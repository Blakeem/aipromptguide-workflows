# develop-cycle — operator guide (for Claude)

`develop-cycle.mjs` builds the **todo blocks of ONE approved plan file** in one target git repo. Each
`## Plan: <id>` block carries its own `mode`, which picks the frames the engine holds: `feature` (one
bounded feature, wired in and reachable), `section` (one slice of a breadth-spanning goal, every call
site converted) or `fix` (one issue inventory from debug's review or your own testing, ACTIONABLE
entries only). Per block: `develop → blind quality → plan-aware acceptance`, **staging each accepted
block**, and in commit mode committing it (§6), before the next. A run builds in a worktree of its own,
and §2 step 6 lands its accepted work on the branch the user has checked out. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`; follow those before changing the engine.

Two checkouts take part. **The user's checkout** is the repo the user named, on the branch they work on.
**The run worktree** is the checkout `wt.mjs open` makes for one `runId`, on branch `aipg/<runId>`, and
it is the `target.repo` every launch of that `runId` gets. Every git state this guide names before §2
step 6 is the run worktree's. The user never needs to know the run worktree exists, so name it only
when step 6 hands the user a decision.

## 1. Scope (check FIRST)

Right-size each block by behavior, never by line count. Join behaviors that edit the same files and
can be accepted together into one block. Then check the block's context size, a second measure that
counts what the developer reads, not the lines the block changes. Aim for a block whose round-1
developer reaches about 200k to 350k tokens of context. Split only behaviors that cannot be judged
together, or a set whose round-1 developer would pass about 350k tokens. In a `feature` block, a
behavior is one entry point (a verb, a command, an endpoint or an added function) with its failure
and recovery paths. In a `section` block, a behavior is one slice of the goal whose call sites
convert and are accepted together. Blocks that stay split are listed in dependency order with
`ordered: true` set when one builds on another. Too small, such as a one-liner or a rename → just
edit. A block may edit hand-written documentation. Acceptance judges a doc edit only against the
block's acceptance criteria or fix entries, so name each doc change a block owes in one of them.
Generated files, such as a flow map regenerated from an engine a block changes, belong to that
block. Locate code in a block body by section title or grep pattern, not line number, since earlier
blocks shift lines. Make each block self-contained. Every agent reads only its own block, so a path
or instruction stated only in the file preamble or another block never reaches it. A block states
the goal, the user's decisions, and the choices that must agree across blocks or with the repo that
a developer working one block cannot see, such as names, data shapes, file locations and which
existing pattern to follow. Everything else is the developer's call. Split work into blocks whose
code is complete on its own, such as a new key together with the code that reads it. Never split by
layer, where an earlier block adds code only a later block uses. That block's blind reviewer flags
the half-built behavior as incomplete, and the developer cannot dismiss it with a reason the code
shows.

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

   **Name the input's sender.** A block that touches a network, an authentication path or a shared
   resource names who sends its input and what limits that input.
2. **Refine it, then get approval.** Run the refine workflow on the file until it returns `converged`,
   under the run-once rule in `workflows/refine/CLAUDE.md` §2 step 3, then the user approves the FINAL
   text. Approval comes after refine so the user signs off on what develop builds.
3. **Derive the args with `node <plan-edit.mjs> args <planPath> [<planPath> ...]`, never by hand.**
   It first folds every finished develop run's statuses into the plan files (below), then prints
   `{ goal, ordered, suite, sweep, plans, blockTool }`, each `plans` row carrying its own `planPath`,
   and `blockTool` naming the `plan-block.mjs` beside the `plan-edit.mjs` that ran. Spread
   that object into the args, and add `backlogDir`, the folder that
   `node <project-settings.mjs> backlog --root <root> --repo <target.repo>` prints (§4, §10). Also
   add `models` and `efforts` from the JSON line
   `node <project-settings.mjs> roles --root <root> --repo <target.repo>` prints. A role the user
   names for the run wins over the repo's saved value. When the user names role settings to keep for
   the repo, save them with
   `node <project-settings.mjs> set-roles --root <root> --repo <target.repo> [--models <role>=<value>,...] [--efforts <role>=<value>,...]`,
   where the value `default` removes a role's saved value. Also add `commit` as §4, "Choosing the
   delivery", settles it, and set `target.repo` to the run worktree (step 4). The approval summary
   shows each role's model and effort and where each came from: the run, the block's `model:` or
   `effort:` line, the repo's saved settings, or the default. Several files make one run, as long as
   their file keys agree. When you know the last launch's Workflow run id (`wf_...`), pass
   `--expect <id>`: it fails loudly if that run's record is missing, which is the sign Claude Code
   moved or changed its run records. For fix-mode files, add `--pack <target.repo>`: it groups the
   todo fix blocks into passes of at most `--loc-cap` lines (default
   5000) of the files their open ACTIONABLE issues name, so one developer, one blind reviewer and one
   verifier build several small blocks. Each member keeps its own plan file and statuses. A pass runs
   on the strongest `model:` and the highest `effort:` among its members. A member without the line
   runs on the run's default, so it shares a pass with a member that sets the line only when that
   value is `fable` or `max`. A pass can run a member on a stronger model or effort than the one
   approved for it, so the approval summary shows each pass row's model and effort and names each
   member the pass raises, which the `packed` note lists.
4. **Open the run worktree, then launch.** The run worktree keeps the run's diff, which every blind
   reviewer reads, apart from the user's own edits, so the user can keep working in their checkout.
   - When `git -C <the user's checkout> worktree list --porcelain` lists no worktree on
     `aipg/<runId>`, which holds on the first launch of a `runId` and after step 6 landed it, run
     `node <project-settings.mjs> provision --root <root> --repo <the user's checkout>`. It prints
     `provision` and `worktreeDir`, each null when unsaved. A fresh worktree holds only tracked
     files, so on `"provision":null` work out once the command that readies one for the gates. The
     default provision command copies every file git ignores in the user's checkout into the
     worktree, except the folder that holds the run worktrees and what the project's own setup
     command rebuilds, such as installed dependencies, build output and caches, and then runs that
     setup command. When the project's checks use something outside the worktree that two runs would
     share, two runs of that project do not run at the same time. The platform's shell runs the
     command in the worktree. Save it with
     `node <project-settings.mjs> set --root <root> --repo <the user's checkout> --provision "<cmd>"`,
     or `--provision none` when the gates need nothing.
   - With no `--dir`, `open` makes the run worktree in `<the user's checkout>/.claude/worktrees/`
     and adds that folder to the repo's `info/exclude`, so `git status` in the checkout lists no run
     worktree. When the project's files reference a path outside the checkout by a relative path,
     that path resolves only when the worktree sits beside the checkout. So save the checkout's
     parent folder once with
     `node <project-settings.mjs> set --root <root> --repo <the user's checkout> --worktree-dir <the checkout's parent folder>`.
     `--worktree-dir default` removes the saved folder. When the project's checks walk the
     checkout's folders or search parent folders, as `docs/worktree-batches.md` describes, save a
     folder outside the checkout instead.
   - Then run `node <wt.mjs> open --repo <the user's checkout> --name <runId> --provision "<cmd>"`,
     leaving `--provision` out on `none` and adding `--dir <worktreeDir>` when `worktreeDir` is set,
     where `<wt.mjs>` is this checkout's `tools/wt.mjs`. It cuts `aipg/<runId>` from the user's
     current branch, records that branch as the one step 6 lands on, and prints the run worktree's
     path. A provision that fails exits 40 and keeps the worktree, so fix the command, save it
     again, and rerun it there by hand.
   - When it lists a worktree on `aipg/<runId>`, reuse it. Settle a dirty run worktree first (§4).

   Run step 3 with `run_in_background`, and launch in the turn its notification starts (root
   `CLAUDE.md`, "Launch from a notification turn"). The engine builds the `status: todo` blocks in file
   order; `done`/`skip`/`backlogged`/`parked`/`blocked` are never selected. `parked` is what an older
   engine wrote for a park.
