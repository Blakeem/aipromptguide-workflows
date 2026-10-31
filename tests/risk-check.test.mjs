// tools/risk-check.mjs: the risk file checker develop's CLASSIFY phase and acceptance's sweep check run.
//
// What matters here is that a skeleton never passes, that each format error is named, that a rerun search finds a
// hit written inside an escaped source string, and that the low-risk line follows the answers.
//
// Fixtures live under os.tmpdir(), never under tests/fixtures/, as in plan-entry.test.mjs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { FORMAT, NO_CHANGES, RISK_KEYS, SNAPSHOT_LINE, SWEEP_HEADING, parseRiskFile, repoPath, run, searchForms, skeleton } from '../tools/risk-check.mjs';

const dirs = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'aipg-risk-check-')); dirs.push(d); return d; };
const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

/** A repo holding `files`, and the tree id of its working tree. */
function fixtureRepo(files) {
  const repo = tmpDir();
  git(repo, ['init', '-q']);
  // A user-level autocrlf would warn on each fixture file and change no byte the test reads.
  git(repo, ['config', 'core.autocrlf', 'false']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, ['add', '-A']);
  return { repo, tree: git(repo, ['write-tree']) };
}

const FILES = {
  'src/a.mjs': "const one = 'the old rule';\nconst two = 'a block\\'s rule';\n",
  'src/b.md': 'The old rule lives here.\nthe old rule again\n',
  'gen/snap.md': 'the old rule\nthe old rule\nthe old rule\n',
};
const answers = (systems = 'no') => [`- Systems: ${systems}`, '- Paths: no', '- Critical code: no: reads only', '- Assumptions: no.'];
const fileOf = (tree, body) => [`Snapshot: ${tree}`, '', '## src/a.mjs:1', ...answers(), '', '## Sweep', ...body, ''].join('\n');
const check = (repo, tree, text, snapshot = tree) => {
  const path = join(tmpDir(), 'risk-x-r1.md');
  writeFileSync(path, text);
  return { path, ...run([path, '--repo', repo, '--snapshot', snapshot]) };
};
const ALL_HITS = [
  'search: the old rule',
  'scope: src gen',
  '- src/a.mjs:1 updated: the constant',
  '- src/b.md:2 unaffected: prose example',
  '- gen/snap.md (3 hits) unaffected: generated, the gate checks it',
];

section('a missing file gets a skeleton that never passes');
{
  const { repo, tree } = fixtureRepo(FILES);
  const path = join(tmpDir(), 'nested', 'risk-x-r1.md');
  const first = run([path, '--repo', repo, '--snapshot', tree]);
  eq(first.code, 1, 'writing a skeleton exits 1, since the file is not filled');
  ok(first.lines[0].startsWith(`wrote a skeleton to ${path}`) && first.lines.join('\n').includes('A risk file holds, in this order:'), 'it prints the format after the write');
  eq(readFileSync(path, 'utf8'), skeleton(tree), 'the skeleton holds the snapshot id it was given');
  const second = run([path, '--repo', repo, '--snapshot', tree]);
  eq(second.code, 1, 'an unfilled skeleton fails the check');
  ok(second.lines.filter((l) => l.includes("still holds the skeleton's placeholder")).length === 8, `each of the 8 slots is named (${second.lines.length} lines)`);
  ok(!second.lines.some((l) => l.startsWith('low risk:')), 'an unfilled answer prints no low-risk line');
}

section('a complete file passes and prints the low-risk line from its answers');
{
  const { repo, tree } = fixtureRepo(FILES);
  const clean = check(repo, tree, fileOf(tree, ALL_HITS));
  eq(clean.lines.join('\n'), `ok: ${clean.path}\nlow risk: yes`, 'every answer no: ok, then low risk: yes');
  eq(clean.code, 0, 'and exit 0');
  const risky = check(repo, tree, fileOf(tree, ALL_HITS).replace('- Systems: no', '- Systems: yes: edits two engines'));
  eq(risky.lines.at(-1), 'low risk: no', 'one yes answer makes the change not low risk');
  eq(risky.code, 0, 'a yes answer is no problem');
  const none = check(repo, tree, `Snapshot: ${tree}\n\nNo changes.\n`);
  eq(none.lines.join('\n'), `ok: ${none.path}\nlow risk: yes`, 'a round that changed nothing passes as low risk');
  const absolute = check(repo, tree, fileOf(tree, ALL_HITS.map((l) => l.replace('- src/a.mjs:1', `- ${repo.replace(/\\/g, '/')}/src/a.mjs:1`))));
  eq(absolute.code, 0, 'a hit written as an absolute path inside the repo matches');
}

