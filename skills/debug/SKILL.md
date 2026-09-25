---
description: "Run the AIPG debug dynamic workflow — find production defects in a repo or change (triaged review), then fix the triaged issue files with the develop workflow's fix mode. Use only when the user explicitly asks for the AIPG debug workflow."
argument-hint: "[repo/change to review, or inventory to fix]"
---

The user wants to run the **debug** dynamic workflow (review, then fix) on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/debug/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Review engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/debug/review.mjs`
- Fix engine `scriptPath` (develop, fix mode; its guide is `${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md`):
  `${CLAUDE_PLUGIN_ROOT}/workflows/develop/develop-cycle.mjs`
- `blockTool` arg for develop: `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`
- Status sync and triage regrouping tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/plan-edit.mjs`
- Unit slicer (plain Node, run directly): `${CLAUDE_PLUGIN_ROOT}/workflows/debug/gen-units.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
