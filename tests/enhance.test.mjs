// enhance/enhance-cycle.mjs — the read-only lensed fan-out.
// Focus: the dead-agent paths. Both roles run inside a fan-out, so a dead one resolves to null rather
// than throwing, and the only thing standing between that and a lens reported as cleanly audited is an
// explicit guard per stage (tests/CLAUDE.md §3). `failed` is the operator's one signal that a lens
// produced nothing because nobody looked — assert it for BOTH stages, or the guards drift apart.
import { runEngine, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';

const ENGINE = 'workflows/enhance/enhance-cycle.mjs';
const baseArgs = {
  runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  scope: ['workflows/'], lenses: ['efficiency', 'simplification'],
};
// The engine's verify-unit cap: a lens holding this many candidates gets a verifier of its own.
const UNIT_CAP = 12;
const lensOfFind = (label) => label.replace(/^find:/, '');
// A finder that wrote `n` candidates under its own lens's ids.
const foundN = (n) => (label) => ({
  candidate_ids: Array.from({ length: n }, (_, i) => `${lensOfFind(label)}-${i + 1}`),
  wrote_candidates: true, wrote_clean_marker: false,
});
const FOUND = foundN(1);
// A verifier that attests every lens its label names.
const unitLenses = (label) => label.replace(/^verify:/, '').split('+');
const verifiedWith = (verdicts) => (label) => ({ wrote_lenses: unitLenses(label), verdicts: verdicts(label) });
const VERIFIED = verifiedWith(() => []);
const verdict = (id, extra) => ({ candidate_id: id, is_real: true, impact: 'high', size: 'small', decision: 'ADOPT', ...extra });

section('a dead verifier lands its lens in failed, never in the audited count');
// The bug this pins: the stage returned its result object anyway, so `live` kept the lens, `failed` stayed
// empty, and `lenses[]` reported a proposals/<lens>.md path the dead verifier never wrote — a lens the
// operator would read as clean. Only the ⚠ in the log said otherwise. A full lens gets a verifier of its
// own, so one verifier can die while the other lens's survives.
{
  const { out, logs } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: {
      'find:efficiency': foundN(UNIT_CAP),
      find: FOUND,
      'verify:efficiency': null,          // longest matching prefix wins over 'verify'
      verify: VERIFIED,
    },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'verify' }]), 'the dead verifier\'s lens is reported failed at the verify stage');
  ok(!out.lenses.some((l) => l.lens === 'efficiency'), 'and no proposal-file path is reported for it');
  eq(out.summary.lenses, 1, 'only the verified lens counts as audited');
  ok(out.lenses.some((l) => l.lens === 'simplification' && /simplification\.md$/.test(l.file)),
    'the live lens is unaffected');
  ok(logs.some((l) => /efficiency: the verifier DIED/.test(l)), 'the log names the lens that must be re-run');
  ok(/TELL THE USER these lenses were NOT audited and produced no verified proposal file: efficiency \(verify\) /.test(out.nextStep), 'and nextStep names it with its stage');
  ok(logs.some((l) => /no verified proposal file from: efficiency \(verify\) /.test(l)), 'and so does the log line after the fan-out');
  ok(!('phase' in out), 'the return has no phase key');
  ok(/not presented until the lens is re-run/.test(out.nextStep), 'and says a file on disk for it is not presented');
  // A re-run with the same runId leaves a failed lens's earlier file on disk, so "present the directory" would present it.
  ok(/PRESENT them to the user: E:\/r\/runs\/t\/proposals\/simplification\.md\./.test(out.nextStep), 'nextStep names the live lens\'s file');
  ok(/Present only the listed files/.test(out.nextStep), 'and says to present only the listed files');
}

