export const meta = {
  name: 'develop-cycle',
  description: 'Plan-driven build engine, one approved plan FILE as the bus: implement the todo BLOCKS of that file — each a "## Plan: <id>" block the user approved — where the block\'s `mode` picks the frame the engine holds (feature = one bounded feature, wired in and reachable; section = one slice of a breadth-spanning goal, every call site converted; fix = a triaged issue inventory, every ACTIONABLE entry verified and closed). Per block: develop → BLIND pure-code review (must pass, apart from the closing pass, whose acceptance sorts its findings) on the block\'s first build and wherever the developer judges a change not low risk → plan-aware acceptance + regression review + an audit of the developer\'s risk judgment (stages on pass, and in commit mode commits), looped per round, then one closing pass when the last round fails, whose acceptance lands the block when no gap it finds is blocking and sends each gap it leaves to the backlog; the accepted baseline advances block by block. A block whose closing acceptance finds a blocking gap is PARKED — its work saved as a commit on a branch that one backlog entry links, and cleared from the tree — after which an UNORDERED run CONTINUES and an ORDERED one STOPS (its later blocks depend on this one). Agents exchange messages as verbatim files; the harness only routes block ids, paths + verdicts.',
  whenToUse: 'Build the todo blocks of ONE approved plan file: bounded features (mode:"feature" — a new MCP tool/API endpoint/page/form, a contained enhancement, a design-needing bugfix), the ordered sections of a breadth-spanning goal (mode:"section" — a migration, upgrade, port, subsystem refactor), and/or triaged issue inventories (mode:"fix" — a block whose "### [<id>]" entries are the verified defects to close). The orchestrating agent authors the plan file OUTSIDE this engine (plan mode, then refine, then the user approves the final text), and the operator derives the args with `tools/plan-edit.mjs args <planPath>`, spreads the object it prints and adds backlogDir, the folder `tools/project-settings.mjs backlog` prints. Requires a CLEAN unstaged working tree; each accepted block is STAGED, and committed only when args.commit is true. Reuse one runId across resumes.',
  phases: [
    { title: 'Develop', detail: 'Developer reads its own block (verbatim, via the plan-block command) + the latest review that flagged issues, and works within the run\'s changePolicy in six phases, in this order. PATTERNS follows the repo\'s existing patterns. BUILD builds the block, then runs the gate. In a round that answers a review, a feature or section block\'s BUILD routes each finding and gap in it through the decision matrix in place of the build, and a fix block\'s BUILD routes them beside its entry rules. HARDEN handles edge cases, failure messages, logging, a test per risky path and cleanup at every tier in the code its round added or changed. SIBLINGS covers each sibling path of a fix. SELF-REVIEW applies the blind reviewer\'s severity scale, reach step and checklist to the code its round changed or read, since each earlier round had its own self-review and each blind review judges the entire block diff. CLASSIFY answers four risk questions (systems, paths, critical code, assumptions) for each change its round made, writes risk-<id>-rN.md and returns review_needed, true when any change is not low risk. Each phase after BUILD runs a targeted test while it works, the gate runs once more after the last phase that changed code, and a phase with nothing to do for its round\'s changes is skipped. It leaves changes UNSTAGED. Owns the decision matrix; halts only for a user-only decision. changePolicy sets the routing over three code zones: task code (the code its block\'s required changes add or change, plus in a fix block the sibling paths of each ACTIONABLE entry\'s root cause, apart from code its block\'s text excludes or another block owns), connected code (what a reach step from the task code finds, apart from code its block\'s text excludes or another block owns) and other code. Under both policies it hunts only task code, fixes every finding there at every tier, a defect the accepted baseline already had included, and fixes each finding its diff introduces or exposes in connected code. Only a proactive feature or section block also fixes a defect the accepted baseline already had in connected code that its diff neither introduces nor exposes, and only when that fix is low risk. Other code is never changed. A finding its diff introduces or exposes there is closed at its source in task or connected code, or escalated when only a change in other code closes it. It logs to DECISIONS.md, as a FOCUSED or PROACTIVE line, each fix of a defect the accepted baseline already had that no requirement of its block names. Each real defect at low or above that the accepted baseline already had and that its zone routing leaves unchanged, under rule 2 or as a sibling path, apart from one in code another block owns, goes to its block\'s file in the project\'s backlog folder (args.backlogDir), a fix-mode plan file a later run builds, the ACTIONABLE entries without triage and the rest once the user triages them. A proactive developer also records there each cleanup outside task code that it noticed and did not make, such as a nit. Under both policies it also records a feature or refactor outside its block\'s scope, and each choice it escalated and proceeded past by a default. It sets each entry\'s decision by one rule: ACTIONABLE for a defect or cleanup with one clear, small fix that changes no user-visible behavior, stored data or public contract, and NEEDS_USER for every other entry. When a block\'s last allowed round ends without a passed acceptance, one more developer, the closing pass, makes each fix of the last review\'s findings and gaps that is low risk and records each one that is not as a backlog entry naming the fix. No develop round follows it, and a blind review follows it only when its changes owe one.' },
    { title: 'Quality', detail: 'BLIND pure-code critic: reads ONLY the unstaged diff (no plan, no spec, no goal), reports every finding the diff introduces or exposes at every tier, from critical down to nit, under both change policies, and writes quality-review-<id>-rN.md. Clean means no finding and no contested dismissal. Runs in a block\'s first round with a satisfied gate in a launch, and in a later round only when a round since the block\'s last blind review returned review_needed true or no boolean, or the previous acceptance verdict returned risk_misclassified. Otherwise the round goes from the developer straight to acceptance. The closing pass gets one by the same rule, whatever its gate, and its findings go to the closing acceptance with no develop round between.' },
    { title: 'Acceptance', detail: 'Plan-aware gate: every acceptance criterion of THIS block met + reachable + the block gate satisfied + no regression + every risk answer of each round since the block\'s last blind review holds against that round\'s own hunks (a wrong or missing one returns risk_misclassified, so the next round gets a blind review). Writes acceptance-review-<id>-rN.md; on pass, STAGES that block (git add), and in commit mode (args.commit) commits it with the block\'s title as the entire message — the accepted baseline advances. The closing acceptance, which reads the closing blind review\'s file when one ran, sorts each gap as blocking (a regression, a red gate, an unmet criterion or unreachable change, in fix mode an ACTIONABLE entry whose root cause is open, a change made for an entry that is not ACTIONABLE or a change no FIXED claim accounts for, a defect at medium or higher the block\'s diff introduces, or a wrong risk answer no blind review read) or not blocking (every other gap). With no blocking gap it lands the block and appends each gap it leaves as one backlog entry. With a blocking gap, the block parks.' },
    { title: 'Park', detail: 'On a block that did not accept within its round budget, or one the developer escalated: SAVES its work as a commit on the branch aipg-unfinished/<the block\'s backlog file id>, built with git plumbing through a temporary index so the repo\'s index stays untouched and no commit hook runs, then clears it from the tree, and appends one backlog entry that links the branch and says why the block parked. The block\'s plan status becomes backlogged once the park clears the tree, keeps the build green and confirms its entry, after a halt that cannot leave the block\'s work staged or committed, for a block whose work a green fix block can build: not a red-baseline block, nor a build-only block in a run with no test gate. After such a halt, a fix block\'s park also takes as a parent the tip of each branch its round 1 restored whose every entry the developer\'s last report gave FIXED, or whose diff the working tree still holds, deletes that branch and syncs its entry stale. Every other park syncs blocked, and nextStep says whether the operator sets it backlogged or rebuilds it from todo. A closing acceptance that finds a blocking gap parks its block with the closing pass\'s work, and the park entry lists the blocking gaps first and names each backlog entry the closing pass listed. An UNORDERED run continues past a budget park or a needs-user escalation; an ORDERED run, or any other escalation, stops. Nothing is destroyed — a fix-mode block built from the entry restores the branch\'s work in its round 1.' },
    { title: 'Sweep', detail: 'Only when the plan file asks for it (sweep: goal-coverage) and every non-skip block is done: an independent agent re-greps the whole surface from the GOAL, runs the full gates, spot-checks the staged diff, or in commit mode this launch\'s commits, writes SWEEP.md. Advisory — a dead sweep never halts.' },
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
// Name the shape received: nesting the object `plan-edit.mjs args` prints under plans is the likely mistake.
if (!A || !Array.isArray(A.plans) || !A.plans.length) {
  const shape = !A ? 'no args at all' : A.plans === undefined ? 'nothing' : Array.isArray(A.plans) ? 'an empty array' : A.plans === null ? 'null' : `a ${typeof A.plans}`;
  throw new Error(`args.plans must be a NON-EMPTY array of { id, planPath, mode, gate, status } entries; got ${shape}. "plan-edit.mjs args <planPath>" prints an object: spread it into the args, so its "plans" array becomes args.plans. Never nest that object under "plans". There is no single-plan or inline-plan fallback.`);
}
if (!A.runId) {
  throw new Error('args must include at least { runId, root, target, gates, backlogDir, plans:[{id, planPath, mode, gate, status}] }; got typeof=' + (typeof args));
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
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 5, 50);    // develop rounds per block, before the closing pass
const MIN_PLAN_BUDGET = num(A.minPlanBudget, 'minPlanBudget', 0, 150_000); // token floor to start another block
// A typo that coerced would silently widen or narrow every developer's diff.
const VALID_CHANGE_POLICY = new Set(['focused', 'proactive']);
const CHANGE_POLICY = A.changePolicy ?? 'focused';
if (!VALID_CHANGE_POLICY.has(CHANGE_POLICY)) {
  const renamed = CHANGE_POLICY === 'strict' ? ' The policy strict is now named focused, so pass "focused" instead.' : '';
  throw new Error(`Invalid args.changePolicy: it must be one of focused, proactive; got ${JSON.stringify(A.changePolicy)}.${renamed} It is not coerced, since it sets the developer's build aim and whether it fixes a pre-existing defect it notices in connected code.`);
}
const PROACTIVE = CHANGE_POLICY === 'proactive';
// The string "false" is truthy, so a coerced value could commit every accepted block the operator meant to stage.
if (A.commit !== undefined && typeof A.commit !== 'boolean') {
  throw new Error(`Invalid commit arg: args.commit must be true or false; got ${JSON.stringify(A.commit)}. It decides whether acceptance commits each accepted block, so it is not coerced. Omit it, or pass false, to stage each accepted block.`);
}
const COMMIT = A.commit === true;
// Ignored, it would leave the operator believing a bar the run never used.
if (A.reviewSeverity !== undefined) {
  throw new Error(`args.reviewSeverity is retired: the developer's risk judgment decides when a blind review runs, and every blind review reports findings at every tier, so drop this key. Got reviewSeverity ${JSON.stringify(A.reviewSeverity)}.`);
}

// Retired args throw, never ignored: each served only a hand-built payload, which skips the status fold
// `plan-edit.mjs args` applies. Below num(): the cross-engine bound sweep passes refine's top-level planPath.
if (A.startAt !== undefined) {
  throw new Error(`args.startAt is retired: relaunch with fresh "plan-edit.mjs args <planPath>", which applies the finished runs' statuses so the run builds only the blocks still todo, or name the blocks to build in args.runOnly. Got startAt ${JSON.stringify(A.startAt)}.`);
}
if (A.planPath !== undefined) {
  throw new Error(`The top-level args.planPath is retired: every "plans" row that "plan-edit.mjs args <planPath>" prints carries its own planPath, so spread the object it prints and drop this key. Got planPath ${JSON.stringify(A.planPath)}.`);
}
if (A.continueParked !== undefined) {
  throw new Error(`args.continueParked is retired: a park saves its block's work on a branch and appends one entry that links it to the block's file in the backlog folder. Continue that work through the backlog entry: once its "- decision:" is ACTIONABLE, build its file as a fix-mode block, and that block's round-1 developer restores the branch's work (develop guide, "Working the backlog"). Drop this key. Got continueParked ${JSON.stringify(A.continueParked)}.`);
}
const CONTEXT_ROWS = A.plans.map((p, i) => [p, i])
  .filter(([p]) => p?.planContext !== undefined)
  .map(([p, i]) => (typeof p.id === 'string' ? p.id : `index ${i}`));
if (CONTEXT_ROWS.length) {
  throw new Error(`args.plans[].planContext is retired: plans [${CONTEXT_ROWS.join(', ')}] carry it. Every agent gets its block through the plan-block command, which already names the whole plan file for neighbour context, so drop the key.`);
}

const ROLE_KEYS = ['develop', 'park', 'quality', 'acceptance', 'sweep'];
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'high';
// Static lead clauses: gen-flows labels each throw node from them. A role map that coerced would send an
// agent to an unintended model or effort, and the run would never say so.
const roleMap = (name, value, legal) => {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid role map: args.${name} must be an object that maps a role key to a value; got ${JSON.stringify(value)}.`);
  }
  const entries = Object.entries(value);
  for (const [role, setting] of entries) {
    if (!ROLE_KEYS.includes(role)) {
      throw new Error(`Unknown role key in a role map: args.${name} names ${JSON.stringify(role)}, and the role keys are ${ROLE_KEYS.join(' | ')}.`);
    }
    if (!legal.has(setting)) {
      throw new Error(`Illegal role value in a role map: args.${name}.${role} is ${JSON.stringify(setting)}, and it must be one of ${[...legal].join(' | ')}.`);
    }
  }
  return Object.fromEntries(entries);
};
// park has no default: it follows its block's developer.
// The blind critic is opus because the fast tier surfaced one deep defect per round on large diffs. Sweep is
// opus too: the runtime relays the launching user message to every agent, and a sonnet agent may follow it over its task.
const M  = { develop: 'opus', quality: 'opus', acceptance: 'opus', sweep: 'opus', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { develop: DEFAULT_EFFORT, quality: DEFAULT_EFFORT, acceptance: DEFAULT_EFFORT, sweep: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
// Set an agentType only when it exists in your registry.
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], effort: EF[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

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
const isAbsolute  = (p) => /^([a-zA-Z]:)?\//.test(p);
const abs         = (p) => { const n = norm(p); return (ROOT && !isAbsolute(n)) ? `${ROOT}/${n}` : n; };
// A long slug keeps a hash of its full form: two block ids sharing a 60-char prefix would otherwise share
// every run-state file, the DISMISSED ledger, the backlog file and the unfinished branch included.
const fnv1a       = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const slug        = (s) => {
  const full = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (full.length <= 60) return full;
  return `${full.slice(0, 51).replace(/-$/, '')}-${fnv1a(full)}`;
};
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo);                      // absolute path to the target git repo (required)
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
// Windows folds case in a drive or UNC path, so E:/Repo/x lies inside e:/repo there.
// A POSIX path keeps its case, so a macOS spelling in another case draws no warning.
const pathKey     = (p) => (/^(?:[a-zA-Z]:\/|\/\/)/.test(p) ? p.toLowerCase() : p);
const insideRepo  = (p) => {
  const path = pathKey(p);
  const repo = pathKey(REPO);
  return path === repo || path.startsWith(`${repo}/`);
};
// Run-state inside the target repo puts the review and ledger files in the blind reviewer's reach (#3).
if (insideRepo(STATE_DIR)) {
  logLine(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the review/ledger files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
// An installed plugin keeps tools/ in its cache and ROOT in its data dir, so args.blockTool names the tool.
// Without it every block command exits non-zero and the run halts on plan_obtained=false.
const BLOCK_TOOL  = A.blockTool ? abs(A.blockTool) : `${ROOT}/tools/plan-block.mjs`;
const toolPath    = (name) => BLOCK_TOOL.replace(/[^/]*$/, name);
// The project's one backlog folder, shared by every run on the repo, so the operator passes the folder the
// project-settings tool names rather than one this engine derives.
const backlogCommand = (root) => `node '${toolPath('project-settings.mjs')}' backlog --root '${root}' --repo '${REPO}'`;
const BACKLOG_DIR = typeof A.backlogDir === 'string' ? norm(A.backlogDir) : '';
if (!isAbsolute(BACKLOG_DIR)) {
  throw new Error(`Missing or relative args.backlogDir: pass the ABSOLUTE folder that \`${backlogCommand(ROOT)}\` prints. The developer, fix acceptance and closing acceptance append there what a block leaves for later. Got ${JSON.stringify(A.backlogDir)}.`);
}
if (insideRepo(BACKLOG_DIR)) {
  throw new Error(`args.backlogDir is inside the target repo. The developer's writes there would join the unstaged diff that the blind reviewer judges, acceptance stages and park clears. Got ${BACKLOG_DIR}, inside ${REPO}. Pass the folder that \`${backlogCommand('<dir>')}\` prints for a <dir> outside the target repo.`);
}

// =============================================================================
// File-level keys, spread from what `plan-edit.mjs args` prints. A typed value outside the set throws: the
// string "false" is truthy.
// =============================================================================
if (A.ordered != null && typeof A.ordered !== 'boolean') {
  throw new Error(`Invalid ordered key: args.ordered must be a boolean; got ${JSON.stringify(A.ordered)}. It decides whether a PARKED block stops the run, and the string "false" is truthy — spread what "plan-edit.mjs args <planPath>" prints.`);
}
const ORDERED = A.ordered === true;
const VALID_SUITE = new Set(['green', 'scoped']);
if (A.suite != null && !VALID_SUITE.has(A.suite)) {
  throw new Error(`Invalid suite key: args.suite must be green | scoped; got ${JSON.stringify(A.suite)}. It decides whether a reddened EXISTING suite fails a green gate, so it must never coerce — spread what "plan-edit.mjs args <planPath>" prints.`);
}
const SUITE = A.suite ?? 'green';
const VALID_SWEEP = new Set(['goal-coverage', 'none']);
if (A.sweep != null && !VALID_SWEEP.has(A.sweep)) {
  throw new Error(`Invalid sweep key: args.sweep must be goal-coverage | none; got ${JSON.stringify(A.sweep)}. It decides whether the run ends with a whole-goal coverage check — spread what "plan-edit.mjs args <planPath>" prints.`);
}
const SWEEP_MODE = A.sweep ?? 'none';
if (A.goal != null && typeof A.goal !== 'string') {
  throw new Error(`Invalid goal key: args.goal must be a string; got ${JSON.stringify(A.goal)}. It is the goal line every agent is framed with and the sweep's re-grep seed — spread what "plan-edit.mjs args <planPath>" prints.`);
}
const GOAL = A.goal ?? '';
// The sweep re-derives its surface from the goal, so a goalless sweep would run with nothing to cover.
if (SWEEP_MODE === 'goal-coverage' && !GOAL.trim()) {
  throw new Error('Missing goal key: args.sweep is goal-coverage but args.goal is empty, so the sweep would re-derive its surface from nothing. Add a "goal:" file key to the plan file (or "sweep: none"), then spread what "plan-edit.mjs args <planPath>" prints.');
}

// =============================================================================
// Plans: thin routing entries in build order. The block body lives in its plan file.
// =============================================================================
const RAW = A.plans;
const VALID_MODES  = new Set(['feature', 'section', 'fix']);
// A fix block's gate is green ONLY: its entries are defects in working code, so a build-only or
// red-baseline fix would stage a "closed" issue nothing ever ran.
const MODE_GATES   = { feature: new Set(['green', 'build-only']), section: new Set(['green', 'red-baseline', 'build-only']), fix: new Set(['green']) };
// `parked` is what an older engine wrote for a park, so a plan file that still holds it stays valid.
const VALID_STATUS = new Set(['todo', 'done', 'skip', 'backlogged', 'parked', 'blocked']);

// Throw, not filter: dropping an entry with no id builds a shorter roadmap and reports success.
const NO_ID = RAW.map((p, i) => [p, i])
  .filter(([p]) => !p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim())
  .map(([, i]) => i);
if (NO_ID.length) {
  throw new Error(`plans entries at index [${NO_ID.join(', ')}] are not objects carrying a string id. Every entry is a "plans" row that "plan-edit.mjs args <planPath>" prints — { id, planPath, mode, gate, status } — or a pass that "plan-edit.mjs args --pack" prints.`);
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

// A typed model or effort the runtime may not know would fail the developer call mid-run, after earlier blocks were accepted.
const BAD_MODELS = RAW.filter((p) => p.model != null && !VALID_MODELS.has(p.model))
  .map((p) => `${p.id}: ${JSON.stringify(p.model)}`);
if (BAD_MODELS.length) {
  throw new Error(`plan model(s) [${BAD_MODELS.join(', ')}] are not one of opus | sonnet | haiku | fable. A model picks its block's developer, so an unrecognized value must never coerce. Omit the field entirely to take the run's models.develop.`);
}

const BAD_EFFORTS = RAW.filter((p) => p.effort != null && !VALID_EFFORTS.has(p.effort))
  .map((p) => `${p.id}: ${JSON.stringify(p.effort)}`);
if (BAD_EFFORTS.length) {
  throw new Error(`plan effort(s) [${BAD_EFFORTS.join(', ')}] are not one of low | medium | high | xhigh | max. An effort sets its block's developer reasoning level, so an unrecognized value must never coerce. Omit the field entirely to take the run's efforts.develop.`);
}

// `status` is what the todo filter selects on, so a typo is a block silently skipped (or, worse, a
// finished one rebuilt over its own accepted baseline). Omitted keeps the 'todo' default.
const BAD_STATUS = RAW.filter((p) => p.status != null && !VALID_STATUS.has(p.status))
  .map((p) => `${p.id}: ${JSON.stringify(p.status)}`);
if (BAD_STATUS.length) {
  throw new Error(`plan status(es) [${BAD_STATUS.join(', ')}] are not one of todo | done | skip | backlogged | parked | blocked. Status drives which blocks this run builds, so an unrecognized value must never coerce. Omit the field entirely to take the todo default.`);
}

// A commit's entire message is its block's title, and git joins a multi-line subject into one line.
const BAD_TITLES = COMMIT
  ? RAW.filter((p) => p.title !== undefined && (typeof p.title !== 'string' || !p.title.trim() || /[\r\n]/.test(p.title)))
    .map((p) => `${p.id}: ${JSON.stringify(p.title)}`)
  : [];
if (BAD_TITLES.length) {
  throw new Error(`plan title(s) [${BAD_TITLES.join(', ')}] are not one line of text. In commit mode a block's title is its commit's entire message, so it never coerces. Spread what "plan-edit.mjs args <planPath>" prints: each row carries its block's header title.`);
}

const ALL_PLANS = RAW.map((p) => ({
  id: String(p.id),
  // plan-block.mjs falls back to the id for a header with no title.
  title: (typeof p.title === 'string' && p.title.trim()) || String(p.id),
  planPath: p.planPath ? abs(p.planPath) : '',
  mode: p.mode,
  gate: p.gate ?? 'green',
  status: p.status ?? 'todo',
  model: p.model ?? null,
  effort: p.effort ?? null,
  blocks: p.blocks ? p.blocks.map((b) => ({ id: b.id, planPath: abs(b.planPath), issues: b.issues })) : null,
}));

// An empty plan path would have the developer build against nothing and report success.
const NO_PATH = ALL_PLANS.filter((p) => !p.planPath && !p.blocks).map((p) => p.id);
if (NO_PATH.length) {
  throw new Error(`plans [${NO_PATH.join(', ')}] carry no planPath — the developer would be handed an empty plan reference. Derive the args with "plan-edit.mjs args <planPath>" and spread the object it prints: every row it prints carries its own planPath.`);
}

// Pass members count too: every run-state file is keyed by the bare id.
const SEEN_IDS = new Set();
const DUPE_IDS = new Set();
for (const id of ALL_PLANS.flatMap((p) => [p.id, ...(p.blocks ?? []).map((b) => b.id)])) {
  if (SEEN_IDS.has(id)) DUPE_IDS.add(id);
  SEEN_IDS.add(id);
}
if (DUPE_IDS.size) {
  throw new Error(`duplicate plan id(s) [${[...DUPE_IDS].join(', ')}] in args.plans. Every per-block run-state file (reviews, DISMISSED, AMENDED, backlog file, unfinished branch) is keyed by the bare id, so duplicates would overwrite each other.`);
}

// The sweep reads these. A plan file in the target repo has run-state's exposure (#3). Warn, not throw: a
// throw strands a run the operator may still want.
const PLAN_FILES = [...new Set(ALL_PLANS.flatMap((p) => (p.blocks ? p.blocks.map((b) => b.planPath) : [p.planPath])))];
for (const path of PLAN_FILES.filter(insideRepo)) {
  logLine(`⚠ plan file (${path}) resolves inside the target repo — the blind quality reviewer could read the spec straight out of the repo tree, and the diff/park machinery could sweep it. Move the plan under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path — never one inside the target repo.`);
}

// A parser decides where the block ends: plan bodies use `##` headers, so an agent reading the file by eye
// can stop at the first `## Feature` and build a truncated spec.
const blockRef = (p) => (p.blocks ? passRef(p) : `the output of:  node '${BLOCK_TOOL}' '${p.planPath}' '${p.id}'
Run it. Redirect its output to a file under ${STATE_DIR}/scratch/ (create it if needed), never inside the
target repo or ${GATE_DIR}/, and read that file, since the Bash display cuts long output. That output is
the block, verbatim. If it exits non-zero, report plan_obtained=false and STOP: never guess at a plan you
could not read. The full plan file is at
${p.planPath} if you need a neighbouring block for context; your block is ONLY "${p.id}"`);
const passRef = (p) => `the output of each command below, one block per command:
${p.blocks.map((b) => `  node '${BLOCK_TOOL}' '${b.planPath}' '${b.id}'`).join('\n')}
Run every one, each redirected to its own file under ${STATE_DIR}/scratch/ (create it if needed), never
inside the target repo or ${GATE_DIR}/, and read those files, since the Bash display cuts long output.
Each output is one block, verbatim. If any exits non-zero, report plan_obtained=false and STOP: never
guess at a plan you could not read. Your blocks are ONLY ${p.blocks.map((b) => `"${b.id}"`).join(', ')}`;

// Blindness is placement, not instruction (#3). STATE_DIR holds acceptance reviews, AMENDED files,
// NEEDS-USER and DECISIONS, all routes to plan text. No path outside GATE_DIR ever enters the blind reviewer's prompt.
const GATE_DIR       = `${STATE_DIR}/gate`;                     // everything the BLIND quality reviewer reads or writes
const qualityFile    = (id, r) => `${GATE_DIR}/quality-review-${slug(id)}-r${r}.md`;
const acceptanceFile = (id, r) => `${STATE_DIR}/acceptance-review-${slug(id)}-r${r}.md`;
// The developer's own judgment of its round, so it stays outside GATE_DIR, where it would anchor the blind reviewer.
const riskFile       = (id, r) => `${STATE_DIR}/risk-${slug(id)}-r${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;            // full detail; for the user (may halt the run) — GLOBAL/cumulative
// Only an ordered run halts on a developer's question. An unordered run carries on past it, so the question
// goes to a file of its block's own, which park copies into the block's backlog entry.
const questionFile   = (id) => (ORDERED ? NEEDS_USER : `${STATE_DIR}/question-${slug(id)}.md`);
// Defaults the developer took, plan amendment pointers and the LOGGED_FIX_TAG lines, for the user to read,
// never a question.
const DECISIONS_NAME = 'DECISIONS.md';
const DECISIONS      = `${STATE_DIR}/${DECISIONS_NAME}`;
const dismissedName  = (id) => `DISMISSED-${slug(id)}.md`;
const dismissedFile  = (id) => `${GATE_DIR}/${dismissedName(id)}`;  // terse ledger; developer → reviewers (anti-spin) — PER BLOCK
// MATRIX 6a overrides, read by acceptance and the sweep. It quotes plan text, so it stays outside GATE_DIR.
const amendedFile    = (id) => `${STATE_DIR}/AMENDED-${slug(id)}.md`;
const commitFile     = (id) => `${STATE_DIR}/commit-${slug(id)}.txt`;  // commit mode: the block's title, the commit's message
// Park's copy of the repo's index, so building the branch's commit never writes the index that holds the accepted baseline.
const parkIndexFile  = (id) => `${STATE_DIR}/scratch/park-${slug(id)}.index`;
const parkMessageFile = (id) => `${STATE_DIR}/scratch/park-${slug(id)}.msg`;  // the branch commit's message, so no shell quoting touches the title
const SWEEP_FILE     = `${STATE_DIR}/SWEEP.md`;                 // final whole-goal completeness sweep
// A closed inventory is what lets a fix loop converge, so an entry found mid-run goes to the backlog and never joins the running inventory.
// One fixed file per source block, so its triage never waits on another block's relaunch. Every run on the
// project shares the folder, and two (runId, block id) pairs can slug and join alike, such as run "a" with
// block "b-c" and run "a-b" with block "c", so the name ends in a hash of the raw pair.
const RUN_SLUG       = slug(RUN_ID) || `run-${fnv1a(String(RUN_ID))}`;
// The file's block id, and its entries' id prefix.
const backlogId      = (id) => `${RUN_SLUG}-${slug(id)}-${fnv1a(JSON.stringify([String(RUN_ID), String(id)]))}`;
const backlogFile    = (id) => `${BACKLOG_DIR}/${backlogId(id)}.md`;
// A parked block's work, one commit per park, kept in the repo so it outlives the run worktree. A backlog id
// is a kebab slug, so the name is a valid ref name.
const unfinishedBranch = (id) => `aipg-unfinished/${backlogId(id)}`;

// The blind variant (canContest=true) reads DISMISSED alone (see GATE_DIR) and may contest it. Only it
// forbids prior reviews, which would anchor it (#5). Acceptance overrides instead.
const SETTLED = (id, canContest) => `Before reviewing, READ ${canContest ? 'this if it exists. It holds' : 'these if they exist. They hold'} the settled decisions:
  • ${dismissedFile(id)} — findings the developer declined for THIS block, each with a one-line reason.
    It exists only once the developer has declined something, so a missing file means nothing is
    settled yet. Do not search for it elsewhere.${canContest ? '' : `
  • ${questionFile(id)} — items already escalated to the user.
  • ${DECISIONS} — defaults the developer took, plan amendment pointers, and one line per ${BASELINE_FIX} that
    this run's ${CHANGE_POLICY} change policy let the developer make, a record. A
    ${LOGGED_FIX_TAG} line is never skipped for its stated reason, since the regression rule below judges each one.`}
Skip anything listed there FOR THE STATED REASON. A DISMISSED line covers exactly what it names: one place, or every place in the class it names. ${canContest ? 'Do NOT read prior review files, apart from the overwrite read the WRITE step names. ' : ''}Review the CURRENT
diff FRESH, catching new or nearby issues.${canContest ? `
If you are confident a DISMISSED reason is WRONG, at any tier, raise the finding ONCE, prefixed
"CONTESTS DISMISSAL:", explaining why the reason does not hold.` : ` Read prior review files only at your
EARLIER FINDINGS step below. The one exception is the file the WRITE step names. Read it only at the WRITE step, so the Write tool
accepts the overwrite, and never use its content.`}`;

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
// A fix worker returns per-issue `results`, from which the engine derives whether a round closed anything,
// so a round that only SKIPPED entries cannot claim work it never did. `closing` marks the closing pass.
const developSchema = (mode, closing) => ({
  type: 'object',
  required: ['plan_obtained', 'baseline_dirty_files', ...(COMMIT ? ['baseline_staged_files'] : []), ...(mode === 'fix' ? ['results', 'restore_failed', 'restored_branches'] : []), 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'needs_user', 'plan_amendments', 'backlog_entries', 'backlog_blocks', 'review_needed', ...(closing ? ['recorded_entries'] : [])],
  properties: {
    plan_obtained:     { type: 'boolean', description: 'true if you HAVE your block text: the plan-block command exited 0 and printed it. A failed command means FALSE. Never fall back to locating your block by eye in the plan file. FALSE halts the run.' },
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files had UNSTAGED or untracked changes BEFORE you touched anything (staged files never count). 0 = clean, >0 HALTS the run. Report -1 on later rounds.' },
    // Commit mode only: acceptance's commit would carry anything staged, which no reviewer reads.
    ...(COMMIT ? {
      baseline_staged_files: { type: 'integer', description: 'ROUND 1 ONLY: how many files were STAGED BEFORE you touched anything. 0 = clean, >0 HALTS the run. Report -1 on later rounds.' },
    } : {}),
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
    } : {}),
    // Required, since an omitted judgment must never read as low risk. The engine treats a non-boolean as true.
    review_needed:     { type: 'boolean', description: 'your CLASSIFY phase\'s verdict: true when any change this round made is not low risk under the RISK QUESTIONS, false only when every change is low risk (a round that changed nothing is false)' },
    ...(closing ? {
      recorded_entries: { type: 'array', items: { type: 'string' }, description: 'the id of each backlog entry you listed for a finding or gap whose fix is not low risk, whether you appended it or the dedup found it already there ([] when none)' },
    } : {}),
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed', 'failed-expected', 'failed-unexpected', 'not-run'], description: 'passed = the required verification ran and PASSED. failed = it ran and failed. failed-expected = a red baseline exactly as a test-first block intends. failed-unexpected = failed for a WRONG reason (a real defect / bad fixture). not-run = no verification executed.' },
    tests_run_count:   { type: 'integer', description: 'the count of tests, or of assertions for a runner that counts those, the runner REPORTS as executed for this block\'s run (0 = nothing ran = a FALSE green; -1 = N/A, e.g. manual/MCP verification). When you ran both this block\'s verification and the full test gate, report the count of this block\'s verification: its `test_selector:` run when the block has one, else the test gate.' },
    full_suite_outcome:{ type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened. "scoped-skip" when this run is scoped to each block\'s own selector.' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q", "phpunit --filter Bar", "curl localhost:3000/health"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add -N on new files only). Anything you staged is reviewed by NOBODY: say false rather than claim it. False HALTS the run.' },
    needs_user:        { type: 'boolean', description: 'true ONLY if a HARD blocker / user-only decision stopped you; you wrote a full entry to the question file your prompt names and cannot proceed' },
    // Fix mode only: a branch the round-1 restore could not apply stops the block before any review.
    ...(mode === 'fix' ? {
      restore_failed: { type: 'string', description: 'ROUND 1 ONLY: the branch whose restore failed and why (missing, or the `git apply` error), or "" when every restore applied or none was due. Report "" on later rounds.' },
      restored_branches: { type: 'integer', description: 'ROUND 1 ONLY: how many branches your restore applied into the tree. 0 when none was due or a restore failed. Report 0 on later rounds.' },
    } : {}),
    dismissed_count:   { type: 'integer', description: 'how many review findings you declined and logged to this block\'s DISMISSED file this round (0 if none)' },
    // Required, unlike dismissed_count: an omitted field must not read as "none this round".
    plan_amendments:   { type: 'integer', description: 'entries you appended to this block\'s AMENDED file this round (MATRIX 6a). Report 0 when there were none.' },
    // Acceptance's fix and closing schemas declare the same two fields. Each schema writes them out, since
    // tests/static.test.mjs reads only the fields a schema declares itself.
    backlog_entries:   { type: 'integer', description: 'entries you appended this round to the backlog files your prompt names (0 if none)' },
    backlog_blocks:    { type: 'array', items: { type: 'string' }, description: 'the id of every block whose backlog file you appended to this round ([] if none)' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
});

const QUALITY_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'clean', 'issue_count'],
  properties: {
    wrote_file:  { type: 'boolean', description: 'true ONLY if you wrote your review file this round' },
    clean:       { type: 'boolean', description: 'true if you found no finding at any tier and contested no dismissal' },
    issue_count: { type: 'integer', description: 'every finding written to the review file, at every tier from critical down to nit' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED entries you re-raised as "CONTESTS DISMISSAL:" this round (0 if none)' },
  },
};

const CLOSING_PASS_TERM = 'true if your review file holds no blocking gap under the CLOSING BAR your prompt states, nothing regressed, and you appended each not blocking gap that no open backlog entry already holds';
const STAGED_TERM = `true if you ran \`git add\` on this block's files, or on a LEGITIMATE NO-OP pass whose diff is empty (only on pass; ${COMMIT ? 'then commit as your prompt says' : 'NEVER commit'})`;
// `closing` marks the closing acceptance, whose pass bar is no blocking gap and which writes each gap it leaves to the backlog.
const acceptanceSchema = (mode, closing) => {
  // Per mode, because the descriptions are each frame's acceptance contract.
  // `|| {}` lets tests/static.test.mjs evaluate the schema with no mode to read its field names.
  const terms = {
    feature: {
      pass: 'true if every acceptance criterion is met, the feature is reachable, gates are green, every earlier finding is closed or declined, the risk audit is clean, and nothing regressed',
      staged: STAGED_TERM,
      reachable: 'the feature is actually wired in / reachable from the app entry points',
      suite: 'observed outcome of running the FULL gates',
    },
    section: {
      pass: 'true if every acceptance criterion of THIS block is met, it is reachable, the block gate is satisfied, every earlier finding is closed or declined, the risk audit is clean, and nothing regressed',
      staged: STAGED_TERM,
      reachable: 'this block\'s change is actually wired in / reachable — every call site converted, route mounted, symbol exported',
      suite: 'observed outcome of running the block gate (and, where the goal expects it, the full gates)',
    },
    fix: {
      pass: 'true if every claimed fix fully closes its root cause, every STALE claim is confirmed absent from the current code, no entry outside the ACTIONABLE set was touched, every earlier finding is closed or declined, the gate is green, the risk audit is clean, and nothing regressed',
      staged: STAGED_TERM,
      suite: 'observed outcome of running the FULL gates',
    },
  }[mode] || {};
  const backlogFields = {
    backlog_entries: { type: 'integer', description: 'entries you appended this round to the backlog files your prompt names (0 if none)' },
    backlog_blocks: { type: 'array', items: { type: 'string' }, description: 'the id of every block whose backlog file you appended to this round ([] if none)' },
  };
  return {
    type: 'object',
    required: [...(mode === 'fix'
      ? ['plan_obtained', 'wrote_file', 'pass', 'staged', 'earlier_reviews_read', 'risk_misclassified', 'fix_checks', 'backlog_entries', 'backlog_blocks', 'branches_kept']
      : ['plan_obtained', 'wrote_file', 'pass', 'staged', 'earlier_reviews_read', 'risk_misclassified', 'reachable', 'evidence_recorded', ...(closing ? ['backlog_entries', 'backlog_blocks'] : [])]),
    ...(COMMIT ? ['committed', 'commit_sha', 'commit_subject', 'tree_matches', 'tree_clean'] : [])],
    properties: {
      // Commit mode only: landingChecks reads these, and any failed check halts the run.
      ...(COMMIT ? {
        committed: { type: 'boolean', description: 'true when this block\'s commit exists, or on a LEGITIMATE NO-OP pass that made no commit. false when you made no commit on a pass, such as when a hook or signing refused it, and on every fail' },
        commit_sha: { type: 'string', description: 'the new commit\'s sha (`git log -1 --format=%H`), or "" when you made no commit' },
        commit_subject: { type: 'string', description: 'the new commit\'s subject (`git log -1 --format=%s`), or "" when you made no commit' },
        tree_matches: { type: 'boolean', description: 'true when the new commit\'s tree (`git log -1 --format=%T`) is the tree id `git write-tree` printed before you committed, or on a LEGITIMATE NO-OP pass that made no commit' },
        tree_clean: { type: 'boolean', description: 'true when `git status --porcelain` printed nothing after your commit step' },
      } : {}),
      plan_obtained: { type: 'boolean', description: 'true if you HAVE the block text you judge against: the plan-block command exited 0 and printed it. A failed command means FALSE. Never fall back to locating the block by eye. FALSE halts the run.' },
      wrote_file:  { type: 'boolean', description: 'true ONLY if you wrote your review file this round' },
      pass:        { type: 'boolean', description: closing ? CLOSING_PASS_TERM : terms.pass },
      staged:      { type: 'boolean', description: terms.staged },
      earlier_reviews_read: { type: 'integer', description: 'how many of the earlier review files your prompt lists you read in full (0 when it lists none)' },
      risk_misclassified: { type: 'boolean', description: 'true if your RISK AUDIT found a risk file or its Snapshot line missing, a change it judges not low risk, or an answer the hunks of its round contradict (false when your prompt lists no risk file)' },
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
        ...backlogFields,
        branches_kept: { type: 'array', items: { type: 'string' }, description: 'each landed branch that still exists after the LANDED BRANCHES step: one its `git branch -D` left behind in commit mode, every one it listed in stage mode ([] when none)' },
      } : {
        reachable:   { type: 'boolean', description: terms.reachable },
        evidence_recorded: { type: 'boolean', description: 'true ONLY if EVERY met criterion carries a locator (file:line / test name / command output) written in the review file' },
        ...(closing ? backlogFields : {}),
      }),
      regression:  { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/accepted behavior' },
      gap_count:   { type: 'integer', description: closing ? 'number of blocking gaps written to the review file (0 on pass)' : 'number of unmet criteria / gaps written to the review file (0 on pass)' },
      suite_result:{ type: 'string', description: terms.suite },
    },
  };
};

// Park saves then clears, so every exit leaves a clean tree and the round-1 clean-baseline check holds
// unconditionally, resume included.
// Per mode, because only a fix block's park supersedes the branches its round 1 restored.
const parkSchema = (mode) => ({
  type: 'object',
  required: ['saved', 'cleared', 'gates_green', 'commit_sha', 'entry_written', ...(mode === 'fix' ? ['superseded_entries'] : [])],
  properties: {
    saved:       { type: 'boolean', description: 'true ONLY if step 1 made the commit, the branch points at it, and its tree differs from its first parent\'s tree. If false over work in the tree, you must NOT have cleared the tree.' },
    cleared:     { type: 'boolean', description: 'true if `git diff` is empty and no untracked file the block created remains after step 2, including a tree that held no work' },
    gates_green: { type: 'boolean', description: 'true if the BUILD gate passes again after clearing (the tree is safe for what comes next)' },
    commit_sha:  { type: 'string', description: 'the full id of the commit step 1 made, as commit-tree printed it, or "" when it made none' },
    entry_written: { type: 'boolean', description: 'true ONLY if step 3 appended the backlog entry and the tool reported success' },
    ...(mode === 'fix' ? {
      superseded_entries: { type: 'array', items: { type: 'string' }, description: 'the id of each entry whose RESTORED branch step 1 deleted, or [] when step 1 made no commit or deleted none' },
    } : {}),
    notes:       { type: 'string' },
  },
});

const SWEEP_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'complete', 'gap_count', 'suite_result'],
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
restate large files back.
Write every scratch file, such as a plan block or a test log, under ${STATE_DIR}/scratch/, never under ${GATE_DIR}/.`;

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to
// overwrite a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';

// A file key, not a mode: suite:scoped allows the mid-run red a test-first migration expects.
const SUITE_LINE = SUITE === 'green'
  ? 'Also run the FULL suite to confirm you did not redden it (report full_suite_outcome). When the verification command is already the full suite, its one run counts for both, and full_suite_outcome reports that run.'
  : 'Do NOT chase whole-suite green — only THIS block\'s scoped tests matter; the rest of the suite may be intentionally red mid-run. Report full_suite_outcome="scoped-skip".';
const ACC_SUITE_LINE = SUITE === 'green'
  ? 'The EXISTING suite must still be green — reddening it is a regression, not an accepted block.'
  : 'Do NOT treat the intentionally-red rest of the suite as a failure: judge THIS block on its own selector.';

// Where each mode keeps the accepted baseline. Commit mode commits each accepted block, so nothing stays staged.
const BASELINE_DEF = COMMIT ? 'HEAD, which holds each accepted block as its own commit' : 'the staged index, or HEAD when nothing is staged';
// No reviewer reads the index, so staged work escapes review in both modes. Only what then carries it differs.
const STAGED_HARM = COMMIT ? 'where no reviewer reads it and the next commit carries it' : 'into the accepted baseline';
// Acceptance compares the unstaged diff against this for regressions.
const ACC_BASELINE_LINE = COMMIT
  ? 'HEAD = accepted baseline, each accepted block one commit (compare against it for regressions).'
  : `\`git -C ${REPO} diff --staged\` = accepted baseline (compare against it for regressions).`;

