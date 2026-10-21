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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { HOOK, heartbeat, shellQuote, shellQuoteFor, takeoverLock, worktreeAdminDirs } from '../tools/wt.mjs';
import { foldsCase } from '../tools/trash.mjs';
// Read off the namespace, so a build without the export fails its own assertions instead of the entire file.
import * as wtTool from '../tools/wt.mjs';

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

// Every wt child trashes into an XDG trash inside its own temp root, so no test reaches the real trash.
const DATA_HOME = 'xdg-data';
const trashEnv = (root) => ({ ...process.env, AIPG_TRASH_BACKEND: 'xdg', XDG_DATA_HOME: join(root, DATA_HOME) });
let fixtureRoot = null;

function fixtureEnv() {
  if (!fixtureRoot) throw new Error('wt.test: a wt child must run inside withFixture, so that its trash stays inside the fixture');
  return trashEnv(fixtureRoot);
}

const wt = (argv, opts = {}) => runCli(process.execPath, [SCRIPT, ...argv], { env: fixtureEnv(), ...opts });

const TRASH_STUB = pathToFileURL(join(REPO_ROOT, 'tests/fixtures/trash-stub.mjs')).href;
const GIT_OVERFLOW_STUB = pathToFileURL(join(REPO_ROOT, 'tests/fixtures/git-overflow-stub.mjs')).href;
const GIT_RACE_STUB = pathToFileURL(join(REPO_ROOT, 'tests/fixtures/git-race-stub.mjs')).href;
/** wt with the fixture module `stub` preloaded in place of a module tools/wt.mjs imports. */
const wtStubbed = (stub, argv, env = {}) => runCli(process.execPath, ['--import', stub, SCRIPT, ...argv], { env: { ...fixtureEnv(), ...env } });
const cleanStubbed = (stub, repo, key, env = {}) => wtStubbed(stub, ['clean', '--repo', repo, '--key', key], env);

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

/** The quote character that wt.mjs prints around a path on this platform. */
const Q = process.platform === 'win32' ? '"' : "'";
/** A RegExp from a template, so a pinned pattern carries Q without doubling its other backslashes. */
const rx = (strings, ...values) => new RegExp(String.raw(strings, ...values));

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

/** A repository at `dir` that is not the fixture's, with the identity pinned so its commits work on any box. */
function otherRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'AIPG Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

async function withFixture(fn) {
  const fixture = makeFixture();
  fixtureRoot = fixture.root;
  try {
    await fn(fixture);
  } finally {
    fixtureRoot = null;
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/**
 * Every name under the fixture trash's `files/` whose `.trashinfo` records `original`, in directory order.
 * The info file holds the path percent-encoded, as the trash spec writes it.
 */
function trashedNames(root, original) {
  const trashDir = join(root, DATA_HOME, 'Trash');
  const infoDir = join(trashDir, 'info');
  const names = [];
  if (!existsSync(infoDir)) return names;
  for (const file of readdirSync(infoDir)) {
    const name = file.replace(/\.trashinfo$/, '');
    const recorded = /^Path=(.*)$/m.exec(readFileSync(join(infoDir, file), 'utf8'))?.[1] ?? '';
    if (norm(decodeURIComponent(recorded)) === norm(original) && existsSync(join(trashDir, 'files', name))) names.push(name);
  }
  return names;
}
const trashedName = (root, original) => trashedNames(root, original)[0] ?? '';
const trashedAt = (root, original, ...parts) => join(root, DATA_HOME, 'Trash', 'files', trashedName(root, original), ...parts);

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

/** Commits `file` holding `content` on the branch checked out in `worktree`, and returns the new commit. */
function commitFile(worktree, file, content) {
  stage(worktree, file, content);
  eq(git(worktree, ['commit', '-qm', `add ${file}`]).code, 0, `commit ${file} in ${worktree}`);
  return sha(worktree, 'HEAD');
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
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnv() });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => done({ code, stdout, stderr }));
});

section('the CLI still speaks when its own path goes through a symlink or junction');
{
  // Node resolves the MAIN module through realpath, so comparing `import.meta.url` against the RAW argv[1]
  // makes `invokedDirectly` false through any link. The process then exits 0 having printed nothing, and
  // every loud failure in the file (unknown verb, bad flags, missing args) is bypassed. Twin of the
  // plan-block case (tests/CLAUDE.md §1). No git needed, so it sits above the git gate. Skipped where a link
  // cannot be created (no privilege, no support) rather than failing for the machine.
  const dir = mkdtempSync(join(tmpdir(), 'aipg-wt-link-'));
  const link = join(dir, 'tools');
  let linked = false;
  try {
    symlinkSync(join(REPO_ROOT, 'tools'), link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch { linked = false; }

  if (linked) {
    const viaLink = runCli(process.execPath, [join(link, 'wt.mjs')], { env: trashEnv(dir) });
    eq(viaLink.code, 1, 'no verb through the link exits 1, not a silent 0');
    ok(/no verb given/.test(viaLink.stderr), `...and says why: ${firstLine(viaLink.stderr)}`);
  } else {
    ok(true, 'skipped — this machine cannot create a link');
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

section('filesInTheWay names a file at, inside or above a path a merge writes, and no other');
{
  const filesInTheWay = typeof wtTool.filesInTheWay === 'function' ? wtTool.filesInTheWay : () => [];
  ok(typeof wtTool.filesInTheWay === 'function', 'tools/wt.mjs exports filesInTheWay');
  // `lib` is written as a file over a lib/ directory, and docs/readme.md as a file under a file docs.
  const written = ['cfg/app.json', 'lib', 'docs/readme.md'];
  const files = ['cfg/app.json', 'lib/cache.bin', 'docs', 'docs2/x', 'cfg/other.json', 'Lib/Cache.bin'];
  eq(filesInTheWay(files, written, false).join(','), 'cfg/app.json,lib/cache.bin,docs', 'with case kept: the file at a path, inside one and above one');
  eq(filesInTheWay(files, written, true).join(','), 'cfg/app.json,lib/cache.bin,docs,Lib/Cache.bin', 'with case folded: Lib/Cache.bin as well');
  eq(filesInTheWay([], written, false).length, 0, 'no files: none in the way');
  // ls-files lists a directory that holds its own repository as one entry ending in `/`.
  eq(filesInTheWay(['vendor/lib/', 'vendor/other/'], ['vendor/lib/x.js'], false).join(','), 'vendor/lib/', 'a nested repository entry over a written path, and not its sibling');
  eq(filesInTheWay(['vendor/lib/'], ['vendor/lib'], false).join(','), 'vendor/lib/', '...at a written path');
  eq(filesInTheWay(['vendor/lib/'], ['vendor'], false).join(','), 'vendor/lib/', '...and inside a written path');
}

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

section('a RELATIVE core.hooksPath is refused before any worktree or hook exists');
await withFixture(({ root, repo }) => {
  // Git resolves a relative hooks path inside each worktree, so the hook would guard the integration
  // worktree alone and every prep's self-test would fail with "re-run init".
  git(repo, ['config', 'core.hooksPath', '.husky']);
  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 40, 'init exits 40 on a relative core.hooksPath');
  ok(/core\.hooksPath/.test(r.stderr), `...naming it: ${firstLine(r.stderr)}`);
  ok(!worktreePaths(repo).some((p) => /aipg-int-/.test(p)), '...creating no integration worktree');
  ok(!existsSync(join(root, 'aipg-int-b1')), '...and no folder for one');
  eq(git(repo, ['branch', '--list', 'aipg/int-*']).stdout.trim(), '', '...and no aipg/int-* branch');
  ok(!existsSync(join(repo, '.husky', 'reference-transaction')), '...and no hook written');
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

section("an IGNORED probe file never makes the self-test pop the operator's own stash entry");
await withFixture(({ root, repo }) => {
  // `stash push -u` skips ignored files and exits 0 with no entry made, so a pop keyed on that exit code
  // applied the operator's top stash into the fresh chain worktree and dropped it from the stack.
  writeFileSync(join(repo, '.gitignore'), '.*\n!.gitignore\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'ignore dotfiles']);
  writeFileSync(join(repo, 'a.txt'), 'operator WIP\n');
  eq(git(repo, ['stash', 'push', '-u', '-m', 'operator WIP']).code, 0, 'the operator stashes their own work before init');
  const list = git(repo, ['stash', 'list']).stdout.trim();
  const reflog = git(repo, ['log', '-g', '--format=%H', 'refs/stash']).stdout.trim();
  ok(list !== '' && reflog !== '', '...so refs/stash holds one entry when prep runs');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 — the hook refused the probe although the repo ignores it (${firstLine(r.stderr)})`);
  eq(git(repo, ['stash', 'list']).stdout.trim(), list, "...the operator's stash list is unchanged");
  eq(git(repo, ['log', '-g', '--format=%H', 'refs/stash']).stdout.trim(), reflog, '...and so is the refs/stash reflog');
  eq(git(join(root, 'aipg-alpha'), ['status', '--porcelain', '--ignored']).stdout.trim(), '', '...and the chain worktree is clean, probe included');
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
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-gamma'))), '...and LEAVES the worktree registered');
  ok(/left in place\. .*clean --repo .* --key gamma, which keeps the branch/.test(red.stderr), '...naming the clean --key that removes it');
});

section('a provision past 1 MiB passes, and one KILLED for flooding its output buffer is SAID so, never given a fabricated exit code, with its worktree named as left in place');
await withFixture(({ root, repo }) => {
  // Node caps a child's combined stdout+stderr at 1 MiB unless told otherwise, and a child that exceeds
  // it is KILLED reporting NO exit status — `err.status` is null. Read as `status ?? 1`, that is an exit
  // code nothing observed, indistinguishable from a real failure. The tool must name the overflow. A
  // provision gets a gate's room, which no test can fill, so the stub kills it there.
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const loud = join(root, 'provision-loud.cjs');
  writeFileSync(loud, "process.stdout.write('x'.repeat(2 * 1024 * 1024));\nprocess.exit(0);\n");

  // No firstLine() on these two stderrs: each carries the provision's 2 MiB of output, relayed verbatim.
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'loud', '--provision', `node "${loud}"`]).code, 0, 'a provision that writes 2 MiB and exits 0 keeps prep green');
  eq(wt(['open', '--repo', repo, '--name', 'noisy', '--provision', `node "${loud}"`]).code, 0, '...and keeps open green');

  const r = wtStubbed(GIT_OVERFLOW_STUB, ['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha', '--provision', 'node -e 0'], { AIPG_SHELL_OVERFLOW: '1' });
  eq(r.code, 40, 'a prep whose provision overflows the buffer exits 40');
  ok(/KILLED/.test(r.stderr), `...saying it was killed: ${firstLine(r.stderr)}`);
  ok(/NOT a report that it failed/.test(r.stderr), '...and refusing to call an unobserved exit code a failure');
  ok(/1073741824 bytes/.test(r.stderr), "...naming the gate's limit it hit");
  ok(/left in place\. .*clean --repo .* --key alpha, which keeps the branch/.test(r.stderr), '...and the clean --key that removes the worktree it keeps');
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-alpha'))), '...which stays registered');

  const o = wtStubbed(GIT_OVERFLOW_STUB, ['open', '--repo', repo, '--name', 'feat', '--provision', 'node -e 0'], { AIPG_SHELL_OVERFLOW: '1' });
  eq(o.code, 40, 'an open whose provision overflows the buffer exits 40');
  ok(/KILLED .*left in place\. .*close --repo .* --name feat --discard, which keeps the branch/.test(o.stderr), `...naming the close --discard that removes the worktree it keeps: ${firstLine(o.stderr)}`);
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-feat'))), '...which stays registered');
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

section('init cuts the integration branch from the current branch, and prep the chain branch from the integration branch, when a tag has the same name');
await withFixture(({ repo }) => {
  const older = sha(repo, 'refs/heads/main');
  commitFile(repo, 'n.txt', 'newer\n');
  eq(git(repo, ['tag', 'main', older]).code, 0, 'a tag main names an older commit');
  const initR = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(initR.code, 0, `init with no --base exits 0 (${firstLine(initR.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/main'), '...and cuts aipg/int-b1 from the main branch, not the tag');
  eq(git(repo, ['tag', 'aipg/int-b1', older]).code, 0, 'a tag aipg/int-b1 names an older commit');
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/alpha'), sha(repo, 'refs/heads/aipg/int-b1'), '...and cuts aipg/b1/alpha from the integration branch, not the tag');
});

section('clean moves the worktree to the trash, keeps the branch, and obeys the same byte-equal hook rule');
await withFixture(async ({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  const chain = join(root, 'aipg-alpha');
  const intWt = join(root, 'aipg-int-b1');
  const hook = hookOf(intWt);

  const c1 = wt(['clean', '--repo', repo, '--key', 'alpha']);
  eq(c1.code, 0, `clean --key exits 0 (${firstLine(c1.stderr)})`);
  ok(!worktreePaths(repo).includes(norm(chain)), '...the chain worktree is out of the registry');
  ok(!existsSync(chain), '...and off its path');
  ok(trashedName(root, chain) !== '', '...and in the trash, with a .trashinfo that records its path');
  eq(readOr(trashedAt(root, chain, 'a.txt')), 'one\n', '...holding its files');
  ok(trashedName(root, chain) !== '' && norm(c1.stderr).includes(norm(trashedAt(root, chain))), `...and stderr names the trash location: ${firstLine(c1.stderr)}`);
  ok(/with 0 ignored files/.test(c1.stderr), '...and the count of ignored files that went with it');
  ok(sha(repo, 'refs/heads/aipg/b1/alpha') !== '', '...while its branch is kept');

  const c2 = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(c2.code, 0, `clean --batch exits 0 (${firstLine(c2.stderr)})`);
  ok(!existsSync(intWt), '...the integration worktree is off its path');
  ok(trashedName(root, intWt) !== '', '...and in the trash, with a .trashinfo that records its path');
  ok(!existsSync(hook), '...the byte-equal hook is removed with it');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== '', '...and the integration branch is kept for the user to merge');
});
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const intWt = join(root, 'aipg-int-b1');
  const hook = hookOf(intWt);
  const foreign = `${HOOK}# and then somebody edited it\n`;
  writeFileSync(hook, foreign);

  const r = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 0, 'clean --batch still tears the worktree down with a foreign hook present');
  ok(trashedName(root, intWt) !== '', '...moving it to the trash');
  eq(readFileSync(hook, 'utf8'), foreign, '...and leaves that hook alone');
});

section('clean REFUSES a worktree that still holds unlanded work, instead of moving it to the trash');
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  const chain = join(root, 'aipg-alpha');
  const intWt = join(root, 'aipg-int-b1');
  const hook = hookOf(intWt);

  // The resting state of a finished engine run is accepted work STAGED, never committed
  // (tests/CLAUDE.md §4), so this is what a `clean` fired one step ahead of the land meets.
  writeFileSync(at(chain, 'wip.txt'), 'accepted, not yet landed\n');
  eq(git(chain, ['add', '-A']).code, 0, 'stage work in the chain worktree');

  const refused = wt(['clean', '--repo', repo, '--key', 'alpha']);
  eq(refused.code, 40, 'clean --key exits 40 rather than discarding staged work');
  ok(/land or commit/.test(refused.stderr), `...naming the ways out: ${firstLine(refused.stderr)}`);
  ok(/wip\.txt/.test(refused.stderr), '...listing the unlanded file');
  ok(rx`trash\.mjs${Q} ${Q}.*aipg-alpha${Q}`.test(refused.stderr) && /worktree prune/.test(refused.stderr), '...naming the by-hand trash and prune');
  ok(!/--force/.test(refused.stderr), '...and never prescribing --force');
  ok(worktreePaths(repo).includes(norm(chain)), '...the worktree is still registered');
  eq(readOr(at(chain, 'wip.txt')), 'accepted, not yet landed\n', '...and the work is still on disk');
  eq(trashedName(root, chain), '', '...and nothing went to the trash');

  eq(git(chain, ['commit', '-qm', 'alpha work']).code, 0, 'commit that work');
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key exits 0 once nothing is unlanded');
  ok(!existsSync(chain), '...and removes it, so the guard costs the landed path nothing');
  ok(trashedName(root, chain) !== '', '...into the trash');

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
  const intWt = join(root, 'aipg-int-b1');
  const beta = join(root, 'aipg-beta');
  const hook = hookOf(intWt);

  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'alpha lands and is cleaned');
  ok(trashedName(root, join(root, 'aipg-alpha')) !== '', '...moving alpha to the trash');

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
  ok(trashedName(root, beta) !== '', '...moving beta to the trash');
  eq(wt(['clean', '--repo', repo, '--batch', 'b1']).code, 0, '...after which clean --batch exits 0');
  ok(trashedName(root, intWt) !== '', '...moving the integration worktree to the trash');
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
  ok(trashedName(root, join(alt, 'aipg-alpha')) !== '' && trashedName(root, join(alt, 'aipg-int-b1')) !== '', '...since both worktrees went to the trash');
});

/**
 * `clean --key` exits 40 naming `why`, and the worktree stays registered, on disk and out of the trash.
 * `opts.stub` preloads that fixture module with `opts.env`, and the other opts go to the child.
 * Returns the clean result, or null when the call could not run.
 */
function refusedIntact(root, repo, key, worktree, why, what, opts = {}) {
  const { stub, env, ...spawnOpts } = opts;
  // A regression that deleted the folder on an earlier call would make spawnSync throw and hide every later case.
  if (spawnOpts.cwd && !existsSync(spawnOpts.cwd)) {
    ok(false, `${what}: its working directory ${spawnOpts.cwd} is already gone`);
    return null;
  }
  const r = stub ? cleanStubbed(stub, repo, key, env) : wt(['clean', '--repo', repo, '--key', key], spawnOpts);
  eq(r.code, 40, `${what} exits 40 (${firstLine(r.stderr)})`);
  ok(why.test(r.stderr), `...naming the reason: ${firstLine(r.stderr)}`);
  ok(worktreePaths(repo).includes(norm(worktree)), '...the worktree is still registered');
  eq(readOr(at(worktree, 'a.txt')), 'one\n', '...its files are still on disk');
  eq(trashedName(root, worktree), '', '...and nothing went to the trash');
  return r;
}

section('clean REFUSES a locked, mid-operation, submodule-holding or in-use worktree, and changes nothing');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['held', 'merging', 'picking', 'bisecting', 'sub', 'inuse']);

  eq(git(repo, ['worktree', 'lock', '--reason', 'on a removable drive', chains.held]).code, 0, 'lock one worktree');
  refusedIntact(root, repo, 'held', chains.held, /locked \(on a removable drive\).*worktree unlock/, 'a locked worktree');
  eq(git(repo, ['worktree', 'unlock', chains.held]).code, 0, 'unlock it');
  eq(wt(['clean', '--repo', repo, '--key', 'held']).code, 0, '...after which clean --key exits 0');
  ok(trashedName(root, chains.held) !== '', '...and moves it to the trash');

  // `-s ours --no-commit` leaves MERGE_HEAD over a tree with no change, so only the operation check refuses it.
  writeFileSync(at(repo, 'b.txt'), 'main moved\n');
  eq(git(repo, ['add', '-A']).code, 0, 'stage a commit on main');
  eq(git(repo, ['commit', '-qm', 'main moves']).code, 0, 'main moves past the chain');
  eq(git(chains.merging, ['merge', '-s', 'ours', '--no-commit', '--no-ff', 'main']).code, 0, 'start a merge and stop before its commit');
  eq(git(chains.merging, ['status', '--porcelain']).stdout.trim(), '', '...over a tree that shows no change');
  refusedIntact(root, repo, 'merging', chains.merging, /a merge in progress \(MERGE_HEAD\)/, 'a worktree mid-merge');
  eq(git(chains.merging, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code, 0, '...and its merge is still in progress');

  // A two-commit cherry-pick whose first pick is resolved and committed by hand keeps only sequencer/.
  eq(git(repo, ['switch', '-q', '-c', 'side']).code, 0, 'branch side off main');
  writeFileSync(at(repo, 'p.txt'), 'side\n');
  eq(git(repo, ['add', '-A']).code, 0, 'stage p.txt on side');
  eq(git(repo, ['commit', '-qm', 'side adds p']).code, 0, '...and commit it');
  writeFileSync(at(repo, 'q.txt'), 'side\n');
  eq(git(repo, ['add', '-A']).code, 0, 'stage q.txt on side');
  eq(git(repo, ['commit', '-qm', 'side adds q']).code, 0, '...and commit it');
  eq(git(repo, ['switch', '-q', 'main']).code, 0, 'back to main');
  writeFileSync(at(chains.picking, 'p.txt'), 'chain\n');
  eq(git(chains.picking, ['add', '-A']).code, 0, 'stage a p.txt the first pick conflicts with');
  eq(git(chains.picking, ['commit', '-qm', 'chain adds p']).code, 0, '...and commit it');
  ok(git(chains.picking, ['cherry-pick', 'side~1', 'side']).code !== 0, 'a two-commit cherry-pick stops on its first pick');
  writeFileSync(at(chains.picking, 'p.txt'), 'resolved\n');
  eq(git(chains.picking, ['add', 'p.txt']).code, 0, '...whose conflict is resolved');
  eq(git(chains.picking, ['commit', '-q', '--no-edit']).code, 0, '...and committed by hand');
  eq(git(chains.picking, ['status', '--porcelain']).stdout.trim(), '', '...over a tree that shows no change');
  refusedIntact(root, repo, 'picking', chains.picking, /a cherry-pick or revert sequence in progress \(sequencer\)/, 'a worktree mid-sequence');
  ok(existsSync(abs(git(chains.picking, ['rev-parse', '--git-path', 'sequencer']).stdout.trim(), 'sequencer path')), '...and its sequence state is still there');

  eq(git(chains.bisecting, ['bisect', 'start']).code, 0, 'start a bisect, which changes no file');
  refusedIntact(root, repo, 'bisecting', chains.bisecting, /a bisect in progress \(BISECT_LOG\)/, 'a worktree mid-bisect');

  const source = join(root, 'sub-src');
  otherRepo(source);
  writeFileSync(join(source, 's.txt'), 'sub\n');
  git(source, ['add', '-A']);
  eq(git(source, ['commit', '-qm', 'sub base']).code, 0, 'a repository to add as a submodule');
  const added = git(chains.sub, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source.replace(/\\/g, '/'), 'mod']);
  eq(added.code, 0, `add an initialized submodule (${firstLine(added.stderr)})`);
  eq(git(chains.sub, ['commit', '-qm', 'add submodule']).code, 0, '...and commit it');
  eq(git(chains.sub, ['status', '--porcelain']).stdout.trim(), '', '...leaving a tree that shows no change');
  const modules = git(chains.sub, ['rev-parse', '--git-path', 'modules']).stdout.trim();
  ok(existsSync(abs(modules, 'modules path')), "...and the submodule's git directory inside the worktree's git directory");
  refusedIntact(root, repo, 'sub', chains.sub, /submodule git directories/, 'a worktree holding an initialized submodule');
  ok(existsSync(join(modules, 'mod')), "...and the submodule's git directory is still there");
  // The unlanded-work refusal comes first, so its by-hand removal must trash the submodule git directories too.
  writeFileSync(at(chains.sub, 'wip.txt'), 'unlanded\n');
  const dirtySub = wt(['clean', '--repo', repo, '--key', 'sub']);
  eq(dirtySub.code, 40, `a dirty worktree holding a submodule exits 40 (${firstLine(dirtySub.stderr)})`);
  ok(/land or commit/.test(dirtySub.stderr), '...as unlanded work');
  ok(norm(dirtySub.stderr).includes(`${Q}${norm(modules)}${Q} and then run`), `...whose by-hand trash names the submodule git directories: ${firstLine(dirtySub.stderr)}`);
  rmSync(at(chains.sub, 'wip.txt'), { force: true });
  // The submodule git directories live in the worktree's git directory, which outlives its folder.
  rmSync(chains.sub, { recursive: true, force: true });
  const goneSub = wt(['clean', '--repo', repo, '--key', 'sub']);
  eq(goneSub.code, 40, `a gone folder whose git directory holds a submodule git directory exits 40 (${firstLine(goneSub.stderr)})`);
  ok(/submodule git directories/.test(goneSub.stderr), '...naming them');
  ok(worktreePaths(repo).includes(norm(chains.sub)), '...the worktree is still registered');
  ok(existsSync(join(modules, 'mod')), "...and the submodule's git directory is still there");

  mkdirSync(at(chains.inuse, 'deep'));
  refusedIntact(root, repo, 'inuse', chains.inuse, /working directory .* is inside it/, 'a call from the worktree itself', { cwd: chains.inuse });
  refusedIntact(root, repo, 'inuse', chains.inuse, /working directory .* is inside it/, 'a call from a directory inside the worktree', { cwd: at(chains.inuse, 'deep') });
  // The prune after the move runs in --repo, so a --repo inside the worktree would fail it with the folder already gone.
  const fromRepo = refusedIntact(root, chains.inuse, 'inuse', chains.inuse, /--repo path .* is inside it/, 'a --repo of the worktree itself');
  ok(norm(fromRepo?.stderr ?? '').includes(`--repo ${Q}${norm(repo)}${Q}`), `...naming the main worktree as the --repo to pass: ${firstLine(fromRepo?.stderr)}`);
  refusedIntact(root, at(chains.inuse, 'deep'), 'inuse', chains.inuse, /--repo path .* is inside it/, 'a --repo inside the worktree');
});

