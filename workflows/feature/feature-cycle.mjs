export const meta = {
  name: 'feature-cycle',
  description: 'Plan-driven feature build, lean/file-bus design: implement ONE bounded feature — or an ordered ROADMAP of them (a `plans` array, each plan separately user-approved in plan mode) — from approved plan(s) → develop → BLIND pure-code review (must pass) → plan-aware acceptance + regression review (stages on pass), looped per round until done, blocked, or flagged; the accepted baseline advances per accepted feature. A plan that does not accept within its round budget is PARKED — its work saved to a patch and cleared from the tree — and the roadmap CONTINUES; nothing is discarded and every exit leaves a clean tree. Agents exchange messages as verbatim files; the harness only routes plan ids, paths + verdicts.',
  whenToUse: 'Build ONE bounded, mostly-additive, NON-TRIVIAL feature (~10–100+ LoC: a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix) integrated into an existing codebase — or an ordered ROADMAP of several such features in ONE run (the `plans` array = build order, each plan separately authored + user-approved in plan mode; staging advances per accepted feature). NOT for one-line/trivial changes (make those directly) and NOT for breadth-spanning migrations/refactors across many call sites (use the sibling migrate-cycle). The orchestrating agent authors each plan in PLAN MODE (EnterPlanMode → ~/.claude/plans/<name>.md), the user approves (ExitPlanMode), and runs MANDATORY phase:"refine" per plan (planPath = that file\'s absolute path) — adversarial plan review vs the real repo — folding in the gaps; then, with a CLEAN unstaged working tree, runs ONE phase:"build" with the plans array (reuse the same runId throughout).',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent critic greps the repo, verifies the plan against real code, returns gaps + blocking questions to the orchestrating agent. Writes nothing.' },
    { title: 'Develop', detail: 'Developer reads the approved plan (verbatim) + the latest review that flagged issues; implements minimally, runs the gate to green, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no spec, no goal), flags production-blocking defects, writes quality-review-<id>-rN.md. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Plan-aware gate: every acceptance criterion met + feature reachable + full gates green + no regression. Writes acceptance-review-<id>-rN.md; on pass, STAGES that feature (git add, never commit) — the accepted baseline advances plan by plan.' },
    { title: 'Park', detail: 'On a plan that did not accept within its round budget, or one the developer escalated: SAVES that plan\'s work to parked-<id>.patch, then clears it from the tree. A budget-exhausted plan is parked and the ROADMAP CONTINUES (the next plan\'s blind diff is clean again); an escalation still stops the run, but leaves the tree clean either way. Nothing is destroyed — NEEDS-USER.md carries the restore command.' },
  ],
};

// =============================================================================
// Config — everything app/feature-specific arrives via args so the engine stays general.
// Each PLAN is produced OUTSIDE this engine, in PLAN MODE, and read VERBATIM from its own file by the
// developer + acceptance verifier (never parsed-and-rebuilt — see WORKFLOW-PRINCIPLES.md #2). The blind
// quality reviewer is never given any plan path (#3). The ONLY thing that travels as control is the
// ordered `plans` list of thin {id, planPath|plan, gate} knobs (routing, not content — #1/#8) plus the
// round number — per-plan files keep even a roadmap placement-blind for the OTHER plans. The main agent
// ensures a clean unstaged working tree before phase:"build" (#4) — there is no baseline/loader/scribe
// agent; each plan's authoring + approval happen in plan mode.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId || !(A.planPath || (A.plan && typeof A.plan !== 'object') || (Array.isArray(A.plans) && A.plans.length))) {
  throw new Error('args must include at least { runId, planPath | plan (markdown string) | plans:[{id,planPath|plan,gate}], target, gates }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally the workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}

const PHASE       = A.phase ?? 'build';                     // 'refine' (review the plan, stop) | 'build' (implement it)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example to mirror
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
const MAX_ROUNDS  = A.maxRounds ?? 4;                       // develop→quality→acceptance rounds before "needs-attention"

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType
// that exists in YOUR registry. Acceptance is opus (spec + regression, high stakes); the blind
// quality critic is the fast tier (runs every round).
const M  = { plan: 'opus', develop: 'opus', quality: 'sonnet', acceptance: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// ROOT is the ABSOLUTE base that run-state hangs off (supplied by the main agent — see the required
// check above), so every agent + `git -C` call is cwd-independent. Run-state lands in
// `<ROOT>/runs/<runId>` unless args.stateDir overrides it.
const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo ?? '.');               // absolute path to the target git repo
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const PLAN_INLINE = (!A.planPath && A.plan && typeof A.plan !== 'object') ? String(A.plan) : '';
// Blind-reviewer placement guard (#3): run-state must live OUTSIDE the target repo so the blind quality
// reviewer cannot reach the review/ledger files through the repo tree. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the review/ledger files. Set args.root to THIS tool's own directory (see CLAUDE.md).`);
}
// The plan reference handed to plan-aware agents (developer, acceptance) — per plan entry, since a
// roadmap carries one plan file per feature. NEVER handed to the blind quality reviewer (#3).
const planRef     = (p) => p.planPath
  ? `the approved plan file at ${p.planPath} (read it verbatim)`
  : `the approved plan below:\n-----\n${p.plan}\n-----`;
// Top-level single plan — used by the refine critic (one plan per refine pass) + back-compat build.
const PLAN_REF    = PLAN_PATH ? `the approved plan file at ${PLAN_PATH} (read it verbatim)` : `the approved plan below:\n-----\n${PLAN_INLINE}\n-----`;

