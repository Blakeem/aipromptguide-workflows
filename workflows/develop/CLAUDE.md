# develop-cycle — operator guide (for Claude)

`develop-cycle.mjs` builds the **todo blocks of ONE approved plan file** in one target git repo. Each
`## Plan: <id>` block carries its own `mode`, which picks the frames the engine holds: `feature` (one
bounded feature, wired in and reachable), `section` (one slice of a breadth-spanning goal, every call
site converted) or `fix` (one issue inventory from debug's review or your own testing, ACTIONABLE
entries only). Per block: `develop → blind quality → plan-aware acceptance`, **staging each accepted
block** before the next. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`; follow those before changing the engine.

## 1. Scope (check FIRST)

Right-size per block, same bars as the engines it replaces: a `feature` block is one bounded feature
(~10–100+ lines plus tests); a `section` block is one coherent slice of one goal, roughly
feature-sized. Too small → just edit. A block too big for one develop pass → split it before running.
Hand-written documentation stays out of blocks (no defect class for the blind reviewer; write docs
directly after the run and verify with a debug doc-accuracy pass). Generated files, such as a flow map
regenerated from an engine a block changes, belong to that block. Locate code in a block body by section
title or grep pattern, not line number, since earlier blocks shift lines. Make each block
self-contained. Every agent reads only its own block, so a path or instruction stated only in the file
preamble or another block never reaches it.

## 2. The flow

1. **Author the plan file** in the plan-bus format (§3), at `<root>/plans/<runId>/` — never inside
   `target.repo`, never under `runs/<runId>/`. Plan mode or direct authoring. A fix-mode file from
   debug's review skips to its triage (debug guide), then step 3.
2. **Refine it, then get approval.** Run the refine workflow on the file (`workflows/refine/CLAUDE.md`)
   until it converges, then the user approves the FINAL text. Approval comes after refine so the user
   signs off on what develop builds.
3. **Derive the args with `node <plan-edit.mjs> args <planPath> [<planPath> ...]`, never by hand.**
   It first folds every finished develop run's statuses into the plan files (below), then prints
   `{ goal, ordered, suite, sweep, plans }`, each `plans` row carrying its own `planPath`. Spread that
   object into the args. Several files make one run, as long as their file keys agree. When you know the
   last launch's Workflow run id (`wf_...`), pass `--expect <id>`: it fails loudly if that run's record is
   missing, which is the sign Claude Code moved or changed its run records. For fix-mode files, add
   `--pack <target.repo>`: it groups the todo fix blocks into passes of at most `--loc-cap` lines (default
   5000) of the files their open ACTIONABLE issues name, so one developer, one blind reviewer and one
   verifier build several small blocks. Each member keeps its own plan file and statuses.
4. **Clean the unstaged tree, then launch.** Clean it before step 3, run step 3 with
   `run_in_background`, and launch in the turn its notification starts (root `CLAUDE.md`, "Launch from
   a notification turn"). The engine builds the `status: todo` blocks in file order;
   `done`/`skip`/`parked`/`blocked` are never selected.
5. **Verify ground truth (§6).** The run's statuses reach the plan file on the next step 3, with no
   step of their own. develop logs each finished block's status edits, Claude Code keeps a run's logs in
   its run record even when the run fails or is stopped, and `args` applies every record newer than the
   file's `synced:` key, oldest first, all or nothing. The engine decides every value. An accepted or
   passed-but-unstaged block → `done`, a park within the round budget → `parked`, every other halt or
   a fix block whose report in round 1 was all SKIPPED or empty → `blocked`. A fix block whose report
   in round 1 was all STALE, or STALE plus SKIPPED, counts as accepted only once acceptance confirms
   each STALE claim. Fix issues map FIXED → `fixed` and STALE → `stale` only when their block landed
   and acceptance confirmed the claim. FAILED in any block → `needs-attention`. FIXED or STALE in a
   block that did not land, or a claim acceptance refuted → `needs-attention` too. SKIPPED keeps
   `open`. The
   plan file is the selection truth and git staging is the landed truth. Flip `parked`/`blocked` back to
   `todo` after resolving, then relaunch from step 3. Records are deleted after `cleanupPeriodDays` (30
   by default), so run step 3 within that window or the statuses of a finished run are lost.

## 3. Plan-file format

The grammar lives with the tool (`tools/CLAUDE.md`): optional frontmatter, file keys
(`goal`/`ordered`/`suite`/`sweep`), a `## Plan: <id> - <title>` header per block with a preamble run
(`mode`/`gate`/`status`, plus informational `test_selector`/`depends_on`), bodies read verbatim.
Gates per mode: `feature` takes `green | build-only`; `section` takes
`green | red-baseline | build-only`; `fix` takes `green` only. A file holding any section-mode block
defaults to `ordered: true`, `suite: scoped` and `sweep: goal-coverage`. A file whose sweep is
`goal-coverage` needs a `goal:` line, and `--list` fails without one. A fix block IS an issue inventory: its
`### [<id>]` entries are what the fix worker verifies and fixes (ACTIONABLE decisions only,
verify-first, vanished issues marked stale). debug's review.mjs writes these files; hand-authored
external inventories use the same shape.

