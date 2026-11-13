import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLine, parseSubagentMeta, toolLabel } from '../../src/ingest/parse';
import type { ParsedLine } from '../../src/core/types';

const FX = join(__dirname, '..', 'fixtures');
const lines = (name: string): string[] => readFileSync(join(FX, name), 'utf8').split('\n').filter(Boolean);
const parsed = (name: string): ParsedLine[][] => lines(name).map((l) => parseLine(l));
const flat = (name: string): ParsedLine[] => parsed(name).flat();
type Kind<K extends ParsedLine['kind']> = Extract<ParsedLine, { kind: K }>;
const ofKind = <K extends ParsedLine['kind']>(all: ParsedLine[], k: K): Kind<K>[] =>
  all.filter((p): p is Kind<K> => p.kind === k);
const json = (l: string): any => JSON.parse(l);

describe('parseLine: assistant responses', () => {
  it('split response yields api_part per line with same messageId', () => {
    const all = parsed('split-response.jsonl');
    const parts = all.flat().filter((p): p is Kind<'api_part'> => p.kind === 'api_part');
    expect(parts).toHaveLength(3);
    expect(new Set(parts.map((p) => p.messageId)).size).toBe(1);
    expect(parts[0].messageId).toBe(json(lines('split-response.jsonl')[1]).message.id);
    // every line carries the same usage; the store dedupes by message id
    expect(parts[1].tokens).toEqual(parts[0].tokens);
    expect(parts[2].tokens).toEqual(parts[0].tokens);
    // each part holds only its own line's tool_use blocks
    const expectedTools = lines('split-response.jsonl').slice(1, 4)
      .map((l) => json(l).message.content.filter((b: any) => b.type === 'tool_use').length);
    expect(parts.map((p) => p.toolUses.length)).toEqual(expectedTools);
    expect(expectedTools.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('api_part carries session, model, effort, cwd, branch, version and the raw line', () => {
    const l = lines('split-response.jsonl')[1];
    const j = json(l);
    const p = ofKind(parseLine(l), 'api_part')[0];
    expect(p.sessionId).toBe(j.sessionId);
    expect(p.model).toBe(j.message.model);
    expect(p.effort).toBe(j.effort ?? null);
    expect(p.ts).toBe(j.timestamp);
    expect(p.cwd).toBe('/repo');
    expect(p.gitBranch).toBe('main');
    expect(p.ccVersion).toBe(j.version);
    expect(p.speed).toBe('standard');
    expect(p.raw).toBe(l);
  });

  it('thinking tokens split out of output', () => {
    const l = lines('split-response.jsonl')[1];
    const u = json(l).message.usage;
    const p = ofKind(parseLine(l), 'api_part')[0];
    expect(u.output_tokens_details.thinking_tokens).toBeGreaterThan(0);
    expect(p.tokens.thinking).toBe(u.output_tokens_details.thinking_tokens);
    expect(p.tokens.output).toBe(u.output_tokens - u.output_tokens_details.thinking_tokens);
    expect(p.tokens.input).toBe(u.input_tokens);
    expect(p.tokens.cacheRead).toBe(u.cache_read_input_tokens);
    expect(p.tokens.cacheWrite1h).toBe(u.cache_creation.ephemeral_1h_input_tokens);
    expect(p.tokens.cacheWrite5m).toBe(u.cache_creation.ephemeral_5m_input_tokens);
  });

  const mk = (usage: object, extra: object = {}): string => JSON.stringify({
    type: 'assistant', uuid: 'u1', sessionId: 's1', timestamp: '2026-01-01T00:00:00.000Z',
    message: { id: 'msg_1', model: 'claude-opus-5-5', role: 'assistant', content: [], usage }, ...extra,
  });

  it('missing thinking details means zero thinking; cache total falls back to 5m', () => {
    const p = ofKind(parseLine(mk({ input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 700,
      cache_read_input_tokens: 9 })), 'api_part')[0];
    expect(p.tokens).toEqual({ input: 5, cacheWrite5m: 700, cacheWrite1h: 0, cacheRead: 9, output: 40, thinking: 0 });
    expect(p.effort).toBeNull();
    expect(p.thinkingMs).toBeNull();
  });

  it('reads speed, effort and thinking duration', () => {
    const p = ofKind(parseLine(mk({ input_tokens: 1, output_tokens: 1, speed: 'fast' },
      { effort: 'high', thinkingDurationMs: 1234 })), 'api_part')[0];
    expect(p.speed).toBe('fast');
    expect(p.effort).toBe('high');
    expect(p.thinkingMs).toBe(1234);
  });

  it('advisor iteration parsed with its own model', () => {
    const l = lines('advisor.jsonl')[0];
    const u = json(l).message.usage;
    const it = u.iterations.find((i: any) => i.type === 'advisor_message');
    const p = ofKind(parseLine(l), 'api_part')[0];
    expect(p.advisor).toHaveLength(1);
    expect(p.advisor[0].model).toBe(it.model);
    expect(p.advisor[0].tokens).toEqual({
      input: it.input_tokens,
      cacheWrite5m: it.cache_creation.ephemeral_5m_input_tokens,
      cacheWrite1h: it.cache_creation.ephemeral_1h_input_tokens,
      cacheRead: it.cache_read_input_tokens,
      output: it.output_tokens,
      thinking: 0,
    });
    // top-level usage already excludes the advisor
    expect(p.tokens.input).toBe(u.input_tokens);
  });

  it('non-advisor lines have an empty advisor list', () => {
    for (const p of ofKind(flat('split-response.jsonl'), 'api_part')) expect(p.advisor).toEqual([]);
  });

  it('synthetic model lines ignored', () => {
    const synth = lines('system.jsonl').find((l) => l.includes('<synthetic>'))!;
    expect(parseLine(synth)).toEqual([{ kind: 'ignored' }]);
  });
});

describe('parseLine: tool_use blocks', () => {
  const toolUseOf = (name: string, tool: string) => {
    const part = ofKind(flat(name), 'api_part').find((p) => p.toolUses.some((t) => t.name === tool))!;
    return { part, tu: part.toolUses.find((t) => t.name === tool)! };
  };

  it('Skill tool_use gives skill name', () => {
    const { tu } = toolUseOf('skill-slash.jsonl', 'Skill');
    const skill = json(lines('skill-slash.jsonl')[0]).message.content[0].input.skill;
    expect(tu.skill).toBe(skill);
    expect(tu.label).toBe(`Skill: ${skill}`);
    expect(tu.id).toBe(json(lines('skill-slash.jsonl')[0]).message.content[0].id);
    expect(tu.inputChars).toBe(tu.inputJson.length);
    expect(JSON.parse(tu.inputJson).skill).toBe(skill);
  });

  it('Agent tool_use label is "Agent: <subagent_type>"', () => {
    const { tu } = toolUseOf('agent.jsonl', 'Agent');
    const t = json(lines('agent.jsonl')[0]).message.content.find((b: any) => b.type === 'tool_use');
    expect(tu.label).toBe(`Agent: ${t.input.subagent_type}`);
    expect(tu.skill).toBeNull();
  });

  it('mcp tool label is "MCP <server>: <tool>"', () => {
    const { tu } = toolUseOf('mcp.jsonl', 'mcp__claude_ai_Example__lookup');
    expect(tu.label).toBe('MCP Example: lookup');
    expect(tu.skill).toBeNull();
  });
});

describe('toolLabel', () => {
  it('maps tool names to labels', () => {
    expect(toolLabel('Skill', { skill: 'simplify' })).toEqual({ label: 'Skill: simplify', skill: 'simplify' });
    expect(toolLabel('Agent', { subagent_type: 'Explore' })).toEqual({ label: 'Agent: Explore', skill: null });
    expect(toolLabel('Task', {})).toEqual({ label: 'Agent: general-purpose', skill: null });
    expect(toolLabel('mcp__claude_ai_Notion__search', {}))
      .toEqual({ label: 'MCP Notion: search', skill: null });
    expect(toolLabel('mcp__plugin_context7_context7__query__docs', {}))
      .toEqual({ label: 'MCP plugin_context7_context7: query__docs', skill: null });
    expect(toolLabel('Bash', { command: 'ls' })).toEqual({ label: 'Bash', skill: null });
  });
});

describe('parseLine: user records', () => {
  it('slash command record yields slash_command', () => {
    const ls = lines('skill-slash.jsonl');
    const r = parseLine(ls[2]);
    expect(r).toEqual([{ kind: 'slash_command', ts: json(ls[2]).timestamp, name: 'clear' }]);
    expect(parseLine(ls[3])).toEqual([{ kind: 'slash_command', ts: json(ls[3]).timestamp, name: 'custom-command-1' }]);
  });

  it('prompt containing a command tag mid-text stays a prompt', () => {
    const rec = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: 't',
      message: { role: 'user', content: 'what does <command-name>/x</command-name> mean?' } });
    expect(parseLine(rec)).toMatchObject([{ kind: 'prompt' }]);
  });

  it('output tokens never go negative and ignored results are not shared', () => {
    const rec = JSON.stringify({ type: 'assistant', timestamp: 't', sessionId: 's', message: { id: 'm', model: 'x',
      content: [], usage: { input_tokens: 1, output_tokens: 5, output_tokens_details: { thinking_tokens: 9 } } } });
    expect((parseLine(rec)[0] as any).tokens.output).toBe(0);
    const a = parseLine('nope');
    expect(a).not.toBe(parseLine('nope'));
  });

  it('plain user text is a prompt, with text blocks joined', () => {
    const ls = lines('split-response.jsonl');
    const p = parseLine(ls[0]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ kind: 'prompt', uuid: json(ls[0]).uuid, sessionId: json(ls[0]).sessionId,
      text: json(ls[0]).message.content, raw: ls[0] });
    const blocks = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: 't',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } });
    expect(parseLine(blocks)).toMatchObject([{ kind: 'prompt', text: 'hello\nworld' }]);
  });

  it('meta, local-command, compact-summary and system-reminder users are not prompts', () => {
    for (const r of parsed('non-prompts.jsonl').slice(0, 3)) expect(r).toEqual([{ kind: 'ignored' }]);
    const reminder = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: 't',
      message: { role: 'user', content: '<system-reminder>hi</system-reminder>' } });
    expect(parseLine(reminder)).toEqual([{ kind: 'ignored' }]);
    for (const prefix of ['<task-notification>x', 'Caveat: x', '<local-command-stdout>x']) {
      const l = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: 't',
        message: { role: 'user', content: prefix } });
      expect(parseLine(l)).toEqual([{ kind: 'ignored' }]);
    }
  });

  it('prompt records from sub-agents are not prompts', () => {
    const first = readFileSync(join(FX, 'subagents', readdirSync(join(FX, 'subagents'))
      .find((f) => f.endsWith('.jsonl'))!), 'utf8').split('\n')[0];
    expect(json(first).isSidechain).toBe(true);
    expect(parseLine(first)).toEqual([{ kind: 'ignored' }]);
  });
});

