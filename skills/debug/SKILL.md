---
description: "Run the AIPG debug workflow, which reviews a repo or change for production defects and then fixes the triaged issue files with develop's fix mode. Use only when the user explicitly asks for the AIPG debug workflow."
argument-hint: "[repo/change to review, or inventory to fix]"
---

The user wants to run the **debug** dynamic workflow (review, then fix) on the task below.

First, before any step of the guide, run the setup check
`node "${CLAUDE_PLUGIN_ROOT}/tools/onboard.mjs" check --root "${CLAUDE_PLUGIN_DATA}" --repo <target.repo>`,
where `<target.repo>` is the repo the run works on. When the task does not name that repo, ask the user
for it, since the working directory may be another repo. On `ready`, go on. On `ask`, ask the questions
it prints in one AskUserQuestion call and run the save command it prints with the answers. The save
prints `ready` once nothing is missing. When either command exits 1, show the user its message, which
names the cause, and run it again once the cause is fixed. The Workflow tool launches only engines the
session can read, which is what the access question settles.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/debug/CLAUDE.md` and follow it exactly.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Review engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/debug/review.mjs`
- Fix engine `scriptPath` (develop in fix mode, guide `${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md`):
  `${CLAUDE_PLUGIN_ROOT}/workflows/develop/develop-cycle.mjs`
- develop's `blockTool` arg: `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`
- Args, status and triage tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/plan-edit.mjs`
- Onboarding tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/onboard.mjs`
- Project-settings tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs`
- Worktree tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/wt.mjs`
- Unit slicer (plain Node, run directly): `${CLAUDE_PLUGIN_ROOT}/workflows/debug/gen-units.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`. Never the plugin install dir,
  which is version-swapped on update.

$ARGUMENTS
