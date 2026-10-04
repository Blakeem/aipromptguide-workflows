// decide/decide-cycle.mjs — the convergence loop and what it hands back when it does NOT converge.
// Focus: WHICH gaps the reviewer raises, round over round. "No agreement in 3 rounds" has two opposite
// causes — a decider that never resolves the objections it was given, or a question so under-specified
// that every round finds fresh ones — and a bare gap COUNT cannot tell them apart, so the hand-back could
// only ever guess at one of them. The slugs are what makes the split observable. The baseline cases pin
// the three terminal states and the two dead-agent throws around it: the loop's stopping already works
// (the hard cap IS the churn detector), and none of this may move it.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/decide/decide-cycle.mjs';

const baseArgs = {
  runId: 't',
  root: 'E:/r',
  requirements: '## Decision\nWhich cache layer?\n## Non-negotiables\n- no new paid dependency\n## Weighted criteria\n- latency (weight 3)',
  lenses: ['efficiency', 'simplest'],
};
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

const ANALYST = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, open_questions: 0, needs_user: false };
const AGREE   = { wrote_file: true, agree: true, gap_count: 0, gap_ids: [], needs_user: false };
// A non-agreeing review carrying exactly the gaps it names — the shape the schema asks for.
const gaps = (...ids) => ({ ...AGREE, agree: false, gap_count: ids.length, gap_ids: ids });

section('the reviewer agreeing ends the loop inside the round budget');
{
  const { out, byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, { ...baseArgs, maxRounds: 4 });
  eq(byLabel('decide').length, 1, 'ended on round 1, well inside maxRounds=4');
  eq(out.status, 'decided (decider + reviewer agree)', 'status');
  ok(out.agreed === true && out.halted === false, 'the return carries the flags');
  ok(out.decisionFile.endsWith('decision-r1.md') && out.reviewFile.endsWith('decision-review-r1.md'),
    'both round files are named');
  eq(out.needsUserFile, '', 'and no escalation file — nothing was escalated');
}

section('both escalations halt on the same status, and the decider\'s runs no reviewer');
{
  const { out, labels } = await run({ analyst: ANALYST, decide: { ...DECIDE, needs_user: true }, review: AGREE });
  eq(out.status, 'BLOCKED (needs user input)', 'the decider\'s escalation');
  ok(!labels.some((l) => l.startsWith('review')), 'it breaks BEFORE the reviewer — nothing reviews a decision that was not made');
  ok(out.needsUserFile.endsWith('NEEDS-USER.md'), 'the escalation file is named');

  const { out: byReviewer, labels: revLabels } = await run({ analyst: ANALYST, decide: DECIDE, review: { ...gaps('rubric-contradiction'), needs_user: true } });
  eq(byReviewer.status, 'BLOCKED (needs user input)', 'the reviewer\'s escalation lands on the same status');
  ok(revLabels.includes('review r1'), 'but by a different route — the reviewer ran');
  ok(byReviewer.needsUserFile.endsWith('NEEDS-USER.md'), 'and names the same file');
}

section('a solo agent that dies throws — it must never read as a decision nobody made');
{
  const dead = await throwsWith(ENGINE, { args: baseArgs, respond: { analyst: ANALYST, decide: null } });
  ok(/Decider returned nothing/.test(dead) && /resumeFromRunId/.test(dead), `dead decider throws with the resume hint: ${dead.slice(0, 50)}`);
  const deadRev = await throwsWith(ENGINE, { args: baseArgs, respond: { analyst: ANALYST, decide: DECIDE, review: null } });
  ok(/Reviewer returned nothing/.test(deadRev) && /resumeFromRunId/.test(deadRev), `dead reviewer too: ${deadRev.slice(0, 50)}`);
}

