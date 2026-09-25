// tools/plan-edit.mjs — the only tool that writes a plan file.
//
// What matters here is that a failure changes NOTHING and a success changes exactly what was asked, byte
// for byte. Every case compares the file before and after: an edit that also normalized a BOM, flipped a
// line ending or added a trailing newline would corrupt an approved plan silently, and the corruption
// would only surface as a strange failure in the run that builds against it.
//
// Fixtures live under os.tmpdir(), never under tests/fixtures/ — the repo-wide CR scan walks that folder
// and a CRLF fixture would turn it red.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { parseBlocks, resolveRoadmap, validate, run as planBlock } from '../tools/plan-block.mjs';
import { run } from '../tools/plan-edit.mjs';

const CLI = join(REPO_ROOT, 'tools/plan-edit.mjs');
const BOM = '\uFEFF';   // escaped: the character itself is invisible in an editor

// Three blocks, one feature and two fix: every run the grammar has (file keys, a block preamble, an issue
// `- key:` run) plus an entry with NO run at all, which is the append-under-the-heading case.
const PLAN = [
  'goal: ship the bus',
  '',
  '## Plan: bus-parser - the grammar',
  'mode: feature',
  'gate: build-only',
  '',
  'body',
  '',
  '## Plan: inventory - the verified issues',
  'mode: fix',
  'gate: green',
  '',
  '### [null-deref] the loader crashes',
  '- severity: high',
  '- decision: ACTIONABLE',
  '',
  'What happens: prose, and a bullet that is not metadata.',
  '',
  '### [no-meta] an entry with no run',
  '',
  'prose.',
  '',
  '## Plan: triage - the second inventory',
  'mode: fix',
  'gate: green',
  '',
  '### [flaky-test] the suite is flaky',
  '- severity: low',
  '',
].join('\n');

// The move destination. Its fix block is NOT last, so "appended at the end of the BLOCK" is distinguishable
// from "appended at the end of the file".
const DEST = [
  '## Plan: inbox - the fix bucket',
  'mode: fix',
  'gate: green',
  '',
  '### [old-one] an existing entry',
  '- severity: low',
  '',
  '## Plan: later - a feature',
  'mode: feature',
  'gate: green',
  '',
  'body',
  '',
].join('\n');

// Three fix blocks in a row, for the same-file move whose destination is in the MIDDLE of the file.
const MIDDLE = [
  '## Plan: first - the source inventory',
  'mode: fix',
  'gate: green',
  '',
  '### [alpha] the entry that moves',
  '- severity: high',
  '',
  '## Plan: second - the destination',
  'mode: fix',
  'gate: green',
  '',
  '### [beta] an entry already here',
  '- severity: low',
  '',
  '## Plan: third - the block that must not move',
  'mode: fix',
  'gate: green',
  '',
  '### [gamma] the tail entry',
  '- severity: low',
  '- decision: DEFER',
  '',
  'Prose that keeps this block longer than the entry being moved.',
  '',
].join('\n');

// A file whose LAST line is an entry heading with no run — the insertion point is then end of file, which
// is not the start of a line. PLAN cannot cover this: its own trailing entry carries a "- severity:" line.
const TAIL_HEADING = [
  '## Plan: inventory - the issues',
  'mode: fix',
  'gate: green',
  '',
  '### [norun] the last line of the file',
].join('\n');

const dirs = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'aipg-plan-edit-')); dirs.push(d); return d; };
const read = (p) => readFileSync(p, 'utf8');

function fixture(text = PLAN, name = 'roadmap.md', dir = tmpDir()) {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}

/** The message from a run() that must fail, or '' if it wrongly succeeded. */
function fails(...argv) {
  try {
    run(argv);
    return '';
  } catch (e) { return e.message; }
}

/** The entry's own bytes, taken from plan-block's parse — the exact span the tool claims to move. */
function entryBytes(text, id) {
  for (const block of parseBlocks(text)) {
    const entry = block.issues.find((e) => e.id === id);
    if (entry) return text.slice(entry.start, entry.end);
  }
  return '';
}

/** The parsed entry an id addresses — what a later run reads back, as opposed to the bytes on disk. */
function entryOf(text, id) {
  for (const block of parseBlocks(text)) {
    const entry = block.issues.find((e) => e.id === id);
    if (entry) return entry;
  }
  return null;
}

