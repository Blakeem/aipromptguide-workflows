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
title or grep pattern, not line number, since earlier blocks shift lines.

## 2. The flow

1. **Author the plan file** in the plan-bus format (§3), at `<root>/plans/<runId>/` — never inside
   `target.repo`, never under `runs/<runId>/`. Plan mode or direct authoring. A fix-mode file from
   debug's review skips to its triage (debug guide), then step 3.
2. **Refine it, then get approval.** Run the refine workflow on the file (`workflows/refine/CLAUDE.md`)
   until it converges, then the user approves the FINAL text. Approval comes after refine so the user
   signs off on what develop builds.
3. **Derive the args — never hand-type them:**
   `node <plan-block.mjs> <planPath> --list` prints
   `{ goal, ordered, suite, sweep, blocks: [{ id, title, mode, gate, status }] }`.
   Pass `goal`/`ordered`/`suite`/`sweep` through verbatim, and `plans` = the `blocks` rows. Rows carry
   no planPath: pass the file as the top-level `planPath` (the per-entry default), or decorate entries
   drawing from other files with their own. Pasting the `--list` object as `plans` throws.
4. **Clean the unstaged tree, then launch.** The engine builds the `status: todo` blocks in file
   order; `done`/`skip`/`parked`/`blocked` are never selected.
5. **Verify ground truth (§6), then sync statuses.** Save the run's returned result as JSON (for
   example `<stateDir>/develop-result.json`) and run `node tools/plan-edit.mjs sync <that file>`. It
   applies the result's `statusSync` edits, all or nothing, and a second run changes nothing. The engine
   decides every value: an accepted or all-stale block → `done`, a park within the round budget →
   `parked`, every other halt or a fix block that closed nothing → `blocked`. Fix issues map FIXED →
   `fixed` only when their block landed, FIXED or FAILED in a block that did not land →
   `needs-attention`, STALE → `stale`, and SKIPPED keeps `open`. The plan file is the selection truth,
   git staging is the landed truth, and the sync is also the recovery step if a run dies between staging
   and sync. Flip `parked`/`blocked` back to `todo` after resolving, then relaunch.

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
  dirty tree first: `git add -A` to keep as baseline, `git stash -u` to set aside.
- **`root` REQUIRED**: the run-state base, outside the target repo. `blockTool` defaults to
  `<root>/tools/plan-block.mjs`; pass it explicitly when root is not a checkout, and pre-allowlist
  the command exactly as agents run it: `Bash(node '<blockTool>':*)`.
- **Fresh vs. resume:** clear `runs/<runId>/` for a new run; preserve on resume.

## 5. Roles

Same roles and contracts as the engines it replaces, with these merge-specific points:

- **Developer** — frame per block mode. Owns the decision matrix, `DISMISSED-<id>.md`,
  `AMENDED-<id>.md` (acceptance-only), `NEEDS-USER.md`. **Must attest `unstaged_confirmed` — a
  missing or false attestation now HALTS** (the staged index is surface neither reviewer checks).
- **Quality Reviewer** — blind by placement (`gate/` only). Skipped ONLY when the round produced
  nothing AND no prior review of the block is still open: a round that drops every finding cannot
  skip the gate past actively-flagged code (`qualityOpen`).
- **Acceptance Verifier** — frame per mode; carries the legitimate no-op branch in both modes (a
  block the staged baseline already satisfies passes without inventing changes). Only agent that
  stages.
- **Park** — saves then clears, never the other way. `ordered: false` → the run CONTINUES past a
  parked block; `ordered: true` → the run STOPS there (later blocks depend on it).
- **Sweep** (sonnet) — runs only when `sweep: goal-coverage` AND every non-skip block is done
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
passed-unstaged, acceptance-regression, park-unsafe, budget) plus `staging-unconfirmed`. Every exit
leaves a clean tree except passed-but-unstaged. Verify ground truth yourself after every run: run the
gates, `git diff --cached`, grep integration points, read the latest acceptance reviews, audit every
`DISMISSED-<id>.md` and `AMENDED-<id>.md`, surface `NEEDS-USER.md` and `SWEEP.md`.

## 7. Resume

Durable state = git staging + the plan file's status lines + the review-file trail. After syncing
statuses (§2.5), a relaunch with the same derived args rebuilds pending from `todo` — no startAt
needed in the common case (`runOnly`/`startAt` still work as explicit overrides, unknown ids throw).
A parked block's work is in `parked-<id>.patch`, not the tree; sharpen its block, flip it to `todo`,
relaunch.

## 8. State files (`runs/<runId>/`, outside every repo)

`gate/quality-review-<id>-rN.md` · `acceptance-review-<id>-rN.md` · `gate/DISMISSED-<id>.md` ·
`AMENDED-<id>.md` · `NEEDS-USER.md` · `parked-<id>.patch` (+ `parked-<id>-newfiles/`) · `SWEEP.md`.

## 9. Args reference

Full schema + defaults: the Config block atop `develop-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `plans` (non-empty array of `{ id, planPath?, mode, gate, status,
  planContext? }`; malformed **throws** naming the shape) · a `planPath` per entry or the top-level
  `planPath` default (**throws** naming the id with neither) · `target.repo` (**throws** if missing) ·
  `gates.build` (**throws** if missing) · `gates.test` (**throws** when any PENDING block's gate is
  `green` — deliberately pending-scoped, so an all-done relaunch reaches its terminal).
- **File keys:** `ordered` (boolean) · `suite` (`green|scoped`) · `sweep` (`goal-coverage|none`) ·
  `goal` (string). Typed illegal values **throw** — copy what `--list` prints. `sweep: goal-coverage`
  with an empty `goal` **throws**.
- **Return:** `status` · `halted`/`haltReason` · `plansDone` · `parked` · `ledger` (per block, with
  per-issue `results` in fix mode) · `statusSync` (the plan-file edits for §2 step 5) · `sweep` /
  `sweepFailed` · `followups`.
- **Optional:** `blockTool` · `planContext` per entry (`block` default | `full`) · `conventions` ·
  `reference` · `gates.testSetup` · `target.lang`/`framework` · `maxRounds` (1–50, **throws** on
  garbage) · `minPlanBudget` (**throws** on non-numbers) · `models`/`agentTypes`
  (develop/quality/acceptance opus, sweep sonnet) · `stateDir` · `runOnly`/`startAt`.
- An all-non-todo `plans` array returns `nothing to run (no todo blocks)` — not an error.
