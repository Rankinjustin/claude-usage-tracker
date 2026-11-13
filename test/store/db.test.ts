import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type ApiCallRow, type Db } from '../../src/store/db';
import type { TokenParts, ToolUse } from '../../src/core/types';

const dirs: string[] = [];
const open = (): { db: Db; path: string } => {
  const d = mkdtempSync(join(tmpdir(), 'tt db '));
  dirs.push(d);
  const path = join(d, 'tracker.db');
  return { db: openDb(path), path };
};
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const tokens: TokenParts = { input: 10, cacheWrite5m: 20, cacheWrite1h: 30, cacheRead: 40, output: 50, thinking: 5 };
const tu = (id: string): ToolUse => ({ id, name: 'Bash', label: 'Bash', skill: null, inputJson: '{}', inputChars: 2 });
type Adv = { model: string; tokens: TokenParts; cost: number | null };
const call = (over: Partial<ApiCallRow> = {}, toolUses: ToolUse[] = [], advisor: Adv[] = []) => ({
  messageId: 'm1', sessionId: 's1', runId: 'main:s1', promptUuid: 'p1', ts: '2026-01-01T00:00:00Z', model: 'claude-x',
  effort: null, speed: 'standard', tokens, ctxTokens: 100, cost: 1.5, costPartsJson: '{}', priceId: 'x@1',
  thinkingMs: 7, rawJson: '{"raw":true}', ...over, toolUses, advisor,
});
const raw = (path: string, sql: string): any[] => {
  const r = new DatabaseSync(path);
  try { return r.prepare(sql).all() as any[]; } finally { r.close(); }
};

