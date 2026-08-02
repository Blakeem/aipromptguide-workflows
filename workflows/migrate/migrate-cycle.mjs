export const meta = {
  name: 'migrate-cycle',
  description: 'Section-driven migration/upgrade/refactor: drive ONE prose goal — broken into ordered, dependency-sequenced SECTIONS in plan mode — to a production-ready, gate-green state across one target git repo. Per section: develop → BLIND pure-code review (must pass) → plan-aware section-acceptance + regression review (stages on pass), looped per round; the accepted baseline advances section by section. A section that does not accept is PARKED — its work saved to a patch and cleared from the tree — and the run then STOPS, because the later sections depend on it. A whole-goal sweep brackets the run. Agents exchange messages as verbatim files; the harness only routes the section id, round, and verdicts.',
  whenToUse: 'A BREADTH-SPANNING goal across many call sites — migrate a data model, upgrade a language/runtime version, port a framework, refactor a subsystem — that is too big for one bounded feature (use the sibling feature-cycle for that) but is ONE coherent goal. The orchestrating agent decomposes the goal into ORDERED SECTIONS in PLAN MODE (EnterPlanMode → ~/.claude/plans/<name>.md, one "## Section: <id>" per bounded change), the user approves (ExitPlanMode), then runs MANDATORY phase:"refine" (whole-plan adversarial coverage review vs the real repo) — folds in the gaps, ensures a CLEAN unstaged working tree — then phase:"run" (executes the sections in order, staging each on accept). Reuse the same runId + planPath throughout.',
  phases: [
    { title: 'Refine', detail: 'MANDATORY first pass (refine phase only): an independent critic greps the WHOLE change surface, verifies every section of the plan against real code, returns coverage gaps + blocking questions + too_big to the orchestrating agent. Writes nothing.' },
    { title: 'Develop', detail: 'Developer reads the approved plan (verbatim) + its section + the latest review that flagged issues; implements ONLY that section minimally, runs the gate, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no goal), flags production-blocking defects, writes quality-review-<section>-N.md. Must be clean to proceed.' },
    { title: 'Acceptance', detail: 'Plan-aware section gate: every acceptance criterion of THIS section met + reachable + section gate green + no regression vs the staged baseline. Writes acceptance-review-<section>-N.md; on pass, STAGES the section (git add, never commit) — the baseline advances.' },
    { title: 'Park', detail: 'On a section that did not accept within its round budget, or one the developer escalated: SAVES that section\'s work to parked-<id>.patch, then clears it from the tree so the repo is left clean and buildable. The run STOPS either way — the sections after it depend on this one landing — but nothing is destroyed: NEEDS-USER.md carries the restore command.' },
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
// args arrives from the Workflow tool VERBATIM and unvalidated, so a structural typo in a hand-built
// payload dies here as a bare parse error naming the runtime. Name the payload and the fix instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
if (!A || !A.runId || !(A.planPath || (A.plan && typeof A.plan !== 'object'))) {
  throw new Error('args must include at least { runId, planPath | plan (markdown string), sections, target, gates }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally the workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// `target.repo` is REQUIRED and has NO default (both phases). It used to fall back to `.`, i.e. ROOT —
// so an omitted repo pointed every `git -C`, the park procedure's `checkout --` + file deletion, and the
// gate commands at the workflow TOOL's own working tree instead of failing loud.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the TARGET git repo. There is no default — an omitted repo would silently run every git command (including park\'s checkout/delete) against this workflow tool\'s own directory.');
}

const PHASE       = A.phase ?? 'run';                       // 'refine' (review the plan, stop) | 'run' (execute sections)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example to mirror
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
// A non-numeric bound must THROW, never coerce. `round < 'three'` is false on the first test, so the
// per-section loop would never run: the first section would park having never spawned a developer, and
// the run would stop there reporting that as an ordinary "could not accept" outcome. A documented default
// is not a licence to accept garbage — same reasoning as the `target.repo` guard below.
// Nothing is COERCED: `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite, so a
// coercing check waves through exactly the garbage that silently disables a bound. The upper bound is not
// decoration either — a fat-fingered `maxRounds: 100000` otherwise spawns agents until something dies.
// The message leads with a STATIC clause because tools/gen-flows.mjs labels a throw node with the first
// clause of its static prefix; starting with `args.${name}` rendered the node as "throw: args.".
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage parks the first section without ever spawning a developer.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 4, 50);    // develop→quality→acceptance rounds per section before "needs-attention"
const MIN_SECTION_BUDGET = num(A.minSectionBudget, 'minSectionBudget', 0, 150_000); // token floor to start another section

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType that
// exists in YOUR registry. Acceptance is opus (spec + regression, high stakes); the blind quality
// critic is opus too — measured 2026-08-01 (wt-tooling): the fast tier surfaced ONE deep-verified defect
// per round on large diffs, serializing discovery. Sweep stays fast — it searches, it doesn't review.
const M  = { develop: 'opus', quality: 'opus', acceptance: 'opus', refine: 'opus', sweep: 'sonnet', ...(A.models ?? {}) };
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
const REPO        = abs(TARGET.repo);                      // absolute path to the target git repo (required)
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const PLAN_INLINE = (!A.planPath && A.plan && typeof A.plan !== 'object') ? String(A.plan) : '';
// Blind-reviewer placement guard (#3): run-state must live OUTSIDE the target repo so the blind quality
// reviewer cannot reach the review/ledger files through the repo tree. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the review/ledger files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
// The PLAN has the same exposure, one door over: a plan file inside the target repo puts the SPEC where
// the blind quality reviewer can reach it through the repo tree, and where the diff/park machinery could
// sweep it. WARN rather than throw, matching the run-state guard's precedent. Sections carry no path of
// their own ({id, title, gate, planContext}), so this single check is the whole surface here; an INLINE
// plan (`plan` as a markdown string) has no path at all and is skipped by construction.
if (PLAN_PATH && REPO && (PLAN_PATH === REPO || PLAN_PATH.startsWith(REPO + '/'))) {
  log(`⚠ plan file (${PLAN_PATH}) resolves inside the target repo — the blind quality reviewer could read the spec straight out of the repo tree, and the diff/park machinery could sweep it. Move the plan under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path — never one inside the target repo.`);
}
// The plan reference handed to plan-aware agents (developer, acceptance, refine, sweep). NEVER handed
// to the blind quality reviewer.
const PLAN_REF    = PLAN_PATH ? `the approved plan file at ${PLAN_PATH} (read it VERBATIM)` : `the approved plan below:\n-----\n${PLAN_INLINE}\n-----`;
// How an agent gets its ONE section out of the verbatim plan. Default (`planContext:'block'`): a
// COMMAND that prints just that section, so a twelve-section migration plan never enters a developer's
// context and the section's END is decided by a parser rather than by eye. `planContext:'full'` hands
// the file instead, for a section that genuinely needs its neighbours in view. An INLINE plan has no
// file to address, so it keeps the by-header wording.
// Where the plan-block tool lives. The default hangs it off ROOT because a checkout keeps engine,
// tools and run-state under one folder — but an INSTALLED plugin splits them: run-state (ROOT) goes to
// the persistent plugin data dir while tools/ ships in the versioned plugin cache. args.blockTool
// carries the installed tool's absolute path in that case; without it a sectioned run whose ROOT has no
// tools/ hands every agent a command that exits non-zero and halts on plan_obtained=false.
const BLOCK_TOOL  = A.blockTool ? abs(A.blockTool) : `${ROOT}/tools/plan-block.mjs`;
const blockRef    = (id) => `the output of:  node '${BLOCK_TOOL}' '${PLAN_PATH}' '${id}' --kind section
Run it and implement EXACTLY what it prints — that is your section, verbatim. If it exits non-zero,
report plan_obtained=false and STOP: never guess at a section you could not read. The full plan is at
${PLAN_PATH} if you need a neighbouring section for context; implement ONLY "${id}"`;
const sectionRef  = (s) => !PLAN_PATH
  // An INLINE plan has no file to address OR to run a command against, so the body must travel in the
  // prompt itself. It previously said "the section headed X in the plan above" while no plan was above:
  // PLAN_REF reaches only refine and the sweep, never develop or acceptance, so the developer was told
  // to read a document it had never been given.
  ? `the section headed "## Section: ${s.id}" in the approved plan below (the other sections are CONTEXT only; do NOT implement them):\n-----\n${PLAN_INLINE}\n-----`
  : s.planContext === 'full'
    ? `the section headed "## Section: ${s.id}" inside ${PLAN_PATH} (read THAT section verbatim — the other sections are CONTEXT only; do NOT implement them)`
    : blockRef(s.id);

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
  .map((s) => ({
    id: String(s.id),
    title: s.title || s.id,
    gate: VALID_GATES.has(s.gate) ? s.gate : 'green',
    planContext: s.planContext === 'full' ? 'full' : 'block',
  }));

// An id routes review/ledger file names AND is interpolated into the block command, so anything but a
// kebab slug is either a file-name collision (two ids that `slug()` folds together silently share one
// DISMISSED file) or a shell metacharacter in a command an agent runs. The plan-block tool enforces
// this on the file's headers; the engine must enforce the same rule on the control array.
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BAD_IDS = ALL_SECTIONS.filter((s) => !KEBAB_ID.test(s.id)).map((s) => s.id);
if (BAD_IDS.length) {
  throw new Error(`section id(s) [${BAD_IDS.join(', ')}] are not kebab slugs (a-z, 0-9, single hyphens). An id names this section's review + ledger files and is passed to the plan-block command, so it must carry no spaces, punctuation or shell characters.`);
}

// A gate is control input like the ids above, and this file fails loud on every other one (unknown
// runOnly/startAt ids, a missing gates.build/test). Coercing an unrecognized value to 'green' instead
// meant a section typoed `red_baseline` got the gate that DEMANDS the very tests a test-first section
// intends to leave failing — a guaranteed park after the full round budget. Read off the RAW entries,
// because the normalization above has already flattened them. An OMITTED gate keeps the 'green' default:
// only a value that was typed and is wrong throws.
const BAD_GATES = (Array.isArray(A.sections) ? A.sections : [])
  .filter((s) => s && typeof s === 'object' && s.gate != null && !VALID_GATES.has(s.gate))
  .map((s) => `${s.id ?? '(no id)'}: ${s.gate}`);
if (BAD_GATES.length) {
  throw new Error(`section gate(s) [${BAD_GATES.join(', ')}] are not one of green | red-baseline | build-only. A gate decides what "done" MEANS for its section, so an unrecognized value must never coerce. Omit the field entirely to take the green default.`);
}

const qualityFile    = (id, r) => `${STATE_DIR}/quality-review-${slug(id)}-r${r}.md`;
const acceptanceFile = (id, r) => `${STATE_DIR}/acceptance-review-${slug(id)}-r${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;            // full detail; for the user (may halt the run) — GLOBAL/cumulative
const dismissedFile  = (id) => `${STATE_DIR}/DISMISSED-${slug(id)}.md`;  // terse ledger; developer → reviewers (anti-spin) — PER SECTION
// Section clauses the developer OVERRODE under MATRIX 6a, having verified the clause prescribes a real
// defect — PER SECTION. Read by the ACCEPTANCE verifier only: it is deliberately NOT in SETTLED and never
// reaches the blind quality reviewer, which would otherwise learn the plan's content from it (#3).
const amendedFile    = (id) => `${STATE_DIR}/AMENDED-${slug(id)}.md`;
const parkedPatch    = (id) => `${STATE_DIR}/parked-${slug(id)}.patch`;    // a section's work, saved before the tree is cleared
const parkedNewDir   = (id) => `${STATE_DIR}/parked-${slug(id)}-newfiles`; // untracked files the patch could not carry (rare)
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
  // A red baseline needs the same false-red guard green gets below: a mistyped selector collects NOTHING
  // and exits non-zero, and a developer that EXPECTS failure at the red step reports `failed-expected`
  // with a count of 0 — a gate passed on a test that never ran, staged as a phantom TDD baseline.
  // `!== 0` not `> 0`: -1 is the schema's N/A (manual/MCP verification) and stays legal.
  if (gate === 'red-baseline') return dev.test_outcome === 'failed-expected' && dev.tests_run_count !== 0;
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
  required: ['plan_obtained', 'baseline_dirty_files', 'produced', 'build_passed', 'test_outcome', 'tests_run_count', 'unstaged_confirmed', 'needs_user', 'plan_amendments'],
  properties: {
    plan_obtained:     { type: 'boolean', description: 'true if you actually HAVE your section text — the plan-block command exited 0 and printed it, or (ONLY when you were handed a plan file rather than a command) you read that file. A command that failed means FALSE — never fall back to locating your section by eye in the plan file. FALSE halts the run: never build from a section you could not read.' },
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files already had UNSTAGED or untracked changes BEFORE you touched anything (staged files are the accepted baseline — never counted). 0 = clean; >0 HALTS the run. Report -1 on later rounds (the check does not apply).' },
    produced:          { type: 'boolean', description: 'true if you changed or added at least one file this round' },
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed-expected', 'failed-unexpected', 'not-run'], description: 'passed = this section\'s selector tests ran and PASSED. failed-expected = red baseline exactly as a test-first section intends. failed-unexpected = failed for a WRONG reason (a real defect / bad fixture). not-run = no tests executed.' },
    tests_run_count:   { type: 'integer', description: 'unit/integration tests the runner ACTUALLY executed for this section\'s selector (0 = selector matched nothing = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q tests/foo.py", "phpunit --filter Bar"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add NOT run on content; git add -N only, for new files)' },
    needs_user:        { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to this section\'s DISMISSED file this round (0 if none)' },
    // REQUIRED, unlike its optional twin dismissed_count: the DISMISSED file is its own standing record,
    // while an amendment's ABSENCE has to be an explicit claim of zero — an omitted field must not be
    // indistinguishable from "none this round".
    plan_amendments:   { type: 'integer', description: 'how many SECTION CLAUSES you overrode under MATRIX 6a this round — each one a defect you VERIFIED in what the section prescribes, recorded as an entry in this section\'s AMENDED file. Report 0 when there were none; this field is required, so "none" must be stated, never omitted.' },
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
  required: ['plan_obtained', 'pass', 'staged', 'reachable', 'criteria_total', 'criteria_met', 'evidence_recorded'],
  properties: {
    plan_obtained: { type: 'boolean', description: 'true if you actually HAVE the section text you are judging against — the plan-block command exited 0 and printed it, or (ONLY when you were handed a plan file rather than a command) you read that file. A command that failed means FALSE — never fall back to locating the section by eye. FALSE halts the run: a verdict reached without the spec is worthless.' },
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
// PARK — the terminal outcome for a section that did not accept, and for one the developer escalated.
// Its work is SAVED to a patch and then CLEARED from the tree, so EVERY exit leaves a clean unstaged
// tree — which is what lets the clean-baseline precondition be unconditional, including on resume.
// UNLIKE feature-cycle, a parked section does NOT let the run continue: migrate's sections are an
// ORDERED decomposition of ONE goal, so section N+1 routinely depends on N having landed. Parking here
// buys a clean, buildable tree and a saved patch — not a continued run.
const PARK_SCHEMA = {
  type: 'object',
  required: ['saved', 'cleared', 'gates_green'],
  properties: {
    saved:       { type: 'boolean', description: 'true ONLY if the patch file was written and you confirmed it is non-empty. If false, you must NOT have cleared the tree.' },
    cleared:     { type: 'boolean', description: 'true if the work was then removed from the working tree and `git diff` is empty' },
    gates_green: { type: 'boolean', description: 'true if the BUILD gate passes again after clearing' },
    patch_bytes: { type: 'integer', description: 'size of the written patch file — 0 means nothing was saved' },
    strays_saved:{ type: 'integer', description: 'how many untracked files you copied to the -newfiles dir in step 2 (0 if none). Non-zero means the restore needs a SECOND step beyond git apply, and step 4 must say so.' },
    notes:       { type: 'string' },
  },
};

const parkPrompt = (section, lastReviewPath, escalated) => `
You are PARKING the migration section "${section.id}", which ${escalated
    ? `hit a BLOCKER the developer escalated to the user (see ${NEEDS_USER})`
    : `did NOT reach acceptance within its round budget`}. The run stops after you either way — the
sections after this one depend on it — but its work is NOT thrown away and NOT left lying in the
working tree: you SAVE it to a patch, then clear the tree so the repo is in a known, buildable state the
user can come back to (or run something else against) before resuming.
TARGET REPO: ${REPO}
STAGING CONTRACT:
  • staged index + HEAD  = ACCEPTED sections (the baseline). Treat as known-good; do NOT touch.
  • unstaged working tree = THIS section's unsuccessful work — the only thing you save and clear.
  • Nothing is EVER committed.

SAVE BEFORE YOU CLEAR — never the other way round. If step 1 does not produce a non-empty patch, STOP:
leave the tree exactly as it is and return saved=false, cleared=false.

PROCEDURE:
1. SAVE. \`git -C ${REPO} status --porcelain\` first. If \`git -C ${REPO} diff\` is already EMPTY there is
   nothing to park — skip to step 3 and return saved=false, patch_bytes=0, with a note saying so.
   Otherwise: \`git -C ${REPO} diff --binary > ${parkedPatch(section.id)}\` (create ${STATE_DIR}/ if needed).
   \`--binary\` is REQUIRED (a plain diff records "Binary files differ" and will not re-apply). Confirm the
   file exists and is non-empty; record its size as patch_bytes.
2. CATCH STRAYS. If \`git status --porcelain\` still lists any \`??\` untracked file this section created
   (the developer missed its \`git add -N\`), COPY those into ${parkedNewDir(section.id)}/ preserving
   relative paths — the patch CANNOT carry them. Skip build output and caches. Report the count as
   strays_saved.
3. CLEAR. \`git -C ${REPO} checkout -- <the tracked files this section modified>\`, then delete the files
   it CREATED (untracked + \`git add -N\` intent-to-add entries). An intent-to-add file is safe because the
   patch carries it; a \`??\` stray is safe ONLY because step 2 copied it. If step 2 did not copy a stray,
   do NOT delete it. Confirm \`git -C ${REPO} diff\` is EMPTY, then run the BUILD gate and record whether
   it is green.
4. RECORD. Append ONE entry to ${NEEDS_USER} under a \`## Parked section: ${section.id}\` heading:
   - that this section is **NOT done and NOT abandoned — a status record, not a dismissal** — and that
     the sections after it were NOT attempted, because they depend on this one
   - one line on why it was parked (${escalated ? 'the blocker the developer escalated' : 'what acceptance was still failing'})
   - ${lastReviewPath ? `the diagnosis: \`${lastReviewPath}\`` : `that this section produced NO review file — its gate never went green, so neither reviewer ever ran; point the user at the run trail in ${STATE_DIR} instead of naming a file`}
   - the saved work: \`${parkedPatch(section.id)}\`
   - restore command, verbatim: \`git -C ${REPO} apply --3way ${parkedPatch(section.id)}\`
   - **ONLY IF step 2 actually copied stray files**: a line naming \`${parkedNewDir(section.id)}/\`, listing
     them, and telling the user to copy them back (preserving relative paths) as a SECOND step after the
     \`git apply\`. Omit this line entirely when there were no strays.
   - how to resume: fix the blocker (sharpening that section of the plan if needed), then re-invoke with
     \`startAt:"${section.id}"\` from the CLEAN baseline and let the developer redo the section — the
     default, with the patch kept for reference. The ONLY alternative is to apply the patch and finish
     this section BY HAND, because a resumed run requires a clean unstaged tree and halts on a dirty
     one. Do NOT tell the user to \`git add -A\` the restored work: that folds UN-reviewed code into the
     accepted baseline, invisible to the blind reviewer
Do NOT touch the staged baseline, do NOT commit, and do NOT modify any file outside this section's work.
Return saved + cleared + gates_green + patch_bytes + strays_saved via the schema.`;

const ENV = `GOAL CONTEXT — this run drives ONE breadth-spanning goal, decomposed into ordered sections in the plan.
TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example of this kind of change — mine it for the canonical pattern): ${REFERENCE_P}\n` : ''}CONVENTIONS (match these): ${CONVENTIONS}
GATES (the commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
BE TOKEN-ECONOMICAL: read ONLY the files this section touches plus the SPECIFIC reference/plan section
you need — do NOT re-read the whole tree, the whole plan body, or the entire reference. Prefer targeted
grep over broad reads. Don't restate large files back; act on them.`;

const MATRIX = (id, round) => `DECISION MATRIX — for each ambiguity or review finding, route it yourself IN ORDER (first match wins):
  1. Not a real problem / false positive .............. DROP — LOG it (see LOGGING).
  2. Pre-existing in untouched code (not yours) ....... DROP silently (out of scope; never fix — regression risk).
  3. Stops the build/tests/verification ............... FIX (always).
  4. A real, clear, in-scope fix (local, small) ....... FIX.
  5. Needed to satisfy THIS section / wire it in ...... FIX (an unreachable or incomplete section is not done).
  6a. Conflicts with the plan AND you VERIFIED that what this section PRESCRIBES is itself defective —
      you reproduced it, or demonstrated the failure path, to the same evidence bar as any FIX
        .............................................. FIX it: the verified defect outranks the
      prescription. RECORD an amendment (see LOGGING).
      PRECEDENCE — for THIS clause only, that verified defect also outranks the "NO scope creep beyond
      it" instruction above and the CONVENTIONS rubric. Everywhere else the plan and the conventions
      still bind, exactly as written.
  6b. Conflicts with the plan but you did NOT verify it / intentional / not a real-world code path
        .............................................. DROP — LOG it (see LOGGING).
  7. A genuine DESIGN/BUSINESS choice only the USER can make, OR a blocker you cannot resolve in scope
        .............................................. ESCALATE (see LOGGING).
  8. Anything else (style, medium/low polish, a different section's work) ... DROP silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. NEVER log the same dismissal twice.

LOGGING — this (plus your code) is your ONLY output. Keep it minimal and unambiguous:
  • DROP (1 or 6b): append ONE terse line to ${dismissedFile(id)} so reviewers won't re-raise it —
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • AMEND (6a): append ONE entry to ${amendedFile(id)} —
      \`## Section amendment: ${id} r${round}\`
      then the section clause you overrode (QUOTED verbatim), the defect (file:line + one line on why it
      is real), and what you built instead.
    Then append ONE POINTER line to ${NEEDS_USER}: the section id, the round, the defect's file:line, and
    the path ${amendedFile(id)} — and NO plan text, so the amendment reaches the user where they already
    look without copying the spec anywhere else. Count every entry you wrote in plan_amendments.
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
You are the DEVELOPER. Implement ${sectionRef(section)}. Build ONLY this section minimally and
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
5. ${MATRIX(section.id, round)}
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
regressed. Read ${sectionRef(section)}.
${ENV}
SECTION: ${section.id} — ${section.title}   (gate: ${section.gate})

${SETTLED(section.id, false)}
OVERRIDE: ${dismissedFile(section.id)} entries are the developer's judgment calls. You are plan-aware —
if a dismissed item ACTUALLY breaks one of this section's acceptance criteria, leaves it unreachable,
or causes a regression, that OVERRIDES the dismissal: fail acceptance for it and record it in your file.

AMENDMENTS: READ ${amendedFile(section.id)} if it exists. It records section clauses the developer
OVERRODE after verifying the clause itself prescribes a real defect (MATRIX 6a). Judge a criterion whose
prescribing clause was amended against the AMENDED behavior, not the superseded clause, and NAME every
criterion you judged under an amendment in your review file. An amendment entry that states NO defect
evidence excuses NOTHING — that criterion stays UNMET, or the escape hatch becomes a free pass.

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
  // A dead critic must NEVER read as a clean plan. Every field below would otherwise launder null into
  // exactly that — verdict "ready", 0 gaps, 0 questions, nextStep "Plan is sound" — and since refine is
  // the ONLY gate on a plan before the developer builds against it, the review would be DELETED rather
  // than degraded, and reported as passed. (Twin of the same guard in feature-cycle.)
  if (!critique) throw new Error('Plan critic returned nothing (agent skipped or died) — that is NOT a clean plan review. Re-invoke with the same args (same runId); pass the Workflow tool\'s resumeFromRunId to replay completed agents from cache.');
  const gaps = Array.isArray(critique.gaps) ? critique.gaps : [];
  const questions = Array.isArray(critique.questions) ? critique.questions : [];
  log(`refine: verdict=${critique.verdict ?? 'ready'} — ${gaps.length} gap(s), ${questions.length} question(s)${critique.too_big ? ' [a section is TOO BIG — split it]' : ''}`);
  return {
    phase: 'refine',
    runId: RUN_ID,
    verdict: critique.verdict ?? 'ready',
    tooBig: critique.too_big === true,
    gaps,
    questions,
    notes: critique.notes || '',
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
// The gate commands are what "it works" MEANS here, and gateOk() only enforces the build when
// GATES.build is set — so an omitted command turns the build gate into a no-op and a build-only section
// passes with nothing ever compiled. Required, and required to fail loud.
if (typeof A.gates?.build !== 'string' || !A.gates.build.trim()) {
  throw new Error('args.gates.build is required for phase:"run": the shell command that defines a GREEN build (non-zero exit = fail). Without it the build gate silently no-ops and a section can pass with nothing compiled.');
}
if (ALL_SECTIONS.some((s) => s.gate === 'green') && (typeof A.gates?.test !== 'string' || !A.gates.test.trim())) {
  throw new Error('args.gates.test is required when any section has gate:"green": the shell command that runs this section\'s selector tests (non-zero exit = fail). A mechanical/testless section takes gate:"build-only" instead.');
}

// Resume / partial-slice scoping (control plane, supplied by the orchestrator after it reconstructs
// progress from git-staging + the review-file trail — there is no progress file by design, #6/#10).
//   runOnly: [ids]  — run exactly these sections (in plan order).
//   startAt: id     — run from this section to the end (skip already-accepted earlier ones).
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
let pending = ALL_SECTIONS;
if (runOnly) {
  pending = ALL_SECTIONS.filter((s) => runOnly.includes(s.id));
  // An unknown id must FAIL FAST, exactly as startAt does below: a silently dropped id runs fewer
  // sections than the operator asked for — and if every id is a typo, none at all, reported as a
  // benign "partial slice complete" with no error.
  const unknown = runOnly.filter((id) => !ALL_SECTIONS.some((s) => s.id === id));
  if (unknown.length) throw new Error(`args.runOnly ${unknown.map((id) => `"${id}"`).join(', ')} matches no section id. Valid ids: ${ALL_SECTIONS.map((s) => s.id).join(', ')}`);
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
// WHY the run halted, as a value rather than prose. The status line used to sniff substrings out of
// haltReason, so every new halt reason (park, dirty baseline, budget) silently reported the same
// generic status; every halt site now sets this.
let haltKind = '';
const doneIds = [];

for (const section of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between sections rather
  // than letting an agent() call throw mid-section. Accepted sections are STAGED; resume continues.
  if (budget.total && budget.remaining() < MIN_SECTION_BUDGET) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltKind = 'budget';
    haltReason = `Stopped before section ${section.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minSectionBudget). Resume phase:"run" with startAt:"${section.id}".`;
    log(`⏸ ${haltReason}`);
    break;
  }

  log(`▶ section ${section.id} — ${section.title} [gate=${section.gate}]`);
  const rec = { id: section.id, title: section.title, gate: section.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, planAmendments: 0, staged: false, reachable: false, regression: false, criteria: null, thinEvidence: false, contradicted: false };
  let reviewPath = '';           // the latest review file the developer must address (control: a path only)
  let accepted = false;
  // An escalation leaves real work in the tree (park it); a dirty-baseline halt changed nothing
  // and that work is the OPERATOR's (never park it).
  let escalated = false;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    rec.rounds = round;

    // ---- DEVELOP -----------------------------------------------------------
    phase('Develop');
    const dev = await agent(developPrompt(section, round, reviewPath), roleOpts('develop', {
      schema: DEVELOP_SCHEMA, phase: 'Develop', label: `develop ${section.id} r${round}`,
    }));

    // ---- PRECONDITION: the developer AGENT itself came back --------------------------------------
    // A dead agent is not a failed round: nothing is known about the tree either way. Unguarded it fell
    // into `gateOk(!dev) === false` and read as an ordinary gate miss, so the section burned its whole
    // round budget and was reported `parked (not accepted within round budget)` — telling the operator
    // to sharpen the plan when the real action is resume/replay. A HALT, not a throw: a throw inside the
    // section loop exits with the developer's work still unstaged and unparked. (The refine critic
    // throws instead because it is solo, writes nothing, and has no tree to save.)
    if (!dev) {
      halted = true;
      escalated = true;   // it may have touched the tree before dying → park rather than abandon
      haltKind = 'agent-dead';
      haltReason = `Developer for section ${section.id} returned nothing in round ${round} (agent skipped or died) — no work can be assumed either way. Re-invoke with the same args/runId; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${section.id} r${round}: developer returned nothing (agent skipped or died) → halting before any review agent`);
      break;
    }

    // ---- PRECONDITION: the developer actually HAS its section ------------------------------------
    // The block command runs in the AGENT's shell, so the harness cannot verify it (no tools). This
    // attestation is the only signal that the section ever arrived — without a consumer it would be
    // pure theater, and an agent whose command was denied, or whose id matches no block, would build
    // something plausible while the run reported success. `=== false` so a dead agent (null) is caught
    // by the halt directly above rather than being laundered into this one.
    if (dev?.plan_obtained === false) {
      halted = true;
      escalated = true;   // it may have touched the tree before giving up → park rather than abandon
      haltKind = 'plan-unreadable';
      haltReason = `Developer for section ${section.id} could not obtain its section (round ${round}). Its section reference was: ${sectionRef(section)}. Run that yourself: a non-zero exit names the cause (an id matching no "## Section:" block, a pruned or mistyped plan file, or the command not permitted in this environment). Nothing was built from a guess.`;
      rec.status = 'BLOCKED (plan unreadable)';
      log(`  ✋ ${section.id} r${round}: developer never got its section → halting before any review agent`);
      break;
    }

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
        haltKind = 'dirty-baseline';
        haltReason = `Section ${section.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the reviewers' scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain), then run ONE command and re-invoke this run unchanged: \`git -C ${REPO} add -A\` to KEEP it (folds it into the accepted baseline), or \`git -C ${REPO} stash -u\` to set it aside. Nothing was built or changed.`;
        log(`  ✋ ${section.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before any review agent (git add -A to fold into the baseline, or git stash -u, then re-run)`);
        break;
      }
    }
    if (dev?.needs_user === true) {
      halted = true;
      escalated = true;
      haltKind = 'needs-user';
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
    // MATRIX 6a: the developer overrode a section clause it verified defective. The COUNT is control
    // plane (#1/#8) — the amendment text stays in AMENDED-<id>.md, which only acceptance is handed.
    // Coerced and floored so a garbage value cannot poison the ledger total; 0/absent logs nothing.
    const amendments = Number(dev?.plan_amendments) || 0;
    if (amendments > 0) {
      rec.planAmendments += amendments;
      log(`  ⚠ ${section.id} r${round}: ${amendments} plan amendment(s) recorded — see ${amendedFile(section.id)}`);
    }
    if (!gateOk(section.gate, dev)) {
      // Gate not satisfied and no user escalation: give the developer another fresh round to fix it (it
      // re-runs the gate and sees the failure live). RETAIN reviewPath — if a prior review is still open
      // (e.g. a quality CONTEST not yet re-confirmed clean), the developer must keep addressing it while
      // also fixing the gate; only a clean quality review advances the pointer. On round 1 it is '' anyway.
      // The developer re-runs the gate live each round, so the engine holds the only copy of WHY it was
      // red once the round budget is gone — surface its diagnostics here rather than collecting them
      // into a schema nothing reads. Prose stays out of the control plane: log only.
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${section.id} r${round}: gate(${section.gate}) not satisfied at round budget (via=${dev?.verification_method || 'n/a'})${dev?.gate_output ? ` — last gate output: ${String(dev.gate_output).slice(-500)}` : ''}`); break; }
      log(`  ↻ ${section.id} r${round}: gate(${section.gate}) not satisfied (build=${dev?.build_passed}, test=${dev?.test_outcome}, count=${dev?.tests_run_count}, via=${dev?.verification_method || 'n/a'}) → another develop round`);
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
      // A dead blind reviewer is NOT a clean review. Left unguarded, `quality?.clean !== true` sent the
      // developer to a quality-review file that was never written ("READ <path> and resolve exactly
      // those"), so the next round either stalls on a missing file or invents fixes and churns the tree.
      if (!quality) {
        halted = true;
        escalated = true;
        haltKind = 'agent-dead';
        haltReason = `Quality reviewer for section ${section.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a clean review. Re-invoke with the same args/runId; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
        rec.status = 'BLOCKED (agent died)';
        log(`  ✋ ${section.id} r${round}: quality reviewer returned nothing (agent skipped or died) → halting`);
        break;
      }
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
    // Same shape as the two guards above: a dead verifier is not a gap verdict. Unguarded it fell to the
    // bottom of the loop and pointed the next developer at an acceptance-review file nobody wrote.
    if (!acc) {
      halted = true;
      escalated = true;
      haltKind = 'agent-dead';
      haltReason = `Acceptance verifier for section ${section.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a gap verdict, and nothing was staged. Re-invoke with the same args/runId; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${section.id} r${round}: acceptance verifier returned nothing (agent skipped or died) → halting`);
      break;
    }
    // The verifier's sibling of the developer's check. An acceptance verifier without the section has
    // no criteria to judge — its `pass:false` would otherwise read as an ordinary gap and park the
    // section, hiding "the spec never arrived" behind a routine round-budget failure.
    if (acc?.plan_obtained === false) {
      halted = true;
      escalated = true;
      haltKind = 'plan-unreadable';
      haltReason = `Acceptance verifier for section ${section.id} could not obtain its section (round ${round}), so it had no criteria to judge. Its section reference was: ${sectionRef(section)}. Run that yourself: a non-zero exit names the cause.`;
      rec.status = 'BLOCKED (plan unreadable)';
      log(`  ✋ ${section.id} r${round}: acceptance never got its section → halting`);
      break;
    }
    if (acc?.regression === true) rec.regression = true;
    rec.criteria = { met: Number(acc?.criteria_met) || 0, total: Number(acc?.criteria_total) || 0 };
    if (acc?.pass === true) {
      rec.reachable = acc?.reachable === true;
      // A pass is only as good as the enumeration behind it: no criteria, an incomplete count, or
      // missing locators means the verdict rests on assertion, not evidence (#14). Detection only —
      // acceptance already staged, so flag it for the operator's audit rather than failing the section.
      rec.thinEvidence = rec.criteria.total === 0 || rec.criteria.met < rec.criteria.total || acc?.evidence_recorded !== true;
      // `pass` MEANS "reachable and nothing regressed" (ACCEPTANCE_SCHEMA), and both fields are REQUIRED
      // — so a pass alongside either one contradicts the verdict's own definition and cannot be a
      // missing-field artifact. Flag both; HALT only on the regression, whose harm compounds hardest
      // here: staged work becomes the baseline every LATER section (an ordered decomposition, each
      // building on the last) is judged against. An unreachable section is bad but inert, and §7 already
      // tells the operator to grep the integration points.
      rec.contradicted = acc?.regression === true || acc?.reachable !== true;
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (evidence_recorded=${acc?.evidence_recorded}) — audit ${acceptanceFile(section.id, round)}` : '';
      const contraNote = rec.contradicted ? ` ⚠ CONTRADICTS ITS OWN PASS (regression=${acc?.regression}, reachable=${acc?.reachable}) — audit ${acceptanceFile(section.id, round)}` : '';
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        log(`  ✓ ${section.id}: acceptance PASSED — ${rec.criteria.met}/${rec.criteria.total} criteria — STAGED (reachable=${acc?.reachable}, gate=${acc?.suite_result || 'n/a'})${thinNote}${contraNote}`);
        // Staged WITH a self-reported regression: stop here. Not another review round (the verifier
        // already ran `git add`, so a re-round would leave staged-but-unaccepted work the next blind
        // reviewer cannot see) and not a park (the work is staged; park must never touch the baseline).
        // The section stays "done (staged)" — what halts is everything AFTER it.
        if (acc?.regression === true) {
          halted = true;
          haltKind = 'acceptance-regression';
          haltReason = `Section ${section.id} was STAGED by acceptance while the SAME verdict reported regression=true — a self-contradictory return (see ${acceptanceFile(section.id, round)}). Its work is now the baseline every later section would build on and be judged against, so the run stops here. Inspect \`git -C ${REPO} diff --cached\`; unstage/fix it, then resume from the NEXT section.`;
          log(`  ✋ ${section.id}: staged while self-reporting a REGRESSION → halting the run (inspect git -C ${REPO} diff --cached)`);
        }
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next section's blind diff would
      // include this section's unstaged work. Do NOT advance; halt for manual staging, then resume.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage — stage manually, then resume)';
      haltKind = 'passed-unstaged';
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

  // ---- PARK, then halt ---------------------------------------------------------------------------
  // Reached on either terminal outcome: round budget exhausted, or a developer escalation. The run stops
  // either way (later sections depend on this one), but the section's work is SAVED to a patch and the
  // tree is CLEARED — leaving the repo buildable and clean, which is also what makes the clean-baseline
  // precondition correct on the resume. NOT reached on a dirty-baseline halt: nothing was changed there
  // and the work in the tree is the operator's, so parking it would take their changes hostage.
  if (!(halted && !escalated)) {
    if (!halted) {
      halted = true;
      rec.status = 'parked (not accepted within round budget)';
      haltKind = 'parked';
      // `reviewPath` is EMPTY when the section never produced a review file (its gate never went green,
      // so neither reviewer ever ran). Naming an acceptance-review path that was never written points
      // the operator — days later, in the one cumulative record — at a file that does not exist.
      haltReason = `Section ${section.id} did not reach acceptance within ${MAX_ROUNDS} rounds (${reviewPath ? `see ${reviewPath}` : `it produced no review file — its gate never went green; see the run trail in ${STATE_DIR}`}).`;
      log(`  ✋ ${section.id}: not accepted within ${MAX_ROUNDS} rounds → parking its work, then halting`);
    }
    phase('Park');
    const pk = await agent(parkPrompt(section, reviewPath, escalated), roleOpts('develop', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${section.id}`,
    }));
    const strays = pk?.strays_saved ?? 0;
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    rec.patch = (pk?.saved === true || contradictory) ? parkedPatch(section.id) : null;
    if (strays > 0) rec.strays = parkedNewDir(section.id);
    // Park's `notes` is the only place the "nothing to park" case can explain itself: step 1 tells the
    // agent to skip ahead with saved=false, patch_bytes=0 "and a note saying so", and without surfacing it
    // the line reads `work saved to nothing to save` with no reason given. Prose stays out of the control
    // plane — log only, same as resolve-cycle's twin.
    log(`  ⚠ ${section.id}: PARKED (work saved to ${rec.patch || 'nothing to save'}${pk?.patch_bytes ? `, ${pk.patch_bytes}B` : ''}${strays > 0 ? `, +${strays} stray file(s) in ${parkedNewDir(section.id)}/` : ''}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${pk?.gates_green ? 'green' : 'RED'}) — see ${NEEDS_USER}${pk?.notes ? ` — park note: ${String(pk.notes).slice(0, 300)}` : ''}`);
    // A tree we could not clear (or a self-contradictory park report) leaves the repo unsafe to resume
    // into, which is a different operator problem from a plain park — say so in the status, not just
    // deep in the reason string.
    if (contradictory) {
      haltKind = 'park-unsafe';
      haltReason += ` Park reported saved=false while writing ${pk.patch_bytes} bytes to ${parkedPatch(section.id)} — the report contradicts itself; the patch is real, inspect it before resuming.`;
    } else if (pk?.cleared !== true) {
      haltKind = 'park-unsafe';
      haltReason += ` Its work could NOT be cleared from the tree${pk?.saved === true ? ` (it IS saved to ${parkedPatch(section.id)})` : ' and was NOT saved — the tree still holds it'}; clean the tree yourself before resuming.`;
    } else if (pk?.gates_green === false) {
      // A cleared tree is not a SAFE tree. `gates_green` was required by PARK_SCHEMA, demanded by the
      // prompt and printed in the log above, but nothing read it — so a park that left the build RED
      // fell through to the "tree is CLEAN, resume from this section" branch below and told the operator
      // to resume into a broken build. Siblings both halt on it (feature-cycle.mjs, resolve-cycle.mjs).
      haltKind = 'park-unsafe';
      haltReason += ` Its work IS saved to ${parkedPatch(section.id)} and the tree was cleared, but the BUILD is RED afterwards — the tree is unsafe to resume into. Fix the build before re-running this section.`;
    } else {
      haltReason += ` Its work is SAVED to ${parkedPatch(section.id)} and the tree is CLEAN; resolve with the user, then resume from this section.`;
    }
  }
  // Unreachable today (every exit sets a status, or parks — which sets one), and kept as a guard for a
  // future exit that forgets. It must name itself an ENGINE BUG rather than leak the initial 'pending',
  // which in a finished run's ledger reads as "still working" — see resolve-cycle's twin.
  if (rec.status === 'pending') rec.status = 'BLOCKED (engine bug: section finished with no status set)';
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
let sweepFailed = false;   // the sweep RAN and DIED — distinct from the two legitimate did-not-run cases
const allDone = isFullRun && !halted && doneIds.length === ALL_SECTIONS.length && ALL_SECTIONS.length > 0;
if (A.finalSweep !== false && allDone) {
  phase('Sweep');
  sweep = await agent(sweepPrompt(doneIds), roleOpts('sweep', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  // A dead sweep is NOT a clean sweep. `(sweep?.gaps || []).length` reported "0 potential gap(s)" for a
  // check that never ran, citing a SWEEP_FILE nothing wrote — turning the run's final "did we actually
  // finish?" signal into a false all-clear. Unlike the refine critic this does NOT throw: every section
  // is already staged and accepted, so failing a complete migration over a missing advisory check would
  // be worse than reporting the check as missing.
  sweepFailed = !sweep;
  log(sweepFailed
    ? `  ⚠ sweep: the final completeness check DIED — it did not run, and ${SWEEP_FILE} was not written. Every section is staged, but NOTHING verified the goal was fully covered: re-run the sweep, or check coverage against the goal yourself.`
    : sweep.complete
      ? `sweep: no goal-coverage gaps found (suite: ${sweep.suite_result || 'n/a'})`
      : `sweep: ${(sweep.gaps || []).length} potential gap(s) — see ${SWEEP_FILE}`);
}

// =============================================================================
// Result (control plane → the orchestrating agent; durable progress lives in git + the review-file trail)
// =============================================================================
// Anything with saved work the user must be told about. Keyed on the PATCH, not the status string: an
// escalated section keeps its "BLOCKED (needs user)" status but was still parked, and dropping it here
// would leave its patch path unreported anywhere in the return.
const parkedSections = ledger.filter((r) => r.patch || (typeof r.status === 'string' && r.status.startsWith('parked')));
// Sections whose developer overrode a section clause under MATRIX 6a. Named in followups because
// AMENDED-<id>.md is reachable by acceptance alone — without this the user would not know it exists.
const amendedIds = ledger.filter((r) => r.planAmendments > 0).map((r) => r.id);
const amendedNote = amendedIds.length
  ? ` PLAN AMENDED for: ${amendedIds.join(', ')}. The developer overrode a section clause it verified prescribes a real defect — read ${STATE_DIR}/AMENDED-<id>.md (and the pointer lines in ${NEEDS_USER}) before you commit, and fold anything you agree with back into the plan file.`
  : '';
const HALT_STATUS = {
  'needs-user':      'BLOCKED (needs user input)',
  'dirty-baseline':  'BLOCKED (working tree was not clean — nothing was built)',
  'plan-unreadable': 'BLOCKED (an agent could not obtain its section — nothing was built from a guess)',
  'agent-dead':      'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)',
  'passed-unstaged': 'BLOCKED (a section passed but was not staged — stage it, then resume)',
  'acceptance-regression': 'BLOCKED (a section staged while self-reporting a regression — inspect the staged diff before continuing)',
  'parked':          'halted (a section was parked — its work is saved to a patch; the sections after it were not attempted)',
  'park-unsafe':     'BLOCKED (a parked section left the tree unsafe — inspect before resuming)',
  'budget':          'stopped on token budget (resume where it left off)',
};
const status = halted
  ? (HALT_STATUS[haltKind] || 'halted (section needs attention / budget)')
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
  // true ONLY when the sweep ran and died. `sweep: null` on its own cannot say whether the check was
  // deliberately skipped (partial slice, finalSweep:false) or lost — and those need different actions.
  sweepFailed,
  // Parked sections: NOT done, but their work is SAVED, not lost — and the sections after them were
  // never attempted. Present each with its patch path (and strays dir when one exists — those need a
  // second restore step).
  parked: parkedSections.map((r) => ({ id: r.id, patch: r.patch ?? null, strays: r.strays ?? null, status: r.status })),
  ledger,
  reviewTrail: `Numbered review files in ${STATE_DIR}/ (quality-review-<section>-rN.md, acceptance-review-<section>-rN.md) show every iteration; git staging marks each accepted section.`,
  followups: (halted
    ? `Run halted — ${haltReason} Read ${NEEDS_USER} (if a hard blocker) and the latest review file for the section in question, resolve with the user, then resume: re-invoke phase:"run" with the same args + startAt:"<that section id>" (or runOnly). A PARKED section's work is in ${STATE_DIR}/parked-<id>.patch, NOT in the tree — apply the patch first ONLY if you want to finish that section by hand; otherwise resume from the clean baseline and the developer redoes it (a resumed run requires a clean unstaged tree and halts on a dirty one).`
    : allDone
      ? `All sections done.${sweepFailed ? ` WARN THE USER FIRST: the final completeness sweep DIED, so nothing checked the goal was fully covered — re-run it or verify coverage against the goal yourself before trusting this as finished.` : ''} Review the staged diff in ${REPO} (git diff --cached), the numbered review files + DISMISSED-*.md in ${STATE_DIR}/ (audit every declined finding)${sweep && sweep.complete !== true ? `, and ${SWEEP_FILE} (coverage gaps!)` : ''}. Run the full gates yourself. Nothing is committed — you commit.`
      : `Partial slice complete (${doneIds.join(', ') || 'none'}). Reconstruct the next start point from git staging + the review trail and re-invoke phase:"run" with startAt the next section (or the full list to also run the final sweep).`) + amendedNote,
};
