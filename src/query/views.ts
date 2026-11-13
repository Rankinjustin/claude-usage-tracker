import { existsSync, readFileSync } from 'node:fs';
import { stateFile } from '../core/paths';
import type { Range } from '../core/types';
import type { Db } from '../store/db';
import { resolveRange } from './ranges';

export interface RunRow {
  id: string; agentType: string; description: string | null; start: string; durationMs: number; cost: number;
  calls: number; promptUuid: string | null; promptText: string | null; flagged: boolean;
}
export interface PromptRow {
  uuid: string; sessionId: string; sessionTitle: string | null; ts: string; text: string; cost: number;
  agentCost: number; total: number; calls: number; durationMs: number | null; multipleOfMedian: number | null;
}
export interface SessionSummary {
  id: string; title: string | null; project: string | null; start: string; durationMin: number; calls: number;
  cost: number; agentCost: number; peakCtx: number; startCtx: number; compactions: number; models: string[];
}
export interface AgentStats {
  type: string; kind: 'built-in' | 'custom' | 'main'; runs: number; calls: number; cost: number; pct: number;
  perRun: number; avgCtx: number; avgDurationMs: number; errorRate: number; sparkline: number[]; flaggedRuns: number;
}

const PART_KEYS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output', 'thinking'] as const;
type PartKey = typeof PART_KEYS[number];
const COL: Record<PartKey, string> = {
  input: 'input', cacheWrite5m: 'cache_write_5m', cacheWrite1h: 'cache_write_1h', cacheRead: 'cache_read',
  output: 'output', thinking: 'thinking',
};
const BUILT_IN = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'fork']);
const FLAG_MULTIPLE = 3;
const FLAG_MIN_PRIOR = 5;
const SPARK_RUNS = 20;

/**
 * Shared CTEs. `rpf` maps each launched run to the prompt whose tool call started it, walking up through
 * parent runs for nested subagents. `calls` is api_calls with that effective prompt, an is_main flag and
 * the advisor cost of the call.
 */
const WITH_CALLS = `WITH RECURSIVE
rp(run_id, prompt_uuid, nxt, depth) AS (
  SELECT r.id, t.prompt_uuid, t.run_id, 0 FROM runs r JOIN tool_calls t ON t.tool_use_id = r.launch_tool_use_id
  UNION ALL
  SELECT rp.run_id, t2.prompt_uuid, t2.run_id, rp.depth + 1
  FROM rp JOIN runs pr ON pr.id = rp.nxt JOIN tool_calls t2 ON t2.tool_use_id = pr.launch_tool_use_id
  WHERE rp.prompt_uuid IS NULL AND rp.depth < 8
),
rpf AS (SELECT run_id, prompt_uuid FROM rp WHERE prompt_uuid IS NOT NULL),
calls AS (
  SELECT c.message_id, c.session_id, c.run_id, c.ts, c.model, c.ctx_tokens, c.input, c.cache_write_5m,
    c.cache_write_1h, c.cache_read, c.output, c.thinking, c.cost, c.cost_parts_json,
    COALESCE((SELECT SUM(a.cost) FROM advisor_calls a WHERE a.message_id = c.message_id), 0) AS adv,
    COALESCE(c.prompt_uuid, rpf.prompt_uuid) AS eff_prompt,
    (r.agent_type IS NULL OR r.agent_type = 'main') AS is_main,
    COALESCE(r.agent_type, 'main') AS agent_type
  FROM api_calls c LEFT JOIN runs r ON r.id = c.run_id LEFT JOIN rpf ON rpf.run_id = c.run_id
)`;
const CALL_COST = '(COALESCE(cost, 0) + adv)';

type Row = Record<string, any>;

