# develop-cycle — operator guide (for Claude)

`develop-cycle.mjs` builds the **todo blocks of ONE approved plan file** in one target git repo. Each
`## Plan: <id>` block carries its own `mode`, which picks the frames the engine holds: `feature` (one
bounded feature, wired in and reachable), `section` (one slice of a breadth-spanning goal, every call
site converted) or `fix` (one issue inventory from debug's review or your own testing, ACTIONABLE
entries only). Per block: `develop → blind quality → plan-aware acceptance`, **staging each accepted
block**, and in commit mode committing it (§6), before the next. Built to
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
   object into the args, and add `backlogDir`, the folder that
   `node <project-settings.mjs> backlog --root <root> --repo <target.repo>` prints (§4, §10). Also add
   `models` and `efforts` from the JSON line `node <project-settings.mjs> roles --root <root> --repo <target.repo>`
   prints. A role the user names for the run wins over the repo's saved value. When the user names role
   settings to keep for the repo, save them with
   `node <project-settings.mjs> set-roles --root <root> --repo <target.repo> [--models <role>=<value>,...] [--efforts <role>=<value>,...]`,
   where the value `default` removes a role's saved value. The approval summary shows each role's model and
   effort and where each came from: the run, the block's `model:` or `effort:` line, the repo's saved settings,
   or the default. Several
   files make one run, as long as their file keys agree. When you know the
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
   its work stays staged or committed, and so does a commit-mode block whose commit did not land as
   asked (§6, "Commit mode"). Their FIXED and STALE issues sync `needs-attention`, as in a block that did not
   land, and §6 says how to resolve both. A fix block whose report
   in round 1 was all STALE, or STALE plus SKIPPED, counts as accepted only once acceptance confirms
   each STALE claim. Fix issues map FIXED → `fixed` and STALE → `stale` only when their block landed
   and acceptance confirmed the claim. FAILED in any block → `needs-attention`. FIXED or STALE in a
   block that did not land, or a claim acceptance refuted → `needs-attention` too. SKIPPED keeps
   `open`. The
   plan file is the selection truth and git staging, or HEAD in commit mode, is the landed truth. After resolving a `parked` or
   `blocked` block, run step 3 (it applies the finished run's statuses), then set the block's `status:`
   back to `todo`, then run step 3 again for the launch args. A block whose staged or committed work you
   keep after `acceptance-regression` or a commit-mode pass halt is the exception: §6 sets it `done`, never `todo`. A flip made before the first step 3 is
   overwritten by the run's own status edit. Records are deleted after `cleanupPeriodDays` (30
   by default), so run step 3 within that window or the statuses of a finished run are lost.

## 3. Plan-file format

The grammar lives with the tool (`tools/CLAUDE.md`): optional frontmatter, file keys
(`goal`/`ordered`/`suite`/`sweep`), a `## Plan: <id> - <title>` header per block with a preamble run
(`mode`/`gate`/`status`/`model`/`effort`, where `model` is `opus | sonnet | haiku | fable`, the block's developer model,
and `effort` is `low | medium | high | xhigh | max`, the block's developer reasoning level, plus
informational `test_selector`/`depends_on`), bodies read verbatim.
Gates per mode: `feature` takes `green | build-only`; `section` takes
`green | red-baseline | build-only`; `fix` takes `green` only. A file holding any section-mode block
defaults to `ordered: true`, `suite: scoped` and `sweep: goal-coverage`. A file whose sweep is
`goal-coverage` needs a `goal:` line, and `--list` fails without one. A fix block IS an issue inventory: its
`### [<id>]` entries are what the fix worker verifies and fixes (ACTIONABLE decisions only,
verify-first, vanished issues marked stale). `--list` fails on a `todo` fix block with no `### [<id>]`
entry. debug's review.mjs writes these files; hand-authored external inventories use the same shape.

**Choosing a block's developer model.** Set `model:` on each block while writing the plan. The user may
override it. Read the repo's saved `models.develop` first (`project-settings.mjs roles`, §2 step 3).
When it is saved, write a block's `model:` line only where the user asks for a different model for that block,
since the line overrides the saved value. A saved `efforts.develop` works the same way for `effort:`. Judge by how many layers of abstraction the block crosses and
how much logic it holds.
Sonnet and opus develop about equally well on most tasks, so `sonnet` takes common work: backend
changes, minor frontend changes, interface or design changes that are not major, a new API endpoint or
MCP tool, simple interface features or updates, and fixes from a debug inventory. `opus` takes complex
logic, security work, mission-critical code, and changes that need an understanding of deeper layers of
abstraction. `haiku` takes a bulk text replacement or a very simple change across the codebase. `fable`
runs only when the user asks for it, since the user controls how many tokens a run spends. When unsure,
leave the line out, so the run's `models.develop` applies. Show each block's model and effort in the approval
summary.

