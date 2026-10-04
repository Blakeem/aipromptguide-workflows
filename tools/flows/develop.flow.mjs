// Flow-map scenarios for develop-cycle — the PLAN-FILE BUS shape, one block at a time.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs develop`; `--check` fails the gate while FLOW.md is stale.
//
// The park exit has TWO shapes: a BOUNDARY edge back into develop (the run carries on) and a TERMINAL
// (block N+1 depends on N). The `ordered` file key picks between them at run time, so each needs its own
// scenario: 'a parked block, and the run carries on' (ordered omitted) and 'an ordered run stops at a
// parked block' (ordered true). Nothing else in the map tells them apart.
//
// The tail is a `final-sweep` that re-greps the whole surface from the goal, and it runs only when
// the plan file asked for it AND every non-skip block is done. Three of the four end-of-run shapes are
// invisible to `out.status` — the dead sweep and the switched-off sweep both still say
// `done (all blocks staged)`, and a partial slice says `partial slice complete` whether a sweep was
// wanted or not — so only these scenarios can draw them.
//
// The develop SELF-LOOP ('the gate never goes green') is the only develop -> develop edge, the only round
// with NO reviewer spawned at all, and the only route to a park with no review file — parkPrompt's
// "produced NO review file" fallback exists for exactly it.
//
// Four halts collapse into ONE `park-unsafe` status, so HALT_STATUS coverage cannot tell them apart: a
// self-contradictory park report, a tree park could not clear, red gates after clearing, and a park agent
// that died. Each needs its own scenario or three of the four go untested behind a green count.
//
// An UNSCRIPTED `park:` label returns `{}` from the harness, and `pk?.cleared !== true` then rewrites the
// halt to `park-unsafe` — so a scenario that reaches park without a PARK_* script silently tests a
// different branch than its name claims.

const TARGET = { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' };
const GATES = { build: 'npm run build', test: 'npm test' };

// Two blocks, because the block loop and its boundary edge are invisible with one — and ONE OF EACH MODE,
// because the developer and acceptance frames switch on it (feature = wired in and reachable; section =
// every call site converted) and a single-mode table would never build the section frame.
const BLOCKS = [
  { id: 'block-a', mode: 'feature', gate: 'green' },
  { id: 'block-b', mode: 'section', gate: 'green' },
];
// The THIRD frame, kept out of BLOCKS so every scenario above stays a two-block run: a fix block's worker
// returns per-issue results instead of `produced`, and its two round-1 terminals are reachable from no
// other mode. Gate green is the only gate a fix block takes.
const FIX_BLOCK = { id: 'block-c', mode: 'fix', gate: 'green' };
const base = {
  runId: 'flow', root: 'E:/flow', target: TARGET, gates: GATES, planPath: 'plans/bus.md',
  goal: 'move every caller onto the new client', sweep: 'goal-coverage', plans: BLOCKS,
};

// Agent returns carrying every attestation the engine reads. `produced` gates the blind review, and
// `unstaged_confirmed` is a HALT here rather than a warning — hence its own scenario below.
const DEV_OK   = { baseline_dirty_files: 0, produced: true, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false, plan_amendments: 0 };
const CLEAN    = { clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { clean: false, issue_count: 2, contested_dismissals: 0 };
const ACC_PASS = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 3, criteria_met: 3, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL = { pass: false, staged: false, reachable: false, regression: false, criteria_total: 3, criteria_met: 1, evidence_recorded: true, gap_count: 2 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };
const SWEEP_OK = { complete: true, gaps: [], suite_result: 'green' };

// The fix frame's returns. `produced` is DERIVED from results here, so the status values below are what
// decide whether the blind reviewer is spawned at all.
const devFix = (results, extra) => ({ ...DEV_OK, produced: undefined, entries_found: results.length, results, ...extra });
const FIX_DONE   = devFix([{ issue_id: 'i-1', status: 'FIXED' }]);
const FIX_STALE  = devFix([{ issue_id: 'i-1', status: 'STALE' }]);
const FIX_SKIP   = devFix([{ issue_id: 'i-1', status: 'SKIPPED' }]);
const ACC_FIX    = { pass: true, staged: true, regression: false, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }], gap_count: 0, suite_result: 'green' };

