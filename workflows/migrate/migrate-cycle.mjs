export const meta = {
  name: 'migrate-cycle',
  description: 'Section-driven migration/upgrade/refactor: drive ONE prose goal — broken into ordered, dependency-sequenced SECTIONS in plan mode — to a production-ready, gate-green state across one target git repo. Per section: develop → BLIND pure-code review (must pass) → plan-aware section-acceptance + regression review (stages on pass), looped per round; the accepted baseline advances section by section. A whole-goal sweep brackets the run. Agents exchange messages as verbatim files; the harness only routes the section id, round, and verdicts.',
  whenToUse: 'A BREADTH-SPANNING goal across many call sites — migrate a data model, upgrade a language/runtime version, port a framework, refactor a subsystem — that is too big for one bounded feature (use the sibling feature-cycle for that) but is ONE coherent goal. The orchestrating agent decomposes the goal into ORDERED SECTIONS in PLAN MODE (EnterPlanMode → ~/.claude/plans/<name>.md, one "## Section: <id>" per bounded change), the user approves (ExitPlanMode), then runs MANDATORY phase:"refine" (whole-plan adversarial coverage review vs the real repo) — folds in the gaps, ensures a CLEAN unstaged working tree — then phase:"run" (executes the sections in order, staging each on accept). Reuse the same runId + planPath throughout.',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent critic greps the WHOLE change surface, verifies every section of the plan against real code, returns coverage gaps + blocking questions + too_big to the orchestrating agent. Writes nothing.' },
    { title: 'Develop', detail: 'Developer reads the approved plan (verbatim) + its section + the latest review that flagged issues; implements ONLY that section minimally, runs the gate, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no goal), flags production-blocking defects, writes quality-review-<section>-N.md. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Plan-aware section gate: every acceptance criterion of THIS section met + reachable + section gate green + no regression vs the staged baseline. Writes acceptance-review-<section>-N.md; on pass, STAGES the section (git add, never commit) — the baseline advances.' },
    { title: 'Sweep', detail: 'After the FINAL section is staged: an independent agent re-greps the whole surface, runs the full gates, spot-checks the staged diff, writes SWEEP.md. The only whole-goal completeness check.' },
  ],
};