**Choosing the review roles' models.** Sonnet reviews worse than opus. The quality, acceptance and sweep
roles run on opus for a major feature or a risky change, and may run on sonnet for a low-risk change, such
as a doc or comment fix. Set them through `models` (§9).

**Reasoning level.** Every role runs at `high` unless `efforts` says otherwise (§9). A block may set `effort:`
beside `model:`, and sets it only when the user asks for a level other than the run's, since `high` suits every model.

## 4. Pre-run setup (your job — no setup agent)

- **Clean unstaged tree, engine-enforced** on round 1 (halts before any reviewer spawns). Settle a
  dirty tree first: `git add -A` to keep your own pre-existing edits as baseline (in commit mode, commit
  them as well), or set the dirt aside without touching the accepted baseline, which the staged index
  holds in stage mode and HEAD holds in commit mode. To set it aside, first remove
  the untracked build output and caches (they regenerate). If `git status --porcelain` then lists no
  `??` file and `git diff` is empty, the tree is settled. Otherwise mark each remaining `??` untracked
  file with `git -C <repo> add -N -- <file>`, save `git -C <repo> diff --binary` to a new patch under
  the run's state dir, creating that dir if needed (the patch carries the new files too), and confirm
  the patch exists and is non-empty. Save before you clear: if it does not, stop and clear nothing.
  Then restore the modified tracked files with `git -C <repo> checkout -- <files>`, drop each
  intent-to-add file with `git -C <repo> rm -f -q -- <file>`, and confirm `git status --porcelain`
  lists no `??` file, `git diff` is empty and `git diff --cached` is unchanged. Restore it later with
  a plain `git -C <repo> apply <patch>`, never `--3way`, which stages what it restores. An unpathed
  `git reset`, `git rm` or `git stash` touches the index, which holds the accepted baseline. If the dirt is an interrupted
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

**Choosing the change policy.** `changePolicy` sets the developer's build aim and whether it fixes a
pre-existing defect it notices in the code its block's changes connect to. The engine defines three code zones, and
every developer and acceptance prompt renders that one definition:
- Task code is the code the block's required changes add or change. Every line such a change adds or
  changes is task code in full, so a pre-existing finding on such a line is a task code finding. In a
  fix block, that holds for every line an ACTIONABLE entry's fix adds or changes, and task code also
  holds the sibling paths of each ACTIONABLE entry's root cause, apart from code the block's text
  excludes or another block of the plan owns.
- Connected code is the code a reach step from the task code finds, which is its callers and consumers,
  its sibling paths, duplicates of its logic and the text that describes it. Code the block's text
  excludes and code another block of the plan owns are never connected code.
- Other code is everything else.

Under both policies, the developer hunts only task code and fixes every finding there at every tier, a
defect the accepted baseline already had included. It also fixes each finding the diff introduces or
exposes in connected code. The developer reads connected code only to check its change's effects. It never
changes other code. It closes a finding the diff introduces or exposes there, such as a build break, at
its source in task or connected code, and escalates the finding when only a change in other code closes
it. A pre-existing finding is one, at any tier, that the accepted baseline already had and that the diff
neither introduces nor exposes. Each real pre-existing defect at low or above that the developer logs
because its zone routing leaves the defect unchanged, under the decision matrix's rule 2 or as a
sibling path (§5), apart from one in code another block owns, goes to the backlog (§10). The policies
differ as follows.
- `focused` aims for working code that stays close to the task. Its developer builds minimally and
  surgically. It leaves every pre-existing finding in connected code unchanged.
- `proactive` aims for the best code. Its developer builds each feature and section block with the
  change that has the best long-term result. In a feature or section block, it also fixes a pre-existing
  defect in connected code when the fix is low risk under the risk questions (§6). It leaves every other
  pre-existing finding there, such as a nit, unchanged. A fix block leaves each pre-existing finding in
  connected code unchanged, as under `focused`. The developer also records each cleanup outside task
  code that it noticed and did not make.

Each fix of a defect the accepted baseline already had that no criterion of the block or ACTIONABLE entry
requires gets one `FOCUSED <id>:` or `PROACTIVE <id>:` line in `DECISIONS.md`. Acceptance excuses such
a fix from its regression check only when it lies in a zone the policy lets the developer change, lies
in no code another block of the plan owns, removes a real defect, and alters no other behavior. Those
zones are task code and connected code where the fix closes a defect the diff introduces or exposes.
Under `proactive`, a feature or section block adds the rest of its connected code. Every developer
prompt says the policy and the prompt's own scope rules override any other instruction about scope, a
memory line or a CLAUDE.md included.
Settle a run's policy in these steps, where `<project-settings.mjs>` is this checkout's
`tools/project-settings.mjs`. The tool saves each repo's policy in `<root>/projects.json`. Its
`node <project-settings.mjs> backlog --root <root> --repo <target.repo>` prints the project's backlog
folder.

