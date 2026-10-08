// tools/plan-block.mjs — the roadmap block extractor.
//
// What matters here is the failure paths. A block printed correctly is verified constantly by use; the
// dangerous cases are the ones that would hand an agent something that LOOKS like a plan: a truncated
// body, a silently defaulted gate, a duplicate id quietly sharing another plan's review files.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { emitList, parseBlocks, parseFileKeys, parseIssues, parsePreamble, readGate, resolveRoadmap, run, validate } from '../tools/plan-block.mjs';

const CLI = join(REPO_ROOT, 'tools/plan-block.mjs');
const SAMPLE = join(REPO_ROOT, 'tests/fixtures/roadmap-sample.md');
const sampleText = readFileSync(SAMPLE, 'utf8');

/** The CLI as a user runs it, from an explicit script path: `{ stdout, stderr, code }`, never throwing. */
function cliAt(script, ...argv) {
  try {
    return { stdout: execFileSync(process.execPath, [script, ...argv], { encoding: 'utf8', stdio: 'pipe' }), stderr: '', code: 0 };
  } catch (e) {
    return { stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status ?? 1 };
  }
}

/** The CLI at its real path — what every case but the link one below runs. */
function cli(...argv) {
  return cliAt(CLI, ...argv);
}

/** The message from a `run()` that should fail, or '' if it wrongly succeeded. */
function failsWith(...argv) {
  try {
    run(argv);
    return '';
  } catch (e) { return e.message; }
}

section('the sample roadmap parses into its three plans, in file order');
{
  const blocks = parseBlocks(sampleText);
  eq(blocks.map((b) => b.id).join(','), 'session-store,login-endpoint,logout-endpoint', 'ids in order');
  eq(blocks[0].title, 'redis-backed session table', 'title split on the em dash, id keeps its hyphens');
  ok(!blocks.some((b) => b.id.includes(' ')), 'no id absorbed its title');
}

section('a body header does NOT end a block (the truncation bug this tool exists to prevent)');
{
  // Plan bodies use `## Feature`, `## Acceptance Criteria`, ... — an agent scanning for the next `##`
  // would stop one paragraph in. Only `## Plan:` may end a block.
  const [first] = parseBlocks(sampleText);
  ok(first.text.includes('## Feature'), 'the body starts with ## Feature');
  ok(first.text.includes('## Test Strategy'), 'and still contains the LAST section of the body');
  ok(first.text.includes('## Gate'), 'including the gate');
  ok(!first.text.includes('## Plan: login-endpoint'), 'and stops before the next plan');
}

section('every block is a verbatim slice of the file — no reassembly, no normalization');
for (const block of parseBlocks(sampleText)) {
  ok(sampleText.includes(block.text), `${block.id} appears in the source byte-for-byte`);
}

section('the last block runs to end of file');
{
  const blocks = parseBlocks(sampleText);
  const last = blocks[blocks.length - 1];
  ok(last.text.includes('build-only'), 'logout-endpoint keeps its trailing gate line');
  ok(sampleText.endsWith(last.text), 'and ends exactly where the file does');
}

section('CRLF input parses the same way (a pasted plan can arrive with Windows line endings)');
{
  const blocks = parseBlocks(sampleText.replace(/\n/g, '\r\n'));
  eq(blocks.length, 3, 'still three blocks');
  ok(blocks[0].text.includes('## Gate'), 'and the first block is still whole');
}

section('text before the first block is ignored');
{
  const blocks = parseBlocks('# Roadmap\n\nSome preamble.\n\n## Plan: only-one — t\n\nbody\n');
  eq(blocks.length, 1, 'one block');
  ok(!blocks[0].text.includes('preamble'), 'the preamble is not part of it');
}

