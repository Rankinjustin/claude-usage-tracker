# Token Tracker

A Claude Code plugin that records your token spend and shows it in a live local dashboard.

Every day Claude Code runs, it writes transcripts. It deletes old ones. Token Tracker copies the numbers into its own database, so your history stays.

## Install

Requires Node 22.13 or newer.

From GitHub:

```
claude plugin marketplace add <owner>/token-tracker
claude plugin install token-tracker@token-tracker
```

From a local clone:

```
claude plugin marketplace add /path/to/token-tracker
claude plugin install token-tracker@token-tracker
```

The first session after install backfills your existing transcripts in the background.

## Use it

- `/token-tracker:spend` starts the dashboard if needed and opens it in your browser.
- `/token-tracker:setup` adds a status line that shows today's spend. It asks before changing your settings.

The dashboard has Overview, Sessions, Prompts, and Agents & skills views. Click any tile or row to open its detail on the right. A switch on the page hides prompt text for screenshots. The coverage indicator shows the date recording began.

A session-end hook records each session, even if you never open the dashboard.

## What is recorded, and where

Everything lives in `~/.claude/token-tracker/`. Set `TOKEN_TRACKER_HOME` to use another folder.

Recorded per session: model usage per call, token counts by type, estimated cost, tool calls, agent and skill runs, file paths, and the **full text of your prompts**. None of it leaves your machine.

## Privacy and security

- The server listens on loopback only. Every request needs the access key.
- The plugin only reads `~/.claude/projects`. It writes only to its own data folder.
- The app makes no outbound network calls. Fonts and scripts are bundled.
- Costs are estimates at API list prices. They are not your bill. A subscription plan is billed differently.
- Models with no known price are shown as unpriced, not guessed.

## Uninstall

```
claude plugin uninstall token-tracker
```

This keeps `~/.claude/token-tracker/` so your history survives. Delete that folder by hand to remove it. A delete command is planned.

## Roadmap

- Stage 1 (this release): recording, backfill, status line, Overview, Sessions, Prompts, Agents & skills.
- Stage 2: run timelines, tool cost detail, Tools and Models views, flags for expensive runs.
- Stage 3: History trends, savings findings, optional AI review, panel inside Claude Code, export, delete-all-data.

## License

MIT
