---
description: "Run the AIPG debug dynamic workflow — find production defects in a repo or change (triaged review), and/or fix a verified issue inventory in batches (resolve loop). Use only when the user explicitly asks for the AIPG debug workflow."
argument-hint: "[repo/change to review, or inventory to fix]"
---

The user wants to run the **debug** dynamic workflow (review and/or resolve) on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/debug/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Review engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/debug/review.mjs`
- Resolve engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/debug/resolve-cycle.mjs`
- Unit slicer (plain Node, run directly): `${CLAUDE_PLUGIN_ROOT}/workflows/debug/gen-units.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
