// migrate/migrate-cycle.mjs — the ordered section loop.
// Focus: the deliberate asymmetry with feature-cycle (a parked section STOPS the run, because section
// N+1 depends on N landing), the whole-goal sweep, and every haltKind → status mapping.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/migrate/migrate-cycle.mjs';

const SECTIONS = [{ id: 'sec-a', title: 'A' }, { id: 'sec-b', title: 'B' }];
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' },
  plan: '## Section: sec-a\nA\n## Section: sec-b\nB\n', sections: SECTIONS };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

const DEV       = { baseline_dirty_files: 0, produced: true, build_passed: true, test_outcome: 'passed', tests_run_count: 4, unstaged_confirmed: true, needs_user: false };
const CLEAN     = { clean: true, issue_count: 0 };
const ACC_PASS  = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 2, criteria_met: 2, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL  = { pass: false, staged: false, reachable: false, regression: false, criteria_total: 2, criteria_met: 0, evidence_recorded: true, gap_count: 2 };
const PARK_OK   = { saved: true, cleared: true, gates_green: true, patch_bytes: 512, strays_saved: 0 };
const SWEEP_OK  = { complete: true, gaps: [], suite_result: 'green' };
const GREEN_RUN = { 'develop': DEV, 'quality': CLEAN, 'acceptance': ACC_PASS, 'final-sweep': SWEEP_OK };

section('a section that never accepts is parked and the run STOPS');
// The asymmetry with feature-cycle: sections are an ordered decomposition of ONE goal, so sec-b would be
// built against a baseline sec-a never landed in. Park still runs — the work is saved, not discarded.
{
  const { out, labels } = await run({ 'develop': DEV, 'quality': CLEAN, 'acceptance': ACC_FAIL, 'park': PARK_OK });
  ok(labels.includes('park:sec-a'), 'sec-a was PARKED');
  ok(!labels.some((l) => l.includes('sec-b')), 'sec-b never started (feature-cycle would have continued)');
  ok(out.halted === true, 'the run halted');
  eq(out.status, 'halted (a section was parked — its work is saved to a patch; the sections after it were not attempted)', 'status');
  ok(/is SAVED to/.test(out.haltReason) && /tree is CLEAN/.test(out.haltReason), 'halt reason states saved + clean');
  ok(/parked-<id>\.patch, NOT in the tree/.test(out.followups), 'followups does not claim the tree holds the work');
  eq(out.parked.length, 1, 'one entry in parked[]');
  eq(out.parked[0].id, 'sec-a', 'sec-a is the parked section');
  ok(out.parked[0].patch?.endsWith('parked-sec-a.patch'), `patch path surfaced: ${out.parked[0].patch}`);
  ok(!labels.includes('final-sweep'), 'no whole-goal sweep on a halted run');
}

section('a park that leaves the BUILD red is unsafe, not a clean park');
// gates_green was `required` in PARK_SCHEMA, demanded by the park prompt and printed in the run log —
// and read by nothing, so a park that cleared the tree but left the build broken took the "tree is
// CLEAN; resume from this section" branch. The operator was told to resume into a red build. Both
// siblings halt on it (feature-cycle, resolve-cycle); this is the twin that was missing.
{
  const { out } = await run({
    'develop': DEV, 'quality': CLEAN, 'acceptance': ACC_FAIL,
    'park': { ...PARK_OK, gates_green: false },
  });
  eq(out.status, 'BLOCKED (a parked section left the tree unsafe — inspect before resuming)', 'status');
  ok(/BUILD is RED/.test(out.haltReason), `the reason names the red build: ${out.haltReason.slice(-90)}`);
  ok(!/tree is CLEAN; resolve with the user/.test(out.haltReason),
    'and does NOT also tell the operator the tree is fine to resume from');
  // The work still has to be recoverable — an unsafe tree must not cost the patch.
  ok(out.parked[0]?.patch?.endsWith('parked-sec-a.patch'), 'the patch is still surfaced');
}

section('a dirty baseline halts without parking');
{
  const { out, calls, labels } = await run({ 'develop': { ...DEV, baseline_dirty_files: 2 } });
  eq(calls.length, 1, 'only the developer ran — no reviewer spawned');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park the operator\'s work');
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'status');
  eq(out.parked.length, 0, 'nothing in parked[]');
}

