// Flow-map scenarios for feature-cycle — the ROADMAP BUILD LOOP shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs feature`; `--check` fails the gate while FLOW.md is stale.
//
// TWO loops, not one: an outer roadmap loop over `plans`, and an inner develop → blind quality →
// acceptance round loop per plan, with STAGING as the boundary between them. The asymmetry at the exit is
// what this table exists to draw — a parked plan lets the roadmap CONTINUE (park → develop, a plan
// BOUNDARY edge) while five other conditions stop the run outright.
//
// Three of those five share the ONE `park-unsafe` status, so HALT_STATUS coverage cannot tell them apart:
// a self-contradictory park report, a tree park could not clear, and red gates after clearing each need
// their own scenario or two of the three go untested behind a green count.
//
// The develop SELF-LOOP ('the gate never goes green') is the only develop→develop edge, the only round
// with NO reviewer spawned at all, and the only route to a park with no review file — parkPrompt's
// "produced NO review file" fallback exists for exactly it.
//
// An UNSCRIPTED `park:` label returns `{}` from the harness, and `pk?.cleared !== true` then rewrites the
// halt to `park-unsafe` — so a scenario that reaches park without a PARK_* script silently tests a
// different branch than its name claims.

const TARGET = { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' };
const GATES = { build: 'npm run build', test: 'npm test' };

// Two plans, because the roadmap loop and its plan-boundary edge are invisible with one.
const PLANS = [
  { id: 'plan-a', plan: '## Feature\nA', gate: 'green' },
  { id: 'plan-b', plan: '## Feature\nB', gate: 'green' },
];
const base = { runId: 'flow', root: 'E:/flow', target: TARGET, gates: GATES, plans: PLANS };
// The single top-level plan (no `plans` array). Its own terminal — `done (staged)` — and every `solo`
// field in the return hang off it, so back-compat is a path, not a footnote.
const solo = { runId: 'flow', root: 'E:/flow', target: TARGET, gates: GATES, planPath: 'plans/one.md', gate: 'green' };

// Agent returns carrying every attestation the engine reads.
const DEV_OK   = { baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false };
const CLEAN    = { clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { clean: false, issue_count: 2, contested_dismissals: 0 };
const ACC_PASS = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 3, criteria_met: 3, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL = { pass: false, staged: false, reachable: false, regression: false, criteria_total: 3, criteria_met: 1, evidence_recorded: true, gap_count: 2 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);

export default {
  engine: 'workflows/feature/feature-cycle.mjs',
  out: 'workflows/feature/FLOW.md',
  title: 'feature-cycle',
  scenarios: [
    // ---- arg validation, in the order the engine checks it ---------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN, the
    // per-plan round loop never runs, and every plan parks having never spawned a developer.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    { name: 'no plan reference', when: 'args carry neither runId nor a plan', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow', planPath: 'plans/one.md' } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow', planPath: 'plans/one.md' } },
    {
      // Passes the top-level check (a non-empty `plans` array) and is then emptied by the `p && p.id`
      // filter that builds ALL_PLANS — the only way to reach this throw.
      name: 'plans with no ids',
      when: 'every plans entry is missing its id',
      args: { ...base, plans: [{ planPath: 'plans/one.md' }] },
    },
    {
      // A roadmap of "## Plan: <id>" blocks with no file holding them. Each entry is legal on its own
      // (it has an id), so only the bodyless check catches it — otherwise the developer is handed an
      // empty plan and builds nothing while reporting success.
      name: 'roadmap blocks with no plan file',
      when: 'plans entries carry no body and there is no top-level planPath',
      args: { ...base, plans: [{ id: 'plan-a' }, { id: 'plan-b' }] },
    },
    { name: 'no build gate', when: 'args.gates.build is missing', args: { ...base, gates: { test: GATES.test } } },
    { name: 'no test gate for a green plan', when: 'a plan asks for gate:"green" with no test command', args: { ...base, gates: { build: GATES.build } } },
    { name: 'runOnly names no plan', when: 'runOnly holds an unknown plan id', args: { ...base, runOnly: ['nope'] } },
    { name: 'startAt names no plan', when: 'startAt is an unknown plan id', args: { ...base, startAt: 'nope' } },

    // ---- phase: refine (its own entry point; the return carries no status) ------------------------
    {
      name: 'refine the plan',
      when: 'phase:"refine"',
      args: { ...solo, phase: 'refine' },
      respond: { 'plan-critic': { verdict: 'needs-changes', gaps: [{ title: 'no wiring step', evidence: 'src/index.js:1' }], questions: [] } },
      terminal: 'plan critique returned (refine stops here)',
    },
    {
      // `plans` alone satisfies the top-level check, so without this guard refine would spawn the opus
      // critic against an EMPTY plan reference and get back a plausible verdict for a plan it never saw.
      name: 'refine handed a roadmap',
      when: 'phase:"refine" with only the plans array',
      args: { ...base, phase: 'refine' },
    },
    { name: 'dead plan critic', when: 'the plan critic dies', args: { ...solo, phase: 'refine' }, respond: { 'plan-critic': null } },

    // ---- phase: build — the round loop, one scenario per way out of it ----------------------------
    {
      // The plan-BOUNDARY edge: plan-a stages, the baseline advances, plan-b starts. Same acceptance →
      // develop node pair as the retry below, and a different fact.
      name: 'every plan accepts first time',
      when: 'acceptance passes and stages',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS },
    },
    {
      name: 'one plan, accepted',
      when: 'a single top-level plan accepts',
      args: solo,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS },
    },
    {
      name: 'quality flags the first round',
      when: 'the blind review finds defects',
      args: base,
      respond: { develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS },
    },
    {
      name: 'acceptance finds gaps, then passes',
      when: 'acceptance finds gaps',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) },
    },
    {
      // The develop SELF-LOOP: a gate that is not green resets reviewPath and re-develops with NO
      // reviewer spawned, until the round budget runs out. Single-plan on purpose, so the measured repeat
      // count is maxRounds rather than maxRounds × plans.
      name: 'the gate never goes green',
      when: 'the build gate is never green',
      args: solo,
      respond: { develop: { ...DEV_OK, build_passed: false }, park: PARK_OK },
    },
    {
      // Park-and-CONTINUE — the one roadmap-continues exit. plan-a burns its rounds and parks; plan-b
      // then builds against a tree the park cleared, and the run ends without halting.
      name: 'a plan that never accepts is parked',
      when: 'a plan does not accept within its round budget',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, 'acceptance plan-a': ACC_FAIL, acceptance: ACC_PASS, park: PARK_OK },
    },

    // ---- the six halts ---------------------------------------------------------------------------
    {
      // Deliberately NOT parked: the work is good and one `git add` both preserves it and cleans the tree.
      name: 'passed but not staged',
      when: 'acceptance passes without staging',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: { ...ACC_PASS, staged: false } },
    },
    {
      // The plan keeps `done (staged)`; what stops is everything AFTER it, because that diff is now the
      // baseline every later plan would be judged against.
      name: 'staged with a regression',
      when: 'acceptance stages while reporting a regression',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: { ...ACC_PASS, regression: true } },
    },
    {
      name: 'plan id is not a slug',
      when: 'a plans entry id is not a kebab slug',
      args: { ...base, plans: [{ id: 'Plan A!', plan: '## Feature — A' }] },
    },
    {
      // The block command runs in the AGENT's shell, so this attestation is the only signal the plan
      // ever arrived. Without the halt, a denied command or an id matching no block builds something
      // plausible and the run reports `done (staged)`.
      name: 'developer never got its plan',
      when: 'the developer reports plan_obtained=false',
      args: base,
      respond: { develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK },
    },
    {
      name: 'acceptance never got its plan',
      when: 'the acceptance verifier reports plan_obtained=false',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: { ...ACC_FAIL, plan_obtained: false }, park: PARK_OK },
    },
    {
      // A dead agent shares ONE terminal across all three round-loop roles, and none of the three is
      // visible to any other assertion — no new role, no throw. Scripted separately so the map shows
      // that develop, quality and acceptance each halt on it rather than only the first.
      name: 'the developer dies',
      when: 'the developer agent dies',
      args: base,
      respond: { develop: null, park: PARK_OK },
    },
    {
      name: 'the quality reviewer dies',
      when: 'the blind quality reviewer dies',
      args: base,
      respond: { develop: DEV_OK, quality: null, acceptance: ACC_PASS, park: PARK_OK },
    },
    {
      name: 'the acceptance verifier dies',
      when: 'the acceptance verifier dies',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: null, park: PARK_OK },
    },
    {
      // Halts before any reviewer is spawned, and does NOT park — that work is the operator's.
      name: 'dirty baseline',
      when: 'the tree was not clean on round 1',
      args: base,
      respond: { develop: { ...DEV_OK, baseline_dirty_files: 4 } },
    },
    {
      name: 'developer escalates',
      when: 'the developer hits a user-only blocker',
      args: base,
      respond: { develop: { ...DEV_OK, needs_user: true }, park: PARK_OK },
    },
    {
      name: 'park cannot clear the tree',
      when: 'park could not clear the tree',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: ACC_FAIL, park: { ...PARK_OK, cleared: false } },
    },
    {
      // saved=false with bytes on disk: the report is wrong, the patch is real.
      name: 'park report contradicts itself',
      when: 'park reports saved=false with bytes on disk',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: ACC_FAIL, park: { ...PARK_OK, saved: false, patch_bytes: 4096 } },
    },
    {
      name: 'red build after parking',
      when: 'the build gate is red after parking',
      args: base,
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false } },
    },
    {
      // Without a budget the harness default is unlimited, which makes the floor dead code and this
      // terminal unreachable. Stateless on purpose: the scenario is run more than once.
      name: 'token budget floor',
      when: 'too few tokens left to start a plan',
      args: base,
      budget: { total: 400_000, spent: () => 0, remaining: () => 40_000 },
      respond: {},
    },

    // ---- the partial slice: a SUCCESS path, distinct from the two id-validation throws ------------
    {
      name: 'a partial slice',
      when: 'runOnly builds a subset of the roadmap',
      args: { ...base, runOnly: ['plan-b'] },
      respond: { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS },
    },
  ],
};
