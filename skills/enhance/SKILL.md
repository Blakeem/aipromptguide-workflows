---
description: "Run the AIPG enhance-cycle dynamic workflow — read-only lensed audit of a working system producing verified, impact-scored proposals the user triages; nothing is auto-applied. Use only when the user explicitly asks for the AIPG enhance workflow."
argument-hint: "[system to audit]"
---

The user wants to run the **enhance-cycle** dynamic workflow on the system below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches an
engine only from a folder the session may read, and this plugin's folder is outside the project. On
`missing`, ask the user once whether to add the printed Read rule to their user settings. On a yes, run
the same command with `grant`. Settings reload live, so the launch needs no restart. On a no, the user
can run `/add-dir ${CLAUDE_PLUGIN_ROOT}`, which lasts for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/enhance/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/enhance/enhance-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
