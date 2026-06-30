export const meta = {
  name: 'review-cycle',
  description: 'Two-phase production-readiness review, lean/file-bus design. phase:"review" fans out over bounded units (reviewer → verifier) READ-ONLY and writes one verbatim issue file per unit (the inventory + your triage doc), then STOPS. phase:"resolve" batches the approved issues and runs fix → BLIND pure-code review (catches anything the fix broke) → issue-aware acceptance (re-derives each defect\'s root cause, confirms it is fully closed + no regression, stages on pass), looped per batch. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Review a whole codebase (or subsystem) as a planned campaign. The main agent runs gen-manifest.mjs and passes the units in args. phase:"review" is read-only and concurrent: each unit gets a reviewer + a verifier that writes runs/<runId>/issues/<unit>.md (a parseable, human-triage-ready file). It then STOPS. You triage by editing those files (flip a decision to SKIP, answer a NEEDS_USER by writing the chosen option into its Fix line). Then the main agent greps the issue files into args.issues and runs phase:"resolve", which batches by area/LOC and fixes each batch behind a two-stage review, staging accepted work. Nothing is ever committed.',
  phases: [
    { title: 'Review', detail: 'Reviewer finds production defects in ONE bounded unit (units run concurrently, read-only).' },
    { title: 'Verify', detail: 'Verifier confirms each finding against real code, corrects severity, routes via the decision matrix, and WRITES runs/<runId>/issues/<unit>.md verbatim (the inventory). Returns a slim verdict index.' },
    { title: 'Fix', detail: 'Fixer reads its batch\'s issue file(s) verbatim, verify-first, fixes minimally, runs gates, leaves work UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no issue text), flags defects the fix introduced or broke. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Issue-aware gate: re-derives each claimed fix\'s root cause from current code, confirms it is fully closed + no regression + gates green. Writes acceptance-review; on pass, STAGES the batch.' },
    { title: 'Rollback', detail: 'On terminal batch failure only: restores the batch to the staged baseline so the next batch starts from a clean diff; its issues are marked needs-attention.' },
    { title: 'Sweep', detail: 'Optional final accounting: full gates, staged-diff spot-check, every issue has a terminal status. Writes SWEEP.md.' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
// The harness reads NO files: the main agent runs gen-manifest.mjs and passes args.units
// (phase review), and after triage greps runs/<runId>/issues/*.md into args.issues (phase
// resolve). Verifiers write the per-unit issue files; those files ARE the inventory and the
// triage doc (no issues.json, no organizer — see WORKFLOW-PRINCIPLES.md #2/#4/#6). The main
// agent also ensures a clean/staged baseline before resolve (#4) — there is no baseline agent.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, target, gates }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally this workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}

const PHASE       = A.phase ?? 'review';                    // 'review' (find + write inventory, then STOP) | 'resolve' (fix in batches)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
const MAX_ROUNDS  = A.maxRounds ?? 2;                       // fix → quality → acceptance repair rounds per batch
const REVIEW_PASSES = A.reviewPasses ?? 1;                  // independent review passes per unit (2 = more thorough)
const BATCH_LOC   = A.batch?.locCap ?? 3000;               // max summed LOC of distinct files per batch (~150-250k tokens/agent)
const BATCH_MAX   = A.batch?.maxIssues ?? 10;              // max issues per batch (soft — same-file issues never split)
const MIN_BATCH_BUDGET = A.minBatchBudget ?? 150_000;      // with a token target set, stop cleanly between batches below this

// Severity floors. The review reports >= reviewSeverity; resolve fixes >= fixSeverity. Because the
// inventory is CLOSED at the end of phase review, fixing mediums HERE converges (no fresh review
// surfaces a new batch each round).
const SEV_RANK    = { low: 1, medium: 2, high: 3, critical: 4 };
const REVIEW_SEV_NAME = A.reviewSeverity ?? 'medium';
const REVIEW_SEV  = SEV_RANK[REVIEW_SEV_NAME];
const FIX_SEV     = SEV_RANK[A.fixSeverity ?? 'medium'];
const CRITIC_SEV_NAME = A.criticSeverity ?? 'high';        // floor for NEW defects the blind reviewer reports in a fix diff

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType
// that exists in YOUR registry. Verify + acceptance are opus (high stakes); reviewer + blind quality
// critic are the fast tier.
const AT = { ...(A.agentTypes ?? {}) };
const M  = { review: 'sonnet', verify: 'opus', fix: 'opus', quality: 'sonnet', acceptance: 'opus', sweep: 'sonnet', ...(A.models ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// ROOT is the ABSOLUTE base run-state hangs off (supplied by the main agent), so every agent +
// `git -C` call is cwd-independent. Run-state lands in `<ROOT>/runs/<runId>` unless args.stateDir overrides.
const ROOT      = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm      = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs       = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const REPO      = abs(TARGET.repo ?? '.');
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
const ISSUES_DIR = `${STATE_DIR}/issues`;
// Blind-reviewer placement guard (#3): run-state (incl. the issue files) must live OUTSIDE the target
// repo so the blind quality reviewer cannot wander into it. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the issue files. Set args.root to THIS tool's own directory (see CLAUDE.md).`);
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

const issueFile      = (unitId) => `${ISSUES_DIR}/${fileSafe(unitId)}.md`;
const qualityFile    = (batchId, r) => `${STATE_DIR}/quality-review-${slug(batchId)}-r${r}.md`;
const acceptanceFile = (batchId, r) => `${STATE_DIR}/acceptance-review-${slug(batchId)}-r${r}.md`;
const dismissedFile  = (batchId) => `${STATE_DIR}/DISMISSED-${slug(batchId)}.md`;   // terse ledger; fixer → reviewers (anti-spin)
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;                                // full detail; for the user (may halt the run)
const SWEEP_FILE     = `${STATE_DIR}/SWEEP.md`;

// Full-suite gate: a review-fix campaign assumes a green baseline, so every accepted batch must keep
// build AND tests green.
const gateOk = (fix) => !!fix
  && (!GATES.build || fix.build_passed === true)
  && (!GATES.test || fix.test_outcome === 'passed');

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'category', 'severity', 'title', 'detail'],
        properties: {
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'string', description: 'line number or range, or "" if N/A' },
          category: { type: 'string', enum: ['correctness', 'security', 'error-handling', 'resource-leak', 'data-integrity', 'types', 'api-contract', 'concurrency', 'testing', 'performance', 'maintainability', 'convention'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string', description: 'short, specific, stable' },
          detail: { type: 'string' },
          suggested_fix: { type: 'string' },
        },
      },
    },
  },
};

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

const FIX_SCHEMA = {
  type: 'object',
  required: ['results', 'build_passed', 'test_outcome', 'unstaged_confirmed', 'needs_user'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['issue_id', 'status'],
        properties: {
          issue_id: { type: 'string' },
          status: { type: 'string', enum: ['FIXED', 'STALE', 'SKIPPED', 'FAILED'] },
          files_changed: { type: 'array', items: { type: 'string' } },
          summary: { type: 'string' },
        },
      },
    },
    tests_written: { type: 'boolean' },
    build_passed: { type: 'boolean' },
    test_outcome: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
    unstaged_confirmed: { type: 'boolean', description: 'true if changes were left UNSTAGED (git add NOT run, except add -N for new files)' },
    needs_user: { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    dismissed_count: { type: 'integer', description: 'how many review findings you declined and logged to DISMISSED this round (0 if none)' },
    gate_output: { type: 'string', description: 'tail of failing gate output, or "" if green' },
    notes: { type: 'string' },
  },
};