5. **Check the result (§6).** The run's statuses reach the plan file on the next step 3, with no
   step of their own. develop logs each finished block's status edits, Claude Code keeps a run's
   logs in its run record even when the run fails or is stopped, and `args` applies every record
   newer than the file's `synced:` key, oldest first, all or nothing. The engine decides every
   value. An accepted or passed-but-unstaged block → `done`. A park that cleared the tree, kept the
   build green and wrote its backlog entry → `backlogged`, unless a green fix block cannot build
   that entry (§5 Park). A held park is one whose halt may have left the block's work staged or
   committed (`staging-unconfirmed`, `rejected-staged`, `agent-dead`), whose tree is unsafe
   (`park-unsafe`), or whose plan block no agent could read (`plan-unreadable`). A held park, every
   other halt, a fix block whose report in round 1 was all SKIPPED or empty and that restored no
   unfinished branch, and a fix block whose unfinished branch did not apply (§7) → `blocked`. The
   exception: an accepted block whose verdict also reported a regression (halt
   `acceptance-regression`) syncs `blocked` while its work stays staged or committed, and so does a
   commit-mode block whose commit did not land as asked (§6, "Commit mode"). Their FIXED and STALE
   issues sync `needs-attention`, as in a block that did not land, and §6 says how to resolve both.
   A fix block whose report in round 1 was all STALE, or STALE plus SKIPPED, counts as accepted only
   once acceptance confirms each STALE claim. Fix issues map FIXED → `fixed` and STALE → `stale`
   only when their block landed and acceptance confirmed the claim. FAILED in any block →
   `needs-attention`. FIXED or STALE in a block that did not land, or a claim acceptance refuted →
   `needs-attention` too. SKIPPED keeps `open`. The plan file is the selection truth and git
   staging, or HEAD in commit mode, is the landed truth. A `backlogged` block's work continues from
   its backlog entry (§10), never from the block. Set the block `done` once that entry is `fixed`
   and close has landed its fix block on the user's branch and that work is committed there (§10,
   "Working the backlog" step 5). Once a held park's halt is resolved, set its block
   `backlogged` when its branch holds all of its work, an entry links that branch, and a green fix
   block can build that entry (§5 Park), and never back to `todo`. For a fix block, that route also
   sets to `stale` each entry whose branch its round 1 restored and whose work the new branch's tree
   holds, deletes that branch with `git branch -D`, and adds that entry's `- origin:` and
   `- amended:` values to the new entry's line of the same key. Otherwise set that entry's
   `- status:` to `stale`, remove the `- pulled:` line of each entry its `Pulled:` line names, delete
   the branch with `git branch -D`, and set the block back to `todo` as follows. After resolving a
   `blocked` block, run step 3 (it applies the finished run's statuses), then set the block's
   `status:` back to `todo`, then run step 3 again for the launch args. A block whose staged or
   committed work you keep after `acceptance-regression` or a commit-mode pass halt is the
   exception: §6 sets it `done`, never `todo`. A flip made before the first step 3 is overwritten by
   the run's own status edit. Records are deleted after `cleanupPeriodDays` (30 by default), so run
   step 3 within that window or the statuses of a finished run are lost.
6. **Build the backlog, then land the run on the user's branch.** Under `proactive`, once the plan
   has no `todo` block left and before the landing below, build the ready backlog entries once, in
   the same run worktree. A `blocked` block, or an older engine's `parked` one, holds back only the
   backlog work on the files its text names. `args --backlog` leaves out its own backlog file, and
   each file with a ready entry whose `- file:` path that block's text names, and notes each held
   entry with that block (§10 step 4). Every other ready entry builds. The build needs a run
   worktree that holds only accepted work, since its round 1 halts on unstaged work and builds on
   the index it finds. So when `git -C <the run worktree> diff` is not empty, `git -C <the run
   worktree> status --porcelain` lists a `??` file, or a `blocked` block halted as a held park,
   with `acceptance-regression` or with a commit-mode commit that did not land (step 5), settle
   the run worktree and that block first (§6). When the user stops the plan with a `todo` block
   left, or with the run worktree unsettled, skip the build for that landing and say so in the run's summary. First apply §10 step 1 to
   the folder, so an entry whose fix the run already made is closed. Then run
   `node <plan-edit.mjs> args --backlog <backlogDir> --pack <the run worktree>` and launch with its
   output as steps 3 and 4 say. This build takes the ready entries that no developer pulled beside its
   block (§4), since `args --backlog` leaves out an entry with a `- pulled:` line. When it exits 1 with
   a message that ends `nothing to build`, no file holds a ready entry, so skip the launch. Whether it prints args or exits with `nothing to build`,
   apply §10 step 5 to the folder next, since that call writes the fold of every `todo` or `done`
   backlog file that holds an ACTIONABLE entry before it prints or exits. Step 5 there closes only
   work an earlier run landed, since close has not yet landed this run's work. The entries that
   launch adds wait for the next run, so one follow-up launch runs per run. An ACTIONABLE entry
   whose fix failed has `status: needs-attention` and waits for the user (§10 step 2), and
   `args --backlog` leaves out every file that holds one until the user skips that entry. A file
   whose entry the user approves again is built by naming it (§10 step 4). Under `focused`, skip
   this paragraph.

   Land the run next. First compare `git -C <the user's checkout> branch --show-current` with
   `git -C <the user's checkout> config branch.aipg/<runId>.aipgbase`, the branch `open` recorded.
   When they differ, ask the user which branch takes the run and pass `--into <that branch>` to
   close. Stage delivery stages the work in the worktree that has that branch checked out. So when
   no worktree has it checked out, offer commit delivery for this landing, or ask the user to check
   that branch out themselves. When the user takes commit delivery here, commit the run worktree's
   staged work as one commit with `git -C <the run worktree> commit -m "<runId>: accepted"`, the
   name `close --stage` gives its carrier commit, and then run close without `--stage`. Never switch
   the user's checkout, not even to follow a close refusal. Land once the plan has no `todo` block
   left, where a `backlogged` block counts as finished, or once the user stops the plan with blocks
   still blocked, so that the accepted blocks land. A parked block's branch is a branch of the repo,
   so it outlives the run worktree. Settle the run worktree first, since close refuses work no
   acceptance staged (§4). Then run
   `node <wt.mjs> close --repo <the user's checkout> --name <runId> --gate "<gate>"`, adding
   `--stage` in stage delivery (§4, "Choosing the delivery"). `<gate>` is the run's `gates.test`,
   else its `gates.build`. close rebases the run onto the branch it was cut from when that branch
   moved, runs the gate on the combined tree, and then lands it. In commit delivery it fast-forwards
   that branch. In stage delivery it stages the run's change in the user's checkout and leaves the
   branch where it is. The user may have uncommitted work in their checkout, and close refuses only
   a change at a path the landing writes. Then close removes the run worktree and deletes
   `aipg/<runId>`. Branch on its exit code:
   - `0`: landed. Run the full gate in the user's checkout, since the run worktree held only the tracked
     files and the ignored files that provision copied. Report the result with the run's summary: each
     landed block, each backlog entry the run added with its decision, each `DECISIONS.md` line,
     showing a logged fix line only after you confirm the landed code still holds its change, and the
     path of each `DISMISSED-<id>.md` that `nextStep` names and that exists.
   - `20`: the rebase conflicted with commits the branch gained during the run, or the branch moved
     while close ran. Resolve it yourself in the run worktree: run `git rebase <branch>`, read both
     sides of each conflicted file and keep both intents, `git add` it, run `git rebase --continue`,
     then run close again. In stage delivery the run's work is one carrier commit named
     `<runId>: accepted`, and it rebases the same way. Ask the user only when the two sides need a
     product decision, with both sides shown. List each file you resolved in the run's summary,
     since no reviewer read the resolution. A moved branch with no conflict needs only close again.
   - `30`: the gate failed on the combined tree. Fix the cause in the run worktree and commit the
     fix there, then run close again. A fix larger than a few lines is a fix-mode block (§3) built
     in the same run worktree under the same `runId`. List each file you changed, with the reason,
     in the run's summary, since no reviewer read the fix.
   - `40`: follow its one-line reason and run close again. When the reason names the user's
     uncommitted changes at paths the landing writes, ask the user to commit them or set them aside,
     since that work is theirs. To drop a run instead, run
     `node <wt.mjs> close --repo <the user's checkout> --name <runId> --discard`, then delete the
     branch with the command it prints, once the user agrees to lose the accepted work.

## 3. Plan-file format

The grammar lives with the tool (`tools/CLAUDE.md`): optional frontmatter, file keys
(`goal`/`ordered`/`suite`/`sweep`), a `## Plan: <id> - <title>` header per block with a preamble run
(`mode`/`gate`/`status`/`model`/`effort`, where `model` is `opus | sonnet | haiku | fable`, the
block's developer model, and `effort` is `low | medium | high | xhigh | max`, the block's developer
reasoning level, plus informational `test_selector`/`depends_on`), bodies read verbatim. Gates per
mode: `feature` takes `green | build-only`; `section` takes `green | red-baseline | build-only`;
`fix` takes `green` only. A file holding any section-mode block defaults to `ordered: true`,
`suite: scoped` and `sweep: goal-coverage`. A file whose sweep is `goal-coverage` needs a `goal:`
line, and `--list` fails without one. A fix block IS an issue inventory: its `### [<id>]` entries
are what the fix worker verifies and fixes (ACTIONABLE decisions only, verify-first, vanished issues
marked stale). `--list` fails on a `todo` fix block with no `### [<id>]` entry. debug's review.mjs
writes these files; hand-authored external inventories use the same shape.

**Choosing a block's developer model.** Set `model:` on each block while writing the plan. The user
may override it. Read the repo's saved `models.develop` first (`project-settings.mjs roles`, §2 step
3). When it is saved, write a block's `model:` line only where the user asks for a different model
for that block, since the line overrides the saved value. A saved `efforts.develop` works the same
way for `effort:`. Judge by how many layers of abstraction the block crosses and how much logic it
holds. Sonnet and opus develop about equally well on most tasks, so `sonnet` takes common work:
backend changes, minor frontend changes, interface or design changes that are not major, a new API
endpoint or MCP tool, simple interface features or updates, and fixes from a debug inventory. `opus`
takes complex logic, security work, mission-critical code, and changes that need an understanding of
deeper layers of abstraction. `haiku` takes a bulk text replacement or a very simple change across
the codebase. `fable` runs only when the user asks for it, since the user controls how many tokens a
run spends. A `fable` or `max` line on a fix block also raises the blocks `--pack` joins to it (§2
step 3), so tell the user so when they ask for either on a fix block. When unsure, leave the line
out, so the run's `models.develop` applies. Show each block's model and effort in the approval
summary.

**Choosing the review roles' models.** Sonnet reviews worse than opus. The quality, acceptance and
sweep roles run on opus for a major feature or a risky change, and may run on sonnet for a low-risk
change, such as a doc or comment fix. Set them through `models` (§9).

**Reasoning level.** Every role runs at `high` unless `efforts` says otherwise (§9). A block may set
`effort:` beside `model:`, and sets it only when the user asks for a level other than the run's,
since `high` suits every model.

## 4. Pre-run setup (your job — no setup agent)

- **Clean unstaged tree, engine-enforced** on round 1 (halts before any reviewer spawns). Dirt in
  the run worktree is never the user's work, since the user's edits stay in the user's checkout. So
  never `git add -A` it or commit it, since §2 step 6 would land it unreviewed. Settle a dirty run
  worktree by setting the dirt aside without touching the accepted baseline, which the staged index
  holds in stage mode and HEAD holds in commit mode. To set it aside, first remove the untracked
  build output and caches (they regenerate). If `git status --porcelain` then lists no `??` file and
  `git diff` is empty, the tree is settled. Otherwise mark each remaining `??` untracked file with
  `git -C <repo> add -N -- <file>`, save `git -C <repo> diff --binary` to a new patch under the
  run's state dir, creating that dir if needed (the patch carries the new files too), and confirm
  the patch exists and is non-empty. Save before you clear: if it does not, stop and clear nothing.
  Then restore the modified tracked files with `git -C <repo> checkout -- <files>`, drop each
  intent-to-add file with `git -C <repo> rm -f -q -- <file>`, and confirm `git status --porcelain`
  lists no `??` file, `git diff` is empty and `git diff --cached` is unchanged. Restore it later
  with a plain `git -C <repo> apply <patch>`, never `--3way`, which stages what it restores. An
  unpathed `git reset`, `git rm` or `git stash` touches the index, which holds the accepted
  baseline. When the dirt is a tracked file the provision command rewrote, such as a lockfile, also
  fix the command and save it again with `project-settings.mjs set --provision` (§2 step 4). When
  the dirt is an interrupted develop run's unfinished block, relaunch once it is set aside. A
  dirty-baseline halt records its block `blocked`, so after settling the tree run §2 step 3, set
  that block's `status:` back to `todo`, and run step 3 again for the launch args.
- **`root` REQUIRED**: the run-state base, outside the target repo. `blockTool`, the
  `plan-block.mjs` every agent reads its block through, is a key of the object `plan-edit.mjs args`
  prints, so the spread args carry it, and the engine throws without it. Never pass it by hand.
  Pre-allowlist the command exactly as agents run it: `Bash(node '<blockTool>':*)`. Under
  `proactive`, also pre-allowlist `Bash(node '<plan-pull.mjs>':*)`, where `<plan-pull.mjs>` is the
  `plan-pull.mjs` beside `blockTool`, since every round-1 developer runs it (§4).
- **Relaunch vs. new run:** relaunch a halted or parked run with the same `runId` and no
  `resumeFromRunId`, so its ledgers, `NEEDS-USER.md` and `DECISIONS.md` carry over. Every develop
  run of one plan, or of one debug review's issue files, keeps that `runId`. Unrelated new work
  takes a new `runId`, and so does a block that already landed and is built again from scratch, so
  its old `DISMISSED-<id>.md` stays out. Never clear the state dir (§8), a plan file or debug's
  `issues/`.

