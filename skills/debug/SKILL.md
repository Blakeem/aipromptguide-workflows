---
description: "Run the AIPG debug workflow: review a repo or change for production defects, then fix the triaged issue files with develop's fix mode. Use only when the user explicitly asks for the AIPG debug workflow."
argument-hint: "[repo/change to review, or inventory to fix]"
---

The user wants to run the **debug** dynamic workflow (review, then fix) on the task below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/debug/CLAUDE.md` and follow it exactly.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Review engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/debug/review.mjs`
- Fix engine `scriptPath` (develop in fix mode, guide `${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md`):
  `${CLAUDE_PLUGIN_ROOT}/workflows/develop/develop-cycle.mjs`
- develop's `blockTool` arg: `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`
- Args, status and triage tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/plan-edit.mjs`
- Unit slicer (plain Node, run directly): `${CLAUDE_PLUGIN_ROOT}/workflows/debug/gen-units.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`. Never the plugin install dir,
  which is version-swapped on update.

$ARGUMENTS
