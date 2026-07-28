// Flow-map scenarios for migrate-cycle — the ORDERED SECTION LOOP shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs migrate`; `--check` fails the gate while FLOW.md is stale.
//
// READ THIS BESIDE tools/flows/feature.flow.mjs — the two engines are near-twins and the maps are meant
// to be compared. ONE difference carries the comparison: a PARKED section is a TERMINAL here. feature's
// park node has a `next item` edge back into develop (the roadmap carries on); migrate's park node only
// ever reaches an end state, because section N+1 routinely depends on N having landed. Two scenarios
// below park, and NEITHER shows sec-b starting.
//
// The other difference is the tail: a `final-sweep` re-greps the whole change surface from the goal. It
// runs on exactly one of the four end-of-run shapes scripted here. The other three — a partial slice,
// finalSweep:false, and a sweep that DIED — are invisible to `out.status`, which says
// `done (all sections staged)` / `partial slice complete` either way, so only these scenarios can draw
// them. The dead sweep is scripted second on purpose: it shares its terminal with four other scenarios,
// and only the first two conditions on a shared edge survive into the label.
//
// An UNSCRIPTED `park:` label returns `{}` from the harness, and `pk?.cleared !== true` at :778 then
// rewrites the halt to `park-unsafe` — so both `needs-user` and `parked` silently become `park-unsafe`
// without a PARK_* script, and three terminals collapse into one.

