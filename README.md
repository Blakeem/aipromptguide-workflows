# AI Prompt Guide — Workflows

**[aipromptguide.com](https://aipromptguide.com)** · A collection of production-grade **Claude Code
dynamic workflows** — the prompts and orchestration that *guide the AI* through real engineering work,
plus the shared design principles they're all built to.

Each workflow is a background **Workflow engine** (a `.mjs` script) paired with a `CLAUDE.md` operator
guide. The guide is the prompt: it drives **plan mode** and the human approval gate *outside* the engine,
then runs the engine to do the work. The **build** workflows leave the result test-verified, wired in,
and staged for you to commit; the **generative** ones leave cited files for you to use — either way
**nothing is ever committed for you**.

## The workflows

| Workflow | Trigger | Use it for |
|----------|---------|------------|
| **[feature](workflows/feature/)** | `/aipg-feature` | Build **one bounded feature** (new MCP tool, endpoint, page, form) — or an ordered **roadmap** of them, one approved plan each — from a plan you approve. |
| **[debug](workflows/debug/)** | `/aipg-debug` | Find **production defects** in a repo or change → triaged issues → batched fixes. The fix loop also accepts an external inventory — findings from live/manual testing or bug reports. |
| **[migrate](workflows/migrate/)** | `/aipg-migrate` | A **breadth-spanning migration/upgrade** decomposed into ordered, section-gated changes across many call sites. |
| **[brainstorm](workflows/brainstorm/)** | `/aipg-brainstorm` | **Diverge**: one fully-committed variation per lens (designs, ideas) for you to pick or combine — no AI verdict. |
| **[decide](workflows/decide/)** | `/aipg-decide` | **Converge**: lensed analysis → a weighted decision matrix → a justified conclusion, adversarially reviewed. |
| **[research](workflows/research/)** | `/aipg-research` | **Inform**: gather across sources (web/repo/api/docs) → verify each claim → a cited report, spec, or assessment. |

The first three are **build** workflows (code, reviewed and staged); the last three are
**generative/read-only** (creative options, a decision, or cited research — no code, nothing staged or
committed). All six share the design rules in **[principles/](principles/)** — the fourteen
[Workflow Principles](principles/WORKFLOW-PRINCIPLES.md) (lean, file-bus, no busy-work agents) and an
[auditor agent](.claude/agents/workflow-principles-auditor.md) that reviews a workflow against them.

## Why it's built this way

The slash commands are **thin and stable** — they carry *no* workflow prompt, only a pointer to the
matching `workflows/<x>/CLAUDE.md`. That split is deliberate:

- **The prompt lives in the workflow, not the command.** Plan mode (and its approval gate) must run
  *outside* a background Workflow, so the `CLAUDE.md` guide — not the engine — drives it. Loading a
  workflow the ordinary way wouldn't include that prompt; pointing at the `CLAUDE.md` does.
- **Copy the command once; pull to update.** Because the command never changes, you `git pull` this
  repo to get new/updated workflows — no re-copying commands.

```
You run /aipg-feature  →  Claude reads aipg/workflows/feature/CLAUDE.md  →  plan mode + your approval
                       →  runs feature-cycle.mjs by path  →  staged result you review & commit
```

## Install

1. **Clone into your project and gitignore it.** The trailing `aipg` names the folder so it matches the
   `/aipg-*` commands — recommended:

   ```bash
   git clone https://github.com/Blakeem/aipromptguide-workflows.git aipg
   echo "aipg/" >> .gitignore
   ```

   A plain `git clone …` (which lands in `aipromptguide-workflows/`) also works — the commands
   auto-locate the checkout — but the `aipg` target keeps paths short and mirrors the command prefix.
   (Or clone once centrally and symlink `aipg` into each project.)

2. **Copy the slash commands** into your Claude Code commands folder (per-project `.claude/commands/`
   or global `~/.claude/commands/`):

   ```bash
   cp aipg/commands/aipg-*.md ~/.claude/commands/
   ```

   See **[commands/](commands/)** for details.

3. **(Optional) Install the auditor agent** if you author/modify workflows:

   ```bash
   cp aipg/.claude/agents/workflow-principles-auditor.md ~/.claude/agents/
   ```

4. **Run one** — e.g. `/aipg-feature add a search_docs MCP tool. Plan it first.`

## Updating

```bash
cd aipg && git pull        # refreshes every workflow's CLAUDE.md + engine
```

You only re-copy a command if a brand-new workflow is added — rare by design.

## Requirements

- **Claude Code** with the background **Workflow** capability.
- The target is a **git repository** (staging is how regressions are caught; you do the commit).
- **Build and test commands** for your project — you provide them; the engines run them and read
  pass/fail.
- For frontend work: optionally a browser/MCP driver (Chrome DevTools MCP, Playwright, MCP inspector),
  else a `curl`/manual fallback.

## Support

If these workflows save you time, you can sponsor their development via
[GitHub Sponsors](https://github.com/sponsors/Blakeem).

## License

[MIT](LICENSE) © Blakeem
