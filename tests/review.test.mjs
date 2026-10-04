// debug/review.mjs — the read-only fan-out that builds the inventory.
// Focus: the lens ARRAY (several angles over the same files, one issue file, one verifier) and the
// returned issues[] index, the triaged inventory a develop fix-mode block is built from.
import { runEngine, runTrace, throwsWith, section, ok, eq } from './harness.mjs';
import { emitList, parseBlocks, parseFileKeys, validate } from '../tools/plan-block.mjs';

const ENGINE = 'workflows/debug/review.mjs';

const UNIT = { id: 'u1', hash: 'h', files: [{ path: 'a.js', loc: 10 }] };
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, conventions: 'c' };
const run = (args, respond) => runEngine(ENGINE, { args: { ...baseArgs, units: [UNIT], ...args }, respond });

const DESTRUCT = { id: 'destructive', mandate: 'auditing for DESTRUCTIVE behavior', categories: ['data-loss', 'irreversible-op'], findingNoun: 'destructive DEFECTS', matters: ' unattended' };
const FLOW     = { id: 'control-flow', mandate: 'auditing CONTROL-FLOW', categories: ['control-flow', 'null-handling'] };

const MATRIX  = { clarity: 'clear', effort: 'small', blast_radius: 'local', scope: 'in-scope', architectural: false };
const keep    = (id, extra = {}) => ({ finding_id: id, is_real: true, severity: 'high', decision: 'ACTIONABLE', matrix: MATRIX, theme: 'x', ...extra });
const finding = (extra) => ({ file: 'a.js', line: '1', severity: 'high', title: 'T', detail: 'd', ...extra });
const NO_FINDINGS = { wrote_clean_marker: false, findings: [] };
const catsOf  = (call) => call.opts.schema?.properties?.findings?.items?.properties?.category?.enum;

section('only a lens whose categories include convention is told to file convention findings');
// A lens enum without 'convention' would make the reviewer emit a category its schema rejects.
{
  const MAP = "File deviations from CONVENTIONS as 'convention' findings.";
  const { calls } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, { id: 'base' }] }] }, { 'review': NO_FINDINGS });
  ok(!calls[0].prompt.includes(MAP), 'a lens enum without convention carries no convention mapping');
  ok(calls[1].prompt.includes(MAP), 'the base enum keeps it');
  ok(calls.every((c) => c.prompt.includes('CONVENTIONS (judge against these):')), 'the shared rubric line names no category');
}

