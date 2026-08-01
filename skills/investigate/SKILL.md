---
description: "Run the AIPG investigate-cycle dynamic workflow — search: find an answer that already exists and qualify it against fixed pass/fail criteria, until nothing qualifying is left unsearched. Use only when the user explicitly asks for the AIPG investigate workflow."
argument-hint: "[question + pass/fail criteria]"
---

The user wants to run the **investigate-cycle** dynamic workflow on the question below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/investigate/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/investigate/investigate-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
