// tools/wt.mjs shared helpers: the CLI through a link, filesInTheWay, shell quoting and argv validation.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { shellQuote, shellQuoteFor } from '../tools/wt.mjs';
// Read off the namespace, so a build without the export fails its own assertions instead of the entire file.
import * as wtTool from '../tools/wt.mjs';
import { SCRIPT, runCli, trashEnv, wt, git, firstLine, otherRepo, withFixture, land, openIn, hookIn, hasGit } from './wt-helpers.mjs';

section('the CLI still speaks when its own path goes through a symlink or junction');
{
  // Node resolves the MAIN module through realpath, so comparing `import.meta.url` against the RAW argv[1]
  // makes `invokedDirectly` false through any link. The process then exits 0 having printed nothing, and
  // every loud failure in the file (unknown verb, bad flags, missing args) is bypassed. Twin of the
  // plan-block case (tests/CLAUDE.md §1). No git needed, so it sits above the git gate. Skipped where a link
  // cannot be created (no privilege, no support) rather than failing for the machine.
  const dir = mkdtempSync(join(tmpdir(), 'aipg-wt-link-'));
  const link = join(dir, 'tools');
  let linked = false;
  try {
    symlinkSync(join(REPO_ROOT, 'tools'), link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch { linked = false; }

  if (linked) {
    const viaLink = runCli(process.execPath, [join(link, 'wt.mjs')], { env: trashEnv(dir) });
    eq(viaLink.code, 1, 'no verb through the link exits 1, not a silent 0');
    ok(/no verb given/.test(viaLink.stderr), `...and says why: ${firstLine(viaLink.stderr)}`);
  } else {
    ok(true, 'skipped — this machine cannot create a link');
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

section('filesInTheWay names a file at, inside or above a path a merge writes, and no other');
{
  const filesInTheWay = typeof wtTool.filesInTheWay === 'function' ? wtTool.filesInTheWay : () => [];
  ok(typeof wtTool.filesInTheWay === 'function', 'tools/wt.mjs exports filesInTheWay');
  // `lib` is written as a file over a lib/ directory, and docs/readme.md as a file under a file docs.
  const written = ['cfg/app.json', 'lib', 'docs/readme.md'];
  const files = ['cfg/app.json', 'lib/cache.bin', 'docs', 'docs2/x', 'cfg/other.json', 'Lib/Cache.bin'];
  eq(filesInTheWay(files, written, false).join(','), 'cfg/app.json,lib/cache.bin,docs', 'with case kept: the file at a path, inside one and above one');
  eq(filesInTheWay(files, written, true).join(','), 'cfg/app.json,lib/cache.bin,docs,Lib/Cache.bin', 'with case folded: Lib/Cache.bin as well');
  eq(filesInTheWay([], written, false).length, 0, 'no files: none in the way');
  // ls-files lists a directory that holds its own repository as one entry ending in `/`.
  eq(filesInTheWay(['vendor/lib/', 'vendor/other/'], ['vendor/lib/x.js'], false).join(','), 'vendor/lib/', 'a nested repository entry over a written path, and not its sibling');
  eq(filesInTheWay(['vendor/lib/'], ['vendor/lib'], false).join(','), 'vendor/lib/', '...at a written path');
  eq(filesInTheWay(['vendor/lib/'], ['vendor'], false).join(','), 'vendor/lib/', '...and inside a written path');
}

section('shellQuoteFor puts a path in double quotes on win32, which cmd.exe, PowerShell and Git Bash run for a path with no $, backtick or UNC prefix');
eq(shellQuoteFor('win32', 'C:\\a b\\c'), '"C:\\a b\\c"', 'a win32 path with a space is one double-quoted word');
eq(shellQuoteFor('win32', "C:\\it's\\x"), '"C:\\it\'s\\x"', '...and an apostrophe in it stays as it is');
eq(shellQuoteFor('win32', 'C:\\x\\$HOME\\`id`'), '"C:\\x\\$HOME\\`id`"', '...and a $ or a backtick in it stays, which PowerShell and Git Bash expand');
eq(shellQuoteFor('win32', ''), '""', '...and an empty path is an empty quoted word');
eq(shellQuoteFor('win32', 'E:\\'), '"E:\\\\"', '...and a trailing backslash, as in a drive root, is doubled so it cannot escape the closing quote');
eq(shellQuoteFor('win32', 'E:\\a\\\\'), '"E:\\a\\\\\\\\"', '...and every trailing backslash is doubled');

section('shellQuoteFor puts a path in single quotes on every other platform and writes each apostrophe in it as a closed quote, a backslash-escaped apostrophe and an opened quote');
for (const platform of ['linux', 'darwin', 'freebsd']) {
  eq(shellQuoteFor(platform, '/a b/c'), "'/a b/c'", `${platform}: a path with a space is one single-quoted word`);
  eq(shellQuoteFor(platform, '/x/$HOME/`id`'), "'/x/$HOME/`id`'", '...and a $ or a backtick in it stays inside the quotes');
  eq(shellQuoteFor(platform, "/it's/x"), "'/it'\\''s/x'", '...and an apostrophe in it closes the quote, escapes the apostrophe and reopens the quote');
  eq(shellQuoteFor(platform, ''), "''", '...and an empty path is an empty quoted word');
  eq(shellQuoteFor(platform, '/a\\'), "'/a\\'", '...and a trailing backslash stays as it is, since sh reads it literally inside single quotes');
}
eq(shellQuote("/it's a/b"), shellQuoteFor(process.platform, "/it's a/b"), 'shellQuote uses the form of the platform that runs the tool');

section('no printed command in tools/wt.mjs wraps a path in double quotes itself instead of passing it through shellQuote');
{
  // Covers every print site at once, including the land refusals that no fixture reaches.
  const DOUBLE_QUOTED_PATH = /(?:git -C|--repo|node|worktree (?:unlock|repair|add)) "\$\{|"\$\{(?:repo|path|mainPath|entry\.path|WT_SCRIPT|TRASH_SCRIPT|t)\}"/;
  const source = readFileSync(SCRIPT, 'utf8');
  ok(DOUBLE_QUOTED_PATH.test('git -C "${repo}" branch -D x') && DOUBLE_QUOTED_PATH.test('node "${WT_SCRIPT}" clean') && DOUBLE_QUOTED_PATH.test('unlock "${path}"'), 'the pattern matches the double-quoted forms the tool printed before');
  ok(!DOUBLE_QUOTED_PATH.test(source), 'tools/wt.mjs prints no command that interpolates a path inside double quotes');
}

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check below drives a real repo');
} else {

section('a path with a space, a $, a backtick and an apostrophe is quoted for the platform in the recovery commands that prep, land and open print');
await withFixture(({ root }) => {
  const odd = join(root, "it's $HOME `id`");
  const failing = '#!/bin/sh\necho "post-checkout: npm install failed" >&2\nexit 1\n';
  const landArgs = ['land', '--repo', odd, '--batch', 'b1', '--key', 'alpha', '--gate', 'true'];
  otherRepo(odd);
  // Pinned inside the fixture, so the hook below never lands in a core.hooksPath inherited from the developer's own config.
  git(odd, ['config', 'core.hooksPath', join(odd, '.git', 'hooks')]);
  writeFileSync(join(odd, 'a.txt'), 'one\n');
  eq(git(odd, ['add', '-A']).code, 0, 'stage a file in the odd-named repo');
  eq(git(odd, ['commit', '-qm', 'base']).code, 0, '...and commit it');

  const lacking = wt(['prep', '--repo', odd, '--batch', 'b1', '--key', 'alpha']);
  eq(lacking.code, 40, `prep with no integration worktree exits 40 (${firstLine(lacking.stderr)})`);
  ok(lacking.stderr.includes(`first run wt.mjs init --repo ${shellQuote(odd)} --batch b1; prep creates nothing`), `...naming the init with the repo path quoted for the platform: ${firstLine(lacking.stderr)}`);

  const landNoInt = wt(landArgs);
  eq(landNoInt.code, 40, `land with no integration worktree exits 40 (${firstLine(landNoInt.stderr)})`);
  ok(landNoInt.stderr.includes(`nothing to land into; first run wt.mjs init --repo ${shellQuote(odd)} --batch b1`), `...naming the init with the repo path quoted for the platform: ${firstLine(landNoInt.stderr)}`);

  eq(wt(['init', '--repo', odd, '--batch', 'b1']).code, 0, 'init the integration worktree');
  const landNoChain = wt(landArgs);
  eq(landNoChain.code, 40, `land with no chain worktree exits 40 (${firstLine(landNoChain.stderr)})`);
  ok(landNoChain.stderr.includes(`first run wt.mjs prep --repo ${shellQuote(odd)} --batch b1 --key alpha, and land only after`), `...naming the prep with the repo path quoted for the platform: ${firstLine(landNoChain.stderr)}`);

  eq(git(odd, ['branch', 'aipg/dup']).code, 0, 'create the branch aipg/dup');
  const dup = openIn(odd, 'dup');
  eq(dup.code, 40, `open of a name whose branch exists exits 40 (${firstLine(dup.stderr)})`);
  ok(dup.stderr.includes(`Pick another --name, or, once its commits are merged or not needed, delete the branch with git -C ${shellQuote(odd)} branch -D aipg/dup.`), `...naming the branch delete with the repo path quoted for the platform: ${firstLine(dup.stderr)}`);

  hookIn(odd, 'post-checkout', failing);
  const openRed = openIn(odd, 'feat');
  eq(openRed.code, 40, `open whose post-checkout hook fails exits 40 (${firstLine(openRed.stderr)})`);
  ok(openRed.stderr.includes(`close --repo ${shellQuote(odd)} --name feat --discard, delete the branch with git -C ${shellQuote(odd)} branch -D aipg/feat, then run open again`), `...naming the close and the branch delete with the repo path quoted for the platform: ${firstLine(openRed.stderr)}`);
});

section('argv is validated, never coerced');
await withFixture(({ repo }) => {
  const cases = [
    [['init', '--repo', repo], /--batch is required/, 'init without --batch'],
    [['init', '--batch', 'b1'], /--repo is required/, 'init without --repo'],
    [['init', '--repo', 'r', '--batch', 'b1'], /ABSOLUTE/, 'a relative --repo'],
    [['init', '--repo', join(repo, 'nope'), '--batch', 'b1'], /not a git repository/, 'a --repo that is not a repo'],
    [['init', '--repo', repo, '--batch'], /needs a value/, 'a bare --batch (never the string "true")'],
    [['init', '--repo', repo, '--batch', 'b1', '--key', 'x'], /unknown flag/, "another verb's flag"],
    [['init', '--repo', repo, '--batch', 'a/b'], /plain name/, 'a --batch with a slash in it'],
    [['prep', '--repo', repo, '--batch', 'b1'], /--key is required/, 'prep without --key'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a'], /--gate is required/, 'land without --gate'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', '  '], /needs a command/, 'land with a blank --gate'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', 'x', '--wait-ms', 'soon'], /MILLISECONDS/, 'a non-numeric --wait-ms'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', 'x', '--stale-ms', '-1'], /MILLISECONDS/, 'a negative --stale-ms'],
    [['land', '--repo', repo, '--batch', 'b1', '--key', 'a', '--gate', 'x', '--scope-file', 'scope.txt'], /ABSOLUTE/, 'a relative --scope-file'],
    [['clean', '--repo', repo], /exactly one of/, 'clean with neither --key nor --batch'],
    [['clean', '--repo', repo, '--key', 'a', '--batch', 'b'], /exactly one of/, 'clean with both'],
    [['open', '--repo', repo], /--name is required/, 'open without --name'],
    [['open', '--repo', repo, '--name', 'int-x'], /starts with "int-"/, 'open with an int- name'],
    [['open', '--repo', repo, '--name', 'INT-x'], /starts with "INT-", and aipg\/int-<x> in any case/, 'open with an INT- name'],
    [['close', '--repo', repo, '--name', 'x'], /exactly one of --into/, 'close with neither --into nor --discard'],
    [['close', '--repo', repo, '--name', 'x', '--into', 'main', '--gate', 'g', '--discard'], /exactly one of --into/, 'close with both --into and --discard'],
    [['close', '--repo', repo, '--name', 'x', '--discard', '--gate', 'g'], /takes no --gate/, 'close --discard with --gate'],
    [['close', '--repo', repo, '--name', 'x', '--into', 'main'], /--gate is required/, 'close --into without --gate'],
    [['close', '--repo', repo, '--name', 'x', '--discard', 'yes'], /unexpected argument/, 'a value after the --discard switch'],
    [['close', '--repo', repo, '--name', 'int-x', '--discard'], /starts with "int-"/, 'close with an int- name'],
    [['nope', '--repo', repo], /unknown verb/, 'an unknown verb'],
    [['constructor'], /unknown verb "constructor"/, 'a bare verb named constructor'],
    [['__proto__'], /unknown verb "__proto__"/, 'a bare verb named __proto__'],
    [['constructor', '--repo', repo], /unknown verb "constructor"/, 'a verb named constructor with a flag'],
    [['__proto__', '--repo', repo], /unknown verb "__proto__"/, 'a verb named __proto__ with a flag'],
    [[], /no verb given/, 'no arguments at all'],
  ];
  for (const [argv, expected, what] of cases) {
    const r = wt(argv);
    eq(r.code, 1, `${what} exits 1`);
    ok(expected.test(r.stderr), `...saying why: ${firstLine(r.stderr)}`);
  }
});

}
