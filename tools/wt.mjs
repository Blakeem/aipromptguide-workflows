// tools/wt.mjs — the batch worktree lifecycle for running several AIPG chains in parallel.
//
// Why this exists. Two engine runs in ONE checkout share a working tree, so their unstaged diffs — the
// exact thing every blind reviewer is handed — bleed into each other. Giving each chain its own git
// worktree fixes that by PLACEMENT rather than by instruction, and costs the engines nothing: a worktree
// is just a different absolute path to pass as `target.repo`. No engine, no agent, no harness is
// involved here; this is a deterministic script the operator runs around the runs.
//
//   init  --repo <abs> --batch <name> [--base <branch>] [--dir <abs>]     once, BEFORE any fan-out
//   prep  --repo <abs> --batch <name> --key <chain> [--provision "<cmd>"] once per chain, concurrent-safe
//   land  --repo <abs> --batch <name> --key <chain> --gate "<cmd>"        once per chain, SERIALIZED
//   clean --repo <abs> --key <chain>                                      after that chain has landed
//   clean --repo <abs> --batch <name>                                     after the batch has landed
//
// "after it has landed" is a precondition `clean` ENFORCES, not advice: it removes a worktree without
// `--force`, so a tree still holding modified, staged or untracked work is refused (exit 40) instead of
// deleted (see `removeWorktree`) — and `clean --batch`, which also removes the shared hook, is refused
// while any chain worktree of that batch is still registered (see `cleanBatch`).
//
// The one thing worktrees do NOT isolate is `refs/stash` — it is a single stack shared by every worktree
// of a repo, so a `stash push` in one chain and a `stash pop` in another injects a sibling's work into
// that chain's tree AND into its accepted index (measured: runs/worktree-parallelism-1/decision-r3.md
// M25). `init` therefore installs a `reference-transaction` hook that refuses `refs/stash` updates from
// inside an `aipg-*` worktree, and `prep` PROVES the hook is live in each fresh worktree before any agent
// runs there (M30). The hook's bytes below are load-bearing and measured — the obvious three-line version
// exits 1 on every ref transaction and bricks every commit and merge in a linked worktree (M19/M20), and
// the `aipg-*` scoping is what leaves the user's own `git stash` working everywhere else (M31). Do not
// "improve" it.
//
// PATHS ARE NEVER STORED. Every verb rediscovers them from `git worktree list --porcelain`: the
// integration worktree is the entry on `aipg/int-<batch>`, a chain worktree the entry on
// `aipg/<batch>/<chain>`. That is what lets a non-default `--dir`, given only to `init`, be found by
// every later verb — and what makes "another batch is already active" answerable without a state file.
//
// LANDING IS SERIALIZED BY ONE REPO-GLOBAL LOCK FILE, `<git-common-dir>/aipg-land.lock`. Fan-out is the
// point of this tool, but two lands merging into the same integration branch at once is the one step that
// cannot overlap — so `land` holds that lock across sync+gate+merge and releases it on every exit path.
// The path is shared knowledge between `land` (creates it) and `clean --batch` (may remove a stale one);
// nothing else may touch it.
//
// LIVENESS IS A HEARTBEAT, NOT AN AGE. The holder rewrites the lock at every land step boundary — after
// COMMIT, after SYNC, after GATE — refreshing `heartbeatAt`, and staleness is measured from THAT alone.
// `startedAt` only identifies the holder and dates the takeover message. Measured against a start time,
// a land whose gate is a real test suite goes "stale" for no reason other than having taken a while, and
// a second land then steals the lock out from under a holder that is mid-merge. A progressing land is
// never stale, however long it runs; a wedged one still is.
//
// A heartbeat at a BOUNDARY still leaves one stretch a takeover can land inside — the gate, which is a
// whole test suite and the longest thing here. So the step that writes to the shared integration worktree
// RE-READS the lock immediately before it and refuses to merge on a lock this land no longer holds
// (exit 75). Detecting the loss on the way out, after the merge, is not a serialization guarantee.
//
// `land` is also the only verb that COMMITS: an index-only accept commit of the chain's accepted work, a
// sync merge, and the landing merge — all on `aipg/*` branches, all by this deterministic script. The user
// still makes every commit that reaches their own branches (WORKFLOW-PRINCIPLES.md #9).
//
// stdout carries ONE value: the worktree path the verb acted on (prep's is the `target.repo` an engine
// run is handed; land's is the integration worktree). Everything a human reads goes to stderr, so
// `target=$(node wt.mjs prep …)` is safe.
//
// Exit codes are the contract an orchestrator branches on:
//   0   success
//   10  nothing to land — the chain accepted no work AND its branch is already contained in the
//       integration branch. NOT an error; the orchestrator moves on.
//   20  conflict — the sync merge conflicted and was aborted. The branch keeps its work, integration is
//       untouched. A human or a fix run resolves it on the branch.
//   30  integration-red — the gate failed on the SYNCED state. The sync merge is kept on the branch (it
//       records the exact combined state a fix run must address); integration is untouched and green.
//   40  unsafe / precondition — foreign hook, no init, another batch active, hook self-test failed,
//       provision red, unlanded work in a worktree being cleaned, a batch cleaned while its chains are
//       still registered, an empty index over a dirty tree, a sync git refused up front, a command
//       killed for flooding its output buffer. Always with a one-line reason naming what to do.
//   75  retry-later — another land holds the lock, or this land LOST it (taken over mid-gate) before it
//       could merge, so it merged nothing. The ONLY code an orchestrator should retry.
//   1   unexpected — bad argv, bad --repo, git missing.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_NOTHING = 10;
export const EXIT_CONFLICT = 20;
export const EXIT_RED = 30;
export const EXIT_UNSAFE = 40;
export const EXIT_RETRY = 75;
export const EXIT_ERROR = 1;

/**
 * The reference-transaction hook, verbatim and byte-exact — this string IS the identity test (see
 * `hookState`), so every character of it is significant.
 *
 *   line 2  only the `prepared` state can abort a transaction
 *   line 3  scope: THIS repo's aipg-* worktrees only. Without it the hook fires in the user's own
 *           worktrees too (M31). git's worktree id is the directory basename, hence the `aipg-` prefix
 *           on every path `init`/`prep` create.
 *   line 7  the fix M19 needed: without a trailing `exit 0`, the failed `[` test inside the loop is the
 *           hook's exit status and EVERY commit, branch and merge in a linked worktree dies.
 */
