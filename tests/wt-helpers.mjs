// Fixtures for the tests/wt-*.test.mjs files, which drive tools/wt.mjs as a child process against REAL git in throwaway repos.
//
// Fixtures live under mkdtemp(os.tmpdir(), 'aipg-wt-') and NEVER under REPO_ROOT: static.test.mjs
// CR-scans the checkout and core.autocrlf=true on a Windows box puts CR bytes into checked-out fixture
// files, and a stray fixture would also dirty the tree the build's own clean-baseline check reads.
// Every fixture is removed in `finally`, on pass and on fail alike — worktrees included, since they are
// created inside the same temp root.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, ok, eq } from './harness.mjs';

export const SCRIPT = join(REPO_ROOT, 'tools/wt.mjs');

// Raised above spawnSync's own 1 MiB default for one scenario: the loud-gate case relays megabytes of the
// gate's output through wt's stderr, and at the default THIS harness is what dies (`r.error`), never
// reaching the assertion.
const CAPTURE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Returns { code, stdout, stderr } — never throws, so a nonzero exit is an assertable value.
 *
 * spawnSync, not execFileSync: execFileSync surfaces stderr only through the exception it throws, so a
 * SUCCESSFUL run's stderr is unreachable — and stderr is where this tool writes everything a human reads
 * (`sync skipped`, `TAKING OVER`, every `AIPG scope:` warning). Asserted through execFileSync, those
 * lines all read as absent on the exit-0 paths that are the only place they appear.
 */
export function runCli(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', maxBuffer: CAPTURE_MAX_BUFFER, ...opts });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

// Every wt child trashes into an XDG trash inside its own temp root, so no test reaches the real trash.
export const DATA_HOME = 'xdg-data';
export const trashEnv = (root) => ({ ...process.env, AIPG_TRASH_BACKEND: 'xdg', XDG_DATA_HOME: join(root, DATA_HOME) });
let fixtureRoot = null;

export function fixtureEnv() {
  if (!fixtureRoot) throw new Error('wt-helpers: a wt child must run inside withFixture, so that its trash stays inside the fixture');
  return trashEnv(fixtureRoot);
}

export const wt = (argv, opts = {}) => runCli(process.execPath, [SCRIPT, ...argv], { env: fixtureEnv(), ...opts });

export const TRASH_STUB = pathToFileURL(join(REPO_ROOT, 'tests/fixtures/trash-stub.mjs')).href;
export const GIT_OVERFLOW_STUB = pathToFileURL(join(REPO_ROOT, 'tests/fixtures/git-overflow-stub.mjs')).href;
export const GIT_RACE_STUB = pathToFileURL(join(REPO_ROOT, 'tests/fixtures/git-race-stub.mjs')).href;
/** wt with the fixture module `stub` preloaded in place of a module tools/wt.mjs imports. */
export const wtStubbed = (stub, argv, env = {}) => runCli(process.execPath, ['--import', stub, SCRIPT, ...argv], { env: { ...fixtureEnv(), ...env } });
export const cleanStubbed = (stub, repo, key, env = {}) => wtStubbed(stub, ['clean', '--repo', repo, '--key', key], env);

/**
 * Every path the wt test files touch is absolute. A path read out of a failed command's stdout is empty, and an
 * empty path resolves against the checkout, so a git call aimed at it would change the developer's own tree.
 * Throwing kills the file, and run.mjs reports it.
 */
export function abs(path, what) {
  if (!path || !isAbsolute(path)) throw new Error(`wt-helpers: refusing to use a non-absolute ${what}: ${JSON.stringify(path)} — the command that produced it failed`);
  return path;
}
export const at = (base, ...parts) => join(abs(base, 'base path'), ...parts);
export const git = (cwd, args) => runCli('git', ['-C', abs(cwd, 'git cwd'), ...args]);

/** The same directory can be spelled with either separator and either case on Windows. */
export const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
export const firstLine = (s) => String(s ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';

/** The quote character that wt.mjs prints around a path on this platform. */
export const Q = process.platform === 'win32' ? '"' : "'";
/** A RegExp from a template, so a pinned pattern carries Q without doubling its other backslashes. */
export const rx = (strings, ...values) => new RegExp(String.raw(strings, ...values));

/** '' for a missing file: an assertion about content that a regression DELETED must fail, not throw. */
export const readOr = (p) => (existsSync(abs(p, 'file path')) ? readFileSync(p, 'utf8') : '');

export const worktreePaths = (repo) => git(repo, ['worktree', 'list', '--porcelain']).stdout
  .split('\n')
  .filter((l) => l.startsWith('worktree '))
  .map((l) => norm(l.slice('worktree '.length).trim()));

export const sha = (repo, ref) => git(repo, ['rev-parse', '--verify', '--quiet', ref]).stdout.trim();
export const hookOf = (linkedWorktree) => git(linkedWorktree, ['rev-parse', '--git-path', 'hooks/reference-transaction']).stdout.trim();

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
export function otherRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'AIPG Test']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
}

