import {
  appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priceCall } from '../../src/core/prices';
import { indexAll, indexFile } from '../../src/ingest/indexer';
import { openDb, type Db } from '../../src/store/db';

const FX = join(__dirname, '..', 'fixtures');
const SUB = join(FX, 'subagents');
const AGENT = 'agent-a0000000000000049';
const SID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A temp transcripts root (with a space in it) plus a fresh store. */
function setup(): { root: string; proj: string; db: Db } {
  const d = mkdtempSync(join(tmpdir(), 'tt idx '));
  dirs.push(d);
  const root = join(d, 'projects root');
  const proj = join(root, 'C--some project');
  mkdirSync(proj, { recursive: true });
  const db = openDb(join(d, 'tracker.db'));
  dbs.push(db);
  return { root, proj, db };
}

/** Copies every main fixture to <proj>/<name>.jsonl and the subagent under <proj>/agent/subagents/. */
function copyCorpus(proj: string): void {
  for (const f of readdirSync(FX)) if (f.endsWith('.jsonl')) copyFileSync(join(FX, f), join(proj, f));
  const sub = join(proj, 'agent', 'subagents');
  mkdirSync(sub, { recursive: true });
  copyFileSync(join(SUB, `${AGENT}.jsonl`), join(sub, `${AGENT}.jsonl`));
  copyFileSync(join(SUB, `${AGENT}.meta.json`), join(sub, `${AGENT}.meta.json`));
}

const all = (db: Db, sql: string, ...p: (string | number)[]): any[] => db.raw.prepare(sql).all(...p) as any[];
const one = (db: Db, sql: string, ...p: (string | number)[]): any => db.raw.prepare(sql).get(...p);
const totalCost = (db: Db): number => one(db, 'SELECT COALESCE(SUM(cost),0) c FROM api_calls').c
  + one(db, 'SELECT COALESCE(SUM(cost),0) c FROM advisor_calls').c;
const fxLines = (name: string): string[] => readFileSync(join(FX, name), 'utf8').split('\n').filter(Boolean);

const promptLine = (sid: string, ts: string, text: string, uuid?: string): string => JSON.stringify({
  type: 'user', sessionId: sid, timestamp: ts, message: { role: 'user', content: text }, ...(uuid ? { uuid } : {}),
});

