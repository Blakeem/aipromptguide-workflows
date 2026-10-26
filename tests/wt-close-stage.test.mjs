// tools/wt.mjs close: the base open records, a landing beside the user's own uncommitted work, and --stage.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { foldsCase } from '../tools/trash.mjs';
import { wt, at, git, norm, firstLine, readOr, worktreePaths, sha, withFixture, trashedName, stage, commitFile, gateCmd, GATE_GREEN, closeIn, discardIn, opened, hasGit, rx, Q } from './wt-helpers.mjs';

const closeTo = (repo, name, gate, extra = []) => wt(['close', '--repo', repo, '--name', name, '--gate', gate, ...extra]);
const stagedNames = (repo) => git(repo, ['diff', '--cached', '--name-only']).stdout.split('\n').filter(Boolean).sort().join(' ');
const baseOf = (repo, branch) => git(repo, ['config', '--get', `branch.${branch}.aipgbase`]).stdout.trim();

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('open records the branch it cut from, and close without --into fast-forwards that branch');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  eq(baseOf(repo, 'aipg/feat'), 'main', 'open records main as the base of aipg/feat');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 0, `close with no --into exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, '...moving main to the branch tip');
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...deleting the branch');
  eq(baseOf(repo, 'aipg/feat'), '', '...and the recorded base with it');

  const again = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN));
  eq(again.code, 0, 'close run again with no branch left exits 0');
  ok(/nothing to close/.test(again.stderr), `...saying so: ${firstLine(again.stderr)}`);
});

section('close without --into REFUSES a branch open did not make, and changes nothing');
await withFixture(({ root, repo }) => {
  eq(git(repo, ['worktree', 'add', '-q', '-b', 'aipg/hand', at(root, 'aipg-hand')]).code, 0, 'add a worktree on aipg/hand by hand');
  const tip = commitFile(at(root, 'aipg-hand'), 'h.txt', 'hand\n');
  const mainAt = sha(repo, 'refs/heads/main');

  const r = closeTo(repo, 'hand', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 40, 'close with no --into and no recorded base exits 40');
  ok(/open recorded no base for aipg\/hand, so name the branch to merge it into with --into/.test(r.stderr), `...asking for --into: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is untouched');
  eq(sha(repo, 'refs/heads/aipg/hand'), tip, '...and aipg/hand is where it was');
});

section('close fast-forwards an --into worktree whose uncommitted work sits at paths the fast-forward leaves alone, and keeps that work');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  writeFileSync(at(repo, 'a.txt'), 'edited, not committed\n');
  stage(repo, 'b.txt', 'staged, not committed\n');

  const r = closeIn(repo, 'feat', 'main', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 0, `close exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), tip, '...moving main to the branch tip');
  eq(readOr(at(repo, 'a.txt')), 'edited, not committed\n', '...keeping the unstaged edit');
  eq(stagedNames(repo), 'b.txt', '...and the staged file');
});

section('close --stage stages the accepted work on the --into worktree, leaves --into where it is, and keeps the user\'s own work');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const mainAt = sha(repo, 'refs/heads/main');
  stage(feat, 's.txt', 'accepted\n');
  stage(feat, 'a.txt', 'accepted change\n');
  writeFileSync(at(repo, 'u.txt'), 'the user\'s untracked file\n');
  stage(repo, 'b.txt', 'the user\'s staged file\n');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 0, `close --stage exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is where it was');
  eq(stagedNames(repo), 'a.txt b.txt s.txt', '...the accepted files are staged beside the user\'s');
  eq(readOr(at(repo, 's.txt')), 'accepted\n', '...with the accepted content in the file');
  eq(git(repo, ['show', ':a.txt']).stdout, 'accepted change\n', '...and in the index');
  eq(readOr(at(repo, 'u.txt')), 'the user\'s untracked file\n', '...the untracked file is kept');
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...the branch is deleted');
  ok(!worktreePaths(repo).includes(norm(feat)), '...the worktree is unregistered');
  ok(trashedName(root, feat) !== '', '...and in the trash');
});