describe('parseLine: tool_result', () => {
  const results = parsed('tool-results.jsonl').map((r) => ofKind(r, 'tool_result'));
  const rawResults = lines('tool-results.jsonl').map(json);

  it('tool_result chars counted, images 6000 chars each', () => {
    // [0] error string
    expect(results[0][0].resultChars).toBe(rawResults[0].message.content[0].content.length);
    // [1] a single image block
    expect(results[1][0].resultChars).toBe(6000);
    // [2] text blocks
    const texts: any[] = rawResults[2].message.content[0].content;
    expect(results[2][0].resultChars).toBe(texts.reduce((n, b) => n + b.text.length, 0));
  });

  it('counts mixed blocks: text length, 6000 per image, JSON length for others', () => {
    const l = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'text', text: 'abcd' }, { type: 'image', source: {} }, { type: 'image', source: {} },
        { type: 'tool_reference', tool_name: 'X' }] }] } });
    const r = ofKind(parseLine(l), 'tool_result')[0];
    expect(r.resultChars).toBe(4 + 12000 + JSON.stringify({ type: 'tool_reference', tool_name: 'X' }).length);
  });

  it('yields one result per tool_result block', () => {
    const l = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: 't', message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' },
        { type: 'tool_result', tool_use_id: 'b', content: 'yy' }] } });
    expect(ofKind(parseLine(l), 'tool_result').map((r) => [r.toolUseId, r.resultChars])).toEqual([['a', 1], ['b', 2]]);
  });

  it('is_error and permission decision recorded', () => {
    expect(results[0][0].isError).toBe(true);
    expect(results[0][0].denied).toBe(false);
    expect(results[0][0].toolUseId).toBe(rawResults[0].message.content[0].tool_use_id);
    expect(results[0][0].permission).toBe(JSON.stringify(rawResults[0].permissionDecision));
    expect(results[1][0].isError).toBe(false);
  });

  it('denied permission flagged, string decisions kept as is', () => {
    expect(results[3][0].denied).toBe(true);
    expect(results[3][0].isError).toBe(true);
    expect(results[3][0].permission).toBeNull();
    const l = JSON.stringify({ type: 'user', uuid: 'u', sessionId: 's', timestamp: 't', permissionDecision: 'allow',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } });
    expect(ofKind(parseLine(l), 'tool_result')[0].permission).toBe('allow');
  });
});

