export const meta = {
  name: 'refine-cycle',
  description: 'Converging plan review, file-bus design: a read-only CRITIC judges every todo block of ONE plan file against the REAL repo under a fixed DEFECT BAR (only what would build wrong or fail counts - improvements, alternatives and style are excluded unconditionally), grades each gap against a severity FLOOR, and writes its findings verbatim to plan-critique-<round>.md; a minimal-fold EDITOR then folds each gap into the plan file with the smallest edit that closes it and changes NOTHING a gap does not name, declining to DISMISSED-PLAN.md and re-validating the file through the plan-block tool. The loop ends on ONE clean round. The harness routes only counts, paths and an explicit halt kind.',
  whenToUse: 'Converge a plan file BEFORE develop-cycle builds from it: the plan is authored and user-approved, and you want its gaps closed until a critic finds none. It is built to converge: a refine loop without its defect bar, floor, dismissal ledger and minimal-fold editor, run five times on one plan, keeps adding code and detail and never stops. Questions (a dependency-ordering error or a too-big block whose fix splits, merges, adds or reorders blocks, or a gap in an already-done block) END the run needs-answers for the operator to restructure, because the editor has no legal edit for any of them. Nothing here builds, stages or commits.',
  phases: [
    { title: 'Critique', detail: 'A read-only critic reads the plan file verbatim, greps the target repo, and judges every todo block against the defect bar and the severity floor. Writes plan-critique-<round>.md (gaps with file:line evidence, a below-floor FYI section, questions) and returns counts plus a wrote_file attestation, nothing else.' },
    { title: 'Fold', detail: 'Runs only when the round returned at-or-above-floor gaps and no questions. The editor folds each gap into the plan file with the smallest edit that closes it, changes nothing a gap does not name, declines to DISMISSED-PLAN.md, and re-runs the plan-block tool to prove the file still parses.' },
  ],
};

