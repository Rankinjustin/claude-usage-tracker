# Token Tracker — Stage 1 Implementation Plan (recording + core views)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. No commit steps: the owner commits when they ask.

**Goal:** A Claude Code plugin that records every Claude Code API call, prompt, tool call and subagent run into a permanent local SQLite store from install day, and serves a live local React app (Overview, Sessions, Prompts, Agents & skills, prompt detail) opened by `/token-tracker:spend`, plus a status line.

**Architecture:** One TypeScript codebase. A tolerant transcript parser feeds an incremental indexer that writes SQLite (`node:sqlite`). The indexer runs as a one-shot from `SessionStart`/`SessionEnd` hooks and continuously inside a loopback-only server that also serves the React build, a read-only JSON API and a server-sent-events stream. A launcher script started by the `/spend` skill finds or starts the server and opens the browser.

**Tech Stack:** Node 22.13+, TypeScript (strict), `node:sqlite`, `node:http` (no server framework), esbuild (server/hooks/CLI bundles), Vite + React 18 + TypeScript (UI), Vitest (+ @testing-library/react, jsdom), hand-drawn SVG charts (no chart library).

**Spec:** `docs/design.md` (sections 4–11, especially 10b and 11). Mockups: `docs/mockups/` (`agents-view-v3.html`, `prompt-detail.html`). Numeric reference: a private prototype (`token_dashboard.py`, not in this repo).

