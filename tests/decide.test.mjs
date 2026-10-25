// decide/decide-cycle.mjs — the convergence loop and what it hands back when it does NOT converge.
// Focus: WHICH gaps the reviewers raise, round over round. "No agreement in 3 rounds" has two opposite
// causes — a decider that never resolves the objections it was given, or a question so under-specified
// that every round finds fresh ones — and a bare gap COUNT cannot tell them apart, so the hand-back could
// only ever guess at one of them. The slugs are what makes the split observable. The baseline cases pin
// the terminal states and the dead-agent throws around it: the loop's stopping already works (the hard
// cap IS the churn detector), and none of this may move it. Round 1 runs three focused reviewers, later
// rounds one verifier, and only a BLOCKING gap stops agreement: a caveat reaches the plan via the return.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';
import { pinRoleMaps } from './role-map-pin.mjs';

const ENGINE = 'workflows/decide/decide-cycle.mjs';

const baseArgs = {
  runId: 't',
  root: 'E:/r',
  planPath: 'E:/r/plans/t/requirements.md',
  lenses: ['efficiency', 'simplest'],
};
const RANKED = { ...baseArgs, selection: 'ranked' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

const ANALYST = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, flip: 'robust', open_questions: 0, needs_user: false };
const AGREE   = { wrote_file: true, agree: true, gap_ids: [], caveat_ids: [], needs_user: false };
// A non-agreeing review carrying exactly the blocking gaps it names — the shape the schema asks for.
const gaps = (...ids) => ({ ...AGREE, agree: false, gap_ids: ids });
const caveats = (...ids) => ({ ...AGREE, caveat_ids: ids });
const FOCUS = { single: ['choice', 'requirements', 'design'], ranked: ['order', 'requirements', 'combine'] };
const isR1 = (label) => /^review r1 /.test(label);
// New and renamed return fields are read defensively, so the old engine fails each assertion on its own.
const list = (v) => (Array.isArray(v) ? v : []);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ');
const promptsOf = (byLabel, prefix) => byLabel(prefix).map((c) => flat(c.prompt));

section('the reviewers agreeing ends the loop inside the round budget');
{
  const { out, byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, { ...baseArgs, maxRounds: 4 });
  eq(byLabel('decide').length, 1, 'ended on round 1, well inside maxRounds=4');
  eq(out.status, 'decided (decider + reviewers agree)', 'status: no caveat, so the plain agreed status');
  ok(out.agreed === true && out.halted === false, 'the return carries the flags');
  const files = list(out.reviewFiles);
  ok(out.decisionFile.endsWith('decision-r1.md') && files.length === 3
    && FOCUS.single.every((f, i) => String(files[i]).endsWith(`decision-review-r1-${f}.md`)),
  `the decision and all three round-1 review files are named: ${JSON.stringify(out.reviewFiles)}`);
  ok(!('reviewFile' in out), 'the single reviewFile field is gone');
  eq(out.needsUserFile, '', 'and no escalation file — nothing was escalated');
  ok(out.nextStep.startsWith('Present the conclusion the decider and reviewers agreed on in round 1:'),
    'the hand-back names the agreement and its round');
  ok(flat(out.nextStep).includes('(the matrix + rationale + why-not-others + trade-off + flip check)'),
    'and lists the trade-off and flip check among what to relay');
  ok(/decision-review-rN\*\.md/.test(String(out.reviewTrail)), `reviewTrail covers the focus files: ${out.reviewTrail}`);
  const { out: ranked } = await run({ analyst: ANALYST, decide: { ...DECIDE, shortlist: [{ rank: 1, title: 'in-process LRU' }, { rank: 2, title: 'redis' }] }, review: AGREE }, RANKED);
  ok(ranked.nextStep.startsWith('Present the SHORTLIST the decider and reviewers agreed on in round 1:'),
    'and so does a ranked run\'s');
  ok(flat(ranked.nextStep).includes('the combine-vs-exclusive section + the flip check)')
    && ranked.nextStep.includes('(several picks become several blocks of one plan file)'),
  'the ranked hand-back adds the flip check and keeps the several-picks note');
}

section('round 1 runs three focused reviewers in parallel, each naming its own file, in each selection');
{
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { calls } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, args);
    const r1 = calls.filter((c) => isR1(c.label));
    eq(r1.map((c) => c.label).join(','), FOCUS[sel].map((f) => `review r1 ${f}`).join(','), `${sel}: one reviewer per focus, labelled by focus`);
    ok(r1.length === 3 && r1.every((c) => c.group?.kind === 'parallel') && new Set(r1.map((c) => c.group?.id)).size === 1,
      `${sel}: the three run in one parallel() fan-out`);
    for (const f of FOCUS[sel]) {
      const p = flat(r1.find((c) => c.label === `review r1 ${f}`)?.prompt);
      ok(p.includes(`decision-review-r1-${f}.md`), `${sel}/${f}: the prompt names its own file`);
      ok(FOCUS[sel].filter((o) => o !== f).every((o) => !p.includes(`decision-review-r1-${o}.md`)), `${sel}/${f}: and no other focus's file`);
      const rederives = p.includes('re-derive every total');
      const matrixFocus = f === 'choice' || f === 'order';
      ok(rederives === matrixFocus, `${sel}/${f}: ${matrixFocus ? 're-derives the matrix' : 'leaves the matrix to the other reviewer'}`);
      ok(p.includes('Other reviewers cover the other focuses at the same time'), `${sel}/${f}: is told the other focuses are covered`);
    }
  }
}