**Choosing the change policy.** `changePolicy` sets the developer's build aim and whether it fixes a
pre-existing defect it notices in the code its block's changes connect to. The engine defines three
code zones, and every developer and acceptance prompt renders that one definition:
- Task code is the code the block's required changes add or change. Every line such a change adds or
  changes is task code in full, so a pre-existing finding on such a line is a task code finding. In a
  fix block, that holds for every line an ACTIONABLE entry's fix adds or changes, and task code also
  holds the sibling paths of each ACTIONABLE entry's root cause, apart from code the block's text
  excludes or another block of the plan owns. Under `proactive`, task code also holds the code each
  pulled backlog entry's fix adds or changes (Pulling, below).
- Connected code is the code a reach step from the task code finds, which is its callers and consumers,
  its sibling paths, duplicates of its logic and the text that describes it. Code the block's text
  excludes and code another block of the plan owns are never connected code.
- Other code is everything else.

Under both policies, the developer hunts only task code and fixes every finding there at every tier,
a defect the accepted baseline already had included. It also fixes each finding the diff introduces
or exposes in connected code. The developer reads connected code only to check its change's effects.
It never changes other code. It closes a finding the diff introduces or exposes there, such as a
build break, at its source in task or connected code, and escalates the finding when only a change
in other code closes it. A pre-existing finding is one, at any tier, that the accepted baseline
already had and that the diff neither introduces nor exposes. Each real pre-existing defect at low
or above that the developer logs because its zone routing leaves the defect unchanged, under the
decision matrix's rule 2 or as a sibling path (§5), apart from one in code another block owns, goes
to the backlog (§10). The policies differ as follows.
- `focused` aims for working code that stays close to the task. Its developer builds minimally and
  surgically. In a feature or section block, it fixes a pre-existing defect in connected code only when
  the defect lies in a function or method that holds task code and the fix is low risk under the risk
  questions (§6). It leaves every other pre-existing finding in connected code unchanged. The run builds
  the backlog only when the user asks (§10).
- `proactive` aims for the best code. Its developer builds each feature and section block with the change
  that has the best long-term result. In a feature or section block, it also fixes a pre-existing defect
  in connected code when the fix is low risk under the risk questions (§6). It leaves every other
  pre-existing finding there, such as a nit, unchanged. A fix block leaves each pre-existing finding in
  connected code unchanged, as a fix block does under `focused`. The developer also records each cleanup
  outside task code that it noticed and did not make. A run whose plan has no `todo` block left also
  builds every ready entry in the project's backlog that no `blocked` or `parked` block holds (§2 step 6), so it
  fixes issues across the codebase over time. It uses more tokens per run, and fewer in total than reaching the same
  code quality later.
- **Pulling** happens only under `proactive`, in round 1 of every feature, section and fix block. Once
  the developer has read its block, it runs `plan-pull.mjs pullable` with the files its block will
  change. The tool decides which entries are eligible, by every rule `args --backlog` builds by, and
  leaves out an entry with a `- branch:` or `- pulled:` line and every entry of a plan file the run
  builds. The developer checks each listed entry against the current code as a fix block's
  verify-first step does, and takes the entries whose fix sits in those files and fits its capacity,
  aiming for a round-1 context of about 200k to 350k tokens. It marks each taken entry with
  `- pulled: <runId>#<block id>`, deletes its `**Parked with:**` line, which the tool releases in memory
  only, lists its id in `PULLED-<id>.md`, and builds its fix as a fix block builds an ACTIONABLE entry.
  Later rounds take no new entry. Every acceptance of the block judges each
  pulled entry as fix acceptance judges an issue. A pulled entry's gap fails the round, and the next
  developer closes it or reverts that entry's change and reports it FAILED. The closing acceptance never
  grades a pulled gap blocking. It reverts the change of each pulled entry it does not confirm before
  it stages the block, then runs the full gates once more. A pulled entry parks its block only when
  those gates fail, since the block's own work then depends on the reverted change. The closing
  acceptance then puts that change back and writes a blocking gap for it. The run's status edits close
  each pulled entry as §2 step 5 maps a fix issue: `fixed` or `stale` when its block landed and the last
  verdict confirmed its claim, `fixed` for a STALE report that follows the developer's own FIXED report,
  and `needs-attention` otherwise, each with its `- pulled:` line removed so a later run can take it
  again. Each of those edits expects the block's mark, so `args` leaves an entry as it is when its
  `- pulled:` line names another block or is absent. When those edits close an entry and its backlog
  file's block is `todo` and then holds no open entry, they also set that block `done`, as for a file
  whose fix block lands. A park that saved its block's work keeps the
  status and `- pulled:` line of each pulled entry whose last report is FIXED, or STALE after a FIXED
  report, since the park's branch holds its fix, and the park entry's `Pulled:` line names those
  entries (§10 steps 3 and 5). Every other pulled entry of that park syncs `needs-attention` and loses
  its line. No status edit closes the `- pulled:` line of an entry `PULLED-<id>.md` lists that no
  report or verdict of the run names, such as an entry a developer marked before it died. A park
  agent that returns closes such an entry. The park's `Pulled:` line names that entry when the park's
  commit holds its fix, and the park removes its `- pulled:` line otherwise. A block that ends without
  such a park, such as one that lands or one whose park agent died, leaves such an entry marked, and
  no later build takes it. So the run's `nextStep` names each such block, with the
  `- pulled: <runId>#<block id>` line to grep the backlog folder for and the ids its ledger row's
  `pulled` names. Remove each such line on an entry those ids leave out. The developer and acceptance
  of a fix block built from a file that holds a pulled entry treat that entry as not ACTIONABLE, so
  only the pulling block, or its park entry, builds that work.

Each fix of a defect the accepted baseline already had that no criterion of the block or ACTIONABLE
entry requires gets one `FOCUSED <id>:` or `PROACTIVE <id>:` line in `DECISIONS.md`. Acceptance
excuses such a fix from its regression check only when it lies in a zone the policy lets the
developer change, lies in no code another block of the plan owns, removes a real defect, and alters
no other behavior. Those zones are task code and connected code where the fix closes a defect the
diff introduces or exposes. Under `focused`, a feature or section block adds the connected code in a
function or method that holds task code. Under `proactive`, a feature or section block adds the rest
of its connected code. Every developer prompt says the policy and the prompt's own scope rules
override any other instruction about scope, a memory line or a CLAUDE.md included. **The setup
check.** Every answer a run needs from the user is asked once per repo, together, at the start. Run
`node <onboard.mjs> check --root <root> --repo <the user's checkout>` before §2 step 1, where
`<onboard.mjs>` is this checkout's `tools/onboard.mjs`. It prints
`ready <key> policy=<policy> delivery=<commit|stage>` once nothing is missing. Otherwise it prints
`ask <key>` and the open questions, with each option's text and the save command. Ask them in one
AskUserQuestion call, then run the save command with one flag per answer, which prints what check
prints. When the user declines the access question, the user runs the `/add-dir` command that
question names for this session, and you pass `--access session` to the save and to each later check
in this session. A user who declines both gets no run, since the Workflow tool cannot read the
engine. The answers stay in the user settings and in `<root>/projects.json`, keyed by the repo's
main checkout, so a worktree takes its main checkout's answers. When check or save exits 1, show the
user its message, which names the cause, and run it again once the cause is fixed. The same holds
for `<project-settings.mjs>`, this checkout's `tools/project-settings.mjs`, whose
`node <project-settings.mjs> backlog --root <root> --repo <target.repo>` prints the project's
backlog folder.

Settle a run's policy in these steps.
- A policy the user names for a run wins over the saved one.
- Otherwise use the `policy=` of the ready line. On `auto`, pick `focused` or `proactive` for this
  run. Pick `focused` when money or user data is at stake with little time to test, when the code is
  old and due for replacement, or when others own it. Pick `proactive` when the user is the main
  developer, the code is new or active, and there is time to test. Ask the user when unsure.
- Show the run's policy in the approval summary. With `auto`, also show the reason for the pick. The
  engines take only `focused` or `proactive`, so pass the pick as the `changePolicy` arg, never `auto`.

**Choosing the delivery.** The delivery sets how the run's accepted work reaches the user's branch, and
with it the `commit` arg (§9).
- A delivery the user names for a run wins. Otherwise use the `delivery=` of the ready line.
- `commit` is `commit: true`. Acceptance commits each accepted block on `aipg/<runId>` with the
  block's title as its message (§6, "Commit mode"), and §2 step 6 fast-forwards the user's branch to
  those commits.
- `stage` is `commit: false`. Acceptance stages each accepted block in the run worktree, and §2 step 6
  stages the run's entire change in the user's checkout, so the user reviews and commits it.
- Show the delivery and where it came from, the run or the repo's saved answer, in the approval summary.

## 5. Roles

Same roles and contracts as the engines it replaces, with these merge-specific points:

- **Developer** — frame per block mode. Owns the decision matrix, `DISMISSED-<id>.md`,
  `AMENDED-<id>.md` (read by acceptance and the sweep, never the blind reviewer), `NEEDS-USER.md`,
  `question-<id>.md`, `DECISIONS.md`. It works in six phases, in this order. PATTERNS finds how the
  repo already does the same kind of thing before it writes. BUILD builds the block, then runs the
  gate. In a feature or section block, a round that answers a review routes each finding and gap in
  that review through the decision matrix in place of the build. A fix block's round routes them
  beside its entry rules. A round after a red gate with no review builds again. It treats each review
  finding as another agent's claim. It confirms the finding against the current code before it acts
  and drops a finding it refutes as a false positive, apart from a contested dismissal, which it fixes
  or escalates. It reads a suggested fix as a hint and checks it
  against the text it changes, the block's text, every sibling text that must agree with it and any
  command or behavior the repo does not already use, then builds the fix that closes the confirmed
  cause. In a fix block, VERIFY-FIRST checks each entry's `**Fix:**` line the same way, and a line it
  verifies is defective goes under the matrix's verified-plan-defect case (6a). HARDEN handles edge
  cases, gives each expected failure a message that names its cause, logs where the repo logs, adds
  a test for each risky path and cleans up the code its round added or changed, at every tier.
  SIBLINGS is the sibling rule below. SELF-REVIEW applies the blind reviewer's severity scale, reach
  step and checklist to the code its round changed or read. Code that earlier rounds changed and
  that its round neither changed nor read is outside the self-review, since each earlier round's
  self-review judged that round's code, and each blind review judges the entire block diff. CLASSIFY
  answers the risk questions (§6) for each change its round made, writes `risk-<id>-rN.md`, which
  starts with a snapshot of its round's tree and ends with a sweep of each changed name or
  phrase (§6), and returns `review_needed` and the snapshot's tree id as `risk_snapshot`. Each
  phase after BUILD runs a targeted test while it works. The gate runs once more after the last
  phase that changed code, and that run's outcome is the one it reports. Every gate run sets the
  shell tool's timeout to its maximum (600000 ms) and writes the gate's entire output to a log
  under `scratch/`, which the agent then reads. A gate that may outlast that timeout runs in the
  background and writes its exit code to a file beside the log, and the agent waits for that
  file with one bounded loop that ends inside the timeout, then reads the log once. Acceptance,
  the sweep and park run their gates the same way. A fix block's later round, and every
  later round's pulled entries, start from the statuses the developer last reported, which the prompt
  lists. A phase with nothing to do for its round's changes is skipped. It
  routes each finding by the code zone it lies in, as §4 sets. It logs every finding it routes and does
  not fix, so none is dropped silently. A dismissal names one place or the class of places it covers,
  and its reason holds for every place it names. The reason states a fact it checked that round, the
  file and line it read or the command it ran and its output. The reason never cites the plan, apart
  from one form, `SKIPPED: SPEC: <file:line>`, for a decline whose reason is that the plan prescribes
  the code at that file:line, that the block's text excludes it, or that another block of the plan owns
  it. That form quotes no plan text. It never drops a finding it can neither confirm nor refute. It
  settles that finding with a read or a probe, fixes it or escalates it. On a relaunch, the round-1
  developer re-checks each line that `DISMISSED-<id>.md` carries from an earlier launch against the
  current code before it builds, and removes each line whose finding no longer applies or whose reason
  the code no longer supports. It re-checks each amendment in `AMENDED-<id>.md` the same way. It
  reproduces the amendment's defect and removes each amendment whose quoted clause the block's text no
  longer holds or whose defect the current code does not reproduce, together with its pointer line in
  `DECISIONS.md`. Each amendment's header, `## Plan amendment: <id> rN, launch <n>`, numbers its launch,
  and its pointer line names the same number. An amendment whose header names no launch has a pointer
  that names none, and the developer matches that pointer by block id, round and defect file:line
  alone. The round-1 developer counts `<n>` as one past the highest
  launch number the file's headers still hold and returns it as `launch_number`, and the engine renders
  it into every later round's header. The number tells apart the launches whose amendments the file
  holds. A number returns once every amendment that carried it is removed.
  It escalates only a choice that changes user-visible behavior, stored data or a public contract and
  that nothing it can read or check settles, or a blocker it cannot resolve in scope. One it cannot
  proceed without goes to `NEEDS-USER.md` in an ordered run, which halts on it, and to the block's
  own `question-<id>.md` in an unordered run. Park copies it into the block's backlog entry either
  way. A default it took goes to `DECISIONS.md`, beside each plan amendment pointer. In SIBLINGS,
  for each finding it fixes in any phase and each fix the block requires, it greps for every sibling
  path with the same mechanism and fixes each one, at any tier, that its zone routing fixes (§4). It
  logs every other sibling, and a sibling in code the block's text excludes or that another block of
  the plan owns. Under both policies, a real defect at low or above that it logs because its zone
  routing leaves the defect unchanged, under rule 2 or as a sibling path, also goes to its block's
  backlog file (§10), so a later run can fix it. Under `proactive` it also records there each
  cleanup outside task code that it noticed and did not make, such as a nit. Under both policies it
  also records there a feature or refactor it noticed outside its block's scope, instead of building
  it, and each choice it escalated and proceeded past by a default. A false positive and anything in
  code another block owns get no entry, and under `focused` neither does a nit it drops that way. In
  a pass, the entry goes to the file of the member whose entry's fix led to it. The dismissal line
  stays, since the blind reviewer never reads a backlog file. When a fix it logs to `DECISIONS.md`
  closes a defect that an entry in any backlog file holds, it adds a `**Closed by:**` line to that
  entry and leaves the entry's status and decision as they are, since a park clears the fix from the
  tree. **Must attest `unstaged_confirmed`. A missing or false attestation HALTS, even beside a
  needs-user escalation** (no reviewer reads what the staged index holds). The attestation is not the
  only guard. The round-1 developer returns the index's tree id, from `git write-tree`, as
  `baseline_index_tree` before it changes anything. Each acceptance confirms the index still holds
  the tree id the run last recorded before it stages. It returns the index's tree id once it finishes,
  after its `git add` when it stages, as `index_tree`, which the engine hands to the next acceptance.
  Before any acceptance of the launch has returned a usable id, and after one returns none, the next
  acceptance has nothing to compare unless a round-1 developer's report takes its place first. The tree
  id that acceptance returns restores the check. A changed index halts `staging-unconfirmed`, and the
  block parks with its work unstaged. The halt reason names `git diff --cached <tree id>` with the
  recorded tree id, which lists only what changed in the index after it, since the index also holds the
  accepted blocks. In commit mode, an agent's own commit moves HEAD, which `git diff --cached` does not
  show. So the halt reason also names the last commit the launch landed, and says to revert each newer
  commit that `git log --oneline` lists.
- **Quality Reviewer** — blind by placement (`gate/` only). It receives the conventions and reports
  every finding the diff introduces or exposes at every tier, from critical down to nit, under both
  policies. It works through a reach step over callers, siblings, duplicates and describing text,
  and a lens checklist that ends with the nit list. It also flags a new sentence that the repo's
  code contradicts. A review is clean when it holds no finding and no contested dismissal, and its
  file then reads `No findings.` Each finding gives a fix direction it checked against the code it
  would change. Before it skips a dismissed finding, it checks the stated reason against the code,
  and it contests a reason the code contradicts, at any tier. It skips a `SKIPPED: SPEC:` line
  without a check, since that reason rests on the plan it cannot read. §6 says which rounds it runs in.
- **Acceptance Verifier** — frame per mode; carries the legitimate no-op branch in both modes (a
  block the accepted baseline already satisfies passes without inventing changes). In fix mode, any
  unstaged or untracked change fails acceptance when no issue is claimed FIXED. Only agent that
  stages, and in commit mode the only agent that commits. It reads every earlier review file of its
  block and counts an earlier finding as a gap unless the code closes it on every sibling path with an edit
  that breaks nothing, or the dismissal ledger declines it. A ledger line whose reason starts `SKIPPED:` declines a finding
  only when its reason holds. Acceptance checks each such reason against the code it cites, and a
  reason the code contradicts or one that states no checked fact declines nothing, so its finding
  counts as a gap. A `SKIPPED: SPEC:` line declines a finding only when the block's text prescribes
  the code it cites, or that code lies in code the block's text excludes or another block of the plan
  owns. Acceptance checks it against the block's text and the other blocks. An amendment in
  `AMENDED-<id>.md` is the developer's claim too. Acceptance reproduces its defect against the file:line
  and the clause it cites before the amendment excuses a criterion, and an amendment whose defect it
  cannot confirm leaves that criterion unmet. Acceptance may also override a line whose reason holds.
  Each gap it writes gives a fix direction it checked against the code it would change. A line whose
  reason starts `ESCALATED:` records a default routed to the user, and acceptance holds it. It audits
  the risk file of each round since the block's last blind review, against that round's own hunks (§6).
  In the closing pass it sorts each gap as
  blocking or not blocking, and it lands the block when no gap blocks. Otherwise the block parks
  (§6). Every defect it writes in its review file counts as a gap, including a regression the block
  prescribes or no current caller reaches. A change counts as required only when the block's text or
  the ACTIONABLE entry names it, so a break that a prescribed construction causes and the text does
  not name is a regression. A change that removes a defect a review finding named, or the same
  defect on a sibling path of a required fix or of such a finding, is not a regression when the code
  shows the removed behavior was a real defect, the change alters no other behavior, the block's
  text does not exclude that code, no other block of the plan owns it, and it lies in a zone the
  policy lets the developer change (§4). Under `proactive`, a change that closes a pulled backlog
  entry's defect (§4) is not a regression when the code shows the removed behavior was that defect and
  the change alters no other behavior. The developer never dismisses a regression it confirms. It fixes
  the regression, with an amendment when prescribed text causes it. It escalates the regression when
  that fix would change a choice the text says the user made, so the block parks with the user's
  question. It also escalates with a default when only a change in other code closes it (§4). A
  regression a review names is another agent's claim too, so the developer fixes it once it confirms it
  against the code, and drops one it refutes as a false positive, with the file:line that refutes it. A
  regression its own self-review finds it always fixes or escalates. The review file holds no notes
  section. In fix mode, an ACTIONABLE entry the developer did not report is an open gap, as one it
  reported SKIPPED is, in every round and in the closing bar. For a pass, the engine renders the ids of
  the members' entries the developer did not report. A single fix block's acceptance reads the block to
  find them, since the engine never parses a block. A FAILED report is no gap by itself, since that
  entry syncs `needs-attention` and goes back to the user. In fix mode, a harm an entry lists whose
  cause shares no code path with the re-derived root cause is a new issue, never a gap. A sibling path
  with the identical defect stays a residual path. The verifier appends a new issue to its source
  block's backlog file (§10), and the entry's `**What:**` names the source issue id. The return counts
  every writer's entries in `backlogEntries` and names each file in `backlogFiles`. Work a block's file
  (§10) once that block is `done`, `skip` or `backlogged`, since a relaunch of the block may still
  append to it. `args --backlog` leaves the file out until then (§10 step 4). In fix mode, an entry with
  an `- origin:` line holds a parked block's unfinished work. When it also carries a `- branch:` line,
  the round-1 developer restored that branch's work (§7), unless the accepted baseline already holds it,
  so acceptance judges that entire branch work as the entry's fix. Every such entry's fix also meets
  every acceptance criterion of each block its `- origin:` line names, and for a feature or section
  block its reachability. The gaps the entry's `**What:**` copies are another agent's claims. The
  round-1 developer confirms each against the code as it confirms a review finding, closes each one it
  confirms and declines each one it refutes with a DISMISSED line. Acceptance counts a listed gap closed
  when the code closes it or a ledger line declines it. A listed gap for a wrong risk answer,
  for a sweep line that is missing, leaves out a hit, or disagrees with the change, or for a path
  that changed after its round's snapshot, takes no fix and no log, and acceptance counts it closed,
  since the block's first blind review judges the entire restored work. A park entry's `- ledger:`
  line names the `DISMISSED-<id>.md` of the parked block, and its `- amended:` line names
  the `AMENDED-<id>.md` files of the blocks its `- origin:` line names. The round-1 developer re-checks
  each line of that ledger as it re-checks an earlier launch's line, and copies each one it keeps into
  its own block's ledger, the one ledger the blind reviewer reads. It reproduces each such amendment's
  defect and meets an origin criterion under an amendment it reproduces. Acceptance reads both files,
  counts a ledger line the developer did not copy as settling nothing, and judges an origin criterion
  under such an amendment only once it reproduces the amendment's defect. A landed block holds a
  branch's work only when acceptance returned `actually_fixed=true` for every entry that names that
  branch, since the developer may keep or revert the restored work of an entry it reports FAILED. In
  commit delivery, acceptance deletes each such branch with `git branch -D` only on a pass with no
  regression that it committed with the block's title, the reviewed tree and a clean tree after, and
  returns each branch its deletion left behind. In stage delivery, acceptance deletes no branch, since
  the user may still reject the staged work. On a pass with no regression that it staged, it returns
  each such branch, and `nextStep` says to delete it once the user commits that work. Every other
  branch stays, and so does every branch on any other verdict, so a rejected landing can be rebuilt
  from it.