**Repo:** `the repo root` (new; the plugin's root is the repo root).

## Global Constraints

- Node `>=22.13.0`; on first run of any entry point, an older Node prints `Token Tracker needs Node 22.13 or newer (found <version>).` and exits 0 (never breaks the session).
- No runtime network access; no CDN; fonts (Geist, Geist Mono) and all assets bundled. Server binds `127.0.0.1` only.
- Read-only on `~/.claude/projects`. Writes only under the data home: env `TOKEN_TRACKER_HOME`, else `~/.claude/token-tracker/`. Directory 0700, files 0600 (Windows: owner-only ACL via `icacls` on the directory at creation).
- Transcripts root: env `CLAUDE_CONFIG_DIR` + `/projects` if set, else `~/.claude/projects`.
- Costs are labelled "at API list prices". Unknown models are priced `null` and flagged, never at another model's rate.
- Hooks never exit non-zero and never block; `SessionEnd` hook `timeout: 30`.
- Paths with spaces and Windows backslashes must work everywhere (e.g. `C:\Users\Jane Doe`).
- Design tokens and look follow `mockups/agents-view-v3.html` (warm charcoal dark default by system theme, warm off-white light, amber accent `#f0a640` dark / `#c27a12` light, chart slots in the validated order `#3987e5,#d95926,#199e70,#c98500,#d55181,#008300,#9085e9,#e66767` dark / `#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#e34948` light). Use the `frontend-design` skill for UI tasks.

## Review Focus

1. **Half-written last line while tailing** — Claude Code is mid-write; the indexer must not consume a line without a trailing newline and must pick it up next pass. (Task 6 test `keeps partial trailing line for next pass`.)
2. **Same API response in several files / several lines** — resumed or forked sessions repeat records; usage must count once per `message.id` globally. (Task 6 test `dedupes message ids across files`.)
3. **Hook and server indexing at the same time** — one writer only; the second waits or skips without corrupting offsets. (Task 7 test `second indexer skips while lock held`.)
4. **Day boundaries in local time** — "Today" and daily buckets use the machine's local timezone, not UTC. (Task 8 test `today range uses local midnight`.)
5. **Transcript deleted or truncated between passes** — file gone: keep data, mark coverage; file shorter than stored offset: rescan from 0 with dedupe. (Task 6 test `rescans truncated file without double counting`.)

---

## File structure

```
token-tracker/
  .claude-plugin/plugin.json          manifest (name "token-tracker")
  .claude-plugin/marketplace.json     makes the repo installable
  hooks/hooks.json                    SessionStart + SessionEnd command hooks
  skills/spend/SKILL.md               /token-tracker:spend
  skills/setup/SKILL.md               /token-tracker:setup (status line)
  dist/                               committed build output (cli.mjs, server.mjs, ui/)
  src/core/paths.ts                   data home, transcripts root, permissions
  src/core/prices.ts                  dated price table + priceCall
  src/core/types.ts                   shared types (below)
  src/ingest/parse.ts                 line -> ParsedLine[]
  src/ingest/indexer.ts               incremental indexing, attribution, coverage
  src/ingest/lock.ts                  single-writer lock
  src/store/db.ts                     open, migrate, write API
  src/store/schema.sql                tables
  src/query/ranges.ts                 Range -> [fromIso, toIso)
  src/query/views.ts                  read functions for each view
  src/server/server.ts                http, auth, API, SSE, idle shutdown
  src/cli.ts                          entry: index | backfill | hook-start | hook-end | serve | open | statusline | setup
  src/ui/                             React app (Vite root)
  test/fixtures/                      anonymised transcript corpus
  test/**/*.test.ts(x)
```

## Shared types (`src/core/types.ts`, produced by Task 2, used everywhere)

```ts
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
```

---

### Task 1: Plugin skeleton and build

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `esbuild.config.mjs`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `skills/spend/SKILL.md`, `skills/setup/SKILL.md`, `src/cli.ts` (stub that prints its subcommand), `.gitignore` (excludes `node_modules`, not `dist`)

**Interfaces:**
- Produces: `npm run build` → `dist/cli.mjs`, `dist/server.mjs`, `dist/ui/index.html`; `npm test` runs Vitest.

- [ ] **Step 1:** `package.json`: `"type": "module"`, `"engines": { "node": ">=22.13.0" }`, scripts `build`, `test`, `typecheck`. Runtime dependencies: none (React is bundled into `dist/ui`), so Claude Code's automatic dependency install has nothing to do.
- [ ] **Step 2:** `plugin.json`: `{ "name": "token-tracker", "displayName": "Token Tracker", "version": "0.1.0", "description": "Records your Claude Code token spend and shows it in a live local dashboard.", "license": "MIT" }`. `marketplace.json`: `{ "name": "token-tracker", "owner": { "name": "<owner>" }, "plugins": [{ "name": "token-tracker", "source": "./" }] }`.
- [ ] **Step 3:** `hooks/hooks.json`:
```json
{ "hooks": {
  "SessionStart": [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs\" hook-start" }] }],
  "SessionEnd":   [{ "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs\" hook-end", "timeout": 30 }] }]
} }
```
- [ ] **Step 4:** `skills/spend/SKILL.md`: frontmatter `description: Open the Token Tracker dashboard`, `disable-model-invocation: true`; body runs `` !`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" open` `` and tells Claude to show the printed URL and nothing else. `skills/setup/SKILL.md` likewise runs `setup --check` and asks the user before running `setup --apply` (Task 12).
- [ ] **Step 5:** Run `npm run build && claude plugin validate .` — Expected: build succeeds; validate reports no errors.
- [ ] **Step 6 (capability spike):** `claude plugin marketplace add "the repo root"`, `claude plugin install token-tracker@token-tracker`, start a session, run `/token-tracker:spend`, exit. Expected: the stub prints `open`, and a file `hook-start`/`hook-end` log line appears in `~/.claude/token-tracker/debug.log` (stub writes one line per subcommand). Record any difference from design 10b in the plan before continuing.

### Task 2: Paths, permissions and shared types

**Files:**
- Create: `src/core/types.ts` (as above), `src/core/paths.ts`
- Test: `test/core/paths.test.ts`

**Interfaces:**
- Produces: `dataHome(): string`, `ensureDataHome(): string` (creates with owner-only permissions, returns path), `projectsRoot(): string`, `dbPath(): string` (= `<dataHome>/tracker.db`), `stateFile(name: 'server.json' | 'installed.json' | 'debug.log'): string`.

- [ ] **Step 1: Tests** — `dataHome honours TOKEN_TRACKER_HOME`; `dataHome defaults to <home>/.claude/token-tracker`; `projectsRoot honours CLAUDE_CONFIG_DIR`; `ensureDataHome creates dir with mode 0o700 on posix` (skip on win32); `paths with spaces round-trip` (home `C:\Users\Jane Doe` → `C:\Users\Jane Doe\.claude\token-tracker`).
- [ ] **Step 2:** Run `npx vitest run test/core/paths.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** Implement with `os.homedir()`, `path.join`; on win32 `ensureDataHome` runs `icacls "<dir>" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"` once at creation via `execFileSync` (no shell string building).
- [ ] **Step 4:** Run the test file — Expected: PASS.

### Task 3: Price table and pricing

**Files:**
- Create: `src/core/prices.ts`
- Test: `test/core/prices.test.ts`

**Interfaces:**
- Produces: `PRICES: PriceRow[]` where `PriceRow = { id: string; model: string; effectiveFrom: string; input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; longContextOver?: number; longContextMultiplier?: number; fastMultiplier?: number }` ($ per million tokens); `priceCall(model: string, tokens: TokenParts, at: string, speed?: 'standard' | 'fast'): { cost: number | null; parts: CostParts | null; priceId: string | null }`.

- [ ] **Step 1: Tests** with the spec's values (design §11.7):
  - `opus 5.5 call matches reference screenshot`: tokens `{input:6, cacheWrite1h:38580, cacheRead:200107, output:2207, thinking:244}` → cost `0.3977` (±0.0001), `parts.cacheWrite1h` `0.3086`, `parts.cacheRead` `0.0400`.
  - `haiku 5.5 over 100K prompt bills 5x`: input+cache tokens 120,000 → each rate × 5.
  - `fast mode doubles opus 5.5 and fable 5.2`.
  - `unknown model returns null cost and null priceId`.
  - `row chosen by effectiveFrom <= at`.
- [ ] **Step 2:** Run — Expected: FAIL.
- [ ] **Step 3:** Rows effective `2026-01-01`: fable-5-2 `8/40/10/16/0.20` fast×2; opus-5-5 `4/20/5/8/0.20` fast×2; sonnet-5-5 `2/10/2.50/4/0.10`; haiku-5-5 `0.10/0.50/0.125/0.20/0.01`, longContextOver 100000 ×5. Thinking is priced at the output rate. Prompt size for the long-context test = input + cacheWrite5m + cacheWrite1h + cacheRead.
- [ ] **Step 4:** Run — Expected: PASS.

### Task 4: Fixture corpus and transcript parser

**Files:**
- Create: `scripts/make-fixtures.mjs` (dev-only; extracts and anonymises lines), `test/fixtures/*.jsonl`, `test/fixtures/subagents/*.jsonl` + `.meta.json`, `src/ingest/parse.ts`
- Test: `test/ingest/parse.test.ts`

**Interfaces:**
- Consumes: types (Task 2).
- Produces: `parseLine(line: string): ParsedLine[]`; `parseSubagentMeta(json: string): { agentType: string; description: string; toolUseId: string | null; spawnDepth: number }`; `toolLabel(name: string, input: Record<string, unknown>): { label: string; skill: string | null }`.

- [ ] **Step 1: Fixtures.** `make-fixtures.mjs <transcriptsDir> <outDir>` picks ≥1 line of each record type listed in design §5 from the owner's transcripts and replaces prompt/result text with `lorem` of equal length, paths with `/repo/fileN`, ids with stable fakes (keep `message.id` collisions). Include: a split assistant response (3 lines, one `message.id`), an advisor iteration, a `Skill` tool_use, a `<command-name>` user record, a tool_result with `is_error`, a denied permission, `turn_duration`, `compact_boundary`, `stop_hook_summary`, `ai-title`, a subagent file + meta, and a malformed line.
- [ ] **Step 2: Tests** — `split response yields api_part per line with same messageId`; `advisor iteration parsed with its own model`; `thinking tokens split out of output`; `Skill tool_use gives skill name`; `Agent tool_use label is "Agent: <subagent_type>"`; `mcp tool label is "MCP <server>: <tool>"`; `slash command record yields slash_command`; `tool_result chars counted, images 6000 chars each`; `malformed line yields ignored, never throws`; `unknown record type yields ignored`; `synthetic model lines ignored`.
- [ ] **Step 3:** Run — Expected: FAIL.
- [ ] **Step 4:** Implement `parseLine`. `api_part` comes from `type: "assistant"`; `tokens.output = usage.output_tokens − thinking`; cache tiers from `usage.cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, falling back to `cache_creation_input_tokens` as 5m; `speed` from `usage.speed`. Prompts are `type: "user"` with string or text content that is not a tool_result, not `isMeta`, not a compact summary, and doesn't start with `<local-command`, `<system-reminder>`, `<task-notification`, or `Caveat:`.
- [ ] **Step 5:** Run — Expected: PASS.

### Task 5: SQLite store

**Files:**
- Create: `src/store/schema.sql`, `src/store/db.ts`
- Test: `test/store/db.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): Db` (WAL, foreign keys, runs migrations, `PRAGMA user_version`); `Db` methods: `upsertSession(s)`, `upsertRun(r)`, `insertPrompt(p)`, `upsertApiCall(c)` (merges tool uses into an existing message id, never re-adds tokens), `insertToolCall(t)`, `completeToolCall(toolUseId, result)`, `insertCompaction`, `insertHookRuns`, `getFileState(path)`, `setFileState(path, {size, mtimeMs, offset, sessionId, runId})`, `markFileMissing(path)`, `meta.get/set(key)`, `transaction(fn)`.

Tables (columns the later tasks rely on; types and indexes are the builder's):
`sessions(id, title, project, cwd, first_ts, last_ts, cc_version)` · `runs(id, session_id, agent_type, description, launch_tool_use_id, parent_run_id, file)` (main thread = run id `main:<sessionId>`, agent_type `main`) · `prompts(uuid, session_id, ts, text, duration_ms)` · `api_calls(message_id PK, session_id, run_id, prompt_uuid, ts, model, effort, speed, input, cache_write_5m, cache_write_1h, cache_read, output, thinking, ctx_tokens, cost, cost_parts_json, price_id, thinking_ms, raw_json)` · `advisor_calls(message_id, model, tokens_json, cost)` · `tool_calls(tool_use_id PK, message_id, run_id, prompt_uuid, name, label, skill, input_json, started_ts, ended_ts, result_chars, is_error, denied, permission)` · `compactions(session_id, run_id, ts, pre_tokens, duration_ms, trigger)` · `hook_runs(session_id, ts, command, duration_ms)` · `files(path PK, size, mtime_ms, offset, session_id, run_id, missing)` · `meta(key PK, value)`.

- [ ] **Step 1: Tests** — `migrates fresh db to latest user_version`; `upsertApiCall twice with same message id keeps tokens once and unions tool uses`; `raw_json stored`; `file state round-trips`; `transaction rolls back on throw`; `db file created 0600 on posix`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement with `DatabaseSync` from `node:sqlite`. **Step 4:** Run — PASS.

### Task 6: Incremental indexer

**Files:**
- Create: `src/ingest/indexer.ts`
- Test: `test/ingest/indexer.test.ts`

**Interfaces:**
- Consumes: `parseLine`, `parseSubagentMeta`, `priceCall`, `Db`.
- Produces: `indexAll(db: Db, opts?: { root?: string; onProgress?: (done: number, total: number) => void }): IndexResult`; `indexFile(db: Db, path: string): IndexResult`; `IndexResult = { files: number; newCalls: number; newPrompts: number; changedSessions: string[] }`.

Rules (design §5):
- Read from the stored offset to the last `\n`. Bytes after it stay for the next pass. A file shorter than the stored offset is rescanned from 0. A file that's gone is marked `missing`.
- Session id comes from the records. Run: main file → `main:<sessionId>`; subagent file → id `agent-<id>` from the filename, with `parent` and `launch_tool_use_id` from `.meta.json`.
- Prompt attribution: within a run file, each `api_part` and tool use takes the most recent `prompt` uuid of the **main** file. A subagent run gets its prompt through the launching `tool_calls.prompt_uuid` (resolved at query time, Task 8).
- `ctx_tokens` = input + cacheWrite5m + cacheWrite1h + cacheRead. Cost comes from `priceCall` at the call's timestamp. Advisor iterations go to `advisor_calls` with their own price.
- A tool result completes its tool call (`ended_ts`, `result_chars`, `is_error`, `denied`, `permission`).
- `turn_duration` sets `prompts.duration_ms` on the most recent prompt.
- Everything for one file is written in one transaction.

- [ ] **Step 1: Tests** (on copies of fixtures in a temp dir) — `indexes fixture corpus: call count, total cost`; `keeps partial trailing line for next pass` (write half a line, index, append rest, index → 1 call); `dedupes message ids across files`; `rescans truncated file without double counting`; `marks deleted file missing and keeps its rows`; `subagent run linked to launching tool call`; `second pass with no changes reads 0 bytes`; `parity with reference script` (compares against a checked-in `test/fixtures/reference-totals.json`, produced once by `python token_dashboard.py --root test/fixtures --days 3650 --out test/fixtures/reference-totals.json`; total and per-model cost equal within $0.01).
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.

### Task 7: Lock, CLI entry points and hooks

**Files:**
- Create: `src/ingest/lock.ts`; Modify: `src/cli.ts`
- Test: `test/ingest/lock.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: `indexAll`, `indexFile`, paths.
- Produces: `withWriteLock<T>(fn: () => T, opts?: { waitMs?: number }): T | 'busy'` (lock = exclusive-create `<dataHome>/write.lock` holding `{pid, ts}`; stale if pid dead or ts > 10 min); CLI subcommands:
  - `hook-start` (stdin JSON). If `installed.json` is missing, write `{installedAt}` and spawn detached `cli.mjs backfill` (`spawn(process.execPath, [cli, 'backfill'], {detached: true, stdio: 'ignore'}).unref()`), then exit 0 within 200 ms.
  - `hook-end` (stdin JSON with `transcript_path`). If `server.json` points to a live server, POST `/api/poke`. Otherwise `withWriteLock(() => indexAll())`. Exit 0 always, logging errors to `debug.log`.
  - `backfill`: `indexAll` with progress written to `meta.backfill_progress`.
  - `index`: `indexAll`.
