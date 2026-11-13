#!/usr/bin/env node
// Dev-only: extracts a small, anonymised fixture corpus from real Claude Code transcripts.
//
//   node scripts/make-fixtures.mjs <transcriptsDir> <outDir>
//
// Anonymisation rules (the corpus is committed to a public repo):
//  - every free-text or identifying string becomes "lorem ipsum " filler of the same length
//    (capped at MAX_TEXT chars, except tool_result bodies whose length the parser measures);
//  - paths become /repo/file<N>, cwd becomes /repo, branch becomes main;
//  - ids (uuid, sessionId, message.id, requestId, tool_use ids, agent ids) become stable fakes that
//    keep which records share an id;
//  - skill, agent and slash-command names that are not built-in/generic become custom-*-<N>;
//  - kept verbatim: record structure and keys, type/subtype, model names, token counts, usage objects,
//    timestamps, effort, built-in tool names.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error('usage: make-fixtures.mjs <transcriptsDir> <outDir>');
  process.exit(2);
}

const MAX_TEXT = 2000;
const RESULT_MAX = 3000;

// ---------------------------------------------------------------- anonymiser

const idMap = new Map();
let idCounter = 0;
function fakeId(real) {
  if (typeof real !== 'string' || real === '') return real;
  let f = idMap.get(real);
  if (f) return f;
  const n = String(++idCounter);
  const m = /^([a-z]+_)(.*)$/.exec(real);
  if (m) f = m[1] + 'F'.repeat(Math.max(0, real.length - m[1].length - n.length)) + n;
  else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(real)) {
    f = '00000000-0000-4000-8000-' + n.padStart(12, '0');
  } else if (/^a[0-9a-f]{16}$/.test(real)) f = 'a' + n.padStart(16, '0');
  else f = 'id-' + n;
  idMap.set(real, f);
  return f;
}

const pathMap = new Map();
function fakePath(real) {
  if (typeof real !== 'string' || real === '') return real;
  if (!pathMap.has(real)) pathMap.set(real, '/repo/file' + (pathMap.size + 1));
  return pathMap.get(real);
}

const MARKERS = ['<local-command', '<system-reminder>', '<task-notification', 'Caveat:'];
function lorem(s, cap = MAX_TEXT) {
  if (typeof s !== 'string' || s === '') return s;
  const n = Math.min(s.length, cap);
  const marker = MARKERS.find((m) => s.startsWith(m));
  const body = 'lorem ipsum '.repeat(Math.ceil(n / 12) + 1);
  if (marker && marker.length < n) return marker + body.slice(0, n - marker.length);
  return body.slice(0, n);
}

const SKILLS_OK = new Set(['update-config', 'simplify', 'loop', 'schedule', 'init', 'security-review', 'claude-api',
  'run', 'fewer-permission-prompts', 'keybindings-help', 'code-review']);
const AGENTS_OK = new Set(['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'claude-code-guide', 'fork',
  'code-simplifier:code-simplifier']);
const COMMANDS_OK = new Set(['clear', 'compact', 'model', 'context', 'help', 'config', 'resume', 'init', 'cost']);
const TOOLS_OK = new Set(['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'PowerShell', 'Skill', 'Agent', 'Task',
  'ToolSearch', 'WebFetch', 'WebSearch', 'Monitor', 'TaskStop', 'SendMessage', 'AskUserQuestion', 'NotebookEdit']);
const customMaps = { skill: new Map(), agent: new Map(), command: new Map() };
function mapName(kind, name, ok) {
  if (typeof name !== 'string' || name === '') return name;
  if (ok.has(name) || (kind === 'skill' && name.startsWith('superpowers:'))) return name;
  const m = customMaps[kind];
  if (!m.has(name)) m.set(name, `custom-${kind}-${m.size + 1}`);
  return m.get(name);
}
const mapSkill = (s) => mapName('skill', s, SKILLS_OK);
const mapAgent = (s) => mapName('agent', s, AGENTS_OK);
function mapTool(name) {
  if (typeof name !== 'string') return name;
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return 'mcp__claude_ai_Example__' + (parts.slice(2).join('__') ? 'lookup' : 'tool');
  }
  return TOOLS_OK.has(name) ? name : 'CustomTool';
}

const KEEP_KEYS = new Set(['type', 'subtype', 'role', 'model', 'effort', 'perTurnEffort', 'speed', 'service_tier',
  'stop_reason', 'timestamp', 'version', 'trigger', 'level', 'decision', 'source', 'reasonType', 'reasonCode',
  'classifierCategory', 'entrypoint', 'userType', 'inference_geo', 'promptCacheRequested', 'thinkingDisplay',
  'advisorModel', 'requestedModel', 'media_type', 'toolDenialKind', 'operation', 'mode', 'permissionMode',
  'stopReason']);
