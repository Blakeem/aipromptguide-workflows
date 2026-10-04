// develop/develop-cycle.mjs — the plan-file bus loop.
// Focus: the failure paths ported from tests/feature.test.mjs and tests/migrate.test.mjs, plus the
// behaviors that exist ONLY in the merge: the `ordered` file key deciding whether a park stops the run,
// the todo filter and its nothing-to-run terminal, the `suite` file key inside gateOk, and the sweep's
// pre-done + this-run union. The happy path is exercised by real runs; halts, parks, dead agents,
// contradictory returns and bad args are what rot silently (tests/CLAUDE.md §6).
//
// Deliberately NOT duplicated here, because each is a CROSS-ENGINE table a per-engine copy would drift
// from: the missing-arg sweep and the miscopied-enum values (required-args.test.mjs), the per-role
// dead-agent sweep (dead-agent.test.mjs), and role/throw/terminal coverage (flow-coverage.test.mjs).
// The dead-agent cases kept below assert what that sweep cannot see: guard ordering, the next round
// never spawning, and a round-2 death.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/develop/develop-cycle.mjs';

// Two blocks, ONE OF EACH MODE: the developer and acceptance frames switch on it, and a single-mode
// table would never build the section frame. Both build-only, so the gate sections below can pick their
// own gate without fighting this baseline.
const BLOCKS = [{ id: 'block-a', mode: 'feature', gate: 'build-only' },
  { id: 'block-b', mode: 'section', gate: 'build-only' }];
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' },
  planPath: 'E:/plans/bus.md', plans: BLOCKS };
