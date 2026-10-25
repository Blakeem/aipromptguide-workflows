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
// An arg's own section here checks what its throw message says, which the sweep does not.
// The dead-agent cases kept below assert what that sweep cannot see: guard ordering, the next round
// never spawning, and a round-2 death.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, runEngine, runTrace, throwsWith, section, ok, eq } from './harness.mjs';
import { pinWriteNotes } from './role-map-pin.mjs';

const ENGINE = 'workflows/develop/develop-cycle.mjs';

// Two blocks, ONE OF EACH MODE: the developer and acceptance frames switch on it, and a single-mode
// table would never build the section frame. Both build-only, so the gate sections below can pick their
// own gate without fighting this baseline.
// `plan-edit.mjs args` prints a planPath on every row, and the engine has no default for a row without one.
const BUS = 'E:/plans/bus.md';
const onBus = (p) => ({ planPath: BUS, ...p });
const BLOCKS = [onBus({ id: 'block-a', mode: 'feature', gate: 'build-only' }),
  onBus({ id: 'block-b', mode: 'section', gate: 'build-only' })];
// The folder `project-settings.mjs backlog` prints, outside the target repo, as every launch passes.
const BACKLOG = 'E:/r/backlog/repo-0a1b2c3d';
// A copy of the engine's hash, so a change to the backlog file names that later runs share fails here. A file's
// id ends in the hash of its raw [runId, block id] pair, which holds for a runId and block id that are slugs.
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const backlogFileId = (id, runId = 't') => `${runId}-${id}-${fnv1a(JSON.stringify([runId, id]))}`;
const backlogFile = (id, runId) => `${BACKLOG}/${backlogFileId(id, runId)}.md`;
// The grep wording of both backlog writers: the dedup before an append, and the Closed-by lookup.
const GREP = (pathOf, nameAt) => `grep the *.md files in ${BACKLOG}/ for ${pathOf} and for the name of the function or identifier at ${nameAt}, and read each entry that a grep matches`;
const DEDUP = (item) => `Before you append, create ${BACKLOG}/ if it does not exist, then ${GREP('the path of the file the new entry names', `the ${item}`)}. Never append a ${item} that an entry there with "- status: open" or "- status: needs-attention" already holds. When the only entries that hold it say "- status: fixed" or "- status: stale", the ${item} is back in the code, so append a new entry whose **What:** names their ids.`;
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' }, backlogDir: BACKLOG, plans: BLOCKS };
const ONE_BLOCK = { ...baseArgs, plans: [BLOCKS[0]] };
const PRO_ONE_BLOCK = { ...ONE_BLOCK, changePolicy: 'proactive' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// Mirrors tools/flows/develop.flow.mjs, so "a healthy return" has one definition per engine.
const DEV_OK   = { baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false, plan_amendments: 0, backlog_entries: 0, backlog_blocks: [], review_needed: true };
const CLEAN    = { wrote_file: true, clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { wrote_file: true, clean: false, issue_count: 2, contested_dismissals: 0 };
const ACC_PASS = { wrote_file: true, pass: true, staged: true, earlier_reviews_read: 0, reachable: true, regression: false, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL = { wrote_file: true, pass: false, staged: false, earlier_reviews_read: 0, reachable: false, regression: false, evidence_recorded: true, gap_count: 2 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048 };
const SWEEP_OK = { wrote_file: true, complete: true, gap_count: 0, suite_result: 'green' };
const GREEN_RUN = { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);
const syncOf = (out) => out.statusSync.map((e) => `${e.id}=${e.value}`).join(',');
const flat = (s) => s.replace(/\s+/g, ' ');
// Both kinds of reason in the developer's DISMISSED file, as each acceptance frame names them.
const OVERRIDE_SKIPPED = 'A line whose reason starts `SKIPPED:` declines a finding, and the OVERRIDE applies to it.';
const HOLD_ESCALATED = 'A line whose reason starts `ESCALATED:` records a default routed to the user, and the hold applies to it: hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a held escalation never fails acceptance. Name it in your file as held.';
// The last DECIDE bullet of both acceptance frames, in a round that has a later round and in the closing pass.
const FAIL_NEXT_ROUND = '• Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.';
const FAIL_PARKS = '• Otherwise → return pass=false (do NOT stage); the block parks, with your review file as its diagnosis.';
// The bullet fixes a regression at any tier under both policies, and escalates only one that only a change in other code closes.
// The bullet also names where a prescribed construction's regression goes, in each mode's own word for the prescriber.
const PRESCRIBER = { feature: "the block's text", section: "the block's text", fix: "an entry's **Fix:** line" };
const REGRESSION_BULLET = (mode) => `• A REGRESSION that any review of this block names, a blind review included, that the acceptance review counted, or that your SELF-REVIEW found is a bug, so never DROP it under 1, 2, 6b or 8. FIX it at any tier (6a when the fix conflicts with the plan), or ESCALATE it (7) with the default you took when only a change in other code closes it. A regression that a construction ${PRESCRIBER[mode]} prescribes causes is fixed under 6a, with an amendment that cites the regression as its defect evidence. When that fix would change a choice that ${PRESCRIBER[mode]} says the user made, it goes to rule 7's branch that cannot proceed, so the block parks with the user's question in ${STATE}/NEEDS-USER.md.`;
const REGRESSION_DEF = "A regression here is a behavior of the accepted baseline that the acceptance check below counts as regressed, or a comment or doc sentence that was true in the accepted baseline and that this cycle's diff made false.";
const OWNED_CODE = 'in code no other block of the plan owns';
// The engine's one zone map, which every developer and acceptance prompt renders.
const TASK_CODE = {
  feature: "the code this block's required changes add or change. Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding",
  section: "the code this block's required changes add or change. Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding",
  fix: "the code each ACTIONABLE entry's fix adds or changes, and the sibling paths of each ACTIONABLE entry's root cause that lie in code this block's text does not exclude and in code no other block of the plan owns. Every line an ACTIONABLE entry's fix adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding",
};
const CODE_ZONES = (mode) => `CODE ZONES - every piece of code lies in one of three zones: - Task code: ${TASK_CODE[mode]}. - Connected code: the code a reach step from the task code finds, which is its callers and consumers, its sibling paths with the same mechanism, duplicates of the same logic, and the comments and docs that describe it, apart from code this block's text excludes or another block of the plan owns. - Other code: everything else.`;
// Only a proactive feature or section block may change connected code for a defect its diff neither introduces nor exposes.
const CHANGE_ZONES = {
  connected: 'in task code or in connected code',
  diffOnly: 'in task code, or in connected code where the change closes a defect the diff introduces or exposes',
};
const changeZones = (policy, mode) => (policy === 'proactive' && mode !== 'fix' ? CHANGE_ZONES.connected : CHANGE_ZONES.diffOnly);

// ---------------------------------------------------------------------------------------------
// Round preconditions, in the order the engine checks them
// ---------------------------------------------------------------------------------------------
section('a dirty baseline halts before any reviewer, and never parks the operator\'s work');
// Parking here would take the operator's own uncommitted changes hostage, and nothing was built anyway.
{
  const { out, calls, labels, logs } = await run({ develop: { ...DEV_OK, baseline_dirty_files: 4 } });
  eq(calls.length, 1, 'only the developer ran, no reviewer spawned');
  ok(logs.some((l) => /pre-existing unstaged\/untracked file\(s\).*never git stash/.test(l)) && !logs.some((l) => /stash -u/.test(l)),
    'the log line never prescribes git stash -u');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park the operator\'s changes');
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'status');
  eq(out.parked.length, 0, 'nothing in parked[]');
  ok(/4 file\(s\)/.test(out.haltReason), 'halt reason names the count');
  ok(/add -A/.test(out.haltReason) && /diff --binary > E:\/r\/runs\/t\/set-aside-<n>\.patch/.test(out.haltReason),
    'and gives both remedies');
  // develop keeps accepted blocks only in the index, and `git stash -u` resets the index to HEAD.
  ok(!/stash -u/.test(out.haltReason) && /unpathed `git reset`, `git rm` or `git stash` touches the index, which holds the accepted baseline/.test(out.haltReason),
    'the set-aside never stashes, and says why');
  // A fresh run has no state dir yet, so an unguarded failed save would be followed by the clear.
  ok(/mkdir -p E:\/r\/runs\/t/.test(out.haltReason)
    && out.haltReason.indexOf('stop and clear nothing') > out.haltReason.indexOf('diff --binary >')
    && out.haltReason.indexOf('stop and clear nothing') < out.haltReason.indexOf('checkout -- <files>'),
    'the set-aside creates the state dir and gates the clear on a non-empty saved patch');
  ok(/checkout -- <files>/.test(out.haltReason) && /rm -f -q -- <file>/.test(out.haltReason)
    && /`git -C E:\/repo diff --cached` is unchanged/.test(out.haltReason), 'it clears by path and confirms the index is unchanged');
  // The round-1 clean check counts every `??` file, so untracked build output left behind re-halts the relaunch.
  ok(out.haltReason.indexOf('remove the untracked build output and caches') > -1
    && out.haltReason.indexOf('remove the untracked build output and caches') < out.haltReason.indexOf('add -N -- <file>')
    && /confirm `git -C E:\/repo status --porcelain` lists no `\?\?` file/.test(out.haltReason),
    'the set-aside removes untracked build output first and confirms no untracked file is left');
  ok(/plain `git -C E:\/repo apply <patch>`, never `--3way`/.test(out.haltReason), 'its restore never stages');
  // A resume re-runs a killed round-1 developer live, whose clean-baseline check halts on its own partial work.
  ok(!/resumeFromRunId/.test(out.haltReason), 'and never offers a cached replay');
  // The halt still syncs the block blocked, so a fresh args run would drop it unless it is flipped back.
  ok(/recorded the block as `blocked`/.test(out.haltReason)
    && /run `plan-edit\.mjs args` \(it applies that status\), set this block's `status:` back to `todo`, run `plan-edit\.mjs args` again/.test(out.haltReason),
    'and says to flip the block back to todo between two plan-edit.mjs args runs');
  ok(!/re-invoke this run unchanged|Nothing was built or changed/.test(out.haltReason), 'never says to re-invoke the same args');
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
    eq(out.status, 'BLOCKED (the developer did not confirm its work stayed out of the staged index, which neither reviewer reads)',
      `unstaged_confirmed ${what} halts`);
    ok(!/inspect/i.test(out.status) && /Inspect `git -C E:\/repo diff --cached` before resuming/.test(out.haltReason),
      'the inspect instruction lives in the halt reason, not the status');
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

section('fix mode: a later round cannot withdraw an earlier round\'s claimed fix from acceptance');
// The ledger holds the LATEST status per issue, but the acceptance verifier's claim list is MONOTONIC.
// The fixer re-verifies every entry each round, so in round 2 it reads its own round-1 fix and honestly
// reports STALE. A last-write-wins claim list would empty on that, leaving the root-cause re-derivation
// — the entire verification substance of the fix frame — with nothing to iterate over while round 1's
// unstaged diff is still there to be staged.
{
  const FIX_BLOCK = { ...baseArgs, plans: [onBus({ id: 'fix-a', mode: 'fix', gate: 'green' })] };
  const DEV_FIXED = { ...DEV_OK, results: [{ issue_id: 'i-1', status: 'FIXED' }] };
  const DEV_STALE = { ...DEV_OK, results: [{ issue_id: 'i-1', status: 'STALE' }] };
  const { out, prompt, logs } = await run({
    develop: firstRound(DEV_FIXED, DEV_STALE),
    quality: firstRound(FLAGGED, CLEAN),
    acceptance: { wrote_file: true, pass: true, staged: true, earlier_reviews_read: 1, regression: false, gap_count: 0, fix_checks: [], backlog_entries: 0, backlog_blocks: [] },
  }, FIX_BLOCK);
  ok(/- i-1/.test(prompt('acceptance')), 'round 2 still hands acceptance the id claimed FIXED in round 1');
  ok(!/none claimed fixed/.test(prompt('acceptance')), 'the claim list did not empty on the downgrade');
  ok(logs.some((l) => /THIN EVIDENCE \(0 check\(s\) for 1 claimed fix\(es\)\)/.test(l)),
    'a pass with no fix_check behind that claim is still flagged thin');
  eq(JSON.stringify(out.ledger[0].results), JSON.stringify([{ issue_id: 'i-1', status: 'STALE' }]),
    'the ledger still records the LATEST status per issue');
}

// ---------------------------------------------------------------------------------------------
// FIX mode — the derived `produced`, the round-1 no-changes terminal, and the gate a fix block may take
// Twins of tests/resolve.test.mjs's battery, ported to the block shape: resolve fans batches out of an
// issue inventory, this engine reads ONE block whose body IS the inventory, so the no-changes terminal
// moves from a batch record onto the ledger's per-block record.
// ---------------------------------------------------------------------------------------------
const FIX_ONE = { ...baseArgs, plans: [onBus({ id: 'fix-a', mode: 'fix', gate: 'green' })] };
// In fix mode the engine DERIVES whether a round changed anything from `results`.
const fixDev = (results, extra = {}) => ({ ...DEV_OK, results, ...extra });
const FIX_PASS = { wrote_file: true, pass: true, staged: true, earlier_reviews_read: 0, regression: false, gap_count: 0, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }], backlog_entries: 0, backlog_blocks: [] };
const FIX_GAP  = { wrote_file: true, pass: false, staged: false, earlier_reviews_read: 0, regression: false, gap_count: 1, fix_checks: [], backlog_entries: 0, backlog_blocks: [] };

const PASS = { id: 'fix-a-plus-1', mode: 'fix', gate: 'green', blocks: [
  { id: 'fix-a', planPath: 'E:/plans/one.md', issues: ['i-1', 'i-2'] },
  { id: 'fix-b', planPath: 'E:/plans/two.md', issues: ['i-3'] },
] };
const PASS_ARGS = { ...baseArgs, plans: [PASS] };
const passDev = (results) => ({ ...DEV_OK, results });

section('the developer\'s risk judgment decides when a later round gets a blind review, and a block\'s first round with a satisfied gate always gets one');
// A low-risk round goes from the developer straight to acceptance, which audits the judgment. The first
// round with a satisfied gate never rests on that judgment, nor on whether the developer changed anything.
{
  const LOW = { ...DEV_OK, review_needed: false };
  const reviewedBefore = (r, round) => {
    const at = r.labels.indexOf(`quality block-a r${round}`);
    return at >= 0 && at < r.labels.indexOf(`acceptance block-a r${round}`);
  };
  const first = await run({ ...GREEN_RUN, develop: LOW }, ONE_BLOCK);
  ok(reviewedBefore(first, 1), 'round 1 is reviewed before acceptance although its developer judged every change low risk');

  const low = await run({ develop: firstRound(DEV_OK, LOW), quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS }, ONE_BLOCK);
  ok(!low.labels.includes('quality block-a r2') && low.labels.includes('acceptance block-a r2'),
    'a later round whose developer returns review_needed false goes straight to acceptance');
  ok(low.logs.some((l) => /r2: the developer judged every change since the block's last blind review low risk → no blind review; acceptance audits the judgment/.test(l)),
    'and the log says why no blind review ran');
  eq(low.out.status, 'done (all blocks staged)', 'and acceptance stages it');

  for (const [what, value] of [['true', true], ['a string', 'no'], ['a missing value', undefined]]) {
    const r = await run({ develop: firstRound(DEV_OK, { ...DEV_OK, review_needed: value }), quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS }, ONE_BLOCK);
    ok(reviewedBefore(r, 2), `review_needed ${what} sends round 2 to a blind review before acceptance`);
    ok((typeof value === 'boolean') !== r.logs.some((l) => /r2: developer returned no risk judgment \(review_needed=.*\) → counted as needing a blind review/.test(l)),
      `review_needed ${what}: only a non-boolean logs that it counted as needing a review`);
  }

  // A round judged not low risk keeps the review owed past a red gate, until a blind review runs.
  const redBetween = await run({
    develop: (label) => (/r1$/.test(label) ? DEV_OK : /r2$/.test(label) ? { ...DEV_OK, build_passed: false } : LOW),
    quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS,
  }, ONE_BLOCK);
  ok(reviewedBefore(redBetween, 3), 'round 2\'s judgment, behind a red gate, still sends round 3 to a blind review');

  // Red gates before the block's first satisfied one leave it unreviewed, so that round gets the first review.
  const redFirst = await run({ develop: firstRound({ ...LOW, build_passed: false }, LOW), quality: CLEAN, acceptance: ACC_PASS }, ONE_BLOCK);
  ok(reviewedBefore(redFirst, 2), 'round 2, the first with a satisfied gate, is reviewed although judged low risk');

  // A risk_misclassified verdict sends the next round to a blind review, and that review clears it.
  const accBy = (verdicts) => (label) => verdicts[Number(/r(\d+)$/.exec(label)?.[1]) - 1];
  const mis = await run({
    develop: firstRound(DEV_OK, LOW), quality: CLEAN,
    acceptance: accBy([ACC_FAIL, { ...ACC_FAIL, risk_misclassified: true }, ACC_FAIL, ACC_PASS]),
  }, ONE_BLOCK);
  ok(!mis.labels.includes('quality block-a r2') && reviewedBefore(mis, 3),
    'a round after a risk_misclassified verdict is reviewed although its developer judged it low risk');
  ok(!mis.logs.some((l) => /r3: acceptance found .*\[RISK MISCLASSIFIED\]/.test(l)), 'a later verdict that finds no wrong judgment carries no tag');
  ok(!mis.labels.includes('quality block-a r4') && mis.labels.includes('acceptance block-a r4'),
    'the blind review clears the verdict, so round 4 goes straight to acceptance');
  ok(mis.logs.some((l) => /r2: acceptance found 2 gap\(s\) \[RISK MISCLASSIFIED\] → develop addresses/.test(l)), 'the log marks the misclassified verdict');
  eq(mis.out.status, 'done (all blocks staged)', 'and the block lands');
}

section('acceptance audits the risk file of each round since the block\'s last blind review');
{
  const LOW = { ...DEV_OK, review_needed: false };
  const r = await run({ develop: LOW, quality: CLEAN, acceptance: (label) => (/r[12]$/.test(label) ? ACC_FAIL : ACC_PASS) }, ONE_BLOCK);
  const a1 = flat(r.prompt('acceptance block-a r1'));
  const a3 = flat(r.prompt('acceptance block-a r3'));
  ok(a1.includes("RISK AUDIT. This round's blind review judged the entire block diff, so no risk file needs an audit. Return risk_misclassified=false."),
    'a reviewed round has no risk file to audit');
  ok(a3.includes('developer judged each change low risk: E:/r/runs/t/risk-block-a-r2.md E:/r/runs/t/risk-block-a-r3.md The first line of each risk file') && !a3.includes('round 1'),
    'round 3\'s acceptance audits rounds 2 and 3, which no blind review judged, and not round 1, which one did');
  ok(a3.includes('round 2, base in E:/r/runs/t/risk-block-a-r1.md, snapshot in E:/r/runs/t/risk-block-a-r2.md: git -C E:/repo diff <base> <snapshot>')
    && a3.includes('round 3, base in E:/r/runs/t/risk-block-a-r2.md, snapshot in E:/r/runs/t/risk-block-a-r3.md: git -C E:/repo diff <base> <snapshot>'),
  'each audited round gets the command that shows its own hunks, from its snapshot and the snapshot of the round before it');
  ok(a3.includes('The first line of each risk file is `Snapshot: <tree id>`, a snapshot of the working tree after that round.')
    && a3.includes('<snapshot> and <base> are the tree ids on the first lines of the files named beside each command:')
    && a3.includes('check each answer it gives against the hunks of its own round under the RISK QUESTIONS below.'),
  'acceptance reads the tree ids from the risk files and checks each answer against its own round\'s hunks');
  ok(a3.includes('A missing file, a missing `Snapshot:` first line in an audited round\'s file or in the base file named beside its command, a change it does not judge low risk, and an answer the hunks contradict are each a gap. Write each one in your review file and return risk_misclassified=true, which sends the next round to a blind review.'),
    'a wrong, missing, snapshotless or not-low-risk answer is a gap that sets risk_misclassified');
  ok(a3.includes('RISK QUESTIONS - answer each one for a change:') && a3.includes('A doubtful answer counts as yes. A change is low risk when every answer is no.'),
    'the audit renders the same risk questions');
  ok(a3.includes('a failed risk audit, or a regression') && a3.includes('risk audit clean, no regression →'),
    'a failed risk audit is a gap, and a pass needs a clean one');
  ok(a3.includes('A gap for a wrong risk answer is closed, since the engine runs a blind review after the verdict that names it and before any later acceptance.'),
    'an earlier risk gap counts as closed');
  ok(a3.includes("This round's blind code review passed, or did not run because the developer judged each change since the block's last blind review low risk, which your RISK AUDIT checks.")
    && !/skipped because the developer changed nothing/.test(a3), 'the opening says why no blind review may have run');
  const accSchema = r.byLabel('acceptance block-a r3')[0]?.opts?.schema ?? {};
  ok(String(accSchema.required ?? '').includes('risk_misclassified') && accSchema.properties?.risk_misclassified?.type === 'boolean', 'risk_misclassified is a required boolean');
  const fixRun = await run({
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { review_needed: false })),
    quality: CLEAN, acceptance: firstRound(FIX_GAP, FIX_PASS),
  }, FIX_ONE);
  const fa2 = flat(fixRun.prompt('acceptance fix-a r2'));
  ok(fa2.includes('E:/r/runs/t/risk-fix-a-r2.md') && fa2.includes('6. RISK AUDIT.') && fa2.includes('a failed risk audit, or a regression')
    && String(fixRun.byLabel('acceptance fix-a r2')[0]?.opts?.schema?.required ?? '').includes('risk_misclassified'),
    'fix acceptance audits the risk file the same way');
  // DECIDE and the schema state one pass contract, so the schema's pass never omits the risk audit.
  const sectionSchema = (await run(GREEN_RUN)).byLabel('acceptance block-b r1')[0]?.opts?.schema;
  for (const [mode, schema] of [['feature', accSchema], ['section', sectionSchema], ['fix', fixRun.byLabel('acceptance fix-a r2')[0]?.opts?.schema]]) {
    ok(String(schema?.properties?.pass?.description ?? '').includes('the risk audit is clean, and nothing regressed'),
      `${mode}: the schema's pass contract names the risk audit, as DECIDE does`);
  }

  const dev = flat(r.prompt('develop block-a r2'));
  ok(dev.includes('CLASSIFY: judge the risk of each change this round made, in any phase, under the RISK QUESTIONS below. Write E:/r/runs/t/risk-block-a-r2.md')
    && dev.includes('Return review_needed=true when any change is not low risk, and false only when every change is low risk.')
    && dev.includes('RISK QUESTIONS - answer each one for a change:'),
    'the developer writes the risk file acceptance reads, and returns review_needed from it');
  const devSchema = r.byLabel('develop block-a r1')[0]?.opts?.schema ?? {};
  ok(String(devSchema.required ?? '').includes('review_needed') && devSchema.properties?.review_needed?.type === 'boolean' && !('produced' in (devSchema.properties ?? {})),
    'review_needed is a required boolean return, and produced is gone');
  ok(dev.includes('A gap for a wrong risk answer takes no fix and no log, since the blind review it triggers judges that change.'),
    'a round answering a review is told a risk gap holds no work');

  const passedMis = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, risk_misclassified: true } }, ONE_BLOCK);
  eq(passedMis.out.ledger[0].contradicted, true, 'a pass that reports risk_misclassified contradicts itself');
  ok(passedMis.logs.some((l) => /CONTRADICTS ITS OWN PASS \(.*risk_misclassified=true/.test(l)), 'and the log names the field');
}

