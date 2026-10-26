// tools/wt.mjs: the worktree lifecycle for running several AIPG chains in parallel as a batch, or for
// building one change in its own worktree.
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
//   open  --repo <abs> --name <n> [--base <branch>] [--dir <abs>] [--provision "<cmd>"]   one change, no batch
//   close --repo <abs> --name <n> [--into <branch>] --gate "<cmd>" [--stage]   merge or stage that change, then remove it
//   close --repo <abs> --name <n> --discard                               trash that change unmerged
//
// With no --dir, `init` and `open` put each worktree in `.claude/worktrees/` of the main worktree, or beside a bare repository, and first add that
// folder to the repo's `info/exclude`, so `git status` in the checkout lists none. `--dir` names another parent folder instead.
//
// "after it has landed" is a precondition `clean` enforces. `clean` moves the worktree folder to the
// operating system's trash through tools/trash.mjs and then runs `git worktree prune`. It never runs
// `git worktree remove`, which deletes the folder and every ignored file in it. It refuses with exit 40
// and changes nothing when the worktree is the repo's main worktree, is locked, has a folder at its path
// whose `.git` file does not point at its git directory, holds modified, staged or untracked files, has
// a merge, cherry-pick, revert, rebase, am or bisect in progress, has submodule git directories in its
// git directory, or holds the working directory of the process that runs it or the `--repo` path (see
// `checkRemovable`). A rebase or bisect detaches HEAD, so `clean` finds that worktree by the branch the
// operation records, as git does (see `worktreesForClean`).
// `clean --batch`, which also removes the shared hook, is refused while any chain worktree of that batch
// is still registered (see `cleanBatch`).
//
// `open` and `close` build one change in its own worktree on `aipg/<n>`. They install no hook and take no
// lock, since both guard the sibling chains of a batch and a single change has none. So `close` refuses an
// `--into` that is a batch's integration or chain branch, which only `land` moves. `open` records the branch it
// cut from in the branch's config, and `close` takes that branch when `--into` is omitted. `close --into` rebases
// `aipg/<n>` onto `<into>` when `<into>` has a commit it lacks, gates the exact commit `<into>` will point at,
// moves `<into>` to it only by fast-forward, and verifies the move. With `--stage` it first commits the worktree's
// staged work as one carrier commit, and after the gate it stages the change in the worktree that has `<into>`
// checked out instead of moving `<into>`. That worktree may hold other uncommitted work, and only a change at a
// path the landing writes is refused. Only then does it remove the worktree the way `clean` does and delete
// `aipg/<n>`. A refusal before the rebase changes nothing. Each later stop keeps the steps already done, such as
// a rebased `aipg/<n>`, a moved `<into>` or a worktree in the trash. Running close again finishes the steps left
// (see `closeInto`). `close --discard` trashes the worktree with its uncommitted work and keeps the branch.
//
// Every M-number in this file is a measurement label of the decide run `worktree-parallelism-1`
// (2026-07-29).
//
// The one thing worktrees do NOT isolate is `refs/stash`. It is a single stack shared by every worktree
// of a repo, so a `stash push` in one chain and a `stash pop` in another injects a sibling's work into
// that chain's tree AND into its accepted index (measured: M25). `init` therefore installs a
// `reference-transaction` hook that refuses `refs/stash` updates from inside an `aipg-*` worktree, and
// `prep` PROVES the hook is live in each fresh worktree before any agent runs there (M30). The hook's
// bytes below are load-bearing and measured — the obvious three-line version exits 1 on every ref
// transaction and bricks every commit and merge in a linked worktree (M19/M20), and the `aipg-*` scoping
// is what leaves the user's own `git stash` working everywhere else (M31). Do not "improve" it.
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
// `land` and `close` are the only verbs that WRITE commits, all on `aipg/*` branches and all by this deterministic
// script. `land` writes an index-only accept commit of the chain's accepted work, a sync merge, and the landing
// merge. `close --stage` writes one carrier commit of the staged work on `aipg/<n>`. `close`'s rebase rewrites the
// `aipg/<n>` commits onto `<into>` and adds no change of its own, and `<into>` moves only by fast-forward, or not at all
// with `--stage`. So every change that reaches the user's own branches is one the user committed, an accepted block that
// the commit delivery the user chose committed, or a landing fix the operator made and named (WORKFLOW-PRINCIPLES.md #9).
//
// stdout carries ONE value: the worktree path the verb acted on (prep's and open's is the `target.repo` an
// engine run is handed; land's is the integration worktree; close's is the worktree it removed). Everything a
// human reads goes to stderr, so `target=$(node wt.mjs prep …)` is safe.
//
// Exit codes are the contract an orchestrator branches on:
//   0   success
//   10  nothing to land — the chain accepted no work AND its branch is already contained in the
//       integration branch. NOT an error; the orchestrator moves on.
//   20  conflict — the sync merge conflicted and was aborted. The branch keeps its work, integration is
//       untouched. A human or a fix run resolves it on the branch. For close: its rebase conflicted and was
//       aborted with `aipg/<n>` back at its old tip, or `<into>` moved before the fast-forward. `<into>` is
//       untouched either way.
//   30  integration-red — the gate failed on the SYNCED state. The sync merge is kept on the branch (it
//       records the exact combined state a fix run must address); integration is untouched and green. For
//       close: the gate failed on the commit `<into>` would point at, and `<into>` is untouched.
//   40  unsafe / precondition — foreign hook, a relative core.hooksPath, no init, another batch active,
//       hook self-test failed or never exercised, provision red, a worktree being cleaned that is the
//       main worktree, is locked, has another folder at its path or holds unlanded work, an unfinished
//       operation, submodule git directories, the caller's working directory or the --repo path, a trash
//       move that was refused or could not be confirmed, a worktree still registered after the prune, a
//       batch cleaned while its chains are still registered, an empty index over a dirty tree, unaccepted
//       work left beside a committed accept, a sync git refused up front, a command killed for flooding
//       its output buffer, an init, prep or open whose worktree git created and then exited nonzero, such
//       as on a failed post-checkout hook, an open or close given a branch name that matches a branch only
//       in another case, an open whose base is no local branch or whose branch exists, a close whose --into
//       is no local branch, a batch's branch or a symbolic ref, whose worktree is off its branch or gone with
//       commits to merge, whose rebase would drop a merge commit of the branch, whose rebase or
//       fast-forward would delete ignored files, whose rebase git refused, left unfinished, stopped with no
//       conflicted file or left uncommitted changes, whose gate changed the tree it judged, whose `<into>`
//       is checked out in two worktrees, under another name or in a folder that is gone or holds another
//       repository, whose `<into>` worktree has uncommitted changes or untracked files in the way of the
//       fast-forward or the staged work, an ignored file in the way of the staged work, or an unfinished
//       operation, whose merge or staged work did not verify, whose `--stage` has no worktree on `<into>` or
//       staged work beside unaccepted work, whose omitted `--into` has no recorded base, or whose branch
//       moved before its delete, a worktree being cleaned or closed whose folder holds another registered
//       worktree, or an open or init whose info/exclude cannot be read or appended to.
//       Always with a one-line reason naming what to do.
//   75  retry-later — another land holds the lock, or this land LOST it (taken over mid-gate) before it
//       could merge, so it merged nothing. The ONLY code an orchestrator should retry.
//   1   unexpected — bad argv, bad --repo, git missing.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { devNull } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TrashError, foldsCase, isWithin, realpathLoose, trash } from './trash.mjs';

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
// The path that the recovery commands a refusal names run this tool from.
const WT_SCRIPT = fileURLToPath(import.meta.url);

