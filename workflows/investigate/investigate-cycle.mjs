export const meta = {
  name: 'investigate-cycle',
  description: 'Bounded exhaustive search, lean/file-bus design: ONE investigator per round hunts for an EXISTING answer that meets fixed PASS/FAIL criteria — writing each qualifier to options/<id>.md and every reject to an append-only DISQUALIFIED.md ledger it re-reads at the top of every round, so each round diverges from what already failed instead of circling — and an adversarial NON-BLIND critic verifies each new option against every criterion (and every citation against its source) before it counts. The loop ends when the investigator can EVIDENCE that no avenues remain and the critic agrees, not when the first answer works. Running out of rounds, running out of tokens, proving that nothing can qualify, stopping on critic-verified SATURATION (diminishing returns — the search stays OPEN, not closed) and STALLING on a round that added nothing at all are DIFFERENT terminal states and are never folded together. The harness only routes ids, paths + verdicts; every finding lives in files.',
  whenToUse: 'Find an answer that likely ALREADY EXISTS and qualify it against fixed pass/fail criteria — a library, tool, API, config, technique or precedent that must satisfy every constraint, plus the evidence that nothing better was left unsearched. The main agent authors the CRITERIA (the question, the pass/fail criteria, the evidence standard, the search space) in PLAN MODE, approves them with the user, runs MANDATORY phase:"refine" (an independent criteria critic returns gaps + blocking questions + criteria no evidence could settle), folds the answers back into the criteria file, then runs phase:"run" with the same runId. Use decide-cycle instead when no established answer exists and the real work is WEIGHING trade-offs among approaches the AI generates; brainstorm-cycle for creative variations a human picks between; to BUILD what the determination names, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent criteria critic reads the criteria and returns gaps, each quoting the criteria line it rests on or naming the section the criteria lack, blocking questions, and any criterion no evidence could settle either way. Writes nothing.' },
    { title: 'Investigate', detail: 'ONE investigator per round (sequential, which is what makes a single shared ledger safe): reads the criteria verbatim + the whole DISQUALIFIED.md ledger + the last critique, searches, self-checks every candidate against every criterion, writes options/<id>.md per qualifier, appends each reject to the ledger tagged with its round and carrying its source and locator (marking NEAR-MISS: the ones that failed exactly one criterion), flags a ledger line it can contradict with a citation, and writes DETERMINATION.md — the options, a comparison over the axes they DIFFER on, which to pick when, the near misses and the coverage evidence — on a terminating round AND on the last round the budget allows, where it is labelled a partial result.' },
    { title: 'Critique', detail: 'Adversarial non-blind critic — skipped only in a round that adds no option, flags no ledger line, claims no termination, owes no determination and is not this run\'s first round: verifies each new option and every unverified option file against every criterion and each citation against its source, writes its verdict as the first line of each file it judges, disqualifies what fails (appending to the same ledger), checks every ledger line added since the last critique against its source and locator and rules on each FLAG among them, re-checks every NEAR-MISS marker among those lines, attacks any exhaustion / no-solution / saturation claim, and, when a determination was written, corrects its ANSWER, COMPARISON, WHICH TO PICK WHEN and NEAR MISSES to match its verdicts and reports any other defect. Agreement on a claim ends the loop; a contested claim buys another round.' },
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
  throw new Error('args must include at least { runId, root, planPath }; got typeof=' + (typeof args));
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
const ROLE_KEYS = ['criteria', 'investigate', 'critique'];
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'high';
// Copy of develop's roleMap, since an engine cannot import: a test pins the copies equal.
// Static lead clauses: gen-flows labels each throw node from them.
const roleMap = (name, value, legal) => {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid role map: args.${name} must be an object that maps a role key to a value; got ${JSON.stringify(value)}.`);
  }
  const entries = Object.entries(value);
  for (const [role, setting] of entries) {
    if (!ROLE_KEYS.includes(role)) {
      throw new Error(`Unknown role key in a role map: args.${name} names ${JSON.stringify(role)}, and the role keys are ${ROLE_KEYS.join(' | ')}.`);
    }
    if (!legal.has(setting)) {
      throw new Error(`Illegal role value in a role map: args.${name}.${role} is ${JSON.stringify(setting)}, and it must be one of ${[...legal].join(' | ')}.`);
    }
  }
  return Object.fromEntries(entries);
};
const M  = { criteria: 'opus', investigate: 'opus', critique: 'opus', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { criteria: DEFAULT_EFFORT, investigate: DEFAULT_EFFORT, critique: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], effort: EF[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });
log(`investigate: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

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
// single source of truth that makes qualification decidable. It lives in a file (planPath).
// This guard is UNCONDITIONAL — it fires for every phase, refine included, so there is no second
// refine-only "with neither" branch to drift out of sync (or to sit unreachable behind this one).
if (typeof A.planPath !== 'string' || !A.planPath.trim()) {
  throw new Error('args.planPath is required: pass the ABSOLUTE path to the criteria FILE (the pass/fail rubric the search qualifies candidates against). There is no inline `criteria` arg. A rubric written without plan mode goes to plans/<runId>/ under root first.');
}
const PLAN_PATH   = abs(A.planPath);
const CRITERIA_REF = `the criteria at ${PLAN_PATH} (read them verbatim: the fixed pass/fail rubric)`;

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
// Each enum is stated ONCE: the schema advertises it and the harness normalizes against it, so the two
// can never drift into accepting different words. Anything outside it is NO signal, not a value.
const CONFIDENCE = ['high', 'medium', 'low', 'none'];
const CLAIMS = ['none', 'exhausted', 'no_solution', 'saturated'];

const INVESTIGATE_SCHEMA = {
  type: 'object',
  required: ['wrote_files', 'option_ids', 'disqualified_added', 'flagged', 'rediscovered', 'next_avenue_confidence', 'claim', 'needs_user'],
  properties: {
    wrote_files:        { type: 'boolean', description: 'true if you wrote every file steps 4 to 8 call for this round' },
    option_ids:         { type: 'array', items: { type: 'string' }, description: 'the ids of the options you wrote to options/ THIS round, re-proposals included (file names, not content). [] is a legitimate round' },
    disqualified_added: { type: 'integer', description: 'candidates you appended to the DISQUALIFIED ledger this round' },
    flagged:            { type: 'integer', description: 'FLAG lines you appended to the DISQUALIFIED ledger this round (step 5), 0 if none' },
    rediscovered:       { type: 'integer', description: 'closed candidates you met again this round, not re-appended (step 5)' },
    next_avenue_confidence: { type: 'string', enum: CONFIDENCE, description: 'the confidence on this round\'s r<N> NEXT: line (step 6)' },
    claim:              { type: 'string', enum: CLAIMS, description: 'this round\'s termination claim (step 7): none unless you can evidence one' },
    needs_user:         { type: 'boolean', description: 'true ONLY if a criteria contradiction or a user-only call blocks you before you can claim anything; you wrote a full entry to NEEDS-USER.md and cannot proceed. A no_solution claim resting on a contradiction is not one: leave this false' },
  },
};

const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'upheld', 'verified_ids', 'disqualified', 'contests_claim', 'agree', 'needs_user', 'determination_defects', 'reopened'],
  properties: {
    wrote_file:          { type: 'boolean', description: 'true if you wrote your round review file' },
    upheld:              { type: 'array', items: { type: 'string' }, description: 'ids of THIS round\'s new options that survive your verification — every criterion met, every citation checked out. verified_ids carries the full upheld set' },
    verified_ids:        { type: 'array', items: { type: 'string' }, description: 'the id of every file in options/ whose first line reads "verdict: upheld" once your own verdict writes are done, earlier rounds and earlier runs included' },
    disqualified:        { type: 'array', items: { type: 'string' }, description: 'ids you knocked out; you appended a ledger line for each, naming the criterion it fails. An id listed here is dropped from the answer set even if an earlier round upheld it' },
    contests_claim:      { type: 'boolean', description: 'true if you contest THIS round\'s termination claim with a cited avenue (step 5)' },
    agree:               { type: 'boolean', description: 'true if you accept this round\'s termination claim (step 5)' },
    needs_user:          { type: 'boolean', description: 'true ONLY if you found a criteria contradiction only the USER can resolve that this round\'s termination claim does not state; you wrote it to NEEDS-USER.md. A contradiction the claim rests on is judged through agree' },
    determination_defects: { type: 'integer', description: 'defects left in the determination after your step-6 corrections, each written in your review file. 0 when none, or when no determination was due. They never change agree' },
    reopened:            { type: 'integer', description: 'ledger candidates you re-opened under step 3, 0 if none' },
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
        required: ['title', 'evidence'],
        properties: {
          title:      { type: 'string' },
          evidence:   { type: 'string', description: 'the line of the criteria file the gap rests on, quoted verbatim, or "absent: <section>" when the gap is a section the file lacks' },
          why:        { type: 'string', description: 'what the search would get wrong without it' },
          suggestion: { type: 'string', description: 'how to fix the criteria file. The operator checks it against the file first' },
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

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';

// Both ledger writers share one line shape. The round tag lets a critic find the lines no critic has
// checked yet, and the locator is what it checks each one against.
const ledgerLine = (round, writer) => `r${round} ${writer} — <candidate> — FAILS|UNPROVEN <criterion> — <≤15-word why> — <source and locator>`;
const newLines = (round, since) => (since >= round ? `\`r${round} inv\`` : `\`r<K> inv\` for K from ${since} to ${round}`);
const NEAR_MISS_RULE = 'A candidate that fails EXACTLY ONE criterion is a NEAR MISS: write `NEAR-MISS: ` in front of its <candidate>';
// The investigator writes NEAR MISSES and the critic corrects it, so both read one rule. A FLAG line and a
// re-proposal leave a candidate's latest FAILS or UNPROVEN line as the one that decides.
const NEAR_MISSES_SET = 'every candidate whose latest FAILS or UNPROVEN ledger line carries `NEAR-MISS:` and that ANSWER does not link';

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `THE QUESTION + CRITERIA: ${CRITERIA_REF}
${REPO ? `CODEBASE (read-only context — fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}${SOURCES.length ? `WHERE TO LOOK (a starting set, NOT a closed list: an avenue you find yourself counts equally, and one you rule out is logged in ${SEARCHED}, never in ${LEDGER}):\n${SOURCES.map((s) => `  - ${s}`).join('\n')}\n` : ''}${TESTBED ? `TESTBED — ground claims EMPIRICALLY where you can: ${TESTBED}\nPrefer MEASURED evidence over reasoning: run the check and cite the exact command + result, so the
other role can re-run it. Treat the testbed as READ-ONLY unless it says otherwise. Leave no artifacts.
A measured difference smaller than the spread across repeated runs settles nothing: the criterion it bears
on is UNPROVEN.\n` : ''}EVERY criterion is PASS/FAIL. A candidate that misses ONE is DISQUALIFIED: no weighted total, no
"close enough". Every claim that a criterion is met carries a CITATION: the source plus the exact
passage/locator that supports it. An uncited claim is not evidence. A criterion no checked source settles
either way is UNPROVEN, not failed: its ledger line reads \`UNPROVEN\` in place of \`FAILS\`, and its locator
names the sources checked that leave it unsettled and the source that would settle it. For the NEAR-MISS marker, an UNPROVEN criterion counts as a failed one.`;

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
    re-opens it: FLAG a line you can contradict with a citation instead (step 5). Do NOT re-walk an
    avenue it closes.${resumedRound(round)
    ? ` This search resumes after round ${PRIOR_ROUNDS}, and the criteria
    may have changed since: a line whose named failing criterion no longer disqualifies the candidate as
    the criteria read now is OPEN, so re-propose that candidate.`
    : ''}
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
        ? `This search resumes after round ${PRIOR_ROUNDS}. If ${reviewPath} does not exist, that round ran
no critic, and this round's critic checks its ledger lines. Change the avenue rather than repeat it. If it
exists, READ it`
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
4. QUALIFIERS: write ${OPTIONS_DIR}/<id>.md per option, <id> a short kebab slug that no file in
   ${OPTIONS_DIR} uses yet (create the dir if needed). ${REPLACE_NOTE} Replace an existing <id>.md only when re-proposing a
   disqualified option or rewriting an unverified file (no verdict line, or one naming round ${round} or later) for the
   same candidate. Each file holds a per-criterion table of EVIDENCE and CITATION,
   what the option BUYS, what it COSTS, and its sources. Terse and concrete.
5. REJECTS: APPEND one line each to ${LEDGER}:
   \`${ledgerLine(round, 'inv')}\`
   A FAILS line's locator is the exact passage, section, line or command output that shows the failure.
   An UNPROVEN line's locator follows the UNPROVEN rule above. The critic checks the line against it.
   ${NEAR_MISS_RULE} and put the
   shortfall in NUMBERS wherever the criterion has any.
   FLAGS: a line already in the ledger that you can contradict with a citation (a passage showing the
   candidate meets the criterion the line names) gets a FLAG, never a re-proposal${resumedRound(round)
    ? ', unless the resumed-search\n   rule above makes the line OPEN'
    : ''}. APPEND:
   \`r${round} inv — FLAG <candidate> — <criterion> — <why the line is wrong> — <source and locator>\`
   The next critic rules on it, and a flag it upholds re-opens the candidate. Return their count as flagged.
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
7. TERMINATION — claim it only when you can EVIDENCE it, and return it in claim (none when you claim
   nothing). The critic will attack the evidence.
   • exhausted = the search space is closed, evidenced in the COVERAGE section of step 8. "I did not find
     more" is not exhaustion. Return claim=exhausted.
   • no_solution = no candidate CAN meet these criteria (usually a criterion pair nothing satisfies), a
     stronger fact than finding none. Say which criterion every candidate died on. Return
     claim=no_solution.${round >= 2
      ? `
   • saturated = DIMINISHING RETURNS. CHECK FOR it every round: before you finish, weigh what THIS round
     genuinely added against the r<N> trajectory in ${SEARCHED}. Claim it when this round added nothing
     genuinely new, OR its yield collapsed to well under half the best round so far AND the best unswept
     avenue is at most \`medium\` confidence. The claim TERMINATES this round: write ${DETERMINATION},
     OPEN it with the words "stopped on saturation — the search is OPEN, not closed", give it the WHERE
     NEXT section, and return claim=saturated. It is the WEAKEST claim: another round is not worth its
     cost, never that nothing else is out there. If you can EVIDENCE exhaustion or no_solution instead,
     claim that.`
      : ''}
8. THE DETERMINATION — write ${DETERMINATION} on a terminating round${round >= LAST_ROUND
      ? `, AND on this one: round ${round} is this run's LAST, so it gets written whatever you conclude`
      : ''}. ${REPLACE_NOTE} LINK to each
   ${OPTIONS_DIR}/<id>.md, never restate one. These sections, in this order:
   • ANSWER — one linked line per qualifying option: each option whose file reads \`verdict: upheld\`, plus
     this round's new options. None qualified? Say so, then skip to NEAR MISSES.
   • COMPARISON — the qualifiers tabled over the axes they actually DIFFER on (what each BUYS and COSTS,
     from their files). NOT the criteria: every qualifier passes those, so a criteria table compares
     nothing. Exactly one qualifier: say so and omit the table.
   • WHICH TO PICK WHEN — one line per option: the situation it is the right answer for. UNRANKED, since
     qualification is pass/fail.
   • NEAR MISSES — ${NEAR_MISSES_SET}: the ONE criterion it failed, the shortfall in
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
${WROTE_NOTE}
Return via the schema, option_ids included.`;

// NON-BLIND on purpose (#3 guards code-regression anchoring, not evidence checking): the critic must see
// the option and the criteria to verify either. Its job is to break them, not to confirm the investigator.
const critiquePrompt = (round, ids, claimKind, det, since) => `
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
${resumedRound(round)
    ? `Then EVERY other file in ${OPTIONS_DIR}/, whatever verdict line it carries: judge each against the
criteria as they read now, because the criteria may have changed since an earlier run judged it.`
    : `Then every other file in ${OPTIONS_DIR}/ that is UNVERIFIED: its first line is not a verdict line, or its
verdict line names round ${round} or a later round (only an interrupted earlier attempt at this round could
have written it). Leave every other verdict line as it is.`}
THE VERDICT LINE — make it the FIRST line of each option file you judge, replacing any verdict line there,
exactly \`verdict: upheld r${round}\` or \`verdict: disqualified r${round}\`.
THE LEDGER (read it, then APPEND to it, never rewrite it): ${LEDGER}
THE AVENUE LOG (the investigator's record of the GROUND it swept, the terms it used, and what it says is
left. Read it before you judge any coverage claim. Do not write to it): ${SEARCHED}

CHECK:
1. Each option you judge against EVERY criterion. On a miss, append its line to ${LEDGER}
   (\`${ledgerLine(round, 'crit')}\`), write its disqualified verdict line,
   and list its id in disqualified. Give each option you could not break its upheld verdict line, and list
   this round's new ones in upheld. ${NEAR_MISS_RULE} and give the shortfall in numbers.
2. VERIFY every citation: open the cited source and confirm the passage exists AND supports the claim made
   from it. A citation that does not check out leaves the criterion it was offered for UNPROVEN, or FAILS
   it when the cited passage contradicts the claim, so an option standing on one is disqualified, not
   merely flagged.
3. THE NEW LEDGER LINES: ${resumedRound(round)
    ? 'no critic of this run has checked the lines the investigator\n   appended,'
    : 'no critic has checked the lines the investigator appended since the last\n   critique,'} the ones tagged ${newLines(round, since)}. Open each line's source at its locator and confirm
   it supports the FAILS the line states, or, on an UNPROVEN line, that the sources it cites leave the
   criterion unsettled. A line it does not support was read wrong: append a
   corrected \`r${round} crit\` line when you find the passage that does disqualify the candidate, and
   otherwise re-open the candidate. Rule on each FLAG line among them: open its citation, re-open the
   candidate when the citation shows it meets the criterion the flagged line names, and otherwise say in
   your review file why the flag fails.
   Then check the rest of the ledger for a candidate disqualified on a WRONG reading that should be
   re-opened. A re-open cites the passage the original reading got wrong, or, on a resumed search, the
   criterion as it reads now. An uncited re-open is not one. Say so in your review file (the next
   investigator reads it). Count every re-open in reopened.${resumedRound(round)
    ? `
   This search resumes after round ${PRIOR_ROUNDS}, and the criteria may have changed since. So read EVERY
   line of ${LEDGER}, re-open in your review file every line whose named failing criterion no longer
   disqualifies the candidate as the criteria read now, and count each in reopened.`
    : ''}
4. NEAR-MISS MARKERS: check every \`NEAR-MISS: \` line among the lines step 3 checks. One whose candidate
   fails a second criterion is mismarked: append a corrected \`r${round} crit\` line naming the additional
   criterion. Append a corrected line for one of those lines that should carry the marker and does not.
${claimKind === 'coverage'
    ? `5. ATTACK THE COVERAGE CLAIM, the check that matters most. The investigator says the search is closed.
   Check that first against ${SEARCHED}, its record of the ground swept.
   Name ONE avenue, source, phrasing or adjacent domain it did not sweep that could plausibly hold a
   qualifier, and CITE it: the source plus the exact locator, and which criterion or search-space bound
   that source puts back in play. An UNCITED contest is not a contest. Set contests_claim=true only
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
   An UNCITED contest is not a contest. Set contests_claim=true only with that citation written into
   your review file. Set agree=true to accept the stop: the run reports an OPEN, STOPPED search, never an
   exhaustive one.`
      : `5. No termination was claimed this round: leave agree and contests_claim false.`}
${det
    ? `6. THE DETERMINATION (${DETERMINATION}), the run's product file. The investigator wrote it before your
   verdicts, so after your verdict writes and ledger appends, CORRECT these sections in place to match them.
   ANSWER links every option whose file reads \`verdict: upheld\` and no other. COMPARISON and WHICH TO PICK
   WHEN hold a row or line for each ANSWER option and no other, taken from its file. When ANSWER links
   exactly one option, COMPARISON says so and holds no table. When it links none, ANSWER says so and the
   file has no COMPARISON or WHICH TO PICK WHEN. NEAR MISSES holds ${NEAR_MISSES_SET},
   your own lines included, less each candidate you re-opened this round, and none reads as an answer.
   Then read it for these defects, which you report and do not correct. Its COMPARISON tables the
   criteria every qualifier passes instead of the axes they DIFFER on. Its WHICH TO PICK WHEN
   smuggles in a ranking (the options are unranked). On any STOPPED result (a saturation, a no_solution,
   or a partial last round), its WHERE NEXT is missing or empty. A correction the tool rejected was not
   made, so it is a defect too. This does NOT change agree.
   Write each correction and each defect in your review file, and count the defects in
   determination_defects.`
    : `6. No determination was DUE this round, so do not judge the run on one. Ignore any ${DETERMINATION}
   on disk: it is not this round's output. Set determination_defects to 0.`}
