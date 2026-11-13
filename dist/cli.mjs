var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/core/paths.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function dataHome(home = homedir()) {
  return process.env.TOKEN_TRACKER_HOME || join(home, ".claude", "token-tracker");
}
function projectsRoot(home = homedir()) {
  const base = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  return join(base, "projects");
}
function dbPath() {
  return join(dataHome(), "tracker.db");
}
function stateFile(name) {
  return join(dataHome(), name);
}
function restrictWindows(dir) {
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync("icacls", [dir, "/inheritance:r", "/grant:r", `${user}:(OI)(CI)F`], { stdio: "ignore" });
  } catch {
  }
}
function ensureDataHome() {
  const dir = dataHome();
  const existed = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: 448 });
  if (!existed && process.platform === "win32") restrictWindows(dir);
  return dir;
}
var init_paths = __esm({
  "src/core/paths.ts"() {
    "use strict";
  }
});

// lazy-sqlite:node:sqlite
var m, DatabaseSync;
var init_node_sqlite = __esm({
  "lazy-sqlite:node:sqlite"() {
    m = process.getBuiltinModule?.("node:sqlite") ?? {};
    DatabaseSync = m.DatabaseSync;
  }
});

// raw:C:\Development and Programming\token-tracker\src\store\schema.sql
var schema_default;
var init_schema = __esm({
  "raw:C:\\Development and Programming\\token-tracker\\src\\store\\schema.sql"() {
    schema_default = 'CREATE TABLE sessions (\n  id TEXT PRIMARY KEY, title TEXT, project TEXT, cwd TEXT, first_ts TEXT, last_ts TEXT, cc_version TEXT\n);\nCREATE TABLE runs (\n  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_type TEXT NOT NULL, description TEXT,\n  launch_tool_use_id TEXT, parent_run_id TEXT, file TEXT\n);\nCREATE INDEX runs_session ON runs(session_id);\nCREATE TABLE prompts (\n  uuid TEXT PRIMARY KEY, session_id TEXT NOT NULL, ts TEXT NOT NULL, text TEXT NOT NULL, duration_ms INTEGER\n);\nCREATE INDEX prompts_session_ts ON prompts(session_id, ts);\nCREATE TABLE api_calls (\n  message_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt_uuid TEXT,\n  ts TEXT NOT NULL, model TEXT NOT NULL, effort TEXT, speed TEXT NOT NULL,\n  input INTEGER NOT NULL, cache_write_5m INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL,\n  cache_read INTEGER NOT NULL, output INTEGER NOT NULL, thinking INTEGER NOT NULL,\n  ctx_tokens INTEGER NOT NULL, cost REAL, cost_parts_json TEXT, price_id TEXT, thinking_ms INTEGER, raw_json TEXT\n);\nCREATE INDEX api_calls_ts ON api_calls(ts);\nCREATE INDEX api_calls_session ON api_calls(session_id);\nCREATE INDEX api_calls_run ON api_calls(run_id);\nCREATE INDEX api_calls_prompt ON api_calls(prompt_uuid);\nCREATE TABLE advisor_calls (\n  message_id TEXT NOT NULL, model TEXT NOT NULL, tokens_json TEXT NOT NULL, cost REAL\n);\nCREATE INDEX advisor_calls_message ON advisor_calls(message_id);\nCREATE TABLE tool_calls (\n  tool_use_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, run_id TEXT NOT NULL, prompt_uuid TEXT,\n  name TEXT NOT NULL, label TEXT NOT NULL, skill TEXT, input_json TEXT, started_ts TEXT, ended_ts TEXT,\n  result_chars INTEGER, is_error INTEGER NOT NULL DEFAULT 0, denied INTEGER NOT NULL DEFAULT 0, permission TEXT\n);\nCREATE INDEX tool_calls_run ON tool_calls(run_id);\nCREATE INDEX tool_calls_prompt ON tool_calls(prompt_uuid);\nCREATE TABLE pending_results (\n  tool_use_id TEXT PRIMARY KEY, ended_ts TEXT, result_chars INTEGER, is_error INTEGER, denied INTEGER, permission TEXT\n);\nCREATE TABLE compactions (\n  session_id TEXT NOT NULL, run_id TEXT, ts TEXT NOT NULL, pre_tokens INTEGER, duration_ms INTEGER, trigger TEXT\n);\nCREATE TABLE hook_runs (\n  session_id TEXT NOT NULL, ts TEXT NOT NULL, command TEXT NOT NULL, duration_ms INTEGER\n);\nCREATE TABLE files (\n  path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, "offset" INTEGER NOT NULL,\n  session_id TEXT, run_id TEXT, missing INTEGER NOT NULL DEFAULT 0\n);\nCREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);\n';
  }
});