function all(db: Db, sql: string, ...p: (string | number)[]): Row[] {
  return db.raw.prepare(sql).all(...p) as Row[];
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

/** cacheRead / (cacheRead + both cache writes + input), as a percentage. */
function cacheHit(read: number, w5: number, w1: number, input: number): number {
  return pct(read, read + w5 + w1 + input);
}

/** Local calendar day of an ISO instant, as YYYY-MM-DD (timezone read at call time). */
function localDay(ts: string): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function agentKind(type: string): AgentStats['kind'] {
  return type === 'main' ? 'main' : BUILT_IN.has(type) ? 'built-in' : 'custom';
}

const sumTokens = (t: Record<string, number>): number => Object.values(t).reduce((a, b) => a + b, 0);

function parseParts(json: string | null): Partial<Record<PartKey, number>> {
  if (!json) return {};
  try { return JSON.parse(json) as Partial<Record<PartKey, number>>; } catch { return {}; }
}

function advisorTokens(json: string): Record<string, number> {
  try { return JSON.parse(json) as Record<string, number>; } catch { return {}; }
}

/** One-sentence summary naming the largest cost group. */
function takeaway(parts: Record<string, number>, total: number, calls: number, storeHasCalls: boolean): string {
  if (calls === 0) return storeHasCalls ? 'No usage in this period.' : 'No usage recorded yet.';
  if (total <= 0) return 'No priced usage in this range.';
  const groups: [string, number][] = [
    ['Cache reads and writes', parts.cacheRead + parts.cacheWrite5m + parts.cacheWrite1h],
    ['Output and thinking', parts.output + parts.thinking],
    ['Advisor calls', parts.advisor],
    ['Input tokens', parts.input],
  ];
  groups.sort((a, b) => b[1] - a[1]);
  return `${groups[0][0]} were ${Math.round(pct(groups[0][1], total))}% of spend.`;
}

export function overview(db: Db, r: Range, now?: Date) {
  const rg = resolveRange(r, now);
  const rows = all(db, `${WITH_CALLS} SELECT ts, session_id, is_main, ctx_tokens, input, cache_write_5m, cache_write_1h,
    cache_read, output, thinking, cost, cost_parts_json FROM calls WHERE ts >= ? AND ts < ?`, rg.from, rg.to);
  const tok: Record<string, number> = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0,
    advisor: 0 };
  const cost: Record<string, number> = { ...tok };
  const daily = new Map<string, { cost: number; parts: Record<string, number> }>();
  const heat = new Map<string, number>();
  const sessionIds = new Set<string>();
  let total = 0, agentCost = 0, unpricedCalls = 0, mainCtx = 0, mainCalls = 0;

  const day = (ts: string) => {
    const k = localDay(ts);
    let d = daily.get(k);
    if (!d) daily.set(k, d = { cost: 0, parts: {} });
    return d;
  };
  for (const row of rows) {
    sessionIds.add(row.session_id);
    for (const k of PART_KEYS) tok[k] += row[COL[k]];
    if (row.is_main) { mainCtx += row.ctx_tokens; mainCalls++; }
    if (row.cost === null) { unpricedCalls++; continue; }
    total += row.cost;
    if (!row.is_main) agentCost += row.cost;
    const d = day(row.ts);
    d.cost += row.cost;
    const parts = parseParts(row.cost_parts_json);
    for (const k of PART_KEYS) {
      const v = parts[k] ?? 0;
      cost[k] += v;
      d.parts[k] = (d.parts[k] ?? 0) + v;
    }
    const dt = new Date(row.ts);
    const hk = `${dt.getDay()}:${dt.getHours()}`;
    heat.set(hk, (heat.get(hk) ?? 0) + row.cost);
  }
  const adv = all(db, `${WITH_CALLS} SELECT a.tokens_json, a.cost, k.ts, k.is_main FROM advisor_calls a
    JOIN calls k ON k.message_id = a.message_id WHERE k.ts >= ? AND k.ts < ?`, rg.from, rg.to);
  for (const a of adv) {
    tok.advisor += sumTokens(advisorTokens(a.tokens_json));
    if (a.cost === null) continue;
    cost.advisor += a.cost;
    total += a.cost;
    if (!a.is_main) agentCost += a.cost;
    const d = day(a.ts);
    d.cost += a.cost;
    d.parts.advisor = (d.parts.advisor ?? 0) + a.cost;
    const dt = new Date(a.ts);
    const hk = `${dt.getDay()}:${dt.getHours()}`;
    heat.set(hk, (heat.get(hk) ?? 0) + a.cost);
  }

  const prev = all(db, `${WITH_CALLS} SELECT COALESCE(SUM(${CALL_COST}), 0) AS c FROM calls WHERE ts >= ? AND ts < ?`,
    rg.prevFrom, rg.prevTo)[0].c as number;
  const prompts = all(db, 'SELECT COUNT(*) AS n FROM prompts WHERE ts >= ? AND ts < ?', rg.from, rg.to)[0].n as number;
  const keys = [...PART_KEYS, 'advisor'] as const;
  return {
    total,
    prevTotal: prev,
    tokens: sumTokens(tok),
    calls: rows.length,
    unpricedCalls,
    sessions: sessionIds.size,
    prompts,
    cacheHitPct: cacheHit(tok.cacheRead, tok.cacheWrite5m, tok.cacheWrite1h, tok.input),
    parts: keys.map((key) => ({ key, tokens: tok[key], cost: cost[key], pct: pct(cost[key], total) })),
    daily: [...daily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, v]) => ({ day: d, ...v })),
    heat: [...heat.entries()].map(([k, c]) => {
      const [weekday, hour] = k.split(':').map(Number);
      return { weekday, hour, cost: c };
    }),
    subagentPct: pct(agentCost, total),
    mainAvgCtx: mainCalls ? Math.round(mainCtx / mainCalls) : 0,
    takeaway: takeaway(cost, total, rows.length,
      rows.length > 0 || all(db, 'SELECT 1 FROM api_calls LIMIT 1').length > 0),
  };
}