## 4. Pre-run setup (your job — no setup agent)

- **Clean unstaged tree, engine-enforced** on round 1 (halts before any reviewer spawns). Settle a
  dirty tree first: `git add -A` to keep your own pre-existing edits as baseline, `git stash -u` to
  set aside. If the dirt is an interrupted develop run's unfinished block, never `git add -A` it (no
  reviewer passed it): `git stash -u` it and relaunch, or relaunch that run with `resumeFromRunId`.
- **`root` REQUIRED**: the run-state base, outside the target repo. `blockTool` defaults to
  `<root>/tools/plan-block.mjs`; pass it explicitly when root is not a checkout, and pre-allowlist
  the command exactly as agents run it: `Bash(node '<blockTool>':*)`.
- **Fresh vs. resume:** for a new run, clear develop's own state files (§8) under the state dir;
  preserve them on resume. Never clear a plan file or debug's `issues/`, which may share
  `runs/<runId>/`.

## 5. Roles

Same roles and contracts as the engines it replaces, with these merge-specific points:

- **Developer** — frame per block mode. Owns the decision matrix, `DISMISSED-<id>.md`,
  `AMENDED-<id>.md` (acceptance-only), `NEEDS-USER.md`. **Must attest `unstaged_confirmed`. A
  missing or false attestation HALTS, even beside a needs-user escalation** (the staged index is
  surface neither reviewer checks).
- **Quality Reviewer** — blind by placement (`gate/` only). Skipped ONLY when no work is owed a review
  (`reviewOwed`). A round that only re-runs a red gate, drops every finding or answers a failed
  acceptance cannot skip it past unreviewed, flagged or rejected code.
- **Acceptance Verifier** — frame per mode; carries the legitimate no-op branch in both modes (a
  block the staged baseline already satisfies passes without inventing changes). When no blind review
  has run for a feature or section block, any unstaged or untracked change fails acceptance. In fix
  mode, the same rule applies when no issue is claimed FIXED. Only agent that stages. Every defect it
  writes counts as a gap, including a regression the block prescribes or no current caller reaches.
  The developer never dismisses a regression. It fixes the regression, with an
  amendment when the block prescribes it, or escalates it with a default when the fix needs major
  changes outside the block's scope. The review file holds no notes section.
- **Park** — saves then clears, never the other way. `ordered: false` → the run CONTINUES past a
  parked block; `ordered: true` → the run STOPS there (later blocks depend on it). A needs-user
  escalation parks the same way and its block ends `blocked`. Every other escalation stops the run.