- A policy the user names for a run wins.
- Otherwise, before §2 step 1, run `node <project-settings.mjs> check --root <root> --repo <target.repo>`
  and use the policy it prints. The tool keys a repo by its main checkout, so a worktree takes its
  main checkout's policy.
- On `missing <key> recommend=<policy>`, ask the user once which policy the repo takes. List the
  recommended policy first, marked recommended, with one line for each policy:
  - `focused`: working code that stays close to the task.
  - `proactive`: the best code, with a low-risk fix of each defect noticed in the code a block's changes
    connect to.

  Then save the answer with `node <project-settings.mjs> set --root <root> --repo <target.repo> --policy <answer>`.
- When `check`, `set`, `roles` or `set-roles` exits 1, show the user its message, which names the cause, and run the step
  again once the cause is fixed.
- Show the policy in the approval summary.

## 5. Roles

Same roles and contracts as the engines it replaces, with these merge-specific points:

- **Developer** — frame per block mode. Owns the decision matrix, `DISMISSED-<id>.md`,
  `AMENDED-<id>.md` (read by acceptance and the sweep, never the blind reviewer), `NEEDS-USER.md`,
  `DECISIONS.md`. It works in six phases, in this order. PATTERNS finds how the repo already does the
  same kind of thing before it writes. BUILD builds the block, then runs the gate. In a feature or
  section block, a round that answers a review routes each finding and gap in that review through the
  decision matrix in place of the build. A fix block's round routes them beside its entry rules. A
  round after a red gate with no review builds again. HARDEN handles edge cases, gives each expected
  failure a message that names its cause, logs where the repo logs, adds a test for each risky path
  and cleans up the code its round added or changed, at every tier. SIBLINGS is the sibling rule
  below. SELF-REVIEW applies the blind reviewer's severity scale, reach step and checklist to the code
  its round changed or read. Code that earlier rounds changed and that its round neither changed nor
  read is outside the self-review, since each earlier round's self-review judged that round's code,
  and each blind review judges the entire block diff. CLASSIFY answers the risk questions (§6) for
  each change its round made, writes `risk-<id>-rN.md`, which starts with a snapshot of its round's
  tree (§6), and returns `review_needed`. Each phase after BUILD runs a targeted test while it
  works. The gate runs once more after the last phase that changed code, and that run's outcome is
  the one it reports. A phase with nothing to do for its round's changes is skipped. It routes each
  finding by the code zone it lies in, as §4 sets. It logs every finding it routes and does not fix,
  so none is dropped silently. A dismissal names one place or the class of places it covers, and its
  reason holds for every place it names. It escalates only a choice that changes user-visible
  behavior, stored data or a public contract and that nothing it can read or check settles, or a
  blocker it cannot resolve in scope. One it cannot proceed without goes to `NEEDS-USER.md`. A
  default it took goes to `DECISIONS.md`, beside each plan amendment pointer. In SIBLINGS, for each
  finding it fixes in any phase and each fix the block requires, it greps for every sibling path
  with the same mechanism and fixes each one, at any tier, that its zone routing fixes (§4). It logs
  every other sibling, and a sibling in code the block's text excludes or that another block of the
  plan owns. Under both policies, a real defect at low or above that it logs because its zone
  routing leaves the defect unchanged, under rule 2 or as a sibling path, also goes to its block's
  backlog file (§10), so a later run can fix it. Under `proactive` it also records there each
  cleanup outside task code that it noticed and did not make, such as a refactor or a nit. A false
  positive and anything in code another block owns get no entry, and under `focused` neither does a
  nit it drops that way. In a pass, the entry goes to the file of the member whose entry's fix led to it. The
  dismissal line stays, since the blind reviewer never reads a backlog file. When a fix it logs to
  `DECISIONS.md` closes a defect that an entry in any backlog file holds, it adds a `**Closed by:**`
  line to that entry and leaves the entry's status and decision as they are, since a park clears the
  fix from the tree. **Must attest `unstaged_confirmed`. A missing or false attestation HALTS, even
  beside a needs-user escalation** (the staged index is surface neither reviewer checks).
