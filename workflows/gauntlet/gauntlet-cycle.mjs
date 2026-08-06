export const meta = {
  name: 'gauntlet-cycle',
  description: 'Gauntlet build, lean/file-bus design: get a product DOWN to a working, code-sound MVP, then CLIMB it toward an inspectable QUALITY BAR. phase:"mvp" runs each component of the approved COMPONENTS.md in order: builder (CANON + BAR in view, spec read verbatim from its own block) -> BLIND code gate that judges defects AND structural debt and STAGES on a clean pass (git add, never commit) -> the next component. A component that cannot pass within its round budget is PARKED - its work saved to a patch and cleared from the tree - and the run STOPS, because later components build on earlier ones. phase:"refine" then climbs the staged product in WAVES: per wave, per still-open quality aspect of ASPECTS.md, a fresh critic OBSERVES the running product with its own testbed tooling, A/Bs it blind against the exemplar, and names ONE largest gap with evidence; an improver closes exactly that gap; after a wave that changed anything the same BLIND code gate reviews the WHOLE wave diff and stages it. cycles is the user brake: the run ends when every aspect closes or the waves are spent, always on a clean tree. Nothing is escalated to the user except an ENVIRONMENT fault; the agents settle every other judgment call themselves and record it. Agents exchange messages as verbatim files; the harness only routes ids, paths + verdicts.',
  whenToUse: 'Build something NEW to a working MVP/alpha and then climb it, against a QUALITY BAR you can point at (an exemplar product) and a CANON (the goal paragraph plus its hard rules), where the standard is flagship/AAA rather than "the tests pass" - a prototype, a product surface, a tool built to look and behave like a shipped thing. phase:"refine" is ALSO the entry point on its own, for a product that already works: point it at the repo with ASPECTS.md + BAR.md and no components at all. NOT for one bounded feature inside an existing codebase (use feature-cycle, which is plan-driven and stages per feature), NOT for improving a system that already works when a human should triage the list (use enhance, which stops at proposals), NOT for hunting defects in existing code (use debug). The orchestrating agent authors CANON.md, BAR.md, COMPONENTS.md and ASPECTS.md with the user BEFORE the run, under <root>/plans/<runId>/ and never inside the target repo; derives the components array with `node tools/plan-block.mjs <COMPONENTS.md> --list --kind component`; ensures a CLEAN unstaged working tree; then runs phase:"mvp" and, once it is staged, phase:"refine" with a cycles wave budget (reuse one runId throughout).',
  phases: [
    { title: 'Build', detail: 'Builder reads its component block (verbatim, via the plan-block command), CANON.md, BAR.md and the latest code review that flagged issues; implements to the quality frame, runs the gate to green, leaves changes UNSTAGED. Owns every judgment call: it settles ambiguity itself and logs it, and escalates NOTHING except an environment fault.' },
    { title: 'Gate', detail: 'BLIND code gate: reads ONLY the unstaged diff (no canon, no bar, no spec, no goal), flags production-blocking defects AND structural debt, writes code-review-<unit>-rN.md. On a clean pass it is the staging agent (git add, never commit) and the accepted baseline advances one component - or, in refine, one whole wave.' },
    { title: 'Park', detail: 'On a component that did not pass the code gate within its round budget, a refine wave that could not gate-clean, or work the run halted mid-flight: SAVES that unit\'s work to parked-<unit>.patch, then clears it from the tree so the repo is left clean and buildable. The run STOPS either way - what comes after it builds on it - but nothing is destroyed: NEEDS-USER.md carries the restore command.' },
    { title: 'Critique', detail: 'Refine only. One fresh critic per open aspect per wave: OBSERVES the running product the way its ASPECTS.md section says to (building whatever tooling it needs in the testbed, read-only on the repo), A/Bs it against BAR.md, checks CANON, and writes critique-<aspect>-wN.md naming the ONE largest gap with its evidence. Reads SETTLED.md so it never re-opens a closed call, never a prior critique. Returns behind | achieved | saturated.' },
    { title: 'Improve', detail: 'Refine only. Closes exactly the ONE gap its critique file names - or, in a wave gate round, exactly what the code review flagged - to the quality frame and inside CANON, runs the gates to green, leaves everything UNSTAGED. Settles its own trade-offs and records each as a SETTLED.md line; declining the gap is a legitimate outcome, but only as a settled, written call.' },
  ],
};

// =============================================================================
// Config — everything product-specific arrives via args so the engine stays general.
// The run documents (CANON.md, BAR.md, COMPONENTS.md) are authored OUTSIDE this engine, by the main agent
// with the user, and are read VERBATIM from their own files by the agents that need them (never
// parsed-and-rebuilt — WORKFLOW-PRINCIPLES.md #2, #11). The BLIND code gate is given none of those paths
// (#3): its whole world is the unstaged diff plus the settled ledgers. The ONLY things that travel as
// control are the ordered `components` list of thin {id, gate} knobs and the round number (#1/#8).
// The main agent ensures a clean unstaged working tree before the run and derives `components` with
// `plan-block.mjs --list --kind component` (#4) — there is no baseline/loader/scribe agent here, and the
// engine never shells out (the harness has no tools).
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
  throw new Error('args must include at least { runId, root, target:{repo}, canonPath, componentsPath, components:[{id,gate}], gates:{build} }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally the workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// `target.repo` is REQUIRED and has NO default. A fallback to `.` resolves against ROOT, i.e. the
// WORKFLOW TOOL's own directory — so an omitted repo would point every `git -C`, the park procedure's
// `checkout --` + file deletion, and the gate commands at this checkout instead of failing loud.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the TARGET git repo. There is no default — an omitted repo would silently run every git command (including park\'s checkout/delete) against this workflow tool\'s own directory.');
}

const PHASE       = A.phase ?? 'mvp';                       // 'mvp' (get the working alpha down) | 'refine' (climb it)
const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
const GATES       = A.gates ?? {};                          // { build, test, testSetup }
// An unknown phase must not fall through to the mvp loop: the two phases are DIFFERENT run shapes (a
// component loop vs. a wave loop over quality aspects), and silently building components for an operator
// who asked for a third thing would rebuild what is already staged. Loud, and it names the legal set.
if (PHASE !== 'mvp' && PHASE !== 'refine') {
  throw new Error(`Unknown phase "${PHASE}" — this engine runs phase:"mvp" (build each component of COMPONENTS.md to a code-sound alpha) or phase:"refine" (climb the staged product toward BAR.md, one wave of quality aspects at a time). Omit the phase arg entirely to take the mvp default.`);
}
// A non-numeric bound must THROW, never coerce. `round < 'three'` is false on the first test, so the
// per-component round loop would never run: the first component would park having never spawned a
// builder, and the run would stop there reporting that as an ordinary "could not pass" outcome. A
// documented default is not a licence to accept garbage — same reasoning as the `target.repo` guard above.
// Nothing is COERCED: `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite, so a
// coercing check waves through exactly the garbage that silently disables a bound. The upper bound is not
// decoration either — a fat-fingered `maxRounds: 100000` otherwise spawns agents until something dies.
// The message leads with a STATIC clause because tools/gen-flows.mjs labels a throw node with the first
// clause of its static prefix; starting with `args.${name}` rendered the node as "throw: args.".
// EVERY numeric arg is evaluated HERE, before the phase-specific required-path checks below, so a garbage
// bound is rejected whatever else the payload is missing (tests/static.test.mjs sweeps exactly that).
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage parks the first component without ever spawning a builder.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS = num(A.maxRounds, 'maxRounds', 1, 4, 50);                         // build→gate rounds per component
const MIN_COMPONENT_BUDGET = num(A.minComponentBudget, 'minComponentBudget', 0, 150_000); // token floor to start another component
// refine-phase bounds. Their VALUES are validated here, in the one pre-phase block, so a garbage bound is
// rejected whatever phase the payload names; their PRESENCE is checked with the other refine-only inputs
// below. `cycles` — the wave budget, and the user's whole brake on a climb that would otherwise never end
// — deliberately has NO default: `null` means "absent", which the refine phase turns into a throw rather
// than into a number nobody chose. Nothing else in this engine may read it as a count.
const CYCLES = num(A.cycles, 'cycles', 1, null, 10_000);                            // waves to run THIS invocation
const START_WAVE = num(A.startWave, 'startWave', 1, 1, 10_000);                     // resume: the wave number to start at
const MAX_GATE_ROUNDS = num(A.maxGateRounds, 'maxGateRounds', 1, 3, 10);            // code-gate→improve rounds per wave
const MIN_WAVE_BUDGET = num(A.minWaveBudget, 'minWaveBudget', 0, 200_000);          // token floor to start another wave

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every role
// runs as the harness's standard workflow subagent (always available). Only set an agentType that exists
// in YOUR registry. Every role is opus: the builder and improver are building to a flagship bar, the blind
// gate is the only code reviewer this workflow has, and the critic is the only thing that can tell the
// product from the exemplar — measured on the sibling engines (2026-08-01, wt-tooling), the fast tier
// surfaced ONE deep-verified defect per round on a large diff and burned the round budget.
// Park runs on the build tier: it is careful git work, not review.
const M  = { build: 'opus', codeGate: 'opus', critic: 'opus', improve: 'opus', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

// ROOT is the ABSOLUTE base that run-state hangs off (supplied by the main agent — see the required check
// above), so every agent + `git -C` call is cwd-independent. Run-state lands in `<ROOT>/runs/<runId>`
// unless args.stateDir overrides it.
const ROOT      = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm      = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs       = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
const slug      = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const REPO      = abs(TARGET.repo);                        // absolute path to the target git repo (required)
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);     // <root>/runs/<runId> unless overridden
// Blind-gate placement guard (#3): run-state must live OUTSIDE the target repo so the code gate cannot
// reach the review/ledger files through the repo tree. Warn loudly if root was set wrong.
if (REPO && (STATE_DIR === REPO || STATE_DIR.startsWith(REPO + '/'))) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind code gate could see the review/ledger files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}

// ---- Inputs a phase cannot run without (checked AFTER every numeric bound, above) --------------------
// CANON is the spec every builder, critic and improver judges inside, so it is required in BOTH phases: a
// missing canon would have them invent the product's rules per round. The rest are per phase — mvp needs
// the COMPONENTS.md blocks each builder is handed, refine needs the ASPECTS.md sections each critic
// observes by and the BAR.md it A/Bs against — and none has a default.
if (typeof A.canonPath !== 'string' || !A.canonPath.trim()) {
  throw new Error('args.canonPath is required: the ABSOLUTE path to CANON.md (the goal paragraph plus the hard rules — theme, tech, the don\'ts). It is what every builder judges inside; without it the product\'s rules would be invented per round. Keep it OUTSIDE the target repo — the blind code gate must have no route to it.');
}
if (PHASE === 'mvp' && (typeof A.componentsPath !== 'string' || !A.componentsPath.trim())) {
  throw new Error('args.componentsPath is required for phase:"mvp": the ABSOLUTE path to COMPONENTS.md, whose "## Component: <id>" blocks are what each builder is handed (verbatim, via the plan-block command). Keep it OUTSIDE the target repo.');
}
if (PHASE === 'refine' && (typeof A.aspectsPath !== 'string' || !A.aspectsPath.trim())) {
  throw new Error('args.aspectsPath is required for phase:"refine": the ABSOLUTE path to ASPECTS.md, whose "## Aspect: <id>" sections tell each critic WHAT to observe and HOW. Without it a critic would invent both the dimension and the method, and two waves would not be measuring the same thing. Keep it OUTSIDE the target repo.');
}
// BAR is optional in mvp (the alpha is judged against its component specs) and REQUIRED in refine, which
// is nothing but a climb TOWARD it: without an exemplar to A/B against, every critic substitutes its own
// taste, "achieved" means whatever that critic thought, and the waves converge on nothing.
if (PHASE === 'refine' && (typeof A.barPath !== 'string' || !A.barPath.trim())) {
  throw new Error('args.barPath is required for phase:"refine": the ABSOLUTE path to BAR.md (the exemplar this product is measured against, and what each pointer witnesses). Refine IS the climb toward that bar — without it each critic invents its own standard and no wave can be compared to the last. Keep it OUTSIDE the target repo.');
}
const CANON_PATH      = abs(A.canonPath);
const BAR_PATH        = A.barPath ? abs(A.barPath) : '';    // the exemplar + what each pointer witnesses
const COMPONENTS_PATH = A.componentsPath ? abs(A.componentsPath) : '';
const ASPECTS_PATH    = A.aspectsPath ? abs(A.aspectsPath) : '';
// The canon/bar/components/aspects files have the same exposure as run-state, one door over (#3): inside
// the target repo the blind code gate could read the product's whole spec straight out of the repo tree,
// and the diff/park machinery could sweep them. WARN rather than throw, matching the run-state guard's
// precedent — a mid-flight throw strands a run the operator may still want, and the loud line names the fix.
for (const p of [CANON_PATH, BAR_PATH, COMPONENTS_PATH, ASPECTS_PATH]) {
  if (p && REPO && (p === REPO || p.startsWith(REPO + '/'))) {
    log(`⚠ run document (${p}) resolves inside the target repo — the blind code gate could read the goal straight out of the repo tree, and the diff/park machinery could sweep it. Move it under ${ROOT}/plans/ (any path outside ${REPO}) and pass THAT absolute path.`);
  }
}
// Where the block tool lives. The default hangs it off ROOT because a checkout keeps engine, tools and
// run-state under one folder — but an INSTALLED plugin splits them: run-state (ROOT) goes to the
// persistent plugin data dir while tools/ ships in the versioned plugin cache. args.blockTool carries the
// installed tool's absolute path in that case; without it every builder is handed a command that exits
// non-zero and the run halts on spec_obtained=false.
const BLOCK_TOOL = A.blockTool ? abs(A.blockTool) : `${ROOT}/tools/plan-block.mjs`;
const specRef = (id) => `the output of:  node '${BLOCK_TOOL}' '${COMPONENTS_PATH}' '${id}' --kind component
Run it and build EXACTLY what it prints — that is your component spec, verbatim. If it exits non-zero,
report spec_obtained=false and STOP: never build from a spec you could not read. The whole component list
is at ${COMPONENTS_PATH} if you need a neighbour for context; build ONLY "${id}".`;

// =============================================================================
// Components — the ordered decomposition the main agent supplies (array order = build order). Each entry
// is a THIN control object { id, gate } (routing knobs, NOT content — the component body lives in
// COMPONENTS.md and is read verbatim). The main agent derives the array pre-run with
// `node tools/plan-block.mjs <componentsPath> --list --kind component`; the engine never runs the tool.
// runOnly / startAt scope a cheaper partial slice by id without editing the file.
// =============================================================================
const VALID_GATES = new Set(['green', 'build-only']);
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALL_COMPONENTS = (Array.isArray(A.components) ? A.components : [])
  .map((c) => (typeof c === 'string' ? { id: c } : c))
  .filter((c) => c && c.id)
  .map((c) => ({ id: String(c.id), gate: VALID_GATES.has(c.gate) ? c.gate : 'green' }));
