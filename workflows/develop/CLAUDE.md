# develop-cycle — operator guide (for Claude)

`develop-cycle.mjs` builds the **todo blocks of ONE approved plan file** in one target git repo. Each
`## Plan: <id>` block carries its own `mode`, which picks the frames the engine holds: `feature` (one
bounded feature, wired in and reachable), `section` (one slice of a breadth-spanning goal, every call
site converted) or `fix` (one issue inventory from debug's review or your own testing, ACTIONABLE
entries only). Per block: `develop → blind quality → plan-aware acceptance`, **staging each accepted
block** before the next. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`; follow those before changing the engine.

## 1. Scope (check FIRST)

Right-size each block by behavior, never by line count. A block holds one behavior a reviewer can
judge as a unit. A `feature` block's behavior is one entry point (a verb, a command, an endpoint or an
added function) with its failure and recovery paths. A `section` block's behavior is one slice of the
goal whose call sites convert and are accepted together. Behaviors that can each be accepted alone are
separate blocks, listed in dependency order with `ordered: true` set when one builds on another. Too
small, such as a one-liner or a rename → just edit.
A block may edit hand-written documentation. Acceptance judges a doc edit only against the block's
acceptance criteria or fix entries, so name each doc change a block owes in one of them. Generated
files, such as a flow map regenerated from an engine a block changes, belong to that block. Locate code
in a block body by section title or grep pattern, not line number, since earlier blocks shift lines.
Make each block self-contained. Every agent reads only its own block, so a path or instruction stated only in the file
preamble or another block never reaches it. A block states the goal, the user's decisions, and the choices that must
agree across blocks or with the repo that a developer working one block cannot see, such as names, data shapes, file
locations and which existing pattern to follow. Everything else is the developer's call. Split work into blocks whose
code is complete on its own, such as a new key together with the code that reads it. Never split by layer, where an
earlier block adds code only a later block uses. That block's blind reviewer flags the half-built behavior as
incomplete, and the developer cannot dismiss it with a reason the code shows.

## 2. The flow

1. **Author the plan file** in the plan-bus format (§3), at `<root>/plans/<runId>/` — never inside
   `target.repo`, never under `runs/<runId>/`. Plan mode or direct authoring. A fix-mode file from
   debug's review skips to its triage (debug guide), then step 3.

   **Research novel work first.** Before writing the blocks for work that adds a dependency, calls an
   external API, uses a technique the repo does not use yet, or touches security or data integrity,
   send a research subagent. Each block it informs records, in that block, what the repo already does
   (its file and a section title or grep pattern, never a line number, per §1), the library or method
   chosen with its source, and each command or API behavior the block prescribes with its source or a
   probe. Routine work in an existing repo pattern skips this. A large open question goes to the
   investigate or docs workflow first.
2. **Refine it, then get approval.** Run the refine workflow on the file until it returns `converged`,
   under the run-once rule in `workflows/refine/CLAUDE.md` §2 step 3, then the user approves the FINAL
   text. Approval comes after refine so the user signs off on what develop builds.
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
   a fix block whose report in round 1 was all SKIPPED or empty → `blocked`. The exception: an accepted
   block whose verdict also reported a regression (halt `acceptance-regression`) syncs `blocked` while
   its work stays staged. Its FIXED and STALE issues sync `needs-attention`, as in a block that did not
   land, and §6 says how to resolve both. A fix block whose report
   in round 1 was all STALE, or STALE plus SKIPPED, counts as accepted only once acceptance confirms
   each STALE claim. Fix issues map FIXED → `fixed` and STALE → `stale` only when their block landed
   and acceptance confirmed the claim. FAILED in any block → `needs-attention`. FIXED or STALE in a
   block that did not land, or a claim acceptance refuted → `needs-attention` too. SKIPPED keeps
   `open`. The
   plan file is the selection truth and git staging is the landed truth. After resolving a `parked` or
   `blocked` block, run step 3 (it applies the finished run's statuses), then set the block's `status:`
   back to `todo`, then run step 3 again for the launch args. An `acceptance-regression` block whose
   staged work you keep is the exception: §6 sets it `done`, never `todo`. A flip made before the first step 3 is
   overwritten by the run's own status edit. Records are deleted after `cleanupPeriodDays` (30
   by default), so run step 3 within that window or the statuses of a finished run are lost.

## 3. Plan-file format

The grammar lives with the tool (`tools/CLAUDE.md`): optional frontmatter, file keys
(`goal`/`ordered`/`suite`/`sweep`), a `## Plan: <id> - <title>` header per block with a preamble run
(`mode`/`gate`/`status`/`model`, where `model` is `opus | sonnet`, the block's developer model, plus
informational `test_selector`/`depends_on`), bodies read verbatim.
Gates per mode: `feature` takes `green | build-only`; `section` takes
`green | red-baseline | build-only`; `fix` takes `green` only. A file holding any section-mode block
defaults to `ordered: true`, `suite: scoped` and `sweep: goal-coverage`. A file whose sweep is
`goal-coverage` needs a `goal:` line, and `--list` fails without one. A fix block IS an issue inventory: its
`### [<id>]` entries are what the fix worker verifies and fixes (ACTIONABLE decisions only,
verify-first, vanished issues marked stale). `--list` fails on a `todo` fix block with no `### [<id>]`
entry. debug's review.mjs writes these files; hand-authored external inventories use the same shape.

