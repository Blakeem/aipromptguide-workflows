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
import { readFileSync } from 'node:fs';
import { runEngine, runTrace, throwsWith, readMeta, REPO_ROOT, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';

const ENGINE = 'workflows/refine/refine-cycle.mjs';

// planPath resolves OUTSIDE the target repo, which is what keeps the plan and the critique files away
// from develop-cycle's blind reviewer. A path inside the repo only warns, so it would prove nothing here.
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, planPath: 'E:/plans/bus.md', blockTool: 'E:/r/tools/plan-block.mjs' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// The same healthy returns as tools/flows/refine.flow.mjs, with the editor's `declined` pinned to 0 so
// the ledger-sum case below is the only place that varies it.
const CLEAN     = { wrote_file: true, gap_count: 0, question_count: 0 };
const GAPS      = { wrote_file: true, gap_count: 2, question_count: 0 };
const QUESTIONS = { wrote_file: true, gap_count: 0, question_count: 1 };
const UNWRITTEN = { wrote_file: false, gap_count: 2, question_count: 0 };
const FOLD_OK   = { wrote_file: true, folded: 2, declined: 0, plan_parses: true };

// Every terminal state is its own fact, so each is asserted verbatim rather than by a substring: folding
// any pair of them together is how an unconverged plan gets handed to a build engine as a finished one.
const CONVERGED     = 'converged (one clean round: no gaps at or above the floor, no questions)';
const NEEDS_ANSWERS = 'needs-answers (the critic raised questions only the operator can settle)';
const CONTESTED     = 'dismissal-contested (the editor escalated a contested dismissal to NEEDS-USER.md)';
const EXHAUSTED     = 'rounds-exhausted (gaps were still being found at the round budget - the plan is NOT converged)';
const EDITOR_DEAD   = 'BLOCKED (the plan editor returned nothing - it was skipped or died and may have partly edited the plan file)';
const NO_CRITIQUE   = 'BLOCKED (the critic did not confirm writing its critique file, which every round writes - the round has no record)';
const NO_FOLD       = 'BLOCKED (the editor reported folded gaps but did not confirm writing the plan file - the fold exists nowhere)';
const PLAN_BROKEN   = 'BLOCKED (the folded plan file no longer parses - every later consumer reads it)';

// Each terminal's instructions live in nextStep, never in status, so its clauses are asserted with
// baseArgs' real paths.
const STATE    = 'E:/r/runs/t-refine';
const LIST     = `node 'E:/r/tools/plan-block.mjs' 'E:/plans/bus.md' --list`;
const RELAUNCH = `A relaunch takes the same args and runId and no resumeFromRunId, which keeps the stateDir and its ledger ${STATE}/DISMISSED-PLAN.md.`;
const handBack = (out, halted, clauses, where) => {
  eq(out.halted, halted, `${where}: halted`);
  ok(halted ? /\bround \d+\b/.test(out.haltReason) : out.haltReason === '',
    `${where}: haltReason ${halted ? 'names the round it halted in' : 'is empty'} (got ${JSON.stringify(out.haltReason)})`);
  for (const c of clauses) ok(String(out.nextStep).includes(c), `${where}: nextStep says "${c.slice(0, 70)}"`);
  eq(JSON.stringify(out.failed), '[]', `${where}: failed is empty`);
};

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
  eq(out.lastCritique, 'E:/r/runs/t-refine/plan-critique-1.md', 'and the clean round\'s critique file is named, since every round writes one');
  handBack(out, false, [
    'Hand the plan E:/plans/bus.md to the user for approval.',
    `Audit ${STATE}/DISMISSED-PLAN.md before trusting the converge, since each declined gap is a judgment call.`,
    `Then build the plan with develop, deriving its args with plan-edit.mjs args 'E:/plans/bus.md'.`,
  ], 'converged');
  ok(typeof out.nextStep === 'string' && !/FYI|relaunch/.test(out.nextStep),'a converge with no below-floor findings sends nobody to an FYI section and relaunches nothing');
}

