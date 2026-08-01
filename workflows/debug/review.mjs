export const meta = {
  name: 'review',
  description: 'Read-only fan-out review, lean/file-bus design. Fans out over bounded units (reviewer, then a verifier only where findings exist) READ-ONLY and writes one verbatim issue file per unit (the inventory + your triage doc), then STOPS. A clean unit is written by the reviewer itself; a unit with findings goes to a verifier — one writer per file. You triage the files; the sibling resolve-cycle.mjs then batches the approved issues and fixes each behind a two-stage review. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Review a whole codebase (or subsystem) as a planned campaign. The main agent runs gen-units.mjs and passes the units in args. This pass is read-only and concurrent: each unit gets a reviewer; clean units get their runs/<runId>/issues/<unit>.md marker from the reviewer, units with findings get a verifier that writes that file (a parseable, human-triage-ready inventory). It then STOPS. You triage by editing those files (flip a decision to SKIP, answer a NEEDS_USER by writing the chosen option into its Fix line). An OPTIONAL lens (args.lens, or per-unit unit.lens) narrows WHICH defects a unit hunts — a destructiveness audit, a data-loss sweep, a compliance pass. Pass an ARRAY of lenses to sweep the same files from several genuinely different angles: each unit is reviewed once per lens and the results merge into that unit\'s single issue file behind ONE verifier. A lens never widens the pass into proposing improvements or features: this is defect-hunting only, because the inventory feeds an autonomous fixer. The return carries an `issues` array in resolve-cycle\'s exact args.issues shape (pre-triage), so the operator applies their triage edits to it rather than re-grepping the files by hand. Then run the sibling resolve-cycle.mjs (SAME runId), which batches by area/LOC and fixes each batch behind a two-stage review, staging accepted work. Nothing is ever committed.',
  phases: [
    { title: 'Review', detail: 'Reviewer finds production defects in ONE bounded unit (units run concurrently, read-only); when it finds nothing it writes the clean issues/<unit>.md marker itself.' },
    { title: 'Verify', detail: 'Spawned ONLY for units with findings: confirms each against real code, corrects severity, routes via the decision matrix, and WRITES runs/<runId>/issues/<unit>.md verbatim (the inventory). Returns a slim verdict index.' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
// The harness reads NO files: the main agent runs gen-units.mjs and passes args.units. Verifiers write
// the per-unit issue files; those files ARE the inventory and the triage doc (no issues.json, no
// organizer — see WORKFLOW-PRINCIPLES.md #2/#4/#6). This engine is READ-ONLY and STOPS after writing the
// inventory; the sibling resolve-cycle.mjs fixes the approved issues (reuse the same runId + root).
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, target, conventions, units }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally this workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// `target.repo` is REQUIRED and has NO default. This pass is read-only, so a wrong repo destroys
// nothing — but it produces a bogus inventory that then feeds resolve-cycle's autonomous fixer, and the
// run-state-inside-repo guard below is computed from the same value, so it would mis-fire too.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the git repo under review. There is no default — every path the reviewers read, and the inventory that feeds resolve-cycle, resolves against it.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup } — informational context for reviewers

// Severity floor. This pass reports >= reviewSeverity into the CLOSED inventory that resolve-cycle.mjs
// then fixes (because the inventory is closed here, fixing mediums downstream converges — no fresh
// review surfaces a new batch each round).
const SEV_RANK    = { low: 1, medium: 2, high: 3, critical: 4 };
const REVIEW_SEV_NAME = A.reviewSeverity ?? 'medium';
const REVIEW_SEV  = SEV_RANK[REVIEW_SEV_NAME];

// LENS — WHICH defects this pass hunts. Unset reproduces the defect-hunting text verbatim, so an
// existing call is unaffected. Set it to aim the same machinery at a narrower class of defect (a
// destructive-behavior audit, a data-loss sweep, a compliance pass, a document/drawing review):
// `mandate` replaces the reviewer's one-line charter, `criteria` its assessment list, `categories` the
// finding enum, `findingNoun`/`matters` the floor wording.
//
// A lens NEVER licenses proposing new capability. "Report DEFECTS, not redesigns" and the verifier's
// `scope-creep -> REJECT` are UNCONDITIONAL and must stay that way: this inventory feeds
// resolve-cycle's autonomous fixer, so an improvement list here would be auto-applied behind a
// two-round gate — exactly the scope creep the workflow exists to prevent. It also would not converge
// (there is always another improvement), which is what the CLOSED-inventory contract depends on.
// Improvement/feature hunting is a DIFFERENT workflow.
//
// args.lens sets the default for every unit; a unit may override it with `unit.lens` (same shape). That
// lets a SMALL codebase fan out by LENS instead of by file-slice: pass the same files as N units with
// distinct ids and a different `unit.lens` each — one issue file per lens, reviewed concurrently.
// `lens` may be ONE lens or an ARRAY of them. An array reviews each unit once per lens and merges the
// results into that unit's SINGLE issue file behind ONE verifier — genuinely different angles over the
// same files, which is what the old `reviewPasses` arg was reaching for and never achieved (it re-ran
// the IDENTICAL prompt, so pass 2 re-hunted pass 1's ground at full cost; the dedup comment below is
// the code admitting it). Passing the same lens twice reproduces `reviewPasses: 2` exactly, so the arg
// is subsumed, not lost.
const BASE_CRITERIA = `correctness, security, error-handling, resource-leak (unclosed handles/timers/sockets),
  data-integrity, types, api-contract, concurrency (races, shared state), testing (missing coverage
  of risky paths), performance, maintainability, convention adherence`;
const BASE_CATEGORIES = ['correctness', 'security', 'error-handling', 'resource-leak', 'data-integrity', 'types', 'api-contract', 'concurrency', 'testing', 'performance', 'maintainability', 'convention'];
// Field-level defaulting: a lens that sets only `mandate` still gets the base criteria and categories.
const oneLens = (L, i) => ({
  id:          L.id ?? `lens${i + 1}`,
  mandate:     L.mandate ?? 'examining ONE bounded unit of a codebase for PRODUCTION READINESS',
  criteria:    L.criteria ?? BASE_CRITERIA,
  categories:  Array.isArray(L.categories) && L.categories.length ? L.categories : BASE_CATEGORIES,
  findingNoun: L.findingNoun ?? 'production DEFECTS',
  matters:     L.matters ?? ' in production',   // "…why it matters<matters>"
});
const asList = (v) => (Array.isArray(v) ? v : (v ? [v] : [{}]));
// A unit's own lens list REPLACES the run default (it does not merge into it) — with arrays in play,
// element-wise merging would be unpredictable, and per-field defaults already cover the common case.
// An EMPTY array reads as unset, for `unit.lens` and `A.lens` alike: `[]` is truthy, so without this it
// would replace a real lens set with nothing and the per-lens loop would never run — the unit gets zero
// reviewers, contributes 0 to every count, and still looks processed. Silent zero coverage is exactly
// what the `args.units` throw exists to prevent. The dangerous shape is the mixed one — `args.lens: []`
// ("no default, each unit brings its own") plus a unit whose `unit.lens` was forgotten.
const pick = (v) => (Array.isArray(v) ? (v.length ? v : null) : (v || null));
const lensesOf = (unit) => asList(pick(unit && unit.lens) ?? pick(A.lens)).map(oneLens);

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType
// that exists in YOUR registry. Verify is opus (high stakes); reviewer is the fast tier.
const AT = { ...(A.agentTypes ?? {}) };
const M  = { review: 'sonnet', verify: 'opus', ...(A.models ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// ROOT is the ABSOLUTE base run-state hangs off (supplied by the main agent), so every agent +
// `git -C` call is cwd-independent. Run-state lands in `<ROOT>/runs/<runId>` unless args.stateDir overrides.
const ROOT      = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm      = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs       = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const REPO      = abs(TARGET.repo);
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
const ISSUES_DIR = `${STATE_DIR}/issues`;
// Blind-reviewer placement guard (#3): run-state (incl. the issue files) must live OUTSIDE the target
// repo so the blind quality reviewer (in resolve-cycle.mjs) cannot wander into it. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the issue files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

// CONTRACT with resolve-cycle.mjs — change both together. The issue-file path scheme
// runs/<runId>/issues/<fileSafe(unit)>.md is the interface between the two engines AND the user's triage
// surface; resolve-cycle.mjs recomputes the IDENTICAL path from runId + root (+ stateDir if overridden).
// Use the SAME values for all three across both engines — a mismatch silently points the fixer at
// missing issue files.
const issueFile      = (unitId) => `${ISSUES_DIR}/${fileSafe(unitId)}.md`;

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
// Per-unit: the category enum comes from that unit's lens (units may carry different lenses).
const reviewSchema = (categories) => ({
  type: 'object',
  required: ['findings', 'wrote_clean_marker'],
  properties: {
    wrote_clean_marker: { type: 'boolean', description: 'true ONLY if you wrote the clean-unit marker file (you had ZERO findings AND no ALREADY-FOUND list); false whenever you report any finding' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'category', 'severity', 'title', 'detail'],
        properties: {
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'string', description: 'line number or range, or "" if N/A' },
          category: { type: 'string', enum: categories },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', description: 'short, specific, stable' },
          detail: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
});

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'wrote_file'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true if you wrote the unit issue file (always required, even when clean)' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding_id', 'is_real', 'severity', 'decision', 'matrix'],
        properties: {
          finding_id: { type: 'string' },
          is_real: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'YOUR confirmed severity (reviewers over-rate; correct it)' },
          decision: { type: 'string', enum: ['ACTIONABLE', 'NEEDS_USER', 'DEFER', 'REJECT'] },
          matrix: {
            type: 'object',
            required: ['clarity', 'effort', 'blast_radius', 'scope', 'architectural'],
            properties: {
              clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
              effort: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
              blast_radius: { type: 'string', enum: ['local', 'cross-cutting'] },
              scope: { type: 'string', enum: ['in-scope', 'scope-creep'] },
              architectural: { type: 'boolean' },
            },
          },
          rationale: { type: 'string' },
          fix_instruction: { type: 'string', description: 'precise minimal instruction for the fixer (ACTIONABLE only)' },
          options: { type: 'string', description: 'NEEDS_USER only: the distinct choices + tradeoffs' },
          recommendation: { type: 'string', description: 'NEEDS_USER only: your suggested direction' },
          theme: { type: 'string', description: 'short grouping keyword (e.g. "pagination") for batching related issues' },
        },
      },
    },
  },
};