section('a developer escalation parks first, then halts');
{
  const { out, labels } = await run({
    'develop': { ...DEV, needs_user: true },
    'park': { ...PARK_OK, patch_bytes: 99, strays_saved: 1 },
  });
  ok(labels.includes('park:sec-a'), 'PARK ran on the halt path');
  eq(out.status, 'BLOCKED (needs user input)', 'status');
  // parked[] is keyed on the PATCH, not the status prose — an escalated section keeps BLOCKED and would
  // otherwise have its patch path reported nowhere.
  eq(out.parked[0].status, 'BLOCKED (needs user)', 'the escalated section keeps its BLOCKED status');
  ok(out.parked[0].strays?.endsWith('-newfiles'), `strays dir surfaced: ${out.parked[0].strays}`);
}

section('every section accepting runs the whole-goal sweep');
{
  const { out, labels } = await run(GREEN_RUN);
  ok(!labels.some((l) => l.startsWith('park')), 'no park spawned');
  ok(out.halted === false, 'not halted');
  eq(labels.filter((l) => l === 'final-sweep').length, 1, 'exactly one sweep, after the last section');
  eq(out.status, 'done (all sections staged)', 'status');
  eq(out.sweep?.suite, 'green', 'the sweep result is surfaced');
  eq(out.sectionsDone.join(), 'sec-a,sec-b', 'both sections done');
}

section('a partial slice skips the sweep — it can only judge a whole goal');
{
  const { out, labels } = await run(GREEN_RUN, { ...baseArgs, runOnly: ['sec-a'] });
  ok(!labels.includes('final-sweep'), 'no sweep on a slice');
  ok(!labels.some((l) => l.includes('sec-b')), 'sec-b not run');
  eq(out.sweep, null, 'sweep is null, not a fabricated pass');
  eq(out.status, 'partial slice complete', 'status');
}

section('finalSweep:false opts out of the sweep on a full run');
{
  const { out, labels } = await run(GREEN_RUN, { ...baseArgs, finalSweep: false });
  ok(!labels.includes('final-sweep'), 'no sweep spawned');
  eq(out.status, 'done (all sections staged)', 'the run is still done');
}

section('a dead final sweep is reported as NOT RUN, never as zero gaps');
// `(sweep?.gaps || []).length` logged "0 potential gap(s) — see SWEEP.md" for a check that never ran and
// a file nothing wrote, and `sweep ? {…} : null` then made that indistinguishable from the two legitimate
// did-not-run cases above (partial slice, finalSweep:false). The sweep is not a gate — the migration is
// already staged — so it must NOT throw; it must say plainly that the completeness check is missing.
{
  const { out, logs } = await run({ ...GREEN_RUN, 'final-sweep': null });
  eq(out.sweepFailed, true, 'the return distinguishes a DIED sweep from one that never ran');
  eq(out.sweep, null, 'no fabricated sweep result');
  ok(!logs.some((l) => /0 potential gap/.test(l)), 'never logs a clean-looking gap count for a check that died');
  eq(out.status, 'done (all sections staged)', 'a dead sweep does not fail an otherwise complete run');
}

section('a dead plan critic throws — a review that never happened is not a clean plan');
// Twin of the same defect in feature-cycle: `verdict: critique?.verdict ?? 'ready'` made a dead critic
// byte-identical to a clean one (verdict "ready", 0 gaps, nextStep "Plan is sound"). Refine is the only
// gate on a plan before an autonomous developer builds against it, so laundering it did not degrade the
// review, it deleted it and reported success.
{
  const msg = await throwsWith(ENGINE, {
    args: { ...baseArgs, phase: 'refine' },
    respond: { 'plan-critic': null },
  });
  ok(/skipped or died/.test(msg), `dead plan critic throws instead of reporting ready: ${msg.slice(0, 60)}`);
}

section('acceptance that stages while reporting a regression halts without parking');
// The work is STAGED, so park must not touch it; the run stops before later sections build on a
// poisoned baseline.
{
  const { out, labels } = await run({ ...GREEN_RUN, 'acceptance': { ...ACC_PASS, regression: true } });
  ok(out.halted === true, 'halted');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park (the work is staged)');
  ok(!labels.some((l) => l.includes('sec-b')), 'sec-b never started on a poisoned baseline');
  eq(out.status, 'BLOCKED (a section staged while self-reporting a regression — inspect the staged diff before continuing)', 'status');
  eq(out.sectionsDone.join(), 'sec-a', 'the section itself still counts as done (staged)');
}

section('acceptance that stages while reporting unreachable is only flagged');
{
  const { out, labels } = await run({ ...GREEN_RUN, 'acceptance': { ...ACC_PASS, reachable: false } });
  ok(out.halted === false, 'did NOT halt — an unreachable section is bad but inert');
  ok(labels.some((l) => l.includes('sec-b')), 'the run continued');
  ok(out.ledger.every((r) => r.contradicted === true), 'every section flagged contradicted in the ledger');
}

