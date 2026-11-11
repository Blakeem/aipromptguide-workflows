// tools/wt.mjs --state-dir: close and clean move each named state dir's scratch folder to the trash with the worktree.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { TRASH_STUB, wt, wtStubbed, norm, firstLine, readOr, worktreePaths, sha, withFixture, trashedName, trashedAt, batchOf, commitFile, gateCmd, GATE_GREEN, opened, ledgerGate, ledgerRuns, unchanged, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

const LOG = 'log\n';
const UID = typeof process.getuid === 'function' ? process.getuid() : null;

/** A run state dir under the fixture root that holds a scratch folder beside the entries that must outlive it. */
function stateDir(root, name) {
  const dir = join(root, 'runs', name);
  mkdirSync(join(dir, 'scratch', 'sub'), { recursive: true });
  writeFileSync(join(dir, 'scratch', 'sub', 'gate.log'), LOG);
  mkdirSync(join(dir, 'gate'));
  writeFileSync(join(dir, 'gate', 'DISMISSED-x.md'), 'dismissed\n');
  writeFileSync(join(dir, 'DECISIONS.md'), 'decisions\n');
  return dir;
}

/** The state dir's scratch folder is in the trash with its files, and every other entry of the state dir is as it was. */
function scratchTrashed(root, dir, what) {
  const scratch = join(dir, 'scratch');
  ok(!existsSync(scratch), `${what}: the scratch folder left ${dir}`);
  eq(readOr(trashedAt(root, scratch, 'sub', 'gate.log')), LOG, '...and is in the trash with its files');
  eq(readOr(join(dir, 'gate', 'DISMISSED-x.md')), 'dismissed\n', '...the gate folder is as it was');
  eq(readOr(join(dir, 'DECISIONS.md')), 'decisions\n', '...as is DECISIONS.md');
  eq(readdirSync(dir).sort().join(','), 'DECISIONS.md,gate', '...and the state dir holds no other change');
}

/** The state dir's scratch folder is still in place and out of the trash. */
function scratchKept(root, dir, what) {
  eq(readOr(join(dir, 'scratch', 'sub', 'gate.log')), LOG, `${what}: the scratch folder is still in ${dir}`);
  eq(trashedName(root, join(dir, 'scratch')), '', '...and not in the trash');
}