// The closing pass takes the number after the last round, so its files sort after every round's.
const CLOSING_ROUND = MAX_ROUNDS + 1;
// A halt reason names the closing pass, since its file-name number exceeds the round budget the operator set.
const roundName = (round) => (round === CLOSING_ROUND ? `the closing pass (round ${round} in its file names)` : `round ${round}`);
// Names the round so an agent that finds no file for a round does not take the gap for an error.
const ROUND_NOTE = (round) => `${round === CLOSING_ROUND
  ? `This is the closing pass, numbered round ${round} in its file names, after round ${MAX_ROUNDS} of at most ${MAX_ROUNDS}.`
  : `This is round ${round} of at most ${MAX_ROUNDS}.`} Round numbers count develop rounds, so a later stage has no file for a round that an earlier stage sent back. Of the rounds that reach the blind review stage, the blind review runs on the block's first one in this launch, and on a later one only when a round since the block's last blind review judged a change not low risk or gave no judgment, or an acceptance verdict since then found a risk judgment wrong. Every other round has no blind review file. The closing pass, the one developer pass that follows round ${MAX_ROUNDS} when that round ends without acceptance staging the block, reaches the blind review stage whatever its gate, and no develop round follows it. A round file of this block that this prompt does not name may come from an earlier launch of the block, so ignore it.`;

// Every agent also loads the user's CLAUDE.md and auto memory, either of which may set scope another way.
// The prompt's own scope rules, 6a's PRECEDENCE included, carry the policy out, so they are not "other".
const POLICY_LINE = `CHANGE POLICY: ${CHANGE_POLICY}. This policy and the scope rules in this prompt that carry it out settle scope for this run and override any other instruction about scope, including a memory line or a CLAUDE.md.`;
const OWNED_CODE = 'in code no other block of the plan owns';
const UNCLAIMED_CODE = `in code this block's text does not exclude and ${OWNED_CODE}`;
// The CODE ZONES bound every change, so this line names the build's aim and the other-block rule.
const PROACTIVE_BUILD = `with the change that has the best long-term result: correct, simple, maintainable and consistent
with the repo. Leave a change that another block of the plan owns to that block.`;

// One map of the code for the developer's routing and acceptance's regression items, so they cannot drift.
// Connected code is keyed on the task code, never on the developer's own fixes, so a fix cannot widen it.
// A fix block's task code holds each root cause's sibling paths this block may change, since fix acceptance
// requires them closed.
const taskCode = (mode) => (mode === 'fix'
  ? `the code each ACTIONABLE entry's fix adds or changes, and the sibling paths of each ACTIONABLE entry's root cause that lie ${UNCLAIMED_CODE}.
    Every line an ACTIONABLE entry's fix adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding`
  : `the code this block's required changes add or change.
    Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding`);
const CODE_ZONES = (mode) => `CODE ZONES - every piece of code lies in one of three zones:
  - Task code: ${taskCode(mode)}.
  - Connected code: the code a reach step from the task code finds, which is its callers and consumers,
    its sibling paths with the same mechanism, duplicates of the same logic, and the comments and docs
    that describe it, apart from code this block's text excludes or another block of the plan owns.
  - Other code: everything else.`;
// A fix block's entries are its only scope, so under both policies it leaves to the backlog a defect in
// connected code that its diff neither introduces nor exposes.
const fixesConnected = (mode) => PROACTIVE && mode !== 'fix';
// Where acceptance excuses a fix of a defect, in the words both its items and the developer's SELF-REVIEW use.
const changeZones = (mode) => (fixesConnected(mode)
  ? 'in task code or in connected code'
  : 'in task code, or in connected code where the change closes a defect the diff introduces or exposes');
const ZONE_ROUTING = (mode) => `ZONE ROUTING - what you fix in each zone under this run's ${CHANGE_POLICY} change policy. A pre-existing
  finding is one the accepted baseline already had that the diff neither introduces nor exposes.
  - Task code: hunt it, and fix every finding in it at every tier, a defect the accepted baseline already
    had included.
  - Connected code: fix a finding the diff introduces or exposes there.
    ${fixesConnected(mode) ? `Fix a pre-existing defect there when its fix is low risk under the RISK QUESTIONS below,
    and leave every other pre-existing finding there unchanged.` : 'Leave every pre-existing finding there unchanged.'}
  - Other code: never change it. Close a finding the diff introduces or exposes there, such as a build
    break or a regression, at its source in task or connected code. When only a change in other code
    closes it, ESCALATE it (7).
  Never hunt outside task code. Read connected code to check your change's effects, and route what you
  notice there by these rules. A fix still follows the DECISION MATRIX's rules for a plan conflict
  (6a, 6b) and a user-only choice (7). Rule 2 of the DECISION MATRIX drops each pre-existing finding
  these rules do not fix, and RECORD below says which of them get a backlog entry.`;
// A fix of a baseline defect that no requirement names changes a baseline behavior, so acceptance needs the
// developer's DECISIONS line to tell it from a regression.
const LOGGED_FIX_TAG = PROACTIVE ? 'PROACTIVE' : 'FOCUSED';
const BASELINE_FIX = 'fix of a defect already in the accepted baseline';
// What makes a behavior change part of the block's work, in acceptance's regression rule and the logged-fix line.
const requiredBy = (mode) => (mode === 'fix' ? 'an ACTIONABLE entry' : 'a criterion of this block');
// The source of a construction the developer must follow, in the DECISION MATRIX's regression bullet.
const prescribingText = (mode) => (mode === 'fix' ? "an entry's **Fix:** line" : "the block's text");

// PRECEDENCE must quote the frame's own scope line, or 6a outranks nothing.
const SCOPE_LINE = {
  feature: 'NO scope creep beyond the plan and the fixes the ZONE ROUTING below allows',
  section: 'NO scope creep beyond this block and the fixes the ZONE ROUTING below allows',
  fix: 'NO scope creep beyond what each fix requires and the fixes the ZONE ROUTING below allows',
};

// The developer, fix acceptance and closing acceptance each append to the project's backlog. A pass
// member's file holds only what its own entries led to, so each block's file is triaged on its own.
const backlogFileId = (p) => (p.blocks ? '<that file\'s name without .md>' : backlogId(p.id));
const backlogBlockId = (p) => (p.blocks ? '<that block\'s id>' : p.id);
const backlogEntryId = (p) => `${backlogFileId(p)}-<n>`;
// `indent` is the caller's continuation indent, so the lines sit inside the caller's step or bullet.
const backlogRoute = (p, owner, { exclusion = '', indent = '   ' } = {}) => p.blocks
  ? `only to the file of the block ${owner}${exclusion}:
${p.blocks.map((b) => `${indent}  - ${b.issues.join(', ')} → ${backlogFile(b.id)} (block "${b.id}")`).join('\n')}
${indent}Count it in backlog_entries and name that block in backlog_blocks.`
  : `to ${backlogFile(p.id)} only${exclusion}.
${indent}Count it in backlog_entries and name "${p.id}" in backlog_blocks.`;
const headerLines = (fileId, blockId) => `A new file starts with the four lines "## Plan: ${fileId} - backlog from block ${blockId} of run ${RUN_ID}", "mode: fix", "gate: green" and "status: todo", then a blank line.`;
const backlogHeader = (p) => headerLines(backlogFileId(p), backlogBlockId(p));
// The folder keeps earlier runs' built files, so an entry that says fixed or stale holds no work, and a
// defect it names that is live again gets a new entry.
const grepBacklog = (pathOf, nameAt) => `grep the *.md files in ${BACKLOG_DIR}/ for ${pathOf} and for the name of the function or identifier at ${nameAt}, and read each entry that a grep matches`;
const backlogDedup = (item) => `Before you append, create ${BACKLOG_DIR}/ if it does not exist, then ${grepBacklog('the path of the file the new entry names', `the ${item}`)}. Never append a ${item} that an entry there with "- status: open" or "- status: needs-attention" already holds. When the only entries that hold it say "- status: fixed" or "- status: stale", the ${item} is back in the code, so append a new entry whose **What:** names their ids.`;
// `indent` is the caller's continuation indent, as in backlogRoute.
const backlogEntryShape = (p, item, indent) => `Each entry copies the shape of debug's issue files, with n one past the highest n in that file's entry ids:
${indent}  ### [${backlogEntryId(p)}] <title>
${indent}  - id: ${backlogEntryId(p)}
${indent}  - status: open
${indent}  - file: <path>:<line>
${indent}  - severity: <low | medium | high | critical>
${indent}  - category: <category>
${indent}  - size: <trivial | small | medium | large>
${indent}  - decision: <ACTIONABLE | NEEDS_USER>
${indent}  **What:** <the ${item}, the input or path that reaches it, and its harm>
${indent}  **Fix:** <the change that closes it>`;

// The one rule every backlog writer applies to an entry's decision, so a later run builds a clear small fix
// without triage and the user sees only the entries that hold a choice.
const DECISION_RULE = `Set the entry's "- decision:" line by one rule. ACTIONABLE when the entry is a defect or a cleanup with one clear fix, its size is trivial or small, and the fix changes no user-visible behavior, stored data or public contract. NEEDS_USER otherwise, such as a feature, a refactor, a choice between fixes, a fix that changes user-visible behavior, or an entry with a **Parked with:** line. A later run builds an ACTIONABLE entry without triage, and a NEEDS_USER entry waits for the user.`;