section('a dead verifier of a packed unit fails every lens it carried');
{
  const { out, logs, labels } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { find: FOUND, verify: null },
  });
  ok(labels.includes('verify:efficiency+simplification'), 'the two one-candidate lenses share one verifier');
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'verify' }, { id: 'simplification', stage: 'verify' }]),
    'both lenses are reported failed at the verify stage');
  ok(['efficiency', 'simplification'].every((id) => logs.some((l) => l.includes(`${id}: the verifier DIED`))), 'and the log names each one');
}

section('a dead finder does the same — the two guards stay symmetric');
{
  const { out } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { 'find:efficiency': null, find: FOUND, verify: VERIFIED },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'find' }]), 'the dead finder\'s lens is reported failed at the find stage');
  eq(out.summary.lenses, 1, 'and is not counted as audited');
}

section('a lens named like an Object member is reported failed at its own stage');
// A lens id is slugged, so `__proto__` becomes `proto` and `constructor` is the one id that names an Object member.
// The stage record is read back for every failed lens, so each id has to resolve to the stage written for it.
{
  const { out } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['__proto__', 'constructor', 'efficiency'] },
    respond: { 'find:proto': null, 'find:constructor': foundN(UNIT_CAP), 'verify:constructor': null, find: FOUND, verify: VERIFIED },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'proto', stage: 'find' }, { id: 'constructor', stage: 'verify' }]),
    'each lens is reported failed at the stage it died in');
}

section('a candidate the verifier judges too risky is rejected, counted, and kept out of the proposals');
// The operator's one filter for "this would regress something the workflow needs" is this count and the
// rejection line in the lens file. A too_risky verdict routed anywhere but REJECT would reach triage.
{
  const { out } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: {
      find: foundN(2),
      verify: verifiedWith(() => [
        verdict('efficiency-1', { decision: 'REJECT', too_risky: true }),
        verdict('efficiency-2'),
      ]),
    },
  });
  eq(out.summary.tooRisky, 1, 'the summary counts it');
  eq(out.lenses[0]?.kept.length, 1, 'and only the safe candidate is kept');
  ok(!out.lenses[0]?.kept.some((k) => k.id.endsWith('-1')), 'the risky one is not among them');
  ok(out.nextStep.includes('ROADMAP items a section-mode block when they span many call sites'), 'nextStep routes ROADMAP to a section-mode block only across many call sites');
  ok(!out.nextStep.includes('returned no verdict'), 'and holds no unjudged line when every candidate has a verdict');
}

section('a verifier that does not attest a lens\'s proposal file lands that lens in failed');
// The path it would have reported names a file nobody attested writing (#15).
{
  const { out, logs } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { find: FOUND, verify: { wrote_lenses: ['simplification'], verdicts: [] } },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'verify' }]), 'the unattested lens is reported failed at the verify stage');
  ok(!out.lenses.some((l) => l.lens === 'efficiency'), 'and no proposal-file path is reported for it');
  eq(out.summary.lenses, 1, 'only the attested lens of the unit counts as audited');
  ok(logs.some((l) => /efficiency: the verifier did NOT confirm writing .*efficiency\.md — this lens was NOT verified\. Re-run it\./.test(l)),
    'the log says why and what to do');
}

section('a candidate the finder scored below the floor still reaches the verifier');
// A pre-cut on the finder's unverified score kept sub-floor candidates out of every proposal file. The
// verifier's routing line rejects them by name in `## Rejected` instead, so no floor count is returned.
// The harness never sees the score now: every id the finder returns is routed.
{
  const { out, labels, prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  ok(labels.includes('verify:efficiency'), 'the verifier is spawned for the candidate');
  ok(/candidate ids:\s+efficiency-1\n/.test(prompt('verify')), 'and its prompt lists its id');
  eq(Object.keys(out.summary).join(), 'lenses,adopt,roadmap,needsUser,rejected,defects,tooRisky,unjudged', 'the summary carries no belowFloor count');
}

section('a finder with no candidate and no attested marker lands its lens in failed');
// Without the marker no file is vouched for, so a path or a clean lens in the return would be unbacked.
{
  const { out, logs } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { 'find:efficiency': { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: false }, find: FOUND, verify: VERIFIED },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'find' }]), 'the unattested lens is reported failed at the find stage');
  ok(!out.lenses.some((l) => l.lens === 'efficiency'), 'and out.lenses has no entry for it');
  ok(logs.some((l) => /efficiency: the finder did NOT confirm writing its marker — this lens was NOT audited \(no candidates, and any .*efficiency\.md on disk is unverified\)\. Re-run it\./.test(l)),
    'the log says why and what to do');
}

