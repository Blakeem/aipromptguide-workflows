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
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { RUN_KEYS, parseBlocks, resolveRoadmap, validate, run as planBlock } from '../tools/plan-block.mjs';
import { PLACEHOLDER, STRENGTH, run } from '../tools/plan-edit.mjs';

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
  run(['set', entry, 'null-deref', 'size=1h']);
  eq(read(entry), beforeEntry.replace('- decision: ACTIONABLE\n', '- decision: ACTIONABLE\n- size: 1h\n'),
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
    [['set', file, 'null-deref', 'effort=small'], /issue key "effort" was renamed to "size", so use size in its place/, 'the issue key renamed to size'],
    // A key outside `[a-z_]+` writes a line that ENDS the run rather than joining it, so a reparse of the
    // edited text sees no new key at all: these are refused before the splice or not at all.
    [['set', file, 'bus-parser', 'test-selector=npm test'], /unknown preamble key "test-selector"/, 'a hyphen where the key has an underscore'],
    [['set', file, 'bus-parser', 'Status=done'], /unknown preamble key "Status"/, 'a capitalized block key'],
    [['set', file, 'null-deref', 'Severity=low'], /unknown issue key "Severity"/, 'a capitalized issue key'],
    [['set', file, 'bus-parser', ' status=done'], /unknown preamble key " status"/, 'a key with a leading space'],
    [['set', file, 'bus-parser', 'status=nearly'], /illegal preamble key "status: nearly"/, 'an illegal block enum names the key AND the value'],
    [['set', file, 'bus-parser', 'mode=fixup'], /illegal preamble key "mode: fixup"/, 'an illegal mode'],
    [['set', file, 'bus-parser', 'model=gpt'], /illegal preamble key "model: gpt" — model takes opus \| sonnet \| haiku \| fable/, 'an illegal developer model'],
    [['set', file, 'bus-parser', 'effort=ultra'], /illegal preamble key "effort: ultra" — effort takes low \| medium \| high \| xhigh \| max/, 'an illegal developer effort'],
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

// ---------------------------------------------------------------------------------------------
// args — the run records Claude Code writes, folded into the plans before every launch
// ---------------------------------------------------------------------------------------------

/** A run record shaped like the runtime's own, carrying one STATUS_LOG line per finished block. */
function record({ runId = 'wf_1', status = 'completed', timestamp = '2026-09-25T10:00:00.000Z', blocks = [], workflowName = 'develop-cycle', args = {} } = {}) {
  const logs = ['develop: 1/1 block(s) to build', ...blocks.map((edits) => `status-sync ${JSON.stringify(edits)}`)];
  return { runId, timestamp, workflowName, status, logs, args, result: null };
}

/** A config dir holding each record where the runtime puts it: projects/<project>/<session>/workflows/. */
function configWith(records) {
  const dir = tmpDir();
  records.forEach((r, i) => {
    const runs = join(dir, 'projects', `proj-${i % 2}`, `session-${i}`, 'workflows');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, `${r.runId ?? `wf_${i}`}.json`), JSON.stringify(r));
  });
  return dir;
}

