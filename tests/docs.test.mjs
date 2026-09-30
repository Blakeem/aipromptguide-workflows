// docs/docs-cycle.mjs — verbatim capture (gather) -> scrub -> curate.
// Focus: the SCRUBBER, the one auxiliary role whose death cannot stop the run and therefore has to be
// visible in the log instead. Everything else about this engine is held by tools/flows/docs.flow.mjs
// (its throw sites, both exits of the gap loop, a dead gatherer, a zero-file source).
import { runEngine, section, ok } from './harness.mjs';

const ENGINE = 'workflows/docs/docs-cycle.mjs';

const baseArgs = {
  runId: 't',
  root: 'E:/r',
  brief: 'Integrate the payments API v2: auth, webhooks, error codes.',
  sources: [{ id: 'api-reference', kind: 'web', focus: 'the official payments API reference (v2)' }],
};
const run = (respond, args = baseArgs) => runEngine(ENGINE, { args, respond });

const GATHER = { files_written: 6, skipped: 0 };
const CURATE = {
  wrote_index: true, files: 6, deleted: 0, inconsistencies: 0,
  fidelity_checked: 2, fidelity_failures: 0, foreign_content: false, foreign_paths: [], gaps: [],
};

section('a dead scrubber is logged as a death, never as "0 file(s)"');
// `s?.files_cleaned ?? 0` collapsed the dead scrubber onto the same line as one that found nothing to
// clean — `✓ scrubbed <id>: 0 file(s)`, byte-identical — and no scrub field reaches the return, so the
// death was recorded NOWHERE. The captured files then ship with whatever nav chrome and ads the capture
// picked up, under a checkmark (WORKFLOW-PRINCIPLES.md #15: an auxiliary death is logged + recorded).
{
  const { logs } = await run({ 'gather': GATHER, 'scrub': null, 'curate': CURATE });
  ok(!logs.some((l) => /✓ scrubbed api-reference/.test(l)), 'no success line for a scrubber that never returned');
  const dead = logs.find((l) => /scrub:api-reference/.test(l) && /returned nothing/.test(l));
  ok(!!dead, `the death is logged and names the source: ${dead}`);
  ok(/skipped or died/.test(dead || ''), 'and says the agent skipped or died');
  ok(/NOT scrubbed/.test(dead || ''), 'and says what that costs the set');
}

section('a scrubber that legitimately cleaned nothing still reads as a success');
// The other half of the collision. Zero cleaned files is a normal outcome for an already-clean capture,
// and reporting it as a death would send the operator hunting a failure that never happened.
{
  const { logs } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 0 }, 'curate': CURATE });
  ok(logs.some((l) => /✓ scrubbed api-reference: 0 file\(s\)/.test(l)), 'the zero-file success line survives');
  ok(!logs.some((l) => /returned nothing/.test(l)), 'and nothing claims the agent died');
}

section('a dead scrubber does not stop the run — its source is still curated');
// The death policy is log + record, NOT halt: what the gatherer wrote is already on disk, and the
// curator is the only role that indexes it.
{
  const { labels, out } = await run({ 'gather': GATHER, 'scrub': null, 'curate': CURATE });
  ok(labels.includes('curate:r1'), 'the curator still ran');
  ok(out.indexWritten === true, 'and the set was indexed');
}

section('the round-2 curator deletes a file its recapture superseded');
// A recapture gap gets a new source id, so its gatherer writes into a new directory beside the flagged
// file. The two are not exact duplicates, so without this instruction the round-2 curator keeps both.
{
  const RECAPTURE = {
    ...CURATE, fidelity_failures: 1,
    gaps: [{ kind: 'web', focus: 'recapture the webhooks page verbatim' }],
  };
  const { labels, prompt } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': RECAPTURE, 'curate:r2': CURATE });
  const r2 = prompt('curate:r2');
  ok(labels.includes('curate:r2'), 'the recapture gap drives a second curate round');
  ok(r2.includes('READ the previous E:/r/runs/t/docs/INDEX.md'), 'the round-2 prompt names the previous index to read');
  ok(/DELETE the superseded file and drop it from the index/.test(r2), 'and tells the curator to delete the superseded file');
  ok(!/superseded/.test(prompt('curate:r1')), 'the round-1 prompt carries no supersede rule');
}