// =============================================================================
// Config — everything app/goal-specific arrives via args so the engine stays general.
// The PLAN is produced OUTSIDE this engine, in PLAN MODE, and read VERBATIM from its file by the
// developer + section-acceptance verifier (never parsed-and-rebuilt — see WORKFLOW-PRINCIPLES.md #2).
// The blind quality reviewer is never given the plan path (#3). The ONLY thing that travels as control
// is the ordered `sections` list of thin {id,title,gate} knobs (routing, not content — #1/#8) plus the
// round number. The main agent ensures a clean unstaged working tree before phase:"run" (#4) — there is
// no baseline/loader/scribe/decompose agent; decomposition + approval happen in plan mode.
// =============================================================================
const A = typeof args === 'string' ? JSON.parse(args) : args;
if (!A || !A.runId || !(A.planPath || (A.plan && typeof A.plan !== 'object'))) {
  throw new Error('args must include at least { runId, planPath | plan (markdown string), sections, target, gates }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally the workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}

const PHASE       = A.phase ?? 'run';                       // 'refine' (review the plan, stop) | 'run' (execute sections)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example to mirror
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
const MAX_ROUNDS  = A.maxRounds ?? 4;                       // develop→quality→acceptance rounds per section before "needs-attention"

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType that
// exists in YOUR registry. Acceptance is opus (spec + regression, high stakes); the blind quality
// critic is the fast tier (runs every round). The refine/sweep critics reuse the quality tier.
const M  = { develop: 'opus', quality: 'sonnet', acceptance: 'opus', refine: 'opus', sweep: 'sonnet', ...(A.models ?? {}) };
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
// The plan reference handed to plan-aware agents (developer, acceptance, refine, sweep). NEVER handed
// to the blind quality reviewer.
const PLAN_REF    = PLAN_PATH ? `the approved plan file at ${PLAN_PATH} (read it VERBATIM)` : `the approved plan below:\n-----\n${PLAN_INLINE}\n-----`;
// How an agent locates its one section inside the verbatim plan — by header, no parsing.
const sectionRef  = (id) => PLAN_PATH
  ? `the section headed "## Section: ${id}" inside ${PLAN_PATH} (read THAT section verbatim — the other sections are CONTEXT only; do NOT implement them)`
  : `the section headed "## Section: ${id}" in the plan above (the other sections are CONTEXT only; do NOT implement them)`;

// =============================================================================
// Sections — the ordered, dependency-sequenced control list the main agent supplies. Each entry is a
// THIN control object {id, title, gate} (routing knobs, NOT content — the section body lives in the
// plan file, read verbatim). Execution is array order = dependency order. runOnly / startAt scope a
// cheaper partial slice (e.g. the harness + first section) without editing the plan.
// =============================================================================
const VALID_GATES = new Set(['green', 'red-baseline', 'build-only']);
const ALL_SECTIONS = (Array.isArray(A.sections) ? A.sections : [])
  .map((s) => (typeof s === 'string' ? { id: s } : s))
  .filter((s) => s && s.id)
  .map((s) => ({ id: String(s.id), title: s.title || s.id, gate: VALID_GATES.has(s.gate) ? s.gate : 'green' }));

const qualityFile    = (id, r) => `${STATE_DIR}/quality-review-${slug(id)}-r${r}.md`;
const acceptanceFile = (id, r) => `${STATE_DIR}/acceptance-review-${slug(id)}-r${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;            // full detail; for the user (may halt the run) — GLOBAL/cumulative
const dismissedFile  = (id) => `${STATE_DIR}/DISMISSED-${slug(id)}.md`;  // terse ledger; developer → reviewers (anti-spin) — PER SECTION
const SWEEP_FILE     = `${STATE_DIR}/SWEEP.md`;                 // final whole-goal completeness sweep

// The settled-decisions both reviewers read so they don't re-raise closed findings (but NOT prior
// review files — that would anchor them; see WORKFLOW-PRINCIPLES.md #5). Scoped per section.
// canContest=true gives the BLIND quality reviewer the contest channel (its schema reports
// contested_dismissals). The acceptance verifier passes false — it does not contest via this token; it
// has the stronger plan-aware OVERRIDE channel below (a dismissed item that breaks a criterion fails
// acceptance regardless), and its schema carries no contest field.
const SETTLED = (id, canContest = true) => `Before reviewing, READ these if they exist — they are the settled decisions, so you do
NOT re-raise what is already closed:
  • ${dismissedFile(id)} — findings the developer declined for THIS section, each with a one-line reason.
  • ${NEEDS_USER} — items already escalated to the user.
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files — review the CURRENT
diff FRESH (so you also catch new or similar nearby issues, and independently re-verify earlier fixes).${canContest ? `
If you are confident a DISMISSED reason is WRONG and the issue is genuinely production-blocking, raise
it ONCE, prefixed "CONTESTS DISMISSAL:", explaining why the reason does not hold.` : ''}`;

// Per-section gate semantics. Some goals keep the WHOLE suite intentionally RED mid-run (test-first
// migrations where the environment/schema already moved ahead of the code), so "done" is judged
// per-section against its OWN selector, never whole-suite-green:
//   green        -> build passes AND this section's (selector-scoped) tests RAN and PASSED
//   red-baseline -> build passes AND the authored tests FAIL for the expected reason (TDD red step)
//   build-only   -> build passes; no test pass/fail requirement (mechanical/testless sections)
// Build (lint/compile) must ALWAYS pass — a broken build is never acceptable. Whole-suite regression
// is the ACCEPTANCE reviewer's job (it compares against the staged baseline), not this scoped gate.
function gateOk(gate, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;       // build/lint must always pass
  if (gate === 'build-only') return true;
  if (gate === 'red-baseline') return dev.test_outcome === 'failed-expected';
  // green:
  if (dev.test_outcome === 'not-run') return false;                  // green requires the selector tests to have run
  if (dev.tests_run_count === 0) return false;                       // selector matched NOTHING = a FALSE green
  return dev.test_outcome === 'passed';
}

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
const DEVELOP_SCHEMA = {
  type: 'object',
  required: ['baseline_dirty_files', 'produced', 'build_passed', 'test_outcome', 'tests_run_count', 'unstaged_confirmed', 'needs_user'],
  properties: {
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files already had UNSTAGED or untracked changes BEFORE you touched anything (staged files are the accepted baseline — never counted). 0 = clean; >0 HALTS the run. Report -1 on later rounds (the check does not apply).' },
    produced:          { type: 'boolean', description: 'true if you changed or added at least one file this round' },
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed-expected', 'failed-unexpected', 'not-run'], description: 'passed = this section\'s selector tests ran and PASSED. failed-expected = red baseline exactly as a test-first section intends. failed-unexpected = failed for a WRONG reason (a real defect / bad fixture). not-run = no tests executed.' },
    tests_run_count:   { type: 'integer', description: 'unit/integration tests the runner ACTUALLY executed for this section\'s selector (0 = selector matched nothing = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q tests/foo.py", "phpunit --filter Bar"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add NOT run on content; git add -N only, for new files)' },
    needs_user:        { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to this section\'s DISMISSED file this round (0 if none)' },
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
    pass:        { type: 'boolean', description: 'true if every acceptance criterion of THIS section is met, it is reachable, the section gate is satisfied, and nothing regressed' },
    staged:      { type: 'boolean', description: 'true if you ran `git add` on this section\'s files (only on pass; NEVER commit)' },
    reachable:   { type: 'boolean', description: 'this section\'s change is actually wired in / reachable (every call site converted, route mounted, symbol exported)' },
    criteria_total: { type: 'integer', description: 'acceptance criteria you enumerated from THIS section (0 means you enumerated none — never a legitimate pass)' },
    criteria_met:   { type: 'integer', description: 'of those, how many you found concrete evidence for' },
    evidence_recorded: { type: 'boolean', description: 'true ONLY if EVERY met criterion carries a locator (file:line / test name / command output) written in the review file' },
    regression:  { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/accepted behavior' },
    gap_count:   { type: 'integer', description: 'number of unmet criteria / gaps written to the review file (0 on pass)' },
    suite_result:{ type: 'string', description: 'observed outcome of running the section gate (and, where the goal expects it, the full gates)' },
  },
};

const REFINE_SCHEMA = {
  type: 'object',
  required: ['verdict', 'gaps', 'questions'],
  properties: {
    verdict: { type: 'string', enum: ['ready', 'needs-changes', 'needs-answers'], description: 'ready = sound + complete coverage; needs-changes = material gaps; needs-answers = blocking questions only the user can resolve' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title:      { type: 'string' },
          evidence:   { type: 'string', description: 'file:line hits / grep counts proving the gap — no evidence, no gap' },
          suggestion: { type: 'string', description: 'how to fix the plan: fold into section <id> | new section | reorder | split' },
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
    too_big: { type: 'boolean', description: 'true if a single section is more than one bounded develop pass and should be split (name it in notes)' },
    notes:   { type: 'string' },
  },
};

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['complete', 'gaps'],
  properties: {
    complete: { type: 'boolean', description: 'true if no goal-coverage gaps were found' },
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'evidence'],
        properties: {
          title:         { type: 'string' },
          evidence:      { type: 'string', description: 'file:line hits or gate output proving the gap' },
          suggested_section: { type: 'string', description: 'a one-line follow-up section that would close it' },
        },
      },
    },
    suite_result: { type: 'string', description: 'observed outcome of running the FULL gates (or why they were not run)' },
  },
};

// =============================================================================
// Shared prompt fragments + decision matrix (developer-owned)
// =============================================================================
const ENV = `GOAL CONTEXT — this run drives ONE breadth-spanning goal, decomposed into ordered sections in the plan.
TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example of this kind of change — mine it for the canonical pattern): ${REFERENCE_P}\n` : ''}CONVENTIONS (match these): ${CONVENTIONS}
GATES (the commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
BE TOKEN-ECONOMICAL: read ONLY the files this section touches plus the SPECIFIC reference/plan section
you need — do NOT re-read the whole tree, the whole plan body, or the entire reference. Prefer targeted
grep over broad reads. Don't restate large files back; act on them.`;

const MATRIX = (id) => `DECISION MATRIX — for each ambiguity or review finding, route it yourself IN ORDER (first match wins):
  1. Not a real problem / false positive .............. DROP — LOG it (see LOGGING).
  2. Pre-existing in untouched code (not yours) ....... DROP silently (out of scope; never fix — regression risk).
  3. Stops the build/tests/verification ............... FIX (always).
  4. A real, clear, in-scope fix (local, small) ....... FIX.
  5. Needed to satisfy THIS section / wire it in ...... FIX (an unreachable or incomplete section is not done).
  6. Conflicts with the plan / intentional / not a real-world code path ... DROP — LOG it (see LOGGING).
  7. A genuine DESIGN/BUSINESS choice only the USER can make, OR a blocker you cannot resolve in scope
        .............................................. ESCALATE (see LOGGING).
  8. Anything else (style, medium/low polish, a different section's work) ... DROP silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. NEVER log the same dismissal twice.

LOGGING — this (plus your code) is your ONLY output. Keep it minimal and unambiguous:
  • DROP (1 or 6): append ONE terse line to ${dismissedFile(id)} so reviewers won't re-raise it —
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • ESCALATE (7): append a FULL, self-contained entry to ${NEEDS_USER} (as much detail as the user
    needs to decide). If you CANNOT proceed without the answer, set needs_user=true (the run HALTS).
    If you can proceed with a defensible default, record it there too but leave needs_user=false.
This is NOT a general code review — a SEPARATE review workflow audits the whole codebase later. Make
THIS section correct, testable, and production-safe; leave the lines you TOUCH a little better; touch
nothing else.`;

// =============================================================================
// Role prompts — succinct; each agent gets ONE document link (the plan) for its task.
// =============================================================================
const developPrompt = (section, round, reviewPath) => {
  const gxLine = section.gate === 'red-baseline'
    ? 'red-baseline — AUTHOR this section\'s tests; they MUST FAIL because the code is not converted yet. Report test_outcome="failed-expected" once they run and fail for the RIGHT reason (asserting the not-yet-built target behavior), or "failed-unexpected" if they fail for a wrong reason (parse error, missing fixture).'
    : section.gate === 'build-only'
      ? 'build-only — no test pass/fail requirement; just keep the build green.'
      : 'green — this section\'s selector tests must RUN and PASS (test_outcome="passed"). Scope the test run to THIS section (the rest of the suite may be intentionally red mid-migration).';
  return `
You are the DEVELOPER. Implement ${sectionRef(section.id)}. Build ONLY this section minimally and
surgically; match conventions; NO scope creep beyond it.
${ENV}
SECTION: ${section.id} — ${section.title}
GATE EXPECTATION: ${gxLine}
${round === 1
  ? `ROUND 1 — STEP 0, BEFORE you read the plan or touch any file: CONFIRM THE BASELINE IS CLEAN. Prior
sections are STAGED (the accepted baseline); the UNSTAGED tree must be EMPTY, because everything unstaged
at the end of this round is reviewed and judged as YOUR work.
  \`git -C ${REPO} diff --name-only\`                        — unstaged tracked edits
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` — untracked files (\`git diff\` OMITS these)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (entries that are ONLY
staged are the accepted baseline — do NOT count them). If it is NOT 0, STOP RIGHT THERE: change nothing,
write nothing, do no work, and return immediately with that count — the run halts so the operator can
fold or stash that work. If it IS 0, implement this section from scratch on top of the staged baseline.`
  : reviewPath
    ? `A prior review flagged issues — READ ${reviewPath} and resolve exactly those. Your earlier work for
this section is already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
    : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working tree —
re-run the gate (below), see what is failing, and fix it. Build ON your work; do NOT revert it.`}
${round === 1 ? '' : `Report baseline_dirty_files=-1 (the round-1 clean-baseline check does not apply from round 2 on — the
unstaged tree now holds YOUR work).
`}If ${dismissedFile(section.id)} exists, READ it first — it is YOUR running ledger of declined findings
for THIS section, and it PERSISTS across resumes (so a resumed round-1 still has it): do not duplicate
an entry, and do not re-litigate what you already declined. If a review RE-RAISES one as
\`CONTESTS DISMISSAL:\`, you MUST FIX or ESCALATE it (never silently re-add the same dismissal).

PROCEDURE:
1. Implement this section's steps. WIRE IT IN so the change is actually reachable — convert EVERY call
   site / occurrence this section owns (registered/exported/routed/bound/flagged); a half-converted
   section is NOT done. Author/extend tests per the section's Test Strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}
2. RUN THE GATE until it satisfies the expectation above — build: ${GATES.build ?? '(none)'} ; tests
   scoped to this section's selector: ${GATES.test ?? '(no test gate configured)'}. Never weaken/delete
   tests to get green. SANITY-CHECK the runner really executed your unit tests (tests_run_count = 0
   means it matched NOTHING = a false green; -1 if N/A). Some runners silently ignore extra path args —
   when in doubt run one file per invocation or use the runner's --filter.
3. Do NOT chase whole-suite green — only THIS section's scoped tests matter; the rest may be intentionally
   red mid-migration. Build/lint must always pass.
4. LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file you
   CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add, so reviewers' \`git diff\` sees it; it does
   not stage content). Set unstaged_confirmed=true. The acceptance verifier stages for real on accept.
5. ${MATRIX(section.id)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;
};

// BLIND. No plan, no goal, no acceptance criteria — judges the code purely as code.
const qualityPrompt = (section, round) => `
You are a CODE CRITIC. You have NO information about what this code is for, what it should do, or any
plan or goal — and you must not seek any. Judge the code PURELY ON ITS OWN MERITS.
TARGET REPO: ${REPO}

${SETTLED(section.id)}

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`                    (unstaged tracked changes — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) — \`git diff\` OMITS new files.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline (prior sections) — context only, do NOT review it.

Report ONLY production-blocking defects INTRODUCED by this diff: real correctness/security/
data-integrity/error-handling/resource/concurrency/api-contract bugs, or anything that breaks the
build or tests. DROP silently: anything pre-existing in the baseline, style, naming, medium/low polish,
speculation, redesigns. An EMPTY result is the normal, GOOD outcome.

WRITE your findings to ${qualityFile(section.id, round)} (create ${STATE_DIR}/ if needed): one section
per defect — file:line, what's wrong, why it's production-blocking, a concrete fix. If none, write
exactly "No production-blocking defects found." Then return clean (true if NO findings, including no
contests) + issue_count + contested_dismissals via the schema. Do NOT modify source, stage, or commit.`;

const acceptancePrompt = (section, round) => `
You are the ACCEPTANCE VERIFIER — the final, plan-aware gate for ONE section. The blind code review
already passed. Verify, against the repo itself, that THIS section is fully delivered and nothing
regressed. Read ${sectionRef(section.id)}.
${ENV}
SECTION: ${section.id} — ${section.title}   (gate: ${section.gate})

${SETTLED(section.id, false)}
OVERRIDE: ${dismissedFile(section.id)} entries are the developer's judgment calls. You are plan-aware —
if a dismissed item ACTUALLY breaks one of this section's acceptance criteria, leaves it unreachable,
or causes a regression, that OVERRIDES the dismissal: fail acceptance for it and record it in your file.

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  \`git -C ${REPO} diff --staged\` = accepted baseline (prior sections — compare against it for regressions).

PROCEDURE:
1. ENUMERATE THIS section's acceptance criteria FIRST, numbered — that count is criteria_total (never 0
   for a real section). For EACH, find concrete evidence it holds (a diff hunk, a passing test, an
   observed behavior) and mark it met / not-met with a file:line / test-name / command-output LOCATOR;
   criteria_met = how many hold. evidence_recorded=true only if EVERY met criterion carries such a
   locator in your review file — a criterion you asserted without one does not count as met.
2. REACHABILITY: prove every integration point this section owns is satisfied — every call site
   converted, route mounted, symbol exported/bound/flagged (grep to prove it). A half-converted section
   is not done.
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-accepted
   behavior was changed or broken.
4. Run this section's gate and record the real outcome (build: ${GATES.build ?? '(none)'} ; tests scoped
   to this section: ${GATES.test ?? '(none)'}). For gate=green the selector tests must PASS; for
   gate=red-baseline the authored tests must FAIL as intended (that failing test IS the spec — a valid,
   stageable "done"); for gate=build-only just build green. Do NOT treat the intentionally-red rest of
   the suite as a failure. If a configured MCP/tool is unavailable here, say so in the file (do not fake
   it) and return pass=false.
5. WRITE ${acceptanceFile(section.id, round)} (create ${STATE_DIR}/ if needed) BEFORE you decide anything
   in step 6: the numbered per-criterion table WITH its locators, the reachability + regression result,
   the gate output, and each gap (title + file:line + fix) — or "All criteria met; reachable; no regression."
6. DECIDE:
   • All criteria met, reachable, gate satisfied, no regression → \`git -C ${REPO} add <this section's
     changed AND newly-created files>\` (NEVER commit); return pass=true, staged=true. The baseline now
     advances to include this section.
   • LEGITIMATE NO-OP: if this section genuinely requires NO code change because the staged baseline
     already satisfies every one of its criteria, that is a valid pass — return pass=true AND staged=true
     (there is simply nothing to add). Say so explicitly in your file. Do NOT invent changes to justify it.
   • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;

// Whole-PLAN coverage critic (refine phase). Reads ALL sections; greps the WHOLE surface.
const refinePrompt = () => `
You are an INDEPENDENT PLAN CRITIC (read-only). The orchestrating agent decomposed a breadth-spanning
GOAL into ordered SECTIONS in plan mode. Find what the plan MISSED or got WRONG against the REAL repo —
across the WHOLE change surface — not to restyle or re-architect it. An empty result (verdict="ready")
is a GOOD outcome. Read ${PLAN_REF} (every "## Section:" block).
${ENV}

PROCEDURE:
1. RE-DERIVE the change surface YOURSELF from the goal: grep the target repo for EVERY occurrence of the
   patterns/APIs/symbols the goal replaces or touches. Do NOT trust the plan's file lists — verify them.
   Record hit counts so coverage is checkable.
2. Compare every hit + integration point against the sections. Report a GAP only for a MATERIAL miss
   WITHIN the goal: an uncovered call site/file/feature, a missing prerequisite (e.g. no test-harness
   section before a red-baseline one), a dependency-ORDERING error (a consumer section before its
   producer), an acceptance criterion with no implementing step, a test strategy that won't prove the
   criteria, or a section too big for one ~150k-token develop pass (too_big=true; name it in notes).
3. Raise a QUESTION only for something that genuinely BLOCKS safe implementation and only a human can
   resolve. Provide file:line evidence for every gap — no evidence, no gap.
Do NOT modify any files. Return your findings via the schema (the orchestrating agent acts on them).`;

const sweepPrompt = (doneIds) => `
You are the FINAL COMPLETENESS SWEEP. Every section is done and its work is STAGED. Verify, against the
repo itself, that the GOAL is actually fully achieved — your job is to find what the plan MISSED, not to
re-review accepted work. Read ${PLAN_REF}.
${ENV}
COMPLETED SECTIONS: ${doneIds.join(', ')}

PROCEDURE (read-only except step 4):
1. RE-DERIVE the change surface from the GOAL: grep the target repo for every pattern/API/symbol the goal
   replaces or touches. Any hit that should have been converted but wasn't = a gap.
2. Run the FULL gates once and record the real outcome (build: ${GATES.build ?? '(none)'} ; test:
   ${GATES.test ?? '(none)'}). If the GOAL implies whole-suite green at the end, a red suite is a gap; if
   a red tail is expected, say which failures look expected vs surprising.
3. Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): does it plausibly cover every
   section's acceptance? Look for suspiciously-untouched areas the GOAL names.
4. WRITE ${SWEEP_FILE}: the suite result, then each gap (title + file:line evidence + a suggested
   follow-up section) — or "No gaps found." Do NOT modify source code, stage, or commit.
Report ONLY material, in-GOAL gaps — not improvements, not pre-existing issues. Return via the schema.`;

// =============================================================================
// PHASE: refine — adversarially review the WHOLE plan; return gaps/questions to the orchestrator. STOP.
// (Writes nothing — the orchestrator reads the return value and relays to the user. Principle #6.)
// =============================================================================
if (PHASE === 'refine') {
  phase('Refine');
  log(`refine: critiquing the plan${PLAN_PATH ? ` at ${PLAN_PATH}` : ' (inline)'} against ${REPO} (${ALL_SECTIONS.length} section[s])`);
  const critique = await agent(refinePrompt(), roleOpts('refine', {
    schema: REFINE_SCHEMA, phase: 'Refine', label: 'plan-critic',
  }));
  const gaps = critique?.gaps || [];
  const questions = critique?.questions || [];
  log(`refine: verdict=${critique?.verdict ?? 'ready'} — ${gaps.length} gap(s), ${questions.length} question(s)${critique?.too_big ? ' [a section is TOO BIG — split it]' : ''}`);
  return {
    phase: 'refine',
    runId: RUN_ID,
    verdict: critique?.verdict ?? 'ready',
    tooBig: critique?.too_big === true,
    gaps,
    questions,
    notes: critique?.notes || '',
    nextStep: questions.length
      ? 'Relay the questions to the user (AskUserQuestion), fold the answers + gap fixes directly into the plan file (planPath), ensure a CLEAN unstaged working tree, then run phase:"run" with this SAME runId + planPath + the (possibly amended) sections list.'
      : gaps.length
        ? 'Fold the gap fixes directly into the plan file (planPath) — adding/splitting/reordering "## Section:" blocks as needed and updating the sections list to match — ensure a CLEAN unstaged working tree, then run phase:"run".'
        : 'Plan is sound — ensure a CLEAN unstaged working tree, then run phase:"run" with this SAME runId + planPath + sections.',
  };
}

// =============================================================================
// PHASE: run — execute the sections in order; per section: develop → BLIND quality (must pass) →
// acceptance + regression (stages on pass; the baseline advances). A section that does NOT accept
// HALTS the run (the staging boundary means the next section's blind diff must be clean — you cannot
// start the next section while this one's work is unstaged).
// PRECONDITION (orchestrator's job, #4): the target repo has a CLEAN unstaged working tree; any
// already-accepted prior sections are STAGED. The engine spawns NO baseline/loader/scribe agent —
// the numbered review files + git staging are the only state + progress trail (#6/#10).
// =============================================================================
if (!ALL_SECTIONS.length) {
  throw new Error('args.sections is required for phase:"run": an ordered array of { id, title, gate } the main agent extracted from the approved plan (each maps to a "## Section: <id>" block). Got none.');
}

// Resume / partial-slice scoping (control plane, supplied by the orchestrator after it reconstructs
// progress from git-staging + the review-file trail — there is no progress file by design, #6/#10).
//   runOnly: [ids]  — run exactly these sections (in plan order).
//   startAt: id     — run from this section to the end (skip already-accepted earlier ones).
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
let pending = ALL_SECTIONS;
if (runOnly) {
  pending = ALL_SECTIONS.filter((s) => runOnly.includes(s.id));
} else if (A.startAt) {
  const i = ALL_SECTIONS.findIndex((s) => s.id === A.startAt);
  // An unknown id must FAIL FAST — silently falling back to the full list would re-run already accepted
  // sections against a baseline that already contains them, and skip the final sweep on top.
  if (i < 0) throw new Error(`args.startAt "${A.startAt}" matches no section id. Valid ids: ${ALL_SECTIONS.map((s) => s.id).join(', ')}`);
  pending = ALL_SECTIONS.slice(i);
}
const isFullRun = !runOnly && !A.startAt;   // a sweep is only meaningful when the whole goal was processed
log(`run: ${pending.length}/${ALL_SECTIONS.length} section(s) to process${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : A.startAt ? ` (startAt: ${A.startAt})` : ''} [maxRounds=${MAX_ROUNDS}]`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
let halted = false;
let haltReason = '';
const doneIds = [];

for (const section of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between sections rather
  // than letting an agent() call throw mid-section. Accepted sections are STAGED; resume continues.
  if (budget.total && budget.remaining() < (A.minSectionBudget ?? 150_000)) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltReason = `Stopped before section ${section.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minSectionBudget). Resume phase:"run" with startAt:"${section.id}".`;
    log(`⏸ ${haltReason}`);
    break;
  }

  log(`▶ section ${section.id} — ${section.title} [gate=${section.gate}]`);
  const rec = { id: section.id, title: section.title, gate: section.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, staged: false, reachable: false, regression: false, criteria: null, thinEvidence: false };
  let reviewPath = '';           // the latest review file the developer must address (control: a path only)
  let accepted = false;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    rec.rounds = round;

    // ---- DEVELOP -----------------------------------------------------------
    phase('Develop');
    const dev = await agent(developPrompt(section, round, reviewPath), roleOpts('develop', {
      schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop ${section.id} r${round}`,
    }));

    // ---- PRECONDITION (round 1 of every section): the unstaged tree must have been CLEAN -----------
    // The reviewers scope on the unstaged diff, so stray pre-existing work would be reviewed as this
    // section's and burn the whole round budget on code nobody in this run touched. Halt HERE — before
    // any quality/acceptance agent spawns. The developer did no work, so there is nothing to unwind.
    if (round === 1) {
      const dirty = Number(dev?.baseline_dirty_files);
      if (!Number.isFinite(dirty)) {
        log(`  ⚠ ${section.id} r1: developer did not report baseline_dirty_files — the clean-baseline precondition was NOT verified`);
      } else if (dirty > 0) {
        halted = true;
        rec.status = 'BLOCKED (dirty baseline)';
        haltReason = `Section ${section.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the reviewers' scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain), then run ONE command and re-invoke this run unchanged: \`git -C ${REPO} add -A\` to KEEP it (folds it into the accepted baseline), or \`git -C ${REPO} stash -u\` to set it aside. Nothing was built or changed.`;
        log(`  ✋ ${section.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before any review agent (git add -A to fold into the baseline, or git stash -u, then re-run)`);
        break;
      }
    }
    if (dev?.needs_user === true) {
      halted = true;
      haltReason = `Developer halted for a user-only decision in section ${section.id} round ${round} (see ${NEEDS_USER}).`;
      rec.status = 'BLOCKED (needs user)';
      log(`  ✋ ${section.id} r${round}: developer escalated a user-only decision → halting (see ${NEEDS_USER})`);
      break;
    }
    if (dev?.unstaged_confirmed !== true) {
      log(`  ⚠ ${section.id} r${round}: developer did not confirm work was left UNSTAGED — staging contract may be violated`);
    }
    if (dev?.dismissed_count) {
      log(`  ${section.id} r${round}: developer declined ${dev.dismissed_count} finding(s) → ${dismissedFile(section.id)} (audit these at the end)`);
    }
    if (!gateOk(section.gate, dev)) {
      // Gate not satisfied and no user escalation: give the developer another fresh round to fix it (it
      // re-runs the gate and sees the failure live). RETAIN reviewPath — if a prior review is still open
      // (e.g. a quality CONTEST not yet re-confirmed clean), the developer must keep addressing it while
      // also fixing the gate; only a clean quality review advances the pointer. On round 1 it is '' anyway.
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${section.id} r${round}: gate(${section.gate}) not satisfied at round budget`); break; }
      log(`  ↻ ${section.id} r${round}: gate(${section.gate}) not satisfied (build=${dev?.build_passed}, test=${dev?.test_outcome}, count=${dev?.tests_run_count}) → another develop round`);
      continue;
    }
    // ---- QUALITY REVIEW (blind, must pass before acceptance) ----------------
    // Run the blind review ONLY when the developer produced changes (an empty diff has nothing to
    // review). Either way, acceptance still runs and judges the section against its criteria: a genuine
    // no-op section (the staged baseline already satisfies it) passes there, and a section that SHOULD
    // have changed files fails acceptance for unmet criteria. The harness never declares "done" itself.
    if (dev?.produced) {
      phase('Quality');
      rec.qualityRounds++;
      const quality = await agent(qualityPrompt(section, round), roleOpts('quality', {
        schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality ${section.id} r${round}`,
      }));
      if (quality?.contested_dismissals) {
        rec.contested += quality.contested_dismissals;
        log(`  ⚠ ${section.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — developer must fix or escalate, not re-dismiss`);
      }
      if (quality?.clean !== true) {
        reviewPath = qualityFile(section.id, round);
        if (round >= MAX_ROUNDS) { log(`  ⚠ ${section.id} r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget (see ${reviewPath})`); break; }
        log(`  ↻ ${section.id} r${round}: quality found ${quality?.issue_count ?? '?'} issue(s) → develop addresses ${reviewPath}`);
        continue;
      }
      log(`  ✓ ${section.id} r${round}: quality review clean`);
    } else {
      log(`  ${section.id} r${round}: developer produced no changes — skipping blind review; acceptance will judge the section against its criteria`);
    }

    // ---- ACCEPTANCE REVIEW (plan-aware; stages on pass; baseline advances) ---
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(section, round), roleOpts('acceptance', {
      schema: ACCEPTANCE_SCHEMA, phase: 'Acceptance', label: `acceptance ${section.id} r${round}`,
    }));
    if (acc?.regression === true) rec.regression = true;
    rec.criteria = { met: Number(acc?.criteria_met) || 0, total: Number(acc?.criteria_total) || 0 };
    if (acc?.pass === true) {
      rec.reachable = acc?.reachable === true;
      // A pass is only as good as the enumeration behind it: no criteria, an incomplete count, or
      // missing locators means the verdict rests on assertion, not evidence (#14). Detection only —
      // acceptance already staged, so flag it for the operator's audit rather than failing the section.
      rec.thinEvidence = rec.criteria.total === 0 || rec.criteria.met < rec.criteria.total || acc?.evidence_recorded !== true;
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (evidence_recorded=${acc?.evidence_recorded}) — audit ${acceptanceFile(section.id, round)}` : '';
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        log(`  ✓ ${section.id}: acceptance PASSED — ${rec.criteria.met}/${rec.criteria.total} criteria — STAGED (reachable=${acc?.reachable}, gate=${acc?.suite_result || 'n/a'})${thinNote}`);
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next section's blind diff would
      // include this section's unstaged work. Do NOT advance; halt for manual staging, then resume.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage — stage manually, then resume)';
      haltReason = `Section ${section.id} passed acceptance but its work was left UNSTAGED. Stage its files (git -C ${REPO} add <files>) so the baseline advances, then resume phase:"run" with startAt the NEXT section.`;
      log(`  ✋ ${section.id}: acceptance passed but NOT staged → halting (staging boundary)`);
      break;
    }
    reviewPath = acceptanceFile(section.id, round);
    if (round >= MAX_ROUNDS) { log(`  ⚠ ${section.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s) at round budget (see ${reviewPath})`); break; }
    log(`  ↻ ${section.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → develop addresses ${reviewPath}`);
  }

  if (accepted) {
    // accepted is only ever true together with staged (the pass-but-unstaged case halts above), so this
    // is unambiguously a staged "done".
    rec.status = 'done (staged)';
    doneIds.push(section.id);
    ledger.push(rec);
    continue;
  }

  // Not accepted (and not already a needs-user halt): HALT the run. The staging boundary means we
  // cannot start the next section while this one's work is unstaged. Resume re-runs THIS section on
  // its persisted unstaged work.
  if (!halted) {
    halted = true;
    rec.status = 'needs-attention (round budget exhausted)';
    haltReason = `Section ${section.id} did not reach acceptance within ${MAX_ROUNDS} rounds (see ${reviewPath || acceptanceFile(section.id, round)}). Its work is UNSTAGED; resolve with the user, then resume from this section.`;
    log(`  ✋ ${section.id}: not accepted within ${MAX_ROUNDS} rounds → halting run (staging boundary)`);
  }
  ledger.push(rec);
  break;
}

// =============================================================================
// Final completeness sweep — only on a FULL run (no partial slice) that processed every section without
// halting. An independent agent re-derives the change surface from the GOAL (grep, full gates,
// staged-diff spot-check) and reports anything the plan missed to SWEEP.md. This is the "did we actually
// finish?" check the per-section loop — which never looks beyond its own diff — cannot do. Disable with
// finalSweep:false.
// =============================================================================
let sweep = null;
const allDone = isFullRun && !halted && doneIds.length === ALL_SECTIONS.length && ALL_SECTIONS.length > 0;
if (A.finalSweep !== false && allDone) {
  phase('Sweep');
  sweep = await agent(sweepPrompt(doneIds), roleOpts('sweep', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  log(sweep?.complete
    ? `sweep: no goal-coverage gaps found (suite: ${sweep?.suite_result || 'n/a'})`
    : `sweep: ${(sweep?.gaps || []).length} potential gap(s) — see ${SWEEP_FILE}`);
}

// =============================================================================
// Result (control plane → the orchestrating agent; durable progress lives in git + the review-file trail)
// =============================================================================
const status = halted
  ? (haltReason.includes('needs user') || haltReason.includes('user-only') ? 'BLOCKED (needs user input)' : 'halted (section needs attention / budget)')
  : allDone
    ? 'done (all sections staged)'
    : 'partial slice complete';

log(`run: ${status} — ${doneIds.length}/${ALL_SECTIONS.length} section(s) done [${ledger.reduce((s, r) => s + r.qualityRounds, 0)} quality pass(es)]`);

return {
  phase: 'run',
  runId: RUN_ID,
  status,
  halted,
  haltReason: halted ? haltReason : '',
  stateDir: STATE_DIR,
  sectionsDone: doneIds,
  sectionsTotal: ALL_SECTIONS.length,
  sweep: sweep ? { complete: sweep.complete === true, gaps: (sweep.gaps || []).length, suite: sweep.suite_result || '' } : null,
  ledger,
  reviewTrail: `Numbered review files in ${STATE_DIR}/ (quality-review-<section>-rN.md, acceptance-review-<section>-rN.md) show every iteration; git staging marks each accepted section.`,
  followups: halted
    ? `Run halted — read ${NEEDS_USER} (if a hard blocker) and the latest review file for the section in question, resolve with the user, confirm the tree still holds that section's in-progress UNSTAGED work, then resume: re-invoke phase:"run" with the same args + startAt:"<that section id>" (or runOnly).`
    : allDone
      ? `All sections done. Review the staged diff in ${REPO} (git diff --cached), the numbered review files + DISMISSED-*.md in ${STATE_DIR}/ (audit every declined finding)${sweep && sweep.complete !== true ? `, and ${SWEEP_FILE} (coverage gaps!)` : ''}. Run the full gates yourself. Nothing is committed — you commit.`
      : `Partial slice complete (${doneIds.join(', ') || 'none'}). Reconstruct the next start point from git staging + the review trail and re-invoke phase:"run" with startAt the next section (or the full list to also run the final sweep).`,
};