section('a lens array spawns one reviewer per lens and exactly ONE verifier');
{
  const { out, calls, logs, byLabel, prompt } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, {
    'review:u1/destructive':  { wrote_clean_marker: false, findings: [finding({ category: 'data-loss', title: 'T1' })] },
    'review:u1/control-flow': { wrote_clean_marker: false, findings: [finding({ category: 'control-flow', title: 'T2' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1'), keep('u1-2', { severity: 'medium', theme: 'y' })] },
  });
  const revs = byLabel('review');
  eq(revs.length, 2, 'two reviewers');
  eq(byLabel('verify').length, 1, 'exactly ONE verifier for the unit, however many lenses ran');
  eq(out.unitsReviewed, 1, 'one unit, so one issue file');
  eq(out.inventory.total, 2, 'both lenses\' findings kept');
  ok(JSON.stringify(catsOf(revs[0])) === JSON.stringify(DESTRUCT.categories), 'reviewer 1 got its own category enum');
  ok(JSON.stringify(catsOf(revs[1])) === JSON.stringify(FLOW.categories), 'reviewer 2 got its own category enum');
  ok(revs[0].prompt.includes(DESTRUCT.mandate) && revs[1].prompt.includes(FLOW.mandate), 'each reviewer got its own mandate');
  ok(revs[0].prompt.includes('destructive DEFECTS'), 'the lens findingNoun reached the severity floor');
  ok(revs[1].prompt.includes('production DEFECTS'), 'an un-set lens field falls back to the base default');
  const v = prompt('verify');
  ok(v.includes('REVIEWERS\' BRIEFS') && v.includes('[destructive]') && v.includes('[control-flow]'), 'the verifier sees BOTH briefs, labelled');
  ok(v.includes('[destructive] :: a.js') && v.includes('[control-flow] :: a.js'), 'each candidate is tagged with the lens that raised it');
  ok(v.includes('FOLD DUPLICATES FIRST'), 'the verifier is told to fold cross-lens duplicates');
  ok(/spawn ceiling: ≤ 3 agents \(2 reviewer/.test(logs.join('\n')), `the logged spawn ceiling counts lenses: ${logs[1]}`);
  eq(calls.length, 3, 'two reviewers + one verifier is the whole run — no organizer, no scribe');
}

section('no harness dedup: distinct same-file, same-category findings from one lens all reach verify');
// A file:category key dropped every finding after the first, and the inventory is CLOSED, so a dropped
// defect was never fixed or shown. Folding true duplicates is the verifier's job, not the harness's.
{
  const two = { wrote_clean_marker: false, findings: [finding({ category: 'correctness', title: 'A' }), finding({ category: 'correctness', title: 'B' })] };
  const { out, prompt } = await run({}, {
    'review': two,
    'verify': { wrote_file: true, verdicts: [keep('u1-1'), keep('u1-2')] },
  });
  const v = prompt('verify');
  ok(v.includes('u1-1 :: a.js:1 :: correctness/high :: A') && v.includes('u1-2 :: a.js:1 :: correctness/high :: B'), 'both findings are verifier candidates');
  ok(v.includes('FOLD DUPLICATES FIRST. One reviewer can surface'), 'a single-lens verifier is told to fold duplicates too, since the harness no longer does');
  eq(out.inventory.total, 2, 'both kept');
}

section('a single lens object offers the clean marker and skips verify entirely');
{
  const { out, calls } = await run({ lens: DESTRUCT }, { 'review': { wrote_clean_marker: true, findings: [] } });
  eq(calls.length, 1, 'one reviewer, no verifier for a clean unit');
  eq(calls[0].label, 'review:u1', 'no lens suffix on the label when there is only one lens');
  ok(calls[0].prompt.includes('CLEAN-UNIT MARKER'), 'the only lens may write the marker');
  eq(out.inventory.total, 0, 'clean');
}

section('only the LAST lens may write the clean marker');
// An earlier lens writing it could leave a premature "clean" file as the terminal on-disk state if a
// later lens throws — and resume trusts that file, silently dropping whatever the later lens found.
{
  const { calls } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, { 'review': NO_FINDINGS });
  ok(!calls[0].prompt.includes('CLEAN-UNIT MARKER'), 'lens 1 may NOT write the marker');
  ok(calls[1].prompt.includes('CLEAN-UNIT MARKER'), 'lens 2 (the last) may');
}

section('the write rule names the marker only when the marker section is present');
// A non-final lens was told to write the marker "described below" with nothing below, so a zero-finding
// reviewer could not tell whether it must write a file.
{
  const NO_MARKER = 'Write no file. Another pass decides the unit\'s marker. Return wrote_clean_marker=false.';
  const { calls } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, { 'review': NO_FINDINGS });
  ok(calls[0].prompt.includes(NO_MARKER), 'the non-final lens is told to write no file');
  ok(!calls[0].prompt.includes('described below'), 'and is never pointed at a missing marker section');
  ok(calls[1].prompt.includes('the ONLY file you may write is the clean-unit marker described below'), 'the final lens keeps the marker clause');
  ok(!calls[1].prompt.includes(NO_MARKER), 'and is not told to write no file');
}

section('ALREADY FOUND entries carry the lens id and location, and a set lens is named');
// Bare titles left a later lens guessing whether a candidate repeats one.
{
  const { calls } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, {
    'review:u1/destructive':  { wrote_clean_marker: false, findings: [finding({ category: 'data-loss', line: '12-14', title: 'T1' })] },
    'review:u1/control-flow': NO_FINDINGS,
    'verify': { wrote_file: true, verdicts: [keep('u1-1')] },
  });
  ok(calls[1].prompt.includes('\n  - [destructive] a.js:12-14 T1'), 'the prior finding is rendered as [lens] file:line title');
  ok(calls[0].prompt.includes('\nLENS: destructive\n') && calls[1].prompt.includes('\nLENS: control-flow\n'), 'each reviewer is told its lens id');
  const { prompt } = await run({}, { 'review': NO_FINDINGS });
  ok(!prompt('review').includes('\nLENS: '), 'an unset lens names no placeholder id');
}

section('the verifier gets each unit file\'s LOC for the entry loc line');
// With no source for `- loc:`, verifiers ran wc -l themselves.
{
  const TWO = { ...UNIT, files: [{ path: 'a.js', loc: 10 }, { path: 'lib/b.js', loc: 37 }] };
  const { prompt } = await run({ units: [TWO] }, {
    'review': { wrote_clean_marker: false, findings: [finding({ file: 'lib/b.js', category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1')] },
  });
  const v = prompt('verify');
  ok(v.includes('  - a.js (10 LOC)\n  - lib/b.js (37 LOC)'), 'every unit file reaches the verifier with its LOC');
  ok(v.includes('- loc: <that file\'s LOC from UNIT FILES>'), 'the template points loc at that list');
  ok(v.includes('write its first line (840)'), 'a range collapses to its first line');
}

section('an empty lens array reads as unset, never as zero reviewers');
// `[]` is truthy, so without normalization it would replace a real lens set with nothing: the unit gets
// no reviewer, contributes 0 to every count, and still looks processed. Silent zero coverage.
{
  const cases = [
    ['unit.lens=[] falls back to args.lens', { units: [{ ...UNIT, lens: [] }], lens: DESTRUCT }, DESTRUCT.mandate],
    ['unit.lens=[] with no args.lens falls back to the default', { units: [{ ...UNIT, lens: [] }] }, 'examining ONE bounded unit'],
    ['args.lens=[] falls back to the default', { lens: [] }, 'examining ONE bounded unit'],
  ];
  for (const [name, args, mandate] of cases) {
    const { calls, logs } = await run(args, { 'review': NO_FINDINGS });
    eq(calls.length, 1, `${name}: one reviewer ran`);
    ok(calls[0].prompt.includes(mandate), `${name}: with the expected mandate`);
    ok(/1 reviewer\(s\)/.test(logs[0]), `${name}: the reviewer count logged matches`);
  }
}

section('a DEAD lens reviewer is named, not silently counted as a clean lens');
// `r?.findings || []` makes a dead lens identical to one that found nothing: the surviving lens keeps
// items.length > 0, the unit is verified and logged with a ✓, its issue file is written with the unit
// hash — and hash-based resume then SKIPS a unit one of whose lenses never looked at it.
{
  const { out, calls, logs, prompt } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, {
    'review:u1/destructive': null,                                  // dead agent
    'review:u1/control-flow': { wrote_clean_marker: false, findings: [finding({ category: 'control-flow', title: 'T2' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1')] },
  });
  const text = logs.join('\n');
  ok(/⚠ u1\/destructive: reviewer returned nothing/.test(text), `the dead lens is named: ${text}`);
  ok(text.includes('contributed NO coverage'), 'and the log says the coverage is missing, not clean');
  eq(calls.length, 3, 'the surviving lens still verifies — the unit is not dropped');
  eq(out.inventory.total, 1, 'only the live lens\'s finding is in the inventory');
  ok(!calls[1].prompt.includes('CLEAN-UNIT MARKER'), 'the surviving final lens is not offered the marker');
  ok(prompt('verify').includes('\nhash: incomplete\n'), 'the inventory is stamped incomplete, so hash resume re-reviews the unit');
  ok(!prompt('verify').includes(`hash: ${UNIT.hash}\n`), 'and never with the real unit hash');
  eq(JSON.stringify(out.failed), JSON.stringify([{ unit: 'u1', stage: 'review', lens: 'destructive' }]), 'the dead lens is in the return');
  eq(out.unitsReviewed, 0, 'a unit with a dead lens is not counted as reviewed');
}

section('a dead lens followed by a clean final lens never offers the clean marker');
// The marker carries the real hash, so writing it after a dead lens would let resume skip a unit that
// lens never looked at.
{
  const { calls } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, {
    'review:u1/destructive': null,
    'review:u1/control-flow': NO_FINDINGS,
  });
  eq(calls.length, 2, 'two reviewers, no verifier');
  ok(!calls[1].prompt.includes('CLEAN-UNIT MARKER'), 'the final lens may NOT write the marker when a sibling died');
}

section('a dead SOLE reviewer is not reported as a clean unit');
// The items.length === 0 path prints "clean but the reviewer did NOT write …", which misdiagnoses a
// dead agent as a clean unit that merely lost its marker.
{
  const { out, calls, logs } = await run({ lens: DESTRUCT }, { 'review': null });
  eq(calls.length, 1, 'no verifier — there are no findings to verify');
  ok(/⚠ u1: reviewer returned nothing/.test(logs.join('\n')), 'the death is logged before the clean-unit line');
  eq(JSON.stringify(out.failed), JSON.stringify([{ unit: 'u1', stage: 'review', lens: 'destructive' }]), 'the dead reviewer is in the return');
  eq(out.unitsReviewed, 0, 'and the unit is not counted as reviewed');
}

section('the verifier\'s required wrote_file attestation is actually read');
// It is `required` in VERIFY_SCHEMA and instructed in the prompt; unread, a verifier that wrote nothing
// still logs a ✓ pointing at a file that does not exist.
{
  const { logs } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness', title: 'T' })] },
    'verify': { verdicts: [keep('u1-1')] },                          // verdicts, but no wrote_file
  });
  const text = logs.join('\n');
  ok(/⚠ u1: verifier did NOT confirm writing E:\/r\/runs\/t\/issues\/u1\.md \(no wrote_file\)/.test(text), `the missing attestation is named with the path: ${text}`);
}

section('a DEAD verifier is named and says how many findings were dropped');
// `verify?.verdicts || []` yields no kept issues, so all four counts are 0 and the ✓ line reads as a
// normal clean-ish unit — while the unit's real findings vanish from the returned issues[] the operator
// builds a fix-mode block from. Nothing downstream can notice: those issues never reach the block, so
// develop's no-issue-entries halt never fires for them.
{
  const { out, logs } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness', title: 'A' }), finding({ category: 'security', title: 'B' })] },
    'verify': null,
  });
  const text = logs.join('\n');
  ok(/⚠ u1: verifier did NOT confirm writing/.test(text), 'the dead verifier is named');
  ok(text.includes('agent returned nothing — its 2 finding(s) were DROPPED'), `the drop count is stated: ${text}`);
  eq(out.inventory.total, 0, 'no verdicts, so nothing is kept');
  eq(JSON.stringify(out.failed), JSON.stringify([{ unit: 'u1', stage: 'verify' }]), 'the dead verifier is in the return');
  eq(out.unitsReviewed, 0, 'and its unit is not counted as reviewed');
}

section('a verifier that did not attest its write never names that file in needsUserFiles');
// Its per-unit file is null, so the operator is never pointed at an issue file that may not exist.
{
  const { out } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness' })] },
    'verify': { verdicts: [keep('u1-1', { decision: 'NEEDS_USER' })] },   // no wrote_file
  });
  eq(out.inventory.needsUser, 1, 'the NEEDS_USER verdict is counted');
  eq(out.needsUserFiles.length, 0, 'but no unwritten path is handed out');
  eq(JSON.stringify(out.failed), JSON.stringify([{ unit: 'u1', stage: 'verify' }]), 'the unattested write is in the return');
}

section('the returned issues[] carries every issue-index field');
// Discarding this index forced the operator to hand-grep it back out of the issue files — which is how
// a `file:224-276` range once became the number 224276.
{
  const { out } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ line: '10-20', category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1', { severity: 'medium', matrix: { ...MATRIX, effort: 'trivial' }, theme: 'th' })] },
  });
  const need = ['id', 'unit', 'file', 'line', 'loc', 'severity', 'category', 'decision', 'effort', 'title', 'theme'];
  const got = out.issues?.[0] || {};
  const missing = need.filter((k) => !(k in got));
  eq(out.issues?.length, 1, 'one issue in the index');
  ok(missing.length === 0, `carries every issue-index field${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
  eq(got.line, '10-20', 'the line RANGE stayed a string');
  eq(got.severity, 'medium', 'severity is the VERIFIER\'s, not the reviewer\'s');
  eq(got.effort, 'trivial', 'effort comes from the verifier\'s matrix');
  eq(got.loc, 10, 'loc is joined from the unit\'s file list');
  eq(out.inventory.actionable, 1, 'counted actionable');
}

section('the verifier writes a fix-mode PLAN block, and its own template parses as one');
// The issue file IS the plan file develop consumes through tools/plan-block.mjs, so the `## Plan:`
// header, its mode/gate/status preamble and every entry's `- status: open` are contract. The unit id is
// PATH-SHAPED on purpose: gen-units mints `workflows/debug#p1`, which plan-block rejects as a block id —
// only slug(unit.id) is legal there, and an already-kebab unit id would sidestep the whole question.
{
  const PATH_UNIT = { id: 'workflows/debug#p1', hash: 'h', files: [{ path: 'a.js', loc: 10 }] };
  const { prompt } = await run({ units: [PATH_UNIT] }, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [keep('workflows-debug-p1-1')] },
  });
  const v = prompt('verify');
  ok(v.includes('## Plan: workflows-debug-p1 - review findings'), 'the block id is slug(unit.id), not the path-shaped unit id');
  ok(v.includes('\nmode: fix\ngate: green\nstatus: todo\n'), 'the preamble declares the fix mode, its only legal gate, and todo');
  ok(v.includes('\n- status: open\n'), 'every entry carries the status the fix bus reads');
  ok(v.includes(`unit: ${PATH_UNIT.id}\nhash: h\nreviewed: true`), 'the frontmatter stamp gen-units resumes on is unchanged');

  // A fixture assembled from the prompt's OWN template: the parenthetical instruction dropped, every
  // <placeholder> filled. Asserting the template's lines proves the words; parsing it proves the format.
  const FILL = {
    id: 'workflows-debug-p1-1', status: 'open', file: 'a.js:1', loc: '10',
    severity: 'high', category: 'correctness', effort: 'small', decision: 'ACTIONABLE', theme: 'x',
  };
  const fixture = v.split('\n-----\n')[1].split('\n')
    .filter((l) => !l.startsWith('(for EACH'))
    .map((l) => {
      const hit = l.match(/^- ([a-z_]+): /);
      if (hit) return `- ${hit[1]}: ${FILL[hit[1]]}`;
      return l.replace('### [<finding_id>] <title>', '### [workflows-debug-p1-1] T');
    })
    .join('\n');
  const unfilled = fixture.split('\n').filter((l) => l.includes('undefined'));
  ok(!unfilled.length, `every templated key has a fixture value${unfilled.length ? ` — ${unfilled.join(' | ')}` : ''}`);

  const blocks = validate(parseBlocks(fixture), 'verifier template');
  const list = JSON.parse(emitList(blocks, 'verifier template', parseFileKeys(fixture)));
  eq(list.blocks.length, 1, 'one block — the frontmatter above it is skipped, not read as file keys');
  eq(list.blocks[0].id, 'workflows-debug-p1', 'listed under the slug id');
  eq(list.blocks[0].mode, 'fix', 'mode fix');
  eq(list.blocks[0].gate, 'green', 'gate green, read from the preamble');
  eq(list.blocks[0].status, 'todo', 'status todo');
  eq(blocks[0].issues.length, 1, 'the entry parses as a fix-mode issue');
  eq(blocks[0].issues[0].values.status, 'open', 'and carries status open');
  eq(blocks[0].issues[0].values.file, 'a.js:1', 'the file:line value survives its own colon');
}