// ---- runs ----

interface RunInfo extends RunRow {
  sessionId: string; ctxSum: number; toolCalls: number; toolErrors: number;
}

/** Every run with calls, with whole-run stats and the flag (cost vs the same type's previous runs). */
function allRuns(db: Db, activeSince?: string): RunInfo[] {
  // activeSince limits work to agent types with calls since then (their history still feeds the medians).
  const scope = activeSince
    ? `WHERE r.agent_type IN (SELECT r2.agent_type FROM runs r2 JOIN api_calls c2 ON c2.run_id = r2.id
        WHERE c2.ts >= ? AND r2.agent_type <> 'main')`
    : '';
  const rows = all(db, `${WITH_CALLS}
    SELECT r.id, r.agent_type, r.description, r.session_id, MIN(k.ts) AS start, MAX(k.ts) AS last_call,
      (SELECT MAX(t.ended_ts) FROM tool_calls t WHERE t.run_id = r.id) AS last_tool,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = r.id) AS tool_n,
      (SELECT COUNT(*) FROM tool_calls t WHERE t.run_id = r.id AND t.is_error = 1) AS tool_err,
      SUM(${CALL_COST}) AS cost, COUNT(k.message_id) AS calls, SUM(k.ctx_tokens) AS ctx_sum,
      rpf.prompt_uuid AS prompt_uuid, p.text AS prompt_text
    FROM runs r JOIN calls k ON k.run_id = r.id LEFT JOIN rpf ON rpf.run_id = r.id
      LEFT JOIN prompts p ON p.uuid = rpf.prompt_uuid
    ${scope}
    GROUP BY r.id ORDER BY start, r.id`, ...(activeSince ? [activeSince] : []));
  const prior = new Map<string, number[]>();
  return rows.map((x): RunInfo => {
    let flagged = false;
    if (x.agent_type !== 'main') {
      const costs = prior.get(x.agent_type) ?? [];
      flagged = costs.length >= FLAG_MIN_PRIOR && x.cost > FLAG_MULTIPLE * median(costs);
      costs.push(x.cost);
      prior.set(x.agent_type, costs);
    }
    const end = [x.last_call, x.last_tool].filter(Boolean).sort().pop() as string;
    return {
      id: x.id, agentType: x.agent_type, description: x.description, start: x.start,
      durationMs: Math.max(0, Date.parse(end) - Date.parse(x.start)), cost: x.cost, calls: x.calls,
      promptUuid: x.prompt_uuid, promptText: x.prompt_text, flagged, sessionId: x.session_id,
      ctxSum: x.ctx_sum, toolCalls: x.tool_n, toolErrors: x.tool_err,
    };
  });
}

const toRunRow = ({ sessionId, ctxSum, toolCalls, toolErrors, ...run }: RunInfo): RunRow => run;

// ---- sessions ----