section('round 2 runs one verifier that reads every round-1 review file, and so does the decider');
{
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { byLabel } = await run({
      analyst: ANALYST, decide: DECIDE,
      review: (label) => (isR1(label) ? gaps('p99-unproven') : AGREE),
    }, { ...args, maxRounds: 3 });
    const verifiers = byLabel('review r2');
    eq(verifiers.length, 1, `${sel}: round 2 spawns exactly one reviewer`);
    eq(verifiers[0]?.label, 'review r2', `${sel}: labelled by round alone`);
    const v = flat(verifiers[0]?.prompt);
    const d2 = flat(byLabel('decide r2')[0]?.prompt);
    for (const f of FOCUS[sel]) {
      ok(v.includes(`decision-review-r1-${f}.md`), `${sel}: the verifier is handed decision-review-r1-${f}.md`);
      ok(d2.includes(`decision-review-r1-${f}.md`), `${sel}: the round-2 decider is handed it too`);
    }
    ok(v.includes('VERIFY THE REVISION') && v.includes('decision-review-r2.md'), `${sel}: the verifier checks the folds and writes decision-review-r2.md`);
    ok(v.includes(`Re-derive the totals, ${sel === 'ranked' ? 'the order' : 'the trade-off'} and the flip check.`),
      `${sel}: the verifier re-derives what this selection's decision holds`);
    ok(d2.includes(`Then redo the totals, ${sel === 'ranked' ? 'the order' : 'the trade-off'} and the flip check.`),
      `${sel}: the decider's closing fold rule matches its selection`);
  }
}

section('every reviewer is told the severity rules, and the round-2 decider the fold rules');
{
  const RULE1 = 'Operator action means only a deliberate configuration change or command by the user that the requirements neither list as a scenario nor require the decision to provide. A path they list or require, such as a human commit, a revert or a manual apply path, is on the default path.';
  const JUDGE = { single: "Rules 1 and 2 judge the winner's design on its own: a defect the runner-up shares, or one with no measured instance on an input the requirements accept, still blocks.",
    ranked: 'Rules 1 and 2 judge each listed option on its own: a defect the runner-up shares, or one with no measured instance on an input the requirements accept, still blocks.' };
  const HOSTILE = 'Before you write a fold, test it against one hostile input of each kind it touches, such as a failure, a concurrent edit, a human-set value, state saved before the change (a legacy row, a migration, a value an older version stored), or an edit by another program that no scan has seen yet, so the fold does not open a new defect.';
  const SYMMETRIC = 'Never add a repaired variant as a new rival option. When a fold repairs one option against a defect another option shares, repair that option the same way and keep it scored in the matrix.';
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { byLabel } = await run({
      analyst: ANALYST, decide: DECIDE,
      review: (label) => (isR1(label) ? gaps('p99-unproven') : AGREE),
    }, { ...args, maxRounds: 3 });
    const reviews = promptsOf(byLabel, 'review');
    ok(reviews.length === 4, `${sel}: three round-1 reviewers and one verifier ran`);
    ok(reviews.every((p) => p.includes(RULE1)), `${sel}: every reviewer holds the rule-1 scenario sentence`);
    ok(reviews.every((p) => p.includes(JUDGE[sel])), `${sel}: every reviewer holds the "Rules 1 and 2 judge" sentence`);
    ok(reviews.every((p) => p.includes('Agree (agree=true) exactly when the Blocking section is empty.')),
      `${sel}: every reviewer agrees exactly when its Blocking section is empty`);
    const d2 = flat(byLabel('decide r2')[0]?.prompt);
    ok(d2.includes(HOSTILE), `${sel}: the round-2 decider tests each fold against the five hostile-input kinds`);
    ok(d2.includes(SYMMETRIC), `${sel}: and repairs a rival that shares the defect the same way`);
    ok(!flat(byLabel('decide r1')[0]?.prompt).includes(HOSTILE), `${sel}: round 1 has no fold to test`);
  }
}

section('the decider writes a flip check in both selections, and a trade-off in single');
{
  const { byLabel: single } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  const s = flat(single('decide r1')[0]?.prompt);
  ok(s.includes('4. TRADE-OFF:') && s.includes('5. FLIP CHECK:'), 'single: TRADE-OFF and FLIP CHECK steps');
  ok(s.includes('a `## Trade-off` section, a `## Flip check` section'), 'single: both sections are written');
  const { byLabel: ranked } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, RANKED);
  const r = flat(ranked('decide r1')[0]?.prompt);
  ok(r.includes('4. FLIP CHECK: for each adjacent pair on the list') && !r.includes('TRADE-OFF:'), 'ranked: a FLIP CHECK over adjacent pairs, no trade-off');
  ok(r.includes('"Combine / exclude" section') && r.indexOf('then the flip check') > r.indexOf('"Combine / exclude" section'),
    'ranked: the flip check is written after the combine/exclude section');
}