/** Every id in a file, in file order — a block's, then its entries'. The two share one namespace. */
const idSpace = (path) => validate(parseBlocks(read(path)), path).flatMap((b) => [b.id, ...b.issues.map((e) => e.id)]);

section('set rewrites ONE line in place, and every other byte is untouched');
{
  const block = fixture();
  const beforeBlock = read(block);
  run(['set', block, 'bus-parser', 'gate=green']);
  eq(read(block), beforeBlock.replace('gate: build-only', 'gate: green'),
    'a block key: the value span alone is overwritten');

  const issue = fixture();
  const beforeIssue = read(issue);
  run(['set', issue, 'null-deref', 'severity=low']);
  eq(read(issue), beforeIssue.replace('- severity: high', '- severity: low'),
    'an issue key: the same, in that entry\'s own run');
}

section('an absent key is appended to the END of its run, or under the header when the run is empty');
{
  const preamble = fixture();
  const beforePreamble = read(preamble);
  run(['set', preamble, 'bus-parser', 'status=done']);
  eq(read(preamble), beforePreamble.replace('gate: build-only\n', 'gate: build-only\nstatus: done\n'),
    'a block preamble: directly after its last key line');

  const entry = fixture();
  const beforeEntry = read(entry);
  run(['set', entry, 'null-deref', 'effort=1h']);
  eq(read(entry), beforeEntry.replace('- decision: ACTIONABLE\n', '- decision: ACTIONABLE\n- effort: 1h\n'),
    'an issue run: directly after its last "- key:" line, and the prose bullet below is not touched');

  const emptyRun = fixture();
  const beforeEmptyRun = read(emptyRun);
  run(['set', emptyRun, 'no-meta', 'severity=low']);
  eq(read(emptyRun), beforeEmptyRun.replace('### [no-meta] an entry with no run\n', '### [no-meta] an entry with no run\n- severity: low\n'),
    'an entry with no run at all: directly under its heading');

  // The empty-preamble twin: markdown's blank line under the header means the run starts nowhere, so the
  // new line has to be placed against the header itself rather than against a run that does not exist.
  const BARE = '## Plan: bare - no preamble\n\nbody\n';
  const bare = fixture(BARE, 'bare.md');
  run(['set', bare, 'bare', 'status=done']);
  eq(read(bare), '## Plan: bare - no preamble\nstatus: done\n\nbody\n',
    'an empty block preamble: directly under the header');
}

section('the first key of an entry whose heading is the file\'s LAST line goes on its own line, not welded on');
{
  // The insertion point clamps to end of file here, so a naive splice lands ON the heading. That still
  // parses as the same entry — the id is unchanged and nothing throws — so the failure is silent: the file
  // gains a mangled title and the key the operator set is simply absent.
  for (const [name, text, eol] of [['LF', TAIL_HEADING, '\n'], ['CRLF', TAIL_HEADING.replace(/\n/g, '\r\n'), '\r\n']]) {
    const file = fixture(text, 'tail.md');
    run(['set', file, 'norun', 'severity=low']);
    eq(read(file), `${text}${eol}- severity: low`, `${name}, no trailing newline: the line is appended below the heading`);
    const entry = entryOf(read(file), 'norun');
    eq(entry.values.severity, 'low', `${name}: and the key is really set, not swallowed by the heading`);
    eq(entry.title, 'the last line of the file', `${name}: the heading's own title is untouched`);
  }

  // The twin: the same heading, but the file ends with a newline. The insertion point is end of file again,
  // and appending without a terminator would delete a trailing newline the file had.
  const ended = fixture(`${TAIL_HEADING}\n`, 'tail-nl.md');
  run(['set', ended, 'norun', 'severity=low']);
  eq(read(ended), `${TAIL_HEADING}\n- severity: low\n`, 'a trailing newline the file had is still there afterwards');
}

