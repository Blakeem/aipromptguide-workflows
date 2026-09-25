export const meta = {
  name: 'develop-cycle',
  description: 'Plan-driven build engine, one approved plan FILE as the bus: implement the todo BLOCKS of that file — each a "## Plan: <id>" block the user approved — where the block\'s `mode` picks the frame the engine holds (feature = one bounded feature, wired in and reachable; section = one slice of a breadth-spanning goal, every call site converted; fix = a triaged issue inventory, every ACTIONABLE entry verified and closed). Per block: develop → BLIND pure-code review (must pass) → plan-aware acceptance + regression review (stages on pass), looped per round; the accepted baseline advances block by block. A block that does not accept within its round budget is PARKED — its work saved to a patch and cleared from the tree — after which an UNORDERED run CONTINUES and an ORDERED one STOPS (its later blocks depend on this one). Agents exchange messages as verbatim files; the harness only routes block ids, paths + verdicts.',
  whenToUse: 'Build the todo blocks of ONE approved plan file: bounded features (mode:"feature" — a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix), the ordered sections of a breadth-spanning goal (mode:"section" — a migration, upgrade, port, subsystem refactor), and/or triaged issue inventories (mode:"fix" — a block whose "### [<id>]" entries are the verified defects to close). The orchestrating agent authors the plan file OUTSIDE this engine (plan mode → the user approves), and the operator derives the `plans` array by decorating the `blocks` rows that `tools/plan-block.mjs <planPath> --list` prints. Requires a CLEAN unstaged working tree; each accepted block is STAGED, never committed. Reuse one runId across resumes.',
  phases: [
    { title: 'Develop', detail: 'Developer reads its own block (verbatim, via the plan-block command) + the latest review that flagged issues; implements minimally, runs the gate, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no spec, no goal), flags production-blocking defects, writes quality-review-<id>-rN.md. Must be clean to proceed. Skipped only for a block that has produced nothing AND has no review still open.' },
    { title: 'Acceptance', detail: 'Plan-aware gate: every acceptance criterion of THIS block met + reachable + the block gate satisfied + no regression. Writes acceptance-review-<id>-rN.md; on pass, STAGES that block (git add, never commit) — the accepted baseline advances.' },
    { title: 'Park', detail: 'On a block that did not accept within its round budget, or one the developer escalated: SAVES its work to parked-<id>.patch, then clears it from the tree. An UNORDERED run then continues; an ORDERED one stops. Nothing is destroyed — NEEDS-USER.md carries the restore command.' },
    { title: 'Sweep', detail: 'Only when the plan file asks for it (sweep: goal-coverage) and every non-skip block is done: an independent agent re-greps the whole surface from the GOAL, runs the full gates, spot-checks the staged diff, writes SWEEP.md. Advisory — a dead sweep never halts.' },
  ],
};

// =============================================================================
// Config. Developer and acceptance read each block verbatim from its plan file (#2). Only the thin
// `plans` routing knobs, copied off `plan-block.mjs --list`, and the round number travel as control (#1/#8).
// =============================================================================
// A bare parse error names the runtime, not the payload the operator must fix.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
// Name the shape received: `--list` prints an object, so pasting it in whole is the likely mistake.
if (!A || !Array.isArray(A.plans) || !A.plans.length) {
  const shape = !A ? 'no args at all' : A.plans === undefined ? 'nothing' : Array.isArray(A.plans) ? 'an empty array' : A.plans === null ? 'null' : `a ${typeof A.plans}`;
  throw new Error(`args.plans must be a NON-EMPTY array of { id, planPath, mode, gate, status } entries; got ${shape}. "plan-block.mjs <planPath> --list" prints an object: pass its "blocks" array (decorated with a planPath, or with the top-level planPath you ran --list against), not the object itself. There is no single-plan or inline-plan fallback.`);
}
if (!A.runId) {
  throw new Error('args must include at least { runId, root, target, gates, plans:[{id, planPath, mode, gate, status}] }; got typeof=' + (typeof args));
}
// The main agent supplies root (#4). No in-engine agent detects it.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// No default: '.' would aim every git -C, park and gate command at ROOT.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the TARGET git repo. There is no default — an omitted repo would silently run every git command (including park\'s checkout/delete) against this workflow tool\'s own directory.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example to mirror
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0.
// The upper bound stops a fat-fingered maxRounds from spawning agents until something dies.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage parks every block without ever spawning a developer.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 4, 50);    // develop→quality→acceptance rounds per block
const MIN_PLAN_BUDGET = num(A.minPlanBudget, 'minPlanBudget', 0, 150_000); // token floor to start another block

// Set an agentType only when it exists in your registry. The blind critic is opus because the fast tier
// surfaced one deep defect per round on large diffs. Sweep searches rather than reviews, so it stays fast.
const M  = { develop: 'opus', quality: 'opus', acceptance: 'opus', sweep: 'sonnet', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// Absolute, so every agent and git -C call is cwd-independent.
const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo);                      // absolute path to the target git repo (required)
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
// The default for entries with no planPath, so undecorated `--list` rows work in the one-file case.
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
// Run-state inside the target repo puts the review and ledger files in the blind reviewer's reach (#3).
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the review/ledger files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
// The plan file has the same exposure (#3). Warn, not throw: a throw strands a run the operator may still
// want. Deduped because a one-file roadmap repeats one planPath on every entry.
const PLAN_PLACEMENT_WARNED = new Set();
const warnPlanPlacement = (p) => {
  if (!p || !REPO || PLAN_PLACEMENT_WARNED.has(p)) return;
  if (p !== REPO && !p.startsWith(REPO + '/')) return;
  PLAN_PLACEMENT_WARNED.add(p);
  log(`⚠ plan file (${p}) resolves inside the target repo — the blind quality reviewer could read the spec straight out of the repo tree, and the diff/park machinery could sweep it. Move the plan under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path — never one inside the target repo.`);
};
warnPlanPlacement(PLAN_PATH);
// An installed plugin keeps tools/ in its cache and ROOT in its data dir, so args.blockTool names the tool.
// Without it every block command exits non-zero and the run halts on plan_obtained=false.
const BLOCK_TOOL  = A.blockTool ? abs(A.blockTool) : `${ROOT}/tools/plan-block.mjs`;

// =============================================================================
// File-level keys, copied off `--list`. A typed value outside the set throws: the string "false" is truthy.
// =============================================================================
if (A.ordered != null && typeof A.ordered !== 'boolean') {
  throw new Error(`Invalid ordered key: args.ordered must be a boolean; got ${JSON.stringify(A.ordered)}. It decides whether a PARKED block stops the run, and the string "false" is truthy — copy the value "plan-block.mjs <planPath> --list" prints.`);
}
const ORDERED = A.ordered === true;
const VALID_SUITE = new Set(['green', 'scoped']);
if (A.suite != null && !VALID_SUITE.has(A.suite)) {
  throw new Error(`Invalid suite key: args.suite must be green | scoped; got ${JSON.stringify(A.suite)}. It decides whether a reddened EXISTING suite fails a green gate, so it must never coerce — copy the value "plan-block.mjs <planPath> --list" prints.`);
}
const SUITE = A.suite ?? 'green';
const VALID_SWEEP = new Set(['goal-coverage', 'none']);
if (A.sweep != null && !VALID_SWEEP.has(A.sweep)) {
  throw new Error(`Invalid sweep key: args.sweep must be goal-coverage | none; got ${JSON.stringify(A.sweep)}. It decides whether the run ends with a whole-goal coverage check — copy the value "plan-block.mjs <planPath> --list" prints.`);
}
const SWEEP_MODE = A.sweep ?? 'none';
if (A.goal != null && typeof A.goal !== 'string') {
  throw new Error(`Invalid goal key: args.goal must be a string; got ${JSON.stringify(A.goal)}. It is the goal line every agent is framed with and the sweep's re-grep seed — copy the value "plan-block.mjs <planPath> --list" prints.`);
}
const GOAL = A.goal ?? '';
// The sweep re-derives its surface from the goal, so a goalless sweep would run with nothing to cover.
if (SWEEP_MODE === 'goal-coverage' && !GOAL.trim()) {
  throw new Error('Missing goal key: args.sweep is goal-coverage but args.goal is empty, so the sweep would re-derive its surface from nothing. Add a "goal:" file key to the plan file (or "sweep: none"), then copy the value "plan-block.mjs <planPath> --list" prints.');
}

// =============================================================================
// Plans: thin routing entries in build order. The block body lives in its plan file.
// =============================================================================
const RAW = A.plans;
const VALID_MODES  = new Set(['feature', 'section', 'fix']);
// A fix block's gate is green ONLY: its entries are defects in working code, so a build-only or
// red-baseline fix would stage a "closed" issue nothing ever ran.
const MODE_GATES   = { feature: new Set(['green', 'build-only']), section: new Set(['green', 'red-baseline', 'build-only']), fix: new Set(['green']) };
const VALID_STATUS = new Set(['todo', 'done', 'skip', 'parked', 'blocked']);

// Throw, not filter: dropping an entry with no id builds a shorter roadmap and reports success.
const NO_ID = RAW.map((p, i) => [p, i])
  .filter(([p]) => !p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim())
  .map(([, i]) => i);
if (NO_ID.length) {
  throw new Error(`plans entries at index [${NO_ID.join(', ')}] are not objects carrying a string id. Every entry is a "blocks" row from "plan-block.mjs <planPath> --list" — { id, mode, gate, status } — optionally decorated with its own planPath and planContext.`);
}

// An id names run-state files and enters the block command, so a non-slug is a slug() file collision or a
// shell metacharacter. plan-block.mjs holds the file's headers to the same rule.
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BAD_IDS = RAW.filter((p) => !KEBAB_ID.test(p.id)).map((p) => p.id);
if (BAD_IDS.length) {
  throw new Error(`plan id(s) [${BAD_IDS.join(', ')}] are not kebab slugs (a-z, 0-9, single hyphens). An id names this block's review + ledger files and is passed to the plan-block command, so it must carry no spaces, punctuation or shell characters.`);
}

// Never defaulted: an omitted mode would judge a migration section by the feature frame's reachability.
const BAD_MODES = RAW.filter((p) => !VALID_MODES.has(p.mode))
  .map((p) => `${p.id}: ${p.mode === undefined ? '(omitted)' : JSON.stringify(p.mode)}`);
if (BAD_MODES.length) {
  throw new Error(`plan mode(s) [${BAD_MODES.join(', ')}] are not one of feature | section | fix. A mode picks the developer and acceptance frames, so it is required and never coerces.`);
}

// A pass is several fix blocks built in one develop cycle (`plan-edit.mjs args --pack`). A member
// without an id, a plan file or its issue ids would be edited nowhere.
const BAD_PASSES = RAW.filter((p) => p.blocks !== undefined && !(
  p.mode === 'fix' && Array.isArray(p.blocks) && p.blocks.length > 1
  && p.blocks.every((b) => b && KEBAB_ID.test(b.id) && typeof b.planPath === 'string' && b.planPath.trim()
    && Array.isArray(b.issues) && b.issues.every((i) => typeof i === 'string'))
)).map((p) => p.id);
if (BAD_PASSES.length) {
  throw new Error(`pass entries [${BAD_PASSES.join(', ')}] are malformed: a pass is mode fix with a "blocks" array of two or more { id, planPath, issues: [ids] }. Take them from "plan-edit.mjs args --pack" rather than writing them by hand.`);
}

// Only a typed illegal value throws. Coercing `red_baseline` to 'green' would demand passing tests from a
// red step and park it after the full round budget.
const BAD_GATES = RAW.filter((p) => p.gate != null && !MODE_GATES[p.mode].has(p.gate))
  .map((p) => `${p.id}: ${JSON.stringify(p.gate)} (mode ${p.mode} takes ${[...MODE_GATES[p.mode]].join(' | ')})`);
if (BAD_GATES.length) {
  throw new Error(`plan gate(s) [${BAD_GATES.join(', ')}] are not legal for their block's mode. A gate decides what "done" MEANS for its block, so an unrecognized value must never coerce. Omit the field entirely to take the green default.`);
}

// `status` is what the todo filter selects on, so a typo is a block silently skipped (or, worse, a
// finished one rebuilt over its own staged baseline). Omitted keeps the 'todo' default.
const BAD_STATUS = RAW.filter((p) => p.status != null && !VALID_STATUS.has(p.status))
  .map((p) => `${p.id}: ${JSON.stringify(p.status)}`);