describe('parseLine: system and bookkeeping records', () => {
  const sys = parsed('system.jsonl');

  it('turn_duration', () => {
    expect(sys[0]).toEqual([{ kind: 'turn_duration', ts: json(lines('system.jsonl')[0]).timestamp,
      durationMs: json(lines('system.jsonl')[0]).durationMs }]);
  });

  it('compact_boundary becomes compaction', () => {
    const j = json(lines('system.jsonl')[1]);
    expect(sys[1]).toEqual([{ kind: 'compaction', ts: j.timestamp, preTokens: j.compactMetadata.preTokens,
      durationMs: j.compactMetadata.durationMs, trigger: j.compactMetadata.trigger }]);
  });

  it('stop_hook_summary becomes hook_runs', () => {
    const j = json(lines('system.jsonl')[2]);
    const r = ofKind(sys[2], 'hook_runs')[0];
    expect(r.ts).toBe(j.timestamp);
    expect(r.runs).toEqual(j.hookInfos.map((h: any) => ({ command: h.command, durationMs: h.durationMs ?? 0 })));
  });

  it('ai-title becomes title', () => {
    const j = json(lines('system.jsonl')[3]);
    expect(sys[3]).toEqual([{ kind: 'title', sessionId: j.sessionId, title: j.aiTitle }]);
  });

  it('record types the tracker does not use are ignored', () => {
    // local_command, queue-operation, attachment, cost-state
    for (const i of [4, 5, 6, 7]) expect(sys[i]).toEqual([{ kind: 'ignored' }]);
  });

  it('unknown record type yields ignored', () => {
    expect(parseLine('{"type":"future-record-type","x":1}')).toEqual([{ kind: 'ignored' }]);
    expect(parseLine('{"type":"system","subtype":"brand_new"}')).toEqual([{ kind: 'ignored' }]);
    expect(parseLine('{}')).toEqual([{ kind: 'ignored' }]);
  });

  it('malformed line yields ignored, never throws', () => {
    const all = lines('system.jsonl');
    const bad = all[all.length - 1];
    expect(() => JSON.parse(bad)).toThrow();
    expect(parseLine(bad)).toEqual([{ kind: 'ignored' }]);
    for (const l of ['', '   ', 'null', '42', '[]', '"x"', '{"type":"assistant"}',
      '{"type":"assistant","message":null}', '{"type":"user","message":{"content":{}}}',
      '{"type":"assistant","message":{"model":"m","id":"i","usage":"nope","content":5}}']) {
      expect(() => parseLine(l)).not.toThrow();
      expect(parseLine(l)).toEqual([{ kind: 'ignored' }]);
    }
  });
});