- [ ] **Step 1: Tests** — `second indexer skips while lock held`; `stale lock from dead pid is taken over`; `hook-start first run writes installed.json and returns fast` (spawn stubbed); `hook-end never exits non-zero on bad stdin`; `old node version prints message and exits 0`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.

### Task 8: Query layer for stage-1 views

**Files:**
- Create: `src/query/ranges.ts`, `src/query/views.ts`
- Test: `test/query/ranges.test.ts`, `test/query/views.test.ts`

**Interfaces:**
- Consumes: `Db`, `Range`.
- Produces: `resolveRange(r: Range, now?: Date): { from: string; to: string; prevFrom: string; prevTo: string }`, plus these functions over the range:
  - `overview(db, r)` → `{ total, prevTotal, tokens, calls, sessions, prompts, cacheHitPct, parts: {key, tokens, cost, pct}[], daily: {day, cost, parts}[], heat: {weekday, hour, cost}[], subagentPct, mainAvgCtx, takeaway }`
  - `sessions(db, r)` → `{ id, title, project, start, durationMin, calls, cost, agentCost, peakCtx, startCtx, compactions, models }[]`
  - `sessionDetail(db, id)` → `{ session, prompts: PromptRow[], runs: RunRow[], ctxSeries: {ts, ctx}[] }`
  - `prompts(db, r, q?: string)` → `PromptRow[]`, where `PromptRow = { uuid, sessionId, sessionTitle, ts, text, cost, agentCost, total, calls, durationMs, multipleOfMedian }`
  - `promptDetail(db, uuid)` → `{ prompt, summary: {cost, agentCost, durationMs, tokens, cacheReadPct, apiCalls, advisorCalls, toolCalls, failed, denied}, parts: {key, tokens, cost}[], byPart: {label, cost}[], runs: RunRow[], tools: {label, calls, failed}[] }`
  - `agents(db, r)` → `{ type, kind: 'built-in' | 'custom' | 'main', runs, calls, cost, pct, perRun, avgCtx, avgDurationMs, errorRate, sparkline: number[], flaggedRuns }[]`
  - `agentDetail(db, type, r)` → `{ stats, runs: RunRow[], medianCost }`
  - `coverage(db)` → `{ installedAt, sessionsComplete, sessionsPartial, filesMissingBeforeIndexed, backfillProgress }`
  - `statusLine(db, sessionId)` → `{ today, session, alerts }`

  `RunRow = { id, agentType, description, start, durationMs, cost, calls, promptUuid, promptText, flagged }`. A run is flagged when its cost is more than 3× the median of that agent type's previous runs, with at least 5 previous runs (design §10a default).
