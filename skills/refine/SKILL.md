---
description: "Run the AIPG refine-cycle dynamic workflow — converge one approved plan file before develop builds from it: a read-only critic under a fixed defect bar and a minimal-fold editor alternate until one clean round. Use only when the user explicitly asks for the AIPG refine workflow."
argument-hint: "[plan file to converge]"
---

The user wants to run the **refine-cycle** dynamic workflow on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/refine/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/refine/refine-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — refine state lands at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>-refine/`, plan files at
  `${CLAUDE_PLUGIN_DATA}/plans/<runId>/`. Never the plugin install dir itself — it is
  version-swapped on update.
- `blockTool` arg (the editor's re-validation command):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`

$ARGUMENTS
