export const meta = {
  name: 'develop-cycle',
  description: 'Plan-driven build engine, one approved plan FILE as the bus: implement the todo BLOCKS of that file — each a "## Plan: <id>" block the user approved — where the block\'s `mode` picks the frame the engine holds (feature = one bounded feature, wired in and reachable; section = one slice of a breadth-spanning goal, every call site converted; fix = a triaged issue inventory, every ACTIONABLE entry verified and closed). Per block: develop → BLIND pure-code review (must pass) → plan-aware acceptance + regression review (stages on pass), looped per round; the accepted baseline advances block by block. A block that does not accept within its round budget is PARKED — its work saved to a patch and cleared from the tree — after which an UNORDERED run CONTINUES and an ORDERED one STOPS (its later blocks depend on this one). Agents exchange messages as verbatim files; the harness only routes block ids, paths + verdicts.',
  whenToUse: 'Build the todo blocks of ONE approved plan file: bounded features (mode:"feature" — a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix), the ordered sections of a breadth-spanning goal (mode:"section" — a migration, upgrade, port, subsystem refactor), and/or triaged issue inventories (mode:"fix" — a block whose "### [<id>]" entries are the verified defects to close). The orchestrating agent authors the plan file OUTSIDE this engine (plan mode → the user approves), and the operator derives the args with `tools/plan-edit.mjs args <planPath>` and spreads the object it prints. Requires a CLEAN unstaged working tree; each accepted block is STAGED, never committed. Reuse one runId across resumes.',
  phases: [
    { title: 'Develop', detail: 'Developer reads its own block (verbatim, via the plan-block command) + the latest review that flagged issues; implements minimally, runs the gate, leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no spec, no goal), flags production-blocking defects, writes quality-review-<id>-rN.md. Must be clean to proceed. Skipped only for a block that has produced nothing AND has no review still open.' },
    { title: 'Acceptance', detail: 'Plan-aware gate: every acceptance criterion of THIS block met + reachable + the block gate satisfied + no regression. Writes acceptance-review-<id>-rN.md; on pass, STAGES that block (git add, never commit) — the accepted baseline advances.' },
    { title: 'Park', detail: 'On a block that did not accept within its round budget, or one the developer escalated: SAVES its work to parked-<id>.patch, then clears it from the tree. An UNORDERED run continues past a budget park or a needs-user escalation; an ORDERED run, or any other escalation, stops. Nothing is destroyed — NEEDS-USER.md carries the restore command.' },
    { title: 'Sweep', detail: 'Only when the plan file asks for it (sweep: goal-coverage) and every non-skip block is done: an independent agent re-greps the whole surface from the GOAL, runs the full gates, spot-checks the staged diff, writes SWEEP.md. Advisory — a dead sweep never halts.' },
  ],
};

// =============================================================================
// Config. Developer and acceptance read each block verbatim from its plan file (#2). Only the thin
// `plans` routing knobs, printed by `plan-edit.mjs args`, and the round number travel as control (#1/#8).
// =============================================================================
// A bare parse error names the runtime, not the payload the operator must fix.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
// Name the shape received: `plan-edit.mjs args` prints an object, so pasting it in whole is the likely mistake.
if (!A || !Array.isArray(A.plans) || !A.plans.length) {
  const shape = !A ? 'no args at all' : A.plans === undefined ? 'nothing' : Array.isArray(A.plans) ? 'an empty array' : A.plans === null ? 'null' : `a ${typeof A.plans}`;
  throw new Error(`args.plans must be a NON-EMPTY array of { id, planPath, mode, gate, status } entries; got ${shape}. "plan-edit.mjs args <planPath>" prints an object: spread it into the args, so its "plans" array lands here, not the object itself. There is no single-plan or inline-plan fallback.`);
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
// surfaced one deep defect per round on large diffs. Sweep is opus too: the runtime relays the launching
// user message to every agent, and a sonnet agent may follow it over its task.
const M  = { develop: 'opus', quality: 'opus', acceptance: 'opus', sweep: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// Every engine line goes through logLine: a bare log() escapes the budget and can push status lines past the cap.
const STATUS_LOG = 'status-sync ';
// Claude Code cuts a log line over 11,024 chars to its head and tail (measured in 2.1.287 to 2.1.289),
// so a status line stays within the 10,000 chars the runtime always keeps.
const STATUS_LINE_MAX = 10_000;
// Claude Code keeps only a run's first 1,000 log lines (measured in 2.1.287 to 2.1.289), and a failed or
// stopped run folds its statuses from those lines alone.
const LOG_CAP = 1_000;
// Progress lines stop here, so the lines left up to LOG_CAP go to status lines.
const LOG_BUDGET = 900;
let logCount = 0;
let logBudgetNoticed = false;
let statusPastCap = false;
function logLine(line) {
  if (line.startsWith(STATUS_LOG) || logCount < LOG_BUDGET) {
    if (logCount >= LOG_CAP) statusPastCap = true;
    logCount += 1;
    log(line);
    return;
  }
  if (logBudgetNoticed) return;
  logBudgetNoticed = true;
  logCount += 1;
  log(`develop: log budget of ${LOG_BUDGET} lines reached, progress lines suppressed, status lines continue`);
}
// Progress lines can still fill up to LOG_BUDGET before the next status line, and an unlogged notice takes one more.
const statusRoom = () => LOG_CAP - Math.max(logCount, LOG_BUDGET) - (logBudgetNoticed ? 0 : 1);

// Absolute, so every agent and git -C call is cwd-independent.
const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
// A long slug keeps a hash of its full form: two block ids sharing a 60-char prefix would otherwise share
// every run-state file, the DISMISSED ledger and the parked patch included.
const fnv1a       = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const slug        = (s) => {
  const full = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (full.length <= 60) return full;
  return `${full.slice(0, 51).replace(/-$/, '')}-${fnv1a(full)}`;
};
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo);                      // absolute path to the target git repo (required)
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
// The default for entries with no planPath, so undecorated `--list` rows work in the one-file case.
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
// Run-state inside the target repo puts the review and ledger files in the blind reviewer's reach (#3).
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  logLine(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the review/ledger files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
// The plan file has the same exposure (#3). Warn, not throw: a throw strands a run the operator may still
// want. Deduped because a one-file roadmap repeats one planPath on every entry.
const PLAN_PLACEMENT_WARNED = new Set();
const warnPlanPlacement = (p) => {
  if (!p || !REPO || PLAN_PLACEMENT_WARNED.has(p)) return;
  if (p !== REPO && !p.startsWith(REPO + '/')) return;
  PLAN_PLACEMENT_WARNED.add(p);
  logLine(`⚠ plan file (${p}) resolves inside the target repo — the blind quality reviewer could read the spec straight out of the repo tree, and the diff/park machinery could sweep it. Move the plan under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path — never one inside the target repo.`);
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
  throw new Error(`plans entries at index [${NO_ID.join(', ')}] are not objects carrying a string id. Every entry is a "plans" row that "plan-edit.mjs args <planPath>" prints — { id, planPath, mode, gate, status } — optionally with its own planContext.`);
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
  throw new Error(`plans [${NO_PATH.join(', ')}] carry no planPath and there is no top-level planPath to default to — the developer would be handed an empty plan reference. Derive the args with "plan-edit.mjs args <planPath>" and spread the object it prints: every row it prints carries its planPath.`);
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
// A second park renames the first patch here. A slug holds no dot, so no block's own patch matches.
const parkedPrevPatch = (id) => `${STATE_DIR}/parked-${slug(id)}.prev<n>.patch`;
const SWEEP_FILE     = `${STATE_DIR}/SWEEP.md`;                 // final whole-goal completeness sweep
// A closed inventory is what lets a fix loop converge, so an issue found mid-run waits for the user's triage.
// One fixed file per source block, so its triage never waits on another block's relaunch.
const newIssuesFile  = (id) => `${ROOT}/plans/${RUN_ID}/NEW-ISSUES-${slug(id)}.md`;

// Settled decisions, never prior reviews, which would anchor them (#5). canContest=true is the blind
// reviewer: the contest channel and DISMISSED alone (see GATE_DIR). Acceptance overrides instead.
const SETTLED = (id, canContest = true, round = 0) => `Before reviewing, READ ${canContest ? 'this if it exists. It holds' : 'these if they exist. They hold'} the settled decisions:
  • ${dismissedFile(id)} — findings the developer declined for THIS block, each with a one-line reason.${round === 1 ? `
    In round 1 it exists only if the developer already declined something (or on a resume). A missing
    file means nothing is settled yet, so do not search for it elsewhere.` : ''}${canContest ? '' : `
  • ${NEEDS_USER} — items already escalated to the user.`}
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files. Review the CURRENT
diff FRESH, catching new or nearby issues and re-verifying earlier fixes independently.${canContest ? `
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
    ? ['plan_obtained', 'baseline_dirty_files', 'results', 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user', 'plan_amendments']
    : ['plan_obtained', 'baseline_dirty_files', 'produced', 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user', 'plan_amendments'],
  properties: {
    plan_obtained:     { type: 'boolean', description: 'true if you HAVE your block text: the plan-block command exited 0 and printed it, or (ONLY when handed a plan file rather than a command) you read that file. A failed command means FALSE. Never fall back to locating your block by eye in the plan file. FALSE halts the run.' },
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files had UNSTAGED or untracked changes BEFORE you touched anything (staged files never count). 0 = clean, >0 HALTS the run. Report -1 on later rounds.' },
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
          },
        },
      },
    } : {
      produced:        { type: 'boolean', description: 'true if you changed or added at least one file this round' },
    }),
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed', 'failed-expected', 'failed-unexpected', 'not-run'], description: 'passed = the required verification ran and PASSED. failed = it ran and failed. failed-expected = a red baseline exactly as a test-first block intends. failed-unexpected = failed for a WRONG reason (a real defect / bad fixture). not-run = no verification executed.' },
    tests_run_count:   { type: 'integer', description: 'the count of tests, or of assertions for a runner that counts those, the runner REPORTS as executed for this block\'s run (0 = nothing ran = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    full_suite_outcome:{ type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened. "scoped-skip" when this run is scoped to each block\'s own selector.' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q", "phpunit --filter Bar", "curl localhost:3000/health"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add -N on new files only). Anything you staged is reviewed by NOBODY: say false rather than claim it. False HALTS the run.' },
    needs_user:        { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to this block\'s DISMISSED file this round (0 if none)' },
    // Required, unlike dismissed_count: an omitted field must not read as "none this round".
    plan_amendments:   { type: 'integer', description: 'entries you appended to this block\'s AMENDED file this round (MATRIX 6a). Report 0 when there were none.' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
});

const QUALITY_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'clean', 'issue_count'],
  properties: {
    wrote_file:  { type: 'boolean', description: 'true ONLY if you wrote your review file this round' },
    clean:       { type: 'boolean', description: 'true if NO production-blocking defects were found in the unstaged diff' },
    issue_count: { type: 'integer', description: 'number of production-blocking defects written to the review file' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED entries you re-raised as "CONTESTS DISMISSAL:" this round (0 if none)' },
  },
};