const ONE_BLOCK = { ...baseArgs, plans: [BLOCKS[0]] };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// Mirrors tools/flows/develop.flow.mjs, so "a healthy return" has one definition per engine.
const DEV_OK   = { baseline_dirty_files: 0, produced: true, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false, plan_amendments: 0 };
const CLEAN    = { clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { clean: false, issue_count: 2, contested_dismissals: 0 };
const ACC_PASS = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 3, criteria_met: 3, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL = { pass: false, staged: false, reachable: false, regression: false, criteria_total: 3, criteria_met: 1, evidence_recorded: true, gap_count: 2 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };
const SWEEP_OK = { complete: true, gaps: [], suite_result: 'green' };
const GREEN_RUN = { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);
const syncOf = (out) => out.statusSync.map((e) => `${e.id}=${e.value}`).join(',');

// ---------------------------------------------------------------------------------------------
// Round preconditions, in the order the engine checks them
// ---------------------------------------------------------------------------------------------
section('a dirty baseline halts before any reviewer, and never parks the operator\'s work');
// Parking here would take the operator's own uncommitted changes hostage, and nothing was built anyway.
{
  const { out, calls, labels } = await run({ develop: { ...DEV_OK, baseline_dirty_files: 4 } });
  eq(calls.length, 1, 'only the developer ran, no reviewer spawned');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park the operator\'s changes');
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'status');
  eq(out.parked.length, 0, 'nothing in parked[]');
  ok(/4 file\(s\)/.test(out.haltReason), 'halt reason names the count');
  ok(/add -A/.test(out.haltReason) && /stash/.test(out.haltReason), 'and gives both remedies');
  // A killed run never parks, so its unreviewed block is also dirt here. `git add -A` on it would fold
  // code no reviewer passed into the accepted baseline.
  ok(/add -A` to KEEP it when it is your own pre-existing edits/.test(out.haltReason),
    'git add -A is limited to the operator\'s own edits');
  ok(/interrupted develop run's unfinished block, never `git add -A` it/.test(out.haltReason),
    'and an interrupted run\'s block is named as the case never to keep');
}
{
  // A developer that stops on a dirty tree never runs its block command, so it honestly reports
  // plan_obtained=false. Read first, that halt parks and clears the operator's work.
  const { out, labels } = await run({ develop: { ...DEV_OK, plan_obtained: false, baseline_dirty_files: 3 }, park: PARK_OK });
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'dirty-baseline outranks plan_obtained=false');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park the operator\'s changes');
  eq(out.parked.length, 0, 'nothing in parked[]');
}

section('the clean-baseline guard reads the VALUE, not what Number() makes of it');
// `Number(undefined)` is NaN and warns, but `Number(null)`, `Number(false)`, `Number('')` and
// `Number([])` are all 0 and all FINITE, so a coercing check reads every one of them as "0 = clean" and
// waves the precondition through silently. After that the blind reviewer judges the operator's
// pre-existing work as this block's and acceptance stages it into the accepted baseline.
{
  for (const bad of [null, false, '', []]) {
    const { logs } = await run({ ...GREEN_RUN, develop: { ...DEV_OK, baseline_dirty_files: bad } });
    ok(logs.some((l) => /precondition was NOT verified/.test(l)),
      `${JSON.stringify(bad)} is not silently a clean tree`);
  }
}

section('an agent that never got its block halts the run, developer and acceptance alike');
// The block command runs in the AGENT's shell and the harness has no tools, so this attestation is the
// only signal the block ever arrived. Without the halt a denied command, or an id matching no block,
// builds something plausible and the run reports `done (staged)`.
{
  const { out, labels } = await run({ develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK });
  ok(!labels.some((l) => l.startsWith('quality')), 'no reviewer was spawned on a block nobody read');
  eq(out.status, 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)', 'status');
  ok(/Developer for block block-a/.test(out.haltReason), 'halt reason names the role and the block');
  ok(labels.includes('park:block-a'), 'its work is PARKED, not abandoned in the tree');
}
{
  // The verifier's sibling channel: a pass=false here would otherwise read as an ordinary gap and park
  // the block, hiding "the spec never arrived" behind a routine round-budget failure.
  const { out, labels } = await run({
    ...GREEN_RUN, acceptance: { ...ACC_FAIL, plan_obtained: false }, park: PARK_OK,
  });
  eq(out.status, 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)', 'status');
  ok(/Acceptance verifier for block block-a/.test(out.haltReason), 'halt reason names the role');
  ok(!labels.some((l) => l.includes('block-b')), 'the run stopped, block-b never started');
}

section('the staging attestation is READ: false and a MISSING field both halt, true does not');
// The staged index is the one surface NEITHER reviewer looks at: the blind critic scopes on `git diff`
// and acceptance treats `git diff --staged` as the accepted baseline. Work the developer staged itself
// is reviewed by nobody and then inherited as known-good. This was a warn-only line for months, which is
// attestation theater with a log message attached.
{
  const { unstaged_confirmed, ...DEV_NO_ATTEST } = DEV_OK;
  for (const [what, dev] of [['false', { ...DEV_OK, unstaged_confirmed: false }], ['omitted', DEV_NO_ATTEST]]) {
    const { out, labels } = await run({ ...GREEN_RUN, develop: dev, park: PARK_OK });
    eq(out.status, 'BLOCKED (the developer did not confirm its work stayed unstaged - the staged index is surface neither reviewer checks; inspect git diff --cached before resuming)',
      `unstaged_confirmed ${what} halts`);
    ok(!labels.some((l) => l.startsWith('quality')), 'and halts BEFORE any review agent spawns');
    ok(labels.includes('park:block-a'), 'its work is parked rather than left in the tree');
  }
  const green = await run(GREEN_RUN);
  ok(green.out.halted === false, 'unstaged_confirmed true does not halt');
}

section('a DEAD developer halts agent-dead, never staging-unconfirmed');
// POSITION IS LOAD-BEARING: `null` also fails `unstaged_confirmed !== true`, so the staging guard has to
// sit after the dead-agent guard or every dead developer is reported as a staging violation and the
// operator inspects a staged index nobody wrote to.
{
  const { out } = await run({ develop: null, park: PARK_OK });
  eq(out.status, 'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)', 'status');
  ok(/Developer for block block-a returned nothing/.test(out.haltReason), 'the reason names the death');
  ok(!/stayed UNSTAGED/.test(out.haltReason), 'and not the staging attestation');
  eq(out.ledger[0].status, 'BLOCKED (agent died)', 'the ledger says the agent died');
}

section('a developer that produced nothing skips the blind review, not acceptance');
// An empty diff has nothing to review, but only acceptance can tell a legitimate no-op block from one
// that should have changed files.
{
  const { out, labels } = await run({ ...GREEN_RUN, develop: { ...DEV_OK, produced: false } });
  ok(!labels.some((l) => l.startsWith('quality')), 'no blind reviewer for an empty diff');
  eq(labels.filter((l) => l.startsWith('acceptance')).length, 2, 'acceptance still judged both blocks');
  eq(out.status, 'done (all blocks staged)', 'a genuine no-op block can still pass');
}
{
  // The flagged half of `reviewOwed`: `produced` is per-ROUND while the unstaged diff is
  // CUMULATIVE, so a round that DROPs every finding reports produced=false over a diff the critic already
  // rejected. Skipping the gate on that stages actively-flagged code with no re-review.
  const { out, labels } = await run({
    develop: firstRound(DEV_OK, { ...DEV_OK, produced: false }),
    quality: firstRound(FLAGGED, CLEAN),
    acceptance: ACC_PASS,
  }, ONE_BLOCK);
  eq(labels.filter((l) => l.startsWith('quality')).length, 2,
    'a flagged block is re-reviewed even when the next round produces nothing');
  eq(out.status, 'done (all blocks staged)', 'and accepts once the critic re-clears it');
}
{
  // The never-reviewed half: round 1 produced over a red gate, so the loop continued before any review.
  // Round 2 only re-ran the gate and reports produced=false, yet round 1's diff is still unreviewed.
  const { out, labels } = await run({
    develop: firstRound({ ...DEV_OK, build_passed: false }, { ...DEV_OK, produced: false }),
    quality: CLEAN,
    acceptance: ACC_PASS,
  }, ONE_BLOCK);
  const qualityAt = labels.indexOf('quality block-a r2');
  ok(qualityAt >= 0, 'the blind critic reviews round 1\'s work in round 2');
  ok(qualityAt < labels.indexOf('acceptance block-a r2'), 'before acceptance can stage it');
  eq(out.status, 'done (all blocks staged)', 'and the block accepts once reviewed');
}

section('fix mode: a later round cannot withdraw an earlier round\'s claimed fix from acceptance');
// The ledger holds the LATEST status per issue, but the acceptance verifier's claim list is MONOTONIC.
// The fixer re-verifies every entry each round, so in round 2 it reads its own round-1 fix and honestly
// reports STALE. A last-write-wins claim list would empty on that, leaving the root-cause re-derivation
// — the entire verification substance of the fix frame — with nothing to iterate over while round 1's
// unstaged diff is still there to be staged.
{
  const FIX_BLOCK = { ...baseArgs, plans: [{ id: 'fix-a', mode: 'fix', gate: 'green' }] };
  const DEV_FIXED = { ...DEV_OK, entries_found: 1, results: [{ issue_id: 'i-1', status: 'FIXED' }] };
  const DEV_STALE = { ...DEV_OK, entries_found: -1, results: [{ issue_id: 'i-1', status: 'STALE' }] };
  const { out, prompt, logs } = await run({
    develop: firstRound(DEV_FIXED, DEV_STALE),
    quality: firstRound(FLAGGED, CLEAN),
    acceptance: { pass: true, staged: true, regression: false, gap_count: 0, fix_checks: [] },
  }, FIX_BLOCK);
  ok(/- i-1/.test(prompt('acceptance')), 'round 2 still hands acceptance the id claimed FIXED in round 1');
  ok(!/none claimed fixed/.test(prompt('acceptance')), 'the claim list did not empty on the downgrade');
  ok(logs.some((l) => /THIN EVIDENCE \(0 check\(s\) for 1 claimed fix\(es\)\)/.test(l)),
    'a pass with no fix_check behind that claim is still flagged thin');
  eq(JSON.stringify(out.ledger[0].results), JSON.stringify([{ issue_id: 'i-1', status: 'STALE' }]),
    'the ledger still records the LATEST status per issue');
}

// ---------------------------------------------------------------------------------------------
// FIX mode — the derived `produced`, the two round-1 terminals, and the gate a fix block may take
// Twins of tests/resolve.test.mjs's battery, ported to the block shape: resolve fans batches out of an
// issue inventory, this engine reads ONE block whose body IS the inventory, so `entries_found` and the
// terminals move from a batch record onto the ledger's per-block record.
// ---------------------------------------------------------------------------------------------
const FIX_ONE = { ...baseArgs, plans: [{ id: 'fix-a', mode: 'fix', gate: 'green' }] };
// `produced` is DELIBERATELY dropped: in fix mode the engine DERIVES it from `results`, and leaving the
// flag in would let every case below pass on the one field the engine must ignore there.
const { produced, ...DEV_FIX } = DEV_OK;
const fixDev = (results, extra = {}) => ({ ...DEV_FIX, entries_found: 1, results, ...extra });
const FIX_PASS = { pass: true, staged: true, regression: false, gap_count: 0, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }] };
const FIX_GAP  = { pass: false, staged: false, regression: false, gap_count: 1, fix_checks: [] };

section('mode fix takes gate green ONLY: build-only and red-baseline throw at launch');
// A fix block's entries are defects in WORKING code, so both other gates would stage a "closed" issue on
// evidence that never ran — build-only asks for no verification at all, red-baseline demands the tests
// FAIL. Neither can be coerced to green, hence a launch throw rather than a per-block gate miss.
{
  for (const gate of ['build-only', 'red-baseline']) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [{ id: 'fix-a', mode: 'fix', gate }] } });
    ok(/plan gate\(s\) \[fix-a: /.test(msg) && msg.includes(JSON.stringify(gate)),
      `gate ${gate} throws naming the block and the value it was handed: ${msg.slice(0, 60)}`);
    ok(/mode fix takes green\)/.test(msg), 'and states the only legal gate for the mode');
  }
}

section('a fix block whose inventory printed no entries halts before any reviewer; -1 in round 2 does not');
// The block body IS the inventory here, so 0 entries means the developer read the wrong block (or none).
// Unguarded, it returns an empty results array, the no-changes terminal fires, and the run ends reporting
// a clean outcome over an inventory nobody read.
{
  const zero = await run({ develop: fixDev([], { entries_found: 0 }) }, FIX_ONE);
  eq(zero.calls.length, 1, 'only the developer ran');
  ok(!zero.labels.some((l) => l.startsWith('quality') || l.startsWith('acceptance') || l.startsWith('park')),
    'no reviewer and no park on a block that was never started');
  eq(zero.out.status, 'BLOCKED (a fix block printed no issue entries - check its planPath and block id; nothing was built)', 'status');
  ok(/ZERO "### \[" issue entries/.test(zero.out.haltReason), 'the halt reason names what was counted');
  ok(/'E:\/plans\/bus\.md' 'fix-a'/.test(zero.out.haltReason), 'and the block reference to re-run by hand');
  eq(zero.out.plansDone.length, 0, 'nothing is done');

  // -1 is the schema's round-2+ n/a. The precondition is round-1 only, so it must fall straight through
  // rather than collapsing into the 0 halt.
  const later = await run({
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]),
      fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { entries_found: -1 })),
    quality: firstRound(FLAGGED, CLEAN),
    acceptance: FIX_PASS,
  }, FIX_ONE);
  ok(later.out.halted === false, 'entries_found -1 in round 2 does not halt');
  eq(later.out.status, 'done (all blocks staged)', 'and the block still reaches acceptance');
}

section('a fix block that halts on escalation or staging still records the results it reported');
// The ledger is where the operator syncs each entry's status line from. Recording after the halts left a
// block that escalated with results:null, although its developer had reported every id.
{
  const reported = [{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'SKIPPED' }];
  for (const [why, extra] of [['needs_user', { needs_user: true }], ['staging unconfirmed', { unstaged_confirmed: false }]]) {
    const { out } = await run({ develop: fixDev(reported, extra), park: PARK_OK }, { ...FIX_ONE, ordered: true });
    ok(out.halted === true, `${why}: the run halted`);
    eq(JSON.stringify(out.ledger[0]?.results), JSON.stringify(reported), `${why}: the ledger carries the reported results`);
  }
}

section('the inventory-readable guard reads the VALUE, not what `=== 0` makes of it');
// `false`, `''` and `[]` all compare `=== 0` as false, so a malformed return would read as a readable
// inventory silently. Each must log that the precondition went unverified.
{
  for (const bad of [null, false, '', []]) {
    const { logs } = await run({
      develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { entries_found: bad }),
      quality: CLEAN, acceptance: FIX_PASS,
    }, FIX_ONE);
    ok(logs.some((l) => /entries_found — the inventory-readable precondition was NOT verified/.test(l)),
      `${JSON.stringify(bad)} is not silently a readable inventory`);
  }
}

section('a round-1 fix block where every entry is reported STALE goes to acceptance, never the blind review');
// An all-STALE report is a CLAIM. Closing it unchecked would let a misjudged live defect sync `stale`, so
// acceptance confirms each id. The empty diff gives the blind reviewer nothing to judge. This is the branch
// the no-changes terminal below must never swallow.
{
  const ALL_STALE = fixDev([{ issue_id: 'i-1', status: 'STALE' }, { issue_id: 'i-2', status: 'STALE' }]);
  const STALE_OK = { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: true }] };
  const { out, calls, prompt } = await run({ develop: ALL_STALE, acceptance: STALE_OK }, FIX_ONE);
  eq(calls.map((c) => c.label.split(' ')[0]).join(), 'develop,acceptance', 'developer then acceptance: no quality, no park');
  ok(/- i-1\n\s*- i-2/.test(prompt('acceptance')), 'acceptance is handed both STALE ids to confirm');
  eq(out.plansDone.join(), 'fix-a', 'a confirmed all-stale block counts DONE');
  eq(out.status, 'done (all blocks staged)', 'the run status reflects the accepted outcome');

  const refuted = await run({ develop: ALL_STALE, acceptance: FIX_GAP, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 });
  eq(refuted.out.plansDone.length, 0, 'a STALE claim acceptance refutes never counts done');
}

section('a round-1 fix block that closed nothing is NOT done, and `ordered` decides whether the run stops');
// All-SKIPPED, a SKIPPED/STALE mix and an EMPTY array all closed zero issues, so the entries stay open and
// the block must never count done. Only an all-stale block that acceptance confirms may. The no-changes
// terminal does not park: the developer changed nothing, so there is nothing to save and nothing to clear.
{
  const skipped = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) }, FIX_ONE);
  eq(skipped.calls.length, 1, 'no reviewer and no park on an empty diff');
  eq(skipped.out.ledger[0].status, 'no-changes', 'the ledger names the terminal');
  eq(skipped.out.plansDone.length, 0, 'the block is NOT done — its issues stay open');
  ok(skipped.out.halted === false, 'an unordered run does not halt on it');

  const empty = await run({ develop: fixDev([]) }, FIX_ONE);
  eq(empty.out.ledger[0].status, 'no-changes', 'an EMPTY results array is the same terminal, never all-stale');
  eq(empty.out.plansDone.length, 0, 'and never counts done either');

  const stop = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) }, { ...FIX_ONE, ordered: true });
  eq(stop.out.status, 'halted (a fix block closed no issue - every entry was skipped or stale, and the ordered run stopped there)', 'ordered status');
  ok(!stop.labels.some((l) => l.startsWith('park')), 'still nothing to park');
  ok(/The tree is clean/.test(stop.out.haltReason), 'and the reason says the tree is clean');

  const TWO = { ...baseArgs, plans: [FIX_ONE.plans[0], BLOCKS[0]] };
  const carry = await run({
    ...GREEN_RUN,
    develop: (l) => (l.startsWith('develop fix-a') ? fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) : DEV_OK),
  }, TWO);
  ok(carry.out.halted === false, 'an unordered run carries on');
  eq(carry.out.plansDone.join(), 'block-a', 'building the next block, which alone is done');
  eq(carry.out.status, 'run complete with 1 block(s) blocked', 'the status counts the blocked block, never "partial slice"');
  ok(/closed NO issue and are NOT done: fix-a/.test(carry.out.followups), 'and followups name it');
}

section('a round-2 empty results array takes NO shortcut — the run still reaches acceptance and park');
// `produced` is per-ROUND while the working tree is CUMULATIVE. From round 2 a developer may legitimately
// return results:[] having resolved a blind-review finding with no issue id in the block. Taking the
// round-1 shortcut there breaks out past quality, acceptance AND park, stranding round 1's real edits
// unstaged, unreviewed and attributed to the next block.
{
  const { out, labels } = await run({
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([], { entries_found: -1 })),
    quality: firstRound(FLAGGED, CLEAN),
    acceptance: FIX_GAP,
    park: PARK_OK,
  }, { ...FIX_ONE, maxRounds: 2 });
  ok(labels.some((l) => l.startsWith('acceptance')), 'acceptance still ran in round 2');
  ok(labels.includes('park:fix-a'), 'PARK ran — round 1\'s work is cleared, not stranded');
  eq(out.ledger[0].status, 'parked (not accepted within round budget)', 'reported parked, never no-changes');
  ok(out.parked[0]?.patch?.endsWith('parked-fix-a.patch'), 'and the patch path reaches the operator');
}

section('`produced` is DERIVED from results: a FAILED-only round is real work the blind reviewer must see');
// FAILED means the developer tried and could not — it attempted edits and may have reverted them
// surgically, so there IS a diff. Only SKIPPED and STALE leave the tree untouched.
{
  const { out, labels } = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FAILED' }]),
    quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK,
  }, { ...FIX_ONE, maxRounds: 1 });
  ok(labels.some((l) => l.startsWith('quality')), 'the blind reviewer ran on the diff');
  ok(labels.includes('park:fix-a'), 'and the round took the ordinary park path');
  eq(out.ledger[0].status, 'parked (not accepted within round budget)', 'it never took the no-changes shortcut');
}

section('a FIXED round that passes acceptance stages, and the ledger record carries the results pairs');
// The per-issue results ARE the round's record: the ledger holds every id the developer reported, with
// the latest status per id, which is what the operator syncs the block's `- decision:` lines against.
{
  const { out, labels } = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'SKIPPED' }]),
    quality: CLEAN, acceptance: FIX_PASS,
  }, FIX_ONE);
  ok(labels.some((l) => l.startsWith('quality')), 'the blind reviewer judged the diff first');
  eq(out.plansDone.join(), 'fix-a', 'the block is staged and done');
  eq(out.ledger[0].status, 'done (staged)', 'the ledger says staged');
  eq(JSON.stringify(out.ledger[0].results), JSON.stringify([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'SKIPPED' }]),
    'every reported id and its status, SKIPPED entries included');
  eq(out.ledger[0].criteria, null, 'a fix block enumerates no plan criteria, so none are invented');
  ok(out.ledger[0].thinEvidence === false, 'one fix_check per claimed fix is not thin');
  ok(out.ledger[0].contradicted === false, 'and a closed check does not contradict the pass');
}

// ---------------------------------------------------------------------------------------------
// gateOk — what "done" MEANS for a block, per gate and per the `suite` file key
// ---------------------------------------------------------------------------------------------
section('a red-baseline gate rejects a count of 0 exactly as green does');
// A mistyped selector collects nothing and exits non-zero; a developer that EXPECTS failure at the red
// step reports failed-expected with tests_run_count 0. That is a gate passed on a test that never ran,
// staged as a phantom TDD baseline.
{
  const RED = { ...baseArgs, plans: [{ id: 'block-a', mode: 'section', gate: 'red-baseline' }] };
  const RED_DEV = { ...DEV_OK, test_outcome: 'failed-expected' };

  const zero = await run({ ...GREEN_RUN, develop: { ...RED_DEV, tests_run_count: 0 }, park: PARK_OK }, RED);
  ok(!zero.labels.some((l) => l.startsWith('quality')), 'no reviewer spawned on a phantom red baseline');
  eq(zero.out.plansDone.length, 0, 'nothing is staged on a test that never ran');
  ok(zero.out.ledger[0].status.startsWith('parked'), 'the block parks at the round budget instead');

  // -1 is the schema's N/A (manual/MCP verification) and must stay a legal red baseline.
  const na = await run({ ...GREEN_RUN, develop: { ...RED_DEV, tests_run_count: -1 } }, RED);
  eq(na.out.status, 'done (all blocks staged)', 'tests_run_count -1 still passes the red-baseline gate');

  const real = await run({ ...GREEN_RUN, develop: { ...RED_DEV, tests_run_count: 3 } }, RED);
  eq(real.out.status, 'done (all blocks staged)', 'a real red baseline still passes');
}

section('suite:green fails a green gate on a reddened suite; suite:scoped allows the mid-run red');
// The one thing the FILE key layers on top of `green`: breaking the existing suite is a regression, but a
// test-first migration expects the rest of the suite to be red until its last block lands.
{
  const GREEN_GATE = { ...baseArgs, plans: [{ id: 'block-a', mode: 'feature', gate: 'green' }] };

  const reddened = await run({ ...GREEN_RUN, develop: { ...DEV_OK, full_suite_outcome: 'failed' }, park: PARK_OK }, GREEN_GATE);
  ok(!reddened.labels.some((l) => l.startsWith('quality')), 'no reviewer spawned on a reddened suite');
  eq(reddened.out.plansDone.length, 0, 'and nothing is staged');
  ok(reddened.out.ledger[0].status.startsWith('parked'), 'the block parks instead');

  const scoped = await run({ ...GREEN_RUN, develop: { ...DEV_OK, full_suite_outcome: 'scoped-skip' } },
    { ...GREEN_GATE, suite: 'scoped' });
  eq(scoped.out.status, 'done (all blocks staged)', 'suite:scoped judges the block on its own selector alone');
}

section('an omitted gate takes the green default, never a throw');
// Only a gate that was typed and is wrong throws. An absent one is the documented default.
{
  const { out } = await run(GREEN_RUN, { ...baseArgs, plans: [{ id: 'block-a', mode: 'section' }] });
  eq(out.ledger[0].gate, 'green', 'the ledger records the green default');
  eq(out.status, 'done (all blocks staged)', 'and the block builds under it');
}

section('a gate that never goes green surfaces the developer\'s own diagnostics');
// The developer re-runs the gate live, so once the round budget is gone the run log holds the only copy of
// why it was red. Without these the operator has to re-run the gate to find out.
{
  const DEV_RED = { ...DEV_OK, build_passed: false, verification_method: 'node tests/run.mjs x', gate_output: 'E   assert 1 == 2\n1 failed' };
  const { logs } = await run({ develop: DEV_RED, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 2 });
  ok(logs.some((l) => /another develop round/.test(l) && /via=node tests\/run\.mjs x/.test(l)),
    'the retry line names what was actually run');
  const budget = logs.find((l) => /not satisfied at round budget/.test(l));
  ok(!!budget && /via=node tests\/run\.mjs x/.test(budget) && /last gate output: E   assert 1 == 2/.test(budget),
    `the round-budget line carries the failing output: ${budget}`);
}

// ---------------------------------------------------------------------------------------------
// Park — save strictly before clear, and `ordered` deciding what happens after
// ---------------------------------------------------------------------------------------------
section('a self-contradictory park report halts and still surfaces the patch');
// saved=false with bytes on disk: the report is wrong, the patch is real. The tree may already be
// cleared, so telling the operator nothing was saved when 4KB exists is actively wrong.
{
  const { out } = await run({
    ...GREEN_RUN, acceptance: ACC_FAIL,
    park: { ...PARK_OK, saved: false, patch_bytes: 4096 },
  }, ONE_BLOCK);
  eq(out.status, 'BLOCKED (a parked block left the tree unsafe — inspect before resuming)', 'status');
  ok(/contradicts itself/.test(out.haltReason), 'halt reason says so');
  ok(out.parked[0].patch !== null, 'patch path surfaced, NOT reported as "nothing saved"');
}

section('a park that cannot clear the tree, or leaves the build red, halts the run');
// Both are unsafe for whatever comes next, so they halt even in an UNORDERED run where a plain park does
// not. `gates_green` was required by the schema, demanded by the prompt and read by nothing in migrate.
{
  const stuck = await run({
    ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, cleared: false },
  });
  eq(stuck.out.status, 'BLOCKED (a parked block left the tree unsafe — inspect before resuming)', 'uncleared status');
  ok(/could not be cleared/.test(stuck.out.haltReason), 'halt reason says the tree still holds it');
  ok(/its work IS saved to/.test(stuck.out.haltReason), 'and that the work was still saved');
  ok(!stuck.labels.some((l) => l.includes('block-b')), 'block-b never started on an unsafe tree');

  const red = await run({
    ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false },
  });
  eq(red.out.status, 'BLOCKED (a parked block left the tree unsafe — inspect before resuming)', 'red-build status');
  ok(/build gate is not green after parking/.test(red.out.haltReason), 'the reason names the red build');
  ok(!/tree is CLEAN; resolve with the user/.test(red.out.haltReason),
    'and does NOT also tell the operator the tree is fine to resume from');
  ok(red.out.parked[0]?.patch?.endsWith('parked-block-a.patch'), 'the patch is still surfaced');
}

section('the `ordered` file key decides whether a parked block stops the run');
// The merge point: feature parks and CARRIES ON (independent features have no coupling), migrate parks
// and STOPS (block N+1 routinely needs N to have landed). One engine, both shapes, chosen by data.
{
  const carry = await run({
    ...GREEN_RUN, 'acceptance block-a': ACC_FAIL, acceptance: ACC_PASS, park: PARK_OK,
  });
  ok(carry.labels.includes('park:block-a'), 'block-a was PARKED');
  ok(carry.labels.some((l) => l.includes('block-b')), 'and the run CONTINUED to block-b');
  ok(carry.out.halted === false, 'the run did not halt');
  eq(carry.out.plansDone.join(), 'block-b', 'block-b is the only one done');
  ok(carry.out.parked[0].patch?.endsWith('parked-block-a.patch'), 'the patch path reaches the operator');
  eq(carry.out.status, 'run complete with 1 block(s) parked', 'status counts the parked block');
  ok(/PARKED: block-a/.test(carry.out.followups) && /git apply --3way/.test(carry.out.followups),
    'followups names the parked block and the restore command');
  ok(/flip it to todo once `plan-edit\.mjs args` has applied this run's statuses, and relaunch it with runOnly/.test(carry.out.followups),
    'followups says to flip a parked block to todo before a runOnly relaunch, since runOnly selects only todo blocks');

  const stop =await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...baseArgs, ordered: true });
  ok(stop.labels.includes('park:block-a'), 'the SAME park still runs, so nothing is discarded');
  ok(!stop.labels.some((l) => l.includes('block-b')), 'but block-b never starts');
  eq(stop.out.status, 'halted (a block was parked — its work is saved to a patch; the blocks after it were not attempted)', 'ordered status');
  ok(/is SAVED to/.test(stop.out.haltReason) && /tree is CLEAN/.test(stop.out.haltReason),
    'halt reason states saved + clean');
}

section('a developer escalation parks first, then stops an ordered run');
// parked[] is keyed on the patch and the `parked` flag, never the status prose: an escalated block keeps
// BLOCKED and would otherwise have its patch path reported nowhere in the return.
{
  const { out, labels, prompt } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: { ...PARK_OK, strays_saved: 2 },
  }, { ...baseArgs, ordered: true });
  ok(labels.includes('park:block-a'), 'PARK ran on the halt path');
  eq(out.status, 'BLOCKED (needs user input)', 'status');
  ok(!labels.some((l) => l.includes('block-b')), 'block-b never started');
  ok(out.parked[0]?.strays?.endsWith('parked-block-a-newfiles'), `strays dir surfaced: ${out.parked[0]?.strays}`);
  eq(out.parked[0]?.status, 'BLOCKED (needs user)', 'the escalated block keeps its BLOCKED status');
  ok(/The tree is clean/.test(out.followups) && !/still holds/.test(out.followups),
    'followups says the tree is clean, never that it still holds the work');
  ok(/was halted: the developer escalated a user-only decision \(see .*NEEDS-USER\.md\)/.test(prompt('park')),
    'park prompt uses the escalation wording');
  // An escalation park has no review path, yet a reviewer may have run: the fallback must claim neither.
  ok(/left no review file to cite; point the user at the run trail in E:\/r\/runs\/t/.test(prompt('park')),
    'with no review file, park points at the run trail');
  ok(!/neither reviewer ever ran|gate never went green/.test(prompt('park')),
    'and never claims no reviewer ran');
}
{
  // Escalated before editing anything: park saves nothing, so naming parked-<id>.patch would send the
  // operator to a file that does not exist.
  const { out } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: { ...PARK_OK, saved: false, patch_bytes: 0 },
  });
  eq(out.parked[0]?.patch, null, 'no patch path for an empty park');
  ok(/NO patch was written for: block-a/.test(out.followups), 'and followups says nothing was saved');
  ok(!/Work SAVED/.test(out.followups), 'never that the work was saved');
}
{
  // An empty diff can still hide `??` files the developer never registered: park copies them, so
  // "nothing to save" would send the operator past real work.
  const { out } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: { ...PARK_OK, saved: false, patch_bytes: 0, strays_saved: 2 },
  }, { ...baseArgs, ordered: true });
  eq(out.parked[0]?.patch, null, 'no patch path');
  ok(/new files are SAVED to .*parked-block-a-newfiles\//.test(out.haltReason), `halt reason names the strays dir: ${out.haltReason}`);
  ok(!/NOTHING to save/.test(out.haltReason), 'and never says there was nothing to save');
  ok(!/NO patch was written for: block-a/.test(out.followups), 'followups does not list it as an empty park');
}

section('an unordered run parks a needs-user block and continues');
// No later block depends on it, so only the user's answer waits. The block stays blocked, never parked:
// a relaunch must not rebuild it before that answer.
{
  const { out, labels, prompt } = await run({
    ...GREEN_RUN,
    develop: (label) => (/block-a/.test(label) ? { ...DEV_OK, needs_user: true } : DEV_OK),
    park: PARK_OK,
  });
  ok(out.halted === false, 'the run did not halt');
  ok(labels.includes('park:block-a'), 'block-a was parked');
  ok(labels.some((l) => /block-b/.test(l)), 'block-b ran');
  eq(syncOf(out), 'block-a=blocked,block-b=done', 'block-a is blocked and block-b is done');
  eq(out.parked[0]?.status, 'BLOCKED (needs user)', 'the escalated block keeps its BLOCKED status');
  eq(out.status, 'run complete with 1 block(s) parked', 'status');
  ok(/REST OF THE RUN can continue/.test(prompt('park')) && /the remaining blocks continued without it/.test(prompt('park')),
    'park is told the run continues');
  ok(/was halted: the developer escalated a user-only decision/.test(prompt('park')), 'with the needs-user reason');
  // The parked-block followup offers only restore, re-run or drop, so the escalated question needs its own line.
  ok(/1 block\(s\) escalated a user-only decision: block-a\. .*resolve with the user.*relaunch it with runOnly/.test(out.followups),
    'followups name the block and say to resolve it with the user');
}
{
  // Every other escalation still stops an unordered run, and park must be told so.
  const { out, prompt } = await run({ develop: null, park: PARK_OK });
  ok(out.halted === true, 'agent-dead halts the unordered run');
  ok(/The run stops after you/.test(prompt('park')) && /the blocks after it were NOT attempted\n/.test(prompt('park')),
    'park is told the run stops, with no ordered-dependency claim');
}

section('park records the halt that actually happened, never an escalation that did not');
// Only needs-user writes a NEEDS-USER entry. Told every escalated halt was a developer escalation, the
// park agent invented a blocker for the durable `## Parked block` record.
{
  for (const [kind, respond, reason] of [
    ['staging-unconfirmed', { ...GREEN_RUN, develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK },
      /did not confirm its work stayed unstaged; inspect `git -C E:\/repo diff --cached` for self-staged work/],
    ['agent-dead', { develop: null, park: PARK_OK }, /an agent returned nothing \(skipped or died\)/],
    ['plan-unreadable', { develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK }, /an agent could not obtain its plan/],
  ]) {
    const p = (await run(respond, ONE_BLOCK)).prompt('park:block-a');
    ok(reason.test(p), `${kind}: park names the real cause`);
    ok(!/developer escalated/.test(p), `${kind}: and never blames a developer escalation`);
  }
}

section('park never names a review file that was never written');
// With the gate never green neither reviewer runs, so there IS no review file. The call site used to
// substitute a concrete acceptance-review path, making parkPrompt's own fallback unreachable and sending
// the operator, days later, to a file that does not exist.
{
  const { prompt } = await run({ develop: { ...DEV_OK, build_passed: false }, park: PARK_OK }, ONE_BLOCK);
  const p = prompt('park:block-a');
  ok(p !== '', 'park still ran');
  ok(!/acceptance-review-block-a-r\d+\.md/.test(p), 'no fabricated acceptance-review path in the prompt');
  ok(/left no review file to cite/.test(p), 'the prompt says outright that no review file exists');
}

// ---------------------------------------------------------------------------------------------
// Acceptance verdicts that contradict themselves
// ---------------------------------------------------------------------------------------------
section('acceptance that stages while reporting a regression halts the run');
// The work is STAGED, so park may not touch it and a re-round would be invisible to the next blind
// reviewer. What stops is everything AFTER it: that diff is now the baseline later blocks are judged on.
{
  const { out, labels } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, regression: true } });
  ok(out.halted === true, 'halted');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park (the work is staged)');
  ok(!labels.some((l) => l.includes('block-b')), 'the run did NOT continue onto a poisoned baseline');
  eq(out.status, 'BLOCKED (a block staged while self-reporting a regression — inspect the staged diff before continuing)', 'status');
  eq(out.plansDone.join(), 'block-a', 'the block itself still counts as done (staged)');
  ok(out.ledger[0].contradicted === true, 'and the ledger flags the self-contradiction');
}

