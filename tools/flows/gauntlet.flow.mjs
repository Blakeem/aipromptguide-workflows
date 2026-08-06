// Flow-map scenarios for gauntlet-cycle — the MVP COMPONENT LOOP and the REFINE WAVE LOOP.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs gauntlet`; `--check` fails the gate while FLOW.md is stale.
//
// TWO loops in mvp, not one: an outer loop over `components` and an inner build -> BLIND code gate round
// loop per component, with STAGING (done by the code gate, this engine's only stager) as the boundary
// between them. The asymmetry to read off the map is the EXIT: unlike feature-cycle, a parked component
// STOPS the run — components decompose one product, so the next one builds on this one having landed
// (migrate's rule). So there is a component-BOUNDARY edge only on the happy path, and every other exit is
// terminal.
//
// REFINE is the same shape one level up: an outer loop over WAVES, an inner critic -> improve pass per
// still-open aspect, then ONE code-gate round loop over the whole wave diff. Its two ordinary endings
// (`done (all aspects closed)` and `cycles spent`) are what the mvp half has no equivalent of, and its two
// park statuses are deliberately its own — a parked wave leaves the MVP staged and intact, which a parked
// component does not.
//
// Three conditions share the ONE `park-unsafe` status, so HALT_STATUS coverage cannot tell them apart: a
// self-contradictory park report, a tree park could not clear, and red gates after clearing each need their
// own scenario or two of the three go untested behind a green count. The same is true of `wave-park-unsafe`.
//
// The build SELF-LOOP ('the gate never goes green') is the only build->build edge, the only round with no
// code gate spawned at all, and the only route to a park with no review file — parkPrompt's "produced NO
// review file" fallback exists for exactly it. Refine's equivalent is 'the wave gates never go green',
// where the improver runs on its own and no code gate is ever spawned for that wave.
//
// An UNSCRIPTED `park:` label returns `{}` from the harness, and `pk?.cleared !== true` then rewrites the
// halt to `park-unsafe` — so a scenario that reaches park without a PARK_* script silently tests a
// different branch than its name claims.
//
// Several refine scenarios reach a terminal some other scenario already covers (a saturation close, a
// contested settled line, an env fault from a critic, a dirty tree at the refine entry point). Coverage
// cannot see any of them — no new role, no throw, no new terminal — so they are here BECAUSE the assertions
// are blind to them, not despite it. Read the comment on each before deleting one as redundant.

const TARGET = { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' };
const GATES = { build: 'npm run build', test: 'npm test' };
const DOCS = { canonPath: 'plans/flow/CANON.md', barPath: 'plans/flow/BAR.md', componentsPath: 'plans/flow/COMPONENTS.md' };

// Two components, because the component loop and its boundary edge are invisible with one.
const COMPONENTS = [{ id: 'comp-a', gate: 'green' }, { id: 'comp-b', gate: 'green' }];
const base = { runId: 'flow', root: 'E:/flow', target: TARGET, gates: GATES, ...DOCS, components: COMPONENTS };
// One component, for the paths whose measured repeat count must be the round budget rather than
// maxRounds x components.
const solo = { ...base, components: [{ id: 'comp-a', gate: 'green' }] };

// REFINE-ONLY args: no componentsPath and no components at all. That is the entry-point shape — refine
// pointed at a product this run never built — and running every refine scenario under it is what proves
// the mvp inputs are not required. One scenario below passes the mvp payload as well, for the other order.
const ASPECTS = [{ id: 'aspect-a' }, { id: 'aspect-b' }];
const refine = {
  runId: 'flow', root: 'E:/flow', phase: 'refine', target: TARGET, gates: GATES,
  canonPath: DOCS.canonPath, barPath: DOCS.barPath, aspectsPath: 'plans/flow/ASPECTS.md',
  aspects: ASPECTS, cycles: 2,
};
// One wave, for the paths whose measured repeat count must be the GATE-round budget rather than
// maxGateRounds x waves.
const oneWave = { ...refine, cycles: 1 };

// Agent returns carrying every attestation the engine reads.
const BUILD_OK = { spec_obtained: true, baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, env_blocked: false, settled_appended: 1 };
const CLEAN    = { clean: true, issue_count: 0, staged: true, wrote_file: true, contested_dismissals: 0 };
const FLAGGED  = { clean: false, issue_count: 2, staged: false, wrote_file: true, contested_dismissals: 0 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };
const BEHIND   = { wrote_file: true, status: 'behind', gap_actionable: true, canon_violation: false, additive: false, contested_settled: 0, baseline_dirty_files: 0, env_blocked: false };
const ACHIEVED = { ...BEHIND, status: 'achieved' };
const IMPROVED = { build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, env_blocked: false, settled_appended: 1, gap_addressed: true, declined: false };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);
const firstWave  = (a, b) => (label) => (/w1$/.test(label) ? a : b);

