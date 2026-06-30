# upgrade-cycle — operator guide (for Claude)

`upgrade-cycle.mjs` drives **ONE breadth-spanning goal** — a migration, version upgrade, framework port,
or subsystem refactor — to a gate-green state in one target git repo, by decomposing it into ordered
**sections** (each a bounded, reviewable change) and running each through `develop → blind quality →
plan-aware acceptance`, **staging each section on accept** so the baseline advances section by section.
Multi-section sibling of `feature-cycle`: same roles + contracts, plus the section loop and per-section
staging. Built to `../../principles/WORKFLOW-PRINCIPLES.md` (the `#N` markers below); follow those before
changing the engine.

## 1. Scope (check FIRST)

Right size: one coherent goal spanning **many call sites / files**, big enough to need decomposition into
sections that are each roughly feature-sized. Too small (one feature → `feature-cycle`; one-liner/rename
→ just edit). Not one goal (several unrelated features) → `feature-cycle` once each. Wrong size → say so
and steer the user.

## 2. The flow

Pick a `runId` now; reuse it. Loads by path: `scriptPath` = the absolute path to `upgrade-cycle.mjs`,
plus the phase args. Drive in order:

1. **`EnterPlanMode`** (read-only). Explore the repo (plan mode runs Explore/Plan subagents for you) and
   **grep the WHOLE change surface** (every occurrence of the pattern/API/symbol — this is what makes the
   decomposition complete), `AskUserQuestion` for ambiguities, and write the plan as `## Section:` blocks
   (§5) into the plan-mode file. **Order sections by dependency** (a producer before its consumers) —
   array order IS execution order.
2. **`ExitPlanMode`** — user approves (the human gate; also leaves read-only mode).
3. **`phase:"refine"`** (MANDATORY, same `runId`) with `planPath` = the **full absolute path** (not `~`).
   The opus Plan Critic re-greps the surface, verifies every section against the code, and **returns**
   `gaps`/`questions`/`too_big` in the result.
4. **Fold the feedback in:** fix gaps in the plan (add/split/reorder `## Section:` blocks); relay each
   question via `AskUserQuestion`; `too_big:true` → split the named section. **Then update your
   `sections` list to match the final plan.**
5. **Prep, then run** (§4): clean the tree, then **`phase:"run"`** (same `runId`, `planPath`, plus
   `sections`) — the per-section `develop → quality → acceptance` loop.
6. **Verify ground truth yourself** (§7), read the numbered review files + `DISMISSED-*.md`, surface
   `NEEDS-USER.md` + `SWEEP.md`, tell the user what to review. **Never commit.**

## 3. The `sections` list (the one new arg vs feature-cycle)

