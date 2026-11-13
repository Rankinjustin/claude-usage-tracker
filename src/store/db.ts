import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import type { TokenParts, ToolUse } from '../core/types';
import { dbPath, ensureDataHome } from '../core/paths';
import schema from './schema.sql?raw';

/** Ordered migrations; `PRAGMA user_version` is the number applied. Append only. */
const MIGRATIONS: string[] = [
  schema,
  // v2: compactions and hook runs are keyed so a rescan from offset 0 cannot duplicate them.
  `DELETE FROM compactions WHERE rowid NOT IN (SELECT MIN(rowid) FROM compactions GROUP BY session_id, ts);
   CREATE UNIQUE INDEX compactions_key ON compactions(session_id, ts);
   DELETE FROM hook_runs WHERE rowid NOT IN (SELECT MIN(rowid) FROM hook_runs GROUP BY session_id, ts, command);
   CREATE UNIQUE INDEX hook_runs_key ON hook_runs(session_id, ts, command);`,
];

export interface SessionRow {
  id: string; title: string | null; project: string | null; cwd: string | null;
  firstTs: string | null; lastTs: string | null; ccVersion: string | null;
}
export interface RunRow {
  id: string; sessionId: string; agentType: string; description: string | null;
  launchToolUseId: string | null; parentRunId: string | null; file: string | null;
}
export interface PromptRow { uuid: string; sessionId: string; ts: string; text: string; durationMs: number | null }
export interface ApiCallRow {
  messageId: string; sessionId: string; runId: string; promptUuid: string | null; ts: string; model: string;
  effort: string | null; speed: string; tokens: TokenParts; ctxTokens: number; cost: number | null;
  costPartsJson: string | null; priceId: string | null; thinkingMs: number | null; rawJson: string | null;
}
export interface ToolCallRow {
  toolUseId: string; messageId: string; runId: string; promptUuid: string | null; name: string; label: string;
  skill: string | null; inputJson: string | null; startedTs: string | null;
}
export interface ToolResultRow {
  endedTs: string | null; resultChars: number; isError: boolean; denied: boolean; permission: string | null;
}
export interface CompactionRow {
  sessionId: string; runId: string | null; ts: string; preTokens: number; durationMs: number; trigger: string;
}
export interface HookRunRow { command: string; durationMs: number }
export interface FileState {
  size: number; mtimeMs: number; offset: number; sessionId: string | null; runId: string | null; missing?: boolean;
}
export interface AdvisorRow { model: string; tokens: TokenParts; cost: number | null }

export interface Db {
  readonly raw: DatabaseSync;
  upsertSession(s: SessionRow): void;
  upsertRun(r: RunRow): void;
  /** Returns true when the prompt is new. */
  insertPrompt(p: PromptRow): boolean;
  setPromptDuration(uuid: string, durationMs: number): void;
  /** Returns true when this message id was not stored before. */
  upsertApiCall(c: ApiCallRow & { toolUses: ToolUse[]; advisor: AdvisorRow[] }): boolean;
  insertToolCall(t: ToolCallRow): void;
  completeToolCall(toolUseId: string, r: ToolResultRow): void;
  insertCompaction(c: CompactionRow): void;
  insertHookRuns(sessionId: string, ts: string, runs: HookRunRow[]): void;
  getFileState(path: string): (FileState & { missing: boolean }) | null;
  setFileState(path: string, s: FileState): void;
  markFileMissing(path: string): void;
  /** Paths of tracked files not yet marked missing. */
  presentFiles(): string[];
  /** Fills missing parent_run_id from the run that holds the launching tool call; returns rows updated. */
  resolveRunParents(): number;
  meta: { get(key: string): string | null; set(key: string, value: string): void; delete(key: string): void };
  transaction<T>(fn: () => T): T;
  close(): void;
}

const flag = (b: boolean): number => (b ? 1 : 0);

function migrate(raw: DatabaseSync): void {
  const row = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    raw.exec('BEGIN IMMEDIATE');
    try {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec('COMMIT');
    } catch (e) {
      raw.exec('ROLLBACK');
      throw e;
    }
  }
}