export default {
  engine: 'workflows/gauntlet/gauntlet-cycle.mjs',
  out: 'workflows/gauntlet/FLOW.md',
  title: 'gauntlet-cycle',
  scenarios: [
    // ---- arg validation, in the order the engine checks it ---------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'no runId', when: 'args carry no runId at all', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow' } },
    {
      // A payload naming a third phase must not fall through to the mvp loop and rebuild what is already
      // staged. Both real phases are legal now, so the probe has to be a value that is neither.
      name: 'unknown phase',
      when: 'phase is neither "mvp" nor "refine"',
      args: { ...base, phase: 'polish' },
    },
    // One throw site serves every numeric bound, and it is checked BEFORE the phase-specific paths below,
    // so a garbage bound is rejected whatever else is missing. Without it a non-numeric maxRounds coerces
    // to NaN, the round loop never runs, and the first component parks having never spawned a builder.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    { name: 'no canon', when: 'args.canonPath is missing', args: { ...base, canonPath: undefined } },
    { name: 'no components file', when: 'args.componentsPath is missing', args: { ...base, componentsPath: undefined } },
    { name: 'no components array', when: 'args.components is missing or empty', args: { ...base, components: [] } },
    { name: 'component id is not a slug', when: 'a components entry id is not a kebab slug', args: { ...base, components: [{ id: 'Comp A!', gate: 'green' }] } },
    {
      // Two components sharing an id share one DISMISSED file and one review file, so the second
      // silently overwrites the first's code review and the gate reads the wrong ledger.
      name: 'duplicate component id',
      when: 'two components carry the same id',
      args: { ...base, components: [{ id: 'comp-a', gate: 'green' }, { id: 'comp-a', gate: 'green' }] },
    },
    { name: 'no build gate', when: 'args.gates.build is missing', args: { ...base, gates: { test: GATES.test } } },
    { name: 'no test gate for a green component', when: 'a component asks for gate:"green" with no test command', args: { ...base, gates: { build: GATES.build } } },
    { name: 'runOnly names no component', when: 'runOnly holds an unknown component id', args: { ...base, runOnly: ['nope'] } },
    { name: 'startAt names no component', when: 'startAt is an unknown component id', args: { ...base, startAt: 'nope' } },

    // ---- refine-only arg validation ----------------------------------------------------------------
    // Each of these is required ONLY under phase:"refine", which is what keeps every mvp payload above
    // untouched. They are checked in the order the engine checks them.
    { name: 'no aspects file', when: 'args.aspectsPath is missing under phase:"refine"', args: { ...refine, aspectsPath: undefined } },
    {
      // Optional in mvp, required here: refine IS the climb toward the bar, so without one every critic
      // substitutes its own taste and no wave can be compared to the last.
      name: 'no bar for a refine run',
      when: 'args.barPath is missing under phase:"refine"',
      args: { ...refine, barPath: undefined },
    },
    { name: 'no aspects array', when: 'args.aspects is missing or empty', args: { ...refine, aspects: [] } },
    { name: 'aspect id is not a slug', when: 'an aspects entry id is not a kebab slug', args: { ...refine, aspects: [{ id: 'Aspect A!' }] } },
    {
      // Two aspects sharing an id share one critique-<id>-wN.md, so the second overwrites the first and
      // its improver is handed the wrong gap.
      name: 'duplicate aspect id',
      when: 'two aspects carry the same id',
      args: { ...refine, aspects: [{ id: 'aspect-a' }, { id: 'aspect-a' }] },
    },
    {
      // The wave budget is the user's whole brake on a climb that has no natural end, so it has no
      // default: a number the engine picked would be a run length nobody chose to pay for.
      name: 'no cycles',
      when: 'args.cycles is missing under phase:"refine"',
      args: { ...refine, cycles: undefined },
    },
    { name: 'runOnly names no aspect', when: 'runOnly holds an unknown aspect id under phase:"refine"', args: { ...refine, runOnly: ['nope'] } },

    // ---- the round loop, one scenario per way out of it -------------------------------------------
    {
      // The component-BOUNDARY edge: comp-a stages, the baseline advances, comp-b starts. The ONLY exit
      // that reaches a second component.
      name: 'every component passes first time',
      when: 'the code gate is clean and stages',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      name: 'the code gate flags the first round',
      when: 'the blind code gate finds defects or structural debt',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': firstRound(FLAGGED, CLEAN), park: PARK_OK },
    },
    {
      // The build SELF-LOOP: a gate that is not green re-builds with NO code gate spawned, until the
      // round budget runs out and the component parks with no review file to point at.
      name: 'the gate never goes green',
      when: 'the build gate is never green',
      args: solo,
      respond: { build: { ...BUILD_OK, build_passed: false }, park: PARK_OK },
    },
    {
      // Park-and-STOP: comp-a burns its round budget and parks, and comp-b is never attempted.
      name: 'a component that never passes is parked',
      when: 'a component does not pass within its round budget',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': FLAGGED, park: PARK_OK },
    },

    {
      // ACCEPTED work with no staging boundary drawn: its own terminal, and the run STOPS rather than hand
      // the next component's builder a tree still holding this one's diff — which that builder's round-1
      // check would call a dirty baseline and blame the operator for. Nothing is parked; accepted work
      // never is, so this is the one halt that reaches a terminal with a component reported done.
      name: 'a clean gate that did not stage',
      when: 'the code gate passes clean but does not confirm staging',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': { ...CLEAN, staged: false } },
    },

    // ---- the halts --------------------------------------------------------------------------------
    {
      // Halts before the code gate is spawned, and does NOT park — that work is the operator's.
      name: 'dirty baseline',
      when: 'the tree was not clean on round 1',
      args: base,
      respond: { build: { ...BUILD_OK, baseline_dirty_files: 4 } },
    },
    {
      // The block command runs in the AGENT's shell, so this attestation is the only signal the spec ever
      // arrived. Without the halt, a denied command or an id matching no block builds something plausible
      // and the run reports the MVP as staged.
      name: 'builder never got its spec',
      when: 'the builder reports spec_obtained=false',
      args: base,
      respond: { build: { ...BUILD_OK, spec_obtained: false }, park: PARK_OK },
    },
    {
      // The ONE escalation this workflow has: everything else the builder settles itself.
      name: 'environment fault',
      when: 'the builder hits an environment fault it cannot resolve',
      args: base,
      respond: { build: { ...BUILD_OK, env_blocked: true }, park: PARK_OK },
    },
    {
      // A dead agent shares ONE terminal across both round-loop roles, and neither is visible to any other
      // assertion — no new role, no throw. Scripted separately so the map shows that the builder and the
      // code gate each halt on it, rather than only the first.
      name: 'the builder dies',
      when: 'the builder agent dies',
      args: base,
      respond: { build: null, park: PARK_OK },
    },
    {
      name: 'the code gate dies',
      when: 'the blind code gate dies',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': null, park: PARK_OK },
    },
    {
      name: 'park cannot clear the tree',
      when: 'park could not clear the tree',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': FLAGGED, park: { ...PARK_OK, cleared: false } },
    },
    {
      // saved=false with bytes on disk: the report is wrong, the patch is real.
      name: 'park report contradicts itself',
      when: 'park reports saved=false with bytes on disk',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': FLAGGED, park: { ...PARK_OK, saved: false, patch_bytes: 4096 } },
    },
    {
      name: 'red build after parking',
      when: 'the build gate is red after parking',
      args: base,
      respond: { build: BUILD_OK, 'code-gate': FLAGGED, park: { ...PARK_OK, gates_green: false } },
    },
    {
      // Without a budget the harness default is unlimited, which makes the floor dead code and this
      // terminal unreachable. Stateless on purpose: the scenario is run more than once.
      name: 'token budget floor',
      when: 'too few tokens left to start a component',
      args: base,
      budget: { total: 400_000, spent: () => 0, remaining: () => 40_000 },
      respond: {},
    },

    // ---- the refine wave loop ----------------------------------------------------------------------
    {
      // The whole climb: wave 1 finds both aspects behind and improves each, the wave diff clears the
      // blind gate and is STAGED, wave 2 finds both at the bar. The only route to `done`, and the only
      // one that shows the wave BOUNDARY edge (code-gate -> the next wave's critic).
      name: 'the climb closes every aspect',
      when: 'every aspect reaches the bar',
      args: refine,
      respond: { critic: firstWave(BEHIND, ACHIEVED), improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // The OTHER way an aspect closes, and it is invisible to coverage (same terminal as `achieved`):
      // every gap the critic can still see is already covered by a SETTLED.md line, so nothing here is
      // open. It spawns no improver at all — the wave changes nothing and no code gate runs.
      name: 'a saturated aspect closes with no improvement',
      when: 'every remaining gap is already settled',
      args: oneWave,
      respond: { critic: { ...BEHIND, status: 'saturated' }, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // refine handed the mvp payload as well: componentsPath and components are accepted and UNUSED.
      // The refine-only shape (no components at all) is what every other scenario here runs.
      name: 'refine continues an mvp run',
      when: 'refine is given the mvp payload too',
      args: { ...base, phase: 'refine', barPath: DOCS.barPath, aspectsPath: refine.aspectsPath, aspects: ASPECTS, cycles: 1 },
      respond: { critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // `aspects` is the runOnly-FILTERED list, so closing all of it is only the SLICE closing: its own
      // terminal, reported halted, because nothing outside the slice was ever critiqued. Sharing
      // `aspects-closed` said "stop, we're done" about a product with an aspect nobody looked at.
      name: 'a runOnly slice closes',
      when: 'every aspect of a runOnly slice closes',
      args: { ...oneWave, runOnly: ['aspect-a'] },
      respond: { critic: ACHIEVED, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // The user's brake, spent: aspects still open, everything staged, one arg resumes it. An ORDINARY
      // ending — a climb toward a bar has no natural end.
      name: 'the wave budget runs out',
      when: 'the cycles are spent with aspects still open',
      args: oneWave,
      respond: { critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // The wave's gate ROUND loop: the blind gate reviews the whole wave diff, the improver answers the
      // findings, the second round clears and stages.
      name: 'the wave code gate flags the first round',
      when: 'the code gate finds defects in the wave diff',
      args: oneWave,
      respond: { critic: BEHIND, improve: IMPROVED, 'code-gate': firstRound(FLAGGED, CLEAN), park: PARK_OK },
    },
    {
      // Two branches no assertion can see: the critic CONTESTS a settled line (the improver is told, and
      // its re-settlement is final), and the gap it names is an ADDITIVE feature (allowed only with the
      // evidenced UX win). Both change what the improver is handed, not where the run ends.
      name: 'the critic contests a settled line',
      when: 'a settled line does not hold against what the critic observed',
      args: oneWave,
      respond: { critic: { ...BEHIND, contested_settled: 1, additive: true }, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // The improve SELF-LOOP: the wave's gates are never green, so the code gate is NEVER spawned for
      // this wave — reviewing a diff that does not build spends an opus pass on what the gates already
      // reported. The only route to a wave park with no review file to point at.
      name: 'the wave gates never go green',
      when: 'an improvement leaves the gates red',
      args: oneWave,
      respond: { critic: BEHIND, improve: { ...IMPROVED, build_passed: false }, park: PARK_OK },
    },
    {
      name: 'a wave that never clears the gate is parked',
      when: 'the wave diff does not clear the code gate within maxGateRounds',
      args: oneWave,
      respond: { critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: PARK_OK },
    },
    {
      // One of the three conditions behind `wave-park-unsafe`; the other two (a self-contradictory report,
      // a red build after clearing) are asserted in tests/gauntlet.test.mjs, which is where mvp's three
      // are pinned to their reasons as well.
      name: 'park cannot clear the wave',
      when: 'park could not clear the wave diff',
      args: oneWave,
      respond: { critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: { ...PARK_OK, cleared: false } },
    },
    {
      // A dead critic must never read as "achieved" — that is a finished climb on an aspect nobody looked
      // at. Nothing is in the tree yet, so this one halts WITHOUT parking.
      name: 'the critic dies',
      when: 'the critic agent dies',
      args: oneWave,
      respond: { critic: null, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      name: 'the improver dies',
      when: 'the improver agent dies',
      args: oneWave,
      respond: { critic: BEHIND, improve: null, 'code-gate': CLEAN, park: PARK_OK },
    },
    {
      // The ONE escalation, reached from a refine role this time: same fault, same status as mvp's.
      name: 'the critic hits an environment fault',
      when: 'a refine agent hits an environment fault',
      args: oneWave,
      respond: { critic: { ...BEHIND, env_blocked: true }, improve: IMPROVED, park: PARK_OK },
    },
    {
      // refine is an ENTRY POINT, so no builder ran ahead of it to check — the first critic carries STEP 0
      // instead. The wave gate STAGES what it clears, so pre-existing work would be folded into the
      // accepted baseline. Halts having changed nothing, and parks NOTHING: that work is the operator's.
      name: 'dirty tree at the refine entry point',
      when: 'the tree was not clean when refine started',
      args: oneWave,
      respond: { critic: { ...BEHIND, baseline_dirty_files: 4 }, improve: IMPROVED, park: PARK_OK },
    },
    {
      // The wave floor, which stops between waves rather than mid-climb. Stateless: the scenario runs more
      // than once.
      name: 'token budget floor between waves',
      when: 'too few tokens left to start a wave',
      args: oneWave,
      budget: { total: 400_000, spent: () => 0, remaining: () => 40_000 },
      respond: {},
    },
  ],
};
