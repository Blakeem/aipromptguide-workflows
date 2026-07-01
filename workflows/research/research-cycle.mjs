export const meta = {
  name: 'research-cycle',
  description: 'Multi-source research, lean/file-bus design: fan out ONE gatherer per angle (web / repo / external API / docs) that writes a cited findings file, ADVERSARIALLY verify each load-bearing claim by trying to refute it, then synthesize the verified findings into one cited deliverable (a report, an external-API/feature spec, or a knowns/unknowns assessment). The harness only routes paths + verdicts; every claim and citation lives in files.',
  whenToUse: 'Answer a question that needs gathering + cross-checking across several sources, then a synthesized, cited output. The main agent frames the question + the ANGLES (each a source to mine: a web search theme, a repo area, an external API/SDK, a doc set) with the user, then runs this engine. outputKind selects the deliverable: "report" (default), "spec" (document an external API or an internal feature contract — replaces the old spec-external/spec-feature), or "assessment" (knowns/unknowns/consequences — the planning-style pre-action pass). To DECIDE among options use decide-cycle; to BUILD use feature-cycle (a research spec is a great input to its plan).',
  phases: [
    { title: 'Gather', detail: 'One gatherer per angle (CONCURRENT, pipelined into Verify). Each mines its source, writes runs/<runId>/findings/<angle>.md with claims, citations, and a confidence per claim. Returns thin counts.' },
    { title: 'Verify', detail: 'An independent verifier per angle tries to REFUTE each load-bearing claim against the cited sources, writing runs/<runId>/verify/<angle>.md (confirmed / refuted / uncertain per claim). The #5-spirit independent check before trust.' },
    { title: 'Synthesize', detail: 'After all angles are verified, one synthesizer reads the findings + verdicts and writes the cited deliverable (REPORT/SPEC/ASSESSMENT.md) — verified claims only, refuted ones excluded, uncertainties flagged, open questions listed.' },
  ],
};

// =============================================================================
// Config — everything question-specific arrives via args so the engine stays general.
// Research is read-only w.r.t. any target repo and the web: it writes ONLY into the run-state dir
// (findings/, verify/, the deliverable) and never modifies, stages, or commits anything. The verify
// stage is the independent-check-before-trust pass (spirit of WORKFLOW-PRINCIPLES.md #5). The main
// agent frames the question + angles with the user BEFOREHAND (#4) — no setup/loader agent.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, angles, question|planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL (for repo angles)
const KIND        = (A.outputKind ?? 'report');            // 'report' | 'spec' | 'assessment'
const AUDIENCE    = A.audience ?? '';                      // optional: who the deliverable is for / how it'll be used

