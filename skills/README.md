# AIPG skills

Thin, **stable** skill entry points for [AI Prompt Guide workflows](../README.md), shipped by the
`aipg` plugin. Each carries no workflow prompt. It resolves the install's paths
(`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`) and points Claude at the workflow's `CLAUDE.md`,
where all the real instruction lives. Updating the plugin refreshes guides, engines and skills
together.

| Skill               | Workflow guide it loads              | Use for |
|---------------------|--------------------------------------|---------|
| `/aipg:develop`     | `workflows/develop/CLAUDE.md`        | Build the todo blocks of one approved plan file. Each block's mode is `feature`, `section` or `fix`. |
| `/aipg:refine`      | `workflows/refine/CLAUDE.md`         | Converge a plan file before develop builds it: a read-only critic and a minimal-fold editor. |
| `/aipg:debug`       | `workflows/debug/CLAUDE.md`          | Find production defects. Its triaged issue files are fix-mode plan files develop builds. |
| `/aipg:enhance`     | `workflows/enhance/CLAUDE.md`        | Audit a working system for enhancements (read-only). You triage its proposals, and nothing is applied. |
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

Then run one from any project, for example `/aipg:develop add a search_docs MCP tool. Plan it first.`
Claude reads the matching `workflows/<x>/CLAUDE.md` from the installed plugin and drives the workflow
(for a build, plan mode, then refine, then your approval, then develop). All eight
skills are visible to Claude, so naming one in prose ("use the aipg develop workflow on X") works
without the slash form. Each description tells Claude to run it only when you explicitly ask. Note
`/debug` and `/docs` un-namespaced are Claude Code's own bundled skills, so use the `/aipg:` forms.

Run-state never touches your project or the plugin install dir. Runs land in the plugin's persistent
data dir (`~/.claude/plugins/data/aipg-aipromptguide/runs/<runId>/`, or on Windows
`%USERPROFILE%\.claude\plugins\data\aipg-aipromptguide\`). Plan files are authored in `plans/<runId>/`
beside them, outside your project. The engines only warn when a plan sits inside the target repo, and
do not move it. Unless you pass `--keep-data`, uninstalling from your last scope **deletes that
directory** with everything in it, including run history and parked patches.

## Updating

`/plugin` → **Installed** → `aipg` → update. Auto-update lives under **Marketplaces** (off by default
for third-party marketplaces). Guides, engines and skills move together. Every commit is a new version,
so there is nothing to re-copy.

## Without the plugin (checkout mode)

A plain clone still works as before. Open the checkout, read the root `CLAUDE.md` router, and drive a
workflow by path with `root` = the checkout. The skills here are plugin components, so they are not
loaded from a bare clone.
