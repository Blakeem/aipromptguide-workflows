// docs/docs-cycle.mjs — verbatim capture (gather) -> scrub -> curate.
// Focus: the SCRUBBER, the one auxiliary role whose death cannot stop the run and therefore has to be
// visible in the log instead. Everything else about this engine is held by tools/flows/docs.flow.mjs
// (its throw sites, both exits of the gap loop, a dead gatherer, a zero-file source).
import { runEngine, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes } from './role-map-pin.mjs';

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
  ok(JSON.stringify(out.failed) === JSON.stringify([{ id: 'api-reference', stage: 'scrub' }]), `the death is recorded in the return: ${JSON.stringify(out.failed)}`);
  ok(/^WARN THE USER FIRST: these sources' files were NOT scrubbed, so nav chrome or ads may remain: api-reference\./.test(out.nextStep),
    `and nextStep warns before presenting the set: ${out.nextStep.slice(0, 120)}`);
}

section('a dead gatherer is logged as a death, never as "0 file(s)", and recorded in the return');
// The ✓ line printed before `g` was checked, so a death read exactly like a live gatherer that captured nothing.
{
  const { logs, out } = await run({ 'gather': null, 'scrub': { files_cleaned: 1 }, 'curate': CURATE });
  ok(!logs.some((l) => /✓ gathered/.test(l)), 'no success line for a gatherer that never returned');
  ok(logs.some((l) => /gather:api-reference returned nothing \(agent skipped or died\)/.test(l)), 'the death is logged and names the source');
  ok(JSON.stringify(out.failed) === JSON.stringify([{ id: 'api-reference', stage: 'gather' }]), `the death is recorded in the return, and the live scrubber is not: ${JSON.stringify(out.failed)}`);
  ok(/^WARN THE USER FIRST: these gatherers returned nothing, so coverage may be partial: api-reference\./.test(out.nextStep), 'and nextStep warns');

  const healthy = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': CURATE });
  ok(Array.isArray(healthy.out.failed) && healthy.out.failed.length === 0, 'a healthy run records no death');
  ok(!('phase' in healthy.out), 'the return carries no phase');
  ok(!/WARN THE USER FIRST: these/.test(healthy.out.nextStep), 'and its nextStep carries no death warning');
}

section('a web source whose gatherer and scrubber both die holds one failed entry per stage');
// The scrubber runs after a dead gatherer, so one source can lose both agents, and the operator needs
// both costs: partial coverage and unscrubbed files.
{
  const { out } = await run({ 'gather': null, 'scrub': null, 'curate': CURATE });
  ok(JSON.stringify(out.failed) === JSON.stringify([{ id: 'api-reference', stage: 'gather' }, { id: 'api-reference', stage: 'scrub' }]),
    `failed holds the gather entry, then the scrub entry: ${JSON.stringify(out.failed)}`);
  ok(/^WARN THE USER FIRST: these gatherers returned nothing, so coverage may be partial: api-reference\. these sources' files were NOT scrubbed, so nav chrome or ads may remain: api-reference\./.test(out.nextStep),
    `nextStep opens with both warnings: ${out.nextStep.slice(0, 200)}`);
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
    gaps: [{ kind: 'web', id: 'gap-r1-1' }],
  };
  const { labels, prompt } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': RECAPTURE, 'curate:r2': CURATE });
  const r2 = prompt('curate:r2');
  ok(labels.includes('curate:r2'), 'the recapture gap drives a second curate round');
  ok(r2.includes('READ the previous E:/r/runs/t/docs/INDEX.md'), 'the round-2 prompt names the previous index to read');
  ok(/A recapture that matches: DELETE the superseded\s+file and drop it from the index/.test(r2), 'and tells the curator to delete the superseded file once its recapture matches');
  // A relaunch into the same outDir starts at round 1 with the earlier run's flagged files on disk.
  ok(/If E:\/r\/runs\/t\/docs\/INDEX\.md already exists[^]*RECAPTURE CHECK[^]*DELETE the superseded\s+file/.test(prompt('curate:r1')),
    'the round-1 prompt carries the checked supersede rule, gated on the index already existing');
  ok(/by an earlier run into this folder/.test(r2), 'the ownership sentence counts an earlier run\'s captures as owned');
}

