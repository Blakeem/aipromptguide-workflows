# feature-cycle — operator guide (for Claude)

This repo is a **single self-contained Claude Code Workflow** (`feature-cycle.mjs`) that builds
**ONE bounded feature** — a new MCP tool, API endpoint, page, form, a contained enhancement, or a
design-needing bugfix — from a plan **you (the orchestrating agent) author and the user approves**,
driving it to a production-ready, test-green, *wired-in* state across one target git repo.

> **Design law:** this engine is built to a strict set of workflow principles (lean, file-bus, no
> busy-work agents); the `#N` markers below refer to them. Follow those principles before changing the
> engine — every choice below follows from them.

## Scope — is this the right tool? (check FIRST)

This workflow carries real overhead (plan mode + a mandatory plan review + a develop→quality→acceptance
loop — a couple hundred k tokens). It only pays off for a feature **big enough to deserve a written
plan and a review of that plan.** Use this band:

- ✅ **Right size:** one bounded feature, roughly **10–100+ lines** depending on complexity, that
  integrates into an existing codebase — a **new MCP tool, a new API endpoint, a new page, a new
  form,** or a similarly-scoped enhancement / design-needing bugfix.
- ❌ **Too small:** a one-line change, a tiny tweak, a rename, a config flip. If it's too small to be
  worth reviewing a plan, it's too small for plan mode AND too small for this workflow — **just make
  the edit directly.** Don't spin up the workflow for it.
- ❌ **Too big:** a breadth-spanning migration, version upgrade, framework port, or subsystem refactor
  across many files — that's the sibling **`upgrade-cycle`**. If it's really several features, run
  this once per bounded feature.

When a request lands at the trivial or breadth-spanning end, say so and steer the user to the direct
edit or to `upgrade-cycle` instead of forcing it through here.

## The canonical flow (memorize this — it is the whole job)

All the user needs to say is *what to build* + *where this workflow lives* (the
`aipg/workflows/feature/` folder of the AI Prompt Guide checkout). The engine is NOT in any name registry, so every `Workflow`
call below loads it BY PATH: pass `scriptPath` = the absolute path to `feature-cycle.mjs` in that
folder, alongside the phase args (`phase`/`runId`/`planPath`/`root`/…). (If the user installed it into
a `~/.claude/workflows/` dir, you may instead pass `name:"feature-cycle"`.) Pick a `runId` now and
reuse it for every phase. Then drive, in order:

