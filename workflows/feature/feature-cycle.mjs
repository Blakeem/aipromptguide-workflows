export const meta = {
  name: 'feature-cycle',
  description: 'Plan-driven feature build, lean/file-bus design: implement ONE bounded feature from an approved plan → develop → BLIND pure-code review (must pass) → plan-aware acceptance + regression review (stages on pass), looped per round until done, blocked, or flagged. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Build ONE bounded, mostly-additive, NON-TRIVIAL feature (~10–100+ LoC: a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix) integrated into an existing codebase. NOT for one-line/trivial changes (make those directly) and NOT for breadth-spanning migrations/refactors. The orchestrating agent authors the plan in PLAN MODE (EnterPlanMode → ~/.claude/plans/<name>.md), the user approves (ExitPlanMode), then runs MANDATORY phase:"refine" (planPath = that file\'s absolute path) — adversarial plan review vs the real repo — folds in the gaps, ensures a CLEAN unstaged working tree, then runs phase:"build" (reuse the same runId + planPath throughout).',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent critic greps the repo, verifies the plan against real code, returns gaps + blocking questions to the orchestrating agent. Writes nothing.' },
    { title: 'Develop', detail: 'Developer reads the approved plan (verbatim) + the latest review that flagged issues; implements minimally, runs the gate to green, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no spec, no goal), flags production-blocking defects, writes quality-review-N.md. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Plan-aware gate: every acceptance criterion met + feature reachable + full gates green + no regression. Writes acceptance-review-N.md; on pass, STAGES the feature (git add, never commit).' },
  ],
};

// =============================================================================
// Config — everything app/feature-specific arrives via args so the engine stays general.
// The PLAN is produced OUTSIDE this engine, in PLAN MODE, and read VERBATIM from its file by the
// developer + acceptance verifier (never parsed-and-rebuilt — see WORKFLOW-PRINCIPLES.md #2). The
// blind quality reviewer is never given the plan path (#3). The main agent ensures a clean unstaged
// working tree before phase:"build" (#4) — there is no baseline/loader/scribe agent.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId || !(A.planPath || (A.plan && typeof A.plan !== 'object'))) {
  throw new Error('args must include at least { runId, planPath | plan (markdown string), target, gates }; got typeof=' + (typeof args));
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
const GATE        = A.gate ?? 'green';                      // 'green' (build + verification pass) | 'build-only'
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
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo ?? '.');               // absolute path to the target git repo
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const PLAN_INLINE = (!A.planPath && A.plan && typeof A.plan !== 'object') ? String(A.plan) : '';
// The plan reference handed to plan-aware agents (developer, acceptance, critic). NEVER handed to the
// blind quality reviewer.
const PLAN_REF    = PLAN_PATH ? `the approved plan file at ${PLAN_PATH} (read it verbatim)` : `the approved plan below:\n-----\n${PLAN_INLINE}\n-----`;