section('acceptance that stages while reporting unreachable is only FLAGGED');
// Same class of self-contradiction, but inert: an unreachable block does not corrupt the baseline, so it
// is an audit flag rather than a halt.
{
  const { out, labels, logs } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, reachable: false } });
  ok(out.halted === false, 'did NOT halt');
  ok(labels.some((l) => l.includes('block-b')), 'the run continued');
  ok(out.ledger.every((r) => r.contradicted === true), 'every block flagged contradicted in the ledger');
  ok(logs.some((l) => /CONTRADICTS ITS OWN PASS/.test(l)), 'and the log points at the review file to audit');
  eq(out.status, 'done (all blocks staged)', 'status is still done');
}

section('acceptance that passed without staging halts without parking');
// The work is good and one `git add` both preserves it and cleans the tree, so parking would be strictly
// worse. But the run cannot advance onto an unstaged baseline either.
{
  const { out, labels } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, staged: false } });
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park good accepted work');
  ok(!labels.some((l) => l.includes('block-b')), 'did not advance past the broken staging boundary');
  eq(out.status, 'BLOCKED (a block passed but was not staged — stage it, then resume)', 'status');
  // Acceptance passed, so the plan file says done. Synced as blocked, the documented flip-to-todo rebuilt a
  // block that had already landed on top of its own staged copy.
  eq(syncOf(out), 'block-a=done', 'statusSync marks the passed block done');
  ok(/then relaunch: the next `plan-edit\.mjs args` marks the block done: no startAt is needed/.test(out.haltReason),
    'and the reason says stage, relaunch, with no startAt, and that args marks the block done');
  ok(/1 block\(s\) halted and are NOT done: block-a - the halt reason above says what each needs/.test(out.followups),
    'followups defers to the halt reason rather than giving fix-block advice');
  ok(!/closed NO issue|- decision:/.test(out.followups), 'and never tells a feature block to read decision lines');

  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN,
    acceptance: { ...FIX_PASS, staged: false } }, FIX_ONE);
  eq(syncOf(fix.out), 'fix-a=done,i-1=fixed', 'a passed-unstaged fix block syncs its FIXED entry fixed');
}