// =============================================================================
// Shared prompt fragments
// =============================================================================
const ENV = `TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
All source paths below are RELATIVE TO THIS REPO. Use \`git -C ${REPO} …\` for any git operation.
CONVENTIONS (judge against these; deviations are 'convention' findings):
${CONVENTIONS}
GATES (the build/test commands that define "it works"; run them from the repo root):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
BE TOKEN-ECONOMICAL (target ~250k tokens for your whole turn): read ONLY the files your task names.
Prefer targeted grep over broad reads. Don't restate large files back; act on them.`;

// =============================================================================
// Review-phase prompts
// =============================================================================
const reviewPrompt = (unit, L, handled, cleanEligible) => `
You are the REVIEWER ${L.mandate}. This is a
FIND-ONLY pass: you report defects; a verified+batched phase fixes them later. Do NOT modify any file in
the target repo (the ONLY file you may write is the clean-unit marker described below, in the run-state dir).
${ENV}
UNIT: ${unit.id}
FILES TO REVIEW (read them fully; review ONLY these files):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}

Assess against these criteria and report concrete, located issues:
  ${L.criteria}.

RULES:
- SEVERITY FLOOR: report ONLY ${REVIEW_SEV_NAME}+ ${L.findingNoun}. Do NOT report below-floor,
  stylistic, or speculative "could be more defensive" suggestions — they are dropped downstream and
  only waste the verify stage. If in doubt it's below the floor, omit it.
- READ THE CURRENT FILE CONTENTS before reporting. Do NOT report anything already handled in the code
  as it exists now${handled.length ? ', and do NOT re-report anything in the ALREADY FOUND list below (even rephrased)' : ''}.
- Stay INSIDE this unit's files. Cross-file concerns: mention as context in detail, do not chase.
- Report DEFECTS, not redesigns. No speculative rewrites, no gold-plating, no scope creep. Your brief
  above narrows WHICH defects matter here; it never licenses proposing a new capability, a feature, or
  an efficiency idea — those are a different workflow and are rejected downstream. Every finding must
  be something the code gets WRONG today, not something it could do better.
- Each finding: specific file + line, the right category/severity, what's wrong and why it matters${L.matters},
  and a minimal suggested_fix direction.${handled.length ? `\n\nALREADY FOUND in a prior pass (do NOT re-report):\n${handled.map((t) => `  - ${t}`).join('\n')}` : ''}
${cleanEligible ? `
CLEAN-UNIT MARKER: if AND ONLY IF you find ZERO findings, WRITE the file ${issueFile(unit.id)} (create
${ISSUES_DIR}/ if needed) with EXACTLY this content, then set wrote_clean_marker=true:
-----
---
unit: ${unit.id}
hash: ${unit.hash}
reviewed: true
---
# Review: ${unit.id}