section('flip returns the grade, and nextStep carries the FRAGILE and DOMINANT notes in each selection');
{
  const NOTES = {
    single: {
      fragile: 'The decider graded the choice FRAGILE. Present its Flip check and Trade-off sections, since the winner turns on the input the Flip check names, and let the user settle it. ',
      dominant: 'The winner dominates the runner-up: the Trade-off section shows nothing given up. ',
    },
    ranked: {
      fragile: 'The decider graded rank 1 FRAGILE. Present its flip check, since rank 1 turns on the input it names, and let the user settle it. ',
      dominant: 'Rank 1 is at least as good as rank 2 on every criterion. ',
    },
  };
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    for (const grade of ['fragile', 'dominant']) {
      const { out, logs } = await run({ analyst: ANALYST, decide: { ...DECIDE, flip: grade }, review: AGREE }, args);
      eq(String(out.flip ?? ''), grade, `${sel}: flip returns ${grade}`);
      ok(String(out.nextStep).startsWith(NOTES[sel][grade] + 'Present the '), `${sel}: the ${grade} note leads the present sentence: ${String(out.nextStep).slice(0, 90)}`);
      ok(logs.some((l) => l.includes(`flip=${grade}, open_q=0)`)), `${sel}: the decider's log line reads flip and open_questions`);
    }
    const { out: robust } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, args);
    eq(String(robust.flip ?? ''), 'robust', `${sel}: robust is returned`);
    ok(/^Present the /.test(robust.nextStep), `${sel}: and adds no note`);
    const { out: junk, logs } = await run({ analyst: ANALYST, decide: { ...DECIDE, flip: 'shaky' }, review: AGREE }, args);
    ok(junk.flip === '', `${sel}: a grade outside the enum returns '' (got ${JSON.stringify(junk.flip)})`);
    ok(logs.some((l) => l.includes('flip=?, open_q=0)')), `${sel}: and logs as ?`);
  }
  // The flip describes the latest attested decision, never an earlier round's.
  const { out } = await run({
    analyst: ANALYST,
    decide: (label) => (/r1$/.test(label) ? { ...DECIDE, flip: 'fragile' } : { ...DECIDE, flip: 'dominant' }),
    review: (label) => (isR1(label) ? gaps('p99-unproven') : AGREE),
  }, { ...baseArgs, maxRounds: 3 });
  eq(String(out.flip ?? ''), 'dominant', 'the latest round\'s grade wins');
}

section('both escalations halt on the same status, and the decider\'s runs no reviewer');
{
  const { out, labels } = await run({ analyst: ANALYST, decide: { ...DECIDE, needs_user: true }, review: AGREE });
  eq(out.status, 'BLOCKED (needs user input)', 'the decider\'s escalation');
  ok(!labels.some((l) => l.startsWith('review')), 'it breaks BEFORE the reviewers — nothing reviews a decision that was not made');
  ok(out.needsUserFile.endsWith('NEEDS-USER.md'), 'the escalation file is named');

  const { out: byReviewer, labels: revLabels } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE, 'review r1 design': { ...gaps('rubric-contradiction'), needs_user: true } });
  eq(byReviewer.status, 'BLOCKED (needs user input)', 'one focus reviewer\'s escalation lands on the same status');
  ok(revLabels.some(isR1), 'but by a different route — the reviewers ran');
  ok(byReviewer.needsUserFile.endsWith('NEEDS-USER.md'), 'and names the same file');
  // The engine keeps no state across invocations, so a relaunch restarts, and a resume replays the halt.
  for (const halt of [out, byReviewer]) {
    ok(/relaunch with the same args and no resumeFromRunId/.test(halt.nextStep) && /round 1 and overwrites the round files/.test(halt.nextStep),
      `the halt relaunches with no resumeFromRunId and says it restarts: ${halt.nextStep.slice(-200)}`);
    ok(!/to continue/.test(halt.nextStep), 'and never promises to continue the halted run');
  }
}

