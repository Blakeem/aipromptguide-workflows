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
// Config — everything app/goal-specific arrives via args so the engine stays general.
// Each BLOCK is produced OUTSIDE this engine, in PLAN MODE, and read VERBATIM out of its plan file by the
// developer + acceptance verifier (never parsed-and-rebuilt — see WORKFLOW-PRINCIPLES.md #2). The blind
// quality reviewer is never given any plan path (#3). The ONLY thing that travels as control is the
// `plans` list of thin {id, planPath, mode, gate, status, planContext} knobs (routing, not content —
// #1/#8) plus the round number. Every one of those knobs is DATA the operator copies off
// `plan-block.mjs --list`, never a judgment call made here. The main agent ensures a clean unstaged
// working tree before the run (#4) — there is no baseline/loader/scribe agent.
// =============================================================================
// args arrives from the Workflow tool VERBATIM and unvalidated, so a structural typo in a hand-built
// payload dies here as a bare parse error naming the runtime. Name the payload and the fix instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
// `plans` is REQUIRED and there is NO single-plan back-compat and no inline plan: a block's body always
// lives in a plan file, addressed by id. A present-but-not-a-non-empty-array value must THROW naming the
// shape received — `plan-block.mjs --list` prints an OBJECT, so pasting that straight in is the live case.
if (!A || !Array.isArray(A.plans) || !A.plans.length) {
  const shape = !A ? 'no args at all' : A.plans === undefined ? 'nothing' : Array.isArray(A.plans) ? 'an empty array' : A.plans === null ? 'null' : `a ${typeof A.plans}`;
  throw new Error(`args.plans must be a NON-EMPTY array of { id, planPath, mode, gate, status } entries; got ${shape}. "plan-block.mjs <planPath> --list" prints an object: pass its "blocks" array (decorated with a planPath, or with the top-level planPath you ran --list against), not the object itself. There is no single-plan or inline-plan fallback.`);
}
if (!A.runId) {
  throw new Error('args must include at least { runId, root, target, gates, plans:[{id, planPath, mode, gate, status}] }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally the workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// `target.repo` is REQUIRED and has NO default. It used to fall back to `.`, i.e. ROOT — so an omitted
// repo pointed every `git -C`, the park procedure's `checkout --` + file deletion, and the gate commands
// at the workflow TOOL's own working tree instead of failing loud.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the TARGET git repo. There is no default — an omitted repo would silently run every git command (including park\'s checkout/delete) against this workflow tool\'s own directory.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const REFERENCE   = A.reference ?? '';                      // optional: a completed example to mirror
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
// A non-numeric bound must THROW, never coerce. `round < 'three'` is false on the first test, so the
// per-block loop would never run: every block would park having never spawned a developer, and the run
// would report that as an ordinary "could not accept" outcome. A documented default is not a licence to
// accept garbage — same reasoning as the `target.repo` guard above.
// Nothing is COERCED: `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite, so a
// coercing check waves through exactly the garbage that silently disables a bound. The upper bound is not
// decoration either — a fat-fingered `maxRounds: 100000` otherwise spawns agents until something dies.
// The message leads with a STATIC clause because tools/gen-flows.mjs labels a throw node with the first
// clause of its static prefix; starting with `args.${name}` rendered the node as "throw: args.".
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage parks every block without ever spawning a developer.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 4, 50);    // develop→quality→acceptance rounds per block
const MIN_PLAN_BUDGET = num(A.minPlanBudget, 'minPlanBudget', 0, 150_000); // token floor to start another block

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every role
// runs as the harness's standard workflow subagent (always available). Only set an agentType that exists
// in YOUR registry. Acceptance is opus (spec + regression, high stakes); the blind quality critic is opus
// too — measured 2026-08-01 (wt-tooling): the fast tier surfaced ONE deep-verified defect per round on
// large diffs, serializing discovery across rounds. Sweep stays fast — it searches, it doesn't review.
const M  = { develop: 'opus', quality: 'opus', acceptance: 'opus', sweep: 'sonnet', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// ROOT is the ABSOLUTE base that run-state hangs off (supplied by the main agent — see the required check
// above), so every agent + `git -C` call is cwd-independent. Run-state lands in `<ROOT>/runs/<runId>`
// unless args.stateDir overrides it.
const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const REFERENCE_P = REFERENCE ? abs(REFERENCE) : '';
const REPO        = abs(TARGET.repo);                      // absolute path to the target git repo (required)
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);   // <root>/runs/<runId> unless overridden
// The DEFAULT plan file for every entry that carries none of its own. `--list` rows have no planPath, so
// this is what keeps them usable undecorated in the common one-file case; one run may still draw blocks
// from several files by giving those entries their own planPath.
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
// Blind-reviewer placement guard (#3): run-state must live OUTSIDE the target repo so the blind quality
// reviewer cannot reach the review/ledger files through the repo tree. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the review/ledger files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
// The PLAN FILE has the same exposure, one door over (#3): a plan file inside the target repo puts the
// SPEC where the blind quality reviewer can reach it through the repo tree, and where the diff/park
// machinery could sweep it. WARN rather than throw, matching the run-state guard's precedent — a
// mid-flight throw strands a run the operator may still want, and the loud line names the correction.
// Deduped on the resolved path, since a one-file roadmap repeats the same planPath on every entry.
const PLAN_PLACEMENT_WARNED = new Set();
const warnPlanPlacement = (p) => {
  if (!p || !REPO || PLAN_PLACEMENT_WARNED.has(p)) return;
  if (p !== REPO && !p.startsWith(REPO + '/')) return;
  PLAN_PLACEMENT_WARNED.add(p);
  log(`⚠ plan file (${p}) resolves inside the target repo — the blind quality reviewer could read the spec straight out of the repo tree, and the diff/park machinery could sweep it. Move the plan under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path — never one inside the target repo.`);
};
warnPlanPlacement(PLAN_PATH);
// Where the plan-block tool lives. The default hangs it off ROOT because a checkout keeps engine, tools
// and run-state under one folder — but an INSTALLED plugin splits them: run-state (ROOT) goes to the
// persistent plugin data dir while tools/ ships in the versioned plugin cache. args.blockTool carries the
// installed tool's absolute path in that case; without it every agent gets a command that exits non-zero
// and the run halts on plan_obtained=false.
const BLOCK_TOOL  = A.blockTool ? abs(A.blockTool) : `${ROOT}/tools/plan-block.mjs`;

// =============================================================================
// File-level keys — the four values the operator copies off the plan file's own header via `--list`.
// They arrive as DATA, never as judgment: `ordered` decides whether a parked block stops the run, `suite`
// decides whether reddening the existing suite fails a green gate, `sweep` decides whether the run ends
// with a goal-coverage check, and `goal` seeds that check's re-grep. A typed value outside the set must
// THROW rather than coerce — the string "false" is truthy, and coercing it silently flips park semantics.
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
// Plans — the block list the main agent supplies (array order = build order). Each entry is a THIN
// control object (routing knobs, NOT content — the block body lives in its plan file, read verbatim).
// runOnly / startAt scope a cheaper partial slice by id without editing the plan file.
// =============================================================================
const RAW = A.plans;
const VALID_MODES  = new Set(['feature', 'section', 'fix']);
// A fix block's gate is green ONLY: its entries are defects in working code, so a build-only or
// red-baseline fix would stage a "closed" issue nothing ever ran.
const MODE_GATES   = { feature: new Set(['green', 'build-only']), section: new Set(['green', 'red-baseline', 'build-only']), fix: new Set(['green']) };
const VALID_STATUS = new Set(['todo', 'done', 'skip', 'parked', 'blocked']);

// An entry with no id addresses nothing. Sibling engines FILTERED these out silently, so a mistyped key
// built a shorter roadmap than the operator asked for and reported success on it.
const NO_ID = RAW.map((p, i) => [p, i])
  .filter(([p]) => !p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim())
  .map(([, i]) => i);
if (NO_ID.length) {
  throw new Error(`plans entries at index [${NO_ID.join(', ')}] are not objects carrying a string id. Every entry is a "blocks" row from "plan-block.mjs <planPath> --list" — { id, mode, gate, status } — optionally decorated with its own planPath and planContext.`);
}

// An id routes review/ledger file names AND is interpolated into the block command, so anything but a
// kebab slug is either a file-name collision (two ids that `slug()` folds together silently share one
// DISMISSED file) or a shell metacharacter in a command an agent runs. The plan-block tool enforces this
// on the file's headers; the engine must enforce the same rule on the control array.
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BAD_IDS = RAW.filter((p) => !KEBAB_ID.test(p.id)).map((p) => p.id);
if (BAD_IDS.length) {
  throw new Error(`plan id(s) [${BAD_IDS.join(', ')}] are not kebab slugs (a-z, 0-9, single hyphens). An id names this block's review + ledger files and is passed to the plan-block command, so it must carry no spaces, punctuation or shell characters.`);
}

// `mode` selects the developer + acceptance FRAME this engine holds, so it is REQUIRED and never
// defaulted: an omitted mode would build a migration section against the feature frame ("wire it in",
// reachable from entry points) and judge it by that instead of by call-site coverage.
const BAD_MODES = RAW.filter((p) => !VALID_MODES.has(p.mode))
  .map((p) => `${p.id}: ${p.mode === undefined ? '(omitted)' : JSON.stringify(p.mode)}`);
if (BAD_MODES.length) {
  throw new Error(`plan mode(s) [${BAD_MODES.join(', ')}] are not one of feature | section | fix. A mode picks the developer and acceptance frames, so it is required and never coerces.`);
}

// A gate is control input like the ids above, and this file fails loud on every other one. Coercing an
// unrecognized value to 'green' meant a block typoed `red_baseline` got the gate that DEMANDS the very
// tests a test-first block intends to leave failing — a guaranteed park after the full round budget. The
// legal set is the block's OWN mode's; an OMITTED gate keeps the 'green' default, so only a value that
// was typed and is wrong throws.
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
  planPath: p.planPath ? abs(p.planPath) : PLAN_PATH,
  mode: p.mode,
  gate: p.gate ?? 'green',
  status: p.status ?? 'todo',
  planContext: p.planContext === 'full' ? 'full' : 'block',
}));