// Per-role model tiers + OPTIONAL custom subagent types. Gatherer + verifier are the fast tier;
// synthesizer is opus (it integrates everything and writes the deliverable).
const M  = { gather: 'sonnet', verify: 'sonnet', synthesize: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const FIND_DIR    = `${STATE_DIR}/findings`;
const VER_DIR     = `${STATE_DIR}/verify`;
const findingsFile = (id) => `${FIND_DIR}/${id}.md`;
const verifyFile   = (id) => `${VER_DIR}/${id}.md`;
const DELIVERABLE  = `${STATE_DIR}/${KIND === 'spec' ? 'SPEC' : KIND === 'assessment' ? 'ASSESSMENT' : 'REPORT'}.md`;

// The question / framing: a single source of truth (#11), read verbatim (#2) by every agent. Either a
// plan-mode file (planPath) or an inline string.
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const QUESTION    = (!PLAN_PATH && A.question) ? String(A.question) : '';
if (!PLAN_PATH && !QUESTION) {
  throw new Error('Provide the research question: either planPath (a framing/scope file) or question (an inline string of what to find out and why).');
}
const Q_REF       = PLAN_PATH ? `the research brief at ${PLAN_PATH} (read it verbatim — the scope + what "done" means)` : `the research question below:\n-----\n${QUESTION}\n-----`;

// Angles — the sources to mine, one gatherer+verifier each. Accept strings (treated as web themes) or
// { id, source, focus }. source ∈ web | repo | api | docs.
const ANGLES = (Array.isArray(A.angles) ? A.angles : []).map((a, i) => {
  if (typeof a === 'string') return { id: slug(a) || `angle-${i + 1}`, source: 'web', focus: a };
  const focus = a.focus || a.id || '';
  return { id: slug(a.id || focus) || `angle-${i + 1}`, source: (a.source || 'web'), focus };
}).filter((a) => a.focus);
if (!ANGLES.length) {
  throw new Error('args.angles is required: a non-empty array of sources to mine — strings (web themes) or { id, source: "web"|"repo"|"api"|"docs", focus }. The main agent frames these with the user beforehand (#4).');
}

// Per-source how-to-mine guidance handed to the gatherer (the only thing that varies by source).
const SOURCE_GUIDE = {
  web:  'Use web search + fetch the most authoritative pages (official docs/standards/primary sources over blogs/forums). Record the URL + retrieval date for every claim.',
  repo: `Read the codebase at ${REPO || '(no repo configured — this angle needs target.repo)'}: grep + read the relevant files. Cite file:line for every claim. Do NOT modify anything.`,
  api:  'Document the external API/SDK from its OFFICIAL docs/reference/RFCs matching the runtime version in scope: auth, endpoints/methods, request/response shapes, error semantics, rate limits, version gates. Cite the doc URL + version for every claim.',
  docs: 'Read the supplied document set / knowledge base; cite the document + section for every claim.',
};

// =============================================================================
// outputKind → synthesizer template (the deliverable's shape). Content lives in the file (#8).
// =============================================================================
const DELIVERABLE_SHAPE = {
  report: `A research REPORT: an executive summary answering the question, then sections per sub-finding,
each claim with its citation and a confidence marker, a "what's uncertain / disputed" section, and an
"open questions" list. Lead with the answer.`,
  spec: `A SPEC document the way an implementer needs it: overview/purpose; the contract (for an external
API: auth, endpoints/methods, request/response shapes WITH examples, error semantics, rate limits,
version compatibility — for an internal feature: behaviour, signatures, request/response examples, edge
cases, perf/security notes); then ACCEPTANCE CRITERIA (observable, testable statements of conformance,
happy + edge cases). Every contract claim carries its source citation.`,
  assessment: `An ASSESSMENT (pre-action, knowns/unknowns): Certainties (what we know, with evidence);
Uncertainties (what we don't, and what would resolve each); Consequence map (immediate effects,
secondary effects, what cannot be predicted); a Recommendation calibrated to the confidence available.`,
};

// =============================================================================
// Schemas — DECISIONS/COUNTS ONLY (control plane). Claims + citations live in files (#8).
// =============================================================================
const GATHER_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'claim_count'],
  properties: {
    wrote_file:    { type: 'boolean' },
    claim_count:   { type: 'integer', description: 'distinct claims recorded in the findings file' },
    source_count:  { type: 'integer', description: 'distinct sources cited' },
    low_confidence:{ type: 'integer', description: 'claims you marked low-confidence / needs-verification (0 if none)' },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'confirmed', 'refuted', 'uncertain'],
  properties: {
    wrote_file: { type: 'boolean' },
    confirmed:  { type: 'integer', description: 'load-bearing claims you could NOT refute (hold up against the sources)' },
    refuted:    { type: 'integer', description: 'claims you found to be wrong / unsupported by the cited source' },
    uncertain:  { type: 'integer', description: 'claims you could neither confirm nor refute' },
  },
};

const SYNTH_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'open_questions'],
  properties: {
    wrote_file:     { type: 'boolean' },
    sections:       { type: 'integer', description: 'top-level sections written' },
    open_questions: { type: 'integer', description: 'unresolved questions listed in the deliverable' },
    confidence:     { type: 'string', enum: ['high', 'medium', 'low'], description: 'overall confidence in the answer given the verified evidence' },
  },
};

