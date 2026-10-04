// enhance/enhance-cycle.mjs — the read-only lensed fan-out.
// Focus: the dead-agent paths. Both roles are inside a pipeline, so a dead one resolves to null rather
// than throwing, and the only thing standing between that and a lens reported as cleanly audited is an
// explicit guard per stage (tests/CLAUDE.md §3). `failed` is the operator's one signal that a lens
// produced nothing because nobody looked — assert it for BOTH stages, or the guards drift apart.
import { runEngine, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/enhance/enhance-cycle.mjs';
const baseArgs = {
  runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  scope: ['workflows/'], lenses: ['efficiency', 'simplification'],
};
const CANDIDATE = {
  title: 'fold the two verifier roles into one', category: 'simplification',
  impact: 'high', effort: 'small', files: ['workflows/enhance/enhance-cycle.mjs:330'],
  today: 'each lens spawns its own verifier', instead: 'one verifier reads every lens',
  cost_removed: 'one agent per lens',
};
const FOUND = { wrote_clean_marker: false, candidates: [CANDIDATE] };
const VERIFIED = { wrote_file: true, verdicts: [] };

section('a dead verifier lands its lens in failed, never in the audited count');
// The bug this pins: the stage returned its result object anyway, so `live` kept the lens, `failed` stayed
// empty, and `lenses[]` reported a proposals/<lens>.md path the dead verifier never wrote — a lens the
// operator would read as clean. Only the ⚠ in the log said otherwise.
{
  const { out, logs } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: {
      find: FOUND,
      'verify:efficiency': null,          // longest matching prefix wins over 'verify'
      verify: VERIFIED,
    },
  });
  eq(out.failed.join(), 'efficiency', 'the dead verifier\'s lens is reported failed');
  ok(!out.lenses.some((l) => l.lens === 'efficiency'), 'and no proposal-file path is reported for it');
  eq(out.summary.lenses, 1, 'only the verified lens counts as audited');
  ok(out.lenses.some((l) => l.lens === 'simplification' && /simplification\.md$/.test(l.file)),
    'the live lens is unaffected');
  ok(logs.some((l) => /efficiency: the verifier DIED/.test(l)), 'the log names the lens that must be re-run');
  ok(/TELL THE USER these lenses were NOT audited and have no proposal file: efficiency/.test(out.nextStep), 'and nextStep names it');
}

section('a dead finder does the same — the two guards stay symmetric');
{
  const { out } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { 'find:efficiency': null, find: FOUND, verify: VERIFIED },
  });
  eq(out.failed.join(), 'efficiency', 'the dead finder\'s lens is reported failed');
  eq(out.summary.lenses, 1, 'and is not counted as audited');
}

section('a candidate the verifier judges too risky is rejected, counted, and kept out of the proposals');
// The operator's one filter for "this would regress something the workflow needs" is this count and the
// rejection line in the lens file. A too_risky verdict routed anywhere but REJECT would reach triage.
{
  const verdict = (id, extra) => ({ candidate_id: id, is_real: true, impact: 'high', effort: 'small', decision: 'REJECT', ...extra });
  const { out } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: {
      find: { wrote_clean_marker: false, candidates: [CANDIDATE, { ...CANDIDATE, title: 'second' }] },
      verify: (label) => ({ wrote_file: true, verdicts: [
        verdict(`${label.replace(/^verify:/, '')}-1`, { too_risky: true }),
        verdict(`${label.replace(/^verify:/, '')}-2`, { decision: 'ADOPT' }),
      ] }),
    },
  });
  eq(out.summary.tooRisky, 1, 'the summary counts it');
  eq(out.lenses[0]?.kept.length, 1, 'and only the safe candidate is kept');
  ok(!out.lenses[0]?.kept.some((k) => k.id.endsWith('-1')), 'the risky one is not among them');
}

section('a verifier that does not attest its proposal file lands its lens in failed');
// The path it would have reported names a file nobody attested writing (#15).
{
  const { out, logs } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { find: FOUND, 'verify:efficiency': { wrote_file: false, verdicts: [] }, verify: VERIFIED },
  });
  eq(out.failed.join(), 'efficiency', 'the unattested lens is reported failed');
  ok(!out.lenses.some((l) => l.lens === 'efficiency'), 'and no proposal-file path is reported for it');
  eq(out.summary.lenses, 1, 'only the attested lens counts as audited');
  ok(logs.some((l) => /efficiency: the verifier did NOT confirm writing .*efficiency\.md — this lens was NOT verified\. Re-run it\./.test(l)),
    'the log says why and what to do');
}

section('a lens whose every candidate sat below the floor reports no proposal path');
// The finder writes no marker when it reports a candidate, and the cut leaves verify nothing, so no file exists.
{
  const { out, logs } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: { wrote_clean_marker: false, candidates: [{ ...CANDIDATE, impact: 'marginal' }] } },
  });
  eq(out.lenses[0].file, null, 'no path names a file nobody wrote');
  eq(out.summary.belowFloor, 1, 'the cut is counted');
  eq(out.failed.length, 0, 'and the lens is not a failure');
  ok(logs.some((l) => /all 1 candidate\(s\) sat below the moderate floor, so no .*efficiency\.md was written — re-run with a lower minImpact to see them/.test(l)),
    'the log points at the knob, not at a re-run that cannot help');
}

section('a submitted candidate with no verdict is counted and named, never silently dropped');
{
  const { out, logs } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: {
      find: { wrote_clean_marker: false, candidates: [CANDIDATE, { ...CANDIDATE, title: 'second' }] },
      verify: { wrote_file: true, verdicts: [{ candidate_id: 'efficiency-1', is_real: true, impact: 'high', effort: 'small', decision: 'ADOPT' }] },
    },
  });
  eq(out.lenses[0].counts.unjudged, 1, 'the lens counts the unjudged candidate');
  eq(out.summary.unjudged, 1, 'and so does the summary');
  ok(logs.some((l) => /efficiency: the verifier returned no verdict for efficiency-2 — they are in no count/.test(l)), 'the log names it');
}

section('a run where every lens failed says NOTHING was audited, never presents proposals');
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { find: null } });
  eq(out.failed.join(), 'efficiency,simplification', 'every lens failed');
  ok(/^NOTHING was audited: every lens failed \(efficiency, simplification\)/.test(out.nextStep), 'nextStep says nothing was audited');
  ok(!/PRESENT them/.test(out.nextStep), 'and never says to present proposals');
}
