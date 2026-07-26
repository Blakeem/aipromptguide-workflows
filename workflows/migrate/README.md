# migrate-cycle

An autonomous Claude Code workflow that drives **ONE breadth-spanning goal** to a production-ready,
tested, staged state across your repo: a migration, a version upgrade, a framework port, or a subsystem
refactor.

You describe the goal. In plan mode, Claude breaks it into **ordered sections** (each a bounded change),
you approve the plan, an independent critic checks it against your real code, then a **develop → review →
acceptance** loop builds each section and stages it. The accepted baseline advances section by section.
You commit.

### What sets it apart

This is a deliberately **lean** workflow. A default Claude workflow tends to spawn an agent for every
step; this one engineers those away and follows a strict set of principles:

- **No busy-work agents.** Decomposition and approval happen up front in plan mode. No agent is spawned
  for a job another agent or the main session can already do.
- **The plan travels verbatim.** Every agent reads the approved plan byte-for-byte from its file. The
  harness routes only a section id and a round number, never paraphrased content, so nothing about your
  plan is lost or reinterpreted.
- **Blind, then plan-aware review.** A blind critic judges the code with no plan or goal (so it cannot
  rubber-stamp "matches the plan"), then a plan-aware gate confirms the section's criteria, reachability,
  and no regression.
- **Staging advances section by section, never a commit.** Each accepted section is staged, which is how
  the next section's diff stays clean and regressions show up. Only the acceptance gate stages, only on
  pass. You always do the commit.
- **Nothing is thrown away, and the tree is left clean.** A section that still can't pass isn't
  abandoned half-done in your working tree: its work is saved to a patch file, cleared out, and the run
  tells you where the patch is and the exact command to restore it.
- **No progress file.** Git staging plus the numbered review files are the durable record, so a stopped
  run resumes from the repo itself.

---

## Scope: is this the right tool?

This workflow carries real overhead (plan mode, a plan review, a per-section build loop). It pays off
for a goal big enough that it must be **decomposed into sections**:

- ✅ **Right size:** one coherent goal spanning many files. Migrate a data model, upgrade a language or
  runtime version, port a framework, refactor a subsystem. Each section is itself roughly a feature.
- ❌ **One bounded feature** (a single MCP tool, endpoint, or form): use the sibling
  [`feature-cycle`](../feature/). A one-line change or a
  rename: just make the edit.
- ❌ **Several unrelated features:** run `feature-cycle` once per feature instead.

---

## How to use it

This workflow ships in the [AI Prompt Guide workflows](../../README.md) repo. Install once — clone it
into your project as `aipg/`, gitignore it, and copy the slash commands (see the
[root README](../../README.md)) — then trigger it two ways:

- **Slash command:** `/aipg-migrate` — then *"migrate the data model in this repo; build is
  `<your build command>`, tests are `<your test command>`; plan it first so I can review the
  breakdown."*
- **Plain pointer:** tell Claude to *use the migrate-cycle **workflow** in `aipg/workflows/migrate/`*,
  describe the goal, and give your build and test commands.

Either way Claude reads `aipg/workflows/migrate/CLAUDE.md`, drives plan mode + your approval, then runs
`migrate-cycle.mjs` **by path** — the engine is in no global registry, so the folder pointer is how it's
discovered; nothing to build.

From there Claude drives everything:

1. **Plans it.** Enters plan mode, greps the whole change surface, asks you the decisions that matter,
   writes the plan as ordered sections, and presents it for your approval.
2. **Reviews the plan.** An independent critic re-greps your real repo, verifies every section and its
   wiring points and ordering, and returns any gaps. Claude folds them in, asking you about anything
   blocking.
3. **Runs it.** The develop → review → acceptance loop runs each section unattended, staging it on
   acceptance and moving to the next. A whole-goal sweep checks coverage at the end.

A workflow runs in the background and **cannot ask you questions mid-run**, so Claude settles anything
needing a human answer while planning, before the run. Tip: have it run just the **first section** first
(a `runOnly` slice) to sanity-check cost and quality before letting the rest go.

---

## The agents

Each is a fresh, throwaway context that does one job and returns one decision:

- **Plan critic** (plan review): adversarial and read-only. Re-greps the whole surface, verifies every
  section's files, integration points, and ordering, returns gaps and blocking questions. Writes nothing.
- **Developer** (run loop): implements one section, **converts every call site it owns** so the change is
  reachable, runs your build and test gate, and leaves the work **unstaged**. Owns the call on every
  review finding: fixes what is real, logs what it declines (with a reason to `DISMISSED-<id>.md`),
  escalates only a decision you must make.
- **Quality reviewer** (run loop): a **blind** code critic. Given no plan or goal, it reviews **only the
  unstaged diff** for production-blocking defects. Must be clean before acceptance runs.
- **Acceptance verifier** (run loop): the **plan-aware** section gate. Checks every acceptance criterion,
  that the section is reachable, that its gate is met, and that nothing regressed against the staged
  baseline. On pass it stages the section, and it is the only agent that stages.
- **Park** (only when a section can't pass): saves that section's work to a patch file under
  `runs/<runId>/`, clears it out of your tree, confirms the build is green again, and records the restore
  command for you. It never touches work that was already accepted and staged.
- **Sweep** (after the last section): an independent whole-goal check. Re-greps the surface, runs the full
  gates, spot-checks the staged diff, and writes `SWEEP.md`.

The loop is **develop → quality → acceptance**, repeated each round until acceptance passes. Any code
change re-enters at the blind review. A section that does not accept is **parked** and the run stops
there — its work is saved to a patch and cleared from your tree, so the repo is left clean and buildable
rather than half-changed. The run stops because the sections are ordered: the ones after it were waiting
on this one to land. You resolve it and resume from that section; nothing is lost. The run also stops if
the verifier ever stages a section while also reporting that something regressed — a verdict that
contradicts itself — so you can look at the staged diff before later sections build on it.

---

## Reviewing the result

Nothing is committed; everything is staged in your repo. Review it like a PR:

```bash
cd /path/to/repo
git diff --cached            # everything staged
<your build + test command>  # confirm green yourself
```

The run leaves a transparent trail under `runs/<runId>/`:

- `acceptance-review-<id>-rN.md`: the plan-aware verdict per section (criteria, reachability, regression,
  gate result). Read the latest per section before committing.
- `quality-review-<id>-rN.md`: what the blind critic found each round.
- `DISMISSED-<id>.md`: every finding the developer declined for that section, one line each with a reason.
  **Audit these.**
- `NEEDS-USER.md`: anything flagged for you — why a run stopped, and, for a parked section, its
  diagnosis and its restore command.
- `parked-<id>.patch`: a parked section's saved work, restored with the `git apply --3way` command
  `NEEDS-USER.md` spells out (it carries the full path). If the section also created files git wasn't
  tracking, they're in `parked-<id>-newfiles/` and you copy those back separately.
- `SWEEP.md`: the final whole-goal coverage check (full-suite result plus any gaps).

Confirm each section is reachable yourself (grep its integration points), run the gates, then commit.

---

## Requirements

- **Claude Code** with the Workflow capability.
- The target is a **git repository** (staging is how regressions are caught).
- A **clean working tree** at the start. The run reviews everything unstaged as its own work, so it checks
  first and stops immediately if you have uncommitted changes lying around — stage or stash them before
  kicking off.
- Commands to **build and test** your project locally. You provide them; the workflow runs them and reads
  pass/fail.
- Optionally a **reference**: a sibling repo or module where a similar change was already done. The agents
  mirror it. Optional but a quality boost.