// src/store/db.ts
var db_exports = {};
__export(db_exports, {
  openDb: () => openDb
});
import { chmodSync, closeSync as closeSync2, existsSync as existsSync2, openSync as openSync2 } from "node:fs";
function migrate(raw) {
  const row2 = raw.prepare("PRAGMA user_version").get();
  for (let v = row2.user_version; v < MIGRATIONS.length; v++) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(MIGRATIONS[v]);
      raw.exec(`PRAGMA user_version = ${v + 1}`);
      raw.exec("COMMIT");
    } catch (e) {
      raw.exec("ROLLBACK");
      throw e;
    }
  }
}
function openDb(path) {
  if (path === dbPath()) ensureDataHome();
  const existed = existsSync2(path);
  if (!existed && process.platform !== "win32") closeSync2(openSync2(path, "a", 384));
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA busy_timeout = 5000");
  migrate(raw);
  if (!existed && process.platform !== "win32") {
    try {
      chmodSync(path, 384);
    } catch {
    }
  }
  const stmts = /* @__PURE__ */ new Map();
  const q = (sql) => {
    let st = stmts.get(sql);
    if (!st) {
      st = raw.prepare(sql);
      stmts.set(sql, st);
    }
    return st;
  };
  const run2 = (sql, ...p) => {
    q(sql).run(...p);
  };
  const insertToolCall = (t) => {
    const r = q(`INSERT OR IGNORE INTO tool_calls
      (tool_use_id, message_id, run_id, prompt_uuid, name, label, skill, input_json, started_ts)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(t.toolUseId, t.messageId, t.runId, t.promptUuid, t.name, t.label, t.skill, t.inputJson, t.startedTs);
    if (r.changes === 0) return;
    const p = q("SELECT * FROM pending_results WHERE tool_use_id = ?").get(t.toolUseId);
    if (!p) return;
    run2(
      `UPDATE tool_calls SET ended_ts=?, result_chars=?, is_error=?, denied=?, permission=? WHERE tool_use_id=?`,
      p.ended_ts,
      p.result_chars,
      p.is_error,
      p.denied,
      p.permission,
      t.toolUseId
    );
    run2("DELETE FROM pending_results WHERE tool_use_id = ?", t.toolUseId);
  };
  let depth = 0;
  const db = {
    raw,
    upsertSession(s) {
      run2(
        `INSERT INTO sessions (id, title, project, cwd, first_ts, last_ts, cc_version) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, title), project = COALESCE(excluded.project, project),
          cwd = COALESCE(excluded.cwd, cwd), cc_version = COALESCE(excluded.cc_version, cc_version),
          first_ts = CASE WHEN first_ts IS NULL OR excluded.first_ts < first_ts THEN excluded.first_ts ELSE first_ts END,
          last_ts = CASE WHEN last_ts IS NULL OR excluded.last_ts > last_ts THEN excluded.last_ts ELSE last_ts END`,
        s.id,
        s.title,
        s.project,
        s.cwd,
        s.firstTs,
        s.lastTs,
        s.ccVersion
      );
    },
    upsertRun(r) {
      run2(
        `INSERT INTO runs (id, session_id, agent_type, description, launch_tool_use_id, parent_run_id, file)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          agent_type = excluded.agent_type, description = COALESCE(excluded.description, description),
          launch_tool_use_id = COALESCE(excluded.launch_tool_use_id, launch_tool_use_id),
          parent_run_id = COALESCE(excluded.parent_run_id, parent_run_id), file = COALESCE(excluded.file, file)`,
        r.id,
        r.sessionId,
        r.agentType,
        r.description,
        r.launchToolUseId,
        r.parentRunId,
        r.file
      );
    },
    insertPrompt(p) {
      const r = q("INSERT OR IGNORE INTO prompts (uuid, session_id, ts, text, duration_ms) VALUES (?,?,?,?,?)").run(p.uuid, p.sessionId, p.ts, p.text, p.durationMs);
      if (r.changes > 0) return true;
      if (p.durationMs !== null) db.setPromptDuration(p.uuid, p.durationMs);
      return false;
    },
    setPromptDuration(uuid, durationMs) {
      run2("UPDATE prompts SET duration_ms = ? WHERE uuid = ?", durationMs, uuid);
    },
    upsertApiCall(c) {
      return db.transaction(() => {
        const t = c.tokens;
        const r = q(`INSERT OR IGNORE INTO api_calls
          (message_id, session_id, run_id, prompt_uuid, ts, model, effort, speed, input, cache_write_5m,
           cache_write_1h, cache_read, output, thinking, ctx_tokens, cost, cost_parts_json, price_id, thinking_ms,
           raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          c.messageId,
          c.sessionId,
          c.runId,
          c.promptUuid,
          c.ts,
          c.model,
          c.effort,
          c.speed,
          t.input,
          t.cacheWrite5m,
          t.cacheWrite1h,
          t.cacheRead,
          t.output,
          t.thinking,
          c.ctxTokens,
          c.cost,
          c.costPartsJson,
          c.priceId,
          c.thinkingMs,
          c.rawJson
        );
        if (r.changes > 0) {
          for (const a of c.advisor) {
            run2(
              "INSERT INTO advisor_calls (message_id, model, tokens_json, cost) VALUES (?,?,?,?)",
              c.messageId,
              a.model,
              JSON.stringify(a.tokens),
              a.cost
            );
          }
        }
        for (const u of c.toolUses) {
          insertToolCall({
            toolUseId: u.id,
            messageId: c.messageId,
            runId: c.runId,
            promptUuid: c.promptUuid,
            name: u.name,
            label: u.label,
            skill: u.skill,
            inputJson: u.inputJson,
            startedTs: c.ts
          });
        }
        return r.changes > 0;
      });
    },
    insertToolCall,
    completeToolCall(id, r) {
      const res = q(`UPDATE tool_calls SET ended_ts=?, result_chars=?, is_error=?, denied=?, permission=?
        WHERE tool_use_id=?`).run(r.endedTs, r.resultChars, flag(r.isError), flag(r.denied), r.permission, id);
      if (res.changes > 0) return;
      run2(`INSERT OR REPLACE INTO pending_results (tool_use_id, ended_ts, result_chars, is_error, denied, permission)
        VALUES (?,?,?,?,?,?)`, id, r.endedTs, r.resultChars, flag(r.isError), flag(r.denied), r.permission);
    },
    insertCompaction(c) {
      run2(
        `INSERT OR IGNORE INTO compactions (session_id, run_id, ts, pre_tokens, duration_ms, trigger) VALUES (?,?,?,?,?,?)`,
        c.sessionId,
        c.runId,
        c.ts,
        c.preTokens,
        c.durationMs,
        c.trigger
      );
    },
    insertHookRuns(sessionId, ts, runs) {
      for (const h of runs) {
        run2(
          "INSERT OR IGNORE INTO hook_runs (session_id, ts, command, duration_ms) VALUES (?,?,?,?)",
          sessionId,
          ts,
          h.command,
          h.durationMs
        );
      }
    },
    getFileState(path2) {
      const r = q('SELECT size, mtime_ms, "offset", session_id, run_id, missing FROM files WHERE path = ?').get(path2);
      return r ? {
        size: r.size,
        mtimeMs: r.mtime_ms,
        offset: r.offset,
        sessionId: r.session_id,
        runId: r.run_id,
        missing: r.missing === 1
      } : null;
    },
    setFileState(path2, s) {
      run2(
        `INSERT INTO files (path, size, mtime_ms, "offset", session_id, run_id, missing) VALUES (?,?,?,?,?,?,0)
        ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, "offset"=excluded."offset",
          session_id=excluded.session_id, run_id=excluded.run_id, missing=0`,
        path2,
        s.size,
        s.mtimeMs,
        s.offset,
        s.sessionId,
        s.runId
      );
    },
    markFileMissing(path2) {
      run2("UPDATE files SET missing = 1 WHERE path = ?", path2);
    },
    presentFiles() {
      return q("SELECT path FROM files WHERE missing = 0").all().map((r) => r.path);
    },
    resolveRunParents() {
      return Number(q(`UPDATE runs SET parent_run_id =
          (SELECT t.run_id FROM tool_calls t WHERE t.tool_use_id = runs.launch_tool_use_id)
        WHERE parent_run_id IS NULL AND launch_tool_use_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM tool_calls t WHERE t.tool_use_id = runs.launch_tool_use_id)`).run().changes);
    },
    meta: {
      delete(key) {
        run2("DELETE FROM meta WHERE key = ?", key);
      },
      get(key) {
        const r = q("SELECT value FROM meta WHERE key = ?").get(key);
        return r ? r.value : null;
      },
      set(key, value) {
        run2(
          "INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          key,
          value
        );
      }
    },
    transaction(fn) {
      if (depth > 0) {
        depth++;
        try {
          return fn();
        } finally {
          depth--;
        }
      }
      raw.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth = 0;
      }
    },
    close() {
      raw.close();
    }
  };
  return db;
}
var MIGRATIONS, flag;
var init_db = __esm({
  "src/store/db.ts"() {
    "use strict";
    init_node_sqlite();
    init_paths();
    init_schema();
    MIGRATIONS = [
      schema_default,
      // v2: compactions and hook runs are keyed so a rescan from offset 0 cannot duplicate them.
      `DELETE FROM compactions WHERE rowid NOT IN (SELECT MIN(rowid) FROM compactions GROUP BY session_id, ts);
   CREATE UNIQUE INDEX compactions_key ON compactions(session_id, ts);
   DELETE FROM hook_runs WHERE rowid NOT IN (SELECT MIN(rowid) FROM hook_runs GROUP BY session_id, ts, command);
   CREATE UNIQUE INDEX hook_runs_key ON hook_runs(session_id, ts, command);`
    ];
    flag = (b) => b ? 1 : 0;
  }
});