if (BAD_STATUS.length) {
  throw new Error(`plan status(es) [${BAD_STATUS.join(', ')}] are not one of todo | done | skip | parked | blocked. Status drives which blocks this run builds, so an unrecognized value must never coerce. Omit the field entirely to take the todo default.`);
}

const ALL_PLANS = RAW.map((p) => ({
  id: String(p.id),
  planPath: p.planPath ? abs(p.planPath) : (p.blocks ? '' : PLAN_PATH),
  mode: p.mode,
  gate: p.gate ?? 'green',
  status: p.status ?? 'todo',
  planContext: p.planContext === 'full' ? 'full' : 'block',
  blocks: p.blocks ? p.blocks.map((b) => ({ id: b.id, planPath: abs(b.planPath), issues: b.issues })) : null,
}));

// An empty plan path would have the developer build against nothing and report success.
const NO_PATH = ALL_PLANS.filter((p) => !p.planPath && !p.blocks).map((p) => p.id);
if (NO_PATH.length) {
  throw new Error(`plans [${NO_PATH.join(', ')}] carry no planPath and there is no top-level planPath to default to — the developer would be handed an empty plan reference. Either add planPath to each of those entries, or pass the top-level planPath you ran "plan-block.mjs <planPath> --list" against.`);
}

// Pass members count too: every run-state file is keyed by the bare id.
const SEEN_IDS = new Set();
const DUPE_IDS = new Set();
for (const id of ALL_PLANS.flatMap((p) => [p.id, ...(p.blocks ?? []).map((b) => b.id)])) {
  if (SEEN_IDS.has(id)) DUPE_IDS.add(id);
  SEEN_IDS.add(id);
}
if (DUPE_IDS.size) {
  throw new Error(`duplicate plan id(s) [${[...DUPE_IDS].join(', ')}] in args.plans. Every per-block run-state file (reviews, DISMISSED, AMENDED, parked patch) is keyed by the bare id, so duplicates would overwrite each other.`);
}

// Checked here, not beside PLAN_PATH, because only ALL_PLANS holds resolved paths. The sweep reads these.
const PLAN_FILES = [...new Set(ALL_PLANS.flatMap((p) => (p.blocks ? p.blocks.map((b) => b.planPath) : [p.planPath])))];
for (const path of PLAN_FILES) warnPlanPlacement(path);

// 'block' lets a parser decide where the block ends: plan bodies use `##` headers, so an agent reading by
// eye can stop at the first `## Feature` and build a truncated spec. 'full' hands the whole file.
const blockRef = (p) => (p.blocks ? passRef(p) : `the output of:  node '${BLOCK_TOOL}' '${p.planPath}' '${p.id}'
Run it. That output is the block, verbatim. If it exits non-zero, report plan_obtained=false and STOP:
never guess at a plan you could not read. The full plan file is at ${p.planPath} if you need a
neighbouring block for context; your block is ONLY "${p.id}"`);
const passRef = (p) => `the output of each command below, one block per command:
${p.blocks.map((b) => `  node '${BLOCK_TOOL}' '${b.planPath}' '${b.id}'`).join('\n')}
Run every one. Each output is one block, verbatim. If any exits non-zero, report plan_obtained=false and
STOP: never guess at a plan you could not read. Your blocks are ONLY ${p.blocks.map((b) => `"${b.id}"`).join(', ')}`;
const planRef = (p) => p.planContext === 'full' && !p.blocks
  ? `the block headed "## Plan: ${p.id}" inside the plan file at ${p.planPath} (read THAT block verbatim; the other blocks are CONTEXT only — your block is ONLY "${p.id}")`
  : blockRef(p);

// Blindness is placement, not instruction (#3). STATE_DIR holds acceptance reviews, AMENDED files and
// NEEDS-USER, all routes to plan text. No path outside GATE_DIR ever enters the blind reviewer's prompt.
const GATE_DIR       = `${STATE_DIR}/gate`;                     // everything the BLIND quality reviewer reads or writes
const qualityFile    = (id, r) => `${GATE_DIR}/quality-review-${slug(id)}-r${r}.md`;
const acceptanceFile = (id, r) => `${STATE_DIR}/acceptance-review-${slug(id)}-r${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;            // full detail; for the user (may halt the run) — GLOBAL/cumulative
const dismissedFile  = (id) => `${GATE_DIR}/DISMISSED-${slug(id)}.md`;  // terse ledger; developer → reviewers (anti-spin) — PER BLOCK
// MATRIX 6a overrides, read by acceptance only. It quotes plan text, so it stays outside GATE_DIR.
const amendedFile    = (id) => `${STATE_DIR}/AMENDED-${slug(id)}.md`;
const parkedPatch    = (id) => `${STATE_DIR}/parked-${slug(id)}.patch`;    // a block's work, saved before the tree is cleared
const parkedNewDir   = (id) => `${STATE_DIR}/parked-${slug(id)}-newfiles`; // untracked files the patch could not carry (rare)
const SWEEP_FILE     = `${STATE_DIR}/SWEEP.md`;                 // final whole-goal completeness sweep

// Settled decisions, never prior reviews, which would anchor them (#5). canContest=true is the blind
// reviewer: the contest channel and DISMISSED alone (see GATE_DIR). Acceptance overrides instead.
const SETTLED = (id, canContest = true, round = 0) => `Before reviewing, READ ${canContest ? 'this if it exists — it is' : 'these if they exist — they are'} the settled decisions, so you do
NOT re-raise what is already closed:
  • ${dismissedFile(id)} — findings the developer declined for THIS block, each with a one-line reason.${round === 1 ? `
    In round 1 it exists only if the developer already declined something this block (or on a resume);
    a missing file means nothing is settled yet, so do not search for it elsewhere.` : ''}${canContest ? '' : `
  • ${NEEDS_USER} — items already escalated to the user.`}
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files — review the CURRENT
diff FRESH (so you also catch new or similar nearby issues, and independently re-verify earlier fixes).${canContest ? `
If you are confident a DISMISSED reason is WRONG and the issue is genuinely production-blocking, raise
it ONCE, prefixed "CONTESTS DISMISSAL:", explaining why the reason does not hold.` : ''}`;

function gateOk(gate, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;   // build/lint must always pass
  if (gate === 'build-only') return true;
  // A mistyped selector runs nothing and fails, which a red step reports as failed-expected with count 0.
  // `!== 0`, not `> 0`: -1 is the schema's N/A.
  if (gate === 'red-baseline') return dev.test_outcome === 'failed-expected' && dev.tests_run_count !== 0;
  // green:
  if (SUITE === 'green' && dev.full_suite_outcome === 'failed') return false;   // reddening the suite is a regression
  if (dev.test_outcome === 'not-run') return false;             // green requires verification to have run
  if (dev.tests_run_count === 0) return false;                  // selector matched nothing = FALSE green
  return dev.test_outcome === 'passed';
}

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
// A fix worker returns per-issue `results`, not `produced`: the engine derives produced from them, so a
// round that only SKIPPED entries cannot claim work it never did.
const developSchema = (mode) => ({
  type: 'object',
  required: mode === 'fix'
    ? ['plan_obtained', 'baseline_dirty_files', 'results', 'entries_found', 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user', 'plan_amendments']
    : ['plan_obtained', 'baseline_dirty_files', 'produced', 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user', 'plan_amendments'],
  properties: {
    plan_obtained:     { type: 'boolean', description: 'true if you actually HAVE your block text — the plan-block command exited 0 and printed it, or (ONLY when you were handed a plan file rather than a command) you read that file. A command that failed means FALSE — never fall back to locating your block by eye in the plan file. FALSE halts the run: never build from a plan you could not read.' },
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files already had UNSTAGED or untracked changes BEFORE you touched anything (staged files are the accepted baseline — never counted). 0 = clean; >0 HALTS the run. Report -1 on later rounds (the check does not apply).' },
    ...(mode === 'fix' ? {
      results: {
        type: 'array',
        description: 'one entry per `### [<id>]` issue in every block you were handed — every id, including the ones you did not touch',
        items: {
          type: 'object',
          required: ['issue_id', 'status'],
          properties: {
            issue_id: { type: 'string' },
            status:   { type: 'string', enum: ['FIXED', 'STALE', 'SKIPPED', 'FAILED'], description: 'FIXED = you changed code that closes it. STALE = it no longer exists in current code. SKIPPED = its `- decision:` is not ACTIONABLE. FAILED = you tried and could not.' },
            files_changed: { type: 'array', items: { type: 'string' } },
            summary:  { type: 'string' },
          },
        },
      },
      entries_found: { type: 'integer', description: 'ROUND 1 ONLY: how many `### [` issue entries you counted across every block printed. 0 HALTS the run before any reviewer spawns. Report -1 on later rounds (the check does not apply).' },
    } : {
      produced:        { type: 'boolean', description: 'true if you changed or added at least one file this round' },
    }),
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed', 'failed-expected', 'failed-unexpected', 'not-run'], description: 'passed = the required verification ran and PASSED. failed = it ran and failed. failed-expected = a red baseline exactly as a test-first block intends. failed-unexpected = failed for a WRONG reason (a real defect / bad fixture). not-run = no verification executed.' },
    tests_run_count:   { type: 'integer', description: 'the count of tests, or of assertions for a runner that counts those, the runner REPORTS as executed for this block\'s run (0 = nothing ran = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    full_suite_outcome:{ type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened; "scoped-skip" when this run is scoped to each block\'s own selector and the rest of the suite may be intentionally red' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q", "phpunit --filter Bar", "curl localhost:3000/health"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add NOT run on content; git add -N only, for new files). Anything you stage yourself is reviewed by NOBODY — say false rather than claim it, which HALTS the run instead of laundering staged work into the accepted baseline.' },
    needs_user:        { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to this block\'s DISMISSED file this round (0 if none)' },
    // Required, unlike dismissed_count: an omitted field must not read as "none this round".
    plan_amendments:   { type: 'integer', description: 'how many PLAN CLAUSES you overrode under MATRIX 6a this round — each one a defect you VERIFIED in what the plan prescribes, recorded as an entry in this block\'s AMENDED file. Report 0 when there were none; this field is required, so "none" must be stated, never omitted.' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
});

