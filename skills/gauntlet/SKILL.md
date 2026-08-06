---
description: "Run the AIPG gauntlet-cycle dynamic workflow — build to a working MVP, then climb it toward an inspectable quality bar in critic-led waves (or point the climb at an existing product); flagship/AAA standard, user-set wave budget. Use only when the user explicitly asks for the AIPG gauntlet workflow."
argument-hint: "[what to build or refine, and the quality bar to climb toward]"
---

The user wants to run the **gauntlet-cycle** dynamic workflow on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/gauntlet/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/gauntlet/gauntlet-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`, run documents (CANON.md, BAR.md, COMPONENTS.md, ASPECTS.md)
  at `${CLAUDE_PLUGIN_DATA}/plans/<runId>/`. Never the plugin install dir itself — it is
  version-swapped on update.
- `blockTool` arg (pass it always — mvp builders are handed this command for their component blocks):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`

$ARGUMENTS