**Choosing a block's developer model.** Set `model:` on each block while writing the plan. The user may
override it. Judge by how many layers of abstraction the block crosses and how much logic it holds.
`sonnet` takes common work: backend changes, minor frontend changes, interface or design changes that
are not major, a new API endpoint or MCP tool, simple interface features or updates, and fixes from a
debug inventory. `opus` takes complex logic, security work, mission-critical code, and changes that need
an understanding of deeper layers of abstraction. When unsure, leave the line out, so the run's
`models.develop` applies. The blind reviewer, acceptance and the sweep always run on the run's review
models. Show each block's model in the approval summary.

## 4. Pre-run setup (your job — no setup agent)

- **Clean unstaged tree, engine-enforced** on round 1 (halts before any reviewer spawns). Settle a
  dirty tree first: `git add -A` to keep your own pre-existing edits as baseline, or set the dirt aside
  without touching the staged index, which holds every accepted block. To set it aside, first remove
  the untracked build output and caches (they regenerate). If `git status --porcelain` then lists no
  `??` file and `git diff` is empty, the tree is settled. Otherwise mark each remaining `??` untracked
  file with `git -C <repo> add -N -- <file>`, save `git -C <repo> diff --binary` to a new patch under
  the run's state dir, creating that dir if needed (the patch carries the new files too), and confirm
  the patch exists and is non-empty. Save before you clear: if it does not, stop and clear nothing.
  Then restore the modified tracked files with `git -C <repo> checkout -- <files>`, drop each
  intent-to-add file with `git -C <repo> rm -f -q -- <file>`, and confirm `git status --porcelain`
  lists no `??` file, `git diff` is empty and `git diff --cached` is unchanged. Restore it later with
  a plain `git -C <repo> apply <patch>`, never `--3way`, which stages what it restores. An unpathed
  `git reset`, `git rm` or `git stash` touches the staged baseline. If the dirt is an interrupted
  develop run's unfinished block, never `git add -A` it (no reviewer passed it): set it aside and
  relaunch. A dirty-baseline halt records its block `blocked`, so after settling the tree run §2
  step 3, set that block's `status:` back to `todo`, and run step 3 again for the launch args.
- **`root` REQUIRED**: the run-state base, outside the target repo. `blockTool` defaults to
  `<root>/tools/plan-block.mjs`; pass it explicitly when root is not a checkout, and pre-allowlist
  the command exactly as agents run it: `Bash(node '<blockTool>':*)`.
- **Relaunch vs. new run:** relaunch a halted or parked run with the same `runId` and no
  `resumeFromRunId`, so its ledgers, `NEEDS-USER.md` and `DECISIONS.md` carry over. Every develop run
  of one plan, or of one debug review's issue files, keeps that `runId`. Unrelated new work takes a new `runId`, and so
  does a block that already landed and is built again from scratch, so its old `DISMISSED-<id>.md`
  stays out. Never clear the state dir (§8), a plan file or debug's `issues/`.