section('gaps every round spend the round budget and report it as needs-attention');
{
  const { out, byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven') }, { ...baseArgs, maxRounds: 3 });
  eq(byLabel('decide').length, 3, 'the loop spun to the bound');
  eq(out.status, 'needs-attention (no agreement within round budget)', 'status');
  ok(out.agreed === false && out.halted === false, 'nothing claims agreement');
  eq(out.rounds, 3, 'and the round count is reported');
}

// ---------------------------------------------------------------------------------------------
// The trajectory: which gaps repeated, and what the hand-back makes of it.
// ---------------------------------------------------------------------------------------------

section('gap slugs are tracked across rounds, and the per-round log shows the split');
// The counts are the whole point: a round of 3 gaps that are all repeats and a round of 3 brand-new ones
// are the same number and opposite facts.
{
  const { out, logs } = await run({
    analyst: ANALYST,
    decide: DECIDE,
    review: (label) => (/r1$/.test(label) ? gaps('p99-unproven') : gaps('p99-unproven', 'lru-citation-stretched', 'no-hybrid-considered')),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.gapRounds?.length, 2, 'one entry per review round');
  eq(JSON.stringify(out.gapRounds?.[0]), JSON.stringify({ round: 1, gaps: 1, new: 1, repeated: 0 }),
    'round 1 can only be new — nothing preceded it');
  eq(JSON.stringify(out.gapRounds?.[1]), JSON.stringify({ round: 2, gaps: 3, new: 2, repeated: 1 }),
    'counts only (#8) — the gaps themselves stay in the review files');
  ok(logs.some((l) => /3 gap\(s\) — 2 new, 1 repeated/.test(l)), 'and the round line shows the split');

  // An agreeing round is still a round: 0 gaps is a real observation, not a missing entry.
  const { out: converged } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (/r1$/.test(label) ? gaps('p99-unproven') : AGREE),
  }, { ...baseArgs, maxRounds: 3 });
  eq(converged.gapRounds?.length, 2, 'the agreeing round is recorded too');
  eq(converged.gapRounds?.[1]?.gaps, 0, 'with no gaps');
  eq(converged.status, 'decided (decider + reviewer agree)', 'and the agree-gate still ends the loop');
}

section('a final round of REPEATS says the decider is not resolving them, and names their reviews');
{
  const { out } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: gaps('p99-unproven', 'lru-citation-stretched'),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.gapRounds?.[1]?.repeated, 2, 'every gap in the last round was already on the table');
  ok(/not RESOLVING/.test(out.nextStep), 'nextStep says which of the two failures this is');
  ok(/decision-review-r1\.md/.test(out.nextStep), 'and points at the review that first raised them');
  ok(/p99-unproven/.test(out.nextStep) && /lru-citation-stretched/.test(out.nextStep), 'naming the repeated gaps');
  ok(!/UNDER-SPECIFIED/.test(out.nextStep), 'and does NOT also offer the opposite diagnosis');
}

section('a final round of NEW gaps says the question is under-specified instead');
{
  const { out } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (/r1$/.test(label) ? gaps('p99-unproven', 'lru-citation-stretched') : gaps('cost-axis-missing', 'no-hybrid-considered')),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.gapRounds?.[1]?.new, 2, 'nothing from round 1 came back');
  ok(/UNDER-SPECIFIED/.test(out.nextStep), 'the opposite diagnosis — the rubric is not settling what "best" means');
  ok(!/not RESOLVING/.test(out.nextStep), 'and only that one');
  ok(/WHERE NEXT/.test(out.nextStep) && /decision-review-r2\.md/.test(out.nextStep),
    'both diagnoses point at the last review\'s WHERE NEXT section — it is what makes the stall resumable');
}

section('round 1 carries no slug list; later rounds carry the prior rounds\' slugs');
// Ids ONLY. Handing the reviewer the earlier gaps' content would anchor it, which is the exact thing the
// do-not-read-earlier-reviews instruction exists to prevent.
{
  const { byLabel } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (/r1$/.test(label) ? gaps('p99-unproven') : gaps('p99-unproven', 'cost-axis-missing')),
  }, { ...baseArgs, maxRounds: 3 });
  const [p1, p2, p3] = byLabel('review').map((c) => c.prompt);
  ok(!/AS SLUGS/.test(p1), 'round 1 has no earlier round, so it is given no list at all');
  ok(/AS SLUGS/.test(p2) && /p99-unproven/.test(p2), 'round 2 gets round 1\'s slug');
  ok(/cost-axis-missing/.test(p3), 'and round 3 gets the ones round 2 added');
  ok(!/decision-review-r1\.md/.test(p2), 'and only the ids — the earlier review file is never named, so there is nothing to go read');
  ok(/reuse its\s+slug verbatim/.test(p2), 'with the instruction that makes a repeat detectable — reuse the slug for the same issue');
  ok(p1.includes('Do NOT read earlier decision-review files') && p2.includes('Do NOT read earlier decision-review files'),
    'and the do-not-read rule survives on both — slugs are ids, not a licence to go reading');
}