// mvp-only, so a refine run needs no COMPONENTS.md and no components array at all — refine is also an
// ENTRY POINT, pointed at a product this run never built.
if (PHASE === 'mvp') {
  if (!ALL_COMPONENTS.length) {
    throw new Error('args.components is required for phase:"mvp": the ORDERED array [{ id, gate }] of components to build, derived pre-run with `node tools/plan-block.mjs <componentsPath> --list --kind component`. The engine cannot derive it itself (the harness has no tools), and an empty list is a run that builds nothing while reporting success.');
  }
  // An id routes review/ledger file names AND is interpolated into the block command an agent runs, so
  // anything but a kebab slug is either a file-name collision (two ids that `slug()` folds together silently
  // share one DISMISSED file) or a shell metacharacter. The plan-block tool enforces this on the file's
  // headers; the engine must enforce the same rule on the control array.
  const BAD_IDS = ALL_COMPONENTS.filter((c) => !KEBAB_ID.test(c.id)).map((c) => c.id);
  if (BAD_IDS.length) {
    throw new Error(`component id(s) [${BAD_IDS.join(', ')}] are not kebab slugs (a-z, 0-9, single hyphens). An id names this component's review + ledger files and is passed to the plan-block command, so it must carry no spaces, punctuation or shell characters.`);
  }
  const DUP_IDS = [...new Set(ALL_COMPONENTS.map((c) => c.id).filter((id, i, all) => all.indexOf(id) !== i))];
  if (DUP_IDS.length) {
    throw new Error(`duplicate component id(s) [${DUP_IDS.join(', ')}] in args.components — two components would share one DISMISSED-<id>.md and one code-review-<id>-rN.md, so the second silently overwrites the first's review and the gate reads the wrong ledger.`);
  }
}

// =============================================================================
// Aspects — the quality dimensions a refine wave climbs, in the order the main agent supplies. Thin
// control objects { id } only (the WHAT and the HOW live in ASPECTS.md and are read verbatim, #2/#11).
// Same shape and the same three failure modes as the components array above, and it is checked ONLY under
// phase:"refine" so no mvp payload has to carry it.
// =============================================================================
const ALL_ASPECTS = (Array.isArray(A.aspects) ? A.aspects : [])
  .map((a) => (typeof a === 'string' ? { id: a } : a))
  .filter((a) => a && a.id)
  .map((a) => ({ id: String(a.id) }));
if (PHASE === 'refine') {
  if (!ALL_ASPECTS.length) {
    throw new Error('args.aspects is required for phase:"refine": the ORDERED array [{ id }] of quality aspects to climb, one per "## Aspect: <id>" section of ASPECTS.md. The engine cannot derive it itself (the harness has no tools), and an empty list is a run that critiques nothing while reporting every aspect closed.');
  }
  const BAD_ASPECTS = ALL_ASPECTS.filter((a) => !KEBAB_ID.test(a.id)).map((a) => a.id);
  if (BAD_ASPECTS.length) {
    throw new Error(`aspect id(s) [${BAD_ASPECTS.join(', ')}] are not kebab slugs (a-z, 0-9, single hyphens). An id names this aspect's critique files, so it must carry no spaces, punctuation or shell characters.`);
  }
  const DUP_ASPECTS = [...new Set(ALL_ASPECTS.map((a) => a.id).filter((id, i, all) => all.indexOf(id) !== i))];
  if (DUP_ASPECTS.length) {
    throw new Error(`duplicate aspect id(s) [${DUP_ASPECTS.join(', ')}] in args.aspects — two aspects would share one critique-<id>-wN.md, so the second silently overwrites the first's critique and its improver reads the wrong gap.`);
  }
  // The wave budget is the user's brake and the only reason a climb terminates at all, so it is REQUIRED
  // and has no default: a number the engine picked would be a run length nobody chose to pay for.
  if (CYCLES === null) {
    throw new Error('args.cycles is required for phase:"refine": how many WAVES to run this invocation (1..10000). It is your brake — a climb toward a bar has no natural end, so there is no default. Every wave leaves the tree staged and clean, so a small budget costs nothing: re-invoke with startWave set to the next wave to buy more.');
  }
}
// The gate commands are what "it works" MEANS here, and gateOk() only enforces the build when GATES.build
// is set — so an omitted command turns the build gate into a no-op and a build-only component passes with
// nothing ever compiled. Required, and required to fail loud.
if (typeof A.gates?.build !== 'string' || !A.gates.build.trim()) {
  throw new Error('args.gates.build is required: the shell command that defines a GREEN build (non-zero exit = fail). Without it the build gate silently no-ops and a component — or a whole wave of improvements — can pass with nothing compiled.');
}
if (ALL_COMPONENTS.some((c) => c.gate === 'green') && (typeof A.gates?.test !== 'string' || !A.gates.test.trim())) {
  throw new Error('args.gates.test is required when any component has gate:"green": the shell command that runs the verification (non-zero exit = fail). A component that legitimately has none takes gate:"build-only" instead.');
}

// The blind gate's OWN directory, and the whole of what it is handed (#3). Blindness is a property of
// PLACEMENT, not of a polite instruction: STATE_DIR holds `critique-<aspect>-wN.md` — which IS the wave's
// spec, the named gap and what "closed" looks like, i.e. exactly what the diff under review was built to do
// — and SETTLED.md, the design calls and their reasons. Disclosing STATE_DIR to the gate (as its output
// path and its "create the dir if needed") put both one `ls` away from this workflow's ONLY code reviewer.
// So the two files the gate legitimately needs move down here, and no path outside this directory is ever
// interpolated into its prompt.
const GATE_DIR       = `${STATE_DIR}/gate`;                 // everything the BLIND code gate reads or writes
const codeReviewFile = (id, r) => `${GATE_DIR}/code-review-${slug(id)}-r${r}.md`;   // blind gate → builder/improver
const critiqueFile   = (id, w) => `${STATE_DIR}/critique-${slug(id)}-w${w}.md`;      // critic → improver (refine)
const NEEDS_USER     = `${STATE_DIR}/NEEDS-USER.md`;        // park records + ENVIRONMENT faults ONLY
const SETTLED        = `${STATE_DIR}/SETTLED.md`;           // every settled judgment call (cumulative; the critics' saturation detector)
const dismissedFile  = (id) => `${GATE_DIR}/DISMISSED-${slug(id)}.md`;   // terse ledger; builder → gate (anti-spin)
const parkedPatch    = (id) => `${STATE_DIR}/parked-${slug(id)}.patch`;   // a unit's work, saved before the tree is cleared
const parkedNewDir   = (id) => `${STATE_DIR}/parked-${slug(id)}-newfiles`; // untracked files the patch could not carry (rare)
// A refine WAVE is the code gate's unit the way a component is in mvp: one diff, one review file, one
// DISMISSED ledger, one patch if it has to park. Same shape as a component entry so the gate and park
// prompts take it unchanged.
const waveUnit       = (w) => ({ id: `wave-${w}` });
const TESTBED        = `${STATE_DIR}/testbed`;              // scratch verification tooling, OUTSIDE every diff