section('every developer round records a snapshot of its tree in its risk file, through a temporary index');
// Git holds one cumulative unstaged diff, so the risk file's first line is the only record of where a round ended.
// The temporary index keeps `git add -A` from staging the block's work into the real index, the accepted baseline.
{
  const snapshotLines = (id, round, repo = 'E:/repo') => {
    const index = `E:/r/runs/t/scratch/snapshot-${id}-r${round}.index`;
    return [`cp "$(git -C ${repo} rev-parse --path-format=absolute --git-path index)" "${index}"`,
      `GIT_INDEX_FILE="${index}" git -C ${repo} add -A`, `GIT_INDEX_FILE="${index}" git -C ${repo} write-tree`].join(' ');
  };
  const FIRST_LINE = 'Its first line is `Snapshot: <tree id>`, the tree id of a snapshot of the working tree. Take the snapshot after your last change, with these commands, which write a temporary index file (create E:/r/runs/t/scratch/ if needed) and never the real index. The last command prints the tree id:';
  const pinned = (prompt, id, round, where) => {
    const text = flat(prompt);
    ok(text.includes(`${FIRST_LINE} ${snapshotLines(id, round)} After the first line, write one section per change`),
      `${where}: CLASSIFY writes the snapshot line first, made by the three commands with their own temporary index`);
  };

  const feat = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, baseArgs);
  pinned(feat.prompt('develop block-a r1'), 'block-a', 1, 'a feature round');
  pinned(feat.prompt('develop block-a r2'), 'block-a', 2, 'a feature round after a review');
  pinned(feat.prompt('develop block-b r1'), 'block-b', 1, 'a section round');
  const fixed = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  pinned(fixed.prompt('develop fix-a r1'), 'fix-a', 1, 'a fix round');
  const closed = await run({ develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK),
    quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, { ...ONE_BLOCK, maxRounds: 1 });
  pinned(closed.prompt('develop-closing block-a'), 'block-a', 2, 'the closing pass');

  // Run the rendered commands in a main checkout and in a linked worktree, across two rounds of edits.
  const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'aipg-develop-snapshot-'))).replace(/\\/g, '/');
  try {
    const git = (args, env = {}) => execFileSync('git', args, { env: { ...process.env, ...env }, encoding: 'utf8', stdio: 'pipe' }).trim();
    const main = `${tmp}/main`;
    mkdirSync(main);
    git(['-C', main, 'init', '-q', '.']);
    for (const [key, value] of [['user.email', 't@t'], ['user.name', 't'], ['core.autocrlf', 'false']]) git(['-C', main, 'config', key, value]);
    writeFileSync(`${main}/a.txt`, 'base\n');
    git(['-C', main, 'add', 'a.txt']);
    git(['-C', main, 'commit', '-q', '-m', 'init']);
    const linked = `${tmp}/linked`;
    git(['-C', main, 'worktree', 'add', '-q', linked, '-b', 'linked']);

    for (const [where, repo] of [['main checkout', main], ['linked worktree', linked]]) {
      const root = `${tmp}/root-${where.split(' ')[0]}`;
      mkdirSync(`${root}/runs/t/scratch`, { recursive: true });
      const run2 = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, { ...ONE_BLOCK, root, target: { repo } });
      const snapshot = (round) => {
        const m = run2.prompt(`develop block-a r${round}`).match(/^ {5}cp "\$\(git -C (\S+) rev-parse --path-format=absolute --git-path index\)" "([^"]+)"\n {5}GIT_INDEX_FILE="([^"]+)" git -C (\S+) add -A\n {5}GIT_INDEX_FILE="([^"]+)" git -C (\S+) write-tree$/m);
        ok(m && m[1] === repo && m[4] === repo && m[6] === repo && m[2] === m[3] && m[3] === m[5],
          `${where} round ${round}: the rendered commands name the repo and one temporary index`);
        if (!m) return null;
        const [, , , index] = m;
        const realIndex = git(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'index']);
        const before = readFileSync(realIndex);
        copyFileSync(realIndex, index);
        git(['-C', repo, 'add', '-A'], { GIT_INDEX_FILE: index });
        const tree = git(['-C', repo, 'write-tree'], { GIT_INDEX_FILE: index });
        ok(before.equals(readFileSync(realIndex)), `${where} round ${round}: the real index, the accepted baseline, is unchanged`);
        return tree;
      };

      // The accepted baseline, staged before round 1, belongs to neither round's hunks.
      writeFileSync(`${repo}/accepted.txt`, 'accepted\n');
      git(['-C', repo, 'add', 'accepted.txt']);
      writeFileSync(`${repo}/a.txt`, 'base\nround one\n');
      writeFileSync(`${repo}/one.txt`, 'one\n');
      git(['-C', repo, 'add', '-N', 'one.txt']);
      const first = snapshot(1);
      writeFileSync(`${repo}/a.txt`, 'base\nround one\nround two\n');
      writeFileSync(`${repo}/two.txt`, 'two\n');
      const second = snapshot(2);
      if (!first || !second) continue;

      eq(git(['-C', repo, 'diff', '--name-status', first, second]).replace(/\r/g, ''), 'M\ta.txt\nA\ttwo.txt',
        `${where}: the diff between the two snapshots holds the second round's change alone, a new untracked file included`);
      const hunks = git(['-C', repo, 'diff', first, second]);
      ok(/^\+round two$/m.test(hunks) && !/^[+-](round one|one)$/m.test(hunks),
        `${where}: and its hunks add no line of the first round`);
      eq(git(['-C', repo, 'diff', '--name-status', 'HEAD', first]).replace(/\r/g, '').split('\n').sort().join('\n'), 'A\taccepted.txt\nA\tone.txt\nM\ta.txt',
        `${where}: the first snapshot holds the accepted baseline and the first round's files, the new one included`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

section('a block whose last round fails gets one closing pass with no blind review');
// No round is left for a blind review, so the closing pass makes only low-risk fixes. It reaches acceptance
// only when it listed nothing and owes no review, and otherwise parks naming each listed entry.
{
  const CLOSING_OK = { ...DEV_OK, review_needed: false, recorded_entries: [] };
  const ONE_ROUND = { ...ONE_BLOCK, maxRounds: 1 };
  const develop = (closingReturn) => (label) => (label.startsWith('develop-closing') ? closingReturn : DEV_OK);
  const parkText = (r) => flat(r.prompt('park:block-a'));

  const lands = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS), park: PARK_OK }, ONE_ROUND);
  eq(lands.labels.join(), 'develop block-a r1,quality block-a r1,acceptance block-a r1,develop-closing block-a,acceptance block-a r2',
    'nothing recorded and no review owed: the closing pass goes straight to one more acceptance');
  eq(lands.out.status, 'done (all blocks staged)', 'whose pass stages the block');
  ok(lands.out.ledger[0].closingPass === true && lands.out.ledger[0].rounds === 1, 'the ledger marks the closing pass and keeps the round count');
  ok(lands.logs.some((l) => /round 1 ended without a passed acceptance → closing pass \(r2\), with no blind review after it/.test(l)), 'the log names the closing pass');
  const closer = flat(lands.prompt('develop-closing block-a'));
  ok(closer.includes('This is the closing pass, numbered round 2 in its file names, after round 1 of at most 1.')
    && closer.includes("so you are this block's CLOSING PASS, and no blind review follows you"),
    'the closing pass is told what it is and that no blind review follows');
  ok(closer.includes('BUILD: CLOSING PASS. READ E:/r/runs/t/acceptance-review-block-a-r1.md.')
    && closer.includes('Where the matrix says FIX and the fix is not low risk under the RISK QUESTIONS in CLASSIFY below, change no code for it.')
    && closer.includes('with a **Fix:** line naming the fix you would make')
    && closer.includes('list its id in recorded_entries, and write no DISMISSED line for it'),
    'it makes each low-risk fix and records the rest as backlog entries naming the fix');
  ok(closer.includes('or, in this closing pass, RECORDED as BUILD says'), 'the matrix counts a recorded finding as routed');
  ok(closer.includes('After that line, add the line "**Parked with:** block block-a. Triage this entry once that block is accepted in a later launch or dropped."'),
    'each recorded entry names the park that holds the code it describes');
  ok(closer.includes('When the dedup forbids the append, list the id of the entry that holds the item in recorded_entries instead.'),
    'an item an entry already holds is listed by that entry\'s id, not appended again');
  ok(closer.includes('Write E:/r/runs/t/risk-block-a-r2.md'), 'it writes its own risk file');
  const closingSchema = lands.byLabel('develop-closing block-a')[0]?.opts?.schema ?? {};
  ok(String(closingSchema.required ?? '').includes('recorded_entries')
    && !('recorded_entries' in (lands.byLabel('develop block-a r1')[0]?.opts?.schema?.properties ?? {})),
    'only the closing pass returns recorded_entries');
  ok(flat(lands.prompt('acceptance block-a r2')).includes('E:/r/runs/t/risk-block-a-r2.md'), 'the closing acceptance audits the closing pass\'s risk file');

  const fails = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(fails.labels.includes('acceptance block-a r2') && fails.labels.includes('park:block-a'), 'a failed closing acceptance parks the block');
  eq(fails.out.ledger[0].status, 'parked (not accepted within round budget)', 'as a budget park');
  ok(parkText(fails).includes('one line on why it was parked (what the closing acceptance was still failing)'), 'and the park record cites that acceptance');

  const recorded = await run({ develop: develop({ ...CLOSING_OK, recorded_entries: ['t-block-a-x-1'] }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(!recorded.labels.includes('acceptance block-a r2') && recorded.labels.includes('park:block-a'), 'a recorded entry parks the block with no acceptance');
  ok(parkText(recorded).includes('its closing pass parked it without acceptance: it listed 1 backlog entry whose fix needs a blind review')
    && parkText(recorded).includes('each backlog entry the closing pass listed, by its id: t-block-a-x-1.'),
    'and its park record names the entry and why');
  ok(recorded.logs.some((l) => /the closing pass parks the block without acceptance: it listed 1 backlog entry/.test(l)), 'the log says so');

  for (const [what, closingReturn, why] of [
    ['a change it judged not low risk', { ...CLOSING_OK, review_needed: true }, 'its changes owe a blind review, since a round since its last blind review judged a change not low risk or gave no judgment'],
    ['an unusable list of entries', { ...CLOSING_OK, recorded_entries: 'none' }, 'it returned no usable list of the backlog entries it listed'],
  ]) {
    const r = await run({ develop: develop(closingReturn), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
    ok(!r.labels.includes('acceptance block-a r2') && r.labels.includes('park:block-a') && parkText(r).includes(why),
      `${what}: the closing pass parks the block without acceptance, naming why`);
  }
  // No round is left to re-run a red gate, so the closing acceptance judges it.
  const redClose = await run({ develop: develop({ ...CLOSING_OK, build_passed: false }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  eq(redClose.labels.join(), 'develop block-a r1,quality block-a r1,acceptance block-a r1,develop-closing block-a,acceptance block-a r2,park:block-a',
    'a closing pass with a red gate still reaches the closing acceptance, then parks, with no extra round');
  const unlisted = await run({ develop: develop({ ...CLOSING_OK, recorded_entries: null }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(parkText(unlisted).includes(`so the user checks ${backlogFile('block-a')} for an entry whose fix needs a blind review`),
    'an unusable list points the park record at the block\'s backlog file');

  // A last verdict that found a risk judgment wrong, or a block never reviewed, leaves a review owed.
  const misLast = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: { ...ACC_FAIL, risk_misclassified: true }, park: PARK_OK }, ONE_ROUND);
  ok(!misLast.labels.includes('acceptance block-a r2') && parkText(misLast).includes('since an acceptance verdict found a risk judgment wrong'),
    'a misclassified last verdict parks the closing pass for a blind review');
  const passes = await run({ ...GREEN_RUN, develop: develop(CLOSING_OK) }, ONE_ROUND);
  ok(!passes.labels.includes('develop-closing block-a') && passes.out.ledger[0].closingPass === false, 'a block that passes in its last round runs no closing pass');
  const greenOnlyAtClose = (label) => (label.startsWith('develop-closing') ? CLOSING_OK : { ...DEV_OK, build_passed: false });
  const redAll = await run({ develop: greenOnlyAtClose, quality: CLEAN, acceptance: ACC_PASS, park: PARK_OK }, ONE_ROUND);
  ok(!redAll.labels.some((l) => l.startsWith('quality') || l.startsWith('acceptance')) && parkText(redAll).includes('since the block has had no blind review in this launch'),
    'a block whose gate went green only in its closing pass parks for its first blind review');
  const redOrdered = await run({ develop: greenOnlyAtClose, park: PARK_OK }, { ...ONE_ROUND, ordered: true });
  ok(/did not reach acceptance within 1 rounds and its closing pass, which parked it without acceptance: .*no round before its closing pass had a satisfied gate/.test(redOrdered.out.haltReason),
    'an ordered halt names the closing pass and why the block left no review file');

  const fixFixed = fixDev([{ issue_id: 'i-1', status: 'FIXED' }]);
  const fixClose = await run({
    develop: (label) => (label.startsWith('develop-closing') ? { ...fixFixed, review_needed: false, recorded_entries: [] } : fixFixed),
    quality: CLEAN, acceptance: firstRound(FIX_GAP, FIX_PASS),
  }, { ...FIX_ONE, maxRounds: 1 });
  eq(fixClose.out.status, 'done (all blocks staged)', 'a fix block reaches the closing acceptance the same way');
  ok(flat(fixClose.prompt('develop-closing fix-a')).includes('BUILD: CLOSING PASS.') && flat(fixClose.prompt('develop-closing fix-a')).includes('FIX ONLY the entries whose `- decision:` line says ACTIONABLE'),
    'and its closing pass keeps the entry rules');
  ok(flat(fixClose.prompt('acceptance fix-a r2')).includes(FAIL_PARKS) && !flat(fixClose.prompt('acceptance fix-a r2')).includes(FAIL_NEXT_ROUND),
    'a fix block\'s closing acceptance says a fail parks the block, with its review file as the diagnosis');
  ok(flat(fixClose.prompt('acceptance fix-a r1')).includes(FAIL_NEXT_ROUND) && !flat(fixClose.prompt('acceptance fix-a r1')).includes(FAIL_PARKS),
    'and a fix block\'s earlier round keeps the gaps driving the next develop round');
  for (const [name, plan] of [['feature', BLOCKS[0]], ['section', BLOCKS[1]]]) {
    const closeRun = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) },
      { ...ONE_ROUND, plans: [plan] });
    const [early, closing] = [flat(closeRun.prompt(`acceptance ${plan.id} r1`)), flat(closeRun.prompt(`acceptance ${plan.id} r2`))];
    ok(closing.includes(FAIL_PARKS) && !closing.includes(FAIL_NEXT_ROUND), `the ${name} closing acceptance says a fail parks the block, with its review file as the diagnosis`);
    ok(early.includes(FAIL_NEXT_ROUND) && !early.includes(FAIL_PARKS), `the ${name} acceptance of an earlier round keeps the gaps driving the next develop round`);
  }

  const dead = await run({ develop: develop(null), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  eq(dead.out.status, 'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)', 'a dead closing pass halts and parks');
  ok(/Developer for block block-a returned nothing in the closing pass \(round 2 in its file names\)/.test(dead.out.haltReason),
    'and its halt reason names the closing pass, not a round past the budget');
  const deadCloseAcc = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, null), park: PARK_OK }, ONE_ROUND);
  ok(/Acceptance verifier for block block-a returned nothing in the closing pass \(round 2 in its file names\)/.test(deadCloseAcc.out.haltReason),
    'a dead closing acceptance names the closing pass too');
  // Every other halt that names its round must name the closing pass, whose file-name number exceeds the round budget.
  const CLOSING_NAME = 'the closing pass (round 2 in its file names)';
  // Only an ordered run halts on an escalation, so that row takes the ordered args.
  for (const [kind, closingReturn, closingAcceptance, extraArgs = {}] of [
    ['a closing developer that could not obtain its plan', { ...CLOSING_OK, plan_obtained: false }, ACC_FAIL],
    ['a closing developer that did not confirm staying unstaged', { ...CLOSING_OK, unstaged_confirmed: false }, ACC_FAIL],
    ['a closing developer that escalated a user-only decision', { ...CLOSING_OK, needs_user: true }, ACC_FAIL, { ordered: true }],
    ['a closing acceptance that could not obtain its plan', CLOSING_OK, { ...ACC_FAIL, plan_obtained: false }],
    ['a closing acceptance that passed with a regression', CLOSING_OK, { ...ACC_PASS, staged: false, regression: true }],
    ['a closing acceptance that failed the block but staged it', CLOSING_OK, { ...ACC_FAIL, staged: true }],
    ['a closing acceptance that failed the block without confirming its review file', CLOSING_OK, { ...ACC_FAIL, wrote_file: false }],
  ]) {
    const r = await run({ develop: develop(closingReturn), quality: CLEAN, acceptance: firstRound(ACC_FAIL, closingAcceptance), park: PARK_OK }, { ...ONE_ROUND, ...extraArgs });
    ok(r.out.halted === true && r.out.haltReason.includes(CLOSING_NAME) && !/\bround 2\b(?! in its file names)/.test(r.out.haltReason),
      `${kind}: the halt reason names the closing pass: ${r.out.haltReason.slice(0, 120)}`);
  }
}

section('fix acceptance records a harm with a separate cause in its block\'s backlog file, never a gap');
// A fix loop converges because its inventory is closed at triage, so the verifier routes such a harm to a
// file the user triages instead of failing a fix whose own root cause is closed.
{
  const DEV_FIXED = fixDev([{ issue_id: 'i-1', status: 'FIXED' }]);
  const ran = (r) => r.labels.some((l) => l.startsWith('acceptance'));
  const FILE_A = backlogFile('fix-a');
  const FILE_B = backlogFile('fix-b');
  const TO_CHECK = (...files) => `so check these files in the project's backlog folder ${BACKLOG}/ for entries this run added: ${files.join(', ')}.`;
  const found = await run({ develop: DEV_FIXED, quality: CLEAN, acceptance: { ...FIX_PASS, backlog_entries: 2, backlog_blocks: ['fix-a'] } }, FIX_ONE);
  const acc = flat(found.prompt('acceptance'));
  ok(acc.includes(`${FILE_A} only, never to your review file`) && acc.includes('"- decision: NEEDS_USER"')
    && acc.includes(`"## Plan: ${backlogFileId('fix-a')} - backlog from block fix-a of run t", "mode: fix", "gate: green" and "status: todo"`),
    'the verifier is told its block\'s backlog file, that a new issue stays out of the review file, and how the file is shaped');
  ok(acc.includes(`with the id "${backlogFileId('fix-a')}-<n>" (n one past the highest n in that file's entry ids)`)
    && acc.includes('a **What:** that names the source issue id'),
    'an entry id continues its file\'s numbering, and the entry names the issue it came from');
  ok(acc.includes(DEDUP('harm')) && !acc.includes('read every *.md'),
    'and to grep the folder for the file path and the name at the harm, and read each matching entry, so a harm two blocks or two runs see is recorded once, unless its entries say it was fixed');
  ok(acc.includes('a cause that shares no code path with the root cause you re-derived')
    && acc.includes('A sibling path, caller or branch with the identical defect is always a residual path, and when unsure, treat it as one.'),
    'the boundary keeps a sibling path with the same defect a residual path');
  ok(acc.includes('It sets no fix_check false, and it never excuses a regression or an unsatisfied gate.'),
    'a new issue never outranks a regression or the gate');
  ok(acc.includes('EVERY DEFECT YOU WRITE IN YOUR REVIEW FILE COUNTS.'), 'only the review file\'s defects count');
  ok(!found.calls.some((c) => /NEW-ISSUES/.test(c.prompt)) && !/NEW-ISSUES/.test(found.out.nextStep),
    'no prompt and no nextStep names a NEW-ISSUES file');
  ok(!found.prompt('quality').includes(BACKLOG), 'the blind quality prompt names no backlog path');
  eq(found.out.backlogEntries, 2, 'the return counts the backlog entries');
  eq(JSON.stringify(found.out.backlogFiles), JSON.stringify([FILE_A]), 'and names the file the verifier wrote');
  ok(found.logs.some((l) => l.includes(`acceptance added 2 backlog entries to ${FILE_A}`)), 'and the round logs it');
  ok(found.out.nextStep.includes(`This run added 2 entries to the project's backlog folder ${BACKLOG}/, in: ${FILE_A}.`),
    'the nextStep names the folder, the file and the count');
  ok(found.out.nextStep.includes('Report each added entry\'s severity, or cleanup for an entry with no severity line, and its title to the user.'),
    'and has the operator report each added entry to the user');
  ok(found.out.nextStep.includes('Work the backlog as the develop guide\'s "Working the backlog" says once each file\'s block is done or skip'),
    'and sends the triage to the guide once the block is done or skipped');
  ok(!/\bmove\b|renumber|rename/i.test(found.out.nextStep), 'and never says to move, renumber or rename a file');

  const pass = await run({
    develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-3', status: 'FIXED' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-3', actually_fixed: true }],
      backlog_entries: 3, backlog_blocks: ['fix-b', 'fix-a', 'fix-b'] },
  }, PASS_ARGS);
  const passAcc = flat(pass.prompt('acceptance'));
  ok(passAcc.includes(`i-1, i-2 → ${FILE_A}`) && passAcc.includes(`i-3 → ${FILE_B}`),
    'a pass verifier maps each member\'s issue ids to that member\'s file');
  ok(!passAcc.includes('t-fix-a-plus-1'), 'and names no file for the pass\'s own id');
  ok(passAcc.includes('with the id "<that file\'s name without .md>-<n>"'), 'and numbers an entry by the file it lands in');
  eq(JSON.stringify(pass.out.backlogFiles), JSON.stringify([FILE_A, FILE_B]), 'the return\'s files are sorted and de-duplicated');

  const passOwnId = await run({
    develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, backlog_entries: 1, backlog_blocks: ['fix-a-plus-1'] },
  }, PASS_ARGS);
  eq(passOwnId.out.backlogFiles, null, 'the pass\'s own id is no member, so the report is unknown');
  ok(passOwnId.out.nextStep.includes(TO_CHECK(FILE_A, FILE_B)), 'and the nextStep lists every member\'s file to check');

  const summed = await run({
    develop: DEV_FIXED, quality: CLEAN, park: PARK_OK,
    acceptance: firstRound({ ...FIX_GAP, backlog_entries: 1, backlog_blocks: ['fix-a'] }, { ...FIX_PASS, backlog_entries: 2, backlog_blocks: ['fix-a'] }),
  }, FIX_ONE);
  eq(summed.out.backlogEntries, 3, 'every round\'s count is summed, not only the last one');
  eq(JSON.stringify(summed.out.backlogFiles), JSON.stringify([FILE_A]), 'and a file two rounds name is listed once');

  const one = await run({ develop: DEV_FIXED, quality: CLEAN, acceptance: { ...FIX_PASS, backlog_entries: 1, backlog_blocks: ['fix-a'] } }, FIX_ONE);
  ok(one.out.nextStep.includes(`This run added 1 entry to the project's backlog folder ${BACKLOG}/`)
    && one.logs.some((l) => l.includes(`acceptance added 1 backlog entry to ${FILE_A}`)), 'one entry reads as one entry');

  const none = await run({ develop: DEV_FIXED, quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  ok(ran(none), 'the no-entry case ran its verifier');
  eq(none.out.backlogEntries, 0, 'a run that added none reports 0');
  eq(JSON.stringify(none.out.backlogFiles), '[]', 'and no file');
  ok(!none.out.nextStep.includes(BACKLOG), 'and its nextStep never mentions the folder');

  const { backlog_entries: _, ...NO_COUNT } = FIX_PASS;
  const { backlog_blocks: __, ...NO_BLOCKS } = FIX_PASS;
  for (const [acceptance, what] of [
    [NO_COUNT, 'a missing count'],
    [NO_BLOCKS, 'a missing backlog_blocks'],
    [{ ...FIX_PASS, backlog_blocks: 'fix-a' }, 'a backlog_blocks that is not an array'],
    [{ ...FIX_PASS, backlog_entries: 1, backlog_blocks: ['fix-b'] }, 'an id outside the block'],
    [{ ...FIX_PASS, backlog_entries: 1, backlog_blocks: [] }, 'a positive count with no block named'],
  ]) {
    const unknown = await run({ develop: DEV_FIXED, quality: CLEAN, acceptance }, FIX_ONE);
    eq(unknown.out.backlogEntries, null, `${what} makes the count unknown, never 0`);
    eq(unknown.out.backlogFiles, null, `${what} makes the file list unknown too`);
    ok(unknown.out.nextStep.includes(TO_CHECK(FILE_A)), `and the nextStep lists the block's file to check (${what})`);
  }

  const dead = await run({ develop: DEV_FIXED, quality: CLEAN, acceptance: null, park: PARK_OK }, FIX_ONE);
  eq(dead.out.backlogEntries, null, 'a dead verifier may have appended before it died, so the count is unknown');
  eq(dead.out.backlogFiles, null, 'and so are its files');
  ok(dead.out.nextStep.includes(TO_CHECK(FILE_A)), 'and the nextStep sends the operator to the file');

  const feature = await run(GREEN_RUN);
  ok(ran(feature), 'the feature case ran its verifier');
  eq(feature.out.backlogEntries, 0, 'a feature block whose developer recorded none reports 0');
  eq(JSON.stringify(feature.out.backlogFiles), '[]', 'and no file');
  ok(!feature.prompt('acceptance').includes(BACKLOG), 'and its verifier is never told of one');

  const idle = await run({}, { ...FIX_ONE, plans: [{ ...FIX_ONE.plans[0], status: 'done' }] });
  eq(idle.out.backlogEntries, 0, 'a nothing-to-run return carries the count');
  eq(JSON.stringify(idle.out.backlogFiles), '[]', 'and the file list');
}

section('a developer records each real defect its zone routing leaves unchanged under rule 2 or as a sibling path in its block\'s backlog file');
// A later run can fix only what a file holds. The DISMISSED line stays, since the blind reviewer reads that
// file and never a backlog one.
{
  const RECORD = `• RECORD (2 or SIBLINGS): when you DROP + LOG a real pre-existing defect at low or above ${OWNED_CODE}, under rule 2 or as a sibling path the SIBLINGS phase leaves unchanged, also append ONE entry for it`;
  const OWN_FILE = (id) => ` to ${backlogFile(id)} only. Count it in backlog_entries and name "${id}" in backlog_blocks.`;
  const HEADER = (fileId, id) => `A new file starts with the four lines "## Plan: ${fileId} - backlog from block ${id} of run t", "mode: fix", "gate: green" and "status: todo", then a blank line.`;
  const ENTRY = (fileId) => `with n one past the highest n in that file's entry ids: ### [${fileId}-<n>] <title> - id: ${fileId}-<n> - status: open - file: <path>:<line> - severity: <low | medium | high | critical> - category: <category> - size: <trivial | small | medium | large> - decision: NEEDS_USER **What:** <the defect, the input or path that reaches it, and its harm> **Fix:** <the change that closes it>`;
  const DISMISSED_TOO = 'Write the defect\'s DISMISSED line too, since the blind reviewer reads that file and never this one.';
  const NO_ENTRY = { focused: 'A false positive and a nit dropped under rule 2 or SIBLINGS get no entry.', proactive: 'A false positive gets no entry, and a nit dropped under rule 2 or SIBLINGS goes under CLEANUP below.' };
  // Its own bullet after RECORD's closing-line rule, since its trigger is a cleanup and not a dropped defect.
  const CLEANUP = `Leave its status and decision as they are, since a park clears the fix from the tree. • CLEANUP (this run's change policy): append ONE entry for each cleanup outside task code, ${OWNED_CODE}, that you noticed and did not make, such as a refactor or a nit. Route, count, dedup and number it as a RECORD entry. It takes RECORD's shape with "- category: cleanup" and no "- severity:" line, since severity takes only critical, high, medium or low. Its **What:** names the cleanup, the code it touches and what it improves. • AMEND (6a)`;
  const CLASS_ENTRY = 'A DISMISSED line that covers a class of places gets one entry. Its "- file:" line names the first place, and its **What:** names the class.';
  const CLOSE = (tag, id) => `When you append a ${tag} line below, ${GREP('the path of the file the fix changes', 'the fix')}. When an entry that a grep matches holds the defect that line's fix closes, add one line after that entry's **Fix:** line in that file: **Closed by:** block ${id} r1. Confirm at triage that the accepted baseline holds the fix. Leave its status and decision as they are, since a park clears the fix from the tree.`;
  const FILE_A = backlogFile('fix-a');
  const FILE_B = backlogFile('fix-b');
  const recordRule = (dev, policy, id, where) => {
    ok(dev.includes(`${RECORD}${OWN_FILE(id)}`), `${where}: a declined defect the zone routing leaves unchanged goes to its block's own backlog file`);
    ok(dev.includes(DISMISSED_TOO) && dev.includes(NO_ENTRY[policy]), `${where}: a false positive gets no entry, and the DISMISSED line stays`);
    ok(policy === 'proactive'
      ? dev.includes(CLEANUP) && !dev.includes(NO_ENTRY.focused)
      : !dev.includes('CLEANUP') && !dev.includes('category: cleanup'),
    policy === 'proactive' ? `${where}: a cleanup outside task code gets an entry with no severity` : `${where}: a nit or other cleanup gets no entry`);
    ok(dev.includes(HEADER(backlogFileId(id), id)), `${where}: a new file takes the backlog header naming the block and the run`);
    ok(dev.includes(DEDUP('defect')) && !dev.includes('read every *.md'), `${where}: the folder is grepped for the file path and the name at the defect, and each matching entry is read, so nothing open is appended twice`);
    ok(dev.includes(ENTRY(backlogFileId(id))), `${where}: each entry copies debug's issue-file shape, numbered within its file and held at NEEDS_USER`);
    ok(dev.includes(CLASS_ENTRY), `${where}: a class-level DISMISSED line gets one entry`);
    ok(dev.includes(CLOSE(policy.toUpperCase(), id)), `${where}: a logged fix of a recorded defect finds its entry by the path and the name at the fix, and marks it closed in whichever file holds it`);
  };

  for (const policy of ['focused', 'proactive']) {
    const both = await run(GREEN_RUN, { ...baseArgs, changePolicy: policy });
    recordRule(flat(both.prompt('develop block-a')), policy, 'block-a', `${policy} feature`);
    recordRule(flat(both.prompt('develop block-b')), policy, 'block-b', `${policy} section`);
    const fixed = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS },
      { ...FIX_ONE, changePolicy: policy });
    recordRule(flat(fixed.prompt('develop')), policy, 'fix-a', `${policy} fix`);
    ok(flat(fixed.prompt('acceptance')).includes(HEADER(backlogFileId('fix-a'), 'fix-a')), `${policy} fix: acceptance's fix frame takes the same header`);
    ok(!flat(fixed.prompt('acceptance')).includes('CLEANUP'), `${policy} fix: acceptance records no cleanup`);

    const FEATURE_FILE = backlogFile('block-a');
    const recorded = await run({ ...GREEN_RUN, develop: { ...DEV_OK, backlog_entries: 2, backlog_blocks: ['block-a'] } },
      { ...ONE_BLOCK, changePolicy: policy });
    eq(recorded.out.backlogEntries, 2, `${policy} feature: the return counts the developer's entries`);
    eq(JSON.stringify(recorded.out.backlogFiles), JSON.stringify([FEATURE_FILE]), `${policy} feature: and names its block's file`);
    ok(recorded.logs.some((l) => l.includes(`developer added 2 backlog entries to ${FEATURE_FILE}`)), `${policy} feature: and the round logs it`);
    ok(recorded.out.nextStep.includes(`This run added 2 entries to the project's backlog folder ${BACKLOG}/, in: ${FEATURE_FILE}. Report each added entry's severity`),
      `${policy} feature: the nextStep names the folder and the file, with the report instruction`);
  }

  const pass = await run({
    develop: { ...passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-3', status: 'FIXED' }]), backlog_entries: 1, backlog_blocks: ['fix-a'] },
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-3', actually_fixed: true }],
      backlog_entries: 2, backlog_blocks: ['fix-b'] },
  }, PASS_ARGS);
  const passDevPrompt = flat(pass.prompt('develop'));
  ok(passDevPrompt.includes(`${RECORD} only to the file of the block whose entry's fix led you to the defect: - i-1, i-2 → ${FILE_A} (block "fix-a") - i-3 → ${FILE_B} (block "fix-b") Count it in backlog_entries and name that block in backlog_blocks.`),
    'a pass developer routes each entry to the file of the member whose entry\'s fix led to it');
  ok(passDevPrompt.includes(HEADER('<that file\'s name without .md>', '<that block\'s id>')) && passDevPrompt.includes(ENTRY('<that file\'s name without .md>')),
    'and names that member\'s file in the header and the entry id');
  ok(passDevPrompt.includes(CLOSE('FOCUSED', 'fix-a-plus-1')), 'a pass developer\'s closing line names the pass, as its DECISIONS lines do');
  ok(flat(pass.prompt('acceptance')).includes(HEADER('<that file\'s name without .md>', '<that block\'s id>')), 'a pass verifier takes the same header');
  eq(pass.out.backlogEntries, 3, 'fix mode sums the developer\'s and the verifier\'s entries');
  eq(JSON.stringify(pass.out.backlogFiles), JSON.stringify([FILE_A, FILE_B]), 'and names both writers\' files');

  const ONE_FILE = backlogFile('block-a');
  const { backlog_entries: _, ...NO_COUNT } = DEV_OK;
  for (const [develop, what] of [
    [{ ...DEV_OK, backlog_entries: 1, backlog_blocks: ['block-b'] }, 'a developer id outside the block'],
    [NO_COUNT, 'a developer report with no count'],
  ]) {
    const unknown = await run({ ...GREEN_RUN, develop }, ONE_BLOCK);
    eq(unknown.out.backlogEntries, null, `${what} makes the count unknown`);
    eq(unknown.out.backlogFiles, null, `${what} makes the file list unknown too`);
    ok(unknown.out.nextStep.includes(`A developer or fix verifier returned no usable backlog report, so check these files in the project's backlog folder ${BACKLOG}/ for entries this run added: ${ONE_FILE}.`),
      `and the nextStep lists the feature block's file to check (${what})`);
  }
  const dead = await run({ develop: null, park: PARK_OK }, ONE_BLOCK);
  eq(dead.out.backlogEntries, null, 'a dead developer may have appended before it died, so the count is unknown');
  ok(dead.out.nextStep.includes(`for entries this run added: ${ONE_FILE}.`), 'and the nextStep sends the operator to its block\'s file');
}

section('a backlog file\'s id is the run\'s slug, the block\'s slug and a hash of the raw pair');
// One folder holds every run's backlog for the project, so two (runId, block id) pairs whose slugs join alike
// must still get two files.
{
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `prefix` is a regex source for the file id before its pair hash.
  const fileIdOf = (prompt, prefix) => prompt.match(new RegExp(` to ${escape(BACKLOG)}/(${prefix}-[0-9a-f]{8})\\.md only\\.`))?.[1];
  const named = flat((await run(GREEN_RUN, { ...ONE_BLOCK, runId: 'Judgment Review' })).prompt('develop'));
  const namedId = fileIdOf(named, 'judgment-review-block-a');
  ok(!!namedId && named.includes(`"## Plan: ${namedId} - backlog from block block-a of run Judgment Review"`),
    'a runId slugs into the file name and the header id, and the header keeps the runId as given');
  const symbols = fileIdOf(flat((await run(GREEN_RUN, { ...ONE_BLOCK, runId: '#!' })).prompt('develop')), 'run-[0-9a-f]{8}-block-a');
  ok(!!symbols, 'a runId with no ASCII letter or digit takes run- and its hash');
  const other = fileIdOf(flat((await run(GREEN_RUN, { ...ONE_BLOCK, runId: '?!' })).prompt('develop')), 'run-[0-9a-f]{8}-block-a');
  ok(!!symbols && !!other && symbols !== other, 'and two such runIds get different files');

  const pairFile = async (runId, id) => {
    const out = await run(GREEN_RUN, { ...baseArgs, runId, plans: [onBus({ id, mode: 'feature', gate: 'build-only' })] });
    return flat(out.prompt('develop')).match(/ to (\S+\.md) only\./)?.[1];
  };
  const joined = [await pairFile('judgment', 'review-docs'), await pairFile('judgment-review', 'docs')];
  ok(joined.every(Boolean) && joined[0] !== joined[1], `two pairs whose slugs join alike get two files: ${joined.join(' vs ')}`);
  const folded = [await pairFile('Fix 1', 'block-a'), await pairFile('fix-1', 'block-a')];
  ok(folded.every(Boolean) && folded[0] !== folded[1], `two runIds that slug alike get two files: ${folded.join(' vs ')}`);
  eq(await pairFile('judgment', 'review-docs'), joined[0], 'a relaunch under the same runId writes the same file');

  const slashed = await run(GREEN_RUN, { ...ONE_BLOCK, backlogDir: `${BACKLOG}/` });
  ok(flat(slashed.prompt('develop')).includes(` to ${backlogFile('block-a')} only.`), 'the trailing slash the project-settings tool prints is dropped');
}

section('a launch without an absolute backlog folder outside the target repo throws, naming the command that prints one');
// The developer and fix acceptance have nowhere to record what a block leaves without the folder, and a folder
// inside the repo would put their writes in the diff the reviewers judge.
{
  const COMMAND = "node 'E:/r/tools/project-settings.mjs' backlog --root 'E:/r' --repo 'E:/repo'";
  const { backlogDir: _, ...NO_BACKLOG } = baseArgs;
  for (const [args, what] of [
    [NO_BACKLOG, 'a missing folder'],
    [{ ...baseArgs, backlogDir: 'backlog/repo-0a1b2c3d' }, 'a relative folder'],
    [{ ...baseArgs, backlogDir: '' }, 'an empty folder'],
    [{ ...baseArgs, backlogDir: 7 }, 'a folder that is not a string'],
  ]) {
    const msg = await throwsWith(ENGINE, { args });
    ok(msg.startsWith('Missing or relative args.backlogDir: pass the ABSOLUTE folder that') && msg.includes(COMMAND),
      `${what} throws with the command that prints the folder: ${msg.slice(0, 60)}`);
  }
  const plugin = await throwsWith(ENGINE, { args: { ...NO_BACKLOG, blockTool: 'C:/plugin/tools/plan-block.mjs' } });
  ok(plugin.includes("node 'C:/plugin/tools/project-settings.mjs' backlog"), 'an installed plugin\'s message names the tool beside its blockTool');
  for (const [repo, dir, what] of [
    ['E:/repo', 'E:/repo/backlog', 'a folder inside the repo'],
    ['E:/repo', 'E:/repo', 'the repo itself'],
    ['E:/repo', 'e:/REPO/backlog', 'a drive path inside the repo in another case'],
    ['E:/repo', 'E:\\repo\\backlog\\', 'a backslash path inside the repo'],
    ['//server/share/repo', '//SERVER/share/repo/backlog', 'a UNC path inside a UNC repo in another case'],
  ]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, target: { repo }, backlogDir: dir } });
    ok(msg.startsWith('args.backlogDir is inside the target repo. The developer\'s writes there would join the unstaged diff that the blind reviewer judges, acceptance stages and park clears.')
      && msg.includes(`, inside ${repo}.`)
      && msg.includes(`backlog --root '<dir>' --repo '${repo}'\` prints for a <dir> outside the target repo`),
    `${what} throws, saying why and how to get a folder outside: ${msg.slice(0, 60)}`);
  }
  const beside = await run(GREEN_RUN, { ...ONE_BLOCK, backlogDir: 'E:/repo-backlog' });
  eq(beside.out.status, 'done (all blocks staged)', 'a folder beside the repo whose name extends the repo\'s is outside it');
  // A POSIX path keeps its case, so /Repo is another folder than /repo there.
  const posix = await run(GREEN_RUN, { ...ONE_BLOCK, target: { repo: '/repo' }, backlogDir: '/Repo/backlog' });
  eq(posix.out.status, 'done (all blocks staged)', 'a POSIX folder whose case differs from the repo\'s is outside it');
}

section('mode fix takes gate green ONLY: build-only and red-baseline throw at launch');
// A fix block's entries are defects in WORKING code, so both other gates would stage a "closed" issue on
// evidence that never ran — build-only asks for no verification at all, red-baseline demands the tests
// FAIL. Neither can be coerced to green, hence a launch throw rather than a per-block gate miss.
{
  for (const gate of ['build-only', 'red-baseline']) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [onBus({ id: 'fix-a', mode: 'fix', gate })] } });
    ok(/plan gate\(s\) \[fix-a: /.test(msg) && msg.includes(JSON.stringify(gate)),
      `gate ${gate} throws naming the block and the value it was handed: ${msg.slice(0, 60)}`);
    ok(/mode fix takes green\)/.test(msg), 'and states the only legal gate for the mode');
  }
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

