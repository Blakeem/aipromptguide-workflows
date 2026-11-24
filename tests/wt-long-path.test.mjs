// tools/wt.mjs close and clean: a worktree the trash refuses for a path too long for the Recycle Bin moves once to a short path.
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import * as wtTool from '../tools/wt.mjs';
import { TRASH_STUB, WT_ROOT, wt, wtStubbed, git, norm, firstLine, worktreePaths, sha, withFixture, trashedNames, commitFile, ledgerGate, ledgerRuns, opened, batchOf, under, fixtureEnv, homeRuleEnv, hasGit } from './wt-helpers.mjs';

// Read defensively, so a tool without the export fails these assertions and not the entire file.
const sharesPathRoot = wtTool.sharesPathRoot ?? (() => null);
const moveWorktree = wtTool.moveWorktree ?? (() => null);
const SHORT_NAME = 'aipg-_000000';
const MOVED = /moved the worktree from (.+) to (.+), since the trash refused it/;
const refusedAt = (stderr) => [...stderr.matchAll(/the trash refused the worktree at (.+?) \(/g)].map((m) => norm(m[1]));

/**
 * The four removals in the order one fixture can run them: close, close --discard, clean --key, then clean --batch
 * once its chain is gone. Each `make` creates the worktree and returns its path, its argv and a file it holds.
 */
function removals(root, repo, gate) {
  return [
    {
      verb: 'close', branch: 'aipg/feat', keepsBranch: false, projectGone: true,
      make: () => {
        const path = opened(repo, 'feat');
        commitFile(path, 'f.txt', 'feature\n');
        return { path, file: 'f.txt', argv: ['close', '--repo', repo, '--name', 'feat', '--into', 'main', '--gate', gate] };
      },
    },
    {
      verb: 'close --discard', branch: 'aipg/disc', keepsBranch: true, projectGone: true,
      make: () => {
        const path = opened(repo, 'disc');
        writeFileSync(join(path, 'u.txt'), 'uncommitted\n');
        return { path, file: 'u.txt', argv: ['close', '--repo', repo, '--name', 'disc', '--discard'] };
      },
    },
    {
      verb: 'clean --key', branch: 'aipg/b1/k1', keepsBranch: true, projectGone: false,
      make: () => ({ path: batchOf(root, repo, ['k1']).chains.k1, file: 'a.txt', argv: ['clean', '--repo', repo, '--key', 'k1'] }),
    },
    {
      verb: 'clean --batch', branch: 'aipg/int-b1', keepsBranch: true, projectGone: true,
      make: () => ({ path: under(repo, 'aipg-int-b1'), file: 'a.txt', argv: ['clean', '--repo', repo, '--batch', 'b1'] }),
    },
  ];
}

/** Asserts the worktree on `removal.branch` is gone from `paths` and the registration, with the branch as the verb leaves it. */
function assertRemoved(root, repo, removal, paths, trashedBefore, short) {
  for (const path of paths) ok(!existsSync(path) && !worktreePaths(repo).includes(norm(path)), `...${path} is gone and not registered`);
  eq(trashedNames(root, short).length, trashedBefore + 1, '...the folder went to the trash from the short path');
  eq(sha(repo, `refs/heads/${removal.branch}`) !== '', removal.keepsBranch, `...${removal.branch} is ${removal.keepsBranch ? 'kept' : 'deleted'}`);
  if (removal.projectGone) ok(!existsSync(under(repo)), '...and the empty project folder is removed');
}

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('sharesPathRoot tells a second drive or share from the same one without a second volume');
eq(sharesPathRoot('E:\\aipg-wt\\p\\aipg-x', 'e:/aipg-wt', 'win32'), true, 'two paths on one drive, in either case and separator, share a root');
eq(sharesPathRoot('E:\\aipg-wt', 'D:\\aipg-wt', 'win32'), false, 'two drives do not');
eq(sharesPathRoot('\\\\server\\share\\a', '\\\\server\\share\\b\\c', 'win32'), true, 'two paths on one share do');
eq(sharesPathRoot('\\\\server\\share\\a', 'E:\\a', 'win32'), false, 'a share and a drive do not');
eq(sharesPathRoot('/home/u/aipg-wt', '/tmp/x', 'linux'), true, 'every absolute POSIX path shares the root /');

section('close, close --discard, clean --key and clean --batch move a worktree the trash refuses for length to a short path and trash it there');
await withFixture(({ root, repo }) => {
  const gate = ledgerGate(root, join(root, 'gate-runs.txt'));
  const short = join(root, WT_ROOT, SHORT_NAME);
  for (const removal of removals(root, repo, gate)) {
    const { path, argv } = removal.make();
    const trashedBefore = trashedNames(root, short).length;
    const r = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPath', AIPG_TRASH_STUB_ONLY: basename(path) });
    const moved = MOVED.exec(r.stderr);
    eq(r.code, 0, `${removal.verb} exits 0 when the trash refuses the first path for length and accepts the short one (${firstLine(r.stderr)})`);
    eq(norm(moved?.[1] ?? ''), norm(path), '...stderr names the move from the first path');
    eq(norm(moved?.[2] ?? ''), norm(short), '...to the short path in the worktree root folder');
    eq(norm(r.stdout.trim()), norm(path), '...stdout prints the first path');
    assertRemoved(root, repo, removal, [path, short], trashedBefore, short);
  }
});

section('a short path the trash refuses too exits 40 with the worktree there, and the same command run again moves nothing and finishes once the trash accepts');
await withFixture(({ root, repo }) => {
  const ledger = join(root, 'gate-runs.txt');
  const gate = ledgerGate(root, ledger);
  const short = join(root, WT_ROOT, SHORT_NAME);
  for (const removal of removals(root, repo, gate)) {
    const { path, file, argv } = removal.make();
    const trashedBefore = trashedNames(root, short).length;
    const refused = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPath' });
    eq(refused.code, 40, `${removal.verb} exits 40 when the trash refuses both paths (${firstLine(refused.stderr)})`);
    ok(worktreePaths(repo).includes(norm(short)) && !worktreePaths(repo).includes(norm(path)), '...with the worktree registered at the short path');
    ok(existsSync(join(short, file)), `...holding its file ${file}`);
    eq(refusedAt(refused.stderr).at(-1) ?? '', norm(short), '...the refusal names the short path');
    ok(!/worktree move/.test(refused.stderr), '...and tells the operator to run no git worktree move');
    const gateRuns = ledgerRuns(ledger).length;

    const again = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPath' });
    eq(again.code, 40, `the same ${removal.verb} run again exits 40 (${firstLine(again.stderr)})`);
    ok(!MOVED.test(again.stderr) && worktreePaths(repo).includes(norm(short)), '...making no second move');

    const finished = wt(argv);
    eq(finished.code, 0, `once the trash accepts, the same ${removal.verb} exits 0 (${firstLine(finished.stderr)})`);
    eq(ledgerRuns(ledger).length, gateRuns, '...running no gate');
    assertRemoved(root, repo, removal, [path, short], trashedBefore, short);
  }
});

section('a git worktree move that fails exits 40 with the worktree registered at its first path');
await withFixture(({ root, repo }) => {
  const gate = ledgerGate(root, join(root, 'gate-runs.txt'));
  const short = join(root, WT_ROOT, SHORT_NAME);
  for (const removal of removals(root, repo, gate)) {
    const { path, file, argv } = removal.make();
    const r = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPathLocked' });
    eq(r.code, 40, `${removal.verb} exits 40 when the move fails (${firstLine(r.stderr)})`);
    ok(/git worktree move to .+ failed: fatal: .*locked/.test(r.stderr), `...carrying git's reason: ${firstLine(r.stderr)}`);
    ok(worktreePaths(repo).includes(norm(path)) && existsSync(join(path, file)), '...with the worktree registered at its first path with its files');
    ok(!existsSync(short), '...and nothing at the short path');
    eq(git(repo, ['worktree', 'unlock', path]).code, 0, 'unlock the worktree');
    eq(wt(argv).code, 0, `...and the same ${removal.verb} then exits 0`);
  }
});

section('a worktree no longer than the short path, and a refusal for another cause or an unknown outcome, move nothing');
await withFixture(({ root, repo }) => {
  const near = opened(repo, 'x', ['--dir', root]);
  const nearRun = wtStubbed(TRASH_STUB, ['close', '--repo', repo, '--name', 'x', '--discard'], { AIPG_TRASH_STUB: 'longPath' });
  eq(nearRun.code, 40, `a worktree whose path is not longer than the short path exits 40 (${firstLine(nearRun.stderr)})`);
  ok(!MOVED.test(nearRun.stderr) && worktreePaths(repo).includes(norm(near)), '...unmoved and registered at its first path');
  ok(/too long for this volume's Recycle Bin.*A shorter --dir given to open or init keeps later worktrees short\. To clear the cause, move the deepest ignored folder in .+, such as a dependency folder, to a shorter path and trash it there with node .+ <shorter path>, then run this command again\.$/m.test(nearRun.stderr),
    `...naming the cause and its clearing action: ${firstLine(nearRun.stderr)}`);
  eq(wt(['close', '--repo', repo, '--name', 'x', '--discard']).code, 0, '...and the same discard exits 0 once the trash accepts');

  for (const outcome of ['held', 'denied', 'unknown']) {
    const path = opened(repo, outcome);
    const r = wtStubbed(TRASH_STUB, ['close', '--repo', repo, '--name', outcome, '--discard'], { AIPG_TRASH_STUB: outcome });
    eq(r.code, 40, `a trash outcome ${outcome} exits 40 (${firstLine(r.stderr)})`);
    ok(!MOVED.test(r.stderr) && !existsSync(join(root, WT_ROOT, SHORT_NAME)), '...and moves nothing');
    ok(worktreePaths(repo).includes(norm(path)), '...with the worktree registered at its first path');
  }
});

section('a worktree root folder the move can neither read nor create exits 40 with the worktree at its first path');
await withFixture(({ root, repo }) => {
  const path = opened(repo, 'feat');
  const file = join(root, 'afile');
  writeFileSync(file, 'not a folder\n');
  const argv = ['close', '--repo', repo, '--name', 'feat', '--discard'];
  const stub = { AIPG_TRASH_STUB: 'longPath', AIPG_TRASH_STUB_ONLY: basename(path) };

  const unread = wtStubbed(TRASH_STUB, argv, { ...stub, AIPG_WT_ROOT: file });
  eq(unread.code, 40, `a worktree root folder that is a file exits 40 (${firstLine(unread.stderr)})`);
  ok(/reading the folder .+ to move it to a shorter path failed \(.+\), so it stays registered and intact/.test(unread.stderr), '...naming the read that failed');
  ok(worktreePaths(repo).includes(norm(path)), '...with the worktree registered at its first path');

  const uncreated = wtStubbed(TRASH_STUB, argv, { ...stub, AIPG_WT_ROOT: join(file, 'sub') });
  eq(uncreated.code, 40, `a worktree root folder under a file exits 40 (${firstLine(uncreated.stderr)})`);
  ok(/creating the worktree root folder .+ to move it to a shorter path failed \(.+\), so it stays registered and intact/.test(uncreated.stderr), '...naming the create that failed');
  ok(worktreePaths(repo).includes(norm(path)), '...with the worktree registered at its first path');
});

section('a derived worktree root folder that a move creates is removed once it is empty, after a failed move or a trash');
await withFixture(({ root, repo }) => {
  const dir = join(root, 'long', 'parent');
  mkdirSync(dir, { recursive: true });
  const path = opened(repo, 'longname1', ['--dir', dir]);
  const home = join(root, 'h');
  const derived = join(home, 'aipg-wt');
  const argv = ['close', '--repo', repo, '--name', 'longname1', '--discard'];
  mkdirSync(home);

  const failed = wtStubbed(TRASH_STUB, argv, { ...homeRuleEnv(home), AIPG_TRASH_STUB: 'longPathLocked' });
  eq(failed.code, 40, `a move that fails into a worktree root folder it created exits 40 (${firstLine(failed.stderr)})`);
  ok(!existsSync(derived) && worktreePaths(repo).includes(norm(path)), '...removing that folder again, with the worktree at its first path');
  eq(git(repo, ['worktree', 'unlock', path]).code, 0, 'unlock the worktree');

  const r = wtStubbed(TRASH_STUB, argv, { ...homeRuleEnv(home), AIPG_TRASH_STUB: 'longPath', AIPG_TRASH_STUB_ONLY: basename(path) });
  eq(r.code, 0, `the discard exits 0 (${firstLine(r.stderr)})`);
  eq(norm(MOVED.exec(r.stderr)?.[2] ?? ''), norm(join(derived, SHORT_NAME)), '...after a move into the derived worktree root folder it created');
  ok(!existsSync(derived), '...which it removes once the folder went to the trash');
});

section('a worktree root folder open would refuse leaves the move in the worktree\'s own parent folder');
await withFixture(({ root, repo }) => {
  const dir = join(root, 'long', 'parent');
  mkdirSync(dir, { recursive: true });
  const path = opened(repo, 'longname1', ['--dir', dir]);
  const short = join(dir, SHORT_NAME);
  // The home folder rule with the home folder at the repo derives a worktree root folder inside its checkout.
  const env = { ...homeRuleEnv(repo), AIPG_TRASH_STUB: 'longPath', AIPG_TRASH_STUB_ONLY: basename(path) };
  const r = wtStubbed(TRASH_STUB, ['close', '--repo', repo, '--name', 'longname1', '--discard'], env);
  const moved = MOVED.exec(r.stderr);
  eq(r.code, 0, `the discard exits 0 (${firstLine(r.stderr)})`);
  eq(norm(moved?.[2] ?? ''), norm(short), '...after a move to the short path in the worktree\'s own parent folder');
  ok(!existsSync(join(repo, 'aipg-wt')), '...creating no worktree root folder inside the checkout');
  ok(!existsSync(path) && !existsSync(short) && trashedNames(root, short).length === 1, '...and the folder went to the trash from the short path');
});

section('a trash that reports success at the short path and leaves the folder registered exits 40 naming the short path');
await withFixture(({ root, repo }) => {
  const gate = ledgerGate(root, join(root, 'gate-runs.txt'));
  const short = join(root, WT_ROOT, SHORT_NAME);
  const path = opened(repo, 'feat');
  commitFile(path, 'f.txt', 'feature\n');
  const r = wtStubbed(TRASH_STUB, ['close', '--repo', repo, '--name', 'feat', '--into', 'main', '--gate', gate], { AIPG_TRASH_STUB: 'longPathThenUnmoved' });
  eq(r.code, 40, `close exits 40 (${firstLine(r.stderr)})`);
  eq(norm(MOVED.exec(r.stderr)?.[2] ?? ''), norm(short), '...after a move to the short path');
  ok(norm(r.stderr).includes(`${norm(short)} is still registered after "git worktree prune"`), `...naming the short path as still registered: ${firstLine(r.stderr)}`);
  ok(worktreePaths(repo).includes(norm(short)), '...where the worktree stays registered');
  ok(sha(repo, 'refs/heads/aipg/feat') !== '', '...and keeping aipg/feat');
});

section('a move whose destination another process made first exits 40, and the same command run again moves the worktree to a free short path');
await withFixture(({ root, repo }) => {
  const path = opened(repo, 'feat');
  const taken = join(root, WT_ROOT, SHORT_NAME);
  const nested = join(taken, basename(path));
  const argv = ['close', '--repo', repo, '--name', 'feat', '--discard'];
  let err = null;
  // The folder appears after shortDestination read the worktree root folder, as a concurrent close's move would make it.
  mkdirSync(taken);
  try {
    moveWorktree(repo, path, { path: taken, create: null });
  } catch (e) {
    err = e;
  }
  eq(err?.exitCode, 40, `the move exits 40 (${err?.message ?? 'no error'})`);
  ok(norm(err?.message ?? '').includes(`put it inside ${norm(taken)}, a folder another process made`) && norm(err?.message ?? '').includes(`registered at ${norm(nested)}`),
    '...naming the folder it landed in and the path git registered');

  const again = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPath', AIPG_TRASH_STUB_ONLY: basename(path) });
  eq(again.code, 0, `the same discard run again exits 0 (${firstLine(again.stderr)})`);
  eq(norm(MOVED.exec(again.stderr)?.[2] ?? ''), norm(join(root, WT_ROOT, 'aipg-_000001')), '...after a move out to the next free short path');
  ok(existsSync(taken) && !existsSync(nested) && !worktreePaths(repo).some((p) => p.startsWith(norm(taken))), '...leaving the other folder in place and nothing registered in it');
});

section('a worktree root folder reached through a link takes the move at its real path, so the same command run again moves nothing');
await withFixture(({ root, repo }) => {
  const dir = join(root, 'long', 'parent', 'deeper');
  const real = join(root, 'real-root');
  const link = join(root, 'ln');
  mkdirSync(dir, { recursive: true });
  mkdirSync(real);
  // A junction needs no privilege on Windows, and elsewhere the type is ignored and a symlink is made.
  symlinkSync(real, link, 'junction');
  const path = opened(repo, 'longname1', ['--dir', dir]);
  const short = join(real, SHORT_NAME);
  const argv = ['close', '--repo', repo, '--name', 'longname1', '--discard'];
  const env = { AIPG_WT_ROOT: link, AIPG_TRASH_STUB: 'longPath' };

  const refused = wtStubbed(TRASH_STUB, argv, env);
  eq(refused.code, 40, `the discard exits 40 when the trash refuses both paths (${firstLine(refused.stderr)})`);
  eq(norm(MOVED.exec(refused.stderr)?.[2] ?? ''), norm(short), '...after a move to the short path under the real folder');
  ok(worktreePaths(repo).includes(norm(short)), '...where the worktree is registered');

  const again = wtStubbed(TRASH_STUB, argv, env);
  eq(again.code, 40, `the same discard run again exits 40 (${firstLine(again.stderr)})`);
  ok(!MOVED.test(again.stderr) && worktreePaths(repo).includes(norm(short)), '...making no second move');

  const finished = wt(argv, { env: { ...fixtureEnv(), AIPG_WT_ROOT: link } });
  eq(finished.code, 0, `once the trash accepts, the same discard exits 0 (${firstLine(finished.stderr)})`);
  ok(!existsSync(short) && !worktreePaths(repo).includes(norm(short)), '...and the worktree is gone from the short path');
});

section('a worktree at its short path that a detached HEAD took off its branch is still found, and close leaves it in place');
await withFixture(({ root, repo }) => {
  const path = opened(repo, 'disc');
  const short = join(root, WT_ROOT, SHORT_NAME);
  const argv = ['close', '--repo', repo, '--name', 'disc', '--discard'];
  const refused = wtStubbed(TRASH_STUB, argv, { AIPG_TRASH_STUB: 'longPath' });
  eq(refused.code, 40, `the discard exits 40 when the trash refuses both paths (${firstLine(refused.stderr)})`);
  eq(norm(MOVED.exec(refused.stderr)?.[2] ?? ''), norm(short), `...after a move from ${path} to the short path`);
  eq(git(short, ['switch', '--detach']).code, 0, 'detach HEAD in the moved worktree');

  const again = wt(argv);
  eq(again.code, 40, `the same discard run again exits 40 (${firstLine(again.stderr)})`);
  ok(/the worktree of aipg\/disc at .+ has a detached HEAD checked out, so close leaves it in place/.test(again.stderr), '...naming the detached HEAD');
  ok(worktreePaths(repo).includes(norm(short)) && existsSync(short), '...with the worktree registered and in place at the short path');
});

section('a worktree opened with --dir set to the derived worktree root folder leaves that folder in place once it is removed');
await withFixture(({ root, repo }) => {
  const home = join(root, 'h');
  const derived = join(home, 'aipg-wt');
  mkdirSync(derived, { recursive: true });
  // A name of seven letters and digits gives the folder the length of a short name.
  const path = opened(repo, 'abcdef1', ['--dir', derived]);
  const r = wt(['close', '--repo', repo, '--name', 'abcdef1', '--discard'], { env: homeRuleEnv(home) });
  eq(r.code, 0, `the discard exits 0 (${firstLine(r.stderr)})`);
  ok(!existsSync(path), '...trashing the worktree');
  ok(existsSync(derived), '...and leaving the --dir folder in place');
});

}
