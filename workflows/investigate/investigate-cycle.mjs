export const meta = {
  name: 'investigate-cycle',
  description: 'Bounded exhaustive search, lean/file-bus design: ONE investigator per round hunts for an EXISTING answer that meets fixed PASS/FAIL criteria — writing each qualifier to options/<id>.md and every reject to an append-only DISQUALIFIED.md ledger it re-reads at the top of every round, so each round diverges from what already failed instead of circling — and an adversarial NON-BLIND critic verifies each new option against every criterion (and every citation against its source) before it counts. The loop ends when the investigator can EVIDENCE that no avenues remain and the critic agrees, not when the first answer works. Running out of rounds, running out of tokens, and proving that nothing can qualify are three DIFFERENT terminal states and are never folded together. The harness only routes ids, paths + verdicts; every finding lives in files.',
  whenToUse: 'Find an answer that likely ALREADY EXISTS and qualify it against fixed pass/fail criteria — a library, tool, API, config, technique or precedent that must satisfy every constraint, plus the evidence that nothing better was left unsearched. The main agent authors the CRITERIA (the question, the pass/fail criteria, the evidence standard, the search space) in PLAN MODE, approves them with the user, runs MANDATORY phase:"refine" (an independent criteria critic returns gaps + blocking questions + criteria no evidence could settle), folds the answers back into the criteria file, then runs phase:"run" with the same runId. Use decide-cycle instead when no established answer exists and the real work is WEIGHING trade-offs among approaches the AI generates; brainstorm-cycle for creative variations a human picks between; feature-cycle to BUILD what the determination names.',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent criteria critic reads the criteria and returns gaps, blocking questions, and any criterion no evidence could settle either way. Writes nothing.' },
    { title: 'Investigate', detail: 'ONE investigator per round (sequential, which is what makes a single shared ledger safe): reads the criteria verbatim + the whole DISQUALIFIED.md ledger + the last critique, searches, self-checks every candidate against every criterion, writes options/<id>.md per qualifier, appends each reject to the ledger (marking NEAR-MISS: the ones that failed exactly one criterion), and writes DETERMINATION.md — the options, a comparison over the axes they DIFFER on, which to pick when, the near misses and the coverage evidence — on a terminating round AND on the last round the budget allows, where it is labelled a partial result.' },
    { title: 'Critique', detail: 'Adversarial non-blind critic — skipped only in a round that adds no option, claims no termination and owes no determination: verifies each new option against every criterion and each citation against its source, disqualifies what fails (appending to the same ledger), re-checks every NEAR-MISS marker, attacks any exhaustion / no-solution claim, and checks the determination when one was written. Agreement on a claim ends the loop; a contested claim buys another round.' },
  ],
};

// =============================================================================
// Config — everything investigation-specific arrives via args so the engine stays general.
// Investigate is a CONVERGENCE workflow of the SEARCH shape: it finds an answer that already exists and
// qualifies it against FIXED pass/fail criteria. It does not weigh trade-offs among options it invents
// (that is decide-cycle, which converges on reviewer agreement about an argument). What converges here
// is COVERAGE — the claim that nothing qualifying was left unsearched — which is why the loop ends on
// evidenced exhaustion rather than on the first answer that works.
// The DISQUALIFIED.md ledger is the mechanism: every round's investigator reads why each earlier
// candidate died, so it diverges from what is already closed. ONE investigator per round, strictly
// sequential (investigator, then critic), which is the only reason a single append-only file shared by
// two writers is safe here.
// It produces a determination, NOT code: nothing is staged or committed. The review loop honors the
// SPIRIT of WORKFLOW-PRINCIPLES.md #5 but is NON-BLIND by design — a critic that cannot see the option
// or the criteria cannot verify either. The main agent authors the criteria with the user BEFOREHAND
// (#4); the engine spawns no setup/loader agent.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, criteria|planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const PHASE       = A.phase ?? 'run';                       // 'refine' (critique the criteria, stop) | 'run' (search)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL read-only context
const CONTEXT     = A.context ?? '';                        // short extra framing (domain facts the agents won't know)
const TESTBED     = A.testbed ?? '';                        // OPTIONAL: how agents may empirically test a candidate
// A non-numeric bound must THROW, never coerce. `Math.max(1, 'three')` is NaN, `round < NaN` is false on
// the first test, and the loop then never runs — handing back a zero-agent run dressed as an ordinary
// round-budget exit, which is the most dangerous shape a bad arg can take here: a search that never
// happened, reported as one that ran out of rounds. Same reasoning as the `target.repo` guard in the
// build engines — a documented default is not a licence to accept garbage.
// Nothing is COERCED: `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite, so a
// coercing check waves through exactly the garbage that silently disables a floor. The upper bound is not
// decoration either — a fat-fingered `maxRounds: 100000` otherwise spawns agents until something dies.
// The message leads with a STATIC clause because tools/gen-flows.mjs labels a throw node with the first
// clause of its static prefix; starting with `args.${name}` rendered the node as "throw: args.".
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round run and reports it as an ordinary round-budget exit.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 5, 50);    // investigator ⇄ critic rounds before "not exhaustive"
// Token floor to START another round. A round that begins with too little budget dies mid-search and
// leaves the ledger half-written; stopping cleanly between rounds keeps the memory consistent and makes
// the resume free (mirrors feature-cycle's minPlanBudget).
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
const OPTIONS_DIR = `${STATE_DIR}/options`;                 // one file per QUALIFYING option
const LEDGER      = `${STATE_DIR}/DISQUALIFIED.md`;         // append-only search memory (both roles write it)
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
  ? `the criteria at ${PLAN_PATH} (read them verbatim — they are the fixed pass/fail rubric)`
  : `the criteria below:\n-----\n${CRITERIA}\n-----`;