// Gate check (additive build; no intentionally-red phase). 'green' => build passes AND the required
// verification passes AND the existing suite is not reddened. 'build-only' => build passes. When a
// component legitimately has NO verification, its block carries gate:'build-only'. Per component.
function gateOk(gate, dev) {
  if (!dev) return false;
  if (GATES.build && dev.build_passed !== true) return false;   // build/lint must always pass
  if (gate === 'build-only') return true;
  if (dev.full_suite_outcome === 'failed') return false;        // reddening the suite is a regression
  if (dev.test_outcome === 'not-run') return false;             // green requires verification to have run
  if (dev.tests_run_count === 0) return false;                  // selector matched nothing = FALSE green
  return dev.test_outcome === 'passed';
}
// Refine has no per-unit gate declaration — an aspect is a quality dimension, not a unit of code, so
// nothing in ASPECTS.md could carry one. The presence of a test command IS the declaration: with one, every
// improver must leave the suite green; without one there is nothing to run and the build gate is the whole
// bar. Logged at the top of the phase so an operator can never mistake the second case for the first.
const REFINE_GATE = GATES.test ? 'green' : 'build-only';

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
const BUILD_SCHEMA = {
  type: 'object',
  required: ['spec_obtained', 'baseline_dirty_files', 'build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'env_blocked', 'settled_appended'],
  properties: {
    spec_obtained:     { type: 'boolean', description: 'true if you actually HAVE your component spec — the plan-block command exited 0 and printed it. A command that failed means FALSE — never fall back to locating your block by eye in the components file. FALSE halts the run: never build from a spec you could not read.' },
    baseline_dirty_files:{ type: 'integer', description: 'ROUND 1 ONLY: how many DISTINCT files already had UNSTAGED or untracked changes BEFORE you touched anything (staged files are the accepted baseline — never counted). 0 = clean; >0 HALTS the run. Report -1 on later rounds (the check does not apply).' },
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed', 'not-run'], description: 'passed = the required verification ran and PASSED; failed = ran and failed; not-run = no verification executed' },
    tests_run_count:   { type: 'integer', description: 'unit/integration tests the runner ACTUALLY executed (0 = selector matched nothing = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    full_suite_outcome:{ type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q", "curl localhost:3000/health"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add NOT run on content; git add -N only, for new files). The code gate is the only agent that stages.' },
    env_blocked:       { type: 'boolean', description: 'true ONLY for an ENVIRONMENT fault — a tool, permission, credential or network you genuinely cannot obtain — which you wrote up in NEEDS-USER.md. It is the ONLY thing that escalates here; a design or scope question is yours to settle.' },
    settled_appended:  { type: 'integer', description: 'how many judgment calls you settled yourself and appended as one terse line each to SETTLED.md this round (0 if none). Required, so "none" is stated rather than omitted.' },
    dismissed_count:   { type: 'integer', description: 'how many code-gate findings you declined and logged to this component\'s DISMISSED file this round (0 if none)' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
};

// The code gate is the STAGING agent in gauntlet (there is no second, spec-aware reviewer): staged=true is
// legal ONLY on a clean pass, and `wrote_file` is what makes the review file's absence visible — the next
// builder is handed that path, so an unconfirmed write must not become a path to a file nobody wrote.
const CODE_GATE_SCHEMA = {
  type: 'object',
  required: ['clean', 'issue_count', 'staged', 'wrote_file'],
  properties: {
    clean:       { type: 'boolean', description: 'true if NO production-blocking defects and NO structural debt were found in the unstaged diff' },
    issue_count: { type: 'integer', description: 'number of findings written to the review file' },
    staged:      { type: 'boolean', description: 'true if you ran `git add` on this component\'s changed AND newly-created files — ONLY on a clean pass, and NEVER a commit' },
    wrote_file:  { type: 'boolean', description: 'true if you actually wrote your review file at the path given. The next builder is handed that path, so an unwritten file must be reported, never assumed.' },
    contested_dismissals: { type: 'integer', description: 'how many DISMISSED entries you re-raised as "CONTESTS DISMISSAL:" this round because the stated reason is wrong for a genuine production-blocking defect (0 if none)' },
  },
};

// The refine critic. `status` is the whole control plane of a wave: `behind` buys an improver, `achieved`
// and `saturated` CLOSE the aspect. Which is why nothing may be inferred from a missing or unknown value —
// a critic that came back malformed must not read as "achieved" any more than a dead one does (#15), so
// the harness treats anything outside the enum as `behind` and says so.
// `baseline_dirty_files` is REQUIRED for the same reason, and it is the load-bearing case: it is the run's
// only clean-tree guard (consumed below on the FIRST critic), and an OMITTED value takes the log-and-warn
// branch — i.e. a critic that simply left the field out would downgrade a HALT to a warning line and let
// the wave gate stage the operator's pre-existing work. Required here matches BUILD_SCHEMA above and the
// same attestation in feature-cycle and migrate-cycle; non-first critics report -1, which IS an answer.
const CRITIC_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'status', 'gap_actionable', 'canon_violation', 'additive', 'baseline_dirty_files', 'env_blocked'],
  properties: {
    wrote_file:      { type: 'boolean', description: 'true if you actually wrote your critique file at the path given. The improver is handed that path, so an unwritten file must be reported, never assumed.' },
    status:          { type: 'string', enum: ['behind', 'achieved', 'saturated'], description: 'behind = a real gap remains and you named it; achieved = this aspect would be mistaken for the exemplar\'s tier; saturated = every gap you can still see is already covered by a SETTLED.md line (say which). achieved and saturated both CLOSE this aspect for the rest of the run — do not use them to mean "good enough for now".' },
    gap_actionable:  { type: 'boolean', description: 'true if the gap you named is concrete enough to implement AS WRITTEN — the file/screen/behaviour it lives in, and what "closed" looks like. Only meaningful with status:"behind".' },
    canon_violation: { type: 'boolean', description: 'true if what you observed BREAKS a CANON rule. A canon violation is never "achieved": it is the largest gap by definition.' },
    additive:        { type: 'boolean', description: 'true if the gap you named is an ADDITIVE FEATURE (something the product does not have at all) rather than a shortfall in what exists. Allowed ONLY with the UX big win stated and evidenced in the critique file, plus its CANON fit.' },
    contested_settled: { type: 'integer', description: 'how many SETTLED.md lines you re-raised as "CONTESTS SETTLED:" because the recorded reason does not hold against what you observed (0 if none). Once per line, ever — the improver answers it and the re-settlement is final.' },
    baseline_dirty_files: { type: 'integer', description: 'FIRST CRITIC OF THE RUN ONLY: how many DISTINCT files already had UNSTAGED or untracked changes BEFORE anything ran (staged files are the accepted baseline — never counted). 0 = clean; >0 HALTS the run. Report -1 when you were not asked for it.' },
    env_blocked:     { type: 'boolean', description: 'true ONLY for an ENVIRONMENT fault — a tool, permission, credential or network you genuinely cannot obtain — which you wrote up in NEEDS-USER.md. It is the ONLY thing that escalates here.' },
  },
};

// The refine improver — the builder's schema minus the two things only a component build has (its own spec
// block, and the round-1 baseline check the critic now owns), plus what a gap-closing round decides:
// whether the gap was actually closed, and whether it was deliberately DECLINED (which is legitimate, but
// only as a written SETTLED line — the count is what proves the line exists).
const IMPROVE_SCHEMA = {
  type: 'object',
  required: ['build_passed', 'test_outcome', 'tests_run_count', 'full_suite_outcome', 'unstaged_confirmed', 'env_blocked', 'settled_appended', 'gap_addressed', 'declined'],
  properties: {
    build_passed:      { type: 'boolean' },
    test_outcome:      { type: 'string', enum: ['passed', 'failed', 'not-run'], description: 'passed = the required verification ran and PASSED; failed = ran and failed; not-run = no verification executed' },
    tests_run_count:   { type: 'integer', description: 'unit/integration tests the runner ACTUALLY executed (0 = selector matched nothing = a FALSE green; -1 = N/A, e.g. manual/MCP verification)' },
    full_suite_outcome:{ type: 'string', enum: ['passed', 'failed', 'not-run', 'scoped-skip'], description: 'result of running the FULL test gate to confirm the EXISTING suite is not reddened' },
    verification_method:{ type: 'string', description: 'what was actually run to verify (e.g. "pytest -q", "curl localhost:3000/health"); note here if a configured MCP/tool was UNAVAILABLE in this environment' },
    unstaged_confirmed:{ type: 'boolean', description: 'true if all changes were left UNSTAGED (git add NOT run on content; git add -N only, for new files). The code gate is the only agent that stages.' },
    env_blocked:       { type: 'boolean', description: 'true ONLY for an ENVIRONMENT fault — a tool, permission, credential or network you genuinely cannot obtain — which you wrote up in NEEDS-USER.md. It is the ONLY thing that escalates here; a design or scope question is yours to settle.' },
    settled_appended:  { type: 'integer', description: 'how many judgment calls you settled yourself and appended as one terse line each to SETTLED.md this round (0 if none). Required, so "none" is stated rather than omitted.' },
    gap_addressed:     { type: 'boolean', description: 'true if you implemented what you were handed — the ONE gap in your critique file, or every finding in the code review. Neither this nor declined true means the round produced nothing.' },
    declined:          { type: 'boolean', description: 'true ONLY if you deliberately DECLINED the gap after running your matrix (scope cost outweighs the win, inside CANON). You must then have appended the reasoning to SETTLED.md, or the next wave\'s critic raises it again from scratch.' },
    dismissed_count:   { type: 'integer', description: 'how many code-gate findings you declined and logged to this wave\'s DISMISSED file this round (0 if none)' },
    gate_output:       { type: 'string', description: 'tail of failing gate/verification output, or "" if green' },
  },
};

// PARK — the terminal outcome for a component that did not pass, and for one the run halted mid-build.
// Its work is SAVED to a patch and then CLEARED from the tree, so every exit leaves a clean, buildable
// repo (which is what makes the round-1 clean-baseline precondition correct on a resume). Nothing is
// discarded. Unlike feature-cycle the run then STOPS: components are an ordered decomposition of ONE
// product, so component N+1 routinely builds on N having landed (migrate-cycle's asymmetry).
const PARK_SCHEMA = {
  type: 'object',
  required: ['saved', 'cleared', 'gates_green'],
  properties: {
    saved:       { type: 'boolean', description: 'true ONLY if the patch file was written and you confirmed it is non-empty. If false, you must NOT have cleared the tree.' },
    cleared:     { type: 'boolean', description: 'true if the component\'s work was then removed from the working tree and `git diff` is empty' },
    gates_green: { type: 'boolean', description: 'true if the BUILD gate passes again after clearing (the tree is safe to resume into)' },
    patch_bytes: { type: 'integer', description: 'size of the written patch file — 0 means nothing was saved' },
    strays_saved:{ type: 'integer', description: 'how many untracked files you copied to the -newfiles dir in step 2 (0 if none). Non-zero means the restore needs a SECOND step beyond git apply, and step 4 must say so.' },
    notes:       { type: 'string' },
  },
};

// =============================================================================
// Shared prompt fragments — the quality frame both roles judge against, and the builder's decision matrix
// =============================================================================
const ENV = `TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
GATES (the commands that define "it works"):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
CONVENTIONS: ${CONVENTIONS}`;

// The STANDARD, stated once and interpolated into both roles' prompts so builder and gate are measured
// against the same bar (#11 — one canonical statement, not two drifting ones).
const QUALITY_FRAME = `QUALITY FRAME — the standard every judgment here is made against:
This is FLAGSHIP, MISSION-CRITICAL, ENTERPRISE-GRADE work — AAA, not "it runs".
  • Correct at the EDGES, not just on the happy path: empty, huge, malformed, concurrent, denied, offline.
  • Every failure mode handled explicitly and reported clearly — no silent catch, no swallowed error.
  • Structurally sound: one responsibility per unit; inputs collected, then processed, then output; no dead
    code, no duplicated logic, nothing left half-wired.
  • Finished, not sketched: what lands is what a paying customer would use unaided.
Anything that would embarrass this product beside the exemplar it is measured against is a DEFECT here,
not a nit — and anything below this bar is worth another round.`;

// The builder owns EVERY call (#7). The one escalation is an environment fault: there is no user in the
// loop to answer a design question mid-run, and a workflow that stops for one converges on nothing.
const MATRIX = (id) => `DECISION MATRIX — route every ambiguity and every code-gate finding YOURSELF, in order
(first match wins). NOTHING reaches the user except case 9:
  1. Not a real problem / false positive .............. DROP — log it (see LOGGING).
  2. Pre-existing in untouched code (not yours) ....... DROP silently (out of scope; regression risk).
  3. Stops the build/tests/verification ............... FIX (always).
  4. A real, clear, in-scope fix (local, small) ....... FIX.
  5. Below the QUALITY FRAME, inside CANON ............ FIX (a component that only works on the happy path
     is not done, and neither is one the exemplar would embarrass).
  6. Conflicts with the brief you were handed (your component block, or your critique file) AND you
     VERIFIED that what it prescribes is itself defective — you reproduced it, or demonstrated the failure
     path ... FIX it: the verified defect outranks the prescription. Record ONE SETTLED line saying which
     clause you overrode and what you built instead. Did NOT verify it? That is case 8.
  7. A genuine open CHOICE (design, trade-off, scope, ordering) ... DECIDE IT YOURSELF and move on:
     • list the live options, then the criteria and their WEIGHTS *before* scoring anything, with "meets
       the QUALITY FRAME within CANON" the top-weighted criterion;
     • where the outcome turns on two uncertain factors, lay them out as a probability matrix so no
       outcome is left unenumerated;
     • where one error costs more than the other (shipping the wrong thing vs. building extra), name BOTH
       costs and bias toward the cheaper mistake.
     Record the call as ONE terse SETTLED line so no later round re-opens it.
  8. Anything else (style, medium/low polish, a different component or aspect) ... DROP silently.
  9. ENVIRONMENT FAULT — a tool, permission, credential or network the work genuinely cannot proceed
     without and that you cannot obtain ... THE ONLY ESCALATION: append a full, self-contained entry to
     ${NEEDS_USER} and return env_blocked=true. The run HALTS. Never use it for a call you could make.
  • A finding the code gate RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or settle it
    with a SETTLED line that answers the contest. NEVER log the same dismissal twice.

LOGGING — these three files plus your code are your ONLY output. Keep every line terse:
  • ${dismissedFile(id)} — one line per declined code-gate finding, so the gate does not re-raise it:
      \`<file:line> — <finding gist> — SKIPPED: <reason, ≤15 words>\`
  • ${SETTLED} — one line per call you settled (cases 6 and 7), so later rounds and later components
    inherit the decision instead of re-litigating it:
      \`<area> — <the call you made> — WHY: <≤20 words>\`   (report the count as settled_appended)
  • ${NEEDS_USER} — ENVIRONMENT faults only (case 9).`;

// =============================================================================
// Role prompts — succinct; each agent gets its own document links and nothing else (#11/#13).
// =============================================================================
// `treeRed` is the THIRD non-round-1 shape, and it is why an empty `reviewPath` is not enough to describe
// the round: the gates being red and the gate flagging a diff whose review file it never wrote are two
// different briefs, and telling a builder the gates were red when they are green spends the round re-running
// a gate that has nothing new to say. Same three-way split as gateFixPrompt below (#11).
const buildPrompt = (c, round, reviewPath, treeRed) => `
You are the BUILDER. Build component "${c.id}" (round ${round}) from ${specRef(c.id)}
CANON — the goal and the hard rules every judgment is made INSIDE: ${CANON_PATH} (read it verbatim).
${BAR_PATH ? `BAR — the exemplar this product is measured against, and what each pointer witnesses: ${BAR_PATH} (read it verbatim).\n` : ''}${ENV}

${QUALITY_FRAME}
${round === 1
  ? `ROUND 1 — STEP 0, BEFORE you read anything else or touch any file: CONFIRM THE BASELINE IS CLEAN.
Earlier accepted components are STAGED (the accepted baseline); the UNSTAGED tree must be EMPTY, because
everything unstaged at the end of this round is reviewed and judged as YOUR work.
  \`git -C ${REPO} diff --name-only\`                        — unstaged tracked edits
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` — untracked files (\`git diff\` OMITS these)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (entries that are ONLY
staged are the accepted baseline — do NOT count them). If it is NOT 0, STOP RIGHT THERE: change nothing,
write nothing, do no work, and return immediately with that count — the run halts so the operator can fold
or stash that work. If it IS 0, build this component on top of the staged baseline.`
  : treeRed
    ? `A prior round's build/verification was not green. Your earlier work is in the UNSTAGED working tree —
re-run the gate (below), see what is failing, and fix it. Build ON your work; do NOT revert it.`
    : reviewPath
      ? `The code gate flagged this component — READ ${reviewPath} and resolve exactly those findings. Your
earlier work is already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`
      : `The code gate flagged this component's diff but did NOT confirm writing its review file, so there is
nothing to read — and THE GATES ARE GREEN, so re-running them tells you nothing new. Re-check your own
unstaged diff against the QUALITY FRAME yourself and fix what you find. Build ON your work; do NOT revert it.`}
${round === 1 ? '' : `Report baseline_dirty_files=-1 (the round-1 clean-baseline check does not apply from round 2 on — the
unstaged tree now holds YOUR work).
READ ${dismissedFile(c.id)} and ${SETTLED} first if they exist — they are YOUR running ledgers: do not
duplicate an entry, and do not re-open a settled call. If the review RE-RAISES a dismissal as
\`CONTESTS DISMISSAL:\`, you MUST fix it or settle it explicitly (never silently re-add the same line).`}

PROCEDURE:
1. Build the component's spec to the QUALITY FRAME, inside CANON. WIRE IT IN so it is actually reachable
   (registered/exported/routed/bound/mounted) — written-but-unreachable is NOT done. Author/extend tests
   per the spec's test strategy.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}
2. RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: per the component's
   spec (${GATES.test ?? 'no test gate configured'}). Also run the FULL suite to confirm you did not redden
   it (report full_suite_outcome). Never weaken/delete a test to get green. SANITY-CHECK that the runner
   really executed your tests (tests_run_count = 0 means it matched NOTHING = a false green; -1 if N/A).
3. LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit; the code gate stages, and only
   on a clean pass. EXCEPTION: for any file you CREATE, run \`git -C ${REPO} add -N <file>\` (intent-to-add,
   so the gate's \`git diff\` sees it; it does not stage content). Set unstaged_confirmed=true.
   You may write freely under ${TESTBED}/ — scratch harnesses, fixtures, captures, anything that helps you
   VERIFY. It lives outside the repo, so nothing there enters the diff the code gate reviews.
4. ${MATRIX(c.id)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

// BLIND by placement (#3): no canon, no bar, no component spec, no goal — this prompt carries no path to
// any of them, so the gate judges the code as code. It is also the STAGING agent, on a clean pass only.
const codeGatePrompt = (c, round) => `
You are the CODE GATE. You have NO information about what this code is for, what it should do, or any
spec, plan or goal — and you must not seek any. Judge the code PURELY ON ITS OWN MERITS.
TARGET REPO: ${REPO}

${QUALITY_FRAME}

Before reviewing, READ this if it exists — it is the settled decisions, so you do NOT re-raise what is
already closed:
  • ${dismissedFile(c.id)} — findings the builder declined for THIS unit, each with a one-line reason.
Skip anything listed there FOR THE STATED REASON. Do NOT read prior review files — review the CURRENT diff
FRESH (so you also catch new or similar nearby issues, and independently re-verify earlier fixes). If you
are confident a DISMISSED reason is WRONG and the issue genuinely blocks production, raise it ONCE,
prefixed "CONTESTS DISMISSAL:", explaining why the reason does not hold.

SCOPE — review ONLY this cycle's UNSTAGED work:
  \`git -C ${REPO} diff\`                    (unstaged tracked changes — review this)
  \`git -C ${REPO} status --porcelain\` then READ every NEW/untracked file (\`??\`/\`A\`) — \`git diff\` OMITS new files.
  \`git -C ${REPO} diff --staged\` is the ACCEPTED baseline — context only, do NOT review it.

Report TWO classes, both to the QUALITY FRAME, both introduced by this diff:
  • DEFECTS — correctness, security, data-integrity, error-handling, resource, concurrency, api-contract
    bugs, unhandled edges, anything that breaks the build or tests.
  • STRUCTURAL DEBT — mixed responsibilities in one unit, collection/processing/output tangled together
    (IPO violations), dead or unreachable code, duplicated logic, a half-wired integration.
DROP silently: anything pre-existing in the baseline, naming, formatting, speculation, redesigns. An EMPTY
result is a normal, GOOD outcome.

WRITE your findings to ${codeReviewFile(c.id, round)} (create ${GATE_DIR}/ if needed): one section per
finding — file:line, what is wrong, why it is blocking at this bar, a concrete fix. If none, write exactly
"No blocking defects or structural debt found." Return wrote_file=true only if that file is really written.

THEN, and only if you found NOTHING: you are this workflow's STAGING agent —
\`git -C ${REPO} add <every changed AND newly-created file in this diff>\` (NEVER commit) and return
staged=true. If you found ANYTHING, stage NOTHING and return staged=false.
Return clean + issue_count + staged + wrote_file + contested_dismissals via the schema. Do NOT modify source.`;

// `noun` is 'component' (mvp) or 'wave' (refine) — the same park procedure serves both, because both are
// "one unit's unaccepted work, saved then cleared". Only the RESUME options differ, so they arrive as text
// rather than being guessed from the noun: a wave resumes with startWave, a component with startAt, and a
// park record that names the wrong one sends the operator to a throw days later.
const parkPrompt = (c, lastReviewPath, interrupted, noun, resumeOptions) => `
You are PARKING ${noun} "${c.id}", which ${interrupted
    ? `the run HALTED mid-flight. Its work is NOT left lying in the working tree`
    : `did NOT pass the code gate within its round budget. Its work is NOT thrown away`}: you SAVE it to a
patch file, then clear it from the working tree. The run STOPS after you either way — the ${noun}s after
this one build on it — but the repo is left clean and buildable, which is what lets the run resume later.
Everything already accepted is STAGED and must survive untouched.
${ENV}
STAGING CONTRACT:
  • staged index + HEAD  = ACCEPTED work (the baseline). Treat as known-good; do NOT touch.
  • unstaged working tree = THIS ${noun}'s unsuccessful work — the only thing you save and clear.
  • Nothing is EVER committed.

SAVE BEFORE YOU CLEAR — never the other way round. If step 1 does not produce a non-empty patch, STOP:
leave the tree exactly as it is and return saved=false, cleared=false.

PROCEDURE:
1. SAVE. \`git -C ${REPO} status --porcelain\` first. If \`git -C ${REPO} diff\` is already EMPTY there is
   nothing to park — skip to step 3 and return saved=false, patch_bytes=0, with a note saying so.
   Otherwise, BEFORE writing anything, PRESERVE ANY EARLIER PARK OF THIS SAME ${noun.toUpperCase()}: both
   documented resumes rebuild this same id (\`startAt\`/\`startWave\`), and the redirect below TRUNCATES, so a
   second park would destroy the first one's only copy — the tree is cleared in step 3, which makes that
   loss irrecoverable. If ${parkedPatch(c.id)} already exists and is NON-EMPTY, RENAME it to the next FREE
   ${STATE_DIR}/parked-${slug(c.id)}-prev<N>.patch (prev1, prev2, … — never overwrite an existing one), and
   if ${parkedNewDir(c.id)}/ also exists rename it to ${STATE_DIR}/parked-${slug(c.id)}-newfiles-prev<N>/
   with the SAME N. Note the names you used — step 4 must tell the user.
   Then write the ${noun}'s work to ${parkedPatch(c.id)} (create ${STATE_DIR}/ if needed):
     \`git -C ${REPO} diff --binary > ${parkedPatch(c.id)}\`
   \`--binary\` is REQUIRED (a plain diff records "Binary files differ" and will not re-apply). The unstaged
   diff IS exactly this ${noun}'s work, and files its agents created are in it via \`git add -N\`.
   Then CONFIRM the file exists and is non-empty, and record its size as patch_bytes.
2. CATCH STRAYS. If \`git status --porcelain\` still lists any \`??\` untracked file this ${noun} created
   (whoever wrote it missed its \`git add -N\`), COPY those files into ${parkedNewDir(c.id)}/ preserving relative
   paths — the patch CANNOT carry them. Skip build output and caches. Report the count as strays_saved: it
   matters, because step 4 must tell the user those files exist.
3. CLEAR. Restore every tracked file this ${noun} modified to the staged baseline:
   \`git -C ${REPO} checkout -- <files>\`. Then delete the files it CREATED (untracked + any \`git add -N\`
   intent-to-add entries). Be precise about WHY each is safe to delete: an intent-to-add file is carried by
   the patch from step 1; a \`??\` stray is safe ONLY because step 2 copied it to ${parkedNewDir(c.id)}/. If
   step 2 did not copy a stray, do NOT delete it. Never touch ${TESTBED}/ — it is outside the repo.
   Confirm \`git -C ${REPO} diff\` is EMPTY, then run the BUILD gate and record whether it is green.
4. RECORD. Append ONE entry to ${NEEDS_USER}, under a \`## Parked ${noun}: ${c.id}\` heading:
   - that this ${noun} is **NOT done and NOT abandoned — a status record, not a dismissal**, and that the
     ${noun}s after it were not attempted
   - one line on why it was parked (${interrupted ? 'the halt that stopped the run mid-flight' : 'what the code gate was still flagging'})
   - ${lastReviewPath ? `the diagnosis: \`${lastReviewPath}\`` : `that this ${noun} produced NO review file — the code gate never ran or never confirmed writing one; point the user at the run trail in ${STATE_DIR} instead of naming a file`}
   - the saved work: \`${parkedPatch(c.id)}\`
   - restore command, verbatim: \`git -C ${REPO} apply --3way ${parkedPatch(c.id)}\`
   - **ONLY IF step 1 renamed an earlier park**: a line naming the preserved file(s) verbatim, saying that
     the EARLIER \`## Parked ${noun}: ${c.id}\` entry above is NOT stale but its restore command now names
     the WRONG file — the work it describes is in the renamed patch, and \`${parkedPatch(c.id)}\` is THIS
     park's. Give the corrected \`git apply --3way <renamed patch>\` command for it. Omit this line entirely
     when there was no earlier park.
   - **ONLY IF step 2 actually copied stray files**: a line naming \`${parkedNewDir(c.id)}/\` as holding new
     files the patch cannot carry, listing them, and telling the user to copy them back into the repo
     (preserving relative paths) as a SECOND step after the \`git apply\`. Omit this line entirely when there
     were no strays — do not leave a dangling reference to an empty directory.
   - the user's options: ${resumeOptions}
Do NOT touch the staged baseline, do NOT commit, and do NOT modify any file outside this ${noun}'s work.
Return saved + cleared + gates_green + patch_bytes + strays_saved via the schema.`;

