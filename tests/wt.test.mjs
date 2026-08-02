// tools/wt.mjs — ordinary Node, driven as a child process against REAL git in throwaway repos.
//
// Fixtures live under mkdtemp(os.tmpdir(), 'aipg-wt-') and NEVER under REPO_ROOT: static.test.mjs
// CR-scans the checkout and core.autocrlf=true on a Windows box puts CR bytes into checked-out fixture
// files, and a stray fixture would also dirty the tree the build's own clean-baseline check reads.
// Every fixture is removed in `finally`, on pass and on fail alike — worktrees included, since they are
// created inside the same temp root.
//
// What is worth asserting here is the git behaviour the tool is built on, not the tool's own bookkeeping:
// that the hook refuses `git stash` in a batch worktree while commit/branch/merge still work (the M19
// brick), that it leaves the user's own worktrees alone (M31), that prep's self-test catches a missing
// hook without leaving a probe entry on the shared stash stack, and that N concurrent preps do not race
// (M26 — spawn + Promise.all; execFileSync is blocking and would prove nothing).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { HOOK, heartbeat, takeoverLock } from '../tools/wt.mjs';

const SCRIPT = join(REPO_ROOT, 'tools/wt.mjs');

/**
 * Returns { code, stdout, stderr } — never throws, so a nonzero exit is an assertable value.
 *
 * spawnSync, not execFileSync: execFileSync surfaces stderr only through the exception it throws, so a
 * SUCCESSFUL run's stderr is unreachable — and stderr is where this tool writes everything a human reads
 * (`sync skipped`, `TAKING OVER`, every `AIPG scope:` warning). Asserted through execFileSync, those
 * lines all read as absent on the exit-0 paths that are the only place they appear.
 *
 * The buffer is raised above spawnSync's own 1 MiB default for one scenario: the loud-gate case relays
 * megabytes of the gate's output through wt's stderr, and at the default THIS harness is what dies
 * (`r.error`), never reaching the assertion.
 */
const CAPTURE_MAX_BUFFER = 64 * 1024 * 1024;

function runCli(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: CAPTURE_MAX_BUFFER, ...opts });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

const wt = (argv) => runCli(process.execPath, [SCRIPT, ...argv]);

/**
 * Every path this file touches is absolute, and this is the guard that keeps it that way. A path read
 * out of a command's stdout is EMPTY when that command failed, and an empty path resolves against the
 * process cwd — which here is the checkout. That is not theoretical: while mutation-testing this file, a
 * `git stash push`/`add -A`/`commit` aimed at `''` ran against this repository instead of the fixture.
 * Throwing kills the file loudly (run.mjs reports it) rather than operating on the developer's own tree.
 */
function abs(path, what) {
  if (!path || !isAbsolute(path)) throw new Error(`wt.test: refusing to use a non-absolute ${what}: ${JSON.stringify(path)} — the command that produced it failed`);
  return path;
}
const at = (base, ...parts) => join(abs(base, 'base path'), ...parts);
const git = (cwd, args) => runCli('git', ['-C', abs(cwd, 'git cwd'), ...args]);

/** The same directory can be spelled with either separator and either case on Windows. */
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';

/** '' for a missing file: an assertion about content that a regression DELETED must fail, not throw. */
const readOr = (p) => (existsSync(abs(p, 'file path')) ? readFileSync(p, 'utf8') : '');

const worktreePaths = (repo) => git(repo, ['worktree', 'list', '--porcelain']).stdout
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => norm(l.slice('worktree '.length).trim()));

const sha = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', ref]).stdout.trim();
const hookOf = (linkedWorktree) => git(linkedWorktree, ['rev-parse', '--git-path', 'hooks/reference-transaction']).stdout.trim();

/** A repo whose parent directory is the temp root, so worktrees land beside it and die with it. */
function makeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aipg-wt-')));
  const repo = join(root, 'r');
  mkdirSync(repo);

  git(repo, ['init', '-q', '-b', 'main']);
  // Pinned so the fixture is reproducible on any box: autocrlf would change committed bytes, and an
  // unset identity or a signing requirement makes every commit here fail.
  git(repo, ['config', 'core.autocrlf', 'false']);
  git(repo, ['config', 'user.name', 'AIPG Test']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  // A core.hooksPath inherited from the developer's own config would send this fixture's hook OUTSIDE
  // the fixture (--git-path honours it, M27) — i.e. the test would write into their hooks dir. Pin it
  // inside the fixture when one is set; leave it alone otherwise, so the default path is what is tested.
  if (git(repo, ['config', '--get', 'core.hooksPath']).code === 0) {
    git(repo, ['config', 'core.hooksPath', join(repo, '.git', 'hooks')]);
  }
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  return { root, repo };
}