// =============================================================================
// Plans — the ordered roadmap the main agent supplies (array order = build order). Each entry is a THIN
// control object { id, planPath|plan, gate } (routing knobs, NOT content — the plan body lives in its own
// file, read verbatim). Back-compat: no `plans` → one synthesized entry from the top-level planPath/plan.
// runOnly / startAt scope a cheaper partial slice by id without editing the roadmap.
// =============================================================================
const VALID_GATES = new Set(['green', 'build-only']);
const ALL_PLANS = (Array.isArray(A.plans) && A.plans.length
  ? A.plans
  : [{ id: 'feature', planPath: A.planPath, plan: A.plan, gate: A.gate ?? 'green' }])
  .map((p) => (typeof p === 'string' ? { id: p } : p))
  .filter((p) => p && p.id)
  .map((p) => ({
    id: String(p.id),
    planPath: p.planPath ? abs(p.planPath) : '',
    plan: (!p.planPath && p.plan && typeof p.plan !== 'object') ? String(p.plan) : '',
    gate: VALID_GATES.has(p.gate) ? p.gate : 'green',
  }));

const qualityFile    = (id, r) => `${STATE_DIR}/quality-review-${slug(id)}-r${r}.md`;
const acceptanceFile = (id, r) => `${STATE_DIR}/acceptance-review-${slug(id)}-r${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;            // full detail; for the user (may halt the run) — GLOBAL/cumulative
const dismissedFile  = (id) => `${STATE_DIR}/DISMISSED-${slug(id)}.md`;  // terse ledger; developer → reviewers (anti-spin) — PER PLAN
const parkedPatch    = (id) => `${STATE_DIR}/parked-${slug(id)}.patch`;    // a plan's work, saved before the tree is cleared
const parkedNewDir   = (id) => `${STATE_DIR}/parked-${slug(id)}-newfiles`; // untracked files the patch could not carry (rare)
// The settled-decisions both reviewers read so they don't re-raise closed findings (but NOT prior
// review files — that would anchor them; see WORKFLOW-PRINCIPLES.md #5). Scoped per plan.
const SETTLED = (id) => `Before reviewing, READ these if they exist — they are the settled decisions, so you do
NOT re-raise what is already closed:
  • ${dismissedFile(id)} — findings the developer declined for THIS feature, each with a one-line reason.
  • ${NEEDS_USER} — items already escalated to the user.
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files — review the CURRENT
diff FRESH (so you also catch new or similar nearby issues, and independently re-verify earlier fixes).
If you are confident a DISMISSED reason is WRONG and the issue is genuinely production-blocking, raise
it ONCE, prefixed "CONTESTS DISMISSAL:", explaining why the reason does not hold.`;

// Gate check (additive feature; no intentionally-red phase). 'green' => build passes AND the required
// verification passes AND the existing suite is not reddened. 'build-only' => build passes. When a
// feature legitimately has NO verification, the orchestrator passes gate:'build-only'. Per-plan gate.
function gateOk(gate, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;   // build/lint must always pass
  if (gate === 'build-only') return true;
  if (dev.full_suite_outcome === 'failed') return false;        // reddening the suite is a regression
  if (dev.test_outcome === 'not-run') return false;             // green requires verification to have run
  if (dev.tests_run_count === 0) return false;                  // selector matched nothing = FALSE green
  return dev.test_outcome === 'passed';
}

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
const DEVELOP_SCHEMA = {
  type: 'object',
  required: ['baseline_dirty_files', 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user'],
  properties: {
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files already had UNSTAGED or untracked changes BEFORE you touched anything (staged files are the accepted baseline — never counted). 0 = clean; >0 HALTS the run. Report -1 on later rounds (the check does not apply).' },
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed', 'not-run'], description: 'passed = the required verification ran and PASSED; failed = ran and failed; not-run = no verification executed' },
    tests_run_count:   { type: 'integer', description: 'unit/integration tests the runner ACTUALLY executed (0 = selector matched nothing = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    full_suite_outcome:{ type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q", "curl localhost:3000/health"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add NOT run on content; git add -N only, for new files)' },
    needs_user:        { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to this feature\'s DISMISSED file this round (0 if none)' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
};

const QUALITY_SCHEMA = {
  type: 'object',
  required: ['clean', 'issue_count'],
  properties: {
    clean:       { type: 'boolean', description: 'true if NO production-blocking defects were found in the unstaged diff' },
    issue_count: { type: 'integer', description: 'number of production-blocking defects written to the review file' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED entries you re-raised as "CONTESTS DISMISSAL:" this round because the stated reason is wrong for a genuine production-blocking defect (0 if none)' },
  },
};

const ACCEPTANCE_SCHEMA = {
  type: 'object',
  required: ['pass', 'staged', 'reachable', 'criteria_total', 'criteria_met', 'evidence_recorded'],
  properties: {
    pass:        { type: 'boolean', description: 'true if every acceptance criterion is met, the feature is reachable, gates are green, and nothing regressed' },
    staged:      { type: 'boolean', description: 'true if you ran `git add` on the feature files (only on pass; NEVER commit)' },
    reachable:   { type: 'boolean', description: 'the feature is actually wired in / reachable from the app entry points' },
    criteria_total: { type: 'integer', description: 'acceptance criteria you enumerated from the plan (0 means you enumerated none — never a legitimate pass)' },
    criteria_met:   { type: 'integer', description: 'of those, how many you found concrete evidence for' },
    evidence_recorded: { type: 'boolean', description: 'true ONLY if EVERY met criterion carries a locator (file:line / test name / command output) written in the review file' },
    regression:  { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/committed behavior' },
    gap_count:   { type: 'integer', description: 'number of unmet criteria / gaps written to the review file (0 on pass)' },
    suite_result:{ type: 'string', description: 'observed outcome of running the FULL gates' },
  },
};

const REFINE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'gaps', 'questions'],
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs-changes', 'needs-answers'], description: 'ready = sound + complete; needs-changes = material gaps; needs-answers = blocking questions only the user can resolve' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title:      { type: 'string' },
          evidence:   { type: 'string', description: 'file:line hits / grep counts proving the gap — no evidence, no gap' },
          suggestion: { type: 'string', description: 'how to fix the plan' },
        },
      },
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['question'],
        properties: {
          question:    { type: 'string' },
          why_blocking:{ type: 'string', description: 'why the plan is not safe to build without an answer' },
        },
      },
    },
    too_big: { type: 'boolean', description: 'true if this is more than ONE bounded feature and should be split' },
    notes:   { type: 'string' },
  },
};

// =============================================================================
// Shared prompt fragment + decision matrix (developer-owned)
// =============================================================================
const ENV = `TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example to mirror): ${REFERENCE_P}\n` : ''}GATES (the commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}`;