// Every block needs a plan file to be addressed inside. Without one, the block reference would name an
// empty path and the developer would build against nothing while reporting success.
const NO_PATH = ALL_PLANS.filter((p) => !p.planPath).map((p) => p.id);
if (NO_PATH.length) {
  throw new Error(`plans [${NO_PATH.join(', ')}] carry no planPath and there is no top-level planPath to default to — the developer would be handed an empty plan reference. Either add planPath to each of those entries, or pass the top-level planPath you ran "plan-block.mjs <planPath> --list" against.`);
}

// Every per-block run-state file is keyed by the bare id, so two entries sharing one would overwrite each
// other's review files, DISMISSED ledger and parked patch — and the second would be judged against the
// first's trail.
const SEEN_IDS = new Set();
const DUPE_IDS = new Set();
for (const p of ALL_PLANS) {
  if (SEEN_IDS.has(p.id)) DUPE_IDS.add(p.id);
  SEEN_IDS.add(p.id);
}
if (DUPE_IDS.size) {
  throw new Error(`duplicate plan id(s) [${[...DUPE_IDS].join(', ')}] in args.plans. Every per-block run-state file (reviews, DISMISSED, AMENDED, parked patch) is keyed by the bare id, so duplicates would overwrite each other.`);
}

// The same placement check across every entry's OWN plan file, abs()-resolved above (the raw entries are
// unresolved strings, and ALL_PLANS is in its TDZ up there). The Set has already absorbed PLAN_PATH.
for (const p of ALL_PLANS) warnPlanPlacement(p.planPath);

// The distinct plan files this run draws from — what the whole-goal sweep is handed to read verbatim.
const PLAN_FILES = [...new Set(ALL_PLANS.map((p) => p.planPath))];

// How an agent gets its ONE block out of the verbatim plan file. Default (`planContext:'block'`): a
// COMMAND that prints just that block, so a twelve-block file never enters a developer's context and the
// block's END is decided by a parser — plan bodies use `##` headers, so an agent locating the block by eye
// can stop at the first `## Feature` and build against a truncated spec that looks complete.
// `planContext:'full'` hands the file instead, for a block that genuinely needs its neighbours in view.
const blockRef = (p) => `the output of:  node '${BLOCK_TOOL}' '${p.planPath}' '${p.id}'
Run it. That output is the block, verbatim. If it exits non-zero, report plan_obtained=false and STOP:
never guess at a plan you could not read. The full plan file is at ${p.planPath} if you need a
neighbouring block for context; your block is ONLY "${p.id}"`;
const planRef = (p) => p.planContext === 'full'
  ? `the block headed "## Plan: ${p.id}" inside the plan file at ${p.planPath} (read THAT block verbatim; the other blocks are CONTEXT only — your block is ONLY "${p.id}")`
  : blockRef(p);

