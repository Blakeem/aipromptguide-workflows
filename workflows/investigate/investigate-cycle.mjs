export const meta = {
  name: 'investigate-cycle',
  description: 'Bounded exhaustive search, lean/file-bus design: ONE investigator per round hunts for an EXISTING answer that meets fixed PASS/FAIL criteria — writing each qualifier to options/<id>.md and every reject to an append-only DISQUALIFIED.md ledger it re-reads at the top of every round, so each round diverges from what already failed instead of circling — and an adversarial NON-BLIND critic verifies each new option against every criterion (and every citation against its source) before it counts. The loop ends when the investigator can EVIDENCE that no avenues remain and the critic agrees, not when the first answer works. Running out of rounds, running out of tokens, proving that nothing can qualify, stopping on critic-verified SATURATION (diminishing returns — the search stays OPEN, not closed) and STALLING on a round that added nothing at all are DIFFERENT terminal states and are never folded together. The harness only routes ids, paths + verdicts; every finding lives in files.',
  whenToUse: 'Find an answer that likely ALREADY EXISTS and qualify it against fixed pass/fail criteria — a library, tool, API, config, technique or precedent that must satisfy every constraint, plus the evidence that nothing better was left unsearched. The main agent authors the CRITERIA (the question, the pass/fail criteria, the evidence standard, the search space) in PLAN MODE, approves them with the user, runs MANDATORY phase:"refine" (an independent criteria critic returns gaps + blocking questions + criteria no evidence could settle), folds the answers back into the criteria file, then runs phase:"run" with the same runId. Use decide-cycle instead when no established answer exists and the real work is WEIGHING trade-offs among approaches the AI generates; brainstorm-cycle for creative variations a human picks between; to BUILD what the determination names, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent criteria critic reads the criteria and returns gaps, blocking questions, and any criterion no evidence could settle either way. Writes nothing.' },
    { title: 'Investigate', detail: 'ONE investigator per round (sequential, which is what makes a single shared ledger safe): reads the criteria verbatim + the whole DISQUALIFIED.md ledger + the last critique, searches, self-checks every candidate against every criterion, writes options/<id>.md per qualifier, appends each reject to the ledger (marking NEAR-MISS: the ones that failed exactly one criterion), and writes DETERMINATION.md — the options, a comparison over the axes they DIFFER on, which to pick when, the near misses and the coverage evidence — on a terminating round AND on the last round the budget allows, where it is labelled a partial result.' },
    { title: 'Critique', detail: 'Adversarial non-blind critic — skipped only in a round that adds no option, claims no termination, owes no determination and is not this run\'s first round: verifies each new option and every unverified option file against every criterion and each citation against its source, writes its verdict as the first line of each file it judges, disqualifies what fails (appending to the same ledger), re-checks every NEAR-MISS marker, attacks any exhaustion / no-solution / saturation claim, and checks the determination when one was written. Agreement on a claim ends the loop; a contested claim buys another round.' },
  ],
};

// =============================================================================
// Config: everything investigation-specific arrives via args so the engine stays general.
// One investigator per round, then the critic, never in parallel: that alone keeps the shared ledger safe.
// =============================================================================
// args arrives from the Workflow tool VERBATIM and unvalidated, so a structural typo in a hand-built
// payload dies here as a bare parse error naming the runtime. Name the payload and the fix instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, criteria|planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const PHASE       = A.phase ?? 'run';                       // 'refine' (critique the criteria, stop) | 'run' (search)
if (A.phase != null && A.phase !== 'refine' && A.phase !== 'run') {
  throw new Error(`Invalid phase: args.phase must be refine | run; got ${JSON.stringify(A.phase)}. It is not coerced, because any other value would skip the mandatory criteria refine and run the full search.`);
}
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL read-only context
const CONTEXT     = A.context ?? '';                        // short extra framing (domain facts the agents won't know)
const TESTBED     = A.testbed ?? '';                        // OPTIONAL: how agents may empirically test a candidate
// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0.
// The upper bound stops a fat-fingered maxRounds from spawning agents until something dies.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round run and reports it as an ordinary round-budget exit.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 5, 50);    // this invocation's investigator ⇄ critic rounds before "not exhaustive"
// Token floor to START another round. A round that begins with too little budget dies mid-search and
// leaves the ledger half-written; stopping cleanly between rounds keeps the memory consistent and makes
// the resume free (mirrors develop-cycle's minPlanBudget).
const MIN_ROUND_BUDGET = num(A.minRoundBudget, 'minRoundBudget', 0, 100_000);