describe('store', () => {
  it('migrates fresh db to latest user_version', () => {
    const { db, path } = open();
    db.close();
    const v = raw(path, 'PRAGMA user_version')[0].user_version;
    expect(v).toBeGreaterThanOrEqual(1);
    const db2 = openDb(path); // reopen is idempotent
    db2.close();
    expect(raw(path, 'PRAGMA user_version')[0].user_version).toBe(v);
    expect(raw(path, "select name from sqlite_master where name='api_calls'")).toHaveLength(1);
  });

  it('upsertApiCall twice with same message id keeps tokens once and unions tool uses', () => {
    const { db, path } = open();
    db.upsertApiCall(call({}, [tu('t1')], [{ model: 'adv', tokens, cost: 0.1 }]));
    db.upsertApiCall(call({}, [tu('t1'), tu('t2')], [{ model: 'adv', tokens, cost: 0.1 }]));
    db.close();
    const a = raw(path, 'select * from api_calls');
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ input: 10, cache_write_5m: 20, cache_write_1h: 30, cache_read: 40, output: 50 });
    const t = raw(path, 'select * from tool_calls order by tool_use_id');
    expect(t.map((r) => r.tool_use_id)).toEqual(['t1', 't2']);
    expect(t[0]).toMatchObject({ message_id: 'm1', run_id: 'main:s1', prompt_uuid: 'p1',
      started_ts: '2026-01-01T00:00:00Z' });
    expect(raw(path, 'select * from advisor_calls')).toHaveLength(1);
  });

  it('raw_json stored', () => {
    const { db, path } = open();
    db.upsertApiCall(call());
    db.close();
    expect(raw(path, 'select raw_json from api_calls')[0].raw_json).toBe('{"raw":true}');
  });

  it('file state round-trips', () => {
    const { db } = open();
    const p = 'a b\\c.jsonl';
    expect(db.getFileState(p)).toBeNull();
    db.setFileState(p, { size: 5, mtimeMs: 12.5, offset: 4, sessionId: 's1', runId: 'main:s1' });
    expect(db.getFileState(p)).toEqual({ size: 5, mtimeMs: 12.5, offset: 4, sessionId: 's1', runId: 'main:s1',
      missing: false });
    db.markFileMissing(p);
    expect(db.getFileState(p)?.missing).toBe(true);
    db.setFileState(p, { size: 6, mtimeMs: 13, offset: 6, sessionId: 's1', runId: 'main:s1' });
    expect(db.getFileState(p)?.missing).toBe(false);
    db.close();
  });

  it('transaction rolls back on throw', () => {
    const { db, path } = open();
    expect(() => db.transaction(() => {
      db.upsertSession({ id: 's1', title: null, project: null, cwd: null, firstTs: 'a', lastTs: 'a', ccVersion: null });
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.transaction(() => 7)).toBe(7);
    db.close();
    expect(raw(path, 'select * from sessions')).toHaveLength(0);
  });

  it('db file created 0600 on posix', () => {
    const { db, path } = open();
    db.close();
    expect(existsSync(path)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('wal side file is 0600 on posix after a write', () => {
    const { db, path } = open();
    db.upsertApiCall(call());
    if (process.platform !== 'win32') expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
    db.close();
  });

  it('nested transaction: outer transaction containing upsertApiCall rolls back everything on throw', () => {
    const { db, path } = open();
    expect(() => db.transaction(() => {
      db.upsertApiCall(call({}, [tu('t1')]));
      throw new Error('boom');
    })).toThrow('boom');
    db.transaction(() => { db.upsertApiCall(call({ messageId: 'm2' })); });
    db.close();
    expect(raw(path, 'select message_id from api_calls').map((r) => r.message_id)).toEqual(['m2']);
    expect(raw(path, 'select * from tool_calls')).toHaveLength(0);
  });

  it('upsertSession merges earliest first, latest last, non-null over null', () => {
    const { db, path } = open();
    db.upsertSession({ id: 's1', title: null, project: 'p', cwd: null, firstTs: '2026-01-02', lastTs: '2026-01-02',
      ccVersion: '1' });
    db.upsertSession({ id: 's1', title: 'T', project: null, cwd: '/c', firstTs: '2026-01-01', lastTs: '2026-01-01',
      ccVersion: null });
    db.upsertSession({ id: 's1', title: null, project: null, cwd: null, firstTs: '2026-01-03', lastTs: '2026-01-03',
      ccVersion: null });
    db.close();
    expect(raw(path, 'select * from sessions')[0]).toEqual({ id: 's1', title: 'T', project: 'p', cwd: '/c',
      first_ts: '2026-01-01', last_ts: '2026-01-03', cc_version: '1' });
  });

  it('result before call is applied when call arrives', () => {
    const { db, path } = open();
    db.completeToolCall('t9', { endedTs: 'E', resultChars: 42, isError: true, denied: false, permission: '"allow"' });
    db.upsertApiCall(call({}, [tu('t9')]));
    db.close();
    expect(raw(path, 'select * from tool_calls')[0]).toMatchObject({ ended_ts: 'E', result_chars: 42, is_error: 1,
      denied: 0, permission: '"allow"' });
    expect(raw(path, 'select * from pending_results')).toHaveLength(0);
  });

  it('completes a known call; prompts, runs, compactions, hook runs and meta work', () => {
    const { db, path } = open();
    db.upsertApiCall(call({}, [tu('t1')]));
    db.completeToolCall('t1', { endedTs: 'E', resultChars: 3, isError: false, denied: true, permission: null });
    const run = { id: 'main:s1', sessionId: 's1', agentType: 'main', description: null, launchToolUseId: null,
      parentRunId: null, file: 'f' };
    db.upsertRun(run);
    db.upsertRun({ ...run, description: 'd' });
    db.insertPrompt({ uuid: 'p1', sessionId: 's1', ts: 't', text: 'hi', durationMs: null });
    db.insertPrompt({ uuid: 'p1', sessionId: 's1', ts: 't', text: 'hi', durationMs: 5 });
    db.insertCompaction({ sessionId: 's1', runId: 'main:s1', ts: 't', preTokens: 1, durationMs: 2, trigger: 'auto' });
    db.insertHookRuns('s1', 't', [{ command: 'c', durationMs: 1 }, { command: 'd', durationMs: 2 }]);
    expect(db.meta.get('k')).toBeNull();
    db.meta.set('k', 'v');
    db.meta.set('k', 'w');
    expect(db.meta.get('k')).toBe('w');
    db.close();
    expect(raw(path, 'select * from tool_calls')[0]).toMatchObject({ ended_ts: 'E', result_chars: 3, denied: 1 });
    expect(raw(path, 'select * from runs')).toHaveLength(1);
    expect(raw(path, 'select description from runs')[0].description).toBe('d');
    expect(raw(path, 'select * from prompts')).toHaveLength(1);
    expect(raw(path, 'select duration_ms from prompts')[0].duration_ms).toBe(5);
    expect(raw(path, 'select * from compactions')).toHaveLength(1);
    expect(raw(path, 'select * from hook_runs')).toHaveLength(2);
  });

  it('completeToolCall for an unknown call parks it as pending without error', () => {
    const { db, path } = open();
    db.completeToolCall('nope', { endedTs: 'E', resultChars: 1, isError: false, denied: false, permission: null });
    db.close();
    expect(raw(path, 'select * from tool_calls')).toHaveLength(0);
    expect(raw(path, 'select * from pending_results')).toHaveLength(1);
  });
});