section('close that lands a run and close --discard trash each --state-dir scratch folder after the worktree');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);

  const landed = opened(repo, 'landed');
  const tip = commitFile(landed, 'l.txt', 'landed\n');
  const landedDir = stateDir(root, 'landed');
  const close = wt(['close', '--repo', repo, '--name', 'landed', '--into', 'main', '--gate', gate, '--state-dir', landedDir]);
  eq(close.code, 0, `close --state-dir exits 0 (${firstLine(close.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, '...main took the run');
  ok(trashedName(root, landed) !== '', '...the worktree is in the trash');
  ok(close.stderr.includes(`moved ${join(landedDir, 'scratch')} to the trash`), '...stderr names the scratch move');
  eq(norm(close.stdout.trim()), norm(landed), '...stdout carries only the worktree path');
  scratchTrashed(root, landedDir, 'close');

  const dropped = opened(repo, 'dropped');
  writeFileSync(join(dropped, 'wip.txt'), 'wip\n');
  const droppedDir = stateDir(root, 'dropped');
  const discard = wt(['close', '--repo', repo, '--name', 'dropped', '--discard', '--state-dir', droppedDir]);
  eq(discard.code, 0, `close --discard --state-dir exits 0 (${firstLine(discard.stderr)})`);
  ok(trashedName(root, dropped) !== '', '...the worktree is in the trash');
  ok(sha(repo, 'refs/heads/aipg/dropped') !== '', '...the branch is kept');
  scratchTrashed(root, droppedDir, 'close --discard');
});

section('clean --key and clean --batch trash each --state-dir scratch folder, and --state-dir may repeat');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha']);

  const alphaDir = stateDir(root, 'alpha');
  const key = wt(['clean', '--repo', repo, '--key', 'alpha', '--state-dir', alphaDir]);
  eq(key.code, 0, `clean --key --state-dir exits 0 (${firstLine(key.stderr)})`);
  ok(trashedName(root, chains.alpha) !== '', '...the chain worktree is in the trash');
  scratchTrashed(root, alphaDir, 'clean --key');

  const firstDir = stateDir(root, 'first');
  const secondDir = stateDir(root, 'second');
  const batch = wt(['clean', '--repo', repo, '--batch', 'b1', '--state-dir', firstDir, '--state-dir', secondDir]);
  eq(batch.code, 0, `clean --batch with two --state-dir exits 0 (${firstLine(batch.stderr)})`);
  ok(!worktreePaths(repo).includes(norm(intWt)), '...the integration worktree is gone');
  scratchTrashed(root, firstDir, 'clean --batch, the first state dir');
  scratchTrashed(root, secondDir, 'clean --batch, the second state dir');
});

section('a state dir with no scratch folder, a state dir given twice and no --state-dir each exit as before');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['bare', 'file', 'twice', 'none']);

  const bareDir = join(root, 'runs', 'bare');
  mkdirSync(bareDir, { recursive: true });
  writeFileSync(join(bareDir, 'DECISIONS.md'), 'decisions\n');
  const bare = wt(['clean', '--repo', repo, '--key', 'bare', '--state-dir', bareDir]);
  eq(bare.code, 0, `clean --key with a state dir that holds no scratch folder exits 0 (${firstLine(bare.stderr)})`);
  ok(trashedName(root, chains.bare) !== '', '...the chain worktree is in the trash');
  ok(bare.stderr.includes(`no scratch folder in ${bareDir}`), '...stderr says no scratch folder went');
  eq(readdirSync(bareDir).join(','), 'DECISIONS.md', '...and the state dir is as it was');

  // POSIX lstat of a path under a file fails with ENOTDIR, where Windows reports the path missing.
  const fileDir = join(root, 'runs', 'file.txt');
  writeFileSync(fileDir, 'not a folder\n');
  const file = wt(['clean', '--repo', repo, '--key', 'file', '--state-dir', fileDir]);
  eq(file.code, 0, `clean --key with a state dir that is a file exits 0 (${firstLine(file.stderr)})`);
  ok(file.stderr.includes(`no scratch folder in ${fileDir}`), '...stderr says no scratch folder went');
  eq(readOr(fileDir), 'not a folder\n', '...and the file is as it was');

  const twiceDir = stateDir(root, 'twice');
  const twice = wt(['clean', '--repo', repo, '--key', 'twice', '--state-dir', twiceDir, '--state-dir', twiceDir]);
  eq(twice.code, 0, `clean --key with one state dir given twice exits 0 (${firstLine(twice.stderr)})`);
  ok(!twice.stderr.includes('no scratch folder'), '...and trashes its scratch folder once');
  scratchTrashed(root, twiceDir, 'a state dir given twice');

  const none = wt(['clean', '--repo', repo, '--key', 'none']);
  eq(none.code, 0, `clean --key with no --state-dir exits 0 (${firstLine(none.stderr)})`);
  ok(!/scratch/.test(none.stderr), '...and names no scratch folder');
});

section('a relative --state-dir is a usage error that leaves the worktree, the branch and every state dir as they were');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const worktree = opened(repo, 'rel');
  const branchAt = commitFile(worktree, 'r.txt', 'rel\n');
  const mainAt = sha(repo, 'refs/heads/main');
  const dir = stateDir(root, 'rel');

  const close = wt(['close', '--repo', repo, '--name', 'rel', '--into', 'main', '--gate', gate, '--state-dir', dir, '--state-dir', 'runs/rel']);
  eq(close.code, 1, `close with a relative --state-dir exits 1 (${firstLine(close.stderr)})`);
  ok(/--state-dir "runs\/rel" must be an ABSOLUTE path/.test(close.stderr), '...naming the flag and its value');
  unchanged(root, repo, worktree, 'rel', mainAt, branchAt);
  scratchKept(root, dir, 'a refused close');

  const discard = wt(['close', '--repo', repo, '--name', 'rel', '--discard', '--state-dir', 'runs/rel']);
  eq(discard.code, 1, `close --discard with a relative --state-dir exits 1 (${firstLine(discard.stderr)})`);
  unchanged(root, repo, worktree, 'rel', mainAt, branchAt);

  const { chains } = batchOf(root, repo, ['alpha']);
  const clean = wt(['clean', '--repo', repo, '--key', 'alpha', '--state-dir', 'runs/rel']);
  eq(clean.code, 1, `clean --key with a relative --state-dir exits 1 (${firstLine(clean.stderr)})`);
  ok(/--state-dir "runs\/rel" must be an ABSOLUTE path/.test(clean.stderr), '...naming the flag and its value');
  ok(worktreePaths(repo).includes(norm(chains.alpha)), '...the chain worktree is still registered');
  eq(trashedName(root, chains.alpha), '', '...and out of the trash');
  scratchKept(root, dir, 'a refused clean');
});

section('a refused scratch trash exits 40 naming its cause, and the same close run again trashes it with no second gate');
await withFixture(({ root, repo }) => {
  const ledger = join(root, 'gate-runs.txt');
  const gate = ledgerGate(root, ledger);
  const worktree = opened(repo, 'held');
  const tip = commitFile(worktree, 'h.txt', 'held\n');
  const dir = stateDir(root, 'held');
  const argv = ['close', '--repo', repo, '--name', 'held', '--into', 'main', '--gate', gate, '--state-dir', dir];

  const refused = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'held', AIPG_TRASH_STUB_ONLY: 'scratch' });
  eq(refused.code, 40, `a refused scratch trash exits 40 (${firstLine(refused.stderr)})`);
  ok(/the trash refused the scratch folder at .*\(.*a process holds the folder or a file in it.*To clear the cause, end the holding process, then run this command again\.$/m.test(refused.stderr),
    `...naming the cause, its clearing action and the rerun: ${refused.stderr.trim().split('\n').pop()}`);
  eq(sha(repo, 'refs/heads/main'), tip, '...after main took the run');
  ok(trashedName(root, worktree) !== '', '...and the worktree went to the trash');
  scratchKept(root, dir, 'a refused scratch trash');
  eq(ledgerRuns(ledger).length, 1, '...the gate ran once');

  const again = wt(argv);
  eq(again.code, 0, `the same close run again exits 0 (${firstLine(again.stderr)})`);
  eq(ledgerRuns(ledger).length, 1, '...and runs no second gate');
  scratchTrashed(root, dir, 'the close run again');
});

section('a scratch folder too long for the Recycle Bin names a move and trash for a folder that is no worktree');
await withFixture(({ root, repo }) => {
  batchOf(root, repo, ['alpha']);
  const dir = stateDir(root, 'long');
  const argv = ['clean', '--repo', repo, '--key', 'alpha', '--state-dir', dir];

  const refused = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPath', AIPG_TRASH_STUB_ONLY: 'scratch' });
  eq(refused.code, 40, `clean --key with a scratch path too long exits 40 (${firstLine(refused.stderr)})`);
  ok(/move the folder to a shorter path and trash it there with node .*trash\.mjs.* <shorter path>, then run this command again\.$/m.test(refused.stderr),
    `...naming the move and trash: ${refused.stderr.trim().split('\n').pop()}`);
  ok(!/worktree move/.test(refused.stderr), '...and no git worktree move');
  scratchKept(root, dir, 'a scratch path too long');

  const again = wt(argv);
  eq(again.code, 0, `the same clean run again exits 0 (${firstLine(again.stderr)})`);
  scratchTrashed(root, dir, 'the clean run again');
});

section('a scratch trash the trash cannot confirm exits 40, and the same command run again exits 0');
await withFixture(({ root, repo }) => {
  const worktree = opened(repo, 'lost');
  const dir = stateDir(root, 'lost');
  const argv = ['close', '--repo', repo, '--name', 'lost', '--discard', '--state-dir', dir];

  const unknown = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'unknown', AIPG_TRASH_STUB_ONLY: 'scratch' });
  eq(unknown.code, 40, `an unconfirmed scratch trash exits 40 (${firstLine(unknown.stderr)})`);
  ok(/could not confirm where the scratch folder at .* went .*Check the trash for it, then run this command again\.$/m.test(unknown.stderr),
    `...saying to check the trash and run the command again: ${unknown.stderr.trim().split('\n').pop()}`);
  ok(trashedName(root, worktree) !== '', '...after the worktree went to the trash');

  const again = wt(argv);
  eq(again.code, 0, `the same close --discard run again exits 0 (${firstLine(again.stderr)})`);
  ok(again.stderr.includes(`no scratch folder in ${dir}`), '...finding the scratch folder gone from its path');
});

section('a scratch link exits 40 naming the removal of the link itself, and leaves the folder it points to untouched');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const dir = join(root, 'runs', 'linked');
  const target = join(root, 'elsewhere');
  mkdirSync(dir, { recursive: true });
  mkdirSync(target);
  writeFileSync(join(target, 'keep.txt'), LOG);
  const link = join(dir, 'scratch');
  // A junction needs no privilege on Windows, and POSIX ignores the type and makes a symbolic link.
  symlinkSync(target, link, 'junction');
  const argv = ['clean', '--repo', repo, '--key', 'alpha', '--state-dir', dir];

  const refused = wt(argv);
  eq(refused.code, 40, `clean --key with a scratch link exits 40 (${firstLine(refused.stderr)})`);
  ok(/the trash refused the scratch link at .*\(the path is a symbolic link or junction\).*To clear the cause, remove the link itself, which leaves the folder it points to in place, then run this command again\.$/m.test(refused.stderr),
    `...naming the link and its removal: ${refused.stderr.trim().split('\n').pop()}`);
  ok(!/deletes it permanently/.test(refused.stderr), '...and no permanent delete of a folder');
  ok(trashedName(root, chains.alpha) !== '', '...after the chain worktree went to the trash');
  ok(lstatSync(link).isSymbolicLink(), '...the link is still in place');
  eq(readOr(join(target, 'keep.txt')), LOG, '...and the folder it points to is untouched');

  unlinkSync(link);
  const again = wt(argv);
  eq(again.code, 0, `the same clean run again exits 0 (${firstLine(again.stderr)})`);
  ok(again.stderr.includes(`no scratch folder in ${dir}`), '...finding no scratch entry');
  eq(readOr(join(target, 'keep.txt')), LOG, '...and the folder the link pointed to is still untouched');
});

section('a scratch path that cannot be read exits 40 naming the error, and the same command run again trashes it');
if (process.platform !== 'win32' && UID === 0) {
  console.log('    (skipped as root: no permission bit stops root from reading a directory)');
} else {
  await withFixture(({ root, repo }) => {
    const worktree = opened(repo, 'locked');
    const dir = stateDir(root, 'locked');
    const argv = ['close', '--repo', repo, '--name', 'locked', '--discard', '--state-dir', dir];
    // Windows ignores the mode bits, so a deny entry for Everyone stops the read there.
    const setLocked = (on) => {
      if (process.platform !== 'win32') chmodSync(dir, on ? 0o000 : 0o700);
      else execFileSync('icacls', on ? [dir, '/deny', '*S-1-1-0:(OI)(CI)(RX)'] : [dir, '/remove:d', '*S-1-1-0'], { stdio: 'pipe' });
    };

    setLocked(true);
    let refused = null;
    try {
      refused = wt(argv);
    } finally {
      setLocked(false);
    }
    eq(refused.code, 40, `close --discard with an unreadable state dir exits 40 (${firstLine(refused.stderr)})`);
    ok(/every step before the scratch trash is done, but reading the scratch folder at .* failed \(E(ACCES|PERM).*To clear the cause, act on that error, then run this command again\.$/m.test(refused.stderr),
      `...naming the error and the rerun: ${refused.stderr.trim().split('\n').pop()}`);
    ok(trashedName(root, worktree) !== '', '...after the worktree went to the trash');
    scratchKept(root, dir, 'an unreadable state dir');

    const again = wt(argv);
    eq(again.code, 0, `the same close --discard run again exits 0 (${firstLine(again.stderr)})`);
    scratchTrashed(root, dir, 'the close --discard run again');
  });
}

section('clean --batch whose scratch folder the real trash refuses exits 40, and runs again once the cause is cleared');
await withFixture(({ root, repo }) => {
  const { intWt } = batchOf(root, repo, []);
  const dir = stateDir(root, 'nested');
  // The trash refuses a tree that holds a folder with a trash name.
  const inner = join(dir, 'scratch', '.Trash');
  mkdirSync(inner);
  const argv = ['clean', '--repo', repo, '--batch', 'b1', '--state-dir', dir];

  const refused = wt(argv);
  eq(refused.code, 40, `clean --batch with a scratch folder the trash refuses exits 40 (${firstLine(refused.stderr)})`);
  ok(/the trash refused the scratch folder at .*\(the path contains a trash\).*To clear the cause, act on the reason the trash names, then run this command again\.$/m.test(refused.stderr),
    `...naming the reason: ${refused.stderr.trim().split('\n').pop()}`);
  ok(!worktreePaths(repo).includes(norm(intWt)), '...after the integration worktree was removed');
  scratchKept(root, dir, 'a refused clean --batch');

  renameSync(inner, join(dir, 'scratch', 'inner'));
  const again = wt(argv);
  eq(again.code, 0, `the same clean --batch run again exits 0 (${firstLine(again.stderr)})`);
  scratchTrashed(root, dir, 'the clean --batch run again');
});

}
