// refine/refine-cycle.mjs — the convergence loop's failure battery.
// Focus: everything that is NOT a clean round. This loop's ONLY success signal is "a critic ran, read the
// ledger, and found nothing at or above the floor", and every case below is a way that signal can be
// forged — a critic that died, a critic that reports findings it never wrote down, an editor that reports
// folds that reached no file, a fold that left the plan unparseable, and garbage counts that would make a
// NaN ledger read as a clean one. The happy path is exercised by real runs (tests/CLAUDE.md §6).
//
// Deliberately NOT duplicated here, because each is a CROSS-ENGINE table a per-engine copy would drift
// from: the per-role dead-agent sweep (dead-agent.test.mjs), the numeric-bound sweep (static.test.mjs),
// and role/throw/terminal coverage (flow-coverage.test.mjs). What the arg cases below add is the ROUND
// ordering those tables cannot see — the throw lands before the first opus critic is ever spawned.
import { runEngine, runTrace, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/refine/refine-cycle.mjs';

// planPath resolves OUTSIDE the target repo, which is what keeps the plan and the critique files away
// from develop-cycle's blind reviewer. A path inside the repo only warns, so it would prove nothing here.
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, planPath: 'E:/plans/bus.md' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// The same healthy returns as tools/flows/refine.flow.mjs, with the editor's `declined` pinned to 0 so
// the ledger-sum case below is the only place that varies it.
const CLEAN     = { wrote_file: false, gap_count: 0, question_count: 0 };
const GAPS      = { wrote_file: true, gap_count: 2, question_count: 0 };
const QUESTIONS = { wrote_file: true, gap_count: 0, question_count: 1 };
const UNWRITTEN = { wrote_file: false, gap_count: 2, question_count: 0 };
const FOLD_OK   = { wrote_file: true, folded: 2, declined: 0, plan_parses: true };

// Every terminal state is its own fact, so each is asserted verbatim rather than by a substring: folding
// any pair of them together is how an unconverged plan gets handed to a build engine as a finished one.
const CONVERGED     = 'converged (one clean round: no gaps at or above the floor, no questions)';
const FRESH         = 'relaunch as a FRESH run (same runId and stateDir, NO resumeFromRunId - a resume replays the cached return and halts the same way)';
const NEEDS_ANSWERS = `needs-answers (the critic raised questions only the operator can settle - restructure the plan, then ${FRESH})`;
const CONTESTED     = `dismissal-contested (the editor escalated a contested dismissal to NEEDS-USER.md - record the user's ruling by folding the gap into the plan or by appending "<block id> - <gap gist> - USER-RULED: <reason>" to DISMISSED-PLAN.md, then ${FRESH})`;
const EXHAUSTED     = 'rounds-exhausted (gaps were still being found at the round budget - the plan is NOT converged)';
const EDITOR_DEAD   = 'BLOCKED (the plan editor returned nothing - it was skipped or died and may have partly edited the plan file; run the plan-block --list check on it first, then relaunch with the same args plus the Workflow tool\'s resumeFromRunId to replay the cached critic and redo the fold - a relaunch without it restarts at round 1)';
const NO_CRITIQUE   = `BLOCKED (the critic returned findings but did not confirm writing its critique file - the findings exist nowhere; ${FRESH} to redo the round)`;
const NO_FOLD       = `BLOCKED (the editor reported folded gaps but did not confirm writing the plan file - the fold exists nowhere; inspect the plan, then ${FRESH})`;
const PLAN_BROKEN   = `BLOCKED (the folded plan file no longer parses - every later consumer reads it, so repair it by hand, then ${FRESH})`;

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);

// ---------------------------------------------------------------------------------------------
// Convergence — the two shapes that legitimately end the loop
// ---------------------------------------------------------------------------------------------
section('a clean first round converges, and is the one path that spawns no editor at all');
{
  const { out, labels, byLabel } = await run({ 'plan-critic': CLEAN });
  eq(byLabel('plan-critic').length, 1, 'one critic ran');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'and no editor — a clean round has nothing to fold');
  eq(out.status, CONVERGED, 'status');
  eq(out.rounds, 1, 'on round 1');
  eq(out.openGaps, 0, 'with no open gaps');
  eq(out.lastCritique, '', 'and no critique file named — a clean round legitimately writes none');
}