// =============================================================================
// Config - everything plan-specific arrives via args so the engine stays general.
// Refine is a CONVERGENCE workflow over a PLAN FILE: it produces an edited plan, not code - nothing is
// built, staged or committed, and there are no gates args. It is the non-blind review-loop family's third
// member (decide-cycle and investigate-cycle are the siblings): the critic MUST see the plan and the repo
// to judge them, so #3's blindness does not apply here.
// What makes THIS loop converge is four things together: the
// DEFECT BAR (only what would build wrong counts), the severity FLOOR (below-floor findings are recorded,
// not folded), the DISMISSAL ledger (a declined gap stays declined), and the minimal-fold EDITOR (it may
// change only what a gap names). Remove any one and the plan grows every round instead of settling.
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
  throw new Error('args must include at least { runId, root, planPath, target:{repo} }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 - no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally the workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// The plan file is the whole subject of this loop - the critic reads it and the editor rewrites it - so
// there is no inline plan and no default. An omitted path would spawn an opus critic against nothing and
// return a plausible clean round for a plan it never saw.
if (typeof A.planPath !== 'string' || !A.planPath.trim()) {
  throw new Error('args.planPath is required: pass the ABSOLUTE path to the plan FILE this loop converges. There is no inline plan and no default - both roles read that one file and the editor rewrites it, so an omitted path would critique nothing and report a clean plan.');
}
// `target.repo` is REQUIRED and has NO default. `abs()` resolves a relative path against ROOT, i.e. the
// workflow tool's own directory - so a fallback would have the critic grep THIS repo and clear a plan it
// never checked against the code it is about.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the TARGET git repo the plan builds in. There is no default - the critic verifies every block against real code, and an omitted repo would resolve to this workflow tool\'s own directory and clear a plan it never checked.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example the plan should mirror
const CONVENTIONS = A.conventions ?? '(none supplied - infer from the surrounding code)';

// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0.
// The upper bound stops a fat-fingered maxRounds from spawning agents until something dies.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced - a bound that absorbs garbage runs zero rounds and reports the plan as converged.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 4, 50);    // critic -> editor rounds before rounds-exhausted

// THE SEVERITY FLOOR - which grades COUNT as gaps. Below-floor findings are still written (an FYI section
// of the critique file) but are excluded from gap_count, so they neither drive a fold nor keep the loop
// alive. A typed illegal value must THROW: a floor that coerces silently changes what "clean" means.
const VALID_SEVERITY = ['blocking', 'major', 'minor'];
if (A.critiqueSeverity != null && !VALID_SEVERITY.includes(A.critiqueSeverity)) {
  throw new Error(`Invalid severity floor: args.critiqueSeverity must be blocking | major | minor; got ${JSON.stringify(A.critiqueSeverity)}. It decides which gaps COUNT and which are demoted to the critique file's FYI section, so it must never coerce.`);
}
const SEVERITY      = A.critiqueSeverity ?? 'major';
const SEVERITY_RANK = { blocking: 3, major: 2, minor: 1 };
const COUNTED       = VALID_SEVERITY.filter((s) => SEVERITY_RANK[s] >= SEVERITY_RANK[SEVERITY]);
const BELOW         = VALID_SEVERITY.filter((s) => SEVERITY_RANK[s] < SEVERITY_RANK[SEVERITY]);

// Per-role model tiers + OPTIONAL custom subagent types. Both roles are opus: the critic judges a spec
// against a whole repo, and the editor rewrites the file every later agent builds from.
const M  = { critic: 'opus', editor: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };

const REPO        = abs(TARGET.repo);
const PLAN_PATH   = abs(A.planPath);
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
// The `-refine` suffix is the MECHANISM that keeps this loop's state out of develop-cycle's. The house
// convention reuses ONE runId across a plan's runs, and the sibling default is `runs/<runId>` - so both
// engines would compute the IDENTICAL directory, putting plan-critique files (which quote plan content
// verbatim) one `ls` away from develop's BLIND quality reviewer, whose blindness is a property of
// placement and nothing else (#3). args.stateDir still overrides: an operator who merges them is choosing
// that, rather than inheriting it from a shared runId.
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}-refine`);
// Where the plan-block tool lives. The default hangs it off ROOT because a checkout keeps engine, tools
// and run-state under one folder - but an INSTALLED plugin splits them: run-state (ROOT) goes to the
// persistent plugin data dir while tools/ ships in the versioned plugin cache. Used only in the editor
// prompt, as its mandatory re-validation command.
const BLOCK_TOOL  = A.blockTool ? abs(A.blockTool) : `${ROOT}/tools/plan-block.mjs`;

const critiqueFile = (r) => `${STATE_DIR}/plan-critique-${r}.md`;   // one per round, the critic's full findings
const DISMISSED    = `${STATE_DIR}/DISMISSED-PLAN.md`;              // the editor's declined gaps, one line each
const NEEDS_USER   = `${STATE_DIR}/NEEDS-USER.md`;                  // questions in full; ends the run needs-answers

// Placement guard, ported from the build engines (#3). Run-state and the plan file must both live OUTSIDE
// the target repo: develop-cycle's blind quality reviewer runs against that repo's tree later, and either
// one inside it is a route to the spec. WARN rather than throw, matching the build engines' precedent - a
// mid-flight throw strands a run the operator may still want, and the loud line names the correction.
if (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/')) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo - the critique files quote plan content, and develop-cycle's blind quality reviewer could reach them through the repo tree. Point args.root back at your run-state base - the checkout, or the plugin data dir the skill resolved - never the plugin install dir (see CLAUDE.md).`);
}
if (PLAN_PATH === REPO || PLAN_PATH.startsWith(REPO + '/')) {
  log(`⚠ plan file (${PLAN_PATH}) resolves inside the target repo - that puts the SPEC where a blind reviewer can read it straight out of the repo tree, and where the diff/park machinery could sweep it. Move the plan under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path.`);
}