section('a round-1 fix block where every entry is reported STALE goes to the blind review and acceptance');
// An all-STALE report is a CLAIM. Closing it unchecked would let a misjudged live defect sync `stale`, so
// acceptance confirms each id. The block's first round with a satisfied gate gets a blind review whatever
// the developer reports. This is the branch the no-changes terminal below must never swallow.
{
  const ALL_STALE = fixDev([{ issue_id: 'i-1', status: 'STALE' }, { issue_id: 'i-2', status: 'STALE' }]);
  const STALE_OK = { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: true }] };
  const { out, calls, prompt } = await run({ develop: ALL_STALE, quality: CLEAN, acceptance: STALE_OK }, FIX_ONE);
  eq(calls.map((c) => c.label.split(' ')[0]).join(), 'develop,quality,acceptance', 'developer, blind review, then acceptance: no park');
  ok(/- i-1\n\s*- i-2/.test(prompt('acceptance')), 'acceptance is handed both STALE ids to confirm');
  eq(out.plansDone.join(), 'fix-a', 'a confirmed all-stale block counts DONE');
  eq(out.status, 'done (all blocks staged)', 'the run status reflects the accepted outcome');

  const refuted = await run({ develop: ALL_STALE, quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 });
  eq(refuted.out.plansDone.length, 0, 'a STALE claim acceptance refutes never counts done');
}

section('a round-1 STALE and SKIPPED mix goes to acceptance and lands, never the no-changes terminal');
// A triaged block often holds non-ACTIONABLE entries beside ACTIONABLE ones fixed upstream. Sent to the
// no-changes terminal, a relaunch reproduced the same report and the block could never land.
{
  const MIX = fixDev([{ issue_id: 'i-1', status: 'STALE' }, { issue_id: 'i-2', status: 'SKIPPED' }]);
  const { out, calls, prompt } = await run({ develop: MIX, quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  eq(calls.map((c) => c.label.split(' ')[0]).join(), 'develop,quality,acceptance', 'developer, blind review, then acceptance: no park');
  ok(/reports these issues STALE[^]*?- i-1/.test(prompt('acceptance')), 'acceptance is handed the STALE id to confirm');
  ok(/reports these issues SKIPPED:\n\s*- i-2/.test(prompt('acceptance')), 'and the SKIPPED id to check its triage');
  eq(out.plansDone.join(), 'fix-a', 'a confirmed mix counts DONE');
  eq(syncOf(out), 'fix-a=done,i-1=stale', 'the STALE entry syncs stale and the SKIPPED entry stays open');
}

section('a round-1 fix block that closed nothing is NOT done, and `ordered` decides whether the run stops');
// All-SKIPPED and an EMPTY array closed zero issues, so the entries stay open and the block must never
// count done. A block holding a STALE claim acceptance confirms may. The no-changes terminal does not
// park: the developer changed nothing, so there is nothing to save and nothing to clear.
{
  const skipped = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) }, FIX_ONE);
  eq(skipped.calls.length, 1, 'no reviewer and no park on an empty diff');
  eq(skipped.out.ledger[0].status, 'no-changes (the fix block closed no issue: every entry was skipped or none was reported)', 'the ledger names the terminal');
  eq(skipped.out.plansDone.length, 0, 'the block is NOT done — its issues stay open');
  ok(skipped.out.halted === false, 'an unordered run does not halt on it');

  const empty = await run({ develop: fixDev([]) }, FIX_ONE);
  eq(empty.out.ledger[0].status, 'no-changes (the fix block closed no issue: every entry was skipped or none was reported)', 'an EMPTY results array is the same terminal, never all-stale');
  eq(empty.out.plansDone.length, 0, 'and never counts done either');

  const stop = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) }, { ...FIX_ONE, ordered: true });
  eq(stop.out.status, 'halted (a fix block closed no issue - every entry was skipped, and the ordered run stopped there)', 'ordered status');
  ok(/closed NO issue and are NOT done: fix-a\./.test(stop.out.nextStep), 'the ordered nextStep names it in the no-changes sentence');
  ok(!stop.labels.some((l) => l.startsWith('park')), 'still nothing to park');
  ok(/The tree is clean/.test(stop.out.haltReason), 'and the reason says the tree is clean');

  const TWO = { ...baseArgs, plans: [FIX_ONE.plans[0], BLOCKS[0]] };
  const carry = await run({
    ...GREEN_RUN,
    develop: (l) => (l.startsWith('develop fix-a') ? fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) : DEV_OK),
  }, TWO);
  ok(carry.out.halted === false, 'an unordered run carries on');
  eq(carry.out.plansDone.join(), 'block-a', 'building the next block, which alone is done');
  eq(carry.out.status, 'run complete (1 block(s) blocked)', 'the status counts the blocked block, never "partial slice"');
  ok(/closed NO issue and are NOT done: fix-a/.test(carry.out.nextStep), 'and nextStep names it');
  // A flip before the fold is undone by it, and the relaunch skips the block.
  ok(/closed NO issue.*flip it back to todo once `plan-edit\.mjs args` has applied this run's statuses/.test(carry.out.nextStep),
    'and order the flip after the status fold');
  ok(/flip it back to todo once `plan-edit\.mjs args` has applied this run's statuses/.test(stop.out.haltReason),
    'as does the ordered halt reason');
}

section('a round-2 empty results array takes NO shortcut — the run still reaches acceptance and park');
// `produced` is per-ROUND while the working tree is CUMULATIVE. From round 2 a developer may legitimately
// return results:[] having resolved a blind-review finding with no issue id in the block. Taking the
// round-1 shortcut there breaks out past quality, acceptance AND park, stranding round 1's real edits
// unstaged, unreviewed and attributed to the next block.
{
  const { out, labels } = await run({
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([])),
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
  ok(!('criteria' in out.ledger[0]), 'the ledger row of a fix block carries no criteria count');
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
  const RED = { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'section', gate: 'red-baseline' })] };
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
  const GREEN_GATE = { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'feature', gate: 'green' })] };

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
  const { out } = await run(GREEN_RUN, { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'section' })] });
  eq(out.ledger[0].gate, 'green', 'the ledger records the green default');
  eq(out.status, 'done (all blocks staged)', 'and the block builds under it');
}

section('a block\'s model picks its developer and park agent, and the reviews keep the run\'s models');
// A block's model buys a cheaper or a stronger developer. The blind reviewer is the floor every block is
// held to, so it never follows the block.
{
  const modelOf = (calls, prefix) => calls.filter((c) => c.label.startsWith(prefix)).map((c) => c.opts.model).join(',');
  const SONNET_ROW = { ...ONE_BLOCK, plans: [{ ...BLOCKS[0], model: 'sonnet' }] };
  const set = await run(GREEN_RUN, SONNET_ROW);
  eq(modelOf(set.calls, 'develop'), 'sonnet', 'a row with model sonnet runs its developer on sonnet');
  eq(`${modelOf(set.calls, 'quality')}|${modelOf(set.calls, 'acceptance')}`, 'opus|opus', 'while its blind reviewer and acceptance stay on opus');
  eq(String(set.out.ledger[0]?.model ?? ''), 'sonnet', 'the ledger row records the developer model');
  ok(set.logs.some((l) => l.startsWith('▶ block block-a [mode=feature, gate=build-only, model=sonnet]')), 'the block-start line names the model');

  const unset = await run(GREEN_RUN, ONE_BLOCK);
  eq(modelOf(unset.calls, 'develop'), 'opus', 'a row without model runs its developer on models.develop, opus by default');
  eq(String(unset.out.ledger[0]?.model ?? ''), 'opus', 'and the ledger records that default');
  ok(unset.logs.some((l) => l.startsWith('▶ block block-a [mode=feature, gate=build-only]')), 'the block-start line names no model the row did not set');

  const runDefault = await run(GREEN_RUN, { ...ONE_BLOCK, models: { develop: 'sonnet' } });
  eq(modelOf(runDefault.calls, 'develop'), 'sonnet', 'models.develop changes the default for a row without model');
  const override = await run(GREEN_RUN, { ...SONNET_ROW, models: { develop: 'opus', quality: 'sonnet' } });
  eq(`${modelOf(override.calls, 'develop')}|${modelOf(override.calls, 'quality')}`, 'sonnet|sonnet', 'a row\'s model outranks models.develop, and quality follows models.quality alone');

  const parked = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, { ...SONNET_ROW, ordered: true });
  eq(modelOf(parked.calls, 'park'), 'sonnet', 'the park agent runs on the block\'s developer model');

  const pass = await run({
    develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-3', status: 'FIXED' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-3', actually_fixed: true }] },
  }, { ...PASS_ARGS, plans: [{ ...PASS, model: 'sonnet' }] });
  eq(`${modelOf(pass.calls, 'develop')}|${modelOf(pass.calls, 'quality')}`, 'sonnet|opus', 'a pass row\'s model applies to the pass\'s developer alone');

  const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, plans: [{ ...BLOCKS[0], model: 'gpt' }] }, respond: {} });
  ok(/plan model\(s\) \[block-a: "gpt"\]/.test(msg) && /opus \| sonnet/.test(msg), `model gpt throws naming the row and the legal values: ${msg.slice(0, 60)}`);
}

section('models and efforts take the five role keys, default every effort to high, and park follows its developer');
// An efforts level reaches the role's agent as opts.effort. A role the map leaves unset must pass high, never undefined.
{
  const optOf = (calls, prefix, key) => calls.filter((c) => c.label.startsWith(prefix)).map((c) => c.opts[key]).join(',');
  const effortsOf = (calls) => ['develop', 'quality', 'acceptance', 'final-sweep'].map((l) => optOf(calls, l, 'effort')).join('|');
  const SWEPT = { ...ONE_BLOCK, sweep: 'goal-coverage', goal: 'g' };
  const SWEEP_RUN = { ...GREEN_RUN, 'final-sweep': SWEEP_OK };
  const PARK_RUN = { develop: { ...DEV_OK, needs_user: true }, park: PARK_OK };
  const PARKED = { ...ONE_BLOCK, ordered: true };
  const parkOf = (r) => `${optOf(r.calls, 'park', 'model')}|${optOf(r.calls, 'park', 'effort')}`;

  const unset = await run(SWEEP_RUN, SWEPT);
  eq(effortsOf(unset.calls), 'high|high|high|high', 'an efforts map left out passes high to every role');

  const efforts = { develop: 'low', park: 'max', quality: 'medium', acceptance: 'xhigh', sweep: 'low' };
  const set = await run(SWEEP_RUN, { ...SWEPT, efforts });
  eq(effortsOf(set.calls), 'low|medium|xhigh|low', 'each role\'s efforts level reaches its own agent');
  const partial = await run(SWEEP_RUN, { ...SWEPT, efforts: { quality: 'max' } });
  eq(effortsOf(partial.calls), 'high|max|high|high', 'a role the map leaves out still passes high');

  const parkDefault = await run(PARK_RUN, { ...PARKED, models: { develop: 'sonnet' }, efforts: { develop: 'medium' } });
  eq(parkOf(parkDefault), 'sonnet|medium', 'park follows the developer\'s model and effort when models.park and efforts.park are unset');
  const parkBlock = await run(PARK_RUN, { ...PARKED, plans: [{ ...BLOCKS[0], model: 'haiku' }] });
  eq(parkOf(parkBlock), 'haiku|high', 'and follows its block\'s model line');
  const parkSet = await run(PARK_RUN, { ...PARKED, plans: [{ ...BLOCKS[0], model: 'haiku' }], models: { park: 'fable' }, efforts });
  eq(parkOf(parkSet), 'fable|max', 'models.park and efforts.park outrank the developer\'s');
  eq(`${optOf(parkSet.calls, 'develop', 'model')}|${optOf(parkSet.calls, 'develop', 'effort')}`, 'haiku|low', 'while the developer keeps its block\'s model and efforts.develop');

  for (const model of ['haiku', 'fable']) {
    const row = await run(GREEN_RUN, { ...ONE_BLOCK, plans: [{ ...BLOCKS[0], model }] });
    eq(optOf(row.calls, 'develop', 'model'), model, `a block row with model ${model} reaches the developer`);
  }

  const ledger = await run(GREEN_RUN, { ...ONE_BLOCK, efforts: { develop: 'xhigh' } });
  eq(String(ledger.out.ledger[0]?.effort ?? ''), 'xhigh', 'the ledger row records the developer effort');
  eq(String(unset.out.ledger[0]?.effort ?? ''), 'high', 'and records the high default');

  const rolesLine = (logs) => logs.find((l) => l.startsWith('develop: roles ')) ?? '';
  eq(rolesLine(unset.logs), 'develop: roles develop=opus/high, park=(developer)/(developer), quality=opus/high, acceptance=opus/high, sweep=opus/high', 'one launch line names each role\'s model and effort, and park follows the developer when unset');
  eq(rolesLine(parkSet.logs), 'develop: roles develop=opus/low, park=fable/max, quality=opus/medium, acceptance=opus/xhigh, sweep=opus/low', 'and it names the values the maps set');
}

section('a row\'s effort sets its developer, closing pass and park agent, and an illegal one throws');
{
  const effortOf = (calls, label) => calls.filter((c) => c.label.startsWith(label)).map((c) => c.opts.effort).join(',');
  const EFFORT_ROW = { ...ONE_BLOCK, plans: [{ ...BLOCKS[0], effort: 'xhigh' }] };

  const row = await run(GREEN_RUN, { ...EFFORT_ROW, efforts: { develop: 'low', quality: 'medium' } });
  eq(`${effortOf(row.calls, 'develop')}|${effortOf(row.calls, 'quality')}`, 'xhigh|medium', 'a row\'s effort outranks efforts.develop for its developer, and quality keeps efforts.quality');
  eq(String(row.out.ledger[0]?.effort ?? ''), 'xhigh', 'the ledger records the developer\'s row effort');
  ok(row.logs.some((l) => l.startsWith('▶ block block-a [mode=feature, gate=build-only, effort=xhigh]')), 'the block-start line names the row\'s effort');

  const fallback = await run(GREEN_RUN, { ...ONE_BLOCK, efforts: { develop: 'low' } });
  eq(effortOf(fallback.calls, 'develop'), 'low', 'a row with no effort takes efforts.develop');

  const closing = await run({ develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK),
    quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS), park: PARK_OK }, { ...EFFORT_ROW, maxRounds: 1, efforts: { develop: 'low' } });
  eq(effortOf(closing.calls, 'develop-closing'), 'xhigh', 'the closing pass takes the row\'s effort');

  const parkRun = { develop: { ...DEV_OK, needs_user: true }, park: PARK_OK };
  const parkRow = await run(parkRun, { ...EFFORT_ROW, ordered: true, efforts: { develop: 'low' } });
  eq(effortOf(parkRow.calls, 'park'), 'xhigh', 'park falls back to the row\'s effort');
  const parkSet = await run(parkRun, { ...EFFORT_ROW, ordered: true, efforts: { develop: 'low', park: 'medium' } });
  eq(`${effortOf(parkSet.calls, 'park')}|${effortOf(parkSet.calls, 'develop')}`, 'medium|xhigh', 'efforts.park outranks the row\'s effort, and the developer keeps it');

  const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, plans: [{ ...BLOCKS[0], effort: 'ultra' }] }, respond: {} });
  ok(/plan effort\(s\) \[block-a: "ultra"\]/.test(msg) && /low \| medium \| high \| xhigh \| max/.test(msg), `effort ultra throws naming the row and the legal values: ${msg.slice(0, 60)}`);
}

section('models and efforts throw at launch, naming the arg, on a bad shape, key or value');
// JSON.parse makes __proto__ an own key, which an object literal would turn into a prototype instead.
{
  const ROLE_KEYS = 'develop | park | quality | acceptance | sweep';
  const jsonArgs = (arg, mapJson) => JSON.parse(`${JSON.stringify(ONE_BLOCK).slice(0, -1)},"${arg}":${mapJson}}`);
  for (const arg of ['models', 'efforts']) {
    const legal = arg === 'models' ? 'opus | sonnet | haiku | fable' : 'low | medium | high | xhigh | max';
    const good = arg === 'models' ? 'opus' : 'high';
    const bad = arg === 'models' ? 'gpt' : 'ultra';
    for (const [shape, mapJson] of [['an array', '["develop"]'], ['null', 'null'], ['a string', '"high"']]) {
      const msg = await throwsWith(ENGINE, { args: jsonArgs(arg, mapJson), respond: {} });
      ok(msg.startsWith(`Invalid role map: args.${arg} must be an object`), `${arg} as ${shape} throws naming the arg: ${msg.slice(0, 70)}`);
    }
    for (const key of ['planner', 'constructor', 'toString', '__proto__']) {
      const msg = await throwsWith(ENGINE, { args: jsonArgs(arg, `{"${key}":"${good}"}`), respond: {} });
      ok(msg.includes(`args.${arg} names "${key}"`) && msg.includes(ROLE_KEYS), `${arg} key ${key} throws and lists the five role keys: ${msg.slice(0, 90)}`);
    }
    const value = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, [arg]: { quality: bad } }, respond: {} });
    ok(value.includes(`args.${arg}.quality is "${bad}"`) && value.includes(legal), `${arg} value ${bad} throws naming the role, the value and the legal set: ${value.slice(0, 90)}`);
    const inherited = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, [arg]: { develop: 'constructor' } }, respond: {} });
    ok(inherited.includes(`args.${arg}.develop is "constructor"`), `a value named like an inherited member throws: ${inherited.slice(0, 70)}`);
  }
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
  eq(out.status, 'BLOCKED (a parked block left the tree unsafe)', 'status');
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
  eq(stuck.out.status, 'BLOCKED (a parked block left the tree unsafe)', 'uncleared status');
  ok(/could not be cleared/.test(stuck.out.haltReason), 'halt reason says the tree still holds it');
  ok(/its work IS saved to/.test(stuck.out.haltReason), 'and that the work was still saved');
  ok(/Inspect the tree before resuming\./.test(stuck.out.haltReason), 'and says to inspect the tree before resuming');
  ok(!stuck.labels.some((l) => l.includes('block-b')), 'block-b never started on an unsafe tree');

  const red = await run({
    ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false },
  });
  eq(red.out.status, 'BLOCKED (a parked block left the tree unsafe)', 'red-build status');
  ok(/build gate is not green after parking/.test(red.out.haltReason), 'the reason names the red build');
  ok(/Inspect the tree before resuming\./.test(red.out.haltReason), 'and says to inspect the tree before resuming');
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
  eq(carry.out.status, 'run complete (1 block(s) parked)', 'status counts the parked block');
  ok(/PARKED: block-a/.test(carry.out.nextStep) && /git apply/.test(carry.out.nextStep),
    'nextStep names the parked block and the restore command');
  // `--3way` implies `--index`: it stages the restored work, folding unreviewed code into the accepted baseline.
  // The park prompt's warning still names `--3way`, so the check targets the restore command alone.
  ok(!/apply --3way/.test(carry.out.nextStep), 'nextStep never names a --3way restore');
  const parkText = carry.prompt('park:block-a');
  ok(/`git -C E:\/repo apply E:\/r\/runs\/t\/parked-block-a\.patch`/.test(parkText) && !/apply --3way/.test(parkText),
    'the park prompt\'s verbatim restore command is a plain git apply');
  ok(carry.out.parked.every((r) => !('strays' in r)), 'no parked row carries a strays key');
  ok(/continue it from its patch under full review \(the same relaunch, with continueParked naming it\)/.test(carry.out.nextStep),
    'nextStep offers continueParked beside the runOnly redo');
  ok(/restores the work UNSTAGED, with new\s+files untracked/.test(parkText),
    'and the park note says the restore leaves the work unstaged');
  ok(/flip it to todo once `plan-edit\.mjs args` has applied this run's statuses, and relaunch it with runOnly/.test(carry.out.nextStep),
    'nextStep says to flip a parked block to todo before a runOnly relaunch, since runOnly selects only todo blocks');

  const stop =await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...baseArgs, ordered: true });
  ok(stop.labels.includes('park:block-a'), 'the SAME park still runs, so nothing is discarded');
  ok(!stop.labels.some((l) => l.includes('block-b')), 'but block-b never starts');
  eq(stop.out.status, 'halted (a block was parked — its work is saved to a patch; the blocks after it were not attempted)', 'ordered status');
  ok(/is SAVED to/.test(stop.out.haltReason) && /tree is CLEAN/.test(stop.out.haltReason),
    'halt reason states saved + clean');
  ok(/tree is CLEAN; resolve with the user, then resume from this block\./.test(stop.out.haltReason),
    'a budget park halt, which has no needs-user nextStep, keeps its resume instruction');
}

section('a developer escalation parks first, then stops an ordered run');
// parked[] is keyed on the patch and the `parked` flag, never the status prose: an escalated block keeps
// BLOCKED and would otherwise have its patch path reported nowhere in the return.
{
  const { out, labels, prompt } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: PARK_OK,
  }, { ...baseArgs, ordered: true });
  ok(labels.includes('park:block-a'), 'PARK ran on the halt path');
  eq(out.status, 'BLOCKED (needs user input)', 'status');
  ok(!labels.some((l) => l.includes('block-b')), 'block-b never started');
  ok(out.parked[0]?.patch?.endsWith('parked-block-a.patch'), `the escalated block's patch is surfaced: ${out.parked[0]?.patch}`);
  ok(!('strays' in (out.parked[0] ?? {})), 'and its parked row carries no strays key');
  eq(out.parked[0]?.status, 'BLOCKED (needs user)', 'the escalated block keeps its BLOCKED status');
  ok(/The tree is clean/.test(out.nextStep) && !/tree still holds/.test(out.nextStep),
    'nextStep says the tree is clean, never that it still holds the work');
  ok(/research each question in it first \(develop guide §6\), then put the rest to the user with a recommendation each/.test(out.nextStep),
    'nextStep sends the operator to research each question before asking the user');
  ok(/and the tree is CLEAN\.$/.test(out.haltReason), `the park suffix ends at the tree state: ${out.haltReason}`);
  ok(!/resolve with the user/.test(out.nextStep), 'and no part of nextStep says to resolve it with the user');
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
  ok(/NO patch was written for: block-a/.test(out.nextStep), 'and nextStep says nothing was saved');
  ok(!/Work SAVED/.test(out.nextStep), 'never that the work was saved');
}
{
  // Park marks every `??` file intent-to-add before it checks the diff, so an empty diff holds no new file
  // and no second save location exists.
  const { out, logs } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: { ...PARK_OK, saved: false, patch_bytes: 0 },
  }, { ...baseArgs, ordered: true });
  eq(out.parked[0]?.patch, null, 'no patch path');
  ok(/It had NOTHING to save \(its working tree was already empty\) and the tree is CLEAN/.test(out.haltReason),
    `an empty ordered park says there was nothing to save: ${out.haltReason}`);
  ok(!/newfiles|strays/.test(out.haltReason + out.nextStep) && !logs.some((l) => /stray/.test(l)),
    'no halt reason, followup or log line names a strays dir');
  ok(/NO patch was written for: block-a/.test(out.nextStep), 'nextStep lists it as an empty park');
}

section('park carries new files in its one patch and never overwrites an earlier patch');
// An untracked file rides the `--binary` patch once it is intent-to-add, and a second park of a block must
// keep the first attempt's patch, which may be the only copy of that work.
{
  const { prompt, byLabel } = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 });
  const parkText = prompt('park:block-a');
  const markNew = parkText.indexOf('`git -C E:/repo add -N -- <path>`');
  const emptyCheck = parkText.indexOf('Only then check `git -C E:/repo diff`');
  const rename = parkText.indexOf('RENAME it to E:/r/runs/t/parked-block-a.prev<n>.patch');
  const write = parkText.indexOf('`git -C E:/repo diff --binary > E:/r/runs/t/parked-block-a.patch`');
  ok(markNew > -1 && markNew < emptyCheck && emptyCheck < write,
    'park marks each ?? path intent-to-add before it checks the diff and writes the patch');
  ok(!/-newfiles|CATCH STRAYS|strays/i.test(parkText), 'park has no strays step and no -newfiles dir');
  ok(!('strays_saved' in (byLabel('park:block-a')[0]?.opts.schema.properties ?? { strays_saved: 1 })),
    'PARK_SCHEMA has no strays_saved property');
  ok(/if E:\/r\/runs\/t\/parked-block-a\.patch already exists, RENAME it/.test(parkText) && rename > -1 && rename < write,
    'an existing patch is renamed to .prev<n> before the new one is written');
  ok(/n one past the highest existing \.prev<n> number for this block, or 1 when none exists/.test(parkText),
    'with n one past the highest existing one');
  ok(/Never overwrite or delete either patch/.test(parkText), 'park never overwrites or deletes a patch');
  ok(/renamed an earlier patch, one more line naming the `\.prev<n>\.patch` path\s+where that earlier attempt's patch now lives/.test(parkText),
    'the NEEDS-USER entry names where the earlier patch now lives');
  ok(/when E:\/r\/runs\/t\/parked-block-a\.patch already exists,\s+a line naming it as this block's earlier saved work/.test(parkText),
    'an empty park names an existing patch as the block\'s earlier saved work');
  ok(/"Saved work: none \(the tree held no changes\)"/.test(parkText) && !/Saved work: no patch/.test(parkText),
    'one empty-diff line remains');
  ok(/`git -C E:\/repo rm -f -q -- <file>`/.test(parkText) && !/delete each `\?\?` stray/.test(parkText),
    'the clear step drops intent-to-add files by path and deletes no stray copy');
  ok(/re-invoke with `runOnly:\["block-a"\]`[\s\S]*?`continueParked:\["block-a"\]`/.test(parkText)
    && !/ONLY alternative is to\s+apply the patch and finish this block BY HAND/.test(parkText),
    'how-to-resume names continueParked beside the runOnly redo, not a hand finish');
}

section('park keeps a copy of every review file of its block and of its ledgers, since a relaunch rewrites the round-numbered files');
// A continued launch's acceptance read a parked review file that its own round of the same number had rewritten.
{
  const KEPT = 'E:/r/runs/t/gate/DISMISSED-block-a.md E:/r/runs/t/DECISIONS.md Then create E:/r/runs/t/NEEDS-USER.md when it does not exist, and append ONE entry to it, under a `## Parked block: block-a` heading:';
  const { prompt } = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_FAIL, park: PARK_OK },
    { ...ONE_BLOCK, maxRounds: 2 });
  const parkText = flat(prompt('park:block-a'));
  const copy = parkText.indexOf('3. RECORD. First copy each file below that exists into E:/r/runs/t/parked-block-a-reviews/<k>/, with k one past the highest numbered folder there, or 1 when none exists. Make that folder whenever at least one of them exists, with or without a review file. Never overwrite or delete an earlier folder.');
  const files = parkText.indexOf(`E:/r/runs/t/gate/quality-review-block-a-r1.md E:/r/runs/t/acceptance-review-block-a-r2.md ${KEPT}`);
  ok(copy > -1 && files > copy, 'park copies every review file of the block, in round order, then the DISMISSED ledger and DECISIONS, into a new numbered folder before it writes the entry');
  ok(parkText.includes('- the diagnosis: the full path of the copy this step made of `E:/r/runs/t/acceptance-review-block-a-r2.md`, since a relaunch of this block rewrites that file'),
    'the entry names the copy of the diagnosis, which no relaunch rewrites');

  const regressed = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, staged: false, regression: true }, park: PARK_OK }, ONE_BLOCK);
  ok(flat(regressed.prompt('park:block-a')).includes(`Never overwrite or delete an earlier folder. E:/r/runs/t/acceptance-review-block-a-r1.md ${KEPT}`),
    'a passed-regression park keeps the acceptance file it cites, which no developer was routed to');

  const escalated = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, ONE_BLOCK);
  const bare = flat(escalated.prompt('park:block-a'));
  ok(bare.includes(`Never overwrite or delete an earlier folder. ${KEPT}`) && !bare.includes('quality-review-') && !bare.includes('acceptance-review-'),
    'a park with no review file still copies the ledgers, and the step makes the folder for them alone');
  ok(parkText.includes('create E:/r/runs/t/NEEDS-USER.md when it does not exist') && bare.includes('create E:/r/runs/t/NEEDS-USER.md when it does not exist'),
    'the step creates NEEDS-USER.md when it does not exist, then appends');
}

section('a parked block names its plan files and the plan-edit tool by their paths, and an agent ignores a round file of an earlier launch');
// The resume line named "its plan file" with no path, and a continued launch's gate folder held a round-2 review
// that the earlier launch wrote beside the new round-1 review.
{
  const single = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  ok(single.includes("how to resume: the plan file of this block is `E:/plans/bus.md`. Fix the blocker (sharpening this block in the file named there if needed). Once `node 'E:/r/tools/plan-edit.mjs' args` has applied this run's statuses, set this block's `status:` back to `todo` in the file named there. Then re-invoke with `runOnly:[\"block-a\"]`"),
    'the resume line names the plan file of a block and the plan-edit tool by their paths');
  ok(!single.includes('in its plan file'), 'and no longer says "its plan file" with no path');

  const PASS_PLANS = [{ planPath: 'E:/plans/a.md', id: 'fix-a', issues: ['i-1', 'i-2'] }, { planPath: 'E:/plans/b.md', id: 'fix-b', issues: ['i-3'] }];
  const pass = await run({ develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK },
    { ...baseArgs, maxRounds: 1, plans: [{ id: 'fix-a-plus-1', mode: 'fix', gate: 'green', blocks: PASS_PLANS }] });
  ok(flat(pass.prompt('park:fix-a-plus-1')).includes('how to resume: the plan files of its members are `E:/plans/a.md` (block "fix-a"), `E:/plans/b.md` (block "fix-b"). Fix the blocker'),
    'a pass\'s resume line names the plan file of each member');

  const note = 'A round file of this block that this prompt does not name may come from an earlier launch of the block, whose park kept its own copies, so ignore it.';
  const { prompts } = await run(GREEN_RUN, ONE_BLOCK).then((r) => ({ prompts: ['develop', 'quality', 'acceptance'].map((l) => flat(r.prompt(l))) }));
  ok(prompts.every((text) => text.includes(`when that round ends without acceptance staging the block. ${note}`)),
    'the round note of every role tells the agent to ignore a round file it is not named');
}

section('continueParked is validated before any agent runs');
// A string or a stray id would otherwise redo the block from scratch with no word in any log line.
{
  const cases = [
    ['a string', { ...baseArgs, continueParked: 'block-a' }, /^Invalid continueParked arg: args\.continueParked must be an ARRAY/],
    ['an empty id', { ...baseArgs, continueParked: [''] }, /^Invalid continueParked arg/],
    ['a non-string id', { ...baseArgs, continueParked: [7] }, /^Invalid continueParked arg/],
    ['a done block', { ...baseArgs, plans: [{ ...BLOCKS[0], status: 'done' }, BLOCKS[1]], continueParked: ['block-a'] },
      /^Invalid continueParked id: args\.continueParked "block-a" names no block this run builds\. Pending ids: block-b\./],
    ['an unknown id', { ...baseArgs, continueParked: ['nope'] }, /^Invalid continueParked id: args\.continueParked "nope".*Pending ids: block-a, block-b\./],
    ['a todo block runOnly excludes', { ...baseArgs, runOnly: ['block-b'], continueParked: ['block-a'] },
      /^Invalid continueParked id: args\.continueParked "block-a".*Pending ids: block-b\./],
  ];
  for (const [what, args, msg] of cases) {
    const { terminal, calls } = await runTrace(ENGINE, { args, respond: GREEN_RUN });
    ok(terminal.kind === 'throw' && msg.test(terminal.message), `${what} throws: ${terminal.message}`);
    eq(calls.length, 0, `${what}: no agent ran`);
  }
  const outside = await throwsWith(ENGINE, { args: { ...baseArgs, continueParked: ['nope'] }, respond: GREEN_RUN });
  ok(/A parked or blocked block must be set back to todo before it can be continued/.test(outside),
    'the id throw says a parked or blocked block must go back to todo first');

  // An omitted or empty continueParked changes no prompt: redo from scratch stays the default.
  const plain = await run(GREEN_RUN);
  const empty = await run(GREEN_RUN, { ...baseArgs, continueParked: [] });
  ok(empty.calls.length === plain.calls.length && empty.calls.every((c, i) => c.prompt === plain.calls[i].prompt),
    'an empty continueParked leaves every prompt unchanged');
  ok(/If it IS 0, implement this block from\nscratch on top of the accepted baseline/.test(plain.prompt('develop block-a r1')),
    'and round 1 still implements from scratch');
}