export const HOOK = `#!/bin/sh
[ "\${1:-}" = "prepared" ] || exit 0
case "$(git rev-parse --absolute-git-dir)" in */worktrees/aipg-*) ;; *) exit 0 ;; esac
while read -r _old _new ref; do
  [ "$ref" = "refs/stash" ] && { echo "AIPG: refuse: 'git stash' inside a batch worktree. refs/stash is ONE stack shared by every worktree of this repo, so a later 'stash pop' can inject this work into a sibling issue's tree and into its blind reviewer's diff. Fold with 'git add -A' instead." >&2; exit 1; }
done
exit 0
`;

const PROBE_FILE = '.aipg-hook-probe';
const LOCK_FILE = 'aipg-land.lock';

// Stated literals, not derived from anything: how long a land may wait for the lock before telling the
// orchestrator to retry, and how long a lock may go WITHOUT A HEARTBEAT before a live-looking owner is
// assumed to have wedged.
const DEFAULT_WAIT_MS = 600000;
const DEFAULT_STALE_MS = 1200000;
const LOCK_POLL_MS = 2000;
// A steal that keeps failing means something is recreating the lock; three rounds of it is a fault, not a
// race to keep spinning on.
const MAX_TAKEOVERS = 3;

const intBranch = (batch) => `aipg/int-${batch}`;
const chainBranch = (batch, key) => `aipg/${batch}/${key}`;
const intDir = (batch) => `aipg-int-${batch}`;
const chainDir = (key) => `aipg-${key}`;

// =============================================================================
// Process + failure helpers
// =============================================================================

/** An Error carrying the exit code the CLI must report. `unsafe` is the 40 half of the table. */
function fail(message, exitCode = EXIT_ERROR) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}
const unsafe = (message) => fail(message, EXIT_UNSAFE);

/** One line, whitespace-trimmed — every reason this tool prints is a single line. */
const firstLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';

// What execFileSync caps a child's combined stdout+stderr at when no `maxBuffer` is passed. Named only
// so the overflow message can state the limit it actually hit.
const NODE_DEFAULT_MAX_BUFFER = 1024 * 1024;

/** The two codes a child killed for overflowing that cap comes back with (ENOBUFS on Windows). */
const isOverflow = (err) => err.code === 'ENOBUFS' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * Run a command and hand back its exit code as a VALUE. A nonzero exit is the normal answer to half the
 * questions here ("does this ref exist", "did the hook refuse"), so it must not throw.
 *
 * The one shape that must NOT come back as a value is an overflow. A child killed for writing past
 * `maxBuffer` never reports a status at all (`err.status` is null), and `null ?? EXIT_ERROR` would hand
 * the caller a FABRICATED exit 1 that no caller can tell apart from a real failure — measured: a --gate
 * that wrote 2 MiB and exited 0 was reported as integration-red. An exit code this function did not
 * observe is not a value it may return.
 */
function run(cmd, args, cwd, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', ...opts });
    return { code: EXIT_OK, stdout: String(stdout ?? ''), stderr: '' };
  } catch (err) {
    if (err.code === 'ENOENT') throw fail(`cannot run "${cmd}" — it is not on PATH`);
    if (isOverflow(err)) {
      throw unsafe(`"${cmd}" was KILLED in ${cwd} for writing more than ${opts.maxBuffer ?? NODE_DEFAULT_MAX_BUFFER} bytes to stdout+stderr — it never reported an exit code, so this is NOT a report that it failed; make it quieter and run it again`);
    }
    return { code: err.status ?? EXIT_ERROR, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

/** `git -C <cwd> …`. -C rather than a cwd option so the failure message always names the repo. */
const git = (cwd, args) => run('git', ['-C', cwd, ...args]);

/** For the git calls whose failure is a precondition the operator must clear, not a branch we take. */
function mustGit(cwd, args, what) {
  const r = git(cwd, args);
  if (r.code !== 0) throw unsafe(`${what} failed: ${firstLine(r.stderr) || firstLine(r.stdout) || `git exited ${r.code}`}`);
  return r.stdout;
}

/** `git status --porcelain` as `['XY path', …]` — the XY prefix is load-bearing (` A` = intent-to-add). */
const porcelainLines = (worktree) => git(worktree, ['status', '--porcelain']).stdout
  .split('\n')
  .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  .filter(Boolean);

/** Those lines as a one-line file list — a message naming the files is what makes a 40 actionable. */
function fileList(lines, cap = 8) {
  const files = lines.map((l) => l.slice(3).trim()).filter(Boolean);
  const head = files.slice(0, cap).join(', ');
  return files.length > cap ? `${head} (+${files.length - cap} more)` : head;
}

// =============================================================================
// Discovery — every path in this tool comes from here, never from stored state
// =============================================================================

/** `[{ path, branch }]` for every worktree of the repo; `branch` is '' for a detached entry. */
function listWorktrees(repo) {
  const out = mustGit(repo, ['worktree', 'list', '--porcelain'], 'listing the worktrees');
  const entries = [];
  let current = null;

  for (const raw of out.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: '' };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return entries;
}

// Segment counts, not a prefix match: a batch named `int-x` would otherwise make the chain branch
// `aipg/int-x/<chain>` read as an integration branch and collide with `aipg/int-int-x`.
const isIntegration = (branch) => /^aipg\/int-[^/]+$/.test(branch);
const integrationEntries = (entries) => entries.filter((e) => isIntegration(e.branch));
const findBranch = (entries, branch) => entries.find((e) => e.branch === branch) ?? null;

/** `{ batch, key }` for an `aipg/<batch>/<chain>` branch, else null. Segment counts, as above. */
function chainParts(branch) {
  const parts = branch.split('/');
  return parts.length === 3 && parts[0] === 'aipg' ? { batch: parts[1], key: parts[2] } : null;
}

/** The chain worktree for `key` under ANY batch — `clean --key` is not given the batch name. */
const findChain = (entries, key) => entries.find((e) => chainParts(e.branch)?.key === key) ?? null;

/** Every chain worktree still registered under `batch` — the ordering `clean --batch` enforces. */
const batchChains = (entries, batch) => entries.filter((e) => chainParts(e.branch)?.batch === batch);

/**
 * Where the hook must be written (M27). Resolve it from a LINKED worktree: the main worktree answers
 * with a RELATIVE `.git/hooks/…` and the write lands wherever the process happens to be. Honours
 * `core.hooksPath`.
 */
function hookPath(linkedWorktree) {
  const out = mustGit(linkedWorktree, ['rev-parse', '--git-path', 'hooks/reference-transaction'], 'resolving the hook path').trim();
  return isAbsolute(out) ? out : resolve(linkedWorktree, out);
}

/**
 * The hook-exists rule, stated ONCE and obeyed by init AND clean: bytes equal to what init writes means
 * the hook is ours (init no-ops, clean may remove it); anything else is someone else's file (init
 * refuses, clean leaves it).
 */
function hookState(path) {
  let bytes = null;
  try {
    bytes = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return 'absent';
    throw fail(`cannot read the reference-transaction hook at ${path}: ${err.message}`);
  }
  return bytes === HOOK ? 'ours' : 'foreign';
}

function writeHook(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, HOOK);                                    // LF only — the byte-compare depends on it
  try { chmodSync(path, 0o755); } catch { /* Windows has no exec bit; git runs the hook regardless */ }
}

// =============================================================================
// init — the ONLY verb that checks-then-acts, which is why it runs before any fan-out
// =============================================================================

/** The branch to cut the integration branch from. No default branch is discoverable in a local repo. */
function resolveBase(repo, base) {
  if (base !== undefined) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).code !== 0) {
      throw unsafe(`--base "${base}" is not a commit in ${repo}`);
    }
    return base;
  }
  const head = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  if (head.code !== 0) {
    throw unsafe(`--base was omitted and ${repo} is on a DETACHED HEAD — git has no machine-independent "default branch" in a local repo, so name the branch to cut from with --base`);
  }
  return head.stdout.trim();
}

