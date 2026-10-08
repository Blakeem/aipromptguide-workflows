// investigate/investigate-cycle.mjs — bounded exhaustive search with memory.
// Focus: the SEVEN terminal statuses, each asserted as a whole literal. "Ran out of rounds", "ran out of
// tokens", "nothing can qualify", "stopped on diminishing returns" and "the round added nothing" are five
// different facts, and a test that asserts only "the loop ended" passes just as well when the engine
// reports the wrong one — which is exactly how fatigue would come to masquerade as a proof. After that:
// the critic gate, dead agents (a dead investigator must never read as an exhausted search), and what the
// prompts actually name.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/investigate/investigate-cycle.mjs';

const baseArgs = { runId: 't', root: 'E:/r', criteria: '## Question\nQ\n## Acceptance Criteria\n- c1', priorRounds: 0 };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// An EMPTY round: nothing found, nothing ruled out, nothing claimed. Spread over it to script the
// interesting cases — but note that on its own it now STALLS the run at r1, so a scenario that needs a
// second round scripts LEARN instead.
const INV  = { wrote_files: true, new_options: 0, disqualified_added: 0, near_misses: 0, rediscovered: 0, next_avenue_confidence: 'low', exhausted: false, no_solution: false, saturated: false, needs_user: false, option_ids: [] };
const CRIT = { wrote_file: true, upheld: [], verified_ids: [], disqualified: [], near_misses: 0, contests_exhaustion: false, contests_saturation: false, agree: false, needs_user: false, reopened: 0 };
// A LEARNING round: it qualifies nothing but closes candidates in the ledger. Answer-neutral and still
// legitimate — a real run does this constantly — so it must not trip the stalled backstop.
const LEARN = { ...INV, disqualified_added: 1 };

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
// the same to the caller (a `critique?.verdict ?? 'ready'` fallback is what NOT to copy).
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
  ok(out.exhaustive === false, 'nothing is reported as exhaustive');
  // The last round CLAIMED exhaustion, so the prompt never told it to label the file partial. The
  // caveat has to say the file asserts a rejected claim, or the operator relays it as a finished answer.
  ok(out.determination.endsWith('DETERMINATION.md'), 'the partial determination is surfaced');
  ok(/asserts the exhaustion claim the critic did NOT accept \(see .*acceptance-review-r3\.md\): it is NOT labelled partial and may lack WHERE NEXT, so label it a PARTIAL result/.test(out.nextStep),
    'nextStep says the file asserts a rejected claim and must be labelled partial');
  ok(!/it says so at the top/.test(out.nextStep), 'and never claims the file already says it is partial');
  ok(/not.*complete answer/i.test(out.nextStep), 'and says plainly that it is not a complete answer');

  const { out: quiet } = await run({ 'investigate': { ...INV, new_options: 1, option_ids: ['o'] }, 'critique': CRIT }, { ...baseArgs, maxRounds: 1 });
  eq(quiet.status, 'not exhaustive (round budget spent)', 'a quiet last round runs out of rounds too');
  ok(/DETERMINATION\.md was written as a PARTIAL result \(it says so at the top\)/.test(quiet.nextStep),
    'and keeps the partial wording, since the prompt told it to label the file');
}

section('an uncontested exhaustion claim ends the loop before the round budget');
{
  const { out, byLabel } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique': { ...CRIT, agree: true, determination_defects: 2 },
  }, { ...baseArgs, maxRounds: 4 });
  eq(byLabel('investigate').length, 1, 'ended on round 1, well inside maxRounds=4');
  eq(out.status, 'exhaustive (search closed, critic agreed)', 'status');
  ok(out.exhaustive === true && out.determination.endsWith('DETERMINATION.md'), 'the determination file is surfaced');
  ok(out.determinationDefects === 2, 'the critic\'s determination defects are counted on the return');
  ok(out.nextStep.includes('The critic found 2 defect(s) in the determination') && out.nextStep.includes(out.reviewFile),
    'nextStep states the count and names the review file that holds them');
}

section('an agreed saturation claim is a STOPPED search with its own terminal, never a closed one');
// The failure this exists to prevent: a critic agrees to "I am not finding more", and the run reports it
// with the same word it uses for a search that was PROVED complete. They are different facts.
{
  const { out, byLabel } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'], saturated: true },
    'critique': { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'], agree: true, determination_defects: 2 },
  }, { ...baseArgs, maxRounds: 4 });
  eq(byLabel('investigate').length, 1, 'the agreed claim ended the loop on round 1, well inside maxRounds=4');
  eq(out.status, 'stopped on saturation (diminishing returns, critic agreed — the search is open, not closed)', 'status');
  ok(out.saturated === true, 'the return carries the flag');
  ok(out.exhaustive === false && out.noSolution === false,
    'and nothing on the return claims the search was closed — that is the whole reason it is its own terminal');
  ok(out.determination.endsWith('DETERMINATION.md'), 'the claiming round was told to write one, so it is named');
  ok(/WHERE NEXT/.test(out.nextStep) && /OPEN, not closed/.test(out.nextStep),
    'nextStep leads with WHERE NEXT and says plainly that the search is open');
  eq(out.options.join(), 'opt-a', 'the upheld option is still a valid answer — stopping does not invalidate what was found');
  ok(out.reviewFile.endsWith('acceptance-review-r1.md') && out.nextStep.includes(out.reviewFile),
    'nextStep points at the review, the only place a determination linking a disqualified option is recorded');
  ok(out.determinationDefects === 2, 'the critic\'s determination defects are counted on the return');
  ok(out.nextStep.includes('The critic found 2 defect(s) in the determination'), 'and nextStep states the count');
  ok(/ANSWER may still link an option the critic disqualified/.test(out.nextStep), 'the disqualified-option warning stays');
}

section('a contested saturation claim buys another round, and reads only its OWN contest flag');
{
  const { out, labels, byLabel } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'], saturated: true },
    'critique': { ...CRIT, contests_saturation: true },
  }, { ...baseArgs, maxRounds: 3 });
  ok(labels.includes('investigate r2'), 'the contested claim forced a second investigator round');
  eq(byLabel('investigate').length, 3, 'and it spun to the round bound');
  eq(out.status, 'not exhaustive (round budget spent)', 'status');
  ok(out.saturated === false, 'a contested claim never reaches the saturated terminal');

  // The two contest flags are NOT interchangeable. A saturation claim attacked with the coverage flag was
  // never attacked at all: the critic's saturation branch is the only place contests_saturation is asked
  // for, so crossing the two would let a stop through on a verdict that was about something else.
  const { out: crossed } = await run({
    'investigate': { ...LEARN, saturated: true },
    'critique': { ...CRIT, agree: true, contests_exhaustion: true },
  }, { ...baseArgs, maxRounds: 1 });
  ok(crossed.saturated === true, 'contests_exhaustion does not block a saturation claim — each reads its own flag');
}

