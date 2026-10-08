// docs/docs-cycle.mjs — verbatim capture (gather) -> scrub -> curate.
// Focus: the SCRUBBER, the one auxiliary role whose death cannot stop the run and therefore has to be
// visible in the log instead. Everything else about this engine is held by tools/flows/docs.flow.mjs
// (its throw sites, both exits of the gap loop, a dead gatherer, a zero-file source).
import { runEngine, section, ok, eq } from './harness.mjs';

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
  const { logs, out } = await run({ 'gather': GATHER, 'scrub': null, 'curate': CURATE });
  ok(!logs.some((l) => /✓ scrubbed api-reference/.test(l)), 'no success line for a scrubber that never returned');
  const dead = logs.find((l) => /scrub:api-reference/.test(l) && /returned nothing/.test(l));
  ok(!!dead, `the death is logged and names the source: ${dead}`);
  ok(/skipped or died/.test(dead || ''), 'and says the agent skipped or died');
  ok(/NOT scrubbed/.test(dead || ''), 'and says what that costs the set');
  ok(out.scrubFailed.join() === 'api-reference', 'the death is recorded in the return');
  ok(/^WARN THE USER FIRST: these sources' files were NOT scrubbed, so nav chrome or ads may remain: api-reference\./.test(out.nextStep),
    `and nextStep warns before presenting the set: ${out.nextStep.slice(0, 120)}`);
}

section('a dead gatherer is logged as a death, never as "0 file(s)", and recorded in the return');
// The ✓ line printed before `g` was checked, so a death read exactly like a live gatherer that captured nothing.
{
  const { logs, out } = await run({ 'gather': null, 'scrub': { files_cleaned: 1 }, 'curate': CURATE });
  ok(!logs.some((l) => /✓ gathered/.test(l)), 'no success line for a gatherer that never returned');
  ok(logs.some((l) => /gather:api-reference returned nothing \(agent skipped or died\)/.test(l)), 'the death is logged and names the source');
  ok(out.gatherFailed.join() === 'api-reference', 'the death is recorded in the return');
  ok(/^WARN THE USER FIRST: these gatherers returned nothing, so coverage may be partial: api-reference\./.test(out.nextStep), 'and nextStep warns');
  ok(out.scrubFailed.length === 0, 'a live scrubber is not recorded');

  const healthy = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': CURATE });
  ok(healthy.out.gatherFailed.length === 0 && healthy.out.scrubFailed.length === 0, 'a healthy run records no death');
  ok(!/WARN THE USER FIRST: these/.test(healthy.out.nextStep), 'and its nextStep carries no death warning');
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
  // A relaunch into the same outDir starts at round 1 with the earlier run's flagged files on disk.
  ok(/If E:\/r\/runs\/t\/docs\/INDEX\.md already exists[^]*DELETE the superseded file/.test(prompt('curate:r1')),
    'the round-1 prompt carries the supersede rule, gated on the index already existing');
  ok(/by an earlier run into this folder/.test(r2), 'the ownership sentence counts an earlier run\'s captures as owned');
}

section('only a web source gets a scrubber');
// Repo and files captures are usually markdown already, so a scrubber there would find no HTML chrome to strip.
{
  const args = {
    ...baseArgs,
    target: { repo: 'E:/proj' },
    sources: [
      ...baseArgs.sources,
      { id: 'sdk-readme', kind: 'repo', focus: 'the SDK README and examples' },
      { id: 'local-notes', kind: 'files', focus: 'the vendored API spec under vendor/spec' },
    ],
  };
  const { labels, out } = await run({ 'gather': GATHER, 'scrub': null, 'curate': CURATE }, args);
  ok(labels.includes('scrub:api-reference'), 'the web source is scrubbed');
  ok(!labels.includes('scrub:sdk-readme'), 'the repo source spawns no scrubber');
  ok(!labels.includes('scrub:local-notes'), 'the files source spawns no scrubber');
  ok(out.scrubFailed.join() === 'api-reference', `scrubFailed can name only a web source: ${out.scrubFailed.join()}`);
}