section('the rerun search finds every hit the file leaves out, in plain and escaped forms');
{
  const { repo, tree } = fixtureRepo(FILES);
  const leftOut = check(repo, tree, fileOf(tree, ALL_HITS.filter((l) => !l.includes('src/b.md'))));
  eq(leftOut.code, 1, 'a left-out hit fails the check');
  ok(leftOut.lines.some((l) => l === 'left out: the search on line 10 ("the old rule") finds src/b.md:2: the old rule again'), `the left-out hit is named with its text: ${leftOut.lines.join(' | ')}`);
  const printedAt = leftOut.lines.indexOf('left out: the search on line 10 ("the old rule") finds src/b.md:2: the old rule again');
  eq(leftOut.lines[printedAt + 1], '- src/b.md:2 updated|unaffected: <reason>', 'the sweep line for the hit prints right under its left out line');
  ok(leftOut.lines.includes('1 problem(s):'), 'a left-out hit counts as one problem, whatever lines it prints');
  const withLine = (line) => fileOf(tree, [...ALL_HITS.filter((l) => !l.includes('src/b.md')), line]);
  eq(check(repo, tree, withLine('- src/b.md:2 unaffected: prose example')).code, 0, 'the printed line passes once its verdict and reason are filled in');
  const asPrinted = check(repo, tree, withLine(leftOut.lines[printedAt + 1]));
  ok(asPrinted.code === 1 && asPrinted.lines.some((l) => l.startsWith('error:') && l.includes('keeps `updated|unaffected` as printed, and a hit line takes one verdict')), `the line as printed fails the check: ${asPrinted.lines.join(' | ')}`);
  const unreasoned = check(repo, tree, withLine('- src/b.md:2 updated: <reason>'));
  ok(unreasoned.code === 1 && unreasoned.lines.some((l) => l.startsWith('error:') && l.includes('still holds the printed reason `<reason>`')), `a verdict kept with the printed reason fails the check: ${unreasoned.lines.join(' | ')}`);
  ok(!leftOut.lines.some((l) => l.includes('src/b.md:1')), 'the search is case-sensitive, so "The old rule" is no hit');
  eq(leftOut.lines.at(-1), 'low risk: yes', 'the low-risk line still prints');
  ok(!leftOut.lines.includes(FORMAT), 'a left-out hit alone prints no format');
  const escaped = check(repo, tree, fileOf(tree, ["search: block's rule", 'scope: .']));
  ok(escaped.lines.some((l) => l.startsWith('left out:') && l.includes("src/a.mjs:2: const two = 'a block\\'s rule';")),
    `a hit written as block\\'s in a single-quoted string is found: ${escaped.lines.join(' | ')}`);
  const listed = check(repo, tree, fileOf(tree, ["search: block's rule", 'scope: .', '- src/a.mjs:2 updated: the string']));
  eq(listed.code, 0, 'and listing it passes');
}

section('each sweep line that the search contradicts is an error');
{
  const { repo, tree } = fixtureRepo(FILES);
  const errorsOf = (body) => check(repo, tree, fileOf(tree, body)).lines.filter((l) => l.startsWith('error:'));
  ok(errorsOf([...ALL_HITS, '- src/a.mjs:9 unaffected: gone']).some((l) => l.includes('lists src/a.mjs:9, where the search on line 10 finds no hit')), 'a listed hit the search does not find');
  ok(errorsOf(ALL_HITS.map((l) => l.replace('(3 hits)', '(4 hits)'))).some((l) => l.includes('counts 4 hit(s) in gen/snap.md, and the search finds 3 there')), 'a hit count that differs');
  ok(errorsOf([...ALL_HITS, '- gen/snap.md (3 hits) unaffected: again']).some((l) => l.includes('counts the hits in gen/snap.md a second time')), 'a path counted twice');
  ok(errorsOf([...ALL_HITS, '- src/a.mjs:1 updated: twice']).some((l) => l.includes('lists src/a.mjs:1 a second time')), 'a hit listed twice');
  ok(errorsOf(ALL_HITS.map((l) => l.replace('scope: src gen', 'scope: src nowhere'))).some((l) => l.includes('the scope "nowhere" names no file')), 'a scope that names no file');
}

