# AI Prompt Guide — Workflows

**[aipromptguide.com](https://aipromptguide.com)** · A collection of production-grade **Claude Code
dynamic workflows**: the prompts and orchestration that *guide the AI* through real engineering work,
plus the shared design principles they're all built to.

Each workflow is a background **Workflow engine** (a `.mjs` script) paired with a `CLAUDE.md` operator
guide. The guide is the prompt: it drives **plan mode** and the human approval gate *outside* the engine,
then runs the engine to do the work. The **build** workflows leave the result test-verified, wired in,
and staged for you to commit. The **generative** ones leave cited files for you to use. Either way,
**nothing is ever committed for you**.

## The workflows

| Workflow | Trigger | Flow | Use it for |
|----------|---------|------|------------|
| **[feature](workflows/feature/)** | `/aipg-feature` | [map](workflows/feature/FLOW.md) | Build **one bounded feature** (new MCP tool, endpoint, page, form) from a plan you approve, or an ordered **roadmap** of them with one approved plan each. |
| **[debug](workflows/debug/)** | `/aipg-debug` | [review](workflows/debug/FLOW-review.md) · [resolve](workflows/debug/FLOW-resolve.md) | Find **production defects** in a repo or change → triaged issues → batched fixes. The fix loop also accepts an external inventory: findings from live/manual testing or bug reports. |
| **[migrate](workflows/migrate/)** | `/aipg-migrate` | [map](workflows/migrate/FLOW.md) | A **breadth-spanning migration/upgrade** decomposed into ordered, section-gated changes across many call sites. |
| **[enhance](workflows/enhance/)** | `/aipg-enhance` | [map](workflows/enhance/FLOW.md) | **Audit**: what a working system could do *better*. One lens per angle → verified, impact-scored proposals you triage. Nothing auto-applied. |
| **[brainstorm](workflows/brainstorm/)** | `/aipg-brainstorm` | [map](workflows/brainstorm/FLOW.md) | **Diverge**: one fully-committed variation per lens (designs, ideas) for you to pick or combine. No AI verdict. |
| **[decide](workflows/decide/)** | `/aipg-decide` | [map](workflows/decide/FLOW.md) | **Converge**: lensed analysis → a weighted decision matrix → a justified conclusion, adversarially reviewed. |
| **[investigate](workflows/investigate/)** | `/aipg-investigate` | [map](workflows/investigate/FLOW.md) | **Search**: find an answer that already exists and qualify it against fixed **pass/fail** criteria, until nothing qualifying is left unsearched. |
| **[docs](workflows/docs/)** | `/aipg-docs` | [map](workflows/docs/FLOW.md) | **Provision**: copy the docs a project needs **verbatim** (web/repo/files) → curate + index into a folder the LLM builds against. |

The first three are **build** workflows (code, reviewed and staged). The last five are
**generative/read-only**: proposals, creative options, a decision, a determination, or a curated doc set,
with no code and nothing staged or committed.

Two pairs are worth keeping straight. `debug` and `enhance`: something the system gets **wrong** is a
defect, which debug fixes; something it could do **better** is an enhancement, which enhance proposes and
you decide on. `decide` and `investigate`: when no established answer exists and the work is **weighing
trade-offs**, that's decide; when the answer is already out there and the work is **finding it and proving
it fits**, that's investigate. The tell is whether missing a requirement is a trade-off or simply
disqualifying.

All eight share the design rules in **[principles/](principles/)**:
the fourteen [Workflow Principles](principles/WORKFLOW-PRINCIPLES.md) (lean, file-bus, no busy-work
agents) and an [auditor agent](.claude/agents/workflow-principles-auditor.md) that reviews a workflow
against them.

**The Flow column is a diagram of what a run actually does** — every agent, gate, loop and terminal
state, rendered inline by GitHub. Read one before starting a run you have not done before: the terminal
states in particular are the part worth knowing in advance, since "ran out of rounds" and "proved there
is no answer" are different results that look alike in a summary.

Those maps are **generated, never hand-drawn**. `tools/gen-flows.mjs` runs each engine against scripted
agent replies and watches which agents it spawns, so a diagram can only ever show a path that really
runs. That makes it a linter as much as a picture: it fails `node tests/run.mjs` when a map goes stale,
when an engine grows a branch no scenario reaches, or when `meta.phases` stops matching the phases the
agents actually run under.

## Why it's built this way

The slash commands are **thin and stable**. They carry *no* workflow prompt, only a pointer to the
matching `workflows/<x>/CLAUDE.md`. That split is deliberate:

- **The prompt lives in the workflow, not the command.** Plan mode (and its approval gate) must run
  *outside* a background Workflow, so the `CLAUDE.md` guide, not the engine, drives it. Loading a
  workflow the ordinary way wouldn't include that prompt. Pointing at the `CLAUDE.md` does.
- **Copy the command once, pull to update.** Because the command never changes, you `git pull` this
  repo to get new and updated workflows, with no commands to re-copy.

```
You run /aipg-feature  →  Claude reads aipg/workflows/feature/CLAUDE.md  →  plan mode + your approval
                       →  runs feature-cycle.mjs by path  →  staged result you review & commit
```

## Install

1. **Clone into your project and gitignore it.** The trailing `aipg` names the folder so it matches the
   `/aipg-*` commands (recommended):

   ```bash
   git clone https://github.com/Blakeem/aipromptguide-workflows.git aipg
   echo "aipg/" >> .gitignore
   ```

   A plain `git clone …` (which lands in `aipromptguide-workflows/`) also works, since the commands
   auto-locate the checkout, but the `aipg` target keeps paths short and mirrors the command prefix.
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

4. **Run one.** For example: `/aipg-feature add a search_docs MCP tool. Plan it first.`

## One checkout, many projects

Every engine takes two separate paths, and they are deliberately **not** the same directory:

```
E:/myproject/          ← target.repo   the project itself, the folder holding .git
├── .git/
├── src/
└── aipg/              ← root          run-state lands at aipg/runs/<runId>/
    └── workflows/
```

- **`target.repo`** is the repo being worked on. Agents run `git -C <target.repo> …` against it, and it
  is the only place code is ever changed or staged.
- **`root`** is the base the run-state hangs off. `<root>/runs/<runId>/` holds the review files, the
  ledgers, and any parked patch. Normally the checkout's own folder, so nothing lands in your project.

Keeping them apart is what makes the blind review work: the issue files live outside the repo under
review, so a reviewer that is supposed to judge a diff on its own merits **cannot** wander into them.
Three engines warn if you point run-state inside the target repo.

It also means **one checkout can drive any number of projects**. Point `target.repo` at each in turn and
give each its own `runId`. The run-state stacks up beside the tool, so you can queue work across several
repos and still read every trail in one place:

```
aipg/runs/api-v2-migration/     ← target.repo E:/work/api
aipg/runs/dashboard-search/     ← target.repo E:/work/dashboard
```

You never type these yourself. Tell Claude which project you mean and it fills them in as pre-run setup.
There is no default for `target.repo` on the engines that write code, because guessing wrong would point
a build, or a park's `git checkout`, at the wrong repo. They fail loudly instead.

## Updating

```bash
cd aipg && git pull        # refreshes every workflow's CLAUDE.md + engine
```

You only re-copy a command if a brand-new workflow is added, which is rare by design.

## Changelog

What's changed, newest first. Only what you'd notice while running them.

### 2026-07-27

- **Every workflow now ships a flow map** — a `FLOW.md` beside each engine (linked in the table above)
  diagramming every agent, gate, loop and terminal state, rendered inline by GitHub. Worth a look before
  a run you haven't done before: the terminal states are where two very different outcomes read alike.
- **The maps are generated by watching each engine run**, not by reading its code, so a diagram can only
  show a path that really executes. The same machinery lints the engines — `node tests/run.mjs` goes red
  when a map is stale, when a branch no scenario covers appears, or when `meta.phases` stops matching
  what the agents actually run under.
- **New workflow: [investigate](workflows/investigate/)** (`/aipg-investigate`) — finds an answer that
  already exists and qualifies it against **pass/fail** criteria, stopping when the search can be
  *evidenced* as complete rather than when the first answer works. "Nothing qualifies" is a verified
  result, not a failure. Use `decide` when the work is weighing trade-offs instead.
- **`migrate` no longer tells you to resume into a red build.** A parked section that cleared the tree but
  left the build broken now halts as unsafe, matching `feature` and `debug`.
- **A dead plan critic no longer reports your plan sound.** In `feature` and `migrate`, a `refine` critic
  that died returned a clean verdict indistinguishable from a real one. It now throws.
- **A dead final sweep no longer reads as zero coverage gaps** in `migrate` — it reports the check as
  missing, and distinguishes a died sweep from one you legitimately skipped.
- **Documentation is called out as a poor fit** for `feature` and `migrate` plans: write it directly, then
  verify with a `debug` pass. Both guides also say to size a plan against a comparable artifact first.

### 2026-07-26

- **Work is never discarded.** A feature, section, or fix batch that can't pass is now **parked**: saved
  to `runs/<runId>/parked-<id>.patch`, cleared from the tree, with the `git apply` restore command
  written into `NEEDS-USER.md`. It used to be rolled back and lost.
- **A parked feature no longer stops the roadmap** — `feature-cycle` parks it and builds the next plan.
  `migrate-cycle` still stops, because its sections depend on each other.
- **New workflow: [enhance](workflows/enhance/)** (`/aipg-enhance`) — audits a working system for
  enhancements worth writing up, and stops for you to triage. Defects still belong in `debug`.
- **The build engines check your working tree first.** A dirty tree halts before any agent does work,
  naming the two commands that fix it, rather than reviewing your uncommitted changes as its own.
- **debug's review pass takes a lens *array*** — sweep the same code from several angles in one pass,
  merged into one issue file per unit. Replaces `reviewPasses`, which re-ran an identical prompt.
- **debug's review pass returns the issue index**, so there's no hand-grepping the issue files to build
  the fix loop's input. `gen-units.mjs --issues-dir` also tags units for cheap review resumes.
- **decide gains `selection: "ranked"`** — a ranked shortlist instead of one winner, when the answer is
  legitimately a portfolio.
- **docs spot-checks captured files against their source** and wants `outDir` pointed at a folder
  dedicated to that one doc set.
- **`target.repo` is now required** on every engine that writes code, instead of quietly defaulting to the
  checkout's own folder, so a typo can't retarget the wrong project (see *One checkout, many projects*).
- **A test suite** (`node tests/run.mjs`) that runs each engine against scripted agents in about a second,
  with no model calls. It's also the gate to point a workflow at when working on this repo.
- resolve's final sweep is gone, since it restated numbers the run already had. Plus assorted edge-case
  fixes across every engine.

### Earlier

- **2026-07-08** — debug's review pass got cheaper: units are bin-packed to ~2000 LOC (`--pack-loc`) and
  a verifier is spawned only where findings exist.
- **2026-07-07** — the research workflow became **docs**: verbatim capture, curated and indexed.
- **2026-07-04** — renamed `upgrade` → **migrate** and `review` → **debug**. `feature` gained the `plans`
  roadmap, so several approved features can be built in one run.
- **2026-07-01** — `decide` gained a `testbed` so claims get measured instead of asserted.

## Requirements

- **Claude Code** with the background **Workflow** capability.
- The target is a **git repository** (staging is how regressions are caught, and you do the commit).
- **Build and test commands** for your project. You provide them, and the engines run them and read
  pass/fail.
- For frontend work: optionally a browser/MCP driver (Chrome DevTools MCP, Playwright, MCP inspector),
  else a `curl`/manual fallback.

## Support

If these workflows save you time, you can sponsor their development via
[GitHub Sponsors](https://github.com/sponsors/Blakeem).

## License

[MIT](LICENSE) © Blakeem