section('the scrub prompt carries the verbatim rule and the write boundary, never the brief');
// The scrubber judges no relevance, so the brief (inline or a planPath file) is text it has no use for.
{
  const { prompt } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': CURATE });
  const scrub = prompt('scrub:api-reference');
  ok(!scrub.includes(baseArgs.brief) && !/PROJECT BRIEF/.test(scrub), 'the inline brief is not in the scrub prompt');
  ok(/VERBATIM RULE/.test(scrub), 'the verbatim rule is');
  ok(/Write ONLY inside E:\/r\/runs\/t\/docs/.test(scrub), 'and so is the write boundary');
  ok(prompt('gather:api-reference').includes(baseArgs.brief), 'the gatherer still reads the brief');

  const planned = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': CURATE },
    { ...baseArgs, brief: undefined, planPath: 'E:/r/brief.md' });
  ok(!planned.prompt('scrub:api-reference').includes('E:/r/brief.md'), 'a planPath brief is not in the scrub prompt either');
}

section('a gap-fill curator spot-checks only that round\'s captures, and the return sums every round');
// A later round re-reads the whole set, but re-sampling files an earlier round already checked spends the
// sample on old evidence. The return then has to add the rounds up, or one small gap-fill round would
// stand for the whole run's verbatim check.
{
  const RECAPTURE = { ...CURATE, fidelity_failures: 1, gaps: [{ kind: 'web', focus: 'recapture the webhooks page verbatim' }] };
  const { prompt, out } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': RECAPTURE, 'curate:r2': CURATE });
  const r2 = prompt('curate:r2');
  ok(r2.includes('E:/r/runs/t/docs/recapture-the-webhooks-page-verbatim/'), 'the round-2 prompt names the gap-fill capture directory');
  ok(/pick ONLY from the files this round's gatherers captured/.test(r2), 'and restricts the spot-check to this round\'s captures');
  ok(/Re-read the whole set/.test(r2), 'while still re-reading the whole set');
  ok(!/pick ONLY from the files this round's gatherers captured/.test(prompt('curate:r1')), 'the round-1 prompt samples the whole set');
  eq(out.fidelity.checked, 4, 'fidelity.checked sums both rounds');
  eq(out.fidelity.failures, 1, 'fidelity.failures sums both rounds');
  ok(/across all 2 curate round\(s\)/.test(out.nextStep), `nextStep says the counts cover every round: ${out.nextStep}`);
}

section('nextStep states the set\'s counts and leads with the foreign-content warning');
// nextStep is the only hand-back the guide relies on, so it carries the counts and puts every warning
// ahead of "Present the set", where an operator relaying it in order cannot bury one.
{
  const healthy = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': CURATE });
  ok(healthy.out.nextStep.includes('Present the set (6 file(s), 0 cross-source inconsistency(ies), 0 unresolved gap(s)): read E:/r/runs/t/docs/INDEX.md'),
    `a healthy nextStep names the counts: ${healthy.out.nextStep.slice(0, 160)}`);

  const FOREIGN = { ...CURATE, foreign_content: true, foreign_paths: ['E:/r/runs/t/docs/old-notes.md'] };
  const foreign = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': FOREIGN });
  ok(foreign.out.nextStep.startsWith('WARN THE USER FIRST: E:/r/runs/t/docs held 1 file(s)/folder(s)'),
    `the foreign-content warning opens nextStep: ${foreign.out.nextStep.slice(0, 120)}`);

  const deadScrub = await run({ 'gather': GATHER, 'scrub': null, 'curate': FOREIGN });
  const step = deadScrub.out.nextStep;
  ok(step.startsWith('WARN THE USER FIRST: these sources\' files were NOT scrubbed'), `the death warning still opens nextStep: ${step.slice(0, 120)}`);
  const foreignAt = step.indexOf('WARN THE USER FIRST: E:/r/runs/t/docs held');
  ok(foreignAt !== -1 && foreignAt < step.indexOf('Present the set'), 'and the foreign-content warning sits before "Present the set"');
}