// src/core/prices.ts
function priceCall(model, tokens, at, speed = "standard") {
  const atMs = Date.parse(at);
  let r;
  for (const p of PRICES) {
    if (p.model !== model || Date.parse(p.effectiveFrom) > atMs) continue;
    if (!r || Date.parse(p.effectiveFrom) > Date.parse(r.effectiveFrom)) r = p;
  }
  if (!r) return NONE;
  let m2 = speed === "fast" && r.fastMultiplier ? r.fastMultiplier : 1;
  const prompt = tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead;
  if (r.longContextOver !== void 0 && prompt > r.longContextOver) m2 *= r.longContextMultiplier ?? 1;
  const c = (n, rate) => n * rate * m2 / 1e6;
  const parts = {
    input: c(tokens.input, r.input),
    cacheWrite5m: c(tokens.cacheWrite5m, r.cacheWrite5m),
    cacheWrite1h: c(tokens.cacheWrite1h, r.cacheWrite1h),
    cacheRead: c(tokens.cacheRead, r.cacheRead),
    output: c(tokens.output, r.output),
    thinking: c(tokens.thinking, r.output)
  };
  const cost = parts.input + parts.cacheWrite5m + parts.cacheWrite1h + parts.cacheRead + parts.output + parts.thinking;
  return { cost, parts, priceId: r.id };
}
var row, PRICES, NONE;
var init_prices = __esm({
  "src/core/prices.ts"() {
    "use strict";
    row = (model, input, output, cacheWrite5m, cacheWrite1h, cacheRead, extra = {}) => ({
      id: `${model}@2026-01-01`,
      model,
      effectiveFrom: "2026-01-01",
      input,
      output,
      cacheWrite5m,
      cacheWrite1h,
      cacheRead,
      ...extra
    });
    PRICES = [
      row("fable-5-2", 8, 40, 10, 16, 0.2, { fastMultiplier: 2 }),
      row("opus-5-5", 4, 20, 5, 8, 0.2, { fastMultiplier: 2 }),
      row("sonnet-5-5", 2, 10, 2.5, 4, 0.1),
      row("haiku-5-5", 0.1, 0.5, 0.125, 0.2, 0.01, { longContextOver: 1e5, longContextMultiplier: 5 })
    ];
    NONE = { cost: null, parts: null, priceId: null };
  }
});

