// tools/trash.mjs: move a file or directory to the operating system's trash, refuse with every file left in place,
// or report unknown.
//
//   node tools/trash.mjs <abs path> [<abs path>...]    each trash location on stdout, one stderr line per path
//   import { trash } from './trash.mjs'                 trash(path) -> { state: 'trashed', target, location, verified }
//
// Every call ends in one state. trashed: the item is in the trash at `location`. refused: nothing moved.
// unknown: the tool cannot confirm where the item is. It may be partly or wholly in the trash, and part of it may
// remain at its path. The export throws a TrashError whose `state` is refused or unknown. CLI exit: 0 every path
// trashed, 2 any refused and none unknown, 3 any unknown, 1 a usage error before any path is touched.
//
// Backends: on Windows it runs trash-windows.ps1 (IFileOperation with a veto sink), on macOS it runs NSFileManager
// through osascript, and on Linux and WSL it implements freedesktop.org Trash 1.0 here. None copies across devices
// and none deletes. AIPG_TRASH_BACKEND=xdg forces the Linux backend on any platform, so tests trash into a temporary
// XDG_DATA_HOME and never reach the real trash.

import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'usage: node tools/trash.mjs <abs path> [<abs path>...]';
const EXIT = { trashed: 0, usage: 1, refused: 2, unknown: 3 };
const BACKEND_ENV = 'AIPG_TRASH_BACKEND';
// Bounds both helpers. Its length allows for the Windows shell, which sizes the entire tree before it moves it.
const HELPER_TIMEOUT_MS = 5 * 60 * 1000;
// Spawn errors that mean the process never started. Windows reports EPERM for an executable the user may not run.
const SPAWN_NEVER_RAN = new Set(['ENOENT', 'EACCES', 'EPERM']);
// FAT volumes spell $RECYCLE.BIN in capitals, so it matches in any case. The other trash names follow the platform's
// case rule, so a lowercase `.trash` folder, such as an Obsidian vault's, is refused only where names fold case.
const RECYCLE_BIN_RE = /^\$recycle\.bin$/i;
const TRASH_DIR_RE = /^\.Trash(es|-\d+)?$/;
const TRASH_DIR_FOLDED_RE = /^\.Trash(es|-\d+)?$/i;
const TRAILING_DOT_OR_SPACE_RE = /[. ]$/;

// pwsh comes first, since Windows PowerShell 5.1 refuses trees with paths of 260 or more characters.
const PS_HOSTS = ['pwsh.exe', 'powershell.exe'];
const PS_SCRIPT = fileURLToPath(new URL('./trash-windows.ps1', import.meta.url));
const PS_TARGET_ENV = 'AIPG_TRASH_TARGET';
const RECYCLE_INFO_VERSION = 2n;
const RECYCLE_INFO_HEADER_BYTES = 28;

const OSASCRIPT = '/usr/bin/osascript';
const NS_FEATURE_UNSUPPORTED = 3328;
const MACOS_PROVIDER_DIRS = ['Library/CloudStorage', 'Library/Mobile Documents'];
// The `$()` out-parameters, never `Ref()`, which crashed osascript after the move in another project's macOS CI
// (github.com/Tobias-Braun/brooom/pull/60).
const JXA_SOURCE = `ObjC.import('Foundation');
function run(argv) {
  var out = { ok: false, resultPath: null, domain: null, code: null, message: null };
  var resulting = $();
  var error = $();
  var url = $.NSURL.fileURLWithPath(argv[0]);
  if ($.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, resulting, error)) {
    out.ok = true;
    try { out.resultPath = resulting.path.js; } catch (e) { out.resultPath = null; }
  } else {
    try { out.domain = error.domain.js; out.code = Number(error.code); out.message = error.localizedDescription.js; }
    catch (e) { out.message = String(e); }
  }
  return JSON.stringify(out);
}
`;

// The trash spec sends files on these shares only to the home trash.
const HOME_TRASH_ONLY_FSTYPES = new Set(['cifs', 'smb3', 'smbfs']);
const STICKY_BIT = 0o1000n;
const MAX_NAME_ATTEMPTS = 1000;
const MAX_NAME_BYTES = 255;
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;   // undefined on Windows

