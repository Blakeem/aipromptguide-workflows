# feature-cycle — operator guide (for Claude)

`feature-cycle.mjs` builds **ONE bounded feature** — a new MCP tool, API endpoint, page, form, contained
enhancement, or design-needing bugfix — from a plan **you author and the user approves**, to a
test-green, *wired-in* state in one target git repo. Built to `../../principles/WORKFLOW-PRINCIPLES.md`
(the `#N` markers below); follow those before changing the engine.

## 1. Scope (check FIRST)

Right size: one bounded feature, ~10–100+ lines, that integrates into an existing codebase. Too small
(one-liner, rename, config flip) → just make the edit. Too big (breadth-spanning migration across many
files) → sibling **`upgrade-cycle`**; several features → run this once each. Wrong size → say so and
steer the user to the direct edit or `upgrade-cycle`.

## 2. The flow

Pick a `runId` now; reuse it for every phase. Every `Workflow` call loads by path: `scriptPath` = the
absolute path to `feature-cycle.mjs`, plus the phase args. Drive in order:

1. **`EnterPlanMode`** (read-only). Explore the target repo (it runs Explore→Plan subagents for you),
   `AskUserQuestion` for anything ambiguous — **acceptance criteria + testing approach are the
   must-asks** (a Workflow can't prompt mid-run, and building the wrong thing is the #1 risk, so resolve
   it now). Write the plan in the standard shape (§4) **into the plan-mode file** it gives you
   (`~/.claude/plans/<name>.md` — the only file you may edit in plan mode).
2. **`ExitPlanMode`** — user approves (the human gate; also leaves read-only mode).
3. **`phase:"refine"`** (MANDATORY, same `runId`) with `planPath` = the **full absolute path** to the
   plan-mode file (not `~` — the engine doesn't expand it). The opus Plan Critic greps the real repo and
   **returns** `gaps`/`questions`/`too_big` in the tool result (writes no file).
4. **Fold the feedback in:** fix every gap directly in the plan file (writes allowed now); relay each
   question via `AskUserQuestion` and fold answers in; tell the user if the plan materially changed.
   `too_big:true` → split or hand to `upgrade-cycle`.
5. **Prep, then build** (§3): clean the tree, then **`phase:"build"`** (same `runId`, `planPath`, plus
   `gate`) — the develop → blind-quality → acceptance loop.
6. **Verify ground truth yourself** (§7), read the numbered review files + `DISMISSED.md`, surface
   `NEEDS-USER.md`, tell the user what to review. **Never commit.**

`planPath` points at the plan-mode file for both refine and build — no copy. Only caveat: a build
*resumed long after* the file might be pruned would fail to re-read it. Expecting a long-delayed resume?
Copy the plan to `runs/<runId>/PLAN.md` and point `planPath` there.

**Testing approach** (decide with the user, bake into Test Strategy): backend / API / MCP tool / data →
**unit tests** (often TDD: failing tests first). Frontend → usually **not** unit tests; pick
chrome-devtools-mcp, mcp-inspector, playwright, curl, or manual.

## 3. Pre-run setup (your job — no setup agent, #4)

Before `phase:"build"`:
- **Clean the unstaged tree.** The blind reviewer reviews the unstaged diff as "this feature's work."
  Staged work from a *prior* feature is a fine baseline, but `git -C <repo> diff` (unstaged) must be
  empty — commit/stash/stage any stray unstaged work first.
- **Fresh vs. resume.** `DISMISSED.md`/`NEEDS-USER.md` are cumulative: clear `runs/<runId>/` for a
  genuinely new feature; **preserve** it on resume.
- **`gate`** from the plan's `## Gate`: `green` (build + required verification) or `build-only` (feature
  legitimately has no test/verification). Default `green`.
- **`root` — REQUIRED** (both phases): the absolute base run-state hangs off, normally the tool's own
  directory so `runs/` lands beside the tool, not in the target repo. Omit it → the engine errors.

## 4. Plan-file shape (you write it; agents read it VERBATIM, #2)

Plain markdown with these headers. The engine does **NOT** parse it into fields. The blind quality
reviewer never sees it. Keep it tight.

```markdown
## Feature
One paragraph: WHAT this bounded feature is and why.

## Acceptance Criteria
- Observable, testable statements of "done" — the spec the acceptance verifier judges against.

## Integration Points
- Where it must be WIRED IN / reachable: route mounted, tool registered in <file>, export added,
  DI binding, feature flag, menu entry. (Unreached code is an incomplete feature.)

## Implementation Steps
1. Ordered, minimal steps (the HOW).

## Files
- likely-touched paths.

## Test Strategy
kind: tdd | tests-after | manual | none
unit: true|false
method: unit | curl | chrome-devtools-mcp | mcp-inspector | playwright | manual
details: exactly how to run/scope it — commands, selectors, how to start a server, what to assert.

## Gate
green   # build + the required verification pass  (or: build-only). You pass this as the `gate` arg.
```

## 5. Roles (in the engine)