section('a BOM, a CRLF and a missing trailing newline all survive the edit');
{
  const after = {};
  for (const [name, text] of [['plain', PLAN], ['CRLF', PLAN.replace(/\n/g, '\r\n')],
    ['BOM', `${BOM}${PLAN}`], ['no trailing newline', PLAN.trimEnd()]]) {
    const file = fixture(text, 'roadmap.md');
    const before = read(file);
    run(['set', file, 'bus-parser', 'gate=green']);
    const replaced = read(file);
    eq(replaced, before.replace('gate: build-only', 'gate: green'), `${name}: the value span alone`);

    run(['set', file, 'bus-parser', 'status=done']);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    eq(read(file), replaced.replace(`gate: green${eol}`, `gate: green${eol}status: done${eol}`),
      `${name}: the appended line inherits the file's dominant line ending`);
    after[name] = read(file);
  }
  ok(after.CRLF.includes('status: done\r\n'), 'the line appended to a CRLF file ends with CRLF');
  ok(!after.CRLF.includes('status: done\n\n'), 'and not with a bare LF');
  ok(after.BOM.startsWith(BOM), 'the BOM is still the first byte, so the positions were raw ones');
  ok(!after['no trailing newline'].endsWith('\n'), 'a file with no trailing newline still has none');
}

section('a bare plan-name resolves exactly where plan-block resolves it, for set and for both move arguments');
{
  const cfg = tmpDir();
  mkdirSync(join(cfg, 'plans'));
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;

  const srcPath = join(cfg, 'plans', 'bus-src.md');
  const destPath = join(cfg, 'plans', 'bus-dest.md');
  writeFileSync(srcPath, PLAN);
  writeFileSync(destPath, DEST);
  eq(resolveRoadmap('bus-src'), srcPath, 'the two tools resolve the bare name to one absolute path');

  run(['set', 'bus-src', 'bus-parser', 'gate=green']);
  ok(read(srcPath).includes('gate: green'), 'set addressed the file by its bare name');

  run(['move', 'bus-src', 'null-deref', 'bus-dest', 'inbox']);
  ok(!read(srcPath).includes('null-deref'), 'move resolved the bare SOURCE name');
  ok(read(destPath).includes('null-deref'), 'and the bare DESTINATION name');

  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
}

section('move cuts the entry from its source and appends it, verbatim, to the end of the destination block');
{
  // Two temp dirs: the cross-directory case, where nothing about the two files' locations can be shared.
  const src = fixture(PLAN, 'src.md');
  const dest = fixture(DEST, 'dest.md');
  const beforeSrc = read(src);
  const beforeDest = read(dest);
  const bytes = entryBytes(beforeSrc, 'null-deref');

  run(['move', src, 'null-deref', dest, 'inbox']);
  eq(read(src), beforeSrc.replace(bytes, ''), 'the source loses exactly the entry bytes, and nothing else');
  eq(read(dest), beforeDest.replace('## Plan: later', `${bytes}## Plan: later`),
    'the destination gains them at the end of the fix BLOCK, before the next header');

  eq(idSpace(src).join(','), 'bus-parser,inventory,no-meta,triage,flaky-test', 'the source id space, minus the entry');
  eq(idSpace(dest).join(','), 'inbox,old-one,null-deref,later', 'the destination id space, plus it');
  ok(planBlock([src, '--list']).includes('"inventory"'), '--list still reads the source');
  ok(planBlock([dest, '--list']).includes('"inbox"'), 'and the destination');
}

section('source and destination may be the same file — a regrouping move writes it once');
{
  const forward = fixture();
  const beforeForward = read(forward);
  const nullDeref = entryBytes(beforeForward, 'null-deref');
  run(['move', forward, 'null-deref', forward, 'triage']);
  eq(read(forward), `${beforeForward.replace(nullDeref, '')}${nullDeref}`,
    'cut from inventory, appended to triage — which is the last block, so at end of file');

  // The destination block is neither the entry's own nor the last one, so the insertion point sits AFTER
  // the cut and must move back by the entry's length. Against the last block the arithmetic is invisible:
  // an over-large index clamps to end of file, which is where the entry belonged anyway.
  const middle = fixture(MIDDLE, 'middle.md');
  const beforeMiddle = read(middle);
  const alpha = entryBytes(beforeMiddle, 'alpha');
  run(['move', middle, 'alpha', middle, 'second']);
  eq(read(middle), beforeMiddle.replace(alpha, '').replace('## Plan: third', `${alpha}## Plan: third`),
    'cut from the first block, appended to the end of the second, with the third untouched');
  eq(idSpace(middle).join(','), 'first,second,beta,alpha,third,gamma', 'one consistent id space afterwards');

  // The other direction: the insertion point sits BEFORE the cut, so it must not be shifted back.
  const backward = fixture();
  const beforeBackward = read(backward);
  const flaky = entryBytes(beforeBackward, 'flaky-test');
  run(['move', backward, 'flaky-test', backward, 'inventory']);
  eq(read(backward), beforeBackward.replace(flaky, '').replace('## Plan: triage', `${flaky}## Plan: triage`),
    'cut from triage, appended to the end of the EARLIER inventory block');
  eq(idSpace(backward).join(','), 'bus-parser,inventory,null-deref,no-meta,flaky-test,triage',
    'and the file still holds one consistent id space');
}