export class TrashError extends Error {
  constructor(state, target, reason) {
    super(state === 'unknown' ? `${reason}, so check the trash for it: ${target}` : `${reason}: ${target}`);
    this.name = 'TrashError';
    this.state = state;
    this.target = target;
    this.reason = reason;
  }
}

const refused = (target, reason) => new TrashError('refused', target, reason);

// =============================================================================
// Shared helpers
// =============================================================================

function systemContext() {
  let home = '';
  try { home = homedir(); } catch { home = ''; }
  return { platform: process.platform, env: process.env, home, uid: typeof process.getuid === 'function' ? process.getuid() : null };
}

function isFullyQualified(p, platform) {
  return platform === 'win32' ? /^([A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p) : path.posix.isAbsolute(p);
}

function isTrashName(name, foldCase) {
  return RECYCLE_BIN_RE.test(name) || (foldCase ? TRASH_DIR_FOLDED_RE : TRASH_DIR_RE).test(name);
}

/** Windows and macOS volumes compare names without regard to case by default. */
export const foldsCase = (platform) => platform === 'win32' || platform === 'darwin';

export function isWithin(inner, outer, foldCase) {
  const rel = foldCase ? path.relative(outer.toLowerCase(), inner.toLowerCase()) : path.relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path of `p`, resolved as far as it exists, so a location that is not created yet still compares. */
function realpathLoose(p) {
  const missing = [];
  let dir = path.resolve(p);
  for (;;) {
    try { return path.join(realpathSync.native(dir), ...missing); } catch { /* resolve the parent instead */ }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(p);
    missing.unshift(path.basename(dir));
    dir = parent;
  }
}

/** True when the item `stat` describes is `homeReal` or an ancestor of it by (dev, ino), which catches an alias the
 *  path strings miss, such as a macOS firmlink or a Linux bind mount. */
function isHomeOrAncestor(homeReal, stat) {
  // A filesystem without file ids reports ino 0, which identifies nothing.
  if (stat.ino === 0n) return false;
  for (let dir = homeReal; ; dir = path.dirname(dir)) {
    const dirStat = lstatSync(dir, { bigint: true, throwIfNoEntry: false });
    if (dirStat && dirStat.dev === stat.dev && dirStat.ino === stat.ino) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

function usesXdgBackend(ctx) {
  return ctx.platform === 'linux' || Boolean(ctx.env[BACKEND_ENV]);
}

function xdgDataHome(ctx) {
  const value = ctx.env.XDG_DATA_HOME;
  return value && path.isAbsolute(value) ? value : path.join(ctx.home, '.local', 'share');
}

/** `{ ino }` of the entry at `p`, or `{ errno }` when it cannot be read. */
function probe(p) {
  try { return { ino: lstatSync(p, { bigint: true }).ino, errno: null }; }
  catch (err) { return { ino: null, errno: err.code ?? 'EUNKNOWN' }; }
}

/** True while the item the preflight saw, by inode, is still at its path. */
const stillInPlace = (pre) => probe(pre.target).ino === pre.ino;

function parseLastJsonLine(text) {
  const lines = String(text ?? '').trim().split(/\r?\n/);
  try {
    const value = JSON.parse(lines[lines.length - 1]);
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

export function spawnFailure(command, result) {
  const stderrLine = String(result.stderr ?? '').trim().split(/\r?\n/)[0];
  if (result.error?.code === 'ETIMEDOUT') return `${command} timed out after ${HELPER_TIMEOUT_MS} ms`;
  if (SPAWN_NEVER_RAN.has(result.error?.code)) return `${command} did not run (${result.error.message})`;
  // Another error, such as ENOBUFS when output passes maxBuffer, can arrive after the child has acted.
  if (result.error) return `${command} failed (${result.error.message})`;
  if (result.signal) return `${command} was killed by ${result.signal}`;
  if (result.status === 0) return null;
  return `${command} exited with code ${result.status}${stderrLine ? `: ${stderrLine}` : ''}`;
}

function settle(target, verdict) {
  if (verdict.state !== 'trashed') throw new TrashError(verdict.state, target, verdict.reason);
  return { state: 'trashed', target, location: verdict.location, verified: verdict.verified };
}

// =============================================================================
// Preflight: every platform, before any move
// =============================================================================

/** The resolved target, its identity and its entry count, or a refused TrashError. `ctx` is { platform, env, home, uid }.
 *  `realpath` defaults to realpathSync.native and takes a stub in tests. */
export function preflight(rawPath, ctx, realpath = realpathSync.native) {
  // Input
  const foldCase = foldsCase(ctx.platform);
  let lexical = null;
  let stat = null;
  let resolvedStat = null;
  let parentReal = null;
  let parentDev = null;
  let target = null;
  let homeReal = null;
  let homeTrash = null;
  let holdsHomeTrash = false;
  let tree = null;

  // Process: checks on the string, then checks that read the filesystem
  if (typeof rawPath !== 'string' || rawPath === '') throw refused(String(rawPath), 'the path must be a non-empty string');
  if ((ctx.platform === 'linux' || ctx.platform === 'darwin') && ctx.uid === 0 && ctx.env.SUDO_UID) {
    throw refused(rawPath, 'running as root under sudo would put the item in root\'s trash');
  }
  if (ctx.platform === 'win32' && /^[\\/]{2}[?.][\\/]/.test(rawPath)) throw refused(rawPath, 'the shell rejects \\\\?\\ and \\\\.\\ paths');
  if (!isFullyQualified(rawPath, ctx.platform)) throw refused(rawPath, 'the path is relative');
  // POSIX resolves a symbolic link before a following `..`, and path.normalize folds it first, so the two can name
  // different items. Windows resolves `..` lexically, but the rule holds on every platform, so callers meet one rule.
  if (rawPath.split(ctx.platform === 'win32' ? /[\\/]/ : '/').includes('..')) {
    throw refused(rawPath, 'the path holds a .. segment, which can name another item behind a symbolic link');
  }
  if (!ctx.home) throw refused(rawPath, 'the home directory is unknown, so it cannot be protected');
  lexical = path.normalize(rawPath);
  if (path.dirname(lexical) === lexical) throw refused(rawPath, 'the path is a filesystem root');
  // POSIX lstat follows a final symbolic link when the path ends in a separator, so the separator is dropped.
  lexical = path.join(path.dirname(lexical), path.basename(lexical));
  stat = lstatSync(lexical, { bigint: true, throwIfNoEntry: false });
  if (!stat) throw refused(rawPath, 'the path does not exist');
  if (stat.isSymbolicLink()) throw refused(rawPath, 'the path is a symbolic link or junction');

  // The item is not a link, so its real path maps a subst drive or a parent link to the real volume and an 8.3 short
  // name to its long name, which the string checks below and the Recycle Bin's record of the original path need.
  target = realpath(lexical);
  resolvedStat = lstatSync(target, { bigint: true });
  if (resolvedStat.dev !== stat.dev || resolvedStat.ino !== stat.ino) throw refused(rawPath, 'the path changed during the preflight');
  parentReal = path.dirname(target);
  parentDev = statSync(parentReal, { bigint: true }).dev;
  if (ctx.platform === 'win32' && /^\\\\[?.]\\/.test(target)) throw refused(target, 'the path resolves to a \\\\?\\ path, which the shell rejects');
  if (ctx.platform === 'win32' && target.split(path.sep).some((name) => TRAILING_DOT_OR_SPACE_RE.test(name))) {
    throw refused(target, 'the shell strips a trailing dot or space from a name, so it would act on another item');
  }
  if (stat.isDirectory() && stat.dev !== parentDev) throw refused(target, 'the path is a volume root');
  homeReal = realpathLoose(ctx.home);
  if (isWithin(homeReal, target, foldCase) || isHomeOrAncestor(homeReal, stat)) throw refused(target, 'the path is the home directory or contains it');
  homeTrash = realpathLoose(path.join(xdgDataHome(ctx), 'Trash'));
  if (target.split(path.sep).some((name) => isTrashName(name, foldCase)) || isWithin(target, homeTrash, foldCase)) {
    throw refused(target, 'the path is inside a trash');
  }
  holdsHomeTrash = isWithin(homeTrash, target, foldCase);
  // A trash at any depth counts, such as a .Trash-<uid> at the root of a volume mounted below the target.
  tree = surveyTree(target, foldCase);
  if ((holdsHomeTrash && probe(homeTrash).ino !== null) || tree.holdsTrash) throw refused(target, 'the path contains a trash');
  // Only the xdg backend creates the home trash, and it would create it inside the target.
  if (holdsHomeTrash && usesXdgBackend(ctx)) throw refused(target, 'the path contains the home trash location');

  // Output
  return { target, parentReal, name: path.basename(target), ino: stat.ino, dev: parentDev, homeReal, entries: tree.count };
}

/** `{ count, holdsTrash }`: the entries of the tree at `root`, itself included, and whether one below it has a trash
 *  name. A directory entry reports a link as a link, so the walk never follows one. */
function surveyTree(root, foldCase) {
  let count = 1;
  let holdsTrash = false;
  const pending = lstatSync(root).isDirectory() ? [root] : [];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      count += 1;
      holdsTrash ||= isTrashName(entry.name, foldCase);
      if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
    }
  }
  return { count, holdsTrash };
}

/** Refuses before a helper runs, since the preflight's walk of a large tree takes time, and an item that replaced the
 *  target meanwhile would be trashed in its place. */
function assertStillInPlace(pre) {
  if (!stillInPlace(pre)) throw refused(pre.target, 'the item changed after the preflight');
}

// =============================================================================
// Windows backend: trash-windows.ps1, then a check of the Recycle Bin entry on disk
// =============================================================================

function countOrNull(root) {
  try { return surveyTree(root, true).count; } catch { return null; }
}

/** The original path a `$I` file records, or null when the bytes are not a version 2 record. */
export function parseRecycleInfo(buffer) {
  // int64 version, int64 size, FILETIME, int32 character count including the NUL, then the UTF-16 path.
  if (buffer.length < RECYCLE_INFO_HEADER_BYTES || buffer.readBigInt64LE(0) !== RECYCLE_INFO_VERSION) return null;
  const chars = buffer.readInt32LE(24);
  if (chars < 1 || buffer.length < RECYCLE_INFO_HEADER_BYTES + chars * 2) return null;
  const stored = buffer.toString('utf16le', RECYCLE_INFO_HEADER_BYTES, RECYCLE_INFO_HEADER_BYTES + (chars - 1) * 2);
  // The shell stores an original path of MAX_PATH or more with a \\?\ prefix.
  return stored.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
}

function recycleInfoOrNull(location) {
  const name = path.basename(location);
  if (!name.startsWith('$R')) return null;
  try { return parseRecycleInfo(readFileSync(path.join(path.dirname(location), `$I${name.slice(2)}`))); } catch { return null; }
}

function windowsAfterState(target, location) {
  const targetProbe = probe(target);
  const locationFound = location !== null && probe(location).ino !== null;
  return {
    targetIno: targetProbe.ino,
    targetErrno: targetProbe.errno,
    targetCount: targetProbe.errno === null ? countOrNull(target) : null,
    locationExists: locationFound,
    locationCount: locationFound ? countOrNull(location) : null,
    infoOriginal: locationFound ? recycleInfoOrNull(location) : null,
  };
}

const recycledPathOf = (outcome) => (typeof outcome?.RecycledPath === 'string' ? outcome.RecycledPath : null);
const isFailureHr = (hr) => typeof hr === 'string' && /^0x[89A-F]/i.test(hr);

/** What the helper reported. A success HRESULT never explains a failure, so only failing HRESULTs are named. */
function windowsReport(outcome) {
  const failures = [];
  if (outcome.Veto || outcome.Error) return outcome.Veto || outcome.Error;
  if (outcome.Success === true) return 'the helper reported success';
  if (isFailureHr(outcome.PerformHr)) failures.push(`operation ${outcome.PerformHr}`);
  if (isFailureHr(outcome.DeleteHr)) failures.push(`item ${outcome.DeleteHr}`);
  if (outcome.Aborted) failures.push('aborted');
  return failures.length > 0 ? failures.join(', ') : 'the shell reported no recycled item';
}

/** The helper's report and the Recycle Bin entry it named, or why there is no report. */
function windowsCause(outcome, failure) {
  if (!outcome) return failure ?? 'the helper printed no result';
  const location = recycledPathOf(outcome);
  return location === null ? windowsReport(outcome) : `${windowsReport(outcome)}, Recycle Bin entry ${location}`;
}

/** The first check that failed, for a Windows result that is neither trashed nor refused. */
function windowsUnconfirmed({ target, preIno, countBefore, location, after }) {
  const tally = (count) => (count === null ? 'cannot be counted' : `holds ${count} entries, not the ${countBefore} the preflight counted`);
  if (after.targetIno !== null && after.targetIno !== preIno) return 'another item now sits at its path';
  if (after.targetIno !== null) return `the item is still at its path but ${tally(after.targetCount)}`;
  if (after.targetErrno !== 'ENOENT') return `its path cannot be read (${after.targetErrno})`;
  if (location === null) return 'the item left its path, and no Recycle Bin entry was reported';
  if (!after.locationExists) return 'the item left its path, and the reported Recycle Bin entry does not exist';
  if (after.locationCount !== countBefore) return `the item left its path, but its Recycle Bin entry ${tally(after.locationCount)}`;
  if (typeof after.infoOriginal !== 'string') return 'the item left its path, but its Recycle Bin entry has no readable original path';
  if (after.infoOriginal.toLowerCase() !== target.toLowerCase()) {
    return `the item left its path, but its Recycle Bin entry records the original ${after.infoOriginal}`;
  }
  return 'the item left its path and its Recycle Bin entry matches it, but the helper did not report success';
}

/** Pure. `outcome` is the helper's JSON or null, and `after` is the disk state windowsAfterState reads, where
 *  `targetIno` and `targetErrno` are probe() of the original path. */
export function classifyWindows({ target, preIno, countBefore, outcome, failure, after }) {
  const location = recycledPathOf(outcome);
  const cause = windowsCause(outcome, failure);
  const confirmed = outcome?.Success === true && location !== null && after.targetErrno === 'ENOENT' && after.locationExists
    && after.locationCount === countBefore && typeof after.infoOriginal === 'string'
    && after.infoOriginal.toLowerCase() === target.toLowerCase();
  if (confirmed) return { state: 'trashed', location, verified: true };
  // Only the preflight item, whole at its path, proves nothing moved. A writer can refill the path with the same count.
  if (after.targetIno === preIno && after.targetCount === countBefore) return { state: 'refused', reason: `not recycled (${cause})` };
  return { state: 'unknown', reason: `${windowsUnconfirmed({ target, preIno, countBefore, location, after })} (${cause})` };
}

/** `spawn` defaults to spawnSync and takes a stub in tests. */
export function runPowerShell(target, env, spawn = spawnSync) {
  const failures = [];
  for (const host of PS_HOSTS) {
    const result = spawn(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT], {
      env: { ...env, [PS_TARGET_ENV]: target },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: HELPER_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
    });
    failures.push(spawnFailure(host, result));
    // A host that never started cannot have acted, so the next host may run.
    if (!SPAWN_NEVER_RAN.has(result.error?.code)) return { stdout: result.stdout, failure: failures[failures.length - 1] };
  }
  return { stdout: '', failure: failures.join(', ') };
}

export function trashWindows(pre, ctx) {
  assertStillInPlace(pre);
  const run = runPowerShell(pre.target, ctx.env);
  const outcome = parseLastJsonLine(run.stdout);
  const after = windowsAfterState(pre.target, recycledPathOf(outcome));
  const verdict = classifyWindows({ target: pre.target, preIno: pre.ino, countBefore: pre.entries, outcome, failure: run.failure, after });
  return settle(pre.target, verdict);
}

// =============================================================================
// macOS backend: NSFileManager trashItemAtURL through osascript, then an inode check
// =============================================================================

/** The first check that failed, for a macOS result that is neither trashed nor refused. */
function macosUnconfirmed({ preIno, output, after }) {
  if (after.target.ino !== null) return 'another item now sits at its path';
  if (after.target.errno !== 'ENOENT') return `its path cannot be read (${after.target.errno})`;
  if (!after.result && output?.ok) return 'the item left its path, and osascript reported no resulting path';
  if (!after.result) return 'the item left its path, and its place in the trash is unconfirmed';
  if (after.result.ino === preIno) return 'the item is at the resulting path, but osascript did not report success';
  if (after.result.ino !== null) return 'the item left its path, but the resulting path holds another inode, so it may be a copy';
  return `the item left its path, but the resulting path cannot be read (${after.result.errno})`;
}

/** The error osascript reported, or null when it reported none. */
function macosHelperCause(output) {
  if (!output || output.ok) return null;
  if (output.domain === 'NSCocoaErrorDomain' && output.code === NS_FEATURE_UNSUPPORTED) return 'this volume has no trash';
  return `${output.message} (${output.domain} ${output.code})`;
}

/** Pure. `output` is the JXA JSON or null, and `after` holds probe() of the target and of the resulting path. */
export function classifyMacos({ preIno, output, failure, after }) {
  const cause = macosHelperCause(output) ?? failure ?? (output ? 'osascript reported success' : 'osascript printed no result');
  if (after.target.ino === preIno) return { state: 'refused', reason: `not trashed (${cause})` };
  if (after.target.errno === 'ENOENT' && output?.ok && after.result) {
    if (after.result.ino === preIno) return { state: 'trashed', location: output.resultPath, verified: true };
    // Without Full Disk Access, macOS denies reading ~/.Trash with EPERM after a successful move.
    if (after.result.errno === 'EPERM') return { state: 'trashed', location: output.resultPath, verified: false };
  }
  return { state: 'unknown', reason: `${macosUnconfirmed({ preIno, output, after })} (${cause})` };
}

/** Pure. Why the macOS backend must not trash `pre.target`, or null. */
export function macosProviderProblem(pre) {
  if (!MACOS_PROVIDER_DIRS.some((dir) => isWithin(pre.target, path.join(pre.homeReal, dir), true))) return null;
  return 'the path is in a cloud provider folder, whose provider defines its own trash';
}

export function trashMacos(pre, ctx) {
  const providerProblem = macosProviderProblem(pre);
  if (providerProblem) throw refused(pre.target, providerProblem);
  assertStillInPlace(pre);
  const result = spawnSync(OSASCRIPT, ['-l', 'JavaScript', '-', pre.target], {
    input: JXA_SOURCE,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: ctx.home, LANG: 'en_US.UTF-8' },
    timeout: HELPER_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  const output = parseLastJsonLine(result.stdout);
  const resultPath = typeof output?.resultPath === 'string' ? output.resultPath : null;
  const after = { target: probe(pre.target), result: resultPath === null ? null : probe(resultPath) };
  const verdict = classifyMacos({ preIno: pre.ino, output, failure: spawnFailure(OSASCRIPT, result), after });
  return settle(pre.target, verdict);
}

// =============================================================================
// Linux backend (and WSL): freedesktop.org Trash 1.0
// =============================================================================

/** Pure. Mount point -> { fstype }, from the bytes of a mountinfo file. */
export function parseMountinfo(bytes) {
  const mounts = new Map();
  // The kernel escapes space, tab, newline and backslash as octal, in a path that is UTF-8 bytes.
  const unescape = (s) => Buffer.from(s.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))), 'latin1').toString('utf8');
  for (const line of bytes.toString('latin1').split('\n')) {
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    if (separator === -1) continue;
    mounts.set(unescape(fields[4]), { fstype: fields[separator + 1] });
  }
  return mounts;
}

/** Empty where /proc/self/mountinfo does not exist. */
function readMounts() {
  let bytes = null;
  try { bytes = readFileSync('/proc/self/mountinfo'); } catch { return new Map(); }
  return parseMountinfo(bytes);
}

function mountOf(dir, mounts) {
  let best = null;
  for (const [point, mount] of mounts) {
    if (isWithin(dir, point, false) && (best === null || point.length > best.point.length)) best = { point, ...mount };
  }
  return best;
}

/** Walks up to a listed mount point or to where st_dev changes, which also stops at a btrfs subvolume root. */
function findTopdir(start, mounts, dev) {
  let dir = start;
  for (;;) {
    const parent = path.dirname(dir);
    if (mounts.has(dir) || parent === dir || statSync(parent, { bigint: true }).dev !== dev) return dir;
    dir = parent;
  }
}

function nearestExisting(p) {
  let dir = p;
  while (!lstatSync(dir, { throwIfNoEntry: false }) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

function ensureOwnedDir(dir, uid) {
  try { mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') return false; }
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  return Boolean(stat?.isDirectory()) && stat.uid === uid;
}

export function selectXdgTrash(pre, ctx, mounts, topdir) {
  const homeTrash = path.join(xdgDataHome(ctx), 'Trash');
  const anchor = realpathSync.native(nearestExisting(homeTrash));
  const homeDev = statSync(anchor, { bigint: true }).dev;
  if (homeDev === pre.dev && findTopdir(anchor, mounts, homeDev) === topdir) {
    mkdirSync(homeTrash, { recursive: true, mode: 0o700 });
    return { dir: homeTrash, base: null };
  }
  const mount = mountOf(pre.parentReal, mounts);
  if (mount && HOME_TRASH_ONLY_FSTYPES.has(mount.fstype)) throw refused(pre.target, `the path is on a ${mount.fstype} mount, which the trash spec limits to the home trash`);
  if (ctx.uid === null) throw refused(pre.target, 'the home trash is on another device, and a top directory trash needs a uid this platform lacks');
  const admin = path.join(topdir, '.Trash');
  const adminStat = lstatSync(admin, { bigint: true, throwIfNoEntry: false });
  const adminUsable = Boolean(adminStat?.isDirectory()) && (adminStat.mode & STICKY_BIT) !== 0n;
  if (adminUsable && ensureOwnedDir(path.join(admin, String(ctx.uid)), ctx.uid)) return { dir: path.join(admin, String(ctx.uid)), base: topdir };
  const perUser = path.join(topdir, `.Trash-${ctx.uid}`);
  if (ensureOwnedDir(perUser, ctx.uid)) return { dir: perUser, base: topdir };
  throw refused(pre.target, `no usable trash on the mount at ${topdir}, and the item is never copied to the home trash on another device`);
}

export function ensureTrashSubdirs(trashDir, pre) {
  for (const sub of ['info', 'files']) {
    const dir = path.join(trashDir, sub);
    try { mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw refused(pre.target, `cannot create ${dir} (${err.code})`); }
    const stat = lstatSync(dir, { bigint: true });
    if (!stat.isDirectory()) throw refused(pre.target, `${dir} is not a directory`);
    if (stat.dev !== pre.dev) throw refused(pre.target, `${dir} is on another device`);
  }
}

/** Percent-escapes every byte except A-Z a-z 0-9 - . _ ~ and /, which the trash spec's RFC 2396 escaping allows for Path. */
function encodeTrashPath(p) {
  let out = '';
  for (const byte of Buffer.from(p, 'utf8')) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~/]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function formatDeletionDate(d) {
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** Removes the info file only while it is still the one this call created. Returns false when it stays behind. */
function removeOwnInfo(info) {
  try {
    if (lstatSync(info.path, { bigint: true, throwIfNoEntry: false })?.ino === info.ino) unlinkSync(info.path);
    return true;
  } catch { return false; }
}

/** The created info file as { path, ino }, or null when the name is taken. */
function reserveInfo(infoPath, body, target) {
  let fd = null;
  let info = null;
  try { fd = openSync(infoPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600); }
  catch (err) {
    if (err.code === 'EEXIST') return null;
    throw refused(target, `cannot create ${infoPath} (${err.code})`);
  }
  try {
    info = { path: infoPath, ino: fstatSync(fd, { bigint: true }).ino };
    for (let written = 0; written < body.length;) written += writeSync(fd, body, written, body.length - written);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    if (info) removeOwnInfo(info);
    throw refused(target, `cannot write ${infoPath} (${err.code})`);
  }
  closeSync(fd);
  return info;
}

// Best effort: it makes an entry durable and moves nothing, and Windows cannot open a directory to fsync it.
function syncDir(dir) {
  try {
    const fd = openSync(dir, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {}
}

export function moveIntoXdgTrash(pre, trash) {
  const original = trash.base === null ? pre.target : path.relative(trash.base, pre.target);
  const body = Buffer.from(`[Trash Info]\nPath=${encodeTrashPath(original)}\nDeletionDate=${formatDeletionDate(new Date())}\n`, 'utf8');
  const fits = (name) => Buffer.byteLength(`${name}.trashinfo`) <= MAX_NAME_BYTES;
  if (!fits(pre.name)) throw refused(pre.target, `the name is too long for a trash info file, which may hold ${MAX_NAME_BYTES} bytes`);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? pre.name : `${pre.name}.${attempt}`;
    const infoPath = path.join(trash.dir, 'info', `${name}.trashinfo`);
    const destPath = path.join(trash.dir, 'files', name);
    if (!fits(name)) throw refused(pre.target, `the trash already holds ${pre.name}, and a numbered name would pass ${MAX_NAME_BYTES} bytes`);
    if (lstatSync(destPath, { throwIfNoEntry: false })) continue;
    const info = reserveInfo(infoPath, body, pre.target);
    if (!info) continue;
    // Where a directory can be fsynced, a crash after the move then cannot leave the item in files/ without its info file.
    syncDir(path.dirname(info.path));
    const leftover = () => (removeOwnInfo(info) ? '' : `, and ${info.path} could not be removed`);
    if (!stillInPlace(pre)) throw refused(pre.target, `the item changed after the preflight${leftover()}`);
    try {
      renameSync(pre.target, destPath);
    } catch (err) {
      const cause = err.code === 'EXDEV' ? 'the move would cross devices, and the item is never copied' : `the move failed (${err.code})`;
      throw refused(pre.target, `${cause}${leftover()}`);
    }
    syncDir(path.dirname(destPath));
    syncDir(pre.parentReal);
    return { state: 'trashed', target: pre.target, location: destPath, verified: true };
  }
  throw refused(pre.target, `no free trash name after ${MAX_NAME_ATTEMPTS} attempts`);
}

/** `mounts` defaults to /proc/self/mountinfo and takes a fabricated table in tests. */
export function trashXdg(pre, ctx, mounts = readMounts()) {
  if (mounts.has(pre.target)) throw refused(pre.target, 'the path is a mount point');
  const topdir = findTopdir(pre.parentReal, mounts, pre.dev);
  const trash = selectXdgTrash(pre, ctx, mounts, topdir);
  ensureTrashSubdirs(trash.dir, pre);
  return moveIntoXdgTrash(pre, trash);
}

// =============================================================================
// Entry points
// =============================================================================

const BACKENDS = { win32: trashWindows, darwin: trashMacos, linux: trashXdg };

/** Why no backend can run in this context, or null. */
function backendProblem(ctx) {
  const forced = ctx.env[BACKEND_ENV];
  if (forced && forced !== 'xdg') return `${BACKEND_ENV} must be unset or "xdg", not "${forced}"`;
  if (!forced && !BACKENDS[ctx.platform]) return `no trash backend for platform ${ctx.platform}`;
  return null;
}

function trashWith(rawPath, ctx) {
  const problem = backendProblem(ctx);
  let pre = null;
  if (problem) throw refused(String(rawPath), problem);
  try {
    pre = preflight(rawPath, ctx);
    return (usesXdgBackend(ctx) ? trashXdg : BACKENDS[ctx.platform])(pre, ctx);
  } catch (err) {
    if (err instanceof TrashError) throw err;
    if (!pre) throw refused(String(rawPath), `the preflight failed (${err.message})`);
    // Only the item still at its path with its preflight inode proves nothing moved.
    throw new TrashError(stillInPlace(pre) ? 'refused' : 'unknown', pre.target, `unexpected error (${err.message})`);
  }
}

export function trash(rawPath) {
  return trashWith(rawPath, systemContext());
}

export function exitCodeFor(states) {
  if (states.includes('unknown')) return EXIT.unknown;
  if (states.includes('refused')) return EXIT.refused;
  return EXIT.trashed;
}

/** A helper's reason or a Linux file name can hold line breaks, and the CLI prints one stderr line per path. */
function writeStderrRecord(text) {
  process.stderr.write(`trash: ${text.replace(/\r/g, '\\r').replace(/\n/g, '\\n')}\n`);
}

function main(argv) {
  const ctx = systemContext();
  const problem = argv.length === 0 ? USAGE : backendProblem(ctx);
  const states = [];
  if (problem) {
    writeStderrRecord(problem);
    return EXIT.usage;
  }
  for (const rawPath of argv) {
    try {
      const result = trashWith(rawPath, ctx);
      process.stdout.write(`${result.location}\n`);
      writeStderrRecord(`trashed ${result.target} to ${result.location}${result.verified ? '' : ' (unverified, the trash is not readable)'}`);
      states.push(result.state);
    } catch (err) {
      const state = err instanceof TrashError ? err.state : 'unknown';
      writeStderrRecord(`${state}: ${err.message}`);
      states.push(state);
    }
  }
  return exitCodeFor(states);
}

// Realpath BOTH sides: a symlink or junction in the script path makes argv[1] differ from import.meta.url,
// and a false `invokedDirectly` prints nothing at exit 0. Holds under `--preserve-symlinks-main` too.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
