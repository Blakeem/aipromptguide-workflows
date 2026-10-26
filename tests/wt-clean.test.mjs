// tools/wt.mjs clean: the teardown, the batch lifecycle, what it prunes, counts and trashes, and the unlanded-work and sibling-chain refusals.
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { HOOK, worktreeAdminDirs } from '../tools/wt.mjs';
import { wt, TRASH_STUB, GIT_OVERFLOW_STUB, cleanStubbed, abs, at, git, norm, firstLine, Q, rx, readOr, worktreePaths, sha, hookOf, withFixture, trashedName, trashedAt, batchOf, under, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('clean moves the worktree to the trash, keeps the branch, and obeys the same byte-equal hook rule');
await withFixture(async ({ root, repo }) => {
  wt(['init', '--repo', repo, '--batch', 'b1']);
  wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  const chain = under(repo, 'aipg-alpha');
  const intWt = under(repo, 'aipg-int-b1');
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
  const intWt = under(repo, 'aipg-int-b1');
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
  const chain = under(repo, 'aipg-alpha');
  const intWt = under(repo, 'aipg-int-b1');
  const hook = hookOf(intWt);

  // The resting state of a finished stage-mode engine run is accepted work STAGED, not committed
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
  const intWt = under(repo, 'aipg-int-b1');
  const beta = under(repo, 'aipg-beta');
  const hook = hookOf(intWt);

  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'alpha lands and is cleaned');
  ok(trashedName(root, under(repo, 'aipg-alpha')) !== '', '...moving alpha to the trash');

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

}