section('an unattested decider or reviewer write halts, and the return names only attested files');
// A same-runId re-run restarts at round 1, so an earlier run's file can sit at the path an unattested write names.
{
  const UNATTESTED = 'BLOCKED (an agent did not confirm writing its file)';
  const { out, labels } = await run({ analyst: ANALYST, decide: { ...DECIDE, wrote_file: false }, review: AGREE });
  eq(out.status, UNATTESTED, 'an unattested decision halts on its own status');
  ok(out.halted === true && out.agreed === false, 'reported halted, never agreed');
  ok(!labels.some((l) => l.startsWith('review')), 'no reviewer judges a decision file nobody attested');
  ok(/decision-r1\.md/.test(out.haltReason), `haltReason names the file: ${out.haltReason}`);
  eq(out.decisionFile, '', 'and the return names no decision file');
  eq(out.chosen, '', 'nor a chosen option from the unattested round');
  eq(out.needsUserFile, '', 'nothing was escalated');
  ok(/no resumeFromRunId: a resume replays the cached return/.test(out.nextStep), 'nextStep relaunches with no resumeFromRunId and says why');
  ok(/Check that file, then relaunch with the same args/.test(out.nextStep), 'nextStep holds the check the status no longer gives');

  // One unattested focus reviewer: its verdict is never read, and the round's other files are not named.
  const { out: focus, labels: focusLabels } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven'), 'review r1 design': { ...gaps('p99-unproven'), wrote_file: false } });
  eq(focus.status, UNATTESTED, 'one unattested focus reviewer halts the run');
  ok(!focusLabels.includes('decide r2'), 'before any decider is sent to the unwritten review');
  ok(/decision-review-r1-design\.md/.test(focus.haltReason) && !/decision-review-r1-choice\.md/.test(focus.haltReason),
    `haltReason names that reviewer's file only: ${focus.haltReason}`);
  ok(Array.isArray(focus.reviewFiles) && focus.reviewFiles.length === 0, `no earlier round attested, so reviewFiles is empty: ${JSON.stringify(focus.reviewFiles)}`);
  eq(focus.gapRounds.length, 0, 'and the halted round\'s gaps are never recorded');

  const { out: rev, labels: revLabels } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (isR1(label) ? gaps('p99-unproven') : { ...gaps('p99-unproven'), wrote_file: false }),
  }, { ...baseArgs, maxRounds: 3 });
  eq(rev.status, UNATTESTED, 'an unattested verifier halts on the same status');
  ok(!revLabels.includes('decide r3'), 'before any decider is sent to the unwritten review');
  const kept = list(rev.reviewFiles);
  ok(kept.length === 3 && FOCUS.single.every((f, i) => String(kept[i]).endsWith(`decision-review-r1-${f}.md`)),
    `reviewFiles keeps the last attested round's files: ${JSON.stringify(rev.reviewFiles)}`);
  ok(rev.decisionFile.endsWith('decision-r2.md'), 'and the attested round-2 decision');
  ok(/decision-review-r2\.md/.test(rev.haltReason), 'haltReason names the unattested review');
  eq(rev.gapRounds.length, 1, 'the unattested review\'s gaps are never recorded');

  const { out: esc } = await run({ analyst: ANALYST, decide: { ...DECIDE, wrote_file: false, needs_user: true }, review: AGREE });
  eq(esc.status, 'BLOCKED (needs user input)', 'a decider escalation keeps its own terminal');
  eq(esc.decisionFile, '', 'and still names no unattested decision file');
}

section('the rubric is a planPath only: an inline requirements arg throws, and every role names the file');
{
  const { planPath, ...noRubric } = baseArgs;
  const PLANPATH_REQUIRED = /^args\.planPath is required/;
  const inline = await throwsWith(ENGINE, { args: { ...noRubric, requirements: '## Decision\nWhich cache layer?' }, respond: {} });
  ok(PLANPATH_REQUIRED.test(inline), `an inline requirements arg with no planPath throws the planPath message: ${inline.slice(0, 60)}`);
  const neither = await throwsWith(ENGINE, { args: noRubric, respond: {} });
  ok(PLANPATH_REQUIRED.test(neither), `no rubric at all throws the same message: ${neither.slice(0, 60)}`);

  const { prompt } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  for (const role of ['analyst', 'decide', 'review']) {
    ok(prompt(role).includes(`the requirements at ${planPath}`), `the ${role} prompt names the planPath`);
    ok(!prompt(role).includes('the requirements below'), `the ${role} prompt carries no inline rubric`);
  }
}

