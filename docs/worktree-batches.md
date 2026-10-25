# Worktree batches and single changes

One checkout cannot host two engine runs at once: they share a working tree, so their unstaged
diffs — the exact thing every blind reviewer is handed — bleed into each other. A **batch** gives
each parallel chain its own git worktree, so isolation comes from *placement*, not instruction.
`tools/wt.mjs` is the whole mechanism: a deterministic operator-invoked script, no agents, no
engine changes — a worktree is just a different absolute path to pass as `target.repo`.

This design is option E-c of the decide run `worktree-parallelism-1` (2026-07-29). That run measured
the batch rules, such as the hook bytes, the exit codes and the lock liveness. This file and the
`tools/wt.mjs` header cite each measurement by its label, such as M25. This file is the one playbook,
so guides link to it and do not copy it.

## The shape

```
--base (your branch, e.g. main)
  └─ aipg/int-<batch>          integration branch, cut fresh at init     worktree aipg-int-<batch>
       ├─ aipg/<batch>/<a>     chain branch, cut at prep                 worktree aipg-<a>
       ├─ aipg/<batch>/<b>     chain branch, cut at prep                 worktree aipg-<b>
       └─ …
```

Worktrees are created beside the repo (`--dir` overrides, given once to `init`). Nothing is stored:
every verb rediscovers paths from `git worktree list --porcelain`, and one batch is active per repo
at a time.

## The lifecycle

```
1  init  --repo <abs> --batch <name> [--base <branch>] [--dir <abs>]   once, before any fan-out
2  prep  --repo <abs> --batch <name> --key <chain> [--provision "<cmd>"]   once per chain (concurrent-safe)
3  run the engine, one run per chain, target.repo = the path prep printed
4  land  --repo <abs> --batch <name> --key <chain> --gate "<cmd>" [--scope-file <p>] [--wait-ms N] [--stale-ms N]
5  clean --repo <abs> --key <chain>          after that chain landed
6  clean --repo <abs> --batch <name>         after ALL chains landed and were cleaned
7  you merge aipg/int-<batch> where you want it (PR branch, develop, main) — and you commit
```

stdout carries exactly one value — the worktree path the verb acted on — so
`target=$(node tools/wt.mjs prep …)` is safe; everything human-readable goes to stderr.

At stage 3, each engine run is ordinary, except that `git stash` is refused (see `refs/stash`
below): same workflow, same args, only `target.repo` differs (and `root` stays shared, so all
runs of the batch report into the same runs/ area under distinct runIds).

## Removal

`clean` moves a worktree folder to the operating system's trash through `tools/trash.mjs` and then
runs `git worktree prune`. It never runs `git worktree remove`, since that deletes the folder and its
ignored files permanently. Ignored files go to the trash with the folder. The stderr of `clean` names
the trash location and the number of ignored files.

`clean` exits 40 and changes nothing when the worktree:

- is the main worktree of the repo, whose `.git` holds the repository itself,
- is locked,
- has a folder at its path whose `.git` file does not point at the worktree's git directory, such
  as another repository moved there,
- holds modified, staged or untracked files,
- has a merge, cherry-pick, revert, rebase, am or bisect in progress,
- holds submodule git directories in its git directory, which `git worktree prune` would delete
  outside the trash,
- holds the working directory of the process that runs `clean`,
- holds the `--repo` path, since the prune after the move runs there.

A rebase or bisect detaches HEAD. So `clean` finds that worktree by the branch the operation records,
as git does, and `clean --batch` counts it as a chain still registered.

The trash can also refuse the move or fail to confirm it. Either case is exit 40 and prunes nothing.
A worktree still registered after the prune is exit 40, and its folder has already left its path.
Check its entry in `git worktree list --porcelain`, then run `clean` again. A registered worktree
whose folder is gone is pruned. When it is also locked, run `git worktree unlock` first. To discard
unlanded work, run the trash and prune commands that the refusal of `clean` prints. They also trash
any submodule git directories.