- **Park** — saves then clears, never the other way. `ordered: false` → the run CONTINUES past a
  parked block; `ordered: true` → the run STOPS there (later blocks depend on it). A needs-user
  escalation parks the same way. Every other escalation stops the run. Park saves the block's work
  as one commit on the branch `aipg-unfinished/<the block's backlog file id>` (§10) in
  `target.repo`. It builds the commit with git plumbing on a temporary index file under `scratch/`,
  seeded with a copy of the repo's index, so the repo's index stays untouched and no commit hook
  runs. The commit's first parent is HEAD in commit mode, and in stage mode a commit whose tree is
  the staged index's tree and whose parent is HEAD. Its tree adds the block's unstaged edits and
  untracked files. Its message is `unfinished: <block title>`. When the branch already exists, its
  tip is the commit's second parent, so earlier unfinished work stays in its history. The park of a
  fix block also takes the tip of each branch its round 1 restored as a further parent, then deletes
  that branch, since the new commit holds its work. It does so for a branch whose every entry the
  developer's last report gave FIXED, and for a branch whose restored diff the working tree still
  holds (`git apply -R --check` accepts it), since a FAILED entry may keep or revert that work. That
  branch's entry syncs `stale`, or, when the developer never reported it, `nextStep` says to set it
  `stale`. The new entry's `**What:**` names it, and the new entry's `- origin:` and `- amended:`
  lines add that entry's values, so the block built from it still meets their criteria under their
  amendments. Its `- ledger:` lines need no carry, since round 1 copied each line it kept into the
  block's own ledger. After a halt that may
  leave the block's work staged or committed (§2 step 5), the park keeps each restored branch, since
  the new commit may lack part of that work. Park clears the tree only after it confirms the
  commit's tree differs from its first parent's tree, and a tree with no work makes no commit and
  clears nothing. Park then appends one entry to the block's backlog file, with
  `- category: unfinished`, a `- branch:` line naming the branch when this park made a commit, a
  `- origin: <planPath>#<block id>` line, a `- ledger:` line naming the block's `DISMISSED-<id>.md`
  and an `- amended:` line naming its `AMENDED-<id>.md`, each only when that file exists, and a
  `- decision:` by §10's rule. The park of a block
  whose developer escalated a user-only question is always `NEEDS_USER`, whatever halt parked it.
  The entry's `**What:**` copies the escalated question, the halt reason, or the gaps of the last
  review file, whichever caused the park. After a closing acceptance it copies the blocking gaps
  first. A park that made a commit ends the `**What:**` with a `Pulled:` line naming each pulled
  entry whose fix the branch holds (§4), and each id the `Pulled:` line of an entry it superseded
  names. A halt that parks a block with an escalated question copies the halt reason and then that
  question. A `plan-unreadable` halt reason names the bare plan-block command, and its park runs
  that command itself and writes its exit code and first error line under the entry's `Halted:`
  line as the cause. Its `**Fix:**` says to close those gaps on top of the branch's work, so each
  origin block meets its criteria. An entry with no branch says to build each origin block on the
  accepted baseline instead, and its `- size:` gives the size of that build, since no work was saved. The block syncs `backlogged`, and its work continues from that entry. A held
  park syncs `blocked` instead, its entry is `NEEDS_USER` unless its park agent died or returned a
  report that contradicts itself, and §2 step 5 says which route its work then takes. Fix mode takes
  only gate `green`, so the park of a `red-baseline` block, or of a `build-only` block in a run with
  no test gate, also syncs `blocked`, whatever halt parked it. Its entry is `NEEDS_USER`, and its
  `**Fix:**` says to set the entry `stale` and the block back to `todo`, which rebuilds the block
  under its own gate once any halt that holds the park is resolved. A round file that an agent's
  prompt does not name may come from an earlier launch of the block, so the agent ignores it.