section('a pass resting on assertion rather than evidence is flagged THIN, never failed');
// Acceptance already staged by the time the flag is computed, so this is an operator audit signal (#14),
// not a gate. A pass with no criteria enumerated at all is the same defect one step further on.
{
  const thin = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, evidence_recorded: false } }, ONE_BLOCK);
  ok(thin.out.ledger[0].thinEvidence === true, 'missing locators flag the pass');
  ok(thin.logs.some((l) => /THIN EVIDENCE \(evidence_recorded=false\)/.test(l)), 'and the log names the audit file');
  eq(thin.out.status, 'done (all blocks staged)', 'without failing the block');

  const none = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, criteria_total: 0, criteria_met: 0 } }, ONE_BLOCK);
  ok(none.out.ledger[0].thinEvidence === true, 'enumerating no criteria is never a clean pass either');

  ok((await run(GREEN_RUN, ONE_BLOCK)).out.ledger[0].thinEvidence === false,
    'an evidenced pass is NOT flagged, so the flag means something');
}

// ---------------------------------------------------------------------------------------------
// Selection — the todo filter, the pending-scoped gate check, the slices
// ---------------------------------------------------------------------------------------------
section('only todo blocks are built: done, skip, parked and blocked are never selected');
// A status typo is a block silently skipped or, worse, a finished one rebuilt over its own staged
// baseline. The filter is what makes a relaunch against the same plan file safe.
{
  const MIXED = { ...baseArgs, plans: [
    { id: 'block-done', mode: 'feature', gate: 'build-only', status: 'done' },
    { id: 'block-skip', mode: 'feature', gate: 'build-only', status: 'skip' },
    { id: 'block-parked', mode: 'feature', gate: 'build-only', status: 'parked' },
    { id: 'block-blocked', mode: 'feature', gate: 'build-only', status: 'blocked' },
    { id: 'block-todo', mode: 'feature', gate: 'build-only', status: 'todo' },
  ] };
  const { out, labels } = await run(GREEN_RUN, MIXED);
  ok(!labels.some((l) => /block-done|block-skip|block-parked|block-blocked/.test(l)),
    'no non-todo block reached any agent');
  eq(out.plansDone.join(), 'block-todo', 'only the todo block was built');
  eq(out.plansTotal, 5, 'while the array total still reports the whole plan file');
}
{
  // An all-done relaunch is a legitimate operator state, not an error: the plan file's statuses say the
  // work landed. A distinct TERMINAL rather than a throw, so the caller can tell "nothing left" apart
  // from "you passed something wrong".
  const { out, calls } = await run({}, { ...baseArgs, plans: BLOCKS.map((b) => ({ ...b, status: 'done' })) });
  eq(calls.length, 0, 'nothing was spawned');
  eq(out.status, 'nothing to run (no todo blocks)', 'status');
  ok(out.halted === false, 'and it is not a halt');
  ok(/status back to todo/.test(out.followups), 'followups says how to re-open a block');
}

section('gates.test is demanded only for the PENDING set, not for blocks already done');
// Scoped deliberately unlike the sibling engines' all-blocks rule: with the todo filter, an all-done
// relaunch would otherwise throw over a test command this run will never execute instead of reaching the
// nothing-to-run terminal above.
{
  const DONE_GREEN = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b' },
    planPath: 'E:/plans/bus.md', plans: [{ id: 'block-a', mode: 'feature', gate: 'green', status: 'done' }] };
  const { out, calls } = await run({}, DONE_GREEN);
  eq(calls.length, 0, 'the relaunch spawns nothing');
  eq(out.status, 'nothing to run (no todo blocks)', 'and reaches the terminal instead of throwing');

  const msg = await throwsWith(ENGINE, {
    args: { ...DONE_GREEN, plans: [{ ...DONE_GREEN.plans[0], status: 'todo' }] },
  });
  ok(/args\.gates\.test is required/.test(msg), `the same block as TODO throws: ${msg.slice(0, 50)}`);
}

section('a partial slice builds only its blocks and is never reported as done');
{
  const only = await run(GREEN_RUN, { ...baseArgs, runOnly: ['block-b'] });
  ok(!only.labels.some((l) => l.includes('block-a')), 'runOnly skipped block-a');
  eq(only.out.status, 'partial slice complete', 'runOnly status');
  const from = await run(GREEN_RUN, { ...baseArgs, startAt: 'block-b' });
  eq(from.out.plansDone.join(), 'block-b', 'startAt built from block-b to the end');
  eq(from.out.status, 'partial slice complete', 'startAt status');
}

section('a block id matching nothing throws instead of building a smaller roadmap');
// A silently dropped id builds fewer blocks than the operator asked for, and if every id is a typo,
// nothing at all, reported as a benign "partial slice complete" with no error.
{
  for (const scope of [{ runOnly: ['nope'] }, { startAt: 'nope' }]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, ...scope } });
    ok(/nope/.test(msg) && /block-a, block-b/.test(msg),
      `${Object.keys(scope)[0]} "nope" throws and lists the valid ids: ${msg.slice(0, 60)}`);
  }
}

section('the token budget stops cleanly between blocks');
{
  const { out, calls } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(calls.length, 0, 'stopped before spawning anything');
  eq(out.status, 'stopped on token budget (resume where it left off)', 'status');
  ok(/startAt:"block-a"/.test(out.haltReason), 'halt reason carries the resume point');
}

// ---------------------------------------------------------------------------------------------
// The whole-goal sweep
// ---------------------------------------------------------------------------------------------
section('the sweep runs on the pre-done + this-run union, with skips excluded');
// The union replaces migrate's is-this-a-full-run guard, which a todo-derived pending would falsify on
// every relaunch: a block already `done` in the plan file counts as covered, a `skip` block is not owed,
// and anything else still open means the goal is not finished and the sweep has nothing to judge.
{
  const MIX = { ...baseArgs, sweep: 'goal-coverage', goal: 'move every caller onto the new client', plans: [
    { id: 'block-done', mode: 'feature', gate: 'build-only', status: 'done' },
    { id: 'block-skip', mode: 'feature', gate: 'build-only', status: 'skip' },
    { id: 'block-todo', mode: 'feature', gate: 'build-only', status: 'todo' },
  ] };
  const { labels, prompt } = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, MIX);
  eq(labels.filter((l) => l === 'final-sweep').length, 1, 'exactly one sweep, after the last block');
  ok(/COMPLETED BLOCKS: block-todo/.test(prompt('final-sweep')), 'it names the blocks this run staged');

  const OPEN = { ...MIX, plans: [...MIX.plans, { id: 'block-open', mode: 'feature', gate: 'build-only', status: 'blocked' }] };
  const open = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, OPEN);
  ok(!open.labels.includes('final-sweep'), 'a non-skip block that is not done keeps the sweep from running');
  eq(open.out.sweep, null, 'and no sweep result is fabricated');
}

section('a healthy sweep is surfaced, sweep:none spawns none, and a halted run is never swept');
{
  const SWEPT = { ...baseArgs, sweep: 'goal-coverage', goal: 'g' };
  const healthy = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, SWEPT);
  eq(healthy.out.status, 'done (all blocks staged)', 'status');
  eq(healthy.out.sweep?.suite, 'green', 'the sweep result is surfaced');
  ok(/status --porcelain/.test(healthy.out.followups), 'followups carries the unstaged-tree check');

  const none = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, { ...baseArgs, sweep: 'none' });
  ok(!none.labels.includes('final-sweep'), 'sweep:none spawns no sweep agent');
  eq(none.out.sweep, null, 'and fabricates no result');

  // Every block is DONE here (the regression was staged), so only the halt keeps the sweep from judging
  // a baseline the run just refused to build on.
  const halted = await run({ ...GREEN_RUN, 'acceptance block-b': { ...ACC_PASS, regression: true }, 'final-sweep': SWEEP_OK }, SWEPT);
  eq(halted.out.plansDone.join(), 'block-a,block-b', 'both blocks count done');
  ok(halted.out.halted === true, 'the run halted on the regression');
  ok(!halted.labels.includes('final-sweep'), 'and ran no sweep');
}

