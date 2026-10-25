// tools/wt.mjs close: a branch main already contains, a close that finishes on the next run, --discard and case folding.
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { shellQuote } from '../tools/wt.mjs';
import { foldsCase } from '../tools/trash.mjs';
import { DATA_HOME, at, git, norm, firstLine, Q, rx, readOr, worktreePaths, sha, withFixture, trashedName, trashedAt, commitFile, gateCmd, GATE_GREEN, openIn, closeIn, discardIn, opened, ledgerGate, ledgerRuns, unchanged, hookIn, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

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
      [closeIn(repo, 'feat', 'Main', gate), rx`--into "Main" names branch main in another case, so pass --into ${Q}main${Q}`, 'close --into Main'],
      [closeIn(repo, 'feat', 'AIPG/feat', gate), /--into "AIPG\/feat" names branch aipg\/feat in another case/, 'close --into AIPG/feat'],
      [closeIn(repo, 'FEAT', 'main', gate), /--name "FEAT" gives branch aipg\/FEAT, which this file system finds as branch aipg\/feat/, 'close --name FEAT'],
      [discardIn(repo, 'FEAT'), /--name "FEAT" gives branch aipg\/FEAT, which this file system finds as branch aipg\/feat/, 'close --name FEAT --discard'],
      [openIn(repo, 'FEAT'), rx`branch aipg\/feat already exists .*does not tell apart from aipg\/FEAT.*Pick another --name, or, once its commits are merged or not needed, delete the branch with git -C ${Q}.*${Q} branch -D aipg\/feat\.`, 'open --name FEAT'],
      [openIn(repo, 'other', ['--base', 'MAIN']), rx`--base "MAIN" names branch main in another case, so pass --base ${Q}main${Q}`, 'open --base MAIN'],
    ];
    for (const [r, expected, what] of refused) {
      eq(r.code, 40, `${what} exits 40`);
      ok(expected.test(r.stderr), `...saying why: ${firstLine(r.stderr)}`);
    }
    unchanged(root, repo, feat, 'feat', mainAt, tip);
    eq(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).stdout.trim().split('\n').join(','), 'refs/heads/aipg/feat,refs/heads/main', '...no branch was added or renamed');
    eq(worktreePaths(repo).length, 2, '...and no worktree was added');

    // A branch name may hold a `$`, so each printed command carries the stored name through shellQuote.
    // On win32 shellQuote uses double quotes, in which a `$` still expands (the comment on shellQuoteFor in tools/wt.mjs).
    eq(git(repo, ['branch', 'dev$x']).code, 0, 'create a branch whose name holds a $');
    const oddBase = openIn(repo, 'odd', ['--base', 'DEV$X']);
    eq(oddBase.code, 40, 'open --base DEV$X exits 40');
    ok(oddBase.stderr.includes(`so pass --base ${shellQuote('dev$x')}`), `...printing the stored name quoted: ${firstLine(oddBase.stderr)}`);
    eq(git(repo, ['checkout', '-q', 'DEV$X']).code, 0, 'check the branch out as DEV$X');
    const oddCurrent = openIn(repo, 'odd');
    eq(oddCurrent.code, 40, 'open with no --base on DEV$X exits 40');
    ok(oddCurrent.stderr.includes(`cut from with --base ${shellQuote('dev$x')}`), `...printing the stored name quoted: ${firstLine(oddCurrent.stderr)}`);
    eq(git(repo, ['checkout', '-q', 'main']).code, 0, 'check main out again');
    eq(git(repo, ['branch', '-D', 'dev$x']).code, 0, 'delete the branch whose name holds a $');

    // git accepts the checkout and writes HEAD as refs/heads/Main, which reads the loose ref file of main.
    eq(git(repo, ['checkout', '-q', 'Main']).code, 0, 'check main out in the main worktree as Main');
    const variant = closeIn(repo, 'feat', 'main', gate);
    eq(variant.code, 40, `close --into main while a worktree has it checked out as Main exits 40 (${firstLine(variant.stderr)})`);
    ok(rx`has it checked out as Main, which names the same branch\..*switch ${Q}main${Q}`.test(variant.stderr), '...naming the worktree and the switch');
    unchanged(root, repo, feat, 'feat', mainAt, tip);
    eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...and the main worktree shows no change');
    eq(git(repo, ['checkout', '-q', 'main']).code, 0, 'check main out as main');

    eq(closeIn(repo, 'feat', 'main', gate).code, 0, "close in git's own spelling exits 0");
  });
}

}
