---
description: "Run the AIPG docs-cycle dynamic workflow — provision the local doc set a project needs to build against: verbatim capture (web/repo/files), scrub, curate + index into a working folder. Use only when the user explicitly asks for the AIPG docs workflow."
argument-hint: "[which docs to gather + for what task]"
---

The user wants to run the **docs-cycle** dynamic workflow on the brief below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/docs/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/docs/docs-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update. (`outDir` still goes where the user wants the doc set, usually inside their project.)

$ARGUMENTS
