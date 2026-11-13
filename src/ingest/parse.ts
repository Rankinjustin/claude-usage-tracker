import type { AdvisorUsage, ParsedLine, TokenParts, ToolUse } from '../core/types';

type Obj = Record<string, unknown>;

const ignored = (): ParsedLine[] => [{ kind: 'ignored' }];
const NOT_PROMPT_PREFIXES = ['<local-command', '<system-reminder>', '<task-notification', 'Caveat:'];
const IMAGE_CHARS = 6000;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Label for a tool call, plus the skill name when the tool is `Skill`. */
export function toolLabel(name: string, input: Record<string, unknown>): { label: string; skill: string | null } {
  if (name === 'Skill') {
    const skill = typeof input.skill === 'string' ? input.skill : null;
    return { label: `Skill: ${skill ?? '?'}`, skill };
  }
  if (name === 'Agent' || name === 'Task') {
    const type = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'general-purpose';
    return { label: `Agent: ${type}`, skill: null };
  }
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    return { label: `MCP ${parts[1].replace(/^claude_ai_/, '')}: ${parts.slice(2).join('__')}`, skill: null };
  }
  return { label: name, skill: null };
}

/** Reads a sub-agent `.meta.json`; never throws. */
export function parseSubagentMeta(json: string): {
  agentType: string; description: string; toolUseId: string | null; spawnDepth: number;
} {
  let m: unknown;
  try { m = JSON.parse(json); } catch { m = null; }
  const o = isObj(m) ? m : {};
  return {
    agentType: str(o.agentType) ?? 'subagent',
    description: str(o.description) ?? '',
    toolUseId: str(o.toolUseId),
    spawnDepth: typeof o.spawnDepth === 'number' ? o.spawnDepth : 1,
  };
}

/** Parses one transcript line into zero-information `ignored` or typed records. Never throws. */
export function parseLine(line: string): ParsedLine[] {
  let rec: unknown;
  try { rec = JSON.parse(line); } catch { return ignored(); }
  if (!isObj(rec)) return ignored();
  try {
    return parseRecord(rec, line);
  } catch {
    return ignored();
  }
}

function parseRecord(rec: Obj, raw: string): ParsedLine[] {
  switch (rec.type) {
    case 'assistant': return parseAssistant(rec, raw);
    case 'user': return parseUser(rec, raw);
    case 'system': return parseSystem(rec);
    case 'ai-title': {
      const sessionId = str(rec.sessionId);
      const title = str(rec.aiTitle);
      return sessionId !== null && title !== null ? [{ kind: 'title', sessionId, title }] : ignored();
    }
    default: return ignored();
  }
}

function tokensOf(u: Obj, thinking: number): TokenParts {
  const cc = isObj(u.cache_creation) ? u.cache_creation : null;
  const hasTiers = cc !== null
    && (typeof cc.ephemeral_5m_input_tokens === 'number' || typeof cc.ephemeral_1h_input_tokens === 'number');
  return {
    input: num(u.input_tokens),
    cacheWrite5m: hasTiers ? num(cc!.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens),
    cacheWrite1h: hasTiers ? num(cc!.ephemeral_1h_input_tokens) : 0,
    cacheRead: num(u.cache_read_input_tokens),
    output: Math.max(0, num(u.output_tokens) - thinking),
    thinking,
  };
}