const QUALITY_SCHEMA = {
  type: 'object',
  required: ['clean', 'issue_count'],
  properties: {
    clean: { type: 'boolean', description: 'true if NO production-blocking defects were found in the unstaged diff' },
    issue_count: { type: 'integer', description: 'number of defects written to the review file' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED entries you re-raised as "CONTESTS DISMISSAL:" this round (0 if none)' },
  },
};

const ACCEPTANCE_SCHEMA = {
  type: 'object',
  required: ['pass', 'staged', 'fix_checks'],
  properties: {
    pass: { type: 'boolean', description: 'true if every claimed fix fully closes its root cause, gates are green, and nothing regressed' },
    staged: { type: 'boolean', description: 'true if you ran `git add` on the batch files (only on pass; NEVER commit)' },
    regression: { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged behavior' },
    fix_checks: {
      type: 'array',
      description: 'one entry per issue the fixer claimed FIXED',
      items: {
        type: 'object',
        required: ['issue_id', 'actually_fixed'],
        properties: {
          issue_id: { type: 'string' },
          actually_fixed: { type: 'boolean', description: 'the diff CLOSES THE ROOT CAUSE completely (not just the literal edit the issue described)' },
          note: { type: 'string', description: 'when false: the live residual path or what is still wrong' },
        },
      },
    },
    gap_count: { type: 'integer', description: 'unmet items written to the review file (0 on pass)' },
    suite_result: { type: 'string', description: 'observed outcome of running the FULL gates' },
  },
};

const ROLLBACK_SCHEMA = {
  type: 'object',
  required: ['reverted', 'gates_green'],
  properties: {
    reverted: { type: 'boolean', description: 'true if the batch files were restored to the staged baseline and created files deleted' },
    gates_green: { type: 'boolean', description: 'true if the gates pass again after the revert (the tree is clean for the next batch)' },
    files_restored: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
};

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['complete', 'gaps', 'suite_result'],
  properties: {
    complete: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'object', required: ['title', 'evidence'], properties: { title: { type: 'string' }, evidence: { type: 'string' } } } },
    suite_result: { type: 'string' },
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
BE TOKEN-ECONOMICAL (target ~150k tokens for your whole turn): read ONLY the files your task names.
Prefer targeted grep over broad reads. Don't restate large files back; act on them.`;

const STAGING = `STAGING CONTRACT (the batch boundary is git itself):
  • staged index + HEAD  = ACCEPTED baseline (prior blessed work). Treat as known-good.
  • unstaged working tree = THIS batch's work — the only thing under review.
  • The fixer NEVER stages content. The acceptance gate stages (git add, NEVER commit) only on pass.
  • Nothing is EVER committed — the user reviews \`git diff --cached\` and commits.`;

// The settled-decisions both resolve reviewers read so they don't re-raise closed findings (but NOT
// prior review files — that would anchor them; see WORKFLOW-PRINCIPLES.md #5).
const settled = (batchId, canContest = true) => `Before reviewing, READ these if they exist — they are the settled decisions, so you do
NOT re-raise what is already closed:
  • ${dismissedFile(batchId)} — findings the fixer declined this batch, each with a one-line reason.
  • ${NEEDS_USER} — items already escalated to the user.
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files — review the CURRENT
diff FRESH (so you also catch new or similar nearby issues, and independently re-verify earlier fixes).${canContest ? `
If you are confident a DISMISSED reason is WRONG and the issue is genuinely production-blocking, raise
it ONCE, prefixed "CONTESTS DISMISSAL:", explaining why the reason does not hold.` : ''}`;

const matrix = (batchId) => `DECISION MATRIX — for each ambiguity or review finding, route it yourself IN ORDER (first match wins):
  1. Not a real problem / false positive .............. DROP — LOG it (see LOGGING).
  2. Pre-existing in untouched code (not yours) ....... DROP silently (out of scope; never fix — regression risk).
  3. Stops the build/tests ............................ FIX (always).
  4. A real, clear, in-scope fix (local, small) ....... FIX.
  5. Needed to make THIS batch's fix actually hold .... FIX.
  6. Conflicts with the issue / intentional / not a real path ... DROP — LOG it (see LOGGING).
  7. A genuine DESIGN/BUSINESS choice only the USER can make, OR a blocker you cannot resolve in scope
        .............................................. ESCALATE (see LOGGING).
  8. Anything else (style, medium/low polish, a different issue) ... DROP silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. NEVER log the same dismissal twice.

LOGGING — this (plus your code) is your ONLY output. Keep it minimal and unambiguous:
  • DROP (1 or 6): append ONE terse line to ${dismissedFile(batchId)} so reviewers won't re-raise it —
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • ESCALATE (7): append a FULL, self-contained entry to ${NEEDS_USER} (as much detail as the user
    needs to decide). If you CANNOT proceed without the answer, set needs_user=true (the run HALTS).
    If you can proceed with a defensible default, record it there too but leave needs_user=false.`;

// =============================================================================
// Review-phase prompts
// =============================================================================
const reviewPrompt = (unit, handled) => `
You are the REVIEWER examining ONE bounded unit of a codebase for PRODUCTION READINESS. This is a
FIND-ONLY pass: you report defects; a verified+batched phase fixes them later. Do NOT modify any file.
${ENV}
UNIT: ${unit.id}
FILES TO REVIEW (read them fully; review ONLY these files):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}

Assess against these criteria and report concrete, located issues:
  correctness, security, error-handling, resource-leak (unclosed handles/timers/sockets),
  data-integrity, types, api-contract, concurrency (races, shared state), testing (missing coverage
  of risky paths), performance, maintainability, convention adherence.

RULES:
- SEVERITY FLOOR: report ONLY ${REVIEW_SEV_NAME}+ production DEFECTS. Do NOT report below-floor,
  stylistic, or speculative "could be more defensive" suggestions — they are dropped downstream and
  only waste the verify stage. If in doubt it's below the floor, omit it.
- READ THE CURRENT FILE CONTENTS before reporting. Do NOT report anything already handled in the code
  as it exists now${handled.length ? ', and do NOT re-report anything in the ALREADY FOUND list below (even rephrased)' : ''}.
- Stay INSIDE this unit's files. Cross-file concerns: mention as context in detail, do not chase.
- Report DEFECTS, not redesigns. No speculative rewrites, no gold-plating, no scope creep.
- Each finding: specific file + line, the right category/severity, what's wrong and why it matters in
  production, and a minimal suggested_fix direction.${handled.length ? `\n\nALREADY FOUND in a prior pass (do NOT re-report):\n${handled.map((t) => `  - ${t}`).join('\n')}` : ''}

Return findings via the schema. An empty findings array means this unit is clean — a normal, good outcome.`;

const verifyPrompt = (unit, items) => `
You are the VERIFIER (read-only on SOURCE — you write exactly one inventory file and nothing else). For
each candidate finding below, inspect the ACTUAL code in the repo to confirm it is real, correct its
severity, then route it with the decision matrix. Reject false positives and gold-plating ruthlessly —
a noisy inventory wastes the user's triage time and the fixer's context.
${ENV}
UNIT: ${unit.id}
${items.length ? `CANDIDATE FINDINGS (finding_id :: file :: category/severity :: title):
${items.map((i) => `  - ${i.id} :: ${i.f.file}${i.f.line ? ':' + i.f.line : ''} :: ${i.f.category}/${i.f.severity} :: ${i.f.title}\n      ${i.f.detail}\n      suggested: ${i.f.suggested_fix || '(none)'}`).join('\n')}

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
Also set a short \`theme\` keyword per verdict so related issues can be batched together.` : `The reviewer found NO defects in this unit. Confirm nothing needs recording (verdicts = []).`}

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

**What:** <detail — what's wrong and why it matters in production>
**Fix:** <fix_instruction>            (ACTIONABLE; for NEEDS_USER leave the chosen option for the user)
**Options:** <options>                (NEEDS_USER only)
**Recommendation:** <recommendation>  (NEEDS_USER only)
-----
If there are NO kept verdicts, write the frontmatter + heading + the single line "No issues found."
Do NOT write issues.json, any shared doc, or modify source. Set wrote_file=true and return all verdicts via the schema.`;

// =============================================================================
// Resolve-phase prompts
// =============================================================================
const fixPrompt = (batch, round, reviewPath, issuePaths) => `
You are the FIXER. Resolve the verified issues in this batch — exactly as instructed, minimally and
surgically. NO opportunistic refactors, NO scope creep beyond what each fix requires.
${ENV}
${STAGING}
BATCH ${batch.id} (round ${round} of max ${MAX_ROUNDS}) — ${batch.issues.length} issue(s) across files: ${[...new Set(batch.issues.map((i) => i.file))].join(', ')}
${round === 1
    ? `ISSUES TO FIX — read each one's FULL entry (What / Fix) VERBATIM from these inventory file(s):
${issuePaths.map((p) => `  - ${p}`).join('\n')}
The issue ids in this batch: ${batch.issues.map((i) => `${i.id} [${i.severity}/${i.category}] ${i.file}${i.line ? ':' + i.line : ''}`).join('; ')}`
    : reviewPath
      ? `A prior review flagged problems — READ ${reviewPath} and resolve exactly those. Your earlier work is
already in the UNSTAGED working tree: build ON it, do NOT revert or redo it. Re-read the issue file(s)
if you need the original instruction: ${issuePaths.join(', ')}.`
      : `A prior round's build/tests were not green. Your earlier work is in the UNSTAGED tree — re-run the
gate, see what is failing, and fix it. Build ON your work; do NOT revert it.`}
${round === 1 ? '' : `If ${dismissedFile(batch.id)} exists, READ it first — it is YOUR running ledger of declined findings: do not
duplicate an entry. If the review RE-RAISES one as \`CONTESTS DISMISSAL:\`, you MUST FIX or ESCALATE it.`}

PROCEDURE:
1. VERIFY-FIRST: the inventory was written from a past snapshot — for EACH issue, read the current code
   and confirm it still exists. If it was already fixed or no longer applies, mark it STALE and move on.
   Never "fix" what isn't there.
2. Apply each confirmed fix per its Fix instruction. Match surrounding style and the CONVENTIONS. Where a
   fix warrants a pinning test (regressions, tricky edge cases, 'testing' issues), write it. Never weaken
   or delete existing tests to make gates pass; never disable lint rules.
3. RUN THE GATES from the repo root and record honest results (build_passed, test_outcome). If a fix
   breaks a gate and you cannot resolve it within the fix's own scope: revert THAT change surgically,
   mark the issue FAILED with the reason, and keep the rest.
4. LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content, do NOT commit. EXCEPTION: for any file you
   CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add) so the reviewer's \`git diff\` shows it.
   Set unstaged_confirmed=true.
