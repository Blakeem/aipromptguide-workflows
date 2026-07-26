# AIPG slash commands

Thin, **stable** command templates for [AI Prompt Guide workflows](../README.md). You copy these into
your Claude Code commands folder **once**; they carry no workflow prompt, so they almost never change.
All the real instruction lives in each workflow's `CLAUDE.md`, which you refresh with a plain
`git pull` inside your `aipg/` checkout — no need to re-copy the commands.

| Command            | Workflow guide it loads                  | Use for |
|--------------------|------------------------------------------|---------|
| `/aipg-feature`    | `aipg/workflows/feature/CLAUDE.md`       | One bounded feature (new tool/endpoint/page/form). |
| `/aipg-debug`      | `aipg/workflows/debug/CLAUDE.md`         | Find production defects and/or fix a verified issue inventory (triage → batched fixes). |
| `/aipg-enhance`    | `aipg/workflows/enhance/CLAUDE.md`       | Audit a working system for enhancements (read-only) — proposals you triage; nothing is applied. |
| `/aipg-migrate`    | `aipg/workflows/migrate/CLAUDE.md`       | Breadth-spanning migration/upgrade across many call sites. |
| `/aipg-brainstorm` | `aipg/workflows/brainstorm/CLAUDE.md`    | Diverge: one fully-committed variation per lens for a human to pick/combine. |
| `/aipg-decide`     | `aipg/workflows/decide/CLAUDE.md`        | Converge: lensed analysis → weighted matrix → a justified conclusion. |
| `/aipg-docs`       | `aipg/workflows/docs/CLAUDE.md`          | Provision: copy the docs a project needs verbatim (web/repo/files) → curate + index. |

## Install (one time)

1. Clone the workflows repo into your project root. The trailing `aipg` names the folder so it matches
   the `/aipg-*` commands (recommended), then gitignore it:

   ```bash
   git clone https://github.com/Blakeem/aipromptguide-workflows.git aipg
   echo "aipg/" >> .gitignore
   ```

   A plain `git clone …` (folder `aipromptguide-workflows/`) also works — the commands auto-locate the
   checkout. (You can also clone once centrally and symlink `aipg` into each project.)

2. Copy these command files into your Claude Code commands folder:

   - **Per project:**  `.claude/commands/`  (scopes the commands to this repo)
   - **Global:**       `~/.claude/commands/` (available everywhere)

   ```bash
   cp aipg/commands/aipg-*.md ~/.claude/commands/
   ```

3. Run a command — e.g. `/aipg-feature add a search_docs MCP tool`. Claude reads the matching
   `aipg/workflows/<x>/CLAUDE.md` and drives the workflow (plan mode → approval → engine).

## Updating

```bash
cd aipg && git pull        # refreshes every workflow's CLAUDE.md + engine
```

You only re-copy a command if a **new** workflow is added or a command's path changes — which is rare
by design.

> The commands prefer `aipg/` in your project root but fall back to the default clone folder
> `aipromptguide-workflows/` (or wherever the checkout lives) automatically — so a bare clone works too.
> Pinning the folder to `aipg/` just keeps paths short and matching the command prefix.
