// investigate/investigate-cycle.mjs — bounded exhaustive search with memory.
// Focus: the FIVE terminal statuses, each asserted as a whole literal. "Ran out of rounds", "ran out of
// tokens" and "nothing can qualify" are three different facts, and a test that asserts only "the loop
// ended" passes just as well when the engine reports the wrong one — which is exactly how fatigue would
// come to masquerade as a proof. After that: the critic gate, dead agents (a dead investigator must
// never read as an exhausted search), and what the prompts actually name.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/investigate/investigate-cycle.mjs';

const baseArgs = { runId: 't', root: 'E:/r', criteria: '## Question\nQ\n## Acceptance Criteria\n- c1' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// A quiet round: nothing found, nothing claimed. Spread over it to script the interesting cases.
const INV  = { wrote_files: true, new_options: 0, disqualified_added: 0, exhausted: false, no_solution: false, needs_user: false, option_ids: [] };
const CRIT = { wrote_file: true, upheld: [], disqualified: [], contests_exhaustion: false, agree: false, needs_user: false };

section('a dead investigator throws — it must never read as an exhausted search');
// "Found nothing, swept everything" is the exact shape of a dead agent's return. Laundering it would
// report a proof of absence the engine never obtained.
{
  const msg = await throwsWith(ENGINE, { args: baseArgs, respond: { 'investigate': null } });
  ok(/Investigator returned nothing/.test(msg) && /NOT an exhausted search/.test(msg) && /resumeFromRunId/.test(msg),
    `throws, says it is not exhaustion, and carries the resume hint: ${msg.slice(0, 60)}`);
}

section('a dead run-phase critic throws — its options are unverified, not upheld');
{
  const msg = await throwsWith(ENGINE, {
    args: baseArgs,
    respond: { 'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] }, 'critique': null },
  });
  ok(/Acceptance critic returned nothing/.test(msg) && /resumeFromRunId/.test(msg),
    `throws with the resume hint: ${msg.slice(0, 60)}`);
}

section('a dead refine-phase criteria critic throws rather than passing the criteria');
// The one phase whose entire job is finding what is missing: "no gaps" and "no critic" must never look
// the same to the caller (feature-cycle's `critique?.verdict ?? 'ready'` shape is what NOT to copy).
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, phase: 'refine' }, respond: { 'criteria-critic': null } });
  ok(/Criteria critic returned nothing/.test(msg) && /NOT a clean bill of health/.test(msg),
    `throws instead of reporting sound criteria: ${msg.slice(0, 60)}`);
}

section('phase:"refine" stops at its critic and writes nothing');
// Case 3 alone cannot catch a refine phase that spawns its critic and then falls through into the search
// loop — it throws on the null either way. This is the case that pins the phase boundary.
{
  const { out, calls } = await run({
    'criteria-critic': {
      gaps: [{ title: 'no evidence standard' }],
      questions: [{ question: 'which runtime?' }],
      unfalsifiable: [{ criterion: 'must be maintainable', why: 'no evidence settles it' }],
    },
  }, { ...baseArgs, phase: 'refine' });
  eq(calls.length, 1, 'one critic, and the phase stops there — no investigator');
  eq(out.gaps.length, 1, 'gaps come back on the return');
  eq(out.questions.length, 1, 'questions too');
  eq(out.unfalsifiable.length, 1, 'and the unfalsifiable criteria — this phase\'s distinctive finding');
  ok(!JSON.stringify(out).includes('runs/'), 'the return names no written file — refine writes nothing');
  ok(/AskUserQuestion/.test(out.nextStep) && /phase:"run"/.test(out.nextStep),
    'nextStep relays the blocking questions first, then routes back into the criteria file');

  // An unfalsifiable criterion with no blocking question still has to be routed: it is the one finding
  // that makes the search loop unable to converge at all, so it may not fall through as "sound".
  const { out: quiet } = await run({
    'criteria-critic': { gaps: [], questions: [], unfalsifiable: [{ criterion: 'must be popular' }] },
  }, { ...baseArgs, phase: 'refine' });
  ok(/REPLACE every unfalsifiable criterion/.test(quiet.nextStep), 'an unfalsifiable criterion alone still routes back into the criteria');
}

section('a contested exhaustion claim buys another round, and the search can still run out of rounds');
{
  const { out, labels, byLabel } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique': { ...CRIT, contests_exhaustion: true },
  }, { ...baseArgs, maxRounds: 3 });
  ok(labels.includes('investigate r2'), 'the contested claim forced a second investigator round');
  eq(byLabel('investigate').length, 3, 'and it spun to the round bound');
  eq(out.status, 'not exhaustive (round budget spent)', 'status');
  ok(out.exhaustive === false && out.determination === '', 'nothing is reported as exhaustive, and no DETERMINATION.md is named');
}

section('an uncontested exhaustion claim ends the loop before the round budget');
{
  const { out, byLabel } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 4 });
  eq(byLabel('investigate').length, 1, 'ended on round 1, well inside maxRounds=4');
  eq(out.status, 'exhaustive (search closed, critic agreed)', 'status');
  ok(out.exhaustive === true && out.determination.endsWith('DETERMINATION.md'), 'the determination file is surfaced');
}

section('a round that adds nothing and claims nothing skips the critic');
{
  const { labels } = await run({ 'investigate': INV }, { ...baseArgs, maxRounds: 1 });
  ok(labels.includes('investigate r1'), 'the investigator ran');
  ok(!labels.some((l) => l.startsWith('critique')), 'no critic spawned over nothing');
}