export async function withFixture(fn) {
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
export function trashedNames(root, original) {
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
export const trashedName = (root, original) => trashedNames(root, original)[0] ?? '';
export const trashedAt = (root, original, ...parts) => join(root, DATA_HOME, 'Trash', 'files', trashedName(root, original), ...parts);

// --- land fixtures ------------------------------------------------------------------------------

/** Every land scenario runs on batch b1, so the argv is worth saying once. */
export const land = (repo, key, gate, extra = []) =>
  wt(['land', '--repo', repo, '--batch', 'b1', '--key', key, '--gate', gate, ...extra]);

/** init + one prep per key: the state a fan-out leaves behind, just before the runs start. */
export function batchOf(root, repo, keys) {
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
export function stage(worktree, file, content) {
  const path = at(worktree, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  eq(git(worktree, ['add', '--', file]).code, 0, `stage ${file} in ${worktree}`);
}

/** Commits `file` holding `content` on the branch checked out in `worktree`, and returns the new commit. */
export function commitFile(worktree, file, content) {
  stage(worktree, file, content);
  eq(git(worktree, ['commit', '-qm', `add ${file}`]).code, 0, `commit ${file} in ${worktree}`);
  return sha(worktree, 'HEAD');
}

/** A --gate the tool shells out to. Written OUTSIDE every worktree so it is not part of any diff. */
export function gateCmd(root, name, body) {
  const path = join(root, `gate-${name}.cjs`);
  writeFileSync(path, body);
  return `node "${path}"`;
}

export const GATE_GREEN = '// always green\n';
// The semantic-overlap case: two chains touch DISJOINT files and still break a cross-file invariant.
export const GATE_ONE_OWNER = `const fs = require('fs');
const has = (f) => { try { return fs.readFileSync(f, 'utf8').includes('OWNER'); } catch { return false; } };
if (has('a.txt') && has('b.txt')) { console.error('two files claim OWNER'); process.exit(1); }
`;

export const lockOf = (repo) => at(git(repo, ['rev-parse', '--absolute-git-dir']).stdout.trim(), 'aipg-land.lock');
export const writeLock = (repo, owner) => writeFileSync(lockOf(repo), `${JSON.stringify(owner)}\n`);

/** A pid that is certainly not running: a child that has already exited. */
export const deadPid = () => Number(runCli(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.trim());

export const spawnCli = (args) => new Promise((done) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnv() });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('close', (code) => done({ code, stdout, stderr }));
});

// --- open and close fixtures --------------------------------------------------------------------

export const openIn = (repo, name, extra = []) => wt(['open', '--repo', repo, '--name', name, ...extra]);
export const closeIn = (repo, name, into, gate, opts = {}) => wt(['close', '--repo', repo, '--name', name, '--into', into, '--gate', gate], opts);
export const discardIn = (repo, name) => wt(['close', '--repo', repo, '--name', name, '--discard']);

/**
 * The worktree path a successful `open` printed. After a failed open it is a throwaway repository beside the
 * fixture's, so the assertions after it fail one at a time and no git call reaches another repository.
 */
export function openedPath(r, repo, name) {
  if (r.code === 0) return abs(r.stdout.trim(), `${name} worktree path`);
  const standIn = join(dirname(repo), `failed-open-${name}`);
  otherRepo(standIn);
  return standIn;
}

/** `open` that must exit 0, returning the worktree path it printed. */
export function opened(repo, name, extra = []) {
  const r = openIn(repo, name, extra);
  eq(r.code, 0, `open ${name} exits 0 (${firstLine(r.stderr)})`);
  return openedPath(r, repo, name);
}

/** A gate that appends the commit it judged and its working directory to `ledger`, one run per line. */
export const ledgerGate = (root, ledger) => gateCmd(root, 'ledger', `const head = require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
require('fs').appendFileSync(${JSON.stringify(ledger)}, head + ' ' + process.cwd() + '\\n');
`);
export const ledgerRuns = (ledger) => readOr(ledger).split('\n').filter(Boolean);

/** Asserts close changed nothing: main and the branch where they were, the worktree registered and out of the trash. */
export function unchanged(root, repo, worktree, name, mainAt, branchAt) {
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is untouched');
  eq(sha(repo, `refs/heads/aipg/${name}`), branchAt, `...aipg/${name} is where it was`);
  ok(worktreePaths(repo).includes(norm(worktree)), '...the worktree is still registered');
  eq(trashedName(root, worktree), '', '...and nothing went to the trash');
}

/** Writes `body` as the hook `name` of the fixture repo, and returns its path. */
export function hookIn(repo, name, body) {
  const out = git(repo, ['rev-parse', '--git-path', 'hooks']).stdout.trim();
  const dir = isAbsolute(out) ? out : join(repo, out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body, { mode: 0o755 });
  return join(dir, name);
}

/** False where git is not on PATH, which every test file that drives a real repo checks first. */
function gitIsOnPath() {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
export const hasGit = gitIsOnPath();
