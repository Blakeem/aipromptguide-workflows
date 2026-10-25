// tools/wt.mjs close: the base open records, a landing beside the user's own uncommitted work, and --stage.
import { existsSync, writeFileSync } from 'node:fs';
import { section, ok, eq } from './harness.mjs';
import { wt, at, git, norm, firstLine, readOr, worktreePaths, sha, withFixture, trashedName, stage, commitFile, gateCmd, GATE_GREEN, closeIn, discardIn, opened, hasGit } from './wt-helpers.mjs';

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

section('close --discard takes no --stage');
await withFixture(({ repo }) => {
  opened(repo, 'feat');
  const r = wt(['close', '--repo', repo, '--name', 'feat', '--discard', '--stage']);
  eq(r.code, 1, 'close --discard --stage exits 1');
  ok(/takes no --into, --gate or --stage/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
});

}