function addIntegrationWorktree(repo, batch, base, path) {
  const branch = intBranch(batch);
  // `clean --batch` removes the worktree and KEEPS the branch (the user decides where the finished
  // integration goes), so re-initialising the same batch must re-use the branch rather than fail on it.
  const exists = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
  const args = exists
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, resolveBase(repo, base)];

  const added = git(repo, args);
  if (added.code !== 0) throw unsafe(`cannot create the integration worktree at ${path}: ${firstLine(added.stderr)}`);

  // Re-read git's own spelling of the path, so later discovery matches what we print here.
  return findBranch(listWorktrees(repo), branch)?.path ?? path;
}

function init(opt) {
  // Input
  const repo = requireRepo(opt);
  const batch = requireName(opt, 'batch');
  const parent = opt.dir === undefined ? dirname(repo) : requireAbsolute(opt, 'dir');

  // Process
  const active = integrationEntries(listWorktrees(repo));
  const mine = active.find((e) => e.branch === intBranch(batch)) ?? null;
  const other = active.find((e) => e.branch !== intBranch(batch)) ?? null;
  if (!mine && other) {
    throw unsafe(`batch "${other.branch.slice('aipg/int-'.length)}" is already active in ${other.path} — one batch at a time: land it and run "clean --batch" before starting "${batch}"`);
  }

  const integration = mine ? mine.path : addIntegrationWorktree(repo, batch, opt.base, resolve(parent, intDir(batch)));
  const hook = hookPath(integration);
  const state = hookState(hook);
  if (state === 'foreign') {
    throw unsafe(`a DIFFERENT reference-transaction hook already exists at ${hook} — refusing to clobber it; move it aside (or fold this hook's body into it) and re-run init`);
  }
  if (state === 'absent') writeHook(hook);

  // Output
  process.stderr.write(`${mine ? 'already initialised' : 'initialised'}: ${intBranch(batch)} in ${integration}\n`);
  process.stderr.write(`hook ${state === 'absent' ? 'installed at' : 'already ours at'} ${hook}\n`);
  process.stdout.write(`${integration}\n`);
}

// =============================================================================
// prep — a PURE `worktree add`, which is what makes N of them concurrent-safe (M26)
// =============================================================================

/**
 * '' when the probe changed NOTHING: the shared stash stack still reads exactly as `stashBefore`, and
 * this worktree is clean.
 *
 * The stash half is a DELTA against a baseline, never an emptiness test. `refs/stash` is one stack for
 * the whole repo — the operator's own WIP lives on it — so "the stack is non-empty" says nothing about
 * whether the probe left anything, and reading it that way failed `prep` for every developer who had
 * ever run `git stash` in the target repo. The porcelain half stays absolute: this worktree was created
 * by `prep` seconds earlier and nothing but the probe has touched it.
 */
function residueOf(worktree, stashBefore) {
  const stash = git(worktree, ['stash', 'list']).stdout.trim();
  const porcelain = git(worktree, ['status', '--porcelain']).stdout.trim();
  const parts = [];
  if (stash !== stashBefore) parts.push(`refs/stash CHANGED (top is now ${firstLine(stash) || 'an empty stack'})`);
  if (porcelain) parts.push(`the worktree is not clean (${firstLine(porcelain)})`);
  return parts.join('; ');
}

/**
 * M30 — prove the hook is live in THIS worktree before any agent runs in it. Hooks live in the common
 * dir so a fresh worktree inherits one for free, but "for free" is an assumption and this is the check
 * that turns it into a fact.
 *
 * The probe stash must never survive the check: an entry left on refs/stash is exactly the hazard the
 * hook exists to prevent, so the failure path undoes it before reporting.
 */
function selfTest(worktree) {
  // Baseline FIRST: whatever is already on the shared stack is the operator's, and the only question
  // this check may ask afterwards is whether the probe moved it (see `residueOf`).
  const stashBefore = git(worktree, ['stash', 'list']).stdout.trim();
  const probe = resolve(worktree, PROBE_FILE);
  writeFileSync(probe, 'aipg hook probe\n');
  const push = git(worktree, ['stash', 'push', '-u', '-m', 'aipg-probe']);

  if (push.code === 0) {
    const pop = git(worktree, ['stash', 'pop']);          // the stash HAPPENED — take it back off the stack
    rmSync(probe, { force: true });
    const residue = residueOf(worktree, stashBefore);
    throw unsafe(`hook self-test FAILED in ${worktree}: "git stash push" was ACCEPTED, so the reference-transaction hook is missing or broken — re-run init before starting any agent${residue ? `. CLEAN UP BY HAND: ${residue}${pop.code === 0 ? '' : ` (stash pop: ${firstLine(pop.stderr)})`}` : ''}`);
  }

  rmSync(probe, { force: true });
  const residue = residueOf(worktree, stashBefore);
  if (residue) throw unsafe(`hook self-test left residue in ${worktree}: ${residue}`);
}

function runProvision(command, worktree) {
  if (!command.trim()) throw fail('--provision needs a command (it was empty)');

  const r = run(command, [], worktree, { shell: true });
  // Onto stderr, both streams: stdout here belongs to the provision command, and stdout is reserved for
  // the one path this tool prints.
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.code !== 0) {
    throw unsafe(`--provision exited ${r.code} in ${worktree} — the worktree is LEFT IN PLACE (removing it would discard its branch); fix and re-provision by hand: ${command}`);
  }
}