// win32 gets double quotes, the form cmd.exe, PowerShell and Git Bash all run, with a trailing backslash doubled so it cannot escape the closing quote.
// Other platforms get sh single quotes. A `$` or a backtick in a win32 path still expands in PowerShell and Git Bash, and Git Bash reads the leading `\\` of a UNC path as one backslash.
export const shellQuoteFor = (platform, value) => {
  const text = String(value);
  return platform === 'win32' ? `"${text.replace(/\\+$/, '$&$&')}"` : `'${text.replace(/'/g, `'\\''`)}'`;
};
export const shellQuote = (value) => shellQuoteFor(process.platform, value);

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
const singleBranch = (name) => `aipg/${name}`;
const intDir = (batch) => `aipg-int-${batch}`;
const chainDir = (key) => `aipg-${key}`;
const WORKTREE_PARENT = join('.claude', 'worktrees');
const WORKTREE_EXCLUDE_LINE = '/.claude/worktrees/';

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

const MIB = 1024 * 1024;

// What execFileSync caps a child's combined stdout+stderr at when no `maxBuffer` is passed. Named only
// so the overflow message can state the limit it actually hit.
const NODE_DEFAULT_MAX_BUFFER = MIB;

/** The two codes a child killed for overflowing that cap comes back with (ENOBUFS on Windows). */
const isOverflow = (err) => err.code === 'ENOBUFS' || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

// A gate or a provision is a whole build, install or test suite, and a real one can write more than Node's default
// cap. A child killed at the cap reports no exit code (see `run`), so the room keeps one that PASSES loudly from
// reading as red.
const GATE_MAX_BUFFER = 1024 * MIB;

/**
 * Run a command and hand back its exit code as a VALUE. A nonzero exit is the normal answer to half the
 * questions here ("does this ref exist", "did the hook refuse"), so it must not throw.
 *
 * The one shape that must NOT come back as a value is an overflow. A child killed for writing past
 * `maxBuffer` never reports a status at all (`err.status` is null), and `null ?? EXIT_ERROR` would hand
 * the caller a FABRICATED exit 1 that no caller can tell apart from a real failure — measured: a --gate
 * that wrote 2 MiB and exited 0 was reported as integration-red. An exit code this function did not
 * observe is not a value it may return. The thrown error carries `overflow`, so a caller that reads the
 * output only to report it can go on without it.
 */
function run(cmd, args, cwd, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: 'pipe', ...opts });
    return { code: EXIT_OK, stdout: String(stdout ?? ''), stderr: '' };
  } catch (err) {
    if (err.code === 'ENOENT') throw fail(`cannot run "${cmd}" — it is not on PATH`);
    if (isOverflow(err)) {
      // `git` passes no cwd, since its -C argument names the repo.
      throw Object.assign(unsafe(`"${[cmd, ...args].join(' ')}" was KILLED${cwd ? ` in ${cwd}` : ''} for writing more than ${opts.maxBuffer ?? NODE_DEFAULT_MAX_BUFFER} bytes to stdout+stderr — it never reported an exit code, so this is NOT a report that it failed; make it quieter and run it again`), { overflow: true });
    }
    return { code: err.status ?? EXIT_ERROR, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') };
  }
}

/** Writes both streams of a `run` result to stderr, since stdout carries only the one path this tool prints. */
function relay(r) {
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
}

/** `git -C <cwd> …`. -C rather than a cwd option so the failure message always names the repo. */
const git = (cwd, args, opts) => run('git', ['-C', cwd, ...args], undefined, opts);

// For the git calls that run the repo's hooks, such as a checkout, rebase, merge or branch update. The hooks write
// to git's pipes, so they get the room a gate has.
const HOOK_ROOM = { maxBuffer: GATE_MAX_BUFFER };

// For close's git calls. One that waits on a prompt would hang close mid-step, such as mid-rebase, so its stdin is
// closed and git may not ask for credentials. A branch create and a worktree add keep the operator's environment,
// since a hook or checkout filter may need its language or a credential prompt.
const UNATTENDED = { ...HOOK_ROOM, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };

/**
 * git's first `error:` or `fatal:` line, past the progress git writes before it, such as the "Preparing worktree"
 * line of `git worktree add` or the `\r`-ended counter of a rebase.
 */
function gitError(r) {
  const found = String(r.stderr).split(/[\r\n]+/).map((l) => l.trim()).find((l) => /^(error|fatal):/.test(l));
  return found ?? (firstLine(r.stderr) || firstLine(r.stdout) || `git exited ${r.code}`);
}

/** For the git calls whose failure is a precondition the operator must clear, not a branch we take. */
function mustGit(cwd, args, what, opts) {
  const r = git(cwd, args, opts);
  if (r.code !== 0) throw unsafe(`${what} failed: ${gitError(r)}`);
  return r.stdout;
}

const HEADS = 'refs/heads/';
const headsRef = (branch) => `${HEADS}${branch}`;
/** The branch that `ref` names, or '' when `ref` is no local branch ref. */
const shortBranch = (ref) => (ref.startsWith(HEADS) ? ref.slice(HEADS.length) : '');

/**
 * Whether `branch` is a local branch. show-ref reads no revision syntax, so a value such as main~1 is no branch.
 * A loose ref is a file, so where the file system folds case it also answers yes for `branch` in another case.
 */
const isLocalBranch = (repo, branch) => git(repo, ['show-ref', '--verify', '--quiet', headsRef(branch)]).code === 0;

const commitOf = (cwd, rev) => mustGit(cwd, ['rev-parse', '--verify', `${rev}^{commit}`], `reading the commit of ${rev}`).trim();

/**
 * Whether `descendant` contains `ancestor`. `--is-ancestor` answers 0 for yes and 1 for no. Anything else is a
 * git error, and reading an error as "yes, already contained" is the one direction that loses work, so it throws.
 */
function contains(cwd, descendant, ancestor) {
  const r = git(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]);
  if (r.code !== EXIT_OK && r.code !== 1) {
    throw unsafe(`cannot tell whether ${descendant} contains ${ancestor}: ${gitError(r)}`);
  }
  return r.code === EXIT_OK;
}

const outputLines = (stdout) => stdout
  .split('\n')
  .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
  .filter(Boolean);

/**
 * `git status --porcelain` as `['XY path', …]` — the XY prefix is load-bearing (` A` = intent-to-add).
 * `--untracked-files=normal` because `status.showUntrackedFiles=no` would otherwise hide untracked work.
 */
const STATUS_ARGS = ['status', '--porcelain', '--untracked-files=normal'];
const porcelainLines = (worktree) => outputLines(git(worktree, STATUS_ARGS).stdout);

/** File names as a one-line list, since a message naming the files is what makes a 40 actionable. */
function nameList(files, cap = 8) {
  const head = files.slice(0, cap).join(', ');
  return files.length > cap ? `${head} (+${files.length - cap} more)` : head;
}

/** Porcelain status lines as a one-line file list. */
const fileList = (lines, cap) => nameList(lines.map((l) => l.slice(3).trim()).filter(Boolean), cap);

// =============================================================================
// Discovery — every path in this tool comes from here, never from stored state
// =============================================================================

// A concurrent `worktree add` holds a `locked` file while it initializes. `worktree list` can see it
// exist, lose it to the add's unlink, and die reading it (M26), so that one failure is retried. The pattern reads
// git's English message, and git skips its translations when GIT_TEXTDOMAINDIR names no directory.
const WORKTREE_LIST_RACE = /failed to read .*locked/;
const WORKTREE_LIST_ATTEMPTS = 5;
const WORKTREE_LIST_OPTS = { env: { ...process.env, GIT_TEXTDOMAINDIR: devNull } };

/**
 * `[{ path, branch, locked, lockReason, main, bare }]` for every worktree of the repo. `branch` is '' for an
 * entry on no local branch, such as a detached one, `lockReason` is '' for an entry locked with no reason,
 * `main` marks the first entry, which git always lists as the main worktree, and `bare` marks the entry of a
 * bare repository, which has no checkout.
 */
function listWorktrees(repo) {
  const listArgs = ['worktree', 'list', '--porcelain'];
  let listed = git(repo, listArgs, WORKTREE_LIST_OPTS);
  const entries = [];
  let current = null;

  for (let attempt = 1; attempt < WORKTREE_LIST_ATTEMPTS && listed.code !== 0 && WORKTREE_LIST_RACE.test(listed.stderr); attempt++) {
    listed = git(repo, listArgs, WORKTREE_LIST_OPTS);
  }
  if (listed.code !== 0) throw unsafe(`listing the worktrees failed: ${firstLine(listed.stderr) || `git exited ${listed.code}`}`);

  for (const line of outputLines(listed.stdout)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: '', locked: false, lockReason: '', main: entries.length === 0, bare: false };
      entries.push(current);
    } else if (line === 'bare' && current) {
      current.bare = true;
    } else if (line.startsWith('branch ') && current) {
      current.branch = shortBranch(line.slice('branch '.length).trim());
    } else if ((line === 'locked' || line.startsWith('locked ')) && current) {
      current.locked = true;
      current.lockReason = line.slice('locked'.length).trim();
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

/** The repo's git common dir, as an absolute path. git answers a relative one from the main worktree. */
function gitCommonDir(cwd) {
  const out = mustGit(cwd, ['rev-parse', '--git-common-dir'], 'resolving the git common dir').trim();
  return isAbsolute(out) ? out : resolve(cwd, out);
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

/**
 * `{ dir, underCheckout }`: the folder that holds the worktrees init or open creates, and whether it is the
 * default folder under the checkout. That is `--dir` if given, else `.claude/worktrees` under the main worktree, so a
 * default worktree never nests in a linked one that `close` could trash, and the `info/exclude` line matches it when
 * `--repo` names a subfolder. A bare repository has no checkout, so it keeps the folder beside it, whichever of its
 * worktrees `--repo` names.
 */
function worktreeParent(repo, opt) {
  // Input
  let main = null;

  // Process
  if (opt.dir !== undefined) return { dir: requireAbsolute(opt, 'dir'), underCheckout: false };
  main = listWorktrees(repo).find((e) => e.main);
  if (main.bare) return { dir: dirname(main.path), underCheckout: false };

  // Output
  return { dir: join(main.path, WORKTREE_PARENT), underCheckout: true };
}

/**
 * Adds `/.claude/worktrees/` to the repo's `info/exclude` before the first worktree is made under the default
 * folder, so `git status` in the user's checkout lists none. It edits no `.gitignore`, which the user's team shares.
 * `--dir` is the operator's choice and the guides direct it outside the checkout, so only the default folder gets a line.
 */
function ensureWorktreeExcluded(repo, parent) {
  // Input
  let file = '';
  let text = '';

  // Process
  if (!parent.underCheckout) return;
  file = join(gitCommonDir(repo), 'info', 'exclude');
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw unsafe(`cannot read ${file}, which must list ${WORKTREE_EXCLUDE_LINE} before a worktree is made under the checkout's ${WORKTREE_PARENT} folder: ${err.message}`);
  }
  if (text.split(/\r?\n/).some((line) => line.trim() === WORKTREE_EXCLUDE_LINE)) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${WORKTREE_EXCLUDE_LINE}\n`);
  } catch (err) {
    throw unsafe(`cannot add ${WORKTREE_EXCLUDE_LINE} to ${file}, so the worktrees under the checkout's ${WORKTREE_PARENT} folder would show in git status: ${err.message}`);
  }
}

const detachedBase = (repo) => unsafe(`--base was omitted and ${repo} is on a DETACHED HEAD — git has no machine-independent "default branch" in a local repo, so name the branch to cut from with --base`);

/** The branch to cut the integration branch from. No default branch is discoverable in a local repo. */
function resolveBase(repo, base) {
  if (base !== undefined) {
    if (git(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]).code !== 0) {
      throw unsafe(`--base "${base}" is not a commit in ${repo}`);
    }
    return base;
  }
  const head = git(repo, ['symbolic-ref', '--short', 'HEAD']);
  if (head.code !== 0) throw detachedBase(repo);
  return head.stdout.trim();
}

/**
 * Exit 40 for a `git worktree add` of `branch` that exited nonzero, once git's output is relayed. git runs the
 * post-checkout hook after it creates the worktree, so a failed hook leaves a worktree on `branch`, which the
 * message names with `recovery`. Null when no worktree is on `branch`. The caller knows that no worktree was on
 * `branch` before the add, so a worktree on it now is the one the add created.
 */
function createdThenFailed(repo, branch, added, what, recovery) {
  const holder = findBranch(listWorktrees(repo), branch);
  if (!holder) return null;
  relay(added);
  return unsafe(`${what}: git created the worktree on ${branch} at ${holder.path} and then exited ${added.code}, as it does when a post-checkout hook fails (git's output is above), so the worktree is left in place. ${recovery}`);
}

/**
 * Creates `branch` at `start`, then a worktree on it at `path`, or exits 40 naming `what` and, for a worktree git
 * created before it failed, `recovery`. The create fails for a branch that exists or that another process is
 * creating, so its exit code says whether this call owns the branch. No decision reads git's message, so both calls
 * keep the operator's environment for their hooks and checkout filters. A failed add deletes the branch this call
 * owns once no worktree holds it, so a later attempt does not fail on it.
 */
function addWorktreeOnNewBranch(repo, branch, path, start, { what, recovery }) {
  // Input
  let created = null;
  let added = null;
  let kept = null;
  let dropped = null;
  let note = '';

  // Process
  created = git(repo, ['branch', '--no-track', branch, start], HOOK_ROOM);
  if (created.code !== 0) throw unsafe(`${what}: ${gitError(created)}`);
  added = git(repo, ['worktree', 'add', path, branch], HOOK_ROOM);
  if (added.code === 0) return;
  kept = createdThenFailed(repo, branch, added, what, recovery);
  if (kept) throw kept;
  dropped = git(repo, ['branch', '-D', branch], HOOK_ROOM);
  note = dropped.code === 0
    ? `. The branch ${branch} that this call created was deleted`
    : `. The branch ${branch} that this call created is left behind (${gitError(dropped)}), so before trying again, delete it with git -C ${shellQuote(repo)} branch -D ${branch}`;

  // Output
  throw unsafe(`${what}: ${gitError(added)}${note}`);
}

function addIntegrationWorktree(repo, batch, base, path) {
  const branch = intBranch(batch);
  const what = `cannot create the integration worktree at ${path}`;
  const recovery = `Fix the cause, then run init again, which re-uses that worktree and installs the hook.`;
  // `clean --batch` removes the worktree and KEEPS the branch (the user decides where the finished
  // integration goes), so re-initialising the same batch must re-use the branch rather than fail on it.
  if (isLocalBranch(repo, branch)) {
    const added = git(repo, ['worktree', 'add', path, branch], HOOK_ROOM);
    if (added.code !== 0) throw createdThenFailed(repo, branch, added, what, recovery) ?? unsafe(`${what}: ${gitError(added)}`);
  } else {
    addWorktreeOnNewBranch(repo, branch, path, resolveBase(repo, base), { what, recovery });
  }

  // Re-read git's own spelling of the path, so later discovery matches what we print here.
  return findBranch(listWorktrees(repo), branch)?.path ?? path;
}