// The hold a park puts on an entry whose code the park removes from the tree, read by the backlog triage.
const parkedWithLine = (id) => `"**Parked with:** block ${id}. Triage this entry once that block's park entry lands, or the block is accepted or dropped."`;

// Case 7's proceeding branch also writes DISMISSED: the blind reviewer never sees DECISIONS (see
// GATE_DIR), so it would flag the escalated default every round until the block parks (#5).
const MATRIX = (p, round) => {
  const { id, mode } = p;
  return `DECISION MATRIX — for each ambiguity or finding, route it yourself IN ORDER (first match wins):
  1. Not a real problem / false positive → DROP + LOG.
  2. A pre-existing finding, at any tier, that the ZONE ROUTING above does not fix → DROP + LOG.
      Never fix it (regression risk).
  3. Stops the build/tests/verification → FIX it where the ZONE ROUTING above places the fix, or
      ESCALATE it (7) where that routing says to.
  4. A finding the ZONE ROUTING above fixes, at any tier, that does not conflict with the plan → FIX.
      A conflict with the plan still goes to 6a or 6b.
  5. Needed to satisfy the spec / wire this block in → FIX (an unreachable or incomplete block is not done).
      A piece the plan's prescribed text leaves out is this case, not a conflict, so it takes no amendment.
      An exception to a rule the plan states is a conflict (6a or 6b), never a left-out piece.
  6a. Conflicts with the plan AND you VERIFIED that what the plan PRESCRIBES is itself defective (you
      reproduced it, or demonstrated the failure path, to the same evidence bar as any FIX)
      → FIX it: the verified defect outranks the prescription. LOG an amendment.
      PRECEDENCE — that verified defect also outranks the "${SCOPE_LINE[mode]}"
      instruction above and the CONVENTIONS rubric. Everywhere else the plan and the conventions
      still bind.
  6b. Conflicts with the plan but you did NOT verify it / intentional / not a real-world code path
      → DROP + LOG.
  7. A choice that changes user-visible behavior, stored data or a public contract, and that the plan,
      the code, the CONVENTIONS and a quick check cannot settle, OR a blocker you cannot resolve in scope
      → ESCALATE + LOG. Settle any other open choice yourself under 4, 5 or 8.
  8. Any other open choice: weigh its benefit (what it improves, and how likely an input reaches it)
      against its cost (diff size, regression risk, scope). Benefit clearly ahead → FIX. Benefit not
      clearly ahead, or a different block's work → DROP + LOG.
  • Every finding a review names ends FIXED, LOGGED to the DISMISSED file, AMENDED (6a) or ESCALATED (7)${round === CLOSING_ROUND ? `,
    or, in this closing pass, RECORDED as BUILD says` : ''}. None is dropped silently.
  • A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is
    truly a user-only call, ESCALATE it. A contested pre-existing finding that the ZONE ROUTING above
    does not fix goes to 7, with the default of leaving it unchanged, since that routing bounds every
    change you make. NEVER log the same dismissal twice.
  • A REGRESSION that any review of this block names, a blind review included, that the acceptance review
    counted, or that your SELF-REVIEW found is a bug, so never DROP it under 1, 2, 6b or 8. FIX it at any
    tier (6a when the fix conflicts with the plan), or ESCALATE it (7) with the default you took when only
    a change in other code closes it.
    A regression that a construction ${prescribingText(mode)} prescribes causes is fixed under 6a, with an
    amendment that cites the regression as its defect evidence. When that fix would change a choice that
    ${prescribingText(mode)} says the user made, it goes to rule 7's branch that cannot proceed, so the
    block parks with the user's question in ${questionFile(id)}.

LOGGING is your ONLY output besides code. Keep it minimal and unambiguous:
  • DROP (1, 2, 6b or 8): append ONE terse line to ${dismissedFile(id)} (create ${GATE_DIR}/ if it does not exist):
      \`<file:line, or the class of places it covers> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
    Name one place by its file:line, or the class of places the line covers, such as every caller of a
    function. The reason must hold for every place the line names.
    The blind reviewer cannot read the plan, so the reason must be decidable from the code alone: never
    cite a plan id, block id, issue id or plan clause.
    A false-positive reason cites the file:line that refutes the finding.
  • RECORD (2 or SIBLINGS): when you DROP + LOG a real pre-existing defect at low or above
    ${OWNED_CODE}, under rule 2 or as a sibling path the SIBLINGS phase leaves unchanged, also
    append ONE entry for it
    ${backlogRoute(p, "whose entry's fix led you to the defect", { indent: '    ' })}
    Write the defect's DISMISSED line too, since the blind reviewer reads that file and never this one.
    ${PROACTIVE ? 'A false positive gets no entry, and a nit dropped under rule 2 or SIBLINGS goes under CLEANUP below.' : 'A false positive and a nit dropped under rule 2 or SIBLINGS get no entry.'}
    ${backlogHeader(p)}
    ${backlogDedup('defect')}
    ${backlogEntryShape(p, 'defect', '    ')}
    A DISMISSED line that covers a class of places gets one entry. Its "- file:" line names the first
    place, and its **What:** names the class.
    ${DECISION_RULE}
    When you append a ${LOGGED_FIX_TAG} line below, ${grepBacklog('the path of the file the fix changes', 'the fix')}.
    When an entry that a grep matches holds the defect that line's fix closes, add one line after that entry's
    **Fix:** line in that file:
      **Closed by:** block ${id} r${round} of run ${RUN_ID}. Confirm before the entry is built that the accepted baseline holds the fix.
    Leave its status and decision as they are, since a park clears the fix from the tree.
${PROACTIVE ? `  • CLEANUP (this run's change policy): append ONE entry for each cleanup outside task code,
    ${OWNED_CODE}, that you noticed and did not make, such as a nit. Route, count,
    dedup and number it as a RECORD entry. It takes RECORD's shape with "- category: cleanup" and no
    "- severity:" line, since severity takes only critical, high, medium or low. Its **What:** names the
    cleanup, the code it touches and what it improves.
` : ''}  • FEATURE (both change policies): append ONE entry for each feature or refactor you noticed that lies outside
    this block's scope, ${OWNED_CODE}, instead of building it. Route, count, dedup and number it as a RECORD entry. It
    takes RECORD's shape with "- category: feature", "- decision: NEEDS_USER" and no "- severity:" line.
    Its **What:** names the feature or refactor, the code it touches and what it adds or improves.
  • AMEND (6a): append ONE entry to ${amendedFile(id)}:
      \`## Plan amendment: ${id} r${round}\`
      then the plan clause you overrode (QUOTED verbatim), the defect (file:line + one line on why it is
      real), and what you built instead.
    Then append ONE POINTER line to ${DECISIONS}: the block id, the round, the defect's file:line, and
    the path ${amendedFile(id)}, with NO plan text. Count every entry you wrote in plan_amendments.
  • ESCALATE (7), in one of two branches:
    - You CANNOT proceed without the answer: append a FULL, self-contained entry to ${questionFile(id)} (all
      the detail the user needs to decide) under the heading \`## Question: ${id} r${round}\`, and set
      needs_user=true (this block stops and is parked, and the park copies the entry into its backlog entry).
    - You can proceed with a defensible default: append an entry to ${DECISIONS} (the choice, the
      options, the default you took and why), leave needs_user=false, AND append ONE terse line to
      ${dismissedFile(id)} (create ${GATE_DIR}/ if it does not exist) in the DROP shape above, its reason
      \`ESCALATED: <the default you took, ≤15 words>\`, because the blind reviewer is NOT shown ${DECISIONS}
      and would re-raise your default every round until this block parks.
      Also append ONE backlog entry for it when the choice lies ${OWNED_CODE}, routed, counted, deduped and
      numbered as a RECORD entry. It takes RECORD's shape with "- category: decision", "- decision: NEEDS_USER"
      and no "- severity:" line. Its **What:** states the question and the default you took, and its **Fix:**
      states the other option. When the default lies in code this block's diff adds or changes, add the line
      ${parkedWithLine(id)} after the **Fix:** line, since a park removes that code from the tree.
    Write to ${questionFile(id)} only a question the user must answer before a block can finish. Never write an
    informational note, a test observation, a chore or a default you took to it.
  • ${LOGGED_FIX_TAG} (this run's change policy): append ONE line to ${DECISIONS} for each ${BASELINE_FIX}
    that you made, in any zone, without ${requiredBy(mode)} requiring it, and that no earlier round
    logged, naming its file:line, what changed and why:
      \`${LOGGED_FIX_TAG} ${id}: <file:line> — <what changed> — <why>\`
This is NOT a general code review. Make THIS block correct, testable and production-safe, make the
fixes the ZONE ROUTING allows, and touch nothing else.`;
};

// The first six lines copy debug/review.mjs's SEVERITY_SCALE, so a grade means the same in both engines.
const SEVERITY_SCALE = `SEVERITY - grade by impact, never by the size of the fix. When two grades fit, take the higher.
  critical - loses or corrupts data, opens a security hole, or breaks the main path on every input.
  high     - crashes or gives wrong output on an input the code accepts.
  medium   - a real defect with a bounded impact, such as a leak, a wrong error path, or a misleading
             result the caller can detect.
  low      - a real defect with no effect on any input the code accepts today.
  nit      - not wrong and no effect on behavior, but it hurts clarity or maintainability.
A comment, docstring, string or doc that is wrong, or that misleads a reader, is a defect graded low or
higher by what the misled reader would do. It is never a nit.
Duplicated logic whose copies already disagree is a defect graded by the harm of the disagreement. It is
never a nit.
A risky path the diff adds with no test, such as an error path, a branch on outside input or a write to
stored state, is a defect graded low or higher. It is never a nit.
NITS include: an overlong comment, or one that restates the code; a comment that breaks the
CONVENTIONS' comment rules; an unclear name, or one inconsistent with its neighbours; dead code the
diff adds (an unused import, variable, parameter, function or branch); a magic number or string with
no named constant; small duplication inside the diff whose copies agree; a redundant line or
condition; control flow nested deeper than its logic needs; a function that mixes I/O with processing
against the CONVENTIONS.`;

// Shared by the blind reviewer and the developer's SELF-REVIEW, so both read a diff with one reach step and one checklist.
const REACH = `REACH: for every function, constant, field, string or rule the diff changes, grep its callers
and consumers, its sibling paths with the same mechanism, duplicates of the same logic, and every
comment or doc that describes the old behavior. A defect there that the diff introduces or exposes
counts as introduced by this diff.`;
const CHECKLIST = `CHECKLIST:
  - build and tests: anything that breaks the build or tests;
  - correctness and edge cases: empty, missing, blank, multi-valued, unicode, case-folded, huge and
    numeric inputs, platform path forms, and a value computed right but reported wrong;
  - crash-safety and resume: a crash between a state change and its record, a resume that repeats or
    skips a step, a partial write, a leaked temp file or handle, two processes on shared state;
  - error contract: an expected failure that escapes the project's error path, a failure returned in
    a success shape, a message that hides the cause or the way to recover;
  - consistency: the same concept shaped differently from its established counterpart in the repo
    (cite the counterpart's file:line), a problem the repo already solves re-solved another way;
  - completeness: behavior the diff gives some inputs or sibling paths and skips for others, such as
    a container, an enum value, a domain or a cleanup step;
  - tests the diff adds or changes: a test that still passes with the code under test broken, a stub
    that replaces the behavior under test, a risky path the diff adds with no test;
  - prose accuracy: a comment, docstring, string or doc the diff adds or leaves that the code
    contradicts or that now misleads;
  - security, where the diff touches a trust boundary: untrusted input reaching a path, command,
    query or page, a secret reaching a log, result or error;
  - maintainability: the nit list in the scale above.`;

// The developer's SELF-REVIEW and acceptance's regression rule share this wording, so they cannot drift.
const DOC_REGRESSION = "a comment or doc sentence that was true in the accepted baseline and that this cycle's diff made false";
// One rule for both acceptance frames, so they cannot drift. Its removed-defect and logged-fix items repeat
// the zones the developer's rules let it change, which nothing else checks.
const regressionRule = (id, mode) => {
  const prescriber = mode === 'fix' ? "an entry's **Fix:**" : "this block's own text";
  return `${CODE_ZONES(mode)}
A regression is any behavior the accepted baseline (${BASELINE_DEF}) gave a caller or
input, a third-party one included, that this cycle's work breaks or changes without
${requiredBy(mode)} requiring it. A change counts as required only when ${requiredBy(mode)} names that change.
A break that a prescribed construction causes, which ${requiredBy(mode)} does not name, is not required,
so it is a regression. Not a regression:
  - a test the gate step's suite rule allows to be red.
  - a line number that another file cites, since every edit moves lines.
  - a removed defect: a change that closes a finding an earlier review of this block named, or that
    closes the same defect on a sibling path of a change ${requiredBy(mode)} requires
    or of such a finding. It is not a regression only when you confirm from the code that the baseline
    behavior it removes was itself a defect and is that same defect, that the change alters no other
    behavior, that it lies ${UNCLAIMED_CODE}, and that it lies ${changeZones(mode)}.
  - a behavior change that a "${LOGGED_FIX_TAG} ${id}:" line in
    ${DECISIONS} names. It is not a regression only when you confirm from the code that the baseline
    behavior it removes was itself a defect, that the change alters no other behavior, that it lies
    ${OWNED_CODE}, and that it lies ${changeZones(mode)}.
Every other such break or change is a regression. So is ${DOC_REGRESSION}. Count each one, even when
${prescriber} prescribes the construction that causes it, and even when you judge the path
rare, inherent, or unreached by any current caller. Those calls are the developer's, never yours. The
developer fixes it, with an amendment when ${prescriber} prescribes it, or escalates it
when only a change in other code closes it. Once the developer's ledger holds one, the
OVERRIDE rule above governs it.`;
};
const REGRESSION_STEP = `REGRESSION: compare the unstaged diff against the accepted baseline. Confirm that no
   previously-accepted behavior was changed or broken, apart from a change that meets an item of the
   "Not a regression" list above.`;
// Mirrors what each ACCEPTANCE_FRAME prompt checks. A change to one needs the same change to the other.
const regressionExcuses = (mode) => `Acceptance does not count as regressed a removed defect (a real defect that an earlier review finding names, or the same defect on a sibling path of such a finding or of a fix this block requires) that lies ${UNCLAIMED_CODE}, and ${changeZones(mode)}. Nor does it count a removed defect that a ${LOGGED_FIX_TAG} line in DECISIONS.md names and that lies ${OWNED_CODE}, and ${changeZones(mode)}.`;
const RISK_CHECK = 'that each risk answer of a round no blind review judged holds against that round\'s own hunks';
const ACCEPTANCE_CHECKS = {
  feature: `After the blind review, when one runs, acceptance checks that every acceptance criterion of this block holds with a file:line, test or command-output locator, that the feature is reachable from real entry points, that every earlier review finding is closed or declined, that no behavior of the accepted baseline regressed, ${RISK_CHECK}, and that the gate is satisfied. ${regressionExcuses('feature')}`,
  section: `After the blind review, when one runs, acceptance checks that every acceptance criterion of this block holds with a file:line, test or command-output locator, that every call site this block owns is converted, that every earlier review finding is closed or declined, that no behavior of the accepted baseline regressed, ${RISK_CHECK}, and that this block's gate meets its expectation. ${regressionExcuses('section')}`,
  fix: `After the blind review, when one runs, acceptance checks that each FIXED entry closes its root cause on every sibling path, that each STALE entry is absent from the current code, that the diff touched no entry that is not ACTIONABLE and skipped none that is, that every earlier review finding is closed or declined, that no behavior of the accepted baseline regressed, ${RISK_CHECK}, and that the gate is satisfied. ${regressionExcuses('fix')}`,
};
const PHASES = 'the six phases PATTERNS, BUILD, HARDEN, SIBLINGS, SELF-REVIEW and CLASSIFY, in this order';
// The developer's CLASSIFY phase, the closing pass and acceptance's risk audit all render these, so a
// judgment and its audit read the same questions.
const RISK_QUESTIONS = `RISK QUESTIONS - answer each one for a change:
  - Systems: does the change need edits in more than one system to stay consistent?
  - Paths: does it add or change many branches, loops, error paths or state transitions?
  - Critical code: does it touch data writes, deletion, security, concurrency, a public contract, or code
    whose behavior is hard to follow?
  - Assumptions: does it rest on a judgment call or an assumption that an input, a platform or a caller
    could falsify?
Each answer cites its evidence, such as a file:line or a count of the branches or systems the change adds
or touches, or is "no". A doubtful answer counts as yes. A change is low risk when every answer is no.`;
// A temporary index holds the snapshot, since the real index holds the accepted baseline and `git add -A` on it
// would stage this block's work. `--git-path index` finds a linked worktree's own index.
const SNAPSHOT_LINE = 'Snapshot:';
const snapshotIndex = (id, round) => `${STATE_DIR}/scratch/snapshot-${slug(id)}-r${round}.index`;
const snapshotCommands = (id, round) => {
  const index = snapshotIndex(id, round);
  return `     cp "$(git -C ${REPO} rev-parse --path-format=absolute --git-path index)" "${index}"
     GIT_INDEX_FILE="${index}" git -C ${REPO} add -A
     GIT_INDEX_FILE="${index}" git -C ${REPO} write-tree`;
};
// Last, so the judgment covers every change the earlier phases made. The snapshot is the first line of the
// risk file, so acceptance can show this round's own hunks, since git holds one cumulative unstaged diff.
const CLASSIFY_STEP = (id, round) => `CLASSIFY: judge the risk of each change this round made, in any phase, under the RISK
   QUESTIONS below. Write ${riskFile(id, round)} (create ${STATE_DIR}/ if needed). ${REPLACE_NOTE} Its first line is
   \`${SNAPSHOT_LINE} <tree id>\`, the tree id of a snapshot of the working tree. Take the snapshot after your
   last change, with these commands, which write a temporary index file (create ${STATE_DIR}/scratch/ if
   needed) and never the real index. The last command prints the tree id:
${snapshotCommands(id, round)}
   After the first line, write one section per change, named by its file:line, with its four answers. A
   round that changed nothing writes "No changes." Return review_needed=true when any change is not low
   risk, and false only when every change is low risk. With false, the engine may send this round's diff to
   acceptance with no blind review, and acceptance then checks each answer against that round's hunks.
${RISK_QUESTIONS}`;
const PATTERN_STEP = `PATTERNS: before you write code, find how the repo already does the same kind of thing, such
   as its names, data shapes and error path, and follow it where the block does not prescribe otherwise.`;
// A phase after BUILD changes code after BUILD's gate run, so the reported outcome must come from a later run.
// One run after the last such phase, since a re-run in each phase repeats a slow suite.
const PHASE_NOTES = `Each phase after BUILD, while it works, runs only a targeted test of the code it changes, such as one
test file, when the repo has one, and never the gate. A phase with nothing to do for this round's changes is
skipped, such as HARDEN after a change to comments alone, or SIBLINGS when the round made no fix.
When any phase after BUILD changed code, run the gate once more under BUILD's rules after the last such
phase and before CLASSIFY. That run's outcome is the one you report. When no phase after BUILD changed
code, BUILD's run is the one you report.`;
const HARDEN_STEP = `HARDEN: in the code this round added or changed, handle edge cases, handle each expected failure
   with a message that names its cause, log where the repo logs, add a test for each risky path, and
   clean up the code you wrote, at every tier of the SEVERITY scale below.`;
// "In any phase" covers a SELF-REVIEW fix, which comes after this phase.
const SIBLING_STEP = `SIBLINGS: when you FIX a finding in any phase or make a fix this block requires, grep for
   every sibling path with the same mechanism, and fix each one the ZONE ROUTING above fixes.
   DROP + LOG every other sibling by its file:line, or log the class it belongs to. A sibling in code
   this block's text excludes, or that another block of the plan owns, is DROP + LOG wherever it lies.`;
// The developer applies the blind reviewer's scale, reach step and checklist first, so a finding it routes costs
// no review round. Its scope stops at its own round's code, since each earlier round had its own self-review.
const SELF_REVIEW = (mode) => `SELF-REVIEW: before you return, apply the SEVERITY scale, the REACH step and the CHECKLIST
   below to the code this round changed or read: the part of your unstaged diff, new files included, that
   this round changed, and the code you read in this round, such as the callers and consumers the REACH
   step names. Code that earlier rounds changed and that this round neither changed nor read is out of
   this phase's scope, since each earlier round's self-review judged that round's code, and each blind
   review judges the entire block diff.
   Hunt the task code in that scope for every finding at every tier. In the connected code in that
   scope, check your change's effects. Route each finding through the ZONE ROUTING above and the
   DECISION MATRIX below.
   In the REACH step, skip a sibling grep that the SIBLINGS phase already ran on the same code in this round.
   A regression here is a behavior of the accepted baseline that the acceptance check below counts as
   regressed, or ${DOC_REGRESSION}.
   ${ACCEPTANCE_CHECKS[mode]}
${SEVERITY_SCALE}

${REACH}

${CHECKLIST}`;

// =============================================================================
// Role prompts. DEVELOP_FRAME and ACCEPTANCE_FRAME switch on mode. The blind critic sees no plan.
// =============================================================================
const featureDevelop = (p, round, { opening, ledgerNote, zones, staging, rework }) => `
You are the DEVELOPER. Implement ${blockRef(p)}. ${PROACTIVE ? `Build it ${PROACTIVE_BUILD} Match conventions;` : 'Build it minimally and surgically; match conventions;'}
${SCOPE_LINE.feature}.
${POLICY_LINE}
${ENV}
BLOCK: ${p.id}
${ROUND_NOTE(round)}
${opening}
${ledgerNote}
${zones}

PROCEDURE: ${PHASES}.
${PHASE_NOTES}
1. ${PATTERN_STEP}
2. BUILD: ${rework || `Implement the plan's steps. WIRE IT IN so the feature is actually reachable
   (registered/exported/routed/bound/flagged) — written-but-unreachable is NOT done. Author/extend tests
   per the plan's Test Strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}`}
   Then RUN THE GATE until it is ${p.gate === 'build-only' ? 'GREEN (build-only: the build must pass; this block has no verification to run)' : 'GREEN'} — build: ${GATES.build ?? '(none)'} ; verification: per
   the plan's Test Strategy (${GATES.test ?? 'no test gate configured'}). ${SUITE_LINE} Never
   weaken/delete tests to get green. SANITY-CHECK the runner really executed your unit tests.
3. ${HARDEN_STEP}
4. ${SIBLING_STEP}
5. ${SELF_REVIEW(p.mode)}
6. ${CLASSIFY_STEP(p.id, round)}
7. ${staging}
8. ${MATRIX(p, round)}
Return ONLY the decision fields via the schema (no prose report).`;

const sectionDevelop = (p, round, { opening, ledgerNote, zones, staging, rework }) => {
  const gateExpectation = p.gate === 'red-baseline'
    ? 'red-baseline — AUTHOR this block\'s tests; they MUST FAIL because the code is not converted yet. Report test_outcome="failed-expected" once they run and fail for the RIGHT reason (asserting the not-yet-built target behavior), or "failed-unexpected" if they fail for a wrong reason (parse error, missing fixture).'
    : p.gate === 'build-only'
      ? 'build-only — no test pass/fail requirement; just keep the build green.'
      : 'green — this block\'s selector tests must RUN and PASS (test_outcome="passed").';
  return `
You are the DEVELOPER. Implement ${blockRef(p)}. ${PROACTIVE ? `Build this block ${PROACTIVE_BUILD} Match` : 'Build ONLY this block minimally and surgically; match'}
conventions; ${SCOPE_LINE.section}.
${POLICY_LINE}
${ENV}
BLOCK: ${p.id}
GATE EXPECTATION: ${gateExpectation}
${ROUND_NOTE(round)}
${opening}
${ledgerNote}
${zones}

PROCEDURE: ${PHASES}.
${PHASE_NOTES}
1. ${PATTERN_STEP}
2. BUILD: ${rework || `Implement this block's steps. WIRE IT IN so the change is actually reachable — convert
   EVERY call site / occurrence this block owns (registered/exported/routed/bound/flagged); a
   half-converted block is NOT done. Author/extend tests per the block's Test Strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}`}
   Then RUN THE GATE until it satisfies the expectation above — build: ${GATES.build ?? '(none)'} ; tests
   scoped to this block (use the block's \`test_selector:\` line when it has one, else the test gate):
   ${GATES.test ?? '(no test gate configured)'}. Never weaken/delete tests to get green. SANITY-CHECK
   the runner really executed your unit tests. Some runners silently ignore extra path args, so when in
   doubt run one file per invocation or use the runner's --filter.
   ${SUITE_LINE} Build/lint must always pass.
3. ${HARDEN_STEP}
4. ${SIBLING_STEP}
5. ${SELF_REVIEW(p.mode)}
6. ${CLASSIFY_STEP(p.id, round)}
7. ${staging}
8. ${MATRIX(p, round)}
Return ONLY the decision fields via the schema (no prose report).`;
};

// Verify-first because entries come from a past snapshot. ACTIONABLE-only because the decision line is
// set by the user's triage or by the backlog writers' decision rule. Every round reports each entry's
// status, so a later round's BUILD keeps the entry rules beside its rework.
const fixDevelop = (p, round, { opening, ledgerNote, zones, staging, rework }) => `
You are the FIXER. Resolve the verified issues in ${blockRef(p)}. Each block printed IS an inventory: a
"## Plan:" header followed by one "### [<id>]" entry per issue, each with its own \`- decision:\` line and
a **Fix:** instruction. Fix each one as its **Fix:** line instructs, minimally and surgically. Change nothing on
behalf of an entry that is not ACTIONABLE, in any zone. ${SCOPE_LINE.fix}.
${POLICY_LINE}
${ENV}
BLOCK: ${p.id}
GATE EXPECTATION: green — build passes and this block's verification RUNS and PASSES (test_outcome="passed").
${ROUND_NOTE(round)}
${opening}
${ledgerNote}
${zones}

PROCEDURE: VERIFY-FIRST, then ${PHASES}.
${PHASE_NOTES}
1. VERIFY-FIRST: the entries come from a PAST snapshot. For EACH, read the CURRENT code and confirm the
   issue still exists. If it is already fixed or no longer applies, record it STALE. Never "fix" what
   isn't there. STALE means someone ELSE closed it before this run: an entry YOU fixed in an earlier
   round of this block stays FIXED every round, since its diff is still unstaged and still has to be
   verified.
2. ${PATTERN_STEP}
3. BUILD: ${rework ? `${rework}\n   ` : ''}FIX ONLY the entries whose \`- decision:\` line says ACTIONABLE. Leave every other
   entry (SKIP, NEEDS_USER, DEFER, anything else) UNTOUCHED and record it SKIPPED: that triage is the
   user's call. Apply each confirmed fix per its **Fix:** instruction, matching the surrounding style.
   The code a fix adds is task code, so harden it like any task code. An edge case the prescribed form
   leaves out, such as an input value the form mishandles, is DECISION MATRIX rule 5 and takes no
   amendment. A change to what the **Fix:** line prescribes is a conflict with the plan, so it goes under
   6a, 6b or rule 7 of the DECISION MATRIX below.
   Where a fix warrants a pinning test, write it. Never weaken or delete existing tests to make the gate
   pass. Never disable lint rules.
   Then RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: ${GATES.test ?? '(no test gate configured)'}.
   ${SUITE_LINE} SANITY-CHECK the runner really executed the tests. If a fix breaks the gate and you
   cannot resolve it within THAT fix's own scope, revert that change surgically, record the entry FAILED
   with the reason, and keep the rest.
4. ${HARDEN_STEP}
5. ${SIBLING_STEP}
6. ${SELF_REVIEW(p.mode)}
7. ${CLASSIFY_STEP(p.id, round)}
8. ${staging}
9. ${MATRIX(p, round)}
Return ONLY the decision fields via the schema (no prose report).`;

const DEVELOP_FRAME = { feature: featureDevelop, section: sectionDevelop, fix: fixDevelop };

// The entries whose branches round 1 restores. One wording keeps the restore and the landing on the same set.
const BRANCH_ENTRIES = 'each ACTIONABLE entry whose "- status:" is absent, open or needs-attention and that carries a "- branch:" line';
// A FAILED entry's restored work may be reverted, so only a verified fix proves the landed block holds that
// branch's work.
const LANDED_BRANCHES = `each distinct branch that the "- branch:" line of ${BRANCH_ENTRIES} names, when this verdict
   returned a fix_check with actually_fixed=true for every such entry that names it`;
// An origin block's own criteria, which a park entry's **What:** may not list, since it copies only why the block parked.
const ORIGIN_CRITERIA = `every acceptance criterion of each block its "- origin:" line names (\`node '${BLOCK_TOOL}' '<plan file>' '<block id>'\`
prints a block), and, for a feature or section block, the reachability of its work from real entry points`;
// A park entry links a branch that holds a parked block's work. The restore follows the clean-baseline
// check, so the restored diff is the only unstaged work, and both reviewers read it as this block's.
// Every apply runs before any intent-to-add, so reversing a failed restore leaves the index untouched.
// A landed block may hold a FAILED entry's restored work while its branch stays, so step b skips that branch.
const RESTORE_OPENING = `fix this block's entries on top of the accepted
baseline. First RESTORE unfinished work, once you have read your block and before VERIFY-FIRST.
The branch of ${BRANCH_ENTRIES} holds a parked block's work.
  a. Run \`git -C ${REPO} diff --cached --stat\` and keep its output.
  b. For each distinct branch those lines name, in turn: when
     \`git -C ${REPO} rev-parse --verify --quiet refs/heads/<branch>\` prints nothing, the branch is missing,
     so the restore FAILS for it (below). When \`git -C ${REPO} diff --stat <branch>^1 <branch>\` prints
     nothing, the branch holds no work, so skip it. When
     \`git -C ${REPO} diff --binary <branch>^1 <branch> | git -C ${REPO} apply -R --check\` succeeds, the
     accepted baseline already holds the branch's work, so skip it. Otherwise restore it with
     \`git -C ${REPO} diff --binary <branch>^1 <branch> | git -C ${REPO} apply\`, a PLAIN apply, never with
     \`--3way\`, \`--index\` or \`--cached\`: each of those stages the restored work ${STAGED_HARM}.
  c. Once every branch has applied, run \`git -C ${REPO} add -N -- <file>\` on each new file the restores
     created (\`git -C ${REPO} status --porcelain\` lists it as \`??\`).
  d. Confirm \`git -C ${REPO} diff --cached --stat\` is the same as the output step a kept.
The restored diff is THIS block's own unstaged work, and it is the work of the entry whose branch it is.
An ACTIONABLE entry with an "- origin:" line holds a parked block's unfinished work. On top of its
branch's work, which step b restored or the accepted baseline already holds, or on the accepted baseline
when it carries no "- branch:" line, close the gaps its **What:** lists and meet ${ORIGIN_CRITERIA}. Report the entry FIXED once both hold, never STALE.
If the restore FAILS for a branch, because it is missing or its \`git apply\` fails, reverse each branch
step b already restored, the last one first, with
\`git -C ${REPO} diff --binary <branch>^1 <branch> | git -C ${REPO} apply -R\`. Then confirm
\`git -C ${REPO} diff\` is empty and that \`git -C ${REPO} status --porcelain\` lists no file the restores
created (a failed plain \`git apply\` changes nothing). Change nothing else, set restore_failed to the
branch that failed and why (missing, or the \`git apply\` error), set restored_branches to 0, and STOP.
Every branch stays as it was. Otherwise set restore_failed to "" and restored_branches to the count of
branches step b applied.`;

// The misclassified verdict itself sends the next round to a blind review, so the gap holds no work.
const RISK_GAP_NOTE = 'A gap for a wrong risk answer takes no fix and no log, since the blind review it triggers judges that change.';
// A recorded item keeps no DISMISSED line, since the closing acceptance must sort it as an open gap. Its entry
// names the park, since a park moves the code it describes to the branch.
const closingRework = (id, reviewPath) => `CLOSING PASS. ${reviewPath ? `READ ${reviewPath}. Every finding and gap in it, and each failure
   the gate run below shows, is` : 'Each failure the gate run below shows is'} your work list. Route each item through the DECISION
   MATRIX below. Where the matrix says FIX and the fix is not low risk under the RISK QUESTIONS in
   CLASSIFY below, change no code for it. Append one entry for it instead, in RECORD's shape below,
   routed, deduped and numbered as a RECORD entry, with a **Fix:** line naming the fix you would make.
   After that line, add the line ${parkedWithLine(id)}, since the engine parks the block with the code the entry names when its closing
   acceptance finds a blocking gap.
   That line sets the entry's "- decision:" to NEEDS_USER, by RECORD's decision rule.
   An entry for a nit takes "- category: cleanup" and no "- severity:" line. Count it in
   backlog_entries, list its id in recorded_entries, and write no DISMISSED line for it. When the dedup
   forbids the append, list the id of the entry that holds the item in recorded_entries instead. Make
   every other fix, and make no change that is not one of these fixes. Every later phase works only
   on them.
   A gap for a wrong risk answer takes no fix and no log, since a blind review of this block's changes follows you.`;

const developPrompt = (p, round, reviewPath) => {
  const closing = round === CLOSING_ROUND;
  // Identical in every frame — only the task lines in DEVELOP_FRAME switch on mode.
  // Commit mode also counts staged files, since acceptance's commit would carry them unreviewed.
  const opening = round === 1
    ? `ROUND 1 — STEP 0, BEFORE you read the plan or touch any file: CONFIRM THE BASELINE IS CLEAN. Earlier
ACCEPTED blocks are ${COMMIT ? 'COMMITTED (the accepted baseline is HEAD), so nothing is staged' : 'STAGED (the accepted baseline)'}. The UNSTAGED tree must be EMPTY, because everything
unstaged at the end of this round is judged as YOUR work.
  \`git -C ${REPO} diff --name-only\` (unstaged tracked edits)
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` (untracked files, which \`git diff\` OMITS)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (do NOT count
staged-only entries). ${COMMIT ? `Then run \`git -C ${REPO} diff --cached --name-only\` and report baseline_staged_files = the
count of files it lists. If either count is NOT 0, STOP RIGHT THERE: change nothing, write nothing, and
return immediately with both counts. The run halts for the operator. If both are 0, ` : `If it is NOT 0, STOP RIGHT THERE: change nothing, write nothing, and return
immediately with that count. The run halts for the operator. If it IS 0, `}${p.mode === 'fix'
      ? RESTORE_OPENING
      : 'implement this block from\nscratch on top of the accepted baseline.'}`
    : `${closing
      ? `Round ${MAX_ROUNDS} ended without a passed acceptance, so you are this block's CLOSING PASS, and no
develop round follows you. A blind review follows you when the block's changes since its last blind
review need one, and then acceptance runs once more. It lands the block when it finds no blocking gap,
and otherwise the block parks. Your earlier work is already in the UNSTAGED working tree: build ON it,
do NOT revert or redo it.`
      : reviewPath
        ? `A prior review flagged issues in ${reviewPath}. Your earlier work is already in the UNSTAGED
working tree: build ON it, do NOT revert or redo it.`
        : `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working
tree: re-run the gate (below) and fix what fails. Build ON it, do NOT revert it.`}
Report baseline_dirty_files=-1${COMMIT ? ' and baseline_staged_files=-1' : ''}.`;
  // A feature or section round that answers a review routes its findings in place of the build, and a fix
  // round routes them beside its entry rules. A round after a red gate with no review still owes round 1's BUILD.
  const reviewRework = reviewPath
    ? `READ ${reviewPath}
   and route every finding and gap in it, at every tier, through the DECISION MATRIX below: fix it or
   log it. ${RISK_GAP_NOTE}`
    : '';
  const rework = closing ? closingRework(p.id, reviewPath) : reviewRework;
  // Every round, round 1 included: the ledger persists across resumes.
  const ledgerNote = `If ${dismissedFile(p.id)} exists, READ it first: your ledger of declined findings for THIS
block. Do not duplicate or re-litigate an entry.`;
  const staging = `LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file
   you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add, so reviewers' \`git diff\` sees it;
   it does not stage content). Set unstaged_confirmed=true. Anything YOU stage is reviewed by nobody
   and HALTS the run. ${COMMIT
    ? `HEAD already holds the blocks this run accepted before this one, each as its own
   commit. Leave HEAD and the index as they are: never commit, reset or revert. You may still edit any file`
    : `The staged index already holds the blocks this run accepted before this one.
   Leave the index as it is: never unstage, restage or revert those blocks. You may still edit any file`}
   this block needs, including one an earlier block changed.`;
  const zones = `${CODE_ZONES(p.mode)}\n${ZONE_ROUTING(p.mode)}`;
  return DEVELOP_FRAME[p.mode](p, round, { opening, ledgerNote, zones, staging, rework });
};

// BLIND: no plan, spec, goal or criteria, so one frame serves every mode.
const qualityPrompt = (p, round) => `
You are a CODE CRITIC. You have NO information about what this code is for or should do, and no plan,
spec or goal. Do not seek any. Judge the code PURELY ON ITS OWN MERITS.
Never open a plan file, an issue inventory, or any run-state path outside ${GATE_DIR}/.
${GATE_DIR}/ also holds other blocks' review and DISMISSED files.
Read only ${dismissedFile(p.id)} there, and ${qualityFile(p.id, round)} only at the WRITE step, so the Write tool accepts the overwrite. Never use its content.
${ROUND_NOTE(round)}
TARGET REPO: ${REPO}
GATES — already ran before you were spawned, and a later stage re-runs them before anything is staged.
Never run them in full. Run the test command only for ONE targeted test that confirms a suspected defect.
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}
Any other command that writes nothing in the repo, such as a tool's check mode, and a probe script in a
temporary folder outside the repo and outside the folder that holds ${GATE_DIR}/ are allowed.
CONVENTIONS (judge against these): ${CONVENTIONS}

${SETTLED(p.id, true)}

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`: unstaged tracked changes, the work to review. On a large diff run
  \`git -C ${REPO} diff --stat\` first, then read it file by file.
  \`git -C ${REPO} status --porcelain\` then READ every untracked file (\`??\`) — \`git diff\` OMITS those.
  A \` A\` entry (intent-to-add) is a new file \`git diff\` already shows in full. A first-column \`A\` or
  \`M\` is STAGED${COMMIT ? ', and' : ': the staged half of an \`AM\` or \`MM\` file is baseline, and'} only its unstaged half
  (\`git -C ${REPO} diff -- <file>\`) is this cycle's work.
  ${COMMIT ? 'HEAD is the ACCEPTED baseline, each accepted block one commit' : `\`git -C ${REPO} diff --staged\` is the ACCEPTED baseline`} — context only, do NOT review it.

