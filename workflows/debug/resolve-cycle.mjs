export const meta = {
  name: 'resolve-cycle',
  description: 'Batched fix loop over a triaged issue inventory, lean/file-bus design. The main agent supplies the approved issues (from the sibling review.mjs, or hand-authored from live/manual testing); this engine batches them by area/LOC and runs fix → BLIND pure-code review (catches anything the fix broke) → issue-aware acceptance (re-derives each defect\'s root cause, confirms it is fully closed + no regression, stages on pass), looped per batch. A failed batch rolls back to the staged baseline; an optional sweep brackets the run. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Fix a verified, triaged issue inventory in one target git repo. Findings come from the sibling review.mjs OR from live/manual testing, a bug bash, or user reports (you hand-author runs/<runId>/issues/<unit>.md in the verifier format). The main agent greps the ACTIONABLE issues into args.issues, ensures a clean/staged baseline, then runs this engine with the SAME runId + root as review.mjs: it batches by area/LOC and fixes each batch behind a two-stage review (BLIND quality, then issue-aware acceptance), staging accepted work. Nothing is ever committed.',
  phases: [
    { title: 'Fix', detail: 'Fixer reads its batch\'s issue file(s) verbatim, verify-first, fixes minimally, runs gates, leaves work UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no issue text), flags defects the fix introduced or broke. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Issue-aware gate: re-derives each claimed fix\'s root cause from current code, confirms it is fully closed + no regression + gates green. Writes acceptance-review; on pass, STAGES the batch.' },
    { title: 'Rollback', detail: 'On terminal batch failure only: restores the batch to the staged baseline so the next batch starts from a clean diff; its issues are marked needs-attention.' },
    { title: 'Sweep', detail: 'Optional final accounting: full gates, staged-diff spot-check, every issue has a terminal status. Writes SWEEP.md.' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
// The harness reads NO files: after triage the main agent greps runs/<runId>/issues/*.md into
// args.issues and supplies it here (same runId + root as review.mjs). The per-unit issue files ARE the
// inventory; the fixer + acceptance read them verbatim (no issues.json, no organizer — see
// WORKFLOW-PRINCIPLES.md #2/#4/#6). The main agent also ensures a clean/staged baseline before this
// engine runs (#4) — there is no loader/baseline/scribe agent.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, target, gates, conventions, issues }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally this workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
const MAX_ROUNDS  = A.maxRounds ?? 2;                       // fix → quality → acceptance repair rounds per batch
const BATCH_LOC   = A.batch?.locCap ?? 3000;               // max summed LOC of distinct files per batch (~150-250k tokens/agent)
const BATCH_MAX   = A.batch?.maxIssues ?? 10;              // max issues per batch (soft — same-file issues never split)
const MIN_BATCH_BUDGET = A.minBatchBudget ?? 150_000;      // with a token target set, stop cleanly between batches below this

// Severity floors. resolve fixes >= fixSeverity; the blind critic floors NEW defects at criticSeverity.
// The inventory is CLOSED (produced by review.mjs, or hand-authored), so fixing mediums HERE converges
// (no fresh review surfaces a new batch each round).
const SEV_RANK    = { low: 1, medium: 2, high: 3, critical: 4 };
const FIX_SEV     = SEV_RANK[A.fixSeverity ?? 'medium'];
const CRITIC_SEV_NAME = A.criticSeverity ?? 'high';        // floor for NEW defects the blind reviewer reports in a fix diff

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType
// that exists in YOUR registry. Fix + acceptance are opus (high stakes); the blind quality critic is
// the fast tier.
const AT = { ...(A.agentTypes ?? {}) };
const M  = { fix: 'opus', quality: 'sonnet', acceptance: 'opus', sweep: 'sonnet', ...(A.models ?? {}) };
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

// CONTRACT with review.mjs — change both together. The issue-file path scheme
// runs/<runId>/issues/<fileSafe(unit)>.md is the interface between the two engines AND the user's triage
// surface; review.mjs writes the IDENTICAL path from runId + root (+ stateDir if overridden). Use the
// SAME values for all three across both engines — a mismatch silently points the fixer at missing
// issue files.
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
// Resolve-phase prompts
// CONTRACT with review.mjs — change both together. The fixer + acceptance below read each unit's issue
// file VERBATIM and depend on its block format (frontmatter + `### [<id>]` blocks + `- ` header lines +
// the `**Fix:**` line), authored by review.mjs's verifier. Keep the two engines in lockstep.
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
// Batch the approved issues, fix → BLIND review → issue-aware acceptance → stage.
// The main agent supplies args.issues (the triaged inventory it grepped from issues/*.md) and has
// already ensured a clean/staged baseline (#4) — there is no loader/baseline/scribe agent.
// =============================================================================
const issues = A.issues;
if (!Array.isArray(issues) || !issues.length) {
  throw new Error('resolve-cycle requires args.issues — the ACTIONABLE issues the main agent grepped from runs/<runId>/issues/*.md after triage (use the SAME runId + root as review.mjs). Each: { id, unit, file, line, loc, severity, category, decision, effort, theme }. None supplied.');
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
// (Kept although feature-cycle's roadmap omits its sweep: resolve batches ROLL BACK and continue, so the
// end state mixes accepted + reverted batches — the sweep's full-gate run + accounting reconciles it.)
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
    ? `Run halted — ${blockerReason} Resolve it with the user, then re-invoke resolve-cycle.mjs with the remaining open issues (re-grep issues/*.md; already-fixed issues are now staged).`
    : `Review the staged diff in ${REPO} (git diff --cached), the numbered review files + DISMISSED-*.md in ${STATE_DIR}/${sweep && sweep.complete !== true ? `, and ${SWEEP_FILE} (gaps!)` : ''}. needs-attention batches were rolled back to baseline — retry them interactively with their acceptance-review file as context. Nothing is committed — you commit.`,
};
