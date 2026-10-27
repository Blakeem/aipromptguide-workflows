export const meta = {
  name: 'decide-cycle',
  description: 'Convergent decision, lean/file-bus design: fan out ONE analyst per lens (each finds + scores the best option through its lens, written to its own file), then a DECIDER funnels them into one conclusion via a global weighted decision matrix that pulls in the best of each, and NON-BLIND adversarial reviewers check that conclusion against the fixed requirements: three focused reviewers in round 1, then one verifier per later round that checks the folds the decider made. A gap BLOCKS only on a non-negotiable violation, a correctness defect, a wrong choice or a missed option; every other real gap is a CAVEAT carried to the plan. Looped until no reviewer holds a blocking gap. The harness only routes paths + verdicts; rich content lives in files.',
  whenToUse: 'Have the AI reach a JUSTIFIED conclusion among approaches, weighing real trade-offs. Set selection:"ranked" instead when the answer is legitimately a PORTFOLIO rather than a choice — "give me the best N, I will pick or combine" — e.g. ranking a large pool of candidates surfaced by many agents over a big corpus; same matrix, same citation discipline, same adversarial review, but the output is an ordered shortlist with combine/exclusive notes and no single winner. The main agent authors the REQUIREMENTS (non-negotiable constraints + weighted criteria — the rubric both the decider and reviewer judge against) in PLAN MODE, approves them with the user, picks the LENSES (e.g. efficiency, simplest, robustness, best-practice), then runs this engine. It diverges into lensed option-generation, then converges via decider ⇄ review loop. To explore open-ended creative variations for a HUMAN to pick (no AI verdict) use brainstorm-cycle; to BUILD the chosen approach, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.',
  phases: [
    { title: 'Diverge', detail: 'One analyst per lens (CONCURRENT). Each reads the requirements (verbatim) + its lens, generates 2–4 options, scores them under its lens, recommends one, and writes lenses/<lens>.md. Returns a thin index.' },
    { title: 'Decide', detail: 'The decider reads the requirements + every lens file (+ every review file of the previous round), combines the best elements, builds a GLOBAL weighted decision matrix enforcing the non-negotiables — every cell citing its lens evidence or marked own-judgment — picks the winner, and writes decision-rN.md. Returns the choice + a meets-all-requirements flag.' },
    { title: 'Review', detail: 'NON-BLIND adversarial reviewers read the decision + requirements + lens files. Round 1 runs three focused reviewers CONCURRENTLY (single: choice, requirements, design; ranked: order, requirements, combine), each writing decision-review-r1-<focus>.md. Each later round runs one verifier that reads every review file of the previous round, checks each blocking gap was closed or rebutted, judges every changed passage, and writes decision-review-rN.md. Every gap is BLOCKING (non-negotiable violation, correctness defect, wrong choice, missed option) or a CAVEAT. No blocking gap ends the loop; blocking gaps drive another Decide round.' },
  ],
};

