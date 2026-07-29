// Flow-map scenarios for debug/resolve-cycle — the BATCHED FIX LOOP shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs resolve`; `--check` fails the gate while FLOW-resolve.md is stale.
//
// FLOW-resolve.md, not FLOW.md: review.mjs owns FLOW-review.md in the same directory — two engines, two
// runs, with a deliberately non-automatic triage conversation between them.
//
// READ THIS BESIDE tools/flows/feature.flow.mjs and tools/flows/migrate.flow.mjs — the third build-loop
// sibling, and the one nothing can check for you. resolve returns NO `status` key and has NO HALT_STATUS
// map, so every terminal below is DECLARED (gen-flows' TERMINAL IDENTITY rule 2) and flow-coverage's
// terminal assertion is SKIPPED for this engine. This table is therefore the only thing that can catch a
// missing outcome: an unscripted exit does not fail a count, it simply never appears. The labels are the
// engine's own `record.status` strings so the map reads back against the returned ledger — except the
// three park exits, which share one status and are three different run outcomes.
//
// The budget stop is the worst case: it breaks BEFORE the batch record exists (:470-473 vs :479), so the
// batch it skipped leaves NO trace in the return — `halted` stays false and the ledger is simply shorter
// than the batch list nobody outside the engine has. Its `terminal` label is the only thing that names
// it, and its `budget` has to stop BETWEEN batches (see `budgetFloor`).
//
// NOT scripted, because it is UNREACHABLE: `needs-attention (loop end)` (:654). The park block at :629
// sets a status unconditionally at :639, and every loop exit that skips park sets its own — the four
// precondition/staging halts leave `escalated === false` (so `preconditionHalt` holds), the escalation
// halt sets `escalated = true` and park overwrites `BLOCKED` with `BLOCKED (parked)`, and the all-stale
// shortcut and the acceptance pass set theirs. :654 is a defensive default with no live path; removing
// engine code is not this table's call.