const QUALITY_SCHEMA = {
  type: 'object',
  required: ['clean', 'issue_count'],
  properties: {
    clean:       { type: 'boolean', description: 'true if NO production-blocking defects were found in the unstaged diff' },
    issue_count: { type: 'integer', description: 'number of production-blocking defects written to the review file' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED entries you re-raised as "CONTESTS DISMISSAL:" this round because the stated reason is wrong for a genuine production-blocking defect (0 if none)' },
  },
};

const acceptanceSchema = (mode) => {
  // Per mode, because the descriptions are each frame's acceptance contract.
  // `|| {}` lets tests/static.test.mjs evaluate the schema with no mode to read its field names.
  const terms = {
    feature: {
      pass: 'true if every acceptance criterion is met, the feature is reachable, gates are green, and nothing regressed',
      staged: 'true if you ran `git add` on this block\'s files (only on pass; NEVER commit)',
      reachable: 'the feature is actually wired in / reachable from the app entry points',
      criteriaFrom: 'THIS block',
      suite: 'observed outcome of running the FULL gates',
    },
    section: {
      pass: 'true if every acceptance criterion of THIS block is met, it is reachable, the block gate is satisfied, and nothing regressed',
      staged: 'true if you ran `git add` on this block\'s files (only on pass; NEVER commit)',
      reachable: 'this block\'s change is actually wired in / reachable — every call site converted, route mounted, symbol exported',
      criteriaFrom: 'THIS block',
      suite: 'observed outcome of running the block gate (and, where the goal expects it, the full gates)',
    },
    fix: {
      pass: 'true if every claimed fix fully closes its root cause, every STALE claim is confirmed absent from the current code, no entry outside the ACTIONABLE set was touched, the gate is green, and nothing regressed',
      staged: 'true if you ran `git add` on this block\'s files (only on pass; NEVER commit)',
      suite: 'observed outcome of running the FULL gates',
    },
  }[mode] || {};
  return {
    type: 'object',
    required: mode === 'fix'
      ? ['plan_obtained', 'pass', 'staged', 'fix_checks']
      : ['plan_obtained', 'pass', 'staged', 'reachable', 'criteria_total', 'criteria_met', 'evidence_recorded'],
    properties: {
      plan_obtained: { type: 'boolean', description: 'true if you actually HAVE the block text you are judging against — the plan-block command exited 0 and printed it, or (ONLY when you were handed a plan file rather than a command) you read that file. A command that failed means FALSE — never fall back to locating the block by eye. FALSE halts the run: a verdict reached without the spec is worthless.' },
      pass:        { type: 'boolean', description: terms.pass },
      staged:      { type: 'boolean', description: terms.staged },
      ...(mode === 'fix' ? {
        fix_checks: {
          type: 'array',
          description: 'one entry per issue the developer claimed FIXED or reported STALE',
          items: {
            type: 'object',
            required: ['issue_id', 'actually_fixed'],
            properties: {
              issue_id: { type: 'string' },
              actually_fixed: { type: 'boolean', description: 'for a FIXED claim: the diff CLOSES THE ROOT CAUSE completely (not just the literal edit the issue described). For a STALE claim: you confirmed the defect is absent from the current code' },
              note: { type: 'string', description: 'when false: the live residual path or what is still wrong' },
            },
          },
        },
      } : {
        reachable:   { type: 'boolean', description: terms.reachable },
        criteria_total: { type: 'integer', description: `acceptance criteria you enumerated from ${terms.criteriaFrom} (0 means you enumerated none — never a legitimate pass)` },
        criteria_met:   { type: 'integer', description: 'of those, how many you found concrete evidence for' },
        evidence_recorded: { type: 'boolean', description: 'true ONLY if EVERY met criterion carries a locator (file:line / test name / command output) written in the review file' },
      }),
      regression:  { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/accepted behavior' },
      gap_count:   { type: 'integer', description: 'number of unmet criteria / gaps written to the review file (0 on pass)' },
      suite_result:{ type: 'string', description: terms.suite },
    },
  };
};

// Park saves then clears, so every exit leaves a clean tree and the round-1 clean-baseline check holds
// unconditionally, resume included.
const PARK_SCHEMA = {
  type: 'object',
  required: ['saved', 'cleared', 'gates_green'],
  properties: {
    saved:       { type: 'boolean', description: 'true ONLY if the patch file was written and you confirmed it is non-empty. If false, you must NOT have cleared the tree.' },
    cleared:     { type: 'boolean', description: 'true if the block\'s work was then removed from the working tree and `git diff` is empty' },
    gates_green: { type: 'boolean', description: 'true if the BUILD gate passes again after clearing (the tree is safe for what comes next)' },
    patch_bytes: { type: 'integer', description: 'size of the written patch file — 0 means nothing was saved' },
    strays_saved:{ type: 'integer', description: 'how many untracked files you copied to the -newfiles dir in step 2 (0 if none). Non-zero means the restore needs a SECOND step beyond git apply, and step 4 must say so.' },
    notes:       { type: 'string' },
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
          title:       { type: 'string' },
          evidence:    { type: 'string', description: 'file:line hits or gate output proving the gap' },
          suggested_block: { type: 'string', description: 'a one-line follow-up block that would close it' },
        },
      },
    },
    suite_result: { type: 'string', description: 'observed outcome of running the FULL gates (or why they were not run)' },
  },
};

