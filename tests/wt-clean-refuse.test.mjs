// tools/wt.mjs clean: what it refuses, with nothing changed. The unlanded-work and sibling-chain refusals sit in tests/wt-clean.test.mjs, which measures the same lifecycle.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { HOOK } from '../tools/wt.mjs';
import { DATA_HOME, wt, GIT_OVERFLOW_STUB, cleanStubbed, abs, at, git, norm, firstLine, Q, rx, readOr, worktreePaths, hookOf, otherRepo, withFixture, trashedName, batchOf, stage, lockOf, writeLock, deadPid, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

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

section('clean REFUSES the main worktree when it is on a chain branch');
await withFixture(({ root, repo }) => {
  batchOf(root, repo, ['alpha']);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key removes the chain worktree and keeps its branch');
  eq(git(repo, ['switch', '-q', 'aipg/b1/alpha']).code, 0, 'the main worktree switches to the kept chain branch');
  refusedIntact(root, repo, 'alpha', repo, /main worktree of the repo.*switch <branch>/, 'a clean --key that finds the main worktree');
  ok(existsSync(join(repo, '.git', 'HEAD')), '...and the repository in its .git is intact');
});

section('a status listing that overflows its cap is refused as unlanded work, naming the by-hand removal');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const r = refusedIntact(root, repo, 'alpha', chains.alpha, /has not landed \(its status listing passed the 1 MiB output cap\)/, 'an overflowing status listing',
    { stub: GIT_OVERFLOW_STUB, env: { AIPG_GIT_OVERFLOW: 'status' } });
  ok(rx`trash\.mjs${Q} ${Q}.*${Q} and then run git -C ${Q}.*${Q} worktree prune`.test(r?.stderr ?? ''), `...and names the by-hand trash and prune: ${firstLine(r?.stderr)}`);
});

}
