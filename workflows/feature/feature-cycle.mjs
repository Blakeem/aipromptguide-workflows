export const meta = {
  name: 'feature-cycle',
  description: 'Plan-driven feature build, lean/file-bus design: implement ONE bounded feature — or an ordered ROADMAP of them (a `plans` array, each plan separately user-approved in plan mode) — from approved plan(s) → develop → BLIND pure-code review (must pass) → plan-aware acceptance + regression review (stages on pass), looped per round until done, blocked, or flagged; the accepted baseline advances per accepted feature. Agents exchange messages as verbatim files; the harness only routes plan ids, paths + verdicts.',
  whenToUse: 'Build ONE bounded, mostly-additive, NON-TRIVIAL feature (~10–100+ LoC: a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix) integrated into an existing codebase — or an ordered ROADMAP of several such features in ONE run (the `plans` array = build order, each plan separately authored + user-approved in plan mode; staging advances per accepted feature). NOT for one-line/trivial changes (make those directly) and NOT for breadth-spanning migrations/refactors across many call sites (use the sibling migrate-cycle). The orchestrating agent authors each plan in PLAN MODE (EnterPlanMode → ~/.claude/plans/<name>.md), the user approves (ExitPlanMode), and runs MANDATORY phase:"refine" per plan (planPath = that file\'s absolute path) — adversarial plan review vs the real repo — folding in the gaps; then, with a CLEAN unstaged working tree, runs ONE phase:"build" with the plans array (reuse the same runId throughout).',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent critic greps the repo, verifies the plan against real code, returns gaps + blocking questions to the orchestrating agent. Writes nothing.' },
    { title: 'Develop', detail: 'Developer reads the approved plan (verbatim) + the latest review that flagged issues; implements minimally, runs the gate to green, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no spec, no goal), flags production-blocking defects, writes quality-review-<id>-rN.md. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Plan-aware gate: every acceptance criterion met + feature reachable + full gates green + no regression. Writes acceptance-review-<id>-rN.md; on pass, STAGES that feature (git add, never commit) — the accepted baseline advances plan by plan.' },
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
  required: ['build_passed', 'test_outcome', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user'],
  properties: {
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
  required: ['pass', 'staged', 'reachable'],
  properties: {
    pass:        { type: 'boolean', description: 'true if every acceptance criterion is met, the feature is reachable, gates are green, and nothing regressed' },
    staged:      { type: 'boolean', description: 'true if you ran `git add` on the feature files (only on pass; NEVER commit)' },
    reachable:   { type: 'boolean', description: 'the feature is actually wired in / reachable from the app entry points' },
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
  ? `This is round 1: the unstaged working tree is clean (any earlier ACCEPTED features in this roadmap are
STAGED = the accepted baseline). Implement this plan from scratch on top of that baseline.`
  : reviewPath
    ? `A prior review flagged issues — READ ${reviewPath} and resolve exactly those. Your earlier work is
already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
    : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working
tree — re-run the gate (below), see what is failing, and fix it. Build ON your work; do NOT revert it.`}
${round === 1 ? '' : `If ${dismissedFile(p.id)} exists, READ it first — it is YOUR running ledger of declined findings: do not
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
1. For EACH acceptance criterion, find concrete evidence it holds (a diff hunk, a passing test, an
   observed behavior). Mark met / not-met with file:line / test-name / output evidence.
2. REACHABILITY: prove every integration point is satisfied — the feature is registered/exported/
   routed/bound/flagged and reachable from real entry points (grep to prove it).
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-working
   behavior was changed or broken.
4. Run the FULL gates once and record the real outcome:
     build: ${GATES.build ?? '(none)'}    test: ${GATES.test ?? '(none)'}
   Re-run the plan's configured verification method to confirm the feature behaves as specified. If a
   configured MCP/tool is unavailable here, say so in the file (do not fake it) and return pass=false.
5. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed): the per-criterion table, the
   reachability + regression result, the gate output, and each gap (title + file:line + fix) — or
   "All criteria met; reachable; no regression."
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
// A plan that does NOT accept HALTS the run (the staging boundary means the next plan's blind diff must
// be clean — you cannot start the next feature while this one's work is unstaged).
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
  pending = i >= 0 ? ALL_PLANS.slice(i) : ALL_PLANS;
}
const isFullRun = !runOnly && !A.startAt;
log(`build: ${pending.length}/${ALL_PLANS.length} plan(s) to build${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : A.startAt ? ` (startAt: ${A.startAt})` : ''} [maxRounds=${MAX_ROUNDS}]`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
let halted = false;
let haltReason = '';
const doneIds = [];

for (const p of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between plans rather
  // than letting an agent() call throw mid-plan. Accepted plans are STAGED; resume continues.
  if (budget.total && budget.remaining() < (A.minPlanBudget ?? 150_000)) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltReason = `Stopped before plan ${p.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minPlanBudget). Resume phase:"build" with startAt:"${p.id}".`;
    log(`⏸ ${haltReason}`);
    break;
  }

  log(`▶ plan ${p.id} [gate=${p.gate}]`);
  const rec = { id: p.id, gate: p.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, staged: false, reachable: false, regression: false };
  let reviewPath = '';           // the latest review file the developer must address (control: a path only)
  let accepted = false;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    rec.rounds = round;

    // ---- DEVELOP -----------------------------------------------------------
    phase('Develop');
    const dev = await agent(developPrompt(p, round, reviewPath), roleOpts('develop', {
      schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop ${p.id} r${round}`,
    }));

    if (dev?.needs_user === true) {
      halted = true;
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
    if (acc?.pass === true) {
      rec.reachable = acc?.reachable === true;
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        log(`  ✓ ${p.id}: acceptance PASSED — STAGED (reachable=${acc?.reachable}, suite=${acc?.suite_result || 'n/a'})`);
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next plan's blind diff would include
      // this feature's unstaged work. Do NOT advance; halt for manual staging, then resume.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage — stage manually, then resume)';
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

  // Not accepted (and not already a needs-user halt): HALT the run. The staging boundary means we cannot
  // start the next plan while this one's work is unstaged. Resume re-runs THIS plan on its unstaged work.
  if (!halted) {
    halted = true;
    rec.status = 'needs-attention (round budget exhausted)';
    haltReason = `Plan ${p.id} did not reach acceptance within ${MAX_ROUNDS} rounds (see ${reviewPath || acceptanceFile(p.id, round)}). Its work is UNSTAGED; resolve with the user, then resume from this plan id.`;
    log(`  ✋ ${p.id}: not accepted within ${MAX_ROUNDS} rounds → halting run (staging boundary)`);
  }
  ledger.push(rec);
  break;
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

const status = halted
  ? (haltReason.includes('needs user') || haltReason.includes('user-only') ? 'BLOCKED (needs user input)' : 'halted (plan needs attention / budget)')
  : allDone
    ? (ALL_PLANS.length === 1 ? 'done (staged)' : 'done (all plans staged)')
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
  ledger,
  reviewTrail: `Numbered review files in ${STATE_DIR}/ (quality-review-<id>-rN.md, acceptance-review-<id>-rN.md) show every iteration; git staging marks each accepted feature.`,
  followups: halted
    ? `Run halted — read ${NEEDS_USER} (if a hard blocker) and the latest review file for the plan in question, resolve with the user, confirm the tree still holds that plan's in-progress UNSTAGED work, then resume: re-invoke phase:"build" with the same args + startAt:"<that plan id>" (or runOnly).`
    : allDone
      ? `All plans done. Review the staged diff in ${REPO} (git diff --cached), the numbered review files + DISMISSED-*.md in ${STATE_DIR}/ (audit every declined finding). Run the full gates yourself. Nothing is committed — you commit.`
      : `Partial slice complete (${doneIds.join(', ') || 'none'}). Reconstruct the next start point from git staging + the review trail and re-invoke phase:"build" with startAt the next plan id.`,
};