5. ${matrix(batch.id)}
6. SELF-REVIEW your own diff before returning and fix anything obviously wrong.
Return ONLY the decision fields via the schema (your code IS the output).`;

// BLIND. No issue text, no inventory path — judges the diff purely as code.
const qualityPrompt = (batch, round) => `
You are a CODE CRITIC. You have NO information about what these changes are for or what issue they were
meant to fix — and you must not seek any (do NOT read any inventory/issue file). Judge the code PURELY
ON ITS OWN MERITS: did this diff INTRODUCE or BREAK anything?
TARGET REPO: ${REPO}

${settled(batch.id)}

SCOPE — review ONLY this batch's UNSTAGED work:
  \`git -C ${REPO} diff\`                    (unstaged tracked changes — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) — \`git diff\` OMITS new files.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline — context only, do NOT review it.

Report ONLY ${CRITIC_SEV_NAME}+ defects INTRODUCED by this diff: real correctness/security/regression/
data-integrity/error-handling/api-contract bugs, or anything that breaks the build or tests. DROP
silently: anything pre-existing in the baseline, style, naming, medium/low polish, speculation,
redesigns. An EMPTY result is the normal, GOOD outcome.

WRITE your findings to ${qualityFile(batch.id, round)} (create ${STATE_DIR}/ if needed): one section per
defect — file:line, what's wrong, why it's production-blocking, a concrete fix. If none, write exactly
"No production-blocking defects found." Then return clean (true if NO findings, including no contests) +
issue_count + contested_dismissals via the schema. Do NOT modify source, stage, or commit.`;

