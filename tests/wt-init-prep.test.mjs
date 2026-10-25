// tools/wt.mjs init and prep.
// What is worth asserting here is the git behaviour the tool is built on, not the tool's own bookkeeping:
// that the hook refuses `git stash` in a batch worktree while commit/branch/merge still work (the M19
// brick), that it leaves the user's own worktrees alone (M31), that prep's self-test catches a missing
// hook without leaving a probe entry on the shared stash stack, and that N concurrent preps do not race
// (M26 — spawn + Promise.all; execFileSync is blocking and would prove nothing).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { HOOK } from '../tools/wt.mjs';
import { SCRIPT, wt, GIT_OVERFLOW_STUB, wtStubbed, at, git, norm, firstLine, worktreePaths, sha, hookOf, withFixture, commitFile, spawnCli, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('init cuts the integration branch, checks it out, and installs the hook');
await withFixture(({ root, repo }) => {
  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 0, `init exits 0 (${firstLine(r.stderr)})`);
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-int-b1'))), 'the integration worktree sits beside the repo');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== '', 'branch aipg/int-b1 exists');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/main'), 'with --base omitted it is cut from the CURRENT HEAD branch');

  const hook = hookOf(join(root, 'aipg-int-b1'));
  ok(existsSync(hook), `the hook is at the --git-path location (${hook})`);
  eq(readFileSync(hook, 'utf8'), HOOK, 'the hook content is byte-exact');

  const again = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(again.code, 0, 'a second init of the SAME batch is a no-op exit 0');
  eq(worktreePaths(repo).length, 2, '...adding no second worktree');

  const other = wt(['init', '--repo', repo, '--batch', 'b2']);
  eq(other.code, 40, 'a second, DIFFERENT batch while b1 is active exits 40');
  ok(/already active/.test(other.stderr), `...naming the batch that holds it: ${firstLine(other.stderr)}`);
});

section('--base picks the branch to cut from; a detached HEAD has no default to fall back to');
await withFixture(({ repo }) => {
  git(repo, ['checkout', '-q', '-b', 'dev']);
  writeFileSync(join(repo, 'b.txt'), 'two\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'dev work']);
  git(repo, ['checkout', '-q', 'main']);

  const r = wt(['init', '--repo', repo, '--batch', 'b1', '--base', 'dev']);
  eq(r.code, 0, `init --base dev exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/dev'), 'the integration branch is cut from --base, not from HEAD');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== sha(repo, 'refs/heads/main'), '...which is a different commit from HEAD here');
});
await withFixture(({ repo }) => {
  git(repo, ['checkout', '-q', '--detach', 'HEAD']);
  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 40, 'a detached HEAD with no --base exits 40 rather than guessing a default branch');
  ok(/DETACHED HEAD/.test(r.stderr), `...loudly: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), '', '...and creates no branch');
});

section('a RELATIVE core.hooksPath is refused before any worktree or hook exists');
await withFixture(({ root, repo }) => {
  // Git resolves a relative hooks path inside each worktree, so the hook would guard the integration
  // worktree alone and every prep's self-test would fail with "re-run init".
  git(repo, ['config', 'core.hooksPath', '.husky']);
  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 40, 'init exits 40 on a relative core.hooksPath');
  ok(/core\.hooksPath/.test(r.stderr), `...naming it: ${firstLine(r.stderr)}`);
  ok(!worktreePaths(repo).some((p) => /aipg-int-/.test(p)), '...creating no integration worktree');
  ok(!existsSync(join(root, 'aipg-int-b1')), '...and no folder for one');
  eq(git(repo, ['branch', '--list', 'aipg/int-*']).stdout.trim(), '', '...and no aipg/int-* branch');
  ok(!existsSync(join(repo, '.husky', 'reference-transaction')), '...and no hook written');
});