section('a goal-coverage sweep with no goal throws at launch, naming the goal: file key');
// The sweep re-derives its surface from the goal; without one it runs with nothing to cover.
{
  for (const goal of [undefined, '', '  ']) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, sweep: 'goal-coverage', goal } });
    ok(/args\.sweep is goal-coverage but args\.goal is empty/.test(msg) && /"goal:" file key/.test(msg),
      `goal ${JSON.stringify(goal)} throws naming the file key: ${msg.slice(0, 60)}`);
  }
  const none = await run(GREEN_RUN, { ...baseArgs, sweep: 'none' });
  eq(none.out.status, 'done (all blocks staged)', 'sweep:none with no goal still runs');
}

section('a dead final sweep is reported as NOT RUN, never as zero gaps');
// `(sweep?.gaps || []).length` logged "0 potential gap(s)" for a check that never ran, citing a file
// nothing wrote. It must NOT halt: every block is already staged, so failing a complete run over a
// missing advisory check would be worse than reporting it missing.
{
  const { out, logs } = await run({ ...GREEN_RUN, 'final-sweep': null },
    { ...baseArgs, sweep: 'goal-coverage', goal: 'g' });
  eq(out.sweepFailed, true, 'the return distinguishes a DIED sweep from one that never ran');
  eq(out.sweep, null, 'no fabricated sweep result');
  ok(!logs.some((l) => /0 potential gap/.test(l)), 'never logs a clean-looking gap count for a check that died');
  eq(out.status, 'done (all blocks staged)', 'a dead sweep does not fail an otherwise complete run');
  ok(/completeness sweep DIED/.test(out.followups), 'and followups warns the user first');
}

// ---------------------------------------------------------------------------------------------
// The control array itself
// ---------------------------------------------------------------------------------------------
section('a plans value that is not a non-empty array throws, pointing at the --list blocks array');
// There is no single-plan fallback, so every one of these must stop before any agent. The message has to
// name the fix, not merely exist: `plan-block.mjs --list` prints an object whose `blocks` array is the input.
{
  for (const bad of ['block-a', 42, true, [], null]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: bad } });
    ok(/args\.plans must be a NON-EMPTY array/.test(msg) && /"blocks" array/.test(msg),
      `plans ${JSON.stringify(bad)} throws naming the "blocks" array: ${msg.slice(0, 45)}`);
  }
}

section('duplicate ids and a mode this engine does not build both throw');
// Every per-block run-state file is keyed by the bare id, so duplicates overwrite each other's reviews,
// ledger and patch, and the second block is judged against the first's trail.
{
  const dupe = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [BLOCKS[0], { ...BLOCKS[0] }] } });
  ok(/duplicate plan id\(s\) \[block-a\]/.test(dupe), `duplicate ids throw: ${dupe.slice(0, 60)}`);

  const bogus = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [{ id: 'block-a', mode: 'bogus' }] } });
  ok(/not one of feature \| section \| fix/.test(bogus), `an unknown mode throws: ${bogus.slice(0, 60)}`);
  ok(/"bogus"/.test(bogus), 'and names the value it was handed');
}

section('a block with no plan file anywhere throws; the top-level planPath satisfies one missing its own');
// Without a plan file the block reference names an empty path and the developer builds against nothing
// while reporting success. The top-level default is what keeps undecorated `--list` rows usable.
{
  const msg = await throwsWith(ENGINE, { args: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
    gates: { build: 'b' }, plans: [{ id: 'block-a', mode: 'feature', gate: 'build-only' }] } });
  ok(/carry no planPath/.test(msg), `throws: ${msg.slice(0, 60)}`);
  ok(/block-a/.test(msg), 'and names the block');

  const { prompt } = await run(GREEN_RUN, ONE_BLOCK);
  ok(/'E:\/plans\/bus\.md' 'block-a'/.test(prompt('develop block-a')),
    'an entry with no path of its own is addressed inside the top-level plan file');
}

section('a block reaches developer and acceptance as a plan-block COMMAND, never the blind reviewer');
// Handing over the file path would put every other block in the developer's context AND let it stop at
// the first `## Feature` (block bodies are all h2) with a truncated spec that looks complete.
{
  const { prompt } = await run(GREEN_RUN);
  const dev = prompt('develop block-a');
  ok(/node 'E:\/r\/tools\/plan-block\.mjs' 'E:\/plans\/bus\.md' 'block-a'/.test(dev),
    'the command uses the <root>/tools default, this block only, every path quoted');
  ok(!/plan-block\.mjs \S+ \S*block-b/.test(dev), 'and never a sibling block');
  ok(/plan_obtained=false and STOP/.test(dev), 'a non-zero exit is reported through the schema, not guessed around');
  ok(/node 'E:\/r\/tools\/plan-block\.mjs' 'E:\/plans\/bus\.md' 'block-a'/.test(prompt('acceptance block-a')),
    'acceptance judges against the same block the developer built to');
  ok(!/plan-block|bus\.md/.test(prompt('quality block-a')), 'the BLIND reviewer gets no route to any plan (#3)');
}

section('args.blockTool points the block command at an installed plugin\'s own tools/ copy');
// An installed plugin splits ROOT (the persistent data dir) from the versioned cache dir that ships
// tools/plan-block.mjs. Without the override the command names a file ROOT does not hold and every agent
// halts the run on plan_obtained=false.
{
  const { prompt } = await run(GREEN_RUN, { ...ONE_BLOCK, blockTool: 'C:\\plug\\cache\\aipg\\1.0.0\\tools\\plan-block.mjs' });
  const dev = prompt('develop block-a');
  ok(/node 'C:\/plug\/cache\/aipg\/1\.0\.0\/tools\/plan-block\.mjs' 'E:\/plans\/bus\.md' 'block-a'/.test(dev),
    'the command uses the passed path, backslashes normalized');
  ok(!/E:\/r\/tools\/plan-block\.mjs/.test(dev), 'and not the ROOT default');
}

section('planContext:"full" hands the file instead, for a block that needs its neighbours');
{
  const { prompt } = await run(GREEN_RUN, { ...baseArgs, plans: [{ ...BLOCKS[0], planContext: 'full' }] });
  const dev = prompt('develop block-a');
  ok(/"## Plan: block-a" inside the plan file at E:\/plans\/bus\.md/.test(dev), 'the block is named inside the file');
  ok(!/plan-block\.mjs/.test(dev), 'and no extraction command is issued');
}

const STATE = 'E:/r/runs/t';
/**
 * Every run-state path the BLIND quality reviewer's prompt discloses must sit under `runs/<runId>/gate/`.
 * Naming the state dir at all discloses everything IN it: `acceptance-review-<id>-rN.md` enumerates the
 * block's acceptance criteria, `AMENDED-<id>.md` quotes the overridden plan clause verbatim, and
 * NEEDS-USER.md carries the pointer line naming that file. #3 forbids relying on "please don't read X".
 * The trailing segment is OPTIONAL on purpose: the BARE state dir is the disclosure that matters most
 * (one `ls` reaches all three files), and a pattern demanding a `/` after it cannot see that leak.
 */
