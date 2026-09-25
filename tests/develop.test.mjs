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
// The one dead-agent case kept below is an ORDERING fact none of those tables can see.
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
  eq(out.status, 'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)', 'status');
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
  // The other half of `produced || qualityOpen`: `produced` is per-ROUND while the unstaged diff is
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

section('a round-1 fix block where every entry is already STALE is done without any reviewer');
// The issues ARE closed in current code, so there is no diff to review, stage or park — an accepted
// outcome, not a failure. This is the branch the no-changes terminal below must never swallow.
{
  const { out, calls } = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'STALE' }, { issue_id: 'i-2', status: 'STALE' }]),
  }, FIX_ONE);
  eq(calls.length, 1, 'only the developer ran — no quality, no acceptance, no park');
  eq(out.ledger[0].status, 'all-stale', 'the ledger names the terminal');
  eq(out.plansDone.join(), 'fix-a', 'and the block counts DONE');
  eq(out.status, 'done (all blocks staged)', 'the run status reflects the accepted outcome');
  ok(out.halted === false, 'nothing halted');
}

section('a round-1 fix block that closed nothing is NOT done, and `ordered` decides whether the run stops');
// All-SKIPPED, a SKIPPED/STALE mix and an EMPTY array all closed zero issues, so the entries stay open and
// the block must never count done. Only the all-stale branch above may. Neither terminal parks: the
// developer changed nothing, so there is nothing to save and nothing to clear.
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
  eq(carry.out.status, 'roadmap complete with 1 plan(s) parked', 'status counts the parked block');

  const stop = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...baseArgs, ordered: true });
  ok(stop.labels.includes('park:block-a'), 'the SAME park still runs, so nothing is discarded');
  ok(!stop.labels.some((l) => l.includes('block-b')), 'but block-b never starts');
  eq(stop.out.status, 'halted (a block was parked — its work is saved to a patch; the blocks after it were not attempted)', 'ordered status');
  ok(/is SAVED to/.test(stop.out.haltReason) && /tree is CLEAN/.test(stop.out.haltReason),
    'halt reason states saved + clean');
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
  ok(/produced NO review file/.test(p), 'the prompt says outright that no review file exists');
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
  eq(planWarnings((await run(GREEN_RUN)).logs).length, 0, 'a plan file outside the repo draws nothing');
}