// The blind quality reviewer's OWN directory, and the whole of what it is handed (#3). Blindness is a
// property of PLACEMENT, not of a polite instruction: STATE_DIR holds `acceptance-review-<id>-rN.md` —
// the block's acceptance criteria enumerated one by one — `AMENDED-<id>.md`, which quotes the overridden
// plan clause VERBATIM, and NEEDS-USER.md, whose amendment pointer line names that file. Disclosing
// STATE_DIR to the reviewer (as its output path and its "create the dir if needed") put all three one
// `ls` away from this engine's only unbiased code reviewer. So the two files it legitimately needs live
// down here, and no path outside this directory is ever interpolated into its prompt.
const GATE_DIR       = `${STATE_DIR}/gate`;                     // everything the BLIND quality reviewer reads or writes
const qualityFile    = (id, r) => `${GATE_DIR}/quality-review-${slug(id)}-r${r}.md`;
const acceptanceFile = (id, r) => `${STATE_DIR}/acceptance-review-${slug(id)}-r${r}.md`;
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;            // full detail; for the user (may halt the run) — GLOBAL/cumulative
const dismissedFile  = (id) => `${GATE_DIR}/DISMISSED-${slug(id)}.md`;  // terse ledger; developer → reviewers (anti-spin) — PER BLOCK
// Plan clauses the developer OVERRODE under MATRIX 6a, having verified the clause prescribes a real
// defect — PER BLOCK. Read by the ACCEPTANCE verifier only: it quotes the superseded clause verbatim, so
// it stays at the STATE_DIR root, OUTSIDE the reviewer's GATE_DIR — out of reach by placement, not by an
// instruction not to read it (#3). The NEEDS-USER pointer line that names it is out of reach the same way.
const amendedFile    = (id) => `${STATE_DIR}/AMENDED-${slug(id)}.md`;
const parkedPatch    = (id) => `${STATE_DIR}/parked-${slug(id)}.patch`;    // a block's work, saved before the tree is cleared
const parkedNewDir   = (id) => `${STATE_DIR}/parked-${slug(id)}-newfiles`; // untracked files the patch could not carry (rare)
const SWEEP_FILE     = `${STATE_DIR}/SWEEP.md`;                 // final whole-goal completeness sweep

// The settled-decisions both reviewers read so they don't re-raise closed findings (but NOT prior review
// files — that would anchor them; see WORKFLOW-PRINCIPLES.md #5). Scoped per block.
// canContest=true is the BLIND reviewer, and the flag carries both halves of that role: it gets the
// contest channel (its schema reports contested_dismissals) and the gate-scoped DISMISSED ledger ALONE —
// NEEDS-USER lives at the STATE_DIR root and its amendment pointer line names the AMENDED file, i.e. a
// route to verbatim plan text (#3). The acceptance verifier passes false: it is plan-aware, so NEEDS-USER
// is legitimate context, and it does not contest via this token — it has the stronger plan-aware OVERRIDE
// channel below, and its schema carries no contest field.
// `round` 1 notes why the ledger may be absent: it holds only what the developer has already declined.
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