// The clean full run every "what changes" scenario is a one-key edit of.
const GREEN_RUN = { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS, 'final-sweep': SWEEP_OK };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);

// The floor has to stop BETWEEN blocks, not before the first one: "block-a landed, block-b waits for a
// resume" is the branch, and a constant `remaining` only ever draws "nothing ran". The one per-run state a
// budget can see is the live `calls` array a respond function is handed, and a reference to it goes STALE
// the moment the run ends: read at the next run's FIRST check, it would stop that run before block-a and
// draw a different graph on the second pass. So the stop CONSUMES it, and every run starts clean. The
// engine reads the floor twice at the stop (the check, then the halt reason), so the low value is held for
// that one extra read. tests/flows.test.mjs generates this spec twice and compares bytes, which is what
// holds both invariants.
let live = null;
let stopReadsLeft = 0;
const budgetFloor = {
  total: 400_000,
  spent: () => 0,
  remaining: () => {
    if (stopReadsLeft > 0) { stopReadsLeft -= 1; return 40_000; }
    if (!live?.length) return 400_000;   // nothing has run yet in THIS run: block-a always starts
    live = null;
    stopReadsLeft = 1;
    return 40_000;
  },
};
const watch = (resp) => (label, prompt, calls) => { live = calls; return resp; };