// =============================================================================
// Shared prompt fragments + decision matrix (developer-owned)
// =============================================================================
const ENV = `${GOAL ? `GOAL CONTEXT — this run drives ONE goal, decomposed into blocks in the plan file: ${GOAL}\n` : ''}TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example to mirror — mine it for the canonical pattern): ${REFERENCE_P}\n` : ''}CONVENTIONS (match these): ${CONVENTIONS}
GATES (the commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
BE TOKEN-ECONOMICAL: read ONLY the files this block touches plus the SPECIFIC reference/plan text you
need — do NOT re-read the whole tree, the whole plan file, or the entire reference. Prefer targeted grep
over broad reads. Don't restate large files back; act on them.`;

// A file key, not a mode: suite:scoped allows the mid-run red a test-first migration expects.
const SUITE_LINE = SUITE === 'green'
  ? 'Also run the FULL suite to confirm you did not redden it (report full_suite_outcome).'
  : 'Do NOT chase whole-suite green — only THIS block\'s scoped tests matter; the rest of the suite may be intentionally red mid-run. Report full_suite_outcome="scoped-skip".';
const ACC_SUITE_LINE = SUITE === 'green'
  ? 'The EXISTING suite must still be green — reddening it is a regression, not an accepted block.'
  : 'Do NOT treat the intentionally-red rest of the suite as a failure: judge THIS block on its own selector.';

// Case 7's proceeding branch also writes DISMISSED: the blind reviewer never sees NEEDS-USER (see
// GATE_DIR), so it would flag the escalated default every round until the block parks (#5).
// PRECEDENCE must quote the frame's own scope line, or 6a outranks nothing.
const SCOPE_LINE = {
  feature: 'NO scope creep beyond the plan',
  section: 'NO scope creep beyond it',
  fix: 'NO scope creep beyond what each fix requires',
};
const MATRIX = (id, round, mode) => `DECISION MATRIX — for each ambiguity or review finding, route it yourself IN ORDER (first match wins):
  1. Not a real problem / false positive .............. DROP — LOG it (see LOGGING).
  2. Pre-existing in untouched code (not yours) ....... DROP silently (out of scope; never fix — regression risk).
  3. Stops the build/tests/verification ............... FIX (always).
  4. A real, clear, in-scope fix (local, small) ....... FIX.
  5. Needed to satisfy the spec / wire this block in .. FIX (an unreachable or incomplete block is not done).
  6a. Conflicts with the plan AND you VERIFIED that what the plan PRESCRIBES is itself defective —
      you reproduced it, or demonstrated the failure path, to the same evidence bar as any FIX
        .............................................. FIX it: the verified defect outranks the
      prescription. RECORD an amendment (see LOGGING).
      PRECEDENCE — for THIS clause only, that verified defect also outranks the "${SCOPE_LINE[mode]}"
      instruction above and the CONVENTIONS rubric. Everywhere else the plan and the conventions
      still bind, exactly as written.
  6b. Conflicts with the plan but you did NOT verify it / intentional / not a real-world code path
        .............................................. DROP — LOG it (see LOGGING).
  7. A genuine DESIGN/BUSINESS choice only the USER can make, OR a blocker you cannot resolve in scope
        .............................................. ESCALATE (see LOGGING).
  8. Anything else (style, medium/low polish, a different block's work) ... DROP silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. NEVER log the same dismissal twice.

LOGGING — this (plus your code) is your ONLY output. Keep it minimal and unambiguous:
  • DROP (1 or 6b): append ONE terse line to ${dismissedFile(id)} so reviewers won't re-raise it —
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • AMEND (6a): append ONE entry to ${amendedFile(id)} —
      \`## Plan amendment: ${id} r${round}\`
      then the plan clause you overrode (QUOTED verbatim), the defect (file:line + one line on why it is
      real), and what you built instead.
    Then append ONE POINTER line to ${NEEDS_USER}: the block id, the round, the defect's file:line, and
    the path ${amendedFile(id)} — and NO plan text, so the amendment reaches the user where they already
    look without copying the spec anywhere else. Count every entry you wrote in plan_amendments.
  • ESCALATE (7): append a FULL, self-contained entry to ${NEEDS_USER} (as much detail as the user
    needs to decide). If you CANNOT proceed without the answer, set needs_user=true (the run HALTS).
    If you can proceed with a defensible default, record it there too, leave needs_user=false, AND
    append ONE terse line to ${dismissedFile(id)} in the DROP shape above, its reason
    \`ESCALATED: <the default you took, ≤15 words>\` — the blind reviewer is NOT shown ${NEEDS_USER},
    so without that line it re-raises your default every round and this block parks instead of accepting.
This is NOT a general code review — a SEPARATE review workflow audits the whole codebase later. Make
THIS block correct, testable, and production-safe; leave the lines you TOUCH a little better; touch
nothing else.`;

// =============================================================================
// Role prompts. DEVELOP_FRAME and ACCEPTANCE_FRAME switch on mode. The blind critic sees no plan.
// =============================================================================
const featureDevelop = (p, round, { opening, ledgerNote, staging }) => `
You are the DEVELOPER. Implement ${planRef(p)}. Build it minimally and surgically; match conventions;
${SCOPE_LINE.feature}.
${ENV}
BLOCK: ${p.id}
${opening}
${ledgerNote}

PROCEDURE:
1. Implement the plan's steps. WIRE IT IN so the feature is actually reachable (registered/exported/
   routed/bound/flagged) — written-but-unreachable is NOT done. Author/extend tests per the plan's
   Test Strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}
2. RUN THE GATE until it is ${p.gate === 'build-only' ? 'GREEN (build-only: the build must pass; this block has no verification to run)' : 'GREEN'} — build: ${GATES.build ?? '(none)'} ; verification: per
   the plan's Test Strategy (${GATES.test ?? 'no test gate configured'}). ${SUITE_LINE} Never
   weaken/delete tests to get green. SANITY-CHECK the runner really executed your unit tests
   (tests_run_count = 0 means it matched NOTHING = a false green; -1 if N/A, e.g. manual/MCP).
3. ${staging}
4. ${MATRIX(p.id, round, p.mode)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

const sectionDevelop = (p, round, { opening, ledgerNote, staging }) => {
  const gateExpectation = p.gate === 'red-baseline'
    ? 'red-baseline — AUTHOR this block\'s tests; they MUST FAIL because the code is not converted yet. Report test_outcome="failed-expected" once they run and fail for the RIGHT reason (asserting the not-yet-built target behavior), or "failed-unexpected" if they fail for a wrong reason (parse error, missing fixture).'
    : p.gate === 'build-only'
      ? 'build-only — no test pass/fail requirement; just keep the build green.'
      : 'green — this block\'s selector tests must RUN and PASS (test_outcome="passed"). Scope the test run to THIS block: use the block\'s `test_selector:` line when it has one, else the test gate.';
  return `
You are the DEVELOPER. Implement ${planRef(p)}. Build ONLY this block minimally and surgically; match
conventions; ${SCOPE_LINE.section}.
${ENV}
BLOCK: ${p.id}
GATE EXPECTATION: ${gateExpectation}
${opening}
${ledgerNote}

PROCEDURE:
1. Implement this block's steps. WIRE IT IN so the change is actually reachable — convert EVERY call
   site / occurrence this block owns (registered/exported/routed/bound/flagged); a half-converted block
   is NOT done. Author/extend tests per the block's Test Strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}
2. RUN THE GATE until it satisfies the expectation above — build: ${GATES.build ?? '(none)'} ; tests
   scoped to this block (its \`test_selector:\` line when it has one, else the test gate):
   ${GATES.test ?? '(no test gate configured)'}. Never weaken/delete
   tests to get green. SANITY-CHECK the runner really executed your unit tests (tests_run_count = 0
   means it matched NOTHING = a false green; -1 if N/A). Some runners silently ignore extra path args —
   when in doubt run one file per invocation or use the runner's --filter.
3. ${SUITE_LINE} Build/lint must always pass.
4. ${staging}
5. ${MATRIX(p.id, round, p.mode)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;
};

// Verify-first because entries come from a past snapshot. ACTIONABLE-only because the decision line is
// the user's triage.
const fixDevelop = (p, round, { opening, ledgerNote, staging }) => `
You are the FIXER. Resolve the verified issues in ${planRef(p)}. Each block printed IS an inventory: a
"## Plan:" header followed by one "### [<id>]" entry per issue, each with its own \`- decision:\` line and
a **Fix:** instruction. Fix each one exactly as instructed, minimally and surgically; NO opportunistic
refactors, ${SCOPE_LINE.fix}.
${ENV}
BLOCK: ${p.id}
GATE EXPECTATION: green — build passes and this block's verification RUNS and PASSES (test_outcome="passed").
${opening}
${ledgerNote}

PROCEDURE:
${round === 1 ? `0. INVENTORY READABLE — do this FIRST, before reading or editing anything else. COUNT the
   "### [" entries across every block printed and report the count as entries_found. If it is 0,
   STOP RIGHT THERE: change nothing and return with that count. A block carrying no entries is nothing to
   fix, and working from memory would be worse than not running.
` : `0. Report entries_found=-1 (the inventory count is a round-1 check).
`}1. VERIFY-FIRST: the entries were written from a PAST snapshot — for EACH one, read the CURRENT code and
   confirm the issue still exists. If it was already fixed or no longer applies, record it STALE and move
   on. Never "fix" what isn't there. STALE means someone ELSE closed it before this run: an entry YOU
   already fixed in an earlier round of this block stays FIXED every round, since its diff is still
   unstaged and still has to be verified.
2. FIX ONLY the entries whose \`- decision:\` line says ACTIONABLE. Every other entry — SKIP, NEEDS_USER,
   DEFER, anything else — is left UNTOUCHED and recorded SKIPPED: that triage is the user's call, not
   yours. Apply each confirmed fix per its **Fix:** instruction, matching the CONVENTIONS and the
   surrounding style. Where a fix warrants a pinning test, write it. Never weaken or delete existing tests
   to make the gate pass; never disable lint rules.
3. RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: ${GATES.test ?? '(no test gate configured)'}.
   ${SUITE_LINE} SANITY-CHECK the runner really executed the tests (tests_run_count = 0 means it matched
   NOTHING = a false green; -1 if N/A). If a fix breaks the gate and you cannot resolve it within THAT
   fix's own scope, revert that change surgically, record the entry FAILED with the reason, and keep the
   rest.
4. ${staging}
5. ${MATRIX(p.id, round, p.mode)}
RESULTS — return one \`results\` entry per issue id in every block, \`{ issue_id, status }\`: FIXED (you
changed code that closes it), STALE (it is not in the current code), SKIPPED (its decision is not
ACTIONABLE), FAILED (you tried and could not). Report EVERY id, including the ones you left alone — the
engine reads these statuses as the record of what this round did.
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

const DEVELOP_FRAME = { feature: featureDevelop, section: sectionDevelop, fix: fixDevelop };

const developPrompt = (p, round, reviewPath) => {
  // Identical in every frame — only the task lines in DEVELOP_FRAME switch on mode.
  const opening = round === 1
    ? `ROUND 1 — STEP 0, BEFORE you read the plan or touch any file: CONFIRM THE BASELINE IS CLEAN. Earlier
ACCEPTED blocks are STAGED (the accepted baseline); the UNSTAGED tree must be EMPTY, because everything
unstaged at the end of this round is reviewed and judged as YOUR work.
  \`git -C ${REPO} diff --name-only\`                        — unstaged tracked edits
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` — untracked files (\`git diff\` OMITS these)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (entries that are ONLY
staged are the accepted baseline — do NOT count them). If it is NOT 0, STOP RIGHT THERE: change nothing,
write nothing, do no work, and return immediately with that count — the run halts so the operator can
fold or stash that work. If it IS 0, implement this block from scratch on top of the staged baseline.`
    : `${reviewPath
      ? `A prior review flagged issues — READ ${reviewPath} and resolve exactly those. Your earlier work is
already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
      : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working
tree — re-run the gate (below), see what is failing, and fix it. Build ON your work; do NOT revert it.`}
Report baseline_dirty_files=-1 (the round-1 clean-baseline check does not apply from round 2 on — the
unstaged tree now holds YOUR work).`;
  // Every round, round 1 included: the ledger persists across resumes.
  const ledgerNote = `If ${dismissedFile(p.id)} exists, READ it first — it is YOUR running ledger of declined findings for
THIS block, and it PERSISTS across resumes (so a resumed round-1 still has it): do not duplicate an
entry, and do not re-litigate what you already declined. If the review you are addressing RE-RAISES one
as \`CONTESTS DISMISSAL:\`, you MUST FIX or ESCALATE it (never silently re-add the same dismissal).`;
  const staging = `LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file
   you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add, so reviewers' \`git diff\` sees it;
   it does not stage content). Set unstaged_confirmed=true. The acceptance verifier stages for real on
   accept — anything YOU stage is reviewed by nobody and HALTS the run.`;
  return DEVELOP_FRAME[p.mode](p, round, { opening, ledgerNote, staging });
};

// BLIND: no plan, spec, goal or criteria, so one frame serves every mode.
const qualityPrompt = (p, round) => `
You are a CODE CRITIC. You have NO information about what this code is for, what it should do, or any
plan, spec or goal — and you must not seek any. Judge the code PURELY ON ITS OWN MERITS.
Never open a plan file, an issue inventory, or any run-state path outside ${GATE_DIR}/.
TARGET REPO: ${REPO}
GATES (the commands that decide whether the build and tests pass):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}

${SETTLED(p.id, true, round)}

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`                    (unstaged tracked changes — review this; on a large diff run
                                          \`git -C ${REPO} diff --stat\` first, then read it file by file)
  \`git -C ${REPO} status --porcelain\` then READ every untracked file (\`??\`) — \`git diff\` OMITS those.
  A \` A\` entry (intent-to-add) is a new file \`git diff\` already shows in full. A first-column \`A\` or
  \`M\` is STAGED: the staged half of an \`AM\` or \`MM\` file is baseline, and only its unstaged half
  (\`git -C ${REPO} diff -- <file>\`) is this cycle's work.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline — context only, do NOT review it.

Report ONLY production-blocking defects INTRODUCED by this diff: real correctness/security/
data-integrity/error-handling/resource/concurrency/api-contract bugs, or anything that breaks the
build or tests. DROP silently: anything pre-existing in the baseline, style, naming, medium/low
polish, speculation, redesigns. An EMPTY result is the normal, GOOD outcome.

WRITE your findings to ${qualityFile(p.id, round)} (create ${GATE_DIR}/ if needed): one section per defect
— file:line, what's wrong, why it's production-blocking, a concrete fix. If none, write exactly
"No production-blocking defects found." Then return clean (true if NO findings, including no contests)
+ issue_count + contested_dismissals via the schema. Do NOT modify source, stage, or commit.`;

// The root cause is re-derived from current code, not checked against the entry's **Fix:** line, because
// the entry may have under-scoped the defect.
const fixAcceptance = (p, round, { claimedFixed, claimedStale, reportedSkipped }) => `
You are the ACCEPTANCE VERIFIER — the final, issue-aware gate for ONE fix block or pass of blocks. The
blind code review already passed (or was skipped because the developer changed nothing). Read
${planRef(p)}. Each block printed IS an inventory: one "### [<id>]" entry per issue, each with a \`- decision:\` line and a **Fix:**
instruction. You judge the work against it; you never implement it.
${ENV}
BLOCK: ${p.id}   (mode: ${p.mode}, gate: ${p.gate})

${SETTLED(p.id, false)}
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. You are issue-aware — if a
dismissed item actually leaves a claimed fix incomplete or causes a regression, that OVERRIDES the
dismissal: fail acceptance for it and record it in your review file. An \`ESCALATED:\` line is a decision
routed to the user: hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a
held escalation never fails acceptance. Name it in your file as held.

AMENDMENTS: READ ${amendedFile(p.id)} if it exists. It records **Fix:** instructions the developer
OVERRODE after verifying the instruction itself prescribes a real defect (MATRIX 6a). Judge an issue whose
instruction was amended against the AMENDED behavior, not the superseded one, and NAME every issue you
judged under an amendment in your review file. An amendment entry that states NO defect evidence excuses
NOTHING — that issue stays actually_fixed=false, or the escape hatch becomes a free pass.

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  \`git -C ${REPO} diff --staged\` = accepted baseline (compare against it for regressions).

PROCEDURE:
1. ROOT-CAUSE COMPLETENESS. The developer claims these issues FIXED:
${claimedFixed.map((id) => `     - ${id}`).join('\n') || '     (none claimed fixed)'}
   For EACH, read its full entry in its block, then INDEPENDENTLY re-derive the defect's root cause from
   the CURRENT code — do NOT just confirm the literal edit the entry described is present; the entry
   itself may have under-scoped the bug. A fix counts as landed ONLY if it closes that root cause
   COMPLETELY. If the same mechanism still has a live residual path the diff left open (a sibling code
   path, an already-started async chain that still writes the bad state, an untouched branch or caller
   with the identical defect), that is actually_fixed=false with a concrete note — EVEN IF the described
   edit was made. Return one fix_check per claimed issue.
   The developer reports these issues STALE (already absent from the current code):
${claimedStale.map((id) => `     - ${id}`).join('\n') || '     (none reported stale)'}
   For EACH, read its full entry and confirm against the CURRENT code that the defect is truly absent.
   Return a fix_check for it too: actually_fixed=true only when you confirmed the defect is gone. A STALE
   claim you cannot confirm is actually_fixed=false and fails acceptance exactly like an unclosed FIXED claim.
2. TRIAGE HELD. Confirm the diff touched NOTHING on behalf of an entry whose \`- decision:\` is not
   ACTIONABLE. Those are the user's calls to make, not this run's; a fix applied to one fails acceptance
   even when the code change looks right. The developer reports these issues SKIPPED:
${reportedSkipped.map((id) => `     - ${id}`).join('\n') || '     (none reported skipped)'}
   Confirm each one's \`- decision:\` is genuinely not ACTIONABLE: an ACTIONABLE entry reported SKIPPED is
   an issue left open, and it fails acceptance.
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-accepted
   behavior was changed or broken.
4. Run the FULL gates once and record the real outcome:
     build: ${GATES.build ?? '(none)'}    test: ${GATES.test ?? '(none)'}
   ${ACC_SUITE_LINE} If a configured MCP/tool is unavailable here, say so in the file (do not fake it)
   and return pass=false.
5. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE you decide anything in
   step 6: the per-issue root-cause verdict (with the residual path for any incomplete one), the
   triage-held result, the regression result, the gate output, and each gap — or "All fixes close their
   root cause; triage held; no regression."
6. DECIDE:
   • Every claimed fix complete, every STALE claim confirmed, no non-ACTIONABLE entry touched, gate
     green, no regression →
     \`git -C ${REPO} add <this block's changed AND newly-created files>\` (NEVER commit); return
     pass=true, staged=true. The baseline now advances to include this block.
   • LEGITIMATE NO-OP: if every entry was genuinely STALE or non-ACTIONABLE and the diff is empty, that is
     a valid pass — return pass=true AND staged=true (there is simply nothing to add). Say so explicitly
     in your file. Do NOT invent changes to justify it.
   • NO FIXED CLAIM, NON-EMPTY DIFF: when the FIXED list in step 1 is empty, no blind reviewer judged the
     tree, so the unstaged diff MUST be empty. Any change there fails acceptance: name the files in your
     file and return pass=false.
   • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;

const planAcceptance = (p, round) => {
  const isSection = p.mode === 'section';
  const reachStep = isSection
    ? `REACHABILITY: prove every integration point this block owns is satisfied — every call site
   converted, route mounted, symbol exported/bound/flagged (grep to prove it, with hit counts). A
   half-converted block is not done.`
    : `REACHABILITY: prove every integration point is satisfied — the feature is registered/exported/
   routed/bound/flagged and reachable from real entry points (grep to prove it).`;
  const gateStep = isSection
    ? `Run this block's gate and record the real outcome (build: ${GATES.build ?? '(none)'} ; tests scoped
   to this block, by its \`test_selector:\` line when it has one, else the test gate:
   ${GATES.test ?? '(none)'}). For gate=green the selector tests must PASS; for
   gate=red-baseline the authored tests must FAIL as intended (that failing test IS the spec — a valid,
   stageable "done"); for gate=build-only just build green. ${ACC_SUITE_LINE} If a configured MCP/tool is
   unavailable here, say so in the file (do not fake it) and return pass=false.`
    : `Run the FULL gates once and record the real outcome:
     build: ${GATES.build ?? '(none)'}    test: ${GATES.test ?? '(none)'}
   Re-run the plan's configured verification method to confirm the feature behaves as specified.
   ${ACC_SUITE_LINE} If a configured MCP/tool is unavailable here, say so in the file (do not fake it)
   and return pass=false.`;
  return `
You are the ACCEPTANCE VERIFIER — the final, plan-aware gate for ONE block. The blind code review already
passed (or was skipped because the developer changed nothing). Verify, against the repo itself, that THIS
block is fully delivered and nothing regressed. Read ${planRef(p)}. You judge the work against that
block; you never implement it.
${ENV}
BLOCK: ${p.id}   (mode: ${p.mode}, gate: ${p.gate})

${SETTLED(p.id, false)}
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. You are plan-aware — if a
dismissed item ACTUALLY breaks one of this block's acceptance criteria, leaves it unreachable, or causes
a regression, that OVERRIDES the dismissal: fail acceptance for it and record it in your review file.
An \`ESCALATED:\` line is a decision
routed to the user: hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a
held escalation never fails acceptance. Name it in your file as held.

AMENDMENTS: READ ${amendedFile(p.id)} if it exists. It records plan clauses the developer OVERRODE after
verifying the clause itself prescribes a real defect (MATRIX 6a). Judge a criterion whose prescribing
clause was amended against the AMENDED behavior, not the superseded clause, and NAME every criterion you
judged under an amendment in your review file. An amendment entry that states NO defect evidence excuses
NOTHING — that criterion stays UNMET, or the escape hatch becomes a free pass.

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  \`git -C ${REPO} diff --staged\` = accepted baseline (compare against it for regressions).

PROCEDURE:
1. ENUMERATE THIS block's acceptance criteria FIRST, numbered — that count is criteria_total (never 0 for
   a real block). For EACH, find concrete evidence it holds (a diff hunk, a passing test, an observed
   behavior) and mark it met / not-met with a file:line / test-name / command-output LOCATOR;
   criteria_met = how many hold. evidence_recorded=true only if EVERY met criterion carries such a
   locator in your review file — a criterion you asserted without one does not count as met.
2. ${reachStep}
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-accepted
   behavior was changed or broken.
4. ${gateStep}
5. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE you decide anything in
   step 6: the numbered per-criterion table WITH its locators, the reachability + regression result, the
   gate output, and each gap (title + file:line + fix) — or "All criteria met; reachable; no regression."
6. DECIDE:
   • All criteria met, reachable, gate satisfied, no regression → \`git -C ${REPO} add <this block's
     changed AND newly-created files>\` (NEVER commit); return pass=true, staged=true. The baseline now
     advances to include this block.
   • LEGITIMATE NO-OP: if this block genuinely requires NO code change because the staged baseline
     already satisfies every one of its criteria, that is a valid pass — return pass=true AND staged=true
     (there is simply nothing to add). Say so explicitly in your file. Do NOT invent changes to justify it.
   • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;
};

const ACCEPTANCE_FRAME = { feature: planAcceptance, section: planAcceptance, fix: fixAcceptance };

const acceptancePrompt = (p, round, claimedFixed = [], claimedStale = [], reportedSkipped = []) =>
  ACCEPTANCE_FRAME[p.mode](p, round, { claimedFixed, claimedStale, reportedSkipped });

// Only needs-user writes a NEEDS-USER entry, so every other halt names its own cause for park to cite.
const parkReason = (haltKind) => ({
  'needs-user': `the developer escalated a user-only decision (see ${NEEDS_USER})`,
  'agent-dead': 'an agent returned nothing (skipped or died)',
  'plan-unreadable': 'an agent could not obtain its plan',
  'staging-unconfirmed': `the developer did not confirm its work stayed unstaged; inspect \`git -C ${REPO} diff --cached\` for self-staged work`,
}[haltKind] || `the run halted (${haltKind || 'unknown halt'})`);

const parkPrompt = (p, lastReviewPath, escalated, haltKind) => `
You are PARKING the plan block "${p.id}", which ${escalated
    ? `was halted: ${parkReason(haltKind)}`
    : 'did NOT reach acceptance within its round budget'}. Its work is NOT thrown away and NOT left lying
in the working tree: you SAVE it to a patch, then clear it from the tree${escalated || ORDERED
    ? `. The run stops after you — ${escalated ? 'only the user can unblock it' : 'the blocks after this one depend on it'} — but the repo is left in a known,
buildable state the user can come back to (or run something else against) before resuming`
    : ` so the REST OF THE RUN can continue — the
next block's blind reviewer scopes on the unstaged diff, so leftover work would be attributed to that
block and fail it for this one's problems`}. Accepted blocks are STAGED and must survive untouched.
${ENV}
STAGING CONTRACT:
  • staged index + HEAD  = ACCEPTED blocks (the baseline). Treat as known-good; do NOT touch.
  • unstaged working tree = THIS block's unsuccessful work — the only thing you save and clear.
  • Nothing is EVER committed.

SAVE BEFORE YOU CLEAR — never the other way round. If the unstaged diff is NOT empty and step 1 cannot
produce a non-empty patch, STOP: leave the tree exactly as it is and return saved=false, cleared=false.
An already-empty diff is not a stop: step 1 says what to do.

PROCEDURE:
1. SAVE. \`git -C ${REPO} status --porcelain\` first. If \`git -C ${REPO} diff\` is already EMPTY there is
   nothing to park — skip to step 3 and return saved=false, patch_bytes=0, with a note saying so.
   Otherwise write the block's work to ${parkedPatch(p.id)} (create ${STATE_DIR}/ if needed):
     \`git -C ${REPO} diff --binary > ${parkedPatch(p.id)}\`
   \`--binary\` is REQUIRED (a plain diff records "Binary files differ" and will not re-apply). The
   unstaged diff IS exactly this block's work, and files the developer created are in it via \`git add -N\`.
   Then CONFIRM the file exists and is non-empty, and record its size as patch_bytes.
2. CATCH STRAYS. If \`git status --porcelain\` still lists any \`??\` untracked file this block created
   (the developer missed its \`git add -N\`), COPY those files into ${parkedNewDir(p.id)}/ preserving
   relative paths — the patch CANNOT carry them. Skip build output and caches. Report the count as
   strays_saved: it matters, because step 4 must tell the user those files exist.
3. CLEAR. Restore every tracked file this block modified to the staged baseline:
   \`git -C ${REPO} checkout -- <files>\`. Then delete the files it CREATED (untracked + any
   \`git add -N\` intent-to-add entries). Be precise about WHY each is safe to delete: an intent-to-add
   file is carried by the patch from step 1; a \`??\` stray is safe ONLY because step 2 copied it to
   ${parkedNewDir(p.id)}/. If step 2 did not copy a stray, do NOT delete it.
   Confirm \`git -C ${REPO} diff\` is EMPTY, then run the BUILD gate and record whether it is green.
4. RECORD. Append ONE entry to ${NEEDS_USER}, under a \`## Parked block: ${p.id}\` heading:
   - that this block is **NOT done and NOT abandoned — a status record, not a dismissal**${ORDERED
    ? ', and that the blocks after it were NOT attempted, because they depend on this one'
    : '; the remaining blocks continued without it'}
   - one line on why it was parked (${escalated ? parkReason(haltKind) : 'what acceptance was still failing'})
   - ${lastReviewPath ? `the diagnosis: \`${lastReviewPath}\`` : `that this block left no review file to cite; point the user at the run trail in ${STATE_DIR} instead of naming a file`}
   - the saved work: \`${parkedPatch(p.id)}\`
   - restore command, verbatim: \`git -C ${REPO} apply --3way ${parkedPatch(p.id)}\`
   - **ONLY IF step 2 actually copied stray files**: a line naming \`${parkedNewDir(p.id)}/\` as holding
     new files the patch cannot carry, listing them, and telling the user to copy them back into the repo
     (preserving relative paths) as a SECOND step after the \`git apply\`. Omit this line entirely when
     there were no strays — do not leave a dangling reference to an empty directory.
   - how to resume: fix the blocker (sharpening this block in the plan file if needed), then re-invoke
     with \`runOnly:["${p.id}"]\` from the CLEAN baseline and let the developer redo it — the default,
     with the patch kept for reference. The ONLY alternative is to apply the patch and finish this block
     BY HAND, because a resumed run requires a clean unstaged tree and halts on a dirty one. Do NOT tell
     the user to \`git add -A\` the restored work: that folds UN-reviewed code into the accepted baseline,
     invisible to the blind reviewer.
Do NOT touch the staged baseline, do NOT commit, and do NOT modify any file outside this block's work.
Return saved + cleared + gates_green + patch_bytes + strays_saved via the schema.`;