// PARK — the terminal outcome for a plan that did not accept, and for one the developer escalated.
// Its work is SAVED to a patch and then CLEARED from the tree. Clearing is what lifts the old staging
// boundary: a parked plan no longer blocks the roadmap, because the next plan's blind reviewer once
// again sees an unstaged diff that is purely its own. Nothing is discarded, and every exit from this
// engine leaves a clean tree, so the user can run something else against the repo and come back later.
const PARK_SCHEMA = {
  type: 'object',
  required: ['saved', 'cleared', 'gates_green'],
  properties: {
    saved:       { type: 'boolean', description: 'true ONLY if the patch file was written and you confirmed it is non-empty. If false, you must NOT have cleared the tree.' },
    cleared:     { type: 'boolean', description: 'true if the plan\'s work was then removed from the working tree and `git diff` is empty' },
    gates_green: { type: 'boolean', description: 'true if the BUILD gate passes again after clearing (the tree is safe for the next plan)' },
    patch_bytes: { type: 'integer', description: 'size of the written patch file — 0 means nothing was saved' },
    strays_saved:{ type: 'integer', description: 'how many untracked files you copied to the -newfiles dir in step 2 (0 if none). Non-zero means the restore needs a SECOND step beyond git apply, and step 4 must say so.' },
    notes:       { type: 'string' },
  },
};

const parkPrompt = (p, lastReviewPath, escalated) => `
You are PARKING the feature plan "${p.id}", which ${escalated
    ? `hit a BLOCKER the developer escalated to the user (see ${NEEDS_USER}). The run stops after you, but its
work is NOT left lying in the working tree`
    : `did NOT reach acceptance within its round budget. Its work is NOT thrown away`}: you SAVE it to a
patch file, then clear it from the working tree${escalated ? '' : ` so the REST OF THE ROADMAP can continue — the next
plan's blind reviewer scopes on the unstaged diff, so leftover work would be attributed to that plan and
fail it for this one's problems`}. Accepted features are STAGED and must survive untouched.
${ENV}
STAGING CONTRACT:
  • staged index + HEAD  = ACCEPTED features (the baseline). Treat as known-good; do NOT touch.
  • unstaged working tree = THIS plan's unsuccessful work — the only thing you save and clear.
  • Nothing is EVER committed.

SAVE BEFORE YOU CLEAR — never the other way round. If step 1 does not produce a non-empty patch, STOP:
leave the tree exactly as it is and return saved=false, cleared=false.

PROCEDURE:
1. SAVE. \`git -C ${REPO} status --porcelain\` first. If \`git -C ${REPO} diff\` is already EMPTY there is
   nothing to park — skip to step 3 and return saved=false, patch_bytes=0, with a note saying so.
   Otherwise write the plan's work to ${parkedPatch(p.id)} (create ${STATE_DIR}/ if needed):
     \`git -C ${REPO} diff --binary > ${parkedPatch(p.id)}\`
   \`--binary\` is REQUIRED (a plain diff records "Binary files differ" and will not re-apply). The
   unstaged diff IS exactly this plan's work, and files the developer created are in it via \`git add -N\`.
   Then CONFIRM the file exists and is non-empty, and record its size as patch_bytes.
2. CATCH STRAYS. If \`git status --porcelain\` still lists any \`??\` untracked file this plan created
   (the developer missed its \`git add -N\`), COPY those files into ${parkedNewDir(p.id)}/ preserving
   relative paths — the patch CANNOT carry them. Skip build output and caches. Report the count as
   strays_saved: it matters, because step 4 must tell the user those files exist.
3. CLEAR. Restore every tracked file this plan modified to the staged baseline:
   \`git -C ${REPO} checkout -- <files>\`. Then delete the files this plan CREATED (untracked + any
   \`git add -N\` intent-to-add entries). Be precise about WHY each is safe to delete: an intent-to-add
   file is carried by the patch from step 1; a \`??\` stray is safe ONLY because step 2 copied it to
   ${parkedNewDir(p.id)}/. If step 2 did not copy a stray, do NOT delete it.
   Confirm \`git -C ${REPO} diff\` is EMPTY, then run the BUILD gate and record whether it is green.
4. RECORD. Append ONE entry to ${NEEDS_USER}, under a \`## Parked plan: ${p.id}\` heading:
   - that this plan is **NOT done and NOT abandoned — a status record, not a dismissal**; the remaining
     roadmap continued without it
   - one line on why it was parked (${escalated ? 'the blocker the developer escalated' : 'what acceptance was still failing'})
   - ${lastReviewPath ? `the diagnosis: \`${lastReviewPath}\`` : 'the latest review file for this plan in ' + STATE_DIR}
   - the saved work: \`${parkedPatch(p.id)}\`
   - restore command, verbatim: \`git -C ${REPO} apply --3way ${parkedPatch(p.id)}\`
   - **ONLY IF step 2 actually copied stray files**: a line naming \`${parkedNewDir(p.id)}/\` as holding
     new files the patch cannot carry, listing them, and telling the user to copy them back into the repo
     (preserving relative paths) as a SECOND step after the \`git apply\`. Omit this line entirely when
     there were no strays — do not leave a dangling reference to an empty directory.
   - the user's options: restore the patch and finish the feature by hand · re-run this plan alone
     (\`runOnly:["${p.id}"]\`) after sharpening the plan file · drop the patch
Do NOT touch the staged baseline, do NOT commit, and do NOT modify any file outside this plan's work.
Return saved + cleared + gates_green + patch_bytes + strays_saved via the schema.`;