// ---- refine roles ------------------------------------------------------------------------------------
// The critic is the only agent in this workflow that judges the PRODUCT rather than the code, so it is the
// only one that must actually RUN the thing. It is fresh every wave and never reads an earlier critique
// (#5's fresh-but-not-amnesiac rule): the settled ledger is what stops it re-raising closed calls, while
// reading its own last message would anchor it to that one gap and blind it to what this wave introduced.
const criticPrompt = (a, w, checkBaseline) => `
You are the CRITIC for quality aspect "${a.id}" (wave ${w}). You judge the RUNNING product against the
exemplar and name ONE gap. You do NOT change it: ${REPO} is READ-ONLY to you.
ASPECT — what to observe, and how to observe it: ${ASPECTS_PATH} (read the "${a.id}" section verbatim).
CANON — the goal and the hard rules the product lives inside: ${CANON_PATH} (read it verbatim).
BAR — the exemplar this product is measured against, and what each pointer witnesses: ${BAR_PATH} (read it verbatim).
${ENV}

${QUALITY_FRAME}
PASS ONLY WHAT WOULD BE MISTAKEN FOR THE EXEMPLAR'S TIER by someone shown both and not told which is which.
"Better than last wave" is not the bar; "indistinguishable from the bar" is.

SETTLED DECISIONS — read BOTH before you judge anything, so you never re-open what is closed:
  • ${SETTLED} — every call an earlier builder or improver settled, with its reason. A gap a line here
    already covers is CLOSED, and counting how much of what you see is already in it is exactly how you
    decide whether this aspect is saturated.
  • ${NEEDS_USER} — environment faults already escalated to the user.
Do NOT read earlier critique files — yours or another aspect's. Judge the product AS IT IS NOW, so you
catch what this wave introduced as readily as what earlier waves missed.
${checkBaseline
    ? `STEP 0, BEFORE you observe anything: CONFIRM THE BASELINE IS CLEAN. You are the first agent of this run
and everything left unstaged is staged as this wave's work, so pre-existing changes would be swept into it.
  \`git -C ${REPO} diff --name-only\`                        — unstaged tracked edits
  \`git -C ${REPO} status --porcelain\`, lines starting \`??\` — untracked files (\`git diff\` OMITS these)
Report baseline_dirty_files = the count of DISTINCT files across those two lists (entries that are ONLY
staged are the accepted baseline — do NOT count them). If it is NOT 0, STOP RIGHT THERE: observe nothing,
write nothing, and return immediately with that count — the run halts so the operator can fold or stash it.`
    : `Report baseline_dirty_files=-1: you are not the first agent of this run, so the clean-tree check is
not yours — the unstaged tree now legitimately holds this wave's work.`}

PROCEDURE:
1. OBSERVE the product the way YOUR aspect section says to — run it, drive it, measure it. Build whatever
   harness, script, fixture or capture you need under ${TESTBED}/ (yours to write in, it persists across
   waves, and it is outside the repo so nothing you build there enters any diff). Read the repo freely;
   never change it.