section('an FYI-only round writes its critique file and still converges, naming that file');
// One rule for the critic: below-floor findings need the file, so an FYI-only round writes it and returns
// zero counts. The engine must read that as convergence, not as a round with something to fold.
{
  const { out, labels, prompt } = await run({ 'plan-critic': { wrote_file: true, gap_count: 0, question_count: 0, fyi_count: 2 } });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  ok(p.includes('A round with FYI items and no gaps or questions writes the file'),
    'the critic is told an FYI-only round writes the file');
  ok(p.includes('Write the file EVERY round and return wrote_file=true.'),
    'the critic is told to write its file every round');
  ok(p.includes('A round with nothing at all writes the one line "No gaps." and returns all three counts 0.')
    && !p.includes('writes NOTHING') && !p.includes('wrote_file=false'),
    'and that a round with nothing at all writes "No gaps.", never nothing');
  ok(p.includes('and count them in fyi_count'), 'the critic is told to count its FYI items');
  eq(out.status, CONVERGED, 'status');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'with no editor spawned for FYI items');
  eq(out.lastCritique, 'E:/r/runs/t-refine/plan-critique-1.md', 'and the FYI file is named as the last critique');
  eq(out.belowFloor, 2, 'and the return carries the FYI count, so the operator knows that file holds findings');
  handBack(out, false, [
    `Show the user the FYI section of ${STATE}/plan-critique-1.md with the plan, since no editor folded its 2 item(s).`,
    'The user can add an item to a block before approving.',
    'Hand the plan E:/plans/bus.md to the user for approval.',
  ], 'converged with FYI items');
}

section('the critic writes the FYI section only in a round with no gap and no question, grouped by location');
{
  const { prompt } = await run({ 'plan-critic': CLEAN });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  const fyi = p.slice(p.indexOf('THE FYI SECTION'), p.indexOf('SETTLED DECISIONS'));
  ok(fyi.length > 0, 'the prompt has an FYI section paragraph before the settled decisions');
  ok(p.includes('Below-floor findings are wrong plan text graded minor, never an omission. EXCLUDE them from gap_count and write them only in the FYI section.'),
    'a below-floor finding is wrong plan text, never an omission, and stays out of gap_count');
  ok(fyi.includes('Write it ONLY in a round with no gap at or above the floor and no question, which is the converged round. A round with any gap or question leaves it out and returns fyi_count 0.'),
    'the FYI section is written only in the converged round, and any other round returns fyi_count 0');
  ok(!p.includes('Re-list') && !p.includes('earlier FYI') && !p.includes('plan-critique-0'),
    'no sentence tells the critic to re-list an earlier FYI item or points at a previous critique file');
  ok(fyi.includes('Head it "## FYI", number its items F1, F2 across the entire section, and count them in fyi_count.'),
    'the section is headed FYI, numbered F1, F2 across the entire section, and counted in fyi_count');
  const at = ['One subsection per block that has below-floor findings, headed by the block id.', '"File preamble":', '"Outside the plan":'].map((s) => fyi.indexOf(s));
  ok(at.every((i) => i > 0) && at.every((i, n) => n === 0 || i > at[n - 1]),
    'the subsections run per block, then File preamble, then Outside the plan');
  ok(fyi.includes('A below-floor item names its class, its evidence and one suggested change.'),
    'a below-floor item names its class, its evidence and one suggested change');
  ok(fyi.includes('"File preamble": a finding in plan text above the first block, other than the file keys, at any grade, since no developer reads that text. A file-key finding below the floor goes here too.'),
    'a finding in plan text above the first block, other than the file keys, goes in File preamble at any grade, and so does a file-key finding below the floor');
  ok(!/"Preamble"/.test(p), 'no subsection is named bare Preamble, which the block metadata paragraph already uses for a block\'s key run');
  ok(fyi.includes('"Outside the plan": a real defect that no plan text holds, in a file you read to judge the plan, with its file and line. Write it at every floor, minor included. Never search further for one.'),
    'Outside the plan holds defects no plan text holds, in a file the critic read for the plan, each with its file and line, at every floor, and the critic never searches further');
  ok(!p.includes('A gap never invites the editor to fold an FYI item.') && !p.includes('then the FYI section, then a QUESTIONS section'),
    'the critique file layout puts no FYI section beside the gaps the editor reads');
  ok(p.includes('You write only your critique file E:/r/runs/t-refine/plan-critique-1.md, E:/r/runs/t-refine/NEEDS-USER.md, and a probe\'s files'),
    'the opening write list names the critique file by its path');
}

section('at the minor floor the critic has no below-floor subsection and still writes Outside the plan');
{
  const { prompt } = await run({ 'plan-critic': CLEAN }, { ...baseArgs, critiqueSeverity: 'minor' });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  ok(p.includes('"Outside the plan": a real defect that no plan text holds, in a file you read to judge the plan, with its file and line. Write it at every floor, minor included. Never search further for one.'),
    'a minor-floor critic is told to write Outside the plan');
  ok(p.includes('"File preamble": a finding in plan text above the first block, other than the file keys, at any grade'),
    'and File preamble');
  ok(p.includes('No grade sits below this floor, so every gap you find counts.')
    && !p.includes('Below-floor findings are') && !p.includes('One subsection per block'),
    'but no grade sits below the minor floor, so it has no below-floor finding and no per-block subsection');
}