section('a verifier with zero kept verdicts writes the clean-marker bytes, never a plan header');
// A `## Plan:` block with no entries halts develop's fix worker at entries_found 0, and a file with no
// gate throws in plan-block — so the all-REJECTED case must land on the clean marker instead.
{
  const CLEAN_MARKER = '---\nunit: u1\nhash: h\nreviewed: true\n---\n# Review: u1\n\nNo issues found.\n-----';
  const { prompt } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1', { is_real: false, decision: 'REJECT' })] },
  });
  ok(prompt('review').includes(CLEAN_MARKER), 'the reviewer\'s clean-marker instruction is byte-for-byte unchanged');
  const v = prompt('verify');
  ok(v.includes('write NO `## Plan:` header at all'), 'the verifier is told the zero-verdict file is not a plan');
  ok(v.includes('then `# Review: u1`, then the single line "No issues found."'), 'and is given the clean-marker bytes verbatim');
}

section('the clean-marker rule is relative to the severity floor');
// A reviewer returning only sub-floor findings would otherwise write no marker and get no verifier, so
// every resume re-reviews the unit at full cost.
{
  const { prompt } = await run({ reviewSeverity: 'high' }, { 'review': NO_FINDINGS });
  const r = prompt('review');
  ok(r.includes('if AND ONLY IF you find ZERO high+ findings'), 'the marker condition names the floor');
  ok(r.includes('If you report ANY high+ finding, write NOTHING'), 'and so does the write-nothing condition');
}