// Sources — an OPTIONAL starting set of avenues (strings, or { id, focus }). Deliberately not a fan-out
// key: one investigator per round sweeps them all, because the ledger only stays consistent with a
// single writer at a time.
const SOURCES = (Array.isArray(A.sources) ? A.sources : A.sources ? [A.sources] : [])
  .map((s) => (typeof s === 'string' ? s : (s?.focus || s?.id || '')))
  .filter(Boolean);

// =============================================================================
// Schemas — DECISIONS ONLY (control plane). Every finding, citation and comparison lives in files (#8).
// =============================================================================
const INVESTIGATE_SCHEMA = {
  type: 'object',
  required: ['wrote_files', 'new_options', 'disqualified_added', 'near_misses', 'exhausted', 'no_solution', 'needs_user'],
  properties: {
    wrote_files:        { type: 'boolean', description: 'true if you wrote everything this round claims: an options/<id>.md per qualifier, a ledger line per reject, and DETERMINATION.md if you are terminating OR this is the last round' },
    new_options:        { type: 'integer', description: 'QUALIFYING options you wrote to options/ THIS round (0 is a legitimate round — the search continues)' },
    disqualified_added: { type: 'integer', description: 'candidates you appended to the DISQUALIFIED ledger this round' },
    near_misses:        { type: 'integer', description: 'of those, how many you marked NEAR-MISS: — failed EXACTLY ONE criterion. A subset of disqualified_added, never larger than it' },
    exhausted:          { type: 'boolean', description: 'true ONLY if you can EVIDENCE the search space is closed: which avenues you swept, what remains untried and why it cannot hold a qualifier. A bare claim will be contested' },
    no_solution:        { type: 'boolean', description: 'true ONLY if you can evidence that NO candidate can meet the criteria — a different fact from "I found none yet"' },
    needs_user:         { type: 'boolean', description: 'true ONLY if a criteria contradiction or a user-only call blocks you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    option_ids:         { type: 'array', items: { type: 'string' }, description: 'the ids of the options you wrote THIS round (file names, not content) — the critic verifies exactly these' },
  },
};

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'upheld', 'disqualified', 'near_misses', 'contests_exhaustion', 'agree', 'needs_user'],
  properties: {
    wrote_file:          { type: 'boolean', description: 'true if you wrote your round review file' },
    upheld:              { type: 'array', items: { type: 'string' }, description: 'ids of THIS round\'s new options that survive your verification — every criterion met, every citation checked out' },
    disqualified:        { type: 'array', items: { type: 'string' }, description: 'ids you knocked out; you appended a ledger line for each, naming the criterion it fails. An id listed here is dropped from the answer set even if an earlier round upheld it' },
    near_misses:         { type: 'integer', description: 'of the lines YOU appended, how many you marked NEAR-MISS: — failed EXACTLY ONE criterion. Your appends count the same as the investigator\'s; 0 if you appended none' },
    contests_exhaustion: { type: 'boolean', description: 'true if the investigator claimed exhaustion / no-solution and the coverage evidence does not hold — name the avenue it missed in your review file' },
    agree:               { type: 'boolean', description: 'true ONLY alongside a termination claim you accept: the coverage evidence holds and the search is genuinely closed' },
    needs_user:          { type: 'boolean', description: 'true ONLY if you found a criteria contradiction only the USER can resolve; you wrote it to NEEDS-USER.md' },
  },
};