// Per-block gate semantics, merged from both source engines:
//   green        -> build passes AND this block's tests RAN and PASSED
//   red-baseline -> build passes AND the authored tests FAIL for the expected reason (TDD red step)
//   build-only   -> build passes; no test pass/fail requirement (mechanical/testless blocks)
// Build (lint/compile) must ALWAYS pass — a broken build is never acceptable.
// The FILE key `suite` decides the one thing layered on top of `green`: with suite=green a reddened
// EXISTING suite fails the gate (breaking existing tests is a regression); with suite=scoped the whole
// suite may be intentionally RED mid-run, so the block is judged on its own selector alone and the
// developer reports full_suite_outcome="scoped-skip".
function gateOk(gate, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;   // build/lint must always pass
  if (gate === 'build-only') return true;
  // A red baseline needs the same false-red guard green gets below: a mistyped selector collects NOTHING
  // and exits non-zero, and a developer that EXPECTS failure at the red step reports `failed-expected`
  // with a count of 0 — a gate passed on a test that never ran, staged as a phantom TDD baseline.
  // `!== 0` not `> 0`: -1 is the schema's N/A (manual/MCP verification) and stays legal.
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
// Built PER MODE, the way the acceptance schema below already is. A fix block's worker returns a
// per-issue `results` array instead of a `produced` flag — the engine derives produced from it, so a
// round that only SKIPPED entries cannot claim work it never did — plus the round-1 inventory count the
// entries_found halt reads. feature and section keep their shape unchanged.
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
        description: 'one entry per `### [<id>]` issue in this block — every id, including the ones you did not touch',
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
      entries_found: { type: 'integer', description: 'ROUND 1 ONLY: how many `### [` issue entries you counted in the block the command printed. 0 HALTS the run before any reviewer spawns. Report -1 on later rounds (the check does not apply).' },
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
    // REQUIRED, unlike its optional twin dismissed_count: the DISMISSED file is its own standing record,
    // while an amendment's ABSENCE has to be an explicit claim of zero — an omitted field must not be
    // indistinguishable from "none this round".
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

// Built PER MODE rather than shipped as one const: half the field descriptions are the acceptance
// CONTRACT (what "reachable" means, what the gate proves), and a single wording would be wrong for one of
// the three modes every time it is used — the feature frame judges reachability from real entry points,
// the section frame judges call-site coverage, the fix frame judges root-cause closure per issue.
// A fix block enumerates no criteria and claims no reachability: its evidence IS the per-issue
// re-derivation, so those four fields are dropped rather than left required over nothing.
const acceptanceSchema = (mode) => {
  const isSection = mode === 'section';
  const isFix = mode === 'fix';
  return {
    type: 'object',
    required: isFix
      ? ['plan_obtained', 'pass', 'staged', 'fix_checks']
      : ['plan_obtained', 'pass', 'staged', 'reachable', 'criteria_total', 'criteria_met', 'evidence_recorded'],
    properties: {
      plan_obtained: { type: 'boolean', description: 'true if you actually HAVE the block text you are judging against — the plan-block command exited 0 and printed it, or (ONLY when you were handed a plan file rather than a command) you read that file. A command that failed means FALSE — never fall back to locating the block by eye. FALSE halts the run: a verdict reached without the spec is worthless.' },
      pass:        { type: 'boolean', description: isFix
        ? 'true if every claimed fix fully closes its root cause, every STALE claim is confirmed absent from the current code, no entry outside the ACTIONABLE set was touched, the gate is green, and nothing regressed'
        : isSection
          ? 'true if every acceptance criterion of THIS block is met, it is reachable, the block gate is satisfied, and nothing regressed'
          : 'true if every acceptance criterion is met, the feature is reachable, gates are green, and nothing regressed' },
      staged:      { type: 'boolean', description: isSection || isFix
        ? 'true if you ran `git add` on this block\'s files (only on pass; NEVER commit)'
        : 'true if you ran `git add` on the feature files (only on pass; NEVER commit)' },
      ...(isFix ? {
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
        reachable:   { type: 'boolean', description: isSection
          ? 'this block\'s change is actually wired in / reachable — every call site converted, route mounted, symbol exported'
          : 'the feature is actually wired in / reachable from the app entry points' },
        criteria_total: { type: 'integer', description: `acceptance criteria you enumerated from ${isSection ? 'THIS block' : 'the plan'} (0 means you enumerated none — never a legitimate pass)` },
        criteria_met:   { type: 'integer', description: 'of those, how many you found concrete evidence for' },
        evidence_recorded: { type: 'boolean', description: 'true ONLY if EVERY met criterion carries a locator (file:line / test name / command output) written in the review file' },
      }),
      regression:  { type: 'boolean', description: 'true if the unstaged diff regressed previously-staged/accepted behavior' },
      gap_count:   { type: 'integer', description: 'number of unmet criteria / gaps written to the review file (0 on pass)' },
      suite_result:{ type: 'string', description: isSection
        ? 'observed outcome of running the block gate (and, where the goal expects it, the full gates)'
        : 'observed outcome of running the FULL gates' },
    },
  };
};

// PARK — the terminal outcome for a block that did not accept, and for one the developer escalated. Its
// work is SAVED to a patch and then CLEARED from the tree, so EVERY exit leaves a clean unstaged tree —
// which is what lets the round-1 clean-baseline precondition be unconditional, including on resume.
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

// The whole-suite clause is a FILE key, not a mode: `suite:green` demands the existing suite stays green
// (breaking existing tests is a regression), `suite:scoped` allows the mid-run red a test-first migration
// expects and judges each block on its own selector.
const SUITE_LINE = SUITE === 'green'
  ? 'Also run the FULL suite to confirm you did not redden it (report full_suite_outcome).'
  : 'Do NOT chase whole-suite green — only THIS block\'s scoped tests matter; the rest of the suite may be intentionally red mid-run. Report full_suite_outcome="scoped-skip".';
const ACC_SUITE_LINE = SUITE === 'green'
  ? 'The EXISTING suite must still be green — reddening it is a regression, not an accepted block.'
  : 'Do NOT treat the intentionally-red rest of the suite as a failure: judge THIS block on its own selector.';

// Case 7's proceeding branch (needs_user=false) writes to BOTH ledgers, and the second write is what the
// gate/ placement made load-bearing: NEEDS-USER.md sits at the STATE_DIR root, so the blind reviewer no
// longer reads it, while the escalated call's defensible default is sitting in the diff. Without a line in
// the gate-scoped DISMISSED ledger, the reviewer flags that default, the developer re-routes it to case 7
// (still a user-only call), nothing changes, and the pair spins to maxRounds and PARKS a block that used
// to accept. The anti-spin channel (#5) has to reach the reviewer through the ONE file it is still handed.
// PRECEDENCE quotes each frame's own scope line, so one table serves all three modes; a line the frame
// does not carry would leave 6a outranking nothing.
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
// Role prompts — succinct; each agent gets ONE document link for its task. The DEVELOPER and ACCEPTANCE
// frames switch on the block's mode (feature = one bounded feature wired in; section = one slice of a
// breadth-spanning goal, every call site converted). The BLIND critic has ONE frame across both modes:
// it is handed no plan and no goal, so there is nothing for a mode to change.
// =============================================================================
const developPrompt = (p, round, reviewPath) => {
  // Identical in both frames — only the task lines below switch on mode.
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
  // Shown in EVERY round, round 1 included: the ledger PERSISTS across resumes, so a resumed round-1
  // developer has one to read and must not re-litigate what it already declined.
  const ledgerNote = `If ${dismissedFile(p.id)} exists, READ it first — it is YOUR running ledger of declined findings for
THIS block, and it PERSISTS across resumes (so a resumed round-1 still has it): do not duplicate an
entry, and do not re-litigate what you already declined. If the review you are addressing RE-RAISES one
as \`CONTESTS DISMISSAL:\`, you MUST FIX or ESCALATE it (never silently re-add the same dismissal).`;
  const staging = `LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit. EXCEPTION: for any file
   you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add, so reviewers' \`git diff\` sees it;
   it does not stage content). Set unstaged_confirmed=true. The acceptance verifier stages for real on
   accept — anything YOU stage is reviewed by nobody and HALTS the run.`;

  // FIX frame: the block IS the inventory. Verify-first (the entries were written from a past snapshot),
  // ACTIONABLE-only (the `- decision:` line is the USER's triage, not the developer's), and one result
  // per entry — the engine derives `produced` from those statuses, so an unreported entry is work that
  // silently never happened.
  if (p.mode === 'fix') {
    return `
You are the FIXER. Resolve the verified issues in ${planRef(p)}. That block IS the inventory: a
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
   "### [" entries in the block the command printed and report the count as entries_found. If it is 0,
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
RESULTS — return one \`results\` entry per issue id in the block, \`{ issue_id, status }\`: FIXED (you
changed code that closes it), STALE (it is not in the current code), SKIPPED (its decision is not
ACTIONABLE), FAILED (you tried and could not). Report EVERY id, including the ones you left alone — the
engine reads these statuses as the record of what this round did.
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;
  }

  if (p.mode === 'section') {
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
  }

  return `
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
};

// BLIND. No plan, no spec, no goal, no acceptance criteria — judges the code purely as code. ONE frame
// across both modes: a mode is a property of the spec, and this reviewer is never shown one.
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

const acceptancePrompt = (p, round, claimedFixed = [], claimedStale = [], reportedSkipped = []) => {
  // FIX frame: there are no criteria to enumerate — the block's entries ARE the spec, and the verdict is
  // per issue. The root cause is RE-DERIVED from current code rather than checked off against the entry's
  // own **Fix:** line, because the entry may have under-scoped the defect.
  if (p.mode === 'fix') {
    return `
You are the ACCEPTANCE VERIFIER — the final, issue-aware gate for ONE fix block. The blind code review
already passed (or was skipped because the developer changed nothing). Read ${planRef(p)}. That block IS
the inventory: one "### [<id>]" entry per issue, each with a \`- decision:\` line and a **Fix:**
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
   For EACH, read its full entry in the block, then INDEPENDENTLY re-derive the defect's root cause from
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
  }

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

// Only needs-user writes a NEEDS-USER entry, so each escalated halt names its own cause. Without this the
// park agent was told to cite a developer escalation that never happened and invented one.
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
// gateOk() only enforces the build when GATES.build is set, so an omitted command turns the build gate
// into a no-op and a build-only block passes with nothing ever compiled. Required, and required to fail
// loud.
if (typeof A.gates?.build !== 'string' || !A.gates.build.trim()) {
  throw new Error('args.gates.build is required: the shell command that defines a GREEN build (non-zero exit = fail). Without it the build gate silently no-ops and a block can pass with nothing compiled.');
}

// =============================================================================
// Pending selection — the todo filter first, then the optional slice.
//   status:'todo'   — the only status this engine builds. done/skip/parked/blocked are never selected.
//   runOnly: [ids]  — build exactly these blocks (in array order).
//   startAt: id     — build from this block to the end (skip already-accepted earlier ones).
// Resume is reconstructed by the orchestrator from git staging + the review-file trail + the plan file's
// own status keys — there is no progress file by design (#6/#10).
// =============================================================================
const TODO = ALL_PLANS.filter((p) => p.status === 'todo');
// SHAPE first, ids second. `runOnly: "block-a"` instead of `["block-a"]` is the likeliest typo here, and
// a shape test folded into the id check would swallow it: a non-array falls to null and the run silently
// builds and STAGES every remaining todo block — the outcome the unknown-id throw below exists to stop,
// reached without an error and without runOnly appearing in any log line.
if (A.runOnly !== undefined && A.runOnly !== null
    && (!Array.isArray(A.runOnly) || A.runOnly.some((id) => typeof id !== 'string' || !id.trim()))) {
  throw new Error(`Invalid slice arg: args.runOnly must be an ARRAY of block id strings; got ${JSON.stringify(A.runOnly)}. It is not coerced — a non-array drops the scope silently and builds every todo block in the roadmap.`);
}
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
let pending = TODO;
if (runOnly) {
  // An unknown id must FAIL FAST, exactly as startAt does below: a silently dropped id builds fewer
  // blocks than the operator asked for — and if every id is a typo, nothing at all, reported as a benign
  // "partial slice complete" with no error.
  const unknown = runOnly.filter((id) => !ALL_PLANS.some((p) => p.id === id));
  if (unknown.length) throw new Error(`args.runOnly ${unknown.map((id) => `"${id}"`).join(', ')} matches no plan id. Valid ids: ${ALL_PLANS.map((p) => p.id).join(', ')}`);
  pending = TODO.filter((p) => runOnly.includes(p.id));
} else if (A.startAt) {
  // Resolved against the WHOLE array, not the todo slice: startAt is normally the first not-yet-accepted
  // id, and naming an already-done one must scope the run rather than throw.
  const i = ALL_PLANS.findIndex((p) => p.id === A.startAt);
  // An unknown id must FAIL FAST — silently falling back to the full array would re-build already
  // accepted blocks (their work is the staged baseline) and burn the whole run.
  if (i < 0) throw new Error(`args.startAt "${A.startAt}" matches no plan id. Valid ids: ${ALL_PLANS.map((p) => p.id).join(', ')}`);
  const fromHere = new Set(ALL_PLANS.slice(i).map((p) => p.id));
  pending = TODO.filter((p) => fromHere.has(p.id));
}
const isFullRun = !runOnly && !A.startAt;

// Scoped to PENDING, deliberately unlike the sibling engines' all-blocks rule: with the todo filter, an
// all-done relaunch would otherwise throw over a test command this run will never execute instead of
// reaching the nothing-to-run terminal below.
if (pending.some((p) => p.gate === 'green') && (typeof A.gates?.test !== 'string' || !A.gates.test.trim())) {
  throw new Error('args.gates.test is required when any block being built has gate:"green": the shell command that runs the verification (non-zero exit = fail). A block that legitimately has none takes gate:"build-only" instead.');
}

const reviewTrail = `Numbered review files show every iteration: quality-review-<id>-rN.md in ${GATE_DIR}/ — the blind reviewer's whole world, which is why nothing carrying the plan lives in it — and acceptance-review-<id>-rN.md in ${STATE_DIR}/; git staging marks each accepted block.`;

// An all-done relaunch is a legitimate operator state, not an error: the plan file's statuses say the
// work landed. A distinct TERMINAL rather than a throw, so the caller can tell "nothing left" apart from
// "you passed something wrong".
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

// =============================================================================
// The per-block loop: develop → BLIND quality (must pass) → acceptance + regression (stages on pass; the
// accepted baseline advances block by block). A block that does NOT accept is PARKED — its work saved to
// a patch and CLEARED from the tree. Clearing is what restores the staging boundary the next block's
// blind diff needs. `ordered` then decides what happens next: an UNORDERED run carries on (independent
// features have no coupling), an ORDERED one STOPS (block N+1 depends on N having landed).
// PRECONDITION (orchestrator's job, #4): the target repo has a CLEAN unstaged working tree; any
// already-accepted blocks are STAGED. The engine spawns NO baseline/loader/scribe agent — the numbered
// review files + git staging are the only state + progress trail (#6/#10).
// =============================================================================
const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
// The plan-file `status:` edits this run's outcomes imply. Each block's edits are also logged as one
// STATUS_LOG line, because the runtime keeps a run's logs even when the run fails or is stopped, and
// `tools/plan-edit.mjs args` folds them into the plan file before the next launch.
const statusSync = [];
const STATUS_LOG = 'status-sync ';
let halted = false;
let haltReason = '';
// WHY the run halted, as a value rather than prose. The status line used to sniff substrings out of
// haltReason, so a new halt reason silently reported the wrong status; every halt site now sets this.
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
 * Records a finished block: its ledger row, its own status edit, and one edit per fix entry that changes.
 * An entry acceptance's own fix_check judged still open never syncs `fixed` or `stale`, even in a landed
 * block: the plan file is the selection truth, and either value would drop the live defect from every
 * later run.
 */
function finishBlock(p, rec, blockStatus, claimedEver, unclosedIds) {
  const edit = (id, value) => ({ planPath: p.planPath, id, key: 'status', value });
  const landed = blockStatus === 'done';
  const edits = [edit(p.id, blockStatus)];
  for (const { issue_id, status } of rec.results || []) {
    const mapped = issueSyncStatus(status, claimedEver.has(issue_id), landed);
    const value = (mapped === 'fixed' || mapped === 'stale') && unclosedIds.has(issue_id) ? 'needs-attention' : mapped;
    if (value) edits.push(edit(issue_id, value));
  }
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

  log(`▶ block ${p.id} [mode=${p.mode}, gate=${p.gate}]`);
  const rec = { id: p.id, mode: p.mode, gate: p.gate, status: 'pending', rounds: 0, qualityRounds: 0, contested: 0, planAmendments: 0, staged: false, reachable: false, regression: false, criteria: null, results: null, thinEvidence: false, contradicted: false, parked: false, patch: null, strays: null };
  // FIX mode only: the per-issue outcome, id → last status reported across rounds. The engine never parses
  // the block, so this is the ONLY record of which entries were touched — it rides out in the ledger and
  // feeds each entry's `- status:` edit in statusSync.
  const fixResults = new Map();
  // Ever-claimed FIXED, monotonic — the acceptance verifier's checklist, kept SEPARATE from the ledger Map
  // above. A later round that re-reports an id as STALE (its own round-1 fix closed it) must not withdraw
  // that fix from verification while the diff is still sitting in the unstaged tree: an empty claim list
  // makes the root-cause re-derivation vacuous and stages unverified code.
  const claimedEver = new Set();
  // Ids the latest acceptance fix_check reported actually_fixed=false. statusSync maps them needs-attention.
  const unclosedIds = new Set();
  // 'no-changes' when this fix block ended on the round-1 no-changes terminal ('' = none). It does not
  // park: the tree is clean, so park would have nothing to save.
  let fixTerminal = '';
  let reviewPath = '';           // the latest review file the developer must address (control: a path only)
  // Produced work the blind reviewer has not yet cleared: set by any producing round and by a flag, cleared
  // only by a clean review. Needed because the unstaged tree is CUMULATIVE while `produced` is per-round.
  // A round that only re-runs a red gate, or DROPs every finding (MATRIX 1/6b), reports produced=false over
  // a diff no reviewer has passed, and skipping the gate on that would stage it.
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
    // A dead agent is not a failed round: nothing is known about the tree either way. Unguarded it fell
    // into `gateOk(!dev) === false` and read as an ordinary gate miss, so the block burned its whole
    // round budget and was reported `parked (not accepted within round budget)` — telling the operator to
    // sharpen the plan when the real action is a clean relaunch. A HALT, not a throw: a throw inside the
    // block loop exits with the developer's work still unstaged and unparked.
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
    // The block command runs in the AGENT's shell, so the harness cannot verify it (no tools). This
    // attestation is the only signal that the block ever arrived — without a consumer it would be pure
    // theater, and an agent whose command was denied, or whose id matches no block, would otherwise build
    // something plausible and the run would report `done (staged)`. `=== false` so a dead agent (null) is
    // caught by the halt directly above rather than being laundered into this one.
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
    // The reviewers scope on the unstaged diff, so stray pre-existing work would be reviewed as this
    // block's and burn the whole round budget on code nobody in this run touched. Halt HERE — before any
    // quality/acceptance agent spawns. The developer did no work, so there is nothing to unwind.
    if (round === 1) {
      // Guard the VALUE, never its coercion. `Number(undefined)` is NaN and takes the warn branch, but
      // `Number(null)`, `Number(false)`, `Number('')` and `Number([])` are all 0 and all FINITE — so a
      // coercing check reads every one of them as "0 = clean" and waves this precondition through
      // silently, after which the blind reviewer judges the operator's pre-existing work as this block's
      // and acceptance stages it into the accepted baseline. Same reasoning the numeric-arg validators
      // above state, applied to an AGENT-supplied value.
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
      // FIX blocks only: the block IS the inventory, so a block that printed no `### [` entries is a fix
      // round with nothing to fix. Unguarded, the developer reports an empty results array, the no-changes
      // terminal below fires, and the run ends reporting a clean outcome over an inventory nobody read.
      // The VALUE is guarded, never coerced — `-1` (the round-2+ n/a) is a number and just falls through,
      // while `false`/`''`/`[]` would all compare `=== 0` as false and wave the precondition past.
      if (p.mode === 'fix') {
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
    // `produced` is derived from them rather than reported: a round that only SKIPPED or found STALE
    // entries changed nothing, and a `produced` flag would let it claim otherwise and pull the blind
    // reviewer onto an empty diff. Statuses accumulate across rounds (last write wins), so the ledger
    // carries every id the developer ever reported, not just the final round's. Recorded BEFORE the
    // needs_user and staging halts: a block that escalates still reaches the ledger with what it reported.
    const results = p.mode === 'fix' && Array.isArray(dev.results) ? dev.results : [];
    if (p.mode === 'fix') {
      for (const r of results) {
        if (r && typeof r.issue_id === 'string' && typeof r.status === 'string') {
          fixResults.set(r.issue_id, r.status);
          if (r.status === 'FIXED') claimedEver.add(r.issue_id);
        }
      }
      rec.results = [...fixResults].map(([issue_id, status]) => ({ issue_id, status }));
    }
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
    // The staged index is the one surface NEITHER reviewer looks at: the blind critic scopes on
    // `git diff` and acceptance treats `git diff --staged` as the ACCEPTED baseline. So work the
    // developer staged itself is reviewed by nobody and then inherited as known-good. This used to be a
    // warn-only line, which is attestation theater with a log message attached.
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
    // MATRIX 6a: the developer overrode a plan clause it verified defective. The COUNT is control plane
    // (#1/#8) — the amendment text stays in AMENDED-<id>.md, which only acceptance is handed. Coerced and
    // floored so a garbage value cannot poison the ledger total; 0/absent logs nothing at all.
    const amendments = Number(dev?.plan_amendments) || 0;
    if (amendments > 0) {
      rec.planAmendments += amendments;
      log(`  ⚠ ${p.id} r${round}: ${amendments} plan amendment(s) recorded — see ${amendedFile(p.id)}`);
    }
    const claimedIds = [...claimedEver];
    // A STALE report closes its entry at sync time, so acceptance confirms it too; one still in claimedEver
    // is this block's own fix and is already on the FIXED list.
    const staleIds = [...fixResults].filter(([id, s]) => s === 'STALE' && !claimedEver.has(id)).map(([id]) => id);
    const skippedIds = [...fixResults].filter(([, s]) => s === 'SKIPPED').map(([id]) => id);
    const produced = p.mode === 'fix'
      ? results.some((r) => r?.status === 'FIXED' || r?.status === 'FAILED')
      : dev.produced === true;
    if (produced) reviewOwed = true;
    if (!gateOk(p.gate, dev)) {
      // Gate not satisfied and no user escalation: give the developer another fresh round to fix it (it
      // re-runs the gate and sees the failure live). RETAIN reviewPath — if a prior review is still open
      // (e.g. a quality CONTEST not yet re-confirmed clean), the developer must keep addressing it while
      // also fixing the gate; only a clean quality review advances the pointer. On round 1 it is '' anyway.
      // The developer re-runs the gate live each round, so the engine holds the only copy of WHY it was
      // red once the round budget is gone — surface its diagnostics here rather than collecting them into
      // a schema nothing reads. Prose stays out of the control plane: log only.
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${p.id} r${round}: gate(${p.gate}) not satisfied at round budget (via=${dev?.verification_method || 'n/a'})${dev?.gate_output ? ` — last gate output: ${String(dev.gate_output).slice(-500)}` : ''}`); break; }
      log(`  ↻ ${p.id} r${round}: gate(${p.gate}) not satisfied (build=${dev?.build_passed}, test=${dev?.test_outcome}, count=${dev?.tests_run_count}, suite=${dev?.full_suite_outcome}, via=${dev?.verification_method || 'n/a'}) → another develop round`);
      continue;
    }

    // ---- FIX MODE, ROUND 1 ONLY: nothing produced over a green gate --------------------------------
    // There is no diff to review, stage or park, and the two outcomes are NOT the same block. Every entry
    // STALE is a CLAIM that the issues are already closed: it falls through to acceptance, which confirms
    // each STALE id against current code (the blind review has no diff to judge, so it is skipped). An
    // unverified all-STALE shortcut would close a live defect a developer misjudged. Anything else (all
    // SKIPPED, a SKIPPED/STALE mix, or an empty array) closed nothing: the entries stay open, so it must
    // never count done.
    // ROUND 1 ONLY: `produced` is per-round while the working tree is CUMULATIVE, so from round 2 a
    // developer may legitimately return results:[] after fixing a blind review finding that has no issue
    // id — taking the shortcut then would break out past quality, acceptance AND park, stranding round 1's
    // real edits unstaged, unreviewed and attributed to the next block.
    // Only round 1 is provably free of accumulated tree state.
    if (p.mode === 'fix' && !produced && round === 1) {
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
    // Skipped only when no produced work is still unreviewed. `produced` alone is not that test: it is
    // per-ROUND while the unstaged diff is CUMULATIVE, so a round that only re-runs a red gate, or DROPs
    // every finding, reports produced=false over a diff no reviewer has cleared. Skipping on that stages
    // unreviewed or actively-flagged code, with the blind critic never re-run to CONTEST the dismissals.
    // On a genuine no-op block acceptance still runs and judges the claim: the staged baseline already
    // satisfying it passes, a block that SHOULD have changed files fails for unmet criteria. The harness
    // never declares "done" itself.
    if (reviewOwed) {
      phase('Quality');
      rec.qualityRounds++;
      const quality = await agent(qualityPrompt(p, round), roleOpts('quality', {
        schema: QUALITY_SCHEMA, phase: 'Quality', label: `quality ${p.id} r${round}`,
      }));
      // A dead blind reviewer is NOT a clean review. Left unguarded, `quality?.clean !== true` sent the
      // developer to a quality-review file that was never written ("READ <path> and resolve exactly
      // those"), so the next round either stalls on a missing file or invents fixes and churns the tree.
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
    const acc = await agent(acceptancePrompt(p, round, claimedIds, staleIds, skippedIds), roleOpts('acceptance', {
      schema: acceptanceSchema(p.mode), phase: 'Acceptance', label: `acceptance ${p.id} r${round}`,
    }));
    // Same shape as the guards above: a dead verifier is not a gap verdict. Unguarded it fell to the
    // bottom of the loop and pointed the next developer at an acceptance-review file nobody wrote.
    if (!acc) {
      halted = true;
      escalated = true;
      haltKind = 'agent-dead';
      haltReason = `Acceptance verifier for block ${p.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a gap verdict, and nothing was staged. ${DEAD_AGENT_RECOVERY}`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${p.id} r${round}: acceptance verifier returned nothing (agent skipped or died) → halting`);
      break;
    }
    // The verifier's sibling of the developer's check. An acceptance verifier without the block has no
    // criteria to judge — its `pass:false` would otherwise read as an ordinary gap and park the block,
    // hiding "the spec never arrived" behind a routine round-budget failure.
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
    // Read PER MODE: a fix block's schema carries no criteria and no reachability claim, so deriving
    // either from it would log THIN EVIDENCE and CONTRADICTS ITS OWN PASS on every fix pass, over fields
    // that were never asked for. Its evidence is the per-issue root-cause re-derivation instead.
    const isFixMode = p.mode === 'fix';
    const checks = isFixMode ? (acc?.fix_checks || []) : [];
    // Every verdict, not just a pass: a refuted STALE claim in a block that never lands must not sync
    // `stale`. The latest check per id wins, so a later round's confirmation clears an earlier refusal.
    for (const c of checks) {
      if (typeof c?.issue_id !== 'string') continue;
      if (c.actually_fixed === false) unclosedIds.add(c.issue_id);
      else if (c.actually_fixed === true) unclosedIds.delete(c.issue_id);
    }
    rec.criteria = isFixMode ? null : { met: Number(acc?.criteria_met) || 0, total: Number(acc?.criteria_total) || 0 };
    if (acc?.pass === true) {
      rec.reachable = isFixMode ? null : acc?.reachable === true;
      // A pass is only as good as the enumeration behind it: no criteria, an incomplete count, or missing
      // locators means the verdict rests on assertion, not evidence (#14) — and in fix mode, a claimed fix
      // with no fix_check behind it is the same defect. Detection only — acceptance already staged, so
      // flag it for the operator's audit rather than failing the block.
      rec.thinEvidence = isFixMode
        ? checks.length < claimedIds.length + staleIds.length
        : rec.criteria.total === 0 || rec.criteria.met < rec.criteria.total || acc?.evidence_recorded !== true;
      // `pass` MEANS "reachable and nothing regressed" (the acceptance schema), and both fields are
      // REQUIRED — so a pass alongside either one contradicts the verdict's own definition and cannot be
      // a missing-field artifact. In fix mode the same contradiction is a pass carrying a fix_check that
      // says the root cause is still open. Flag both; HALT only on the regression, whose harm compounds:
      // staged work becomes the baseline every later block is judged against. An unreachable block is bad
      // but inert, and the operator guide already says to grep the integration point.
      const openChecks = checks.filter((c) => c?.actually_fixed === false).length;
      rec.contradicted = acc?.regression === true || (isFixMode ? openChecks > 0 : acc?.reachable !== true);
      const evidence = isFixMode ? `${checks.length} check(s) for ${claimedIds.length} claimed fix(es)${staleIds.length ? ` and ${staleIds.length} stale claim(s)` : ''}` : `evidence_recorded=${acc?.evidence_recorded}`;
      const thinNote = rec.thinEvidence ? ` ⚠ THIN EVIDENCE (${evidence}) — audit ${acceptanceFile(p.id, round)}` : '';
      const contraNote = rec.contradicted ? ` ⚠ CONTRADICTS ITS OWN PASS (regression=${acc?.regression}, ${isFixMode ? `unclosed=${openChecks}` : `reachable=${acc?.reachable}`}) — audit ${acceptanceFile(p.id, round)}` : '';
      const scoreNote = isFixMode ? `${checks.length} fix check(s)` : `${rec.criteria.met}/${rec.criteria.total} criteria`;
      if (acc?.staged === true) {
        accepted = true;
        rec.staged = true;
        log(`  ✓ ${p.id}: acceptance PASSED — ${scoreNote} — STAGED (${isFixMode ? '' : `reachable=${acc?.reachable}, `}gate=${acc?.suite_result || 'n/a'})${thinNote}${contraNote}`);
        // Staged WITH a self-reported regression: stop here. Not another review round (the verifier
        // already ran `git add`, so a re-round would leave staged-but-unaccepted work the next blind
        // reviewer cannot see) and not a park (the work is staged; park must never touch the baseline).
        // The block stays "done (staged)" — what halts is everything AFTER it.
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
    // accepted is only ever true together with staged (the pass-but-unstaged case halts above), so this
    // is unambiguously a staged "done".
    rec.status = 'done (staged)';
    doneIds.push(p.id);
    // Staged while self-reporting a regression: the work IS in the baseline, but the operator must inspect
    // it before anything builds on it, so the plan file says blocked, never done.
    finishBlock(p, rec, haltKind === 'acceptance-regression' ? 'blocked' : 'done', claimedEver, unclosedIds);
    continue;
  }

  // The fix-mode round-1 no-changes terminal does NOT park: the developer changed nothing, so there is no
  // work to save and nothing to clear. It never counts done, and in an ORDERED run it has already halted.
  if (fixTerminal) {
    finishBlock(p, rec, 'blocked', claimedEver, unclosedIds);
    if (halted) break;
    continue;
  }

  // ---- PARK: save this block's work, then clear the tree ------------------------------------------
  // Reached on either terminal outcome — round budget exhausted, or a developer escalation. Parking is
  // what removes the old staging boundary: this block's work no longer sits unstaged, so the NEXT block's
  // blind reviewer sees a diff that is purely its own. `ordered` decides whether there IS a next block.
  // NOT reached on a dirty-baseline halt: that broke out before the developer changed anything, and the
  // work in the tree belongs to the operator — parking it would be taking their changes hostage.
  if (!(halted && !escalated)) {
    // An ORDERED run stops at a park: its blocks are a dependency-sequenced decomposition of one goal, so
    // block N+1 routinely needs N to have landed. An UNORDERED run carries on — independent features have
    // no such coupling, and the cleared tree is exactly what the next one's blind diff needs.
    if (ORDERED && !halted) {
      halted = true;
      haltKind = 'parked';
      // `reviewPath` is EMPTY when the block never produced a review file (its gate never went green, so
      // neither reviewer ever ran). Naming an acceptance-review path that was never written points the
      // operator — days later, in the one cumulative record — at a file that does not exist.
      haltReason = `Block ${p.id} did not reach acceptance within ${MAX_ROUNDS} rounds (${reviewPath ? `see ${reviewPath}` : `it produced no review file — its gate never went green; see the run trail in ${STATE_DIR}`}).`;
      log(`  ✋ ${p.id}: not accepted within ${MAX_ROUNDS} rounds → parking its work, then halting (ordered run)`);
    }
    phase('Park');
    // Pass `reviewPath` THROUGH, empty or not. Substituting a concrete acceptance-review path here would
    // make parkPrompt's own "no review file yet" fallback unreachable, writing a path to a file that does
    // not exist into the one record the operator reads days later.
    const pk = await agent(parkPrompt(p, reviewPath, escalated, haltKind), roleOpts('develop', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${p.id}`,
    }));
    const strays = pk?.strays_saved ?? 0;
    // Patch bytes written but `saved` false — an internally inconsistent report. The tree may already be
    // cleared, so telling the user "nothing was saved" would be actively wrong: name the patch and stop.
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    rec.patch = (pk?.saved === true || contradictory) ? parkedPatch(p.id) : null;
    // A VALUE, set here at the one park site, so the return's parked[] never has to sniff status prose:
    // an escalated block keeps its "BLOCKED (needs user)" status but was still parked.
    rec.parked = true;
    if (strays > 0) rec.strays = parkedNewDir(p.id);
    if (!escalated) rec.status = 'parked (not accepted within round budget)';
    // Park's `notes` is the only place the "nothing to park" case can explain itself: step 1 tells the
    // agent to skip ahead with saved=false, patch_bytes=0 "and a note saying so", and without surfacing it
    // the line reads `work saved to nothing to save` with no reason given. Prose stays out of the control
    // plane — log only.
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
      // A cleared tree is not a SAFE tree: `gates_green` is required by PARK_SCHEMA and demanded by the
      // prompt, and a park that left the build RED must not report a tree the operator can resume into.
      halted = true;
      haltKind = 'park-unsafe';
      haltReason = `The build gate is not green after parking block ${p.id}; the tree is unsafe for whatever runs next.`;
    } else if (halted) {
      // An ordered park, or an escalation: the run is stopping, so say where the work went. Gated on
      // `rec.patch`, NOT written unconditionally: park is told to skip ahead with saved=false when the
      // diff is already empty, which every escalation that halts the developer before it edits anything
      // hits (plan-unreadable, staging-unconfirmed, needs-user, agent-dead). Naming a patch nobody wrote
      // contradicts this same return's `parked[].patch: null` and hands the user a `git apply` that fails.
      haltReason += rec.patch
        ? ` Its work is SAVED to ${rec.patch} and the tree is CLEAN; resolve with the user, then resume from this block.`
        : ` It had NOTHING to save (its working tree was already empty) and the tree is CLEAN; resolve with the user, then resume from this block.`;
    }
  }
  // Unreachable today (every exit sets a status, or parks — which sets one), and kept as a guard for a
  // future exit that forgets. It must name itself an ENGINE BUG rather than leak the initial 'pending',
  // which in a finished run's ledger reads as "still working".
  if (rec.status === 'pending') rec.status = 'BLOCKED (engine bug: block finished with no status set)';
  // Only a park over the round budget is `parked`. An escalation, an unsafe park and every halt that never
  // parked need the operator before the block may run again. A passed-but-unstaged block is `done`:
  // acceptance passed, and if the operator never stages it the next launch's clean-tree check halts on it.
  const budgetPark = rec.parked && !escalated && haltKind !== 'park-unsafe';
  let blockStatus = budgetPark ? 'parked' : 'blocked';
  if (haltKind === 'passed-unstaged') blockStatus = 'done';
  finishBlock(p, rec, blockStatus, claimedEver, unclosedIds);
  if (halted) break;      // escalation / ordered park / unsafe tree stops the run; an unordered park carries on
}

// =============================================================================
// Final completeness sweep — only when the PLAN FILE asked for one (sweep: goal-coverage), the run did
// not halt, and every block that is not `skip` is now done (either it was already `done` at launch or
// this run staged it). That last clause, not a full-run test, decides it: a relaunch derives pending from
// the todo blocks, so a full-run test would read false on every relaunch. An independent agent re-derives
// the change surface from the GOAL (grep, full gates, staged-diff spot-check) and reports anything the
// plan missed to SWEEP.md. This is the "did we actually finish?" check the per-block loop — which never
// looks beyond its own diff — cannot do.
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
  // A dead sweep is NOT a clean sweep. `(sweep?.gaps || []).length` reported "0 potential gap(s)" for a
  // check that never ran, citing a SWEEP_FILE nothing wrote — turning the run's final "did we actually
  // finish?" signal into a false all-clear. It does NOT halt: every block is already staged and accepted,
  // so failing a complete run over a missing advisory check would be worse than reporting it as missing.
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
// Anything with saved work the user must be told about. Keyed on the PATCH and on the explicit `parked`
// flag, never on the status string: an escalated block keeps its "BLOCKED (needs user)" status but was
// still parked, and dropping it here would leave its patch path unreported anywhere in the return.
const parkedPlans = ledger.filter((r) => r.patch || r.parked === true);
// Split on whether park actually WROTE a patch. A block escalated before it edited anything parks an
// empty tree (park is told to return saved=false, patch_bytes=0), and telling the user to restore
// `parked-<id>.patch` would point them at a file that does not exist — the same failure the halt reason
// guards against above. Both lists still belong in the return: an empty park is still a block not done.
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
  // Parked blocks: NOT done. `patch` is the path when park wrote one and NULL when there was nothing to
  // save (an escalation that halted the developer before it edited anything) — the prose above says which
  // is which, so neither reading promises a file that was never written. `strays` needs a second restore
  // step when it is set.
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