## One change in its own worktree

`open` and `close` build one change in its own worktree, with no batch.

```
1  open  --repo <abs> --name <name> [--base <branch>] [--dir <abs>] [--provision "<cmd>"]
2  run the engine, target.repo = the path open printed, and commit the accepted work there
3  close --repo <abs> --name <name> --into <branch> --gate "<cmd>"
4  run the full suite in the main checkout (see "untracked files" below)
```

`open` cuts `aipg/<name>` from the `--base` branch and checks it out in a worktree beside the repo.
With `--base` omitted, it cuts from the current branch. `--dir` places the worktree elsewhere, and
`--provision` runs as it does for `prep`. Since the hook and the land lock guard the chains of a batch,
`open` installs no hook and `close` takes no lock. A branch that already exists is refused. So is a
name that starts with `int-` in any case, since `aipg/int-<x>` is the integration branch of batch
`<x>`. When git creates the worktree and then exits nonzero, as it does on a failed post-checkout
hook, `open` exits 40 and keeps the worktree. Its stderr relays git's output and names the commands
that remove the worktree. `prep` does the same. `init` names a rerun of `init`, which re-uses the
worktree.

`close --into` runs these steps in order:

1. When the `--into` branch has a commit `aipg/<name>` lacks, it rebases `aipg/<name>` onto it. A conflict
   aborts the rebase and exits 20 with `aipg/<name>` back at its old tip. A rebase that stops with no
   conflicted file, such as on a commit that fails to sign, is aborted the same way and exits 40. The
   rebase turns off directory rename detection. So a file that `aipg/<name>` adds to a directory the
   `--into` branch renamed stays at the path the branch gave it.
2. It runs the gate in the worktree on the exact commit the `--into` branch will point at. A red gate
   exits 30.
3. It moves the `--into` branch to that commit by fast-forward only. When the `--into` branch moved
   during the gate, it exits 20.
4. It verifies the move, then removes the worktree as `clean` does and deletes `aipg/<name>`.

A refusal before the rebase changes nothing. Each later stop keeps the steps already done, such as a
rebased `aipg/<name>`, a moved `--into` branch or a worktree in the trash. Running `close` again
finishes the steps left. `close` exits 40 in cases such as these:

- the `--into` branch is the integration or chain branch of a batch, which only `land` moves, under
  its lock,
- the `--into` branch is a symbolic ref, or is checked out in more than one worktree, since a
  fast-forward updates the files of only the worktree it runs in,
- the worktree that has the `--into` branch checked out has lost its folder, or its folder holds
  another repository,
- the worktree fails a check of `clean`, such as the one for unlanded work,
- the worktree `open` made is off `aipg/<name>`, such as on a detached HEAD,
- the `--into` branch is checked out in a worktree that has staged or modified tracked files, an
  untracked file in the way of the fast-forward, or an unfinished operation, such as a rebase of the
  `--into` branch itself,
- the rebase would drop a merge commit of `aipg/<name>` and any change made only in that merge,
- the rebase or the fast-forward would overwrite an ignored file, which git deletes without a word,
- the rebase left uncommitted changes in the worktree, such as files a hook wrote,
- the gate moved `aipg/<name>`, switched the worktree off it, or left changes in the worktree.

`close --discard` moves the worktree to the trash with its uncommitted work and any unfinished
operation, and keeps `aipg/<name>`. Its stderr lists that work and operation, the branch tip, and the
command that deletes the branch. For a rebase or bisect, it also names the detached HEAD, which
reaches any commit made during the operation. Every other refusal of `clean` still applies, and so
does the refusal of a worktree off `aipg/<name>`.

On a file system that folds case, `open` and `close` refuse a `--name`, `--base` or `--into` that
matches a branch only in another case. `close` also refuses an `--into` branch that a worktree has
checked out under a name in another case.

## Exit codes — the contract the orchestrator branches on