- **Quality Reviewer** — blind by placement (`gate/` only). It receives the conventions and reports
  every finding the diff introduces or exposes at every tier, from critical down to nit, under both
  policies. It works through a reach step over callers, siblings, duplicates and describing text,
  and a lens checklist that ends with the nit list. It also flags a new sentence that the repo's
  code contradicts. A review is clean when it holds no finding and no contested dismissal, and its
  file then reads `No findings.` It may contest a dismissal at any tier. §6 says which rounds it
  runs in.
- **Acceptance Verifier** — frame per mode; carries the legitimate no-op branch in both modes (a block the accepted baseline already satisfies passes without inventing changes). In fix
  mode, any unstaged or untracked change fails acceptance when no issue is claimed FIXED. Only agent
  that stages, and in commit mode the only agent that commits. It reads every earlier review file of its block and counts an earlier finding as a
  gap unless the code closes it on every sibling path or the dismissal ledger declines it. A ledger
  line whose reason starts `SKIPPED:` declines a finding, and acceptance may override it. A line
  whose reason starts `ESCALATED:` records a default routed to the user, and acceptance holds it. It
  audits the risk file of each round since the block's last blind review, against that round's own
  hunks (§6). When its verdict fails in the closing pass, the block parks with its review file as
  the diagnosis. Every defect it writes in its review file counts as a gap, including a regression
  the block prescribes or no current caller reaches. A change counts as required only when the
  block's text or the ACTIONABLE entry names it, so a break that a prescribed construction causes
  and the text does not name is a regression. A change that removes a defect a review finding named,
  or the same defect on a sibling path of a required fix or of such a finding, is not a regression
  when the code shows the removed behavior was a real defect, the change alters no other behavior,
  the block's text does not exclude that code, no other block of the plan owns it, and it lies in a
  zone the policy lets the developer change (§4). For a continued block, that rule also counts the
  findings of the review files its parks kept in `parked-<id>-reviews/`. The ledger copies there are
  not reviews. The developer never dismisses a regression. It fixes the regression, with an
  amendment when prescribed text causes it. It escalates the regression when that fix would change a
  choice the text says the user made, so the block parks with the user's question. It also escalates
  with a default when only a change in other code closes it (§4). The review file holds no notes
  section. In fix mode, a harm an entry lists whose cause shares no code path with the re-derived
  root cause is a new issue, never a gap. A sibling path with the identical defect stays a residual
  path. The verifier appends a new issue to its source block's backlog file (§10), and the entry's
  `**What:**` names the source issue id. The return counts both writers' entries in `backlogEntries`
  and names each file in `backlogFiles`. Work a block's file (§10) once that block is `done` or
  `skip`.
- **Park** — saves then clears, never the other way. `ordered: false` → the run CONTINUES past a
  parked block; `ordered: true` → the run STOPS there (later blocks depend on it). A needs-user
  escalation parks the same way and its block ends `blocked`. Every other escalation stops the run.
  Park marks the block's new files intent-to-add, so its one patch carries them. A second park of a
  block renames the earlier patch to `parked-<id>.prev<n>.patch`. The restore command park writes is
  a plain `git apply`, which leaves the work unstaged. A relaunch rewrites the round-numbered review
  files, so park copies the block's review files, its `DISMISSED-<id>.md` ledger and the run's
  `DECISIONS.md`, each when it exists, into a new `parked-<id>-reviews/<k>/` folder. It makes the folder
  when any of them exists. Park creates `NEEDS-USER.md` when it does not exist, and its entry names
  the copy of the diagnosis and the path of each plan file of the block. A round file that an agent's
  prompt does not name may come from an earlier launch of the block, so the agent ignores it.