**Choosing the change policy.** `changePolicy` sets each blind review's bar, which findings a developer
fixes, and how far it may change code past its block. Under `strict`, every blind review hunts at
`medium`, or `high` in a block's last allowed round, and never hunts or reports a finding below its
bar. Under `proactive`, a block's blind reviews in a launch hunt at `low`, then `medium`, then `high`,
or `high` in its last allowed round, and each review that finds something also dives below its bar,
down to nit.
`strict` aims for working code that stays close to the task. A strict developer checks its own diff
only for findings at `medium` or above and for regressions at any tier. It changes code only in the
code its block's required changes add, change or interact with, or in a fix block the code each fix
touches and the sibling paths of each root cause. It fixes a critical, high or security finding in
code its block adds or changes. When that fix conflicts with the plan, it fixes the finding only
after it verifies the plan is defective, and logs an amendment. It weighs a medium against its cost.
It logs each fix of a defect the staged baseline already had to `DECISIONS.md` as a `STRICT` line.
`proactive` aims for the best code. A proactive developer builds each feature and section block with
the change that has the best long-term result. It fixes a clear win at any tier and makes clear-win
refactors in the code a block reaches. A fix block keeps each fix as its entry instructs, and that
extra work stays inside the code each fix touches. Past those bounds it changes code only to close a
defect a review file names, or the same defect on a sibling path of one or of a required fix, apart
from code the block's text excludes or another block of the plan owns. It logs each change past its
block's own work to `DECISIONS.md` as a `PROACTIVE` line. Under both policies, acceptance excuses a
logged fix from its regression check only when it lies inside the developer's bounds, the behavior
it removes was a defect, and nothing else changed. Every logged fix, apart from a proactive fix
block's, must also lie in no code another block of the plan owns. Acceptance judges a fix past the
proactive bounds as a removed defect. Every developer prompt says the policy and the prompt's own
scope rules override any other instruction about scope, a memory line or a CLAUDE.md included.
Settle a run's policy in these steps, where `<change-policy.mjs>` is this checkout's
`tools/change-policy.mjs`.

- A policy the user names for a run wins.
- Otherwise, before §2 step 1, run `node <change-policy.mjs> check --root <root> --repo <target.repo>`
  and use the policy it prints. The tool keys a repo by its main checkout, so a worktree takes its
  main checkout's policy.
- On `missing <key> recommend=<policy>`, ask the user once which policy the repo takes. List the
  recommended policy first, marked recommended, with one line for each policy:
  - `strict`: working code that stays close to the task.
  - `proactive`: the best code, with a clear win fixed at any tier and clear-win refactors made in the
    code a block reaches.

  Then save the answer with `node <change-policy.mjs> set --root <root> --repo <target.repo> --policy <answer>`.
- When `check` or `set` exits 1, show the user its message, which names the cause, and run the step
  again once the cause is fixed.
- Show the policy in the approval summary.

## 5. Roles

Same roles and contracts as the engines it replaces, with these merge-specific points:

- **Developer** — frame per block mode. Owns the decision matrix, `DISMISSED-<id>.md`,
  `AMENDED-<id>.md` (read by acceptance and the sweep, never the blind reviewer), `NEEDS-USER.md`,
  `DECISIONS.md`. It follows the repo's existing patterns before it writes, and checks its own diff with
  the blind reviewer's severity scale, reach step and checklist before handoff. It fixes and weighs
  findings as the change policy sets (§4). It logs every finding it routes and does not fix, so none is
  dropped silently. A dismissal names one place or the class of places it covers, and its reason holds
  for every place it names. It escalates only a choice that changes user-visible behavior, stored data
  or a public contract and that nothing it can read or check settles, or a blocker it cannot resolve in
  scope. One it cannot proceed without goes to `NEEDS-USER.md`. A default it took goes to
  `DECISIONS.md`, beside each plan amendment pointer. When it fixes a finding or makes a fix the block
  requires, it greps for every sibling path with the same mechanism and fixes each one, at any tier,
  inside its policy's bounds (§4). Under `strict` it logs every other sibling. Under `proactive` it
  fixes one past those bounds only as §4 allows, and logs the others. Under both, it logs a sibling in
  code the block's text excludes or that another block of the plan owns. Under both policies, a real
  defect at low or above that it logs because the defect lies outside its policy's bounds, under rule 2
  or as a sibling path, also goes to its block's `<root>/plans/<runId>/NEW-ISSUES-<block id>.md` as a
  `NEEDS_USER` entry `<block id>-noticed-<n>` in debug's issue-file shape, so a later run can fix it. A
  false positive, a nit and a defect in code another block owns get no entry. In a pass, the entry goes
  to the file of the member whose entry's fix led to the defect. The dismissal line stays, since the
  blind reviewer never reads a NEW-ISSUES file. When a fix it logs to `DECISIONS.md` closes a defect
  that an entry in any NEW-ISSUES file holds, it adds a `**Closed by:**` line to that entry and leaves
  the entry's status and decision as they are, since a park clears the fix from the tree. Triage then
  confirms the staged code holds the fix before it skips the entry. **Must attest
  `unstaged_confirmed`. A missing or false attestation HALTS, even beside a needs-user escalation**
  (the staged index is surface neither reviewer checks).