/** Opens (creating and migrating) the store. The data home is only created for the default path. */
export function openDb(path: string): Db {
  if (path === dbPath()) ensureDataHome();
  const existed = existsSync(path);
  // Pre-create at 0600 so SQLite's -wal/-shm side files inherit the mode.
  if (!existed && process.platform !== 'win32') closeSync(openSync(path, 'a', 0o600));
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('PRAGMA busy_timeout = 5000');
  migrate(raw);
  if (!existed && process.platform !== 'win32') {
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  const stmts = new Map<string, StatementSync>();
  const q = (sql: string): StatementSync => {
    let st = stmts.get(sql);
    if (!st) { st = raw.prepare(sql); stmts.set(sql, st); }
    return st;
  };
  const run = (sql: string, ...p: SQLInputValue[]): void => { q(sql).run(...p); };

  const insertToolCall = (t: ToolCallRow): void => {
    const r = q(`INSERT OR IGNORE INTO tool_calls
      (tool_use_id, message_id, run_id, prompt_uuid, name, label, skill, input_json, started_ts)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(t.toolUseId, t.messageId, t.runId, t.promptUuid, t.name, t.label, t.skill, t.inputJson, t.startedTs);
    if (r.changes === 0) return;
    const p = q('SELECT * FROM pending_results WHERE tool_use_id = ?').get(t.toolUseId) as
      { ended_ts: string | null; result_chars: number; is_error: number; denied: number;
        permission: string | null } | undefined;
    if (!p) return;
    run(`UPDATE tool_calls SET ended_ts=?, result_chars=?, is_error=?, denied=?, permission=? WHERE tool_use_id=?`,
      p.ended_ts, p.result_chars, p.is_error, p.denied, p.permission, t.toolUseId);
    run('DELETE FROM pending_results WHERE tool_use_id = ?', t.toolUseId);
  };

  let depth = 0;

  const db: Db = {
    raw,
    upsertSession(s) {
      run(`INSERT INTO sessions (id, title, project, cwd, first_ts, last_ts, cc_version) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, title), project = COALESCE(excluded.project, project),
          cwd = COALESCE(excluded.cwd, cwd), cc_version = COALESCE(excluded.cc_version, cc_version),
          first_ts = CASE WHEN first_ts IS NULL OR excluded.first_ts < first_ts THEN excluded.first_ts ELSE first_ts END,
          last_ts = CASE WHEN last_ts IS NULL OR excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`,
      s.id, s.title, s.project, s.cwd, s.firstTs, s.lastTs, s.ccVersion);
    },
    upsertRun(r) {
      run(`INSERT INTO runs (id, session_id, agent_type, description, launch_tool_use_id, parent_run_id, file)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          agent_type = excluded.agent_type, description = COALESCE(excluded.description, description),
          launch_tool_use_id = COALESCE(excluded.launch_tool_use_id, launch_tool_use_id),
          parent_run_id = COALESCE(excluded.parent_run_id, parent_run_id), file = COALESCE(excluded.file, file)`,
      r.id, r.sessionId, r.agentType, r.description, r.launchToolUseId, r.parentRunId, r.file);
    },
    insertPrompt(p) {
      const r = q('INSERT OR IGNORE INTO prompts (uuid, session_id, ts, text, duration_ms) VALUES (?,?,?,?,?)')
        .run(p.uuid, p.sessionId, p.ts, p.text, p.durationMs);
      if (r.changes > 0) return true;
      if (p.durationMs !== null) db.setPromptDuration(p.uuid, p.durationMs);
      return false;
    },
    setPromptDuration(uuid, durationMs) {
      run('UPDATE prompts SET duration_ms = ? WHERE uuid = ?', durationMs, uuid);
    },
    upsertApiCall(c) {
      return db.transaction(() => {
        const t = c.tokens;
        const r = q(`INSERT OR IGNORE INTO api_calls
          (message_id, session_id, run_id, prompt_uuid, ts, model, effort, speed, input, cache_write_5m,
           cache_write_1h, cache_read, output, thinking, ctx_tokens, cost, cost_parts_json, price_id, thinking_ms,
           raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(c.messageId, c.sessionId, c.runId, c.promptUuid, c.ts, c.model, c.effort, c.speed, t.input,
            t.cacheWrite5m, t.cacheWrite1h, t.cacheRead, t.output, t.thinking, c.ctxTokens, c.cost,
            c.costPartsJson, c.priceId, c.thinkingMs, c.rawJson);
        if (r.changes > 0) {
          for (const a of c.advisor) {
            run('INSERT INTO advisor_calls (message_id, model, tokens_json, cost) VALUES (?,?,?,?)',
              c.messageId, a.model, JSON.stringify(a.tokens), a.cost);
          }
        }
        for (const u of c.toolUses) {
          insertToolCall({ toolUseId: u.id, messageId: c.messageId, runId: c.runId, promptUuid: c.promptUuid,
            name: u.name, label: u.label, skill: u.skill, inputJson: u.inputJson, startedTs: c.ts });
        }
        return r.changes > 0;
      });
    },
    insertToolCall,
    completeToolCall(id, r) {
      const res = q(`UPDATE tool_calls SET ended_ts=?, result_chars=?, is_error=?, denied=?, permission=?
        WHERE tool_use_id=?`)
        .run(r.endedTs, r.resultChars, flag(r.isError), flag(r.denied), r.permission, id);
      if (res.changes > 0) return;
      run(`INSERT OR REPLACE INTO pending_results (tool_use_id, ended_ts, result_chars, is_error, denied, permission)
        VALUES (?,?,?,?,?,?)`, id, r.endedTs, r.resultChars, flag(r.isError), flag(r.denied), r.permission);
    },
    insertCompaction(c) {
      run(`INSERT OR IGNORE INTO compactions (session_id, run_id, ts, pre_tokens, duration_ms, trigger) VALUES (?,?,?,?,?,?)`,
        c.sessionId, c.runId, c.ts, c.preTokens, c.durationMs, c.trigger);
    },
    insertHookRuns(sessionId, ts, runs) {
      for (const h of runs) {
        run('INSERT OR IGNORE INTO hook_runs (session_id, ts, command, duration_ms) VALUES (?,?,?,?)',
          sessionId, ts, h.command, h.durationMs);
      }
    },
    getFileState(path) {
      const r = q('SELECT size, mtime_ms, "offset", session_id, run_id, missing FROM files WHERE path = ?').get(path) as
        { size: number; mtime_ms: number; offset: number; session_id: string | null; run_id: string | null;
          missing: number } | undefined;
      return r ? { size: r.size, mtimeMs: r.mtime_ms, offset: r.offset, sessionId: r.session_id, runId: r.run_id,
        missing: r.missing === 1 } : null;
    },
    setFileState(path, s) {
      run(`INSERT INTO files (path, size, mtime_ms, "offset", session_id, run_id, missing) VALUES (?,?,?,?,?,?,0)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, "offset"=excluded."offset",
          session_id=excluded.session_id, run_id=excluded.run_id, missing=0`,
      path, s.size, s.mtimeMs, s.offset, s.sessionId, s.runId);
    },
    markFileMissing(path) {
      run('UPDATE files SET missing = 1 WHERE path = ?', path);
    },
    presentFiles() {
      return (q('SELECT path FROM files WHERE missing = 0').all() as { path: string }[]).map((r) => r.path);
    },
    resolveRunParents() {
      return Number(q(`UPDATE runs SET parent_run_id =
          (SELECT t.run_id FROM tool_calls t WHERE t.tool_use_id = runs.launch_tool_use_id)
        WHERE parent_run_id IS NULL AND launch_tool_use_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.tool_use_id = runs.launch_tool_use_id)`).run().changes);
    },
    meta: {
      delete(key) {
        run('DELETE FROM meta WHERE key = ?', key);
      },
      get(key) {
        const r = q('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
        return r ? r.value : null;
      },
      set(key, value) {
        run('INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key, value);
      },
    },
    transaction(fn) {
      if (depth > 0) { // nested: join the outer transaction; a throw propagates and the outer rolls back
        depth++;
        try { return fn(); } finally { depth--; }
      }
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth = 0;
      }
    },
    close() { raw.close(); },
  };
  return db;
}