section('an FYI-only round writes its critique file and still converges, naming that file');
// One rule for the critic: below-floor findings need the file, so an FYI-only round writes it and returns
// zero counts. The engine must read that as convergence, not as a round with something to fold.
{
  const { out, labels, prompt } = await run({ 'plan-critic': { wrote_file: true, gap_count: 0, question_count: 0, fyi_count: 2 } });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  ok(p.includes('A round with FYI items and no gaps or questions writes the file'),
    'the critic is told an FYI-only round writes the file');
  ok(p.includes('A round with nothing at all writes NOTHING'),
    'and that a round with nothing at all writes nothing');
  ok(p.includes('Count them in fyi_count'), 'the critic is told to count its below-floor items');
  eq(out.status, CONVERGED, 'status');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'with no editor spawned for below-floor findings');
  eq(out.lastCritique, 'E:/r/runs/t-refine/plan-critique-1.md', 'and the FYI file is named as the last critique');
  eq(out.belowFloor, 2, 'and the return carries the FYI count, so the operator knows that file holds findings');
}

section('belowFloor is the LAST round\'s FYI count, never a run total');
// A fold rewrites the lines an earlier FYI item cited, so only the final critic's count describes the
// plan the operator is about to approve.
{
  const { out } = await run({ 'plan-critic': firstRound({ ...GAPS, fyi_count: 3 }, CLEAN), 'plan-editor': FOLD_OK });
  eq(out.status, CONVERGED, 'status');
  eq(out.belowFloor, 0, 'the clean final round reported no FYI items, so the round-1 count is not carried');
}

section('the critic prompt settles gates, grading and one-fix-per-gap');
{
  const { prompt } = await run({ 'plan-critic': CLEAN });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  ok(p.includes('You MAY run read-only commands, including a build or test command you find in the repo'),
    'read-only is defined as never editing, with read-only commands allowed');
  ok(p.includes('a finding whose fix is a text edit inside ONE todo block is a GAP, whatever its class'),
    'a text edit inside one block is a gap');
  ok(p.includes('An OMISSION the block\'s own green gate would catch on its first run is minor')
    && p.includes('A WRONG INSTRUCTION the gate would not catch is major or higher'),
    'the two grading rules are stated');
  ok(p.includes('EXACTLY ONE smallest change that closes it (never alternatives)')
    && p.includes('every other gap whose change touches the same plan lines'),
    'one fix per gap, with overlapping gaps named');
  ok(p.includes('7. A FAILURE ON ACCEPTED INPUT') && p.includes('Exactly seven classes qualify'),
    'a failure on accepted input is a defect class of its own');
  ok(!p.includes('six classes'), 'no line still counts six classes');
}

section('the critic grades by impact on accepted input, never by fix size');
{
  const { byLabel } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK });
  const prompts = byLabel('plan-critic').map((c) => c.prompt.replace(/\s+/g, ' '));
  const bar = (p) => p.slice(p.indexOf('THE SEVERITY FLOOR'), p.indexOf('SETTLED DECISIONS'));
  eq(prompts.length, 2, 'two critic rounds ran');
  ok(prompts[0].includes('crashes, loses or corrupts data, or gives wrong output on an input the repo or the plan accepts'),
    'a runtime failure on accepted input is major by definition, whether or not a criterion names it');
  ok(prompts[0].includes('Only the gate counts as a catch'), 'a guess that a developer will notice is never a catch');
  ok(prompts[0].includes('The size of the fix never lowers a grade'), 'a one-line fix does not make a crash minor');
  ok(prompts[0].includes('a crash on an accepted input that the gate would not catch is major'),
    'the crash example yields to the gate-catch rule');
  ok(!prompts[0].includes('blast radius is one line'), 'minor is no longer defined by the size of the fix');
  ok(bar(prompts[0]).length > 0 && bar(prompts[0]) === bar(prompts[1]),
    'every round\'s critic grades under the same bar');
}

