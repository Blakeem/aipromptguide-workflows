---
description: "Run the AIPG decide-cycle dynamic workflow — converge among approaches: lensed analysis, weighted matrix, a justified conclusion, adversarially reviewed. Use only when the user explicitly asks for the AIPG decide workflow."
argument-hint: "[decision question]"
---

The user wants to run the **decide-cycle** dynamic workflow on the decision below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/decide/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/decide/decide-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
