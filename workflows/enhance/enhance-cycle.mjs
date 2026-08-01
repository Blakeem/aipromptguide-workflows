export const meta = {
  name: 'enhance-cycle',
  description: 'Read-only ENHANCEMENT audit of an existing system, lean/file-bus design. Fans out ONE finder per lens across the whole scope (breadth, not slices — cross-cutting enhancements are the point), then a verifier per lens that confirms each candidate against the real code, kills anything the system ALREADY does, scores impact x effort, and writes one verbatim proposals/<lens>.md, then STOPS. Enhancements only: a defect belongs in the debug workflow, and NOTHING here is auto-applied — there is deliberately no resolve sibling. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Audit a system you already have for ENHANCEMENTS — bigger changes worth writing up, not nits: make it more efficient, simpler, cheaper, more robust, less work to operate, or smaller (removing a role/file/arg/code path is a first-class enhancement). The main agent settles the scope + the lenses with the user, then runs this engine. Each lens gets the whole scope and returns a verified, impact-scored, human-triage-ready proposal file. It then STOPS: YOU triage, and adopted proposals go to feature-cycle (as plans[]) or migrate-cycle. NOT for defects/bugs/typos — those are the debug workflow, whose inventory feeds an autonomous fixer. NOT for open-ended creative variations (brainstorm-cycle) or for concluding among competing approaches (decide-cycle).',
  phases: [
    { title: 'Find', detail: 'One finder per lens (CONCURRENT), each reading the WHOLE scope through its lens. Grounded candidates only: what the system does today (file:line) -> what it would do instead -> the concrete cost that removes. A lens that finds nothing writes its own clean proposals/<lens>.md marker.' },
    { title: 'Verify', detail: 'Spawned ONLY for lenses with candidates: re-checks each against the real code, REJECTS anything the system already does / any unsubstantiated benefit / any nit / anything that is really a defect, scores impact x effort, routes ADOPT | ROADMAP | NEEDS_USER | REJECT, and WRITES proposals/<lens>.md verbatim.' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
//
// WHY THIS IS NOT THE DEBUG WORKFLOW. debug/review.mjs hunts DEFECTS and its inventory feeds
// resolve-cycle's autonomous fixer. Enhancements must never enter that path: they would be auto-applied
// behind a two-round gate (the exact scope creep debug exists to prevent), and an enhancement list does
// not converge the way a closed defect inventory does — there is always another enhancement. So this
// engine writes to proposals/ (never issues/), has NO resolve sibling, and STOPS at the inventory. A
// human triages; adopted items become feature-cycle plans[] or a migrate goal.
//
// ENHANCEMENT, not improvement. The floor is deliberately high: a typo or a nit IS an improvement but
// nobody would write it up as an enhancement — and debug catches it anyway. Ask "would this be worth an
// enhancement ticket?"; if not, it is below the floor. REMOVAL counts: deleting a role, a file, an arg,
// or a code path is a first-class enhancement when it makes the system simpler, cheaper, or more
// reliable.
//
// Fan-out is by LENS over the WHOLE scope, not by file-slice (that is debug's axis, right for local
// defects). Enhancements are frequently cross-cutting — "every engine re-implements this" is invisible
// to a unit-scoped reader. For a corpus too large for one turn, either run per-subsystem with a
// narrower scope or subdivide with args.units (lens x unit).
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
  throw new Error('args must include at least { runId, root, target, scope, lenses }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent).
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                        // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the code)';
const GOALS       = A.goals ?? '';                         // what "better" MEANS for this system (the north star every lens serves)
const CONTEXT     = A.context ?? '';                       // domain facts the agents will not infer

// Impact floor — the "enhancement, not nit" gate. Marginal is below the default floor on purpose.
const IMPACT_RANK = { marginal: 1, moderate: 2, high: 3, transformative: 4 };
const MIN_IMPACT_NAME = A.minImpact ?? 'moderate';
const MIN_IMPACT = IMPACT_RANK[MIN_IMPACT_NAME];
if (!MIN_IMPACT) {
  throw new Error(`args.minImpact must be one of ${Object.keys(IMPACT_RANK).join(' | ')} (got "${MIN_IMPACT_NAME}").`);
}

// Categories the finder must classify into. Overridable per run; a lens may narrow further in prose.
const CATEGORIES = Array.isArray(A.categories) && A.categories.length ? A.categories : [
  'efficiency',      // less time / tokens / compute for the same result
  'simplification',  // same behavior, less machinery
  'removal',         // delete something — a role, file, arg, code path — and the system gets better
  'robustness',      // fewer ways to fail, better failure behavior (NOT a present bug — that is debug)
  'capability',      // a genuinely new capability the system should have
  'operator-effort', // less manual work / fewer steps / less babysitting for the human
  'consistency',     // one way to do a thing instead of N divergent ones
  'observability',   // the operator can see what happened and why
  'cost',            // money, quota, storage
];

// Per-role model tiers + OPTIONAL custom subagent types. Both roles are opus: the finder needs breadth
// and judgment across the whole scope, the verifier is the quality gate that kills the noise.
const AT = { ...(A.agentTypes ?? {}) };
const M  = { find: 'opus', verify: 'opus', ...(A.models ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT      = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm      = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs       = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
// No `?? '.'` default. `abs()` resolves a relative path against ROOT, and ROOT is this TOOL's directory
// — so a default would silently point the audit at the tool instead of the system under audit. Unlike
// the build engines this one is read-only, so it is required only when it is actually load-bearing:
// when a scope path is relative and therefore has to resolve against something (checked below, once
// SCOPE exists). An all-absolute scope needs no repo at all.
const REPO      = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
const PROPOSALS_DIR = `${STATE_DIR}/proposals`;

const slug     = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
// NOT issues/<unit>.md — that path is resolve-cycle's input and nothing here may be auto-applied.
const proposalFile = (lensId) => `${PROPOSALS_DIR}/${fileSafe(lensId)}.md`;
// And deliberately NO shared NEEDS-USER.md. Every lens verifies concurrently, and an agent "append" is a
// read-modify-write, so two of them would silently clobber each other's entries in an unattended run. A
// user-only call belongs in that lens's own proposal file, where its options + recommendation already go.

// Scope — the paths every finder reads. Enhancements are cross-cutting, so a lens sees ALL of it.
const SCOPE = (Array.isArray(A.scope) ? A.scope : (A.scope ? [A.scope] : [])).map(String).filter(Boolean);
if (!SCOPE.length) {
  throw new Error('args.scope is required: the file/dir paths (repo-relative or absolute) every finder reads through its lens. Enhancements are cross-cutting, so each lens sees the WHOLE scope — keep it to what one agent can genuinely read in a turn, and split the run by subsystem if it is larger than that.');
}
// A relative scope path is meaningless without a repo to resolve it against — and guessing would send
// every finder to read the wrong tree and return a confidently wrong proposal list.
const RELATIVE_SCOPE = SCOPE.filter((p) => !/^([a-zA-Z]:)?\//.test(norm(p)));
if (RELATIVE_SCOPE.length && !REPO) {
  throw new Error(`args.target.repo is required when any args.scope path is relative (${RELATIVE_SCOPE.join(', ')}): pass the ABSOLUTE path to the system under audit — the directory holding its .git — since relative scope paths resolve against it. There is no default: args.root is THIS tool's directory, so defaulting would audit the tool. Give every scope path as an absolute path instead if the audit target is not one repo.`);
}

// Lenses — the axes of enhancement. Each becomes ONE finder (+ verifier) → ONE proposal file.
const LENSES = (Array.isArray(A.lenses) ? A.lenses : []).map((l, i) => {
  if (typeof l === 'string') return { id: slug(l) || `lens-${i + 1}`, focus: l, criteria: '' };
  const focus = l.focus || l.id || '';
  return { id: slug(l.id || focus) || `lens-${i + 1}`, focus, criteria: l.criteria || '' };
}).filter((l) => l.focus);
if (!LENSES.length) {
  throw new Error('args.lenses is required: a non-empty array of enhancement axes (strings, or { id, focus, criteria }), e.g. ["efficiency","simplification","operator-effort"]. The main agent picks these with the user beforehand (#4).');
}
const dupes = [...new Set(LENSES.map((l) => l.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`lens ids collide after slugging (${dupes.join(', ')}): two lenses would write the same proposal file — give each a distinct id.`);
}

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose lives in the proposal files.
// =============================================================================
const FIND_SCHEMA = {
  type: 'object',
  required: ['candidates', 'wrote_clean_marker'],
  properties: {
    wrote_clean_marker: { type: 'boolean', description: 'true ONLY if you had ZERO candidates AND wrote the clean-lens marker file; false whenever you report any candidate' },
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'category', 'impact', 'effort', 'today', 'instead', 'cost_removed'],
        properties: {
          title:        { type: 'string', description: 'short, specific, stable' },
          category:     { type: 'string', enum: CATEGORIES },
          impact:       { type: 'string', enum: ['transformative', 'high', 'moderate', 'marginal'] },
          effort:       { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
          files:        { type: 'array', items: { type: 'string' }, description: 'the file(s) this touches, repo-relative, with line numbers where you can give them' },
          today:        { type: 'string', description: 'what the system ACTUALLY DOES today — cite file:line. Not a paraphrase of the design; the current behavior.' },
          instead:      { type: 'string', description: 'what it would do instead — concrete enough to hand to a builder' },
          cost_removed: { type: 'string', description: 'the SPECIFIC cost this removes: tokens, wall-clock, agent count, operator steps, a failure mode, maintenance surface. No cost you can name = not an enhancement.' },
          risk:         { type: 'string', description: 'what this could break or make worse (be honest; "none" is rarely true)' },
        },
      },
    },
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'wrote_file'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true if you wrote the lens proposal file (always required, even when everything was rejected)' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['candidate_id', 'is_real', 'impact', 'effort', 'decision'],
        properties: {
          candidate_id: { type: 'string' },
          is_real:      { type: 'boolean', description: 'false if the system ALREADY does this, the claimed cost does not exist, or you could not substantiate it from the code' },
          impact:       { type: 'string', enum: ['transformative', 'high', 'moderate', 'marginal'], description: 'YOUR confirmed impact (finders over-rate; correct it)' },
          effort:       { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
          decision:     { type: 'string', enum: ['ADOPT', 'ROADMAP', 'NEEDS_USER', 'REJECT'] },
          is_defect:    { type: 'boolean', description: 'true if this is really a BUG in current behavior, not an enhancement — it is out of scope here and belongs in the debug workflow. Always REJECT these, and say so.' },
          rationale:    { type: 'string' },
          options:      { type: 'string', description: 'NEEDS_USER only: the distinct choices + tradeoffs' },
          recommendation: { type: 'string', description: 'NEEDS_USER only: your suggested direction' },
          theme:        { type: 'string', description: 'short grouping keyword so related proposals can be planned together' },
        },
      },
    },
  },
};

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `${REPO ? `TARGET REPO: ${REPO}  ` : 'NO TARGET REPO — every scope path below is absolute.  '}(lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
SCOPE — read THESE, and judge only these (paths are repo-relative unless absolute):
${SCOPE.map((p) => `  - ${p}`).join('\n')}
CONVENTIONS / house rules (an enhancement must fit these, or argue explicitly for changing them):
${CONVENTIONS}
${GOALS ? `WHAT "BETTER" MEANS HERE (the north star every lens serves):\n${GOALS}\n` : ''}${CONTEXT ? `CONTEXT: ${CONTEXT}\n` : ''}
THIS IS AN ENHANCEMENT AUDIT — read this twice:
  • An ENHANCEMENT makes a system that already WORKS work better: faster, cheaper, simpler, smaller,
    more robust, less work to operate, or newly capable.
  • A DEFECT — something the system gets WRONG today, a bug, a typo, an edge case, a destructive
    behavior — is OUT OF SCOPE. A separate defect workflow owns those. If you spot one, do not report
    it here; it will be rejected.
  • REMOVAL IS A FIRST-CLASS ENHANCEMENT. Deleting a role, a file, an argument, a phase, or a code path
    is one of the best outcomes available to you. Look for it deliberately — most audits only add.
  • THE FLOOR IS HIGH. Report ONLY ${MIN_IMPACT_NAME}+ impact. The test: would a competent engineer
    write this up as an enhancement ticket? A nit, a rename, a preference, or a tidy-up would not.
    Below the floor, omit it — it wastes the verify stage and the user's triage time.
BE TOKEN-ECONOMICAL: read the scope properly, but do not restate large files back; act on them.`;

// =============================================================================
// Role prompts
// =============================================================================
const findPrompt = (lens) => `
You are an ENHANCEMENT FINDER examining an EXISTING, WORKING system through ONE lens. This is a
FIND-ONLY pass: you propose, a verifier confirms, and a HUMAN decides — nothing you write is applied
automatically. Do NOT modify any file in the target repo (the ONLY file you may write is the clean-lens
marker described below, in the run-state dir).
${ENV}
YOUR LENS: ${lens.focus}
${lens.criteria ? `WHAT TO WEIGH UNDER THIS LENS: ${lens.criteria}\n` : ''}
Push your lens hard and look across the WHOLE scope — cross-cutting findings ("every engine
re-implements X", "these three roles could be two") are the most valuable thing you can return, and are
invisible to anyone reading one file at a time. Other lenses run in parallel; do not hedge toward them.

RULES:
- GROUND EVERY CANDIDATE IN THE CODE AS IT IS. For each: what the system does TODAY (cite file:line),
  what it would do INSTEAD, and the SPECIFIC cost that removes (tokens, wall-clock, agent count,
  operator steps, a failure mode, maintenance surface). If you cannot name the cost, it is not an
  enhancement — drop it.
- READ BEFORE YOU PROPOSE. The single most common failure of this pass is proposing something the
  system ALREADY DOES. Verify against the current code first; the verifier will reject it otherwise.
- NO VAGUE PROPOSALS. "Consider refactoring", "add more tests", "improve error handling", "make it more
  modular" are not proposals. Name the change.
- NO RESTATING THE DESIGN. Describing back what the system does, however elegantly, is not a finding.
- BE HONEST ABOUT RISK. What could this break or make worse? A proposal with no stated downside reads
  as unexamined.
- Impact is about the SYSTEM's outcome, not how interesting the change is. Effort is about the work to
  land it. Score both honestly — inflated impact is the fastest way to get rejected.
- Aim for QUALITY over count. Five substantiated enhancements beat twenty speculative ones. Returning
  two is a fine outcome; returning zero is a legitimate one.

CLEAN-LENS MARKER: if AND ONLY IF you have ZERO candidates, WRITE the file ${proposalFile(lens.id)}
(create ${PROPOSALS_DIR}/ if needed) with EXACTLY this content, then set wrote_clean_marker=true:
-----
---
lens: ${lens.id}
reviewed: true
---
# Enhancements: ${lens.id}

No enhancements found above the ${MIN_IMPACT_NAME} impact floor.
-----
If you report ANY candidate, write NOTHING (the verifier writes this lens's file) and set
wrote_clean_marker=false.
Return candidates via the schema. An empty array means this lens is clean — a normal, good outcome.`;

const verifyPrompt = (lens, items) => `
You are the ENHANCEMENT VERIFIER (read-only on SOURCE — you write exactly one proposal file and nothing
else). For each candidate below, inspect the ACTUAL code to decide whether it is REAL and WORTH THE
USER'S ATTENTION, correct its impact, and route it. You are the quality gate: a noisy proposal list
wastes the user's triage time, and an enhancement audit that cries wolf gets ignored entirely.
${ENV}
LENS: ${lens.id} — ${lens.focus}
CANDIDATES (candidate_id :: category :: impact/effort :: title):
${items.map((i) => `  - ${i.id} :: ${i.c.category} :: ${i.c.impact}/${i.c.effort} :: ${i.c.title}
      files:   ${(i.c.files || []).join(', ') || '(none given)'}
      today:   ${i.c.today}
      instead: ${i.c.instead}
      removes: ${i.c.cost_removed}
      risk:    ${i.c.risk || '(none stated)'}`).join('\n')}

REJECT RUTHLESSLY — in this order, first match wins. Set is_real=false for 1–3:
  1. THE SYSTEM ALREADY DOES THIS. Go look. This is the most common failure of the find pass — check
     every candidate against the current code before anything else.
  2. THE CLAIMED COST IS NOT REAL, or you cannot substantiate it from the code in front of you. A
     benefit that only holds under an assumption the code does not make is not a benefit.
  3. IT IS TASTE. A preference, a rename, a restructure with no named cost removed. Also: anything
     below the ${MIN_IMPACT_NAME} impact floor once YOU have scored it honestly.
  4. IT IS A DEFECT, not an enhancement — the system gets this WRONG today. Set is_defect=true and
     REJECT it with a one-line note naming what is broken, so the user can route it to the defect
     workflow. Do NOT smuggle it through as an enhancement.

For each SURVIVOR, score and route:
  impact : transformative | high | moderate | marginal   (YOUR honest score, not the finder's)
  effort : trivial | small | medium | large
ROUTING (apply in order; first match wins):
  - is_real == false OR is_defect == true    -> REJECT (one line why)
  - impact below the ${MIN_IMPACT_NAME} floor -> REJECT (below floor)
  - a genuine product/design call only the USER can make (changes what the system IS, trades off two
    things the user values differently, or rests on intent you cannot read from the code)
                                             -> NEEDS_USER (fill options + recommendation)
  - effort == large OR it touches many files/contracts at once
                                             -> ROADMAP (real, but it needs planning, not a single change)
  - otherwise                                -> ADOPT (well-scoped; ready to hand to a builder as-is)
Also set a short \`theme\` keyword per verdict so related proposals can be planned together.

WRITE the proposal file ${proposalFile(lens.id)} (create ${PROPOSALS_DIR}/ if needed). Use EXACTLY this
format so the user can triage it:
-----
---
lens: ${lens.id}
focus: ${lens.focus}
reviewed: true
note: PROPOSALS — human triage required. Not a defect inventory; nothing here is applied automatically.
---
# Enhancements: ${lens.id}

(for EACH kept verdict — ADOPT, then ROADMAP, then NEEDS_USER — one block, highest impact first:)
### [<candidate_id>] <title>
- id: <candidate_id>
- files: <file:line, comma-separated>
- category: <category>
- impact: <your confirmed impact>
- effort: <your confirmed effort>
- decision: <ADOPT | ROADMAP | NEEDS_USER>
- theme: <theme>

**Today:** <what the system actually does now, with the file:line you confirmed it at>
**Instead:** <the change, concrete enough to hand to a builder>
**Removes:** <the specific cost this removes>
**Risk:** <what it could break or make worse>
**Options:** <options>                (NEEDS_USER only)
**Recommendation:** <recommendation>  (NEEDS_USER only)

## Rejected
(one line each: \`<title> — <why>\`; mark defects as \`DEFECT (route to the defect workflow): <what is broken>\`)
-----
If NOTHING survived, write the frontmatter + heading + "No enhancements found above the
${MIN_IMPACT_NAME} impact floor." followed by the Rejected section.
A question only the user can answer stays in THIS file, in that candidate's own NEEDS_USER block — its
**Options:** + **Recommendation:** lines ARE the escalation. There is no shared escalation file: the
lenses write concurrently, so appends to one shared file would overwrite each other.
Do NOT modify source, do NOT write into any issues/ directory, do NOT stage or commit.
Set wrote_file=true and return all verdicts via the schema.`;

// =============================================================================
// Fan out finder → verifier per LENS (read-only, concurrent), then STOP.
// =============================================================================
log(`enhance: ${LENSES.length} lens(es) over ${SCOPE.length} scope path(s) → ${PROPOSALS_DIR} [floor=${MIN_IMPACT_NAME}]`);
log(`spawn ceiling: ≤ ${LENSES.length * 2} agents (${LENSES.length} finder(s) + ≤${LENSES.length} verifier(s) — verify spawns only where candidates exist)`);

const results = await pipeline(
  LENSES,
  // -- Find: one agent per lens, reading the whole scope --------------------------------------
  async (lens) => {
    const r = await agent(findPrompt(lens), roleOpts('find', {
      schema: FIND_SCHEMA, phase: 'Find', label: `find:${lens.id}`,
    }));
    // Floor the finder's own scores before verify — below-floor candidates only cost verify tokens.
    // They are cut here, so they never reach the verifier and never appear in the proposal file's
    // Rejected section: this count is the ONLY trace they existed. It has to reach the caller, because
    // `minImpact` is a knob the operator is invited to lower (CLAUDE.md §3) and "12 candidates sat one
    // rank under your floor" is exactly the fact that decides whether lowering it is worth a re-run.
    // Logging it and dropping it made a floor that is too high indistinguishable from a clean system.
    // A DEAD finder is not a clean lens. `r?.candidates || []` would make the two identical — zero
    // candidates, zero below the floor, and a result object carrying this lens id, so `failed` stays empty
    // and the run reports the lens as audited. Dropping it to null instead puts it in `failed`, which is
    // the one place the operator can see that this lens produced nothing because nobody looked.
    if (!r) {
      log(`  ⚠ ${lens.id}: the finder DIED — this lens was NOT audited (no candidates, no marker file). Re-run it.`);
      return null;
    }
    const kept = (r.candidates || []).filter((c) => (IMPACT_RANK[c.impact] ?? 1) >= MIN_IMPACT);
    const belowFloor = (r.candidates || []).length - kept.length;
    if (belowFloor) log(`  ${lens.id}: ${belowFloor} candidate(s) below the ${MIN_IMPACT_NAME} floor — cut before verify, not in the proposal file`);
    return { lens, candidates: kept, belowFloor, markerWritten: r.wrote_clean_marker === true };
  },
  // -- Verify + write the lens proposal file — ONLY when the lens has candidates ---------------
  async (r) => {
    if (!r) return null;                        // stage 1 dropped a dead finder — it belongs in `failed`
    const { lens, candidates, belowFloor, markerWritten } = r;
    const items = candidates.map((c, i) => ({ id: `${slug(lens.id)}-${i + 1}`, c }));
    if (items.length === 0) {
      if (markerWritten) log(`  ✓ ${lens.id}: nothing above the floor — finder wrote the marker, verify skipped`);
      else log(`  ⚠ ${lens.id}: nothing above the floor but no ${proposalFile(lens.id)} was written — re-run this lens to get its marker`);
      return { lens: lens.id, focus: lens.focus, file: proposalFile(lens.id), counts: { found: 0, adopt: 0, roadmap: 0, needs_user: 0, rejected: 0, defects: 0, belowFloor }, kept: [] };
    }
    const v = await agent(verifyPrompt(lens, items), roleOpts('verify', {
      schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${lens.id}`,
    }));
    // A DEAD verifier is not a verified lens, exactly as a dead finder is not a clean one (:343-346).
    // Returning the result object anyway kept the lens out of `failed`, counted it as audited, and
    // reported a `file:` path nobody wrote. Dropping it to null is the one place the operator sees it.
    if (!v) {
      log(`  ⚠ ${lens.id}: the verifier DIED — this lens was NOT verified and no ${proposalFile(lens.id)} was written. Re-run it.`);
      return null;
    }
    // Match every verdict back to a candidate we actually submitted (same guard as debug/review.mjs):
    // a hallucinated or repeated candidate_id would inflate the counts and put a phantom row in `kept`,
    // and the main agent would report adoption numbers the proposal file does not contain.
    const byId = new Set(items.map((x) => x.id));
    const seen = new Set();
    const verdicts = (v?.verdicts || []).filter((x) => {
      if (!byId.has(x.candidate_id) || seen.has(x.candidate_id)) return false;
      seen.add(x.candidate_id);
      return true;
    });
    const stray = (v?.verdicts || []).length - verdicts.length;
    if (stray) log(`  ⚠ ${lens.id}: ignored ${stray} verdict(s) with an unknown or duplicate candidate_id`);
    const by = (d) => verdicts.filter((x) => x.decision === d).length;
    const counts = {
      found: items.length,
      adopt: by('ADOPT'),
      roadmap: by('ROADMAP'),
      needs_user: by('NEEDS_USER'),
      rejected: by('REJECT'),
      defects: verdicts.filter((x) => x.is_defect === true).length,
      belowFloor,
    };
    if (v?.wrote_file !== true) log(`  ⚠ ${lens.id}: verifier did NOT confirm writing ${proposalFile(lens.id)} — check it before triaging`);
    log(`  ✓ ${lens.id}: ${counts.found} candidate(s) → ${counts.adopt} adopt, ${counts.roadmap} roadmap, ${counts.needs_user} needs-user, ${counts.rejected} rejected${counts.defects ? ` (${counts.defects} were DEFECTS → debug workflow)` : ''}`);
    return {
      lens: lens.id, focus: lens.focus, file: proposalFile(lens.id), counts,
      kept: verdicts.filter((x) => x.decision !== 'REJECT')
        .map((x) => ({ id: x.candidate_id, decision: x.decision, impact: x.impact, effort: x.effort, theme: x.theme || '' })),
    };
  },
);

const live = results.filter(Boolean);
const failed = LENSES.filter((l) => !live.some((r) => r.lens === l.id)).map((l) => l.id);
if (failed.length) log(`  ⚠ no proposal file from: ${failed.join(', ')} (finder or verifier failed) — re-run these lenses`);

const total = (k) => live.reduce((s, r) => s + (r.counts[k] || 0), 0);
const adopt = total('adopt'), roadmap = total('roadmap'), needsUser = total('needs_user');
const defects = total('defects');
const belowFloor = total('belowFloor');
log(`enhance: ${adopt} adopt, ${roadmap} roadmap, ${needsUser} needs-user across ${live.length} lens(es)${defects ? `; ${defects} candidate(s) were defects (debug workflow)` : ''}${belowFloor ? `; ${belowFloor} cut below the ${MIN_IMPACT_NAME} floor` : ''}`);

return {
  phase: 'enhance',
  runId: RUN_ID,
  proposalsDir: PROPOSALS_DIR,
  // `belowFloor` counts candidates cut on the FINDER's own unverified score, before any verifier saw
  // them — so they are in no proposal file at all. It is the only signal that the floor, not the system,
  // is why a lens came back thin.
  summary: { lenses: live.length, adopt, roadmap, needsUser, rejected: total('rejected'), defects, belowFloor },
  // Cross-lens overlap is SIGNAL, not duplication: two lenses landing on the same change independently
  // is the strongest evidence in the run. The engine keeps lens files separate and lets the human see
  // the convergence (matching how brainstorm/decide treat their lenses) — no merge agent (#4/#6).
  lenses: live.map((r) => ({ lens: r.lens, focus: r.focus, file: r.file, counts: r.counts, kept: r.kept })),
  failed,
  nextStep: `Read the proposal files in ${PROPOSALS_DIR}/ and PRESENT them to the user: the ADOPT items first (highest impact), then ROADMAP, then every NEEDS_USER with its options + recommendation. Call out any change TWO OR MORE lenses landed on independently — that convergence is the strongest signal in the run. Then triage with the user: adopted items go to feature-cycle (several become its plans[] roadmap), ROADMAP items to migrate-cycle or a feature plan of their own, and anything the verifier flagged as a DEFECT goes to the debug workflow instead. NOTHING here is applied automatically and there is no resolve step — the user decides what gets built.${belowFloor ? ` ALSO TELL THEM: ${belowFloor} candidate(s) were cut below the ${MIN_IMPACT_NAME} impact floor before verification, so they appear in NO proposal file. That is a knob, not a verdict — if the run came back thinner than expected, re-run with a lower minImpact to see them.` : ''}`,
};