section('the fyi_count schema description and the Critique phase detail say when the FYI section is written');
{
  const { byLabel } = await run({ 'plan-critic': CLEAN });
  const description = String(byLabel('plan-critic')[0]?.opts?.schema?.properties?.fyi_count?.description ?? '');
  ok(description.includes('which you write only in a round with no gaps and no questions (0 in any other round)'),
    'the fyi_count description says the FYI section is written only with no gaps and no questions');
  ok(!description.includes('below floor'), 'and no longer calls the section a below-floor section');
  const critique = (readMeta(readFileSync(`${REPO_ROOT}/${ENGINE}`, 'utf8'))?.phases ?? []).find((ph) => ph.title === 'Critique');
  const detail = String(critique?.detail ?? '');
  ok(detail.includes('an FYI section only in a round with no gaps and no questions'),
    'the Critique phase detail says the same');
  ok(!detail.includes('a below-floor FYI section'), 'and no longer lists a below-floor FYI section beside the gaps');
}

section('belowFloor is the LAST round\'s FYI count, never a run total');
// Only the converged round writes FYI items, so an earlier round's count is never carried.
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
  ok(p.includes('You MAY read any file the plan cites, such as a design note or another plan file, to judge a claim about it.'),
    'the critic may read a file the plan cites');
  ok(p.includes('a finding whose fix is a text edit inside ONE todo block is a GAP, whatever its class'),
    'a text edit inside one block is a gap');
  ok(p.includes('A WRONG PRESCRIPTION is major or higher, since the developer can depart from it only through a plan amendment.'),
    'a wrong prescription is major, with no clause about the gate');
  ok(!p.includes('whether or not the gate would catch it'), 'and no grade rule names the gate');
  ok(!p.includes('An OMISSION the block\'s own green gate') && !p.includes('Only the gate counts as a catch'),
    'an omission the gate catches is no longer a grade rule, since an omission is no gap');
  ok(p.includes('1. A CONTRADICTION: two statements in the plan that cannot both hold'),
    'a self-contradiction is a CONTRADICTION');
  ok(!p.includes('WRONG INSTRUCTION'), 'no line still names a WRONG INSTRUCTION');
  ok(p.includes('EXACTLY ONE smallest change that closes it (never alternatives)')
    && p.includes('every other gap whose change touches the same plan lines'),
    'one fix per gap, with overlapping gaps named');
  ok(p.includes('Exactly four classes qualify') && !p.includes('seven classes') && !p.includes('six classes'),
    'the bar counts four classes, and no line still counts six or seven');
}

