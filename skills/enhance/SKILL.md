---
description: "Run the AIPG enhance workflow, which audits a working system read-only through lenses and returns verified proposals scored by impact for the user to triage. Nothing is applied. Use only when the user explicitly asks for the AIPG enhance workflow."
argument-hint: "[system to audit]"
---

The user wants to run the **enhance** dynamic workflow on the system below. It is the audit workflow's
enhancements kind.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.
When `plugin-access.mjs` exits 1, show the user its message, which names the cause, and run it again
once the cause is fixed.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/audit/CLAUDE.md` and follow it exactly, through its scope section
and its enhancements kind section.
Work the checklist's enhancements lists top to bottom.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/audit/audit.mjs`, launched with
  `kind: enhancements`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`. Never the plugin install dir,
  which is version-swapped on update.

$ARGUMENTS
