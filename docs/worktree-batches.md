# Worktree batches — running chains in parallel

One checkout cannot host two engine runs at once: they share a working tree, so their unstaged
diffs — the exact thing every blind reviewer is handed — bleed into each other. A **batch** gives
each parallel chain its own git worktree, so isolation comes from *placement*, not instruction.
`tools/wt.mjs` is the whole mechanism: a deterministic operator-invoked script, no agents, no
engine changes — a worktree is just a different absolute path to pass as `target.repo`.

Decided in `runs/worktree-parallelism-1/decision-r3.md` (E-c); every load-bearing rule below
(hook bytes, exit codes, lock liveness) is a measured decision recorded there and in the
`tools/wt.mjs` header. This file is the one playbook — guides link here, nothing copies it.

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

At stage 3, each engine run is completely ordinary: same workflow, same args, only `target.repo`
differs (and `root` stays shared, so all runs of the batch report into the same runs/ area under
distinct runIds).

## Exit codes — the contract the orchestrator branches on

| Code | Meaning | Orchestrator's move |
|---|---|---|
| 0 | success | continue |
| 10 | nothing to land (no accepted work, branch already contained) | move on — not an error |
| 20 | sync merge conflicted, aborted; branch keeps its work, integration untouched | human or fix run resolves on the branch |
| 30 | gate red on the SYNCED state; sync merge kept on the branch, integration untouched | fix run against the branch |
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
  (M19/M20/M31) — do not edit them.
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
branch — that run is part of the batch, not optional.

## What commits, and who

`land` is the only verb that commits: the index-only accept commit, the sync merge, the landing
merge — all on `aipg/*` branches, all deterministic. Nothing here touches your branches; the merge
of `aipg/int-<batch>` into anything of yours is stage 7, done by you
(WORKFLOW-PRINCIPLES.md #9).