section('the critic judges only whether the plan\'s text is correct, and a lean block passes');
{
  const { prompt } = await run({ 'plan-critic': CLEAN });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  ok(p.includes('THE DEFECT BAR - the plan states what the user wants. Judge only whether what it SAYS is correct. A gap names plan text that is wrong. Exactly four classes qualify:'),
    'the bar opens on the plan as what the user wants');
  const classes = ['1. A CONTRADICTION:', '2. A WRONG PRESCRIPTION:', '3. A BAD PRACTICE BY PRESCRIPTION:', '4. A DEPENDENCY-ORDERING ERROR between blocks:'];
  const at = classes.map((c) => p.indexOf(c));
  ok(at.every((i) => i > 0) && at.every((i, n) => n === 0 || i > at[n - 1]),
    'the four classes are listed in order');
  for (const gone of ['WIRING POINT', 'BLOCK TOO BIG', 'REFERENCE OUTSIDE THE BLOCK', 'ACCEPTANCE CRITERION WITH NO IMPLEMENTING STEP', 'FAILURE ON ACCEPTED INPUT', 'WRONG or ABSENT FILE']) {
    ok(!p.includes(gone), `the completeness class "${gone}" is gone`);
  }
  const neverGap = p.indexOf('WHAT THE PLAN DOES NOT SAY IS NEVER A GAP. A missing step, test, wiring point, edge case, file, doc update or detail is the developer\'s call, and develop\'s own reviews catch what it misses. A lean block that states its requirements and leaves the how to the developer passes.');
  ok(neverGap > at[3] && neverGap < p.indexOf('IMPROVEMENTS, ALTERNATIVES and STYLE are OUT OF SCOPE'),
    'the never-a-gap paragraph sits after the class list and before the out-of-scope paragraph');
  ok(p.includes('Every gap\'s change corrects or removes the wrong text. It never adds a requirement, step, file, test or detail the plan does not already state.'),
    'a gap\'s change corrects or removes text and never adds to the plan');
  ok(p.includes('never adds a requirement, step, file, test or detail the plan does not already state. A clause that makes a stated sentence true is a correction, and a new obligation is an addition.'),
    'the critic bar calls a clause that makes a stated sentence true a correction and a new obligation an addition, as the editor guard does');
  ok(p.includes('A command, flag, or library, tool or API behavior the block prescribes counts too. Confirm each one the repo does not already use the same way, against the dependency\'s own docs or source, or a probe in a temporary directory outside the repo and the state dir. A confirmed prescription needs no source cited in the plan.'),
    'a prescribed command or dependency behavior is confirmed against its docs, source or a probe');
  ok(p.includes('You write only your critique file E:/r/runs/t-refine/plan-critique-1.md, E:/r/runs/t-refine/NEEDS-USER.md, and a probe\'s files in a temporary directory outside the target repo and the state dir E:/r/runs/t-refine.'),
    'the write list names the critique file by its path and the probe\'s temporary directory');
  ok(p.includes('Judge the plan file against the REAL repo and find plan text that is wrong.') && !p.includes('find what would BUILD WRONG'),
    'the opener looks for wrong plan text');
  ok(p.includes('EVERY gap carries evidence - the plan line it is about, and the repo line, plan line, cited file\'s line, dependency doc or probe output that contradicts it. NO EVIDENCE, NO GAP.'),
    'evidence may be a plan line, a cited file\'s line, a dependency doc or a probe output');
  ok(p.includes('a plan statement the repo or a file the plan cites contradicts'),
    'a contradiction class admits a plan statement that a cited file contradicts');
  ok(p.includes('SCOPE RULE 2 - a DEPENDENCY-ORDERING ERROR (class 4) whose fix splits, merges, adds or reorders blocks is reported as a QUESTION'),
    'only an ordering error becomes a structural question');
  ok(p.includes('which of the four classes it is') && p.includes('The one change may touch several lines of one block, such as a Files line, a Docs bullet and a criterion, and still names no alternatives. It names every plan line the change makes stale.'),
    'the write list asks for one of four classes and one change that names what it makes stale');
}

section('the critic judges text the block tells the developer to write as output');
{
  const { prompt } = await run({ 'plan-critic': CLEAN });
  const p = prompt('plan-critic').replace(/\s+/g, ' ');
  const textIsOutput = p.indexOf('Text the block tells the developer to write, such as an engine prompt sentence, a principle, a guide or README sentence or a comment, is output: a sentence the repo contradicts once the plan\'s steps are applied is wrong output and a WRONG PRESCRIPTION.');
  ok(textIsOutput > p.indexOf('2. A WRONG PRESCRIPTION:')
    && textIsOutput < p.indexOf('3. A BAD PRACTICE BY PRESCRIPTION:'),
    'a false sentence the block prescribes is a wrong prescription, stated as class 2\'s continuation');
  const gradeRules = p.slice(p.indexOf('Three rules settle the grade'), p.indexOf('Gaps graded'));
  ok(gradeRules.includes('When an earlier block\'s steps make an existing sentence false and a LATER block rewrites it, that is a DEPENDENCY-ORDERING ERROR graded major, since the earlier block\'s acceptance counts the sentence before the later block runs.'),
    'a stale sentence a later block rewrites is a major ordering error, so the default floor cannot hide it');
  ok(!p.includes('OMISSION graded minor'), 'a stale sentence the block leaves unchanged is no longer a graded omission');
  ok(!p.includes('Four rules settle the grade'), 'no line still counts four grade rules');
}