const TARGET = { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' };
const GATES = { build: 'npm run build', test: 'npm test' };

// Two sections, because the section loop and its boundary edge are invisible with one.
const SECTIONS = [
  { id: 'sec-a', title: 'A', gate: 'green' },
  { id: 'sec-b', title: 'B', gate: 'green' },
];
const base = { runId: 'flow', root: 'E:/flow', target: TARGET, gates: GATES, planPath: 'plans/goal.md', sections: SECTIONS };

// Agent returns carrying every attestation the engine reads. `produced` is migrate's own — it gates the
// blind review, and no other engine has it.
const DEV_OK   = { baseline_dirty_files: 0, produced: true, build_passed: true, test_outcome: 'passed', tests_run_count: 5, unstaged_confirmed: true, needs_user: false };
const CLEAN    = { clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { clean: false, issue_count: 2, contested_dismissals: 0 };
const ACC_PASS = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 3, criteria_met: 3, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL = { pass: false, staged: false, reachable: false, regression: false, criteria_total: 3, criteria_met: 1, evidence_recorded: true, gap_count: 2 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };
const SWEEP_OK = { complete: true, gaps: [], suite_result: 'green' };

// The clean full run every "what changes" scenario is a one-key edit of.
const GREEN_RUN = { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS, 'final-sweep': SWEEP_OK };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);

export default {
  engine: 'workflows/migrate/migrate-cycle.mjs',
  out: 'workflows/migrate/FLOW.md',
  title: 'migrate-cycle',
  scenarios: [
    // ---- arg validation, in the order the engine checks it ---------------------------------------
    { name: 'no plan reference', when: 'args carry neither runId nor a plan', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow', planPath: 'plans/goal.md' } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow', planPath: 'plans/goal.md' } },
    {
      // Passes the top-level check and is then emptied by the `s && s.id` filter that builds
      // ALL_SECTIONS — the only way to reach this throw.
      name: 'sections with no ids',
      when: 'every sections entry is missing its id',
      args: { ...base, sections: [{ title: 'A' }] },
    },
    { name: 'no build gate', when: 'args.gates.build is missing', args: { ...base, gates: { test: GATES.test } } },
    { name: 'no test gate for a green section', when: 'a section asks for gate:"green" with no test command', args: { ...base, gates: { build: GATES.build } } },
    { name: 'runOnly names no section', when: 'runOnly holds an unknown section id', args: { ...base, runOnly: ['nope'] } },
    { name: 'startAt names no section', when: 'startAt is an unknown section id', args: { ...base, startAt: 'nope' } },

    // ---- phase: refine (its own entry point; the return carries no status) ------------------------
    {
      name: 'refine the plan',
      when: 'phase:"refine"',
      args: { ...base, phase: 'refine' },
      respond: { 'plan-critic': { verdict: 'needs-changes', gaps: [{ title: 'sec-b converts no call site', evidence: 'src/db.js:12' }], questions: [] } },
      terminal: 'plan critique returned (refine stops here)',
    },
    { name: 'dead plan critic', when: 'the plan critic dies', args: { ...base, phase: 'refine' }, respond: { 'plan-critic': null } },

    // ---- phase: run — the three sweep paths, and the one that ran it -----------------------------
    {
      // The section-BOUNDARY edge: sec-a stages, the baseline advances, sec-b starts. Same
      // acceptance → develop node pair as the retry below, and a different fact.
      name: 'every section accepts first time',
      when: 'every section accepts and the sweep runs',
      args: base,
      respond: GREEN_RUN,
    },
    {
      // A sweep that RAN AND DIED. `out.status` is still `done (all sections staged)` — only `sweepFailed`
      // says the goal-coverage check is missing — so this path exists in the map on the strength of this
      // scenario alone.
      name: 'the final sweep dies',
      when: 'the whole-goal sweep dies',
      args: base,
      respond: { ...GREEN_RUN, 'final-sweep': null },
    },
    {
      name: 'the sweep is switched off',
      when: 'finalSweep:false on a fully accepted run',
      args: { ...base, finalSweep: false },
      respond: GREEN_RUN,
    },
    {
      // A slice can only judge the sections it ran, so it reaches its own terminal with no sweep.
      name: 'a partial slice',
      when: 'runOnly builds a subset of the sections',
      args: { ...base, runOnly: ['sec-a'] },
      respond: GREEN_RUN,
    },

    // ---- the round loop — one scenario per way back into develop ---------------------------------
    {
      name: 'quality flags the first round',
      when: 'the blind review finds defects',
      args: base,
      respond: { ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) },
    },
    {
      name: 'acceptance finds gaps, then passes',
      when: 'acceptance finds gaps',
      args: base,
      respond: { ...GREEN_RUN, acceptance: firstRound(ACC_FAIL, ACC_PASS) },
    },
    {
      // The develop → acceptance edge that exists on no other path: an empty diff has nothing to review,
      // so the blind stage is skipped and only acceptance can tell a legitimate no-op from a miss.
      name: 'the developer produced nothing',
      when: 'the developer changed no files',
      args: base,
      respond: { ...GREEN_RUN, develop: { ...DEV_OK, produced: false } },
    },
    {
      // The develop SELF-LOOP: a gate that is not green re-develops with NO reviewer spawned, until the
      // round budget runs out. The only route to a park with no review file — parkPrompt's "produced NO
      // review file" fallback exists for exactly it.
      name: 'the gate never goes green',
      when: 'the section gate is never green',
      args: base,
      respond: { develop: { ...DEV_OK, build_passed: false }, park: PARK_OK },
    },
    {
      // THE headline asymmetry with feature-cycle: park is a TERMINAL, not a boundary edge back into
      // develop. sec-b is never attempted — it depends on sec-a having landed.
      name: 'a section that never accepts is parked',
      when: 'a section does not accept within its round budget',
      args: base,
      respond: { ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK },
    },

    // ---- the remaining halts ---------------------------------------------------------------------
    {
      // Deliberately NOT parked: the work is good and one `git add` both preserves it and cleans the tree.
      name: 'passed but not staged',
      when: 'acceptance passes without staging',
      args: base,
      respond: { ...GREEN_RUN, acceptance: { ...ACC_PASS, staged: false } },
    },
    {
      // The section keeps `done (staged)`; what stops is everything AFTER it, because that diff is now the
      // baseline every later section would be judged against.
      name: 'staged with a regression',
      when: 'acceptance stages while reporting a regression',
      args: base,
      respond: { ...GREEN_RUN, acceptance: { ...ACC_PASS, regression: true } },
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
      respond: { ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, cleared: false } },
    },
    {
      // saved=false with bytes on disk: the report is wrong, the patch is real.
      name: 'park report contradicts itself',
      when: 'park reports saved=false with bytes on disk',
      args: base,
      respond: { ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, saved: false, patch_bytes: 4096 } },
    },
    {
      // The third park-unsafe cause. It used to fold into the plain `parked` terminal because the engine
      // never read `gates_green` — the diagram is what surfaced that, since feature drew three routes
      // into park-unsafe here and migrate only two.
      name: 'red build after parking',
      when: 'the build is red after parking',
      args: base,
      respond: { ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false } },
    },
    {
      // Without a budget the harness default is unlimited, which makes the floor dead code and this
      // terminal unreachable. Stateless on purpose: the scenario is run more than once.
      name: 'token budget floor',
      when: 'too few tokens left to start a section',
      args: base,
      budget: { total: 400_000, spent: () => 0, remaining: () => 40_000 },
      respond: {},
    },
  ],
};