section('close --stage rebases onto an --into that moved, gates the combined tree, and stages only the run\'s change');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  stage(feat, 's.txt', 'accepted\n');
  const mainAt = commitFile(repo, 'm.txt', 'main moved\n');
  const gate = gateCmd(root, 'needs-both', "const fs = require('fs'); if (!fs.existsSync('m.txt') || !fs.existsSync('s.txt')) process.exit(1);\n");

  const r = closeTo(repo, 'feat', gate, ['--stage']);
  eq(r.code, 0, `close --stage exits 0 (${firstLine(r.stderr)})`);
  ok(/rebased aipg\/feat onto main/.test(r.stderr), '...after a rebase');
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main stays at its own commit');
  eq(stagedNames(repo), 's.txt', '...and only the run\'s file is staged');
});

section('close --stage REFUSES user changes where the staged work writes, and a run again after they are cleared lands it');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const mainAt = sha(repo, 'refs/heads/main');
  stage(feat, 'a.txt', 'accepted change\n');
  writeFileSync(at(repo, 'a.txt'), 'the user\'s edit\n');
  const gate = gateCmd(root, 'green', GATE_GREEN);

  const r = closeTo(repo, 'feat', gate, ['--stage']);
  eq(r.code, 40, 'close --stage exits 40');
  ok(/uncommitted changes at paths the staged work writes \(a\.txt\)/.test(r.stderr), `...naming the file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is untouched');
  eq(readOr(at(repo, 'a.txt')), 'the user\'s edit\n', '...the user\'s edit is kept');
  eq(stagedNames(repo), '', '...nothing is staged there');
  ok(worktreePaths(repo).includes(norm(feat)), '...and the worktree is still registered');

  eq(git(repo, ['checkout', '--', 'a.txt']).code, 0, 'revert the user\'s edit');
  const again = closeTo(repo, 'feat', gate, ['--stage']);
  eq(again.code, 0, `close --stage run again exits 0 (${firstLine(again.stderr)})`);
  eq(git(repo, ['show', ':a.txt']).stdout, 'accepted change\n', '...staging the accepted change');
});

section('close --stage REFUSES work no acceptance staged, and changes nothing');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = sha(repo, 'refs/heads/aipg/feat');
  stage(feat, 's.txt', 'accepted\n');
  writeFileSync(at(feat, 'wip.txt'), 'unreviewed\n');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 40, 'close --stage exits 40');
  ok(/holds work beside its staged work that no acceptance staged \(wip\.txt\)/.test(r.stderr), `...naming the file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/feat'), tip, '...aipg/feat is where it was');
  eq(stagedNames(feat), 's.txt', '...and the accepted work is still staged');
});

section('close --stage REFUSES an --into no worktree has checked out, with --into untouched');
await withFixture(({ root, repo }) => {
  eq(git(repo, ['branch', 'other']).code, 0, 'make branch other');
  const feat = opened(repo, 'feat', ['--base', 'other']);
  const otherAt = sha(repo, 'refs/heads/other');
  stage(feat, 's.txt', 'accepted\n');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 40, 'close --stage exits 40');
  ok(/none has it, so other is untouched/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/other'), otherAt, '...other is where it was');
  ok(existsSync(feat), '...and the worktree is kept');
});

section('close --stage with nothing staged or committed removes the worktree and stages nothing');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 0, `close --stage exits 0 (${firstLine(r.stderr)})`);
  eq(stagedNames(repo), '', '...staging nothing');
  ok(!worktreePaths(repo).includes(norm(feat)), '...and unregistering the worktree');
});

section('close --stage run again after the worktree went finishes by deleting a branch whose work is staged, and keeps one whose work is not');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  commitFile(feat, 's.txt', 'accepted\n');
  eq(discardIn(repo, 'feat').code, 0, 'trash the worktree, keeping the branch');
  const gate = gateCmd(root, 'green', GATE_GREEN);

  const unstaged = closeTo(repo, 'feat', gate, ['--stage']);
  eq(unstaged.code, 40, 'with its work not staged on main, close --stage exits 40');
  ok(sha(repo, 'refs/heads/aipg/feat') !== '', '...keeping the branch');

  writeFileSync(at(root, 'feat.patch'), git(repo, ['diff', '--binary', 'main', 'aipg/feat']).stdout);
  eq(git(repo, ['apply', '--index', at(root, 'feat.patch')]).code, 0, 'stage the branch\'s work on main by hand');
  const staged = closeTo(repo, 'feat', gate, ['--stage']);
  eq(staged.code, 0, `with its work staged, close --stage exits 0 (${firstLine(staged.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...deleting the branch');
});

section('close --stage REFUSES a locked worktree before it carries the staged work, and changes nothing');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = sha(repo, 'refs/heads/aipg/feat');
  stage(feat, 's.txt', 'accepted\n');
  eq(git(repo, ['worktree', 'lock', feat]).code, 0, 'lock the feat worktree');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 40, 'close --stage exits 40');
  ok(/It is locked/.test(r.stderr), `...naming the lock: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/feat'), tip, '...aipg/feat is where it was');
  eq(stagedNames(feat), 's.txt', '...and the accepted work is still staged');
});

