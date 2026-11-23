// tools/wt.mjs: where open and init put a worktree with no --dir, and the empty folders close and clean remove.
// Every case runs with AIPG_WT_ROOT inside the fixture, or with AIPG_WT_ROOT_RULE=home and a home folder inside it, so no
// case creates a folder at a drive root or in the real home folder.
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, win32 } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import * as wtModule from '../tools/wt.mjs';
import {
  WT_ROOT, RMDIR_STUB, fixtureEnv, homeRuleEnv, wt, wtStubbed, runCli, git, norm, firstLine, readOr, sha, worktreePaths, withFixture,
  commitFile, opened, closeIn, discardIn, gateCmd, GATE_GREEN, under, projectOf, excludeFile, hasGit,
} from './wt-helpers.mjs';

const SETTINGS = join(REPO_ROOT, 'tools/project-settings.mjs');
// Read through the namespace, so a tool without the export fails those assertions and not the entire file.
const worktreeRoot = wtModule.worktreeRoot ?? (() => ({ dir: '', derived: null }));
/** How many entries `folder` holds, or -1 when it is missing, so an assertion on a missing folder fails and does not throw. */
const entries = (folder) => (existsSync(folder) ? readdirSync(folder).length : -1);

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('open and init put the worktree in <AIPG_WT_ROOT>/<the backlog folder name> and leave info/exclude and git status as they were');
await withFixture(({ root, repo }) => {
  const excludeBefore = readOr(excludeFile(repo));
  const first = opened(repo, 'one');
  const backlog = runCli(process.execPath, [SETTINGS, 'backlog', '--root', join(root, 'state'), '--repo', repo]);
  const project = basename(backlog.stdout.trim().replace(/\/$/, ''));
  ok(project !== '', `project-settings.mjs backlog names the project (${backlog.stdout.trim()})`);
  eq(norm(first), norm(join(root, WT_ROOT, project, 'aipg-one')), 'open puts the worktree in the project folder, named as the backlog folder is');
  eq(project, projectOf(repo), "...which is the name the tests' own helper computes");
  eq(readOr(excludeFile(repo)), excludeBefore, '...and leaves info/exclude byte-identical');
  eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...so git status in the checkout prints nothing');
  ok(!existsSync(join(repo, '.claude')), '...and the checkout gains no .claude folder');

  const second = opened(repo, 'two');
  eq(norm(dirname(second)), norm(dirname(first)), 'a second open uses the same project folder');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  ok(worktreePaths(repo).includes(norm(join(root, WT_ROOT, project, 'aipg-int-b1'))), '...putting the integration worktree in the project folder');
  const chain = wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']);
  eq(norm(chain.stdout.trim()), norm(join(root, WT_ROOT, project, 'aipg-alpha')), '...and prep puts a chain beside it');
  eq(readOr(excludeFile(repo)), excludeBefore, '...and info/exclude is still byte-identical');
  eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...and git status in the checkout still prints nothing');
});
await withFixture(({ repo }) => {
  writeFileSync(excludeFile(repo), '# mine\r\n/.claude/worktrees/\r\n');
  opened(repo, 'kept');
  eq(readOr(excludeFile(repo)), '# mine\r\n/.claude/worktrees/\r\n', 'a line an older version wrote to info/exclude stays');
});

