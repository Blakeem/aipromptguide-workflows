// debug/resolve-cycle.mjs — the batched fix loop.
// Focus: the paths that only fire when something goes WRONG. Those are the ones a real run rarely
// exercises and the ones where a regression is silent.
import { runEngine, section, ok } from './harness.mjs';

const ENGINE = 'workflows/debug/resolve-cycle.mjs';

const baseArgs = {
  runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  gates: { build: 'b', test: 't' }, conventions: 'c',
  issues: [{ id: 'i1', unit: 'u1', file: 'src/a.js', line: '1', loc: 10, severity: 'high', category: 'correctness', decision: 'ACTIONABLE', effort: 'small', title: 'T', theme: 'x' }],
};
const run = (respond, args = baseArgs) => runEngine(ENGINE, { args, respond });

// A fixer return with every attestation the engine now checks.
const GREEN = { build_passed: true, test_outcome: 'passed', unstaged_confirmed: true, needs_user: false, baseline_dirty_files: 0, issue_entries_found: 1, plan_amendments: 0 };
const FIXED = { ...GREEN, results: [{ issue_id: 'i1', status: 'FIXED' }] };
const CLEAN = { clean: true, issue_count: 0 };
const PARK_OK = { saved: true, cleared: true, gates_green: true, patch_bytes: 900, strays_saved: 0 };

section('round 2 returning no results must NOT take the round-1 shortcut');
// The working tree is CUMULATIVE. From round 2 a fixer can legitimately return results:[] having
// resolved a blind-review finding with no issue id in this batch. Taking the shortcut there would break
// out past quality, acceptance AND park, stranding round 1's real edits unstaged and unrecorded.
{
  const { out, labels } = await run({
    'fix': (l) => (l.endsWith('r1') ? FIXED : { ...GREEN, results: [] }),
    'quality': (l) => (l.endsWith('r1') ? { clean: false, issue_count: 1 } : CLEAN),
    'accept': { pass: false, gap_count: 1, fix_checks: [] },
    'park': PARK_OK,
  });
  ok(labels.some((l) => l.startsWith('accept')), 'acceptance still ran in round 2');
  ok(labels.some((l) => l.startsWith('park')), 'PARK ran — the tree is cleared, not stranded');
  ok(out.summary.batchesParked === 1, 'reported parked, not "no-changes"');
  ok(out.parked[0]?.patch?.endsWith('.patch'), `patch path surfaced: ${out.parked[0]?.patch}`);
}

section('round 1 all-stale still short-circuits (the shortcut is not gone, just narrowed)');
{
  const { out, calls } = await run({ 'fix': { ...GREEN, results: [{ issue_id: 'i1', status: 'STALE' }] } });
  ok(calls.length === 1, 'only the fixer ran — no quality/acceptance/park');
  ok(out.ledger[0].status === 'all-stale', 'status = all-stale');
  ok(out.summary.issuesStale === 1, 'issue counted stale');
}

section('precondition: dirty baseline halts before any reviewer spawns');
{
  const { out, calls } = await run({ 'fix': { ...GREEN, baseline_dirty_files: 3, results: [] } });
  ok(calls.length === 1, 'halted after the fixer, nothing else spawned');
  ok(out.halted === true, 'run halted');
  ok(/3 file\(s\) already modified/.test(out.blockerReason), 'blocker names the count');
  ok(/add -A/.test(out.blockerReason) && /stash/.test(out.blockerReason), 'blocker gives both remedies');
  ok(!calls.some((c) => c.label.startsWith('park')), 'did NOT park — that work is the operator\'s');
}

section('precondition: an unreadable inventory halts instead of reporting false success');
{
  const { out, calls } = await run({ 'fix': { ...GREEN, issue_entries_found: 0, results: [{ issue_id: 'i1', status: 'STALE' }] } });
  ok(out.halted === true, 'halted rather than reporting every issue stale');
  ok(/could not find ANY/.test(out.blockerReason), 'blocker explains it');
  ok(/runId="t"/.test(out.blockerReason), 'blocker names the runId that produced the paths');
  ok(!calls.some((c) => c.label.startsWith('park')), 'did not park');
  ok(out.summary.batchesAccepted === 0, 'NOT counted as accepted');
}

section('a fixer escalation parks its work before halting');
{
  const { out, calls } = await run({
    'fix': { ...GREEN, needs_user: true, results: [{ issue_id: 'i1', status: 'FIXED' }] },
    'park': { ...PARK_OK, patch_bytes: 1200, strays_saved: 2 },
  });
  ok(calls.some((c) => c.label.startsWith('park')), 'PARK ran on the halt path');
  ok(out.halted === true, 'still halts the run');
  ok(out.parked.length === 1, 'escalated batch appears in parked[]');
  ok(out.parked[0].strays?.endsWith('-newfiles'), `strays dir surfaced: ${out.parked[0].strays}`);
  ok(/the tree is clean/.test(out.followups), 'followups tells the operator the tree is clean');
}