section('a FOREIGN reference-transaction hook is never clobbered');
await withFixture(({ repo }) => {
  const hook = join(repo, '.git', 'hooks', 'reference-transaction');
  const foreign = '#!/bin/sh\n# somebody else got here first\nexit 0\n';
  mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
  writeFileSync(hook, foreign);

  const r = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(r.code, 40, 'init exits 40 when a different hook already exists');
  eq(readFileSync(hook, 'utf8'), foreign, '...and the existing hook is untouched');
  ok(/refusing to clobber/.test(r.stderr), `...saying so: ${firstLine(r.stderr)}`);
});

section('prep adds one worktree per chain, and the hook is live inside it');
await withFixture(({ root, repo }) => {
  const early = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(early.code, 40, 'prep before init exits 40');
  ok(/init/.test(early.stderr), `...naming init as the fix: ${firstLine(early.stderr)}`);

  wt(['init', '--repo', repo, '--batch', 'b1']);
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 — its hook self-test passed (${firstLine(r.stderr)})`);
  const chain = r.stdout.trim();
  eq(norm(chain), norm(join(root, 'aipg-alpha')), 'it prints the worktree path, beside the integration worktree');
  ok(sha(repo, 'refs/heads/aipg/b1/alpha') !== '', 'the branch is exactly aipg/<batch>/<chain>');
  ok(!existsSync(at(chain, '.aipg-hook-probe')), 'the self-test left no probe file behind');
  eq(git(chain, ['status', '--porcelain']).stdout.trim(), '', '...a clean worktree');
  eq(git(chain, ['stash', 'list']).stdout.trim(), '', '...and an empty stash stack');

  // The refusal itself. A stash needs something to save, so make a change first.
  writeFileSync(at(chain, 'c.txt'), 'c\n');
  const stash = git(chain, ['stash', 'push', '-u', '-m', 'x']);
  ok(stash.code !== 0, 'git stash inside the prepped worktree is refused');
  ok(/AIPG: refuse/.test(stash.stderr), `...with the AIPG message: ${firstLine(stash.stderr)}`);
  eq(git(chain, ['stash', 'list']).stdout.trim(), '', '...and no entry reaches the shared stash stack');

  // M19: the naive hook exits 1 on EVERY ref transaction, which would brick all of these.
  writeFileSync(at(chain, 'c.txt'), 'c\n');
  git(chain, ['add', '-A']);
  eq(git(chain, ['commit', '-qm', 'alpha work']).code, 0, 'git commit in a batch worktree still works');
  eq(git(chain, ['branch', 'probe-branch']).code, 0, 'git branch still works');
  eq(git(join(root, 'aipg-int-b1'), ['merge', '--no-ff', '-m', 'land alpha', 'aipg/b1/alpha']).code, 0, 'git merge into the integration worktree still works');

  // M31: the hook is scoped to aipg-* worktrees, so the user's own tree keeps git stash.
  writeFileSync(join(repo, 'a.txt'), 'changed\n');
  eq(git(repo, ['stash', 'push', '-u', '-m', 'user own']).code, 0, 'the MAIN worktree keeps git stash');
  eq(git(repo, ['stash', 'pop']).code, 0, '...and git stash pop');
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', '...leaving the stack empty');
});

section("a stash entry the operator already had is not residue — prep's self-test is a DELTA check");
await withFixture(({ root, repo }) => {
  // refs/stash is ONE stack for the whole repo, so "did the probe leave residue" can only be answered
  // against a baseline. Asked in absolute terms ("is the stack empty"), every developer who already had
  // WIP stashed in the target repo got exit 40 from a self-test that had actually PASSED.
  writeFileSync(join(repo, 'a.txt'), 'operator WIP\n');
  eq(git(repo, ['stash', 'push', '-u', '-m', 'operator WIP']).code, 0, 'the operator stashes their own work before any of this');
  const before = git(repo, ['stash', 'list']).stdout.trim();
  ok(before !== '', '...so refs/stash is NOT empty when prep runs');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0 with that entry on the stack');
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 — the pre-existing entry is not the probe's residue (${firstLine(r.stderr)})`);
  eq(norm(r.stdout.trim()), norm(join(root, 'aipg-alpha')), '...and it still prints the worktree path');
  eq(git(repo, ['stash', 'list']).stdout.trim(), before, "...leaving the operator's own entry exactly as it was");
  ok(!existsSync(join(root, 'aipg-alpha', '.aipg-hook-probe')), '...and no probe file behind');
});

