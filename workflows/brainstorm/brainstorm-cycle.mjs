export const meta = {
  name: 'brainstorm-cycle',
  description: 'Divergent creative generation, lean/file-bus design: fan out ONE generator per lens, each producing a COMPLETE, fully-committed variation (design or idea) written to its own folder — NO AI review, the USER judges. The harness only routes paths; agents never see each other. Use it to explore a wide solution space (web/slideshow designs, product ideas, business-plan angles) so the user can pick one or cherry-pick elements across variations.',
  whenToUse: 'Generate several DISTINCT, fully-realized variations of one creative thing so a human can compare and combine them. The main agent settles the brief + the LENSES with the user beforehand (each lens = one variation axis, e.g. "minimalist", "bold/editorial", "efficiency-first", "robustness-first"), optionally authors a shared brief/requirements file in PLAN MODE for a complex problem, then runs this engine. This is intentionally LOOSE: no scoring, no review, no convergence — divergence only. To converge ON a conclusion from options, use decide-cycle; to build a chosen variation, use feature-cycle.',
  phases: [
    { title: 'Generate', detail: 'One generator per lens (CONCURRENT). Each reads the shared brief (verbatim) + its lens, produces a complete variation fully committed to that lens, and writes it into runs/<runId>/variations/<lens>/. Returns only the entry path + a one-line differentiator. No review, no staging.' },
  ],
};