section('a self-contradictory park report halts and still surfaces the patch');
// saved=false but bytes on disk: the report is wrong, the patch is real. Never tell the user nothing
// was saved when 4KB exists.
{
  const { out } = await run({
    'fix': FIXED, 'quality': CLEAN,
    'accept': { pass: false, gap_count: 1, fix_checks: [] },
    'park': { saved: false, cleared: true, gates_green: true, patch_bytes: 4096, strays_saved: 0 },
  });
  ok(out.halted === true, 'halted for a human to look');
  ok(/contradicts itself/.test(out.blockerReason), 'blocker says so');
  ok(out.parked[0].patch !== null, 'patch path surfaced, NOT reported as "nothing saved"');
}

section('the final sweep is gone and its one real check moved to followups');
{
  const { out, calls } = await run({
    'fix': FIXED, 'quality': CLEAN,
    'accept': { pass: true, staged: true, suite_result: 'green', fix_checks: [] },
  });
  ok(!calls.some((c) => c.label.includes('sweep')), 'no sweep agent spawned');
  ok(!('sweep' in out), 'no sweep field in the return');
  ok(/status --porcelain/.test(out.followups), 'followups carries the unstaged check the sweep did');
  ok(out.summary.issuesFixed === 1 && out.ledger[0].status === 'accepted', 'accounting intact');
}

section('a fixer that never attests unstaged_confirmed halts, and must NOT park');
// Park may not touch the staged index, and clearing only the unstaged half leaves a worse state to
// inspect — so this halt skips Park deliberately.
{
  const { out, calls } = await run({
    'fix': { build_passed: true, test_outcome: 'passed', needs_user: false, baseline_dirty_files: 0, issue_entries_found: 1, results: [{ issue_id: 'i1', status: 'FIXED' }] },
    'quality': CLEAN,
  });
  ok(out.halted === true, 'halted');
  ok(!calls.some((c) => c.label.startsWith('park')), 'did NOT park (staged index must not be touched)');
  ok(/unstaged/i.test(out.blockerReason), `blocker names the unstaged contract: ${out.blockerReason.slice(0, 55)}`);
  ok(!calls.some((c) => c.label.startsWith('accept')), 'never reached acceptance');
}

section('a DEAD round-1 fixer halts instead of being laundered into "not applicable"');
// -1 is the round-2+ sentinel. A null return must not collapse into it and skip both preconditions.
{
  const { out, calls } = await run({ 'fix': null });
  ok(out.halted === true, 'halted');
  ok(!calls.some((c) => c.label.startsWith('quality') || c.label.startsWith('park')), 'nothing else spawned');
  ok(calls.length === 1, 'only the dead fix call was made');
  ok(/return|nothing/i.test(out.blockerReason), `blocker says the fixer returned nothing: ${out.blockerReason.slice(0, 55)}`);
}

section('a DEAD round-2 fixer is named as agent failure, not as a red gate');
// Rounds 2+ have no halt, so the death fell through to gateOk(null) === false and the run reported
// `gate not green (build=undefined, test=undefined)` — a build failure that never happened, which is the
// cause the operator then debugs against.
{
  const { logs } = await run({
    'fix': (l) => (l.endsWith('r1') ? FIXED : null),
    'quality': (l) => (l.endsWith('r1') ? { clean: false, issue_count: 1 } : CLEAN),
    'park': PARK_OK,
  });
  const text = logs.join('\n');
  ok(/⚠ .* r2: fixer returned nothing/.test(text), `the dead round-2 fixer is named: ${text}`);
  ok(text.includes('NOT a red gate'), 'and the log denies the gate diagnosis the next line implies');
}

section('a DEAD quality reviewer is named and does not send the next fixer to a file nobody wrote');
// `quality?.clean !== true` is true for a dead agent too, so it read as "blind review found ? issue(s)"
// and reviewPath was set to a qualityFile() the dead agent never wrote — which fixPrompt then orders the
// next round's fixer to READ.
{
  const { logs, byLabel } = await run({
    'fix': (l) => (l.endsWith('r1') ? FIXED : { ...GREEN, results: [] }),
    'quality': (l) => (l.endsWith('r1') ? null : CLEAN),
    'accept': { pass: true, staged: true },
  });
  const text = logs.join('\n');
  ok(/⚠ .* r1: blind quality reviewer returned nothing/.test(text), `the dead reviewer is named: ${text}`);
  ok(text.includes('quality-review-'), 'the log names the file that was NOT written');
  const r2 = byLabel('fix')[1];
  ok(r2 && !r2.prompt.includes('quality-review-'), 'the round-2 fixer is NOT pointed at the nonexistent review file');
}

section('a DEAD acceptance verifier is named — 0 gaps means UNVERIFIED, not near-pass');
// `acc?.gap_count ?? bad.length` printed `0 gap(s)`, and reviewPath cited an acceptanceFile() that was
// never written.
{
  const { logs, byLabel } = await run({
    'fix': (l) => (l.endsWith('r1') ? FIXED : { ...GREEN, results: [] }),
    'quality': CLEAN,
    'accept': (l) => (l.endsWith('r1') ? null : { pass: true, staged: true }),
  });
  const text = logs.join('\n');
  ok(/⚠ .* r1: acceptance verifier returned nothing/.test(text), `the dead verifier is named: ${text}`);
  ok(text.includes('UNVERIFIED, not near-pass'), 'the 0-gap line is explicitly contradicted');
  const r2 = byLabel('fix')[1];
  ok(r2 && !r2.prompt.includes('acceptance-review-'), 'the round-2 fixer is NOT pointed at the nonexistent review file');
}