const stateRefsOutsideGate = (p) =>
  (p.match(/E:\/r\/runs\/t(\/[^\s`'")]*)?/g) ?? []).filter((s) => !s.startsWith(`${STATE}/gate/`));

section('the quality reviewer is blind BY PLACEMENT: no run-state path outside gate/');
{
  const q = (await run(GREEN_RUN)).prompt('quality block-a');
  ok(q !== '', 'the blind reviewer ran');
  ok(q.includes(`${STATE}/gate/DISMISSED-block-a.md`), 'it IS given the anti-spin ledger (#5)');
  ok(q.includes(`${STATE}/gate/quality-review-block-a-r1.md`), 'and its own output path, gate-scoped too');
  ok(!q.includes('NEEDS-USER.md'),
    'but NOT NEEDS-USER: its amendment pointer line names the AMENDED file, which quotes the plan verbatim');
  eq(stateRefsOutsideGate(q).join(', '), '', 'and no run-state path outside gate/');
  // Blindness is placement AND instruction: a fix block's plan file IS an issue inventory.
  ok(q.includes(`Never open a plan file, an issue inventory, or any run-state path outside ${STATE}/gate/.`),
    'and it is told never to open a plan file, an inventory or run-state outside gate/');
  const a = (await run(GREEN_RUN)).prompt('acceptance block-a');
  ok(a.includes(`${STATE}/gate/DISMISSED-block-a.md`) && a.includes(`${STATE}/NEEDS-USER.md`),
    'while the plan-aware verifier still reads both settled-decision files');
}

section('run-state and plan files inside the target repo each draw their own warning');
// Two doors onto the same hazard (#3): run-state holds the review files, the plan file holds the SPEC.
// Both warn rather than halt, because a mid-flight throw strands a run the operator may still want.
const planWarnings = (logs) => logs.filter((l) => l.includes('resolves inside the target repo'));
{
  const { logs } = await run(GREEN_RUN, { ...baseArgs, stateDir: 'E:/repo/runs/t' });
  ok(logs.some((l) => l.includes('INSIDE the target repo')), 'the run-state warning names the placement hazard');
  ok(logs.some((l) => l.includes('never the plugin install dir')), 'and steers away from the version-swapped install dir');
  eq(planWarnings(logs).length, 0, 'and it does not also fire the PLAN guard');
}
{
  // Both blocks default to the one top-level path, so the guard has three chances to warn about it. The
  // dedupe Set is what keeps a one-file roadmap from repeating the same line per block.
  const warn = planWarnings((await run(GREEN_RUN, { ...baseArgs, planPath: 'E:\\repo\\docs\\bus.md' })).logs);
  eq(warn.length, 1, 'a plan file inside the repo warns exactly ONCE, backslashes normalized');
  ok((warn[0] ?? '').includes('E:/repo/docs/bus.md'), `and names the offending path: ${(warn[0] ?? '(none)').slice(0, 60)}`);
}
{
  const ENTRY = { ...baseArgs, plans: [{ id: 'block-a', mode: 'feature', gate: 'build-only', planPath: 'E:/repo/plans/a.md' }, BLOCKS[1]] };
  const warn = planWarnings((await run(GREEN_RUN, ENTRY)).logs);
  eq(warn.length, 1, 'an ENTRY\'s own planPath is checked too, and its outside sibling is not');
  ok((warn[0] ?? '').includes('E:/repo/plans/a.md'), 'the path it names is the entry\'s');
}
{
  // The repo ROOT itself, through backslashes and a trailing slash: the check runs on the abs()-normalized
  // path, so neither separator style nor a trailing slash can dodge the equality branch.
  const { logs } = await run(GREEN_RUN, { ...baseArgs, planPath: 'E:\\repo\\' });
  const warn = planWarnings(logs);
  eq(warn.length, 1, 'a plan path equal to the repo root warns exactly once');
  ok((warn[0] ?? '').includes('(E:/repo)'), `and names the normalized path: ${(warn[0] ?? '(none)').slice(0, 60)}`);
  ok(!logs.some((l) => l.includes('INSIDE the target repo')), 'and it is not the run-state guard firing');
}
{
  eq(planWarnings((await run(GREEN_RUN)).logs).length, 0, 'a plan file outside the repo draws nothing');
}

// ---------------------------------------------------------------------------------------------
// Dead round-loop agents
// ---------------------------------------------------------------------------------------------
section('a dead round-loop agent halts and parks, never a gate miss or a clean review');
// A dead developer used to read as an ordinary gate miss and burn the round budget into a park; a dead
// reviewer pointed the NEXT developer at a review file nobody wrote.
{
  const DEAD = [
    ['developer', { develop: null, park: PARK_OK }, /Developer for block block-a/],
    ['quality reviewer', { ...GREEN_RUN, quality: null, park: PARK_OK }, /Quality reviewer for block block-a/],
    ['acceptance verifier', { ...GREEN_RUN, acceptance: null, park: PARK_OK }, /Acceptance verifier for block block-a/],
  ];
  for (const [role, respond, names] of DEAD) {
    const { out, labels } = await run(respond);
    eq(out.status, 'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)', `a dead ${role} halts`);
    ok(names.test(out.haltReason) && /skipped or died/.test(out.haltReason), `the reason names the ${role}`);
    // Park clears the tree before the run returns, so a cached replay would build on work no longer there.
    ok(!/resumeFromRunId|replay/.test(out.haltReason), 'and never advises a cached replay of parked work');
    ok(/work, if any, is parked/.test(out.haltReason) && /relaunch clean, or apply the patch and finish by hand/.test(out.haltReason),
      'it names the two recoveries a parked block has');
    ok(labels.includes('park:block-a'), 'its work is PARKED, not abandoned in the tree');
    ok(!labels.some((l) => l.includes('block-b')), 'block-b never started');
    eq(out.ledger[0].status, 'BLOCKED (agent died)', 'the ledger says the agent died, not "round budget"');
  }
}

section('a dead reviewer never sends a next round or the park to a review file nobody wrote');
{
  for (const [role, respond, file] of [
    ['quality reviewer', { ...GREEN_RUN, quality: null, park: PARK_OK }, /quality-review-block-a-r\d+\.md/],
    ['acceptance verifier', { ...GREEN_RUN, acceptance: null, park: PARK_OK }, /acceptance-review-block-a-r\d+\.md/],
  ]) {
    const { labels, prompt } = await run(respond, ONE_BLOCK);
    ok(!labels.includes('develop block-a r2'), `no second develop round after a dead ${role}`);
    ok(!file.test(prompt('park:block-a')), `and park names no ${role} file`);
  }
  // A round-1 review WAS written, so park may cite it, but never the round-2 file the dead agent owed.
  const { prompt } = await run({
    develop: DEV_OK, quality: firstRound(FLAGGED, null), acceptance: ACC_PASS, park: PARK_OK,
  }, ONE_BLOCK);
  const p = prompt('park:block-a');
  ok(p.includes('quality-review-block-a-r1.md'), 'park cites the review file round 1 did write');
  ok(!p.includes('quality-review-block-a-r2.md'), 'and not the one the dead round-2 reviewer never wrote');
}

section('a developer that dies in round 2 is reported as a death, not a red gate');
// From round 2 no round-1 precondition runs, so an unguarded null falls through to the gate check and
// reads `build=undefined` as a build failure that never happened.
{
  for (const [frame, args, first, acceptance] of [
    ['feature', ONE_BLOCK, DEV_OK, ACC_PASS],
    ['fix', FIX_ONE, fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), FIX_PASS],
  ]) {
    const { out, logs, labels } = await run({
      develop: firstRound(first, null), quality: firstRound(FLAGGED, CLEAN), acceptance, park: PARK_OK,
    }, args);
    const id = args.plans[0].id;
    eq(out.status, 'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)', `${frame}: status`);
    ok(/returned nothing in round 2/.test(out.haltReason), `${frame}: the reason names the round the agent died in`);
    ok(!logs.some((l) => /not satisfied/.test(l)), `${frame}: no gate-miss line for a gate nobody ran`);
    eq(out.ledger[0].status, 'BLOCKED (agent died)', `${frame}: the ledger says the agent died`);
    ok(labels.includes(`park:${id}`), `${frame}: round 1's work is parked`);
  }
}

// ---------------------------------------------------------------------------------------------
// MATRIX 6a/6b and the amendment protocol, in every mode's frame
// ---------------------------------------------------------------------------------------------
const bus = await run(GREEN_RUN);
const fixBus = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
const FRAMES = [['feature', 'block-a', bus], ['section', 'block-b', bus], ['fix', 'fix-a', fixBus]];
const flat = (s) => s.replace(/\s+/g, ' ');

section('MATRIX case 6 is SPLIT in every mode: 6a fixes a VERIFIED plan defect, 6b keeps the drop');
// The plan-defect wedge: a finding that indicts the plan's own prescription routed to a DROP, the
// reviewer re-raised it as CONTESTS DISMISSAL, and the round budget burned with neither side converging.
{
  for (const [mode, id, r] of FRAMES) {
    const dev = r.prompt(`develop ${id}`);
    ok(/6a\. Conflicts with the plan AND you VERIFIED/.test(dev), `${mode}: 6a exists and is gated on verification`);
    ok(/the verified defect outranks the\s+prescription/.test(dev), `${mode}: the verified defect outranks the prescription`);
    const quoted = dev.match(/that verified defect also outranks the "([^"]+)"\s+instruction above and the CONVENTIONS rubric/)?.[1] ?? '';
    ok(quoted !== '', `${mode}: the PRECEDENCE clause names a scope line and the CONVENTIONS rubric`);
    ok(quoted !== '' && flat(dev.slice(0, dev.indexOf('PRECEDENCE —'))).includes(flat(quoted)),
      `${mode}: and the frame carries that scope line above it: "${quoted}"`);
    ok(/Everywhere else the plan and the conventions\s+still bind/.test(dev), `${mode}: the override is confined to that clause`);
    ok(/6b\. Conflicts with the plan but you did NOT verify it/.test(dev), `${mode}: 6b keeps the unverified case a DROP`);
    ok(dev.includes(`DROP (1 or 6b): append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md`),
      `${mode}: LOGGING routes the DROP at 6b, not the whole of 6`);
    ok(/7\. A genuine DESIGN\/BUSINESS choice only the USER can make/.test(dev), `${mode}: ESCALATE (case 7) is intact`);
  }
}

section('an amendment is RECORDED in a per-block AMENDED file, with a pointer line for the user');
{
  for (const [mode, id, r] of FRAMES) {
    const dev = r.prompt(`develop ${id}`);
    ok(dev.includes(`AMEND (6a): append ONE entry to ${STATE}/AMENDED-${id}.md`), `${mode}: the record is the per-block AMENDED file`);
    ok(dev.includes(`## Plan amendment: ${id} r1`), `${mode}: the entry heading carries the round`);
    ok(/QUOTED verbatim/.test(dev) && /file:line \+ one line on why it is\s+real/.test(dev) && /what you built instead/.test(dev),
      `${mode}: the entry demands the overridden clause, the defect evidence and what was built`);
    ok(dev.includes(`ONE POINTER line to ${STATE}/NEEDS-USER.md`) && /NO plan text/.test(dev),
      `${mode}: NEEDS-USER gets a pointer line only, no plan text`);
    ok(/Count every entry you wrote in plan_amendments/.test(dev), `${mode}: the count is reported through the schema`);
  }
}

section('case 7 proceeding also writes an ESCALATED: line to the ledger the blind reviewer reads');
// The blind reviewer is not handed NEEDS-USER.md, so without this line it flags the developer's default
// every round and a block that should accept parks.
{
  for (const [mode, id, r] of FRAMES) {
    const dev = r.prompt(`develop ${id}`);
    const esc = dev.slice(dev.indexOf('ESCALATE (7):'));
    ok(esc.includes(`append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md`), `${mode}: case 7 writes the gate-scoped ledger`);
    ok(/ESCALATED: <the default you took/.test(esc), `${mode}: the line states the default taken`);
    ok(esc.includes(`the blind reviewer is NOT shown ${STATE}/NEEDS-USER.md`), `${mode}: with the reason attached`);
  }
}

section('a dismissal reason and a prose-only diff are both judged from the code alone');
// The blind reviewer reads the DISMISSED ledger but never the plan, so a reason citing a plan id is opaque.
{
  for (const [mode, id, r] of FRAMES) {
    const drop = r.prompt(`develop ${id}`).split('• DROP (1 or 6b):')[1]?.split('• AMEND (6a)')[0] ?? '';
    ok(/decidable from the code alone: never\s+cite a plan id, block id, issue id or plan clause/.test(drop),
      `${mode}: a DROP reason never cites the plan`);
  }
  const q = (await run(GREEN_RUN)).prompt('quality block-a');
  ok(/A diff that changes ONLY comments or string text has three checkable defects/.test(q)
    && q.includes('git -C E:/repo diff --word-diff') && /Whether the wording reads well is out of scope/.test(q),
    'the blind reviewer has a bar for a comment- or string-only diff');
}

section('the blind reviewer never hears of an amendment; only it carries CONTESTS DISMISSAL');
// An amendment quotes the plan verbatim (#3). The acceptance schema has no contest field, so a contest
// paragraph there would ask for a report nothing reads.
{
  for (const [mode, id, r] of FRAMES) {
    const q = r.prompt(`quality ${id}`);
    ok(q !== '' && !/AMENDED/.test(q) && !/amendment/i.test(q), `${mode}: the blind prompt names no AMENDED file and no amendment`);
    ok(/CONTESTS DISMISSAL/.test(q), `${mode}: the blind reviewer, whose schema carries a contest count, keeps the paragraph`);
    ok(!/CONTESTS DISMISSAL/.test(r.prompt(`acceptance ${id}`)), `${mode}: acceptance does not`);
  }
}

section('acceptance judges an amended criterion against the AMENDED behavior, with evidence or not at all');
{
  for (const [mode, id, r] of FRAMES) {
    const a = r.prompt(`acceptance ${id}`);
    const [unit, superseded, unmet] = mode === 'fix'
      ? ['issue', 'one', /stays actually_fixed=false/]
      : ['criterion', 'clause', /stays UNMET/];
    ok(a.includes(`READ ${STATE}/AMENDED-${id}.md if it exists`), `${mode}: acceptance is told to read the record`);
    ok(a.includes(`against the AMENDED behavior, not the superseded ${superseded}`), `${mode}: and to judge against what was built`);
    ok(new RegExp(`NAME every ${unit} you\\s+judged under an amendment in your review file`).test(a), `${mode}: each such ${unit} is named`);
    ok(/states NO defect evidence excuses\s+NOTHING/.test(a) && unmet.test(a), `${mode}: an evidence-free amendment excuses nothing`);
  }
}

section('acceptance counts every defect it writes, in every mode: a prescribed or unreached regression is a gap, and the rest is dropped');
// An uncounted notes section is a channel no agent reads on a pass, so a waived regression staged unseen.
{
  for (const [mode, id, r] of FRAMES) {
    const a = flat(r.prompt(`acceptance ${id}`));
    ok(a.includes('EVERY DEFECT YOU WRITE COUNTS.'), `${mode}: every defect acceptance writes counts`);
    ok(a.includes('a third-party one included'), `${mode}: a third-party caller's behavior is in the regression bar`);
    ok(a.includes('suite rule allows to be red is not a regression'), `${mode}: a suite-allowed red test is not a regression`);
    ok(a.includes('prescribes the construction that causes it'), `${mode}: a prescribed regression still counts`);
    ok(a.includes('unreached by any current caller'), `${mode}: an unreached regression still counts`);
    ok(a.includes("Those calls are the developer's, never yours."), `${mode}: the call on a counted regression is the developer's`);
    ok(a.includes("escalates it when the fix needs major changes outside this block's scope"), `${mode}: the developer's only waiver is an escalation`);
    ok(!a.includes('dismiss or escalate'), `${mode}: a counted regression is never the developer's to dismiss`);
    ok(flat(r.prompt(`develop ${id}`)).includes('A REGRESSION the acceptance review counted is a bug, so never DROP it under 1 or 6b.'),
      `${mode}: the developer's MATRIX never drops a counted regression`);
    ok(a.includes('the OVERRIDE rule above governs it'), `${mode}: a ledgered one falls to the OVERRIDE rule`);
    ok(a.includes('Drop any other concern silently.'), `${mode}: anything below the bar is dropped`);
    ok(a.includes('Your file holds no notes, observations or non-blocking section.'), `${mode}: the review file has no uncounted section`);
    if (mode !== 'fix') continue;
    // The gap list ends in "drop silently", so a fail condition a step states but the list omits passes.
    ok(a.includes('an ACTIONABLE entry reported SKIPPED, a touched entry'), 'fix: an ACTIONABLE entry reported SKIPPED is a gap');
    ok(a.includes('a non-empty diff with no FIXED claim'), 'fix: a non-empty diff with no FIXED claim is a gap');
    ok(a.includes('a gate not satisfied, or a regression'), 'fix: an unsatisfied gate, unavailable tool included, is a gap');
  }
}

section('a recorded amendment is logged, summed into the ledger and named in followups; zero is silent');
// `plan_amendments` is REQUIRED so "none" is an explicit claim, which only means something if the engine
// reads it (tests/CLAUDE.md §3).
{
  const one = await run({ ...GREEN_RUN, develop: { ...DEV_OK, plan_amendments: 1 } });
  ok(one.logs.some((l) => /⚠ block-a r1: 1 plan amendment\(s\) recorded — see E:\/r\/runs\/t\/AMENDED-block-a\.md/.test(l)),
    'the amendment is logged with the file that holds it');
  eq(one.out.ledger[0].planAmendments, 1, 'counted into the block\'s ledger record');
  ok(/PLAN AMENDED for: block-a, block-b/.test(one.out.followups), 'and followups names every amended block');

  const summed = await run({
    develop: firstRound({ ...DEV_OK, plan_amendments: 1 }, { ...DEV_OK, plan_amendments: 2 }),
    quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS,
  }, ONE_BLOCK);
  eq(summed.out.ledger[0].planAmendments, 3, 'rounds SUM into the ledger, never last-write-wins');

  const none = await run(GREEN_RUN);
  ok(!none.logs.some((l) => /plan amendment\(s\) recorded/.test(l)), 'a zero report logs nothing');
  eq(none.out.ledger[0].planAmendments, 0, 'the ledger record still carries the field');
  ok(!/PLAN AMENDED/.test(none.out.followups), 'and followups says nothing about amendments');
}

// ---------------------------------------------------------------------------------------------
// statusSync — the plan-file edits a run logs for `tools/plan-edit.mjs args` to apply
// ---------------------------------------------------------------------------------------------
// A wrong value here corrupts the selection truth the next launch builds from.

section('statusSync maps every block terminal to done, parked or blocked, and skips blocks never reached');
{
  const accepted = await run(GREEN_RUN, ONE_BLOCK);
  eq(JSON.stringify(accepted.out.statusSync), JSON.stringify([{ planPath: 'E:/plans/bus.md', id: 'block-a', key: 'status', value: 'done' }]),
    'an accepted block is done, with its absolute planPath and the status key');

  const parked = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 });
  eq(syncOf(parked.out), 'block-a=parked', 'a park over the round budget is parked');

  const halted = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, { ...baseArgs, ordered: true });
  eq(syncOf(halted.out), 'block-a=blocked', 'an ordered needs-user halt is blocked, and block-b, never reached, has no edit');

  const ordered = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...baseArgs, ordered: true, maxRounds: 1 });
  eq(syncOf(ordered.out), 'block-a=parked', 'an ordered park stops the run, and the block after it has no edit');

  const regressed = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, regression: true } });
  eq(syncOf(regressed.out), 'block-a=blocked', 'staged with a self-reported regression is blocked, never done');

  const unsafe = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, cleared: false } }, { ...ONE_BLOCK, maxRounds: 1 });
  eq(syncOf(unsafe.out), 'block-a=blocked', 'a park that left the tree unsafe is blocked, not parked');

  const dirty = await run({ develop: { ...DEV_OK, baseline_dirty_files: 2 } });
  eq(syncOf(dirty.out), 'block-a=blocked', 'a dirty baseline changed nothing and is still blocked, so the operator sees it');

  const none = await run({}, { ...baseArgs, plans: BLOCKS.map((b) => ({ ...b, status: 'done' })) });
  eq(JSON.stringify(none.out.statusSync), '[]', 'a run with nothing to build returns no edits');
}