section('close --stage stopped by a lock after it staged the work finishes when run again, staging the work once');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');
  // The gate runs in the worktree after step 3, so its lock stops only step 8, once the work is staged on main.
  const lockOnce = gateCmd(root, 'lock-once', `const fs = require('fs');
const marker = ${JSON.stringify(at(root, 'locked-once'))};
if (!fs.existsSync(marker)) { require('child_process').execFileSync('git', ['worktree', 'lock', process.cwd()]); fs.writeFileSync(marker, ''); }
`);

  const r = closeTo(repo, 'feat', lockOnce, ['--stage']);
  eq(r.code, 40, `close --stage whose gate locks the worktree exits 40 (${firstLine(r.stderr)})`);
  ok(/It is locked/.test(r.stderr), '...naming the lock');
  eq(stagedNames(repo), 'f.txt', '...after staging the change on main');

  eq(git(repo, ['worktree', 'unlock', feat]).code, 0, 'unlock the feat worktree');
  const again = closeTo(repo, 'feat', lockOnce, ['--stage']);
  eq(again.code, 0, `close --stage run again exits 0 (${firstLine(again.stderr)})`);
  ok(/already has the work of aipg\/feat staged/.test(again.stderr), '...saying the work is already staged');
  eq(stagedNames(repo), 'f.txt', '...main\'s index holds the change');
  eq(git(repo, ['show', ':f.txt']).stdout, 'feature\n', '...once');
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is where it was');
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...and the branch is deleted');
});

section('close --stage REFUSES an ignored file in the way of the staged work, and says git refuses it, never that git deletes it');
await withFixture(({ root, repo }) => {
  appendFileSync(join(repo, '.git', 'info', 'exclude'), 'out.cfg\n');
  const feat = opened(repo, 'feat');
  writeFileSync(at(feat, 'out.cfg'), 'branch\n');
  eq(git(feat, ['add', '-f', 'out.cfg']).code, 0, 'the run force-adds the ignored out.cfg');
  writeFileSync(at(repo, 'out.cfg'), 'my local copy\n');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 40, 'close --stage exits 40');
  ok(/It holds ignored files in the way of the staged work \(out\.cfg\)/.test(r.stderr), `...naming it: ${firstLine(r.stderr)}`);
  ok(!/delete/.test(r.stderr), '...without saying git would delete it');
  eq(readOr(at(repo, 'out.cfg')), 'my local copy\n', '...and the ignored file is intact');
});

section('close --stage REFUSES an --into checked out twice, naming the staging it stopped');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  stage(feat, 's.txt', 'accepted\n');
  eq(git(repo, ['worktree', 'add', '-q', '--force', at(root, 'second-main'), 'main']).code, 0, 'check main out in a second worktree');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN), ['--stage']);
  eq(r.code, 40, 'close --stage exits 40');
  ok(/cannot stage the work on main, so it is untouched\. It is checked out in more than one worktree/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
  eq(stagedNames(repo), '', '...and nothing is staged on main');
});

section('close without --into REFUSES a worktree of the change whose branch was renamed, and changes nothing');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  eq(git(repo, ['branch', '-m', 'aipg/feat', 'aipg/other']).code, 0, 'rename aipg/feat to aipg/other');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 40, `close with no --into exits 40 (${firstLine(r.stderr)})`);
  ok(/the worktree of aipg\/feat at .* has branch aipg\/other checked out, so close leaves it in place/.test(r.stderr), '...naming the branch the worktree is on');
  ok(worktreePaths(repo).includes(norm(feat)), '...and the worktree is still registered');
});