section('a finder whose every candidate id is unroutable lands its lens in failed, never clean');
// A contradictory return (ids plus a marker) would otherwise drop the candidates and report a clean lens.
{
  const { out, logs, labels } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: { candidate_ids: ['eff-1', 'efficiency-x'], wrote_candidates: true, wrote_clean_marker: true } },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'find' }]), 'the lens is reported failed at the find stage');
  ok(!labels.some((l) => l.startsWith('verify')), 'and no verifier is spawned');
  ok(logs.some((l) => /efficiency: no candidate id the finder returned reads efficiency-<n> — this lens was NOT audited/.test(l)), 'the log says why');
}

section('a finder that returns ids without attesting its candidates file lands its lens in failed');
// The file on disk may be an earlier launch's, so a verifier would judge candidates this finder never wrote.
{
  const { out, logs, labels } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { 'find:efficiency': { candidate_ids: ['efficiency-1'], wrote_candidates: false, wrote_clean_marker: false }, find: FOUND, verify: VERIFIED },
  });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'find' }]), 'the lens is reported failed at the find stage');
  ok(labels.includes('verify:simplification'), 'and no verifier carries it');
  ok(logs.some((l) => /efficiency: the finder did NOT confirm writing E:\/r\/runs\/t\/candidates\/efficiency\.md — this lens was NOT audited\. Re-run it\./.test(l)),
    'the log names the candidates file');
}

section('a candidate id that repeats or lacks the lens prefix is ignored and logged');
// The prefix ties a verdict back to its lens inside a packed unit, so lens `efficiency`'s id must never read as lens `efficiency-2`'s.
{
  const { prompt, logs, out } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency', 'efficiency-2'] },
    respond: {
      'find:efficiency-2': { candidate_ids: ['efficiency-2-1'], wrote_candidates: true, wrote_clean_marker: false },
      find: { candidate_ids: ['efficiency-1', 'efficiency-1', 'efficiency-2-1', 'other-1'], wrote_candidates: true, wrote_clean_marker: false },
      verify: verifiedWith(() => [verdict('efficiency-1'), verdict('efficiency-2-1', { decision: 'ROADMAP' })]),
    },
  });
  ok(logs.some((l) => /efficiency: ignored 3 candidate id\(s\) that repeat or do not read efficiency-<n>/.test(l)), 'the stray ids are counted in the log');
  ok(/LENS efficiency: efficiency\n.*\n\s+candidate ids:\s+efficiency-1\n/.test(prompt('verify')), 'the verifier gets only the lens\'s own id');
  const rows = Object.fromEntries(out.lenses.map((l) => [l.lens, l.counts]));
  eq(`${rows.efficiency?.adopt}/${rows.efficiency?.roadmap}`, '1/0', 'the efficiency verdict counts under efficiency');
  eq(`${rows['efficiency-2']?.adopt}/${rows['efficiency-2']?.roadmap}`, '0/1', 'and the efficiency-2 verdict under efficiency-2');
}