// =============================================================================
// Schemas - COUNTS AND ATTESTATIONS ONLY (control plane). Every gap, question, grade and citation crosses
// between the two roles through the critique FILE, read verbatim (#8/#2). There is deliberately no verdict
// field: the engine branches on the counts alone, and a field nothing reads is attestation theater.
// =============================================================================
const CRITIC_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'gap_count', 'question_count', 'fyi_count'],
  properties: {
    wrote_file:     { type: 'boolean', description: 'true if you wrote this round\'s critique file' },
    gap_count:      { type: 'integer', description: 'gaps AT OR ABOVE the severity floor (the numbered GAPS section). 0 with question_count 0 ends the run: the plan converged' },
    question_count: { type: 'integer', description: 'questions written to your critique file AND in full to NEEDS-USER.md' },
    fyi_count:      { type: 'integer', description: 'items in the FYI (below floor) section. They never drive a fold and never block convergence' },
  },
};

const EDITOR_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'folded', 'declined', 'plan_parses', 'needs_user'],
  properties: {
    wrote_file:  { type: 'boolean', description: 'true if you actually wrote your edits to the plan file. Reporting folded gaps with false HALTS the run - the fold would exist nowhere' },
    folded:      { type: 'integer', description: 'numbered gaps you closed with an edit to the plan file' },
    declined:    { type: 'integer', description: 'gaps you declined to DISMISSED-PLAN.md' },
    plan_parses: { type: 'boolean', description: 'true ONLY if the plan-block --list command you ran AFTER your edits exited 0' },
    needs_user:  { type: 'boolean', description: 'true ONLY if you appended an entry to NEEDS-USER.md for a contested dismissal' },
  },
};

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `THE PLAN FILE (read it VERBATIM): ${PLAN_PATH}
THE TARGET REPO (read-only - grep it): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
CONVENTIONS the plan must fit: ${CONVENTIONS}
${REFERENCE_P ? `REFERENCE - a completed example the plan should mirror: ${REFERENCE_P}\n` : ''}`;