function init(opt) {
  // Input
  const repo = requireRepo(opt);
  const batch = requireName(opt, 'batch');
  const parent = worktreeParent(repo, opt);

  // Process
  // Git resolves a relative hooks path inside EACH worktree, so no single hook file could guard every chain.
  const hooksPath = git(repo, ['config', '--type=path', '--get', 'core.hooksPath']);
  const hooksDir = hooksPath.code === 0 ? hooksPath.stdout.trim() : '';
  if (hooksDir && !isAbsolute(hooksDir)) {
    throw unsafe(`core.hooksPath is RELATIVE ("${hooksDir}") in ${repo} — git resolves a relative hooks path inside each worktree, so one reference-transaction hook cannot guard every chain; point core.hooksPath at an absolute directory and re-run init`);
  }
  const active = integrationEntries(listWorktrees(repo));
  const mine = active.find((e) => e.branch === intBranch(batch)) ?? null;
  const other = active.find((e) => e.branch !== intBranch(batch)) ?? null;
  if (!mine && other) {
    throw unsafe(`batch "${other.branch.slice('aipg/int-'.length)}" is already active in ${other.path} — one batch at a time: land it and run "clean --batch" before starting "${batch}"`);
  }

  if (!mine) ensureWorktreeExcluded(repo, parent);
  const integration = mine ? mine.path : addIntegrationWorktree(repo, batch, opt.base, resolve(parent.dir, intDir(batch)));
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
// prep — a new branch and its worktree and nothing else, which is what makes N of them concurrent-safe (M26)
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
  // `--all` and the pathspec: `-u` skips an IGNORED probe, and git then exits 0 with no stash made, so a
  // pop keyed on the exit code alone would pop the operator's own top entry into this worktree.
  const push = git(worktree, ['stash', 'push', '--all', '-m', 'aipg-probe', '--', PROBE_FILE]);
  const stashAfter = git(worktree, ['stash', 'list']).stdout.trim();

  if (push.code === 0 && stashAfter === stashBefore) {
    rmSync(probe, { force: true });
    throw unsafe(`hook self-test could not run in ${worktree}: "git stash push" exited 0 but made NO stash entry (${firstLine(push.stdout) || firstLine(push.stderr) || 'no output'}), so the reference-transaction hook was never exercised — find what keeps git from stashing ${PROBE_FILE} there before starting any agent`);
  }
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

/**
 * Runs `command`, which `requireCommand` checked before the worktree was created, in `worktree`. A red one, or
 * one killed for passing its output cap, keeps the worktree, and its message names `removal`, the caller's
 * command that removes it.
 */
function runProvision(command, worktree, removal) {
  // Input
  const recovery = `re-provision it by hand with ${command}, or remove it with ${removal}.`;
  let r = null;

  // Process
  try {
    r = run(command, [], worktree, { shell: true, maxBuffer: GATE_MAX_BUFFER });
  } catch (err) {
    if (!err.overflow) throw err;
    throw unsafe(`--provision was KILLED in ${worktree} for writing more than ${GATE_MAX_BUFFER} bytes to stdout+stderr. It never reported an exit code, so this is NOT a report that it failed. The worktree is left in place. Make it quieter, then ${recovery}`);
  }
  relay(r);

  // Output
  if (r.code !== 0) throw unsafe(`--provision exited ${r.code} in ${worktree}, so the worktree is left in place. Fix the cause and ${recovery}`);
}

function prep(opt) {
  // Input
  const repo = requireRepo(opt);
  const batch = requireName(opt, 'batch');
  const key = requireName(opt, 'key');
  const provision = opt.provision === undefined ? undefined : requireCommand(opt, 'provision');

  // Process
  const integration = findBranch(listWorktrees(repo), intBranch(batch));
  if (!integration) {
    throw unsafe(`no worktree on ${intBranch(batch)} — first run wt.mjs init --repo ${shellQuote(repo)} --batch ${batch}; prep creates nothing but its own worktree, deliberately (concurrent check-then-act races)`);
  }

  const path = resolve(dirname(integration.path), chainDir(key));
  addWorktreeOnNewBranch(repo, chainBranch(batch, key), path, headsRef(intBranch(batch)), {
    what: `cannot create the worktree for "${key}" at ${path}`,
    recovery: `Its hook self-test never ran, so start no agent there. Fix the cause, remove it with node ${shellQuote(WT_SCRIPT)} clean --repo ${shellQuote(repo)} --key ${key}, delete the branch with git -C ${shellQuote(repo)} branch -D ${chainBranch(batch, key)}, then run prep again.`,
  });

  const worktree = findBranch(listWorktrees(repo), chainBranch(batch, key))?.path ?? path;
  selfTest(worktree);
  if (provision !== undefined) runProvision(provision, worktree, `node ${shellQuote(WT_SCRIPT)} clean --repo ${shellQuote(repo)} --key ${key}, which keeps the branch`);

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
const lockPath = (linkedWorktree) => resolve(gitCommonDir(linkedWorktree), LOCK_FILE);

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
function removeDeadLock(path) {
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

const TRASH_SCRIPT = fileURLToPath(new URL('./trash.mjs', import.meta.url));

// What git keeps in a worktree's git directory while an operation is unfinished, and the operation's
// name. `git worktree prune` deletes that directory outside the trash.
const OPERATION_MARKERS = [
  ['MERGE_HEAD', 'a merge'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase or am'],
  ['BISECT_LOG', 'a bisect'],
  // Outlives CHERRY_PICK_HEAD and REVERT_HEAD once a conflicted pick of a multi-commit sequence is
  // committed by hand.
  ['sequencer', 'a cherry-pick or revert sequence'],
];

// A rebase or bisect detaches HEAD, and git still counts the worktree as on the branch that operation
// returns to (is_worktree_being_rebased, is_worktree_being_bisected). BISECT_START holds an object id
// instead of a branch name when the bisect started detached.
const REBASE_HEAD_NAMES = ['rebase-merge/head-name', 'rebase-apply/head-name'];
const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// A file listing, such as the ignored files of a node_modules tree, can pass Node's 1 MiB default child-output cap.
const LISTING_MAX_BUFFER = 256 * MIB;
// Every ignored file by name, the files inside an ignored directory included, each name ended by a NUL. A
// directory that holds its own repository is one entry ending in `/`.
const IGNORED_LIST_ARGS = ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'];
// Every untracked file that no ignore rule matches, the files inside an untracked directory included, each name ended by
// a NUL. A directory that holds its own repository is one entry ending in `/`.
const UNTRACKED_LIST_ARGS = ['ls-files', '-z', '--others', '--exclude-standard'];

const pathExists = (path) => statSync(path, { throwIfNoEntry: false }) !== undefined;

/** A file's trimmed text, or '' when it cannot be read. */
function readTrimmed(file) {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const FOLDS_CASE = foldsCase(process.platform);
const caseKey = (p) => (FOLDS_CASE ? resolve(p).toLowerCase() : resolve(p));

const pruneCommand = (repo) => `git -C ${shellQuote(repo)} worktree prune`;
/** The by-hand removal a refusal names, which trashes each target and then prunes. */
const handRemoval = (repo, targets) => `node ${shellQuote(TRASH_SCRIPT)} ${targets.map(shellQuote).join(' ')} and then run ${pruneCommand(repo)}`;
const cannotRemove = (path, reason) => unsafe(`cannot remove the worktree at ${path}. ${reason}`);

/** Each `--git-path` answer for `names` in `cwd`, as an absolute path. */
function gitPaths(cwd, names) {
  const out = mustGit(cwd, ['rev-parse', ...names.flatMap((name) => ['--git-path', name])], `resolving the git paths of ${cwd}`);
  return outputLines(out).map((p) => (isAbsolute(p) ? p : resolve(cwd, p)));
}

/**
 * Each directory under `<git-common-dir>/worktrees`, keyed by the `caseKey` of the `.git` path its
 * `gitdir` file records. It is read from the repo, so a worktree whose folder is gone still has one.
 */
export function worktreeAdminDirs(repo) {
  // Input
  const [typedRoot] = gitPaths(repo, ['worktrees']);
  // git lists worktree paths in physical form, so a relative gitdir must resolve from the physical root,
  // not from a --repo typed through a symlink, junction or subst drive.
  const root = pathExists(typedRoot) ? realpathSync.native(typedRoot) : typedRoot;
  const dirs = (pathExists(root) ? readdirSync(root) : []).map((id) => join(root, id));
  const byDotGit = new Map();

  // Process
  for (const dir of dirs) {
    // A `gitdir` file may hold a path relative to its own directory (worktree.useRelativePaths).
    const recorded = readTrimmed(join(dir, 'gitdir'));
    if (recorded) byDotGit.set(caseKey(resolve(dir, recorded)), dir);
  }

  // Output
  return byDotGit;
}

/** The branch an unfinished rebase or bisect in the worktree git directory `gitDir` returns to, or ''. */
function heldBranch(gitDir) {
  // Input
  const headName = REBASE_HEAD_NAMES.map((name) => readTrimmed(join(gitDir, name))).find(Boolean) ?? '';
  const bisectStart = readTrimmed(join(gitDir, 'BISECT_START'));
  const rebased = shortBranch(headName);

  // Output
  if (rebased) return rebased;
  if (bisectStart && !OBJECT_ID_RE.test(bisectStart)) return bisectStart;
  return '';
}

/**
 * `listWorktrees` as `clean` reads it. Each linked entry gains `gitDir`, its directory under
 * `<git-common-dir>/worktrees` or null, and a detached one takes the branch its rebase or bisect holds,
 * so `clean --key` finds and refuses it and `clean --batch` counts it as a registered chain.
 */
function worktreesForClean(repo) {
  const entries = listWorktrees(repo);
  const byDotGit = worktreeAdminDirs(repo);
  return entries.map((e) => {
    const gitDir = e.main ? null : byDotGit.get(caseKey(join(e.path, '.git'))) ?? null;
    return { ...e, gitDir, branch: e.branch || (gitDir ? heldBranch(gitDir) : '') };
  });
}

/**
 * Whether a folder exists at `path` and its `.git` file points at `gitDir`. git reads whatever repository
 * holds a folder, so no check may run git in the folder before this one passes.
 */
function linksBack(path, gitDir) {
  const text = readTrimmed(join(path, '.git'));
  const target = text.startsWith('gitdir: ') ? text.slice('gitdir: '.length).trim() : '';
  if (!target || !gitDir) return false;
  try {
    return caseKey(realpathSync.native(resolve(path, target))) === caseKey(realpathSync.native(gitDir));
  } catch {
    return false;
  }
}

/**
 * The unlanded files of the worktree at `path` as a one-line list of at most `cap` names, or '' when it is
 * clean. A status listing that passes the output cap is never empty, so it proves the tree dirty.
 */
function unlandedFiles(path, cap) {
  try {
    return fileList(outputLines(mustGit(path, STATUS_ARGS, `reading the status of ${path}`)), cap);
  } catch (err) {
    if (!err.overflow) throw err;
    return `its status listing passed the ${NODE_DEFAULT_MAX_BUFFER / MIB} MiB output cap`;
  }
}

/** The `[marker, name]` of the operation unfinished in the worktree at `path`, or null. */
function operationInProgress(path) {
  const markers = gitPaths(path, OPERATION_MARKERS.map(([name]) => name));
  return OPERATION_MARKERS.find((_, i) => pathExists(markers[i])) ?? null;
}

/**
 * Why the existing folder of the worktree at `path` must not go to the trash, or null. `mainPath` is the
 * --repo the in-repo refusal names, and `unlandedAdvice` is what the unlanded-work refusal tells the operator to do.
 * `discard` lets unlanded work and an unfinished operation go with the folder.
 */
function folderProblem(repo, path, mainPath, { discard, unlandedAdvice }) {
  // Input
  const real = realpathSync.native(path);
  const cwd = realpathSync.native(process.cwd());
  const repoReal = realpathSync.native(repo);
  const nested = listWorktrees(repo).filter((e) => {
    const other = realpathLoose(e.path);
    return other !== real && isWithin(other, real, FOLDS_CASE);
  });
  const operation = discard ? null : operationInProgress(path);
  const dirty = discard ? '' : unlandedFiles(path);

  // Process
  if (isWithin(cwd, real, FOLDS_CASE)) return `The working directory ${cwd} is inside it. Change to a directory outside it and run this command again.`;
  if (isWithin(repoReal, real, FOLDS_CASE)) {
    return `The --repo path ${repo} is inside it, and the prune after the move runs there. Run this command again with --repo ${shellQuote(mainPath)}.`;
  }
  if (nested.length > 0) {
    return `It holds the registered worktree${nested.length === 1 ? '' : 's'} ${nested.map((e) => e.path).join(', ')}, and the prune after the move would drop ${nested.length === 1 ? 'its' : 'their'} registration with any unlanded work. Close or move ${nested.length === 1 ? 'it' : 'them'} first, then run this command again.`;
  }
  if (operation) {
    return `It has ${operation[1]} in progress (${operation[0]}), and "git worktree prune" would delete that state outside the trash. Finish or abort it there, then run this command again.`;
  }
  if (dirty) {
    return `It holds work that has not landed (${dirty}), so ${unlandedAdvice}.`;
  }

  // Output
  return null;
}

/**
 * How many ignored files go to the trash with the folder, or null when their names pass the listing cap.
 * The status check passes over them. The count only informs stderr, so an overflow never blocks the move.
 */
function ignoredFileCount(path) {
  // Input
  let out = '';
  let count = 0;
  try {
    out = mustGit(path, IGNORED_LIST_ARGS, `listing the ignored files of ${path}`, { maxBuffer: LISTING_MAX_BUFFER });
  } catch (err) {
    if (err.overflow) return null;
    throw err;
  }

  // Process
  // `-z` ends each name with a NUL, so counting NULs counts the names without building a string for each.
  for (let i = out.indexOf('\0'); i !== -1; i = out.indexOf('\0', i + 1)) count++;

  // Output
  return count;
}

/** A refused move left every file in place and an unknown one may have moved part of it, so neither may prune. */
function moveToTrash(repo, path) {
  try {
    return trash(path);
  } catch (err) {
    const state = err instanceof TrashError ? err.state : 'unknown';
    const reason = err instanceof TrashError ? err.reason : err.message;
    if (state === 'refused') {
      throw unsafe(`the trash refused the worktree at ${path} (${reason}), so it stays registered and intact and nothing was pruned. Clear that cause and run this command again, or move the folder elsewhere by hand and then run ${pruneCommand(repo)}.`);
    }
    throw unsafe(`the trash could not confirm where the worktree at ${path} went (${reason}), so nothing was pruned. Check the trash for it, then run this command again.`);
  }
}

/**
 * Refuses, with exit 40 and nothing changed, the main worktree, a worktree no gitdir file records, a locked one, and
 * one whose present folder does not link back. It runs no git call in the folder, so it may run before any check that does.
 */
function requireStructural(repo, entry) {
  // Input
  const { path, gitDir } = entry;

  // Process
  // Runs before the gitDir check, since the main worktree has no directory under worktrees/ either.
  if (entry.main) {
    throw cannotRemove(path, `It is the main worktree of the repo, whose .git holds the repository itself, so it is never removed. Switch it to another branch with git -C ${shellQuote(path)} switch <branch>, then run this command again.`);
  }
  if (!gitDir) {
    throw cannotRemove(path, `No gitdir file in the worktrees directory of ${repo} records it, so its git directory cannot be checked. Compare those files with git -C ${shellQuote(repo)} worktree list --porcelain.`);
  }
  if (entry.locked) {
    throw cannotRemove(path, `It is locked${entry.lockReason ? ` (${entry.lockReason})` : ''}, and "git worktree prune" keeps a locked worktree. If no process uses it, run git -C ${shellQuote(repo)} worktree unlock ${shellQuote(path)} and run this command again.`);
  }
  if (pathExists(path) && !linksBack(path, gitDir)) {
    throw cannotRemove(path, `Its .git file does not point at its git directory ${gitDir}, so the folder there may hold another repository. If the folder is this worktree, run git -C ${shellQuote(repo)} worktree repair ${shellQuote(path)}. Otherwise move the folder elsewhere. Then run this command again.`);
  }
}

/**
 * Refuses, with exit 40 and nothing changed, a worktree whose removal could lose work or reach another
 * folder, and returns whether its folder is present. An engine run leaves its accepted work staged, or
 * committed in develop's commit mode (tests/CLAUDE.md §4). Staged work has not landed, so a dirty tree is
 * refused. A folder already gone skips the checks that read it. `entry` comes from `worktreesForClean`, and
 * `mainPath` is the main worktree's path.
 * `discard` lets unlanded work and an unfinished operation go to the trash with the folder, and
 * `unlandedAdvice` replaces the land, commit or by-hand trash that the unlanded-work refusal names.
 */
function checkRemovable(repo, entry, mainPath, { discard = false, unlandedAdvice = '' } = {}) {
  requireStructural(repo, entry);

  // Input
  const { path, gitDir } = entry;
  const present = pathExists(path);
  const modules = join(gitDir, 'modules');
  const hasModules = pathExists(modules);
  // The by-hand prune deletes the submodule git directories, so every by-hand removal trashes them first.
  const byHand = handRemoval(repo, [present ? path : null, hasModules ? modules : null].filter(Boolean));
  const advice = unlandedAdvice || `land or commit it, or trash the folder${hasModules ? ` and the submodule git directories in ${modules}` : ''} by hand with ${byHand}`;
  let problem = null;

  // Process
  problem = present ? folderProblem(repo, path, mainPath, { discard, unlandedAdvice: advice }) : null;
  if (problem) throw cannotRemove(path, problem);
  if (hasModules) {
    throw cannotRemove(path, `It holds submodule git directories in ${modules}, which "git worktree prune" would delete outside the trash. Trash ${present ? 'the folder and that directory' : 'that directory'} by hand with ${byHand}.`);
  }

  // Output
  return present;
}

/**
 * Moves a registered worktree's folder to the trash and prunes its registration, once `checkRemovable`
 * passes with `opts`. `git worktree remove` is never run, since it deletes the folder and its ignored files
 * permanently. A folder already gone is pruned. A discard lists on stderr the work it trashed, the
 * operation whose state the prune deletes, and the detached HEAD of a rebase or bisect.
 */
function removeWorktree(repo, entry, mainPath, opts = {}) {
  // Input
  const { path } = entry;
  const present = checkRemovable(repo, entry, mainPath, opts);
  const work = present && opts.discard ? unlandedFiles(path, Infinity) : '';
  const operation = present && opts.discard ? operationInProgress(path) : null;
  // A commit made during a rebase or bisect is reachable only from its detached HEAD, which the prune deletes.
  const detachedAt = operation && !headRef(path) ? commitOf(path, 'HEAD') : '';
  const recovery = detachedAt ? `. Its detached HEAD was ${detachedAt}. To recover a commit made during it before git gc expires it, run git -C ${shellQuote(repo)} branch <name> ${detachedAt}` : '';
  let ignored = null;
  let ignoredText = '';
  let moved = null;

  // Process
  if (present) {
    ignored = ignoredFileCount(path);
    ignoredText = ignored === null
      ? `an uncounted number of ignored files, whose names pass the ${LISTING_MAX_BUFFER / MIB} MiB listing cap`
      : `${ignored} ignored file${ignored === 1 ? '' : 's'}`;
    moved = moveToTrash(repo, path);
    process.stderr.write(`moved ${path} to the trash at ${moved.location}${moved.verified ? '' : ' (unverified, the trash is not readable)'}, with ${ignoredText}\n`);
    if (work) process.stderr.write(`discarded the uncommitted work it held: ${work}\n`);
    if (operation) process.stderr.write(`discarded ${operation[1]} in progress, whose state (${operation[0]}) the prune deletes${recovery}\n`);
  } else {
    process.stderr.write(`the folder ${path} was already gone, so only its registration is pruned\n`);
  }
  mustGit(repo, ['worktree', 'prune'], 'git worktree prune');

  // Output
  if (listWorktrees(repo).some((e) => e.path === path)) {
    throw unsafe(`${path} is still registered after "git worktree prune". Check its entry in git -C ${shellQuote(repo)} worktree list --porcelain, then run this command again.`);
  }
}

function cleanChain(repo, key) {
  const entries = worktreesForClean(repo);
  const entry = findChain(entries, key);
  if (!entry) {
    // Idempotent on purpose: teardown runs after every chain, including ones that never got a worktree.
    process.stderr.write(`no worktree on aipg/<batch>/${key} — nothing to remove\n`);
    git(repo, ['worktree', 'prune']);
    return;
  }
  removeWorktree(repo, entry, entries[0].path);
  process.stderr.write(`kept branch ${entry.branch}\n`);
  process.stdout.write(`${entry.path}\n`);
}

function cleanBatch(repo, batch) {
  const entries = worktreesForClean(repo);
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

  // The hook and the land lock resolve only from a linked worktree (M27), so both are resolved before the
  // worktree goes away. A folder already gone leaves both alone, and `removeWorktree` refuses a folder
  // that is not the worktree. A dead lock goes only after the removal succeeds, so a refused clean
  // changes nothing.
  const linked = linksBack(entry.path, entry.gitDir);
  const hook = linked ? hookPath(entry.path) : null;
  const lock = linked ? lockPath(entry.path) : null;
  const state = hook ? hookState(hook) : 'unresolved';
  removeWorktree(repo, entry, entries[0].path);
  if (lock) removeDeadLock(lock);

  if (state === 'ours') {
    rmSync(hook, { force: true });
    process.stderr.write(`removed the AIPG reference-transaction hook at ${hook}\n`);
  } else if (state === 'foreign') {
    process.stderr.write(`left a FOREIGN reference-transaction hook in place at ${hook}\n`);
  } else if (state === 'unresolved') {
    process.stderr.write(`left the hook and any land lock alone, since their paths resolve only from a linked worktree\n`);
  }
  process.stderr.write(`kept branch ${intBranch(batch)}. Merge it where you want it.\n`);
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
 */
const isLanded = (worktree, batch, key) => contains(worktree, intBranch(batch), chainBranch(batch, key));

/**
 * Step 2. Commit the ACCEPTED index — index-only, never `-a`: work an engine left unstaged was not
 * accepted, so it is never committed and the land refuses while it remains. When the commit fails, the
 * split below is what separates "this chain finished with nothing to land" from "this chain's accepted
 * work is about to be left behind", and they must never share an exit code. The orchestrator moves on
 * from 10 and never lands that work.
 *
 * A clean tree over an empty index is NOT nothing-to-land on its own. It is also what the recovery this
 * tool prescribes leaves behind: `syncFromIntegration`'s exit 20 says "resolve it on <chain> and land
 * again", git's own conflict output says "fix conflicts and then commit the result", and once that commit
 * exists the tree is clean and the index empty while the BRANCH carries a merge integration has never
 * seen. Hence the branch-level question, which is the one exit 10 is really about.
 */
function commitAccepted(worktree, batch, key) {
  const commit = git(worktree, ['commit', '-m', `${key}: accepted`]);
  if (commit.code === 0) {
    // The gate runs in this tree and the land merges only the commit, so leftover work would be judged
    // and then left behind.
    const left = porcelainLines(worktree);
    if (!left.length) return;
    throw unsafe(`"${key}" committed its accepted index, but ${worktree} still holds work that was NOT accepted (${fileList(left)}) — the gate would judge it and the land would leave it behind; "git add" it if it passed review (develop-cycle's passed-but-unstaged halt), or save it outside the tree and discard it ("git stash" is refused here), then land again`);
  }

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
  throw unsafe(`"${key}" has an EMPTY index but a DIRTY worktree in ${worktree} (${fileList(lines)}) — the likely cause is develop-cycle's passed-but-unstaged halt, where the work is good and one "git add" fixes it; refusing to report nothing-to-land, since the orchestrator moves on from that and the work would never land`);
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

/** Runs the gate in `worktree` with both of its streams on stderr, and returns its exit code. */
function relayGate(command, worktree) {
  const r = run(command, [], worktree, { shell: true, maxBuffer: GATE_MAX_BUFFER });
  relay(r);
  return r.code;
}

/** Step 4. Only ever on a SYNCED state, the only state that predicts what integration will look like. */
function runGate(command, worktree, batch, key) {
  const code = relayGate(command, worktree);
  if (code === 0) return;

  throw fail(`the gate exited ${code} on the SYNCED state of "${key}" — ${intBranch(batch)} is untouched and still green. The sync merge is KEPT on ${chainBranch(batch, key)} so a fix run sees the exact combined state that failed: ${command}`, EXIT_RED);
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
    throw unsafe(`no worktree on ${intBranch(batch)} — nothing to land into; first run wt.mjs init --repo ${shellQuote(repo)} --batch ${batch}`);
  }
  const chain = findBranch(entries, chainBranch(batch, key));
  if (!chain) {
    throw unsafe(`no worktree on ${chainBranch(batch, key)} — first run wt.mjs prep --repo ${shellQuote(repo)} --batch ${batch} --key ${key}, and land only after that chain's run has EXITED`);
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
// open / close: one change in its own worktree, merged into a branch only by fast-forward
// =============================================================================

/** The names in git's `-z` output. */
const nulNames = (out) => out.split('\0').filter(Boolean);

/** `a/b/c` as `['a', 'a/b']`. */
const parentsOf = (path) => path.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'));

/**
 * The files of `files` in the way when git writes the tree paths `written`: a file at a path, a file inside
 * one, whose directory git replaces with the file, and a file above one, which git replaces with a directory.
 * An entry ending in `/`, the form ls-files gives a directory that holds its own repository, counts as a file at
 * that directory's path. Names compare without case where the file system folds it.
 */
export function filesInTheWay(files, written, foldCase = FOLDS_CASE) {
  // Input
  const key = (p) => (foldCase ? p.toLowerCase() : p).replace(/\/$/, '');
  const targets = new Set(written.map(key));
  const above = new Set(written.flatMap((p) => parentsOf(key(p))));

  // Process + Output
  return files.filter((file) => {
    const k = key(file);
    return targets.has(k) || above.has(k) || parentsOf(k).some((dir) => targets.has(dir));
  });
}

/**
 * The `kind` files that `args` lists in the worktree at `path`. A rebase, fast-forward or staging of the work
 * must know each one, so a listing past the cap refuses.
 */
function listFiles(path, args, kind) {
  try {
    return nulNames(mustGit(path, args, `listing the ${kind} files of ${path}`, { maxBuffer: LISTING_MAX_BUFFER }));
  } catch (err) {
    if (!err.overflow) throw err;
    throw unsafe(`the names of the ${kind} files in ${path} pass the ${LISTING_MAX_BUFFER / MIB} MiB listing cap, so close cannot tell which of them are in the way of the rebase, fast-forward or staged work. Move the largest ${kind} directories out of it, then run close again.`);
  }
}

const ignoredFiles = (path) => listFiles(path, IGNORED_LIST_ARGS, 'ignored');
const untrackedFiles = (path) => listFiles(path, UNTRACKED_LIST_ARGS, 'untracked');

/** The paths the tree of `to` holds and the tree of `from` lacks. */
const addedPaths = (cwd, from, to) => nulNames(mustGit(cwd, ['diff', '--name-only', '--no-renames', '--diff-filter=A', '-z', from, to],
  `listing the paths ${to} adds to ${from}`, { maxBuffer: LISTING_MAX_BUFFER }));

/**
 * The paths each commit in `from..to` adds, modifies or retypes, which a replay of those commits writes. A
 * modify/delete conflict writes the modified file too. A delete writes nothing.
 */
const pathsWrittenBy = (cwd, from, to) => nulNames(mustGit(cwd, ['log', '--format=', '--no-show-signature', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', `${from}..${to}`],
  `listing the paths the commits of ${from}..${to} write`, { maxBuffer: LISTING_MAX_BUFFER }));

/** The unmerged files of `worktree` as a one-line list, or '' when it has none. */
const unmergedNames = (worktree) => nameList(nulNames(mustGit(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'],
  `listing the unmerged files of ${worktree}`, { maxBuffer: LISTING_MAX_BUFFER })));

const rebaseInProgress = (worktree) => gitPaths(worktree, ['rebase-merge', 'rebase-apply']).some(pathExists);

/** The ref HEAD of `worktree` names, or '' for a detached HEAD. */
const headRef = (worktree) => git(worktree, ['symbolic-ref', '-q', 'HEAD']).stdout.trim();

/**
 * Each local branch of `repo`, spelled as git stores it, mapped to the full ref name a symbolic branch points at,
 * or to '' for any other branch. A ref name holds no space, so a space ends the name.
 */
function localBranchTargets(repo) {
  const out = mustGit(repo, ['for-each-ref', '--format=%(refname:strip=2) %(symref)', HEADS],
    `listing the branches of ${repo}`, { maxBuffer: LISTING_MAX_BUFFER });
  return new Map(outputLines(out).map((line) => line.split(' ')));
}

/** A file or ref name as the file system matches it: without case where the file system folds it. */
const foldName = (name) => (FOLDS_CASE ? name.toLowerCase() : name);

/** `targets` from `localBranchTargets`, keyed by `foldName`. */
const foldedTargets = (targets) => new Map([...targets].map(([name, target]) => [foldName(name), target]));

// git's SYMREF_MAXDEPTH, past which git stops following a chain of symbolic refs.
const SYMREF_MAX_HOPS = 5;

/**
 * The `foldName` key of the branch git reads for `branch`, once each symbolic branch is followed through `folded`
 * from `foldedTargets`. Two names with one key name one branch.
 */
function branchKey(folded, branch) {
  // Input
  let key = foldName(branch);
  let next = shortBranch(folded.get(key) ?? '');

  // Process
  for (let hop = 0; hop < SYMREF_MAX_HOPS && next; hop++) {
    key = foldName(next);
    next = shortBranch(folded.get(key) ?? '');
  }

  // Output
  return key;
}

/**
 * The local branch in `targets` from `localBranchTargets` that `branch` names, spelled as git stores it, or ''
 * when none does. Where the file system folds case, git finds the loose ref file of branch main for
 * refs/heads/Main, while the worktree list and every comparison here are exact. So an answer that differs from
 * `branch` in case is refused by each caller.
 */
function storedBranch(targets, branch) {
  if (targets.has(branch)) return branch;
  return [...targets.keys()].find((n) => foldName(n) === foldName(branch)) ?? '';
}

/**
 * `branch` when `repo`, whose `targets` come from `localBranchTargets`, has a local branch spelled that way, or
 * exit 40 naming the `flag` that gave it.
 */
function requireLocalBranch(repo, targets, branch, flag) {
  const stored = storedBranch(targets, branch);
  // storedBranch answers '' for no branch, so an empty `branch` would otherwise pass.
  if (stored && stored === branch) return branch;
  throw unsafe(stored
    ? `${flag} "${branch}" names branch ${stored} in another case, so pass ${flag} ${shellQuote(stored)}`
    : `${flag} "${branch}" is not a local branch in ${repo}`);
}

/**
 * Whether `aipg/<name>` is in `targets` from `localBranchTargets`, or exit 40 when the file system finds it as a
 * branch spelled in another case.
 */
function singleBranchExists(targets, name) {
  const branch = singleBranch(name);
  const stored = storedBranch(targets, branch);
  if (stored && stored !== branch) {
    throw unsafe(`--name "${name}" gives branch ${branch}, which this file system finds as branch ${stored}, spelled in another case. Pass the --name that ${stored} was opened with.`);
  }
  return stored === branch;
}

/** The local branch `open` cuts from: `--base`, or the branch checked out in `repo`, whose branches are `targets`. */
function resolveOpenBase(repo, targets, base) {
  // Input
  const current = base === undefined ? shortBranch(headRef(repo)) : '';
  let stored = '';

  // Process
  if (base !== undefined) return requireLocalBranch(repo, targets, base, '--base');
  if (!current) throw detachedBase(repo);
  stored = storedBranch(targets, current);
  if (stored && stored !== current) {
    throw unsafe(`the current branch "${current}" of ${repo} names branch ${stored} in another case, so name the branch to cut from with --base ${shellQuote(stored)}`);
  }
  if (!stored) throw unsafe(`the current branch "${current}" of ${repo} has no commit yet, so name the branch to cut from with --base`);

  // Output
  return current;
}

function open(opt) {
  // Input
  const repo = requireRepo(opt);
  const name = requireSingleName(opt);
  const parent = worktreeParent(repo, opt);
  const provision = opt.provision === undefined ? undefined : requireCommand(opt, 'provision');
  const branch = singleBranch(name);
  const path = resolve(parent.dir, chainDir(name));
  let targets = new Map();
  let base = '';
  let existing = '';
  let alias = '';
  let holder = null;
  let worktree = '';

  // Process
  targets = localBranchTargets(repo);
  base = resolveOpenBase(repo, targets, opt.base);
  existing = storedBranch(targets, branch);
  if (existing) {
    holder = findBranch(listWorktrees(repo), existing);
    alias = existing === branch ? '' : `, which this file system does not tell apart from ${branch}`;
    throw unsafe(`branch ${existing} already exists in ${repo}${alias}${holder ? `, and the worktree at ${holder.path} is on it, so finish that change with close` : ''}. Pick another --name, or, once its commits are merged or not needed, delete the branch with git -C ${shellQuote(repo)} branch -D ${existing}.`);
  }
  ensureWorktreeExcluded(repo, parent);
  addWorktreeOnNewBranch(repo, branch, path, headsRef(base), {
    what: `cannot create the worktree for "${name}" at ${path}`,
    recovery: `Fix the cause, remove it with node ${shellQuote(WT_SCRIPT)} close --repo ${shellQuote(repo)} --name ${name} --discard, delete the branch with git -C ${shellQuote(repo)} branch -D ${branch}, then run open again.`,
  });
  worktree = findBranch(listWorktrees(repo), branch)?.path ?? path;
  // Branch config goes with the branch when close deletes it, so the record outlives no change.
  mustGit(repo, ['config', baseKey(branch), base], `recording ${base} as the base of ${branch}`);
  if (provision !== undefined) runProvision(provision, worktree, `node ${shellQuote(WT_SCRIPT)} close --repo ${shellQuote(repo)} --name ${name} --discard, which keeps the branch`);

  // Output
  process.stderr.write(`opened ${branch} off ${base} in ${worktree}\n`);
  process.stdout.write(`${worktree}\n`);
}

/** The config key that holds the branch `open` cut `branch` from. */
const baseKey = (branch) => `branch.${branch}.aipgbase`;

/** The base `open` recorded for `branch`, or '' when none is recorded. */
function recordedBase(repo, branch) {
  const r = git(repo, ['config', '--get', baseKey(branch)]);
  if (r.code === 1) return '';
  if (r.code !== 0) throw unsafe(`reading the base of ${branch} failed: ${gitError(r)}`);
  return r.stdout.trim();
}

/** Deletes `branch` when `into` contains it, and returns whether it did. */
function deleteIfMerged(repo, branch, into) {
  if (!contains(repo, headsRef(into), headsRef(branch))) return false;
  // -D after that check, since -d judges against the current HEAD, which may be another branch.
  mustGit(repo, ['branch', '-D', branch], `deleting ${branch}`, UNATTENDED);
  return true;
}

/**
 * Exit 40 for a worktree `open` made that a switch or a detached HEAD took off `aipg/<name>`, found by its folder
 * name, or null. prep names a chain's folder the same way, so a chain branch of key `name` makes the folder ambiguous.
 */
function strayRefusal(targets, entries, name, exists) {
  // Input
  const branch = singleBranch(name);
  const folder = foldName(chainDir(name));
  const stray = entries.find((e) => !e.main && !chainParts(e.branch) && foldName(basename(e.path)) === folder && pathExists(e.path)) ?? null;
  let chains = [];

  // Process
  if (!stray) return null;
  chains = [...targets.keys()].filter((b) => foldName(chainParts(b)?.key ?? '') === foldName(name));
  if (chains.length > 0 && !exists) return null;

  // Output
  return offBranch(stray.path, stray.branch, branch, exists, chains);
}

/**
 * Exit 40 for the worktree of `branch` at `path` while `head`, a branch name or '' for a detached HEAD, is checked
 * out. After the switch back, a commit made on a detached HEAD is reachable only from the worktree's HEAD reflog,
 * which the prune of a later close deletes. `chains` names the chain branches the worktree may belong to instead.
 */
function offBranch(path, head, branch, exists, chains = []) {
  const held = head ? `branch ${head}` : 'a detached HEAD';
  const keep = head ? '' : `Keep any commit made on that detached HEAD with git -C ${shellQuote(path)} branch <new-name>. `;
  if (chains.length > 0) {
    return unsafe(`the worktree at ${path} has ${held} checked out, and the branches ${[branch, ...chains].join(', ')} exist, so it may be the worktree of any of them, and close leaves it in place. ${keep}Switch it back to its branch with git -C ${shellQuote(path)} switch <branch>, then run close again.`);
  }
  return unsafe(`the worktree of ${branch} at ${path} has ${held} checked out, so close leaves it in place. ${keep}Switch it back with git -C ${shellQuote(path)} switch ${exists ? '' : '-c '}${branch}, then run close again.`);
}

/**
 * Where the change `name` stands in `repo`, whose branches are `targets` from `localBranchTargets`: whether its branch
 * `exists`, the `entries` of `worktreesForClean` and the `entry` on its branch, or null. Exit 40 for a `--name` in
 * another case, and for a worktree of the change that is off its branch.
 */
function discoverChange(repo, name, targets) {
  // Input
  const branch = singleBranch(name);
  const exists = singleBranchExists(targets, name);
  const entries = worktreesForClean(repo);
  const entry = findBranch(entries, branch);
  const strayRefused = entry ? null : strayRefusal(targets, entries, name, exists);

  // Process
  if (strayRefused) throw strayRefused;

  // Output
  return { exists, entries, entry };
}

/**
 * Why `into`, the base `open` recorded for a change, cannot take it in `repo`, whose branches are `targets`, and
 * what to pass instead, or ''. closeInto refuses the same cases as a bad --into, which the operator never passed.
 */
function recordedBaseProblem(repo, targets, into) {
  // Input
  const stored = storedBranch(targets, into);
  const intoTarget = targets.get(into);
  const askInto = 'so name the branch to merge it into with --into';

  // Process + Output
  if (!stored) return `it is no longer a local branch in ${repo}, ${askInto}`;
  if (stored !== into) return `it names branch ${stored} in another case, so pass --into ${shellQuote(stored)}`;
  if (intoTarget) return `it is a symbolic ref to ${intoTarget}, ${askInto}`;
  if (isIntegration(into) || chainParts(into)) return `it is a branch of a batch, which only land moves, ${askInto}`;
  return '';
}

/**
 * Step 2 of `closeInto` when no worktree is on `aipg/<name>`. A close that stopped after its removal left the
 * branch, which `into` contains, or with `stage` holds staged, so it is deleted. Any other branch with commits
 * `into` lacks is refused.
 */
function closeWithoutWorktree(repo, branch, into, exists, stage) {
  // Process
  if (!exists) {
    git(repo, ['worktree', 'prune']);
    process.stderr.write(`no worktree and no branch ${branch}, so there is nothing to close\n`);
    return;
  }
  if (deleteIfMerged(repo, branch, into)) {
    process.stderr.write(`no worktree is on ${branch}, and ${into} contains it, so the branch was deleted\n`);
    return;
  }
  if (!stage || !deleteIfStaged(repo, branch, into)) {
    throw unsafe(`no worktree is on ${branch}, and it holds commits ${into} lacks, so close cannot gate them. Check it out in a free folder with git -C ${shellQuote(repo)} worktree add <folder> ${branch}, then run close again.`);
  }

  // Output
  process.stderr.write(`no worktree is on ${branch}, and its work is staged on ${into}, so the branch was deleted\n`);
}

/**
 * The end of a rebase of `branch` onto `into` in `worktree` that stopped with `rebased`, its nonzero `run` result.
 * Lists the unmerged files, aborts whatever that listing gives, confirms `branch` is back at `before`, and returns
 * the error to throw. A stop with unmerged files is a conflict, exit 20. One with none, such as a commit that failed
 * to sign, is exit 40.
 */
function abortStoppedRebase(worktree, branch, into, before, rebased) {
  // Input
  const stopped = gitError(rebased);
  const undone = `The rebase was aborted, ${branch} is back at ${before} and ${into} is untouched.`;
  let conflicts = '';
  let unlisted = '';
  let aborted = null;
  let restored = '';
  let left = '';

  // Process
  try {
    conflicts = unmergedNames(worktree);
  } catch (err) {
    unlisted = err.message;
  }
  aborted = git(worktree, ['rebase', '--abort'], UNATTENDED);
  restored = commitOf(worktree, headsRef(branch));
  if (aborted.code !== 0) left = `"git rebase --abort" failed (${gitError(aborted)}), so ${worktree} is mid-rebase`;
  else if (rebaseInProgress(worktree)) left = `${worktree} is still mid-rebase after "git rebase --abort"`;
  else if (restored !== before) left = `${branch} is at ${restored} after "git rebase --abort", not at ${before}`;
  if (left) {
    return unsafe(`the rebase of ${branch} onto ${into} stopped (${conflicts || stopped}), and ${left}. Finish or abort any rebase in ${worktree} and check ${branch} there, then run close again.`);
  }
  if (unlisted) {
    return unsafe(`the rebase of ${branch} onto ${into} stopped (${stopped}), and listing its unmerged files failed (${unlisted}). ${undone} Rebase ${branch} onto ${into} in ${worktree} by hand, then run close again.`);
  }
  if (!conflicts) return unsafe(`the rebase of ${branch} onto ${into} stopped with no conflicted file (${stopped}). ${undone} Clear that cause, then run close again.`);

  // Output
  return fail(`rebasing ${branch} onto ${into} conflicted (${conflicts}). ${undone} Rebase ${branch} onto ${into} in ${worktree} by hand, resolve the conflicts, and run close again.`, EXIT_CONFLICT);
}

/**
 * Step 5. Rebases `branch` in `worktree` onto `intoOld`, the commit `into` pointed at when close read it, so
 * the fast-forward's old-value check guards the commit the rebase built on. Returns the branch tip after it.
 * A branch that already contains `intoOld` stays as it is. A rebase drops every merge commit it replays, and
 * with it any change made only in that merge, such as a conflict resolution, so a branch holding one is refused.
 * A rebase that leaves uncommitted changes, such as a hook's output, is refused before the gate can take the blame.
 */
function rebaseOnto(worktree, branch, into, intoOld, before) {
  // Input
  const branchRef = headsRef(branch);
  let merges = [];
  let written = [];
  let doomed = [];
  let rebased = null;
  let after = '';
  let dirty = '';

  // Process
  if (contains(worktree, branchRef, intoOld)) return before;
  merges = outputLines(mustGit(worktree, ['rev-list', '--merges', `${intoOld}..${before}`], `listing the merge commits of ${branch} that ${into} lacks`));
  if (merges.length) {
    throw unsafe(`${branch} holds merge commits ${into} lacks (${nameList(merges)}), and a rebase onto ${into} drops each one with any change made only in it, so nothing changed. Rebase ${branch} onto ${into} by hand in ${worktree} and check that every change those merges carried survives, then run close again.`);
  }
  // The rebase's checkout of intoOld and its replay of the branch's commits write these paths over any ignored file.
  written = [...addedPaths(worktree, before, intoOld), ...pathsWrittenBy(worktree, intoOld, before)];
  doomed = filesInTheWay(ignoredFiles(worktree), written);
  if (doomed.length) {
    throw unsafe(`rebasing ${branch} onto ${into} would delete ignored files in ${worktree} without a word (${nameList(doomed)}). Move them out of the worktree, then run close again.`);
  }
  // Directory rename detection would move a file a branch commit adds to a path neither listing names.
  rebased = git(worktree, ['-c', 'rebase.updateRefs=false', '-c', 'merge.directoryRenames=false', 'rebase', '--no-autostash', intoOld], UNATTENDED);
  after = commitOf(worktree, branchRef);
  if (rebased.code === 0) {
    process.stderr.write(`rebased ${branch} onto ${into}: ${before} -> ${after}\n`);
    dirty = unlandedFiles(worktree);
    if (dirty) {
      throw unsafe(`the rebase of ${branch} onto ${into} left uncommitted changes in ${worktree} (${dirty}), such as files a post-checkout or post-rewrite hook wrote, so no gate ran and ${into} is untouched. ${branch} is at ${after}, and was at ${before} before the rebase. Commit or remove those changes, then run close again.`);
    }
    return after;
  }
  if (rebaseInProgress(worktree)) throw abortStoppedRebase(worktree, branch, into, before, rebased);
  if (after === before) throw unsafe(`git refused to rebase ${branch} onto ${into} in ${worktree}, so nothing changed: ${gitError(rebased)}`);

  // Output
  throw unsafe(`the rebase of ${branch} onto ${into} exited ${rebased.code} and moved ${branch} from ${before} to ${after}: ${gitError(rebased)}. Check ${branch} in ${worktree}, then run close again.`);
}

/**
 * Step 6. Gates `tip` in `worktree`, the exact commit `into` will point at. A gate that moved the branch,
 * switched off it or left changes judged something other than what would merge.
 */
function gateTip(worktree, branch, into, gate, tip, before) {
  // Input
  const history = tip === before ? '' : `, and was at ${before} before the rebase`;
  let code = 0;
  let now = '';
  let dirty = '';
  let changed = '';

  // Process
  code = relayGate(gate, worktree);
  if (code !== 0) {
    throw fail(`the gate exited ${code} on ${tip}, the commit ${into} would point at, so ${into} is untouched. ${branch} is at ${tip}${history}. Fix it in ${worktree}, commit, and run close again: ${gate}`, EXIT_RED);
  }
  now = commitOf(worktree, headsRef(branch));
  dirty = unlandedFiles(worktree);
  if (now !== tip) changed = `moved ${branch} from ${tip} to ${now}`;
  else if (headRef(worktree) !== headsRef(branch)) changed = `switched ${worktree} off ${branch}`;
  else if (dirty) changed = `left changes in ${worktree} (${dirty})`;

  // Output
  if (changed) {
    throw unsafe(`the gate passed but ${changed}, so it may not have judged ${tip}. ${into} is untouched. Put ${worktree} back on ${branch} at ${tip} with a clean tree, then run close again.`);
  }
}

/** The paths whose content differs between the trees of `from` and `to`, a rename as its two paths. */
const changedPaths = (cwd, from, to) => nulNames(mustGit(cwd, ['diff', '--name-only', '--no-renames', '-z', from, to],
  `listing the paths ${to} changes from ${from}`, { maxBuffer: LISTING_MAX_BUFFER }));

/** The tracked paths of the worktree at `path` with staged or unstaged changes. */
function changedTrackedPaths(path) {
  const unstaged = nulNames(mustGit(path, ['diff', '--name-only', '--no-renames', '-z'], `listing the modified files of ${path}`, { maxBuffer: LISTING_MAX_BUFFER }));
  const staged = nulNames(mustGit(path, ['diff', '--cached', '--name-only', '--no-renames', '-z'], `listing the staged files of ${path}`, { maxBuffer: LISTING_MAX_BUFFER }));
  return [...new Set([...unstaged, ...staged])];
}

/** The landings `landingProblem` judges. Only a fast-forward deletes the ignored files in its way. */
const FAST_FORWARD = { label: 'fast-forward', deletesIgnored: true };
const STAGED_WORK = { label: 'staged work', deletesIgnored: false };

/**
 * Why the worktree at `path`, which has `into` checked out, must not take the `landing` (FAST_FORWARD or
 * STAGED_WORK) from `from` to `to`, or null. The user may keep working there, so only a change at a path the
 * landing writes is refused, which git would refuse too without naming the worktree or the recovery. An untracked
 * file at a path the landing adds, inside one or above one is refused for the same reason. So is an ignored file
 * there, which git deletes without a word on a fast-forward and refuses on the staged work without naming the worktree.
 */
function landingProblem(path, from, to, landing) {
  // Input
  const operation = operationInProgress(path);
  let overlapping = [];
  let added = [];
  let blocking = [];
  let doomed = [];

  // Process
  // Cheapest first, since the file listings of a main checkout can run to hundreds of MB.
  if (operation) return `It has ${operation[1]} in progress (${operation[0]}). Finish or abort it there, then run close again.`;
  overlapping = filesInTheWay(changedTrackedPaths(path), changedPaths(path, from, to));
  if (overlapping.length) return `It has uncommitted changes at paths the ${landing.label} writes (${nameList(overlapping)}). Commit them or set them aside, then run close again.`;
  added = addedPaths(path, from, to);
  blocking = filesInTheWay(untrackedFiles(path), added);
  if (blocking.length) return `It holds untracked files in the way of the ${landing.label} (${nameList(blocking)}). Move them out of it, then run close again.`;
  doomed = filesInTheWay(ignoredFiles(path), added);
  if (doomed.length && landing.deletesIgnored) return `The ${landing.label} would delete ignored files there without a word (${nameList(doomed)}). Move them out of it, then run close again.`;
  if (doomed.length) return `It holds ignored files in the way of the ${landing.label} (${nameList(doomed)}). Move them out of it, then run close again.`;

  // Output
  return null;
}

/**
 * Why `holder`, a worktree entry whose `branch` names the same branch as `into`, must not take the landing on
 * `into`, a fast-forward or the staged work, or null. git reads whatever repository holds a folder, so no git call may run in it before this passes.
 */
function holderProblem(repo, into, holder) {
  // Input
  const { path, branch, main, gitDir, locked, lockReason } = holder;
  const present = pathExists(path);
  const gone = `The folder of the worktree at ${path}, which has it checked out, is gone`;

  // Process + Output
  if (branch !== into) {
    return `The worktree at ${path} has it checked out as ${branch}, which names the same branch. Once no rebase or bisect runs there, switch it with git -C ${shellQuote(path)} switch ${shellQuote(into)}, then run close again.`;
  }
  if (!present && locked) {
    return `${gone}, and it is locked${lockReason ? ` (${lockReason})` : ''}, so "git worktree prune" keeps it. If the folder is on a drive that is not mounted, mount it. Otherwise run git -C ${shellQuote(repo)} worktree unlock ${shellQuote(path)} and ${pruneCommand(repo)}. Then run close again.`;
  }
  if (!present) return `${gone}. Run ${pruneCommand(repo)}, then run close again.`;
  if (!main && !linksBack(path, gitDir)) {
    return `The .git file of the worktree at ${path}, which has it checked out, does not point at its git directory, so the folder may hold another repository. If the folder is that worktree, run git -C ${shellQuote(repo)} worktree repair ${shellQuote(path)}, then run close again.`;
  }
  return null;
}

/**
 * The worktree that has `into` checked out or that a rebase or bisect of `into` detached, or null. A fast-forward
 * updates the files of only the worktree it runs in and moves the branch under every other one, so `into` checked
 * out in two worktrees, or under another name (a case variant or a symbolic branch), is refused. `worktreesForClean`
 * reads an operation only for a linked worktree. The main worktree keeps its operation's state in the git common
 * dir, so that state is read from there. `verb` names the landing the refusal stops.
 */
function intoHolder(repo, into, verb) {
  // Input
  const folded = foldedTargets(localBranchTargets(repo));
  const mainHeld = heldBranch(gitCommonDir(repo));
  const intoKey = branchKey(folded, into);
  const holders = worktreesForClean(repo)
    .map((e) => ({ ...e, branch: e.branch || (e.main ? mainHeld : '') }))
    .filter((e) => e.branch && branchKey(folded, e.branch) === intoKey);
  let problem = null;

  // Process
  problem = holders.map((h) => holderProblem(repo, into, h)).find(Boolean) ?? null;
  if (!problem && holders.length > 1) {
    problem = `It is checked out in more than one worktree (${nameList(holders.map((h) => h.path))}). Switch all but one of them to another branch, then run close again.`;
  }

  // Output
  if (problem) throw unsafe(`cannot ${verb} ${into}, so it is untouched. ${problem}`);
  return holders[0] ?? null;
}

/** Exit 40, before anything is removed, unless `into` and the worktree that has it checked out are at `tip`. */
function verifyFastForward(repo, into, holder, tip) {
  // Input
  const now = commitOf(repo, headsRef(into));
  const head = holder ? commitOf(holder.path, 'HEAD') : tip;
  const unmerged = holder ? unmergedNames(holder.path) : '';
  let problem = '';

  // Process
  if (now !== tip) problem = `${into} is at ${now}`;
  else if (head !== tip) problem = `the worktree at ${holder.path} has HEAD at ${head}`;
  else if (unmerged) problem = `the worktree at ${holder.path} shows unmerged files (${unmerged})`;

  // Output
  if (problem) throw unsafe(`the fast-forward of ${into} to ${tip} did not verify, since ${problem}. Nothing was removed. Check ${into}, then run close again.`);
}

/**
 * Step 7. Moves `into` from `intoOld` to `tip`, with `git merge --ff-only <tip>` in the worktree that has `into`
 * checked out, or with an update-ref that checks the old value when none has. Naming the gated commit keeps a
 * commit that lands on the branch after the gate out of `into`. A move of `into` is exit 20: update-ref checks
 * the old value as it writes, and the merge, which succeeds from any ancestor of `tip`, runs only after `into`
 * is re-read at `intoOld`.
 */
function fastForward(repo, name, into, intoOld, tip) {
  // Input
  const intoRef = headsRef(into);
  const holder = intoHolder(repo, into, 'fast-forward');
  const problem = holder ? landingProblem(holder.path, intoOld, tip, FAST_FORWARD) : null;
  const movedAway = () => fail(`${into} moved while close ran, so it was not fast-forwarded and ${singleBranch(name)} keeps its gated work. Run close again.`, EXIT_CONFLICT);
  let moved = null;

  // Process
  // Before the problem, which was judged against intoOld and is stale once `into` moved.
  if (commitOf(repo, intoRef) !== intoOld) throw movedAway();
  if (problem) throw unsafe(`cannot fast-forward ${into} in the worktree at ${holder.path}, so it is untouched. ${problem}`);
  moved = holder
    ? git(holder.path, ['merge', '--ff-only', tip], UNATTENDED)
    : git(repo, ['update-ref', '-m', `aipg close ${name}`, intoRef, tip, intoOld], UNATTENDED);
  if (moved.code !== 0 && !contains(repo, tip, intoRef)) throw movedAway();
  if (moved.code !== 0) throw unsafe(`fast-forwarding ${into} to ${tip} failed: ${gitError(moved)}`);

  // Output
  verifyFastForward(repo, into, holder, tip);
  process.stderr.write(`fast-forwarded ${into} from ${intoOld} to ${tip}\n`);
}

/**
 * Step 3 of `close --stage`. Commits the staged work in `worktree` to `branch` as one carrier commit, so the rebase
 * and the gate handle it as they handle a commit. The carrier never reaches the user's branch, since `--stage` lands
 * only its changes, so it is built with commit-tree and runs no commit hook. Work no acceptance staged is refused.
 */
function carryStaged(worktree, branch, name) {
  // Input
  const staged = git(worktree, ['diff', '--cached', '--quiet']);
  const unstaged = porcelainLines(worktree).filter((line) => line[1] !== ' ');
  let tree = '';
  let parent = '';
  let carrier = '';

  // Process
  if (staged.code === 0) return;
  if (staged.code !== 1) throw unsafe(`reading the staged work of ${worktree} failed: ${gitError(staged)}`);
  if (unstaged.length) {
    throw unsafe(`${worktree} holds work beside its staged work that no acceptance staged (${fileList(unstaged)}), so close lands nothing. Set it aside as develop's guide says, then run close again.`);
  }
  tree = mustGit(worktree, ['write-tree'], `writing the staged tree of ${worktree}`).trim();
  parent = commitOf(worktree, 'HEAD');
  carrier = mustGit(worktree, ['commit-tree', tree, '-p', parent, '-m', `${name}: accepted`], `committing the staged work of ${worktree}`, UNATTENDED).trim();
  mustGit(worktree, ['update-ref', '-m', `aipg close ${name}`, headsRef(branch), carrier, parent], `moving ${branch} to the carrier commit ${carrier}`, UNATTENDED);

  // Output
  process.stderr.write(`carried the staged work of ${branch} in commit ${carrier}\n`);
}

/** Whether the index of the worktree at `path` holds `tip`'s content at each of `paths`. */
function stagedAt(path, tip, paths) {
  const differing = new Set(nulNames(mustGit(path, ['diff', '--cached', '--name-only', '--no-renames', '-z', tip],
    `comparing the index of ${path} with ${tip}`, { maxBuffer: LISTING_MAX_BUFFER })).map(foldName));
  return paths.every((p) => !differing.has(foldName(p)));
}

/**
 * Step 7 of `close --stage`. Applies the changes from `intoOld` to `tip` to the index and files of the worktree that has
 * `into` checked out, and leaves `into` where it is, so the user reviews and commits them. A change already staged there
 * is not applied twice, which lets a close run again after a later stop finish.
 */
function applyStaged(repo, name, into, intoOld, tip) {
  // Input
  const holder = intoHolder(repo, into, 'stage the work on');
  const paths = changedPaths(repo, intoOld, tip);
  let problem = null;
  let patch = '';
  let applied = null;

  // Process
  if (!holder) {
    throw unsafe(`--stage stages the work in the worktree that has ${into} checked out, and none has it, so ${into} is untouched. Check ${into} out, then run close again.`);
  }
  if (commitOf(repo, headsRef(into)) !== intoOld) {
    throw fail(`${into} moved while close ran, so nothing was staged and ${singleBranch(name)} keeps its gated work. Run close again.`, EXIT_CONFLICT);
  }
  if (stagedAt(holder.path, tip, paths)) {
    process.stderr.write(`the worktree at ${holder.path} already has the work of ${singleBranch(name)} staged\n`);
    return;
  }
  problem = landingProblem(holder.path, intoOld, tip, STAGED_WORK);
  if (problem) throw unsafe(`cannot stage the work in the worktree at ${holder.path}, so it is untouched. ${problem}`);
  patch = mustGit(repo, ['diff', '--binary', '--full-index', '--no-renames', intoOld, tip], `reading the changes of ${singleBranch(name)}`, { maxBuffer: GATE_MAX_BUFFER });
  applied = git(holder.path, ['apply', '--index', '--whitespace=nowarn'], { input: patch, maxBuffer: GATE_MAX_BUFFER });
  if (applied.code !== 0) throw unsafe(`staging the work of ${singleBranch(name)} in ${holder.path} failed, and git apply changed nothing: ${gitError(applied)}`);

  // Output
  if (!stagedAt(holder.path, tip, paths)) {
    throw unsafe(`the work of ${singleBranch(name)} was applied in ${holder.path} but its index does not match ${tip}. Nothing was removed. Check git -C ${shellQuote(holder.path)} diff --cached, then run close again.`);
  }
  process.stderr.write(`staged the work of ${singleBranch(name)} in ${holder.path}, and ${into} stays at ${intoOld}\n`);
}

/**
 * Deletes `branch` once the worktree that has `into` checked out holds its work staged, and returns whether it did.
 * The work is the change from where `branch` left `into` to its tip.
 */
function deleteIfStaged(repo, branch, into) {
  // Input
  const holder = intoHolder(repo, into, 'find the staged work on');
  const tip = commitOf(repo, headsRef(branch));
  const from = mustGit(repo, ['merge-base', headsRef(into), tip], `finding where ${branch} left ${into}`).trim();

  // Process + Output
  if (!holder || !stagedAt(holder.path, tip, changedPaths(repo, from, tip))) return false;
  mustGit(repo, ['branch', '-D', branch], `deleting ${branch}`, UNATTENDED);
  return true;
}

/**
 * `close --into`: merges `aipg/<name>` into `into` only by fast-forward, after gating the exact commit `into`
 * will point at, then removes the worktree and deletes the branch. With `stage`, it stages the gated change in the
 * worktree that has `into` checked out instead, and `into` stays where it is. A refusal before the rebase changes
 * nothing but the carrier commit of step 3, which holds the staged work as it was. A close run again after a later
 * stop finishes the steps left, since steps 2 to 5 and 7 skip what is done.
 */
function closeInto(repo, name, into, gate, stage = false) {
  // Input
  const branch = singleBranch(name);
  const branchRef = headsRef(branch);
  const intoRef = headsRef(into);
  const opts = { unlandedAdvice: `commit it, or trash the worktree with its uncommitted work with node ${shellQuote(WT_SCRIPT)} close --repo ${shellQuote(repo)} --name ${name} --discard, which keeps the branch` };
  let targets = new Map();
  let exists = false;
  let entries = [];
  let entry = null;
  let present = false;
  let head = '';
  let intoOld = '';
  let before = '';
  let tip = '';
  let branchAt = '';
  let intoAt = '';
  let intoTarget = '';

  // Process
  // 1. `into` is a local branch other than the one being closed, no batch's branch, which close would move outside
  // the land lock, and no symbolic branch, which moves the branch it points at under another name.
  if (into === branch) throw unsafe(`--into ${into} is the branch being closed, so name the branch to merge it into`);
  if (isIntegration(into) || chainParts(into)) {
    throw unsafe(`--into ${into} is a branch of a batch, which only land moves, under the lock that keeps two merges into it apart. Name another --into, or land the change as a chain of that batch.`);
  }
  targets = localBranchTargets(repo);
  requireLocalBranch(repo, targets, into, '--into');
  intoTarget = targets.get(into);
  if (intoTarget) throw unsafe(`--into ${into} is a symbolic ref to ${intoTarget}, so a fast-forward of it would move ${intoTarget}. Pass the branch it points at as --into.`);

  // 2. Discovery. With no worktree, only the branch is left to settle.
  ({ exists, entries, entry } = discoverChange(repo, name, targets));
  if (!entry) {
    closeWithoutWorktree(repo, branch, into, exists, stage);
    return;
  }

  // 3. With stage, the staged work becomes a commit first, once the refusals that run no git call in the folder pass.
  // A worktree off its branch or with an operation in progress skips the carry, and the checks below refuse it.
  if (stage) requireStructural(repo, entry);
  if (stage && pathExists(entry.path) && headRef(entry.path) === branchRef && !operationInProgress(entry.path)) {
    carryStaged(entry.path, branch, name);
  }
  present = checkRemovable(repo, entry, entries[0].path, opts);
  head = present ? headRef(entry.path) : '';
  if (present && head !== branchRef) throw offBranch(entry.path, shortBranch(head) || head, branch, exists);

  // 4. A branch `into` already contains needs no merge. 5 to 7: rebase when `into` has a commit the branch lacks,
  // gate, fast-forward.
  before = commitOf(repo, branchRef);
  tip = before;
  if (contains(repo, intoRef, before)) {
    process.stderr.write(`${into} already contains ${branch}, so nothing is merged and no gate runs\n`);
  } else if (!present) {
    throw unsafe(`the folder ${entry.path} of the worktree on ${branch} is gone, so close cannot gate the commits ${into} lacks. Run git -C ${shellQuote(repo)} worktree prune, check the branch out with git -C ${shellQuote(repo)} worktree add ${shellQuote(entry.path)} ${branch}, then run close again.`);
  } else {
    intoOld = commitOf(repo, intoRef);
    tip = rebaseOnto(entry.path, branch, into, intoOld, before);
    gateTip(entry.path, branch, into, gate, tip, before);
    if (stage) applyStaged(repo, name, into, intoOld, tip);
    else fastForward(repo, name, into, intoOld, tip);
  }

  // 8. Removal, re-read in case the gate's run changed the registration, then the branch `into` contains or, with
  // stage, holds staged.
  removeWorktree(repo, findBranch(worktreesForClean(repo), branch) ?? entry, entries[0].path, opts);
  if (!deleteIfMerged(repo, branch, into) && !(stage && deleteIfStaged(repo, branch, into))) {
    branchAt = commitOf(repo, branchRef);
    throw unsafe(branchAt === tip
      ? `the worktree at ${entry.path} went to the trash, but ${into} no longer ${stage ? 'holds the work staged' : 'contains it'}, so ${branch} is kept. Check ${into}, then run close again.`
      : `the worktree at ${entry.path} went to the trash, but ${branch} moved from ${tip} to ${branchAt}, so the branch is kept. Check it out in a free folder with git -C ${shellQuote(repo)} worktree add <folder> ${branch}, then run close again, which gates it.`);
  }
  intoAt = commitOf(repo, intoRef);

  // Output
  process.stderr.write(`closed ${branch}: ${into} is at ${intoAt}\n`);
  process.stdout.write(`${entry.path}\n`);
}

/**
 * `close --discard`: trashes the worktree with any uncommitted work in it and keeps the branch. Every refusal of
 * `checkRemovable` but the unlanded-work and unfinished-operation ones still applies. So does the refusal of a
 * worktree off its branch with no rebase or bisect of it, since the prune drops the HEAD that reaches any commit
 * made off the branch. A rebase or bisect of the branch goes with the worktree, and stderr names its detached HEAD.
 */
function closeDiscard(repo, name) {
  // Input
  const branch = singleBranch(name);
  const { exists, entries, entry } = discoverChange(repo, name, localBranchTargets(repo));
  let tip = '';

  // Process
  if (entry) {
    removeWorktree(repo, entry, entries[0].path, { discard: true });
  } else {
    git(repo, ['worktree', 'prune']);
    process.stderr.write(`no worktree is on ${branch}, so there is nothing to discard\n`);
  }
  tip = exists ? commitOf(repo, headsRef(branch)) : '';

  // Output
  if (tip) process.stderr.write(`kept branch ${branch} at ${tip}. Delete it with git -C ${shellQuote(repo)} branch -D ${branch}\n`);
  if (entry) process.stdout.write(`${entry.path}\n`);
}

function close(opt) {
  // Input
  const repo = requireRepo(opt);
  const name = requireSingleName(opt);
  const branch = singleBranch(name);
  const discard = opt.discard === true;
  const stage = opt.stage === true;
  let into = opt.into;
  let gate = '';
  let targets = null;
  let baseProblem = '';
  let change = null;

  // Process
  if (discard && (opt.into !== undefined || opt.gate !== undefined || stage)) {
    throw fail('close --discard takes no --into, --gate or --stage, since it merges nothing');
  }
  if (discard) {
    closeDiscard(repo, name);
    return;
  }
  gate = requireCommand(opt, 'gate');
  if (into === undefined) {
    into = recordedBase(repo, branch);
    targets = localBranchTargets(repo);
    baseProblem = into ? recordedBaseProblem(repo, targets, into) : '';
    change = into ? null : discoverChange(repo, name, targets);
  }
  if (baseProblem) throw unsafe(`open recorded ${into} as the base of ${branch} in git config ${baseKey(branch)}, and ${baseProblem}`);
  if (change && !change.exists && !change.entry) {
    git(repo, ['worktree', 'prune']);
    process.stderr.write(`no branch ${branch}, so there is nothing to close\n`);
    return;
  }
  if (change) throw unsafe(`open recorded no base for ${branch}, so name the branch to merge it into with --into`);

  // Output
  closeInto(repo, name, into, gate, stage);
}

// =============================================================================
// CLI
// =============================================================================

const VERBS = {
  init: { fn: init, flags: ['repo', 'batch', 'base', 'dir'] },
  prep: { fn: prep, flags: ['repo', 'batch', 'key', 'provision'] },
  land: { fn: land, flags: ['repo', 'batch', 'key', 'gate', 'scope-file', 'wait-ms', 'stale-ms'] },
  clean: { fn: clean, flags: ['repo', 'batch', 'key'] },
  open: { fn: open, flags: ['repo', 'name', 'base', 'dir', 'provision'] },
  close: { fn: close, flags: ['repo', 'name', 'into', 'gate'], switches: ['discard', 'stage'] },
};

const USAGE = `usage:
  node tools/wt.mjs init  --repo <abs> --batch <name> [--base <branch>] [--dir <abs>]
  node tools/wt.mjs prep  --repo <abs> --batch <name> --key <chain> [--provision "<cmd>"]
  node tools/wt.mjs land  --repo <abs> --batch <name> --key <chain> --gate "<cmd>" [--scope-file <abs>] [--wait-ms <n>] [--stale-ms <n>]
  node tools/wt.mjs clean --repo <abs> --key <chain>
  node tools/wt.mjs clean --repo <abs> --batch <name>
  node tools/wt.mjs open  --repo <abs> --name <name> [--base <branch>] [--dir <abs>] [--provision "<cmd>"]
  node tools/wt.mjs close --repo <abs> --name <name> [--into <branch>] --gate "<cmd>" [--stage]
  node tools/wt.mjs close --repo <abs> --name <name> --discard`;

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

/**
 * `--name` for open and close, which may not start with int- in any case, since `aipg/int-<x>` reads as a batch's
 * integration branch, and a file system that folds case finds `aipg/INT-<x>` as that branch's loose ref.
 */
function requireSingleName(opt) {
  const name = requireName(opt, 'name');
  if (/^int-/i.test(name)) {
    throw fail(`--name "${name}" starts with "${name.slice(0, 'int-'.length)}", and aipg/int-<x> in any case reads as the integration branch of a batch, so pick a name that does not`);
  }
  return name;
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
 * `<verb> [--flag value]… [--switch]…`, validated. NOTHING is coerced: a bare `--batch` is an error, never
 * the string "true" quietly naming a branch (the defect gen-units.mjs's numeric flags were fixed for), and a
 * flag belonging to another verb is an error rather than a silently ignored argument. A switch such as
 * `--discard` takes no value and reads as `true`.
 */
export function parseArgv(argv) {
  const [verb, ...rest] = argv;
  if (!verb || !Object.hasOwn(VERBS, verb)) throw fail(`${verb ? `unknown verb "${verb}"` : 'no verb given'} — ${USAGE}`);

  const { flags, switches = [] } = VERBS[verb];
  const opt = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) throw fail(`unexpected argument "${token}" — every value follows its own flag. ${USAGE}`);

    const name = token.slice(2);
    if (!flags.includes(name) && !switches.includes(name)) {
      throw fail(`unknown flag "--${name}" for ${verb} — it takes ${[...flags, ...switches].map((f) => `--${f}`).join(' ')}`);
    }
    if (opt[name] !== undefined) throw fail(`--${name} was given twice`);
    if (switches.includes(name)) {
      opt[name] = true;
      continue;
    }

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

// Node resolves the MAIN module through realpath by default (`--preserve-symlinks-main` off), so
// `import.meta.url` is canonical while argv[1] is whatever the caller typed. A symlink, a Windows junction
// or a `subst` drive anywhere in the invocation path makes the two differ and `invokedDirectly` false. The
// process then writes nothing at exit 0 and bypasses every loud failure above, the silent-success shape
// this file exists to prevent. Realpath BOTH sides, so it holds under `--preserve-symlinks-main` too.
// (Twin of the same expression in tools/plan-block.mjs, per tests/CLAUDE.md §1.)
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`wt: ${err.message}\n`);
    process.exitCode = err.exitCode ?? EXIT_ERROR;
  }
}