2. A/B AGAINST THE BAR: put what you observed beside the exemplar pointer that witnesses this aspect and
   name the DIFFERENCE — what the bar does that this does not, or does worse. Evidence, not impression:
   what you ran, what you saw, the file:line or the screen (#14).
3. CANON: anything you observed that breaks a CANON rule is the largest gap by definition — set
   canon_violation=true and name it. A canon break is never "achieved", whatever else you saw.
4. NAME THE ONE LARGEST GAP: the single change that closes the most distance to the bar. ONE, not a list —
   the improver implements exactly what you name, so a list spends the wave on its smallest item.
   ADDITIVE FEATURES: you may name something the product does not have AT ALL, but ONLY if you state the UX
   BIG WIN it buys WITH the evidence for it, AND show it fits CANON. Otherwise name a shortfall in what
   already exists: this is a climb toward the bar, not a wish list. Set additive=true when you do.
5. STATUS — behind (you named a gap) · achieved (this aspect would be mistaken for the exemplar's tier;
   nothing left is worth a wave) · saturated (every gap you can still see is already covered by a ${SETTLED}
   line — name those lines in your file). achieved and saturated both CLOSE this aspect for the whole run,
   so neither means "good enough for now".
   A settled line that is WRONG against what you just observed may be CONTESTED ONCE, ever: write
   "CONTESTS SETTLED: <the line> — <why it does not hold>" in your critique file, count it in
   contested_settled, and return behind. The improver answers it and its re-settlement is final.
6. WRITE ${critiqueFile(a.id, w)} (create ${STATE_DIR}/ if needed): the gap, the evidence, the A/B against
   the bar, what "closed" looks like, and any contest. That file IS the improver's entire brief — anything
   you leave out never reaches it. Return wrote_file=true only if it is really written.
An ENVIRONMENT fault — a tool, permission, credential or network you genuinely cannot obtain — is the ONLY
thing that escalates: append a full entry to ${NEEDS_USER} and return env_blocked=true (the run HALTS).
Return wrote_file + status + gap_actionable + canon_violation + additive + contested_settled +
baseline_dirty_files + env_blocked via the schema. The critique file is the finding; the return is control.`;

const improvePrompt = (a, w, critiquePath, contested) => `
You are the IMPROVER (wave ${w}, aspect "${a.id}"). Close the ONE gap the critic named — that one, whole,
to the frame. A second improvement you can see belongs to the next wave's critic, not to this round.
THE GAP: ${critiquePath
    ? `${critiquePath} — read it VERBATIM. It is your entire brief.`
    : `the critic did NOT confirm writing its critique file, so there is no brief to read. Observe the
"${a.id}" section of ${ASPECTS_PATH} yourself, A/B against ${BAR_PATH}, and close the largest gap you can EVIDENCE.`}
CANON — the hard rules every judgment is made INSIDE: ${CANON_PATH} (read it verbatim).
BAR — the exemplar this product is measured against: ${BAR_PATH} (read it verbatim).
${ENV}

${QUALITY_FRAME}
${contested ? `THE CRITIC CONTESTED A SETTLED LINE — it is in the critique file, prefixed "CONTESTS SETTLED:".
Re-run your matrix INCLUDING its argument, then either FIX the thing or re-settle it as ONE
\`SETTLED (contested)\` line that answers the argument. That re-settlement is FINAL: no later wave re-opens it.
` : ''}READ ${SETTLED} first — it is what earlier waves decided and why. Do not re-litigate a line and do not
duplicate one.

PROCEDURE:
1. Implement THAT GAP to the QUALITY FRAME, inside CANON. WIRE IT IN so it is actually reachable
   (registered/exported/routed/bound/mounted) — written-but-unreachable is NOT done. Extend the tests that
   cover it.${GATES.testSetup ? ` If the harness is missing: ${GATES.testSetup}.` : ''}
2. RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: ${GATES.test ?? 'no test gate configured'}.
   Also run the FULL suite to confirm you did not redden it (report full_suite_outcome). Never weaken or
   delete a test to get green. SANITY-CHECK that the runner really executed your tests (tests_run_count = 0
   means it matched NOTHING = a false green; -1 if N/A). A wave whose gates are red never reaches the code
   gate at all — the next round is spent getting them back to green instead of climbing.
3. LEAVE EVERYTHING UNSTAGED — do NOT \`git add\` content and do NOT commit; the code gate stages this whole
   wave, and only on a clean pass. EXCEPTION: for any file you CREATE, run \`git -C ${REPO} add -N <file>\`
   (intent-to-add, so the gate's \`git diff\` sees it; it does not stage content). Set unstaged_confirmed=true.
   You may write freely under ${TESTBED}/ — it lives outside the repo, so nothing there enters the diff.
4. DECLINING the gap is legitimate, and this is the ONLY legitimate way to do it: run the matrix below,
   weigh the scope cost against the win the critic evidenced, and if you decline, record it as ONE
   ${SETTLED} line and return declined=true. An unrecorded decline is invisible — the next wave's critic
   raises the same gap from scratch and the climb stalls there.
5. ${MATRIX(waveUnit(w).id)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

// The same improver, closing out the WAVE rather than an aspect: it answers the blind code gate over the
// whole wave diff, or gets red gates back to green so that gate can run at all. Deliberately given no
// aspect, no bar and no critique file — this round is about the code, not the climb.
const gateFixPrompt = (w, r, reviewPath, treeRed) => `
You are the IMPROVER, closing out wave ${w} (gate round ${r}). This wave's work is ALL in the UNSTAGED
tree: build ON it. Do NOT revert it, and do NOT start a new improvement.
${treeRed
    ? `THE GATES ARE RED. The last improver of this wave did not leave them green, so the blind code gate has
not run and cannot: re-run the gates below, see what is failing, and fix it.`
    : reviewPath
      ? `The BLIND code gate reviewed everything this wave changed and flagged it — READ ${reviewPath} and
resolve exactly those findings.`
      : `The blind code gate flagged this wave's diff but did NOT confirm writing its review file, so there is
nothing to read. Re-check the wave's whole diff yourself against the frame below and fix what you find.`}
CANON — the hard rules every judgment is made INSIDE: ${CANON_PATH} (read it verbatim).
${ENV}

${QUALITY_FRAME}
READ ${dismissedFile(waveUnit(w).id)} and ${SETTLED} first if they exist — they are this wave's running
ledgers: do not duplicate an entry and do not re-open a settled call. If the review RE-RAISES a dismissal
as \`CONTESTS DISMISSAL:\`, you MUST fix it or settle it explicitly, never silently re-dismiss it.

PROCEDURE:
1. Resolve the findings (or the red gate) to the QUALITY FRAME, inside CANON. Report gap_addressed=true
   only if you actually closed what you were handed.
2. RUN THE GATE until it is GREEN — build: ${GATES.build ?? '(none)'} ; verification: ${GATES.test ?? 'no test gate configured'}.
   Also run the FULL suite (report full_suite_outcome). Never weaken or delete a test to get green.
3. LEAVE EVERYTHING UNSTAGED (\`git add -N <file>\` for anything you CREATE, nothing else) — the code gate
   stages this wave on its clean pass. Set unstaged_confirmed=true.
4. ${MATRIX(waveUnit(w).id)}
Return ONLY the decision fields via the schema (no prose report — your code IS the output).`;

// =============================================================================
// Terminal states — ONE literal map for BOTH phases, and the only place a status string is written. Every
// exit sets an explicit `haltKind` and this maps it; nothing sniffs prose out of a reason (tests/CLAUDE.md
// §3). It sits HERE rather than beside the result because the refine phase below returns before the mvp
// section is ever reached, and a `const` read above its declaration is a ReferenceError, not a fallback.
// =============================================================================
const HALT_STATUS = {
  'dirty-baseline':  'BLOCKED (working tree was not clean — nothing was built)',
  'agent-dead':      'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)',
  'spec-unreadable': 'BLOCKED (an agent could not obtain its component spec — nothing was built from a guess)',
  'env-fault':       'BLOCKED (environment fault — see NEEDS-USER.md)',
  'parked':          'BLOCKED (component parked — MVP incomplete; resolve before refining)',
  // Accepted work whose staging boundary was never drawn. Its own terminal because the run must NOT go on:
  // the next component's round-1 builder counts this component's unstaged files as a dirty baseline and
  // halts anyway — one opus spawn later, under a status that blames the operator for dirt this run made.
  'clean-unstaged':  'BLOCKED (a component passed clean but was not staged — stage it, then resume from the next component)',
  'park-unsafe':     'BLOCKED (a parked component left the tree unsafe — inspect before resuming)',
  // A parked WAVE is a different operator problem from a parked component — the MVP is intact and staged,
  // one wave of polish is in a patch — so it gets its own two statuses rather than borrowing mvp's.
  'wave-parked':     'BLOCKED (wave parked — its diff never cleared the code gate; resolve before climbing further)',
  'wave-park-unsafe':'BLOCKED (a parked wave left the tree unsafe — inspect before resuming)',
  // refine's two ORDINARY endings — neither is a fault. `cycles spent` carries the number of aspects still
  // open, interpolated at the site that knows it; the value here is that template, and the flow maps
  // normalize digits to N, so the template and every real status are ONE terminal.
  'aspects-closed':  'done (all aspects closed)',
  // A runOnly slice closing is NOT the climb finishing: the aspects outside the slice were never critiqued
  // and are still open in the product. Its own terminal, carrying how many were left, because "done (all
  // aspects closed)" here is the difference between "stop, we're done" and "resume the other two".
  'slice-closed':    'done (this runOnly slice closed — N aspect(s) outside the slice were not climbed)',
  'cycles-spent':    'cycles spent (N aspect(s) open — resume with more cycles)',
  'budget':          'stopped on token budget (resume where it left off)',
};

// =============================================================================
// PHASE: refine — climb the STAGED product toward BAR.md, in WAVES.
// Per wave, per still-open aspect: a fresh critic OBSERVES the running product by that aspect's own method,
// A/Bs it blind against the bar and either names ONE largest gap or CLOSES the aspect; an improver closes
// exactly that gap. After a wave that changed anything, the same BLIND code gate reviews the WHOLE wave
// diff and stages it on a clean pass — so the accepted baseline advances one WAVE here, where mvp advances
// one component. `cycles` is the user's brake and the only reason a climb terminates: a bar has no natural
// end, and "one more wave" is always arguable.
// PRECONDITION (orchestrator's job, #4): a CLEAN unstaged tree. The FIRST critic verifies it as its first
// act — refine is also an ENTRY POINT, pointed at a product this run never built, so there is no builder
// ahead of it to have checked, and the gate STAGES whatever the tree holds when a wave clears.
// There is no progress file (#6/#10): git staging plus the critique/review trail IS the durable state, and
// a resume is `startWave: <last wave + 1>` with, optionally, runOnly naming the aspects still open.
// =============================================================================
if (PHASE === 'refine') {
  // Resume / partial-slice scoping (control plane, supplied by the orchestrator).
  //   startWave: N    — the wave number this invocation starts at (file names carry it; nothing re-derives it).
  //   runOnly: [ids]  — climb exactly these aspects, in file order.
  const runOnlyAspects = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
  let pendingAspects = ALL_ASPECTS;
  if (runOnlyAspects) {
    pendingAspects = ALL_ASPECTS.filter((a) => runOnlyAspects.includes(a.id));
    // Fail fast, exactly as the mvp slice does: a silently dropped id climbs fewer aspects than the
    // operator asked for — and if every id is a typo, none at all, reported as "all aspects closed".
    const unknown = runOnlyAspects.filter((id) => !ALL_ASPECTS.some((a) => a.id === id));
    if (unknown.length) throw new Error(`args.runOnly holds unknown aspect id(s) ${unknown.map((id) => `"${id}"`).join(', ')} — under phase:"refine" it scopes ASPECT ids, not component ids. Valid ids: ${ALL_ASPECTS.map((a) => a.id).join(', ')}`);
  }
  const LAST_WAVE = START_WAVE + CYCLES - 1;
  log(`refine: ${pendingAspects.length}/${ALL_ASPECTS.length} aspect(s) over wave(s) ${START_WAVE}..${LAST_WAVE}${runOnlyAspects ? ` (runOnly: ${runOnlyAspects.join(', ')})` : ''} [gate=${REFINE_GATE}, maxGateRounds=${MAX_GATE_ROUNDS}]`);

  // Per-aspect ledger: what closed, when, and on which verdict. In-memory and returned to the
  // orchestrator, never written (#6) — the durable trail is the critique files plus git staging.
  const aspects = pendingAspects.map((a) => ({ id: a.id, status: 'open', open: true, waves: 0, improved: 0, closedWave: 0, closedBy: '', contested: 0, settled: 0 }));
  const trajectory = [];          // one entry per COMPLETED wave: counts only (#8)
  const stagedWaves = [];         // waves the code gate cleared AND staged
  let halted = false;
  let haltReason = '';
  let haltKind = '';
  // TRUE while this wave's improvements sit in the UNSTAGED tree having passed no code gate. It is what
  // decides whether an exit parks: between waves everything is staged, so a halt there changed nothing and
  // parking would take the operator's own tree hostage. A clean gate clears it — accepted work is never
  // parked, even in the one case where the gate forgot to stage it (loud, below).
  let waveWork = false;
  let checkedBaseline = false;    // the FIRST critic of the run carries the clean-tree STEP 0
  let wave = START_WAVE - 1;      // the last wave actually STARTED — what the resume instruction counts from
  let lastReviewPath = '';        // the newest code review of the wave in flight (control: a path only)

  for (let w = START_WAVE; w <= LAST_WAVE; w++) {
    // Budget floor: stop CLEANLY between waves rather than letting an agent() call throw mid-wave. Every
    // earlier wave is STAGED, so resuming costs nothing.
    if (budget.total && budget.remaining() < MIN_WAVE_BUDGET) {
      halted = true;
      haltKind = 'budget';
      haltReason = `Stopped before wave ${w}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minWaveBudget). Every earlier wave is STAGED; resume phase:"refine" with startWave:${w}.`;
      log(`⏸ ${haltReason}`);
      break;
    }
    wave = w;
    // Reset per WAVE, not per gate loop: a wave that halts in its aspect pass never reaches the gate, and a
    // stale path here would have its park record name the PREVIOUS wave's review — a diagnosis of a diff
    // that is already staged.
    lastReviewPath = '';
    const openNow = aspects.filter((r) => r.open);
    log(`▶ wave ${w} [${openNow.length} aspect(s) open: ${openNow.map((r) => r.id).join(', ')}]`);
    let improved = 0;
    let gateRounds = 0;
    let treeGreen = true;         // nothing has touched the tree yet this wave

    for (const rec of openNow) {
      rec.waves++;
      // ---- CRITIC (fresh; observes the RUNNING product, reads no prior critique) ---------------------
      const firstCritic = !checkedBaseline;
      checkedBaseline = true;
      phase('Critique');
      const cr = await agent(criticPrompt(rec, w, firstCritic), roleOpts('critic', {
        schema: CRITIC_SCHEMA, phase: 'Critique', label: `critic ${rec.id} w${w}`,
      }));
      // A dead critic is NOT a verdict. Unguarded it falls through the routing below as "not behind" —
      // i.e. this aspect ACHIEVED the bar — which is the exact shape of a finished climb, on an aspect
      // nobody looked at. A HALT rather than a throw: earlier improvements this wave are unstaged, and the
      // park below is what gets them out of the tree.
      if (!cr) {
        halted = true;
        haltKind = 'agent-dead';
        haltReason = `Critic for aspect ${rec.id} returned nothing in wave ${w} (agent skipped or died) — that is NOT an "achieved" verdict and the aspect stays OPEN. Re-invoke with the same args/runId and startWave:${w}; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
        rec.status = 'BLOCKED (agent died)';
        log(`  ✋ ${rec.id} w${w}: critic returned nothing (agent skipped or died) → halting`);
        break;
      }
      // ---- PRECONDITION (first critic of the run): the unstaged tree must have been CLEAN ------------
      // Nothing ran before it — refine is an entry point — and the wave gate STAGES whatever the tree
      // holds when it clears, so pre-existing work would be reviewed as this wave's and then folded into
      // the accepted baseline. Halt here: nothing has been changed, so there is nothing to unwind and
      // nothing to park (that work is the OPERATOR's).
      if (firstCritic) {
        // Guard the VALUE, never its coercion. `Number(undefined)` is NaN and takes the warn branch, but
        // `Number(null)`, `Number(false)`, `Number('')` and `Number([])` are all 0 and all FINITE — so a
        // coercing check reads every one of them as "0 = clean" and waves this precondition through
        // silently. It is refine's only clean-tree guard, and passing it lets the wave gate review the
        // operator's pre-existing work as this run's and `git add` it into the accepted baseline. Same
        // reasoning the numeric-arg validator states above, applied to an AGENT-supplied value.
        const dirty = cr.baseline_dirty_files;
        if (typeof dirty !== 'number' || !Number.isFinite(dirty)) {
          log(`  ⚠ w${w}: the first critic did not report baseline_dirty_files — the clean-baseline precondition was NOT verified`);
        } else if (dirty > 0) {
          halted = true;
          haltKind = 'dirty-baseline';
          haltReason = `Wave ${w} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. A wave's unstaged diff IS what the code gate reviews and then STAGES, so this run would judge that work as its own and fold it into the accepted baseline. Inspect it (git -C ${REPO} status --porcelain), then run ONE command and re-invoke this run unchanged: \`git -C ${REPO} add -A\` to KEEP it (folds it into the accepted baseline), or \`git -C ${REPO} stash -u\` to set it aside. Nothing was changed.`;
          rec.status = 'BLOCKED (dirty baseline)';
          log(`  ✋ w${w}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before anything is improved (git add -A to fold into the baseline, or git stash -u, then re-run)`);
          break;
        }
      }
      // The ONE escalation this workflow has (#7) — same fault, same status, whichever role hits it.
      if (cr.env_blocked === true) {
        halted = true;
        haltKind = 'env-fault';
        haltReason = `Critic for aspect ${rec.id} hit an ENVIRONMENT fault in wave ${w} — a tool, permission, credential or network it could not obtain (see ${NEEDS_USER}). Nothing else escalates here, so this is a real blocker: fix the environment, then re-invoke with startWave:${w}.`;
        rec.status = 'BLOCKED (environment fault)';
        log(`  ✋ ${rec.id} w${w}: critic reported an environment fault → halting (see ${NEEDS_USER})`);
        break;
      }
      // The critique file IS the improver's brief (#2), so an UNCONFIRMED write must never become a path
      // handed over as if it existed: the improver would be told to READ a file nobody wrote. Without one
      // it re-observes the aspect itself — degraded, but honest.
      const critiquePath = cr.wrote_file === true ? critiqueFile(rec.id, w) : '';
      if (!critiquePath) log(`  ⚠ ${rec.id} w${w}: critic did NOT confirm writing ${critiqueFile(rec.id, w)} — its improver gets no brief and must re-observe the aspect itself`);
      if (cr.contested_settled) {
        rec.contested += cr.contested_settled;
        log(`  ⚠ ${rec.id} w${w}: critic CONTESTED ${cr.contested_settled} settled line(s) — the improver must answer them, and its re-settlement is final (audit ${SETTLED})`);
      }
      // Self-contradictory return: by the critic's own instructions a canon break IS the largest gap, so
      // "achieved" alongside one cannot be true. The safe reading is whichever keeps the aspect OPEN —
      // closing retires it for the whole run on a verdict that contradicts itself.
      let verdict = cr.status;
      if (verdict === 'achieved' && cr.canon_violation === true) {
        verdict = 'behind';
        log(`  ⚠ ${rec.id} w${w}: critic returned achieved WITH canon_violation=true — contradictory; taken as BEHIND (a canon break is never achieved)`);
      }
      // A value outside the enum is NO verdict, not a close: a malformed return must not retire an aspect
      // any more than a dead critic may (#15). Same absorbing shape, one step short of death.
      if (verdict !== 'behind' && verdict !== 'achieved' && verdict !== 'saturated') {
        log(`  ⚠ ${rec.id} w${w}: critic returned status ${JSON.stringify(cr.status)}, which is not behind|achieved|saturated — taken as BEHIND, so the aspect stays open`);
        verdict = 'behind';
      }
      if (verdict !== 'behind') {
        rec.open = false;
        rec.closedWave = w;
        rec.closedBy = verdict;
        rec.status = verdict === 'achieved'
          ? 'closed (achieved — indistinguishable from the bar)'
          : 'closed (saturated — every remaining gap is already settled)';
        log(`  ✓ ${rec.id} w${w}: ${verdict} → aspect CLOSED${critiquePath ? ` (see ${critiquePath})` : ''}`);
        continue;
      }
      if (cr.additive === true) {
        log(`  ${rec.id} w${w}: the gap is an ADDITIVE FEATURE — the critic evidenced a UX big win inside CANON; the improver's matrix still weighs its scope cost (see ${critiquePath || SETTLED})`);
      }
      if (cr.gap_actionable !== true) {
        log(`  ⚠ ${rec.id} w${w}: critic did not confirm the gap is actionable as written — its improver may spend the round working out what "closed" means`);
      }

      // ---- IMPROVE (closes exactly that one gap) ----------------------------------------------------
      phase('Improve');
      // Set BEFORE the call, deliberately: an improver that edited files and then died leaves work in the
      // tree, and a flag set only on a healthy return would abandon it there instead of parking it.
      waveWork = true;
      const imp = await agent(improvePrompt(rec, w, critiquePath, cr.contested_settled > 0), roleOpts('improve', {
        schema: IMPROVE_SCHEMA, phase: 'Improve', label: `improve ${rec.id} w${w}`,
      }));
      if (!imp) {
        halted = true;
        haltKind = 'agent-dead';
        haltReason = `Improver for aspect ${rec.id} returned nothing in wave ${w} (agent skipped or died) — the gap is NOT closed and its work, if any, is in the tree. Re-invoke with the same args/runId and startWave:${w}; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
        rec.status = 'BLOCKED (agent died)';
        log(`  ✋ ${rec.id} w${w}: improver returned nothing (agent skipped or died) → halting`);
        break;
      }
      if (imp.env_blocked === true) {
        halted = true;
        haltKind = 'env-fault';
        haltReason = `Improver for aspect ${rec.id} hit an ENVIRONMENT fault in wave ${w} — a tool, permission, credential or network it could not obtain (see ${NEEDS_USER}). Fix the environment, then re-invoke with startWave:${w}.`;
        rec.status = 'BLOCKED (environment fault)';
        log(`  ✋ ${rec.id} w${w}: improver reported an environment fault → halting (see ${NEEDS_USER})`);
        break;
      }
      if (imp.unstaged_confirmed !== true) {
        log(`  ⚠ ${rec.id} w${w}: improver did not confirm work was left UNSTAGED — the code gate stages the wave, so the staging contract may be violated`);
      }
      const settled = Number(imp.settled_appended) || 0;
      if (settled > 0) {
        rec.settled += settled;
        log(`  ${rec.id} w${w}: improver settled ${settled} judgment call(s) itself → ${SETTLED} (the next wave's critics read it)`);
      }
      if (imp.dismissed_count) {
        log(`  ${rec.id} w${w}: improver declined ${imp.dismissed_count} finding(s) → ${dismissedFile(waveUnit(w).id)} (audit these at the end)`);
      }
      // A decline is a legitimate outcome and a SETTLED line is what makes it one: without it the next
      // wave's critic re-raises the same gap from scratch and the aspect never saturates.
      if (imp.declined === true) {
        log(`  ${rec.id} w${w}: improver DECLINED the gap after its matrix${settled ? ` — recorded in ${SETTLED}` : ` — and appended NO ${SETTLED} line, so the next wave's critic will raise it again from scratch`}`);
      } else if (imp.gap_addressed !== true) {
        log(`  ⚠ ${rec.id} w${w}: improver reports the gap neither addressed nor declined — the wave spent a round on nothing; the next critic re-observes it`);
      }
      // The gate result rides forward as `treeGreen`: the wave's code gate must never review a tree that
      // does not build (mvp's rule — those findings are the gates' to report, not an opus reviewer's).
      treeGreen = gateOk(REFINE_GATE, imp);
      if (!treeGreen) {
        log(`  ⚠ ${rec.id} w${w}: gate(${REFINE_GATE}) NOT green after the improvement (build=${imp.build_passed}, test=${imp.test_outcome}, ran=${imp.tests_run_count}, suite=${imp.full_suite_outcome}, via=${imp.verification_method || 'n/a'})${imp.gate_output ? ` — last gate output: ${String(imp.gate_output).slice(-500)}` : ''} — a gate round must get it back to green before the code gate can run`);
      }
      improved++;
      rec.improved++;
    }
    if (halted) break;

    // ---- WAVE CODE GATE (blind, over the WHOLE wave diff; stages the wave on a clean pass) ----------
    // Once per WAVE, not per aspect: the gate's unit is a diff, and reviewing each aspect's change alone
    // would miss precisely what a wave introduces — two improvements that each read fine and contradict
    // each other. A round that starts on a RED tree is spent on the fixer instead, so the gate never
    // reviews something that does not build.
    if (improved > 0) {
      const unit = waveUnit(w);
      let gateClean = false;
      while (gateRounds < MAX_GATE_ROUNDS) {
        gateRounds++;
        if (treeGreen) {
          phase('Gate');
          const wcg = await agent(codeGatePrompt(unit, gateRounds), roleOpts('codeGate', {
            schema: CODE_GATE_SCHEMA, phase: 'Gate', label: `code-gate ${unit.id} r${gateRounds}`,
          }));
          // A dead gate is NOT a clean review — and here it is also the staging agent, so absorbing it
          // would advance the baseline with nothing reviewed and nothing staged.
          if (!wcg) {
            halted = true;
            haltKind = 'agent-dead';
            haltReason = `Code gate for wave ${w} returned nothing in gate round ${gateRounds} (agent skipped or died) — that is NOT a clean review, and nothing was staged. Re-invoke with the same args/runId and startWave:${w}; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
            log(`  ✋ ${unit.id} r${gateRounds}: code gate returned nothing (agent skipped or died) → halting`);
            break;
          }
          if (wcg.contested_dismissals) {
            log(`  ⚠ ${unit.id} r${gateRounds}: code gate CONTESTED ${wcg.contested_dismissals} dismissal(s) — the improver must fix or settle them explicitly, never re-dismiss (audit ${dismissedFile(unit.id)})`);
          }
          // `clean:true` WITH findings contradicts the schema's own words ("true if NO … defects and NO
          // structural debt were found" / "number of findings written to the review file"). Here the gate
          // is also the STAGING agent, so reading it as clean would promote a diff carrying N written
          // findings into the accepted baseline every later wave is judged against — and no review path is
          // set, so that file reaches nobody. Taken as FLAGGED, the way the critic's contradiction is
          // (tests/CLAUDE.md §3: does the harm compound? here it compounds into the baseline).
          if (wcg.clean === true && !(wcg.issue_count > 0)) {
            gateClean = true;
            // A clean pass means this wave is ACCEPTED, so it is never parked — even when the gate forgot
            // to stage it. That is mvp's deliberate passed-but-unstaged exception: one `git add` restores
            // the boundary, and parking good work instead would be strictly worse.
            waveWork = false;
            if (wcg.staged === true) {
              stagedWaves.push(w);
              log(`  ✓ ${unit.id}: code gate CLEAN after ${gateRounds} round(s) — STAGED`);
            } else {
              log(`  ⚠ ${unit.id}: code gate passed CLEAN but did NOT confirm staging — stage its files yourself (git -C ${REPO} add <files>) before anything else runs, or the NEXT wave's blind diff carries this wave's work`);
            }
            break;
          } else if (wcg.clean === true) {
            log(`  ⚠ ${unit.id} r${gateRounds}: code gate returned clean=true WITH issue_count=${wcg.issue_count} — contradictory; taken as FLAGGED`);
          }
          lastReviewPath = wcg.wrote_file === true ? codeReviewFile(unit.id, gateRounds) : '';
          if (!lastReviewPath) {
            log(`  ⚠ ${unit.id} r${gateRounds}: code gate reported ${wcg.issue_count ?? '?'} finding(s) but did NOT confirm writing ${codeReviewFile(unit.id, gateRounds)} — the improver is given no review path`);
          }
          if (gateRounds >= MAX_GATE_ROUNDS) {
            log(`  ⚠ ${unit.id} r${gateRounds}: ${wcg.issue_count ?? '?'} finding(s) open at the gate-round budget${lastReviewPath ? ` (see ${lastReviewPath})` : ''}`);
            break;
          }
          log(`  ↻ ${unit.id} r${gateRounds}: code gate found ${wcg.issue_count ?? '?'} finding(s)${lastReviewPath ? ` → the improver addresses ${lastReviewPath}` : ' → the improver re-checks the diff itself'}`);
        } else if (gateRounds >= MAX_GATE_ROUNDS) {
          log(`  ⚠ ${unit.id} r${gateRounds}: the gates are still RED at the gate-round budget — the code gate never ran on this wave`);
          break;
        }

        // ---- IMPROVE, closing out the wave: answer the review, or get the gates back to green --------
        phase('Improve');
        const fix = await agent(gateFixPrompt(w, gateRounds, lastReviewPath, !treeGreen), roleOpts('improve', {
          schema: IMPROVE_SCHEMA, phase: 'Improve', label: `improve ${unit.id} r${gateRounds}`,
        }));
        if (!fix) {
          halted = true;
          haltKind = 'agent-dead';
          haltReason = `Improver closing out wave ${w} returned nothing in gate round ${gateRounds} (agent skipped or died) — the wave's findings are UNRESOLVED and its work is in the tree. Re-invoke with the same args/runId and startWave:${w}; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
          log(`  ✋ ${unit.id} r${gateRounds}: improver returned nothing (agent skipped or died) → halting`);
          break;
        }
        if (fix.env_blocked === true) {
          halted = true;
          haltKind = 'env-fault';
          haltReason = `Improver closing out wave ${w} hit an ENVIRONMENT fault in gate round ${gateRounds} — a tool, permission, credential or network it could not obtain (see ${NEEDS_USER}). Fix the environment, then re-invoke with startWave:${w}.`;
          log(`  ✋ ${unit.id} r${gateRounds}: improver reported an environment fault → halting (see ${NEEDS_USER})`);
          break;
        }
        if (fix.unstaged_confirmed !== true) {
          log(`  ⚠ ${unit.id} r${gateRounds}: improver did not confirm work was left UNSTAGED — the code gate stages, so the staging contract may be violated`);
        }
        const fixSettled = Number(fix.settled_appended) || 0;
        if (fixSettled > 0) log(`  ${unit.id} r${gateRounds}: improver settled ${fixSettled} judgment call(s) itself → ${SETTLED} (audit these at the end)`);
        if (fix.dismissed_count) log(`  ${unit.id} r${gateRounds}: improver declined ${fix.dismissed_count} finding(s) → ${dismissedFile(unit.id)} (audit these at the end)`);
        if (fix.declined === true && fixSettled === 0) {
          log(`  ⚠ ${unit.id} r${gateRounds}: improver DECLINED a finding but appended no ${SETTLED} line — nothing records the call, so the next round re-opens it`);
        } else if (fix.declined !== true && fix.gap_addressed !== true) {
          log(`  ⚠ ${unit.id} r${gateRounds}: improver reports the findings neither resolved nor declined — the gate round produced nothing`);
        }
        treeGreen = gateOk(REFINE_GATE, fix);
        if (!treeGreen) {
          log(`  ⚠ ${unit.id} r${gateRounds}: gate(${REFINE_GATE}) still NOT green (build=${fix.build_passed}, test=${fix.test_outcome}, ran=${fix.tests_run_count}, suite=${fix.full_suite_outcome}, via=${fix.verification_method || 'n/a'})${fix.gate_output ? ` — last gate output: ${String(fix.gate_output).slice(-500)}` : ''}`);
        }
      }
      if (halted) break;
      if (!gateClean) {
        halted = true;
        haltKind = 'wave-parked';
        haltReason = `Wave ${w} did not clear the code gate within ${MAX_GATE_ROUNDS} gate round(s) (${lastReviewPath ? `see ${lastReviewPath}` : `it produced no review file; see the run trail in ${STATE_DIR}`}). Everything up to wave ${w} is STAGED and intact.`;
        log(`  ✋ ${unit.id}: not clean within ${MAX_GATE_ROUNDS} gate round(s) → parking the wave's work, then halting`);
        break;
      }
    }

    trajectory.push({ wave: w, open: aspects.filter((r) => r.open).length, improved, gateRounds });
    if (!aspects.some((r) => r.open)) {
      // `aspects` is built from the runOnly-FILTERED list, so this test only ever asks whether the SLICE is
      // closed. Under runOnly it is not the climb finishing — nothing outside the slice was critiqued at
      // all — so it takes its own terminal and reports halted, with the resume that climbs the rest.
      const outside = ALL_ASPECTS.filter((a) => !aspects.some((r) => r.id === a.id)).map((a) => a.id);
      haltKind = outside.length ? 'slice-closed' : 'aspects-closed';
      if (haltKind === 'slice-closed') {
        haltReason = `Wave ${w} closed every aspect in this runOnly slice (${aspects.map((r) => r.id).join(', ')}), but ${outside.length} aspect(s) of ASPECTS.md were never climbed by this invocation: ${outside.join(', ')}. They are NOT closed. Every wave that improved anything is STAGED, so resume phase:"refine" with startWave:${w + 1} and runOnly:[${outside.map((id) => `"${id}"`).join(', ')}].`;
        log(`✓ wave ${w}: every aspect in the runOnly slice is closed — ${outside.length} outside it were not climbed (${outside.join(', ')})`);
      } else {
        log(`✓ wave ${w}: every aspect is closed — the climb is done`);
      }
      break;
    }
  }

  // Fell out of the wave loop with waves spent and aspects still open. An ORDINARY ending: `cycles` is the
  // user's brake, so spending it is the expected outcome, not a fault — and the resume is one arg away.
  const openIds = aspects.filter((r) => r.open).map((r) => r.id);
  if (!haltKind) {
    haltKind = 'cycles-spent';
    haltReason = `Wave budget spent after wave ${wave}: ${openIds.length} aspect(s) still open (${openIds.join(', ')}). Every wave that improved anything is STAGED, so resume phase:"refine" with startWave:${wave + 1} — add runOnly:[${openIds.map((id) => `"${id}"`).join(', ')}] to spend the next cycles only on what is still open.`;
    log(`⏹ ${haltReason}`);
  }

  // ---- PARK whatever the wave left in the tree -----------------------------------------------------
  // Reached on both shapes of unfinished wave: a halt mid-wave, and a wave whose diff never cleared the
  // gate. Its work is SAVED to a patch and CLEARED, so the repo is left clean and buildable — which is what
  // makes the first critic's clean-baseline precondition correct on the resume. NOT reached when the tree
  // holds nothing of ours: a budget stop between waves, an ending with every wave staged, and a
  // dirty-baseline halt (that work is the OPERATOR's, and parking it would take their changes hostage).
  let parkedWave = null;
  if (waveWork) {
    const unit = waveUnit(wave);
    phase('Park');
    const wpk = await agent(parkPrompt(unit, lastReviewPath, haltKind !== 'wave-parked', 'wave',
      `restore the patch and finish this wave by hand · resolve what the gate flagged and re-run this wave (\`startWave:${wave}\`) · drop the patch`), roleOpts('build', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${unit.id}`,
    }));
    const strays = wpk?.strays_saved ?? 0;
    // Patch bytes written but `saved` false — an internally inconsistent report. The tree may already be
    // cleared, so telling the user nothing was saved would be actively wrong: name the patch and stop.
    const contradictory = wpk?.saved !== true && (wpk?.patch_bytes ?? 0) > 0;
    parkedWave = {
      id: unit.id,
      patch: (wpk?.saved === true || contradictory) ? parkedPatch(unit.id) : null,
      strays: strays > 0 ? parkedNewDir(unit.id) : null,
    };
    log(`  ⚠ ${unit.id}: PARKED (work saved to ${parkedWave.patch || 'nothing to save'}${wpk?.patch_bytes ? `, ${wpk.patch_bytes}B` : ''}${strays > 0 ? `, +${strays} stray file(s) in ${parkedNewDir(unit.id)}/` : ''}, tree ${wpk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${wpk?.gates_green ? 'green' : 'RED'}) — see ${NEEDS_USER}${wpk?.notes ? ` — park note: ${String(wpk.notes).slice(0, 300)}` : ''}`);
    // A tree the park could not clear, a self-contradictory report, or a red build afterwards each leave
    // the repo unsafe to resume into — a different operator problem from a plain park, so each gets the
    // status rather than a sentence buried in the reason.
    if (contradictory) {
      haltKind = 'wave-park-unsafe';
      haltReason += ` Park reported saved=false while writing ${wpk.patch_bytes} bytes to ${parkedPatch(unit.id)} — the report contradicts itself; the patch is real, inspect it before resuming.`;
    } else if (wpk?.cleared !== true) {
      haltKind = 'wave-park-unsafe';
      haltReason += ` This wave's work could NOT be cleared from the tree${wpk?.saved === true ? ` (it IS saved to ${parkedPatch(unit.id)})` : ' and was NOT saved — the tree still holds it'}; clean the tree yourself before resuming.`;
    } else if (wpk?.gates_green === false) {
      haltKind = 'wave-park-unsafe';
      haltReason += ` This wave's work IS saved to ${parkedPatch(unit.id)} and the tree was cleared, but the BUILD is RED afterwards — the tree is unsafe to resume into. Fix the build before re-running this wave.`;
    } else {
      haltReason += ` Its work is SAVED to ${parkedPatch(unit.id)} and the tree is CLEAN; resolve it, then resume from this wave.`;
    }
  }

  // `cycles spent` counts as halted for the caller: the climb is unfinished and one arg resumes it. Only
  // "all aspects closed" is a finished run — and an unmapped kind is an ENGINE BUG, never a plausible
  // terminal, which is the whole reason the map above exists.
  const refineHalted = haltKind !== 'aspects-closed';
  const status = haltKind === 'cycles-spent'
    ? `cycles spent (${openIds.length} aspect(s) open — resume with more cycles)`
    : haltKind === 'slice-closed'
      ? `done (this runOnly slice closed — ${ALL_ASPECTS.length - aspects.length} aspect(s) outside the slice were not climbed)`
      : (HALT_STATUS[haltKind] || `halted (unmapped terminal state "${haltKind}" — engine bug)`);
  const closedIds = aspects.filter((r) => !r.open).map((r) => r.id);
  // Denominator is EVERY aspect, never the runOnly slice: "1/1 closed" against a narrowed list reads as a
  // finished climb on a product with two aspects nobody looked at.
  log(`refine: ${status} — ${closedIds.length}/${ALL_ASPECTS.length} aspect(s) closed over ${trajectory.length} completed wave(s) [${trajectory.reduce((s, t) => s + t.gateRounds, 0)} code-gate round(s)]`);

  return {
    phase: 'refine',
    runId: RUN_ID,
    status,
    halted: refineHalted,
    haltReason: refineHalted ? haltReason : '',
    stateDir: STATE_DIR,
    wavesCompleted: trajectory.length,
    lastWave: wave,
    aspectsClosed: closedIds,
    aspectsOpen: openIds,
    aspectsTotal: ALL_ASPECTS.length,
    stagedWaves,
    contestedSettled: aspects.reduce((s, r) => s + (r.contested || 0), 0),
    settledDecisions: aspects.reduce((s, r) => s + (r.settled || 0), 0),
    // The CLIMB, wave by wave — counts only. No single wave can tell a product still closing distance from
    // one grinding over settled ground: `open` falling is the first, `improved` staying high while `open`
    // holds is the second.
    trajectory,
    parked: parkedWave ? [parkedWave] : [],
    ledger: aspects,
    reviewTrail: `critique-<aspect>-w<N>.md in ${STATE_DIR}/ is what each critic observed and named; ${GATE_DIR}/code-review-wave-<N>-rM.md is each wave's blind code gate (its own directory — nothing that could tell it what the wave was FOR may sit beside it); ${SETTLED} carries every call the improvers settled themselves; git staging marks each accepted wave.`,
    followups: `${refineHalted ? `Run stopped — ${haltReason} ` : `Every aspect is closed: ${closedIds.join(', ')}. `}${parkedWave ? `PARKED: ${parkedWave.id}. That work is saved to ${parkedWave.patch || `(nothing — see ${NEEDS_USER})`} and cleared from the tree; ${NEEDS_USER} carries the diagnosis and the verbatim \`git apply --3way\` restore command. ` : ''}Verify the end state yourself: run the full gates, \`git -C ${REPO} diff --cached --stat\`, and \`git -C ${REPO} status --porcelain\` (should be clean). Read the critique files, ${SETTLED} (every judgment call the improvers made) and each DISMISSED-wave-<N>.md in ${GATE_DIR}/, and surface ${NEEDS_USER}. Nothing is committed — you commit.`,
  };
}

// =============================================================================
// PHASE: mvp — build each component IN ORDER; per component: build → BLIND code gate (stages on clean).
// A component that does NOT pass is PARKED — its work saved to a patch and CLEARED from the tree — and the
// run STOPS. (feature-cycle parks and CONTINUES because a roadmap's plans are independent features;
// gauntlet's components decompose ONE product, so N+1 builds on N — migrate-cycle's asymmetry, and its
// reason.) PRECONDITION (orchestrator's job, #4): the target repo has a CLEAN unstaged working tree; any
// already-accepted components are STAGED. There is no progress file — git staging plus the numbered review
// trail IS the durable state (#6/#10).
// =============================================================================
// Resume / partial-slice scoping (control plane, supplied by the orchestrator after it reconstructs
// progress from git staging + the review-file trail).
//   runOnly: [ids]  — build exactly these components (in file order).
//   startAt: id     — build from this component to the end (skip the already-accepted earlier ones).
const runOnly = Array.isArray(A.runOnly) && A.runOnly.length ? A.runOnly : null;
let pending = ALL_COMPONENTS;
if (runOnly) {
  pending = ALL_COMPONENTS.filter((c) => runOnly.includes(c.id));
  // An unknown id must FAIL FAST, exactly as startAt does below: a silently dropped id builds fewer
  // components than the operator asked for — and if every id is a typo, nothing at all, reported as a
  // benign success with no error.
  const unknown = runOnly.filter((id) => !ALL_COMPONENTS.some((c) => c.id === id));
  if (unknown.length) throw new Error(`args.runOnly ${unknown.map((id) => `"${id}"`).join(', ')} matches no component id. Valid ids: ${ALL_COMPONENTS.map((c) => c.id).join(', ')}`);
} else if (A.startAt) {
  const i = ALL_COMPONENTS.findIndex((c) => c.id === A.startAt);
  // An unknown id must FAIL FAST — silently falling back to the whole list would rebuild components whose
  // work is already the staged baseline, and burn the run.
  if (i < 0) throw new Error(`args.startAt "${A.startAt}" matches no component id. Valid ids: ${ALL_COMPONENTS.map((c) => c.id).join(', ')}`);
  pending = ALL_COMPONENTS.slice(i);
}
log(`mvp: ${pending.length}/${ALL_COMPONENTS.length} component(s) to build${runOnly ? ` (runOnly: ${runOnly.join(', ')})` : A.startAt ? ` (startAt: ${A.startAt})` : ''} [maxRounds=${MAX_ROUNDS}]`);

const ledger = [];               // in-memory, returned to the orchestrator (NOT a written file — #6)
let halted = false;
let haltReason = '';
// WHY the run halted, as a value rather than prose. A status line that sniffs substrings out of haltReason
// silently reports the wrong thing the day someone adds a reason; every halt site below sets this instead.
let haltKind = '';
const doneIds = [];

for (const c of pending) {
  // Budget guard: when the user set a token target (e.g. "+500k"), stop CLEANLY between components rather
  // than letting an agent() call throw mid-component. Accepted components are STAGED; resume continues.
  if (budget.total && budget.remaining() < MIN_COMPONENT_BUDGET) {
    halted = true;   // so the reason + resume instruction surface in the return value
    haltKind = 'budget';
    haltReason = `Stopped before component ${c.id}: ~${Math.round(budget.remaining() / 1000)}k tokens remain (< minComponentBudget). Resume phase:"mvp" with startAt:"${c.id}".`;
    log(`⏸ ${haltReason}`);
    break;
  }

  log(`▶ component ${c.id} [gate=${c.gate}]`);
  const rec = { id: c.id, gate: c.gate, status: 'pending', rounds: 0, gateRounds: 0, contested: 0, settled: 0, staged: false, parked: false };
  let reviewPath = '';           // the code review the next builder must address (control: a path only)
  // Which EMPTY-reviewPath cause the next round is answering: red gates, or a gate that flagged the diff
  // without confirming its review file. The engine knows; without carrying it the builder is told the
  // gates were red when they are green and spends the round re-running them.
  let treeRed = false;
  let accepted = false;
  // `interrupted` distinguishes the two halt shapes: a halt mid-build leaves real work in the tree (park
  // it), while a round-1 dirty-baseline halt changed nothing (that work is the OPERATOR's — never park it).
  let interrupted = false;
  let round = 0;

  while (round < MAX_ROUNDS) {
    round++;
    rec.rounds = round;

    // ---- BUILD -------------------------------------------------------------
    phase('Build');
    const dev = await agent(buildPrompt(c, round, reviewPath, treeRed), roleOpts('build', {
      schema: BUILD_SCHEMA, phase: 'Build', label: `build ${c.id} r${round}`,
    }));

    // ---- PRECONDITION: the builder AGENT itself came back -------------------------------------------
    // A dead agent is not a failed round: nothing is known about the tree either way. Unguarded it falls
    // into `gateOk(!dev) === false` and reads as an ordinary gate miss, so the component burns its whole
    // round budget and parks — telling the operator to sharpen the spec when the real action is a replay.
    // A HALT, not a throw: a throw here would exit with the builder's work still unstaged and unparked.
    if (!dev) {
      halted = true;
      interrupted = true;   // it may have touched the tree before dying → park rather than abandon
      haltKind = 'agent-dead';
      haltReason = `Builder for component ${c.id} returned nothing in round ${round} (agent skipped or died) — no work can be assumed either way. Re-invoke with the same args/runId; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${c.id} r${round}: builder returned nothing (agent skipped or died) → halting before the code gate`);
      break;
    }

    // ---- PRECONDITION: the builder actually HAS its component spec ----------------------------------
    // The block command runs in the AGENT's shell, so the harness cannot verify it (it has no tools). This
    // attestation is the only signal the spec ever arrived — without a consumer it would be pure theater,
    // and an agent whose command was denied, or whose id matches no block, would build something plausible
    // and the run would report success. `=== false` so a dead agent (null) is caught by the halt directly
    // above rather than being laundered into this one.
    if (dev?.spec_obtained === false) {
      halted = true;
      interrupted = true;   // it may have touched the tree before giving up → park rather than abandon
      haltKind = 'spec-unreadable';
      haltReason = `Builder for component ${c.id} could not obtain its spec (round ${round}). Its spec reference was: ${specRef(c.id)} Run that command yourself: a non-zero exit names the cause (an id matching no "## Component:" block, a pruned or mistyped components file, or the command not permitted in this environment). Nothing was built from a guess.`;
      rec.status = 'BLOCKED (spec unreadable)';
      log(`  ✋ ${c.id} r${round}: builder never got its component spec → halting before the code gate`);
      break;
    }

    // ---- PRECONDITION (round 1 of every component): the unstaged tree must have been CLEAN ----------
    // The code gate scopes on the unstaged diff, so stray pre-existing work would be reviewed as this
    // component's and burn the whole round budget on code nobody in this run touched. Halt HERE — before
    // the gate spawns. The builder did no work, so there is nothing to unwind.
    if (round === 1) {
      // The VALUE, not its coercion — the twin of refine's guard above, and for the same reason: only
      // `undefined` coerces to NaN, while null/false/''/[] all coerce to a finite 0 that reads as CLEAN
      // and lets the blind gate review the operator's pre-existing work as this component's.
      const dirty = dev?.baseline_dirty_files;
      if (typeof dirty !== 'number' || !Number.isFinite(dirty)) {
        log(`  ⚠ ${c.id} r1: builder did not report baseline_dirty_files — the clean-baseline precondition was NOT verified`);
      } else if (dirty > 0) {
        halted = true;
        rec.status = 'BLOCKED (dirty baseline)';
        haltKind = 'dirty-baseline';
        haltReason = `Component ${c.id} was not started: ${dirty} file(s) in ${REPO} already held UNSTAGED or untracked work. The unstaged tree IS the code gate's scope, so this run would review and judge that work as its own. Inspect it (git -C ${REPO} status --porcelain), then run ONE command and re-invoke this run unchanged: \`git -C ${REPO} add -A\` to KEEP it (folds it into the accepted baseline), or \`git -C ${REPO} stash -u\` to set it aside. Nothing was built or changed.`;
        log(`  ✋ ${c.id}: ${dirty} pre-existing unstaged/untracked file(s) in ${REPO} → halting before the code gate (git add -A to fold into the baseline, or git stash -u, then re-run)`);
        break;
      }
    }
    // The ONE escalation this workflow has (#7). Every other call is the builder's own, so an env fault is
    // never conflatable with "the component was hard": it gets its own status and its own write-up.
    if (dev?.env_blocked === true) {
      halted = true;
      interrupted = true;   // real work may be in the tree → park it below rather than abandoning it there
      haltKind = 'env-fault';
      haltReason = `Builder hit an ENVIRONMENT fault in component ${c.id} round ${round} — a tool, permission, credential or network it could not obtain (see ${NEEDS_USER}). Nothing else escalates here, so this is a real blocker: fix the environment, then re-invoke with startAt:"${c.id}".`;
      rec.status = 'BLOCKED (environment fault)';
      log(`  ✋ ${c.id} r${round}: builder reported an environment fault → halting (see ${NEEDS_USER})`);
      break;
    }
    if (dev?.unstaged_confirmed !== true) {
      log(`  ⚠ ${c.id} r${round}: builder did not confirm work was left UNSTAGED — the code gate stages, so the staging contract may be violated`);
    }
    if (dev?.dismissed_count) {
      log(`  ${c.id} r${round}: builder declined ${dev.dismissed_count} finding(s) → ${dismissedFile(c.id)} (audit these at the end)`);
    }
    // The builder settles its own ambiguity (#7) and SETTLED.md is where those calls land. The COUNT is
    // control plane (#1/#8) — the reasoning stays in the file. Coerced and floored so a garbage value
    // cannot poison the ledger total; 0/absent logs nothing at all.
    const settled = Number(dev?.settled_appended) || 0;
    if (settled > 0) {
      rec.settled += settled;
      log(`  ${c.id} r${round}: builder settled ${settled} judgment call(s) itself → ${SETTLED} (audit these at the end)`);
    }
    if (!gateOk(c.gate, dev)) {
      // Build/verification not green: give the builder another fresh round to fix it (it re-runs the gate
      // and sees the failure live). No content is carried by the harness, and no review file exists yet.
      reviewPath = '';
      treeRed = true;
      // The builder re-runs the gate live each round, so the engine holds the only copy of WHY it was red
      // once the round budget is gone — surface its diagnostics here rather than collecting them into a
      // schema field nothing reads. Prose stays out of the control plane: log only.
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${c.id} r${round}: gate(${c.gate}) not green at round budget (via=${dev?.verification_method || 'n/a'})${dev?.gate_output ? ` — last gate output: ${String(dev.gate_output).slice(-500)}` : ''}`); break; }
      log(`  ↻ ${c.id} r${round}: gate(${c.gate}) not green (build=${dev?.build_passed}, test=${dev?.test_outcome}, suite=${dev?.full_suite_outcome}, via=${dev?.verification_method || 'n/a'}) → another build round`);
      continue;
    }

    // ---- CODE GATE (blind; stages on a clean pass) ---------------------------
    phase('Gate');
    rec.gateRounds++;
    const cg = await agent(codeGatePrompt(c, round), roleOpts('codeGate', {
      schema: CODE_GATE_SCHEMA, phase: 'Gate', label: `code-gate ${c.id} r${round}`,
    }));
    // A dead gate is NOT a clean review — and here it is also the staging agent, so absorbing it would
    // advance the baseline with nothing reviewed and nothing staged.
    if (!cg) {
      halted = true;
      interrupted = true;
      haltKind = 'agent-dead';
      haltReason = `Code gate for component ${c.id} returned nothing in round ${round} (agent skipped or died) — that is NOT a clean review, and nothing was staged. Re-invoke with the same args/runId; pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`;
      rec.status = 'BLOCKED (agent died)';
      log(`  ✋ ${c.id} r${round}: code gate returned nothing (agent skipped or died) → halting`);
      break;
    }
    if (cg?.contested_dismissals) {
      rec.contested += cg.contested_dismissals;
      log(`  ⚠ ${c.id} r${round}: code gate CONTESTED ${cg.contested_dismissals} dismissal(s) — the builder must fix or settle them explicitly, never re-dismiss (audit ${dismissedFile(c.id)})`);
    }
    // `clean:true` alongside findings contradicts the schema's own words, and the gate is ALSO the staging
    // agent here — reading it as clean would stage a diff carrying N written findings into the accepted
    // baseline every later component is judged against, with the file holding them handed to nobody. Taken
    // as FLAGGED (the refine wave gate above decides the same contradiction the same way).
    if (cg?.clean !== true || cg?.issue_count > 0) {
      if (cg?.clean === true) {
        log(`  ⚠ ${c.id} r${round}: code gate returned clean=true WITH issue_count=${cg.issue_count} — contradictory; taken as FLAGGED`);
      }
      // The review file IS the message to the next builder (#2), so an UNCONFIRMED write must not become a
      // path handed over as if it existed: the builder would be told to "READ" a file nobody wrote. Without
      // it the next round re-runs the gate blind, which is degraded but honest (migrate shipped the other
      // shape — a park naming a review file that was never written).
      reviewPath = cg?.wrote_file === true ? codeReviewFile(c.id, round) : '';
      treeRed = false;   // the round reached the gate at all only by passing gateOk() — the gates ARE green
      if (cg?.wrote_file !== true) {
        log(`  ⚠ ${c.id} r${round}: code gate reported ${cg?.issue_count ?? '?'} finding(s) but did NOT confirm writing ${codeReviewFile(c.id, round)} — the next builder is given no review path`);
      }
      if (round >= MAX_ROUNDS) { log(`  ⚠ ${c.id} r${round}: ${cg?.issue_count ?? '?'} finding(s) open at round budget${reviewPath ? ` (see ${reviewPath})` : ''}`); break; }
      log(`  ↻ ${c.id} r${round}: code gate found ${cg?.issue_count ?? '?'} finding(s)${reviewPath ? ` → build addresses ${reviewPath}` : ' → build re-runs without a review file'}`);
      continue;
    }
    // CLEAN — the gate stages, and the accepted baseline advances one component.
    rec.staged = cg?.staged === true;
    if (!rec.staged) {
      // HALT, and deliberately NOT a park: the work is ACCEPTED (so `interrupted` stays false and nothing
      // is saved-and-cleared), but the staging boundary this workflow rests on was never drawn. Continuing
      // is what the engine used to do, and it cannot work: the NEXT component's round-1 builder counts this
      // component's unstaged files as its dirty baseline and halts one opus spawn later under
      // `dirty-baseline`, whose text blames pre-existing operator work for dirt this run created. Halting
      // here says the true thing and names the exact recovery instead.
      const nextId = pending[pending.indexOf(c) + 1]?.id ?? '';
      halted = true;
      haltKind = 'clean-unstaged';
      haltReason = `Component ${c.id} passed the code gate CLEAN but the gate did not confirm STAGING it, so its work is still unstaged. It is ACCEPTED, not failed — nothing was parked and nothing is lost. Stage it yourself: \`git -C ${REPO} add <${c.id}'s changed AND newly-created files>\`, then ${nextId ? `re-invoke with startAt:"${nextId}"` : 'you are done — this was the last component this invocation had to build'}. Left unstaged, the next component's round-1 baseline is dirty and the run halts there instead.`;
      log(`  ⚠ ${c.id}: code gate passed CLEAN but did NOT confirm staging → halting: stage its files yourself (git -C ${REPO} add <files>)${nextId ? `, then resume with startAt:"${nextId}"` : ''}`);
    }
    accepted = true;
    log(`  ✓ ${c.id}: code gate CLEAN after ${round} round(s)${rec.staged ? ' — STAGED' : ''}`);
    break;
  }

  if (accepted) {
    rec.status = rec.staged ? 'done (staged)' : 'done (gate clean, NOT staged — stage it yourself)';
    doneIds.push(c.id);
    ledger.push(rec);
    // Accepted AND halted is the clean-but-unstaged case: the ledger still shows this component done, but
    // the run stops rather than handing the next builder a tree holding this component's work.
    if (halted) break;
    continue;
  }

  // ---- PARK, then STOP -----------------------------------------------------------------------------
  // Reached on either terminal outcome: the round budget ran out, or a halt left work in the tree. The run
  // stops either way (later components build on this one), but the component's work is SAVED to a patch and
  // the tree is CLEARED — leaving the repo buildable and clean, which is what makes the clean-baseline
  // precondition correct on the resume. NOT reached on a dirty-baseline halt: nothing was changed there and
  // the work in the tree is the operator's, so parking it would take their changes hostage.
  if (!(halted && !interrupted)) {
    if (!halted) {
      halted = true;
      haltKind = 'parked';
      rec.status = 'parked (did not pass the code gate within the round budget)';
      // `reviewPath` is EMPTY when the component never produced a review file (its gate never went green,
      // so the code gate never ran — or it ran and did not confirm the write). Naming a review path that
      // was never written points the operator, days later, at a file that does not exist.
      haltReason = `Component ${c.id} did not pass the code gate within ${MAX_ROUNDS} rounds (${reviewPath ? `see ${reviewPath}` : `it produced no review file; see the run trail in ${STATE_DIR}`}).`;
      log(`  ✋ ${c.id}: not passed within ${MAX_ROUNDS} rounds → parking its work, then halting`);
    }
    phase('Park');
    const pk = await agent(parkPrompt(c, reviewPath, interrupted, 'component',
      `restore the patch and finish this component by hand · sharpen its block in COMPONENTS.md and re-run from it (\`startAt:"${c.id}"\`) · drop the patch`), roleOpts('build', {
      schema: PARK_SCHEMA, phase: 'Park', label: `park:${c.id}`,
    }));
    rec.parked = true;   // an explicit flag, not a later re-read of the status prose — same reason haltKind exists
    const strays = pk?.strays_saved ?? 0;
    // Patch bytes written but `saved` false — an internally inconsistent report. The tree may already be
    // cleared, so telling the user "nothing was saved" would be actively wrong: name the patch and stop.
    const contradictory = pk?.saved !== true && (pk?.patch_bytes ?? 0) > 0;
    rec.patch = (pk?.saved === true || contradictory) ? parkedPatch(c.id) : null;
    if (strays > 0) rec.strays = parkedNewDir(c.id);
    // Park's `notes` is the only place the "nothing to park" case can explain itself: step 1 tells the
    // agent to skip ahead with saved=false, patch_bytes=0 "and a note saying so", and without surfacing it
    // the line reads `work saved to nothing to save` with no reason given. Log only — prose stays out of
    // the control plane.
    log(`  ⚠ ${c.id}: PARKED (work saved to ${rec.patch || 'nothing to save'}${pk?.patch_bytes ? `, ${pk.patch_bytes}B` : ''}${strays > 0 ? `, +${strays} stray file(s) in ${parkedNewDir(c.id)}/` : ''}, tree ${pk?.cleared === true ? 'cleared' : 'NOT CLEARED'}, build ${pk?.gates_green ? 'green' : 'RED'}) — see ${NEEDS_USER}${pk?.notes ? ` — park note: ${String(pk.notes).slice(0, 300)}` : ''}`);
    // A tree park could not clear, a self-contradictory report, or a red build afterwards each leave the
    // repo unsafe to resume into — a different operator problem from a plain park, so it gets its own
    // status rather than a sentence buried in the reason.
    if (contradictory) {
      haltKind = 'park-unsafe';
      haltReason += ` Park reported saved=false while writing ${pk.patch_bytes} bytes to ${parkedPatch(c.id)} — the report contradicts itself; the patch is real, inspect it before resuming.`;
    } else if (pk?.cleared !== true) {
      haltKind = 'park-unsafe';
      haltReason += ` Its work could NOT be cleared from the tree${pk?.saved === true ? ` (it IS saved to ${parkedPatch(c.id)})` : ' and was NOT saved — the tree still holds it'}; clean the tree yourself before resuming.`;
    } else if (pk?.gates_green === false) {
      haltKind = 'park-unsafe';
      haltReason += ` Its work IS saved to ${parkedPatch(c.id)} and the tree was cleared, but the BUILD is RED afterwards — the tree is unsafe to resume into. Fix the build before re-running this component.`;
    } else {
      haltReason += ` Its work is SAVED to ${parkedPatch(c.id)} and the tree is CLEAN; resolve it, then resume from this component.`;
    }
  }
  // Unreachable today (every exit sets a status, or parks — which sets one), and kept as a guard for a
  // future exit that forgets. It must name itself an ENGINE BUG rather than leak the initial 'pending',
  // which in a finished run's ledger reads as "still working".
  if (rec.status === 'pending') rec.status = 'BLOCKED (engine bug: component finished with no status set)';
  ledger.push(rec);
  break;      // stop-after-park: the components after this one build on it, so the run ends here
}

// =============================================================================
// Result (control plane → the orchestrating agent; durable progress lives in git + the review-file trail)
// =============================================================================
// Anything with saved work the user must be told about. Keyed on an explicit per-component FLAG rather than
// on the status string: a component halted mid-build keeps its BLOCKED status and was still parked, and
// re-reading prose to find that out is the defect shape `haltKind` exists to prevent.
const parkedComponents = ledger.filter((r) => r.parked === true);
const contestedTotal = ledger.reduce((s, r) => s + (r.contested || 0), 0);
const settledTotal = ledger.reduce((s, r) => s + (r.settled || 0), 0);
// Not halted means every component the run was asked to build passed its gate: the loop's only other exits
// all set `halted`, so there is no third outcome to name here.
const status = halted ? (HALT_STATUS[haltKind] || 'halted (component needs attention)') : 'done (MVP staged)';

log(`mvp: ${status} — ${doneIds.length}/${ALL_COMPONENTS.length} component(s) done [${ledger.reduce((s, r) => s + r.gateRounds, 0)} code-gate pass(es)]`);

return {
  phase: 'mvp',
  runId: RUN_ID,
  status,
  halted,
  haltReason: halted ? haltReason : '',
  stateDir: STATE_DIR,
  componentsDone: doneIds,
  componentsTotal: ALL_COMPONENTS.length,
  contestedDismissals: contestedTotal,
  settledDecisions: settledTotal,
  // Parked components: NOT done, but their work is SAVED, not lost. Present each with its patch path (and
  // strays dir when one exists — those need a second restore step).
  parked: parkedComponents.map((r) => ({ id: r.id, patch: r.patch ?? null, strays: r.strays ?? null, status: r.status })),
  ledger,
  reviewTrail: `Numbered review files in ${GATE_DIR}/ (code-review-<id>-rN.md) show every gate round — that directory is the blind gate's whole world, which is why nothing describing the goal lives in it; ${SETTLED} carries every call the builders settled themselves; git staging marks each accepted component.`,
  followups: `${halted ? `Run halted — ${haltReason} ` : ''}${parkedComponents.length
    ? `PARKED: ${parkedComponents.map((r) => r.id).join(', ')}. That work is saved to ${STATE_DIR}/parked-<id>.patch and cleared from the tree — nothing discarded; ${NEEDS_USER} carries the diagnosis and the verbatim \`git apply --3way\` restore command. Decide per component: restore the patch and finish it by hand, sharpen its block in ${COMPONENTS_PATH} and re-run from it with startAt, or drop the patch. `
    : ''}${doneIds.length ? `Staged/accepted: ${doneIds.join(', ')}. ` : ''}Verify the end state yourself: run the full gates, \`git -C ${REPO} diff --cached --stat\`, and \`git -C ${REPO} status --porcelain\` (should be clean). Read the code-review files, ${SETTLED} (every judgment call the builders made) and each DISMISSED-<id>.md in ${GATE_DIR}/, and surface ${NEEDS_USER}. Nothing is committed — you commit.`,
};