section('clean --batch REFUSES a --repo inside the integration worktree, and changes nothing');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha']);
  const hook = hookOf(intWt);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'the chain is cleaned first (clean --batch requires it)');
  ok(trashedName(root, chains.alpha) !== '', '...moving it to the trash');
  writeLock(repo, { pid: deadPid(), key: 'crashed', startedAt: Date.now() });

  const refused = wt(['clean', '--repo', intWt, '--batch', 'b1']);
  eq(refused.code, 40, `clean --batch with --repo set to the integration worktree exits 40 (${firstLine(refused.stderr)})`);
  ok(/--repo path .* is inside it/.test(refused.stderr), `...naming the reason: ${firstLine(refused.stderr)}`);
  ok(norm(refused.stderr).includes(`--repo ${Q}${norm(repo)}${Q}`), '...and the main worktree as the --repo to pass');
  ok(worktreePaths(repo).includes(norm(intWt)), '...the integration worktree is still registered');
  eq(trashedName(root, intWt), '', '...nothing went to the trash');
  eq(readOr(hook), HOOK, '...the hook is still installed');
  ok(existsSync(lockOf(repo)), '...and the dead lock is still in place');

  const fromMain = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(fromMain.code, 0, `...after which clean --batch with the main worktree as --repo exits 0 (${firstLine(fromMain.stderr)})`);
  ok(trashedName(root, intWt) !== '', '...moving the integration worktree to the trash');
  ok(!existsSync(hook), '...removing the hook');
  ok(!existsSync(lockOf(repo)), '...and removing the dead lock');
});

section('clean REFUSES a folder at the registered path that is not that worktree, and changes nothing');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['other', 'plain']);

  // git -C <path> reads whatever repository holds the folder, so a clean tree of another repo passes every git check.
  renameSync(chains.other, `${chains.other}.moved`);
  otherRepo(chains.other);
  writeFileSync(at(chains.other, 'a.txt'), 'one\n');
  eq(git(chains.other, ['add', '-A']).code, 0, 'another repository at the registered path stages a.txt');
  eq(git(chains.other, ['commit', '-qm', 'unrelated']).code, 0, '...and commits it, leaving a clean tree');
  refusedIntact(root, repo, 'other', chains.other, /\.git file does not point at its git directory.*worktree repair/, 'a registered path holding another repository');
  eq(git(chains.other, ['log', '-1', '--format=%s']).stdout.trim(), 'unrelated', '...and that repository is untouched');

  renameSync(chains.plain, `${chains.plain}.moved`);
  mkdirSync(chains.plain);
  writeFileSync(at(chains.plain, 'a.txt'), 'one\n');
  refusedIntact(root, repo, 'plain', chains.plain, /\.git file does not point at its git directory/, 'a registered path holding a folder with no .git');
});

section('clean finds and REFUSES a worktree that a rebase or bisect detached, and clean --batch counts it');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['rebasing', 'bisecting']);
  const hook = hookOf(intWt);
  const detached = (worktree) => git(worktree, ['symbolic-ref', '-q', 'HEAD']).code !== 0;

  // An add/add conflict on c.txt stops the rebase with HEAD detached.
  stage(chains.rebasing, 'c.txt', 'chain\n');
  eq(git(chains.rebasing, ['commit', '-qm', 'chain adds c']).code, 0, 'the chain commits c.txt');
  stage(repo, 'c.txt', 'main\n');
  eq(git(repo, ['commit', '-qm', 'main adds c']).code, 0, 'main commits a different c.txt');
  ok(git(chains.rebasing, ['rebase', 'main']).code !== 0, 'a rebase of the chain onto main stops on the conflict');
  ok(detached(chains.rebasing), '...with HEAD detached');
  refusedIntact(root, repo, 'rebasing', chains.rebasing, /a rebase(?: or am)? in progress \(rebase-(?:merge|apply)\)/, 'a worktree mid-rebase');

  // Three commits past the good one give the bisect a midpoint to check out.
  for (const n of [1, 2, 3]) {
    stage(chains.bisecting, `n${n}.txt`, `${n}\n`);
    eq(git(chains.bisecting, ['commit', '-qm', `n${n}`]).code, 0, `the chain commits n${n}.txt`);
  }
  eq(git(chains.bisecting, ['bisect', 'start', 'HEAD', 'HEAD~3']).code, 0, 'a bisect starts from a bad and a good commit');
  ok(detached(chains.bisecting), '...and checks out a midpoint with HEAD detached');
  refusedIntact(root, repo, 'bisecting', chains.bisecting, /a bisect in progress \(BISECT_LOG\)/, 'a worktree mid-bisect');

  const batch = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(batch.code, 40, `clean --batch exits 40 while both detached chains are registered (${firstLine(batch.stderr)})`);
  ok(batch.stderr.includes('aipg/b1/rebasing') && batch.stderr.includes('aipg/b1/bisecting'), `...naming both: ${firstLine(batch.stderr)}`);
  eq(readOr(hook), HOOK, '...and the shared hook is still installed');
  ok(worktreePaths(repo).includes(norm(intWt)), '...as is the integration worktree');
});

section('a refused trash move leaves the worktree registered and intact, and prunes nothing');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  // A file where the trash needs its files/ directory makes the trash refuse before it moves anything.
  mkdirSync(join(root, DATA_HOME, 'Trash'), { recursive: true });
  writeFileSync(join(root, DATA_HOME, 'Trash', 'files'), 'not a directory\n');
  refusedIntact(root, repo, 'alpha', chains.alpha, /the trash refused.*run this command again.*worktree prune/, 'a refused trash move');
});

section('an unconfirmed trash move and a registration that outlives the prune each exit 40');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['partial', 'unmoved']);

  const partial = cleanStubbed(TRASH_STUB, repo, 'partial', { AIPG_TRASH_STUB: 'unknown' });
  eq(partial.code, 40, `an unknown trash outcome exits 40 (${firstLine(partial.stderr)})`);
  ok(/could not confirm .*Check the trash/.test(partial.stderr), `...naming what to check: ${firstLine(partial.stderr)}`);
  eq(readOr(at(`${chains.partial}.partial`, 'a.txt')), 'one\n', '...after the stub moved the folder aside');
  ok(worktreePaths(repo).includes(norm(chains.partial)), '...and nothing was pruned, so the worktree is still registered');

  const unmoved = cleanStubbed(TRASH_STUB, repo, 'unmoved', { AIPG_TRASH_STUB: 'unmoved' });
  eq(unmoved.code, 40, `a worktree still registered after the prune exits 40 (${firstLine(unmoved.stderr)})`);
  ok(/still registered after "git worktree prune"/.test(unmoved.stderr), `...naming it: ${firstLine(unmoved.stderr)}`);
});

