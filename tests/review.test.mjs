// debug/review.mjs — the read-only fan-out that builds the inventory.
// Focus: the lens ARRAY (several angles over the same files, one issue file, one verifier) and the
// returned issues[] index, which is the contract resolve-cycle's args.issues is built from.
import { runEngine, section, ok, eq } from './harness.mjs';

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

section('dedup is per lens, so two lenses may both report the same file+category');
// Within one lens, file:category is the right key — a re-phrased concern would slip past a title-based
// one. Across lenses it must NOT collapse: two briefs can find two different real defects in the same
// file and category, and folding true overlap is the verifier's job, not the harness's.
{
  const dupes = { wrote_clean_marker: false, findings: [finding({ category: 'data-loss', title: 'A' }), finding({ category: 'data-loss', title: 'B' })] };
  const { out } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, {
    'review': dupes,
    'verify': { wrote_file: true, verdicts: [keep('u1-1'), keep('u1-2')] },
  });
  eq(out.inventory.total, 2, 'one kept per lens; the intra-lens duplicate dropped');
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
  const { out, calls, logs } = await run({ units: [{ ...UNIT, lens: [DESTRUCT, FLOW] }] }, {
    'review:u1/destructive': null,                                  // dead agent
    'review:u1/control-flow': { wrote_clean_marker: false, findings: [finding({ category: 'control-flow', title: 'T2' })] },
    'verify': { wrote_file: true, verdicts: [keep('u1-1')] },
  });
  const text = logs.join('\n');
  ok(/⚠ u1\/destructive: reviewer returned nothing/.test(text), `the dead lens is named: ${text}`);
  ok(text.includes('contributed NO coverage'), 'and the log says the coverage is missing, not clean');
  eq(calls.length, 3, 'the surviving lens still verifies — the unit is not dropped');
  eq(out.inventory.total, 1, 'only the live lens\'s finding is in the inventory');
}

section('a dead SOLE reviewer is not reported as a clean unit');
// The items.length === 0 path prints "clean but the reviewer did NOT write …", which misdiagnoses a
// dead agent as a clean unit that merely lost its marker.
{
  const { calls, logs } = await run({ lens: DESTRUCT }, { 'review': null });
  eq(calls.length, 1, 'no verifier — there are no findings to verify');
  ok(/⚠ u1: reviewer returned nothing/.test(logs.join('\n')), 'the death is logged before the clean-unit line');
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
// builds resolve-cycle's args.issues from. Nothing downstream can notice: those issues never enter a
// batch, so resolve's issue_entries_found precondition never fires.
{
  const { out, logs } = await run({}, {
    'review': { wrote_clean_marker: false, findings: [finding({ category: 'correctness', title: 'A' }), finding({ category: 'security', title: 'B' })] },
    'verify': null,
  });
  const text = logs.join('\n');
  ok(/⚠ u1: verifier did NOT confirm writing/.test(text), 'the dead verifier is named');
  ok(text.includes('agent returned nothing — its 2 finding(s) were DROPPED'), `the drop count is stated: ${text}`);
  eq(out.inventory.total, 0, 'the return shape is unchanged — this guard is log-only');
}

section('the returned issues[] is resolve-cycle\'s args.issues shape');
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
  ok(missing.length === 0, `carries every field resolve-cycle requires${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
  eq(got.line, '10-20', 'the line RANGE stayed a string');
  eq(got.severity, 'medium', 'severity is the VERIFIER\'s, not the reviewer\'s');
  eq(got.effort, 'trivial', 'effort comes from the verifier\'s matrix');
  eq(got.loc, 10, 'loc is joined from the unit\'s file list');
  eq(out.inventory.actionable, 1, 'counted actionable');
}

// The 'required args throw rather than silently defaulting' section (runId, root, target.repo, units)
// moved to required-args.test.mjs, which sweeps the same keys across EVERY engine — the axis this defect
// class actually travels on.
