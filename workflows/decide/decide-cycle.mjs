export const meta = {
  name: 'decide-cycle',
  description: 'Convergent decision, lean/file-bus design: fan out ONE analyst per lens (each finds + scores the best option through its lens, written to its own file), then a DECIDER funnels them into one conclusion via a global weighted decision matrix that pulls in the best of each, and a NON-BLIND adversarial reviewer checks that conclusion against the fixed requirements — looped until decider and reviewer agree. The harness only routes paths + verdicts; rich content lives in files.',
  whenToUse: 'Have the AI reach a JUSTIFIED conclusion among approaches, weighing real trade-offs. The main agent authors the REQUIREMENTS (non-negotiable constraints + weighted criteria — the rubric both the decider and reviewer judge against) in PLAN MODE, approves them with the user, picks the LENSES (e.g. efficiency, simplest, robustness, best-practice), then runs this engine. It diverges into lensed option-generation, then converges via decider ⇄ review loop. To explore open-ended creative variations for a HUMAN to pick (no AI verdict) use brainstorm-cycle; to BUILD the chosen approach use feature-cycle.',
  phases: [
    { title: 'Diverge', detail: 'One analyst per lens (CONCURRENT). Each reads the requirements (verbatim) + its lens, generates 2–4 options, scores them under its lens, recommends one, and writes lenses/<lens>.md. Returns a thin index.' },
    { title: 'Decide', detail: 'The decider reads the requirements + every lens file (+ the latest review), combines the best elements, builds a GLOBAL weighted decision matrix enforcing the non-negotiables — every cell citing its lens evidence or marked own-judgment — picks the winner, and writes decision-rN.md. Returns the choice + a meets-all-requirements flag.' },
    { title: 'Review', detail: 'A NON-BLIND adversarial reviewer reads the decision + requirements + lens files, checks every requirement is met and the matrix is sound (each citation verified against its lens file, no unsupported leap, no better option overlooked), and writes decision-review-rN.md. Agreement ends the loop; gaps drive another Decide round.' },
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
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, lenses, requirements|planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL read-only context
const CONTEXT     = A.context ?? '';                       // short extra framing (domain facts the agents won't know)
const MAX_ROUNDS  = A.maxRounds ?? 3;                       // decider ⇄ reviewer rounds before "needs-attention"

// Per-role model tiers + OPTIONAL custom subagent types. Decider + reviewer are opus (high stakes);
// the per-lens analysts are the fast tier by default.
const M  = { analyst: 'sonnet', decide: 'opus', review: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const LENS_DIR    = `${STATE_DIR}/lenses`;
const lensFile    = (id) => `${LENS_DIR}/${id}.md`;
const decisionFile       = (r) => `${STATE_DIR}/decision-r${r}.md`;
const decisionReviewFile = (r) => `${STATE_DIR}/decision-review-r${r}.md`;
const NEEDS_USER  = `${STATE_DIR}/NEEDS-USER.md`;          // user-only escalations (may halt the run)

// Requirements: the FIXED rubric — non-negotiable constraints + weighted criteria — read verbatim
// (#2/#11) by the analysts, the decider, AND the reviewer. The single source of truth that makes the
// loop converge. Either a plan-mode file (planPath) or an inline string.
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const REQ         = (!PLAN_PATH && A.requirements) ? String(A.requirements) : '';
if (!PLAN_PATH && !REQ) {
  throw new Error('Provide the requirements (the rubric both the decider and reviewer judge against): either planPath (a plan-mode file) or requirements (an inline string with the non-negotiable constraints + weighted criteria + the decision to be made).');
}
const REQ_REF     = PLAN_PATH ? `the requirements at ${PLAN_PATH} (read them verbatim — they are the fixed rubric)` : `the requirements below:\n-----\n${REQ}\n-----`;

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
  required: ['chosen', 'meets_all_requirements', 'needs_user'],
  properties: {
    chosen:                 { type: 'string', description: 'short title of the chosen conclusion (may be a hybrid pulling the best of several lenses)' },
    meets_all_requirements: { type: 'boolean', description: 'true if the conclusion satisfies every non-negotiable + criterion in the requirements (your own honest assessment)' },
    open_questions:         { type: 'integer', description: 'count of unresolved points you noted in the decision file (0 if none)' },
    needs_user:             { type: 'boolean', description: 'true ONLY if a genuine choice/contradiction only the USER can resolve blocks you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['agree', 'gap_count', 'needs_user'],
  properties: {
    agree:      { type: 'boolean', description: 'true ONLY if the conclusion meets EVERY requirement and the decision matrix is sound — no unsupported leap, no clearly-better option overlooked, no non-negotiable violated' },
    gap_count:  { type: 'integer', description: 'number of gaps/objections written to the review file (0 when you agree)' },
    needs_user: { type: 'boolean', description: 'true ONLY if you found a requirement contradiction only the USER can resolve; you wrote it to NEEDS-USER.md' },
  },
};

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `THE DECISION + RUBRIC: ${REQ_REF}
${REPO ? `CODEBASE (read-only context — pattern-fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}NON-NEGOTIABLES are pass/fail: an option that violates one scores 0 on that axis and cannot win, no
matter how strong elsewhere. Prefer the SIMPLEST option that meets all requirements; if a more complex
option wins, the matrix must justify why the simpler one is inadequate.`;

// =============================================================================
// Role prompts
// =============================================================================
const analystPrompt = (lens) => `
You are an ANALYST evaluating the decision THROUGH ONE LENS. Find the best answer your lens can offer —
push that perspective hard; the decider will balance lenses later, so do NOT pre-compromise.
${ENV}
YOUR LENS: ${lens.focus}

PROCEDURE:
1. Generate 2–4 DISTINCT options that address the decision (include a simple baseline among them).
2. Score each option 0–10 FROM YOUR LENS (a non-negotiable violation = 0). State the reasoning per score.
3. Recommend the one option your lens favours, and call out which ELEMENTS of it are worth keeping even
   if another option ultimately wins (so the decider can build a hybrid).
WRITE ${lensFile(lens.id)} (create ${LENS_DIR}/ if needed): for each option a short block — title,
description, your 0–10 lens score + why, and (for your pick) the keep-worthy elements. Be concrete and
terse. Do NOT modify any repo, stage, or commit.
Return wrote_file + top_pick via the schema (the analysis itself is the file).`;

const decidePrompt = (round, reviewPath) => `
You are the DECIDER. Converge the lensed analyses into ONE justified conclusion via a global weighted
decision matrix that pulls in the best elements of each lens where they compose.
${ENV}
LENS ANALYSES — read each VERBATIM (these are your inputs):
${LIVE.map((l) => `  - ${lensFile(l.id)}  (lens: ${l.focus})`).join('\n')}
${round === 1
    ? `This is round 1.`
    : `The reviewer did NOT yet agree — READ ${reviewPath} and resolve every gap/objection it raises.
Your prior decision is at ${decisionFile(round - 1)}; revise it, do not start over unless a gap is fundamental.`}

PROCEDURE:
1. Consolidate the options across all lens files; dedupe near-identical ones. You MAY construct a hybrid
   that combines the best elements of several — but only where they genuinely compose (no Frankenstein).
2. Choose the weighted CRITERIA from the requirements (and their weights). Build a decision matrix:
   each candidate option (incl. any hybrid) scored 0–10 per weighted criterion, non-negotiable
   violations forced to 0, weighted total computed. The highest defensible total wins.
   GROUND every cell (#14): cite the lens evidence behind the score (lens + the specific claim); where
   none exists (a legitimate cross-lens synthesis), mark it "own judgment, low-confidence" — never
   fabricate a citation.
3. State the WINNER, WHY it wins, and explicitly WHY NOT each runner-up (the disqualifying trade-offs).
   Confirm it satisfies every non-negotiable and criterion; note any residual risk or follow-up.
WRITE ${decisionFile(round)} (create ${STATE_DIR}/ if needed): the matrix (table), the chosen conclusion
with its rationale, the why-not-others, and any open questions. Do NOT modify any repo, stage, or commit.
If a genuine contradiction in the requirements (or a choice only the user can make) blocks you, append a
full entry to ${NEEDS_USER} and set needs_user=true (the run HALTS).
Return chosen + meets_all_requirements + open_questions + needs_user via the schema.`;

// NON-BLIND on purpose (#3 guards code-regression anchoring, not argument evaluation): the reviewer
// MUST see the decision + requirements to judge them. It does NOT read prior review files (that would
// anchor it) — it re-checks the CURRENT decision fresh against the fixed rubric. Freshness here is
// instruction-based, not placement-based (#3): prior reviews share STATE_DIR, an accepted trade-off
// vs. per-round directories.
const reviewPrompt = (round) => `
You are an ADVERSARIAL DECISION REVIEWER. Try to BREAK the conclusion: find any requirement it misses,
any unsupported leap in the matrix, any clearly-better option it overlooked, any non-negotiable it
violates. Agreement (agree=true) is only warranted when you genuinely cannot.
${ENV}
THE DECISION TO REVIEW (read it verbatim): ${decisionFile(round)}
THE LENS ANALYSES it drew on (cross-check its claims against these): ${LIVE.map((l) => lensFile(l.id)).join(', ')}
Do NOT read earlier decision-review files — judge THIS decision fresh against the requirements.

CHECK, against the requirements rubric:
1. Every non-negotiable satisfied? (a single violation ⇒ NOT agree.)
2. Every weighted criterion actually addressed, and every matrix cell's citation VERIFIED (#14): the
   cited lens claim exists and actually supports that score — spot-read the lens files. Cells marked
   "own judgment, low-confidence" are legitimate; a stretched/fabricated citation or an unmarked
   assertion is a gap. Re-derive any score that looks generous.
3. A clearly stronger option (or a better hybrid) the decider dismissed or never considered?
4. The "why not others" honest, or does it strawman the runners-up?
WRITE ${decisionReviewFile(round)} (create ${STATE_DIR}/ if needed): each gap/objection with concrete
reference to the requirement or lens evidence it rests on — or, if sound, "Conclusion holds: every
requirement met, matrix sound." Do NOT modify any repo, stage, or commit. If a requirement contradiction
only the user can resolve surfaces, append it to ${NEEDS_USER} and set needs_user=true.
Return agree + gap_count + needs_user via the schema.`;

// =============================================================================
// DIVERGE — fan out one analyst per lens, concurrently (read-only, write own lens file).
// =============================================================================
phase('Diverge');
log(`decide: ${LENSES.length} lens(es) → ${LENS_DIR} [maxRounds=${MAX_ROUNDS}]`);
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
for (const l of LENSES.filter((l) => !LIVE.includes(l))) log(`  ✗ ${l.id}: no lens file (analyst failed/skipped) — dropped from convergence`);

// =============================================================================
// CONVERGE — decider ⇄ non-blind reviewer, until they agree or the round budget is spent.
// =============================================================================
let round = 0, agreed = false, halted = false, haltReason = '';
let reviewPath = '';            // latest review the decider must address (control: a path only)
let lastReviewFile = '';        // latest review written, agreeing or not (surfaced in the return)
let lastChosen = '';

while (round < MAX_ROUNDS) {
  round++;

  // ---- DECIDE --------------------------------------------------------------
  phase('Decide');
  const dec = await agent(decidePrompt(round, reviewPath), roleOpts('decide', {
    schema: DECIDE_SCHEMA, phase: 'Decide', label: `decide r${round}`,
  }));
  if (!dec) throw new Error(`Decider returned nothing in round ${round} (agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  lastChosen = dec.chosen || lastChosen;
  if (dec.needs_user === true) {
    halted = true; haltReason = `Decider escalated a user-only call in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: decider escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  log(`  r${round}: chose "${dec.chosen || '?'}" (meets_all=${dec.meets_all_requirements}, open_q=${dec.open_questions ?? 0})`);

  // ---- REVIEW (non-blind, adversarial) -------------------------------------
  phase('Review');
  const rev = await agent(reviewPrompt(round), roleOpts('review', {
    schema: REVIEW_SCHEMA, phase: 'Review', label: `review r${round}`,
  }));
  if (!rev) throw new Error(`Reviewer returned nothing in round ${round} (agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  lastReviewFile = decisionReviewFile(round);
  if (rev.needs_user === true) {
    halted = true; haltReason = `Reviewer surfaced a requirement contradiction only the user can resolve in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: reviewer escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  if (rev.agree === true) {
    agreed = true;
    log(`  ✓ r${round}: reviewer AGREES — conclusion holds`);
    break;
  }
  reviewPath = decisionReviewFile(round);
  if (round >= MAX_ROUNDS) { log(`  ⚠ r${round}: ${rev.gap_count ?? '?'} gap(s) still open at round budget (see ${reviewPath})`); break; }
  log(`  ↻ r${round}: reviewer found ${rev.gap_count ?? '?'} gap(s) → decider revises (addresses ${reviewPath})`);
}

const status = halted ? 'BLOCKED (needs user input)' : agreed ? 'decided (decider + reviewer agree)' : 'needs-attention (no agreement within round budget)';
log(`decide: ${status} after ${round} round(s)`);

return {
  phase: 'decide',
  runId: RUN_ID,
  status,
  agreed,
  halted,
  chosen: lastChosen,
  rounds: round,
  stateDir: STATE_DIR,
  decisionFile: round ? decisionFile(round) : '',
  reviewFile: lastReviewFile,
  needsUserFile: halted ? NEEDS_USER : '',
  lensFiles: LIVE.map((l) => lensFile(l.id)),
  lensPicks: LIVE.map((l) => ({ lens: l.id, focus: l.focus, top: ready.find((a) => a.lens === l.id)?.top || '' })),
  reviewTrail: `Lens analyses in ${LENS_DIR}/, and decision-rN.md / decision-review-rN.md in ${STATE_DIR}/ show every round.`,
  nextStep: halted
    ? `Run halted — ${haltReason} Read ${NEEDS_USER}, resolve it with the user, then re-invoke with the same runId to continue.`
    : agreed
      ? `Present the conclusion: relay ${decisionFile(round)} (the matrix + rationale + why-not-others) and let the user read each lens file in ${LENS_DIR}/ to see the source perspectives. To build the chosen approach, hand it to feature-cycle.`
      : `No agreement within ${MAX_ROUNDS} rounds. Read the latest ${decisionFile(round)} + ${decisionReviewFile(round)} with the user — the gap is usually an under-specified requirement; refine the requirements and re-run, or raise maxRounds.`,
};