async function withFixture(fn) {
  const fixture = makeFixture();
  try {
    await fn(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

// --- land fixtures ------------------------------------------------------------------------------

/** Every land scenario runs on batch b1, so the argv is worth saying once. */
const land = (repo, key, gate, extra = []) =>
  wt(['land', '--repo', repo, '--batch', 'b1', '--key', key, '--gate', gate, ...extra]);

/** init + one prep per key: the state a fan-out leaves behind, just before the runs start. */
function batchOf(root, repo, keys) {
  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  const chains = {};
  for (const key of keys) {
    const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', key]);
    eq(r.code, 0, `prep ${key} exits 0 (${firstLine(r.stderr)})`);
    chains[key] = abs(r.stdout.trim(), `${key} worktree path`);
  }
  return { intWt: join(root, 'aipg-int-b1'), chains };
}

/** An engine's RESTING state: accepted work STAGED, never committed (tests/CLAUDE.md §4). */
function stage(worktree, file, content) {
  const path = at(worktree, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  eq(git(worktree, ['add', '--', file]).code, 0, `stage ${file} in ${worktree}`);
}

/** A --gate the tool shells out to. Written OUTSIDE every worktree so it is not part of any diff. */
function gateCmd(root, name, body) {
  const path = join(root, `gate-${name}.cjs`);
  writeFileSync(path, body);
  return `node "${path}"`;
}

const GATE_GREEN = '// always green\n';
// The semantic-overlap case: two chains touch DISJOINT files and still break a cross-file invariant.
const GATE_ONE_OWNER = `const fs = require('fs');
const has = (f) => { try { return fs.readFileSync(f, 'utf8').includes('OWNER'); } catch { return false; } };
if (has('a.txt') && has('b.txt')) { console.error('two files claim OWNER'); process.exit(1); }
`;

const lockOf = (repo) => at(git(repo, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'aipg-land.lock');
const writeLock = (repo, owner) => writeFileSync(lockOf(repo), `${JSON.stringify(owner)}\n`);

/** A pid that is certainly not running: a child that has already exited. */
const deadPid = () => Number(runCli(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.trim());

const spawnCli = (args) => new Promise((done) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => done({ code, stdout, stderr }));
});

// ---------------------------------------------------------------------------------------------

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'pipe' }); } catch { hasGit = false; }

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('init cuts the integration branch, checks it out, and installs the hook');
await withFixture(({ root, repo }) => {
  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 0, `init exits 0 (${firstLine(r.stderr)})`);
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-int-b1'))), 'the integration worktree sits beside the repo');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== '', 'branch aipg/int-b1 exists');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/main'), 'with --base omitted it is cut from the CURRENT HEAD branch');

  const hook = hookOf(join(root, 'aipg-int-b1'));
  ok(existsSync(hook), `the hook is at the --git-path location (${hook})`);
  eq(readFileSync(hook, 'utf8'), HOOK, 'the hook content is byte-exact');

  const again = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(again.code, 0, 'a second init of the SAME batch is a no-op exit 0');
  eq(worktreePaths(repo).length, 2, '...adding no second worktree');

  const other = wt(['init', '--repo', repo, '--batch', 'b2']);
  eq(other.code, 40, 'a second, DIFFERENT batch while b1 is active exits 40');
  ok(/already active/.test(other.stderr), `...naming the batch that holds it: ${firstLine(other.stderr)}`);
});

section('--base picks the branch to cut from; a detached HEAD has no default to fall back to');
await withFixture(({ repo }) => {
  git(repo, ['checkout', '-q', '-b', 'dev']);
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'dev work']);
  git(repo, ['checkout', '-q', 'main']);

  const r = wt(['init', '--repo', repo, '--batch', 'b1', '--base', 'dev']);
  eq(r.code, 0, `init --base dev exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/dev'), 'the integration branch is cut from --base, not from HEAD');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== sha(repo, 'refs/heads/main'), '...which is a different commit from HEAD here');
});
await withFixture(({ repo }) => {
  git(repo, ['checkout', '-q', '--detach', 'HEAD']);
  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 40, 'a detached HEAD with no --base exits 40 rather than guessing a default branch');
  ok(/DETACHED HEAD/.test(r.stderr), `...loudly: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), '', '...and creates no branch');
});

section('a FOREIGN reference-transaction hook is never clobbered');
await withFixture(({ repo }) => {
  const hook = join(repo, '.git', 'hooks', 'reference-transaction');
  const foreign = '#!/bin/sh\n# somebody else got here first\nexit 0\n';
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(hook, foreign);

  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 40, 'init exits 40 when a different hook already exists');
  eq(readFileSync(hook, 'utf8'), foreign, '...and the existing hook is untouched');
  ok(/refusing to clobber/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
});

section('prep adds one worktree per chain, and the hook is live inside it');
await withFixture(({ root, repo }) => {
  const early = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(early.code, 40, 'prep before init exits 40');
  ok(/init/.test(early.stderr), `...naming init as the fix: ${firstLine(early.stderr)}`);

  wt(['init', '--repo', repo, '--batch', 'b1']);
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 — its hook self-test passed (${firstLine(r.stderr)})`);
  const chain = r.stdout.trim();
  eq(norm(chain), norm(join(root, 'aipg-alpha')), 'it prints the worktree path, beside the integration worktree');
  ok(sha(repo, 'refs/heads/aipg/b1/alpha') !== '', 'the branch is exactly aipg/<batch>/<chain>');
  ok(!existsSync(at(chain, '.aipg-hook-probe')), 'the self-test left no probe file behind');
  eq(git(chain, ['status', '--porcelain']).stdout.trim(), '', '...a clean worktree');
  eq(git(chain, ['stash', 'list']).stdout.trim(), '', '...and an empty stash stack');

  // The refusal itself. A stash needs something to save, so make a change first.
  writeFileSync(at(chain, 'c.txt'), 'c\n');
  const stash = git(chain, ['stash', 'push', '-u', '-m', 'x']);
  ok(stash.code !== 0, 'git stash inside the prepped worktree is refused');
  ok(/AIPG: refuse/.test(stash.stderr), `...with the AIPG message: ${firstLine(stash.stderr)}`);
  eq(git(chain, ['stash', 'list']).stdout.trim(), '', '...and no entry reaches the shared stash stack');

  // M19: the naive hook exits 1 on EVERY ref transaction, which would brick all of these.
  writeFileSync(at(chain, 'c.txt'), 'c\n');
  git(chain, ['add', '-A']);
  eq(git(chain, ['commit', '-qm', 'alpha work']).code, 0, 'git commit in a batch worktree still works');
  eq(git(chain, ['branch', 'probe-branch']).code, 0, 'git branch still works');
  eq(git(join(root, 'aipg-int-b1'), ['merge', '--no-ff', '-m', 'land alpha', 'aipg/b1/alpha']).code, 0, 'git merge into the integration worktree still works');

  // M31: the hook is scoped to aipg-* worktrees, so the user's own tree keeps git stash.
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  eq(git(repo, ['stash', 'push', '-u', '-m', 'user own']).code, 0, 'the MAIN worktree keeps git stash');
  eq(git(repo, ['stash', 'pop']).code, 0, '...and git stash pop');
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', '...leaving the stack empty');
});

section("a stash entry the operator already had is not residue — prep's self-test is a DELTA check");
await withFixture(({ root, repo }) => {
  // refs/stash is ONE stack for the whole repo, so "did the probe leave residue" can only be answered
  // against a baseline. Asked in absolute terms ("is the stack empty"), every developer who already had
  // WIP stashed in the target repo got exit 40 from a self-test that had actually PASSED.
  writeFileSync(join(repo, 'a.txt'), 'operator WIP\n');
  eq(git(repo, ['stash', 'push', '-u', '-m', 'operator WIP']).code, 0, 'the operator stashes their own work before any of this');
  const before = git(repo, ['stash', 'list']).stdout.trim();
  ok(before !== '', '...so refs/stash is NOT empty when prep runs');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0 with that entry on the stack');
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 — the pre-existing entry is not the probe's residue (${firstLine(r.stderr)})`);
  eq(norm(r.stdout.trim()), norm(join(root, 'aipg-alpha')), '...and it still prints the worktree path');
  eq(git(repo, ['stash', 'list']).stdout.trim(), before, "...leaving the operator's own entry exactly as it was");
  ok(!existsSync(join(root, 'aipg-alpha', '.aipg-hook-probe')), '...and no probe file behind');
});

