export interface TokenParts { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number; thinking: number }
export type CostParts = TokenParts;                       // same keys, dollars
export interface ToolUse { id: string; name: string; label: string; skill: string | null; inputJson: string; inputChars: number }
export interface AdvisorUsage { model: string; tokens: TokenParts }
export type ParsedLine =
  | { kind: 'api_part'; messageId: string; sessionId: string; ts: string; model: string; effort: string | null;
      speed: 'standard' | 'fast'; tokens: TokenParts; advisor: AdvisorUsage[]; thinkingMs: number | null;
      cwd: string | null; gitBranch: string | null; ccVersion: string | null; toolUses: ToolUse[]; raw: string }
  | { kind: 'prompt'; uuid: string; sessionId: string; ts: string; text: string; raw: string }
  | { kind: 'tool_result'; toolUseId: string; ts: string; isError: boolean; resultChars: number;
      permission: string | null; denied: boolean; raw: string }
  | { kind: 'turn_duration'; ts: string; durationMs: number }
  | { kind: 'compaction'; ts: string; preTokens: number; durationMs: number; trigger: string }
  | { kind: 'hook_runs'; ts: string; runs: { command: string; durationMs: number }[] }
  | { kind: 'title'; sessionId: string; title: string }
  | { kind: 'slash_command'; ts: string; name: string }
  | { kind: 'ignored' };
export type Range = { preset: 'today' | 'week' | 'month' | 'all' } | { from: string; to: string };
