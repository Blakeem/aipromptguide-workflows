---
description: "Run the AIPG develop-cycle dynamic workflow — build the todo blocks of one approved plan-bus file (feature, section and fix modes, staged per accepted block). Use only when the user explicitly asks for the AIPG develop workflow."
argument-hint: "[plan file or blocks to build]"
---

The user wants to run the **develop-cycle** dynamic workflow on the task below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches an
engine only from a folder the session may read, and this plugin's folder is outside the project. On
`missing`, ask the user once whether to add the printed Read rule to their user settings. On a yes, run
the same command with `grant`. Settings reload live, so the launch needs no restart. On a no, the user
can run `/add-dir ${CLAUDE_PLUGIN_ROOT}`, which lasts for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/develop/develop-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`, plan files at `${CLAUDE_PLUGIN_DATA}/plans/<runId>/`.
  Never the plugin install dir itself — it is version-swapped on update.
- `blockTool` arg (pass it always):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`
- Args tool (operator-side, before every launch, it also applies finished runs' statuses):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-edit.mjs`

$ARGUMENTS