export default {
  engine: 'workflows/develop/develop-cycle.mjs',
  out: 'workflows/develop/FLOW.md',
  title: 'develop-cycle',
  scenarios: [
    // ---- arg validation, in the order the engine checks it ---------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    // Checked FIRST, before the general guard: `plan-block.mjs --list` prints an OBJECT, so pasting that
    // straight in is the live typo. There is no back-compat path to fall through to here.
    { name: 'malformed plans', when: 'the --list object is pasted in whole', args: { ...base, plans: { blocks: BLOCKS } } },
    { name: 'no runId', when: 'a plans array arrives with no runId', args: { plans: BLOCKS } },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow', plans: BLOCKS } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow', plans: BLOCKS } },
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN, the
    // per-block round loop never runs, and every block parks having never spawned a developer.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },

    // The four FILE KEYS the operator copies off `--list`. Each is control input, and each throw exists
    // because the coerced reading is silently wrong: the string "false" is truthy, so a coerced `ordered`
    // flips park semantics without a word in any log line.
    { name: 'ordered is not a boolean', when: 'ordered is the string "false"', args: { ...base, ordered: 'false' } },
    { name: 'suite is not a known value', when: 'suite is outside green | scoped', args: { ...base, suite: 'all' } },
    { name: 'sweep is not a known value', when: 'sweep is outside goal-coverage | none', args: { ...base, sweep: 'always' } },
    { name: 'goal is not a string', when: 'goal is a number', args: { ...base, goal: 7 } },
    // The sweep re-derives its surface from the goal, so a goalless one would run with nothing to cover.
    { name: 'goal-coverage sweep with no goal', when: 'sweep is goal-coverage and goal is empty', args: { ...base, goal: '' } },

    // The per-entry validators, in engine order. Sibling engines FILTERED an id-less entry out silently,
    // so a mistyped key built a shorter roadmap than the operator asked for and reported success on it.
    { name: 'a plans entry has no id', when: 'a plans entry carries no id', args: { ...base, plans: [{ mode: 'feature' }] } },
    { name: 'block id is not a slug', when: 'a plans entry id is not a kebab slug', args: { ...base, plans: [{ id: 'Block A!', mode: 'feature' }] } },
    // A mode picks the developer and acceptance FRAMES, so an unrecognized one has no frame to build with.
    { name: 'block mode is not a valid mode', when: 'a block asks for an unknown mode', args: { ...base, plans: [{ id: 'block-a', mode: 'bogus' }] } },
    // A gate is legal only for its OWN mode: red-baseline is a section gate, and a feature block that got
    // it would be judged by a rule its frame never applies.
    { name: 'block gate is illegal for its mode', when: 'a feature block asks for gate red-baseline', args: { ...base, plans: [{ id: 'block-a', mode: 'feature', gate: 'red-baseline' }] } },
    { name: 'block status is not a known status', when: 'a block names an unknown status', args: { ...base, plans: [{ id: 'block-a', mode: 'feature', status: 'wip' }] } },
    { name: 'a pass is malformed', when: 'a pass entry is not mode fix with two or more members', args: { ...base, plans: [{ id: 'pass-a', mode: 'feature', blocks: [] }] } },
    // Every block's body lives in a plan FILE, addressed by id. With no path anywhere the developer would
    // be handed an empty plan reference and build nothing while reporting success.
    { name: 'no plan file for a block', when: 'no entry and no top-level planPath', args: { ...base, planPath: '' } },
    { name: 'duplicate block ids', when: 'two plans entries share one id', args: { ...base, plans: [BLOCKS[0], { ...BLOCKS[0] }] } },

    { name: 'no build gate', when: 'args.gates.build is missing', args: { ...base, gates: { test: GATES.test } } },
    // Shape first, ids second: `runOnly: "block-b"` would otherwise drop the scope silently and build
    // every todo block in the file.
    { name: 'runOnly is not an array', when: 'runOnly is a bare block id string', args: { ...base, runOnly: 'block-b' } },
    { name: 'runOnly names no block', when: 'runOnly holds an unknown block id', args: { ...base, runOnly: ['nope'] } },
    { name: 'startAt names no block', when: 'startAt is an unknown block id', args: { ...base, startAt: 'nope' } },
    // Scoped to the PENDING slice, unlike the siblings: an all-done relaunch must reach the nothing-to-run
    // terminal below rather than throw over a command this run would never execute.
    { name: 'no test gate for a green block', when: 'a todo block wants gate green with no test command', args: { ...base, gates: { build: GATES.build } } },

    // ---- the four end-of-run shapes, and the sweep that separates them ---------------------------
    {
      // The block-BOUNDARY edge: block-a stages, the baseline advances, block-b starts. Same
      // acceptance -> develop node pair as the retry below, and a different fact.
      name: 'every block accepts first time',
      when: 'every block accepts and the sweep runs',
      args: base,
      respond: GREEN_RUN,
    },
    {
      // A sweep that RAN AND DIED. `out.status` is still `done (all blocks staged)` — only `sweepFailed`
      // says the goal-coverage check is missing — so this path exists in the map on this scenario alone.
      name: 'the final sweep dies',
      when: 'the whole-goal sweep dies',
      args: base,
      respond: { ...GREEN_RUN, 'final-sweep': null },
    },
    {
      name: 'the sweep is switched off',
      when: 'sweep:none on a fully accepted run',
      args: { ...base, sweep: 'none' },
      respond: GREEN_RUN,
    },
    {
      // A slice can only judge the blocks it ran, so it reaches its own terminal with no sweep.
      name: 'a partial slice',
      when: 'runOnly builds a subset of the blocks',
      args: { ...base, runOnly: ['block-b'] },
      respond: GREEN_RUN,
    },
    {
      // An all-done relaunch is a legitimate operator state, not an error — the plan file's statuses say
      // the work landed. Nothing is spawned, so only this scenario can draw the terminal.
      name: 'nothing to run',
      when: 'no block still has status todo',
      args: { ...base, plans: BLOCKS.map((b) => ({ ...b, status: 'done' })) },
      respond: {},
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
      // The develop -> acceptance edge that exists on no other path: an empty diff has nothing to review,
      // so the blind stage is skipped and only acceptance can tell a legitimate no-op from a miss.
      name: 'the developer produced nothing',
      when: 'the developer changed no files',
      args: base,
      respond: { ...GREEN_RUN, develop: { ...DEV_OK, produced: false } },
    },
    {
      // The develop SELF-LOOP: a gate that is not green re-develops with NO reviewer spawned, until the
      // round budget runs out. The only route to a park with no review file.
      name: 'the gate never goes green',
      when: 'the block gate is never green',
      args: base,
      respond: { develop: { ...DEV_OK, build_passed: false }, park: PARK_OK },
    },

    // ---- park: the ONE exit whose shape the `ordered` file key decides ----------------------------
    {
      // Park-and-CONTINUE: block-a burns its rounds and parks; block-b then builds
      // against a tree the park cleared, and the run ends without halting.
      name: 'a parked block, and the run carries on',
      when: 'a block parks and ordered is false',
      args: base,
      respond: { ...GREEN_RUN, 'acceptance block-a': ACC_FAIL, acceptance: ACC_PASS, park: PARK_OK },
    },
    {
      // Park-and-STOP: the SAME park node reaches a terminal instead, because block-b
      // routinely needs block-a to have landed. Only `ordered` differs from the scenario above.
      name: 'an ordered run stops at a parked block',
      when: 'a block parks and ordered is true',
      args: { ...base, ordered: true },
      respond: { ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK },
    },

    // ---- fix mode: the third frame, and the two round-1 terminals only it can reach ---------------
    {
      // The ordinary fix path, drawn so the map shows a fix block running the SAME three roles the other
      // two modes do — the frames differ, the flow does not.
      name: 'a fix block closes its issues',
      when: 'a fix block fixes an issue and accepts',
      args: { ...base, plans: [FIX_BLOCK] },
      respond: { develop: FIX_DONE, quality: CLEAN, acceptance: ACC_FIX, 'final-sweep': SWEEP_OK },
    },
    {
      // A pass: two fix blocks from two plan files built by ONE developer, reviewer and verifier. The flow
      // is the fix block's; what differs is the status edits, one per member in its own file.
      name: 'a pass of two fix blocks closes its issues',
      when: 'a packed pass of two fix blocks fixes its issues and accepts',
      args: { ...base, plans: [{ id: 'block-c-plus-1', mode: 'fix', gate: 'green', blocks: [
        { id: 'block-c', planPath: 'E:/flow/plans/one.md', issues: ['i-1'] },
        { id: 'block-d', planPath: 'E:/flow/plans/two.md', issues: ['i-2'] },
      ] }] },
      respond: {
        develop: devFix([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FIXED' }]),
        quality: CLEAN,
        acceptance: { ...ACC_FIX, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: true }] },
        'final-sweep': SWEEP_OK,
      },
    },
    {
      // The block IS the inventory, so a block that printed no `### [` entries is a fix round with nothing
      // to fix. Halts before any reviewer spawns, and does NOT park — nothing was changed.
      name: 'a fix block has no issue entries',
      when: 'a fix block printed no issue entries',
      args: { ...base, plans: [FIX_BLOCK] },
      respond: { develop: devFix([]) },
    },
    {
      // ALL-STALE: every entry is claimed already closed. The empty diff skips the blind review, and
      // acceptance confirms each STALE claim before the block counts done.
      name: 'every issue is already fixed',
      when: 'every issue in a fix block is stale',
      args: { ...base, plans: [FIX_BLOCK] },
      respond: { develop: FIX_STALE, acceptance: ACC_FIX, 'final-sweep': SWEEP_OK },
    },
    {
      // NO-CHANGES, unordered: the same empty diff, a different outcome — every entry was SKIPPED, so the
      // issues stay open and the block never counts done. The run carries on to the next block.
      name: 'a fix block closes nothing, and the run carries on',
      when: 'a fix block closes nothing and ordered is false',
      args: { ...base, plans: [FIX_BLOCK, BLOCKS[0]] },
      respond: { ...GREEN_RUN, 'develop block-c': FIX_SKIP },
    },
    {
      // The SAME terminal, stopped: later blocks routinely need this one's fixes to have landed.
      name: 'an ordered run stops on a fix block that closes nothing',
      when: 'a fix block closes nothing and ordered is true',
      args: { ...base, ordered: true, plans: [FIX_BLOCK] },
      respond: { develop: FIX_SKIP },
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
      // The block keeps `done (staged)`; what stops is everything AFTER it, because that diff is now the
      // baseline every later block would be judged against.
      name: 'staged with a regression',
      when: 'acceptance stages while reporting a regression',
      args: base,
      respond: { ...GREEN_RUN, acceptance: { ...ACC_PASS, regression: true } },
    },
    {
      // The staged index is the one surface NEITHER reviewer looks at, so work the developer staged
      // itself is reviewed by nobody and then inherited as known-good. A halt, not a warning.
      name: 'the developer staged its own work',
      when: 'the developer will not confirm its work stayed unstaged',
      args: base,
      respond: { develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK },
    },
    {
      // The block command runs in the AGENT's shell, so this attestation is the only signal the block
      // ever arrived. Without the halt, a denied command or an id matching no block builds something
      // plausible and the run reports `done (staged)`.
      name: 'developer never got its block',
      when: 'the developer reports plan_obtained=false',
      args: base,
      respond: { develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK },
    },
    {
      name: 'acceptance never got its block',
      when: 'the acceptance verifier reports plan_obtained=false',
      args: base,
      respond: { ...GREEN_RUN, acceptance: { ...ACC_FAIL, plan_obtained: false }, park: PARK_OK },
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
      respond: { ...GREEN_RUN, quality: null, park: PARK_OK },
    },
    {
      name: 'the acceptance verifier dies',
      when: 'the acceptance verifier dies',
      args: base,
      respond: { ...GREEN_RUN, acceptance: null, park: PARK_OK },
    },
    {
      // Halts before any reviewer is spawned, and does NOT park — that work is the operator's, and
      // parking it would take their changes hostage.
      name: 'dirty baseline',
      when: 'the tree was not clean on round 1',
      args: base,
      respond: { develop: { ...DEV_OK, baseline_dirty_files: 4 } },
    },
    {
      name: 'developer escalates',
      when: 'the developer hits a user-only blocker in an unordered run',
      args: base,
      respond: { develop: { ...DEV_OK, needs_user: true }, park: PARK_OK },
    },
    {
      name: 'developer escalates in an ordered run',
      when: 'the developer hits a user-only blocker in an ordered run',
      args: { ...base, ordered: true },
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
      // A cleared tree is not a SAFE tree. This used to fold into the plain `parked` terminal because the
      // engine never read `gates_green`.
      name: 'red build after parking',
      when: 'the build is red after parking',
      args: base,
      respond: { ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false } },
    },
    {
      // Without a budget the harness default is unlimited, which makes the floor dead code and this
      // terminal unreachable. Stops cleanly BETWEEN blocks: block-a is accepted and staged, block-b is left
      // for a resume with startAt.
      name: 'token budget floor',
      when: 'too few tokens left to start the next block',
      args: base,
      budget: budgetFloor,
      respond: { ...GREEN_RUN, acceptance: watch(ACC_PASS) },
    },
    {
      // The runtime keeps a run's first 1,000 log lines, and 400 one-round blocks outgrow them even with
      // progress lines budgeted. Stops cleanly BETWEEN blocks, like the token floor.
      name: 'log line cap',
      when: 'the next status line could fall past the runtime\'s 1,000 kept log lines',
      args: { ...base, plans: Array.from({ length: 400 }, (_, i) => ({ id: `block-${i + 1}`, mode: 'feature', gate: 'green' })) },
      respond: GREEN_RUN,
    },
    {
      // A second route into the same terminal, which coverage cannot see: 322 one-round blocks leave room
      // for one status line, and the last block's 200 issue statuses need two, so the run skips the sweep.
      // One FIXED claim keeps the acceptance prompt the variant 'a fix block closes its issues' snapshots.
      name: 'log line cap before the sweep',
      when: 'the last block\'s status lines fell past the runtime\'s 1,000 kept log lines',
      args: { ...base, plans: [...Array.from({ length: 322 }, (_, i) => ({ id: `block-${i + 1}`, mode: 'feature', gate: 'green' })), FIX_BLOCK] },
      respond: {
        ...GREEN_RUN,
        [`develop ${FIX_BLOCK.id}`]: devFix(Array.from({ length: 200 }, (_, i) => ({ issue_id: `i-${i + 1}`, status: i ? 'FAILED' : 'FIXED' }))),
        [`acceptance ${FIX_BLOCK.id}`]: ACC_FIX,
      },
    },
  ],
};
