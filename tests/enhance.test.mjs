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
  ok(/TELL THE USER these lenses were NOT audited and produced no verified proposal file: efficiency/.test(out.nextStep), 'and nextStep names it');
  ok(/not presented until the lens is re-run/.test(out.nextStep), 'and says a file on disk for it is not presented');
  // A re-run with the same runId leaves a failed lens's earlier file on disk, so "present the directory" would present it.
  ok(/PRESENT them to the user: E:\/r\/runs\/t\/proposals\/simplification\.md\./.test(out.nextStep), 'nextStep names the live lens\'s file');
  ok(/Present only the listed files/.test(out.nextStep), 'and says to present only the listed files');
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

section('a candidate the finder scored below the floor still reaches the verifier');
// A pre-cut on the finder's unverified score kept sub-floor candidates out of every proposal file. The
// verifier's routing line rejects them by name in `## Rejected` instead, so no floor count is returned.
{
  const { out, labels, prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: { wrote_clean_marker: false, candidates: [{ ...CANDIDATE, impact: 'marginal' }] }, verify: VERIFIED },
  });
  ok(labels.includes('verify:efficiency'), 'the verifier is spawned for the marginal candidate');
  ok(/efficiency-1 :: simplification :: marginal\/small :: fold the two verifier roles into one/.test(prompt('verify')), 'and its prompt lists it');
  eq(Object.keys(out.summary).join(), 'lenses,adopt,roadmap,needsUser,rejected,defects,tooRisky,unjudged', 'the summary carries no belowFloor count');
}

section('a finder with no candidate and no attested marker lands its lens in failed');
// Without the marker no file is vouched for, so a path or a clean lens in the return would be unbacked.
{
  const { out, logs } = await runEngine(ENGINE, {
    args: baseArgs,
    respond: { 'find:efficiency': { wrote_clean_marker: false, candidates: [] }, find: FOUND, verify: VERIFIED },
  });
  eq(out.failed.join(), 'efficiency', 'the unattested lens is reported failed');
  ok(!out.lenses.some((l) => l.lens === 'efficiency'), 'and out.lenses has no entry for it');
  ok(logs.some((l) => /efficiency: the finder did NOT confirm writing its marker — this lens was NOT audited \(no candidates, and any .*efficiency\.md on disk is unverified\)\. Re-run it\./.test(l)),
    'the log says why and what to do');
}

section('a clean finder that attests its marker reports its proposal file');
{
  const { out } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: { wrote_clean_marker: true, candidates: [] } },
  });
  ok(/proposals\/efficiency\.md$/.test(out.lenses[0]?.file), 'the marker path is reported');
  eq(out.failed.length, 0, 'and the lens is not a failure');
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

section('a defect has its own channel: a DEFECT: candidate and a Defects to route section');
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verifyText = prompt('verify');
  ok(/reports it as its own candidate whose title starts `DEFECT:`/.test(prompt('find')), 'the finder reports a defect as a DEFECT: candidate');
  ok(/\n## Defects to route\n\(one line per defect: `- <candidate_id>: <file:line> <what is broken>`/.test(verifyText), 'the template holds the Defects to route section');
  ok(/A candidate that mixes a defect with a separable enhancement keeps its enhancement\n\s+half/.test(verifyText), 'and rule 4 keeps the enhancement half of a mixed candidate');
}

section('the ROADMAP trigger is a contract change across files, not a file count');
{
  const { prompt } = await runEngine(ENGINE, {
    args: { ...baseArgs, lenses: ['efficiency'] },
    respond: { find: FOUND, verify: VERIFIED },
  });
  const verifyText = prompt('verify');
  ok(/effort == large OR the change alters a contract across files/.test(verifyText), 'the ROADMAP line names a contract change');
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
  ok(/\(one line each: `<title>: <why>`\)/.test(verifyText), 'the Rejected format reads <title>: <why>');
  ok(noteLine.length > 0 && !/[—;]/.test(noteLine), `the note line holds no em dash and no semicolon (got "${noteLine}")`);
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
  ok(/-> REJECT \(one line under `## Rejected`,\s+or under `## Defects to route` for an is_defect candidate\)/.test(v),
    'the REJECT routing line names the section its line goes under');
}

section('a run where every lens failed says NOTHING was audited, never presents proposals');
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { find: null } });
  eq(out.failed.join(), 'efficiency,simplification', 'every lens failed');
  ok(/^NOTHING was audited: every lens failed \(efficiency, simplification\)/.test(out.nextStep), 'nextStep says nothing was audited');
  ok(!/PRESENT them/.test(out.nextStep), 'and never says to present proposals');
}