section("prep's self-test catches a hook removed behind its back, and leaves no probe residue");
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  rmSync(hookOf(join(root, 'aipg-int-b1')), { force: true });

  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'beta']);
  eq(r.code, 40, 'prep exits 40 when the stash probe is ACCEPTED');
  ok(/self-test FAILED/.test(r.stderr), `...saying which check failed: ${firstLine(r.stderr)}`);
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', '...with no probe entry left on the shared stash stack');
  ok(!existsSync(join(root, 'aipg-beta', '.aipg-hook-probe')), '...and no probe file left in the worktree');
  eq(git(join(root, 'aipg-beta'), ['status', '--porcelain']).stdout.trim(), '', '...and a clean worktree');
});

section('--provision runs in the new worktree; a red one exits 40 and keeps the worktree');
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const good = join(root, 'provision-ok.cjs');
  const bad = join(root, 'provision-bad.cjs');
  writeFileSync(good, "require('fs').writeFileSync('provisioned.txt', 'ok\\n');\n");
  writeFileSync(bad, "process.stderr.write('provision blew up\\n'); process.exit(3);\n");

  const green = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha', '--provision', `node "${good}"`]);
  eq(green.code, 0, `a zero-exit --provision keeps prep green (${firstLine(green.stderr)})`);
  ok(existsSync(join(root, 'aipg-alpha', 'provisioned.txt')), '...and it ran with cwd = the new worktree');

  const red = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'gamma', '--provision', `node "${bad}"`]);
  eq(red.code, 40, 'a nonzero --provision exits 40');
  ok(/provision blew up/.test(red.stderr), "...surfacing the command's own stderr");
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-gamma'))), '...and LEAVES the worktree registered (removing it would discard the branch)');
});

section('a command KILLED for flooding its output buffer is SAID so, never given a fabricated exit code');
await withFixture(({ root, repo }) => {
  // Node caps a child's combined stdout+stderr at 1 MiB unless told otherwise, and a child that exceeds
  // it is KILLED reporting NO exit status — `err.status` is null. Read as `status ?? 1`, that is an exit
  // code nothing observed, indistinguishable from a real failure. The tool must name the overflow.
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const loud = join(root, 'provision-loud.cjs');
  writeFileSync(loud, "process.stdout.write('x'.repeat(2 * 1024 * 1024));\nprocess.exit(0);\n");

  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha', '--provision', `node "${loud}"`]);
  eq(r.code, 40, 'a command whose output overflows the buffer exits 40');
  ok(/KILLED/.test(r.stderr), `...saying it was killed: ${firstLine(r.stderr)}`);
  ok(/NOT a report that it failed/.test(r.stderr), '...and refusing to call an unobserved exit code a failure');
  ok(/1048576 bytes/.test(r.stderr), '...naming the limit it hit');
});

section('three CONCURRENT preps of distinct keys all succeed (M26)');
await withFixture(async ({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const keys = ['c1', 'c2', 'c3'];
  const runs = await Promise.all(keys.map((key) =>
    spawnCli([SCRIPT, 'prep', '--repo', repo, '--batch', 'b1', '--key', key])));

  runs.forEach((r, i) => eq(r.code, 0, `concurrent prep ${keys[i]} exits 0 (${firstLine(r.stderr)})`));
  // M26's measurement was `errs=[]`, not just "the exits were 0": the racing shape emitted git fatals
  // ("already exists", "cannot lock ref HEAD", "index.lock: File exists") on runs that still registered.
  runs.forEach((r, i) => ok(!/^(fatal|error):/m.test(r.stderr), `concurrent prep ${keys[i]} raised no git error`));
  const paths = worktreePaths(repo);
  for (const key of keys) ok(paths.includes(norm(join(root, `aipg-${key}`))), `aipg-${key} is registered`);
  eq(paths.length, 5, 'main + integration + 3 chains — nothing lost to the race');
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', 'three concurrent self-tests left the stash stack empty');
});

section('clean removes the worktree, keeps the branch, and obeys the same byte-equal hook rule');
await withFixture(async ({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  const chain = join(root, 'aipg-alpha');
  const hook = hookOf(join(root, 'aipg-int-b1'));

  const c1 = wt(['clean', '--repo', repo, '--key', 'alpha']);
  eq(c1.code, 0, `clean --key exits 0 (${firstLine(c1.stderr)})`);
  ok(!worktreePaths(repo).includes(norm(chain)), '...the chain worktree is out of the registry');
  ok(!existsSync(chain), '...and off disk');
  ok(sha(repo, 'refs/heads/aipg/b1/alpha') !== '', '...while its branch is kept');

  const c2 = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(c2.code, 0, `clean --batch exits 0 (${firstLine(c2.stderr)})`);
  ok(!existsSync(join(root, 'aipg-int-b1')), '...the integration worktree is gone');
  ok(!existsSync(hook), '...the byte-equal hook is removed with it');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== '', '...and the integration branch is kept for the user to merge');
});
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const hook = hookOf(join(root, 'aipg-int-b1'));
  const foreign = `${HOOK}# and then somebody edited it\n`;
  writeFileSync(hook, foreign);

  const r = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 0, 'clean --batch still tears the worktree down with a foreign hook present');
  eq(readFileSync(hook, 'utf8'), foreign, '...and leaves that hook alone');
});