section('the critic grades by impact on accepted input, never by fix size');
{
  const { byLabel } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK });
  const prompts = byLabel('plan-critic').map((c) => c.prompt.replace(/\s+/g, ' '));
  const bar = (p) => p.slice(p.indexOf('THE SEVERITY FLOOR'), p.indexOf('THE FYI SECTION'));
  eq(prompts.length, 2, 'two critic rounds ran');
  ok(prompts[0].includes('crashes, loses or corrupts data, or gives wrong output on an input the repo or the plan accepts'),
    'a runtime failure on accepted input is major by definition, whether or not a criterion names it');
  ok(prompts[0].includes('the plan contradicts itself, the repo or a file it cites on what to build, or it prescribes a bad practice'),
    'a contradiction about what to build and a prescribed bad practice are major by definition');
  ok(!prompts[0].includes('a named acceptance criterion or wiring point is not met'),
    'an unmet criterion or wiring point no longer defines major');
  ok(prompts[0].includes('The size of the fix never lowers a grade'), 'a one-line fix does not make a crash minor');
  ok(prompts[0].includes('A one-word fix to a crash on an accepted input is major.'), 'the crash example stays major');
  ok(!prompts[0].includes('that the gate would not catch'), 'the fix-size rule no longer names a gate-catch condition');
  ok(!prompts[0].includes('blast radius is one line'), 'minor is no longer defined by the size of the fix');
  ok(bar(prompts[0]).length > 0 && bar(prompts[0]) === bar(prompts[1]),
    'every round\'s critic grades under the same bar');
}

section('a round-2 critic is pointed at no earlier critique file, and a file-key defect is a question');
{
  const { byLabel } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK });
  const [r1, r2] = byLabel('plan-critic').map((c) => c.prompt.replace(/\s+/g, ' '));
  ok(!r2.includes(`${STATE}/plan-critique-1.md`) && r2.includes(`${STATE}/plan-critique-2.md`),
    'the round-2 prompt names only its own critique file, never the round-1 file');
  ok(!r1.includes('plan-critique-0') && !r1.includes('plan-critique-2'),
    'the round-1 prompt names no other round\'s critique');
  ok(r1.includes('SCOPE RULE 4 - a defect in a file key (goal, ordered, suite, sweep) at or above the floor is reported as a QUESTION, never as a gap, since no block\'s text holds it. One below the floor goes to the FYI "File preamble" subsection.')
    && r1.indexOf('SCOPE RULE 4') > r1.indexOf('SCOPE RULE 3'),
    'a file-key defect at or above the floor is a question and one below it is an FYI item, stated after SCOPE RULE 3');
}

section('a gapped round then a clean one converges on round 2, with exactly one editor');
{
  const { out, byLabel } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK });
  eq(out.rounds, 2, 'the clean round is a second round, not a continuation of the first');
  eq(byLabel('plan-editor').length, 1, 'the editor ran once — the clean round folds nothing');
  eq(out.status, CONVERGED, 'status');
  eq(out.lastCritique, `${STATE}/plan-critique-2.md`,
    'and lastCritique names the clean round\'s file, since every round writes one');
}