// Per-role model tiers + OPTIONAL custom subagent types. All three roles are opus: the search is the
// hard part, the critic must re-verify citations against their sources, and there are few agents per
// run — this is not a fan-out where a fast tier pays.
const M  = { criteria: 'opus', investigate: 'opus', critique: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const OPTIONS_DIR = `${STATE_DIR}/options`;                 // one file per option written (a disqualified one's file stays)
const LEDGER      = `${STATE_DIR}/DISQUALIFIED.md`;         // append-only search memory (both roles write it)
const SEARCHED    = `${STATE_DIR}/SEARCHED.md`;             // append-only avenue log: swept ground + what is next
const DETERMINATION = `${STATE_DIR}/DETERMINATION.md`;      // the cross-option comparison + coverage evidence
const reviewFile  = (r) => `${STATE_DIR}/acceptance-review-r${r}.md`;
const NEEDS_USER  = `${STATE_DIR}/NEEDS-USER.md`;           // user-only escalations (may halt the run)

// Criteria: the FIXED pass/fail rubric, read verbatim (#2/#11) by the investigator AND the critic. The
// single source of truth that makes qualification decidable. Either a plan-mode file or an inline string.
// This guard is UNCONDITIONAL — it fires for every phase, refine included, so there is no second
// refine-only "with neither" branch to drift out of sync (or to sit unreachable behind this one).
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const CRITERIA    = (!PLAN_PATH && A.criteria) ? String(A.criteria) : '';
if (!PLAN_PATH && !CRITERIA) {
  throw new Error('Provide the acceptance criteria the search qualifies candidates against: either planPath (a plan-mode criteria file) or criteria (an inline string with the question, the PASS/FAIL criteria, and the evidence standard).');
}
const CRITERIA_REF = PLAN_PATH
  ? `the criteria at ${PLAN_PATH} (read them verbatim: the fixed pass/fail rubric)`
  : `the criteria below:\n-----\n${CRITERIA}\n-----`;

// A resumed search continues the round numbers that name the review files and SEARCHED.md's r<N> lines.
// The engine reads no files, so the operator passes the count, and a default would let a forgotten one
// overwrite the earlier rounds' reviews.
if (PHASE === 'run' && A.priorRounds == null) {
  throw new Error('args.priorRounds is required for phase:"run": pass 0 for a new search, or the value the last run\'s nextStep names to continue it.');
}
const PRIOR_ROUNDS = num(A.priorRounds, 'priorRounds', 0, 0);
const LAST_ROUND   = PRIOR_ROUNDS + MAX_ROUNDS;
const firstRound   = (r) => r === PRIOR_ROUNDS + 1;
const resumedRound = (r) => PRIOR_ROUNDS > 0 && firstRound(r);

// Sources — an OPTIONAL starting set of avenues (strings, or { id, focus }). Deliberately not a fan-out
// key: one investigator per round sweeps them all, because the ledger only stays consistent with a
// single writer at a time.
const SOURCES = (Array.isArray(A.sources) ? A.sources : A.sources ? [A.sources] : [])
  .map((s) => (typeof s === 'string' ? s : (s?.focus || s?.id || '')))
  .filter(Boolean);

// =============================================================================
// Schemas — DECISIONS ONLY (control plane). Every finding, citation and comparison lives in files (#8).
// =============================================================================
// The confidence scale, stated ONCE: the schema advertises it and the harness normalizes against it, so
// the two can never drift into accepting different words. Anything outside it is NO signal, not a value.
const CONFIDENCE = ['high', 'medium', 'low', 'none'];

const INVESTIGATE_SCHEMA = {
  type: 'object',
  required: ['wrote_files', 'new_options', 'disqualified_added', 'near_misses', 'rediscovered', 'next_avenue_confidence', 'exhausted', 'no_solution', 'saturated', 'needs_user'],
  properties: {
    wrote_files:        { type: 'boolean', description: 'true if you wrote every file steps 4 to 8 call for this round' },
    new_options:        { type: 'integer', description: 'QUALIFYING options you wrote to options/ THIS round (0 is a legitimate round)' },
    disqualified_added: { type: 'integer', description: 'candidates you appended to the DISQUALIFIED ledger this round' },
    near_misses:        { type: 'integer', description: 'of those, how many you marked NEAR-MISS: (never more than disqualified_added)' },
    rediscovered:       { type: 'integer', description: 'closed candidates you met again this round, not re-appended (step 5)' },
    next_avenue_confidence: { type: 'string', enum: CONFIDENCE, description: 'the confidence on this round\'s r<N> NEXT: line (step 6)' },
    exhausted:          { type: 'boolean', description: 'true if you claim the search space is closed (step 7)' },
    no_solution:        { type: 'boolean', description: 'true if you claim no candidate can meet the criteria (step 7)' },
    saturated:          { type: 'boolean', description: 'leave false unless you claim saturation (step 7)' },
    needs_user:         { type: 'boolean', description: 'true ONLY if a criteria contradiction or a user-only call blocks you before you can claim anything; you wrote a full entry to NEEDS-USER.md and cannot proceed. A no_solution claim resting on a contradiction is not one: leave this false' },
    option_ids:         { type: 'array', items: { type: 'string' }, description: 'the ids of the options you wrote THIS round (file names, not content) — the critic verifies exactly these' },
  },
};

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'upheld', 'verified_ids', 'disqualified', 'near_misses', 'contests_exhaustion', 'contests_saturation', 'agree', 'needs_user', 'determination_defects', 'reopened'],
  properties: {
    wrote_file:          { type: 'boolean', description: 'true if you wrote your round review file' },
    upheld:              { type: 'array', items: { type: 'string' }, description: 'ids of THIS round\'s new options that survive your verification — every criterion met, every citation checked out. verified_ids carries the full upheld set' },
    verified_ids:        { type: 'array', items: { type: 'string' }, description: 'the id of every file in options/ whose first line reads "verdict: upheld" once your own verdict writes are done, earlier rounds and earlier runs included' },
    disqualified:        { type: 'array', items: { type: 'string' }, description: 'ids you knocked out; you appended a ledger line for each, naming the criterion it fails. An id listed here is dropped from the answer set even if an earlier round upheld it' },
    near_misses:         { type: 'integer', description: 'of the lines YOU appended, how many you marked NEAR-MISS: (0 if you appended none)' },
    contests_exhaustion: { type: 'boolean', description: 'true if you contest the exhaustion or no-solution claim with a cited avenue (step 5)' },
    contests_saturation: { type: 'boolean', description: 'true if you contest the saturation claim with a cited avenue (step 5)' },
    agree:               { type: 'boolean', description: 'true if you accept this round\'s termination claim (step 5)' },
    needs_user:          { type: 'boolean', description: 'true ONLY if you found a criteria contradiction only the USER can resolve that this round\'s termination claim does not state; you wrote it to NEEDS-USER.md. A contradiction the claim rests on is judged through agree' },
    determination_defects: { type: 'integer', description: 'defects you found in the determination under step 6 and wrote in your review file. 0 when none, or when no determination was due. They never change agree' },
    reopened:            { type: 'integer', description: 'ledger candidates you flagged for re-opening under step 3, 0 if none' },
  },
};

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['gaps', 'questions', 'unfalsifiable'],
  properties: {
    gaps: {
      type: 'array',
      description: 'the GAPS you found (procedure step 1)',
      items: {
        type: 'object',
        required: ['title'],
        properties: {
          title:      { type: 'string' },
          why:        { type: 'string', description: 'what the search would get wrong without it' },
          suggestion: { type: 'string', description: 'how to fix the criteria file' },
        },
      },
    },
    questions: {
      type: 'array',
      description: 'blocking questions only the USER can answer',
      items: {
        type: 'object',
        required: ['question'],
        properties: {
          question:     { type: 'string' },
          why_blocking: { type: 'string', description: 'why the search is not safe to start without an answer' },
        },
      },
    },
    unfalsifiable: {
      type: 'array',
      description: 'the UNFALSIFIABLE criteria you found (procedure step 2)',
      items: {
        type: 'object',
        required: ['criterion'],
        properties: {
          criterion: { type: 'string' },
          why:       { type: 'string', description: 'what evidence would be needed, and why none can exist as written' },
        },
      },
    },
    notes: { type: 'string' },
  },
};

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `THE QUESTION + CRITERIA: ${CRITERIA_REF}
${REPO ? `CODEBASE (read-only context — fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}${SOURCES.length ? `WHERE TO LOOK (a starting set, NOT a closed list: an avenue you find yourself counts equally, and one you rule out is logged in ${SEARCHED}, never in ${LEDGER}):\n${SOURCES.map((s) => `  - ${s}`).join('\n')}\n` : ''}${TESTBED ? `TESTBED — ground claims EMPIRICALLY where you can: ${TESTBED}\nPrefer MEASURED evidence over reasoning: run the check and cite the exact command + result, so the
other role can re-run it. Treat the testbed as READ-ONLY unless it says otherwise. Leave no artifacts.\n` : ''}EVERY criterion is PASS/FAIL. A candidate that misses ONE is DISQUALIFIED: no weighted total, no
"close enough". Every claim that a criterion is met carries a CITATION: the source plus the exact
passage/locator that supports it. An uncited claim is not evidence.`;

// =============================================================================
// Role prompts
// =============================================================================
const investigatePrompt = (round, reviewPath) => `
You are the INVESTIGATOR (round ${round} of at most ${LAST_ROUND}). Find an answer that ALREADY EXISTS and
meets every criterion. You are SEARCHING, not designing: prefer what is documented, shipped and citable
over anything you could invent.
${ENV}
SEARCH MEMORY — read ALL THREE before you search:
  • ${LEDGER} — every candidate already disqualified, and why. Do NOT re-propose one unless a critique
    re-opens it. Do NOT re-walk an avenue it closes.
  • ${SEARCHED} — every AVENUE already swept, with its terms and yield. Do not re-run a search recorded
    here with the same terms. Pick up from its last \`NEXT:\` line, or say what you are doing differently.
  • ${OPTIONS_DIR}/ — one file per option written so far. A critic records its verdict as a file's FIRST
    line, \`verdict: upheld r<N>\` or \`verdict: disqualified r<N>\`, N the round it judged. Never write
    a verdict line yourself. A file whose verdict line reads \`verdict: disqualified\` and names a round
    before round ${round} is OUT: never link it in ANSWER. A file with no verdict line, or one naming round
    ${round} or a later round, is unverified until a critic judges it. Bring a disqualified option back
    only on a critique's re-open note, by re-proposing it: rewrite its whole file with no verdict line.
${round === 1
    ? `Round 1: none of them may exist yet. Create them as you go.`
    : reviewPath
      ? `${resumedRound(round)
        ? `This search resumes after round ${PRIOR_ROUNDS}. If ${reviewPath} does not exist, that round had
nothing for the critic to check, so change the avenue rather than repeat it. If it exists, READ it`
        : `The critic reviewed the last round. READ ${reviewPath}`} and answer EVERY point it raises. A
