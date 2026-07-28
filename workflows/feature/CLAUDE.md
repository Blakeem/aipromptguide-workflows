# feature-cycle — operator guide (for Claude)

`feature-cycle.mjs` builds **ONE bounded feature** — a new MCP tool, API endpoint, page, form, contained
enhancement, or design-needing bugfix — or an ordered **roadmap** of several such features, each from a
plan **you author and the user approves**, to a test-green, *wired-in* state in one target git repo,
**staging each accepted feature** before the next. Built to `../../principles/WORKFLOW-PRINCIPLES.md`
(the `#N` markers below); follow those before changing the engine.

## 1. Scope (check FIRST)

Right size: one bounded feature, ~10–100+ lines, that integrates into an existing codebase — or an
ordered **roadmap** of several such features in ONE run (the `plans` array; §11). Too small (one-liner,
rename, config flip) → just make the edit. Too big for one bounded feature → **split it into multiple
bounded plans** and run them as a roadmap (refine's `too_big` routes here when the pieces are
feature-shaped); a single goal that is a **pattern spanning many call sites** (migration/upgrade/port/
refactor) → sibling **`migrate-cycle`**. Wrong size → say so and steer the user.

**Documentation is a POOR FIT — keep it out of the plan.** The blind quality stage judges a diff on its
own merits for production-blocking defects, and prose has no such defect class: the reviewer either
returns clean trivially (a wasted opus pass) or manufactures nits that then burn develop rounds.
Acceptance's reachability and regression checks are equally meaningless for markdown. Bundling the docs
with the code is also the most common reason a sound plan comes back `too_big` and has to be split. So
**build the feature here, then write the docs directly** (main agent, no engine) and verify them with a
`debug` review pass under a doc-accuracy lens against the source — documentation drift is a *defect*
(something the system states wrongly), and that inventory is closed by "every claim vs. the code", so it
converges. The one thing worth keeping in the plan is a line naming which docs will need updating, so
they are not forgotten.

**Size it BEFORE you write the plan, not at refine.** `too_big` arriving from the plan critic means the
planning work is already spent and has to be re-partitioned. Cheap pre-check while still in plan mode:
name the **comparable artifacts already in this repo** and size against them (`ls -la` / `wc -l` the
nearest sibling). One plan should be about **one coherent artifact plus its tests**. Several new files,
or a new file plus edits to many existing ones, is a roadmap — decide that up front and write one plan
per entry. If the honest estimate is more than roughly a single focused develop pass, split first;
refine then confirms the pieces instead of rejecting the whole.

## 2. The flow

Pick a `runId` now; reuse it for every phase. Every `Workflow` call loads by path: `scriptPath` = the
absolute path to `feature-cycle.mjs`, plus the phase args. **Plan + refine each feature, then build once.**