function sessionRows(db: Db, from: string, to: string, id?: string): SessionSummary[] {
  const idSql = id ? 'AND s.id = ?' : '';
  const params = id ? [from, to, id] : [from, to];
  const rows = all(db, `${WITH_CALLS}
    SELECT s.id, s.title, s.project, s.first_ts, s.last_ts, SUM(${CALL_COST}) AS cost,
      SUM(CASE WHEN k.is_main THEN 0 ELSE ${CALL_COST} END) AS agent_cost, COUNT(*) AS calls,
      MAX(CASE WHEN k.is_main THEN k.ctx_tokens ELSE 0 END) AS peak,
      GROUP_CONCAT(DISTINCT k.model) AS models
    FROM sessions s JOIN calls k ON k.session_id = s.id WHERE k.ts >= ? AND k.ts < ? ${idSql}
    GROUP BY s.id ORDER BY s.first_ts DESC`, ...params);
  const startCtx = new Map<string, number>();
  const ids = rows.map((s) => s.id as string);
  const firstCalls = ids.length === 0 ? [] : all(db, `${WITH_CALLS} SELECT session_id, ctx_tokens FROM calls
    WHERE is_main AND session_id IN (${ids.map(() => '?').join(',')}) ORDER BY ts`, ...ids);
  for (const c of firstCalls) {
    if (!startCtx.has(c.session_id)) startCtx.set(c.session_id, c.ctx_tokens);
  }
  const compactions = new Map<string, number>();
  for (const c of all(db, `SELECT session_id, COUNT(*) AS n FROM compactions WHERE ts >= ? AND ts < ?
    GROUP BY session_id`, from, to)) compactions.set(c.session_id, c.n);
  return rows.map((s) => ({
    id: s.id, title: s.title, project: s.project, start: s.first_ts,
    durationMin: Math.round((Date.parse(s.last_ts) - Date.parse(s.first_ts)) / 60000),
    calls: s.calls, cost: s.cost, agentCost: s.agent_cost, peakCtx: s.peak, startCtx: startCtx.get(s.id) ?? 0,
    compactions: compactions.get(s.id) ?? 0, models: String(s.models ?? '').split(',').filter(Boolean).sort(),
  }));
}

export function sessions(db: Db, r: Range, now?: Date): SessionSummary[] {
  const rg = resolveRange(r, now);
  return sessionRows(db, rg.from, rg.to);
}

export function sessionDetail(db: Db, id: string) {
  const session = sessionRows(db, '', '￿', id)[0] ?? null;
  const ps = promptRows(db, all(db, 'SELECT * FROM prompts WHERE session_id = ? ORDER BY ts', id));
  const runs = allRuns(db).filter((x) => x.sessionId === id).map(toRunRow);
  const ctxSeries = all(db, `${WITH_CALLS} SELECT ts, ctx_tokens AS ctx FROM calls WHERE is_main AND session_id = ?
    ORDER BY ts`, id).map((c) => ({ ts: c.ts as string, ctx: c.ctx as number }));
  return { session, prompts: ps, runs, ctxSeries };
}

// ---- prompts ----

/** Prompt cost and call count (main thread vs launched agents), for every prompt. */
function promptTotals(db: Db): Map<string, { main: number; agent: number; calls: number }> {
  const m = new Map<string, { main: number; agent: number; calls: number }>();
  for (const x of all(db, `${WITH_CALLS} SELECT eff_prompt AS u,
      SUM(CASE WHEN is_main THEN ${CALL_COST} ELSE 0 END) AS main,
      SUM(CASE WHEN is_main THEN 0 ELSE ${CALL_COST} END) AS agent, COUNT(*) AS calls
    FROM calls WHERE eff_prompt IS NOT NULL GROUP BY eff_prompt`)) {
    m.set(x.u, { main: x.main, agent: x.agent, calls: x.calls });
  }
  return m;
}

/** Builds PromptRows for raw prompt rows. The median is taken over `base` (default: the rows themselves). */
function promptRows(db: Db, rows: Row[], base: Row[] = rows): PromptRow[] {
  const totals = promptTotals(db);
  const t = (u: string): number => { const x = totals.get(u); return x ? x.main + x.agent : 0; };
  const med = median(base.map((p) => t(p.uuid)).filter((v) => v > 0));
  const titles = new Map(all(db, 'SELECT id, title FROM sessions').map((s) => [s.id as string, s.title as string | null]));
  return rows.map((p) => {
    const x = totals.get(p.uuid) ?? { main: 0, agent: 0, calls: 0 };
    const total = x.main + x.agent;
    return {
      uuid: p.uuid, sessionId: p.session_id, sessionTitle: titles.get(p.session_id) ?? null, ts: p.ts, text: p.text,
      cost: x.main, agentCost: x.agent, total, calls: x.calls, durationMs: p.duration_ms,
      multipleOfMedian: med > 0 ? total / med : null,
    };
  });
}