disqualified option needs a DIFFERENT candidate, not a re-argued one. A candidate the review re-opens is
the exception: re-propose it. A contested exhaustion claim names
an avenue you did not sweep: sweep it.`
      : `The last round added no option and claimed nothing, so NO critique was written. Change the avenue
rather than repeat the last one.`}

PROCEDURE:
1. Read the criteria VERBATIM and list them NUMBERED. Every step below checks against that numbering.
2. SEARCH the avenues above and any you find yourself. Prefer primary sources (official docs, the source
   itself, release notes, the spec) over summaries.
3. SELF-CHECK each candidate against EVERY criterion BEFORE you write anything. Do not soften a criterion
   to keep a candidate you like.
4. QUALIFIERS: write ${OPTIONS_DIR}/<id>.md per option, <id> a short kebab slug (create the dir if
   needed): a per-criterion table of EVIDENCE and CITATION, what the option BUYS, what it COSTS, and its
   sources. Terse and concrete.
5. REJECTS: APPEND one line each to ${LEDGER}:
   \`<candidate> — FAILS <criterion> — <≤15-word why> — <source>\`
   A candidate that fails EXACTLY ONE criterion is a NEAR MISS: prefix its line \`NEAR-MISS: \` and put the
   shortfall in NUMBERS wherever the criterion has any.
   Append only: never rewrite, reorder or prune it.
   Do NOT re-append a REDISCOVERED candidate (one the ledger already closed that your search turned up
   again). Return their count as rediscovered.
6. AVENUES — APPEND to ${SEARCHED} one line per avenue you actually SWEPT this round:
   \`r${round} SWEPT: <avenue> — <queries/terms used> — <result: X new, Y rediscovered | nothing>\`
   Then EXACTLY ONE line saying where you would look next:
   \`r${round} NEXT: <most promising unswept avenue> — confidence: high|medium|low|none — <why>\`
   \`confidence: none\` means NO unswept avenue remains. That is step 7's exhaustion claim, so write it
   only with the evidence step 7 demands. Return the same value as next_avenue_confidence.
   Append only: never rewrite, reorder or prune it.
7. TERMINATION — claim it only when you can EVIDENCE it. The critic will attack the evidence.
   • exhausted = the search space is closed, evidenced in the COVERAGE section of step 8. "I did not find
     more" is not exhaustion.
   • no_solution = no candidate CAN meet these criteria (usually a criterion pair nothing satisfies), a
     stronger fact than finding none. Say which criterion every candidate died on.${round >= 2
      ? `
   • saturated = DIMINISHING RETURNS. CHECK FOR it every round: before you finish, weigh what THIS round
     genuinely added against the r<N> trajectory in ${SEARCHED}. Claim it when this round added nothing
     genuinely new, OR its yield collapsed to well under half the best round so far AND the best unswept
     avenue is at most \`medium\` confidence. The claim TERMINATES this round: write ${DETERMINATION},
     OPEN it with the words "stopped on saturation — the search is OPEN, not closed", give it the WHERE
     NEXT section, and return saturated=true. It is the WEAKEST claim: another round is not worth its
     cost, never that nothing else is out there. If you can EVIDENCE exhaustion or no_solution instead,
     claim that and leave saturated false: never both.`
      : ''}
8. THE DETERMINATION — write ${DETERMINATION} on a terminating round${round >= LAST_ROUND
      ? `, AND on this one: round ${round} is this run's LAST, so it gets written whatever you conclude`
      : ''}. LINK to each
   ${OPTIONS_DIR}/<id>.md, never restate one. These sections, in this order:
   • ANSWER — one linked line per qualifying option: each option whose file reads \`verdict: upheld\`, plus
     this round's new options. None qualified? Say so, then skip to NEAR MISSES.
   • COMPARISON — the qualifiers tabled over the axes they actually DIFFER on (what each BUYS and COSTS,
     from their files). NOT the criteria: every qualifier passes those, so a criteria table compares
     nothing. Exactly one qualifier: say so and omit the table.
   • WHICH TO PICK WHEN — one line per option: the situation it is the right answer for. UNRANKED, since
     qualification is pass/fail.
   • NEAR MISSES — every \`NEAR-MISS:\` line in the ledger: the ONE criterion it failed, the shortfall in
     numbers, and whether it is worth doing anyway on its own merits. Say plainly that none is a
     qualifier, even if worth doing.
   • COVERAGE — the avenues you swept, what remains untried, and why what remains cannot hold a qualifier.
   • WHERE NEXT — REQUIRED on a STOPPED result (a saturation, a no_solution, or a partial last round).
     One line per UNSWEPT avenue with its own \`confidence: high|medium|low|none\`, then the ONE change to
     the premise or the criteria that would open search space this run could not reach. Omit the section
     only on an evidenced exhaustion.
   For no_solution ALSO: why nothing qualifies, and the SINGLE criterion the user could relax to change
   that. That criterion IS the WHERE NEXT premise change. Append it to ${NEEDS_USER} as well. That entry is
   informational: needs_user stays false, because the critic verifies the no_solution claim itself.${round >= LAST_ROUND
      ? `\n   If you are NOT claiming termination, OPEN the file stating the search is NOT exhaustive and this
   is a PARTIAL result. Say what stopped it (the round budget, or the escalation you are about to write
   to ${NEEDS_USER}), never that nothing more is there.`
      : ''}
If a criteria contradiction, or a call only the user can make, blocks you before you can claim anything:
append a full entry to ${NEEDS_USER} and set needs_user=true.
Do NOT modify any repo, stage, or commit.
Return via the schema, option_ids included.`;

