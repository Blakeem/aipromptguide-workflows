# feature-cycle

An autonomous Claude Code workflow that builds **ONE bounded feature** — or an ordered **roadmap** of
several, one approved plan each — test-verified, wired in, and staged for you to commit.

You ask for a feature. Claude writes a short plan, you approve it, an independent critic checks that
plan against your real code, then a **develop → review → acceptance** loop builds it and stages the
result. You commit. Building a roadmap? Plan and approve each feature up front, then one run builds them
in order, **staging each accepted feature** before starting the next.

### What sets it apart

This is a deliberately **lean** workflow. A default Claude workflow tends to spawn an agent for every
step; this one engineers those away and follows a strict set of principles:

- **No busy-work agents.** Setup (clean tree, config, the plan) happens up front. No agent is spawned
  for a job another agent or the main session can already do.
- **The plan travels verbatim.** Every agent reads the approved plan byte-for-byte from its file.
  Nothing is parsed into fields and rebuilt, so nothing about your spec is lost or reinterpreted.
- **The harness only routes.** The script passes control signals (a path, a round number, a verdict),
  never paraphrased content.
- **Blind, then plan-aware review.** A blind critic judges the code with no plan or goal (so it can't
  rubber-stamp "matches the plan"), then a plan-aware gate confirms completeness and no regression.
- **One staging, never a commit.** Git staging is the boundary; only the final gate stages, only on
  pass. You always do the commit.
- **Nothing is thrown away, and the tree is left clean.** A feature that still can't pass isn't
  abandoned half-done in your working tree: its work is saved to a patch file, cleared out, and the run
  tells you where the patch is and the exact command to restore it. The rest of the roadmap continues on
  a clean slate.

---

## Scope: is this the right tool?

The workflow has real overhead (plan mode, a plan review, a multi-round build loop). It pays off only
for a feature **big enough to deserve a written plan**:

- ✅ **Right size:** one bounded feature added to an existing codebase. A new MCP tool, API endpoint,
  page, form, or a similarly-scoped enhancement or design-needing bugfix.
- ❌ **Too small** (a one-line change, a rename, a config flip): skip the workflow and just make the
  edit. If it's too small to review a plan for, it's too small for this.
- ❌ **Too big for one feature:** split it into a **roadmap** of bounded plans and build them in one run
  (the `plans` array), approving each. A single goal that is a *pattern across many call sites* (a
  migration, version upgrade, framework port, or broad refactor) → the sibling
  [`migrate-cycle`](../migrate/) instead.

---

## How to use it

This workflow ships in the [AI Prompt Guide workflows](../../README.md) repo. Install once — clone it
into your project as `aipg/`, gitignore it, and copy the slash commands (see the
[root README](../../README.md)) — then trigger it two ways:

- **Slash command:** `/aipg-feature add a search_docs MCP tool to this server. Plan it first.`
- **Plain pointer:** tell Claude to *use the feature-cycle **workflow** in `aipg/workflows/feature/`*
  and what to build.

Either way Claude reads `aipg/workflows/feature/CLAUDE.md`, drives plan mode + your approval, then runs
`feature-cycle.mjs` **by path** (the engine is in no global registry, so the folder pointer is how it's
discovered; nothing to build). Optional: drop `feature-cycle.mjs` into a `~/.claude/workflows/`
directory to invoke it by name instead.

From there Claude drives everything:

1. **Plans it.** Enters plan mode, explores your repo, asks you the decisions that matter (acceptance
   criteria, how to test it), writes the plan, and presents it for your approval.
2. **Reviews the plan.** An independent critic greps your real repo, confirms the plan's files and
   wiring points, and returns any gaps. Claude folds them in, asking you about anything blocking.
3. **Builds it.** The develop → review → acceptance loop runs unattended until each feature is done,
   parked, or needs a call only you can make, and stages what passed.

A workflow runs in the background and **can't ask you questions mid-run**, so Claude settles anything
needing a human answer while planning, before the build.

---

## The agents

Each is a fresh, throwaway context that does one job and returns one decision:

- **Plan critic** (plan review): adversarial and read-only. Greps your repo, verifies the plan's file
  list and integration points, returns gaps and blocking questions. Writes nothing.
- **Developer** (build loop): implements the plan, **wires the feature in** so it's reachable,
  writes/runs tests, runs your build + test gate to green, and leaves the work **unstaged**. Owns the
  call on every review finding: fixes what's real, logs what it declines (with a reason to
  `DISMISSED-<id>.md`), escalates only a decision you must make.
- **Quality reviewer** (build loop): a **blind** code critic. Given no plan, spec, or goal, it reviews
  **only the unstaged diff** for production-blocking defects. Must be clean before acceptance runs.
- **Acceptance verifier** (build loop): the **plan-aware** final gate. Checks every acceptance
  criterion, that the feature is reachable, that the gates are green, and that nothing regressed. On
  pass it stages the feature, and it's the only agent that stages.
- **Park** (only when a feature can't pass): saves that feature's work to a patch file under
  `runs/<runId>/`, clears it out of your tree, confirms the build is green again, and records the
  restore command for you. It never touches work that was already accepted and staged.

The loop is **develop → quality → acceptance**, repeated each round until acceptance passes. Any code
change re-enters at the blind review. A reviewer can contest a wrongly-declined finding, so the loop
converges without burying a real defect. If a feature still can't pass, it's parked — saved to a patch,
cleared from the tree — and the next feature in the roadmap starts clean. If the verifier ever stages a
feature while also reporting that something regressed — a verdict that contradicts itself — the run
stops there, so you can look at the staged diff before anything else is built on top of it.

---

## Reviewing the result

Nothing is committed; everything is staged in your repo. Review it like a PR:

```bash
cd /path/to/repo
git diff --cached            # everything staged
<your build + test command>  # confirm green yourself
```

The run leaves a transparent trail under `runs/<runId>/`:

- `acceptance-review-<id>-rN.md`: the final, plan-aware verdict per feature (per-criterion table,
  reachability, regression, gate result). Read the latest before committing.
- `quality-review-<id>-rN.md`: what the blind critic found each round.
- `DISMISSED-<id>.md`: every finding the developer declined, one line each with a reason. **Audit this.**
- `NEEDS-USER.md`: anything flagged for you — why a run stopped, and an entry per parked feature with
  its diagnosis and its restore command.
- `parked-<id>.patch`: a parked feature's saved work, restored with the `git apply --3way` command
  `NEEDS-USER.md` spells out (it carries the full path). If the feature also created files git wasn't
  tracking, they're in `parked-<id>-newfiles/` and you copy those back separately.

Confirm the feature is reachable yourself (grep the integration point) and that the existing suite
still passes, then commit. Anything parked is yours to decide on: restore the patch and finish it by
hand, re-run that one plan after sharpening it, or drop the patch.

---

## Requirements

- **Claude Code** with the Workflow capability.
- The target is a **git repository** (staging is how regressions are caught).
- A **clean working tree** at the start. The run reviews everything unstaged as its own work, so it
  checks first and stops immediately if you have uncommitted changes lying around — stage or stash them
  before kicking off.
- Commands to **build and test** your project locally. You provide them; the workflow runs them and
  reads pass/fail.
- For frontend features: optionally a browser driver (Chrome DevTools MCP, Playwright) or MCP
  inspector connected in your session, otherwise it falls back to `curl` or manual verification.
