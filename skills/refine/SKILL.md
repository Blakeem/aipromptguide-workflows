---
description: "Run the AIPG refine workflow, which converges a plan file before develop builds it. A read-only critic under a fixed defect bar and a minimal-fold editor alternate until one round is clean. Use only when the user explicitly asks for the AIPG refine workflow."
argument-hint: "[plan file to converge]"
---

The user wants to run the **refine-cycle** dynamic workflow on the task below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/refine/CLAUDE.md` and follow it exactly.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/refine/refine-cycle.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Refine state lands in its `runs/<runId>-refine/`, plan files in
  its `plans/<runId>/`. Never the plugin install dir, which is version-swapped on update.
- `blockTool` arg (the editor's re-validation command): `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`

$ARGUMENTS