section('a registered worktree whose folder is gone is pruned, unless it is locked');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['gone', 'held']);
  const hook = hookOf(intWt);

  rmSync(chains.gone, { recursive: true, force: true });
  const gone = wt(['clean', '--repo', repo, '--key', 'gone']);
  eq(gone.code, 0, `clean --key exits 0 for a folder already gone (${firstLine(gone.stderr)})`);
  ok(/already gone/.test(gone.stderr), '...saying so');
  ok(!worktreePaths(repo).includes(norm(chains.gone)), '...and its registration is pruned');

  eq(git(repo, ['worktree', 'lock', chains.held]).code, 0, 'lock another worktree');
  rmSync(chains.held, { recursive: true, force: true });
  const held = wt(['clean', '--repo', repo, '--key', 'held']);
  eq(held.code, 40, 'clean --key exits 40 for a gone folder that is locked');
  ok(/worktree unlock/.test(held.stderr), `...naming git worktree unlock: ${firstLine(held.stderr)}`);
  ok(worktreePaths(repo).includes(norm(chains.held)), '...and it stays registered');
  eq(git(repo, ['worktree', 'unlock', chains.held]).code, 0, 'unlock it');
  eq(wt(['clean', '--repo', repo, '--key', 'held']).code, 0, '...after which clean --key prunes it');

  rmSync(intWt, { recursive: true, force: true });
  const batch = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(batch.code, 0, `clean --batch exits 0 for an integration folder already gone (${firstLine(batch.stderr)})`);
  ok(!worktreePaths(repo).includes(norm(intWt)), '...its registration is pruned');
  ok(/left the hook/.test(batch.stderr), '...and it says the hook was left alone');
  eq(readOr(hook), HOOK, '...since the hook path resolves only from a linked worktree');
});

section('clean REFUSES the main worktree when it is on a chain branch');
await withFixture(({ root, repo }) => {
  batchOf(root, repo, ['alpha']);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key removes the chain worktree and keeps its branch');
  eq(git(repo, ['switch', '-q', 'aipg/b1/alpha']).code, 0, 'the main worktree switches to the kept chain branch');
  refusedIntact(root, repo, 'alpha', repo, /main worktree of the repo.*switch <branch>/, 'a clean --key that finds the main worktree');
  ok(existsSync(join(repo, '.git', 'HEAD')), '...and the repository in its .git is intact');
});

section('clean finds a worktree through a --repo typed through a link, and a relative gitdir file from the physical root');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha', 'rel']);
  // Deeper than the repo, so a relative gitdir resolved from the link lands beside the link, not the worktree.
  const link = join(root, 'via', 'repo');
  let linked = false;
  mkdirSync(dirname(link));
  try {
    symlinkSync(repo, link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch { linked = false; }

  if (linked) {
    const r = wt(['clean', '--repo', link, '--key', 'alpha']);
    eq(r.code, 0, `clean --key through the link exits 0 (${firstLine(r.stderr)})`);
    ok(trashedName(root, chains.alpha) !== '', '...and moves the worktree to the trash');

    // git 2.48 writes relative gitdir files under worktree.useRelativePaths. An older git does not support
    // them, so the lookup is called directly rather than through clean.
    const adminDir = abs(git(chains.rel, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'rel git dir');
    writeFileSync(join(adminDir, 'gitdir'), `${relative(adminDir, join(chains.rel, '.git')).replace(/\\/g, '/')}\n`);
    let found = '';
    try {
      found = [...worktreeAdminDirs(link)].find(([dotGit]) => norm(dotGit) === norm(join(chains.rel, '.git')))?.[1] ?? 'no git directory';
    } catch (err) { found = err.message; }
    eq(norm(found), norm(adminDir), 'a relative gitdir file read through the link resolves to the worktree it records');
  } else {
    ok(true, 'skipped, since this machine cannot create a link');
  }
});

section('ignored files go to the trash with the folder, and stderr counts them or says the count is unknown');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  writeFileSync(at(chains.alpha, '.gitignore'), 'build/\n*.log\n');
  eq(git(chains.alpha, ['add', '-A']).code, 0, 'stage a .gitignore');
  eq(git(chains.alpha, ['commit', '-qm', 'ignore build output']).code, 0, '...and commit it');
  mkdirSync(at(chains.alpha, 'build', 'deep'), { recursive: true });
  writeFileSync(at(chains.alpha, 'build', 'out.bin'), 'built\n');
  writeFileSync(at(chains.alpha, 'build', 'deep', 'x.bin'), 'deeper\n');
  writeFileSync(at(chains.alpha, 'notes.log'), 'a log\n');
  eq(git(chains.alpha, ['status', '--porcelain']).stdout.trim(), '', 'the ignored files leave the tree clean');

  const r = wt(['clean', '--repo', repo, '--key', 'alpha']);
  eq(r.code, 0, `clean --key exits 0 (${firstLine(r.stderr)})`);
  ok(/with 3 ignored files/.test(r.stderr), `...counting the ignored files: ${firstLine(r.stderr)}`);
  eq(readOr(trashedAt(root, chains.alpha, 'build', 'deep', 'x.bin')), 'deeper\n', '...which are in the trash with the folder');
  eq(readOr(trashedAt(root, chains.alpha, 'notes.log')), 'a log\n', '...every one of them');
});
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const r = cleanStubbed(GIT_OVERFLOW_STUB, repo, 'alpha', { AIPG_GIT_OVERFLOW: 'ls-files' });
  eq(r.code, 0, `an ignored-file listing that overflows its cap does not block clean (${firstLine(r.stderr)})`);
  ok(/with an uncounted number of ignored files/.test(r.stderr), `...stderr says the count is unknown: ${firstLine(r.stderr)}`);
  ok(trashedName(root, chains.alpha) !== '', '...and the folder is in the trash');
});

section('a status listing that overflows its cap is refused as unlanded work, naming the by-hand removal');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const r = refusedIntact(root, repo, 'alpha', chains.alpha, /has not landed \(its status listing passed the 1 MiB output cap\)/, 'an overflowing status listing',
    { stub: GIT_OVERFLOW_STUB, env: { AIPG_GIT_OVERFLOW: 'status' } });
  ok(rx`trash\.mjs${Q} ${Q}.*${Q} and then run git -C ${Q}.*${Q} worktree prune`.test(r?.stderr ?? ''), `...and names the by-hand trash and prune: ${firstLine(r?.stderr)}`);
});

// --- open and close fixtures --------------------------------------------------------------------

const openIn = (repo, name, extra = []) => wt(['open', '--repo', repo, '--name', name, ...extra]);
const closeIn = (repo, name, into, gate, opts = {}) => wt(['close', '--repo', repo, '--name', name, '--into', into, '--gate', gate], opts);
const discardIn = (repo, name) => wt(['close', '--repo', repo, '--name', name, '--discard']);

/**
 * The worktree path a successful `open` printed. After a failed open it is a throwaway repository beside the
 * fixture's, so the assertions after it fail one at a time and no git call reaches another repository.
 */
function openedPath(r, repo, name) {
  if (r.code === 0) return abs(r.stdout.trim(), `${name} worktree path`);
  const standIn = join(dirname(repo), `failed-open-${name}`);
  otherRepo(standIn);
  return standIn;
}

/** `open` that must exit 0, returning the worktree path it printed. */
function opened(repo, name, extra = []) {
  const r = openIn(repo, name, extra);
  eq(r.code, 0, `open ${name} exits 0 (${firstLine(r.stderr)})`);
  return openedPath(r, repo, name);
}

/** A gate that appends the commit it judged and its working directory to `ledger`, one run per line. */
const ledgerGate = (root, ledger) => gateCmd(root, 'ledger', `const head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
require('fs').appendFileSync(${JSON.stringify(ledger)}, head + ' ' + process.cwd() + '\\n');
`);
const ledgerRuns = (ledger) => readOr(ledger).split('\n').filter(Boolean);

/** Asserts close changed nothing: main and the branch where they were, the worktree registered and out of the trash. */
function unchanged(root, repo, worktree, name, mainAt, branchAt) {
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is untouched');
  eq(sha(repo, `refs/heads/aipg/${name}`), branchAt, `...aipg/${name} is where it was`);
  ok(worktreePaths(repo).includes(norm(worktree)), '...the worktree is still registered');
  eq(trashedName(root, worktree), '', '...and nothing went to the trash');
}