section('a solo agent that dies throws — it must never read as a decision nobody made');
{
  const dead = await throwsWith(ENGINE, { args: baseArgs, respond: { analyst: ANALYST, decide: null } });
  ok(/Decider returned nothing/.test(dead) && /resumeFromRunId/.test(dead), `dead decider throws with the resume hint: ${dead.slice(0, 50)}`);
  const deadRev = await throwsWith(ENGINE, { args: baseArgs, respond: { analyst: ANALYST, decide: DECIDE, review: null } });
  ok(/Reviewer returned nothing/.test(deadRev) && /resumeFromRunId/.test(deadRev), `dead reviewer too: ${deadRev.slice(0, 50)}`);
  // One dead focus reviewer is enough: two live verdicts never stand in for the third focus.
  const deadFocus = await throwsWith(ENGINE, { args: baseArgs, respond: { analyst: ANALYST, decide: DECIDE, review: AGREE, 'review r1 requirements': null } });
  ok(/^Reviewer returned nothing in round 1 \(review r1 requirements: agent skipped or died\)/.test(deadFocus),
    `one dead focus reviewer throws naming its label: ${deadFocus.slice(0, 90)}`);
  const deadVerifier = await throwsWith(ENGINE, { args: { ...baseArgs, maxRounds: 3 }, respond: { analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven'), 'review r2': null } });
  ok(/^Reviewer returned nothing in round 2 \(review r2: agent skipped or died\)/.test(deadVerifier),
    `a dead verifier throws naming its label: ${deadVerifier.slice(0, 90)}`);
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
// Blocking versus caveat: what agreement means, and how a caveat reaches the plan.
// ---------------------------------------------------------------------------------------------

section('agreement with a caveat ends "decided with caveats", and the return carries them');
{
  const { out, logs } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE, 'review r1 design': caveats('retry-unbounded') });
  eq(out.status, 'decided with caveats (no blocking gap, and the reviews list caveats for the plan)', 'status');
  ok(out.agreed === true, 'it is an agreement');
  eq(out.caveats, 1, 'the run-wide caveat count');
  const files = list(out.caveatFiles);
  ok(files.length === 1 && String(files[0]).endsWith('decision-review-r1-design.md'), `caveatFiles names only the file that holds it: ${JSON.stringify(out.caveatFiles)}`);
  ok(String(out.nextStep).startsWith(`Carry the 1 caveat(s) under "## Caveats" in ${files[0]} into the plan's design section.`),
    `nextStep leads with the caveat note: ${String(out.nextStep).slice(0, 120)}`);
  ok(/each is a gap the plan must close, so refine the plan before building\. Present the conclusion/.test(String(out.nextStep)),
    'and the present sentence follows it');
  eq(JSON.stringify(out.gapRounds?.[0]), JSON.stringify({ round: 1, gaps: 0, new: 0, repeated: 0, caveats: 1 }), 'gapRounds counts the caveat');
  ok(logs.some((l) => /✓ r1: reviewers AGREE — no blocking gap \(1 caveat\(s\) this round\)/.test(l)), 'the agree line reports the caveat count');

  const { out: clean } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(clean.status, 'decided (decider + reviewers agree)', 'no caveat: the plain agreed status');
  ok(clean.caveats === 0 && Array.isArray(clean.caveatFiles) && clean.caveatFiles.length === 0, 'with no caveats and no caveat files');
  ok(!/caveat\(s\) under/.test(clean.nextStep), 'and no caveat note');

  // Notes compose in order: the audit, the flip note, the caveat note, then the present sentence.
  const { out: all } = await run({ analyst: ANALYST, decide: { ...DECIDE, flip: 'fragile', meets_all_requirements: false }, review: AGREE, 'review r1 choice': caveats('retry-unbounded') });
  const n = String(all.nextStep);
  const at = ['The decider itself reported', 'The decider graded the choice FRAGILE', 'Carry the 1 caveat(s)', 'Present the conclusion'].map((s) => n.indexOf(s));
  ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `audit, flip, caveat, present, in that order: ${n.slice(0, 160)}`);
}

section('a caveat raised in an earlier round still reaches the agreed return');
{
  const { out, logs } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (label === 'review r1 choice' ? { ...gaps('p99-unproven'), caveat_ids: ['wording-loose'] } : AGREE),
  }, { ...baseArgs, maxRounds: 3 });
  eq(out.status, 'decided with caveats (no blocking gap, and the reviews list caveats for the plan)', 'the round-1 caveat survives a clean round 2');
  const files = list(out.caveatFiles);
  ok(files.length === 1 && String(files[0]).endsWith('decision-review-r1-choice.md'), `caveatFiles names the round-1 file: ${JSON.stringify(out.caveatFiles)}`);
  const last = list(out.reviewFiles);
  ok(last.length === 1 && String(last[0]).endsWith('decision-review-r2.md'), 'while reviewFiles names only the latest round');
  eq(out.gapRounds?.[0]?.caveats, 1, 'round 1 counts its caveat');
  ok(logs.some((l) => /↻ r1: 1 blocking gap\(s\) — 1 new, 0 repeated, 1 caveat\(s\) → decider revises/.test(l)), 'the revise line names blocking gaps and caveats');
}

section('a slug one reviewer blocks on and another lists as a caveat counts as blocking only');
{
  const { out } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: AGREE, 'review r1 choice': gaps('reopen-deletes-row'), 'review r1 design': caveats('reopen-deletes-row'),
  }, { ...baseArgs, maxRounds: 1 });
  eq(JSON.stringify(out.gapRounds?.[0]), JSON.stringify({ round: 1, gaps: 1, new: 1, repeated: 0, caveats: 0 }), 'one blocking gap, no caveat');
  eq(out.caveats, 0, 'the run-wide count skips it');
  ok(Array.isArray(out.caveatFiles) && out.caveatFiles.length === 0, 'and the design file is no caveat file, since its only caveat did not count');

  const { out: mixed } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: AGREE, 'review r1 choice': gaps('reopen-deletes-row'), 'review r1 design': caveats('reopen-deletes-row', 'log-noisy'),
  }, { ...baseArgs, maxRounds: 1 });
  eq(mixed.gapRounds?.[0]?.caveats, 1, 'its other caveat still counts');
  ok(list(mixed.caveatFiles).length === 1 && String(mixed.caveatFiles[0]).endsWith('decision-review-r1-design.md'), 'so the file is a caveat file');
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
    review: (label) => (isR1(label) ? gaps('p99-unproven') : gaps('p99-unproven', 'lru-citation-stretched', 'no-hybrid-considered')),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.gapRounds?.length, 2, 'one entry per review round');
  eq(JSON.stringify(out.gapRounds?.[0]), JSON.stringify({ round: 1, gaps: 1, new: 1, repeated: 0, caveats: 0 }),
    'round 1 can only be new — nothing preceded it, and three reviewers naming one slug are one gap');
  eq(JSON.stringify(out.gapRounds?.[1]), JSON.stringify({ round: 2, gaps: 3, new: 2, repeated: 1, caveats: 0 }),
    'counts only (#8) — the gaps themselves stay in the review files');
  ok(logs.some((l) => /3 blocking gap\(s\) — 2 new, 1 repeated/.test(l)), 'and the round line shows the split');

  // An agreeing round is still a round: 0 gaps is a real observation, not a missing entry.
  const { out: converged } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (isR1(label) ? gaps('p99-unproven') : AGREE),
  }, { ...baseArgs, maxRounds: 3 });
  eq(converged.gapRounds?.length, 2, 'the agreeing round is recorded too');
  eq(converged.gapRounds?.[1]?.gaps, 0, 'with no gaps');
  eq(converged.status, 'decided (decider + reviewers agree)', 'and the agree-gate still ends the loop');
}

