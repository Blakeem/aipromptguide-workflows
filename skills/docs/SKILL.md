---
description: "Run the AIPG docs workflow, which copies the docs a project builds against verbatim from the web, repos or local files. It then scrubs the captured web pages and curates and indexes the set into a working folder. Use only when the user explicitly asks for the AIPG docs workflow."
argument-hint: "[which docs to gather + for what task]"
---

The user wants to run the **docs-cycle** dynamic workflow on the brief below.

First run `node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check`. The Workflow tool launches only
engines the session can read. On `missing`, unless the working directory is `${CLAUDE_PLUGIN_ROOT}` or a
folder above it, ask the user once whether to add the printed Read rule to their user settings. On yes,
run the command again with `grant` (settings reload live, no restart). On no, the user can run
`/add-dir ${CLAUDE_PLUGIN_ROOT}` for this session only.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/docs/CLAUDE.md` and follow it exactly.
Use these paths wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/docs/docs-cycle.mjs`
- `root` arg: `${CLAUDE_PLUGIN_DATA}`. Runs land in its `runs/<runId>/`. Never the plugin install dir,
  which is version-swapped on update.
- `outDir` is where the user wants the doc set, usually inside their project.

$ARGUMENTS