// NON-BLIND on purpose (#3 guards code-regression anchoring, not evidence checking): the critic must see
// the option and the criteria to verify either. Its job is to break them, not to confirm the investigator.
const critiquePrompt = (round, ids, claimKind, det) => `
You are the ACCEPTANCE CRITIC, adversarial and non-blind. Try to BREAK this round's result: an option that
misses a criterion, a citation that does not say what it is cited for, ${claimKind === 'coverage'
    ? 'and above all a claim that the search is finished when an avenue is still open'
    : claimKind === 'saturation'
      ? 'and above all a claim that the search has run dry when a promising avenue is still open'
      : 'a candidate promoted on assertion rather than evidence'}. Uphold an option only when you
genuinely cannot break it.
${ENV}
THE OPTIONS TO JUDGE — read each VERBATIM. First this round's new options:
${ids.length ? ids.map((id) => `  - ${OPTIONS_DIR}/${id}.md`).join('\n') : '  (the investigator named no new option this round)'}
Then every other file in ${OPTIONS_DIR}/ that is UNVERIFIED: its first line is not a verdict line, or its
verdict line names round ${round} or a later round (only an interrupted earlier attempt at this round could
have written it). Leave every other verdict line as it is.
THE VERDICT LINE — make it the FIRST line of each option file you judge, replacing any verdict line there,
exactly \`verdict: upheld r${round}\` or \`verdict: disqualified r${round}\`.
THE LEDGER (read it, then APPEND to it, never rewrite it): ${LEDGER}
THE AVENUE LOG (the investigator's record of the GROUND it swept, the terms it used, and what it says is
left. Read it before you judge any coverage claim. Do not write to it): ${SEARCHED}

CHECK:
1. Each option you judge against EVERY criterion. On a miss, append its line to ${LEDGER}
   (\`<candidate> — FAILS <criterion> — <≤15-word why> — <source>\`), write its disqualified verdict line,
   and list its id in disqualified. Give each option you could not break its upheld verdict line, and list
   this round's new ones in upheld. A line for a candidate that fails EXACTLY ONE criterion is a NEAR MISS:
   prefix it \`NEAR-MISS: \`, give the shortfall in numbers, and count it in near_misses.
2. VERIFY every citation: open the cited source and confirm the passage exists AND supports the claim made
   from it. A citation that does not check out fails the criterion it was offered for, so an option
   standing on one is disqualified, not merely flagged.
3. Check the ledger for a candidate disqualified on a WRONG reading that should be re-opened. Say so in
   your review file (the next investigator reads it). Count them in reopened.
4. NEAR-MISS MARKERS: check every \`NEAR-MISS: \` line this round added. One whose candidate fails a second
   criterion is mismarked: append a corrected line naming the additional criterion. Flag a line that
   should carry the marker and does not.
${claimKind === 'coverage'
    ? `5. ATTACK THE COVERAGE CLAIM, the check that matters most. The investigator says the search is closed.
   Check that first against ${SEARCHED}, its record of the ground swept.
   Name ONE avenue, source, phrasing or adjacent domain it did not sweep that could plausibly hold a
   qualifier, and CITE it: the source plus the exact locator, and which criterion or search-space bound
   that source puts back in play. An UNCITED contest is not a contest. Set contests_exhaustion=true only
   with that citation written into your review file. Set agree=true ONLY when you have genuinely tried
   and cannot: agreeing asserts nothing else is there.`
    : claimKind === 'saturation'
      ? `5. ATTACK THE SATURATION CLAIM. It is NOT that the search is CLOSED. It is that another round is not
   worth its cost, because this one added nothing genuinely new or its yield collapsed against earlier
   rounds. Check that TRAJECTORY in the r<N> SWEPT lines of ${SEARCHED} and the growth of ${LEDGER}. Did the
   yield really collapse, or did this round search BADLY: the same avenue re-run with the same terms, an
   obvious phrasing never tried, last round's r<N> NEXT: avenue never swept?
   Contest it exactly ONE way: name an unswept avenue that is CITED (the source plus the exact locator),
   CONNECTED to a criterion or a search-space bound, and plausibly worth a whole round.
   An UNCITED contest is not a contest. Set contests_saturation=true only with that citation written into
   your review file. Set agree=true to accept the stop: the run reports an OPEN, STOPPED search, never an
   exhaustive one.`
      : `5. No termination was claimed this round: leave agree, contests_exhaustion and contests_saturation
   false.`}
${det
    ? `6. THE DETERMINATION (${DETERMINATION}), the run's product file. Read it for these defects. Its
   ANSWER links an option whose file, after your own verdict writes, does not read \`verdict: upheld\`.
   Its ANSWER omits an option whose file reads \`verdict: upheld\` after your verdict writes. Its
   COMPARISON tables the criteria every qualifier passes instead of the axes they DIFFER on. Its WHICH TO PICK WHEN smuggles in a ranking (the options are unranked). Its NEAR MISSES do
   not match the marked ledger lines, or read as answers. On any STOPPED result (a saturation, a
   no_solution, or a partial last round), its WHERE NEXT is missing or empty. This does NOT change agree.
   Write each defect in your review file and count them in determination_defects.`
    : `6. No determination was DUE this round, so do not judge the run on one. Ignore any ${DETERMINATION}
   on disk: it is not this round's output. Set determination_defects to 0.`}
WRITE ${reviewFile(round)} (create ${STATE_DIR}/ if needed): per option, which criteria hold and which
fail, with the evidence you checked. Then your near-miss corrections. Then your verdict on any termination
claim: the avenue still open WITH its citation, or that the claim holds.${det ? ` Then any defect in ${DETERMINATION}.` : ''}
Do NOT modify any repo, stage, or commit.
If a criteria contradiction only the user can resolve surfaces, append it to ${NEEDS_USER} and set
needs_user=true. The exception is a contradiction this round's termination claim already rests on (a
no_solution): judge that claim through agree, and set needs_user=true only for a contradiction the claim
does not state.
Return via the schema. Its verified_ids lists the id of EVERY file in ${OPTIONS_DIR}/ whose first line reads
\`verdict: upheld\` once your own writes are done, earlier rounds and earlier runs included.`;