section('exhaustion and no-solution OUTRANK saturation, and claiming both is logged');
// A search that can be EVIDENCED as closed must never be downgraded to "I stopped looking", and the
// reverse would be worse still. Both flags arriving together is self-contradictory: the stronger fact
// makes the weaker one moot.
{
  const { out, logs } = await run({
    'investigate': { ...INV, exhausted: true, saturated: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(out.status, 'exhaustive (search closed, critic agreed)', 'the stronger fact wins');
  ok(out.exhaustive === true && out.saturated === false, 'and only its flag is set');
  ok(logs.some((l) => /claimed BOTH/.test(l) && /IGNORED/.test(l)),
    'the contradictory return is flagged rather than silently resolved');

  const { out: dead } = await run({
    'investigate': { ...INV, no_solution: true, saturated: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(dead.status, 'no qualifying option exists (verified)', 'no_solution outranks it too');
  ok(dead.saturated === false, 'and saturation is dropped, not carried alongside');
}

section('a round that adds NOTHING stalls the run rather than buying another empty one');
// The backstop. An empty round leaves the next round nothing to diverge FROM, so another one costs full
// price for the same result. A run's first round always gets a critic, so the critic-less stall is r2.
{
  const { out, labels, logs } = await run({
    'investigate': (label) => (/r1$/.test(label) ? LEARN : INV),
    'critique': CRIT,
  }, { ...baseArgs, maxRounds: 5 });
  eq(labels.join(), 'investigate r1,critique r1,investigate r2', 'it stopped at r2 — no third round, and no critic spawned over nothing');
  eq(out.status, 'stalled (a round added nothing new and claimed nothing)', 'status');
  eq(out.rounds, 2, 'two rounds ran');
  ok(/No critic ran in round 2/.test(out.nextStep), 'nextStep says the stalled round had no critic');
  eq(out.determination, '', 'and NO determination is named — nothing was claimed, none was due, none was written');
  ok(/SEARCHED\.md/.test(out.nextStep) && /NEXT:/.test(out.nextStep),
    'nextStep points at the avenue log\'s own NEXT: lines — the only record left of where to go');
  ok(/same runId/.test(out.nextStep) && /criteria\/premise/.test(out.nextStep),
    'and offers the two real continuations: resume from the memory, or change the question');
  ok(logs.some((l) => /added NOTHING/.test(l)), 'and the round is called out in the log');
}

section('a LEARNING round is not a stall — ruling candidates out is progress');
// The real-run finding this protects: a round that qualifies nothing but closes several candidates is
// high-yield and answer-neutral. Counting it as "nothing" would end runs that were working.
{
  const { out, byLabel, labels } = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 3 });
  eq(byLabel('investigate').length, 3, 'a round that only appends to the ledger keeps the loop going');
  ok(!labels.includes('critique r2'), 'and after the first round spawns no critic — there is no option to check');
  eq(out.status, 'not exhaustive (round budget spent)', 'so it ends on the round budget, not on the backstop');
}

section('the FINAL round is never relabelled a stall — it owes a determination');
// The `!det` guard. With maxRounds: 1 EVERY quiet run is a final round, and calling it 'stalled' would
// hide the partial determination that round was just ordered to write and had verified.
{
  const { out, labels } = await run({ 'investigate': INV, 'critique': CRIT }, { ...baseArgs, maxRounds: 1 });
  eq(out.status, 'not exhaustive (round budget spent)', 'status — the round budget, not the backstop');
  ok(labels.includes('critique r1'), 'the determination gate still opened, so the file reaching the user was checked');
  ok(out.determination.endsWith('DETERMINATION.md'), 'and the partial determination is NAMED, not hidden behind a stall');
}

section('the critic gate: skipped over nothing, but never over a determination');
// Both halves matter. Spawning a critic over an empty round buys a meaningless verdict; NOT spawning one
// on the last round would let the determination — the file the user actually reads — reach them unchecked.
{
  const { labels } = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 3 });
  ok(labels.includes('investigate r2'), 'the investigator ran');
  ok(!labels.includes('critique r2'), 'round 2 added no OPTION and claimed nothing — no critic spawned over it');
  ok(labels.includes('critique r3'), 'but the LAST round owes a determination, so its critic runs even though the round was just as quiet');
}

section('an escalation with new options is vetted BEFORE the halt is honored');
// The one exit that could otherwise hand the user an option nobody checked. The critic runs first, and
// only its upheld ids reach the return.
{
  const { out, labels } = await run({
    'investigate': { ...INV, new_options: 2, option_ids: ['opt-good', 'opt-bad'], needs_user: true },
    'critique': { ...CRIT, upheld: ['opt-good'], verified_ids: ['opt-good'], disqualified: ['opt-bad'] },
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
    'critique': { ...CRIT, agree: true, determination_defects: 2 },
  });
  eq(out.status, 'no qualifying option exists (verified)', 'status');
  ok(out.noSolution === true && out.exhaustive === false, 'reported as a verified dead end, not as an exhaustive search');
  ok(/relaxing one criterion|relaxing a criterion|relax/.test(out.nextStep), 'nextStep tells the operator the only thing that changes the answer');
  ok(out.reviewFile.endsWith('acceptance-review-r1.md') && out.nextStep.includes(out.reviewFile),
    'nextStep points at the review, the only place a defect the critic found in the determination is recorded');
  ok(out.determinationDefects === 2, 'the critic\'s determination defects are counted on the return');
  ok(out.nextStep.includes('The critic found 2 defect(s) in the determination'), 'and nextStep states the count');
}

section('a determination count of 0 reads as clean, and a missing one as unknown, never as clean');
// The critic writes determination defects into its review file without changing agree, so the count is
// the operator's only signal. A missing count must keep pointing at the review file (#15).
{
  const TERMINALS = {
    'exhausted':   { ...INV, exhausted: true },
    'saturated':   { ...INV, saturated: true },
    'no-solution': { ...INV, no_solution: true },
  };
  for (const [name, inv] of Object.entries(TERMINALS)) {
    const { out: clean } = await run({ 'investigate': inv, 'critique': { ...CRIT, agree: true, determination_defects: 0 } });
    ok(clean.determinationDefects === 0, `${name}: a count of 0 is returned as 0`);
    ok(clean.nextStep.includes('The critic found no defect in the determination.') && !clean.nextStep.includes(clean.reviewFile),
      `${name}: nextStep says the determination is clean and sends no one to the review file for it`);

    const { out: unknown } = await run({ 'investigate': inv, 'critique': { ...CRIT, agree: true } });
    ok(unknown.determinationDefects === null, `${name}: an omitted count is null, not 0`);
    ok(unknown.nextStep.includes(unknown.reviewFile) && !/The critic found/.test(unknown.nextStep),
      `${name}: nextStep still points at the review file and claims no count`);
  }

  // A critic with no determination due is told to return 0, and that 0 must not read as a checked file.
  const { out: early } = await run({
    'investigate': (label) => (label === 'investigate r1' ? { ...INV, new_options: 1, option_ids: ['opt-a'] } : INV),
    'critique r1': { ...CRIT, upheld: ['opt-a'], determination_defects: 0 },
  }, { ...baseArgs, maxRounds: 3 });
  eq(early.status, 'stalled (a round added nothing new and claimed nothing)', 'the run stalls after a critic that owed no determination');
  ok(early.determinationDefects === null, 'a count from a round that owed no determination is ignored');

  // A later determination with no count must not inherit an earlier determination's count.
  const { out: stale } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique r1': { ...CRIT, contests_exhaustion: true, determination_defects: 3 },
    'critique r2': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 3 });
  ok(stale.determinationDefects === null, 'a count describes only the determination the critic last checked');
}

