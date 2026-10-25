---
description: "Run the AIPG develop workflow, which builds the todo blocks of approved plan files in feature, section and fix modes, then stages each accepted block. It also works the project's backlog with the user. Use only when the user explicitly asks for the AIPG develop workflow."
argument-hint: "[plan file or blocks to build, or 'work the backlog']"
---

The user wants to run the **develop-cycle** dynamic workflow on the task below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.

Next, before any step of the guide, settle the change policy. Run
`node "${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs" check --root "${CLAUDE_PLUGIN_DATA}" --repo <target.repo>`,
where `<target.repo>` is the repo the run works on. When the task does not name that repo, ask the user
for it, since the working directory may be another repo. Then follow
`${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md` §4 "Choosing the change policy" on its output.

Right after the change policy, settle commit mode. Run
`node "${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs" commit --root "${CLAUDE_PLUGIN_DATA}" --repo <target.repo>`
and follow the same guide's §4 "Choosing commit mode" on its output.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md` and follow it exactly.
When the task is to work the project's backlog, start at its §10 "Working the backlog".
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/develop/develop-cycle.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`, plan files in its
  `plans/<runId>/`. Never the plugin install dir, which is version-swapped on update.
- `blockTool` arg (always pass it): `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`
- Args tool (operator-side, before every launch, also applies finished runs' statuses):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-edit.mjs`
- Project-settings tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs`
- Attribution tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/attribution.mjs`

$ARGUMENTS