section('each recapture is spot-checked before the file it replaces is deleted');
// Deleting the flagged file on the word of an unchecked recapture could swap one paraphrase for another
// and lose the only copy that named the source.
{
  const RECAPTURE = { ...CURATE, fidelity_failures: 1, gaps: [{ kind: 'web', id: 'gap-r1-1' }] };
  const { prompt } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': RECAPTURE, 'curate:r2': CURATE });
  const r2 = prompt('curate:r2').replace(/\s+/g, ' ');
  ok(r2.includes('RECAPTURE CHECK: before you delete a file that a newer capture recaptures, open the source cited in the NEW capture\'s own header and compare ONE substantive passage'),
    'the check runs before the delete, against the new capture\'s own source');
  ok(r2.includes('A reworded, condensed or reordered recapture fails: count it in fidelity_failures, delete the failed recapture, keep the superseded file, and return its gap again.'),
    'a failed recapture keeps the superseded file and reopens the gap');
  ok(r2.includes('apart from a recapture the RECAPTURE CHECK already compared'), 'and the sample does not spend a pick on a checked recapture');
  const off = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': RECAPTURE, 'curate:r2': CURATE }, { ...baseArgs, fidelitySample: 0 });
  ok(off.prompt('curate:r2').includes('The sample spot-check is disabled for this run, so fidelity_checked counts only RECAPTURE CHECK comparisons.'),
    'fidelitySample 0 turns off the sample and keeps the recapture check');
  ok(!off.prompt('curate:r2').includes('FIDELITY SPOT-CHECK adds'), 'and the numbering rule names no spot-check that does not run');
}

section('a gap travels as an id\'d Coverage-notes entry, and the gap-fill gatherer reads it by path');
{
  const GAPS = { ...CURATE, gaps: [{ kind: 'web', id: 'gap-r1-1' }, { kind: 'repo', id: 'gap-r1-2' }, { kind: 'web', id: 'gap-r1-1' }] };
  const { prompt, calls, labels, logs } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': GAPS, 'curate:r2': CURATE },
    { ...baseArgs, target: { repo: 'E:/proj' } });
  const gapItem = calls.find((c) => c.label === 'curate:r1').opts.schema.properties.gaps.items;
  eq(Object.keys(gapItem.properties).sort().join(), 'id,kind', 'a returned gap carries its kind and id only');
  const r1 = prompt('curate:r1');
  ok(r1.includes('### [gap-r1-<n>] <short title>\n- kind: <web | repo | files>\n- file: <the captured file to recapture, or none for missing coverage>\n- source: <the URL, repo path or local doc to capture from>\n- reason: <'),
    'the curator writes each gap as an entry naming the file, the source and the reason');
  ok(prompt('curate:r2').includes('### [gap-r2-<n>]'), 'and a later round numbers its new gaps under its own round');
  const g = prompt('gather:r2');
  ok(g.includes('YOUR GAPS: each one is an entry under its id in the Coverage notes of E:/r/runs/t/docs/INDEX.md.'), 'the gap-fill gatherer reads the entries in the index');
  ok(g.includes('  - gap-r1-1 (web): write its captures into E:/r/runs/t/docs/gap-r1-1/\n  - gap-r1-2 (repo): write its captures into E:/r/runs/t/docs/gap-r1-2/\nHOW TO CAPTURE'),
    'one directory per distinct gap id, a repeated id dropped');
  ok(/  - repo: Copy the relevant docs\/READMEs\/reference material from the repo at E:\/proj/.test(g), 'with the capture guide of each kind it holds');
  ok(logs.some((l) => /gap-fill round 2: gap-r1-1, gap-r1-2$/.test(l)), 'the log names the gaps by id');
  eq(labels.filter((l) => l.startsWith('gather')).join(), 'gather:api-reference,gather:r2', 'one gatherer carries every gap of round 2');
  ok(logs.some((l) => /ignored 1 gap\(s\) with a blank or repeated id — check the Coverage notes in E:\/r\/runs\/t\/docs\/INDEX\.md$/.test(l)),
    'the repeated id is logged, never dropped silently');
  ok(r1.replace(/\s+/g, ' ').includes('Number this round\'s new gaps in sequence, the first one past the highest <n> any entry of the E:/r/runs/t/docs/INDEX.md on disk when your turn began uses under gap-r1- (from 1 when none does). A gap the FIDELITY SPOT-CHECK adds continues that sequence.'),
    'new gaps are numbered in sequence past every id the previous index holds, so a relaunch mints no open gap\'s id and no two gaps share one');
  ok(r1.replace(/\s+/g, ' ').includes('A reworded, condensed, or reordered passage is a FAILURE: rewrite E:/r/runs/t/docs/INDEX.md with a gap entry for it added'),
    'a spot-check failure rewrites the index with its entry, since the gatherer reads only the entry');
  ok(g.includes('A gap\nwhose id has no entry gets no capture: never guess its source, and list its id in missing_entries.'),
    'the gap-fill gatherer skips an id with no entry');
}