section('reviewer and verifier grade by impact, never by fix size');
// An unanchored scale lets a crash be graded below the floor, and the harness drops sub-floor findings uncounted.
{
  const SCALE = [
    'When two grades fit, take the higher.',
    'critical - loses or corrupts data, opens a security hole, or breaks the main path on every input.',
    'high - crashes or gives wrong output on an input the code accepts.',
    'medium - a real defect with a bounded impact',
    'low - a real defect with no effect on any input the code accepts today.',
  ];
  const { prompt } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1')] },
  });
  for (const role of ['review', 'verify']) {
    const text = prompt(role).replace(/\s+/g, ' ');
    for (const line of SCALE) ok(text.includes(line), `the ${role} prompt defines the grade: ${line}`);
    ok(!text.includes('is high or critical'), `the ${role} prompt maps no case to two grades`);
  }
}

section('an unknown reviewSeverity throws instead of disabling the floor');
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, units: [UNIT], reviewSeverity: 'Medium' }, respond: {} });
  ok(msg.includes('reviewSeverity "Medium" is not one of low|medium|high|critical'), `throws naming the bad value: ${msg}`);
}

section('long unit ids sharing a 60-char prefix get distinct plan ids; short ids are unchanged');
{
  const prefix = 'src/' + 'a'.repeat(60);
  const units = [
    { id: `${prefix}#1`, hash: 'h1', files: [{ path: 'a.js', loc: 10 }] },
    { id: `${prefix}#2`, hash: 'h2', files: [{ path: 'a.js', loc: 10 }] },
  ];
  const { byLabel } = await run({ units }, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [] },
  });
  const ids = byLabel('verify').map((c) => c.prompt.match(/## Plan: (\S+) - review findings/)?.[1]);
  eq(ids.length, 2, 'both units verified');
  ok(ids[0] && ids[1] && ids[0] !== ids[1], `distinct plan ids: ${ids.join(' | ')}`);
  ok(ids.every((id) => id.length <= 60 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)), 'each stays a legal kebab id of at most 60 chars');
}