section('the editor checks every gap against the plan and the repo before it folds one, in every round');
{
  const { byLabel } = await run(
    { 'plan-critic': GAPS, 'plan-editor': FOLD_OK }, { ...baseArgs, maxRounds: 2 });
  const prompts = byLabel('plan-editor').map((c) => c.prompt.replace(/\s+/g, ' '));
  eq(prompts.length, 2, 'two editor rounds ran');
  for (const [n, p] of prompts.entries()) {
    const r = `round ${n + 1}`;
    const [guardAt, procedureAt] = [p.indexOf('THE ONE GUARD THAT MATTERS'), p.indexOf('PROCEDURE:')];
    ok(guardAt >= 0 && procedureAt > guardAt, `${r}: the guard paragraph sits before the PROCEDURE`);
    const guard = p.slice(guardAt, procedureAt);
    ok(guard.includes('Never add a requirement, step, file, test or detail the plan does not already state, even when a gap\'s change asks for one.'),
      `${r}: the guard forbids adding to the plan even when a gap's change asks for it`);
    ok(guard.includes('A clause that makes a stated sentence true is a correction, and a new obligation is an addition.'),
      `${r}: the guard calls a clause that makes a stated sentence true a correction and a new obligation an addition`);
    ok(guard.includes('not an extra step you think a block needs, and not a criterion you would have phrased differently.'),
      `${r}: the guard's list of changes the editor may not make ends on the criterion`);
    ok(!/FYI/i.test(p), `${r}: the editor prompt never mentions an FYI section, since no round the editor reads holds one`);
    const steps = ['1. CHECK each numbered gap before you fold it. Open the plan line',
      '2. For each numbered gap, make the smallest edit to E:/plans/bus.md that closes it',
      '3. A gap you DECLINE under the CHECK step gets ONE line',
      '4. A gap prefixed "CONTESTS DISMISSAL:" may NOT be declined a second time.',
      '5. MANDATORY FINAL STEP'];
    const at = steps.map((s) => p.indexOf(s));
    ok(at.every((i) => i > 0) && at.every((i, k) => k === 0 || i > at[k - 1]),
      `${r}: the CHECK step is step 1, before the fold step, and the later steps are renumbered in order`);
    const check = p.slice(at[0], at[1]);
    for (const c of ['Open the plan line and the evidence it cites (a repo line, a plan line, a cited file\'s line, a dependency doc or a probe output) and confirm each says what the gap claims.',
      'Confirm the gap names text the plan states, never text it lacks.',
      'Re-run every probe whose output decides a WRONG PRESCRIPTION gap, and any other probe the critic ran when you doubt its result.',
      `Put a probe's files in a temporary directory outside the target repo and the state dir ${STATE}.`,
      'Treat the gap\'s change as a hint. Write the correction that closes the confirmed defect: it corrects, removes or moves text the plan states, and adds nothing the plan does not already state.',
      'Confirm every path, symbol and quote your new text introduces against the repo.',
      'Find every plan line that states the same fact, and count a line your correction would make false as named by the gap.',
      'DECLINE a gap only when its defect is not confirmed, or when no correction, as opposed to an addition, closes it. Its reason names which.',
      `A gap prefixed "CONTESTS DISMISSAL:" is never declined here and goes to ${STATE}/NEEDS-USER.md under the contested-dismissal step.`]) {
      ok(check.includes(c), `${r}: the CHECK step says "${c.slice(0, 60)}"`);
    }
    ok(!check.includes('A gap that fails any check is DECLINED') && !check.includes('as a spot check of the critic'),
      `${r}: the CHECK step no longer declines a gap for a change it can correct`);
    ok(p.slice(at[1], at[2]).includes('The critique\'s plan line numbers predate this round\'s edits, so find each cited plan line by its quoted text.'),
      `${r}: the fold step finds each cited plan line by its quoted text`);
  }
  for (const [n, c] of byLabel('plan-critic').entries()) {
    ok(c.prompt.replace(/\s+/g, ' ').includes('its evidence with the plan line quoted verbatim'),
      `critic round ${n + 1}: each gap quotes its plan line, so the editor can find it after earlier folds`);
  }
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
  handBack(out, true, [
    `Read the QUESTIONS section of ${STATE}/plan-critique-1.md and the new entries headed "## r1 critic" at the end of ${STATE}/NEEDS-USER.md, settle the questions with the user and restructure E:/plans/bus.md, where new blocks take fresh kebab ids. Then relaunch.`,
    RELAUNCH,
    'A replay returns the cached critic and halts the same way.',
  ], 'needs-answers');

  const { out: later, byLabel } = await run({ 'plan-critic': firstRound(GAPS, QUESTIONS), 'plan-editor': FOLD_OK });
  eq(later.status, NEEDS_ANSWERS, 'a question raised after a fold lands on the same status');
  eq(later.rounds, 2, 'on the round that raised it');
  ok(String(later.nextStep ?? '').includes(`the new entries headed "## r2 critic" at the end of ${STATE}/NEEDS-USER.md`),
    'and nextStep names that round as the one whose NEEDS-USER entries are new');
  const [q1, q2] = byLabel('plan-critic').map((c) => c.prompt.replace(/\s+/g, ' '));
  ok(q1.includes(`QUESTIONS also go to ${STATE}/NEEDS-USER.md IN FULL (append, create it if needed). Each question you append there opens with the line \`## r1 critic\`.`)
    && q2.includes('opens with the line \`## r2 critic\`.'),
    'each round\'s critic heads its NEEDS-USER entries with its own round');
  eq(byLabel('plan-editor').length, 1, 'the round-1 fold ran; the round-2 question spawned no second editor');
}