// =============================================================================
// Role prompts
// =============================================================================
const criticPrompt = (round) => `
You are an INDEPENDENT PLAN CRITIC. You write only your critique file and ${NEEDS_USER}. You MAY run
read-only commands, including a build or test command you find in the repo. Judge the plan file against
the REAL repo and find what would BUILD WRONG. An EMPTY result is a GOOD outcome and ends the run.
${ENV}
THE DEFECT BAR - a gap must name something that would build wrong or fail. Exactly seven classes qualify:
  1. A missing WIRING POINT: the block never says where the work is registered, exported, routed, bound
     or flagged so it is reachable from a real entry point.
  2. A WRONG or ABSENT FILE: a path in the Files list that does not exist, sits elsewhere, or is not the
     file the change must touch.
  3. An ACCEPTANCE CRITERION WITH NO IMPLEMENTING STEP: the block promises a behavior no step builds.
  4. A DEPENDENCY-ORDERING ERROR between blocks: a block needs something a later block creates.
  5. A BLOCK TOO BIG for one develop pass: more than roughly one coherent artifact plus its tests.
  6. A REFERENCE OUTSIDE THE BLOCK: develop hands each agent only its own block by default, so a path, term or
     instruction the block relies on but states only in the file preamble or another block is missing.
  7. A FAILURE ON ACCEPTED INPUT: built as written, the block crashes, loses or corrupts data, or gives
     wrong output on an input the repo or the plan accepts.
IMPROVEMENTS, ALTERNATIVES and STYLE are OUT OF SCOPE, with no exceptions: a better design, a nicer name,
an extra safeguard you would have added, a different approach.
EVERY gap carries file:line evidence - the plan line it is about, and the repo line that contradicts it.
NO EVIDENCE, NO GAP. Grep the repo; never trust the plan's own lists.

BLOCK METADATA is part of what you judge. Each \`## Plan: <id>\` block opens with a preamble run of
\`key: value\` lines: \`mode\` (feature | section | fix), \`gate\`, \`status\` (todo | done | skip | parked |
blocked), plus informational \`test_selector\` and \`depends_on\`. A \`gate\` ILLEGAL for its block's mode is
a gap (feature takes green | build-only; section takes green | red-baseline | build-only; fix takes
green). File keys \`goal\` / \`ordered\` / \`suite\` / \`sweep\` sit above the first block.

SCOPE RULE 1 - you judge only blocks whose \`status\` is \`todo\` or absent. A block marked done, skip,
parked or blocked is CLOSED. A gap you find in one of those goes to ${NEEDS_USER} as a QUESTION and NEVER
to the editor.
SCOPE RULE 2 - a DEPENDENCY-ORDERING ERROR (class 4) or a BLOCK TOO BIG (class 5) whose fix splits,
merges, adds or reorders blocks is reported as a QUESTION, never as a gap. It ends the run so the
operator can restructure.
SCOPE RULE 3 - a finding whose fix is a text edit inside ONE todo block is a GAP, whatever its class.

THE SEVERITY FLOOR is ${SEVERITY}. Grade every gap by what the code built from the block would do:
  blocking - the block cannot be built correctly from this text at all.
  major    - the block builds, but a named acceptance criterion or wiring point is not met, or the built
             code crashes, loses or corrupts data, or gives wrong output on an input the repo or the plan
             accepts.
  minor    - any other real defect.
Three rules settle the grade, and each wins over the definitions above:
  - An OMISSION the block's own green gate would catch on its first run is minor. Only the gate counts
    as a catch, never a guess that the developer will notice.
  - A WRONG INSTRUCTION the gate would not catch is major or higher.
  - The size of the fix never lowers a grade. A one-word fix to a crash on an accepted input that the
    gate would not catch is major.
Gaps graded ${COUNTED.join(' or ')} COUNT: write them in the numbered GAPS section and include them in
gap_count. ${BELOW.length
    ? `Gaps graded ${BELOW.join(' or ')} are BELOW the floor: list them in a separate
"## FYI (below floor)" section and EXCLUDE them from gap_count. Count them in fyi_count.`
    : 'No grade sits below this floor, so every gap you find counts.'}

SETTLED DECISIONS - READ ${DISMISSED} FIRST if it exists: the editor's ledger of declined gaps, one line
each with a reason. SKIP every item listed there FOR THE STATED REASON. If you are confident a reason is
WRONG and the gap genuinely clears the defect bar, raise it ONCE for the whole run, prefixed
"CONTESTS DISMISSAL:", saying why the reason does not hold. A line marked \`USER-RULED:\` is the user's
own ruling: never contest it.

WRITE ${critiqueFile(round)} (create ${STATE_DIR}/ if needed) and put EVERYTHING there VERBATIM, since it
is your ONLY channel to the editor: a numbered GAPS section, then the FYI section, then a QUESTIONS
section. Per gap: the block id, which of the seven classes it is, its grade, the file:line evidence,
EXACTLY ONE smallest change that closes it (never alternatives), and the number of every other gap whose
change touches the same plan lines, so the editor folds them together.
QUESTIONS also go to ${NEEDS_USER} IN FULL (append, create it if needed).
ONE RULE decides whether you write the file: write it when you have ANY gap, FYI item or question, and
return wrote_file=true. A round with FYI items and no gaps or questions writes the file with its FYI
section, returns wrote_file=true with gap_count and question_count 0 and fyi_count set, and still
converges. A round with nothing at all writes NOTHING and returns wrote_file=false with all three counts 0.
Do NOT modify the plan file or the target repo. Do NOT stage or commit.
Return via the schema.`;