export function prompts(db: Db, r: Range, q?: string, now?: Date): PromptRow[] {
  const rg = resolveRange(r, now);
  const inRange = all(db, 'SELECT * FROM prompts WHERE ts >= ? AND ts < ? ORDER BY ts DESC', rg.from, rg.to);
  const needle = q?.trim().toLowerCase();
  const shown = needle ? inRange.filter((p) => String(p.text).toLowerCase().includes(needle)) : inRange;
  return promptRows(db, shown, inRange);
}

export function promptDetail(db: Db, uuid: string) {
  const p = all(db, 'SELECT * FROM prompts WHERE uuid = ?', uuid)[0];
  if (!p) return null;
  const prompt = promptRows(db, [p], all(db, 'SELECT * FROM prompts'))[0];
  const calls = all(db, `${WITH_CALLS} SELECT run_id, agent_type, is_main, input, cache_write_5m, cache_write_1h,
    cache_read, output, thinking, cost, cost_parts_json, adv FROM calls WHERE eff_prompt = ?`, uuid);
  const tok: Record<string, number> = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, thinking: 0,
    advisor: 0 };
  const cost: Record<string, number> = { ...tok };
  const byLabel = new Map<string, number>();
  const byRun = new Map<string, { cost: number; calls: number }>();
  for (const c of calls) {
    for (const k of PART_KEYS) tok[k] += c[COL[k]];
    const parts = parseParts(c.cost_parts_json);
    for (const k of PART_KEYS) cost[k] += parts[k] ?? 0;
    const callCost = (c.cost ?? 0) + c.adv;
    const label = c.is_main ? 'Main thread' : c.agent_type;
    byLabel.set(label, (byLabel.get(label) ?? 0) + callCost);
    const br = byRun.get(c.run_id) ?? { cost: 0, calls: 0 };
    br.cost += callCost;
    br.calls++;
    byRun.set(c.run_id, br);
  }
  for (const a of all(db, `${WITH_CALLS} SELECT a.tokens_json, a.cost FROM advisor_calls a
    JOIN calls k ON k.message_id = a.message_id WHERE k.eff_prompt = ?`, uuid)) {
    tok.advisor += sumTokens(advisorTokens(a.tokens_json));
    cost.advisor += a.cost ?? 0;
  }
  const tools = all(db, `${WITH_CALLS} SELECT t.label, COUNT(*) AS calls, SUM(t.is_error) AS failed, SUM(t.denied) AS denied
    FROM tool_calls t LEFT JOIN rpf ON rpf.run_id = t.run_id WHERE COALESCE(t.prompt_uuid, rpf.prompt_uuid) = ?
    GROUP BY t.label ORDER BY calls DESC, t.label`, uuid);
  const advisorCalls = all(db, `${WITH_CALLS} SELECT COUNT(*) AS n FROM advisor_calls a
    JOIN calls k ON k.message_id = a.message_id WHERE k.eff_prompt = ?`, uuid)[0].n as number;
  const runs = allRuns(db).filter((x) => byRun.has(x.id)).map((x) => ({
    ...toRunRow(x), cost: byRun.get(x.id)!.cost, calls: byRun.get(x.id)!.calls,
    promptUuid: uuid, promptText: p.text as string,
  }));
  const keys = [...PART_KEYS, 'advisor'] as const;
  return {
    prompt,
    summary: {
      cost: prompt.cost, agentCost: prompt.agentCost, durationMs: prompt.durationMs, tokens: sumTokens(tok),
      cacheReadPct: cacheHit(tok.cacheRead, tok.cacheWrite5m, tok.cacheWrite1h, tok.input),
      apiCalls: calls.length, advisorCalls, toolCalls: tools.reduce((a, t) => a + t.calls, 0),
      failed: tools.reduce((a, t) => a + (t.failed ?? 0), 0), denied: tools.reduce((a, t) => a + (t.denied ?? 0), 0),
    },
    parts: keys.map((key) => ({ key, tokens: tok[key], cost: cost[key] })),
    byPart: [...byLabel.entries()].map(([label, c]) => ({ label, cost: c })).sort((a, b) => b.cost - a.cost),
    runs,
    tools: tools.map((t) => ({ label: t.label as string, calls: t.calls as number, failed: (t.failed ?? 0) as number })),
  };
}

// ---- agents ----