${SEVERITY_SCALE}

Report every finding this diff introduces or exposes, at every tier. Drop silently anything
pre-existing in code the diff neither changes nor interacts with, speculation, and redesigns.

${REACH}

${CHECKLIST}

HUNT. Working from critical down to nit, find every finding through the CHECKLIST and the REACH
step. A finding at medium or above names the concrete input or path that reaches it and its harm,
cited by file:line. A real defect you cannot tie to a concrete input or path grades low at most. An
EMPTY review is the normal, GOOD outcome.

A hunk that changes ONLY comments, string text or documentation has four checkable defects: a change
to executable code (\`git -C ${REPO} diff --word-diff\` shows each hunk's exact tokens), a path, command,
identifier or file the new text names that does not exist, a sentence the change removed that other
text still refers to, and a claim the new text makes about this repo's code that the code contradicts,
cited by line. Those four checks and the nit list bound your review of such a hunk.
A prompt template or other text an agent or a program acts on is behavior, not string text. Review it
with the full checklist, and grade a contradiction in it by what an agent that follows it would do.

WRITE your findings to ${qualityFile(p.id, round)} (create ${GATE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE}
Group them by tier, highest first, one section per finding: its tier, file:line, what is wrong, the input or path and the
harm (for a finding at medium or above), and a concrete fix. When you found nothing, write
exactly "No findings." Then return wrote_file (true ONLY if you wrote that file), clean (true if you
found no finding and contested no dismissal), issue_count (every finding you wrote, at every tier) and
contested_dismissals via the schema. Do NOT modify source, stage, or commit.`;

// Read after step 1, so the verifier's own first judgment stays unanchored (#5).
const earlierFindingsStep = (p, earlierReviews) => `EARLIER FINDINGS. Read each file below in full, after step 1, so your own step-1 judgment stays
   fresh:
${earlierReviews.map((path) => `     ${path}`).join('\n') || '     (none: no review in this run has flagged this block)'}
   For each finding or gap in them, confirm one of: (a) the current code closes it, and a grep finds no
   sibling path that carries the same mechanism and that no line in ${dismissedFile(p.id)} covers, or (b)
   ${dismissedFile(p.id)} holds a line for it, with the OVERRIDE rule above deciding whether that declined
   item still fails acceptance. A finding that reappeared, one closed on one path while a sibling path
   that no line in ${dismissedFile(p.id)} covers keeps the same mechanism, and one neither closed nor declined
   each count as a gap. A gap for a wrong risk answer is closed, since the engine runs a blind review
   after the verdict that names it and before any later acceptance. A blind review that came back clean
   is never on this list, since it found nothing. That includes this round's blind review, when one ran.`;

// A round's base is the round before it. Round 1 is never audited, since the block's first blind review
// covers it before any acceptance runs.
const roundHunksCommand = (id, round) => `round ${round}, base in ${riskFile(id, round - 1)}, snapshot in ${riskFile(id, round)}:
       git -C ${REPO} diff <base> <snapshot>`;
// Rendered on every verdict, so a round with no blind review is never judged without its risk audit.
const riskAuditStep = (id, riskRounds, round) => (riskRounds.length
  ? `RISK AUDIT. No blind review judged the changes of the rounds these risk files cover, since their
   developer judged each change low risk:
${riskRounds.map((r) => `     ${riskFile(id, r)}`).join('\n')}
   The first line of each risk file is \`${SNAPSHOT_LINE} <tree id>\`, a snapshot of the working tree after
   that round. Git holds one cumulative unstaged diff, so a round's own hunks are the diff between its
   snapshot and its base, which these commands show. <snapshot> and <base> are the tree ids on the
   first lines of the files named beside each command:
${riskRounds.map((r) => `     ${roundHunksCommand(id, r)}`).join('\n')}
   Read each risk file, and check each answer it gives against the hunks of its own round under the RISK
   QUESTIONS below. A missing file, a missing \`${SNAPSHOT_LINE}\` first line in an audited round's file or in
   the base file named beside its command, a change it does not judge low risk, and an answer the hunks
   contradict are each a gap. Write each one in your review file and return risk_misclassified=true, which
   ${round === CLOSING_ROUND ? 'makes it a blocking gap, since no round follows to send to a blind review' : 'sends the next round to a blind review'}. Otherwise return risk_misclassified=false.
${RISK_QUESTIONS}`
  : "RISK AUDIT. This round's blind review judged the entire block diff, so no risk file needs an audit. Return risk_misclassified=false.");

// The developer writes both kinds of reason (the DROP shape and ESCALATE's proceeding branch), so acceptance names both.
const LEDGER_LINES = `A line whose reason starts \`SKIPPED:\` declines a finding, and the OVERRIDE applies to it.
A line whose reason starts \`ESCALATED:\` records a default routed to the user, and the hold applies to it:
hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a held escalation never
fails acceptance. Name it in your file as held.`;
// A closing pass has no later round, so a blocking gap in the closing acceptance parks the block.
const failBullet = (round) => `${round === CLOSING_ROUND ? 'Any blocking gap' : 'Otherwise'} → return pass=false (do NOT stage${COMMIT ? ' or commit, and return committed=false and commit_sha ""' : ''}); ${round === CLOSING_ROUND
  ? 'append no gap to the backlog, since the block parks and its backlog entry copies your blocking gaps first, then every other gap.'
  : 'the gaps you wrote drive the next develop round.'}`;
// Follows each pass bullet's `git add`: stage mode never commits, and commit mode commits by step 9.
const ADD_NOTE = COMMIT ? ', then COMMIT as step 9 says' : ' (NEVER commit)';

// No develop round follows the closing acceptance, so it lands a block whose open gaps are not blocking. A
// wrong risk answer is blocking only when no blind review read its changes, since the review is what the answer gated.
const closingBar = (mode) => `CLOSING BAR. No develop round follows this verdict. Sort each gap into one of two kinds, and list
each under the heading "## Blocking gaps" or, after it, "## Not blocking gaps" in your review file:
  • Blocking: a regression, a gate not satisfied, ${mode === 'fix'
    ? 'an ACTIONABLE entry whose root cause is not closed (an incomplete claimed fix, an unconfirmed STALE claim or an ACTIONABLE entry reported SKIPPED), a change made for an entry that is not ACTIONABLE or that no FIXED claim accounts for'
    : 'a criterion of this block not met, such as a change that is not reachable'}, a defect at
    medium severity or higher that this block's diff introduces, or a wrong risk answer whose changes no
    blind review has read, which is every gap your RISK AUDIT finds.
  • Not blocking: every other gap, such as a low or nit finding or a cleanup.
A finding this pass's blind review raised as "CONTESTS DISMISSAL" is neither closed nor declined, so it is a
gap, sorted by the kinds above, unless the line it contests is a held escalation.`;

// A park entry copies every gap of a parked block, so only a landing writes its gaps as entries of their own.
const closingPassBullet = (p) => `No blocking gap → APPEND each not blocking gap as ONE backlog entry ${backlogRoute(p, 'whose entry the gap concerns (the first block below when it concerns no single entry)', { indent: '     ' })}
     ${backlogHeader(p)}
     ${backlogDedup('gap')}
     ${backlogEntryShape(p, 'gap', '     ')}
     A nit or a cleanup takes "- category: cleanup" and no "- severity:" line. ${DECISION_RULE}
     Then \`git -C ${REPO} add <this block's changed AND newly-created files>\`${ADD_NOTE}; return pass=true,
     staged=true, gap_count=0.`;
// The closing acceptance's bar is no blocking gap, so its pass bullet replaces each frame's own.
const passBullet = (p, round, own) => (round === CLOSING_ROUND ? closingPassBullet(p) : own);
const NO_OP_GAPS = (round) => (round === CLOSING_ROUND ? ' Append each not blocking gap to the backlog as the first bullet says.' : '');
const NO_OP_COMMIT = COMMIT ? ' Make no commit, and return committed=true, commit_sha "", commit_subject "", tree_matches=true and tree_clean as step 9 says.' : '';
// The title goes through a file, so no shell quoting touches it. A hook or signing that refuses the commit halts
// the run, so the step never skips one. The tree id kept before the commit catches a hook that rewrites and
// re-stages files, which leaves the tree clean.
const commitStep = (p, round) => (COMMIT ? `
9. COMMIT, on a pass whose diff is not empty: write the block's title, which is the JSON string
   ${JSON.stringify(p.title)}, decoded, as the one line of ${commitFile(p.id)} (create ${STATE_DIR}/
   if needed), with no quotes, no other line and no trailer. ${REPLACE_NOTE} Run \`git -C ${REPO} write-tree\` and keep the
   tree id it prints. Run \`git -C ${REPO} commit -F ${commitFile(p.id)}\`.
   Never pass \`--no-verify\`, \`--no-gpg-sign\` or \`--amend\`. When the commit fails, such as when a hook or
   signing refuses it, append its full output to ${acceptanceFile(p.id, round)}, leave the work staged, and
   return committed=false, commit_sha "", commit_subject "" and tree_matches=false. When it succeeds,
   return committed=true, commit_sha from \`git -C ${REPO} log -1 --format=%H\`, commit_subject from
   \`git -C ${REPO} log -1 --format=%s\`, and tree_matches=true only when
   \`git -C ${REPO} log -1 --format=%T\` prints the tree id you kept. When it prints another, append both
   tree ids to ${acceptanceFile(p.id, round)}, the kept one first. On every pass, return tree_clean=true
   only when \`git -C ${REPO} status --porcelain\` then prints nothing.` : '');

const reviewStatus = (round) => (round === CLOSING_ROUND
  ? `This closing pass's blind code review ran when the block's changes owed one, and step 2 lists its file
when it found issues. When none ran, the developer judged each change since the block's last blind review
low risk, which your RISK AUDIT checks.`
  : `This round's blind code review passed, or did not run because the developer judged each
change since the block's last blind review low risk, which your RISK AUDIT checks.`);
const ACCEPTANCE_CHECK_RULE = `Any command that writes nothing in the repo, such as a tool's check mode, is allowed.`;

// The root cause is re-derived from current code, not checked against the entry's **Fix:** line, because
// the entry may have under-scoped the defect.
const fixAcceptance = (p, round, { claimedFixed, claimedStale, reportedSkipped, earlierReviews, riskRounds }) => `
You are the ACCEPTANCE VERIFIER — the final, issue-aware gate for ONE fix block or pass of blocks.
${reviewStatus(round)} Read ${blockRef(p)}. Each block printed IS an inventory: one "### [<id>]" entry per issue, each with a \`- decision:\` line and a **Fix:**
instruction. You judge the work against it; you never implement it.
${ENV}
BLOCK: ${p.id}   (mode: ${p.mode}, gate: ${p.gate})
${ROUND_NOTE(round)}

${SETTLED(p.id, false)}
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. A dismissed item that
actually leaves a claimed fix incomplete or causes a regression OVERRIDES the dismissal: fail
acceptance for it and record it in your review file. ${LEDGER_LINES}

AMENDMENTS: READ ${amendedFile(p.id)} if it exists. It records **Fix:** instructions the developer
OVERRODE after verifying the instruction itself prescribes a real defect. Judge an issue whose
instruction was amended against the AMENDED behavior, not the superseded one, and NAME every issue you
judged under an amendment in your review file. An amendment entry that states NO defect evidence excuses
NOTHING: that issue stays actually_fixed=false.

EVERY DEFECT YOU WRITE IN YOUR REVIEW FILE COUNTS. A gap is a claimed fix with a residual path
(actually_fixed=false), an unconfirmed STALE claim, an ACTIONABLE entry reported SKIPPED, a touched entry that is not ACTIONABLE,
a non-empty diff with no FIXED claim, a gate not satisfied, an earlier finding that is neither closed
nor declined, a failed risk audit, or a regression.
${regressionRule(p.id, 'fix')}
Drop any other concern silently, except a new issue (step 1). ${round === CLOSING_ROUND
    ? `Your file holds no notes or observations.\n${closingBar('fix')}`
    : 'Your file holds no notes, observations or\nnon-blocking section.'}

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  ${ACC_BASELINE_LINE}

PROCEDURE:
1. ROOT-CAUSE COMPLETENESS. The developer claims these issues FIXED:
${claimedFixed.map((id) => `     - ${id}`).join('\n') || '     (none claimed fixed)'}
   For EACH, read its full entry in its block, then INDEPENDENTLY re-derive the defect's root cause from
   the CURRENT code — do NOT just confirm the literal edit the entry described is present; the entry
   itself may have under-scoped the bug. A fix counts as landed ONLY if it closes that root cause
   COMPLETELY. If the same mechanism still has a live residual path the diff left open (a sibling code
   path, an already-started async chain that still writes the bad state, an untouched branch or caller
   with the identical defect), that is actually_fixed=false — EVEN IF the described edit was made — and
   its residual path goes in your review file at step 7. Return one fix_check per claimed issue.
   An entry with an "- origin:" line holds a parked block's unfinished work. When it also carries a
   "- branch:" line, the developer restored that branch's work into the unstaged diff in round 1, unless
   the accepted baseline already held it, and its fix is that entire branch work and every change made on
   it: read every hunk of \`git -C ${REPO} diff <branch>^1 <branch>\` in the unstaged diff or the accepted
   baseline. Return actually_fixed=true for an entry with an "- origin:" line only when the accepted
   baseline with the unstaged diff closes every gap its **What:** lists and meets ${ORIGIN_CRITERIA}.
   A harm an entry lists can come from a DIFFERENT mechanism: a cause that shares no code path with the
   root cause you re-derived. That harm is a NEW ISSUE, not a residual path. A sibling path, caller or
   branch with the identical defect is always a residual path, and when unsure, treat it as one. Append a
   new issue ${backlogRoute(p, 'whose entry lists the harm', { exclusion: ', never to your review file' })} It sets no
   fix_check false, and it never excuses a regression or an unsatisfied gate.
   ${backlogHeader(p)}
   ${backlogDedup('harm')}
   Each entry copies the shape of the block's own entries, with the id "${backlogEntryId(p)}" (n one past
   the highest n in that file's entry ids), "- status: open" and a **What:** that
   names the source issue id. ${DECISION_RULE}
   The developer reports these issues STALE (already absent from the current code):
${claimedStale.map((id) => `     - ${id}`).join('\n') || '     (none reported stale)'}
   For EACH, read its full entry and confirm against the CURRENT code that the defect is truly absent.
   Return a fix_check for it too. A STALE
   claim you cannot confirm is actually_fixed=false and fails acceptance exactly like an unclosed FIXED claim.
2. ${earlierFindingsStep(p, earlierReviews)}
3. TRIAGE HELD. Confirm the diff touched NOTHING on behalf of an entry whose \`- decision:\` is not
   ACTIONABLE. A fix applied to one fails acceptance even when the code change looks right, since that
   entry is the user's call. The developer reports these issues SKIPPED:
${reportedSkipped.map((id) => `     - ${id}`).join('\n') || '     (none reported skipped)'}
   Confirm each one's \`- decision:\` is genuinely not ACTIONABLE: an ACTIONABLE entry reported SKIPPED is
   an issue left open, and it fails acceptance.
4. ${REGRESSION_STEP}
5. Run the FULL gates (GATES above) once and record the real outcome.
   ${ACC_SUITE_LINE} If a configured MCP/tool is unavailable here, say so in the file (do not fake it)
   and return pass=false.
6. ${riskAuditStep(p.id, riskRounds, round)}
7. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE step 8. ${REPLACE_NOTE} ${WROTE_NOTE} It holds the
   per-issue root-cause verdict (with the residual path for any incomplete one), the earlier-findings
   result, the triage-held result, the regression result, the gate output, the risk-audit result, and
   each gap — or "All fixes close their root cause; every earlier finding closed or declined; triage
   held; no regression; risk audit clean."
8. DECIDE:
   • ${passBullet(p, round, `Every claimed fix complete, every STALE claim confirmed, no non-ACTIONABLE entry touched, every
     earlier finding closed or declined, gate green, risk audit clean, no regression →
     \`git -C ${REPO} add <this block's changed AND newly-created files>\`${ADD_NOTE}; return
     pass=true, staged=true.`)}
   • LEGITIMATE NO-OP: if every entry was genuinely STALE or non-ACTIONABLE and the diff is empty, that is
     a valid pass — return pass=true AND staged=true (nothing to add). Say so in your file. Do NOT
     invent changes to justify it.${NO_OP_GAPS(round)}${NO_OP_COMMIT}
   • NO FIXED CLAIM, NON-EMPTY DIFF: when the FIXED list in step 1 is empty, no claimed fix accounts for
     a change, so the unstaged diff MUST be empty. Any change there fails acceptance: name the files in your
     file and return pass=false.
   • ${failBullet(round)}${commitStep(p, round)}