const CRITERIA_SCHEMA = {
  type: 'object',
  required: ['gaps', 'questions', 'unfalsifiable'],
  properties: {
    gaps: {
      type: 'array',
      description: 'material misses in the criteria — a constraint the question implies but no criterion states, a missing evidence standard, an unbounded search space',
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
      description: 'criteria NO evidence could settle either way, or that contradict another criterion — the ones that would make every candidate arguable forever',
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
${REPO ? `CODEBASE (read-only context — fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}${SOURCES.length ? `WHERE TO LOOK (a starting set, NOT a closed list — an avenue you find yourself counts just as much, and one you rule out belongs in the ledger):\n${SOURCES.map((s) => `  - ${s}`).join('\n')}\n` : ''}${TESTBED ? `TESTBED — ground claims EMPIRICALLY where you can: ${TESTBED}\nPrefer MEASURED evidence over reasoning: run the check and cite the exact command + result (#14) — a measurement
beats an argument, and it lets the other role re-run it. Treat the testbed strictly READ-ONLY unless it
explicitly says otherwise; leave no artifacts behind.\n` : ''}EVERY criterion is PASS/FAIL. A candidate that misses ONE is DISQUALIFIED however strong it is elsewhere:
there is no weighted total here and no "close enough". Every claim that a criterion is met carries a
CITATION — the source plus the exact passage/locator that supports it (#14); an uncited claim is not
evidence, it is a hope.`;

// =============================================================================
// Role prompts
// =============================================================================
const investigatePrompt = (round, reviewPath) => `
You are the INVESTIGATOR (round ${round} of at most ${MAX_ROUNDS}). Find an answer that ALREADY EXISTS and
meets every criterion. You are SEARCHING, not designing: what is documented, shipped and citable beats
anything you could invent here.
${ENV}
SEARCH MEMORY — read BOTH before you look anywhere:
  • ${LEDGER} — every candidate already disqualified, and why. Do NOT re-propose any of them and do not
    re-walk an avenue it already closes. This file is the entire reason round ${round} is not round 1 again.
  • ${OPTIONS_DIR}/ — the options that already qualified, one file each.
${round === 1
    ? `This is round 1 — both may not exist yet; create them as you go.`
    : reviewPath
      ? `The critic reviewed the last round — READ ${reviewPath} and answer EVERY point it raises. A
disqualified option needs a DIFFERENT candidate, not a re-argued one; a contested exhaustion claim names
an avenue you did not sweep, so sweep it.`
      : `The last round added no option and claimed nothing, so NO critique was written. You are still
searching: change the avenue rather than repeating the last one.`}

PROCEDURE:
1. Read the criteria VERBATIM and list them NUMBERED. That numbering is what every step below checks against.
2. SEARCH. Follow the avenues above and any you find yourself; go to primary sources (official docs,
   the source itself, release notes, the spec) over summaries about them.
3. SELF-CHECK each candidate against EVERY criterion BEFORE you write anything. One miss disqualifies it —
   do not soften a criterion to keep a candidate you like.
4. QUALIFIERS: write ${OPTIONS_DIR}/<id>.md, one file per option (<id> = a short kebab slug; create the
   dir if needed). In it: a per-criterion table with the EVIDENCE and its CITATION for each, what the
   option BUYS, what it COSTS, and its sources. Terse and concrete.
5. REJECTS: APPEND one terse line each to ${LEDGER} —
   \`<candidate> — FAILS <criterion> — <≤15-word why> — <source>\`
   A candidate that fails EXACTLY ONE criterion is a NEAR MISS: prefix its line \`NEAR-MISS: \` and put the
   shortfall in NUMBERS wherever the criterion has any. These are what a user relaxes a criterion for, so
   burying them among the outright misses costs real answers. The marker is a FACT, not sympathy: two
   failed criteria is not a near miss, and the critic re-checks every one you mark.
   Append only: never rewrite, reorder or prune it. It is the search's memory, the critic appends after
   you, and a rejected candidate that vanishes from it will be re-proposed next round.
6. TERMINATION — claim it only when you can EVIDENCE it, because the critic will attack the evidence:
   • exhausted = the search space is closed. State which avenues you swept, what remains untried, and why
     what remains cannot hold a qualifier. "I did not find more" is not exhaustion.
   • no_solution = no candidate CAN meet these criteria (usually a criterion pair nothing satisfies).
     That is a different, stronger fact than finding none — say which criterion every candidate died on.
7. THE DETERMINATION — write ${DETERMINATION} on a terminating round${round >= MAX_ROUNDS
      ? `, AND on this one: round ${round} is this run's LAST, so it gets written whatever you conclude`
      : ''}. LINK to each
   ${OPTIONS_DIR}/<id>.md; never restate one (#11). These sections, in this order:
   • ANSWER — the qualifying options, one linked line each. None qualified? Say so, then skip to NEAR MISSES.
   • COMPARISON — the qualifiers tabled over the axes on which they actually DIFFER: what each BUYS and
     COSTS, already in their files. NOT the criteria — every qualifier passes all of those, so a criteria
     table compares nothing. Exactly one qualifier: say so and omit the table.
   • WHICH TO PICK WHEN — one line per option: the situation it is the right answer for. These are
     UNRANKED and stay that way; qualification is pass/fail, so nothing here outranks anything.
   • NEAR MISSES — every \`NEAR-MISS:\` line in the ledger: the ONE criterion it failed, the shortfall in
     numbers, and whether it is worth doing anyway on its own merits. Doing one does NOT make it a
     qualifier — say so plainly, so nothing here can be mistaken for an answer.
   • COVERAGE — the avenues you swept, what remains untried, and why what remains cannot hold a qualifier.
   For no_solution ALSO: why nothing qualifies, and the SINGLE criterion the user could relax to change
   that (append that one to ${NEEDS_USER}).${round >= MAX_ROUNDS
      ? `\n   If you are NOT claiming termination, OPEN the file stating the search is NOT exhaustive and this
   is a PARTIAL result. Say what actually stopped it — the round budget, or the escalation you are about to
   write to ${NEEDS_USER} — and never that nothing more is there, which is the one thing you did not show.`
      : ''}
If a criteria contradiction, or a call only the user can make, blocks you: append a full entry to
${NEEDS_USER} and set needs_user=true (the run HALTS — any options you wrote this round are still
verified by the critic first, so nothing unchecked reaches the user).
Do NOT modify any repo, stage, or commit.
Return wrote_files + new_options + disqualified_added + near_misses + exhausted + no_solution + needs_user
+ option_ids via the schema (the findings themselves are the files).`;

// NON-BLIND on purpose (#3 guards code-regression anchoring, not evidence checking): the critic must see
// the option and the criteria to verify either. It re-checks THIS round's options fresh — its job is to
// break them, not to confirm the investigator's reasoning.
const critiquePrompt = (round, ids, claim, det) => `
You are the ACCEPTANCE CRITIC — adversarial, non-blind. Try to BREAK this round's result: an option that
misses a criterion, a citation that does not say what it is cited for, ${claim
    ? 'and above all a claim that the search is finished when an avenue is still open'
    : 'a candidate promoted on assertion rather than evidence'}. Upholding an option is only warranted
when you genuinely cannot break it.
${ENV}
THIS ROUND'S NEW OPTIONS — read each VERBATIM:
${ids.length ? ids.map((id) => `  - ${OPTIONS_DIR}/${id}.md`).join('\n') : `  (the investigator named no ids — read every file in ${OPTIONS_DIR}/ and verify any that no earlier review already cleared)`}
THE LEDGER (the search's memory — read it, then APPEND to it, never rewrite it): ${LEDGER}

CHECK:
1. Each new option against EVERY criterion, one by one. A single miss DISQUALIFIES it: append its line to
   ${LEDGER} (\`<candidate> — FAILS <criterion> — <≤15-word why> — <source>\`) and list its id in
   disqualified. Only ids you could not break go in upheld. YOUR appends follow the same rule as the
   investigator's: one that fails EXACTLY ONE criterion is a NEAR MISS — prefix it \`NEAR-MISS: \`, give the
   shortfall in numbers, and count it in near_misses. An option you personally knock out on a single
   criterion is the most interesting near miss in the run, since it got far enough to look like an answer.
2. VERIFY every citation (#14): open the cited source and confirm the passage exists AND actually supports
   the claim made from it. A citation that does not check out fails the criterion it was offered for —
   an option standing on one is disqualified, not merely flagged.
3. Check the ledger for a candidate that was disqualified on a WRONG reading and should be re-opened; say
   so in your review file (the next investigator reads it).
4. NEAR-MISS MARKERS — every \`NEAR-MISS: \` line this round added asserts the candidate failed EXACTLY ONE
   criterion. Check each: one that fails a second criterion is mismarked, and the determination's near-miss
   section inherits the error. Append a corrected line naming the additional criterion. A line that should
   carry the marker and does not is the same defect inverted — flag it. Both go in your review file.
${claim
    ? `5. ATTACK THE COVERAGE CLAIM — this is the one that matters most. The investigator says the search is
   closed. Name ONE avenue, source, phrasing or adjacent domain it did not sweep and that could plausibly
   hold a qualifier; if you can, set contests_exhaustion=true (it buys another round). Set agree=true ONLY
   when you have genuinely tried and cannot: agreeing here is what turns "I stopped looking" into
   "nothing else is there", and it is the one verdict this workflow exists to make trustworthy.`
    : `5. No termination was claimed this round, so agree / contests_exhaustion do not apply — leave both false.`}
${det
    ? `6. THE DETERMINATION (${DETERMINATION}) — the run's product file, so read it. Three ways it goes wrong:
   its COMPARISON tables the criteria every qualifier passes instead of the axes they actually DIFFER on
   (which compares nothing); its WHICH TO PICK WHEN smuggles in a ranking, when qualification is pass/fail
   and the options are unranked; its NEAR MISSES do not match the marked ledger lines, or read as answers
   rather than as things that failed a criterion. Name any of these in your review file. This does NOT
   change agree — a malformed determination is not an open search — but the operator reads your file.`
    : `6. No determination was DUE this round (no termination claim, and rounds remain) so none is expected of
   the investigator — do not judge the run on one. An earlier round that claimed termination and was
   contested may have left a stale ${DETERMINATION} on disk; ignore it, it is not this round's output.`}
WRITE ${reviewFile(round)} (create ${STATE_DIR}/ if needed): per option, which criteria hold and which
fail with the evidence you checked; your near-miss corrections; then your verdict on the coverage claim
(if any) naming the specific avenue you say is still open — or that it holds${det ? `; then any defect in ${DETERMINATION}` : ''}.
Do NOT modify any repo, stage, or commit.
If a criteria contradiction only the user can resolve surfaces, append it to ${NEEDS_USER} and set
needs_user=true.
Return upheld + disqualified + contests_exhaustion + agree + needs_user + wrote_file via the schema.`;

const criteriaPrompt = () => `
You are an INDEPENDENT CRITERIA CRITIC (read-only). The orchestrating agent authored these criteria in
plan mode; the search is about to be judged ENTIRELY against them. Find what would make that judgement
impossible or wrong — not what would make the criteria prettier. An empty result is a GOOD outcome.
${ENV}

PROCEDURE — three distinct failure modes, and only these:
1. GAPS: a constraint the question plainly implies but no criterion states, a missing EVIDENCE STANDARD
   (what would count as proof that a criterion is met), or a search space so unbounded that no exhaustion
   claim over it could ever be evidenced.
2. UNFALSIFIABLE: a criterion no evidence could settle either way as written ("must be maintainable",
   "should be popular"), or one that CONTRADICTS another so nothing could satisfy both. Say what evidence
   would be needed and why none can exist as written. This is your distinctive job: a criterion nothing
   can decide keeps every candidate arguable forever and the loop never converges.
3. QUESTIONS: only what genuinely BLOCKS the search and only the USER can answer.
Do NOT write any file. Do NOT modify any repo, stage, or commit. The orchestrating agent folds your
findings back into the criteria itself. Return gaps + questions + unfalsifiable via the schema.`;

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
      ? 'Relay the questions to the user (AskUserQuestion), fold the answers + the gap and unfalsifiable fixes directly into the criteria (planPath), then run phase:"run" with this SAME runId.'
      : (gaps.length || unfalsifiable.length)
        ? 'Fold the gap fixes directly into the criteria (planPath) and REPLACE every unfalsifiable criterion with one that evidence can settle, then run phase:"run" with this SAME runId. A criterion nothing can decide never converges.'
        : 'Criteria are sound — run phase:"run" with this SAME runId.',
  };
}

// =============================================================================
// PHASE: run — [investigate → (critique, when there is something to check)] × maxRounds.
// The loop STARTS and ENDS with the investigator: the critic only ever judges what a round produced.
// Its terminal states are kept strictly distinct (see HALT_STATUS): "ran out of rounds", "ran out of
// tokens" and "nothing can qualify" are three different facts, and folding any pair of them together
// would let fatigue masquerade as a proof — which is the exact failure this workflow exists to avoid.
// haltKind is set at EVERY terminal site and mapped once; nothing sniffs prose (tests/CLAUDE.md §3).
// =============================================================================
log(`investigate: searching for an answer that meets the criteria → ${OPTIONS_DIR} [maxRounds=${MAX_ROUNDS}]`);

let round = 0;
let haltKind = 'rounds';        // the default terminal state: the loop fell through its round budget
let haltReason = '';
let reviewPath = '';            // the ONE review-path variable: set the moment a critic call returns, so
                                // it can never name a file no critic wrote. Feeds the next investigator
                                // prompt AND the return.
let nearMisses = 0;             // ledger lines marked NEAR-MISS: — failed EXACTLY ONE criterion. The
                                // actionable residue of a search that qualifies nothing, and the thing a
                                // user relaxes a criterion for; surfaced so it cannot die in the ledger.
const upheldIds = [];           // critic-UPHELD option ids only — the return never surfaces an unvetted one
const knockedEver = new Set();  // every id any critic has disqualified. Kept for the WHOLE run: an option
                                // that died must not walk back into the answer set on a later critic's say-so.

while (round < MAX_ROUNDS) {
  // Budget floor: stop CLEANLY between rounds rather than letting a round die mid-search with the ledger
  // half-written. The ledger IS the resume state, so a clean stop costs nothing to continue from.
  if (budget.total && budget.remaining() < MIN_ROUND_BUDGET) {
    haltKind = 'budget';
    haltReason = `Stopped before round ${round + 1}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minRoundBudget). Re-invoke phase:"run" with the same runId and the same args — ${LEDGER} carries the search's memory, so the next round resumes where this one stopped instead of re-walking closed avenues.`;
    log(`⏸ ${haltReason}`);
    break;
  }
  round++;

  // ---- INVESTIGATE ---------------------------------------------------------
  phase('Investigate');
  const inv = await agent(investigatePrompt(round, reviewPath), roleOpts('investigate', {
    schema: INVESTIGATE_SCHEMA, phase: 'Investigate', label: `investigate r${round}`,
  }));
  // A dead investigator must NEVER read as "found nothing, swept everything" — that is exactly the shape
  // of an exhausted search, and it would be reported as a proof of absence.
  if (!inv) throw new Error(`Investigator returned nothing in round ${round} (agent skipped or died) — that is NOT an exhausted search. Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  if (inv.wrote_files !== true) log(`  ⚠ r${round}: investigator did NOT confirm writing its files — check ${OPTIONS_DIR}/ and ${LEDGER} before relaying`);
  const added = Number(inv.new_options) || 0;
  const ids = (Array.isArray(inv.option_ids) ? inv.option_ids : []).filter((id) => typeof id === 'string' && id);
  const claim = inv.exhausted === true || inv.no_solution === true;
  const invNear = Math.max(0, Number(inv.near_misses) || 0);
  // The marker is a subset of the rejects by definition, so a count above them is a self-contradictory
  // return. Flagged, not halted (§ the harm does not compound — it misstates one number in a file the
  // operator is about to read, and the ledger itself is still correct).
  if (invNear > (Number(inv.disqualified_added) || 0)) {
    log(`  ⚠ r${round}: investigator reported ${invNear} near-miss(es) but only ${Number(inv.disqualified_added) || 0} reject(s) — a near miss IS a reject, so one of those numbers is wrong; check ${LEDGER}`);
  }
  // A determination is due on a terminating round AND on the last round the budget allows — a search that
  // merely ran out of rounds still owes the user its comparison and its near misses, and the investigator
  // that just ran is the only agent left to write them. `claim` is deliberately folded in here rather than
  // repeated in the gate below: one definition of "a determination exists", not two that can drift.
  const det = claim || round >= MAX_ROUNDS;

  // ---- CRITIQUE (adversarial, non-blind) -----------------------------------
  // Gated: a round that added no option and owes no determination has nothing to check, and a critic
  // spawned over nothing would return a meaningless verdict. It DOES run when the investigator escalated
  // alongside new options — nothing unvetted may reach the user, so the halt waits for the verdict — and
  // whenever a determination is due, since that file IS what reaches the user.
  let crit = null;
  if (added > 0 || det) {
    phase('Critique');
    crit = await agent(critiquePrompt(round, ids, claim, det), roleOpts('critique', {
      schema: CRITIQUE_SCHEMA, phase: 'Critique', label: `critique r${round}`,
    }));
    if (!crit) throw new Error(`Acceptance critic returned nothing in round ${round} (agent skipped or died) — its options and any termination claim are therefore UNVERIFIED. Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
    if (crit.wrote_file !== true) log(`  ⚠ r${round}: critic did NOT confirm writing ${reviewFile(round)} — check it before relaying`);
    reviewPath = reviewFile(round);
    // Disqualification must be able to REMOVE, not just withhold. A later critic can knock out an option
    // an earlier round upheld — it is told to verify anything no earlier review cleared, and a quiet last
    // round now routes a full re-verification pass through here — so an append-only answer set would keep
    // surfacing an option the critic has since broken. Disqualified beats upheld within one verdict too:
    // an id in both lists is a critic contradicting itself, and "broken" is the only safe reading.
    const knocked = new Set((Array.isArray(crit.disqualified) ? crit.disqualified : []).filter((id) => typeof id === 'string' && id));
    const bothWays = (Array.isArray(crit.upheld) ? crit.upheld : []).filter((id) => knocked.has(id));
    if (bothWays.length) log(`  ⚠ r${round}: critic listed ${bothWays.join(', ')} as BOTH upheld and disqualified — taken as disqualified`);
    for (const id of (Array.isArray(crit.upheld) ? crit.upheld : [])) {
      if (typeof id !== 'string' || !id || knocked.has(id)) continue;
      // A dead option stays dead unless THIS round re-proposed it as a fresh options/<id>.md. Re-opening a
      // wrong disqualification is the investigator's channel (the critic flags it in the review file, the
      // next investigator re-proposes and it gets re-verified) — never a later critic's `upheld` list.
      // Without this the answer set contradicts the ledger in the user's own hand: the last round always
      // spawns a critic now, that critic is told to verify anything no earlier review cleared, and it has
      // no memory of the round that knocked this id out.
      if (knockedEver.has(id) && !ids.includes(id)) {
        log(`  ⚠ r${round}: critic upheld "${id}", which an earlier round DISQUALIFIED and this round did not re-propose — IGNORED (it stays out; see ${LEDGER})`);
        continue;
      }
      knockedEver.delete(id);                 // re-proposed and re-verified on its merits — genuinely back
      if (!upheldIds.includes(id)) upheldIds.push(id);
    }
    for (const id of knocked) {
      knockedEver.add(id);
      const at = upheldIds.indexOf(id);
      if (at !== -1) {
        upheldIds.splice(at, 1);
        log(`  ⚠ r${round}: "${id}" was upheld in an earlier round and is now DISQUALIFIED — dropped from the answer set`);
      }
    }
  }
  // Both writers append to the ledger, so both writers' near misses count. Summing only the investigator's
  // would silently drop the ones the critic found — which are the most interesting, since those candidates
  // got far enough to look like answers. The critic's count gets the SAME contradiction check as the
  // investigator's: it appends one line per id it disqualified, so more near misses than disqualifications
  // is the identical nonsense, and this is the number the operator is told to lead with on a dead end.
  const critNear = Math.max(0, Number(crit?.near_misses) || 0);
  if (crit && critNear > (Array.isArray(crit.disqualified) ? crit.disqualified.length : 0)) {
    log(`  ⚠ r${round}: critic reported ${critNear} near-miss(es) but disqualified only ${Array.isArray(crit.disqualified) ? crit.disqualified.length : 0} — a near miss IS a disqualification, so one of those numbers is wrong; check ${LEDGER}`);
  }
  nearMisses += invNear + critNear;
  // `crit` is null ONLY when the gate above skipped it — a critic that died threw. So these reads cannot
  // launder a dead agent into a zero.
  const knockedOut = (Number(inv.disqualified_added) || 0) + (Array.isArray(crit?.disqualified) ? crit.disqualified.length : 0);
  // The ledger's growth is the operator's only signal that the search is LEARNING rather than circling,
  // so it is logged every round — including the quiet ones.
  const roundNear = invNear + critNear;
  log(`  r${round}: +${added} option(s), ${knockedOut} disqualified${roundNear ? ` (${roundNear} near-miss)` : ''}${crit ? ` (critic upheld ${Array.isArray(crit.upheld) ? crit.upheld.length : 0})` : ' — no critic this round: nothing new to check'}`);

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
  if (claim) {
    // A termination claim ends the run ONLY when the critic accepted it. Contested — or simply not
    // agreed — it buys another round, which is the whole mechanic: exhaustion has to survive an attack.
    if (crit?.agree === true && crit?.contests_exhaustion !== true) {
      haltKind = inv.no_solution === true ? 'no-solution' : 'exhausted';
      log(`  ✓ r${round}: critic AGREES — ${haltKind === 'no-solution' ? 'no candidate can qualify' : 'the search is closed'} (see ${DETERMINATION})`);
      break;
    }
    // Only when a next round actually exists: on the last round this used to promise "another
    // investigator round" one line above the round-budget warning saying there is none.
    if (round < MAX_ROUNDS) log(`  ↻ r${round}: termination claim ${crit?.contests_exhaustion === true ? 'CONTESTED' : 'not agreed'} → another investigator round (addresses ${reviewPath})`);
    else log(`  ✗ r${round}: termination claim ${crit?.contests_exhaustion === true ? 'CONTESTED' : 'not agreed'} on the LAST round — the search ends unproven (see ${reviewPath})`);
  }
  if (round >= MAX_ROUNDS) {
    log(`  ⚠ r${round}: round budget spent with the search still OPEN — ${upheldIds.length} option(s) qualified, nothing proved exhaustive (partial ${DETERMINATION}; see ${LEDGER})`);
    break;                       // haltKind stays 'rounds'
  }
  if (!claim) log(`  ↻ r${round}: search continues → next investigator reads ${reviewPath || LEDGER}`);
}

// Each terminal state gets its OWN string. "Ran out of rounds", "ran out of tokens" and "nothing can
// qualify" are three different facts; collapsing any pair of them is how a stopped search gets reported
// as a finished one.
const HALT_STATUS = {
  'exhausted':   'exhaustive (search closed, critic agreed)',
  'rounds':      'not exhaustive (round budget spent)',
  'no-solution': 'no qualifying option exists (verified)',
  'budget':      'stopped on token budget (resume where it left off)',
  'needs-user':  'BLOCKED (needs user input)',
};
// No silent fallback string: an unmapped haltKind is an engine bug, and reporting it as a plausible
// terminal state is precisely the collapse this table exists to prevent.
const status = HALT_STATUS[haltKind] || `halted (unmapped terminal state "${haltKind}" — engine bug)`;
const halted = haltKind === 'needs-user' || haltKind === 'budget';
const concluded = haltKind === 'exhausted' || haltKind === 'no-solution';
// The determination is due on a terminating round AND on the last round the budget allowed, so 'rounds'
// names it too — a search that merely ran out of rounds still owes its comparison and its near misses.
// The other two halts deliberately name nothing: 'budget' stops BEFORE any agent runs that round, and
// 'needs-user' means the investigator escalated instead of concluding. Naming a file nobody wrote is the
// defect this stays narrow to avoid — hence `round > 0`, which is the PROOF an investigator actually ran
// and got the write-it instruction. 'rounds' is the initial value of haltKind, so without that guard any
// future path that exits before the loop body would inherit it and name a file nothing wrote.
const determined = concluded || (haltKind === 'rounds' && round > 0);
log(`investigate: ${status} after ${round} round(s) — ${upheldIds.length} qualifying option(s), ${nearMisses} near-miss(es)`);

return {
  phase: 'run',
  runId: RUN_ID,
  status,
  halted,
  exhaustive: haltKind === 'exhausted',
  noSolution: haltKind === 'no-solution',
  haltReason: halted ? haltReason : '',
  rounds: round,
  stateDir: STATE_DIR,
  // Critic-upheld ids ONLY — never a listing of options/. An option the critic knocked out (or never
  // saw) reaching the caller as an answer is the one outcome this loop exists to prevent.
  options: upheldIds,
  optionFiles: upheldIds.map((id) => `${OPTIONS_DIR}/${id}.md`),
  ledgerFile: LEDGER,
  // Due on a terminating round AND on the last round the budget allowed — named only where an
  // investigator actually ran and was told to write it (see `determined`).
  determination: determined ? DETERMINATION : '',
  // Candidates that failed EXACTLY ONE criterion. On a no-solution or round-budget run this is often the
  // only actionable thing the search produced, so it is surfaced rather than left to die in the ledger.
  nearMisses,
  reviewFile: reviewPath,
  needsUserFile: haltKind === 'needs-user' ? NEEDS_USER : '',
  searchTrail: `${LEDGER} is the full list of what was ruled out and why (lines marked NEAR-MISS: failed exactly one criterion); options/<id>.md hold the qualifiers with their evidence; acceptance-review-rN.md in ${STATE_DIR}/ shows each round the critic judged.`,
  nextStep: halted
    ? (haltKind === 'needs-user'
      ? `Run halted — ${haltReason} Read ${NEEDS_USER}, resolve it with the user (usually by editing the criteria), then re-invoke phase:"run" with the same runId — the ledger means the search resumes rather than restarts.`
      : `Run stopped on budget — ${haltReason}`)
    : haltKind === 'exhausted'
      ? `Present the determination: relay ${DETERMINATION} (the options, the comparison, which to pick when, the near misses, the coverage evidence) and let the user read each options/<id>.md for the per-criterion evidence, plus ${LEDGER} for what was ruled out. The options are UNRANKED by design — present the trade-offs and let the user choose; to rank them you want decide-cycle. Read ${reviewPath || 'the latest round review'} alongside it: the critic notes any defect it found in the determination there. To build what it names, hand it to feature-cycle.`
      : haltKind === 'no-solution'
        ? `NOTHING qualifies, and the critic verified that. Relay ${DETERMINATION} + ${LEDGER} and take the criterion it names to the user: relaxing one criterion is the only thing that changes this answer.${nearMisses ? ` Lead with the ${nearMisses} NEAR MISS(es) — each failed exactly one criterion, so they are what relaxing a criterion would make available, and some may be worth doing on their own merits even though they do not qualify.` : ''} Do NOT re-run unchanged — the same criteria produce the same dead end.`
        : `The round budget ran out with the search still open — ${upheldIds.length} option(s) qualified so far but NOTHING was proved exhaustive, so do not present this as a complete answer. ${DETERMINATION} was written as a PARTIAL result (it says so at the top) — relay it with that caveat, alongside ${LEDGER}${nearMisses ? ` and its ${nearMisses} NEAR MISS(es)` : ''} and the latest ${reviewPath || 'round review'}. Then either re-invoke with the same runId (and a higher maxRounds) to continue from the ledger, or accept the partial result.`,
};