const editorPrompt = (round, critiquePath) => `
You are the PLAN EDITOR. Fold this round's gaps into the plan file.
${ENV}
THE GAPS TO FOLD (read it verbatim): ${critiquePath}
This is round ${round} of at most ${MAX_ROUNDS}.

THE ONE GUARD THAT MATTERS: you may change ONLY what a numbered gap NAMES. Not a wording improvement,
not an extra step you think a block needs, not a criterion you would have phrased differently, and not
the FYI section.

PROCEDURE:
1. For each numbered gap, make the smallest edit to ${PLAN_PATH} that closes it - usually one line, one
   step, one file path, one criterion. Keep each block's existing shape, headers and preamble keys.
2. A gap you DECLINE (it is wrong, or it names something the block already covers) gets ONE line
   appended to ${DISMISSED} (create it if needed):
     \`<block id> - <gap gist> - DECLINED: <reason, 15 words or fewer>\`
   The critic skips the item next round for your stated reason, so a vague reason buys the same gap again.
3. A gap prefixed "CONTESTS DISMISSAL:" may NOT be declined a second time. FOLD it, or - if it is
   genuinely a call only the user can make - append a full self-contained entry to ${NEEDS_USER} and set
   needs_user=true.
4. MANDATORY FINAL STEP, after every edit is written: run
     node '${BLOCK_TOOL}' '${PLAN_PATH}' --list
   and report plan_parses = (it exited 0). The plan-bus grammar is strict: a folded \`key: value\` line
   landing at the top of a block BODY joins the preamble run and throws as an unrecognized key. Non-zero
   exit: FIX the file and re-run until it exits 0. Report plan_parses=false only if you could not.
Do NOT modify the target repo. Do NOT stage or commit anything.
Return via the schema.`;

// =============================================================================
// THE LOOP - [critique -> (fold, when there are gaps and no questions)] x maxRounds.
// It STARTS and ENDS with the critic: the editor only ever folds what a round produced, and the run only
// ends clean when a critic that ran found nothing. haltKind is set at EVERY terminal site and mapped once
// below; nothing sniffs prose (tests/CLAUDE.md §3).
// =============================================================================
log(`refine: converging ${PLAN_PATH} against ${REPO} [floor=${SEVERITY}, maxRounds=${MAX_ROUNDS}] → ${STATE_DIR}`);

let round = 0;
let haltKind = 'rounds';        // the default terminal state: the loop fell through its round budget
let openGaps = 0;               // the LAST round's at-or-above-floor gap count
let questions = 0;              // the LAST round's question count
let belowFloor = 0;             // the LAST round's FYI count
let dismissedCount = 0;         // gaps the editor declined across the whole run
let lastCritique = '';          // the last critique file a critic CONFIRMED writing - never one nothing wrote

