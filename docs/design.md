# Token Tracker — design

Date: 2026-11-13 · Status: draft for review · Working name: **Token Tracker** (final name open)

## 1. Intent

A Claude Code plugin that records every token a person spends in Claude Code, from the day they install it, and lets them explore that spend in a live local web app and inside Claude Code itself.

Why the owner wants it:

- **Understand usage.** Where tokens go: by model, token type, session, prompt, subagent, skill, tool, project and time of day. Plain curiosity counts.
- **Cut spend.** Find the expensive habits (long contexts, cache rebuilds, chatty agents, costly prompts) and get concrete suggestions.
- **Catch things going wrong.** Notice when a skill, agent or tool suddenly costs or takes far more than its usual, loops, or keeps failing.
- **Compare processes.** How long and how much each skill, agent, tool or task takes, against each other and against their own history.
- **Share it.** It will live in the owner's personal repo so anyone can install it and run it on their own machine.

## 2. Goals, non-goals, anti-goals

**Goals**

- Permanent, complete history from install day onward (plus a backfill of whatever transcripts still exist at install).
- Live while open: numbers move as the person works.
- Drill-down to the deepest level the transcripts allow: session → prompt → API call / tool call / subagent run, with time and cost at each level.
- Works for anyone with Claude Code; nothing tied to the owner's machine, projects or company.

**Non-goals (v1)**

- claude.ai chats, the Claude desktop app's chat, the API Console, or other machines. Only Claude Code on the machine where the plugin is installed.
- Syncing or merging history across machines (export/import covers moving machines).
- Real billing figures for subscription plans. Costs are **estimates at API list prices**; the UI says so.
- Changing Claude Code behaviour (no blocking, throttling or budget enforcement).

**Anti-goals (failure even if it "works")**

- Any data leaving the machine (no telemetry, no CDN, no remote fonts or scripts at runtime) other than the opt-in AI review, which goes through the user's own Claude Code.
- The app reachable from another device on the network, or by another local user without the access key.
- Modifying anything under `~/.claude/projects` (read-only access to transcripts).
- Slowing Claude Code down noticeably (hooks must stay around a second or less).
- Silent holes in history that the user does not know about.
- Wrong numbers presented as exact (estimates are labelled as estimates).

## 3. Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **TypeScript on Node, React UI, packaged as a Claude Code plugin** | One language for indexer, server, hooks and UI; plugin install is the easiest way to share; Node 22's built-in SQLite avoids native add-ons. Requires Node 22+. | **Chosen** |
| Python (standard library server + SQLite) | Builds on the existing draft script and needs no installs, but the Claude Code panel still needs JavaScript (charts written twice) and Python is not on every machine running Claude Code. | Rejected |
| Desktop app (Electron / Tauri) | Polished window, but far bigger build and installer, no easier to share, and the in-Claude-Code panel is still separate work. | Rejected |
| Always-running background service | Always live, but a process running all day for a dashboard opened occasionally. | Replaced by: app starts on `/spend` and stops when idle, plus a session-end hook for history. |