const sweepPrompt = (doneIds) => `
You are the FINAL COMPLETENESS SWEEP. Every block is done and its work is STAGED. Verify, against the
repo itself, that the GOAL is actually fully achieved — your job is to find what the plan MISSED, not to
re-review accepted work. Read the approved plan file(s) VERBATIM: ${PLAN_FILES.join(' , ')}.
${ENV}
COMPLETED BLOCKS: ${doneIds.join(', ')}

PROCEDURE (read-only except step 4):
1. RE-DERIVE the change surface from the GOAL: grep the target repo for every pattern/API/symbol the goal
   replaces or touches. Any hit that should have been converted but wasn't = a gap. Record hit counts so
   coverage is checkable.
2. Run the FULL gates once and record the real outcome (build: ${GATES.build ?? '(none)'} ; test:
   ${GATES.test ?? '(none)'}). If the GOAL implies whole-suite green at the end, a red suite is a gap; if
   a red tail is expected, say which failures look expected vs surprising.
3. Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): does it plausibly cover every
   block's acceptance? Look for suspiciously-untouched areas the GOAL names.
4. WRITE ${SWEEP_FILE}: the suite result, then each gap (title + file:line evidence + a suggested
   follow-up block) — or "No gaps found." Do NOT modify source code, stage, or commit.
Report ONLY material, in-GOAL gaps — not improvements, not pre-existing issues. Return via the schema.`;

// =============================================================================
// Launch guards — the gate commands are what "it works" MEANS here.
// =============================================================================
// gateOk() skips the build check without GATES.build, so omitting it passes blocks nothing compiled.
if (typeof A.gates?.build !== 'string' || !A.gates.build.trim()) {
  throw new Error('args.gates.build is required: the shell command that defines a GREEN build (non-zero exit = fail). Without it the build gate silently no-ops and a block can pass with nothing compiled.');
}

// =============================================================================
//   status:'todo'   — the only status this engine builds. done/skip/parked/blocked are never selected.
//   runOnly: [ids]  — build exactly these blocks (in array order).
//   startAt: id     — build from this block to the end (skip already-accepted earlier ones).
// =============================================================================
const TODO = ALL_PLANS.filter((p) => p.status === 'todo');
// Shape before ids: a string runOnly would fall to null and silently build and stage every todo block.
if (A.runOnly !== undefined && A.runOnly !== null
    && (!Array.isArray(A.runOnly) || A.runOnly.some((id) => typeof id !== 'string' || !id.trim()))) {
  throw new Error(`Invalid slice arg: args.runOnly must be an ARRAY of block id strings; got ${JSON.stringify(A.runOnly)}. It is not coerced — a non-array drops the scope silently and builds every todo block in the roadmap.`);
}
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
let pending = TODO;
if (runOnly) {
  // A dropped id builds fewer blocks than asked, and an all-typo list builds nothing and reports success.
  const unknown = runOnly.filter((id) => !ALL_PLANS.some((p) => p.id === id));
  if (unknown.length) throw new Error(`args.runOnly ${unknown.map((id) => `"${id}"`).join(', ')} matches no plan id. Valid ids: ${ALL_PLANS.map((p) => p.id).join(', ')}`);
  pending = TODO.filter((p) => runOnly.includes(p.id));
} else if (A.startAt) {
  // Resolved against the WHOLE array, not the todo slice: startAt is normally the first not-yet-accepted
  // id, and naming an already-done one must scope the run rather than throw.
  const i = ALL_PLANS.findIndex((p) => p.id === A.startAt);
  // Falling back to the full array would rebuild accepted blocks.
  if (i < 0) throw new Error(`args.startAt "${A.startAt}" matches no plan id. Valid ids: ${ALL_PLANS.map((p) => p.id).join(', ')}`);
  const fromHere = new Set(ALL_PLANS.slice(i).map((p) => p.id));
  pending = TODO.filter((p) => fromHere.has(p.id));
}
const isFullRun = !runOnly && !A.startAt;

// Scoped to pending, so an all-done relaunch reaches the nothing-to-run terminal instead of throwing over
// a test command it will never run.
if (pending.some((p) => p.gate === 'green') && (typeof A.gates?.test !== 'string' || !A.gates.test.trim())) {
  throw new Error('args.gates.test is required when any block being built has gate:"green": the shell command that runs the verification (non-zero exit = fail). A block that legitimately has none takes gate:"build-only" instead.');
}

const reviewTrail = `Numbered review files show every iteration: quality-review-<id>-rN.md in ${GATE_DIR}/ — the blind reviewer's whole world, which is why nothing carrying the plan lives in it — and acceptance-review-<id>-rN.md in ${STATE_DIR}/; git staging marks each accepted block.`;

// A terminal, not a throw: an all-done relaunch is legitimate, and the caller must tell it from bad args.
if (!pending.length) {
  log(`develop: no todo blocks selected out of ${ALL_PLANS.length} — nothing to run`);
  return {
    runId: RUN_ID,
    status: 'nothing to run (no todo blocks)',
    halted: false,
    haltReason: '',
    regression: false,
    contestedDismissals: 0,
    stateDir: STATE_DIR,
    plansDone: [],
    plansTotal: ALL_PLANS.length,
    sweep: null,
    sweepFailed: false,
    parked: [],
    ledger: [],
    statusSync: [],
    reviewTrail,
    followups: `No block in args.plans has status:"todo"${runOnly ? ` within runOnly [${runOnly.join(', ')}]` : A.startAt ? ` at or after startAt "${A.startAt}"` : ''}. Nothing was built and nothing was changed. If work remains, set that block's status back to todo in its plan file and re-run; otherwise this roadmap is finished — verify the end state yourself (run the full gates, \`git -C ${REPO} diff --cached --stat\`) and commit.`,
  };
}