const ID_KEYS = new Set(['uuid', 'parentUuid', 'logicalParentUuid', 'sessionId', 'session_id', 'id', 'requestId',
  'requestRef', 'serverClassifierRequest', 'tool_use_id', 'toolUseID', 'toolUseId', 'agentId', 'promptId',
  'sourceToolAssistantUUID', 'messageId', 'leafUuid', 'interruptedMessageId']);
const PATH_KEYS = new Set(['file_path', 'path', 'notebook_path', 'filePath']);
const DROP_KEYS = new Set(['serverClassifierContext', 'preservedSegment', 'preservedMessages',
  'preCompactDiscoveredTools', 'preCompactArtifactReadVersions']);

// ctx: { shrink: bool (tool-use result blobs), keepLen: bool (tool_result bodies) }
function anon(v, key, ctx, parent) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) {
    const arr = ctx.shrink ? v.slice(0, 3) : v;
    return arr.map((x) => anon(x, key, ctx, parent));
  }
  if (typeof v === 'object') {
    const out = {};
    const isToolUse = v.type === 'tool_use';
    const isToolResult = v.type === 'tool_result';
    for (const [k, x] of Object.entries(v)) {
      if (DROP_KEYS.has(k)) continue;
      if (k === 'toolUseResult') { out[k] = anon(x, k, { ...ctx, shrink: true }, v); continue; }
      if (isToolResult && k === 'content') { out[k] = anon(x, k, { ...ctx, keepLen: true }, v); continue; }
      if (isToolUse && k === 'name') { out[k] = mapTool(x); continue; }
      if (isToolUse && k === 'input') { out[k] = anon(x, k, { ...ctx, input: v.name }, v); continue; }
      if (k === 'attributionAgent' || k === 'agentType') { out[k] = mapAgent(x); continue; }
      out[k] = anon(x, k, ctx, v);
    }
    return out;
  }
  // strings
  const s = v;
  if (ID_KEYS.has(key)) return fakeId(s);
  if (key === 'cwd' || key === 'live_cwd') return '/repo';
  if (key === 'gitBranch') return 'main';
  if (PATH_KEYS.has(key)) return fakePath(s);
  if (ctx.input && key === 'skill') return mapSkill(s);
  if (ctx.input && key === 'subagent_type') return mapAgent(s);
  if (key === 'permissionDecision' && s.length < 20) return s;
  if (key === 'data' && parent && parent.type === 'base64') return 'AAAA';
  if (key === 'base64') return 'AAAA';
  if (key === 'signature') return lorem(s, 24);
  if (KEEP_KEYS.has(key) && s.length < 60) return s;
  if (s.includes('<command-name>')) return anonSlash(s);
  if (ctx.shrink) return lorem(s, 40);
  if (ctx.keepLen) return lorem(s, RESULT_MAX);
  return lorem(s);
}

function anonSlash(s) {
  const m = /<command-name>\/?([^<]*)<\/command-name>/.exec(s);
  const name = mapName('command', m ? m[1] : 'x', COMMANDS_OK);
  return `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args></command-args>`;
}

// ---------------------------------------------------------------- scanning

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const allFiles = walk(srcDir)
  .filter((f) => !f.includes('remember-summarizer') && statSync(f).size < 20e6)
  .map((f) => ({ f, size: statSync(f).size }))
  .sort((a, b) => a.size - b.size || (a.f < b.f ? -1 : 1))
  .map((x) => x.f);

