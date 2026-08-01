export const meta = {
  name: 'resolve-cycle',
  description: 'Batched fix loop over a triaged issue inventory, lean/file-bus design. The main agent supplies the approved issues (from the sibling review.mjs, or hand-authored from live/manual testing); this engine batches them by area/LOC and runs fix → BLIND pure-code review (catches anything the fix broke) → issue-aware acceptance (re-derives each defect\'s root cause, confirms it is fully closed + no regression, stages on pass), looped per batch. A failed batch is PARKED — its work is saved to a patch file, then cleared from the tree so the next batch starts clean; nothing is discarded. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Fix a verified, triaged issue inventory in one target git repo. Findings come from the sibling review.mjs OR from live/manual testing, a bug bash, or user reports (you hand-author runs/<runId>/issues/<unit>.md in the verifier format). The main agent greps the ACTIONABLE issues into args.issues, ensures a clean/staged baseline, then runs this engine with the SAME runId + root as review.mjs: it batches by area/LOC and fixes each batch behind a two-stage review (BLIND quality, then issue-aware acceptance), staging accepted work. Nothing is ever committed.',
  phases: [
    { title: 'Fix', detail: 'Fixer reads its batch\'s issue file(s) verbatim, verify-first, fixes minimally, runs gates, leaves work UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no issue text), flags defects the fix introduced or broke. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Issue-aware gate: re-derives each claimed fix\'s root cause from current code, confirms it is fully closed + no regression + gates green. Writes acceptance-review; on pass, STAGES the batch.' },
    { title: 'Park', detail: 'On EITHER terminal outcome — round budget exhausted, or a fixer escalation that halts the run: SAVES the batch\'s work to parked-<batch>.patch, then clears it from the tree. Nothing is destroyed, every exit leaves a clean unstaged tree, and the batch is recorded in NEEDS-USER.md for the user to restore, retry, or drop.' },
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
// args arrives from the Workflow tool VERBATIM and unvalidated, so a structural typo in a hand-built
// payload dies here as a bare parse error naming the runtime. Name the payload and the fix instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, target, gates, conventions, issues }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally this workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// `target.repo` is REQUIRED and has NO default. Every `git -C ${REPO}` in the fix, quality, acceptance
// and park prompts runs there — including park's `git checkout --` and file deletion. A silent fallback
// to `${ROOT}/.` would point that machinery at this workflow tool's own working tree.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the target git repo being fixed. There is no default — every git command (including park\'s checkout/delete) runs against it.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
// A non-numeric bound must THROW, never coerce. `round < 'three'` is false on the first test, so the
// repair loop would never run and every batch would come back needs-attention without a fixer ever having
// been spawned. A bad batch cap is the same shape one level up: it silently produces zero batches, i.e. a
// run that reports nothing to do. A documented default is not a licence to accept garbage.
// Nothing is COERCED: `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite, so a
// coercing check waves through exactly the garbage that silently disables a bound. The upper bound is not
// decoration either — a fat-fingered `maxRounds: 100000` otherwise spawns agents until something dies.
// The message leads with a STATIC clause because tools/gen-flows.mjs labels a throw node with the first
// clause of its static prefix; starting with `args.${name}` rendered the node as "throw: args.".
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round or zero-batch run and reports it as an ordinary result.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 2, 50);    // fix → quality → acceptance repair rounds per batch
const BATCH_LOC   = num(A.batch?.locCap, 'batch.locCap', 1, 3000);     // max summed LOC of distinct files per batch (~150-250k tokens/agent)
const BATCH_MAX   = num(A.batch?.maxIssues, 'batch.maxIssues', 1, 10); // max issues per batch (soft — same-file issues never split)
const MIN_BATCH_BUDGET = num(A.minBatchBudget, 'minBatchBudget', 0, 150_000); // with a token target set, stop cleanly between batches below this

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
const M  = { fix: 'opus', quality: 'sonnet', acceptance: 'opus', ...(A.models ?? {}) };
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
// repo so the blind quality reviewer cannot wander into it. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the issue files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
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
const parkedPatch    = (batchId) => `${STATE_DIR}/parked-${slug(batchId)}.patch`;    // a failed batch's work, saved before the tree is cleared
const parkedNewDir   = (batchId) => `${STATE_DIR}/parked-${slug(batchId)}-newfiles`; // untracked files the patch could not carry (rare)
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;                                // full detail; for the user (may halt the run)

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
    // Two ROUND-1 preconditions the harness cannot check itself (it has no shell). Both are reported
    // by the fixer BEFORE it edits anything, and either one halts the run before a single reviewer spawns.
    baseline_dirty_files: { type: 'integer', description: 'ROUND 1 ONLY: how many files were already modified/untracked in the UNSTAGED tree BEFORE you touched anything (git diff --name-only plus untracked from git status --porcelain). Must be 0 to proceed. -1 if you did not check (round 2+).' },
    issue_entries_found: { type: 'integer', description: 'ROUND 1 ONLY: how many `### [<id>]` blocks for THIS batch\'s issue ids you actually located in the inventory file(s) you were given. 0 means you could not read the inventory — the run halts. -1 if not applicable (round 2+, which addresses a review file instead).' },
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

const PARK_SCHEMA = {
  type: 'object',
  required: ['saved', 'cleared', 'gates_green'],
  properties: {
    saved: { type: 'boolean', description: 'true ONLY if the patch file was written and you confirmed it is non-empty. If false, you must NOT have cleared the tree.' },
    cleared: { type: 'boolean', description: 'true if the batch work was then removed from the working tree and `git diff` is empty' },
    gates_green: { type: 'boolean', description: 'true if the gates pass again after clearing (the tree is clean for the next batch)' },
    patch_bytes: { type: 'integer', description: 'size of the written patch file — 0 means nothing was saved' },
    strays_saved: { type: 'integer', description: 'how many untracked files you copied to the -newfiles dir in step 2 (0 if none). Non-zero means the restore needs a SECOND step beyond git apply, and step 4 must say so.' },
    notes: { type: 'string', description: 'anything the numbers above cannot say — above all WHY nothing was saved when there was nothing to park' },
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
${round === 1 ? `0. PRECONDITIONS — do these FIRST, before reading or editing anything else. The harness has no shell
   of its own, so you are the only thing that can check them.
   a. CLEAN BASELINE. Run \`git -C ${REPO} diff --name-only\` AND \`git -C ${REPO} status --porcelain\`
      (\`git diff\` omits untracked files). Report the count of already-dirty/untracked files as
      baseline_dirty_files. If it is NOT 0, STOP IMMEDIATELY: change nothing, fix nothing, and return
      right now with that count. Pre-existing unstaged work would be read as YOUR work by the reviewers
      and would fail this batch for someone else's changes.
   b. INVENTORY READABLE. Count how many \`### [<id>]\` blocks matching THIS batch's issue ids you can
      actually find in the inventory file(s) listed above; report it as issue_entries_found. If it is 0,
      STOP IMMEDIATELY and return — the paths you were handed do not contain this batch's issues (the
      runId/root/stateDir the engine computed them from is wrong), and "fixing" from memory would be
      worse than not running.
   Only when both are satisfied, continue.
` : ''}1. VERIFY-FIRST: the inventory was written from a past snapshot — for EACH issue, read the current code
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

// Park runs on BOTH terminal outcomes — a batch that exhausted its rounds, and a batch the fixer
// escalated (needs_user). In each case the work is saved and the tree is cleared, so every exit from
// this engine leaves a clean unstaged tree. That is what lets the next batch's reviewers scope
// correctly, lets a resume start from a known state, and lets the user run some other workflow against
// the repo without inheriting an abandoned diff.
const parkPrompt = (batch, lastReviewPath, escalated) => `
You are PARKING a batch that ${escalated
    ? `hit a BLOCKER the fixer escalated to the user (see ${NEEDS_USER}). The run stops after you, but its
work is NOT left lying in the working tree`
    : `FAILED to pass within its round budget. Its work is NOT thrown away`}: you
SAVE it to a patch file, then clear it from the working tree${escalated ? '' : ` so the NEXT batch starts from a clean diff
(the reviewers scope on the unstaged diff — leftover work would be attributed to the next batch and
cascade failures)`}. The accepted baseline is STAGED and must survive untouched.
${ENV}
${STAGING}
BATCH ${batch.id}. Files this batch touched: ${[...new Set(batch.issues.map((i) => i.file))].join(', ')}
Issue ids: ${batch.issues.map((i) => i.id).join(', ')}

SAVE BEFORE YOU CLEAR — never the other way round. If step 1 does not produce a non-empty patch, STOP:
leave the tree exactly as it is and return saved=false, cleared=false.

PROCEDURE:
1. SAVE. \`git -C ${REPO} status --porcelain\` first. If \`git -C ${REPO} diff\` is already EMPTY there is
   nothing to park — skip to step 3 and return saved=false, patch_bytes=0, with a note saying so.
   Otherwise write the batch's work to ${parkedPatch(batch.id)} (create ${STATE_DIR}/ if needed):
     \`git -C ${REPO} diff --binary > ${parkedPatch(batch.id)}\`
   \`--binary\` is REQUIRED (a plain diff records "Binary files differ" and will not re-apply). The
   unstaged diff IS exactly this batch's work, and files the fixer created are in it via \`git add -N\`.
   Then CONFIRM the file exists and is non-empty, and record its size as patch_bytes.
2. CATCH STRAYS. If \`git status --porcelain\` still lists any \`??\` untracked file this batch created
   (the fixer missed its \`git add -N\`), COPY those files into ${parkedNewDir(batch.id)}/ preserving
   relative paths — the patch CANNOT carry them. Skip build output and caches. Report how many you
   copied as strays_saved: the count matters, because step 4 must tell the user those files exist.
3. CLEAR. Restore every tracked file this batch modified to the staged baseline:
   \`git -C ${REPO} checkout -- <files>\`. Then delete the files this batch CREATED (untracked + any
   \`git add -N\` intent-to-add entries). Be precise about WHY each one is safe to delete: an
   intent-to-add file is carried by the patch from step 1; a \`??\` stray is safe ONLY because step 2
   copied it to ${parkedNewDir(batch.id)}/. If step 2 did not copy a stray, do NOT delete it.
   Confirm \`git -C ${REPO} diff\` is EMPTY, then run the GATES and record whether they are green again.
4. RECORD. Append ONE entry to ${NEEDS_USER}, under a \`## Parked batch: ${batch.id}\` heading:
   - the issue ids above, and that they remain **OPEN and undecided — this is a status record, NOT a
     dismissal**; nobody should treat these as settled or skip them because of this entry
   - one line on why it was parked (${escalated ? 'the blocker the fixer escalated' : 'which gate never passed'})
   - ${lastReviewPath ? `the diagnosis: \`${lastReviewPath}\`` : 'the last review file for this batch in ' + STATE_DIR}
   - the saved work: \`${parkedPatch(batch.id)}\`
   - restore command, verbatim: \`git -C ${REPO} apply --3way ${parkedPatch(batch.id)}\`
   - **ONLY IF step 2 actually copied stray files**: a line naming \`${parkedNewDir(batch.id)}/\` as
     holding new files the patch cannot carry, listing them, and telling the user to copy them back
     into the repo (preserving relative paths) as a SECOND step after the \`git apply\`. Omit this line
     entirely when there were no strays — do not leave a dangling reference to an empty directory.
   - the user's options: restore and finish by hand · re-run resolve scoped to these ids (the fix
     instructions can be sharpened in the issue file first) · drop the patch
Do NOT touch the staged baseline, do NOT commit, and do NOT modify any file outside this batch.
Return saved + cleared + gates_green + patch_bytes + strays_saved via the schema.`;

// =============================================================================
// Batch the approved issues, fix → BLIND review → issue-aware acceptance → stage.
// The main agent supplies args.issues (the triaged inventory it grepped from issues/*.md) and has
// already ensured a clean/staged baseline (#4) — there is no loader/baseline/scribe agent.
// =============================================================================
const issues = A.issues;
if (!Array.isArray(issues) || !issues.length) {
  throw new Error('resolve-cycle requires args.issues — the ACTIONABLE issues the main agent grepped from runs/<runId>/issues/*.md after triage (use the SAME runId + root as review.mjs). Each: { id, unit, file, line, loc, severity, category, decision, effort, title, theme }. None supplied.');
}
// Both gates are REQUIRED. `gateOk` skips the half whose command is unset, so a missing value does not
// fail loudly — it silently passes every round with nothing built or tested, and acceptance is handed
// "(none)" so it has no command to run either. A fix campaign assumes a green baseline; demand it.
if (typeof A.gates?.build !== 'string' || !A.gates.build.trim()) {
  throw new Error('args.gates.build is required: the shell command that defines a green build, run from the target repo root. There is no default — unset, gateOk() no-ops that half and every round "passes" unbuilt.');
}
if (typeof A.gates?.test !== 'string' || !A.gates.test.trim()) {
  throw new Error('args.gates.test is required: the shell command that runs the tests (it must already be GREEN before resolve). There is no default — unset, gateOk() no-ops that half and every round "passes" untested.');
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

  // `escalated` distinguishes the two halts: a fixer escalation leaves real work in the tree (park it),
  // while a round-1 precondition halt changed nothing at all (there is nothing to park).
  let round = 0, reviewPath = '', accepted = false, allStale = false, escalated = false;
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

    // ---- Round-1 preconditions: halt BEFORE any reviewer spawns ---------------
    // Both are things the harness cannot see for itself; the fixer checks them before doing any work,
    // so halting here costs one agent turn instead of maxRounds of agents chasing phantom findings.
    if (round === 1) {
      // A dead fixer must never reach the -1 sentinels below: optional chaining collapses BOTH fields
      // to "not applicable (round 2+)", so the two guards would be skipped for the one case they most
      // need to cover — the fixer never ran, so nothing was checked and no work can be assumed.
      if (fix == null) {
        halted = true;
        record.status = 'BLOCKED (fixer did not return)';
        blockerReason = `The round-1 fixer for ${batch.id} returned nothing (the agent died or produced no structured output). Neither round-1 precondition was verified — the baseline was never checked for pre-existing changes, and the inventory at\n  ${issuePaths.join('\n  ')}\nwas never confirmed readable — so no work can be assumed either way. Nothing was changed; re-run with the same args.`;
        log(`  ✋ ${batch.id}: round-1 fixer returned nothing → halting before any reviewer spawns (preconditions unverified)`);
        break;
      }
      const dirty = fix?.baseline_dirty_files ?? -1;
      if (dirty > 0) {
        halted = true;
        record.status = 'BLOCKED (dirty baseline)';
        blockerReason = `The working tree was NOT clean when ${batch.id} started: ${dirty} file(s) already modified or untracked in ${REPO}. Resolve needs the unstaged diff to be purely the current batch's work — pre-existing changes get attributed to the batch and fail it for someone else's edits. Fix it one of two ways, then re-run with the same args: \`git -C ${REPO} add -A\` to fold the existing work into the accepted baseline, or \`git -C ${REPO} stash\` to set it aside. Nothing was changed.`;
        log(`  ✋ ${batch.id}: baseline NOT clean (${dirty} pre-existing file(s)) → halting before any work (stage or stash them, then re-run)`);
        break;
      }
      // > 0, never an exact match against batch size: a fixer that miscounts blocks must not halt a
      // healthy run, and hand-authored external inventories are formatted more loosely.
      const entries = fix?.issue_entries_found ?? -1;
      if (entries === 0 && batch.issues.length > 0) {
        halted = true;
        record.status = 'BLOCKED (inventory not found)';
        blockerReason = `The fixer could not find ANY of ${batch.id}'s issue blocks in the inventory file(s) it was handed:\n  ${issuePaths.join('\n  ')}\nThose paths are computed from runId="${RUN_ID}" + root + stateDir — they must be the SAME values review.mjs used, or they point at files that do not exist. Check them and re-run; nothing was changed. (Without this guard the fixer would report every issue STALE and the run would end reporting false success.)`;
        log(`  ✋ ${batch.id}: fixer found 0 issue blocks in ${issuePaths.join(', ')} → halting (runId/root/stateDir mismatch?)`);
        break;
      }
    }
    // Rounds 2+ have no halt (the round-1 preconditions are the only thing a dead fixer strands), but
    // the death must still be NAMED: `fix &&` below short-circuits the staging check, `gateOk(null)` is
    // false, and the run would log `gate not green (build=undefined, test=undefined)` — a red build that
    // never happened, which is the cause the operator then debugs against.
    if (fix == null) log(`  ⚠ ${batch.id} r${round}: fixer returned nothing (agent died or produced no output) — the outcome below is agent failure, NOT a red gate`);

    // ---- Staging contract: the fixer must attest it left its work UNSTAGED --------------------
    // Neither review layer can catch a violation: the blind critic is told the staged diff is the
    // ACCEPTED baseline and must NOT be reviewed, and acceptance uses it as its comparison baseline —
    // so content the fixer staged itself passes both unseen and lands in what the user commits.
    // `fix &&` keeps a dead agent on the dead-agent path above rather than misreporting it as staging.
    // No park call: `preconditionHalt` is `halted && !escalated`, so this halt skips Park by design —
    // Park may not touch the staged baseline, and clearing only the unstaged half would leave the
    // human a worse state to inspect.
    if (fix && fix.unstaged_confirmed !== true) {
      halted = true;
      record.status = 'BLOCKED (staging contract violated)';
      blockerReason = `The fixer for ${batch.id} round ${round} did not confirm it left its work UNSTAGED (unstaged_confirmed was not true). The staged index may therefore hold content neither review layer saw — the blind critic is told the staged diff is the accepted baseline, and acceptance compares against it. Inspect it before anything else touches the repo: \`git -C ${REPO} diff --cached\`, then \`git -C ${REPO} reset\` the batch's files to move them back to the unstaged tree and re-run with the same args.`;
      log(`  ✋ ${batch.id} r${round}: fixer did not confirm UNSTAGED work → halting (inspect \`git -C ${REPO} diff --cached\`)`);
      break;
    }

    for (const r of (fix?.results || [])) {
      if (!statusById.has(r.issue_id)) continue;
      const s = r.status.toLowerCase();
      statusById.set(r.issue_id, { status: s === 'stale' ? 'stale' : s === 'fixed' ? 'fixed' : 'needs-attention', summary: r.summary || '' });
    }
    if (fix?.dismissed_count) log(`  r${round}: fixer declined ${fix.dismissed_count} finding(s) → ${dismissedFile(batch.id)} (audit these)`);
    if (fix?.needs_user === true) {
      halted = true;
      escalated = true;   // work may be in the tree → park it below rather than abandoning it there
      blockerReason = `Fixer escalated a user-only decision during ${batch.id} round ${round} (see ${NEEDS_USER}).`;
      record.status = 'BLOCKED';
      log(`  ✋ BLOCKER during ${batch.id} r${round} → halting run (see ${NEEDS_USER})`);
      break;
    }
    const gateMet = gateOk(fix);
    for (const r of (fix?.results || [])) if (r.status === 'FIXED') fixedIds.add(r.issue_id);
    const claimedFixed = [...fixedIds].map((id) => batch.issues.find((i) => i.id === id)).filter(Boolean);
    const produced = (fix?.results || []).some((r) => r.status === 'FIXED' || r.status === 'FAILED');

    // Nothing produced this round + gates green: no changes to review, stage, or park. Truly
    // all-stale is a clean outcome; an all-SKIPPED batch is not (its issues stay needs-attention).
    // ROUND 1 ONLY. `produced` is computed from THIS round's results, but the working tree is
    // CUMULATIVE: from round 2 a fixer may resolve a blind-review finding that has no issue id in this
    // batch and legitimately return results:[] — taking this shortcut then would break out past quality,
    // acceptance AND park, stranding round 1's real edits unstaged, unreviewed and unrecorded. The next
    // batch's blind reviewer would inherit them as its own work. Only round 1 is provably free of
    // accumulated tree state, so later rounds must fall through to the normal finalize path.
    if (!produced && gateMet && round === 1) {
      allStale = true;
      const onlyStale = (fix?.results || []).length > 0 && (fix?.results || []).every((r) => r.status === 'STALE');
      record.status = onlyStale ? 'all-stale' : 'no-changes';
      log(`  ${batch.id} r${round}: ${onlyStale ? 'every issue stale (already resolved in current code)' : 'no changes produced (issues skipped or stale)'}`);
      break;
    }
    if (!gateMet) {
      reviewPath = '';
      // The fixer re-runs the gate live each round, so the engine holds the only copy of WHY it was red
      // once the round budget is gone — surface its tail here rather than collecting `gate_output` into
      // a schema nothing reads. Prose stays out of the control plane: log only. (No `verification_method`
      // on this engine's fix schema — the sibling loops log it too.)
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${batch.id} r${round}: gate still not green at round budget${fix?.gate_output ? ` — last gate output: ${String(fix.gate_output).slice(-500)}` : ''}`); break; }
      log(`  ↻ ${batch.id} r${round}: gate not green (build=${fix?.build_passed}, test=${fix?.test_outcome}) → another fix round`);
      continue;
    }

    // ---- QUALITY REVIEW (blind, must pass before acceptance) -----------------
    phase('Quality');
    const quality = await agent(qualityPrompt(batch, round), roleOpts('quality', {
      schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality:${batch.id} r${round}`,
    }));
    if (quality?.contested_dismissals) { contestedTotal += quality.contested_dismissals; log(`  ⚠ ${batch.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — fixer must fix or escalate`); }
    // A dead blind reviewer is not a failed review: `quality?.clean !== true` is true either way. Name it,
    // and do NOT point the next round at qualityFile() — the agent died without writing it, and fixPrompt
    // would order the fixer to READ a file that cannot exist.
    if (!quality) log(`  ⚠ ${batch.id} r${round}: blind quality reviewer returned nothing (agent died) — no ${qualityFile(batch.id, round)} was written`);
    if (quality?.clean !== true) {
      if (quality) reviewPath = qualityFile(batch.id, round);
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${batch.id} r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget`); break; }
      log(`  ↻ ${batch.id} r${round}: blind review found ${quality?.issue_count ?? '?'} issue(s) → fix addresses ${reviewPath}`);
      continue;
    }

    // ---- ACCEPTANCE (issue-aware; stages on pass) ----------------------------
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(batch, round, claimedFixed, issuePaths), roleOpts('acceptance', {
      schema: ACCEPTANCE_SCHEMA, phase: 'Acceptance', label: `accept:${batch.id} r${round}`,
    }));
    // Same shape as the quality guard above: a dead acceptance verifier fails `acc?.pass === true`, and
    // `acc?.gap_count ?? bad.length` then prints `0 gap(s)` — which reads as a near-pass. And it wrote no
    // acceptanceFile() for the next round's fixPrompt to cite.
    if (!acc) log(`  ⚠ ${batch.id} r${round}: acceptance verifier returned nothing (agent died) — 0 gaps below means UNVERIFIED, not near-pass`);
    if (acc?.regression) record.regression = true;
    if (acc?.pass === true) {
      accepted = true;
      record.status = 'accepted';
      record.staged = acc?.staged === true;
      log(`  ✓ ${batch.id} accepted after ${round} round(s) (staged=${record.staged}, suite=${acc?.suite_result || 'n/a'})`);
      break;
    }
    if (acc) reviewPath = acceptanceFile(batch.id, round);
    const bad = (acc?.fix_checks || []).filter((c) => c.actually_fixed === false);
    if (round >= MAX_ROUNDS) { log(`  ⚠ ${batch.id} r${round}: ${acc?.gap_count ?? bad.length} gap(s) at round budget`); break; }
    log(`  ↻ ${batch.id} r${round}: acceptance found ${acc?.gap_count ?? bad.length} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → fix addresses ${reviewPath}`);
  }

  // ---- PARK: save the batch's work, then clear the tree --------------------------------------
  // Runs on BOTH terminal outcomes — round budget exhausted, and a fixer escalation (`escalated`).
  // Non-destructive by design: the work goes to parked-<batch>.patch and the batch is recorded in
  // NEEDS-USER.md, so EVERY exit from this engine leaves a clean unstaged tree. That is what the next
  // batch's reviewers need (they scope on the unstaged diff, so leftover work would be read as theirs
  // and cascade), what makes a resume start from a known state, and what lets the user run another
  // workflow against the repo without inheriting an abandoned diff.
  // NOT run for a round-1 precondition halt (dirty baseline / unreadable inventory): the fixer stopped
  // before changing anything, so there is nothing to park and the operator's own work is in the tree.
  const preconditionHalt = halted && !escalated;
  if (!accepted && !allStale && !preconditionHalt) {
    phase('Park');
    const pk = await agent(parkPrompt(batch, reviewPath, escalated), roleOpts('fix', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${batch.id}`,
    }));
    const strays = pk?.strays_saved ?? 0;
    // A patch was written but `saved` says otherwise — an internally inconsistent report. The tree may
    // already be cleared, so pointing the user at "nothing was saved" would be actively wrong: name the
    // patch, and halt so a human looks before the next batch builds on top of it.
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    record.status = escalated ? 'BLOCKED (parked)' : 'parked';
    record.patch = (pk?.saved === true || contradictory) ? parkedPatch(batch.id) : null;
    if (strays > 0) record.strays = parkedNewDir(batch.id);
    // Park's `notes` is the only place the "nothing to park" case can explain itself: step 1 tells the
    // agent to skip ahead with saved=false, patch_bytes=0 "and a note saying so", and without surfacing it
    // the line reads `work saved to nothing to save` with no reason given. Prose stays out of the control
    // plane — log only, same as the fixer's gate_output tail above.
    log(`  ⚠ ${batch.id}: ${escalated ? 'escalated to the user' : 'round budget exhausted'} — PARKED (work saved to ${record.patch || 'nothing to save'}${pk?.patch_bytes ? `, ${pk.patch_bytes}B` : ''}${strays > 0 ? `, +${strays} stray file(s) in ${parkedNewDir(batch.id)}/` : ''}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, gates ${pk?.gates_green ? 'green' : 'RED'}); issues stay open — see ${NEEDS_USER}${pk?.notes ? ` — park note: ${String(pk.notes).slice(0, 300)}` : ''}`);
    if (contradictory) {
      halted = true;
      blockerReason = `Park reported saved=false for ${batch.id} but wrote ${pk.patch_bytes} bytes to ${parkedPatch(batch.id)} — the report contradicts itself. The patch is real; inspect it before continuing (the tree was ${pk?.cleared === true ? 'already cleared' : 'left as-is'}).`;
    } else if (pk?.cleared !== true) {
      halted = true;
      blockerReason = `${batch.id} could not be cleared from the working tree${pk?.saved === true ? ` (its work IS saved to ${parkedPatch(batch.id)})` : ' and its work was NOT saved — the tree still holds it'}; the tree is unsafe for the next batch.`;
    } else if (pk?.gates_green === false) {
      halted = true;
      blockerReason = `Gates not green after parking ${batch.id}; tree unsafe for the next batch.`;
    }
  }
  // Unreachable today: every loop exit either sets a status itself or falls into the park block above,
  // which always sets one. It stays as a guard for a future exit that forgets — but it must NOT read as
  // a plausible outcome. `needs-attention (loop end)` did, so a batch that escaped every status
  // assignment would be reported as a normal, slightly-disappointing result instead of the engine bug it
  // is. Same reasoning as investigate-cycle's unmapped-haltKind string.
  if (record.status === 'pending') record.status = 'BLOCKED (engine bug: batch finished with no status set)';

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