section("an IGNORED probe file never makes the self-test pop the operator's own stash entry");
await withFixture(({ root, repo }) => {
  // `stash push -u` skips ignored files and exits 0 with no entry made, so a pop keyed on that exit code
  // applied the operator's top stash into the fresh chain worktree and dropped it from the stack.
  writeFileSync(join(repo, '.gitignore'), '.*\n!.gitignore\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'ignore dotfiles']);
  writeFileSync(join(repo, 'a.txt'), 'operator WIP\n');
  eq(git(repo, ['stash', 'push', '-u', '-m', 'operator WIP']).code, 0, 'the operator stashes their own work before init');
  const list = git(repo, ['stash', 'list']).stdout.trim();
  const reflog = git(repo, ['log', '-g', '--format=%H', 'refs/stash']).stdout.trim();
  ok(list !== '' && reflog !== '', '...so refs/stash holds one entry when prep runs');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 — the hook refused the probe although the repo ignores it (${firstLine(r.stderr)})`);
  eq(git(repo, ['stash', 'list']).stdout.trim(), list, "...the operator's stash list is unchanged");
  eq(git(repo, ['log', '-g', '--format=%H', 'refs/stash']).stdout.trim(), reflog, '...and so is the refs/stash reflog');
  eq(git(join(root, 'aipg-alpha'), ['status', '--porcelain', '--ignored']).stdout.trim(), '', '...and the chain worktree is clean, probe included');
});

section("prep's self-test catches a hook removed behind its back, and leaves no probe residue");
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  rmSync(hookOf(join(root, 'aipg-int-b1')), { force: true });

  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'beta']);
  eq(r.code, 40, 'prep exits 40 when the stash probe is ACCEPTED');
  ok(/self-test FAILED/.test(r.stderr), `...saying which check failed: ${firstLine(r.stderr)}`);
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', '...with no probe entry left on the shared stash stack');
  ok(!existsSync(join(root, 'aipg-beta', '.aipg-hook-probe')), '...and no probe file left in the worktree');
  eq(git(join(root, 'aipg-beta'), ['status', '--porcelain']).stdout.trim(), '', '...and a clean worktree');
});

section('--provision runs in the new worktree; a red one exits 40 and keeps the worktree');
await withFixture(({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const good = join(root, 'provision-ok.cjs');
  const bad = join(root, 'provision-bad.cjs');
  writeFileSync(good, "require('fs').writeFileSync('provisioned.txt', 'ok\\n');\n");
  writeFileSync(bad, "process.stderr.write('provision blew up\\n'); process.exit(3);\n");

  const green = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha', '--provision', `node "${good}"`]);
  eq(green.code, 0, `a zero-exit --provision keeps prep green (${firstLine(green.stderr)})`);
  ok(existsSync(join(root, 'aipg-alpha', 'provisioned.txt')), '...and it ran with cwd = the new worktree');

  const red = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'gamma', '--provision', `node "${bad}"`]);
  eq(red.code, 40, 'a nonzero --provision exits 40');
  ok(/provision blew up/.test(red.stderr), "...surfacing the command's own stderr");
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-gamma'))), '...and LEAVES the worktree registered');
  ok(/left in place\. .*clean --repo .* --key gamma, which keeps the branch/.test(red.stderr), '...naming the clean --key that removes it');
});

section('a provision past 1 MiB passes, and one KILLED for flooding its output buffer is SAID so, never given a fabricated exit code, with its worktree named as left in place');
await withFixture(({ root, repo }) => {
  // Node caps a child's combined stdout+stderr at 1 MiB unless told otherwise, and a child that exceeds
  // it is KILLED reporting NO exit status — `err.status` is null. Read as `status ?? 1`, that is an exit
  // code nothing observed, indistinguishable from a real failure. The tool must name the overflow. A
  // provision gets a gate's room, which no test can fill, so the stub kills it there.
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const loud = join(root, 'provision-loud.cjs');
  writeFileSync(loud, "process.stdout.write('x'.repeat(2 * 1024 * 1024));\nprocess.exit(0);\n");

  // No firstLine() on these two stderrs: each carries the provision's 2 MiB of output, relayed verbatim.
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'loud', '--provision', `node "${loud}"`]).code, 0, 'a provision that writes 2 MiB and exits 0 keeps prep green');
  eq(wt(['open', '--repo', repo, '--name', 'noisy', '--provision', `node "${loud}"`]).code, 0, '...and keeps open green');

  const r = wtStubbed(GIT_OVERFLOW_STUB, ['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha', '--provision', 'node -e 0'], { AIPG_SHELL_OVERFLOW: '1' });
  eq(r.code, 40, 'a prep whose provision overflows the buffer exits 40');
  ok(/KILLED/.test(r.stderr), `...saying it was killed: ${firstLine(r.stderr)}`);
  ok(/NOT a report that it failed/.test(r.stderr), '...and refusing to call an unobserved exit code a failure');
  ok(/1073741824 bytes/.test(r.stderr), "...naming the gate's limit it hit");
  ok(/left in place\. .*clean --repo .* --key alpha, which keeps the branch/.test(r.stderr), '...and the clean --key that removes the worktree it keeps');
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-alpha'))), '...which stays registered');

  const o = wtStubbed(GIT_OVERFLOW_STUB, ['open', '--repo', repo, '--name', 'feat', '--provision', 'node -e 0'], { AIPG_SHELL_OVERFLOW: '1' });
  eq(o.code, 40, 'an open whose provision overflows the buffer exits 40');
  ok(/KILLED .*left in place\. .*close --repo .* --name feat --discard, which keeps the branch/.test(o.stderr), `...naming the close --discard that removes the worktree it keeps: ${firstLine(o.stderr)}`);
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-feat'))), '...which stays registered');
});

section('three CONCURRENT preps of distinct keys all succeed (M26)');
await withFixture(async ({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  const keys = ['c1', 'c2', 'c3'];
  const runs = await Promise.all(keys.map((key) =>
    spawnCli([SCRIPT, 'prep', '--repo', repo, '--batch', 'b1', '--key', key])));

  runs.forEach((r, i) => eq(r.code, 0, `concurrent prep ${keys[i]} exits 0 (${firstLine(r.stderr)})`));
  // M26's measurement was `errs=[]`, not just "the exits were 0": the racing shape emitted git fatals
  // ("already exists", "cannot lock ref HEAD", "index.lock: File exists") on runs that still registered.
  runs.forEach((r, i) => ok(!/^(fatal|error):/m.test(r.stderr), `concurrent prep ${keys[i]} raised no git error`));
  const paths = worktreePaths(repo);
  for (const key of keys) ok(paths.includes(norm(join(root, `aipg-${key}`))), `aipg-${key} is registered`);
  eq(paths.length, 5, 'main + integration + 3 chains — nothing lost to the race');
  eq(git(repo, ['stash', 'list']).stdout.trim(), '', 'three concurrent self-tests left the stash stack empty');
});

section('init cuts the integration branch from the current branch, and prep the chain branch from the integration branch, when a tag has the same name');
await withFixture(({ repo }) => {
  const older = sha(repo, 'refs/heads/main');
  commitFile(repo, 'n.txt', 'newer\n');
  eq(git(repo, ['tag', 'main', older]).code, 0, 'a tag main names an older commit');
  const initR = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(initR.code, 0, `init with no --base exits 0 (${firstLine(initR.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/main'), '...and cuts aipg/int-b1 from the main branch, not the tag');
  eq(git(repo, ['tag', 'aipg/int-b1', older]).code, 0, 'a tag aipg/int-b1 names an older commit');
  const r = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(r.code, 0, `prep exits 0 (${firstLine(r.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/alpha'), sha(repo, 'refs/heads/aipg/int-b1'), '...and cuts aipg/b1/alpha from the integration branch, not the tag');
});

}