const criteriaPrompt = () => `
You are an INDEPENDENT CRITERIA CRITIC (read-only). A search is about to be judged ENTIRELY against these
criteria. Find what would make that judgement impossible or wrong, not what would make the criteria
prettier. An empty result is a GOOD outcome.
${ENV}

PROCEDURE — three failure modes, and only these:
1. GAPS: a constraint the question plainly implies but no criterion states, a missing EVIDENCE STANDARD
   (what would count as proof that a criterion is met), or a search space so unbounded that no exhaustion
   claim over it could ever be evidenced.
2. UNFALSIFIABLE: a criterion no evidence could settle either way as written ("must be maintainable",
   "should be popular"), or one that CONTRADICTS another so nothing could satisfy both.
3. QUESTIONS: only what genuinely BLOCKS the search and only the USER can answer.
Do NOT write any file. Do NOT modify any repo, stage, or commit.
Return via the schema.`;

// =============================================================================
// PHASE: refine — critique the criteria; return the findings to the orchestrator. STOP.
// (Writes nothing — the orchestrator reads the return value and relays to the user. Principle #6.)
// A dead critic THROWS rather than defaulting to a clean verdict: "no gaps" and "no critic" must never
// look the same to the caller, since the whole point of this phase is to catch what is missing.
// =============================================================================
if (PHASE === 'refine') {
  phase('Refine');
  log(`refine: critiquing the criteria${PLAN_PATH ? ` at ${PLAN_PATH}` : ' (inline)'}`);
  const critique = await agent(criteriaPrompt(), roleOpts('criteria', {
    schema: CRITERIA_SCHEMA, phase: 'Refine', label: 'criteria-critic',
  }));
  if (!critique) throw new Error('Criteria critic returned nothing (agent skipped or died) — that is NOT a clean bill of health for the criteria. Re-invoke with the same args (same runId); pass the Workflow tool\'s resumeFromRunId to replay completed agents from cache.');
  const gaps = Array.isArray(critique.gaps) ? critique.gaps : [];
  const questions = Array.isArray(critique.questions) ? critique.questions : [];
  const unfalsifiable = Array.isArray(critique.unfalsifiable) ? critique.unfalsifiable : [];
  log(`refine: ${gaps.length} gap(s), ${questions.length} question(s), ${unfalsifiable.length} unfalsifiable criterion/criteria`);
  return {
    phase: 'refine',
    runId: RUN_ID,
    gaps,
    questions,
    unfalsifiable,
    notes: critique.notes || '',
    nextStep: questions.length
      ? 'Relay the questions to the user (AskUserQuestion), fold the answers + the gap and unfalsifiable fixes directly into the criteria (planPath), then run phase:"run" with this SAME runId and priorRounds: 0.'
      : (gaps.length || unfalsifiable.length)
        ? 'Fold the gap fixes directly into the criteria (planPath) and REPLACE every unfalsifiable criterion with one that evidence can settle, then run phase:"run" with this SAME runId and priorRounds: 0. A criterion nothing can decide never converges.'
        : 'Criteria are sound — run phase:"run" with this SAME runId and priorRounds: 0.',
  };
}

// =============================================================================
// PHASE: run
// =============================================================================
log(`investigate: searching for an answer that meets the criteria → ${OPTIONS_DIR} [maxRounds=${MAX_ROUNDS}${PRIOR_ROUNDS ? `, resuming after r${PRIOR_ROUNDS}` : ''}]`);

let round = PRIOR_ROUNDS;
let haltKind = 'rounds';        // the default terminal state: the loop fell through its round budget
let haltReason = '';
let reviewPath = '';            // set only from a critic's attested write, so it can never name a file no
                                // critic wrote. The return names it as the latest review.
let lastClaimRejected = '';     // the claim kind the critic did not accept on the LAST round ('' = none)
let critRound = 0;              // the round reviewPath's critic ran in: after a critic-less round that
                                // review is already answered, so the next investigator must not get it.
let determinationDefects = null; // the critic's count for the determination it last checked. null when no critic has checked one
let nearMisses = 0;             // NEAR-MISS: ledger lines (failed EXACTLY ONE criterion), surfaced so the
                                // candidates a user could relax a criterion for cannot die in the ledger.
// One entry per investigator round, counts and the confidence enum only (#8). A round with 0 new options
// looks the same opening ground or grinding over closed ground. Only the shape across rounds differs.
const trajectory = [];
// The latest critic's verified_ids. null means unknown: a resumed run's files may hold upheld options
// before any critic of this run has read them, and a critic that returned no list leaves the set unread.
let verifiedIds = PRIOR_ROUNDS === 0 ? [] : null;
const knockedEver = new Set();  // every id any critic has disqualified. Kept for the WHOLE run: an option
                                // that died must not walk back into the answer set on a later critic's say-so.
const idList = (v) => (Array.isArray(v) ? v : []).filter((id) => typeof id === 'string' && id);
const optionCount = () => (verifiedIds === null ? 'an unknown number of' : String(verifiedIds.length));
const setPhrase = () => (verifiedIds === null
  ? '`options` is null: the verified set is unknown'
  : `\`options\` holds the verified set of ${verifiedIds.length} option(s)`);
let stallCritic = '';           // the stalled round's critic verdict, worded once for its log line and nextStep