No issues found.
-----
If you report ANY finding, write NOTHING (a verifier writes this unit's file) and set wrote_clean_marker=false.
Do NOT write issues.json, any shared doc, or a source file.
` : ''}
Return findings via the schema. An empty findings array means this unit is clean — a normal, good outcome.`;

// CONTRACT with resolve-cycle.mjs — change both together. The issue-file BLOCK FORMAT the verifier writes
// below (frontmatter unit/hash/reviewed; `### [<id>]` blocks; `- ` header lines; the decision values;
// the `**Fix:**` line) is exactly what resolve-cycle.mjs's fixer + acceptance parse. Same runId + root
// (+ stateDir if overridden) ⇒ same runs/<runId> across both engines.
const verifyPrompt = (unit, items) => { const lenses = lensesOf(unit); const multi = lenses.length > 1; return `
You are the VERIFIER (read-only on SOURCE — you write exactly one inventory file and nothing else). For
each candidate finding below, inspect the ACTUAL code in the repo to confirm it is real, correct its
severity, then route it with the decision matrix. Reject false positives and gold-plating ruthlessly —
a noisy inventory wastes the user's triage time and the fixer's context. Reject, in particular,
anything the code ALREADY does, and anything that is a preference rather than a defect.
${ENV}
UNIT: ${unit.id}
THE REVIEWER${multi ? "S'" : "'S"} BRIEF${multi ? 'S' : ''} for this unit — context for judging severity. ${multi
    ? `${lenses.length} reviewers each swept these files under a DIFFERENT brief; judge each candidate against
the brief it came from (named on its line below). A brief narrows which defects matter; it does NOT
widen what counts as one.
${lenses.map((l) => `  [${l.id}] ${l.mandate}`).join('\n')}`
    : `It narrows which defects matter, it does NOT widen what counts as one:
  ${lenses[0].mandate}`}
CANDIDATE FINDINGS (finding_id :: ${multi ? 'lens :: ' : ''}file :: category/severity :: title):
${items.map((i) => `  - ${i.id} :: ${multi ? `[${i.f._lens?.id || '?'}] :: ` : ''}${i.f.file}${i.f.line ? ':' + i.f.line : ''} :: ${i.f.category}/${i.f.severity} :: ${i.f.title}\n      ${i.f.detail}\n      suggested: ${i.f.suggested_fix || '(none)'}`).join('\n')}
${multi ? `
FOLD DUPLICATES FIRST. Different briefs can surface the SAME underlying defect in different words. Where
two or more candidates are one defect, keep ONE verdict for it (the clearest id, at the highest
justified severity, with a fix_instruction that closes the whole thing) and REJECT the others with
"duplicate of <id>". Do not let one defect enter the inventory twice — the fixer would fix it, then find
it stale. Candidates that merely share a file and category are NOT duplicates unless the underlying
defect is the same.
` : ''}
DECISION MATRIX — score each real finding on:
  clarity      : clear (one obvious correct fix) | ambiguous (multiple valid fixes / unclear intent)
  effort       : trivial (one-liner) | small (localized, <~30 lines) | medium (<~150 lines, this unit) | large
  blast_radius : local (this unit) | cross-cutting (touches shared contracts / many files)
  scope        : in-scope (a real defect in current behavior) | scope-creep (nice-to-have / new feature)
  architectural: true if it questions a design/structural decision

ROUTING (apply in order; first match wins):
  - is_real == false                       -> REJECT
  - scope == scope-creep                   -> REJECT (note why; do not pursue)
  - architectural == true                  -> NEEDS_USER (the user must decide design direction; fill options + recommendation)
  - clarity == ambiguous with materially different valid fixes -> NEEDS_USER (fill options + recommendation)
  - effort == large OR blast_radius == cross-cutting -> DEFER (too big for an autonomous batch; the user plans it)
  - otherwise                              -> ACTIONABLE (write a precise, minimal fix_instruction)
Also set a short \`theme\` keyword per verdict so related issues can be batched together.

WRITE the inventory file ${issueFile(unit.id)} (create ${ISSUES_DIR}/ if needed). Use EXACTLY this format
so the user can triage it and the resolve phase can parse it:
-----
---
unit: ${unit.id}
hash: ${unit.hash}
reviewed: true
---
# Review: ${unit.id}

(for EACH kept verdict — ACTIONABLE, NEEDS_USER, or DEFER, in that order — one block:)
### [<finding_id>] <title>
- id: <finding_id>
- file: <file>:<line>
- loc: <the LOC of that file>
- severity: <your confirmed severity>
- category: <category>
- effort: <matrix effort>
- decision: <ACTIONABLE | NEEDS_USER | DEFER>
- theme: <theme>

**What:** <detail — what's wrong and why it matters${multi ? '' : lenses[0].matters}>
**Fix:** <fix_instruction>            (ACTIONABLE; for NEEDS_USER leave the chosen option for the user)
**Options:** <options>                (NEEDS_USER only)
**Recommendation:** <recommendation>  (NEEDS_USER only)
-----
If there are NO kept verdicts, write the frontmatter + heading + the single line "No issues found."
Do NOT write issues.json, any shared doc, or modify source. Set wrote_file=true and return all verdicts via the schema.`; };

// =============================================================================
// Fan out reviewer → verifier per unit (read-only, concurrent), then STOP. The main agent supplies
// args.units (gen-units.mjs output it read) and, on resume, only the units whose issues/<unit>.md is
// missing or whose embedded hash changed. The engine reviews whatever units it is given — there is no
// loader/scribe/organizer (WORKFLOW-PRINCIPLES.md #4/#6).
// =============================================================================
const units = A.units;
if (!Array.isArray(units) || !units.length) {
  throw new Error('review requires a non-empty args.units array (run gen-units.mjs, read it, and pass units — see CLAUDE.md). On resume pass only the units lacking an issue file or whose hash changed. Reuse this runId when you run the sibling resolve-cycle.mjs — both engines key runs/<runId> off it.');
}
const totalReviewers = units.reduce((s, u) => s + lensesOf(u).length, 0);
const lensedUnits = units.filter((u) => u && u.lens).length;
log(`review: ${units.length} unit(s) → ${ISSUES_DIR} [floor=${REVIEW_SEV_NAME}, ${totalReviewers} reviewer(s)${A.lens ? `, default lens x${asList(A.lens).length}` : ''}${lensedUnits ? `, ${lensedUnits} unit lens override(s)` : ''}]`);
log(`spawn ceiling: ≤ ${totalReviewers + units.length} agents (${totalReviewers} reviewer(s) = one per unit x lens, + ≤${units.length} verifiers — verify spawns only where findings exist, ONE per unit however many lenses it ran)`);

// Read-only fan-out: each unit flows reviewer(s) → verifier independently and concurrently.
const results = await pipeline(
  units,
  // -- Review: one pass per lens, merged into this unit's single finding set --------------------
  async (unit) => {
    const lenses = lensesOf(unit);
    const found = [];
    const sigs = new Set();
    const handled = [];
    let markerWritten = false;
    for (let p = 0; p < lenses.length; p++) {
      const lens = lenses[p];
      // Only the FINAL lens, with no prior finding, may write the clean marker: an earlier clean pass
      // that wrote it could be left as the terminal on-disk state if a later pass throws or the run is
      // cut before verify overwrites — resume would then trust that premature "clean" file and skip the
      // unit, silently dropping a defect a later lens found.
      const cleanEligible = handled.length === 0 && p === lenses.length - 1;
      const r = await agent(reviewPrompt(unit, lens, handled, cleanEligible), roleOpts('review', {
        schema: reviewSchema(lens.categories), phase: 'Review',
        label: `review:${unit.id}${lenses.length > 1 ? `/${lens.id}` : ''}`,
      }));
      // A DEAD reviewer is not a clean lens. `r?.findings || []` would make the two identical — zero
      // findings from this lens, while a surviving sibling lens keeps `items.length > 0`, so the unit
      // goes to verify and is logged as normally processed. The issue file is then written with the unit
      // hash, and hash-based resume skips a unit one of whose lenses never looked at it.
      if (!r) {
        log(`  ⚠ ${unit.id}${lenses.length > 1 ? `/${lens.id}` : ''}: reviewer returned nothing (agent died or produced no output) — this lens contributed NO coverage; re-review this unit`);
        continue;
      }
      if (cleanEligible && r?.wrote_clean_marker) markerWritten = true;   // only the final clean pass writes it
      for (const f of (r?.findings || [])) {
        if ((SEV_RANK[f.severity] ?? 1) < REVIEW_SEV) continue;
        // Dedup on lens+file+category. Within ONE lens this is the old file:category rule, which exists
        // because a re-review re-phrases the same concern and title-based dedup leaks duplicates. Across
        // lenses it must NOT collapse: a destructiveness lens and a correctness lens can each find a
        // DIFFERENT real defect in the same file and category. The verifier folds any true overlap.
        const s = `${lens.id}:${f.file}:${f.category}`;
        if (sigs.has(s)) continue;
        sigs.add(s);
        handled.push(f.title);
        found.push({ ...f, _lens: lens });
      }
    }
    return { unit, findings: found, markerWritten };
  },
  // -- Verify + write the unit inventory file — ONLY when the unit has findings -------------------
  async (r) => {
    const { unit, findings, markerWritten } = r;
    const items = findings.map((f, i) => ({ id: `${slug(unit.id)}-${i + 1}`, f }));
    // Clean unit: no findings ⇒ NO verify spawn. The reviewer already wrote issues/<unit>.md itself.
    if (items.length === 0) {
      if (markerWritten) log(`  ✓ ${unit.id}: clean (0 findings) — reviewer wrote the marker, verify skipped`);
      else log(`  ⚠ ${unit.id}: clean but the reviewer did NOT write ${issueFile(unit.id)} — resume will re-review it`);
      return { unit: unit.id, file: issueFile(unit.id), counts: { found: 0, actionable: 0, needs_user: 0, deferred: 0, rejected: 0 }, kept: [] };
    }
    const verify = await agent(verifyPrompt(unit, items), roleOpts('verify', {
      schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${unit.id}`,
    }));
    // `wrote_file` is REQUIRED by VERIFY_SCHEMA and instructed in the prompt — read it, or two failures
    // both log as a normal ✓: a verifier that returned verdicts without writing issues/<unit>.md (the
    // ✓ line points at a file that does not exist), and a DEAD verifier, where `verify?.verdicts || []`
    // yields no kept issues at all and this unit's real findings vanish from the returned `issues` array
    // the operator builds resolve-cycle's args.issues from. Same guard as enhance-cycle.mjs's verifier.
    if (verify?.wrote_file !== true) log(`  ⚠ ${unit.id}: verifier did NOT confirm writing ${issueFile(unit.id)} (${verify ? 'no wrote_file' : `agent returned nothing — its ${findings.length} finding(s) were DROPPED`}) — check the file before triaging and re-review this unit`);
    const byId = new Map(items.map((x) => [x.id, x]));
    const locOf = new Map((unit.files || []).map((f) => [f.path, f.loc]));
    const counts = { found: findings.length, actionable: 0, needs_user: 0, deferred: 0, rejected: 0 };
    const kept = [];
    for (const v of (verify?.verdicts || [])) {
      const item = byId.get(v.finding_id);
      if (!item) continue;
      if (!v.is_real || v.decision === 'REJECT') { counts.rejected++; continue; }
      if (v.decision === 'ACTIONABLE') counts.actionable++;
      else if (v.decision === 'NEEDS_USER') counts.needs_user++;
      else counts.deferred++;
      kept.push({
        id: item.id, unit: unit.id, file: item.f.file, line: item.f.line || '',
        loc: locOf.get(item.f.file) ?? 0, severity: v.severity || item.f.severity,
        category: item.f.category, decision: v.decision, effort: v.matrix?.effort || 'small',
        title: item.f.title, theme: v.theme || '',
      });
    }
    log(`  ✓ ${unit.id}: ${counts.found} found → ${counts.actionable} actionable, ${counts.needs_user} needs-you, ${counts.deferred} deferred, ${counts.rejected} rejected`);
    return { unit: unit.id, file: issueFile(unit.id), counts, kept };
  },
);

const processed = results.filter(Boolean);
const all = processed.flatMap((r) => r.kept);
const sum = (pred) => all.filter(pred).length;
const bySeverity = { critical: sum((i) => i.severity === 'critical'), high: sum((i) => i.severity === 'high'), medium: sum((i) => i.severity === 'medium'), low: sum((i) => i.severity === 'low') };

// Hottest areas (directory) by max severity then count — guidance for the triage conversation.
const area = (f) => (f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)');
const areas = {};
for (const i of all) { const a = area(i.file); (areas[a] ??= { area: a, count: 0, maxSev: 0 }); areas[a].count++; areas[a].maxSev = Math.max(areas[a].maxSev, SEV_RANK[i.severity] ?? 1); }
const hottest = Object.values(areas).sort((x, y) => y.maxSev - x.maxSev || y.count - x.count).slice(0, 8).map((a) => ({ area: a.area, issues: a.count }));

return {
  phase: 'review',
  runId: RUN_ID,
  unitsReviewed: processed.length,
  issuesDir: ISSUES_DIR,
  inventory: {
    total: all.length,
    actionable: sum((i) => i.decision === 'ACTIONABLE'),
    needsUser: sum((i) => i.decision === 'NEEDS_USER'),
    deferred: sum((i) => i.decision === 'DEFER'),
    bySeverity,
  },
  hottest,
  // Which files hold items that need a triage decision (open these to present options).
  needsUserFiles: processed.filter((r) => r.counts.needs_user > 0).map((r) => r.file),
  // The machine-built index of every kept finding, in EXACTLY resolve-cycle's args.issues shape. The
  // engine already had to build this to compute the counts above; discarding it forced the operator to
  // re-derive the same array by hand-grepping the issue files, which is error-prone busywork (a hand
  // rebuild is how a `file.py:224-276` range once became the number 224276).
  // It is PRE-TRIAGE — the verifier's decisions, not the user's. Apply the triage on top: drop the ones
  // the user set to SKIP, and flip approved NEEDS_USER items to ACTIONABLE (re-reading their rewritten
  // Fix lines). The issue FILES remain the source of truth for WHAT to fix; this is only the index.
  issues: all,
  nextStep: `Present the inventory: read ${ISSUES_DIR}/*.md and walk the user through totals, the hottest areas, and every NEEDS_USER item (open needsUserFiles for its options + recommendation). Triage by EDITING those files: set a NEEDS_USER item's decision to ACTIONABLE and write the chosen option into its Fix line, or flip any decision to SKIP. Then run the sibling resolve-cycle.mjs with the SAME runId (start scoped with resolveOnly), passing args.issues — start from the \`issues\` array in THIS return rather than re-grepping the files, and apply the triage edits you just made on top of it.`,
};
