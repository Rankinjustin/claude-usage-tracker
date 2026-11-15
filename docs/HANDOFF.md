# Handoff — where Token Tracker stands

Last updated 2026-11-15. Stage 1 (recording + core views) is built. Read this first when picking the project up again.

## State

- All 13 stage-1 tasks in `docs/stage1-plan.md` are built, each with its own review and fix round.
- A final whole-codebase review found 4 issues worth fixing, and all were fixed in `caa02a0`: split-response token undercount, a stale status line during a live session, coverage that counted normal transcript cleanup as loss, and status-line repair flipping between installs. Three small race fixes went in the same commit.
- **The scoped re-review of that last fix commit was stopped before it finished.** That review is the first thing to do (see Next steps).
- Tests: 162 passed, 1 skipped (a posix-only permission test, skipped on Windows). Typecheck is clean.
- A real-data check before the final fixes matched the Python prototype to 4 decimals. After the split-response fix, the tracker should report slightly *more* output and thinking than the prototype, because the prototype has the same first-record bug. Expect roughly 6% more output tokens and 10% more thinking tokens.
- Not yet done:
  - A real install into Claude Code. Everything so far ran through `claude -p --plugin-dir`.
  - A manual visual check of the dashboard against `docs/mockups/`.

## Getting it running on a new machine

```
git clone <this repo>
cd token-tracker
npm install          # dev dependencies only; the plugin has no runtime deps
npm test             # builds, then runs the suite
```

Try it without installing:

```
claude --plugin-dir /path/to/token-tracker
# then inside the session:
/token-tracker:spend
```

Install it for real:

```
claude plugin marketplace add /path/to/token-tracker   # or <github-user>/token-tracker
claude plugin install token-tracker@token-tracker
/token-tracker:setup                                    # optional status line
```

Data lives in `~/.claude/token-tracker/` (override with `TOKEN_TRACKER_HOME`). Always point `TOKEN_TRACKER_HOME` and `CLAUDE_CONFIG_DIR` at temp folders when experimenting, so your real history and settings aren't touched.

## Next steps

1. **Re-review `caa02a0`** (the final fix wave). Check four things:
   - **Repeat reads.** The split-response merge (keep the larger output/thinking, reprice) must stay idempotent when transcripts are read again.
   - **Cross-file merges.** It must also merge a message whose parts sit in different transcript files.
   - **Repricing.** It must reprice using the call's original timestamp.
   - **Migration v3.** It resets read offsets so existing transcripts are re-read once. Expect the first pass after upgrade to be slower.
2. Re-run the real-data check against your own transcripts, then do the manual visual check in light and dark mode at full width and at about 400px.
3. Install for real and live with it for a few days.
4. Stage 2 (deep detail):
   - the multi-lane timeline
   - the "what it was doing" phases
   - tool costs and time per tool and skill
   - the Tools and Models views
   - run and tool-call detail pages
   - baselines and flags
5. Stage 3 (extras):
   - History trends
   - Savings & alerts
   - AI review
   - the panel inside Claude Code (a native mod pane, not a web view)
   - export/import and a delete-all-data command

## Decisions made during the build (change any you disagree with)

- **Libraries.** React 19, Vite 8 and Vitest 5 were used instead of the plan's React 18. The spec only asks for React with TypeScript.
- **Model names** are stored in short form (`opus-5-5`) to match the price table. The `claude-` prefix is stripped when transcripts are read.
- **Auth.** The local server also accepts `Authorization: Bearer <key>`, which the session-end hook and the launcher use.
- **Backfill.** The first-run backfill always runs as its own background process. The server never waits on the write lock; it retries.
- **Status line repair.** The status line repairs its own entry in Claude Code settings, and only when the plugin path it points to no longer exists (for example after a plugin update).
- **Commands need Bash approval.** Both commands declare `allowed-tools: Bash(node:*)`. Without it, Claude Code blocks their shell step in `-p` mode.
- **Ranges and stats.**
  - "Month" means the last 30 days.
  - Percentages run 0 to 100.
  - The main thread is never flagged as an outlier.
  - Agent sparklines show the last 20 runs.
- **Coverage field names** follow the plan, with documented meanings. `filesMissingBeforeIndexed` counts transcripts that vanished with unread bytes.
- **Access key in the URL.** The keyed dashboard URL briefly appears on the browser-opener command line. That's accepted for a server that only listens on your own machine. A possible later hardening is a single-use key.
- **Tool permissions** are stored as the JSON text of Claude Code's permission decision.
- **Run detail.** Runs open inside their prompt, session or agent page. Stage 1 has no separate run page.

## Known small issues (reviewed, safe to leave for later)

- **Write lock.** A writer holding the lock for more than 10 minutes can lose it, because the lock has no heartbeat. That only costs a retry, never a double count; a real backfill took 10 seconds.
- **Status line speed.** It costs about 126 ms per refresh and will slow down as history grows. Precomputing medians would fix that.
- **Prices.** A malformed timestamp is silently treated as unpriced. The Haiku 100K boundary and the two-rows-per-model case are untested.
- **Run counts.** `stats.runs` and the agent detail's run list can differ by one around a day boundary.
- **Dashboard.**
  - The browser Back button and the in-app Back arrow can disagree.
  - Long bar charts have one tab stop per bar.
  - Small grey text is a little under AA contrast.
  - The overlay panel doesn't trap focus.
  - The custom date range resets when you switch views.
- **Masked search box.** It relies on a non-standard CSS property, so some browsers would show the typed text.
- **Housekeeping.** A failed settings write can leave a stray `.tt-*.tmp` file. Some tests leave temp folders behind.
- **Test gaps.** No end-to-end test covers the alert marker, the Esc handling, or the flagged-bar label.