section('statusSync maps each fix entry by its report AND by whether its block landed');
{
  const allStale = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'STALE' }, { issue_id: 'i-2', status: 'STALE' }]),
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: true }] },
  }, FIX_ONE);
  eq(syncOf(allStale.out), 'fix-a=done,i-1=stale,i-2=stale', 'an all-stale block acceptance confirmed is done and each entry stale');

  const noChanges = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }, { issue_id: 'i-2', status: 'STALE' }]) }, FIX_ONE);
  eq(syncOf(noChanges.out), 'fix-a=blocked,i-2=needs-attention',
    'a no-changes block is blocked, its unchecked STALE entry needs-attention, its SKIPPED entry untouched');

  // Quality never clean at the round budget: the block parks before acceptance, so no reviewer checked the STALE claim.
  const unchecked = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'STALE' }]),
    quality: FLAGGED, park: PARK_OK,
  }, { ...FIX_ONE, maxRounds: 1 });
  eq(unchecked.byLabel('acceptance').length, 0, 'the park path never reached acceptance');
  eq(syncOf(unchecked.out), 'fix-a=parked,i-1=needs-attention,i-2=needs-attention',
    'a STALE entry in a block parked before acceptance is needs-attention, never stale');

  const parked = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FAILED' }]),
    quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK,
  }, { ...FIX_ONE, maxRounds: 1 });
  eq(syncOf(parked.out), 'fix-a=parked,i-1=needs-attention,i-2=needs-attention',
    'a parked block\'s FIXED entry is needs-attention: its fix sits in a patch, never landed');

  const accepted = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'STALE' }, { issue_id: 'i-3', status: 'SKIPPED' }]),
    quality: CLEAN, acceptance: FIX_PASS,
  }, FIX_ONE);
  eq(syncOf(accepted.out), 'fix-a=done,i-1=fixed,i-2=stale', 'an accepted block: FIXED is fixed, STALE is stale, SKIPPED has no edit');

  // Acceptance's own fix_check says the root cause is still open. Synced fixed, the residual defect would
  // drop out of every later selection while the record says it was closed.
  const unclosed = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]),
    quality: CLEAN, acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: false }] },
  }, FIX_ONE);
  ok(unclosed.out.statusSync.some((e) => e.id === 'i-1' && e.value === 'needs-attention'),
    'a landed FIXED entry its fix_check calls unclosed is needs-attention, never fixed');
  eq(syncOf(unclosed.out), 'fix-a=done,i-1=needs-attention', 'while the block itself still lands done');
}

section('a block whose status edits outgrow one log line logs them over several lines, each under the cap');
{
  const ids = Array.from({ length: 100 }, (_, i) => `i-${i + 1}`);
  const { out, logs } = await run({
    develop: fixDev(ids.map((issue_id) => ({ issue_id, status: 'FIXED' }))),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: ids.map((issue_id) => ({ issue_id, actually_fixed: true })) },
  }, { ...FIX_ONE, planPath: 'E:/' + 'deep/'.repeat(20) + 'inventory.md' });
  const oneLine = 'status-sync ' + JSON.stringify(out.statusSync);
  ok(oneLine.length > 11024, `the edits as one line pass the runtime's 11,024-char cut: ${oneLine.length}`);
  const lines = logs.filter((l) => l.startsWith('status-sync '));
  ok(lines.length > 1, `they log over several lines: ${lines.length}`);
  ok(lines.every((l) => l.length <= 10000), `each line is at most 10,000 chars: ${lines.map((l) => l.length).join(', ')}`);
  ok(JSON.stringify(lines.flatMap((l) => JSON.parse(l.slice('status-sync '.length)))) === JSON.stringify(out.statusSync),
    'and the lines concatenated hold every edit in order');

  const few = await run(GREEN_RUN, ONE_BLOCK);
  eq(few.logs.filter((l) => l.startsWith('status-sync ')).length, 1, 'a block with few edits logs exactly one line');
}

const idsWithoutKeptStatus = (logs, ids) => {
  const kept = new Set(logs.slice(0, 1000).filter((l) => l.startsWith('status-sync '))
    .flatMap((l) => JSON.parse(l.slice('status-sync '.length)).map((e) => e.id)));
  return ids.filter((id) => !kept.has(id));
};

section('a run past the log budget still logs every status line inside the runtime\'s first 1,000');
// 300 one-round blocks log 1,202 lines unbudgeted. 200 log 802, which never reach the budget.
{
  const NOTICE = 'develop: log budget of 900 lines reached, progress lines suppressed, status lines continue';
  const plans = Array.from({ length: 300 }, (_, i) => ({ id: `block-${i + 1}`, mode: 'feature', gate: 'build-only' }));
  const { out, logs } = await run(GREEN_RUN, { ...baseArgs, plans });
  eq(out.plansDone.length, plans.length, 'every block is done');
  eq(logs.filter((l) => l === NOTICE).length, 1, 'the logs hold the notice line once');
  const missing = idsWithoutKeptStatus(logs, plans.map((p) => p.id));
  eq(missing.length, 0, `the first 1,000 lines hold a status line for every block${missing.length ? `, first miss ${missing[0]}` : ''}`);
  ok(logs.length <= 1000, `the logs number at most 1,000: ${logs.length}`);

  ok(!(await run(GREEN_RUN, ONE_BLOCK)).logs.includes(NOTICE), 'a short run logs no notice line');
}

section('a run whose status lines would outgrow the runtime\'s first 1,000 halts before the block that would lose one');
// 400 one-round blocks log 1,077 lines under the progress budget alone, so blocks 324 to 400 lose their status lines.
{
  const plans = Array.from({ length: 400 }, (_, i) => ({ id: `block-${i + 1}`, mode: 'feature', gate: 'build-only' }));
  const { out, logs } = await run(GREEN_RUN, { ...baseArgs, plans });
  eq(out.status, 'stopped on the runtime log line cap (resume where it left off)', 'the run halts on the log line cap');
  const next = plans[out.plansDone.length]?.id;
  ok(out.plansDone.length > 0 && next, `the halt falls mid-run: ${out.plansDone.length} block(s) done`);
  ok(out.haltReason.includes(`startAt:"${next}"`), `the halt reason resumes at the first block not run: ${next}`);
  const missing = idsWithoutKeptStatus(logs, out.plansDone);
  eq(missing.length, 0, `the first 1,000 lines hold a status line for every finished block${missing.length ? `, first miss ${missing[0]}` : ''}`);
  ok(logs.length <= 1000, `the logs number at most 1,000: ${logs.length}`);
}

section('a last block whose status lines overrun the runtime\'s first 1,000 returns them before any sweep runs');
// 322 one-round blocks leave room for one status line, and 200 fixed issues need two, so the last
// block's status lines overrun the cap. Awaiting the sweep after that leaves a stop that loses them.
{
  const ids = Array.from({ length: 200 }, (_, i) => `i-${i + 1}`);
  const plans = [...Array.from({ length: 322 }, (_, i) => ({ id: `block-${i + 1}`, mode: 'feature', gate: 'build-only' })),
    { id: 'fix-z', mode: 'fix', gate: 'green' }];
  const { out, logs, labels } = await run({
    ...GREEN_RUN,
    'develop fix-z': fixDev(ids.map((issue_id) => ({ issue_id, status: 'FIXED' }))),
    'acceptance fix-z': { ...FIX_PASS, fix_checks: ids.map((issue_id) => ({ issue_id, actually_fixed: true })) },
    'final-sweep': SWEEP_OK,
  }, { ...baseArgs, sweep: 'goal-coverage', goal: 'g', plans });
  ok(logs.slice(1000).some((l) => l.startsWith('status-sync ')), `the last block's status lines overrun the cap: ${logs.length} lines`);
  eq(out.plansDone.length, plans.length, 'every block is done');
  ok(!labels.includes('final-sweep'), 'the run spawns no sweep after the overrun');
  eq(out.status, 'stopped on the runtime log line cap (resume where it left off)', 'it halts on the log line cap');
  ok(/goal-coverage sweep/.test(out.haltReason) && /verify coverage against the goal yourself/.test(out.haltReason),
    `the halt reason says the sweep did not run: ${out.haltReason.slice(0, 60)}`);
  const fixed = out.statusSync.filter((e) => ids.includes(e.id) && e.value === 'fixed').length;
  eq(fixed, ids.length, 'the returned statuses close every fixed issue');
}