while (round < LAST_ROUND) {
  // Budget floor: stop CLEANLY between rounds rather than letting a round die mid-search with the ledger
  // half-written. The ledger IS the resume state, so a clean stop costs nothing to continue from.
  if (budget.total && budget.remaining() < MIN_ROUND_BUDGET) {
    haltKind = 'budget';
    haltReason = `Stopped before round ${round + 1}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minRoundBudget). Re-invoke phase:"run" with the same args and priorRounds: ${round} — ${LEDGER} carries the search's memory, so the next round resumes where this one stopped instead of re-walking closed avenues.`;
    log(`⏸ ${haltReason}`);
    break;
  }
  round++;

  // ---- INVESTIGATE ---------------------------------------------------------
  phase('Investigate');
  // A resumed first round is pointed at the last invocation's review, which no critic of this run wrote.
  const lastReview = resumedRound(round) ? reviewFile(PRIOR_ROUNDS) : critRound === round - 1 ? reviewPath : '';
  const inv = await agent(investigatePrompt(round, lastReview), roleOpts('investigate', {
    schema: INVESTIGATE_SCHEMA, phase: 'Investigate', label: `investigate r${round}`,
  }));
  // A dead investigator must NEVER read as "found nothing, swept everything" — that is exactly the shape
  // of an exhausted search, and it would be reported as a proof of absence.
  if (!inv) throw new Error(`Investigator returned nothing in round ${round} (agent skipped or died) — that is NOT an exhausted search. Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  const added = Number(inv.new_options) || 0;
  const invDisq = Number(inv.disqualified_added) || 0;
  const ids = idList(inv.option_ids);
  // Three claims, ONE precedence order. `exhausted` / `no_solution` are facts about the SEARCH SPACE;
  // `saturated` is only a fact about THIS RUN's yield, so it can never outrank them — a search that can be
  // evidenced as closed must not be reported as merely stopped. Both arriving together is a
  // self-contradictory return (the stronger claim makes the weaker one moot): the stronger wins, and the
  // contradiction is logged rather than swallowed, because it is the operator's only sign the investigator
  // did not understand which fact it was asserting.
  const hardClaim = inv.exhausted === true || inv.no_solution === true;
  if (hardClaim && inv.saturated === true) {
    log(`  ⚠ r${round}: investigator claimed BOTH ${inv.no_solution === true ? 'no_solution' : 'exhaustion'} AND saturation — the stronger fact takes precedence; the saturation claim is IGNORED`);
  }
  const claimKind = hardClaim ? 'coverage' : inv.saturated === true ? 'saturation' : '';
  const claim = claimKind !== '';
  const invNear = Math.max(0, Number(inv.near_misses) || 0);
  // The marker is a subset of the rejects by definition, so a count above them is a self-contradictory
  // return. Flagged, not halted (§ the harm does not compound — it misstates one number in a file the
  // operator is about to read, and the ledger itself is still correct).
  if (invNear > invDisq) {
    log(`  ⚠ r${round}: investigator reported ${invNear} near-miss(es) but only ${invDisq} reject(s) — a near miss IS a reject, so one of those numbers is wrong; check ${LEDGER}`);
  }
  const det = claim || round >= LAST_ROUND;
  // The critic and the return would name these files, and on a same-runId re-run a stale file can sit there.
  if (inv.wrote_files !== true && inv.needs_user !== true) {
    haltKind = 'write-unattested';
    haltReason = `The investigator did not confirm writing its files in round ${round}: ${OPTIONS_DIR}/, ${LEDGER}, ${SEARCHED}${det ? ` and ${DETERMINATION}` : ''}.`;
    log(`  ✋ r${round}: investigator did NOT confirm writing its files → halting before the critic (check ${OPTIONS_DIR}/, ${LEDGER}, ${SEARCHED}${det ? `, ${DETERMINATION}` : ''})`);
    break;
  }

  // ---- CRITIQUE (adversarial, non-blind) -----------------------------------
  // Gated: a round that added no option and owes no determination has nothing to check, and a critic
  // spawned over nothing would return a meaningless verdict. It DOES run when the investigator escalated
  // alongside new options — nothing unvetted may reach the user, so the halt waits for the verdict — and
  // whenever a determination is due, since that file IS what reaches the user. A run's first round always
  // runs it, since an interrupted earlier attempt may have left option files no critic judged.
  let crit = null;
  if (added > 0 || det || firstRound(round)) {
    phase('Critique');
    crit = await agent(critiquePrompt(round, ids, claimKind, det), roleOpts('critique', {
      schema: CRITIQUE_SCHEMA, phase: 'Critique', label: `critique r${round}`,
    }));
    if (!crit) throw new Error(`Acceptance critic returned nothing in round ${round} (agent skipped or died) — its options and any termination claim are therefore UNVERIFIED. Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
    // The next investigator, and a contest's cited avenue, live only in that file.
    if (crit.wrote_file !== true) {
      haltKind = 'write-unattested';
      haltReason = `The critic did not confirm writing ${reviewFile(round)} in round ${round}, so its verdict has no review file behind it.`;
      log(`  ✋ r${round}: critic did NOT confirm writing ${reviewFile(round)} → halting before its verdict is applied`);
      break;
    }
    reviewPath = reviewFile(round);
    critRound = round;
    // A missing count is unknown, never zero, so it must not read as a clean determination (#15).
    if (det) determinationDefects = Number.isInteger(crit.determination_defects) && crit.determination_defects >= 0 ? crit.determination_defects : null;
    // The answer set is the critic's verified_ids, read from the option files' verdict lines. Disqualified
    // beats upheld within one verdict: an id in both lists is a critic contradicting itself, and "broken"
    // is the only safe reading.
    const knocked = new Set(idList(crit.disqualified));
    const verified = Array.isArray(crit.verified_ids) ? idList(crit.verified_ids) : null;
    const nextSet = verified === null ? null : [];
    if (verified === null) log(`  ⚠ r${round}: critic returned no verified_ids — the verified set is unknown, so \`options\` is null until a later critic lists it`);
    const bothWays = [...new Set([...idList(crit.upheld), ...(verified ?? [])])].filter((id) => knocked.has(id));
    if (bothWays.length) log(`  ⚠ r${round}: critic listed ${bothWays.join(', ')} as BOTH upheld and disqualified — taken as disqualified`);
    for (const id of (verified ?? [])) {
      if (knocked.has(id)) continue;
      // A dead option stays dead unless THIS round re-proposed it as a fresh options/<id>.md. Re-opening a
      // wrong disqualification is the investigator's channel, never a later critic's say-so.
      if (knockedEver.has(id) && !ids.includes(id)) {
        log(`  ⚠ r${round}: critic upheld "${id}", which an earlier round DISQUALIFIED and this round did not re-propose — IGNORED (it stays out; see ${LEDGER})`);
        continue;
      }
      knockedEver.delete(id);                 // re-proposed and re-verified on its merits — genuinely back
      if (!nextSet.includes(id)) nextSet.push(id);
    }
    // `upheld` covers this round's new options, so one missing from verified_ids is a self-contradiction.
    const unlisted = verified === null ? [] : idList(crit.upheld).filter((id) => !knocked.has(id) && !verified.includes(id));
    if (unlisted.length) log(`  ⚠ r${round}: critic upheld ${unlisted.join(', ')} but left it out of verified_ids — kept out; check its verdict line`);
    for (const id of knocked) {
      knockedEver.add(id);
      if (verifiedIds?.includes(id)) log(`  ⚠ r${round}: "${id}" was upheld in an earlier round and is now DISQUALIFIED — dropped from the answer set`);
    }
    verifiedIds = nextSet;
  }
  // Both writers append to the ledger, so both counts are summed, each under the same contradiction check.
  const critNear = Math.max(0, Number(crit?.near_misses) || 0);
  if (crit && critNear > (Array.isArray(crit.disqualified) ? crit.disqualified.length : 0)) {
    log(`  ⚠ r${round}: critic reported ${critNear} near-miss(es) but disqualified only ${Array.isArray(crit.disqualified) ? crit.disqualified.length : 0} — a near miss IS a disqualification, so one of those numbers is wrong; check ${LEDGER}`);
  }
  nearMisses += invNear + critNear;
  // `crit` is null ONLY when the gate above skipped it — a critic that died threw. So these reads cannot
  // launder a dead agent into a zero.
  const critDisq = Array.isArray(crit?.disqualified) ? crit.disqualified.length : 0;
  const knockedOut = invDisq + critDisq;
  // The ledger's growth is the operator's only signal that the search is LEARNING rather than circling,
  // so it is logged every round — including the quiet ones.
  const roundNear = invNear + critNear;
  // Floored like near_misses, for the same reason: a negative count is not a count, and this one feeds a
  // return array a stop rule reads.
  const rediscovered = Math.max(0, Number(inv.rediscovered) || 0);
  // Anything outside the enum is NO signal rather than a value. A scripted or garbage return must not put
  // an invented word into the operator's round log or into the trajectory — the two places a reader would
  // take it for a measurement.
  const confidence = CONFIDENCE.includes(inv.next_avenue_confidence) ? inv.next_avenue_confidence : '';
  log(`  r${round}: +${added} option(s), ${knockedOut} disqualified${roundNear ? ` (${roundNear} near-miss)` : ''}${rediscovered ? `, ${rediscovered} rediscovered` : ''}${confidence ? `, next: ${confidence}` : ''}${crit ? ` (critic upheld ${Array.isArray(crit.upheld) ? crit.upheld.length : 0})` : ' — no critic this round: nothing new to check'}`);
  trajectory.push({ round, options: added, disqualified: knockedOut, rediscovered, confidence });

  // ---- HALTS + TERMINATION -------------------------------------------------
  if (inv.needs_user === true) {
    haltKind = 'needs-user';
    haltReason = `Investigator escalated a user-only call in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: investigator escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  if (crit?.needs_user === true) {
    haltKind = 'needs-user';
    haltReason = `Critic surfaced a criteria contradiction only the user can resolve in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: critic escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  // BACKSTOP — the investigator produced literally nothing: no option, no ledger line, no claim (checked
  // below, via `det`) and no escalation (checked above). There is nothing for the next round to diverge FROM,
  // so buying one gets the same empty round at full price. Round 1 counts too: nothing at the start just
  // means we exit. Only a run's first round reaches it with a critic. That critic judged files an earlier
  // attempt left, so its disqualifications close old ground, not new, and the round still stalls.
  // The `!det` guard is load-bearing. A claiming round and the FINAL round have each been ORDERED to write
  // a DETERMINATION.md and have had it verified, so each keeps its own terminal state; with maxRounds: 1
  // every quiet run is a final round, and relabelling it 'stalled' would hide the partial determination it
  // just wrote behind a status that says nothing was produced.
  if (!det && added === 0 && invDisq === 0) {
    haltKind = 'stalled';
    stallCritic = crit
      ? `the critic judged the files in ${OPTIONS_DIR}/${critDisq ? `, disqualified ${critDisq} of them (see ${LEDGER})` : ''}, and ${setPhrase()}`
      : '';
    log(`  ⏹ r${round}: the investigator added NOTHING — no option, no ledger line, no claim — so another round buys the same; stopping ${stallCritic ? `after ${stallCritic}` : 'unverified'} (see ${SEARCHED})`);
    break;
  }
  if (claim) {
    // A termination claim ends the run ONLY when the critic accepted it. Contested — or simply not
    // agreed — it buys another round, which is the whole mechanic: a stop has to survive an attack.
    // Each claim carries its OWN contest flag, and only its own is read: a saturation contest names an
    // avenue still worth a round, a coverage contest names one the claim missed, and crossing the two
    // would let either kind be waved through by a verdict that was never about it.
    const contested = claimKind === 'saturation' ? crit?.contests_saturation === true : crit?.contests_exhaustion === true;
    // A re-open flag, or a missing count, means a disqualified candidate may still qualify, so it buys a
    // round in which the next investigator reads the review.
    const reopened = Number.isInteger(crit?.reopened) && crit.reopened >= 0 ? crit.reopened : null;
    if (crit?.agree === true && !contested && reopened === 0) {
      haltKind = claimKind === 'saturation' ? 'saturated' : inv.no_solution === true ? 'no-solution' : 'exhausted';
      log(`  ✓ r${round}: critic AGREES — ${haltKind === 'no-solution' ? 'no candidate can qualify'
        : haltKind === 'saturated' ? 'the search has run dry; STOPPING with it OPEN, not closed (see its WHERE NEXT)'
          : 'the search is closed'} (see ${DETERMINATION})`);
      break;
    }
    const kind = claimKind === 'saturation' ? 'saturation' : 'termination';
    const why = contested ? 'CONTESTED'
      : crit?.agree !== true ? 'not agreed'
        : reopened === null ? 'not accepted (the critic returned no re-open count)'
          : `not accepted (the critic flagged ${reopened} disqualified candidate(s) for re-opening)`;
    if (round < LAST_ROUND) log(`  ↻ r${round}: ${kind} claim ${why} → another investigator round (addresses ${reviewPath})`);
    else {
      lastClaimRejected = claimKind === 'saturation' ? 'saturation' : inv.no_solution === true ? 'no-solution' : 'exhaustion';
      log(`  ✗ r${round}: ${kind} claim ${why} on the LAST round — the search ends unproven (see ${reviewPath})`);
    }
  }
  if (round >= LAST_ROUND) {
    log(`  ⚠ r${round}: round budget spent with the search still OPEN — ${optionCount()} option(s) qualified, nothing proved exhaustive (partial ${DETERMINATION}; see ${LEDGER})`);
    break;                       // haltKind stays 'rounds'
  }
  if (!claim) log(`  ↻ r${round}: search continues → next investigator reads ${critRound === round ? reviewPath : LEDGER}`);
}

// One string per terminal state: collapsing any pair reports a stopped search as a finished one.
const HALT_STATUS = {
  'exhausted':   'exhaustive (search closed, critic agreed)',
  'rounds':      'not exhaustive (round budget spent)',
  'no-solution': 'no qualifying option exists (verified)',
  // Deliberately spells out "the search is open": this is the one terminal a reader is most likely to
  // mistake for a finished search, since a critic agreed to it just as one agrees to exhaustion.
  'saturated':   'stopped on saturation (diminishing returns, critic agreed — the search is open, not closed)',
  'stalled':     'stalled (a round added nothing new and claimed nothing)',
  'budget':      'stopped on token budget (resume where it left off)',
  'needs-user':  'BLOCKED (needs user input)',
  'write-unattested': 'BLOCKED (an agent did not confirm writing its files - check them, then relaunch fresh with the same runId and no resumeFromRunId)',
};
// No silent fallback string: an unmapped haltKind is an engine bug, and reporting it as a plausible
// terminal state is precisely the collapse this table exists to prevent.
const status = HALT_STATUS[haltKind] || `halted (unmapped terminal state "${haltKind}" — engine bug)`;
const halted = haltKind === 'needs-user' || haltKind === 'budget' || haltKind === 'write-unattested';
const concluded = haltKind === 'exhausted' || haltKind === 'no-solution';
// Owed on a terminating round and on the last round: a search that ran out of rounds still owes its
// comparison and near misses. The halts and 'stalled' name none, never a file nothing attested writing.
// `round > PRIOR_ROUNDS` proves an investigator ran, since 'rounds' is haltKind's initial value.
const determined = concluded || haltKind === 'saturated' || (haltKind === 'rounds' && round > PRIOR_ROUNDS);
const determinationNote = determinationDefects > 0
  ? `The critic found ${determinationDefects} defect(s) in the determination. Read them in ${reviewPath} and correct them before you relay it.`
  : determinationDefects === 0
    ? 'The critic found no defect in the determination.'
    : `Read ${reviewPath || 'the latest round review'} alongside it: the critic notes any defect it found in the determination there.`;
log(`investigate: ${status} after ${round} round(s) — ${optionCount()} qualifying option(s), ${nearMisses} near-miss(es)`);

return {
  phase: 'run',
  runId: RUN_ID,
  status,
  halted,
  exhaustive: haltKind === 'exhausted',
  noSolution: haltKind === 'no-solution',
  saturated: haltKind === 'saturated',
  haltReason: halted ? haltReason : '',
  rounds: round,
  stateDir: STATE_DIR,
  options: verifiedIds,
  optionFiles: verifiedIds === null ? null : verifiedIds.map((id) => `${OPTIONS_DIR}/${id}.md`),
  ledgerFile: LEDGER,
  determination: determined ? DETERMINATION : '',
  nearMisses,
  trajectory,
  reviewFile: reviewPath,
  determinationDefects,
  needsUserFile: haltKind === 'needs-user' ? NEEDS_USER : '',
  searchTrail: `${LEDGER} is the full list of what was ruled out and why (lines marked NEAR-MISS: failed exactly one criterion); ${SEARCHED} is the avenue log — which ground each round swept, with the terms used, and the most promising avenue it left unswept; options/<id>.md hold each option the investigator qualified, with its evidence (a critic-disqualified option's file stays on disk, so \`optionFiles\` lists the verified ones); acceptance-review-rN.md in ${STATE_DIR}/ shows each round the critic judged.`,
  nextStep: halted
    ? (haltKind === 'needs-user'
      ? `Run halted — ${haltReason} Read ${NEEDS_USER}, resolve it with the user (usually by editing the criteria), then re-invoke phase:"run" with the same runId and priorRounds: ${round} — the ledger means the search resumes rather than restarts.`
      : haltKind === 'write-unattested'
        ? `Run halted — ${haltReason} Check those files, then relaunch phase:"run" as a FRESH run with the same runId, priorRounds: ${round - 1} and no resumeFromRunId: a resume replays the cached return and halts the same way. No determination is named, since no file behind it was attested.`
        : `Run stopped on budget — ${haltReason}`)
    : haltKind === 'exhausted'
      ? `Present the determination: relay ${DETERMINATION} (the options, the comparison, which to pick when, the near misses, the coverage evidence) and let the user read each options/<id>.md for the per-criterion evidence, plus ${LEDGER} for what was ruled out. The options are UNRANKED by design — present the trade-offs and let the user choose; to rank them you want decide-cycle. ${determinationNote} To build what it names, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.`
      : haltKind === 'saturated'
        ? `The search STOPPED on diminishing returns and the critic agreed the collapse is real — it is OPEN, not closed, so never present it as exhaustive or complete. Relay ${DETERMINATION} and lead with its WHERE NEXT section. ${verifiedIds === null ? `The return's \`options\` is null: the verified set is unknown, so read the verdict line atop each file in ${OPTIONS_DIR}/.` : `The return's \`options\` is the verified set of ${verifiedIds.length} option(s), and each is a valid answer, but nothing was proved to be all of them.`} The determination's ANSWER may still link an option the critic disqualified. ${determinationNote}${nearMisses ? ` Include the ${nearMisses} NEAR MISS(es) — each failed exactly one criterion.` : ''} To continue, pick an avenue WHERE NEXT names and re-invoke phase:"run" with the same runId and priorRounds: ${round} — ${SEARCHED} and ${LEDGER} carry the memory, so the next round starts from swept ground rather than re-walking it — or make the premise/criteria change it proposes. Re-running unchanged buys another round over the same worked-out ground, which is what this stop is telling you.`
        : haltKind === 'stalled'
          ? `Round ${round}'s investigator added NOTHING — no option, no ledger line, no claim — so the run stopped rather than buy another round of the same. ${stallCritic
            ? `In that round ${stallCritic}.`
            : `No critic ran in round ${round}.`} No ${DETERMINATION} was written, so there is no product file to relay. Read the \`r<N> NEXT:\` lines in ${SEARCHED} (the avenues the search itself named as unswept) and ${LEDGER} (what is already closed), and say plainly that the search found nothing new this invocation. Then either re-invoke phase:"run" with the same runId and priorRounds: ${round} to continue from that memory, or change the criteria/premise — an unchanged re-run starts from the same empty round.`
          : haltKind === 'no-solution'
            ? `NOTHING qualifies, and the critic verified that. Relay ${DETERMINATION} + ${LEDGER} and take the criterion it names to the user: relaxing one criterion is the only thing that changes this answer. ${determinationNote}${nearMisses ? ` Lead with the ${nearMisses} NEAR MISS(es) — each failed exactly one criterion, so they are what relaxing a criterion would make available, and some may be worth doing on their own merits even though they do not qualify.` : ''} Do NOT re-run unchanged — the same criteria produce the same dead end.`
            : `The round budget ran out with the search still open — ${optionCount()} option(s) qualified so far but NOTHING was proved exhaustive, so do not present this as a complete answer. ${lastClaimRejected
              ? `${DETERMINATION} asserts the ${lastClaimRejected} claim the critic did NOT accept (see ${reviewPath}): it is NOT labelled partial and may lack WHERE NEXT, so label it a PARTIAL result and add that review's open avenue before relaying it`
              : `${DETERMINATION} was written as a PARTIAL result (it says so at the top)`} — relay it with that caveat, alongside ${LEDGER}${nearMisses ? ` and its ${nearMisses} NEAR MISS(es)` : ''} and the latest ${reviewPath || 'round review'}. Then either re-invoke with the same runId and priorRounds: ${round} to continue from the ledger, or accept the partial result.`,
};