section('a continued block restores its patch in round 1, after the clean-baseline check');
{
  const { byLabel } = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, { ...baseArgs, continueParked: ['block-a'] });
  const r1 = byLabel('develop block-a r1')[0]?.prompt ?? '';
  const clean = r1.indexOf('CONFIRM THE BASELINE IS CLEAN');
  const apply = r1.indexOf('PLAIN `git -C E:/repo apply E:/r/runs/t/parked-block-a.patch`');
  ok(clean > -1 && apply > clean, 'round 1 runs the clean-baseline check first, then the plain git apply of its patch');
  ok(/never with `--3way`,\s+`--index` or `--cached`/.test(r1) && !/apply --3way/.test(r1), 'the restore is never --3way, --index or --cached');
  ok(r1.indexOf('`git -C E:/repo add -N -- <file>` on each new file the patch created') > apply, 'it marks the patch\'s new files intent-to-add');
  ok(/Confirm `git -C E:\/repo diff --cached --stat` is the same/.test(r1), 'it confirms the staged index is unchanged');
  ok(/latest `## Parked block: block-a` entry in E:\/r\/runs\/t\/NEEDS-USER\.md and the review file that entry\s+names/.test(r1),
    'it reads the park entry and the review it names');
  ok(/The restored diff is THIS block's own unstaged work\.\nIf /.test(r1) && !/\bproduced\b/.test(r1), 'the restored work is the block\'s own, with no produced field to report');
  ok(/If E:\/r\/runs\/t\/parked-block-a\.patch is missing or `git apply` fails/.test(r1) && /set needs_user=true and STOP/.test(r1),
    'a missing patch or a failed apply falls back to needs_user');
  ok(!/implement this block from\s+scratch on top/.test(r1), 'and it does not also implement from scratch');
  const untouched = [byLabel('develop block-a r2')[0]?.prompt, byLabel('develop block-b r1')[0]?.prompt];
  ok(untouched.every((t) => t && !/parked-block-a\.patch|CONTINUE from/.test(t)),
    'round 2 of the continued block and the block not named get no restore text');
  // A continued launch starts its earlier-review list empty and rewrites the round-numbered review files, so
  // only park's kept copies hold the parked findings.
  const acceptA = flat(byLabel('acceptance block-a')[0]?.prompt ?? '');
  const acceptB = flat(byLabel('acceptance block-b')[0]?.prompt ?? '');
  ok(acceptA.includes(`and that it lies ${CHANGE_ZONES.diffOnly}. This block continues its parked patch, so for this item every review file under E:/r/runs/t/parked-block-a-reviews/, when that folder exists, also counts as an earlier review of this block. The copies of DISMISSED-block-a.md and DECISIONS.md there are not reviews.`),
    "the continued block's removed-defect item, after its conditions, counts every review park kept as an earlier review");
  ok(acceptB.includes(`and that it lies ${CHANGE_ZONES.diffOnly}. - a behavior change`) && !acceptB.includes('continues its parked patch') && !acceptB.includes('-reviews/'),
    'the block not named gets no parked-review sentence');
}
{
  const { prompt } = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS },
    { ...FIX_ONE, continueParked: ['fix-a'] });
  const r1 = prompt('develop fix-a r1');
  ok(!/step 0 below/.test(r1), 'a continued fix block names no procedure step 0, since its procedure starts at step 1');
  ok(/Report every entry the restored work closes as FIXED, never STALE\./.test(r1), 'a continued fix block reports the entries the restored work closes as FIXED');
  ok(flat(prompt('acceptance fix-a')).includes('This block continues its parked patch, so for this item every review file under E:/r/runs/t/parked-fix-a-reviews/, when that folder exists, also counts as an earlier review of this block. The copies of DISMISSED-fix-a.md and DECISIONS.md there are not reviews.'),
    "a continued fix block's acceptance counts every review park kept as an earlier review");
}

section('a continued block whose park saves nothing names the patch it was continued from');
// The patch may be missing or may not have applied, so "nothing to save" would hide the earlier work and
// "saved work" would promise a file that may not exist.
{
  const { out, logs } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: { ...PARK_OK, saved: false, patch_bytes: 0 },
  }, { ...baseArgs, ordered: true, continueParked: ['block-a'] });
  eq(out.parked[0]?.patch, null, 'no new patch path');
  ok(/It was continued from E:\/r\/runs\/t\/parked-block-a\.patch, which holds its earlier work only if that file exists: its entry in E:\/r\/runs\/t\/NEEDS-USER\.md says whether the patch was missing or did not apply/.test(out.haltReason),
    `the halt reason names the patch and the NEEDS-USER entry: ${out.haltReason}`);
  ok(/No new patch was written for: block-a \(continued from E:\/r\/runs\/t\/parked-block-a\.patch\)/.test(out.nextStep)
    && /entry in E:\/r\/runs\/t\/NEEDS-USER\.md says whether its patch was missing or did not apply/.test(out.nextStep),
    'nextStep names the patch and the NEEDS-USER entry');
  const parkLine = logs.find((l) => /PARKED/.test(l)) ?? '';
  ok(/no new patch, continued from E:\/r\/runs\/t\/parked-block-a\.patch/.test(parkLine), `the park log line names the patch: ${parkLine}`);
  const texts = [out.haltReason, out.nextStep, parkLine].join('\n');
  ok(!/nothing to save|nothing to restore|NO patch was written/i.test(texts), 'none of them says there is nothing to save or restore');
  ok(!/(SAVED|saved) to E:\/r\/runs\/t\/parked-block-a\.patch|work saved to/.test(texts), 'and none calls the patch saved work');
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
  eq(out.status, 'run complete (1 block(s) parked)', 'status');
  ok(/REST OF THE RUN can continue/.test(prompt('park')) && /the remaining blocks continued without it/.test(prompt('park')),
    'park is told the run continues');
  ok(/was halted: the developer escalated a user-only decision/.test(prompt('park')), 'with the needs-user reason');
  // The parked-block followup offers only restore, re-run or drop, so the escalated question needs its own line.
  ok(/1 block\(s\) escalated a user-only decision: block-a\. .*research each question in it first \(develop guide §6\), then put the rest to the user with a recommendation each.*relaunch it with runOnly/.test(out.nextStep),
    'nextStep names the block and sends the operator to research each question before asking the user');
  ok(!/resolve with the user/.test(out.nextStep), 'and no longer says to resolve it with the user');
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
  eq(out.status, 'BLOCKED (a block staged while self-reporting a regression)', 'status');
  ok(!/inspect/i.test(out.status) && /Inspect `git -C E:\/repo diff --cached`/.test(out.haltReason),
    'the inspect instruction lives in the halt reason, not the status');
  eq(out.plansDone.join(), 'block-a', 'the block itself still counts as done (staged)');
  ok(out.ledger[0].contradicted === true, 'and the ledger flags the self-contradiction');
  // The plan file's statuses pick the relaunch's blocks, so a block rejected back to todo is rebuilt.
  ok(out.haltReason.includes('CLAUDE.md §6'), 'the halt reason points at the keep-or-reject guide');
  ok(out.haltReason.includes('relaunch with fresh `plan-edit.mjs args`'), 'and says to relaunch with fresh plan-edit.mjs args');
  ok(!/startAt/.test(out.haltReason), 'and never names startAt');
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
// worse. But the run cannot advance onto an unaccepted baseline either.
{
  const { out, labels } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, staged: false } });
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park good accepted work');
  ok(!labels.some((l) => l.includes('block-b')), 'did not advance past the broken staging boundary');
  eq(out.status, 'BLOCKED (a block passed but was not staged)', 'status');
  ok(!/stage it/i.test(out.status) && /Stage its files \(git -C E:\/repo add <files>\)/.test(out.haltReason),
    'the stage instruction lives in the halt reason, not the status');
  // Acceptance passed, so the plan file says done. Synced as blocked, the documented flip-to-todo rebuilt a
  // block that had already landed on top of its own staged copy.
  eq(syncOf(out), 'block-a=done', 'statusSync marks the passed block done');
  ok(/then relaunch: the next `plan-edit\.mjs args` marks the block done\./.test(out.haltReason) && !/startAt/.test(out.haltReason),
    'and the reason says stage, relaunch, and that args marks the block done');
  ok(/1 block\(s\) halted and are NOT done: block-a - the halt reason above says what each needs/.test(out.nextStep),
    'nextStep defers to the halt reason rather than giving fix-block advice');
  ok(!/closed NO issue|- decision:/.test(out.nextStep), 'and never tells a feature block to read decision lines');

  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN,
    acceptance: { ...FIX_PASS, staged: false } }, FIX_ONE);
  eq(syncOf(fix.out), 'fix-a=done,i-1=fixed', 'a passed-unstaged fix block syncs its FIXED entry fixed');
}

section('acceptance that passed with a regression but staged nothing parks, and is never synced done');
// Routed as passed-unstaged, the block synced done, its FIXED entries fixed, and the halt told the operator
// to stage work its own verifier flagged as a regression.
{
  const { out, labels } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, staged: false, regression: true }, park: PARK_OK });
  ok(out.halted === true, 'halted');
  ok(labels.includes('park:block-a'), 'parked the flagged work, so the tree is clean');
  ok(!labels.some((l) => l.includes('block-b')), 'the run did not continue');
  eq(out.status, 'BLOCKED (a block passed but flagged a regression and was not staged - its work is parked)', 'status');
  eq(syncOf(out), 'block-a=blocked', 'statusSync marks the block blocked, never done');
  eq(out.plansDone.length, 0, 'nothing counts done');
  ok(/flagged a regression and staged nothing/.test(out.haltReason) && /left UNSTAGED and is flagged as a regression/.test(out.haltReason),
    'the reason says the work is unstaged and flagged as a regression');
  ok(/never stage it as it is/.test(out.haltReason) && !/Stage its files|git -C \S+ add/.test(out.haltReason),
    'and never tells the operator to stage it');
  ok(/see E:\/r\/runs\/t\/acceptance-review-block-a-r1\.md/.test(out.haltReason), 'and cites the acceptance file it wrote');
  ok(/flagged a regression and staged nothing/.test(out.nextStep), 'nextStep repeats the reason');

  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN,
    acceptance: { ...FIX_PASS, staged: false, regression: true }, park: PARK_OK }, FIX_ONE);
  eq(syncOf(fix.out), 'fix-a=blocked,i-1=needs-attention', 'a fix block syncs blocked and its FIXED entry needs-attention');
}

section('the regression flag follows the last acceptance verdict, never an earlier round');
// A later round may fix what an earlier acceptance flagged, so the ledger and the return read the last verdict.
{
  const fixed = await run({ ...GREEN_RUN, acceptance: firstRound({ ...ACC_FAIL, regression: true }, ACC_PASS) }, ONE_BLOCK);
  eq(fixed.out.status, 'done (all blocks staged)', 'a round-1 regression fixed in round 2 ends staged');
  eq(fixed.out.ledger[0].regression, false, 'the ledger reads false once the last verdict found none');
  eq(fixed.out.regression, false, 'and so does the return');

  const open = await run({ ...GREEN_RUN, acceptance: firstRound(ACC_FAIL, { ...ACC_FAIL, regression: true }), park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 2 });
  eq(open.out.ledger[0].regression, true, 'a regression in the last verdict stays in the ledger');
  eq(open.out.regression, true, 'and in the return');

  // A failing verdict that reports false still clears the earlier regression, since the last verdict stands.
  const failFalse = await run({ ...GREEN_RUN, acceptance: firstRound({ ...ACC_FAIL, regression: true }, ACC_FAIL), park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 2 });
  eq(failFalse.out.ledger[0].regression, false, 'a failing verdict that reports false clears the earlier regression in the ledger');
  eq(failFalse.out.regression, false, 'and in the return');

  // A verdict that omits the field says nothing about the earlier regression, so it must not clear it.
  const ACC_FAIL_NO_FIELD = { ...ACC_FAIL };
  delete ACC_FAIL_NO_FIELD.regression;
  const silent = await run({ ...GREEN_RUN, acceptance: firstRound({ ...ACC_FAIL, regression: true }, ACC_FAIL_NO_FIELD), park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 2 });
  eq(silent.out.ledger[0].regression, true, 'a later verdict without the field leaves the earlier regression in the ledger');
  eq(silent.out.regression, true, 'and in the return');

  // A pass certifies that nothing regressed, so a passing verdict without the field clears the earlier regression.
  const ACC_PASS_NO_FIELD = { ...ACC_PASS };
  delete ACC_PASS_NO_FIELD.regression;
  const passSilent = await run({ ...GREEN_RUN, acceptance: firstRound({ ...ACC_FAIL, regression: true }, ACC_PASS_NO_FIELD) }, ONE_BLOCK);
  eq(passSilent.out.status, 'done (all blocks staged)', 'a staged pass without the field ends staged');
  eq(passSilent.out.ledger[0].regression, false, 'a passing verdict without the field clears the earlier regression in the ledger');
  eq(passSilent.out.regression, false, 'and in the return');
}

section('a pass resting on assertion rather than evidence is flagged THIN, never failed');
// Acceptance already staged by the time the flag is computed, so this is an operator audit signal (#14),
// not a gate.
{
  const thin = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, evidence_recorded: false } }, ONE_BLOCK);
  ok(thin.out.ledger[0].thinEvidence === true, 'missing locators flag the pass');
  ok(thin.logs.some((l) => /THIN EVIDENCE \(evidence_recorded=false\)/.test(l)), 'and the log names the audit file');
  eq(thin.out.status, 'done (all blocks staged)', 'without failing the block');

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
    onBus({ id: 'block-done', mode: 'feature', gate: 'build-only', status: 'done' }),
    onBus({ id: 'block-skip', mode: 'feature', gate: 'build-only', status: 'skip' }),
    onBus({ id: 'block-parked', mode: 'feature', gate: 'build-only', status: 'parked' }),
    onBus({ id: 'block-blocked', mode: 'feature', gate: 'build-only', status: 'blocked' }),
    onBus({ id: 'block-todo', mode: 'feature', gate: 'build-only', status: 'todo' }),
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
  ok(/status back to todo/.test(out.nextStep), 'nextStep says how to re-open a block');

  // A halt before the sweep, resolved to done by hand, leaves this relaunch as the only run that can say so.
  const ALL_DONE = { ...baseArgs, goal: 'g', plans: BLOCKS.map((b) => ({ ...b, status: 'done' })) };
  const swept = await run({}, { ...ALL_DONE, sweep: 'goal-coverage' });
  ok(/the sweep runs only at the end of a run that builds a block, so it did not run here/.test(swept.out.nextStep),
    'a goal-coverage all-done relaunch says the sweep did not run');
  const unswept = await run({}, { ...ALL_DONE, sweep: 'none' });
  ok(!/sweep/.test(unswept.out.nextStep), 'a sweep:none all-done relaunch never mentions the sweep');
}

section('gates.test is demanded only for the PENDING set, not for blocks already done');
// Scoped deliberately unlike the sibling engines' all-blocks rule: with the todo filter, an all-done
// relaunch would otherwise throw over a test command this run will never execute instead of reaching the
// nothing-to-run terminal above.
{
  const DONE_GREEN = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b' }, backlogDir: BACKLOG,
    plans: [onBus({ id: 'block-a', mode: 'feature', gate: 'green', status: 'done' })] };
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
  eq(only.out.status, 'partial slice complete (every selected block staged)', 'runOnly status');
  const from = await throwsWith(ENGINE, { args: { ...baseArgs, startAt: 'block-b' } });
  ok(/^args\.startAt is retired/.test(from), `startAt no longer slices, it throws: ${from.slice(0, 50)}`);
}

section('a block id matching nothing throws instead of building a smaller roadmap');
// A silently dropped id builds fewer blocks than the operator asked for, and if every id is a typo,
// nothing at all, reported as a benign "partial slice complete" with no error.
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, runOnly: ['nope'] } });
  ok(/nope/.test(msg) && /block-a, block-b/.test(msg), `runOnly "nope" throws and lists the valid ids: ${msg.slice(0, 60)}`);
}

section('the token budget stops cleanly between blocks');
{
  const { out, calls } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(calls.length, 0, 'stopped before spawning anything');
  eq(out.status, 'stopped on token budget (fewer tokens remain than minPlanBudget)', 'status');
  ok(/^Stopped before block block-a:/.test(out.haltReason), 'halt reason names the block it stopped before');
  ok(out.haltReason.includes('Relaunch with fresh `plan-edit.mjs args`') && !/startAt/.test(out.haltReason),
    'and says to relaunch with fresh plan-edit.mjs args, never startAt');
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
    onBus({ id: 'block-done', mode: 'feature', gate: 'build-only', status: 'done' }),
    onBus({ id: 'block-skip', mode: 'feature', gate: 'build-only', status: 'skip' }),
    onBus({ id: 'block-todo', mode: 'feature', gate: 'build-only', status: 'todo' }),
  ] };
  const { labels, prompt } = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, MIX);
  eq(labels.filter((l) => l === 'final-sweep').length, 1, 'exactly one sweep, after the last block');
  ok(/COMPLETED BLOCKS: block-todo/.test(prompt('final-sweep')), 'it names the blocks this run staged');
  ok(prompt('final-sweep').replace(/\s+/g, ' ').includes('for this role "the files this block touches" means the files the goal or the plan names, every file in the staged diff, and every file a step-1 grep hits'),
    'the sweep redefines ENV\'s readable files as the goal, the plan, the staged diff and the step-1 grep hits');

  const OPEN = { ...MIX, plans: [...MIX.plans, onBus({ id: 'block-open', mode: 'feature', gate: 'build-only', status: 'blocked' })] };
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
  ok(/status --porcelain/.test(healthy.out.nextStep), 'nextStep carries the unstaged-tree check');

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
  eq(JSON.stringify(none.out.failed), '[]', 'and a switched-off sweep leaves failed empty');
}

section('a dead final sweep is reported as NOT RUN, never as zero gaps');
// `(sweep?.gaps || []).length` logged "0 potential gap(s)" for a check that never ran, citing a file
// nothing wrote. It must NOT halt: every block is already staged, so failing a complete run over a
// missing advisory check would be worse than reporting it missing.
{
  const { out, logs } = await run({ ...GREEN_RUN, 'final-sweep': null },
    { ...baseArgs, sweep: 'goal-coverage', goal: 'g' });
  eq(JSON.stringify(out.failed), '[{"id":"sweep","stage":"sweep"}]',
    'failed holds the sweep entry, which tells a DIED sweep from one that never ran');
  eq(out.sweep, null, 'no fabricated sweep result');
  ok(!logs.some((l) => /0 potential gap/.test(l)), 'never logs a clean-looking gap count for a check that died');
  eq(out.status, 'done (all blocks staged)', 'a dead sweep does not fail an otherwise complete run');
  ok(/completeness sweep DIED/.test(out.nextStep), 'and nextStep warns the user first');
  // The sweep runs only after the block loop, and a relaunch finds every block done and returns first.
  const deadLine = logs.find((l) => /completeness check DIED/.test(l)) ?? '';
  ok(/check coverage against the goal yourself/.test(deadLine) && /verify coverage against the goal yourself/.test(out.nextStep),
    'both tell the operator to verify coverage by hand');
  ok(!/re-run/.test(deadLine) && !/re-run it/.test(out.nextStep), 'and neither offers a sweep re-run no relaunch can reach');
}

section('a sweep gap count is read only as a non-negative integer, and a missing one is unknown, never zero');
// `(sweep.gaps || []).length` read a missing gap list as zero gaps.
{
  const SWEPT = { ...baseArgs, sweep: 'goal-coverage', goal: 'g' };
  const GAPS = { wrote_file: true, complete: false, suite_result: 'green' };
  const counted = await run({ ...GREEN_RUN, 'final-sweep': { ...GAPS, gap_count: 2 } }, SWEPT);
  eq(counted.out.sweep.gaps, 2, 'the return carries the sweep\'s own count');
  ok(counted.logs.some((l) => /sweep: 2 potential gap\(s\)/.test(l)), 'and the log line states it');
  for (const [name, sweep] of [['missing', GAPS], ['negative', { ...GAPS, gap_count: -1 }],
    ['fractional', { ...GAPS, gap_count: 1.5 }], ['string', { ...GAPS, gap_count: '2' }]]) {
    const { out, logs } = await run({ ...GREEN_RUN, 'final-sweep': sweep }, SWEPT);
    eq(out.sweep.gaps, null, `a ${name} count reads as unknown`);
    ok(logs.some((l) => /sweep: returned no gap count/.test(l)), `a ${name} count is logged as no gap count`);
    ok(!logs.some((l) => /0 potential gap/.test(l)), `a ${name} count never logs zero gaps`);
  }
}

// ---------------------------------------------------------------------------------------------
// The control array itself
// ---------------------------------------------------------------------------------------------
section('a plans value that is not a non-empty array throws, pointing at the plan-edit.mjs args object');
// There is no single-plan fallback, so every one of these must stop before any agent. The message has to
// name the fix, not merely exist: `plan-edit.mjs args` prints an object to spread, whose `plans` array is the input.
// Rows copied off `plan-block.mjs --list` skip the status fold, so a block a finished run settled is rebuilt.
{
  for (const bad of ['block-a', 42, true, [], null]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: bad } });
    ok(/args\.plans must be a NON-EMPTY array/.test(msg) && /"plan-edit\.mjs args <planPath>" prints an object: spread it/.test(msg)
      && /"plans" array becomes args\.plans/.test(msg) && /Never nest that object under "plans"/.test(msg) && !/--list/.test(msg),
      `plans ${JSON.stringify(bad)} throws naming the plan-edit.mjs args object to spread: ${msg.slice(0, 45)}`);
  }
  const noId = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [onBus({ mode: 'feature', gate: 'green', status: 'todo' })] } });
  ok(/"plans" row that "plan-edit\.mjs args <planPath>" prints/.test(noId) && /--pack/.test(noId)
    && !/--list|planContext/.test(noId),
    `an entry with no id names plan-edit.mjs args rows and --pack passes as the source: ${noId.slice(0, 60)}`);
}

section('duplicate ids and a mode this engine does not build both throw');
// Every per-block run-state file is keyed by the bare id, so duplicates overwrite each other's reviews,
// ledger and patch, and the second block is judged against the first's trail.
{
  const dupe = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [BLOCKS[0], { ...BLOCKS[0] }] } });
  ok(/duplicate plan id\(s\) \[block-a\]/.test(dupe), `duplicate ids throw: ${dupe.slice(0, 60)}`);

  const bogus = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'bogus' })] } });
  ok(/not one of feature \| section \| fix/.test(bogus), `an unknown mode throws: ${bogus.slice(0, 60)}`);
  ok(/"bogus"/.test(bogus), 'and names the value it was handed');
}

section('a row with no planPath throws naming it');
// Without a plan file the block reference names an empty path and the developer builds against nothing
// while reporting success.
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs,
    plans: [BLOCKS[0], { id: 'block-b', mode: 'section', gate: 'build-only' }] } });
  ok(/^plans \[block-b\] carry no planPath/.test(msg), `throws naming only the row without one: ${msg.slice(0, 60)}`);
  // Hand-derived `--list` rows skip the status fold, so a finished block would be rebuilt.
  ok(/"plan-edit\.mjs args <planPath>" and spread the object it prints: every row it prints carries its own planPath/.test(msg)
    && !/--list|top-level/.test(msg), 'and says every plan-edit.mjs args row carries its own, naming no --list or top-level default');
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
  ok(dev.includes('Redirect its output to a file under E:/r/runs/t/scratch/ (create it if needed), never inside the'), 'the developer reads its block from a file under the scratch dir, since the Bash display cuts long output');
  ok(/node 'E:\/r\/tools\/plan-block\.mjs' 'E:\/plans\/bus\.md' 'block-a'/.test(prompt('acceptance block-a')),
    'acceptance judges against the same block the developer built to');
  ok(prompt('acceptance block-a').includes('Redirect its output to a file under E:/r/runs/t/scratch/ (create it if needed), never inside the'), 'and reads it from a file there too');
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

section('a row carrying planContext throws, naming the row, since every agent gets the block command');
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [{ ...BLOCKS[0], planContext: 'full' }, BLOCKS[1]] } });
  ok(/^args\.plans\[\]\.planContext is retired/.test(msg), `throws: ${msg.slice(0, 50)}`);
  ok(/\[block-a\]/.test(msg) && !/block-b/.test(msg), 'and names only the row carrying it');
}

section('each retired arg throws at launch, naming itself and its replacement, after the numeric guards');
// Ignoring one would build a different set of blocks, hand agents a different plan text, or review at a
// different bar than the operator asked for.
{
  const retired = [
    ['startAt', { startAt: 'block-b' }, /^args\.startAt is retired: .*"plan-edit\.mjs args <planPath>".*args\.runOnly/],
    ['reviewSeverity', { reviewSeverity: 'medium' }, /^args\.reviewSeverity is retired: the developer's risk judgment decides when a blind review runs/],
    ['planPath', { planPath: BUS }, /^The top-level args\.planPath is retired: .*every "plans" row that "plan-edit\.mjs args <planPath>" prints carries its own planPath/],
    ['planContext', { plans: [{ ...BLOCKS[0], planContext: 'block' }] }, /^args\.plans\[\]\.planContext is retired: .*plan-block command.*whole plan file/],
  ];
  for (const [name, extra, re] of retired) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, ...extra } });
    ok(re.test(msg), `${name} throws naming itself and its replacement: ${msg.slice(0, 70)}`);
    const numeric = await throwsWith(ENGINE, { args: { ...baseArgs, ...extra, maxRounds: 'x' } });
    ok(/^Invalid numeric arg/.test(numeric), `and ${name} is checked after the numeric guards: ${numeric.slice(0, 40)}`);
  }
  const absent = await run(GREEN_RUN, { ...baseArgs, startAt: undefined, reviewSeverity: undefined, planPath: undefined,
    plans: BLOCKS.map((b) => ({ ...b, planContext: undefined })) });
  eq(absent.out.status, 'done (all blocks staged)', 'a retired key whose value is undefined counts as absent');
}