- [ ] **Step 1: Tests** (seed a temp db via the indexer on fixtures) — `today range uses local midnight` (TZ=America/Chicago, now 00:30 local ⇒ from = local midnight); `week range is last 7 days incl. today`; `prompt total includes subagent cost via launching tool call`; `overview parts sum to total`; `prompts search matches full text case-insensitively`; `run flagged above 3x median with 5 prior runs`; `not flagged with only 4 prior runs`; `unknown-model calls counted in tokens but listed as unpriced`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement as SQL, plus small TS post-processing. The `takeaway` sentence comes from the data, e.g. `Cache reads and writes were 73% of spend.` (whichever token type leads). **Step 4:** Run — PASS.

### Task 9: Local server

**Files:**
- Create: `src/server/server.ts`; Modify: `src/cli.ts` (`serve`)
- Test: `test/server/server.test.ts`

**Interfaces:**
- Consumes: query functions, `indexAll`, `withWriteLock`.
- Produces: `startServer(opts: { port?: number; idleMs?: number }): Promise<{ url: string; port: number; key: string; close(): Promise<void> }>`, which writes `server.json` `{pid, port, key, startedAt}` (0600).
- Routes: `GET /` (UI, sets `tt_key` cookie when `?key=` matches), `GET /api/overview|sessions|sessions/:id|prompts|prompts/:uuid|agents|agents/:type|coverage?range=today|week|month|all|from,to`, `POST /api/poke` (re-index now), `GET /api/events` (SSE `data: {"changed":[sessionIds]}` after each index pass). Requests without a valid key or cookie get 401. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, otherwise 403 (blocks DNS rebinding). No CORS headers.
- Behaviour: indexes on start, then watches `projectsRoot()` recursively with `fs.watch` (with a 2 s poll fallback) and re-indexes changed files under the write lock. Idle shutdown after `idleMs` (default 30 min) with no SSE clients and no requests. Removes `server.json` on exit.
- [ ] **Step 1: Tests** — `rejects request without key (401)`; `accepts cookie after keyed load`; `rejects foreign Host header (403)`; `listens on 127.0.0.1 only`; `poke triggers index and SSE change event`; `shuts down after idle with no clients` (idleMs 200); `server.json removed on close`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement with `node:http`. **Step 4:** Run — PASS.