section('a final round of REPEATS says the decider is not resolving them, and names each one\'s first review');
{
  const { out } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: gaps('p99-unproven', 'lru-citation-stretched'),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.gapRounds?.[1]?.repeated, 2, 'every gap in the last round was already on the table');
  ok(/not RESOLVING/.test(out.nextStep), 'nextStep says which of the two failures this is');
  ok(/re-raised 2 blocking gap\(s\)/.test(out.nextStep), 'counting blocking gaps');
  ok(/p99-unproven/.test(out.nextStep) && /lru-citation-stretched/.test(out.nextStep), 'naming the repeated gaps');
  ok(!/UNDER-SPECIFIED/.test(out.nextStep), 'and does NOT also offer the opposite diagnosis');

  // The first review file is the first reviewer, in focus order, whose return lists the slug.
  const { out: first } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (label === 'review r1 choice' ? gaps('p99-unproven')
      : label === 'review r1 requirements' ? AGREE
        : gaps('p99-unproven', 'lru-citation-stretched')),
  }, { ...baseArgs, maxRounds: 2 });
  ok(/p99-unproven, first raised in \S*decision-review-r1-choice\.md/.test(first.nextStep), `a slug two reviewers raised names the earlier focus: ${first.nextStep.slice(0, 260)}`);
  ok(/lru-citation-stretched, first raised in \S*decision-review-r1-design\.md/.test(first.nextStep), 'a slug only the design reviewer raised names its file');
}

section('a final round of NEW gaps says the folds open new defects or the question is under-specified');
{
  const { out } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (isR1(label) ? gaps('p99-unproven', 'lru-citation-stretched') : gaps('cost-axis-missing', 'no-hybrid-considered')),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.gapRounds?.[1]?.new, 2, 'nothing from round 1 came back');
  ok(flat(out.nextStep).includes('The final review raised 2 blocking gap(s) no earlier round did, so every round finds fresh ground. Either the folds open new defects or the question is UNDER-SPECIFIED, and that review\'s WHERE NEXT section says which.'),
    `the NEW diagnosis names both causes and where to tell them apart: ${out.nextStep.slice(0, 260)}`);
  ok(!/not RESOLVING/.test(out.nextStep), 'and only that one');
  ok(/decision-review-r2\.md/.test(out.nextStep), 'it points at the last review');
  ok(flat(out.nextStep).includes('starting with the WHERE NEXT section of each review that did not agree, which says whether the folds open new defects or names the one requirement change that would let a decision converge'),
    'and starts the user at each disagreeing review\'s WHERE NEXT');
}

section('round 1 carries no slug list; later rounds carry the prior rounds\' slugs, caveats included');
{
  const { byLabel } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: (label) => (isR1(label) ? { ...gaps('p99-unproven'), caveat_ids: ['wording-loose'] } : gaps('p99-unproven', 'cost-axis-missing')),
  }, { ...baseArgs, maxRounds: 3 });
  const [p1] = promptsOf(byLabel, 'review r1');
  const [p2] = promptsOf(byLabel, 'review r2');
  const [p3] = promptsOf(byLabel, 'review r3');
  ok(!/AS SLUGS/.test(p1), 'round 1 has no earlier round, so it is given no list at all');
  ok(/AS SLUGS/.test(p2) && /p99-unproven/.test(p2), 'round 2 gets round 1\'s slug');
  ok(/wording-loose/.test(p2 ?? ''), 'and its caveat slug, so a re-raised caveat reuses it');
  ok(/cost-axis-missing/.test(p3), 'and round 3 gets the ones round 2 added');
  ok(/reuse its slug verbatim/.test(p2), 'with the instruction that makes a repeat detectable — reuse the slug for the same issue');
}

