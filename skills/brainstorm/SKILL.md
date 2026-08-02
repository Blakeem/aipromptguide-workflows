---
description: "Run the AIPG brainstorm-cycle dynamic workflow — diverge: one fully-committed variation per lens for a human to pick or combine; creative, no AI verdict. Use only when the user explicitly asks for the AIPG brainstorm workflow."
argument-hint: "[topic + lenses]"
---

The user wants to run the **brainstorm-cycle** dynamic workflow on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/brainstorm/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/brainstorm/brainstorm-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