section('close without --into REFUSES a recorded base that is no longer a plain local branch, naming the config and --into');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');
  const recorded = /open recorded main as the base of aipg\/feat in git config branch\.aipg\/feat\.aipgbase, and /;
  const askInto = /, so name the branch to merge it into with --into/;
  eq(git(repo, ['branch', '-m', 'main', 'trunk']).code, 0, 'rename main to trunk');

  const gone = closeTo(repo, 'feat', gate);
  eq(gone.code, 40, `with main renamed, close exits 40 (${firstLine(gone.stderr)})`);
  ok(recorded.test(gone.stderr) && /it is no longer a local branch in /.test(gone.stderr) && askInto.test(gone.stderr), '...naming the recorded base and --into');
  eq(sha(repo, 'refs/heads/trunk'), mainAt, '...trunk is untouched');
  eq(sha(repo, 'refs/heads/aipg/feat'), tip, '...and aipg/feat is where it was');

  eq(git(repo, ['symbolic-ref', 'refs/heads/main', 'refs/heads/trunk']).code, 0, 'make main a symbolic ref to trunk');
  const symbolic = closeTo(repo, 'feat', gate);
  eq(symbolic.code, 40, `with main a symbolic ref, close exits 40 (${firstLine(symbolic.stderr)})`);
  ok(recorded.test(symbolic.stderr) && /it is a symbolic ref to refs\/heads\/trunk/.test(symbolic.stderr) && askInto.test(symbolic.stderr), '...naming the branch it points at');
  eq(sha(repo, 'refs/heads/trunk'), mainAt, '...and trunk is untouched');
});

section('close without --into REFUSES a recorded base spelled in another case, naming the --into to pass where the file system folds case');
await withFixture(({ root, repo }) => {
  const feat = opened(repo, 'feat');
  const tip = commitFile(feat, 'f.txt', 'feature\n');
  const mainAt = sha(repo, 'refs/heads/main');
  eq(git(repo, ['config', 'branch.aipg/feat.aipgbase', 'MAIN']).code, 0, 'record the base as MAIN');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 40, `close exits 40 (${firstLine(r.stderr)})`);
  if (foldsCase(process.platform)) {
    ok(rx`open recorded MAIN as the base of aipg/feat in git config branch\.aipg/feat\.aipgbase, and it names branch main in another case, so pass --into ${Q}main${Q}`.test(r.stderr), '...naming the stored branch and the --into to pass');
  } else {
    ok(/open recorded MAIN as the base of aipg\/feat in git config branch\.aipg\/feat\.aipgbase, and it is no longer a local branch in /.test(r.stderr), '...naming MAIN as no local branch, since this file system tells branch names apart by case');
  }
  eq(sha(repo, 'refs/heads/main'), mainAt, '...main is untouched');
  eq(sha(repo, 'refs/heads/aipg/feat'), tip, '...and aipg/feat is where it was');
});

section('close without --into REFUSES a recorded base that is a branch of a batch');
await withFixture(({ root, repo }) => {
  eq(git(repo, ['branch', 'aipg/int-b1']).code, 0, 'make branch aipg/int-b1');
  const feat = opened(repo, 'feat', ['--base', 'aipg/int-b1']);
  const intAt = sha(repo, 'refs/heads/aipg/int-b1');
  commitFile(feat, 'f.txt', 'feature\n');

  const r = closeTo(repo, 'feat', gateCmd(root, 'green', GATE_GREEN));
  eq(r.code, 40, `close exits 40 (${firstLine(r.stderr)})`);
  ok(/open recorded aipg\/int-b1 as the base of aipg\/feat .*it is a branch of a batch, which only land moves, so name the branch to merge it into with --into/.test(r.stderr), '...saying so');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), intAt, '...and aipg/int-b1 is untouched');
});

section('close --discard takes no --stage');
await withFixture(({ repo }) => {
  opened(repo, 'feat');
  const r = wt(['close', '--repo', repo, '--name', 'feat', '--discard', '--stage']);
  eq(r.code, 1, 'close --discard --stage exits 1');
  ok(/takes no --into, --gate or --stage/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
});

}
