// tools/plan-block.mjs — the roadmap block extractor.
//
// What matters here is the failure paths. A block printed correctly is verified constantly by use; the
// dangerous cases are the ones that would hand an agent something that LOOKS like a plan: a truncated
// body, a silently defaulted gate, a duplicate id quietly sharing another plan's review files.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { emitList, parseBlocks, readGate, resolveRoadmap, run, validate } from '../tools/plan-block.mjs';

const CLI = join(REPO_ROOT, 'tools/plan-block.mjs');
const SAMPLE = join(REPO_ROOT, 'tests/fixtures/roadmap-sample.md');
const sampleText = readFileSync(SAMPLE, 'utf8');

/** The CLI as a user runs it: `{ stdout, stderr, code }`, never throwing. */
function cli(...argv) {
  try {
    return { stdout: execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', stdio: 'pipe' }), stderr: '', code: 0 };
  } catch (e) {
    return { stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status ?? 1 };
  }
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

section('--list derives the control array, so nothing about the roadmap is hand-typed');
{
  const listed = JSON.parse(run([SAMPLE, '--list']));
  eq(JSON.stringify(listed), JSON.stringify([
    { id: 'session-store', gate: 'green' },
    { id: 'login-endpoint', gate: 'green' },
    { id: 'logout-endpoint', gate: 'build-only' },
  ]), 'ids + gates read from the ## Gate lines, in build order');
}

section('a gate reads from either shape, and a trailing comment is not part of it');
{
  eq(readGate('\n## Gate\ngreen\n'), 'green', 'feature\'s "## Gate" heading');
  eq(readGate('\ngate: build-only\n', 'section'), 'build-only', 'migrate\'s inline "gate:" line');
  eq(readGate('\ngate: build-only\n'), null, 'and that shape is NOT accepted for a feature plan');
  eq(readGate('\n## Gate\ngreen   # build + the required verification\n'), 'green', 'comment stripped');
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
  ok(/no gate for: a/.test(gateFails(nogate)), 'a missing gate throws rather than defaulting to green');
  ok(/invalid gate/.test(gateFails('## Plan: a — t\n\n## Gate\nred-baseline\n')),
    'a gate outside green|build-only throws — the engine would silently fall back to green');
}

/** Validate arbitrary roadmap text through the same path the CLI uses. */
function failsWith0(text) {
  try {
    validate(parseBlocks(text), 'test');
    return '';
  } catch (e) { return e.message; }
}

/** As above, but through the real emitList — where gates are checked. */
function gateFails(text, kind = 'plan') {
  try {
    emitList(validate(parseBlocks(text, kind), 'test', kind), 'test', kind);
    return '';
  } catch (e) { return e.message; }
}

section('--kind section reads migrate\'s blocks, gates and titles');
{
  const MIGRATION = join(REPO_ROOT, 'tests/fixtures/migration-sample.md');
  const listed = JSON.parse(run([MIGRATION, '--list', '--kind', 'section']));
  eq(JSON.stringify(listed), JSON.stringify([
    { id: 'date-shim', title: 'a Temporal-backed replacement for the moment helpers', gate: 'green' },
    { id: 'report-callsites', title: 'convert the 14 report builders', gate: 'green' },
    { id: 'drop-moment', title: 'remove the dependency', gate: 'build-only' },
  ]), 'sections carry a title too — migrate\'s control array is { id, title, gate }');

  const block = run([MIGRATION, 'report-callsites', '--kind=section']);
  ok(block.startsWith('## Section: report-callsites'), '--kind=name form works as well as --kind name');
  ok(block.includes('### Test Strategy'), 'the whole section, not truncated');
  ok(!block.includes('drop-moment'), 'and it stops at the next section');

  // red-baseline is legal in a migration and NOT in a feature roadmap — the kind decides.
  ok(gateFails('## Section: a — t\n\ngate: red-baseline\n\nbody\n', 'section') === '',
    'red-baseline passes under --kind section');
  ok(/invalid gate/.test(gateFails('## Plan: a — t\n\n## Gate\nred-baseline\n')),
    'and still fails under the default plan kind');

  // The kinds must not see each other's blocks, or a mixed file would parse as one giant unit.
  eq(parseBlocks(readFileSync(MIGRATION, 'utf8'), 'plan').length, 0, 'plan kind finds no Section blocks');
  eq(parseBlocks(sampleText, 'section').length, 0, 'section kind finds no Plan blocks');
}

section('an unknown --kind throws rather than falling back to plan');
{
  ok(/unknown --kind "chapter"/.test(failsWith(SAMPLE, 'session-store', '--kind', 'chapter')), 'named in the message');
  ok(/--kind needs a value/.test(failsWith(SAMPLE, 'session-store', '--kind')), 'a bare --kind throws');
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
    '## Plan: real-one — the actual feature', '',
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
  eq(JSON.parse(emitList(blocks, 'test')).length, 1, '--list agrees');
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

section('the gate is read ONLY from the place its kind documents');
{
  // A `gate:` line mentioned in prose used to outrank the real `## Gate`. That is not a loud failure:
  // build-only makes the engine accept the feature the moment the build passes, nothing tested.
  const prose = ['## Plan: docs-tool — a linter', '',
    '## Feature', 'Each block needs a line like', 'gate: build-only', 'under its `## Gate` header.', '',
    '## Gate', 'green', ''].join('\n');
  eq(readGate(parseBlocks(prose)[0].body), 'green', 'prose mentioning a gate does not win');

  // An earlier `## Gate` (quoted in a criterion) must not outrank the real trailing one either.
  const twice = '## Plan: a — t\n\n## Acceptance Criteria\n- The template shows:\n\n## Gate\nbuild-only\n\n## Gate\ngreen\n';
  eq(readGate(parseBlocks(twice)[0].body), 'green', 'the LAST ## Gate is the real one');

  // migrate's gate lives in the preamble, above the first "###" — not anywhere in the body.
  const late = '## Section: a — t\n\n### Implementation Steps\n1. Write:\n\ngate: build-only\n';
  eq(readGate(parseBlocks(late, 'section')[0].body, 'section'), null, 'a gate: below the first ### is not the gate');
  eq(readGate('\ngate: red-baseline\n\n### Acceptance Criteria\n- x\n', 'section'), 'red-baseline', 'the preamble one is');
}