- **Sweep** (opus) — runs only when `sweep: goal-coverage` AND every non-skip block is done
  (launch-status `done` plus this run's accepted ids). Re-greps the surface from `goal`, runs the
  full gates, writes `SWEEP.md`. Advisory: a dead sweep is the `failed` entry
  `{ id: 'sweep', stage: 'sweep' }`, never a halt.

## 6. Loop, gates & verification

`develop → quality (must be clean) → acceptance (stages on pass, and commits in commit mode)`, up to `maxRounds` (default 5) per
block, then one closing pass when the last round fails.

**Risk-gated review.** The developer's CLASSIFY phase answers four risk questions for each change its
round made:
- Systems: does the change need edits in more than one system to stay consistent?
- Paths: does it add or change many branches, loops, error paths or state transitions?
- Critical code: does it touch data writes, deletion, security, concurrency, a public contract, or code
  whose behavior is hard to follow?
- Assumptions: does it rest on a judgment call or an assumption that an input, a platform or a caller
  could falsify?

Each answer cites its evidence or is "no". A doubtful answer counts as yes, and a change is low risk
when every answer is no. The developer writes the answers to `risk-<id>-rN.md` and returns
`review_needed`, true when any change is not low risk. Each risk file starts with the line
`Snapshot: <tree id>`. The tree id is a snapshot of the round's working tree, which the developer
makes with `git add -A` and `git write-tree` on a temporary index file under `scratch/`, seeded with
a copy of the real index. The real index, which holds the accepted baseline, is never written. The blind review
runs in a block's first round with a satisfied gate in a launch, a block continued from its parked
patch included. A later round gets one when a round since the block's last blind review returned
`review_needed` true or no boolean, or an acceptance verdict since then returned
`risk_misclassified` true. Any other round goes from the developer straight to acceptance. Git holds
one cumulative unstaged diff, so acceptance reads each audited round's own hunks from two snapshots.
It runs `git diff <base> <snapshot>`, where `<snapshot>` is the line in that round's risk file and
`<base>` is the line in the risk file of the round before it. It checks each answer in the risk file
of each round since the last blind review against that round's hunks. A missing file, a missing
snapshot line in an audited round's file or in its base file, a change the file does not judge low
risk and an answer the hunks contradict are each a gap, and the verdict returns `risk_misclassified`
true, which sends the next round to a blind review.

**Closing pass.** When round `maxRounds` ends without a passed acceptance, one more developer runs,
with no blind review after it. It takes round number `maxRounds + 1` in its file names. It makes each
fix of the last review's findings and gaps that is low risk, and records each one whose fix is not as
an entry in its block's backlog file (§10), with a `**Fix:**` line naming the fix, a
`**Parked with:**` line naming the block and no DISMISSED line, under both policies. It returns those
entries' ids in `recorded_entries`. When the dedup forbids an append, it returns the id of the entry
that holds the item instead. When it listed no entry and no blind review is owed, acceptance runs
once more. A pass stages the block and a fail parks it. Otherwise the engine parks the block with the
closing pass's work in its patch, and the park entry in `NEEDS-USER.md` names each listed entry. A
block never reaches acceptance with a change that needs a blind review and has none.

Gate semantics per block: `green` = build + the block's verification passed
(`tests_run_count==0` is a false green) — and when `suite: green`, a reddened existing suite fails it
too; `suite: scoped` drops the whole-suite requirement (mid-run red is expected in a migration).
`red-baseline` (section mode) = authored tests fail for the right reason, count 0 fails.
`build-only` = build green.

Halts match the sibling engines (dirty baseline, needs-user, plan-unreadable, agent-dead,
passed-unstaged, acceptance-regression, park-unsafe, budget) plus `staging-unconfirmed`,
`rejected-staged`, `review-unwritten`, `passed-regression` and `log-cap`. Commit mode adds
`staged-baseline` and `commit-unverified`, which **Commit mode** below describes. `rejected-staged` means
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
then done, so a relaunch has nothing to build, and you verify coverage against the goal yourself. Every
exit leaves a clean tree except passed-but-unstaged, a commit-mode halt whose reason names the tree
dirty check, and a `park-unsafe` halt whose park did not confirm a clear.
Verify ground truth yourself after every run: run the gates, `git diff --cached` (in commit mode,
`git -C <repo> log --stat` over the run's commits), grep integration points, read the latest acceptance
reviews, audit every `DISMISSED-<id>.md` and `AMENDED-<id>.md`, surface `NEEDS-USER.md`, `DECISIONS.md`,
the files in `backlogFiles` and `SWEEP.md`.

**Commit mode.** With `commit: true`, acceptance stages each accepted block, then commits it with the
block's title as the entire message: it writes the title to `<stateDir>/commit-<id>.txt` and runs
`git -C <repo> commit -F` on that file. It never passes `--no-verify`, `--no-gpg-sign` or `--amend`, so
the repo's commit hooks and signing run. A legitimate no-op pass makes no commit. The accepted baseline
is HEAD, and nothing stays staged between blocks. Each commit lands on the branch the repo has checked
out, so run commit mode on a branch or in a worktree. Round 1 halts with `staged-baseline`, before any
reviewer, when files were staged before the block started, since the next commit would carry them
unreviewed. `git -C <repo> diff --cached --stat` lists them: commit or unstage them. A pass halts the
run with `commit-unverified` when its commit fails a landing check. The checks, in the order the halt
reason numbers them, are:
- not committed: the commit did not land. A hook or signing may have refused it, the work stays
  staged, and the hook output is in the acceptance file.
  `git -C <repo> commit -F <stateDir>/commit-<id>.txt` keeps the work.
- unverified sha: acceptance reported a commit whose `commit_sha` is not 40 or 64 hex digits, such as
  `"none"`, or is blank beside a subject or beside a `tree_matches` that is not true, since a no-op
  reports the reviewed tree. `git -C <repo> log -1 --stat` finds the commit, if any.
- wrong subject: the commit's subject is not the block's title. A commit-msg hook may have rewritten it.
- tree changed: the commit's tree is not the tree acceptance staged. A pre-commit hook may have
  rewritten and re-staged files.
- tree dirty: the tree is not clean after the commit step. A commit hook, the gate run, or a block file
  acceptance did not stage may have left the changes. `git -C <repo> status --porcelain` lists them.

The wrong subject and tree changed checks run only on a valid sha. The tree dirty check runs only when
`committed` is true, since a refused commit leaves its reviewed work staged. The reason names every failed check with
the value acceptance reported, then `git -C <repo> show --stat <sha>` on a valid sha. An
`acceptance-regression` reason on a commit-mode pass ends with the same list. `commit-unverified` syncs
the block `blocked`. Settle the work, run §2 step 3, then set the block's `status:` to `done` when the
accepted baseline holds its reviewed work, or to `todo` to rebuild it. For a fix block set to `done`,
also set each fix issue that its acceptance file confirmed closed to `fixed` or `stale`, as for
`acceptance-regression`. To reject a committed block after `acceptance-regression`, `commit-unverified` or
`rejected-staged`, run `git -C <repo> revert <sha>` in place of the unstage. Park is the same in both modes.
An acceptance verifier that dies may have committed or staged its block, which park never saves. Its
`agent-dead` reason names the HEAD the block started from. Before you relaunch, revert any newer commit
that `git -C <repo> log -1 --stat` shows and unstage what `git -C <repo> diff --cached --stat` lists.

**Research NEEDS-USER before asking.** For each unanswered question the blocks named in `nextStep`
wrote to `NEEDS-USER.md`, park records under `## Parked block: <id>` excluded, read the code, the docs
and the conventions it touches, and send a research subagent to the web when the answer rests on an
outside fact. Settle each question the evidence settles, and record the evidence. Ask the user only
the rest, each with a recommendation. Show the settled ones too, with their evidence, so the user can
overrule them.

## 7. Resume

Durable state = git staging (HEAD's commits in commit mode) + the plan file's status lines + the
review-file trail. A relaunch with args from a fresh `plan-edit.mjs args` (never the previous args
object) rebuilds pending from `todo`, with the finished runs already applied. `runOnly` is the one
explicit slice, and an unknown id throws.
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
Before you relaunch under `focused` a run that an engine from before the rename ran under `strict`,
rewrite each `STRICT <id>:` tag in its `DECISIONS.md` to `FOCUSED <id>:`. The acceptance and developer
prompts name only `FOCUSED <id>:` lines, so acceptance counts a fix logged under the old tag as a
regression.

**Run killed mid-block** (operator stop, API error, dead Workflow): the unstaged tree is that block's
unreviewed work. Set it aside with §4's save-and-clear, which saves it to a patch under the state dir
and leaves the staged index alone, then relaunch clean. Never `git add -A` it. In commit mode the killed
block's acceptance may have committed or staged its work, and no landing check read it. Before you
relaunch, revert a commit that `git -C <repo> log -1 --stat` shows with the killed block's title as its
subject, using `git -C <repo> revert <sha>`, and unstage what `git -C <repo> diff --cached --stat` lists.

## 8. State files (`runs/<runId>/`, outside every repo)

`gate/quality-review-<id>-rN.md` · `acceptance-review-<id>-rN.md` · `risk-<id>-rN.md` (the
developer's risk answers for round N, outside `gate/`, §6, starting with the line
`Snapshot: <tree id>`) · `gate/DISMISSED-<id>.md` · `AMENDED-<id>.md` · `NEEDS-USER.md` ·
`DECISIONS.md` · `commit-<id>.txt` (commit mode: the block's title, its commit's message) ·
`parked-<id>.patch` · `parked-<id>.prev<n>.patch` (an earlier park of the same block) ·
`parked-<id>-reviews/<k>/` (the review files one park of the block kept, and its copies of
`DISMISSED-<id>.md` and `DECISIONS.md`) · `SWEEP.md` · `scratch/` (the agents' plan block copies and
test logs, never in `gate/`).
An `<id>` past 60 characters keeps its first 51 characters and a hash of the whole id, so two long ids
that share a prefix get separate files.

## 9. Args reference

Full schema + defaults: the Config block atop `develop-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `plans` (non-empty array of `{ id, title?, planPath, mode, gate, status,
  model?, effort? }` rows that `plan-edit.mjs args` prints, or a `--pack` pass `{ id, title?, mode: fix, gate, status,
  model?, effort?, blocks: [{ id, planPath, issues }] }`. Malformed **throws** naming the shape. A row with no
  `planPath` **throws** naming it. A `model` outside `opus | sonnet | haiku | fable` or an `effort` outside `low | medium | high | xhigh | max` **throws** naming the row.) · `target.repo` (**throws** if missing) ·
  `gates.build` (**throws** if missing) · `gates.test` (**throws** when any PENDING block's gate is
  `green` — deliberately pending-scoped, so an all-done relaunch reaches its terminal) · `backlogDir`
  (the absolute folder `project-settings.mjs backlog` prints, §10. **Throws** when missing, relative or
  inside `target.repo`, and the message names the command).
- **File keys:** `ordered` (boolean) · `suite` (`green|scoped`) · `sweep` (`goal-coverage|none`) ·
  `goal` (string). Typed illegal values **throw** — spread what `args` prints. `sweep: goal-coverage`
  with an empty `goal` **throws**.
- **Return:** `status` · `halted`/`haltReason` · `regression` (true when any block's ledger entry reads
  true. An entry follows the last acceptance verdict that reports the field, and a passing verdict that
  omits the field sets it false) · `plansDone` · `parked` · `ledger` (per block, with a
  status of the form `<token> (<meaning>)`, the developer `model` and `effort` it ran on, `rounds`, `closingPass`
  (true when the block ran its closing pass, §6), `commit` (the sha of the block's commit, null in stage
  mode, on a no-op pass, when the commit did not land or failed the unverified sha check, and on a block
  acceptance rejected, whose commit the halt reason names), and per-issue `results` in fix mode) · `statusSync` (the
  plan-file edits, also logged per block for §2 step 5) · `sweep` · `failed`
  (`{ id: 'sweep', stage: 'sweep' }` when the sweep ran and died, else empty, so `sweep: null` with no
  entry means the sweep did not run) · `backlogEntries` (every mode, the entries developers and fix
  verifiers added to the backlog this run, null when one returned no usable report) · `backlogFiles`
  (the sorted backlog files the developers and fix verifiers named, null when `backlogEntries` is
  null) · `nextStep` (when the run added entries, it names the folder, the files and the count, and
  asks you to report each added entry's severity and title to the user. In commit mode it names each
  committed block with its sha. It says nothing is staged when the run did not halt, and otherwise
  points at `git diff --cached --stat`).
- **Optional:** `blockTool` · `conventions` ·
  `reference` · `gates.testSetup` · `target.lang`/`framework` · `maxRounds` (1–50, default 5, **throws** on
  garbage) · `changePolicy` (`focused|proactive`, default `focused`, any other value **throws**, and
  `strict`, the old name of `focused`, throws with a message that names the rename. It sets the
  developer's build aim and whether it fixes a pre-existing defect it notices in connected code, and §4 says how to
  choose it) · `commit` (`true | false`, default `false`, any other value **throws** naming the arg and
  the value. `false` stages each accepted block, and `true` commits it, §6 "Commit mode". In commit mode
  a row's `title`, which `plan-edit.mjs args` prints, is the commit's entire message, a title that is
  not one line of text **throws** naming the row, and a row with no title commits under its id. The
  launch log line names it) ·
  `minPlanBudget` (**throws** on non-numbers) · `models`/`efforts`/`agentTypes`
  (`models` and `efforts` map a role key to a value. The role keys are `develop` (the developer, the
  closing pass included), `park`, `quality`, `acceptance` and `sweep`. A model is `opus | sonnet |
  haiku | fable` and an effort is `low | medium | high | xhigh | max`. The develop, quality, acceptance
  and sweep roles default to opus. Every role defaults to `high`. A block's `model:` and `effort:` lines override
  `models.develop` and `efforts.develop` for that block's developer. The park role takes `models.park`, else its block's
  developer model, and takes `efforts.park`, else the block's developer effort. `agentTypes` has no park key, so the park agent takes `agentTypes.develop`. The engine **throws** at
  launch, naming the arg, on a value that is not an object, a key outside the role keys, and a value
  outside its set. Choose the review roles' models as §3 says. Role settings saved in the repo's settings
  (§2 step 3) count as the user asking for them, as a saved memory preference does. One launch log line
  names each role's model and effort) ·
  `stateDir` · `runOnly` · `continueParked` (block ids whose round 1 restores the parked patch, §7.
  **Throws** on a non-array or an id outside the pending blocks).
- **Retired:** `startAt`, `reviewSeverity` (the developer's risk judgment decides when a blind review
  runs, and every blind review reports every tier), a top-level `planPath` and `planContext` are
  retired and **throw**.
- **Agent returns the loop reads (§6):** the developer's `review_needed` (true when any change of its
  round is not low risk, and a non-boolean counts as true) and, in the closing pass only,
  `recorded_entries` (the ids of the backlog entries it listed, appended or already there) · in commit
  mode, the round-1 developer's `baseline_staged_files` (the files staged before it touched anything,
  above 0 halts `staged-baseline`, and a non-number is logged as unverified) · acceptance's `risk_misclassified`
  (true when its risk audit found a gap) · in commit mode, acceptance's `committed`, `commit_sha`,
  `commit_subject`, `tree_matches` and `tree_clean`, which the landing checks of §6 "Commit mode" read, and a failed check halts `commit-unverified` · the blind reviewer's `issue_count`, which counts every
  finding at every tier. `minor_count`, the old count of findings below a review's bar, is retired.
- An all-non-todo `plans` array returns `nothing to run (no todo blocks)` — not an error.

## 10. Working the backlog

The backlog folder holds what develop leaves for later on one project, across all of its runs. It is
the folder `node <project-settings.mjs> backlog --root <root> --repo <target.repo>` prints, and every
launch passes it as `backlogDir`. A run's entries for one block go to one file there,
`<file id>.md`, created with the first entry. `<file id>` is `<run slug>-<block slug>-<pair hash>`:
- `<run slug>` is the runId through the engine's `slug()`, or `run-` and the engine's `fnv1a()` hash of
  the runId when that slug is empty, as for a runId with no ASCII letter or digit.
- `<block slug>` is the block id through `slug()`. It equals the block id for an id of 60 characters or
  fewer.
- `<pair hash>` is the `fnv1a()` hash of the JSON array `[runId, block id]`. It keeps two runs apart
  whose slugs join alike, such as run `a` with block `b-c` and run `a-b` with block `c`.

Each file is a fix-mode plan file. Its header is
`## Plan: <file id> - backlog from block <block id> of run <runId>`, then `mode: fix`, `gate: green`
and `status: todo`. Its entries take debug's issue-file shape, with the id `<file id>-<n>` and
`- decision: NEEDS_USER`. A cleanup entry carries `- category: cleanup` and no `- severity:` line.
Before the developer or fix acceptance appends an entry (§5), it greps the folder's `*.md` files by the
file path and the name of the function or identifier at the defect, reads each matching entry, and
never appends a defect that an entry with `- status: open` or `- status: needs-attention` already
holds. A defect whose only entries say `fixed` or `stale` is back in the code, so it gets a new entry
whose `**What:**` names theirs.

When the user asks to work the backlog:

1. Run `node <project-settings.mjs> backlog --root <root> --repo <target.repo>` and read each file in
   the folder it prints.
2. List the entries that wait on the user, grouped by severity, highest first, with the cleanup entries
   last. An entry waits on the user while its `- decision:` is `NEEDS_USER` or `DEFER`, or while it is
   ACTIONABLE and its `- status:` is `needs-attention`, which a fix that failed or did not land sets.
   An entry whose decision is SKIP never waits on the user, whatever its status. It keeps its status
   unless step 3 sets one, so `- status: open` alone never lists an entry. List an entry with a
   `**Parked with:**` line with a note naming its parked block, and leave it out of the triage in
   step 3 while it is held.
3. Triage them with the user. Set each entry the user decides to skip to `- decision: SKIP`. Set each
   entry the user approves to `- decision: ACTIONABLE`, and rewrite its `**Fix:**` line to encode the
   option the user chose. Skip an entry with a `**Closed by:**` line once you confirm the accepted baseline
   holds that fix, and triage it like the rest when the code does not. Hold an entry with a
   `**Parked with:**` line until its block is accepted in a later launch, whether continued or
   redone, since the code it names sits in that block's parked patch. Release the hold when the block
   is dropped. Once the hold ends, skip the entry when the accepted baseline holds its fix, and triage it
   like the rest when the code does not. Set `- status: fixed` on each entry skipped because the accepted
   baseline holds its fix, since the writers' dedup treats an open entry as still holding the defect.
   A `status: todo` file left with no ACTIONABLE entry and no entry that waits on the user is not a
   plan, so set it to `status: skip`, as debug's triage does.
4. Build the files that hold an ACTIONABLE entry whose status is not `fixed` or `stale` with
   `node <plan-edit.mjs> args <file> [<file> ...] --pack <target.repo>` and a develop launch in fix
   mode, from §2 step 3. A file whose `status:` is not `todo`, such as a `done` file whose
   needs-attention entry the user approved again, first takes §2 step 5's order: run `args` on it, set
   its `status:` to `todo`, then run `args` again for the launch.
