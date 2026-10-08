---
description: "Run the AIPG brainstorm workflow, which writes one fully committed variation per lens for a human to pick or combine, with no AI verdict. Use only when the user explicitly asks for the AIPG brainstorm workflow."
argument-hint: "[topic + lenses]"
---

The user wants to run the **brainstorm-cycle** dynamic workflow on the task below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/brainstorm/CLAUDE.md` and follow it exactly.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/brainstorm/brainstorm-cycle.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`. Never the plugin install dir,
  which is version-swapped on update.

$ARGUMENTS