section('the finder writes each candidate with its evidence to a file and returns only ids');
// Candidate prose re-encoded through the schema into the verifier prompt lost the finder's evidence and
// put content on the control plane (#8).
{
  const { calls, prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const findSchema = calls.find((c) => c.label.startsWith('find')).opts.schema;
  eq(Object.keys(findSchema.properties).sort().join(), 'candidate_ids,wrote_candidates,wrote_clean_marker', 'the find schema carries ids and flags only');
  const f = prompt('find');
  ok(f.includes('WRITE the file E:/r/runs/t/candidates/efficiency.md'), 'the find prompt names the candidates file');
  ok(f.includes('Number the candidates efficiency-1, efficiency-2 and so on, in file order.'), 'and the id scheme');
  ok(/\n\*\*Evidence:\*\* <what grounds Today and Removes: each file:line you read, and each command you ran with its output>\n/.test(f), 'and an Evidence line per candidate');
  ok(f.includes('- category: <one of efficiency | simplification | removal'), 'and lists the categories');
  const v = prompt('verify');
  ok(v.includes('candidates file: E:/r/runs/t/candidates/efficiency.md   (read it in full'), 'the verifier reads the candidates file by path');
  ok(v.includes('proposal file:   E:/r/runs/t/proposals/efficiency.md'), 'and is told its proposal file');
  ok(/are the finder's claims, not facts\. Confirm each one\nagainst the source it cites/.test(v), 'and confirms the finder\'s claims against their sources');
  ok(v.replace(/\s+/g, ' ').includes('Judge only the candidate ids listed above. A block of a candidates file whose id is not listed for its lens gets no verdict and stays out of every proposal file'),
    'and judges only the listed ids, so a block whose id the run dropped reaches no proposal file');
}

section('verifiers are bin-packed across lenses up to the candidate cap, and a lens never splits');
{
  const { labels, out, prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['a', 'b', 'c', 'd', 'e'] },
    respond: {
      'find:a': foundN(5), 'find:b': foundN(7), 'find:c': foundN(1), 'find:d': foundN(UNIT_CAP + 3), 'find:e': foundN(2),
      verify: verifiedWith((label) => unitLenses(label).map((id) => verdict(`${id}-1`))),
    },
  });
  const verifyLabels = labels.filter((l) => l.startsWith('verify:'));
  eq(verifyLabels.join(), 'verify:a+b,verify:c,verify:d,verify:e', 'next-fit in lens order: a+b fill the cap, c starts a unit d overflows, d alone, e after it');
  ok(/LENS a: a\n[\s\S]*LENS b: b\n/.test(prompt('verify:a+b')), 'the packed verifier lists both lenses');
  eq(out.lenses.map((l) => `${l.lens}:${l.counts.found}/${l.counts.adopt}`).join(), 'a:5/1,b:7/1,c:1/1,d:15/1,e:2/1', 'each lens keeps its own counts');
  eq(out.lenses.find((l) => l.lens === 'd')?.counts.unjudged, UNIT_CAP + 2, 'and its own unjudged count');
}

section('a clean finder that attests its marker reports its proposal file');
{
  const { out, labels } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: true } },
  });
  ok(/proposals\/efficiency\.md$/.test(out.lenses[0]?.file), 'the marker path is reported');
  eq(JSON.stringify(out.failed), '[]', 'and the lens is not a failure');
  ok(!labels.some((l) => l.startsWith('verify')), 'and no verifier is spawned');
}

section('ENV lets both roles cite out-of-scope evidence, and the verifier states its own reading rule');
// "read and judge only the scope" stopped a verifier from finding the existing mechanism a candidate
// duplicates when that mechanism lived outside the scope or used other words.
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const findText = prompt('find');
  const verifyText = prompt('verify');
  ok(verifyText.includes('READING RULE: read the code each candidate cites, plus what you need to apply the REJECT rules. For\nrule 1, search the scope for an existing mechanism that does what the candidate proposes, by what the\nmechanism does and not only by the candidate\'s words.'),
    'the verify prompt states its reading rule with the rule-1 search guard');
  ok(!/judge only these/.test(verifyText) && !/read the scope properly/.test(verifyText), 'and drops the scope-only reading rule');
  ok(/Files outside the scope may be read and cited as evidence\./.test(findText), 'the find prompt allows out-of-scope evidence');
  ok(/Files outside the scope may be read and cited as evidence\./.test(verifyText), 'and so does the verify prompt');
}