// No final sweep. Everything it did is already covered: acceptance runs the FULL gates on every accepted
// batch and park re-runs them after clearing (the run halts if either is red), and the accounting below
// is the harness's own ledger — the sweep was handed those same numbers to restate. A SWEEP.md run
// summary is also exactly what #6 forbids. The one genuinely uncovered check (did acceptance leave
// anything unstaged?) needs a shell the harness does not have, so it belongs in `followups`, below.
// migrate-cycle KEEPS its sweep: that one re-derives the change surface from the goal by grep and
// produces findings no per-section agent could have — a different thing entirely.

const parked = ledger.filter((r) => r.status === 'parked' || r.status === 'BLOCKED (parked)');
return {
  phase: 'resolve',
  runId: RUN_ID,
  halted,
  blockerReason: halted ? blockerReason : '',
  stateDir: STATE_DIR,
  contestedDismissals: contestedTotal,
  summary: {
    batchesProcessed: ledger.length,
    batchesAccepted: ledger.filter((r) => r.status === 'accepted' || r.status === 'all-stale').length,
    batchesParked: parked.length,
    issuesFixed: ledger.reduce((s, r) => s + r.fixed, 0),
    issuesStale: ledger.reduce((s, r) => s + r.stale, 0),
    issuesNeedsAttention: ledger.reduce((s, r) => s + r.needsAttention, 0),
  },
  // Parked batches: their work is SAVED, not lost. Present these to the user with the patch path (and
  // the strays dir when one exists — those files need a second restore step beyond `git apply`).
  parked: parked.map((r) => ({ id: r.id, patch: r.patch, strays: r.strays ?? null, issues: r.perIssue.map((p) => p.id) })),
  ledger: ledger.map((r) => ({ id: r.id, status: r.status, rounds: r.rounds, fixed: r.fixed, stale: r.stale, needsAttention: r.needsAttention, regression: r.regression === true, gates: r.gates, patch: r.patch ?? null })),
  followups: `${halted ? `Run halted — ${blockerReason}\n` : ''}Verify the end state yourself: run the FULL gates once, \`git -C ${REPO} diff --cached --stat\` for what is staged, and \`git -C ${REPO} status --porcelain\` to confirm NOTHING is left unstaged (an acceptance verifier that missed a newly-created file is the one gap the engine cannot see). Read the numbered review files + DISMISSED-*.md in ${STATE_DIR}/.${parked.length ? ` ${parked.length} batch(es) were PARKED — their work is saved to ${STATE_DIR}/parked-<batch>.patch and cleared from the tree, nothing discarded; ${NEEDS_USER} lists each with its diagnosis and the \`git apply --3way\` restore command. Per parked batch the user decides: restore and finish by hand, re-run resolve scoped to its ids (sharpen the Fix lines first), or drop the patch.` : ''}${halted ? ` Resolve the blocker with the user, then re-invoke with the remaining open issues (re-grep issues/*.md; already-fixed issues are now staged, and the halted batch's work is in its patch — the tree is clean).` : ''} Nothing is committed — you commit.`,
};