section('the determination is NEVER named where no investigator was told to write it');
// The negative side of the flag is the whole risk surface, and it is what a positive-only test misses:
// `haltKind` is INITIALISED to 'rounds', so any exit before the loop body inherits a terminal state that
// means "the last round wrote a determination" when no round ran at all.
{
  // A non-numeric bound used to coerce to NaN, make `round < NaN` false, and return a zero-agent run
  // carrying a DETERMINATION.md path. It now throws instead — the run never happened, so it may not be
  // reported as one that ran out of rounds.
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, maxRounds: 'three' } });
  ok(/Invalid numeric arg: args\.maxRounds/.test(msg) && /zero-round run/.test(msg),
    `a non-numeric maxRounds throws rather than silently running nothing: ${msg.slice(0, 60)}`);
  // The message must LEAD with a static clause: gen-flows.mjs labels a throw node with the first clause of
  // its static prefix, and starting with `args.${name}` rendered six maps' node as "throw: args.".
  ok(/^Invalid numeric arg: /.test(msg), 'and it leads with a static clause, so the flow-map node is legible');
  ok(/Invalid numeric arg: args\.minRoundBudget/.test(await throwsWith(ENGINE, { args: { ...baseArgs, minRoundBudget: {} } })),
    'a non-numeric budget floor throws too');
  ok(/Invalid numeric arg: args\.maxRounds/.test(await throwsWith(ENGINE, { args: { ...baseArgs, maxRounds: 0 } })),
    'zero rounds is rejected — it is the same silent no-op by another route');
  // `Number('')` and `Number([])` are 0 and finite, so a COERCING guard waves them through. On a floor
  // whose legal minimum IS 0 that silently disables the floor rather than shortening a loop.
  ok(/Invalid numeric arg: args\.minRoundBudget/.test(await throwsWith(ENGINE, { args: { ...baseArgs, minRoundBudget: '' } })),
    'and so is a value that merely COERCES to a legal 0');

  // The two halts that name nothing: no agent ran (budget), or the investigator escalated (needs-user).
  const { out: budget } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(budget.determination, '', 'a token-budget stop before round 1 names no determination');
  eq(budget.nearMisses, 0, 'and no near misses — nothing ran');

  const { out: escalated } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'], needs_user: true },
    'critique': { ...CRIT, upheld: ['opt-a'] },
  }, { ...baseArgs, maxRounds: 3 });
  eq(escalated.status, 'BLOCKED (needs user input)', 'status');
  eq(escalated.determination, '', 'and an escalation names no determination — the investigator escalated instead of concluding');
}