const TARGET = { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' };
const GATES = { build: 'npm run build', test: 'npm test' };

// Two issues in two areas, each at the batcher's LOC cap, so they land in SEPARATE batches: the batch
// loop and its boundary edge are invisible with one batch (batches serialize because staging does).
const issue = (id, unit, file) => ({
  id, unit, file, line: '1', loc: 2000,
  severity: 'high', category: 'correctness', decision: 'ACTIONABLE', effort: 'small',
  title: `defect ${id}`, theme: 'null-guards',
});
const I1 = issue('i1', 'u-a', 'src/a/one.js');
const I2 = issue('i2', 'u-b', 'src/b/two.js');

const base = { runId: 'flow', root: 'E:/flow', target: TARGET, gates: GATES, conventions: 'zero dependencies; LF only', issues: [I1, I2] };
// ONE batch, for every loop and halt scenario: with two, a measured repeat count is maxRounds × batches
// and reads as a loop the engine does not have.
const one = { ...base, issues: [I1] };

// Agent returns carrying every attestation the engine reads — the two round-1 preconditions included.
// Both ids ride in `results` so one constant serves either batch; each batch keeps only its own
// (`statusById.has` drops the rest).
const fixed = (id) => ({ issue_id: id, status: 'FIXED', files_changed: [], summary: 'root cause closed' });
const FIX_OK   = { baseline_dirty_files: 0, issue_entries_found: 1, unstaged_confirmed: true, needs_user: false, build_passed: true, test_outcome: 'passed', dismissed_count: 0, results: [fixed('i1'), fixed('i2')] };
const CLEAN    = { clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { clean: false, issue_count: 2, contested_dismissals: 0 };
const ACC_PASS = { pass: true, staged: true, regression: false, gap_count: 0, suite_result: 'green', fix_checks: [] };
const ACC_FAIL = { pass: false, staged: false, regression: false, gap_count: 2, suite_result: 'green', fix_checks: [] };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);

// The floor has to stop BETWEEN batches, not before the first one — "batch 1 landed, batch 2 waits for a
// resume" is the branch, and a constant `remaining` only ever draws "nothing ran". The one per-run state
// a budget can see is the live `calls` array the responder is handed, and a reference to it goes STALE
// the moment the run ends: read it at the next run's FIRST check and that run stops before batch 1,
// silently drawing a different graph on the second pass. So the reference is CONSUMED the single time it
// is used to stop, leaving every run to start from a clean slate. tests/flows.test.mjs generates this
// spec twice and compares bytes, which is what holds that invariant.
let live = null;
const budgetFloor = {
  total: 400_000,
  spent: () => 0,
  remaining: () => {
    if (!live?.length) return 400_000;   // nothing has run yet in THIS run: batch 1 always starts
    live = null;
    return 40_000;
  },
};
const watch = (resp) => (label, prompt, calls) => { live = calls; return resp; };

export default {
  engine: 'workflows/debug/resolve-cycle.mjs',
  out: 'workflows/debug/FLOW-resolve.md',
  title: 'debug/resolve-cycle',
  scenarios: [
    // ---- arg validation, in the order the engine checks it ---------------------------------------
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN, the
    // repair loop never runs, and every batch comes back needs-attention with no fixer ever spawned.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...one, maxRounds: 'three' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'no issues', when: 'args.issues is missing', args: { runId: 'flow', root: 'E:/flow', target: TARGET } },
    { name: 'no build gate', when: 'args.gates.build is missing', args: { ...one, gates: { test: GATES.test } } },
    { name: 'no test gate', when: 'args.gates.test is missing', args: { ...one, gates: { build: GATES.build } } },
    {
      // Triage skipped everything: the inventory is non-empty, the OPEN set is not. Fixing nothing is
      // never a successful run — the main agent handed over a batch it had already emptied.
      name: 'nothing actionable',
      when: 'triage left no ACTIONABLE issue at the fix floor',
      args: { ...one, issues: [{ ...I1, decision: 'SKIP' }] },
    },

    // ---- the batch loop ---------------------------------------------------------------------------
    {
      // The batch BOUNDARY edge: batch-01 stages, the baseline advances, batch-02 starts. Same
      // acceptance → fix node pair as the retry rounds below, and a different fact.
      name: 'every batch accepts first time',
      when: 'both batches accept and stage',
      args: base,
      respond: { fix: FIX_OK, quality: CLEAN, accept: ACC_PASS },
      terminal: 'accepted',
    },
    {
      // Two different FACTS, not one: every issue was already fixed in current code (verify-first did its
      // job) versus a batch that produced nothing because its issues were skipped.
      name: 'every issue is stale',
      when: 'verify-first finds every issue already fixed',
      args: one,
      respond: { fix: { ...FIX_OK, results: [{ issue_id: 'i1', status: 'STALE', summary: 'already fixed' }] } },
      terminal: 'all-stale',
    },
    {
      name: 'nothing produced',
      when: 'the fixer produced no change at all',
      args: one,
      respond: { fix: { ...FIX_OK, results: [{ issue_id: 'i1', status: 'SKIPPED', summary: 'not reproducible' }] } },
      terminal: 'no-changes',
    },
    {
      // The gate-red RETRY: the only fix → fix self-edge, and the only post-fixer path that spawns no
      // blind reviewer at all — a red gate has nothing worth reviewing yet.
      name: 'the gate is red, then green',
      when: 'the gate is red on round 1',
      args: one,
      respond: { fix: firstRound({ ...FIX_OK, build_passed: false }, FIX_OK), quality: CLEAN, accept: ACC_PASS },
      terminal: 'accepted',
    },
    {
      // The same self-edge at the round budget: :582 breaks to park instead of re-fixing, so this is the
      // one route to a park with no review file.
      name: 'the gate never goes green',
      when: 'the gate is never green',
      args: one,
      respond: { fix: { ...FIX_OK, build_passed: false }, park: PARK_OK },
      terminal: 'parked',
    },
    {
      name: 'quality flags the first round',
      when: 'the blind review finds defects',
      args: one,
      respond: { fix: FIX_OK, quality: firstRound(FLAGGED, CLEAN), accept: ACC_PASS },
      terminal: 'accepted',
    },
    {
      name: 'acceptance finds gaps, then passes',
      when: 'acceptance finds gaps',
      args: one,
      respond: { fix: FIX_OK, quality: CLEAN, accept: firstRound(ACC_FAIL, ACC_PASS) },
      terminal: 'accepted',
    },

    // ---- the three park exits — one status, three run outcomes, no assertion can tell them apart ---
    {
      name: 'a batch that never accepts is parked',
      when: 'a batch does not accept within its round budget',
      args: one,
      respond: { fix: FIX_OK, quality: CLEAN, accept: ACC_FAIL, park: PARK_OK },
      terminal: 'parked',
    },
    {
      // saved=false with bytes on disk: the report is wrong, the patch is real. Halts so a human looks
      // before the next batch builds on top of it.
      name: 'park report contradicts itself',
      when: 'park reports saved=false with bytes on disk',
      args: one,
      respond: { fix: FIX_OK, quality: CLEAN, accept: ACC_FAIL, park: { ...PARK_OK, saved: false, patch_bytes: 4096 } },
      terminal: 'parked (run HALTED: park report contradicts itself)',
    },
    {
      name: 'red gates after parking',
      when: 'the gates are red after the tree is cleared',
      args: one,
      respond: { fix: FIX_OK, quality: CLEAN, accept: ACC_FAIL, park: { ...PARK_OK, gates_green: false } },
      terminal: 'parked (run HALTED: gates red after clearing)',
    },

    // ---- the halts ---------------------------------------------------------------------------------
    {
      // The one halt that DOES park: the fixer's work is real and in the tree, so it is saved and cleared
      // before the run stops. `BLOCKED` at :556 is overwritten by park at :639.
      name: 'fixer escalates',
      when: 'the fixer hits a user-only blocker',
      args: one,
      respond: { fix: { ...FIX_OK, needs_user: true }, park: PARK_OK },
      terminal: 'BLOCKED (parked)',
    },
    {
      // Round-1 precondition, halting before any reviewer spawns and changing nothing — so it does NOT
      // park: that work is the operator's.
      name: 'dirty baseline',
      when: 'the tree was not clean on round 1',
      args: one,
      respond: { fix: { ...FIX_OK, baseline_dirty_files: 4 } },
      terminal: 'BLOCKED (dirty baseline)',
    },
    {
      // The other round-1 precondition. Without it the fixer reports every issue STALE against inventory
      // files that are not there, and the run ends reporting false success.
      name: 'inventory not found',
      when: 'the fixer finds no issue block in the inventory',
      args: one,
      respond: { fix: { ...FIX_OK, issue_entries_found: 0, results: [{ issue_id: 'i1', status: 'STALE', summary: '' }] } },
      terminal: 'BLOCKED (inventory not found)',
    },
    {
      // A DEAD round-1 fixer: neither precondition was checked, so no work can be assumed either way.
      // The -1 sentinels below it mean "round 2+, not applicable" and must never absorb this case.
      name: 'dead round-1 fixer',
      when: 'the round-1 fixer returns nothing',
      args: one,
      respond: { fix: null },
      terminal: 'BLOCKED (fixer did not return)',
    },
    {
      // Neither review layer looks at the staged index, so content the fixer staged itself would reach
      // the user's commit unseen. Park is skipped by design — it may not touch the staged baseline.
      name: 'staging contract violated',
      when: 'the fixer never attests its work is unstaged',
      args: one,
      respond: { fix: { ...FIX_OK, unstaged_confirmed: false } },
      terminal: 'BLOCKED (staging contract violated)',
    },
    {
      // Stops cleanly BETWEEN batches: batch-01 is accepted and staged, batch-02 is left for a resume.
      // The skipped batch never reaches the ledger and `halted` is false, so the return of a run that
      // stopped short is shaped exactly like the return of a run that had less to do.
      name: 'token budget floor',
      when: 'too few tokens left to start the next batch',
      args: base,
      budget: budgetFloor,
      respond: { fix: watch(FIX_OK), quality: CLEAN, accept: ACC_PASS },
      terminal: 'stopped on token budget (resume where it left off)',
    },
  ],
};