section('the FINAL round is told to write the new WHERE NEXT, and a final verifier to walk every non-negotiable');
// The engine cannot write the file (the harness has no tools), so "a stalled run hands back somewhere to
// go" is only true if the last reviewer was asked for it. That makes it a contract, not a hope.
{
  const WHERE = 'If you do NOT agree, END that file with a `## WHERE NEXT` section. Say whether the open blocking gaps sit in text the latest revision changed, so the folds open new defects, or in a requirement the rubric does not settle';
  const CHANGE = 'name the ONE requirement and the ONE change to it (a weight, a non-negotiable\'s depth, a missing criterion) that would let a decision converge.';
  const WALK = 'Before you write, walk every non-negotiable over the entire design, unchanged text included.';
  const { byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven') }, { ...baseArgs, maxRounds: 2 });
  const r1 = promptsOf(byLabel, 'review r1');
  const [v] = promptsOf(byLabel, 'review r2');
  ok(r1.length === 3 && r1.every((p) => !/WHERE NEXT/.test(p)), 'round 1 is not — another decider round follows it');
  ok(String(v).includes(WHERE) && String(v).includes(CHANGE), 'the final verifier carries the new WHERE NEXT text');
  ok(String(v).includes(WALK), 'and walks every non-negotiable over the entire design');

  const { byLabel: one } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven') }, { ...baseArgs, maxRounds: 1 });
  const finals = promptsOf(one, 'review r1');
  ok(finals.length === 3 && finals.every((p) => p.includes(WHERE) && p.includes(CHANGE)), 'a final round-1 reviewer carries it too');
  ok(finals.every((p) => !p.includes(WALK)), 'but no walk: the requirements reviewer already covers it');
}

section('the decider cites what rules out each option it rejects, and what would reverse it, in both selections');
{
  const RULE = 'Each option you rule out, by a non-negotiable or as a runner-up, cites what rules it out and names the one observation that would reverse that.';
  for (const args of [baseArgs, RANKED]) {
    const { byLabel } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE }, args);
    const p = byLabel('decide')[0].prompt.replace(/\s+/g, ' ');
    ok(p.includes(RULE), `${args.selection ?? 'single'}: the decider is told to cite and reverse each ruled-out option`);
  }
}

section('the gap ids are the only gap count, and garbage ids are filtered');
{
  const { calls, logs } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('a', 'b') }, { ...baseArgs, maxRounds: 2 });
  ok(logs.some((l) => /r1: 2 blocking gap\(s\) — 2 new, 0 repeated, 0 caveat\(s\) → decider revises/.test(l)), 'round 1 logs the number of ids it was given');
  ok(logs.some((l) => /r2: 2 blocking gap\(s\).*still open at round budget/.test(l)), 'and the last round logs it beside the round budget');
  const review = calls.find((c) => isR1(c.label));
  ok(review && !('gap_count' in review.opts.schema.properties) && !review.opts.schema.required.includes('gap_count'),
    'the review schema neither has nor requires gap_count');
  ok(review && review.opts.schema.required.includes('caveat_ids'), 'and requires caveat_ids');
  ok(review && !review.prompt.includes('gap_count'), 'and the review prompt never names it');

  const { out: junk } = await run({
    analyst: ANALYST, decide: DECIDE,
    review: { ...AGREE, agree: false, gap_ids: ['ok-slug', '', 42, null, 'ok-slug'], caveat_ids: ['c', '', 7, 'c'] },
  }, { ...baseArgs, maxRounds: 1 });
  eq(junk.gapRounds?.[0]?.gaps, 1, 'blanks, non-strings and a slug repeated inside ONE round all collapse to the one real gap');
  eq(junk.gapRounds?.[0]?.caveats, 1, 'and caveat slugs are filtered the same way');

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
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'simplest', stage: 'diverge' }]), 'the dead lens is in failed at the diverge stage');
  ok(!('phase' in out), 'the return has no phase key');
  eq(out.lensFiles.length, 1, 'and only the surviving lens file is listed');
  ok(/left out of the decision: simplest\./.test(out.nextStep), `nextStep names the dropped lens: ${out.nextStep.slice(-120)}`);
  // No arg selects lenses to redo, and a same-runId relaunch overwrites the decision this nextStep presents.
  ok(/relaunch under a new runId/.test(out.nextStep), 'nextStep sends the relaunch to a new runId');
  ok(!/Re-run them with the same runId/.test(out.nextStep), 'and never to a per-lens same-runId re-run');

  const { out: full } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(JSON.stringify(full.failed), '[]', 'a full run has an empty failed list');
  ok(!/left out of the decision/.test(full.nextStep), 'and no dropped-lens sentence');

  // A halt's relaunch reruns every lens, so the agreed and stalled terminals' relay-first advice does not apply.
  for (const decide of [{ ...DECIDE, needs_user: true }, { ...DECIDE, wrote_file: false }]) {
    const { out: halt } = await run({ analyst: ANALYST, 'analyst:simplest': null, decide, review: AGREE });
    ok(halt.halted === true, 'a run that drops a lens can still halt');
    ok(/left out of the decision: simplest\./.test(halt.nextStep), `a halt's nextStep names the dropped lens: ${halt.nextStep.slice(-200)}`);
    ok(/relaunch with the same args redoes them/.test(halt.nextStep), 'and says the halt\'s relaunch redoes it');
    ok(!/Relay this run's decision first|new runId/.test(halt.nextStep), 'and never sends a halt to relay first or to a new runId');
  }
}