${COMMIT
    ? `10. DELETE LANDED BRANCHES, only on a pass that returns regression=false, committed=true, commit_subject equal to the block's title, tree_matches=true and tree_clean=true:
   for ${LANDED_BRANCHES}, run \`git -C ${REPO} branch -D <branch>\`, since the landed block holds that
   work. Every other branch, and every branch on any other verdict, stays, since the operator may reject
   the work and rebuild it from the branch. Return branches_kept = each branch this step ran
   \`git branch -D\` on that \`git -C ${REPO} rev-parse --verify --quiet refs/heads/<branch>\` still resolves after it, or [].`
    : `9. LIST LANDED BRANCHES, only on a pass that returns regression=false, once step 8 has staged the block:
   return branches_kept = ${LANDED_BRANCHES}, or []. Delete no branch: the user reviews the staged work
   before committing it, so each branch stays until that commit, and a landing the user rejects can be
   rebuilt from it. Every other verdict returns branches_kept=[].`}
Return wrote_file=true ONLY if you wrote ${acceptanceFile(p.id, round)} this round.
Do NOT modify source code. ${ACCEPTANCE_CHECK_RULE} Return ONLY the decision fields via the schema.`;

const planAcceptance = (p, round, { earlierReviews, riskRounds }) => {
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
You are the ACCEPTANCE VERIFIER — the final, plan-aware gate for ONE block.
${reviewStatus(round)} Read ${blockRef(p)}. You judge the work against that block; you never implement it.
${ENV}
BLOCK: ${p.id}   (mode: ${p.mode}, gate: ${p.gate})
${ROUND_NOTE(round)}

${SETTLED(p.id, false)}
OVERRIDE: ${dismissedFile(p.id)} entries are the developer's judgment calls. A dismissed item that
ACTUALLY breaks one of this block's acceptance criteria, leaves it unreachable, or causes a regression
OVERRIDES the dismissal: fail acceptance for it and record it in your review file.
${LEDGER_LINES}

AMENDMENTS: READ ${amendedFile(p.id)} if it exists. It records plan clauses the developer OVERRODE after
verifying the clause itself prescribes a real defect. Judge a criterion whose prescribing clause was
amended against the AMENDED behavior, not the superseded clause, and NAME every criterion you
judged under an amendment in your review file. An amendment entry that states NO defect evidence excuses
NOTHING: that criterion stays UNMET.

EVERY DEFECT YOU WRITE COUNTS. A gap is a criterion not met, a change not reachable, a gate not
satisfied, an earlier finding that is neither closed nor declined, a failed risk audit, or a regression.
${regressionRule(p.id, p.mode)}
Drop any other concern silently. ${round === CLOSING_ROUND
    ? `Your file holds no notes or observations.\n${closingBar(p.mode)}`
    : 'Your file holds no notes, observations or non-blocking section.'}

SCOPE — this cycle's work is the UNSTAGED diff plus new files:
  \`git -C ${REPO} diff\` + \`git -C ${REPO} status --porcelain\` (READ new files).
  ${ACC_BASELINE_LINE}

PROCEDURE:
1. ENUMERATE THIS block's acceptance criteria FIRST, numbered. For EACH, find concrete evidence it holds
   (a diff hunk, a passing test, an observed behavior) and mark it met / not-met with a file:line /
   test-name / command-output LOCATOR. evidence_recorded=true only if EVERY met criterion carries such a
   locator in your review file. A criterion asserted without one is not met.
2. ${earlierFindingsStep(p, earlierReviews)}
3. ${reachStep}
4. ${REGRESSION_STEP}
5. ${gateStep}
6. ${riskAuditStep(p.id, riskRounds, round)}
7. WRITE ${acceptanceFile(p.id, round)} (create ${STATE_DIR}/ if needed) BEFORE step 8. ${REPLACE_NOTE} ${WROTE_NOTE} It holds the
   numbered per-criterion table WITH its locators, the earlier-findings result, the reachability +
   regression result, the gate output, the risk-audit result, and each gap (title + file:line + fix) —
   or "All criteria met; every earlier finding closed or declined; reachable; no regression; risk audit
   clean."
8. DECIDE:
   • ${passBullet(p, round, `All criteria met, reachable, gate satisfied, every earlier finding closed or declined, risk audit
     clean, no regression → \`git -C ${REPO} add <this block's changed AND newly-created files>\`${ADD_NOTE};
     return pass=true, staged=true.`)}
   • LEGITIMATE NO-OP: if this block genuinely requires NO code change because the accepted baseline
     already satisfies every one of its criteria, that is a valid pass — return pass=true AND staged=true
     (nothing to add). Say so in your file. Do NOT invent changes to justify it.${NO_OP_GAPS(round)}${NO_OP_COMMIT}
   • ${failBullet(round)}${commitStep(p, round)}
Return wrote_file=true ONLY if you wrote ${acceptanceFile(p.id, round)} this round.
Do NOT modify source code. ${ACCEPTANCE_CHECK_RULE} Return ONLY the decision fields via the schema.`;
};

const ACCEPTANCE_FRAME = { feature: planAcceptance, section: planAcceptance, fix: fixAcceptance };

const acceptancePrompt = (p, round, claimedFixed = [], claimedStale = [], reportedSkipped = [], earlierReviews = [], riskRounds = []) =>
  ACCEPTANCE_FRAME[p.mode](p, round, { claimedFixed, claimedStale, reportedSkipped, earlierReviews, riskRounds });

// Only needs-user writes a question entry, so every other halt names its own cause for park to cite.
const parkReason = (haltKind, id) => ({
  'needs-user': `the developer escalated a user-only decision (see ${questionFile(id)})`,
  'agent-dead': 'an agent returned nothing (skipped or died)',
  'plan-unreadable': 'an agent could not obtain its plan',
  'staging-unconfirmed': `the developer did not confirm its work stayed unstaged; inspect \`git -C ${REPO} diff --cached\` for self-staged work`,
  'rejected-staged': COMMIT
    ? `acceptance rejected the block but staged or committed it anyway; inspect \`git -C ${REPO} diff --cached\` and \`git -C ${REPO} log -1\`, then unstage this block's files or revert its commit with \`git -C ${REPO} revert <sha>\``
    : `acceptance rejected the block but staged it anyway; inspect \`git -C ${REPO} diff --cached\` and unstage this block's files`,
  'review-unwritten': 'a reviewer reported a failing verdict but did not confirm writing its review file',
  'passed-regression': 'acceptance passed the block but flagged a regression and staged nothing, so its work must never be staged as it is',
}[haltKind] || `the run halted (${haltKind || 'unknown halt'})`);

// A closing pass that listed entries names them, since each holds a fix that needs a blind review, which only the user can schedule.
// `recorded` is null when the pass gave no usable list, which may hide such an entry.
const closingRecordNote = (p, recorded) => {
  if (recorded === null) {
    return `, then the line "The closing pass returned no usable list of the backlog entries it listed, so check ${(p.blocks ?? [p]).map((b) => backlogFile(b.id)).join(', ')} for an entry whose fix needs a blind review."`;
  }
  if (!recorded.length) return '';
  return `, then the line "The closing pass listed these backlog entries, each with a **Fix:** line that names a fix that needs a blind review: ${recorded.join(', ')}."`;
};

/**
 * What the park entry's **What:** copies, by the cause of the park. A budget park always follows a closing
 * acceptance that found a blocking gap and wrote its review file, so the blocking gaps lead.
 */
function parkWhat(p, { escalated, userOnly, kind, haltText, closingRecorded, lastReviewPath }) {
  const question = `the latest \`## Question: ${p.id} r<n>\` entry in ${questionFile(p.id)}, copied verbatim`;
  if (userOnly && kind === 'needs-user') return question;
  if (escalated) return `the line "Halted: ${parkReason(kind, p.id)}.", then this halt reason, copied verbatim: ${haltText}${lastReviewPath ? `, then every finding and gap in ${lastReviewPath}, copied verbatim` : ''}${userOnly ? `, then ${question}` : ''}`;
  return `the line "Parked: the closing acceptance found a blocking gap.", then each gap under the "## Blocking gaps" heading of ${lastReviewPath}, then every other finding and gap in it, each copied verbatim${closingRecordNote(p, closingRecorded)}`;
}

// A park entry is built in fix mode, whose one gate is green (MODE_GATES.fix). A red-baseline block's tests
// fail by design, and a build-only block's work meets green only through a test gate, so neither may continue there.
const HAS_TEST_GATE = typeof GATES.test === 'string' && GATES.test.trim() !== '';
const parkBuildable = (p) => p.gate !== 'red-baseline' && HAS_TEST_GATE;
const unbuildableWhy = (p) => `the fix mode that builds a backlog entry takes only gate green, ${p.gate === 'red-baseline'
  ? 'and the parked block\'s red-baseline tests fail by design'
  : 'which needs a test gate, and the run that parked the block has none'}`;

// Each member of a pass names its own plan block, since the parked work spans them all.
const originOf = (p) => (p.blocks ? p.blocks.map((b) => `${b.planPath}#${b.id}`).join(', ') : `${p.planPath}#${p.id}`);

// `needsUser` marks a block whose developer escalated a user-only question, whatever halt parked it.
// `fixedIds` are the entries the developer's last report gave FIXED.
const parkPrompt = (p, { lastReviewPath, escalated, haltKind, haltText, stopsRun, needsUser, closingRecorded = [], heldHalt = false, fixedIds = [] }) => {
  const branch = unfinishedBranch(p.id);
  const index = parkIndexFile(p.id);
  const message = parkMessageFile(p.id);
  const userOnly = escalated && needsUser;
  // A fix block's round 1 restored its entries' branches, so its new commit holds their work and supersedes them.
  // The operator picks a held park's route, so each restored branch then stays.
  const supersedes = p.mode === 'fix' && !heldHalt;
  const buildable = parkBuildable(p);
  // A FAILED report may keep or revert an entry's restored work, so the working tree, which step 1e reads
  // before step 2 clears it, decides for a branch whose entries are not all FIXED.
  const restored = supersedes
    ? `
      This is a fix block, so its round 1 restored the work of each branch that the "- branch:" line of
      ${BRANCH_ENTRIES} names (print its entries with ${(p.blocks ?? [p]).map((b) => `\`node '${BLOCK_TOOL}' '${b.planPath}' '${b.id}'\``).join(', ')}).
      The developer's last report gave FIXED to ${fixedIds.length ? fixedIds.join(', ') : 'no entry'}. A FAILED report may keep or revert an entry's restored work.
      Each distinct such branch other than ${branch} that \`git -C ${REPO} rev-parse --verify --quiet refs/heads/<it>\`
      resolves is RESTORED when its every such entry that names it is on that FIXED list, or when
      \`git -C ${REPO} diff --binary <it>^1 <it> | git -C ${REPO} apply -R --check\` succeeds, since the working tree
      then still holds its work. Add \`-p <its tip>\` after the other parents for each RESTORED branch, so its
      history stays in the new commit's. Every other branch and its entry stay as they are.`
    : '';
  const supersede = supersedes
    ? `
      Then delete each RESTORED branch with \`git -C ${REPO} branch -D <it>\`, since the new commit's history
      holds its work, and return superseded_entries = the id of each entry whose branch you deleted.`
    : '';
  return `
You are PARKING the plan block "${p.id}", which ${escalated
    ? `was halted: ${parkReason(haltKind, p.id)}`
    : 'did NOT land within its round budget, since its closing acceptance found a blocking gap'}. SAVE its work as a commit on the
branch ${branch}, then clear it from the tree${stopsRun
    ? `. The run stops after you (${escalated ? 'only the user can unblock it' : 'the blocks after this one depend on it'}), so leave the repo in a
known, buildable state the user can come back to`
    : ` so the REST OF THE RUN can continue: leftover work would fail the next block's blind review, which
scopes on the unstaged diff`}. Then append ONE backlog entry that links the branch. ${!buildable
    ? `The engine keeps the block's plan status blocked, since ${unbuildableWhy(p)}, so the operator rebuilds the block from todo.`
    : heldHalt
      ? 'The engine keeps the block\'s plan status blocked until the operator picks the route its work takes.'
      : 'The engine sets the block\'s plan status to backlogged when step 2 clears the tree and leaves the build green, so that entry is the one place its work continues from. Otherwise it keeps the block blocked until the operator picks the route its work takes.'}
${ENV}
STAGING CONTRACT:
  • staged index + HEAD  = ACCEPTED blocks (the baseline). Treat as known-good; do NOT touch. No command
    in step 1 writes the repo's own index. Step 2 removes from it only the intent-to-add entries of files
    this block created.
  • unstaged working tree = THIS block's unsuccessful work — the only thing you save and clear.
  • The only commits you make are step 1's, and only ${branch} points at them. ${COMMIT ? 'Only acceptance commits on HEAD\'s branch, and only a block it accepted.' : 'Nothing is EVER committed on HEAD\'s branch.'}

SAVE BEFORE YOU CLEAR. If the tree holds this block's work and step 1 cannot make its commit, STOP: leave
the tree exactly as it is, skip steps 2 and 3, and return saved=false, cleared=false, commit_sha "" and
entry_written=false.${supersedes ? ' Return superseded_entries=[] whenever step 1 makes no commit.' : ''}${p.mode === 'fix' && !supersedes
    ? ' Return superseded_entries=[], since the operator picks this park\'s route once its halt is resolved, so every branch its round 1 restored stays as it is.'
    : ''} A tree that holds no work of this block is not a stop: step 1 says what to do.

PROCEDURE:
1. SAVE. Each command names the repo with \`-C\`, so it runs from any folder.
   a. Create ${STATE_DIR}/scratch/ if needed, then seed a temporary index file with a copy of the repo's index:
        \`cp "$(git -C ${REPO} rev-parse --path-format=absolute --git-path index)" "${index}"\`
      Each command below that sets \`GIT_INDEX_FILE\` reads and writes only that copy. Delete the copy and
      ${message} once step 1 ends, whichever way it ends.
   b. BASE, the new commit's first parent, is a commit of the accepted baseline. ${COMMIT
    ? `It is HEAD: \`git -C ${REPO} rev-parse HEAD\` prints it.`
    : `Run \`GIT_INDEX_FILE="${index}" git -C ${REPO} write-tree\`, which prints the staged index's tree (an
      intent-to-add entry takes no part in it). Then \`git -C ${REPO} commit-tree <that tree> -p HEAD -m "accepted baseline"\`
      prints BASE.`}
   c. Add the block's work to the copy with \`GIT_INDEX_FILE="${index}" git -C ${REPO} add -A\`. Then drop each
      untracked path that is build output or a cache with \`GIT_INDEX_FILE="${index}" git -C ${REPO} rm --cached -r -q -- <path>\`.
      Then \`GIT_INDEX_FILE="${index}" git -C ${REPO} write-tree\` prints WORK: the accepted baseline's tree
      plus this block's unstaged tracked edits and untracked files.
   d. TREE CHECK. When WORK is the tree that \`git -C ${REPO} rev-parse <BASE>^{tree}\` prints, the tree holds
      no work of this block. Make no commit, leave the branch as it is, return saved=false and
      commit_sha "", and continue at step 2.
   e. COMMIT. Write \`unfinished: \` followed by the block's title, which is the JSON string
      ${JSON.stringify(p.title)}, decoded, as the one line of ${message}, with no quotes and no other line.
      ${REPLACE_NOTE} When \`git -C ${REPO} rev-parse --verify --quiet refs/heads/${branch}\` prints a commit id, that
      earlier tip is the second parent, so earlier unfinished work stays in the branch's history: run
      \`git -C ${REPO} commit-tree <WORK> -p <BASE> -p <tip> -F ${message}\`. Otherwise run it without
      \`-p <tip>\`.${restored} The command prints NEW, and it runs no commit hook. Then run
      \`git -C ${REPO} update-ref refs/heads/${branch} <NEW>\`.
   f. Confirm \`git -C ${REPO} rev-parse ${branch}^{tree}\` prints WORK and \`git -C ${REPO} rev-parse ${branch}^1\`
      prints BASE. Return saved=true and commit_sha=NEW.${supersede}
2. CLEAR, only when step 1 made a commit. Restore every tracked file this block modified to the accepted
   baseline: \`git -C ${REPO} checkout -- <files>\`. Remove each \`git add -N\` intent-to-add file the block
   CREATED with \`git -C ${REPO} rm -f -q -- <file>\`: that drops the index entry and the file together.
   Deleting the file alone leaves the entry, and \`git diff\` stays non-empty. Delete each other untracked
   file the new commit holds: \`git -C ${REPO} diff --name-only --no-renames --diff-filter=A <BASE> <NEW>\` lists every
   file it adds, and \`git -C ${REPO} status --porcelain\` lists the untracked ones as \`??\`. Always name
   the files: an unpathed \`git reset\`, \`git rm\` or \`git clean\` touches the index, which holds the
   accepted baseline, or files the new commit does not hold. A file is safe to remove because the new
   commit holds it. When step 1 made no commit, clear nothing.
   Either way, confirm \`git -C ${REPO} diff\` is EMPTY and \`git -C ${REPO} status --porcelain\` lists no
   \`??\` file of this block apart from build output and caches, and return cleared=true only then. Then
   run the BUILD gate and record whether it is green.
3. RECORD. Append ONE entry to ${backlogFile(p.id)}, creating ${BACKLOG_DIR}/ if it does not exist.
   ${headerLines(backlogId(p.id), p.id)}
   n is one past the highest n in that file's entry ids, or 1 when it has none:
     ### [${backlogId(p.id)}-<n>] unfinished: <block title>
     - id: ${backlogId(p.id)}-<n>
     - status: open
     - file: <the first path \`git -C ${REPO} diff --name-only ${branch}^1 ${branch}\` prints>
     - category: unfinished
     - size: <trivial | small | medium | large: the work the gaps below leave>
     - decision: <ACTIONABLE | NEEDS_USER>
     - branch: ${branch}
     - origin: ${originOf(p)}
     **What:** <${parkWhat(p, { escalated, userOnly, kind: haltKind, haltText, closingRecorded, lastReviewPath })}>
     **Fix:** ${buildable
    ? 'Close the gaps the **What:** lists on top of the work the branch holds, so each block the "- origin:" line names meets its criteria. Round 1 of the block built from this file restores that work.'
    : `Fix mode cannot build this entry, since ${unbuildableWhy(p)}. Set this entry's "- status:" to stale and set each block the "- origin:" line names back to todo, which rebuilds it under its own gate.`}
   When step 1 made no commit, this park saved no work to restore, so write no "- branch:" line, even
   when ${branch} holds an earlier park's work, give "- file:" the path ${p.blocks ? p.blocks[0].planPath : p.planPath}${buildable
    ? `, and write this **Fix:** line instead:
     **Fix:** Build each block the "- origin:" line names on the accepted baseline, closing the gaps the **What:** lists, so it meets its criteria.`
    : '.'}${supersedes ? `
   When superseded_entries is not empty, end the **What:** with the line "Supersedes: <those ids>, whose
   branches this entry's branch now holds." Then append to this entry's "- origin:" line, each after ", ",
   every <planPath>#<block id> value that the "- origin:" line of those entries holds and this line does
   not, since this entry now carries the work those blocks were built for.` : ''}
   ${userOnly
    ? 'Set "- decision: NEEDS_USER", since this park waits on a question only the user can answer.'
    : !buildable
      ? 'Set "- decision: NEEDS_USER", since no fix block can build this entry.'
      : heldHalt
        ? 'Set "- decision: NEEDS_USER", since the operator picks whether this entry or the block continues its work.'
        : `When step 2 did not return cleared=true, or the build gate was not green after it, set "- decision: NEEDS_USER", since the engine then holds the park and the operator picks whether this entry or the block continues its work. Otherwise read the gaps the **What:** lists as the entry's defect. ${DECISION_RULE}`}
   Write each verbatim copy on lines of its own below the **What:** line, every copied line indented by
   four spaces, so no copied heading, fence or "- <key>:" line ends this entry or starts another when the
   plan file is parsed.
   Then return entry_written=true. ${WROTE_NOTE}
Do NOT modify any file in the repo outside this block's work.
Return saved + cleared + gates_green + commit_sha + entry_written${p.mode === 'fix' ? ' + superseded_entries' : ''} via the schema.`;
};

// Commit mode stages nothing, so the spot check reads each commit this launch made, which only the engine can list.
const spotCheckStep = (commits) => (COMMIT
  ? `Spot-check this launch's commits, each with the command beside its block:
${commits.map((c) => `     ${c.id}: \`git -C ${REPO} show --stat ${c.sha}\``).join('\n') || '     (none: every block this launch accepted was a no-op that made no commit)'}
   A block an earlier launch accepted has its commit before these, in \`git -C ${REPO} log --stat\`. Do these
   commits and the earlier ones plausibly cover every block's acceptance?`
  : `Spot-check the staged diff (\`git -C ${REPO} diff --staged --stat\`): does it plausibly cover every
   block's acceptance?`);

const sweepPrompt = (doneIds, commits) => `
You are the FINAL COMPLETENESS SWEEP. Every block is done and its work is ${COMMIT ? 'COMMITTED' : 'STAGED'}. Verify, against the
repo itself, that the GOAL is fully achieved. Find what the plan MISSED. Do not re-review accepted work.
Read the approved plan file(s) VERBATIM and IN FULL (ENV's never-the-whole-plan-file rule does not apply to
this role, and for this role "the files this block touches" means the files the goal or the plan names,
every file in ${COMMIT ? "this launch's commits" : 'the staged diff'}, and every file a step-1 grep hits): ${PLAN_FILES.join(' , ')}.
${ENV}
COMPLETED BLOCKS: ${doneIds.join(', ')}
Before step 1, READ ${DECISIONS} and every ${STATE_DIR}/AMENDED-<id>.md (list ${STATE_DIR}/ to find them), each
only if it exists. A recorded amendment or decision is never a gap.
Where a block's text explicitly excludes something the goal line covers, the block's text decides. A goal
hit that no block's text names or excludes is still a gap.

PROCEDURE (read-only except step 4):
1. RE-DERIVE the change surface from the GOAL: grep the target repo for every pattern/API/symbol the goal
   replaces or touches. Any hit that should have been converted but wasn't = a gap. Record hit counts.
   Also grep every guide and README in the repo, including those of other components, for each file name,
   phrase or behavior the goal moves or renames.
2. Run each distinct gate command once (build and test may be the same command) and record the real
   outcome. If the GOAL implies whole-suite green at the end, a red suite is a gap. If a red tail is
   expected, say which failures look expected vs surprising.
3. ${spotCheckStep(commits)} Look for suspiciously-untouched areas the GOAL names.
4. WRITE ${SWEEP_FILE}. ${REPLACE_NOTE} ${WROTE_NOTE} It holds the suite result, then each gap (title + file:line evidence + a suggested
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
//   status:'todo'   — the only status this engine builds. done/skip/backlogged/parked/blocked are never selected.
//   runOnly: [ids]  — build exactly these blocks (in array order).
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
}
const isFullRun = !runOnly;

// Scoped to pending, so an all-done relaunch reaches the nothing-to-run terminal instead of throwing over
// a test command it will never run.
if (pending.some((p) => p.gate === 'green') && (typeof A.gates?.test !== 'string' || !A.gates.test.trim())) {
  throw new Error('args.gates.test is required when any block being built has gate:"green": the shell command that runs the verification (non-zero exit = fail). A block that legitimately has none takes gate:"build-only" instead.');
}

const reviewTrail = `Numbered review files show every iteration: quality-review-<id>-rN.md in ${GATE_DIR}/ — the blind reviewer's whole world, which is why nothing carrying the plan lives in it — and acceptance-review-<id>-rN.md in ${STATE_DIR}/; ${COMMIT ? 'a git commit' : 'git staging'} marks each accepted block.`;