section('each format error is named by its line');
{
  const { repo, tree } = fixtureRepo(FILES);
  const errorsOf = (text) => parseRiskFile(text).errors;
  const has = (text, part, what) => ok(errorsOf(text).some((e) => e.includes(part)), `${what}: ${errorsOf(text).join(' | ')}`);
  const good = fileOf(tree, ALL_HITS);
  eq(errorsOf(good).length, 0, 'the complete file parses with no error');
  eq(errorsOf(`﻿${good.replace(/\n/g, '\r\n')}`).length, 0, 'a BOM and CRLF line endings parse the same');
  has(good.replace(`Snapshot: ${tree}`, 'snapshot here'), 'line 1 must be `Snapshot: <tree id>`', 'a missing Snapshot line');
  has(good.replace(`Snapshot: ${tree}`, 'Snapshot: HEAD'), 'which is no tree id', 'a Snapshot value that is no tree id');
  has(good.replace('- Paths: no', '- Paths: maybe'), 'the Paths answer is `no`, `no: <note>` or `yes: <evidence>`', 'an answer of neither shape');
  has(good.replace('- Paths: no', '- Paths: yes'), 'the Paths answer is', 'a yes with no evidence');
  has(good.replace('- Paths: no\n', ''), 'has no answer line for Paths', 'a missing answer');
  has(good.replace('- Paths: no', '- Paths: no\n- Paths: no'), 'answers Paths a second time', 'a repeated answer');
  has(good.replace('- Paths: no', '- Speed: no'), 'is no answer line', 'an unknown question');
  has(good.replace('## src/a.mjs:1', '## the parser'), 'a change section is named `## <path>:<line>`', 'a change section not named by its path and line');
  has(good.replace(/## Sweep[\s\S]*$/, ''), 'holds no `## Sweep` section', 'no sweep');
  has(good.replace(/## Sweep[\s\S]*$/, '## Sweep\n'), 'holds no `search:` line', 'an empty sweep');
  has(`${good}\n## src/b.md:1\n${answers().join('\n')}\n`, 'after `## Sweep`', 'a change section after the sweep');
  has(good.replace('scope: src gen\n', ''), 'before the `scope:` line', 'a hit before its scope');
  has(good.replace('scope: src gen\n', ''), 'has no `scope:` line', 'a search with no scope');
  has(`${good}\n## Sweep\nsearch: x\nscope: .\n`, 'is a second `## Sweep` section, after the one on line 9', 'a second sweep');
  has(good.replace('scope: src gen', 'scope: src gen\nscope: src'), 'is a second `scope:` line for the search on line 10', 'a second scope');
  has(good.replace('scope: src gen', 'scope:'), 'is a `scope:` line with no path', 'a scope with no path');
  has(good.replace('search: the old rule', 'search:'), 'is a `search:` line with no text', 'a search with no text');
  has(good.replace('- src/a.mjs:1 updated: the constant', '- src/a.mjs:1 fixed: the constant'), 'is no sweep line', 'a hit with an unknown mark');
  has(good.replace('- src/a.mjs:1 updated: the constant', '- src/a.mjs:1 updated:'), 'marks a hit with no reason', 'a hit with no reason');
  has(`${good}\nNo changes.\n`, 'stands alone', '`No changes.` beside sections');
  has(`Snapshot: ${tree}\n\n`, 'no change section and no `No changes.` line', 'an empty file body');
  has(`Snapshot: ${tree}\nstray text\nNo changes.\n`, 'sits before any section', 'text outside a section');
  const emptyTree = execFileSync('git', ['-C', repo, 'hash-object', '-t', 'tree', '-w', '--stdin'], { input: '', encoding: 'utf8' }).trim();
  const mismatch = check(repo, tree, good, emptyTree);
  ok(mismatch.lines.some((l) => l.includes(`line 1 holds the snapshot ${tree}, not`)), 'a Snapshot line that differs from --snapshot is an error');
  ok(mismatch.lines.includes(FORMAT), 'a file to replace in full gets the format');
  eq(mismatch.lines.at(-1), 'low risk: yes', 'and the low-risk line stays last');
  const malformed = check(repo, tree, good.replace('- Paths: no', '- Paths: maybe'));
  ok(malformed.code === 1 && malformed.lines.includes(FORMAT), 'a format error prints the format');
}

section('a usage or git error exits 2 and writes nothing');
{
  const { repo, tree } = fixtureRepo(FILES);
  const path = join(tmpDir(), 'risk-x-r1.md');
  eq(run([path, '--repo', repo]).code, 2, 'a missing --snapshot');
  eq(run([path, '--repo', repo, '--snapshot', 'HEAD']).code, 2, 'a --snapshot that is no tree id');
  ok(run([path, '--repo', repo, '--snapshot', 'f'.repeat(40)]).lines[0].includes('names no tree'), 'a --snapshot the repo does not hold');
  ok(run([path, '--repo', tmpDir(), '--snapshot', tree]).lines[0].includes('is no git work tree'), 'a --repo outside git');
  eq(run([path, '--repo', repo, '--snapshot', tree, 'extra']).code, 2, 'an extra argument');
  let exists = true;
  try { readFileSync(path); } catch { exists = false; }
  ok(!exists, 'no refused call wrote the file');
  const badScope = check(repo, tree, fileOf(tree, ALL_HITS.map((l) => l.replace('scope: src gen', 'scope: :(bad)x'))));
  ok(badScope.code === 2 && badScope.lines[0].includes('git ls-files failed for the scope ":(bad)x"'), `a failed git call exits 2: ${badScope.lines.join(' | ')}`);
  const cli = (() => {
    try { execFileSync(process.execPath, [join(REPO_ROOT, 'tools/risk-check.mjs'), path], { encoding: 'utf8', stdio: 'pipe' }); return { code: 0 }; }
    catch (e) { return { code: e.status, stderr: String(e.stderr) }; }
  })();
  ok(cli.code === 2 && cli.stderr.startsWith('risk-check: usage:'), `the CLI prints a usage error on stderr with exit 2 (exit ${cli.code})`);
}

section('helpers');
{
  eq(JSON.stringify(searchForms('plain')), JSON.stringify(['plain']), 'a literal with no quote or backslash has one form');
  eq(JSON.stringify(searchForms("block's ${x}")), JSON.stringify(["block's ${x}", "block\\'s ${x}", "block's \\${x}"]), 'each quote escapes in its own form, and a template escapes ${');
  eq(JSON.stringify(searchForms('a\\b')), JSON.stringify(['a\\b', 'a\\\\b']), 'a backslash doubles');
  eq(repoPath('.\\src\\a.mjs', 'E:/r'), 'src/a.mjs', 'a Windows relative path takes forward slashes');
  eq(repoPath('e:/R/src/a.mjs', 'E:/r'), 'src/a.mjs', 'an absolute path inside the repo becomes relative');
}

section("the risk file constants agree with develop's copies");
{
  const engine = readFileSync(join(REPO_ROOT, 'workflows/develop/develop-cycle.mjs'), 'utf8');
  const questions = engine.slice(engine.indexOf('const RISK_QUESTIONS'), engine.indexOf('`;', engine.indexOf('const RISK_QUESTIONS')));
  const names = [...questions.matchAll(/^ {2}- ([A-Za-z ]+):/gm)].map((m) => m[1]);
  eq(JSON.stringify(names), JSON.stringify(RISK_KEYS), 'the tool parses one answer line per question, by the name the prompt gives it');
  const engineConst = (name) => engine.match(new RegExp(`^const ${name} = '([^']*)';$`, 'm'))?.[1];
  eq(engineConst('SNAPSHOT_LINE'), SNAPSHOT_LINE, 'the engine names the first line as the tool parses it');
  eq(engineConst('SWEEP_HEADING'), SWEEP_HEADING, 'the engine names the sweep heading as the tool parses it');
  ok(engine.includes(`reads "${NO_CHANGES}"`), 'the engine names the no-change line as the tool parses it');
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