/** plan-edit args under a config dir: { out, notes } on success, { err } on failure. */
function argsWith(configDir, ...argv) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const notes = [];
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return { out: run(['args', ...argv], (l) => notes.push(l)), notes: notes.join('') };
  } catch (e) {
    return { err: e.message, notes: notes.join('') };
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

const status = (id, value, planPath) => ({ planPath, id, key: 'status', value });

section('args folds a finished run into every plan it names, then prints develop\'s args');
{
  const plan = fixture();
  const dest = fixture(DEST, 'inbox.md');
  const config = configWith([record({ blocks: [
    [status('bus-parser', 'done', plan)],
    [status('inventory', 'done', plan), status('null-deref', 'fixed', plan)],
    [status('inbox', 'parked', dest), status('old-one', 'needs-attention', dest)],
  ] })]);
  const [planBefore, destBefore] = [read(plan), read(dest)];

  const { out, notes, err } = argsWith(config, plan);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(read(plan), planBefore.replace('goal: ship the bus', 'goal: ship the bus\nsynced: 2026-09-25T10:00:00.000Z')
    .replace('gate: build-only', 'gate: build-only\nstatus: done')
    .replace('mode: fix\ngate: green\n\n### [null-deref]', 'mode: fix\ngate: green\nstatus: done\n\n### [null-deref]')
    .replace('- decision: ACTIONABLE', '- decision: ACTIONABLE\n- status: fixed'), 'the plan carries its three edits and the synced marker, nothing else');
  eq(read(dest), destBefore, 'a plan the command was not given is left alone');
  ok(/applied 3 status edit\(s\) from run wf_1 \(completed\)/.test(notes), `the note names the run and the count: ${notes.trim()}`);

  const args = JSON.parse(out);
  eq(args.goal, 'ship the bus', 'the file keys come through with defaults applied');
  eq(args.plans.map((r) => `${r.id}=${r.status}`).join(','), 'bus-parser=done,inventory=done,triage=todo', 'and the rows carry the folded statuses');
  ok(args.plans.every((r) => r.planPath === plan), 'every row names its plan file');

  const after = read(plan);
  const again = argsWith(config, plan);
  eq(read(plan), after, 'a second call writes no byte: the synced marker covers the run');
  eq(again.notes, '', 'and applies nothing');
}

section('args prints blockTool, the plan-block.mjs beside the plan-edit.mjs that ran, spelled as the caller ran it');
// Node realpaths the main module, so the CLI takes the folder from argv[1] to keep the caller's spelling, and
// only an imported run falls back to its own file.
{
  const plan = fixture();
  const config = configWith([]);
  const imported = JSON.parse(argsWith(config, plan).out ?? '{}').blockTool;
  eq(imported, join(REPO_ROOT, 'tools', 'plan-block.mjs').replace(/\\/g, '/'), 'an imported run names the plan-block.mjs beside its own file, with forward slashes');
  ok(existsSync(imported ?? ''), 'and that file exists');

  const dir = tmpDir();
  const real = join(dir, 'real');
  const link = join(dir, 'link');
  mkdirSync(join(real, 'tools'), { recursive: true });
  for (const name of ['plan-edit.mjs', 'plan-block.mjs']) copyFileSync(join(REPO_ROOT, 'tools', name), join(real, 'tools', name));
  const cliArgs = (script) => {
    try {
      const out = execFileSync(process.execPath, [script, 'args', plan], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
      return JSON.parse(out).blockTool;
    } catch (e) { return `exit ${e.status}: ${e.stderr}`; }
  };
  eq(cliArgs(join(real, 'tools', 'plan-edit.mjs')), join(real, 'tools', 'plan-block.mjs').replace(/\\/g, '/'), 'the CLI names the plan-block.mjs in its own folder');
  let isLinked = false;
  try {
    symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    isLinked = true;
  } catch { isLinked = false; }
  if (isLinked) {
    const viaLink = cliArgs(join(link, 'tools', 'plan-edit.mjs'));
    eq(viaLink, join(link, 'tools', 'plan-block.mjs').replace(/\\/g, '/'), 'a CLI run through a link keeps the link spelling');
    ok(existsSync(viaLink), 'and that path reaches the file');
  } else {
    ok(true, 'skipped: this machine cannot create a link');
  }

  // A link to the tool FILE leaves no plan-block.mjs beside the caller's spelling, so the path falls back to the real folder.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  let isFileLinked = false;
  try {
    symlinkSync(join(real, 'tools', 'plan-edit.mjs'), join(bin, 'plan-edit.mjs'), 'file');
    isFileLinked = true;
  } catch { isFileLinked = false; }
  if (isFileLinked) {
    const viaFileLink = cliArgs(join(bin, 'plan-edit.mjs'));
    eq(viaFileLink, join(real, 'tools', 'plan-block.mjs').replace(/\\/g, '/'), 'a CLI run through a file link names the plan-block.mjs in the real folder');
    ok(existsSync(viaFileLink), 'and that path reaches the file');
  } else {
    ok(true, 'skipped: this machine cannot create a file link');
  }
}

section('backlogged is a status that args writes and set accepts, and that no launch selects');
// A park syncs its block backlogged, since the block's work waits in a backlog entry. A status the
// grammar refused would fail the fold, and one the todo filter or --pack selected would rebuild the block.
{
  const plan = fixture();
  const { out, err } = argsWith(configWith([record({ blocks: [[status('bus-parser', 'backlogged', plan)], [status('inventory', 'backlogged', plan)]] })]), plan);
  ok(!err, `a run's backlogged edit folds: ${err ?? ''}`);
  ok(read(plan).includes('gate: build-only\nstatus: backlogged'), 'args writes it into the block preamble');
  eq(JSON.parse(out).plans.map((r) => `${r.id}=${r.status}`).join(','), 'bus-parser=backlogged,inventory=backlogged,triage=todo', 'and prints it in the block\'s row');

  const set = fixture();
  run(['set', set, 'triage', 'status=backlogged']);
  ok(read(set).includes('mode: fix\ngate: green\nstatus: backlogged\n\n### [flaky-test]'), 'set accepts it');
  ok(/status/.test(fails('set', set, 'triage', 'status=backlog')), 'a near miss still fails');
}

section('args refuses a plan whose file key sits under a heading, and writes nothing');
{
  const plan = fixture(`# Title\n\nordered: true\n\n${PLAN}`);
  const before = read(plan);
  const { err } = argsWith(configWith([record({ blocks: [[status('bus-parser', 'done', plan)]] })]), plan);
  ok(/file key "ordered" on line 3/.test(err ?? ''), `args fails naming the key and line: ${err ?? ''}`);
  eq(read(plan), before, 'and the plan file is untouched');
}

section('a failed or stopped run folds too, and runs apply oldest first, each exactly once');
// The runtime keeps a run's logs when it fails or is stopped, and that is the case a relaunch needs most.
{
  const plan = fixture();
  const older = record({ runId: 'wf_old', status: 'killed', timestamp: '2026-09-25T09:00:00.000Z', blocks: [[status('bus-parser', 'parked', plan)]] });
  const newer = record({ runId: 'wf_new', status: 'failed', timestamp: '2026-09-25T11:00:00.000Z', blocks: [[status('bus-parser', 'done', plan)]] });
  const config = configWith([newer, older]);

  const { notes } = argsWith(config, plan);
  ok(read(plan).includes('status: done') && !read(plan).includes('status: parked'), 'the newer run wins');
  ok(notes.indexOf('wf_old') < notes.indexOf('wf_new'), 'because the older applied first');
  ok(read(plan).includes('synced: 2026-09-25T11:00:00.000Z'), 'and the marker is the newest applied run');

  // The operator's own edit after a fold must survive every later launch.
  run(['set', plan, 'bus-parser', 'status=todo']);
  argsWith(config, plan);
  ok(read(plan).includes('status: todo'), 'a block flipped back to todo stays todo');
}

section('args reads only develop records, and only the edits that name the plans it was given');
{
  const plan = fixture();
  const other = fixture(DEST, 'inbox.md');
  const config = configWith([
    { runId: 'wf_review', workflowName: 'review', timestamp: 'not a date' },
    record({ runId: 'wf_dev', blocks: [[status('inbox', 'done', other)]] }),
  ]);
  const before = read(plan);
  const { err, notes } = argsWith(config, plan);
  ok(!err, `another workflow's record is skipped without reading its fields: ${err ?? ''}`);
  eq(read(plan), before, 'and an edit for another plan changes nothing here');
  eq(notes, '', 'so nothing is reported applied');
  const empty = argsWith(tmpDir(), plan);
  ok(!empty.err && JSON.parse(empty.out).plans.length === 3, `a config dir with no projects folder is a plain launch: ${empty.err ?? ''}`);
}

section('a status line the runtime cut short blocks only the plans it names');
// The runtime keeps a long log line's head and tail and drops its middle, so one oversized status line from
// another project's run must not stop every launch on the machine. A cut line that still names a plan being
// folded fails, since its edits would be lost. A completed run's result carries every edit uncut.
{
  const plan = fixture();
  const other = fixture(DEST, 'inbox.md');
  // develop logs forward-slash paths, so the fixtures' native paths are respelled the way it writes them.
  const logged = (path) => path.replace(/\\/g, '/');
  const cutLine = (edits) => {
    const full = `status-sync ${JSON.stringify(edits)}`;
    const head = full.indexOf('","id"') + 6;
    return `${full.slice(0, head)}\n\n... [${full.length - head - 40} characters truncated] ...\n\n${full.slice(-40)}`;
  };
  const withCut = (cutEdits, { good = [], runId = 'wf_cut', timestamp, result = null } = {}) => ({
    ...record({ runId, timestamp }),
    logs: ['develop: 2/2 block(s) to build', ...(good.length ? [`status-sync ${JSON.stringify(good)}`] : []), cutLine(cutEdits)],
    result,
  });
  const many = (planPath, ids) => ids.map((id) => status(id, 'done', logged(planPath)));

  const foreign = argsWith(configWith([withCut(many(other, ['inbox', 'later', 'old-one']), { good: [status('bus-parser', 'done', plan)] })]), plan);
  ok(!foreign.err, `a cut line naming only another plan is skipped: ${foreign.err ?? ''}`);
  ok(read(plan).includes('status: done'), 'and the run\'s whole lines still apply');
  ok(/skipped 1 status line\(s\) the runtime cut short in run wf_cut/.test(foreign.notes), `the note names the run: ${foreign.notes.trim().split('\n')[0]}`);

  const own = fixture(PLAN, 'own.md');
  const bystander = fixture(DEST, 'bystander.md');
  const [ownBefore, bystanderBefore] = [read(own), read(bystander)];
  const cutOwn = withCut(many(own, ['bus-parser', 'triage', 'inventory']), { good: [status('inbox', 'done', bystander)] });
  const failed = argsWith(configWith([cutOwn]), bystander, own);
  ok(/run wf_cut \(.*, 2026-09-25T10:00:00\.000Z\) .*cut short, and it names .*own\.md.*"synced:" file key to 2026-09-25T10:00:00\.000Z/.test(failed.err ?? ''), `a cut line naming a plan fails, naming the run's timestamp: ${(failed.err ?? 'no error').slice(0, 140)}`);
  ok(/by hand, applying an edit that carries "expectPulled" only to an entry whose "- pulled:" value equals it/.test(failed.err ?? ''), 'the hand-apply instruction names the expectPulled condition');
  eq(read(own) + read(bystander), ownBefore + bystanderBefore, 'and writes neither plan, not even the one it could fold');

  const foreignCut = withCut(many(other, ['inbox', 'later', 'old-one']), { runId: 'wf_foreign', timestamp: '2026-09-25T09:30:00.000Z' });
  const noted = argsWith(configWith([foreignCut, cutOwn]), own);
  ok(/run wf_cut \(/.test(noted.err ?? '') && /skipped 1 status line\(s\) the runtime cut short in run wf_foreign/.test(noted.notes ?? ''), `a given plan that fails to fold still gets the skip note of a run naming no plan given: ${(noted.notes ?? 'no notes').slice(0, 90)}`);

  const older = record({ runId: 'wf_older', timestamp: '2026-09-25T09:00:00.000Z', blocks: [[status('bus-parser', 'parked', own)]] });
  const both = argsWith(configWith([cutOwn, older]), own);
  ok(/older run\(s\) wf_older, which that key also skips/.test(both.err ?? ''), `an older unapplied run that names the plan is listed: ${(both.err ?? 'no error').slice(-90)}`);

  const synced = fixture(`synced: 2026-09-25T11:00:00.000Z\n${PLAN}`, 'synced.md');
  const past = argsWith(configWith([withCut(many(synced, ['bus-parser', 'triage', 'inventory']))]), synced);
  ok(!past.err, `a cut run the synced key already covers is skipped: ${past.err ?? ''}`);

  const newer = withCut(many(own, ['bus-parser', 'triage', 'inventory']), { runId: 'wf_cut_newer', timestamp: '2026-09-25T12:00:00.000Z' });
  const pair = argsWith(configWith([newer, cutOwn]), own);
  ok(/^run wf_cut \(/.test(pair.err ?? ''), `of two cut runs naming the plan, the older one is named: ${(pair.err ?? 'no error').slice(0, 60)}`);

  // A dot-dot spelling only resolves to the plan, and a path cut before its closing quote only matches as
  // text, in a different case.
  const dir = join(own, '..');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  const dotted = withCut([status('bus-parser', 'done', logged(join(dir, 'sub', '..', 'own.md'))), status('triage', 'done', logged(own))]);
  ok(/cut short, and it names .*own\.md/.test(argsWith(configWith([dotted]), own).err ?? ''), 'a logged path that resolves to the plan is matched');
  const quoteCut = { ...record({ runId: 'wf_quote' }), logs: [`status-sync [{"planPath":"${logged(own).toUpperCase()}\n\n... [900 characters truncated] ...\n\n","value":"done"}]`] };
  ok(/run wf_quote .*cut short, and it names .*own\.md/.test(argsWith(configWith([quoteCut]), own).err ?? ''), 'a path cut before its closing quote still matches as text, in any case');

  const done = fixture(PLAN, 'done.md');
  const completed = withCut(many(done, ['bus-parser', 'triage', 'inventory']), { result: { statusSync: many(done, ['bus-parser']) } });
  const fromResult = argsWith(configWith([completed]), done);
  ok(!fromResult.err && read(done).includes('status: done'), `a completed run folds from its uncut result, past its cut logs: ${fromResult.err ?? ''}`);

  const broken = { ...record({ runId: 'wf_bad' }), logs: ['status-sync [{"planPath": nope'] };
  ok(/wf_bad\.json has a status line that is not JSON — the Claude Code run-record format changed/.test(argsWith(configWith([broken]), plan).err ?? ''), 'a status line broken without the cut marker still fails as a format change');
}

section('args writes the synced key under frontmatter, and keeps a BOM and CRLF endings');
{
  const bare = fixture(`---\ntitle: x\n---\n\n${DEST}`, 'fm.md');
  argsWith(configWith([record({ blocks: [[status('inbox', 'done', bare)]] })]), bare);
  ok(read(bare).startsWith('---\ntitle: x\n---\n\nsynced: 2026-09-25T10:00:00.000Z\n\n## Plan: inbox'), 'a file with no file keys gains its own run, set off by a blank line');

  const crlf = fixture(`${BOM}${PLAN.trimEnd().replace(/\n/g, '\r\n')}`);
  const before = read(crlf);
  argsWith(configWith([record({ blocks: [[status('bus-parser', 'done', crlf)]] })]), crlf);
  eq(read(crlf), before.replace('goal: ship the bus', 'goal: ship the bus\r\nsynced: 2026-09-25T10:00:00.000Z')
    .replace('gate: build-only', 'gate: build-only\r\nstatus: done'), 'only the two appended lines differ, in the file\'s own ending');
}

section('set writes a block\'s model line, and args passes it into that block\'s row only');
{
  const plan = fixture();
  const before = read(plan);
  eq(fails('set', plan, 'bus-parser', 'model=sonnet'), '', 'set model=sonnet succeeds');
  eq(read(plan), before.replace('gate: build-only\n', 'gate: build-only\nmodel: sonnet\n'), 'and appends the line to the block\'s preamble');
  const { out, err } = argsWith(configWith([]), plan);
  const rows = err ? [] : JSON.parse(out).plans;
  eq(rows.map((r) => `${r.id}=${r.model ?? '-'}`).join(','), 'bus-parser=sonnet,inventory=-,triage=-', `args carries the model on its block's row: ${err ?? ''}`);
}

section('set writes a block\'s effort line, and args passes it into that block\'s row only');
{
  const plan = fixture();
  const before = read(plan);
  eq(fails('set', plan, 'bus-parser', 'effort=xhigh'), '', 'set effort=xhigh succeeds');
  eq(read(plan), before.replace('gate: build-only\n', 'gate: build-only\neffort: xhigh\n'), 'and appends the line to the block\'s preamble');
  const { out, err } = argsWith(configWith([]), plan);
  const rows = err ? [] : JSON.parse(out).plans;
  eq(rows.map((r) => `${r.id}=${r.effort ?? '-'}`).join(','), 'bus-parser=xhigh,inventory=-,triage=-', `args carries the effort on its block's row: ${err ?? ''}`);
}

section('several plans make one args object, and plans that disagree on a file key fail');
{
  const a = fixture(DEST, 'a.md');
  const b = fixture(DEST.replace(/inbox/g, 'inbox-2').replace(/later/g, 'later-2').replace(/old-one/g, 'old-two'), 'b.md');
  const { out } = argsWith(configWith([]), a, b);
  eq(JSON.parse(out).plans.map((r) => `${r.id}@${r.planPath === a ? 'a' : 'b'}`).join(','), 'inbox@a,later@a,inbox-2@b,later-2@b', 'rows from both files, each naming its own');

  const odd = fixture(`ordered: true\n\n${DEST.replace(/inbox/g, 'x').replace(/later/g, 'y').replace(/old-one/g, 'z')}`, 'odd.md');
  ok(/disagree on ordered/.test(argsWith(configWith([]), a, odd).err), 'a mismatched file key names the key');
}

section('every args failure writes no file, and names what to do');
{
  const plan = fixture();
  const dest = fixture(DEST, 'inbox.md');
  const [planBefore, destBefore] = [read(plan), read(dest)];
  const good = [status('bus-parser', 'done', plan)];
  const cases = [
    [[record({ blocks: [good, [status('ghost', 'done', dest)]] })], /run wf_1 .* sets ghost status=done in .*no id "ghost".*set its "synced:" file key/, 'an unknown id in the LAST file'],
    [[record({ blocks: [good, [status('inbox', 'nearly', dest)]] })], /illegal preamble key "status: nearly"/, 'an illegal value'],
    [[record({ blocks: [[status('bus-parser', 'done', 'plans/x.md')]] })], /is not \{ planPath \(absolute\)/, 'a relative planPath'],
    [[{ runId: 'wf_x', timestamp: '2026-09-25T10:00:00.000Z' }], /has no workflowName — the Claude Code run-record format changed/, 'a record with no workflowName'],
    [[{ ...record(), logs: undefined }], /has no valid logs — the Claude Code run-record format changed/, 'a develop record with no logs'],
    [[{ ...record(), status: 'done', timestamp: 'soon' }], /has no valid status, timestamp/, 'a develop record with an unknown status and date'],
  ];
  for (const [records, re, what] of cases) {
    const { err } = argsWith(configWith(records), plan, dest);
    ok(re.test(err ?? ''), `${what}: ${(err ?? 'no error').slice(0, 110)}`);
    eq(read(plan) + read(dest), planBefore + destBefore, `${what}: neither file was written`);
  }
  ok(/no develop run record for wf_missing .*moved its run records/.test(argsWith(configWith([]), plan, '--expect', 'wf_missing').err), '--expect names a run it cannot find');
  ok(!argsWith(configWith([record()]), plan, '--expect', 'wf_1').err, 'and passes when the record exists');
  ok(/usage:/.test(argsWith(configWith([]), '--expect').err ?? ''), 'no plan is a usage error');
}

// ---------------------------------------------------------------------------------------------
// args --pack — small fix blocks share one develop pass
// ---------------------------------------------------------------------------------------------

/** A one-block fix file whose entries name `files` ({ path, loc }), each ACTIONABLE unless `decision` says. */
function inventory(dir, name, entries) {
  const lines = [`## Plan: ${name} - findings`, 'mode: fix', 'gate: green', ''];
  for (const e of entries) {
    lines.push(`### [${e.id}] ${e.id}`, `- file: ${e.file}:1`, ...(e.loc ? [`- loc: ${e.loc}`] : []),
      `- decision: ${e.decision ?? 'ACTIONABLE'}`, ...(e.status ? [`- status: ${e.status}`] : []),
      ...(e.branch ? [`- branch: ${e.branch}`] : []), '', 'What.', '');
  }
  return fixture(lines.join('\n'), `${name}.md`, dir);
}
const packed = (config, repo, cap, ...plans) => argsWith(config, ...plans, '--pack', repo, ...(cap ? ['--loc-cap', String(cap)] : []));

section('--pack groups small fix blocks into passes under the line cap, neighbouring files together');
{
  const dir = tmpDir();
  const a = inventory(dir, 'a', [{ id: 'a-1', file: 'src/core/x.js', loc: 1000 }]);
  const b = inventory(dir, 'b', [{ id: 'b-1', file: 'src/web/y.js', loc: 3000 }]);
  const c = inventory(dir, 'c', [{ id: 'c-1', file: 'src/core/z.js', loc: 1500 }, { id: 'c-2', file: 'src/core/x.js', loc: 1000 }]);
  const { out, notes, err } = packed(configWith([]), dir, 3000, a, b, c);
  ok(!err, `it succeeds: ${err ?? ''}`);
  const plans = JSON.parse(out).plans;
  eq(plans.map((r) => r.id).join(','), 'a-plus-1,b', 'the two core blocks share a pass that sits where its first member did, the web block stays alone');
  eq(plans[0].blocks.map((m) => `${m.id}:${m.issues.join('+')}`).join(','), 'a:a-1,c:c-1+c-2', 'each member keeps its own issue ids');
  ok(plans[0].blocks.every((m) => m.planPath.endsWith(`${m.id}.md`)) && plans[0].mode === 'fix' && plans[0].gate === 'green', 'and its own plan file');
  ok(/packed a, c into a-plus-1 \(2500 lines\)/.test(notes), `a shared file counts once: ${notes.trim()}`);
}

section('--pack lists only the open ACTIONABLE entries of a member, so a fixed entry stays out of its issues');
{
  const dir = tmpDir();
  const a = inventory(dir, 'a', [{ id: 'a-1', file: 'x.js', loc: 10, status: 'fixed' }, { id: 'a-2', file: 'x.js', loc: 10 }, { id: 'a-3', file: 'x.js', loc: 10, decision: 'NEEDS_USER' }]);
  const b = inventory(dir, 'b', [{ id: 'b-1', file: 'x.js', loc: 10 }]);
  const { out, err } = packed(configWith([]), dir, 3000, a, b);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(JSON.parse(out).plans[0].blocks.map((m) => `${m.id}:${m.issues.join('+')}`).join(','), 'a:a-2,b:b-1', 'a fixed entry and a NEEDS_USER entry are not listed');
}

section('--pack leaves out what it cannot pack, and reads a file\'s lines when no loc is given');
{
  const dir = tmpDir();
  writeFileSync(join(dir, 'big.js'), 'x\n'.repeat(4000));
  const big = inventory(dir, 'big', [{ id: 'g-1', file: 'big.js' }]);
  const small = inventory(dir, 'small', [{ id: 's-1', file: 'small.js', loc: 100 }]);
  const skipped = inventory(dir, 'skipped', [{ id: 'k-1', file: 'k.js', loc: 10, decision: 'SKIP' }, { id: 'k-2', file: 'k.js', loc: 10, status: 'fixed' }]);
  const { out, notes } = packed(configWith([]), dir, 4000, big, small, skipped);
  eq(JSON.parse(out).plans.map((r) => r.id).join(','), 'big,small,skipped', 'a block over the cap alone is its own row, and so is one with nothing open and ACTIONABLE');
  ok(/not packed: skipped has no open ACTIONABLE entry/.test(notes), 'the note names the block with nothing to build');
}

section('--pack never packs a backlogged block');
{
  const dir = tmpDir();
  const parked = inventory(dir, 'parked', [{ id: 'p-1', file: 'a.js', loc: 10 }]);
  run(['set', parked, 'parked', 'status=backlogged']);
  const open = inventory(dir, 'open', [{ id: 'o-1', file: 'a.js', loc: 10 }]);
  const other = inventory(dir, 'other', [{ id: 'q-1', file: 'b.js', loc: 10 }]);
  const pack = packed(configWith([]), dir, 3000, parked, open, other);
  ok(!pack.err, `--pack runs over a backlogged block: ${pack.err ?? ''}`);
  const rows = JSON.parse(pack.out).plans;
  eq(rows.map((r) => `${r.id}=${r.status}`).join(','), 'parked=backlogged,open-plus-1=todo', 'the backlogged block keeps its own row and status');
}

section('--pack keeps each block that restores an unfinished branch a pass of its own');
{
  const dir = tmpDir();
  const one = inventory(dir, 'one', [{ id: 'u-1', file: 'shared.js', loc: 10, branch: 'aipg-unfinished/one' }]);
  const two = inventory(dir, 'two', [{ id: 'w-1', file: 'shared.js', loc: 10, branch: 'aipg-unfinished/two' }]);
  const plain = inventory(dir, 'plain', [{ id: 'n-1', file: 'shared.js', loc: 10 }]);
  const plain2 = inventory(dir, 'plain2', [{ id: 'm-1', file: 'shared.js', loc: 10 }]);
  const closed = inventory(dir, 'closed', [{ id: 'c-1', file: 'shared.js', loc: 10, branch: 'aipg-unfinished/closed', status: 'fixed' }, { id: 'c-2', file: 'shared.js', loc: 10 }]);
  const { out, notes, err } = packed(configWith([]), dir, 3000, one, two, plain, plain2, closed);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(JSON.parse(out).plans.map((r) => r.id).join(','), 'one,two,plain-plus-2', 'two branch blocks on one file stay apart, and a block whose branch entry is closed packs');
  ok(/not packed: one restores an unfinished branch/.test(notes) && /not packed: two restores an unfinished branch/.test(notes), `the note names each branch block: ${notes.trim()}`);
}

/** The block file with `line` added to its preamble. */
const withLine = (path, line) => { writeFileSync(path, read(path).replace('gate: green\n', `gate: green\n${line}\n`)); return path; };
/** The rows of a --pack run as `<id>:<key value or ->`, or the failure. */
const packRows = (key, ...plans) => {
  const { out, notes, err } = packed(configWith([]), dirname(plans[0]), 3000, ...plans);
  return { rows: err ? `failed: ${err}` : JSON.parse(out).plans.map((r) => `${r.id}:${r[key] ?? '-'}`).join(','), plans: err ? [] : JSON.parse(out).plans, notes };
};

section('--pack joins blocks of different models into one pass on the strongest, and a block with no model only beside fable');
// A block with no model line runs on the run's default, which --pack cannot see, so only fable is sure to be at least as strong.
{
  for (const key of ['model', 'effort']) {
    eq([...STRENGTH[key]].sort().join(','), [...RUN_KEYS.preamble.keys[key]].sort().join(','), `the ${key} strength order ranks every value the grammar allows`);
  }
  const dir = tmpDir();
  const sa = withLine(inventory(dir, 'sa', [{ id: 'sa-1', file: 'src/a.js', loc: 10 }]), 'model: sonnet');
  const op = withLine(inventory(dir, 'op', [{ id: 'op-1', file: 'src/a.js', loc: 10 }]), 'model: opus');
  const none = inventory(dir, 'none', [{ id: 'none-1', file: 'src/a.js', loc: 10 }]);
  const sb = withLine(inventory(dir, 'sb', [{ id: 'sb-1', file: 'src/b.js', loc: 10 }]), 'model: sonnet');
  const mixed = packRows('model', sa, op, none, sb);
  eq(mixed.rows, 'sa-plus-2:opus,none:-', `the sonnet and opus blocks share one opus pass, and the block with no model stays alone: ${mixed.notes.trim()}`);
  eq(mixed.plans[0]?.blocks?.map((m) => m.id).join(','), 'sa,op,sb', 'that pass holds the opus block and both sonnet blocks');
  ok(/packed sa, op, sb into sa-plus-2 \(\d+ lines\), raising sa model sonnet -> opus, sb model sonnet -> opus\n/.test(mixed.notes), `the note names each member the pass raises, and only those: ${mixed.notes.trim()}`);

  const dir2 = tmpDir();
  const fa = withLine(inventory(dir2, 'fa', [{ id: 'fa-1', file: 'src/a.js', loc: 10 }]), 'model: fable');
  const n1 = inventory(dir2, 'n1', [{ id: 'n1-1', file: 'src/a.js', loc: 10 }]);
  const n2 = inventory(dir2, 'n2', [{ id: 'n2-1', file: 'src/b.js', loc: 10 }]);
  const hk = withLine(inventory(dir2, 'hk', [{ id: 'hk-1', file: 'src/c.js', loc: 10 }]), 'model: haiku');
  const fable = packRows('model', fa, n1, n2, hk);
  eq(fable.rows, 'fa-plus-3:fable', `a fable block takes the blocks with no model and the haiku block into one fable pass: ${fable.notes.trim()}`);
  ok(/raising (?=.*n1 model default -> fable)(?=.*n2 model default -> fable)(?=.*hk model haiku -> fable)(?!.*fa model)/.test(fable.notes), `the note names a member with no line as raised from the default: ${fable.notes.trim()}`);

  const dir3 = tmpDir();
  const bare = packRows('model', inventory(dir3, 'b1', [{ id: 'b1-1', file: 'src/a.js', loc: 10 }]), inventory(dir3, 'b2', [{ id: 'b2-1', file: 'src/b.js', loc: 10 }]));
  eq(bare.rows, 'b1-plus-1:-', 'blocks that all lack a model line share a pass');
  ok(bare.plans.length === 1 && !('model' in bare.plans[0]) && !('effort' in bare.plans[0]), 'and that pass takes no model or effort key');
  ok(!/raising/.test(bare.notes), `and its note names no raise: ${bare.notes.trim()}`);
}

section('--pack joins blocks of different efforts into one pass on the highest, and a block with no effort only beside max');
{
  const dir = tmpDir();
  const hi = withLine(inventory(dir, 'hi', [{ id: 'hi-1', file: 'src/a.js', loc: 10 }]), 'effort: xhigh');
  const lo = withLine(inventory(dir, 'lo', [{ id: 'lo-1', file: 'src/a.js', loc: 10 }]), 'effort: low');
  const none = inventory(dir, 'none', [{ id: 'none-1', file: 'src/a.js', loc: 10 }]);
  const hi2 = withLine(inventory(dir, 'hi2', [{ id: 'hi2-1', file: 'src/b.js', loc: 10 }]), 'effort: xhigh');
  const mixed = packRows('effort', hi, lo, none, hi2);
  eq(mixed.rows, 'hi-plus-2:xhigh,none:-', `the xhigh and low blocks share one xhigh pass, and the block with no effort stays alone: ${mixed.notes.trim()}`);

  const dir2 = tmpDir();
  const mx = withLine(inventory(dir2, 'mx', [{ id: 'mx-1', file: 'src/a.js', loc: 10 }]), 'effort: max');
  const n1 = inventory(dir2, 'n1', [{ id: 'n1-1', file: 'src/b.js', loc: 10 }]);
  eq(packRows('effort', mx, n1).rows, 'mx-plus-1:max', 'a max block takes a block with no effort into one max pass');

  const dir3 = tmpDir();
  const fableOnly = withLine(inventory(dir3, 'fo', [{ id: 'fo-1', file: 'src/a.js', loc: 10 }]), 'model: fable');
  const maxOnly = withLine(inventory(dir3, 'mo', [{ id: 'mo-1', file: 'src/b.js', loc: 10 }]), 'effort: max');
  const both = packRows('model', fableOnly, maxOnly);
  eq(`${both.rows}/${both.plans[0]?.effort ?? '-'}`, 'fo-plus-1:fable/max', 'each key is judged on its own: a fable block with no effort and a max block with no model share a fable, max pass');
  ok(/raising mo model default -> fable, fo effort default -> max\n/.test(both.notes), `the note names each key's raise: ${both.notes.trim()}`);
}

section('--pack puts each block in the first pass it fits, not only the last one opened');
{
  const dir = tmpDir();
  const sh = withLine(withLine(inventory(dir, 'sh', [{ id: 'sh-1', file: 'src/a.js', loc: 10 }]), 'model: sonnet'), 'effort: high');
  const sn = withLine(inventory(dir, 'sn', [{ id: 'sn-1', file: 'src/b.js', loc: 10 }]), 'model: sonnet');
  const fh = withLine(withLine(inventory(dir, 'fh', [{ id: 'fh-1', file: 'src/c.js', loc: 10 }]), 'model: fable'), 'effort: high');
  const fit = packRows('model', sh, sn, fh);
  eq(fit.rows, 'sh-plus-1:fable,sn:sonnet', `the fable block joins the sonnet/high pass, and the block with no effort stays alone: ${fit.notes.trim()}`);
  eq(fit.plans[0]?.blocks?.map((m) => m.id).join(','), 'sh,fh', 'that pass holds the two blocks that share an effort');
}

section('--pack refuses an ordered plan set and a bad cap');
{
  const dir = tmpDir();
  const a = inventory(dir, 'a', [{ id: 'a-1', file: 'x.js', loc: 10 }]);
  const ordered = fixture(`ordered: true\n\n${read(inventory(dir, 'o', [{ id: 'o-1', file: 'y.js', loc: 10 }]))}`, 'ord.md', dir);
  ok(/needs a plan set with ordered: false/.test(packed(configWith([]), dir, 0, ordered).err ?? ''), 'an ordered file is refused, since packing regroups blocks');
  ok(/usage:/.test(argsWith(configWith([]), a, '--pack', dir, '--loc-cap', 'lots').err ?? ''), 'a cap that is not a whole number is a usage error');
  ok(/usage:/.test(argsWith(configWith([]), a, '--loc-cap', '10').err ?? ''), 'and so is a cap without --pack');
}

// ---------------------------------------------------------------------------------------------
// args --backlog — the project's ready backlog files join the plan set
// ---------------------------------------------------------------------------------------------

/** A backlog folder file: one fix block named `name`, with the file's own status line. */
function backlogFile(dir, name, status, entries) {
  const path = inventory(dir, name, entries);
  run(['set', path, name, `status=${status}`]);
  return path;
}
const withBacklog = (config, dir, ...argv) => argsWith(config, ...argv, '--backlog', dir);

section('--backlog adds only the todo or done files that hold an open ACTIONABLE entry');
{
  const dir = tmpDir();
  const ready = backlogFile(dir, 'ready', 'todo', [{ id: 'r-1', file: 'a.js', status: 'open' }]);
  backlogFile(dir, 'bare', 'todo', [{ id: 'b-1', file: 'h.js' }]);
  const reopen = backlogFile(dir, 'reopen', 'done', [{ id: 'o-1', file: 'b.js', status: 'fixed' }, { id: 'o-2', file: 'b.js', status: 'open' }]);
  const skipped = backlogFile(dir, 'skipped', 'todo', [{ id: 's-1', file: 'c.js', decision: 'SKIP', status: 'open' }]);
  const waiting = backlogFile(dir, 'waiting', 'todo', [{ id: 'w-1', file: 'd.js', status: 'needs-attention' }]);
  const mixed = backlogFile(dir, 'mixed', 'todo', [{ id: 'm-1', file: 'd.js', status: 'needs-attention' }, { id: 'm-2', file: 'd.js', status: 'open' }]);
  const finished = backlogFile(dir, 'finished', 'done', [{ id: 'f-1', file: 'e.js', status: 'fixed' }]);
  const parked = backlogFile(dir, 'parked', 'backlogged', [{ id: 'p-1', file: 'g.js', status: 'open' }]);
  const stray = join(dir, 'notes.txt');
  writeFileSync(stray, 'not a plan');
  const before = Object.fromEntries([ready, skipped, waiting, mixed, finished, parked].map((p) => [p, read(p)]));

  const { out, err } = withBacklog(configWith([]), dir);
  ok(!err, `it succeeds with no plan file: ${err ?? ''}`);
  const args = JSON.parse(out);
  eq(args.plans.map((r) => `${r.id}=${r.status}`).join(','), 'bare=todo,ready=todo,reopen=todo', 'only the todo files and the done file with an open or status-less entry are rows, and the done one reads todo');
  eq(args.ordered, false, 'the set is unordered');
  ok(args.plans.every((r) => r.planPath.endsWith(`${r.id}.md`)), 'each row names its own file');
  ok(/^status: todo$/m.test(read(reopen)) && !/^status: done$/m.test(read(reopen)), 'the done file was set to todo on disk');
  ok([ready, skipped, waiting, mixed, finished, parked].every((p) => read(p) === before[p]), 'every other file keeps its bytes, and a file with a needs-attention ACTIONABLE entry waits for triage');
}

section('--backlog adds to the given plans, takes their file keys, and never lists a file twice');
{
  const dir = tmpDir();
  const backlog = tmpDir();
  const given = fixture(`goal: tidy up\n\n${read(inventory(dir, 'given', [{ id: 'g-1', file: 'x.js' }]))}`, 'given.md', dir);
  const inFolder = backlogFile(backlog, 'inbox', 'todo', [{ id: 'i-1', file: 'y.js', status: 'open' }]);
  const twice = withBacklog(configWith([]), backlog, inFolder);
  ok(!twice.err, `a folder file also named as a plan is accepted: ${twice.err ?? ''}`);
  eq(JSON.parse(twice.out).plans.map((r) => r.id).join(','), 'inbox', 'and is one row');

  const both = withBacklog(configWith([]), backlog, given);
  const args = JSON.parse(both.out);
  eq(args.plans.map((r) => r.id).join(','), 'given,inbox', 'the folder file follows the given plan');
  eq(args.goal, 'tidy up', 'the set takes the given plan\'s goal, which the backlog file has no key to disagree with');
}

section('--backlog composes with --pack, and refuses an ordered plan set');
{
  const backlog = tmpDir();
  backlogFile(backlog, 'one', 'todo', [{ id: 'n-1', file: 'shared.js', loc: 10, status: 'open' }]);
  backlogFile(backlog, 'two', 'done', [{ id: 'w-1', file: 'shared.js', loc: 10, status: 'open' }]);
  const { out, notes, err } = argsWith(configWith([]), '--backlog', backlog, '--pack', backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(JSON.parse(out).plans.map((r) => r.id).join(','), 'one-plus-1', 'the two backlog files pack into one pass');
  ok(/packed one, two into one-plus-1/.test(notes), `the note names both: ${notes.trim()}`);

  const dir = tmpDir();
  const ordered = fixture(`ordered: true\n\n${read(inventory(dir, 'o', [{ id: 'o-1', file: 'y.js', loc: 10 }]))}`, 'ord.md', dir);
  const done = backlogFile(tmpDir(), 'late', 'done', [{ id: 'l-1', file: 'z.js', status: 'open' }]);
  const before = read(done);
  ok(/needs a plan set with ordered: false/.test(withBacklog(configWith([]), join(done, '..'), ordered).err ?? ''), 'an ordered plan file is refused');
  eq(read(done), before, 'and the done file stays done on disk');
}

section('--backlog folds a finished run into a backlog file before it chooses');
{
  const backlog = tmpDir();
  const file = backlogFile(backlog, 'built', 'todo', [{ id: 'b-1', file: 'a.js', status: 'open' }]);
  const config = configWith([record({ blocks: [[status('built', 'done', file), status('b-1', 'fixed', file)]] })]);
  const { err } = withBacklog(config, backlog);
  ok(/nothing to build/.test(err ?? ''), `an entry the last run fixed is not built again: ${err ?? ''}`);
  const text = read(file);
  ok(/^status: done$/m.test(text) && /^- status: fixed$/m.test(text) && /^synced: /m.test(text), 'the fold is written although the file joined no run');
}

section('--backlog leaves out a file while the block that wrote it, in any plan, is not done, skip or backlogged');
{
  const plans = tmpDir();
  const backlog = tmpDir();
  const writer = (name, status) => backlogFile(plans, name, status, [{ id: `${name}-1`, file: 'w.js' }]);
  const writtenBy = (name, blockId, runId) => fixture(
    [`## Plan: ${name} - backlog from block ${blockId} of run ${runId}`, 'mode: fix', 'gate: green', 'status: todo', '',
      `### [${name}-1] ${name}`, '- file: a.js:1', '- decision: ACTIONABLE', '- status: open', '', 'What.', ''].join('\n'), `${name}.md`, backlog);
  const stuck = writer('stuck', 'todo');
  const fine = writer('fine', 'todo');
  const member = writer('member', 'blocked');
  const legacy = writer('legacy', 'todo');
  const shelved = writer('shelved', 'todo');
  const dropped = writer('dropped', 'todo');
  const oldPark = writer('old-park', 'parked');
  const numbered = writer('numbered', 'todo');
  writtenBy('from-stuck', 'stuck', 'p1');
  writtenBy('from-fine', 'fine', 'p1');
  writtenBy('from-pass', 'member-plus-1', 'p1');
  writtenBy('from-member', 'member', 'p1');
  writtenBy('from-legacy', 'legacy', 'old');
  writtenBy('from-other-run', 'stuck', 'p2');
  writtenBy('from-gone', 'gone', 'p1');
  writtenBy('from-renamed', 'renamed', 'p1');
  writtenBy('from-shelved', 'shelved', 'p1');
  writtenBy('from-dropped', 'dropped', 'p1');
  writtenBy('from-old-park', 'old-park', 'p1');
  writtenBy('from-numeric', 'numbered', '1026');
  const stuckBefore = read(stuck);
  const rows = [{ id: 'member-plus-1', blocks: [{ id: 'member', planPath: member }] }, { id: 'gone', planPath: join(plans, 'gone.md') }, { id: 'renamed', planPath: fine }, { id: 'old-park', planPath: oldPark }];
  // The run names its folder with a trailing slash, which still matches the --backlog folder.
  const p1 = record({ runId: 'wf_p1', args: { runId: 'p1', backlogDir: `${backlog}/`, plans: rows },
    blocks: [[status('stuck', 'blocked', stuck)], [status('fine', 'done', fine)], [status('shelved', 'backlogged', shelved)], [status('dropped', 'skip', dropped)]] });
  // An older record keeps no args, and its result echoes the runId arg.
  const old = { ...record({ runId: 'wf_old', timestamp: '2026-09-25T11:00:00.000Z' }), args: undefined, result: { runId: 'old', statusSync: [status('legacy', 'blocked', legacy)] } };

  // Another project's run shares the runId and block id, and its block is blocked.
  const elsewhere = backlogFile(tmpDir(), 'fine', 'todo', [{ id: 'q-1', file: 'q.js' }]);
  const otherProject = record({ runId: 'wf_q', args: { runId: 'p1', backlogDir: tmpDir() }, blocks: [[status('fine', 'blocked', elsewhere)]] });

  // develop takes a numeric runId and writes it into the header as text.
  const numeric = record({ runId: 'wf_n', args: { runId: 1026, backlogDir: backlog }, blocks: [[status('numbered', 'blocked', numbered)]] });

  const { out, notes, err } = withBacklog(configWith([p1, old, otherProject, numeric]), backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(err ? '' : JSON.parse(out).plans.map((r) => r.id).join(','), 'from-dropped,from-fine,from-gone,from-other-run,from-renamed,from-shelved',
    'only the files whose writer is done, skip or backlogged, or that no record names, are rows');
  ok(/fine\.md no longer holds renamed/.test(notes), 'a writer plan that no longer holds the block keeps its file, with a note');
  ok(!/left out .*from-fine\.md/.test(notes), 'a run of another backlog folder with the same runId and block id holds back no file here');
  ok(/left out .*from-stuck\.md: the block that wrote it, stuck \(blocked\) in .*stuck\.md/.test(notes), `a blocked writer of another plan holds its file back, from the record's fold: ${notes.trim()}`);
  ok(/left out .*from-pass\.md: the block that wrote it, member \(blocked\)/.test(notes), 'a pass\'s file is held back by a blocked member its args row names');
  ok(/left out .*from-member\.md: the block that wrote it, member \(blocked\)/.test(notes), 'a member\'s own file is held back through its pass\'s args row, with no status edit for the member');
  ok(/left out .*from-legacy\.md: the block that wrote it, legacy \(blocked\)/.test(notes), 'a record with no args names its run through its result');
  ok(/left out .*from-old-park\.md: the block that wrote it, old-park \(parked\) in .*old-park\.md, is not done, skip or backlogged\. A parked block is never relaunched, so set old-park in its plan file to skip to drop it, to todo to rebuild it, or to backlogged only when a backlog entry carries its work\./.test(notes),
    'a parked writer holds its file back, and the note names every way the user releases it');
  ok(/left out .*from-numeric\.md: the block that wrote it, numbered \(blocked\)/.test(notes), 'a record with a numeric runId arg names its run');
  ok(/cannot read .*gone\.md, which holds gone/.test(notes), 'a writer plan that is gone keeps its file, with a note');
  eq(read(stuck), stuckBefore, 'the writer\'s plan file is folded in memory only, never written');

  const bad = record({ runId: 'wf_bad', timestamp: '2026-09-25T12:00:00.000Z', args: { runId: 'p1' }, blocks: [[status('stuck', 'sideways', stuck)]] });
  const foldErr = withBacklog(configWith([p1, old, bad]), backlog).err ?? '';
  ok(/sets stuck status=sideways in .*stuck\.md, which fails/.test(foldErr), 'a writer plan whose records cannot fold fails loudly, since its status is unknown');
  ok(/cannot fold the run records into .*stuck\.md, which holds stuck, the block that wrote a backlog file/.test(foldErr), 'and the error names the writer block whose backlog file it was checking');

  // A plan with two blocks of one id fails validation, so the writer's status cannot be read.
  writeFileSync(stuck, `${stuckBefore}
${stuckBefore}`);
  ok(/cannot load .*stuck\.md, which holds stuck, the block that wrote a backlog file/.test(withBacklog(configWith([p1, old]), backlog).err ?? ''),
    'a writer plan that exists but fails to validate fails loudly instead of releasing its file');
  writeFileSync(stuck, stuckBefore);
}

section('--backlog writes the needs-attention a failed run synced, so the entry reaches triage');
{
  const backlog = tmpDir();
  const file = backlogFile(backlog, 'failed', 'todo', [{ id: 'x-1', file: 'a.js', status: 'open' }]);
  const config = configWith([record({ blocks: [[status('x-1', 'needs-attention', file)]] })]);
  const first = withBacklog(config, backlog);
  ok(/nothing to build/.test(first.err ?? ''), `the failed entry is not rebuilt without the user: ${first.err ?? ''}`);
  ok(/^- status: needs-attention$/m.test(read(file)) && !/^- status: open$/m.test(read(file)), 'and its status is on disk');
}

section('--backlog fails on a folder it cannot read, and skips a cut record line naming a file it does not fold');
{
  const dir = tmpDir();
  const notAFolder = inventory(dir, 'plain', [{ id: 'p-1', file: 'a.js' }]);
  ok(/cannot read the backlog folder/.test(withBacklog(configWith([]), notAFolder).err ?? ''), 'a file passed as the folder is an error that says so');

  const backlog = tmpDir();
  const idle = backlogFile(backlog, 'idle', 'todo', [{ id: 'i-1', file: 'a.js', decision: 'NEEDS_USER', status: 'open' }]);
  const ready = backlogFile(backlog, 'ready', 'todo', [{ id: 'r-1', file: 'b.js', status: 'open' }]);
  // The runtime keeps a long line's head and tail, so the cut line still names the plan path in its head.
  const cutRecord = (planPath) => {
    const full = `status-sync ${JSON.stringify([status('i-1', 'fixed', planPath.split(sep).join('/'))])}`;
    const head = full.indexOf('","id"') + 6;
    return { ...record({ runId: 'wf_cut' }), logs: [[full.slice(0, head), '', '... [9 characters truncated] ...', '', full.slice(-40)].join('\n')] };
  };
  const skipped = withBacklog(configWith([cutRecord(idle)]), backlog);
  ok(!skipped.err, `a cut line naming a file with no ACTIONABLE entry does not block the launch: ${skipped.err ?? ''}`);
  eq(JSON.parse(skipped.out).plans.map((r) => r.id).join(','), 'ready', 'and the ready file still builds');
  ok(/cut short, and it names .*ready.md/.test(withBacklog(configWith([cutRecord(ready)]), backlog).err ?? ''), 'a cut line naming a file it builds fails');
}

section('--backlog with nothing ready fails, and a missing folder adds nothing');
{
  const backlog = tmpDir();
  backlogFile(backlog, 'idle', 'todo', [{ id: 'd-1', file: 'a.js', decision: 'NEEDS_USER', status: 'open' }]);
  ok(/nothing to build/.test(withBacklog(configWith([]), backlog).err ?? ''), 'no ready file and no plan is an error that says so');

  const dir = tmpDir();
  const given = inventory(dir, 'given', [{ id: 'g-1', file: 'x.js' }]);
  const missing = join(dir, 'no-such-folder');
  const { out, notes, err } = withBacklog(configWith([]), missing, given);
  ok(!err, `a plan with a missing backlog folder still builds: ${err ?? ''}`);
  eq(JSON.parse(out).plans.map((r) => r.id).join(','), 'given', 'the folder adds no row');
  ok(/no backlog folder at/.test(notes), `and the note says so: ${notes.trim()}`);
  ok(/usage:/.test(argsWith(configWith([])).err ?? ''), 'no plan and no --backlog is still a usage error');
}

section('a status edit whose value is null removes that key\'s line, with its own line ending, and a repeat is a no-op');
{
  const pulledPlan = (eol, last) => [
    '## Plan: inbox - backlog', 'mode: fix', 'gate: green', '',
    '### [inbox-1] first', '- file: a.js:1', '- decision: ACTIONABLE', '- pulled: r1#blk', '', 'What.', '',
    '### [inbox-2] last', '- file: b.js:1', '- pulled: r1#blk',
  ].join(eol) + (last ? eol : '');
  for (const [eol, last, name] of [['\n', true, 'LF'], ['\r\n', true, 'CRLF'], ['\n', false, 'no trailing newline']]) {
    const path = fixture(pulledPlan(eol, last), 'inbox.md');
    const removals = [{ planPath: path, id: 'inbox-1', key: 'pulled', value: null }, { planPath: path, id: 'inbox-2', key: 'pulled', value: null }];
    const { err } = argsWith(configWith([record({ blocks: [[status('inbox-1', 'fixed', path), ...removals, ...removals]] })]), path);
    ok(!err, `${name}: it succeeds: ${err ?? ''}`);
    const text = read(path);
    ok(!/pulled:/.test(text), `${name}: both pulled lines are gone, the repeated removal included`);
    ok(text.includes(`- decision: ACTIONABLE${eol}- status: fixed${eol}${eol}What.`), `${name}: the status edit lands where the removed line was`);
    ok(text.endsWith(last ? `- file: b.js:1${eol}` : '- file: b.js:1'), `${name}: the last line keeps the file's ending`);
    eq(text.split(eol).length, pulledPlan(eol, last).split(eol).length - 2 + 1 + 2, `${name}: two lines left, one status line and the synced key's two lines came, and no other line changed`);
  }
  const path = fixture(pulledPlan('\n', true), 'inbox.md');
  const bad = argsWith(configWith([record({ blocks: [[{ planPath: path, id: 'inbox-1', key: 'pullled', value: null }]] })]), path).err ?? '';
  ok(/removes the pullled line of inbox-1 in .*inbox\.md, which fails: unknown issue key "pullled"/.test(bad), `an unknown key fails, naming the removal: ${bad}`);
  const renamed = argsWith(configWith([record({ blocks: [[{ planPath: path, id: 'inbox-1', key: 'effort', value: null }]] })]), path).err ?? '';
  ok(/removes the effort line of inbox-1 .*was renamed to "size", so use size in its place/.test(renamed), `a renamed key fails with a message that never asks for a value: ${renamed}`);
  const typed = argsWith(configWith([record({ blocks: [[{ planPath: path, id: 'inbox-1', key: 'pulled', value: 7 }]] })]), path).err ?? '';
  ok(/is not \{ planPath \(absolute\), id, key, value \(a string, or null to remove the line\), expectPulled \(absent, or the pulled value the entry must carry\), expectNoOpen \(absent, or true\) \}/.test(typed), 'a value that is neither a string nor null still fails the record');
  const badExpect = argsWith(configWith([record({ blocks: [[{ planPath: path, id: 'inbox-1', key: 'pulled', value: null, expectPulled: 7 }]] })]), path).err ?? '';
  ok(/is not \{ planPath \(absolute\), id, key, value/.test(badExpect), `an expectPulled that is not a string fails the record: ${badExpect}`);
}

section('a status edit with expectPulled applies only to an entry whose pulled line holds that mark');
{
  const marked = (mark) => [
    '## Plan: inbox - backlog', 'mode: fix', 'gate: green', '',
    '### [inbox-1] first', '- file: a.js:1', '- decision: ACTIONABLE', '- status: open', ...(mark ? [`- pulled: ${mark}`] : []), '', 'What.', '',
  ].join('\n');
  const edits = (path) => [{ planPath: path, id: 'inbox-1', key: 'status', value: 'fixed', expectPulled: 'r1#blk' }, { planPath: path, id: 'inbox-1', key: 'pulled', value: null, expectPulled: 'r1#blk' }];
  for (const [mark, name] of [['r1#blk', 'its own mark'], ['r2#other', 'a foreign mark'], [null, 'no mark']]) {
    const path = fixture(marked(mark), 'inbox.md');
    const { err, notes } = argsWith(configWith([record({ blocks: [[...edits(path)]] })]), path);
    ok(!err, `${name}: it succeeds: ${err ?? ''}`);
    const text = read(path);
    ok(notes.includes(`applied ${mark === 'r1#blk' ? 2 : 0} status edit(s) from run wf_1`), `${name}: the fold note counts only the edits it applied: ${notes.trim()}`);
    if (mark === 'r1#blk') {
      ok(text.includes('- status: fixed') && !/pulled:/.test(text), `${name}: the status edit and the removal apply`);
      continue;
    }
    ok(text.includes('- status: open') && !text.includes('- status: fixed'), `${name}: the status edit is skipped`);
    ok(mark ? text.includes(`- pulled: ${mark}`) : !/pulled:/.test(text), `${name}: the pulled line stays as it was`);
    ok(notes.includes(`leaves the status line of inbox-1`) && notes.includes(mark ? `its pulled line is "${mark}", not "r1#blk"` : 'its pulled line is absent, not "r1#blk"'), `${name}: a note names the skipped edit and the mark it found: ${notes.trim()}`);
  }
  const path = fixture(marked('r1#blk'), 'inbox.md');
  const unmarked = argsWith(configWith([record({ blocks: [[{ planPath: path, id: 'inbox', key: 'status', value: 'done', expectPulled: 'r1#blk' }]] })]), path).err ?? '';
  ok(/sets inbox status=done in .*inbox\.md, which fails: no issue "inbox"/.test(unmarked), `an expectPulled on a block id fails, naming the edit: ${unmarked}`);
}

section('a status edit with expectNoOpen sets a todo block done only once it holds no open entry');
{
  const inbox = (second, blockStatus = null) => [
    '## Plan: inbox - backlog', 'mode: fix', 'gate: green', ...(blockStatus ? [`status: ${blockStatus}`] : []), '',
    '### [inbox-1] first', '- file: a.js:1', '- decision: ACTIONABLE', '- status: open', '- pulled: r1#blk', '', 'What.', '',
    '### [inbox-2] second', '- file: b.js:1', '- decision: ACTIONABLE', ...second, '', 'What.', '',
  ].join('\n');
  const close = (path, id, mark = 'r1#blk') => [{ planPath: path, id, key: 'status', value: 'fixed', expectPulled: mark }, { planPath: path, id, key: 'pulled', value: null, expectPulled: mark }];
  const done = (path) => ({ planPath: path, id: 'inbox', key: 'status', value: 'done', expectNoOpen: true });
  const statusOf = (text) => text.match(/^status: (\w+)$/m)?.[1] ?? 'todo';
  for (const [second, blockStatus, want, note, name] of [
    [['- status: fixed'], null, 'done', '', 'every other entry closed'],
    [['- status: needs-attention'], null, 'done', '', 'the other entry waits on the user, which is not open'],
    [['- status: open'], null, 'todo', 'block inbox still holds the open entry inbox-2', 'another entry still open'],
    [[], null, 'todo', 'block inbox still holds the open entry inbox-2', 'another entry with no status line, which counts as open'],
    [['- status: fixed'], 'skip', 'skip', 'block inbox is skip, not todo', 'a block that is not todo'],
  ]) {
    const path = fixture(inbox(second, blockStatus), 'inbox.md');
    const { err, notes } = argsWith(configWith([record({ blocks: [[...close(path, 'inbox-1'), done(path)]] })]), path);
    ok(!err, `${name}: it succeeds: ${err ?? ''}`);
    const text = read(path);
    ok(text.includes('### [inbox-1] first\n- file: a.js:1\n- decision: ACTIONABLE\n- status: fixed\n\nWhat.'), `${name}: the pulled entry closes first`);
    eq(statusOf(text), want, `${name}: the block's status`);
    ok(note ? notes.includes(`leaves the status line of inbox in`) && notes.includes(note) : !notes.includes('leaves the status line of inbox in'),
      `${name}: ${note ? 'a note says why the block stays' : 'no note'}: ${notes.trim()}`);
  }

  // Two blocks of one run pulled one entry each from the file: only the later done edit finds every entry closed.
  const both = fixture(inbox(['- status: open', '- pulled: r1#other']), 'inbox.md');
  const { err: bothErr } = argsWith(configWith([record({ blocks: [[...close(both, 'inbox-1'), done(both)], [...close(both, 'inbox-2', 'r1#other'), done(both)]] })]), both);
  ok(!bothErr, `two blocks' edits succeed: ${bothErr ?? ''}`);
  eq(statusOf(read(both)), 'done', 'the file closes once the second block closes its last open entry');

  // develop names the block after its file, so a hand-written file with another block id keeps its status and the fold goes on.
  const renamed = fixture(inbox(['- status: fixed']).replace('## Plan: inbox -', '## Plan: inbox-hand -'), 'inbox.md');
  const { err: renamedErr, notes: renamedNotes } = argsWith(configWith([record({ blocks: [[...close(renamed, 'inbox-1'), done(renamed)]] })]), renamed);
  ok(!renamedErr && statusOf(read(renamed)) === 'todo' && read(renamed).includes('- status: fixed\n\nWhat.'), `a file with no such block keeps its block status and still takes the entry edits: ${renamedErr ?? ''}`);
  ok(renamedNotes.includes('the file holds no block "inbox"'), `and a note says why: ${renamedNotes.trim()}`);

  const onIssue = fixture(inbox(['- status: fixed']), 'inbox.md');
  const issueErr = argsWith(configWith([record({ blocks: [[{ planPath: onIssue, id: 'inbox-2', key: 'status', value: 'fixed', expectNoOpen: true }]] })]), onIssue).err ?? '';
  ok(/sets inbox-2 status=fixed in .*inbox\.md, which fails: "inbox-2" in .*inbox\.md is an issue entry, not a block/.test(issueErr), `an expectNoOpen on an issue id fails, naming the edit: ${issueErr}`);
  const badFlag = argsWith(configWith([record({ blocks: [[{ ...done(onIssue), expectNoOpen: false }]] })]), onIssue).err ?? '';
  ok(/is not \{ planPath \(absolute\), id, key, value .*expectNoOpen \(absent, or true\) \}/.test(badFlag), `an expectNoOpen that is not true fails the record: ${badFlag}`);
}

section('--backlog never builds an entry another block\'s developer pulled');
{
  const backlog = tmpDir();
  const taken = backlogFile(backlog, 'taken', 'todo', [{ id: 'taken-1', file: 'a.js', status: 'open' }]);
  writeFileSync(taken, read(taken).replace('- status: open', '- status: open\n- pulled: r1#blk'));
  backlogFile(backlog, 'free', 'todo', [{ id: 'free-1', file: 'b.js', status: 'open' }]);
  const { out, err } = withBacklog(configWith([]), backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(JSON.parse(out).plans.map((r) => r.id).join(','), 'free', 'a file whose only ready entry carries a pulled line is left out');

  const only = tmpDir();
  const lone = backlogFile(only, 'lone', 'todo', [{ id: 'lone-1', file: 'a.js', status: 'open' }]);
  writeFileSync(lone, read(lone).replace('- status: open', '- status: open\n- pulled: r1#blk'));
  ok(/no pulled line.*nothing to build/.test(withBacklog(configWith([]), only).err ?? ''), 'and with no other ready file there is nothing to build, which the message says');

  const pack = tmpDir();
  const mixed = backlogFile(pack, 'mixed', 'todo', [{ id: 'mixed-1', file: 'big.js', loc: 4000, status: 'open' }, { id: 'mixed-2', file: 'small.js', loc: 10, status: 'open' }]);
  writeFileSync(mixed, read(mixed).replace('- loc: 4000\n- decision: ACTIONABLE\n- status: open', '- loc: 4000\n- decision: ACTIONABLE\n- status: open\n- pulled: r1#blk'));
  backlogFile(pack, 'next', 'todo', [{ id: 'next-1', file: 'other.js', loc: 2000, status: 'open' }]);
  const packedOut = argsWith(configWith([]), '--backlog', pack, '--pack', pack, '--loc-cap', '2500');
  eq(packedOut.err ? packedOut.err : JSON.parse(packedOut.out).plans.map((r) => r.id).join(','), 'mixed-plus-1', '--pack weighs only the files of entries a developer will work, so a pulled entry\'s file adds no lines');
}

section('--backlog leaves out a file whose open ACTIONABLE entry still holds a plan-entry.mjs placeholder, and names the entry');
{
  const backlog = tmpDir();
  const unfilled = backlogFile(backlog, 'unfilled', 'todo', [{ id: 'unfilled-1', file: 'a.js', status: 'open' }, { id: 'unfilled-2', file: 'a.js', status: 'open' }]);
  writeFileSync(unfilled, read(unfilled).replace('### [unfilled-2] unfilled-2', `### [unfilled-2] ${PLACEHOLDER}`));
  const asked = backlogFile(backlog, 'asked', 'todo', [{ id: 'asked-1', file: 'b.js', status: 'open' }, { id: 'asked-2', file: 'b.js', decision: 'NEEDS_USER', status: 'open' }]);
  writeFileSync(asked, read(asked).replace(/What\.\n$/, `**Fix:** ${PLACEHOLDER}\n`));
  const quoted = backlogFile(backlog, 'quoted', 'todo', [{ id: 'quoted-1', file: 'c.js', status: 'open' }]);
  writeFileSync(quoted, read(quoted).replace('What.', `**What:** a check that flags "${PLACEHOLDER}"\n\n    **Fix:** ${PLACEHOLDER}`));
  const before = read(unfilled);

  const { out, notes, err } = withBacklog(configWith([]), backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(JSON.parse(out).plans.map((r) => r.id).join(','), 'asked,quoted',
    'only the file with an unfilled ACTIONABLE entry is left out: an unfilled NEEDS_USER entry waits for triage anyway, and a quoted or indented placeholder is filled text');
  ok(/left out .*unfilled\.md: entry unfilled-2 still holds the placeholder/.test(notes) && !/unfilled-1/.test(notes), `the note names only the unfilled entry: ${notes.trim()}`);
  eq(read(unfilled), before, 'the left-out file keeps its bytes');

  const only = tmpDir();
  const lone = backlogFile(only, 'lone', 'todo', [{ id: 'lone-1', file: 'a.js', status: 'open' }]);
  writeFileSync(lone, read(lone).replace('What.', `**What:** ${PLACEHOLDER}`));
  ok(/unfilled placeholder.*nothing to build/.test(withBacklog(configWith([]), only).err ?? ''), 'with no other ready file there is nothing to build, which the message says');
}

section('--backlog holds a parked-with entry until its block is done or skip, then cuts the line and builds it');
{
  const plans = tmpDir();
  const backlog = tmpDir();
  const block = (name, status) => backlogFile(plans, name, status, [{ id: `${name}-1`, file: 'w.js' }]);
  const parkedWith = (id) => `**Parked with:** block ${id}. Hold this entry until that block is done or skip.`;
  /** A backlog file written by block `writer` of run p1, one ACTIONABLE entry per `[id, extra lines]` pair, each naming `file`. */
  const writtenBy = (name, writer, entries, { dir = backlog, file = 'a.js', loc = 10 } = {}) => fixture([`## Plan: ${name} - backlog from block ${writer} of run p1`, 'mode: fix', 'gate: green', 'status: todo', '',
    ...entries.flatMap(([id, ...extra]) => [`### [${id}] ${id}`, `- file: ${file}:1`, `- loc: ${loc}`, '- decision: ACTIONABLE', '- status: open', '', 'What.', '**Fix:** fix it.', ...extra, ''])].join('\n'), `${name}.md`, dir);
  const landed = block('landed', 'done');
  const dropped = block('dropped', 'skip');
  const shelved = block('shelved', 'backlogged');
  const pending = block('pending', 'todo');
  const stuck = block('stuck', 'blocked');
  const member = block('member', 'done');
  const fromLanded = writtenBy('from-landed', 'landed', [
    ['l-1', parkedWith('landed')], ['l-2', parkedWith('dropped')], ['l-3', parkedWith('pending')], ['l-4', parkedWith('stuck')],
    ['l-5', parkedWith('ghost')], ['l-6', parkedWith('member-plus-1')], ['l-7', `    ${parkedWith('pending')}`],
    ['l-8', '**Parked with:** block `landed`.'], ['l-9', parkedWith('gone')], ['l-10', parkedWith('gone')], ['l-11', parkedWith('renamed')]]);
  const fromShelved = writtenBy('from-shelved', 'shelved', [['s-1', parkedWith('shelved')]]);
  const fromShelvedMixed = writtenBy('from-shelved-mixed', 'shelved', [['m-1', parkedWith('shelved')], ['m-2']]);
  const fromCrlf = writtenBy('from-crlf', 'landed', [['c-1', parkedWith('landed')]]);
  writeFileSync(fromCrlf, `${BOM}${read(fromCrlf).replace(/\n/g, '\r\n')}`);
  const rows = [landed, dropped, shelved, pending, stuck].map((planPath) => ({ id: planPath.replace(/^.*[\\/]|\.md$/g, ''), planPath }))
    .concat([{ id: 'member-plus-1', blocks: [{ id: 'member', planPath: member }] }, { id: 'gone', planPath: join(plans, 'missing.md') }, { id: 'renamed', planPath: landed }]);
  const config = configWith([record({ runId: 'wf_p1', args: { runId: 'p1', backlogDir: backlog, plans: rows } })]);
  const shelvedBefore = read(fromShelved);

  const { out, notes, err } = withBacklog(config, backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  const text = read(fromLanded);
  const held = (id) => new RegExp(`### \\[${id}\\][^#]*\\n\\*\\*Parked with:\\*\\*`).test(text);
  eq(['l-1', 'l-2', 'l-6'].filter(held).join(','), '', 'a block that is done or skip, a pass whose members are all done included, releases its entry: the line is cut on disk');
  eq(['l-3', 'l-4', 'l-5', 'l-8', 'l-9', 'l-10', 'l-11'].filter(held).join(','), 'l-3,l-4,l-5,l-8,l-9,l-10,l-11',
    'a todo, a blocked and an unknown block keep the hold, and so do a line that names no block, a gone plan file and a gone block');
  ok(text.includes('**Fix:** fix it.\n\n### [l-2]'), 'the cut takes the line\'s own ending and nothing else');
  ok(text.includes(`What.\n**Fix:** fix it.\n    ${parkedWith('pending')}\n`), 'an indented copy of the line is not a hold and is left as it is');
  const wayOut = 'Once that block is done or skip, release each entry it holds by deleting that entry\'s \\*\\*Parked with:\\*\\* line';
  ok(new RegExp(`kept the hold on l-5 in .*from-landed\\.md: no run record names block ghost of run p1\\. ${wayOut}`).test(notes),
    `an unknown block keeps the hold, with a note naming the way out: ${notes.trim()}`);
  ok(new RegExp(`kept the hold on l-8 in .*from-landed\\.md: its \\*\\*Parked with:\\*\\* line names no block as "block <id>"\\. ${wayOut}`).test(notes),
    'a line that names no block keeps the hold, with a note naming the way out');
  ok(new RegExp(`cannot read .*missing\\.md, which holds gone \\(.*\\), so the entries parked with it stay held\\. ${wayOut}`).test(notes),
    'a gone plan file keeps the hold, with a note naming the way out');
  eq((notes.match(/cannot read .*missing\.md/g) ?? []).length, 1, 'a block that holds two entries is looked up once');
  ok(new RegExp(`landed\\.md no longer holds renamed, so the entries parked with it stay held\\. ${wayOut}`).test(notes),
    'a gone block keeps the hold, with a note naming the way out');
  eq(read(fromShelved), shelvedBefore, 'a backlogged block keeps the hold, so its file is left as it was');
  eq(read(fromCrlf), `${BOM}${['## Plan: from-crlf - backlog from block landed of run p1', 'mode: fix', 'gate: green', 'status: todo', '',
    '### [c-1] c-1', '- file: a.js:1', '- loc: 10', '- decision: ACTIONABLE', '- status: open', '', 'What.', '**Fix:** fix it.', ''].join('\r\n')}`,
  'a BOM\'d CRLF file loses only the line and its CRLF ending');
  eq(err ? '' : JSON.parse(out).plans.map((r) => r.id).join(','), 'from-crlf,from-landed,from-shelved-mixed',
    'a file whose only ready entry is held is left out, and a file with a ready entry beside a held one is built');
  ok(read(fromShelvedMixed).includes(parkedWith('shelved')), 'and the held entry of a built file keeps its line, which the fix-mode developer reads as not ACTIONABLE');

  const lone = tmpDir();
  writeFileSync(join(lone, 'only.md'), read(fromShelved));
  const nothing = withBacklog(config, lone).err ?? '';
  ok(/no pulled line or held Parked with line.*nothing to build/.test(nothing), `a held entry alone is nothing to build, which the message says: ${nothing}`);

  // A plan with two blocks of one id fails validation, so the parked block's status cannot be read.
  const pendingBefore = read(pending);
  writeFileSync(pending, `${pendingBefore}\n${pendingBefore}`);
  ok(/cannot load .*pending\.md, which holds pending, the block a backlog entry is parked with \(.*\)\. Its status decides whether that entry is held back/.test(withBacklog(config, backlog).err ?? ''),
    'a parked block\'s plan that exists but fails to validate fails loudly instead of releasing the entry');
  writeFileSync(pending, pendingBefore);

  const weigh = tmpDir();
  writtenBy('heavy', 'shelved', [['h-1', parkedWith('shelved')]], { dir: weigh, file: 'big.js', loc: 4000 });
  writeFileSync(join(weigh, 'heavy.md'), `${read(join(weigh, 'heavy.md'))}### [h-2] h-2\n- file: small.js:1\n- loc: 10\n- decision: ACTIONABLE\n- status: open\n\nWhat.\n`);
  writtenBy('next', 'landed', [['n-1']], { dir: weigh, file: 'other.js', loc: 2000 });
  const weighed = argsWith(config, '--backlog', weigh, '--pack', weigh, '--loc-cap', '2500');
  eq(weighed.err ? weighed.err : JSON.parse(weighed.out).plans.map((r) => r.id).join(','), 'heavy-plus-1', '--pack weighs only the files of entries a developer will work, so a held entry\'s file adds no lines');
}

section('--backlog leaves out a file whose ready entry names a file a blocked block names, and builds the rest');
{
  const plans = tmpDir();
  const backlog = tmpDir();
  const work = fixture(['## Plan: stuck - change the parser', 'mode: feature', 'gate: green', 'status: blocked', '',
    'Edit `./src/held.js` and src\\win.js, then the docs and src/free.js.orig.', '',
    '## Plan: landed - the loader', 'mode: feature', 'gate: green', 'status: done', '', 'Edit src/free.js.', ''].join('\n'), 'work.md', plans);
  const held = backlogFile(backlog, 'held', 'done', [{ id: 'held-1', file: 'src/held.js', status: 'open' }]);
  backlogFile(backlog, 'win', 'todo', [{ id: 'win-1', file: 'src/win.js', status: 'open' }]);
  backlogFile(backlog, 'free', 'todo', [{ id: 'free-1', file: 'src/free.js', status: 'open' }]);
  backlogFile(backlog, 'suffix', 'todo', [{ id: 'suffix-1', file: 'held.js', status: 'open' }]);
  backlogFile(backlog, 'longer', 'todo', [{ id: 'longer-1', file: 'src/held.js.bak/x.js', status: 'open' }]);
  const heldBefore = read(held);
  const run9 = record({ runId: 'wf_9', args: { runId: 'p9', backlogDir: backlog, plans: [{ id: 'stuck', planPath: work }, { id: 'landed', planPath: work }] } });

  const { out, notes, err } = withBacklog(configWith([run9]), backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(err ? '' : JSON.parse(out).plans.map((r) => r.id).join(','), 'free,longer,suffix',
    'a file a blocked block names holds its entry back, in either slash direction and with a leading ./, and a file named only by a done block, a shorter path, a longer one or one with an added extension builds');
  ok(/held held-1 in .*held\.md: block stuck \(blocked\) in .*work\.md names src\/held\.js, and a relaunch of it may change that file, so the file is left out/.test(notes), `the note names the entry, the blocked block and the file: ${notes.trim()}`);
  ok(/held win-1 in .*win\.md: block stuck \(blocked\)/.test(notes), 'a backslash path in the block text holds its entry too');
  eq(read(held), heldBefore, 'a held done file stays done on disk');

  const otherFolder = record({ runId: 'wf_10', args: { runId: 'p10', backlogDir: tmpDir(), plans: [{ id: 'stuck', planPath: work }] } });
  const elsewhere = withBacklog(configWith([otherFolder]), backlog);
  ok(!/held /.test(elsewhere.notes), `a run on another backlog folder holds nothing here: ${elsewhere.notes.trim()}`);

  const given = withBacklog(configWith([]), backlog, fixture(read(work).replace('status: done', 'status: todo'), 'given.md', plans));
  ok(/held held-1 in .*held\.md: block stuck \(blocked\) in .*given\.md/.test(given.notes), `a blocked block of a plan named here holds too: ${given.notes.trim()}`);

  const pass = record({ runId: 'wf_11', args: { runId: 'p11', backlogDir: backlog, plans: [
    { id: 'gone', planPath: join(plans, 'gone.md') },
    { id: 'stuck-plus-1', mode: 'fix', blocks: [{ id: 'stuck', planPath: work, issues: [] }, { id: 'landed', planPath: work, issues: [] }] },
  ] } });
  const member = withBacklog(configWith([pass]), backlog);
  ok(!member.err, `a row whose plan file is gone holds nothing and fails nothing: ${member.err ?? ''}`);
  ok(/held held-1 in .*held\.md: block stuck \(blocked\) in .*work\.md/.test(member.notes), `a blocked member of a pass row holds its files: ${member.notes.trim()}`);

  const old = fixture(read(work).replace('status: blocked', 'status: parked'), 'old.md', plans);
  const parked = withBacklog(configWith([record({ runId: 'wf_12', args: { runId: 'p12', backlogDir: backlog, plans: [{ id: 'stuck', planPath: old }] } })]), backlog);
  ok(/held held-1 in .*held\.md: block stuck \(parked\) in .*old\.md/.test(parked.notes), `an older engine's parked block holds its files too: ${parked.notes.trim()}`);
  ok(/held held-1 in .*held\.md: block stuck \(parked\).*so the file is left out\. A parked block is never relaunched, so set stuck in its plan file to skip to drop it, to todo to rebuild it, or to backlogged only when a backlog entry carries its work\./.test(parked.notes),
    'and the note names every way the user releases it');
  ok(!/never relaunched/.test(given.notes), 'a blocked holder\'s note names no parked way out');

  writeFileSync(work, `${read(work)}\n${read(work)}`);
  ok(/cannot read the blocked blocks of .*work\.md/.test(withBacklog(configWith([run9]), backlog).err ?? ''), 'a built plan that fails to validate fails loudly instead of releasing the entries it may hold');
}

section('--backlog matches a writer whose runId the header title rewrites, and reads only block status edits');
{
  const plans = tmpDir();
  const backlog = tmpDir();
  const stuck = backlogFile(plans, 'stuck', 'blocked', [{ id: 'stuck-1', file: 'w.js' }]);
  const writer = backlogFile(plans, 'wx', 'done', [{ id: 'wx-1', file: 'w.js' }]);
  const issues = backlogFile(plans, 'host', 'todo', [{ id: 'wx', file: 'w.js' }]);
  const header = (name, blockId, runId) => fixture([`## Plan: ${name} - backlog from block ${blockId} of run ${runId}`, 'mode: fix', 'gate: green', 'status: todo', '',
    `### [${name}-1] ${name}`, '- file: a.js:1', '- decision: ACTIONABLE', '- status: open', '', 'What.', ''].join('\n'), `${name}.md`, backlog);
  header('from-dash', 'stuck', 'p — 1');
  header('from-spaced', 'stuck', ' p2 ');
  header('from-wx', 'wx', 'p3');
  const dash = record({ runId: 'wf_d', args: { runId: 'p — 1', backlogDir: backlog }, blocks: [[status('stuck', 'blocked', stuck)]] });
  const spaced = record({ runId: 'wf_s', args: { runId: 'p2', backlogDir: backlog }, blocks: [[status('stuck', 'blocked', stuck)]] });
  const both = record({ runId: 'wf_w', args: { runId: 'p3', backlogDir: backlog }, blocks: [[status('wx', 'done', writer), status('wx', 'fixed', issues)]] });
  const { out, notes, err } = withBacklog(configWith([dash, spaced, both]), backlog);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq(err ? '' : JSON.parse(out).plans.map((r) => r.id).join(','), 'from-wx', 'a runId the title parser rewrites still names its writer, so its blocked writer holds its file');
  ok(/left out .*from-dash\.md: the block that wrote it, stuck \(blocked\)/.test(notes), `an em dash runId matches its rewritten header: ${notes.trim()}`);
  ok(/left out .*from-spaced\.md: the block that wrote it, stuck \(blocked\)/.test(notes), 'a header runId with surrounding spaces matches its record');
  ok(!/host\.md no longer holds wx/.test(notes), 'an issue status edit with the writer block\'s id is not read as a block edit');
}

section('args --fold-only writes the folds and cuts, sets no done file to todo, and prints nothing');
{
  const backlog = tmpDir();
  const reopen = backlogFile(backlog, 'reopen', 'done', [{ id: 'o-1', file: 'b.js', status: 'open' }]);
  const built = backlogFile(backlog, 'built', 'todo', [{ id: 'b-1', file: 'a.js', status: 'open' }]);
  const given = inventory(tmpDir(), 'given', [{ id: 'g-1', file: 'x.js' }]);
  const landed = backlogFile(tmpDir(), 'landed', 'done', [{ id: 'landed-1', file: 'w.js' }]);
  const parkedWith = '**Parked with:** block landed. Hold this entry until that block is done or skip.';
  const released = fixture(['## Plan: released - backlog from block landed of run p1', 'mode: fix', 'gate: green', 'status: todo', '',
    '### [r-1] r-1', '- file: c.js:1', '- decision: ACTIONABLE', '- status: open', '', 'What.', '**Fix:** fix it.', parkedWith, ''].join('\n'), 'released.md', backlog);
  const config = configWith([
    record({ blocks: [[status('built', 'done', built), status('b-1', 'fixed', built)], [status('g-1', 'fixed', given)]] }),
    record({ runId: 'wf_p1', args: { runId: 'p1', backlogDir: backlog, plans: [{ id: 'landed', planPath: landed }] } }),
  ]);
  const { out, err } = argsWith(config, given, '--backlog', backlog, '--fold-only');
  ok(!err, `it succeeds although nothing is left to build: ${err ?? ''}`);
  eq(out, '', 'it prints nothing on stdout');
  ok(/^status: done$/m.test(read(built)) && /^- status: fixed$/m.test(read(built)) && /^synced: /m.test(read(built)), 'the backlog fold is written');
  ok(/^- status: fixed$/m.test(read(given)), 'and so is the fold of a plan named here');
  ok(/^status: done$/m.test(read(reopen)) && !/^status: todo$/m.test(read(reopen)), 'a done file with a ready entry stays done');
  ok(!read(released).includes('**Parked with:**') && read(released).includes('**Fix:** fix it.\n'), 'the line of an entry parked with a done block is cut on disk');
  ok(/usage:/.test(argsWith(config, '--backlog', backlog, '--fold-only', '--pack', backlog).err ?? ''), '--fold-only with --pack is a usage error');
  ok(/usage:/.test(argsWith(config, '--fold-only').err ?? ''), 'and so is --fold-only with no plan and no --backlog');
}

for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