section('acceptance that passed without staging halts without parking');
{
  const { out, labels } = await run({ ...GREEN_RUN, 'acceptance': { ...ACC_PASS, staged: false } });
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park good accepted work');
  eq(out.status, 'BLOCKED (a section passed but was not staged — stage it, then resume)', 'status');
}

section('a park that cannot clear the tree gets its own status, not the plain parked one');
{
  const { out } = await run({
    'develop': DEV, 'quality': CLEAN, 'acceptance': ACC_FAIL,
    'park': { ...PARK_OK, cleared: false },
  });
  eq(out.status, 'BLOCKED (a parked section left the tree unsafe — inspect before resuming)', 'status');
  ok(/could NOT be cleared/.test(out.haltReason), 'halt reason says the tree is dirty');
  ok(/it IS saved to/.test(out.haltReason), 'and that the work was still saved');
}

section('a self-contradictory park report keeps the patch and flags the tree unsafe');
// saved=false with bytes on disk: the report is wrong, the patch is real.
{
  const { out } = await run({
    'develop': DEV, 'quality': CLEAN, 'acceptance': ACC_FAIL,
    'park': { saved: false, cleared: true, gates_green: true, patch_bytes: 4096, strays_saved: 0 },
  });
  eq(out.status, 'BLOCKED (a parked section left the tree unsafe — inspect before resuming)', 'status');
  ok(/contradicts itself/.test(out.haltReason), 'halt reason says so');
  ok(out.parked[0].patch !== null, 'patch path surfaced, NOT reported as "nothing saved"');
}

section('the token budget stops cleanly between sections');
{
  const { out, calls } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(calls.length, 0, 'stopped before spawning anything');
  eq(out.status, 'stopped on token budget (resume where it left off)', 'status');
  ok(/startAt:"sec-a"/.test(out.haltReason), 'halt reason carries the resume point');
}

section('a developer that produced nothing skips the blind review, not acceptance');
// An empty diff has nothing to review, but only acceptance can tell a legitimate no-op section from one
// that should have changed files.
{
  const { out, labels } = await run({ ...GREEN_RUN, 'develop': { ...DEV, produced: false } });
  ok(!labels.some((l) => l.startsWith('quality')), 'no blind reviewer for an empty diff');
  eq(labels.filter((l) => l.startsWith('acceptance')).length, 2, 'acceptance still judged both sections');
  eq(out.status, 'done (all sections staged)', 'a genuine no-op section can still pass');
}

section('a section id matching nothing throws instead of running a smaller list');
{
  for (const scope of [{ runOnly: ['nope'] }, { startAt: 'nope' }]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, ...scope } });
    ok(/nope/.test(msg) && /sec-a, sec-b/.test(msg),
      `${Object.keys(scope)[0]} "nope" throws and lists the valid ids: ${msg.slice(0, 60)}`);
  }
}

section('required args throw rather than silently defaulting');
{
  const cases = [
    ['target.repo', { ...baseArgs, target: {} }],
    ['gates.build', { ...baseArgs, gates: { test: 't' } }],
    // gates.test is only required when a section actually asks for verification.
    ['gates.test with a green section', { ...baseArgs, gates: { build: 'b' } }],
    ['root', { ...baseArgs, root: undefined }],
    ['plan', { ...baseArgs, plan: undefined }],
    ['sections', { ...baseArgs, sections: [] }],
  ];
  for (const [name, args] of cases) {
    const msg = await throwsWith(ENGINE, { args });
    ok(msg !== '', `missing ${name} throws: ${msg.slice(0, 50)}`);
  }
}

section('park never names a review file that was never written');
// Same contract as feature-cycle's: with the gate never green neither reviewer runs, so the park entry
// in NEEDS-USER.md must not name an acceptance-review file that was never written.
{
  const { prompt } = await run({
    'develop': { ...DEV, build_passed: false },   // gate never green -> no reviewer ever runs
    'park': { saved: true, cleared: true, gates_green: true, patch_bytes: 512, strays_saved: 0 },
  });
  const p = prompt('park:sec-a');
  ok(p !== '', 'park still ran');
  ok(!/acceptance-review-sec-a-r\d+\.md/.test(p), 'no fabricated acceptance-review path in the prompt');
  ok(/produced NO review file/.test(p), 'the prompt says outright that no review file exists');
}