The JS conductor sequences `agent()` calls, passing only control signals (#1). Each agent is fresh and
throwaway.

- **Plan Critic** (refine · opus) — read-only; greps the repo, verifies the plan's file list +
  integration points; returns gaps/questions/too_big.
- **Developer** (build · opus) — reads the plan + the latest flagging review verbatim; implements
  minimally, **wires it in**, runs the gate green, leaves work **UNSTAGED**. Owns the **decision
  matrix**: fixes what's real, logs declines to `DISMISSED.md`, escalates user-only calls to
  `NEEDS-USER.md` (halts only on a hard blocker).
- **Quality Reviewer** (build · sonnet) — **blind**: no plan/spec/goal, reviews ONLY the unstaged diff
  for introduced production-blocking defects. Reads `DISMISSED.md` + `NEEDS-USER.md`, never prior review
  files. Writes `quality-review-N.md`. Must be clean to proceed.
- **Acceptance Verifier** (build · opus) — **plan-aware** final gate: every criterion, reachability,
  full gates, regression vs the staged baseline. Writes `acceptance-review-N.md`. Only agent that stages
  (`git add`), on pass.

## 6. Loop & contracts (keep intact)

`develop → quality (blind, must be clean) → acceptance (plan-aware; stages on pass)`, up to `maxRounds`
(default 4). A flagging review hands the developer that one file's path next round; **any code change
re-enters at quality.**

- **Staging = the cycle boundary, exactly ONE staging.** Staged = accepted baseline; unstaged = this
  feature's work (the reviewers' scope). Only acceptance stages, only on pass. Nothing is ever committed.
- **Gates are the per-stack adapter.** `args.gates.build`/`test` are literal shell commands; `build`
  (lint/compile) must ALWAYS pass. `green` = build + required verification pass *and* the existing suite
  isn't reddened (breaking existing tests is a regression); `build-only` = build green only.
- **Two-stage review = blind then plan-aware** — keep separate (deliberate de-biasing, #5); never hand
  the plan to the quality reviewer.
- **Anti-spin (#5).** The developer logs each decline as one terse line in `DISMISSED.md`; reviewers
  skip settled items for the stated reason. A reviewer that thinks a dismissal is wrong raises
  `CONTESTS DISMISSAL:` once; the developer must fix or escalate, never silently re-dismiss. Rising
  `dismissed_count` (in the run log) is your spin signal — audit `DISMISSED.md` at the end.
- **Frontend/MCP verification.** The developer drives the configured method in-loop; acceptance
  re-confirms once. If the tool is unavailable in the run env, acceptance records it and returns
  `pass=false` — run that check yourself, with the user, before blessing the feature.

## 7. Verify ground truth yourself

The engine reports `status`/`staged`/`reachable`/`regression`. Confirm:
- Run the gates for real; the existing suite is still green.
- `git -C <repo> diff --cached`; `git status --porcelain` + read new files (`git diff` omits new files).
- Grep the integration point — the feature is actually reachable.
- Read `acceptance-review-<last>.md` (per-criterion verdict); **audit `DISMISSED.md`** for bad calls.
- Surface `NEEDS-USER.md`.

## 8. Resume

A run halts only when the developer writes a hard blocker to `NEEDS-USER.md`. Resume: read it, resolve
with the user, confirm the tree still holds this feature's in-progress unstaged work, **preserve
`runs/<runId>/`**, re-invoke `phase:"build"` with the same args. To force a fresh run, clear
`runs/<runId>/` and start from a clean tree.

## 9. Gotchas

- **Verify what the runner actually ran.** Some test runners silently ignore extra path args, so a
  multi-file selector runs only the first file and falsely passes. The engine fails the gate on
  `tests_run_count==0` for a unit selector — sanity-check the count, and scope one file per invocation or
  use the runner's filter. Manual/MCP → `tests_run_count` is `-1`; confirm the behavior was observed.
- **Custom `agentTypes` must exist in the user's registry** — defaults use the standard subagent.
- **Stray `runs/` in the target repo** = `root`/`stateDir` pointed into it. Point `root` at the tool's
  dir, relocate the stray state, re-run.
- **`too_big`** (from refine, or you realize mid-plan) → split into one run per feature, or hand to
  `upgrade-cycle`.

## 10. State files (`runs/<runId>/`, gitignored)

The numbered review files are the inter-agent messages + progress trail; the developer's two files are
its only non-code output. No `PLAN-REVIEW.md` (refine returns in the result), no `progress.json`.
- `quality-review-N.md` — blind findings for round N.
- `acceptance-review-N.md` — per-criterion table + reachability + regression + gate result.
- `DISMISSED.md` — declined findings, one terse line each; **you audit before committing.**
- `NEEDS-USER.md` — self-contained user notes; a hard blocker here halted the run.

Report when done: status, suite result (you ran it), that it's wired in/reachable, what's staged,
`NEEDS-USER.md`, the last acceptance verdict, anything in `DISMISSED.md` worth a second look. **Never
commit** — tell the user to review `git diff --cached` and commit.

## 11. Args reference

Full schema + defaults: the Config block atop `feature-cycle.mjs` (the canonical source). Pass `args`
inline to `Workflow`.
- **Required:** `runId` · `root` (§3) · `planPath` (absolute) **or** `plan` (inline markdown) ·
  `target.repo` (absolute path to the git repo) · `gates.build` + `gates.test` (shell commands; non-zero
  exit = fail).
- **Optional:** `phase` (`refine`|`build`, default `build`) · `gate` (§3) · `conventions` (the
  developer's rubric — language/version constraints, what stays additive, what NOT to touch; the blind
  reviewer is never shown it) · `reference` (path to a completed example to mirror) · `gates.testSetup`
  (runner quirks, how to scope one test, run-as-user/container prefix, how to start a server) ·
  `target.lang`/`target.framework` (hints) · `maxRounds` (4) · `models` (per-role tier:
  plan/develop/quality/acceptance) · `agentTypes` (custom subagent per role — must exist in your
  registry) · `stateDir` (override `runs/<runId>`).