section('a gap id with no Coverage-notes entry is logged by the run');
{
  const GAPS = { ...CURATE, gaps: [{ kind: 'web', id: 'gap-r1-1' }, { kind: 'web', id: 'gap-r1-2' }] };
  const { logs } = await run({ 'gather:r2': { files_written: 1, missing_entries: ['gap-r1-2'] }, 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': GAPS, 'curate:r2': CURATE });
  ok(logs.some((l) => /no Coverage-notes entry in E:\/r\/runs\/t\/docs\/INDEX\.md for gap\(s\) gap-r1-2 — nothing was captured for them$/.test(l)),
    'the log names the gap the gatherer could not read');
  const clean = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': GAPS, 'curate:r2': CURATE });
  ok(!clean.logs.some((l) => /no Coverage-notes entry/.test(l)), 'and a gatherer that found every entry logs nothing');
}

section('a curate return with no gaps array ends the loop and the return counts no gap');
{
  const noGaps = { ...CURATE };
  delete noGaps.gaps;
  const { out, labels } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate': noGaps });
  eq(labels.filter((l) => l.startsWith('curate')).join(), 'curate:r1', 'no gap-fill round runs');
  eq(out?.unresolvedGaps, 0, 'and the return is built with zero unresolved gaps');
}

section('the gap-fill gatherer scrubs its own captures, so no scrubber runs per gap');
{
  const GAPS = { ...CURATE, gaps: [{ kind: 'web', id: 'gap-r1-1' }, { kind: 'web', id: 'gap-r1-2' }] };
  const { prompt, labels } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': GAPS, 'curate:r2': CURATE });
  eq(labels.filter((l) => l.startsWith('scrub')).join(), 'scrub:api-reference', 'only the round-1 web source gets a scrubber');
  const g = prompt('gather:r2');
  ok(g.includes('3. SCRUB each web capture in place once it is written, under these rules:\nDELETE ONLY capture junk:'), 'the scrub rules join the gap-fill prompt');
  ok(prompt('scrub:api-reference').includes('DELETE ONLY capture junk:'), 'and the round-1 scrubber keeps them');
}

section('a dead gap-fill gatherer records each of its gaps, and the curator still runs');
{
  const GAPS = { ...CURATE, gaps: [{ kind: 'web', id: 'gap-r1-1' }, { kind: 'files', id: 'gap-r1-2' }] };
  const { out, logs, labels } = await run({ 'gather:r2': null, 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': GAPS, 'curate:r2': CURATE });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'gap-r1-1', stage: 'gather' }, { id: 'gap-r1-2', stage: 'gather' }]), 'each gap dir is a gather failure');
  ok(logs.some((l) => /gather:r2 returned nothing \(agent skipped or died\) — the gap-fill gatherer died before returning; .* gaps may stay open: gap-r1-1, gap-r1-2/.test(l)), 'the log says so and names the gaps');
  ok(labels.includes('curate:r2'), 'the round-2 curator still runs');
  ok(/^WARN THE USER FIRST: these gatherers returned nothing, so coverage may be partial: gap-r1-1, gap-r1-2\./.test(out.nextStep), 'and nextStep warns');
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
  ok(JSON.stringify(out.failed) === JSON.stringify([{ id: 'api-reference', stage: 'scrub' }]), `a scrub entry can name only a web source: ${JSON.stringify(out.failed)}`);
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
  const RECAPTURE = { ...CURATE, fidelity_failures: 1, gaps: [{ kind: 'web', id: 'gap-r1-1' }] };
  const { prompt, out } = await run({ 'gather': GATHER, 'scrub': { files_cleaned: 1 }, 'curate:r1': RECAPTURE, 'curate:r2': CURATE });
  const r2 = prompt('curate:r2');
  ok(r2.includes('E:/r/runs/t/docs/gap-r1-1/ (gap gap-r1-1)'), 'the round-2 prompt names the gap-fill capture directory and its gap');
  ok(/pick ONLY from the files this round's gap-fill gatherer captured/.test(r2), 'and restricts the spot-check to this round\'s captures');
  ok(/Re-read the whole set/.test(r2), 'while still re-reading the whole set');
  ok(!/pick ONLY from the files this round's gap-fill gatherer captured/.test(prompt('curate:r1')), 'the round-1 prompt samples the whole set');
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
  ok(foreign.out.nextStep.includes('neither a source-headed capture for this set (this or an earlier run) nor a curator-written file'),
    'the warning names the curator\'s foreign class, since an earlier run\'s captures are deletable, not foreign');

  const deadScrub = await run({ 'gather': GATHER, 'scrub': null, 'curate': FOREIGN });
  const step = deadScrub.out.nextStep;
  ok(step.startsWith('WARN THE USER FIRST: these sources\' files were NOT scrubbed'), `the death warning still opens nextStep: ${step.slice(0, 120)}`);
  const foreignAt = step.indexOf('WARN THE USER FIRST: E:/r/runs/t/docs held');
  ok(foreignAt !== -1 && foreignAt < step.indexOf('Present the set'), 'and the foreign-content warning sits before "Present the set"');
}

await pinRoleMaps({
  engine: ENGINE, name: 'docs', defaults: { gather: 'sonnet', scrub: 'haiku', curate: 'sonnet' },
  runs: [{ args: baseArgs, respond: { gather: GATHER, scrub: { files_cleaned: 1 }, curate: CURATE }, labels: { gather: 'gather', scrub: 'scrub', curate: 'curate' } }],
});

// A relaunch into the same outDir finds the earlier launch's files, and the Write tool refuses to overwrite one the agent has not read.
section("every prompt that writes a file says to Read an earlier launch's file first, and a rejected write is not a write");
{
  const { prompt } = await run({ gather: GATHER, scrub: { files_cleaned: 1 }, 'curate:r1': { ...CURATE, gaps: [{ kind: 'web', id: 'gap-r1-1' }] }, curate: CURATE });
  const sites = [
    ["the gatherer's capture files", prompt('gather:api-reference'), 1, 1],
    ["the gap-fill gatherer's capture files", prompt('gather:r2'), 1, 1],
    ["the curator's index file", prompt('curate'), 1, 1],
  ];
  pinWriteNotes(sites);
}