// =============================================================================
// Config — everything problem-specific arrives via args so the engine stays general.
// Brainstorm is DIVERGENT and read-only w.r.t. any target repo: it writes ONLY into the run-state
// dir (variations/<lens>/), never the repo, and never stages or commits. There is NO review stage —
// the user is the judge (see WORKFLOW-PRINCIPLES.md: generative workflows honor only the core
// principles). The main agent picks the lenses + (optional) brief with the user BEFOREHAND (#4) —
// the engine spawns no setup/loader/scribe agent.
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
  throw new Error('args must include at least { runId, root, lenses, brief|planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL (brainstorm often needs no repo)
const CONSTRAINTS = A.constraints ?? '';                   // shared constraints every lens must respect
const FORMAT      = A.outputFormat ?? 'a single self-contained Markdown document';   // what each variation IS
const KIND        = A.kind ?? 'variation';                 // noun for the thing being produced (e.g. "web design", "product idea")

// Per-role model tier + OPTIONAL custom subagent type. Default: no agentType (standard subagent).
const M  = { generate: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const VAR_DIR     = `${STATE_DIR}/variations`;
const lensDir     = (id) => `${VAR_DIR}/${id}`;

// Shared brief: a single source of truth (#11), read VERBATIM by every generator (#2). Either a file
// (richer requirements for a complex problem, authored in plan mode) or a short inline string.
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const BRIEF       = (!PLAN_PATH && A.brief) ? String(A.brief) : '';
if (!PLAN_PATH && !BRIEF) {
  throw new Error('Provide the problem framing: either planPath (a brief/requirements file each generator reads verbatim) or brief (a short inline string).');
}
const BRIEF_REF   = PLAN_PATH ? `the shared brief at ${PLAN_PATH} (read it verbatim — it is the single source of truth)` : `the brief below:\n-----\n${BRIEF}\n-----`;

// Optional reference docs each generator may draw on (the "brainstorm-refs" mode). Handed as paths
// the agent reads (#11 — link, don't paste). Each is genuinely distinct, so multiple links are fine.
const REFERENCES  = Array.isArray(A.references) ? A.references.map(abs) : [];

// Lenses — the variation axes. Each becomes ONE generator → ONE folder. Accept strings or {id, focus}.
const LENSES = (Array.isArray(A.lenses) ? A.lenses : []).map((l, i) => {
  if (typeof l === 'string') return { id: slug(l) || `lens-${i + 1}`, focus: l };
  const focus = l.focus || l.id || '';
  return { id: slug(l.id || focus) || `lens-${i + 1}`, focus };
}).filter((l) => l.focus);
if (!LENSES.length) {
  throw new Error('args.lenses is required: a non-empty array of variation axes (strings, or { id, focus }). The main agent proposes these with the user beforehand (#4).');
}
const dupes = [...new Set(LENSES.map((l) => l.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`lens ids collide after slugging (${dupes.join(', ')}): two generators would write into the same variation folder — give each lens a distinct id.`);
}

// =============================================================================
// Schema — DECISIONS/INDEX ONLY (control plane). The variation itself lives in the file (#8).
// =============================================================================
const GENERATE_SCHEMA = {
  type: 'object',
  required: ['entry', 'summary'],
  properties: {
    entry:   { type: 'string', description: 'path to the MAIN artifact you wrote (the file to open first)' },
    files:   { type: 'array', items: { type: 'string' }, description: 'all files you wrote for this variation' },
    summary: { type: 'string', description: 'ONE line: what makes THIS variation distinct (for the user\'s comparison index — NOT the content, which is in the file)' },
  },
};

// =============================================================================
// Generator prompt — divergent, fully committed, writes one folder, reviews nothing.
// =============================================================================
const generatePrompt = (lens) => `
You are a CREATIVE GENERATOR producing ONE complete ${KIND} optimized for a SINGLE lens. This is
DIVERGENT ideation: commit FULLY to your lens. Do NOT hedge, do NOT compare to other approaches, do NOT
water it down toward a safe compromise. Other generators are exploring other lenses in parallel and the
user will compare and combine — so push your lens as far as it sensibly goes. There is no single right
answer; a bold, coherent take is the goal.

YOUR LENS: ${lens.focus}
THE BRIEF: read ${BRIEF_REF}.
${REFERENCES.length ? `REFERENCE MATERIAL (read these for grounding; they are distinct sources, use what is relevant):\n${REFERENCES.map((r) => `  - ${r}`).join('\n')}\n` : ''}${REPO ? `EXISTING CODEBASE (read-only context, e.g. to match an existing style — do NOT modify it): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONSTRAINTS ? `CONSTRAINTS (shared — every variation must respect these): ${CONSTRAINTS}\n` : ''}OUTPUT FORMAT: ${FORMAT}.

PROCEDURE:
1. Produce your COMPLETE ${KIND} through your lens — fully realized, not an outline (unless the format
   IS an outline). Make the lens's influence obvious and concrete in the result.
2. WRITE it into the folder ${lensDir(lens.id)}/ (create it). Put the main artifact at
   ${lensDir(lens.id)}/index.<ext> (pick the extension the format implies, e.g. .md/.html); put any
   supporting files alongside it.
3. Do NOT review or critique your work, do NOT modify the target repo, do NOT stage or commit. The
   file(s) in your folder are your ONLY output.
Return the entry path + a ONE-LINE differentiator via the schema (the full content stays in the file).`;

// =============================================================================
// Generate — fan out one generator per lens, concurrently. No review, no staging, no convergence.
// =============================================================================
phase('Generate');
log(`brainstorm: ${LENSES.length} lens(es) → ${VAR_DIR}${REFERENCES.length ? ` [${REFERENCES.length} reference(s)]` : ''}`);

const results = await parallel(LENSES.map((lens) => () =>
  agent(generatePrompt(lens), roleOpts('generate', {
    schema: GENERATE_SCHEMA, phase: 'Generate', label: `generate:${lens.id}`,
  })).then((r) => ({ lens: lens.id, focus: lens.focus, dir: lensDir(lens.id), entry: r?.entry || '', summary: r?.summary || '', files: r?.files || [] }))
));

const variations = results.filter(Boolean).filter((v) => v.entry);
for (const v of variations) log(`  ✓ ${v.lens}: ${v.entry} — ${v.summary}`);
const failed = LENSES.filter((l) => !variations.some((v) => v.lens === l.id)).map((l) => l.id);
if (failed.length) log(`  ⚠ no output from: ${failed.join(', ')}`);

return {
  phase: 'generate',
  runId: RUN_ID,
  variationsDir: VAR_DIR,
  count: variations.length,
  variations: variations.map((v) => ({ lens: v.lens, focus: v.focus, entry: v.entry, summary: v.summary })),
  failed,
  nextStep: variations.length
    ? `Present the variations to the user: open each entry under ${VAR_DIR}/ (or relay the one-line summaries) and walk them through the distinct take of each. This is divergent — there is no winner; the user picks one, asks for a hybrid, or cherry-picks elements. To turn a chosen direction into a built feature, hand it to feature-cycle; to have the AI conclude among options with a decision matrix, use decide-cycle.${failed.length ? ` Tell the user these lenses produced NOTHING: ${failed.join(', ')} — offer to re-run just those with the same runId.` : ''}`
    : `NOTHING was produced: every generator failed or returned no entry (${failed.join(', ')}). There is nothing to present — do NOT describe variations. Tell the user the batch produced no output, then re-run those lenses with the same runId (check the brief/planPath is readable and each lens focus is sane first).`,
};
