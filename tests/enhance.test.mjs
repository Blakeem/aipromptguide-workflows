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