section('every set failure exits 1 naming the problem, with the file\'s bytes unchanged');
{
  const file = fixture();
  const before = read(file);
  const cases = [
    [['set', file, 'nope', 'status=done'], /no id "nope"/, 'an unknown id, listing the ids that do exist'],
    [['set', file, 'bus-parser', 'goal=x'], /unknown preamble key "goal"/, 'a key the block namespace does not have'],
    [['set', file, 'null-deref', 'sevrity=high'], /unknown issue key "sevrity"/, 'a key the issue namespace does not have'],
    // A key outside `[a-z_]+` writes a line that ENDS the run rather than joining it, so a reparse of the
    // edited text sees no new key at all: these are refused before the splice or not at all.
    [['set', file, 'bus-parser', 'test-selector=npm test'], /unknown preamble key "test-selector"/, 'a hyphen where the key has an underscore'],
    [['set', file, 'bus-parser', 'Status=done'], /unknown preamble key "Status"/, 'a capitalized block key'],
    [['set', file, 'null-deref', 'Severity=low'], /unknown issue key "Severity"/, 'a capitalized issue key'],
    [['set', file, 'bus-parser', ' status=done'], /unknown preamble key " status"/, 'a key with a leading space'],
    [['set', file, 'bus-parser', 'status=nearly'], /illegal preamble key "status: nearly"/, 'an illegal block enum names the key AND the value'],
    [['set', file, 'bus-parser', 'mode=fixup'], /illegal preamble key "mode: fixup"/, 'an illegal mode'],
    [['set', file, 'null-deref', 'severity=urgent'], /illegal issue key "severity: urgent"/, 'an illegal issue enum'],
    [['set', file, 'null-deref', 'decision=MAYBE'], /illegal issue key "decision: MAYBE"/, 'an illegal decision'],
    [['set', file, 'null-deref', 'status=nearly'], /illegal issue key "status: nearly"/, 'and an illegal issue status — the enums differ by run'],
    [['set', file, 'inventory', 'gate=build-only'], /mode fix does not allow/, 'a gate the block\'s own mode forbids'],
    [['set', file, 'bus-parser', 'gate=red-baseline'], /mode feature does not allow/, 'the same check on a feature block'],
    [['set', file, 'bus-parser', 'test_selector=a\nb'], /contains a line break/, 'a value carrying a line break'],
    [['set', file, 'bus-parser', 'status'], /is not <key>=<value>/, 'an argument that is not an assignment'],
    [['set', file, 'bus-parser', '=done'], /is not <key>=<value>/, 'an assignment with no key'],
    [['set', file, 'bus-parser'], /usage:/, 'too few arguments'],
    [['set', file, 'bus-parser', 'status=done', 'extra'], /usage:/, 'and too many'],
    [['set', join(tmpDir(), 'missing.md'), 'a', 'status=done'], /no such plan file/, 'a file that is not there'],
  ];
  for (const [argv, re, what] of cases) {
    ok(re.test(fails(...argv)), what);
    eq(read(file), before, `${what} — nothing was written`);
  }
}

