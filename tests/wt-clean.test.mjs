// tools/wt.mjs clean.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { HOOK, worktreeAdminDirs } from '../tools/wt.mjs';
import { DATA_HOME, wt, TRASH_STUB, GIT_OVERFLOW_STUB, cleanStubbed, abs, at, git, norm, firstLine, Q, rx, readOr, worktreePaths, sha, hookOf, otherRepo, withFixture, trashedName, trashedAt, land, batchOf, stage, lockOf, writeLock, deadPid, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

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

}