section('an editor that escalates a contested dismissal ends the run dismissal-contested, not converged');
// The escalated question lives only in NEEDS-USER.md. The next critic would skip the original DISMISSED
// line, find nothing else, and report converged with a user-only call still open. The ruling must land in
// DISMISSED-PLAN.md, the file the next critic reads, or a relaunch contests and escalates it again.
{
  const { out, byLabel, prompt } = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': { ...FOLD_OK, needs_user: true } });
  ok(prompt('plan-editor').includes('needs_user=true'), 'the editor is told which field reports the escalation');
  ok(prompt('plan-editor').replace(/\s+/g, ' ').includes(`append a full self-contained entry to ${STATE}/NEEDS-USER.md that opens with the line \`## r1 editor\`, and set needs_user=true.`),
    'the editor heads its NEEDS-USER entry with its round');
  eq(out.status, CONTESTED, 'status');
  eq(out.rounds, 1, 'on the round the editor escalated');
  handBack(out, true, [
    `Read the new entries headed "## r1 editor" at the end of ${STATE}/NEEDS-USER.md and record the user's ruling, by folding the gap into E:/plans/bus.md or by appending "<block id> - <gap gist> - USER-RULED: <reason>" to ${STATE}/DISMISSED-PLAN.md. Then relaunch.`,
    RELAUNCH,
  ], 'dismissal-contested');
  eq(byLabel('plan-critic').length, 1, 'and no second critic ran to report a clean round over the open question');
  ok(/A line marked `USER-RULED:` is the user's\s+own ruling: never contest it\./.test(prompt('plan-critic')), 'the critic is told a USER-RULED line is never contested');
}

section('a gap in a closed block arrives as a question, never as a gap to fold');
// Scope rule 1: folding into a done block rewrites the spec that already-staged code was built against.
// The engine cannot enforce that — the critic does — so what is asserted is the contract on both ends:
// the rule and the file are in the prompt, and the return it produces ends the run without an editor.
{
  const { out, labels, prompt } = await run({ 'plan-critic': { wrote_file: true, gap_count: 0, question_count: 1 } });
  const p = prompt('plan-critic');
  ok(p.includes('SCOPE RULE 1'), 'the critic is told which blocks are closed to it');
  const whenToUse = String(readMeta(readFileSync(`${REPO_ROOT}/${ENGINE}`, 'utf8'))?.whenToUse ?? '');
  ok(whenToUse.includes('a gap in a closed block, which is a block with any status but todo') && !whenToUse.includes('already-done'),
    'the engine header names a closed block as any status but todo, as the critic prompt closes them');
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
  handBack(out, false, [
    'The last round\'s gaps were folded but no critic re-read them.',
    `Read ${STATE}/plan-critique-2.md, decide with the user, then relaunch to confirm, raising maxRounds if needed.`,
    RELAUNCH,
  ], 'rounds-exhausted');
}

section('conventionFiles reach the critic and the editor, and a bad value throws');
// The distilled conventions line is an index, so both roles read the target's own instruction files in full.
{
  const HEAD = "CONVENTION FILES (the target's own rules, which the CONVENTIONS line above indexes. Read each one in full):";
  const none = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK });
  ok(!none.prompt('plan-critic').includes('CONVENTION FILES') && !none.prompt('plan-editor').includes('CONVENTION FILES'), 'without the arg, no prompt carries the section');
  const set = await run({ 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK }, { ...baseArgs, conventionFiles: [' CLAUDE.md', ' E:/home/.claude/CLAUDE.md '] });
  for (const role of ['plan-critic', 'plan-editor']) {
    ok(set.prompt(role).includes(`${HEAD}
  - E:/repo/CLAUDE.md
  - E:/home/.claude/CLAUDE.md
`), `the ${role} prompt lists each file trimmed, a relative one resolved against target.repo`);
  }
  for (const bad of ['CLAUDE.md', [' '], [null]]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, conventionFiles: bad } });
    ok(msg.startsWith('Invalid args.conventionFiles: it must be an array of file paths') && msg.includes(JSON.stringify(bad)),
      `conventionFiles ${JSON.stringify(bad)} throws naming the value: ${msg.slice(0, 120)}`);
  }
}

section('a launch without blockTool throws, naming the pre-launch command that runs the tool');
// An installed plugin keeps run-state (root) apart from tools/, so no path derived from root names the tool.
{
  const { blockTool: _, ...NO_TOOL } = baseArgs;
  for (const [args, what] of [[NO_TOOL, 'a missing path'], [{ ...baseArgs, blockTool: '' }, 'an empty path'], [{ ...baseArgs, blockTool: 7 }, 'a path that is not a string']]) {
    const msg = await throwsWith(ENGINE, { args });
    ok(msg.startsWith('Missing args.blockTool: pass the path of the plan-block.mjs that the pre-launch command `node <plan-block.mjs> <planPath> --list` runs'),
      `${what} throws, naming the arg and the pre-launch command: ${msg.slice(0, 70)}`);
  }
  const { prompt } = await runEngine(ENGINE, { args: { ...baseArgs, blockTool: 'C:\\plug\\tools\\plan-block.mjs' }, respond: { 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK } });
  ok(prompt('plan-editor').includes("node 'C:/plug/tools/plan-block.mjs' 'E:/plans/bus.md' --list"), 'the editor re-validates through the passed path, backslashes normalized');
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
  handBack(out, true, [
    `Run ${LIST} first, since the editor may have partly edited the plan.`,
    `Then replay with the same args and runId plus the Workflow tool's resumeFromRunId, so the cached critic returns and only the fold of ${STATE}/plan-critique-1.md runs again.`,
    'A relaunch without resumeFromRunId restarts at round 1.',
  ], 'agent-dead');
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
  handBack(out, true, ['Relaunch to redo the round.', RELAUNCH], 'critique-unwritten');

  const { out: asked } = await run({ 'plan-critic': { wrote_file: false, gap_count: 0, question_count: 1 } });
  eq(asked.status, NO_CRITIQUE, 'an unwritten QUESTION halts the same way, ahead of the needs-answers branch');
}