// =============================================================================
// Shared fragment + role prompts
// =============================================================================
const ENV = `RESEARCH BRIEF: ${Q_REF}
${AUDIENCE ? `AUDIENCE / USE: ${AUDIENCE}\n` : ''}CITE EVERYTHING: every claim needs a concrete source (URL + date, or file:line, or doc#section). A claim
without a source is a hypothesis — mark it as such. Prefer primary/authoritative sources; note version.
Do NOT modify any repo or file outside your output; do NOT stage or commit.`;

const gatherPrompt = (angle) => `
You are a RESEARCHER mining ONE source for the brief. Gather thoroughly but stay on YOUR angle; other
researchers cover the others.
${ENV}
YOUR ANGLE: ${angle.focus}
SOURCE TYPE: ${angle.source} — ${SOURCE_GUIDE[angle.source] || SOURCE_GUIDE.web}

PROCEDURE:
1. Mine your source for everything relevant to the brief on this angle. Follow authoritative leads; don't
   stop at the first hit.
2. For EACH claim, record: the claim, its source citation, and a confidence (high/medium/low). Separate
   established fact from inference. Capture specifics (numbers, signatures, limits, version gates), not
   vague summaries.
WRITE ${findingsFile(angle.id)} (create ${FIND_DIR}/ if needed): your claims with citations + confidence,
grouped sensibly. Be concrete and terse; don't pad. Return wrote_file + claim_count + source_count +
low_confidence via the schema (the findings themselves are the file).`;

const verifyPrompt = (angle) => `
You are an ADVERSARIAL VERIFIER. For each LOAD-BEARING claim in the findings file, TRY TO REFUTE it: go
to the cited source (and a corroborating one where you can) and check it actually says what's claimed,
at the version in scope. Default to "uncertain" when you can't confirm — do not wave claims through.
${ENV}
YOUR ANGLE: ${angle.focus}
FINDINGS TO VERIFY (read verbatim): ${findingsFile(angle.id)}
SOURCE TYPE: ${angle.source} — ${SOURCE_GUIDE[angle.source] || SOURCE_GUIDE.web}

For each load-bearing claim, mark: CONFIRMED (source supports it), REFUTED (source contradicts it or
doesn't support it — give the correction), or UNCERTAIN (couldn't verify — say what's missing). Skip
trivial/obvious claims; focus on the ones the conclusion will rest on.
WRITE ${verifyFile(angle.id)} (create ${VER_DIR}/ if needed): one line per checked claim with its verdict
+ the evidence (the source quote/location, or the contradiction). Return confirmed + refuted + uncertain
counts + wrote_file via the schema. Do NOT edit the findings file.`;

const synthesizePrompt = (angleList) => `
You are the SYNTHESIZER. Produce the final deliverable from the VERIFIED research — verified claims only.
${ENV}
DELIVERABLE: ${DELIVERABLE_SHAPE[KIND] || DELIVERABLE_SHAPE.report}

INPUTS — read each findings file together with its verify file, and trust the VERIFY verdict over the raw
finding:
${angleList.map((a) => `  - findings: ${findingsFile(a.id)}   verdict: ${verifyFile(a.id)}`).join('\n')}

PROCEDURE:
1. Use CONFIRMED claims as the backbone. EXCLUDE refuted claims (or state the correction). Flag UNCERTAIN
   claims explicitly as unverified — never present them as settled.
2. Reconcile disagreements across angles; where sources genuinely conflict, say so rather than papering
   over it. Carry every citation through.
3. Answer the brief directly; don't bury the answer. List what remains open.
WRITE the deliverable to ${DELIVERABLE} (create ${STATE_DIR}/ if needed) in the shape above. Return
wrote_file + sections + open_questions + overall confidence via the schema. Do NOT modify any repo,
stage, or commit.`;

