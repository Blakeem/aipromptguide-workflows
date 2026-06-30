# upgrade-cycle — operator guide (for Claude)

This repo is a **single self-contained Claude Code Workflow** (`upgrade-cycle.mjs`) that drives **ONE
breadth-spanning goal** — a migration, version upgrade, framework port, or subsystem refactor — to a
production-ready, gate-green state across one target git repo. The goal is broken into **ordered
SECTIONS** (each a bounded, reviewable change), and the engine runs each section through a
`develop → blind quality review → plan-aware acceptance` loop, **staging each section on accept** so the
accepted baseline advances section by section.

> **Design law:** this engine is built to a strict set of workflow principles (lean, file-bus, no
> busy-work agents — `../../principles/WORKFLOW-PRINCIPLES.md`); the `#N` markers below refer to them. It is the
> **multi-section sibling of `feature-cycle`** (which builds ONE bounded feature). The only structural
> difference is the section loop + per-section staging; every role and contract is shared. Follow the
> principles before changing the engine.

## Scope — is this the right tool? (check FIRST)

- ✅ **Right size:** one coherent goal that spans **many call sites / files** — migrate a data model,
  upgrade a language/runtime version, port a framework, refactor a subsystem. Big enough that it must be
  **decomposed into sections**, each of which is itself roughly a feature-sized change.
- ❌ **Too small:** a single bounded feature (one MCP tool, one endpoint, one form) → use the sibling
  **`feature-cycle`**. A one-liner / rename / config flip → just make the edit directly.
- ❌ **Not one goal:** several unrelated features → run `feature-cycle` once per feature instead.

If a request is really a single feature or a trivial edit, say so and steer the user to `feature-cycle`
or a direct edit rather than forcing it through here.

## The canonical flow (memorize this — it is the whole job)

The engine is NOT in any name registry, so every `Workflow` call loads it **by path**: pass
`scriptPath` = the absolute path to `upgrade-cycle.mjs`, alongside the phase args. Pick a `runId` now and
reuse it for every phase. Then drive, in order:

1. **`EnterPlanMode`.** Plan mode is READ-ONLY and gives you a plan-file path in its system message
   (`~/.claude/plans/<random-words>.md`). Explore the target repo (plan mode runs Explore/Plan subagents
   for you), **grep the WHOLE change surface** (every occurrence of the pattern/API/symbol the goal
   touches — this is what makes the decomposition complete), `AskUserQuestion` for anything ambiguous,
   and **write the plan as a series of `## Section:` blocks** (shape below) INTO that plan-mode file.
   Order the sections by **dependency** (a producer before its consumers) — array order IS the
   execution order; there is no separate dependency graph.
2. **`ExitPlanMode`** — present the plan; the user approves. The human approval gate; also leaves
   read-only mode so writes/tools are allowed again.