// =============================================================================
// Config — everything decision-specific arrives via args so the engine stays general.
// Decide is a CONVERGENCE workflow: it produces a conclusion, not code — nothing is staged or
// committed. Its review loop honors the SPIRIT of WORKFLOW-PRINCIPLES.md #5 but is NON-BLIND by
// design: the reviewer MUST see the decision + the requirements it's judged against (a reviewer blind
// to the decision can't evaluate it). The fixed requirements file is the anti-spin rubric — both
// agents check against it, so the loop converges. The main agent authors the requirements + picks the
// lenses with the user BEFOREHAND (#4) — the engine spawns no setup/loader agent.
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
  throw new Error('args must include at least { runId, root, lenses, planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL read-only context
const CONTEXT     = A.context ?? '';                       // short extra framing (domain facts the agents won't know)
const TESTBED     = A.testbed ?? '';                       // OPTIONAL: how agents may empirically test claims (e.g. a read-only sqlite db + how to query it)
// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0.
// The upper bound stops a fat-fingered maxRounds from spawning agents until something dies.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round run and reports it as an ordinary result.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 3, 50);    // decider ⇄ reviewer rounds before "needs-attention"

// SELECTION — what the decider is asked to produce.
//   'single' (default) : ONE justified winner + why-not-each-runner-up. The normal decision.
//   'ranked'           : a RANKED SHORTLIST of the strongest options, no single winner, with what each
//                        buys and costs and which of them combine. Use when the answer is legitimately
//                        a portfolio rather than a choice — "give me the best N, I'll pick" — e.g.
//                        ranking a large pool of candidates surfaced by many agents over a big corpus.
// Both modes run the SAME weighted matrix with the same citation discipline (#14) and the same
// adversarial review; only the shape of the conclusion (and what the reviewer checks) differs. In
// 'single' the decider may still build a HYBRID that combines the best of several lenses — that has
// always been in scope and is not what 'ranked' is for.
const SELECTION   = A.selection ?? 'single';
if (SELECTION !== 'single' && SELECTION !== 'ranked') {
  throw new Error(`args.selection must be 'single' (one justified winner — the default) or 'ranked' (a ranked shortlist, no single winner); got "${SELECTION}".`);
}
const RANKED      = SELECTION === 'ranked';
const SHORTLIST_N = num(A.shortlist, 'shortlist', 2, 5, 50);    // ranked only: how many to carry on the list

// Per-role model tiers + OPTIONAL custom subagent types. Decider + reviewer are opus (high stakes);
// the per-lens analysts are the fast tier by default.
const ROLE_KEYS = ['analyst', 'decide', 'review'];
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
const M  = { analyst: 'sonnet', decide: 'opus', review: 'opus', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { analyst: DEFAULT_EFFORT, decide: DEFAULT_EFFORT, review: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], effort: EF[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });
log(`decide: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const LENS_DIR    = `${STATE_DIR}/lenses`;
const lensFile    = (id) => `${LENS_DIR}/${id}.md`;
const decisionFile       = (r) => `${STATE_DIR}/decision-r${r}.md`;
const decisionReviewFile = (r, focus) => `${STATE_DIR}/decision-review-r${r}${focus ? `-${focus}` : ''}.md`;
const NEEDS_USER  = `${STATE_DIR}/NEEDS-USER.md`;          // user-only escalations (may halt the run)

// Requirements: the FIXED rubric — non-negotiable constraints + weighted criteria — read verbatim
// (#2/#11) by the analysts, the decider, AND the reviewer. The single source of truth that makes the
// loop converge. It lives in a file (planPath).
if (typeof A.planPath !== 'string' || !A.planPath.trim()) {
  throw new Error('args.planPath is required: pass the ABSOLUTE path to the requirements FILE (the rubric both the decider and reviewer judge against). There is no inline `requirements` arg. A rubric written without plan mode goes to plans/<runId>/ under root first.');
}
const PLAN_PATH   = abs(A.planPath);
const REQ_REF     = `the requirements at ${PLAN_PATH} (read them verbatim: the fixed rubric)`;

// Lenses — the evaluation perspectives. Each becomes ONE analyst → ONE file. Accept strings or {id, focus}.
const LENSES = (Array.isArray(A.lenses) ? A.lenses : []).map((l, i) => {
  if (typeof l === 'string') return { id: slug(l) || `lens-${i + 1}`, focus: l };
  const focus = l.focus || l.id || '';
  return { id: slug(l.id || focus) || `lens-${i + 1}`, focus };
}).filter((l) => l.focus);
if (LENSES.length < 2) {
  throw new Error('args.lenses requires >=2 evaluation perspectives (strings, or { id, focus }), e.g. ["efficiency","simplest","robustness","best-practice"] — one lens has no cross-lens trade-off to weigh; just decide directly. The main agent picks these with the user beforehand (#4).');
}
const dupes = [...new Set(LENSES.map((l) => l.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`lens ids collide after slugging (${dupes.join(', ')}): two analysts would write the same file — give each lens a distinct id.`);
}

// =============================================================================
// Schemas — DECISIONS ONLY (control plane). All reasoning/matrices live in files (#8).
// =============================================================================
const ANALYST_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'top_pick'],
  properties: {
    wrote_file:    { type: 'boolean', description: 'true if you wrote your lens file' },
    top_pick:      { type: 'string', description: 'short title of the option your lens favours' },
  },
};

const DECIDE_SCHEMA = {
  type: 'object',
  required: RANKED ? ['wrote_file', 'chosen', 'shortlist', 'meets_all_requirements', 'flip', 'needs_user'] : ['wrote_file', 'chosen', 'meets_all_requirements', 'flip', 'needs_user'],
  properties: {
    wrote_file:             { type: 'boolean', description: 'true if you wrote the decision file' },
    chosen:                 { type: 'string', description: RANKED ? 'short title of the RANK-1 option (the list itself is in the file)' : 'short title of the chosen conclusion (may be a hybrid)' },
    ...(RANKED ? {
      shortlist: {
        type: 'array',
        description: 'the ranked shortlist, best first — an INDEX only; the reasoning and matrix live in the decision file',
        items: {
          type: 'object',
          required: ['rank', 'title'],
          properties: {
            rank:  { type: 'integer', description: '1 = strongest' },
            title: { type: 'string' },
            combines_with: { type: 'array', items: { type: 'integer' }, description: 'ranks of the other listed options this genuinely composes with' },
            excludes:      { type: 'array', items: { type: 'integer' }, description: 'ranks of listed options that are MUTUALLY EXCLUSIVE with this one' },
          },
        },
      },
    } : {}),
    meets_all_requirements: { type: 'boolean', description: RANKED ? 'true if EVERY option on the shortlist satisfies every non-negotiable' : 'true if the conclusion satisfies every non-negotiable + criterion in the requirements (your own honest assessment)' },
    flip:                   { type: 'string', enum: ['robust', 'fragile', 'dominant'], description: 'your flip-check grade from the decision file: dominant = the winner gives up nothing against the runner-up, robust = the smallest flip is larger than the uncertainty of the input it moves, fragile = it is not' },
    open_questions:         { type: 'integer', description: 'count of unresolved points you noted in the decision file (0 if none)' },
    needs_user:             { type: 'boolean', description: 'true ONLY if a genuine choice/contradiction only the USER can resolve blocks you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'agree', 'gap_ids', 'caveat_ids', 'needs_user'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true if you wrote the review file' },
    agree:      { type: 'boolean', description: 'true ONLY if your review holds no BLOCKING gap. Caveats never block agree' },
    gap_ids:    { type: 'array', items: { type: 'string' }, description: 'one SHORT kebab-case slug per BLOCKING gap in your review file, naming the ISSUE and not the round (e.g. "p99-unproven", "reopen-deletes-human-row"). [] when you agree. Re-raising THAT SAME issue as a slug listed from an earlier round: reuse it verbatim. Mint a new one only for a genuinely new gap' },
    caveat_ids: { type: 'array', items: { type: 'string' }, description: 'one SHORT kebab-case slug per CAVEAT in your review file. [] when there is none' },
    needs_user: { type: 'boolean', description: 'true ONLY if you found a requirement contradiction only the USER can resolve; you wrote it to NEEDS-USER.md' },
  },
};

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `THE DECISION + RUBRIC: ${REQ_REF}
${REPO ? `CODEBASE (read-only context — pattern-fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}${TESTBED ? `TESTBED — ground claims EMPIRICALLY where you can: ${TESTBED}\nPrefer MEASURED evidence over reasoning: run the check and cite the exact command + result in your file,
so the reviewer can re-run it. Treat the testbed as READ-ONLY unless it says otherwise. Leave no artifacts.
A measured difference smaller than the spread across repeated runs decides nothing: score it own judgment,
low-confidence, and state the spread.\n` : ''}NON-NEGOTIABLES are pass/fail: an option that violates one scores 0 on that axis and cannot win.
Judge each non-negotiable at the depth the requirements state. Where they state none, judge it on the
DEFAULT PATH: the default configuration and the paths the design runs with no operator action.
Prefer the SIMPLEST option that meets all requirements. If a more complex option wins, the matrix must
justify why the simpler one is inadequate.`;

// =============================================================================
// Role prompts
// =============================================================================
const analystPrompt = (lens) => `
You are an ANALYST evaluating the decision THROUGH ONE LENS. Find the best answer your lens can offer.
Push that perspective hard and do NOT pre-compromise: the decider balances lenses later.
${ENV}
YOUR LENS: ${lens.focus}

PROCEDURE:
1. Generate 2–4 DISTINCT options that address the decision, including a simple baseline.
2. Score each option 0–10 FROM YOUR LENS (a non-negotiable violation = 0).
3. Recommend the one option your lens favours, say what it gives up against your runner-up, and name
   the ELEMENTS of it worth keeping even if another option wins (so the decider can build a hybrid).
WRITE ${lensFile(lens.id)} (create ${LENS_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} Per option, write a short block with title,
description, and your 0–10 lens score + why. For your pick, add the keep-worthy elements. Be concrete and
terse. Cite each factual claim: a file:line, a measurement (the exact command and its result), a source URL,
or "own judgment" where you have none. The ${RANKED ? 'order' : 'choice'} reviewer re-checks the source behind
each matrix cell that moves the outcome. Do NOT modify any repo, stage, or commit.
Return via the schema.`;

const decidePrompt = (round, reviewPaths) => `
You are the DECIDER. Converge the lensed analyses into ${RANKED
    ? `a RANKED SHORTLIST of the strongest options (up to ${SHORTLIST_N}) via a global weighted decision
matrix. You are NOT picking one winner: the user wants the best options in order, to choose among or
combine.`
    : `ONE justified conclusion via a global weighted decision matrix.`}
${ENV}
LENS ANALYSES — read each VERBATIM:
${LIVE.map((l) => `  - ${lensFile(l.id)}  (lens: ${l.focus})`).join('\n')}
${round === 1
    ? ''
    : `The reviewers did NOT yet agree. READ every review file of round ${round - 1}:
${reviewPaths.map((p) => `  - ${p}`).join('\n')}
Each holds a BLOCKING section and a CAVEATS section. REVISE your decision at ${decisionFile(round - 1)}
into a complete new file:
- A gap is another agent's claim. Before you fold a BLOCKING gap, confirm its evidence against its
  source: open the lens file, file:line, URL or requirements text it cites, and re-run a measurement it
  cites where you can run it. Treat its smallest change as a hint. Fold the SMALLEST change that closes
  the confirmed defect, which may differ from the hint, and check it against every passage of your
  decision that states the same fact.
- A gap whose evidence you refute is rebutted under a \`## Rebuttals\` heading with evidence: a lens claim,
  a file:line, a measurement or the requirements text. A rebuttal without evidence is not one. A gap you
  can neither confirm nor refute goes under \`## Rebuttals\` marked unverified, with the check that would
  settle it.
- You MAY fold a CAVEAT whose fix is one sentence. Leave every other caveat alone: the review files
  carry it to the user.
- A repair patches the option it repairs. Never add a repaired variant as a new rival option. When a
  fold repairs one option against a defect another option shares, repair that option the same way and
  keep it scored in the matrix. But an option or hybrid a reviewer raised as missed in two rounds goes
  into the matrix, scored.
- Before you write a fold, test it against one hostile input of each kind it touches, such as a failure,
  a concurrent edit, a human-set value, state saved before the change (a legacy row, a migration, a
  value an older version stored), or an edit by another program that no scan has seen yet, so the fold
  does not open a new defect.
- Change nothing a gap does not name. Then redo the totals, ${RANKED ? 'the order' : 'the trade-off'} and the flip check.
`}
PROCEDURE:
1. Consolidate the options across all lens files and dedupe near-identical ones. You MAY build a hybrid
   of the best elements of several, but only where they genuinely compose (no Frankenstein).
2. Take the weighted CRITERIA and their weights from the requirements. Build a decision matrix: each
   candidate (incl. any hybrid) scored 0–10 per weighted criterion, non-negotiable violations forced to
   0, weighted total computed. The highest defensible total wins.
   GROUND every cell: cite the lens evidence behind the score (lens + the specific claim). Where none
   exists (a legitimate cross-lens synthesis), mark it "own judgment, low-confidence". Never fabricate a
   citation. Each option you rule out, by a non-negotiable or as a runner-up, cites what rules it out
   and names the one observation that would reverse that.
${RANKED
    ? `3. RANK the strongest options by weighted total, best first, up to ${SHORTLIST_N}. An option that
   violates a non-negotiable is OFF the list, never ranked last. Do NOT pad: three real options beat
   ${SHORTLIST_N} with filler, and if one option truly dominates, say so at rank 1 rather than
   manufacturing rivals.
4. FLIP CHECK: for each adjacent pair on the list, the smallest change to one cell or one weight that
   swaps them. Grade the rank-1 position: DOMINANT when rank 1 is at least as good as rank 2 on every
   criterion, ROBUST when the smallest swap is larger than the uncertainty of the input it moves, FRAGILE
   when it is not.
WRITE ${decisionFile(round)} (create ${STATE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} Write the matrix (table, all candidates scored),
then the RANKED SHORTLIST (one block per option: what it BUYS, what it COSTS, and why it sits above the one
below it), then a "Combine / exclude" section stating which listed options genuinely COMBINE and which are
MUTUALLY EXCLUSIVE (a shortlist the user cannot safely mix is a trap), then the flip check, then anything
you considered and left OFF the list with one line why, then any open questions. Do NOT modify any repo,
stage, or commit.`
    : `3. State the WINNER, WHY it wins, and WHY NOT each runner-up (the disqualifying trade-offs). Confirm it
   satisfies every non-negotiable and criterion. Note any residual risk or follow-up.
4. TRADE-OFF: the winner against the runner-up as two columns, GAINS and GIVES UP, one row per criterion
   where they differ, written as weight x score gap, so the columns net to the difference in totals. An
   empty GIVES UP column means the winner dominates: say so. A consideration the requirements have no
   criterion for goes below the table, unweighted and marked outside the rubric.
5. FLIP CHECK: the smallest single change to one cell or one weight that changes the winner (from, to),
   and the joint effect of moving every low-confidence cell by its uncertainty together. Grade the choice
   DOMINANT when the GIVES UP column is empty, ROBUST when the smallest flip is larger than the uncertainty
   of the input it moves, FRAGILE when it is not. For FRAGILE, name the input that decides it and the
   evidence or user call that would settle it.
WRITE ${decisionFile(round)} (create ${STATE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} Write the matrix (table), the chosen conclusion
with its rationale, the why-not-others, a \`## Trade-off\` section, a \`## Flip check\` section, and any
open questions. Do NOT modify any repo, stage, or commit.`}
If a genuine contradiction in the requirements (or a choice only the user can make) blocks you, append a
full entry to ${NEEDS_USER} and set needs_user=true (the run HALTS).
Return via the schema.`;

// Round 1 splits the review by FOCUS, so one pass covers what three fresh sequential samples used to find
// one round at a time. Later rounds verify the folds instead of re-sampling the whole decision, so the
// loop converges on the folds rather than on whatever the next fresh reviewer happens to read.
// A lens file can misquote its own source, so the cells that decide the outcome are checked past it.
const sourceCheck = (outcome) => `For each cell that moves the outcome, one the flip check names or one
whose error would change ${outcome}, open the source the lens file cites behind it and confirm it says what
the cell claims${TESTBED ? ', and re-run each testbed command the cell rests on' : ''}.`;
const FOCUSES = RANKED
  ? [
    { id: 'order', check: `the MATRIX and the ORDER. Verify every matrix cell's citation against its lens file and
re-derive every total. ${sourceCheck('the order')} Name any option that dominates the one ranked above it, any pair the matrix does
not support, any filler option, and any clearly stronger option left OFF the list or never considered.` },
    { id: 'requirements', check: `the NON-NEGOTIABLES and the CRITERIA. Check every listed option against every
non-negotiable, path by path, and check every weighted criterion is addressed. The order reviewer
re-derives the matrix, so do not.` },
    { id: 'combine', check: `the COMBINE / MUTUALLY-EXCLUSIVE claims. Check each claimed pair against the lens
evidence${REPO ? ' and the codebase' : ''}: two items sold as combinable that actually conflict is the most
damaging error this list can carry.` },
  ]
  : [
    { id: 'choice', check: `the CHOICE. Verify every matrix cell's citation against its lens file, re-derive every
total, the trade-off and the flip check (the single smallest flip AND the joint effect of the
low-confidence cells). ${sourceCheck('the winner')} Look for a stronger option or hybrid the decider dismissed or never considered, a
"why not" that strawmans a runner-up, and a ruling-out whose premise the evidence contradicts.` },
    { id: 'requirements', check: `the REQUIREMENTS. Check the winner's design against every non-negotiable, path by
path, and check every weighted criterion is addressed. The choice reviewer re-derives the matrix, so do
not.` },
    { id: 'design', check: `the DESIGN the conclusion specifies: does it work as written? Walk every input the
requirements accept, the edge and failure paths included. Look for a rule that contradicts another rule,
the requirements${REPO ? ' or the codebase' : ''}, a step that depends on something built later, and a
claim the conclusion rests on that the design does not deliver. The choice reviewer re-derives the
matrix, so do not.` },
  ];

const SEVERITY = `SEVERITY: every gap is BLOCKING or a CAVEAT. A gap is BLOCKING only when it is one of these:
  1. A NON-NEGOTIABLE VIOLATION by ${RANKED ? 'a listed option' : 'the winner'}, judged at the depth the requirements state, or on
     the default path where they state none. Normal use, an edit by another program or tool, and a
     failure such as an outage, a timeout or a locked file are all on the default path. Operator
     action means only a deliberate configuration change or command by the user that the requirements
     neither list as a scenario nor require the decision to provide. A path they list or require, such
     as a human commit, a revert or a manual apply path, is on the default path.
  2. A CORRECTNESS DEFECT in ${RANKED ? 'a listed option' : "the winner's design"}: as written it fails, loses or corrupts data, or
     contradicts itself, the requirements${REPO ? ' or the codebase' : ''}, on an input the requirements accept.
     Size does not matter: a small defect that voids a claim the conclusion rests on blocks. A
     condition the decision states, such as "this holds once X" or "assuming X", is a claim it rests
     on, so an X the design does not deliver is a correctness defect.
  Rules 1 and 2 judge ${RANKED ? 'each listed option' : "the winner's design"} on its own: a defect the runner-up shares, or one
  with no measured instance on an input the requirements accept, still blocks.
  3. A WRONG CHOICE: apply ALL your evidenced score and citation corrections TOGETHER and re-derive the
     totals, and ${RANKED ? 'an adjacent pair swaps' : 'the winner changes'} by more than the uncertainty of the cells you moved. Your
     own judgment against the decider's own judgment on the same cell is inside that uncertainty.
  4. A MISSED OPTION: an option or hybrid the decider dismissed or never considered that, scored with
     evidence, beats ${RANKED ? 'the option it would displace' : 'the winner'} by more than that uncertainty.
Every other real gap is a CAVEAT: an addition the design needs but does not get wrong, a wording
problem, a citation that does not move the outcome, a dispute inside the fragile margin of the flip
check, a breach reachable only through operator action or non-default configuration, or a value
judgment the requirements leave open. A caveat never blocks agree.
EVERY gap, blocking or caveat, carries its evidence: a lens claim, a file:line, a measurement or the
requirements text. No evidence, no gap. A check you ran that holds is evidence, not a gap.`;

// NON-BLIND on purpose (#3 guards code-regression anchoring, not argument evaluation): every reviewer
// MUST see the decision + requirements to judge them. A round-1 reviewer judges its focus fresh. A later
// round's verifier reads the previous round's reviews, since its job is to check the folds they asked for.
const reviewPrompt = (round, focus, priorSlugs, isFinal, prevReviews, olderCaveatFiles) => `
You are an ADVERSARIAL DECISION REVIEWER. ${round === 1
    ? `Try to BREAK ${RANKED ? 'the ranked shortlist' : 'the conclusion'} on ONE focus: ${focus.check}
Other reviewers cover the other focuses at the same time, so go deep on yours.`
    : `The decider revised ${decisionFile(round - 1)} into ${decisionFile(round)} to address the review files of
round ${round - 1}:
${prevReviews.map((p) => `  - ${p}`).join('\n')}
VERIFY THE REVISION:
1. Each BLOCKING gap in those files: closed by the revision, or rebutted under \`## Rebuttals\` with
   evidence that holds? One that is neither stays BLOCKING under its slug. A gap the decider marked
   unverified stays BLOCKING unless you run the check it names and that check refutes the gap.
2. Every passage the revision changed or added (compare the two decision files): judge it in full.
3. Re-derive the totals, ${RANKED ? 'the order' : 'the trade-off'} and the flip check.
In text the revision left unchanged, report only a NON-NEGOTIABLE VIOLATION as blocking. Anything else
you notice there is a caveat. List only NEW caveats: one an earlier review raised stays on record there,
so do not re-list it.${olderCaveatFiles.length ? ` Earlier rounds' caveats are under \`## Caveats\` in these files as well, so read
them before you list one:
${olderCaveatFiles.map((p) => `  - ${p}`).join('\n')}` : ''}`}
${ENV}
THE ${RANKED ? 'SHORTLIST' : 'DECISION'} TO REVIEW (read it verbatim): ${decisionFile(round)}
THE LENS ANALYSES it drew on (cross-check its claims against these): ${LIVE.map((l) => lensFile(l.id)).join(', ')}
${round === 1 ? '' : priorSlugs.length ? `Blocking gaps earlier reviews raised, AS SLUGS: ${priorSlugs.join(', ')}. If a gap you find is the SAME issue
as one of those, or as a caveat in a review file named above, reuse its slug verbatim. Otherwise mint a
new short kebab-case one.
` : `If a gap you find is the SAME issue as a caveat in a review file named above, reuse its slug verbatim.
Otherwise mint a new short kebab-case one.
`}
${SEVERITY}
WRITE ${decisionReviewFile(round, round === 1 ? focus.id : '')} (create ${STATE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} The file has a \`## Blocking\` section and a
\`## Caveats\` section: each gap with its slug, its evidence and, for a blocking gap, the smallest change
that closes it. An empty section says "None." Return the blocking slugs in gap_ids and the caveat slugs in
caveat_ids. Agree (agree=true) exactly when the Blocking section is empty.
Do NOT modify any repo, stage, or commit. If a requirement contradiction
only the user can resolve surfaces, append it to ${NEEDS_USER} and set needs_user=true.${isFinal ? `
This is the run's LAST round: no decider round follows.${round > 1 ? `
Before you write, walk every non-negotiable over the entire design, unchanged text included.` : ''}
If you do NOT agree, END that file with a \`## WHERE NEXT\` section. Say whether the open blocking gaps
sit in text the latest revision changed, so the folds open new defects, or in a requirement the rubric
does not settle, such as how far a non-negotiable reaches or a trade-off you and the decider land on
opposite sides of. For a requirement, name the ONE requirement and the ONE change to it (a weight, a
non-negotiable's depth, a missing criterion) that would let a decision converge.` : ''}
Return via the schema.`;

// =============================================================================
// DIVERGE — fan out one analyst per lens, concurrently (read-only, write own lens file).
// =============================================================================
phase('Diverge');
log(`decide: ${LENSES.length} lens(es) → ${LENS_DIR} [selection=${SELECTION}${RANKED ? ` (top ${SHORTLIST_N})` : ''}, maxRounds=${MAX_ROUNDS}]`);
const analysts = await parallel(LENSES.map((lens) => () =>
  agent(analystPrompt(lens), roleOpts('analyst', {
    schema: ANALYST_SCHEMA, phase: 'Diverge', label: `analyst:${lens.id}`,
  })).then((r) => ({ lens: lens.id, ok: r?.wrote_file === true, top: r?.top_pick || '' }))
));
const ready = analysts.filter(Boolean).filter((a) => a.ok);
for (const a of ready) log(`  ✓ ${a.lens}: favours "${a.top}"`);
if (!ready.length) throw new Error('No analyst produced a lens file — cannot converge. Check the requirements/lenses and re-run.');
// Converge only over lenses whose file exists; a dropped lens is logged, never silently assumed.
const LIVE = LENSES.filter((l) => ready.some((a) => a.lens === l.id));
const failedLensIds = LENSES.filter((l) => !LIVE.includes(l)).map((l) => l.id);
for (const id of failedLensIds) log(`  ✗ ${id}: no lens file (analyst failed/skipped) — dropped from convergence`);

// =============================================================================
// CONVERGE — decider ⇄ non-blind reviewer, until they agree or the round budget is spent.
// =============================================================================
let round = 0, agreed = false, haltReason = '';
let haltKind = '';              // '' (not halted) | 'needs-user' | 'write-unattested'
let reviewPaths = [];           // the last round's review files the decider must address (control: paths only)
let lastReviewFiles = [];       // the latest round's attested review files, agreeing or not (surfaced in the return)
const caveatFiles = [];         // every attested review file whose reviewer listed a caveat that counted, in round order
let lastDecisionFile = '';      // latest decision whose writer attested it: a same-runId re-run can leave stale ones
let lastChosen = '';
let lastShortlist = [];         // ranked mode: the ordered index the decider returned (reasoning is in the file)
let lastMeetsAll = false;       // the decider's own rubric attestation for the latest decision file
let lastFlip = '';              // the decider's flip-check grade for the latest decision file, '' when off the enum
let contradictedFiles = [];     // the review files whose reviewer agreed while listing blocking gaps

// WHICH gaps the reviewers raise, round over round, so the needs-attention hand-back can say whether the
// decider is not resolving what it was given (repeats) or every round finds fresh ground (new).
const gapFirstRound = new Map();   // slug -> first round that raised it
const gapFirstFile  = new Map();   // slug -> first review file that raised it, in FOCUSES order inside round 1
const gapRounds     = [];          // [{ round, gaps, new, repeated, caveats }] — counts only (#8)
const caveatIds     = new Set();   // every caveat slug any review raised, run-wide
let lastGapIds      = [];          // the last round's blocking slugs, for the needs-attention diagnosis
// Slugs are control plane, so they are filtered like one: non-strings and blanks are dropped, and a
// slug listed twice inside ONE round is one gap, not a repeat of itself.
const slugs = (list) => (Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && id);

while (round < MAX_ROUNDS) {
  round++;

  // ---- DECIDE --------------------------------------------------------------
  phase('Decide');
  const dec = await agent(decidePrompt(round, reviewPaths), roleOpts('decide', {
    schema: DECIDE_SCHEMA, phase: 'Decide', label: `decide r${round}`,
  }));
  if (!dec) throw new Error(`Decider returned nothing in round ${round} (agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  // The reviewers and the return would name this path, and a same-runId re-run can leave a stale file there.
  if (dec.wrote_file !== true && dec.needs_user !== true) {
    haltKind = 'write-unattested'; haltReason = `The decider did not confirm writing ${decisionFile(round)} in round ${round}.`;
    log(`  ✋ r${round}: decider did NOT confirm writing ${decisionFile(round)} → halting before the reviewers`);
    break;
  }
  // Per round, no carry-over: an empty shortlist is a valid ranked return and must not pair an older
  // round's options with this round's decision file. Set together, so they describe the file named.
  if (dec.wrote_file === true) {
    lastDecisionFile = decisionFile(round);
    lastChosen = typeof dec.chosen === 'string' ? dec.chosen : '';
    if (RANKED) {
      lastShortlist = Array.isArray(dec.shortlist) ? [...dec.shortlist].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) : [];
    }
    lastMeetsAll = dec.meets_all_requirements === true;
    lastFlip = DECIDE_SCHEMA.properties.flip.enum.includes(dec.flip) ? dec.flip : '';
  }
  if (dec.needs_user === true) {
    haltKind = 'needs-user'; haltReason = `Decider escalated a user-only call in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: decider escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  log(RANKED
    ? `  r${round}: shortlisted ${lastShortlist.length} option(s), rank 1 = "${dec.chosen || '?'}" (meets_all=${dec.meets_all_requirements}, flip=${lastFlip || '?'}, open_q=${dec.open_questions ?? 0})`
    : `  r${round}: chose "${dec.chosen || '?'}" (meets_all=${dec.meets_all_requirements}, flip=${lastFlip || '?'}, open_q=${dec.open_questions ?? 0})`);

  // ---- REVIEW (non-blind, adversarial) -------------------------------------
  phase('Review');
  // A bare caveat slug says nothing about the caveat, so the verifier gets the files that hold the
  // caveats of rounds before the one it reviews, whose files it already reads in full.
  const priorSlugs = [...gapFirstRound.keys()];
  const olderCaveatFiles = caveatFiles.filter((f) => !reviewPaths.includes(f));
  const units = round === 1
    ? FOCUSES.map((f) => ({ focus: f, file: decisionReviewFile(1, f.id), label: `review r1 ${f.id}` }))
    : [{ focus: null, file: decisionReviewFile(round), label: `review r${round}` }];
  const revs = await parallel(units.map((u) => () =>
    agent(reviewPrompt(round, u.focus, priorSlugs, round === MAX_ROUNDS, reviewPaths, olderCaveatFiles), roleOpts('review', {
      schema: REVIEW_SCHEMA, phase: 'Review', label: u.label,
    }))));
  const dead = units.filter((u, i) => !revs[i]);
  if (dead.length) throw new Error(`Reviewer returned nothing in round ${round} (${dead.map((u) => u.label).join(', ')}: agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  // The next decider and the return would name these paths, so their verdicts must not be read either.
  const unattested = units.filter((u, i) => revs[i].wrote_file !== true && revs[i].needs_user !== true).map((u) => u.file);
  if (unattested.length) {
    haltKind = 'write-unattested'; haltReason = `A reviewer did not confirm writing ${unattested.join(', ')} in round ${round}.`;
    log(`  ✋ r${round}: reviewer did NOT confirm writing ${unattested.join(', ')} → halting before its verdict is read`);
    break;
  }
  lastReviewFiles = units.filter((u, i) => revs[i].wrote_file === true).map((u) => u.file);

  const gapIds = [...new Set(revs.flatMap((r) => slugs(r.gap_ids)))];
  // Blocking outranks caveat: a slug one reviewer blocks on must still drive the next round.
  const roundCaveats = [...new Set(revs.flatMap((r) => slugs(r.caveat_ids)))].filter((id) => !gapIds.includes(id));
  for (const id of roundCaveats) caveatIds.add(id);
  caveatFiles.push(...units
    .filter((u, i) => revs[i].wrote_file === true && slugs(revs[i].caveat_ids).some((id) => roundCaveats.includes(id)))
    .map((u) => u.file));
  const repeatedIds = gapIds.filter((id) => gapFirstRound.has(id));
  for (const id of gapIds) {
    if (gapFirstRound.has(id)) continue;
    gapFirstRound.set(id, round);
    gapFirstFile.set(id, units[revs.findIndex((r) => slugs(r.gap_ids).includes(id))].file);
  }
  gapRounds.push({ round, gaps: gapIds.length, new: gapIds.length - repeatedIds.length, repeated: repeatedIds.length, caveats: roundCaveats.length });
  lastGapIds = gapIds;
  const split = gapIds.length ? ` — ${gapIds.length - repeatedIds.length} new, ${repeatedIds.length} repeated` : '';

  if (revs.some((r) => r.needs_user === true)) {
    haltKind = 'needs-user'; haltReason = `A reviewer surfaced a requirement contradiction only the user can resolve in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: reviewer escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  if (revs.every((r) => r.agree === true)) {
    agreed = true;
    // Flagged, not halted: the decision is the run's last step, so the contradiction cannot compound.
    contradictedFiles = units.filter((u, i) => slugs(revs[i].gap_ids).length > 0).map((u) => u.file);
    if (contradictedFiles.length) {
      log(`  ⚠ r${round}: reviewers AGREE but list ${gapIds.length} blocking gap(s) — self-contradictory; audit ${contradictedFiles.join(', ')}`);
    }
    if (!lastMeetsAll) log(`  ⚠ r${round}: reviewers AGREE but the decider reported meets_all_requirements=false — audit ${decisionFile(round)}`);
    log(`  ✓ r${round}: reviewers AGREE — no blocking gap (${roundCaveats.length} caveat(s) this round)`);
    break;
  }
  reviewPaths = lastReviewFiles;
  if (round >= MAX_ROUNDS) { log(`  ⚠ r${round}: ${gapIds.length} blocking gap(s)${split} still open at round budget (see ${reviewPaths.join(', ')})`); break; }
  log(`  ↻ r${round}: ${gapIds.length} blocking gap(s)${split}, ${roundCaveats.length} caveat(s) → decider revises`);
}

const halted = haltKind !== '';
const status = haltKind === 'write-unattested' ? 'BLOCKED (an agent did not confirm writing its file)'
  : halted ? 'BLOCKED (needs user input)'
  : agreed && caveatIds.size ? 'decided with caveats (no blocking gap, and the reviews list caveats for the plan)'
  : agreed ? 'decided (decider + reviewers agree)'
  : 'needs-attention (no agreement within round budget)';
log(`decide: ${status} after ${round} round(s)`);

// WHY there was no agreement, read off the last review's slugs. Mostly REPEATS: the decider is not
// resolving objections it has already been handed, so another round against the same rubric buys the
// same review again. Mostly NEW: either the folds open new defects or the rubric is not settling what
// "best" means, and the final review's WHERE NEXT says which. Opposite fixes, so naming the wrong one
// costs a whole re-run. Empty when the last review raised no slugs, or ran in round 1 where the decider
// never had a round to address a gap: no evidence, no diagnosis.
const finalGaps  = gapRounds.length ? gapRounds[gapRounds.length - 1] : null;
const repeatsOut = lastGapIds.filter((id) => (gapFirstRound.get(id) ?? round) < round);
const churn = !finalGaps || !finalGaps.gaps || finalGaps.round < 2
  ? ''
  : finalGaps.repeated > finalGaps.new
    ? `The final review re-raised ${finalGaps.repeated} blocking gap(s) an earlier round already put to the decider (${repeatsOut.map((id) => `${id}, first raised in ${gapFirstFile.get(id)}`).join('; ')}) — the decider is not RESOLVING them, so another round against the same rubric will not either. `
    : `The final review raised ${finalGaps.new} blocking gap(s) no earlier round did, so every round finds fresh ground. Either the folds open new defects or the question is UNDER-SPECIFIED, and that review's WHERE NEXT section says which. `;

const agreeCaveats = [
  contradictedFiles.length ? `A reviewer agreed while listing blocking gaps: audit ${contradictedFiles.join(', ')} before presenting. ` : '',
  agreed && !lastMeetsAll ? `The decider itself reported that ${RANKED ? 'a shortlisted option' : 'the conclusion'} does not meet every requirement: check ${decisionFile(round)} before presenting. ` : '',
].join('');
const FLIP_NOTES = RANKED
  ? {
    fragile: 'The decider graded rank 1 FRAGILE. Present its flip check, since rank 1 turns on the input it names, and let the user settle it. ',
    dominant: 'Rank 1 is at least as good as rank 2 on every criterion. ',
  }
  : {
    fragile: 'The decider graded the choice FRAGILE. Present its Flip check and Trade-off sections, since the winner turns on the input the Flip check names, and let the user settle it. ',
    dominant: 'The winner dominates the runner-up: the Trade-off section shows nothing given up. ',
  };
const flipNote = FLIP_NOTES[lastFlip] ?? '';
const caveatNote = caveatIds.size
  ? `Carry the ${caveatIds.size} caveat(s) under "## Caveats" in ${caveatFiles.join(', ')} into the plan's design section. The reviewers judged that none changes the choice, but each is a gap the plan must close, so refine the plan before building. `
  : '';
// A halt's relaunch already redoes every lens and leaves no decision to relay, so it gets the short form.
const droppedLenses = !failedLensIds.length
  ? ''
  : ` These lenses did not confirm a lens file and were left out of the decision: ${failedLensIds.join(', ')}.` + (halted
    ? ' The relaunch with the same args redoes them.'
    : ' The engine cannot re-run single lenses. Bringing them in takes a full relaunch with the full lens list and no resumeFromRunId, which redoes every lens and round. Relay this run\'s decision first, then relaunch under a new runId so this run\'s files stay intact.');
const relaunchFromStart = 'The relaunch re-runs the run from the lens analyses and round 1 and overwrites the round files.';

return {
  runId: RUN_ID,
  status,
  agreed,
  halted,
  selection: SELECTION,
  chosen: lastChosen,
  ...(RANKED ? { shortlist: lastShortlist } : {}),
  flip: lastFlip,
  rounds: round,
  gapRounds,
  caveats: caveatIds.size,
  stateDir: STATE_DIR,
  haltReason: halted ? haltReason : '',
  decisionFile: lastDecisionFile,
  reviewFiles: lastReviewFiles,
  caveatFiles,
  needsUserFile: haltKind === 'needs-user' ? NEEDS_USER : '',
  lensFiles: LIVE.map((l) => lensFile(l.id)),
  failed: failedLensIds.map((id) => ({ id, stage: 'diverge' })),
  lensPicks: LIVE.map((l) => ({ lens: l.id, focus: l.focus, top: ready.find((a) => a.lens === l.id)?.top || '' })),
  contradicted: contradictedFiles.length > 0,
  meetsAllRequirements: lastMeetsAll,
  reviewTrail: `Lens analyses in ${LENS_DIR}/, and decision-rN.md / decision-review-rN*.md in ${STATE_DIR}/ show every round.`,
  nextStep: (halted
    ? (haltKind === 'needs-user'
      ? `Run halted — ${haltReason} Read ${NEEDS_USER}, resolve it with the user, then relaunch with the same args and no resumeFromRunId. ${relaunchFromStart}`
      : `Run halted — ${haltReason} Check that file, then relaunch with the same args and no resumeFromRunId: a resume replays the cached return and halts the same way. ${relaunchFromStart}`)
    : (agreed
      ? agreeCaveats + flipNote + caveatNote + (RANKED
        ? `Present the SHORTLIST the decider and reviewers agreed on in round ${round}: relay ${decisionFile(round)} (the matrix + the ranked options with what each buys/costs + the combine-vs-exclusive section + the flip check) and let the user read each lens file in ${LENS_DIR}/ to see the source perspectives. There is deliberately NO single winner — the user picks, or combines the options marked as composable. To build what they pick, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle (several picks become several blocks of one plan file).`
        : `Present the conclusion the decider and reviewers agreed on in round ${round}: relay ${decisionFile(round)} (the matrix + rationale + why-not-others + trade-off + flip check) and let the user read each lens file in ${LENS_DIR}/ to see the source perspectives. To build the chosen approach, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.`)
      : `No agreement within ${MAX_ROUNDS} rounds. ${churn}Read the latest ${decisionFile(round)} + ${lastReviewFiles.join(', ')} with the user, starting with the WHERE NEXT section of each review that did not agree, which says whether the folds open new defects or names the one requirement change that would let a decision converge. Refine the requirements, then relaunch with the same args and no resumeFromRunId: the relaunch re-runs the run from the lens analyses and round 1 and overwrites the round files, while a resume would replay the cached returns and never read the edit. Or raise maxRounds and relaunch with the same args plus the Workflow tool's resumeFromRunId: the finished rounds replay from cache and the loop continues past round ${round}.`)) + droppedLenses,
};