section('a one-round stall gets no churn diagnosis: the decider never had a round to address a gap');
{
  const { out } = await run({ analyst: ANALYST, decide: DECIDE, review: gaps('p99-unproven') }, { ...baseArgs, maxRounds: 1 });
  ok(!/UNDER-SPECIFIED/.test(out.nextStep), 'not UNDER-SPECIFIED');
  ok(!/not RESOLVING/.test(out.nextStep), 'not "not RESOLVING" either');
  // The two remedies need opposite cache modes: a resume never reads an edited rubric, a restart drops the finished rounds.
  ok(/Refine the requirements, then relaunch with the same args and no resumeFromRunId/.test(out.nextStep)
    && /a resume would replay the cached returns and never read the edit/.test(out.nextStep), 'refining relaunches with no resumeFromRunId');
  ok(/raise maxRounds and relaunch with the same args plus the Workflow tool's resumeFromRunId/.test(out.nextStep)
    && /continues past round 1\./.test(out.nextStep), 'raising maxRounds resumes from cache past the finished round');
  ok(FOCUS.single.every((f) => out.nextStep.includes(`decision-review-r1-${f}.md`)), 'and it names every review file of the round');
}

section('an empty ranked shortlist or a blank chosen replaces the earlier round\'s, never carries it over');
// The return pairs shortlist with decisionFile, which names the LATEST round's file.
{
  const SHORT = { ...DECIDE, shortlist: [{ rank: 2, title: 'redis' }, { rank: 1, title: 'in-process LRU' }] };
  const { out } = await run({
    analyst: ANALYST,
    decide: (label) => (/r1$/.test(label) ? SHORT : { ...SHORT, chosen: '', shortlist: [] }),
    review: gaps('p99-unproven'),
  }, { ...RANKED, maxRounds: 2 });
  ok(out.decisionFile.endsWith('decision-r2.md'), 'the return names round 2\'s decision file');
  eq(JSON.stringify(out.shortlist), '[]', 'and round 2\'s empty shortlist, not round 1\'s');
  eq(out.chosen, '', 'and round 2\'s blank chosen');

  const { out: r1 } = await run({ analyst: ANALYST, decide: SHORT, review: AGREE }, RANKED);
  eq(r1.shortlist.map((s) => s.rank).join(','), '1,2', 'a non-empty shortlist is still sorted by rank');
}

section('an agree that lists blocking gaps is flagged, not trusted silently, and names that reviewer\'s file');
// Flag, not halt (tests/CLAUDE.md §3): the decision is the last step, so the harm cannot compound.
{
  const { out, logs } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE, 'review r1 design': { ...AGREE, gap_ids: ['x'] } });
  eq(out.status, 'decided (decider + reviewers agree)', 'the status is unchanged');
  ok(logs.some((l) => /reviewers AGREE but list 1 blocking gap\(s\) — self-contradictory; audit \S*decision-review-r1-design\.md$/.test(l)), 'the contradiction is logged with that reviewer\'s file only');
  eq(out.contradicted, true, 'and returned');
  ok(/^A reviewer agreed while listing blocking gaps: audit \S*decision-review-r1-design\.md before presenting\./.test(out.nextStep), `nextStep leads with the audit: ${out.nextStep.slice(0, 140)}`);

  const { out: clean } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(clean.contradicted, false, 'a clean agree is not flagged');
  ok(/^Present the conclusion/.test(clean.nextStep), 'and its nextStep is unchanged');
}

section('an agree over a decision the decider says misses a requirement is flagged');
{
  const { out, logs } = await run({ analyst: ANALYST, decide: { ...DECIDE, meets_all_requirements: false }, review: AGREE });
  eq(out.status, 'decided (decider + reviewers agree)', 'the status is unchanged');
  eq(out.meetsAllRequirements, false, 'the decider\'s attestation is returned');
  ok(logs.some((l) => /reviewers AGREE but the decider reported meets_all_requirements=false — audit .*decision-r1\.md/.test(l)), 'the contradiction is logged');
  ok(/^The decider itself reported that the conclusion does not meet every requirement: check .*decision-r1\.md before presenting\./.test(out.nextStep), 'nextStep leads with the check');

  const { out: ranked } = await run({ analyst: ANALYST, decide: { ...DECIDE, meets_all_requirements: false, shortlist: [] }, review: AGREE }, RANKED);
  ok(/a shortlisted option does not meet every requirement/.test(ranked.nextStep), 'ranked mode names a shortlisted option');

  const { out: both } = await run({ analyst: ANALYST, decide: { ...DECIDE, meets_all_requirements: false }, review: { ...AGREE, gap_ids: ['x'] } });
  ok(/^A reviewer agreed while listing blocking gaps: .* The decider itself reported/.test(both.nextStep), 'both caveats compose, reviewer first');

  const { out: ok1 } = await run({ analyst: ANALYST, decide: DECIDE, review: AGREE });
  eq(ok1.meetsAllRequirements, true, 'a met rubric returns true');
}

await pinRoleMaps({
  engine: ENGINE, name: 'decide', defaults: { analyst: 'sonnet', decide: 'opus', review: 'opus' },
  runs: [{ args: baseArgs, respond: { analyst: ANALYST, decide: DECIDE, review: AGREE }, labels: { analyst: 'analyst', decide: 'decide', review: 'review' } }],
});