section('clean REFUSES a worktree that still holds unlanded work, instead of forcing it away');
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  const chain = join(root, 'aipg-alpha');
  const intWt = join(root, 'aipg-int-b1');
  const hook = hookOf(intWt);

  // The resting state of a finished engine run is accepted work STAGED, never committed
  // (tests/CLAUDE.md §4) — so this is what a `clean` fired one step ahead of the land actually meets.
  // `worktree remove --force` deleted it at exit 0, with no patch and no prompt.
  writeFileSync(at(chain, 'wip.txt'), 'accepted, not yet landed\n');
  eq(git(chain, ['add', '-A']).code, 0, 'stage work in the chain worktree');

  const refused = wt(['clean', '--repo', repo, '--key', 'alpha']);
  eq(refused.code, 40, 'clean --key exits 40 rather than discarding staged work');
  ok(/land or commit/.test(refused.stderr), `...naming the ways out: ${firstLine(refused.stderr)}`);
  ok(worktreePaths(repo).includes(norm(chain)), '...the worktree is still registered');
  eq(readOr(at(chain, 'wip.txt')), 'accepted, not yet landed\n', '...and the work is still on disk');

  eq(git(chain, ['commit', '-qm', 'alpha work']).code, 0, 'commit that work');
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key exits 0 once nothing is unlanded');
  ok(!existsSync(chain), '...and removes it, so the guard costs the landed path nothing');

  // Same guard on the integration worktree — a half-resolved merge conflict reads as "modified" too.
  writeFileSync(at(intWt, 'a.txt'), 'half-resolved\n');
  const refusedBatch = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(refusedBatch.code, 40, 'clean --batch exits 40 on a dirty integration worktree');
  ok(existsSync(intWt), '...the integration worktree survives');
  eq(readOr(hook), HOOK, '...and the hook is still installed (nothing was torn down)');
});

section('clean --batch REFUSES while a sibling chain of the batch is still registered');
await withFixture(({ root, repo }) => {
  // The reference-transaction hook is ONE file shared by every worktree of the repo. Removing it while a
  // chain of this batch is still checked out silently un-protects that chain — measured: after the hook
  // went, `git stash push -u` in the surviving worktree was ACCEPTED and its work landed on the shared
  // refs/stash stack, which is the M25 hazard the hook exists to prevent.
  wt(['init', '--repo', repo, '--batch', 'b1']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'beta']);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'alpha lands and is cleaned');

  const intWt = join(root, 'aipg-int-b1');
  const beta = join(root, 'aipg-beta');
  const hook = hookOf(intWt);

  const refused = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(refused.code, 40, 'clean --batch exits 40 while beta is still registered');
  ok(/aipg\/b1\/beta/.test(refused.stderr), `...naming the chain that holds it: ${firstLine(refused.stderr)}`);
  ok(!/aipg\/b1\/alpha/.test(refused.stderr), '...and not the chain already cleaned');
  eq(readOr(hook), HOOK, '...the shared hook is still installed');
  ok(worktreePaths(repo).includes(norm(intWt)), '...and the integration worktree survives');

  writeFileSync(at(beta, 'wip.txt'), 'beta work\n');
  const stash = git(beta, ['stash', 'push', '-u', '-m', 'hazard']);
  ok(stash.code !== 0, '...so a stash inside beta is STILL refused');
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', "...and beta's work never reaches the shared stash stack");
  rmSync(at(beta, 'wip.txt'), { force: true });

  eq(wt(['clean', '--repo', repo, '--key', 'beta']).code, 0, 'clean --key beta clears the precondition');
  eq(wt(['clean', '--repo', repo, '--batch', 'b1']).code, 0, '...after which clean --batch exits 0');
  ok(!existsSync(hook), '...and only then is the shared hook removed');
});

section('a non-default --dir given only to init survives the whole lifecycle (discovery, not state)');
await withFixture(({ root, repo }) => {
  const alt = join(root, 'elsewhere');
  mkdirSync(alt);

  eq(wt(['init', '--repo', repo, '--batch', 'b1', '--dir', alt]).code, 0, 'init --dir exits 0');
  ok(existsSync(join(alt, 'aipg-int-b1')), 'the integration worktree lands under --dir');

  const p = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(p.code, 0, 'prep needs no --dir');
  eq(norm(p.stdout.trim()), norm(join(alt, 'aipg-alpha')), '...it finds the location from worktree list');
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key finds it the same way');
  eq(wt(['clean', '--repo', repo, '--batch', 'b1']).code, 0, 'clean --batch too');
  ok(!existsSync(join(alt, 'aipg-int-b1')), 'nothing is left under --dir');
});

section('land: two chains with disjoint edits, in order — the first skips the sync, the second merges it');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  // Counts its own runs, so "the gate was skipped" is an assertion rather than an absence of complaint.
  const ledger = join(root, 'gate-runs.txt');
  const gate = gateCmd(root, 'count', `require('fs').appendFileSync(${JSON.stringify(ledger)}, process.cwd() + '\\n');\n`);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  const a = land(repo, 'alpha', gate);
  eq(a.code, 0, `land alpha exits 0 (${firstLine(a.stderr)})`);
  ok(/sync skipped/.test(a.stderr), '...the FIRST lander finds integration already an ancestor and skips the sync (M28)');
  eq(readOr(ledger), '', '...and the gate too: it merged nothing, so there is no combined state its own run did not already gate');
  eq(norm(a.stdout.trim()), norm(intWt), '...and prints the integration worktree it landed into');

  const b = land(repo, 'beta', gate);
  eq(b.code, 0, `land beta exits 0 (${firstLine(b.stderr)})`);
  ok(/synced aipg\/int-b1/.test(b.stderr), '...the SECOND lander syncs integration in first');
  const gateRuns = readOr(ledger).split('\n').filter(Boolean);
  eq(gateRuns.length, 1, '...and gates exactly once, on the merge it just made');
  eq(norm(gateRuns[0]), norm(chains.beta), '...in the CHAIN worktree, on the merged state');

  const log = git(intWt, ['log', '--format=%s']).stdout;
  ok(/land alpha/.test(log), 'the integration log records landing alpha');
  ok(/land beta/.test(log), '...and landing beta');
  ok(existsSync(at(intWt, 'alpha.txt')) && existsSync(at(intWt, 'beta.txt')), "both chains' work is in the integration tree");
  eq(git(intWt, ['status', '--porcelain']).stdout.trim(), '', 'the integration worktree is clean throughout');
  ok(!existsSync(lockOf(repo)), 'and no land lock is left behind');
});