section('--list derives the control object, so nothing about the roadmap is hand-typed');
{
  const listed = JSON.parse(run([SAMPLE, '--list']));
  eq(JSON.stringify(listed), JSON.stringify({
    goal: '', ordered: false, suite: 'green', sweep: 'none',
    blocks: [
      { id: 'session-store', title: 'redis-backed session table', mode: 'feature', gate: 'green', status: 'todo' },
      { id: 'login-endpoint', title: 'POST /session', mode: 'feature', gate: 'green', status: 'todo' },
      { id: 'logout-endpoint', title: 'DELETE /session', mode: 'feature', gate: 'build-only', status: 'todo' },
    ],
  }), 'the file keys, then one row per block, every default already applied');
}

section('a gate reads from the block preamble');
{
  eq(readGate('\ngate: build-only\n'), 'build-only', 'a plan states its gate in its preamble');
  eq(readGate('\n## Feature\nno gate here\n'), null, 'absent reads as null, never as a default');
}

section('every structural fault throws, naming the plan — none may resolve to a default');
{
  const nogate = '## Plan: a — t\n\n## Feature\nx\n';
  ok(failsWith(SAMPLE, 'nope').includes('session-store'), 'unknown id lists the ids that do exist');
  ok(/empty body/.test(failsWith0('## Plan: a — t\n\n## Plan: b — t\n\nbody\n')), 'an empty body throws');
  ok(/twice/.test(failsWith0('## Plan: a — t\n\nbody\n\n## Plan: a — t2\n\nbody\n')), 'a duplicate id throws');
  ok(/kebab/.test(failsWith0('## Plan: Not A Slug\n\nbody\n')), 'a non-kebab id throws');
  ok(/no "## Plan/.test(failsWith0('# just a plan\n\n## Feature\nx\n')), 'a file with no blocks throws');
  ok(/no gate for: a/.test(planFails(nogate)), 'a missing gate throws rather than defaulting to green');
  ok(/no gate for: a \(mode feature\)/.test(planFails('## Plan: a — t\n\n## Gate\ngreen\n')),
    'a "## Gate" heading with no preamble gate is body text, so the gate is missing');
  ok(/mode feature does not allow/.test(planFails('## Plan: a — t\ngate: red-baseline\n\nbody\n')),
    'a gate outside green|build-only throws — the engine would silently fall back to green');
}

/** Validate arbitrary roadmap text through the same path the CLI uses. */
function failsWith0(text) {
  try {
    validate(parseBlocks(text), 'test');
    return '';
  } catch (e) { return e.message; }
}

// ---------------------------------------------------------------------------------------------------
// The metadata grammar: three runs of `key: value` lines and nowhere else. Every case
// here is either a DEFAULT nobody may re-derive, or a typo that must not silently take one.
// ---------------------------------------------------------------------------------------------------

/** --list for arbitrary plan text, through the whole path the CLI uses. */
function listOf(text) {
  return JSON.parse(emitList(validate(parseBlocks(text), 'test'), 'test', parseFileKeys(text)));
}

/** The message from a listOf() that should fail, or '' if it wrongly succeeded. */
function planFails(text) {
  try {
    listOf(text);
    return '';
  } catch (e) { return e.message; }
}

const ONE = (preamble = 'gate: green\n', body = '') => `## Plan: a - t\n${preamble}\nbody\n${body}`;

section('the file keys open the file, and every default is applied in the output');
{
  const bare = listOf(ONE());
  eq(bare.goal, '', 'goal defaults to empty');
  eq(bare.ordered, false, 'ordered defaults to false');
  eq(bare.suite, 'green', 'suite defaults to green');
  eq(bare.sweep, 'none', 'sweep defaults to none');

  const keyed = listOf(`goal: ship it\nordered: true\nsuite: scoped\nsweep: goal-coverage\n\n${ONE()}`);
  eq(keyed.goal, 'ship it', 'a goal is free text');
  eq(keyed.ordered, true, 'ordered is emitted as a boolean, not the string');
  eq(keyed.suite, 'scoped', 'suite is read');
  eq(keyed.sweep, 'goal-coverage', 'sweep is read');

  // The run is the top of the file only. A colon-bearing line further down is prose, so a plan that
  // discusses its own goal cannot silently rewrite the file's control values.
  eq(listOf(`# Title\n\ngoal: prose, not a file key\n\n${ONE()}`).goal, '',
    'a key: line that does not open the file is body text');
  eq(listOf(`---\ntitle: x\nordered: true\n---\ngoal: after the fence\n\n${ONE()}`).goal, 'after the fence',
    'a --- frontmatter fence is skipped without being read, and the keys under it are the file keys');

  // Markdown puts a blank line under a `---` fence, and a blank misses the run shape. Reading that gap
  // as "no keys" replaced every declared value with its default at exit 0 — ordered silently false.
  const gapped = listOf(`---\ntitle: x\n---\n\ngoal: ship it\nordered: true\n\n${ONE()}`);
  eq(gapped.goal, 'ship it', 'the file keys are found across the blank line under the fence');
  eq(gapped.ordered, true, 'so a declared ordered is not replaced by its default');
  eq(listOf(`\ngoal: g\nsweep: goal-coverage\n\n${ONE()}`).sweep, 'goal-coverage',
    'and across a blank line that opens the file');

  // The gap above the run is crossed; a gap INSIDE it still ends it, which is what keeps prose out.
  eq(listOf(`goal: real\n\nsuite: scoped\n\n${ONE()}`).suite, 'green',
    'a blank INSIDE the run ends it, so the line below is body text');
}

section('a section-mode block flips the FILE defaults, and an explicit key still wins');
{
  const flipped = listOf(`goal: g\n\n${ONE('mode: section\ngate: red-baseline\n', '')}`);
  eq(flipped.ordered, true, 'ordered flips to true — sections run in order');
  eq(flipped.sweep, 'goal-coverage', 'and sweep flips to goal-coverage');
  // migrate never demanded a green whole suite, so a test-first migration must not park on its own red.
  eq(flipped.suite, 'scoped', 'and suite flips to scoped');

  const explicit = listOf(`goal: g\nordered: false\n\n${ONE('mode: section\ngate: green\n', '')}`);
  eq(explicit.ordered, false, 'an explicit ordered outranks the flip');
  eq(explicit.sweep, 'goal-coverage', 'and the other defaults still flip');
  eq(explicit.suite, 'scoped', 'suite among them');
  eq(listOf(`goal: g\nsuite: green\n\n${ONE('mode: section\ngate: green\n', '')}`).suite, 'green',
    'an explicit suite outranks the flip');
}

section('a goal-coverage sweep with no goal exits 1 naming the goal: file key');
{
  const GOALLESS = /sweep is goal-coverage but no goal is set.*"goal:" file key/;
  ok(GOALLESS.test(planFails(ONE('mode: section\ngate: green\n', ''))),
    'a section file with no goal fails on the flipped default');
  ok(GOALLESS.test(planFails(`sweep: goal-coverage\n\n${ONE()}`)), 'an explicit sweep with no goal fails too');
  eq(listOf(`sweep: none\n\n${ONE('mode: section\ngate: green\n', '')}`).sweep, 'none',
    'sweep: none is the way out, and passes with no goal');
}

section('block metadata is read from the preamble run and NOWHERE else');
{
  const [block] = parseBlocks(ONE('mode: fix\ngate: green\nstatus: parked\ntest_selector: -k parser\ndepends_on: bus-parser\n', ''));
  eq(block.mode, 'fix', 'mode');
  eq(block.preamble.values.status, 'parked', 'status');
  eq(block.preamble.values.test_selector, '-k parser', 'test_selector is recognized and free text');
  eq(block.preamble.values.depends_on, 'bus-parser', 'depends_on likewise');

  const row = listOf(ONE('mode: fix\ngate: green\nstatus: done\n', '')).blocks[0];
  eq(JSON.stringify(row), JSON.stringify({ id: 'a', title: 't', mode: 'fix', gate: 'green', status: 'done' }),
    'and each reaches --list');

  // The live case: a plan body's ## Test Strategy section is `kind:` / `unit:` / `method:` / `details:`
  // at column 0. Below the first blank line those are prose — reading them would fail on an unknown key.
  const [sample] = parseBlocks(sampleText);
  eq(JSON.stringify(sample.preamble.values), '{"gate":"green"}', 'the sample roadmap\'s blocks carry a gate-only preamble');
  eq(sample.mode, 'feature', 'so mode falls to its default');
  eq(listOf(ONE('gate: green\n', '\n## Test Strategy\nkind: tests-after\ndetails: node --test\n')).blocks[0].mode,
    'feature', 'a Test Strategy body section does not register as metadata');
  eq(listOf(ONE('gate: green\n', '\nmode: fix\n')).blocks[0].mode, 'feature',
    'and neither does a bare "mode:" line in prose — the preamble is the only place it may be written');

  // The blank line under `## Plan: <id>` is what the shipped template writes (tests/fixtures/roadmap-sample.md).
  // It used to end the run before it started, so every declared key took its default at exit 0.
  const gapBlock = listOf('goal: g\n\n' + ONE('\nmode: section\ngate: red-baseline\nstatus: done\n', ''));
  eq(gapBlock.blocks[0].mode, 'section', 'a blank line under the header does not void the preamble');
  eq(gapBlock.blocks[0].gate, 'red-baseline', 'the declared gate is still read');
  eq(gapBlock.blocks[0].status, 'done', 'and the declared status is still read');
  eq(gapBlock.ordered, true, 'the file defaults flip on the mode that gap nearly hid');
  eq(readGate('\n\ngate: red-baseline\n'), 'red-baseline',
    'readGate crosses the same gap, so it cannot disagree with the block about the gate');

  // Crossed to FIND a run, never to continue one — a blank INSIDE the run still ends it.
  ok(/no gate for: a \(mode fix\)/.test(planFails(ONE('\nmode: fix\n\ngate: green\n', ''))),
    'a blank line inside the run ends it, and the line below is body prose again');
}

section('issue entries live under a fix-mode block, and carry their own `- key:` run');
{
  const FIXES = ['## Plan: inventory - the verified issues', 'mode: fix', 'gate: green', '',
    '### [null-deref] the loader crashes', '- severity: high', '- file: src/loader.js',
    '- decision: ACTIONABLE', '', 'What happens: prose, and a bullet that is not metadata.',
    '- status: not read here', '', '### [stale-cache] the cache never expires', '- id: stale-cache',
    '- status: fixed', '', '## Files', '- src/loader.js', ''].join('\n');
  const [block] = parseBlocks(FIXES);
  eq(block.issues.map((e) => e.id).join(','), 'null-deref,stale-cache', 'both entries, in file order');
  eq(block.issues[0].title, 'the loader crashes', 'the heading text after the bracketed id is the title');
  eq(block.issues[0].values.severity, 'high', 'its run is read');
  eq(block.issues[0].values.status, undefined,
    'and the `- status:` bullet below the blank line is prose, not a second value');
  eq(block.issues[1].values.status, 'fixed', 'the second entry has its own run');
  eq(JSON.stringify(listOf(FIXES).blocks[0].id), '"inventory"', 'the block still lists normally');

  // Same fence rule as every other header here: a quoted example is not an entry.
  eq(parseBlocks(ONE('', '\n```\n### [x-y] an example entry\n```\n\n## Gate\ngreen\n'))[0].issues.length, 0,
    'a fenced entry heading is an example, not an entry');

  // The entry twin of the preamble gap: markdown convention puts a blank line under a heading, and that
  // blank used to leave `values` empty — severity, decision and status all silently absent, at exit 0.
  const [gapEntry] = parseBlocks(['## Plan: a - t', 'mode: fix', 'gate: green', '',
    '### [x-y] an entry', '', '- severity: low', '- decision: DEFER', '', 'body', ''].join('\n'))[0].issues;
  eq(gapEntry.values.severity, 'low', 'a blank line under an entry heading does not void its run');
  eq(gapEntry.values.decision, 'DEFER', 'and the whole run is read, not just its first line');
}

section('--list rejects a todo fix block with no issue entry, and validate() does not');
{
  // An empty todo inventory used to pass --list and halt a launched run only after a developer spawned.
  const fixBlock = (preamble, entries = '', id = 'empty-inv') => `## Plan: ${id} - t\nmode: fix\ngate: green\n${preamble}\n${entries}body\n`;
  const FIXES = /add one, delete the block, or set its "status:" to skip/;

  const todo = planFails(fixBlock('status: todo\n'));
  ok(/empty-inv/.test(todo), 'a todo fix block with no entry throws, naming the block');
  ok(todo.includes('"### [<id>]"'), 'the message names the entry heading it needs');
  ok(FIXES.test(todo), 'and the three fixes');
  ok(/empty-inv/.test(planFails(fixBlock(''))), 'a fix block with no status: line is todo by default, so it throws');
  ok(/empty-inv/.test(planFails(fixBlock('status: todo\n', '```\n### [x-y] an example entry\n```\n\n'))),
    'a fenced entry heading is an example, so its block still throws');

  const both = planFails(`${fixBlock('')}\n${fixBlock('', '', 'other-inv')}`);
  ok(/in test/.test(both) && /empty-inv/.test(both) && /other-inv/.test(both), 'one throw names every such block and the file');

  for (const status of ['done', 'skip', 'parked', 'blocked']) {
    eq(listOf(fixBlock(`status: ${status}\n`)).blocks[0].status, status, `a ${status} fix block with no entry still lists`);
  }
  eq(listOf(fixBlock('status: todo\n', '### [x-y] t\n\n')).blocks[0].id, 'empty-inv', 'a todo fix block with one entry lists');
  eq(failsWith0(fixBlock('status: todo\n')), '', 'validate() still accepts a todo fix block with no entry');
}

section('every metadata fault exits 1 naming the offending key, value or id');
{
  ok(/unknown file key "goa"/.test(planFails(`goa: x\n\n${ONE()}`)), 'an unknown file key names it');
  ok(/goal, ordered, suite, sweep/.test(planFails(`goa: x\n\n${ONE()}`)), 'and lists the run\'s keys');
  ok(/illegal file key "suite: turquoise"/.test(planFails(`suite: turquoise\n\n${ONE()}`)),
    'an illegal file enum names the key AND the value');
  ok(/unknown preamble key "gaet"/.test(planFails(ONE('gaet: green\n'))), 'an unknown preamble key names it');
  ok(/illegal preamble key "mode: fixup"/.test(planFails(ONE('mode: fixup\n'))), 'an illegal mode too');
  ok(/illegal preamble key "status: nearly"/.test(planFails(ONE('status: nearly\n'))), 'and an illegal status');
  ok(/is set twice in one run/.test(planFails(ONE('gate: green\ngate: build-only\n'))),
    'one key twice in a run throws — there is no rule for which value wins');

  // A gate legal for another mode is not legal here. Silently coercing it is how a feature gets accepted
  // on a green build with nothing tested.
  ok(/mode feature does not allow/.test(planFails(ONE('gate: red-baseline\n'))),
    'a gate outside the block\'s own mode set throws');
  ok(/a fix-mode plan takes green/.test(planFails(ONE('mode: fix\ngate: build-only\n', ''))),
    'and the message names the mode\'s legal set');

  const fix = (entry) => `## Plan: a - t\nmode: fix\ngate: green\n\n${entry}\n\nbody\n`;
  ok(/unknown issue key "sevrity"/.test(planFails(fix('### [x-y] t\n- sevrity: high'))), 'an unknown issue key');
  ok(/illegal issue key "severity: urgent"/.test(planFails(fix('### [x-y] t\n- severity: urgent'))),
    'an illegal issue enum');
  ok(/issue id "Not Kebab".*kebab/.test(planFails(fix('### [Not Kebab] t'))), 'a non-kebab entry id');
  ok(/heading id and the id key disagree/.test(planFails(fix('### [x-y] t\n- id: z-w'))),
    'an `- id:` that contradicts its heading');
  ok(/legal only under a fix-mode plan/.test(planFails(ONE('', '\n### [x-y] t\n\n## Gate\ngreen\n'))),
    'an entry under a feature-mode block');
  ok(/is claimed twice/.test(planFails(fix('### [a] t'))),
    'an issue id colliding with a BLOCK id — the two namespaces are one');
  ok(/is claimed twice/.test(planFails(`${fix('### [x-y] t')}\n## Plan: b - t\nmode: fix\ngate: green\n\n### [x-y] t\n\nbody\n`)),
    'and two entries sharing an id across blocks');
}

section('every scanner reports positions into the RAW bytes — a splice cannot corrupt a BOM or a CRLF');
{
  const PLAN = ['goal: ship it', 'ordered: true', '', '## Plan: a - t', 'mode: fix', 'gate: green', '',
    '### [x-y] an entry', '- severity: low', '- decision: DEFER', '', 'body', ''].join('\n');

  for (const [name, text] of [['plain', PLAN], ['CRLF', PLAN.replace(/\n/g, '\r\n')], ['BOM', `\uFEFF${PLAN}`]]) {
    const slice = (p) => text.slice(p.start, p.end);
    const fileKeys = parseFileKeys(text);
    const [block] = parseBlocks(text);

    eq(fileKeys.keys.map(slice).join('|'), 'goal: ship it|ordered: true', `${name}: each file-key line`);
    eq(slice(fileKeys), text.includes('\r') ? 'goal: ship it\r\nordered: true' : 'goal: ship it\nordered: true',
      `${name}: and the run as a whole`);
    eq(text.slice(fileKeys.keys[0].valueStart, fileKeys.keys[0].valueEnd), 'ship it',
      `${name}: the value span is the value alone, which is what a set tool overwrites`);

    eq(block.preamble.keys.map(slice).join('|'), 'mode: fix|gate: green', `${name}: each preamble line`);
    eq(block.issues[0].keys.map(slice).join('|'), '- severity: low|- decision: DEFER', `${name}: each issue line`);
    ok(slice(block.issues[0]).startsWith('### [x-y] an entry'), `${name}: the entry span opens at its heading`);
    eq(slice(block), block.text, `${name}: and the block span reproduces the block`);
  }

  // A crossed gap moves the run's start, and `runStart` measures on the BOM-stripped text while the
  // reported positions must land on the raw bytes — so the skip and the shift are asserted together.
  const GAPPED = ['---', 'title: x', '---', '', 'goal: ship it', '', '## Plan: a - t', 'gate: green', '',
    'body', ''].join('\n');
  for (const [name, text] of [['plain', GAPPED], ['CRLF', GAPPED.replace(/\n/g, '\r\n')], ['BOM', `\uFEFF${GAPPED}`]]) {
    const run = parseFileKeys(text);
    eq(text.slice(run.start, run.end), 'goal: ship it', `${name}: the run span opens past the crossed gap`);
  }

  // The scanners take a position, so they can be pointed at any run without re-reading the file.
  eq(parsePreamble('mode: fix\ngate: green\n', 0).values.gate, 'green', 'parsePreamble scans from an index');
  eq(parseIssues(PLAN, 0, PLAN.length).map((e) => e.id).join(','), 'x-y', 'parseIssues scans a range');
}

section('--kind is retired: any form of it exits 1 naming the one remaining grammar, never ignored');
{
  const forms = [[SAMPLE, '--list', '--kind', 'section'], [SAMPLE, 'session-store', '--kind=component'],
    [SAMPLE, 'session-store', '--kind']];
  for (const argv of forms) {
    const res = cli(...argv);
    eq(res.code, 1, `${argv.slice(1).join(' ')}: exit 1`);
    ok(res.stdout === '', `${argv.slice(1).join(' ')}: nothing on stdout`);
    ok(/--kind is retired/.test(res.stderr) && /"## Plan: <id>" with a preamble "gate:" line/.test(res.stderr),
      `${argv.slice(1).join(' ')}: the reason names the retirement and what replaces it`);
  }
}

section('a bare name resolves to the plan-mode directory; a path is left alone');
{
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg';
  eq(resolveRoadmap('swirling-amber-moth').replace(/\\/g, '/'), '/tmp/cfg/plans/swirling-amber-moth.md',
    'CLAUDE_CONFIG_DIR is honoured');
  eq(resolveRoadmap(SAMPLE), SAMPLE, 'an absolute path passes through unchanged');
  ok(resolveRoadmap('some/where/roadmap.md').includes('roadmap.md'), 'a relative path stays a path');
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
}

section('the CLI itself: exit codes and where the message goes');
{
  const good = cli(SAMPLE, 'login-endpoint');
  eq(good.code, 0, 'exit 0 on success');
  ok(good.stdout.startsWith('## Plan: login-endpoint'), 'the block goes to stdout');
  ok(good.stdout.includes('## Gate'), 'whole, not truncated at the first body header');

  const bad = cli(SAMPLE, 'no-such-plan');
  eq(bad.code, 1, 'exit 1 on an unknown id');
  ok(bad.stdout === '', 'nothing on stdout — a caller cannot mistake an error for a plan');
  ok(bad.stderr.includes('plan-block:'), 'the reason goes to stderr');

  eq(cli(join(REPO_ROOT, 'tests/fixtures/does-not-exist.md'), 'x').code, 1, 'exit 1 on a missing file');
  eq(cli(SAMPLE).code, 1, 'exit 1 with usage when the selector is missing');
}

section('stdout is byte-identical to the slice (the plan reaches the agent verbatim)');
{
  const printed = cli(SAMPLE, 'session-store').stdout;
  const parsed = parseBlocks(sampleText).find((b) => b.id === 'session-store').text;
  eq(printed.replace(/\r/g, ''), parsed, 'what the agent reads is what the user approved');
}

// ---------------------------------------------------------------------------------------------------
// The class that matters: inputs where the parser could return a WRONG answer at exit 0. Every case
// above this line is a fault `validate()` already throws on; these are the silent ones, and each was a
// live defect found by adversarial review rather than by the suite.
// ---------------------------------------------------------------------------------------------------

section('a header inside a fenced code block is an example, not a boundary');
{
  // Before the fix this minted a PHANTOM plan from the example (which would get a full build loop) and
  // truncated the real block at the opening fence, losing its remaining steps AND its gate — exit 0.
  const text = [
    '## Plan: real-one — the actual feature', 'gate: green', '',
    '## Implementation Steps',
    '1. The roadmap format looks like:', '',
    '```markdown',
    '## Plan: example-block — do not implement me', '',
    '## Gate',
    'build-only',
    '```', '',
    '2. Do the real work.', '',
    '## Gate',
    'green', '',
  ].join('\n');
  const blocks = parseBlocks(text);
  eq(blocks.length, 1, 'the fenced example is not a second plan');
  ok(blocks[0].text.includes('2. Do the real work.'), 'the real block keeps the steps after the fence');
  ok(blocks[0].text.includes('## Gate\ngreen'), 'and its own gate');
  eq(readGate(blocks[0].body), 'green', 'the fenced "build-only" example is not mistaken for the gate');
  eq(JSON.parse(emitList(blocks, 'test')).blocks.length, 1, '--list agrees');
}

section('an UNCLOSED fence throws — it used to delete every block after it, at exit 0');
{
  // `fence` is threaded across the whole file and was never inspected after the loop, so ONE unbalanced
  // marker left it open to EOF and every later header was read as an example. --list then printed a SHORTER
  // roadmap at exit 0: the missing units never run, and the survivor's gate becomes the merged tail's.
  const plan = ['## Plan: session-store — a', '', '## Implementation Steps', '```js',
    'const a = 1;', '', '## Plan: login-endpoint — b', '', '## Gate', 'build-only', ''].join('\n');
  ok(/unclosed "```" code fence/.test(failsWith0(plan)), 'the open fence is named and refused');
}

section('a column-0 header that misses the shape throws — it must never merge into its neighbour');
{
  // Neither a boundary nor an error before the fix, so the block merged into the previous one: `beta`
  // vanished from --list AND alpha's gate flipped green -> build-only (beta's), in one exit-0 answer.
  const noColon = '## Plan: alpha — a\n\nbody a\n\n## Gate\ngreen\n\n## Plan beta — b\n\nbody b\n\n## Gate\nbuild-only\n';
  ok(/malformed "## Plan:"/.test(failsWith0(noColon)), 'a forgotten colon is named and refused');
  ok(/## Plan beta — b/.test(failsWith0(noColon)), 'and the offending header is quoted back');

  const emptyId = '## Plan: alpha — a\n\nbody a\n\n## Gate\ngreen\n\n## Plan:\n\nbody b\n\n## Gate\nbuild-only\n';
  ok(/malformed "## Plan:"/.test(failsWith0(emptyId)), 'a colon with no id throws the same way');

  // Same mechanism, same exit-0 corruption, two more near-miss shapes: a space before the colon, and a
  // header one level too deep. Both were live-reproduced printing `[{ id: alpha, gate: build-only }]`.
  const spacedColon = '## Plan: alpha — a\n\nbody a\n\n## Gate\ngreen\n\n## Plan : beta — b\n\nbody b\n\n## Gate\nbuild-only\n';
  ok(/malformed "## Plan:"/.test(failsWith0(spacedColon)), 'a space before the colon is named and refused');
  ok(/## Plan : beta — b/.test(failsWith0(spacedColon)), 'and that header is quoted back too');

  const deepHeader = '## Plan: alpha — a\n\nbody a\n\n## Gate\ngreen\n\n### Plan: beta — b\n\nbody b\n\n## Gate\nbuild-only\n';
  ok(/malformed "## Plan:"/.test(failsWith0(deepHeader)), 'a "###" header throws rather than merging');

  // The kebab-token requirement is what keeps ordinary prose headings out of that throw.
  eq(parseBlocks('## Plan: alpha — a\n\n## Plan Rationale\n\nwhy\n\n## Gate\ngreen\n').length, 1,
    'a prose heading such as "## Plan Rationale" is still just body text');
}

section('an indented header throws — it must never be silently dropped');
{
  // 1-3 spaces still renders as a heading, so a human sees a plan the parser does not. Dropping it
  // silently removes a whole feature from the roadmap; --list would report N-1 plans at exit 0.
  const text = '## Plan: a — t\n\n## Implementation Steps\n1. Then:\n\n   ## Plan: b — lost feature\n\n## Gate\ngreen\n';
  ok(/indented "## Plan:"/.test(failsWith0(text)), 'named and refused');
  ok(/lost feature/.test(failsWith0(text)), 'and the offending header is quoted back');
}

section('a BOM does not swallow the first block');
{
  // `^` does not match before a BOM, so header 1 never matched and its whole block was absorbed by
  // "text before the first block is ignored" — one plan silently missing from --list.
  const blocks = parseBlocks('\uFEFF## Plan: first — a\n\n## Gate\ngreen\n\n## Plan: second — b\n\n## Gate\ngreen\n');
  eq(blocks.map((b) => b.id).join(','), 'first,second', 'both blocks survive');
}

section('the CLI still prints when its own path goes through a symlink or junction');
{
  // Node resolves the MAIN module through realpath, so comparing `import.meta.url` against the RAW argv[1]
  // made `invokedDirectly` false through any link: the process wrote NOTHING and exited 0, bypassing every
  // loud failure above. An installed plugin dir, a subst drive or macOS /tmp -> /private/tmp all trigger it.
  // Skipped where a link cannot be created (no privilege, no support) rather than failing for the machine.
  const dir = mkdtempSync(join(tmpdir(), 'aipg-plan-block-'));
  const link = join(dir, 'tools');
  let linked = false;
  try {
    symlinkSync(join(REPO_ROOT, 'tools'), link, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch { linked = false; }

  if (linked) {
    const viaLink = cliAt(join(link, 'plan-block.mjs'), SAMPLE, '--list');
    eq(viaLink.code, 0, 'exit 0 through the link');
    ok(viaLink.stdout.includes('session-store'), 'and it actually printed the control array, rather than nothing');
  } else {
    ok(true, 'skipped — this machine cannot create a link');
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