### Task 10: Launcher and `/spend`

**Files:**
- Modify: `src/cli.ts` (`open`)
- Test: `test/cli-open.test.ts`

**Interfaces:**
- Produces: `cli open` → if `server.json` names a live pid whose `/api/coverage` answers with the key, reuse it; otherwise spawn detached `cli.mjs serve` and poll `server.json` for up to 5 s. Then open the browser (`start "" "<url>"` on win32, `open` on darwin, `xdg-open` on linux, via `spawn` with an args array) and print `Token Tracker: <url>`.
- [ ] **Step 1: Tests** — `reuses live server`; `starts server when server.json is stale`; `prints url even if browser open fails`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5 (manual):** In a real session, `/token-tracker:spend` opens the browser. Running it again reuses the same port.

### Task 11: React app shell and stage-1 views

Use the `frontend-design` skill. Match `mockups/agents-view-v3.html` and `mockups/prompt-detail.html`.

**Files:**
- Create: `src/ui/main.tsx`, `src/ui/theme.css` (tokens from Global Constraints), `src/ui/api.ts`, `src/ui/App.tsx`, `src/ui/components/{Sidebar,RangeControl,Tile,DetailPanel,Kpi,Sparkline,StackBar,BarChart,HideTextToggle,CoverageBadge}.tsx`, `src/ui/views/{Overview,Sessions,Prompts,Agents}.tsx`, `src/ui/details/{PromptDetail,SessionDetail,RunDetail}.tsx`
- Test: `test/ui/*.test.tsx`