// =============================================================================
// GATHER → VERIFY — one pipeline per angle (no barrier; each angle verifies as soon as it's gathered).
// =============================================================================
phase('Gather');
log(`research: ${ANGLES.length} angle(s) [${ANGLES.map((a) => a.source).join(', ')}] → ${KIND.toUpperCase()} at ${DELIVERABLE}`);
if (ANGLES.some((a) => a.source === 'repo') && !REPO) log(`  ⚠ a "repo" angle was given but no target.repo — that gatherer has nothing to read.`);

const verified = await pipeline(
  ANGLES,
  // -- Gather -----------------------------------------------------------------
  (angle) => agent(gatherPrompt(angle), roleOpts('gather', {
    schema: GATHER_SCHEMA, phase: 'Gather', label: `gather:${angle.id}`,
  })).then((g) => {
    log(`  ✓ gathered ${angle.id}: ${g?.claim_count ?? 0} claim(s), ${g?.source_count ?? 0} source(s)${g?.low_confidence ? `, ${g.low_confidence} low-confidence` : ''}`);
    return { angle, gather: g };
  }),
  // -- Verify (adversarial) — read the item from stage 1's return (no reliance on a 2nd stage arg) --
  (prev) => agent(verifyPrompt(prev.angle), roleOpts('verify', {
    schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${prev.angle.id}`,
  })).then((v) => {
    log(`  ✓ verified ${prev.angle.id}: ${v?.confirmed ?? 0} confirmed, ${v?.refuted ?? 0} refuted, ${v?.uncertain ?? 0} uncertain`);
    return { angle: prev.angle, gather: prev.gather, verify: v };
  }),
);

// Drop angles whose gather wrote no findings file — a silently-failed gather shouldn't dilute synthesis.
const done = verified.filter(Boolean).filter((d) => d.angle && d.gather?.wrote_file === true);
if (!done.length) throw new Error('No angle produced verified findings — nothing to synthesize. Check the angles/brief (and web access for web/api angles) and re-run.');
const dropped = ANGLES.length - done.length;
if (dropped > 0) log(`  ⚠ ${dropped} angle(s) produced no findings — excluded from synthesis`);
const totals = done.reduce((t, d) => ({
  confirmed: t.confirmed + (d.verify?.confirmed ?? 0),
  refuted:   t.refuted + (d.verify?.refuted ?? 0),
  uncertain: t.uncertain + (d.verify?.uncertain ?? 0),
}), { confirmed: 0, refuted: 0, uncertain: 0 });

// =============================================================================
// SYNTHESIZE — barrier (needs ALL verified angles), one deliverable.
// =============================================================================
phase('Synthesize');
const synth = await agent(synthesizePrompt(done.map((d) => d.angle)), roleOpts('synthesize', {
  schema: SYNTH_SCHEMA, phase: 'Synthesize', label: `synthesize:${KIND}`,
}));
log(`research: ${KIND.toUpperCase()} written — ${synth?.sections ?? '?'} section(s), confidence=${synth?.confidence ?? '?'}, ${synth?.open_questions ?? 0} open question(s)`);

return {
  phase: 'research',
  runId: RUN_ID,
  outputKind: KIND,
  deliverable: DELIVERABLE,
  anglesResearched: done.length,
  evidence: totals,
  confidence: synth?.confidence ?? '',
  openQuestions: synth?.open_questions ?? 0,
  stateDir: STATE_DIR,
  trail: `Per-angle findings in ${FIND_DIR}/ and verification verdicts in ${VER_DIR}/.`,
  nextStep: `Present the ${KIND}: read ${DELIVERABLE} and relay the answer + confidence + open questions; the per-angle findings (${FIND_DIR}/) and verify verdicts (${VER_DIR}/) are the audit trail. ${totals.refuted ? `${totals.refuted} claim(s) were refuted in verification — make sure none resurface. ` : ''}The deliverable lives in gitignored run-state; copy it into the repo/docs yourself if you want to keep it. ${KIND === 'spec' ? 'This spec is a strong input to a feature-cycle plan.' : KIND === 'assessment' ? 'Use it to decide whether/how to proceed.' : ''}`,
};