3. **Run `Workflow` `phase:"refine"`** (MANDATORY — same `runId`) with `planPath` = the **full absolute
   path** the plan-mode system message gave you (NOT a `~` shorthand — the engine doesn't expand `~`).
   The opus Plan Critic re-greps the real surface, verifies **every section** against the code, and
   **returns** `gaps` / `questions` / `too_big` **in the tool result** (writes no file). Refine runs
   HERE, after approval.
4. **Fold the feedback in:** fix every gap directly in the plan file (add/split/reorder `## Section:`
   blocks as needed); relay each question to the user with `AskUserQuestion` and fold the answers in. If
   `too_big:true`, split the named section. **Then update your `sections` list to match the final plan.**
5. **Prep, then run.** Ensure the target repo's **unstaged working tree is clean** (see *Pre-run setup*),
   then run `Workflow` `phase:"run"` (same `runId`, same `planPath`, plus `sections`) — the per-section
   `develop → quality → acceptance` loop.
6. **Verify ground truth YOURSELF** (see below), read the numbered review files + `DISMISSED-*.md`,
   surface `NEEDS-USER.md` and `SWEEP.md`, tell the user what to review. **Never commit.**

## The `sections` control list (the one new arg vs feature-cycle)

`phase:"run"` requires **`sections`**: an **ordered** array of thin control objects you extract from the
approved plan — `[{ id, title, gate }]`:
- **`id`** — a stable kebab slug matching a `## Section: <id>` header in the plan file. This is the ONLY
  thing that routes an agent to its section; the section BODY is read verbatim from the file (#1/#2 — the
  id is control, the body is content, never transcribed).
- **`title`** — for logs/labels only.
- **`gate`** — `green` | `red-baseline` | `build-only` (semantics below). Drives the harness's gate
  branch; the harness can't read the plan, so this knob must travel as control.

`test_selector` and everything else stay in the plan body (read verbatim). Order = dependency order.

## Pre-run setup (YOUR job — the engine has no setup agent)

Principle #4: all setup happens out here, before run, never via an in-engine "busy-work" agent.

- **Clean the unstaged working tree.** Section 1's blind reviewer reviews *the unstaged diff*, so at the
  start the tree must hold nothing but (eventually) that section's work. Already-staged work from a prior
  accepted section is the correct baseline; just make sure `git -C <repo> diff` (unstaged) is empty
  before kicking off (or before a resume of the first not-yet-started section).
- **Pass `root` — REQUIRED** (both phases). The absolute base run-state hangs off; normally the workflow
  tool's own directory (so `runs/` lands beside the tool, not in the target repo). Omit it and the engine
  errors (it no longer auto-detects cwd — #4).
- **Set each section's `gate`** from its plan `gate:` line. Mechanical/testless sections → `build-only`.
- **Fresh vs. resumed `runs/<runId>/`.** `DISMISSED-*.md`, `NEEDS-USER.md` are cumulative. For a
  **genuinely new** run, clear `runs/<runId>/`. On a **resume**, **preserve** it.

## The plan-file shape (you write this; agents read it VERBATIM)

Plain markdown. The engine does **NOT** parse section bodies — the developer and acceptance verifier
**read the file itself, verbatim** (#2), locating their section by its `## Section: <id>` header. The
blind quality reviewer is **never given this file** (#3). One block per section, in dependency order:

```markdown
## Section: <section-id> — <title>
gate: green | red-baseline | build-only
test_selector: <a test path or --filter scoping JUST this section, or "">
depends_on: <earlier section ids, or ->   # informational; real ordering is the section order

### Acceptance Criteria
- Observable, testable statements of "done" for THIS section.

### Integration Points
- Every call site / registration / export this section must convert or wire in (a half-converted
  section is not done).

### Implementation Steps
1. Ordered, minimal steps.

### Files
- likely-touched paths.

### Test Strategy
kind: tdd | tests-after | manual | none · method: unit | curl | mcp-inspector | playwright | manual
details: exactly how to run/scope it for THIS section.
```

**Right-size sections.** Each pays a full develop→quality→acceptance loop (~hundreds of k tokens). Target
~1–6 files / one ~150k-token develop pass. Fold trivial changes into a neighbor; split anything too big
(`refine` flags `too_big`). You MAY combine a feature's failing-test authoring and its conversion into
ONE `green` section when small enough — reserve a separate `red-baseline` section for large/risky
features whose failing spec is worth reviewing before conversion.

## The roles (all in the engine)

The JS **conductor** sequences these `agent()` calls; it passes only control signals (a section id, a
round number, a verdict), never re-interprets content (#1). Each agent is fresh, returns one decision,
is destroyed.

- **Plan Critic** (`refine` only · opus) — adversarial, read-only. Re-greps the WHOLE surface, verifies
  every section's file list + integration points + ordering, returns gaps/questions/too_big. Writes
  nothing.
- **Developer** (run loop · opus) — reads its `## Section:` block verbatim + the latest review that
  flagged issues; implements ONLY that section, **converts every call site it owns**, runs the section
  gate, leaves work **UNSTAGED**. Owns the **decision matrix**: fixes what's real, logs declines tersely
  to the section's `DISMISSED-<id>.md`, escalates a user-only call to `NEEDS-USER.md` (halting only on a
  hard blocker). Writes no "what I did" report.
- **Quality Reviewer** (run loop · sonnet) — a **blind pure-code critic**: given NO plan/goal, reviews
  ONLY the unstaged diff for introduced production-blocking defects. Reads the section's settled-decisions
  files so it doesn't re-spin, but **never** prior review files. Writes `quality-review-<id>-rN.md`. Must
  be clean to proceed.
- **Acceptance Verifier** (run loop · opus) — the **plan-aware** section gate. Reads the section; checks
  its acceptance criteria, reachability, the section gate, and **regression** vs the staged baseline.
  Writes `acceptance-review-<id>-rN.md`. On pass, it is the **only** agent that stages (`git add`) — the
  baseline advances.
- **Sweep** (after the final section · sonnet) — independent whole-goal completeness check: re-greps the
  surface, runs the FULL gates, spot-checks the staged diff, writes `SWEEP.md`.

There is **no** Loader, Scribe, Decompose, Triage, or baseline-prep agent — decomposition + approval
happened in plan mode; git staging + the review-file trail are the progress; the developer owns the
matrix.

## How the loop runs

For each section in order, `develop → quality (blind, must be clean) → acceptance (plan-aware; stages on
pass)`, up to `maxRounds` (default 4):

1. **Develop.** Round 1 starts on the clean baseline; later rounds build on the section's own unstaged
   work, addressing the one review file it's handed. Runs the gate before handing off.
2. **Quality review.** Blind. Production-blocking defects send the developer back to
   `quality-review-<id>-N.md`. **Any code change re-enters here.** (Skipped only when the developer
   produced no files — acceptance still judges the section.)
3. **Acceptance review.** Only after quality is clean. Checks criteria + reachability + regression + the
   section gate. On pass it **stages** the section and the loop moves to the next section.

**A section that does NOT accept HALTS the whole run.** This is the key multi-section contract: because
the next section's blind diff must be clean, you cannot start it while the current section's work is
unstaged. A round-budget exhaustion, a hard blocker, or a "passed-but-verifier-didn't-stage" all halt;
resume re-runs that section on its persisted unstaged work.

**Gate semantics** (per section — the suite may be intentionally RED mid-migration, so "done" is judged
on the section's OWN selector, never whole-suite-green):
- `green` — build passes AND this section's selector tests RAN and PASSED (`tests_run_count==0` = a false
  green, fails the gate).
- `red-baseline` — build passes AND the authored tests FAIL for the expected reason (TDD red step; the
  failing test IS the spec a later conversion satisfies — a valid, stageable "done").
- `build-only` — build passes; no test pass/fail requirement (mechanical/testless sections).
Build (lint/compile) must ALWAYS pass. Whole-suite regression is the acceptance verifier's job (it
compares against the staged baseline), not the scoped gate.

**Anti-spin contract (#5).** The developer records each declined finding as one terse line in the
section's `DISMISSED-<id>.md`; reviewers **skip settled items for the stated reason**. The blind quality
reviewer may raise a wrong dismissal once as `CONTESTS DISMISSAL:`; the developer must then **fix or
escalate it — never silently re-dismiss**. The acceptance verifier is a second backstop via its plan-aware
OVERRIDE: a dismissed item that actually breaks a criterion or regresses fails acceptance regardless of
the ledger.

## The contracts that make it safe — keep them intact

- **Staging = the section boundary; staging happens per accepted section** (a deliberate deviation from
  feature-cycle's single end-stage, #9 — forced because the baseline must advance for each section's diff
  to be clean). Staged index/HEAD = accepted baseline; the unstaged tree = the current section's work
  (the reviewers' scope). Only the acceptance verifier stages, only on pass. **Nothing is ever committed
  — the user commits.**
- **Gates are the per-stack adapter.** `args.gates.build` / `args.gates.test` are literal shell commands
  — the only thing that changes between a PHP app and a TS app. `build` must ALWAYS pass.
- **Two-stage review = blind then plan-aware.** Quality is a blind production-blocking-only code critic;
  acceptance is the plan-aware criteria + reachability + regression gate. The blindness is deliberate
  de-biasing (#5) — keep them separate, and never hand the plan to the quality reviewer.

## Resume after a stop (no progress file by design — #6/#10)

Durable progress = **git staging** (each accepted section is staged) + the **numbered review-file trail**
+ the **ordered plan**. There is no `progress.json` or ledger file. To resume:
1. Read the trail in `runs/<runId>/` and `git -C <repo> diff --cached --stat` to see which sections are
   already staged/accepted and which is in-flight (its work sits **unstaged**).
2. If the halt was a hard blocker, read `NEEDS-USER.md` / the section's latest review file and resolve it
   with the user.
3. Re-invoke `phase:"run"` with the same args **plus `startAt:"<first not-yet-accepted section id>"`**
   (or `runOnly:[ids]` for an explicit subset). The engine starts there; the in-progress unstaged work
   persists and the next developer builds on it. (A partial slice via `startAt`/`runOnly` skips the final
   sweep — run the full list once at the end to get it.)

Use `runOnly:[firstFewIds]` to run a cheap first slice (the harness + first section) before committing to
the whole goal.

## Verify ground truth YOURSELF — do not trust the ledger blindly

When run returns, the engine reports `status` / `sectionsDone` / `ledger` / `sweep`. Confirm it:
- Run the gates in the real environment. Confirm each accepted section's selector is actually green (and,
  if the goal expects a green suite at the end, that the full suite is green).
- `git -C <repo> diff --cached` — inspect everything staged; `git status --porcelain` + read new files
  (`git diff` omits brand-new files).
- Confirm each section is **reachable** — grep its integration points yourself; confirm conversions are
  complete (no call site left on the old path).
- Read the latest `acceptance-review-<id>-N.md` per section and **audit every `DISMISSED-<id>.md`**.
- Read `SWEEP.md` (the whole-goal completeness check) — evidence, not a substitute for your verification.
- Surface anything in `NEEDS-USER.md`.

## Gotchas burned in from real runs

- **Verify what the test runner actually ran.** Some runners silently mislead (e.g. PHPUnit 4.x runs only
  the FIRST path arg → a multi-file selector gives a false green). The engine fails the gate when
  `tests_run_count==0` for a green section, but sanity-check the count yourself. Run one file per
  invocation or use `--filter`.
- **`git diff` omits brand-new files.** When verifying, also use `git status --porcelain` and read new
  files. (The engine handles this for reviewers via `git add -N`; you must too.)
- **Custom `agentTypes` must exist in the user's registry.** Defaults use the standard workflow subagent,
  which always works. Only pass agentTypes the user actually has.
- **Halts are recovery loops, not failures.** A halt is usually a bad gate command, a missing dependency
  the plan assumed (a consumer section before its producer — reorder the plan), or a real design question.
  Fix the root cause, then resume from that section.
- **A section that "passed but wasn't staged" halts on purpose.** If the verifier reports `pass` but
  didn't stage, the engine stops rather than corrupt the next section's diff. Stage the section's files
  yourself (`git add`), then resume from the NEXT section.
- **`refine` says `too_big`?** Split the named section in the plan, update `sections`, re-run refine.
- **Stray `runs/` inside the target repo** = you passed a `root`/`stateDir` pointing into the target repo.
  Pass `root` = the tool's own directory; relocate the stray state; re-run.

## State files (under `runs/<runId>/`, gitignored)

The numbered review files ARE the inter-agent messages and the progress trail; the developer's two file
kinds are its only output besides code. There is **no** `tasks.json`, `progress/`, `LEDGER.md`,
`CHANGELOG.md`, or `PLAN-REVIEW.md` (refine returns its findings in the tool result).

- `quality-review-<id>-rN.md` — the blind critic's findings for section `<id>`, round N.
- `acceptance-review-<id>-rN.md` — the plan-aware per-criterion table + reachability + regression + gate
  result for section `<id>`, round N.
- `DISMISSED-<id>.md` — the developer's terse ledger of declined findings for section `<id>` (one line
  each, with a reason). **You audit these before committing.**
- `NEEDS-USER.md` — full, self-contained notes for the user: blockers/questions/decisions (GLOBAL,
  cumulative). A hard blocker here also halted the run.
- `SWEEP.md` — the final whole-goal completeness sweep: full-suite result + any goal-coverage gaps.

## When you're done

Report: status + which sections are done, the suite result (run it yourself), that each section is
actually wired in / fully converted, what's staged, anything in `NEEDS-USER.md`, the latest
`acceptance-review-<id>-N.md` verdicts, anything in a `DISMISSED-<id>.md` worth a second look, and the
`SWEEP.md` result. **Never commit** — tell the user what to review (`git diff --cached`) and let them
commit.