**Interfaces:**
- Consumes: the JSON shapes from Task 8 via `api.ts`: `getJSON<T>(path: string, range: Range): Promise<T>`, `subscribe(onChange: (sessionIds: string[]) => void): () => void` (EventSource on `/api/events`).
- Navigation uses hash routes: `#overview`, `#sessions`, `#prompts`, `#agents`; detail opens as `#prompts/<uuid>` etc. and renders in `DetailPanel`. `DetailPanel` has a full-page toggle and a back arrow, and slides over the tiles when the window is narrower than 900px. Every list row and tile links to its detail (design §4). Stage-3 views (Tools, Models, History, Savings) show in the sidebar as disabled with "coming soon".
- `HideTextToggle` masks prompt text and file paths everywhere (`•••`). Stored in `localStorage` key `tt.hideText`.
- Charts are SVG with tooltips that stay inside the chart box. Every chart has `role="img"` and an `aria-label`.

- [ ] **Step 1: Tests** — `sidebar marks active view from hash`; `range control refetches with new range`; `clicking a tile opens detail panel with its id in hash`; `hide text masks prompt text`; `prompt detail shows total = main + agents`; `live event refetches current view`; `coverage badge shows partial sessions count`; `empty store shows a designed empty state with backfill progress`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.
- [ ] **Step 5 (manual):** `npm run build`, `/token-tracker:spend`. Check dark and light at full width and at 400px against the mockups.