section('a critic that reports a clean round it never wrote halts instead of converging');
// A clean round writes "No gaps.", so a clean return with no file confirmed has no record that a critic looked.
{
  const { out, labels } = await run({ 'plan-critic': { ...CLEAN, wrote_file: false } });
  eq(out.status, NO_CRITIQUE, 'status');
  ok(!labels.some((l) => l.startsWith('plan-editor')), 'and no editor is spawned');
  eq(out.lastCritique, '', 'and no file is named');
  const { out: later } = await run({ 'plan-critic': firstRound(GAPS, { ...CLEAN, wrote_file: false }), 'plan-editor': FOLD_OK });
  eq(later.status, NO_CRITIQUE, 'an unwritten clean round after a fold halts the same way');
  eq(later.lastCritique, `${STATE}/plan-critique-1.md`, 'and names the last file a critic confirmed writing');
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
  handBack(out, true, ['Inspect E:/plans/bus.md, then relaunch.', RELAUNCH], 'fold-unattested');

  const { out: broken } = await run({ 'plan-critic': GAPS, 'plan-editor': { ...FOLD_OK, plan_parses: false } });
  eq(broken.status, PLAN_BROKEN, 'a file every later consumer reads is repaired by hand, not by another round');
  handBack(broken, true, [`Repair E:/plans/bus.md by hand until ${LIST} exits 0, then relaunch.`, RELAUNCH], 'plan-broken');

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
{
  // Windows folds case in a drive or UNC path, so a path that spells the repo in another case is still
  // inside it. A POSIX path keeps its case.
  const CASES = [
    ['E:/repo', 'E:\\repo\\', 1, 'the repo root itself, in backslashes with a trailing slash'],
    ['E:/repo', 'e:/REPO/runs/t', 1, 'a drive path in another case'],
    ['//server/share/repo', '//SERVER/share/Repo/runs/t', 1, 'a UNC path in another case'],
    ['/srv/repo', '/srv/REPO/runs/t', 0, 'a POSIX path in another case, so a macOS spelling draws no warning'],
    ['E:/repo', 'E:/repo-state/t', 0, 'a folder beside the repo whose name extends the repo\'s'],
  ];
  for (const [repo, path, warns, what] of CASES) {
    const { logs } = await run({ 'plan-critic': CLEAN }, { ...baseArgs, target: { repo }, stateDir: path, planPath: `${path}/bus.md` });
    eq(stateWarnings(logs).length, warns, `run-state: ${what} warns ${warns} time(s)`);
    eq(planWarnings(logs).length, warns, `plan file: ${what} warns ${warns} time(s)`);
  }
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

await pinRoleMaps({
  engine: ENGINE, name: 'refine', defaults: { critic: 'opus', editor: 'opus' },
  runs: [{ args: { ...baseArgs, maxRounds: 1 }, respond: { 'plan-critic': GAPS, 'plan-editor': FOLD_OK }, labels: { critic: 'plan-critic', editor: 'plan-editor' } }],
});

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite one the agent has not read.
section("every prompt that writes a file says to Read an earlier launch's file first, and a rejected write is not a write");
{
  const { prompt } = await run({ 'plan-critic': GAPS, 'plan-editor': FOLD_OK }, { ...baseArgs, maxRounds: 1 });
  const sites = [
    ["the critic's critique file", prompt('plan-critic'), 1, 1],
    ["the editor's plan edits", prompt('plan-editor'), 0, 1],
  ];
  pinWriteNotes(sites);
  pinFileWriteNote(sites);
}
