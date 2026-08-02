# migrate-cycle — operator guide (for Claude)

`migrate-cycle.mjs` drives **ONE breadth-spanning goal** — a migration, version upgrade, framework port,
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

**Documentation is a POOR FIT as a section — keep it out of the plan** (same reasoning as
`feature-cycle`'s §1). The blind quality stage has no defect class to find in prose, and acceptance's
reachability and regression checks do not apply to markdown, so a docs section spends two review agents
to learn nothing. Land the code sections here, then write the docs directly and verify them with a
`debug` review pass under a doc-accuracy lens against the source — doc drift is a *defect*, and "every
claim vs. the code" is a closed inventory, so it converges. Name the docs needing updates in the plan so
they are not forgotten; do not make them a section.

**Size the sections BEFORE writing the plan, not at refine.** A `too_big` verdict from the plan critic
means the decomposition work is already spent. While still in plan mode, after grepping the change
surface, sanity-check each intended section against a **comparable artifact already in this repo**
(`wc -l` the nearest sibling): a section should be about one coherent change plus its tests. Split
anything larger up front — refine should be confirming your decomposition, not rejecting it.

## 2. The flow

Pick a `runId` now; reuse it. Loads by path: `scriptPath` = the absolute path to `migrate-cycle.mjs`,
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

**Plan mode is a judgment call — yours.** Default INTO `EnterPlanMode` when the goal is complex, when
the decomposition or gates need the user's answers, or when the migration touches something important
enough that the user should read the sectioned plan before anything runs — the approval gate is an
extra quality gate, spent where it matters. SKIP plan mode when the goal is simple, well understood, or
already planned — the user handed a finished sectioned plan, or the work is fully specified in context
— there their request (or standing instruction) is the approval. The user always has the final say:
asked to see the plan first → plan mode; told to run without them → skip it.

When you skip plan mode, everything else keeps its order:

1. **The plan lives at `plans/<runId>/<name>.md` under `root`, beside `runs/`.** A plan YOU author goes
   there directly (`## Section:` blocks, dependency order) — never inside `target.repo` and never under
   `runs/<runId>/`. A plan the USER handed you that sits anywhere a reviewer can reach — inside
   `target.repo`, or under `runs/<runId>/` — is snapshotted to that same place and the copy used as
   `planPath`: the blind reviewer must have no route to a plan (#3). Never edit the user's original —
   but do get it out of `target.repo`: snapshotting relocates the path you pass, not the file, and an
   untracked plan there halts round 1 on the clean-tree check while a tracked one stays readable by
   the blind reviewer.
2. `phase:"refine"` as usual; fold gaps into your plan file. Questions refine returns: user present →
   `AskUserQuestion`; unattended → resolve each conservatively against the plan's own text, say so in
   your report, and let `NEEDS-USER.md` catch what genuinely cannot proceed. `too_big:true` unattended
   → split the named section into more `## Section:` blocks and re-run refine.
3. `phase:"run"` unchanged.

## 3. The `sections` list (the one new arg vs feature-cycle)

`phase:"run"` requires **`sections`**: an **ordered** array `[{ id, title, gate }]` you extract from the
approved plan:
- **`id`** — a stable kebab slug matching a `## Section: <id>` header. The ONLY routing key; the body is
  read verbatim from the file (#1/#2 — never transcribed).
- **`title`** — logs/labels only.
- **`gate`** — `green` | `red-baseline` | `build-only` (§6). The harness can't read the plan, so this
  knob travels as control. An unrecognized value **throws** — it used to coerce to `green`, so a typoed
  `red_baseline` silently demanded the very tests a test-first section means to leave failing. Omit the
  field entirely to take the `green` default.
- **`planContext`** (optional) — `block` (default) hands that agent a `plan-block.mjs` command that
  prints ONLY its section, so a twelve-section plan never enters a developer's context; `full` hands
  the whole plan file with the section named, for a section that genuinely needs its neighbours in view.

Derive the whole list rather than typing it:
`node <plan-block.mjs> <planPath> --list --kind section` (`<root>/tools/plan-block.mjs` in a checkout;
from the installed plugin, the plugin's own copy — the same path you pass as `blockTool`) prints
`[{ id, title, gate }]` in
file order, and throws on a duplicate id, a non-kebab id, an empty section or a missing/invalid gate —
all of which would otherwise surface mid-run. **Only a `## Section:` header ends a section**, so the
`###` bodies are safe and a section can never be silently truncated at one of its own subheadings.

Everything else (`test_selector`, …) stays in the plan body. Order = dependency order.

## 4. Pre-run setup (your job — no setup agent, #4)

Before `phase:"run"`:
- **Clean the unstaged tree — now engine-enforced** (`git -C <repo> diff` empty before kicking off, and
  before any resume). Staged work from a prior accepted section is the correct baseline. On round 1 the
  developer's FIRST act (before reading the plan) is `git diff --name-only` + `git status --porcelain`;
  any non-zero count halts the run **before a reviewer is spawned** — nothing built, nothing changed.
  Still settle a dirty tree with the user BEFORE you start (`git add -A` to keep it as baseline,
  `git stash -u` to set it aside): finding out at run time costs a spawn.
- **`root` — REQUIRED** (both phases): the absolute base run-state hangs off — this checkout when run
  from a clone, or the persistent plugin data dir the skill resolves when run from the installed aipg
  plugin (never the plugin install dir itself: it is version-swapped on update, which would strand
  parked patches). Either way `runs/` lands outside the target repo. Omit it → the engine errors.
  The block command an agent runs defaults to `<root>/tools/plan-block.mjs` — correct for a checkout;
  from the installed plugin pass **`blockTool`** = the plugin's own `tools/plan-block.mjs` (the skill
  resolves it). A block command pointing at a dir with no `tools/` means every section fails to get
  its plan (loudly — see `plan_obtained` below).
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
- **Developer** (run · opus) — gets its `## Section:` block from the `plan-block.mjs` command (§3) and
  reads the latest flagging review verbatim;
  implements ONLY that section, **converts every call site it owns**, runs the section gate, leaves work
  **UNSTAGED**. Owns the matrix: declines → `DISMISSED-<id>.md`; a verified defect in what the plan
  prescribes (6a) → fixed + recorded in `AMENDED-<id>.md` (acceptance-only) with a pointer in
  `NEEDS-USER.md`; user-only → `NEEDS-USER.md` (halts on a
  hard blocker).
- **Quality Reviewer** (run · opus) — **blind**; reviews ONLY the unstaged diff for introduced
  production-blocking defects. Writes `quality-review-<id>-rN.md`. Must be clean to proceed.
- **Acceptance Verifier** (run · opus) — **plan-aware** section gate: criteria (enumerated and evidenced
  with locators), reachability, the section gate, regression vs the staged baseline. Writes
  `acceptance-review-<id>-rN.md`. Only agent that stages, on pass — the baseline advances.
- **Park** (run · develop tier) — runs only when a section can't accept: saves its work to
  `parked-<id>.patch`, copies untracked strays to `parked-<id>-newfiles/`, clears the tree, re-runs the
  build gate, writes the restore instructions to `NEEDS-USER.md`. Never touches the staged baseline.
- **Sweep** (after the final section · sonnet) — whole-goal check: re-greps the surface, runs the FULL
  gates, spot-checks the staged diff, writes `SWEEP.md`. Kept here (unlike the sibling `resolve-cycle`,
  whose sweep was deleted): this one **re-derives the whole change surface from the goal** by grep and
  finds coverage gaps no per-section agent could see, where resolve's only restated numbers the harness
  already had. Disable with `finalSweep:false`; it runs only on a full, unhalted run.

**Loop**, per section in order: `develop → quality (blind, must be clean) → acceptance (plan-aware;
stages on pass)`, up to `maxRounds` (default 4). Any code change re-enters at quality.

**A section that does NOT accept is PARKED, and the run STOPS there.** Park saves that section's work to
`runs/<runId>/parked-<id>.patch` (`git diff --binary`, so binary files re-apply), copies any untracked
strays the patch can't carry into `parked-<id>-newfiles/`, clears the tree, re-runs the build gate, and
appends the diagnosis + the verbatim restore command (`git -C <repo> apply --3way <patch>`) to
`NEEDS-USER.md`. Nothing is discarded, and save always precedes clear — no patch, no clear. The run
still stops (unlike `feature-cycle`, which parks and continues): sections are an ordered decomposition
of ONE goal, so section N+1 routinely depends on N having landed. Parking buys a clean, buildable tree
and a saved patch — not a continued run. Two exits deliberately do NOT park: a **dirty baseline** on
round 1 (that work is the user's; parking it would take their changes hostage) and acceptance **passed
but not staged** (one `git add` both preserves the work and cleans the tree, so parking would be
strictly worse). A third exit parks nothing either: acceptance that **staged while the same verdict
reported `regression:true`** (`BLOCKED (a section staged while self-reporting a regression — inspect the
staged diff before continuing)`) — that section keeps its `done (staged)` status, but the run stops,
because its work is now the baseline every later section builds on. It is neither re-reviewed
(acceptance already ran `git add`) nor parked (park must never touch the staged baseline): you inspect
`git diff --cached`. Every exit therefore leaves a clean tree except passed-but-unstaged — and a park
that reports it could NOT clear, which gets its own status (`BLOCKED (a parked section left the tree
unsafe — inspect before resuming)`) for you to clean up before resuming.

**An agent that never got its section halts the run.** The block command runs in the *agent's* shell, so
the engine cannot verify it (the harness has no tools). Both the developer and the acceptance verifier
report `plan_obtained`, and an explicit `false` halts with `BLOCKED (an agent could not obtain its
section — nothing was built from a guess)` — before any reviewer spawns, work parked. Causes, likeliest
first: the command not permitted in the run environment (pre-allowlist
the block command exactly as the agent runs it — the path is single-quoted, so the rule must match
that string: `Bash(node '<abs path to plan-block.mjs>':*)`, the path being
`<root>/tools/plan-block.mjs` or your `blockTool` value — since a background run cannot answer a
prompt), an id
matching no `## Section:` block, or a pruned/mistyped plan file. Run the command yourself — its non-zero
exit names the cause. A *dead* agent is deliberately not folded in here (the check is `=== false`) — it
has its own halt, next.

**An agent that comes back with NOTHING halts the run.** Any of the three per-round roles — developer,
quality reviewer, acceptance verifier — returning null (skipped or died) halts with `BLOCKED (an agent
returned nothing — it was skipped or died; re-invoke to replay it)`, work parked. A dead agent is not a
failed round: nothing is known about the tree either way. Untreated, a dead developer read as an ordinary
gate miss and burned the whole round budget into `parked (not accepted within round budget)` — pointing
you at the plan when the fix is a replay — and a dead reviewer sent the next developer to a review file
nobody wrote. Re-invoke with the same args/runId, passing the Workflow tool's `resumeFromRunId` to replay
the agents that did complete.

**Gate semantics** (per section — the suite may be intentionally RED mid-migration; "done" is judged on
the section's OWN selector, never whole-suite-green):
- `green` — build passes AND this section's selector tests RAN and PASSED (`tests_run_count==0` = a false
  green, fails the gate).
- `red-baseline` — build passes AND the authored tests FAIL for the expected reason (TDD red step; a
  valid, stageable "done"). `tests_run_count==0` fails this gate too: a selector that matched nothing
  exits non-zero and looks exactly like the intended red, so a false RED is caught the same way a false
  green is. `-1` (manual/MCP verification) stays legal.
- `build-only` — build passes; no test pass/fail requirement (mechanical/testless).
Build (lint/compile) must ALWAYS pass. Whole-suite regression is the acceptance verifier's job (vs the
staged baseline), not the scoped gate. `args.gates.build`/`test` are literal shell commands — the
per-stack adapter, the only thing that changes between stacks.

**Anti-spin (#5).** Declines → one terse line in the section's `DISMISSED-<id>.md`; reviewers skip
settled items for the stated reason. A wrong dismissal → `CONTESTS DISMISSAL:` once; the developer must
fix or escalate, never silently re-dismiss. Keep the two-stage review separate; never hand the plan to
the quality reviewer.

## 7. Verify ground truth yourself

The engine reports `status`/`sectionsDone`/`ledger`/`parked`/`sweep` — `parked` is
`[{ id, patch, strays, status }]` for the section that stopped the run (empty on a clean run). Confirm:
- Run the gates for real; each accepted section's selector is green (and the full suite, if the goal
  expects green at the end).
- `git -C <repo> diff --cached`; `git status --porcelain` + read new files (`git diff` omits new files).
  Except after a passed-but-unstaged halt, `status --porcelain` should show nothing unstaged.
- Grep each section's integration points — reachable, conversions complete (no call site on the old
  path).
- Read the latest `acceptance-review-<id>-rN.md` per section; **audit every `DISMISSED-<id>.md` and
  `AMENDED-<id>.md`** (an amendment = the developer overrode a plan clause it verified was defective —
  fold it back into the plan if you agree).
- Any section the `ledger` flags `thinEvidence` (no criteria enumerated, criteria unmet, or a pass whose
  criteria carry no locators) passed on assertion rather than evidence — read that file closely.
- Any section the `ledger` flags `contradicted` returned `pass:true` next to `regression:true` or
  `reachable:false` — a verdict that contradicts its own schema. The regression case also halts the run;
  an unreachable "pass" does not, so grep that section's integration points yourself.
- Read `SWEEP.md` (evidence, not a substitute for your own check); surface `NEEDS-USER.md`.

## 8. Resume (no progress file by design, #6/#10)

Durable progress = git staging + the numbered review-file trail + the ordered plan. Every exit leaves a
clean tree except passed-but-unstaged (and a park that reports it could NOT clear — the halt reason says
so), so a resume normally starts from the staged baseline.
1. Read the trail + `git -C <repo> diff --cached --stat` to see which sections are staged/accepted and
   which one stopped the run (the result's `parked` array and `NEEDS-USER.md` both name it; its work is
   in **its patch**, not the tree).
2. Hard blocker → read `NEEDS-USER.md` / the section's latest review, resolve with the user. Passed-but-
   unstaged → stage that section's files yourself first.
3. Re-invoke `phase:"run"` with the same args **plus `startAt:"<first not-yet-accepted section id>"`** (or
   `runOnly:[ids]` for an explicit subset). An id matching no section now **throws** — copy it from the
   `sections` list. A partial slice via `startAt`/`runOnly` skips the final sweep — run the full list
   once at the end to get it.
4. **The parked section's work is in `parked-<id>.patch`.** Default: sharpen that section of the plan
   and let the developer redo it from the CLEAN baseline (the patch stays as reference). The only
   alternative is to apply the patch and finish that section **by hand** — a resumed run requires a
   clean unstaged tree and halts on a dirty one, and `git add -A`-ing restored work is not a way around
   that (it folds UN-reviewed code into the accepted baseline, invisible to the blind reviewer).
   `parked-<id>-newfiles/`, when present, is a separate manual copy-back.

Use `runOnly:[firstFewIds]` for a cheap first slice before committing to the whole goal.

## 9. Gotchas

- **Verify what the runner actually ran.** Some test runners silently ignore extra path args, so a
  multi-file selector runs only the first file and gives a false green. The engine fails the gate on
  `tests_run_count==0` for a green OR red-baseline section (a required field, so it can't be omitted to
  dodge the check) — sanity-check it; scope one file per invocation or use the runner's filter.
- **`git diff` omits new files** — also `git status --porcelain` + read them.
- **Custom `agentTypes` must exist** in the user's registry — defaults use the standard subagent.
- **A "passed but not staged" section halts on purpose** (so the next section's diff isn't corrupted) —
  stage its files yourself (`git add`), resume from the NEXT section. It is deliberately NOT parked: the
  work is good, and one `git add` both preserves it and cleans the tree.
- **A parked section's work is NOT in the tree** — it's in `runs/<runId>/parked-<id>.patch` (plus
  `parked-<id>-newfiles/` when it created untracked strays, which need a manual copy-back as a second
  step). `NEEDS-USER.md` carries the diagnosis and the exact `git apply --3way` command. A park is a
  status record, not a dismissal: nothing was discarded, and the sections after it were not attempted.
- **A halt is usually** a bad gate command, a missing dependency the plan assumed (a consumer before its
  producer — reorder the plan), or a real design question. Fix the root cause, resume from that section.
- **`too_big`** → split the named section, update `sections`, re-run refine.
- **A plan file inside `target.repo`** now draws its own ⚠ warning at run start — the blind reviewer
  must have no route to a plan (#3). Move it under `<root>/plans/` (the snapshot rule in §2).
- **Stray `runs/` in the target repo** = `root`/`stateDir` pointed into it. Point `root` back at your
  run-state base — the checkout, or the plugin data dir the skill resolved (never the plugin install
  dir) — relocate the stray state, re-run.

## 10. State files (`runs/<runId>/`, outside every repo)

The numbered review files are the inter-agent messages + progress trail; the developer's two file kinds
are its only non-code output. No `tasks.json`/`progress/`/`LEDGER.md`/`CHANGELOG.md`/`PLAN-REVIEW.md`.
- `quality-review-<id>-rN.md` — blind findings for section `<id>`, round N.
- `acceptance-review-<id>-rN.md` — per-criterion table + reachability + regression + gate result.
- `DISMISSED-<id>.md` — the section's declined findings, one terse line each; **you audit before
  committing.**
- `NEEDS-USER.md` — global cumulative user notes; a hard blocker here halted the run, and a parked
  section has a `## Parked section: <id>` entry with its diagnosis + restore command.
- `parked-<id>.patch` — the parked section's saved work (`git diff --binary`); restore with
  `git -C <repo> apply --3way <patch>`.
- `parked-<id>-newfiles/` — only when the section left untracked strays the patch can't carry; copy them
  back into the repo (relative paths preserved) as a second step after the `git apply`.
- `SWEEP.md` — the final whole-goal completeness sweep.

Report when done: status + which sections are done and which parked (and where its patch is), the suite
result (you ran it), each section wired in / fully converted, what's staged, `NEEDS-USER.md`, the latest
acceptance verdicts, anything in a `DISMISSED-<id>.md` worth a second look, the `SWEEP.md` result.
**Never commit** — tell the user to review `git diff --cached` and commit.

## 11. Args reference

Full schema + defaults: the Config block atop `migrate-cycle.mjs` (the canonical source). Pass `args`
inline to `Workflow`.
- **Required:** `runId` · `root` (§4) · `planPath` (absolute) **or** `plan` (inline markdown) ·
  `sections` (§3, for `phase:"run"`) · `target.repo` (absolute path to the git repo — **throws** if
  missing; there is no default, so a typo can't silently retarget the tool's own repo) · `gates.build`
  (shell command; **throws** if missing — an unset build command would no-op the build gate) +
  `gates.test` (**throws** when any section's gate is `green`; a run of purely mechanical `build-only`
  sections needs no test command). Non-zero exit = fail.
- **Optional:** `phase` (`refine`|`run`, default `run`) · `blockTool` (absolute path to
  `plan-block.mjs`; default `<root>/tools/plan-block.mjs` — required in practice when `root` is not
  this checkout, e.g. the installed plugin's data dir; §4) · each section's `planContext` (§3; `block`
  default, `full` to hand over the whole plan file) · `conventions` (the developer's rubric —
  language/version constraints, what stays additive, what NOT to touch; the blind reviewer is never shown
  it) · `reference` (path to a completed example to mirror) · `gates.testSetup` (runner quirks, how to
  scope one test, run-as-user/container prefix) · `target.lang`/`target.framework` (hints) · `maxRounds`
  (4; **throws** unless it is a number in 1–50 — it used to coerce, and a NaN bound parked the first
  section without ever spawning a developer) · `models` (per-role tier:
  develop/quality/acceptance/refine/sweep) · `agentTypes` (custom subagent
  per role — must exist in your registry) · `stateDir` (override `runs/<runId>`) · `runOnly`/`startAt`
  (§8, scope a partial slice; an unknown id throws) · `finalSweep` (default true; `false` skips the
  whole-goal sweep) · `minSectionBudget` (token floor to start another section; default 150k — stops
  cleanly between sections; **throws** on a non-number, including `""`/`false`/`[]`, which all coerce to a
  legal `0` and would silently disable the floor — and it is validated in **both** phases, so a bad value
  is rejected by `refine` even though only `run` reads it).
