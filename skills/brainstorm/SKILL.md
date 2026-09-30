---
description: "Run the AIPG brainstorm-cycle dynamic workflow — diverge: one fully-committed variation per lens for a human to pick or combine; creative, no AI verdict. Use only when the user explicitly asks for the AIPG brainstorm workflow."
argument-hint: "[topic + lenses]"
---

The user wants to run the **brainstorm-cycle** dynamic workflow on the task below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches an
engine only from a folder the session may read, and this plugin's folder is outside the project. On
`missing`, ask the user once whether to add the printed Read rule to their user settings. On a yes, run
the same command with `grant`. Settings reload live, so the launch needs no restart. On a no, the user
can run `/add-dir ${CLAUDE_PLUGIN_ROOT}`, which lasts for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/brainstorm/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/brainstorm/brainstorm-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`. Never the plugin install dir itself — it is version-swapped
  on update.

$ARGUMENTS