const acceptancePrompt = (batch, round, claimedFixed, issuePaths) => `
You are the ACCEPTANCE VERIFIER — the issue-aware gate. The blind code review already passed. Your job:
prove each claimed fix FULLY CLOSES ITS ROOT CAUSE and that nothing regressed. Read the batch's issue
file(s) for the original defect text:
${issuePaths.map((p) => `  - ${p}`).join('\n')}
${ENV}
${STAGING}

${settled(batch.id, false)}
OVERRIDE: ${dismissedFile(batch.id)} entries are the fixer's judgment calls. You are issue-aware — if a
dismissed item actually leaves a claimed fix incomplete or causes a regression, that OVERRIDES the
dismissal: fail acceptance for it and record it in your review file.

SCOPE — this batch's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  \`git -C ${REPO} diff --staged\` = accepted baseline (compare against it for regressions).

JOB 1 — ROOT-CAUSE COMPLETENESS. The fixer claims these issues FIXED. For EACH, read its full entry in
the issue file, then INDEPENDENTLY re-derive the defect's root cause from the CURRENT code — do NOT just
confirm the literal edit the issue described is present; the issue itself may have under-scoped the bug.
A fix counts as landed ONLY if it closes that root cause COMPLETELY. If the same mechanism still has a
live residual path the diff left open (a sibling code path, an already-started async chain that still
writes the bad state, an untouched branch or caller with the identical defect), that is
actually_fixed=false with a concrete note — EVEN IF the described edit was made.
${claimedFixed.map((i) => `  - ${i.id} :: ${i.file} — ${i.title}`).join('\n') || '  (none claimed fixed)'}
Return one fix_check per claimed issue.

JOB 2 — REGRESSION + GATES. Compare the unstaged diff against the staged baseline; confirm no
previously-working behavior changed or broke. Run the FULL gates once and record the real outcome:
  build: ${GATES.build ?? '(none)'}    test: ${GATES.test ?? '(none)'}

WRITE ${acceptanceFile(batch.id, round)} (create ${STATE_DIR}/ if needed): the per-issue root-cause
verdict (with the residual path for any incomplete one), the regression result, the gate output, and
each gap — or "All fixes close their root cause; no regression." Then DECIDE:
  • Every fix complete, gates green, no regression → \`git -C ${REPO} add <the batch's changed AND newly-
    created files>\` (NEVER commit); return pass=true, staged=true.
  • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next fix round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;

const rollbackPrompt = (batch) => `
You are restoring the git baseline after a batch FAILED to pass within its round budget. The accepted
baseline is STAGED; this batch's unsuccessful work is UNSTAGED and must be removed so the next batch
starts from a clean diff.
${ENV}
${STAGING}
BATCH ${batch.id}. Files this batch touched: ${[...new Set(batch.issues.map((i) => i.file))].join(', ')}
PROCEDURE:
1. \`git -C ${REPO} status --porcelain\` to see the unstaged + untracked changes.
2. Restore every tracked file this batch modified to the staged baseline: \`git -C ${REPO} checkout -- <files>\`.
   Delete any file this batch CREATED (untracked, and any \`git add -N\` intent-to-add entries).
3. Confirm \`git -C ${REPO} diff\` is EMPTY (clean tree) and run the GATES to confirm they are green again.
Do NOT touch the staged baseline or any file outside this batch. Return reverted + gates_green via the schema.`;