const acceptanceSchema = (mode) => {
  // Per mode, because the descriptions are each frame's acceptance contract.
  // `|| {}` lets tests/static.test.mjs evaluate the schema with no mode to read its field names.
  const terms = {
    feature: {
      pass: 'true if every acceptance criterion is met, the feature is reachable, gates are green, and nothing regressed',
      staged: 'true if you ran `git add` on this block\'s files, or on a LEGITIMATE NO-OP pass whose diff is empty (only on pass; NEVER commit)',
      reachable: 'the feature is actually wired in / reachable from the app entry points',
      criteriaFrom: 'THIS block',
      suite: 'observed outcome of running the FULL gates',
    },
    section: {
      pass: 'true if every acceptance criterion of THIS block is met, it is reachable, the block gate is satisfied, and nothing regressed',
      staged: 'true if you ran `git add` on this block\'s files, or on a LEGITIMATE NO-OP pass whose diff is empty (only on pass; NEVER commit)',
      reachable: 'this block\'s change is actually wired in / reachable — every call site converted, route mounted, symbol exported',
      criteriaFrom: 'THIS block',
      suite: 'observed outcome of running the block gate (and, where the goal expects it, the full gates)',
    },
    fix: {
      pass: 'true if every claimed fix fully closes its root cause, every STALE claim is confirmed absent from the current code, no entry outside the ACTIONABLE set was touched, the gate is green, and nothing regressed',
      staged: 'true if you ran `git add` on this block\'s files, or on a LEGITIMATE NO-OP pass whose diff is empty (only on pass; NEVER commit)',
      suite: 'observed outcome of running the FULL gates',
    },
  }[mode] || {};
  return {
    type: 'object',
    required: mode === 'fix'
      ? ['plan_obtained', 'wrote_file', 'pass', 'staged', 'fix_checks', 'new_issues', 'new_issue_blocks']
      : ['plan_obtained', 'wrote_file', 'pass', 'staged', 'reachable', 'criteria_total', 'criteria_met', 'evidence_recorded'],
    properties: {
      plan_obtained: { type: 'boolean', description: 'true if you HAVE the block text you judge against: the plan-block command exited 0 and printed it, or (ONLY when handed a plan file rather than a command) you read that file. A failed command means FALSE. Never fall back to locating the block by eye. FALSE halts the run.' },
      wrote_file:  { type: 'boolean', description: 'true ONLY if you wrote your review file this round' },
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
            },
          },
        },
        new_issues: { type: 'integer', description: 'entries you appended this round to the NEW-ISSUES-<block id>.md files your prompt names (0 if none)' },
        new_issue_blocks: { type: 'array', items: { type: 'string' }, description: 'the id of every block whose NEW-ISSUES-<block id>.md file you appended to this round ([] if none)' },
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
    saved:       { type: 'boolean', description: 'true ONLY if the patch file was written and you confirmed it is non-empty. If false over a non-empty diff, you must NOT have cleared the tree.' },
    cleared:     { type: 'boolean', description: 'true if `git diff` is empty after step 2, including a diff that was already empty' },
    gates_green: { type: 'boolean', description: 'true if the BUILD gate passes again after clearing (the tree is safe for what comes next)' },
    patch_bytes: { type: 'integer', description: 'size of the written patch file — 0 means nothing was saved' },
    notes:       { type: 'string' },
  },
};

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'complete', 'gap_count'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true ONLY if you wrote the sweep file' },
    complete: { type: 'boolean', description: 'true if no goal-coverage gaps were found' },
    gap_count: { type: 'integer', description: 'the number of gaps you wrote to the sweep file, 0 when none' },
    suite_result: { type: 'string', description: 'observed outcome of running the FULL gates (or why they were not run)' },
  },
};