function prep(opt) {
  // Input
  const repo = requireRepo(opt);
  const batch = requireName(opt, 'batch');
  const key = requireName(opt, 'key');

  // Process
  const integration = findBranch(listWorktrees(repo), intBranch(batch));
  if (!integration) {
    throw unsafe(`no worktree on ${intBranch(batch)} — run "wt.mjs init --repo ${repo} --batch ${batch}" first; prep creates nothing but its own worktree, deliberately (concurrent check-then-act races)`);
  }

  const path = resolve(dirname(integration.path), chainDir(key));
  const added = git(repo, ['worktree', 'add', '-b', chainBranch(batch, key), path, intBranch(batch)]);
  if (added.code !== 0) throw unsafe(`cannot create the worktree for "${key}" at ${path}: ${firstLine(added.stderr)}`);

  const worktree = findBranch(listWorktrees(repo), chainBranch(batch, key))?.path ?? path;
  selfTest(worktree);
  if (opt.provision !== undefined) runProvision(opt.provision, worktree);

  // Output
  process.stderr.write(`prepared ${chainBranch(batch, key)}\n`);
  process.stdout.write(`${worktree}\n`);
}

// =============================================================================
// The land lock — ONE file per repo, created by land, cleaned by land AND by clean --batch
// =============================================================================

/**
 * `<git-common-dir>/aipg-land.lock`, resolved from a LINKED worktree for the same reason `hookPath` is:
 * the main worktree answers `--git-common-dir` with a relative `.git`. `--git-path` is NOT usable here —
 * for a name git does not know, it answers with the PER-WORKTREE git dir, which would give every chain
 * its own lock and serialize nothing.
 */
function lockPath(linkedWorktree) {
  const out = mustGit(linkedWorktree, ['rev-parse', '--git-common-dir'], 'resolving the git common dir').trim();
  return resolve(isAbsolute(out) ? out : resolve(linkedWorktree, out), LOCK_FILE);
}

/**
 * `{ pid, key, startedAt, heartbeatAt }` for the current holder, or null when there is no lock.
 *
 * A crash between the `wx` open and the write leaves an EMPTY file, so no field may be trusted to exist:
 * an unreadable pid reads as "still alive" (never steal on a guess) and an unreadable timestamp falls
 * back to the file's mtime, which is what keeps such a lock stealable by age instead of forever. mtime is
 * the honest fallback for `heartbeatAt` in particular: a heartbeat IS a rewrite of this file, so the last
 * write time is the last heartbeat whether or not the field survived.
 */
function readLock(path) {
  let raw = null;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw fail(`cannot read the land lock at ${path}: ${err.message}`);
  }

  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }

  let mtime = null;
  const writtenAt = () => {
    if (mtime === null) {
      try { mtime = statSync(path).mtimeMs; } catch { mtime = Date.now(); }
    }
    return mtime;
  };
  return {
    pid: Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
    key: typeof parsed.key === 'string' ? parsed.key : '',
    startedAt: Number.isFinite(parsed.startedAt) ? parsed.startedAt : writtenAt(),
    heartbeatAt: Number.isFinite(parsed.heartbeatAt) ? parsed.heartbeatAt : writtenAt(),
  };
}

/**
 * Is this the same holder? IDENTITY only — `heartbeatAt` is deliberately excluded, because it changes
 * every time the holder heartbeats and the whole point of the comparison is to survive that. Both the
 * takeover guard and the release match on exactly this.
 */
const sameOwner = (a, b) => a !== null && b !== null
  && a.pid === b.pid && a.startedAt === b.startedAt && a.key === b.key;

/** Signal 0 asks the question without sending anything. EPERM = alive but not ours; unknown = alive. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const describeHolder = (owner) => `pid ${owner?.pid ?? '?'} landing "${owner?.key || '?'}"`;

/** Blocking sleep — everything in this tool is synchronous, and a poll loop must not busy-spin. */
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Remove a lock this process decided was stale — but ONLY if it is still the same lock. Between the
 * staleness decision and this call the holder can have released it and a third land taken it: `rmSync`
 * on that would delete a LIVE holder's lock and hand a fourth land a free run into the same integration
 * branch, which is the exact overlap the lock exists to prevent. So the decision is re-read and
 * field-matched (pid, startedAt, key — never heartbeatAt, which the live holder is busy changing)
 * immediately before the unlink.
 *
 * Three outcomes, and the caller says a different thing about each: 'removed' (this call took it),
 * 'gone' (the holder released it first — nothing was taken over, so nothing is announced) and 'changed'
 * (a different holder now, so the wait resumes).
 */
export function takeoverLock(path, decided) {
  const current = readLock(path);
  if (current === null) return 'gone';                           // released on its own — nothing to steal
  if (!sameOwner(current, decided)) return 'changed';            // NOT the lock the decision was about
  rmSync(path, { force: true });
  return 'removed';
}

/**
 * Refresh `heartbeatAt` at a land step boundary, so a holder that is progressing never looks wedged.
 *
 * Guarded by the same field match as the takeover and the release: if the lock is no longer ours,
 * rewriting it would resurrect our identity over the live holder's — and that holder's own release would
 * then refuse to unlink a lock it no longer recognises, wedging landing for the whole repo. Losing the
 * lock is not made worse by saying nothing about it here; the step in flight is finished either way and
 * `releaseLock` reports it on the way out.
 */
export function heartbeat(path, token) {
  if (!sameOwner(readLock(path), token)) return;
  token.heartbeatAt = Date.now();
  writeFileSync(path, `${JSON.stringify(token)}\n`);
}

/**
 * Take the repo-global land lock, or exit 75 telling the orchestrator to retry. Returns the token that
 * `heartbeat` refreshes and `releaseLock` matches against, so a lock TAKEN OVER mid-land is not deleted
 * by the process it was taken from — that would hand a third land a free run while the second is still
 * merging.
 *
 * Staleness is `now − heartbeatAt`, never `now − startedAt`: see the LIVENESS note at the top of the
 * file. `startedAt` is identity and message material only.
 */