section('land: a textual conflict parks the branch and leaves integration untouched (exit 20)');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'a.txt', 'beta edit\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 20, 'the second land of the same line exits 20 conflict');
  ok(/CONFLICTED/.test(r.stderr), `...saying so and naming the file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...INTEGRATION IS UNTOUCHED (the invariant, asserted by SHA)');
  ok(git(chains.beta, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0, '...MERGE_HEAD is gone — the merge was aborted');
  eq(git(chains.beta, ['status', '--porcelain']).stdout.trim(), '', '...the chain worktree is clean again');
  eq(git(repo, ['show', 'aipg/b1/beta:a.txt']).stdout, 'beta edit\n', "...and the branch still holds beta's accepted work");
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
  eq(git(intWt, ['status', '--porcelain']).stdout.trim(), '', '...and a clean integration worktree');
});

section('land: a conflict RESOLVED BY HAND still lands — a clean tree is not an empty branch');
await withFixture(({ root, repo }) => {
  // The recovery this tool's own conflict message prescribes ("resolve it on <chain> and land again"),
  // completed the way git's own conflict output prescribes (fix it, add it, commit it). That leaves the
  // chain worktree CLEAN with an EMPTY index — byte for byte the shape of a chain that accepted nothing —
  // while its BRANCH carries a resolved merge integration has never seen. Read as nothing-to-land, the
  // orchestrator moves on (exit 10 is documented as "not an error") and a later `clean --key` removes the
  // only copy of that work, with no error anywhere.
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'a.txt', 'beta edit\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first');
  eq(land(repo, 'beta', gate).code, 20, 'beta conflicts, and its work is parked on its branch');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  ok(git(chains.beta, ['merge', 'aipg/int-b1']).code !== 0, 'the hand merge conflicts too, as the land did');
  writeFileSync(at(chains.beta, 'a.txt'), 'alpha edit\nbeta edit\n');
  eq(git(chains.beta, ['add', '--', 'a.txt']).code, 0, '...the operator resolves it');
  eq(git(chains.beta, ['commit', '-qm', 'resolve sync']).code, 0, '...and COMMITS the resolution');
  eq(git(chains.beta, ['status', '--porcelain']).stdout.trim(), '', '...leaving a clean tree and an empty index');

  const r = land(repo, 'beta', gate);
  eq(r.code, 0, `the resolved chain LANDS (${firstLine(r.stderr)})`);
  ok(!/nothing to land/.test(r.stderr), '...it is never reported as nothing-to-land');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...integration really moved (SHA)');
  eq(readOr(at(intWt, 'a.txt')), 'alpha edit\nbeta edit\n', '...carrying the hand-resolved content into the integration tree');
  ok(/land beta/.test(git(intWt, ['log', '--format=%s']).stdout), '...recorded in the integration log');
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: a sync git REFUSES up front is exit 40, not a conflict — and nothing is aborted');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'beta.txt', 'beta\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands, so the sync into beta now touches a.txt');

  // UNSTAGED — so it survives the index-only accept commit and git refuses the merge before it starts.
  writeFileSync(at(chains.beta, 'a.txt'), 'unaccepted local edit\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'a merge refused for unstaged overlap exits 40, NOT 20');
  ok(/REFUSED/.test(r.stderr), `...naming the refusal: ${firstLine(r.stderr)}`);
  ok(/a\.txt/.test(r.stderr), '...and the file that blocks it');
  ok(!/no merge to abort/.test(r.stderr), '...with no "there is no merge to abort" fatal (the abort is MERGE_HEAD-gated)');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  eq(readOr(at(chains.beta, 'a.txt')), 'unaccepted local edit\n', '...and the unaccepted edit is still there, untouched');
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: disjoint FILES can still break the build — a red gate on the merged state is exit 30');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'one-owner', GATE_ONE_OWNER);
  stage(chains.alpha, 'a.txt', 'OWNER\n');
  stage(chains.beta, 'b.txt', 'OWNER\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its own run already gated that state)');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 30, 'beta touches no file of alpha\'s and still exits 30 on the SYNCED state');
  ok(/two files claim OWNER/.test(r.stderr), "...surfacing the gate's own output");
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  ok(/sync aipg\/int-b1/.test(git(repo, ['log', '--format=%s', 'aipg/b1/beta']).stdout),
    '...the sync merge is KEPT on the branch, recording the combined state a fix run must address');
  eq(runCli(process.execPath, [join(root, 'gate-one-owner.cjs')], { cwd: intWt }).code, 0, "...and integration's own gate is still green");
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: a RETRY after a red gate is GATED AGAIN — the kept sync merge is not a free pass');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const ledger = join(root, 'retry-gate-runs.txt');
  // Counts its runs AND enforces the cross-file invariant, so "was it gated at all" and "what did it
  // say" are both assertable against the same command.
  const gate = gateCmd(root, 'counted-owner', `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(ledger)}, process.cwd() + '\\n');