// =============================================================================
// Shared prompt fragments + decision matrix (developer-owned)
// =============================================================================
const ENV = `${GOAL ? `GOAL (this run's ONE goal, split into the plan file's blocks): ${GOAL}\n` : ''}TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
${REFERENCE_P ? `REFERENCE (a COMPLETED example to mirror for the canonical pattern): ${REFERENCE_P}\n` : ''}CONVENTIONS (match these): ${CONVENTIONS}
GATES (the commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
BE TOKEN-ECONOMICAL: read ONLY the files this block touches plus the SPECIFIC reference/plan text you
need, never the whole tree, plan file or reference. Prefer targeted grep over broad reads. Do not
restate large files back.`;

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
  1. Not a real problem / false positive → DROP + LOG.
  2. Pre-existing in untouched code (not yours) → DROP silently. Never fix it (regression risk).
  3. Stops the build/tests/verification → FIX (always).
  4. A real, clear, in-scope fix (local, small) → FIX.
  5. Needed to satisfy the spec / wire this block in → FIX (an unreachable or incomplete block is not done).
  6a. Conflicts with the plan AND you VERIFIED that what the plan PRESCRIBES is itself defective (you
      reproduced it, or demonstrated the failure path, to the same evidence bar as any FIX)
      → FIX it: the verified defect outranks the prescription. LOG an amendment.
      PRECEDENCE — that verified defect also outranks the "${SCOPE_LINE[mode]}"
      instruction above and the CONVENTIONS rubric. Everywhere else the plan and the conventions
      still bind.
  6b. Conflicts with the plan but you did NOT verify it / intentional / not a real-world code path
      → DROP + LOG.
  7. A genuine DESIGN/BUSINESS choice only the USER can make, OR a blocker you cannot resolve in scope
      → ESCALATE + LOG.
  8. Anything else (style, medium/low polish, a different block's work) → DROP silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. NEVER log the same dismissal twice.
  • A REGRESSION the acceptance review counted is a bug, so never DROP it under 1 or 6b. FIX it (4, 5 or
    6a), or ESCALATE it (7) with the default you took when the fix needs major changes outside this
    block's scope.

LOGGING is your ONLY output besides code. Keep it minimal and unambiguous:
  • DROP (1 or 6b): append ONE terse line to ${dismissedFile(id)}:
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
    The blind reviewer cannot read the plan, so the reason must be decidable from the code alone: never
    cite a plan id, block id, issue id or plan clause.
  • AMEND (6a): append ONE entry to ${amendedFile(id)}:
      \`## Plan amendment: ${id} r${round}\`
      then the plan clause you overrode (QUOTED verbatim), the defect (file:line + one line on why it is
      real), and what you built instead.
    Then append ONE POINTER line to ${NEEDS_USER}: the block id, the round, the defect's file:line, and
    the path ${amendedFile(id)}, with NO plan text. Count every entry you wrote in plan_amendments.
  • ESCALATE (7): append a FULL, self-contained entry to ${NEEDS_USER} (all the detail the user needs
    to decide). If you CANNOT proceed without the answer, set needs_user=true (this block stops and is parked).
    If you can proceed with a defensible default, record it there too, leave needs_user=false, AND
    append ONE terse line to ${dismissedFile(id)} in the DROP shape above, its reason
    \`ESCALATED: <the default you took, ≤15 words>\`, because the blind reviewer is NOT shown ${NEEDS_USER}
    and would re-raise your default every round until this block parks.
This is NOT a general code review. Make THIS block correct, testable and production-safe, leave the
lines you TOUCH a little better, and touch nothing else.`;

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
   weaken/delete tests to get green. SANITY-CHECK the runner really executed your unit tests.
3. ${staging}
4. ${MATRIX(p.id, round, p.mode)}
Return ONLY the decision fields via the schema (no prose report).`;

const sectionDevelop = (p, round, { opening, ledgerNote, staging }) => {
  const gateExpectation = p.gate === 'red-baseline'
    ? 'red-baseline — AUTHOR this block\'s tests; they MUST FAIL because the code is not converted yet. Report test_outcome="failed-expected" once they run and fail for the RIGHT reason (asserting the not-yet-built target behavior), or "failed-unexpected" if they fail for a wrong reason (parse error, missing fixture).'
    : p.gate === 'build-only'
      ? 'build-only — no test pass/fail requirement; just keep the build green.'
      : 'green — this block\'s selector tests must RUN and PASS (test_outcome="passed").';
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
   scoped to this block (use the block's \`test_selector:\` line when it has one, else the test gate):
   ${GATES.test ?? '(no test gate configured)'}. Never weaken/delete tests to get green. SANITY-CHECK
   the runner really executed your unit tests. Some runners silently ignore extra path args, so when in
   doubt run one file per invocation or use the runner's --filter.
3. ${SUITE_LINE} Build/lint must always pass.
4. ${staging}
5. ${MATRIX(p.id, round, p.mode)}
Return ONLY the decision fields via the schema (no prose report).`;
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
1. VERIFY-FIRST: the entries come from a PAST snapshot. For EACH, read the CURRENT code and confirm the
   issue still exists. If it is already fixed or no longer applies, record it STALE. Never "fix" what
   isn't there. STALE means someone ELSE closed it before this run: an entry YOU fixed in an earlier
   round of this block stays FIXED every round, since its diff is still unstaged and still has to be
   verified.
2. FIX ONLY the entries whose \`- decision:\` line says ACTIONABLE. Leave every other entry (SKIP,
   NEEDS_USER, DEFER, anything else) UNTOUCHED and record it SKIPPED: that triage is the user's call.
   Apply each confirmed fix per its **Fix:** instruction, matching the surrounding style. Where a fix
   warrants a pinning test, write it. Never weaken or delete existing tests to make the gate pass. Never
   disable lint rules.
3. RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: ${GATES.test ?? '(no test gate configured)'}.
   ${SUITE_LINE} SANITY-CHECK the runner really executed the tests. If a fix breaks the gate and you
   cannot resolve it within THAT fix's own scope, revert that change surgically, record the entry FAILED
   with the reason, and keep the rest.
4. ${staging}
5. ${MATRIX(p.id, round, p.mode)}
Return ONLY the decision fields via the schema (no prose report).`;

const DEVELOP_FRAME = { feature: featureDevelop, section: sectionDevelop, fix: fixDevelop };

// The restore follows the clean-baseline check, so the restored diff is the only unstaged work.
const continueOpening = (p) => `CONTINUE from this block's
parked patch instead of implementing it from scratch:
  a. Run \`git -C ${REPO} diff --cached --stat\` and keep its output.
  b. Restore the patch with a PLAIN \`git -C ${REPO} apply ${parkedPatch(p.id)}\`, never with \`--3way\`,
     \`--index\` or \`--cached\`: each of those stages the restored work into the accepted baseline.
  c. Run \`git -C ${REPO} add -N -- <file>\` on each new file the patch created
     (\`git -C ${REPO} status --porcelain\` lists it as \`??\`).
  d. Confirm \`git -C ${REPO} diff --cached --stat\` is the same as the output step a kept.
  e. READ the latest \`## Parked block: ${p.id}\` entry in ${NEEDS_USER} and the review file that entry
     names, then continue from the restored work.
The restored diff is THIS block's own unstaged work. ${p.mode === 'fix'
    ? 'Report every entry the restored work closes as FIXED, never STALE.'
    : 'Report produced=true.'}
If ${parkedPatch(p.id)} is missing or \`git apply\` fails, confirm \`git -C ${REPO} diff\` is empty and that
no file you created remains (a failed plain \`git apply\` changes nothing). Append an entry to
${NEEDS_USER} naming ${parkedPatch(p.id)} and the apply error, set needs_user=true and STOP.`;

const developPrompt = (p, round, reviewPath) => {
  // Identical in every frame — only the task lines in DEVELOP_FRAME switch on mode.
  const opening = round === 1
    ? `ROUND 1 — STEP 0, BEFORE you read the plan or touch any file: CONFIRM THE BASELINE IS CLEAN. Earlier
ACCEPTED blocks are STAGED (the accepted baseline). The UNSTAGED tree must be EMPTY, because everything
unstaged at the end of this round is judged as YOUR work.
  \`git -C ${REPO} diff --name-only\` (unstaged tracked edits)
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` (untracked files, which \`git diff\` OMITS)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (do NOT count
staged-only entries). If it is NOT 0, STOP RIGHT THERE: change nothing, write nothing, and return
immediately with that count. The run halts for the operator. If it IS 0, ${CONTINUE.has(p.id)
      ? continueOpening(p)
      : 'implement this block from\nscratch on top of the staged baseline.'}`
    : `${reviewPath
      ? `A prior review flagged issues — READ ${reviewPath} and resolve exactly those. Your earlier work is
already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
      : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working
tree: re-run the gate (below) and fix what fails. Build ON it, do NOT revert it.`}
Report baseline_dirty_files=-1.`;
  // Every round, round 1 included: the ledger persists across resumes.
  const ledgerNote = `If ${dismissedFile(p.id)} exists, READ it first: your ledger of declined findings for THIS
block. Do not duplicate or re-litigate an entry.`;
  const staging = `LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file
   you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add, so reviewers' \`git diff\` sees it;
   it does not stage content). Set unstaged_confirmed=true. Anything YOU stage is reviewed by nobody
   and HALTS the run.`;
  return DEVELOP_FRAME[p.mode](p, round, { opening, ledgerNote, staging });
};

// BLIND: no plan, spec, goal or criteria, so one frame serves every mode.
const qualityPrompt = (p, round) => `
You are a CODE CRITIC. You have NO information about what this code is for or should do, and no plan,
spec or goal. Do not seek any. Judge the code PURELY ON ITS OWN MERITS.
Never open a plan file, an issue inventory, or any run-state path outside ${GATE_DIR}/.
TARGET REPO: ${REPO}
GATES — already ran before you were spawned, and a later stage re-runs them before anything is staged.
Never run them in full. Run the test command only for ONE targeted test that confirms a suspected defect.
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}

${SETTLED(p.id, true, round)}

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`: unstaged tracked changes, the work to review. On a large diff run
  \`git -C ${REPO} diff --stat\` first, then read it file by file.
  \`git -C ${REPO} status --porcelain\` then READ every untracked file (\`??\`) — \`git diff\` OMITS those.
  A \` A\` entry (intent-to-add) is a new file \`git diff\` already shows in full. A first-column \`A\` or
  \`M\` is STAGED: the staged half of an \`AM\` or \`MM\` file is baseline, and only its unstaged half
  (\`git -C ${REPO} diff -- <file>\`) is this cycle's work.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline — context only, do NOT review it.

Report ONLY production-blocking defects INTRODUCED by this diff: real correctness/security/
data-integrity/error-handling/resource/concurrency/api-contract bugs, or anything that breaks the
build or tests. DROP silently: anything pre-existing in the baseline, style, naming, medium/low
polish, speculation, redesigns. An EMPTY result is the normal, GOOD outcome.

A hunk that changes ONLY comments, string text or documentation has three checkable defects: a change
to executable code (\`git -C ${REPO} diff --word-diff\` shows each hunk's exact tokens), a path, command,
identifier or file the new text names that does not exist, and a sentence the change removed that other
text still refers to. Whether the wording reads well is out of scope.

WRITE your findings to ${qualityFile(p.id, round)} (create ${GATE_DIR}/ if needed): one section per defect
— file:line, what's wrong, why it's production-blocking, a concrete fix. If none, write exactly
"No production-blocking defects found." Then return wrote_file (true ONLY if you wrote that file) + clean
(true if NO findings, including no contests) + issue_count + contested_dismissals via the schema. Do NOT
modify source, stage, or commit.`;

// A pass member's file holds only harms its own entries list, so each block's file is triaged on its own.
const newIssueRoute = (p) => p.blocks
  ? `only to the file of the block whose entry lists the harm, never to your review file:
${p.blocks.map((b) => `     - ${b.issues.join(', ')} → ${newIssuesFile(b.id)} (block "${b.id}")`).join('\n')}
   Count it in new_issues and name that block in new_issue_blocks.`
  : `to ${newIssuesFile(p.id)} only, never to your review file. Count it in new_issues and name
   "${p.id}" in new_issue_blocks.`;

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
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. A dismissed item that
actually leaves a claimed fix incomplete or causes a regression OVERRIDES the dismissal: fail
acceptance for it and record it in your review file. An \`ESCALATED:\` line is a decision
routed to the user: hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a
held escalation never fails acceptance. Name it in your file as held.

AMENDMENTS: READ ${amendedFile(p.id)} if it exists. It records **Fix:** instructions the developer
OVERRODE after verifying the instruction itself prescribes a real defect. Judge an issue whose
instruction was amended against the AMENDED behavior, not the superseded one, and NAME every issue you
judged under an amendment in your review file. An amendment entry that states NO defect evidence excuses
NOTHING: that issue stays actually_fixed=false.

EVERY DEFECT YOU WRITE IN YOUR REVIEW FILE COUNTS. A gap is a claimed fix with a residual path
(actually_fixed=false), an unconfirmed STALE claim, an ACTIONABLE entry reported SKIPPED, a touched entry that is not ACTIONABLE,
a non-empty diff with no FIXED claim, a gate not satisfied, or a regression. A
regression is any behavior the staged baseline (HEAD when nothing is staged) gave a caller or input, a
third-party one included, that this cycle's diff breaks or changes without an ACTIONABLE entry
requiring it. A test the gate step's suite rule allows to be red is not a regression. Count each one,
even when an entry's **Fix:** prescribes the construction that causes it, and even when you judge the
path rare, inherent, or unreached by any current caller. Those calls are the developer's, never yours.
The developer fixes it, with an amendment when an entry's **Fix:** prescribes it, or escalates it when
the fix needs major changes outside this block's scope. Once the developer's ledger holds one, the
OVERRIDE rule above governs it. Drop any other concern silently, except a new issue (step 1). Your
file holds no notes, observations or non-blocking section.

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
   with the identical defect), that is actually_fixed=false — EVEN IF the described edit was made — and
   its residual path goes in your review file at step 5. Return one fix_check per claimed issue.
   A harm an entry lists can come from a DIFFERENT mechanism: a cause that shares no code path with the
   root cause you re-derived. That harm is a NEW ISSUE, not a residual path. A sibling path, caller or
   branch with the identical defect is always a residual path, and when unsure, treat it as one. Append a
   new issue ${newIssueRoute(p)} It sets no
   fix_check false, and it never excuses a regression or an unsatisfied gate. A new file starts with the
   four lines "## Plan: ${p.blocks ? '<that block\'s id>' : p.id}-new-issues - issues found outside the fixes' root causes",
   "mode: fix", "gate: green" and "status: todo", then a blank line. Before you append, read every
   existing NEW-ISSUES-*.md in ${ROOT}/plans/${RUN_ID}/ and never append a harm any of them already holds.
   Each entry copies the shape of the block's own entries, with the id "<source issue id>-new-<n>"
   (n one past that source's highest), "- status: open" and "- decision: NEEDS_USER", so that the user
   triages it before anything fixes it.
   The developer reports these issues STALE (already absent from the current code):
${claimedStale.map((id) => `     - ${id}`).join('\n') || '     (none reported stale)'}
   For EACH, read its full entry and confirm against the CURRENT code that the defect is truly absent.
   Return a fix_check for it too. A STALE
   claim you cannot confirm is actually_fixed=false and fails acceptance exactly like an unclosed FIXED claim.
2. TRIAGE HELD. Confirm the diff touched NOTHING on behalf of an entry whose \`- decision:\` is not
   ACTIONABLE. A fix applied to one fails acceptance even when the code change looks right, since that
   entry is the user's call. The developer reports these issues SKIPPED:
${reportedSkipped.map((id) => `     - ${id}`).join('\n') || '     (none reported skipped)'}
   Confirm each one's \`- decision:\` is genuinely not ACTIONABLE: an ACTIONABLE entry reported SKIPPED is
   an issue left open, and it fails acceptance.
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-accepted
   behavior was changed or broken.
4. Run the FULL gates (GATES above) once and record the real outcome.
   ${ACC_SUITE_LINE} If a configured MCP/tool is unavailable here, say so in the file (do not fake it)
   and return pass=false.
5. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE step 6: the
   per-issue root-cause verdict (with the residual path for any incomplete one), the triage-held result,
   the regression result, the gate output, and each gap — or "All fixes close their root cause; triage
   held; no regression."
6. DECIDE:
   • Every claimed fix complete, every STALE claim confirmed, no non-ACTIONABLE entry touched, gate
     green, no regression →
     \`git -C ${REPO} add <this block's changed AND newly-created files>\` (NEVER commit); return
     pass=true, staged=true.
   • LEGITIMATE NO-OP: if every entry was genuinely STALE or non-ACTIONABLE and the diff is empty, that is
     a valid pass — return pass=true AND staged=true (nothing to add). Say so in your file. Do NOT
     invent changes to justify it.
   • NO FIXED CLAIM, NON-EMPTY DIFF: when the FIXED list in step 1 is empty, no blind reviewer judged the
     tree, so the unstaged diff MUST be empty. Any change there fails acceptance: name the files in your
     file and return pass=false.
   • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.
Return wrote_file=true ONLY if you wrote ${acceptanceFile(p.id, round)} this round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;

const planAcceptance = (p, round, { reviewSkipped }) => {
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
    : `Run the FULL gates (GATES above) once and record the real outcome.
   Re-run the plan's configured verification method to confirm the feature behaves as specified.
   ${ACC_SUITE_LINE} If a configured MCP/tool is unavailable here, say so in the file (do not fake it)
   and return pass=false.`;
  return `
You are the ACCEPTANCE VERIFIER — the final, plan-aware gate for ONE block. The blind code review already
passed (or was skipped because the developer changed nothing). Read ${planRef(p)}. You judge the work
against that block; you never implement it.
${ENV}
BLOCK: ${p.id}   (mode: ${p.mode}, gate: ${p.gate})

${SETTLED(p.id, false)}
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. A dismissed item that
ACTUALLY breaks one of this block's acceptance criteria, leaves it unreachable, or causes a regression
OVERRIDES the dismissal: fail acceptance for it and record it in your review file.
An \`ESCALATED:\` line is a decision
routed to the user: hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a
held escalation never fails acceptance. Name it in your file as held.

AMENDMENTS: READ ${amendedFile(p.id)} if it exists. It records plan clauses the developer OVERRODE after
verifying the clause itself prescribes a real defect. Judge a criterion whose prescribing clause was
amended against the AMENDED behavior, not the superseded clause, and NAME every criterion you
judged under an amendment in your review file. An amendment entry that states NO defect evidence excuses
NOTHING: that criterion stays UNMET.

EVERY DEFECT YOU WRITE COUNTS. A gap is a criterion not met, a change not reachable, a gate not
satisfied, or a regression. A regression is any behavior the staged baseline (HEAD when nothing is
staged) gave a caller or input, a third-party one included, that this cycle's work breaks or changes
without a criterion of this block requiring it. A test the gate step's suite rule allows to be red is
not a regression. Count each one, even when this block's own text prescribes the construction that
causes it, and even when you judge the path rare, inherent, or unreached by any current caller. Those
calls are the developer's, never yours. The developer fixes it, with an amendment when this block's own
text prescribes it, or escalates it when the fix needs major changes outside this block's scope. Once
the developer's ledger holds one, the OVERRIDE rule above governs it. Drop any other concern silently.
Your file holds no notes, observations or non-blocking section.

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  \`git -C ${REPO} diff --staged\` = accepted baseline (compare against it for regressions).

PROCEDURE:
1. ENUMERATE THIS block's acceptance criteria FIRST, numbered — that count is criteria_total (never 0 for
   a real block). For EACH, find concrete evidence it holds (a diff hunk, a passing test, an observed
   behavior) and mark it met / not-met with a file:line / test-name / command-output LOCATOR;
   criteria_met = how many hold. evidence_recorded=true only if EVERY met criterion carries such a
   locator in your review file. A criterion asserted without one is not met.
2. ${reachStep}
3. REGRESSION: compare the unstaged diff against the staged baseline; confirm no previously-accepted
   behavior was changed or broken.
4. ${gateStep}
5. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE step 6: the
   numbered per-criterion table WITH its locators, the reachability + regression result, the gate
   output, and each gap (title + file:line + fix) — or "All criteria met; reachable; no regression."
6. DECIDE:
   • All criteria met, reachable, gate satisfied, no regression → \`git -C ${REPO} add <this block's
     changed AND newly-created files>\` (NEVER commit); return pass=true, staged=true.
   • LEGITIMATE NO-OP: if this block genuinely requires NO code change because the staged baseline
     already satisfies every one of its criteria, that is a valid pass — return pass=true AND staged=true
     (nothing to add). Say so in your file. Do NOT invent changes to justify it.${reviewSkipped ? `
   • NO CHANGES REPORTED, NON-EMPTY DIFF: no blind reviewer judged the tree because the developer
     reported no changes, so the unstaged diff and the untracked files MUST be empty. Any change there
     fails acceptance: name the files in your file and return pass=false.` : ''}
   • Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.
Return wrote_file=true ONLY if you wrote ${acceptanceFile(p.id, round)} this round.
Do NOT modify source code. Return ONLY the decision fields via the schema.`;
};

const ACCEPTANCE_FRAME = { feature: planAcceptance, section: planAcceptance, fix: fixAcceptance };

const acceptancePrompt = (p, round, claimedFixed = [], claimedStale = [], reportedSkipped = [], reviewSkipped = false) =>
  ACCEPTANCE_FRAME[p.mode](p, round, { claimedFixed, claimedStale, reportedSkipped, reviewSkipped });

// Only needs-user writes a NEEDS-USER entry, so every other halt names its own cause for park to cite.
const parkReason = (haltKind) => ({
  'needs-user': `the developer escalated a user-only decision (see ${NEEDS_USER})`,
  'agent-dead': 'an agent returned nothing (skipped or died)',
  'plan-unreadable': 'an agent could not obtain its plan',
  'staging-unconfirmed': `the developer did not confirm its work stayed unstaged; inspect \`git -C ${REPO} diff --cached\` for self-staged work`,
  'rejected-staged': `acceptance rejected the block but staged it anyway; inspect \`git -C ${REPO} diff --cached\` and unstage this block's files`,
  'review-unwritten': 'a reviewer reported a failing verdict but did not confirm writing its review file',
  'passed-regression': 'acceptance passed the block but flagged a regression and staged nothing, so its work must never be staged as it is',
}[haltKind] || `the run halted (${haltKind || 'unknown halt'})`);

const parkPrompt = (p, lastReviewPath, escalated, haltKind, stopsRun) => `
You are PARKING the plan block "${p.id}", which ${escalated
    ? `was halted: ${parkReason(haltKind)}`
    : 'did NOT reach acceptance within its round budget'}. SAVE its work to a patch, then clear it from
the tree${stopsRun
    ? `. The run stops after you (${escalated ? 'only the user can unblock it' : 'the blocks after this one depend on it'}), so leave the repo in a
known, buildable state the user can come back to`
    : ` so the REST OF THE RUN can continue: leftover work would fail the next block's blind review, which
scopes on the unstaged diff`}.
${ENV}
STAGING CONTRACT:
  • staged index + HEAD  = ACCEPTED blocks (the baseline). Treat as known-good; do NOT touch.
  • unstaged working tree = THIS block's unsuccessful work — the only thing you save and clear.
  • Nothing is EVER committed.

SAVE BEFORE YOU CLEAR. If the unstaged diff is NOT empty and step 1 cannot
produce a non-empty patch, STOP: leave the tree exactly as it is, the intent-to-add entries step 1 made
included, and return saved=false, cleared=false.
An already-empty diff is not a stop: step 1 says what to do.

PROCEDURE:
1. SAVE. \`git -C ${REPO} status --porcelain\` first. Mark each \`??\` untracked path this block created
   intent-to-add with \`git -C ${REPO} add -N -- <path>\`, so the patch carries it. Skip build output and
   caches. Only then check \`git -C ${REPO} diff\`. If it is EMPTY there is no patch to write — skip the
   patch write, return saved=false, patch_bytes=0, with a note saying so, and continue at step 2.
   Otherwise, if ${parkedPatch(p.id)} already exists, RENAME it to ${parkedPrevPatch(p.id)},
   with n one past the highest existing .prev<n> number for this block, or 1 when none exists.
   Never overwrite or delete either patch. Then write the block's work to ${parkedPatch(p.id)}
   (create ${STATE_DIR}/ if needed):
     \`git -C ${REPO} diff --binary > ${parkedPatch(p.id)}\`
   \`--binary\` is REQUIRED: a plain diff cannot re-apply binary files. The unstaged diff IS exactly this
   block's work, and every file it created is in it via \`git add -N\`.
   Then CONFIRM the file exists and is non-empty, and record its size as patch_bytes.
2. CLEAR. Restore every tracked file this block modified to the staged baseline:
   \`git -C ${REPO} checkout -- <files>\`. Remove each \`git add -N\` intent-to-add file it CREATED, the
   ones step 1 marked included, with \`git -C ${REPO} rm -f -q -- <file>\`: that drops the index entry
   and the file together. Deleting the file alone leaves the entry, and \`git diff\` stays non-empty.
   Always name the files: an unpathed \`git reset\` or \`git rm\` touches the staged baseline. An
   intent-to-add file is safe to remove because the step 1 patch carries it.
   Confirm \`git -C ${REPO} diff\` is EMPTY, then run the BUILD gate and record whether it is green.
3. RECORD. Append ONE entry to ${NEEDS_USER}, under a \`## Parked block: ${p.id}\` heading:
   - that this block is **NOT done and NOT abandoned — a status record, not a dismissal**${stopsRun
    ? `, and that the blocks after it were NOT attempted${ORDERED ? ', because they depend on this one' : ''}`
    : '; the remaining blocks continued without it'}
   - one line on why it was parked (${escalated ? parkReason(haltKind) : 'what acceptance was still failing'})
   - ${lastReviewPath ? `the diagnosis: \`${lastReviewPath}\`` : `that this block left no review file to cite; point the user at the run trail in ${STATE_DIR} instead of naming a file`}
   - when step 1 saved a patch, the saved work \`${parkedPatch(p.id)}\` and the restore command, verbatim:
     \`git -C ${REPO} apply ${parkedPatch(p.id)}\`. Say that it restores the work UNSTAGED, with new
     files untracked, and that \`--3way\`, \`--index\` and \`--cached\` would each stage it into the accepted
     baseline. When step 1 renamed an earlier patch, one more line naming the \`.prev<n>.patch\` path
     where that earlier attempt's patch now lives. When the diff was already empty, in their place the
     line "Saved work: none (the tree held no changes)", and, when ${parkedPatch(p.id)} already exists,
     a line naming it as this block's earlier saved work.
   - how to resume: fix the blocker (sharpening this block in the plan file if needed). Once
     \`plan-edit.mjs args\` has applied this run's statuses, set this block's \`status:\` back to \`todo\`
     in its plan file. Then re-invoke with \`runOnly:["${p.id}"]\` from the CLEAN baseline and let the
     developer redo it — the default, with the patch kept for reference. To continue from the patch
     instead, add \`continueParked:["${p.id}"]\` to that relaunch: its round-1 developer restores the
     patch after the clean-baseline check, and the block runs under full review. Do NOT tell the user to
     \`git add -A\` the restored work: that folds UN-reviewed code into the accepted baseline.
Do NOT modify any file outside this block's work.
Return saved + cleared + gates_green + patch_bytes via the schema.`;