section('AIPG_WT_ROOT unset or empty derives the worktree root folder from the main worktree on Windows and the home folder elsewhere');
await withFixture(({ root, repo }) => {
  const linked = opened(repo, 'linked');
  const mainReal = realpathSync.native(repo);
  for (const [env, what] of [[{}, 'unset'], [{ AIPG_WT_ROOT: '' }, 'empty']]) {
    const windows = worktreeRoot(linked, env, 'win32');
    eq(windows.dir, win32.join(win32.parse(mainReal).root, 'aipg-wt'), `with AIPG_WT_ROOT ${what}, Windows takes aipg-wt at the root of the main worktree's real path, though --repo names a linked worktree`);
    eq(windows.derived, true, '...and calls it derived');
    eq(worktreeRoot(repo, env, 'linux').dir, join(homedir(), 'aipg-wt'), `with AIPG_WT_ROOT ${what}, every other platform takes aipg-wt in the home folder`);
  }
  eq(worktreeRoot(repo, { AIPG_WT_ROOT_RULE: 'home' }, 'win32').dir, join(homedir(), 'aipg-wt'), 'AIPG_WT_ROOT_RULE=home forces the home folder rule on Windows');
  const named = worktreeRoot(repo, { AIPG_WT_ROOT: join(root, 'mine') }, 'win32');
  eq(`${named.dir} ${named.derived}`, `${join(root, 'mine')} false`, 'AIPG_WT_ROOT names the worktree root folder, which is not derived');

  const home = join(root, 'home');
  const derived = wt(['open', '--repo', repo, '--name', 'derived'], { env: homeRuleEnv(home) });
  eq(derived.code, 0, `open under the home folder rule exits 0 (${firstLine(derived.stderr)})`);
  eq(norm(derived.stdout.trim()), norm(join(home, 'aipg-wt', projectOf(repo), 'aipg-derived')), '...putting the worktree in <home>/aipg-wt/<project>');
});