section('the FINAL round is told to write WHERE NEXT; earlier rounds are not');
// The engine cannot write the file (the harness has no tools), so "a stalled run hands back somewhere to
// go" is only true if the last reviewer was asked for it. That makes it a contract, not a hope.
{
  const { byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven') }, { ...baseArgs, maxRounds: 2 });
  const [p1, p2] = byLabel('review').map((c) => c.prompt);
  ok(!/WHERE NEXT/.test(p1), 'round 1 is not — another decider round follows it');
  ok(/WHERE NEXT/.test(p2), 'the last round is');
  ok(/If you do NOT agree/.test(p2), 'conditionally: an agreeing review has nowhere to point');
  ok(/axis/.test(p2) && /converge/.test(p2), 'and is told what goes in it — the unsettled axis + the change that would converge a decision');
}

section('every concern the reviewer writes counts, in both selections');
// An agreeing review file reaches no agent, so an uncounted notes section there is a concern nobody acts on.
{
  const RULES = [
    'A concern you write about the decision is a gap.',
    'it blocks agree',
    'is evidence, not a concern',
    'stays a gap whatever its effect on the verdict',
    'you drop silently',
    'The file holds no notes or not-a-gap section.',
  ];
  for (const args of [baseArgs, { ...baseArgs, selection: 'ranked' }]) {
    const { byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, args);
    const p = byLabel('review')[0].prompt.replace(/\s+/g, ' ');
    const sel = args.selection ?? 'single';
    for (const rule of RULES) ok(p.includes(rule), `${sel}: the reviewer is told "${rule}"`);
  }
}

section('a gap_count that contradicts the ids is logged, and garbage ids are filtered');
// Self-contradictory, but the harm does not compound (tests/CLAUDE.md §3): the slugs drive the split and
// the count is only printed, so this is flagged, never a halt.
{
  const { out, logs } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: { ...AGREE, agree: false, gap_count: 5, gap_ids: ['p99-unproven'] },
  }, { ...baseArgs, maxRounds: 1 });
  ok(logs.some((l) => /gap_count=5 but 1 gap id/.test(l)), 'the contradiction is flagged rather than silently reconciled');
  eq(out.gapRounds?.[0]?.gaps, 1, 'and the ids win — they are what the split is computed from');
  eq(out.status, 'needs-attention (no agreement within round budget)', 'the run is not halted over it');

  const { out: junk } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: { ...AGREE, agree: false, gap_count: 3, gap_ids: ['ok-slug', '', 42, null, 'ok-slug'] },
  }, { ...baseArgs, maxRounds: 1 });
  eq(junk.gapRounds?.[0]?.gaps, 1, 'blanks, non-strings and a slug repeated inside ONE review all collapse to the one real gap');

  const { out: none } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: { wrote_file: true, agree: false, needs_user: false },
  }, { ...baseArgs, maxRounds: 1 });
  eq(none.gapRounds?.[0]?.gaps, 0, 'a review that returns no ids at all reads as no slugs, not as garbage');
  ok(/WHERE NEXT/.test(none.nextStep), 'and the hand-back still routes to WHERE NEXT — there is a stall either way');
}

section('a dead lens analyst is recorded in the return and named in the hand-back');
// One lens of many is auxiliary (#15): its death must not read as a full run that converged over every lens.
{
  const { out } = await run({ analyst: ANALYST, 'analyst:simplest': null, decide: DECIDE, review: AGREE });
  eq(JSON.stringify(out.failed), '["simplest"]', 'the dead lens is in failed');
  eq(out.lensFiles.length, 1, 'and only the surviving lens file is listed');
  ok(/left out of the decision: simplest\./.test(out.nextStep), `nextStep names the dropped lens: ${out.nextStep.slice(-120)}`);

  const { out: full } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(JSON.stringify(full.failed), '[]', 'a full run has an empty failed list');
  ok(!/left out of the decision/.test(full.nextStep), 'and no dropped-lens sentence');
}