- **Quality Reviewer** — blind by placement (`gate/` only). It receives the conventions and reviews
  at a severity bar the change policy sets. A block's last allowed round hunts at `high` under both
  policies, since no round is left to fix a smaller finding. Otherwise `strict` hunts at `medium` on
  every review, and `proactive` hunts at `low` on a block's first review in a launch, `medium` on its
  second and `high` on every later one. The count restarts in each launch, so a block continued from its
  parked patch starts at `low` again. It works through a reach step over callers, siblings, duplicates and
  describing text, and a lens checklist. A `proactive` review dives below its bar, down to nit, only when
  its hunt found something at or above it. A `strict` review neither hunts nor reports a finding below its
  bar, and its checklist, like a strict developer's self-check, drops the maintainability item (the nit
  list). It also flags a new sentence that the
  repo's code contradicts. Skipped ONLY when no work is owed a review (`reviewOwed`). A round that
  only re-runs a red gate, drops every finding or answers a failed acceptance cannot skip it past
  unreviewed, flagged or rejected code.
- **Acceptance Verifier** — frame per mode; carries the legitimate no-op branch in both modes (a
  block the staged baseline already satisfies passes without inventing changes). When no blind
  review has run for a feature or section block, any unstaged or untracked change fails acceptance.
  In fix mode, the same rule applies when no issue is claimed FIXED. Only agent that stages. It
  reads every earlier review file of its block and counts an earlier finding as a gap unless the
  code closes it on every sibling path or the dismissal ledger declines it. Every defect it writes
  in its review file counts as a gap, including a regression the block prescribes or no current
  caller reaches. A change that removes a defect a review finding named, or the same defect on a
  sibling path of a required fix or of such a finding, is not a regression when the code shows the
  removed behavior was a real defect, the change alters no other behavior, the block's text does not
  exclude that code, and no other block of the plan owns it. Under `strict`, the change must also
  lie inside the developer's bounds (§4). For a continued block, that rule also counts the findings
  of the review files its parks kept in `parked-<id>-reviews/`. The developer never dismisses a
  regression. It fixes the regression, with an amendment when the block prescribes it, or escalates
  it with a default when the fix needs major changes outside the developer's bounds (§4). The review
  file holds no notes section. In fix mode, a harm an entry lists whose cause shares no code path
  with the re-derived root cause is a new issue, never a gap. A sibling path with the identical
  defect stays a residual path. The verifier appends a new issue to its source block's
  `<root>/plans/<runId>/NEW-ISSUES-<block id>.md`, a fix-mode plan file with every entry
  `NEEDS_USER`. The verifier and the developer start a new file with one header,
  `## Plan: <block id>-new-issues - defects found outside the block's work`, then `mode: fix`,
  `gate: green` and `status: todo`. The return counts both writers' entries in `newIssues` and names
  each file in `newIssueFiles`.
  Triage a block's file like a debug issue file once that block is `done` or `skip`.
- **Park** — saves then clears, never the other way. `ordered: false` → the run CONTINUES past a
  parked block; `ordered: true` → the run STOPS there (later blocks depend on it). A needs-user
  escalation parks the same way and its block ends `blocked`. Every other escalation stops the run.
  Park marks the block's new files intent-to-add, so its one patch carries them. A second park of a
  block renames the earlier patch to `parked-<id>.prev<n>.patch`. The restore command park writes is
  a plain `git apply`, which leaves the work unstaged. A relaunch rewrites the round-numbered review
  files, so park copies the block's review files, when it has any, into a new
  `parked-<id>-reviews/<k>/` folder, and its `NEEDS-USER.md` entry names the copy of the diagnosis.