section('an entry claimed FIXED and re-reported STALE is only closed if its block lands');
// Round 2 reads round 1's own unstaged fix and honestly reports STALE. Synced as stale, a parked block
// would drop the entry from the inventory while its fix sits in a patch nobody applied.
{
  const reports = {
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([{ issue_id: 'i-1', status: 'STALE' }], { entries_found: -1 })),
    quality: firstRound(FLAGGED, CLEAN),
  };
  const parked = await run({ ...reports, acceptance: FIX_GAP, park: PARK_OK }, { ...FIX_ONE, maxRounds: 2 });
  eq(syncOf(parked.out), 'fix-a=parked,i-1=needs-attention', 'parked: needs-attention, never stale');
  const landed = await run({ ...reports, acceptance: FIX_PASS }, FIX_ONE);
  eq(syncOf(landed.out), 'fix-a=done,i-1=fixed', 'landed: fixed, since this run closed it');
}

section('acceptance is handed STALE and SKIPPED ids beside the FIXED list, and confirms each STALE claim');
// statusSync closes a STALE entry as `stale`. Unshown to acceptance, a live defect the developer wrongly
// called STALE would close with no reviewer check.
{
  const { prompt } = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'STALE' }, { issue_id: 'i-3', status: 'SKIPPED' }]),
    quality: CLEAN, acceptance: FIX_PASS,
  }, FIX_ONE);
  const acc = prompt('acceptance fix-a');
  ok(/claims these issues FIXED:\n\s+- i-1\n/.test(acc), 'the FIXED list carries only the fixed id');
  ok(/reports these issues STALE[^\n]*\n\s+- i-2\n/.test(acc), 'the STALE id is listed for confirmation');
  ok(/reports these issues SKIPPED:\n\s+- i-3\n/.test(acc), 'the SKIPPED id is listed for the triage check');
  ok(/STALE\s+claim you cannot confirm is actually_fixed=false and fails acceptance/.test(acc),
    'an unconfirmed STALE claim fails acceptance like an unclosed FIXED claim');
}
{
  const reports = { develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'STALE' }]), quality: CLEAN };
  const refuted = [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: false }];
  const failed = await run({ ...reports, acceptance: { ...FIX_GAP, fix_checks: refuted }, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 });
  eq(syncOf(failed.out), 'fix-a=parked,i-1=needs-attention,i-2=needs-attention',
    'a refuted STALE claim in a block that never lands is needs-attention, never stale');
  const passed = await run({ ...reports, acceptance: { ...FIX_PASS, fix_checks: refuted } }, FIX_ONE);
  ok(passed.out.ledger[0].contradicted === true, 'a pass carrying a refuted STALE check contradicts itself');
  eq(syncOf(passed.out), 'fix-a=done,i-1=fixed,i-2=needs-attention', 'and the refuted entry never syncs stale');
  const thin = await run({ ...reports, acceptance: FIX_PASS }, FIX_ONE);
  ok(thin.logs.some((l) => /THIN EVIDENCE \(1 check\(s\) for 1 claimed fix\(es\) and 1 stale claim\(s\)\)/.test(l)),
    'a pass with no check behind a STALE claim is flagged thin');
}

section('the block command is role-neutral: acceptance is never told to implement it');
// planRef hands the same text to the developer and to the verifier, whose prompt forbids modifying source.
{
  for (const args of [ONE_BLOCK, { ...baseArgs, plans: [{ ...BLOCKS[0], planContext: 'full' }] }, FIX_ONE]) {
    const { prompt } = await run({ ...GREEN_RUN, develop: args === FIX_ONE ? fixDev([{ issue_id: 'i-1', status: 'FIXED' }]) : DEV_OK, acceptance: args === FIX_ONE ? FIX_PASS : ACC_PASS }, args);
    const id = args.plans[0].id;
    const acc = prompt(`acceptance ${id}`);
    ok(acc !== '' && !/implement EXACTLY|implement ONLY/.test(acc), `${id} (${args.plans[0].planContext ?? 'block'}): acceptance is not told to implement`);
    ok(/you never implement it/.test(acc), 'and it is told it judges against the block');
    ok(/Implement the |Resolve the verified issues in /.test(prompt(`develop ${id}`)), 'while the developer role still builds it');
  }
}

section('the blind reviewer is told the gate commands and which porcelain entries are this cycle\'s work');
{
  const { prompt } = await run({ develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS }, ONE_BLOCK);
  const r1 = prompt('quality block-a r1');
  const r2 = prompt('quality block-a r2');
  ok(/build: b\n\s+test:  t\n/.test(r1), 'the build and test commands are named');
  ok(/READ every untracked file \(`\?\?`\)/.test(r1) && !/`\?\?`\/`A`/.test(r1), 'new files are the untracked ?? entries, not a staged A');
  ok(/staged half of an `AM` or `MM` file is baseline/.test(r1), 'an AM/MM file\'s staged half is baseline');
  ok(/diff --stat/.test(r1), 'a large diff starts from --stat');
  ok(/In round 1 it exists only if the developer already declined something/.test(r1), 'round 1 explains an absent ledger');
  ok(r2 !== '' && !/In round 1 it exists only/.test(r2), 'round 2 drops the round-1 note');
  ok(r2.includes(`${STATE}/gate/DISMISSED-block-a.md`), 'and still points at the ledger');
  eq(stateRefsOutsideGate(r1 + r2).join(', '), '', 'no run-state path outside gate/ in either round');
}

section('tests_run_count counts what the runner reports, and a section block scopes by its test_selector line');
{
  const { calls, prompt } = await run({ ...GREEN_RUN }, { ...baseArgs, plans: [{ id: 'sec', mode: 'section', gate: 'green' }] });
  const desc = calls.find((c) => c.label.startsWith('develop sec')).opts.schema.properties.tests_run_count.description;
  ok(/tests, or of assertions/.test(desc) && /0 = nothing ran = a FALSE green/.test(desc), 'the field covers assertion-counting runners and keeps the 0 rule');
  ok(/use the block's `test_selector:` line when it has one, else the test gate/.test(prompt('develop sec')),
    'the developer is told where the selector comes from');
}

section('a fix-mode results item declares only the fields the engine reads');
// The ledger and statusSync read issue_id and status. Any other field is effort the fixer spends for nothing.
{
  const { calls } = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  const item = calls.find((c) => c.label.startsWith('develop fix-a')).opts.schema.properties.results.items;
  eq(Object.keys(item.properties).join(), 'issue_id,status', 'exactly issue_id and status');
  eq(item.required.join(), 'issue_id,status', 'both still required');
}

section('an ESCALATED dismissal is held by acceptance in every mode, and the hold wins over OVERRIDE');
// Case 7 applies to all three frames. Without the hold in one frame, acceptance fails the escalated
// default, the developer re-escalates, and the rounds spin to a park.
{
  const feat = await run(GREEN_RUN);
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  for (const [name, p] of [['feature', feat.prompt('acceptance')], ['fix', fix.prompt('acceptance')]]) {
    ok(/`ESCALATED:` line is a decision\nrouted to the user: hold it unless its stated reason is false\. The hold wins over this OVERRIDE/.test(p),
      `the ${name} acceptance frame holds an ESCALATED line`);
  }
}

section('a fix round with no FIXED claim must leave an empty diff, since no blind reviewer judged it');
{
  const { prompt } = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'STALE' }]),
    acceptance: FIX_PASS,
  }, FIX_ONE);
  ok(/NO FIXED CLAIM, NON-EMPTY DIFF: when the FIXED list in step 1 is empty, no blind reviewer judged the\n\s+tree, so the unstaged diff MUST be empty/.test(prompt('acceptance')),
    'acceptance fails a STALE-only round that left changes');
}

section('park stops only when a NON-empty diff cannot be saved; an empty diff is not a stop');
{
  const { prompt } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, pass: false, staged: false, gap_count: 1 }, park: PARK_OK }, { ...baseArgs, maxRounds: 1 });
  const pk = prompt('park');
  ok(/If the unstaged diff is NOT empty and step 1 cannot\nproduce a non-empty patch, STOP/.test(pk), 'the STOP rule is scoped to a non-empty diff');
  ok(/An already-empty diff is not a stop/.test(pk), 'and an empty tree follows step 1\'s skip');
}

// ---------------------------------------------------------------------------------------------
// Passes: several fix blocks built in one develop cycle
// ---------------------------------------------------------------------------------------------

const PASS = { id: 'fix-a-plus-1', mode: 'fix', gate: 'green', blocks: [
  { id: 'fix-a', planPath: 'E:/plans/one.md', issues: ['i-1', 'i-2'] },
  { id: 'fix-b', planPath: 'E:/plans/two.md', issues: ['i-3'] },
] };
const PASS_ARGS = { ...baseArgs, planPath: undefined, plans: [PASS] };
const passDev = (results) => ({ ...DEV_OK, produced: undefined, entries_found: results.length, results });

section('a pass hands every agent one command per member block, and edits each status in its own file');
{
  const { out, calls } = await run({
    develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'SKIPPED' }, { issue_id: 'i-3', status: 'FIXED' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-3', actually_fixed: true }] },
  }, PASS_ARGS);
  const devPrompt = calls.find((c) => c.label.startsWith('develop')).prompt;
  ok(devPrompt.includes("'E:/plans/one.md' 'fix-a'") && devPrompt.includes("'E:/plans/two.md' 'fix-b'"), 'the developer gets a plan-block command per member');
  ok(calls.find((c) => c.label.startsWith('acceptance')).prompt.includes("'E:/plans/two.md' 'fix-b'"), 'and so does acceptance');
  eq(calls.filter((c) => c.label.startsWith('develop')).length, 1, 'one developer builds the whole pass');
  eq(out.statusSync.map((e) => `${e.planPath.slice(-6)}:${e.id}=${e.value}`).join(','),
    'one.md:fix-a=done,two.md:fix-b=done,one.md:i-1=fixed,two.md:i-3=fixed', 'each member and each issue is edited in its own plan file');
}

section('an issue a pass member does not list gets no status edit, and the log says so');
{
  const { out, logs } = await run({
    develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'stray', status: 'FIXED' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'stray', actually_fixed: true }] },
  }, PASS_ARGS);
  ok(!out.statusSync.some((e) => e.id === 'stray'), 'no edit names the stray id');
  ok(logs.some((l) => /issue stray was reported FIXED but belongs to no block in this pass/.test(l)), 'and the log names it');
}

section('a malformed pass throws before any agent runs');
{
  const bad = (blocks, extra = {}) => ({ ...PASS_ARGS, plans: [{ ...PASS, blocks, ...extra }] });
  for (const [args, what] of [
    [bad(PASS.blocks, { mode: 'feature' }), 'a pass that is not fix mode'],
    [bad([PASS.blocks[0]]), 'a pass of one block'],
    [bad([PASS.blocks[0], { id: 'fix-b', planPath: 'E:/plans/two.md' }]), 'a member with no issue list'],
    [bad([PASS.blocks[0], { ...PASS.blocks[1], id: 'Fix B' }]), 'a member id that is not a slug'],
  ]) {
    ok(/pass entries \[fix-a-plus-1\] are malformed/.test(await throwsWith(ENGINE, { args, respond: {} })), what);
  }
  ok(/duplicate plan id\(s\) \[fix-a\]/.test(await throwsWith(ENGINE, { args: { ...PASS_ARGS, plans: [PASS, { id: 'fix-a', mode: 'fix', planPath: 'E:/plans/one.md' }] }, respond: {} })),
    'a member id that is also another entry\'s id');
}