// src/ingest/parse.ts
function toolLabel(name, input) {
  if (name === "Skill") {
    const skill = typeof input.skill === "string" ? input.skill : null;
    return { label: `Skill: ${skill ?? "?"}`, skill };
  }
  if (name === "Agent" || name === "Task") {
    const type = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "general-purpose";
    return { label: `Agent: ${type}`, skill: null };
  }
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { label: `MCP ${parts[1].replace(/^claude_ai_/, "")}: ${parts.slice(2).join("__")}`, skill: null };
  }
  return { label: name, skill: null };
}
function parseSubagentMeta(json) {
  let m2;
  try {
    m2 = JSON.parse(json);
  } catch {
    m2 = null;
  }
  const o = isObj(m2) ? m2 : {};
  return {
    agentType: str(o.agentType) ?? "subagent",
    description: str(o.description) ?? "",
    toolUseId: str(o.toolUseId),
    spawnDepth: typeof o.spawnDepth === "number" ? o.spawnDepth : 1
  };
}
function parseLine(line) {
  let rec;
  try {
    rec = JSON.parse(line);
  } catch {
    return ignored();
  }
  if (!isObj(rec)) return ignored();
  try {
    return parseRecord(rec, line);
  } catch {
    return ignored();
  }
}
function parseRecord(rec, raw) {
  switch (rec.type) {
    case "assistant":
      return parseAssistant(rec, raw);
    case "user":
      return parseUser(rec, raw);
    case "system":
      return parseSystem(rec);
    case "ai-title": {
      const sessionId = str(rec.sessionId);
      const title = str(rec.aiTitle);
      return sessionId !== null && title !== null ? [{ kind: "title", sessionId, title }] : ignored();
    }
    default:
      return ignored();
  }
}
function tokensOf(u, thinking) {
  const cc = isObj(u.cache_creation) ? u.cache_creation : null;
  const hasTiers = cc !== null && (typeof cc.ephemeral_5m_input_tokens === "number" || typeof cc.ephemeral_1h_input_tokens === "number");
  return {
    input: num(u.input_tokens),
    cacheWrite5m: hasTiers ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
    cacheWrite1h: hasTiers ? num(cc.ephemeral_1h_input_tokens) : 0,
    cacheRead: num(u.cache_read_input_tokens),
    output: Math.max(0, num(u.output_tokens) - thinking),
    thinking
  };
}
function parseAssistant(rec, raw) {
  const msg = rec.message;
  if (!isObj(msg)) return ignored();
  const model = str(msg.model);
  if (!model || model === "<synthetic>") return ignored();
  const messageId = str(msg.id) ?? str(rec.requestId);
  const ts = str(rec.timestamp);
  const usage = msg.usage;
  if (!messageId || !ts || !isObj(usage)) return ignored();
  const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const tokens = tokensOf(usage, num(details.thinking_tokens));
  const advisor = [];
  if (Array.isArray(usage.iterations)) {
    for (const it of usage.iterations) {
      if (isObj(it) && it.type === "advisor_message") {
        advisor.push({ model: str(it.model) ?? model, tokens: tokensOf(it, 0) });
      }
    }
  }
  const toolUses = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!isObj(b) || b.type !== "tool_use") continue;
      const id = str(b.id);
      const name = str(b.name);
      if (!id || !name) continue;
      const input = isObj(b.input) ? b.input : {};
      const inputJson = JSON.stringify(input);
      toolUses.push({ id, name, ...toolLabel(name, input), inputJson, inputChars: inputJson.length });
    }
  }
  return [{
    kind: "api_part",
    messageId,
    sessionId: str(rec.sessionId) ?? "",
    ts,
    model,
    effort: str(rec.effort),
    speed: usage.speed === "fast" ? "fast" : "standard",
    tokens,
    advisor,
    thinkingMs: typeof rec.thinkingDurationMs === "number" ? rec.thinkingDurationMs : null,
    cwd: str(rec.cwd),
    gitBranch: str(rec.gitBranch),
    ccVersion: str(rec.version),
    toolUses,
    raw
  }];
}
function resultChars(content) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (isObj(b) && b.type === "text") n += (str(b.text) ?? "").length;
    else if (isObj(b) && b.type === "image") n += IMAGE_CHARS;
    else n += JSON.stringify(b).length;
  }
  return n;
}
function parseUser(rec, raw) {
  const ts = str(rec.timestamp);
  const msg = rec.message;
  if (!ts || !isObj(msg)) return ignored();
  const content = msg.content;
  const blocks = Array.isArray(content) ? content.filter(isObj) : [];
  const results = blocks.filter((b) => b.type === "tool_result" && str(b.tool_use_id));
  if (results.length > 0) {
    const pd = rec.permissionDecision;
    const permission = typeof pd === "string" ? pd : isObj(pd) ? JSON.stringify(pd) : null;
    return results.map((b) => ({
      kind: "tool_result",
      toolUseId: b.tool_use_id,
      ts,
      isError: b.is_error === true,
      resultChars: resultChars(b.content),
      permission,
      denied: Boolean(rec.toolDenialKind),
      raw
    }));
  }
  if (rec.isMeta === true || rec.isCompactSummary === true || rec.isSidechain === true) return ignored();
  const text = typeof content === "string" ? content : blocks.filter((b) => b.type === "text").map((b) => str(b.text) ?? "").join("\n");
  if (!text) return ignored();
  const head = text.trimStart();
  const cmd = /^<command-(?:message|name)>/.test(head) ? /<command-name>\/?([^<]*)<\/command-name>/.exec(text) : null;
  if (cmd) return [{ kind: "slash_command", ts, name: cmd[1] }];
  if (NOT_PROMPT_PREFIXES.some((p) => head.startsWith(p))) return ignored();
  return [{ kind: "prompt", uuid: str(rec.uuid) ?? "", sessionId: str(rec.sessionId) ?? "", ts, text, raw }];
}
function parseSystem(rec) {
  const ts = str(rec.timestamp);
  if (!ts) return ignored();
  switch (rec.subtype) {
    case "turn_duration":
      return [{ kind: "turn_duration", ts, durationMs: num(rec.durationMs) }];
    case "compact_boundary": {
      const m2 = isObj(rec.compactMetadata) ? rec.compactMetadata : {};
      return [{
        kind: "compaction",
        ts,
        preTokens: num(m2.preTokens),
        durationMs: num(m2.durationMs),
        trigger: str(m2.trigger) ?? ""
      }];
    }
    case "stop_hook_summary": {
      const infos = Array.isArray(rec.hookInfos) ? rec.hookInfos.filter(isObj) : [];
      return [{
        kind: "hook_runs",
        ts,
        runs: infos.map((h) => ({ command: str(h.command) ?? "", durationMs: num(h.durationMs) }))
      }];
    }
    default:
      return ignored();
  }
}
var ignored, NOT_PROMPT_PREFIXES, IMAGE_CHARS, isObj, num, str;
var init_parse = __esm({
  "src/ingest/parse.ts"() {
    "use strict";
    ignored = () => [{ kind: "ignored" }];
    NOT_PROMPT_PREFIXES = ["<local-command", "<system-reminder>", "<task-notification", "Caveat:"];
    IMAGE_CHARS = 6e3;
    isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
    num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
    str = (v) => typeof v === "string" ? v : null;
  }
});