section('a later critic can REMOVE an option an earlier round upheld');
// The answer set is not append-only. The widened gate routes a full re-verification pass through quiet
// last rounds, so an option upheld in r1 can be broken in r2 — and "only upheld ids reach the caller" is
// worth nothing if the id cannot be taken back out.
{
  const { out } = await run({
    'investigate': (label) => (/r1$/.test(label) ? { ...INV, new_options: 1, option_ids: ['opt-a'] } : INV),
    'critique': (label) => (/r1$/.test(label)
      ? { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'] }
      : { ...CRIT, disqualified: ['opt-a'] }),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.options.length, 0, 'the option upheld in r1 and knocked out in r2 is gone from the answer set');
  ok(!JSON.stringify(out).includes('opt-a'), 'and appears nowhere in the return');

  // ...and it STAYS out. A later critic cannot resurrect it by listing it in `upheld`: the last round
  // always spawns a critic now, that critic is told to verify anything no earlier review cleared, and it
  // has no memory of the round that knocked the option out. Without this the answer set hands the user an
  // option their own DISQUALIFIED.md says fails a criterion — two artifacts contradicting, silently.
  // r1 finds opt-a and the critic upholds it. r2 finds opt-b, and ITS critic knocks opt-a back out. r3 is
  // the last round — quiet, but a determination is due, so a critic runs with no memory of r2 and upholds
  // opt-a again. (r2 must add an option of its own, or its critic never spawns and there is nothing to
  // disqualify — the gate is what makes this sequence reachable at all.)
  const { out: zombie, logs: zLogs } = await run({
    'investigate': (label) => (/r1$/.test(label) ? { ...INV, new_options: 1, option_ids: ['opt-a'] }
      : /r2$/.test(label) ? { ...INV, new_options: 1, option_ids: ['opt-b'] } : INV),
    'critique': (label) => (/r1$/.test(label) ? { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'] }
      : /r2$/.test(label) ? { ...CRIT, upheld: ['opt-b'], verified_ids: ['opt-b'], disqualified: ['opt-a'] }
        : { ...CRIT, verified_ids: ['opt-a', 'opt-b'] }),
  }, { ...baseArgs, maxRounds: 3 });
  eq(zombie.options.join(), 'opt-b', 'r3 upholding an id r2 disqualified does NOT put it back');
  ok(zLogs.some((l) => /IGNORED/.test(l) && /opt-a/.test(l)), 'and the attempt is logged, not silently dropped');

  // The legitimate re-open path stays open: a later round that RE-PROPOSES the option as a fresh
  // options/<id>.md gets it re-verified on its merits, and an upholding critic brings it back. That is
  // the channel the critic prompt actually documents (flag it in the review file → next investigator
  // re-proposes), which is why the block above keys on "did THIS round re-propose it".
  const { out: reopened } = await run({
    'investigate': (label) => (/r2$/.test(label) ? { ...INV, new_options: 1, option_ids: ['opt-b'] }
      : { ...INV, new_options: 1, option_ids: ['opt-a'] }),
    'critique': (label) => (/r2$/.test(label) ? { ...CRIT, upheld: ['opt-b'], verified_ids: ['opt-b'], disqualified: ['opt-a'] }
      : /r3$/.test(label) ? { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a', 'opt-b'] }
        : { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'] }),
  }, { ...baseArgs, maxRounds: 3 });
  ok(reopened.options.includes('opt-a'), 're-proposed in r3 and re-verified, it is genuinely back');

  // A critic that lists the same id both ways contradicts itself; "broken" is the only safe reading.
  const { out: both, logs } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'], disqualified: ['opt-a'] },
  }, { ...baseArgs, maxRounds: 1 });
  eq(both.options.length, 0, 'an id in BOTH lists is treated as disqualified, not upheld');
  ok(logs.some((l) => /BOTH upheld and disqualified/.test(l)), 'and the contradiction is logged rather than swallowed');
}

section('both ledger writers mark and count near misses');
// The critic appends to the same ledger. Counting only the investigator would drop the near misses found
// by the one agent that knocks out options which already looked like answers.
{
  const { out, logs } = await run({
    'investigate': { ...INV, new_options: 2, option_ids: ['a', 'b'], disqualified_added: 4, near_misses: 1, exhausted: true },
    'critique': { ...CRIT, upheld: ['a'], verified_ids: ['a'], disqualified: ['b'], near_misses: 1, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(out.nearMisses, 2, 'the investigator\'s 1 and the critic\'s 1 both count');
  ok(logs.some((l) => /2 near-miss/.test(l)), 'and the round line shows the sum');
  ok(out.options.join() === 'a', 'the disqualified option is still kept out of the answer set');

  // Self-contradictory: more near misses than rejects. A near miss IS a reject, so one number is wrong.
  const { logs: warned } = await run({
    'investigate': { ...INV, disqualified_added: 0, near_misses: 7, no_solution: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  ok(warned.some((l) => /near-miss\(es\) but only 0 reject/.test(l)),
    'the engine flags the contradiction rather than reporting the nonsense number silently');

  // The critic gets the SAME check — it appends one ledger line per id it disqualified, so more near
  // misses than disqualifications is the identical nonsense. Checking only the investigator left the
  // number §7 tells the operator to LEAD with unguarded on one of its two writers.
  const { logs: critWarned } = await run({
    'investigate': { ...INV, no_solution: true },
    'critique': { ...CRIT, disqualified: [], near_misses: 9, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  ok(critWarned.some((l) => /critic reported 9 near-miss\(es\) but disqualified only 0/.test(l)),
    'the critic\'s contradiction is flagged too, not just the investigator\'s');

  // A negative count is not a count. It used to flow straight through into the return and the log line.
  const { out: neg } = await run({
    'investigate': { ...INV, disqualified_added: 2, near_misses: -8, no_solution: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(neg.nearMisses, 0, 'a negative near-miss count floors at 0 rather than reporting -8 near misses');
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

section('priorRounds continues the round numbers of a resumed search');
// The review files and SEARCHED.md's r<N> lines are keyed by round number, so a resume that restarted at
// r1 would overwrite the earlier rounds' reviews and hand its first investigator no critique.
{
  const msg = await throwsWith(ENGINE, { args: { runId: 't', root: 'E:/r', criteria: 'c' } });
  ok(/args\.priorRounds is required/.test(msg), `a run without priorRounds throws: ${msg.slice(0, 50)}`);
  ok(/Invalid numeric arg: args\.priorRounds/.test(await throwsWith(ENGINE, { args: { ...baseArgs, priorRounds: '2' } })),
    'a priorRounds that only coerces to a number throws too');
  const { calls: refine } = await run({ 'criteria-critic': { gaps: [], questions: [], unfalsifiable: [] } },
    { runId: 't', root: 'E:/r', criteria: 'c', phase: 'refine' });
  eq(refine.length, 1, 'refine runs no rounds, so it needs no priorRounds');

  const { out, byLabel } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': CRIT,
  }, { ...baseArgs, priorRounds: 2, maxRounds: 2 });
  eq(byLabel('investigate').map((c) => c.label).join(), 'investigate r3,investigate r4',
    'the rounds continue at r3, and maxRounds counts only this run\'s rounds');
  const [p3, p4] = byLabel('investigate').map((c) => c.prompt);
  ok(/resumes after round 2/.test(p3) && p3.includes('acceptance-review-r2.md') && /round 3 of at most 4/.test(p3),
    'the first resumed investigator is pointed at the last run\'s review');
  ok(p4.includes('acceptance-review-r3.md') && !/resumes after/.test(p4) && /round 4 is this run's LAST/.test(p4),
    'the next round reads this run\'s review and owes the determination');
  eq(byLabel('critique').map((c) => c.label).join(), 'critique r3,critique r4', 'the critics write r3 and r4, never over r1 or r2');
  eq(out.rounds, 4, 'rounds counts the whole search');
  ok(/priorRounds: 4/.test(out.nextStep), 'nextStep names the priorRounds that continues the search');

  const { out: stopped } = await run({}, { ...baseArgs, priorRounds: 3 }, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  ok(/Stopped before round 4/.test(stopped.haltReason) && /priorRounds: 3/.test(stopped.haltReason),
    'a budget stop names the round it did not start and the priorRounds to pass');
  eq(stopped.determination, '', 'and names no determination, since no round of this run wrote one');
}

section('the token budget stops cleanly between rounds');
{
  const { out, calls } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(calls.length, 0, 'stopped before spawning anything');
  eq(out.status, 'stopped on token budget (resume where it left off)', 'status');
  ok(/same args and priorRounds: 0/.test(out.haltReason) && /DISQUALIFIED\.md/.test(out.haltReason),
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

section('near misses survive the ledger — counted across rounds, logged, and led with on a dead end');
// A candidate that failed EXACTLY ONE criterion is the actionable residue of a search that qualifies
// nothing. It is one line among hundreds in the ledger, so if the return does not carry it, it is lost —
// and on a no-solution run it is the only thing the user can act on.
{
  const { out, logs } = await run({
    'investigate': { ...INV, disqualified_added: 9, near_misses: 2, no_solution: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(out.status, 'no qualifying option exists (verified)', 'status');
  eq(out.nearMisses, 2, 'the count reaches the return');
  ok(logs.some((l) => /2 near-miss/.test(l)), 'and the round line shows it next to the ledger growth');
  ok(/NEAR MISS\(es\)/.test(out.nextStep), 'nextStep leads with them — on a dead end they are the only actionable finding');

  // Counted ACROSS rounds, not just the last one: the ledger is cumulative, so the tally must be too.
  const { out: multi } = await run({
    'investigate': { ...INV, disqualified_added: 4, near_misses: 3 },
    'critique': CRIT,
  }, { ...baseArgs, maxRounds: 3 });
  eq(multi.nearMisses, 9, 'three rounds at 3 each — the tally accumulates rather than reporting the last round');

  // A quiet search must not manufacture one: 0 near misses keeps the phrase out of nextStep entirely.
  const { out: none } = await run({
    'investigate': { ...INV, no_solution: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(none.nearMisses, 0, 'none found');
  ok(!/NEAR MISS/.test(none.nextStep), 'and nextStep says nothing about near misses when there are none');
}

section('the LAST round is told to write the determination; earlier rounds are not');
// The engine cannot write the file itself (the harness has no tools), so "a determination exists on a
// round-budget exit" is only true if the prompt asks for it. That makes this a contract, not a hope.
{
  const { byLabel } = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 2 });
  const [p1, p2] = byLabel('investigate').map((c) => c.prompt);
  ok(!/this run's LAST/.test(p1), 'round 1 is not told it is last');
  ok(/this run's LAST/.test(p2) && /PARTIAL result/.test(p2),
    'the final round is, and is told to label the file a partial result when it cannot claim termination');
  ok(p1.includes('DETERMINATION.md') && p2.includes('DETERMINATION.md'), 'both rounds are told where it goes');
}

section('the determination has a specified shape, and the critic is pointed at it');
// The defect this fixes: "the cross-option comparison" was the whole spec, so what a multi-option run
// produced was whatever that investigator felt like writing. Each named section is load-bearing.
{
  const { prompt } = await run({
    'investigate': { ...INV, new_options: 2, option_ids: ['opt-a', 'opt-b'], exhausted: true },
    'critique': { ...CRIT, upheld: ['opt-a', 'opt-b'], agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  const inv = prompt('investigate');
  for (const s of ['ANSWER', 'COMPARISON', 'WHICH TO PICK WHEN', 'NEAR MISSES', 'COVERAGE']) {
    ok(inv.includes(s), `the investigator is told to write the ${s} section`);
  }
  ok(/NOT the criteria/.test(inv), 'and told NOT to table the criteria every qualifier passes — that compares nothing');
  ok(/UNRANKED/.test(inv), 'the options are explicitly unranked — ranking pass/fail qualifiers is decide-cycle\'s job');
  ok(/NEAR-MISS: /.test(inv), 'the ledger marker is spelled out so the determination can be built from it');

  const crit = prompt('critique');
  ok(crit.includes('DETERMINATION.md') && /smuggles in a ranking/.test(crit),
    'the critic reads the product file and is told the specific ways it goes wrong');
  ok(/NEAR-MISS/.test(crit), 'and re-checks the near-miss markers — an over-claimed one poisons the determination');
}

section('SEARCHED.md is the SECOND memory file, and both roles are pointed at it every round');
// The ledger closes CANDIDATES; this closes GROUND. Without it, which avenues were already walked lives
// only in the TERMINATING round's DETERMINATION — so every non-terminating round re-runs the last round's
// searches with the same terms and calls the same candidates new.
{
  const { byLabel, prompt } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': CRIT,
  }, { ...baseArgs, maxRounds: 2 });
  const [p1, p2] = byLabel('investigate').map((c) => c.prompt);
  ok(p1.includes('SEARCHED.md') && p2.includes('SEARCHED.md'),
    'every investigator round names it — memory re-read at the top of the round, like the ledger');
  ok(/r1 SWEPT: /.test(p1) && /r2 SWEPT: /.test(p2), 'the SWEPT line is templated with the round number');
  ok(/r1 NEXT: /.test(p1) && /confidence: high\|medium\|low\|none/.test(p1),
    'and exactly one NEXT line, carrying the same scale the schema enumerates');
  // Append-only is what makes a shared memory file safe, and it is stated for the ledger already. A
  // SEARCHED.md without it would be rewritten each round and stop being memory at all.
  eq((p1.match(/never rewrite, reorder or prune/g) || []).length, 2,
    'append-only discipline is spelled out for BOTH memory files, in the same terms');
  ok(prompt('critique').includes('SEARCHED.md'),
    'the critic reads it too — it is the record its coverage attack is checked against');
}

section('a coverage contest costs a citation — an uncited one is not a contest');
// "Name ONE avenue" was free: a bare "you missed something" can be said about any search that ever ended,
// and it buys a whole round. The citation is what makes the contest falsifiable.
{
  const { prompt } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique': { ...CRIT, contests_exhaustion: true },
  }, { ...baseArgs, maxRounds: 1 });
  const crit = prompt('critique');
  ok(/An UNCITED contest is not a contest\./.test(crit), 'the critic is told so in those words');
  ok(/the source plus the exact locator/.test(crit), 'the citation must carry a source AND a locator');
  ok(/which criterion or search-space bound/.test(crit),
    'and connect to the criterion or search-space bound it puts back in play');
  ok(/contests_exhaustion=true only\s+with that citation/.test(crit), 'and the contest flag is gated on that citation');
}

section('saturation is a standing instruction from round 2 — round 1 has nothing to compare against');
{
  const { byLabel } = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 2 });
  const [p1, p2] = byLabel('investigate').map((c) => c.prompt);
  ok(!/DIMINISHING RETURNS/.test(p1), 'round 1 has no earlier round to measure a collapse against, so it is never offered the claim');
  ok(/saturated = DIMINISHING RETURNS/.test(p2), 'round 2 is');
  ok(/SEARCHED\.md/.test(p2) && /well under half/.test(p2),
    'and is told what to measure against and where — a threshold in numbers, checked against the avenue log');
  ok(/never both/.test(p2), 'plus that the stronger claim wins, so a return carrying both is not offered as an option');
}

section('WHERE NEXT is part of the determination shape, and the critic checks for it');
// The section that makes a STOPPED result resumable. Without it a saturation, a no-solution and a partial
// round all read like finished searches with nothing left to do.
{
  const { prompt } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'], no_solution: true },
    'critique': { ...CRIT, upheld: ['opt-a'], agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  const inv = prompt('investigate');
  ok(/WHERE NEXT — REQUIRED/.test(inv), 'the investigator is told to write it, and exactly when it is required');
  ok(/confidence: high\|medium\|low\|none/.test(inv), 'one line per unswept avenue, on the scale the schema enumerates');
  ok(/premise or the criteria/.test(inv), 'plus the change that would open search space this run could not reach');
  ok(/WHERE NEXT/.test(prompt('critique')), 'and the critic\'s determination checklist covers it');
}

section('a saturation contest costs a citation too, and attacks different evidence');
{
  const crit = (await run({
    'investigate': { ...LEARN, saturated: true },
    'critique': { ...CRIT, contests_saturation: true },
  }, { ...baseArgs, maxRounds: 1 })).prompt('critique');
  ok(/ATTACK THE SATURATION CLAIM/.test(crit), 'the critic gets the saturation branch');
  ok(!/ATTACK THE COVERAGE CLAIM/.test(crit), 'and only that one — the two claims are checked against different things');
  ok(/It is NOT that the search is CLOSED/.test(crit),
    'it is told what saturation does NOT assert, so it cannot attack a weaker claim as if it were exhaustion');
  ok(/An UNCITED contest is not a contest\./.test(crit), 'an uncited contest is refused in the same words as the coverage one');
  ok(/the source plus the exact locator/.test(crit) && /criterion or a search-space bound/.test(crit),
    'the citation carries a source, a locator, and the bound it puts back in play');
  ok(/contests_saturation=true/.test(crit), 'and the flag it must set is named');
}

section('the trajectory carries the search\'s shape round by round');
// A single round cannot tell a search still opening ground from one grinding over what the ledger already
// closed — 0 new options looks identical either way. Both new schema fields are consumed HERE and in the
// round log; a field the harness never reads is attestation theater (tests/CLAUDE.md §3).
{
  const { out, logs } = await run({
    'investigate': (label) => (/r1$/.test(label)
      ? { ...INV, new_options: 1, option_ids: ['opt-a'], disqualified_added: 3, rediscovered: 3, next_avenue_confidence: 'medium' }
      : { ...INV, rediscovered: 7, next_avenue_confidence: 'none' }),
    'critique': (label) => (/r1$/.test(label) ? { ...CRIT, upheld: ['opt-a'], disqualified: ['opt-b'] } : CRIT),
  }, { ...baseArgs, maxRounds: 2 });
  eq(out.trajectory.length, 2, 'one entry per investigator round');
  eq(JSON.stringify(out.trajectory[0]),
    JSON.stringify({ round: 1, options: 1, disqualified: 4, rediscovered: 3, confidence: 'medium' }),
    'counts and the enum only (#8) — the findings stay in the files');
  eq(out.trajectory[1].confidence, 'none',
    'a round reporting no unswept avenue left is visible in the shape, not only in a prose file');
  ok(logs.some((l) => /\+1 option\(s\), 4 disqualified, 3 rediscovered, next: medium/.test(l)),
    'and the round line shows both new numbers beside the ledger growth');
  ok(out.searchTrail.includes('SEARCHED.md'), 'searchTrail points the operator at the avenue log too');

  // Garbage in the control plane must not reach the operator, and must not reach a stop rule reading the
  // trajectory as measurements.
  const { out: junk, logs: junkLogs } = await run({
    'investigate': { ...INV, rediscovered: -8, next_avenue_confidence: 'pretty sure', no_solution: true },
    'critique': { ...CRIT, agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  eq(junk.trajectory[0].rediscovered, 0, 'a negative rediscovered count floors at 0, exactly like near_misses');
  eq(junk.trajectory[0].confidence, '', 'a value outside the enum is taken as NO signal rather than passed through');
  ok(!junkLogs.some((l) => /pretty sure/.test(l)), 'and it is never printed into the round log');
  ok(!junkLogs.some((l) => /next:/.test(l)),
    'which drops the field entirely rather than logging "next: " with nothing behind it');
  ok(!junkLogs.some((l) => /rediscovered/.test(l)), 'a zero rediscovered count stays out of the line too');
}

section('the investigator prompt names the ledger every round, and a review file only when one exists');
{
  const quiet = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 3 });
  const [p1, p2, p3quiet] = quiet.byLabel('investigate').map((c) => c.prompt);
  ok(p1.includes('DISQUALIFIED.md') && p1.includes('/options'), 'r1 names the ledger + the options dir');
  ok(p2.includes('DISQUALIFIED.md') && p2.includes('/options'), 'r2 names them again — the memory is re-read every round');
  ok(!/acceptance-review-r\d/.test(p3quiet), 'after a skipped-critic round it names NO review file');

  const busy = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': CRIT,
  }, { ...baseArgs, maxRounds: 2 });
  ok(busy.byLabel('investigate')[1].prompt.includes('acceptance-review-r1.md'),
    'and it DOES name the review file after a round that wrote one');
  ok(busy.prompt('critique').includes('opt-a'), 'the critic is told exactly which option ids to verify');

  // A learning round skips the critic and has already answered r1's review, so r3 must not be sent back
  // to re-answer it as if it were fresh.
  const stale = await run({
    'investigate': (label) => (/r1$/.test(label) ? { ...INV, new_options: 1, option_ids: ['opt-a'] } : LEARN),
    'critique': { ...CRIT, upheld: ['opt-a'] },
  }, { ...baseArgs, maxRounds: 4 });
  const p3 = stale.byLabel('investigate')[2].prompt;
  ok(p3.includes('NO critique was written'), 'after a critic-less learning round r3 is told no critique was written');
  ok(!p3.includes('acceptance-review-r1.md'), 'and r3 does NOT name the r1 review the learning round already answered');
  ok(stale.logs.some((l) => /r2: search continues/.test(l) && /DISQUALIFIED\.md/.test(l) && !/acceptance-review-r1/.test(l)),
    'the r2 continue log names the ledger, not the stale r1 review');
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

section('an unknown phase throws instead of silently running the full search');
// 'Refine' is the meta.phases title, so it is the plausible typo, and it skipped the mandatory criteria refine.
{
  for (const bad of ['Refine', 'search', 7]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, phase: bad }, respond: {} });
    ok(/^Invalid phase: args\.phase must be refine \| run/.test(msg), `phase ${JSON.stringify(bad)} throws: ${msg.slice(0, 70)}`);
  }
  const { calls } = await run({ 'criteria-critic': { gaps: [], questions: [], unfalsifiable: [] } }, { ...baseArgs, phase: 'refine' });
  eq(calls.length, 1, 'refine still runs');
}

section('an investigator that did not attest its files halts before any critic spawns');
// The critic and the return would name those files, and a same-runId re-run can leave stale ones there.
{
  const { out, labels } = await run({ 'investigate': { ...INV, wrote_files: false, new_options: 1, option_ids: ['o'], exhausted: true }, 'critique': { ...CRIT, agree: true } });
  ok(!labels.some((l) => l.startsWith('critique')), 'no critic spawned');
  eq(out.status, 'BLOCKED (an agent did not confirm writing its files - check them, then relaunch fresh with the same runId and no resumeFromRunId)', 'status');
  ok(out.halted === true, 'reported halted');
  ok(/investigator did not confirm writing its files in round 1: .*options\/, .*DISQUALIFIED\.md, .*SEARCHED\.md and .*DETERMINATION\.md/.test(out.haltReason),
    `the reason names every owed file: ${out.haltReason}`);
  eq(out.determination, '', 'no determination is named');
  ok(/FRESH run with the same runId, priorRounds: 0 and no resumeFromRunId/.test(out.nextStep), 'nextStep relaunches so the halted round re-runs');

  const { out: escalated } = await run({ 'investigate': { ...INV, wrote_files: false, needs_user: true }, 'critique': CRIT });
  eq(escalated.status, 'BLOCKED (needs user input)', 'an escalation keeps its own terminal');
}

section('a critic that did not attest its review file halts before its verdict is applied');
{
  const { out, labels } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['o'], exhausted: true },
    'critique': { ...CRIT, wrote_file: false, upheld: ['o'], agree: true },
  }, { ...baseArgs, maxRounds: 3 });
  eq(out.status, 'BLOCKED (an agent did not confirm writing its files - check them, then relaunch fresh with the same runId and no resumeFromRunId)', 'status');
  ok(!labels.includes('investigate r2'), 'no next investigator is sent to the unwritten review');
  eq(out.reviewFile, '', 'no review file is named');
  eq(out.determination, '', 'no determination is named');
  eq(out.options.length, 0, 'its upheld list was never applied');
  ok(/critic did not confirm writing .*acceptance-review-r1\.md in round 1/.test(out.haltReason), 'the reason names the file');

  // The halted round's options and claim were never verified, so the relaunch must re-run it, not skip it.
  const { out: resumed } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['o'], exhausted: true },
    'critique': { ...CRIT, wrote_file: false, upheld: ['o'], agree: true },
  }, { ...baseArgs, priorRounds: 2, maxRounds: 3 });
  eq(resumed.rounds, 3, 'the resumed run halted in r3');
  ok(/FRESH run with the same runId, priorRounds: 2 and no resumeFromRunId/.test(resumed.nextStep),
    `nextStep names the priorRounds that re-runs r3: ${resumed.nextStep.slice(0, 160)}`);
}

section('a critic that agrees but flags a candidate for re-opening buys another round');
// A written but uncounted re-open finding let an agreed claim end the run as a closed search.
{
  const { out, labels, logs } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique': (label) => (/r1$/.test(label) ? { ...CRIT, agree: true, reopened: 1 } : { ...CRIT, agree: true }),
  }, { ...baseArgs, maxRounds: 3 });
  ok(labels.includes('investigate r2'), 'another investigator round ran');
  ok(logs.some((l) => /termination claim not accepted \(the critic flagged 1 disqualified candidate\(s\) for re-opening\)/.test(l)), 'the log names the re-open count');
  eq(out.status, 'exhaustive (search closed, critic agreed)', 'round 2 closes once nothing is flagged');

  const { labels: missing, logs: missingLogs } = await run({
    'investigate': { ...INV, exhausted: true },
    'critique': (label) => {
      if (!/r1$/.test(label)) return { ...CRIT, agree: true };
      const { reopened, ...noCount } = { ...CRIT, agree: true };
      return noCount;
    },
  }, { ...baseArgs, maxRounds: 3 });
  ok(missing.includes('investigate r2'), 'a missing count is unknown, never zero, so it buys a round too');
  ok(missingLogs.some((l) => /the critic returned no re-open count/.test(l)), 'and the log says why');
}

section('each option file carries the critic\'s verdict, and the run\'s result comes from the files');
// The answer set used to be this run's `upheld` lists, so a resumed run dropped every option an earlier
// run verified, and option files an interrupted round left behind reached no critic.
{
  const { prompt } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'], exhausted: true },
    'critique': { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'], agree: true },
  }, { ...baseArgs, maxRounds: 1 });
  const crit = prompt('critique');
  ok(crit.includes('`verdict: upheld r1`') && crit.includes('`verdict: disqualified r1`') && /FIRST line/.test(crit),
    'the critic is told the exact verdict line, its round included, and where it goes');
  ok(crit.includes('options/opt-a.md') && /every other file in \S+\/options\/ that is UNVERIFIED/.test(crit),
    'and judges this round\'s ids plus every unverified file in options/');
  ok(/does not read `verdict: upheld`/.test(crit) && /omits an option whose file reads `verdict: upheld`/.test(crit),
    'its determination check counts both a link to an option not upheld and an upheld option left unlinked');
  const inv = prompt('investigate');
  ok(/Never write\s+a verdict line yourself/.test(inv) && /rewrite its whole file with no verdict line/.test(inv),
    'the investigator reads the verdict lines, never writes one, and re-proposes by rewriting the file');

  // The forced first-round critic: an interrupted round's files are judged by the next run's first critic.
  const resumed = await run({ 'investigate': INV, 'critique': CRIT }, { ...baseArgs, priorRounds: 2, maxRounds: 3 });
  ok(resumed.labels.includes('critique r3'), 'a resumed run\'s quiet first round still spawns critique r3');
  eq(resumed.out.status, 'stalled (a round added nothing new and claimed nothing)', 'and then stalls');
  ok(/critic judged the files in \S+\/options\//.test(resumed.out.nextStep) && /`options` holds the verified set/.test(resumed.out.nextStep),
    'the stalled nextStep says the critic judged the option files and `options` holds the verified set');
  ok(!/no critic ran/i.test(resumed.out.nextStep) && !/nothing here is verified/i.test(resumed.out.nextStep),
    'and never says that no critic ran');
  ok(resumed.logs.some((l) => /added NOTHING/.test(l) && /critic judged the files/.test(l)), 'the stalled log line says so too');
  // The forced critic may rule a leftover file out, so the stall texts must not deny that ledger line.
  const pruned = await run({ 'investigate': INV, 'critique': { ...CRIT, disqualified: ['opt-leftover'] } }, { ...baseArgs, priorRounds: 2, maxRounds: 3 });
  eq(pruned.out.status, 'stalled (a round added nothing new and claimed nothing)', 'a quiet first round whose critic disqualifies a leftover file still stalls');
  ok(/investigator added NOTHING/.test(pruned.out.nextStep) && /disqualified 1 of them/.test(pruned.out.nextStep) && !/produced nothing/.test(pruned.out.nextStep),
    'its nextStep scopes the nothing to the investigator, names the critic\'s disqualification and never says the search produced nothing');
  ok(pruned.logs.some((l) => /investigator added NOTHING/.test(l) && /disqualified 1 of them/.test(l)), 'its stalled log line names the disqualification too');
  const { verified_ids: _unread, ...noList } = CRIT;
  const unread = await run({ 'investigate': INV, 'critique': noList }, { ...baseArgs, priorRounds: 2, maxRounds: 3 });
  ok(/`options` is null/.test(unread.out.nextStep) && !/`options` holds/.test(unread.out.nextStep),
    'a stall after a critic that returned no verified_ids says `options` is null, never that it holds the verified set');
  const fresh = await run({ 'investigate': INV, 'critique': CRIT }, { ...baseArgs, maxRounds: 3 });
  ok(fresh.labels.includes('critique r1'), 'a fresh run\'s quiet first round spawns critique r1');
  const later = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 3 });
  ok(!later.labels.includes('critique r2'), 'a quiet round after the run\'s first round still skips the critic');

  // The return reads the latest critic's verified_ids, an earlier run's upheld option included.
  const { out: carried } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-new'], exhausted: true },
    'critique': { ...CRIT, upheld: ['opt-new'], verified_ids: ['opt-old', 'opt-new'], agree: true },
  }, { ...baseArgs, priorRounds: 2, maxRounds: 2 });
  eq(carried.options.join(), 'opt-old,opt-new', 'out.options is the last critic\'s verified_ids');
  eq(carried.optionFiles.map((f) => f.replace(/^.*\//, '')).join(), 'opt-old.md,opt-new.md', 'and optionFiles is derived from it');

  const { out: both, logs: bothLogs } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': { ...CRIT, verified_ids: ['opt-a', 'opt-b'], disqualified: ['opt-a'] },
  }, { ...baseArgs, maxRounds: 1 });
  eq(both.options.join(), 'opt-b', 'an id in both verified_ids and disqualified of one critic is dropped');
  ok(bothLogs.some((l) => /opt-a/.test(l) && /BOTH upheld and disqualified/.test(l)), 'and logged');

  const { verified_ids: _omitted, ...NO_SET } = CRIT;
  const { out: unknown, logs: unknownLogs } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': { ...NO_SET, upheld: ['opt-a'] },
  }, { ...baseArgs, maxRounds: 1 });
  ok(unknown.options === null && unknown.optionFiles === null, 'a critic return without verified_ids gives out.options === null');
  ok(/an unknown number of option\(s\) qualified so far/.test(unknown.nextStep), 'the round-budget nextStep says the count is unknown');
  ok(unknownLogs.some((l) => /round budget spent/.test(l) && /an unknown number of option\(s\) qualified/.test(l)),
    'and so does the last-round log');
  ok(unknownLogs.some((l) => /^investigate: .*an unknown number of qualifying option\(s\)/.test(l)), 'and the final log');

  const BUDGET = { total: 400_000, spent: () => 0, remaining: () => 40_000 };
  const { out: resumedStop } = await run({}, { ...baseArgs, priorRounds: 2 }, BUDGET);
  ok(resumedStop.options === null, 'a resumed run that stops on budget before its first round gives null: the files may hold upheld options');
  const { out: freshStop } = await run({}, baseArgs, BUDGET);
  ok(Array.isArray(freshStop.options) && freshStop.options.length === 0, 'a fresh run that stops the same way gives [] (guard)');

  // The relaunch re-runs the halted round as its first round, whose critic always runs and rewrites that review.
  const { out: unattested1 } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['o'] },
    'critique': { ...CRIT, wrote_file: false },
  }, { ...baseArgs, maxRounds: 3 });
  const { out: unattested2 } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['o'] },
    'critique': (label) => (/r2$/.test(label) ? { ...CRIT, wrote_file: false } : CRIT),
  }, { ...baseArgs, maxRounds: 3 });
  for (const [r, o] of [[1, unattested1], [2, unattested2]]) {
    ok(o.halted === true && new RegExp(`in round ${r}`).test(o.haltReason), `the critic-unattested halt fires in round ${r}`);
    ok(!/Move that file aside/.test(o.haltReason) && !/Move that file aside/.test(o.nextStep), `and round ${r}'s haltReason no longer says "Move that file aside"`);
  }
}