// A terminal, not a throw: an all-done relaunch is legitimate, and the caller must tell it from bad args.
if (!pending.length) {
  logLine(`develop: no todo blocks selected out of ${ALL_PLANS.length} — nothing to run`);
  // A halt resolved to done by hand (an INSPECT_LANDING keep, passed-unstaged, log-cap) leaves no later
  // run that sweeps, so an all-done relaunch is the last place to say the sweep may never have run.
  // A backlogged block's work lands through its park entry's own fix block, so no run of this plan sweeps it.
  const nonSkipPlans = ALL_PLANS.filter((p) => p.status !== 'skip');
  const backloggedIds = nonSkipPlans.filter((p) => p.status === 'backlogged').map((p) => p.id);
  const sweepNeverRan = SWEEP_MODE === 'goal-coverage' && isFullRun
    && nonSkipPlans.every((p) => p.status === 'done' || p.status === 'backlogged');
  const backloggedNote = backloggedIds.length
    ? ` The backlogged blocks ${backloggedIds.join(', ')} are not done: set each done once its park entry syncs fixed, as the develop guide's "Working the backlog" step 5 says, or to skip or todo once the user skips that entry, as its step 3 says.`
    : '';
  const sweepNote = sweepNeverRan
    ? ` args.sweep is goal-coverage, but the sweep runs only at the end of a run that builds a block, so it did not run here. If the last run that built blocks halted before its sweep, or a block was backlogged, verify coverage against the goal yourself.${backloggedNote}`
    : '';
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
    failed: [],
    parked: [],
    ledger: [],
    statusSync: [],
    backlogEntries: 0,
    backlogFiles: [],
    reviewTrail,
    nextStep: `No block in args.plans has status:"todo"${runOnly ? ` within runOnly [${runOnly.join(', ')}]` : ''}. Nothing was built and nothing was changed. If work remains, set that block's status back to todo in its plan file and re-run; otherwise this roadmap is finished — verify the end state yourself (run the full gates, ${COMMIT ? `\`git -C ${REPO} log --stat\`)` : `\`git -C ${REPO} diff --cached --stat\`) and commit`}.${sweepNote}`,
  };
}

logLine(`develop: ${pending.length}/${ALL_PLANS.length} block(s) to build${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : ''} [maxRounds=${MAX_ROUNDS}, ordered=${ORDERED}, suite=${SUITE}, changePolicy=${CHANGE_POLICY}, commit=${COMMIT}]`);
logLine(`develop: roles ${ROLE_KEYS.map((r) => `${r}=${M[r] ?? '(developer)'}/${EF[r] ?? '(developer)'}`).join(', ')}`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
// Also logged per block as one or more STATUS_LOG lines: run logs survive a failed or stopped run, and
// `plan-edit.mjs args` folds them into the plan file.
const statusSync = [];
let backlogEntries = 0;
let backlogUnknown = false;          // a writer's report was unusable, so a file it never named may hold entries
const backlogFiles = new Set();        // the files developers, fix verifiers and closing acceptances named in backlog_blocks
const startedBacklogFiles = new Set(); // every started block's file: what to check when a report is unknown
const keptBranches = [];               // { id, branch } a landed fix block holds the work of and that still exists
let halted = false;
let haltReason = '';
// A value, so the status line never parses haltReason prose. Every halt site sets it.
let haltKind = '';
const doneIds = [];
// Fix blocks that ended on the round-1 no-changes terminal. A value, so the result never parses a status.
const noChangeIds = [];
// Each commit-mode pass's landing state by block id. A value, so the result never parses a status.
const landingStates = new Map();
// Every agent-dead halt parks first, so a cached replay would return rounds whose work is no longer in the
// tree. The work continues from the park's backlog entry, which links the branch that holds it.
// An ordered run's later blocks depend on the parked one, so its entry is built before they are.
// An agent-dead park is held, so the held-park rule picks between that entry and the block first. A park no
// fix block can build is rebuilt from todo instead, which the halt reason's resume hint says (parkBuildable).
const deadAgentRecovery = (p) => (parkBuildable(p)
  ? `Its work, if any, is parked on a branch that the park's backlog entry links, and the block stays blocked until nextStep's rule for a held park picks that entry or the block. When it picks the entry, ${ORDERED
    ? 'work that entry first, as the develop guide\'s "Working the backlog" says, then relaunch with fresh `plan-edit.mjs args` to build the blocks still todo, since they depend on this block.'
    : 'work that entry as the develop guide\'s "Working the backlog" says, and relaunch with fresh `plan-edit.mjs args` to build the blocks still todo, in either order.'}`
  : 'Its work, if any, is parked on a branch that the park\'s backlog entry links, and the block stays blocked.');
// A branch that no longer applies holds work only the user can rebuild on the new baseline or drop. The work
// stays on the branch, since putting it in the baseline would skip both reviews. A skipped entry's origin
// blocks stay backlogged until their status is set by hand, since that entry never syncs fixed.
const RESTORE_RECOVERY = 'The user decides how that work continues. Either rebuild the branch on the accepted baseline, by rebasing or re-committing it so that `git diff <branch>^1 <branch>` applies there, keeping the work on the branch and never in the tree, the index or the baseline. Or set the entry\'s `- decision:` to SKIP, delete the branch to drop it, and set each block its `- origin:` line names to `skip`, or to `todo` to rebuild it. Then, once `plan-edit.mjs args` has applied this run\'s statuses, set the block\'s `status:` back to `todo` to build what is left.';

/**
 * What a dead acceptance verifier may have left past park's reach, which saves only unstaged work. It runs
 * `git add`, and in commit mode the commit and its hooks, before it returns, so it can die after either.
 */
function deadAcceptanceCheck(p) {
  const beforeRoute = parkBuildable(p) ? 'before you pick the route the held-park rule gives this block' : 'before you set this block back to todo';
  // The branch's first parent is the staged index in stage mode and HEAD in commit mode (park step 1b).
  if (!COMMIT) return `It may have staged the block's files before it died: check \`git -C ${REPO} diff --cached --stat\` for them ${beforeRoute}. Any such work is in the branch's first parent, the staged index, so it is outside the park's branch diff, and that branch then does not hold all of the block's work.`;
  const priorSha = ledger.filter((r) => r.commit).pop()?.commit;
  const priorHead = priorSha ? `${priorSha}, the last commit of this launch` : 'the HEAD this launch started from';
  return `It may have staged or committed the block before it died. Run \`git -C ${REPO} log -1 --stat\` ${beforeRoute}. HEAD before this block was ${priorHead}, so a newer commit is this block's, and no landing check ran on it: revert it with \`git -C ${REPO} revert <sha>\`. Work that commit holds is in the branch's first parent, HEAD, so it is outside the park's branch diff, and that branch then does not hold all of the block's work. Then \`git -C ${REPO} diff --cached --stat\` lists any files it staged: unstage them with \`git -C ${REPO} restore --staged -- <files>\` and set them aside. Work it only staged is inside the branch's diff.`;
}

/**
 * Folds one writer's backlog report into the run's count. A report it cannot use makes the count
 * unknown, since a file the writer never named may hold its entries.
 */
function recordBacklog(p, round, writer, count, namedBlocks) {
  // A pass's own id names no file, since each entry belongs to the member whose entry led to it.
  const issueBlocks = p.blocks ? p.blocks.map((b) => b.id) : [p.id];
  const countKnown = Number.isInteger(count) && count >= 0;
  const blocksKnown = Array.isArray(namedBlocks) && namedBlocks.every((id) => issueBlocks.includes(id))
    && !(count > 0 && namedBlocks.length === 0);
  if (!countKnown || !blocksKnown) {
    backlogUnknown = true;
    return;
  }
  const writtenFiles = [...new Set(namedBlocks)].map(backlogFile);
  backlogEntries += count;
  for (const file of writtenFiles) backlogFiles.add(file);
  if (count > 0) logLine(`  ⓘ ${p.id} r${round}: ${writer} added ${count} backlog entr${count === 1 ? 'y' : 'ies'} to ${writtenFiles.join(', ')}`);
}

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
    lastFixed: () => [...reported].filter(([, s]) => s === 'FIXED').map(([id]) => id),
    unreported: (ids) => [...ids].filter((id) => !reported.has(id)),
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
     * live defect from every later run. A superseded entry syncs `stale`, since a newer park entry's branch holds its work.
     */
    edits(landed, superseded = new Set()) {
      const out = [];
      for (const [id, status] of reported) {
        const mapped = issueSyncStatus(status, claimedEver.has(id), landed);
        const synced = (mapped === 'fixed' || mapped === 'stale') && unclosed.has(id) ? 'needs-attention' : mapped;
        const value = superseded.has(id) ? 'stale' : synced;
        if (!value) continue;
        if (ownerOf(id)) out.push({ planPath: ownerOf(id), id, value });
        else logLine(`  ⚠ ${p.id}: issue ${id} was reported ${status} but belongs to no block in this pass — no status edit`);
      }
      return out;
    },
  };
}

/** A feature or section verdict: its reachability, and what makes a pass thin or self-contradicting. */
function judgePlanAcceptance(acc) {
  return {
    reachable: acc?.reachable === true,
    thin: acc?.evidence_recorded !== true,
    open: acc?.reachable !== true,
    evidence: `evidence_recorded=${acc?.evidence_recorded}`,
    contraDetail: `reachable=${acc?.reachable}`,
    score: '',
    reachNote: `reachable=${acc?.reachable}, `,
  };
}

// A commit id. SHA-1 ids are 40 hex digits and SHA-256 ids are 64.
const SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const trimmedText = (value) => (typeof value === 'string' ? value.trim() : '');
// The halts that leave an accepted block's work in the baseline or the index for the operator to inspect.
const INSPECT_LANDING = new Set(['acceptance-regression', 'commit-unverified']);
// The halts whose cause the operator resolves before the work continues: an unsafe tree, work that may sit in a commit
// or in stage mode the index, where the branch's diff omits it, or a plan block no agent could read, which the entry's fix block also reads.
const HELD_PARK_HALTS = new Set(['park-unsafe', 'staging-unconfirmed', 'rejected-staged', 'agent-dead', 'plan-unreadable']);
/** The recovery a commit-mode pass halt names. Its fix issues synced needs-attention, so a kept fix block lands them by hand. */
function inspectStatus(p, round, landing) {
  const issueNote = p.mode === 'fix'
    ? ` When you set it \`done\`, also set each fix issue that ${acceptanceFile(p.id, round)} confirmed closed to \`fixed\` or \`stale\`.`
    : '';
  return `This run recorded the block as \`blocked\`. Once \`plan-edit.mjs args\` has applied this run's statuses, set its \`status:\` to \`done\` when the accepted baseline holds its reviewed work as you want it, or, once you ${landedRecovery(landing).reject}, to \`todo\` to rebuild it.${issueNote} Then relaunch with fresh \`plan-edit.mjs args\`.`;
}

/**
 * How a commit-mode verdict landed its block. Only committed=true beside a sha of commit-id shape names a
 * commit, since a sha beside committed=false may be HEAD before this block, whose revert would undo accepted
 * work. `claimed` means the verdict reports some commit, verified or not. committed=true is a no-op only in the
 * no-op shape the prompt asks for, since a fail must return committed=false and a no-op has the reviewed tree.
 */
function landingOf(acc) {
  const committed = acc.committed === true;
  const reportedSha = trimmedText(acc.commit_sha);
  const subject = trimmedText(acc.commit_subject);
  const sha = committed && SHA_PATTERN.test(reportedSha) ? reportedSha : '';
  const noOpShape = acc.pass === true && reportedSha === '' && subject === '' && acc.tree_matches === true;
  const claimed = committed && !noOpShape;
  let state = 'no-op';
  if (!committed) state = 'refused';
  else if (sha) state = 'committed';
  else if (claimed) state = 'unverified';
  return { committed, sha, subject, claimed, state };
}

/**
 * How a halt names a block's landed work and how the operator inspects and rejects it. A claimed commit with
 * no verified sha is found from HEAD, never reverted by a guessed id. `landing` is null in stage mode.
 */
function landedRecovery(landing) {
  if (landing?.sha) {
    return { landed: `COMMITTED as ${landing.sha}`, view: `git -C ${REPO} show --stat ${landing.sha}`, reject: `revert it with \`git -C ${REPO} revert ${landing.sha}\`` };
  }
  if (landing?.claimed) {
    return { landed: 'COMMITTED with no verified sha', view: `git -C ${REPO} log -1 --stat`, reject: `revert each commit it made with \`git -C ${REPO} revert <sha>\`` };
  }
  return { landed: 'STAGED', view: `git -C ${REPO} diff --cached`, reject: 'unstage and set its files aside' };
}

// An accepted block's ledger status in commit mode, by its landing state.
const LANDED_STATUS = {
  refused: 'done (staged, its commit not made)',
  committed: 'done (committed)',
  unverified: 'done (commit unverified)',
  'no-op': 'done (no-op, nothing to commit)',
};

// A block the closing acceptance landed names in its ledger status the gaps it left, which the operator reports.
const closingEntriesNote = (count) => (Number.isInteger(count) && count >= 0
  ? `the closing acceptance left ${count} backlog entr${count === 1 ? 'y' : 'ies'}`
  : 'the closing acceptance gave no usable count of the backlog entries it left');

/** What an accepted pass did with its work, for its log line. `landing` is null in stage mode. */
function landedNote(landing) {
  if (!landing) return 'STAGED';
  return {
    refused: 'STAGED, its commit NOT made',
    committed: `COMMITTED ${landing.sha}`,
    unverified: 'COMMIT UNVERIFIED',
    'no-op': 'NO-OP, no commit',
  }[landing.state];
}

/**
 * Every landing check a commit-mode pass fails, in the order its halt reason names them, each quoting the
 * value acceptance reported. The subject and tree checks need a verified sha. The dirty-tree check needs
 * committed=true, a no-op included, since a refused commit leaves its reviewed work staged and so listed.
 * Empty when the commit landed as asked.
 */
function landingChecks(p, round, acc, landing) {
  const checks = [];
  if (!landing.committed) {
    checks.push({ name: 'not committed', text: `committed=${JSON.stringify(acc.committed)}. A commit hook or commit signing may have refused the commit. The block's work is STAGED and not committed, and the hook output is in ${acceptanceFile(p.id, round)}. To keep the work, fix the cause, then run \`git -C ${REPO} commit -F ${commitFile(p.id)}\`, whose one line is the block's title.` });
  }
  if (landing.state === 'unverified') {
    checks.push({ name: 'unverified sha', text: `commit_sha=${JSON.stringify(acc.commit_sha)} beside commit_subject=${JSON.stringify(acc.commit_subject)} names no commit id, so the engine cannot tell which commit, if any, holds the work. A no-op reports a blank sha and subject with tree_matches=true, and this verdict reported tree_matches=${JSON.stringify(acc.tree_matches)}. Find the commit, if any, with \`git -C ${REPO} log -1 --stat\`.` });
  }
  if (landing.sha && landing.subject !== p.title) {
    checks.push({ name: 'wrong subject', text: `commit_subject=${JSON.stringify(acc.commit_subject)} is not the block's title ${JSON.stringify(p.title)}. A commit-msg hook may have rewritten the message.` });
  }
  if (landing.sha && acc.tree_matches !== true) {
    checks.push({ name: 'tree changed', text: `tree_matches=${JSON.stringify(acc.tree_matches)}. The commit's tree is not the tree acceptance staged and reviewed. A pre-commit hook may have rewritten and re-staged files, so the commit may hold changes no reviewer passed. ${acceptanceFile(p.id, round)} names both tree ids, and \`git -C ${REPO} diff <staged tree id> ${landing.sha}\` shows what changed between them.` });
  }
  if (landing.committed && acc.tree_clean !== true) {
    checks.push({ name: 'tree dirty', text: `tree_clean=${JSON.stringify(acc.tree_clean)}. The working tree is not clean after the commit step. A commit hook, the gate run, or a block file acceptance did not stage may have left these changes, and the next block would judge them as its own. \`git -C ${REPO} status --porcelain\` lists them. Inspect each change before you commit it or set it aside.` });
  }
  return checks;
}