// src/ingest/indexer.ts
var indexer_exports = {};
__export(indexer_exports, {
  indexAll: () => indexAll,
  indexFile: () => indexFile
});
import { closeSync as closeSync3, existsSync as existsSync3, openSync as openSync3, readFileSync as readFileSync2, readSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join as join3, resolve, sep } from "node:path";
function add(into, r) {
  into.files += r.files;
  into.newCalls += r.newCalls;
  into.newPrompts += r.newPrompts;
  into.bytesRead += r.bytesRead;
  into.failed += r.failed;
  into.errors.push(...r.errors);
  for (const s of r.changedSessions) if (!into.changedSessions.includes(s)) into.changedSessions.push(s);
}
function listTranscripts(root) {
  const mains = [];
  const subs = [];
  for (const p of dirEntries(root)) {
    if (!p.isDirectory()) continue;
    const proj = join3(root, p.name);
    for (const e of dirEntries(proj)) {
      if (e.isFile() && e.name.endsWith(".jsonl")) mains.push(join3(proj, e.name));
      else if (e.isDirectory()) {
        const sub = join3(proj, e.name, "subagents");
        for (const s of dirEntries(sub)) {
          if (s.isFile() && s.name.startsWith("agent-") && s.name.endsWith(".jsonl")) subs.push(join3(sub, s.name));
        }
      }
    }
  }
  return [...mains, ...subs];
}
function indexAll(db, opts = {}) {
  const root = resolve(opts.root ?? projectsRoot());
  const files = listTranscripts(root);
  const out = empty();
  files.forEach((f, i) => {
    try {
      add(out, indexFile(db, f));
    } catch (e) {
      out.failed++;
      out.errors.push({ path: f, message: e instanceof Error ? e.message : String(e) });
    }
    opts.onProgress?.(i + 1, files.length);
  });
  const seen = new Set(files);
  for (const p of db.presentFiles()) {
    if (p.startsWith(root + sep) && !seen.has(p)) db.markFileMissing(p);
  }
  db.resolveRunParents();
  return out;
}
function indexFile(db, path, opts = {}) {
  const p = resolve(path);
  const prev = db.getFileState(p);
  let st;
  try {
    st = statSync(p);
  } catch {
    if (prev) db.markFileMissing(p);
    return empty();
  }
  const out = empty();
  out.files = 1;
  if (prev && !prev.missing && st.size === prev.size && st.mtimeMs === prev.mtimeMs) return out;
  const isSub = basename(dirname(p)) === "subagents";
  let offset = prev?.offset ?? 0;
  const rescan = st.size < offset;
  if (rescan) offset = 0;
  let fd;
  try {
    fd = openSync3(p, "r");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    if (prev) db.markFileMissing(p);
    return empty();
  }
  try {
    db.transaction(() => {
      let sid = rescan ? null : prev?.sessionId ?? null;
      let runId = "";
      const promptKey = `lastPrompt:${p}`;
      let lastPrompt = isSub || offset === 0 ? null : db.meta.get(promptKey);
      if (!isSub && offset === 0) db.meta.delete(promptKey);
      let title = null;
      let cwd = null;
      let ccVersion = null;
      let firstTs = null;
      let lastTs = null;
      let touched = false;
      const seenTs = (ts) => {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      };
      const handle = (line) => {
        for (const x of parseLine(line)) {
          if (x.kind === "ignored" || x.kind === "slash_command") continue;
          touched = true;
          switch (x.kind) {
            case "api_part": {
              const model = shortModel(x.model);
              const pr = priceCall(model, x.tokens, x.ts, x.speed);
              const t = x.tokens;
              const isNew = db.upsertApiCall({
                messageId: x.messageId,
                sessionId: sid,
                runId,
                promptUuid: lastPrompt,
                ts: x.ts,
                model,
                effort: x.effort,
                speed: x.speed,
                tokens: t,
                ctxTokens: t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead,
                cost: pr.cost,
                costPartsJson: pr.parts ? JSON.stringify(pr.parts) : null,
                priceId: pr.priceId,
                thinkingMs: x.thinkingMs,
                rawJson: x.raw,
                toolUses: x.toolUses,
                advisor: x.advisor.map((a) => {
                  const am = shortModel(a.model);
                  return { model: am, tokens: a.tokens, cost: priceCall(am, a.tokens, x.ts).cost };
                })
              });
              if (isNew) out.newCalls++;
              cwd = x.cwd ?? cwd;
              ccVersion = x.ccVersion ?? ccVersion;
              seenTs(x.ts);
              break;
            }
            case "prompt": {
              if (isSub) break;
              const uuid = x.uuid || `${sid}:${x.ts}`;
              const isNew = db.insertPrompt({ uuid, sessionId: sid, ts: x.ts, text: x.text, durationMs: null });
              if (isNew) out.newPrompts++;
              lastPrompt = uuid;
              seenTs(x.ts);
              break;
            }
            case "tool_result":
              db.completeToolCall(x.toolUseId, {
                endedTs: x.ts,
                resultChars: x.resultChars,
                isError: x.isError,
                denied: x.denied,
                permission: x.permission
              });
              break;
            case "turn_duration":
              if (lastPrompt) db.setPromptDuration(lastPrompt, x.durationMs);
              break;
            case "compaction":
              db.insertCompaction({
                sessionId: sid,
                runId,
                ts: x.ts,
                preTokens: x.preTokens,
                durationMs: x.durationMs,
                trigger: x.trigger
              });
              break;
            case "hook_runs":
              db.insertHookRuns(sid, x.ts, x.runs);
              break;
            case "title":
              title = x.title;
              break;
          }
        }
      };
      const chunk = opts.chunkSize ?? CHUNK;
      const buf = Buffer.allocUnsafe(chunk);
      let carry = Buffer.alloc(0);
      let pos = offset;
      let consumed = offset;
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, Math.min(chunk, st.size - pos), pos);
        if (n <= 0) break;
        pos += n;
        out.bytesRead += n;
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        const last = data.lastIndexOf(NL);
        if (last < 0) {
          carry = Buffer.from(data);
          continue;
        }
        if (sid === null) {
          const m2 = SESSION_RE.exec(data.toString("utf8", 0, last));
          sid = m2 ? m2[1] : isSub ? basename(dirname(dirname(p))) : basename(p, ".jsonl");
        }
        runId = isSub ? basename(p, ".jsonl") : `main:${sid}`;
        let start = 0;
        while (start <= last) {
          const end = data.indexOf(NL, start);
          let line = data.toString("utf8", start, end);
          if (line.endsWith("\r")) line = line.slice(0, -1);
          if (line) handle(line);
          start = end + 1;
        }
        consumed += last + 1;
        carry = Buffer.from(data.subarray(last + 1));
      }
      if (sid === null) sid = isSub ? basename(dirname(dirname(p))) : basename(p, ".jsonl");
      runId = isSub ? basename(p, ".jsonl") : `main:${sid}`;
      if (touched) {
        const project = basename(isSub ? dirname(dirname(dirname(p))) : dirname(p));
        db.upsertSession({ id: sid, title, project, cwd, firstTs, lastTs, ccVersion });
        upsertRunFor(db, p, isSub, sid, runId);
        out.changedSessions.push(sid);
      }
      if (!isSub && lastPrompt) db.meta.set(promptKey, lastPrompt);
      db.setFileState(p, { size: st.size, mtimeMs: st.mtimeMs, offset: consumed, sessionId: sid, runId });
    });
  } finally {
    closeSync3(fd);
  }
  return out;
}
function upsertRunFor(db, p, isSub, sid, runId) {
  if (!isSub) {
    db.upsertRun({
      id: runId,
      sessionId: sid,
      agentType: "main",
      description: null,
      launchToolUseId: null,
      parentRunId: null,
      file: p
    });
    return;
  }
  const metaPath = p.replace(/\.jsonl$/, ".meta.json");
  const meta = parseSubagentMeta(existsSync3(metaPath) ? readFileSync2(metaPath, "utf8") : "");
  const launcher = meta.toolUseId ? db.raw.prepare("SELECT run_id FROM tool_calls WHERE tool_use_id = ?").get(meta.toolUseId) : void 0;
  const parent = launcher?.run_id ?? (meta.spawnDepth <= 1 ? `main:${sid}` : null);
  db.upsertRun({
    id: runId,
    sessionId: sid,
    agentType: meta.agentType,
    description: meta.description || null,
    launchToolUseId: meta.toolUseId,
    parentRunId: parent,
    file: p
  });
}
var CHUNK, NL, SESSION_RE, shortModel, empty, dirEntries;
var init_indexer = __esm({
  "src/ingest/indexer.ts"() {
    "use strict";
    init_paths();
    init_prices();
    init_parse();
    CHUNK = 4 * 1024 * 1024;
    NL = 10;
    SESSION_RE = /"sessionId"\s*:\s*"([^"]+)"/;
    shortModel = (m2) => m2.replace(/^claude-/, "");
    empty = () => ({
      files: 0,
      newCalls: 0,
      newPrompts: 0,
      changedSessions: [],
      bytesRead: 0,
      failed: 0,
      errors: []
    });
    dirEntries = (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true });
      } catch {
        return [];
      }
    };
  }
});