### Task 12: Status line and setup

**Files:**
- Modify: `src/cli.ts` (`statusline`, `setup`)
- Test: `test/statusline.test.ts`

**Interfaces:**
- Consumes: `statusLine(db, sessionId)`; status line stdin (`session_id`, `cost.total_cost_usd`, `context_window.used_percentage`, `context_window.context_window_size`).
- Produces: `cli statusline` prints one line, `▮▮▮ $<today> today · session $<session> · context <K>K` plus ` · ▲ <n> alert(s)` when alerts > 0. It reads the db read-only and never writes. If the db is missing or busy, it falls back to stdin's `cost.total_cost_usd` for the session and prints `today —`. Must finish in under 150 ms on a 100 MB db.
- `cli setup --check` prints whether `~/.claude/settings.json` has a `statusLine`. `setup --apply` writes `{"statusLine": {"type": "command", "command": "node \"<abs path to dist/cli.mjs>\" statusline"}}`, keeping a backup `settings.json.bak-token-tracker`, and refuses to replace an existing `statusLine` unless passed `--replace`.
- [ ] **Step 1: Tests** — `formats today, session, context`; `shows alert marker`; `falls back to stdin cost when db missing`; `setup refuses to overwrite existing statusLine without --replace`; `setup writes backup`.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** Run — PASS.

### Task 13: End-to-end check on real data and README

**Files:**
- Create: `README.md` (install commands, what's recorded and where, privacy, Node requirement, uninstall keeps `~/.claude/token-tracker/`, delete it by hand until stage 3's delete command exists)

- [ ] **Step 1:** Run `node dist/cli.mjs backfill` against the owner's real `~/.claude/projects` with `TOKEN_TRACKER_HOME` set to a temp dir. Expected: completes, and for the same window `python token_dashboard.py --days 7` reports total, per-model and per-token-type cost within $0.05.
- [ ] **Step 2:** Install the plugin from the repo, work a short session, exit, then `/token-tracker:spend`. Expected: the session and its prompts appear, the status line shows today's spend after `/token-tracker:setup`, and coverage shows the backfill start date.
- [ ] **Step 3:** Run `npm test && npm run typecheck`. Expected: all green.
