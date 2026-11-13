---
description: Set up the Token Tracker status line
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Current setup status:

!`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" setup --check`

Tell the user what the status above says. If a change is needed, ask the user
for permission first; only after they agree, run
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs" setup --apply`.