// src/cli.ts
init_paths();
import { spawn } from "node:child_process";
import { appendFileSync, existsSync as existsSync4, readFileSync as readFileSync3, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// src/ingest/lock.ts
init_paths();
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join as join2 } from "node:path";
var STALE_MS = 10 * 60 * 1e3;
var sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function isStale(path) {
  try {
    const { pid, ts } = JSON.parse(readFileSync(path, "utf8"));
    return !pidAlive(pid) || !(Date.now() - ts < STALE_MS);
  } catch {
    return false;
  }
}
function tryAcquire(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 384);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (!isStale(path)) return false;
      try {
        unlinkSync(path);
      } catch {
      }
    }
  }
  return false;
}
function withWriteLock(fn, opts = {}) {
  ensureDataHome();
  const path = join2(dataHome(), "write.lock");
  const deadline = Date.now() + (opts.waitMs ?? 0);
  while (!tryAcquire(path)) {
    if (Date.now() >= deadline) return "busy";
    sleep(50);
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(path);
    } catch {
    }
  }
}

// src/cli.ts
var MIN_NODE = [22, 13, 0];
function nodeTooOld(version) {
  const v = version.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((v[i] ?? 0) !== MIN_NODE[i]) return (v[i] ?? 0) < MIN_NODE[i];
  }
  return false;
}
function log(message) {
  try {
    ensureDataHome();
    appendFileSync(stateFile("debug.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
  } catch {
  }
}
var errText = (e) => e instanceof Error ? e.stack ?? e.message : String(e);
function readStdin() {
  return new Promise((done) => {
    if (process.stdin.isTTY) return done({});
    let text = "";
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = text.trim() ? JSON.parse(text) : {};
        done(parsed && typeof parsed === "object" ? parsed : {});
      } catch (e) {
        log(`bad hook stdin: ${errText(e)}`);
        done({});
      }
    };
    const timer = setTimeout(() => {
      process.stdin.pause();
      finish();
    }, 500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      text += c;
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
function hookStart() {
  ensureDataHome();
  const marker = stateFile("installed.json");
  if (existsSync4(marker)) return;
  writeFileSync(marker, JSON.stringify({ installedAt: (/* @__PURE__ */ new Date()).toISOString() }), { mode: 384 });
  if (process.env.TOKEN_TRACKER_NO_SPAWN) {
    log("hook-start: backfill spawn skipped (TOKEN_TRACKER_NO_SPAWN)");
    return;
  }
  const cli = fileURLToPath(import.meta.url);
  spawn(process.execPath, [cli, "backfill"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
async function pokeServer() {
  try {
    const file = stateFile("server.json");
    if (!existsSync4(file)) return false;
    const { pid, port, key } = JSON.parse(readFileSync3(file, "utf8"));
    if (!pidAlive(pid)) return false;
    const res = await fetch(`http://127.0.0.1:${port}/api/poke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(1500)
    });
    return res.ok;
  } catch (e) {
    log(`poke failed: ${errText(e)}`);
    return false;
  }
}
async function indexLocked(fn, waitMs) {
  const { openDb: openDb2 } = await Promise.resolve().then(() => (init_db(), db_exports));
  const idx = await Promise.resolve().then(() => (init_indexer(), indexer_exports));
  const r = withWriteLock(() => {
    const db = openDb2(dbPath());
    try {
      fn(db, idx);
    } finally {
      db.close();
    }
  }, { waitMs });
  return r !== "busy";
}
var summary = (r) => `indexed ${r.files} files, ${r.newCalls} new calls, ${r.newPrompts} new prompts` + (r.failed ? `, ${r.failed} failed` : "");
async function run(sub) {
  switch (sub) {
    case "hook-start":
      await readStdin();
      hookStart();
      return;
    case "hook-end": {
      await readStdin();
      if (await pokeServer()) return;
      const ran = await indexLocked((db, { indexAll: indexAll2 }) => {
        const r = indexAll2(db);
        for (const e of r.errors) log(`index error ${e.path}: ${e.message}`);
      }, 0);
      if (!ran) log("hook-end: another indexer holds the lock; skipped");
      return;
    }
    case "index": {
      const ran = await indexLocked((db, { indexAll: indexAll2 }) => {
        console.log(summary(indexAll2(db)));
      }, 5e3);
      if (!ran) console.log("another indexer is running; skipped");
      return;
    }
    case "backfill": {
      const startedAt = (/* @__PURE__ */ new Date()).toISOString();
      const ran = await indexLocked((db, { indexAll: indexAll2 }) => {
        const progress = (done, total, finishedAt) => db.meta.set("backfill_progress", JSON.stringify({ done, total, startedAt, ...finishedAt && { finishedAt } }));
        progress(0, 0);
        let last = { done: 0, total: 0 };
        const r = indexAll2(db, { onProgress: (done, total) => {
          last = { done, total };
          progress(done, total);
        } });
        progress(last.done, last.total, (/* @__PURE__ */ new Date()).toISOString());
        console.log(summary(r));
      }, 6e4);
      if (!ran) console.log("another indexer is running; skipped");
      return;
    }
    default:
      console.error(`token-tracker: unknown command "${sub}"`);
  }
}
async function main() {
  const sub = process.argv[2] ?? "";
  const nodeVersion = process.env.TOKEN_TRACKER_FAKE_NODE_VERSION || process.versions.node;
  if (nodeTooOld(nodeVersion)) {
    console.error(`Token Tracker needs Node 22.13 or newer (found ${nodeVersion}).`);
    return;
  }
  try {
    await run(sub);
  } catch (e) {
    log(`${sub} failed: ${errText(e)}`);
  }
}
await main();
process.exit(0);
