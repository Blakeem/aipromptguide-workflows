---
description: "Run the AIPG develop-cycle dynamic workflow — build the todo blocks of one approved plan-bus file (feature and section modes, staged per accepted block). Use only when the user explicitly asks for the AIPG develop workflow."
argument-hint: "[plan file or blocks to build]"
---

The user wants to run the **develop-cycle** dynamic workflow on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/develop/develop-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`, plan files at `${CLAUDE_PLUGIN_DATA}/plans/<runId>/`.
  Never the plugin install dir itself — it is version-swapped on update.
- `blockTool` arg (pass it always — the args derive from its `--list`):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`
- Status sync tool (operator-side, after the run):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-edit.mjs`

$ARGUMENTS