/** The failed landing checks as halt-reason text, numbered in check order, or '' when none failed. */
function landingText(checks) {
  if (!checks.length) return '';
  return ` Its commit failed ${checks.length} landing check(s): ${checks.map((c, i) => `(${i + 1}) ${c.name}: ${c.text}`).join(' ')}`;
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
function finishBlock(p, rec, blockStatus, fix, superseded) {
  const members = p.blocks ?? [{ id: p.id, planPath: p.planPath }];
  const issueEdits = fix ? fix.edits(blockStatus === 'done', superseded) : [];
  const edits = [...members, ...issueEdits].map((e) => ({ planPath: e.planPath, id: e.id, key: 'status', value: e.value ?? blockStatus }));
  ledger.push(rec);
  statusSync.push(...edits);
  for (const line of statusLines(edits)) logLine(line);
}

for (const p of pending) {
  if (halted) break;
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between blocks rather
  // than letting an agent() call throw mid-block. Accepted blocks stay staged, or committed in commit mode; resume continues.
  if (budget.total && budget.remaining() < MIN_PLAN_BUDGET) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltKind = 'budget';
    haltReason = `Stopped before block ${p.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minPlanBudget). Relaunch with fresh \`plan-edit.mjs args\`: it applies this run's statuses, so the relaunch builds only the blocks still todo.`;
    logLine(`⏸ ${haltReason}`);
    break;
  }
  // A block starts only while its status line fits inside LOG_CAP, and one that overran it halts the next.
  // Progress lines have stopped by then, so the halt reason travels in the return value alone.
  if (statusRoom() < 1) {
    halted = true;
    haltKind = 'log-cap';
    haltReason = `Stopped before block ${p.id}: Claude Code keeps only a run's first ${LOG_CAP} log lines, and this block's status line could fall past them. Relaunch with fresh \`plan-edit.mjs args\`: it applies this run's statuses, so the relaunch builds only the blocks still todo.`;
    break;
  }

  // A block's model and effort pick its developer, and its park agent when models.park or efforts.park is unset. Reviews stay on the run's models and efforts.
  const devModel = p.model ?? M.develop;
  const devEffort = p.effort ?? EF.develop;
  logLine(`▶ block ${p.id} [mode=${p.mode}, gate=${p.gate}${p.model ? `, model=${p.model}` : ''}${p.effort ? `, effort=${p.effort}` : ''}]${p.blocks ? ` packing ${p.blocks.map((b) => b.id).join(', ')}` : ''}`);
  const rec = { id: p.id, mode: p.mode, gate: p.gate, model: devModel, effort: devEffort, status: 'pending', rounds: 0, closingPass: false, qualityRounds: 0, contested: 0, planAmendments: 0, staged: false, reachable: false, regression: false, results: null, thinEvidence: false, contradicted: false, parked: false, parkCleared: false, branch: null, entryWritten: false, superseded: [], unreportedSuperseded: [], heldPark: false, backlogged: false, commit: null };
  const fix = p.mode === 'fix' ? fixTracker(p) : null;
  for (const b of p.blocks ?? [p]) startedBacklogFiles.add(backlogFile(b.id));
  // The round-1 fix terminal this block ended on: 'no-changes' or 'restore-failed' ('' = none). Neither
  // parks: the tree is clean, so park would have nothing to save.
  let fixTerminal = '';
  // The latest review file the next stage must read. Empty until a reviewer writes one, and never replaced
  // by a path nobody wrote. Only an escalated park can see it empty, and its entry then names no review file.
  let reviewPath = '';
  // Every reviewPath routed to the developer in this block, in round order, for acceptance to re-check.
  const earlierReviews = new Set();
  // The rounds since the block's last blind review, whose risk files acceptance audits. The tree is
  // CUMULATIVE, so a skipped review leaves each of them unjudged until the next blind review runs.
  const unreviewedRounds = [];
  // A round since the last blind review judged a change not low risk or returned no boolean judgment.
  let riskDue = false;
  // An acceptance verdict since the last blind review found a risk judgment wrong.
  let misclassified = false;
  // Why a blind review is owed before acceptance, or '' when the developer's risk judgment lets the round
  // go straight there. The block's first round with a satisfied gate never rests on that judgment.
  const reviewDueReason = () => {
    if (rec.qualityRounds === 0) return 'the block has had no blind review in this launch';
    if (riskDue) return 'a round since its last blind review judged a change not low risk or gave no judgment';
    if (misclassified) return 'an acceptance verdict found a risk judgment wrong';
    return '';
  };
  // Set when round MAX_ROUNDS ends without a passed acceptance, which earns the block its closing pass.
  let closingDue = false;
  // The backlog entries the closing pass listed (null when its list was unusable), for the park record.
  let closingRecorded = [];
  let accepted = false;
  // `escalated` distinguishes the halts that leave real work in the tree (park it) from a round-1 baseline
  // halt (dirty-baseline, staged-baseline), which changed nothing. That work is the OPERATOR's: never park it.
  let escalated = false;
  // The escalation's kind when it parks without halting the run (needs-user in an unordered run).
  let parkKind = '';
  let round = 0;

  while (round < MAX_ROUNDS || closingDue) {
    round++;
    const closing = round === CLOSING_ROUND;
    closingDue = false;
    if (closing) rec.closingPass = true;
    else rec.rounds = round;

    // ---- DEVELOP -----------------------------------------------------------
    phase('Develop');
    // Two call sites, so the flow map draws the closing pass as a node of its own.
    let dev;
    if (!closing) {
      dev = await agent(developPrompt(p, round, reviewPath), roleOpts('develop', {
        model: devModel, effort: devEffort, schema: developSchema(p.mode), phase: 'Develop', label: `develop ${p.id} r${round}`,
      }));
    } else {
      logLine(`  ↻ ${p.id}: round ${MAX_ROUNDS} ended without a passed acceptance → closing pass (r${round}), with no develop round after it`);
      dev = await agent(developPrompt(p, round, reviewPath), roleOpts('develop', {
        model: devModel, effort: devEffort, schema: developSchema(p.mode, true), phase: 'Develop', label: `develop-closing ${p.id}`,
      }));
    }

    // ---- PRECONDITION: the developer AGENT itself came back -----------------------------------------
    // A dead developer is agent-dead, not a gate miss that burns the round budget. Halt, not throw, so
    // park still runs.
    if (!dev) {
      halted = true;
      escalated = true;   // it may have touched the tree before dying → park rather than abandon
      haltKind = 'agent-dead';
      haltReason = `Developer for block ${p.id} returned nothing in ${roundName(round)} (agent skipped or died) — no work can be assumed either way. ${deadAgentRecovery(p)}`;
      rec.status = 'BLOCKED (agent died)';
      // It may have appended a backlog entry before it died.
      backlogUnknown = true;
      logLine(`  ✋ ${p.id} r${round}: developer returned nothing (agent skipped or died) → halting before any review agent`);
      break;
    }
    // Counted before every halt below, since a developer that halts may already have appended.
    recordBacklog(p, round, 'developer', dev.backlog_entries, dev.backlog_blocks);

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
        haltReason = `Block ${p.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the reviewers' scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain). ${REPO} is the run worktree, and the user's own edits stay in the user's checkout, so this dirt is never the user's work. Never \`git add -A\` it or commit it, since wt close would land it on the user's branch with no reviewer having read it. SET IT ASIDE without touching ${COMMIT
          ? 'HEAD, which holds every accepted block as a commit'
          : 'the staged index, which holds every accepted block'}. First remove the untracked build output and caches (they regenerate). If \`git -C ${REPO} status --porcelain\` then lists no \`??\` file and \`git -C ${REPO} diff\` is empty, the tree is settled. Otherwise mark each remaining \`??\` untracked file with \`git -C ${REPO} add -N -- <file>\`, create the state dir if needed (\`mkdir -p ${STATE_DIR}\`), save \`git -C ${REPO} diff --binary > ${STATE_DIR}/set-aside-<n>.patch\` with an n no file there uses (the patch carries the new files too), and confirm that patch exists and is non-empty. SAVE BEFORE YOU CLEAR: if it does not, stop and clear nothing. Then restore the modified tracked files with \`git -C ${REPO} checkout -- <files>\`, drop each intent-to-add file with \`git -C ${REPO} rm -f -q -- <file>\`, then confirm \`git -C ${REPO} status --porcelain\` lists no \`??\` file, \`git -C ${REPO} diff\` is empty and \`git -C ${REPO} diff --cached\` is unchanged. Restore it later with a plain \`git -C ${REPO} apply <patch>\`, never \`--3way\`, which stages what it restores. An unpathed \`git reset\`, \`git rm\` or \`git stash\` touches the index, which holds the accepted baseline. When the dirt is a tracked file the provision command rewrote, such as a lockfile, also fix the command and save it again with \`project-settings.mjs set --provision\`. When the dirt is an earlier interrupted develop run's unfinished block, relaunch once it is set aside. Nothing was built, but this run recorded the block as \`blocked\`. Once the tree is settled, run \`plan-edit.mjs args\` (it applies that status), set this block's \`status:\` back to \`todo\`, run \`plan-edit.mjs args\` again, and relaunch with those args.`;
        logLine(`  ✋ ${p.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before any review agent (run-worktree dirt is never the user's work, so never ${COMMIT ? 'commit' : 'git add -A'} it; set it aside as a git diff --binary patch, never git stash, which takes the index too — steps in the halt reason)`);
        break;
      }
      // Commit mode only: acceptance's commit would carry staged work that no reviewer passed. Guarded like
      // the dirty count, since a missing value must never read as an empty index.
      if (COMMIT) {
        const stagedCount = dev.baseline_staged_files;
        if (typeof stagedCount !== 'number' || !Number.isFinite(stagedCount)) {
          logLine(`  ⚠ ${p.id} r1: developer did not report baseline_staged_files — the empty-index precondition was NOT verified`);
        } else if (stagedCount > 0) {
          halted = true;
          rec.status = 'BLOCKED (staged baseline)';
          haltKind = 'staged-baseline';
          haltReason = `Block ${p.id} was not started: ${stagedCount} file(s) in ${REPO} were already STAGED. This run commits each accepted block, so the next commit would carry staged work that no reviewer passed. Inspect them (\`git -C ${REPO} diff --cached --stat\`), then commit them when they are your own reviewed work, or unstage them with \`git -C ${REPO} restore --staged -- <files>\`. Nothing was built, but this run recorded the block as \`blocked\`. Once the index is settled, run \`plan-edit.mjs args\` (it applies that status), set this block's \`status:\` back to \`todo\`, run \`plan-edit.mjs args\` again, and relaunch with those args.`;
          logLine(`  ✋ ${p.id}: ${stagedCount} file(s) already staged in ${REPO} → halting before any review agent (commit or unstage them — git -C ${REPO} diff --cached --stat)`);
          break;
        }
      }
    }

    // ---- PRECONDITION: the developer actually HAS its block -----------------------------------------
    // The block command runs in the agent's shell, so this attestation is the only proof the block
    // arrived. `=== false` leaves a null return to the agent-dead halt above.
    if (dev?.plan_obtained === false) {
      halted = true;
      escalated = true;   // it may have touched the tree before giving up → park rather than abandon
      haltKind = 'plan-unreadable';
      haltReason = `Developer for block ${p.id} could not obtain its plan (${roundName(round)}). Its plan reference was: ${blockRef(p)}. Run that yourself: a non-zero exit names the cause (an id matching no "## Plan:" block, a pruned or mistyped plan file, or the command not permitted in this environment). Nothing was built from a guess.`;
      rec.status = 'BLOCKED (plan unreadable)';
      logLine(`  ✋ ${p.id} r${round}: developer never got its plan → halting before any review agent`);
      break;
    }

    // ---- FIX MODE: the per-issue results ARE the round's record ------------------------------------
    // Recorded before the halts below so an escalated block still reaches the ledger.
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
      haltReason = `Developer for block ${p.id} did not confirm its work stayed UNSTAGED in ${roundName(round)} (unstaged_confirmed=${JSON.stringify(dev.unstaged_confirmed)}). The staged index is the one surface neither reviewer checks — the blind critic reads \`git diff\`, ${COMMIT
        ? "and acceptance's commit takes whatever is staged — so anything staged here would be reviewed by nobody and then committed as known-good"
        : 'acceptance treats `git diff --staged` as the accepted baseline — so anything staged here would be reviewed by nobody and then inherited as known-good'}. Inspect \`git -C ${REPO} diff --cached\` before resuming.`;
      if (dev.needs_user === true) {
        rec.needsUser = true;
        haltReason += ` The developer also escalated a user-only decision (see ${questionFile(p.id)}).`;
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
        haltReason = `Developer halted for a user-only decision in block ${p.id}, ${roundName(round)} (see ${questionFile(p.id)}).`;
      } else {
        parkKind = 'needs-user';
      }
      logLine(`  ✋ ${p.id} r${round}: developer escalated a user-only decision → ${ORDERED ? 'halting' : 'parking it, the unordered run continues'} (see ${questionFile(p.id)})`);
      break;
    }
    // ---- FIX MODE, ROUND 1: a branch whose work no longer applies --------------------------------------
    // The developer reversed every restore and changed nothing, so the block ends without a park, which
    // would commit an empty tree, and the branch keeps the work for the user.
    const restoreError = fix && round === 1 ? trimmedText(dev.restore_failed) : '';
    if (restoreError) {
      fixTerminal = 'restore-failed';
      rec.restoreError = restoreError;
      rec.status = 'blocked (an unfinished branch did not apply)';
      logLine(`  ✋ ${p.id}: an unfinished branch did not apply onto the accepted baseline (${restoreError.slice(0, 300)}) → the block is blocked and every branch stays as it was`);
      if (ORDERED) {
        halted = true;
        haltKind = 'restore-failed';
        haltReason = `Fix block ${p.id} could not restore an unfinished branch in round 1: ${restoreError}. Its developer reversed every restore, so the tree is clean, and the branch still holds the work. This is an ORDERED run, so the blocks after it were not attempted. ${RESTORE_RECOVERY}`;
      }
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
    // ---- RISK: the developer's judgment of this round's changes -------------------------------------
    unreviewedRounds.push(round);
    if (typeof dev.review_needed !== 'boolean') {
      logLine(`  ⚠ ${p.id} r${round}: developer returned no risk judgment (review_needed=${JSON.stringify(dev.review_needed)}) → counted as needing a blind review`);
    }
    if (dev.review_needed !== false) riskDue = true;

    // ---- CLOSING PASS: its listed entries park nothing, since the closing acceptance sorts each gap ----
    if (closing) {
      const listed = dev.recorded_entries;
      closingRecorded = Array.isArray(listed) && listed.every((id) => typeof id === 'string') ? listed : null;
      if (closingRecorded === null) logLine(`  ⚠ ${p.id}: the closing pass returned no usable list of the backlog entries it listed (recorded_entries=${JSON.stringify(listed)})`);
      else if (closingRecorded.length) logLine(`  ⓘ ${p.id}: the closing pass listed ${closingRecorded.join(', ')}, each a fix that needs a blind review`);
    }

    // The closing pass has no round left to re-run a red gate, so acceptance judges it as a gap.
    if (!closing && !gateOk(p.gate, dev)) {
      // Retain reviewPath: a still-open review, such as a quality CONTEST, must keep being addressed. At
      // the budget the engine holds the only copy of why the gate was red, so log it.
      if (round >= MAX_ROUNDS) {
        logLine(`  ⚠ ${p.id} r${round}: gate(${p.gate}) not satisfied at round budget (via=${dev?.verification_method || 'n/a'})${dev?.gate_output ? ` — last gate output: ${String(dev.gate_output).slice(-500)}` : ''}`);
        closingDue = true;
        continue;
      }
      logLine(`  ↻ ${p.id} r${round}: gate(${p.gate}) not satisfied (build=${dev?.build_passed}, test=${dev?.test_outcome}, count=${dev?.tests_run_count}, suite=${dev?.full_suite_outcome}, via=${dev?.verification_method || 'n/a'}) → another develop round`);
      continue;
    }

    // ---- FIX MODE, ROUND 1 ONLY: nothing produced over a green gate --------------------------------
    // Derived from the results, so a round that only SKIPPED or found STALE entries cannot claim work it
    // never did. A STALE claim, alone or beside SKIPPED entries, is one acceptance must confirm, so it falls
    // through. All SKIPPED or no report closed nothing. Round 1 only: a later results:[] can follow a real fix.
    // A restored branch is unstaged work no result reflects, so it falls through to the reviews, and a park saves it.
    const produced = results.some((r) => r?.status === 'FIXED' || r?.status === 'FAILED');
    if (fix && !produced && round === 1) {
      const staleCount = results.filter((r) => r?.status === 'STALE').length;
      const restoredCount = Number.isInteger(dev?.restored_branches) ? dev.restored_branches : 0;
      if (restoredCount > 0) {
        logLine(`  ⚠ ${p.id}: closed no issue, but its round 1 restored ${restoredCount} unfinished branch(es) into the tree → the reviews judge that work`);
      } else if (staleCount > 0) {
        const claim = staleCount === results.length
          ? `every issue reported already resolved (all ${staleCount} STALE)`
          : `${staleCount} issue(s) reported already resolved (STALE), the rest SKIPPED`;
        logLine(`  ${p.id}: ${claim} — acceptance confirms each claim`);
      } else {
        fixTerminal = 'no-changes';
        noChangeIds.push(p.id);
        rec.status = 'no-changes (the fix block closed no issue: every entry was skipped or none was reported)';
        logLine(`  ⚠ ${p.id}: no changes produced — ${results.length ? 'every entry was skipped' : 'the developer reported no entries at all'}; the block is NOT done and its issues stay open`);
        if (ORDERED) {
          halted = true;
          haltKind = 'no-changes';
          haltReason = `Fix block ${p.id} produced no changes in round 1: every entry it reported was SKIPPED (or it reported none), so nothing was fixed and nothing was staged. This is an ORDERED run, so the blocks after it were not attempted. Read the block itself — an entry only gets fixed while its \`- decision:\` line says ACTIONABLE — then flip it back to todo once \`plan-edit.mjs args\` has applied this run's statuses, and relaunch. The tree is clean.`;
        }
        break;
      }
    }

    // ---- QUALITY REVIEW (blind, must pass before acceptance outside the closing pass) ----------
    // The closing pass reaches it whatever its gate, since no later round could review its changes before they land,
    // and its findings go to the closing acceptance, since no develop round follows to fix them.
    const reviewOwed = reviewDueReason() !== '';
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
        haltReason = `Quality reviewer for block ${p.id} returned nothing in ${roundName(round)} (agent skipped or died) — that is NOT a clean review. ${deadAgentRecovery(p)}`;
        rec.status = 'BLOCKED (agent died)';
        logLine(`  ✋ ${p.id} r${round}: quality reviewer returned nothing (agent skipped or died) → halting`);
        break;
      }
      // It judged the entire block diff, so every earlier round's changes now have a blind review.
      unreviewedRounds.length = 0;
      riskDue = false;
      misclassified = false;
      if (quality?.contested_dismissals) {
        rec.contested += quality.contested_dismissals;
        logLine(`  ⚠ ${p.id} r${round}: quality CONTESTED ${quality.contested_dismissals} dismissal(s) — ${closing ? 'the closing acceptance sorts each contest' : 'developer must fix or escalate, not re-dismiss'} (audit ${dismissedFile(p.id)})`);
      }
      // clean means no finding and no contest, so a clean:true beside either count
      // contradicts itself and must route its findings to the developer rather than on to acceptance.
      const qualityClean = quality.clean === true && !(Number(quality.issue_count) > 0) && !(Number(quality.contested_dismissals) > 0);
      if (quality.clean === true && !qualityClean) {
        logLine(`  ⚠ ${p.id} r${round}: quality returned clean=true with issue_count=${quality.issue_count} and contested_dismissals=${quality.contested_dismissals} — self-contradictory; treated as NOT clean`);
      }
      if (quality.clean === false && !(Number(quality.issue_count) > 0) && !(Number(quality.contested_dismissals) > 0)) {
        logLine(`  ⚠ ${p.id} r${round}: quality returned clean=false with no finding and no contest — self-contradictory; treated as NOT clean`);
      }
      if (!qualityClean) {
        // An unwritten review file would send the next developer, and park, to a path nobody wrote.
        if (quality.wrote_file !== true) {
          halted = true;
          escalated = true;
          haltKind = 'review-unwritten';
          haltReason = `Quality reviewer for block ${p.id} reported findings in ${roundName(round)} but did not confirm writing ${qualityFile(p.id, round)}, so there is no review file for the next stage to read. Check whether that file exists before resuming.`;
          rec.status = 'BLOCKED (review file not written)';
          logLine(`  ✋ ${p.id} r${round}: quality reviewer did not confirm writing ${qualityFile(p.id, round)} → halting`);
          break;
        }
        reviewPath = qualityFile(p.id, round);
        earlierReviews.add(reviewPath);
        if (closing) {
          logLine(`  ⚠ ${p.id}: the closing blind review found ${quality.issue_count ?? '?'} issue(s) → the closing acceptance sorts them (see ${reviewPath})`);
        } else if (round >= MAX_ROUNDS) {
          logLine(`  ⚠ ${p.id} r${round}: quality review left ${quality.issue_count ?? '?'} issue(s) open at round budget (see ${reviewPath})`);
          closingDue = true;
          continue;
        } else {
          logLine(`  ↻ ${p.id} r${round}: quality review found ${quality.issue_count ?? '?'} issue(s) → develop addresses ${reviewPath}`);
          continue;
        }
      } else {
        if (quality.wrote_file !== true) logLine(`  ⚠ ${p.id} r${round}: quality reviewer did not confirm writing ${qualityFile(p.id, round)}`);
        logLine(`  ✓ ${p.id} r${round}: quality review clean`);
      }
    } else if (closing) {
      logLine(`  ${p.id}: the closing pass owes no blind review → the closing acceptance audits its risk judgment`);
    } else {
      logLine(`  ${p.id} r${round}: the developer judged every change since the block's last blind review low risk → no blind review; acceptance audits the judgment`);
    }

    // ---- ACCEPTANCE REVIEW (plan-aware; stages on pass; baseline advances) ---
    phase('Acceptance');
    const acc = await agent(acceptancePrompt(p, round, fix?.claimed(), fix?.stale(), fix?.skipped(), [...earlierReviews], [...unreviewedRounds]), roleOpts('acceptance', {
      schema: acceptanceSchema(p.mode, closing), phase: 'Acceptance', label: `acceptance ${p.id} r${round}`,
    }));
    // A dead verifier is not a gap verdict, and the next round would read a review file nobody wrote.
    if (!acc) {
      halted = true;
      escalated = true;
      haltKind = 'agent-dead';
      haltReason = `Acceptance verifier for block ${p.id} returned nothing in ${roundName(round)} (agent skipped or died) — that is NOT a gap verdict. ${deadAcceptanceCheck(p)} ${deadAgentRecovery(p)}`;
      rec.status = 'BLOCKED (agent died)';
      // A fix verifier or the closing acceptance may have appended a backlog entry before it died.
      if (fix || closing) backlogUnknown = true;
      logLine(`  ✋ ${p.id} r${round}: acceptance verifier returned nothing (agent skipped or died) → halting`);
      break;
    }
    // Without the block, the verifier's pass:false would park the block as a routine gap.
    if (acc?.plan_obtained === false) {
      halted = true;
      escalated = true;
      haltKind = 'plan-unreadable';
      haltReason = `Acceptance verifier for block ${p.id} could not obtain its plan (${roundName(round)}), so it had no criteria to judge. Its plan reference was: ${blockRef(p)}. Run that yourself: a non-zero exit names the cause.`;
      rec.status = 'BLOCKED (plan unreadable)';
      logLine(`  ✋ ${p.id} r${round}: acceptance never got its plan → halting`);
      break;
    }
    // Flagged for audit, never halted, like a thin pass. A missing count flags too, or it would read as
    // a full read.
    if (earlierReviews.size > 0 && !(Number(acc.earlier_reviews_read) >= earlierReviews.size)) {
      logLine(`  ⚠ ${p.id} r${round}: acceptance read ${acc.earlier_reviews_read} of ${earlierReviews.size} earlier review file(s) — audit ${acceptanceFile(p.id, round)}`);
    }
    // The last verdict stands, since a later round may fix an earlier regression. Only a pass certifies
    // none when the field is omitted.
    if (typeof acc.regression === 'boolean') rec.regression = acc.regression;
    else if (acc.pass === true) rec.regression = false;
    // Only a fix verifier and the closing acceptance append to the backlog.
    if (fix || closing) recordBacklog(p, round, 'acceptance', acc.backlog_entries, acc.backlog_blocks);
    // Only a landing deletes or lists branches, so a kept branch on any other verdict is the expected state.
    if (fix && acc.pass === true && Array.isArray(acc.branches_kept)) {
      for (const kept of acc.branches_kept.map(trimmedText).filter(Boolean)) keptBranches.push({ id: p.id, branch: kept });
    }
    // Per mode: a fix schema has no evidence_recorded or reachable, which would flag every fix pass as thin.
    const verdict = fix ? fix.judge(acc) : judgePlanAcceptance(acc);
    const landing = COMMIT ? landingOf(acc) : null;
    const landedSha = landing?.sha ?? '';
    if (acc?.pass === true) {
      rec.reachable = verdict.reachable;
      // A thin pass (#14) is flagged for audit, not failed: acceptance already staged.
      rec.thinEvidence = verdict.thin;
      // Flag every contradiction. Halt only on the regression: staged work becomes every later baseline.
      // A reported commit holds the block's work whatever staged reports, so it lands below as a staged pass.
      const committedUnstaged = landing?.claimed === true && acc.staged !== true;
      rec.contradicted = acc?.regression === true || verdict.open || Number(acc?.gap_count) > 0 || acc?.risk_misclassified === true || committedUnstaged;
      const scoreNote = verdict.score ? ` — ${verdict.score}` : '';
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (${verdict.evidence}) — audit ${acceptanceFile(p.id, round)}` : '';
      const contraNote = rec.contradicted ? ` ⚠ CONTRADICTS ITS OWN PASS (regression=${acc?.regression}, ${verdict.contraDetail}, risk_misclassified=${acc?.risk_misclassified}, gap_count=${acc?.gap_count}${committedUnstaged ? `, staged=${acc.staged} beside commit ${landedSha || JSON.stringify(acc.commit_sha)}` : ''}) — audit ${acceptanceFile(p.id, round)}` : '';
      if (acc.wrote_file !== true) logLine(`  ⚠ ${p.id} r${round}: acceptance verifier did not confirm writing ${acceptanceFile(p.id, round)}`);
      if (acc?.staged === true || committedUnstaged) {
        accepted = true;
        rec.staged = true;
        // One function names every failed check, so the regression and commit-unverified reasons cannot drift.
        const failedChecks = landing ? landingChecks(p, round, acc, landing) : [];
        rec.commit = landedSha || null;
        if (landing) landingStates.set(p.id, landing.state);
        const landedStatus = landing ? LANDED_STATUS[landing.state] : 'done (staged)';
        rec.status = closing ? landedStatus.replace(/\)$/, `, and ${closingEntriesNote(acc.backlog_entries)})`) : landedStatus;
        logLine(`  ✓ ${p.id}: acceptance PASSED${scoreNote} — ${landedNote(landing)} (${verdict.reachNote}gate=${acc?.suite_result || 'n/a'})${thinNote}${contraNote}`);
        // Halt, not re-round (the next blind diff cannot see accepted work) and not park (park never
        // touches the baseline). The block stays "done".
        if (acc?.regression === true) {
          const { landed, view, reject } = landedRecovery(landing);
          halted = true;
          haltKind = 'acceptance-regression';
          haltReason = `Block ${p.id} was ${landed} by acceptance while the SAME verdict reported regression=true — a self-contradictory return (see ${acceptanceFile(p.id, round)}). Its work is now the baseline every later block would be judged against, so the run stops here. Inspect \`${view}\`, then keep or reject the work as workflows/develop/CLAUDE.md §6 describes for acceptance-regression. Edit the block's plan-file status only after \`plan-edit.mjs args\` has applied this run's statuses (keep → done, reject → ${reject}, then todo), and relaunch with fresh \`plan-edit.mjs args\`: the plan file selects the todo blocks.${landingText(failedChecks)}`;
          logLine(`  ✋ ${p.id}: ${landing?.claimed ? 'committed' : 'staged'} while self-reporting a REGRESSION → halting the run (inspect ${view})`);
        } else if (failedChecks.length) {
          halted = true;
          haltKind = 'commit-unverified';
          haltReason = `Block ${p.id} passed acceptance in ${roundName(round)}.${landingText(failedChecks)}${landedSha ? ` Inspect the commit with \`git -C ${REPO} show --stat ${landedSha}\`.` : ''} ${inspectStatus(p, round, landing)}`;
          logLine(`  ✋ ${p.id}: its commit failed ${failedChecks.map((c) => c.name).join(', ')} → halting the run`);
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
        haltReason = `Acceptance PASSED block ${p.id} in ${roundName(round)} but flagged a regression and staged nothing (${acc.wrote_file === true ? `see ${reviewPath}` : `it did not confirm writing ${acceptanceFile(p.id, round)}, so that file may not exist`}). Its work was left UNSTAGED and is flagged as a regression, so never stage it as it is.`;
        logLine(`  ✋ ${p.id} r${round}: acceptance passed but flagged a REGRESSION and staged nothing → parking its work, halting${contraNote}`);
        break;
      }
      // Passed but NOT staged: the staging boundary is broken — the next block's blind diff would include
      // this block's unstaged work. Do NOT advance; halt for manual staging, then relaunch.
      halted = true;
      rec.status = 'done-unstaged (verifier passed but did NOT stage)';
      haltKind = 'passed-unstaged';
      haltReason = `Block ${p.id} passed acceptance but its work was left UNSTAGED. Stage its files (git -C ${REPO} add <files>)${COMMIT ? ` and commit them with the block's title as the entire message (git -C ${REPO} commit -F <a file holding that title>)` : ''} so the baseline advances, then relaunch: the next \`plan-edit.mjs args\` marks the block done.`;
      logLine(`  ✋ ${p.id}: acceptance passed but NOT staged → halting (staging boundary)`);
      break;
    }
    // Rejected work in the index or in a commit skips every later review and becomes the baseline they judge against.
    const committedRejected = landing?.claimed === true;
    if (acc.staged === true || committedRejected) {
      const accCite = acc.wrote_file === true
        ? `see ${acceptanceFile(p.id, round)}`
        : `it did not confirm writing ${acceptanceFile(p.id, round)}, so that file may not exist`;
      const { view: commitView, reject: commitRevert } = landedRecovery(landing);
      halted = true;
      escalated = true;   // park saves any unstaged remainder and leaves the index alone
      haltKind = 'rejected-staged';
      haltReason = committedRejected
        ? `Acceptance REJECTED block ${p.id} in ${roundName(round)} but reported commit ${landedSha || JSON.stringify(acc.commit_sha)} (${accCite}), so work it failed may now sit in the accepted baseline. Inspect \`${commitView}\` and ${commitRevert} before resuming.`
        : `Acceptance REJECTED block ${p.id} in ${roundName(round)} but reported staged=true (${accCite}), so work it failed may now sit in the accepted baseline. Inspect \`git -C ${REPO} diff --cached\` and unstage this block's files before resuming.`;
      rec.status = committedRejected ? 'BLOCKED (acceptance committed a rejected block)' : 'BLOCKED (acceptance staged a rejected block)';
      if (acc.wrote_file !== true) logLine(`  ⚠ ${p.id} r${round}: acceptance verifier did not confirm writing ${acceptanceFile(p.id, round)}`);
      logLine(`  ✋ ${p.id} r${round}: acceptance failed the block but ${committedRejected ? `committed it → halting (inspect ${commitView})` : `staged it → halting (inspect git -C ${REPO} diff --cached)`}`);
      break;
    }
    if (acc.wrote_file !== true) {
      halted = true;
      escalated = true;
      haltKind = 'review-unwritten';
      haltReason = `Acceptance verifier for block ${p.id} failed the block in ${roundName(round)} but did not confirm writing ${acceptanceFile(p.id, round)}, so there is no review file for the next stage to read. Check whether that file exists before resuming.`;
      rec.status = 'BLOCKED (review file not written)';
      logLine(`  ✋ ${p.id} r${round}: acceptance verifier did not confirm writing ${acceptanceFile(p.id, round)} → halting`);
      break;
    }
    // Cleared only by the next blind review, which it forces.
    if (acc.risk_misclassified === true) misclassified = true;
    reviewPath = acceptanceFile(p.id, round);
    earlierReviews.add(reviewPath);
    const gaps = `${acc?.gap_count ?? '?'} gap(s)${acc?.regression ? ' [REGRESSION]' : ''}${acc.risk_misclassified === true ? ' [RISK MISCLASSIFIED]' : ''}`;
    if (closing) {
      logLine(`  ⚠ ${p.id}: the closing acceptance found ${gaps} that block its landing (see ${reviewPath})`);
      break;
    }
    if (round >= MAX_ROUNDS) {
      logLine(`  ⚠ ${p.id} r${round}: acceptance found ${gaps} at round budget (see ${reviewPath})`);
      closingDue = true;
      continue;
    }
    logLine(`  ↻ ${p.id} r${round}: acceptance found ${gaps} → develop addresses ${reviewPath}`);
  }

  if (accepted) {
    // Only the staged branch above sets accepted, and it set rec.status. A pass left unstaged halts instead.
    doneIds.push(p.id);
    // Accepted while self-reporting a regression, or with a commit that did not land as asked: the work IS in
    // the baseline or the index, but the operator must inspect it before anything builds on it, so the plan
    // file says blocked, never done.
    finishBlock(p, rec, INSPECT_LANDING.has(haltKind) ? 'blocked' : 'done', fix);
    continue;
  }

  // Neither fix-mode round-1 terminal (no-changes, restore-failed) parks: the developer changed nothing, so
  // there is no work to save and nothing to clear. It never counts done, and in an ORDERED run it has already halted.
  if (fixTerminal) {
    finishBlock(p, rec, 'blocked', fix);
    if (halted) break;
    continue;
  }

  // ---- PARK: save this block's work, then clear the tree ------------------------------------------
  // Clearing gives the next block's blind reviewer a diff of its own. Skipped on a halt that sets no
  // `escalated`, such as a round-1 baseline halt (dirty-baseline, staged-baseline), whose tree is the operator's.
  let superseded = new Set();
  if (!(halted && !escalated)) {
    // Ordered blocks depend on their predecessors landing.
    if (ORDERED && !halted) {
      halted = true;
      haltKind = 'parked';
      haltReason = `Block ${p.id} did not land within ${MAX_ROUNDS} rounds and its closing pass, since its closing acceptance found a blocking gap (see ${reviewPath}).`;
      logLine(`  ✋ ${p.id}: not accepted within ${MAX_ROUNDS} rounds and its closing pass → parking its work, then halting (ordered run)`);
    }
    phase('Park');
    // A needs-user parkKind can hide the halt kind that holds the park, so the held test reads haltKind.
    const heldHalt = HELD_PARK_HALTS.has(haltKind);
    // reviewPath may be empty on an escalated park: see its declaration.
    const pk = await agent(parkPrompt(p, {
      lastReviewPath: reviewPath, escalated, haltKind: parkKind || haltKind, haltText: haltReason, stopsRun: halted,
      needsUser: rec.needsUser === true, closingRecorded, heldHalt, fixedIds: fix ? fix.lastFixed() : [],
    }), roleOpts('develop', {
      // park reads agentTypes.develop: the engine looks up no agentTypes.park key.
      model: M.park ?? devModel, effort: EF.park ?? devEffort, schema: parkSchema(p.mode), phase: 'Park', label: `park:${p.id}`,
    }));
    const branch = unfinishedBranch(p.id);
    const parkFile = backlogFile(p.id);
    const reportedSha = trimmedText(pk?.commit_sha);
    // A commit id beside saved=false contradicts itself, and the tree may already be cleared: name the branch.
    const contradictory = pk?.saved !== true && SHA_PATTERN.test(reportedSha);
    // Null when park made no commit. Every later branch mention keys on this, never naming work that was not saved.
    rec.branch = (pk?.saved === true || contradictory) ? branch : null;
    // A value, so parked[] never parses status prose: an escalated block keeps its BLOCKED status.
    rec.parked = true;
    // Only a confirmed clear proves a commitless park had nothing to save.
    rec.parkCleared = pk?.cleared === true;
    rec.entryWritten = pk?.entry_written === true;
    // Only a saved commit holds the restored work, so a park with no commit supersedes no entry.
    if (fix && pk?.saved === true && !heldHalt && Array.isArray(pk.superseded_entries)) {
      superseded = new Set(pk.superseded_entries.map(trimmedText).filter(Boolean));
    }
    rec.superseded = [...superseded];
    if (superseded.size) logLine(`  ${p.id}: park superseded ${[...superseded].join(', ')}, whose branches ${branch} now holds`);
    // An id the developer never reported may not be in the block, and plan-edit rejects an unknown id, so nextStep names it.
    rec.unreportedSuperseded = fix ? fix.unreported(superseded) : [];
    if (rec.unreportedSuperseded.length) logLine(`  ⚠ ${p.id}: park superseded ${rec.unreportedSuperseded.join(', ')}, which the developer never reported — no status edit, so nextStep says to set each stale`);
    if (rec.entryWritten) {
      backlogEntries += 1;
      backlogFiles.add(parkFile);
    } else if (!pk) {
      // A dead park may have appended its entry before it died.
      backlogUnknown = true;
      startedBacklogFiles.add(parkFile);
    }
    const parkSavedTo = rec.branch
      ? `${rec.branch}${reportedSha ? ` at ${reportedSha}` : ''}`
      : (rec.parkCleared ? 'nothing to save' : pk ? 'nowhere: park confirmed no save or clear' : 'unknown: the park agent returned nothing');
    // Park's notes are the only place an empty park explains itself. Logged, not returned.
    logLine(`  ⚠ ${p.id}: ${escalated ? 'escalated to the user' : `not accepted within ${MAX_ROUNDS} rounds and its closing pass`} — PARKED (work saved to ${parkSavedTo}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${pk?.gates_green ? 'green' : 'RED'}, backlog entry ${rec.entryWritten ? 'written' : 'NOT CONFIRMED'}) — see ${parkFile}${pk?.notes ? ` — park note: ${String(pk.notes).slice(0, 300)}` : ''}`);
    const inspectBranch = `\`git -C ${REPO} log -1 --stat ${branch}\``;
    // A tree we could not clear (or a broken build) is unsafe for whatever comes next, so those DO halt
    // even in an unordered run, where a plain park does not.
    if (contradictory) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Park reported saved=false for block ${p.id} but reported commit ${reportedSha} on the branch ${branch} — the report contradicts itself. The commit may be real; inspect ${inspectBranch} before continuing (the tree was ${pk?.cleared === true ? 'already cleared' : 'left as-is'}).`;
    } else if (!pk) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The park agent for block ${p.id} returned nothing (skipped or died), so whether its work is on the branch ${branch} or still in the working tree is unknown: inspect both with ${inspectBranch} and \`git -C ${REPO} status --porcelain\`. The tree is unsafe for whatever runs next until you do.`;
    } else if (pk.cleared !== true) {
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `Block ${p.id} could not be cleared from the working tree${pk.saved === true ? ` (its work IS saved on the branch ${branch})` : ' and its work was NOT saved — the tree still holds it'}; the tree is unsafe for whatever runs next. Inspect the tree before resuming.`;
    } else if (pk?.gates_green === false) {
      // A cleared tree with a red build is not safe to resume into.
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The build gate is not green after parking block ${p.id}; the tree is unsafe for whatever runs next. Inspect the tree before resuming.`;
    } else if (halted) {
      // The run is stopping, so say where the work went (see rec.branch). An escalated block's nextStep line
      // carries its own research-first instruction, so the suffix stops at the tree state.
      const savedTo = rec.branch ? ` Its work is SAVED on the branch ${rec.branch}` : ' It had NOTHING to save (its working tree held no work)';
      const entryNote = rec.entryWritten
        ? `. The park appended one entry to ${parkFile} that says why the block parked${rec.branch ? ' and links that branch' : ''}`
        : `. The park did not confirm writing its entry in ${parkFile}`;
      // The held and buildable tests that set blockStatus below pick the route, so this text and nextStep agree.
      let resumeHint = '; work that entry with the user as the develop guide\'s "Working the backlog" says.';
      if (!rec.entryWritten) resumeHint = '; nextStep says how to add that entry first.';
      else if (!parkBuildable(p)) resumeHint = `; fix mode cannot build that entry, since ${unbuildableWhy(p)}, so nextStep says how to rebuild the block from todo${heldHalt ? ' once its halt is resolved' : ''}.`;
      else if (heldHalt) resumeHint = '; its halt holds the park, so nextStep\'s rule for a held park picks whether that entry or the block continues its work.';
      else if (rec.needsUser) resumeHint = '.';
      haltReason += `${savedTo}${entryNote}, and the tree is CLEAN${resumeHint}`;
    }
  }
  // A safe park whose entry is confirmed and buildable is `backlogged`, since that entry is where its work
  // continues. A held park, a park with no confirmed entry, a park no fix block can build and every halt that
  // never parked need the operator before the block may run again. A passed-but-unstaged block is `done`:
  // acceptance passed, and if the operator never stages it the next launch's clean-tree check halts on it. An
  // escalated block keeps the BLOCKED status its halt set.
  rec.heldPark = rec.parked && HELD_PARK_HALTS.has(haltKind);
  const backlogged = rec.parked && rec.entryWritten && !rec.heldPark && parkBuildable(p);
  rec.backlogged = backlogged;
  if (rec.parked && !escalated) {
    rec.status = backlogged ? 'backlogged (not accepted within round budget)' : 'blocked (not accepted within round budget, and its park needs the operator)';
  }
  // Guards a future exit that sets no status: a leaked 'pending' reads as "still working".
  if (rec.status === 'pending') rec.status = 'BLOCKED (engine bug: block finished with no status set)';
  let blockStatus = backlogged ? 'backlogged' : 'blocked';
  if (haltKind === 'passed-unstaged') blockStatus = 'done';
  finishBlock(p, rec, blockStatus, fix, superseded);
  if (halted) break;      // escalation / ordered park / unsafe tree stops the run; an unordered park carries on
}

// =============================================================================
// Final completeness sweep. Gated on every non-skip block being done, not on a full run: a relaunch
// derives pending from the todo blocks, so a full-run test would read false on every relaunch.
// =============================================================================
let sweep = null;
let sweepDied = false;     // the sweep RAN and DIED, which the return's `failed` entry reports
let sweepFileNote = '';
let sweepGapCount = null;  // null when the sweep returned no valid count: unknown, never zero
// Commit mode: each commit this launch made, in block order, for the sweep's spot check and nextStep.
const launchCommits = ledger.filter((r) => r.commit).map((r) => ({ id: r.id, sha: r.commit }));
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
  sweep = await agent(sweepPrompt(doneIds, launchCommits), roleOpts('sweep', {
    schema: SWEEP_SCHEMA, phase: 'Sweep', label: 'final-sweep',
  }));
  // A dead sweep is not a clean sweep. It does not halt: every block is accepted, and the sweep is advisory.
  sweepDied = !sweep;
  // The sweep file is cited only when the sweep attested writing it.
  sweepFileNote = sweep?.wrote_file === true
    ? `read ${SWEEP_FILE}`
    : `${SWEEP_FILE} was not written, so the gap count comes from the sweep's return alone`;
  sweepGapCount = Number.isInteger(sweep?.gap_count) && sweep.gap_count >= 0 ? sweep.gap_count : null;
  logLine(sweepDied
    ? `  ⚠ sweep: the final completeness check DIED — it did not run, and ${SWEEP_FILE} was not written. Every block is ${COMMIT ? 'committed' : 'staged'}, but NOTHING verified the goal was fully covered: check coverage against the goal yourself.`
    : sweep.complete
      ? `sweep: no goal-coverage gaps found (suite: ${sweep.suite_result || 'n/a'})`
      : sweepGapCount === null
        ? `  ⚠ sweep: returned no gap count, so the number of gaps is unknown — ${sweepFileNote}`
        : `sweep: ${sweepGapCount} potential gap(s) — ${sweepFileNote}`);
}