section('an escalation with new options is vetted BEFORE the halt is honored');
// The one exit that could otherwise hand the user an option nobody checked. The critic runs first, and
// only its upheld ids reach the return.
{
  const { out, labels } = await run({
    'investigate': { ...INV, new_options: 2, option_ids: ['opt-good', 'opt-bad'], needs_user: true },
    'critique': { ...CRIT, upheld: ['opt-good'], disqualified: ['opt-bad'] },
  });
  ok(labels.includes('critique r1'), 'the critic ran before the halt');
  eq(out.status, 'BLOCKED (needs user input)', 'status');
  eq(out.options.join(), 'opt-good', 'only the upheld option is surfaced');
  ok(!JSON.stringify(out).includes('opt-bad'), 'the disqualified id appears NOWHERE in the return');
  ok(out.needsUserFile.endsWith('NEEDS-USER.md'), 'the escalation file is named');
}

section('a verified no-solution gets its own status, not the round-budget one');
{
  const { out } = await run({
    'investigate': { ...INV, no_solution: true },
    'critique': { ...CRIT, agree: true },
  });
  eq(out.status, 'no qualifying option exists (verified)', 'status');
  ok(out.noSolution === true && out.exhaustive === false, 'reported as a verified dead end, not as an exhaustive search');
  ok(/relaxing one criterion|relaxing a criterion|relax/.test(out.nextStep), 'nextStep tells the operator the only thing that changes the answer');
}

section('required args throw, and the two throws cannot pass on each other\'s message');
{
  const rootMsg = await throwsWith(ENGINE, { args: { runId: 't', criteria: 'c' } });
  ok(/args\.root is required/.test(rootMsg) && !/acceptance criteria/.test(rootMsg), `missing root: ${rootMsg.slice(0, 50)}`);
  const critMsg = await throwsWith(ENGINE, { args: { runId: 't', root: 'E:/r' } });
  ok(/acceptance criteria the search qualifies/.test(critMsg) && !/args\.root is required/.test(critMsg), `neither criteria nor planPath: ${critMsg.slice(0, 50)}`);
  // The criteria guard is UNCONDITIONAL, so refine hits the very same one. A refine-only "with neither"
  // branch would be dead code sitting behind this throw, and its test would pass on this error.
  const refineMsg = await throwsWith(ENGINE, { args: { runId: 't', root: 'E:/r', phase: 'refine' } });
  eq(refineMsg, critMsg, 'refine hits the same guard — there is no second, drift-prone copy of it');
}

section('the token budget stops cleanly between rounds');
{
  const { out, calls } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(calls.length, 0, 'stopped before spawning anything');
  eq(out.status, 'stopped on token budget (resume where it left off)', 'status');
  ok(/same runId/.test(out.haltReason) && /DISQUALIFIED\.md/.test(out.haltReason),
    'halt reason carries the resume hint and names the ledger the resume reads');
}

section('the per-round log counts BOTH writers into the ledger');
// This line is the only consumer of disqualified_added + disqualified, and the operator's only signal
// that the search is learning rather than circling. Without it both schema fields are unread.
{
  const { logs } = await run({
    'investigate': { ...INV, new_options: 1, disqualified_added: 3, option_ids: ['opt-a'] },
    'critique': { ...CRIT, upheld: ['opt-a'], disqualified: ['opt-b'] },
  }, { ...baseArgs, maxRounds: 1 });
  ok(logs.some((l) => /\+1 option\(s\), 4 disqualified/.test(l)),
    'the round line sums the investigator\'s 3 and the critic\'s 1');
}

section('the investigator prompt names the ledger every round, and a review file only when one exists');
{
  const quiet = await run({ 'investigate': INV }, { ...baseArgs, maxRounds: 2 });
  const p1 = quiet.byLabel('investigate')[0].prompt;
  const p2 = quiet.byLabel('investigate')[1].prompt;
  ok(p1.includes('DISQUALIFIED.md') && p1.includes('/options'), 'r1 names the ledger + the options dir');
  ok(p2.includes('DISQUALIFIED.md') && p2.includes('/options'), 'r2 names them again — the memory is re-read every round');
  ok(!p2.includes('acceptance-review-r1.md'), 'after a skipped-critic round it names NO review file');

  const busy = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': CRIT,
  }, { ...baseArgs, maxRounds: 2 });
  ok(busy.byLabel('investigate')[1].prompt.includes('acceptance-review-r1.md'),
    'and it DOES name the review file after a round that wrote one');
  ok(busy.prompt('critique').includes('opt-a'), 'the critic is told exactly which option ids to verify');
}

section('every role prompt carries the read-only contract');
// Read-only is the whole license this workflow runs under; asserting it makes it testable rather than
// aspirational. prompt(prefix) returns the FIRST matching call, so refine needs its own run.
{
  const runPhase = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': CRIT,
  }, { ...baseArgs, maxRounds: 1 });
  const refinePhase = await run({ 'criteria-critic': {} }, { ...baseArgs, phase: 'refine' });
  const LINE = 'Do NOT modify any repo, stage, or commit.';
  ok(runPhase.prompt('investigate').includes(LINE), 'investigator');
  ok(runPhase.prompt('critique').includes(LINE), 'critic');
  ok(refinePhase.prompt('criteria-critic').includes(LINE), 'criteria critic');
}
