---
description: "Run the AIPG decide workflow, which runs a bounded chain of investigators that find and improve the options, ranks the options in one weighted matrix and has a final reviewer verify the ranking. Use only when the user explicitly asks for the AIPG decide workflow."
argument-hint: "[decision question]"
---

The user wants to run the **decide-cycle** dynamic workflow on the decision below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.
When `plugin-access.mjs` exits 1, show the user its message, which names the cause, and run it again
once the cause is fixed.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/decide/CLAUDE.md` and follow it exactly.
Work its `## 0. Checklist` top to bottom.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/decide/decide-cycle.mjs`
- Launch tool (operator-side, the reserve command of the guide's §0 step 10):
  `${CLAUDE_PLUGIN_ROOT}/tools/launch.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`. Never the plugin install dir,
  which is version-swapped on update.

$ARGUMENTS