const sweepPrompt = (doneIds) => `
You are the FINAL COMPLETENESS SWEEP. Every block is done and its work is STAGED. Verify, against the
repo itself, that the GOAL is fully achieved. Find what the plan MISSED. Do not re-review accepted work.
Read the approved plan file(s) VERBATIM and IN FULL (ENV's never-the-whole-plan-file rule does not apply to
this role): ${PLAN_FILES.join(' , ')}.
${ENV}
COMPLETED BLOCKS: ${doneIds.join(', ')}

PROCEDURE (read-only except step 4):
1. RE-DERIVE the change surface from the GOAL: grep the target repo for every pattern/API/symbol the goal
   replaces or touches. Any hit that should have been converted but wasn't = a gap. Record hit counts.
2. Run the FULL gates (GATES above) once and record the real outcome. If the GOAL implies whole-suite
   green at the end, a red suite is a gap; if a red tail is expected, say which failures look expected
   vs surprising.
3. Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): does it plausibly cover every
   block's acceptance? Look for suspiciously-untouched areas the GOAL names.
4. WRITE ${SWEEP_FILE}: the suite result, then each gap (title + file:line evidence + a suggested
   follow-up block) — or "No gaps found." Do NOT modify source code, stage, or commit.
Report ONLY material, in-GOAL gaps — not improvements, not pre-existing issues. Return via the schema,
with wrote_file=true ONLY if you wrote ${SWEEP_FILE}, and gap_count = the number of gaps you wrote to it
(0 when none). Each gap's detail goes only in ${SWEEP_FILE}.`;

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
//   continueParked: [ids] — these pending blocks restore their parked patch in round 1 instead of redoing it.
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
// Shape before ids, as for runOnly: a string would otherwise drop the scope and redo the block from scratch.
if (A.continueParked !== undefined && A.continueParked !== null
    && (!Array.isArray(A.continueParked) || A.continueParked.some((id) => typeof id !== 'string' || !id.trim()))) {
  throw new Error(`Invalid continueParked arg: args.continueParked must be an ARRAY of block id strings; got ${JSON.stringify(A.continueParked)}. It is not coerced — a non-array would silently redo each named block from scratch.`);
}
const continueParked = Array.isArray(A.continueParked) ? A.continueParked : [];
// Only a block this run builds can restore its patch, so any other id would be silently ignored.
const notPending = continueParked.filter((id) => !pending.some((p) => p.id === id));
if (notPending.length) {
  throw new Error(`Invalid continueParked id: args.continueParked ${notPending.map((id) => `"${id}"`).join(', ')} names no block this run builds. Pending ids: ${pending.map((p) => p.id).join(', ') || '(none)'}. A parked or blocked block must be set back to todo before it can be continued.`);
}
const CONTINUE = new Set(continueParked);