const MATRIX = (id) => `DECISION MATRIX — for each ambiguity or review finding, route it yourself IN ORDER (first match wins):
  1. Not a real problem / false positive .............. DROP — LOG it (see LOGGING).
  2. Pre-existing in untouched code (not yours) ....... DROP silently (out of scope; never fix — regression risk).
  3. Stops the build/tests/verification ............... FIX (always).
  4. A real, clear, in-scope fix (local, small) ....... FIX.
  5. Needed to satisfy the spec / wire the feature in . FIX (an unreachable or incomplete feature is not done).
  6. Conflicts with the plan / intentional / not a real-world code path ... DROP — LOG it (see LOGGING).
  7. A genuine DESIGN/BUSINESS choice only the USER can make, OR a blocker you cannot resolve in scope
        .............................................. ESCALATE (see LOGGING).
  8. Anything else (style, medium/low polish, a different feature) ... DROP silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. NEVER log the same dismissal twice.

LOGGING — this (plus your code) is your ONLY output. Keep it minimal and unambiguous:
  • DROP (1 or 6): append ONE terse line to ${dismissedFile(id)} so reviewers won't re-raise it —
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • ESCALATE (7): append a FULL, self-contained entry to ${NEEDS_USER} (as much detail as the user
    needs to decide). If you CANNOT proceed without the answer, set needs_user=true (the run HALTS).
    If you can proceed with a defensible default, record it there too but leave needs_user=false.`;

// =============================================================================
// Role prompts — succinct; each agent gets ONE document link for its task.
// =============================================================================
const developPrompt = (p, round, reviewPath) => `
You are the DEVELOPER. Implement ${planRef(p)}. Build it minimally and surgically; match conventions;
NO scope creep beyond the plan.
${ENV}
CONVENTIONS: ${CONVENTIONS}
${round === 1
  ? `ROUND 1 — STEP 0, BEFORE you read the plan or touch any file: CONFIRM THE BASELINE IS CLEAN. Earlier
ACCEPTED features are STAGED (the accepted baseline); the UNSTAGED tree must be EMPTY, because everything
unstaged at the end of this round is reviewed and judged as YOUR work.
  \`git -C ${REPO} diff --name-only\`                        — unstaged tracked edits
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` — untracked files (\`git diff\` OMITS these)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (entries that are ONLY
staged are the accepted baseline — do NOT count them). If it is NOT 0, STOP RIGHT THERE: change nothing,
write nothing, do no work, and return immediately with that count — the run halts so the operator can
fold or stash that work. If it IS 0, implement this plan from scratch on top of the staged baseline.`
  : reviewPath
    ? `A prior review flagged issues — READ ${reviewPath} and resolve exactly those. Your earlier work is
already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
    : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working
tree — re-run the gate (below), see what is failing, and fix it. Build ON your work; do NOT revert it.`}
${round === 1 ? '' : `Report baseline_dirty_files=-1 (the round-1 clean-baseline check does not apply from round 2 on — the
unstaged tree now holds YOUR work).
If ${dismissedFile(p.id)} exists, READ it first — it is YOUR running ledger of declined findings: do not
duplicate an entry. If the review you are addressing RE-RAISES one as \`CONTESTS DISMISSAL:\`, you MUST
FIX or ESCALATE it (never silently re-add the same dismissal).`}

PROCEDURE:
1. Implement the plan's steps. WIRE IT IN so the feature is actually reachable (registered/exported/
   routed/bound/flagged) — written-but-unreachable is NOT done. Author/extend tests per the plan's
   Test Strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}
2. RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: per the plan's
   Test Strategy (${GATES.test ?? 'no test gate configured'}). Also run the FULL suite to confirm you
   did not redden it (report full_suite_outcome). Never weaken/delete tests to get green.
   SANITY-CHECK the runner really executed your unit tests (tests_run_count = 0 means it matched
   NOTHING = a false green; -1 if N/A, e.g. manual/MCP).
3. LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file
   you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add, so reviewers' \`git diff\` sees it;
   it does not stage content). Set unstaged_confirmed=true.
