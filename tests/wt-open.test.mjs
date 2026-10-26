// tools/wt.mjs open, and the post-checkout hook that init, prep and open each run.
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { HOOK } from '../tools/wt.mjs';
import { fixtureEnv, wt, GIT_RACE_STUB, wtStubbed, at, git, norm, firstLine, readOr, worktreePaths, sha, hookOf, withFixture, commitFile, opened, openIn, discardIn, openedPath, hookIn, hasGit, under, excludeFile, excludeLines } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('open cuts aipg/<name> off a local branch into its own worktree, with no hook and no upstream');
await withFixture(({ root, repo }) => {
  // Under always, git sets an upstream for a branch cut from a local branch unless --no-track says otherwise.
  eq(git(repo, ['config', 'branch.autoSetupMerge', 'always']).code, 0, 'set branch.autoSetupMerge to always');
  const r = openIn(repo, 'feat');
  eq(r.code, 0, `open exits 0 (${firstLine(r.stderr)})`);
  const feat = openedPath(r, repo, 'feat');
  eq(norm(feat), norm(under(repo, 'aipg-feat')), '...printing the worktree under .claude/worktrees in the repo on stdout');
  eq(git(feat, ['symbolic-ref', 'HEAD']).stdout.trim(), 'refs/heads/aipg/feat', '...which has aipg/feat checked out');
  eq(sha(repo, 'refs/heads/aipg/feat'), sha(repo, 'refs/heads/main'), '...cut from the current branch when --base is omitted');
  eq(git(repo, ['config', '--get', 'branch.aipg/feat.merge']).stdout.trim(), '', '...with no upstream, though branch.autoSetupMerge is always');
  // makeFixture keeps any hooks path inside the fixture at .git/hooks.
  ok(!existsSync(join(repo, '.git', 'hooks', 'reference-transaction')), '...and no reference-transaction hook');

  eq(git(repo, ['switch', '-q', '-c', 'dev']).code, 0, 'branch dev off main');
  const devTip = commitFile(repo, 'd.txt', 'dev\n');
  eq(git(repo, ['switch', '-q', 'main']).code, 0, '...and switch back to main');
  eq(openIn(repo, 'fix', ['--base', 'dev']).code, 0, 'open --base dev exits 0');
  eq(sha(repo, 'refs/heads/aipg/fix'), devTip, '...cutting the branch from dev');

  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  const far = openIn(repo, 'far', ['--dir', elsewhere]);
  eq(norm(far.stdout.trim()), norm(join(elsewhere, 'aipg-far')), `--dir places the worktree under it (${firstLine(far.stderr)})`);

  const again = openIn(repo, 'feat');
  eq(again.code, 40, 'an existing branch exits 40');
  ok(/already exists.*aipg-feat is on it.*close.*another --name.*branch -D aipg\/feat/.test(again.stderr), `...naming close, another name and the delete: ${firstLine(again.stderr)}`);
  eq(worktreePaths(repo).length, 4, '...adding no worktree');

  const revision = openIn(repo, 'rev', ['--base', 'main~0']);
  eq(revision.code, 40, 'a --base that is a revision, not a local branch, exits 40');
  ok(/not a local branch/.test(revision.stderr), `...saying so: ${firstLine(revision.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/rev'), '', '...and creates no branch');

  const empty = openIn(repo, 'empty', ['--base', '']);
  eq(empty.code, 40, 'an empty --base exits 40');
  ok(/--base "" is not a local branch/.test(empty.stderr), `...saying so: ${firstLine(empty.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/empty'), '', '...and creates no branch');
});
section('open with no --dir uses the repo\'s .claude/worktrees folder and hides it from git status through info/exclude, once');
await withFixture(({ root, repo }) => {
  eq(excludeLines(repo), 0, 'the exclude file starts with no line for the folder');
  const first = opened(repo, 'one');
  eq(norm(first), norm(under(repo, 'aipg-one')), 'the worktree sits under <repo>/.claude/worktrees');
  eq(excludeLines(repo), 1, '...and the exclude file gained the line');
  eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...so git status in the checkout lists no worktree');
  eq(readOr(join(repo, '.gitignore')), '', '...and no .gitignore was written');

  opened(repo, 'two');
  eq(excludeLines(repo), 1, 'a second open adds no second line');

  const elsewhere = join(root, 'elsewhere');
  opened(repo, 'far', ['--dir', elsewhere]);
  ok(existsSync(join(elsewhere, 'aipg-far')), '--dir still sets the parent folder');
});
await withFixture(({ repo }) => {
  const sub = join(repo, 'sub');
  mkdirSync(sub);
  const r = openIn(sub, 'nested');
  eq(r.code, 0, `open with --repo naming a subfolder exits 0 (${firstLine(r.stderr)})`);
  eq(norm(openedPath(r, sub, 'nested')), norm(under(repo, 'aipg-nested')), '...putting the worktree under the top level of the checkout');
  eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...where the exclude line hides it from git status');
});
await withFixture(({ repo }) => {
  const outer = opened(repo, 'outer');
  const r = openIn(outer, 'inner');
  eq(r.code, 0, `open with --repo naming a linked worktree exits 0 (${firstLine(r.stderr)})`);
  eq(norm(openedPath(r, outer, 'inner')), norm(under(repo, 'aipg-inner')), '...putting the worktree under the main worktree, never inside the linked one');
});
await withFixture(({ root, repo }) => {
  const bare = join(root, 'bare.git');
  eq(git(root, ['clone', '--bare', '-q', repo, bare]).code, 0, 'clone a bare repository');
  const r = openIn(bare, 'x');
  eq(r.code, 0, `open on a bare repository with no --dir exits 0 (${firstLine(r.stderr)})`);
  eq(norm(openedPath(r, bare, 'x')), norm(join(root, 'aipg-x')), '...putting the worktree beside the bare repository');
  ok(!readOr(join(bare, 'info', 'exclude')).includes('/.claude/worktrees/'), '...and adding no exclude line to the bare repository, which has no checkout');

  const linked = join(root, 'linked');
  eq(git(bare, ['worktree', 'add', '-q', '-b', 'side', linked]).code, 0, 'add a linked worktree to the bare repository');
  const fromLinked = openIn(linked, 'y');
  eq(fromLinked.code, 0, `open with --repo naming a linked worktree of the bare repository exits 0 (${firstLine(fromLinked.stderr)})`);
  eq(norm(openedPath(fromLinked, linked, 'y')), norm(join(root, 'aipg-y')), '...putting the worktree beside the bare repository, never inside its git directory');
  ok(!existsSync(join(bare, '.claude')), '...so the git directory gains no .claude folder');
});
await withFixture(({ root, repo }) => {
  opened(repo, 'far', ['--dir', join(root, 'elsewhere')]);
  eq(excludeLines(repo), 0, 'an open with --dir adds no line to the exclude file');
});
await withFixture(({ repo }) => {
  writeFileSync(excludeFile(repo), '# mine\r\n/.claude/worktrees/\r\n');
  opened(repo, 'kept');
  eq(readOr(excludeFile(repo)), '# mine\r\n/.claude/worktrees/\r\n', 'a line the file already holds, in CRLF form, is left alone');
});
await withFixture(({ repo }) => {
  writeFileSync(excludeFile(repo), 'build/');
  opened(repo, 'joined');
  eq(readOr(excludeFile(repo)), 'build/\n/.claude/worktrees/\n', 'a file with no final newline gets one before the new line');
});
await withFixture(({ repo }) => {
  rmSync(excludeFile(repo), { force: true });
  opened(repo, 'fresh');
  eq(readOr(excludeFile(repo)), '/.claude/worktrees/\n', 'a missing exclude file is created with the line');
});
await withFixture(({ repo }) => {
  rmSync(excludeFile(repo), { force: true });
  mkdirSync(excludeFile(repo));
  const r = openIn(repo, 'blocked');
  eq(r.code, 40, 'an exclude path that cannot be read as a file exits 40');
  ok(/cannot read .*exclude/.test(r.stderr), `...naming the file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/blocked'), '', '...before it creates a branch');
});
await withFixture(({ repo }) => {
  writeFileSync(excludeFile(repo), '# mine\n');
  chmodSync(excludeFile(repo), 0o444);
  let writable = true;
  try { appendFileSync(excludeFile(repo), ''); } catch { writable = false; }
  if (writable) {
    // A process that ignores file modes (root) cannot make an append fail.
    ok(true, 'skipped: this process can append to a read-only file');
    return;
  }
  const r = openIn(repo, 'readonly');
  chmodSync(excludeFile(repo), 0o666);
  eq(r.code, 40, 'an exclude file that cannot be appended to exits 40');
  ok(/cannot add .*exclude/.test(r.stderr), `...naming the file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/readonly'), '', '...before it creates a branch');
});
await withFixture(({ repo }) => {
  // git's short name for the current branch is heads/main once a tag shares its name.
  eq(git(repo, ['tag', 'main']).code, 0, 'tag main beside branch main');
  const tagged = openIn(repo, 'tagged');
  eq(tagged.code, 0, `open with no --base exits 0 when a tag shares the current branch's name (${firstLine(tagged.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/tagged'), sha(repo, 'refs/heads/main'), '...cutting from branch main');

  git(repo, ['checkout', '-q', '--detach', 'HEAD']);
  const r = openIn(repo, 'feat');
  eq(r.code, 40, 'open on a detached HEAD with no --base exits 40');
  ok(/DETACHED HEAD/.test(r.stderr), `...naming it: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...and creates no branch');

  git(repo, ['checkout', '-q', '--orphan', 'fresh']);
  const unborn = openIn(repo, 'feat');
  eq(unborn.code, 40, 'open on a branch with no commit yet and no --base exits 40');
  ok(/current branch "fresh" .* has no commit yet/.test(unborn.stderr), `...naming it: ${firstLine(unborn.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/feat'), '', '...and creates no branch');
});

section('open keeps a worktree whose --provision is red, open and prep refuse a blank one first, and both leave no branch behind when git refuses the path');
await withFixture(({ root, repo }) => {
  const blank = openIn(repo, 'blank', ['--provision', ' ']);
  eq(blank.code, 1, 'open with a blank --provision exits 1');
  ok(/--provision needs a command/.test(blank.stderr), `...saying so: ${firstLine(blank.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/blank'), '', '...before it creates the branch');
  ok(!existsSync(under(repo, 'aipg-blank')), '...or the worktree');

  const bad = join(root, 'provision-bad.cjs');
  writeFileSync(bad, 'process.exit(3);\n');
  const red = openIn(repo, 'feat', ['--provision', `node "${bad}"`]);
  eq(red.code, 40, 'a red --provision exits 40');
  ok(/--provision exited 3/.test(red.stderr), `...saying so: ${firstLine(red.stderr)}`);
  ok(/left in place\. .*close --repo .* --name feat --discard, which keeps the branch/.test(red.stderr), '...naming the close --discard that removes it');
  ok(worktreePaths(repo).includes(norm(under(repo, 'aipg-feat'))), '...and the worktree stays registered');

  // open creates the branch before git checks the path, so a refused add would strand it.
  const busy = under(repo, 'aipg-busy');
  mkdirSync(busy);
  writeFileSync(join(busy, 'mine.txt'), 'not a worktree\n');
  const refused = openIn(repo, 'busy');
  eq(refused.code, 40, `open onto a folder already there exits 40 (${firstLine(refused.stderr)})`);
  ok(/aipg-busy' already exists/.test(refused.stderr), "...giving git's reason, not its progress line");
  eq(sha(repo, 'refs/heads/aipg/busy'), '', '...and deletes the branch it created first');
  ok(/The branch aipg\/busy that this call created was deleted/.test(refused.stderr), '...saying it deleted the branch');
  eq(readOr(join(busy, 'mine.txt')), 'not a worktree\n', '...leaving the folder alone');
  renameSync(busy, `${busy}.moved`);
  eq(openIn(repo, 'busy').code, 0, '...so open exits 0 once the folder is moved');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init a batch');
  const blankPrep = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'blank', '--provision', ' ']);
  eq(blankPrep.code, 1, `prep with a blank --provision exits 1 (${firstLine(blankPrep.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/blank'), '', '...before it creates the branch');
  ok(!existsSync(under(repo, 'aipg-blank')), '...or the worktree');

  const taken = under(repo, 'aipg-alpha');
  mkdirSync(taken);
  writeFileSync(join(taken, 'mine.txt'), 'not a worktree\n');
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 40, 'prep onto a folder already there exits 40');
  eq(sha(repo, 'refs/heads/aipg/b1/alpha'), '', '...and deletes the branch it created first');
  renameSync(taken, `${taken}.moved`);
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 0, '...so prep exits 0 once the folder is moved');

  const nested = openIn(repo, 'b1');
  eq(nested.code, 40, 'open of a name whose branch aipg/b1 the chain branch aipg/b1/alpha blocks exits 40');
  ok(/cannot lock ref 'refs\/heads\/aipg\/b1'/.test(nested.stderr), `...giving git's reason: ${firstLine(nested.stderr)}`);
  ok(!existsSync(under(repo, 'aipg-b1')), '...and creates no worktree');
});

section('open and prep leave alone the branch and worktree of another process that creates their branch first');
await withFixture(({ root, repo }) => {
  const mainAt = sha(repo, 'refs/heads/main');
  const raced = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'race'], { AIPG_GIT_RACE: 'branch' });
  eq(raced.code, 40, `open whose branch another process creates during it exits 40 (${firstLine(raced.stderr)})`);
  ok(/a branch named 'aipg\/race' already exists/.test(raced.stderr), "...giving git's reason");
  eq(sha(repo, 'refs/heads/aipg/race'), mainAt, "...and keeps the other process's branch");

  const translated = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'local'], { AIPG_GIT_RACE: 'branch', AIPG_GIT_TRANSLATED: '1' });
  eq(translated.code, 40, `the same race under a git that translates its messages exits 40 (${firstLine(translated.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/local'), mainAt, "...and keeps the other process's branch");

  const held = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'held'], { AIPG_GIT_RACE: 'worktree' });
  eq(held.code, 40, `open whose branch and worktree another process creates during it exits 40 (${firstLine(held.stderr)})`);
  ok(/a branch named 'aipg\/held' already exists/.test(held.stderr) && !/git created the worktree/.test(held.stderr),
    "...giving git's reason, not the other process's worktree as one it created");
  eq(sha(repo, 'refs/heads/aipg/held'), mainAt, "...keeping the other process's branch");
  ok(worktreePaths(repo).includes(norm(join(root, 'aipg-held-racer'))), '...and its worktree');

  const locked = wtStubbed(GIT_RACE_STUB, ['open', '--repo', repo, '--name', 'locked'], { AIPG_GIT_RACE: 'locked' });
  eq(locked.code, 40, `open whose branch another process creates inside git's window between check and create exits 40 (${firstLine(locked.stderr)})`);
  ok(/aipg\/locked\.lock': File exists/.test(locked.stderr), "...giving git's reason");
  eq(sha(repo, 'refs/heads/aipg/locked'), mainAt, "...and keeps the other process's branch");

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init a batch');
  const prepped = wtStubbed(GIT_RACE_STUB, ['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha'], { AIPG_GIT_RACE: 'branch' });
  eq(prepped.code, 40, `prep whose branch another process creates during it exits 40 (${firstLine(prepped.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/alpha'), mainAt, "...and keeps the other process's branch");

  const prepTranslated = wtStubbed(GIT_RACE_STUB, ['prep', '--repo', repo, '--batch', 'b1', '--key', 'beta'], { AIPG_GIT_RACE: 'branch', AIPG_GIT_TRANSLATED: '1' });
  eq(prepTranslated.code, 40, `the same race of prep under a git that translates its messages exits 40 (${firstLine(prepTranslated.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/b1/beta'), mainAt, "...and keeps the other process's branch");
});

section("init's, prep's and open's worktree adds give the post-checkout hook the caller's locale, message catalog and credential prompt setting and a gate's output room");
await withFixture(({ root, repo }) => {
  const log = join(root, 'hook-env.log');
  // A catalog folder that does not exist only turns git's translations off, which no assertion here reads.
  const callerEnv = { ...fixtureEnv(), LC_ALL: 'C.UTF-8', GIT_TERMINAL_PROMPT: '1', GIT_TEXTDOMAINDIR: 'caller-catalog' };
  const seen = 'LC_ALL=[C.UTF-8] GIT_TERMINAL_PROMPT=[1] GIT_TEXTDOMAINDIR=[caller-catalog]';
  // Each run also writes 2 MiB, past Node's 1 MiB default child-output cap.
  hookIn(repo, 'post-checkout', `#!/bin/sh\necho "LC_ALL=[$LC_ALL] GIT_TERMINAL_PROMPT=[$GIT_TERMINAL_PROMPT] GIT_TEXTDOMAINDIR=[$GIT_TEXTDOMAINDIR]" >> "${log.replace(/\\/g, '/')}"\n`
    + `${JSON.stringify(process.execPath.replace(/\\/g, '/'))} -e 'process.stdout.write("x".repeat(2 * 1024 * 1024))'\n`);

  const initR = wt(['init', '--repo', repo, '--batch', 'b1'], { env: callerEnv });
  eq(initR.code, 0, `init exits 0 (${firstLine(initR.stderr)})`);
  const prepR = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha'], { env: callerEnv });
  eq(prepR.code, 0, `prep exits 0 (${firstLine(prepR.stderr)})`);
  const openR = wt(['open', '--repo', repo, '--name', 'feat'], { env: callerEnv });
  eq(openR.code, 0, `open exits 0 (${firstLine(openR.stderr)})`);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key alpha exits 0');
  eq(wt(['clean', '--repo', repo, '--batch', 'b1']).code, 0, 'clean --batch b1 exits 0, keeping aipg/int-b1');
  const reuseR = wt(['init', '--repo', repo, '--batch', 'b1'], { env: callerEnv });
  eq(reuseR.code, 0, `init that re-uses aipg/int-b1 exits 0 (${firstLine(reuseR.stderr)})`);
  eq(readOr(log), `${seen}\n`.repeat(4), "...and each add's post-checkout hook saw the caller's LC_ALL, GIT_TEXTDOMAINDIR and GIT_TERMINAL_PROMPT");
});

section('a worktree git created before its post-checkout hook failed is kept and named by open, init and prep, never reported as not created');
await withFixture(({ root, repo }) => {
  const failing = '#!/bin/sh\necho "post-checkout: npm install failed" >&2\nexit 1\n';
  const feat = under(repo, 'aipg-feat');
  const intWt = under(repo, 'aipg-int-b1');
  let hook = hookIn(repo, 'post-checkout', failing);

  const r = openIn(repo, 'feat');
  eq(r.code, 40, `open whose post-checkout hook fails exits 40 (${firstLine(r.stderr)})`);
  ok(/git created the worktree on aipg\/feat at .*aipg-feat and then exited 1/.test(r.stderr), '...saying git created the worktree');
  ok(r.stderr.includes('post-checkout: npm install failed'), "...relaying the hook's output");
  ok(/close --repo .* --name feat --discard, delete the branch with .*branch -D aipg\/feat, then run open again/.test(r.stderr), '...naming close --discard and the branch delete');
  ok(worktreePaths(repo).includes(norm(feat)), '...and the worktree stays registered');
  eq(sha(repo, 'refs/heads/aipg/feat'), sha(repo, 'refs/heads/main'), '...with its branch kept');
  eq(discardIn(repo, 'feat').code, 0, 'the close --discard it names exits 0');
  eq(git(repo, ['branch', '-D', 'aipg/feat']).code, 0, '...and so does the branch delete');

  const initRed = wt(['init', '--repo', repo, '--batch', 'b1']);
  eq(initRed.code, 40, `init whose post-checkout hook fails exits 40 (${firstLine(initRed.stderr)})`);
  ok(/git created the worktree on aipg\/int-b1 .*run init again, which re-uses that worktree/.test(initRed.stderr), '...naming init again');
  ok(worktreePaths(repo).includes(norm(intWt)), '...and the worktree stays registered');
  rmSync(hook);
  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init again exits 0 once the hook is gone');
  eq(readOr(hookOf(intWt)), HOOK, '...and installs the reference-transaction hook');

  hook = hookIn(repo, 'post-checkout', failing);
  const prepRed = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(prepRed.code, 40, `prep whose post-checkout hook fails exits 40 (${firstLine(prepRed.stderr)})`);
  ok(/self-test never ran.*clean --repo .* --key alpha, delete the branch with .*branch -D aipg\/b1\/alpha, then run prep again/.test(prepRed.stderr), '...naming clean --key and the branch delete');
  ok(worktreePaths(repo).includes(norm(under(repo, 'aipg-alpha'))), '...and the worktree stays registered');
  rmSync(hook);

  const twice = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(twice.code, 40, `a second prep of a key whose branch a worktree holds exits 40 (${firstLine(twice.stderr)})`);
  ok(/a branch named 'aipg\/b1\/alpha' already exists/.test(twice.stderr) && !/git created the worktree/.test(twice.stderr), "...giving git's reason, not a worktree it did not create");
});

}
