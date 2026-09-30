---
description: "Run the AIPG docs-cycle dynamic workflow — provision the local doc set a project needs to build against: verbatim capture (web/repo/files), scrub, curate + index into a working folder. Use only when the user explicitly asks for the AIPG docs workflow."
argument-hint: "[which docs to gather + for what task]"
---

The user wants to run the **docs-cycle** dynamic workflow on the brief below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches an
engine only from a folder the session may read, and this plugin's folder is outside the project. On
`missing`, ask the user once whether to add the printed Read rule to their user settings. On a yes, run
the same command with `grant`. Settings reload live, so the launch needs no restart. On a no, the user
can run `/add-dir ${CLAUDE_PLUGIN_ROOT}`, which lasts for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/docs/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/docs/docs-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update. (`outDir` still goes where the user wants the doc set, usually inside their project.)

$ARGUMENTS