section('a relative AIPG_WT_ROOT and an unknown AIPG_WT_ROOT_RULE exit 1, and a folder that cannot be created or lies inside the checkout exits 40, each with no branch left');
await withFixture(({ root, repo }) => {
  const relative = wt(['open', '--repo', repo, '--name', 'rel'], { env: { ...fixtureEnv(), AIPG_WT_ROOT: 'rel-trees' }, cwd: root });
  eq(relative.code, 1, `open with a relative AIPG_WT_ROOT exits 1 (${firstLine(relative.stderr)})`);
  ok(/AIPG_WT_ROOT "rel-trees" must be an ABSOLUTE path/.test(relative.stderr), '...naming the variable');
  eq(sha(repo, 'refs/heads/aipg/rel'), '', '...creating no branch');
  ok(!existsSync(join(root, 'rel-trees')), '...and no folder');
  const relativeInit = wt(['init', '--repo', repo, '--batch', 'b1'], { env: { ...fixtureEnv(), AIPG_WT_ROOT: 'rel-trees' }, cwd: root });
  eq(relativeInit.code, 1, `init with a relative AIPG_WT_ROOT exits 1 (${firstLine(relativeInit.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), '', '...creating no branch');
  ok(!existsSync(join(root, 'rel-trees')), '...and no folder');

  const rule = wt(['open', '--repo', repo, '--name', 'rule'], { env: { ...fixtureEnv(), AIPG_WT_ROOT: '', AIPG_WT_ROOT_RULE: 'drive' } });
  eq(rule.code, 1, `open with an unknown AIPG_WT_ROOT_RULE exits 1 (${firstLine(rule.stderr)})`);
  ok(/AIPG_WT_ROOT_RULE "drive" is not home/.test(rule.stderr), '...naming the variable');
  eq(sha(repo, 'refs/heads/aipg/rule'), '', '...creating no branch');

  const blocker = join(root, 'blocker');
  writeFileSync(blocker, 'a file where a folder must go\n');
  const blockedEnv = { ...fixtureEnv(), AIPG_WT_ROOT: join(blocker, 'trees') };
  for (const [verb, argv, branch] of [['open', ['--name', 'blocked'], 'aipg/blocked'], ['init', ['--batch', 'b2'], 'aipg/int-b2']]) {
    const r = wt([verb, '--repo', repo, ...argv], { env: blockedEnv });
    eq(r.code, 40, `${verb} whose worktree root folder cannot be created exits 40 (${firstLine(r.stderr)})`);
    ok(/cannot create the worktree root folder .*blocker.*trees/.test(r.stderr), '...naming the folder and the cause');
    ok(/set AIPG_WT_ROOT/.test(r.stderr), '...and AIPG_WT_ROOT as the way to choose another folder');
    eq(sha(repo, `refs/heads/${branch}`), '', '...leaving no branch');
    eq(worktreePaths(repo).length, 1, '...and no worktree');
  }

  const trees = join(root, 'trees');
  mkdirSync(trees);
  writeFileSync(join(trees, projectOf(repo)), 'a file where the project folder must go\n');
  const project = wt(['open', '--repo', repo, '--name', 'project'], { env: { ...fixtureEnv(), AIPG_WT_ROOT: trees } });
  eq(project.code, 40, `open whose project folder cannot be created exits 40 (${firstLine(project.stderr)})`);
  ok(/cannot create the project folder /.test(project.stderr), '...naming the project folder');
  eq(sha(repo, 'refs/heads/aipg/project'), '', '...leaving no branch');
});
await withFixture(({ repo }) => {
  // The checkout is the home folder, so the home folder rule derives a worktree root folder inside it.
  const env = homeRuleEnv(repo);
  for (const [verb, argv, branch] of [['open', ['--name', 'inside'], 'aipg/inside'], ['init', ['--batch', 'b1'], 'aipg/int-b1']]) {
    const r = wt([verb, '--repo', repo, ...argv], { env });
    eq(r.code, 40, `${verb} whose derived worktree root folder lies inside the checkout exits 40 (${firstLine(r.stderr)})`);
    ok(/lies inside the checkout/.test(r.stderr) && /Set AIPG_WT_ROOT/.test(r.stderr), '...naming the checkout and AIPG_WT_ROOT');
    eq(sha(repo, `refs/heads/${branch}`), '', '...leaving no branch');
    ok(!existsSync(join(repo, 'aipg-wt')), '...and no folder');
    eq(git(repo, ['status', '--porcelain']).stdout.trim(), '', '...so git status in the checkout prints nothing');
  }
});

section('a --dir whose last segment is the worktree folder\'s own name is a usage error that changes nothing');
await withFixture(({ root, repo }) => {
  const cases = [['open', ['--name', 'deep'], 'aipg-deep', 'aipg/deep'], ['init', ['--batch', 'b1'], 'aipg-int-b1', 'aipg/int-b1']];
  // A file system that folds case compares the folder names in any case.
  if (process.platform === 'win32' || process.platform === 'darwin') cases.push(['open', ['--name', 'deep'], 'AIPG-DEEP', 'aipg/deep']);
  for (const [verb, argv, folder, branch] of cases) {
    const dir = join(root, folder);
    const r = wt([verb, '--repo', repo, ...argv, '--dir', dir]);
    eq(r.code, 1, `${verb} --dir <...>/${folder} exits 1 (${firstLine(r.stderr)})`);
    ok(/--dir names the parent folder/.test(r.stderr), '...saying --dir names the parent folder');
    eq(sha(repo, `refs/heads/${branch}`), '', '...creating no branch');
    ok(!existsSync(dir), '...and no folder');
  }
  const placed = opened(repo, 'deep', ['--dir', join(root, 'parent')]);
  eq(norm(placed), norm(join(root, 'parent', 'aipg-deep')), 'open --dir still places the worktree directly in it');
  eq(wt(['init', '--repo', repo, '--batch', 'b1', '--dir', join(root, 'parent')]).code, 0, 'init --dir exits 0');
  ok(worktreePaths(repo).includes(norm(join(root, 'parent', 'aipg-int-b1'))), '...placing the integration worktree directly in it');
});

section('the close or clean that removes the last worktree of a project removes the empty project folder, and a derived worktree root folder');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const one = opened(repo, 'one');
  const two = opened(repo, 'two');
  commitFile(one, 'one.txt', 'one\n');
  const landed = closeIn(repo, 'one', 'main', gate);
  eq(landed.code, 0, `close of one of two worktrees exits 0 (${firstLine(landed.stderr)})`);
  ok(existsSync(under(repo)), '...and the project folder that still holds the other stays');
  // recursive, so a tool that put the worktrees elsewhere fails the assertions below instead of the entire file.
  mkdirSync(under(repo), { recursive: true });
  writeFileSync(join(under(repo), 'note.txt'), 'not a worktree\n');
  eq(discardIn(repo, 'two').code, 0, 'close --discard of the last worktree exits 0');
  ok(existsSync(under(repo)), '...and a project folder that holds any other entry stays');
  eq(readOr(join(under(repo), 'note.txt')), 'not a worktree\n', '...with that entry in it');
});
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const only = opened(repo, 'only');
  commitFile(only, 'only.txt', 'only\n');
  ok(existsSync(join(under(repo), 'aipg-only')), 'the project folder holds the worktree before the close');
  const r = closeIn(repo, 'only', 'main', gate);
  eq(r.code, 0, `the close that lands the last worktree exits 0 (${firstLine(r.stderr)})`);
  ok(!existsSync(under(repo)), '...and the project folder is absent');
  ok(/removed the empty folder/.test(r.stderr), '...which stderr reports');
  ok(existsSync(join(root, WT_ROOT)), '...while the folder AIPG_WT_ROOT names stays, empty');
  eq(entries(join(root, WT_ROOT)), 0, '...holding nothing');

  opened(repo, 'thrown');
  ok(existsSync(join(under(repo), 'aipg-thrown')), 'the project folder holds the next worktree');
  eq(discardIn(repo, 'thrown').code, 0, 'close --discard of the last worktree exits 0');
  ok(!existsSync(under(repo)), '...and the project folder is absent');
});
await withFixture(({ repo }) => {
  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 0, 'prep exits 0');
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'clean --key exits 0');
  ok(existsSync(under(repo)), '...and the project folder that holds the integration worktree stays');
  eq(wt(['clean', '--repo', repo, '--batch', 'b1']).code, 0, 'clean --batch exits 0');
  ok(!existsSync(under(repo)), '...and the project folder is absent');
});
await withFixture(({ repo }) => {
  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 0, 'prep exits 0');
  eq(git(repo, ['worktree', 'remove', '--force', under(repo, 'aipg-int-b1')]).code, 0, 'remove the integration worktree by hand');
  ok(existsSync(join(under(repo), 'aipg-alpha')), 'the project folder holds the chain worktree alone');
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'the clean --key that removes the last worktree in the folder exits 0');
  ok(!existsSync(under(repo)), '...and the project folder is absent');
});
await withFixture(({ root, repo }) => {
  const home = join(root, 'home');
  const env = homeRuleEnv(home);
  const derivedRoot = join(home, 'aipg-wt');
  eq(wt(['open', '--repo', repo, '--name', 'a'], { env }).code, 0, 'open under the home folder rule exits 0');
  ok(existsSync(join(derivedRoot, projectOf(repo), 'aipg-a')), '...making the worktree in the derived worktree root folder');
  const r = wt(['close', '--repo', repo, '--name', 'a', '--discard'], { env });
  eq(r.code, 0, `close --discard exits 0 (${firstLine(r.stderr)})`);
  ok(!existsSync(derivedRoot), '...and the derived worktree root folder, which holds no entry after the project folder goes, is absent');

  eq(wt(['open', '--repo', repo, '--name', 'b'], { env }).code, 0, 'open again exits 0');
  mkdirSync(join(derivedRoot, 'other-project'));
  eq(wt(['close', '--repo', repo, '--name', 'b', '--discard'], { env }).code, 0, 'close --discard exits 0');
  ok(!existsSync(join(derivedRoot, projectOf(repo))), '...the project folder is absent');
  ok(existsSync(join(derivedRoot, 'other-project')), "...and the derived worktree root folder that holds another project's folder stays");
});

section('a worktree outside the project folder leaves its parent folder, unless --dir named the project folder');
await withFixture(({ root, repo }) => {
  const parent = join(root, 'elsewhere');
  opened(repo, 'far', ['--dir', parent]);
  eq(discardIn(repo, 'far').code, 0, 'close --discard of a --dir worktree exits 0');
  ok(existsSync(parent), '...and its empty parent folder stays');
  eq(entries(parent), 0, '...holding nothing');

  opened(repo, 'own', ['--dir', under(repo)]);
  ok(existsSync(join(under(repo), 'aipg-own')), 'open --dir <the project folder> makes the worktree there');
  eq(discardIn(repo, 'own').code, 0, 'close --discard of a worktree whose --dir is the project folder exits 0');
  ok(!existsSync(under(repo)), '...and that project folder is absent');

  const old = join(repo, '.claude', 'worktrees');
  opened(repo, 'old', ['--dir', old]);
  eq(discardIn(repo, 'old').code, 0, "close --discard of a worktree in the checkout's .claude/worktrees folder exits 0");
  ok(existsSync(old), '...and that folder stays');
});

section('a failed folder removal or project folder lookup prints one line and keeps the exit code, and the same command run again finishes the removal');
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const held = opened(repo, 'held');
  commitFile(held, 'held.txt', 'held\n');
  const argv = ['close', '--repo', repo, '--name', 'held', '--into', 'main', '--gate', gate];
  const stopped = wtStubbed(RMDIR_STUB, argv);
  eq(stopped.code, 0, `close whose folder removal fails exits 0 (${firstLine(stopped.stderr)})`);
  const lines = stopped.stderr.split('\n').filter((l) => /left the folder/.test(l));
  eq(lines.length, 1, '...printing one line about it');
  ok(lines.length === 1 && norm(lines[0]).includes(norm(under(repo))) && /EBUSY/.test(lines[0]), `...naming the folder and the reason: ${lines[0] ?? ''}`);
  ok(existsSync(under(repo)), '...and the project folder stays');
  ok(!worktreePaths(repo).includes(norm(held)), '...after the worktree was removed');

  const again = wt(argv);
  eq(again.code, 0, `the same close run again exits 0 (${firstLine(again.stderr)})`);
  ok(!existsSync(under(repo)), '...and removes the project folder');
});
await withFixture(({ root, repo }) => {
  const gate = gateCmd(root, 'green', GATE_GREEN);
  /** Runs `argv` with every folder removal failing, then again without the stub, which finds no worktree left. */
  const stopThenRerun = (argv, what) => {
    const stopped = wtStubbed(RMDIR_STUB, argv);
    eq(stopped.code, 0, `${what} whose folder removal fails exits 0 (${firstLine(stopped.stderr)})`);
    ok(existsSync(under(repo)), '...and the project folder stays');
    const again = wt(argv);
    eq(again.code, 0, `the same ${what} run again exits 0 (${firstLine(again.stderr)})`);
    ok(!existsSync(under(repo)), '...and removes the project folder');
  };

  opened(repo, 'tossed');
  stopThenRerun(['close', '--repo', repo, '--name', 'tossed', '--discard'], 'close --discard');

  const based = opened(repo, 'based');
  commitFile(based, 'based.txt', 'based\n');
  stopThenRerun(['close', '--repo', repo, '--name', 'based', '--gate', gate], 'close with no --into');

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'init exits 0');
  eq(wt(['prep', '--repo', repo, '--batch', 'b1', '--key', 'alpha']).code, 0, 'prep exits 0');
  eq(git(repo, ['worktree', 'remove', '--force', under(repo, 'aipg-int-b1')]).code, 0, 'remove the integration worktree by hand');
  stopThenRerun(['clean', '--repo', repo, '--key', 'alpha'], 'clean --key');

  eq(wt(['init', '--repo', repo, '--batch', 'b2']).code, 0, 'init of the next batch exits 0');
  stopThenRerun(['clean', '--repo', repo, '--batch', 'b2'], 'clean --batch');
});
await withFixture(({ root, repo }) => {
  const lost = opened(repo, 'lost');
  const r = wt(['close', '--repo', repo, '--name', 'lost', '--discard'], { env: { ...fixtureEnv(), AIPG_WT_ROOT: 'rel-trees' }, cwd: root });
  eq(r.code, 0, `close --discard whose project folder cannot be found exits 0 (${firstLine(r.stderr)})`);
  const lines = r.stderr.split('\n').filter((l) => /left the project folder/.test(l));
  eq(lines.length, 1, '...printing one line about it');
  ok(lines.length === 1 && /AIPG_WT_ROOT "rel-trees" must be an ABSOLUTE path/.test(lines[0]), `...naming the cause: ${lines[0] ?? ''}`);
  ok(!worktreePaths(repo).includes(norm(lost)), '...after the worktree was removed');
  ok(existsSync(under(repo)), '...and the project folder stays');
});

}