function acquireLock(path, key, waitMs, staleMs) {
  const deadline = Date.now() + waitMs;
  let takeovers = 0;

  for (;;) {
    const now = Date.now();
    const token = { pid: process.pid, key, startedAt: now, heartbeatAt: now };
    try {
      const fd = openSync(path, 'wx');
      try { writeSync(fd, `${JSON.stringify(token)}\n`); } finally { closeSync(fd); }
      return token;
    } catch (err) {
      if (err.code !== 'EEXIST') throw fail(`cannot create the land lock at ${path}: ${err.message}`);
    }

    const owner = readLock(path);
    if (owner === null) {                                        // released between our open and our read
      if (Date.now() >= deadline) throw fail(`the land lock at ${path} kept changing hands and "${key}" never got it within --wait-ms ${waitMs} — retry later`, EXIT_RETRY);
      continue;
    }

    const dead = !pidAlive(owner.pid);
    const idle = Date.now() - owner.heartbeatAt;
    if (dead || idle > staleMs) {
      if (takeovers >= MAX_TAKEOVERS) {
        throw unsafe(`the land lock at ${path} was taken over ${MAX_TAKEOVERS} times and keeps coming back (${describeHolder(owner)}) — something is recreating it; sort that out before landing "${key}"`);
      }

      const outcome = takeoverLock(path, owner);
      if (outcome === 'removed') {
        takeovers++;
        const age = Date.now() - owner.startedAt;
        process.stderr.write(`TAKING OVER the land lock at ${path} — ${describeHolder(owner)} ${dead ? 'is GONE' : `has not heartbeat for ${Math.round(idle / 1000)}s (started ${Math.round(age / 1000)}s ago), past --stale-ms ${staleMs}`}\n`);
      } else if (outcome === 'changed') {
        process.stderr.write(`the land lock at ${path} looked ${dead ? 'abandoned' : 'wedged'} (${describeHolder(owner)}) but CHANGED HANDS before it could be removed — left it alone, waiting again\n`);
      }

      if (Date.now() >= deadline) {
        throw fail(`the land lock at ${path} kept changing hands and "${key}" never got it within --wait-ms ${waitMs} — retry later`, EXIT_RETRY);
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw fail(`the land lock at ${path} is held by ${describeHolder(owner)} and did not clear within --wait-ms ${waitMs} — retry "${key}" later`, EXIT_RETRY);
    }
    sleepSync(Math.min(LOCK_POLL_MS, Math.max(deadline - Date.now(), 1)));
  }
}

/**
 * The last check before the ONE step that writes to the SHARED integration worktree.
 *
 * `heartbeatAt` is refreshed at step BOUNDARIES, so the gate — a whole build or test suite, and the step
 * this file itself calls the long one — is the stretch that can legitimately outrun `--stale-ms` and be
 * taken over while it is still running. `heartbeat` observes that loss and deliberately says nothing (the
 * step in flight finishes either way), which left the integration merge as the only unguarded write: a
 * land that had ALREADY lost the lock merged into integration anyway and reported exit 0, with the
 * takeover mentioned only in passing by `releaseLock` on the way out. Nothing else this land does touches
 * shared state — the accept commit and the sync merge are on the chain's own branch — so this one re-read,
 * the same field match `takeoverLock` applies before its own unlink, is what makes the serialization real.
 *
 * EXIT_RETRY rather than a new code: nothing has been merged, the chain keeps its synced and gated work,
 * and "run this land again later" is exactly what 75 already means to an orchestrator.
 */
function requireLockHeld(path, token, batch, key) {
  const owner = readLock(path);
  if (sameOwner(owner, token)) return;

  const now = owner === null ? 'it was REMOVED' : `it now belongs to ${describeHolder(owner)}`;
  throw fail(`the land lock at ${path} is NO LONGER held by "${key}" (${now}) — refusing to merge into ${intBranch(batch)} unserialized. Nothing was merged and ${chainBranch(batch, key)} keeps its synced, gated work: land "${key}" again later`, EXIT_RETRY);
}

function releaseLock(path, token) {
  const owner = readLock(path);
  if (owner === null) return;
  if (!sameOwner(owner, token)) {
    process.stderr.write(`the land lock at ${path} was TAKEN OVER by ${describeHolder(owner)} while this land ran — leaving it in place\n`);
    return;
  }
  rmSync(path, { force: true });
}

/**
 * `clean --batch` is the teardown that can also clear a lock a crashed land left behind — it is the only
 * other verb that knows this path. A lock whose owner is still running is left ALONE: the fix for a live
 * land is to wait for it, never to pull the lock out from under it.
 */
function removeDeadLock(linkedWorktree) {
  const path = lockPath(linkedWorktree);
  const owner = readLock(path);
  if (owner === null) return;

  if (pidAlive(owner.pid)) {
    process.stderr.write(`left the land lock at ${path} in place — ${describeHolder(owner)} is still running\n`);
    return;
  }
  rmSync(path, { force: true });
  process.stderr.write(`removed a STALE land lock at ${path} — ${describeHolder(owner)} is GONE\n`);
}

// =============================================================================
// clean — the two teardown forms; both leave the branch for the user
// =============================================================================

/**
 * NO `--force`, deliberately. `--force` is the flag that overrides git's own refusal to delete a
 * worktree holding modified, staged or untracked files — and an engine run's RESTING state is exactly
 * that: accepted work staged, never committed (tests/CLAUDE.md §4). A `clean` run one step ahead of the
 * land would have discarded it silently, at exit 0, with no patch and no prompt. Git's refusal is the
 * guard; the operator clears the precondition (land it, commit it, or discard it deliberately with the
 * command named below). The `--force` recovery of a CRASHED run (decision-r3 M7/M8) is still exactly
 * that command — it just has to be typed by the person who accepts the loss.
 */
function removeWorktree(repo, path) {
  const r = git(repo, ['worktree', 'remove', path]);
  if (r.code !== 0) {
    throw unsafe(`cannot remove the worktree at ${path}: ${firstLine(r.stderr)} — land or commit the work there, or throw it away on purpose with "git -C ${repo} worktree remove --force ${path}"`);
  }
  git(repo, ['worktree', 'prune']);
}

function cleanChain(repo, key) {
  const entry = findChain(listWorktrees(repo), key);
  if (!entry) {
    // Idempotent on purpose: teardown runs after every chain, including ones that never got a worktree.
    process.stderr.write(`no worktree on aipg/<batch>/${key} — nothing to remove\n`);
    git(repo, ['worktree', 'prune']);
    return;
  }
  removeWorktree(repo, entry.path);
  process.stderr.write(`removed ${entry.path}; branch ${entry.branch} kept\n`);
  process.stdout.write(`${entry.path}\n`);
}

function cleanBatch(repo, batch) {
  const entries = listWorktrees(repo);
  const entry = findBranch(entries, intBranch(batch));
  if (!entry) {
    // The hook path is only resolvable from a linked worktree (M27) and this tool never guesses at a
    // path it would DELETE — so with the integration worktree already gone, the hook stays.
    process.stderr.write(`no worktree on ${intBranch(batch)} — nothing to remove, and the hook was left alone (its path resolves only from a linked worktree)\n`);
    git(repo, ['worktree', 'prune']);
    return;
  }

  // The hook is ONE file shared by every worktree of the repo, so tearing the batch down while a chain of
  // it is still checked out un-protects that chain SILENTLY — measured: after the hook went, `git stash
  // push -u` in the surviving worktree was accepted and its work landed on the shared refs/stash stack,
  // which is the M25 hazard the hook exists to prevent. Chains go first; this is the ordering precondition.
  const stranded = batchChains(entries, batch);
  if (stranded.length) {
    throw unsafe(`batch "${batch}" still has ${stranded.length} chain worktree(s) registered (${stranded.map((e) => e.branch).join(', ')}) — run "clean --key <chain>" on each first; removing the shared reference-transaction hook now would leave them open to the refs/stash hazard it exists to prevent`);
  }

  const hook = hookPath(entry.path);
  const state = hookState(hook);                                 // read BEFORE the worktree goes away
  removeDeadLock(entry.path);                                    // same reason: the path needs a linked worktree
  removeWorktree(repo, entry.path);

  if (state === 'ours') {
    rmSync(hook, { force: true });
    process.stderr.write(`removed the AIPG reference-transaction hook at ${hook}\n`);
  } else if (state === 'foreign') {
    process.stderr.write(`left a FOREIGN reference-transaction hook in place at ${hook}\n`);
  }
  process.stderr.write(`removed ${entry.path}; branch ${intBranch(batch)} kept — merge it where you want it\n`);
  process.stdout.write(`${entry.path}\n`);
}

function clean(opt) {
  const repo = requireRepo(opt);
  const hasKey = opt.key !== undefined;
  const hasBatch = opt.batch !== undefined;
  if (hasKey === hasBatch) {
    throw fail(`clean takes exactly one of --key <chain> or --batch <name> (${hasKey ? 'both were given' : 'neither was given'})`);
  }
  if (hasKey) cleanChain(repo, requireName(opt, 'key'));
  else cleanBatch(repo, requireName(opt, 'batch'));
}

// =============================================================================
// land — the serialized half: lock, commit, scope report, sync, gate, merge
// =============================================================================

/**
 * Is every commit of the chain branch already contained in integration? That — not the state of the
 * working tree — is what "this chain has nothing to land" actually means.
 *
 * `--is-ancestor` answers 0 for yes and 1 for no; anything else is a git error, and reading an error as
 * "yes, already landed" is the one direction that loses work, so it throws instead.
 */
function isLanded(worktree, batch, key) {
  const chain = chainBranch(batch, key);
  const int = intBranch(batch);
  const r = git(worktree, ['merge-base', '--is-ancestor', chain, int]);
  if (r.code !== EXIT_OK && r.code !== 1) {
    throw unsafe(`cannot tell whether ${chain} is already contained in ${int}: ${firstLine(r.stderr) || `git merge-base exited ${r.code}`}`);
  }
  return r.code === EXIT_OK;
}

/**
 * Step 2. Commit the ACCEPTED index — index-only, never `-a`: work an engine left unstaged was not
 * accepted and must stay behind. When the commit fails, the split below is what separates "this chain
 * finished with nothing to land" from "this chain's accepted work is about to be thrown away", and they
 * must never share an exit code: the orchestrator moves on from 10, and a later `clean --key` on a tree
 * it believes empty is `remove --force` on the only copy of that work.
 *
 * A clean tree over an empty index is NOT nothing-to-land on its own. It is also what the recovery this
 * tool prescribes leaves behind: `syncFromIntegration`'s exit 20 says "resolve it on <chain> and land
 * again", git's own conflict output says "fix conflicts and then commit the result", and once that commit
 * exists the tree is clean and the index empty while the BRANCH carries a merge integration has never
 * seen. Hence the branch-level question, which is the one exit 10 is really about.
 */
function commitAccepted(worktree, batch, key) {
  const commit = git(worktree, ['commit', '-m', `${key}: accepted`]);
  if (commit.code === 0) return;

  const indexClean = git(worktree, ['diff', '--cached', '--quiet']).code === 0;
  if (!indexClean) {
    throw unsafe(`cannot commit the accepted index of "${key}" in ${worktree}: ${firstLine(commit.stderr) || firstLine(commit.stdout) || `git commit exited ${commit.code}`}`);
  }

  const lines = porcelainLines(worktree);
  if (!lines.length) {
    if (!isLanded(worktree, batch, key)) {
      process.stderr.write(`no accept commit for "${key}": ${worktree} is clean, but ${chainBranch(batch, key)} carries commits ${intBranch(batch)} does not have — landing those\n`);
      return;
    }
    throw fail(`nothing to land for "${key}" — its index is empty, ${worktree} is clean and ${chainBranch(batch, key)} is already contained in ${intBranch(batch)}, so that run accepted no work`, EXIT_NOTHING);
  }

  // An intent-to-add entry reads as an EMPTY index (`git diff --cached --quiet` is happy) while carrying
  // a real, uncommitted file — commit it and the file lands as a zero-byte placeholder.
  const ita = lines.filter((l) => l.startsWith(' A'));
  if (ita.length) {
    throw unsafe(`"${key}" has ${ita.length} residual intent-to-add entr${ita.length === 1 ? 'y' : 'ies'} in ${worktree} (${fileList(ita)}) — "git add -N" reserved those names but staged no content, so landing now would commit them EMPTY; "git add" them for real (or "git reset" them) and land again`);
  }
  throw unsafe(`"${key}" has an EMPTY index but a DIRTY worktree in ${worktree} (${fileList(lines)}) — the likely cause is feature-cycle's passed-but-unstaged halt, where the work is good and one "git add" fixes it; refusing to report nothing-to-land, because that would let a later "clean --key" force-remove the only copy of it`);
}

/**
 * `*` and `**` only, deliberately: the globs are a plan's Files list, not a gitignore dialect, and a
 * matcher nobody can predict would make the warnings noise. `**` spans separators, `*` never does.
 */
function globToRegExp(glob) {
  const body = glob
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')                      // escape everything, `*` included
    .replace(/\\\*\\\*/g, '\u0000')                              // `**` → a placeholder no path can hold
    .replace(/\\\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

/**
 * Step 2.5 — LENIENT BY DESIGN. Overlap outside a chain's declared Files is usually deliberate (a shared
 * config, two endpoints in one controller) and merges cleanly, so this never changes the exit code: the
 * sync merge (20) and the gate (30) stay the only arbiters. It exists so an operator reading a failed
 * batch can see which chain wandered.
 */
function reportScope(worktree, batch, key, scopeFile) {
  if (scopeFile === null) return;

  let text = '';
  try {
    text = readFileSync(scopeFile, 'utf8');
  } catch (err) {
    throw unsafe(`cannot read --scope-file ${scopeFile}: ${err.message}`);
  }

  // git names files with forward slashes on every platform; a scope file written on Windows may not.
  const globs = text.split('\n').map((l) => l.trim().replace(/\\/g, '/')).filter(Boolean).map(globToRegExp);
  const touched = mustGit(worktree, ['diff', '--name-only', `${intBranch(batch)}...${chainBranch(batch, key)}`], 'listing the files this chain touched')
    .split('\n').map((l) => l.trim()).filter(Boolean);

  for (const file of touched) {
    if (!globs.some((re) => re.test(file))) {
      process.stderr.write(`AIPG scope: ${key} touched ${file} outside its declared scope\n`);
    }
  }
}

/**
 * Has a sync merge ALREADY been recorded on this chain? Only ever asked with `int` an ancestor of
 * `chain`, so `int..chain` is exactly what the chain carries on top of integration, and the only merge
 * commits this tool ever puts there are its own sync merges (its accept commit is index-only and
 * single-parent; engines commit nothing at all).
 *
 * A merge a human made on the branch counts too, and that is the SAFE direction: a false positive costs
 * one extra gate run, a false negative costs the invariant this whole tool exists for.
 */
function hasSyncMerge(worktree, int, chain) {
  const r = git(worktree, ['rev-list', '--min-parents=2', '--count', `${int}..${chain}`]);
  if (r.code !== 0) {
    throw unsafe(`cannot tell whether ${chain} has already been synced: ${firstLine(r.stderr) || `git rev-list exited ${r.code}`}`);
  }
  return Number(r.stdout.trim()) > 0;
}

/**
 * Step 3. Bring integration into the chain BEFORE gating, so the gate judges the combined state.
 * Returns whether the GATE must run (step 4) — false only for the M28 case: the FIRST lander of a batch
 * adds nothing to its own already-gated run, so re-running the gate would only re-prove what that run
 * proved. Every other land is gated.
 *
 * "int is an ancestor of chain" is NOT that case on its own, and reading it that way punched a hole
 * straight through the invariant. EXIT_RED deliberately KEEPS the sync merge on the branch, so from then
 * on `int` is an ancestor of `chain` forever: the fix run's commit lands on top of that merge, the
 * ancestor test reads true again, the gate is skipped and the combined state — fixed or not — merges into
 * integration at exit 0. The recovery path documented for a red gate was precisely the path that escaped
 * it. Hence the second half: a chain that already carries a sync merge is re-gated, always.
 *
 * Two failures that look alike and are not: git REFUSES a merge up front when unstaged changes would be
 * overwritten (exit 128, no MERGE_HEAD, porcelain ` M`) — nothing started, nothing to abort, and the
 * operator clears it in one command. A real conflict leaves MERGE_HEAD and `UU` entries and must be
 * aborted. Calling `merge --abort` on the first shape fails 128 itself, which is why the abort is gated.
 */
function syncFromIntegration(worktree, batch, key) {
  const int = intBranch(batch);
  const chain = chainBranch(batch, key);

  if (git(worktree, ['merge-base', '--is-ancestor', int, chain]).code === 0) {
    if (!hasSyncMerge(worktree, int, chain)) {
      process.stderr.write(`sync skipped: ${int} is already an ancestor of ${chain} and this chain has never synced — nothing new to gate\n`);
      return false;
    }
    process.stderr.write(`sync not needed: ${int} is already in ${chain}, but ${chain} has moved since its sync merge — RE-GATING the combined state\n`);
    return true;
  }

  const merged = git(worktree, ['merge', '--no-ff', '-m', `sync ${int}`, int]);
  if (merged.code === 0) {
    process.stderr.write(`synced ${int} into ${chain}\n`);
    return true;
  }

  if (git(worktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0) {
    const dirty = porcelainLines(worktree);
    throw unsafe(`sync of ${int} into "${key}" was REFUSED before it started — unstaged changes in ${worktree} would be overwritten (${fileList(dirty)}); commit or discard them and land again. git said: ${firstLine(merged.stderr)}`);
  }

  const conflicts = porcelainLines(worktree).filter((l) => /^(UU|AA|DD|.U|U.)/.test(l));
  const aborted = git(worktree, ['merge', '--abort']);
  throw fail(`sync of ${int} into "${key}" CONFLICTED (${fileList(conflicts) || firstLine(merged.stdout)}) — the merge was aborted, ${chain} keeps its work and ${int} is untouched; resolve it on ${chain} and land again${aborted.code === 0 ? '' : `. WARNING: "git merge --abort" FAILED (${firstLine(aborted.stderr)}) — ${worktree} is mid-merge`}`, EXIT_CONFLICT);
}

/**
 * Step 4. Only ever on a SYNCED state — the only state that predicts what integration will look like.
 *
 * A gate is a whole build or test suite by definition, and Node's default 1 MiB child-output cap is
 * something a real one clears without trying — at which point the child is KILLED and reports no exit
 * code (see `run`). Room, so that a gate which PASSES loudly is not read as a red one.
 */
const GATE_MAX_BUFFER = 1024 * 1024 * 1024;

function runGate(command, worktree, batch, key) {
  const r = run(command, [], worktree, { shell: true, maxBuffer: GATE_MAX_BUFFER });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.code === 0) return;

  throw fail(`the gate exited ${r.code} on the SYNCED state of "${key}" — ${intBranch(batch)} is untouched and still green. The sync merge is KEPT on ${chainBranch(batch, key)} so a fix run sees the exact combined state that failed: ${command}`, EXIT_RED);
}

/** Step 5. Fast-forwardable by construction — the chain already contains integration's tip. */
function mergeIntoIntegration(intWorktree, batch, key) {
  const int = intBranch(batch);
  const chain = chainBranch(batch, key);

  const dirty = porcelainLines(intWorktree);
  if (dirty.length) {
    throw unsafe(`the integration worktree ${intWorktree} is NOT clean (${fileList(dirty)}) — refusing to land "${key}" on top of work nobody has accounted for; clear it and land again`);
  }

  const merged = git(intWorktree, ['merge', '--no-ff', '-m', `land ${key}`, chain]);
  if (merged.code === 0) return;

  // Same shape as the sync abort: the abort is MERGE_HEAD-gated (aborting a merge that never started
  // fails 128 itself), and its RESULT is read — this message is the only account an operator gets of the
  // double fault, so it must not assert an outcome it did not check.
  const aborted = git(intWorktree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code === 0
    ? git(intWorktree, ['merge', '--abort'])
    : { code: EXIT_OK, stdout: '', stderr: '' };
  throw fail(`landing "${key}" into ${int} FAILED even though the gate was green (${firstLine(merged.stderr)}) — the merge was aborted and ${int} is untouched. ${chain} contains ${int}'s tip by construction, so something moved ${int} while this land held the lock${aborted.code === 0 ? '' : `. WARNING: "git merge --abort" FAILED (${firstLine(aborted.stderr)}) — ${intWorktree} is mid-merge`}`, EXIT_CONFLICT);
}

function land(opt) {
  // Input
  const repo = requireRepo(opt);
  const batch = requireName(opt, 'batch');
  const key = requireName(opt, 'key');
  const gate = requireCommand(opt, 'gate');
  const scopeFile = opt['scope-file'] === undefined ? null : requireAbsolute(opt, 'scope-file');
  const waitMs = requireMs(opt, 'wait-ms', DEFAULT_WAIT_MS);
  const staleMs = requireMs(opt, 'stale-ms', DEFAULT_STALE_MS);

  const entries = listWorktrees(repo);
  const integration = findBranch(entries, intBranch(batch));
  if (!integration) {
    throw unsafe(`no worktree on ${intBranch(batch)} — nothing to land into; run "wt.mjs init --repo ${repo} --batch ${batch}" first`);
  }
  const chain = findBranch(entries, chainBranch(batch, key));
  if (!chain) {
    throw unsafe(`no worktree on ${chainBranch(batch, key)} — run "wt.mjs prep --repo ${repo} --batch ${batch} --key ${key}" first, and land only after that chain's run has EXITED`);
  }

  // Process — one lock across all of it, heartbeat at every step boundary so a land that is PROGRESSING
  // is never mistaken for a wedged one, released on every path out (including a throw).
  const lock = lockPath(integration.path);
  const token = acquireLock(lock, key, waitMs, staleMs);
  try {
    commitAccepted(chain.path, batch, key);
    heartbeat(lock, token);                                      // after COMMIT
    reportScope(chain.path, batch, key, scopeFile);

    const mustGate = syncFromIntegration(chain.path, batch, key);
    heartbeat(lock, token);                                      // after SYNC
    if (mustGate) {
      runGate(gate, chain.path, batch, key);
      heartbeat(lock, token);                                    // after GATE — the long one
    }
    requireLockHeld(lock, token, batch, key);                    // ...and STILL ours, or nothing merges
    mergeIntoIntegration(integration.path, batch, key);
  } finally {
    releaseLock(lock, token);
  }

  // Output
  process.stderr.write(`landed ${chainBranch(batch, key)} into ${intBranch(batch)}\n`);
  process.stdout.write(`${integration.path}\n`);
}

// =============================================================================
// CLI
// =============================================================================

const VERBS = {
  init: { fn: init, flags: ['repo', 'batch', 'base', 'dir'] },
  prep: { fn: prep, flags: ['repo', 'batch', 'key', 'provision'] },
  land: { fn: land, flags: ['repo', 'batch', 'key', 'gate', 'scope-file', 'wait-ms', 'stale-ms'] },
  clean: { fn: clean, flags: ['repo', 'batch', 'key'] },
};

const USAGE = `usage:
  node tools/wt.mjs init  --repo <abs> --batch <name> [--base <branch>] [--dir <abs>]
  node tools/wt.mjs prep  --repo <abs> --batch <name> --key <chain> [--provision "<cmd>"]
  node tools/wt.mjs land  --repo <abs> --batch <name> --key <chain> --gate "<cmd>" [--scope-file <abs>] [--wait-ms <n>] [--stale-ms <n>]
  node tools/wt.mjs clean --repo <abs> --key <chain>
  node tools/wt.mjs clean --repo <abs> --batch <name>`;

// A name becomes a ref segment AND a directory name, so a slash or a space would silently reshape both.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function requireValue(opt, name) {
  const value = opt[name];
  if (value === undefined) throw fail(`--${name} is required`);
  return value;
}

function requireName(opt, name) {
  const value = requireValue(opt, name);
  if (!NAME_RE.test(value)) {
    throw fail(`--${name} "${value}" is not a plain name — it becomes a branch segment and a directory name, so it must start with a letter or digit and hold only letters, digits, dot, underscore or hyphen`);
  }
  return value;
}

function requireAbsolute(opt, name) {
  const value = requireValue(opt, name);
  if (!isAbsolute(value)) throw fail(`--${name} "${value}" must be an ABSOLUTE path`);
  return resolve(value);
}

function requireCommand(opt, name) {
  const value = requireValue(opt, name);
  if (!value.trim()) throw fail(`--${name} needs a command (it was empty)`);
  return value;
}

/**
 * Milliseconds, or the stated default. NOTHING is coerced: `Number("")` and `Number(" ")` are both 0 —
 * a legal-looking bound that would turn the lock wait off entirely — and `Number("10s")` is NaN, which
 * every comparison here answers false to, so a typo would silently make a land wait forever.
 */
function requireMs(opt, name, dflt) {
  const raw = opt[name];
  if (raw === undefined) return dflt;
  if (!/^\d+$/.test(raw)) throw fail(`--${name} "${raw}" must be a whole number of MILLISECONDS (digits only)`);
  return Number(raw);
}

function requireRepo(opt) {
  const repo = requireAbsolute(opt, 'repo');
  const r = git(repo, ['rev-parse', '--git-dir']);
  if (r.code !== 0) throw fail(`--repo ${repo} is not a git repository: ${firstLine(r.stderr)}`);
  return repo;
}

/**
 * `<verb> [--flag value]…`, validated. NOTHING is coerced: a bare `--batch` is an error, never the
 * string "true" quietly naming a branch (the defect gen-units.mjs's numeric flags were fixed for), and a
 * flag belonging to another verb is an error rather than a silently ignored argument.
 */
export function parseArgv(argv) {
  const [verb, ...rest] = argv;
  if (!verb || !VERBS[verb]) throw fail(`${verb ? `unknown verb "${verb}"` : 'no verb given'} — ${USAGE}`);

  const allowed = VERBS[verb].flags;
  const opt = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw fail(`unexpected argument "${token}" — every value follows its own flag. ${USAGE}`);

    const name = token.slice(2);
    if (!allowed.includes(name)) throw fail(`unknown flag "--${name}" for ${verb} — it takes ${allowed.map((f) => `--${f}`).join(' ')}`);
    if (opt[name] !== undefined) throw fail(`--${name} was given twice`);

    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw fail(`--${name} needs a value`);
    opt[name] = value;
    i++;
  }
  return { verb, opt };
}

export function main(argv) {
  const { verb, opt } = parseArgv(argv);
  VERBS[verb].fn(opt);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`wt: ${err.message}\n`);
    process.exitCode = err.exitCode ?? EXIT_ERROR;
  }
}