section('a defect has its own channel: a DEFECT: candidate and a Defects to route block');
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verifyText = prompt('verify');
  ok(/reports it as its own candidate whose title starts `DEFECT:`, with its Today line naming\n\s+what is broken/.test(prompt('find')), 'the finder reports a defect as a DEFECT: candidate');
  ok(verifyText.includes('\n## Defects to route\n(one block per defect,'), 'the template holds the Defects to route section');
  ok(verifyText.includes('### [<candidate_id>] <what is broken, as a short title>\n- file: <file>:<line>\n\n**What:** <what is broken and its harm>\n**Evidence:** <the trigger and what you confirmed: the triggering input, the probe command and its output, or the cited document>\n'),
    'each defect is a block with debug\'s file and What lines, and an Evidence line');
  ok(!verifyText.includes('one line per defect'), 'and the one-line shape is gone');
  ok(/A candidate that mixes a defect with a separable enhancement keeps its enhancement\n\s+half/.test(verifyText), 'and rule 4 keeps the enhancement half of a mixed candidate');
}

section('the work-size field is named size in the verdict schema, the prompts and the kept rows, and effort is gone');
{
  const { calls, out, prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: verifiedWith(() => [verdict('efficiency-1')]) },
  });
  const item = calls.find((c) => c.label.startsWith('verify')).opts.schema.properties.verdicts.items;
  ok(item.required.includes('size') && 'size' in item.properties, 'the verdict schema requires size');
  ok(!item.required.includes('effort') && !('effort' in item.properties), 'and holds no effort field');
  ok(prompt('find').includes('- size: <trivial | small | medium | large>'), 'the candidates template holds a size line');
  const v = prompt('verify');
  ok(v.includes('- size: <your confirmed size>'), 'the proposal template holds a size line');
  ok(!/\beffort\b/i.test(v), 'and the verify prompt names no effort');
  eq(out.lenses[0].kept[0]?.size, 'small', 'the kept row carries the verdict size');
}

section('the ROADMAP trigger is a contract change across files, not a file count');
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verifyText = prompt('verify');
  ok(/size == large OR the change alters a contract across files/.test(verifyText), 'the ROADMAP line names a contract change');
  ok(/A doc-only edit across many files is not a contract change and\n\s+does not trigger ROADMAP\./.test(verifyText), 'and excludes a doc-only edit');
  ok(!/touches many files\/contracts at once/.test(verifyText), 'the file-count trigger is gone');
}

section('the triage doc template holds no em dash in its Rejected format or its note line');
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verifyText = prompt('verify');
  const noteLine = verifyText.split('\n').find((l) => l.startsWith('note: ')) || '';
  ok(/\(one line each: `<title>: <why, with the file:line it rests on>`\)/.test(verifyText), 'the Rejected format reads <title>: <why, with the file:line it rests on>');
  ok(noteLine.length > 0 && !/[—;]/.test(noteLine), `the note line holds no em dash and no semicolon (got "${noteLine}")`);
}

section('the verifier records a cost it cannot substantiate as UNPROVEN, apart from a refuted one');
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const flatVerify = prompt('verify').replace(/\s+/g, ' ');
  ok(flatVerify.includes('A cost the code refutes is NOT REAL: cite the code that refutes it.'), 'rule 2 cites the code that refutes a cost');
  ok(flatVerify.includes('A cost you cannot substantiate is UNPROVEN: its Rejected line starts `UNPROVEN:` and names the evidence that would substantiate it.'),
    'rule 2 records an unsubstantiated cost as UNPROVEN with the evidence that would substantiate it');
}