- **Sweep** (opus) — runs only when `sweep: goal-coverage` AND every non-skip block is done
  (launch-status `done` plus this run's accepted ids). Re-greps the surface from `goal`, runs the
  full gates, writes `SWEEP.md`. Advisory: a dead sweep sets `sweepFailed`, never halts.

## 6. Loop, gates & verification

`develop → quality (must be clean) → acceptance (stages on pass)`, up to `maxRounds` (default 4) per
block. Gate semantics per block: `green` = build + the block's verification passed
(`tests_run_count==0` is a false green) — and when `suite: green`, a reddened existing suite fails it
too; `suite: scoped` drops the whole-suite requirement (mid-run red is expected in a migration).
`red-baseline` (section mode) = authored tests fail for the right reason, count 0 fails.
`build-only` = build green.

Halts match the sibling engines (dirty baseline, needs-user, plan-unreadable, agent-dead,
passed-unstaged, acceptance-regression, park-unsafe, budget) plus `staging-unconfirmed`,
`rejected-staged`, `review-unwritten` and `log-cap`. `rejected-staged` means acceptance failed a block
but staged it, so inspect `git diff --cached` and unstage that block's files before resuming.
`review-unwritten` means a quality reviewer or acceptance verifier failed a block without confirming its
review file.
`log-cap` stops the run before a block once no room for a status line is left in the runtime's first
1,000 log lines, and a relaunch builds the rest. A block whose status lines overrun that room still
finishes. Its lines past 1,000 survive only in the return's `statusSync`, and the next block halts. When
that block was the last in a `sweep: goal-coverage` run, the run halts before the sweep. Every block is
then done, so a relaunch has nothing to build, and you verify coverage against the goal yourself. Every exit
leaves a clean tree except passed-but-unstaged and a `park-unsafe` halt whose park did not confirm a
clear. Verify ground truth yourself after every run: run the
gates, `git diff --cached`, grep integration points, read the latest acceptance reviews, audit every
`DISMISSED-<id>.md` and `AMENDED-<id>.md`, surface `NEEDS-USER.md` and `SWEEP.md`.

## 7. Resume

Durable state = git staging + the plan file's status lines + the review-file trail. A relaunch with
args from a fresh `plan-edit.mjs args` (never the previous args object) rebuilds pending from `todo`,
with the finished runs already applied — no startAt
needed in the common case (`runOnly`/`startAt` still work as explicit overrides, unknown ids throw).
A parked block's work is in `parked-<id>.patch`, not the tree, unless its park halted `park-unsafe`.
That halt reason and `followups` say where its work is. Sharpen its block, flip it to `todo` and
relaunch.

**Run killed mid-block** (operator stop, API error, dead Workflow): the unstaged tree is that block's
unreviewed work. Set it aside with `git stash -u` (or save `git diff --binary` plus untracked files to
the state dir), then relaunch clean. Never `git add -A` it.

## 8. State files (`runs/<runId>/`, outside every repo)

`gate/quality-review-<id>-rN.md` · `acceptance-review-<id>-rN.md` · `gate/DISMISSED-<id>.md` ·
`AMENDED-<id>.md` · `NEEDS-USER.md` · `parked-<id>.patch` (+ `parked-<id>-newfiles/`) · `SWEEP.md`.
An `<id>` past 60 characters keeps its first 51 characters and a hash of the whole id, so two long ids
that share a prefix get separate files.

## 9. Args reference

Full schema + defaults: the Config block atop `develop-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `plans` (non-empty array of `{ id, planPath?, mode, gate, status,
  planContext? }`, or a pass `{ id, mode: fix, gate, status, blocks: [{ id, planPath, issues }] }` from
  `--pack`; malformed **throws** naming the shape) · a `planPath` per entry or the top-level
  `planPath` default (**throws** naming the id with neither) · `target.repo` (**throws** if missing) ·
  `gates.build` (**throws** if missing) · `gates.test` (**throws** when any PENDING block's gate is
  `green` — deliberately pending-scoped, so an all-done relaunch reaches its terminal).
- **File keys:** `ordered` (boolean) · `suite` (`green|scoped`) · `sweep` (`goal-coverage|none`) ·
  `goal` (string). Typed illegal values **throw** — spread what `args` prints. `sweep: goal-coverage`
  with an empty `goal` **throws**.
- **Return:** `status` · `halted`/`haltReason` · `plansDone` · `parked` · `ledger` (per block, with
  per-issue `results` in fix mode) · `statusSync` (the plan-file edits, also logged per block for §2
  step 5) · `sweep` /
  `sweepFailed` · `followups`.
- **Optional:** `blockTool` · `planContext` per entry (`block` default | `full`) · `conventions` ·
  `reference` · `gates.testSetup` · `target.lang`/`framework` · `maxRounds` (1–50, **throws** on
  garbage) · `minPlanBudget` (**throws** on non-numbers) · `models`/`agentTypes`
  (every role opus) · `stateDir` · `runOnly`/`startAt`.
- An all-non-todo `plans` array returns `nothing to run (no todo blocks)` — not an error.