section('open cuts aipg/<name> off a local branch into its own worktree, with no hook and no upstream');
await withFixture(({ root, repo }) => {
  // Under always, git sets an upstream for a branch cut from a local branch unless --no-track says otherwise.
  eq(git(repo, ['config', 'branch.autoSetupMerge', 'always']).code, 0, 'set branch.autoSetupMerge to always');
  const r = openIn(repo, 'feat');
  eq(r.code, 0, `open exits 0 (${firstLine(r.stderr)})`);
  const feat = openedPath(r, repo, 'feat');
  eq(norm(feat), norm(join(root, 'aipg-feat')), '...printing the worktree beside the repo on stdout');
  eq(git(feat, ['symbolic-ref', 'HEAD']).stdout.trim(), 'refs/heads/aipg/feat', '...which has aipg/feat checked out');
  eq(sha(repo, 'refs/heads/aipg/feat'), sha(repo, 'refs/heads/main'), '...cut from the current branch when --base is omitted');
  eq(git(repo, ['config', '--get', 'branch.aipg/feat.merge']).stdout.trim(), '', '...with no upstream, though branch.autoSetupMerge is always');
  // makeFixture keeps any hooks path inside the fixture at .git/hooks.
  ok(!existsSync(join(repo, '.git', 'hooks', 'reference-transaction')), '...and no reference-transaction hook');

  eq(git(repo, ['switch', '-q', '-c', 'dev']).code, 0, 'branch dev off main');
  const devTip = commitFile(repo, 'd.txt', 'dev\n');
  eq(git(repo, ['switch', '-q', 'main']).code, 0, '...and switch back to main');
  eq(openIn(repo, 'fix', ['--base', 'dev']).code, 0, 'open --base dev exits 0');
  eq(sha(repo, 'refs/heads/aipg/fix'), devTip, '...cutting the branch from dev');

  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const far = openIn(repo, 'far', ['--dir', elsewhere]);
  eq(norm(far.stdout.trim()), norm(join(elsewhere, 'aipg-far')), `--dir places the worktree under it (${firstLine(far.stderr)})`);

  const again = openIn(repo, 'feat');
  eq(again.code, 40, 'an existing branch exits 40');
  ok(/already exists.*aipg-feat is on it.*close.*another --name.*branch -D aipg\/feat/.test(again.stderr), `...naming close, another name and the delete: ${firstLine(again.stderr)}`);
  eq(worktreePaths(repo).length, 4, '...adding no worktree');

  const revision = openIn(repo, 'rev', ['--base', 'main~0']);
  eq(revision.code, 40, 'a --base that is a revision, not a local branch, exits 40');
  ok(/not a local branch/.test(revision.stderr), `...saying so: ${firstLine(revision.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/rev'), '', '...and creates no branch');

  const empty = openIn(repo, 'empty', ['--base', '']);
  eq(empty.code, 40, 'an empty --base exits 40');
  ok(/--base "" is not a local branch/.test(empty.stderr), `...saying so: ${firstLine(empty.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/empty'), '', '...and creates no branch');
});
await withFixture(({ repo }) => {
  // git's short name for the current branch is heads/main once a tag shares its name.
  eq(git(repo, ['tag', 'main']).code, 0, 'tag main beside branch main');
  const tagged = openIn(repo, 'tagged');
  eq(tagged.code, 0, `open with no --base exits 0 when a tag shares the current branch's name (${firstLine(tagged.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/tagged'), sha(repo, 'refs/heads/main'), '...cutting from branch main');

  git(repo, ['checkout', '-q', '--detach', 'HEAD']);
  const r = openIn(repo, 'feat');
  eq(r.code, 40, 'open on a detached HEAD with no --base exits 40');
  ok(/DETACHED HEAD/.test(r.stderr), `...naming it: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...and creates no branch');

  git(repo, ['checkout', '-q', '--orphan', 'fresh']);
  const unborn = openIn(repo, 'feat');
  eq(unborn.code, 40, 'open on a branch with no commit yet and no --base exits 40');
  ok(/current branch "fresh" .* has no commit yet/.test(unborn.stderr), `...naming it: ${firstLine(unborn.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...and creates no branch');
});

section('open keeps a worktree whose --provision is red, open and prep refuse a blank one first, and both leave no branch behind when git refuses the path');
await withFixture(({ root, repo }) => {
  const blank = openIn(repo, 'blank', ['--provision', ' ']);
  eq(blank.code, 1, 'open with a blank --provision exits 1');
  ok(/--provision needs a command/.test(blank.stderr), `...saying so: ${firstLine(blank.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/blank'), '', '...before it creates the branch');
  ok(!existsSync(join(root, 'aipg-blank')), '...or the worktree');

  const bad = join(root, 'provision-bad.cjs');
  writeFileSync(bad, 'process.exit(3);\n');
  const red = openIn(repo, 'feat', ['--provision', `node "${bad}"`]);
  eq(red.code, 40, 'a red --provision exits 40');
  ok(/--provision exited 3/.test(red.stderr), `...saying so: ${firstLine(red.stderr)}`);
  ok(/left in place\. .*close --repo .* --name feat --discard, which keeps the branch/.test(red.stderr), '...naming the close --discard that removes it');
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-feat'))), '...and the worktree stays registered');

  // open creates the branch before git checks the path, so a refused add would strand it.
  const busy = join(root, 'aipg-busy');
  mkdirSync(busy);
  writeFileSync(join(busy, 'mine.txt'), 'not a worktree\n');
  const refused = openIn(repo, 'busy');
  eq(refused.code, 40, `open onto a folder already there exits 40 (${firstLine(refused.stderr)})`);
  ok(/aipg-busy' already exists/.test(refused.stderr), "...giving git's reason, not its progress line");
  eq(sha(repo, 'refs/heads/aipg/busy'), '', '...and deletes the branch it created first');
  ok(/The branch aipg\/busy that this call created was deleted/.test(refused.stderr), '...saying it deleted the branch');
  eq(readOr(join(busy, 'mine.txt')), 'not a worktree\n', '...leaving the folder alone');
  renameSync(busy, `${busy}.moved`);
  eq(openIn(repo, 'busy').code, 0, '...so open exits 0 once the folder is moved');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init a batch');
  const blankPrep = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'blank', '--provision', ' ']);
  eq(blankPrep.code, 1, `prep with a blank --provision exits 1 (${firstLine(blankPrep.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/blank'), '', '...before it creates the branch');
  ok(!existsSync(join(root, 'aipg-blank')), '...or the worktree');

  const taken = join(root, 'aipg-alpha');
  mkdirSync(taken);
  writeFileSync(join(taken, 'mine.txt'), 'not a worktree\n');
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 40, 'prep onto a folder already there exits 40');
  eq(sha(repo, 'refs/heads/aipg/b1/alpha'), '', '...and deletes the branch it created first');
  renameSync(taken, `${taken}.moved`);
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 0, '...so prep exits 0 once the folder is moved');

  const nested = openIn(repo, 'b1');
  eq(nested.code, 40, 'open of a name whose branch aipg/b1 the chain branch aipg/b1/alpha blocks exits 40');
  ok(/cannot lock ref 'refs\/heads\/aipg\/b1'/.test(nested.stderr), `...giving git's reason: ${firstLine(nested.stderr)}`);
  ok(!existsSync(join(root, 'aipg-b1')), '...and creates no worktree');
});

section('open and prep leave alone the branch and worktree of another process that creates their branch first');
await withFixture(({ root, repo }) => {
  const mainAt = sha(repo, 'refs/heads/main');
  const raced = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'race'], { AIPG_GIT_RACE: 'branch' });
  eq(raced.code, 40, `open whose branch another process creates during it exits 40 (${firstLine(raced.stderr)})`);
  ok(/a branch named 'aipg\/race' already exists/.test(raced.stderr), "...giving git's reason");
  eq(sha(repo, 'refs/heads/aipg/race'), mainAt, "...and keeps the other process's branch");

  const translated = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'local'], { AIPG_GIT_RACE: 'branch', AIPG_GIT_TRANSLATED: '1' });
  eq(translated.code, 40, `the same race under a git that translates its messages exits 40 (${firstLine(translated.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/local'), mainAt, "...and keeps the other process's branch");

  const held = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'held'], { AIPG_GIT_RACE: 'worktree' });
  eq(held.code, 40, `open whose branch and worktree another process creates during it exits 40 (${firstLine(held.stderr)})`);
  ok(/a branch named 'aipg\/held' already exists/.test(held.stderr) && !/git created the worktree/.test(held.stderr),
    "...giving git's reason, not the other process's worktree as one it created");
  eq(sha(repo, 'refs/heads/aipg/held'), mainAt, "...keeping the other process's branch");
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-held-racer'))), '...and its worktree');

  const locked = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'locked'], { AIPG_GIT_RACE: 'locked' });
  eq(locked.code, 40, `open whose branch another process creates inside git's window between check and create exits 40 (${firstLine(locked.stderr)})`);
  ok(/aipg\/locked\.lock': File exists/.test(locked.stderr), "...giving git's reason");
  eq(sha(repo, 'refs/heads/aipg/locked'), mainAt, "...and keeps the other process's branch");

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init a batch');
  const prepped = wtStubbed(GIT_RACE_STUB, ['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha'], { AIPG_GIT_RACE: 'branch' });
  eq(prepped.code, 40, `prep whose branch another process creates during it exits 40 (${firstLine(prepped.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/alpha'), mainAt, "...and keeps the other process's branch");

  const prepTranslated = wtStubbed(GIT_RACE_STUB, ['prep', '--repo', repo, '--batch', 'b1', '--key', 'beta'], { AIPG_GIT_RACE: 'branch', AIPG_GIT_TRANSLATED: '1' });
  eq(prepTranslated.code, 40, `the same race of prep under a git that translates its messages exits 40 (${firstLine(prepTranslated.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/beta'), mainAt, "...and keeps the other process's branch");
});

section('close fast-forwards the --into branch checked out in the main worktree, trashes the worktree and deletes the branch');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const ledger = join(root, 'gate-runs.txt');
  const gate = ledgerGate(root, ledger);

  const r = closeIn(repo, 'feat', 'main', gate);
  eq(r.code, 0, `close exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, 'main points at the branch tip');
  eq(readOr(at(repo, 'f.txt')), 'feature\n', '...and the main worktree has its file checked out');
  eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...in a clean tree');
  const runs = ledgerRuns(ledger);
  eq(runs.length, 1, 'the gate ran once');
  eq(norm(runs[0] ?? ''), norm(`${tip} ${feat}`), '...in the worktree, on the commit main now points at');
  ok(!worktreePaths(repo).includes(norm(feat)), 'the worktree is no longer registered');
  eq(readOr(trashedAt(root, feat, 'f.txt')), 'feature\n', '...its folder is in the trash');
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...and aipg/feat is deleted');
  eq(norm(r.stdout.trim()), norm(feat), 'stdout carries the removed worktree path');
  ok(r.stderr.includes(`main is at ${tip}`), `stderr names main and its new tip: ${r.stderr.trim().split('\n').pop()}`);

  const again = closeIn(repo, 'feat', 'main', gate);
  eq(again.code, 0, 'a second close exits 0');
  ok(/nothing to close/.test(again.stderr), `...with nothing left to do: ${firstLine(again.stderr)}`);
  eq(ledgerRuns(ledger).length, 1, '...and runs no gate');
});

section('close moves an --into branch checked out nowhere with update-ref, and in either form a moved --into is exit 20 that a second close finishes');
await withFixture(({ root, repo }) => {
  eq(git(repo, ['switch', '-q', '-c', 'side']).code, 0, 'the main worktree switches to side, so main is checked out nowhere');
  const sideTip = commitFile(repo, 's.txt', 'side\n');
  const feat = opened(repo, 'feat', ['--base', 'main']);
  const tip = commitFile(feat, 'f.txt', 'feature\n');

  const r = closeIn(repo, 'feat', 'main', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 0, `close exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, 'main points at the branch tip');
  eq(git(repo, ['reflog', '-1', '--format=%gs', 'refs/heads/main']).stdout.trim(), 'aipg close feat', '...moved by update-ref with its reflog message');
  eq(sha(repo, 'refs/heads/side'), sideTip, '...and side, checked out in the main worktree, is untouched');
  eq(sha(repo, 'refs/heads/aipg/feat'), '', 'aipg/feat is deleted');
  ok(trashedName(root, feat) !== '', '...and the worktree is in the trash');

  const fix = opened(repo, 'fix', ['--base', 'main']);
  const fixTip = commitFile(fix, 'g.txt', 'fix\n');
  eq(git(repo, ['switch', '-q', '-c', 'ahead', 'main']).code, 0, 'branch ahead off main');
  const aheadTip = commitFile(repo, 'n.txt', 'ahead\n');
  eq(git(repo, ['switch', '-q', 'side']).code, 0, '...and switch back to side');
  // The gate moves main to ahead once, standing in for a commit that lands on main while the gate runs.
  const marker = join(root, 'moved-once');
  const mover = gateCmd(root, 'mover', `const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, '');
  require('child_process').execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'branch', '-f', 'main', 'ahead']);
}
`);
  const moved = closeIn(repo, 'fix', 'main', mover);
  eq(moved.code, 20, `a main that moved during the gate exits 20 (${firstLine(moved.stderr)})`);
  ok(/main moved while close ran.*Run close again/.test(moved.stderr), '...saying to run close again');
  unchanged(root, repo, fix, 'fix', aheadTip, fixTip);

  const rerun = closeIn(repo, 'fix', 'main', mover);
  eq(rerun.code, 0, `...and a second close exits 0 (${firstLine(rerun.stderr)})`);
  ok(/rebased aipg\/fix onto main/.test(rerun.stderr), '...rebasing the branch onto the moved main');
  eq(sha(repo, 'refs/heads/main~1'), aheadTip, '...so main holds the commit it moved to with the fix on top');
  eq(git(repo, ['show', 'main:g.txt']).stdout, 'fix\n', "...carrying the fix's file");
  eq(sha(repo, 'refs/heads/aipg/fix'), '', '...and aipg/fix is deleted');
});
await withFixture(({ root, repo }) => {
  const mainOld = sha(repo, 'refs/heads/main');
  commitFile(repo, 'm.txt', 'main\n');
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  // The gate resets main in the main worktree back one commit once, to an ancestor that merge --ff-only accepts.
  const marker = join(root, 'reset-once');
  const resetter = gateCmd(root, 'resetter', `const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, '');
  require('child_process').execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'reset', '-q', '--hard', 'HEAD~1']);
}
`);
  const moved = closeIn(repo, 'feat', 'main', resetter);
  eq(moved.code, 20, `a main checked out in the main worktree and reset to an ancestor during the gate exits 20 (${firstLine(moved.stderr)})`);
  ok(/main moved while close ran.*Run close again/.test(moved.stderr), '...saying to run close again');
  unchanged(root, repo, feat, 'feat', mainOld, tip);

  const rerun = closeIn(repo, 'feat', 'main', resetter);
  eq(rerun.code, 0, `...and a second close exits 0 (${firstLine(rerun.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, '...moving main to the gated tip');
});
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  // The gate commits on main in the main worktree once and leaves a tracked edit there, which a fast-forward refuses.
  const marker = join(root, 'moved-and-edited-once');
  const mover = gateCmd(root, 'mover-editor', `const fs = require('fs');
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, '');
  require('child_process').execFileSync('git', ['-C', ${JSON.stringify(repo)}, 'commit', '-q', '--allow-empty', '-m', 'moved']);
  fs.writeFileSync(${JSON.stringify(join(repo, 'a.txt'))}, 'edited\\n');
}
`);
  const mainOld = sha(repo, 'refs/heads/main');
  const moved = closeIn(repo, 'feat', 'main', mover);
  eq(moved.code, 20, `a main that moved during the gate exits 20 even when its worktree also has a tracked edit (${firstLine(moved.stderr)})`);
  ok(/main moved while close ran/.test(moved.stderr), '...reporting the move, not the edit judged against the old main');
  eq(sha(repo, 'refs/heads/main~1'), mainOld, '...main holds only the commit the gate made');
  unchanged(root, repo, feat, 'feat', sha(repo, 'refs/heads/main'), tip);
  eq(git(repo, ['checkout', '--', 'a.txt']).code, 0, 'revert the edit');
  eq(closeIn(repo, 'feat', 'main', mover).code, 0, '...and a second close exits 0');
});

section('close rebases a branch main moved past and gates the rebased commit, a rebase conflict is exit 20, and a merge commit a rebase would drop is exit 40, each with nothing changed');
await withFixture(({ root, repo }) => {
  const ledger = join(root, 'gate-runs.txt');
  const gate = ledgerGate(root, ledger);
  const feat = opened(repo, 'feat');
  const featOld = commitFile(feat, 'f.txt', 'feature\n');
  const mainOld = commitFile(repo, 'm.txt', 'main\n');

  const r = closeIn(repo, 'feat', 'main', gate);
  eq(r.code, 0, `close exits 0 (${firstLine(r.stderr)})`);
  const merged = sha(repo, 'refs/heads/main');
  eq(sha(repo, 'refs/heads/main~1'), mainOld, 'main is its old tip with the rebased commit on top');
  ok(merged !== featOld, '...which is a new commit, since the rebase rewrote it');
  ok(r.stderr.includes(`rebased aipg/feat onto main: ${featOld} -> ${merged}`), '...reported with the old and new tip');
  eq((ledgerRuns(ledger)[0] ?? '').split(' ')[0], merged, 'the gate judged the exact commit main now points at');
  eq(readOr(at(repo, 'f.txt')) + readOr(at(repo, 'm.txt')), 'feature\nmain\n', 'the main worktree has both files');
  eq(sha(repo, 'refs/heads/aipg/feat'), '', 'aipg/feat is deleted');

  const clash = opened(repo, 'clash');
  const clashTip = commitFile(clash, 'a.txt', 'clash\n');
  const mainTip = commitFile(repo, 'a.txt', 'main edit\n');
  const c = closeIn(repo, 'clash', 'main', gate);
  eq(c.code, 20, `a rebase conflict exits 20 (${firstLine(c.stderr)})`);
  ok(/conflicted \(a\.txt\)/.test(c.stderr), '...naming the conflicted file');
  ok(c.stderr.includes(`back at ${clashTip}`), '...and the tip the branch is back at');
  unchanged(root, repo, clash, 'clash', mainTip, clashTip);
  ok(!existsSync(at(git(clash, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'rebase-merge')), 'the worktree is not mid-rebase');
  eq(git(clash, ['symbolic-ref', 'HEAD']).stdout.trim(), 'refs/heads/aipg/clash', '...it is back on its branch');
  eq(git(clash, ['status', '--porcelain']).stdout.trim(), '', '...in a clean tree');
  eq(ledgerRuns(ledger).length, 1, '...and the gate never ran on it');

  const unlisted = wtStubbed(GIT_OVERFLOW_STUB, ['close', '--repo', repo, '--name', 'clash', '--into', 'main', '--gate', gate],
    { AIPG_GIT_OVERFLOW: 'diff', AIPG_GIT_OVERFLOW_ARG: '--diff-filter=U' });
  eq(unlisted.code, 40, `a rebase conflict whose unmerged files cannot be listed exits 40 (${firstLine(unlisted.stderr)})`);
  ok(/listing its unmerged files failed \(.*KILLED.*\)\. The rebase was aborted, aipg\/clash is back at/.test(unlisted.stderr), '...saying so, after the abort');
  unchanged(root, repo, clash, 'clash', mainTip, clashTip);
  ok(!existsSync(at(git(clash, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'rebase-merge')), '...and the worktree is not mid-rebase');

  // A rebase drops a merge commit, and with it a change made only in that merge.
  const merging = opened(repo, 'merging');
  commitFile(merging, 'use.txt', 'uses api v1\n');
  commitFile(repo, 'api.txt', 'api v2\n');
  eq(git(merging, ['merge', '-q', '--no-edit', 'main']).code, 0, 'merge main into aipg/merging');
  stage(merging, 'use.txt', 'uses api v2\n');
  eq(git(merging, ['commit', '-q', '--amend', '--no-edit']).code, 0, '...and amend a change of its own into the merge commit');
  const mergeTip = sha(merging, 'HEAD');
  const mainLater = commitFile(repo, 'later.txt', 'later\n');
  const dropped = closeIn(repo, 'merging', 'main', gate);
  eq(dropped.code, 40, `a branch holding a merge commit main lacks exits 40 (${firstLine(dropped.stderr)})`);
  ok(dropped.stderr.includes(`aipg/merging holds merge commits main lacks (${mergeTip})`), '...naming the merge commit');
  ok(/drops each one with any change made only in it, so nothing changed\. Rebase aipg\/merging onto main by hand/.test(dropped.stderr), '...why, and the rebase by hand');
  unchanged(root, repo, merging, 'merging', mainLater, mergeTip);
  eq(readOr(at(merging, 'use.txt')), 'uses api v2\n', "...the merge's own change is still in the worktree");
  eq(ledgerRuns(ledger).length, 1, '...and the gate never ran on it');

  // A commit that fails to sign stops the rebase with no unmerged file, so there is no conflict to resolve.
  const failGpg = join(root, 'fail-gpg');
  writeFileSync(failGpg, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const signed = opened(repo, 'signed');
  const signedTip = commitFile(signed, 's.txt', 'signed\n');
  const mainNow = commitFile(repo, 'n.txt', 'main again\n');
  eq(git(repo, ['config', 'commit.gpgSign', 'true']).code, 0, 'every commit is signed...');
  eq(git(repo, ['config', 'gpg.program', failGpg.replace(/\\/g, '/')]).code, 0, '...by a program that fails');
  const stop = closeIn(repo, 'signed', 'main', gate);
  eq(stop.code, 40, `a rebase that stops with no conflicted file exits 40 (${firstLine(stop.stderr)})`);
  ok(/stopped with no conflicted file \(error: gpg failed to sign the data\)\. The rebase was aborted, aipg\/signed is back at/.test(stop.stderr), "...giving git's reason, after the abort");
  unchanged(root, repo, signed, 'signed', mainNow, signedTip);
  eq(git(signed, ['status', '--porcelain']).stdout.trim(), '', '...in a clean tree');
  eq(ledgerRuns(ledger).length, 1, '...and the gate never ran on it');
});

/** Writes `body` as the hook `name` of the fixture repo, and returns its path. */
function hookIn(repo, name, body) {
  const out = git(repo, ['rev-parse', '--git-path', 'hooks']).stdout.trim();
  const dir = isAbsolute(out) ? out : join(repo, out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  return join(dir, name);
}

section("open's checkout and close's rebase and fast-forward give the repo's hooks a gate's output room, a rebase git refuses up front is exit 40 with nothing changed, and a rebase whose hook leaves changes is exit 40 before the gate");
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  // Each run writes 2 MiB, past Node's 1 MiB default child-output cap.
  const loud = `#!/bin/sh\n${JSON.stringify(process.execPath.replace(/\\/g, '/'))} -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'\n`;
  // Both are opened before the hooks exist, so each close below is judged on its own.
  const next = opened(repo, 'next');
  const feat = opened(repo, 'feat');
  const nextTip = commitFile(next, 'n.txt', 'next\n');
  const featOld = commitFile(feat, 'f.txt', 'feature\n');
  for (const name of ['post-checkout', 'post-rewrite', 'post-merge']) hookIn(repo, name, loud);

  const ff = closeIn(repo, 'next', 'main', gate);
  eq(ff.code, 0, `close exits 0 through a fast-forward with no rebase, whose post-merge hook writes 2 MiB (${firstLine(ff.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), nextTip, '...and main points at the branch tip');

  const rebased = closeIn(repo, 'feat', 'main', gate);
  eq(rebased.code, 0, `close exits 0 through a rebase and a fast-forward whose hooks write 2 MiB a run (${firstLine(rebased.stderr)})`);
  eq(sha(repo, 'refs/heads/main~1'), nextTip, '...main holds the rebased commit on top of the first');
  ok(sha(repo, 'refs/heads/main') !== featOld, '...which the rebase rewrote');

  const r = openIn(repo, 'third');
  eq(r.code, 0, `open exits 0 under a post-checkout hook that writes 2 MiB (${firstLine(r.stderr)})`);
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-third'))), '...registering the worktree');
});
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = commitFile(repo, 'm.txt', 'main\n');
  const hook = hookIn(repo, 'pre-rebase', '#!/bin/sh\nexit 1\n');

  const refused = closeIn(repo, 'feat', 'main', gate);
  eq(refused.code, 40, 'a rebase the pre-rebase hook refuses exits 40');
  ok(/git refused to rebase aipg\/feat onto main in .*, so nothing changed: fatal: The pre-rebase hook refused to rebase/.test(refused.stderr), `...giving git's reason: ${firstLine(refused.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  rmSync(hook);
  eq(closeIn(repo, 'feat', 'main', gate).code, 0, '...and close exits 0 once the hook is gone');
});
await withFixture(({ root, repo }) => {
  const ledger = join(root, 'ledger.txt');
  const feat = opened(repo, 'feat');
  const featOld = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = commitFile(repo, 'm.txt', 'main\n');
  hookIn(repo, 'post-rewrite', '#!/bin/sh\necho hooked >> f.txt\n');

  const r = closeIn(repo, 'feat', 'main', ledgerGate(root, ledger));
  eq(r.code, 40, `a rebase whose post-rewrite hook modifies a tracked file exits 40 (${firstLine(r.stderr)})`);
  ok(/the rebase of aipg\/feat onto main left uncommitted changes in .*f\.txt.*so no gate ran and main is untouched/.test(r.stderr), `...naming the rebase and the file, never the gate: ${firstLine(r.stderr)}`);
  ok(r.stderr.includes(`was at ${featOld} before the rebase`), '...and the tip from before the rebase');
  eq(ledgerRuns(ledger).length, 0, '...the gate never ran');
  eq(sha(repo, 'refs/heads/main'), mainAt, '...and main is untouched');
});

section("init's, prep's and open's worktree adds give the post-checkout hook the caller's locale, message catalog and credential prompt setting and a gate's output room");
await withFixture(({ root, repo }) => {
  const log = join(root, 'hook-env.log');
  // A catalog folder that does not exist only turns git's translations off, which no assertion here reads.
  const callerEnv = { ...fixtureEnv(), LC_ALL: 'C.UTF-8', GIT_TERMINAL_PROMPT: '1', GIT_TEXTDOMAINDIR: 'caller-catalog' };
  const seen = 'LC_ALL=[C.UTF-8] GIT_TERMINAL_PROMPT=[1] GIT_TEXTDOMAINDIR=[caller-catalog]';
  // Each run also writes 2 MiB, past Node's 1 MiB default child-output cap.
  hookIn(repo, 'post-checkout', `#!/bin/sh\necho "LC_ALL=[$LC_ALL] GIT_TERMINAL_PROMPT=[$GIT_TERMINAL_PROMPT] GIT_TEXTDOMAINDIR=[$GIT_TEXTDOMAINDIR]" >> "${log.replace(/\\/g, '/')}"\n`
    + `${JSON.stringify(process.execPath.replace(/\\/g, '/'))} -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'\n`);

  const initR = wt(['init', '--repo', repo, '--batch', 'b1'], { env: callerEnv });
  eq(initR.code, 0, `init exits 0 (${firstLine(initR.stderr)})`);
  const prepR = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha'], { env: callerEnv });
  eq(prepR.code, 0, `prep exits 0 (${firstLine(prepR.stderr)})`);
  const openR = wt(['open', '--repo', repo, '--name', 'feat'], { env: callerEnv });
  eq(openR.code, 0, `open exits 0 (${firstLine(openR.stderr)})`);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key alpha exits 0');
  eq(wt(['clean', '--repo', repo, '--batch', 'b1']).code, 0, 'clean --batch b1 exits 0, keeping aipg/int-b1');
  const reuseR = wt(['init', '--repo', repo, '--batch', 'b1'], { env: callerEnv });
  eq(reuseR.code, 0, `init that re-uses aipg/int-b1 exits 0 (${firstLine(reuseR.stderr)})`);
  eq(readOr(log), `${seen}\n`.repeat(4), "...and each add's post-checkout hook saw the caller's LC_ALL, GIT_TEXTDOMAINDIR and GIT_TERMINAL_PROMPT");
});

section('a worktree git created before its post-checkout hook failed is kept and named by open, init and prep, never reported as not created');
await withFixture(({ root, repo }) => {
  const failing = '#!/bin/sh\necho "post-checkout: npm install failed" >&2\nexit 1\n';
  const feat = join(root, 'aipg-feat');
  const intWt = join(root, 'aipg-int-b1');
  let hook = hookIn(repo, 'post-checkout', failing);

  const r = openIn(repo, 'feat');
  eq(r.code, 40, `open whose post-checkout hook fails exits 40 (${firstLine(r.stderr)})`);
  ok(/git created the worktree on aipg\/feat at .*aipg-feat and then exited 1/.test(r.stderr), '...saying git created the worktree');
  ok(r.stderr.includes('post-checkout: npm install failed'), "...relaying the hook's output");
  ok(/close --repo .* --name feat --discard, delete the branch with .*branch -D aipg\/feat, then run open again/.test(r.stderr), '...naming close --discard and the branch delete');
  ok(worktreePaths(repo).includes(norm(feat)), '...and the worktree stays registered');
  eq(sha(repo, 'refs/heads/aipg/feat'), sha(repo, 'refs/heads/main'), '...with its branch kept');
  eq(discardIn(repo, 'feat').code, 0, 'the close --discard it names exits 0');
  eq(git(repo, ['branch', '-D', 'aipg/feat']).code, 0, '...and so does the branch delete');

  const initRed = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(initRed.code, 40, `init whose post-checkout hook fails exits 40 (${firstLine(initRed.stderr)})`);
  ok(/git created the worktree on aipg\/int-b1 .*run init again, which re-uses that worktree/.test(initRed.stderr), '...naming init again');
  ok(worktreePaths(repo).includes(norm(intWt)), '...and the worktree stays registered');
  rmSync(hook);
  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init again exits 0 once the hook is gone');
  eq(readOr(hookOf(intWt)), HOOK, '...and installs the reference-transaction hook');

  hook = hookIn(repo, 'post-checkout', failing);
  const prepRed = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(prepRed.code, 40, `prep whose post-checkout hook fails exits 40 (${firstLine(prepRed.stderr)})`);
  ok(/self-test never ran.*clean --repo .* --key alpha, delete the branch with .*branch -D aipg\/b1\/alpha, then run prep again/.test(prepRed.stderr), '...naming clean --key and the branch delete');
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-alpha'))), '...and the worktree stays registered');
  rmSync(hook);

  const twice = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(twice.code, 40, `a second prep of a key whose branch a worktree holds exits 40 (${firstLine(twice.stderr)})`);
  ok(/a branch named 'aipg\/b1\/alpha' already exists/.test(twice.stderr) && !/git created the worktree/.test(twice.stderr), "...giving git's reason, not a worktree it did not create");
});

section('shellQuoteFor puts a path in double quotes on win32, which cmd.exe, PowerShell and Git Bash run for a path with no $, backtick or UNC prefix');
eq(shellQuoteFor('win32', 'C:\\a b\\c'), '"C:\\a b\\c"', 'a win32 path with a space is one double-quoted word');
eq(shellQuoteFor('win32', "C:\\it's\\x"), '"C:\\it\'s\\x"', '...and an apostrophe in it stays as it is');
eq(shellQuoteFor('win32', 'C:\\x\\$HOME\\`id`'), '"C:\\x\\$HOME\\`id`"', '...and a $ or a backtick in it stays, which PowerShell and Git Bash expand');
eq(shellQuoteFor('win32', ''), '""', '...and an empty path is an empty quoted word');
eq(shellQuoteFor('win32', 'E:\\'), '"E:\\\\"', '...and a trailing backslash, as in a drive root, is doubled so it cannot escape the closing quote');
eq(shellQuoteFor('win32', 'E:\\a\\\\'), '"E:\\a\\\\\\\\"', '...and every trailing backslash is doubled');

section('shellQuoteFor puts a path in single quotes on every other platform and writes each apostrophe in it as a closed quote, a backslash-escaped apostrophe and an opened quote');
for (const platform of ['linux', 'darwin', 'freebsd']) {
  eq(shellQuoteFor(platform, '/a b/c'), "'/a b/c'", `${platform}: a path with a space is one single-quoted word`);
  eq(shellQuoteFor(platform, '/x/$HOME/`id`'), "'/x/$HOME/`id`'", '...and a $ or a backtick in it stays inside the quotes');
  eq(shellQuoteFor(platform, "/it's/x"), "'/it'\\''s/x'", '...and an apostrophe in it closes the quote, escapes the apostrophe and reopens the quote');
  eq(shellQuoteFor(platform, ''), "''", '...and an empty path is an empty quoted word');
  eq(shellQuoteFor(platform, '/a\\'), "'/a\\'", '...and a trailing backslash stays as it is, since sh reads it literally inside single quotes');
}
eq(shellQuote("/it's a/b"), shellQuoteFor(process.platform, "/it's a/b"), 'shellQuote uses the form of the platform that runs the tool');

section('no printed command in tools/wt.mjs wraps a path in double quotes itself instead of passing it through shellQuote');
{
  // Covers every print site at once, including the land refusals that no fixture reaches.
  const DOUBLE_QUOTED_PATH = /(?:git -C|--repo|node|worktree (?:unlock|repair|add)) "\$\{|"\$\{(?:repo|path|mainPath|entry\.path|WT_SCRIPT|TRASH_SCRIPT|t)\}"/;
  const source = readFileSync(SCRIPT, 'utf8');
  ok(DOUBLE_QUOTED_PATH.test('git -C "${repo}" branch -D x') && DOUBLE_QUOTED_PATH.test('node "${WT_SCRIPT}" clean') && DOUBLE_QUOTED_PATH.test('unlock "${path}"'), 'the pattern matches the double-quoted forms the tool printed before');
  ok(!DOUBLE_QUOTED_PATH.test(source), 'tools/wt.mjs prints no command that interpolates a path inside double quotes');
}

section('a path with a space, a $, a backtick and an apostrophe is quoted for the platform in the recovery commands that prep, land and open print');
await withFixture(({ root }) => {
  const odd = join(root, "it's $HOME `id`");
  const failing = '#!/bin/sh\necho "post-checkout: npm install failed" >&2\nexit 1\n';
  const landArgs = ['land', '--repo', odd, '--batch', 'b1', '--key', 'alpha', '--gate', 'true'];
  otherRepo(odd);
  // Pinned inside the fixture, so the hook below never lands in a core.hooksPath inherited from the developer's own config.
  git(odd, ['config', 'core.hooksPath', join(odd, '.git', 'hooks')]);
  writeFileSync(join(odd, 'a.txt'), 'one\n');
  eq(git(odd, ['add', '-A']).code, 0, 'stage a file in the odd-named repo');
  eq(git(odd, ['commit', '-qm', 'base']).code, 0, '...and commit it');

  const lacking = wt(['prep', '--repo', odd, '--batch', 'b1', '--key', 'alpha']);
  eq(lacking.code, 40, `prep with no integration worktree exits 40 (${firstLine(lacking.stderr)})`);
  ok(lacking.stderr.includes(`first run wt.mjs init --repo ${shellQuote(odd)} --batch b1; prep creates nothing`), `...naming the init with the repo path quoted for the platform: ${firstLine(lacking.stderr)}`);

  const landNoInt = wt(landArgs);
  eq(landNoInt.code, 40, `land with no integration worktree exits 40 (${firstLine(landNoInt.stderr)})`);
  ok(landNoInt.stderr.includes(`nothing to land into; first run wt.mjs init --repo ${shellQuote(odd)} --batch b1`), `...naming the init with the repo path quoted for the platform: ${firstLine(landNoInt.stderr)}`);

  eq(wt(['init', '--repo', odd, '--batch', 'b1']).code, 0, 'init the integration worktree');
  const landNoChain = wt(landArgs);
  eq(landNoChain.code, 40, `land with no chain worktree exits 40 (${firstLine(landNoChain.stderr)})`);
  ok(landNoChain.stderr.includes(`first run wt.mjs prep --repo ${shellQuote(odd)} --batch b1 --key alpha, and land only after`), `...naming the prep with the repo path quoted for the platform: ${firstLine(landNoChain.stderr)}`);

  eq(git(odd, ['branch', 'aipg/dup']).code, 0, 'create the branch aipg/dup');
  const dup = openIn(odd, 'dup');
  eq(dup.code, 40, `open of a name whose branch exists exits 40 (${firstLine(dup.stderr)})`);
  ok(dup.stderr.includes(`Pick another --name, or, once its commits are merged or not needed, delete the branch with git -C ${shellQuote(odd)} branch -D aipg/dup.`), `...naming the branch delete with the repo path quoted for the platform: ${firstLine(dup.stderr)}`);

  hookIn(odd, 'post-checkout', failing);
  const openRed = openIn(odd, 'feat');
  eq(openRed.code, 40, `open whose post-checkout hook fails exits 40 (${firstLine(openRed.stderr)})`);
  ok(openRed.stderr.includes(`close --repo ${shellQuote(odd)} --name feat --discard, delete the branch with git -C ${shellQuote(odd)} branch -D aipg/feat, then run open again`), `...naming the close and the branch delete with the repo path quoted for the platform: ${firstLine(openRed.stderr)}`);
});

section('a red gate is exit 30 and a gate that changes the tree, moves the branch or switches off it is exit 40, each with main untouched');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');
  const redGate = gateCmd(root, 'red', 'process.exit(5);\n');

  const red = closeIn(repo, 'feat', 'main', redGate);
  eq(red.code, 30, 'a red gate exits 30');
  ok(red.stderr.includes(`gate exited 5 on ${tip}`), `...naming the commit it judged: ${firstLine(red.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  const dirtying = closeIn(repo, 'feat', 'main', gateCmd(root, 'dirty', "require('fs').writeFileSync('gate-out.txt', 'x\\n');\n"));
  eq(dirtying.code, 40, 'a gate that leaves a file in the worktree exits 40');
  ok(/gate passed but left changes .*gate-out\.txt/.test(dirtying.stderr), `...saying so: ${firstLine(dirtying.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  rmSync(at(feat, 'gate-out.txt'), { force: true });
  const committing = closeIn(repo, 'feat', 'main', gateCmd(root, 'commits', "require('child_process').execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'gate commit']);\n"));
  eq(committing.code, 40, 'a gate that commits on the branch exits 40');
  ok(committing.stderr.includes(`gate passed but moved aipg/feat from ${tip}`), `...saying so: ${firstLine(committing.stderr)}`);
  eq(sha(repo, 'refs/heads/main'), mainAt, '...and main is untouched');
  eq(git(feat, ['reset', '-q', '--hard', tip]).code, 0, 'put the branch back at its tip');

  const detaching = closeIn(repo, 'feat', 'main', gateCmd(root, 'detaches', "require('child_process').execFileSync('git', ['checkout', '-q', '--detach']);\n"));
  eq(detaching.code, 40, 'a gate that switches the worktree off the branch exits 40');
  ok(/gate passed but switched .* off aipg\/feat/.test(detaching.stderr), `...saying so: ${firstLine(detaching.stderr)}`);
  eq(git(feat, ['switch', '-q', 'aipg/feat']).code, 0, 'switch the worktree back');
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  const mainMoved = commitFile(repo, 'm.txt', 'main\n');
  const rebasedRed = closeIn(repo, 'feat', 'main', redGate);
  eq(rebasedRed.code, 30, 'a red gate on a rebased branch exits 30');
  ok(rebasedRed.stderr.includes(`was at ${tip} before the rebase`), `...naming the tip from before the rebase: ${firstLine(rebasedRed.stderr)}`);
  eq(sha(repo, 'refs/heads/main'), mainMoved, '...and main is untouched');
});

section('close REFUSES a dirty worktree, an --into worktree with tracked changes, a call from inside the worktree, and a bad --into');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');
  const gate = gateCmd(root, 'green', GATE_GREEN);

  writeFileSync(at(feat, 'wip.txt'), 'unsaved\n');
  const dirty = closeIn(repo, 'feat', 'main', gate);
  eq(dirty.code, 40, 'a worktree with untracked work exits 40');
  ok(/has not landed \(wip\.txt\), so commit it, or trash the worktree with its uncommitted work with .*close .*--discard, which keeps the branch/.test(dirty.stderr), `...naming the file, a commit and close --discard, never land: ${firstLine(dirty.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  rmSync(at(feat, 'wip.txt'));

  writeFileSync(at(repo, 'a.txt'), 'edited, not committed\n');
  const intoDirty = closeIn(repo, 'feat', 'main', gate);
  eq(intoDirty.code, 40, 'a main worktree with a modified tracked file exits 40');
  ok(/staged or modified tracked files \(a\.txt\)/.test(intoDirty.stderr), `...naming it: ${firstLine(intoDirty.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  eq(readOr(at(repo, 'a.txt')), 'edited, not committed\n', '...and the edit is still there');
  eq(git(repo, ['checkout', '--', 'a.txt']).code, 0, 'revert the edit');

  // A regression that removed the worktree on an earlier call would make spawnSync throw and hide every later case.
  const inside = existsSync(feat) ? closeIn(repo, 'feat', 'main', gate, { cwd: feat }) : { code: -1, stderr: 'the worktree is already gone' };
  eq(inside.code, 40, 'a call from inside the worktree exits 40');
  ok(/working directory .* is inside it/.test(inside.stderr), `...naming it: ${firstLine(inside.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  const nowhere = closeIn(repo, 'feat', 'nope', gate);
  eq(nowhere.code, 40, 'an --into that is no local branch exits 40');
  ok(/--into "nope" is not a local branch/.test(nowhere.stderr), `...saying so: ${firstLine(nowhere.stderr)}`);
  const itself = closeIn(repo, 'feat', 'aipg/feat', gate);
  eq(itself.code, 40, 'an --into that is the branch being closed exits 40');
  ok(/is the branch being closed/.test(itself.stderr), `...saying so: ${firstLine(itself.stderr)}`);
  const empty = closeIn(repo, 'feat', '', gate);
  eq(empty.code, 40, 'an empty --into exits 40');
  ok(/--into "" is not a local branch/.test(empty.stderr), `...saying so: ${firstLine(empty.stderr)}`);
  for (const batchBranch of ['aipg/int-b1', 'aipg/b1/alpha']) {
    eq(git(repo, ['branch', batchBranch]).code, 0, `make the batch branch ${batchBranch}`);
    const r = closeIn(repo, 'feat', batchBranch, gate);
    eq(r.code, 40, `an --into that is the batch branch ${batchBranch} exits 40`);
    ok(/is a branch of a batch, which only land moves/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
    eq(sha(repo, `refs/heads/${batchBranch}`), mainAt, '...and leaves that branch where it was');
  }
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  eq(closeIn(repo, 'feat', 'main', gate).code, 0, 'with every refusal cleared, close exits 0');
});

section('close REFUSES to fast-forward an --into branch that the main worktree is mid-rebase of, and changes nothing');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const mainAt = commitFile(repo, 'm.txt', 'main\n');
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  // The exec fails after the replay, so the rebase stops with HEAD detached and main as the branch it returns to.
  ok(git(repo, ['rebase', '-x', 'exit 1', 'HEAD~1']).code !== 0, 'stop a rebase of main in the main worktree');
  eq(git(repo, ['symbolic-ref', '-q', 'HEAD']).stdout.trim(), '', '...which detached HEAD');

  const r = closeIn(repo, 'feat', 'main', gate);
  eq(r.code, 40, `close exits 40 (${firstLine(r.stderr)})`);
  ok(/cannot fast-forward main in the worktree at .*\. It has a rebase in progress/.test(r.stderr), '...naming the rebase in the main worktree');
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  ok(existsSync(join(repo, '.git', 'rebase-merge')), '...and the rebase is still in progress');

  eq(git(repo, ['rebase', '--abort']).code, 0, 'abort the rebase');
  eq(closeIn(repo, 'feat', 'main', gate).code, 0, '...and close exits 0');
  eq(sha(repo, 'refs/heads/main'), tip, '...moving main to the branch tip');
});

section('close REFUSES an --into branch whose fast-forward would move it under a worktree that does not take it, and changes nothing');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');

  // An update-ref of trunk moves main, which the main worktree has checked out.
  eq(git(repo, ['symbolic-ref', 'refs/heads/trunk', 'refs/heads/main']).code, 0, 'make trunk a symbolic ref to main');
  const symbolic = closeIn(repo, 'feat', 'trunk', gate);
  eq(symbolic.code, 40, `close --into a symbolic branch exits 40 (${firstLine(symbolic.stderr)})`);
  ok(/--into trunk is a symbolic ref to refs\/heads\/main.*Pass the branch it points at as --into/.test(symbolic.stderr), '...naming the branch it points at');
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...and the main worktree shows no change');
  eq(git(repo, ['symbolic-ref', '--delete', 'refs/heads/trunk']).code, 0, 'delete trunk');

  // --force checks main out a second time, so a merge in either worktree moves main under the other.
  const second = join(root, 'second-main');
  eq(git(repo, ['worktree', 'add', '-q', '--force', second, 'main']).code, 0, 'check main out in a second worktree');
  const twice = closeIn(repo, 'feat', 'main', gate);
  eq(twice.code, 40, `close --into a branch checked out in two worktrees exits 40 (${firstLine(twice.stderr)})`);
  ok(/cannot fast-forward main, so it is untouched\. It is checked out in more than one worktree \(.*second-main\)/.test(twice.stderr), '...naming both');
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  eq(git(second, ['status', '--porcelain']).stdout.trim(), '', '...and the second worktree shows no change');

  // git worktree prune keeps a locked worktree, so for a locked one the prune alone is no recovery.
  eq(git(repo, ['worktree', 'lock', '--reason', 'on a removable drive', second]).code, 0, 'lock the second worktree');
  renameSync(second, `${second}.moved`);
  const lockedGone = closeIn(repo, 'feat', 'main', gate);
  eq(lockedGone.code, 40, `close --into a branch held by a locked worktree whose folder is gone exits 40 (${firstLine(lockedGone.stderr)})`);
  ok(rx`second-main, which has it checked out, is gone, and it is locked \(on a removable drive\), so "git worktree prune" keeps it\. .*mount it\. Otherwise run git -C .* worktree unlock ${Q}.*second-main${Q} and git -C .* worktree prune\. Then run close again`.test(lockedGone.stderr),
    '...naming the mount, then the unlock before the prune');
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  eq(git(repo, ['worktree', 'unlock', second]).code, 0, 'unlock the second worktree');

  const gone = closeIn(repo, 'feat', 'main', gate);
  eq(gone.code, 40, `close --into a branch held by a worktree whose folder is gone exits 40 (${firstLine(gone.stderr)})`);
  ok(/The folder of the worktree at .*second-main, which has it checked out, is gone\. Run git -C .* worktree prune/.test(gone.stderr), '...naming the prune');
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  // git -C <path> reads whatever repository holds the folder, so a merge there would land in the other repository.
  otherRepo(second);
  const otherAt = commitFile(second, 'x.txt', 'other\n');
  const foreign = closeIn(repo, 'feat', 'main', gate);
  eq(foreign.code, 40, `close --into a branch held by a worktree whose folder holds another repository exits 40 (${firstLine(foreign.stderr)})`);
  ok(/The \.git file of the worktree at .*second-main, which has it checked out, does not point at its git directory.*worktree repair/.test(foreign.stderr), '...naming the repair');
  unchanged(root, repo, feat, 'feat', mainAt, tip);
  eq(sha(second, 'HEAD'), otherAt, '...and the other repository is untouched');

  renameSync(second, `${second}.other`);
  eq(git(repo, ['worktree', 'prune']).code, 0, 'prune the second worktree');
  eq(closeIn(repo, 'feat', 'main', gate).code, 0, '...and close exits 0');
  eq(sha(repo, 'refs/heads/main'), tip, '...moving main to the branch tip');
});

section('close and close --discard REFUSE a worktree that a detached HEAD or a switch took off its branch, and change nothing');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');
  eq(git(feat, ['checkout', '-q', '--detach']).code, 0, 'detach HEAD in the worktree');
  writeFileSync(at(feat, 'wip.txt'), 'unsaved\n');
  const offBranch = rx`the worktree of aipg\/feat at .*aipg-feat has a detached HEAD checked out, so close leaves it in place\. Keep any commit made on that detached HEAD with git -C ${Q}.*${Q} branch <new-name>\. Switch it back with git -C ${Q}.*${Q} switch aipg\/feat,`;

  const unmerged = closeIn(repo, 'feat', 'main', gate);
  eq(unmerged.code, 40, 'close of a detached worktree whose branch holds commits main lacks exits 40');
  ok(offBranch.test(unmerged.stderr), `...naming the worktree and the switch back: ${firstLine(unmerged.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  const discarded = discardIn(repo, 'feat');
  eq(discarded.code, 40, 'close --discard of a detached worktree exits 40');
  ok(offBranch.test(discarded.stderr), `...naming the switch back: ${firstLine(discarded.stderr)}`);
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  eq(git(repo, ['merge', '-q', '--ff-only', 'aipg/feat']).code, 0, 'main takes the branch by hand');
  const merged = closeIn(repo, 'feat', 'main', gate);
  eq(merged.code, 40, 'close of a detached worktree whose branch main contains exits 40');
  ok(offBranch.test(merged.stderr), `...naming the switch back: ${firstLine(merged.stderr)}`);
  unchanged(root, repo, feat, 'feat', tip, tip);
  eq(readOr(at(feat, 'wip.txt')), 'unsaved\n', '...and the untracked work is still in the worktree');

  eq(git(feat, ['switch', '-q', '-c', 'other']).code, 0, 'switch the worktree to a new branch other');
  eq(git(repo, ['branch', '-D', 'aipg/feat']).code, 0, '...and delete aipg/feat');
  const gone = closeIn(repo, 'feat', 'main', gate);
  eq(gone.code, 40, 'close of a worktree on another branch, with aipg/feat deleted, exits 40');
  ok(rx`has branch other checked out, so close leaves it in place\. Switch it back with git -C ${Q}.*${Q} switch -c aipg\/feat,`.test(gone.stderr), `...naming the switch that recreates the branch: ${firstLine(gone.stderr)}`);
  ok(worktreePaths(repo).includes(norm(feat)), '...keeping the worktree registered');

  eq(git(feat, ['switch', '-q', '-c', 'aipg/feat']).code, 0, 'recreate aipg/feat in the worktree');
  rmSync(at(feat, 'wip.txt'));
  const closed = closeIn(repo, 'feat', 'main', gate);
  eq(closed.code, 0, `...and close exits 0 (${firstLine(closed.stderr)})`);
  ok(trashedName(root, feat) !== '', '...moving the worktree to the trash');
});
await withFixture(({ root, repo }) => {
  // prep names a chain's folder aipg-<key>, as open names its own.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init a batch');
  const chain = abs(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'feat']).stdout.trim(), 'chain worktree path');
  eq(git(chain, ['checkout', '-q', '--detach']).code, 0, 'detach HEAD by hand in the chain worktree aipg-feat');
  const closed = closeIn(repo, 'feat', 'main', gate);
  eq(closed.code, 0, `close --name feat with no aipg/feat exits 0 (${firstLine(closed.stderr)})`);
  ok(/nothing to close/.test(closed.stderr), "...finding nothing to close, never the chain's folder");
  const discarded = discardIn(repo, 'feat');
  eq(discarded.code, 0, `close --name feat --discard exits 0 (${firstLine(discarded.stderr)})`);
  ok(/nothing to discard/.test(discarded.stderr), "...finding nothing to discard, never the chain's folder");
  ok(worktreePaths(repo).includes(norm(chain)), '...the chain worktree stays registered');
  eq(trashedName(root, chain), '', '...and out of the trash');
});
await withFixture(({ root, repo }) => {
  // clean keeps a chain branch, so a cleaned chain of key feat can sit beside a later open of feat.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  eq(git(repo, ['branch', 'aipg/b1/feat']).code, 0, 'a kept chain branch aipg/b1/feat');
  const feat = opened(repo, 'feat');
  const mainAt = sha(repo, 'refs/heads/main');
  eq(git(feat, ['checkout', '-q', '--detach']).code, 0, 'detach HEAD in the worktree of aipg/feat');
  const detachedAt = commitFile(feat, 'x.txt', 'detached\n');
  const either = rx`the worktree at .*aipg-feat has a detached HEAD checked out, and the branches aipg\/feat, aipg\/b1\/feat exist, so it may be the worktree of any of them, and close leaves it in place\. Keep any commit made on that detached HEAD with git -C ${Q}.*${Q} branch <new-name>\. Switch it back to its branch with git -C ${Q}.*${Q} switch <branch>,`;

  const closed = closeIn(repo, 'feat', 'main', gate);
  eq(closed.code, 40, `close of a detached open of feat beside the chain branch aipg/b1/feat exits 40 (${firstLine(closed.stderr)})`);
  ok(either.test(closed.stderr), '...naming the worktree and both branches it may belong to');
  unchanged(root, repo, feat, 'feat', mainAt, mainAt);
  const discarded = discardIn(repo, 'feat');
  eq(discarded.code, 40, `close --discard of the same worktree exits 40 (${firstLine(discarded.stderr)})`);
  ok(either.test(discarded.stderr), '...naming both branches');
  unchanged(root, repo, feat, 'feat', mainAt, mainAt);
  eq(sha(feat, 'HEAD'), detachedAt, '...and the detached commit is still checked out');
});

section('close REFUSES a rebase or fast-forward that would delete an ignored file, or a fast-forward an untracked file is in the way of, and changes nothing');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  // info/exclude lives in the common git directory, so it applies in every worktree of the repo.
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'local.cfg\nout.cfg\n');

  const feat = opened(repo, 'feat');
  const featTip = commitFile(feat, 'f.txt', 'feature\n');
  writeFileSync(at(feat, 'local.cfg'), 'mine\n');
  writeFileSync(at(repo, 'local.cfg'), 'shared\n');
  eq(git(repo, ['add', '-f', 'local.cfg']).code, 0, 'main force-adds the ignored local.cfg');
  eq(git(repo, ['commit', '-qm', 'track local.cfg']).code, 0, '...and commits it');
  const mainAt = sha(repo, 'refs/heads/main');
  const rebase = closeIn(repo, 'feat', 'main', gate);
  eq(rebase.code, 40, "a rebase whose checkout of main would overwrite the worktree's ignored local.cfg exits 40");
  ok(/would delete ignored files .*\(local\.cfg\)/.test(rebase.stderr), `...naming it: ${firstLine(rebase.stderr)}`);
  eq(readOr(at(feat, 'local.cfg')), 'mine\n', '...and the ignored file is intact');
  unchanged(root, repo, feat, 'feat', mainAt, featTip);
  rmSync(at(feat, 'local.cfg'), { force: true });
  eq(closeIn(repo, 'feat', 'main', gate).code, 0, 'with the ignored file moved out, close exits 0');

  const ship = opened(repo, 'ship');
  writeFileSync(at(ship, 'out.cfg'), 'branch\n');
  eq(git(ship, ['add', '-f', 'out.cfg']).code, 0, 'the branch force-adds the ignored out.cfg');
  eq(git(ship, ['commit', '-qm', 'track out.cfg']).code, 0, '...and commits it');
  const shipTip = sha(ship, 'HEAD');
  writeFileSync(at(repo, 'out.cfg'), 'my local copy\n');
  const mainBefore = sha(repo, 'refs/heads/main');
  const ff = closeIn(repo, 'ship', 'main', gate);
  eq(ff.code, 40, "a fast-forward that would overwrite the main worktree's ignored out.cfg exits 40");
  ok(/fast-forward would delete ignored files there .*\(out\.cfg\)/.test(ff.stderr), `...naming it: ${firstLine(ff.stderr)}`);
  eq(readOr(at(repo, 'out.cfg')), 'my local copy\n', '...and the ignored file is intact');
  unchanged(root, repo, ship, 'ship', mainBefore, shipTip);

  const plain = opened(repo, 'plain');
  const plainTip = commitFile(plain, 'p.txt', 'branch\n');
  writeFileSync(at(repo, 'p.txt'), 'my untracked copy\n');
  const blocked = closeIn(repo, 'plain', 'main', gate);
  eq(blocked.code, 40, "a fast-forward that the main worktree's untracked p.txt is in the way of exits 40");
  ok(norm(blocked.stderr).includes(`worktree at ${norm(repo)}`) && /untracked files in the way of the fast-forward \(p\.txt\)/.test(blocked.stderr), `...naming the worktree and the file: ${firstLine(blocked.stderr)}`);
  eq(readOr(at(repo, 'p.txt')), 'my untracked copy\n', '...and the untracked file is intact');
  unchanged(root, repo, plain, 'plain', mainBefore, plainTip);
});
await withFixture(({ root, repo }) => {
  // ls-files lists an ignored directory that holds its own repository as one `dir/` entry, never the files inside it.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'deps/\n');
  const nestedRepo = (base, dir, file) => {
    mkdirSync(at(base, 'deps', dir), { recursive: true });
    eq(git(at(base, 'deps', dir), ['init', '-q']).code, 0, `${base} holds an ignored repository at deps/${dir}`);
    writeFileSync(at(base, 'deps', dir, file), 'my uncommitted edit\n');
  };
  const vendor = (base, dir, file) => {
    mkdirSync(at(base, 'deps', dir), { recursive: true });
    writeFileSync(at(base, 'deps', dir, file), 'vendored\n');
    eq(git(base, ['add', '-f', `deps/${dir}/${file}`]).code, 0, `${base} force-adds the ignored deps/${dir}/${file}`);
    eq(git(base, ['commit', '-qm', `vendor ${dir}`]).code, 0, '...and commits it');
    return sha(base, 'HEAD');
  };

  const feat = opened(repo, 'feat');
  const featTip = commitFile(feat, 'f.txt', 'feature\n');
  nestedRepo(feat, 'lib', 'x.js');
  const mainAt = vendor(repo, 'lib', 'x.js');
  const rebase = closeIn(repo, 'feat', 'main', gate);
  eq(rebase.code, 40, "a rebase whose checkout of main would overwrite a file inside the worktree's ignored repository deps/lib exits 40");
  ok(/would delete ignored files .*\(deps\/lib\/\)/.test(rebase.stderr), `...naming it: ${firstLine(rebase.stderr)}`);
  eq(readOr(at(feat, 'deps', 'lib', 'x.js')), 'my uncommitted edit\n', '...and the file inside it is intact');
  unchanged(root, repo, feat, 'feat', mainAt, featTip);

  const ship = opened(repo, 'ship');
  const shipTip = vendor(ship, 'vend', 'z.js');
  nestedRepo(repo, 'vend', 'z.js');
  const ff = closeIn(repo, 'ship', 'main', gate);
  eq(ff.code, 40, "a fast-forward that would overwrite a file inside the main worktree's ignored repository deps/vend exits 40");
  ok(/fast-forward would delete ignored files there .*\(deps\/vend\/\)/.test(ff.stderr), `...naming it: ${firstLine(ff.stderr)}`);
  eq(readOr(at(repo, 'deps', 'vend', 'z.js')), 'my uncommitted edit\n', '...and the file inside it is intact');
  unchanged(root, repo, ship, 'ship', mainAt, shipTip);
});
await withFixture(({ root, repo }) => {
  // A replay writes each path a branch commit adds, though a later commit deletes it and main never had it.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'cache/\n');
  const feat = opened(repo, 'feat');
  commitFile(feat, 'cache', 'a file for now\n');
  eq(git(feat, ['rm', '-q', 'cache']).code, 0, 'the branch removes the file cache');
  eq(git(feat, ['commit', '-qm', 'drop cache']).code, 0, '...and commits that');
  const featTip = sha(feat, 'HEAD');
  mkdirSync(at(feat, 'cache'));
  writeFileSync(at(feat, 'cache', 'x'), 'mine\n');
  const mainAt = commitFile(repo, 'm.txt', 'main moved\n');
  const replay = closeIn(repo, 'feat', 'main', gate);
  eq(replay.code, 40, "a rebase whose replay of the commit that adds the file cache would delete the worktree's ignored cache/x exits 40");
  ok(/would delete ignored files .*\(cache\/x\)/.test(replay.stderr), `...naming it: ${firstLine(replay.stderr)}`);
  eq(readOr(at(feat, 'cache', 'x')), 'mine\n', '...and the ignored file is intact');
  unchanged(root, repo, feat, 'feat', mainAt, featTip);
});
await withFixture(({ root, repo }) => {
  // A replay writes each path a branch commit modifies, such as the file a modify/delete conflict leaves.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  commitFile(repo, 'p', 'tracked\n');
  const feat = opened(repo, 'feat');
  commitFile(feat, 'p', 'branch edit\n');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'p\n');
  eq(git(feat, ['rm', '-q', '--cached', 'p']).code, 0, 'the branch stops tracking p');
  eq(git(feat, ['commit', '-qm', 'untrack p']).code, 0, '...and commits that');
  const featTip = sha(feat, 'HEAD');
  writeFileSync(at(feat, 'p'), 'mine\n');
  eq(git(repo, ['rm', '-q', 'p']).code, 0, 'main removes p');
  eq(git(repo, ['commit', '-qm', 'drop p']).code, 0, '...and commits that');
  const mainAt = sha(repo, 'refs/heads/main');
  const replay = closeIn(repo, 'feat', 'main', gate);
  eq(replay.code, 40, "a rebase whose replay of the commit that modifies p would delete the worktree's ignored p exits 40");
  ok(/would delete ignored files .*\(p\)/.test(replay.stderr), `...naming it: ${firstLine(replay.stderr)}`);
  eq(readOr(at(feat, 'p')), 'mine\n', '...and the ignored file is intact');
  unchanged(root, repo, feat, 'feat', mainAt, featTip);
});
await withFixture(({ root, repo }) => {
  // Directory rename detection would move the branch's d/new.txt onto the ignored e/new.txt, a path no listing names.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  commitFile(repo, 'd/a.txt', 'a\n');
  commitFile(repo, 'd/b.txt', 'b\n');
  eq(git(repo, ['config', 'merge.directoryRenames', 'true']).code, 0, 'the repo turns on silent directory rename detection');
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'e/new.txt\n');
  const feat = opened(repo, 'feat');
  commitFile(feat, 'd/new.txt', 'branch\n');
  mkdirSync(at(feat, 'e'));
  writeFileSync(at(feat, 'e', 'new.txt'), 'mine\n');
  eq(git(repo, ['mv', 'd', 'e']).code, 0, 'main renames d to e');
  eq(git(repo, ['commit', '-qm', 'rename d']).code, 0, '...and commits that');
  const moved = closeIn(repo, 'feat', 'main', gate);
  eq(moved.code, 0, `close rebases the branch past the rename and merges it (${firstLine(moved.stderr)})`);
  eq(git(repo, ['cat-file', '-e', 'main:d/new.txt']).code, 0, "...with the branch's file at the path its commit gave it");
  ok(git(repo, ['cat-file', '-e', 'main:e/new.txt']).code !== 0, '...and not moved into the renamed directory');
  eq(readOr(trashedAt(root, feat, 'e', 'new.txt')), 'mine\n', "...and the worktree's ignored e/new.txt went to the trash intact");
});
await withFixture(({ root, repo }) => {
  // A listing past the cap hides which names are in the way, so close refuses before the rebase or fast-forward.
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const closeStubbed = (name, env) => wtStubbed(GIT_OVERFLOW_STUB, ['close', '--repo', repo, '--name', name, '--into', 'main', '--gate', gate], env);
  const feat = opened(repo, 'feat');
  const featTip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = commitFile(repo, 'm.txt', 'main moved\n');
  const rebase = closeStubbed('feat', { AIPG_GIT_OVERFLOW: 'ls-files', AIPG_GIT_OVERFLOW_ARG: '--ignored' });
  eq(rebase.code, 40, `a rebase whose ignored-file listing passes the listing cap exits 40 (${firstLine(rebase.stderr)})`);
  ok(/names of the ignored files in .*aipg-feat pass the \d+ MiB listing cap, so close cannot tell which of them are in the way of the rebase or fast-forward/.test(rebase.stderr),
    '...naming the listing and the operation');
  unchanged(root, repo, feat, 'feat', mainAt, featTip);

  const ship = opened(repo, 'ship');
  const shipTip = commitFile(ship, 's.txt', 'ship\n');
  const ff = closeStubbed('ship', { AIPG_GIT_OVERFLOW: 'ls-files' });
  eq(ff.code, 40, `a fast-forward whose untracked-file listing in the main worktree passes the listing cap exits 40 (${firstLine(ff.stderr)})`);
  ok(/names of the untracked files in .* pass the \d+ MiB listing cap, so close cannot tell which of them are in the way of the rebase or fast-forward/.test(ff.stderr),
    '...naming the listing and the operation');
  unchanged(root, repo, ship, 'ship', mainAt, shipTip);
});

section('close removes a branch main already contains with no gate run, and a close stopped after its merge or removal finishes on the next run');
await withFixture(({ root, repo }) => {
  const ledger = join(root, 'gate-runs.txt');
  const gate = ledgerGate(root, ledger);

  const done = opened(repo, 'done');
  commitFile(done, 'd.txt', 'done\n');
  eq(git(repo, ['merge', '-q', '--ff-only', 'aipg/done']).code, 0, 'main takes the branch by hand');
  const merged = closeIn(repo, 'done', 'main', gate);
  eq(merged.code, 0, `close of a merged branch exits 0 (${firstLine(merged.stderr)})`);
  ok(/main already contains aipg\/done.*no gate runs/.test(merged.stderr), '...saying nothing is merged');
  eq(ledgerRuns(ledger).length, 0, '...the gate never ran');
  ok(trashedName(root, done) !== '', '...the worktree is in the trash');
  eq(sha(repo, 'refs/heads/aipg/done'), '', '...and aipg/done is deleted');

  // A file where the trash keeps its files/ directory makes the trash refuse after the merge.
  const half = opened(repo, 'half');
  const halfTip = commitFile(half, 'h.txt', 'half\n');
  const files = join(root, DATA_HOME, 'Trash', 'files');
  const kept = `${files}.kept`;
  mkdirSync(dirname(files), { recursive: true });
  if (existsSync(files)) renameSync(files, kept);
  writeFileSync(files, 'not a directory\n');
  const halfBase = sha(repo, 'refs/heads/main');
  const stopped = closeIn(repo, 'half', 'main', gate);
  eq(stopped.code, 40, `a refused trash move after the merge exits 40 (${firstLine(stopped.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), halfTip, '...after main took the gated commit');
  ok(stopped.stderr.includes(`fast-forwarded main from ${halfBase} to ${halfTip}`), '...which stderr reports before the refusal');
  eq(sha(repo, 'refs/heads/aipg/half'), halfTip, '...with the branch kept');
  ok(worktreePaths(repo).includes(norm(half)), '...and the worktree still registered');
  rmSync(files, { force: true });
  if (existsSync(kept)) renameSync(kept, files);
  const finished = closeIn(repo, 'half', 'main', gate);
  eq(finished.code, 0, `the next close exits 0 (${firstLine(finished.stderr)})`);
  eq(ledgerRuns(ledger).length, 1, '...running no second gate');
  ok(trashedName(root, half) !== '', '...moving the worktree to the trash');
  eq(sha(repo, 'refs/heads/aipg/half'), '', '...and deleting aipg/half');

  const last = opened(repo, 'last');
  commitFile(last, 'l.txt', 'last\n');
  eq(git(repo, ['merge', '-q', '--ff-only', 'aipg/last']).code, 0, 'main takes another branch by hand');
  rmSync(last, { recursive: true, force: true });
  eq(git(repo, ['worktree', 'prune']).code, 0, '...whose worktree is gone and pruned');
  const branchOnly = closeIn(repo, 'last', 'main', gate);
  eq(branchOnly.code, 0, `close of a branch with no worktree that main contains exits 0 (${firstLine(branchOnly.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/last'), '', '...and deletes the branch');

  const gone = opened(repo, 'gone');
  commitFile(gone, 'g.txt', 'gone\n');
  eq(git(repo, ['merge', '-q', '--ff-only', 'aipg/gone']).code, 0, 'main takes a third branch by hand');
  rmSync(gone, { recursive: true, force: true });
  const goneFolder = closeIn(repo, 'gone', 'main', gate);
  eq(goneFolder.code, 0, `close of a registered worktree whose folder is gone, on a branch main contains, exits 0 (${firstLine(goneFolder.stderr)})`);
  ok(!worktreePaths(repo).includes(norm(gone)), '...pruning its registration');
  eq(sha(repo, 'refs/heads/aipg/gone'), '', '...and deleting the branch');

  const stray = opened(repo, 'stray');
  const strayTip = commitFile(stray, 's.txt', 'stray\n');
  rmSync(stray, { recursive: true, force: true });
  const strayFolder = closeIn(repo, 'stray', 'main', gate);
  eq(strayFolder.code, 40, 'close of a registered worktree whose folder is gone, with commits main lacks, exits 40');
  ok(/is gone, so close cannot gate.*worktree prune.*worktree add/.test(strayFolder.stderr), `...naming the prune and the checkout: ${firstLine(strayFolder.stderr)}`);
  ok(worktreePaths(repo).includes(norm(stray)), '...keeping its registration');
  eq(sha(repo, 'refs/heads/aipg/stray'), strayTip, '...and the branch');

  const lost = opened(repo, 'lost');
  const lostTip = commitFile(lost, 'x.txt', 'lost\n');
  rmSync(lost, { recursive: true, force: true });
  eq(git(repo, ['worktree', 'prune']).code, 0, 'a branch with commits main lacks loses its worktree');
  const unmerged = closeIn(repo, 'lost', 'main', gate);
  eq(unmerged.code, 40, 'close of that branch exits 40');
  ok(/holds commits main lacks.*worktree add/.test(unmerged.stderr), `...naming how to check it out: ${firstLine(unmerged.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/lost'), lostTip, '...and keeps the branch');
});

section('close keeps a branch that moved past the gated commit before its delete, and names the move, not --into');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const moved = opened(repo, 'moved');
  const tip = commitFile(moved, 'm.txt', 'moved\n');
  // The fast-forward's post-merge hook commits on the branch after the gate, with the same tree, so the worktree stays clean.
  const hook = hookIn(repo, 'post-merge', `#!/bin/sh
next=$(git commit-tree -p refs/heads/aipg/moved -m late "refs/heads/aipg/moved^{tree}")
git update-ref refs/heads/aipg/moved "$next"
`);
  const r = closeIn(repo, 'moved', 'main', gate);
  rmSync(hook);
  const late = sha(repo, 'refs/heads/aipg/moved');
  eq(r.code, 40, `close exits 40 (${firstLine(r.stderr)})`);
  ok(late !== tip && late !== '', '...after the hook moved aipg/moved past the gated commit');
  ok(r.stderr.includes(`aipg/moved moved from ${tip} to ${late}, so the branch is kept`), '...naming the move');
  ok(/worktree add <folder> aipg\/moved, then run close again, which gates it/.test(r.stderr), '...and the checkout that lets close gate it');
  ok(!/no longer contains/.test(r.stderr), '...never blaming main');
  eq(sha(repo, 'refs/heads/main'), tip, '...main is at the gated commit');
  ok(trashedName(root, moved) !== '', '...and the worktree is in the trash');
});

section('close keeps the worktree and the branch when its fast-forward does not verify, and a second close finishes');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const feat = opened(repo, 'feat');
  const mainAt = sha(repo, 'refs/heads/main');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  // The fast-forward's post-merge hook moves main back, so main is off the gated commit when close verifies it.
  const hook = hookIn(repo, 'post-merge', '#!/bin/sh\ngit reset -q --hard HEAD~1\n');
  const r = closeIn(repo, 'feat', 'main', gate);
  rmSync(hook);
  eq(r.code, 40, `close exits 40 (${firstLine(r.stderr)})`);
  ok(r.stderr.includes(`did not verify, since main is at ${mainAt}. Nothing was removed.`), '...naming where main is and that nothing was removed');
  unchanged(root, repo, feat, 'feat', mainAt, tip);

  const again = closeIn(repo, 'feat', 'main', gate);
  eq(again.code, 0, `a second close exits 0 (${firstLine(again.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, '...and main points at the gated commit');
});

section('close --discard trashes the worktree with its uncommitted work and an unfinished operation, keeps the branch, and still refuses a locked worktree');
await withFixture(({ root, repo }) => {
  const scrap = opened(repo, 'scrap');
  const tip = commitFile(scrap, 's.txt', 'on the branch\n');
  writeFileSync(at(scrap, 'wip.txt'), 'unsaved\n');
  writeFileSync(at(scrap, 'a.txt'), 'edited\n');

  eq(git(repo, ['worktree', 'lock', scrap]).code, 0, 'lock the worktree');
  const locked = discardIn(repo, 'scrap');
  eq(locked.code, 40, 'close --discard of a locked worktree exits 40');
  ok(/locked/.test(locked.stderr), `...naming the lock: ${firstLine(locked.stderr)}`);
  eq(readOr(at(scrap, 'wip.txt')), 'unsaved\n', '...and its work is still on disk');
  eq(git(repo, ['worktree', 'unlock', scrap]).code, 0, 'unlock it');
  eq(git(scrap, ['bisect', 'start']).code, 0, 'start a bisect in it');

  const r = discardIn(repo, 'scrap');
  eq(r.code, 0, `close --discard exits 0 (${firstLine(r.stderr)})`);
  eq(readOr(trashedAt(root, scrap, 'wip.txt')), 'unsaved\n', 'the untracked file is in the trash');
  eq(readOr(trashedAt(root, scrap, 'a.txt')), 'edited\n', '...and so is the modified one');
  ok(/discarded the uncommitted work it held: .*a\.txt/.test(r.stderr) && /discarded the uncommitted work it held: .*wip\.txt/.test(r.stderr), 'stderr lists that work');
  ok(/discarded a bisect in progress, whose state \(BISECT_LOG\) the prune deletes\n/.test(r.stderr), '...and the bisect whose state the prune deletes, which left HEAD on the branch');
  ok(r.stderr.includes(`kept branch aipg/scrap at ${tip}`) && r.stderr.includes('branch -D aipg/scrap'), '...and names the kept tip and the command that deletes it');
  eq(sha(repo, 'refs/heads/aipg/scrap'), tip, 'the branch is kept');
  ok(!worktreePaths(repo).includes(norm(scrap)), 'the worktree is no longer registered');
  eq(norm(r.stdout.trim()), norm(scrap), 'stdout carries the removed worktree path');

  const none = discardIn(repo, 'scrap');
  eq(none.code, 0, `close --discard with no worktree left exits 0 (${firstLine(none.stderr)})`);
  ok(/nothing to discard/.test(none.stderr) && none.stderr.includes(`kept branch aipg/scrap at ${tip}`), '...saying so and naming the kept branch');
  eq(none.stdout, '', '...with nothing on stdout');

  // The exec fails after the replay, so the rebase stops with HEAD detached, and a commit made there is on no branch.
  const stop = opened(repo, 'stop');
  const stopTip = commitFile(stop, 'x.txt', 'x\n');
  ok(git(stop, ['rebase', '-x', 'exit 1', 'HEAD~1']).code !== 0, 'stop a rebase of aipg/stop in its worktree');
  const during = commitFile(stop, 'during.txt', 'made during the rebase\n');
  const mid = discardIn(repo, 'stop');
  eq(mid.code, 0, `close --discard of a worktree mid-rebase exits 0 (${firstLine(mid.stderr)})`);
  ok(mid.stderr.includes(`discarded a rebase in progress, whose state (rebase-merge) the prune deletes. Its detached HEAD was ${during}`), '...naming the detached HEAD');
  ok(new RegExp(`To recover a commit made during it before git gc expires it, run git -C .* branch <name> ${during}\n`).test(mid.stderr), '...and the command that recovers it');
  eq(git(repo, ['cat-file', '-t', during]).stdout.trim(), 'commit', '...which the commit is still there for');
  eq(sha(repo, 'refs/heads/aipg/stop'), stopTip, '...and the branch is kept at its tip');
});

section('where the file system folds case, a branch name given in another case is refused before anything changes');
if (!foldsCase(process.platform)) {
  ok(true, 'skipped, since this file system tells branch names apart by case');
} else {
  await withFixture(({ root, repo }) => {
    const gate = gateCmd(root, 'green', GATE_GREEN);
    const feat = opened(repo, 'feat');
    const tip = commitFile(feat, 'f.txt', 'feature\n');
    const mainAt = sha(repo, 'refs/heads/main');
    // A loose ref is a file, so git finds refs/heads/Main as the file of branch main.
    const refused = [
      [closeIn(repo, 'feat', 'Main', gate), /--into "Main" names branch main in another case, so pass --into main/, 'close --into Main'],
      [closeIn(repo, 'feat', 'AIPG/feat', gate), /--into "AIPG\/feat" names branch aipg\/feat in another case/, 'close --into AIPG/feat'],
      [closeIn(repo, 'FEAT', 'main', gate), /--name "FEAT" gives branch aipg\/FEAT, which this file system finds as branch aipg\/feat/, 'close --name FEAT'],
      [discardIn(repo, 'FEAT'), /--name "FEAT" gives branch aipg\/FEAT, which this file system finds as branch aipg\/feat/, 'close --name FEAT --discard'],
      [openIn(repo, 'FEAT'), rx`branch aipg\/feat already exists .*does not tell apart from aipg\/FEAT.*Pick another --name, or, once its commits are merged or not needed, delete the branch with git -C ${Q}.*${Q} branch -D aipg\/feat\.`, 'open --name FEAT'],
      [openIn(repo, 'other', ['--base', 'MAIN']), /--base "MAIN" names branch main in another case, so pass --base main/, 'open --base MAIN'],
    ];
    for (const [r, expected, what] of refused) {
      eq(r.code, 40, `${what} exits 40`);
      ok(expected.test(r.stderr), `...saying why: ${firstLine(r.stderr)}`);
    }
    unchanged(root, repo, feat, 'feat', mainAt, tip);
    eq(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).stdout.trim().split('\n').join(','), 'refs/heads/aipg/feat,refs/heads/main', '...no branch was added or renamed');
    eq(worktreePaths(repo).length, 2, '...and no worktree was added');

    // git accepts the checkout and writes HEAD as refs/heads/Main, which reads the loose ref file of main.
    eq(git(repo, ['checkout', '-q', 'Main']).code, 0, 'check main out in the main worktree as Main');
    const variant = closeIn(repo, 'feat', 'main', gate);
    eq(variant.code, 40, `close --into main while a worktree has it checked out as Main exits 40 (${firstLine(variant.stderr)})`);
    ok(/has it checked out as Main, which names the same branch\..*switch main/.test(variant.stderr), '...naming the worktree and the switch');
    unchanged(root, repo, feat, 'feat', mainAt, tip);
    eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...and the main worktree shows no change');
    eq(git(repo, ['checkout', '-q', 'main']).code, 0, 'check main out as main');

    eq(closeIn(repo, 'feat', 'main', gate).code, 0, "close in git's own spelling exits 0");
  });
}

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
  // orchestrator moves on (exit 10 is documented as "not an error") and that work never reaches
  // integration, with no error anywhere.
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

section('land: unaccepted work that a sync would touch is exit 40, not a conflict — and nothing is aborted');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'beta.txt', 'beta\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands, so the sync into beta now touches a.txt');

  // UNSTAGED — so it survives the index-only accept commit, and the land refuses before any sync.
  writeFileSync(at(chains.beta, 'a.txt'), 'unaccepted local edit\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'unaccepted work over an overlapping sync exits 40, NOT 20');
  ok(/NOT accepted/.test(r.stderr), `...naming the refusal: ${firstLine(r.stderr)}`);
  ok(/a\.txt/.test(r.stderr), '...and the file that holds the unaccepted work');
  ok(!/no merge to abort/.test(r.stderr), '...with no "there is no merge to abort" fatal');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  eq(readOr(at(chains.beta, 'a.txt')), 'unaccepted local edit\n', '...and the unaccepted edit is still there, untouched');
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: unaccepted work the sync never touches is still exit 40 — the gate would judge what does not land');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'needs-fixed', "if (!require('fs').readFileSync('a.txt', 'utf8').includes('fixed')) process.exit(1);\n");
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip), so beta must sync and gate');

  // The gate passes only because of the UNSTAGED edit, which the land would never carry into integration.
  stage(chains.beta, 'b.txt', 'accepted\n');
  writeFileSync(at(chains.beta, 'a.txt'), 'fixed, but never accepted\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'a staged b.txt beside an unstaged a.txt edit exits 40, never 0');
  ok(/NOT accepted/.test(r.stderr) && /a\.txt/.test(r.stderr), `...naming the unaccepted file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  eq(readOr(at(intWt, 'a.txt')), 'one\n', "...and integration's a.txt never read as fixed");
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');

  eq(git(chains.beta, ['checkout', '--', 'a.txt']).code, 0, 'the operator discards the unaccepted edit');
  const again = land(repo, 'beta', gate);
  eq(again.code, 30, `land again judges only the accepted work, and the gate is red on it (${firstLine(again.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...so integration is still untouched');
});

section('land: an UNTRACKED unaccepted file is exit 40 even when status.showUntrackedFiles is no');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'needs-c', "if (!require('fs').existsSync('c.txt')) process.exit(1);\n");
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  eq(land(repo, 'alpha', gateCmd(root, 'green', GATE_GREEN)).code, 0, 'alpha lands first, so beta must sync and gate');

  // The repo config reaches every worktree, and it hides untracked files from a plain `git status`.
  eq(git(repo, ['config', 'status.showUntrackedFiles', 'no']).code, 0, 'the operator hides untracked files');
  stage(chains.beta, 'b.txt', 'accepted\n');
  writeFileSync(at(chains.beta, 'c.txt'), 'never accepted\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'a staged b.txt beside an untracked c.txt exits 40, never 0');
  ok(/NOT accepted/.test(r.stderr) && /c\.txt/.test(r.stderr), `...naming the untracked file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  ok(!existsSync(at(intWt, 'c.txt')), '...and integration never received c.txt');
  eq(readOr(at(chains.beta, 'c.txt')), 'never accepted\n', '...while the untracked file stays in the chain');
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

  // develop-cycle's passed-but-unstaged halt: the work is GOOD and one `git add` fixes it. Reporting 10
  // here would let the orchestrator move on, and that work would never land.
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
  const { intWt, chains } = batchOf(root, repo, ['alpha']);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'the chain is cleaned first (clean --batch requires it)');
  ok(trashedName(root, chains.alpha) !== '', '...moving it to the trash');

  writeLock(repo, { pid: process.pid, key: 'in-flight', startedAt: Date.now() });
  const live = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(live.code, 0, 'clean --batch still tears the batch down with a lock present');
  eq(trashedNames(root, intWt).length, 1, '...moving the integration worktree to the trash');
  ok(existsSync(lockOf(repo)), '...but a LIVE land lock is left exactly where it is');
  ok(/left the land lock/.test(live.stderr), `...saying so: ${firstLine(live.stderr)}`);
  rmSync(lockOf(repo), { force: true });

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'the batch is re-initialised');
  writeLock(repo, { pid: deadPid(), key: 'crashed', startedAt: Date.now() });
  const stray = join(intWt, 'stray.txt');
  writeFileSync(stray, 'not landed\n');
  const refused = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(refused.code, 40, `clean --batch exits 40 for an integration worktree with untracked work (${firstLine(refused.stderr)})`);
  ok(existsSync(lockOf(repo)), '...and leaves the dead lock in place, since a refused clean changes nothing');
  rmSync(stray);
  const dead = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(dead.code, 0, 'clean --batch exits 0 with a dead-pid lock');
  eq(trashedNames(root, intWt).length, 2, '...moving the re-initialised integration worktree to the trash beside the first');
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
    [['open', '--repo', repo], /--name is required/, 'open without --name'],
    [['open', '--repo', repo, '--name', 'int-x'], /starts with "int-"/, 'open with an int- name'],
    [['open', '--repo', repo, '--name', 'INT-x'], /starts with "INT-", and aipg\/int-<x> in any case/, 'open with an INT- name'],
    [['close', '--repo', repo, '--name', 'x'], /exactly one of --into/, 'close with neither --into nor --discard'],
    [['close', '--repo', repo, '--name', 'x', '--into', 'main', '--gate', 'g', '--discard'], /exactly one of --into/, 'close with both --into and --discard'],
    [['close', '--repo', repo, '--name', 'x', '--discard', '--gate', 'g'], /takes no --gate/, 'close --discard with --gate'],
    [['close', '--repo', repo, '--name', 'x', '--into', 'main'], /--gate is required/, 'close --into without --gate'],
    [['close', '--repo', repo, '--name', 'x', '--discard', 'yes'], /unexpected argument/, 'a value after the --discard switch'],
    [['close', '--repo', repo, '--name', 'int-x', '--discard'], /starts with "int-"/, 'close with an int- name'],
    [['nope', '--repo', repo], /unknown verb/, 'an unknown verb'],
    [['constructor'], /unknown verb "constructor"/, 'a bare verb named constructor'],
    [['__proto__'], /unknown verb "__proto__"/, 'a bare verb named __proto__'],
    [['constructor', '--repo', repo], /unknown verb "constructor"/, 'a verb named constructor with a flag'],
    [['__proto__', '--repo', repo], /unknown verb "__proto__"/, 'a verb named __proto__ with a flag'],
    [[], /no verb given/, 'no arguments at all'],
  ];
  for (const [argv, expected, what] of cases) {
    const r = wt(argv);
    eq(r.code, 1, `${what} exits 1`);
    ok(expected.test(r.stderr), `...saying why: ${firstLine(r.stderr)}`);
  }
});

}