export function agents(db: Db, r: Range, now?: Date): AgentStats[] {
  const rg = resolveRange(r, now);
  // Cost, calls and context come from calls inside the range, so a long-lived main thread only counts
  // what was spent in it and the rows reconcile with overview(). Flags, durations and errors go by run start.
  const agg = all(db, `${WITH_CALLS} SELECT agent_type, COUNT(DISTINCT run_id) AS runs, COUNT(*) AS calls,
      SUM(${CALL_COST}) AS cost, SUM(ctx_tokens) AS ctx_sum FROM calls WHERE ts >= ? AND ts < ? GROUP BY agent_type`,
  rg.from, rg.to);
  const started = allRuns(db).filter((x) => x.start >= rg.from && x.start < rg.to);
  const grandTotal = agg.reduce((a, x) => a + x.cost, 0);
  return agg.map((x): AgentStats => {
    const xs = started.filter((run) => run.agentType === x.agent_type);
    const toolN = xs.reduce((a, run) => a + run.toolCalls, 0);
    return {
      type: x.agent_type, kind: agentKind(x.agent_type), runs: x.runs, calls: x.calls, cost: x.cost,
      pct: pct(x.cost, grandTotal), perRun: x.cost / x.runs, avgCtx: Math.round(x.ctx_sum / x.calls),
      avgDurationMs: xs.length ? xs.reduce((a, run) => a + run.durationMs, 0) / xs.length : 0,
      errorRate: pct(xs.reduce((a, run) => a + run.toolErrors, 0), toolN),
      sparkline: xs.slice(-SPARK_RUNS).map((run) => run.cost), flaggedRuns: xs.filter((run) => run.flagged).length,
    };
  }).sort((a, b) => b.cost - a.cost);
}

export function agentDetail(db: Db, type: string, r: Range, now?: Date) {
  const rg = resolveRange(r, now);
  const runs = allRuns(db).filter((x) => x.agentType === type && x.start >= rg.from && x.start < rg.to);
  return {
    stats: agents(db, r, now).find((a) => a.type === type) ?? null,
    runs: runs.map(toRunRow),
    medianCost: median(runs.map((x) => x.cost)),
  };
}

// ---- coverage and status line ----

/** installed.json in the data home records the install time; unreadable or absent means unknown. */
function installedAt(): string | null {
  try {
    const f = stateFile('installed.json');
    if (!existsSync(f)) return null;
    const v = (JSON.parse(readFileSync(f, 'utf8')) as { installedAt?: unknown }).installedAt;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

/**
 * Index coverage. `sessionsPartial` = sessions with at least one transcript file that disappeared after it was
 * indexed (their rows are kept, the history may be incomplete). `filesMissingBeforeIndexed` = transcript files that
 * disappeared after being seen; their rows are kept.
 */
export function coverage(db: Db) {
  const n = (sql: string): number => all(db, sql)[0].n as number;
  const sessionsPartial = n(`SELECT COUNT(DISTINCT session_id) AS n FROM files WHERE missing = 1 AND session_id IS NOT NULL`);
  let progress: unknown = null;
  try { progress = JSON.parse(db.meta.get('backfill_progress') ?? 'null'); } catch { /* unreadable: treat as none */ }
  const started = (progress as { startedAt?: string } | null)?.startedAt ?? null;
  return {
    installedAt: installedAt() ?? started,
    sessionsComplete: n('SELECT COUNT(*) AS n FROM sessions') - sessionsPartial,
    sessionsPartial,
    filesMissingBeforeIndexed: n('SELECT COUNT(*) AS n FROM files WHERE missing = 1'),
    backfillProgress: progress,
  };
}

export function statusLine(db: Db, sessionId: string, now?: Date) {
  const rg = resolveRange({ preset: 'today' }, now);
  const today = all(db, `${WITH_CALLS} SELECT COALESCE(SUM(${CALL_COST}), 0) AS c FROM calls WHERE ts >= ? AND ts < ?`,
    rg.from, rg.to)[0].c as number;
  const session = all(db, `${WITH_CALLS} SELECT COALESCE(SUM(${CALL_COST}), 0) AS c FROM calls WHERE session_id = ?`,
    sessionId)[0].c as number;
  const alerts = allRuns(db, rg.from).filter((x) => x.flagged && x.start >= rg.from && x.start < rg.to).length;
  return { today, session, alerts };
}