section('an inherited Object.prototype name is a key nowhere — neither in the argument nor already in the file');
{
  // `key in schema` answered true for twelve names the grammar does not have. Ten carry a capital, so the
  // line they built missed the run shape, the round-trip parse read it as prose and the junk went to disk
  // at exit 0 — with every key BELOW it now outside the run, silently back to its default on the next read.
  const file = fixture();
  const before = read(file);
  const cases = [
    [['set', file, 'bus-parser', 'valueOf=x'], /unknown preamble key "valueOf"/, 'a camelCase inherited name on the preamble run'],
    [['set', file, 'null-deref', 'toString=x'], /unknown issue key "toString"/, 'the same on an issue run'],
    [['set', file, 'bus-parser', 'hasOwnProperty=x'], /unknown preamble key "hasOwnProperty"/, 'and another of the ten'],
    [['set', file, 'bus-parser', 'constructor=x'], /unknown preamble key "constructor"/, 'an all-lowercase one, whose line WOULD have rejoined the run'],
    [['set', file, 'null-deref', '__proto__=x'], /unknown issue key "__proto__"/, 'and its issue-run twin'],
  ];
  for (const [argv, re, what] of cases) {
    ok(re.test(fails(...argv)), what);
    eq(read(file), before, `${what} — nothing was written`);
  }

  // The same hole one level down, in the parser this tool reads its positions from. Only the two
  // all-lowercase names reach it, and both were reported as "set twice" — a key the file sets once.
  const carried = fixture(PLAN.replace('mode: feature\n', 'mode: feature\nconstructor: zzz\n'), 'carried.md');
  const beforeCarried = read(carried);
  ok(/unknown preamble key "constructor"/.test(fails('set', carried, 'bus-parser', 'status=done')),
    'a file already carrying such a line names THAT key, not a duplicate');
  eq(read(carried), beforeCarried, 'and it is never edited');
}

section('every move failure exits 1, with BOTH files\' bytes unchanged');
{
  const src = fixture(PLAN, 'src.md');
  const dest = fixture(DEST, 'dest.md');
  const clash = fixture(DEST.replace('old-one', 'null-deref'), 'clash.md');
  const blockClash = fixture(DEST.replace('## Plan: later - a feature', '## Plan: no-meta - a feature'), 'block-clash.md');
  const before = new Map([src, dest, clash, blockClash].map((p) => [p, read(p)]));
  const cases = [
    [['move', src, 'nope', dest, 'inbox'], /no issue "nope"/, 'an unknown issue id in the source'],
    [['move', src, 'inventory', dest, 'inbox'], /no issue "inventory"/, 'a BLOCK id, which is not an entry'],
    [['move', src, 'null-deref', dest, 'nope'], /no plan "nope"/, 'an unknown block id in the destination'],
    [['move', src, 'null-deref', dest, 'later'], /is mode feature/, 'a destination block that is not mode fix'],
    [['move', src, 'null-deref', clash, 'inbox'], /already claimed/, 'an id an entry in the destination already holds'],
    [['move', src, 'no-meta', blockClash, 'inbox'], /already claimed/, 'an id a destination BLOCK holds — one namespace'],
    [['move', src, 'null-deref', dest], /usage:/, 'too few arguments'],
  ];
  for (const [argv, re, what] of cases) {
    ok(re.test(fails(...argv)), what);
    ok([...before].every(([p, text]) => read(p) === text), `${what} — nothing was written to either file`);
  }
}

section('a move whose destination cannot be written leaves the entry in the SOURCE, never in neither file');
{
  // The one fault the up-front validation cannot pre-empt is an I/O error between the two writes. Losing
  // the entry from both files is unrecoverable — the plan file is its only copy — so the destination is
  // written first and a fault duplicates the entry instead.
  const src = fixture(PLAN, 'src.md');
  const dest = fixture(DEST, 'dest.md');
  const beforeSrc = read(src);
  const beforeDest = read(dest);

  chmodSync(dest, 0o444);
  let enforced = true;
  try { writeFileSync(dest, beforeDest); enforced = false; } catch { /* read-only is honored here */ }

  if (enforced) {
    ok(fails('move', src, 'null-deref', dest, 'inbox') !== '', 'the move fails loudly');
    ok(read(src).includes('### [null-deref]'), 'the entry is still in the source, where it can be moved again');
    eq(read(dest), beforeDest, 'and the destination never changed');
    eq(read(src), beforeSrc, 'so neither file moved at all');
  } else {
    ok(true, 'this user can write a read-only file, so the write order is not observable here');
  }
  chmodSync(dest, 0o666);
}