section('a submitted candidate with no verdict is counted and named, never silently dropped');
{
  const { out, logs } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: foundN(2), verify: verifiedWith(() => [verdict('efficiency-1')]) },
  });
  eq(out.lenses[0].counts.unjudged, 1, 'the lens counts the unjudged candidate');
  eq(out.summary.unjudged, 1, 'and so does the summary');
  ok(logs.some((l) => /efficiency: the verifier returned no verdict for efficiency-2 — they are in no count/.test(l)), 'the log names it');
  ok(out.nextStep.includes('They hold 1 ADOPT, 0 ROADMAP and 0 NEEDS_USER item(s) across 1 lens(es).'), 'nextStep states the counts');
  ok(out.nextStep.includes('The verifier returned no verdict for 1 candidate(s) (summary.unjudged), so they are in no count: check them in E:/r/runs/t/proposals/efficiency.md before triage.'),
    'and names the unjudged count and the lens file that holds it');
}

section('a real candidate below the impact floor keeps is_real=true, and its impact score rejects it');
// is_real=false is reserved for an unreal candidate. Telling the verifier to set it for a real but marginal
// one gave the same candidate two contradictory values.
{
  const { prompt, calls } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verifyPrompt = prompt('verify');
  const isRealDesc = calls.find((c) => c.label.startsWith('verify')).opts.schema.properties.verdicts.items.properties.is_real.description;
  ok(!/impact floor once YOU have scored it honestly/.test(verifyPrompt), 'the taste rule no longer sweeps in below-floor candidates');
  ok(/below the moderate floor keeps is_real=true/.test(verifyPrompt), 'the prompt says a below-floor survivor keeps is_real=true');
  ok(/below the impact floor stays true/.test(isRealDesc), 'the is_real schema description names the floor case');
}

section('the verdict schema holds decisions only, and the prompt points every note at the file');
// The verifier writes its rejection notes, options and recommendation into the proposal file first, so a schema copy is read by nothing.
{
  const { calls, prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verdictProps = calls.find((c) => c.label.startsWith('verify')).opts.schema.properties.verdicts.items.properties;
  const v = prompt('verify');
  for (const field of ['rationale', 'options', 'recommendation']) ok(!(field in verdictProps), `the verdict items have no ${field}`);
  ok(!v.includes('options + recommendation'), 'the verify prompt names no options + recommendation pair');
  ok(/-> REJECT \(one line under `## Rejected`,\s+or one block under `## Defects to route` for an is_defect candidate\)/.test(v),
    'the REJECT routing line names the section its entry goes under');
}

section('a run where every lens failed says NOTHING was audited, never presents proposals');
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { find: null } });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'efficiency', stage: 'find' }, { id: 'simplification', stage: 'find' }]),
    'every lens failed at the find stage');
  ok(/^NOTHING was audited: every lens failed: efficiency \(find\), simplification \(find\)\./.test(out.nextStep),
    'nextStep says nothing was audited and names each lens with its stage');
  ok(!/PRESENT them/.test(out.nextStep), 'and never says to present proposals');
}

await pinRoleMaps({
  engine: ENGINE, name: 'enhance', defaults: { find: 'opus', verify: 'opus' },
  runs: [{ args: baseArgs, respond: { find: FOUND, verify: VERIFIED }, labels: { find: 'find', verify: 'verify' } }],
});

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite one the agent has not read.
section("every prompt that writes a file says to Read an earlier launch's file first, and a rejected write is not a write");
{
  const found = await runEngine(ENGINE, { args: { ...baseArgs, lenses: ['efficiency'] }, respond: { find: { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: true } } });
  const verified = await runEngine(ENGINE, { args: baseArgs, respond: { find: FOUND, verify: VERIFIED } });
  const sites = [
    ["the finder's candidates file and clean-lens marker", found.prompt('find'), 2, 1],
    ["the verifier's proposal files", verified.prompt('verify'), 1, 1],
  ];
  pinWriteNotes(sites);
  pinFileWriteNote(sites);
}