- **Sweep** (opus) — runs only when `sweep: goal-coverage` AND every non-skip block is done
  (launch-status `done` plus this run's accepted ids). Re-greps the surface from `goal`, runs the
  full gates, writes `SWEEP.md`. Advisory: a dead sweep is the `failed` entry
  `{ id: 'sweep', stage: 'sweep' }`, never a halt.

## 6. Loop, gates & verification

`develop → quality (must be clean) → acceptance (stages on pass)`, up to `maxRounds` (default 5) per
block. Each review's bar follows the change policy. `strict` hunts at `medium`, `proactive` at `low`,
then `medium`, then `high` by review in a launch, and a block's last allowed round hunts at `high` under
both. Only a `proactive` review that finds something dives below its bar, down to nit. A finding below a review's bar never sends a block back on its own, unless the developer
neither fixed nor logged it, which acceptance counts as a gap. Gate semantics per block: `green` = build + the block's verification passed
(`tests_run_count==0` is a false green) — and when `suite: green`, a reddened existing suite fails it
too; `suite: scoped` drops the whole-suite requirement (mid-run red is expected in a migration).
`red-baseline` (section mode) = authored tests fail for the right reason, count 0 fails.
`build-only` = build green.

Halts match the sibling engines (dirty baseline, needs-user, plan-unreadable, agent-dead,
passed-unstaged, acceptance-regression, park-unsafe, budget) plus `staging-unconfirmed`,
`rejected-staged`, `review-unwritten`, `passed-regression` and `log-cap`. `rejected-staged` means
acceptance failed a block but staged it, so inspect `git diff --cached` and unstage that block's files
before resuming. `passed-regression` means acceptance passed a block but flagged a regression and
staged nothing. Its work is parked and the block ends `blocked`. Never stage that work as it is.
`acceptance-regression` means acceptance staged a block while its verdict flagged a regression, so
inspect `git diff --cached`. To keep the work, run §2 step 3, then set the block's `status:` to `done`.
Then set each fix issue that the acceptance file named in the halt reason confirmed closed to `fixed`
or `stale`, as §2 step 5 maps a landed block's issues. To reject it, unstage the block's files, set
them aside as §4 describes, run §2 step 3, then set the block's `status:` to `todo`. Either way, run
step 3 again for the launch args.
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
`DISMISSED-<id>.md` and `AMENDED-<id>.md`, surface `NEEDS-USER.md`, `DECISIONS.md`, the files in
`newIssueFiles` and `SWEEP.md`.

**Research NEEDS-USER before asking.** For each unanswered question the blocks named in `nextStep`
wrote to `NEEDS-USER.md`, park records under `## Parked block: <id>` excluded, read the code, the docs
and the conventions it touches, and send a research subagent to the web when the answer rests on an
outside fact. Settle each question the evidence settles, and record the evidence. Ask the user only
the rest, each with a recommendation. Show the settled ones too, with their evidence, so the user can
overrule them.

## 7. Resume

Durable state = git staging + the plan file's status lines + the review-file trail. A relaunch with
args from a fresh `plan-edit.mjs args` (never the previous args object) rebuilds pending from `todo`,
with the finished runs already applied. `runOnly` is the one explicit slice, and an unknown id throws.
When the run-record fold is unavailable (records past `cleanupPeriodDays`, or `--expect` fails), recover
with `runOnly` or by editing the statuses in the plan file. A `resumeFromRunId` replay of a run launched
with a retired arg throws at launch.
A parked block's work is in `parked-<id>.patch`, not the tree, unless its park halted `park-unsafe`.
That halt reason and `nextStep` say where its work is. Sharpen its block, run §2 step 3 (it applies
the finished run's statuses), set the block's `status:` back to `todo`, then run step 3 again for the
launch args and relaunch.
To continue a parked block under full review instead of redoing it, add `continueParked: ["<id>"]` by
hand to the args `plan-edit.mjs args` prints. That tool does not print it. The block's round-1
developer restores the patch into the unstaged tree after the clean-baseline check. A patch that no
longer applies parks the block as `blocked` and leaves its patch untouched, so redo that block. A park
from an older engine may also hold a `parked-<id>-newfiles/` directory, which `continueParked` does not
restore. Finish that block by hand or redo it.

**Run killed mid-block** (operator stop, API error, dead Workflow): the unstaged tree is that block's
unreviewed work. Set it aside with §4's save-and-clear, which saves it to a patch under the state dir
and leaves the staged index alone, then relaunch clean. Never `git add -A` it.

## 8. State files (`runs/<runId>/`, outside every repo)

`gate/quality-review-<id>-rN.md` · `acceptance-review-<id>-rN.md` · `gate/DISMISSED-<id>.md` ·
`AMENDED-<id>.md` · `NEEDS-USER.md` · `DECISIONS.md` · `parked-<id>.patch` ·
`parked-<id>.prev<n>.patch` (an earlier park of the same block) · `parked-<id>-reviews/<k>/` (the
review files one park of the block kept) · `SWEEP.md` · `scratch/` (the agents' plan
block copies and test logs, never in `gate/`).
An `<id>` past 60 characters keeps its first 51 characters and a hash of the whole id, so two long ids
that share a prefix get separate files.

## 9. Args reference

Full schema + defaults: the Config block atop `develop-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `plans` (non-empty array of `{ id, planPath, mode, gate, status,
  model? }` rows that `plan-edit.mjs args` prints, or a `--pack` pass `{ id, mode: fix, gate, status,
  model?, blocks: [{ id, planPath, issues }] }`. Malformed **throws** naming the shape. A row with no
  `planPath` **throws** naming it. A `model` outside `opus | sonnet` **throws** naming the row.) · `target.repo` (**throws** if missing) ·
  `gates.build` (**throws** if missing) · `gates.test` (**throws** when any PENDING block's gate is
  `green` — deliberately pending-scoped, so an all-done relaunch reaches its terminal).
- **File keys:** `ordered` (boolean) · `suite` (`green|scoped`) · `sweep` (`goal-coverage|none`) ·
  `goal` (string). Typed illegal values **throw** — spread what `args` prints. `sweep: goal-coverage`
  with an empty `goal` **throws**.
- **Return:** `status` · `halted`/`haltReason` · `regression` (true when any block's ledger entry reads
  true. An entry follows the last acceptance verdict that reports the field, and a passing verdict that
  omits the field sets it false) · `plansDone` · `parked` · `ledger` (per block, with a
  status of the form `<token> (<meaning>)`, the developer `model` it ran on, and per-issue `results` in
  fix mode) · `statusSync` (the
  plan-file edits, also logged per block for §2 step 5) · `sweep` · `failed`
  (`{ id: 'sweep', stage: 'sweep' }` when the sweep ran and died, else empty, so `sweep: null` with no
  entry means the sweep did not run) · `newIssues` (every mode, the entries developers and fix
  verifiers appended, null when one returned no usable report) · `newIssueFiles` (the sorted
  NEW-ISSUES files the developers and fix verifiers named, null when `newIssues` is null) · `nextStep`.
- **Optional:** `blockTool` · `conventions` ·
  `reference` · `gates.testSetup` · `target.lang`/`framework` · `maxRounds` (1–50, default 5, **throws** on
  garbage) · `changePolicy` (`strict|proactive`, default `strict`, any other value **throws**. Each
  blind review's bar, which findings a developer fixes, and how far it may change code past its block,
  and §4 says how to choose it) ·
  `minPlanBudget` (**throws** on non-numbers) · `models`/`agentTypes`
  (keep the quality, acceptance and sweep roles on opus, and set another model for them only when the
  user asks. A saved memory preference counts as asking. The develop role is opus by default, and a
  block's `model:` line overrides `models.develop` for that block's developer and park agent, §3) ·
  `stateDir` · `runOnly` · `continueParked` (block ids whose round 1 restores the parked patch, §7.
  **Throws** on a non-array or an id outside the pending blocks).
- **Retired:** `startAt`, `reviewSeverity` (`changePolicy` sets every blind review's bar), a top-level
  `planPath` and `planContext` are retired and **throw**.
- An all-non-todo `plans` array returns `nothing to run (no todo blocks)` — not an error.