// Scoped to pending, so an all-done relaunch reaches the nothing-to-run terminal instead of throwing over
// a test command it will never run.
if (pending.some((p) => p.gate === 'green') && (typeof A.gates?.test !== 'string' || !A.gates.test.trim())) {
  throw new Error('args.gates.test is required when any block being built has gate:"green": the shell command that runs the verification (non-zero exit = fail). A block that legitimately has none takes gate:"build-only" instead.');
}

const reviewTrail = `Numbered review files show every iteration: quality-review-<id>-rN.md in ${GATE_DIR}/ — the blind reviewer's whole world, which is why nothing carrying the plan lives in it — and acceptance-review-<id>-rN.md in ${STATE_DIR}/; git staging marks each accepted block.`;

// A terminal, not a throw: an all-done relaunch is legitimate, and the caller must tell it from bad args.
if (!pending.length) {
  logLine(`develop: no todo blocks selected out of ${ALL_PLANS.length} — nothing to run`);
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
    newIssues: 0,
    newIssueFiles: [],
    reviewTrail,
    followups: `No block in args.plans has status:"todo"${runOnly ? ` within runOnly [${runOnly.join(', ')}]` : A.startAt ? ` at or after startAt "${A.startAt}"` : ''}. Nothing was built and nothing was changed. If work remains, set that block's status back to todo in its plan file and re-run; otherwise this roadmap is finished — verify the end state yourself (run the full gates, \`git -C ${REPO} diff --cached --stat\`) and commit.`,
  };
}