- **Sweep** (opus) — runs only when `sweep: goal-coverage` AND every non-skip block is done
  (launch-status `done` plus this run's accepted ids). Re-greps the surface from `goal`, runs the
  full gates, writes `SWEEP.md`, where each gap's follow-up block gives a fix direction it checked
  against the code. It holds an escalated default in `DECISIONS.md` as acceptance holds it, so a goal
  hit it covers is no gap unless the reason it gives is false. It reads every other `DECISIONS.md` line
  and every `AMENDED-<id>.md` as claims, so one excuses a goal hit only once the sweep confirms it
  against the code. Advisory: a dead sweep is the `failed` entry
  `{ id: 'sweep', stage: 'sweep' }`, never a halt.

## 6. Loop, gates & verification

`develop → quality (must be clean, apart from the closing pass) → acceptance (stages on pass, and commits in commit mode)`,
up to `maxRounds` (default 5) per block, then one closing pass when the last round fails.

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
a copy of the real index, and deletes that file once it prints the tree id. The real index, which
holds the accepted baseline, is never written. After its answers the risk file holds a `## Sweep`
section. For each function, constant, field, message or rule phrase the round changed, it lists
the search the developer ran and each hit, marked `updated` or `unaffected` with a few words of
reason, and a changed field, return value, file format or output that other code or prompts read
lists those readers as hits. A round that changed nothing writes no section. The blind review runs
in a block's first round with a satisfied gate in a launch, a fix block that restored a parked block's
branch included. A later round gets one when a round since the block's last blind review returned
`review_needed` true or no boolean, or an acceptance verdict since then returned `risk_misclassified`
true. Any other round goes from the developer straight to acceptance.
Git holds one cumulative unstaged diff, so acceptance reads each audited round's own hunks from two
snapshots. It runs `git diff --stat <base> <snapshot>` and then `git diff <base> <snapshot> -- <file>` per file, where `<snapshot>` is the line in that round's risk
file and `<base>` is the line in the risk file of the round before it. The engine hands acceptance
the `risk_snapshot` each of those rounds returned, and acceptance confirms each file's snapshot line
equals it before it audits. A line that differs, or a round that returned no tree id, counts as a
missing file. On every verdict, acceptance also runs the same snapshot commands on a temporary index
file of its own, before it stages anything, and lists the paths that differ from the snapshot the
last round returned with `git diff --name-only`. A path that differs is a risk-audit gap, since it
changed after the developer handed its round on, unless it is untracked build output or a cache that a
gate or test run regenerates. When the last round returned no snapshot, this check has nothing to
compare, and an unreviewed round's missing snapshot is already a missing file. It checks each answer in
the risk file of each round since the last blind review against that round's hunks. It also checks
the sweep of the latest of those rounds: each changed name or phrase in that round's hunks needs a
line, and each hit marked `unaffected` must still agree with the change. A missing file, a missing
snapshot line in an audited round's file or in its base file, a change the file does not judge low
risk, an answer the hunks contradict, a changed name or phrase with no sweep line, an
`unaffected` hit that disagrees with the change and a hit that acceptance finds by running the
line's search again and the line leaves out are each a gap, and the verdict returns
`risk_misclassified` true, which sends the next round to a blind review.

**Closing pass.** When round `maxRounds` ends without a passed acceptance, one more developer runs,
and no develop round follows it. It takes round number `maxRounds + 1` in its file names. It makes each
fix of the last review's findings and gaps that is low risk, and records each one whose fix is not as
an entry in its block's backlog file (§10), with a `**Fix:**` line naming the fix, a
`**Parked with:**` line naming the block and no DISMISSED line, under both policies. Each entry takes
its decision by §10's rule, and its line holds it out of every build until the block is `done` or
`skip` (§10). It returns those
entries' ids in `recorded_entries`. When the dedup forbids an append, it returns the id of the entry
that holds the item instead. The closing acceptance confirms that each listed id names an entry in
its backlog file before it relies on it, and a missing entry, or a list that is not usable, is a
gap. A blind review follows the closing pass when its changes owe one by the
rule above, whatever its gate, and the closing acceptance reads that review's file. A block never
lands with a change that needs a blind review and has none.

The closing acceptance sorts each gap into one of two kinds. A blocking gap is a regression, a red
gate, an unmet criterion of a feature or section block, an ACTIONABLE entry of a fix block whose root
cause is not closed, a change made for an entry that is not ACTIONABLE or a change no FIXED claim
accounts for, a defect at medium severity or higher that the block's diff introduces, a wrong risk
answer or a sweep line that is missing, leaves out a hit, or disagrees with the change, in changes
no blind review has read, or a path the tree check finds changed after its round's snapshot. Every other
gap is not blocking, such as a low or nit finding or a cleanup. A finding the closing blind review raises
against a dismissal is a gap of either kind by the same rule, unless it contests an `ESCALATED:` line
acceptance holds. With no blocking gap, the closing acceptance stages the block, commits it in commit
mode, and appends each gap that is not blocking as one entry in the block's backlog file, with a
`- decision:` by §10's rule. The block syncs `done`, and its ledger status names the count of those
entries. With a blocking gap, the block parks, and its park entry lists the blocking gaps first and names
each entry the closing pass listed. Every round before the closing pass keeps the bar where every gap
fails acceptance.

Gate semantics per block: `green` = build + the block's verification passed
(`tests_run_count==0` is a false green) — and when `suite: green`, a reddened existing suite fails it
too; `suite: scoped` drops the whole-suite requirement (mid-run red is expected in a migration).
`red-baseline` (section mode) = authored tests fail for the right reason, count 0 fails.
`build-only` = build green.

Halts match the sibling engines (dirty baseline, needs-user, plan-unreadable, agent-dead,
passed-unstaged, acceptance-regression, park-unsafe, budget) plus `relayed-request`, `staging-unconfirmed`,
`rejected-staged`, `restore-failed`, `review-unwritten`, `passed-regression` and `log-cap`. Commit
mode adds `staged-baseline` and `commit-unverified`, which **Commit mode** below describes.
`relayed-request` means a developer reported a user request relayed into its context, so the run was launched
inside a user turn. The halt runs no park and no reviewer, because each would read the same message, and it
records its block `blocked`. The developer may have changed the run worktree, so settle the tree as §4 says,
run §2 step 3, set the block back to `todo`, run step 3 again, and relaunch from a notification turn.
`rejected-staged` means acceptance failed a block but staged it, so inspect
`git diff --cached <tree id>` with the tree id the halt reason names, which lists only what that
acceptance staged, and unstage that block's files before resuming. `passed-regression` means
acceptance passed a block but flagged a regression and staged nothing. Its work is parked, and the
block ends as §5 Park says. Never stage that work as it is. `acceptance-regression` means acceptance
staged a block while its verdict flagged a regression, so inspect the view its halt reason names,
`git diff --cached <tree id>` in stage delivery. To keep the work, run §2 step 3, then
set the block's `status:` to `done`. Then set each fix issue that the acceptance file named in the
halt reason confirmed closed to `fixed` or `stale`, as §2 step 5 maps a landed block's issues. Under
`proactive`, also run `plan-edit.mjs args --backlog <backlogDir> --fold-only`, which writes the run's
statuses into the backlog files and prints nothing. Only then set each pulled entry that the
acceptance file confirmed closed to `fixed` or `stale`, since a later fold overwrites a hand edit made
before it. To reject it, unstage the block's files, set them aside as §4 describes, run §2 step 3, then set the
block's `status:` to `todo`. Either way, run step 3 again for the launch args. `review-unwritten`
means a quality reviewer or acceptance verifier failed a block without confirming its review file.
`log-cap` stops the run before a block once no room for a status line is left in the runtime's first
1,000 log lines, and a relaunch builds the rest. A block whose status lines overrun that room still
finishes. Its lines past 1,000 survive only in the return's `statusSync`, and the next block halts.
When that block was the last in a `sweep: goal-coverage` run, the run halts before the sweep. Every
block is then done, so a relaunch has nothing to build, and you verify coverage against the goal
yourself. Every exit leaves a clean tree except passed-but-unstaged, a commit-mode halt whose reason
names the tree dirty check, and a `park-unsafe` halt whose park did not confirm a clear. After every
run, grep integration points, read every `AMENDED-<id>.md` and surface `NEEDS-USER.md`,
`DECISIONS.md`, the files in `backlogFiles`, `SWEEP.md` and the path of each `DISMISSED-<id>.md` that
`nextStep` names and that exists, so the user can audit every judgment call. Before landing, do not
re-run the gates, read the review files or audit those ledgers yourself, since acceptance and the gate
of `wt.mjs close` cover them. Do not view the accepted diff, apart from a record a guide asks for, such
as debug's stat record in stage delivery. Once §2 step 6 says the run lands, land it there and
report its summary.

**Commit mode.** With `commit: true`, acceptance stages each accepted block, then commits it with the
block's title as the entire message: it writes the title to `<stateDir>/commit-<id>.txt` and runs
`git -C <repo> commit -F` on that file. It never passes `--no-verify`, `--no-gpg-sign` or `--amend`, so
the repo's commit hooks and signing run. A legitimate no-op pass makes no commit. The accepted baseline
is HEAD, and nothing stays staged between blocks. Each commit lands on `aipg/<runId>` in the run
worktree, and §2 step 6 moves the user's branch to them. Round 1 halts with `staged-baseline`, before any
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

The wrong subject and tree changed checks run only on a valid sha. The tree dirty check runs only
when `committed` is true, since a refused commit leaves its reviewed work staged. The reason names
every failed check with the value acceptance reported, then `git -C <repo> show --stat <sha>` on a
valid sha. An `acceptance-regression` reason on a commit-mode pass ends with the same list.
`commit-unverified` syncs the block `blocked`. Settle the work, run §2 step 3, then set the block's
`status:` to `done` when the accepted baseline holds its reviewed work, or to `todo` to rebuild it.
For a fix block set to `done`, also set each fix issue that its acceptance file confirmed closed to
`fixed` or `stale`, as for `acceptance-regression`. Under `proactive`, a block set to `done` also
closes its pulled entries as for `acceptance-regression`. To reject a committed block after
`acceptance-regression`, `commit-unverified` or `rejected-staged`, run `git -C <repo> revert <sha>`
in place of the unstage. Park is the same in both modes. An acceptance verifier that dies may have
committed or staged its block, which park never saves. Its `agent-dead` reason names the HEAD the
block started from. Before you relaunch, revert any newer commit that `git -C <repo> log -1 --stat`
shows and unstage what `git -C <repo> diff --cached --stat` lists.

**Research NEEDS-USER before asking.** For each unanswered question the blocks named in `nextStep`
wrote to `NEEDS-USER.md`, or to a park's backlog entry in an unordered run, read the code, the docs
and the conventions it touches, and send a research subagent to the web when the answer rests on an
outside fact. Settle each question the evidence settles, and record the evidence. Ask the user only
the rest, each with a recommendation. Show the settled ones too, with their evidence, so the user can
overrule them.

## 7. Resume

Durable state = git staging (HEAD's commits in commit mode) + the plan file's status lines + the
review-file trail. A relaunch with args from a fresh `plan-edit.mjs args` (never the previous args
object) rebuilds pending from `todo`, with the finished runs already applied. `runOnly` is the one
explicit slice, and an unknown id throws. When the run-record fold is unavailable (records past
`cleanupPeriodDays`, or `--expect` fails), recover with `runOnly` or by editing the statuses in the
plan file. A `resumeFromRunId` replay of a run launched with a retired arg throws at launch. A
parked block's work is on its `aipg-unfinished/<backlog file id>` branch, not the tree, unless its
park halted `park-unsafe`. That halt reason and `nextStep` say where its work is. The block is
`backlogged`, or `blocked` after a held park until §2 step 5 resolves it. Its park entry is the one
place its work continues from, except for a park no fix block can build (§5 Park). Triage that entry
like any other (§10). Once it is `ACTIONABLE`, build its backlog file in fix mode. That block's
round-1 developer restores the branch into the unstaged tree after the clean-baseline check, with
`git diff --binary <branch>^1 <branch> | git apply -3` on a copy of the index (`GIT_INDEX_FILE`), so
both reviewers judge the restored work. The 3-way apply carries the branch onto blocks that landed
after its parent, and the copy keeps the real index unstaged, since `-3` implies `--index`. The
developer resolves a conflict only when it confirms the resolution against the accepted baseline and
the branch's work, and reports one it cannot confirm as `restore_failed`. It
skips a branch whose work the accepted baseline already holds (`git apply -R --check` accepts its
diff), which a landed block that kept a FAILED entry's restored work leaves. When the block lands,
acceptance deletes the branch, or in stage delivery `nextStep` says to delete it once the user
commits the staged work (§5). A branch that is missing, fails to apply or holds a conflict the developer cannot confirm leaves the
tree clean and every branch as it was, and the fix block syncs `blocked`. The user then rebuilds the branch on
the accepted baseline, by rebasing or re-committing it so that `git diff <branch>^1 <branch>`
applies there, and keeps the work on the branch, never in the tree, the index or the baseline, since
the baseline holds only reviewed work. Or the user skips the entry and deletes the branch. In an
ordered plan, the blocks after a parked block depend on it, so build its entry before you relaunch
them. `continueParked` is retired and throws. A park from an older engine left `parked-<id>.patch`
and a `## Parked block:` entry in `NEEDS-USER.md` in its state dir. Restore that patch by hand with
a plain `git apply` and finish the block, or redo it. Before you relaunch under `focused` a run that
an engine from before the rename ran under `strict`, rewrite each `STRICT <id>:` tag in its
`DECISIONS.md` to `FOCUSED <id>:`. The acceptance and developer prompts name only `FOCUSED <id>:`
lines, so acceptance counts a fix logged under the old tag as a regression.

**Run killed mid-block** (operator stop, API error, dead Workflow): the unstaged tree is that block's
unreviewed work. Set it aside with §4's save-and-clear, which saves it to a patch under the state dir
and leaves the staged index alone, then relaunch clean. Never `git add -A` it. No status edit closed
the killed block's pulled entries (§4), so remove each `- pulled: <runId>#<that block id>` line from
the backlog folder, since the patch holds their work. In commit mode the killed
block's acceptance may have committed or staged its work, and no landing check read it. Before you
relaunch, revert a commit that `git -C <repo> log -1 --stat` shows with the killed block's title as its
subject, using `git -C <repo> revert <sha>`, and unstage what `git -C <repo> diff --cached --stat` lists.

## 8. State files (`runs/<runId>/`, outside every repo)

`gate/quality-review-<id>-rN.md` · `acceptance-review-<id>-rN.md` · `risk-<id>-rN.md` (the
developer's risk answers for round N, outside `gate/`, §6, starting with the line
`Snapshot: <tree id>`) · `gate/DISMISSED-<id>.md` · `AMENDED-<id>.md` · `NEEDS-USER.md` (an ordered
run's questions) · `question-<id>.md` (an unordered run's question for one block, which park copies
into its entry) · `DECISIONS.md` · `PULLED-<id>.md` (under `proactive`, the ids of the backlog
entries the block's round-1 developer pulled, §4) · `commit-<id>.txt` (commit mode: the block's title, its commit's
message) · `SWEEP.md` · `scratch/` (the agents' plan block copies, test logs and park's temporary
index file, never in `gate/`). A parked block's work is on a branch of `target.repo` and its entry
is in the backlog folder (§10), so neither is in the state dir. An `<id>` past 60 characters keeps
its first 51 characters and a hash of the whole id, so two long ids that share a prefix get separate
files.

## 9. Args reference

Full schema + defaults: the Config block atop `develop-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `plans` (non-empty array of
  `{ id, title?, planPath, mode, gate, status, model?, effort? }` rows that `plan-edit.mjs args`
  prints, or a `--pack` pass
  `{ id, title?, mode: fix, gate, status, model?, effort?, blocks: [{ id, planPath, issues }] }`.
  Malformed **throws** naming the shape. A row with no `planPath` **throws** naming it. A `model`
  outside `opus | sonnet | haiku | fable` or an `effort` outside `low | medium | high | xhigh | max`
  **throws** naming the row.) · `target.repo` (**throws** if missing) · `gates.build` (**throws** if
  missing) · `gates.test` (**throws** when any PENDING block's gate is `green` — deliberately
  pending-scoped, so an all-done relaunch reaches its terminal) · `backlogDir` (the absolute folder
  `project-settings.mjs backlog` prints, §10. **Throws** when missing, relative or inside
  `target.repo`, and the message names the command) · `blockTool` (the `plan-block.mjs` path that
  `plan-edit.mjs args` prints, so spreading its output passes it. **Throws** when missing or blank,
  and the message names that command).
- **File keys:** `ordered` (boolean) · `suite` (`green|scoped`) · `sweep` (`goal-coverage|none`) ·
  `goal` (string). Typed illegal values **throw** — spread what `args` prints. `sweep: goal-coverage`
  with an empty `goal` **throws**.
- **Return:** `status` · `halted`/`haltReason` · `regression` (true when any block's ledger entry
  reads true. An entry follows the last acceptance verdict that reports the field, and a passing
  verdict that omits the field sets it false) · `plansDone` · `parked` (per parked block, its
  `branch`, null when the park made no commit, its `backlogFile`, and `entryWritten`, false when the
  park did not confirm its entry) · `ledger` (per block, with a status of the form
  `<token> (<meaning>)`, the developer `model` and `effort` it ran on, `rounds`, `closingPass` (true
  when the block ran its closing pass, §6), `commit` (the sha of the block's commit, null in stage
  mode, on a no-op pass, when the commit did not land or failed the unverified sha check, and on a
  block acceptance rejected, whose commit the halt reason names), per-issue `results` in fix
  mode, and `pulled`, each pulled entry as `{ issue_id, status, confirmed }`, which is empty under
  `focused`) · `statusSync` (the plan-file edits, also logged per block for §2 step 5. An edit whose
  `value` is null removes its key's line, which closes a pulled entry's `- pulled:` line. An edit with
  `expectPulled` applies only to an entry whose `- pulled:` value is `expectPulled`. An edit with
  `expectNoOpen`, which develop adds for the backlog file of each pulled entry it closes, applies only to
  a `todo` block that holds no open entry) · `sweep` ·
  `failed` (`{ id: 'sweep', stage: 'sweep' }` when the sweep ran and died, else empty, so
  `sweep: null` with no entry means the sweep did not run) · `backlogEntries` (every mode, the
  entries developers, fix verifiers and closing acceptances added to the backlog this run, null when
  one returned no usable report) · `backlogFiles` (the sorted backlog files the developers, fix
  verifiers and closing acceptances named, null when `backlogEntries` is null) · `nextStep` (when
  the run added entries, it names the folder, the files and the count, and asks you to report each
  added entry's severity, title and decision to the user. In commit mode it names each committed
  block with its sha. It says nothing is staged when the run did not halt, and otherwise points at
  `git diff --cached --stat`).
- **Optional:** `conventions` · `conventionFiles` (an array of the project's CLAUDE.md paths, each
  absolute or relative to `target.repo`, which every agent reads in full. A value that is not an array
  of non-empty strings **throws**) · `reference` · `gates.testSetup` ·
  `target.lang`/`framework` · `maxRounds` (1–50, default 5, **throws** on garbage) · `changePolicy`
  (`focused|proactive`, default `focused`, any other value **throws**, and `strict`, the old name of
  `focused`, throws with a message that names the rename. It sets the developer's build aim and
  whether it fixes a pre-existing defect it notices in connected code, and §4 says how to choose it)
  · `commit` (`true | false`, default `false`, any other value **throws** naming the arg and the
  value. `false` stages each accepted block, and `true` commits it, §6 "Commit mode". In commit mode
  a row's `title`, which `plan-edit.mjs args` prints, is the commit's entire message, a title that
  is not one line of text **throws** naming the row, and a row with no title commits under its id.
  The launch log line names it) · `minPlanBudget` (**throws** on non-numbers) ·
  `models`/`efforts`/`agentTypes` (`models` and `efforts` map a role key to a value. The role keys
  are `develop` (the developer, the closing pass included), `park`, `quality`, `acceptance` and
  `sweep`. A model is `opus | sonnet | haiku | fable` and an effort is
  `low | medium | high | xhigh | max`. The develop, quality, acceptance and sweep roles default to
  opus. Every role defaults to `high`. A block's `model:` and `effort:` lines override
  `models.develop` and `efforts.develop` for that block's developer. The park role takes
  `models.park`, else its block's developer model, and takes `efforts.park`, else the block's
  developer effort. `agentTypes` maps the develop, quality, acceptance and sweep keys to a custom subagent that must exist in your registry. It has no park key, so the park agent takes `agentTypes.develop` and a park key throws. The
  engine **throws** at launch, naming the arg, on a value that is not an object, a key outside the
  role keys, a value outside its set, and a blank `agentTypes` name. Choose the review roles' models as §3 says. Role settings
  saved in the repo's settings (§2 step 3) count as the user asking for them, as a saved memory
  preference does. One launch log line names each role's model and effort) · `stateDir` · `runOnly`.
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for
  the agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and
  outside `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of
  this checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt
  then ends with an instruction to append the survey's answers to its own file in `dir`.
  A `notes` arg without both paths, or with a `dir` inside `target.repo` or `runs/<runId>/`, **throws**.
  Once the run ends, run `node <survey's folder>/survey.mjs <dir>`
  and report the themes of the `SURVEY.md` it writes to the user.
- **Retired:** `continueParked` (a park's backlog entry continues its work, §7), `startAt`,
  `reviewSeverity` (the developer's risk judgment decides when a blind review runs, and every blind
  review reports every tier), a top-level `planPath` and `planContext` are retired and **throw**.
- **Agent returns the loop reads (§6):** the developer's `review_needed` (true when any change of
  its round is not low risk, and a non-boolean counts as true), its `risk_snapshot` (the tree id on
  its risk file's first line, which acceptance's risk audit confirms, and a value that is not a tree
  id counts as no risk file) and, in the closing pass only,
  `recorded_entries` (the ids of the backlog entries it listed, appended or already there, which a
  park's entry names) · the round-1 developer's `baseline_index_tree` (the index's tree id before it
  changed anything, which the first acceptance of a launch confirms, §5) and `launch_number` (the
  launch its amendment headers name, and a value below 1 or not an integer is logged and renders
  `launch unrecorded`) and `earlier_files` (true when the block's `DISMISSED-<id>.md` or
  `AMENDED-<id>.md` existed before it wrote. Only `false` there, with no round, round 1 included,
  appending to a file, lets the blind review, acceptance and park (and, for DISMISSED, each later
  developer round) say that file does not exist in place of a read step, so any other value keeps
  every read step. Under `proactive`, a round-1 `pulled_results` of `[]` does the same for
  `PULLED-<id>.md`. Neither counts from a round 1 that reported `plan_obtained=false` or
  `needs_user=true`, since it may have stopped before those steps) · acceptance's `index_matched`
  (false halts `staging-unconfirmed`, and a
  non-boolean is logged as unverified) and `index_tree` (the index's tree id once it finished, after its
  `git add` when it staged, which the next acceptance confirms. A value that is not a tree id is logged,
  and the next acceptance then compares nothing unless a round-1 developer reports a tree id first. The
  tree id that acceptance returns restores the check) · in commit mode, the round-1
  developer's `baseline_staged_files` (the files staged before it touched anything, above 0 halts
  `staged-baseline`, and a non-number is logged as unverified) · under `proactive`, the developer's
  `pulled_results` (each pulled entry's `FIXED`,
  `STALE` or `FAILED`, every round) and acceptance's `pulled_checks` (each pulled entry's
  `actually_fixed`, and only the latest verdict's checks count, §4) · acceptance's
  `risk_misclassified` (true when its risk audit found a gap) · in commit
  mode, acceptance's `committed`, `commit_sha`, `commit_subject`, `tree_matches` and `tree_clean`,
  which the landing checks of §6 "Commit mode" read, and a failed check halts `commit-unverified` ·
  the blind reviewer's `issue_count`, which counts every finding at every tier. `minor_count`, the
  old count of findings below a review's bar, is retired.
- An all-non-todo `plans` array returns `nothing to run (no todo blocks)` — not an error.

## 10. Working the backlog

The backlog folder is the one place for the work a run leaves for later on one project, across all
of its runs. An entry is a defect, a cleanup, a feature, a decision or an unfinished block. A defect
is a real problem the run left in the code. A cleanup is a nit or a clearer name the run did not
make. A feature is a feature or refactor outside a block's scope. A decision is a choice the
developer escalated and proceeded past by a default. An unfinished block is a parked block's work,
which its park saved on a branch (§5 Park). A park entry is triaged and built like any other entry.
The folder is the one that `node <project-settings.mjs> backlog --root <root> --repo <target.repo>`
prints, and every launch passes it as `backlogDir`. A run's entries for one block go to one file
there, `<file id>.md`, created with the first entry. `<file id>` is
`<run slug>-<block slug>-<pair hash>`:
- `<run slug>` is the runId through the engine's `slug()`, or `run-` and the engine's `fnv1a()` hash of
  the runId when that slug is empty, as for a runId with no ASCII letter or digit.
- `<block slug>` is the block id through `slug()`. It equals the block id for an id of 60 characters or
  fewer.
- `<pair hash>` is the `fnv1a()` hash of the JSON array `[runId, block id]`. It keeps two runs apart
  whose slugs join alike, such as run `a` with block `b-c` and run `a-b` with block `c`.

Each file is a fix-mode plan file. Its header is
`## Plan: <file id> - backlog from block <block id> of run <runId>`, then `mode: fix`, `gate: green`
and `status: todo`. A writer that finds the file already there keeps its header and appends below
its last entry. When the file's `status:` line reads `skip`, the writer sets it to `todo`, since
`plan-edit.mjs args --backlog` builds only `todo` and `done` files. Its entries take debug's issue-file shape, with the id `<file id>-<n>` and
a `- decision:` that the writer sets by one rule. The decision is `ACTIONABLE` when the entry is a
defect or a cleanup with one clear fix, its size is trivial or small, and the fix changes no
user-visible behavior, stored data or public contract. It is `NEEDS_USER` otherwise, such as a
feature, a refactor, a choice between fixes, or a fix that changes user-visible behavior. A later
run builds an `ACTIONABLE` entry without triage, and a
`NEEDS_USER` entry waits for the user. A cleanup entry carries `- category: cleanup`. A feature entry
carries `- category: feature` and a decision entry `- category: decision`, and both carry
`- decision: NEEDS_USER`. An unfinished entry carries `- category: unfinished`, a `- branch:` line
naming the branch that holds the work when that branch exists, and an `- origin: <planPath>#<block id>`
line naming the block the work was built for. It carries a `- ledger:` line naming the block's
`DISMISSED-<id>.md` and an `- amended:` line naming its `AMENDED-<id>.md`, each only when that file
exists. Its `**What:**` indents every line it copies from a
file by four spaces, so a copied heading, fence or `- <key>:` line never ends the entry or starts
another. These four kinds carry no `- severity:` line.
An entry a developer pulled beside its block carries `- pulled: <runId>#<block id>` (§4). No launch
builds it while that line stands, and the run's status edits remove the line, apart from a park whose
branch holds the entry's fix, whose entry ends with a `Pulled: <ids>` line. That line says to set
each id `fixed` once the park entry is fixed and landed, and to remove only each `- pulled:` line once
the park entry is skipped, or set `stale` while its block is rebuilt from `todo`.
An entry that a closing pass or an escalated default recorded may carry the line
`**Parked with:** block <id>. Hold this entry until that block is done or skip.` (§5, §6), since the
code it names sits on that block's branch or is not built yet. A line that a closing pass or an
escalated default writes names a block of the run the file's header names, and a line that step 1
below writes names a block of the run the entry's `**Closed by:**` line names. The line never sets
the entry's decision. No launch builds the entry while a line that starts with `**Parked with:**`
stands, and the developer and acceptance of a fix block treat it as not ACTIONABLE.
`args --backlog` cuts the line from an open ACTIONABLE entry once that block is `done` or `skip` in
its plan file, so the entry builds like any other. A block that is `backlogged`, `blocked` or `todo`
keeps the hold, since its code sits on a branch or is not built. A line that names no block as
`block <id>`, a block no run record names, a plan file that is gone and a plan file that no longer
holds the block keep the hold too, and the note `args` prints says to delete the line by hand once
that block is `done` or `skip`.
Before the developer, fix acceptance or the closing acceptance appends an entry (§5, §6), it greps
the folder's `*.md` files by the file path and the name of the function or identifier at the defect,
reads each matching entry, and never appends a defect that an entry with `- status: open` or
`- status: needs-attention` already holds. A defect whose only entries say `fixed` or `stale` is
back in the code, so it gets a new entry whose `**What:**` names theirs.

When the user asks to work the backlog:

1. Run `node <project-settings.mjs> backlog --root <root> --repo <target.repo>`, which prints the
   folder. Then run `node <plan-edit.mjs> args --backlog <that folder> --fold-only`, which writes
   every finished run's statuses into the folder's `todo` and `done` files that hold an ACTIONABLE
   entry, sets no `done` file to `todo` and prints nothing. It runs before every read and hand edit
   below, since a later fold would overwrite a hand edit made before it. Then read each file in the
   folder. For each entry with a `**Closed by:**` line and a `- status:` of `open`
   or `needs-attention`, confirm the accepted baseline holds the fix. When it does, set
   `- status: fixed` and leave the entry out of the steps below, since the writers' dedup treats an
   open entry as still holding the defect. When the code does not hold the fix and the entry carries
   no `**Parked with:**` line yet, find the run the line names. When it names none, ask the user
   which run closed the entry, since an older engine wrote that line into any file of the folder.
   When that run's backlog file for that block, whose header names the block and the run, holds an
   entry with `- category: unfinished` and a `- status:` of `open` or `needs-attention`, or that run
   halted `park-unsafe` on that block, hold the entry, since building it would collide with that
   block's unlanded work. Every park writes that entry, into the file of the pass id for a packed
   pass. A run from an older engine wrote its park instead as the heading line
   `## Parked block: <the block id>` in its state folder's NEEDS-USER.md, so hold the entry when
   that line is there as an entire line. To hold it, set its `- decision: NEEDS_USER` and add the
   line
   `**Parked with:** block <id>. Hold this entry until that block is done or skip.`
   after its `**Fix:**` line, where `<id>` is a block of the run the `**Closed by:**` line names. The
   decision keeps `args --backlog` from releasing it, since `args` looks the block up in the run the
   file's header names. Step 3 owns an entry once it carries that line. Otherwise treat the
   entry like the rest. Last, apply step 5 to the folder.
2. List only the entries that wait on the user, grouped by severity, highest first, with the entries
   that carry no severity last. An entry waits on the user while its `- decision:` is `NEEDS_USER` or
   `DEFER`, or while it is ACTIONABLE and its `- status:` is `needs-attention`, which a fix that failed
   or did not land sets.
   An entry whose decision is SKIP never waits on the user, whatever its status. It keeps its status
   unless step 3 sets one, so `- status: open` alone never lists an entry. An entry whose `- status:`
   is `fixed` or `stale` never waits on the user either, whatever its decision. Also list each entry with
   a `**Parked with:**` line, whatever its decision, with a note naming the block that line names,
   and leave it out of the triage in step 3 while it is held. Leave out every ACTIONABLE entry of a `backlogged` file, since that
   file's park entry carries it and step 5 closes it once its work lands. List each other entry of
   that file with a note naming the file, and leave it out of the triage in step 3 until step 5 sets
   the file `done`, since an entry approved before then would be closed with entries it was never
   built with.
   Then research each entry that step 3 triages, before you present it. First confirm that its defect
   or gap still holds in the accepted baseline, and cite the file:line. When it no longer holds,
   recommend a skip, since the accepted baseline holds its fix. Otherwise list its fix options, the
   lowest-impact fix and the most automated one among them. Fix the criteria and their weights before
   you score, score each option in a decision matrix, and run a flip check that names the smallest
   weight change that changes the winner. Mark the flip check ROBUST when that change is larger than the
   uncertainty in that weight, else FRAGILE. Last, argue once against the winner and check that argument
   against the code. Recommend the winner with a one-line reason and its flip-check mark.
3. Triage them with the user. Present each entry with its recommendation and its matrix. The user may
   answer for all of them at once, such as "apply the recommendations". When the user has delegated
   triage, apply each ROBUST recommendation yourself and ask only about each FRAGILE one and each
   change to the architecture. Record each decision as one `**Triage:**` line after the entry's
   `**Fix:**` line, with its reason, since the developer reads the entry and the matrix belongs in your
   report. Set each entry the user decides to skip to `- decision: SKIP`. When a
   skipped entry carries an `- origin:` line, also set each block it names to `skip`, or to `todo` to
   rebuild it, since a `backlogged` block whose entry never syncs `fixed` never reaches `done`. When it
   also carries a `- branch:` line, delete that branch with `git -C <repo> branch -D <branch>`, since a
   later park of the rebuilt block would otherwise stack on the skipped work. When it ends with a
   `Pulled:` line, remove the `- pulled:` line of each entry that line names, so a later run can take
   that entry again. Set each
   entry the user approves to `- decision: ACTIONABLE`, and rewrite its `**Fix:**` line to encode the
   option the user chose. Hold an entry with a `**Parked with:**` line while the block it names is
   not `done` or `skip` in its plan file, since until then the code it names sits on that block's
   branch or is not built. Step 5 sets the block `done` once its park entry lands, a closing
   acceptance that lands the block makes it `done` with no park entry, and dropping the block sets
   it `skip`. A released ACTIONABLE entry takes no triage, since `args --backlog` cuts its line and
   builds it (step 4), and its developer records it STALE when the accepted baseline already holds
   its fix. Once the hold on a NEEDS_USER entry ends, remove its line, skip the entry when the
   accepted baseline holds its fix, and triage it like the rest when the code does not. Set
   `- status: fixed` on each entry skipped because the accepted baseline holds its fix.
   A `status: todo` file left with no ACTIONABLE entry and no entry that waits on the user is not a
   plan, so set it to `status: skip`, as debug's triage does.
4. Build the files that hold an ACTIONABLE entry whose status is not `fixed` or `stale` and that
   carries no `- pulled:` or `**Parked with:**` line, with `node <plan-edit.mjs> args <file> [<file> ...] --pack <target.repo>`
   and a develop launch in fix mode, from §2 step 3. `args --backlog <backlogDir> --pack <target.repo>`
   takes the place of naming the files. It first cuts the `**Parked with:**` line of each open
   ACTIONABLE entry whose block is `done` or `skip`, as the hold paragraph above says. A file named
   on the command line gets no cut, so its held entries stay held. It adds every `todo` or `done` file that holds an ACTIONABLE
   entry with `- status: open` and no `- pulled:` or `**Parked with:**` line, and none with `- status: needs-attention`,
   sets each `done` one to `todo`, and prints an unordered set, so it refuses an ordered plan file.
   It leaves out a file while the block that wrote it is not `done`, `skip` or `backlogged` (§5). It matches the run records whose `runId`
   arg and block id match the file's header, and whose `backlogDir` arg, when they keep one, names
   this folder. An older record with no args stands for its run through the `runId` its result
   echoes. The `backlogDir` test is there because a run of another project may share the `runId`
   and block id. It finds the block's plan file in those records' block status edits or in the rows of their
   `plans` arg. A header that names a pass or one of its members matches that pass's row. It reads the
   block's status in its plan file with those records folded in, without writing that file. A file
   whose block no record names, such as one whose records expired (§2 step 5), or whose plan file is
   gone, is not held back. A block's plan file that exists but fails to read or validate, or whose run
   records cannot be folded into it, fails the command, since that block's status is unknown. A file
   named on the command line skips this check, so name one only once its writer block is `done`,
   `skip` or `backlogged`. It also leaves out a file with a ready entry whose `- file:` path the text
   of a `blocked` block, or of an older engine's `parked` block, names, since a relaunch of that
   block may change that file, and notes each held entry with that block. Those blocks are the
   `blocked` and `parked` blocks of the plans named on the command line and of every plan a run on
   this folder built. A file named on the command line skips this hold too, so name one only once
   no such block's text names the `- file:` path of one of its ready entries. The file is held, not the entry alone,
   since develop builds every ACTIONABLE entry of a file it builds. A file that holds an ACTIONABLE
   entry with `- status: needs-attention`, such as one whose entry the user approved again in step
   3, is never added, so name it as a file. A file whose `status:` is not `todo`, such as a `done`
   file whose needs-attention entry the user approved again, first takes §2 step 5's order: run
   `args` on it, set its `status:` to `todo`, then run `args` again for the launch. A `backlogged`
   file never takes that order, since its park entry carries its ACTIONABLE entries. The round-1
   developer of a file whose ACTIONABLE entry carries a `- branch:` line restores that branch's work
   first (§7). Each `args` call writes the fold of the files it names and, with `--backlog`, of every
   `todo` or `done` backlog file that holds an ACTIONABLE entry, so apply step 5 to the folder again
   after it. Once the run lands, repeat steps 1 to 4. Stop when `args --backlog` exits 1 with a
   message that ends `nothing to build`, even while a file this step says it leaves out still holds a
   ready entry.
5. Each entry in the folder with an `- origin:` line and `- status: fixed` takes this step while the
   blocks that line names are not all `done` or `skip`. `<repo>` in this step is the user's checkout,
   never a run worktree. Run this step only when `git -C <repo> status --short --untracked-files=no`
   prints nothing, so the index and every tracked file match `HEAD` and every test below reads
   committed work. Untracked files never block the step, since no test below reads them. Otherwise
   tell the user and leave the step for a later check. A branch test passes for a branch that
   `git -C <repo> rev-parse --verify --quiet refs/heads/<branch>` resolves when
   `git -C <repo> diff --stat <branch>^1 <branch>` prints nothing, or when
   `git -C <repo> diff --binary <branch>^1 <branch> | git -C <repo> apply -R --check --cached` succeeds.
   `--cached` checks the patch against the index, so an untracked copy of a file the branch adds never
   passes it. Round 1's restore uses the same `diff --stat` test first, and the reverse-apply check
   without `--cached`, since `git apply` exits 128 on an empty patch. Both tests can fail on landed
   work, since a fix block may edit the lines its branch added. Take the step for an entry
   only once close has landed its fix block on the user's branch. When the entry's `- branch:` line
   names a branch that resolves, it has landed only when a branch test passes or the user says that
   work is on their branch, since an earlier build of the same file can leave its title in the log.
   When the entry has no `- branch:` line or its branch does not resolve, it has landed when
   `git -C <repo> log --format=%s` prints the title that `node '<blockTool>' <its file> --list` prints
   for its file, or a `pass of` title that names its file's id, since commit mode commits each accepted
   block or pass with its title as the message (§6, "Commit mode"). When no test holds, such as for work
   the user committed under another message, ask the user whether that work is on their branch. An entry
   whose fix block the current run built waits for a later check, since close has not landed it yet. Once
   the step takes an entry, its fix block has landed and acceptance checked its work against every
   criterion of each block that line names. Set each of those blocks to `status: done` in its plan file,
   and delete the entry's branch when it resolves, with `git -C <repo> branch -D <branch>`. When the
   entry ends with a `Pulled:` line, set each entry that line names to `- status: fixed` and remove its
   `- pulled:` line, since the landed branch work holds its fix. A plan with
   `sweep: goal-coverage` runs no sweep for an origin block, so verify its coverage against the plan's
   goal yourself. When an origin block is a fix block, also take each of its ACTIONABLE entries whose
   `- status:` is absent, `open` or `needs-attention`, since those entries are its criteria. Set such an
   entry `fixed` when it carries no `- branch:` line, when its branch does not resolve, or when a branch
   test passes on its branch. When its branch resolves and both branch tests fail, ask the user whether
   that entry's work is on their branch, and set it `fixed` when the user says it is. The log test never
   decides such an entry, since its parent's title lands whether or not that entry's branch was restored.
   Apply this step to each entry it sets `fixed` with no further landed test, since the check that set it
   `fixed` covers it, and delete that entry's branch when it resolves. Leave the status and branch of
   every other such entry as they are, since its work has not landed. Once its file is `done`, step 2
   lists it when its status is `needs-attention`, and step 4 builds it when its status is absent or
   `open`.