`phase:"run"` requires **`sections`**: an **ordered** array `[{ id, title, gate }]` you extract from the
approved plan:
- **`id`** — a stable kebab slug matching a `## Section: <id>` header. The ONLY routing key; the body is
  read verbatim from the file (#1/#2 — never transcribed).
- **`title`** — logs/labels only.
- **`gate`** — `green` | `red-baseline` | `build-only` (§6). The harness can't read the plan, so this
  knob travels as control.

Everything else (`test_selector`, …) stays in the plan body. Order = dependency order.

## 4. Pre-run setup (your job — no setup agent, #4)

Before `phase:"run"`:
- **Clean the unstaged tree** (`git -C <repo> diff` empty before kicking off, or before a resume of the
  first not-yet-started section). Staged work from a prior accepted section is the correct baseline.
- **`root` — REQUIRED** (both phases): the tool's own directory so `runs/` lands beside the tool, not in
  the target repo. Omit it → the engine errors.
- **Each section's `gate`** from its plan `gate:` line (mechanical/testless → `build-only`).
- **Fresh vs. resume.** `DISMISSED-*.md`/`NEEDS-USER.md` are cumulative: clear `runs/<runId>/` for a
  genuinely new run; **preserve** it on resume.

## 5. Plan-file shape (you write it; agents read it VERBATIM, #2)

Plain markdown. The engine does **NOT** parse section bodies — agents locate their section by its
`## Section: <id>` header. The blind quality reviewer never sees it (#3). One block per section,
dependency order:

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
(refine flags `too_big`). You MAY combine a small feature's failing-test authoring + conversion into ONE
`green` section; reserve a separate `red-baseline` section for large/risky features whose failing spec is
worth reviewing before conversion.

## 6. Roles, loop & gate semantics

Roles mirror feature-cycle (the conductor passes only control signals, #1; agents fresh + throwaway):
- **Plan Critic** (refine · opus) — re-greps the surface, verifies every section's files + integration
  points + ordering; returns gaps/questions/too_big.
- **Developer** (run · opus) — reads its `## Section:` block + the latest flagging review verbatim;
  implements ONLY that section, **converts every call site it owns**, runs the section gate, leaves work
  **UNSTAGED**. Owns the matrix: declines → `DISMISSED-<id>.md`, user-only → `NEEDS-USER.md` (halts on a
  hard blocker).
- **Quality Reviewer** (run · sonnet) — **blind**; reviews ONLY the unstaged diff for introduced
  production-blocking defects. Writes `quality-review-<id>-rN.md`. Must be clean to proceed.
- **Acceptance Verifier** (run · opus) — **plan-aware** section gate: criteria, reachability, the section
  gate, regression vs the staged baseline. Writes `acceptance-review-<id>-rN.md`. Only agent that stages,
  on pass — the baseline advances.
- **Sweep** (after the final section · sonnet) — whole-goal check: re-greps the surface, runs the FULL
  gates, spot-checks the staged diff, writes `SWEEP.md`.

**Loop**, per section in order: `develop → quality (blind, must be clean) → acceptance (plan-aware;
stages on pass)`, up to `maxRounds` (default 4). Any code change re-enters at quality. **A section that
does NOT accept HALTS the whole run** — the next section's blind diff must be clean, so you cannot start
it while this section's work is unstaged. Resume re-runs that section on its persisted unstaged work.

**Gate semantics** (per section — the suite may be intentionally RED mid-migration; "done" is judged on
the section's OWN selector, never whole-suite-green):
- `green` — build passes AND this section's selector tests RAN and PASSED (`tests_run_count==0` = a false
  green, fails the gate).
- `red-baseline` — build passes AND the authored tests FAIL for the expected reason (TDD red step; a
  valid, stageable "done").
- `build-only` — build passes; no test pass/fail requirement (mechanical/testless).
Build (lint/compile) must ALWAYS pass. Whole-suite regression is the acceptance verifier's job (vs the
staged baseline), not the scoped gate. `args.gates.build`/`test` are literal shell commands — the
per-stack adapter, the only thing that changes between stacks.

**Anti-spin (#5).** Declines → one terse line in the section's `DISMISSED-<id>.md`; reviewers skip
settled items for the stated reason. A wrong dismissal → `CONTESTS DISMISSAL:` once; the developer must
fix or escalate, never silently re-dismiss. Keep the two-stage review separate; never hand the plan to
the quality reviewer.

## 7. Verify ground truth yourself

The engine reports `status`/`sectionsDone`/`ledger`/`sweep`. Confirm:
- Run the gates for real; each accepted section's selector is green (and the full suite, if the goal
  expects green at the end).
- `git -C <repo> diff --cached`; `git status --porcelain` + read new files (`git diff` omits new files).
- Grep each section's integration points — reachable, conversions complete (no call site on the old
  path).
- Read the latest `acceptance-review-<id>-N.md` per section; **audit every `DISMISSED-<id>.md`**.
- Read `SWEEP.md` (evidence, not a substitute for your own check); surface `NEEDS-USER.md`.

## 8. Resume (no progress file by design, #6/#10)

Durable progress = git staging + the numbered review-file trail + the ordered plan.
1. Read the trail + `git -C <repo> diff --cached --stat` to see which sections are staged/accepted and
   which is in-flight (its work sits **unstaged**).
2. Hard blocker → read `NEEDS-USER.md` / the section's latest review, resolve with the user.
3. Re-invoke `phase:"run"` with the same args **plus `startAt:"<first not-yet-accepted section id>"`** (or
   `runOnly:[ids]` for an explicit subset). In-progress unstaged work persists; the next developer builds
   on it. A partial slice via `startAt`/`runOnly` skips the final sweep — run the full list once at the
   end to get it.

Use `runOnly:[firstFewIds]` for a cheap first slice before committing to the whole goal.

## 9. Gotchas

- **Verify what the runner actually ran.** Some test runners silently ignore extra path args, so a
  multi-file selector runs only the first file and gives a false green. The engine fails the gate on
  `tests_run_count==0` for a green section — sanity-check it; scope one file per invocation or use the
  runner's filter.
- **`git diff` omits new files** — also `git status --porcelain` + read them.
- **Custom `agentTypes` must exist** in the user's registry — defaults use the standard subagent.
- **A "passed but not staged" section halts on purpose** (so the next section's diff isn't corrupted) —
  stage its files yourself (`git add`), resume from the NEXT section.
- **A halt is usually** a bad gate command, a missing dependency the plan assumed (a consumer before its
  producer — reorder the plan), or a real design question. Fix the root cause, resume from that section.
- **`too_big`** → split the named section, update `sections`, re-run refine.
- **Stray `runs/` in the target repo** = `root`/`stateDir` pointed into it. Point `root` at the tool's
  dir, relocate the stray state, re-run.

## 10. State files (`runs/<runId>/`, gitignored)

The numbered review files are the inter-agent messages + progress trail; the developer's two file kinds
are its only non-code output. No `tasks.json`/`progress/`/`LEDGER.md`/`CHANGELOG.md`/`PLAN-REVIEW.md`.
- `quality-review-<id>-rN.md` — blind findings for section `<id>`, round N.
- `acceptance-review-<id>-rN.md` — per-criterion table + reachability + regression + gate result.
- `DISMISSED-<id>.md` — the section's declined findings, one terse line each; **you audit before
  committing.**
- `NEEDS-USER.md` — global cumulative user notes; a hard blocker here halted the run.
- `SWEEP.md` — the final whole-goal completeness sweep.

Report when done: status + which sections are done, the suite result (you ran it), each section wired in
/ fully converted, what's staged, `NEEDS-USER.md`, the latest acceptance verdicts, anything in a
`DISMISSED-<id>.md` worth a second look, the `SWEEP.md` result. **Never commit** — tell the user to
review `git diff --cached` and commit.

## 11. Args reference

Full schema + defaults: the Config block atop `upgrade-cycle.mjs` (the canonical source). Pass `args`
inline to `Workflow`.
- **Required:** `runId` · `root` (§4) · `planPath` (absolute) **or** `plan` (inline markdown) ·
  `sections` (§3, for `phase:"run"`) · `target.repo` (absolute path to the git repo) · `gates.build` +
  `gates.test` (shell commands; non-zero exit = fail).
- **Optional:** `phase` (`refine`|`run`, default `run`) · `conventions` (the developer's rubric —
  language/version constraints, what stays additive, what NOT to touch; the blind reviewer is never shown
  it) · `reference` (path to a completed example to mirror) · `gates.testSetup` (runner quirks, how to
  scope one test, run-as-user/container prefix) · `target.lang`/`target.framework` (hints) · `maxRounds`
  (4) · `models` (per-role tier: develop/quality/acceptance/refine/sweep) · `agentTypes` (custom subagent
  per role — must exist in your registry) · `stateDir` (override `runs/<runId>`) · `runOnly`/`startAt`
  (§8, scope a partial slice).