section('two unit ids that map to one issue file throw before any reviewer spawns');
{
  const units = [{ ...UNIT, id: 'src/foo-bar' }, { ...UNIT, id: 'src/foo_bar' }];
  const { terminal, calls } = await runTrace(ENGINE, { args: { ...baseArgs, units }, respond: {} });
  eq(terminal.kind, 'throw', 'the run throws');
  ok(terminal.message.includes('"src/foo-bar" and "src/foo_bar" both map to issue file src_foo_bar.md'), `names both ids and the file: ${terminal.message}`);
  eq(calls.length, 0, 'no agent spawned');
}

// The 'required args throw rather than silently defaulting' section (runId, root, target.repo, units)
// moved to required-args.test.mjs, which sweeps the same keys across EVERY engine — the axis this defect
// class actually travels on.

section('a mis-copied verdict id is logged and recorded, not silently dropped from the index');
// The issue file still holds the finding, but the returned index and totals the operator triages from do not.
{
  const { out, logs } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness', title: 'A' }), finding({ category: 'security', title: 'B' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1'), keep('u-2')] },
  });
  ok(logs.some((l) => /⚠ u1: verifier verdicts do not cover the findings \(unmatched: u-2, no verdict: u1-2\) — the returned index and totals are incomplete; read E:\/r\/runs\/t\/issues\/u1\.md/.test(l)),
    'the gap is logged with both id lists and the issue file');
  eq(JSON.stringify(out.failed), JSON.stringify([{ unit: 'u1', stage: 'verify', unmatched: ['u-2'], unverdicted: ['u1-2'] }]), 'and recorded in failed');
  eq(out.unitsReviewed, 0, 'so the unit is not counted as fully reviewed');

  const { out: full } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1')] },
  });
  eq(JSON.stringify(full.failed), '[]', 'full coverage records nothing');
}

section('a clean reviewer that did not attest its marker is recorded in failed');
// Unrecorded, the unit counted as reviewed while a prior run's issue file stayed in issues/ as current.
{
  const { out } = await run({}, { 'review': NO_FINDINGS });
  eq(JSON.stringify(out.failed), JSON.stringify([{ unit: 'u1', stage: 'review', marker: false }]), 'the unattested marker is in failed');
  eq(out.unitsReviewed, 0, 'and the unit is not counted as reviewed');

  const { out: marked } = await run({}, { 'review': { wrote_clean_marker: true, findings: [] } });
  eq(JSON.stringify(marked.failed), '[]', 'an attested marker records nothing');
  eq(marked.unitsReviewed, 1, 'and counts the unit');
}
