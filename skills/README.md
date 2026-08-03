# AIPG skills

Thin, **stable** skill entry points for [AI Prompt Guide workflows](../README.md), shipped by the
`aipg` plugin. Each carries no workflow prompt — it resolves the install's paths
(`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`) and points Claude at the workflow's `CLAUDE.md`,
where all the real instruction lives. Updating the plugin refreshes guides, engines and skills
together.

| Skill               | Workflow guide it loads              | Use for |
|---------------------|--------------------------------------|---------|
| `/aipg:feature`     | `workflows/feature/CLAUDE.md`        | One bounded feature (new tool/endpoint/page/form) — or an ordered roadmap of them. |
| `/aipg:debug`       | `workflows/debug/CLAUDE.md`          | Find production defects and/or fix a verified issue inventory (triage → batched fixes). |
| `/aipg:enhance`     | `workflows/enhance/CLAUDE.md`        | Audit a working system for enhancements (read-only) — proposals you triage; nothing is applied. |
| `/aipg:migrate`     | `workflows/migrate/CLAUDE.md`        | Breadth-spanning migration/upgrade across many call sites. |
| `/aipg:brainstorm`  | `workflows/brainstorm/CLAUDE.md`     | Diverge: one fully-committed variation per lens for a human to pick/combine. |
| `/aipg:decide`      | `workflows/decide/CLAUDE.md`         | Converge: lensed analysis → weighted matrix → a justified conclusion. |
| `/aipg:investigate` | `workflows/investigate/CLAUDE.md`    | Search: find an answer that already exists and qualify it against fixed pass/fail criteria. |
| `/aipg:docs`        | `workflows/docs/CLAUDE.md`           | Provision: copy the docs a project needs verbatim (web/repo/files) → curate + index. |

## Install

```
/plugin marketplace add Blakeem/aipromptguide-workflows
/plugin install aipg@aipromptguide
/reload-plugins
```

Then run one from any project — e.g. `/aipg:feature add a search_docs MCP tool. Plan it first.`
Claude reads the matching `workflows/<x>/CLAUDE.md` from the installed plugin and drives the workflow
(plan mode → approval → engine — or the autonomous path when you hand it a finished plan). All eight
skills are visible to Claude, so naming one in prose ("use the aipg migrate workflow on X") works
without the slash form; each description tells Claude to run it only when you explicitly ask. Note
`/debug` and `/docs` un-namespaced are Claude Code's own bundled skills — use the `/aipg:` forms.

Run-state never touches your project or the plugin install dir: runs land in the plugin's persistent
data dir (`~/.claude/plugins/data/aipg-aipromptguide/runs/<runId>/`; on Windows
`%USERPROFILE%\.claude\plugins\data\aipg-aipromptguide\`), plan snapshots in `plans/<runId>/` beside
them whenever the original plan sits somewhere a reviewer could reach. Uninstalling from your last
scope **deletes that directory** — run history, parked patches and all — unless you pass
`--keep-data`.

## Updating

`/plugin` → **Installed** → `aipg` → update; auto-update lives under **Marketplaces** (off by default
for third-party marketplaces). Guides, engines and skills move together, and every commit is a new
version — there is nothing to re-copy.

## Without the plugin (checkout mode)

A plain clone still works exactly as before — open the checkout, read the root `CLAUDE.md` router, and
drive a workflow by path with `root` = the checkout. The skills here are plugin components; they are
not loaded from a bare clone.