logLine(`develop: ${pending.length}/${ALL_PLANS.length} block(s) to build${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : A.startAt ? ` (startAt: ${A.startAt})` : ''} [maxRounds=${MAX_ROUNDS}, ordered=${ORDERED}, suite=${SUITE}]`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
// Also logged per block as one or more STATUS_LOG lines: run logs survive a failed or stopped run, and
// `plan-edit.mjs args` folds them into the plan file.
const statusSync = [];
let newIssues = 0;
let newIssuesUnknown = false;    // a fix verifier's report was unusable, so a file it never named may hold entries
const newIssueFiles = new Set();     // the files fix verifiers named in new_issue_blocks
const startedIssueFiles = new Set(); // every started fix block's file: what to check when a report is unknown
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
  // A later FAILED report is a reverted fix, so acceptance must not hold the block open on it.
  const claimed = () => [...claimedEver].filter((id) => reported.get(id) !== 'FAILED');
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
    claimed,
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
      const claimedCount = claimed().length;
      return {
        criteria: null,
        reachable: null,
        thin: checks.length < claimedCount + staleIds.length,
        open: openChecks > 0,
        evidence: `${checks.length} check(s) for ${claimedCount} claimed fix(es)${staleIds.length ? ` and ${staleIds.length} stale claim(s)` : ''}`,
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
        else logLine(`  ⚠ ${p.id}: issue ${id} was reported ${status} but belongs to no block in this pass — no status edit`);
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

/** One block's status edits as STATUS_LOG lines: whole edits in order, packed greedily up to STATUS_LINE_MAX chars. */
function statusLines(edits) {
  const headLength = STATUS_LOG.length + 1;
  const lines = [];
  let batch = [];
  let lineLength = headLength;
  for (const edit of edits) {
    // An array's JSON spends one char per element beyond the element: its ',' or the closing ']'.
    const editLength = JSON.stringify(edit).length + 1;
    if (batch.length && lineLength + editLength > STATUS_LINE_MAX) {
      lines.push(STATUS_LOG + JSON.stringify(batch));
      batch = [];
      lineLength = headLength;
    }
    batch.push(edit);
    lineLength += editLength;
  }
  if (batch.length) lines.push(STATUS_LOG + JSON.stringify(batch));
  return lines;
}

/** Records a finished block or pass: its ledger row, each member block's status, and each changed fix entry's. */
function finishBlock(p, rec, blockStatus, fix) {
  const members = p.blocks ?? [{ id: p.id, planPath: p.planPath }];
  const issueEdits = fix ? fix.edits(blockStatus === 'done') : [];
  const edits = [...members, ...issueEdits].map((e) => ({ planPath: e.planPath, id: e.id, key: 'status', value: e.value ?? blockStatus }));
  ledger.push(rec);
  statusSync.push(...edits);
  for (const line of statusLines(edits)) logLine(line);
}

for (const p of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between blocks rather
  // than letting an agent() call throw mid-block. Accepted blocks are STAGED; resume continues.
  if (budget.total && budget.remaining() < MIN_PLAN_BUDGET) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltKind = 'budget';
    haltReason = `Stopped before block ${p.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minPlanBudget). Resume with startAt:"${p.id}".`;
    logLine(`⏸ ${haltReason}`);
    break;
  }
  // A block starts only while its status line fits inside LOG_CAP, and one that overran it halts the next.
  // Progress lines have stopped by then, so the halt reason travels in the return value alone.
  if (statusRoom() < 1) {
    halted = true;
    haltKind = 'log-cap';
    haltReason = `Stopped before block ${p.id}: Claude Code keeps only a run's first ${LOG_CAP} log lines, and this block's status line could fall past them. Resume with startAt:"${p.id}".`;
    break;
  }

  logLine(`▶ block ${p.id} [mode=${p.mode}, gate=${p.gate}]${p.blocks ? ` packing ${p.blocks.map((b) => b.id).join(', ')}` : ''}`);
  const rec = { id: p.id, mode: p.mode, gate: p.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, planAmendments: 0, staged: false, reachable: false, regression: false, criteria: null, results: null, thinEvidence: false, contradicted: false, parked: false, parkCleared: false, patch: null };
  const fix = p.mode === 'fix' ? fixTracker(p) : null;
  if (fix) for (const b of p.blocks ?? [p]) startedIssueFiles.add(newIssuesFile(b.id));
  // 'no-changes' when this fix block ended on the round-1 no-changes terminal ('' = none). It does not
  // park: the tree is clean, so park would have nothing to save.
  let fixTerminal = '';
  // The latest review file the developer must address. Empty until a reviewer writes one, and never
  // replaced by a path nobody wrote: the halt reason and parkPrompt each say so instead.
  let reviewPath = '';
  // Work no clean review has passed. The tree is CUMULATIVE while `produced` is per-round, so a round that
  // re-runs a red gate, DROPs every finding or answers a failed acceptance can report produced=false over it.
  let reviewOwed = false;
  let accepted = false;
  // `escalated` distinguishes the halts that leave real work in the tree (park it) from a round-1
  // dirty-baseline halt, which changed nothing — that work is the OPERATOR's and must never be parked.
  let escalated = false;
  // The escalation's kind when it parks without halting the run (needs-user in an unordered run).
  let parkKind = '';
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
      logLine(`  ✋ ${p.id} r${round}: developer returned nothing (agent skipped or died) → halting before any review agent`);
      break;
    }

    // ---- PRECONDITION (round 1 of every block): the unstaged tree must have been CLEAN --------------
    // Reviewers scope on the unstaged diff, so pre-existing work would be judged as this block's. Checked
    // before plan_obtained, whose halt parks: a developer that stops here never ran its block command.
    if (round === 1) {
      // Guard the value, never its coercion: Number(null), Number(false) and Number('') are a finite 0,
      // which reads as clean.
      const dirty = dev?.baseline_dirty_files;
      if (typeof dirty !== 'number' || !Number.isFinite(dirty)) {
        logLine(`  ⚠ ${p.id} r1: developer did not report baseline_dirty_files — the clean-baseline precondition was NOT verified`);
      } else if (dirty > 0) {
        halted = true;
        rec.status = 'BLOCKED (dirty baseline)';
        haltKind = 'dirty-baseline';
        haltReason = `Block ${p.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the reviewers' scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain), then settle it one of two ways. \`git -C ${REPO} add -A\` to KEEP it when it is your own pre-existing edits (folds it into the accepted baseline). Or SET IT ASIDE without touching the staged index, which holds every accepted block. First remove the untracked build output and caches (they regenerate). If \`git -C ${REPO} status --porcelain\` then lists no \`??\` file and \`git -C ${REPO} diff\` is empty, the tree is settled. Otherwise mark each remaining \`??\` untracked file with \`git -C ${REPO} add -N -- <file>\`, create the state dir if needed (\`mkdir -p ${STATE_DIR}\`), save \`git -C ${REPO} diff --binary > ${STATE_DIR}/set-aside-<n>.patch\` with an n no file there uses (the patch carries the new files too), and confirm that patch exists and is non-empty. SAVE BEFORE YOU CLEAR: if it does not, stop and clear nothing. Then restore the modified tracked files with \`git -C ${REPO} checkout -- <files>\`, drop each intent-to-add file with \`git -C ${REPO} rm -f -q -- <file>\`, then confirm \`git -C ${REPO} status --porcelain\` lists no \`??\` file, \`git -C ${REPO} diff\` is empty and \`git -C ${REPO} diff --cached\` is unchanged. Restore it later with a plain \`git -C ${REPO} apply <patch>\`, never \`--3way\`, which stages what it restores. An unpathed \`git reset\`, \`git rm\` or \`git stash\` touches the staged baseline. If the dirt is an earlier interrupted develop run's unfinished block, never \`git add -A\` it (no reviewer passed it): set it aside as above. Nothing was built, but this run recorded the block as \`blocked\`. Once the tree is settled, run \`plan-edit.mjs args\` (it applies that status), set this block's \`status:\` back to \`todo\`, run \`plan-edit.mjs args\` again, and relaunch with those args.`;
        logLine(`  ✋ ${p.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before any review agent (git add -A only your own edits; set the rest aside as a git diff --binary patch, never git stash, which takes the staged baseline too — steps in the halt reason)`);
        break;
      }
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
      logLine(`  ✋ ${p.id} r${round}: developer never got its plan → halting before any review agent`);
      break;
    }

    // ---- FIX MODE: the per-issue results ARE the round's record ------------------------------------
    // Derived, so a round that only SKIPPED or found STALE entries cannot pull the blind reviewer onto an
    // empty diff. Recorded before the halts below so an escalated block still reaches the ledger.
    const results = fix ? fix.record(dev) : [];
    if (fix) rec.results = fix.ledger();
    // ---- PRECONDITION: the work is still UNSTAGED ---------------------------------------------------
    // Self-staged work would skip both reviewers and be inherited as the accepted baseline. It follows the
    // dead-agent, dirty-baseline and plan_obtained guards, since a null return also fails `!== true`, and
    // precedes needs_user, since a staged index must halt even an unordered run.
    if (dev.unstaged_confirmed !== true) {
      halted = true;
      escalated = true;   // real work is probably in the tree → park it rather than abandon it
      haltKind = 'staging-unconfirmed';
      haltReason = `Developer for block ${p.id} did not confirm its work stayed UNSTAGED in round ${round} (unstaged_confirmed=${JSON.stringify(dev.unstaged_confirmed)}). The staged index is the one surface neither reviewer checks — the blind critic reads \`git diff\`, acceptance treats \`git diff --staged\` as the accepted baseline — so anything staged here would be reviewed by nobody and then inherited as known-good. Inspect \`git -C ${REPO} diff --cached\` before resuming.`;
      if (dev.needs_user === true) {
        rec.needsUser = true;
        haltReason += ` The developer also escalated a user-only decision (see ${NEEDS_USER}).`;
      }
      rec.status = 'BLOCKED (staging unconfirmed)';
      logLine(`  ✋ ${p.id} r${round}: developer did not confirm its work stayed UNSTAGED → halting before any review agent (inspect git -C ${REPO} diff --cached)`);
      break;
    }
    if (dev?.needs_user === true) {
      escalated = true;   // real work may be in the tree → park it below rather than abandoning it there
      rec.status = 'BLOCKED (needs user)';
      rec.needsUser = true;
      // No later block depends on this one in an unordered run, so only an ordered run stops.
      if (ORDERED) {
        halted = true;
        haltKind = 'needs-user';
        haltReason = `Developer halted for a user-only decision in block ${p.id} round ${round} (see ${NEEDS_USER}).`;
      } else {
        parkKind = 'needs-user';
      }
      logLine(`  ✋ ${p.id} r${round}: developer escalated a user-only decision → ${ORDERED ? 'halting' : 'parking it, the unordered run continues'} (see ${NEEDS_USER})`);
      break;
    }
    if (dev?.dismissed_count) {
      logLine(`  ${p.id} r${round}: developer declined ${dev.dismissed_count} finding(s) → ${dismissedFile(p.id)} (audit these at the end)`);
    }
    // MATRIX 6a: only the count travels (#1/#8). Coerced so garbage cannot poison the ledger total.
    const amendments = Number(dev?.plan_amendments) || 0;
    if (amendments > 0) {
      rec.planAmendments += amendments;
      logLine(`  ⚠ ${p.id} r${round}: ${amendments} plan amendment(s) recorded — see ${amendedFile(p.id)}`);
    }
    const produced = fix
      ? results.some((r) => r?.status === 'FIXED' || r?.status === 'FAILED')
      : dev.produced === true;
    if (produced) reviewOwed = true;
    if (!gateOk(p.gate, dev)) {
      // Retain reviewPath: a still-open review, such as a quality CONTEST, must keep being addressed. At
      // the budget the engine holds the only copy of why the gate was red, so log it.
      if (round >= MAX_ROUNDS) { logLine(`  ⚠ ${p.id} r${round}: gate(${p.gate}) not satisfied at round budget (via=${dev?.verification_method || 'n/a'})${dev?.gate_output ? ` — last gate output: ${String(dev.gate_output).slice(-500)}` : ''}`); break; }
      logLine(`  ↻ ${p.id} r${round}: gate(${p.gate}) not satisfied (build=${dev?.build_passed}, test=${dev?.test_outcome}, count=${dev?.tests_run_count}, suite=${dev?.full_suite_outcome}, via=${dev?.verification_method || 'n/a'}) → another develop round`);
      continue;
    }

    // ---- FIX MODE, ROUND 1 ONLY: nothing produced over a green gate --------------------------------
    // A STALE claim, alone or beside SKIPPED entries, is one acceptance must confirm, so it falls through.
    // All SKIPPED or no report closed nothing. Round 1 only: a later results:[] can follow a real fix.
    if (fix && !produced && round === 1) {
      const staleCount = results.filter((r) => r?.status === 'STALE').length;
      if (staleCount > 0) {
        const claim = staleCount === results.length
          ? `every issue reported already resolved (all ${staleCount} STALE)`
          : `${staleCount} issue(s) reported already resolved (STALE), the rest SKIPPED`;
        logLine(`  ${p.id}: ${claim} — no diff, so acceptance confirms each claim without a blind review`);
      } else {
        fixTerminal = 'no-changes';
        rec.status = fixTerminal;
        logLine(`  ⚠ ${p.id}: no changes produced — ${results.length ? 'every entry was skipped' : 'the developer reported no entries at all'}; the block is NOT done and its issues stay open`);
        if (ORDERED) {
          halted = true;
          haltKind = 'no-changes';
          haltReason = `Fix block ${p.id} produced no changes in round 1: every entry it reported was SKIPPED (or it reported none), so nothing was fixed and nothing was staged. This is an ORDERED run, so the blocks after it were not attempted. Read the block itself — an entry only gets fixed while its \`- decision:\` line says ACTIONABLE — then flip it back to todo once \`plan-edit.mjs args\` has applied this run's statuses, and relaunch. The tree is clean.`;
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
        logLine(`  ✋ ${p.id} r${round}: quality reviewer returned nothing (agent skipped or died) → halting`);
        break;
      }
      if (quality?.contested_dismissals) {
        rec.contested += quality.contested_dismissals;
        logLine(`  ⚠ ${p.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — developer must fix or escalate, not re-dismiss (audit ${dismissedFile(p.id)})`);
      }
      // clean means no findings and no contests, so a clean:true beside either count contradicts itself and
      // must route its findings to the developer rather than on to acceptance.
      const qualityClean = quality.clean === true && !(Number(quality.issue_count) > 0) && !(Number(quality.contested_dismissals) > 0);
      if (quality.clean === true && !qualityClean) {
        logLine(`  ⚠ ${p.id} r${round}: quality returned clean=true with issue_count=${quality.issue_count} and contested_dismissals=${quality.contested_dismissals} — self-contradictory; treated as NOT clean`);
      }
      if (!qualityClean) {
        // An unwritten review file would send the next developer, and park, to a path nobody wrote.
        if (quality.wrote_file !== true) {
          halted = true;
          escalated = true;
          haltKind = 'review-unwritten';
          haltReason = `Quality reviewer for block ${p.id} reported findings in round ${round} but did not confirm writing ${qualityFile(p.id, round)}, so there is no review file for the developer to address. Check whether that file exists before resuming.`;
          rec.status = 'BLOCKED (review file not written)';
          logLine(`  ✋ ${p.id} r${round}: quality reviewer did not confirm writing ${qualityFile(p.id, round)} → halting`);
          break;
        }
        reviewOwed = true;
        reviewPath = qualityFile(p.id, round);
        if (round >= MAX_ROUNDS) { logLine(`  ⚠ ${p.id} r${round}: ${quality?.issue_count ?? '?'} quality issue(s) open at round budget (see ${reviewPath})`); break; }
        logLine(`  ↻ ${p.id} r${round}: quality review found ${quality?.issue_count ?? '?'} issue(s) → develop addresses ${reviewPath}`);
        continue;
      }
      reviewOwed = false;
      if (quality.wrote_file !== true) logLine(`  ⚠ ${p.id} r${round}: quality reviewer did not confirm writing ${qualityFile(p.id, round)}`);
      logLine(`  ✓ ${p.id} r${round}: quality review clean`);
    } else {
      logLine(`  ${p.id} r${round}: developer produced no changes — skipping blind review; acceptance will judge the block against its criteria`);
    }

    // ---- ACCEPTANCE REVIEW (plan-aware; stages on pass; baseline advances) ---
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(p, round, fix?.claimed(), fix?.stale(), fix?.skipped(), rec.qualityRounds === 0), roleOpts('acceptance', {
      schema: acceptanceSchema(p.mode), phase: 'Acceptance', label: `acceptance ${p.id} r${round}`,
    }));
    // A dead verifier is not a gap verdict, and the next round would read a review file nobody wrote.
    if (!acc) {
      halted = true;
      escalated = true;
      haltKind = 'agent-dead';
      haltReason = `Acceptance verifier for block ${p.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a gap verdict, and nothing was staged. ${DEAD_AGENT_RECOVERY}`;
      rec.status = 'BLOCKED (agent died)';
      // It may have appended a new issue before it died.
      if (fix) newIssuesUnknown = true;
      logLine(`  ✋ ${p.id} r${round}: acceptance verifier returned nothing (agent skipped or died) → halting`);
      break;
    }
    // Without the block, the verifier's pass:false would park the block as a routine gap.
    if (acc?.plan_obtained === false) {
      halted = true;
      escalated = true;
      haltKind = 'plan-unreadable';
      haltReason = `Acceptance verifier for block ${p.id} could not obtain its plan (round ${round}), so it had no criteria to judge. Its plan reference was: ${planRef(p)}. Run that yourself: a non-zero exit names the cause.`;
      rec.status = 'BLOCKED (plan unreadable)';
      logLine(`  ✋ ${p.id} r${round}: acceptance never got its plan → halting`);
      break;
    }
    if (acc?.regression === true) rec.regression = true;
    if (fix) {
      // A pass's own id names no file: each harm belongs to the member whose entry lists it.
      const issueBlocks = p.blocks ? p.blocks.map((b) => b.id) : [p.id];
      const countKnown = Number.isInteger(acc.new_issues) && acc.new_issues >= 0;
      const namedBlocks = Array.isArray(acc.new_issue_blocks) ? acc.new_issue_blocks : null;
      const blocksKnown = namedBlocks !== null && namedBlocks.every((id) => issueBlocks.includes(id))
        && !(acc.new_issues > 0 && namedBlocks.length === 0);
      if (countKnown && blocksKnown) {
        const writtenFiles = [...new Set(namedBlocks)].map(newIssuesFile);
        newIssues += acc.new_issues;
        for (const file of writtenFiles) newIssueFiles.add(file);
        if (acc.new_issues > 0) logLine(`  ⓘ ${p.id} r${round}: acceptance recorded ${acc.new_issues} new issue(s) in ${writtenFiles.join(', ')}`);
      } else {
        newIssuesUnknown = true;
      }
    }
    // Per mode: a fix schema has no criteria or reachability, which would flag every fix pass as thin.
    const verdict = fix ? fix.judge(acc) : judgePlanAcceptance(acc);
    rec.criteria = verdict.criteria;
    if (acc?.pass === true) {
      rec.reachable = verdict.reachable;
      // A thin pass (#14) is flagged for audit, not failed: acceptance already staged.
      rec.thinEvidence = verdict.thin;
      // Flag every contradiction. Halt only on the regression: staged work becomes every later baseline.
      rec.contradicted = acc?.regression === true || verdict.open || Number(acc?.gap_count) > 0;
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (${verdict.evidence}) — audit ${acceptanceFile(p.id, round)}` : '';
      const contraNote = rec.contradicted ? ` ⚠ CONTRADICTS ITS OWN PASS (regression=${acc?.regression}, ${verdict.contraDetail}, gap_count=${acc?.gap_count}) — audit ${acceptanceFile(p.id, round)}` : '';
      if (acc.wrote_file !== true) logLine(`  ⚠ ${p.id} r${round}: acceptance verifier did not confirm writing ${acceptanceFile(p.id, round)}`);
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        logLine(`  ✓ ${p.id}: acceptance PASSED — ${verdict.score} — STAGED (${verdict.reachNote}gate=${acc?.suite_result || 'n/a'})${thinNote}${contraNote}`);
        // Halt, not re-round (the next blind diff cannot see staged work) and not park (park never
        // touches the baseline). The block stays "done (staged)".
        if (acc?.regression === true) {
          halted = true;
          haltKind = 'acceptance-regression';
          haltReason = `Block ${p.id} was STAGED by acceptance while the SAME verdict reported regression=true — a self-contradictory return (see ${acceptanceFile(p.id, round)}). Its work is now the baseline every later block would be judged against, so the run stops here. Inspect \`git -C ${REPO} diff --cached\`; unstage/fix it, then resume with startAt the NEXT block id.`;
          logLine(`  ✋ ${p.id}: staged while self-reporting a REGRESSION → halting the run (inspect git -C ${REPO} diff --cached)`);
        }
        break;
      }
      // The passed-unstaged remedy below stages the work, which would put a flagged regression into the baseline.
      if (acc?.regression === true) {
        halted = true;
        escalated = true;   // park saves the unstaged work and clears the tree
        haltKind = 'passed-regression';
        rec.status = 'BLOCKED (acceptance passed a flagged regression and staged nothing)';
        if (acc.wrote_file === true) reviewPath = acceptanceFile(p.id, round);
        haltReason = `Acceptance PASSED block ${p.id} in round ${round} but flagged a regression and staged nothing (${acc.wrote_file === true ? `see ${reviewPath}` : `it did not confirm writing ${acceptanceFile(p.id, round)}, so that file may not exist`}). Its work was left UNSTAGED and is flagged as a regression, so never stage it as it is.`;
        logLine(`  ✋ ${p.id} r${round}: acceptance passed but flagged a REGRESSION and staged nothing → parking its work, halting${contraNote}`);
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next block's blind diff would include
      // this block's unstaged work. Do NOT advance; halt for manual staging, then resume.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage — stage manually, then resume)';
      haltKind = 'passed-unstaged';
      haltReason = `Block ${p.id} passed acceptance but its work was left UNSTAGED. Stage its files (git -C ${REPO} add <files>) so the baseline advances, then relaunch: the next \`plan-edit.mjs args\` marks the block done: no startAt is needed.`;
      logLine(`  ✋ ${p.id}: acceptance passed but NOT staged → halting (staging boundary)`);
      break;
    }
    // Rejected work in the index skips every later review and becomes the baseline they judge against.
    if (acc.staged === true) {
      const accCite = acc.wrote_file === true
        ? `see ${acceptanceFile(p.id, round)}`
        : `it did not confirm writing ${acceptanceFile(p.id, round)}, so that file may not exist`;
      halted = true;
      escalated = true;   // park saves any unstaged remainder and leaves the index alone
      haltKind = 'rejected-staged';
      haltReason = `Acceptance REJECTED block ${p.id} in round ${round} but reported staged=true (${accCite}), so work it failed may now sit in the accepted baseline. Inspect \`git -C ${REPO} diff --cached\` and unstage this block's files before resuming.`;
      rec.status = 'BLOCKED (acceptance staged a rejected block)';
      if (acc.wrote_file !== true) logLine(`  ⚠ ${p.id} r${round}: acceptance verifier did not confirm writing ${acceptanceFile(p.id, round)}`);
      logLine(`  ✋ ${p.id} r${round}: acceptance failed the block but staged it → halting (inspect git -C ${REPO} diff --cached)`);
      break;
    }
    if (acc.wrote_file !== true) {
      halted = true;
      escalated = true;
      haltKind = 'review-unwritten';
      haltReason = `Acceptance verifier for block ${p.id} failed the block in round ${round} but did not confirm writing ${acceptanceFile(p.id, round)}, so there is no review file for the developer to address. Check whether that file exists before resuming.`;
      rec.status = 'BLOCKED (review file not written)';
      logLine(`  ✋ ${p.id} r${round}: acceptance verifier did not confirm writing ${acceptanceFile(p.id, round)} → halting`);
      break;
    }
    reviewOwed = true;
    reviewPath = acceptanceFile(p.id, round);
    if (round >= MAX_ROUNDS) { logLine(`  ⚠ ${p.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s) at round budget (see ${reviewPath})`); break; }
    logLine(`  ↻ ${p.id} r${round}: acceptance found ${acc?.gap_count ?? '?'} gap(s)${acc?.regression ? ' [REGRESSION]' : ''} → develop addresses ${reviewPath}`);
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
      logLine(`  ✋ ${p.id}: not accepted within ${MAX_ROUNDS} rounds → parking its work, then halting (ordered run)`);
    }
    phase('Park');
    // reviewPath passes through empty or not: see its declaration.
    const pk = await agent(parkPrompt(p, reviewPath, escalated, parkKind || haltKind, halted), roleOpts('develop', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${p.id}`,
    }));
    // Patch bytes with saved=false contradicts itself, and the tree may already be cleared: name the patch.
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    // Null when park wrote nothing. Every later patch mention keys on this, never naming a missing file.
    rec.patch = (pk?.saved === true || contradictory) ? parkedPatch(p.id) : null;
    // A value, so parked[] never parses status prose: an escalated block keeps its BLOCKED status.
    rec.parked = true;
    // Only a confirmed clear proves a patchless park had nothing to save.
    rec.parkCleared = pk?.cleared === true;
    if (!escalated) rec.status = 'parked (not accepted within round budget)';
    // A continued block's patchless park leaves its earlier work, if any, in the patch it was continued from.
    const continuedEmpty = CONTINUE.has(p.id) && !rec.patch && rec.parkCleared;
    const continuedFrom = `continued from ${parkedPatch(p.id)}, which holds its earlier work only if that file exists: its entry in ${NEEDS_USER} says whether the patch was missing or did not apply`;
    const parkSavedTo = rec.patch || (rec.parkCleared ? 'nothing to save' : pk ? 'nowhere: park confirmed no save or clear' : 'unknown: the park agent returned nothing');
    // Park's notes are the only place an empty park explains itself. Logged, not returned.
    logLine(`  ⚠ ${p.id}: ${escalated ? 'escalated to the user' : `not accepted within ${MAX_ROUNDS} rounds`} — PARKED (${continuedEmpty ? `no new patch, ${continuedFrom}` : `work saved to ${parkSavedTo}`}${pk?.patch_bytes ? `, ${pk.patch_bytes}B` : ''}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${pk?.gates_green ? 'green' : 'RED'}) — see ${NEEDS_USER}${pk?.notes ? ` — park note: ${String(pk.notes).slice(0, 300)}` : ''}`);
    // A tree we could not clear (or a broken build) is unsafe for whatever comes next, so those DO halt
    // even in an unordered run, where a plain park does not.
    if (contradictory) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Park reported saved=false for block ${p.id} but wrote ${pk.patch_bytes} bytes to ${parkedPatch(p.id)} — the report contradicts itself. The patch is real; inspect it before continuing (the tree was ${pk?.cleared === true ? 'already cleared' : 'left as-is'}).`;
    } else if (!pk) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The park agent for block ${p.id} returned nothing (skipped or died), so whether its work is in ${parkedPatch(p.id)} or still in the working tree is unknown: inspect both. The tree is unsafe for whatever runs next until you do.`;
    } else if (pk.cleared !== true) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Block ${p.id} could not be cleared from the working tree${pk.saved === true ? ` (its work IS saved to ${parkedPatch(p.id)})` : ' and its work was NOT saved — the tree still holds it'}; the tree is unsafe for whatever runs next.`;
    } else if (pk?.gates_green === false) {
      // A cleared tree with a red build is not safe to resume into.
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The build gate is not green after parking block ${p.id}; the tree is unsafe for whatever runs next.`;
    } else if (halted) {
      // The run is stopping, so say where the work went (see rec.patch).
      let savedTo = ' It had NOTHING to save (its working tree was already empty)';
      if (rec.patch) savedTo = ` Its work is SAVED to ${rec.patch}`;
      else if (continuedEmpty) savedTo = ` It was ${continuedFrom}. This park wrote no new patch`;
      haltReason += `${savedTo} and the tree is CLEAN; resolve with the user, then resume from this block.`;
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
let sweepFileNote = '';
let sweepGapCount = null;  // null when the sweep returned no valid count: unknown, never zero
const goalCovered = !halted && ALL_PLANS
  .filter((p) => p.status !== 'skip')
  .every((p) => p.status === 'done' || doneIds.includes(p.id));
// A status line past LOG_CAP survives only in result.statusSync, so the run returns before awaiting the
// sweep: a stop during the sweep would lose that line.
if (SWEEP_MODE === 'goal-coverage' && goalCovered && statusPastCap) {
  halted = true;
  haltKind = 'log-cap';
  haltReason = `Stopped before the goal-coverage sweep: Claude Code keeps only a run's first ${LOG_CAP} log lines, and the last block's status lines fell past them. Every block is done, but the sweep did not run: verify coverage against the goal yourself.`;
} else if (SWEEP_MODE === 'goal-coverage' && goalCovered) {
  phase('Sweep');
  sweep = await agent(sweepPrompt(doneIds), roleOpts('sweep', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  // A dead sweep is not a clean sweep. It does not halt: every block is staged, and the sweep is advisory.
  sweepFailed = !sweep;
  // The sweep file is cited only when the sweep attested writing it.
  sweepFileNote = sweep?.wrote_file === true
    ? `read ${SWEEP_FILE}`
    : `${SWEEP_FILE} was not written, so the gap count comes from the sweep's return alone`;
  sweepGapCount = Number.isInteger(sweep?.gap_count) && sweep.gap_count >= 0 ? sweep.gap_count : null;
  logLine(sweepFailed
    ? `  ⚠ sweep: the final completeness check DIED — it did not run, and ${SWEEP_FILE} was not written. Every block is staged, but NOTHING verified the goal was fully covered: check coverage against the goal yourself.`
    : sweep.complete
      ? `sweep: no goal-coverage gaps found (suite: ${sweep.suite_result || 'n/a'})`
      : sweepGapCount === null
        ? `  ⚠ sweep: returned no gap count, so the number of gaps is unknown — ${sweepFileNote}`
        : `sweep: ${sweepGapCount} potential gap(s) — ${sweepFileNote}`);
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
const savedClearedPlans = patchedPlans.filter((r) => r.parkCleared === true);
const savedUnclearedPlans = patchedPlans.filter((r) => r.parkCleared !== true);
// A continued block's patchless park may still have earlier work in the patch it was continued from.
const emptyParkPlans = parkedPlans.filter((r) => !r.patch && r.parkCleared === true && !CONTINUE.has(r.id));
const continuedEmptyPlans = parkedPlans.filter((r) => !r.patch && r.parkCleared === true && CONTINUE.has(r.id));
// A patchless park that never confirmed a clear may still hold the work in the tree or a patch file.
const unclearedParkPlans = parkedPlans.filter((r) => !r.patch && r.parkCleared !== true);
// Selected blocks that ended neither done nor parked: a fix block that closed no issue (no-changes), or a
// block stopped by a halt that never parks (dirty-baseline, passed-unstaged).
const blockedPlans = ledger.filter((r) => !doneIds.includes(r.id) && !parkedPlans.includes(r));
const noChangePlans = blockedPlans.filter((r) => r.status === 'no-changes');
const haltedPlans = blockedPlans.filter((r) => r.status !== 'no-changes');
// An ordered needs-user halt already says this in its halt text.
const needsUserParks = haltKind === 'needs-user' ? [] : ledger.filter((r) => r.needsUser);
const HALT_STATUS = {
  'needs-user':      'BLOCKED (needs user input)',
  'dirty-baseline':  'BLOCKED (working tree was not clean — nothing was built)',
  'plan-unreadable': 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)',
  'no-changes':      'halted (a fix block closed no issue - every entry was skipped, and the ordered run stopped there)',
  'agent-dead':      'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)',
  'staging-unconfirmed': 'BLOCKED (the developer did not confirm its work stayed unstaged - the staged index is surface neither reviewer checks; inspect git diff --cached before resuming)',
  'passed-unstaged': 'BLOCKED (a block passed but was not staged — stage it, then resume)',
  'passed-regression': 'BLOCKED (a block passed but flagged a regression and was not staged - its work is parked, never stage it as it is)',
  'acceptance-regression': 'BLOCKED (a block staged while self-reporting a regression — inspect the staged diff before continuing)',
  'rejected-staged': 'BLOCKED (acceptance failed a block but staged it - inspect git diff --cached and unstage that block before resuming)',
  'review-unwritten': 'BLOCKED (a reviewer failed a block without confirming its review file - check that file before resuming)',
  'parked':          'halted (a block was parked — its work is saved to a patch; the blocks after it were not attempted)',
  'park-unsafe':     'BLOCKED (a parked block left the tree unsafe — inspect before resuming)',
  'budget':          'stopped on token budget (resume where it left off)',
  'log-cap':         'stopped on the runtime log line cap (resume where it left off)',
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

logLine(`develop: ${status} — ${doneIds.length}/${pending.length} block(s) done [${ledger.reduce((s, r) => s + r.qualityRounds, 0)} quality pass(es)]`);

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
  sweep: sweep ? { complete: sweep.complete === true, gaps: sweepGapCount, suite: sweep.suite_result || '' } : null,
  // true ONLY when the sweep ran and died. `sweep: null` on its own cannot say whether the check was
  // deliberately skipped (sweep:none, an incomplete goal) or lost — and those need different actions.
  sweepFailed,
  // Parked blocks: NOT done. patch follows rec.patch.
  parked: parkedPlans.map((r) => ({ id: r.id, mode: r.mode, patch: r.patch ?? null, status: r.status })),
  ledger,
  // One { planPath, id, key, value } edit per block this run finished and per fix entry whose status
  // changes. A block the run never reached has none.
  statusSync,
  // null when a fix verifier's report was unusable: a file may then hold entries the total would hide.
  newIssues: newIssuesUnknown ? null : newIssues,
  newIssueFiles: newIssuesUnknown ? null : [...newIssueFiles].sort(),
  reviewTrail,
  followups: `${halted ? `Run halted — ${haltReason}${haltKind === 'needs-user' ? ` Read ${NEEDS_USER} and the block's latest review file, resolve with the user, then flip the block to todo once \`plan-edit.mjs args\` has applied this run's statuses, and relaunch. The tree is clean; whether that block's work is in a patch is stated below.` : ' '}` : ''}${sweepFailed
    ? `WARN THE USER FIRST: the final completeness sweep DIED, so nothing checked the goal was fully covered — verify coverage against the goal yourself before trusting this as finished. `
    : ''}${needsUserParks.length
    ? `${needsUserParks.length} block(s) escalated a user-only decision: ${needsUserParks.map((r) => r.id).join(', ')}. Read ${NEEDS_USER} and each block's latest review file, resolve with the user, then flip the block to todo once \`plan-edit.mjs args\` has applied this run's statuses, and relaunch it with runOnly. `
    : ''}${parkedPlans.length
    ? `${parkedPlans.length} block(s) were PARKED: ${parkedPlans.map((r) => r.id).join(', ')}. ${savedClearedPlans.length
      ? `Work SAVED and cleared from the tree — nothing discarded — for: ${savedClearedPlans.map((r) => r.id).join(', ')} (each in ${STATE_DIR}/parked-<id>.patch; ${NEEDS_USER} carries its diagnosis and its \`git apply\` restore command). `
      : ''}${savedUnclearedPlans.length
      ? `Work SAVED but NOT cleared from the tree for: ${savedUnclearedPlans.map((r) => r.id).join(', ')} (each in ${STATE_DIR}/parked-<id>.patch, and the working tree still holds it). Clear the tree before resuming, and keep the patch until you have. `
      : ''}${emptyParkPlans.length
      ? `NO patch was written for: ${emptyParkPlans.map((r) => r.id).join(', ')} — those blocks had nothing to save (their working tree was already empty), so there is nothing to restore; read their diagnosis in ${NEEDS_USER}. `
      : ''}${continuedEmptyPlans.length
      ? `No new patch was written for: ${continuedEmptyPlans.map((r) => `${r.id} (continued from ${parkedPatch(r.id)})`).join(', ')}. That patch holds the block's earlier work only if the file exists. Each block's entry in ${NEEDS_USER} says whether its patch was missing or did not apply. `
      : ''}${unclearedParkPlans.length
      ? `Park did NOT confirm a save or a clear for: ${unclearedParkPlans.map((r) => r.id).join(', ')}. Their work may still be in the working tree or in ${STATE_DIR}/parked-<id>.patch: inspect both before discarding anything. `
      : ''}Per parked block the user decides: ${patchedPlans.length ? 'restore the patch and finish by hand, ' : ''}re-run it alone (sharpen its block in the plan file if needed, flip it to todo once \`plan-edit.mjs args\` has applied this run's statuses, and relaunch it with runOnly)${patchedPlans.length ? ', continue it from its patch under full review (the same relaunch, with continueParked naming it)' : ''}, or drop it. `
    : ''}${noChangePlans.length
    ? `${noChangePlans.length} block(s) closed NO issue and are NOT done: ${noChangePlans.map((r) => r.id).join(', ')}. statusSync marks each blocked: read its entries' \`- decision:\` lines (only ACTIONABLE entries get fixed), then flip it back to todo once \`plan-edit.mjs args\` has applied this run's statuses. `
    : ''}${haltedPlans.length
    ? `${haltedPlans.length} block(s) halted and are NOT done: ${haltedPlans.map((r) => r.id).join(', ')} - the halt reason above says what each needs. `
    : ''}${amendedIds.length
    ? `PLAN AMENDED for: ${amendedIds.join(', ')}. The developer overrode a plan clause it verified prescribes a real defect — read ${STATE_DIR}/AMENDED-<id>.md (and the pointer lines in ${NEEDS_USER}) before you commit, and fold anything you agree with back into the plan file. `
    : ''}${sweep && sweep.complete !== true
    ? `The sweep reported goal-coverage gaps — ${sweepFileNote}. `
    : ''}${newIssueFiles.size || newIssuesUnknown
    ? `${newIssuesUnknown
      ? `A fix verifier returned no usable new-issue report, so check these files for entries: ${[...startedIssueFiles].sort().join(', ')}.`
      : `Acceptance recorded ${newIssues} new issue(s) outside the fixes' root causes in: ${[...newIssueFiles].sort().join(', ')}.`} Triage each file like a debug issue file once its block's status is done or skip, since a relaunch of a parked or blocked block may still append to it. `
    : ''}${doneIds.length ? `Staged/accepted: ${doneIds.join(', ')}. ` : ''}Verify the end state yourself: run the full gates, \`git -C ${REPO} diff --cached --stat\`, and \`git -C ${REPO} status --porcelain\` (should be clean). Read the numbered review files (acceptance-review-*.md in ${STATE_DIR}/, quality-review-*.md in ${GATE_DIR}/) and each DISMISSED-<id>.md in ${GATE_DIR}/, auditing every declined finding. Then derive the next launch's args with \`node '${BLOCK_TOOL.replace(/[^/\\]*$/, 'plan-edit.mjs')}' args <planPath>\`, which first folds this run's statuses into the plan file. Nothing is committed — you commit.`,
};