WRITE ${reviewFile(round)} (create ${STATE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} Per option, write which criteria hold and which
fail, with the evidence you checked. Then your rulings on the new ledger lines and FLAG lines, and your
near-miss corrections. Then your verdict on any termination claim: the avenue still open WITH its
citation, or that the claim holds.${det ? ` Then each correction you made to ${DETERMINATION} and each defect left in it.` : ''}
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
   claim over it could ever be evidenced. Each gap's evidence quotes, verbatim, the line of the criteria
   file it rests on, or reads "absent: <section>" when the gap is a section the file lacks. The operator
   checks each gap against that line before folding it, so a gap with neither a line nor an absent section
   behind it is not one.
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
  log(`refine: critiquing the criteria at ${PLAN_PATH}`);
  const critique = await agent(criteriaPrompt(), roleOpts('criteria', {
    schema: CRITERIA_SCHEMA, phase: 'Refine', label: 'criteria-critic',
  }));
  if (!critique) throw new Error('Criteria critic returned nothing (agent skipped or died) — that is NOT a clean bill of health for the criteria. Re-invoke with the same args (same runId); pass the Workflow tool\'s resumeFromRunId to replay completed agents from cache.');
  const gaps = Array.isArray(critique.gaps) ? critique.gaps : [];
  const questions = Array.isArray(critique.questions) ? critique.questions : [];
  const unfalsifiable = Array.isArray(critique.unfalsifiable) ? critique.unfalsifiable : [];
  log(`refine: ${gaps.length} gap(s), ${questions.length} question(s), ${unfalsifiable.length} unfalsifiable criterion/criteria`);
  const gapCheck = gaps.length
    ? 'Check each gap against the criteria file before you fold it: confirm its quoted evidence line is there and says what the gap claims, or, for an `absent:` gap, that the section is missing, and treat its suggestion as a hint, never as text to paste. '
    : '';
  return {
    phase: 'refine',
    runId: RUN_ID,
    gaps,
    questions,
    unfalsifiable,
    notes: critique.notes || '',
    failed: [],
    nextStep: questions.length
      ? `Relay the questions to the user (AskUserQuestion). ${gapCheck}Fold the answers${gaps.length ? ' + the confirmed gap fixes' : ''}${unfalsifiable.length ? ' + the unfalsifiable fixes' : ''} into the criteria (planPath)${unfalsifiable.length ? ', REPLACING every unfalsifiable criterion with one that evidence can settle' : ''}, then run phase:"run" with this SAME runId and priorRounds: 0.${unfalsifiable.length ? ' A criterion nothing can decide never converges.' : ''}`
      : (gaps.length || unfalsifiable.length)
        ? `${gaps.length
          ? `${gapCheck}Fold the confirmed gap fixes into the criteria (planPath)${unfalsifiable.length ? ' and REPLACE every unfalsifiable criterion with one that evidence can settle' : ''}`
          : 'REPLACE every unfalsifiable criterion in the criteria (planPath) with one that evidence can settle'}, then run phase:"run" with this SAME runId and priorRounds: 0.${unfalsifiable.length ? ' A criterion nothing can decide never converges.' : ''}`
        : 'Criteria are sound — run phase:"run" with this SAME runId and priorRounds: 0.',
  };
}