section('a gapped round then a clean one converges on round 2, with exactly one editor');
{
  const { out, byLabel } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK });
  eq(out.rounds, 2, 'the clean round is a second round, not a continuation of the first');
  eq(byLabel('plan-editor').length, 1, 'the editor ran once — the clean round folds nothing');
  eq(out.status, CONVERGED, 'status');
  ok(out.lastCritique.endsWith('plan-critique-1.md'),
    'and lastCritique names the last file a critic CONFIRMED writing, not the last round');
}

// ---------------------------------------------------------------------------------------------
// Questions — the exit the minimal-fold editor has no legal edit for
// ---------------------------------------------------------------------------------------------
section('questions end the run on any round, and the editor never sees them');
{
  const { out, labels } = await run({ 'plan-critic': QUESTIONS });
  eq(out.status, NEEDS_ANSWERS, 'status on round 1');
  eq(out.questions, 1, 'the count is handed back');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'nothing was folded');

  const { out: later, byLabel } = await run({ 'plan-critic': firstRound(GAPS, QUESTIONS), 'plan-editor': FOLD_OK });
  eq(later.status, NEEDS_ANSWERS, 'a question raised after a fold lands on the same status');
  eq(later.rounds, 2, 'on the round that raised it');
  eq(byLabel('plan-editor').length, 1, 'the round-1 fold ran; the round-2 question spawned no second editor');
}

section('an editor that escalates a contested dismissal ends the run dismissal-contested, not converged');
// The escalated question lives only in NEEDS-USER.md. The next critic would skip the original DISMISSED
// line, find nothing else, and report converged with a user-only call still open. The ruling must land in
// DISMISSED-PLAN.md, the file the next critic reads, or a relaunch contests and escalates it again.
{
  const { out, byLabel, prompt } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': { ...FOLD_OK, needs_user: true } });
  ok(prompt('plan-editor').includes('needs_user=true'), 'the editor is told which field reports the escalation');
  eq(out.status, CONTESTED, 'status');
  eq(out.rounds, 1, 'on the round the editor escalated');
  eq(byLabel('plan-critic').length, 1, 'and no second critic ran to report a clean round over the open question');
  ok(/A line marked `USER-RULED:` is the user's\s+own ruling: never contest it\./.test(prompt('plan-critic')), 'the critic is told a USER-RULED line is never contested');
}

section('a gap in an already-done block arrives as a question, never as a gap to fold');
// Scope rule 1: folding into a done block rewrites the spec that already-staged code was built against.
// The engine cannot enforce that — the critic does — so what is asserted is the contract on both ends:
// the rule and the file are in the prompt, and the return it produces ends the run without an editor.
{
  const { out, labels, prompt } = await run({ 'plan-critic': { wrote_file: true, gap_count: 0, question_count: 1 } });
  const p = prompt('plan-critic');
  ok(p.includes('SCOPE RULE 1'), 'the critic is told which blocks are closed to it');
  ok(p.includes('E:/r/runs/t-refine/NEEDS-USER.md'), 'and where the operator reads the question');
  eq(out.openGaps, 0, 'the finding counts as no gap');
  eq(out.status, NEEDS_ANSWERS, 'and the run ends for the operator to restructure');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'with no editor spawned against a closed block');
}

// ---------------------------------------------------------------------------------------------
// The round budget
// ---------------------------------------------------------------------------------------------
section('the round budget runs out carrying the LAST round\'s gaps and critique file');
{
  const { out, byLabel } = await run(
    { 'plan-critic': { ...GAPS, gap_count: 3 }, 'plan-editor': FOLD_OK }, { ...baseArgs, maxRounds: 2 });
  eq(byLabel('plan-critic').length, 2, 'the loop spun to the bound');
  eq(byLabel('plan-editor').length, 2, 'folding on every round');
  eq(out.status, EXHAUSTED, 'status');
  eq(out.rounds, 2, 'rounds');
  eq(out.openGaps, 3, 'the last round\'s gaps — folded, but never re-critiqued');
  eq(out.lastCritique, 'E:/r/runs/t-refine/plan-critique-2.md',
    'and the file named is the last round\'s, under the -refine state dir that keeps it out of develop\'s');
}