const qualityFile    = (r) => `${STATE_DIR}/quality-review-${r}.md`;
const acceptanceFile = (r) => `${STATE_DIR}/acceptance-review-${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;   // full detail; for the user (may halt the run)
const DISMISSED      = `${STATE_DIR}/DISMISSED.md`;    // terse ledger; developer → reviewers (anti-spin)
// The settled-decisions both reviewers read so they don't re-raise closed findings (but NOT prior
// review files — that would anchor them; see WORKFLOW-PRINCIPLES.md #5).
const SETTLED = `Before reviewing, READ these if they exist — they are the settled decisions, so you do
NOT re-raise what is already closed:
  • ${DISMISSED} — findings the developer declined, each with a one-line reason.
  • ${NEEDS_USER} — items already escalated to the user.
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files — review the CURRENT
diff FRESH (so you also catch new or similar nearby issues, and independently re-verify earlier fixes).
If you are confident a DISMISSED reason is WRONG and the issue is genuinely production-blocking, raise
it ONCE, prefixed "CONTESTS DISMISSAL:", explaining why the reason does not hold.`;

// Gate check (additive feature; no intentionally-red phase). 'green' => build passes AND the required
// verification passes AND the existing suite is not reddened. 'build-only' => build passes. When a
// feature legitimately has NO verification, the orchestrator passes gate:'build-only'.
function gateOk(dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;   // build/lint must always pass
  if (GATE === 'build-only') return true;
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
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to DISMISSED.md this round (0 if none)' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
};

const QUALITY_SCHEMA = {
  type: 'object',
  required: ['clean', 'issue_count'],
  properties: {
    clean:       { type: 'boolean', description: 'true if NO production-blocking defects were found in the unstaged diff' },
    issue_count: { type: 'integer', description: 'number of production-blocking defects written to the review file' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED.md entries you re-raised as "CONTESTS DISMISSAL:" this round because the stated reason is wrong for a genuine production-blocking defect (0 if none)' },
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

const MATRIX = `DECISION MATRIX — for each ambiguity or review finding, route it yourself IN ORDER (first match wins):
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
  • DROP (1 or 6): append ONE terse line to ${DISMISSED} so reviewers won't re-raise it —
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • ESCALATE (7): append a FULL, self-contained entry to ${NEEDS_USER} (as much detail as the user
    needs to decide). If you CANNOT proceed without the answer, set needs_user=true (the run HALTS).
    If you can proceed with a defensible default, record it there too but leave needs_user=false.`;

// =============================================================================
// Role prompts — succinct; each agent gets ONE document link for its task.
// =============================================================================
const developPrompt = (round, reviewPath) => `
You are the DEVELOPER. Implement ${PLAN_REF}. Build it minimally and surgically; match conventions;
NO scope creep beyond the plan.
${ENV}
CONVENTIONS: ${CONVENTIONS}
${round === 1
  ? `This is round 1: the working tree is clean. Implement the plan from scratch.`
  : reviewPath
    ? `A prior review flagged issues — READ ${reviewPath} and resolve exactly those. Your earlier work is
already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
    : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working
tree — re-run the gate (below), see what is failing, and fix it. Build ON your work; do NOT revert it.`}
${round === 1 ? '' : `If ${DISMISSED} exists, READ it first — it is YOUR running ledger of declined findings: do not
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
4. ${MATRIX}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

// BLIND. No plan, no spec, no goal, no acceptance criteria — judges the code purely as code.
const qualityPrompt = (round) => `
You are a CODE CRITIC. You have NO information about what this code is for, what it should do, or any
plan or spec — and you must not seek any. Judge the code PURELY ON ITS OWN MERITS.
TARGET REPO: ${REPO}

${SETTLED}

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`                    (unstaged tracked changes — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) — \`git diff\` OMITS new files.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline — context only, do NOT review it.

Report ONLY production-blocking defects INTRODUCED by this diff: real correctness/security/
data-integrity/error-handling/resource/concurrency/api-contract bugs, or anything that breaks the
build or tests. DROP silently: anything pre-existing in the baseline, style, naming, medium/low
polish, speculation, redesigns. An EMPTY result is the normal, GOOD outcome.

WRITE your findings to ${qualityFile(round)} (create ${STATE_DIR}/ if needed): one section per defect
— file:line, what's wrong, why it's production-blocking, a concrete fix. If none, write exactly
"No production-blocking defects found." Then return clean (true if NO findings, including no contests)
+ issue_count + contested_dismissals via the schema. Do NOT modify source, stage, or commit.`;

const acceptancePrompt = (round) => `
You are the ACCEPTANCE VERIFIER — the final, plan-aware gate. The blind code review already passed.
Verify, against the repo itself, that the FEATURE is fully delivered and nothing regressed. Read
${PLAN_REF}.
${ENV}

${SETTLED}
OVERRIDE: ${DISMISSED} entries are the developer's judgment calls. You are plan-aware — if a dismissed
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
5. WRITE ${acceptanceFile(round)} (create ${STATE_DIR}/ if needed): the per-criterion table, the
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
      ? 'Relay the questions to the user (AskUserQuestion), fold the answers + gap fixes directly into the plan file (planPath), ensure a CLEAN unstaged working tree, then run phase:"build" with this SAME runId + planPath.'
      : gaps.length
        ? 'Fold the gap fixes directly into the plan file (planPath), ensure a CLEAN unstaged working tree, then run phase:"build" with this SAME runId + planPath.'
        : 'Plan is sound — ensure a CLEAN unstaged working tree, then run phase:"build" with this SAME runId + planPath.',
  };
}

// =============================================================================
// PHASE: build — develop → BLIND quality review (must pass) → acceptance + regression (stages on pass)
// PRECONDITION (orchestrator's job, #4): the target repo has a CLEAN unstaged working tree. The engine
// spawns NO baseline/loader/scribe agent; the numbered review files are the only state + progress trail.
// =============================================================================
log(`build: implementing the approved plan → ${REPO} [gate=${GATE}, maxRounds=${MAX_ROUNDS}]`);

let accepted = false;
let halted = false;
let haltReason = '';
let round = 0;
let reviewPath = '';            // the latest review file the developer must address (control: a path only)
let lastAcceptance = null;
let qualityRounds = 0;
let contestedTotal = 0;         // dismissals a reviewer pushed back on — a spin/disagreement signal for the user

while (round < MAX_ROUNDS) {
  round++;

  // ---- DEVELOP -------------------------------------------------------------
  phase('Develop');
  const dev = await agent(developPrompt(round, reviewPath), roleOpts('develop', {
    schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop r${round}`,
  }));

  if (dev?.needs_user === true) {
    halted = true;
    haltReason = `Developer halted for a user-only decision in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: developer escalated a user-only decision → halting (see ${NEEDS_USER})`);
    break;
  }
  if (dev?.unstaged_confirmed !== true) {
    log(`  ⚠ r${round}: developer did not confirm work was left UNSTAGED — staging contract may be violated`);
  }
  if (dev?.dismissed_count) {
    log(`  r${round}: developer declined ${dev.dismissed_count} finding(s) → ${DISMISSED} (audit these at the end)`);
  }
  if (!gateOk(dev)) {
    // Build/verification not green and no user escalation: give the developer another fresh round to
    // fix it (it re-runs the gate and sees the failure live). No content is carried by the harness.
    reviewPath = '';
    if (round >= MAX_ROUNDS) { log(`  ⚠ r${round}: gate still not green at round budget`); break; }
    log(`  ↻ r${round}: gate not green (build=${dev?.build_passed}, test=${dev?.test_outcome}, suite=${dev?.full_suite_outcome}) → another develop round`);
    continue;
  }

  // ---- QUALITY REVIEW (blind, must pass before acceptance) -----------------
  phase('Quality');
  qualityRounds++;
  const quality = await agent(qualityPrompt(round), roleOpts('quality', {
    schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality r${round}`,
  }));
  if (quality?.contested_dismissals) {
    contestedTotal += quality.contested_dismissals;
    log(`  ⚠ r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — developer must fix or escalate, not re-dismiss (audit ${DISMISSED})`);
  }
  if (quality?.clean !== true) {
    reviewPath = qualityFile(round);
    if (round >= MAX_ROUNDS) { log(`  ⚠ r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget (see ${reviewPath})`); break; }
    log(`  ↻ r${round}: quality review found ${quality?.issue_count ?? '?'} issue(s) → develop addresses ${reviewPath}`);
    continue;
  }
  log(`  ✓ r${round}: quality review clean`);

  // ---- ACCEPTANCE REVIEW (plan-aware; stages on pass) ----------------------
  phase('Acceptance');
  const acc = await agent(acceptancePrompt(round), roleOpts('acceptance', {
    schema: ACCEPTANCE_SCHEMA, phase: 'Acceptance', label: `acceptance r${round}`,
  }));
  lastAcceptance = acc;
  if (acc?.pass === true) {
    accepted = true;
    log(`  ✓ r${round}: acceptance PASSED — feature ${acc?.staged ? 'STAGED' : 'NOT staged (⚠ verifier did not stage)'} (reachable=${acc?.reachable}, suite=${acc?.suite_result || 'n/a'})`);
    break;
  }
  reviewPath = acceptanceFile(round);
  if (round >= MAX_ROUNDS) { log(`  ⚠ r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s) at round budget (see ${reviewPath})`); break; }
  log(`  ↻ r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → develop addresses ${reviewPath}`);
}

// =============================================================================
// Result
// =============================================================================
const status = halted
  ? 'BLOCKED (needs user input)'
  : accepted
    ? (lastAcceptance?.staged ? 'done (staged)' : 'done (NOT staged — verifier did not stage; check manually)')
    : 'needs-attention (round budget exhausted)';

log(`build: ${status} after ${round} round(s) [${qualityRounds} quality pass(es)]`);

return {
  phase: 'build',
  runId: RUN_ID,
  status,
  accepted,
  halted,
  staged: accepted && lastAcceptance?.staged === true,
  reachable: lastAcceptance?.reachable === true,
  regression: lastAcceptance?.regression === true,
  rounds: round,
  contestedDismissals: contestedTotal,
  stateDir: STATE_DIR,
  reviewTrail: `Numbered review files in ${STATE_DIR}/ (quality-review-N.md, acceptance-review-N.md) show every iteration.`,
  followups: halted
    ? `Run halted for a user decision — read ${NEEDS_USER}, resolve it with the user, ensure the tree is still this feature's in-progress work, then re-invoke phase:"build" with the same args.`
    : accepted
      ? `Review the staged diff in ${REPO} (git diff --cached), the numbered review files in ${STATE_DIR}/, and ${DISMISSED} (every finding the developer declined — audit these). Nothing is committed — you commit.`
      : `Not accepted within ${MAX_ROUNDS} rounds. Read the latest acceptance-review / quality-review file + ${DISMISSED} in ${STATE_DIR}/, decide with the user, then re-invoke phase:"build".`,
};