// =============================================================================
// PHASE: run
// =============================================================================
log(`investigate: searching for an answer that meets the criteria → ${OPTIONS_DIR} [maxRounds=${MAX_ROUNDS}${PRIOR_ROUNDS ? `, resuming after r${PRIOR_ROUNDS}` : ''}]`);

let round = PRIOR_ROUNDS;
let haltKind = 'rounds';        // the default terminal state: the loop fell through its round budget
let escalatedBy = '';           // 'investigator' when it escalated: its round may have answered no review yet
let haltReason = '';
let reviewPath = '';            // set only from a critic's attested write, so it can never name a file no
                                // critic wrote. The return names it as the latest review.
let lastClaimRejected = '';     // the claim kind the critic did not accept on the LAST round ('' = none)
let critRound = 0;              // the round reviewPath's critic ran in: after a critic-less round that
                                // review is already answered, so the next investigator must not get it.
let determinationDefects = null; // the critic's count for the determination it last checked. null when no critic has checked one
// One entry per investigator round, counts and the confidence enum only (#8). A round with 0 new options
// looks the same opening ground or grinding over closed ground. Only the shape across rounds differs.
const trajectory = [];
// The latest critic's verified_ids. null means unknown: a resumed run's files may hold upheld options
// before any critic of this run has read them, and a critic that returned no list leaves the set unread.
let verifiedIds = PRIOR_ROUNDS === 0 ? [] : null;
// The latest applied list, plus ids upheld since by critics that returned none, so each omission is named once.
let lastKnownUpheld = [];
const knockedEver = new Set();  // every id any critic has disqualified. Kept for the WHOLE run: an option
                                // that died must not walk back into the answer set on a later critic's say-so.
