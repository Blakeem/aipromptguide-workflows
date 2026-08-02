---
description: "Run the AIPG feature-cycle dynamic workflow — build one bounded feature (new MCP tool, endpoint, page, form, contained enhancement, design-needing bugfix) or an ordered roadmap of them, plan-first and staged. Use only when the user explicitly asks for the AIPG feature workflow."
disable-model-invocation: "true"
argument-hint: "[feature or roadmap to build]"
---

The user wants to run the **feature-cycle** dynamic workflow on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/feature/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/feature/feature-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`, plan snapshots at `${CLAUDE_PLUGIN_DATA}/plans/<runId>/`.
  Never the plugin install dir itself — it is version-swapped on update.
- `blockTool` arg (pass it whenever the run uses a `plans` roadmap of blocks):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`

$ARGUMENTS