function load(file) {
  const recs = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { recs.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return recs;
}

/** Runs recipe(recs, file) over transcripts, smallest first, until it returns a record list. */
function find(recipe, { mainOnly = false } = {}) {
  for (const f of allFiles) {
    if (mainOnly && f.includes(`${'subagents'}`)) continue;
    const recs = load(f);
    const r = recipe(recs, f);
    if (r) return { recs: r, file: f };
  }
  throw new Error('no match for recipe ' + recipe.name);
}

const content = (o) => (Array.isArray(o.message?.content) ? o.message.content : []);
const toolUses = (o) => content(o).filter((b) => b.type === 'tool_use');
const resultFor = (recs, id) => recs.find((o) => o.type === 'user'
  && content(o).some((b) => b.type === 'tool_result' && b.tool_use_id === id));
const resultLen = (o) => {
  const b = content(o).find((x) => x.type === 'tool_result');
  const c = b?.content;
  return typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
};
const smallResult = (o) => !!o && resultLen(o) < RESULT_MAX && !JSON.stringify(o).includes('"image"');
const isPrompt = (o) => o.type === 'user' && !o.isMeta && !o.isCompactSummary && typeof o.message?.content === 'string'
  && o.message.content.length > 20 && o.message.content.length < 400
  && !MARKERS.some((m) => o.message.content.startsWith(m)) && !o.message.content.includes('<command-name>');
const real = (o) => o.type === 'assistant' && o.message?.model && o.message.model !== '<synthetic>';

// ---------------------------------------------------------------- recipes

const out = {}; // fixture name -> record[]
const add = (name, recs) => { (out[name] ??= []).push(...recs); };

// 1. split response: three lines sharing one message.id, thinking tokens, 1h cache, a tool call, its result.
add('split-response.jsonl', find(function splitResponse(recs) {
  const byId = new Map();
  for (const o of recs) if (real(o)) byId.set(o.message.id, [...(byId.get(o.message.id) ?? []), o]);
  for (const group of byId.values()) {
    if (group.length !== 3) continue;
    const u = group[0].message.usage;
    const tu = group.flatMap(toolUses)[0];
    if (!tu || !(u.output_tokens_details?.thinking_tokens > 0) || !(u.cache_creation?.ephemeral_1h_input_tokens > 0)) continue;
    if (!group.some((g) => content(g).some((b) => b.type === 'thinking'))) continue;
    const res = resultFor(recs, tu.id);
    if (!smallResult(res)) continue;
    const prompt = [...recs.slice(0, recs.indexOf(group[0]))].reverse().find(isPrompt);
    if (!prompt) continue;
    return [prompt, ...group, res];
  }
  return null;
}).recs);

// 2. advisor iteration
add('advisor.jsonl', find(function advisor(recs) {
  const o = recs.find((x) => real(x) && x.message.usage?.iterations?.some((i) => i.type === 'advisor_message')
    && toolUses(x).length === 0);
  return o ? [o] : null;
}).recs);

// 3. Skill tool_use + result, and slash commands
add('skill-slash.jsonl', find(function skill(recs) {
  const o = recs.find((x) => real(x) && toolUses(x).some((t) => t.name === 'Skill'));
  if (!o) return null;
  const res = resultFor(recs, toolUses(o).find((t) => t.name === 'Skill').id);
  return smallResult(res) ? [o, res] : null;
}).recs);
add('skill-slash.jsonl', find(function slashBuiltin(recs) {
  const o = recs.find((x) => x.type === 'user' && typeof x.message?.content === 'string'
    && /<command-name>\/(clear|compact|model|context)<\/command-name>/.test(x.message.content));
  return o ? [o] : null;
}).recs);
add('skill-slash.jsonl', find(function slashCustom(recs) {
  const o = recs.find((x) => x.type === 'user' && typeof x.message?.content === 'string'
    && x.message.content.includes('<command-name>/') && !x.isMeta
    && !/<command-name>\/(clear|compact|model|context|help|config|resume|init|cost)</.test(x.message.content));
  return o ? [o] : null;
}).recs);

// 4. Agent tool_use with a subagent transcript + meta
let agentFixture = null;
{
  const cands = [];
  for (const f of allFiles) {
    if (f.includes('subagents')) continue;
    const sub = join(dirname(f), basename(f, '.jsonl'), 'subagents');
    if (!existsSync(sub)) continue;
    for (const e of readdirSync(sub)) if (e.endsWith('.meta.json')) cands.push({ f, sub, meta: join(sub, e) });
  }
  cands.sort((a, b) => statSync(a.meta.replace('.meta.json', '.jsonl')).size
    - statSync(b.meta.replace('.meta.json', '.jsonl')).size);
  for (const c of cands) {
    const subFile = c.meta.replace('.meta.json', '.jsonl');
    let meta; try { meta = JSON.parse(readFileSync(c.meta, 'utf8')); } catch { continue; }
    if (!meta.toolUseId) continue;
    const recs = load(c.f);
    const asst = recs.find((o) => real(o) && toolUses(o).some((t) => t.id === meta.toolUseId && t.name === 'Agent'));
    if (!asst) continue;
    const subRecs = load(subFile);
    if (!subRecs.some(real)) continue;
    agentFixture = { asst, subRecs, meta, subName: basename(subFile) };
    break;
  }
  if (!agentFixture) throw new Error('no agent+subagent fixture found');
}
add('agent.jsonl', [agentFixture.asst]);

// 5. MCP tool_use
add('mcp.jsonl', find(function mcp(recs) {
  const o = recs.find((x) => real(x) && toolUses(x).some((t) => t.name.startsWith('mcp__')));
  return o ? [o] : null;
}).recs);

// 6. tool results: error, image, array content, denied
add('tool-results.jsonl', find(function errResult(recs) {
  const o = recs.find((x) => x.type === 'user' && !x.toolDenialKind
    && content(x).some((b) => b.type === 'tool_result' && b.is_error) && smallResult(x));
  return o ? [o] : null;
}).recs);
add('tool-results.jsonl', find(function imageResult(recs) {
  const o = recs.find((x) => x.type === 'user'
    && content(x).some((b) => b.type === 'tool_result' && Array.isArray(b.content)
      && b.content.length === 1 && b.content[0].type === 'image'));
  return o ? [o] : null;
}).recs);
add('tool-results.jsonl', find(function arrayText(recs) {
  const o = recs.find((x) => x.type === 'user'
    && content(x).some((b) => b.type === 'tool_result' && Array.isArray(b.content)
      && b.content.length > 0 && b.content.every((c) => c.type === 'text')) && smallResult(x));
  return o ? [o] : null;
}).recs);
add('tool-results.jsonl', find(function denied(recs) {
  const o = recs.find((x) => x.type === 'user' && x.toolDenialKind && smallResult(x));
  return o ? [o] : null;
}).recs);
add('tool-results.jsonl', find(function permitted(recs) {
  const o = recs.find((x) => x.type === 'user' && !x.toolDenialKind && x.permissionDecision
    && typeof x.permissionDecision === 'object' && smallResult(x));
  return o ? [o] : null;
}).recs);

// 7. system and bookkeeping records
const pickOne = (name, pred, file = 'system.jsonl', maxLen = 4000) => add(file, find(function pick(recs) {
  const o = recs.find((x) => pred(x) && JSON.stringify(x).length < maxLen);
  return o ? [o] : null;
}).recs);
pickOne('turn', (o) => o.subtype === 'turn_duration');
pickOne('compact', (o) => o.subtype === 'compact_boundary');
pickOne('hook', (o) => o.subtype === 'stop_hook_summary' && o.hookInfos?.length > 0);
pickOne('title', (o) => o.type === 'ai-title');
pickOne('local_command', (o) => o.subtype === 'local_command');
pickOne('queue', (o) => o.type === 'queue-operation');
pickOne('attachment', (o) => o.type === 'attachment');
pickOne('cost', (o) => o.type === 'cost-state');
pickOne('synthetic', (o) => o.type === 'assistant' && o.message?.model === '<synthetic>');

// 8. prompts that are not prompts
pickOne('meta', (o) => o.type === 'user' && o.isMeta && typeof o.message?.content === 'string', 'non-prompts.jsonl');
pickOne('local-cmd', (o) => o.type === 'user' && typeof o.message?.content === 'string'
  && o.message.content.startsWith('<local-command'), 'non-prompts.jsonl');
pickOne('compact-summary', (o) => o.type === 'user' && o.isCompactSummary, 'non-prompts.jsonl', 1e6);
pickOne('prompt-blocks', (o) => o.type === 'user' && !o.isMeta && Array.isArray(o.message?.content)
  && o.message.content.some((b) => b.type === 'text') && !o.message.content.some((b) => b.type === 'tool_result'),
'non-prompts.jsonl');

// ---------------------------------------------------------------- output

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'subagents'), { recursive: true });
const ctx0 = {};
for (const [name, recs] of Object.entries(out)) {
  const lines = recs.map((o) => JSON.stringify(anon(o, '', ctx0)));
  if (name === 'system.jsonl') {
    lines.push('{"type":"future-record-type","uuid":"00000000-0000-4000-8000-000000000000","note":"unknown"}');
    // Malformed line: an anonymised assistant record cut off mid-write.
    const asst = JSON.stringify(anon(out['split-response.jsonl'][1], '', ctx0));
    lines.push(asst.slice(0, Math.floor(asst.length / 2)));
  }
  writeFileSync(join(outDir, name), lines.join('\n') + '\n');
}
const subRecs = agentFixture.subRecs.slice(0, 40);
const subName = 'agent-' + fakeId(agentFixture.subName.replace(/^agent-|\.jsonl$/g, '')) + '.jsonl';
writeFileSync(join(outDir, 'subagents', subName), subRecs.map((o) => JSON.stringify(anon(o, '', ctx0))).join('\n') + '\n');
writeFileSync(join(outDir, 'subagents', subName.replace('.jsonl', '.meta.json')), JSON.stringify({
  agentType: mapAgent(agentFixture.meta.agentType),
  description: lorem(agentFixture.meta.description ?? ''),
  toolUseId: fakeId(agentFixture.meta.toolUseId),
  spawnDepth: agentFixture.meta.spawnDepth ?? 1,
}, null, 2) + '\n');
console.log('fixtures written to', outDir);
