---
description: "Run the AIPG migrate-cycle dynamic workflow — one plan driven across many call sites (migration, upgrade, port, refactor) in ordered, section-gated changes. Use only when the user explicitly asks for the AIPG migrate workflow."
disable-model-invocation: "true"
argument-hint: "[migration/upgrade goal]"
---

The user wants to run the **migrate-cycle** dynamic workflow on the task below.

Read `${CLAUDE_PLUGIN_ROOT}/workflows/migrate/CLAUDE.md` and follow it exactly. Resolved paths for
this install — use these wherever the guide says "this checkout" or "the tool's own directory":

- Engine `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/migrate/migrate-cycle.mjs`
- `root` arg (run-state base): `${CLAUDE_PLUGIN_DATA}` — runs land at
  `${CLAUDE_PLUGIN_DATA}/runs/<runId>/`, plan snapshots at `${CLAUDE_PLUGIN_DATA}/plans/<runId>/`.
  Never the plugin install dir itself — it is version-swapped on update.
- `blockTool` arg (pass it whenever the plan is sectioned via `planContext:'block'`):
  `${CLAUDE_PLUGIN_ROOT}/tools/plan-block.mjs`

$ARGUMENTS