// ---------------------------------------------------------------------------------------------
// The two death policies — deliberately different, and neither reads as a finished round
// ---------------------------------------------------------------------------------------------
section('a dead critic throws on every round — zero gaps from an agent that died is not convergence');
{
  const r1 = await throwsWith(ENGINE, { args: baseArgs, respond: { 'plan-critic': null } });
  ok(/Plan critic returned nothing in round 1/.test(r1) && /resumeFromRunId/.test(r1),
    `round 1 throws with the resume hint: ${r1.slice(0, 50)}`);

  const r2 = await throwsWith(ENGINE, {
    args: baseArgs,
    respond: { 'plan-critic': firstRound(GAPS, null), 'plan-editor': FOLD_OK },
  });
  ok(/Plan critic returned nothing in round 2/.test(r2),
    `a critic that dies AFTER a fold throws too — a fold nobody re-read is not a clean plan: ${r2.slice(0, 50)}`);
}

section('a dead editor halts instead, because the round\'s critique file survives it');
{
  const { out, byLabel } = await run({ 'plan-critic': GAPS, 'plan-editor': null });
  eq(out.status, EDITOR_DEAD, 'status');
  eq(out.rounds, 1, 'it halts in the round it died in, not at the budget');
  eq(byLabel('plan-critic').length, 1, 'and no further critic re-read a plan nothing folded into');
  ok(out.lastCritique.endsWith('plan-critique-1.md'), 'the file a relaunch resumes the fold from is named');
}

// ---------------------------------------------------------------------------------------------
// Self-contradictory returns — a count saying work happened, with no file to hold it
// ---------------------------------------------------------------------------------------------
section('a critic that reports findings it never wrote halts before the editor');
{
  const { out, labels } = await run({ 'plan-critic': UNWRITTEN });
  eq(out.status, NO_CRITIQUE, 'status');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'the editor is never spawned against a file that does not exist');
  eq(out.lastCritique, '', 'and no file is named — nothing confirmed writing one');

  const { out: asked } = await run({ 'plan-critic': { wrote_file: false, gap_count: 0, question_count: 1 } });
  eq(asked.status, NO_CRITIQUE, 'an unwritten QUESTION halts the same way, ahead of the needs-answers branch');
}

section('a critic that reports FYI items it never wrote halts instead of converging');
// Below-floor findings never drive a fold, but the critique file is still their only record.
{
  const { out, labels } = await run({ 'plan-critic': { wrote_file: false, gap_count: 0, question_count: 0, fyi_count: 1 } });
  eq(out.status, NO_CRITIQUE, 'status');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'and no editor is spawned');
}

section('an editor that reports folds it never wrote halts, and a broken parse halts separately');
{
  const { out } = await run({ 'plan-critic': GAPS, 'plan-editor': { ...FOLD_OK, wrote_file: false } });
  eq(out.status, NO_FOLD, 'the fold exists nowhere, so the next critic would re-find the same gaps');
  eq(out.rounds, 1, 'halted on the round that claimed it');

  const { out: broken } = await run({ 'plan-critic': GAPS, 'plan-editor': { ...FOLD_OK, plan_parses: false } });
  eq(broken.status, PLAN_BROKEN, 'a file every later consumer reads is repaired by hand, not by another round');

  // The guard is scoped to a NONZERO fold: an editor that declined every gap wrote nothing to the plan
  // file, and reporting that honestly must not be read as an unattested fold.
  const { out: allDeclined } = await run({
    'plan-critic': firstRound(GAPS, CLEAN),
    'plan-editor': { wrote_file: false, folded: 0, declined: 2, plan_parses: true },
  }, { ...baseArgs, maxRounds: 2 });
  eq(allDeclined.status, CONVERGED, 'folded 0 with wrote_file false is legal and the loop carries on');
  eq(allDeclined.dismissedCount, 2, 'with the declines still on the ledger total');
}