section('a one-round stall gets no churn diagnosis: the decider never had a round to address a gap');
{
  const { out } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven') }, { ...baseArgs, maxRounds: 1 });
  ok(!/UNDER-SPECIFIED/.test(out.nextStep), 'not UNDER-SPECIFIED');
  ok(!/not RESOLVING/.test(out.nextStep), 'not "not RESOLVING" either');
  ok(/Refine the requirements and re-run, or raise maxRounds/.test(out.nextStep), 'the plain stall text remains');
}

section('an empty ranked shortlist or a blank chosen replaces the earlier round\'s, never carries it over');
// The return pairs shortlist with decisionFile, which names the LATEST round's file.
{
  const SHORT = { ...DECIDE, shortlist: [{ rank: 2, title: 'redis' }, { rank: 1, title: 'in-process LRU' }] };
  const { out } = await run({
    analyst: ANALYST,
    decide: (label) => (/r1$/.test(label) ? SHORT : { ...SHORT, chosen: '', shortlist: [] }),
    review: gaps('p99-unproven'),
  }, { ...baseArgs, selection: 'ranked', maxRounds: 2 });
  ok(out.decisionFile.endsWith('decision-r2.md'), 'the return names round 2\'s decision file');
  eq(JSON.stringify(out.shortlist), '[]', 'and round 2\'s empty shortlist, not round 1\'s');
  eq(out.chosen, '', 'and round 2\'s blank chosen');

  const { out: r1 } = await run({ analyst: ANALYST, decide: SHORT, review: AGREE }, { ...baseArgs, selection: 'ranked' });
  eq(r1.shortlist.map((s) => s.rank).join(','), '1,2', 'a non-empty shortlist is still sorted by rank');
}

section('an agree that lists open gaps is flagged, not trusted silently');
// Flag, not halt (tests/CLAUDE.md §3): the decision is the last step, so the harm cannot compound.
{
  const { out, logs } = await run({ analyst: ANALYST, decide: DECIDE, review: { ...AGREE, gap_ids: ['x'] } });
  eq(out.status, 'decided (decider + reviewer agree)', 'the status is unchanged');
  ok(logs.some((l) => /reviewer AGREES but lists 1 open gap\(s\) — self-contradictory; audit .*decision-review-r1\.md/.test(l)), 'the contradiction is logged');
  eq(out.contradicted, true, 'and returned');
  ok(/^The reviewer agreed while listing open gaps: audit .*decision-review-r1\.md before presenting\./.test(out.nextStep), 'nextStep leads with the audit');

  const { out: count } = await run({ analyst: ANALYST, decide: DECIDE, review: { ...AGREE, gap_count: 2 } });
  eq(count.contradicted, true, 'a positive gap_count with no ids is the same contradiction');

  const { out: clean } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(clean.contradicted, false, 'a clean agree is not flagged');
  ok(/^Present the conclusion/.test(clean.nextStep), 'and its nextStep is unchanged');
}

section('an agree over a decision the decider says misses a requirement is flagged');
{
  const { out, logs } = await run({ analyst: ANALYST, decide: { ...DECIDE, meets_all_requirements: false }, review: AGREE });
  eq(out.status, 'decided (decider + reviewer agree)', 'the status is unchanged');
  eq(out.meetsAllRequirements, false, 'the decider\'s attestation is returned');
  ok(logs.some((l) => /reviewer AGREES but the decider reported meets_all_requirements=false — audit .*decision-r1\.md/.test(l)), 'the contradiction is logged');
  ok(/^The decider itself reported that the conclusion does not meet every requirement: check .*decision-r1\.md before presenting\./.test(out.nextStep), 'nextStep leads with the check');

  const { out: ranked } = await run({ analyst: ANALYST, decide: { ...DECIDE, meets_all_requirements: false, shortlist: [] }, review: AGREE }, { ...baseArgs, selection: 'ranked' });
  ok(/a shortlisted option does not meet every requirement/.test(ranked.nextStep), 'ranked mode names a shortlisted option');

  const { out: both } = await run({ analyst: ANALYST, decide: { ...DECIDE, meets_all_requirements: false }, review: { ...AGREE, gap_ids: ['x'] } });
  ok(/^The reviewer agreed while listing open gaps: .* The decider itself reported/.test(both.nextStep), 'both caveats compose, reviewer first');

  const { out: ok1 } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(ok1.meetsAllRequirements, true, 'a met rubric returns true');
}