const sweepPrompt = (counts) => `
You are the FINAL SWEEP. Every batch has been processed. Verify the campaign's end state honestly.
${ENV}
${STAGING}
EXPECTED ACCOUNTING: ${JSON.stringify(counts)}
PROCEDURE (read-only except step 3):
1. Run the FULL gates once and record the real outcome (suite_result).
2. Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): plausible for what was fixed?
   Confirm the unstaged tree is CLEAN (nothing half-done left behind; \`git status --porcelain\` too).
3. WRITE ${SWEEP_FILE}: suite result, staged-diff summary, accounting table, each gap with evidence — or
   "No gaps found." Do NOT modify source code, stage, or commit.
Return via the schema.`;

// =============================================================================
// PHASE: review — fan out reviewer → verifier per unit (read-only, concurrent), then STOP.
// The main agent supplies args.units (gen-manifest.mjs output it read) and, on resume, only the
// units whose issues/<unit>.md is missing or whose embedded hash changed. The engine reviews
// whatever units it is given — there is no loader/scribe/organizer (WORKFLOW-PRINCIPLES.md #4/#6).
// =============================================================================
if (PHASE === 'review') {
  const units = A.units;
  if (!Array.isArray(units) || !units.length) {
    throw new Error('phase "review" requires a non-empty args.units array (run gen-manifest.mjs, read it, and pass units — see CLAUDE.md). On resume pass only the units lacking an issue file or whose hash changed.');
  }
  log(`review: ${units.length} unit(s) → ${ISSUES_DIR} [passes=${REVIEW_PASSES}, floor=${REVIEW_SEV_NAME}]`);

  // Read-only fan-out: each unit flows reviewer → verifier independently and concurrently.
  const results = await pipeline(
    units,
    // -- Review (1..REVIEW_PASSES, deduped by file:category across passes) ----
    async (unit) => {
      const found = [];
      const sigs = new Set();
      const handled = [];
      for (let p = 1; p <= REVIEW_PASSES; p++) {
        const r = await agent(reviewPrompt(unit, handled), roleOpts('review', {
          schema: REVIEW_SCHEMA, phase: 'Review',
          label: `review:${unit.id}${REVIEW_PASSES > 1 ? ` p${p}` : ''}`,
        }));
        for (const f of (r?.findings || [])) {
          if ((SEV_RANK[f.severity] ?? 1) < REVIEW_SEV) continue;
          // Dedup across passes on file+category: re-reviews re-phrase the same concern, so
          // title-based dedup leaks duplicates into the inventory.
          const s = `${f.file}:${f.category}`;
          if (sigs.has(s)) continue;
          sigs.add(s);
          handled.push(f.title);
          found.push(f);
        }
      }
      return { unit, findings: found };
    },
    // -- Verify + write the unit inventory file (always, even when clean) ------
    async (r) => {
      const { unit, findings } = r;
      const items = findings.map((f, i) => ({ id: `${slug(unit.id)}-${i + 1}`, f }));
      const verify = await agent(verifyPrompt(unit, items), roleOpts(items.length ? 'verify' : 'review', {
        schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${unit.id}`,
      }));
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
    nextStep: `Present the inventory: read ${ISSUES_DIR}/*.md and walk the user through totals, the hottest areas, and every NEEDS_USER item (open needsUserFiles for its options + recommendation). Triage by EDITING those files: set a NEEDS_USER item's decision to ACTIONABLE and write the chosen option into its Fix line, or flip any decision to SKIP. Then grep the ACTIONABLE issues into args.issues and run phase:"resolve" (start scoped with resolveOnly).`,
  };
}

// =============================================================================
// PHASE: resolve — batch the approved issues, fix → BLIND review → issue-aware acceptance → stage.
// The main agent supplies args.issues (the triaged inventory it grepped from issues/*.md) and has
// already ensured a clean/staged baseline (#4) — there is no loader/baseline/scribe agent.
// =============================================================================
if (PHASE !== 'resolve') throw new Error(`Unknown phase "${PHASE}" — use "review" or "resolve".`);

const issues = A.issues;
if (!Array.isArray(issues) || !issues.length) {
  throw new Error('phase "resolve" requires args.issues — the ACTIONABLE issues the main agent grepped from runs/<runId>/issues/*.md after triage. Each: { id, unit, file, line, loc, severity, category, decision, effort, theme }. None supplied.');
}

const resolveOnly = Array.isArray(A.resolveOnly) && A.resolveOnly.length ? A.resolveOnly : null;
const inScope = (i) => !resolveOnly || resolveOnly.some((s) => s === i.id || i.file.startsWith(s));
const open = issues.filter((i) =>
  i.decision === 'ACTIONABLE'
  && (SEV_RANK[i.severity] ?? 1) >= FIX_SEV
  && inScope(i));
log(`inventory: ${issues.length} issue(s) supplied — ${open.length} open actionable at-or-above the ${A.fixSeverity ?? 'medium'} fix floor${resolveOnly ? ' (scoped by resolveOnly)' : ''}`);
if (!open.length) throw new Error('No ACTIONABLE issues at or above the fix floor in args.issues (after resolveOnly scoping). Nothing to resolve.');

// ---- Deterministic batcher: same file always together; group by area; cap by LOC + count -------
function buildBatches(items) {
  const area = (f) => (f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)');
  const sorted = [...items].sort((a, b) =>
    area(a.file).localeCompare(area(b.file))
    || a.file.localeCompare(b.file)
    || String(a.theme || '').localeCompare(String(b.theme || ''))
    || String(a.id).localeCompare(String(b.id)));
  const batches = [];
  let cur = [], curFiles = new Set(), curLoc = 0;
  const flush = () => { if (cur.length) { batches.push(cur); cur = []; curFiles = new Set(); curLoc = 0; } };
  for (const it of sorted) {
    const newFile = !curFiles.has(it.file);
    const addLoc = newFile ? (it.loc || 200) : 0;
    if (cur.length && newFile && (curLoc + addLoc > BATCH_LOC || cur.length >= BATCH_MAX)) flush();
    cur.push(it);
    curFiles.add(it.file);
    curLoc += addLoc;
  }
  flush();
  return batches.map((items_, i) => ({
    id: `batch-${String(i + 1).padStart(2, '0')}-${slug(area(items_[0].file))}`,
    issues: items_,
    units: [...new Set(items_.map((x) => x.unit).filter(Boolean))],
    loc: [...new Set(items_.map((x) => x.file))].reduce((s, f) => s + (items_.find((x) => x.file === f)?.loc || 0), 0),
  }));
}

const batches = buildBatches(open);
log(`batched ${open.length} issue(s) into ${batches.length} batch(es): ${batches.map((b) => `${b.id} (${b.issues.length} issues, ~${b.loc} LOC)`).join('; ')}`);

const ledger = [];
let halted = false;
let blockerReason = '';
let contestedTotal = 0;

for (const batch of batches) {
  if (halted) break;
  if (budget.total && budget.remaining() < MIN_BATCH_BUDGET) {
    log(`⏸ stopping before ${batch.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minBatchBudget) — resume with the same args to continue`);
    break;
  }
  log(`▶ ${batch.id}: ${batch.issues.length} issue(s) in ${[...new Set(batch.issues.map((i) => i.file))].length} file(s)`);

  // Issue inventory file path(s) the fixer + acceptance read verbatim for this batch.
  const issuePaths = batch.units.length ? batch.units.map((u) => issueFile(u)) : [...new Set(batch.issues.map((i) => issueFile(i.unit || batch.id)))];
  const statusById = new Map(batch.issues.map((i) => [i.id, { status: 'needs-attention', summary: 'not reached' }]));
  const record = { id: batch.id, issues: batch.issues.length, rounds: 0, status: 'pending', gates: null, staged: false };

  let round = 0, reviewPath = '', accepted = false, allStale = false;
  const fixedIds = new Set();   // FIXED issue ids accumulated across rounds → acceptance's checklist is batch-cumulative
  while (round < MAX_ROUNDS) {
    round++;
    record.rounds = round;

    // ---- FIX -----------------------------------------------------------------
    phase('Fix');
    const fix = await agent(fixPrompt(batch, round, reviewPath, issuePaths), roleOpts('fix', {
      schema: FIX_SCHEMA, phase: 'Fix', label: `fix:${batch.id} r${round}`,
    }));
    record.gates = { build: fix?.build_passed ?? null, tests: fix?.test_outcome ?? null };
    for (const r of (fix?.results || [])) {
      if (!statusById.has(r.issue_id)) continue;
      const s = r.status.toLowerCase();
      statusById.set(r.issue_id, { status: s === 'stale' ? 'stale' : s === 'fixed' ? 'fixed' : 'needs-attention', summary: r.summary || '' });
    }
    if (fix?.dismissed_count) log(`  r${round}: fixer declined ${fix.dismissed_count} finding(s) → ${dismissedFile(batch.id)} (audit these)`);
    if (fix?.needs_user === true) {
      halted = true;
      blockerReason = `Fixer escalated a user-only decision during ${batch.id} round ${round} (see ${NEEDS_USER}).`;
      record.status = 'BLOCKED';
      log(`  ✋ BLOCKER during ${batch.id} r${round} → halting run (see ${NEEDS_USER})`);
      break;
    }
    const gateMet = gateOk(fix);
    for (const r of (fix?.results || [])) if (r.status === 'FIXED') fixedIds.add(r.issue_id);
    const claimedFixed = [...fixedIds].map((id) => batch.issues.find((i) => i.id === id)).filter(Boolean);
    const produced = (fix?.results || []).some((r) => r.status === 'FIXED' || r.status === 'FAILED');

    // Nothing produced this round + gates green: no changes to review, stage, or roll back. Truly
    // all-stale is a clean outcome; an all-SKIPPED batch is not (its issues stay needs-attention).
    if (!produced && gateMet) {
      allStale = true;
      const onlyStale = (fix?.results || []).length > 0 && (fix?.results || []).every((r) => r.status === 'STALE');
      record.status = onlyStale ? 'all-stale' : 'no-changes';
      log(`  ${batch.id} r${round}: ${onlyStale ? 'every issue stale (already resolved in current code)' : 'no changes produced (issues skipped or stale)'}`);
      break;
    }
    if (!gateMet) {
      reviewPath = '';
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${batch.id} r${round}: gate still not green at round budget`); break; }
      log(`  ↻ ${batch.id} r${round}: gate not green (build=${fix?.build_passed}, test=${fix?.test_outcome}) → another fix round`);
      continue;
    }

    // ---- QUALITY REVIEW (blind, must pass before acceptance) -----------------
    phase('Quality');
    const quality = await agent(qualityPrompt(batch, round), roleOpts('quality', {
      schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality:${batch.id} r${round}`,
    }));
    if (quality?.contested_dismissals) { contestedTotal += quality.contested_dismissals; log(`  ⚠ ${batch.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — fixer must fix or escalate`); }
    if (quality?.clean !== true) {
      reviewPath = qualityFile(batch.id, round);
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${batch.id} r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget`); break; }
      log(`  ↻ ${batch.id} r${round}: blind review found ${quality?.issue_count ?? '?'} issue(s) → fix addresses ${reviewPath}`);
      continue;
    }

    // ---- ACCEPTANCE (issue-aware; stages on pass) ----------------------------
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(batch, round, claimedFixed, issuePaths), roleOpts('acceptance', {
      schema: ACCEPTANCE_SCHEMA, phase: 'Acceptance', label: `accept:${batch.id} r${round}`,
    }));
    if (acc?.regression) record.regression = true;
    if (acc?.pass === true) {
      accepted = true;
      record.status = 'accepted';
      record.staged = acc?.staged === true;
      log(`  ✓ ${batch.id} accepted after ${round} round(s) (staged=${record.staged}, suite=${acc?.suite_result || 'n/a'})`);
      break;
    }
    reviewPath = acceptanceFile(batch.id, round);
    const bad = (acc?.fix_checks || []).filter((c) => c.actually_fixed === false);
    if (round >= MAX_ROUNDS) { log(`  ⚠ ${batch.id} r${round}: ${acc?.gap_count ?? bad.length} gap(s) at round budget`); break; }
    log(`  ↻ ${batch.id} r${round}: acceptance found ${acc?.gap_count ?? bad.length} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → fix addresses ${reviewPath}`);
  }

  // ---- Terminal-failure rollback: restore the batch so the next one starts clean ----------------
  if (!accepted && !allStale && !halted) {
    phase('Rollback');
    const rb = await agent(rollbackPrompt(batch), roleOpts('fix', {
      schema: ROLLBACK_SCHEMA, phase: 'Rollback', label: `rollback:${batch.id}`,
    }));
    record.status = 'needs-attention (reverted)';
    log(`  ⚠ ${batch.id}: round budget exhausted — reverted to baseline (reverted=${rb?.reverted}, gates=${rb?.gates_green ? 'green' : 'RED'}), issues marked needs-attention`);
    if (rb?.gates_green === false) { halted = true; blockerReason = `Gates not green after rolling back ${batch.id}; tree unsafe for the next batch.`; }
  }
  if (record.status === 'pending') record.status = 'needs-attention (loop end)';

  // Finalize per-issue outcomes (in-memory; returned to the main agent — no progress files).
  const perIssue = batch.issues.map((i) => {
    const st = statusById.get(i.id) || { status: 'needs-attention', summary: '' };
    const final = (record.status === 'accepted' || record.status === 'all-stale') ? st.status : (st.status === 'stale' ? 'stale' : 'needs-attention');
    return { id: i.id, file: i.file, status: final, summary: st.summary };
  });
  record.fixed = perIssue.filter((p) => p.status === 'fixed').length;
  record.stale = perIssue.filter((p) => p.status === 'stale').length;
  record.needsAttention = perIssue.filter((p) => p.status === 'needs-attention').length;
  record.perIssue = perIssue;
  ledger.push(record);
  log(`  → ${batch.id}: ${record.status} (fixed ${record.fixed}, stale ${record.stale}, needs-attention ${record.needsAttention})`);
}

// ---- Optional final sweep --------------------------------------------------------------------
let sweep = null;
const processedAll = !halted && ledger.length === batches.length;
if (A.finalSweep !== false && processedAll) {
  phase('Sweep');
  const counts = {
    actionable_in_scope: open.length,
    fixed: ledger.reduce((s, r) => s + r.fixed, 0),
    stale: ledger.reduce((s, r) => s + r.stale, 0),
    needs_attention: ledger.reduce((s, r) => s + r.needsAttention, 0),
  };
  sweep = await agent(sweepPrompt(counts), roleOpts('sweep', { schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep' }));
  log(sweep?.complete ? `sweep: accounting clean (suite: ${sweep?.suite_result || 'n/a'})` : `sweep: ${(sweep?.gaps || []).length} gap(s) — see ${SWEEP_FILE}`);
}

return {
  phase: 'resolve',
  runId: RUN_ID,
  halted,
  blockerReason: halted ? blockerReason : '',
  stateDir: STATE_DIR,
  contestedDismissals: contestedTotal,
  sweep: sweep ? { complete: sweep.complete === true, gaps: (sweep.gaps || []).length, suite: sweep.suite_result || '' } : null,
  summary: {
    batchesProcessed: ledger.length,
    batchesAccepted: ledger.filter((r) => r.status === 'accepted' || r.status === 'all-stale').length,
    issuesFixed: ledger.reduce((s, r) => s + r.fixed, 0),
    issuesStale: ledger.reduce((s, r) => s + r.stale, 0),
    issuesNeedsAttention: ledger.reduce((s, r) => s + r.needsAttention, 0),
  },
  ledger: ledger.map((r) => ({ id: r.id, status: r.status, rounds: r.rounds, fixed: r.fixed, stale: r.stale, needsAttention: r.needsAttention, regression: r.regression === true, gates: r.gates })),
  followups: halted
    ? `Run halted — ${blockerReason} Resolve it with the user, then re-invoke phase:"resolve" with the remaining open issues (re-grep issues/*.md; already-fixed issues are now staged).`
    : `Review the staged diff in ${REPO} (git diff --cached), the numbered review files + DISMISSED-*.md in ${STATE_DIR}/${sweep && sweep.complete !== true ? `, and ${SWEEP_FILE} (gaps!)` : ''}. needs-attention batches were rolled back to baseline — retry them interactively with their acceptance-review file as context. Nothing is committed — you commit.`,
};