section('MATRIX case 6 is SPLIT: 6a fixes a VERIFIED defect in the issue\'s Fix, 6b keeps the old drop');
// The same wedge as the two build-loop siblings (§1), against a prescribed **Fix:** instead of a plan
// clause: it routed to case 6 (DROP — LOG), the reviewer re-raised it, and the round budget burned.
{
  const { prompt } = await run({ 'fix': FIXED, 'quality': CLEAN, 'accept': { pass: true, staged: true, fix_checks: [] } });
  const fix = prompt('fix:');
  ok(/6a\. Conflicts with the issue AND you VERIFIED/.test(fix), '6a exists and is gated on verification');
  ok(/the verified defect outranks the\s+prescription/.test(fix), 'and says the verified defect outranks the prescription');
  ok(/that verified defect also outranks the "NO scope creep beyond\s+what each fix requires" instruction above and the CONVENTIONS rubric/.test(fix),
    'the PRECEDENCE clause names both lines that produced the observed wedge');
  ok(/6b\. Conflicts with the issue but you did NOT verify it/.test(fix), '6b keeps the unverified/intentional case a DROP');
  ok(/DROP \(1 or 6b\): append ONE terse line to E:\/r\/runs\/t\/DISMISSED-batch-01-src\.md/.test(fix),
    'and LOGGING re-points the DROP route at 6b, not the whole of 6');
  ok(/7\. A genuine DESIGN\/BUSINESS choice only the USER can make/.test(fix), 'ESCALATE (case 7) is untouched');

  ok(/AMEND \(6a\): append ONE entry to E:\/r\/runs\/t\/AMENDED-batch-01-src\.md/.test(fix), 'the record is the per-BATCH AMENDED file');
  ok(/## Issue amendment: batch-01-src r1/.test(fix), 'the entry heading uses THIS engine\'s idiom and carries the round');
  ok(/ONE POINTER line to E:\/r\/runs\/t\/NEEDS-USER\.md/.test(fix) && /NO issue text/.test(fix),
    'NEEDS-USER gets a pointer line only — no issue text travels with it');

  const q = prompt('quality:');
  ok(q !== '' && !/AMENDED/.test(q) && !/amendment/i.test(q), 'the BLIND quality prompt gains no AMENDED path and no mention of one');
  ok(/DISMISSED-batch-01-src\.md/.test(q), 'while settled() still hands it the DISMISSED ledger — unchanged');

  const a = prompt('accept:');
  ok(/READ E:\/r\/runs\/t\/AMENDED-batch-01-src\.md if it exists/.test(a), 'acceptance is told to read the record');
  ok(/against the AMENDED behavior, not the superseded instruction/.test(a), 'and to judge the amended issue against what was built');
  ok(/NAME\s+every issue you judged under an amendment in your review file/.test(a), 'each such issue must be named in the review file');
  ok(/states NO defect\s+evidence excuses NOTHING/.test(a) && /stays actually_fixed=false/.test(a),
    'an evidence-free amendment excuses nothing — the escape hatch is not a free pass');
}

section('a recorded amendment is logged, counted into the ledger and named in followups; zero is silent');
{
  const ACC = { pass: true, staged: true, fix_checks: [] };
  const one = await run({ 'fix': { ...FIXED, plan_amendments: 2 }, 'quality': CLEAN, 'accept': ACC });
  ok(one.logs.some((l) => /⚠ batch-01-src r1: 2 plan amendment\(s\) recorded — see E:\/r\/runs\/t\/AMENDED-batch-01-src\.md/.test(l)),
    `the amendment is logged with the file that holds it: ${one.logs.find((l) => /amendment/.test(l))}`);
  ok(one.out.ledger[0].planAmendments === 2, 'accumulated into the batch\'s ledger record');
  ok(/FIX INSTRUCTION AMENDED for: batch-01-src/.test(one.out.followups), 'and followups names every amended batch');

  const none = await run({ 'fix': { ...FIXED, plan_amendments: 0 }, 'quality': CLEAN, 'accept': ACC });
  ok(!none.logs.some((l) => /plan amendment\(s\) recorded/.test(l)), 'a zero report logs nothing at all');
  ok(none.out.ledger[0].planAmendments === 0, 'the ledger record still carries the field, initialized in its literal');
  ok(!/AMENDED for/.test(none.out.followups), 'and followups says nothing about amendments');
}

// The 'required args throw rather than silently defaulting' section (target.repo, gates.build,
// gates.test, root, issues) moved to required-args.test.mjs, which sweeps the same keys across EVERY
// engine — the axis this defect class actually travels on.