function parseAssistant(rec: Obj, raw: string): ParsedLine[] {
  const msg = rec.message;
  if (!isObj(msg)) return ignored();
  const model = str(msg.model);
  if (!model || model === '<synthetic>') return ignored();
  const messageId = str(msg.id) ?? str(rec.requestId);
  const ts = str(rec.timestamp);
  const usage = msg.usage;
  if (!messageId || !ts || !isObj(usage)) return ignored();

  const details = isObj(usage.output_tokens_details) ? usage.output_tokens_details : {};
  const tokens = tokensOf(usage, num(details.thinking_tokens));

  const advisor: AdvisorUsage[] = [];
  if (Array.isArray(usage.iterations)) {
    for (const it of usage.iterations) {
      if (isObj(it) && it.type === 'advisor_message') {
        advisor.push({ model: str(it.model) ?? model, tokens: tokensOf(it, 0) });
      }
    }
  }

  const toolUses: ToolUse[] = [];
  if (Array.isArray(msg.content)) {
    for (const b of msg.content) {
      if (!isObj(b) || b.type !== 'tool_use') continue;
      const id = str(b.id);
      const name = str(b.name);
      if (!id || !name) continue;
      const input = isObj(b.input) ? b.input : {};
      const inputJson = JSON.stringify(input);
      toolUses.push({ id, name, ...toolLabel(name, input), inputJson, inputChars: inputJson.length });
    }
  }

  return [{
    kind: 'api_part',
    messageId,
    sessionId: str(rec.sessionId) ?? '',
    ts,
    model,
    effort: str(rec.effort),
    speed: usage.speed === 'fast' ? 'fast' : 'standard',
    tokens,
    advisor,
    thinkingMs: typeof rec.thinkingDurationMs === 'number' ? rec.thinkingDurationMs : null,
    cwd: str(rec.cwd),
    gitBranch: str(rec.gitBranch),
    ccVersion: str(rec.version),
    toolUses,
    raw,
  }];
}

/** Characters in a tool_result body: text length, 6000 per image, JSON length for anything else. */
function resultChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content) {
    if (isObj(b) && b.type === 'text') n += (str(b.text) ?? '').length;
    else if (isObj(b) && b.type === 'image') n += IMAGE_CHARS;
    else n += JSON.stringify(b).length;
  }
  return n;
}

function parseUser(rec: Obj, raw: string): ParsedLine[] {
  const ts = str(rec.timestamp);
  const msg = rec.message;
  if (!ts || !isObj(msg)) return ignored();
  const content = msg.content;

  const blocks = Array.isArray(content) ? content.filter(isObj) : [];
  const results = blocks.filter((b) => b.type === 'tool_result' && str(b.tool_use_id));
  if (results.length > 0) {
    const pd = rec.permissionDecision;
    const permission = typeof pd === 'string' ? pd : isObj(pd) ? JSON.stringify(pd) : null;
    return results.map((b): ParsedLine => ({
      kind: 'tool_result',
      toolUseId: b.tool_use_id as string,
      ts,
      isError: b.is_error === true,
      resultChars: resultChars(b.content),
      permission,
      denied: Boolean(rec.toolDenialKind),
      raw,
    }));
  }

  if (rec.isMeta === true || rec.isCompactSummary === true || rec.isSidechain === true) return ignored();
  const text = typeof content === 'string'
    ? content
    : blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join('\n');
  if (!text) return ignored();

  const head = text.trimStart();
  const cmd = /^<command-(?:message|name)>/.test(head) ? /<command-name>\/?([^<]*)<\/command-name>/.exec(text) : null;
  if (cmd) return [{ kind: 'slash_command', ts, name: cmd[1] }];
  if (NOT_PROMPT_PREFIXES.some((p) => head.startsWith(p))) return ignored();
  return [{ kind: 'prompt', uuid: str(rec.uuid) ?? '', sessionId: str(rec.sessionId) ?? '', ts, text, raw }];
}

function parseSystem(rec: Obj): ParsedLine[] {
  const ts = str(rec.timestamp);
  if (!ts) return ignored();
  switch (rec.subtype) {
    case 'turn_duration':
      return [{ kind: 'turn_duration', ts, durationMs: num(rec.durationMs) }];
    case 'compact_boundary': {
      const m = isObj(rec.compactMetadata) ? rec.compactMetadata : {};
      return [{ kind: 'compaction', ts, preTokens: num(m.preTokens), durationMs: num(m.durationMs),
        trigger: str(m.trigger) ?? '' }];
    }
    case 'stop_hook_summary': {
      const infos = Array.isArray(rec.hookInfos) ? rec.hookInfos.filter(isObj) : [];
      return [{ kind: 'hook_runs', ts,
        runs: infos.map((h) => ({ command: str(h.command) ?? '', durationMs: num(h.durationMs) })) }];
    }
    default:
      return ignored();
  }
}