while (round < MAX_ROUNDS) {
  round++;

  // ---- CRITIQUE (read-only, non-blind) ---------------------------------------
  phase('Critique');
  const crit = await agent(criticPrompt(round), roleOpts('critic', {
    schema: CRITIC_SCHEMA, phase: 'Critique', label: `plan-critic r${round}`,
  }));
  // A dead critic must NEVER read as a clean round: zero gaps from an agent that died is byte-identical
  // to convergence, and this loop's ONLY success signal is "a critic looked and found nothing". The throw
  // fires on a NULL return specifically - never on a missing count - because an agent that returns an
  // empty object still ran, and the required-args baseline contract feeds every engine exactly that and
  // expects a clean fall-through (decide-cycle's guard is the pattern).
  if (!crit) throw new Error(`Plan critic returned nothing in round ${round} (agent skipped or died) - that is NOT a clean plan. Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  openGaps  = Math.max(0, Number(crit.gap_count) || 0);
  questions = Math.max(0, Number(crit.question_count) || 0);
  belowFloor = Math.max(0, Number(crit.fyi_count) || 0);
  const wroteCritique = crit.wrote_file === true;
  if (wroteCritique) lastCritique = critiqueFile(round);

  // Findings with no file to hold them exist NOWHERE: the editor's only input is that file, and the
  // operator's only copy of a question is that file plus NEEDS-USER.md. A clean round with no FYI items
  // writes nothing, so this fires only when a count says there was something to write.
  if ((openGaps > 0 || questions > 0 || belowFloor > 0) && !wroteCritique) {
    haltKind = 'critique-unwritten';
    log(`  ✋ r${round}: critic returned ${openGaps} gap(s) + ${questions} question(s) + ${belowFloor} FYI item(s) but did NOT confirm writing ${critiqueFile(round)} - the findings exist nowhere; halting`);
    break;
  }
  log(`  r${round}: ${openGaps} gap(s) at or above ${SEVERITY}, ${belowFloor} below it, ${questions} question(s)`);

  // Questions END the run. Both classes that produce one - an ordering error between blocks and a block
  // too big for one develop pass - change the block STRUCTURE and the operator's derived plans array, and
  // the minimal-fold editor has no legal edit for either. So does a gap found in an already-done block.
  if (questions > 0) {
    haltKind = 'needs-answers';
    log(`  ✋ r${round}: ${questions} question(s) for the operator (see ${NEEDS_USER}) - the editor has no legal edit for these; halting`);
    break;
  }
  // ONE CLEAN ROUND and done. A critic that ran, read the ledger, and found nothing at or above the floor
  // is the whole convergence condition.
  if (openGaps === 0) {
    haltKind = 'converged';
    log(`  ✓ r${round}: no gaps at or above ${SEVERITY} and no questions - the plan has converged`);
    break;
  }

  // ---- FOLD (minimal edit, gaps only) ----------------------------------------
  phase('Fold');
  const fold = await agent(editorPrompt(round, critiqueFile(round)), roleOpts('editor', {
    schema: EDITOR_SCHEMA, phase: 'Fold', label: `plan-editor r${round}`,
  }));
  // A dead EDITOR halts rather than throws: the critique file is on disk, so a resumeFromRunId relaunch
  // replays the cached critic and redoes only the fold. (A dead CRITIC throws - nothing survives it.)
  if (!fold) {
    haltKind = 'agent-dead';
    log(`  ✋ r${round}: plan editor returned nothing (skipped or died) - it may have partly edited ${PLAN_PATH}, so run node '${BLOCK_TOOL}' '${PLAN_PATH}' --list first; relaunch with resumeFromRunId to replay the cached critic and redo the fold from ${critiqueFile(round)}; halting`);
    break;
  }
  const folded   = Math.max(0, Number(fold.folded) || 0);
  const declined = Math.max(0, Number(fold.declined) || 0);
  dismissedCount += declined;
  log(`  r${round}: folded ${folded}, declined ${declined} (ledger: ${DISMISSED})`);

  // Folded gaps with no write attestation means the plan file is UNCHANGED while the engine believes the
  // round made progress - the next critic would re-find the same gaps and the loop would burn its budget
  // reporting folds that never happened.
  if (folded > 0 && fold.wrote_file !== true) {
    haltKind = 'fold-unattested';
    log(`  ✋ r${round}: editor reported ${folded} folded gap(s) but did NOT confirm writing ${PLAN_PATH} - the fold exists nowhere; halting`);
    break;
  }
  // The plan-bus grammar is strict and every later consumer reads this file - develop-cycle's agents get
  // their block from it. A broken parse is not recoverable by another round; it is repaired by hand.
  if (fold.plan_parses !== true) {
    haltKind = 'plan-broken';
    log(`  ✋ r${round}: editor did not confirm ${PLAN_PATH} still parses (node '${BLOCK_TOOL}' '${PLAN_PATH}' --list must exit 0) - halting before another agent builds from it`);
    break;
  }
  // A contested dismissal the editor escalated is a user-only call. Another round would find the original
  // DISMISSED line, skip it, and could report converged with the question still unanswered. Its ruling is
  // recorded where the next critic reads it, so a relaunch does not contest it again.
  if (fold.needs_user === true) {
    haltKind = 'dismissal-contested';
    log(`  ✋ r${round}: editor escalated a contested dismissal to the operator (see ${NEEDS_USER}); halting`);
    break;
  }
  if (round >= MAX_ROUNDS) {
    log(`  ⚠ r${round}: round budget spent with ${openGaps} gap(s) folded but never re-critiqued (see ${lastCritique})`);
    break;                       // haltKind stays 'rounds'
  }
  log(`  ↻ r${round}: fold complete → next critic re-reads ${PLAN_PATH} and ${DISMISSED}`);
}

// Each terminal state gets its OWN string. "The plan converged", "the operator must restructure it" and
// "the budget ran out with gaps still open" are three different facts, and folding any pair of them
// together is how an unconverged plan gets handed to a build engine as a finished one.
const HALT_STATUS = {
  'converged':          'converged (one clean round: no gaps at or above the floor, no questions)',
  'needs-answers':      'needs-answers (the critic raised questions only the operator can settle - restructure the plan, then relaunch as a FRESH run (same runId and stateDir, NO resumeFromRunId - a resume replays the cached return and halts the same way))',
  'dismissal-contested': 'dismissal-contested (the editor escalated a contested dismissal to NEEDS-USER.md - record the user\'s ruling by folding the gap into the plan or by appending "<block id> - <gap gist> - USER-RULED: <reason>" to DISMISSED-PLAN.md, then relaunch as a FRESH run (same runId and stateDir, NO resumeFromRunId - a resume replays the cached return and halts the same way))',
  'rounds':             'rounds-exhausted (gaps were still being found at the round budget - the plan is NOT converged)',
  'agent-dead':         'BLOCKED (the plan editor returned nothing - it was skipped or died and may have partly edited the plan file; run the plan-block --list check on it first, then relaunch with the same args plus the Workflow tool\'s resumeFromRunId to replay the cached critic and redo the fold - a relaunch without it restarts at round 1)',
  'critique-unwritten': 'BLOCKED (the critic returned findings but did not confirm writing its critique file - the findings exist nowhere; relaunch as a FRESH run (same runId and stateDir, NO resumeFromRunId - a resume replays the cached return and halts the same way) to redo the round)',
  'fold-unattested':    'BLOCKED (the editor reported folded gaps but did not confirm writing the plan file - the fold exists nowhere; inspect the plan, then relaunch as a FRESH run (same runId and stateDir, NO resumeFromRunId - a resume replays the cached return and halts the same way))',
  'plan-broken':        'BLOCKED (the folded plan file no longer parses - every later consumer reads it, so repair it by hand, then relaunch as a FRESH run (same runId and stateDir, NO resumeFromRunId - a resume replays the cached return and halts the same way))',
};
// No silent fallback string: an unmapped haltKind is an engine bug, and reporting it as a plausible
// terminal state is precisely the collapse this table exists to prevent.
const status = HALT_STATUS[haltKind] || `halted (unmapped terminal state "${haltKind}" - engine bug)`;
log(`refine: ${status} after ${round} round(s) - ${openGaps} open gap(s), ${questions} question(s), ${dismissedCount} declined`);

return {
  status,
  runId: RUN_ID,
  rounds: round,
  // The LAST round's counts. On rounds-exhausted these are the gaps the critic found and the editor then
  // folded WITHOUT a further critic seeing the result - open in the only sense that matters: unverified.
  openGaps,
  questions,
  belowFloor,
  dismissedCount,
  // Named only where a critic CONFIRMED writing it. `round > 0` is the house gate - a field derived from
  // the DEFAULT haltKind must not name a file no agent wrote - and the write attestation is the other
  // half, since a converged round with no FYI items legitimately writes nothing at all.
  lastCritique: round > 0 ? lastCritique : '',
  planPath: PLAN_PATH,
  stateDir: STATE_DIR,
};