| Code | Meaning | Orchestrator's move |
|---|---|---|
| 0 | success | continue |
| 10 | nothing to land (no accepted work, branch already contained) | move on — not an error |
| 20 | sync merge conflicted, aborted; branch keeps its work, integration untouched. For `close`, the rebase conflicted and was aborted, or the `--into` branch moved | human or fix run resolves on the branch. After a moved `--into` branch, run `close` again |
| 30 | gate red on the SYNCED state; sync merge kept on the branch, integration untouched. For `close`, the gate was red on the commit the `--into` branch would point at | fix run against the branch |
| 40 | unsafe / precondition, one-line reason names what to do | do that, re-run the verb |
| 75 | lock held by another land, or lost mid-gate before merging | the ONLY code to retry |
| 1 | unexpected (bad argv, bad --repo, git missing) | read stderr |

## Sequential vs parallel vs dependent

- **Sequential** work is one engine run's `plans` array — it never needs a batch.
- **Parallel** work is N engine runs, one per prepped chain worktree.
- **Dependent** work is phases: land and clean phase 1's chains, then `prep` phase 2's — its
  branches cut from integration then *contain* phase 1's landed work.

## Scope files — lenient by design

`--scope-file` (path globs, one per line — the chain's declared Files) makes `land` print one
WARNING per out-of-scope file. Warnings never change the exit code: deliberate minor overlap (a
shared config, two endpoints in one controller) is expected to auto-merge, and the merge (20) +
gate (30) stay the arbiters. No fatal mode in v1.

## The two shared things worktrees do NOT isolate

- **`refs/stash`** — one stack for every worktree of a repo, so a stash in one chain can `pop`
  into a sibling's tree and its blind reviewer's diff (measured, M25). `init` installs a
  `reference-transaction` hook refusing `refs/stash` updates from inside `aipg-*` worktrees, and
  `prep` proves the hook live in each fresh worktree before any agent runs there. Your own
  `git stash` outside `aipg-*` worktrees is untouched. The hook's bytes are load-bearing
  (M19/M20/M31). Do not edit them. Inside a chain worktree, `git stash` is refused. Set an
  interrupted block's unreviewed work aside with develop's save-and-clear
  (`workflows/develop/CLAUDE.md` §4), which never uses the stash. Never follow the
  hook's `git add -A` advice for work no reviewer passed.
- **The integration branch** — two lands merging into it at once is the one step that cannot
  overlap. `land` serializes on `<git-common-dir>/aipg-land.lock`, held across sync+gate+merge.
  Liveness is a **heartbeat, not an age**: the holder rewrites the lock at each step boundary, so
  a progressing land never goes stale however long it runs. The gate is the one stretch with no
  beat inside it — if it outruns `--stale-ms` (default 20 min) a waiter may take over, and the
  loser then *refuses to merge* and exits 75 (retry) rather than writing unguarded. Set
  `--stale-ms` above your slowest gate to avoid ever hitting that path.

## One divergence to know: untracked files

A fresh worktree carries only TRACKED files — nothing gitignored or untracked crosses over. A gate
that scans the tree (a cache dir, a downloaded artifact, a stray fixture) can therefore pass in every
chain worktree and still fail in the main checkout after the merge (measured: batch h2's control-byte
scan vs `tools/.cache`). Always run the full suite in the main checkout after merging the integration
branch or after `close`. That run is part of the merge, not optional.

## What commits, and who

`land` and `close` are the only verbs that write commits, all on `aipg/*` branches and all
deterministic. `land` writes the index-only accept commit, the sync merge and the landing merge.
Nothing else in a batch touches your branches, and the merge of `aipg/int-<batch>` into anything of
yours is stage 7, done by you (WORKFLOW-PRINCIPLES.md #9). The rebase of `close` rewrites the
`aipg/<name>` commits and adds no change of its own. Since the `--into` branch moves only by
fast-forward, every change that reaches it is one you committed, or an accepted block that develop's
commit mode, which you turned on, committed.