**A roadmap belongs in ONE plan file.** Author every feature as a `## Plan: <id>` block in a single
plan-mode session (§4): one approval, ONE refine pass that sees all the blocks together (so it can
catch two plans converting the same call site), and no split into per-feature files — which is
transcription (#2/#11), and the reason this used to be painful. Each agent is handed a **command**
that prints just its block, so the other features never enter its context. One feature per plan-mode
session still works: give each entry its own `planPath` (below, unchanged).

Per feature (or per block; plan mode re-enters freely, and each session mints its own
`~/.claude/plans/<name>.md`):

1. **`EnterPlanMode`** (read-only). Explore the target repo (it runs Explore→Plan subagents for you),
   `AskUserQuestion` for anything ambiguous — **acceptance criteria + testing approach are the
   must-asks** (a Workflow can't prompt mid-run, and building the wrong thing is the #1 risk, so resolve
   it now). Write the plan in the standard shape (§4) **into the plan-mode file** it gives you (the only
   file you may edit in plan mode).
2. **`ExitPlanMode`** — user approves (the human gate; also leaves read-only mode).
3. **`phase:"refine"`** (MANDATORY, same `runId`) with `planPath` = that file's **full absolute path**
   (not `~` — the engine doesn't expand it). The opus Plan Critic greps the real repo and **returns**
   `gaps`/`questions`/`too_big` in the tool result (writes no file).
4. **Fold the feedback in:** fix every gap directly in the plan file (writes allowed now); relay each
   question via `AskUserQuestion` and fold answers in; tell the user if the plan materially changed.
   `too_big:true` → split into more feature-plans (add them to the roadmap), or hand to `migrate-cycle`
   if it's a pattern across many call sites.

Then ONCE, for the whole roadmap:

5. **Prep, then build** (§3): clean the tree, then **`phase:"build"`** (same `runId`) with the **`plans`**
   array in build order (§11). One plan file of blocks → keep the top-level `planPath` and pass
   `[{ id, gate }]`; derive it rather than typing it:
   `node <root>/tools/plan-block.mjs <planPath> --list`. Per-feature files → `[{ id, planPath, gate }]`.
   One feature? A single top-level `planPath` + `gate` (back-compat). The develop → blind-quality →
   acceptance loop runs each plan in order, **staging each accepted feature** before the next starts; a
   plan that can't pass is **parked** (its work saved to a patch, the tree cleared) and the roadmap
   carries on (§6).
6. **Verify ground truth yourself** (§7), read the numbered review files + `DISMISSED-<id>.md`, surface
   `NEEDS-USER.md`, tell the user what to review. **Never commit.**

Each entry's `planPath` points at that feature's plan-mode file — no copy for a same-session build. Only
caveat: a build *resumed long after* could hit a pruned plan-mode file — for a long roadmap, snapshot
each plan (§3).

**Testing approach** (decide with the user, bake into Test Strategy): backend / API / MCP tool / data →
**unit tests** (often TDD: failing tests first). Frontend → usually **not** unit tests; pick
chrome-devtools-mcp, mcp-inspector, playwright, curl, or manual.

## 3. Pre-run setup (your job — no setup agent, #4)

Before `phase:"build"`:
- **Clean the unstaged tree — now engine-enforced.** The blind reviewer reviews the unstaged diff as
  "this feature's work." Staged work from a *prior accepted* feature is a fine baseline, but the
  unstaged tree must be empty: on round 1 the developer's FIRST act (before reading the plan) is
  `git diff --name-only` + `git status --porcelain`, and any non-zero count halts the run **before a
  reviewer is spawned** — nothing built, nothing changed. Still settle a dirty tree with the user
  BEFORE you start (`git add -A` to keep it as baseline, `git stash -u` to set it aside): finding out
  at run time costs a spawn.
- **Fresh vs. resume.** `DISMISSED-<id>.md`/`NEEDS-USER.md` are cumulative: clear `runs/<runId>/` for a
  genuinely new run; **preserve** it on resume.
- **Each plan's `gate`** from its `## Gate` line: `green` (build + required verification) or `build-only`
  (the feature legitimately has no test/verification). Default `green`.
- **Long roadmap (spanning days)?** Snapshot each approved plan to `plans/<runId>/<id>.md` (beside
  `runs/`, gitignored) and point that entry's `planPath` there (a stated-purpose copy per #11) —
  plan-mode files may be pruned before a late resume. NEVER snapshot into `runs/<runId>/`: reviewers
  are handed paths into that dir, and the blind reviewer must have no path that reaches a plan (#3).
- **`root` — REQUIRED** (both phases): the absolute base run-state hangs off, normally the tool's own
  directory so `runs/` lands beside the tool, not in the target repo. Omit it → the engine errors.
  For a roadmap of blocks it must ALSO be this checkout: the block command an agent runs is
  `<root>/tools/plan-block.mjs`. Point `root` at a bare scratch directory and every unit fails to get
  its plan (loudly — see `plan_obtained` below).

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
green   # build + the required verification pass  (or: build-only). Becomes this plan's `gate` — a
        # top-level `gate` arg for one feature, or the entry's `gate` in a `plans` roadmap.
```

**A roadmap** is that same body, once per feature, under a `## Plan: <id> — <title>` header:

```markdown
## Plan: session-store — redis-backed session table

## Feature
...as above, through ## Gate...

## Plan: login-endpoint — POST /session

## Feature
...
```

`<id>` is a kebab slug and the only routing key. **Only a `## Plan:` header ends a block** — the body
keeps its `##` headers unchanged, so a single-feature plan pastes into a roadmap as-is. That boundary
is a parser's, not an agent's: `tools/plan-block.mjs` slices the block and prints it verbatim, which is
what each developer and acceptance verifier is handed. Check a roadmap before you run it —
`plan-block.mjs <file> --list` throws on a duplicate id, a non-kebab id, an empty body or a missing
gate, all of which would otherwise surface mid-build. A working sample: `tests/fixtures/roadmap-sample.md`.

## 5. Roles (in the engine)

The JS conductor sequences `agent()` calls, passing only control signals (#1). Each agent is fresh and
throwaway.

- **Plan Critic** (refine · opus) — read-only; greps the repo, verifies the plan's file list +
  integration points; returns gaps/questions/too_big.
- **Developer** (build · opus) — gets its plan from the `plan-block.mjs` command (§4) or its own
  `planPath`, reads the latest flagging review verbatim; implements
  minimally, **wires it in**, runs the gate green, leaves work **UNSTAGED**. Owns the **decision
  matrix**: fixes what's real, logs declines to `DISMISSED-<id>.md`, escalates user-only calls to
  `NEEDS-USER.md` (halts only on a hard blocker).
- **Quality Reviewer** (build · sonnet) — **blind**: no plan/spec/goal, reviews ONLY the unstaged diff
  for introduced production-blocking defects. Reads `DISMISSED-<id>.md` + `NEEDS-USER.md`, never prior
  review files. Writes `quality-review-<id>-rN.md`. Must be clean to proceed.
- **Acceptance Verifier** (build · opus) — **plan-aware** final gate: every criterion (enumerated and
  evidenced with locators), reachability, full gates, regression vs the staged baseline. Writes
  `acceptance-review-<id>-rN.md`. Only agent that stages (`git add`), on pass — the baseline advances
  plan by plan.
- **Park** (build · develop tier) — runs only when a plan can't accept: saves its work to
  `parked-<id>.patch`, copies untracked strays to `parked-<id>-newfiles/`, clears the tree, re-runs the
  build gate, and writes the restore instructions to `NEEDS-USER.md`. Never touches the staged baseline.

## 6. Loop & contracts (keep intact)

`develop → quality (blind, must be clean) → acceptance (plan-aware; stages on pass)`, up to `maxRounds`
(default 4), **per plan in roadmap order**. A flagging review hands the developer that one file's path
next round; **any code change re-enters at quality.**

- **Staging = the cycle boundary; each accepted feature stages once.** Staged = accepted baseline (prior
  features); unstaged = the current feature's work (the reviewers' scope). Only acceptance stages, only
  on pass — the baseline then advances to the next plan. Nothing is ever committed.
- **A plan that does not accept within `maxRounds` is PARKED — and the roadmap CONTINUES.** Park saves
  that plan's work to `runs/<runId>/parked-<id>.patch` (`git diff --binary`, so binary files re-apply),
  copies any untracked strays the patch can't carry into `parked-<id>-newfiles/`, clears the tree,
  re-runs the build gate, and appends the diagnosis + the verbatim restore command
  (`git -C <repo> apply --3way <patch>`) to `NEEDS-USER.md`. Nothing is discarded, and save always
  precedes clear — no patch, no clear. Clearing is the *point*: it restores the clean staging boundary
  the next plan's blind diff needs. Final status `roadmap complete with N plan(s) parked`, plus a
  `parked:[{ id, patch, strays, status }]` array in the result.
- **An agent that never got its plan halts the run.** The block command runs in the *agent's* shell, so
  the engine cannot verify it (the harness has no tools). Both the developer and the acceptance verifier
  report `plan_obtained`, and an explicit `false` halts with `BLOCKED (an agent could not obtain its
  plan — nothing was built from a guess)` — before any reviewer spawns, work parked. Causes, likeliest
  first: the command not permitted in the run environment (pre-allowlist
  `Bash(node <root>/tools/plan-block.mjs:*)`, since a background run cannot answer a prompt), an id
  matching no `## Plan:` block, or a pruned/mistyped plan file. Run the command yourself — its non-zero
  exit names the cause. A *dead* agent is deliberately not folded in here (the check is `=== false`).
- **What still stops the run.** A hard blocker escalated to `NEEDS-USER.md` (parked first, then stopped —
  only the user can unblock it); a park that couldn't clear the tree or left the build red
  (`BLOCKED (a parked plan left the tree unsafe — inspect before resuming)`); acceptance **passed but did
  not stage** (NOT parked — one `git add` both preserves the work and cleans the tree, so parking would
  be strictly worse; stage its files, resume from the NEXT plan id); a **dirty baseline** on round 1 (NOT
  parked — that work is the user's, and parking it would take their changes hostage; §3); and acceptance
  that **staged while the same verdict reported `regression:true`** (`BLOCKED (a plan staged while
  self-reporting a regression — inspect the staged diff before continuing)`) — that plan keeps its
  `done (staged)` status, but the roadmap stops there, because its work is now the baseline every later
  plan would be judged against. That case is neither re-reviewed (acceptance already ran `git add`) nor
  parked (park must never touch the staged baseline): you inspect `git diff --cached`. Every exit
  leaves a clean tree except passed-but-unstaged (one `git add` from clean); a park that can't manage it
  halts with the status above instead of carrying on.
- **Gates are the per-stack adapter.** `args.gates.build`/`test` are literal shell commands; `build`
  (lint/compile) must ALWAYS pass. `green` = build + required verification pass *and* the existing suite
  isn't reddened (breaking existing tests is a regression); `build-only` = build green only. Each plan
  carries its own `gate`.
- **Two-stage review = blind then plan-aware** — keep separate (deliberate de-biasing, #5); never hand
  the plan to the quality reviewer (per-plan files keep even a roadmap placement-blind for the others).
- **Anti-spin (#5).** The developer logs each decline as one terse line in `DISMISSED-<id>.md`; reviewers
  skip settled items for the stated reason. A reviewer that thinks a dismissal is wrong raises
  `CONTESTS DISMISSAL:` once; the developer must fix or escalate, never silently re-dismiss. Rising
  `dismissed_count` (in the run log) is your spin signal — audit `DISMISSED-<id>.md` at the end.
- **Frontend/MCP verification.** The developer drives the configured method in-loop; acceptance
  re-confirms once. If the tool is unavailable in the run env, acceptance records it and returns
  `pass=false` — run that check yourself, with the user, before blessing the feature.

## 7. Verify ground truth yourself

The engine reports `status`/`staged`/`reachable`/`regression`, plus `parked` and the per-plan `ledger`.
Confirm:
- Run the gates for real; the existing suite is still green.
- `git -C <repo> diff --cached`; `git status --porcelain` + read new files (`git diff` omits new files).
  Except after a passed-but-unstaged halt, `status --porcelain` should show nothing unstaged.
- Grep each feature's integration point — it is actually reachable.
- Read the latest `acceptance-review-<id>-rN.md` per plan (per-criterion verdict); **audit each
  `DISMISSED-<id>.md`** for bad calls.
- Any plan the `ledger` flags `thinEvidence` (no criteria enumerated, criteria unmet, or a pass whose
  criteria carry no locators) passed on assertion rather than evidence — read that file closely.
- Any plan the `ledger` flags `contradicted` returned `pass:true` next to `regression:true` or
  `reachable:false` — a verdict that contradicts its own schema. The regression case also halts the run;
  an unreachable "pass" does not, so grep that integration point yourself.
- Every `parked` entry: its patch exists and is non-empty, and `NEEDS-USER.md` says why it parked.
- Surface `NEEDS-USER.md`.

## 8. Resume (no progress file by design, #6/#10)

Durable progress = git staging + the numbered review-file trail + the ordered `plans`. Running out of
rounds is no longer a stop — that plan parks and the roadmap continues. The run ends early only on
`BLOCKED (needs user input)`, `BLOCKED (working tree was not clean — nothing was built)`,
`BLOCKED (a plan passed but was not staged — stage it, then resume)`, `BLOCKED (a plan staged while
self-reporting a regression — inspect the staged diff before continuing)`, `BLOCKED (a parked plan left
the tree unsafe — inspect before resuming)`, `BLOCKED (an agent could not obtain its plan — nothing was
built from a guess)`, or `stopped on token budget (resume where it left off)`.
1. Read the trail + `git -C <repo> diff --cached --stat` to see which features are staged/accepted, and
   the result's `parked` array (or `NEEDS-USER.md`) for which parked — their work is in a patch, not
   the tree.
2. Hard blocker → read `NEEDS-USER.md` / the plan's latest review, resolve with the user. Passed-but-
   unstaged → stage that plan's files yourself first (the one exit that leaves work in the tree).
3. **Preserve `runs/<runId>/`** and re-invoke `phase:"build"` with the same args **plus
   `startAt:"<first not-yet-accepted plan id>"`** (or `runOnly:[ids]` for an explicit subset). An id
   matching no plan now **throws** — copy it from the roadmap. To force a fresh run, clear
   `runs/<runId>/` and start from a clean tree.
4. **A parked plan's work is in its patch, not the tree.** Sharpen its plan file, then re-run just that
   plan (`runOnly:["<id>"]`) — the developer rebuilds it from the clean staged baseline. Restore
   `parked-<id>.patch` first ONLY if the partial work is worth continuing from, and note the cost: the
   round-1 check then sees a dirty tree, so you must `git add -A` it in (it enters as UN-reviewed
   baseline). Otherwise restore the patch and finish that feature by hand, or drop it.

Use `runOnly:[firstFewIds]` for a cheap first slice of a roadmap before committing to the whole thing.

## 9. Gotchas

- **Verify what the runner actually ran.** Some test runners silently ignore extra path args, so a
  multi-file selector runs only the first file and falsely passes. The engine fails the gate on
  `tests_run_count==0` for a unit selector (a required field, so it can't be omitted to dodge the check)
  — sanity-check the count, and scope one file per invocation or use the runner's filter. Manual/MCP →
  `tests_run_count` is `-1`; confirm the behavior was observed.
- **Custom `agentTypes` must exist in the user's registry** — defaults use the standard subagent.
- **Stray `runs/` in the target repo** = `root`/`stateDir` pointed into it. Point `root` at the tool's
  dir, relocate the stray state, re-run.
- **A "passed but not staged" plan halts on purpose** (so the next feature's diff isn't corrupted) —
  stage its files yourself (`git add`), resume from the NEXT plan id. It is deliberately NOT parked:
  the work is good, and one `git add` both preserves it and cleans the tree.
- **A parked plan's work is NOT in the tree** — it's in `runs/<runId>/parked-<id>.patch` (plus
  `parked-<id>-newfiles/` when it created untracked strays, which need a manual copy-back as a second
  step). `NEEDS-USER.md` carries the diagnosis and the exact `git apply --3way` command. A park is a
  status record, not a dismissal: nothing was discarded.
- **`too_big`** (from refine, or you realize mid-plan) → split into multiple bounded feature-plans and
  run them as a roadmap (`plans`); a pattern across many call sites goes to `migrate-cycle` instead.

## 10. State files (`runs/<runId>/`, gitignored)

The numbered review files are the inter-agent messages + progress trail; the developer's two file kinds
are its only non-code output. No `PLAN-REVIEW.md` (refine returns in the result), no `progress.json`.
- `quality-review-<id>-rN.md` — blind findings for plan `<id>`, round N.
- `acceptance-review-<id>-rN.md` — per-criterion table + reachability + regression + gate result.
- `DISMISSED-<id>.md` — the plan's declined findings, one terse line each; **you audit before committing.**
- `NEEDS-USER.md` — global cumulative user notes; a hard blocker here halted the run, and every parked
  plan has a `## Parked plan: <id>` entry with its diagnosis + restore command.
- `parked-<id>.patch` — a parked plan's saved work (`git diff --binary`); restore with
  `git -C <repo> apply --3way <patch>`.
- `parked-<id>-newfiles/` — only when the plan left untracked strays the patch can't carry; copy them
  back into the repo (relative paths preserved) as a second step after the `git apply`.

(Long-roadmap plan snapshots live at `plans/<runId>/<id>.md` BESIDE `runs/` — never inside
`runs/<runId>/`, which reviewers read; #3, §3.)

(A single-feature run uses id `feature` → `quality-review-feature-r1.md`, `DISMISSED-feature.md`, …)

Report when done: status + which features are staged, which **parked** (and where each patch is), the
suite result (you ran it), each wired in/reachable, `NEEDS-USER.md`, the latest acceptance verdicts,
anything in a `DISMISSED-<id>.md` worth a second look. **Never commit** — tell the user to review
`git diff --cached` and commit.

## 11. Args reference

Full schema + defaults: the Config block atop `feature-cycle.mjs` (the canonical source). Pass `args`
inline to `Workflow`.
- **Required:** `runId` · `root` (§3) · a plan — **either** `plans` (the roadmap: an ordered array
  `[{ id, gate }]` whose bodies are `## Plan: <id>` blocks in the top-level `planPath`, or
  `[{ id, planPath|plan, gate }]` with a body per entry; array order = build order; `id` is a stable
  kebab slug + the only routing key, the body is read verbatim, `gate` is `green`|`build-only`; an
  entry with no body **and** no top-level `planPath` **throws** — that combination used to hand the
  developer an empty plan and build nothing while reporting success) **or** a
  single top-level `planPath` (absolute) / `plan` (inline markdown) for one feature (back-compat;
  synthesized as one plan `id:"feature"`) · `target.repo` (absolute path to the git repo — **throws** if
  missing; there is no default, so a typo can't silently retarget the tool's own repo) · `gates.build`
  (shell command; **throws** if missing — an unset build command would no-op the build gate) +
  `gates.test` (**throws** when any plan's gate is `green`; a `build-only` plan needs no test command).
  Non-zero exit = fail.
- **Optional:** `phase` (`refine`|`build`, default `build`; refine takes the single top-level
  `planPath`/`plan` and never reads `plans` — it **throws** if neither is set)
  · `gate` (§3; the single-plan gate — for a roadmap each entry carries its own) · `planContext` (per
  `plans` entry: `block`, the default, hands that agent the `plan-block.mjs` command so only its own
  block is in context; `full` hands the whole roadmap file with the block named, for a feature that
  genuinely needs its neighbours in view) · `conventions` (the
  developer's rubric — language/version constraints, what stays additive, what NOT to touch; the blind
  reviewer is never shown it) · `reference` (path to a completed example to mirror) · `gates.testSetup`
  (runner quirks, how to scope one test, run-as-user/container prefix, how to start a server) ·
  `target.lang`/`target.framework` (hints) · `maxRounds` (4) · `models` (per-role tier:
  plan/develop/quality/acceptance) · `agentTypes` (custom subagent per role — must exist in your
  registry) · `stateDir` (override `runs/<runId>`) · `runOnly`/`startAt` (§8, scope a partial slice of
  the roadmap by plan id) · `minPlanBudget` (token floor to start another plan; default 150k — stops
  cleanly between plans).
