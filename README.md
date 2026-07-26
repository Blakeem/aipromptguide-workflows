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
| **[enhance](workflows/enhance/)** | `/aipg-enhance` | **Audit**: what a working system could do *better* — one lens per angle → verified, impact-scored proposals you triage. Nothing auto-applied. |
| **[brainstorm](workflows/brainstorm/)** | `/aipg-brainstorm` | **Diverge**: one fully-committed variation per lens (designs, ideas) for you to pick or combine — no AI verdict. |
| **[decide](workflows/decide/)** | `/aipg-decide` | **Converge**: lensed analysis → a weighted decision matrix → a justified conclusion, adversarially reviewed. |
| **[docs](workflows/docs/)** | `/aipg-docs` | **Provision**: copy the docs a project needs **verbatim** (web/repo/files) → curate + index into a folder the LLM builds against. |

The first three are **build** workflows (code, reviewed and staged); the last four are
**generative/read-only** (proposals, creative options, a decision, or a curated doc set — no code,
nothing staged or committed). `debug` and `enhance` are the pair to keep straight: something the system
gets **wrong** is a defect (debug fixes it), something it could do **better** is an enhancement (enhance
proposes it, you decide). All seven share the design rules in **[principles/](principles/)** — the fourteen
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

## One checkout, many projects

Every engine takes two separate paths, and they are deliberately **not** the same directory:

```
E:/myproject/          ← target.repo   the project itself — the folder holding .git
├── .git/
├── src/
└── aipg/              ← root          run-state lands at aipg/runs/<runId>/
    └── workflows/
```

- **`target.repo`** is the repo being worked on. Agents run `git -C <target.repo> …` against it, and it
  is the only place code is ever changed or staged.
- **`root`** is the base the run-state hangs off — `<root>/runs/<runId>/` holds the review files, the
  ledgers, and any parked patch. Normally the checkout's own folder, so nothing lands in your project.

Keeping them apart is what makes the blind review work: the issue files live outside the repo under
review, so a reviewer that is supposed to judge a diff on its own merits **cannot** wander into them.
Three engines warn if you point run-state inside the target repo.

It also means **one checkout can drive any number of projects** — point `target.repo` at each in turn
and give each its own `runId`. The run-state stacks up beside the tool, so you can queue work across
several repos and still read every trail in one place:

```
aipg/runs/api-v2-migration/     ← target.repo E:/work/api
aipg/runs/dashboard-search/     ← target.repo E:/work/dashboard
```

You never type these yourself — tell Claude which project you mean and it fills them in as pre-run
setup. There is no default for `target.repo` on the engines that write code: guessing wrong would point
a build, or a park's `git checkout`, at the wrong repo, so they fail loudly instead.

## Updating

```bash
cd aipg && git pull        # refreshes every workflow's CLAUDE.md + engine
```

You only re-copy a command if a brand-new workflow is added — rare by design.

## Changelog

What's changed, newest first — only what you'd notice while running them.

### 2026-07-26

- **Work is never discarded.** A feature, section, or fix batch that can't pass is now **parked**: saved
  to `runs/<runId>/parked-<id>.patch`, cleared from the tree, with the `git apply` restore command
  written into `NEEDS-USER.md`. It used to be rolled back and lost.
- **A parked feature no longer stops the roadmap** — `feature-cycle` parks it and builds the next plan.
  `migrate-cycle` still stops, because its sections depend on each other.
- **New workflow: [enhance](workflows/enhance/)** (`/aipg-enhance`) — audits a working system for
  enhancements worth writing up, and stops for you to triage. Defects still belong in `debug`.
- **The build engines check your working tree first.** A dirty tree halts before any agent does work,
  naming the two commands that fix it — instead of reviewing your uncommitted changes as its own.
- **debug's review pass takes a lens *array*** — sweep the same code from several angles in one pass,
  merged into one issue file per unit. Replaces `reviewPasses`, which re-ran an identical prompt.
- **debug's review pass returns the issue index**, so there's no hand-grepping the issue files to build
  the fix loop's input. `gen-units.mjs --issues-dir` also tags units new/changed/unchanged for cheap
  review resumes.
- **decide gains `selection: "ranked"`** — a ranked shortlist instead of one winner, when the answer is
  legitimately a portfolio.
- **docs spot-checks captured files against their source** and wants `outDir` pointed at a folder
  dedicated to that one doc set.
- **`target.repo` is now required** on every engine that writes code, instead of quietly defaulting to
  the checkout's own folder. Pointing one checkout at several projects has always worked — it's now
  documented (see *One checkout, many projects*) and can't silently target the wrong one.
- **A test suite** (`node tests/run.mjs`) that runs each engine against scripted agents — no model calls,
  runs in a second. It's also the build/test gate to point a workflow at when working on this repo.
- resolve's final sweep is gone (it restated numbers the run already had); migrate keeps its sweep, which
  re-greps the change surface. Plus assorted edge-case fixes across every engine.

### Earlier

- **2026-07-08** — debug's review pass got cheaper: units are bin-packed to ~2000 LOC (`--pack-loc`) and
  a verifier is spawned only where findings exist.
- **2026-07-07** — the research workflow became **docs**: verbatim capture, curated and indexed.
- **2026-07-04** — renamed `upgrade` → **migrate** and `review` → **debug**; `feature` gained the `plans`
  roadmap (several approved features in one run).
- **2026-07-01** — `decide` gained a `testbed` so claims get measured instead of asserted.

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
