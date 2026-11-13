import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { indexAll } from '../../src/ingest/indexer';
import {
  agentDetail, agents, coverage, overview, promptDetail, prompts, sessionDetail, sessions, statusLine,
} from '../../src/query/views';
import { openDb, type Db } from '../../src/store/db';

process.env.TZ = 'America/Chicago';
const FX = join(__dirname, '..', 'fixtures');
const AGENT = 'agent-a0000000000000049';
const ALL = { preset: 'all' } as const;

const dirs: string[] = [];
const dbs: Db[] = [];
const realHome = process.env.TOKEN_TRACKER_HOME;
beforeEach(() => { // never read the developer's real data home
  const h = mkdtempSync(join(tmpdir(), 'tt home '));
  dirs.push(h);
  process.env.TOKEN_TRACKER_HOME = h;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.TOKEN_TRACKER_HOME; else process.env.TOKEN_TRACKER_HOME = realHome;
  while (dbs.length) dbs.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function freshDb(): Db {
  const d = mkdtempSync(join(tmpdir(), 'tt qry '));
  dirs.push(d);
  const db = openDb(join(d, 'tracker.db'));
  dbs.push(db);
  return db;
}

/** A store built by the real indexer over a copy of the fixture corpus. */
function fixtureDb(): Db {
  const d = mkdtempSync(join(tmpdir(), 'tt qryfx '));
  dirs.push(d);
  const proj = join(d, 'projects root', 'C--some project');
  mkdirSync(join(proj, 'agent', 'subagents'), { recursive: true });
  for (const f of readdirSync(FX)) if (f.endsWith('.jsonl')) copyFileSync(join(FX, f), join(proj, f));
  for (const e of ['jsonl', 'meta.json']) {
    copyFileSync(join(FX, 'subagents', `${AGENT}.${e}`), join(proj, 'agent', 'subagents', `${AGENT}.${e}`));
  }
  const db = openDb(join(d, 'tracker.db'));
  dbs.push(db);
  indexAll(db, { root: join(d, 'projects root') });
  return db;
}

const zero = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0 };
let seq = 0;

/** Hand-inserts one api call; cost parts default to everything in `output`. */
function call(db: Db, o: {
  session: string; run: string; prompt?: string | null; ts: string; model?: string; cost: number | null;
  tokens?: Partial<typeof zero>; ctx?: number; parts?: Partial<typeof zero>; advisor?: number; tools?: string[];
}): string {
  const id = `msg_${++seq}`;
  const parts = o.cost === null ? null : JSON.stringify({ ...zero, output: o.cost, ...o.parts });
  db.upsertApiCall({
    messageId: id, sessionId: o.session, runId: o.run, promptUuid: o.prompt ?? null, ts: o.ts,
    model: o.model ?? 'opus-5-5', effort: null, speed: 'standard', tokens: { ...zero, output: 10, ...o.tokens },
    ctxTokens: o.ctx ?? 100, cost: o.cost, costPartsJson: parts, priceId: null, thinkingMs: null, rawJson: null,
    toolUses: (o.tools ?? []).map((t) => ({
      id: t, name: 'Agent', label: 'Agent', skill: null, inputJson: '{}', inputChars: 2,
    })),
    advisor: o.advisor ? [{ model: 'opus-5-5', tokens: { ...zero, output: 5 }, cost: o.advisor }] : [],
  });
  return id;
}

/** One session with a main run and its prompts. */
function seedSession(db: Db, sid: string, ps: { uuid: string; ts: string; text: string }[]): void {
  db.upsertSession({ id: sid, title: `Title ${sid}`, project: 'proj', cwd: null, firstTs: ps[0].ts,
    lastTs: ps[ps.length - 1].ts, ccVersion: null });
  db.upsertRun({ id: `main:${sid}`, sessionId: sid, agentType: 'main', description: null, launchToolUseId: null,
    parentRunId: null, file: null });
  for (const p of ps) db.insertPrompt({ uuid: p.uuid, sessionId: sid, ts: p.ts, text: p.text, durationMs: 1000 });
}

function addAgentRun(db: Db, sid: string, type: string, n: number, launchTool: string, parent = `main:${sid}`): string {
  const id = `${sid}:${type}:${n}`;
  db.upsertRun({ id, sessionId: sid, agentType: type, description: `${type} ${n}`, launchToolUseId: launchTool,
    parentRunId: parent, file: null });
  return id;
}

describe('views over the fixture corpus', () => {
  it('overview parts sum to total', () => {
    const db = fixtureDb();
    const o = overview(db, ALL);
    expect(o.calls).toBe(6);
    expect(o.total).toBeCloseTo(0.8423, 3);
    expect(o.parts.reduce((a, p) => a + p.cost, 0)).toBeCloseTo(o.total, 9);
    expect(o.parts.find((p) => p.key === 'advisor')!.cost).toBeGreaterThan(0);
    expect(o.daily.reduce((a, d) => a + d.cost, 0)).toBeCloseTo(o.total, 9);
    expect(o.heat.reduce((a, h) => a + h.cost, 0)).toBeCloseTo(o.total, 9);
    expect(o.takeaway).toMatch(/ were \d+% of spend\.$/);
    expect(o.unpricedCalls).toBe(0);
  });

  it('empty store reports no usage', () => {
    const o = overview(freshDb(), ALL);
    expect(o.total).toBe(0);
    expect(o.takeaway).toBe('No usage recorded yet.');
    expect(sessions(freshDb(), ALL)).toEqual([]);
  });

  it('prompts, sessions, agents, coverage all answer on the fixture corpus', () => {
    const db = fixtureDb();
    const ss = sessions(db, ALL);
    expect(ss.reduce((a, s) => a + s.cost, 0)).toBeCloseTo(0.8423, 3);
    const ps = prompts(db, ALL);
    expect(ps.length).toBeGreaterThan(0);
    const d = sessionDetail(db, ss[0].id);
    expect(d.session!.id).toBe(ss[0].id);
    expect(d.ctxSeries.length).toBeGreaterThan(0);
    expect(agents(db, ALL).some((a) => a.type === 'custom-agent-1' && a.kind === 'custom')).toBe(true);
    expect(agents(db, ALL).find((a) => a.type === 'main')!.kind).toBe('main');
    const cov = coverage(db);
    expect(cov.sessionsComplete + cov.sessionsPartial).toBeGreaterThan(0);
    const detail = promptDetail(db, ps.find((p) => p.total > 0)!.uuid)!;
    expect(detail.parts.reduce((a, p) => a + p.cost, 0)).toBeCloseTo(detail.prompt.total, 9);
  });
});

describe('views over hand-built data', () => {
  it('prompt total includes subagent cost via launching tool call', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'Do the thing' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:01.000Z', cost: 1, tools: ['tu_a'] });
    const sub = addAgentRun(db, 's1', 'custom-x', 1, 'tu_a');
    // nested: the child's launching tool call lives inside the subagent run (no prompt of its own)
    call(db, { session: 's1', run: sub, ts: '2026-11-10T15:00:02.000Z', cost: 2, tools: ['tu_b'] });
    const nested = addAgentRun(db, 's1', 'custom-y', 1, 'tu_b', sub);
    call(db, { session: 's1', run: nested, ts: '2026-11-10T15:00:03.000Z', cost: 4 });
    const [p] = prompts(db, ALL);
    expect(p.cost).toBeCloseTo(1);
    expect(p.agentCost).toBeCloseTo(6);
    expect(p.total).toBeCloseTo(7);
    expect(p.calls).toBe(3);
    const d = promptDetail(db, 'p1')!;
    expect(d.runs.map((r) => r.agentType).sort()).toEqual(['custom-x', 'custom-y', 'main']);
    expect(d.runs.find((r) => r.agentType === 'custom-y')!.promptText).toBe('Do the thing');
    expect(d.summary.agentCost).toBeCloseTo(6);
    expect(d.byPart.map((b) => b.label).sort()).toEqual(['Main thread', 'custom-x', 'custom-y']);
    expect(sessions(db, ALL)[0].agentCost).toBeCloseTo(6);
    expect(statusLine(db, 's1', new Date('2026-11-10T20:00:00Z')).session).toBeCloseTo(7);
  });

  it('prompts search matches full text case-insensitively', () => {
    const db = freshDb();
    seedSession(db, 's1', [
      { uuid: 'a', ts: '2026-11-10T15:00:00.000Z', text: 'Refactor the Billing module, then run tests' },
      { uuid: 'b', ts: '2026-11-10T16:00:00.000Z', text: 'unrelated 100%_literal' },
    ]);
    expect(prompts(db, ALL, 'BILLING MODULE').map((p) => p.uuid)).toEqual(['a']);
    expect(prompts(db, ALL, 'run tests').map((p) => p.uuid)).toEqual(['a']);
    expect(prompts(db, ALL, '100%_').map((p) => p.uuid)).toEqual(['b']);
    expect(prompts(db, ALL, 'nomatch')).toEqual([]);
  });

  function seedRuns(costs: number[]): Db {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'go' }]);
    costs.forEach((c, i) => {
      call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: `2026-11-10T15:00:0${i}.000Z`, cost: 0.01,
        tools: [`tu${i}`] });
      const run = addAgentRun(db, 's1', 'Explore', i, `tu${i}`);
      call(db, { session: 's1', run, ts: `2026-11-10T15:10:0${i}.000Z`, cost: c });
    });
    return db;
  }

  it('run flagged above 3x median with 5 prior runs', () => {
    const db = seedRuns([1, 1, 1, 1, 1, 3.5]);
    const d = agentDetail(db, 'Explore', ALL);
    expect(d.runs.filter((r) => r.flagged).map((r) => r.cost)).toEqual([3.5]);
    expect(d.stats!.flaggedRuns).toBe(1);
    expect(d.stats!.kind).toBe('built-in');
    expect(d.medianCost).toBeCloseTo(1);
    expect(statusLine(db, 's1', new Date('2026-11-10T20:00:00Z')).alerts).toBe(1);
  });

  it('not flagged with only 4 prior runs', () => {
    const db = seedRuns([1, 1, 1, 1, 50]);
    const d = agentDetail(db, 'Explore', ALL);
    expect(d.runs.some((r) => r.flagged)).toBe(false);
    expect(statusLine(db, 's1', new Date('2026-11-10T20:00:00Z')).alerts).toBe(0);
  });

  it('not flagged at exactly 3x the median', () => {
    const db = seedRuns([1, 1, 1, 1, 1, 3]);
    expect(agentDetail(db, 'Explore', ALL).runs.some((r) => r.flagged)).toBe(false);
  });

  it('unknown-model calls counted in tokens but listed as unpriced', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'go' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:01.000Z', cost: 2,
      tokens: { output: 100 } });
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:02.000Z', cost: null,
      model: 'mystery-9', tokens: { output: 400 } });
    const o = overview(db, ALL);
    expect(o.calls).toBe(2);
    expect(o.unpricedCalls).toBe(1);
    expect(o.tokens).toBe(500);
    expect(o.total).toBeCloseTo(2);
    expect(prompts(db, ALL)[0].total).toBeCloseTo(2);
  });

  it('daily buckets, heat map and range split use local time', () => {
    const db = freshDb();
    // 03:30Z on Nov 11 is 21:30 local on Nov 10 (Tuesday)
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-11T03:30:00.000Z', text: 'late' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-11T03:30:00.000Z', cost: 1 });
    const o = overview(db, ALL);
    expect(o.daily.map((d) => d.day)).toEqual(['2026-11-10']);
    expect(o.heat).toEqual([{ weekday: 2, hour: 21, cost: 1 }]);
    expect(overview(db, { preset: 'today' }, new Date('2026-11-11T05:00:00Z')).total).toBeCloseTo(1); // 23:00 local
    const next = overview(db, { preset: 'today' }, new Date('2026-11-11T07:00:00Z'));
    expect(next.total).toBe(0);
    expect(next.prevTotal).toBeCloseTo(1);
  });

  it('advisor cost counts in overview parts, totals and prompt cost', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'go' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:01.000Z', cost: 1, advisor: 0.5 });
    const o = overview(db, ALL);
    expect(o.total).toBeCloseTo(1.5);
    expect(o.parts.find((p) => p.key === 'advisor')!.cost).toBeCloseTo(0.5);
    expect(o.parts.reduce((a, p) => a + p.cost, 0)).toBeCloseTo(o.total);
    expect(prompts(db, ALL)[0].total).toBeCloseTo(1.5);
    expect(promptDetail(db, 'p1')!.summary.advisorCalls).toBe(1);
  });

  it('takeaway names the leading cost group', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'go' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:01.000Z', cost: 4,
      parts: { output: 1, cacheRead: 2, cacheWrite5m: 1 } });
    expect(overview(db, ALL).takeaway).toBe('Cache reads and writes were 75% of spend.');
  });

  it('agents reconcile with overview for a main session spanning two local days', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'old' },
      { uuid: 'p2', ts: '2026-11-12T15:00:00.000Z', text: 'new' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:01.000Z', cost: 10 });
    call(db, { session: 's1', run: 'main:s1', prompt: 'p2', ts: '2026-11-12T15:00:01.000Z', cost: 1, tools: ['tu1'] });
    const sub = addAgentRun(db, 's1', 'Explore', 1, 'tu1');
    call(db, { session: 's1', run: sub, ts: '2026-11-12T15:00:02.000Z', cost: 2 });
    const now = new Date('2026-11-12T18:00:00Z');
    const rows = agents(db, { preset: 'today' }, now);
    expect(rows.find((a) => a.type === 'main')!.cost).toBeCloseTo(1);
    expect(rows.find((a) => a.type === 'main')!.runs).toBe(1);
    expect(rows.reduce((a, x) => a + x.cost, 0)).toBeCloseTo(overview(db, { preset: 'today' }, now).total);
    expect(rows.reduce((a, x) => a + x.pct, 0)).toBeCloseTo(100);
    expect(agents(db, ALL).find((a) => a.type === 'main')!.cost).toBeCloseTo(11);
  });

  it('coverage reads installedAt from installed.json, falling back to backfill start', () => {
    const db = freshDb();
    expect(coverage(db).installedAt).toBeNull();
    db.meta.set('backfill_progress', JSON.stringify({ done: 1, total: 1, startedAt: '2026-11-01T00:00:00.000Z' }));
    expect(coverage(db).installedAt).toBe('2026-11-01T00:00:00.000Z');
    writeFileSync(join(process.env.TOKEN_TRACKER_HOME!, 'installed.json'), JSON.stringify({ installedAt: '2026-10-20T12:00:00.000Z' }));
    expect(coverage(db).installedAt).toBe('2026-10-20T12:00:00.000Z');
    writeFileSync(join(process.env.TOKEN_TRACKER_HOME!, 'installed.json'), '{not json');
    expect(coverage(db).installedAt).toBe('2026-11-01T00:00:00.000Z');
  });

  it('overview parts sum to total with advisor and an unpriced call together', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-10T15:00:00.000Z', text: 'go' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:01.000Z', cost: 1, advisor: 0.5 });
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-10T15:00:02.000Z', cost: null, model: 'mystery-9' });
    const o = overview(db, ALL);
    expect(o.unpricedCalls).toBe(1);
    expect(o.total).toBeCloseTo(1.5);
    expect(o.parts.reduce((a, p) => a + p.cost, 0)).toBeCloseTo(o.total);
  });

  it('statusLine today splits at local midnight; empty range with data says so', () => {
    const db = freshDb();
    seedSession(db, 's1', [{ uuid: 'p1', ts: '2026-11-11T05:30:00.000Z', text: 'go' }]);
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-11T05:30:00.000Z', cost: 1 }); // 23:30 local Nov 10
    call(db, { session: 's1', run: 'main:s1', prompt: 'p1', ts: '2026-11-11T06:30:00.000Z', cost: 2 }); // 00:30 local Nov 11
    const s = statusLine(db, 's1', new Date('2026-11-11T12:00:00Z'));
    expect(s.today).toBeCloseTo(2);
    expect(s.session).toBeCloseTo(3);
    expect(overview(db, { preset: 'today' }, new Date('2026-12-25T12:00:00Z')).takeaway).toBe('No usage in this period.');
  });
});