const STATE = 'E:/r/runs/t';
/**
 * Every run-state path the BLIND quality reviewer's prompt discloses must sit under `runs/<runId>/gate/`.
 * Naming the state dir at all discloses everything IN it: `acceptance-review-<id>-rN.md` enumerates the
 * block's acceptance criteria, `AMENDED-<id>.md` quotes the overridden plan clause verbatim, and
 * DECISIONS.md carries the pointer line naming that file and the escalated default. #3 forbids relying
 * on "please don't read X".
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
  ok(!q.includes('NEEDS-USER.md') && !q.includes('DECISIONS.md'),
    'but NOT NEEDS-USER or DECISIONS: the DECISIONS amendment pointer line names the AMENDED file, which quotes the plan verbatim');
  eq(stateRefsOutsideGate(q).join(', '), '', 'and no run-state path outside gate/');
  // Blindness is placement AND instruction: a fix block's plan file IS an issue inventory.
  ok(q.includes(`Never open a plan file, an issue inventory, or any run-state path outside ${STATE}/gate/.`),
    'and it is told never to open a plan file, an inventory or run-state outside gate/');
  // gate/ is shared by every block, so its own DISMISSED file is the one gate/ file it may read. Its own
  // review file is readable only at the WRITE step, where the Write tool needs a prior read to overwrite it.
  ok(q.replace(/\s+/g, ' ').includes(`${STATE}/gate/ also holds other blocks' review and DISMISSED files. Read only ${STATE}/gate/DISMISSED-block-a.md there, and ${STATE}/gate/quality-review-block-a-r1.md only at the WRITE step`),
    'and it is told gate/ holds other blocks\' files and to read only its own DISMISSED file there, plus its own review file at the WRITE step');
  const a = (await run(GREEN_RUN)).prompt('acceptance block-a');
  ok(a.includes(`${STATE}/gate/DISMISSED-block-a.md`) && a.includes(`${STATE}/NEEDS-USER.md`)
    && a.includes(`${STATE}/DECISIONS.md`),
    'while the plan-aware verifier still reads every settled-decision file');
}

section('two block ids that share their first 60 characters get distinct run-state files');
// A bare 60-char cut gave two such blocks one DISMISSED ledger, one review file per round and one parked
// patch, so one block's declined findings silenced the other's blind review.
{
  const stem = `shared-prefix-${'x'.repeat(50)}`;
  const ids = [`${stem}-one`, `${stem}-two`];
  const plans = ids.map((id) => onBus({ id, mode: 'fix', gate: 'green' }));
  const r = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS },
    { ...baseArgs, plans });
  const fileOf = (text, re) => text.match(re)?.[0] ?? '';
  const files = ids.map((id) => ({
    quality: fileOf(r.prompt(`quality ${id}`), /quality-review-[a-z0-9-]+-r1\.md/),
    acceptance: fileOf(r.prompt(`acceptance ${id}`), /acceptance-review-[a-z0-9-]+-r1\.md/),
    dismissed: fileOf(r.prompt(`quality ${id}`), /DISMISSED-[a-z0-9-]+\.md/),
  }));
  for (const kind of ['quality', 'acceptance', 'dismissed']) {
    ok(files[0][kind] !== '' && files[1][kind] !== '', `both blocks name a ${kind} file`);
    ok(files[0][kind] !== files[1][kind], `and the two ${kind} files differ: ${files[0][kind]} vs ${files[1][kind]}`);
  }
  ok(files.every((f) => f.dismissed.length <= 'DISMISSED-.md'.length + 60), 'each slug still fits in 60 characters');

  const sixty = `id-${'y'.repeat(57)}`;
  eq(sixty.length, 60, 'an id of exactly 60 characters');
  const whole = await run(GREEN_RUN, { ...baseArgs, plans: [onBus({ id: sixty, mode: 'feature', gate: 'build-only' })] });
  ok(whole.prompt(`quality ${sixty}`).includes(`${STATE}/gate/quality-review-${sixty}-r1.md`)
    && whole.prompt(`quality ${sixty}`).includes(`${STATE}/gate/DISMISSED-${sixty}.md`),
    'keeps its whole id in its file names, as before');
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
  // Both rows name the one plan file, so a one-file roadmap must not repeat the warning per block.
  const inRepo = BLOCKS.map((b) => ({ ...b, planPath: 'E:\\repo\\docs\\bus.md' }));
  const warn = planWarnings((await run(GREEN_RUN, { ...baseArgs, plans: inRepo })).logs);
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
  const { logs } = await run(GREEN_RUN, { ...baseArgs, plans: [{ ...BLOCKS[0], planPath: 'E:\\repo\\' }] });
  const warn = planWarnings(logs);
  eq(warn.length, 1, 'a plan path equal to the repo root warns exactly once');
  ok((warn[0] ?? '').includes('(E:/repo)'), `and names the normalized path: ${(warn[0] ?? '(none)').slice(0, 60)}`);
  ok(!logs.some((l) => l.includes('INSIDE the target repo')), 'and it is not the run-state guard firing');
}
{
  eq(planWarnings((await run(GREEN_RUN)).logs).length, 0, 'a plan file outside the repo draws nothing');
}
{
  // Windows folds case in a drive path, so a path that spells the repo in another case is still inside it.
  const { logs } = await run(GREEN_RUN, { ...baseArgs, stateDir: 'e:/REPO/runs/t', plans: [{ ...BLOCKS[0], planPath: 'e:/Repo/plans/a.md' }] });
  ok(logs.some((l) => l.includes('INSIDE the target repo')), 'run-state inside the repo in another case still warns');
  eq(planWarnings(logs).length, 1, 'and so does a plan file inside the repo in another case');
  const beside = await run(GREEN_RUN, { ...baseArgs, stateDir: 'E:/repo-state/t', plans: [{ ...BLOCKS[0], planPath: 'E:/repo-plans/a.md' }] });
  ok(!beside.logs.some((l) => l.includes('INSIDE the target repo')) && planWarnings(beside.logs).length === 0,
    'a folder beside the repo whose name extends the repo\'s draws neither warning');
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
const proBus = await run(GREEN_RUN, { ...baseArgs, changePolicy: 'proactive' });
const proFixBus = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, { ...FIX_ONE, changePolicy: 'proactive' });
const FRAMES_BY_POLICY = { focused: FRAMES, proactive: [['feature', 'block-a', proBus], ['section', 'block-b', proBus], ['fix', 'fix-a', proFixBus]] };
const REQUIRED_BY = { feature: 'a criterion of this block', section: 'a criterion of this block', fix: 'an ACTIONABLE entry' };
const RULE_2 = '2. A pre-existing finding, at any tier, that the ZONE ROUTING above does not fix → DROP + LOG. Never fix it (regression risk).';
const RULE_3 = '3. Stops the build/tests/verification → FIX it where the ZONE ROUTING above places the fix, or ESCALATE it (7) where that routing says to.';
const RULE_8 = "8. Any other open choice: weigh its benefit (what it improves, and how likely an input reaches it) against its cost (diff size, regression risk, scope). Benefit clearly ahead → FIX. Benefit not clearly ahead, or a different block's work → DROP + LOG.";
const SIBLINGS_STEP = "SIBLINGS: when you FIX a finding in any phase or make a fix this block requires, grep for every sibling path with the same mechanism, and fix each one the ZONE ROUTING above fixes. DROP + LOG every other sibling by its file:line, or log the class it belongs to. A sibling in code this block's text excludes, or that another block of the plan owns, is DROP + LOG wherever it lies.";

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
    ok(dev.includes(`DROP (1, 2, 6b or 8): append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md`),
      `${mode}: LOGGING routes the DROP at 1, 2, 6b and 8, not the whole of 6`);
    ok(/7\. A choice that changes user-visible behavior, stored data or a public contract/.test(dev), `${mode}: ESCALATE (case 7) is intact`);
  }
}

section('MATRIX case 5 owns a piece the plan leaves out, so the fix takes no amendment');
// Read as a conflict, an omission routed to 6a and reached the user, or not, on the developer's reading.
{
  for (const [mode, id, r] of FRAMES.filter(([m]) => m !== 'section')) {
    ok(flat(r.prompt(`develop ${id}`)).includes("A piece the plan's prescribed text leaves out is this case, not a conflict, so it takes no amendment."),
      `${mode}: an omission in the plan's text routes to case 5, not 6a`);
  }
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`develop ${id}`)).includes('An exception to a rule the plan states is a conflict (6a or 6b), never a left-out piece.'),
      `${mode}: an exception to a rule the plan states is a conflict, never a left-out piece`);
  }
}

section('the developer weighs any other open choice and accounts for every finding, in every mode');
// A silent drop left a minor finding in code the developer was already in, and acceptance counts one neither closed nor ledgered.
{
  const flaggedBus = await run({ develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS });
  const flaggedFix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS }, FIX_ONE);
  const laterRound = { 'block-a': flaggedBus, 'block-b': flaggedBus, 'fix-a': flaggedFix };
  for (const [mode, id, r] of FRAMES) {
    const dev = flat(r.prompt(`develop ${id}`));
    ok(dev.includes(RULE_2), `${mode}: rule 2 logs each pre-existing finding, at any tier, that the zone routing does not fix, a sibling path included`);
    ok(dev.includes(RULE_3), `${mode}: rule 3 fixes a build or test break where the zone routing places the fix, or escalates it where that routing says to`);
    ok(dev !== '' && !dev.includes('a finding below the threshold included'), `${mode}: rule 4 names no threshold the developer never sees`);
    ok(dev.includes('7. A choice that changes user-visible behavior, stored data or a public contract, and that the plan, the code, the CONVENTIONS and a quick check cannot settle, OR a blocker you cannot resolve in scope → ESCALATE + LOG. Settle any other open choice yourself under 4, 5 or 8.'),
      `${mode}: rule 7 escalates only a choice nothing the developer can read or check settles`);
    ok(dev !== '' && !dev.includes('A genuine DESIGN/BUSINESS choice'), `${mode}: the old rule 7 bar is gone`);
    ok(dev.includes(RULE_8), `${mode}: rule 8 weighs an open choice's benefit against its cost and logs a drop`);
    ok(dev.includes('Every finding a review names ends FIXED, LOGGED to the DISMISSED file, AMENDED (6a) or ESCALATED (7). None is dropped silently.'),
      `${mode}: every finding is accounted for`);
    ok(dev.includes(SIBLINGS_STEP),
      `${mode}: a fix, found or required, covers every sibling path with the same mechanism that the zone routing fixes, and any other, excluded or other-block code included, is logged by place or class`);
    ok(dev !== '' && !dev.includes('medium/low polish') && !dev.includes('DROP silently'), `${mode}: no rule drops a finding silently`);
    const later = flat(laterRound[id].prompt(`develop ${id} r2`));
    ok(later.includes(`A prior review flagged issues in ${STATE}/gate/quality-review-${id}-r1.md. Your earlier work is already in the UNSTAGED working tree: build ON it, do NOT revert or redo it.`)
      && later.includes(`BUILD: READ ${STATE}/gate/quality-review-${id}-r1.md and route every finding and gap in it, at every tier, through the DECISION MATRIX below: fix it or log it.`),
      `${mode}: a later round's BUILD addresses every finding in the review file`);
    ok(later !== '' && !later.includes('resolve exactly those'), `${mode}: a later round no longer narrows to the flagged issues`);
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
    ok(dev.includes(`ONE POINTER line to ${STATE}/DECISIONS.md`) && /NO plan text/.test(dev),
      `${mode}: DECISIONS gets a pointer line only, no plan text`);
    ok(dev !== '' && !dev.includes(`ONE POINTER line to ${STATE}/NEEDS-USER.md`), `${mode}: NEEDS-USER gets no pointer line`);
    ok(/Count every entry you wrote in plan_amendments/.test(dev), `${mode}: the count is reported through the schema`);
  }
}

section('case 7 proceeding also writes an ESCALATED: line to the ledger the blind reviewer reads');
// The blind reviewer is not handed DECISIONS.md, which holds the escalated default, so without this line
// it flags the developer's default every round and a block that should accept parks.
{
  for (const [mode, id, r] of FRAMES) {
    const dev = r.prompt(`develop ${id}`);
    const esc = flat(dev.slice(dev.indexOf('ESCALATE (7)'), dev.indexOf('This is NOT a general code review.')));
    ok(esc.includes(`append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md`), `${mode}: case 7 writes the gate-scoped ledger`);
    ok(/ESCALATED: <the default you took/.test(esc), `${mode}: the line states the default taken`);
    ok(esc.includes(`the blind reviewer is NOT shown ${STATE}/DECISIONS.md`), `${mode}: with the reason attached`);
    ok(esc.includes(`You CANNOT proceed without the answer: append a FULL, self-contained entry to ${STATE}/NEEDS-USER.md`)
      && esc.includes('and set needs_user=true'), `${mode}: the blocking branch writes NEEDS-USER and stops`);
    ok(esc.includes(`You can proceed with a defensible default: append an entry to ${STATE}/DECISIONS.md (the choice, the options, the default you took and why), leave needs_user=false`),
      `${mode}: the proceeding branch writes DECISIONS`);
    ok(esc.includes(`Write to ${STATE}/NEEDS-USER.md only a question the user must answer before a block can finish. Never write an informational note, a test observation, a chore or a default you took to it.`),
      `${mode}: the developer writes only questions to NEEDS-USER`);
    const accDecisions = flat(r.prompt(`acceptance ${id}`));
    ok(accDecisions.includes(`${STATE}/DECISIONS.md — defaults the developer took, plan amendment pointers, and one line per `) && accDecisions.includes(', a record.'),
      `${mode}: acceptance reads DECISIONS as a settled-decision record`);
    const q = r.prompt(`quality ${id}`);
    ok(q !== '' && !q.includes('NEEDS-USER.md') && !q.includes('DECISIONS.md'), `${mode}: the blind reviewer is handed neither file`);
  }
}

section('a dismissal reason and a prose-only diff are both judged from the code alone');
// The blind reviewer reads the DISMISSED ledger but never the plan, so a reason citing a plan id is opaque.
{
  for (const [mode, id, r] of FRAMES) {
    const drop = r.prompt(`develop ${id}`).split('• DROP (1, 2, 6b or 8):')[1]?.split('• AMEND (6a)')[0] ?? '';
    ok(/decidable from the code alone: never\s+cite a plan id, block id, issue id or plan clause/.test(drop),
      `${mode}: a DROP reason never cites the plan`);
    ok(flat(drop).includes('A false-positive reason cites the file:line that refutes the finding.'),
      `${mode}: a false-positive DROP reason cites the line that refutes the finding`);
  }
  const q = (await run(GREEN_RUN)).prompt('quality block-a');
  ok(/A hunk that changes ONLY comments, string text or documentation has four checkable defects/.test(q)
    && q.includes('git -C E:/repo diff --word-diff')
    && flat(q).includes('Those four checks and the nit list bound your review of such a hunk.'),
    'the blind reviewer has a bar for a comment, string or documentation hunk');
  ok(flat(q).includes("and a claim the new text makes about this repo's code that the code contradicts, cited by line."),
    'the blind reviewer flags a new sentence the code contradicts');
  ok(flat(q).includes('A prompt template or other text an agent or a program acts on is behavior, not string text. '
    + 'Review it with the full checklist, and grade a contradiction in it by what an agent that follows it would do.'),
    'the blind reviewer reviews a prompt template as behavior, not under the four-check prose bar');
}

section('the developer is told the staged index holds blocks this run already accepted');
// From the second block on, git status shows earlier accepted blocks staged, and a developer cannot tell
// them from its own.
{
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`develop ${id}`)).includes('Anything YOU stage is reviewed by nobody and HALTS the run. '
      + 'The staged index already holds the blocks this run accepted before this one. '
      + 'Leave the index as it is: never unstage, restage or revert those blocks. '
      + 'You may still edit any file this block needs, including one an earlier block changed.'),
      `${mode}: the staging step says the staged entries are earlier accepted blocks, and a file they changed stays editable`);
  }
}

section('every scratch file an agent writes goes under scratch/, never into the blind reviewer\'s gate/');
// An agent that redirected the plan block or a test log into gate/ left plan text one read away from the blind reviewer (#3).
{
  for (const [mode, id, r] of FRAMES) {
    for (const role of ['develop', 'acceptance']) {
      const text = flat(r.prompt(`${role} ${id}`));
      ok(text.includes(`Write every scratch file, such as a plan block or a test log, under ${STATE}/scratch/, never under ${STATE}/gate/.`),
        `${mode}: the ${role} prompt sends every scratch file to scratch/ and none to gate/`);
    }
    ok(!r.prompt(`quality ${id}`).includes('/scratch/'), `${mode}: the blind prompt names no scratch dir`);
  }
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

section('acceptance returns no criteria count, and its pass log line and ledger row carry none');
// The engine never checked a self-reported count, so evidence_recorded alone marks a thin pass.
{
  for (const [mode, id, r] of FRAMES) {
    const schema = r.calls.find((c) => c.label.startsWith(`acceptance ${id}`))?.opts.schema;
    for (const field of ['criteria_total', 'criteria_met']) {
      ok(!(field in (schema?.properties ?? {})) && !(schema?.required ?? []).includes(field),
        `${mode}: the acceptance schema no longer lists ${field}`);
      ok(!r.prompt(`acceptance ${id}`).includes(field), `${mode}: and its prompt no longer names ${field}`);
    }
    const passLine = r.logs.find((l) => l.includes(`${id}: acceptance PASSED`)) ?? '';
    ok(/acceptance PASSED(?: — \d+ fix check\(s\))? — STAGED \(/.test(passLine) && !/criteria/.test(passLine),
      `${mode}: the pass log line carries no criteria count`);
    ok(!('criteria' in (r.out.ledger.find((row) => row.id === id) ?? { criteria: null })),
      `${mode}: the ledger row carries no criteria count`);
  }
}

section('acceptance re-checks every earlier review file of its block, and only the blind reviewer is kept from them');
// Reading a prior review anchors the blind reviewer (#5). Acceptance reads them after its own first check,
// so a finding that reopened, or closed on one path only, still counts as a gap.
{
  const earlierList = (a) => (a.match(/judgment stays\s+fresh:\n([\s\S]*?)\n\s+For each finding/)?.[1] ?? '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join(', ');
  for (const [mode, id, r] of FRAMES) {
    const q = r.prompt(`quality ${id}`);
    const a = r.prompt(`acceptance ${id}`);
    const schema = r.calls.find((c) => c.label.startsWith(`acceptance ${id}`))?.opts.schema;
    ok(/Do NOT read prior review files/.test(q), `${mode}: the blind prompt still forbids prior review files`);
    ok(a !== '' && !/Do NOT read prior review files/.test(a), `${mode}: the acceptance prompt no longer does`);
    ok(flat(q).includes('Review the CURRENT diff FRESH, catching new or nearby issues.'), `${mode}: the blind prompt keeps the fresh-review sentence`);
    ok(!/re-verifying earlier fixes/.test(q + a), `${mode}: neither prompt keeps the re-verify clause`);
    eq(earlierList(a), '(none: no review in this run has flagged this block)', `${mode}: round 1 lists no earlier review file`);
    ok(flat(a).includes('A blind review that came back clean is never on this list, since it found nothing. '
      + "That includes this round's blind review, when one ran."),
      `${mode}: the earlier-findings step says a clean blind review found nothing`);
    ok(/an earlier finding that is neither closed\s+nor declined/.test(a), `${mode}: an open earlier finding counts as a gap`);
    ok(/the earlier-findings\s+result/.test(a) && /BEFORE step 8/.test(a) && !/BEFORE step [67]/.test(a),
      `${mode}: the WRITE step records it and points at the renumbered DECIDE step`);
    ok(/every earlier finding closed or declined,[^•]*no regression →/.test(flat(a)), `${mode}: the pass branch requires it`);
    ok(schema?.required?.includes('earlier_reviews_read') && schema.properties.earlier_reviews_read?.type === 'integer',
      `${mode}: earlier_reviews_read is a required integer`);
    ok(String(schema?.properties?.pass?.description ?? '').includes('every earlier finding is closed or declined'),
      `${mode}: the pass description requires it too`);
  }
  const accPrompts = [...bus.byLabel('acceptance '), ...fixBus.byLabel('acceptance ')].map((c) => flat(c.prompt));
  ok(accPrompts.length > 0 && accPrompts.every((p) => p.includes('Review the CURRENT diff FRESH, catching new or nearby issues. '
    + 'Read prior review files only at your EARLIER FINDINGS step below.')),
    'every acceptance prompt keeps the fresh-review sentence and points at its EARLIER FINDINGS step');
  ok(accPrompts.every((p) => p.includes('The one exception is the file the WRITE step names. Read it only at the WRITE step, '
    + 'so the Write tool accepts the overwrite, and never use its content.')),
    'every acceptance prompt carves out the WRITE step file, read only to overwrite and never used');
  ok(/residual path goes in your review file at step 7\./.test(fixBus.prompt('acceptance fix-a')),
    'fix: step 1 points at the renumbered WRITE step');

  // r1 quality flags, r2 acceptance fails, r3 passes: each acceptance lists every file routed so far.
  const Q1 = `${STATE}/gate/quality-review-block-a-r1.md`;
  const A2 = `${STATE}/acceptance-review-block-a-r2.md`;
  const chain = await run({
    develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN),
    acceptance: (label) => (/r2$/.test(label) ? ACC_FAIL : { ...ACC_PASS, earlier_reviews_read: 2 }),
  }, ONE_BLOCK);
  eq(earlierList(chain.prompt('acceptance block-a r2')), Q1, 'round 2 lists the quality file that flagged round 1');
  eq(earlierList(chain.prompt('acceptance block-a r3')), `${Q1}, ${A2}`, 'round 3 adds the failed acceptance file, in round order');
  eq(chain.out.status, 'done (all blocks staged)', 'and the block stages on its round-3 pass');
  const fixChain = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS }, FIX_ONE);
  eq(earlierList(fixChain.prompt('acceptance fix-a r2')), `${STATE}/gate/quality-review-fix-a-r1.md`, 'the fix frame lists it too');

  // A short read is an audit flag like a thin pass, so the block still stages.
  const shortRead = await run({ develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS }, ONE_BLOCK);
  ok(shortRead.logs.some((l) => l.includes(`block-a r2: acceptance read 0 of 1 earlier review file(s) — audit ${STATE}/acceptance-review-block-a-r2.md`)),
    'reading fewer files than listed logs the warning');
  eq(shortRead.out.status, 'done (all blocks staged)', 'and the block still stages');
  const missing = await run({ develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: { ...ACC_PASS, earlier_reviews_read: undefined } }, ONE_BLOCK);
  ok(missing.logs.some((l) => /acceptance read undefined of 1 earlier review file\(s\)/.test(l)), 'a missing count warns, never reading as a full read');
  const fullRead = await run({ develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: { ...ACC_PASS, earlier_reviews_read: 1 } }, ONE_BLOCK);
  ok(!fullRead.logs.some((l) => /earlier review file\(s\)/.test(l)), 'a full read logs no warning');
  ok(!bus.logs.some((l) => /earlier review file\(s\)/.test(l)), 'nor does a round with no earlier review file');
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

section('acceptance may run a command that writes nothing, in every mode');
// Without a named check-only allowance, a verifier confirming freshness runs a regenerator, which writes.
{
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`acceptance ${id}`)).includes("Do NOT modify source code. Any command that writes nothing in the repo, such as a tool's check mode, is allowed. Return ONLY"),
      `${mode}: the allowance sits beside the no-modify line`);
  }
}

section('acceptance counts every defect it writes, in every mode: a prescribed or unreached regression is a gap, and the rest is dropped');
// An uncounted notes section is a channel no agent reads on a pass, so a waived regression staged unseen.
{
  for (const [mode, id, r] of FRAMES) {
    const a = flat(r.prompt(`acceptance ${id}`));
    ok(a.includes(mode === 'fix' ? 'EVERY DEFECT YOU WRITE IN YOUR REVIEW FILE COUNTS.' : 'EVERY DEFECT YOU WRITE COUNTS.'), `${mode}: every defect acceptance writes counts`);
    ok(a.includes('a third-party one included'), `${mode}: a third-party caller's behavior is in the regression bar`);
    ok(a.includes("Not a regression: - a test the gate step's suite rule allows to be red."), `${mode}: a suite-allowed red test is not a regression`);
    ok(a.includes("Every other such break or change is a regression. So is a comment or doc sentence that was true in the accepted baseline and that this cycle's diff made false."), `${mode}: a comment or doc sentence the cycle made false is a regression`);
    ok(a.includes('- a line number that another file cites, since every edit moves lines.'), `${mode}: a cited line number the edit moved is not`);
    ok(a.includes('prescribes the construction that causes it'), `${mode}: a prescribed regression still counts`);
    ok(a.includes('unreached by any current caller'), `${mode}: an unreached regression still counts`);
    ok(a.includes("Those calls are the developer's, never yours."), `${mode}: the call on a counted regression is the developer's`);
    ok(a.includes('escalates it when only a change in other code closes it. Once'), `${mode}: the developer's only waiver is an escalation that only a change in other code closes`);
    ok(!a.includes('dismiss or escalate'), `${mode}: a counted regression is never the developer's to dismiss`);
    ok(flat(r.prompt(`develop ${id}`)).includes(REGRESSION_BULLET(mode)),
      `${mode}: the developer's MATRIX never drops a regression and fixes it at any tier`);
    ok(a.includes('the OVERRIDE rule above governs it'), `${mode}: a ledgered one falls to the OVERRIDE rule`);
    ok(a.includes(mode === 'fix' ? 'Drop any other concern silently, except a new issue (step 1).' : 'Drop any other concern silently.'),
      `${mode}: anything below the bar is dropped${mode === 'fix' ? ', except a new issue' : ''}`);
    ok(a.includes('Your file holds no notes, observations or non-blocking section.'), `${mode}: the review file has no uncounted section`);
    if (mode !== 'fix') continue;
    // The gap list ends in "drop silently", so a fail condition a step states but the list omits passes.
    ok(a.includes('an ACTIONABLE entry reported SKIPPED, a touched entry'), 'fix: an ACTIONABLE entry reported SKIPPED is a gap');
    ok(a.includes('a non-empty diff with no FIXED claim'), 'fix: a non-empty diff with no FIXED claim is a gap');
    ok(a.includes('a gate not satisfied, an earlier finding that is neither closed nor declined, a failed risk audit, or a regression'), 'fix: an unsatisfied gate, unavailable tool included, is a gap');
  }
}

section('acceptance lists what is not a regression from one rule, in every mode and under both policies, and the developer\'s SELF-REVIEW and SIBLINGS phases name the removed-defect exception and its zones');
// The developer's sibling rule removed a defect on a sibling path of a required fix, and acceptance counted that change as a regression.
{
  const otherZones = (zones) => (zones === CHANGE_ZONES.connected ? CHANGE_ZONES.diffOnly : CHANGE_ZONES.connected);
  const removedDefect = (mode, zones) => `- a removed defect: a change that closes a finding an earlier review of this block named, or that closes the same defect on a sibling path of a change ${REQUIRED_BY[mode]} requires or of such a finding. It is not a regression only when you confirm from the code that the baseline behavior it removes was itself a defect and is that same defect, that the change alters no other behavior, that it lies in code this block's text does not exclude and ${OWNED_CODE}, and that it lies ${zones}.`;
  const removedDefectExcuse = (zones) => `Acceptance does not count as regressed a removed defect (a real defect that an earlier review finding names, or the same defect on a sibling path of such a finding or of a fix this block requires) that lies in code this block's text does not exclude and ${OWNED_CODE}, and ${zones}.`;
  const passage = (r, id) => {
    const a = flat(r.prompt(`acceptance ${id}`));
    const at = a.indexOf('A regression is any behavior');
    const end = at < 0 ? -1 : a.indexOf('OVERRIDE rule above governs it.', at);
    return end < 0 ? '' : a.slice(at, end);
  };
  for (const [policy, frames] of Object.entries(FRAMES_BY_POLICY)) {
    for (const [mode, id, r] of frames) {
      const a = flat(r.prompt(`acceptance ${id}`));
      const at = (s) => (a.includes(s) ? a.indexOf(s) : NaN);
      const zones = changeZones(policy, mode);
      const item = removedDefect(mode, zones);
      const otherWording = mode === 'fix' ? REQUIRED_BY.feature : REQUIRED_BY.fix;
      ok(a.includes(`without ${REQUIRED_BY[mode]} requiring it. A change counts as required only when ${REQUIRED_BY[mode]} names that change. A break that a prescribed construction causes, which ${REQUIRED_BY[mode]} does not name, is not required, so it is a regression. Not a regression: - a test`) && !a.includes(`without ${otherWording} requiring it`),
        `${policy} ${mode}: the definition keeps this frame's requirement wording, then opens the "Not a regression" list`);
      ok(a.includes(item) && !a.includes(removedDefect(mode, otherZones(zones))),
        `${policy} ${mode}: the list holds the removed-defect item with its conditions and the zones a ${policy} ${mode} block may change: ${zones}`);
      ok(at('Not a regression:') < at(item) && at(item) < at('Every other such break or change is a regression.')
        && at('Every other such break or change is a regression.') < at('So is a comment or doc sentence that was true in the accepted baseline'),
        `${policy} ${mode}: the definition, then the list, then the rule that everything else counts`);
      ok((policy === 'proactive') === a.includes(`- a behavior change that a "PROACTIVE ${id}:" line in`),
        `${policy} ${mode}: the PROACTIVE item is ${policy === 'proactive' ? 'listed' : 'absent'}`);
      ok((policy === 'focused') === a.includes(`- a behavior change that a "FOCUSED ${id}:" line in`),
        `${policy} ${mode}: the FOCUSED item is ${policy === 'focused' ? 'listed' : 'absent'}`);
      const dev = flat(r.prompt(`develop ${id}`));
      ok(dev.includes(removedDefectExcuse(zones)) && !dev.includes(removedDefectExcuse(otherZones(zones))),
        `${policy} ${mode}: the developer's SELF-REVIEW states acceptance's removed-defect excuse with acceptance's two scope conditions and the same zones`);
      ok(dev.includes(SIBLINGS_STEP),
        `${policy} ${mode}: the SIBLINGS phase fixes each sibling path the zone routing fixes, and leaves excluded and other-block code to a DISMISSED line`);
    }
  }
  const feature = passage(bus, 'block-a');
  const asBlockA = (text, id) => text.replace(`"FOCUSED ${id}:"`, '"FOCUSED block-a:"');
  const fixAsFeature = asBlockA(passage(fixBus, 'fix-a'), 'fix-a').replaceAll(REQUIRED_BY.fix, REQUIRED_BY.feature).replaceAll("an entry's **Fix:**", "this block's own text");
  ok(feature !== '' && asBlockA(passage(bus, 'block-b'), 'block-b') === feature && fixAsFeature === feature,
    'focused: every frame renders one passage, apart from the block id and the fix frame\'s ACTIONABLE-entry and **Fix:** wording');
  ok(passage(proBus, 'block-a') !== '' && passage(proBus, 'block-b').replace('"PROACTIVE block-b:"', '"PROACTIVE block-a:"') === passage(proBus, 'block-a'),
    'proactive: the feature and section frames render one passage, apart from the block id');
  ok(passage(proFixBus, 'fix-a') !== '' && passage(proFixBus, 'fix-a').replace('"PROACTIVE fix-a:"', '"FOCUSED fix-a:"') === passage(fixBus, 'fix-a'),
    'a fix block renders one passage under both policies, apart from the logged-fix tag');
}

section('a recorded amendment is logged, summed into the ledger and named in nextStep; zero is silent');
// `plan_amendments` is REQUIRED so "none" is an explicit claim, which only means something if the engine
// reads it (tests/CLAUDE.md §3).
{
  const one = await run({ ...GREEN_RUN, develop: { ...DEV_OK, plan_amendments: 1 } });
  ok(one.logs.some((l) => /⚠ block-a r1: 1 plan amendment\(s\) recorded — see E:\/r\/runs\/t\/AMENDED-block-a\.md/.test(l)),
    'the amendment is logged with the file that holds it');
  eq(one.out.ledger[0].planAmendments, 1, 'counted into the block\'s ledger record');
  ok(/PLAN AMENDED for: block-a, block-b/.test(one.out.nextStep), 'and nextStep names every amended block');
  ok(String(one.out.nextStep ?? '').includes('(and the pointer lines in E:/r/runs/t/DECISIONS.md) before you commit'),
    'and points at the DECISIONS pointer lines');

  const summed = await run({
    develop: firstRound({ ...DEV_OK, plan_amendments: 1 }, { ...DEV_OK, plan_amendments: 2 }),
    quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS,
  }, ONE_BLOCK);
  eq(summed.out.ledger[0].planAmendments, 3, 'rounds SUM into the ledger, never last-write-wins');

  const none = await run(GREEN_RUN);
  ok(!none.logs.some((l) => /plan amendment\(s\) recorded/.test(l)), 'a zero report logs nothing');
  eq(none.out.ledger[0].planAmendments, 0, 'the ledger record still carries the field');
  ok(!/PLAN AMENDED/.test(none.out.nextStep), 'and nextStep says nothing about amendments');
  ok(String(none.out.nextStep ?? '').includes('auditing every declined finding. Show the user each entry in E:/r/runs/t/DECISIONS.md if it exists, since each is a default the developer took, a plan amendment, or a fix'),
    'the closing sentence still names DECISIONS, since an escalated default lands there with no amendment');
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
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: true }] },
  }, FIX_ONE);
  eq(syncOf(allStale.out), 'fix-a=done,i-1=stale,i-2=stale', 'an all-stale block acceptance confirmed is done and each entry stale');

  const noChanges = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }]) }, FIX_ONE);
  eq(syncOf(noChanges.out), 'fix-a=blocked', 'a no-changes block is blocked and its SKIPPED entry untouched');

  const mixed = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }, { issue_id: 'i-2', status: 'STALE' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-2', actually_fixed: true }] },
  }, FIX_ONE);
  eq(syncOf(mixed.out), 'fix-a=done,i-2=stale', 'a SKIPPED and STALE mix acceptance confirmed is done, its STALE entry stale, its SKIPPED entry untouched');

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
  }, { ...FIX_ONE, plans: [{ ...FIX_ONE.plans[0], planPath: 'E:/' + 'deep/'.repeat(20) + 'inventory.md' }] });
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
  const plans = Array.from({ length: 300 }, (_, i) => onBus({ id: `block-${i + 1}`, mode: 'feature', gate: 'build-only' }));
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
  const plans = Array.from({ length: 400 }, (_, i) => onBus({ id: `block-${i + 1}`, mode: 'feature', gate: 'build-only' }));
  const { out, logs } = await run(GREEN_RUN, { ...baseArgs, plans });
  eq(out.status, 'stopped on the runtime log line cap (no room is left for a status line inside the log lines Claude Code keeps)', 'the run halts on the log line cap');
  const next = plans[out.plansDone.length]?.id;
  ok(out.plansDone.length > 0 && next, `the halt falls mid-run: ${out.plansDone.length} block(s) done`);
  ok(out.haltReason.startsWith(`Stopped before block ${next}:`), `the halt reason names the first block not run: ${next}`);
  ok(out.haltReason.includes('Relaunch with fresh `plan-edit.mjs args`') && !/startAt/.test(out.haltReason),
    'and says to relaunch with fresh plan-edit.mjs args, never startAt');
  const missing = idsWithoutKeptStatus(logs, out.plansDone);
  eq(missing.length, 0, `the first 1,000 lines hold a status line for every finished block${missing.length ? `, first miss ${missing[0]}` : ''}`);
  ok(logs.length <= 1000, `the logs number at most 1,000: ${logs.length}`);
}

section('a last block whose status lines overrun the runtime\'s first 1,000 returns them before any sweep runs');
// 322 one-round blocks leave room for one status line, and 200 fixed issues need two, so the last
// block's status lines overrun the cap. Awaiting the sweep after that leaves a stop that loses them.
{
  const ids = Array.from({ length: 200 }, (_, i) => `i-${i + 1}`);
  const plans = [...Array.from({ length: 322 }, (_, i) => onBus({ id: `block-${i + 1}`, mode: 'feature', gate: 'build-only' })),
    onBus({ id: 'fix-z', mode: 'fix', gate: 'green' })];
  const { out, logs, labels } = await run({
    ...GREEN_RUN,
    'develop fix-z': fixDev(ids.map((issue_id) => ({ issue_id, status: 'FIXED' }))),
    'acceptance fix-z': { ...FIX_PASS, fix_checks: ids.map((issue_id) => ({ issue_id, actually_fixed: true })) },
    'final-sweep': SWEEP_OK,
  }, { ...baseArgs, sweep: 'goal-coverage', goal: 'g', plans });
  ok(logs.slice(1000).some((l) => l.startsWith('status-sync ')), `the last block's status lines overrun the cap: ${logs.length} lines`);
  eq(out.plansDone.length, plans.length, 'every block is done');
  ok(!labels.includes('final-sweep'), 'the run spawns no sweep after the overrun');
  eq(out.status, 'stopped on the runtime log line cap (no room is left for a status line inside the log lines Claude Code keeps)', 'it halts on the log line cap');
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
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([{ issue_id: 'i-1', status: 'STALE' }])),
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
// blockRef hands the same text to the developer and to the verifier, whose prompt forbids modifying source.
{
  for (const args of [ONE_BLOCK, FIX_ONE]) {
    const { prompt } = await run({ ...GREEN_RUN, develop: args === FIX_ONE ? fixDev([{ issue_id: 'i-1', status: 'FIXED' }]) : DEV_OK, acceptance: args === FIX_ONE ? FIX_PASS : ACC_PASS }, args);
    const id = args.plans[0].id;
    const acc = prompt(`acceptance ${id}`);
    ok(acc !== '' && !/implement EXACTLY|implement ONLY/.test(acc), `${id}: acceptance is not told to implement`);
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
  ok(/GATES[^\n]*already ran before you were spawned/.test(r1), 'the gates already ran before the reviewer');
  ok(/a later stage re-runs them before anything is staged/.test(r1), 'and a later stage re-runs them');
  ok(/Never run them in full/.test(r1), 'running them in full is forbidden');
  ok(/test command only for ONE targeted test/.test(r1), 'one targeted test is allowed');
  ok(flat(r1).includes(`Any other command that writes nothing in the repo, such as a tool's check mode, and a probe script in a temporary folder outside the repo and outside the folder that holds ${STATE}/gate/ are allowed.`),
    'any other command that writes nothing and a probe script outside the repo and the folder holding gate/ are allowed');
  ok(r1.indexOf('test:  t\n') < r1.indexOf('Any other command that writes nothing'), 'the allowance follows the gate command list, so it excludes the gate commands');
  ok(/anything that breaks the\s+build or tests/.test(r1), 'a build or test break stays a defect class');
  ok(/READ every untracked file \(`\?\?`\)/.test(r1) && !/`\?\?`\/`A`/.test(r1), 'new files are the untracked ?? entries, not a staged A');
  ok(/staged half of an `AM` or `MM` file is baseline/.test(r1), 'an AM/MM file\'s staged half is baseline');
  ok(/diff --stat/.test(r1), 'a large diff starts from --stat');
  const absentLedger = 'It exists only once the developer has declined something, so a missing file means nothing is settled yet. Do not search for it elsewhere.';
  ok(r2 !== '' && flat(r1).includes(absentLedger) && flat(r2).includes(absentLedger), 'every round explains an absent ledger');
  ok(flat(prompt('acceptance block-a')).includes(absentLedger), 'and so does acceptance, which reads the same ledger');
  ok(r2.includes(`${STATE}/gate/DISMISSED-block-a.md`), 'and still points at the ledger');
  eq(stateRefsOutsideGate(r1 + r2).join(', '), '', 'no run-state path outside gate/ in either round');
}
// A red-baseline or build-only block has red or absent tests by design, and the blind reviewer must not learn that.
{
  const variants = [
    ['a green feature block', { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'feature', gate: 'green' })] }, DEV_OK],
    ['a red-baseline section block', { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'section', gate: 'red-baseline' })] },
      { ...DEV_OK, test_outcome: 'failed-expected' }],
    ['a suite: scoped run', { ...baseArgs, suite: 'scoped', plans: [onBus({ id: 'block-a', mode: 'feature', gate: 'green' })] },
      { ...DEV_OK, full_suite_outcome: 'scoped-skip' }]];
  const gateTexts = [];
  for (const [name, args, develop] of variants) {
    const { prompt } = await run({ ...GREEN_RUN, develop }, args);
    const q = prompt('quality block-a r1');
    ok(q !== '' && !/\b(green|red|passed|passing|failed|failing)\b/i.test(q), `${name}: the quality prompt states no gate outcome or kind`);
    gateTexts.push(q.match(/GATES[\s\S]*?test: {2}t\n/)?.[0] ?? '');
  }
  ok(gateTexts[0] !== '' && gateTexts.every((t) => t === gateTexts[0]), 'the gates text is identical for every mode, gate and suite');
}

section('tests_run_count counts what the runner reports, and a section block scopes by its test_selector line');
{
  const { calls, prompt } = await run({ ...GREEN_RUN }, { ...baseArgs, plans: [onBus({ id: 'sec', mode: 'section', gate: 'green' })] });
  const desc = calls.find((c) => c.label.startsWith('develop sec')).opts.schema.properties.tests_run_count.description;
  ok(/tests, or of assertions/.test(desc) && /0 = nothing ran = a FALSE green/.test(desc), 'the field covers assertion-counting runners and keeps the 0 rule');
  ok(desc.includes('When you ran both this block\'s verification and the full test gate, report the count of this block\'s verification: its `test_selector:` run when the block has one, else the test gate.'),
    'a developer that ran both reports its own block\'s verification count, so the 0-count guard sees a selector that matched nothing');
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

section('fix acceptance and the sweep return decisions only, never a prose field nothing reads');
// judge reads issue_id and actually_fixed, and the harness reads only the sweep's gap count. The prose
// lives in the review file and SWEEP.md.
{
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  const item = fix.calls.find((c) => c.label.startsWith('acceptance fix-a')).opts.schema.properties.fix_checks.items;
  eq(Object.keys(item.properties).join(), 'issue_id,actually_fixed', 'a fix check declares exactly issue_id and actually_fixed');
  eq(item.required.join(), 'issue_id,actually_fixed', 'both still required');
  ok(!/\bnote\b/.test(fix.prompt('acceptance fix-a')), 'the fix acceptance prompt never asks for a note');

  const swept = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, { ...baseArgs, sweep: 'goal-coverage', goal: 'g' });
  const sweepSchema = swept.calls.find((c) => c.label === 'final-sweep').opts.schema;
  ok(sweepSchema.required.includes('gap_count') && sweepSchema.properties.gap_count?.type === 'integer', 'the sweep schema requires an integer gap_count');
  ok(!('gaps' in sweepSchema.properties) && !sweepSchema.required.includes('gaps'), 'and declares no gaps list');
  ok(/gap_count/.test(swept.prompt('final-sweep')), 'the sweep prompt names gap_count');
  ok(sweepSchema.required.includes('suite_result') && sweepSchema.properties.suite_result?.type === 'string',
    'the sweep schema requires suite_result, since step 2 makes the suite outcome mandatory');
  const sweepText = flat(swept.prompt('final-sweep'));
  ok(sweepText.includes('Also grep every guide and README in the repo, including those of other components, for each file name, '
    + 'phrase or behavior the goal moves or renames.'),
    'the sweep greps every guide and README for what the goal moves or renames');
  ok(sweepText.includes('Run each distinct gate command once (build and test may be the same command) and record the real outcome.'),
    'the sweep runs each distinct gate command once');
  ok(sweepText.includes(`Before step 1, READ ${STATE}/DECISIONS.md and every ${STATE}/AMENDED-<id>.md (list ${STATE}/ to find them), each only if it exists. A recorded amendment or decision is never a gap.`)
    && sweepText.indexOf('Before step 1, READ') < sweepText.indexOf('PROCEDURE'),
    'the sweep reads the decisions and amendments before step 1, and a recorded one is never a gap');
  ok(sweepText.includes('Where a block\'s text explicitly excludes something the goal line covers, the block\'s text decides. A goal hit that no block\'s text names or excludes is still a gap.'),
    'an explicit exclusion in a block\'s text decides, and a goal hit no block names or excludes stays a gap');
}

section('the fix developer is never asked to count its entries');
// plan-block --list rejects a todo fix block with no entry, so a count the developer reports would guard nothing.
{
  const fixed = fixDev([{ issue_id: 'i-1', status: 'FIXED' }]);
  const rounds = await run({ develop: fixed, quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS }, FIX_ONE);
  const continued = await run({ develop: fixed, quality: CLEAN, acceptance: FIX_PASS }, { ...FIX_ONE, continueParked: ['fix-a'] });
  const devs = [...rounds.calls, ...continued.calls].filter((c) => c.label.startsWith('develop fix-a'));
  eq(devs.length, 3, 'rounds 1 and 2 and a continued round 1 ran');
  ok(devs.every((c) => !('entries_found' in c.opts.schema.properties) && !c.opts.schema.required.includes('entries_found')),
    'no fix developer schema carries entries_found');
  ok(devs.every((c) => !/entries_found/.test(c.prompt)), 'and no fix developer prompt names it');
}

section('an ESCALATED dismissal is held by acceptance in every mode, and the hold wins over OVERRIDE');
// Case 7 applies to all three frames. Without the hold in one frame, acceptance fails the escalated
// default, the developer re-escalates, and the rounds spin to a park.
{
  const feat = await run(GREEN_RUN);
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  for (const [name, p] of [['feature', feat.prompt('acceptance block-a')], ['section', feat.prompt('acceptance block-b')], ['fix', fix.prompt('acceptance')]]) {
    ok(flat(p).includes(HOLD_ESCALATED), `the ${name} acceptance frame holds an ESCALATED line`);
    ok(flat(p).includes(OVERRIDE_SKIPPED), `the ${name} acceptance frame applies its OVERRIDE to a SKIPPED line`);
  }
}

section('a fix round with no FIXED claim must leave an empty diff, since no claimed fix accounts for a change');
{
  const { prompt } = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'STALE' }]),
    quality: CLEAN,
    acceptance: FIX_PASS,
  }, FIX_ONE);
  ok(/NO FIXED CLAIM, NON-EMPTY DIFF: when the FIXED list in step 1 is empty, no claimed fix accounts for\n\s+a change, so the unstaged diff MUST be empty/.test(prompt('acceptance')),
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

section('a pass hands every agent one command per member block, and edits each status in its own file');
{
  const { out, calls } = await run({
    develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'SKIPPED' }, { issue_id: 'i-3', status: 'FIXED' }]),
    quality: CLEAN,
    acceptance: { ...FIX_PASS, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-3', actually_fixed: true }] },
  }, PASS_ARGS);
  const devPrompt = calls.find((c) => c.label.startsWith('develop')).prompt;
  ok(devPrompt.includes("'E:/plans/one.md' 'fix-a'") && devPrompt.includes("'E:/plans/two.md' 'fix-b'"), 'the developer gets a plan-block command per member');
  ok(devPrompt.includes('each redirected to its own file under E:/r/runs/t/scratch/ (create it if needed), never'), 'and reads each block from its own scratch file, since the Bash display cuts long output');
  ok(calls.find((c) => c.label.startsWith('acceptance')).prompt.includes('each redirected to its own file under E:/r/runs/t/scratch/'), 'and acceptance reads each block from a scratch file too');
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

// ---------------------------------------------------------------------------------------------
// Staging and verdict contradictions the round loop must not trust
// ---------------------------------------------------------------------------------------------
section('a developer that escalates AND will not confirm its work stayed unstaged halts even an unordered run');
// needs_user broke out before the staging guard, so an unordered run parked the block and carried on with
// self-staged work in the index no reviewer saw.
{
  const { out, labels } = await run({
    ...GREEN_RUN,
    develop: (label) => (/block-a/.test(label) ? { ...DEV_OK, needs_user: true, unstaged_confirmed: false } : DEV_OK),
    park: PARK_OK,
  });
  eq(out.status, 'BLOCKED (the developer did not confirm its work stayed out of the staged index, which neither reviewer reads)',
    'the staging halt wins over the unordered needs-user park');
  ok(!labels.some((l) => /block-b/.test(l)), 'block-b never started');
  ok(/also escalated a user-only decision \(see .*NEEDS-USER\.md\)/.test(out.haltReason), 'the halt reason also names the escalation');
  eq(out.ledger[0].needsUser, true, 'and the ledger records it');
  ok(/research each question in it first \(develop guide §6\)/.test(out.nextStep), 'nextStep sends the operator to research the escalation first');
  ok(!/resolve with the user/.test(out.nextStep), `and no park suffix sends it straight to the user: ${out.nextStep}`);
}

section('acceptance that FAILS a block but reports staged=true halts, never re-rounds over the index');
{
  const { out, labels, prompt } = await run({ ...GREEN_RUN, acceptance: { ...ACC_FAIL, staged: true }, park: PARK_OK });
  eq(out.status, 'BLOCKED (acceptance failed a block but staged it)', 'status');
  ok(!/unstage/i.test(out.status) && /unstage this block's files before resuming/.test(out.haltReason),
    'the unstage instruction lives in the halt reason, not the status');
  ok(/REJECTED block block-a in round 1 .*acceptance-review-block-a-r1\.md.*git -C E:\/repo diff --cached/.test(out.haltReason),
    `the reason names the block, round, file and the staged diff: ${out.haltReason.slice(0, 160)}`);
  ok(!labels.includes('develop block-a r2'), 'no second develop round runs over the staged index');
  ok(labels.includes('park:block-a'), 'any unstaged remainder is parked');
  ok(/acceptance rejected the block but staged it anyway; inspect `git -C E:\/repo diff --cached`/.test(prompt('park')), 'park is told the real cause');
  ok(!labels.some((l) => /block-b/.test(l)), 'block-b never started');
  eq(out.ledger[0].status, 'BLOCKED (acceptance staged a rejected block)', 'ledger status');
}
{
  const { out, logs } = await run({ ...GREEN_RUN, acceptance: { ...ACC_FAIL, staged: true, wrote_file: false }, park: PARK_OK });
  eq(out.ledger[0].status, 'BLOCKED (acceptance staged a rejected block)', 'the staged check still runs first');
  ok(/did not confirm writing .*acceptance-review-block-a-r1\.md, so that file may not exist/.test(out.haltReason),
    `an unwritten review file is never cited as one to see: ${out.haltReason.slice(0, 160)}`);
  ok(!/see .*acceptance-review-block-a-r1\.md/.test(out.haltReason), 'no "see" citation');
  ok(logs.some((l) => /⚠ block-a r1: acceptance verifier did not confirm writing/.test(l)), 'the log warns');
}

section('a fix the developer reverted and reported FAILED leaves acceptance\'s claimed-FIXED list');
{
  const reports = {
    develop: firstRound(
      fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FIXED' }]),
      fixDev([{ issue_id: 'i-1', status: 'FAILED' }, { issue_id: 'i-2', status: 'FIXED' }])),
    quality: CLEAN,
    acceptance: firstRound(FIX_GAP, { ...FIX_PASS, fix_checks: [{ issue_id: 'i-2', actually_fixed: true }] }),
  };
  const { byLabel, logs } = await run(reports, FIX_ONE);
  const claimedList = (p) => p.split('claims these issues FIXED:')[1].split('For EACH')[0];
  const [r1, r2] = byLabel('acceptance').map((c) => claimedList(c.prompt));
  ok(/- i-1/.test(r1) && /- i-2/.test(r1), 'round 1 lists both claimed fixes');
  ok(/- i-2/.test(r2), 'round 2 still lists i-2');
  ok(!/- i-1/.test(r2), 'round 2 drops the reverted i-1');
  ok(!logs.some((l) => /THIN EVIDENCE/.test(l)), 'one check for one live claim is not thin');
}

section('a park that did not clear, or a dead park, is never reported as having nothing to save');
// Either may leave work in the tree or in parked-<id>.patch, so "nothing to restore" could send the
// operator past it.
{
  const notCleared = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { saved: false, cleared: false, gates_green: true, patch_bytes: 0 } }, { ...ONE_BLOCK, maxRounds: 1 });
  ok(!/nothing to save/i.test(notCleared.out.nextStep), 'an uncleared park never says nothing to save');
  ok(/Park did NOT confirm a save or a clear for: block-a\. Their work may still be in the working tree or in .*parked-<id>\.patch: inspect both/.test(notCleared.out.nextStep),
    'nextStep says to inspect the tree and the patch');
  ok(!notCleared.logs.some((l) => /work saved to nothing to save/.test(l)), 'an uncleared park log line does not claim nothing to save');
  ok(notCleared.logs.some((l) => /work saved to nowhere: park confirmed no save or clear/.test(l)), 'the log line says park confirmed neither');

  for (const [what, park] of [['saved', { saved: true, cleared: false, gates_green: true, patch_bytes: 2048 }], ['contradictory', { saved: false, cleared: false, gates_green: true, patch_bytes: 2048 }]]) {
    const { out } = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park }, { ...ONE_BLOCK, maxRounds: 1 });
    ok(!/SAVED and cleared/.test(out.nextStep), `${what}: a patched park that did not clear never reads as cleared`);
    ok(/Work SAVED but NOT cleared from the tree for: block-a/.test(out.nextStep), `${what}: nextStep says the tree still holds it`);
  }

  const dead =await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: null }, { ...ONE_BLOCK, maxRounds: 1 });
  eq(dead.out.status, 'BLOCKED (a parked block left the tree unsafe)', 'a dead park is still unsafe');
  ok(/park agent for block block-a returned nothing \(skipped or died\), so whether its work is in .*parked-block-a\.patch or still in the working tree is unknown: inspect both/.test(dead.out.haltReason),
    'the reason says the outcome is unknown');
  ok(!/nothing to save/i.test(dead.out.nextStep), 'nextStep never says nothing to save');
  ok(/Park did NOT confirm a save or a clear for: block-a/.test(dead.out.nextStep), 'and name the block to inspect');
  ok(!dead.logs.some((l) => /work saved to nothing to save/.test(l)), 'the park log line does not claim nothing to save');

  const empty = await run({ develop: { ...DEV_OK, needs_user: true }, park: { ...PARK_OK, saved: false, patch_bytes: 0 } }, ONE_BLOCK);
  ok(/NO patch was written for: block-a/.test(empty.out.nextStep), 'a confirmed-clear empty park still reads as nothing to save');
  ok(!/Park did NOT confirm/.test(empty.out.nextStep), 'and is not listed as unconfirmed');
  ok(empty.logs.some((l) => /work saved to nothing to save/.test(l)), 'and its log line says nothing to save');
}

section('a quality clean:true that carries findings or contests is NOT clean');
// The prompt defines clean as no findings and no contests. Trusted, the contested or counted findings went
// to acceptance and never reached the developer.
{
  for (const [what, bad] of [['contested_dismissals', { ...CLEAN, contested_dismissals: 1 }], ['issue_count', { ...CLEAN, issue_count: 1 }]]) {
    const { labels, byLabel, logs } = await run({ ...GREEN_RUN, quality: firstRound(bad, CLEAN) }, ONE_BLOCK);
    ok(!labels.includes('acceptance block-a r1'), `${what}: no acceptance runs in round 1`);
    ok(byLabel('develop block-a r2')[0]?.prompt.includes('quality-review-block-a-r1.md'), `${what}: the next developer is sent to the quality file`);
    ok(logs.some((l) => /quality returned clean=true with issue_count=\d+ and contested_dismissals=\d+ — self-contradictory/.test(l)), `${what}: the contradiction is logged`);
  }
}

section('every blind review reports each finding at every tier under both policies, with no threshold');
// The developer's risk judgment decides when a blind review runs, so a review that runs hunts down to nit
// and blocks on any finding. Its round, its policy and the reviews before it change none of that.
{
  const pro = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, { ...PRO_ONE_BLOCK, conventions: 'two-space indent' });
  const focused = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, { ...ONE_BLOCK, conventions: 'two-space indent' });
  const last = await run({ ...GREEN_RUN, quality: FLAGGED, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 2 });
  const MAINTAINABILITY = '- maintainability: the nit list in the scale above.';
  for (const [label, r, rounds] of [['proactive', pro, [1, 2]], ['focused', focused, [1, 2]], ['focused, last round', last, [2]]]) {
    for (const round of rounds) {
      const call = r.byLabel(`quality block-a r${round}`)[0];
      const props = call?.opts?.schema?.properties ?? {};
      const q = flat(call?.prompt ?? '');
      const where = `${label} r${round}`;
      ok(q !== '' && !/threshold|THRESHOLD|STAGE [12]|\bstage [12]\b|\bdive\b|minor_count/i.test(q), `${where}: the prompt names no threshold, stage or below-threshold count`);
      ok(q.includes('Report every finding this diff introduces or exposes, at every tier.')
        && q.includes('HUNT. Working from critical down to nit, find every finding through the CHECKLIST and the REACH step.'),
        `${where}: it hunts and reports every tier, down to nit`);
      ok(q.includes(MAINTAINABILITY) && q.includes('Those four checks and the nit list bound your review of such a hunk.'),
        `${where}: its CHECKLIST keeps the nit list, a comment-only hunk included`);
      ok(q.includes('If you are confident a DISMISSED reason is WRONG, at any tier, raise the finding ONCE, prefixed "CONTESTS DISMISSAL:"'),
        `${where}: it may contest a dismissal at any tier`);
      ok(q.includes('When you found nothing, write exactly "No findings."')
        && q.includes('clean (true if you found no finding and contested no dismissal), issue_count (every finding you wrote, at every tier) and contested_dismissals via the schema.'),
        `${where}: a clean file reads "No findings." and clean means no finding and no contest`);
      ok(!('minor_count' in props) && String(call?.opts?.schema?.required ?? '') === 'wrote_file,clean,issue_count'
        && String(props.issue_count?.description ?? '').includes('every finding written to the review file, at every tier'),
        `${where}: issue_count counts every finding, and minor_count is gone`);
    }
    const q = flat(r.prompt('quality block-a'));
    ok(q.includes('A finding at medium or above names the concrete input or path that reaches it and its harm, cited by file:line. A real defect you cannot tie to a concrete input or path grades low at most.'),
      `${label}: only a medium or higher finding must name a concrete input`);
    ok(q.includes('the input or path and the harm (for a finding at medium or above), and a concrete fix'),
      `${label}: the review file asks the input or path and the harm only of a medium or higher finding`);
  }
  const q = pro.prompt('quality block-a');
  ok(q.includes('CONVENTIONS (judge against these): two-space indent'), 'the reviewer receives the conventions');
  ok(flat(q).includes('REACH: for every function, constant, field, string or rule the diff changes, grep its callers and consumers'), 'the REACH step');
  ok(q.includes('\n  nit      - not wrong and no effect on behavior, but it hurts clarity or maintainability.'), 'the scale keeps its nit line');
  ok(!/production-blocking/.test(q), 'no "production-blocking" bar is left');
  ok(flat(pro.prompt('develop block-a')).includes(MAINTAINABILITY) && flat(focused.prompt('develop block-a')).includes(MAINTAINABILITY),
    'the developer\'s SELF-REVIEW carries the same CHECKLIST under both policies');

  for (const value of ['low', 'medium', 'high', 'critical', 'nit', null]) {
    const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, reviewSeverity: value } });
    ok(msg.startsWith("args.reviewSeverity is retired: the developer's risk judgment decides when a blind review runs, and every blind review reports findings at every tier, so drop this key.")
      && msg.includes(`Got reviewSeverity ${JSON.stringify(value)}.`),
      `reviewSeverity ${JSON.stringify(value)} throws as retired: ${msg.slice(0, 70)}`);
  }
}

section('develop\'s SEVERITY_SCALE opens with debug\'s six lines');
// Neither engine is an importable module, so both are read as text.
{
  const scaleOf = (path) => {
    const src = readFileSync(join(REPO_ROOT, path), 'utf8');
    const open = 'const SEVERITY_SCALE = `';
    const at = src.indexOf(open);
    return at < 0 ? [] : src.slice(at + open.length, src.indexOf('`', at + open.length)).split('\n');
  };
  const develop = scaleOf(ENGINE);
  const debug = scaleOf('workflows/debug/review.mjs');
  eq(debug.length, 6, 'debug\'s scale is six lines');
  eq(develop.slice(0, 6).join('\n'), debug.join('\n'), 'develop\'s first six lines match debug\'s byte for byte');
  ok(develop[6]?.startsWith('  nit      - '), 'then the nit line');
}

section('a quality review routes on its finding count, whatever the tier');
// A single nit makes a review not clean, so every finding reaches the developer.
{
  for (const [policy, args] of [['focused', ONE_BLOCK], ['proactive', PRO_ONE_BLOCK]]) {
    const one = await run({ ...GREEN_RUN, quality: firstRound({ wrote_file: true, clean: false, issue_count: 1, contested_dismissals: 0 }, CLEAN) }, args);
    ok(!one.labels.includes('acceptance block-a r1') && one.byLabel('develop block-a r2')[0]?.prompt.includes('quality-review-block-a-r1.md'),
      `${policy}: one finding at any tier sends the block back to the developer`);
    ok(one.logs.some((l) => /r1: quality review found 1 issue\(s\) → develop addresses .*quality-review-block-a-r1\.md/.test(l)),
      `${policy}: and the log line names the count with no bar`);
  }

  const contradicts = await run({ ...GREEN_RUN, quality: firstRound({ wrote_file: true, clean: false, issue_count: 0 }, CLEAN) }, PRO_ONE_BLOCK);
  ok(!contradicts.labels.includes('acceptance block-a r1') && contradicts.labels.includes('develop block-a r2'),
    'clean=false with no finding still goes back to the developer');
  ok(contradicts.logs.some((l) => /quality returned clean=false with no finding and no contest — self-contradictory; treated as NOT clean/.test(l)),
    'and logs the self-contradiction');

  const budget = await run({ ...GREEN_RUN, quality: FLAGGED, park: PARK_OK }, PRO_ONE_BLOCK);
  ok(budget.labels.includes('develop block-a r5') && !budget.labels.includes('develop block-a r6') && budget.labels.includes('develop-closing block-a'),
    'maxRounds defaults to 5, and the closing pass follows round 5');
  ok(budget.logs.some((l) => /r5: quality review left 2 issue\(s\) open at round budget/.test(l)),
    'the round-budget line names the count');
}

section('a failing reviewer that did not attest its review file halts instead of routing a missing path');
{
  const q = await run({ ...GREEN_RUN, quality: { ...FLAGGED, wrote_file: false }, park: PARK_OK });
  eq(q.out.status, 'BLOCKED (a reviewer failed a block without confirming its review file)', 'quality: status');
  ok(!/check/i.test(q.out.status) && /Check whether that file exists before resuming/.test(q.out.haltReason),
    'quality: the check instruction lives in the halt reason, not the status');
  ok(/Quality reviewer for block block-a reported findings in round 1 but did not confirm writing .*quality-review-block-a-r1\.md/.test(q.out.haltReason), 'quality: the reason names the file');
  ok(!q.labels.includes('develop block-a r2'), 'quality: no developer is sent to it');
  ok(q.labels.includes('park:block-a'), 'quality: the work is parked');
  ok(!/quality-review-block-a-r1\.md/.test(q.prompt('park:block-a')), 'quality: park never cites the unwritten file');

  const a = await run({ ...GREEN_RUN, acceptance: { ...ACC_FAIL, wrote_file: false }, park: PARK_OK });
  eq(a.out.status, 'BLOCKED (a reviewer failed a block without confirming its review file)', 'acceptance: status');
  ok(!/check/i.test(a.out.status) && /Check whether that file exists before resuming/.test(a.out.haltReason),
    'acceptance: the check instruction lives in the halt reason, not the status');
  ok(/Acceptance verifier for block block-a failed the block in round 1 but did not confirm writing .*acceptance-review-block-a-r1\.md/.test(a.out.haltReason), 'acceptance: the reason names the file');
  ok(!a.labels.includes('develop block-a r2'), 'acceptance: no developer is sent to it');

  const fixA = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: { ...FIX_GAP, wrote_file: false }, park: PARK_OK }, FIX_ONE);
  eq(fixA.out.ledger[0].status, 'BLOCKED (review file not written)', 'fix-mode acceptance halts the same way');

  // On the clean and pass paths the verdict needs no file to act on, so only a warning is logged.
  const passes = await run({ ...GREEN_RUN, quality: { ...CLEAN, wrote_file: false }, acceptance: { ...ACC_PASS, wrote_file: false } }, ONE_BLOCK);
  eq(passes.out.status, 'done (all blocks staged)', 'an unattested clean or pass still lands');
  ok(passes.logs.some((l) => /quality reviewer did not confirm writing .*quality-review-block-a-r1\.md/.test(l)), 'the quality gap is logged');
  ok(passes.logs.some((l) => /acceptance verifier did not confirm writing .*acceptance-review-block-a-r1\.md/.test(l)), 'the acceptance gap is logged');

  const SWEPT = { ...baseArgs, sweep: 'goal-coverage', goal: 'g' };
  const GAPS = { complete: false, gap_count: 1, suite_result: 'green' };
  const unwritten = await run({ ...GREEN_RUN, 'final-sweep': { ...GAPS, wrote_file: false } }, SWEPT);
  ok(unwritten.logs.some((l) => /sweep: 1 potential gap\(s\) — .*SWEEP\.md was not written, so the gap count comes from the sweep's return alone/.test(l)), 'an unwritten sweep file is never cited as one to read');
  ok(/goal-coverage gaps — .*SWEEP\.md was not written/.test(unwritten.out.nextStep), 'nor in nextStep');
  const written = await run({ ...GREEN_RUN, 'final-sweep': { ...GAPS, wrote_file: true } }, SWEPT);
  ok(/goal-coverage gaps — read .*SWEEP\.md\./.test(written.out.nextStep), 'a written sweep file is cited');
}

section('an acceptance pass with gap_count above 0 is flagged as contradicting itself');
{
  const { out, logs } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, gap_count: 1 } }, ONE_BLOCK);
  eq(out.ledger[0].contradicted, true, 'the ledger flags it');
  ok(logs.some((l) => /CONTRADICTS ITS OWN PASS \(.*gap_count=1\)/.test(l)), 'the log carries the mark and the count');
  eq(out.status, 'done (all blocks staged)', 'flag only: the block still lands');
  const clean = await run(GREEN_RUN, ONE_BLOCK);
  eq(clean.out.ledger[0].contradicted, false, 'gap_count 0 is not flagged');
}

section('every develop prompt states its round and why a later stage can lack a file for a round');
// An agent that globbed for a round's review file read a missing one as a defect, when an earlier stage
// had sent that round back.
{
  const maxRounds = 3;
  const why = "Round numbers count develop rounds, so a later stage has no file for a round that an earlier stage sent back. Of the rounds that reach the blind review stage, the blind review runs on the block's first one in this launch, and on a later one only when a round since the block's last blind review judged a change not low risk or gave no judgment, or an acceptance verdict since then found a risk judgment wrong. Every other round has no blind review file, and neither has the closing pass, the one developer pass that follows round 3 when that round ends without acceptance staging the block. A round file of this block that this prompt does not name may come from an earlier launch of the block, whose park kept its own copies, so ignore it.";
  const plan = await run({ develop: DEV_OK, quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, { ...baseArgs, maxRounds });
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: firstRound(FIX_GAP, FIX_PASS) }, { ...FIX_ONE, maxRounds });
  for (const [mode, id, r] of [['feature', 'block-a', plan], ['section', 'block-b', plan], ['fix', 'fix-a', fix]]) {
    for (const stage of ['develop', 'quality', 'acceptance']) {
      for (const round of [1, 2]) {
        ok(flat(r.prompt(`${stage} ${id} r${round}`)).includes(`This is round ${round} of at most ${maxRounds}. ${why}`),
          `${mode} ${stage} r${round}: the prompt states its round of at most ${maxRounds} and the missing-file sentence`);
      }
    }
  }
  // The closing pass and its acceptance name the pass and its file number in place of a round of the budget.
  const closed = await run({
    develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK),
    quality: CLEAN, acceptance: (label) => (/r4$/.test(label) ? ACC_PASS : ACC_FAIL),
  }, { ...ONE_BLOCK, maxRounds });
  const closingNote = `This is the closing pass, numbered round 4 in its file names, after round 3 of at most 3. ${why}`;
  ok(flat(closed.prompt('develop-closing block-a')).includes(closingNote) && flat(closed.prompt('acceptance block-a r4')).includes(closingNote),
    'the closing pass and its acceptance state the closing pass and its file number');
}

section('the DROP line names one place or the class of places it covers, and its reason holds for each');
{
  for (const [mode, id, r] of FRAMES) {
    const dev = flat(r.prompt(`develop ${id}`));
    ok(dev.includes('`<file:line, or the class of places it covers> — <finding gist> — SKIPPED: <reason, ≤15 words>`'),
      `${mode}: the line shape allows the class form`);
    ok(dev.includes('Name one place by its file:line, or the class of places the line covers, such as every caller of a function. The reason must hold for every place the line names.'),
      `${mode}: the class names its scope and the reason must hold for every place`);
  }
}

section('both SETTLED variants say a DISMISSED line covers exactly what it names');
{
  const coverage = 'A DISMISSED line covers exactly what it names: one place, or every place in the class it names.';
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`quality ${id}`)).includes(coverage), `${mode}: the blind reviewer is told what a DISMISSED line covers`);
    ok(flat(r.prompt(`acceptance ${id}`)).includes(coverage), `${mode}: acceptance is told what a DISMISSED line covers`);
  }
}

section('acceptance counts a sibling path as a gap only when no DISMISSED line covers it');
// A class line has no line of its own per place, so an own-line test would count every covered caller as a gap.
{
  for (const [mode, id, r] of FRAMES) {
    const acc = flat(r.prompt(`acceptance ${id}`));
    const ledger = `${STATE}/gate/DISMISSED-${id}.md`;
    ok(!acc.includes('without its own line'), `${mode}: the sibling-path check no longer asks for a line of its own`);
    ok(acc.includes(`the same mechanism and that no line in ${ledger} covers`),
      `${mode}: step 2 (a) counts only a sibling path that no DISMISSED line covers`);
    ok(acc.includes(`that no line in ${ledger} covers keeps the same mechanism`),
      `${mode}: the gap rule counts only a sibling path that no DISMISSED line covers`);
  }
}

section('every developer frame works in six phases in every mode, policy and round, and its SELF-REVIEW judges only its own round\'s code with the blind reviewer\'s scale, reach step and checklist');
// The blind reviewer flagged what the developer could have caught with the same scale, reach step and checklist.
// Each earlier round had its own self-review, so the developer's own review stops at its round's code.
{
  const between = (s, from, to) => {
    const at = s.indexOf(from);
    const end = at < 0 ? -1 : s.indexOf(to, at);
    return end < 0 ? '' : s.slice(at, end);
  };
  const q = flat(bus.prompt('quality block-a'));
  const scale = between(q, 'SEVERITY - grade by impact', 'Report every finding this diff');
  const reachAndChecklist = between(q, 'REACH: for every function', 'HUNT. Working');
  ok(scale.includes('nit - not wrong and no effect on behavior') && scale.includes('NITS include:'), 'qualityPrompt still carries the severity scale');
  ok(reachAndChecklist.includes('comment or doc that describes the old behavior.')
    && reachAndChecklist.includes('CHECKLIST: - build and tests: anything that breaks the build or tests;')
    && reachAndChecklist.includes('a secret reaching a log, result or error; - maintainability: the nit list in the scale above.'),
    'qualityPrompt still carries the reach step and the checklist');

  // The two rules sit after the wrong-prose rule, so no reviewer grades a disagreement or an untested risky path as a nit.
  const gradeRules = [
    'Duplicated logic whose copies already disagree is a defect graded by the harm of the disagreement. It is never a nit.',
    'A risky path the diff adds with no test, such as an error path, a branch on outside input or a write to stored state, is a defect graded low or higher. It is never a nit.',
  ];
  const nitDuplication = 'small duplication inside the diff whose copies agree;';
  const wrongProse = 'by what the misled reader would do. It is never a nit.';
  ok(gradeRules.every((rule) => scale.includes(rule)) && scale.includes(nitDuplication) && !scale.includes('small duplication inside the diff;'),
    'qualityPrompt: the scale grades disagreeing duplication and an untested risky path above a nit, and the duplication nit covers copies that agree');
  ok(scale.indexOf(wrongProse) < scale.indexOf(gradeRules[0]) && scale.indexOf(gradeRules[0]) < scale.indexOf(gradeRules[1])
    && scale.indexOf(gradeRules[1]) < scale.indexOf('NITS include:'),
    'qualityPrompt: the two rules follow the wrong-prose rule and precede the nit list');

  const pattern ='PATTERNS: before you write code, find how the repo already does the same kind of thing, such as its names, data shapes and error path, and follow it where the block does not prescribe otherwise.';
  const phaseList = 'the six phases PATTERNS, BUILD, HARDEN, SIBLINGS, SELF-REVIEW and CLASSIFY, in this order';
  const procedure = { feature: `PROCEDURE: ${phaseList}.`, section: `PROCEDURE: ${phaseList}.`, fix: `PROCEDURE: VERIFY-FIRST, then ${phaseList}.` };
  const gateRerunText = /re-run the gate/i;
  const phaseHeads = [pattern, 'BUILD: ', 'HARDEN: ', 'SIBLINGS: ', 'SELF-REVIEW: ', 'CLASSIFY: '];
  // A phase after BUILD changes code after BUILD's gate run, so one gate run follows the last such phase and its outcome is reported.
  const phaseNotes = "Each phase after BUILD, while it works, runs only a targeted test of the code it changes, such as one test file, when the repo has one, and never the gate. A phase with nothing to do for this round's changes is skipped, such as HARDEN after a change to comments alone, or SIBLINGS when the round made no fix. When any phase after BUILD changed code, run the gate once more under BUILD's rules after the last such phase and before CLASSIFY. That run's outcome is the one you report. When no phase after BUILD changed code, BUILD's run is the one you report.";
  const fullSuite = 'Also run the FULL suite to confirm you did not redden it (report full_suite_outcome). When the verification command is already the full suite, its one run counts for both, and full_suite_outcome reports that run.';
  const harden = 'HARDEN: in the code this round added or changed, handle edge cases, handle each expected failure with a message that names its cause, log where the repo logs, add a test for each risky path, and clean up the code you wrote, at every tier of the SEVERITY scale below.';
  const reachSkip = 'In the REACH step, skip a sibling grep that the SIBLINGS phase already ran on the same code in this round.';
  const count = (text, sub) => text.split(sub).length - 1;
  const reviewScope = "SELF-REVIEW: before you return, apply the SEVERITY scale, the REACH step and the CHECKLIST below to the code this round changed or read: the part of your unstaged diff, new files included, that this round changed, and the code you read in this round, such as the callers and consumers the REACH step names. Code that earlier rounds changed and that this round neither changed nor read is out of this phase's scope, since each earlier round's self-review judged that round's code, and each blind review judges the entire block diff.";
  // Phrases that would aim the developer's own review at its entire diff.
  const entireDiff = ['so apply them to it first', '"The diff" they name is your unstaged diff', 'SELF-CHECK'];
  const writesCode = { feature: "Implement the plan's steps.", section: "Implement this block's steps.", fix: 'FIX ONLY the entries' };
  const rework = (id) => `BUILD: READ ${STATE}/gate/quality-review-${id}-r1.md and route every finding and gap in it, at every tier, through the DECISION MATRIX below: fix it or log it.`;
  const reworkKeeps = { feature: 'in place of the build', section: 'in place of the build', fix: 'beside the entry rules' };
  const accepts = {
    feature: 'that the feature is reachable from real entry points',
    section: 'that every call site this block owns is converted',
    fix: 'that each FIXED entry closes its root cause on every sibling path',
  };
  for (const policy of ['focused', 'proactive']) {
    const flaggedBus = await run({ develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS }, { ...baseArgs, changePolicy: policy });
    const flaggedFix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS }, { ...FIX_ONE, changePolicy: policy });
    // Both policies' blind reviewers carry one CHECKLIST, and the developer carries it too.
    const policyReach = between(flat(flaggedBus.prompt('quality block-a r1')), 'REACH: for every function', 'HUNT. Working');
    for (const [mode, id, r] of [['feature', 'block-a', flaggedBus], ['section', 'block-b', flaggedBus], ['fix', 'fix-a', flaggedFix]]) {
      for (const round of [1, 2]) {
        const where = `${policy} ${mode} r${round}`;
        const dev = flat(r.prompt(`develop ${id} r${round}`));
        const at = (s) => (dev.includes(s) ? dev.indexOf(s) : NaN);
        const heads = phaseHeads.map(at);
        ok(dev.includes(procedure[mode]) && heads.every((h, i) => i === 0 || heads[i - 1] < h) && heads[heads.length - 1] < at('DECISION MATRIX —'),
          `${where}: the procedure names the six phases and runs them in order, before the decision matrix`);
        if (round === 1) {
          const buildsBlock = at('BUILD: ') < at(writesCode[mode]) && at(writesCode[mode]) < at('Then RUN THE GATE') && !dev.includes('BUILD: READ');
          ok(buildsBlock, `${where}: BUILD builds the block, then runs the gate`);
        } else {
          const routesReview = at(rework(id)) < at('Then RUN THE GATE') && (mode === 'fix') === dev.includes(writesCode[mode]);
          ok(routesReview, `${where}: BUILD routes the review's findings ${reworkKeeps[mode]}, then runs the gate`);
        }
        ok(at('Then RUN THE GATE') < at(harden) && between(dev, 'HARDEN: ', 'SIBLINGS: ').startsWith(`${harden} `),
          `${where}: HARDEN works this round's code at every tier after the gate`);
        const procedureAt = at(procedure[mode]);
        ok(count(dev, phaseNotes) === 1 && at(`${procedure[mode]} ${phaseNotes}`) === procedureAt && procedureAt < at(pattern),
          `${where}: the procedure states once, beside the phase list, the targeted test, the skip rule and the one final gate run`);
        ok([['HARDEN: ', 'SIBLINGS: '], ['SIBLINGS: ', 'SELF-REVIEW: '], ['SELF-REVIEW: ', 'CLASSIFY: ']].every(([from, to]) => !gateRerunText.test(between(dev, from, to))),
          `${where}: HARDEN, SIBLINGS and SELF-REVIEW tell no re-run of the gate`);
        ok(dev.includes(reachSkip) && at(reachSkip) > at('SELF-REVIEW: ') && at(reachSkip) < at('REACH: for every function'),
          `${where}: SELF-REVIEW skips a sibling grep that SIBLINGS ran, and leaves the shared REACH text as it is`);
        ok(count(dev, `append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md (create ${STATE}/gate/ if it does not exist)`) === 2,
          `${where}: both lines that append to the DISMISSED file say to create the gate folder`);
        ok(dev.includes(fullSuite) && !dev.includes('Do NOT chase whole-suite green'),
          `${where}: under suite green the full-suite line counts the verification run for both when it is already the full suite`);
        ok(dev.includes(`${reviewScope} `) && entireDiff.every((s) => !dev.includes(s)),
          `${where}: SELF-REVIEW covers the code this round changed or read, and no line asks for a self-review of the entire block diff`);
        ok(scale !== '' && dev.includes(scale), `${where}: the developer carries the blind reviewer's severity scale`);
        ok(gradeRules.every((rule) => dev.includes(rule)) && dev.includes(nitDuplication) && !dev.includes('small duplication inside the diff;'),
          `${where}: and its SELF-REVIEW carries both grading rules and the narrowed duplication nit`);
        ok(policyReach !== '' && dev.includes(policyReach), `${where}: and its policy's reach step and checklist`);
        ok(dev.includes(`${REGRESSION_DEF} After the blind review, when one runs, acceptance checks `)
          && dev.includes('that each risk answer of a round no blind review judged holds against that round\'s own hunks')
          && Object.entries(accepts).every(([m, s]) => (m === mode) === dev.includes(s)),
          `${where}: the SELF-REVIEW says what ${mode} acceptance checks, and no other mode's`);
      }
    }
  }
  // A red gate leaves round 1's BUILD unfinished and names no review, so the next round builds again.
  const redGate = await run({ develop: firstRound({ ...DEV_OK, build_passed: false }, DEV_OK), quality: CLEAN, acceptance: ACC_PASS }, ONE_BLOCK);
  const afterRed = flat(redGate.prompt('develop block-a r2'));
  ok(afterRed.includes(`BUILD: ${writesCode.feature}`) && !afterRed.includes('BUILD: READ'), 'a round after a red gate with no review keeps round 1\'s BUILD');
}

section('a changed line is task code in full, the fixer follows each Fix line and hardens its code, and a prescribed construction never excuses a regression');
// Each phrase sits in the rendered prompt, so a rule that goes missing from one frame or one role fails here by name.
{
  const lineRule = {
    feature: 'Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding.',
    section: 'Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding.',
    fix: "Every line an ACTIONABLE entry's fix adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding.",
  };
  const fixerBuild = 'The code a fix adds is task code, so harden it like any task code. An edge case the prescribed form leaves out, such as an input value the form mishandles, is DECISION MATRIX rule 5 and takes no amendment. A change to what the **Fix:** line prescribes is a conflict with the plan, so it goes under 6a, 6b or rule 7 of the DECISION MATRIX below.';
  for (const [mode, id, r] of FRAMES) {
    const dev = flat(r.prompt(`develop ${id}`));
    const acc = flat(r.prompt(`acceptance ${id}`));
    ok(dev.includes(lineRule[mode]) && acc.includes(lineRule[mode]), `${mode}: the developer and acceptance prompts both say a changed line is task code in full`);
    ok(dev.includes(REGRESSION_BULLET(mode)) && !dev.includes('the acceptance review counted or your SELF-REVIEW found'),
      `${mode}: the matrix covers a regression any review names, and fixes a prescribed one under 6a or parks the block when it changes the user's choice`);
    ok(acc.includes(`A change counts as required only when ${REQUIRED_BY[mode]} names that change. A break that a prescribed construction causes, which ${REQUIRED_BY[mode]} does not name, is not required, so it is a regression.`)
      && acc.includes('Count each one, even when'),
      `${mode}: acceptance counts a change as required only when its text or entry names it, and a prescribed break the text does not name is a regression`);
    ok((mode === 'fix') === dev.includes(fixerBuild) && !dev.includes('exactly as instructed'),
      `${mode}: ${mode === 'fix' ? 'the fixer hardens the code a fix adds and sends a change to the prescribed form to 6a, 6b or 7' : 'no fixer wording'}, and no prompt says "exactly as instructed"`);
  }
}

section('changePolicy defaults to focused, sets the developer\'s build aim and zone routing, logs each fix of a defect already in the accepted baseline under its tag, and any other value throws');
// The user's CLAUDE.md and auto memory reach every agent too, so each developer prompt names the policy as the override.
{
  const policyLine = (policy) => `CHANGE POLICY: ${policy}. This policy and the scope rules in this prompt that carry it out settle scope for this run and override any other instruction about scope, including a memory line or a CLAUDE.md.`;
  const scopeLine = {
    feature: 'NO scope creep beyond the plan and the fixes the ZONE ROUTING below allows.',
    section: 'NO scope creep beyond this block and the fixes the ZONE ROUTING below allows.',
    fix: 'NO scope creep beyond what each fix requires and the fixes the ZONE ROUTING below allows.',
  };
  const best = 'with the change that has the best long-term result: correct, simple, maintainable and consistent with the repo. Leave a change that another block of the plan owns to that block.';
  const fixScope = `Fix each one as its **Fix:** line instructs, minimally and surgically. Change nothing on behalf of an entry that is not ACTIONABLE, in any zone. ${scopeLine.fix}`;
  const buildLine = {
    focused: {
      feature: `Build it minimally and surgically; match conventions; ${scopeLine.feature}`,
      section: `Build ONLY this block minimally and surgically; match conventions; ${scopeLine.section}`,
      fix: fixScope,
    },
    proactive: {
      feature: `Build it ${best} Match conventions; ${scopeLine.feature}`,
      section: `Build this block ${best} Match conventions; ${scopeLine.section}`,
      fix: fixScope,
    },
  };
  const rule4 = '4. A finding the ZONE ROUTING above fixes, at any tier, that does not conflict with the plan → FIX. A conflict with the plan still goes to 6a or 6b.';
  const route = "Hunt the task code in that scope for every finding at every tier. In the connected code in that scope, check your change's effects. Route each finding through the ZONE ROUTING above and the DECISION MATRIX below. In the REACH step, skip a sibling grep that the SIBLINGS phase already ran on the same code in this round. A regression here";
  const close = 'This is NOT a general code review. Make THIS block correct, testable and production-safe, make the fixes the ZONE ROUTING allows, and touch nothing else. Return ONLY the decision fields';
  const contest = '• A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is truly a user-only call, ESCALATE it. A contested pre-existing finding that the ZONE ROUTING above does not fix goes to 7, with the default of leaving it unchanged, since that routing bounds every change you make. NEVER log the same dismissal twice.';
  const FIX_NOUN = 'fix of a defect already in the accepted baseline';
  const loggedFixRule = (tag, id, mode) => `${tag} (this run's change policy): append ONE line to ${STATE}/DECISIONS.md for each ${FIX_NOUN} that you made, in any zone, without ${REQUIRED_BY[mode]} requiring it, and that no earlier round logged, naming its file:line, what changed and why: \`${tag} ${id}: <file:line> — <what changed> — <why>\``;
  const loggedFixItem = (tag, id, zones) => `- a behavior change that a "${tag} ${id}:" line in ${STATE}/DECISIONS.md names. It is not a regression only when you confirm from the code that the baseline behavior it removes was itself a defect, that the change alters no other behavior, that it lies ${OWNED_CODE}, and that it lies ${zones}. Every other such break or change is a regression.`;
  const loggedFixExcuse = (tag, zones) => `Nor does it count a removed defect that a ${tag} line in DECISIONS.md names and that lies ${OWNED_CODE}, and ${zones}.`;
  const step4 = '4. REGRESSION: compare the unstaged diff against the accepted baseline. Confirm that no previously-accepted behavior was changed or broken, apart from a change that meets an item of the "Not a regression" list above.';
  const settled = (tag, policy) => `${STATE}/DECISIONS.md — defaults the developer took, plan amendment pointers, and one line per ${FIX_NOUN} that this run's ${policy} change policy let the developer make, a record. A ${tag} line is never skipped for its stated reason, since the regression rule below judges each one.`;
  const decisionsNext = (tag, policy) => `Show the user each entry in ${STATE}/DECISIONS.md if it exists, since each is a default the developer took, a plan amendment, or a ${FIX_NOUN} that the ${policy} change policy allowed. Show a ${tag} line only after you confirm the code still holds its change, since a later round or a park can undo it`;

  ok(bus.logs.some((l) => l.startsWith('develop: 2/2 block(s) to build') && l.endsWith(', changePolicy=focused, commit=false]')), 'the default run\'s start line names focused');
  ok(proBus.logs.some((l) => l.startsWith('develop: 2/2 block(s) to build') && l.endsWith(', changePolicy=proactive, commit=false]')), 'a proactive run\'s start line names proactive');

  for (const [policy, frames] of Object.entries(FRAMES_BY_POLICY)) {
    const tag = policy.toUpperCase();
    const otherTag = policy === 'focused' ? 'PROACTIVE' : 'FOCUSED';
    for (const [mode, id, r] of frames) {
      const where = `${policy} ${mode}`;
      const zones = changeZones(policy, mode);
      const dev = flat(r.prompt(`develop ${id}`));
      ok(dev.includes(policyLine(policy)), `${where}: the developer prompt names the policy and its override`);
      ok(dev.includes(buildLine[policy][mode]), `${where}: the build line states the policy's aim and bounds scope by the zone routing`);
      ok(dev.includes(rule4) && dev.includes(RULE_2) && dev.includes(RULE_8),
        `${where}: rule 4 fixes what the zone routing fixes at any tier, rule 2 logs each pre-existing finding it leaves at any tier, and rule 8 weighs an open choice`);
      ok(dev.includes(route), `${where}: the SELF-REVIEW hunts only task code, at every tier, checks the change's effects in connected code, and routes each finding by the zones`);
      ok(dev.includes(close), `${where}: the closing sentence allows only the fixes the zone routing allows`);
      ok(dev.includes(contest), `${where}: a contested pre-existing finding at any tier that the zone routing leaves escalates with no change`);
      ok(dev.includes(REGRESSION_BULLET(mode)), `${where}: the MATRIX's regression bullet fixes a regression at any tier`);
      ok(dev.includes(`${REGRESSION_DEF} After the blind review`), `${where}: the SELF-REVIEW defines a regression, a falsified comment or doc sentence included`);
      ok(dev.includes(loggedFixRule(tag, id, mode)) && !dev.includes(`${otherTag} (this run`), `${where}: each fix of a defect already in the accepted baseline that ${REQUIRED_BY[mode]} does not require gets one ${tag} line in DECISIONS`);
      ok(dev.includes(loggedFixExcuse(tag, zones)) && !dev.includes(otherTag), `${where}: the SELF-REVIEW states acceptance's logged-fix excuse in the zones acceptance names, and no other tag`);
      ok((policy === 'focused' || mode === 'fix') === dev.includes('minimally and surgically'), `${where}: ${policy === 'focused' || mode === 'fix' ? 'the build is minimal and surgical' : 'no "minimally and surgically"'}`);
      ok(dev !== '' && !dev.includes('a little better'), `${where}: no closing line asks to leave touched lines a little better`);
      const acc = flat(r.prompt(`acceptance ${id}`));
      ok(acc.includes(settled(tag, policy)), `${where}: acceptance's DECISIONS entry says it also holds the ${tag} lines`);
      ok(acc.includes(loggedFixItem(tag, id, zones)) && !acc.includes(otherTag),
        `${where}: the last "Not a regression" item excuses a ${tag}-logged fix of a defect only in code no other block owns and ${zones}`);
      ok(acc.includes('escalates it when only a change in other code closes it. Once'), `${where}: acceptance names other code as the escalation's limit`);
      ok(!acc.includes('refactor'), `${where}: acceptance excuses no refactor`);
      ok(acc.includes(step4), `${where}: acceptance's regression step defers to the "Not a regression" list`);
    }
  }
  for (const [policy, r] of [['focused', bus], ['proactive', proBus]]) {
    const tag = policy.toUpperCase();
    const next = String(r.out.nextStep ?? '');
    ok(next.includes(decisionsNext(tag, policy)) && !next.includes(policy === 'focused' ? 'PROACTIVE' : 'FOCUSED'),
      `${policy}: nextStep says DECISIONS also holds the ${tag} lines, each shown only while the code holds its change`);
  }

  for (const bad of ['lenient', 'Focused', '']) {
    const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, changePolicy: bad } });
    ok(msg.startsWith('Invalid args.changePolicy: it must be one of focused, proactive') && msg.includes(JSON.stringify(bad)),
      `changePolicy ${JSON.stringify(bad)} throws naming the value: ${msg.slice(0, 90)}`);
    ok(msg.endsWith("It is not coerced, since it sets the developer's build aim and whether it fixes a pre-existing defect it notices in connected code."),
      `changePolicy ${JSON.stringify(bad)} says what the policy sets`);
    ok(!msg.includes('now named focused'), `changePolicy ${JSON.stringify(bad)} carries no rename sentence`);
  }

  const retired = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, changePolicy: 'strict' } });
  ok(retired.startsWith('Invalid args.changePolicy: it must be one of focused, proactive; got "strict".')
    && retired.includes('The policy strict is now named focused, so pass "focused" instead.'),
  `changePolicy "strict" throws the rename message: ${retired.slice(0, 160)}`);
}

section('every developer and acceptance prompt renders one code-zone map, the developer routes by zone, and no prompt names a per-policy bound');
// One zone map in every prompt keeps the developer's routing and acceptance's regression items on the same code.
{
  const count = (text, s) => text.split(s).length - 1;
  const routing = (policy) => `ZONE ROUTING - what you fix in each zone under this run's ${policy} change policy. A pre-existing finding is one the accepted baseline already had that the diff neither introduces nor exposes. - Task code: hunt it, and fix every finding in it at every tier, a defect the accepted baseline already had included. - Connected code: fix a finding the diff introduces or exposes there.`;
  const fixesConnected = 'Fix a pre-existing defect there when its fix is low risk under the RISK QUESTIONS below, and leave every other pre-existing finding there unchanged.';
  const keepsConnected = 'Leave every pre-existing finding there unchanged.';
  const routingTail = "- Other code: never change it. Close a finding the diff introduces or exposes there, such as a build break or a regression, at its source in task or connected code. When only a change in other code closes it, ESCALATE it (7). Never hunt outside task code. Read connected code to check your change's effects, and route what you notice there by these rules. A fix still follows the DECISION MATRIX's rules for a plan conflict (6a, 6b) and a user-only choice (7). Rule 2 of the DECISION MATRIX drops each pre-existing finding these rules do not fix, and RECORD below says which of them get a backlog entry.";
  // The retired per-policy bounds, the proactive past-reach permission and the focused rule 4 and SELF-REVIEW threshold.
  const RETIRED = [
    "this block's reach", 'add, change or interact with', "the code each ACTIONABLE entry's fix touches",
    'change code only to close a defect an earlier review finding names', 'An earlier review finding is one a review file of this block names',
    'Outside that reach', 'Outside that code', 'outside it make only the defect fixes', 'clear-win refactors', 'A clear win at any tier',
    'A critical, high or security finding in code this block adds or changes', 'Route every finding at medium or above', 'neither an earlier review finding nor',
    'owns, wherever it lies', 'Outside it, fix only a sibling path', 'the defect fixes this prompt allows',
  ];
  for (const [policy, frames] of Object.entries(FRAMES_BY_POLICY)) {
    for (const [mode, id, r] of frames) {
      const where = `${policy} ${mode}`;
      const zoneMap = CODE_ZONES(mode);
      const dev = flat(r.prompt(`develop ${id}`));
      const acc = flat(r.prompt(`acceptance ${id}`));
      const q = flat(r.prompt(`quality ${id}`));
      ok(count(dev, zoneMap) === 1 && count(acc, zoneMap) === 1,
        `${where}: the developer and acceptance prompts each render the one zone map once, with this mode's task code: ${TASK_CODE[mode]}`);
      ok(q !== '' && !q.includes('CODE ZONES') && !q.includes('ZONE ROUTING'), `${where}: the blind reviewer sees no zone, since task code names the block's required changes`);
      ok(dev.indexOf(zoneMap) < dev.indexOf(routing(policy)) && dev.indexOf(routing(policy)) < dev.indexOf('PROCEDURE: '),
        `${where}: the developer reads the zone map, then the zone routing, before its phases`);
      ok(acc.indexOf(zoneMap) >= 0 && acc.indexOf(zoneMap) < acc.indexOf('A regression is any behavior') && !acc.includes('ZONE ROUTING'),
        `${where}: acceptance reads the zone map just before the regression rule, and no routing`);
      const proactiveConnected = policy === 'proactive' && mode !== 'fix';
      ok(dev.includes(`${routing(policy)} ${proactiveConnected ? fixesConnected : keepsConnected} ${routingTail}`)
        && !dev.includes(proactiveConnected ? keepsConnected : fixesConnected),
        `${where}: connected code takes a fix of a defect the diff introduces or exposes${proactiveConnected ? ', and of a pre-existing one only when its fix is low risk' : ', and never another change'}, and other code takes none, a break the diff causes there closed at its source or escalated`);
      for (const [label, text] of [['developer', dev], ['acceptance', acc], ['blind reviewer', q]]) {
        const named = RETIRED.filter((s) => text.includes(s));
        ok(text !== '' && named.length === 0, `${where}: the ${label} prompt names no per-policy bound or past-reach permission${named.length ? `: ${named.join(' | ')}` : ''}`);
      }
    }
  }
  // The closing pass has no blind review after it, so its routing must match the rounds' routing.
  const closing = await run({ develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS), park: PARK_OK },
    { ...ONE_BLOCK, maxRounds: 1, changePolicy: 'proactive' });
  const closer = flat(closing.prompt('develop-closing block-a'));
  ok(count(closer, CODE_ZONES('feature')) === 1 && closer.includes(`${routing('proactive')} ${fixesConnected} ${routingTail}`),
    'the closing pass renders the same zone map and routing');
}

// ---------------------------------------------------------------------------------------------
// Commit mode: acceptance commits each accepted block, and the accepted baseline is HEAD
// ---------------------------------------------------------------------------------------------
// A quote and a non-ASCII letter, so the title reaches the commit file through JSON, never through shell quoting.
const TITLE = 'Add the "fast" path for ünïcode';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const C_BLOCK = { ...BLOCKS[0], title: TITLE };
const COMMIT_ONE = { ...ONE_BLOCK, commit: true, plans: [C_BLOCK] };
const DEV_C = { ...DEV_OK, baseline_staged_files: 0 };
const ACC_C = { ...ACC_PASS, committed: true, commit_sha: SHA, commit_subject: TITLE, tree_matches: true, tree_clean: true };
const C_RUN = { develop: DEV_C, quality: CLEAN, acceptance: ACC_C };
const nextOf = (out) => String(out?.nextStep ?? '');
const UNVERIFIED = 'BLOCKED (a block passed but its commit did not land as asked)';
const HALTED_NEXT = 'The run halted, so the index may hold work: check `git -C E:/repo diff --cached --stat` against the halt reason above.';
const schemaOf = (r, prefix) => r.calls.find((c) => c.label.startsWith(prefix))?.opts?.schema ?? { required: [], properties: {} };

section('commit takes true or false, and any other value throws naming the arg and the value');
{
  for (const bad of ['true', 'false', 1, null]) {
    const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, commit: bad } });
    ok(msg.startsWith('Invalid commit arg: args.commit must be true or false') && msg.includes(`got ${JSON.stringify(bad)}`),
      `commit ${JSON.stringify(bad)} throws naming args.commit and the value`);
  }
  eq((await run(GREEN_RUN, { ...ONE_BLOCK, commit: false })).out.status, 'done (all blocks staged)', 'commit false is stage mode');
  eq((await run(GREEN_RUN, ONE_BLOCK)).out.status, 'done (all blocks staged)', 'an absent commit is stage mode');
  eq((await run(C_RUN, COMMIT_ONE)).out.status, 'done (all blocks committed)', 'commit true is commit mode');
}

section('in commit mode a block title must be one line of text, since it is the commit\'s entire message');
{
  for (const bad of ['one\ntwo', '   ', 7, null]) {
    const msg = await throwsWith(ENGINE, { args: { ...COMMIT_ONE, plans: [{ ...BLOCKS[0], title: bad }] } });
    ok(msg.startsWith('plan title(s) [block-a: ') && msg.includes(JSON.stringify(bad)), `title ${JSON.stringify(bad)} throws in commit mode`);
    eq((await run(GREEN_RUN, { ...ONE_BLOCK, plans: [{ ...BLOCKS[0], title: bad }] })).out.status, 'done (all blocks staged)',
      `title ${JSON.stringify(bad)} is ignored in stage mode, which commits nothing`);
  }
  const untitled = await run({ ...C_RUN, acceptance: { ...ACC_C, commit_subject: 'block-a' } }, { ...COMMIT_ONE, plans: [BLOCKS[0]] });
  ok(flat(untitled.prompt('acceptance block-a')).includes('which is the JSON string "block-a", decoded'), 'a row with no title commits under its id, as plan-block.mjs prints it');
  eq(untitled.out.status, 'done (all blocks committed)', 'and its id is the subject the engine checks');
  // `plan-edit.mjs args --pack` prints a pass row's own title.
  const pass = await run({ develop: { ...DEV_C, results: [{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FIXED' }] }, quality: CLEAN,
    acceptance: { wrote_file: true, pass: true, staged: true, earlier_reviews_read: 0, regression: false, fix_checks: [{ issue_id: 'i-1', actually_fixed: true }, { issue_id: 'i-2', actually_fixed: true }], backlog_entries: 0, backlog_blocks: [], gap_count: 0, committed: true, commit_sha: SHA, commit_subject: 'pass of block-c, block-d', tree_matches: true, tree_clean: true } },
  { ...COMMIT_ONE, plans: [{ id: 'pass-1', title: 'pass of block-c, block-d', mode: 'fix', gate: 'green', blocks: [
    { id: 'block-c', planPath: 'E:/plans/one.md', issues: ['i-1'] }, { id: 'block-d', planPath: 'E:/plans/two.md', issues: ['i-2'] }] }] });
  ok(flat(pass.prompt('acceptance pass-1')).includes('which is the JSON string "pass of block-c, block-d", decoded'), 'a pass commits under its row title');
  eq(pass.out.ledger[0].commit, SHA, 'and records its commit');
}

section('in commit mode a round-1 developer that finds staged files halts before any reviewer, and never parks');
{
  const halt = await run({ develop: { ...DEV_C, baseline_staged_files: 2 }, park: PARK_OK }, COMMIT_ONE);
  eq(halt.calls.length, 1, 'only the developer ran, no reviewer spawned');
  ok(!halt.labels.some((l) => l.startsWith('park')), 'did NOT park the operator\'s staged work');
  eq(halt.out.status, 'BLOCKED (the index held staged work - nothing was built)', 'status');
  ok(nextOf(halt.out).endsWith(HALTED_NEXT) && !nextOf(halt.out).includes('Nothing is staged.'), 'nextStep points at the index, never says nothing is staged');
  const reason = String(halt.out.haltReason ?? '');
  ok(reason.includes('2 file(s)') && reason.includes('`git -C E:/repo diff --cached --stat`') && /commit them/.test(reason) && /unstage them/.test(reason),
    'the halt reason names the count and the command, and says to commit or unstage them');
  eq(`${syncOf(halt.out)} ${halt.out.ledger[0]?.status}`, 'block-a=blocked BLOCKED (staged baseline)', 'statusSync marks the block blocked, and the ledger says why');
  const dev = flat(halt.prompt('develop block-a r1'));
  ok(dev.includes('Then run `git -C E:/repo diff --cached --name-only` and report baseline_staged_files') && dev.includes('If either count is NOT 0, STOP RIGHT THERE'),
    'round 1 counts staged files and stops on either count');
  ok(schemaOf(halt, 'develop').required.includes('baseline_staged_files'), 'the developer schema requires the staged count');
  for (const bad of [undefined, null, '', false]) {
    const r = await run({ ...C_RUN, develop: { ...DEV_C, baseline_staged_files: bad } }, COMMIT_ONE);
    ok(r.logs.some((l) => /empty-index precondition was NOT verified/.test(l)), `a staged count of ${JSON.stringify(bad)} is not silently an empty index`);
  }
  const later = await run({ ...C_RUN, quality: firstRound(FLAGGED, CLEAN) }, COMMIT_ONE);
  ok(later.prompt('develop block-a r2').includes('Report baseline_dirty_files=-1 and baseline_staged_files=-1.'), 'a later round reports -1 for both counts');
  const stage = await run({ ...GREEN_RUN, develop: { ...DEV_OK, baseline_staged_files: 3 } }, ONE_BLOCK);
  eq(stage.out.status, 'done (all blocks staged)', 'stage mode, whose index holds the accepted blocks, never halts on a staged count');
  ok(!stage.prompt('develop block-a r1').includes('baseline_staged_files') && !('baseline_staged_files' in schemaOf(stage, 'develop').properties),
    'and never asks for one');
}

section('a commit-mode pass commits with the block title through a file, and the ledger, log and nextStep name the commit');
{
  const r = await run(C_RUN, COMMIT_ONE);
  const acc = flat(r.prompt('acceptance block-a r1'));
  ok(acc.includes(`newly-created files>\`, then COMMIT as step 9 says; return pass=true, staged=true.`) && !acc.includes('NEVER commit'),
    'the pass bullet stages, then commits');
  ok(acc.includes(`which is the JSON string ${JSON.stringify(TITLE)}, decoded, as the one line of ${STATE}/commit-block-a.txt`)
    && acc.includes('with no quotes, no other line and no trailer'), 'the title goes into the commit file as the message\'s one line');
  ok(r.prompt('acceptance block-a r1').includes('\n9. COMMIT, on a pass whose diff is not empty:'), 'the COMMIT step is its own numbered step after DECIDE, not part of the fail bullet');
  ok(acc.includes('Run `git -C E:/repo write-tree` and keep the tree id it prints.')
    && acc.includes('tree_matches=true only when `git -C E:/repo log -1 --format=%T` prints the tree id you kept')
    && acc.includes(`When it prints another, append both tree ids to ${STATE}/acceptance-review-block-a-r1.md, the kept one first.`),
  'the commit\'s tree is checked against the tree staged before it, and a mismatch records both trees');
  ok(acc.includes(`Run \`git -C E:/repo commit -F ${STATE}/commit-block-a.txt\`.`) && acc.includes('Never pass `--no-verify`, `--no-gpg-sign` or `--amend`.'),
    'it commits from that file, and never skips a hook or signing or amends');
  ok(acc.includes(`append its full output to ${STATE}/acceptance-review-block-a-r1.md, leave the work staged, and return committed=false`)
    && acc.includes('commit_subject from `git -C E:/repo log -1 --format=%s`')
    && acc.includes('return tree_clean=true only when `git -C E:/repo status --porcelain` then prints nothing'),
    'a refused commit leaves its output in the acceptance file, and the subject and tree come from git');
  ok(['committed', 'commit_sha', 'commit_subject', 'tree_matches', 'tree_clean'].every((k) => schemaOf(r, 'acceptance').required.includes(k)), 'the acceptance schema requires the five commit fields');
  eq(r.out.status, 'done (all blocks committed)', 'status');
  eq(r.out.ledger[0].commit, SHA, 'the ledger records the commit');
  eq(`${syncOf(r.out)} ${r.out.ledger[0].status}`, 'block-a=done done (committed)', 'statusSync marks the block done, and the ledger says committed');
  ok(r.logs.some((l) => l.includes(`acceptance PASSED — COMMITTED ${SHA}`)), 'the pass log line names the commit');
  ok(r.logs.some((l) => l.startsWith('develop: 1/1 block(s) to build') && l.endsWith(', commit=true]')), 'the launch line names commit mode');
  const next = nextOf(r.out);
  ok(next.includes(`Committed: block-a (${SHA}).`) && next.endsWith('Nothing is staged.') && !next.includes('Nothing is committed') && !next.includes('Staged/accepted'),
    'nextStep names the commit and says nothing is staged');
  ok(next.includes('run the full gates, `git -C E:/repo show --stat <sha>` for each commit above,') && !next.includes('diff --cached --stat'),
    'and verifies the run by its commits');
  ok(r.out.reviewTrail.endsWith('a git commit marks each accepted block.'), 'the review trail names the commit');

  const stage = await run(GREEN_RUN, ONE_BLOCK);
  eq(stage.out.ledger[0].commit, null, 'stage mode records no commit');
  const sacc = flat(stage.prompt('acceptance block-a r1'));
  ok(sacc.includes('newly-created files>` (NEVER commit); return pass=true, staged=true.') && !sacc.includes('COMMIT, on a pass') && !sacc.includes('committed=false'),
    'stage-mode acceptance never commits');
  ok(!('committed' in schemaOf(stage, 'acceptance').properties), 'and its schema has no commit field');
  ok(nextOf(stage.out).includes('Staged/accepted: block-a.') && nextOf(stage.out).endsWith('Nothing is committed — you commit.'), 'stage-mode nextStep keeps its wording');
}

section('a commit-mode pass halts commit-unverified on each failed landing check, alone, and names it with the reported value');
{
  const TWO = { ...COMMIT_ONE, plans: [C_BLOCK, { ...BLOCKS[1], title: 'next block' }] };
  const cases = [
    ['not committed', { committed: false, commit_sha: '', commit_subject: '' },
      (s) => s.includes('(1) not committed: committed=false.') && s.includes('A commit hook or commit signing may have refused the commit.')
        && s.includes(`STAGED and not committed, and the hook output is in ${STATE}/acceptance-review-block-a-r1.md`)
        && s.includes(`run \`git -C E:/repo commit -F ${STATE}/commit-block-a.txt\``) && !s.includes('show --stat')],
    ['unverified sha', { commit_sha: 'none' },
      (s) => s.includes(`(1) unverified sha: commit_sha="none" beside commit_subject=${JSON.stringify(TITLE)} names no commit id`)
        && s.includes('`git -C E:/repo log -1 --stat`') && !s.includes('show --stat')],
    ['wrong subject', { commit_subject: 'rewritten by a hook' },
      (s) => s.includes(`(1) wrong subject: commit_subject="rewritten by a hook" is not the block's title ${JSON.stringify(TITLE)}.`)
        && s.includes(`Inspect the commit with \`git -C E:/repo show --stat ${SHA}\`.`)],
    ['tree changed', { tree_matches: false },
      (s) => s.includes('(1) tree changed: tree_matches=false.') && s.includes('A pre-commit hook may have rewritten and re-staged files')
        && s.includes(`${STATE}/acceptance-review-block-a-r1.md names both tree ids`) && s.includes(`\`git -C E:/repo diff <staged tree id> ${SHA}\``)],
    ['tree dirty', { tree_clean: false },
      (s) => s.includes('(1) tree dirty: tree_clean=false.') && s.includes('A commit hook, the gate run, or a block file acceptance did not stage may have left these changes')
        && s.includes('`git -C E:/repo status --porcelain` lists them')],
  ];
  // A landed commit is rejected by its revert, a commit with no verified sha is found first, and staged work is unstaged.
  const REJECT = {
    'not committed': 'once you unstage and set its files aside, to `todo`',
    'unverified sha': 'once you revert each commit it made with `git -C E:/repo revert <sha>`, to `todo`',
    'wrong subject': `once you revert it with \`git -C E:/repo revert ${SHA}\`, to \`todo\``,
    'tree changed': `once you revert it with \`git -C E:/repo revert ${SHA}\`, to \`todo\``,
    'tree dirty': `once you revert it with \`git -C E:/repo revert ${SHA}\`, to \`todo\``,
  };
  for (const [name, over, reasonOk] of cases) {
    const r = await run({ ...C_RUN, acceptance: { ...ACC_C, ...over }, park: PARK_OK }, TWO);
    const reason = String(r.out.haltReason ?? '');
    eq(r.out.status, UNVERIFIED, `${name}: status`);
    ok(reasonOk(reason) && reason.includes('Its commit failed 1 landing check(s): (1)') && !reason.includes('(2)'), `${name}: the reason names that check alone, with its reported value`);
    ok(reason.includes('set its `status:` to `done`') && reason.includes(REJECT[name]), `${name}: and the recovery, with the reject step its landing needs`);
    ok(r.logs.some((l) => l.endsWith(`its commit failed ${name} → halting the run`)), `${name}: the log line names the check`);
    ok(!r.labels.some((l) => l.startsWith('park') || l.includes('block-b')), `${name}: nothing parks and the next block never starts`);
    eq(syncOf(r.out), 'block-a=blocked', `${name}: statusSync marks the block blocked`);
    ok(!reason.includes('confirmed closed'), `${name}: a feature block's halt names no fix issues`);
  }
  const fixHalt = await run({ ...C_RUN, develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { baseline_staged_files: 0 }),
    acceptance: { ...FIX_PASS, committed: true, commit_sha: SHA, commit_subject: 'rewritten by a hook', tree_matches: true, tree_clean: true } },
  { ...FIX_ONE, commit: true });
  ok(String(fixHalt.out.haltReason ?? '').includes(`also set each fix issue that ${STATE}/acceptance-review-fix-a-r1.md confirmed closed to \`fixed\` or \`stale\``),
    'a fix block\'s commit halt names the issue reset its kept work needs');
  const refused = await run({ ...C_RUN, acceptance: { ...ACC_C, committed: false } }, COMMIT_ONE);
  eq(refused.out.ledger[0]?.commit, null, 'a sha beside committed=false is not recorded as a commit');
  eq(refused.out.ledger[0]?.status, 'done (staged, its commit not made)', 'and the ledger says the work is staged');
  ok(nextOf(refused.out).endsWith(HALTED_NEXT), 'nextStep never claims nothing is staged');
  ok(nextOf(refused.out).includes('Accepted but its commit not made, its work staged: block-a.') && !nextOf(refused.out).includes('Accepted with no commit of their own'),
    'nextStep lists a refused commit as staged work, never as a no-op');
  const padded = await run({ ...C_RUN, acceptance: { ...ACC_C, commit_subject: `${TITLE}\n` } }, COMMIT_ONE);
  eq(padded.out.status, 'done (all blocks committed)', 'a subject reported with a trailing newline still matches its title');
  const sha256 = `${SHA}${SHA.slice(0, 24)}`;
  const longSha = await run({ ...C_RUN, acceptance: { ...ACC_C, commit_sha: sha256 } }, COMMIT_ONE);
  eq(`${longSha.out.status} ${longSha.out.ledger[0]?.commit}`, `done (all blocks committed) ${sha256}`, 'a SHA-256 commit id is a verified sha');
  for (const [name, over, value] of [['an omitted committed', { committed: undefined }, 'not committed: committed=undefined'],
    ['an omitted tree_clean', { tree_clean: undefined }, 'tree dirty: tree_clean=undefined'],
    ['an omitted tree_matches', { tree_matches: undefined }, 'tree changed: tree_matches=undefined'],
    ['a 41-digit sha', { commit_sha: `${SHA}0` }, `unverified sha: commit_sha="${SHA}0"`]]) {
    const r = await run({ ...C_RUN, acceptance: { ...ACC_C, ...over } }, COMMIT_ONE);
    ok(r.out.status === UNVERIFIED && String(r.out.haltReason ?? '').includes(value), `${name} never reads as a landed commit that passed its check`);
  }
  // A no-op returns the reviewed tree, so a blank sha beside another tree may hide a commit a hook rewrote.
  const noOpMatch = await run({ ...C_RUN, acceptance: { ...ACC_C, commit_sha: '', commit_subject: '', tree_matches: false } }, COMMIT_ONE);
  ok(noOpMatch.out.status === UNVERIFIED && String(noOpMatch.out.haltReason ?? '').includes('(1) unverified sha: commit_sha="" beside commit_subject="" names no commit id')
    && String(noOpMatch.out.haltReason ?? '').includes('this verdict reported tree_matches=false.'), 'a blank sha beside tree_matches=false is no no-op');
  // committed=true with a sha means the work is in HEAD, so a staged=false beside it must not drop that commit.
  const committedUnstaged = await run({ ...C_RUN, acceptance: { ...ACC_C, staged: false } }, COMMIT_ONE);
  eq(committedUnstaged.out.status, 'done (all blocks committed)', 'a pass that reports staged=false beside a landed commit lands as that commit');
  eq(committedUnstaged.out.ledger[0]?.commit, SHA, 'and the ledger records the commit');
  eq(committedUnstaged.out.ledger[0]?.contradicted, true, 'and flags the self-contradiction for audit');
  ok(committedUnstaged.logs.some((l) => l.includes(`staged=false beside commit ${SHA}`)), 'and the log names the contradiction');
  const unstagedRegression = await run({ ...C_RUN, acceptance: { ...ACC_C, staged: false, regression: true } }, COMMIT_ONE);
  ok(String(unstagedRegression.out.haltReason ?? '').includes(`reject → revert it with \`git -C E:/repo revert ${SHA}\``),
    'a staged=false regression pass with a landed commit names the revert of that commit, never a park');
  ok(!unstagedRegression.labels.some((l) => l.startsWith('park')), 'and parks nothing');
}

section('a commit-mode pass that fails several landing checks names every one, in check order');
{
  for (const [over, names] of [
    [{ commit_subject: 'rewritten by a hook', tree_matches: false }, ['wrong subject', 'tree changed']],
    [{ commit_subject: 'rewritten by a hook', tree_matches: false, tree_clean: false }, ['wrong subject', 'tree changed', 'tree dirty']],
    [{ commit_sha: 'N/A', tree_clean: false }, ['unverified sha', 'tree dirty']],
  ]) {
    const r = await run({ ...C_RUN, acceptance: { ...ACC_C, ...over } }, COMMIT_ONE);
    const reason = String(r.out.haltReason ?? '');
    const at = names.map((n, i) => reason.indexOf(`(${i + 1}) ${n}: `));
    eq(r.out.status, UNVERIFIED, `${names.join(' + ')}: one commit-unverified halt`);
    ok(reason.includes(`Its commit failed ${names.length} landing check(s): (1) ${names[0]}: `) && at.every((n, i) => n > (i ? at[i - 1] : 0)) && !reason.includes(`(${names.length + 1})`),
      `${names.join(' + ')}: the reason numbers every failed check in check order`);
    ok(r.logs.some((l) => l.endsWith(`its commit failed ${names.join(', ')} → halting the run`)), `${names.join(' + ')}: the log line names them in the same order`);
  }
}

section('a commit-mode pass whose sha is a placeholder, or blank beside a subject, is a commit the engine cannot verify');
{
  for (const [name, over] of [['"none" on a no-op', { commit_sha: 'none', commit_subject: '' }], ['"N/A" on a commit', { commit_sha: 'N/A' }],
    ['a blank sha beside a subject and another tree', { commit_sha: '', tree_matches: false }]]) {
    const r = await run({ ...C_RUN, acceptance: { ...ACC_C, ...over } }, COMMIT_ONE);
    const reason = String(r.out.haltReason ?? '');
    eq(r.out.status, UNVERIFIED, `${name}: it halts commit-unverified`);
    ok(reason.includes('(1) unverified sha: ') && !reason.includes('(2)') && !reason.includes('show --stat'), `${name}: the reason names the sha check alone and no show command`);
    eq(`${r.out.ledger[0]?.commit} ${r.out.ledger[0]?.status}`, 'null done (commit unverified)', `${name}: the ledger records no commit and says it is unverified`);
    ok(nextOf(r.out).includes('Accepted with a commit the engine could not verify: block-a.') && !nextOf(r.out).includes('Committed:')
      && !nextOf(r.out).includes('Accepted with no commit of their own'), `${name}: nextStep lists it as unverified, never as a commit or a no-op`);
    ok(r.logs.some((l) => l.includes('acceptance PASSED — COMMIT UNVERIFIED')), `${name}: the pass log line says unverified`);
  }
}

section('an acceptance-regression halt on a commit-mode pass appends the same failed landing checks');
{
  const regressed = await run({ ...C_RUN, acceptance: { ...ACC_C, regression: true } }, COMMIT_ONE);
  const rr = String(regressed.out.haltReason ?? '');
  ok(rr.includes(`COMMITTED as ${SHA}`) && rr.includes(`Inspect \`git -C E:/repo show --stat ${SHA}\``) && rr.includes(`reject → revert it with \`git -C E:/repo revert ${SHA}\``) && !rr.includes('unstage'),
    'a committed regression names the commit and its revert, never an unstage');
  ok(!rr.includes('landing check'), 'a regression whose commit landed as asked names no landing check');
  eq(regressed.out.status, 'BLOCKED (a block staged or committed while self-reporting a regression)', 'the commit-mode regression status names the commit');
  const both = String((await run({ ...C_RUN, acceptance: { ...ACC_C, regression: true, commit_subject: 'rewritten by a hook', tree_matches: false } }, COMMIT_ONE)).out.haltReason ?? '');
  const direct = String((await run({ ...C_RUN, acceptance: { ...ACC_C, commit_subject: 'rewritten by a hook', tree_matches: false } }, COMMIT_ONE)).out.haltReason ?? '');
  const list = direct.slice(direct.indexOf(' Its commit failed'), direct.indexOf(' Inspect the commit with'));
  ok(list.startsWith(' Its commit failed 2 landing check(s): (1) wrong subject: ') && both.endsWith(list),
    'the regression reason ends with the list the commit-unverified reason names');
  const unverifiedRegression = await run({ ...C_RUN, acceptance: { ...ACC_C, regression: true, commit_sha: 'none' } }, COMMIT_ONE);
  const ur = String(unverifiedRegression.out.haltReason ?? '');
  ok(ur.includes('was COMMITTED with no verified sha by acceptance') && ur.includes('Inspect `git -C E:/repo log -1 --stat`')
    && ur.includes('reject → revert each commit it made with `git -C E:/repo revert <sha>`') && !ur.includes('unstage') && !ur.includes('revert none'),
  'a regression on a commit with no verified sha finds it from HEAD and names its revert, never an unstage');
  ok(unverifiedRegression.logs.some((l) => l.includes('block-a: committed while self-reporting a REGRESSION')), 'and its log line says committed');
  const stagedRegression = await run({ ...C_RUN, acceptance: { ...ACC_C, regression: true, committed: false, commit_sha: '' } }, COMMIT_ONE);
  eq(stagedRegression.out.ledger[0]?.status, 'done (staged, its commit not made)', 'a regression pass whose commit did not land is staged, never a no-op');
  ok(nextOf(stagedRegression.out).endsWith(HALTED_NEXT), 'and nextStep never claims nothing is staged');
  const sr = String(stagedRegression.out.haltReason ?? '');
  ok(sr.includes('(1) not committed: committed=false.') && sr.includes(`the hook output is in ${STATE}/acceptance-review-block-a-r1.md`)
    && sr.includes(`\`git -C E:/repo commit -F ${STATE}/commit-block-a.txt\``), 'and its halt reason names the refused commit, the hook output and the commit that keeps the work');
}

section('a commit-mode no-op pass makes no commit, lands, and has no subject to check');
{
  const r = await run({ ...C_RUN, acceptance: { ...ACC_C, commit_sha: '', commit_subject: '' } }, COMMIT_ONE);
  eq(r.out.status, 'done (all blocks committed)', 'a no-op pass lands');
  eq(r.out.ledger[0].commit, null, 'the ledger records no commit');
  eq(r.out.ledger[0].status, 'done (no-op, nothing to commit)', 'and says why');
  ok(nextOf(r.out).includes('Accepted with no commit of their own: block-a.') && !nextOf(r.out).includes('Committed:')
    && nextOf(r.out).includes('run the full gates, `git -C E:/repo log --stat`,'), 'nextStep says the block made no commit');
  ok(flat(r.prompt('acceptance block-a r1')).includes('Make no commit, and return committed=true, commit_sha "", commit_subject "", tree_matches=true and tree_clean as step 9 says'),
    'the no-op bullet makes no commit and says what to return');
  const dirty = await run({ ...C_RUN, acceptance: { ...ACC_C, commit_sha: '', commit_subject: '', tree_clean: false } }, COMMIT_ONE);
  eq(dirty.out.status, UNVERIFIED, 'a no-op pass that left the tree dirty still halts');
  ok(String(dirty.out.haltReason ?? '').includes('(1) tree dirty: tree_clean=false.'), 'and names the dirty tree');
}

section('commit-mode acceptance that fails a block but reports a commit halts and names the revert');
{
  const r = await run({ ...C_RUN, acceptance: { ...ACC_FAIL, committed: true, commit_sha: SHA, commit_subject: TITLE, tree_clean: true }, park: PARK_OK }, COMMIT_ONE);
  eq(r.out.status, 'BLOCKED (acceptance failed a block but staged or committed it)', 'it takes the rejected-staged halt');
  eq(r.out.ledger[0]?.status, 'BLOCKED (acceptance committed a rejected block)', 'the ledger says the rejected block was committed');
  const staged = await run({ ...C_RUN, acceptance: { ...ACC_FAIL, staged: true, committed: false, commit_sha: '', commit_subject: '', tree_matches: false, tree_clean: true }, park: PARK_OK }, COMMIT_ONE);
  eq(staged.out.ledger[0]?.status, 'BLOCKED (acceptance staged a rejected block)', 'a rejected block that was only staged says staged');
  ok(nextOf(staged.out).endsWith(HALTED_NEXT), 'and nextStep never claims nothing is staged');
  ok(String(r.out.haltReason ?? '').includes(`revert it with \`git -C E:/repo revert ${SHA}\``), 'the halt reason names the revert of that commit');
  ok(r.prompt('park').includes('revert its commit with `git -C E:/repo revert <sha>`'), 'park is told the commit-mode cause');
  ok(flat(r.prompt('acceptance block-a r1')).includes('return pass=false (do NOT stage or commit, and return committed=false and commit_sha "")'),
    'the fail bullet forbids a commit');
  // A sha beside committed=false may be HEAD before this block, and its revert would undo an accepted block.
  const stale = await run({ ...C_RUN, acceptance: firstRound({ ...ACC_FAIL, committed: false, commit_sha: SHA, commit_subject: TITLE, tree_clean: true }, ACC_C) }, COMMIT_ONE);
  eq(stale.out.status, 'done (all blocks committed)', 'a fail that reports committed=false re-rounds, whatever sha it names');
  const placeholder = await run({ ...C_RUN, acceptance: { ...ACC_FAIL, committed: true, commit_sha: 'none', commit_subject: TITLE, tree_clean: true }, park: PARK_OK }, COMMIT_ONE);
  const pr = String(placeholder.out.haltReason ?? '');
  eq(placeholder.out.ledger[0]?.status, 'BLOCKED (acceptance committed a rejected block)', 'a fail that reports a commit with a placeholder sha still halts as committed');
  ok(pr.includes('reported commit "none"') && pr.includes('Inspect `git -C E:/repo log -1 --stat`') && pr.includes('revert each commit it made with `git -C E:/repo revert <sha>`')
    && !pr.includes('revert none'), 'and finds the commit from HEAD, never reverting the placeholder');
  // A fail must return committed=false, so committed=true with blank fields still reports a commit.
  const blankFail = await run({ ...C_RUN, acceptance: { ...ACC_FAIL, committed: true, commit_sha: '', commit_subject: '', tree_matches: true, tree_clean: true }, park: PARK_OK }, COMMIT_ONE);
  eq(blankFail.out.ledger[0]?.status, 'BLOCKED (acceptance committed a rejected block)', 'a fail that reports committed=true with a blank sha halts as committed, never as a no-op');
}

section('a refused commit fails only the not committed check, since git status lists its staged work');
{
  const r = await run({ ...C_RUN, acceptance: { ...ACC_C, committed: false, commit_sha: '', commit_subject: '', tree_matches: false, tree_clean: false } }, COMMIT_ONE);
  const reason = String(r.out.haltReason ?? '');
  eq(r.out.status, UNVERIFIED, 'a refused commit halts commit-unverified');
  ok(reason.includes('Its commit failed 1 landing check(s): (1) not committed: ') && !reason.includes('tree dirty'),
    'and never blames a hook rewrite for the staged work');
}

section('a dead acceptance verifier in commit mode names the HEAD its block started from and what to undo');
{
  const SHAS = { 'block-a': 'a'.repeat(40) };
  const accFor = (label) => (label.includes('block-b') ? null : { ...ACC_PASS, committed: true, commit_sha: SHAS['block-a'], commit_subject: 'block-a', tree_matches: true, tree_clean: true });
  const second = await run({ develop: DEV_C, quality: CLEAN, acceptance: accFor, park: PARK_OK }, { ...baseArgs, commit: true, plans: BLOCKS });
  const reason = String(second.out.haltReason ?? '');
  eq(second.out.status, 'BLOCKED (an agent returned nothing - it was skipped or died; its unstaged work is parked, and a dead acceptance may have staged or committed)',
    'commit mode: the status says a dead acceptance may have staged or committed');
  ok(reason.includes('Acceptance verifier for block block-b returned nothing') && reason.includes('It may have staged or committed the block before it died.')
    && reason.includes(`HEAD before this block was ${SHAS['block-a']}, the last commit of this launch`)
    && reason.includes('`git -C E:/repo log -1 --stat`') && reason.includes('`git -C E:/repo revert <sha>`')
    && reason.includes('`git -C E:/repo diff --cached --stat` lists any files it staged') && !reason.includes('nothing was staged'),
    'commit mode: the reason names the last commit, the revert and the staged check');
  const first = await run({ ...C_RUN, acceptance: null, park: PARK_OK }, COMMIT_ONE);
  ok(String(first.out.haltReason ?? '').includes('HEAD before this block was the HEAD this launch started from'), 'commit mode: the first block names the launch HEAD');
  const stage = await run({ ...GREEN_RUN, acceptance: null, park: PARK_OK });
  ok(String(stage.out.haltReason ?? '').includes("It may have staged the block's files before it died: check `git -C E:/repo diff --cached --stat`")
    && !String(stage.out.haltReason ?? '').includes('nothing was staged'), 'stage mode: the reason names the staged check, never "nothing was staged"');
}

section('the commit-mode sweep spot-checks each commit of this launch, and stage mode the staged diff');
{
  const SHAS = { 'block-a': 'a'.repeat(40), 'block-b': 'b'.repeat(40) };
  const args = { ...baseArgs, commit: true, goal: 'g', sweep: 'goal-coverage', plans: BLOCKS };
  const accFor = (label) => {
    const id = label.split(' ')[1];
    return { ...ACC_PASS, committed: true, commit_sha: SHAS[id], commit_subject: id, tree_matches: true, tree_clean: true };
  };
  const r = await run({ develop: DEV_C, quality: CLEAN, acceptance: accFor, 'final-sweep': SWEEP_OK }, args);
  const s = flat(r.prompt('final-sweep'));
  ok(s.includes(`block-a: \`git -C E:/repo show --stat ${SHAS['block-a']}\``) && s.includes(`block-b: \`git -C E:/repo show --stat ${SHAS['block-b']}\``),
    'the sweep lists each commit with its show command');
  ok(s.includes('A block an earlier launch accepted has its commit before these, in `git -C E:/repo log --stat`.'), 'and names where an earlier launch\'s commits are');
  ok(s.includes('its work is COMMITTED') && s.includes("every file in this launch's commits") && !s.includes('diff --staged'), 'and never spot-checks the empty staged diff');
  ok(nextOf(r.out).includes(`Committed: block-a (${SHAS['block-a']}), block-b (${SHAS['block-b']}).`), 'nextStep names both commits in block order');
  const stage = await run({ develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS, 'final-sweep': SWEEP_OK }, { ...args, commit: false });
  const ss = flat(stage.prompt('final-sweep'));
  ok(ss.includes('Spot-check the staged diff (`git -C E:/repo diff --staged --stat`)') && ss.includes('its work is STAGED') && !ss.includes('show --stat'),
    'stage mode spot-checks the staged diff');
}

section('every prompt and halt names the accepted baseline in its mode\'s own terms');
{
  const c = await run({ ...C_RUN, quality: firstRound(FLAGGED, CLEAN) }, COMMIT_ONE);
  const s = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, ONE_BLOCK);
  for (const [mode, r] of [['commit', c], ['stage', s]]) {
    const named = r.calls.filter((call) => call.prompt.includes('staged baseline')).map((call) => call.label);
    ok(named.length === 0, `${mode}: no prompt names a "staged baseline"${named.length ? `: ${named.join(', ')}` : ''}`);
  }
  const dev = flat(c.prompt('develop block-a r1'));
  ok(dev.includes('ACCEPTED blocks are COMMITTED (the accepted baseline is HEAD), so nothing is staged.')
    && dev.includes('HEAD already holds the blocks this run accepted before this one, each as its own commit. Leave HEAD and the index as they are: never commit, reset or revert.')
    && !dev.includes('The staged index already holds'), 'commit mode: the developer is told HEAD holds the accepted blocks');
  const sdev = flat(s.prompt('develop block-a r1'));
  ok(sdev.includes('ACCEPTED blocks are STAGED (the accepted baseline).') && sdev.includes('The staged index already holds the blocks this run accepted before this one.'),
    'stage mode: the developer is told the index holds them');
  ok(flat(c.prompt('quality block-a r1')).includes('HEAD is the ACCEPTED baseline, each accepted block one commit — context only')
    && flat(s.prompt('quality block-a r1')).includes('`git -C E:/repo diff --staged` is the ACCEPTED baseline — context only'), 'the blind reviewer is told where the baseline lives in each mode');
  ok(flat(c.prompt('quality block-a r1')).includes('A first-column `A` or `M` is STAGED, and only its unstaged half')
    && !flat(c.prompt('quality block-a r1')).includes('file is baseline'), 'commit mode never tells the blind reviewer that staged content is baseline');
  const acc = flat(c.prompt('acceptance block-a r2'));
  ok(acc.includes('HEAD = accepted baseline, each accepted block one commit (compare against it for regressions).')
    && acc.includes('A regression is any behavior the accepted baseline (HEAD, which holds each accepted block as its own commit) gave'),
    'commit-mode acceptance compares against HEAD');
  ok(flat(s.prompt('acceptance block-a r2')).includes('A regression is any behavior the accepted baseline (the staged index, or HEAD when nothing is staged) gave'),
    'stage-mode acceptance compares against the index');
  const park = await run({ ...C_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...COMMIT_ONE, maxRounds: 1 });
  const pk = flat(park.prompt('park'));
  ok(pk.includes('You commit nothing: only acceptance commits, and only a block it accepted.') && !pk.includes('Nothing is EVER committed')
    && pk.includes('would each stage it where no reviewer reads it and the next commit carries it'), 'commit-mode park commits nothing and names what staging would do');
  const dirty = String((await run({ develop: { ...DEV_C, baseline_dirty_files: 2 } }, COMMIT_ONE)).out.haltReason ?? '');
  ok(dirty.includes('Commit it (`git -C E:/repo add -A`, then `git -C E:/repo commit`) to KEEP it') && dirty.includes('without touching HEAD, which holds every accepted block as a commit')
    && dirty.includes('never `git add -A` or commit it'), 'the commit-mode dirty-baseline halt keeps the operator\'s edits by a commit');
  const unconfirmed = String((await run({ develop: { ...DEV_C, unstaged_confirmed: false }, park: PARK_OK }, COMMIT_ONE)).out.haltReason ?? '');
  ok(unconfirmed.includes("acceptance's commit takes whatever is staged") && !unconfirmed.includes('diff --staged` as the accepted baseline'),
    'the commit-mode staging halt names the commit that would carry self-staged work');
  const unstaged = String((await run({ ...C_RUN, acceptance: { ...ACC_C, staged: false, committed: false, commit_sha: '', commit_subject: '' } }, COMMIT_ONE)).out.haltReason ?? '');
  ok(unstaged.includes("and commit them with the block's title as the entire message"), 'the commit-mode passed-unstaged halt says to commit as well as stage');
  const none = await run({}, { ...COMMIT_ONE, plans: [{ ...C_BLOCK, status: 'done' }] });
  ok(nextOf(none.out).includes('(run the full gates, `git -C E:/repo log --stat`).') && !nextOf(none.out).includes('and commit.'),
    'the commit-mode nothing-to-run terminal verifies by the log and never says to commit');
}

// ---------------------------------------------------------------------------------------------
// A relaunch with the same runId finds the earlier launch's round files
// ---------------------------------------------------------------------------------------------
section('every develop prompt that writes a round file says to Read an earlier launch\'s file first, and a rejected write is not a write');
{
  const feat = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, { ...ONE_BLOCK, sweep: 'goal-coverage', goal: 'g' });
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  const commit = await run(C_RUN, COMMIT_ONE);
  const sites = [
    ['the developer risk file', flat(feat.prompt('develop block-a r1')), 1, 0],
    ['the blind quality file', flat(feat.prompt('quality block-a r1')), 1, 1],
    ['the feature-mode acceptance file', flat(feat.prompt('acceptance block-a r1')), 1, 1],
    ['the fix-mode acceptance file', flat(fix.prompt('acceptance fix-a r1')), 1, 1],
    ['the sweep file', flat(feat.prompt('final-sweep')), 1, 1],
    ['the commit message file', flat(commit.prompt('acceptance block-a r1')), 2, 1],
  ];
  pinWriteNotes(sites);
}