4. ${MATRIX(p.id)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

// BLIND. No plan, no spec, no goal, no acceptance criteria — judges the code purely as code.
const qualityPrompt = (p, round) => `
You are a CODE CRITIC. You have NO information about what this code is for, what it should do, or any
plan or spec — and you must not seek any. Judge the code PURELY ON ITS OWN MERITS.
TARGET REPO: ${REPO}

${SETTLED(p.id)}

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`                    (unstaged tracked changes — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) — \`git diff\` OMITS new files.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline — context only, do NOT review it.

Report ONLY production-blocking defects INTRODUCED by this diff: real correctness/security/
data-integrity/error-handling/resource/concurrency/api-contract bugs, or anything that breaks the
build or tests. DROP silently: anything pre-existing in the baseline, style, naming, medium/low
polish, speculation, redesigns. An EMPTY result is the normal, GOOD outcome.

WRITE your findings to ${qualityFile(p.id, round)} (create ${STATE_DIR}/ if needed): one section per defect
— file:line, what's wrong, why it's production-blocking, a concrete fix. If none, write exactly
"No production-blocking defects found." Then return clean (true if NO findings, including no contests)
+ issue_count + contested_dismissals via the schema. Do NOT modify source, stage, or commit.`;

const acceptancePrompt = (p, round) => `
You are the ACCEPTANCE VERIFIER — the final, plan-aware gate. The blind code review already passed.
Verify, against the repo itself, that the FEATURE is fully delivered and nothing regressed. Read
${planRef(p)}.
${ENV}

${SETTLED(p.id)}
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. You are plan-aware — if a dismissed
item ACTUALLY breaks an acceptance criterion, leaves the feature unreachable, or causes a regression,
that OVERRIDES the dismissal: fail acceptance for it and record it in your review file.

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  \`git -C ${REPO} diff --staged\` = accepted baseline (compare against it for regressions).

PROCEDURE:
1. ENUMERATE the plan's acceptance criteria FIRST, numbered — that count is criteria_total (never 0 for
   a real plan). For EACH, find concrete evidence it holds (a diff hunk, a passing test, an observed
   behavior) and mark it met / not-met with a file:line / test-name / command-output LOCATOR;
   criteria_met = how many hold. evidence_recorded=true only if EVERY met criterion carries such a
   locator in your review file — a criterion you asserted without one does not count as met.
2. REACHABILITY: prove every integration point is satisfied — the feature is registered/exported/
   routed/bound/flagged and reachable from real entry points (grep to prove it).
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-working
   behavior was changed or broken.
4. Run the FULL gates once and record the real outcome:
     build: ${GATES.build ?? '(none)'}    test: ${GATES.test ?? '(none)'}
   Re-run the plan's configured verification method to confirm the feature behaves as specified. If a
   configured MCP/tool is unavailable here, say so in the file (do not fake it) and return pass=false.
5. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE you decide anything in
   step 6: the numbered per-criterion table WITH its locators, the reachability + regression result, the
   gate output, and each gap (title + file:line + fix) — or "All criteria met; reachable; no regression."
6. DECIDE:
   • Everything met, reachable, gates green, no regression → \`git -C ${REPO} add <the feature's changed
     AND newly-created files>\` (NEVER commit); return pass=true, staged=true.
   • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;

const refinePrompt = () => `
You are an INDEPENDENT PLAN CRITIC (read-only). The orchestrating agent authored the feature plan in
plan mode. Find what it MISSED or got WRONG against the REAL repo — not to restyle or re-architect it.
An empty result (verdict="ready") is a GOOD outcome. Read ${PLAN_REF}.
${ENV}

PROCEDURE:
1. Verify the plan's FILE LIST and INTEGRATION POINTS against the actual repo (grep for the symbols/
   registries/routes the feature must touch — confirm them; do not trust the plan's lists).
2. Report a GAP only for a MATERIAL miss WITHIN this feature: an unaddressed wiring point, a missing
   prerequisite, a wrong/absent file, an acceptance criterion with no implementing step, a test
   strategy that won't prove the criteria, or a feature too big for one develop pass (too_big=true).
3. Raise a QUESTION only for something that genuinely BLOCKS safe implementation and only a human can
   resolve. Provide file:line evidence for every gap — no evidence, no gap.
Do NOT modify any files. Return your findings via the schema (the orchestrating agent acts on them).`;

// =============================================================================
// PHASE: refine — adversarially review the plan; return gaps/questions to the orchestrator. STOP.
// (Writes nothing — the orchestrator reads the return value and relays to the user. Principle #6.)
// Refine runs on ONE plan at a time (the top-level planPath) — during the planning loop, before the
// next plan exists — so it takes the single planPath, not the `plans` array.
// =============================================================================
if (PHASE === 'refine') {
  phase('Refine');
  log(`refine: critiquing the plan${PLAN_PATH ? ` at ${PLAN_PATH}` : ' (inline)'} against ${REPO}`);
  const critique = await agent(refinePrompt(), roleOpts('plan', {
    schema: REFINE_SCHEMA, phase: 'Refine', label: 'plan-critic',
  }));
  const gaps = critique?.gaps || [];
  const questions = critique?.questions || [];
  log(`refine: verdict=${critique?.verdict ?? 'ready'} — ${gaps.length} gap(s), ${questions.length} question(s)${critique?.too_big ? ' [TOO BIG — split it]' : ''}`);
  return {
    phase: 'refine',
    runId: RUN_ID,
    verdict: critique?.verdict ?? 'ready',
    tooBig: critique?.too_big === true,
    gaps,
    questions,
    notes: critique?.notes || '',
    nextStep: questions.length
      ? 'Relay the questions to the user (AskUserQuestion), fold the answers + gap fixes directly into the plan file (planPath), ensure a CLEAN unstaged working tree, then run phase:"build" with this SAME runId + planPath (or, for a roadmap, add this plan to the plans array once every plan is refined).'
      : gaps.length
        ? 'Fold the gap fixes directly into the plan file (planPath), ensure a CLEAN unstaged working tree, then run phase:"build" with this SAME runId + planPath (or, for a roadmap, add this plan to the plans array once every plan is refined).'
        : 'Plan is sound — ensure a CLEAN unstaged working tree, then run phase:"build" with this SAME runId + planPath (or, for a roadmap, add this plan to the plans array once every plan is refined).',
  };
}

// =============================================================================
// PHASE: build — implement each plan in the roadmap IN ORDER; per plan: develop → BLIND quality (must
// pass) → acceptance + regression (stages on pass; the accepted baseline advances feature by feature).
// A plan that does NOT accept is PARKED — its work saved to a patch and CLEARED from the tree — and the
// roadmap CONTINUES. Clearing is what restores the staging boundary the next plan's blind diff needs;
// destroying the work never was required. (migrate-cycle parks too but then STOPS: its sections are an
// ordered decomposition of one goal, so N+1 depends on N. Independent features have no such coupling.)
// PRECONDITION (orchestrator's job, #4): the target repo has a CLEAN unstaged working tree; any
// already-accepted prior features are STAGED. The engine spawns NO baseline/loader/scribe agent — the
// numbered review files + git staging are the only state + progress trail (#6/#10).
// =============================================================================
if (!ALL_PLANS.length) {
  throw new Error('args needs a plan for phase:"build": pass planPath|plan (one feature) or plans:[{id, planPath|plan, gate}] (an ordered roadmap). Got none.');
}

// Resume / partial-slice scoping (control plane, supplied by the orchestrator after it reconstructs
// progress from git-staging + the review-file trail — there is no progress file by design, #6/#10).
//   runOnly: [ids]  — build exactly these plans (in roadmap order).
//   startAt: id     — build from this plan to the end (skip already-accepted earlier ones).
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
let pending = ALL_PLANS;
if (runOnly) {
  pending = ALL_PLANS.filter((p) => runOnly.includes(p.id));
} else if (A.startAt) {
  const i = ALL_PLANS.findIndex((p) => p.id === A.startAt);
  // An unknown id must FAIL FAST — silently falling back to the full roadmap would re-build already
  // accepted plans (their work is the staged baseline) and burn the whole run.
  if (i < 0) throw new Error(`args.startAt "${A.startAt}" matches no plan id. Valid ids: ${ALL_PLANS.map((p) => p.id).join(', ')}`);
  pending = ALL_PLANS.slice(i);
}
const isFullRun = !runOnly && !A.startAt;
log(`build: ${pending.length}/${ALL_PLANS.length} plan(s) to build${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : A.startAt ? ` (startAt: ${A.startAt})` : ''} [maxRounds=${MAX_ROUNDS}]`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
let halted = false;
let haltReason = '';
// WHY the run halted, as a value rather than prose. The status line used to sniff substrings out of
// haltReason, so a new halt reason silently reported the wrong status; every halt site now sets this.
let haltKind = '';
const doneIds = [];

for (const p of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between plans rather
  // than letting an agent() call throw mid-plan. Accepted plans are STAGED; resume continues.
  if (budget.total && budget.remaining() < (A.minPlanBudget ?? 150_000)) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltKind = 'budget';
    haltReason = `Stopped before plan ${p.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minPlanBudget). Resume phase:"build" with startAt:"${p.id}".`;
    log(`⏸ ${haltReason}`);
    break;
  }

  log(`▶ plan ${p.id} [gate=${p.gate}]`);
  const rec = { id: p.id, gate: p.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, staged: false, reachable: false, regression: false, criteria: null, thinEvidence: false };
  let reviewPath = '';           // the latest review file the developer must address (control: a path only)
  let accepted = false;
  // `escalated` distinguishes the two halts: a developer escalation leaves real work in the tree (park
  // it), while a round-1 dirty-baseline halt changed nothing (that work is the OPERATOR's — never park it).
  let escalated = false;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    rec.rounds = round;

    // ---- DEVELOP -----------------------------------------------------------
    phase('Develop');
    const dev = await agent(developPrompt(p, round, reviewPath), roleOpts('develop', {
      schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop ${p.id} r${round}`,
    }));

    // ---- PRECONDITION (round 1 of every plan): the unstaged tree must have been CLEAN --------------
    // The reviewers scope on the unstaged diff, so stray pre-existing work would be reviewed as this
    // plan's and burn the whole round budget on code nobody in this run touched. Halt HERE — before any
    // quality/acceptance agent spawns. The developer did no work, so there is nothing to unwind.
    if (round === 1) {
      const dirty = Number(dev?.baseline_dirty_files);
      if (!Number.isFinite(dirty)) {
        log(`  ⚠ ${p.id} r1: developer did not report baseline_dirty_files — the clean-baseline precondition was NOT verified`);
      } else if (dirty > 0) {
        halted = true;
        rec.status = 'BLOCKED (dirty baseline)';
        haltKind = 'dirty-baseline';
        haltReason = `Plan ${p.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the reviewers' scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain), then run ONE command and re-invoke this build unchanged: \`git -C ${REPO} add -A\` to KEEP it (folds it into the accepted baseline), or \`git -C ${REPO} stash -u\` to set it aside. Nothing was built or changed.`;
        log(`  ✋ ${p.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before any review agent (git add -A to fold into the baseline, or git stash -u, then re-run)`);
        break;
      }
    }
    if (dev?.needs_user === true) {
      halted = true;
      escalated = true;   // real work may be in the tree → park it below rather than abandoning it there
      haltKind = 'needs-user';
      haltReason = `Developer halted for a user-only decision in plan ${p.id} round ${round} (see ${NEEDS_USER}).`;
      rec.status = 'BLOCKED (needs user)';
      log(`  ✋ ${p.id} r${round}: developer escalated a user-only decision → halting (see ${NEEDS_USER})`);
      break;
    }
    if (dev?.unstaged_confirmed !== true) {
      log(`  ⚠ ${p.id} r${round}: developer did not confirm work was left UNSTAGED — staging contract may be violated`);
    }
    if (dev?.dismissed_count) {
      log(`  ${p.id} r${round}: developer declined ${dev.dismissed_count} finding(s) → ${dismissedFile(p.id)} (audit these at the end)`);
    }
    if (!gateOk(p.gate, dev)) {
      // Build/verification not green and no user escalation: give the developer another fresh round to
      // fix it (it re-runs the gate and sees the failure live). No content is carried by the harness.
      reviewPath = '';
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: gate(${p.gate}) not green at round budget`); break; }
      log(`  ↻ ${p.id} r${round}: gate(${p.gate}) not green (build=${dev?.build_passed}, test=${dev?.test_outcome}, suite=${dev?.full_suite_outcome}) → another develop round`);
      continue;
    }

    // ---- QUALITY REVIEW (blind, must pass before acceptance) -----------------
    phase('Quality');
    rec.qualityRounds++;
    const quality = await agent(qualityPrompt(p, round), roleOpts('quality', {
      schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality ${p.id} r${round}`,
    }));
    if (quality?.contested_dismissals) {
      rec.contested += quality.contested_dismissals;
      log(`  ⚠ ${p.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — developer must fix or escalate, not re-dismiss (audit ${dismissedFile(p.id)})`);
    }
    if (quality?.clean !== true) {
      reviewPath = qualityFile(p.id, round);
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget (see ${reviewPath})`); break; }
      log(`  ↻ ${p.id} r${round}: quality review found ${quality?.issue_count ?? '?'} issue(s) → develop addresses ${reviewPath}`);
      continue;
    }
    log(`  ✓ ${p.id} r${round}: quality review clean`);

    // ---- ACCEPTANCE REVIEW (plan-aware; stages on pass; baseline advances) ---
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(p, round), roleOpts('acceptance', {
      schema: ACCEPTANCE_SCHEMA, phase: 'Acceptance', label: `acceptance ${p.id} r${round}`,
    }));
    if (acc?.regression === true) rec.regression = true;
    rec.criteria = { met: Number(acc?.criteria_met) || 0, total: Number(acc?.criteria_total) || 0 };
    if (acc?.pass === true) {
      rec.reachable = acc?.reachable === true;
      // A pass is only as good as the enumeration behind it: no criteria, an incomplete count, or
      // missing locators means the verdict rests on assertion, not evidence (#14). Detection only —
      // acceptance already staged, so flag it for the operator's audit rather than failing the plan.
      rec.thinEvidence = rec.criteria.total === 0 || rec.criteria.met < rec.criteria.total || acc?.evidence_recorded !== true;
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (evidence_recorded=${acc?.evidence_recorded}) — audit ${acceptanceFile(p.id, round)}` : '';
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        log(`  ✓ ${p.id}: acceptance PASSED — ${rec.criteria.met}/${rec.criteria.total} criteria — STAGED (reachable=${acc?.reachable}, suite=${acc?.suite_result || 'n/a'})${thinNote}`);
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next plan's blind diff would include
      // this feature's unstaged work. Do NOT advance; halt for manual staging, then resume.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage — stage manually, then resume)';
      haltKind = 'passed-unstaged';
      haltReason = `Plan ${p.id} passed acceptance but its work was left UNSTAGED. Stage its files (git -C ${REPO} add <files>) so the baseline advances, then resume phase:"build" with startAt the NEXT plan id.`;
      log(`  ✋ ${p.id}: acceptance passed but NOT staged → halting (staging boundary)`);
      break;
    }
    reviewPath = acceptanceFile(p.id, round);
    if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s) at round budget (see ${reviewPath})`); break; }
    log(`  ↻ ${p.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → develop addresses ${reviewPath}`);
  }

  if (accepted) {
    // accepted is only ever true together with staged (the pass-but-unstaged case halts above), so this
    // is unambiguously a staged "done".
    rec.status = 'done (staged)';
    doneIds.push(p.id);
    ledger.push(rec);
    continue;
  }

  // ---- PARK: save this plan's work, then clear the tree ----------------------------------------
  // Reached on either terminal outcome — round budget exhausted, or a developer escalation. Parking is
  // what removes the old staging boundary: this plan's work no longer sits unstaged, so the NEXT plan's
  // blind reviewer sees a diff that is purely its own and the roadmap can carry on. A budget-exhausted
  // plan therefore PARKS AND CONTINUES; only an escalation still stops the run (the user must answer),
  // and even then the tree is left clean.
  // NOT reached on a dirty-baseline halt: that broke out before the developer changed anything, and the
  // work in the tree belongs to the operator — parking it would be taking their changes hostage.
  if (!(halted && !escalated)) {
    phase('Park');
    const pk = await agent(parkPrompt(p, reviewPath || acceptanceFile(p.id, round), escalated), roleOpts('develop', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${p.id}`,
    }));
    const strays = pk?.strays_saved ?? 0;
    // Patch bytes written but `saved` false — an internally inconsistent report. The tree may already be
    // cleared, so telling the user "nothing was saved" would be actively wrong: name the patch and stop.
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    rec.patch = (pk?.saved === true || contradictory) ? parkedPatch(p.id) : null;
    if (strays > 0) rec.strays = parkedNewDir(p.id);
    if (!escalated) rec.status = 'parked (not accepted within round budget)';
    log(`  ⚠ ${p.id}: ${escalated ? 'escalated to the user' : `not accepted within ${MAX_ROUNDS} rounds`} — PARKED (work saved to ${rec.patch || 'nothing to save'}${pk?.patch_bytes ? `, ${pk.patch_bytes}B` : ''}${strays > 0 ? `, +${strays} stray file(s) in ${parkedNewDir(p.id)}/` : ''}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${pk?.gates_green ? 'green' : 'RED'}) — see ${NEEDS_USER}`);
    // A tree we could not clear (or a broken build) is unsafe for the next plan, so those DO halt even
    // though a plain park does not.
    if (contradictory) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Park reported saved=false for plan ${p.id} but wrote ${pk.patch_bytes} bytes to ${parkedPatch(p.id)} — the report contradicts itself. The patch is real; inspect it before continuing (the tree was ${pk?.cleared === true ? 'already cleared' : 'left as-is'}).`;
    } else if (pk?.cleared !== true) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Plan ${p.id} could not be cleared from the working tree${pk?.saved === true ? ` (its work IS saved to ${parkedPatch(p.id)})` : ' and its work was NOT saved — the tree still holds it'}; the tree is unsafe for the next plan.`;
    } else if (pk?.gates_green === false) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The build gate is not green after parking plan ${p.id}; the tree is unsafe for the next plan.`;
    }
    if (halted && !escalated && rec.status === 'pending') rec.status = 'parked (park incomplete)';
  }
  ledger.push(rec);
  if (halted) break;      // escalation / unsafe tree stops the roadmap; a clean park carries on
}

// No final sweep (deliberate asymmetry vs migrate-cycle): roadmap plans are INDEPENDENT features with no
// shared surface to re-grep, and each plan's acceptance already ran the full gates + its own reachability
// check — so there is nothing a whole-run sweep could add.

// =============================================================================
// Result (control plane → the orchestrating agent; durable progress lives in git + the review-file trail)
// =============================================================================
const allDone = isFullRun && !halted && doneIds.length === ALL_PLANS.length && ALL_PLANS.length > 0;
const contestedTotal = ledger.reduce((s, r) => s + (r.contested || 0), 0);
// Single-plan back-compat fields (meaningful when plansTotal===1; for a roadmap, read per-plan detail
// from `ledger`). `solo` is the one plan's record when the run built exactly one plan.
const solo = ALL_PLANS.length === 1 ? ledger[0] : null;

// Anything with saved work the user must be told about. Keyed on the PATCH, not the status string: an
// escalated plan keeps its "BLOCKED (needs user)" status but was still parked, and dropping it here
// would leave its patch path unreported anywhere in the return.
const parkedPlans = ledger.filter((r) => r.patch || (typeof r.status === 'string' && r.status.startsWith('parked')));
const HALT_STATUS = {
  'needs-user':      'BLOCKED (needs user input)',
  'dirty-baseline':  'BLOCKED (working tree was not clean — nothing was built)',
  'passed-unstaged': 'BLOCKED (a plan passed but was not staged — stage it, then resume)',
  'park-unsafe':     'BLOCKED (a parked plan left the tree unsafe — inspect before resuming)',
  'budget':          'stopped on token budget (resume where it left off)',
};
const status = halted
  ? (HALT_STATUS[haltKind] || 'halted (plan needs attention)')
  : allDone
    ? (ALL_PLANS.length === 1 ? 'done (staged)' : 'done (all plans staged)')
    : parkedPlans.length
      ? `roadmap complete with ${parkedPlans.length} plan(s) parked`
      : 'partial slice complete';

log(`build: ${status} — ${doneIds.length}/${ALL_PLANS.length} plan(s) done [${ledger.reduce((s, r) => s + r.qualityRounds, 0)} quality pass(es)]`);

return {
  phase: 'build',
  runId: RUN_ID,
  status,
  halted,
  haltReason: halted ? haltReason : '',
  // Single-plan back-compat (meaningful when plansTotal===1; else read per-plan from `ledger`):
  accepted: solo ? solo.status === 'done (staged)' : allDone,
  staged: solo ? solo.staged === true : allDone,
  reachable: solo ? solo.reachable === true : undefined,
  regression: solo ? solo.regression === true : ledger.some((r) => r.regression),
  rounds: solo ? solo.rounds : undefined,
  contestedDismissals: contestedTotal,
  stateDir: STATE_DIR,
  plansDone: doneIds,
  plansTotal: ALL_PLANS.length,
  // Parked plans: NOT done, but their work is SAVED, not lost — the roadmap carried on without them.
  // Present each with its patch path (and strays dir when one exists — those need a second restore step).
  parked: parkedPlans.map((r) => ({ id: r.id, patch: r.patch ?? null, strays: r.strays ?? null, status: r.status })),
  ledger,
  reviewTrail: `Numbered review files in ${STATE_DIR}/ (quality-review-<id>-rN.md, acceptance-review-<id>-rN.md) show every iteration; git staging marks each accepted feature.`,
  followups: `${halted ? `Run halted — ${haltReason}${haltKind === 'needs-user' ? ` Read ${NEEDS_USER} and the plan's latest review file, resolve with the user, then re-invoke phase:"build" with the same args + startAt (or runOnly) for the plans still to do. That plan's work is in its patch and the tree is clean — apply the patch first only if you want to continue it by hand.` : ' '}` : ''}${parkedPlans.length
    ? `${parkedPlans.length} plan(s) were PARKED: ${parkedPlans.map((r) => r.id).join(', ')}. Their work is saved to ${STATE_DIR}/parked-<id>.patch and cleared from the tree — nothing discarded; ${NEEDS_USER} carries each one's diagnosis and its \`git apply --3way\` restore command. Per parked plan the user decides: restore the patch and finish by hand, re-run it alone with runOnly after sharpening its plan file, or drop the patch. `
    : ''}${doneIds.length ? `Staged/accepted: ${doneIds.join(', ')}. ` : ''}Verify the end state yourself: run the full gates, \`git -C ${REPO} diff --cached --stat\`, and \`git -C ${REPO} status --porcelain\` (should be clean). Read the numbered review files + DISMISSED-*.md in ${STATE_DIR}/ and audit every declined finding. Nothing is committed — you commit.`,
};
