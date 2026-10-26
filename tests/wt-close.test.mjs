// tools/wt.mjs close: the fast-forward, the rebase, the hooks and the gate.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { GIT_OVERFLOW_STUB, wtStubbed, at, git, norm, firstLine, readOr, worktreePaths, sha, withFixture, trashedName, trashedAt, stage, commitFile, gateCmd, GATE_GREEN, openIn, closeIn, opened, ledgerGate, ledgerRuns, unchanged, hookIn, hasGit, under } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

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
  ok(worktreePaths(repo).includes(norm(under(repo, 'aipg-third'))), '...registering the worktree');
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

}
