// tools/wt.mjs close: what it refuses, with nothing changed.
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { wt, GIT_OVERFLOW_STUB, wtStubbed, abs, at, git, norm, firstLine, Q, rx, readOr, worktreePaths, sha, otherRepo, withFixture, trashedName, trashedAt, land, commitFile, gateCmd, GATE_GREEN, closeIn, discardIn, opened, unchanged, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('close REFUSES a dirty worktree, an --into worktree with changes where the fast-forward writes, a call from inside the worktree, and a bad --into');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'a.txt', 'feature\n');
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
  eq(intoDirty.code, 40, 'a main worktree with a modified tracked file the fast-forward writes exits 40');
  ok(/uncommitted changes at paths the fast-forward writes \(a\.txt\)/.test(intoDirty.stderr), `...naming it: ${firstLine(intoDirty.stderr)}`);
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

}