section('a cross-file move whose SOURCE cannot be written names the duplicate and the manual cut');
{
  // No parse sees an id duplicated across two files, so the error is the only signal of the half-applied move.
  const src = fixture(PLAN, 'src.md');
  const dest = fixture(DEST, 'dest.md');
  const beforeSrc = read(src);

  chmodSync(src, 0o444);
  let enforced = true;
  try { writeFileSync(src, beforeSrc); enforced = false; } catch { /* read-only is honored here */ }

  if (enforced) {
    const message = fails('move', src, 'null-deref', dest, 'inbox');
    ok(message.includes(`${dest} already holds null-deref`), 'the error names the destination that holds the entry');
    ok(message.includes(`delete the "### [null-deref]" entry from ${src} by hand`), 'and the manual cut from the source');
    ok(read(dest).includes('### [null-deref]'), 'the destination holds the entry');
    eq(read(src), beforeSrc, 'and the source still does, unchanged');
  } else {
    ok(true, 'this user can write a read-only file, so the source-write failure is not observable here');
  }
  chmodSync(src, 0o666);
}

section('the CLI itself: exit codes, where the message goes, and what reaches disk');
{
  const file = fixture();
  const before = read(file);
  const cli = (...argv) => {
    try {
      return { stdout: execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', stdio: 'pipe' }), stderr: '', code: 0 };
    } catch (e) { return { stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status ?? 1 }; }
  };

  const good = cli('set', file, 'bus-parser', 'status=done');
  eq(good.code, 0, 'exit 0 on success');
  ok(good.stdout.includes('status') && good.stdout.includes('bus-parser'), 'and it names what it set, on stdout');
  ok(read(file).includes('status: done'), 'the file really was written');

  const written = read(file);
  const bad = cli('set', file, 'no-such-id', 'status=done');
  eq(bad.code, 1, 'exit 1 on an unknown id');
  ok(bad.stderr.includes('plan-edit:'), 'the reason goes to stderr');
  eq(read(file), written, 'and the file is byte-identical afterwards');

  eq(cli().code, 1, 'exit 1 with usage when the subcommand is missing');
  eq(cli('rename', file, 'x').code, 1, 'and on an unknown subcommand');
  eq(read(file), written, 'neither of which wrote anything');
  ok(before !== written, 'the fixture was edited exactly once across this section');
}

section('sync applies a develop result\'s statusSync across several files, from the object or a bare array');
{
  const plan = fixture();
  const dest = fixture(DEST, 'inbox.md');
  const [planBefore, destBefore] = [read(plan), read(dest)];
  const edits = [
    { planPath: plan, id: 'bus-parser', key: 'status', value: 'done' },
    { planPath: dest, id: 'inbox', key: 'status', value: 'parked' },
    { planPath: plan, id: 'null-deref', key: 'status', value: 'fixed' },
    { planPath: dest, id: 'old-one', key: 'status', value: 'stale' },
  ];
  const result = fixture(JSON.stringify({ runId: 'r', status: 'done (all blocks staged)', statusSync: edits }), 'result.json');
  const out = run(['sync', result]);
  eq(read(plan), planBefore.replace('gate: build-only', 'gate: build-only\nstatus: done')
    .replace('- decision: ACTIONABLE', '- decision: ACTIONABLE\n- status: fixed'), 'the first file carries both of its edits, nothing else');
  eq(read(dest), destBefore.replace('gate: green', 'gate: green\nstatus: parked')
    .replace('- severity: low', '- severity: low\n- status: stale'), 'and the second file both of its own');
  ok(out.includes(plan) && out.includes(dest), 'the output names each file it wrote');

  const [planAfter, destAfter] = [read(plan), read(dest)];
  const again = run(['sync', result]);
  ok(/nothing to change/.test(again), `a second run is a no-op and says so: ${again.trim()}`);
  eq(read(plan) + read(dest), planAfter + destAfter, 'and writes no byte');

  const bare = fixture(PLAN, 'bare.md');
  const bareBefore = read(bare);
  run(['sync', fixture(JSON.stringify([{ planPath: bare, id: 'triage', key: 'status', value: 'blocked' }]), 'bare.json')]);
  eq(read(bare), bareBefore.replace('mode: fix\ngate: green\n\n### [flaky-test]', 'mode: fix\ngate: green\nstatus: blocked\n\n### [flaky-test]'),
    'a bare array of edits works the same');
  eq(run(['sync', fixture(JSON.stringify({ statusSync: [] }), 'empty.json')]).trim(), 'nothing to change: 0 edit(s) across 0 file(s) already applied',
    'an empty statusSync changes nothing');
}

section('sync keeps a BOM, CRLF line endings and a missing trailing newline, exactly as set does');
{
  const file = fixture(`${BOM}${PLAN.trimEnd().replace(/\n/g, '\r\n')}`);
  const before = read(file);
  run(['sync', fixture(JSON.stringify([{ planPath: file, id: 'bus-parser', key: 'status', value: 'done' }]), 'r.json')]);
  eq(read(file), before.replace('gate: build-only', 'gate: build-only\r\nstatus: done'), 'only the appended line differs, in the file\'s own ending');
}

section('one bad edit in any file writes NO file, and the failure names the file, id, key and value');
{
  const plan = fixture();
  const dest = fixture(DEST, 'inbox.md');
  const [planBefore, destBefore] = [read(plan), read(dest)];
  const good = { planPath: plan, id: 'bus-parser', key: 'status', value: 'done' };
  const syncWith = (bad) => fails('sync', fixture(JSON.stringify([good, bad]), 'result.json'));
  const cases = [
    [{ planPath: dest, id: 'inbox', key: 'status', value: 'nearly' }, /inbox status=nearly: .*illegal preamble key "status: nearly"/, 'an illegal value in the LAST file'],
    [{ planPath: dest, id: 'ghost', key: 'status', value: 'done' }, /ghost status=done: no id "ghost"/, 'an unknown id'],
    [{ planPath: dest, id: 'old-one', key: 'sevrity', value: 'low' }, /old-one sevrity=low: unknown issue key "sevrity"/, 'an unknown key'],
    [{ planPath: dest, id: 'inbox', key: 'status', value: 'done\nstatus: todo' }, /contains a line break/, 'a value carrying a line break'],
    [{ planPath: 'plans/inbox.md', id: 'inbox', key: 'status', value: 'done' }, /relative planPath "plans\/inbox\.md"/, 'a relative planPath'],
    [{ planPath: dest, id: 'inbox', key: 'status' }, /is not \{ planPath, id, key, value \} strings/, 'an edit missing a field'],
  ];
  for (const [bad, re, what] of cases) {
    const msg = syncWith(bad);
    ok(re.test(msg), `${what}: ${msg.slice(0, 90)}`);
    eq(read(plan) + read(dest), planBefore + destBefore, `${what} — neither file was written, the good edit included`);
  }
  ok(syncWith({ planPath: dest, id: 'inbox', key: 'status', value: 'nearly' }).includes(dest), 'the message names the file at fault');
  ok(/neither a develop result/.test(fails('sync', fixture('{"status":"done"}', 'no-sync.json'))), 'a result with no statusSync fails');
  ok(/as JSON/.test(fails('sync', fixture('not json', 'bad.json'))), 'a file that is not JSON fails');
  ok(/no such result file/.test(fails('sync', join(tmpDir(), 'missing.json'))), 'a missing result file fails');
  ok(/usage:/.test(fails('sync')), 'and so does a missing argument');

  const cliOut = (() => {
    try {
      execFileSync(process.execPath, [CLI, 'sync', fixture(JSON.stringify([good, { planPath: dest, id: 'ghost', key: 'status', value: 'done' }]), 'cli.json')], { stdio: 'pipe' });
      return { code: 0, stderr: '' };
    } catch (e) { return { code: e.status ?? 1, stderr: String(e.stderr || '') }; }
  })();
  eq(cliOut.code, 1, 'the CLI exits 1');
  ok(cliOut.stderr.includes('ghost'), 'naming the edit at fault on stderr');
  eq(read(plan) + read(dest), planBefore + destBefore, 'with every file byte-identical');
}

for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