UI language: **React written in TypeScript** (owner's choice after comparing with plain JavaScript).

## 4. What the owner decided

- **Form:** a Claude Code plugin containing a live local web app, a `/spend` command, a session-end hook, a status line and a panel inside Claude Code.
- **Launch model:** `/spend` starts the app in the background if it is not running and opens the browser to it; if running, it just opens the browser. The app watches transcripts while open and shuts itself down after an idle period (proposed 30 minutes without a connected viewer).
- **History:** permanent from install day; backfill existing transcripts on install; a session-end hook records each session even when the app is never opened. Nothing is lost when Claude Code deletes old transcripts.
- **Full prompt text** is stored and searchable. A hide-text switch on the page masks prompt text for screenshots.
- **Layout:** a sidebar to move between views; each view opens with a row of tiles; clicking a tile opens a **detail panel on the right** (tiles stay in place). On narrow widths the panel slides over the tiles.
- **Views (all eight):** Overview, Sessions, Prompts, Agents & skills, Tools, Models & effort, History, Savings & alerts.
- **Everything in a list is clickable** to its own detail (run, session, prompt, tool call, skill use), with links both ways along the chain (prompt → its runs → their tool calls; flagged run → the prompt that launched it). Detail opens in the right panel with a "full page" button and a back arrow.
- **Maximum detail** per session, prompt and run (section 7).
- **Look:** the approved mockups in `mockups/` next to this document (`agents-view-v3.html`, `prompt-detail.html`; `dark-themes.html` shows the theme choice, option C). They are authoritative for look, layout and what each page contains; their per-run numbers and copy are illustrative. Geist + Geist Mono, **warm charcoal dark theme** with an amber accent, matching warm off-white light theme, follows the system theme. Chart colors use the validated categorical palette (blue, orange, aqua, yellow, magenta, green, violet, red in that order), checked for colorblind separation on the warm charcoal surface `#211e1b`.
- **AI review (opt-in):** a "Review with Claude" button on any prompt, session or run explains what it did and how it could have been cheaper. Runs only when pressed (automatic summaries are a setting, off by default). Uses the user's own Claude Code headlessly (`claude -p`), defaulting to Haiku; each review shows its own cost and is itself recorded as spend.
- **Repo:** shared from the owner's personal repo; usage data is never committed.

## 5. Data source (what Claude Code records)

Verified against the owner's transcripts (Claude Code 2.1.3xx):

- Location: `~/.claude/projects/<project-slug>/<sessionId>.jsonl`; subagents in `<sessionId>/subagents/agent-<id>.jsonl` with a sibling `.meta.json` (`agentType`, `description`, `toolUseId` of the launching Agent call, `spawnDepth`).
- **Assistant records** carry `message.model`, `message.usage` (`input_tokens`, `cache_creation_input_tokens` with `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `server_tool_use.web_search_requests`, `iterations[]`), plus `effort`, `requestId`, `timestamp`, `thinkingDurationMs`, `cwd`, `gitBranch`. **One API response is split across several records sharing `message.id`; usage must be counted once per id.**
- **Advisor calls** appear as `usage.iterations[]` entries with `type: "advisor_message"` and their own `model`; top-level usage excludes them, so they are priced separately.
- **User records** hold prompts (string or text blocks) and tool results (`tool_result` blocks with `tool_use_id`, `is_error`, plus `toolUseResult` structured data, `permissionDecision`, `toolDenialKind`, `interruptedMessageId`).
- **System records:** `turn_duration` (`durationMs` per prompt), `stop_hook_summary` (`hookInfos[].durationMs`), `compact_boundary` (`compactMetadata.preTokens`, `durationMs`, trigger), `local_command`, `away_summary`.
- `ai-title` (session title), `cost-state` (session totals incl. `totalAPIDuration`, `totalToolDuration`, `totalLinesAdded/Removed`).
- `api-request` records carry `querySource` (`repl_main_thread`, `agent:builtin:<type>`, `agent:custom:<name>`).
- Claude Code deletes old transcripts (the owner's go back only ~3 weeks), which is why the plugin keeps its own store.

Derivations (from the existing draft `token_dashboard.py` (a private Python prototype), to be ported):

- Tool duration = tool_result timestamp − tool_use record timestamp. Model time = assistant timestamp − preceding user/tool_result timestamp (minus thinking where reported). Waiting for approval = time between a tool_use and its result when a permission decision was recorded.
- Tool cost estimate = ask (tool input size ÷ 4 at output price) + into context (result size ÷ 4 at the cache-write price) + re-reads (result tokens × later calls in the same transcript until the next compaction, at cache-read price). Labelled as an estimate.
- Prompt attribution: API calls after a prompt belong to it until the next prompt; subagent cost attaches to the prompt whose Agent tool call launched it (`toolUseId`).
- Cache rebuild events: a later call in a transcript that writes >20K cache tokens while reading fewer than it writes.
- "Phases" (what it was doing) grouped from consecutive tool calls by kind (reading/searching, running commands, editing, spawning agents, waiting for the user, writing the answer).

## 6. Architecture

One core with four front doors:

1. **Indexer** (Node, TypeScript). Tails transcript files incrementally (remembers byte offset + size + mtime per file; handles truncation/rotation by re-scanning a file), parses records, dedupes by message id, prices calls, and writes to SQLite. Runs inside the server while it is up, and as a short one-shot from the session-end hook and on install (backfill).
2. **Store:** SQLite via `node:sqlite` in the plugin's data directory (survives plugin updates and uninstall). Keeps every API call, tool call, prompt (full text), subagent run, session, compaction and hook run. A versioned price table is stored, and each call stores the prices used, so later price changes do not rewrite history. Each stored record also keeps its original transcript line as JSON beside the typed columns, so a Claude Code format change never breaks ingestion and old records can be re-parsed for fields added later. (Owner considered Postgres or a document store; SQLite chosen because it needs no server or install and fits single-user aggregation. A shared multi-machine database would be the reason to revisit.)
3. **Local server:** binds `127.0.0.1` only, random high port, a random access key in the URL (cookie after first load, same pattern as the brainstorming companion). Serves the built React app (all assets bundled; no network at runtime) and a read-only JSON API; pushes live updates over a WebSocket or SSE while a page is open. Idle shutdown. A lock/port file lets `/spend` find a running instance.
4. **Front doors:**
   - **`/spend`** slash command: ensure server, open browser, print the URL.
   - **Session-end hook:** one-shot index of that session; must finish in about a second and never block Claude Code on error.
   - **Status line:** script printing today's spend, current session cost, current context size and an alert marker. Proposed text: `▮▮▮ $11.03 today · session $2.14 · context 147K · ▲ 1 alert`. Installing it changes the user's status line setting, so the plugin offers it (e.g. `/spend setup`) rather than overwriting an existing one silently.
   - **Panel inside Claude Code:** the same web app at narrow width (sidebar becomes a top menu, tiles stack, detail slides over). Not a second UI.
5. **AI review worker:** on request, builds a compact digest of the item (no full transcript dump), runs `claude -p` with the chosen model, stores the result and its usage.

Commands also include export (CSV/JSON of everything), import (to move machines), and a deliberate delete-all-data command.

## 7. Views and detail pages

Every view: a time range at the top (Today, Week, Month, All time, Custom), a one-sentence takeaway written from the data, a few summary figures, then tiles; clicking a tile opens the right-hand detail panel.

- **Overview:** spend today/week/all time with change vs the previous period, token-type mix (input, cache write 5m/1h, cache read, output, thinking, advisor) in the style of the owner's reference screenshot, daily trend, day × hour heatmap, cache hit rate, top alerts.
- **Sessions:** each session with cost (main + agents), duration, calls, peak and starting context, models, compactions. Detail: every prompt and run on one timeline.
- **Prompts:** searchable full-text list with total cost including spawned agents, wall time, flags (e.g. multiple of median).
- **Agents & skills:** per agent type and skill: runs, cost, cost per run, average context, duration, error rate, trend sparkline, flagged runs. Detail: cost-per-run chart with the usual (median) line, the runs, the prompts that launched them.
- **Tools:** per tool: calls, estimated cost split (ask / into context / re-read), time spent, failures, denials; top shell commands; heaviest results.
- **Models & effort:** spend by model and effort level, advisor cost, a "same work on a cheaper model" estimate.
- **History:** week-by-week and month-by-month since install, by project, model, agent and token type.
- **Savings & alerts:** plain-language findings with the dollars involved, e.g. cache rebuilt 16 times ($22), half of spend on calls above 200K context, runaway sessions, agents far above their baseline.

**Prompt detail** (approved mockup `prompt-detail.html`): full prompt text and metadata; summary strip (cost main vs agents, wall time, tokens, API and advisor calls, tool calls with failed/denied, lines changed); "where the time went" (model thinking & writing, each tool, waiting on subagents, waiting for approval, skills, hooks & compaction); a timeline with one lane for the main thread and one per subagent, every call a bar on a shared clock, hover for details, click to open, failures marked; "what it was doing" phases; cost by part and by token type; files touched with lines added/removed; the AI review.

**Run detail:** the same for one agent run, plus what it handed back. **Session detail:** the same across all its prompts, plus compactions and context size over time. **Tool call detail:** input, result size and excerpt, exit code, duration, tokens added, estimated cost, permission decision.

**Baselines and flags:** each agent type, skill and tool keeps a rolling baseline (median and spread of cost, duration, error rate). A run or prompt well above its baseline is flagged in the list, the detail and the status line.

## 8. Security and privacy

- Loopback only; access key required for every HTTP and live-update request; no CORS for other origins.
- Read-only on `~/.claude`; writes only in the plugin's data directory.
- No outbound network from the app. Fonts and scripts are bundled.
- The database contains full prompt text and file paths. It never leaves the machine; export is explicit.
- Hide-text switch masks prompt text and file paths for screenshots.
- AI review is opt-in per press; the digest sent to `claude -p` is shown or describable to the user.

## 9. Constraints

- Node 22+ (built-in SQLite). Windows, macOS and Linux; paths and home directories with spaces (e.g. `C:\Users\Jane Doe`).
- Transcript format is undocumented and changes between Claude Code versions: parsing must be tolerant (unknown records ignored, missing fields defaulted) and record the Claude Code version seen.
- Prices change; the price table must be easy to update and versioned by date. Unknown models are priced as "unknown" and flagged, never silently at another model's rate.
- Hooks must be fast and never fail the session.

## 10. Release stages (owner approved)

Each stage is usable on its own. Recording comes first because every day without it is history lost.

1. **Recording + core views:** capability spike, indexer, store, backfill, session-end hook, `/spend`, local server; Overview, Sessions, Prompts, Agents & skills views with tiles and the right-hand detail panel; prompt detail without the timeline; status line; coverage indicator.
2. **Deep detail:** multi-lane timeline, "what it was doing" phases, tool cost estimates and time per tool/skill, Tools and Models & effort views, run and tool-call detail, baselines and flags.
3. **Extras:** History trends, Savings & alerts findings, AI review, panel inside Claude Code, export/import, delete-all-data.

## 10a. Left to the builder

- Exact SQLite schema, indexes, and migrations.
- Server framework (or none), bundler, chart library (or hand-drawn SVG), state management.
- Idle timeout value, port selection, lock-file details.
- Rolling-baseline method and flag thresholds (start simple: e.g. > 3× median cost or duration with at least 5 prior runs).
- How the in-Claude-Code panel is wired: check what Claude Code's plugin/mod surface provides for a persistent side panel; if it cannot host a web view, fall back to the status line plus `/spend`.
- Test approach and fixtures (a corpus of anonymised transcript lines covering each record type).
- Final product name.

## 10b. Confirmed plugin facts (Claude Code docs, checked 2026-11-13) and resulting changes

- Plugin = `.claude-plugin/plugin.json` + root folders (`skills/`, `hooks/hooks.json`, `bin/`); repo made installable by `.claude-plugin/marketplace.json`. Commands are skills (`skills/<name>/SKILL.md`, invoked `/<plugin>:<name>`), which can run shell with `` !`cmd` `` (2-minute limit) and substitute `${CLAUDE_PLUGIN_ROOT}`.
- Hooks: `SessionStart` and `SessionEnd` exist; stdin includes `session_id`, `transcript_path`, `cwd`. `SessionEnd` hooks get 1.5 s unless the hook sets a longer `timeout` (max 60 s). Failures are non-blocking by default.
- No install hook: first-run work (backfill) is triggered from `SessionStart` via a marker file, spawned detached so the session is not delayed.
- `${CLAUDE_PLUGIN_DATA}` exists but **is deleted on uninstall by default**. **Change:** the store lives in `~/.claude/token-tracker/` (override with env `TOKEN_TRACKER_HOME`), so history survives uninstall as designed.
- Status line is a user setting only; `/token-tracker:setup` edits it with consent. Its stdin gives `session_id`, `cost.total_cost_usd`, `context_window.*`.
- The in-Claude-Code panel is a **mod** pane drawn from a declarative element tree, not HTML. **Change (stage 3):** the panel is a compact native summary (today, this session, alerts, top items) with a link to the web app, not the web app at narrow width.

## 11. Answers from the builder review (designer's calls, owner may override)

1. **Plugin capabilities.** Commands and hooks are standard plugin pieces. A plugin cannot set the user's `statusLine`; `/spend setup` asks and then edits the user settings (never overwrites an existing status line without asking). A persistent data directory and a side-panel surface must be confirmed against current Claude Code docs: **the first plan task is a capability spike** (command, SessionEnd hook, data-dir location, panel). Fallbacks: data dir `~/.claude/token-tracker/` if no plugin data dir exists; if no panel surface can host the web view, the panel milestone is dropped and status line + `/spend` cover "inside Claude Code".
3. **Mockups:** see section 4 (`mockups/`).
4. **The Python draft** is at a private prototype (`token_dashboard.py`, not in this repo). The formulas in section 5 are the spec; the script is a reference. Plan one parity check: on the same transcript set, total cost, per-token-type cost and per-model cost must match the script within rounding.
5. **Fixtures:** build a fixture corpus by extracting real lines from the owner's transcripts, anonymised (prompt text, paths, ids replaced), covering every record type in section 5, plus synthesized edge cases. Parsing rules: subagent transcripts nest by `.meta.json` `toolUseId` at any `spawnDepth` (a subagent's own Agent calls link the same way); **dedupe API calls globally by `message.id`** (resumed/forked sessions repeat records across files); a **skill use** is a `tool_use` named `Skill` (`input.skill`), and a slash command shows as a user record with `<command-name>` and/or `toolUseResult.commandName`; both count as skill uses, keyed by name.
6. **Security:** data dir, database, lock/port file and key file are created user-only (0700/0600; owner-only ACL on Windows). The key lives in that user-only file and the browser cookie; opening the browser necessarily passes the keyed URL on the opener's command line (briefly visible to the same user, and to others on Linux/macOS via process listings). Accepted for a loopback-only server; possible later hardening: make `?key=` single-use, exchanged for the cookie. This guards against other local users and drive-by web pages; it is not protection against malware running as the same user.
7. **Prices:** hand-entered from Anthropic's pricing page, stored as a dated table. Launch rows ($ per million tokens: input / output / cache write 5m / cache write 1h / cache read): Fable 5.2 8 / 40 / 10 / 16 / 0.20; Opus 5.5 4 / 20 / 5 / 8 / 0.20; Sonnet 5.5 2 / 10 / 2.50 / 4 / 0.10; Haiku 5.5 0.10 / 0.50 / 0.125 / 0.20 / 0.01, and 5× for Haiku 5.5 prompts over 100K tokens. Cache writes are priced by tier from `cache_creation.ephemeral_5m/1h`. Advisor iterations are priced by their own `model`. Fast-mode calls (`usage.speed: "fast"`) use that model's fast rate. Every user gets the same list-price estimate regardless of plan; the UI says "at API list prices".
8. **Backfill and gaps:** backfill runs on the first run of any entry point (session-end hook or `/spend`), records an "installed at" date, and shows progress in the app. A **coverage indicator** is in scope: the app knows which sessions it saw complete, which were indexed only partly, and transcript files that existed before install but were already gone. Gaps show on History and in the sidebar footer.
9. **Node:** require Node 22.13+ (or any later LTS), where `node:sqlite` needs no flag; check the version on first run and say clearly what to install. The repo ships built artifacts (server bundle and React build) so users need no build toolchain.
10. **Idle and concurrency:** only the indexer writes, guarded by a lock (the server's indexer or the hook's one-shot, never both at once; the hook skips its own pass if the server is running and simply pokes it). The status line reads SQLite directly, read-only, in WAL mode, and does not count as activity. Idle = no connected viewer for 30 minutes.


- Spike finding (Task 1, 2026-11-13): SessionStart/SessionEnd fire under `claude -p --plugin-dir`. A skill `!` injection is denied in -p mode without Bash permission; fix via `allowed-tools: Bash(node:*)` in the skill frontmatter (Task 10).