1. **`EnterPlanMode`.** Plan mode is READ-ONLY and gives you a plan-file path in its system message
   (`~/.claude/plans/<random-words>.md` — Anthropic's, NOT a `runs/` or `plans/` path you invent).
   Explore the target repo (it runs Explore→Plan subagents for you), `AskUserQuestion` for anything
   ambiguous (acceptance criteria + testing approach are the must-asks), and **write the plan, in the
   standard section shape (below), INTO that plan-mode file** — it's the only file you may edit in
   plan mode.
2. **`ExitPlanMode`** — present the plan; the user approves. This is the human approval gate and it
   leaves read-only mode (so writes/tools are allowed again).
3. **Run `Workflow` `phase:"refine"`** (MANDATORY — same `runId`) with `planPath` pointing straight at
   the plan-mode file — the **full absolute path** its system message gave you (e.g.
   `C:\Users\Blake\.claude\plans\<name>.md`). No copy needed; the engine just reads that path. (Pass
   the absolute path, NOT a `~` shorthand — the engine doesn't expand `~`.) The opus Plan Critic greps
   the real repo and **returns** `gaps` / `questions` / `too_big` **in the tool result** — it writes
   no file (you read the result and act on it). **Refine runs HERE, after approval** — it reviews the
   plan the user just approved, and the next phase (build) writes.
4. **Fold the feedback in:** fix every gap directly in the plan file (writes are allowed now that
   you've left plan mode); relay each question to the user with `AskUserQuestion` and fold the answers
   in; if refine materially changed the plan, tell the user. (If `too_big:true`, split or hand to
   `upgrade-cycle`.)
5. **Prep, then build.** Ensure the target repo's **unstaged working tree is clean** and the state dir
   is right (see *Pre-run setup* below), then run `Workflow` `phase:"build"` (same `runId`, same
   `planPath`, plus `gate`) — the develop → blind-quality-review → acceptance loop.
6. **Verify ground truth YOURSELF** (see below), read the numbered review files + `DISMISSED.md`,
   surface `NEEDS-USER.md`, tell the user what to review. **Never commit.**

The plan stays in plan mode's `~/.claude/plans/<name>.md` file — `planPath` points there for both
refine and build; no manual copy. The only caveat: a build *resumed long after* the plan file might be
pruned would fail to re-read it. If you expect a long-delayed resume, copy the plan into
`runs/<runId>/PLAN.md` and point `planPath` there instead.

Below is what is NOT obvious from the prompts inside the engine.

## Pre-run setup (YOUR job — the engine has no setup agent)

Principle #4: all setup happens out here, before build, never via an in-engine "busy-work" agent.
Before `phase:"build"`:

- **Clean the unstaged working tree.** The blind quality reviewer reviews *the unstaged diff* as "this
  feature's work," so the tree must hold nothing else. Already-staged work from a *prior* feature is a
  fine baseline; just make sure `git -C <repo> diff` (unstaged) is empty. If there's stray unstaged
  work, commit/stash it or fold it into the staged baseline first.
- **Fresh vs. resumed `runs/<runId>/`.** `DISMISSED.md` and `NEEDS-USER.md` are cumulative. For a
  **genuinely new** feature, clear `runs/<runId>/` first. On a **resume** (after a halt), **preserve**
  it so the ledger + user notes survive.
- **Pass `gate`.** Derive it from the plan's `## Gate` section: `green` (build + the required
  verification must pass) or `build-only` (build/lint only — use this when the feature legitimately
  has no test/verification). Default is `green`.
- **Pass `root` — it's REQUIRED** (both phases). It's the absolute base the run-state hangs off;
  normally the workflow tool's own directory (so `runs/` lands beside the tool, not in the target
  repo). The engine no longer spawns an agent to auto-detect the cwd (#4) — omit `root` and it errors.

## The division of labour that makes this work

Discovery, spec-writing, and the human approval gate live **OUTSIDE the engine**, in native **plan
mode** — which you drive, and which Anthropic keeps current. The engine consumes an *approved* plan
*verbatim*; it does not decompose a goal, discover a spec, or parse the plan into fields. That is the
deliberate difference from the sibling `upgrade-cycle` (which owns its own decomposition because it
manages breadth across many call sites).

**A Workflow runs autonomously in the background — it cannot prompt the user mid-run.** So anything
that needs a human answer is YOUR job, done interactively before/around the run:
- **Clarify the spec up front.** If the request is under-specified, use `AskUserQuestion` to nail the
  acceptance criteria BEFORE you write the plan. Building the wrong thing is the #1 feature risk.
- **Decide the testing approach up front** (bake it into the plan's Test Strategy), e.g.:
  - Backend / API / MCP tool / data logic → **unit tests** (often TDD: write failing tests first).
  - Frontend → usually **not** unit tests; decide the verification method *with the user*: Chrome
    DevTools MCP, MCP inspector, Playwright, manual `curl` against a running server, or none.
- **Run the plan review, every time.** `phase:"refine"` is a MANDATORY stage. It runs AFTER the
  user's `ExitPlanMode` approval, with `planPath` pointing at the plan-mode file. If refine returns
  questions, ask the user and fold the answers into the plan; if it returns gaps, fix them; only then
  run `phase:"build"`.

## The plan-file shape (you write this; agents read it VERBATIM)

Plain markdown with these headers. The engine does **NOT** parse it into fields — the developer and
the acceptance verifier **read the file itself, verbatim** (principle #2), so there is no lossy
extract/rebuild. The blind quality reviewer is **never given this file**. Keep it tight.

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

## The roles (all in the engine)

The JS **conductor** (the script itself — not an LLM, no tools) sequences these `agent()` calls; it
passes only control signals (a path, a round number, a verdict), never re-interprets content (#1).
Each agent is a fresh, throwaway context that returns one decision and is destroyed.

- **Plan Critic** (`refine` only · opus) — adversarial, read-only. Greps the real repo, verifies the
  plan's file list + integration points, returns gaps/questions/too_big. Writes nothing.
- **Developer** (build loop · opus) — reads the plan verbatim + the latest review that flagged issues;
  implements minimally, **wires it in**, runs the gate to green, leaves work **UNSTAGED**. Owns the
  **decision matrix**: fixes what's real, logs declines tersely to `DISMISSED.md`, escalates a
  user-only call to `NEEDS-USER.md` (halting only on a hard blocker). Writes no "what I did" report.
- **Quality Reviewer** (build loop · sonnet) — a **blind pure-code critic**: given NO plan, spec, or
  goal, it reviews ONLY the unstaged diff for introduced **production-blocking** defects. Reads the
  settled-decisions files (`DISMISSED.md` + `NEEDS-USER.md`) so it doesn't re-raise closed findings,
  but **never** prior review files (staying fresh). Writes `quality-review-N.md`. **Must be clean to
  proceed.**
- **Acceptance Verifier** (build loop · opus) — the **plan-aware** final gate. Reads the plan; checks
  every acceptance criterion, reachability, full gates, and **regression** vs the staged baseline.
  Writes `acceptance-review-N.md`. On pass, it is the **only** agent that stages (`git add`).

There is no Loader (agents read the plan directly), no separate Triage (the developer owns the
matrix), and no Scribe/progress file (the numbered review files are the trail). Discovery happened in
plan mode.

## How the loop runs

`develop → quality review (blind, must be clean) → acceptance review (plan-aware; stages on pass)`,
repeated per round up to `maxRounds` (default 4):

1. **Develop.** If a prior review flagged issues, the developer is handed *that one review file's path*
   and resolves it, building on its existing unstaged work. It runs the gate to green before handing
   off (a red build just loops back to develop).
2. **Quality review.** Blind. If it finds production-blocking defects, the developer addresses
   `quality-review-N.md` next round. **Any code change re-enters here.**
3. **Acceptance review.** Only after quality is clean. If criteria/reachability/regression fail, the
   developer addresses `acceptance-review-N.md` next round. On pass, it stages and the feature is done.

**Anti-spin contract (principle #5).** A blind reviewer would otherwise re-flag every finding the
developer deliberately declined. So the developer records each decline as one terse line in
`DISMISSED.md`, and reviewers **skip settled items for the stated reason**. A reviewer that believes a
dismissal is wrong (for a genuine production-blocking defect) raises it once as `CONTESTS DISMISSAL:`;
the developer must then **fix or escalate it — never silently re-dismiss**. This bounds the loop *and*
prevents a wrongly-dismissed real defect from being silently suppressed. The acceptance verifier is a
second backstop: a dismissed item that actually breaks a criterion or regresses fails acceptance
regardless of the ledger. `dismissed_count` is surfaced in the run log each round — a rising count is
your spin signal; audit `DISMISSED.md` at the end.

## The contracts that make it safe — keep them intact

- **Staging = the cycle boundary, and there is exactly ONE staging.** Staged index/HEAD = accepted
  baseline; the unstaged working tree = this feature's work (the reviewers' scope). Only the
  **acceptance verifier stages, and only on pass.** **Nothing is ever committed — the user commits.**
- **Gates are the per-stack adapter.** `args.gates.build` and `args.gates.test` are literal shell
  commands the agents run — the only thing that changes between a PHP app and a TS app. `build`
  (lint/compile) must ALWAYS pass.
- **Gate semantics** (no intentionally-red phase — a feature is additive): `green` = build + the
  required verification pass, *and the existing suite isn't reddened* (a feature that breaks existing
  tests is a regression). `build-only` = build green only. You pass the choice via the `gate` arg.
- **Two-stage review = blind then plan-aware.** Quality is a blind production-blocking-only code
  critic; acceptance is the plan-aware completeness + reachability + regression gate. Keep them
  separate — the blindness is deliberate de-biasing (#5).
- **Frontend/MCP verification.** The developer drives the configured method (chrome-devtools-mcp,
  mcp-inspector, curl, playwright) inside the loop; the acceptance verifier re-confirms once. If the
  configured tool is unavailable in the run environment, the verifier records that in
  `acceptance-review-N.md` and returns `pass=false` (it does not fake a pass) — run that check
  yourself, with the user, before blessing the feature.

## Verify ground truth YOURSELF — do not trust the ledger blindly

When build returns, the engine reports `status` / `staged` / `reachable` / `regression`. Confirm it:

- Run the gates in the real environment; confirm the **existing suite is still green**.
- `git -C <repo> diff --cached` — inspect everything staged; `git status --porcelain` + read new files
  (`git diff` omits brand-new files).
- Confirm the feature is **reachable** — grep the integration point yourself.
- Read `runs/<runId>/acceptance-review-<last>.md` (the per-criterion verdict) and **audit
  `DISMISSED.md`** (every finding the developer declined — catch a bad call here).
- Surface anything in `NEEDS-USER.md`.

## Resume after a stop

There is no progress file by design. A run halts only when the developer writes a hard blocker to
`NEEDS-USER.md` (and sets `needs_user`). To resume: read `NEEDS-USER.md`, resolve it with the user,
confirm the tree still holds this feature's in-progress unstaged work, **preserve `runs/<runId>/`**,
and re-invoke `phase:"build"` with the same args. The next developer builds on the unstaged work.
Because staging only happens on final acceptance, in-progress work is never folded into the baseline.
To force a totally fresh run, clear `runs/<runId>/` and start from a clean tree.

## Gotchas burned in from real runs

- **Verify what the test runner actually ran.** Some runners silently mislead (e.g. PHPUnit 4.x runs
  only the FIRST path arg). The engine fails the gate when `tests_run_count` is 0 for a unit
  selector, but sanity-check the count yourself. For manual/MCP verification, `tests_run_count` is
  `-1` (no count) — confirm the behavior was actually observed.
- **`git diff` omits brand-new files.** When verifying, also use `git status --porcelain` and read
  new files. (The engine handles this for the reviewers via `git add -N`; you must too.)
- **Custom `agentTypes` must exist in the user's agent registry.** Defaults use the standard workflow
  subagent, which always works. Only pass agentTypes the user actually has.
- **Halts are recovery loops, not failures.** A `NEEDS-USER.md` hard blocker is usually a bad gate
  command, a missing dependency the plan assumed, or a real design question. Fix the root cause, then
  resume.
- **Rising `dismissed_count` across rounds = the developer is declining a lot.** Read `DISMISSED.md`
  during/after the run; a wrongly-dismissed real defect should have been contested — if you disagree
  with a dismissal, that's a fix or a decision for the user.
- **Stray `runs/` inside the target repo** = you passed a `root` (or `stateDir`) pointing into the
  target repo. Pass `root` = the tool's own directory so state lands beside the tool; relocate the
  stray state, re-run. (`root` is required — the engine errors if it's missing rather than guessing.)
- **Too big?** If `refine` returns `too_big:true`, or you realize mid-plan the work is really several
  features, split it: run this engine once per bounded feature, or hand the whole thing to
  `upgrade-cycle`.

## State files (under `runs/<runId>/`, gitignored)

The numbered review files ARE the inter-agent messages and the progress trail; the developer's two
files are its only output besides code. There is **no** `PLAN-REVIEW.md` (refine returns its findings
in the tool result), no `progress.json`, no `FEATURE.md`, no `ACCEPTANCE.md`.

- `quality-review-N.md` — the blind critic's findings for round N (or "No production-blocking defects
  found.").
- `acceptance-review-N.md` — the plan-aware per-criterion table + reachability + regression + gate
  result + any gaps for round N.
- `DISMISSED.md` — the developer's terse ledger of declined findings (one line each, with a reason).
  Reviewers read it to avoid re-spin; **you audit it before committing.**
- `NEEDS-USER.md` — full, self-contained notes for the user: blockers/questions/decisions. A hard
  blocker here also halted the run.

## When you're done

Report: status, suite result (run it yourself), that the feature is actually wired in/reachable,
what's staged, anything in `NEEDS-USER.md`, the `acceptance-review-<last>.md` verdict, anything in
`DISMISSED.md` you'd want a second look at, and any "reads-oddly-but-tests-pass" item worth the user's
eye. **Never commit** — tell the user what to review (`git diff --cached`) and let them commit.
