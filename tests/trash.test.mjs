// tools/trash.mjs, driven through its CLI and its exports against throwaway trees under os.tmpdir().
//
// Every CLI run outside the live cases sets AIPG_TRASH_BACKEND=xdg with an XDG_DATA_HOME inside the fixture, so the
// default suite never reaches the real trash. The Windows and macOS backends are tested as pure classifiers fed
// fabricated helper output and disk states, and the PowerShell host order through a stub spawn. The preflight's
// identity check runs against a stub realpath. The xdg backend is also called directly with a fabricated device,
// inode, name or mount table, which reaches the top directory trash, a cifs mount, a mount point target, a trash
// subdirectory on another device, a 255-byte name and the recheck after the preflight without a second mount or a
// racing process. The Windows backend's recheck runs with an empty PATH, so a regression finds no PowerShell host,
// and the macOS backend's recheck runs on a removed item, so a regression gives osascript nothing to trash.
// The cases that drive the real platform backend run only under AIPG_TRASH_LIVE=1. They trash temp directories, on
// Windows one at a path of MAX_PATH or more, and on Windows one runs the helper against a name its shell parses as
// another item.
import { spawnSync } from 'node:child_process';
import {
  chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, parse, sep } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import {
  TrashError, classifyMacos, classifyWindows, ensureTrashSubdirs, exitCodeFor, macosProviderProblem, moveIntoXdgTrash,
  parseMountinfo, parseRecycleInfo, preflight, runPowerShell, selectXdgTrash, spawnFailure, trashMacos, trashWindows,
  trashXdg,
} from '../tools/trash.mjs';

const SCRIPT = join(REPO_ROOT, 'tools/trash.mjs');
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

/** A temp root holding `work/` for targets and `data/` as XDG_DATA_HOME, real-pathed so trash paths compare. */
function makeFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aipg-trash-')));
  const fx = { root, work: join(root, 'work'), data: join(root, 'data'), trash: join(root, 'data', 'Trash') };
  mkdirSync(fx.work);
  mkdirSync(fx.data);
  return fx;
}

const xdgEnv = (fx) => ({ ...process.env, AIPG_TRASH_BACKEND: 'xdg', XDG_DATA_HOME: fx.data });
const fixtureCtx = (fx, uid = UID) => ({ platform: process.platform, env: { XDG_DATA_HOME: fx.data }, home: join(fx.root, 'home'), uid });

/** The error `fn` throws, or null, so a refusal is an assertable value. */
function thrown(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

/** Returns { code, stdout, stderr }, so a nonzero exit is an assertable value. Throws only when node cannot be spawned. */
function trashCli(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/** '' for a missing file: an assertion about content a regression never wrote must fail, not throw. */
const readOr = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function readTrashInfo(trashDir, name) {
  const lines = readOr(join(trashDir, 'info', `${name}.trashinfo`)).split('\n');
  const value = (key) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1) ?? '';
  return { header: lines[0], path: value('Path'), date: value('DeletionDate') };
}

/** The 8.3 form of `p` from cmd's %~s modifier, which keeps a long name where the volume generates no short one. */
function shortPath(p) {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${p}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  return String(r.stdout ?? '').trim();
}

function makeTree(dir, marker) {
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'marker.txt'), marker);
}

section('xdg backend: a directory and a file land in files/ with a valid .trashinfo');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'tree');
    const file = join(fx.work, 'note.txt');
    makeTree(dir, 'kept');
    writeFileSync(file, 'note');
    const r = trashCli([dir, file], xdgEnv(fx));
    eq(r.code, 0, 'exit 0 when every path was trashed');
    ok(!existsSync(dir) && !existsSync(file), 'both items left their paths');
    eq(readOr(join(fx.trash, 'files', 'tree', 'sub', 'marker.txt')), 'kept', 'the directory landed in files/ with its contents');
    eq(readOr(join(fx.trash, 'files', 'note.txt')), 'note', 'the file landed in files/');
    eq(r.stdout, `${join(fx.trash, 'files', 'tree')}\n${join(fx.trash, 'files', 'note.txt')}\n`, 'stdout lists each trash location');
    eq(r.stderr.split('\n').filter((l) => l.startsWith('trash: trashed ')).length, 2, 'stderr has one line per path');
    for (const [name, original] of [['tree', dir], ['note.txt', file]]) {
      const info = readTrashInfo(fx.trash, name);
      eq(info.header, '[Trash Info]', `${name}.trashinfo starts with [Trash Info]`);
      eq(decodeURIComponent(info.path), original, `${name}.trashinfo Path is the absolute original path`);
      ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d$/.test(info.date), `${name}.trashinfo DeletionDate is YYYY-MM-DDThh:mm:ss (got ${info.date})`);
    }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a name collision takes <name>.2');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'same');
    makeTree(dir, 'first');
    const first = trashCli([dir], xdgEnv(fx));
    makeTree(dir, 'second');
    const second = trashCli([dir], xdgEnv(fx));
    eq(first.code + second.code, 0, 'both calls exit 0');
    eq(second.stdout.trim(), join(fx.trash, 'files', 'same.2'), 'the second item is reported at same.2');
    eq(readOr(join(fx.trash, 'files', 'same', 'sub', 'marker.txt')), 'first', 'the first item is untouched at same');
    eq(readOr(join(fx.trash, 'files', 'same.2', 'sub', 'marker.txt')), 'second', 'the second item landed at same.2');
    eq(decodeURIComponent(readTrashInfo(fx.trash, 'same.2').path), dir, 'same.2.trashinfo records the original path');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: spaces and non-ASCII characters are percent-encoded byte by byte');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'sp ace \u00fc\u20ac');
    makeTree(dir, 'x');
    const r = trashCli([dir], xdgEnv(fx));
    const info = readTrashInfo(fx.trash, 'sp ace \u00fc\u20ac');
    eq(r.code, 0, 'exit 0');
    ok(info.path.endsWith('sp%20ace%20%C3%BC%E2%82%AC'), `the name is encoded as UTF-8 bytes (got ${info.path})`);
    ok(/^[A-Za-z0-9\-._~/%]+$/.test(info.path), 'Path holds only unreserved characters and escapes');
    eq(decodeURIComponent(info.path), dir, 'Path decodes to the original path');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a refused move leaves the target in place with no stray info file');