describe('indexer', () => {
  it('indexes fixture corpus: call count, total cost', () => {
    const { root, proj, db } = setup();
    copyCorpus(proj);
    const r = indexAll(db, { root });
    expect(r.files).toBe(9);
    expect(r.newCalls).toBe(6);
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls').n).toBe(6);
    expect(totalCost(db)).toBeCloseTo(0.8423, 3);
    // every fixture call is a known model, so nothing is unpriced
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls WHERE cost IS NULL').n).toBe(0);
    // ctx_tokens = input + both cache writes + cache read
    for (const c of all(db, 'SELECT * FROM api_calls')) {
      expect(c.ctx_tokens).toBe(c.input + c.cache_write_5m + c.cache_write_1h + c.cache_read);
    }
    expect(all(db, 'SELECT DISTINCT model FROM api_calls ORDER BY model').map((x) => x.model))
      .toEqual(['haiku-5-5', 'opus-5-5']);
    expect(one(db, 'SELECT COUNT(*) n FROM advisor_calls').n).toBe(1);
  });

  it('keeps partial trailing line for next pass', () => {
    const { proj, db } = setup();
    const line = fxLines('mcp.jsonl')[0];
    const f = join(proj, `${SID(1)}.jsonl`);
    const half = Math.floor(line.length / 2);
    writeFileSync(f, line.slice(0, half));
    const r1 = indexFile(db, f);
    expect(r1.newCalls).toBe(0);
    expect(db.getFileState(f)?.offset).toBe(0);
    appendFileSync(f, `${line.slice(half)}\n`);
    const r2 = indexFile(db, f);
    expect(r2.newCalls).toBe(1);
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls').n).toBe(1);
    expect(db.getFileState(f)?.offset).toBe(Buffer.byteLength(line) + 1);
  });

  it('dedupes message ids across files', () => {
    const { root, proj, db } = setup();
    copyFileSync(join(FX, 'split-response.jsonl'), join(proj, `${SID(1)}.jsonl`));
    indexAll(db, { root });
    const once = totalCost(db);
    // a resumed/forked session repeats the same response in a second file
    copyFileSync(join(FX, 'split-response.jsonl'), join(proj, `${SID(2)}.jsonl`));
    const r = indexAll(db, { root });
    expect(r.newCalls).toBe(0);
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls').n).toBe(1);
    expect(totalCost(db)).toBeCloseTo(once, 10);
  });

  it('rescans truncated file without double counting', () => {
    const { proj, db } = setup();
    const f = join(proj, `${SID(1)}.jsonl`);
    // system.jsonl holds the only compact_boundary and stop_hook_summary records
    const body = [...fxLines('split-response.jsonl'), ...fxLines('system.jsonl')].join('\n') + '\n';
    writeFileSync(f, body);
    indexFile(db, f);
    const before = {
      calls: one(db, 'SELECT COUNT(*) n FROM api_calls').n,
      tools: one(db, 'SELECT COUNT(*) n FROM tool_calls').n,
      prompts: one(db, 'SELECT COUNT(*) n FROM prompts').n,
      compactions: one(db, 'SELECT COUNT(*) n FROM compactions').n,
      hooks: one(db, 'SELECT COUNT(*) n FROM hook_runs').n,
      cost: totalCost(db),
    };
    expect(before.compactions).toBe(1);
    expect(before.hooks).toBeGreaterThan(0);
    // rewritten shorter than the stored offset (last line dropped): rescan from 0
    const lines = body.split('\n').filter(Boolean);
    writeFileSync(f, lines.slice(0, -1).join('\n') + '\n');
    expect(Buffer.byteLength(lines.slice(0, -1).join('\n') + '\n')).toBeLessThan(db.getFileState(f)!.offset);
    indexFile(db, f);
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls').n).toBe(before.calls);
    expect(one(db, 'SELECT COUNT(*) n FROM tool_calls').n).toBe(before.tools);
    expect(one(db, 'SELECT COUNT(*) n FROM prompts').n).toBe(before.prompts);
    expect(one(db, 'SELECT COUNT(*) n FROM compactions').n).toBe(before.compactions);
    expect(one(db, 'SELECT COUNT(*) n FROM hook_runs').n).toBe(before.hooks);
    expect(totalCost(db)).toBeCloseTo(before.cost, 10);
  });

  it('marks deleted file missing and keeps its rows', () => {
    const { root, proj, db } = setup();
    const f = join(proj, `${SID(1)}.jsonl`);
    copyFileSync(join(FX, 'split-response.jsonl'), f);
    indexAll(db, { root });
    rmSync(f);
    indexAll(db, { root });
    expect(db.getFileState(f)?.missing).toBe(true);
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls').n).toBe(1);
  });

  it('subagent run linked to launching tool call', () => {
    const { root, proj, db } = setup();
    copyFileSync(join(FX, 'agent.jsonl'), join(proj, `${SID(47)}.jsonl`));
    const sub = join(proj, SID(47), 'subagents');
    mkdirSync(sub, { recursive: true });
    copyFileSync(join(SUB, `${AGENT}.jsonl`), join(sub, `${AGENT}.jsonl`));
    copyFileSync(join(SUB, `${AGENT}.meta.json`), join(sub, `${AGENT}.meta.json`));
    indexAll(db, { root });
    const meta = JSON.parse(readFileSync(join(SUB, `${AGENT}.meta.json`), 'utf8'));
    const run = one(db, 'SELECT * FROM runs WHERE id = ?', AGENT);
    expect(run).toMatchObject({ agent_type: meta.agentType, description: meta.description,
      launch_tool_use_id: meta.toolUseId });
    const launch = one(db, 'SELECT * FROM tool_calls WHERE tool_use_id = ?', meta.toolUseId);
    expect(launch).toBeTruthy();
    expect(launch.run_id).toBe(`main:${SID(47)}`);
    expect(run.parent_run_id).toBe(`main:${SID(47)}`);
    expect(run.session_id).toBe(SID(47));
    const calls = all(db, 'SELECT * FROM api_calls WHERE run_id = ?', AGENT);
    expect(calls).toHaveLength(1);
    // a subagent's prompt is resolved through the launching tool call, not stored on its calls
    expect(calls[0].prompt_uuid).toBeNull();
    expect(one(db, 'SELECT COUNT(*) n FROM prompts WHERE session_id = ?', run.session_id).n).toBe(0);
  });

  it('second pass with no changes reads 0 bytes', () => {
    const { root, proj, db } = setup();
    copyCorpus(proj);
    const r1 = indexAll(db, { root });
    expect(r1.bytesRead).toBeGreaterThan(0);
    const r2 = indexAll(db, { root });
    expect(r2.bytesRead).toBe(0);
    expect(r2.newCalls).toBe(0);
    expect(r2.newPrompts).toBe(0);
    expect(r2.changedSessions).toEqual([]);
  });

  it('attributes calls to the latest main-file prompt across passes; turn_duration sets its duration', () => {
    const { proj, db } = setup();
    const sid = SID(9);
    const f = join(proj, `${sid}.jsonl`);
    writeFileSync(f, `${promptLine(sid, '2026-11-03T15:00:00.000Z', 'first', 'u-1')}\n`);
    const r1 = indexFile(db, f);
    expect(r1.newPrompts).toBe(1);
    expect(r1.changedSessions).toEqual([sid]);
    // next pass: the assistant reply arrives on its own, then the turn's duration
    const reply = JSON.parse(fxLines('mcp.jsonl')[0]);
    reply.sessionId = sid;
    const dur = { type: 'system', subtype: 'turn_duration', timestamp: '2026-11-03T15:01:00.000Z', durationMs: 4321 };
    appendFileSync(f, `${JSON.stringify(reply)}\n${JSON.stringify(dur)}\n`);
    indexFile(db, f);
    expect(one(db, 'SELECT prompt_uuid, session_id, run_id FROM api_calls')).toEqual(
      { prompt_uuid: 'u-1', session_id: sid, run_id: `main:${sid}` });
    const tools = all(db, 'SELECT prompt_uuid FROM tool_calls');
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) expect(t.prompt_uuid).toBe('u-1');
    expect(one(db, 'SELECT duration_ms FROM prompts WHERE uuid = ?', 'u-1').duration_ms).toBe(4321);
  });

  it('prompts without a uuid get a stable synthetic id each', () => {
    const { proj, db } = setup();
    const sid = SID(10);
    const f = join(proj, `${sid}.jsonl`);
    const body = `${promptLine(sid, '2026-11-03T15:00:00.000Z', 'a')}\n`
      + `${promptLine(sid, '2026-11-03T15:05:00.000Z', 'b')}\n`;
    writeFileSync(f, body);
    indexFile(db, f);
    writeFileSync(f, body.slice(0, 10)); // truncate, then restore: rescan must reuse the same ids
    indexFile(db, f);
    writeFileSync(f, body);
    indexFile(db, f);
    expect(all(db, 'SELECT uuid FROM prompts ORDER BY ts').map((p) => p.uuid)).toEqual(
      [`${sid}:2026-11-03T15:00:00.000Z`, `${sid}:2026-11-03T15:05:00.000Z`]);
  });

  it('tool result completes its tool call', () => {
    const { proj, db } = setup();
    const f = join(proj, `${SID(11)}.jsonl`);
    copyFileSync(join(FX, 'skill-slash.jsonl'), f); // Skill tool_use ...26 and its tool_result
    indexFile(db, f);
    const res = JSON.parse(fxLines('skill-slash.jsonl')[1]);
    const t = one(db, 'SELECT * FROM tool_calls WHERE tool_use_id = ?', 'toolu_FFFFFFFFFFFFFFFFFFFFFF26');
    expect(t.skill).not.toBeNull();
    expect(t.ended_ts).toBe(res.timestamp);
    expect(t.result_chars).toBeGreaterThan(0);
    expect(one(db, 'SELECT COUNT(*) n FROM pending_results').n).toBe(0);
  });

  it('one unreadable file does not stop the pass', () => {
    const { root, proj, db } = setup();
    // 'a…' sorts before 'b…', so the failing file comes first in the pass
    const bad = join(proj, `a-${SID(56)}.jsonl`);
    const good = join(proj, `b-${SID(4)}.jsonl`);
    copyFileSync(join(FX, 'mcp.jsonl'), bad);
    copyFileSync(join(FX, 'split-response.jsonl'), good);
    db.raw.exec(`CREATE TRIGGER fail_one BEFORE INSERT ON api_calls WHEN NEW.session_id = '${SID(56)}'
      BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
    const r = indexAll(db, { root });
    expect(r.failed).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].path).toBe(bad);
    expect(r.errors[0].message).toContain('simulated write failure');
    expect(r.newCalls).toBe(1); // the later file still indexed
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls WHERE session_id = ?', SID(4)).n).toBe(1);
    expect(db.getFileState(bad)).toBeNull(); // rolled back: nothing recorded, retried next pass
    db.raw.exec('DROP TRIGGER fail_one');
    const r2 = indexAll(db, { root });
    expect(r2.failed).toBe(0);
    expect(r2.newCalls).toBe(1);
  });

  it('subagent indexed before parent gets parent_run_id after the pass', () => {
    const { root, proj, db } = setup();
    copyFileSync(join(FX, 'agent.jsonl'), join(proj, `${SID(47)}.jsonl`));
    const sub = join(proj, SID(47), 'subagents');
    mkdirSync(sub, { recursive: true });
    const subFile = join(sub, `${AGENT}.jsonl`);
    copyFileSync(join(SUB, `${AGENT}.jsonl`), subFile);
    // depth 2: no main-thread fallback, the parent must come from the launching tool call
    const meta = JSON.parse(readFileSync(join(SUB, `${AGENT}.meta.json`), 'utf8'));
    writeFileSync(join(sub, `${AGENT}.meta.json`), JSON.stringify({ ...meta, spawnDepth: 2 }));
    indexFile(db, subFile);
    expect(one(db, 'SELECT parent_run_id FROM runs WHERE id = ?', AGENT).parent_run_id).toBeNull();
    const r = indexAll(db, { root }); // subagent file unchanged, so only the re-resolution can fix it
    expect(r.failed).toBe(0);
    expect(one(db, 'SELECT parent_run_id FROM runs WHERE id = ?', AGENT).parent_run_id).toBe(`main:${SID(47)}`);
  });

  it('rescan from 0 without a prompt does not reuse the pre-truncation prompt', () => {
    const { proj, db } = setup();
    const sid = SID(12);
    const f = join(proj, `${sid}.jsonl`);
    writeFileSync(f, `${promptLine(sid, '2026-11-03T15:00:00.000Z', 'old', 'u-old')}\n${fxLines('agent.jsonl')[0]}\n`);
    indexFile(db, f);
    const shorter = `${fxLines('mcp.jsonl')[0]}\n`;
    expect(Buffer.byteLength(shorter)).toBeLessThan(db.getFileState(f)!.offset);
    writeFileSync(f, shorter);
    indexFile(db, f);
    // a later tail pass (offset > 0) must not pick the old prompt back up from stored state
    appendFileSync(f, `${fxLines('skill-slash.jsonl')[0]}\n`);
    indexFile(db, f);
    for (const name of ['mcp.jsonl', 'skill-slash.jsonl']) {
      const id = JSON.parse(fxLines(name)[0]).message.id;
      expect(one(db, 'SELECT prompt_uuid FROM api_calls WHERE message_id = ?', id).prompt_uuid, name).toBeNull();
    }
  });

  it('multi-byte UTF-8 line straddling a read chunk boundary decodes intact', () => {
    const { proj, db } = setup();
    const sid = SID(13);
    const f = join(proj, `${sid}.jsonl`);
    const text = 'naïve café — 日本語 🚀 '.repeat(20);
    writeFileSync(f, `${promptLine(sid, '2026-11-03T15:00:00.000Z', text, 'u-utf8')}\n`);
    // 7-byte chunks split the 2-, 3- and 4-byte sequences many times over
    const r = indexFile(db, f, { chunkSize: 7 });
    expect(r.newPrompts).toBe(1);
    expect(one(db, 'SELECT text FROM prompts WHERE uuid = ?', 'u-utf8').text).toBe(text);
    expect(db.getFileState(f)?.offset).toBe(readFileSync(f).length);
  });

  it('parity with reference script', () => {
    const { root, proj, db } = setup();
    copyCorpus(proj);
    indexAll(db, { root });
    const ref = JSON.parse(readFileSync(join(FX, 'reference-totals.json'), 'utf8'));
    // The reference dedupes message ids per file; we dedupe globally. The only id that repeats across fixture
    // files (msg_...F6 in split-response.jsonl and system.jsonl) sits on a line with a raw control character that
    // both JSON parsers reject, so the expected difference is exactly 0.
    // The reference also keeps the first part of a split response while we keep the largest output/thinking.
    // Every split id in the fixtures (msg_...F6 x3, msg_...110 x4) has identical usage on all parts, so that
    // difference is exactly 0 too.
    const crossFileDuplicateCost = 0;
    expect(Math.abs(totalCost(db) + crossFileDuplicateCost - ref.summary[0].total)).toBeLessThan(0.01);
    const short = (m: string): string => m.replace(/^claude-/, '');
    for (const m of ref.models as { name: string; cost: number }[]) {
      const adv = /^advisor\W+(.+)$/.exec(m.name);
      const ours = adv
        ? one(db, 'SELECT COALESCE(SUM(cost),0) c FROM advisor_calls WHERE model = ?', short(adv[1])).c
        : one(db, 'SELECT COALESCE(SUM(cost),0) c FROM api_calls WHERE model = ?', short(m.name)).c;
      expect(Math.abs(ours - m.cost), m.name).toBeLessThan(0.01);
    }
  });

  /** split-response.jsonl's prompt plus its three parts of one message, with output/thinking overridden. */
  const splitBody = (usages: [number, number][]): string => {
    const ls = fxLines('split-response.jsonl');
    const parts = ls.slice(1, 4).map((l, i) => {
      const j = JSON.parse(l);
      j.message.usage.output_tokens = usages[i]![0];
      j.message.usage.output_tokens_details = { thinking_tokens: usages[i]![1] };
      return JSON.stringify(j);
    });
    return [ls[0], ...parts, ...ls.slice(4)].join('\n') + '\n';
  };
  const F6 = 'msg_FFFFFFFFFFFFFFFFFFFFFFF6';

  it('split response keeps the largest output and thinking', () => {
    const { proj, db } = setup();
    const f = join(proj, `${SID(20)}.jsonl`);
    // low, then high, then mid: the last part must not downgrade the stored row
    writeFileSync(f, splitBody([[100, 10], [400, 40], [250, 25]]));
    const r = indexFile(db, f);
    expect(r.newCalls).toBe(1);
    const row = one(db, 'SELECT * FROM api_calls WHERE message_id = ?', F6);
    const first = JSON.parse(fxLines('split-response.jsonl')[1]!);
    expect(row.ts).toBe(first.timestamp);
    expect(row.prompt_uuid).toBe(JSON.parse(fxLines('split-response.jsonl')[0]!).uuid);
    expect(row.output).toBe(400 - 40);
    expect(row.thinking).toBe(40);
    const u = first.message.usage;
    const merged = { input: row.input, cacheWrite5m: row.cache_write_5m, cacheWrite1h: row.cache_write_1h,
      cacheRead: row.cache_read, output: 360, thinking: 40 };
    expect(row.input).toBe(u.input_tokens);
    const pr = priceCall('opus-5-5', merged, row.ts, row.speed);
    expect(row.cost).toBeCloseTo(pr.cost!, 10);
    expect(JSON.parse(row.cost_parts_json)).toEqual(pr.parts);
    expect(row.price_id).toBe(pr.priceId);
    expect(JSON.parse(row.raw_json).message.usage.output_tokens).toBe(400);
    expect(one(db, 'SELECT COUNT(*) n FROM advisor_calls').n).toBe(0);
  });

  it('migration triggers a re-read that corrects existing rows', () => {
    const d = mkdtempSync(join(tmpdir(), 'tt idx '));
    dirs.push(d);
    const root = join(d, 'projects');
    const proj = join(root, 'p');
    mkdirSync(proj, { recursive: true });
    const dbFile = join(d, 'tracker.db');
    const f = join(proj, `${SID(21)}.jsonl`);
    writeFileSync(f, splitBody([[100, 10], [400, 40], [400, 40]]));
    let db = openDb(dbFile);
    indexAll(db, { root });
    // What an older build stored: the first part's output, thinking and cost.
    db.raw.prepare('UPDATE api_calls SET output = 90, thinking = 10, cost = 0.001 WHERE message_id = ?').run(F6);
    db.close();

    db = openDb(dbFile); // control: an unchanged file is skipped, so the stale row stays
    indexAll(db, { root });
    expect(one(db, 'SELECT output FROM api_calls WHERE message_id = ?', F6).output).toBe(90);
    db.raw.exec('PRAGMA user_version = 2');
    db.close();

    db = openDb(dbFile);
    dbs.push(db);
    expect(db.getFileState(f)?.offset).toBe(0);
    const r = indexAll(db, { root });
    expect(r.newCalls).toBe(0);
    const row = one(db, 'SELECT output, thinking, cost FROM api_calls WHERE message_id = ?', F6);
    expect(row).toMatchObject({ output: 360, thinking: 40 });
    expect(row.cost).toBeGreaterThan(0.001);
    expect(one(db, 'SELECT COUNT(*) n FROM api_calls').n).toBe(1);
    expect(one(db, 'SELECT COUNT(*) n FROM prompts').n).toBe(1);
    expect(one(db, 'SELECT COUNT(*) n FROM tool_calls').n).toBe(2);
  });
});