// =============================================================================
// Result (control plane → the orchestrating agent; durable progress lives in git + the review-file trail)
// =============================================================================
// Every block this run SELECTED is accepted (staged, or committed in commit mode). Scoped to `pending` (the todo slice), not to the whole array:
// entries already `done` in the plan file are the accepted baseline, not work this run owed.
const allDone = isFullRun && !halted && pending.length > 0 && doneIds.length === pending.length;
const contestedTotal = ledger.reduce((s, r) => s + (r.contested || 0), 0);
// Blocks whose developer overrode a plan clause under MATRIX 6a. Named here because AMENDED-<id>.md is
// reachable by acceptance and the sweep alone — without this the user would have to already know the file exists.
const amendedIds = ledger.filter((r) => r.planAmendments > 0).map((r) => r.id);
// Keyed on the branch and rec.parked, never the status string.
const parkedPlans = ledger.filter((r) => r.branch || r.parked === true);
// Split on rec.branch. An empty park is still a block not done.
const savedPlans = parkedPlans.filter((r) => r.branch);
const savedClearedPlans = savedPlans.filter((r) => r.parkCleared === true);
const savedUnclearedPlans = savedPlans.filter((r) => r.parkCleared !== true);
const emptyParkPlans = parkedPlans.filter((r) => !r.branch && r.parkCleared === true);
// A commitless park that never confirmed a clear may still hold the work in the tree or on its branch.
const unclearedParkPlans = parkedPlans.filter((r) => !r.branch && r.parkCleared !== true);
// A park with no confirmed entry leaves its work on a branch that nothing in the backlog links.
const unlinkedParkPlans = parkedPlans.filter((r) => r.entryWritten !== true);
// The branch may hold an earlier park's work, so an entry added by hand links it only for this park's commit.
const handBranchLine = (r) => {
  if (r.branch) return `"- branch: ${r.branch}"`;
  if (r.parkCleared === true) return 'no "- branch:" line, since this park made no commit';
  return `"- branch: ${unfinishedBranch(r.id)}" only when \`git -C ${REPO} log -1 ${unfinishedBranch(r.id)}\` shows a commit this park made`;
};
// A superseded entry the developer never reported got no status edit, while the park deleted its branch.
const unreportedSupersededPlans = parkedPlans.filter((r) => r.unreportedSuperseded?.length);
// Selected blocks that ended neither done nor parked: a fix block that closed no issue (no-changes) or whose
// unfinished branch did not apply, or a block stopped by a halt that never parks (dirty-baseline,
// staged-baseline, passed-unstaged).
const blockedPlans = ledger.filter((r) => !doneIds.includes(r.id) && !parkedPlans.includes(r));
const noChangePlans = blockedPlans.filter((r) => noChangeIds.includes(r.id));
const restoreFailedPlans = blockedPlans.filter((r) => r.restoreError);
const haltedPlans = blockedPlans.filter((r) => !noChangeIds.includes(r.id) && !r.restoreError);
// An ordered needs-user halt already says this in its halt text.
const needsUserParks = haltKind === 'needs-user' ? [] : ledger.filter((r) => r.needsUser);
// A park no fix block can build is rebuilt from todo, so its answers belong in the block, not its staled entry.
const buildableQuestions = needsUserParks.filter((r) => parkBuildable(r));
const unbuildableQuestions = needsUserParks.filter((r) => !parkBuildable(r));
// A park that never confirmed its entry may have written no copy of the question.
const linkedQuestions = needsUserParks.filter((r) => r.entryWritten === true);
const unlinkedQuestions = needsUserParks.filter((r) => r.entryWritten !== true);
// An ordered needs-user halt parks one block, whose question reaches its entry only when the park confirms it.
const haltQuestionLinked = ledger.some((r) => r.needsUser && r.entryWritten === true);
// A needs-user halt is never held, so only the block's gate decides whether a fix block can build its entry.
const haltParkBuildable = ledger.some((r) => r.needsUser && parkBuildable(r));
// A held park synced blocked, so its halt is resolved before HELD_PARK_RULE picks the entry or the block (HELD_PARK_HALTS).
// A park no fix block can build is rebuilt from todo whatever its halt, so the held-park rule skips it.
const heldParkPlans = parkedPlans.filter((r) => r.heldPark === true && parkBuildable(r));
const unbuildableParkPlans = parkedPlans.filter((r) => !parkBuildable(r));
// A park that superseded entries deleted their branches, so an entry written by hand carries their origins.
const unlinkedSupersedingPlans = unlinkedParkPlans.filter((r) => r.superseded?.length);
const unlinkedBuildablePlans = unlinkedParkPlans.filter((r) => r.heldPark !== true && parkBuildable(r));
const backloggedPlans = parkedPlans.filter((r) => r.backlogged === true);
// One rule for the two routes a held park leaves, so its entry and its block never both continue the same work.
const HELD_PARK_RULE = `Once a block's halt is resolved, set its status to backlogged when its branch holds all of its work and its backlog file holds an entry that links that branch, so that entry is the one place its work continues from, and never set it back to todo${ORDERED ? '. In this ordered run, work that entry before you relaunch the blocks after it, since they depend on it' : ''}. For a fix block, that route also sets to stale each entry whose branch its round 1 restored and whose work the new branch's tree holds, deletes that branch with \`git -C ${REPO} branch -D <branch>\`, and adds that entry's "- origin:" values to the new entry's "- origin:" line. Otherwise set that entry's "- status:" to stale, delete the branch with \`git -C ${REPO} branch -D <branch>\` when it exists, and set the block back to todo.`;
const RESEARCH_FIRST = 'research each question in it first (develop guide §6), then put the rest to the user with a recommendation each';
const HALT_STATUS = {
  'needs-user':      'BLOCKED (needs user input)',
  'dirty-baseline':  'BLOCKED (working tree was not clean — nothing was built)',
  'staged-baseline': 'BLOCKED (the index held staged work - nothing was built)',
  'plan-unreadable': 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)',
  'no-changes':      'halted (a fix block closed no issue - every entry was skipped, and the ordered run stopped there)',
  'restore-failed':  'halted (a fix block could not restore an unfinished branch, and the ordered run stopped there)',
  'agent-dead':      'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)',
  'staging-unconfirmed': 'BLOCKED (the developer did not confirm its work stayed out of the staged index, which neither reviewer reads)',
  'passed-unstaged': 'BLOCKED (a block passed but was not staged)',
  'passed-regression': 'BLOCKED (a block passed but flagged a regression and was not staged - its work is parked)',
  'acceptance-regression': 'BLOCKED (a block staged while self-reporting a regression)',
  'rejected-staged': 'BLOCKED (acceptance failed a block but staged it)',
  'commit-unverified': 'BLOCKED (a block passed but its commit did not land as asked)',
  'review-unwritten': 'BLOCKED (a reviewer failed a block without confirming its review file)',
  'parked':          'halted (a block was parked — its work is saved on a branch that a backlog entry links; the blocks after it were not attempted)',
  'park-unsafe':     'BLOCKED (a parked block left the tree unsafe)',
  'budget':          'stopped on token budget (fewer tokens remain than minPlanBudget)',
  'log-cap':         'stopped on the runtime log line cap (no room is left for a status line inside the log lines Claude Code keeps)',
};
// Commit mode's wording for the halts whose work may sit in a commit. It stays apart from HALT_STATUS, which
// gen-flows reads as a literal with no engine scope.
const COMMIT_HALT_STATUS = {
  'agent-dead': 'BLOCKED (an agent returned nothing - it was skipped or died; its unstaged work is parked, and a dead acceptance may have staged or committed)',
  'acceptance-regression': 'BLOCKED (a block staged or committed while self-reporting a regression)',
  'rejected-staged': 'BLOCKED (acceptance failed a block but staged or committed it)',
};
const status = halted
  ? ((COMMIT && COMMIT_HALT_STATUS[haltKind]) || HALT_STATUS[haltKind] || 'halted (a block needs attention)')
  : allDone
    ? `done (all blocks ${COMMIT ? 'committed' : 'staged'})`
    : parkedPlans.length || blockedPlans.length
      ? `run complete (${[
        parkedPlans.length ? `${parkedPlans.length} block(s) parked` : '',
        blockedPlans.length ? `${blockedPlans.length} block(s) blocked` : '',
      ].filter(Boolean).join(' and ')})`
      : `partial slice complete (every selected block ${COMMIT ? 'committed' : 'staged'})`;

// Commit mode names each accepted block's commit, by which the operator verifies the run, and stages nothing.
const landedIds = (state) => doneIds.filter((id) => landingStates.get(id) === state);
const noCommitIds = landedIds('no-op');
const refusedIds = landedIds('refused');
const unverifiedIds = landedIds('unverified');
const acceptedLine = COMMIT
  ? `${launchCommits.length ? `Committed: ${launchCommits.map((c) => `${c.id} (${c.sha})`).join(', ')}. ` : ''}${noCommitIds.length ? `Accepted with no commit of their own: ${noCommitIds.join(', ')}. ` : ''}${refusedIds.length ? `Accepted but its commit not made, its work staged: ${refusedIds.join(', ')}. ` : ''}${unverifiedIds.length ? `Accepted with a commit the engine could not verify: ${unverifiedIds.join(', ')}. ` : ''}`
  : `${doneIds.length ? `Staged/accepted: ${doneIds.join(', ')}. ` : ''}`;
let acceptedView = `\`git -C ${REPO} diff --cached --stat\``;
if (COMMIT) acceptedView = launchCommits.length ? `\`git -C ${REPO} show --stat <sha>\` for each commit above` : `\`git -C ${REPO} log --stat\``;
let closingLine = 'Nothing is committed — you commit.';
// Several halts leave work in the index, such as a refused commit or files staged before round 1.
if (COMMIT) closingLine = halted ? `The run halted, so the index may hold work: check \`git -C ${REPO} diff --cached --stat\` against the halt reason above.` : 'Nothing is staged.';

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
  // The sweep is develop's one auxiliary agent: its entry means it died, and `sweep: null` with no entry
  // means it did not run (sweep:none, an incomplete goal, or a halt).
  failed: sweepDied ? [{ id: 'sweep', stage: 'sweep' }] : [],
  // Parked blocks: NOT done. branch follows rec.branch, and backlogFile names the file that holds the park entry.
  parked: parkedPlans.map((r) => ({ id: r.id, mode: r.mode, branch: r.branch ?? null, backlogFile: backlogFile(r.id), entryWritten: r.entryWritten === true, status: r.status })),
  ledger,
  // One { planPath, id, key, value } edit per block this run finished and per fix entry whose status
  // changes. A block the run never reached has none.
  statusSync,
  // null when a developer's or fix verifier's report was unusable: a file may then hold entries the total would hide.
  backlogEntries: backlogUnknown ? null : backlogEntries,
  backlogFiles: backlogUnknown ? null : [...backlogFiles].sort(),
  reviewTrail,
  nextStep: `${halted ? `Run halted — ${haltReason}${haltKind === 'needs-user' ? ` Read ${NEEDS_USER} and the block's latest review file, ${RESEARCH_FIRST}. ${haltQuestionLinked
    ? 'The block\'s backlog entry holds the same question: record the answers in that entry\'s triage'
    : `The park did not confirm the block's backlog entry, so the question is only in ${NEEDS_USER}: once that entry exists, record the answers in its triage`}, as the develop guide's "Working the backlog" says, and ${haltParkBuildable ? 'build it' : 'rebuild the block from todo with those answers, as the line below that names it says,'} before you relaunch the blocks after it. The tree is clean; whether that block's work is on a branch is stated below.` : ' '}` : ''}${sweepDied
    ? `WARN THE USER FIRST: the final completeness sweep DIED, so nothing checked the goal was fully covered — verify coverage against the goal yourself before trusting this as finished. `
    : ''}${needsUserParks.length
    ? `${needsUserParks.length} block(s) escalated a user-only decision: ${needsUserParks.map((r) => r.id).join(', ')}. ${linkedQuestions.length
      ? `These questions are in their block's backlog entry, whose decision is NEEDS_USER: ${linkedQuestions.map((r) => `${r.id} in ${backlogFile(r.id)}`).join(', ')}. `
      : ''}${unlinkedQuestions.length
      ? `The park did not confirm the backlog entry of ${unlinkedQuestions.map((r) => r.id).join(', ')}, so each question is only in ${[...new Set(unlinkedQuestions.map((r) => questionFile(r.id)))].join(', ')}. `
      : ''}Read each question and the block's latest review file, ${RESEARCH_FIRST}. ${buildableQuestions.length
      ? `For ${buildableQuestions.map((r) => r.id).join(', ')}, record the answers in that block's backlog entry's triage, as the develop guide's "Working the backlog" says. `
      : ''}${unbuildableQuestions.length
      ? `For ${unbuildableQuestions.map((r) => r.id).join(', ')}, write the answers into the block's own text in its plan file, since fix mode cannot build its entry and the block is rebuilt from todo, as the line below that names it says. `
      : ''}`
    : ''}${parkedPlans.length
    ? `${parkedPlans.length} block(s) were PARKED: ${parkedPlans.map((r) => r.id).join(', ')}. ${savedClearedPlans.length
      ? `Work SAVED and cleared from the tree — nothing discarded — for: ${savedClearedPlans.map((r) => `${r.id} (on the branch ${r.branch})`).join(', ')}. `
      : ''}${savedUnclearedPlans.length
      ? `Work SAVED but NOT cleared from the tree for: ${savedUnclearedPlans.map((r) => `${r.id} (on the branch ${r.branch}, and the working tree still holds it)`).join(', ')}. Clear the tree before resuming. `
      : ''}${emptyParkPlans.length
      ? `NO work was saved for: ${emptyParkPlans.map((r) => r.id).join(', ')} — those blocks had nothing to save (their working tree held no work), so their entries link no new commit. `
      : ''}${unclearedParkPlans.length
      ? `Park did NOT confirm a save or a clear for: ${unclearedParkPlans.map((r) => `${r.id} (${unfinishedBranch(r.id)})`).join(', ')}. Their work may still be in the working tree or on that branch: inspect both before discarding anything. `
      : ''}${unlinkedParkPlans.length
      ? `Park did NOT confirm writing its backlog entry for: ${unlinkedParkPlans.map((r) => `${r.id} (${backlogFile(r.id)}, ${handBranchLine(r)})`).join(', ')}, so each stays blocked. When that file holds no "- category: unfinished" entry for this park, add one in the shape the develop guide's "Working the backlog" gives, with the "- branch:" line its block's note in this list gives.${unlinkedSupersedingPlans.map((r) => `The park of ${r.id} superseded ${r.superseded.join(', ')} and deleted their branches, so end its entry's **What:** with the line "Supersedes: ${r.superseded.join(', ')}, whose branches this entry's branch now holds." and append each "- origin:" value of those entries to its "- origin:" line. `).join('')}${unlinkedBuildablePlans.length
        ? `Once that entry exists, set ${unlinkedBuildablePlans.map((r) => r.id).join(', ')} backlogged, so the entry is the one place its work continues from. `
        : ''}`
      : ''}${heldParkPlans.length
      ? `These parked blocks stay blocked until you resolve their halt: ${heldParkPlans.map((r) => r.id).join(', ')}. ${HELD_PARK_RULE} `
      : ''}${unbuildableParkPlans.length
      ? `These parked blocks stay blocked, since the fix mode that builds a backlog entry takes only gate green: ${unbuildableParkPlans.map((r) => `${r.id} (${r.gate === 'red-baseline' ? 'its red-baseline tests fail by design' : 'gate build-only, and this run has no test gate'}${r.heldPark === true ? ', and its halt holds the park, so resolve that halt first' : ''})`).join(', ')}. For each, set its park entry's "- status:" to stale and set the block back to todo, which rebuilds it under its own gate. Its branch keeps the earlier work until you delete it with \`git -C ${REPO} branch -D <branch>\`. `
      : ''}${unreportedSupersededPlans.map((r) => `The park of ${r.id} deleted the branches of ${r.unreportedSuperseded.join(', ')}, entries its developer never reported, so no status edit reached them: set each one's "- status:" to stale, since ${r.branch} holds their work. `).join('')}${backloggedPlans.length
      ? `Each backlogged block's entry in its backlog file says why it parked and links its branch when it has one: triage and build it like any other entry, as the develop guide's "Working the backlog" says${ORDERED ? ', before you relaunch the blocks after it, since they depend on it' : ''}. Once that entry syncs fixed, set the backlogged block done, as that section's step 5 says. `
      : ''}`
    : ''}${keptBranches.length
    ? (COMMIT
      ? `Acceptance landed these blocks but could not delete the unfinished branch whose work they now hold: ${keptBranches.map((k) => `${k.branch} (${k.id})`).join(', ')}. Delete each with \`git -C ${REPO} branch -D <branch>\`. `
      : `These staged blocks hold the work of unfinished branches that stay until the user commits that work, so a landing the user rejects can be rebuilt from them: ${keptBranches.map((k) => `${k.branch} (${k.id})`).join(', ')}. Once the user commits the staged work, delete each with \`git branch -D <branch>\` in any checkout of the repo. `)
    : ''}${noChangePlans.length
    ? `${noChangePlans.length} block(s) closed NO issue and are NOT done: ${noChangePlans.map((r) => r.id).join(', ')}. statusSync marks each blocked: read its entries' \`- decision:\` lines (only ACTIONABLE entries get fixed), then flip it back to todo once \`plan-edit.mjs args\` has applied this run's statuses. `
    : ''}${restoreFailedPlans.length
    ? `${restoreFailedPlans.length} fix block(s) could not restore an unfinished branch and are NOT done: ${restoreFailedPlans.map((r) => `${r.id} (${r.restoreError})`).join('; ')}. Each developer reversed every restore, so the tree is clean, and each branch still holds its work. ${RESTORE_RECOVERY} `
    : ''}${haltedPlans.length
    ? `${haltedPlans.length} block(s) halted and are NOT done: ${haltedPlans.map((r) => r.id).join(', ')} - the halt reason above says what each needs. `
    : ''}${amendedIds.length
    ? `PLAN AMENDED for: ${amendedIds.join(', ')}. The developer overrode a plan clause it verified prescribes a real defect — read ${STATE_DIR}/AMENDED-<id>.md (and the pointer lines in ${DECISIONS})${COMMIT ? '' : ' before you commit'}, and fold anything you agree with back into the plan file. `
    : ''}${sweep && sweep.complete !== true
    ? `The sweep reported goal-coverage gaps — ${sweepFileNote}. `
    : ''}${backlogFiles.size || backlogUnknown
    ? `${backlogUnknown
      ? `A developer, fix verifier or closing acceptance returned no usable backlog report, so check these files in the project's backlog folder ${BACKLOG_DIR}/ for entries this run added: ${[...startedBacklogFiles].sort().join(', ')}.`
      : `This run added ${backlogEntries} entr${backlogEntries === 1 ? 'y' : 'ies'} to the project's backlog folder ${BACKLOG_DIR}/, in: ${[...backlogFiles].sort().join(', ')}.`} Report each added entry's severity, or its category for an entry with no severity line, and its title to the user. Work the backlog as the develop guide's "Working the backlog" says once each file's block is done, skip or backlogged, since a relaunch of a blocked block may still append to its file. `
    : ''}${acceptedLine}Verify the end state yourself: run the full gates, ${acceptedView}, and \`git -C ${REPO} status --porcelain\` (should be clean). Read the numbered review files (acceptance-review-*.md in ${STATE_DIR}/, quality-review-*.md in ${GATE_DIR}/) and each DISMISSED-<id>.md in ${GATE_DIR}/, auditing every declined finding. Show the user each entry in ${DECISIONS} if it exists, since each is a default the developer took, a plan amendment, or a ${BASELINE_FIX} that the ${CHANGE_POLICY} change policy allowed. Show a ${LOGGED_FIX_TAG} line only after you confirm the code still holds its change, since a later round or a park can undo it. Then derive the next launch's args with \`node '${toolPath('plan-edit.mjs')}' args <planPath>\`, which first folds this run's statuses into the plan file. ${closingLine}`,
};