if (process.platform !== 'win32' && UID === 0) {
  console.log('    (skipped as root: no permission bit stops root from renaming into the trash)');
} else {
  const fx = makeFixture();
  let held = null;
  try {
    const dir = join(fx.work, 'held');
    makeTree(dir, 'x');
    mkdirSync(join(fx.trash, 'info'), { recursive: true });
    mkdirSync(join(fx.trash, 'files'), { recursive: true });
    // Windows refuses to rename a directory while a file under it is open. Elsewhere an unwritable files/ refuses it.
    if (process.platform === 'win32') held = openSync(join(dir, 'sub', 'marker.txt'), 'r');
    else chmodSync(join(fx.trash, 'files'), 0o500);
    const r = trashCli([dir], xdgEnv(fx));
    eq(r.code, 2, 'exit 2 when the move is refused');
    ok(/refused: the move failed/.test(r.stderr), `stderr names the failed move (got ${r.stderr.trim()})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the target is still in place with its contents');
    eq(readdirSync(join(fx.trash, 'info')).length, 0, 'the info file this call created was removed');
  } finally {
    if (held !== null) closeSync(held);
    if (process.platform !== 'win32' && existsSync(join(fx.trash, 'files'))) chmodSync(join(fx.trash, 'files'), 0o700);
    rmSync(fx.root, { recursive: true, force: true });
  }
}

section('xdg backend: an item that changed after the preflight is refused, with its info file removed');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'swapped');
    makeTree(dir, 'x');
    const pre = preflight(dir, fixtureCtx(fx));
    mkdirSync(join(fx.trash, 'info'), { recursive: true });
    mkdirSync(join(fx.trash, 'files'), { recursive: true });
    // Another inode stands in for an item replaced between the preflight and the rename.
    const err = thrown(() => moveIntoXdgTrash({ ...pre, ino: pre.ino + 1n }, { dir: fx.trash, base: null }));
    ok(err instanceof TrashError && err.state === 'refused' && /changed after the preflight/.test(err.message), `the move is refused (got ${err ? err.message : 'no refusal'})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
    eq(readdirSync(join(fx.trash, 'info')).length, 0, 'the info file this call created was removed');
    eq(readdirSync(join(fx.trash, 'files')).length, 0, 'nothing reached files/');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('Windows backend: an item that changed after the preflight is refused before any helper runs');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'swapped');
    makeTree(dir, 'x');
    const pre = preflight(dir, fixtureCtx(fx));
    // An empty PATH finds no PowerShell host, so a missing recheck refuses for another reason and recycles nothing.
    const err = thrown(() => trashWindows({ ...pre, ino: pre.ino + 1n }, { ...fixtureCtx(fx), env: { PATH: '' } }));
    ok(err instanceof TrashError && err.state === 'refused' && /changed after the preflight/.test(err.message), `the call is refused (got ${err ? err.message : 'no refusal'})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('macOS backend: an item that left its path after the preflight is refused before osascript runs');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'removed');
    makeTree(dir, 'x');
    const pre = preflight(dir, fixtureCtx(fx));
    // A removed item, unlike a replaced one, leaves osascript nothing to trash, so a missing recheck ends in unknown.
    rmSync(dir, { recursive: true });
    const err = thrown(() => trashMacos(pre, fixtureCtx(fx)));
    ok(err instanceof TrashError && err.state === 'refused' && /changed after the preflight/.test(err.message), `the call is refused (got ${err ? err.message : 'no refusal'})`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a top directory trash is chosen when the home trash is on another device');
{
  const fx = makeFixture();
  try {
    const top = join(fx.root, 'vol');
    const dir = join(top, 'proj', 'tree');
    makeTree(dir, 'x');
    // A file the test creates is owned by the real uid, or by 0 on Windows, which has no uid.
    const owner = lstatSync(top).uid;
    const ctx = fixtureCtx(fx, owner);
    const pre = preflight(dir, ctx);
    // A device the home trash is not on sends the selection to the top directory without a second mount.
    const elsewhere = { ...pre, dev: -1n };
    const noUid = thrown(() => selectXdgTrash(elsewhere, fixtureCtx(fx, null), new Map(), top));
    ok(noUid instanceof TrashError && noUid.state === 'refused' && /needs a uid/.test(noUid.message), `a platform with no uid is refused (got ${noUid ? noUid.message : 'no refusal'})`);
    mkdirSync(join(top, '.Trash'));
    const perUser = selectXdgTrash(elsewhere, ctx, new Map(), top);
    eq(perUser.dir, join(top, `.Trash-${owner}`), 'a .Trash without the sticky bit is passed over for .Trash-<uid>');
    eq(perUser.base, top, 'a top directory trash records paths from the top directory');
    ok(existsSync(perUser.dir), '.Trash-<uid> was created');
    if (process.platform !== 'win32') {
      chmodSync(join(top, '.Trash'), 0o1777);
      eq(selectXdgTrash(elsewhere, ctx, new Map(), top).dir, join(top, '.Trash', String(owner)), 'a sticky .Trash comes first, at .Trash/<uid>');
    }
    mkdirSync(join(perUser.dir, 'info'));
    mkdirSync(join(perUser.dir, 'files'));
    const moved = moveIntoXdgTrash(pre, perUser);
    eq(moved.location, join(perUser.dir, 'files', 'tree'), 'the item is reported in the top directory trash');
    eq(readOr(join(perUser.dir, 'files', 'tree', 'sub', 'marker.txt')), 'x', 'the item landed in its files/');
    eq(decodeURIComponent(readTrashInfo(perUser.dir, 'tree').path), join('proj', 'tree'), 'Path is relative to the top directory');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a cifs mount uses the home trash on it and refuses a top directory trash');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'tree');
    makeTree(dir, 'x');
    const ctx = fixtureCtx(fx, 1000);
    const pre = preflight(dir, ctx);
    // The fixture root stands in for a cifs mount that holds the target and the home trash.
    const cifs = new Map([[fx.root, { fstype: 'cifs' }]]);
    // A device the home trash is not on stands in for a part of the share away from the home trash.
    const away = thrown(() => trashXdg({ ...pre, dev: -1n }, ctx, cifs));
    ok(away instanceof TrashError && away.state === 'refused' && /cifs mount/.test(away.message), `a top directory trash on a cifs mount is refused (got ${away ? away.message : 'no refusal'})`);
    ok(!existsSync(join(fx.work, '.Trash-1000')), 'no top directory trash was created');
    const moved = trashXdg(pre, ctx, cifs);
    eq(moved.location, join(fx.trash, 'files', 'tree'), 'the item is reported in the home trash on the same cifs mount');
    eq(readOr(join(fx.trash, 'files', 'tree', 'sub', 'marker.txt')), 'x', 'the item landed in the home trash');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a target that is a mount point is refused before any trash is created');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'bound');
    makeTree(dir, 'x');
    const ctx = fixtureCtx(fx);
    const pre = preflight(dir, ctx);
    // A mount table that lists the target stands in for a bind mount without a second mount.
    const err = thrown(() => trashXdg(pre, ctx, new Map([[pre.target, { fstype: 'ext4' }]])));
    ok(err instanceof TrashError && err.state === 'refused' && /mount point/.test(err.message), `the mount point is refused (got ${err ? err.message : 'no refusal'})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
    ok(!existsSync(fx.trash), 'no trash directory was created');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a name with no room for <name>.trashinfo or for a numbered name is refused in place');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'tree');
    makeTree(dir, 'x');
    const pre = preflight(dir, fixtureCtx(fx));
    const trash = { dir: fx.trash, base: null };
    // A 245-byte name fills <name>.trashinfo to 255 bytes, so <name>.2.trashinfo does not fit.
    const fitting = 'a'.repeat(245);
    mkdirSync(join(fx.trash, 'info'), { recursive: true });
    mkdirSync(join(fx.trash, 'files', fitting), { recursive: true });
    const taken = thrown(() => moveIntoXdgTrash({ ...pre, name: fitting }, trash));
    ok(taken instanceof TrashError && taken.state === 'refused' && /already holds a+, and a numbered name/.test(taken.message), `a taken name with no room for a number names the collision (got ${taken ? taken.message : 'no refusal'})`);
    const tooLong = thrown(() => moveIntoXdgTrash({ ...pre, name: 'a'.repeat(246) }, trash));
    ok(tooLong instanceof TrashError && tooLong.state === 'refused' && /too long for a trash info file/.test(tooLong.message), `a name with no room for .trashinfo is too long (got ${tooLong ? tooLong.message : 'no refusal'})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
    eq(readdirSync(join(fx.trash, 'info')).length, 0, 'no info file was created');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('xdg backend: a files/ that is a link, or a trash subdirectory on another device, is refused in place');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'tree');
    const outside = join(fx.root, 'outside');
    makeTree(dir, 'x');
    mkdirSync(outside);
    mkdirSync(fx.trash, { recursive: true });
    // A planted link at files/ would send the item outside the trash.
    symlinkSync(outside, join(fx.trash, 'files'), process.platform === 'win32' ? 'junction' : 'dir');
    const ctx = fixtureCtx(fx);
    const pre = preflight(dir, ctx);
    const linked = thrown(() => trashXdg(pre, ctx, new Map()));
    ok(linked instanceof TrashError && linked.state === 'refused' && /files is not a directory/.test(linked.message), `a linked files/ is refused (got ${linked ? linked.message : 'no refusal'})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
    eq(readdirSync(outside).length, 0, 'nothing reached the link target');
    // A device the item is not on stands in for an info/ on another mount without a second mount.
    mkdirSync(join(fx.root, 'other-trash'));
    const away = thrown(() => ensureTrashSubdirs(join(fx.root, 'other-trash'), { ...pre, dev: -1n }));
    ok(away instanceof TrashError && away.state === 'refused' && /info is on another device/.test(away.message), `a trash subdirectory on another device is refused (got ${away ? away.message : 'no refusal'})`);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('a .. segment after a symbolic link is refused, and neither item it could name moves');
{
  const fx = makeFixture();
  try {
    // POSIX resolves work/link/../x to other/x, the x beside the link's target, and a lexical fold names work/x.
    makeTree(join(fx.work, 'x'), 'work');
    makeTree(join(fx.root, 'other', 'x'), 'other');
    mkdirSync(join(fx.root, 'other', 'dir'));
    symlinkSync(join(fx.root, 'other', 'dir'), join(fx.work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const r = trashCli([[fx.work, 'link', '..', 'x'].join(sep)], xdgEnv(fx));
    eq(r.code, 2, 'the path is refused, exit 2');
    ok(/refused: the path holds a \.\. segment/.test(r.stderr), `stderr names the .. segment (got ${r.stderr.trim()})`);
    eq(readOr(join(fx.work, 'x', 'sub', 'marker.txt')), 'work', 'the x a lexical fold names is still in place');
    eq(readOr(join(fx.root, 'other', 'x', 'sub', 'marker.txt')), 'other', 'the x the kernel resolves is still in place');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('an unexpected backend error with the item still in place is refused');
{
  const fx = makeFixture();
  try {
    const dir = join(fx.work, 'tree');
    const dataFile = join(fx.root, 'data-file');
    makeTree(dir, 'x');
    // A file where XDG_DATA_HOME names a directory makes creating the home trash throw a plain fs error.
    writeFileSync(dataFile, '');
    const r = trashCli([dir], { ...xdgEnv(fx), XDG_DATA_HOME: dataFile });
    eq(r.code, 2, 'exit 2');
    ok(/refused: unexpected error \(/.test(r.stderr), `stderr reports the unexpected error as a refusal (got ${r.stderr.trim()})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('a tree the preflight cannot read for a trash is refused');
if (process.platform !== 'win32' && UID === 0) {
  console.log('    (skipped as root: no permission bit stops root from reading a directory)');
} else {
  const fx = makeFixture();
  const dir = join(fx.work, 'tree');
  const locked = join(dir, 'locked');
  // Windows ignores the mode bits, so a deny entry for Everyone stops the listing there.
  const setLocked = (p, on) => {
    if (process.platform !== 'win32') chmodSync(p, on ? 0o000 : 0o700);
    else spawnSync('icacls', on ? [p, '/deny', '*S-1-1-0:(RD)'] : [p, '/remove:d', '*S-1-1-0']);
  };
  try {
    makeTree(dir, 'x');
    mkdirSync(locked);
    setLocked(locked, true);
    const r = trashCli([dir], xdgEnv(fx));
    eq(r.code, 2, 'exit 2');
    ok(/refused: the preflight failed \(E(ACCES|PERM)/.test(r.stderr), `stderr names the unreadable directory (got ${r.stderr.trim()})`);
    eq(readOr(join(dir, 'sub', 'marker.txt')), 'x', 'the item is still in place with its contents');
  } finally {
    // A regression trashes the tree, so the locked directory may sit in the fixture's trash instead.
    for (const p of [locked, join(fx.trash, 'files', 'tree', 'locked')]) if (existsSync(p)) setLocked(p, false);
    rmSync(fx.root, { recursive: true, force: true });
  }
}

section('preflight refuses every unsafe target before any move');
{
  const fx = makeFixture();
  const ctx = fixtureCtx(fx);
  const home = ctx.home;
  const refusal = (p, c = ctx, realpath) => thrown(() => preflight(p, c, realpath));
  const refusedWith = (p, pattern, msg, c = ctx, realpath) => {
    const err = refusal(p, c, realpath);
    ok(err instanceof TrashError && err.state === 'refused' && pattern.test(err.message), `${msg} (got ${err ? err.message : 'no refusal'})`);
  };
  const dirAt = (...parts) => { const p = join(...parts); mkdirSync(p, { recursive: true }); return p; };
  try {
    mkdirSync(home);
    const plain = dirAt(fx.work, 'plain');
    eq(refusal(plain)?.message ?? 'passed', 'passed', 'control: a plain directory passes');
    eq(refusal(dirAt(home, 'project'))?.message ?? 'passed', 'passed', 'control: a directory inside the home directory passes');
    makeTree(join(fx.work, 'counted'), 'x');
    eq(preflight(join(fx.work, 'counted'), ctx).entries, 3, 'the preflight counts the entries of the tree, itself included');
    refusedWith('rel/dir', /the path is relative/, 'a relative path');
    refusedWith(join(fx.work, 'missing'), /does not exist/, 'a path that does not exist');
    refusedWith('\\\\?\\C:\\work\\tree', /rejects/, 'a \\\\?\\ path on Windows', { ...ctx, platform: 'win32' });
    refusedWith('\\\\.\\pipe\\tree', /rejects/, 'a \\\\.\\ path on Windows', { ...ctx, platform: 'win32' });
    symlinkSync(plain, join(fx.work, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    refusedWith(join(fx.work, 'link'), /symbolic link or junction/, 'a symbolic link or junction as the target');
    refusedWith(join(fx.work, 'link') + sep, /symbolic link or junction/, 'a symbolic link given with a trailing separator');
    refusedWith([fx.work, 'plain', '..', 'plain'].join(sep), /\.\. segment/, 'a path that holds a .. segment');
    if (process.platform === 'win32') refusedWith(`${fx.work}/plain/../plain`, /\.\. segment/, 'a .. segment between forward slashes on Windows');
    eq(refusal(dirAt(fx.work, 'a..b'))?.message ?? 'passed', 'passed', 'control: a name that holds two dots passes');
    // A stub realpath stands in for an item replaced between the lstat and the realpath, a race no test can time.
    const swappedIn = dirAt(fx.work, 'swapped-in');
    refusedWith(plain, /changed during the preflight/, 'a real path that names another item', ctx, () => swappedIn);
    refusedWith(parse(fx.root).root, /filesystem root/, 'a filesystem root');
    const mountPoint = { linux: '/proc', darwin: '/dev' }[process.platform];
    if (mountPoint) {
      refusedWith(mountPoint, /volume root/, `a volume root that is not a filesystem root (${mountPoint})`);
    } else {
      console.log('    (volume root case skipped: this platform has no mount point a test can rely on)');
    }
    refusedWith(home, /home directory/, 'the home directory');
    refusedWith(fx.root, /home directory/, 'a directory that contains the home directory');
    refusedWith(dirAt(fx.work, '$Recycle.Bin', 'S-1-5-21', 'item'), /inside a trash/, 'a path inside $Recycle.Bin');
    refusedWith(dirAt(fx.work, 'fat', '$RECYCLE.BIN', 'item'), /inside a trash/, 'a path inside a FAT volume\'s $RECYCLE.BIN');
    refusedWith(dirAt(fx.work, 'vol', '.Trash-1000', 'files', 'item'), /inside a trash/, 'a path inside a .Trash-<uid> directory');
    refusedWith(dirAt(fx.work, 'vol', '.Trash', '1000', 'files', 'item'), /inside a trash/, 'a path inside a .Trash directory');
    refusedWith(dirAt(fx.work, 'mac', '.Trashes', '501', 'item'), /inside a trash/, 'a path inside /.Trashes');
    refusedWith(dirAt(home, '.Trash', 'item'), /inside a trash/, 'a path inside ~/.Trash');
    refusedWith(dirAt(fx.data, 'Trash', 'files', 'item'), /inside a trash/, 'a path inside $XDG_DATA_HOME/Trash');
    dirAt(fx.work, 'holder', '.Trash-1000');
    refusedWith(join(fx.work, 'holder'), /contains a trash/, 'a directory that contains a .Trash-<uid> directory');
    dirAt(fx.work, 'outer', 'vol', '.Trash-1000', 'files');
    refusedWith(join(fx.work, 'outer'), /contains a trash/, 'a directory that holds a .Trash-<uid> directory two levels down');
    dirAt(fx.work, 'outer-bin', 'drive', '$Recycle.Bin');
    refusedWith(join(fx.work, 'outer-bin'), /contains a trash/, 'a directory that holds a $Recycle.Bin two levels down');
    symlinkSync(join(fx.work, 'outer'), join(dirAt(fx.work, 'linker'), 'to-outer'), process.platform === 'win32' ? 'junction' : 'dir');
    eq(refusal(join(fx.work, 'linker'))?.message ?? 'passed', 'passed', 'a link to a directory that holds a trash is not followed');
    refusedWith(fx.data, /contains a trash/, 'a directory that contains $XDG_DATA_HOME/Trash');
    // Only the xdg backend creates the home trash, so a missing one blocks its ancestors only where that backend runs.
    const fresh = dirAt(fx.root, 'fresh');
    const freshCtx = { ...ctx, env: { XDG_DATA_HOME: dirAt(fresh, 'share') } };
    const forcedCtx = { ...freshCtx, env: { ...freshCtx.env, AIPG_TRASH_BACKEND: 'xdg' } };
    refusedWith(fresh, /contains the home trash location/, 'a directory holding a missing home trash where the xdg backend is forced', forcedCtx);
    if (process.platform === 'linux') {
      refusedWith(fresh, /contains the home trash location/, 'a directory holding a missing home trash on Linux', freshCtx);
    } else {
      eq(refusal(fresh, freshCtx)?.message ?? 'passed', 'passed', 'a directory holding a missing home trash passes where the backend never creates it');
    }
    dirAt(fx.work, 'vault', '.trash');
    if (process.platform === 'linux') {
      eq(refusal(join(fx.work, 'vault'))?.message ?? 'passed', 'passed', 'a lowercase .trash folder is not a trash where names keep their case');
    } else {
      refusedWith(join(fx.work, 'vault'), /contains a trash/, 'a lowercase .trash folder is refused where names fold case');
    }
    refusedWith(plain, /sudo/, 'uid 0 while SUDO_UID is set on Linux', { ...ctx, platform: 'linux', uid: 0, env: { ...ctx.env, SUDO_UID: '1000' } });
    refusedWith(plain, /sudo/, 'uid 0 while SUDO_UID is set on macOS', { ...ctx, platform: 'darwin', uid: 0, env: { ...ctx.env, SUDO_UID: '501' } });
    // A hard link stands in for an alias of the home directory the path strings miss, such as a macOS firmlink.
    writeFileSync(join(fx.root, 'home-file'), '');
    linkSync(join(fx.root, 'home-file'), join(fx.work, 'home-alias'));
    refusedWith(join(fx.work, 'home-alias'), /home directory/, 'another path to the home directory\'s own inode', { ...ctx, home: join(fx.root, 'home-file') });
    if (process.platform === 'win32') {
      const longHome = dirAt(fx.root, 'LongHomeDirectoryName');
      const longPlain = dirAt(fx.work, 'LongPlainDirectoryName');
      const shortHome = shortPath(longHome);
      if (basename(shortHome) === basename(longHome)) {
        console.log('    (8.3 cases skipped: this volume generates no short names)');
      } else {
        refusedWith(shortHome, /home directory/, 'the 8.3 short name of the home directory', { ...ctx, home: longHome });
        refusedWith(shortPath(join(fx.work, 'vol', '.Trash-1000')), /inside a trash/, 'the 8.3 short name of a .Trash-<uid> directory');
        let resolved = '';
        try { resolved = preflight(shortPath(longPlain), ctx).target; } catch (err) { resolved = err.message; }
        eq(resolved, longPlain, 'an 8.3 short name resolves to the long path the Recycle Bin records');
      }
      dirAt(fx.work, 'dotted');
      refusedWith(dirAt(fx.work, 'dotted.'), /strips a trailing dot or space/, 'a name ending in a dot beside the name without it');
      refusedWith(dirAt(fx.work, 'dotted '), /strips a trailing dot or space/, 'a name ending in a space beside the name without it');
      refusedWith(dirAt(fx.work, 'parent.', 'item'), /strips a trailing dot or space/, 'a path whose parent name ends in a dot');
    } else {
      eq(refusal(dirAt(fx.work, 'dotted.'))?.message ?? 'passed', 'passed', 'a name ending in a dot passes where no shell strips it');
    }
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

section('Windows classification: trashed, refused and unknown from fabricated helper output');
{
  const target = 'C:\\w\\tree';
  const location = 'C:\\$Recycle.Bin\\S-1-5-21\\$RAB12CD';
  const base = { target, preIno: 9n, countBefore: 5, failure: null };
  const success = { Success: true, RecycledPath: location, Veto: null, Error: null, PerformHr: '0x00000000', DeleteHr: '0x00270008', Aborted: false };
  const veto = { ...success, Success: false, RecycledPath: null, Veto: 'no recycling possible (the shell would delete permanently)' };
  const moved = { targetIno: null, targetErrno: 'ENOENT', targetCount: null, locationExists: true, locationCount: 5, infoOriginal: target };
  const intact = { targetIno: 9n, targetErrno: null, targetCount: 5, locationExists: false, locationCount: null, infoOriginal: null };
  const confirmed = classifyWindows({ ...base, outcome: success, after: moved });
  eq(confirmed.state, 'trashed', 'reported success with a matching $R entry is trashed');
  eq(confirmed.location, location, 'the trashed result carries the $R path');
  eq(classifyWindows({ ...base, outcome: success, after: { ...moved, infoOriginal: 'c:\\W\\TREE' } }).state, 'trashed', 'the $I original path compares without regard to case');
  const vetoed = classifyWindows({ ...base, outcome: veto, after: intact });
  eq(vetoed.state, 'refused', 'a veto with the item intact is refused');
  ok(/would delete permanently/.test(vetoed.reason), `the refusal names the veto (got ${vetoed.reason})`);
  const timedOut = classifyWindows({ ...base, outcome: null, failure: 'pwsh.exe timed out after 300000 ms', after: intact });
  eq(timedOut.state, 'refused', 'a timed-out helper with the item intact is refused');
  ok(/timed out/.test(timedOut.reason), `the refusal names the timeout (got ${timedOut.reason})`);
  const stillThere = classifyWindows({ ...base, outcome: success, after: intact });
  eq(stillThere.state, 'refused', 'reported success with the item still intact is refused');
  ok(stillThere.reason.includes(`reported success, Recycle Bin entry ${location}`) && !/0x[0-7]/.test(stillThere.reason), `the refusal names the reported success and its entry, never a success HRESULT (got ${stillThere.reason})`);
  const noItem = classifyWindows({ ...base, outcome: { ...success, Success: false, RecycledPath: null }, after: intact });
  ok(/the shell reported no recycled item/.test(noItem.reason) && !/0x[0-7]/.test(noItem.reason), `a refusal with only success HRESULTs names none of them (got ${noItem.reason})`);
  const failedOp = classifyWindows({ ...base, outcome: { ...success, Success: false, RecycledPath: null, PerformHr: '0x80270000', DeleteHr: null, Aborted: true }, after: intact });
  eq(failedOp.reason, 'not recycled (operation 0x80270000, aborted)', 'a refusal names a failed operation HRESULT and the abort');
  eq(classifyWindows({ ...base, outcome: null, failure: 'pwsh.exe was killed by SIGKILL', after: { ...intact, targetCount: 3 } }).state, 'unknown', 'a partial tree left at the path is unknown');
  eq(classifyWindows({ ...base, outcome: success, after: { ...intact, targetCount: null } }).state, 'unknown', 'an item at its path that cannot be counted is unknown');
  // A writer that recreates the path after the shell recycled the item can match its entry count.
  const refilled = classifyWindows({ ...base, outcome: success, after: { ...moved, targetIno: 10n, targetErrno: null, targetCount: 5 } });
  eq(refilled.state, 'unknown', 'another item at the path with the same count and a matching $R entry is unknown');
  ok(/another item now sits at its path/.test(refilled.reason) && refilled.reason.includes(`Recycle Bin entry ${location}`), `the reason names the other item and the reported entry (got ${refilled.reason})`);
  const unreadable = classifyWindows({ ...base, outcome: null, failure: 'pwsh.exe timed out', after: { ...intact, targetIno: null, targetErrno: 'EPERM', targetCount: null } });
  eq(unreadable.state, 'unknown', 'an original path that cannot be read is unknown');
  ok(/its path cannot be read \(EPERM\)/.test(unreadable.reason), `the reason names the unreadable path, not an item still there (got ${unreadable.reason})`);
  const noEntry = { ...moved, locationExists: false, locationCount: null, infoOriginal: null };
  const killed = classifyWindows({ ...base, outcome: null, failure: 'pwsh.exe timed out after 300000 ms', after: noEntry });
  eq(killed.state, 'unknown', 'a killed helper with the item gone is unknown');
  eq(killed.reason, 'the item left its path, and no Recycle Bin entry was reported (pwsh.exe timed out after 300000 ms)', 'that reason names the missing entry and the timeout');
  const vetoedAfterMove = classifyWindows({ ...base, outcome: { ...veto, RecycledPath: location }, after: moved });
  eq(vetoedAfterMove.state, 'unknown', 'the item gone without reported success is unknown');
  ok(/matches it, but the helper did not report success/.test(vetoedAfterMove.reason) && /would delete permanently/.test(vetoedAfterMove.reason), `that reason says the entry matches and names the veto (got ${vetoedAfterMove.reason})`);
  const unconfirmed = (after) => classifyWindows({ ...base, outcome: success, after });
  const missingEntry = unconfirmed(noEntry);
  eq(missingEntry.state, 'unknown', 'a reported $R entry missing on disk is unknown');
  ok(/the reported Recycle Bin entry does not exist/.test(missingEntry.reason), `that reason says the entry is missing (got ${missingEntry.reason})`);
  const shortEntry = unconfirmed({ ...moved, locationCount: 4 });
  eq(shortEntry.state, 'unknown', 'a $R entry holding fewer entries is unknown');
  ok(/holds 4 entries, not the 5 the preflight counted/.test(shortEntry.reason), `that reason names the count (got ${shortEntry.reason})`);
  // A writer can add entries while the shell removes some, so a grown tree at the path does not prove nothing moved.
  const grown = classifyWindows({ ...base, outcome: veto, after: { ...intact, targetCount: 6 } });
  eq(grown.state, 'unknown', 'the item at its path holding more entries than the preflight counted is unknown');
  ok(/still at its path but holds 6 entries, not the 5 the preflight counted/.test(grown.reason), `that reason names both counts in order (got ${grown.reason})`);
  const otherOriginal = unconfirmed({ ...moved, infoOriginal: 'C:\\w\\other' });
  eq(otherOriginal.state, 'unknown', 'a $I record naming another original is unknown');
  ok(otherOriginal.reason.includes('records the original C:\\w\\other'), `that reason names the recorded original (got ${otherOriginal.reason})`);
  const unreadableInfo = unconfirmed({ ...moved, infoOriginal: null });
  eq(unreadableInfo.state, 'unknown', 'an unreadable $I record is unknown');
  ok(/no readable original path/.test(unreadableInfo.reason), `that reason names the unreadable record (got ${unreadableInfo.reason})`);
}

section('macOS classification: trashed, refused and unknown from fabricated helper output');
{
  const preIno = 42n;
  const gone = { ino: null, errno: 'ENOENT' };
  const intact = { ino: preIno, errno: null };
  const okOut = { ok: true, resultPath: '/Users/u/.Trash/tree', domain: null, code: null, message: null };
  const errOut = (code, message) => ({ ok: false, resultPath: null, domain: 'NSCocoaErrorDomain', code, message });
  const verified = classifyMacos({ preIno, output: okOut, failure: null, after: { target: gone, result: { ino: preIno, errno: null } } });
  eq(verified.state, 'trashed', 'the original gone and the resulting path holding its inode is trashed');
  eq(verified.verified, true, 'that result is verified');
  eq(verified.location, okOut.resultPath, 'the trashed result carries the resulting path');
  const unverified = classifyMacos({ preIno, output: okOut, failure: null, after: { target: gone, result: { ino: null, errno: 'EPERM' } } });
  eq(unverified.state, 'trashed', 'EPERM on the resulting path is trashed');
  eq(unverified.verified, false, 'that result is unverified');
  const noTrash = classifyMacos({ preIno, output: errOut(3328, 'not supported'), failure: null, after: { target: intact, result: null } });
  eq(noTrash.state, 'refused', 'NSCocoaErrorDomain 3328 with the item intact is refused');
  ok(/this volume has no trash/.test(noTrash.reason), `the refusal says the volume has no trash (got ${noTrash.reason})`);
  eq(classifyMacos({ preIno, output: null, failure: 'osascript was killed by SIGSEGV', after: { target: intact, result: null } }).state, 'refused', 'a crash with the item intact is refused');
  eq(classifyMacos({ preIno, output: null, failure: 'osascript timed out after 300000 ms', after: { target: gone, result: null } }).state, 'unknown', 'a timeout with the item gone is unknown');
  eq(classifyMacos({ preIno, output: null, failure: 'osascript was killed by SIGSEGV', after: { target: gone, result: null } }).state, 'unknown', 'a crash with the item gone is unknown');
  eq(classifyMacos({ preIno, output: errOut(513, 'denied'), failure: null, after: { target: gone, result: null } }).state, 'unknown', 'a reported error with the item gone is unknown');
  const copied = classifyMacos({ preIno, output: okOut, failure: null, after: { target: gone, result: { ino: 43n, errno: null } } });
  eq(copied.state, 'unknown', 'a resulting path with another inode is unknown');
  ok(/copy/.test(copied.reason), `the reason says it may be a copy (got ${copied.reason})`);
  eq(classifyMacos({ preIno, output: okOut, failure: null, after: { target: gone, result: { ino: null, errno: 'ENOENT' } } }).state, 'unknown', 'a missing resulting path is unknown');
  eq(classifyMacos({ preIno, output: { ...okOut, resultPath: null }, failure: null, after: { target: gone, result: null } }).state, 'unknown', 'success with no resulting path is unknown');
  eq(classifyMacos({ preIno, output: okOut, failure: null, after: { target: { ino: 7n, errno: null }, result: { ino: preIno, errno: null } } }).state, 'unknown', 'another item at the original path is unknown');
  const replaced = classifyMacos({ preIno, output: null, failure: 'osascript timed out after 300000 ms', after: { target: { ino: 7n, errno: null }, result: null } });
  eq(replaced.reason, 'another item now sits at its path (osascript timed out after 300000 ms)', 'that reason names the other item and the helper\'s failure');
  const crashedAfterMove = classifyMacos({ preIno, output: null, failure: 'osascript was killed by SIGSEGV', after: { target: gone, result: null } });
  eq(crashedAfterMove.reason, 'the item left its path, and its place in the trash is unconfirmed (osascript was killed by SIGSEGV)', 'a crash after the move names the crash');
  const errorAtResult = classifyMacos({ preIno, output: { ...errOut(513, 'denied'), resultPath: '/Users/u/.Trash/tree' }, failure: null, after: { target: gone, result: { ino: preIno, errno: null } } });
  eq(errorAtResult.state, 'unknown', 'a reported error with the item at the resulting path is unknown');
  ok(/at the resulting path, but osascript did not report success/.test(errorAtResult.reason) && /denied/.test(errorAtResult.reason), `that reason never claims another inode and names the error (got ${errorAtResult.reason})`);
}

section('macOS: a path in a cloud provider folder is refused before osascript runs');
{
  const homeReal = join(tmpdir(), 'home');
  const problem = (...parts) => macosProviderProblem({ target: join(homeReal, ...parts), homeReal });
  ok(/cloud provider folder/.test(problem('Library', 'CloudStorage', 'x') ?? ''), 'a path under ~/Library/CloudStorage is refused');
  ok(/cloud provider folder/.test(problem('Library', 'Mobile Documents', 'x') ?? ''), 'a path under ~/Library/Mobile Documents is refused');
  ok(/cloud provider folder/.test(problem('Library', 'CloudStorage') ?? ''), 'the CloudStorage folder itself is refused');
  // path.relative folds case by itself on Windows, so only a POSIX run proves this check folds case.
  ok(/cloud provider folder/.test(problem('library', 'cloudstorage', 'x') ?? ''), 'the check folds case, as macOS names do');
  eq(problem('Library', 'CloudStorageOld', 'x'), null, 'a sibling whose name starts with CloudStorage passes');
  eq(problem('Documents', 'x'), null, 'another path under the home directory passes');
}

section('a helper spawn error says whether the helper ran');
{
  const spawnError = (code) => ({ error: Object.assign(new Error(`spawnSync pwsh.exe ${code}`), { code }), status: null, signal: null, stderr: '' });
  ok(/^pwsh\.exe did not run \(/.test(spawnFailure('pwsh.exe', spawnError('EACCES'))), 'EACCES means the helper never ran');
  ok(/^pwsh\.exe did not run \(/.test(spawnFailure('pwsh.exe', spawnError('EPERM'))), 'EPERM, which Windows reports for an executable the user may not run, means the helper never ran');
  const overflow = spawnFailure('pwsh.exe', spawnError('ENOBUFS'));
  ok(/^pwsh\.exe failed \(.*ENOBUFS/.test(overflow), `ENOBUFS, raised after the helper started, is not reported as never run (got ${overflow})`);
}

section('the PowerShell hosts: powershell.exe runs only when pwsh.exe never started');
{
  /** A spawn stub that fails each host named in `codes` with that code and runs the others, recording each call. */
  const stubSpawn = (codes, calls) => (host) => {
    calls.push(host);
    if (!codes[host]) return { error: undefined, status: 0, signal: null, stdout: `{"Host":"${host}"}`, stderr: '' };
    return { error: Object.assign(new Error(`spawnSync ${host} ${codes[host]}`), { code: codes[host] }), status: null, signal: null, stdout: null, stderr: null };
  };
  const hostsRun = (codes) => {
    const calls = [];
    const run = runPowerShell('C:\\w\\tree', {}, stubSpawn(codes, calls));
    return { calls, run };
  };
  const installed = hostsRun({});
  eq(installed.calls.join(), 'pwsh.exe', 'a pwsh.exe that starts is the only host run');
  for (const code of ['ENOENT', 'EACCES', 'EPERM']) {
    const fallback = hostsRun({ 'pwsh.exe': code });
    eq(fallback.calls.join(), 'pwsh.exe,powershell.exe', `a pwsh.exe that fails with ${code} never started, so powershell.exe runs`);
    eq(fallback.run.stdout, '{"Host":"powershell.exe"}', `the output is powershell.exe's after ${code}`);
    eq(fallback.run.failure, null, `no failure is reported once powershell.exe ran after ${code}`);
  }
  const overflow = hostsRun({ 'pwsh.exe': 'ENOBUFS' });
  eq(overflow.calls.join(), 'pwsh.exe', 'a pwsh.exe that may have acted is never followed by powershell.exe');
  ok(/^pwsh\.exe failed \(/.test(overflow.run.failure ?? ''), `that failure is pwsh.exe's (got ${overflow.run.failure})`);
  const neither = hostsRun({ 'pwsh.exe': 'ENOENT', 'powershell.exe': 'ENOENT' });
  ok(/^pwsh\.exe did not run \(.*\), powershell\.exe did not run \(/.test(neither.run.failure ?? ''), `with no host started, the failure names both (got ${neither.run.failure})`);
}

section('the mountinfo parser unescapes octal and decodes UTF-8 mount points');
{
  const mounts = parseMountinfo(Buffer.from([
    '22 1 0:21 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
    '36 22 0:32 / /mnt/my\\040disk/\u00fcn\u00ef rw,relatime shared:5 master:2 - cifs //srv/share rw',
    '37 22 0:33 / /mnt/back\\134slash rw - tmpfs tmpfs rw',
    'not a mountinfo line',
    '',
  ].join('\n'), 'utf8'));
  eq(mounts.get('/')?.fstype, 'ext4', 'the root mount is read');
  eq(mounts.get('/mnt/my disk/\u00fcn\u00ef')?.fstype, 'cifs', 'an escaped space and a UTF-8 name decode, past two optional fields');
  eq(mounts.get('/mnt/back\\slash')?.fstype, 'tmpfs', 'an escaped backslash decodes');
  eq(mounts.size, 3, 'a line with no separator is skipped');
}

section('the $I record parser reads version 2 and strips the long-path prefix');
{
  const record = (version, original) => {
    const chars = original.length + 1;
    const buffer = Buffer.alloc(28 + chars * 2);
    buffer.writeBigInt64LE(BigInt(version), 0);
    buffer.writeBigInt64LE(1234n, 8);
    buffer.writeInt32LE(chars, 24);
    buffer.write(original, 28, 'utf16le');
    return buffer;
  };
  eq(parseRecycleInfo(record(2, 'C:\\w\\tree \u00fc')), 'C:\\w\\tree \u00fc', 'a version 2 record yields its original path');
  eq(parseRecycleInfo(record(2, '\\\\?\\C:\\long\\tree')), 'C:\\long\\tree', 'a \\\\?\\ prefix is stripped');
  eq(parseRecycleInfo(record(2, '\\\\?\\UNC\\srv\\share\\tree')), '\\\\srv\\share\\tree', 'a \\\\?\\UNC\\ prefix becomes \\\\');
  eq(parseRecycleInfo(record(1, 'C:\\w\\tree')), null, 'a version 1 record is not read');
  eq(parseRecycleInfo(record(2, 'C:\\w\\tree').subarray(0, 32)), null, 'a truncated record is not read');
}

section('CLI exit codes: 0 trashed, 1 usage, 2 refused, 3 unknown');
{
  const fx = makeFixture();
  try {
    const kept = join(fx.work, 'kept');
    const gone = join(fx.work, 'gone');
    makeTree(kept, 'k');
    makeTree(gone, 'g');
    const noArgs = trashCli([], xdgEnv(fx));
    eq(noArgs.code, 1, 'no path is a usage error, exit 1');
    ok(/usage:/.test(noArgs.stderr), 'stderr prints the usage line');
    const badBackend = trashCli([kept], { ...xdgEnv(fx), AIPG_TRASH_BACKEND: 'bogus' });
    eq(badBackend.code, 1, 'an unknown AIPG_TRASH_BACKEND is a usage error, exit 1');
    ok(/AIPG_TRASH_BACKEND/.test(badBackend.stderr), 'stderr names the variable');
    eq(readOr(join(kept, 'sub', 'marker.txt')), 'k', 'a usage error touches no path');
    const mixed = trashCli([gone, 'rel/dir'], xdgEnv(fx));
    eq(mixed.code, 2, 'one trashed and one refused path exit 2');
    ok(!existsSync(gone), 'the path before the refused one was still trashed');
    ok(/refused: the path is relative: rel\/dir/.test(mixed.stderr), 'stderr names the refused path and its cause');
    eq(mixed.stdout, `${join(fx.trash, 'files', 'gone')}\n`, 'stdout lists only the trashed location');
    // A helper's exception text or a Linux file name can hold line breaks, as this path does.
    const broken = trashCli([join(fx.work, 'missing\r\n   at name')], xdgEnv(fx));
    eq(broken.code, 2, 'a missing path holding line breaks is refused, exit 2');
    eq(broken.stderr.split(/\r\n|\r|\n/).length, 2, `a reason holding line breaks is one stderr line (got ${JSON.stringify(broken.stderr)})`);
    ok(broken.stderr.includes('missing\\r\\n   at name'), 'the record shows the line breaks escaped');
    eq(exitCodeFor(['trashed', 'trashed']), 0, 'every path trashed maps to 0');
    eq(exitCodeFor(['trashed', 'refused']), 2, 'a refused path with none unknown maps to 2');
    eq(exitCodeFor(['refused', 'unknown', 'trashed']), 3, 'any unknown path maps to 3');
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
}

if (process.env.AIPG_TRASH_LIVE === '1') {
  const liveEnv = { ...process.env };
  delete liveEnv.AIPG_TRASH_BACKEND;
  /** Trashes a new tree at `dir` through the real backend and checks that it left its path for the reported location. */
  const liveTrash = (dir) => {
    makeTree(dir, 'live');
    const r = trashCli([dir], liveEnv);
    eq(r.code, 0, `exit 0 (stderr: ${r.stderr.trim()})`);
    ok(!existsSync(dir), 'the directory left its path');
    // macOS denies reading ~/.Trash without Full Disk Access, and the CLI then marks the location unverified.
    const unverified = r.stderr.includes('(unverified, the trash is not readable)');
    ok(r.stdout.trim() !== '' && (unverified || existsSync(r.stdout.trim())), `the reported trash location exists or is marked unverified (${r.stdout.trim()})`);
  };
  section('live: the real platform backend trashes a temp directory');
  const fx = makeFixture();
  try { liveTrash(join(fx.work, 'aipg-trash-live')); } finally { rmSync(fx.root, { recursive: true, force: true }); }
  if (process.platform === 'win32') {
    section('live: the Windows backend trashes a path of MAX_PATH or more, which the shell under pwsh reports in its 8.3 form');
    const deep = makeFixture();
    try { liveTrash(join(deep.work, 'x'.repeat(120), 'y'.repeat(120), 'aipg-trash-live')); } finally { rmSync(deep.root, { recursive: true, force: true }); }
    section('live: the Windows helper refuses a path the shell parses as another item');
    const dotted = makeFixture();
    try {
      makeTree(join(dotted.work, 'name'), 'plain');
      makeTree(join(dotted.work, 'name.'), 'dotted');
      // The helper runs directly, since the preflight refuses this name before any helper sees it.
      const run = runPowerShell(join(dotted.work, 'name.'), process.env);
      const outcome = JSON.parse(String(run.stdout).trim().split(/\r?\n/).pop() || 'null');
      ok(outcome?.Success === false && /the shell parses the path as .*\\name$/.test(outcome.Error ?? ''), `the helper names the parsed path and recycles nothing (got ${run.stdout.trim()})`);
      eq(readOr(join(dotted.work, 'name', 'sub', 'marker.txt')), 'plain', 'the item the shell parsed is still in place');
      eq(readOr(join(dotted.work, 'name.', 'sub', 'marker.txt')), 'dotted', 'the named item is still in place');
    } finally { rmSync(dotted.root, { recursive: true, force: true }); }
  }
} else {
  console.log('  live backend cases skipped (set AIPG_TRASH_LIVE=1 to run them, which trashes temp directories into the real trash)');
}