describe('every fixture line parses without throwing', () => {
  it('main and subagent fixtures', () => {
    const files = readdirSync(FX).filter((f) => f.endsWith('.jsonl')).map((f) => join(FX, f));
    const sub = join(FX, 'subagents');
    for (const f of readdirSync(sub).filter((x) => x.endsWith('.jsonl'))) files.push(join(sub, f));
    let api = 0;
    for (const f of files) {
      for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        const r = parseLine(l);
        expect(r.length).toBeGreaterThan(0);
        api += r.filter((p) => p.kind === 'api_part').length;
      }
    }
    expect(api).toBeGreaterThan(5);
  });
});

describe('parseSubagentMeta', () => {
  it('reads the fixture meta file', () => {
    const sub = join(FX, 'subagents');
    const f = readdirSync(sub).find((x) => x.endsWith('.meta.json'))!;
    const m = parseSubagentMeta(readFileSync(join(sub, f), 'utf8'));
    expect(m.agentType).toBe('custom-agent-1');
    expect(m.toolUseId).toBe(json(lines('agent.jsonl')[0]).message.content[0].id);
    expect(m.spawnDepth).toBe(1);
    expect(typeof m.description).toBe('string');
  });

  it('is tolerant of missing fields and bad JSON', () => {
    expect(parseSubagentMeta('{}')).toEqual({ agentType: 'subagent', description: '', toolUseId: null, spawnDepth: 1 });
    expect(parseSubagentMeta('not json')).toEqual({ agentType: 'subagent', description: '', toolUseId: null,
      spawnDepth: 1 });
  });
});
