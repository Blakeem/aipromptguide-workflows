// investigate/investigate-cycle.mjs — bounded exhaustive search with memory.
// Focus: the SEVEN terminal statuses, each asserted as a whole literal. "Ran out of rounds", "ran out of
// tokens", "nothing can qualify", "stopped on diminishing returns" and "the round added nothing" are five
// different facts, and a test that asserts only "the loop ended" passes just as well when the engine
// reports the wrong one — which is exactly how fatigue would come to masquerade as a proof. After that:
// the critic gate, dead agents (a dead investigator must never read as an exhausted search), and what the
// prompts actually name.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/investigate/investigate-cycle.mjs';

const baseArgs = { runId: 't', root: 'E:/r', criteria: '## Question\nQ\n## Acceptance Criteria\n- c1' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// An EMPTY round: nothing found, nothing ruled out, nothing claimed. Spread over it to script the
// interesting cases — but note that on its own it now STALLS the run at r1, so a scenario that needs a
// second round scripts LEARN instead.
const INV  = { wrote_files: true, new_options: 0, disqualified_added: 0, near_misses: 0, rediscovered: 0, next_avenue_confidence: 'low', exhausted: false, no_solution: false, saturated: false, needs_user: false, option_ids: [] };
const CRIT = { wrote_file: true, upheld: [], disqualified: [], near_misses: 0, contests_exhaustion: false, contests_saturation: false, agree: false, needs_user: false };
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
  ok(out.exhaustive === false, 'nothing is reported as exhaustive');
  // The determination IS named here — the last round writes it as a labelled PARTIAL result — so the
  // caveat has to travel with it, or a partial answer reads exactly like a finished one.
  ok(out.determination.endsWith('DETERMINATION.md'), 'the partial determination is surfaced');
  ok(/PARTIAL result/.test(out.nextStep) && /not.*complete answer/i.test(out.nextStep),
    'and nextStep says plainly that it is partial, not a complete answer');
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

section('an agreed saturation claim is a STOPPED search with its own terminal, never a closed one');
// The failure this exists to prevent: a critic agrees to "I am not finding more", and the run reports it
// with the same word it uses for a search that was PROVED complete. They are different facts.
{
  const { out, byLabel } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'], saturated: true },
    'critique': { ...CRIT, upheld: ['opt-a'], agree: true },
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
// The backstop, and the only terminal reached with no critic at all. An empty round leaves the next round
// nothing to diverge FROM, so another one costs full price for the same result. r1 counts: nothing at the
// start just means we exit.
{
  const { out, labels, logs } = await run({ 'investigate': INV, 'critique': CRIT }, { ...baseArgs, maxRounds: 5 });
  eq(labels.join(), 'investigate r1', 'it stopped at r1 — no second round, and no critic spawned over nothing');
  eq(out.status, 'stalled (a round added nothing new and claimed nothing — stopped unverified)', 'status');
  eq(out.rounds, 1, 'one round ran');
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
  ok(!labels.includes('critique r1'), 'and still spawns no critic — there is no option to check');
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
  const { labels } = await run({ 'investigate': LEARN, 'critique': CRIT }, { ...baseArgs, maxRounds: 2 });
  ok(labels.includes('investigate r1'), 'the investigator ran');
  ok(!labels.includes('critique r1'), 'round 1 added no OPTION and claimed nothing — no critic spawned over it');
  ok(labels.includes('critique r2'), 'but the LAST round owes a determination, so its critic runs even though the round was just as quiet');
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
      ? { ...CRIT, upheld: ['opt-a'] }
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
    'critique': (label) => (/r1$/.test(label) ? { ...CRIT, upheld: ['opt-a'] }
      : /r2$/.test(label) ? { ...CRIT, upheld: ['opt-b'], disqualified: ['opt-a'] }
        : { ...CRIT, upheld: ['opt-a'] }),
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
    'critique': (label) => (/r2$/.test(label) ? { ...CRIT, upheld: ['opt-b'], disqualified: ['opt-a'] }
      : { ...CRIT, upheld: ['opt-a'] }),
  }, { ...baseArgs, maxRounds: 3 });
  ok(reopened.options.includes('opt-a'), 're-proposed in r3 and re-verified, it is genuinely back');

  // A critic that lists the same id both ways contradicts itself; "broken" is the only safe reading.
  const { out: both, logs } = await run({
    'investigate': { ...INV, new_options: 1, option_ids: ['opt-a'] },
    'critique': { ...CRIT, upheld: ['opt-a'], disqualified: ['opt-a'] },
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
    'critique': { ...CRIT, upheld: ['a'], disqualified: ['b'], near_misses: 1, agree: true },
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
  ok(/unfalsifiable/.test(crit), 'the reason is stated, not just the rule');
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
  const quiet = await run({ 'investigate': LEARN }, { ...baseArgs, maxRounds: 2 });
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