log(`develop: ${pending.length}/${ALL_PLANS.length} block(s) to build${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : A.startAt ? ` (startAt: ${A.startAt})` : ''} [maxRounds=${MAX_ROUNDS}, ordered=${ORDERED}, suite=${SUITE}]`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
// Also logged per block as one STATUS_LOG line: run logs survive a failed or stopped run, and
// `plan-edit.mjs args` folds them into the plan file.
const statusSync = [];
const STATUS_LOG = 'status-sync ';
let halted = false;
let haltReason = '';
// A value, so the status line never parses haltReason prose. Every halt site sets it.
let haltKind = '';
const doneIds = [];
// Every agent-dead halt parks first, so a cached replay would return rounds whose work is no longer in the
// tree. The only honest recoveries are a clean relaunch or finishing the parked patch by hand.
const DEAD_AGENT_RECOVERY = 'Its work, if any, is parked. Once `plan-edit.mjs args` has applied the statuses of this run, flip the block to todo and relaunch clean, or apply the patch and finish by hand.';

/**
 * One fix entry's synced status, or '' for no edit. An id this run claimed FIXED maps as FIXED even when a
 * later round re-reported it STALE: that STALE is its own unstaged fix, so it closes only if the block lands.
 * A plain STALE closes only in a landed block too: a block that parks or blocks before acceptance never checked it.
 */
function issueSyncStatus(status, claimedFixed, landed) {
  if (status === 'FIXED' || (status === 'STALE' && claimedFixed)) return landed ? 'fixed' : 'needs-attention';
  if (status === 'STALE') return landed ? 'stale' : 'needs-attention';
  if (status === 'FAILED') return 'needs-attention';
  return '';   // SKIPPED: the entry stays open, and its decision line already says why
}

/**
 * A fix block's per-issue record across rounds. The engine never parses a block, so the statuses the
 * developer reports are the only record of which entries were touched.
 */
function fixTracker(p) {
  const reported = new Map();     // issue id → the last status reported, across rounds
  // A pass edits each issue in its own block's plan file. An id no member lists has no file to edit.
  const owners = new Map((p.blocks ?? []).flatMap((b) => b.issues.map((id) => [id, b.planPath])));
  const ownerOf = (id) => (p.blocks ? owners.get(id) : p.planPath);
  // Ever claimed FIXED, monotonic. A later round that re-reports an id STALE (its own round-1 fix closed
  // it) must not withdraw that fix from verification while its diff still sits unstaged: an empty claim
  // list makes the root-cause re-derivation vacuous and stages unverified code.
  const claimedEver = new Set();
  const unclosed = new Set();     // ids the latest fix_check reported actually_fixed=false
  // A STALE report closes its entry once the block lands, so acceptance confirms it too. One still in
  // claimedEver is this block's own fix and is already on the FIXED list.
  const stale = () => [...reported].filter(([id, s]) => s === 'STALE' && !claimedEver.has(id)).map(([id]) => id);
  return {
    /** This round's results, recorded before any halt so an escalated block still reaches the ledger. */
    record(dev) {
      const results = Array.isArray(dev.results) ? dev.results : [];
      for (const r of results) {
        if (r && typeof r.issue_id === 'string' && typeof r.status === 'string') {
          reported.set(r.issue_id, r.status);
          if (r.status === 'FIXED') claimedEver.add(r.issue_id);
        }
      }
      return results;
    },
    ledger: () => [...reported].map(([issue_id, status]) => ({ issue_id, status })),
    claimed: () => [...claimedEver],
    stale,
    skipped: () => [...reported].filter(([, s]) => s === 'SKIPPED').map(([id]) => id),
    /** The verdict's fix checks. Every verdict counts, not just a pass: the latest check per id wins. */
    judge(acc) {
      const checks = acc?.fix_checks || [];
      for (const c of checks) {
        if (typeof c?.issue_id !== 'string') continue;
        if (c.actually_fixed === false) unclosed.add(c.issue_id);
        else if (c.actually_fixed === true) unclosed.delete(c.issue_id);
      }
      const openChecks = checks.filter((c) => c?.actually_fixed === false).length;
      const staleIds = stale();
      return {
        criteria: null,
        reachable: null,
        thin: checks.length < claimedEver.size + staleIds.length,
        open: openChecks > 0,
        evidence: `${checks.length} check(s) for ${claimedEver.size} claimed fix(es)${staleIds.length ? ` and ${staleIds.length} stale claim(s)` : ''}`,
        contraDetail: `unclosed=${openChecks}`,
        score: `${checks.length} fix check(s)`,
        reachNote: '',
      };
    },
    /**
     * One `{ planPath, id, value }` per entry whose status changes. An entry acceptance's own fix_check
     * judged still open never syncs `fixed` or `stale`, even in a landed block: either value would drop a
     * live defect from every later run.
     */
    edits(landed) {
      const out = [];
      for (const [id, status] of reported) {
        const mapped = issueSyncStatus(status, claimedEver.has(id), landed);
        const value = (mapped === 'fixed' || mapped === 'stale') && unclosed.has(id) ? 'needs-attention' : mapped;
        if (!value) continue;
        if (ownerOf(id)) out.push({ planPath: ownerOf(id), id, value });
        else log(`  ⚠ ${p.id}: issue ${id} was reported ${status} but belongs to no block in this pass — no status edit`);
      }
      return out;
    },
  };
}

/** A feature or section verdict: its criteria, reachability, and what makes a pass thin or self-contradicting. */
function judgePlanAcceptance(acc) {
  const criteria = { met: Number(acc?.criteria_met) || 0, total: Number(acc?.criteria_total) || 0 };
  return {
    criteria,
    reachable: acc?.reachable === true,
    thin: criteria.total === 0 || criteria.met < criteria.total || acc?.evidence_recorded !== true,
    open: acc?.reachable !== true,
    evidence: `evidence_recorded=${acc?.evidence_recorded}`,
    contraDetail: `reachable=${acc?.reachable}`,
    score: `${criteria.met}/${criteria.total} criteria`,
    reachNote: `reachable=${acc?.reachable}, `,
  };
}

/** Records a finished block or pass: its ledger row, each member block's status, and each changed fix entry's. */
function finishBlock(p, rec, blockStatus, fix) {
  const members = p.blocks ?? [{ id: p.id, planPath: p.planPath }];
  const issueEdits = fix ? fix.edits(blockStatus === 'done') : [];
  const edits = [...members, ...issueEdits].map((e) => ({ planPath: e.planPath, id: e.id, key: 'status', value: e.value ?? blockStatus }));
  ledger.push(rec);
  statusSync.push(...edits);
  log(STATUS_LOG + JSON.stringify(edits));
}

for (const p of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between blocks rather
  // than letting an agent() call throw mid-block. Accepted blocks are STAGED; resume continues.
  if (budget.total && budget.remaining() < MIN_PLAN_BUDGET) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltKind = 'budget';
    haltReason = `Stopped before block ${p.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minPlanBudget). Resume with startAt:"${p.id}".`;
    log(`⏸ ${haltReason}`);
    break;
  }

  log(`▶ block ${p.id} [mode=${p.mode}, gate=${p.gate}]${p.blocks ? ` packing ${p.blocks.map((b) => b.id).join(', ')}` : ''}`);
  const rec = { id: p.id, mode: p.mode, gate: p.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, planAmendments: 0, staged: false, reachable: false, regression: false, criteria: null, results: null, thinEvidence: false, contradicted: false, parked: false, patch: null, strays: null };
  const fix = p.mode === 'fix' ? fixTracker(p) : null;
  // 'no-changes' when this fix block ended on the round-1 no-changes terminal ('' = none). It does not
  // park: the tree is clean, so park would have nothing to save.
  let fixTerminal = '';
  // The latest review file the developer must address. Empty until a reviewer writes one, and never
  // replaced by a path nobody wrote: the halt reason and parkPrompt each say so instead.
  let reviewPath = '';
  // Produced work no clean review has passed. The tree is CUMULATIVE while `produced` is per-round, so a
  // round that only re-runs a red gate or DROPs every finding reports produced=false over unreviewed code.
  let reviewOwed = false;
  let accepted = false;
  // `escalated` distinguishes the halts that leave real work in the tree (park it) from a round-1
  // dirty-baseline halt, which changed nothing — that work is the OPERATOR's and must never be parked.
  let escalated = false;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    rec.rounds = round;

    // ---- DEVELOP -----------------------------------------------------------
    phase('Develop');
    const dev = await agent(developPrompt(p, round, reviewPath), roleOpts('develop', {
      schema: developSchema(p.mode), phase: 'Develop', label: `develop ${p.id} r${round}`,
    }));

    // ---- PRECONDITION: the developer AGENT itself came back -----------------------------------------
    // A dead developer is agent-dead, not a gate miss that burns the round budget. Halt, not throw, so
    // park still runs.
    if (!dev) {
      halted = true;
      escalated = true;   // it may have touched the tree before dying → park rather than abandon
      haltKind = 'agent-dead';
      haltReason = `Developer for block ${p.id} returned nothing in round ${round} (agent skipped or died) — no work can be assumed either way. ${DEAD_AGENT_RECOVERY}`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${p.id} r${round}: developer returned nothing (agent skipped or died) → halting before any review agent`);
      break;
    }

    // ---- PRECONDITION: the developer actually HAS its block -----------------------------------------
    // The block command runs in the agent's shell, so this attestation is the only proof the block
    // arrived. `=== false` leaves a null return to the agent-dead halt above.
    if (dev?.plan_obtained === false) {
      halted = true;
      escalated = true;   // it may have touched the tree before giving up → park rather than abandon
      haltKind = 'plan-unreadable';
      haltReason = `Developer for block ${p.id} could not obtain its plan (round ${round}). Its plan reference was: ${planRef(p)}. Run that yourself: a non-zero exit names the cause (an id matching no "## Plan:" block, a pruned or mistyped plan file, or the command not permitted in this environment). Nothing was built from a guess.`;
      rec.status = 'BLOCKED (plan unreadable)';
      log(`  ✋ ${p.id} r${round}: developer never got its plan → halting before any review agent`);
      break;
    }

    // ---- PRECONDITION (round 1 of every block): the unstaged tree must have been CLEAN --------------
    // Reviewers scope on the unstaged diff, so pre-existing work would be judged as this block's.
    if (round === 1) {
      // Guard the value, never its coercion: Number(null), Number(false) and Number('') are a finite 0,
      // which reads as clean.
      const dirty = dev?.baseline_dirty_files;
      if (typeof dirty !== 'number' || !Number.isFinite(dirty)) {
        log(`  ⚠ ${p.id} r1: developer did not report baseline_dirty_files — the clean-baseline precondition was NOT verified`);
      } else if (dirty > 0) {
        halted = true;
        rec.status = 'BLOCKED (dirty baseline)';
        haltKind = 'dirty-baseline';
        haltReason = `Block ${p.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the reviewers' scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain), then run ONE command and re-invoke this run unchanged: \`git -C ${REPO} add -A\` to KEEP it when it is your own pre-existing edits (folds it into the accepted baseline), or \`git -C ${REPO} stash -u\` to set it aside. If the dirt is an earlier interrupted develop run's unfinished block, never \`git add -A\` it (no reviewer passed it): \`git -C ${REPO} stash -u\` it and relaunch, or relaunch that run with the Workflow tool's resumeFromRunId. Nothing was built or changed.`;
        log(`  ✋ ${p.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before any review agent (git add -A only your own edits, or git stash -u, then re-run)`);
        break;
      }
      // Zero `### [` entries would reach the no-changes terminal and report a clean outcome over an
      // inventory nobody read. The value is guarded, never coerced, as above.
      if (fix) {
        const entries = dev.entries_found;
        if (typeof entries !== 'number' || !Number.isFinite(entries)) {
          log(`  ⚠ ${p.id} r1: developer did not report entries_found — the inventory-readable precondition was NOT verified`);
        } else if (entries === 0) {
          halted = true;
          rec.status = 'BLOCKED (no issue entries)';
          haltKind = 'inventory-empty';
          haltReason = `Fix block ${p.id} was not started: the developer counted ZERO "### [" issue entries in the block it was handed, so there was nothing to fix. Its block reference was: ${planRef(p)}. Run that yourself and read what it prints: check the planPath and the block id, NOT runId/root/stateDir — those name where run-state lands and select nothing in the plan file. Nothing was built or changed.`;
          log(`  ✋ ${p.id}: developer found 0 "### [" issue entries in its block → halting before any review agent (check the planPath and the block id)`);
          break;
        }
      }
    }
    // ---- FIX MODE: the per-issue results ARE the round's record ------------------------------------
    // Derived, so a round that only SKIPPED or found STALE entries cannot pull the blind reviewer onto an
    // empty diff. Recorded before the halts below so an escalated block still reaches the ledger.
    const results = fix ? fix.record(dev) : [];
    if (fix) rec.results = fix.ledger();
    if (dev?.needs_user === true) {
      halted = true;
      escalated = true;   // real work may be in the tree → park it below rather than abandoning it there
      haltKind = 'needs-user';
      haltReason = `Developer halted for a user-only decision in block ${p.id} round ${round} (see ${NEEDS_USER}).`;
      rec.status = 'BLOCKED (needs user)';
      log(`  ✋ ${p.id} r${round}: developer escalated a user-only decision → halting (see ${NEEDS_USER})`);
      break;
    }
    // ---- PRECONDITION: the work is still UNSTAGED ---------------------------------------------------
    // Self-staged work would skip both reviewers and be inherited as the accepted baseline.
    // POSITION IS LOAD-BEARING: it sits AFTER the dead-agent, plan_obtained, dirty-baseline and
    // needs_user checks, because a null return also fails `!== true` — a dead developer must report
    // agent-dead, and a dirty baseline dirty-baseline, never this.
    if (dev.unstaged_confirmed !== true) {
      halted = true;
      escalated = true;   // real work is probably in the tree → park it rather than abandon it
      haltKind = 'staging-unconfirmed';
      haltReason = `Developer for block ${p.id} did not confirm its work stayed UNSTAGED in round ${round} (unstaged_confirmed=${JSON.stringify(dev.unstaged_confirmed)}). The staged index is the one surface neither reviewer checks — the blind critic reads \`git diff\`, acceptance treats \`git diff --staged\` as the accepted baseline — so anything staged here would be reviewed by nobody and then inherited as known-good. Inspect \`git -C ${REPO} diff --cached\` before resuming.`;
      rec.status = 'BLOCKED (staging unconfirmed)';
      log(`  ✋ ${p.id} r${round}: developer did not confirm its work stayed UNSTAGED → halting before any review agent (inspect git -C ${REPO} diff --cached)`);
      break;
    }
    if (dev?.dismissed_count) {
      log(`  ${p.id} r${round}: developer declined ${dev.dismissed_count} finding(s) → ${dismissedFile(p.id)} (audit these at the end)`);
    }
    // MATRIX 6a: only the count travels (#1/#8). Coerced so garbage cannot poison the ledger total.
    const amendments = Number(dev?.plan_amendments) || 0;
    if (amendments > 0) {
      rec.planAmendments += amendments;
      log(`  ⚠ ${p.id} r${round}: ${amendments} plan amendment(s) recorded — see ${amendedFile(p.id)}`);
    }
    const produced = fix
      ? results.some((r) => r?.status === 'FIXED' || r?.status === 'FAILED')
      : dev.produced === true;
    if (produced) reviewOwed = true;
    if (!gateOk(p.gate, dev)) {
      // Retain reviewPath: a still-open review, such as a quality CONTEST, must keep being addressed. At
      // the budget the engine holds the only copy of why the gate was red, so log it.
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: gate(${p.gate}) not satisfied at round budget (via=${dev?.verification_method || 'n/a'})${dev?.gate_output ? ` — last gate output: ${String(dev.gate_output).slice(-500)}` : ''}`); break; }
      log(`  ↻ ${p.id} r${round}: gate(${p.gate}) not satisfied (build=${dev?.build_passed}, test=${dev?.test_outcome}, count=${dev?.tests_run_count}, suite=${dev?.full_suite_outcome}, via=${dev?.verification_method || 'n/a'}) → another develop round`);
      continue;
    }

    // ---- FIX MODE, ROUND 1 ONLY: nothing produced over a green gate --------------------------------
    // All STALE is a claim acceptance must confirm, so it falls through. Anything else closed nothing and
    // never counts done. Round 1 only (see reviewOwed): later, results:[] can follow a real fix, and this
    // exit would strand that work past quality, acceptance and park.
    if (fix && !produced && round === 1) {
      const onlyStale = results.length > 0 && results.every((r) => r?.status === 'STALE');
      if (onlyStale) {
        log(`  ${p.id}: every issue reported already resolved (all ${results.length} STALE) — no diff, so acceptance confirms each claim without a blind review`);
      } else {
        fixTerminal = 'no-changes';
        rec.status = fixTerminal;
        log(`  ⚠ ${p.id}: no changes produced — ${results.length ? 'every entry was skipped or stale' : 'the developer reported no entries at all'}; the block is NOT done and its issues stay open`);
        if (ORDERED) {
          halted = true;
          haltKind = 'no-changes';
          haltReason = `Fix block ${p.id} produced no changes in round 1: every entry it reported was SKIPPED or STALE (or it reported none), so nothing was fixed and nothing was staged. This is an ORDERED run, so the blocks after it were not attempted. Read the block itself — an entry only gets fixed while its \`- decision:\` line says ACTIONABLE — then re-run. The tree is clean.`;
        }
        break;
      }
    }

    // ---- QUALITY REVIEW (blind, must pass before acceptance) ----------------
    // reviewOwed, not produced: see its declaration. A no-op block still reaches acceptance, which judges
    // the claim.
    if (reviewOwed) {
      phase('Quality');
      rec.qualityRounds++;
      const quality = await agent(qualityPrompt(p, round), roleOpts('quality', {
        schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality ${p.id} r${round}`,
      }));
      // A dead reviewer is not a clean review, and the next round would read a review file nobody wrote.
      if (!quality) {
        halted = true;
        escalated = true;
        haltKind = 'agent-dead';
        haltReason = `Quality reviewer for block ${p.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a clean review. ${DEAD_AGENT_RECOVERY}`;
        rec.status = 'BLOCKED (agent died)';
        log(`  ✋ ${p.id} r${round}: quality reviewer returned nothing (agent skipped or died) → halting`);
        break;
      }
      if (quality?.contested_dismissals) {
        rec.contested += quality.contested_dismissals;
        log(`  ⚠ ${p.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — developer must fix or escalate, not re-dismiss (audit ${dismissedFile(p.id)})`);
      }
      if (quality?.clean !== true) {
        reviewOwed = true;
        reviewPath = qualityFile(p.id, round);
        if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget (see ${reviewPath})`); break; }
        log(`  ↻ ${p.id} r${round}: quality review found ${quality?.issue_count ?? '?'} issue(s) → develop addresses ${reviewPath}`);
        continue;
      }
      reviewOwed = false;
      log(`  ✓ ${p.id} r${round}: quality review clean`);
    } else {
      log(`  ${p.id} r${round}: developer produced no changes — skipping blind review; acceptance will judge the block against its criteria`);
    }

    // ---- ACCEPTANCE REVIEW (plan-aware; stages on pass; baseline advances) ---
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(p, round, fix?.claimed(), fix?.stale(), fix?.skipped()), roleOpts('acceptance', {
      schema: acceptanceSchema(p.mode), phase: 'Acceptance', label: `acceptance ${p.id} r${round}`,
    }));
    // A dead verifier is not a gap verdict, and the next round would read a review file nobody wrote.
    if (!acc) {
      halted = true;
      escalated = true;
      haltKind = 'agent-dead';
      haltReason = `Acceptance verifier for block ${p.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a gap verdict, and nothing was staged. ${DEAD_AGENT_RECOVERY}`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${p.id} r${round}: acceptance verifier returned nothing (agent skipped or died) → halting`);
      break;
    }
    // Without the block, the verifier's pass:false would park the block as a routine gap.
    if (acc?.plan_obtained === false) {
      halted = true;
      escalated = true;
      haltKind = 'plan-unreadable';
      haltReason = `Acceptance verifier for block ${p.id} could not obtain its plan (round ${round}), so it had no criteria to judge. Its plan reference was: ${planRef(p)}. Run that yourself: a non-zero exit names the cause.`;
      rec.status = 'BLOCKED (plan unreadable)';
      log(`  ✋ ${p.id} r${round}: acceptance never got its plan → halting`);
      break;
    }
    if (acc?.regression === true) rec.regression = true;
    // Per mode: a fix schema has no criteria or reachability, which would flag every fix pass as thin.
    const verdict = fix ? fix.judge(acc) : judgePlanAcceptance(acc);
    rec.criteria = verdict.criteria;
    if (acc?.pass === true) {
      rec.reachable = verdict.reachable;
      // A thin pass (#14) is flagged for audit, not failed: acceptance already staged.
      rec.thinEvidence = verdict.thin;
      // Flag both contradictions. Halt only on the regression: staged work becomes every later baseline.
      rec.contradicted = acc?.regression === true || verdict.open;
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (${verdict.evidence}) — audit ${acceptanceFile(p.id, round)}` : '';
      const contraNote = rec.contradicted ? ` ⚠ CONTRADICTS ITS OWN PASS (regression=${acc?.regression}, ${verdict.contraDetail}) — audit ${acceptanceFile(p.id, round)}` : '';
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        log(`  ✓ ${p.id}: acceptance PASSED — ${verdict.score} — STAGED (${verdict.reachNote}gate=${acc?.suite_result || 'n/a'})${thinNote}${contraNote}`);
        // Halt, not re-round (the next blind diff cannot see staged work) and not park (park never
        // touches the baseline). The block stays "done (staged)".
        if (acc?.regression === true) {
          halted = true;
          haltKind = 'acceptance-regression';
          haltReason = `Block ${p.id} was STAGED by acceptance while the SAME verdict reported regression=true — a self-contradictory return (see ${acceptanceFile(p.id, round)}). Its work is now the baseline every later block would be judged against, so the run stops here. Inspect \`git -C ${REPO} diff --cached\`; unstage/fix it, then resume with startAt the NEXT block id.`;
          log(`  ✋ ${p.id}: staged while self-reporting a REGRESSION → halting the run (inspect git -C ${REPO} diff --cached)`);
        }
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next block's blind diff would include
      // this block's unstaged work. Do NOT advance; halt for manual staging, then resume.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage — stage manually, then resume)';
      haltKind = 'passed-unstaged';
      haltReason = `Block ${p.id} passed acceptance but its work was left UNSTAGED. Stage its files (git -C ${REPO} add <files>) so the baseline advances, then relaunch: the next \`plan-edit.mjs args\` marks the block done: no startAt is needed.`;
      log(`  ✋ ${p.id}: acceptance passed but NOT staged → halting (staging boundary)`);
      break;
    }
    reviewPath = acceptanceFile(p.id, round);
    if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s) at round budget (see ${reviewPath})`); break; }
    log(`  ↻ ${p.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → develop addresses ${reviewPath}`);
  }

  if (accepted) {
    // accepted implies staged: the passed-but-unstaged case halts above.
    rec.status = 'done (staged)';
    doneIds.push(p.id);
    // Staged while self-reporting a regression: the work IS in the baseline, but the operator must inspect
    // it before anything builds on it, so the plan file says blocked, never done.
    finishBlock(p, rec, haltKind === 'acceptance-regression' ? 'blocked' : 'done', fix);
    continue;
  }

  // The fix-mode round-1 no-changes terminal does NOT park: the developer changed nothing, so there is no
  // work to save and nothing to clear. It never counts done, and in an ORDERED run it has already halted.
  if (fixTerminal) {
    finishBlock(p, rec, 'blocked', fix);
    if (halted) break;
    continue;
  }

  // ---- PARK: save this block's work, then clear the tree ------------------------------------------
  // Clearing gives the next block's blind reviewer a diff of its own. Skipped on a dirty-baseline halt,
  // whose tree holds the operator's work.
  if (!(halted && !escalated)) {
    // Ordered blocks depend on their predecessors landing.
    if (ORDERED && !halted) {
      halted = true;
      haltKind = 'parked';
      // reviewPath may be empty: see its declaration.
      haltReason = `Block ${p.id} did not reach acceptance within ${MAX_ROUNDS} rounds (${reviewPath ? `see ${reviewPath}` : `it produced no review file — its gate never went green; see the run trail in ${STATE_DIR}`}).`;
      log(`  ✋ ${p.id}: not accepted within ${MAX_ROUNDS} rounds → parking its work, then halting (ordered run)`);
    }
    phase('Park');
    // reviewPath passes through empty or not: see its declaration.
    const pk = await agent(parkPrompt(p, reviewPath, escalated, haltKind), roleOpts('develop', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${p.id}`,
    }));
    const strays = pk?.strays_saved ?? 0;
    // Patch bytes with saved=false contradicts itself, and the tree may already be cleared: name the patch.
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    // Null when park wrote nothing. Every later patch mention keys on this, never naming a missing file.
    rec.patch = (pk?.saved === true || contradictory) ? parkedPatch(p.id) : null;
    // A value, so parked[] never parses status prose: an escalated block keeps its BLOCKED status.
    rec.parked = true;
    if (strays > 0) rec.strays = parkedNewDir(p.id);
    if (!escalated) rec.status = 'parked (not accepted within round budget)';
    // Park's notes are the only place an empty park explains itself. Logged, not returned.
    log(`  ⚠ ${p.id}: ${escalated ? 'escalated to the user' : `not accepted within ${MAX_ROUNDS} rounds`} — PARKED (work saved to ${rec.patch || 'nothing to save'}${pk?.patch_bytes ? `, ${pk.patch_bytes}B` : ''}${strays > 0 ? `, +${strays} stray file(s) in ${parkedNewDir(p.id)}/` : ''}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${pk?.gates_green ? 'green' : 'RED'}) — see ${NEEDS_USER}${pk?.notes ? ` — park note: ${String(pk.notes).slice(0, 300)}` : ''}`);
    // A tree we could not clear (or a broken build) is unsafe for whatever comes next, so those DO halt
    // even in an unordered run, where a plain park does not.
    if (contradictory) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Park reported saved=false for block ${p.id} but wrote ${pk.patch_bytes} bytes to ${parkedPatch(p.id)} — the report contradicts itself. The patch is real; inspect it before continuing (the tree was ${pk?.cleared === true ? 'already cleared' : 'left as-is'}).`;
    } else if (pk?.cleared !== true) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Block ${p.id} could not be cleared from the working tree${pk?.saved === true ? ` (its work IS saved to ${parkedPatch(p.id)})` : ' and its work was NOT saved — the tree still holds it'}; the tree is unsafe for whatever runs next.`;
    } else if (pk?.gates_green === false) {
      // A cleared tree with a red build is not safe to resume into.
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The build gate is not green after parking block ${p.id}; the tree is unsafe for whatever runs next.`;
    } else if (halted) {
      // The run is stopping, so say where the work went (see rec.patch).
      haltReason += rec.patch
        ? ` Its work is SAVED to ${rec.patch} and the tree is CLEAN; resolve with the user, then resume from this block.`
        : ` It had NOTHING to save (its working tree was already empty) and the tree is CLEAN; resolve with the user, then resume from this block.`;
    }
  }
  // Guards a future exit that sets no status: a leaked 'pending' reads as "still working".
  if (rec.status === 'pending') rec.status = 'BLOCKED (engine bug: block finished with no status set)';
  // Only a park over the round budget is `parked`. An escalation, an unsafe park and every halt that never
  // parked need the operator before the block may run again. A passed-but-unstaged block is `done`:
  // acceptance passed, and if the operator never stages it the next launch's clean-tree check halts on it.
  const budgetPark = rec.parked && !escalated && haltKind !== 'park-unsafe';
  let blockStatus = budgetPark ? 'parked' : 'blocked';
  if (haltKind === 'passed-unstaged') blockStatus = 'done';
  finishBlock(p, rec, blockStatus, fix);
  if (halted) break;      // escalation / ordered park / unsafe tree stops the run; an unordered park carries on
}

// =============================================================================
// Final completeness sweep. Gated on every non-skip block being done, not on a full run: a relaunch
// derives pending from the todo blocks, so a full-run test would read false on every relaunch.
// =============================================================================
let sweep = null;
let sweepFailed = false;   // the sweep RAN and DIED — distinct from the legitimate did-not-run cases
const goalCovered = !halted && ALL_PLANS
  .filter((p) => p.status !== 'skip')
  .every((p) => p.status === 'done' || doneIds.includes(p.id));
if (SWEEP_MODE === 'goal-coverage' && goalCovered) {
  phase('Sweep');
  sweep = await agent(sweepPrompt(doneIds), roleOpts('sweep', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  // A dead sweep is not a clean sweep. It does not halt: every block is staged, and the sweep is advisory.
  sweepFailed = !sweep;
  log(sweepFailed
    ? `  ⚠ sweep: the final completeness check DIED — it did not run, and ${SWEEP_FILE} was not written. Every block is staged, but NOTHING verified the goal was fully covered: re-run the sweep, or check coverage against the goal yourself.`
    : sweep.complete
      ? `sweep: no goal-coverage gaps found (suite: ${sweep.suite_result || 'n/a'})`
      : `sweep: ${(sweep.gaps || []).length} potential gap(s) — see ${SWEEP_FILE}`);
}

// =============================================================================
// Result (control plane → the orchestrating agent; durable progress lives in git + the review-file trail)
// =============================================================================
// Every block this run SELECTED is staged. Scoped to `pending` (the todo slice), not to the whole array:
// entries already `done` in the plan file are the accepted baseline, not work this run owed.
const allDone = isFullRun && !halted && pending.length > 0 && doneIds.length === pending.length;
const contestedTotal = ledger.reduce((s, r) => s + (r.contested || 0), 0);
// Blocks whose developer overrode a plan clause under MATRIX 6a. Named here because AMENDED-<id>.md is
// reachable by acceptance alone — without this the user would have to already know the file exists.
const amendedIds = ledger.filter((r) => r.planAmendments > 0).map((r) => r.id);
// Keyed on the patch and rec.parked, never the status string.
const parkedPlans = ledger.filter((r) => r.patch || r.parked === true);
// Split on rec.patch. An empty park is still a block not done.
const patchedPlans = parkedPlans.filter((r) => r.patch);
const emptyParkPlans = parkedPlans.filter((r) => !r.patch);
// Selected blocks that ended neither done nor parked: a fix block that closed no issue (no-changes), or a
// block stopped by a halt that never parks (dirty-baseline, inventory-empty, passed-unstaged).
const blockedPlans = ledger.filter((r) => !doneIds.includes(r.id) && !parkedPlans.includes(r));
const noChangePlans = blockedPlans.filter((r) => r.status === 'no-changes');
const haltedPlans = blockedPlans.filter((r) => r.status !== 'no-changes');
const HALT_STATUS = {
  'needs-user':      'BLOCKED (needs user input)',
  'dirty-baseline':  'BLOCKED (working tree was not clean — nothing was built)',
  'plan-unreadable': 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)',
  'inventory-empty': 'BLOCKED (a fix block printed no issue entries - check its planPath and block id; nothing was built)',
  'no-changes':      'halted (a fix block closed no issue - every entry was skipped or stale, and the ordered run stopped there)',
  'agent-dead':      'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)',
  'staging-unconfirmed': 'BLOCKED (the developer did not confirm its work stayed unstaged - the staged index is surface neither reviewer checks; inspect git diff --cached before resuming)',
  'passed-unstaged': 'BLOCKED (a block passed but was not staged — stage it, then resume)',
  'acceptance-regression': 'BLOCKED (a block staged while self-reporting a regression — inspect the staged diff before continuing)',
  'parked':          'halted (a block was parked — its work is saved to a patch; the blocks after it were not attempted)',
  'park-unsafe':     'BLOCKED (a parked block left the tree unsafe — inspect before resuming)',
  'budget':          'stopped on token budget (resume where it left off)',
};
const status = halted
  ? (HALT_STATUS[haltKind] || 'halted (a block needs attention)')
  : allDone
    ? 'done (all blocks staged)'
    : parkedPlans.length || blockedPlans.length
      ? `run complete with ${[
        parkedPlans.length ? `${parkedPlans.length} block(s) parked` : '',
        blockedPlans.length ? `${blockedPlans.length} block(s) blocked` : '',
      ].filter(Boolean).join(' and ')}`
      : 'partial slice complete';

log(`develop: ${status} — ${doneIds.length}/${pending.length} block(s) done [${ledger.reduce((s, r) => s + r.qualityRounds, 0)} quality pass(es)]`);

return {
  runId: RUN_ID,
  status,
  halted,
  haltReason: halted ? haltReason : '',
  regression: ledger.some((r) => r.regression),
  contestedDismissals: contestedTotal,
  stateDir: STATE_DIR,
  plansDone: doneIds,
  plansTotal: ALL_PLANS.length,
  sweep: sweep ? { complete: sweep.complete === true, gaps: (sweep.gaps || []).length, suite: sweep.suite_result || '' } : null,
  // true ONLY when the sweep ran and died. `sweep: null` on its own cannot say whether the check was
  // deliberately skipped (sweep:none, an incomplete goal) or lost — and those need different actions.
  sweepFailed,
  // Parked blocks: NOT done. patch follows rec.patch. A set strays needs a second restore step.
  parked: parkedPlans.map((r) => ({ id: r.id, mode: r.mode, patch: r.patch ?? null, strays: r.strays ?? null, status: r.status })),
  ledger,
  // One { planPath, id, key, value } edit per block this run finished and per fix entry whose status
  // changes. A block the run never reached has none.
  statusSync,
  reviewTrail,
  followups: `${halted ? `Run halted — ${haltReason}${haltKind === 'needs-user' ? ` Read ${NEEDS_USER} and the block's latest review file, resolve with the user, then re-invoke with the same args + startAt (or runOnly) for the blocks still to do. The tree is clean; whether that block's work is in a patch is stated below.` : ' '}` : ''}${sweepFailed
    ? `WARN THE USER FIRST: the final completeness sweep DIED, so nothing checked the goal was fully covered — re-run it or verify coverage against the goal yourself before trusting this as finished. `
    : ''}${parkedPlans.length
    ? `${parkedPlans.length} block(s) were PARKED: ${parkedPlans.map((r) => r.id).join(', ')}. ${patchedPlans.length
      ? `Work SAVED and cleared from the tree — nothing discarded — for: ${patchedPlans.map((r) => r.id).join(', ')} (each in ${STATE_DIR}/parked-<id>.patch; ${NEEDS_USER} carries its diagnosis and its \`git apply --3way\` restore command). `
      : ''}${emptyParkPlans.length
      ? `NO patch was written for: ${emptyParkPlans.map((r) => r.id).join(', ')} — those blocks had nothing to save (their working tree was already empty), so there is nothing to restore; read their diagnosis in ${NEEDS_USER}. `
      : ''}Per parked block the user decides: ${patchedPlans.length ? 'restore the patch and finish by hand, ' : ''}re-run it alone with runOnly after sharpening its block in the plan file, or drop it. `
    : ''}${noChangePlans.length
    ? `${noChangePlans.length} block(s) closed NO issue and are NOT done: ${noChangePlans.map((r) => r.id).join(', ')}. statusSync marks each blocked: read its entries' \`- decision:\` lines (only ACTIONABLE entries get fixed), then flip it back to todo. `
    : ''}${haltedPlans.length
    ? `${haltedPlans.length} block(s) halted and are NOT done: ${haltedPlans.map((r) => r.id).join(', ')} - the halt reason above says what each needs. `
    : ''}${amendedIds.length
    ? `PLAN AMENDED for: ${amendedIds.join(', ')}. The developer overrode a plan clause it verified prescribes a real defect — read ${STATE_DIR}/AMENDED-<id>.md (and the pointer lines in ${NEEDS_USER}) before you commit, and fold anything you agree with back into the plan file. `
    : ''}${sweep && sweep.complete !== true
    ? `The sweep reported goal-coverage gaps — read ${SWEEP_FILE}. `
    : ''}${doneIds.length ? `Staged/accepted: ${doneIds.join(', ')}. ` : ''}Verify the end state yourself: run the full gates, \`git -C ${REPO} diff --cached --stat\`, and \`git -C ${REPO} status --porcelain\` (should be clean). Read the numbered review files (acceptance-review-*.md in ${STATE_DIR}/, quality-review-*.md in ${GATE_DIR}/) and each DISMISSED-<id>.md in ${GATE_DIR}/, auditing every declined finding. Then derive the next launch's args with \`node '${BLOCK_TOOL.replace(/[^/\\]*$/, 'plan-edit.mjs')}' args <planPath>\`, which first folds this run's statuses into the plan file. Nothing is committed — you commit.`,
};