// ---------------------------------------------------------------------------------------------
// The ledger totals
// ---------------------------------------------------------------------------------------------
section('garbage counts from the editor do not poison the ledger total');
// `dismissedCount += NaN` is permanently NaN, and every later round adds to a number that can no longer
// report anything. The coercion guards must survive a null, a string and a negative alike.
{
  for (const bad of [{ folded: null, declined: 'two' }, { folded: 'nine', declined: null }, { folded: -3, declined: -4 }]) {
    const { out, logs } = await run({
      'plan-critic': GAPS,
      'plan-editor': { wrote_file: true, plan_parses: true, ...bad },
    }, { ...baseArgs, maxRounds: 2 });
    eq(out.dismissedCount, 0, `${JSON.stringify(bad)} collapses to 0, never NaN`);
    ok(out.status === EXHAUSTED && logs.some((l) => /folded 0, declined 0/.test(l)),
      'the run reaches its normal terminal and the round line reports the coerced numbers');
  }
}

section('dismissedCount sums the editor\'s declines across every round, not just the last');
{
  const { out } = await run({
    'plan-critic': GAPS,
    'plan-editor r1': { ...FOLD_OK, declined: 1 },
    'plan-editor r2': { ...FOLD_OK, declined: 2 },
    'plan-editor r3': { ...FOLD_OK, declined: 4 },
  }, { ...baseArgs, maxRounds: 3 });
  eq(out.rounds, 3, 'three rounds folded');
  eq(out.dismissedCount, 7, 'and the total is their sum');
}

section('run-state and plan files inside the target repo each draw their own warning');
// Either one inside the repo is a route to the spec for develop-cycle's blind reviewer later. Each guard
// asserts on a substring the OTHER guard's line lacks: two guards that match one assertion prove nothing.
const planWarnings = (logs) => logs.filter((l) => l.includes('resolves inside the target repo'));
const stateWarnings = (logs) => logs.filter((l) => l.includes('INSIDE the target repo'));
{
  const { logs } = await run({ 'plan-critic': CLEAN }, { ...baseArgs, stateDir: 'E:/repo/runs/t-refine' });
  eq(stateWarnings(logs).length, 1, 'run-state inside the repo warns once');
  eq(planWarnings(logs).length, 0, 'and does not also fire the plan guard');
}
{
  const { logs } = await run({ 'plan-critic': CLEAN }, { ...baseArgs, planPath: 'E:\\repo\\docs\\bus.md' });
  const warn = planWarnings(logs);
  eq(warn.length, 1, 'a plan file inside the repo warns once');
  ok((warn[0] ?? '').includes('E:/repo/docs/bus.md'), `and names the normalized path: ${(warn[0] ?? '(none)').slice(0, 60)}`);
  eq(stateWarnings(logs).length, 0, 'and is not the run-state guard firing');
}
{
  const { logs } = await run({ 'plan-critic': CLEAN });
  eq(stateWarnings(logs).length + planWarnings(logs).length, 0, 'both outside the repo draw nothing');
}

// ---------------------------------------------------------------------------------------------
// Arg validation — every one of these throws BEFORE an opus critic is spawned
// ---------------------------------------------------------------------------------------------
section('a payload the loop cannot trust throws instead of running a round');
// Each responder below would report a CLEAN round, so an engine that defaulted any of these would hand
// back `converged` for a plan no critic ever read — the single worst thing this file can say.
{
  const BAD = [
    ['runId', { ...baseArgs, runId: undefined }],
    ['root', { ...baseArgs, root: undefined }],
    ['planPath', { ...baseArgs, planPath: undefined }],
    ['target.repo', { ...baseArgs, target: {} }],
    ['critiqueSeverity', { ...baseArgs, critiqueSeverity: 'nit' }],
  ];
  for (const [name, args] of BAD) {
    const { terminal, calls } = await runTrace(ENGINE, { args, respond: { 'plan-critic': CLEAN } });
    ok(terminal.kind === 'throw' && calls.length === 0,
      `${name} throws before the first critic: ${terminal.message.slice(0, 45)}`);
  }
}