const idList = (v) => (Array.isArray(v) ? v : []).filter((id) => typeof id === 'string' && id);
// Floored: a negative count is not a count, and these feed the stall guard and the trajectory.
const toCount = (v) => Math.max(0, Number(v) || 0);
const optionCount = () => (verifiedIds === null ? 'an unknown number of' : String(verifiedIds.length));
const setPhrase = () => (verifiedIds === null
  ? '`options` is null: the verified set is unknown'
  : `\`options\` holds the verified set of ${verifiedIds.length} option(s)`);
let stallCritic = '';           // the stalled round's critic verdict, worded once for its log line and nextStep
let stallUnchecked = '';        // the ledger tags of the critic-less rounds before a stall, which no critic checked

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
  const ids = [...new Set(idList(inv.option_ids))];
  const added = ids.length;
  const invDisq = toCount(inv.disqualified_added);
  const invFlags = toCount(inv.flagged);
  const invClaim = CLAIMS.includes(inv.claim) ? inv.claim : 'none';
  const claimKind = invClaim === 'saturated' ? 'saturation' : invClaim === 'none' ? '' : 'coverage';
  const claim = claimKind !== '';
  const det = claim || round >= LAST_ROUND;
  // The critic and the return would name these files, and on a same-runId re-run a stale file can sit there.
  if (inv.wrote_files !== true && inv.needs_user !== true) {
    haltKind = 'write-unattested';
    haltReason = `The investigator did not confirm writing its files in round ${round}: ${OPTIONS_DIR}/, ${LEDGER}, ${SEARCHED}${det ? ` and ${DETERMINATION}` : ''}.`;
    log(`  ✋ r${round}: investigator did NOT confirm writing its files → halting before the critic (check ${OPTIONS_DIR}/, ${LEDGER}, ${SEARCHED}${det ? `, ${DETERMINATION}` : ''})`);
    break;
  }

  // ---- CRITIQUE (adversarial, non-blind) -----------------------------------
  // Gated: a round that added no option or FLAG and owes no determination has nothing to check now, since
  // its ledger lines wait for the next critic's range, and a stall before that critic names them unchecked.
  // A FLAG cannot wait: a stall would leave it unruled, and only a ruling re-opens its candidate. A critic
  // spawned over nothing would return a meaningless verdict. It DOES run when the investigator escalated
  // alongside new options — nothing unvetted may reach the user, so the halt waits for the verdict — and
  // whenever a determination is due, since that file IS what reaches the user. A run's first round always
  // runs it, since an interrupted earlier attempt may have left option files no critic judged.
  let crit = null;
  if (added > 0 || invFlags > 0 || det || firstRound(round)) {
    phase('Critique');
    // critRound is 0 until a critic of this run attests, so a run's first critic checks every tagged line.
    crit = await agent(critiquePrompt(round, ids, claimKind, det, critRound + 1), roleOpts('critique', {
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
    // A dead option stays dead unless THIS round re-proposed it as a fresh options/<id>.md and this critic
    // upheld it. Re-opening a wrong disqualification is the investigator's channel, never a later critic's say-so.
    for (const id of ids) {
      if (!knocked.has(id) && (idList(crit.upheld).includes(id) || verified?.includes(id))) knockedEver.delete(id);
    }
    for (const id of (verified ?? [])) {
      if (knocked.has(id)) continue;
      if (knockedEver.has(id)) {
        log(`  ⚠ r${round}: critic upheld "${id}", which an earlier round DISQUALIFIED and this round did not re-propose — IGNORED (it stays out; see ${LEDGER})`);
        continue;
      }
      if (!nextSet.includes(id)) nextSet.push(id);
    }
    // An id this critic upheld, or an earlier critic listed or upheld, still reads `verdict: upheld` unless this
    // critic disqualified it. Missing from verified_ids, it is a listing slip or an unreported verdict, so it stays out.
    const unlisted = verified === null ? []
      : [...new Set([...idList(crit.upheld), ...lastKnownUpheld])].filter((id) => !knocked.has(id) && !verified.includes(id));
    if (unlisted.length) log(`  ⚠ r${round}: critic left ${unlisted.join(', ')} out of verified_ids without disqualifying it — kept out of options; check its verdict line`);
    for (const id of knocked) {
      knockedEver.add(id);
      if (lastKnownUpheld.includes(id)) log(`  ⚠ r${round}: "${id}" was upheld in an earlier round and is now DISQUALIFIED — dropped from the answer set`);
    }
    verifiedIds = nextSet;
    lastKnownUpheld = nextSet ?? [...new Set([...lastKnownUpheld, ...idList(crit.upheld)])].filter((id) => !knockedEver.has(id));
  }
  // `crit` is null ONLY when the gate above skipped it — a critic that died threw. So these reads cannot
  // launder a dead agent into a zero.
  const critDisq = Array.isArray(crit?.disqualified) ? crit.disqualified.length : 0;
  const knockedOut = invDisq + critDisq;
  const rediscovered = toCount(inv.rediscovered);
  // Anything outside the enum is NO signal rather than a value. A scripted or garbage return must not put
  // an invented word into the operator's round log or into the trajectory — the two places a reader would
  // take it for a measurement.
  const confidence = CONFIDENCE.includes(inv.next_avenue_confidence) ? inv.next_avenue_confidence : '';
  // The ledger's growth is the operator's only signal that the search is LEARNING rather than circling,
  // so it is logged every round — including the quiet ones.
  log(`  r${round}: +${added} option(s), ${knockedOut} disqualified${invFlags ? `, ${invFlags} flagged` : ''}${rediscovered ? `, ${rediscovered} rediscovered` : ''}${confidence ? `, next: ${confidence}` : ''}${crit ? ` (critic upheld ${Array.isArray(crit.upheld) ? crit.upheld.length : 0})` : ` — no critic this round: ${invDisq ? 'its ledger lines wait for the next critic' : 'nothing new to check'}`}`);
  trajectory.push({ round, options: added, disqualified: knockedOut, rediscovered, confidence });

  // ---- HALTS + TERMINATION -------------------------------------------------
  if (inv.needs_user === true) {
    haltKind = 'needs-user';
    escalatedBy = 'investigator';
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
  // BACKSTOP — the investigator produced literally nothing: no option, no ledger line (a FLAG is one), no
  // claim (checked below, via `det`) and no escalation (checked above). There is nothing for the next round
  // to diverge FROM, so buying one gets the same empty round at full price. Round 1 counts too: nothing at
  // the start just means we exit. Only a run's first round reaches it with a critic. That critic judged files
  // an earlier attempt left, so its disqualifications close old ground, not new, and the round still stalls.
  // The `!det` guard is load-bearing. A claiming round and the FINAL round have each been ORDERED to write
  // a DETERMINATION.md and have had it verified, so each keeps its own terminal state; with maxRounds: 1
  // every quiet run is a final round, and relabelling it 'stalled' would hide the partial determination it
  // just wrote behind a status that says nothing was produced.
  if (!det && added === 0 && invDisq === 0 && invFlags === 0) {
    haltKind = 'stalled';
    stallCritic = crit
      ? `the critic judged the files in ${OPTIONS_DIR}/${critDisq ? `, disqualified ${critDisq} of them (see ${LEDGER})` : ''}, and ${setPhrase()}`
      : '';
    stallUnchecked = critRound < round - 1 ? newLines(round - 1, critRound + 1) : '';
    log(`  ⏹ r${round}: the investigator added NOTHING — no option, no ledger line, no claim — so another round buys the same; stopping ${stallCritic ? `after ${stallCritic}` : 'unverified'} (see ${SEARCHED})${stallUnchecked ? `. No critic checked the ledger lines tagged ${stallUnchecked}` : ''}`);
    break;
  }
  if (claim) {
    // A termination claim ends the run ONLY when the critic accepted it. Contested — or simply not
    // agreed — it buys another round, which is the whole mechanic: a stop has to survive an attack.
    const contested = crit?.contests_claim === true;
    // A re-open, or a missing count, means a disqualified candidate may still qualify, so it buys a
    // round in which the next investigator reads the review.
    const reopened = Number.isInteger(crit?.reopened) && crit.reopened >= 0 ? crit.reopened : null;
    if (crit?.agree === true && !contested && reopened === 0) {
      haltKind = invClaim === 'saturated' ? 'saturated' : invClaim === 'no_solution' ? 'no-solution' : 'exhausted';
      log(`  ✓ r${round}: critic AGREES — ${haltKind === 'no-solution' ? 'no candidate can qualify'
        : haltKind === 'saturated' ? 'the search has run dry; STOPPING with it OPEN, not closed (see its WHERE NEXT)'
          : 'the search is closed'} (see ${DETERMINATION})`);
      break;
    }
    const kind = claimKind === 'saturation' ? 'saturation' : 'termination';
    const why = contested ? 'CONTESTED'
      : crit?.agree !== true ? 'not agreed'
        : reopened === null ? 'not accepted (the critic returned no re-open count)'
          : `not accepted (the critic re-opened ${reopened} disqualified candidate(s))`;
    if (round < LAST_ROUND) log(`  ↻ r${round}: ${kind} claim ${why} → another investigator round (addresses ${reviewPath})`);
    else {
      lastClaimRejected = invClaim === 'saturated' ? 'saturation' : invClaim === 'no_solution' ? 'no-solution' : 'exhaustion';
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
  'budget':      'stopped on token budget (rounds remain, and the ledgers carry the search)',
  'needs-user':  'BLOCKED (needs user input)',
  'write-unattested': 'BLOCKED (an agent did not confirm writing its files)',
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
    : `The critic gave no defect count: read ${reviewPath || 'the latest round review'} and correct any defect it notes in the determination before you relay it.`;
// Round 1 was handed no review and its critic always runs, so resuming after it loses nothing and
// gives the relaunch a resumed round, which re-judges under edited criteria.
const rerunEscalated = escalatedBy === 'investigator' && round > 1;
log(`investigate: ${status} after ${round} round(s) — ${optionCount()} qualifying option(s)`);

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
  trajectory,
  reviewFile: reviewPath,
  determinationDefects,
  needsUserFile: haltKind === 'needs-user' ? NEEDS_USER : '',
  failed: [], // every agent runs solo, and one that returns nothing throws instead
  searchTrail: `${LEDGER} is the full list of what was ruled out and why (lines marked NEAR-MISS: failed exactly one criterion); ${SEARCHED} is the avenue log — which ground each round swept, with the terms used, and the most promising avenue it left unswept; options/<id>.md hold each option the investigator qualified, with its evidence (a critic-disqualified option's file stays on disk, so \`optionFiles\` lists the verified ones); acceptance-review-rN.md in ${STATE_DIR}/ shows each round the critic judged.`,
  nextStep: halted
    ? (haltKind === 'needs-user'
      ? `Run halted — ${haltReason} Read ${NEEDS_USER}, resolve it with the user (usually by editing the criteria), then re-invoke phase:"run" with the same runId and priorRounds: ${rerunEscalated ? round - 1 : round} — the ledger means the search resumes rather than restarts.${rerunEscalated ? ` Round ${round} re-runs from its start, so its investigator re-reads any review it was handed.` : ''}`
      : haltKind === 'write-unattested'
        ? `Run halted — ${haltReason} Check those files, then relaunch phase:"run" as a FRESH run with the same runId, priorRounds: ${round - 1} and no resumeFromRunId: a resume replays the cached return and halts the same way. No determination is named, since no file behind it was attested.`
        : `Run stopped on budget — ${haltReason}`)
    : haltKind === 'exhausted'
      ? `The search is CLOSED: the critic agreed it is exhaustive. Present the determination: relay ${DETERMINATION} (the options, the comparison, which to pick when, the near misses, the coverage evidence) and let the user read each options/<id>.md for the per-criterion evidence, plus ${LEDGER} for what was ruled out. The return's ${setPhrase()}. The options are UNRANKED by design — present the trade-offs and let the user choose; to rank them, run decide-cycle over this option set, not a re-run here. ${determinationNote} To build what it names, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.`
      : haltKind === 'saturated'
        ? `The search STOPPED on diminishing returns and the critic agreed the collapse is real — it is OPEN, not closed, so never present it as exhaustive or complete. Relay ${DETERMINATION} and lead with its WHERE NEXT section. ${verifiedIds === null ? `The return's \`options\` is null: the verified set is unknown, so read the verdict line atop each file in ${OPTIONS_DIR}/.` : `The return's \`options\` is the verified set of ${verifiedIds.length} option(s), and each is a valid answer, but nothing was proved to be all of them.`} ${determinationNote} Include the determination's NEAR MISSES section when it lists any — each failed exactly one criterion. Offer ${LEDGER} for what was ruled out and why. To continue, pick an avenue WHERE NEXT names and re-invoke phase:"run" with the same runId and priorRounds: ${round} — ${SEARCHED} and ${LEDGER} carry the memory, so the next round starts from swept ground rather than re-walking it — or make the premise/criteria change it proposes. Re-running unchanged buys another round over the same worked-out ground, which is what this stop is telling you.`
        : haltKind === 'stalled'
          ? `Round ${round}'s investigator added NOTHING — no option, no ledger line, no claim — so the run stopped rather than buy another round of the same. ${stallCritic
            ? `In that round ${stallCritic}.`
            : `No critic ran in round ${round}, and the return's ${setPhrase()}.`} No ${DETERMINATION} was written, so there is no product file to relay. Read the \`r<N> NEXT:\` lines in ${SEARCHED} (the avenues the search itself named as unswept) and ${LEDGER} (what is already closed${stallUnchecked ? `, apart from the lines tagged ${stallUnchecked}, which no critic checked and a re-invoke's first critic checks` : ''}), and say plainly that the search found nothing new this invocation. Then either re-invoke phase:"run" with the same runId and priorRounds: ${round} to continue from that memory, or change the criteria/premise — an unchanged re-run starts from the same empty round.`
          : haltKind === 'no-solution'
            ? `NOTHING qualifies, and the critic verified that: this is a real answer, not a failure. Relay ${DETERMINATION} + ${LEDGER} and take the criterion it names to the user: relaxing one criterion is the only thing that changes this answer. ${determinationNote} Lead with the determination's NEAR MISSES section when it lists any — each failed exactly one criterion, so they are what relaxing a criterion would make available, and some may be worth doing on their own merits even though they do not qualify. Do NOT re-run unchanged — the same criteria produce the same dead end.`
            : `The round budget ran out with the search still open — ${optionCount()} option(s) qualified so far but NOTHING was proved exhaustive, so do not present this as a complete answer. ${lastClaimRejected
              ? `${DETERMINATION} asserts the ${lastClaimRejected} claim the critic did NOT accept (see ${reviewPath}): it is NOT labelled partial and may lack WHERE NEXT, so label it a PARTIAL result and add that review's open avenue before relaying it`
              : `${DETERMINATION} was written as a PARTIAL result (it says so at the top)`} — relay it with that caveat and its NEAR MISSES section, alongside ${LEDGER} and the latest ${reviewPath || 'round review'}. ${determinationNote} Then either re-invoke with the same runId and priorRounds: ${round} to continue from the ledger, or accept the partial result.`,
};