const has = (f) => { try { return fs.readFileSync(f, 'utf8').includes('OWNER'); } catch { return false; } };
if (has('a.txt') && has('b.txt')) { console.error('two files claim OWNER'); process.exit(1); }
`);
  const gateRuns = () => readOr(ledger).split('\n').filter(Boolean).length;

  stage(chains.alpha, 'a.txt', 'OWNER\n');
  stage(chains.beta, 'b.txt', 'OWNER\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip, no sync merge on it yet)');
  eq(land(repo, 'beta', gate).code, 30, 'beta exits 30 on the merged state');
  eq(gateRuns(), 1, '...having gated exactly once');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  // Exit 30 deliberately KEEPS the sync merge on the branch, so from here on integration is an ancestor
  // of the chain forever. The documented recovery — fix it on the chain and land again — was therefore
  // the one path that read "int is an ancestor" as "already gated", skipped the gate entirely and merged
  // a RED combined state into integration at exit 0. A retry that fixes NOTHING must still be caught.
  stage(chains.beta, 'unrelated.txt', 'a change that fixes nothing\n');
  const retry = land(repo, 'beta', gate);
  eq(retry.code, 30, 'a retry that does NOT fix the breakage exits 30 again');
  ok(!/sync skipped/.test(retry.stderr), '...the kept sync merge is not mistaken for an already-gated state');
  eq(gateRuns(), 2, '...because the gate really ran a second time');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...and integration is still untouched (SHA)');

  stage(chains.beta, 'b.txt', 'no claim here\n');
  const fixed = land(repo, 'beta', gate);
  eq(fixed.code, 0, `a retry that DOES fix it lands (${firstLine(fixed.stderr)})`);
  eq(gateRuns(), 3, '...gated a third time, on the exact state it landed');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...and only now does integration move');
  eq(runCli(process.execPath, [join(root, 'gate-counted-owner.cjs')], { cwd: intWt }).code, 0,
    "...leaving integration's own gate green, which is the invariant the retry path had been breaking");
  ok(!existsSync(lockOf(repo)), 'and no lock survives any of it');
});

section('land: a gate that PASSES loudly lands — output past the 1 MiB default is not a red gate');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  // A gate is a build or a test suite by definition, so clearing Node's 1 MiB default child-output cap is
  // ordinary, not adversarial. Over it the child is KILLED with no exit status, and reading that as exit 1
  // reported a gate that had called process.exit(0) as integration-red (30): the chain's accepted work was
  // blocked and the operator was pointed at a failure that never happened.
  const gate = gateCmd(root, 'loud', "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\n');\nprocess.exit(0);\n");
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its gate never runs)');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  // No firstLine() on this stderr: it carries the gate's 2 MiB of output, relayed verbatim.
  const r = land(repo, 'beta', gate);
  eq(r.code, 0, 'a gate that writes 2 MiB and exits 0 is GREEN, and beta lands');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...integration really moved (SHA)');
  ok(existsSync(at(intWt, 'beta.txt')), "...carrying beta's work into the integration tree");
  ok(!/exited 1/.test(r.stderr), '...with no fabricated exit code anywhere in the report');
  ok(!existsSync(lockOf(repo)), '...and no lock left behind');
});

section('land: an empty index is nothing-to-land (10) only when the tree is CLEAN — otherwise 40');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['c1', 'c2', 'c3']);
  const gate = gateCmd(root, 'green', GATE_GREEN);

  const nothing = land(repo, 'c1', gate);
  eq(nothing.code, 10, 'an untouched chain exits 10 nothing-to-land');
  ok(/nothing to land/.test(nothing.stderr), `...saying so: ${firstLine(nothing.stderr)}`);

  // feature-cycle's passed-but-unstaged halt: the work is GOOD and one `git add` fixes it. Reporting 10
  // here would let a later `clean --key` force-remove the only copy of it.
  writeFileSync(at(chains.c2, 'a.txt'), 'accepted but never staged\n');
  const dirty = land(repo, 'c2', gate);
  eq(dirty.code, 40, 'an empty index over a DIRTY tree exits 40, never 10');
  ok(/a\.txt/.test(dirty.stderr), '...listing the files');
  ok(/passed-but-unstaged/.test(dirty.stderr), `...and naming the likely cause: ${firstLine(dirty.stderr)}`);

  writeFileSync(at(chains.c3, 'n.txt'), 'created, only intent-to-add\n');
  eq(git(chains.c3, ['add', '-N', '--', 'n.txt']).code, 0, 'a developer round leaves created files intent-to-add');
  const ita = land(repo, 'c3', gate);
  eq(ita.code, 40, 'a residual intent-to-add entry exits 40');
  ok(/intent-to-add/.test(ita.stderr), `...naming it: ${firstLine(ita.stderr)}`);
  ok(/n\.txt/.test(ita.stderr), '...and the file it would have committed EMPTY');
  ok(!existsSync(lockOf(repo)), 'no lock survives any of those exits');
});

section('land: the repo-global lock serializes landing — held is 75, dead is taken over');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');

  // A LIVE holder: this test process itself, which is unambiguously running.
  writeLock(repo, { pid: process.pid, key: 'other', startedAt: Date.now() });
  const held = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(held.code, 75, 'a lock held by a LIVE owner exits 75 retry-later after --wait-ms');
  ok(new RegExp(`pid ${process.pid} landing "other"`).test(held.stderr), `...naming the holder: ${firstLine(held.stderr)}`);
  ok(existsSync(lockOf(repo)), "...and does NOT touch someone else's lock");
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/main'), '...integration never moved');

  // The same lock, owned by a process that is gone.
  writeLock(repo, { pid: deadPid(), key: 'crashed', startedAt: Date.now() });
  const taken = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(taken.code, 0, 'a lock whose owner is GONE is taken over and the land proceeds');
  ok(/TAKING OVER/.test(taken.stderr), `...loudly: ${firstLine(taken.stderr)}`);
  ok(/is GONE/.test(taken.stderr), '...saying the owner is dead, not merely old');
  ok(!existsSync(lockOf(repo)), '...and the lock is released on the way out');
});

section('land: a lock goes stale by its HEARTBEAT, never by how long its holder has been running');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  const HOUR = 3600000;
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  // A holder that has been landing for an HOUR and is still progressing: a pid that is unambiguously
  // alive (this test process), an ancient startedAt, and a heartbeat written just now. Measured from
  // startedAt this lock is long past --stale-ms and gets stolen out from under a land that may be
  // mid-merge; measured from the heartbeat it is simply busy. A gate that IS the project's test suite
  // makes that an ordinary Tuesday, not an edge case.
  //
  // Nothing here races: --stale-ms is 10 minutes and the waiter is allowed 300ms, so the heartbeat
  // cannot cross the staleness bound inside the wait window whatever the machine is doing.
  writeLock(repo, { pid: process.pid, key: 'slow-but-alive', startedAt: Date.now() - HOUR, heartbeatAt: Date.now() });
  const waited = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(waited.code, 75, 'an hour-old holder whose heartbeat is FRESH is waited for, then reported retry-later');
  ok(!/TAKING OVER/.test(waited.stderr), `...with no takeover anywhere in the report: ${firstLine(waited.stderr)}`);
  ok(/pid \d+ landing "slow-but-alive"/.test(waited.stderr), '...naming the holder it is waiting for');
  ok(existsSync(lockOf(repo)), '...and the lock is left exactly where it is');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration never moved');

  // The mirror image: the same live pid, started seconds ago, but WEDGED — no heartbeat for an hour.
  writeLock(repo, { pid: process.pid, key: 'wedged', startedAt: Date.now(), heartbeatAt: Date.now() - HOUR });
  const taken = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(taken.code, 0, 'a LIVE holder that has not heartbeat for an hour IS taken over, and the land proceeds');
  ok(/TAKING OVER/.test(taken.stderr), `...loudly: ${firstLine(taken.stderr)}`);
  ok(/has not heartbeat/.test(taken.stderr), '...saying it went quiet, not that it died');
  ok(!/is GONE/.test(taken.stderr), '...because its pid is still there');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...and the work really landed (SHA)');
  ok(!existsSync(lockOf(repo)), '...leaving no lock behind');
});

section('the takeover guard re-reads the lock and removes it ONLY if it is still the same one');
await withFixture(({ repo }) => {
  // Between deciding a lock is stale and unlinking it, the holder can release and a THIRD land can take
  // it — and unlinking THAT hands a fourth land a free run into the same integration branch, which is
  // the one overlap this lock exists to prevent. The guard is the re-read, and it is exercised here
  // directly on both owner shapes: no sleeping, no racing processes, nothing timing-dependent.
  const lock = lockOf(repo);
  const decided = { pid: deadPid(), key: 'crashed', startedAt: 1000, heartbeatAt: 1000 };

  writeLock(repo, decided);
  eq(takeoverLock(lock, decided), 'removed', 'the lock the staleness decision was made about is removed');
  ok(!existsSync(lock), '...and is really gone');

  writeLock(repo, { pid: process.pid, key: 'next', startedAt: 2000, heartbeatAt: 2000 });
  eq(takeoverLock(lock, decided), 'changed', 'a lock that changed hands is NOT removed');
  eq(JSON.parse(readOr(lock) || '{}').key, 'next', "...the new holder's lock is left byte-for-byte alone");

  // Same pid, same key, a LATER run of it — startedAt is what tells the two apart.
  writeLock(repo, { ...decided, startedAt: 3000 });
  eq(takeoverLock(lock, decided), 'changed', 'a later run of the same pid and key is a different owner');
  ok(existsSync(lock), '...so its lock survives too');

  // heartbeatAt is deliberately NOT part of the identity: the holder rewrites it at every step boundary,
  // and matching on it would make every stale lock un-takeable the moment it was refreshed once.
  writeLock(repo, { ...decided, heartbeatAt: 9999 });
  eq(takeoverLock(lock, decided), 'removed', 'a refreshed heartbeat does not make it a different owner');

  eq(takeoverLock(lock, decided), 'gone', 'a lock already released reports gone — nothing was taken over');
});

section('the heartbeat refreshes the lock in place, and never writes over one that changed hands');
await withFixture(({ repo }) => {
  // Timestamps seeded in 1970, so "was it refreshed" is a comparison against Date.now() with fifty years
  // of margin rather than a measurement of how long anything took.
  const lock = lockOf(repo);
  const token = { pid: process.pid, key: 'alpha', startedAt: 1000, heartbeatAt: 1000 };

  writeLock(repo, token);
  heartbeat(lock, { ...token });
  const beat = JSON.parse(readOr(lock) || '{}');
  ok(beat.heartbeatAt > 1000, 'the heartbeat moves heartbeatAt forward');
  eq(beat.startedAt, 1000, '...leaving startedAt alone — it dates the holder, not its progress');
  eq(beat.pid, token.pid, '...and the pid');
  eq(beat.key, 'alpha', '...and the key, so the release still recognises its own lock');

  // The other half: a holder that lost the lock must not stamp its identity back over the new one, or
  // the new holder's release would refuse to unlink a lock it no longer recognises — landing would be
  // wedged for the whole repo with nothing left running.
  const other = { pid: deadPid(), key: 'next', startedAt: 2000, heartbeatAt: 2000 };
  writeLock(repo, other);
  heartbeat(lock, { ...token });
  eq(JSON.parse(readOr(lock) || '{}').key, 'next', "a lock that changed hands is NOT written over");
  eq(JSON.parse(readOr(lock) || '{}').heartbeatAt, 2000, '...not even its heartbeat');
});

section('land heartbeats at its step boundaries, and the rewrites keep it the SAME lock');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha', 'beta']);
  const ledger = join(root, 'lock-at-gate.json');
  // The gate runs INSIDE the land, while the lock is held — the one moment the live lock file is
  // readable from outside. By then the holder has heartbeat twice, after COMMIT and after SYNC.
  const gate = gateCmd(root, 'peek', `require('fs').copyFileSync(${JSON.stringify(lockOf(repo))}, ${JSON.stringify(ledger)});\n`);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its gate never runs)');
  const b = land(repo, 'beta', gate);
  eq(b.code, 0, `beta lands, gating the merged state (${firstLine(b.stderr)})`);

  const held = JSON.parse(readOr(ledger) || '{}');
  eq(held.key, 'beta', 'the lock held during the gate names the chain being landed');
  ok(Number.isInteger(held.pid) && held.pid !== process.pid, '...and carries the land process pid, not this one');
  // Acquisition writes startedAt and heartbeatAt from ONE Date.now(), so they are equal until a boundary
  // refreshes one of them. Two git subprocesses (the accept commit and the sync merge) run in between,
  // which is tens of milliseconds of real work against a 1ms clock tick — a lower bound, not a race.
  ok(held.heartbeatAt > held.startedAt,
    `...and a heartbeatAt the COMMIT and SYNC boundaries moved past startedAt (+${held.heartbeatAt - held.startedAt}ms)`);
  // A rewrite that changed pid, startedAt or key would leave `releaseLock` unable to recognise its own
  // lock, and it would outlive the land that made it.
  ok(!existsSync(lockOf(repo)), 'the release still recognises the lock after those rewrites, and removes it');
});

section('land: a land that LOST the lock refuses to merge into integration (75) instead of merging anyway');
await withFixture(({ root, repo }) => {
  // The heartbeat is written at step BOUNDARIES, so the gate — a whole test suite — is the one stretch a
  // takeover can land inside: past --stale-ms a waiter correctly sees an idle lock and steals it while
  // this land is still mid-gate. `heartbeat` then silently no-ops and, unguarded, the merge into the
  // SHARED integration worktree went ahead anyway at exit 0, with the loss reported only in passing on
  // the way out. That is the whole serialization guarantee, lost in the one step that needs it.
  //
  // The gate below IS the takeover, performed deterministically: it overwrites the live lock with a
  // different owner and exits green, at exactly the moment a real steal would land. Nothing sleeps,
  // nothing races, no second process is involved.
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const hostile = { pid: process.pid, key: 'hostile-taker', startedAt: 1000, heartbeatAt: 1000 };
  const gate = gateCmd(root, 'steal',
    `require('fs').writeFileSync(${JSON.stringify(lockOf(repo))}, ${JSON.stringify(`${JSON.stringify(hostile)}\n`)});\n`);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its gate never runs, so nothing is stolen yet)');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 75, 'a land whose lock was taken over DURING the gate exits 75 retry-later, not 0');
  ok(/NO LONGER held/.test(r.stderr), `...saying the lock is gone from under it: ${firstLine(r.stderr)}`);
  ok(/hostile-taker/.test(r.stderr), '...naming who holds it now');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...and INTEGRATION IS UNTOUCHED (the invariant, asserted by SHA)');
  ok(!/land beta/.test(git(intWt, ['log', '--format=%s']).stdout), '...with no landing commit in its log');
  ok(!existsSync(at(intWt, 'beta.txt')), "...and none of beta's work in the integration tree");
  eq(git(intWt, ['status', '--porcelain']).stdout.trim(), '', '...and a clean integration worktree');
  ok(/sync aipg\/int-b1/.test(git(repo, ['log', '--format=%s', 'aipg/b1/beta']).stdout),
    'the chain keeps its synced, gated work, so the retry the exit code asks for has something to land');
  eq(JSON.parse(readOr(lockOf(repo)) || '{}').key, 'hostile-taker', "...and the new holder's lock is left exactly where it is");
});

section('clean --batch clears a DEAD land lock and leaves a live one alone');
await withFixture(({ root, repo }) => {
  batchOf(root, repo, ['alpha']);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'the chain is cleaned first (clean --batch requires it)');

  writeLock(repo, { pid: process.pid, key: 'in-flight', startedAt: Date.now() });
  const live = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(live.code, 0, 'clean --batch still tears the batch down with a lock present');
  ok(existsSync(lockOf(repo)), '...but a LIVE land lock is left exactly where it is');
  ok(/left the land lock/.test(live.stderr), `...saying so: ${firstLine(live.stderr)}`);
  rmSync(lockOf(repo), { force: true });

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'the batch is re-initialised');
  writeLock(repo, { pid: deadPid(), key: 'crashed', startedAt: Date.now() });
  const dead = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(dead.code, 0, 'clean --batch exits 0 with a dead-pid lock');
  ok(!existsSync(lockOf(repo)), '...having removed it');
  ok(/removed a STALE land lock/.test(dead.stderr), `...loudly: ${firstLine(dead.stderr)}`);
});

section('land: --scope-file WARNS about files outside the declared scope and changes no exit code');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const scope = join(root, 'scope-alpha.txt');
  writeFileSync(scope, 'src/a/**\nsrc\\c\\**\n');            // second line as a Windows operator would type it
  stage(chains.alpha, 'src/a/y.js', '// in scope\n');
  stage(chains.alpha, 'src/c/z.js', '// in scope, declared with backslashes\n');
  stage(chains.alpha, 'src/b/x.js', '// out of scope\n');

  const r = land(repo, 'alpha', gate, ['--scope-file', scope]);
  eq(r.code, 0, 'an out-of-scope file is a WARNING, never a failure — merge and gate stay the arbiters');
  eq((r.stderr.match(/AIPG scope:/g) ?? []).length, 1, '...exactly one warning line');
  ok(/AIPG scope: alpha touched src\/b\/x\.js outside its declared scope/.test(r.stderr), `...naming chain and file: ${firstLine(r.stderr)}`);
  ok(!/src\/a\/y\.js/.test(r.stderr), '...and saying nothing about the file that IS in scope');
  ok(!/src\/c\/z\.js/.test(r.stderr), '...including one declared with backslashes, since git names files with forward slashes');
});

section('argv is validated, never coerced');
await withFixture(({ repo }) => {
  const cases = [
    [['init', '--repo', repo], /--batch is required/, 'init without --batch'],
    [['init', '--batch', 'b1'], /--repo is required/, 'init without --repo'],
    [['init', '--repo', 'r', '--batch', 'b1'], /ABSOLUTE/, 'a relative --repo'],
    [['init', '--repo', join(repo, 'nope'), '--batch', 'b1'], /not a git repository/, 'a --repo that is not a repo'],
    [['init', '--repo', repo, '--batch'], /needs a value/, 'a bare --batch (never the string "true")'],
    [['init', '--repo', repo, '--batch', 'b1', '--key', 'x'], /unknown flag/, "another verb's flag"],
    [['init', '--repo', repo, '--batch', 'a/b'], /plain name/, 'a --batch with a slash in it'],
    [['prep', '--repo', repo, '--batch', 'b1'], /--key is required/, 'prep without --key'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a'], /--gate is required/, 'land without --gate'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', '  '], /needs a command/, 'land with a blank --gate'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', 'x', '--wait-ms', 'soon'], /MILLISECONDS/, 'a non-numeric --wait-ms'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', 'x', '--stale-ms', '-1'], /MILLISECONDS/, 'a negative --stale-ms'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', 'x', '--scope-file', 'scope.txt'], /ABSOLUTE/, 'a relative --scope-file'],
    [['clean', '--repo', repo], /exactly one of/, 'clean with neither --key nor --batch'],
    [['clean', '--repo', repo, '--key', 'a', '--batch', 'b'], /exactly one of/, 'clean with both'],
    [['nope', '--repo', repo], /unknown verb/, 'an unknown verb'],
    [[], /no verb given/, 'no arguments at all'],
  ];
  for (const [argv, expected, what] of cases) {
    const r = wt(argv);
    eq(r.code, 1, `${what} exits 1`);
    ok(expected.test(r.stderr), `...saying why: ${firstLine(r.stderr)}`);
  }
});

}
