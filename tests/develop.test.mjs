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
// A copy of the engine's rule, so a change to the one rule every backlog writer applies fails here.
const DECISION_RULE = `Set the entry's "- decision:" line by one rule. ACTIONABLE when the entry is a defect or a cleanup with one clear fix, its size is trivial or small, and the fix changes no user-visible behavior, stored data or public contract. NEEDS_USER otherwise, such as a feature, a refactor, a choice between fixes, or a fix that changes user-visible behavior. A later run builds an ACTIONABLE entry without triage, and a NEEDS_USER entry waits for the user.`;
// The grep wording of both backlog writers: the dedup before an append, and the Closed-by lookup.
const GREP = (pathOf, nameAt) => `grep the *.md files in ${BACKLOG}/ for ${pathOf} and for the name of the function or identifier at ${nameAt}, and read each entry that a grep matches`;
const DEDUP = (item) => `Before you append, create ${BACKLOG}/ if it does not exist, then ${GREP('the path of the file the new entry names', `the ${item}`)}. Append a ${item} only when no entry there with "- status: open" or "- status: needs-attention" already holds it. When the only entries that hold it say "- status: fixed" or "- status: stale", the ${item} is back in the code, so append a new entry whose **What:** names their ids.`;
// The plan-block.mjs path `plan-edit.mjs args` prints, which a launch spreads in.
const BLOCK_TOOL = 'E:/r/tools/plan-block.mjs';
// Every backlog writer appends through plan-entry.mjs beside blockTool, so no prompt holds the entry shape or id rule.
const ENTRY_TOOL = 'E:/r/tools/plan-entry.mjs';
// The risk file checker beside blockTool, which holds the risk file format and reruns each sweep search.
const RISK_TOOL = 'E:/r/tools/risk-check.mjs';
const ENTRY_INTRO = 'with the entry tool, since the tool numbers the entry, writes the header of a missing file and sets a skip file to todo';
const ENTRY_NEW = (file, block, runId = 't') => `node '${ENTRY_TOOL}' new --file '${file}' --block '${block}' --run '${runId}'`;
const ENTRY_FLAGS = "--file-ref '<path>:<line>' --severity <low|medium|high|critical> --category <category> --size <trivial|small|medium|large> --decision <ACTIONABLE|NEEDS_USER>";
const ENTRY_CHECK = (file) => `Then run \`node '${ENTRY_TOOL}' check '${file}'\` and fix each problem it prints.`;
// The flattened RECORD entry instruction for one file and block, the item named in its **What:** placeholder.
const ENTRY_RULE = (file, block, item) => `Write each entry ${ENTRY_INTRO}: ${ENTRY_NEW(file, block)} ${ENTRY_FLAGS} It prints the new entry's id on its first line. With the Edit tool, replace the entry's placeholder title with <title>, its **What:** placeholder with <the ${item}, the input or path that reaches it, and its harm> and its **Fix:** placeholder with <the change that closes it>. ${ENTRY_CHECK(file)}`;
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' }, backlogDir: BACKLOG, blockTool: BLOCK_TOOL, plans: BLOCKS };
const ONE_BLOCK = { ...baseArgs, plans: [BLOCKS[0]] };
const PRO_ONE_BLOCK = { ...ONE_BLOCK, changePolicy: 'proactive' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// Mirrors tools/flows/develop.flow.mjs, so "a healthy return" has one definition per engine. Only earlier_files
// differs: true here keeps every read step, false there traces the absent-file wording.
const DEV_OK   = { baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false, plan_amendments: 0, dismissed_count: 0, backlog_entries: 0, backlog_blocks: [], review_needed: true, risk_snapshot: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', baseline_index_tree: 'c0ffee0000000000000000000000000000000001', launch_number: 1, earlier_files: true };
const CLEAN    = { wrote_file: true, clean: true, issue_count: 0, contested_dismissals: 0 };
const FLAGGED  = { wrote_file: true, clean: false, issue_count: 2, contested_dismissals: 0 };
// The backlog fields are what a closing acceptance reports, and an earlier round ignores them.
const ACC_PASS = { wrote_file: true, pass: true, staged: true, index_matched: true, index_tree: 'c0ffee0000000000000000000000000000000001', earlier_reviews_read: 0, reachable: true, regression: false, evidence_recorded: true, gap_count: 0, backlog_entries: 0, backlog_blocks: [] };
const ACC_FAIL = { wrote_file: true, pass: false, staged: false, index_matched: true, index_tree: 'c0ffee0000000000000000000000000000000001', earlier_reviews_read: 0, reachable: false, regression: false, evidence_recorded: true, gap_count: 2, backlog_entries: 0, backlog_blocks: [] };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, commit_sha: 'd1e2f3a4b5c60718293a4b5c6d7e8f9012345678', entry_written: true };
// A park whose tree held no work of its block: no commit, and an entry that links no branch.
const PARK_EMPTY = { ...PARK_OK, saved: false, commit_sha: '' };
// The branch a park commits its block's work to, named by the block's backlog file id.
const UNFINISHED = (id, runId) => `aipg-unfinished/${backlogFileId(id, runId)}`;
const SWEEP_OK = { wrote_file: true, complete: true, gap_count: 0, suite_result: 'green' };
const GREEN_RUN = { develop: DEV_OK, quality: CLEAN, acceptance: ACC_PASS };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);
const syncOf = (out) => out.statusSync.map((e) => `${e.id}=${e.value}`).join(',');
const flat = (s) => s.replace(/\s+/g, ' ');
// The entries whose branch a fix block restores and its landing deletes, and what that restored work must meet.
const BRANCH_ENTRIES = 'each ACTIONABLE entry whose "- status:" is absent, open or needs-attention and that carries a "- branch:" line';
const LANDED_BRANCHES = `each distinct branch that the "- branch:" line of ${BRANCH_ENTRIES} names, when this verdict returned a fix_check with actually_fixed=true for every such entry that names it`;
const ORIGIN_CRITERIA = 'every acceptance criterion of each block its "- origin:" line names (`node \'E:/r/tools/plan-block.mjs\' \'<plan file>\' \'<block id>\'` prints a block), and, for a feature or section block, the reachability of its work from real entry points';
// Both kinds of reason in the developer's DISMISSED file, as each acceptance frame names them.
const OVERRIDE_SKIPPED = 'A line whose reason starts `SKIPPED:` declines a finding, and the OVERRIDE applies to it.';
const HOLD_ESCALATED = 'A line whose reason starts `ESCALATED:` records a default routed to the user, and the hold applies to it: hold it unless its stated reason is false. The hold wins over this OVERRIDE, so a held escalation never fails acceptance. Name it in your file as held.';
// The last DECIDE bullet of both acceptance frames, in a round that has a later round and in the closing pass.
const FAIL_NEXT_ROUND = '• Otherwise → return pass=false (do NOT stage); the gaps you wrote drive the next develop round.';
const FAIL_PARKS = '• Any blocking gap → return pass=false (do NOT stage); append no gap to the backlog, since the block parks and its backlog entry copies your blocking gaps first, then every other gap.';
// The closing acceptance's two gap kinds, per frame: a blocking gap parks the block, and every other gap goes to the backlog.
const closingBar = (kinds) => `CLOSING BAR. No develop round follows this verdict. Sort each gap into one of two kinds, and list each under the heading "## Blocking gaps" or, after it, "## Not blocking gaps" in your review file: • Blocking: a regression, a gate not satisfied, ${kinds}, a defect at medium severity or higher that this block's diff introduces, a wrong risk answer or a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, in changes no blind review has read, which is every gap your RISK AUDIT finds outside its TREE CHECK, a missing risk file included, or a path that changed after its round's snapshot, which is every gap your TREE CHECK finds. • Not blocking: every other gap, such as a low or nit finding or a cleanup. A finding this pass's blind review raised as "CONTESTS DISMISSAL" is neither closed nor declined, so it is a gap, sorted by the kinds above, unless the line it contests is a held escalation.`;
const CLOSING_BAR = {
  feature: closingBar('a criterion of this block not met, such as a change that is not reachable'),
  fix: closingBar('an ACTIONABLE entry whose root cause is not closed (an incomplete claimed fix, an unconfirmed STALE claim or an ACTIONABLE entry reported SKIPPED or left unreported), a change made for an entry that is not ACTIONABLE or a change that no FIXED claim accounts for'),
};
// The bullet fixes a regression at any tier under both policies, and escalates only one that only a change in other code closes.
// The bullet also names where a prescribed construction's regression goes, in each mode's own word for the prescriber.
const PRESCRIBER = { feature: "the block's text", section: "the block's text", fix: "an entry's **Fix:** line" };
const REGRESSION_BULLET = (mode, id) => `• A REGRESSION that a review of this block names, a blind review included, or that the acceptance review counted, and that you confirm against the code, or one your SELF-REVIEW found, is a bug, so never DROP it under 1, 2, 6b or 8. FIX it at any tier (6a when the fix conflicts with the plan), or ESCALATE it (7) with the default you took when only a change in other code closes it. A named regression you refute is dropped under rule 1 with the file:line that refutes it, as for any refuted review finding. A regression that a construction ${PRESCRIBER[mode]} prescribes causes is fixed under 6a, with an amendment that cites the regression as its defect evidence. When that fix would change a choice that ${PRESCRIBER[mode]} says the user made, it goes to rule 7's branch that cannot proceed, so the block parks with the user's question in ${STATE}/question-${id}.md.`;
const REGRESSION_DEF = "A regression here is a behavior of the accepted baseline that the acceptance check below counts as regressed, or a comment or doc sentence that was true in the accepted baseline and that this cycle's diff made false.";
const OWNED_CODE = 'in code no other block of the plan owns';
// The engine's one zone map, which every developer and acceptance prompt renders.
const TASK_CODE = {
  feature: "the code this block's required changes add or change. Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding",
  section: "the code this block's required changes add or change. Every line a required change adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding",
  fix: "the code each ACTIONABLE entry's fix adds or changes, and the sibling paths of each ACTIONABLE entry's root cause that lie in code this block's text does not exclude and in code no other block of the plan owns. Every line an ACTIONABLE entry's fix adds or changes is task code in full, so a pre-existing finding on such a line is a task code finding",
};
// Under proactive, a pulled backlog entry's fix is task code too, since acceptance judges it as the block's work.
const PULLED_TASK_CODE = ", and the code each pulled backlog entry's fix adds or changes";
const taskCode = (mode, policy) => (policy === 'proactive' ? TASK_CODE[mode].replace('. Every line', `${PULLED_TASK_CODE}. Every line`) : TASK_CODE[mode]);
// The proactive "Not a regression" item that excuses a pulled entry's fix.
const pulledRegressionItem = (id) => `- a behavior change that closes the defect of a backlog entry E:/r/runs/t/PULLED-${id}.md lists. It is not a regression only when you confirm from the code that the baseline behavior it removes was that entry's defect and that the change alters no other behavior.`;
const CODE_ZONES = (mode, policy = 'focused') => `CODE ZONES - every piece of code lies in one of three zones: - Task code: ${taskCode(mode, policy)}. - Connected code: the code a reach step from the task code finds, which is its callers and consumers, its sibling paths with the same mechanism, duplicates of the same logic, and the comments and docs that describe it, apart from code this block's text excludes or another block of the plan owns. - Other code: everything else.`;
// A feature or section block may change connected code for a defect its diff neither introduces nor exposes: any such
// defect under proactive, and one in a function or method that holds task code under focused.
const CHANGE_ZONES = {
  connected: 'in task code or in connected code',
  changedFunction: 'in task code, in connected code where the change closes a defect the diff introduces or exposes, or in connected code that lies in a function or method that holds task code',
  diffOnly: 'in task code, or in connected code where the change closes a defect the diff introduces or exposes',
};
const changeZones = (policy, mode) => (mode === 'fix' ? CHANGE_ZONES.diffOnly : policy === 'proactive' ? CHANGE_ZONES.connected : CHANGE_ZONES.changedFunction);

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
  ok(/diff --binary > E:\/r\/runs\/t\/set-aside-<n>\.patch/.test(out.haltReason),
    'and gives the set-aside remedy');
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
  // The run worktree never holds the user's edits, so any dirt kept by `git add -A` would land on the
  // user's branch unreviewed.
  ok(/is never the user's work\. Never `git add -A` it or commit it/.test(out.haltReason) && !/to KEEP it/.test(out.haltReason),
    'the halt never offers to keep run-worktree dirt');
  ok(/rewrote, such as a lockfile, also fix the command and save it again with `project-settings\.mjs set --provision`/.test(out.haltReason),
    'and names the provision fix for a rewritten tracked file');
  ok(/interrupted develop run's unfinished block, set it aside, then finish the develop guide's section 7 "Run killed mid-block" steps before you relaunch/.test(out.haltReason),
    'and an interrupted run\'s block is set aside before the relaunch');
  ok(/run-worktree dirt is never the user's work, so never git add -A it/.test(logs.join('\n')),
    'the log line says the same');
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
  // The entry's fix block reads the same plan block, so the operator fixes the plan reference before either route.
  eq(syncOf(out), 'block-a=blocked', 'a plan-unreadable park is held, never backlogged');
}
{
  // The verifier's sibling channel: a pass=false here would otherwise read as an ordinary gap and park
  // the block, hiding "the spec never arrived" behind a routine round-budget failure.
  const { out, labels } = await run({
    ...GREEN_RUN, acceptance: { ...ACC_FAIL, plan_obtained: false }, park: PARK_OK,
  });
  eq(out.status, 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)', 'status');
  ok(/Acceptance verifier for block block-a/.test(out.haltReason), 'halt reason names the role');
  eq(syncOf(out), 'block-a=blocked', 'an acceptance plan-unreadable park is held, never backlogged');
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
    eq(out.status, 'BLOCKED (the staged index may hold work no reviewer read: the developer did not confirm its work stayed unstaged, or acceptance found the index changed outside acceptance)',
      `unstaged_confirmed ${what} halts`);
    ok(!/inspect/i.test(out.status) && /Inspect `git -C E:\/repo diff --cached c0ffee0000000000000000000000000000000001` before resuming/.test(out.haltReason),
      'the inspect instruction lives in the halt reason, not the status, and diffs against the recorded index tree');
    ok(!labels.some((l) => l.startsWith('quality')), 'and halts BEFORE any review agent spawns');
    ok(labels.includes('park:block-a'), 'its work is parked rather than left in the tree');
  }
  const untreed = await run({ ...GREEN_RUN, develop: { ...DEV_OK, unstaged_confirmed: false, baseline_index_tree: '' }, park: PARK_OK });
  ok(String(untreed.out.haltReason ?? '').includes('Inspect `git -C E:/repo diff --cached` before resuming'),
    'with no recorded index tree the halt reason names the plain staged diff');
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
  ok(low.logs.some((l) => /r2: the developer judged every change since the block's last blind review or last clean risk audit low risk → no blind review; acceptance audits the judgment/.test(l)),
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

section('acceptance audits the risk file of each round since the block\'s last blind review or last clean risk audit');
{
  const LOW = { ...DEV_OK, review_needed: false };
  const r = await run({ develop: LOW, quality: CLEAN, acceptance: (label) => (/r[12]$/.test(label) ? ACC_FAIL : ACC_PASS) }, ONE_BLOCK);
  const a1 = flat(r.prompt('acceptance block-a r1'));
  const a3 = flat(r.prompt('acceptance block-a r3'));
  ok(a1.includes("RISK AUDIT. This round's blind review judged the entire block diff, so no risk file needs an audit. TREE CHECK."),
    'a reviewed round has no risk file to audit');
  // The tree acceptance stages must be the snapshot its round's developer judged, or a change after it went unjudged.
  const TREE_CMDS = (round) => `TREE CHECK. Before any change step 8 makes, run these commands, which write a temporary index file (create E:/r/runs/t/scratch/ if needed) and never the real index: cp "$(git -C E:/repo rev-parse --path-format=absolute --git-path index)" "E:/r/runs/t/scratch/snapshot-block-a-r${round}-acceptance.index" GIT_INDEX_FILE="E:/r/runs/t/scratch/snapshot-block-a-r${round}-acceptance.index" git -C E:/repo add -A GIT_INDEX_FILE="E:/r/runs/t/scratch/snapshot-block-a-r${round}-acceptance.index" git -C E:/repo write-tree`;
  for (const [a, round] of [[a1, 1], [a3, 3]]) {
    ok(a.includes(`${TREE_CMDS(round)} Delete the temporary index file once the last command has printed the tree id. Then run \`git -C E:/repo diff --name-only a1b2c3d4e5f60718293a4b5c6d7e8f9012345678 <the tree id the last command printed>\`. It lists each path that differs from a1b2c3d4e5f60718293a4b5c6d7e8f9012345678, the snapshot round ${round}'s developer took after its last change. A listed path that is untracked build output or a cache that a gate or test run regenerates is no gap. Any other listed path changed after that snapshot, so the tree you would stage is not the tree that developer handed on, which is a gap.`),
      `r${round}: acceptance snapshots the tree on its own index file and compares it with the round's returned snapshot`);
  }
  ok(a1.includes('which is a gap. Write each gap it finds in your review file and return risk_misclassified=true, which sends the next round to a blind review. Otherwise return risk_misclassified=false.'),
    'a reviewed round\'s tree mismatch is a risk-audit gap too');
  const noSnap = await run({ develop: { ...LOW, risk_snapshot: '' }, quality: CLEAN, acceptance: ACC_PASS }, ONE_BLOCK);
  const noSnapAcc = flat(noSnap.prompt('acceptance block-a r1'));
  ok(noSnapAcc.includes("RISK AUDIT. This round's blind review judged the entire block diff, so no risk file needs an audit. TREE CHECK. Round 1's developer returned no snapshot, so this check has nothing to compare. Write each gap it finds")
    && !noSnapAcc.includes('snapshot-block-a-r1-acceptance.index'),
    'a reviewed round that returned no snapshot has no tree to compare, since its blind review read the diff');
  ok(a3.includes('developer judged each change low risk: E:/r/runs/t/risk-block-a-r2.md E:/r/runs/t/risk-block-a-r3.md The first line of each risk file') && !a3.includes('round 1, base in'),
    'round 3\'s acceptance audits rounds 2 and 3, which no blind review judged, and not round 1, which one did');
  ok(a3.includes('round 2, base in E:/r/runs/t/risk-block-a-r1.md, snapshot in E:/r/runs/t/risk-block-a-r2.md: git -C E:/repo diff --stat <base> <snapshot>, then git -C E:/repo diff <base> <snapshot> -- <file> for each file it lists, one file per command')
    && a3.includes('round 3, base in E:/r/runs/t/risk-block-a-r2.md, snapshot in E:/r/runs/t/risk-block-a-r3.md: git -C E:/repo diff --stat <base> <snapshot>, then git -C E:/repo diff <base> <snapshot> -- <file> for each file it lists, one file per command'),
  'each audited round gets the command that shows its own hunks, from its snapshot and the snapshot of the round before it');
  ok(a3.includes('The first line of each risk file is `Snapshot: <tree id>`, a snapshot of the working tree after that round.')
    && a3.includes('<snapshot> and <base> are the tree ids on the first lines of the files named beside each command:')
    && a3.includes('check each answer it gives against the hunks of its own round under the RISK QUESTIONS below.'),
  'acceptance reads the tree ids from the risk files and checks each answer against its own round\'s hunks');
  ok(a3.includes('A missing file, a missing `Snapshot:` first line in an audited round\'s file or in the base file named beside its command, a change it does not judge low risk, and an answer the hunks contradict are each a gap. TREE CHECK.')
    && a3.indexOf('SWEEP CHECK.') < a3.indexOf('Read each risk file, and check each answer') && a3.includes('which is a gap. Write each gap in your review file and return risk_misclassified=true, which sends the next round to a blind review. Otherwise return risk_misclassified=false.'),
    'a wrong, missing, snapshotless or not-low-risk answer is a gap that sets risk_misclassified');
  ok(a3.includes('RISK QUESTIONS - answer each one for a change:') && a3.includes('A doubtful answer counts as yes. A change is low risk when every answer is no.'),
    'the audit renders the same risk questions');
  ok(a3.includes('a failed risk audit, or a regression') && a3.includes('risk audit clean, no regression →'),
    'a failed risk audit is a gap, and a pass needs a clean one');
  ok(a3.includes("A gap for a wrong risk answer, for a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, or for a path that changed after its round's snapshot, is closed, since the engine runs a blind review after the verdict that names it and before any later acceptance."),
    'an earlier risk gap or tree-check gap counts as closed');
  ok(a3.includes("This round's blind code review passed, or did not run because the developer judged each change since the block's last blind review or last clean risk audit low risk, which your RISK AUDIT checks.")
    && !/skipped because the developer changed nothing/.test(a3), 'the opening says why no blind review may have run');
  // A clean risk audit drops the rounds it audited, so the next acceptance audits only the rounds after them.
  const cleanAudit = await run({
    develop: LOW, quality: CLEAN,
    acceptance: (label) => (/r1$/.test(label) ? ACC_FAIL : /r2$/.test(label) ? { ...ACC_FAIL, risk_misclassified: false } : ACC_PASS),
  }, ONE_BLOCK);
  const cleanA2 = flat(cleanAudit.prompt('acceptance block-a r2'));
  const cleanA3 = flat(cleanAudit.prompt('acceptance block-a r3'));
  ok(cleanA2.includes('developer judged each change low risk: E:/r/runs/t/risk-block-a-r2.md The first line of each risk file'),
    'the acceptance of round 2 audits round 2, which no blind review judged');
  ok(cleanA3.includes('developer judged each change low risk: E:/r/runs/t/risk-block-a-r3.md The first line of each risk file')
    && !cleanA3.includes('round 2, base in') && cleanA3.includes('round 3, base in E:/r/runs/t/risk-block-a-r2.md, snapshot in E:/r/runs/t/risk-block-a-r3.md'),
  'after a clean audit of round 2, the acceptance of round 3 audits only round 3, with the snapshot of round 2 as its base');
  ok(a3.includes('round 2, base in') && a3.includes('developer judged each change low risk: E:/r/runs/t/risk-block-a-r2.md E:/r/runs/t/risk-block-a-r3.md'),
    'a verdict that returns no risk_misclassified boolean drops no round from the next audit');
  const accSchema = r.byLabel('acceptance block-a r3')[0]?.opts?.schema ?? {};
  ok(String(accSchema.required ?? '').includes('risk_misclassified') && accSchema.properties?.risk_misclassified?.type === 'boolean', 'risk_misclassified is a required boolean');
  // The sweep: the developer records it in CLASSIFY and acceptance's risk audit checks the latest audited round's.
  const d1 = flat(r.prompt('develop block-a r1'));
  const q1 = flat(r.prompt('quality block-a r1'));
  ok(d1.includes("again until it prints ok. Add a sweep search for each function, constant, field, message or rule phrase this round changed. Search a changed or removed rule phrase, message or name by its old wording, and by its new wording too when other text must repeat it. A changed field, return value, file format or output that other code or prompts read needs a search that finds those readers.")
    && !d1.includes('marked `updated` or `unaffected`') && !d1.includes('"No changes."'),
    'CLASSIFY has the developer add a sweep search for each changed name or phrase, and leaves the file format to the risk tool');
  // The risk tool holds the risk file format and reruns each search, so neither prompt restates the format or reruns a search by hand.
  ok(d1.includes(`Then run \`node '${RISK_TOOL}' 'E:/r/runs/t/risk-block-a-r1.md' --repo 'E:/repo' --snapshot <that tree id>\`. This risk tool holds the file's format.`)
    && d1.includes('Then run the command again until it prints ok.')
    && d1.includes("Return review_needed=false only when the command's last line reads `low risk: yes`, and true otherwise."),
  'CLASSIFY runs the risk tool on its own file until it prints ok, and returns review_needed from its last line');
  ok(a3.includes(`SWEEP CHECK. When E:/r/runs/t/risk-block-a-r3.md, the file of the latest round named above, exists, run \`node '${RISK_TOOL}' 'E:/r/runs/t/risk-block-a-r3.md' --repo 'E:/repo' --snapshot ${DEV_OK.risk_snapshot}\`.`)
    && a3.includes('Each line it prints that starts `error:` is a gap.')
    && !a3.includes('Run the search each line names again.')
    && a3.includes('A changed name or phrase with no line, and a hit marked `unaffected` that disagrees with the change, are each a gap.')
    && a3.includes('A hit the line leaves out is a gap only when it needs a change the diff did not make or disagrees with the change. Name each left-out hit you judge unaffected, with its reason, in the risk-audit result of your review file, and count it as no gap.')
    && !a3.includes('finds a hit the line leaves out is a gap too')
    && a3.includes('A round whose file reads "No changes." has no section and no gap here.')
    && !a1.includes('SWEEP CHECK'),
  'a missing sweep line or an unaffected hit that disagrees is a gap in the latest audited round, and a reviewed round has no sweep to audit');
  ok(d1.includes("that the sweep of the latest such round lists each changed name or phrase of that round's hunks and each hit it marks unaffected still agrees with the change and a rerun of each line's search finds no hit the line leaves out that the change left wrong"),
    'the developer is told the acceptance check on the sweep');
  ok(d1.includes("that a search of each changed or removed rule phrase, message or name by its old wording, and by its new wording too when other text must repeat it finds no hit the sweep leaves out that the change left wrong, and that the tree it stages"),
    'the developer is told acceptance also searches a changed rule by its old wording');
  ok(a3.includes("Also search each changed or removed rule phrase, message or name by its old wording, and by its new wording too when other text must repeat it, whatever its line names."),
    "the acceptance sweep check searches the old wording of a changed rule, which a rerun of the line's own search misses");
  ok(flat(a3).includes('Read against the change each hit marked `unaffected`, each hit the tool prints as `left out:` and each hit that search finds that the line leaves out.'),
    'the acceptance sweep check reads a left-out hit of the risk tool and of the old-wording search against the change');
  const engineText = readFileSync(join(REPO_ROOT, ENGINE), 'utf8');
  ok(engineText.includes('(a changed or removed one by its old wording, and by its new wording too when other text must repeat it)'),
    'the Develop meta states the same search wording as the developer prompt');
  ok(engineText.includes("own search of a changed or removed name or phrase by its old wording, and by its new wording too when other text must repeat it, finds no hit the change left wrong")
    && !engineText.includes('Sweep section lists each changed name or phrase, searches'),
    'the Acceptance meta credits the old-wording search to acceptance, never to the Sweep section');
  // A changed return schema is searched for the prose that lists the agent's return fields, which a search for the changed names misses.
  const SCHEMA_PROSE = `each sentence in the repo's prose that lists that agent's return fields, such as "returns", "only" and "nothing else"`;
  ok(d1.includes(`A change that adds, removes or renames a field of an agent's return schema also needs a search that finds ${SCHEMA_PROSE}.`),
    'CLASSIFY has the developer list each sentence that lists the return fields of an agent whose schema changed');
  ok(a3.includes(`A round whose hunks add, remove or rename a field of an agent's return schema needs a line that lists ${SCHEMA_PROSE}, and a sentence a rerun of that search finds and the line leaves out is judged as any left-out hit is.`)
    && !a1.includes('return schema'),
  'the sweep check of acceptance flags a missing line for the prose that lists the return fields of an agent whose schema changed');
  const REACH_SENTENCE = 'When a fact must be stated in more than one place, keep it in as few places as possible, at most one copy for users and one for agents, and update every copy in the same change.';
  ok(d1.includes(REACH_SENTENCE) && q1.includes(REACH_SENTENCE), 'the REACH step of the developer and the blind reviewer states a fact in as few places as possible');
  // A rule that two prompts state renders from one constant.
  const SPEC_CASES = "the plan prescribes the code, this block's text excludes it, or another block of the plan owns it";
  ok(d1.includes(`whose reason is that ${SPEC_CASES}. Its entire line is`) && a3.includes(`declines a finding because ${SPEC_CASES}.`),
    'the developer and acceptance render the SPEC cases from one constant');
  const TREE_EXEMPT = 'untracked build output or a cache that a gate or test run regenerates';
  ok(d1.includes(`differs from the snapshot your CLASSIFY phase returns only in ${TREE_EXEMPT}`) && a3.includes(`A listed path that is ${TREE_EXEMPT} is no gap.`),
    'the developer and acceptance render the tree-check exemption from one constant');
  const SWEEP_GAP = 'a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change';
  ok(a3.includes(`A gap for a wrong risk answer, for ${SWEEP_GAP}, or for a path that changed after its round's snapshot,`) && flat(r.prompt('develop block-a r2')).includes(`A gap for a wrong risk answer, for ${SWEEP_GAP}, or for a path that changed after its round's snapshot,`)
    && String(accSchema.properties?.risk_misclassified?.description ?? '').includes(SWEEP_GAP),
  'the risk-gap kinds read the same in acceptance, the developer and the schema');
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
  ok(dev.includes('CLASSIFY: judge the risk of each change this round made, in any phase, under the RISK QUESTIONS below, and record each judgment in E:/r/runs/t/risk-block-a-r2.md.')
    && dev.includes("Return review_needed=false only when the command's last line reads `low risk: yes`, and true otherwise.")
    && dev.includes('RISK QUESTIONS - answer each one for a change:'),
    'the developer writes the risk file acceptance reads, and returns review_needed from it');
  const devSchema = r.byLabel('develop block-a r1')[0]?.opts?.schema ?? {};
  ok(String(devSchema.required ?? '').includes('review_needed') && devSchema.properties?.review_needed?.type === 'boolean' && !('produced' in (devSchema.properties ?? {})),
    'review_needed is a required boolean return, and produced is gone');
  ok(dev.includes("A gap for a wrong risk answer, for a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, or for a path that changed after its round's snapshot, takes no fix and no log, since the blind review its verdict triggers judges the entire block diff."),
    'a round answering a review is told a risk gap or a tree-check gap holds no work');

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
  const FIRST_LINE = 'First take a snapshot of the working tree after your last change, with these commands, which write a temporary index file (create E:/r/runs/t/scratch/ if needed) and never the real index. The last command prints the tree id, which you also return as risk_snapshot:';
  const pinned = (prompt, id, round, where) => {
    const text = flat(prompt);
    ok(text.includes(`${FIRST_LINE} ${snapshotLines(id, round)} Delete the temporary index file once the last command has printed the tree id. Then run \`node '${RISK_TOOL}' 'E:/r/runs/t/risk-${id}-r${round}.md' --repo 'E:/repo' --snapshot <that tree id>\`.`),
      `${where}: CLASSIFY takes the snapshot with the three commands and their own temporary index, then hands its tree id to the risk tool`);
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

section('a block whose last round fails gets one closing pass, whose acceptance lands it unless a gap blocks');
// No develop round follows the closing pass. A blind review follows it only when its changes owe one, and the
// closing acceptance lands the block when no gap it finds is blocking, writing each gap it leaves to the backlog.
{
  const CLOSING_OK = { ...DEV_OK, review_needed: false, recorded_entries: [] };
  const ONE_ROUND = { ...ONE_BLOCK, maxRounds: 1 };
  const develop = (closingReturn) => (label) => (label.startsWith('develop-closing') ? closingReturn : DEV_OK);
  const parkText = (r) => flat(r.prompt('park:block-a'));
  // A closing acceptance that lands the block and leaves two not blocking gaps in its backlog file.
  const LANDS = { ...ACC_PASS, backlog_entries: 2, backlog_blocks: ['block-a'] };

  const lands = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, LANDS), park: PARK_OK }, ONE_ROUND);
  eq(lands.labels.join(), 'develop block-a r1,quality block-a r1,acceptance block-a r1,develop-closing block-a,acceptance block-a r2',
    'no review owed: the closing pass goes straight to the closing acceptance');
  eq(lands.out.status, 'done (all blocks staged)', 'whose pass lands the block beside its not blocking gaps');
  eq(syncOf(lands.out), 'block-a=done', 'the landed block syncs done');
  eq(String(lands.out.ledger[0]?.status), 'done (staged, and the closing acceptance left 2 backlog entries)', 'its ledger status names the count of entries the closing acceptance left');
  eq(lands.out.backlogEntries, 2, 'those entries count in backlogEntries');
  const noCount = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, { ...LANDS, backlog_entries: 'x' }) }, ONE_ROUND);
  eq(String(noCount.out.ledger[0]?.status), 'done (staged, and the closing acceptance gave no usable count of the backlog entries it left)',
    'a landing whose count is unusable says so in its ledger status');
  eq(noCount.out.backlogEntries, null, 'and leaves backlogEntries unknown');
  eq(String(lands.out.backlogFiles), backlogFile('block-a'), 'in the block\'s own backlog file');
  ok(lands.out.ledger[0].closingPass === true && lands.out.ledger[0].rounds === 1, 'the ledger marks the closing pass and keeps the round count');
  ok(lands.logs.some((l) => /round 1 ended without a passed acceptance → closing pass \(r2\), with no develop round after it/.test(l)), 'the log names the closing pass');
  const closer = flat(lands.prompt('develop-closing block-a'));
  ok(closer.includes('This is the closing pass, numbered round 2 in its file names, after round 1 of at most 1.')
    && closer.includes("so you are this block's CLOSING PASS, and no develop round follows you. A blind review follows you when the block's changes since its last blind review need one, and then acceptance runs once more. It lands the block when it finds no blocking gap, and otherwise the block parks."),
    'the closing pass is told what it is, what follows it, and what lands the block');
  ok(closer.includes('BUILD: CLOSING PASS. READ E:/r/runs/t/acceptance-review-block-a-r1.md.')
    && closer.includes('Where the matrix says FIX, answer the RISK QUESTIONS in CLASSIFY below for that fix before you write any code for it. When the fix is not low risk, change no code for it.')
    && closer.includes('with a **Fix:** line naming the fix you would make')
    && closer.includes('list its id in recorded_entries, and write no DISMISSED line for it'),
    'it makes each low-risk fix and records the rest as backlog entries naming the fix');
  ok(closer.includes("Set its \"- decision:\" line by RECORD's decision rule, from the entry's own kind, size and effect.") && !closer.includes('to NEEDS_USER, by RECORD'),
    'a recorded entry takes its decision from its own kind, size and effect, never from its Parked-with line');
  ok(closer.includes('or, in this closing pass, RECORDED as BUILD says'), 'the matrix counts a recorded finding as routed');
  ok(closer.includes('After that line, add the line "**Parked with:** block block-a. Hold this entry until that block is done or skip.", since the engine parks the block with the code the entry names when its closing acceptance finds a blocking gap.'),
    'each recorded entry names the park that would hold the code it describes');
  ok(closer.includes('When the dedup forbids the append, list the id of the entry that holds the item in recorded_entries instead.'),
    'an item an entry already holds is listed by that entry\'s id, not appended again');
  ok(closer.includes("A gap for a wrong risk answer, for a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, or for a path that changed after its round's snapshot, takes no fix and no log, since a blind review of this block's changes follows you."),
    'a wrong risk answer or a tree-check gap is left to the closing blind review');
  ok(closer.includes('record each judgment in E:/r/runs/t/risk-block-a-r2.md'), 'it writes its own risk file');
  const closingSchema = lands.byLabel('develop-closing block-a')[0]?.opts?.schema ?? {};
  ok(String(closingSchema.required ?? '').includes('recorded_entries')
    && !('recorded_entries' in (lands.byLabel('develop block-a r1')[0]?.opts?.schema?.properties ?? {})),
    'only the closing pass returns recorded_entries');
  ok(['baseline_dirty_files', 'baseline_index_tree', 'launch_number', 'earlier_files'].every((f) => !closingSchema.required.includes(f) && !(f in closingSchema.properties)),
    'the closing pass declares no round-1 field');
  const [earlyAcc, closingAcc] = [flat(lands.prompt('acceptance block-a r1')), flat(lands.prompt('acceptance block-a r2'))];
  ok(closingAcc.includes('E:/r/runs/t/risk-block-a-r2.md'), 'the closing acceptance audits the closing pass\'s risk file');
  ok(closingAcc.includes('makes it a blocking gap, since no round follows to send to a blind review') && !closingAcc.includes('which sends the next round to a blind review'),
    'and a gap of that audit blocks the landing, since no round follows to send to a blind review');
  ok(closingAcc.includes(`Your file holds no notes or observations. ${CLOSING_BAR.feature}`) && !closingAcc.includes('non-blocking section'),
    'the closing acceptance sorts each gap into the blocking and the not blocking kind');
  ok(!earlyAcc.includes('CLOSING BAR') && earlyAcc.includes('Your file holds no notes, observations or non-blocking section.'),
    'an earlier round keeps the bar where every gap fails acceptance');
  ok(closingAcc.includes(`• No blocking gap → APPEND each not blocking gap as ONE backlog entry to ${backlogFile('block-a')} only. Count it in backlog_entries and name "block-a" in backlog_blocks.`)
    && closingAcc.includes(DEDUP('gap')) && closingAcc.includes(DECISION_RULE)
    && closingAcc.includes('its **What:** placeholder with <the gap, the input or path that reaches it, and its harm>')
    && closingAcc.includes('A nit or a cleanup takes "- category: cleanup" and no "- severity:" line.')
    && closingAcc.includes('Then `git -C E:/repo add <this block\'s changed AND newly-created files>` (NEVER commit); return pass=true, staged=true, gap_count=0.'),
    'with no blocking gap it appends each not blocking gap as one backlog entry with its decision, then stages the block');
  ok(!earlyAcc.includes('APPEND each not blocking gap'), 'an earlier round appends no gap to the backlog');
  ok(closingAcc.includes('Append each not blocking gap to the backlog as the first bullet says.'), 'a closing no-op pass appends its gaps too');
  const accSchema = (r, label) => r.byLabel(label)[0]?.opts?.schema ?? {};
  ok(String(accSchema(lands, 'acceptance block-a r2').required ?? '').includes('backlog_entries')
    && !('backlog_entries' in (accSchema(lands, 'acceptance block-a r1').properties ?? {})),
    'only the closing acceptance of a feature block reports backlog entries');
  ok(String(accSchema(lands, 'acceptance block-a r2').properties?.gap_count?.description ?? '').startsWith('number of blocking gaps'),
    'and its gap_count counts the blocking gaps alone');
  ok(closingAcc.includes("This closing pass's blind code review ran when the block's changes owed one, and step 2 lists its file when it found issues.")
    && earlyAcc.includes("This round's blind code review passed, or did not run"),
    'the closing acceptance is told that its blind review may have found issues');

  // A blocking gap parks the block, and its park entry lists the blocking gaps first.
  const blocked = await run({ develop: develop({ ...CLOSING_OK, recorded_entries: ['t-block-a-x-1'] }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(blocked.labels.includes('acceptance block-a r2') && blocked.labels.includes('park:block-a'), 'a recorded entry reaches the closing acceptance, and a blocking gap parks the block');
  eq(blocked.out.ledger[0].status, 'backlogged (not accepted within round budget)', 'as a budget park');
  ok(parkText(blocked).includes('its **What:** placeholder with <the line "Parked: the closing acceptance found a blocking gap.", then each gap under the "## Blocking gaps" heading of E:/r/runs/t/acceptance-review-block-a-r2.md, then every other finding and gap in it, each copied verbatim, then the line "The closing pass listed these backlog entries, each with a **Fix:** line that names a fix that needs a blind review: t-block-a-x-1.">'),
    'its park entry lists the blocking gaps first, then the rest, then the entries the closing pass listed');
  ok(blocked.logs.some((l) => /the closing acceptance found 2 gap\(s\) that block its landing/.test(l)), 'the log says the gaps block the landing');
  const recorded = await run({ develop: develop({ ...CLOSING_OK, recorded_entries: ['t-block-a-x-1'] }), quality: CLEAN, acceptance: firstRound(ACC_FAIL, LANDS) }, ONE_ROUND);
  eq(recorded.out.status, 'done (all blocks staged)', 'a closing pass that recorded an entry still lands when no gap blocks');
  ok(recorded.logs.some((l) => /the closing pass listed t-block-a-x-1, each a fix that needs a blind review/.test(l)), 'and the log names the entry');
  const unlisted = await run({ develop: develop({ ...CLOSING_OK, recorded_entries: null }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(unlisted.labels.includes('acceptance block-a r2') && parkText(unlisted).includes(`so check ${backlogFile('block-a')} for an entry whose fix needs a blind review`),
    'an unusable list reaches acceptance, and a park points its entry at the block\'s backlog file');
  ok(unlisted.logs.some((l) => /the closing pass returned no usable list of the backlog entries it listed \(recorded_entries=null\)/.test(l)), 'the log says the list was unusable');
  // No round is left to re-run a red gate, so the closing acceptance judges it.
  const redClose = await run({ develop: develop({ ...CLOSING_OK, build_passed: false }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  eq(redClose.labels.join(), 'develop block-a r1,quality block-a r1,acceptance block-a r1,develop-closing block-a,acceptance block-a r2,park:block-a',
    'a closing pass with a red gate still reaches the closing acceptance, then parks, with no extra round');

  // A blind review owed after the closing pass runs once on its tree, and the closing acceptance reads its file.
  const FLAGGED_AT_CLOSE = (label) => (/r2$/.test(label) ? FLAGGED : CLEAN);
  for (const [what, respond] of [
    ['a change it judged not low risk', { develop: develop({ ...CLOSING_OK, review_needed: true }), quality: FLAGGED_AT_CLOSE, acceptance: firstRound(ACC_FAIL, LANDS) }],
    ['a last verdict that found a risk judgment wrong', { develop: develop(CLOSING_OK), quality: FLAGGED_AT_CLOSE, acceptance: firstRound({ ...ACC_FAIL, risk_misclassified: true }, LANDS) }],
    ['a block that never had a blind review', { develop: (label) => (label.startsWith('develop-closing') ? CLOSING_OK : { ...DEV_OK, build_passed: false }), quality: FLAGGED_AT_CLOSE, acceptance: LANDS }],
  ]) {
    const r = await run(respond, ONE_ROUND);
    ok(r.labels.join().endsWith('develop-closing block-a,quality block-a r2,acceptance block-a r2'),
      `${what}: the closing pass gets one blind review, then the closing acceptance, with no develop round between`);
    ok(flat(r.prompt('acceptance block-a r2')).includes('E:/r/runs/t/gate/quality-review-block-a-r2.md'),
      `${what}: the closing acceptance reads the closing blind review's file`);
    eq(r.out.status, 'done (all blocks staged)', `${what}: and lands the block when no gap blocks`);
    ok(r.logs.some((l) => /the closing blind review found 2 issue\(s\) → the closing acceptance sorts them/.test(l)), `${what}: the log says the acceptance sorts its findings`);
  }
  // Before the closing pass a contest goes back to a developer, so the closing acceptance is the only stage left to sort one.
  const contested = await run({ develop: develop({ ...CLOSING_OK, review_needed: true }), quality: (label) => (/r2$/.test(label) ? { ...FLAGGED, contested_dismissals: 1 } : CLEAN), acceptance: firstRound(ACC_FAIL, LANDS) }, ONE_ROUND);
  ok(contested.labels.join().endsWith('develop-closing block-a,quality block-a r2,acceptance block-a r2')
    && flat(contested.prompt('acceptance block-a r2')).includes(`A finding this pass's blind review raised as "CONTESTS DISMISSAL" is neither closed nor declined, so it is a gap`),
    'a closing blind review that contests a dismissal reaches the closing acceptance, which sorts the contest as a gap');
  ok(contested.logs.some((l) => /quality CONTESTED 1 dismissal\(s\) — the closing acceptance sorts each contest/.test(l)), 'the log says the closing acceptance sorts the contest');
  const cleanClose = await run({ develop: develop({ ...CLOSING_OK, review_needed: true }), quality: CLEAN, acceptance: firstRound(ACC_FAIL, LANDS) }, ONE_ROUND);
  ok(cleanClose.labels.includes('quality block-a r2') && !flat(cleanClose.prompt('acceptance block-a r2')).includes('quality-review-block-a-r2.md') && cleanClose.out.status === 'done (all blocks staged)',
    'a clean closing blind review lists no file, and the block lands');
  const redOrdered = await run({ develop: (label) => (label.startsWith('develop-closing') ? CLOSING_OK : { ...DEV_OK, build_passed: false }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK },
    { ...ONE_ROUND, ordered: true });
  eq(String(redOrdered.out.haltReason).split(' Its work is')[0], 'Block block-a did not land within 1 rounds and its closing pass, since its closing acceptance found a blocking gap (see E:/r/runs/t/acceptance-review-block-a-r2.md).',
    'an ordered halt names the closing acceptance file that holds the blocking gaps');
  const passes = await run({ ...GREEN_RUN, develop: develop(CLOSING_OK) }, ONE_ROUND);
  ok(!passes.labels.includes('develop-closing block-a') && passes.out.ledger[0].closingPass === false, 'a block that passes in its last round runs no closing pass');
  eq(passes.out.ledger[0].status, 'done (staged)', 'and its ledger status names no closing entries');

  const fixFixed = fixDev([{ issue_id: 'i-1', status: 'FIXED' }]);
  const fixClose = await run({
    develop: (label) => (label.startsWith('develop-closing') ? { ...fixFixed, review_needed: false, recorded_entries: [] } : fixFixed),
    quality: CLEAN, acceptance: firstRound(FIX_GAP, FIX_PASS),
  }, { ...FIX_ONE, maxRounds: 1 });
  eq(fixClose.out.status, 'done (all blocks staged)', 'a fix block reaches the closing acceptance the same way');
  ok(flat(fixClose.prompt('develop-closing fix-a')).includes('BUILD: CLOSING PASS.') && flat(fixClose.prompt('develop-closing fix-a')).includes('FIX ONLY the entries whose `- decision:` line says ACTIONABLE'),
    'and its closing pass keeps the entry rules');
  const fixClosingAcc = flat(fixClose.prompt('acceptance fix-a r2'));
  ok(fixClosingAcc.includes(FAIL_PARKS) && !fixClosingAcc.includes(FAIL_NEXT_ROUND),
    'a fix block\'s closing acceptance says a blocking gap parks the block');
  ok(fixClosingAcc.includes(`Your file holds no notes or observations. ${CLOSING_BAR.fix}`) && fixClosingAcc.includes('• No blocking gap → APPEND each not blocking gap as ONE backlog entry'),
    'and sorts each gap by the fix kinds, landing the block with no blocking gap');
  ok(flat(fixClose.prompt('acceptance fix-a r1')).includes(FAIL_NEXT_ROUND) && !flat(fixClose.prompt('acceptance fix-a r1')).includes(FAIL_PARKS),
    'and a fix block\'s earlier round keeps the gaps driving the next develop round');
  for (const [name, plan] of [['feature', BLOCKS[0]], ['section', BLOCKS[1]]]) {
    const closeRun = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) },
      { ...ONE_ROUND, plans: [plan] });
    const [early, closing] = [flat(closeRun.prompt(`acceptance ${plan.id} r1`)), flat(closeRun.prompt(`acceptance ${plan.id} r2`))];
    ok(closing.includes(FAIL_PARKS) && !closing.includes(FAIL_NEXT_ROUND) && closing.includes(CLOSING_BAR.feature), `the ${name} closing acceptance sorts each gap, and says a blocking gap parks the block`);
    ok(early.includes(FAIL_NEXT_ROUND) && !early.includes(FAIL_PARKS), `the ${name} acceptance of an earlier round keeps the gaps driving the next develop round`);
  }

  const dead = await run({ develop: develop(null), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  eq(dead.out.status, 'BLOCKED (an agent returned nothing - it was skipped or died; its work is parked)', 'a dead closing pass halts and parks');
  ok(/Developer for block block-a returned nothing in the closing pass \(round 2 in its file names\)/.test(dead.out.haltReason),
    'and its halt reason names the closing pass, not a round past the budget');
  const deadCloseAcc = await run({ develop: develop(CLOSING_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, null), park: PARK_OK }, ONE_ROUND);
  ok(/Acceptance verifier for block block-a returned nothing in the closing pass \(round 2 in its file names\)/.test(deadCloseAcc.out.haltReason),
    'a dead closing acceptance names the closing pass too');
  eq(deadCloseAcc.out.backlogEntries, null, 'and leaves backlogEntries unknown, since a closing acceptance may append before it dies');
  // Every other halt that names its round must name the closing pass, whose file-name number exceeds the round budget.
  const CLOSING_NAME = 'the closing pass (round 2 in its file names)';
  const OWES_REVIEW = { ...CLOSING_OK, review_needed: true };
  // Only an ordered run halts on an escalation, so that row takes the ordered args.
  for (const [kind, closingReturn, closingAcceptance, extraArgs = {}, closingQuality = CLEAN] of [
    ['a closing developer that could not obtain its plan', { ...CLOSING_OK, plan_obtained: false }, ACC_FAIL],
    ['a closing developer that did not confirm staying unstaged', { ...CLOSING_OK, unstaged_confirmed: false }, ACC_FAIL],
    ['a closing developer that escalated a user-only decision', { ...CLOSING_OK, needs_user: true }, ACC_FAIL, { ordered: true }],
    ['a closing blind review that returned nothing', OWES_REVIEW, ACC_FAIL, {}, null],
    ['a closing blind review that flagged issues without confirming its review file', OWES_REVIEW, ACC_FAIL, {}, { ...FLAGGED, wrote_file: false }],
    ['a closing acceptance that could not obtain its plan', CLOSING_OK, { ...ACC_FAIL, plan_obtained: false }],
    ['a closing acceptance that passed with a regression', CLOSING_OK, { ...ACC_PASS, staged: false, regression: true }],
    ['a closing acceptance that failed the block but staged it', CLOSING_OK, { ...ACC_FAIL, staged: true }],
    ['a closing acceptance that failed the block without confirming its review file', CLOSING_OK, { ...ACC_FAIL, wrote_file: false }],
  ]) {
    const r = await run({ develop: develop(closingReturn), quality: firstRound(CLEAN, closingQuality), acceptance: firstRound(ACC_FAIL, closingAcceptance), park: PARK_OK }, { ...ONE_ROUND, ...extraArgs });
    ok(r.out.halted === true && r.out.haltReason.includes(CLOSING_NAME) && !/\bround 2\b(?! in its file names)/.test(r.out.haltReason),
      `${kind}: the halt reason names the closing pass: ${r.out.haltReason.slice(0, 120)}`);
  }
}

section('fix acceptance records a harm with a separate cause in its block\'s backlog file, never a gap');
// A fix loop converges because its inventory is closed at triage, so the verifier routes such a harm to
// its block's backlog file instead of failing a fix whose own root cause is closed.
{
  const DEV_FIXED = fixDev([{ issue_id: 'i-1', status: 'FIXED' }]);
  const ran = (r) => r.labels.some((l) => l.startsWith('acceptance'));
  const FILE_A = backlogFile('fix-a');
  const FILE_B = backlogFile('fix-b');
  const TO_CHECK = (...files) => `so check these files in the project's backlog folder ${BACKLOG}/ for entries this run added: ${files.join(', ')}.`;
  const found = await run({ develop: DEV_FIXED, quality: CLEAN, acceptance: { ...FIX_PASS, backlog_entries: 2, backlog_blocks: ['fix-a'] } }, FIX_ONE);
  const acc = flat(found.prompt('acceptance'));
  ok(acc.includes(`${FILE_A} only.`) && !acc.includes('so that the user triages it before anything fixes it')
    && acc.includes(ENTRY_RULE(FILE_A, 'fix-a', 'harm')) && !acc.includes('one past the highest n'),
    'the verifier is told its block\'s backlog file and to append it with the entry tool');
  ok(acc.includes(`${ENTRY_CHECK(FILE_A)} Its **What:** names the source issue id.`),
    'the entry names the issue it came from');
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
  ok(found.out.nextStep.includes('Report each added entry\'s severity, or its category for an entry with no severity line, its title and its decision to the user.'),
    'and has the operator report each added entry and its decision to the user');
  ok(found.out.nextStep.includes('Work the backlog as the develop guide\'s "Working the backlog" says once each file\'s block is done, skip or backlogged'),
    'and sends the triage to the guide once the block is done, skipped or backlogged');
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
  ok(!passAcc.includes('/t-fix-a-plus-1'), 'and names no file for the pass\'s own id');
  ok(passAcc.includes(`${ENTRY_NEW('<that file>', '<that block id>')} ${ENTRY_FLAGS}`), 'and appends an entry to the file and block it lands in');
  eq(JSON.stringify(pass.out.backlogFiles), JSON.stringify([FILE_A, FILE_B]), 'the return\'s files are sorted and de-duplicated');
  const passClosing = await run({
    develop: (label) => ({ ...passDev([{ issue_id: 'i-1', status: 'FIXED' }]), ...(label.startsWith('develop-closing') ? { review_needed: false, recorded_entries: [] } : {}) }),
    quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK,
  }, { ...PASS_ARGS, maxRounds: 1 });
  ok(flat(passClosing.prompt('acceptance fix-a-plus-1 r2')).includes(`No blocking gap → APPEND each not blocking gap as ONE backlog entry only to the file of the block whose entry the gap concerns (the first block below when it concerns no single entry): - i-1, i-2 → ${FILE_A}`),
    'a pass\'s closing acceptance routes a gap that concerns no single entry to the first member\'s file');

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
  const DISMISSED_TOO = 'Write the defect\'s DISMISSED line too, since the blind reviewer reads that file and never this one.';
  const NO_ENTRY = { focused: 'A false positive and a nit dropped under rule 2 or SIBLINGS get no entry.', proactive: 'A false positive gets no entry, and a nit dropped under rule 2 or SIBLINGS goes under CLEANUP below.' };
  // Its own bullet after RECORD's closing-line rule, since its trigger is a cleanup and not a dropped defect.
  const CLEANUP = `Leave its status and decision as they are, since a park clears the change from the tree. • CLEANUP (this run's change policy): append ONE entry for each cleanup outside task code, ${OWNED_CODE}, that you noticed and did not make, such as a nit. Route, count, dedup and number it as a RECORD entry. It takes RECORD's shape with "- category: cleanup" and no "- severity:" line, since severity takes only critical, high, medium or low. Its **What:** names the cleanup, the code it touches and what it improves.`;
  // Both policies, after the CLEANUP bullet when there is one.
  const FEATURE = `• FEATURE (both change policies): append ONE entry for each feature or refactor you noticed that lies outside this block's scope, ${OWNED_CODE}, instead of building it. Route, count, dedup and number it as a RECORD entry. It takes RECORD's shape with "- category: feature", "- decision: NEEDS_USER" and no "- severity:" line. Its **What:** names the feature or refactor, the code it touches and what it adds or improves. • AMEND (6a)`;
  const ESCALATION_ENTRY = (id) => `Also append ONE backlog entry for it when the choice lies ${OWNED_CODE}, routed, counted, deduped and numbered as a RECORD entry. It takes RECORD's shape with "- category: decision", "- decision: NEEDS_USER" and no "- severity:" line. Its **What:** states the question and the default you took, and its **Fix:** states the other option. When the default lies in code this block's diff adds or changes, add the line "**Parked with:** block ${id}. Hold this entry until that block is done or skip." after the **Fix:** line, since a park removes that code from the tree. Write to`;
  const CLASS_ENTRY = 'A DISMISSED line that covers a class of places gets one entry. Its "- file:" line names the first place, and its **What:** names the class.';
  const CLOSE = (tag, id) => `When you append a ${tag} line below, ${GREP('the path of the file the fix changes', 'the fix')}. When an entry that a grep matches holds the defect that line's fix closes, add one line after that entry's **Fix:** line in that file: **Closed by:** block ${id} r1 of run ${baseArgs.runId}. Confirm before the entry is built that the accepted baseline holds the fix. Leave its status and decision as they are, since a park clears the fix from the tree.`;
  const RETIRE = (id) => `• RETIRED (a backlog entry the block retires): when the block's text names a backlog entry as retired or superseded, grep the *.md files in ${BACKLOG}/ for that entry's id and add one line after its **Fix:** line, with the block's change as the fix: **Closed by:** block ${id} r1 of run ${baseArgs.runId}. Confirm before the entry is built that the accepted baseline holds the fix. Leave its status and decision as they are, since a park clears the change from the tree.`;
  const FILE_A = backlogFile('fix-a');
  const FILE_B = backlogFile('fix-b');
  const recordRule = (dev, policy, id, where) => {
    ok(dev.includes(`${RECORD}${OWN_FILE(id)}`), `${where}: a declined defect the zone routing leaves unchanged goes to its block's own backlog file`);
    ok(dev.includes(DISMISSED_TOO) && dev.includes(NO_ENTRY[policy]), `${where}: a false positive gets no entry, and the DISMISSED line stays`);
    ok(policy === 'proactive'
      ? dev.includes(`${CLEANUP} ${FEATURE}`) && !dev.includes(NO_ENTRY.focused)
      : dev.includes(`since a park clears the change from the tree. ${FEATURE}`) && !dev.includes('CLEANUP') && !dev.includes('category: cleanup'),
    policy === 'proactive' ? `${where}: a cleanup outside task code gets an entry with no severity` : `${where}: a nit or other cleanup gets no entry`);
    ok(!dev.includes('A new file starts with') && !dev.includes('one past the highest n in that file'), `${where}: no prompt copy of the header or the id rule is left`);
    ok(dev.includes(DEDUP('defect')) && !dev.includes('read every *.md'), `${where}: the folder is grepped for the file path and the name at the defect, and each matching entry is read, so nothing open is appended twice`);
    ok(dev.includes(ENTRY_RULE(backlogFile(id), id, 'defect')), `${where}: each entry is appended with the entry tool to its block's file, then filled and checked`);
    ok(dev.includes(CLASS_ENTRY), `${where}: a class-level DISMISSED line gets one entry`);
    ok(dev.includes(DECISION_RULE) && !dev.includes('NEEDS_USER holds the entry'), `${where}: the entry's decision follows the one rule, and the old always-NEEDS_USER sentence is gone`);
    ok(dev.includes(FEATURE), `${where}: a feature or refactor outside the block's scope gets a NEEDS_USER entry with no severity`);
    ok(dev.includes(ESCALATION_ENTRY(id)), `${where}: an escalated choice the developer proceeds past gets a NEEDS_USER entry that states the question, the default and the other option`);
    ok(dev.includes(CLOSE(policy.toUpperCase(), id)), `${where}: a logged fix of a recorded defect finds its entry by the path and the name at the fix, and marks it closed in whichever file holds it`);
    ok(dev.includes(RETIRE(id)), `${where}: a backlog entry the block retires gets its own Closed by bullet, apart from the RECORD trigger`);
  };

  for (const policy of ['focused', 'proactive']) {
    const both = await run(GREEN_RUN, { ...baseArgs, changePolicy: policy });
    recordRule(flat(both.prompt('develop block-a')), policy, 'block-a', `${policy} feature`);
    recordRule(flat(both.prompt('develop block-b')), policy, 'block-b', `${policy} section`);
    const fixed = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS },
      { ...FIX_ONE, changePolicy: policy });
    recordRule(flat(fixed.prompt('develop')), policy, 'fix-a', `${policy} fix`);
    ok(flat(fixed.prompt('acceptance')).includes(ENTRY_RULE(backlogFile('fix-a'), 'fix-a', 'harm')), `${policy} fix: acceptance's fix frame appends with the same tool`);
    ok(!flat(fixed.prompt('acceptance')).includes('CLEANUP'), `${policy} fix: acceptance records no cleanup`);
    ok(flat(fixed.prompt('acceptance')).includes(DECISION_RULE), `${policy} fix: acceptance sets a new issue's decision by the same rule`);

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
  ok(passDevPrompt.includes(ENTRY_RULE('<that file>', '<that block id>', 'defect')),
    'and appends to that member\'s file under that member\'s block id');
  ok(passDevPrompt.includes(CLOSE('FOCUSED', 'fix-a-plus-1')), 'a pass developer\'s closing line names the pass, as its DECISIONS lines do');
  ok(flat(pass.prompt('acceptance')).includes(`${ENTRY_NEW('<that file>', '<that block id>')} ${ENTRY_FLAGS}`), 'a pass verifier appends the same way');
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
    ok(unknown.out.nextStep.includes(`A developer, fix verifier or closing acceptance returned no usable backlog report, so check these files in the project's backlog folder ${BACKLOG}/ for entries this run added: ${ONE_FILE}.`),
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
  ok(!!namedId && named.includes(ENTRY_NEW(`${BACKLOG}/${namedId}.md`, 'block-a', 'Judgment Review')),
    'a runId slugs into the file name, and the entry tool gets the runId as given for the header');
  const quoted = flat((await run(GREEN_RUN, { ...ONE_BLOCK, runId: "Bob's run" })).prompt('develop'));
  ok(quoted.includes("--run 'Bob'\\''s run'"), 'a quote in the runId is escaped for a POSIX shell');
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
// The developer, fix acceptance and closing acceptance have nowhere to record what a block leaves without the
// folder, and a folder inside the repo would put their writes in the diff the reviewers judge.
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
  ok(String(stop.out.haltReason ?? '').includes('says ACTIONABLE, its `- status:` is not fixed or stale and it carries no `- pulled:` line and no line that starts with `**Parked with:**`')
    && String(carry.out.nextStep ?? '').includes("read its entries' `- decision:`, `- pulled:` and `**Parked with:**` lines"),
  'the halt reason and nextStep name the pulled and parked-with lines that also keep an ACTIONABLE entry from being fixed');

  // A restored branch is unstaged work that no SKIPPED or empty report reflects, so it must reach a review and a park.
  for (const [what, results] of [['all SKIPPED', [{ issue_id: 'i-1', status: 'SKIPPED' }]], ['empty', []]]) {
    const restored = await run({ ...GREEN_RUN, develop: fixDev(results, { restored_branches: 1 }), acceptance: ACC_FAIL, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 });
    ok(restored.labels.includes('quality fix-a r1') && restored.labels.includes('park:fix-a'), `${what} beside a restore: the block is reviewed and parked`);
    ok(!/^no-changes/.test(restored.out.ledger[0].status), `${what} beside a restore: never the no-changes terminal`);
  }
  ok(String(empty.byLabel('develop fix-a r1')[0]?.opts?.schema?.required ?? '').includes('restored_branches'),
    'a fix developer returns restored_branches');
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
  eq(out.ledger[0].status, 'backlogged (not accepted within round budget)', 'reported backlogged, never no-changes');
  eq(out.parked[0]?.branch, `aipg-unfinished/${backlogFileId('fix-a')}`, 'and the branch reaches the operator');
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
  eq(out.ledger[0].status, 'backlogged (not accepted within round budget)', 'it never took the no-changes shortcut');
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

  const zero = await run({ ...GREEN_RUN, develop: { ...RED_DEV, tests_run_count: 0 }, acceptance: ACC_FAIL, park: PARK_OK }, RED);
  eq(zero.labels.filter((l) => l.startsWith('quality')).join(), 'quality block-a r6', 'no round with a phantom red baseline reaches a reviewer, only the closing pass');
  eq(zero.out.plansDone.length, 0, 'nothing is staged on a test that never ran');
  ok(zero.labels.includes('park:block-a'), 'the block parks at the round budget instead');

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

  const reddened = await run({ ...GREEN_RUN, develop: { ...DEV_OK, full_suite_outcome: 'failed' }, acceptance: ACC_FAIL, park: PARK_OK }, GREEN_GATE);
  eq(reddened.labels.filter((l) => l.startsWith('quality')).join(), 'quality block-a r6', 'no round with a reddened suite reaches a reviewer, only the closing pass');
  eq(reddened.out.plansDone.length, 0, 'and nothing is staged');
  ok(reddened.out.ledger[0].status.startsWith('backlogged'), 'the block parks instead');

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

section('agentTypes takes the develop, quality, acceptance and sweep keys, throws on park, and park takes agentTypes.develop');
{
  for (const agentTypes of [['my-dev'], null, 'my-dev', { park: 'my-parker' }, { planner: 'my-planner' }, { develop: '  ' }, { develop: 7 }]) {
    const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, agentTypes }, respond: {} });
    ok(msg.startsWith('Invalid agentTypes arg') && msg.includes('develop | quality | acceptance | sweep'), `agentTypes ${JSON.stringify(agentTypes)} throws listing the four keys: ${msg.slice(0, 100)}`);
  }
  const typeOf = (calls, prefix) => calls.filter((c) => c.label.startsWith(prefix)).map((c) => c.opts.agentType ?? '-').join(',');
  const agentTypes = { develop: 'my-dev', quality: 'my-critic' };
  const green = await run(GREEN_RUN, { ...ONE_BLOCK, agentTypes });
  eq(['develop', 'quality', 'acceptance'].map((p) => typeOf(green.calls, p)).join('|'), 'my-dev|my-critic|-', 'each agentTypes entry reaches only its own role');
  const parked = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, { ...ONE_BLOCK, ordered: true, agentTypes });
  eq(typeOf(parked.calls, 'park'), 'my-dev', 'the park agent takes agentTypes.develop');
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
section('a self-contradictory park report halts and still surfaces the branch');
// saved=false beside a commit id: the report is wrong, and the commit may be real. The tree may already be
// cleared, so telling the operator nothing was saved when a commit exists is actively wrong.
{
  const { out } = await run({
    ...GREEN_RUN, acceptance: ACC_FAIL,
    park: { ...PARK_OK, saved: false },
  }, ONE_BLOCK);
  eq(out.status, 'BLOCKED (a parked block left the tree unsafe)', 'status');
  ok(/contradicts itself/.test(out.haltReason) && out.haltReason.includes(`git -C E:/repo log -1 --stat ${UNFINISHED('block-a')}`),
    'halt reason says so and names the command that shows the branch');
  eq(out.parked[0].branch, UNFINISHED('block-a'), 'the branch is surfaced, NOT reported as "nothing saved"');
  eq(syncOf(out), 'block-a=blocked', 'an unsafe park is blocked, never backlogged');
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
  ok(stuck.out.haltReason.includes(`its work IS saved on the branch ${UNFINISHED('block-a')}`), 'and that the work was still saved');
  ok(/Inspect the tree before resuming\./.test(stuck.out.haltReason), 'and says to inspect the tree before resuming');
  ok(!stuck.labels.some((l) => l.includes('block-b')), 'block-b never started on an unsafe tree');
  eq(stuck.out.ledger[0].status, 'blocked (not accepted within round budget, and its park needs the operator)', 'the ledger never calls an unsafe park backlogged');

  const red = await run({
    ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false },
  });
  eq(red.out.status, 'BLOCKED (a parked block left the tree unsafe)', 'red-build status');
  ok(/build gate is not green after parking/.test(red.out.haltReason), 'the reason names the red build');
  ok(/Inspect the tree before resuming\./.test(red.out.haltReason), 'and says to inspect the tree before resuming');
  ok(!/tree is CLEAN/.test(red.out.haltReason),
    'and does NOT also tell the operator the tree is fine to resume from');
  eq(red.out.parked[0]?.branch, UNFINISHED('block-a'), 'the branch is still surfaced');
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
  eq(syncOf(carry.out), 'block-a=backlogged,block-b=done', 'the parked block syncs backlogged');
  eq(JSON.stringify(carry.out.parked[0]), JSON.stringify({ id: 'block-a', mode: 'feature', branch: UNFINISHED('block-a'), backlogFile: backlogFile('block-a'), entryWritten: true, status: 'backlogged (not accepted within round budget)' }),
    'the parked row names the branch and the backlog file that holds the park entry');
  eq(carry.out.status, 'run complete (1 block(s) parked)', 'status counts the parked block');
  ok(carry.out.nextStep.includes(`PARKED: block-a. Work SAVED and cleared from the tree — nothing discarded — for: block-a (on the branch ${UNFINISHED('block-a')}).`),
    'nextStep names the parked block and its branch');
  ok(carry.out.nextStep.includes('Each backlogged block\'s entry in its backlog file says why it parked and links its branch when it has one: triage and build it like any other entry, as the develop guide\'s "Working the backlog" says.'),
    'nextStep sends the parked block to the backlog triage');
  ok(!carry.out.nextStep.includes('stay blocked until you resolve their halt'), 'a backlogged park takes no held-park rule');
  ok(!/\.patch|git apply|continueParked|runOnly\)|restore the patch|re-run it alone/.test(carry.out.nextStep),
    'nextStep names no patch, restore command, continueParked or four-outcome menu');
  ok(!carry.out.nextStep.includes('NEEDS-USER'), 'and never names NEEDS-USER.md for a park');
  eq(carry.out.backlogEntries, 1, 'the park entry counts in backlogEntries');
  eq(carry.out.backlogFiles.join(), backlogFile('block-a'), 'and its file in backlogFiles');

  const stop = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...baseArgs, ordered: true });
  ok(stop.labels.includes('park:block-a'), 'the SAME park still runs, so nothing is discarded');
  ok(!stop.labels.some((l) => l.includes('block-b')), 'but block-b never starts');
  eq(stop.out.status, 'halted (a block was parked — its work is saved on a branch that a backlog entry links; the blocks after it were not attempted)', 'ordered status');
  ok(stop.out.haltReason.includes(`Its work is SAVED on the branch ${UNFINISHED('block-a')}. The park appended one entry to ${backlogFile('block-a')} that says why the block parked and links that branch, and the tree is CLEAN; work that entry with the user as the develop guide's "Working the backlog" says.`),
    'halt reason states the branch, the entry and the clean tree');
  ok(stop.out.nextStep.includes(', before you relaunch the blocks after it, since they depend on it.'),
    'an ordered park says its entry comes before the blocks after it');
  ok(!/\.patch|NEEDS-USER/.test(stop.out.haltReason + stop.out.nextStep), 'and names no patch and no NEEDS-USER.md');
}

section('a park builds its commit with plumbing through a temporary index, and clears only once the tree check passes');
// The repo's index holds the accepted baseline, so only a copy may take the block's work, and commit-tree
// runs no commit hook on unfinished work.
{
  const INDEX = 'E:/r/runs/t/scratch/park-block-a.index';
  const MESSAGE = 'E:/r/runs/t/scratch/park-block-a.msg';
  const BRANCH = UNFINISHED('block-a');
  const staged = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  const steps = [
    `\`cp "$(git -C E:/repo rev-parse --path-format=absolute --git-path index)" "${INDEX}"\``,
    `\`GIT_INDEX_FILE="${INDEX}" git -C E:/repo write-tree\`, which prints the staged index's tree (an intent-to-add entry takes no part in it). Then \`git -C E:/repo commit-tree <that tree> -p HEAD -m "accepted baseline"\` prints BASE.`,
    `\`GIT_INDEX_FILE="${INDEX}" git -C E:/repo add -A\``,
    `Then \`GIT_INDEX_FILE="${INDEX}" git -C E:/repo write-tree\` prints WORK`,
    'd. TREE CHECK. When WORK is the tree that `git -C E:/repo rev-parse <BASE>^{tree}` prints, the tree holds no work of this block. Make no commit, leave the branch as it is, return saved=false and commit_sha "", and continue at step 2.',
    `Write \`unfinished: \` followed by the block's title, which is the JSON string "block-a", decoded, as the one line of ${MESSAGE}, with no quotes and no other line.`,
    `When \`git -C E:/repo rev-parse --verify --quiet refs/heads/${BRANCH}\` prints a commit id, that earlier tip is the second parent, so earlier unfinished work stays in the branch's history: run \`git -C E:/repo commit-tree <WORK> -p <BASE> -p <tip> -F ${MESSAGE}\`.`,
    `\`git -C E:/repo update-ref refs/heads/${BRANCH} <NEW>\``,
    '2. CLEAR, only when step 1 made a commit.',
  ];
  const at = steps.map((s) => staged.indexOf(s));
  ok(at.every((i, n) => i > -1 && (n === 0 || i > at[n - 1])), `the plumbing steps and the tree check run in order before the clear: ${at.join(',')}`);
  ok(staged.includes('When step 1 made no commit, clear nothing.'), 'a tree with no work is never cleared');
  ok(staged.includes('Delete each other untracked file the new commit holds'), 'the clear removes each untracked file the commit holds');
  // A moved untracked file shows as a rename, which --diff-filter=A omits, so the clear would leave it.
  ok(staged.includes('`git -C E:/repo diff --name-only --no-renames --diff-filter=A <BASE> <NEW>`'), 'the added-file list turns rename detection off');
  ok(staged.includes('`git -C E:/repo rm -f -q -- <file>`') && staged.includes('an unpathed `git reset`, `git rm` or `git clean` touches the index'),
    'the clear names every file and never runs an unpathed reset, rm or clean');
  // The title is user text, so a shell-quoted -m would break on a quote, a dollar sign or a backtick in it.
  ok(!staged.includes('-m "unfinished'), 'the commit message never goes through a shell-quoted -m');
  ok(staged.includes(`Delete the copy and ${MESSAGE} once step 1 ends, whichever way it ends.`), 'the index copy and the message file are both deleted');
  ok(staged.includes('No command in step 1 writes the repo\'s own index. Step 2 removes from it only the intent-to-add entries of files this block created.'),
    'the staging contract allows the clear\'s intent-to-add removals');
  ok(!staged.includes('No command you run writes the repo\'s own index.'), 'and never forbids every index write');
  ok(!/\.patch|parked-block-a|NEEDS-USER/.test(staged), 'the park prompt names no patch, no review copy and no NEEDS-USER.md');
  const committed = flat((await run({ ...GREEN_RUN, develop: { ...DEV_OK, baseline_staged_files: 0 }, acceptance: { ...ACC_FAIL, committed: false, commit_sha: '', commit_subject: '', tree_matches: false, tree_clean: true }, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1, commit: true })).prompt('park:block-a'));
  ok(committed.includes('BASE, the new commit\'s first parent, is a commit of the accepted baseline. It is HEAD: `git -C E:/repo rev-parse HEAD` prints it.')
    && !committed.includes('-m "accepted baseline"'), 'in commit mode the first parent is HEAD');
  const schema = (await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_BLOCK)).byLabel('park:block-a')[0]?.opts?.schema ?? {};
  eq(JSON.stringify(schema.required), JSON.stringify(['saved', 'cleared', 'gates_green', 'commit_sha', 'entry_written']), 'the park returns its commit and its entry write');
}

section('every park appends one backlog entry that links its branch');
{
  const FILE = backlogFile('block-a');
  const budget = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  for (const line of [
    `3. RECORD. Append ONE entry to ${FILE} ${ENTRY_INTRO}:`,
    `${ENTRY_NEW(FILE, 'block-a')} --file-ref '<the first path \`git -C E:/repo diff --name-only ${UNFINISHED('block-a')}^1 ${UNFINISHED('block-a')}\` prints>' --category unfinished --size <trivial|small|medium|large: the work the gaps below leave> --decision <ACTIONABLE|NEEDS_USER> --branch '${UNFINISHED('block-a')}' --origin 'E:/plans/bus.md#block-a'`,
    'Its --decision value follows the decision sentence at the end of this step.',
    'With the Edit tool, replace the entry\'s placeholder title with "unfinished: <block title>",',
    'and its **Fix:** placeholder with this text: Close the gaps the **What:** lists on top of the work the branch holds, so each block the "- origin:" line names meets its criteria. Round 1 of the block built from this file restores that work.',
    ENTRY_CHECK(FILE),
    `When step 2 did not return cleared=true, or the build gate was not green after it, set "- decision: NEEDS_USER", since the engine then holds the park and the operator picks whether this entry or the block continues its work. Otherwise read the gaps the **What:** lists as the entry's defect. ${DECISION_RULE}`,
    // A copied `## Question:` or `### [id]` heading at column 0 would end the entry or start a phantom one.
    'Write each verbatim copy on lines of its own below the **What:** line, every copied line indented by four spaces, so no copied heading, fence or "- <key>:" line ends this entry or starts another when the plan file is parsed.',
    'Then return entry_written=true.',
  ]) ok(budget.includes(line), `the park entry carries: ${line}`);
  // An earlier park of the same block may have left the branch, so the commit, not the branch, decides.
  ok(budget.includes('When step 1 made no commit, this park saved no work to restore, so pass no --branch, even when aipg-unfinished/')
    && budget.includes('holds an earlier park\'s work, pass --file-ref') && !budget.includes('does not exist after step 1'),
    'an entry links a branch only when this park made a commit');

  const asked = flat((await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, ONE_BLOCK)).prompt('park:block-a'));
  ok(asked.includes('its **What:** placeholder with <the latest `## Question: block-a r<n>` entry in E:/r/runs/t/question-block-a.md, copied verbatim>'),
    'a needs-user park copies the escalated question');
  ok(asked.includes('Set "- decision: NEEDS_USER", since this park waits on a question only the user can answer.') && !asked.includes(DECISION_RULE),
    'and is always NEEDS_USER');
  // A staging halt keeps its own kind, but the developer's question still waits on the user.
  const stagedAsk = flat((await run({ develop: { ...DEV_OK, needs_user: true, unstaged_confirmed: false }, park: PARK_OK }, ONE_BLOCK)).prompt('park:block-a'));
  ok(stagedAsk.includes('its **What:** placeholder with <the line "Halted: ') && stagedAsk.includes(', then the latest `## Question: block-a r<n>` entry in E:/r/runs/t/question-block-a.md, copied verbatim>'),
    'a staging halt of a block that escalated copies the halt reason, then the question');
  ok(stagedAsk.includes('Set "- decision: NEEDS_USER", since this park waits on a question only the user can answer.') && !stagedAsk.includes(DECISION_RULE),
    'and is always NEEDS_USER');
  const stagedOnly = flat((await run({ develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK }, ONE_BLOCK)).prompt('park:block-a'));
  // A held park's entry waits on the operator's route, so no backlog run builds it first.
  ok(stagedOnly.includes('Set "- decision: NEEDS_USER", since the operator picks whether this entry or the block continues its work.')
    && !stagedOnly.includes(DECISION_RULE) && !stagedOnly.includes('## Question:'), 'a staging halt with no question is NEEDS_USER and copies no question');

  const dead = flat((await run({ develop: null, park: PARK_OK }, ONE_BLOCK)).prompt('park:block-a'));
  ok(dead.includes('its **What:** placeholder with <the line "Halted: an agent returned nothing (skipped or died).", then this halt reason, copied verbatim: Developer for block block-a returned nothing in round 1'),
    'a halt park copies the halt reason');

  const PASS_PLANS = [{ planPath: 'E:/plans/a.md', id: 'fix-a', issues: ['i-1', 'i-2'] }, { planPath: 'E:/plans/b.md', id: 'fix-b', issues: ['i-3'] }];
  const pass = flat((await run({ develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK },
    { ...baseArgs, maxRounds: 1, plans: [{ id: 'fix-a-plus-1', mode: 'fix', gate: 'green', blocks: PASS_PLANS }] })).prompt('park:fix-a-plus-1'));
  ok(pass.includes("--origin 'E:/plans/a.md#fix-a, E:/plans/b.md#fix-b'") && pass.includes(`--branch '${UNFINISHED('fix-a-plus-1')}'`),
    'a pass names each member\'s plan block, and its branch is the pass\'s own');

  const unwritten = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, entry_written: false } }, ONE_BLOCK);
  eq(syncOf(unwritten.out), 'block-a=blocked', 'a park with no confirmed entry stays blocked, never backlogged');
  eq(unwritten.out.ledger[0].status, 'blocked (not accepted within round budget, and its park needs the operator)', 'and its ledger status says so');
  ok(unwritten.out.nextStep.includes(`Park did NOT confirm writing its backlog entry for: block-a (${backlogFile('block-a')}, "- branch: ${UNFINISHED('block-a')}"), so each stays blocked.`),
    'and nextStep names the file and the branch to link by hand');
  ok(unwritten.out.nextStep.includes('When that file holds no "- category: unfinished" entry for this park, add one in the shape the develop guide\'s "Working the backlog" gives, with the "- branch:" line its block\'s note in this list gives.')
    && !unwritten.out.nextStep.includes('resolves that branch'), 'and links the branch its note gives');
  // The branch may hold an earlier park's work, so a park that made no commit links none.
  const unwrittenEmpty = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_EMPTY, entry_written: false } }, ONE_BLOCK);
  ok(unwrittenEmpty.out.nextStep.includes(`block-a (${backlogFile('block-a')}, no "- branch:" line, since this park made no commit)`),
    'a commitless unlinked park links no branch, even one an earlier park left');
  const unwrittenUnknown = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_EMPTY, cleared: false, entry_written: false } }, ONE_BLOCK);
  ok(unwrittenUnknown.out.nextStep.includes(`block-a (${backlogFile('block-a')}, "- branch: ${UNFINISHED('block-a')}" only when \`git -C E:/repo log -1 ${UNFINISHED('block-a')}\` shows a commit this park made)`),
    'a park that confirmed neither a save nor a clear links the branch only for a commit it made');
  ok(unwritten.out.nextStep.includes('Once that entry exists, set block-a backlogged, so the entry is the one place its work continues from.')
    && !unwritten.out.nextStep.includes('resolve their halt'), 'and names the missing entry, never a halt the run did not have, as what holds the block');
  eq(unwritten.out.backlogEntries, 0, 'an unwritten entry is not counted');
}

section('a park that saved no commit writes an entry built from the accepted baseline');
// The fix block built from it restores nothing, so its Fix must name the origin block, never work on a branch.
{
  const empty = flat((await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_EMPTY }, ONE_BLOCK)).prompt('park:block-a'));
  ok(empty.includes('pass --file-ref the path E:/plans/bus.md, and pass --size the size of building each block the "- origin:" line names from the accepted baseline, since no work was saved. Replace the **Fix:** placeholder with this text instead: Build each block the "- origin:" line names on the accepted baseline, closing the gaps the **What:** lists, so it meets its criteria.'),
    'an entry with no branch says to build its origin block on the accepted baseline');
}

section('a park after a halt that may leave work staged or the tree unsafe stays blocked, with one rule for its two routes');
// The branch's first parent holds committed work, and in stage mode staged work, so its diff omits that part, and the entry may not be the block's whole work.
{
  const HELD = 'These parked blocks stay blocked until you resolve their halt: block-a. Once a block\'s halt is resolved, set its status to backlogged when its branch holds all of its work and its backlog file holds an entry that links that branch, so that entry is the one place its work continues from, and never set it back to todo. For a fix block, that route also sets to stale each entry whose branch its round 1 restored and whose work the new branch\'s tree holds, deletes that branch with `git -C E:/repo branch -D <branch>`, and adds that entry\'s "- origin:" and "- amended:" values to the new entry\'s line of the same key, writing an "- amended:" line when it has none. Otherwise set that entry\'s "- status:" to stale, remove the "- pulled:" line of each entry its "Pulled:" line names, delete the branch with `git -C E:/repo branch -D <branch>` when it exists, and set the block back to todo.';
  for (const [what, respond] of [
    ['staging-unconfirmed', { develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK }],
    ['rejected-staged', { ...GREEN_RUN, acceptance: { ...ACC_FAIL, staged: true }, park: PARK_OK }],
    ['agent-dead', { develop: null, park: PARK_OK }],
    ['park-unsafe', { ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, gates_green: false } }],
    ['plan-unreadable', { develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK }],
    ['plan-unreadable (acceptance)', { ...GREEN_RUN, acceptance: { ...ACC_FAIL, plan_obtained: false }, park: PARK_OK }],
  ]) {
    const held = await run(respond, ONE_BLOCK);
    const { out } = held;
    eq(syncOf(out), 'block-a=blocked', `${what}: the park syncs blocked, never backlogged`);
    ok(out.nextStep.includes(HELD), `${what}: nextStep gives the one rule that picks the entry or the block`);
    ok(!out.nextStep.includes('Each backlogged block\'s entry'), `${what}: and never sends the blocked park to the backlog triage`);
    // park-unsafe is known only from the park's own report, so its prompt makes the clear and the build decide.
    if (what === 'park-unsafe') {
      const pk = flat(held.prompt('park:block-a'));
      ok(pk.includes('When step 2 did not return cleared=true, or the build gate was not green after it, set "- decision: NEEDS_USER", since the engine then holds the park and the operator picks whether this entry or the block continues its work.')
        && !pk.includes('plan status'), `${what}: the park prompt makes its entry's decision depend on its own clear and build, and states no plan status`);
      const unsafeRule = pk.indexOf('When step 2 did not return cleared=true, or the build gate was not green after it, set "- decision: NEEDS_USER"');
      ok(unsafeRule > -1 && unsafeRule < pk.indexOf(DECISION_RULE), `${what}: its entry is NEEDS_USER, ahead of the decision rule`);
    } else {
      const pk = flat(held.prompt('park:block-a'));
      ok(pk.includes('Set "- decision: NEEDS_USER", since the operator picks whether this entry or the block continues its work.')
        && !pk.includes('When step 2 did not return cleared=true') && !pk.includes('plan status'), `${what}: the park prompt's entry waits for the operator's route`);
      ok(out.haltReason.includes('and the tree is CLEAN; its halt holds the park, so nextStep\'s rule for a held park picks whether that entry or the block continues its work.')
        && !out.haltReason.includes('work that entry with the user'), `${what}: the halt reason defers to the held-park rule, never to the entry`);
    }
  }
  // The later blocks of an ordered run depend on the held block, so its entry is built before they are.
  const ORDERED_CLAUSE = 'never set it back to todo. In this ordered run, work that entry before you relaunch the blocks after it, since they depend on it.';
  const orderedHeld = await run({ develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK }, { ...ONE_BLOCK, ordered: true });
  ok(orderedHeld.out.nextStep.includes(ORDERED_CLAUSE), 'an ordered held park builds its entry before the later blocks');
  const unorderedHeld = await run({ develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK }, ONE_BLOCK);
  ok(!unorderedHeld.out.nextStep.includes('In this ordered run'), 'an unordered held park has no ordering clause');
}

section('a park whose entry no green fix block can build stays blocked and is rebuilt from todo');
// Fix mode takes only gate green, so a red-baseline block, or a build-only block in a run with no test gate,
// cannot continue from its park entry.
{
  const REBUILD = 'For each, set its park entry\'s "- status:" to stale and set the block back to todo, which rebuilds it under its own gate.';
  const UNBUILDABLE_FIX = 'and its **Fix:** placeholder with this text: Fix mode cannot build this entry, since the fix mode that builds a backlog entry takes only gate green,';
  const red = await run({ develop: { ...DEV_OK, test_outcome: 'failed-expected' }, quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK },
    { ...baseArgs, maxRounds: 1, plans: [onBus({ id: 'block-a', mode: 'section', gate: 'red-baseline' })] });
  eq(syncOf(red.out), 'block-a=blocked', 'a red-baseline park syncs blocked, never backlogged');
  eq(red.out.ledger[0].status, 'blocked (not accepted within round budget, and its park needs the operator)', 'and its ledger status says so');
  ok(red.out.nextStep.includes(`These parked blocks stay blocked, since the fix mode that builds a backlog entry takes only gate green: block-a (its red-baseline tests fail by design). ${REBUILD}`),
    'nextStep sends the red-baseline block back to todo');
  ok(!red.out.nextStep.includes('Each backlogged block\'s entry') && !red.out.nextStep.includes('resolve their halt'),
    'and never to the backlog triage or a halt it never had');
  const redPk = flat(red.prompt('park:block-a'));
  ok(redPk.includes('Fix mode cannot build this entry, since the fix mode that builds a backlog entry takes only gate green, and the parked block\'s red-baseline tests fail by design.')
    && !redPk.includes('plan status'), 'the park prompt\'s **Fix:** text says why no fix block can build the entry');
  ok(redPk.includes('Set "- decision: NEEDS_USER", since no fix block can build this entry.') && redPk.includes(UNBUILDABLE_FIX)
    && !redPk.includes('Round 1 of the block built from this file restores that work.') && !redPk.includes('Build each block the "- origin:" line names on the accepted baseline'),
    'its entry waits for the user and says to rebuild the block, never to build the entry');

  const noTest = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, gates: { build: 'b' }, maxRounds: 1 });
  eq(syncOf(noTest.out), 'block-a=blocked', 'a build-only park in a run with no test gate syncs blocked');
  ok(noTest.out.nextStep.includes(`block-a (gate build-only, and this run has no test gate). ${REBUILD}`), 'and nextStep names the missing test gate');
  ok(flat(noTest.prompt('park:block-a')).includes('which needs a test gate, and the run that parked the block has none'), 'and so does the park prompt');

  const withTest = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  ok(withTest.includes('Close the gaps the **What:** lists on top of the work the branch holds')
    && !withTest.includes(UNBUILDABLE_FIX), 'a build-only park in a run with a test gate continues from its entry');

  const RED_ORDERED = { ...baseArgs, ordered: true, maxRounds: 1, plans: [onBus({ id: 'block-a', mode: 'section', gate: 'red-baseline' }), BLOCKS[1]] };
  const redStop = await run({ develop: { ...DEV_OK, test_outcome: 'failed-expected' }, quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, RED_ORDERED);
  ok(redStop.out.haltReason.includes('and the tree is CLEAN; fix mode cannot build that entry, since the fix mode that builds a backlog entry takes only gate green, and the parked block\'s red-baseline tests fail by design, so nextStep says how to rebuild the block from todo.')
    && !redStop.out.haltReason.includes('work that entry with the user'), 'an ordered red-baseline park\'s halt reason sends the block back to todo, never to its entry');
  const redAsk = await run({ develop: { ...DEV_OK, test_outcome: 'failed-expected', needs_user: true }, park: PARK_OK }, RED_ORDERED);
  eq(syncOf(redAsk.out), 'block-a=blocked', 'an ordered red-baseline needs-user park syncs blocked');
  ok(redAsk.out.nextStep.includes('"Working the backlog" says, and rebuild the block from todo with those answers, as the line below that names it says, before you relaunch the blocks after it.')
    && !redAsk.out.nextStep.includes('and build it before you relaunch') && redAsk.out.nextStep.includes(REBUILD),
    'an ordered red-baseline needs-user halt says to rebuild the block from todo, never to build its entry');
  // Unordered, the rebuilt block's developer reads only its block, never the staled entry's triage.
  const redAskOne = await run({ develop: { ...DEV_OK, test_outcome: 'failed-expected', needs_user: true }, park: PARK_OK },
    { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'section', gate: 'red-baseline' })] });
  ok(redAskOne.out.nextStep.includes('For block-a, write the answers into the block\'s own text in its plan file, since fix mode cannot build its entry and the block is rebuilt from todo, as the line below that names it says.')
    && !redAskOne.out.nextStep.includes('record the answers in that block\'s backlog entry\'s triage') && redAskOne.out.nextStep.includes(REBUILD),
    'an unordered red-baseline needs-user park carries the answers into the block, never into its entry');
  const greenAskOne = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, ONE_BLOCK);
  ok(greenAskOne.out.nextStep.includes('For block-a, record the answers in that block\'s backlog entry\'s triage, as the develop guide\'s "Working the backlog" says.')
    && !greenAskOne.out.nextStep.includes('write the answers into the block\'s own text'), 'a buildable needs-user park records the answers in its entry');

  // A held halt cannot make an unbuildable entry buildable, so the rebuild route wins over the held-park rule.
  const RED_ONE = { ...baseArgs, plans: [onBus({ id: 'block-a', mode: 'section', gate: 'red-baseline' })] };
  const redDead = await run({ develop: null, park: PARK_OK }, RED_ONE);
  eq(syncOf(redDead.out), 'block-a=blocked', 'an agent-dead red-baseline park syncs blocked');
  ok(redDead.out.nextStep.includes(`block-a (its red-baseline tests fail by design, and its halt holds the park, so resolve that halt first). ${REBUILD}`)
    && !redDead.out.nextStep.includes('stay blocked until you resolve their halt'), 'its nextStep sends it back to todo, never to the held-park rule');
  ok(redDead.out.haltReason.includes('so nextStep says how to rebuild the block from todo once its halt is resolved.')
    && !redDead.out.haltReason.includes('rule for a held park'), 'its halt reason says to rebuild it once the halt is resolved');
  const redDeadPk = flat(redDead.prompt('park:block-a'));
  ok(redDeadPk.includes('Set "- decision: NEEDS_USER", since no fix block can build this entry.') && redDeadPk.includes(UNBUILDABLE_FIX)
    && !redDeadPk.includes('until the operator picks the route its work takes'), 'its park prompt gives the unbuildable entry, never the held one');
  const redDeadAcc = await run({ develop: { ...DEV_OK, test_outcome: 'failed-expected' }, quality: CLEAN, acceptance: null, park: PARK_OK }, RED_ONE);
  ok(redDeadAcc.out.haltReason.includes('for them before you set this block back to todo.') && !redDeadAcc.out.haltReason.includes('rule for a held park'),
    'a dead verifier of a red-baseline block says to check the index before the rebuild');
}

section('a fix block that parks supersedes each branch its round 1 restored');
// Its new commit holds the restored work, so the old branch and its entry would otherwise stay open beside the new entry.
{
  const fixPark = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_OK, superseded_entries: ['i-1'] } },
    { ...FIX_ONE, maxRounds: 1 });
  const pk = flat(fixPark.prompt('park:fix-a'));
  ok(pk.includes(`This is a fix block, so its round 1 restored the work of each branch that the "- branch:" line of ${BRANCH_ENTRIES} names (print its entries with \`node 'E:/r/tools/plan-block.mjs' 'E:/plans/bus.md' 'fix-a'\`).`)
    && pk.includes(`Each distinct such branch other than ${UNFINISHED('fix-a')} that \`git -C E:/repo rev-parse --verify --quiet refs/heads/<it>\` resolves is RESTORED when its every such entry that names it is on that FIXED list,`)
    && pk.includes('Add `-p <its tip>` after the other parents for each RESTORED branch, so its history stays in the new commit\'s.'),
    'the new commit takes each restored branch\'s tip as a further parent');
  ok(pk.includes('The developer\'s last report gave FIXED to i-1. A FAILED report may keep or revert an entry\'s restored work.')
    && pk.includes('Every other branch and its entry stay as they are.'),
    'a branch whose entries were last reported FIXED is superseded');
  // A FAILED entry whose restored work stays in the tree is in the new commit, so the tree decides, not the report.
  const failedKeptRun = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FAILED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_OK, superseded_entries: ['i-1'] } },
    { ...FIX_ONE, maxRounds: 1 });
  const failedKept = flat(failedKeptRun.prompt('park:fix-a'));
  eq(syncOf(failedKeptRun.out), 'fix-a=backlogged,i-1=stale', 'a superseded FAILED entry syncs stale, so it never stays live beside the new entry');
  ok(failedKept.includes('The developer\'s last report gave FIXED to no entry.')
    && failedKept.includes('or when `git -C E:/repo diff --binary <it>^1 <it> | git -C E:/repo apply -R --check` succeeds, since the working tree then still holds its work.'),
    'a FAILED entry\'s branch is superseded when the working tree still holds its restored diff');
  ok(failedKept.indexOf('apply -R --check') < failedKept.indexOf('2. CLEAR'), 'and the tree check runs before step 2 clears the tree');
  // The superseded entry's origin blocks keep their criteria in the entry that now carries their work.
  ok(pk.includes('Then append to this entry\'s "- origin:" line, each after ", ", every <planPath>#<block id> value that the "- origin:" line of those entries holds and this line does not'),
    'the new entry adds the origins of each entry it supersedes');
  ok(pk.includes('The pulled list is empty, plus each id that the "Pulled:" line of an entry in superseded_entries names, since this entry\'s branch now holds that work too.'),
    'a focused fix park still carries the Pulled line of each entry it supersedes, since its branch now holds that pulled work');
  ok(pk.indexOf('Then delete each RESTORED branch with `git -C E:/repo branch -D <it>`, since the new commit\'s history holds its work, and return superseded_entries') > pk.indexOf('f. Confirm'),
    'and deletes each restored branch only after it confirms the new commit');
  ok(pk.includes('Return superseded_entries=[] whenever step 1 makes no commit.') && pk.includes('end the **What:** with the line "Supersedes: <those ids>, whose branches this entry\'s branch now holds."'),
    'a park with no commit supersedes nothing, and the new entry names each entry it supersedes');
  ok(String(fixPark.byLabel('park:fix-a')[0]?.opts?.schema?.required ?? '').includes('superseded_entries'), 'a fix park returns superseded_entries');
  eq(syncOf(fixPark.out), 'fix-a=backlogged,i-1=stale', 'the superseded entry syncs stale, so triage never offers it beside the new entry');
  const featurePark = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  ok(!featurePark.includes('RESTORED') && !featurePark.includes('superseded_entries'), 'a feature park supersedes nothing');

  const unsaved = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_EMPTY, superseded_entries: ['i-1'] } },
    { ...FIX_ONE, maxRounds: 1 });
  eq(syncOf(unsaved.out), 'fix-a=backlogged,i-1=needs-attention', 'a park that saved no commit supersedes no entry');
  const unknown = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_OK, superseded_entries: ['i-9'] } },
    { ...FIX_ONE, maxRounds: 1 });
  eq(syncOf(unknown.out), 'fix-a=backlogged,i-1=needs-attention', 'an entry the developer never reported gets no status edit');
  ok(unknown.logs.some((l) => l.includes('park superseded i-9, which the developer never reported — no status edit, so nextStep says to set each stale')),
    'and the log names it');
  // The park deleted its branch, so a later build of its file would find the branch missing.
  ok(unknown.out.nextStep.includes(`The park of fix-a deleted the branches of i-9, entries its developer never reported, so no status edit reached them: set each one's "- status:" to stale, since ${UNFINISHED('fix-a')} holds their work.`),
    'and nextStep says to set it stale');
  eq(unknown.out.ledger[0].unreportedSuperseded.join(','), 'i-9', 'the ledger row carries the unreported ids');
  ok(!unsaved.out.nextStep.includes('entries its developer never reported'), 'a park that superseded nothing adds no such line');
  // The park deleted the superseded branches, so an entry written by hand is the only place their origins survive.
  const unlinkedFix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_OK, superseded_entries: ['i-1'], entry_written: false } },
    { ...FIX_ONE, maxRounds: 1 });
  eq(syncOf(unlinkedFix.out), 'fix-a=blocked,i-1=stale', 'an unlinked fix park still syncs its superseded entry stale');
  ok(unlinkedFix.out.nextStep.includes('The park of fix-a superseded i-1 and deleted their branches, so end its entry\'s **What:** with the line "Supersedes: i-1, whose branches this entry\'s branch now holds." and append each "- origin:" value of those entries to its "- origin:" line, and each "- amended:" value to its "- amended:" line, writing that line when it has none.'),
    'and nextStep says to carry the superseded entries\' origins and amendments into the entry written by hand');
  ok(!fixPark.out.nextStep.includes('The park of fix-a superseded'), 'a park that wrote its entry adds no such line');
  ok(!fixPark.out.nextStep.includes('entries its developer never reported'), 'a park whose superseded entries were all reported adds no stale line');
  // The branch may omit staged work, so the operator may redo the block, which restores each old branch again.
  const held = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { unstaged_confirmed: false }), park: { ...PARK_OK, superseded_entries: ['i-1'] } }, FIX_ONE);
  const heldPk = flat(held.prompt('park:fix-a'));
  ok(!heldPk.includes('RESTORED') && heldPk.includes('Return superseded_entries=[], since the operator picks this park\'s route once its halt is resolved, so every branch its round 1 restored stays as it is.'),
    'a held halt supersedes no branch');
  eq(syncOf(held.out), 'fix-a=blocked,i-1=needs-attention', 'and the engine ignores a superseded list it returns anyway');
}

section('a landed fix block names each branch its acceptance could not delete');
{
  const kept = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: { ...FIX_PASS, branches_kept: ['aipg-unfinished/x'] } }, FIX_ONE);
  ok(kept.out.nextStep.includes('These staged blocks hold the work of unfinished branches that stay until the user commits that work, so a landing the user rejects can be rebuilt from them: aipg-unfinished/x (fix-a). Once the user commits the staged work, delete each with `git branch -D <branch>` in any checkout of the repo.'),
    'stage delivery: nextStep names each landed branch and says to delete it once the user commits');
  const keptCommit = await run({ develop: { ...fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), baseline_staged_files: 0 }, quality: CLEAN,
    acceptance: { ...FIX_PASS, committed: true, commit_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', commit_subject: 'fix-a', tree_matches: true, tree_clean: true, branches_kept: ['aipg-unfinished/x'] } },
  { ...FIX_ONE, commit: true });
  ok(keptCommit.out.nextStep.includes('Acceptance landed these blocks but could not delete the unfinished branch whose work they now hold: aipg-unfinished/x (fix-a). Delete each with `git -C E:/repo branch -D <branch>`.'),
    'commit delivery: nextStep names the branch a deletion left behind and how to delete it');
  const rejected = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: { ...FIX_GAP, branches_kept: ['aipg-unfinished/x'] }, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 });
  ok(!rejected.out.nextStep.includes('hold the work of unfinished branches'), 'a failing verdict keeps its branches by design');
}

section('a developer escalation parks first, then stops an ordered run');
// parked[] is keyed on the branch and the `parked` flag, never the status prose: an escalated block's status
// text names its halt, so it would otherwise have its branch reported nowhere in the return.
{
  const { out, labels, prompt } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: PARK_OK,
  }, { ...baseArgs, ordered: true });
  ok(labels.includes('park:block-a'), 'PARK ran on the halt path');
  eq(out.status, 'BLOCKED (needs user input)', 'status');
  ok(!labels.some((l) => l.includes('block-b')), 'block-b never started');
  eq(out.parked[0]?.branch, UNFINISHED('block-a'), `the escalated block's branch is surfaced: ${out.parked[0]?.branch}`);
  eq(out.parked[0]?.status, 'backlogged (needs user)', 'the ledger row of a backlogged escalated block agrees with its plan status');
  eq(syncOf(out), 'block-a=backlogged', 'and its plan status is backlogged, since its entry holds its work');
  ok(/The tree is clean/.test(out.nextStep) && !/tree still holds/.test(out.nextStep),
    'nextStep says the tree is clean, never that it still holds the work');
  ok(/research each question in it first \(develop guide §6\), then put the rest to the user with a recommendation each/.test(out.nextStep),
    'nextStep sends the operator to research each question before asking the user');
  ok(out.nextStep.includes('Read E:/r/runs/t/NEEDS-USER.md') && out.nextStep.includes("The block's backlog entry holds the same question"),
    'an ordered halt names NEEDS-USER.md for its question and the backlog entry that also holds it');
  ok(/and the tree is CLEAN\.$/.test(out.haltReason), `the park suffix ends at the tree state: ${out.haltReason}`);
  ok(/was halted: the developer escalated a user-only decision \(see E:\/r\/runs\/t\/NEEDS-USER\.md\)/.test(prompt('park')),
    'an ordered run\'s question is in NEEDS-USER.md');
  const unlinked = await run({ develop: { ...DEV_OK, needs_user: true }, park: { ...PARK_OK, entry_written: false } }, { ...baseArgs, ordered: true });
  ok(unlinked.out.nextStep.includes('The park did not confirm the block\'s backlog entry, so the question is only in E:/r/runs/t/NEEDS-USER.md: once that entry exists, record the answers in its triage')
    && !unlinked.out.nextStep.includes('The block\'s backlog entry holds the same question'),
    'an ordered halt whose park did not confirm its entry never says the entry holds the question');
  // The halt reason already says the entry is unconfirmed, so it never tells the operator to work that entry.
  ok(unlinked.out.haltReason.includes('The park did not confirm writing its entry in')
    && unlinked.out.haltReason.endsWith('and the tree is CLEAN; nextStep says how to add that entry first.'),
    `a halted park with no confirmed entry points at nextStep's line for adding it: ${unlinked.out.haltReason}`);
  const unlinkedBudget = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, entry_written: false } }, { ...baseArgs, ordered: true });
  ok(unlinkedBudget.out.haltReason.endsWith('and the tree is CLEAN; nextStep says how to add that entry first.')
    && !unlinkedBudget.out.haltReason.includes('work that entry with the user'),
    'an ordered budget park with no confirmed entry never says to work that entry');
}
{
  // Escalated before editing anything: park saves nothing, so naming a branch would send the operator to a
  // commit that does not exist.
  const { out } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: PARK_EMPTY,
  });
  eq(out.parked[0]?.branch, null, 'no branch for an empty park');
  ok(/NO work was saved for: block-a/.test(out.nextStep), 'and nextStep says nothing was saved');
  ok(!/Work SAVED/.test(out.nextStep), 'never that the work was saved');
}
{
  const { out } = await run({
    develop: { ...DEV_OK, needs_user: true },
    park: PARK_EMPTY,
  }, { ...baseArgs, ordered: true });
  eq(out.parked[0]?.branch, null, 'no branch');
  ok(/It had NOTHING to save \(its working tree held no work\)\. The park appended one entry to .* that says why the block parked, and the tree is CLEAN/.test(out.haltReason),
    `an empty ordered park says there was nothing to save: ${out.haltReason}`);
  ok(/NO work was saved for: block-a/.test(out.nextStep), 'nextStep lists it as an empty park');
}

section('an agent ignores a round file of an earlier launch');
{
  const note = 'A round file of this block that this prompt does not name may come from an earlier launch of the block, so ignore it.';
  const { prompts } = await run(GREEN_RUN, ONE_BLOCK).then((r) => ({ prompts: ['develop', 'quality', 'acceptance'].map((l) => flat(r.prompt(l))) }));
  ok(prompts.every((text) => text.includes(`A round with no blind review has no blind review file. ${note}`)),
    'the round note of every role tells the agent to ignore a round file it is not named');
}

section('continueParked is retired and throws before any agent runs');
// A park's backlog entry carries its block's work, so an ignored arg would silently redo the block from scratch.
{
  for (const [what, value] of [['an id list', ['block-a']], ['an empty list', []], ['a string', 'block-a']]) {
    const { terminal, calls } = await runTrace(ENGINE, { args: { ...baseArgs, continueParked: value }, respond: GREEN_RUN });
    ok(terminal.kind === 'throw' && /^args\.continueParked is retired: a park saves its block's work on a branch and appends one entry that links it/.test(terminal.message)
      && terminal.message.includes('once its "- decision:" is ACTIONABLE, build its file as a fix-mode block, and that block\'s round-1 developer restores the branch\'s work'),
      `${what} throws naming the backlog entry route: ${terminal.message}`);
    eq(calls.length, 0, `${what}: no agent ran`);
  }
  const plain = await run(GREEN_RUN);
  ok(/If it IS 0, run `git -C E:\/repo write-tree`\nand report the tree id it prints as baseline_index_tree\. Next, report earlier_files=true when [^\n]* exists,\nelse false, before you write to either file\. Then implement this block from\nscratch on top of the accepted baseline/.test(plain.prompt('develop block-a r1')),
    'a feature block\'s round 1 implements from scratch');
}

section('a fix block restores each branch its ACTIONABLE entries link, in round 1, after the clean-baseline check');
{
  const { prompt, byLabel } = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS },
    { ...FIX_ONE, maxRounds: 2 });
  const r1 = flat(prompt('develop fix-a r1'));
  const clean = r1.indexOf('CONFIRM THE BASELINE IS CLEAN');
  const INDEX_COPY = 'E:/r/runs/t/scratch/restore-fix-a.index';
  const apply = r1.indexOf(`Otherwise restore it with \`git -C E:/repo diff --binary <branch>^1 <branch> | GIT_INDEX_FILE="${INDEX_COPY}" git -C E:/repo apply -3\``);
  ok(clean > -1 && apply > clean, 'round 1 runs the clean-baseline check first, then restores the branch');
  ok(r1.includes(`The branch of ${BRANCH_ENTRIES} holds a parked block's work.`) && r1.includes('b. For each distinct branch those lines name, in turn:'),
    'only an ACTIONABLE entry\'s branch is restored, once per branch');
  ok(r1.includes('When `git -C E:/repo diff --stat <branch>^1 <branch>` prints nothing, the branch holds no work, so skip it.'), 'an empty diff restores nothing');
  // A landed block may hold a FAILED entry's restored work while its branch stays, so a second apply would fail.
  const landedSkip = r1.indexOf('When `git -C E:/repo diff --binary <branch>^1 <branch> | git -C E:/repo apply -R --check` succeeds, the accepted baseline already holds the branch\'s work, so skip it.');
  ok(landedSkip > -1 && landedSkip < apply, 'a branch the accepted baseline already holds is skipped before the apply');
  // A missing branch also prints nothing to the diff above, so it is checked first and never read as empty.
  const missing = r1.indexOf('when `git -C E:/repo rev-parse --verify --quiet refs/heads/<branch>` prints nothing, the branch is missing, so the restore FAILS for it (below).');
  ok(missing > -1 && missing < r1.indexOf('When `git -C E:/repo diff --stat <branch>^1 <branch>` prints nothing'), 'a missing branch fails the restore before the empty-diff check');
  // apply -3 implies --index, so the index copy is what keeps the restored work out of the real index.
  ok(r1.includes('a 3-way apply onto the accepted baseline, since a block that landed after the branch was cut may have changed a file the branch touches.')
    && r1.includes('Never run it without that GIT_INDEX_FILE, and never with `--index` or `--cached`'), 'the 3-way restore runs on an index copy, never --index or --cached');
  ok(r1.includes('A clean apply leaves no conflict to resolve. An apply that exits non-zero') && !r1.includes('A clean apply needs nothing more'),
    'a clean restore is not called finished');
  const copy = r1.indexOf(`cp "$(git -C E:/repo rev-parse --path-format=absolute --git-path index)" "${INDEX_COPY}"`);
  ok(copy > clean && copy < apply, 'it copies the real index after the clean-baseline check and before the first apply');
  ok(!/a PLAIN apply/.test(r1), 'it no longer restores with a plain apply');
  ok(r1.includes(`Resolve each such file only when you confirm the resolution against the accepted baseline and the work the branch holds, then run \`GIT_INDEX_FILE="${INDEX_COPY}" git -C E:/repo add -- <file>\``)
    && r1.includes('A conflict you cannot confirm FAILS the restore for the branch (below).'), 'a conflict is resolved only when confirmed, else the restore fails');
  // Intent-to-add follows every apply, so a reversed restore leaves no index entry behind.
  ok(r1.indexOf('c. Once every branch has applied and no conflict marker is left, delete that index copy. A file the project generates from the restored files may still be stale, so regenerate it now, before the gate run. Then run `git -C E:/repo add -N -- <file>` on each new file the restores or that regeneration created') > apply,
    'once every branch applied, it deletes the index copy, regenerates generated files, then marks the new files intent-to-add, so one branch\'s regeneration never conflicts with the next apply');
  ok(/Confirm `git -C E:\/repo diff --cached --stat` is the same/.test(r1), 'it confirms the staged index is unchanged');
  ok(r1.includes(`An ACTIONABLE entry with an "- origin:" line holds a parked block's unfinished work. On top of its branch's work, which step b restored or the accepted baseline already holds, or on the accepted baseline when it carries no "- branch:" line, close the gaps its **What:** lists and meet ${ORIGIN_CRITERIA}. Those gaps are copied from a review. A review is another agent's claim.`)
    && r1.includes("A gap you refute gets its DISMISSED line under rule 1. A gap for a wrong risk answer, for a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, or for a path that changed after its round's snapshot, takes no fix and no log, since this block's first blind review judges the entire restored work. Report the entry FIXED once every other listed gap is closed or declined by a DISMISSED line and the origin criteria hold, never STALE."),
    'every park entry, with a branch or without, meets its origin block\'s criteria and is reported FIXED, never STALE, with no fix or log owed for a listed risk gap');
  ok(r1.includes('undo every restore. The unstaged tree was empty when you started, so run `git -C E:/repo checkout -- <file>` for each file `git -C E:/repo diff --name-only` lists, and `git -C E:/repo clean -f -- <file>` for each `??` file `git -C E:/repo status --porcelain` lists')
    && r1.includes('set restore_failed to the branch that failed and why (missing, the `git apply` error, or the conflict you could not confirm), set restored_branches to 0, and STOP. Every branch stays as it was.')
    && r1.includes('Otherwise set restore_failed to "" and restored_branches to the count of branches step b applied.'),
    'a branch that is missing or does not apply undoes the restores and stops');
  ok(!/step 0 below/.test(r1), 'a fix block names no procedure step 0, since its procedure starts at step 1');
  ok(!flat(prompt('develop fix-a r2')).includes('RESTORE unfinished work'), 'round 2 restores nothing');
  ok(String(byLabel('develop fix-a r1')[0]?.opts?.schema?.required ?? '').includes('restore_failed'), 'a fix developer returns restore_failed');
  ok(!('restore_failed' in (byLabel('develop fix-a r2')[0]?.opts?.schema?.properties ?? {})) && !String(byLabel('develop fix-a r2')[0]?.opts?.schema?.required ?? '').includes('restored_branches'), 'a later-round fix developer returns neither restore field');
  ok(!flat((await run(GREEN_RUN, ONE_BLOCK)).prompt('develop block-a r1')).includes('RESTORE unfinished work'), 'a feature block restores nothing');
  const accept = flat(prompt('acceptance fix-a r2'));
  ok(accept.includes('An entry with an "- origin:" line holds a parked block\'s unfinished work. When it also carries a "- branch:" line, the developer restored that branch\'s work into the unstaged diff in round 1, unless the accepted baseline already held it, and its fix is that entire branch work and every change made on it: read every hunk of that range, by `git -C E:/repo diff --stat <branch>^1 <branch>` first, then `git -C E:/repo diff <branch>^1 <branch> -- <file>` for each file it lists, one file per command, in the unstaged diff or the accepted baseline.'),
    'acceptance judges the entire branch work as that entry\'s fix, wherever it is');
  ok(accept.includes(`The gaps its **What:** lists are another agent's claims, which the developer confirmed or refuted. Return actually_fixed=true for an entry with an "- origin:" line only when the accepted baseline with the unstaged diff closes each gap its **What:** lists, or a line in E:/r/runs/t/gate/DISMISSED-fix-a.md declines that gap under the OVERRIDE and ledger-line rules above, and meets ${ORIGIN_CRITERIA}. A gap for a wrong risk answer, for a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, or for a path that changed after its round's snapshot, that its **What:** lists counts as closed, since this block's first blind review, which runs before any acceptance, judges the entire restored work.`),
    'acceptance checks the origin block\'s criteria and reachability for every park entry, with a branch or without, and counts a listed risk gap closed');
  // Stage delivery: the user may still reject the staged work, so the branch stays until the user commits it.
  ok(accept.includes(`9. LIST LANDED BRANCHES, only on a pass that returns regression=false, once step 8 has staged the block: return branches_kept = ${LANDED_BRANCHES}, or []. Delete no branch:`)
    && String(byLabel('acceptance fix-a r2')[0]?.opts?.schema?.required ?? '').includes('branches_kept'),
    'stage-mode acceptance lists each landed branch and deletes none');
  ok(!accept.includes('DELETE LANDED BRANCHES') && !/branch -D/.test(accept), 'stage-mode acceptance runs no git branch -D');
  ok(accept.indexOf('9. LIST LANDED BRANCHES') > accept.indexOf('8. DECIDE'), 'after it stages the block');
  const committed = flat((await run({ develop: { ...fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), baseline_staged_files: 0 }, quality: CLEAN, acceptance: { ...FIX_PASS, committed: true, commit_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', commit_subject: 'fix-a', tree_matches: true, tree_clean: true } },
    { ...FIX_ONE, commit: true })).prompt('acceptance fix-a r1'));
  ok(committed.indexOf('10. DELETE LANDED BRANCHES') > committed.indexOf('9. COMMIT'), 'in commit mode the branch is deleted after the commit');
  ok(committed.includes('10. DELETE LANDED BRANCHES, only on a pass that returns regression=false, committed=true, commit_subject equal to the block\'s title, tree_matches=true and tree_clean=true:'),
    'in commit mode only a commit that passes every landing check deletes a branch');
  ok(committed.includes(`for ${LANDED_BRANCHES}, run \`git -C E:/repo branch -D <branch>\`, since the landed block holds that work.`)
    && committed.includes('Return branches_kept = each branch this step ran `git branch -D` on that `git -C E:/repo rev-parse --verify --quiet refs/heads/<branch>` still resolves after it, or [].'),
    'in commit mode it deletes only a branch whose entries it verified fixed, and returns each deletion left behind');
  ok(!flat((await run({ ...GREEN_RUN, acceptance: ACC_PASS }, ONE_BLOCK)).prompt('acceptance block-a r1')).includes('DELETE LANDED BRANCHES'),
    'a feature block\'s acceptance deletes no branch');
}

section('a branch that no longer applies blocks its fix block, with no park');
{
  const FAILED = { restore_failed: 'aipg-unfinished/x: error: patch failed: src/a.js:3' };
  const carry = await run({ ...GREEN_RUN, develop: (label) => (label === 'develop fix-a r1' ? fixDev([], FAILED) : DEV_OK), park: PARK_OK },
    { ...baseArgs, plans: [FIX_ONE.plans[0], BLOCKS[1]] });
  ok(!carry.labels.some((l) => l.startsWith('park') || /quality fix-a|acceptance fix-a/.test(l)), 'no review and no park follow the failed restore');
  ok(carry.labels.includes('develop block-b r1') && carry.out.halted === false, 'an unordered run carries on');
  eq(syncOf(carry.out).split(',')[0], 'fix-a=blocked', 'the block syncs blocked');
  ok(carry.out.nextStep.includes('1 fix block(s) could not restore an unfinished branch and are NOT done: fix-a (aipg-unfinished/x: error: patch failed: src/a.js:3).')
    && carry.out.nextStep.includes('each branch still holds its work'), 'nextStep names the block, the error and the kept branch');
  const stop = await run({ develop: fixDev([], FAILED), park: PARK_OK }, { ...baseArgs, ordered: true, plans: [FIX_ONE.plans[0], BLOCKS[1]] });
  eq(stop.out.status, 'halted (a fix block could not restore an unfinished branch, and the ordered run stopped there)', 'an ordered run stops');
  ok(stop.out.haltReason.includes('could not restore an unfinished branch in round 1: aipg-unfinished/x: error: patch failed: src/a.js:3.')
    && stop.out.haltReason.includes('the branch still holds the work'), 'and its halt reason names the error and the kept branch');
  const later = await run({ develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([{ issue_id: 'i-1', status: 'FIXED' }], FAILED)), quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS },
    { ...FIX_ONE, maxRounds: 2 });
  eq(later.out.status, 'done (all blocks staged)', 'a later round\'s restore_failed is ignored, since only round 1 restores');
}

section('an unordered run parks a needs-user block and continues');
// No later block depends on it, so only the user's answer waits, and the question goes to the block's own
// question file and its backlog entry, never to NEEDS-USER.md.
{
  const { out, labels, prompt } = await run({
    ...GREEN_RUN,
    develop: (label) => (/block-a/.test(label) ? { ...DEV_OK, needs_user: true } : DEV_OK),
    park: PARK_OK,
  });
  ok(out.halted === false, 'the run did not halt');
  ok(labels.includes('park:block-a'), 'block-a was parked');
  ok(labels.some((l) => /block-b/.test(l)), 'block-b ran');
  eq(syncOf(out), 'block-a=backlogged,block-b=done', 'block-a is backlogged and block-b is done');
  eq(out.parked[0]?.status, 'backlogged (needs user)', 'the ledger row of a backlogged escalated block agrees with its plan status');
  eq(out.status, 'run complete (1 block(s) parked)', 'status');
  ok(/REST OF THE RUN can continue/.test(prompt('park')), 'park is told the run continues');
  ok(/was halted: the developer escalated a user-only decision \(see E:\/r\/runs\/t\/question-block-a\.md\)/.test(prompt('park')), 'with the needs-user reason and the question file');
  ok(flat(prompt('develop block-a r1')).includes('append a FULL, self-contained entry to E:/r/runs/t/question-block-a.md (all the detail the user needs to decide) under the heading `## Question: block-a r1`'),
    'the developer of an unordered run writes its question to the block\'s question file');
  ok(out.nextStep.includes(`1 block(s) escalated a user-only decision: block-a. These questions are in their block's backlog entry, whose decision is NEEDS_USER: block-a in ${backlogFile('block-a')}.`)
    && /research each question in it first \(develop guide §6\), then put the rest to the user with a recommendation each/.test(out.nextStep),
    'nextStep names the block and its backlog entry and sends the operator to research each question before asking the user');
  ok(!out.nextStep.includes('NEEDS-USER'), 'and never names NEEDS-USER.md for a park');
}
{
  // A park with no confirmed entry may hold no copy of the question, so nextStep names the question file.
  const { out } = await run({
    ...GREEN_RUN,
    develop: (label) => (/block-a/.test(label) ? { ...DEV_OK, needs_user: true } : DEV_OK),
    park: { ...PARK_OK, entry_written: false },
  });
  const next = String(out.nextStep ?? '');
  ok(next.includes('The park did not confirm the backlog entry of block-a, so each question is only in E:/r/runs/t/question-block-a.md.')
    && !next.includes('These questions are in their block\'s backlog entry'), `an unconfirmed entry sends the operator to the question file: ${next}`);
}
{
  // Every other escalation still stops an unordered run, and park must be told so.
  const { out, prompt } = await run({ develop: null, park: PARK_OK });
  ok(out.halted === true, 'agent-dead halts the unordered run');
  ok(/The run stops after you/.test(prompt('park')), 'park is told the run stops');
}

section('park records the halt that actually happened, never an escalation that did not');
// Only needs-user writes a question entry. Told every escalated halt was a developer escalation, the
// park agent invented a blocker in the backlog entry that copies the halt.
{
  for (const [kind, respond, reason] of [
    ['staging-unconfirmed', { ...GREEN_RUN, develop: { ...DEV_OK, unstaged_confirmed: false }, park: PARK_OK },
      /the staged index may hold work no reviewer read, since the developer did not confirm its work stayed unstaged or acceptance found the index changed outside acceptance; inspect `git -C E:\/repo diff --cached c0ffee0000000000000000000000000000000001` for self-staged work/],
    ['agent-dead', { develop: null, park: PARK_OK }, /an agent returned nothing \(skipped or died\)/],
    ['plan-unreadable', { develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK }, /an agent could not obtain its plan/],
  ]) {
    const p = (await run(respond, ONE_BLOCK)).prompt('park:block-a');
    ok(reason.test(p), `${kind}: park names the real cause`);
    ok(!/developer escalated/.test(p), `${kind}: and never blames a developer escalation`);
  }
}

section('park never names a review file that was never written');
// With the gate never green no round reaches a reviewer, the closing blind review is clean and the closing
// acceptance does not confirm its file, so there IS no review file.
{
  const { prompt } = await run({ develop: { ...DEV_OK, build_passed: false }, quality: CLEAN, acceptance: { ...ACC_FAIL, wrote_file: false }, park: PARK_OK }, ONE_BLOCK);
  const p = prompt('park:block-a');
  ok(p !== '', 'park still ran');
  ok(!/(acceptance|quality)-review-block-a-r\d+\.md, copied verbatim/.test(p), 'no fabricated review path in the entry the park writes');
  ok(flat(p).includes('the line "Halted: a reviewer reported a failing verdict but did not confirm writing its review file.", then this halt reason, copied verbatim: Acceptance verifier for block block-a failed the block in the closing pass (round 6 in its file names) but did not confirm writing'),
    'the entry copies the halt reason, which says the file may not exist');
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
  ok(!/inspect/i.test(out.status) && out.haltReason.includes('Inspect `git -C E:/repo diff --cached c0ffee0000000000000000000000000000000001`'),
    'the inspect instruction lives in the halt reason, not the status, and diffs against the tree before this acceptance staged');
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
  eq(syncOf(out), 'block-a=backlogged', 'statusSync marks the block backlogged, never done');
  eq(out.plansDone.length, 0, 'nothing counts done');
  ok(/flagged a regression and staged nothing/.test(out.haltReason) && /left UNSTAGED and is flagged as a regression/.test(out.haltReason),
    'the reason says the work is unstaged and flagged as a regression');
  ok(/never stage it as it is/.test(out.haltReason) && !/Stage its files|git -C \S+ add/.test(out.haltReason),
    'and never tells the operator to stage it');
  ok(/see E:\/r\/runs\/t\/acceptance-review-block-a-r1\.md/.test(out.haltReason), 'and cites the acceptance file it wrote');
  ok(/flagged a regression and staged nothing/.test(out.nextStep), 'nextStep repeats the reason');

  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN,
    acceptance: { ...FIX_PASS, staged: false, regression: true }, park: PARK_OK }, FIX_ONE);
  eq(syncOf(fix.out), 'fix-a=backlogged,i-1=needs-attention', 'a fix block syncs backlogged and its FIXED entry needs-attention');
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
section('only todo blocks are built: done, skip, backlogged, parked and blocked are never selected');
// A status typo is a block silently skipped or, worse, a finished one rebuilt over its own staged
// baseline. The filter is what makes a relaunch against the same plan file safe.
{
  const MIXED = { ...baseArgs, plans: [
    onBus({ id: 'block-done', mode: 'feature', gate: 'build-only', status: 'done' }),
    onBus({ id: 'block-skip', mode: 'feature', gate: 'build-only', status: 'skip' }),
    onBus({ id: 'block-backlogged', mode: 'feature', gate: 'build-only', status: 'backlogged' }),
    onBus({ id: 'block-parked', mode: 'feature', gate: 'build-only', status: 'parked' }),
    onBus({ id: 'block-blocked', mode: 'feature', gate: 'build-only', status: 'blocked' }),
    onBus({ id: 'block-todo', mode: 'feature', gate: 'build-only', status: 'todo' }),
  ] };
  const { out, labels } = await run(GREEN_RUN, MIXED);
  ok(!labels.some((l) => /block-done|block-skip|block-backlogged|block-parked|block-blocked/.test(l)),
    'no non-todo block reached any agent');
  eq(out.plansDone.join(), 'block-todo', 'only the todo block was built');
  eq(out.plansTotal, 6, 'while the array total still reports the whole plan file');
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
  // A backlogged block's work lands through its park entry's fix block, so no run of this plan sweeps it.
  const backlogged = await run({}, { ...ALL_DONE, sweep: 'goal-coverage', plans: BLOCKS.map((b, i) => ({ ...b, status: i ? 'done' : 'backlogged' })) });
  ok(backlogged.out.nextStep.includes('or a block was backlogged, verify coverage against the goal yourself.')
    && backlogged.out.nextStep.includes(`The backlogged blocks ${BLOCKS[0].id} are not done: set each done once its park entry is fixed and close has landed that entry's fix block on the user's branch and that work is committed there, as the develop guide\'s "Working the backlog" step 5 says, or to skip or todo once the user skips that entry, as its step 3 says.`),
    'a goal-coverage relaunch with a backlogged block says the sweep did not run and how the block becomes done');
  ok(!swept.out.nextStep.includes('The backlogged blocks'), 'an all-done relaunch names no backlogged block');
  const unswept = await run({}, { ...ALL_DONE, sweep: 'none' });
  ok(!/sweep/.test(unswept.out.nextStep), 'a sweep:none all-done relaunch never mentions the sweep');
}

section('gates.test is demanded only for the PENDING set, not for blocks already done');
// Scoped deliberately unlike the sibling engines' all-blocks rule: with the todo filter, an all-done
// relaunch would otherwise throw over a test command this run will never execute instead of reaching the
// nothing-to-run terminal above.
{
  const DONE_GREEN = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b' }, backlogDir: BACKLOG, blockTool: BLOCK_TOOL,
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
  ok(healthy.out.nextStep.includes('Land the run with `wt.mjs close` once the develop guide says the run lands, and report the run\'s summary to the user: each landed block, each backlog entry named above, and each entry in '),
    'nextStep tells the operator to land the run and report its summary');
  ok(healthy.out.nextStep.includes('diff` is empty and `git -C ') && healthy.out.nextStep.includes('status --porcelain` lists no `??` file'),
    'nextStep carries the unstaged-tree check that holds in stage and commit delivery');
  ok(!/diff --cached --stat|run the full gates|review files|DISMISSED-<id>|auditing/.test(healthy.out.nextStep),
    'and drops the gate re-run, the diff stat, the review-file reads and the DISMISSED audit');

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

section('args.blockTool points the block command at an installed plugin\'s own tools/ copy, and a launch without it throws');
// An installed plugin splits ROOT (the persistent data dir) from the versioned cache dir that ships
// tools/plan-block.mjs. A path derived from ROOT names a file ROOT does not hold, and every agent
// halts the run on plan_obtained=false.
{
  const { prompt } = await run(GREEN_RUN, { ...ONE_BLOCK, blockTool: 'C:\\plug\\cache\\aipg\\1.0.0\\tools\\plan-block.mjs' });
  const dev = prompt('develop block-a');
  ok(/node 'C:\/plug\/cache\/aipg\/1\.0\.0\/tools\/plan-block\.mjs' 'E:\/plans\/bus\.md' 'block-a'/.test(dev),
    'the command uses the passed path, backslashes normalized');
  ok(!/E:\/r\/tools\/plan-block\.mjs/.test(dev), 'and no path under ROOT');

  const { blockTool: _, ...NO_TOOL } = baseArgs;
  for (const [args, what] of [[NO_TOOL, 'a missing path'], [{ ...baseArgs, blockTool: '  ' }, 'a blank path'], [{ ...baseArgs, blockTool: 7 }, 'a path that is not a string']]) {
    const msg = await throwsWith(ENGINE, { args });
    ok(msg.startsWith('Missing args.blockTool: pass the blockTool path that `node <plan-edit.mjs> args` prints'),
      `${what} throws, naming the arg and the command that prints it: ${msg.slice(0, 70)}`);
  }
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
  // review file is read at the WRITE step, where the Write tool needs a prior read to overwrite it.
  ok(q.replace(/\s+/g, ' ').includes(`${STATE}/gate/ also holds other blocks' review and DISMISSED files. Before you review, read only ${STATE}/gate/DISMISSED-block-a.md there. At the WRITE step, once your findings are final, Read ${STATE}/gate/quality-review-block-a-r1.md if it exists`),
    'and it is told gate/ holds other blocks\' files and to read only its own DISMISSED file there, plus its own review file at the WRITE step');
  const a = (await run(GREEN_RUN)).prompt('acceptance block-a');
  ok(a.includes(`${STATE}/gate/DISMISSED-block-a.md`) && a.includes(`${STATE}/question-block-a.md`)
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
    ok(/work, if any, is parked on a branch that the park's backlog entry links/.test(out.haltReason) && /work that entry as the develop guide's "Working the backlog" says/i.test(out.haltReason),
      'it names where a parked block\'s work continues');
    ok(String(out.haltReason ?? '').includes('build the blocks still todo, in either order.'), 'an unordered run may work the entry and relaunch in either order');
    ok(labels.includes('park:block-a'), 'its work is PARKED, not abandoned in the tree');
    ok(!labels.some((l) => l.includes('block-b')), 'block-b never started');
    eq(out.ledger[0].status, 'BLOCKED (agent died)', 'the ledger says the agent died, not "round budget"');
  }
  // An ordered run's later blocks depend on the parked one, so its entry is worked before they are built.
  for (const [role, respond] of DEAD) {
    const { out } = await run(respond, { ...baseArgs, ordered: true });
    ok(String(out.haltReason ?? '').includes('the block stays blocked until nextStep\'s rule for a held park picks that entry or the block. When it picks the entry, work that entry first, as the develop guide\'s "Working the backlog" says, then relaunch with fresh `plan-edit.mjs args` to build the blocks still todo, since they depend on this block.')
      && !String(out.haltReason ?? '').includes('in either order'), `a dead ${role} in an ordered run works the entry before the later blocks`);
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
// Acceptance's one "Not a regression" item for a removed defect, a logged fix included, and its developer-side mirror.
const removedDefectItem = (mode, tag, id, zones) => `- a removed defect: a change that closes a finding an earlier review of this block named, the same defect on a sibling path of a change ${REQUIRED_BY[mode]} requires or of such a finding, or a defect that a "${tag} ${id}:" line in ${STATE}/DECISIONS.md names. It is not a regression only when you confirm from the code that the baseline behavior it removes was itself that defect, that the change alters no other behavior, that it lies in code this block's text does not exclude and ${OWNED_CODE}, and that it lies ${zones}.`;
const removedDefectExcuse = (tag, zones) => `Acceptance does not count as regressed a removed defect (a real defect that an earlier review finding or a ${tag} line in DECISIONS.md names, or the same defect on a sibling path of such a finding or of a fix this block requires) that lies in code this block's text does not exclude and ${OWNED_CODE}, and ${zones}.`;
const RULE_2 = '2. A pre-existing finding, at any tier, that the ZONE ROUTING above does not fix → DROP + LOG.';
const RULE_3 = '3. Stops the build/tests/verification → FIX it where the ZONE ROUTING above places the fix, or ESCALATE it (7) where that routing says to.';
const RULE_8 = "8. Any other open choice: weigh its benefit (what it improves, and how likely an input reaches it) against its cost (diff size, regression risk, scope). Benefit clearly ahead → FIX. Benefit not clearly ahead, or a different block's work → DROP + LOG.";
const SIBLINGS_STEP = "SIBLINGS: when you FIX a finding in any phase or make a fix this block requires, grep for every sibling path with the same mechanism, and fix each one the ZONE ROUTING above fixes. DROP + LOG every other sibling by its file:line, or log the class it belongs to. A sibling in code this block's text excludes, or that another block of the plan owns, is DROP + LOG wherever it lies, in the SPEC reason form below.";

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
    ok(/6b\. Conflicts with the plan, and you did not verify that the plan's prescription is defective\s+→ DROP \+ LOG, in the SPEC reason form below\./.test(dev)
      && !/intentional \/ not a real-world code path/.test(dev), `${mode}: 6b keeps only the unverified case a DROP`);
    ok(/→ DROP \+ LOG, in the SPEC reason form below\. The DROP reason names the read or probe that showed\s+the prescription works as written\. A conflict that no read or probe settles goes to 7\./.test(dev),
      `${mode}: a 6b drop rests on a checked fact, and an unsettled conflict escalates`);
    // A decline whose reason is the plan cannot name its reason in code terms, so it takes the one form the blind reviewer skips.
    ok(flat(dev).includes('never cite a plan id, block id, issue id or plan clause. One reason form is the exception, for a decline whose reason is that the plan prescribes the code, this block\x27s text excludes it, or another block of the plan owns it. Its entire line is: `<file:line> — <finding gist> — SKIPPED: SPEC: <file:line of that code> — <which of the three holds, and the read or probe that showed it, ≤15 words>` Its reason names the code\'s file:line and quotes no plan text. The blind reviewer skips such a line, and acceptance checks it against the plan.'),
      `${mode}: the ledger-reason rule gains the SPEC form for a plan-prescribed or other-block decline`);
    ok(dev.includes(`DROP (1, 2, 6b or 8): append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md`),
      `${mode}: LOGGING routes the DROP at 1, 2, 6b and 8, not the whole of 6`);
    ok(dev.includes(`(create ${STATE}/gate/ if it does not exist) when no line there covers the finding yet:`),
      `${mode}: the DROP bullet appends a line only when no ledger line covers the finding yet`);
    ok(dev.includes(`in the DROP line format above, even when a SKIPPED line already covers the finding, its reason`),
      `${mode}: the ESCALATE default appends its ESCALATED line even when a SKIPPED line covers the finding`);
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
    const esc = flat(dev.slice(dev.indexOf('ESCALATE (7)'), dev.indexOf('Make THIS block correct')));
    ok(esc.includes(`append ONE terse line to ${STATE}/gate/DISMISSED-${id}.md`), `${mode}: case 7 writes the gate-scoped ledger`);
    ok(/ESCALATED: <the default you took/.test(esc), `${mode}: the line states the default taken`);
    ok(esc.includes(`the blind reviewer is NOT shown ${STATE}/DECISIONS.md`), `${mode}: with the reason attached`);
    ok(esc.includes(`You CANNOT proceed without the answer: append a FULL, self-contained entry to ${STATE}/question-${id}.md`)
      && esc.includes('and set needs_user=true'), `${mode}: the blocking branch of an unordered run writes the block's question file and stops`);
    ok(esc.includes(`You can proceed with a defensible default: append an entry to ${STATE}/DECISIONS.md (the choice, the options, the default you took and why), leave needs_user=false`),
      `${mode}: the proceeding branch writes DECISIONS`);
    ok(esc.includes(`Write to ${STATE}/question-${id}.md only a question the user must answer before a block can finish. Never write an informational note, a test observation, a chore or a default you took to it.`),
      `${mode}: the developer writes only questions to the question file`);
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
  // Acceptance reads a rewrapped prose hunk through a word diff, and the blind reviewer keeps its own sentence.
  const PROSE_HUNK_READ = 'Check a hunk that changes only prose, such as comments, string text or documentation, for changed words with `git -C E:/repo diff --word-diff=porcelain` and the arguments of the `git diff` command that showed it. A rewrap with no changed word needs no further read.';
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`acceptance ${id}`)).includes(PROSE_HUNK_READ), `${mode}: acceptance checks a prose-only hunk with a word diff`);
  }
  ok(!q.includes('--word-diff=porcelain'), 'the blind reviewer keeps its own word-diff sentence');
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
    ok(/Never open a plan file, an issue inventory, or any run-state path outside/.test(q)
      && /At the WRITE step, once your findings are final,\s+Read \S+ if it exists, so the Write tool accepts the overwrite, then replace its entire content\./.test(q)
      && !/Never use its content/.test(q)
      && !/Do NOT read prior review files/.test(q), `${mode}: the blind prompt's gate-folder read rule alone forbids prior review files`);
    ok(a !== '' && !/Do NOT read prior review files/.test(a), `${mode}: the acceptance prompt no longer does`);
    ok(flat(q).includes('Review the CURRENT diff FRESH, catching new or nearby issues.'), `${mode}: the blind prompt keeps the fresh-review sentence`);
    ok(!/re-verifying earlier fixes/.test(q + a), `${mode}: neither prompt keeps the re-verify clause`);
    eq(earlierList(a), '(none: no review in this run has flagged this block)', `${mode}: round 1 lists no earlier review file`);
    ok(flat(a).includes('A blind review that came back clean is never on this list, since it found nothing. '
      + "That includes this round's blind review, when one ran."),
      `${mode}: the earlier-findings step says a clean blind review found nothing`);
    ok(/an earlier finding that is neither closed\s+nor declined/.test(a), `${mode}: an open earlier finding counts as a gap`);
    // A closing edit can make a true sentence or record false, so a finding counts as closed only when its edit passes the REGRESSION step.
    ok(flat(a).includes('(a) the current code closes it, the edit that closes it breaks nothing under the REGRESSION step below, and a grep finds no sibling path')
      && flat(a).includes('Every other finding or gap counts as a gap.')
      && a.indexOf('EARLIER FINDINGS') < a.indexOf('REGRESSION: compare the unstaged diff'), `${mode}: a finding closed by an edit that fails the REGRESSION step is a gap`);
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
    + 'Read prior review files at your EARLIER FINDINGS step below.')),
    'every acceptance prompt keeps the fresh-review sentence and points at its EARLIER FINDINGS step');
  ok(accPrompts.every((p) => p.includes('At the WRITE step, Read the file it names if it exists, '
    + 'so the Write tool accepts the overwrite, then replace its entire content.') && !p.includes('never use its content')),
    'every acceptance prompt reads the WRITE step file at that step');
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

section('acceptance reproduces each amendment\'s defect, and judges an amended criterion against the AMENDED behavior only then');
// An amendment is the developer's claim that the plan prescribes a defect, so stating evidence is not enough to excuse a criterion.
{
  for (const [mode, id, r] of FRAMES) {
    const a = flat(r.prompt(`acceptance ${id}`));
    const [unit, unmet] = mode === 'fix' ? ['issue', 'that issue stays actually_fixed=false'] : ['criterion', 'that criterion stays UNMET'];
    const art = mode === 'fix' ? 'an' : 'a';
    ok(a.includes(`READ ${STATE}/AMENDED-${id}.md if it exists`), `${mode}: acceptance is told to read the record`);
    ok(a.includes(`Each amendment is the developer's claim. Before it excuses ${art} ${unit}, reproduce its defect yourself against the file:line it cites and the text it quotes, by reading that code and following the failure path it names, or by running the probe it names.`),
      `${mode}: acceptance reproduces each amendment's defect before it excuses anything`);
    ok(a.includes(`Judge ${art} ${unit} under an amendment you confirmed against the AMENDED behavior, not the superseded text`), `${mode}: and to judge against what was built`);
    ok(a.includes(`NAME every ${unit} you judged under an amendment in your review file`), `${mode}: each such ${unit} is named`);
    ok(a.includes(`An amendment whose defect you cannot confirm, or that states NO defect evidence, excuses NOTHING: ${unmet}.`), `${mode}: an unconfirmed or evidence-free amendment excuses nothing`);
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
    ok(flat(r.prompt(`develop ${id}`)).includes(REGRESSION_BULLET(mode, id)),
      `${mode}: the developer's MATRIX never drops a regression and fixes it at any tier`);
    ok(a.includes('the OVERRIDE rule above governs it'), `${mode}: a ledgered one falls to the OVERRIDE rule`);
    ok(a.includes(mode === 'fix' ? 'Drop any other concern silently, except a new issue (step 1).' : 'Drop any other concern silently.'),
      `${mode}: anything below the bar is dropped${mode === 'fix' ? ', except a new issue' : ''}`);
    ok(a.includes('Your file holds no notes, observations or non-blocking section.'), `${mode}: the review file has no uncounted section`);
    if (mode !== 'fix') continue;
    // The gap list ends in "drop silently", so a fail condition a step states but the list omits passes.
    ok(a.includes('an ACTIONABLE entry reported SKIPPED or left unreported, a touched entry'), 'fix: an ACTIONABLE entry reported SKIPPED or left unreported is a gap');
    ok(a.includes('a non-empty diff with no FIXED claim'), 'fix: a non-empty diff with no FIXED claim is a gap');
    ok(a.includes('a gate not satisfied, an earlier finding that is neither closed nor declined, a failed risk audit, or a regression'), 'fix: an unsatisfied gate, unavailable tool included, is a gap');
  }
}

section('acceptance lists what is not a regression from one rule, in every mode and under both policies, and the developer\'s SELF-REVIEW and SIBLINGS phases name the removed-defect exception and its zones');
// The developer's sibling rule removed a defect on a sibling path of a required fix, and acceptance counted that change as a regression.
{
  const otherZones = (zones) => Object.values(CHANGE_ZONES).filter((z) => z !== zones);
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
      const tag = policy.toUpperCase();
      const item = removedDefectItem(mode, tag, id, zones);
      const otherWording = mode === 'fix' ? REQUIRED_BY.feature : REQUIRED_BY.fix;
      ok(a.includes(`without ${REQUIRED_BY[mode]} requiring it. A change counts as required only when ${REQUIRED_BY[mode]} names that change. A break that a prescribed construction causes, which ${REQUIRED_BY[mode]} does not name, is not required, so it is a regression. Not a regression: - a test`) && !a.includes(`without ${otherWording} requiring it`),
        `${policy} ${mode}: the definition keeps this frame's requirement wording, then opens the "Not a regression" list`);
      ok(a.includes(item) && otherZones(zones).every((o) => !a.includes(removedDefectItem(mode, tag, id, o))),
        `${policy} ${mode}: the list holds the removed-defect item with its conditions and the zones a ${policy} ${mode} block may change: ${zones}`);
      ok(at('Not a regression:') < at(item) && at(item) < at('Every other such break or change is a regression.')
        && at('Every other such break or change is a regression.') < at('So is a comment or doc sentence that was true in the accepted baseline'),
        `${policy} ${mode}: the definition, then the list, then the rule that everything else counts`);
      ok((policy === 'proactive') === a.includes(`or a defect that a "PROACTIVE ${id}:" line in`),
        `${policy} ${mode}: the removed-defect item names a PROACTIVE line ${policy === 'proactive' ? 'and' : 'never'}`);
      ok((policy === 'focused') === a.includes(`or a defect that a "FOCUSED ${id}:" line in`),
        `${policy} ${mode}: the removed-defect item names a FOCUSED line ${policy === 'focused' ? 'and' : 'never'}`);
      ok(!a.includes(`- a behavior change that a "${tag} ${id}:" line in`), `${policy} ${mode}: no separate logged-fix item repeats the confirm rule`);
      const dev = flat(r.prompt(`develop ${id}`));
      ok(dev.includes(removedDefectExcuse(tag, zones)) && otherZones(zones).every((o) => !dev.includes(removedDefectExcuse(tag, o))),
        `${policy} ${mode}: the developer's SELF-REVIEW states acceptance's removed-defect excuse with acceptance's two scope conditions and the same zones`);
      ok(dev.includes(SIBLINGS_STEP),
        `${policy} ${mode}: the SIBLINGS phase fixes each sibling path the zone routing fixes, and leaves excluded and other-block code to a DISMISSED line`);
    }
  }
  const feature = passage(bus, 'block-a');
  const asBlockA = (text, id) => text.replace(`"FOCUSED ${id}:"`, '"FOCUSED block-a:"');
  const fixAsFeature = asBlockA(passage(fixBus, 'fix-a'), 'fix-a').replaceAll(REQUIRED_BY.fix, REQUIRED_BY.feature).replaceAll("an entry's **Fix:**", "this block's own text").replaceAll(CHANGE_ZONES.diffOnly, CHANGE_ZONES.changedFunction);
  ok(feature !== '' && asBlockA(passage(bus, 'block-b'), 'block-b') === feature && fixAsFeature === feature,
    'focused: every frame renders one passage, apart from the block id, the fix frame\'s ACTIONABLE-entry and **Fix:** wording, and its zones, which leave out a function that holds task code');
  ok(passage(proBus, 'block-a') !== '' && passage(proBus, 'block-b').replace('"PROACTIVE block-b:"', '"PROACTIVE block-a:"').replace('PULLED-block-b.md', 'PULLED-block-a.md') === passage(proBus, 'block-a'),
    'proactive: the feature and section frames render one passage, apart from the block id');
  ok(passage(proFixBus, 'fix-a') !== '' && passage(proFixBus, 'fix-a').replace('"PROACTIVE fix-a:"', '"FOCUSED fix-a:"').replace(` ${pulledRegressionItem('fix-a')}`, '') === passage(fixBus, 'fix-a'),
    'a fix block renders one passage under both policies, apart from the logged-fix tag and the proactive pulled-fix item');
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
  ok(String(none.out.nextStep ?? '').includes('each entry in E:/r/runs/t/DECISIONS.md if it exists, since each is a default the developer took, a plan amendment, or a fix'),
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
  eq(syncOf(parked.out), 'block-a=backlogged', 'a park over the round budget is backlogged');

  const halted = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_OK }, { ...baseArgs, ordered: true });
  eq(syncOf(halted.out), 'block-a=backlogged', 'an ordered needs-user halt is backlogged, since its entry holds its work, and block-b, never reached, has no edit');
  ok(halted.out.nextStep.includes('"Working the backlog" says, and build it before you relaunch the blocks after it.'), 'and its nextStep says to build that entry first');

  const ordered = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...baseArgs, ordered: true, maxRounds: 1 });
  eq(syncOf(ordered.out), 'block-a=backlogged', 'an ordered park stops the run, and the block after it has no edit');

  const regressed = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, regression: true } });
  eq(syncOf(regressed.out), 'block-a=blocked', 'staged with a self-reported regression is blocked, never done');

  const unsafe = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { ...PARK_OK, cleared: false } }, { ...ONE_BLOCK, maxRounds: 1 });
  eq(syncOf(unsafe.out), 'block-a=blocked', 'a park that left the tree unsafe is blocked, not backlogged');

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

  // Quality never clean, and the closing acceptance finds a blocking gap: the block parks, so no landing confirmed the STALE claim.
  const unchecked = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'STALE' }]),
    quality: FLAGGED, acceptance: FIX_GAP, park: PARK_OK,
  }, { ...FIX_ONE, maxRounds: 1 });
  eq(unchecked.labels.filter((l) => l.startsWith('acceptance')).join(), 'acceptance fix-a r2', 'only the closing acceptance ran, and it failed the block');
  eq(syncOf(unchecked.out), 'fix-a=backlogged,i-1=needs-attention,i-2=needs-attention',
    'a STALE entry in a block that parked is needs-attention, never stale');

  const parked = await run({
    develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FAILED' }]),
    quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK,
  }, { ...FIX_ONE, maxRounds: 1 });
  eq(syncOf(parked.out), 'fix-a=backlogged,i-1=needs-attention,i-2=needs-attention',
    'a parked block\'s FIXED entry is needs-attention: its fix sits on a branch, never landed');

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
// would drop the entry from the inventory while its fix sits on a branch nobody restored.
{
  const reports = {
    develop: firstRound(fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), fixDev([{ issue_id: 'i-1', status: 'STALE' }])),
    quality: firstRound(FLAGGED, CLEAN),
  };
  const parked = await run({ ...reports, acceptance: FIX_GAP, park: PARK_OK }, { ...FIX_ONE, maxRounds: 2 });
  eq(syncOf(parked.out), 'fix-a=backlogged,i-1=needs-attention', 'parked: needs-attention, never stale');
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
  eq(syncOf(failed.out), 'fix-a=backlogged,i-1=needs-attention,i-2=needs-attention',
    'a refuted STALE claim in a block that never lands is needs-attention, never stale');
  const passed = await run({ ...reports, acceptance: { ...FIX_PASS, fix_checks: refuted } }, FIX_ONE);
  ok(passed.out.ledger[0].contradicted === true, 'a pass carrying a refuted STALE check contradicts itself');
  eq(syncOf(passed.out), 'fix-a=done,i-1=fixed,i-2=needs-attention', 'and the refuted entry never syncs stale');
  const thin = await run({ ...reports, acceptance: FIX_PASS }, FIX_ONE);
  ok(thin.logs.some((l) => /THIN EVIDENCE \(1 check\(s\) for 1 claimed fix\(es\) and 1 stale claim\(s\)\)/.test(l)),
    'a pass with no check behind a STALE claim is flagged thin');
}

section('a lone fix block that holds a closed entry: it needs no report and its status sync leaves it as it is');
// Only a pass carries an `issues` filter, so a lone block's file hands the developer every entry, closed ones included.
{
  const { out, prompt } = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  eq(syncOf(out), 'fix-a=done,i-1=fixed', 'an entry the developer never reported gets no status edit, so a fixed one stays fixed');
  ok(prompt('acceptance fix-a').includes('entry, other than a closed one, that none of the FIXED, STALE, SKIPPED or FAILED lists names was left unreported'),
    'and acceptance does not fail it as left unreported');
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

section('every reviewer reads the diff by --stat, then file by file, and never runs the entire diff');
{
  const { prompt } = await run({ ...GREEN_RUN, develop: DEV_OK, quality: firstRound(FLAGGED, CLEAN) }, ONE_BLOCK);
  const fix = await run({ ...GREEN_RUN, develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), acceptance: FIX_PASS }, FIX_ONE);
  const prompts = [
    ['the blind reviewer', prompt('quality block-a r1')],
    ['feature acceptance', prompt('acceptance block-a')],
    ['fix acceptance', fix.prompt(`acceptance ${FIX_ONE.plans[0].id}`)]];
  for (const [name, text] of prompts) {
    const stat = text.indexOf('1. `git -C E:/repo diff --stat`.');
    const perFile = text.indexOf('2. `git -C E:/repo diff -- <file>` for each file it lists, one file per command.');
    const untracked = text.indexOf('3. `git -C E:/repo status --porcelain`, then READ every untracked file');
    ok(text !== '' && stat > -1 && stat < perFile && perFile < untracked, `${name}: the numbered reading order is --stat, per-file diff, untracked files`);
    ok(!/`git -C E:\/repo diff`/.test(text), `${name}: no unconditional full git diff`);
  }
  // A range read of a parked branch or of a risk round's snapshots overflows like the entire diff, so each names --stat or one file.
  const risk = await run({ develop: { ...DEV_OK, review_needed: false }, quality: CLEAN, acceptance: (label) => (/r[12]$/.test(label) ? ACC_FAIL : ACC_PASS) }, ONE_BLOCK);
  const rangeReads = [
    ['fix acceptance', fix.prompt(`acceptance ${FIX_ONE.plans[0].id}`), /git -C E:\/repo diff (?:--stat )?<branch>\^1 <branch>[^`,.]*/g],
    ['a risk round acceptance', risk.prompt('acceptance block-a r3'), /git -C E:\/repo diff (?:--stat )?<base> <snapshot>[^`,.]*/g]];
  for (const [name, text, pattern] of rangeReads) {
    const reads = flat(text).match(pattern) ?? [];
    ok(reads.length > 0, `${name}: renders a range diff command`);
    ok(reads.every((c) => /^git -C E:\/repo diff --stat /.test(c) || / -- <file>/.test(c)), `${name}: every range diff command is --stat or one file`);
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
  ok(/Of the gates, run only the test command, and only for ONE targeted test that confirms a suspected defect\./.test(r1),
    'of the gates, only the test command runs, for one targeted test');
  ok(flat(r1).includes(`Any other command that writes nothing in the repo, such as a tool's check mode, and a probe script in a temporary folder outside the repo and outside the folder that holds ${STATE}/gate/ are allowed.`),
    'any other command that writes nothing and a probe script outside the repo and the folder holding gate/ are allowed');
  ok(r1.indexOf('test:  t\n') < r1.indexOf('Any other command that writes nothing'), 'the allowance follows the gate command list, so it excludes the gate commands');
  ok(/anything that breaks the\s+build or tests/.test(r1), 'a build or test break stays a defect class');
  ok(/READ every untracked file \(`\?\?`\)/.test(r1) && !/`\?\?`\/`A`/.test(r1), 'new files are the untracked ?? entries, not a staged A');
  ok(/staged half of an `AM` or `MM` file is baseline/.test(r1), 'an AM/MM file\'s staged half is baseline');
  ok(/diff --stat/.test(r1), 'a large diff starts from --stat');
  const absentLedger = 'It exists only once the developer has declined something, so a missing file or folder means nothing is settled yet. Do not search for it elsewhere.';
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
  ok(sweepText.includes(`Before step 1, READ ${STATE}/DECISIONS.md and every ${STATE}/AMENDED-<id>.md (list ${STATE}/ to find them), each only if it exists. An escalated default in ${STATE}/DECISIONS.md records a choice routed to the user and the default the developer took, and you hold it as acceptance holds it. Unless the reason it gives is false, a goal hit it covers is no gap. Every other line and amendment records a developer's claim, which excuses a goal hit only once you confirm it against the code.`)
    && sweepText.indexOf('Before step 1, READ') < sweepText.indexOf('PROCEDURE') && !sweepText.includes('never a gap'),
    'the sweep reads the decisions and amendments before step 1, holds an escalated default, and confirms each other claim before it excuses a goal hit');
  ok(sweepText.includes('Where a block\'s text explicitly excludes something the goal line covers, the block\'s text decides. A goal hit that no block\'s text names or excludes is still a gap.'),
    'an explicit exclusion in a block\'s text decides, and a goal hit no block names or excludes stays a gap');
}

section('the fix developer is never asked to count its entries');
// plan-block --list rejects a todo fix block with no entry, so a count the developer reports would guard nothing.
{
  const fixed = fixDev([{ issue_id: 'i-1', status: 'FIXED' }]);
  const rounds = await run({ develop: fixed, quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS }, FIX_ONE);
  const devs = rounds.calls.filter((c) => c.label.startsWith('develop fix-a'));
  eq(devs.length, 2, 'rounds 1 and 2 ran');
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

section('park stops only when the tree holds work it cannot commit; a tree with no work is not a stop');
{
  const { prompt } = await run({ ...GREEN_RUN, acceptance: { ...ACC_PASS, pass: false, staged: false, gap_count: 1 }, park: PARK_OK }, { ...baseArgs, maxRounds: 1 });
  const pk = flat(prompt('park'));
  ok(pk.includes('SAVE BEFORE YOU CLEAR. If the tree holds this block\'s work and step 1 cannot make its commit, STOP: leave the tree exactly as it is, skip steps 2 and 3, and return saved=false, cleared=false, commit_sha "" and entry_written=false.'),
    'the STOP rule is scoped to a tree that holds work');
  ok(pk.includes('A tree that holds no work of this block is not a stop: step 1 says what to do.'), 'and a tree with no work follows step 1\'s tree check');
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
  eq(out.status, 'BLOCKED (the staged index may hold work no reviewer read: the developer did not confirm its work stayed unstaged, or acceptance found the index changed outside acceptance)',
    'the staging halt wins over the unordered needs-user park');
  ok(!labels.some((l) => /block-b/.test(l)), 'block-b never started');
  ok(/also escalated a user-only decision \(see E:\/r\/runs\/t\/question-block-a\.md\)/.test(out.haltReason), 'the halt reason also names the escalation');
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
  ok(prompt('park').includes('acceptance rejected the block but staged it anyway; inspect `git -C E:/repo diff --cached c0ffee0000000000000000000000000000000001`'),
    'park is told the real cause and the tree from before the rejected staging');
  ok(!labels.some((l) => /block-b/.test(l)), 'block-b never started');
  eq(out.ledger[0].status, 'BLOCKED (acceptance staged a rejected block)', 'ledger status');
}
{
  // The index holds block-a's accepted work, so the recovery diffs against the tree block-a's acceptance recorded,
  // never the tree the rejecting acceptance reported after it staged.
  const accepted = 'b0b0000000000000000000000000000000000002';
  const rejected = 'bad0000000000000000000000000000000000003';
  const { out, logs, prompt } = await run({
    develop: DEV_OK,
    quality: CLEAN,
    acceptance: (label) => (label.includes('block-a') ? { ...ACC_PASS, index_tree: accepted } : { ...ACC_FAIL, staged: true, index_tree: rejected }),
    park: PARK_OK,
  });
  const view = `git -C E:/repo diff --cached ${accepted}`;
  ok(String(out.haltReason ?? '').includes(`Inspect \`${view}\` and unstage this block's files before resuming.`),
    `the halt reason diffs against the tree before the rejected staging: ${String(out.haltReason ?? '').slice(0, 300)}`);
  ok(logs.some((l) => l.includes(`staged it → halting (inspect ${view})`)), 'the log line names the same view');
  ok(prompt('park:block-b').includes(`acceptance rejected the block but staged it anyway; inspect \`${view}\``), 'and so does the park reason');
  ok(![String(out.haltReason ?? ''), prompt('park:block-b')].some((t) => t.includes(rejected)), 'no recovery names the rejected tree');
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
// Either may leave work in the tree or on the block's branch, so "nothing to restore" could send the
// operator past it.
{
  const notCleared = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: { saved: false, cleared: false, gates_green: true, commit_sha: '', entry_written: false } }, { ...ONE_BLOCK, maxRounds: 1 });
  ok(!/nothing to save/i.test(notCleared.out.nextStep), 'an uncleared park never says nothing to save');
  ok(notCleared.out.nextStep.includes(`Park did NOT confirm a save or a clear for: block-a (${UNFINISHED('block-a')}). Their work may still be in the working tree or on that branch: inspect both`),
    'nextStep says to inspect the tree and the branch');
  ok(!notCleared.logs.some((l) => /work saved to nothing to save/.test(l)), 'an uncleared park log line does not claim nothing to save');
  ok(notCleared.logs.some((l) => /work saved to nowhere: park confirmed no save or clear/.test(l)), 'the log line says park confirmed neither');

  for (const [what, park] of [['saved', { saved: true, cleared: false, gates_green: true, commit_sha: 'd1e2f3a4b5c60718293a4b5c6d7e8f9012345678', entry_written: true }], ['contradictory', { saved: false, cleared: false, gates_green: true, commit_sha: 'd1e2f3a4b5c60718293a4b5c6d7e8f9012345678', entry_written: true }]]) {
    const { out } = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park }, { ...ONE_BLOCK, maxRounds: 1 });
    ok(!/SAVED and cleared/.test(out.nextStep), `${what}: a committed park that did not clear never reads as cleared`);
    ok(/Work SAVED but NOT cleared from the tree for: block-a/.test(out.nextStep), `${what}: nextStep says the tree still holds it`);
  }

  const dead =await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: null }, { ...ONE_BLOCK, maxRounds: 1 });
  eq(dead.out.status, 'BLOCKED (a parked block left the tree unsafe)', 'a dead park is still unsafe');
  ok(dead.out.haltReason.includes(`park agent for block block-a returned nothing (skipped or died), so whether its work is on the branch ${UNFINISHED('block-a')} or still in the working tree is unknown: inspect both`),
    'the reason says the outcome is unknown');
  ok(!/nothing to save/i.test(dead.out.nextStep), 'nextStep never says nothing to save');
  ok(/Park did NOT confirm a save or a clear for: block-a/.test(dead.out.nextStep), 'and name the block to inspect');
  ok(!dead.logs.some((l) => /work saved to nothing to save/.test(l)), 'the park log line does not claim nothing to save');

  const empty = await run({ develop: { ...DEV_OK, needs_user: true }, park: PARK_EMPTY }, ONE_BLOCK);
  ok(/NO work was saved for: block-a/.test(empty.out.nextStep), 'a confirmed-clear empty park still reads as nothing to save');
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

section('conventionFiles reach the developer, the blind reviewer and acceptance, and a bad value throws');
// The distilled conventions text is an index, so each agent reads the project's own instruction files in full.
{
  const HEAD = "CONVENTION FILES (the project's own rules, which the CONVENTIONS text above indexes. Read each one in full, whatever any rule below limits your reads to):";
  const none = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, ONE_BLOCK);
  for (const label of ['develop block-a', 'quality block-a', 'acceptance block-a']) {
    ok(!none.prompt(label).includes('CONVENTION FILES'), `without the arg, the ${label} prompt carries no section`);
  }
  const set = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, { ...ONE_BLOCK, conventions: 'c', conventionFiles: [' CLAUDE.md', 'src\\CLAUDE.md', ' E:/home/.claude/CLAUDE.md '] });
  for (const label of ['develop block-a', 'quality block-a', 'acceptance block-a']) {
    ok(set.prompt(label).includes(`${HEAD}\n  - E:/repo/CLAUDE.md\n  - E:/repo/src/CLAUDE.md\n  - E:/home/.claude/CLAUDE.md\n`),
      `the ${label} prompt lists each file trimmed, a relative one resolved against target.repo`);
  }
  for (const bad of ['CLAUDE.md', [''], ['CLAUDE.md', 3], {}]) {
    const msg = await throwsWith(ENGINE, { args: { ...ONE_BLOCK, conventionFiles: bad } });
    ok(msg.startsWith('Invalid args.conventionFiles: it must be an array of file paths') && msg.includes(JSON.stringify(bad)),
      `conventionFiles ${JSON.stringify(bad)} throws naming the value: ${msg.slice(0, 120)}`);
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
      ok(q.includes('Before you skip a listed finding, check its stated reason against the code it cites. When the code contradicts a reason, at any tier, raise the finding ONCE, prefixed "CONTESTS DISMISSAL:", citing the file:line that contradicts it.'),
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
    ok(q.includes('the input or path and the harm (for a finding at medium or above), and a fix direction you checked against the code it would change.'),
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
  ok(!/every finding and gap in \S*quality-review-block-a-r1\.md/.test(q.prompt('park:block-a')), 'quality: park never copies the gaps of the unwritten file');

  const a = await run({ ...GREEN_RUN, acceptance: { ...ACC_FAIL, wrote_file: false }, park: PARK_OK });
  eq(a.out.status, 'BLOCKED (a reviewer failed a block without confirming its review file)', 'acceptance: status');
  ok(!/check/i.test(a.out.status) && /Check whether that file exists before resuming/.test(a.out.haltReason),
    'acceptance: the check instruction lives in the halt reason, not the status');
  ok(/Acceptance verifier for block block-a failed the block in round 1 but did not confirm writing .*acceptance-review-block-a-r1\.md/.test(a.out.haltReason), 'acceptance: the reason names the file');
  ok(!a.labels.includes('develop block-a r2'), 'acceptance: no developer is sent to it');

  const fixA = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: { ...FIX_GAP, wrote_file: false }, park: PARK_OK }, FIX_ONE);
  eq(fixA.out.ledger[0].status, 'backlogged (review file not written)', 'fix-mode acceptance halts the same way, and its backlogged park shows in the ledger row');
  ok(syncOf(fixA.out).startsWith('fix-a=backlogged'), 'and its plan status is backlogged');

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
  const why = "Round numbers count develop rounds, so a later stage has no file for a round that an earlier stage sent back. A round with no blind review has no blind review file. A round file of this block that this prompt does not name may come from an earlier launch of the block, so ignore it.";
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
    ok(acc.includes('covers, or (b)') && acc.includes('Every other finding or gap counts as a gap.')
      && !acc.includes(`that no line in ${ledger} covers keeps the same mechanism`),
      `${mode}: the gap rule counts every finding that neither (a) nor (b) settles, with no restated sibling-path list`);
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
        ok(dev.includes(fullSuite) && !dev.includes("Judge only THIS block's scoped tests"),
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
    ok(dev.includes(REGRESSION_BULLET(mode, id)) && !dev.includes('the acceptance review counted or your SELF-REVIEW found'),
      `${mode}: the matrix covers a regression a review names once the developer confirms it, and fixes a prescribed one under 6a or parks the block when it changes the user's choice`);
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
  const takenRules = 'An entry of this block that carries a "- pulled:" line counts as not ACTIONABLE, since another block\'s developer took it. An entry of this block that carries a line that starts with "**Parked with:**" counts as not ACTIONABLE too, since the code it names sits on that block\'s branch or is not built yet.';
  const closedRule = 'An entry of this block whose "- status:" reads fixed or stale was closed by an earlier run. In every step below the developer works no such entry and returns no result for it, and acceptance does not count one as left unreported.';
  const fixScope = `Fix each one as its **Fix:** line instructs, once VERIFY-FIRST has checked that line, minimally and surgically. Change nothing on behalf of an entry that is not ACTIONABLE, in any zone. ${takenRules} ${closedRule} ${scopeLine.fix}`;
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
  const close = 'Make THIS block correct, testable and production-safe, make the fixes the ZONE ROUTING allows, and touch nothing else. Return ONLY the decision fields';
  const contest = '• A finding a reviewer RE-RAISED as "CONTESTS DISMISSAL": do NOT re-drop it — FIX it, or if it is truly a user-only call, ESCALATE it. A contested pre-existing finding that the ZONE ROUTING above does not fix goes to 7, with the default of leaving it unchanged, since that routing bounds every change you make. NEVER log the same dismissal twice.';
  const FIX_NOUN = 'fix of a defect already in the accepted baseline';
  const loggedFixRule = (tag, id, mode) => `${tag} (this run's change policy): append ONE line to ${STATE}/DECISIONS.md for each ${FIX_NOUN} that you made, in any zone, without ${REQUIRED_BY[mode]} requiring it, and that no earlier round logged, naming its file:line, what changed and why: \`${tag} ${id}: <file:line> — <what changed> — <why>\``;
  const lastItems = (mode, tag, id, zones) => `${removedDefectItem(mode, tag, id, zones)}${tag === 'PROACTIVE' ? ` ${pulledRegressionItem(id)}` : ''} Every other such break or change is a regression.`;
  const step4 = '4. REGRESSION: compare the unstaged diff against the accepted baseline. Confirm that no previously-accepted behavior was changed or broken, apart from a change that meets an item of the "Not a regression" list above.';
  const settled = (tag, policy) => `${STATE}/DECISIONS.md — defaults the developer took, plan amendment pointers, and one line per ${FIX_NOUN} that this run's ${policy} change policy let the developer make, a record. A ${tag} line is never skipped for its stated reason, since the regression rule below judges each one.`;
  const decisionsNext = (tag, policy) => `each entry in ${STATE}/DECISIONS.md if it exists, since each is a default the developer took, a plan amendment, or a ${FIX_NOUN} that the ${policy} change policy allowed. Show a ${tag} line only after you confirm the landed code still holds its change, since a later round or a park can undo it`;

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
      ok(dev.includes(REGRESSION_BULLET(mode, id)), `${where}: the MATRIX's regression bullet fixes a regression at any tier`);
      ok(dev.includes(`${REGRESSION_DEF} After the blind review`), `${where}: the SELF-REVIEW defines a regression, a falsified comment or doc sentence included`);
      ok(dev.includes(loggedFixRule(tag, id, mode)) && !dev.includes(`${otherTag} (this run`), `${where}: each fix of a defect already in the accepted baseline that ${REQUIRED_BY[mode]} does not require gets one ${tag} line in DECISIONS`);
      ok(dev.includes(removedDefectExcuse(tag, zones)) && !dev.includes(otherTag), `${where}: the SELF-REVIEW states acceptance's logged-fix excuse in the zones acceptance names, and no other tag`);
      ok((policy === 'proactive') === dev.includes('Nor does it count a change that closes the defect of a pulled backlog entry and alters no other behavior.'),
        `${where}: the SELF-REVIEW ${policy === 'proactive' ? 'states' : 'leaves out'} acceptance's pulled-fix excuse`);
      ok((policy === 'focused' || mode === 'fix') === dev.includes('minimally and surgically'), `${where}: ${policy === 'focused' || mode === 'fix' ? 'the build is minimal and surgical' : 'no "minimally and surgically"'}`);
      ok(dev !== '' && !dev.includes('a little better'), `${where}: no closing line asks to leave touched lines a little better`);
      const acc = flat(r.prompt(`acceptance ${id}`));
      ok(acc.includes(settled(tag, policy)), `${where}: acceptance's DECISIONS entry says it also holds the ${tag} lines`);
      if (mode === 'fix') {
        ok(dev.includes('Leave every other entry (SKIP, NEEDS_USER, DEFER, an entry with a "- pulled:" line or a line that starts with "**Parked with:**", anything else but a closed entry) UNTOUCHED'),
          `${where}: the developer leaves a held parked-with entry untouched`);
        ok(dev.includes(closedRule) && acc.includes(closedRule) && dev.includes('For EACH ACTIONABLE entry that is not closed, read the CURRENT code'),
          `${where}: the developer and acceptance both skip an entry whose status reads fixed or stale`);
        ok(acc.includes(takenRules) && acc.includes('or that it carries a "- pulled:" line or a line that starts with "**Parked with:**": an'),
          `${where}: fix acceptance counts a parked-with entry as not ACTIONABLE, and confirms it was reported SKIPPED`);
      }
      ok(acc.includes(lastItems(mode, tag, id, zones)) && !acc.includes(otherTag),
        `${where}: the removed-defect item excuses a ${tag}-logged fix of a defect only in unclaimed code and ${zones}`);
      ok(acc.includes('escalates it when only a change in other code closes it. Once'), `${where}: acceptance names other code as the escalation's limit`);
      ok(!acc.replace(DECISION_RULE, '').includes('refactor'), `${where}: acceptance excuses no refactor`);
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
  const fixesConnected = 'Fix a pre-existing defect there when its fix is low risk under the RISK QUESTIONS below, which you answer for that fix before you write any code for it, and leave every other pre-existing finding there unchanged.';
  const sameFunctionFix = 'Fix a pre-existing defect there that lies in a function or method that holds task code, when its fix is low risk under the RISK QUESTIONS below, which you answer for that fix before you write any code for it, and leave every other pre-existing finding there unchanged.';
  const keepsConnected = 'Leave every pre-existing finding there unchanged.';
  const connectedRule = (policy, mode) => (mode === 'fix' ? keepsConnected : policy === 'proactive' ? fixesConnected : sameFunctionFix);
  const routingTail = "- Other code: leave it unchanged. Close a finding the diff introduces or exposes there, such as a build break or a regression, at its source in task or connected code. When only a change in other code closes it, ESCALATE it (7). Hunt only in task code. Read connected code to check your change's effects, and route what you notice there by these rules. A fix still follows the DECISION MATRIX's rules for a plan conflict (6a, 6b) and a user-only choice (7). Rule 2 of the DECISION MATRIX drops each pre-existing finding these rules do not fix, and RECORD below says which of them get a backlog entry.";
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
      const zoneMap = CODE_ZONES(mode, policy);
      const dev = flat(r.prompt(`develop ${id}`));
      const acc = flat(r.prompt(`acceptance ${id}`));
      const q = flat(r.prompt(`quality ${id}`));
      ok(count(dev, zoneMap) === 1 && count(acc, zoneMap) === 1,
        `${where}: the developer and acceptance prompts each render the one zone map once, with this mode's task code: ${taskCode(mode, policy)}`);
      ok((policy === 'proactive') === acc.includes(PULLED_TASK_CODE), `${where}: a pulled entry's fix is task code ${policy === 'proactive' ? 'under proactive' : 'only under proactive'}`);
      ok(q !== '' && !q.includes('CODE ZONES') && !q.includes('ZONE ROUTING'), `${where}: the blind reviewer sees no zone, since task code names the block's required changes`);
      ok(dev.indexOf(zoneMap) < dev.indexOf(routing(policy)) && dev.indexOf(routing(policy)) < dev.indexOf('PROCEDURE: '),
        `${where}: the developer reads the zone map, then the zone routing, before its phases`);
      ok(acc.indexOf(zoneMap) >= 0 && acc.indexOf(zoneMap) < acc.indexOf('A regression is any behavior') && !acc.includes('ZONE ROUTING'),
        `${where}: acceptance reads the zone map just before the regression rule, and no routing`);
      const rule = connectedRule(policy, mode);
      ok(dev.includes(`${routing(policy)} ${rule} ${routingTail}`)
        && [fixesConnected, keepsConnected, sameFunctionFix].filter((r) => r !== rule).every((r) => !dev.includes(r)),
        `${where}: connected code takes a fix of a defect the diff introduces or exposes, and of a pre-existing one only ${mode === 'fix' ? 'never' : policy === 'proactive' ? 'when its fix is low risk' : 'in a function or method that holds task code when its fix is low risk'}, and other code takes none, a break the diff causes there closed at its source or escalated`);
      for (const [label, text] of [['developer', dev], ['acceptance', acc], ['blind reviewer', q]]) {
        const named = RETIRED.filter((s) => text.includes(s));
        ok(text !== '' && named.length === 0, `${where}: the ${label} prompt names no per-policy bound or past-reach permission${named.length ? `: ${named.join(' | ')}` : ''}`);
      }
    }
  }
  // No develop round follows the closing pass, so its routing must match the rounds' routing.
  const closing = await run({ develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS), park: PARK_OK },
    { ...ONE_BLOCK, maxRounds: 1, changePolicy: 'proactive' });
  const closer = flat(closing.prompt('develop-closing block-a'));
  ok(count(closer, CODE_ZONES('feature', 'proactive')) === 1 && closer.includes(`${routing('proactive')} ${fixesConnected} ${routingTail}`),
    'the closing pass renders the same zone map and routing');
}

section('the developer opens its scope rules with one stance paragraph per policy, and three prompts carry the tools sentence');
// The stance reads before the zone routing it points to, and the focused same-function rule reaches acceptance in the same words.
{
  const count = (text, x) => text.split(x).length - 1;
  const STANCE = {
    proactive: 'You own the work you touch. Fix each defect in it and in the code around it as far as the ZONE ROUTING below allows.',
    focused: 'Make the smallest change that does the task, as a contractor in code that others depend on.',
  };
  const TOOLS = 'Use the tools you have, such as web search or a browser, to check how something behaves, and run the project to see a change working when the project says how to run it and the run writes nothing in the repo.';
  for (const [policy, frames] of Object.entries(FRAMES_BY_POLICY)) {
    const other = policy === 'focused' ? 'proactive' : 'focused';
    for (const [mode, id, r] of frames) {
      const where = `${policy} ${mode}`;
      const dev = flat(r.prompt(`develop ${id}`));
      const acc = flat(r.prompt(`acceptance ${id}`));
      const q = flat(r.prompt(`quality ${id}`));
      ok(count(dev, STANCE[policy]) === 1 && !dev.includes(STANCE[other]) && dev.indexOf(STANCE[policy]) < dev.indexOf('ZONE ROUTING - what'),
        `${where}: the developer prompt holds the ${policy} stance once, above the zone routing, and not the ${other} stance`);
      for (const [label, text] of [['developer', dev], ['blind review', q], ['acceptance', acc]]) {
        ok(count(text, TOOLS) === 1, `${where}: the ${label} prompt holds the tools sentence once`);
      }
      const sameFunction = 'lies in a function or method that holds task code';
      const expected = policy === 'focused' && mode !== 'fix';
      ok(expected === dev.includes(sameFunction) && expected === acc.includes(sameFunction),
        `${where}: the developer's routing and acceptance's regression rule ${expected ? 'both' : 'neither'} name the function or method that holds task code`);
    }
  }
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
  ok(!later.prompt('develop block-a r2').includes('Report baseline_dirty_files=-1'), 'a later round is not told to report -1 for the round-1 fields');
  const laterSchema = schemaOf(later, 'develop block-a r2');
  ok(!laterSchema.required.includes('baseline_staged_files') && !('baseline_staged_files' in laterSchema.properties), 'a later round declares no staged count');
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
  const closingCommit = await run({ ...C_RUN,
    develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_C, review_needed: false, recorded_entries: [] } : DEV_C),
    acceptance: firstRound({ ...ACC_FAIL, committed: false, commit_sha: '', commit_subject: '', tree_matches: false, tree_clean: true }, { ...ACC_C, backlog_entries: 1, backlog_blocks: ['block-a'] }) },
  { ...COMMIT_ONE, maxRounds: 1 });
  eq(`${syncOf(closingCommit.out)} ${closingCommit.out.ledger[0].status}`, 'block-a=done done (committed, and the closing acceptance left 1 backlog entry)',
    'a closing acceptance that commits the block names the entries it left in the committed status');
  ok(r.logs.some((l) => l.includes(`acceptance PASSED — COMMITTED ${SHA}`)), 'the pass log line names the commit');
  ok(r.logs.some((l) => l.startsWith('develop: 1/1 block(s) to build') && l.endsWith(', commit=true]')), 'the launch line names commit mode');
  const next = nextOf(r.out);
  ok(next.includes(`Committed: block-a (${SHA}).`) && next.endsWith('Nothing is staged.') && !next.includes('Nothing is committed') && !next.includes('Staged/accepted'),
    'nextStep names the commit and says nothing is staged');
  ok(next.includes('Land the run with `wt.mjs close`') && !next.includes('show --stat') && !next.includes('diff --cached --stat'),
    'and sends the operator to land the run, not to view the commits');
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
  ok(nextOf(r.out).includes('Accepted with no commit of their own: block-a.') && !nextOf(r.out).includes('Committed:'), 'nextStep says the block made no commit');
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
  // A diff against the tree before a rejected commit would list that commit's hunks as staged.
  ok(r.prompt('park').includes("inspect `git -C E:/repo diff --cached` and `git -C E:/repo log -1`, then unstage this block's files"),
    'the commit-mode park reason diffs the index against HEAD, never against the tree before the rejected commit');
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
    && reason.includes('`git -C E:/repo diff --cached --stat` lists any files it staged') && !reason.includes('nothing was staged')
    && reason.includes('Run `git -C E:/repo log -1 --stat` before you pick the route the held-park rule gives this block.') && !reason.includes('flip the block to todo')
    && reason.includes('Work that commit holds is in the branch\'s first parent, HEAD, so it is outside the park\'s branch diff, and that branch then does not hold all of the block\'s work.')
    && reason.includes('Work it only staged is inside the branch\'s diff.') && !reason.includes('the staged index'),
    'commit mode: the reason names the last commit, the revert and the staged check');
  const first = await run({ ...C_RUN, acceptance: null, park: PARK_OK }, COMMIT_ONE);
  ok(String(first.out.haltReason ?? '').includes('HEAD before this block was the HEAD this launch started from'), 'commit mode: the first block names the launch HEAD');
  const stage = await run({ ...GREEN_RUN, acceptance: null, park: PARK_OK });
  ok(String(stage.out.haltReason ?? '').includes("It may have staged the block's files before it died: check `git -C E:/repo diff --cached c0ffee0000000000000000000000000000000001 --stat` for them before you pick the route the held-park rule gives this block. Any such work is in the branch's first parent, the staged index, so it is outside the park's branch diff")
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
  ok(pk.includes('Only acceptance commits on HEAD\'s branch, and only a block it accepted.') && !pk.includes('Nothing is EVER committed'),
    'commit-mode park commits nothing on HEAD\'s branch');
  const dirty = String((await run({ develop: { ...DEV_C, baseline_dirty_files: 2 } }, COMMIT_ONE)).out.haltReason ?? '');
  ok(!dirty.includes('to KEEP it') && dirty.includes('without touching HEAD, which holds every accepted block as a commit')
    && dirty.includes('Never `git add -A` it or commit it'), 'the commit-mode dirty-baseline halt sets the dirt aside and never commits it');
  const unconfirmed = String((await run({ develop: { ...DEV_C, unstaged_confirmed: false }, park: PARK_OK }, COMMIT_ONE)).out.haltReason ?? '');
  ok(unconfirmed.includes("acceptance's commit takes whatever is staged") && !unconfirmed.includes('diff --staged` as the accepted baseline'),
    'the commit-mode staging halt names the commit that would carry self-staged work');
  const unstaged = String((await run({ ...C_RUN, acceptance: { ...ACC_C, staged: false, committed: false, commit_sha: '', commit_subject: '' } }, COMMIT_ONE)).out.haltReason ?? '');
  ok(unstaged.includes("and commit them with the block's title as the entire message"), 'the commit-mode passed-unstaged halt says to commit as well as stage');
  const none = await run({}, { ...COMMIT_ONE, plans: [{ ...C_BLOCK, status: 'done' }] });
  ok(nextOf(none.out).includes('land it with `wt.mjs close` once the develop guide says the run lands') && !nextOf(none.out).includes('run the full gates') && !nextOf(none.out).includes('and commit.'),
    'the commit-mode nothing-to-run terminal lands a held run with wt.mjs close and never says to re-run the gates or to commit');
}

// ---------------------------------------------------------------------------------------------
// A relaunch with the same runId finds the earlier launch's round files
// ---------------------------------------------------------------------------------------------
section('every develop prompt that writes a round file says to Read an earlier launch\'s file first, and a rejected write is not a write');
{
  const feat = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, { ...ONE_BLOCK, sweep: 'goal-coverage', goal: 'g' });
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  const commit = await run(C_RUN, COMMIT_ONE);
  const park = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 });
  // The risk tool has written the file before the developer writes it, so its read takes its own sentence.
  const RISK_READ = 'The command leaves the file in place, so Read it, then replace its entire content.';
  for (const [what, p] of [['the developer', feat.prompt('develop block-a r1')], ['the proactive developer', proBus.prompt('develop block-a r1')]]) {
    eq(flat(p).split(RISK_READ).length - 1, 1, `${what}: the risk file's read step says the command left the file in place`);
  }
  const sites = [
    ['the developer prompt', flat(feat.prompt('develop block-a r1')), 0, 0],
    ['the proactive developer PULLED file', flat(proBus.prompt('develop block-a r1')), 1, 0],
    ['the blind quality file', flat(feat.prompt('quality block-a r1')), 1, 1],
    ['the feature-mode acceptance file', flat(feat.prompt('acceptance block-a r1')), 1, 1],
    ['the fix-mode acceptance file', flat(fix.prompt('acceptance fix-a r1')), 1, 1],
    ['the sweep file', flat(feat.prompt('final-sweep')), 1, 1],
    ['the commit message file', flat(commit.prompt('acceptance block-a r1')), 2, 1],
    // The park replaces its commit-message file and appends its backlog entry, attesting the append.
    ['the park message file and backlog entry', flat(park.prompt('park:block-a')), 1, 1],
  ];
  pinWriteNotes(sites);
}

// ---------------------------------------------------------------------------------------------
// Every develop agent checks what it is handed, and every handoff file is current
// ---------------------------------------------------------------------------------------------
section('the developer confirms each review finding, suggested fix and Fix line before it acts on one');
// A reviewer and a fix entry each make claims another agent wrote, so the developer checks them against the code.
{
  const REVIEW_CLAIMS = "A review is another agent's claim. For each finding and gap, confirm it yourself against the current code, by reading the place it cites and following the input or path it names, or by running the check it names. A finding you refute is dropped under the DECISION MATRIX's false-positive rule (1), with the file:line that refutes it. Its suggested fix is a hint, never an instruction. Before you apply any part of it, check it against the text it changes, the block's text and every sibling text that must agree with it, such as other call sites, the same string or rule elsewhere, and the docs that describe the behavior. Confirm any command, flag or behavior it relies on that the repo does not already use the same way. Build the fix that closes the confirmed cause, which may differ from the suggestion. A finding raised as \"CONTESTS DISMISSAL\" follows the DECISION MATRIX's rule for a contested dismissal, never rule 1.";
  const rework = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, ONE_BLOCK);
  ok(flat(rework.prompt('develop block-a r2')).includes(REVIEW_CLAIMS), 'a round that answers a review confirms each finding and treats its fix as a hint');
  ok(!flat(rework.prompt('develop block-a r1')).includes("A review is another agent's claim."), 'round 1, which answers no review, carries no such rule');
  // A refuted finding would otherwise be re-dropped against the contested-dismissal bullet and logged against the risk-gap note.
  ok(flat(rework.prompt('develop block-a r2')).includes(`${REVIEW_CLAIMS} A gap for a wrong risk answer, for a sweep line that is missing, leaves out a hit the change left wrong, or disagrees with the change, or for a path that changed after its round's snapshot, takes no fix and no log`),
    'the risk-gap rule follows the claim check');
  ok(!flat(rework.prompt('develop block-a r2')).includes('follows its own rule below'), 'the review rework states the risk-gap rule once, in its own sentence');
  const closing = await run({ develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK),
    quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, { ...ONE_BLOCK, maxRounds: 1 });
  ok(flat(closing.prompt('develop-closing block-a')).includes(`your work list. Route each item through the DECISION MATRIX below. ${REVIEW_CLAIMS} Where the matrix says FIX`),
    'the closing pass confirms the last review\'s findings the same way');
  ok(!flat(closing.prompt('develop-closing block-a')).includes('follows its own rule below'), 'the closing pass states the risk-gap rule once, in its own sentence');
  const fixRework = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: firstRound(FLAGGED, CLEAN), acceptance: FIX_PASS }, FIX_ONE);
  const fixR1 = flat(fixRework.prompt('develop fix-a r1'));
  ok(flat(fixRework.prompt('develop fix-a r2')).includes(REVIEW_CLAIMS), 'a fix round that answers a review carries the rule too');
  ok(fixR1.includes("Once you confirm an entry's issue exists, read its **Fix:** line as a suggested fix. Before you apply any part of it, check it against the text it changes, the block's text and every sibling text that must agree with it")
    && fixR1.includes('A **Fix:** line you verify is defective goes under DECISION MATRIX rule 6a.'),
    'VERIFY-FIRST checks each Fix line, and a defective one goes under 6a');
  ok(fixR1.includes('Fix each one as its **Fix:** line instructs, once VERIFY-FIRST has checked that line,'),
    'the instruction to follow a Fix line is subject to that check');
}

section('the fix developer and fix acceptance are told an entry carries the evidence a review confirmed');
// debug's verifier removes its probe directory, so the entry's Evidence line is the only record of what it confirmed.
{
  const fixRun = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE);
  const dev = flat(fixRun.prompt('develop fix-a r1'));
  ok(dev.includes('each with its own `- decision:` line, a **Fix:** instruction and, from a review, an **Evidence:** line.'), 'the developer\'s inventory line names the Evidence line');
  ok(dev.includes("An entry's **Evidence:** line names the input, probe or document a review confirmed it with. It is a claim to re-check, never proof."), 'VERIFY-FIRST treats it as a claim to re-check');
  ok(flat(fixRun.prompt('acceptance fix-a r1')).includes('each with a `- decision:` line, a **Fix:** instruction and, from a review, an **Evidence:** line with what the review confirmed.'), 'fix acceptance names it too');
}

section('every reviewer gives a fix direction it checked against the code');
{
  const DIRECTION = 'a fix direction you checked against the code it would change';
  const feat = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, { ...ONE_BLOCK, sweep: 'goal-coverage', goal: 'g' });
  ok(flat(feat.prompt('quality block-a r1')).includes(`and ${DIRECTION}. When you found nothing`), 'the blind reviewer');
  ok(flat(bus.prompt('acceptance block-a r1')).includes(`each gap (title + file:line + ${DIRECTION})`)
    && flat(bus.prompt('acceptance block-b r1')).includes(`each gap (title + file:line + ${DIRECTION})`), 'feature and section acceptance');
  ok(flat(fixBus.prompt('acceptance fix-a r1')).includes(`each gap with ${DIRECTION} —`), 'fix acceptance');
  ok(flat(feat.prompt('final-sweep')).includes(`a suggested follow-up block that gives ${DIRECTION})`), 'the sweep');
  ok(!flat(feat.prompt('quality block-a r1')).includes('a concrete fix'), 'no reviewer asks for a concrete fix to apply');
}

section('a dismissal rests on a checked fact, and every reader checks it');
{
  const CHECKED = 'Every SKIPPED reason states a fact you checked this round: the file and line you read, or the command you ran and its output. Settle a finding you can neither confirm nor refute with a read or a probe, fix it, or escalate it (7).';
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`develop ${id}`)).includes(CHECKED), `${mode}: the drop rules ask a checked fact and never drop an unsettled finding`);
  }
  const LEDGER_CHECK = 'Check each such reason against the code it cites. A reason the code contradicts, or one that states no checked fact (a file and line read, or a command run and its output), declines nothing, so its finding counts as a gap.';
  for (const [where, prompt] of [['feature', bus.prompt('acceptance block-a r1')], ['section', bus.prompt('acceptance block-b r1')], ['fix', fixBus.prompt('acceptance fix-a r1')]]) {
    ok(flat(prompt).includes(`${OVERRIDE_SKIPPED} ${LEDGER_CHECK}`), `${where} acceptance checks each SKIPPED reason against the code`);
  }
  ok(flat(bus.prompt('quality block-a r1')).includes('Before you skip a listed finding, check its stated reason against the code it cites.'),
    'the blind reviewer checks a reason before it skips the finding');
  // Round 1 can only see an earlier launch's ledger, written against code this launch rebuilds.
  const RECHECK = "In round 1 it holds only an earlier launch's lines. After STEP 0 and before you build, re-check each line against the current code, and remove each line whose finding no longer applies or whose reason the code no longer supports, so no earlier launch's dismissal hides a finding in rebuilt code.";
  const rounds = await run({ ...GREEN_RUN, quality: firstRound(FLAGGED, CLEAN) }, ONE_BLOCK);
  ok(flat(rounds.prompt('develop block-a r1')).includes(RECHECK), 'the round-1 developer re-checks a carried ledger before it builds');
  ok(!flat(rounds.prompt('develop block-a r2')).includes("an earlier launch's lines"), 'a later round keeps the ledger its own launch wrote');
}

section('the risk file is tied to the snapshot its developer returned');
// A risk file an earlier launch left, or one a round never rewrote, must not pass as that round's.
{
  const tree = (c) => c.repeat(40);
  const devSchema = bus.byLabel('develop block-a r1')[0]?.opts?.schema ?? {};
  ok(String(devSchema.required ?? '').includes('risk_snapshot') && devSchema.properties?.risk_snapshot?.type === 'string',
    'risk_snapshot is a required string in the developer schema');
  const byRound = { 1: tree('a'), 2: tree('b'), 3: '' };
  const r = await run({
    develop: (label) => ({ ...DEV_OK, review_needed: false, risk_snapshot: byRound[Number(/r(\d+)$/.exec(label)?.[1])] }),
    quality: CLEAN, acceptance: (label) => (/r[12]$/.test(label) ? ACC_FAIL : ACC_PASS),
  }, ONE_BLOCK);
  const a3 = flat(r.prompt('acceptance block-a r3'));
  ok(a3.includes(`Each round's developer returned the tree id it wrote on its risk file's first line: round 1: ${tree('a')} round 2: ${tree('b')} round 3: none returned`),
    'acceptance gets the tree id of each audited round and of its base round');
  ok(a3.includes('Before you use a file named above, confirm its `Snapshot:` line equals the tree id its round returned. A file whose line differs, or whose round returned none, counts as a missing file.'),
    'a mismatch or a missing id counts as a missing risk file, which is a gap that sets risk_misclassified');
  // The risk tool writes a skeleton for a file it finds missing, so a round with no snapshot gets no command.
  ok(a3.includes("SWEEP CHECK. Round 3's developer returned no snapshot, so E:/r/runs/t/risk-block-a-r3.md counts as missing and holds no sweep to check.")
    && !a3.includes(`'E:/r/runs/t/risk-block-a-r3.md' --repo`),
  'a latest round that returned no snapshot gets no risk tool command in the sweep check');
  ok(r.logs.some((l) => /block-a r3: developer returned no tree id as risk_snapshot \(""\) → acceptance counts its risk file as missing/.test(l)),
    'the log names a round whose developer returned no tree id');
  ok(!r.logs.some((l) => /r[12]: developer returned no tree id/.test(l)), 'and no round that returned one');
  const notTree = await run({ develop: firstRound(DEV_OK, { ...DEV_OK, review_needed: false, risk_snapshot: 'HEAD' }), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, ONE_BLOCK);
  ok(flat(notTree.prompt('acceptance block-a r2')).includes('round 2: none returned'), 'a value that is not a tree id counts as none');
  const noField = await run({ develop: firstRound(DEV_OK, { ...DEV_OK, review_needed: false, risk_snapshot: undefined }), quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, ONE_BLOCK);
  ok(flat(noField.prompt('acceptance block-a r2')).includes('round 2: none returned'), 'a missing value counts as none');
  ok(!flat(r.prompt('acceptance block-a r1')).includes('returned the tree id'), 'a round the blind review judged has no snapshot to confirm');
}

section('the closing acceptance confirms each backlog entry the closing pass listed');
{
  const ONE_ROUND = { ...ONE_BLOCK, maxRounds: 1 };
  const closingDev = (recorded) => (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: recorded } : DEV_OK);
  const listed = await run({ develop: closingDev(['t-block-a-x-1', 't-block-a-x-2']), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(flat(listed.prompt('acceptance block-a r2')).includes(`RECORDED ENTRIES. The closing pass listed these backlog entries, each holding a fix it did not make: t-block-a-x-1 t-block-a-x-2 Before you rely on one, confirm that ${BACKLOG}/<the id without its last "-<n>">.md holds a "### [<the id>]" entry. Each id with no such entry is a gap.`),
    'each listed id is confirmed in the backlog file it names, and a missing one is a gap');
  ok(!flat(listed.prompt('acceptance block-a r1')).includes('RECORDED ENTRIES'), 'an earlier round\'s acceptance has nothing to confirm');
  const unusable = await run({ develop: closingDev(null), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(flat(unusable.prompt('acceptance block-a r2')).includes('RECORDED ENTRIES. The closing pass returned no usable list of the backlog entries it listed, so no listed entry can be confirmed. Write that as a gap.'),
    'an unusable list is a gap');
  const none = await run({ develop: closingDev([]), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, ONE_ROUND);
  ok(!flat(none.prompt('acceptance block-a r2')).includes('RECORDED ENTRIES'), 'an empty list adds no step');
}

section('a plan-unreadable halt names the bare plan command, and its park records the cause');
{
  const COMMAND = "`node 'E:/r/tools/plan-block.mjs' 'E:/plans/bus.md' 'block-a'`";
  const dev = await run({ develop: { ...DEV_OK, plan_obtained: false }, park: PARK_OK }, ONE_BLOCK);
  const reason = String(dev.out.haltReason ?? '');
  ok(reason.includes(`Its plan command was ${COMMAND}. Run it yourself. A non-zero exit names the cause`) && !reason.includes('Redirect its output'),
    'the developer halt carries the command, never the agent\'s instruction text');
  const acc = await run({ ...GREEN_RUN, acceptance: { ...ACC_FAIL, plan_obtained: false }, park: PARK_OK }, ONE_BLOCK);
  ok(String(acc.out.haltReason ?? '').includes(`Its plan command was ${COMMAND}. Run it yourself. A non-zero exit names the cause.`),
    'so does the acceptance halt');
  ok(flat(dev.prompt('park:block-a')).includes(`its **What:** placeholder with <the line "Halted: an agent could not obtain its plan.", then the cause: run ${COMMAND} yourself, and for each command write the line "Cause: <the command> exited <its exit code>: <the first line of its error output>", or "Cause: <the command> exited 0, so it reads the plan now" when it exits 0, then this halt reason, copied verbatim:`),
    'the park runs the command and writes its exit code and first error line under the Halted line');
  const dead = await run({ ...GREEN_RUN, quality: null, park: PARK_OK }, ONE_BLOCK);
  const deadPark = flat(dead.prompt('park:block-a'));
  ok(deadPark.includes('its **What:** placeholder with <the line "Halted: an agent returned nothing') && !deadPark.includes('"Cause: '),
    'a park for any other halt runs no plan command');
  const pass = await run({ develop: { ...passDev([]), plan_obtained: false }, park: PARK_OK }, PASS_ARGS);
  ok(String(pass.out.haltReason ?? '').includes("Its plan commands were `node 'E:/r/tools/plan-block.mjs' 'E:/plans/one.md' 'fix-a'`, `node 'E:/r/tools/plan-block.mjs' 'E:/plans/two.md' 'fix-b'`. Run each yourself."),
    'a pass names each member\'s command');
}

section('every backlog writer appends through the entry tool, which keeps an existing header and reopens a skipped file');
{
  const RULE = `${ENTRY_INTRO}:`;
  const closingLands = await run({ develop: (label) => (label.startsWith('develop-closing') ? { ...DEV_OK, review_needed: false, recorded_entries: [] } : DEV_OK),
    quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, { ...ONE_BLOCK, maxRounds: 1 });
  const park = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 });
  for (const [where, prompt] of [['the developer', bus.prompt('develop block-a r1')], ['fix acceptance', fixBus.prompt('acceptance fix-a r1')],
    ['the closing acceptance', closingLands.prompt('acceptance block-a r2')], ['park', park.prompt('park:block-a')]]) {
    ok(flat(prompt).includes(RULE) && !flat(prompt).includes('set it to todo, since the backlog build'), `${where} names the tool and keeps no copy of its rule`);
  }
}

section('every gate run keeps its entire output in a log under scratch');
{
  // A background run may not wake a subagent, so the rule names one bounded wait on an exit-code file.
  const gateRun = (name) => `Run each gate command this step names with the shell tool's timeout set to its maximum (600000 ms), and write its entire output to ${STATE}/scratch/gate-${name}-<build or test>.log, replacing that log's earlier content. Then read the end of that log and the command's exit code. A gate that may outlast that timeout runs through the shell tool's own background option, never with a shell \`&\`, since a job started with \`&\` may stop when its tool call returns. It writes the same log, and once the command exits, its exit code to ${STATE}/scratch/gate-${name}-<build or test>.exit, which you delete before you start it. Wait for it with one bounded loop in the foreground that checks every 10 seconds whether that exit-code file exists and stops when it does or after 9 minutes, so it ends inside the shell tool's timeout. Run that loop again until the file exists, then read the exit code and the end of the log once.`;
  const feat = await run({ ...GREEN_RUN, 'final-sweep': SWEEP_OK }, { ...ONE_BLOCK, sweep: 'goal-coverage', goal: 'g' });
  const park = await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 });
  const sites = [
    ['feature developer', bus.prompt('develop block-a r1'), 'develop-block-a-r1'],
    ['section developer', bus.prompt('develop block-b r1'), 'develop-block-b-r1'],
    ['fix developer', fixBus.prompt('develop fix-a r1'), 'develop-fix-a-r1'],
    ['feature acceptance', bus.prompt('acceptance block-a r1'), 'acceptance-block-a-r1'],
    ['section acceptance', bus.prompt('acceptance block-b r1'), 'acceptance-block-b-r1'],
    ['fix acceptance', fixBus.prompt('acceptance fix-a r1'), 'acceptance-fix-a-r1'],
    ['sweep', feat.prompt('final-sweep'), 'sweep'],
    ['park', park.prompt('park:block-a'), 'park-block-a'],
  ];
  for (const [where, prompt, name] of sites) {
    eq(flat(prompt).split(gateRun(name)).length - 1, 1, `${where}: runs its gates through the one rule, once`);
  }
}

section('the rendered prompts name none of python, pytest, jest, npm, powershell or the backlog build command');
// The rules apply in any project, so a project stack's command never appears in them.
{
  const rules = [bus.prompt('develop block-a r1'), fixBus.prompt('develop fix-a r1'), bus.prompt('acceptance block-a r1'), fixBus.prompt('acceptance fix-a r1'), bus.prompt('quality block-a r1')]
    .map(flat).join(' ');
  ok(!/\b(?:python|pytest|jest|npm|powershell|plan-edit\.mjs args --backlog)\b/i.test(rules), 'the rendered prompts name no stack-specific tool');
}

// ---------------------------------------------------------------------------------------------
// Pulled backlog entries — a proactive round-1 developer takes ready entries in its block's files
// ---------------------------------------------------------------------------------------------
// Two entries of one backlog file outside the run, in the id shape plan-pull.mjs lists.
const PULLED_FILE_ID = 'old-run-blk-0a1b2c3d';
const PULLED_FILE = `${BACKLOG}/${PULLED_FILE_ID}.md`;
const PULL_A = `${PULLED_FILE_ID}-1`;
const PULL_B = `${PULLED_FILE_ID}-2`;
const pulledDev = (results, extra = {}) => ({ ...DEV_OK, pulled_results: results, ...extra });
const pulledChecks = (checks) => checks.map(([issue_id, actually_fixed]) => ({ issue_id, actually_fixed }));
const PRO_FIX_ONE = { ...FIX_ONE, changePolicy: 'proactive' };
const pulledSync = (out) => out.statusSync.filter((e) => e.planPath === PULLED_FILE).map((e) => `${e.id}:${e.key}=${e.value}`).join(',');

section('the proactive round-1 developer of every mode runs the pull step, and the focused one never does');
{
  const PULL_COMMAND = `node 'E:/r/tools/plan-pull.mjs' pullable --backlog '${BACKLOG}' --files '<path>,<path>,...' --exclude '${BUS}'`;
  const proFix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { pulled_results: [] }), quality: CLEAN, acceptance: { ...FIX_PASS, pulled_checks: [] } }, PRO_FIX_ONE);
  const frames = [['feature', proBus, 'block-a'], ['section', proBus, 'block-b'], ['fix', proFix, 'fix-a']];
  for (const [mode, r, id] of frames) {
    const dev = flat(r.prompt(`develop ${id} r1`));
    ok(dev.includes('PULL READY BACKLOG ENTRIES, in round 1 only.') && dev.includes(PULL_COMMAND), `proactive ${mode}: round 1 runs plan-pull with the backlog folder and leaves out the run's own plan files`);
    ok(dev.includes(`a. Append the line "- pulled: t#${id}" to the entry's "- <key>:" lines in its planPath`), `proactive ${mode}: each taken entry is marked with the run and block`);
    ok(dev.includes('When the entry carries a line that starts with "**Parked with:**", delete that line, since the tool lists such an entry only once the block that line names is done or skip.'),
      `proactive ${mode}: a taken entry loses the parked-with line the tool released in memory only`);
    ok(dev.includes(`b. List its id, one id per line, in ${STATE}/PULLED-${id}.md`), `proactive ${mode}: each taken id goes to the block's PULLED file`);
    ok(dev.includes('aim for a round-1 context of about 200k to 350k tokens, your block\'s own work included'), `proactive ${mode}: the developer takes entries up to its capacity`);
    ok(r.calls.find((c) => c.label === `develop ${id} r1`).opts.schema.required.includes('pulled_results'), `proactive ${mode}: the developer reports its pulled entries`);
    ok(r.calls.find((c) => c.label === `acceptance ${id} r1`).opts.schema.required.includes('pulled_checks'), `proactive ${mode}: acceptance checks each pulled entry`);
  }
  ok(flat(proFix.prompt('develop fix-a r1')).includes('Once you have read your block and restored any unfinished branch, and before you build'), 'a fix block pulls after its restore');
  for (const [mode, r, id] of [['feature', bus, 'block-a'], ['section', bus, 'block-b'], ['fix', fixBus, 'fix-a']]) {
    const dev = r.prompt(`develop ${id} r1`);
    ok(dev !== '' && !dev.includes('plan-pull.mjs') && !dev.includes('PULLED') && !dev.includes('pulled_results'), `focused ${mode}: no pull step and no pulled report`);
    ok(!r.calls.find((c) => c.label === `develop ${id} r1`).opts.schema.required.includes('pulled_results'), `focused ${mode}: the schema asks for no pulled results`);
    ok(!r.prompt(`acceptance ${id} r1`).includes('PULLED'), `focused ${mode}: acceptance judges no pulled entry`);
  }
  const later = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: firstRound({ ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, false]]) }, { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, true]]) }) }, PRO_ONE_BLOCK);
  const r2 = flat(later.prompt('develop block-a r2'));
  ok(r2 !== '' && !r2.includes('plan-pull.mjs') && r2.includes('Take no new entry.') && r2.includes('revert that entry\'s change surgically and report it FAILED'), 'a later round takes no new entry, and closes or reverts a pulled gap');
}

section('acceptance judges each pulled entry like a fix entry, and the closing acceptance parks on one only when the block depends on it');
{
  const two = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }, { issue_id: PULL_B, status: 'STALE' }]), acceptance: { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, true], [PULL_B, true]]) } }, PRO_ONE_BLOCK);
  const acc = flat(two.prompt('acceptance block-a r1'));
  ok(acc.includes(`PULLED ENTRIES. READ ${STATE}/PULLED-block-a.md if it exists.`) && acc.includes(`- ${PULL_A}: FIXED - ${PULL_B}: STALE`), 'acceptance reads the PULLED file and the developer\'s last report');
  ok(acc.includes('judge each id the file lists as a fix block\'s acceptance judges an issue') && acc.includes('A pulled entry whose claim fails, or whose FAILED change the diff still holds, is a gap.'), 'a pulled entry\'s gap fails the round like any other gap');
  ok(!acc.includes('is never blocking'), 'a round with a later round has no closing rule');

  const closing = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, false]]) }, park: PARK_OK }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  const bar = flat(closing.prompt('acceptance block-a r2'));
  ok(bar.includes('A pulled entry\'s gap, a regression its change causes included, is never blocking') && bar.includes('revert the change of each listed entry whose check is false, surgically'), 'the closing acceptance never grades a pulled gap blocking and reverts each unconfirmed pulled change before it stages');
  ok(bar.includes('run the full gates once more. When they fail, the block\'s own work depends on a reverted change: put that change back, write a blocking gap for it, and return pass=false.'), 'a revert the block\'s own work depends on is restored and parks the block');
  ok(bar.includes('Do NOT modify source code, apart from the PULLED ENTRIES reverts.'), 'those reverts are its one change to source code');
  ok(flat(closing.prompt('develop-closing block-a')).includes('Take no new entry.'), 'the closing pass takes no new entry');

  const proFixGap = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'SKIPPED' }], { pulled_results: [{ issue_id: PULL_A, status: 'FIXED' }] }), quality: CLEAN, acceptance: { ...FIX_PASS, fix_checks: [], pulled_checks: pulledChecks([[PULL_A, true]]) } }, PRO_FIX_ONE);
  ok(proFixGap.labels.includes('acceptance fix-a r1') && !proFixGap.out.ledger[0].status.startsWith('no-changes'), 'a fix round whose own entries were all skipped but that built a pulled entry goes to the reviews');
  ok(flat(proFixGap.prompt('acceptance fix-a r1')).includes('when the FIXED list in step 1 is empty and no pulled entry is reported FIXED, no claimed fix accounts for'), 'a pulled FIXED claim accounts for its change in a fix block');
  ok(flat(proFixGap.prompt('acceptance fix-a r1')).includes('a non-empty diff with no FIXED claim of an entry or a pulled entry, a gate not satisfied'), 'the gap list counts a pulled FIXED claim as the procedure does');
  // A confirmed pulled fix changes baseline behavior that no criterion names, so the regression rule must excuse it.
  for (const [mode, accText, blockId] of [['feature', flat(two.prompt('acceptance block-a r1')), 'block-a'], ['fix', flat(proFixGap.prompt('acceptance fix-a r1')), 'fix-a']]) {
    ok(accText.includes(`- a behavior change that closes the defect of a backlog entry ${STATE}/PULLED-${blockId}.md lists. It is not a regression only when`), `proactive ${mode} acceptance: a confirmed pulled fix is not a regression`);
    ok(accText.includes(", and the code each pulled backlog entry's fix adds or changes."), `proactive ${mode} acceptance: a pulled fix is task code, as the developer's zones say`);
  }
  const focusedFixAcc = flat((await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE)).prompt('acceptance fix-a r1'));
  ok(focusedFixAcc !== '' && !focusedFixAcc.includes('pulled backlog entry') && focusedFixAcc.includes('a non-empty diff with no FIXED claim, a gate not satisfied'), 'focused acceptance names no pulled fix');
}

section('a landed block syncs each pulled entry fixed, stale or needs-attention, and removes its pulled line');
{
  const landed = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }, { issue_id: PULL_B, status: 'STALE' }]), acceptance: { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, true], [PULL_B, true]]) } }, PRO_ONE_BLOCK);
  eq(pulledSync(landed.out), `${PULL_A}:status=fixed,${PULL_A}:pulled=null,${PULL_B}:status=stale,${PULL_B}:pulled=null,${PULLED_FILE_ID}:status=done`,
    'a confirmed FIXED entry syncs fixed and a confirmed STALE one stale, each in its own backlog file, each loses its pulled line, and their file then closes once');
  eq(JSON.stringify(landed.out.ledger[0].pulled), JSON.stringify([{ issue_id: PULL_A, status: 'FIXED', confirmed: true }, { issue_id: PULL_B, status: 'STALE', confirmed: true }]), 'the ledger row names each pulled entry');
  const pulledEdits = landed.out.statusSync.filter((e) => e.planPath === PULLED_FILE && e.id !== PULLED_FILE_ID);
  ok(pulledEdits.length === 4 && pulledEdits.every((e) => e.expectPulled === 't#block-a'), 'each pulled status edit and removal expects the block\'s own mark, so plan-edit skips an entry the block never marked');
  const fileEdit = landed.out.statusSync.filter((e) => e.id === PULLED_FILE_ID);
  ok(fileEdit.length === 1 && fileEdit[0].expectNoOpen === true && fileEdit[0].expectPulled === undefined && landed.out.statusSync.at(-1) === fileEdit[0],
    `the file's done edit expects no open entry, since the run cannot see the file's other entries, and follows every entry edit: ${JSON.stringify(fileEdit)}`);
  ok(landed.out.statusSync.filter((e) => e.planPath !== PULLED_FILE).every((e) => e.expectPulled === undefined), 'a block or fix entry edit expects no mark');
  const landedNext = String(landed.out.nextStep ?? '');
  ok(landedNext.includes(`For block-a, grep ${BACKLOG}/ for the line "- pulled: t#block-a" and remove each one on an entry that is not one of ${PULL_A}, ${PULL_B}, the ids its ledger row's \`pulled\` names.`),
    'a landed block\'s nextStep names the mark to grep for and the pulled ids its ledger row names, so an unreported mark is released');
  const noneNext = String((await run({ ...GREEN_RUN, develop: pulledDev([]), acceptance: { ...ACC_PASS, pulled_checks: [] } }, PRO_ONE_BLOCK)).out.nextStep ?? '');
  ok(noneNext.includes(`For block-a, grep ${BACKLOG}/ for the line "- pulled: t#block-a" and remove each one you find, since its ledger row's \`pulled\` names no entry.`), 'a block that reported no pulled entry releases every mark it left');
  const focusedNext = String((await run({ ...GREEN_RUN }, ONE_BLOCK)).out.nextStep ?? '');
  ok(focusedNext !== '' && !focusedNext.includes('- pulled:'), 'a focused run names no pulled mark');

  const mixed = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FAILED' }, { issue_id: PULL_B, status: 'FIXED' }]), acceptance: { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, false]]) } }, PRO_ONE_BLOCK);
  eq(pulledSync(mixed.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null,${PULL_B}:status=needs-attention,${PULL_B}:pulled=null`, 'a FAILED entry and one the landing verdict never confirmed sync needs-attention, and their file gets no done edit');
  ok(mixed.logs.some((l) => l.includes(`acceptance returned no pulled_check for ${PULL_B}`)), 'a missing check is logged');

  // The round-1 verdict confirmed it, and the passing round-2 verdict did not check it, so only the latest verdict counts.
  const earlier = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: firstRound({ ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, { ...ACC_PASS, pulled_checks: [] }) }, PRO_ONE_BLOCK);
  eq(pulledSync(earlier.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'an earlier verdict\'s check never confirms the landed work');

  const unreported = await run({ ...GREEN_RUN, develop: pulledDev([]), acceptance: { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, false]]) } }, PRO_ONE_BLOCK);
  eq(pulledSync(unreported.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'an entry only acceptance names still syncs, so its pulled line never strands it');

  const bogus = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: 'Not An Id', status: 'FIXED' }, { issue_id: PULL_A, status: 'SKIPPED' }]), acceptance: { ...ACC_PASS, pulled_checks: [] } }, PRO_ONE_BLOCK);
  eq(bogus.out.statusSync.filter((e) => e.id !== 'block-a').length, 0, 'an id outside the backlog id shape and a status outside FIXED, STALE and FAILED make no edit');
  eq(bogus.logs.filter((l) => l.includes('names no backlog entry or status → ignored')).length, 2, 'and each is logged');
  const staleOwnFix = await run({ ...GREEN_RUN, develop: firstRound(pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), pulledDev([{ issue_id: PULL_A, status: 'STALE' }])),
    acceptance: firstRound({ ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, true]]) }) }, PRO_ONE_BLOCK);
  eq(pulledSync(staleOwnFix.out), `${PULL_A}:status=fixed,${PULL_A}:pulled=null,${PULLED_FILE_ID}:status=done`, 'a STALE report after the block\'s own FIXED report syncs fixed, as a fix issue does');

  const refuted = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, false]]) } }, PRO_ONE_BLOCK);
  ok(refuted.logs.some((l) => l.includes(`CONTRADICTS ITS OWN PASS`) && l.includes(`refuted pulled claims=${PULL_A}`)), 'a pass that refutes a pulled claim is flagged as contradicting itself');
  ok(!landed.logs.some((l) => l.includes('CONTRADICTS ITS OWN PASS')), 'a pass that confirms every pulled claim is not');
  const closingRefuted = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: firstRound({ ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, false]]) }, { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, false]]) }) }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  ok(closingRefuted.out.ledger[0].staged && !closingRefuted.logs.some((l) => l.includes('CONTRADICTS ITS OWN PASS')), 'a closing pass that refutes a pulled claim reverted it, so it is no contradiction');
  eq(pulledSync(closingRefuted.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'and the refuted entry goes back to the backlog');

  const ownRun = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: `${PULLED_FILE_ID}-3`, status: 'FIXED' }]), acceptance: { ...ACC_PASS, pulled_checks: [] } },
    { ...PRO_ONE_BLOCK, plans: [BLOCKS[0], { id: 'other', planPath: PULLED_FILE, mode: 'fix', gate: 'green', status: 'done' }] });
  eq(pulledSync(ownRun.out), '', `an entry of a file this run builds as a block makes no pulled edit`);
}

section('a park that saved the block keeps its pulled entries, and every other unlanded end returns them to the backlog');
{
  const parked = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, park: PARK_OK }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  eq(pulledSync(parked.out), '', 'a park whose commit holds the pulled work keeps each entry\'s status and pulled line');
  ok(!String(parked.out.nextStep ?? '').includes('ended without a park'), 'a parked block\'s RELEASE step closes its unreported marks, so nextStep names no grep for it');
  const deadPark = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, park: null }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  ok(String(deadPark.out.nextStep ?? '').includes(`These blocks ended without a park that returned, so no status edit closes the "- pulled:" line of an entry that a block's round-1 developer marked and that no report or verdict of this run names. For block-a, grep ${BACKLOG}/ for the line "- pulled: t#block-a" and remove each one on an entry that is not one of ${PULL_A}, the ids its ledger row's \`pulled\` names.`),
    'a dead park ran no RELEASE step, so nextStep names the mark to grep for');
  const parkedPrompt = flat(parked.prompt('park:block-a'));
  ok(parkedPrompt.includes('When step 1 made a commit and the pulled list is not empty, end the **What:** with the line Pulled: <the pulled list>, whose work this entry\'s branch holds.')
    && parkedPrompt.includes(`The pulled list is ${PULL_A}, plus each id ${STATE}/PULLED-block-a.md lists, when it exists, that is not one of ${PULL_A} and whose fix`), 'the park entry names the pulled ids the engine holds on the branch, so their statuses follow it');
  ok(parkedPrompt.includes('Once this entry is skipped, or set stale while its block is rebuilt from todo, remove only that line.'), 'the Pulled line says how a discarded park releases its entries');
  const focusedPark = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  ok(focusedPark !== '' && !focusedPark.includes('PULLED') && !focusedPark.includes('Pulled:'), 'a focused feature park names no pulled file and no Pulled line');

  // Round 1 fixed both, and the closing pass reverted A, so the branch holds only B's fix.
  const reverted = await run({ ...GREEN_RUN,
    develop: firstRound(pulledDev([{ issue_id: PULL_A, status: 'FIXED' }, { issue_id: PULL_B, status: 'FIXED' }]), pulledDev([{ issue_id: PULL_A, status: 'FAILED' }, { issue_id: PULL_B, status: 'FIXED' }])),
    acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, false], [PULL_B, true]]) }, park: PARK_OK }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  eq(pulledSync(reverted.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'a saved park returns an entry whose change was reverted to the backlog, and keeps only the one its branch holds');
  ok(flat(reverted.prompt('park:block-a')).includes(`The pulled list is ${PULL_B}, plus each id`), 'and its Pulled line names only the entry the branch holds');
  const staleAfterFixed = await run({ ...GREEN_RUN,
    develop: firstRound(pulledDev([{ issue_id: PULL_A, status: 'FIXED' }, { issue_id: PULL_B, status: 'STALE' }]), pulledDev([{ issue_id: PULL_A, status: 'STALE' }, { issue_id: PULL_B, status: 'STALE' }])),
    acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true], [PULL_B, true]]) }, park: PARK_OK }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  eq(pulledSync(staleAfterFixed.out), `${PULL_B}:status=needs-attention,${PULL_B}:pulled=null`, 'a park keeps a STALE report of the block\'s own fix on its branch, and returns a plain STALE one, which the cleared tree may no longer confirm');

  const unlinked = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, park: { ...PARK_OK, entry_written: false } }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  ok(String(unlinked.out.nextStep ?? '').includes(`When the pulled list of block-a is not empty, end its entry's **What:** with the line \`Pulled: <the pulled list>, whose work this entry's branch holds.`)
    && String(unlinked.out.nextStep ?? '').includes(`Its pulled list is ${PULL_A}.`), 'a park whose entry is not confirmed tells the operator to name the pulled entries its branch holds');
  ok(!String(parked.out.nextStep ?? '').includes('pulled list'), 'a confirmed park entry needs no such line');

  const empty = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, park: PARK_EMPTY }, { ...PRO_ONE_BLOCK, maxRounds: 1 });
  eq(pulledSync(empty.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'a park that saved nothing returns each pulled entry to the backlog');

  const held = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }], { unstaged_confirmed: false }), park: PARK_OK }, PRO_ONE_BLOCK);
  eq(pulledSync(held.out), '', 'a held park whose commit holds the work keeps its pulled entries too');
}

section('a park names each unreported pulled entry its commit holds, releases the rest, and a halt before the clean-baseline check still syncs the reported ones');
{
  // The round-1 developer may have marked entries before it died, and only its PULLED file names them.
  const dead = flat((await run({ develop: null, park: PARK_OK }, PRO_ONE_BLOCK)).prompt('park:block-a'));
  ok(dead.includes(`The pulled list is empty, plus each id ${STATE}/PULLED-block-a.md lists, when it exists, that no report or verdict of the run names and whose fix, as its entry in ${BACKLOG}/<the id without its last "-<n>">.md describes it, \`git -C E:/repo diff aipg-unfinished/`),
    'a dead round-1 developer\'s park names on its Pulled line each marked entry whose fix its commit holds');
  ok(dead.includes(`4. RELEASE, whatever steps 1 to 3 did. READ ${STATE}/PULLED-block-a.md if it exists.`) && dead.includes('For each id the file lists that no report or verdict of the run names and that no "Pulled:" line step 3 wrote names, nothing closes that line, so remove it'),
    'and removes the pulled line of every other entry its PULLED file lists');
  const known = flat((await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: { ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true], [PULL_B, false]]) }, park: PARK_OK }, { ...PRO_ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  ok(known.includes(`For each id the file lists that is not one of ${PULL_A}, ${PULL_B} and that no "Pulled:" line`), 'the park leaves alone each entry a report or a verdict of the run names');
  const focusedDead = flat((await run({ develop: null, park: PARK_OK }, ONE_BLOCK)).prompt('park:block-a'));
  ok(focusedDead !== '' && !focusedDead.includes('RELEASE'), 'a focused park releases nothing');

  const dirty = await run({ develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }], { baseline_dirty_files: 2 }) }, PRO_ONE_BLOCK);
  ok(dirty.out.halted === true && !dirty.labels.some((l) => l.startsWith('park')), 'a dirty baseline halts and parks nothing');
  eq(pulledSync(dirty.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'and the entries its developer reported still go back to the backlog');
}

section('a commit halt on an accepted block tells the operator to fold the backlog files before closing its pulled entries');
{
  const hooked = { ...ACC_C, commit_subject: 'rewritten by a hook' };
  const held = await run({ ...C_RUN, develop: { ...DEV_C, pulled_results: [{ issue_id: PULL_A, status: 'FIXED' }] }, acceptance: { ...hooked, pulled_checks: pulledChecks([[PULL_A, true]]) } }, { ...COMMIT_ONE, changePolicy: 'proactive' });
  const reason = String(held.out.haltReason ?? '');
  ok(reason.includes(`also run \`plan-edit.mjs args --backlog ${BACKLOG} --fold-only\`, which writes this run's statuses into the backlog files and prints nothing, and only then set each pulled entry ${STATE}/PULLED-${C_BLOCK.id}.md lists that ${STATE}/acceptance-review-${C_BLOCK.id}-r1.md confirmed closed to \`fixed\` or \`stale\`.`),
    'the fold comes before the hand edit, so a later fold never overwrites it');
  ok(!reason.includes('fix issue'), 'a feature block names no fix issue');
  eq(pulledSync(held.out), `${PULL_A}:status=needs-attention,${PULL_A}:pulled=null`, 'the run syncs the entry as not landed, which that fold applies');
  const focused = String((await run({ ...C_RUN, acceptance: hooked }, COMMIT_ONE)).out.haltReason ?? '');
  ok(focused !== '' && !focused.includes('--backlog'), 'a focused block\'s note names no backlog fold');
}

// ---------------------------------------------------------------------------------------------
// Each agent confirms what it is handed: an amendment, a SPEC decline, an unreported entry and the staged index
// ---------------------------------------------------------------------------------------------
section('an amendment header names its launch, which round 1 counts from the AMENDED file and the engine hands to later rounds');
{
  const twoRounds = (r1) => ({ develop: (label) => (/r1$/.test(label) ? r1 : { ...DEV_OK, launch_number: -1 }), quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS });
  const r = await run(twoRounds({ ...DEV_OK, launch_number: 3 }), ONE_BLOCK);
  const r1 = flat(r.prompt('develop block-a r1'));
  const r2 = flat(r.prompt('develop block-a r2'));
  ok(r1.includes('`## Plan amendment: block-a r1, launch <the launch_number you report>`'), 'round 1 heads an amendment with the launch number it reports');
  ok(r2.includes('`## Plan amendment: block-a r2, launch 3`'), 'a later round heads it with the number round 1 reported');
  ok(r1.includes(`${STATE}/AMENDED-block-a.md, when it exists, holds plan amendments, each another agent's claim under a header that names its launch, and in round 1 every one comes from an earlier launch. Before you change it, report launch_number as one past the highest n that a "launch <n>" in its headers names, or 1 when the file does not exist or no header names one. After STEP 0 and before you build, re-check each amendment as you re-check a DISMISSED line: reproduce its defect against the file:line it cites and the clause it quotes, and remove each amendment whose quoted clause your block's text no longer holds or whose defect the current code does not reproduce, with its pointer line in ${STATE}/DECISIONS.md, the line that names its block id, round, launch and defect file:line. An amendment whose header names no launch has a pointer that names none, so match that pointer by its block id, round and defect file:line alone.`),
    'round 1 counts the launch and re-checks every earlier launch\'s amendment as it re-checks a DISMISSED line, an unnumbered one included');
  ok(r2 !== '' && !r2.includes('report launch_number as one past'), 'a later round counts no launch');
  ok(!r2.includes('Report baseline_dirty_files=-1'), 'a later round is not told to report the round-1 fields');
  const schema = r.calls.find((c) => c.label === 'develop block-a r1')?.opts.schema;
  ok(['launch_number', 'baseline_index_tree'].every((f) => schema?.required?.includes(f)), 'the developer schema requires the launch number and the baseline index tree');
  const ROUND1_ONLY = ['baseline_dirty_files', 'baseline_index_tree', 'launch_number', 'earlier_files'];
  const laterSchema = r.calls.find((c) => c.label === 'develop block-a r2')?.opts.schema;
  ok(ROUND1_ONLY.every((f) => schema.required.includes(f) && f in schema.properties), 'the round-1 developer schema declares and requires every round-1 field');
  ok(ROUND1_ONLY.every((f) => !laterSchema.required.includes(f) && !(f in laterSchema.properties)), 'a later-round developer schema declares and requires none of them');
  for (const bad of [undefined, 0, 1.5, '2']) {
    const u = await run(twoRounds({ ...DEV_OK, launch_number: bad }), ONE_BLOCK);
    ok(flat(u.prompt('develop block-a r2')).includes('`## Plan amendment: block-a r2, launch unrecorded`')
      && u.logs.some((l) => /block-a r1: developer reported no launch number/.test(l)),
    `a round-1 launch_number of ${JSON.stringify(bad)} is logged and leaves later headers unrecorded`);
  }
}

section('a SPEC decline rests on the plan, so the blind reviewer skips it and acceptance checks it against the plan');
{
  const q = flat(bus.prompt('quality block-a'));
  ok(q.includes('A line whose reason starts `SKIPPED: SPEC:` rests on a plan you cannot read, and a later stage checks it, so skip its finding without that check.'),
    'the blind reviewer skips a SPEC line without checking its reason');
  for (const [mode, id, r] of FRAMES) {
    ok(flat(r.prompt(`acceptance ${id}`)).includes("A line whose reason starts `SKIPPED: SPEC:` names a file:line of code and declines a finding because the plan prescribes the code, this block's text excludes it, or another block of the plan owns it. Check it against this block's text and the plan's other blocks. When none of the three holds, the line declines nothing, so its finding counts as a gap."),
      `${mode}: acceptance checks a SPEC line against the block's text and the other blocks' code`);
  }
}

section('fix acceptance counts every ACTIONABLE entry the developer left unreported as an open gap');
{
  const single = flat((await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FAILED' }]), quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE)).prompt('acceptance fix-a'));
  ok(single.includes('The developer reports these issues FAILED, each a fix it reverted or could not make: - i-2 A FAILED entry goes back to the user as needs-attention, so its report alone is no gap.'),
    'a FAILED entry is listed and is no gap by its report alone');
  ok(single.includes('An ACTIONABLE entry, other than a closed one, that none of the FIXED, STALE, SKIPPED or FAILED lists names was left unreported: it is an issue left open, and it fails acceptance. Read every entry of the block to find each one.'),
    'a single block\'s acceptance finds each unreported entry by reading the block');
  ok(flat(fixBus.prompt('acceptance fix-a')).includes('(none reported failed)'), 'no FAILED report renders an empty list');
  ok(single.includes('Every claimed fix complete, every STALE claim confirmed, every ACTIONABLE entry reported, no non-ACTIONABLE entry touched'),
    'a pass needs every ACTIONABLE entry reported');
  ok(flat(fixBus.prompt('develop fix-a')).includes('that the diff touched no entry that is not ACTIONABLE and skipped or left unreported none that is'),
    'the developer\'s copy of the acceptance checks names an unreported entry too');
  const pass = flat((await run({ develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, PASS_ARGS)).prompt('acceptance'));
  ok(pass.includes('The developer reported none of these entries of the pass: - i-2 - i-3') && !pass.includes('Read every entry of the block to find each one.'),
    'a pass\'s acceptance gets the ids of the entries its developer did not report');
  const full = flat((await run({ develop: passDev(['i-1', 'i-2', 'i-3'].map((id) => ({ issue_id: id, status: 'FIXED' }))), quality: CLEAN, acceptance: FIX_PASS }, PASS_ARGS)).prompt('acceptance'));
  ok(full.includes('The developer reported none of these entries of the pass: (none: it reported every entry)'), 'a pass whose every entry was reported lists none');
}

section('acceptance confirms the staged index still holds the tree the run last recorded before it stages');
{
  const TREE = (c) => c.repeat(40);
  const INDEX_CHECK = (tree) => `8. DECIDE. INDEX CHECK, before any \`git add\`: run \`git -C E:/repo write-tree\`. It must print ${tree}, the tree id this run last recorded for the index. When it prints another id, the index holds work no acceptance staged, which no reviewer read: stage nothing, write both ids in your file, and return index_matched=false and pass=false. Otherwise return index_matched=true.`;
  const byBlock = (a, b) => (label) => (label.includes('block-a') ? a : b);
  const chain = await run({
    develop: byBlock({ ...DEV_OK, baseline_index_tree: TREE('a') }, { ...DEV_OK, baseline_index_tree: TREE('f') }),
    quality: CLEAN,
    acceptance: byBlock({ ...ACC_PASS, index_tree: TREE('b') }, { ...ACC_PASS, index_tree: TREE('c') }),
  });
  ok(flat(chain.prompt('develop block-a r1')).includes('If it IS 0, run `git -C E:/repo write-tree` and report the tree id it prints as baseline_index_tree. Next, report earlier_files=true when'),
    'the round-1 developer reports the index tree before it touches anything');
  ok(flat(chain.prompt('acceptance block-a')).includes(INDEX_CHECK(TREE('a'))), 'the first acceptance confirms the tree the round-1 developer reported');
  ok(flat(chain.prompt('acceptance block-b')).includes(INDEX_CHECK(TREE('b'))) && !flat(chain.prompt('acceptance block-b')).includes(TREE('f')),
    'a later acceptance confirms the tree the previous acceptance recorded, never its own developer\'s report');
  ok(flat(chain.prompt('acceptance block-a')).includes('Return index_tree as the tree id `git -C E:/repo write-tree` prints once you finish step 8: run it again after your `git add` when you stage, and otherwise return the id this check printed.'),
    'acceptance records the index tree after it stages');
  const schema = chain.calls.find((c) => c.label.startsWith('acceptance'))?.opts.schema;
  ok(['index_matched', 'index_tree'].every((f) => schema?.required?.includes(f)), 'the acceptance schema requires both index fields');

  for (const [what, acc, note] of [['a failing', { ...ACC_FAIL, index_matched: false }, 'It staged nothing. Inspect'], ['a passing', { ...ACC_PASS, index_matched: false }, 'It still reported staged=true, so its own staging may sit there too. Inspect']]) {
    const moved = await run({ ...GREEN_RUN, acceptance: acc, park: PARK_OK });
    eq(moved.out.status, 'BLOCKED (the staged index may hold work no reviewer read: the developer did not confirm its work stayed unstaged, or acceptance found the index changed outside acceptance)',
      `${what} verdict that found the index changed halts as staging-unconfirmed`);
    ok(String(moved.out.haltReason ?? '').includes(`found in round 1 that the staged index no longer holds tree c0ffee0000000000000000000000000000000001, the tree id this run last recorded for the index, so work that no reviewer read may sit in the accepted baseline (see E:/r/runs/t/acceptance-review-block-a-r1.md).`),
      `${what} verdict's halt names the tree it expected`);
    ok(String(moved.out.haltReason ?? '').includes(note), `${what} verdict's halt says whether acceptance reported its own staging`);
    ok(String(moved.out.haltReason ?? '').includes('Inspect `git -C E:/repo diff --cached c0ffee0000000000000000000000000000000001` and unstage what no acceptance staged before resuming.'),
      `${what} verdict's halt diffs the index against the recorded tree, so accepted blocks stay out of the listing`);
    ok(moved.out.ledger[0].staged === false && moved.labels.includes('park:block-a') && !moved.labels.some((l) => l.includes('block-b')),
      `${what} verdict lands nothing, parks the block and stops the run`);
  }

  const fixMoved = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: { ...FIX_GAP, index_matched: false, backlog_entries: 1, backlog_blocks: ['fix-a'] }, park: PARK_OK }, FIX_ONE);
  ok(fixMoved.out.halted === true && fixMoved.logs.some((l) => /fix-a r1: acceptance added 1 backlog entry/.test(l)), 'a fix verifier\'s backlog entries still count when its index check halts the run');
  const untreedMoved = await run({ ...GREEN_RUN, develop: { ...DEV_OK, baseline_index_tree: '' }, acceptance: { ...ACC_FAIL, index_matched: false }, park: PARK_OK });
  ok(String(untreedMoved.out.haltReason ?? '').includes('Inspect `git -C E:/repo diff --cached` and unstage what no acceptance staged before resuming.'),
    'with no recorded index tree the index halt names the plain staged diff');
  const unknown = await run({ ...GREEN_RUN, develop: { ...DEV_OK, baseline_index_tree: '' } }, ONE_BLOCK);
  ok(unknown.logs.some((l) => /block-a r1: developer reported no tree id as baseline_index_tree \(""\)/.test(l)), 'a missing baseline tree is logged');
  ok(flat(unknown.prompt('acceptance block-a')).includes('This run recorded no tree id for the index, so this check has nothing to compare: say so in your file and return index_matched=true.'),
    'acceptance with no recorded tree says so rather than comparing');
  const refill = await run({
    develop: byBlock(DEV_OK, { ...DEV_OK, baseline_index_tree: TREE('d') }),
    quality: CLEAN,
    acceptance: byBlock({ ...ACC_PASS, index_tree: 'none', index_matched: undefined }, ACC_PASS),
  });
  ok(refill.logs.some((l) => /block-a r1: acceptance returned no tree id as index_tree \("none"\) → the next acceptance has no index to confirm unless a round-1 developer reports one first, and the tree id that acceptance returns restores the check$/.test(l))
    && refill.logs.some((l) => /block-a r1: acceptance did not report its index check \(index_matched=undefined\)/.test(l)),
  'an unusable index_tree and a missing index_matched are each logged');
  ok(flat(refill.prompt('acceptance block-b')).includes(INDEX_CHECK(TREE('d'))), 'the next block\'s round-1 developer refills a tree the last acceptance left unrecorded');
}

section('an index halt names a reported commit and its revert, and says when no tree was recorded');
{
  const STAGING = 'BLOCKED (the staged index may hold work no reviewer read: the developer did not confirm its work stayed unstaged, or acceptance found the index changed outside acceptance)';
  const committed = await run({ ...C_RUN, acceptance: { ...ACC_C, index_matched: false }, park: PARK_OK }, COMMIT_ONE);
  const reason = String(committed.out.haltReason ?? '');
  eq(committed.out.status, STAGING, 'a commit-mode verdict that found the index changed halts as staging-unconfirmed');
  ok(reason.includes(`It still reported commit ${SHA}, which may carry that work: inspect \`git -C E:/repo show --stat ${SHA}\` and revert it with \`git -C E:/repo revert ${SHA}\`.`),
    'its halt names the reported commit, how to view it and how to revert it');
  ok(committed.out.ledger[0].commit === null, 'and records no landed commit, as for a rejected block');
  const unverified = await run({ ...C_RUN, acceptance: { ...ACC_C, index_matched: false, commit_sha: 'none' }, park: PARK_OK }, COMMIT_ONE);
  ok(String(unverified.out.haltReason ?? '').includes('It still reported commit "none", which may carry that work: inspect `git -C E:/repo log -1 --stat` and revert each commit it made'),
    'a reported commit with no verified sha is found from HEAD, never reverted by a guessed id');
  const noTree = await run({ ...GREEN_RUN, develop: { ...DEV_OK, baseline_index_tree: '' }, acceptance: { ...ACC_PASS, index_matched: false }, park: PARK_OK }, ONE_BLOCK);
  const noTreeReason = String(noTree.out.haltReason ?? '');
  ok(noTreeReason.includes('that the staged index changed, although this run recorded no tree id for the index, so that check had nothing to compare') && !noTreeReason.includes('tree null'),
    'a mismatch reported with no recorded tree says no tree was recorded');
  const unwritten = await run({ ...GREEN_RUN, acceptance: { ...ACC_FAIL, index_matched: false, wrote_file: false }, park: PARK_OK });
  const unwrittenReason = String(unwritten.out.haltReason ?? '');
  ok(unwrittenReason.includes('(it did not confirm writing E:/r/runs/t/acceptance-review-block-a-r1.md, so that file may not exist)') && !unwrittenReason.includes('(see E:/r/runs/t/acceptance-review-block-a-r1.md)'),
    'an index halt from a verdict that did not confirm its file says that file may not exist');
  // An agent's own commit moves HEAD, so `git diff --cached` shows nothing and only the history finds it.
  ok(reason.includes('HEAD before this block was the HEAD this launch started from, so a newer commit holds work no acceptance landed: list each with `git -C E:/repo log --oneline` and revert it with `git -C E:/repo revert <sha>`.'),
    'a commit-mode index halt names the commits since the last landing');
  ok(committed.prompt('park:block-a').includes('for self-staged work, and `git -C E:/repo log --oneline` for a commit after the HEAD this launch started from, which no acceptance landed'),
    'a commit-mode park after an index halt names the history check');
  ok(!noTreeReason.includes('log --oneline') && !noTree.prompt('park:block-a').includes('log --oneline'), 'a stage-mode index halt and its park name only the staged index');
  const LANDED = 'a'.repeat(40);
  const accAfterLanding = (label) => (label.includes('block-a') ? { ...ACC_C, commit_sha: LANDED, commit_subject: 'block-a' } : { ...ACC_C, index_matched: false });
  const afterLanding = await run({ develop: DEV_C, quality: CLEAN, acceptance: accAfterLanding, park: PARK_OK }, { ...baseArgs, commit: true, plans: BLOCKS });
  ok(String(afterLanding.out.haltReason ?? '').includes('HEAD before this block was ' + LANDED + ', the last commit of this launch, so a newer commit holds work no acceptance landed: list each with `git -C E:/repo log --oneline` and revert it with `git -C E:/repo revert <sha>`.'),
    'a later block\'s index halt names the last commit this launch landed');
  const devCommitted = await run({ ...C_RUN, develop: { ...DEV_C, unstaged_confirmed: false }, park: PARK_OK }, COMMIT_ONE);
  ok(String(devCommitted.out.haltReason ?? '').includes('before resuming. HEAD before this block was the HEAD this launch started from, so a newer commit holds work no acceptance landed: list each with `git -C E:/repo log --oneline` and revert it with `git -C E:/repo revert <sha>`.'),
    'a commit-mode halt for an unconfirmed developer names the history check too');
  ok(flat(bus.prompt('develop block-a')).includes(`Then append ONE POINTER line to ${STATE}/DECISIONS.md: the block id, the round, the launch, the defect's file:line, and the path`),
    'an amendment\'s pointer line names its launch, so a relaunch finds the pointer of an amendment it removes');
}

section('develop hands each later agent what an earlier agent settled');
{
  const LEDGER = (id) => `${STATE}/gate/DISMISSED-${id}.md`;
  const AMENDED = (id) => `${STATE}/AMENDED-${id}.md`;
  // A park entry names its block's ledger and amendments, so the fix block built from it reads both.
  const parked = flat((await run({ ...GREEN_RUN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 })).prompt('park:block-a'));
  ok(parked.includes(`--origin '${BUS}#block-a' --ledger '${LEDGER('block-a')}' --amended '${AMENDED('block-a')}' Its --decision`), 'the park entry carries the ledger and amended lines after its origin');
  ok(parked.includes(`Pass --ledger only when ${LEDGER('block-a')} exists, and --amended only when ${AMENDED('block-a')} exists, so the block built from this entry reads this block's declined findings and plan amendments.`),
    'each line is written only when its file exists');
  ok(!parked.includes('Append to its "- amended:" line'), 'a park that supersedes nothing carries no amendments over');
  const fixParked = flat((await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 })).prompt('park:fix-a'));
  ok(fixParked.includes(`Append to its "- amended:" line the same way every path that the "- amended:" line of those entries holds and this line does not, writing that line directly under this entry's "- origin:" line when this entry has none, since those blocks' criteria stay judged under their amendments. Their "- ledger:" lines carry over through ${LEDGER('fix-a')}, into which round 1 copied each line it kept.`),
    'a superseding park carries the superseded entries\' amendments, and their ledgers through its own');

  // The fix block built from such an entry: round 1 copies each kept ledger line where the blind reviewer reads.
  const fix = await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: firstRound(FIX_GAP, FIX_PASS) }, FIX_ONE);
  const r1 = flat(fix.prompt('develop fix-a r1'));
  const copy = r1.indexOf(`An ACTIONABLE entry's "- ledger:" line names the DISMISSED ledger of the parked block whose work it continues. Before you build, READ each file it names, re-check each line there as the ledger rule below re-checks an earlier launch's line, and append each line you keep to ${LEDGER('fix-a')} unless that file already holds it, since that is the one ledger the blind reviewer reads.`);
  ok(copy > -1 && copy < r1.indexOf("In round 1 it holds only an earlier launch's lines."), 'round 1 re-checks and copies each origin ledger line, before the ledger rule it cites');
  ok(r1.includes('Its "- amended:" line names the plan amendments of the blocks its "- origin:" line names, each another agent\'s claim. READ each file it names and reproduce each amendment\'s defect against the file:line it cites. Meet an origin criterion under an amendment whose defect you reproduce, and as its block\'s text states it otherwise.'),
    'round 1 meets an origin criterion under an amendment only once it reproduces its defect');
  ok(!flat(fix.prompt('develop fix-a r2')).includes('"- ledger:" line names'), 'a later round copies nothing');
  const acc = flat(fix.prompt('acceptance fix-a r1'));
  ok(acc.includes(`• each file that the "- ledger:" line of an ACTIONABLE entry of this block names — the findings that the developers of the parked block whose work that entry continues declined. The round-1 developer re-checked each of its lines against the code and copied each one it kept into ${LEDGER('fix-a')}, so a line that only such a file holds settles nothing.`),
    'fix acceptance reads the origin ledgers in its settled section');
  ok(acc.includes('Also READ each file that the "- amended:" line of an ACTIONABLE entry of this block names. It records the plan clauses that the developers of the parked block whose work that entry continues OVERRODE. Judge each of those amendments the same way before it excuses a criterion of a block that entry\'s "- origin:" line names.'),
    'fix acceptance reads the origin amendments in its amendment section and confirms each before it excuses a criterion');
  const plan = flat((await run(GREEN_RUN, ONE_BLOCK)).prompt('acceptance block-a'));
  ok(plan !== '' && !plan.includes('"- ledger:"') && !plan.includes('"- amended:"'), 'a feature acceptance names no park entry line');
  ok(!/- ledger:|- amended:|AMENDED-/.test(fix.prompt('quality fix-a')), 'the blind reviewer gets no path outside its gate folder (#3)');

  // Rounds 2 and later start from the statuses the developer last reported.
  const r2 = flat(fix.prompt('develop fix-a r2'));
  ok(r2.includes('Your earlier rounds last reported these statuses: - i-1: FIXED Start each listed entry from its status rather than re-deriving it.'), 'a fix block\'s round 2 lists each entry\'s last status');
  ok(!r1.includes('Your earlier rounds last reported'), 'round 1 lists none');
  const pro = await run({ ...GREEN_RUN, develop: pulledDev([{ issue_id: PULL_A, status: 'FIXED' }]), acceptance: firstRound({ ...ACC_FAIL, pulled_checks: pulledChecks([[PULL_A, true]]) }, { ...ACC_PASS, pulled_checks: pulledChecks([[PULL_A, true]]) }) }, PRO_ONE_BLOCK);
  ok(flat(pro.prompt('develop block-a r2')).includes(`Your earlier rounds last reported: - ${PULL_A}: FIXED Report each listed status again unless this round's work changes it.`), 'a later round lists each pulled entry\'s last status');

  // Every block's ledger reaches the user, so each judgment call can be audited (#6).
  const next = nextOf((await run(GREEN_RUN)).out);
  ok(next.includes(`so the user can audit every judgment call: ${LEDGER('block-a')}, ${LEDGER('block-b')}. Then derive`), `nextStep names each block's ledger: ${next.slice(-600)}`);
  const idle = nextOf((await run(GREEN_RUN, { ...baseArgs, plans: BLOCKS.map((b) => ({ ...b, status: 'done' })) })).out);
  ok(idle !== '' && !idle.includes('audit every judgment call'), 'a run that built no block names no ledger');
  const guide = flat(readFileSync(join(REPO_ROOT, 'workflows/develop/CLAUDE.md'), 'utf8'));
  ok(guide.includes('the files in `backlogFiles`, `SWEEP.md` and the path of each `DISMISSED-<id>.md` that `nextStep` names and that exists, so the user can audit every judgment call.'),
    'the guide\'s surfaced list names each ledger');
}

// ---------------------------------------------------------------------------------------------
// A prompt says a ledger file does not exist only when the engine knows it
// ---------------------------------------------------------------------------------------------
section('a prompt drops the read step of a file no earlier launch left and no developer round wrote');
{
  const NONE = { ...DEV_OK, earlier_files: false, dismissed_count: 0, plan_amendments: 0 };
  const READ_Q_DISMISSED = 'Before reviewing, READ this if it exists.';
  const READ_A_DISMISSED = 'Before reviewing, READ these if they exist.';
  const READ_A_AMENDED = `READ ${STATE}/AMENDED-block-a.md if it exists.`;
  const NO_AMENDMENT = 'does not exist, so no amendment excuses';
  const NOTHING_SETTLED = 'does not exist, so nothing is settled yet';
  const prompts = async (develop) => {
    const r = await run({ develop, quality: CLEAN, acceptance: ACC_PASS }, ONE_BLOCK);
    return { q: flat(r.prompt('quality block-a r1')), a: flat(r.prompt('acceptance block-a r1')), r };
  };

  const fresh = await prompts(NONE);
  ok(fresh.q.includes(`Settled decisions: ${STATE}/gate/DISMISSED-block-a.md ${NOTHING_SETTLED}.`) && !fresh.q.includes(READ_Q_DISMISSED),
    'the blind reviewer is told the DISMISSED file does not exist when round 1 found none and wrote none');
  ok(!fresh.q.includes(`read only ${STATE}/gate/DISMISSED-block-a.md there`) && fresh.q.includes('Before you review, read no file there.')
    && fresh.q.includes('quality-review-block-a-r1.md if it exists'),
    'the blind reviewer is no longer sent to read it');
  ok(fresh.a.includes(`${STATE}/gate/DISMISSED-block-a.md does not exist, so no finding of this block is declined.`),
    'acceptance is told the DISMISSED file does not exist');
  ok(fresh.a.includes(`AMENDMENTS: ${STATE}/AMENDED-block-a.md ${NO_AMENDMENT} a criterion.`) && !fresh.a.includes(READ_A_AMENDED),
    'acceptance is told the AMENDED file does not exist');
  ok(fresh.a.includes(`${STATE}/DECISIONS.md`), 'acceptance still lists the run-wide DECISIONS file, which no block-level report covers');

  const kept = await prompts({ ...NONE, earlier_files: true });
  ok(kept.q.includes(READ_Q_DISMISSED) && kept.a.includes(READ_A_AMENDED) && kept.a.includes(READ_A_DISMISSED),
    'an earlier launch left a file, so every read step stays');
  for (const bad of [undefined, 'false', null]) {
    const u = await prompts({ ...NONE, earlier_files: bad });
    ok(u.q.includes(READ_Q_DISMISSED) && u.a.includes(READ_A_AMENDED), `a round-1 earlier_files of ${JSON.stringify(bad)} keeps every read step`);
  }
  const wrote = await prompts({ ...NONE, dismissed_count: 2 });
  ok(wrote.q.includes(READ_Q_DISMISSED) && wrote.a.includes(READ_A_DISMISSED) && wrote.a.includes(NO_AMENDMENT),
    'a round that appended to DISMISSED keeps its read steps and leaves the AMENDED file absent');
  const amended = await prompts({ ...NONE, plan_amendments: 1 });
  ok(amended.a.includes(READ_A_AMENDED) && amended.q.includes(NOTHING_SETTLED),
    'a round that appended to AMENDED keeps that read step and leaves the DISMISSED file absent');
  for (const bad of [undefined, '0', -1]) {
    const u = await prompts({ ...NONE, dismissed_count: bad, plan_amendments: bad });
    ok(u.q.includes(READ_Q_DISMISSED) && u.a.includes(READ_A_AMENDED), `a count of ${JSON.stringify(bad)} keeps both read steps`);
  }

  // Only round 1 answers earlier_files, and a later round that appended puts the read step back.
  const later = await run({ develop: firstRound(NONE, { ...NONE, earlier_files: true, dismissed_count: 1 }), quality: firstRound(FLAGGED, CLEAN), acceptance: ACC_PASS }, ONE_BLOCK);
  const laterAcc = flat(later.prompt('acceptance block-a r2'));
  ok(flat(later.prompt('quality block-a r1')).includes(NOTHING_SETTLED) && laterAcc.includes(READ_A_DISMISSED) && laterAcc.includes(NO_AMENDMENT),
    'round 2 appended to DISMISSED, so its acceptance reads it, and only round 1 decides the earlier_files answer');

  const fixDevFresh = fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { earlier_files: false, dismissed_count: 0, plan_amendments: 0 });
  const fixFresh = flat((await run({ develop: fixDevFresh, quality: CLEAN, acceptance: FIX_PASS }, FIX_ONE)).prompt('acceptance fix-a'));
  ok(fixFresh.includes(`${NO_AMENDMENT} an issue.`) && fixFresh.includes('Also READ each file that the "- amended:" line'),
    'a fix acceptance drops the read of its own AMENDED file and keeps the read of the files its entries name');

  const schema = fresh.r.calls.find((c) => c.label === 'develop block-a r1')?.opts.schema;
  ok(schema?.required?.includes('earlier_files') && schema.properties.earlier_files.type === 'boolean', 'the developer schema requires the earlier_files boolean');
  ok(schema?.required?.includes('dismissed_count') && schema?.required?.includes('plan_amendments'), 'the developer schema requires both counts the file tracker reads');
  const EARLIER = `report earlier_files=true when ${STATE}/gate/DISMISSED-block-a.md or ${STATE}/AMENDED-block-a.md exists,
else false, before you write to either file.`;
  const devR1 = fresh.r.prompt('develop block-a r1');
  ok(devR1.includes(EARLIER) && devR1.indexOf(EARLIER) < devR1.indexOf('If ' + STATE + '/gate/DISMISSED-block-a.md exists, READ it first'), 'the round-1 developer is told how to answer earlier_files in STEP 0, before the ledger note');
  ok(devR1.split('report earlier_files=true').length === 2, 'the earlier_files answer is stated once');

  const DISMISSED_READ = `If ${STATE}/gate/DISMISSED-block-a.md exists, READ it first`;
  const DISMISSED_GONE = `${STATE}/gate/DISMISSED-block-a.md does not exist, so you have declined nothing in THIS block yet.`;
  const twoRounds = (develop) => run({ develop, quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, ONE_BLOCK);
  const absentRun = await twoRounds(NONE);
  ok(flat(absentRun.prompt('develop block-a r1')).includes(DISMISSED_READ) && flat(absentRun.prompt('develop block-a r2')).includes(DISMISSED_GONE)
    && !flat(absentRun.prompt('develop block-a r2')).includes(DISMISSED_READ),
    'a later developer is told the DISMISSED file does not exist, and round 1 keeps the read step');
  for (const [label, develop] of [['an earlier launch left a file', { ...NONE, earlier_files: true }], ['round 1 appended to DISMISSED', { ...NONE, dismissed_count: 1 }], ['round 1 returned no earlier_files', { ...NONE, earlier_files: undefined }]]) {
    const kept2 = await twoRounds(develop);
    ok(flat(kept2.prompt('develop block-a r2')).includes(DISMISSED_READ) && !flat(kept2.prompt('develop block-a r2')).includes(DISMISSED_GONE),
      `a later developer keeps the DISMISSED read step when ${label}`);
  }
}

section('an acceptance prompt leaves out every rule that judges a DISMISSED line when the engine knows the ledger does not exist');
{
  const ledger = (id) => `${STATE}/gate/DISMISSED-${id}.md`;
  const ledgerRules = (id) => [
    'A DISMISSED line covers exactly what it names',
    `OVERRIDE: ${ledger(id)} entries are the developer's judgment calls.`,
    'A line whose reason starts `SKIPPED:` declines a finding',
    'A line whose reason starts `ESCALATED:` records a default',
    `that no line in ${ledger(id)} covers`,
    `${ledger(id)} holds a line for it`,
    "Once the developer's ledger holds one, the OVERRIDE rule above governs it.",
  ];
  const CONTEST = 'A finding this pass\'s blind review raised as "CONTESTS DISMISSAL"';
  const ORIGIN = `closes each gap its **What:** lists, or a line in ${ledger('fix-a')} declines that gap under the OVERRIDE and ledger-line rules above, and meets`;
  const ORIGIN_GONE = 'closes each gap its **What:** lists and meets';
  const CLOSED_ONLY = 'For each finding or gap in them, confirm that the current code closes it, the edit that closes it breaks nothing under the REGRESSION step below, and a grep finds no sibling path that carries the same mechanism. Every other finding or gap counts as a gap.';
  const REGRESSION_END = 'escalates it when only a change in other code closes it.';
  // maxRounds 1 with a failing round 1 renders both an ordinary and a closing acceptance of each frame.
  const withClosing = (dev) => (label) => (label.startsWith('develop-closing') ? { ...dev, review_needed: false, recorded_entries: [] } : dev);
  const prompts = async (files) => {
    const feature = await run({ develop: withClosing({ ...DEV_OK, ...files }), quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, { ...ONE_BLOCK, maxRounds: 1 });
    const fix = await run({ develop: withClosing(fixDev([{ issue_id: 'i-1', status: 'FIXED' }], files)), quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK }, { ...FIX_ONE, maxRounds: 1 });
    return [['block-a', 'r1', feature], ['block-a', 'r2', feature], ['fix-a', 'r1', fix], ['fix-a', 'r2', fix]]
      .map(([id, round, r]) => ({ id, round, a: flat(r.prompt(`acceptance ${id} ${round}`)) }));
  };

  for (const { id, round, a } of await prompts({ earlier_files: false, dismissed_count: 0, plan_amendments: 0 })) {
    const what = `absent ledger, ${id} ${round}`;
    ok(a.includes(`${ledger(id)} does not exist, so no finding of this block is declined.`), `${what}: SETTLED says the ledger does not exist`);
    ok(ledgerRules(id).every((t) => !a.includes(t)) && !a.includes(CONTEST), `${what}: no rule that judges a ledger line renders`);
    ok(a.includes(CLOSED_ONLY), `${what}: the earlier-findings step confirms only that the code closes each finding`);
    ok(a.includes(`${REGRESSION_END} Drop any other concern silently`), `${what}: the regression rule ends without the OVERRIDE tail`);
    if (id === 'fix-a') ok(a.includes(ORIGIN_GONE) && !a.includes(ORIGIN), `${what}: the origin clause drops its DISMISSED alternative`);
  }
  for (const { id, round, a } of await prompts({ earlier_files: false, dismissed_count: 1, plan_amendments: 0 })) {
    const what = `present ledger, ${id} ${round}`;
    ok(ledgerRules(id).every((t) => a.includes(t)), `${what}: every rule that judges a ledger line renders`);
    ok(!a.includes(CLOSED_ONLY), `${what}: the earlier-findings step keeps its ledger clause`);
    ok(a.includes(CONTEST) === (round === 'r2'), `${what}: the CONTESTS DISMISSAL sentence renders only in the closing bar`);
    if (id === 'fix-a') ok(a.includes(ORIGIN) && !a.includes(ORIGIN_GONE), `${what}: the origin clause keeps its DISMISSED alternative`);
  }
}

section('the park prompt renders the ledger and amended lines and their existence checks only for a file that may exist');
{
  const NONE_FILES = { ...DEV_OK, earlier_files: false, dismissed_count: 0, plan_amendments: 0 };
  const parkArgs = { ...ONE_BLOCK, maxRounds: 1 };
  const parkOf = async (develop) => flat((await run({ develop, quality: CLEAN, acceptance: ACC_FAIL, park: PARK_OK }, parkArgs)).prompt('park:block-a'));
  const LEDGER_LINE = `--ledger '${STATE}/gate/DISMISSED-block-a.md'`;
  const AMENDED_LINE = `--amended '${STATE}/AMENDED-block-a.md'`;
  const LEDGER_CHECK = `--ledger only when ${STATE}/gate/DISMISSED-block-a.md exists`;
  const AMENDED_CHECK = `--amended only when ${STATE}/AMENDED-block-a.md exists`;
  const lacks = (prompt, ...texts) => texts.every((t) => !prompt.includes(t));

  const gone = await parkOf(NONE_FILES);
  ok(lacks(gone, LEDGER_LINE, AMENDED_LINE, LEDGER_CHECK, AMENDED_CHECK, 'Pass neither', 'so the block built from this entry reads'),
    'a park whose developers wrote neither file renders neither line and no rule about them');
  const dismissed = await parkOf({ ...NONE_FILES, dismissed_count: 1 });
  ok(dismissed.includes(LEDGER_LINE) && dismissed.includes(`Pass ${LEDGER_CHECK}, so the block built from this entry reads this block's declined findings.`)
    && lacks(dismissed, AMENDED_LINE, AMENDED_CHECK, '"- amended:" line, since'),
  'a park renders only the ledger line and its check when only DISMISSED was written');
  const amended = await parkOf({ ...NONE_FILES, plan_amendments: 1 });
  ok(amended.includes(AMENDED_LINE) && amended.includes(`Pass ${AMENDED_CHECK}, so the block built from this entry reads this block's plan amendments.`)
    && lacks(amended, LEDGER_LINE, LEDGER_CHECK, '"- ledger:" line, since'),
  'a park renders only the amended line and its check when only AMENDED was written');
  for (const [label, dev] of [['an earlier launch left a file', { ...NONE_FILES, earlier_files: true }], ['round 1 stopped at its plan', { ...NONE_FILES, plan_obtained: false }], ['round 1 returned no earlier_files', { ...NONE_FILES, earlier_files: undefined }]]) {
    const kept = await parkOf(dev);
    ok(kept.includes(`${LEDGER_LINE} ${AMENDED_LINE} Its --decision`)
      && kept.includes(`Pass ${LEDGER_CHECK}, and ${AMENDED_CHECK}, so the block built from this entry reads this block's declined findings and plan amendments.`),
    `a park renders both lines and both existence checks when ${label}`);
  }
}

section('a prompt drops the PULLED read when round 1 took no entry');
{
  const PRO_DEV = (list) => ({ ...DEV_OK, earlier_files: false, dismissed_count: 0, plan_amendments: 0, pulled_results: list });
  const rounds = (develop) => run({ develop, quality: CLEAN, acceptance: firstRound(ACC_FAIL, ACC_PASS) }, PRO_ONE_BLOCK);
  const READ_PULLED = `READ ${STATE}/PULLED-block-a.md if it exists.`;

  const none = await rounds(PRO_DEV([]));
  ok(flat(none.prompt('develop block-a r2')).includes(`PULLED ENTRIES. Round 1 took no backlog entry beside this block, so ${STATE}/PULLED-block-a.md lists none. Take no new entry, and report an empty pulled_results.`),
    'a later developer is told round 1 took none');
  ok(flat(none.prompt('acceptance block-a r1')).includes(`PULLED ENTRIES. ${STATE}/PULLED-block-a.md lists no entry, since the block's developer took none. Return an empty pulled_checks.`),
    'acceptance is told the PULLED file lists none');
  const took = await rounds(PRO_DEV([{ issue_id: PULL_A, status: 'FIXED' }]));
  ok(flat(took.prompt('develop block-a r2')).includes('when it exists, lists the backlog entries round 1 took') && flat(took.prompt('acceptance block-a r1')).includes(READ_PULLED),
    'a taken entry keeps both read steps');
  const unknown = await rounds({ ...PRO_DEV([]), pulled_results: undefined });
  ok(flat(unknown.prompt('acceptance block-a r1')).includes(READ_PULLED), 'a round-1 report with no pulled_results list keeps the read step');

  const parkArgs = { ...PRO_ONE_BLOCK, maxRounds: 1 };
  const parkNone = await run({ develop: PRO_DEV([]), quality: CLEAN, acceptance: ACC_FAIL }, parkArgs);
  const parkTook = await run({ develop: PRO_DEV([{ issue_id: PULL_A, status: 'FIXED' }]), quality: CLEAN, acceptance: ACC_FAIL }, parkArgs);
  ok(!flat(parkNone.prompt('park:block-a')).includes('4. RELEASE') && flat(parkTook.prompt('park:block-a')).includes('4. RELEASE, whatever steps 1 to 3 did.'),
    'a park whose round 1 took no entry drops its release step, and a park whose round 1 took one keeps it');
  const REVERT_NOTE = 'apart from the PULLED ENTRIES reverts';
  ok(!flat(parkNone.prompt('acceptance block-a r2')).includes(REVERT_NOTE) && flat(parkTook.prompt('acceptance block-a r2')).includes(REVERT_NOTE),
    'a closing acceptance names the pulled reverts only when round 1 took an entry');

  // A round 1 that stopped at its plan never reached its pull step, so its empty list proves nothing about an earlier launch's PULLED file.
  for (const [label, dev] of [['plan_obtained=false', { ...PRO_DEV([]), plan_obtained: false }], ['needs_user=true', { ...PRO_DEV([]), needs_user: true }]]) {
    const early = await run({ develop: dev, park: PARK_OK }, parkArgs);
    const earlyPark = flat(early.prompt('park:block-a'));
    ok(earlyPark.includes('4. RELEASE, whatever steps 1 to 3 did.'), `a park after a round 1 with ${label} and an empty pulled_results keeps its release step`);
  }
}

section('the developer, acceptance and park prompts tell the agent to use the file-editing tool, not a shell heredoc');
{
  const NOTE = 'Write file content with the file-editing tool, since a shell heredoc can alter backslashes and backticks.';
  const r = await run({ develop: DEV_OK, quality: CLEAN, acceptance: ACC_FAIL }, { ...ONE_BLOCK, maxRounds: 1 });
  for (const label of ['develop block-a r1', 'acceptance block-a r1', 'park:block-a']) {
    ok(flat(r.prompt(label)).includes(NOTE), `the ${label.split(/[ :]/)[0]} prompt carries the file-writing rule`);
  }
  ok(flat(r.prompt('develop block-a r1')).split(NOTE).length === 2, 'the developer prompt states it once');
}

section('a fix block whose entries continue no parked work skips the park-continuation text, and every other block keeps it');
{
  const RESTORE = 'First RESTORE unfinished work';
  const NO_RESTORE = 'No entry of this block continues a parked block\'s work, so report restore_failed "" and restored_branches 0, and go on to VERIFY-FIRST.';
  const ORIGIN = 'An entry with an "- origin:" line holds a parked block\'s unfinished work.';
  const LEDGER_BULLET = 'each file that the "- ledger:" line of an ACTIONABLE entry of this block names';
  const AMENDED_LINE = 'Also READ each file that the "- amended:" line of an ACTIONABLE entry of this block names.';
  const fixRun = (args) => run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, args);
  const promptsOf = (r, id) => ({ d: flat(r.prompt(`develop ${id} r1`)), a: flat(r.prompt(`acceptance ${id} r1`)) });
  const shows = ({ d, a }) => [d.includes(RESTORE), !d.includes(NO_RESTORE), a.includes(ORIGIN), a.includes(LEDGER_BULLET), a.includes(AMENDED_LINE)];

  const off = promptsOf(await fixRun({ ...FIX_ONE, plans: [{ ...FIX_ONE.plans[0], continues: false }] }), 'fix-a');
  eq(shows(off).join(','), 'false,false,false,false,false', 'continues false: no restore, origin, ledger or amended text, and the one-line skip instead');
  ok(off.d.includes(`fix this block's entries on top of the accepted baseline. ${NO_RESTORE}`), 'continues false: the developer still fixes on the accepted baseline');
  // A false that contradicts a "- branch:" entry would otherwise land and delete a branch round 1 never restored.
  const NO_LANDING = 'LANDED BRANCHES: round 1 restored no branch, since no entry of this block continues a parked block\'s work, so no branch landed. Delete no branch and return branches_kept=[].';
  ok(off.a.includes(`9. ${NO_LANDING}`) && !off.a.includes('LIST LANDED BRANCHES'), 'continues false: stage-mode acceptance lists no landed branch');
  const offCommit = flat((await run({ develop: { ...fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), baseline_staged_files: 0 }, quality: CLEAN, acceptance: { ...FIX_PASS, committed: true, commit_sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', commit_subject: 'fix-a', tree_matches: true, tree_clean: true } },
    { ...FIX_ONE, commit: true, plans: [{ ...FIX_ONE.plans[0], continues: false }] })).prompt('acceptance fix-a r1'));
  ok(offCommit.includes(`10. ${NO_LANDING}`) && !offCommit.includes('DELETE LANDED BRANCHES') && !/branch -D/.test(offCommit), 'continues false: commit-mode acceptance deletes no branch');
  const parkRun = (continues, superseded = []) => run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_OK, superseded_entries: superseded } },
    { ...FIX_ONE, maxRounds: 1, plans: [{ ...FIX_ONE.plans[0], continues }] });
  const parkOf = async (continues) => flat((await parkRun(continues)).prompt('park:fix-a'));
  const SUPERSEDE = 'Add `-p <its tip>` after the other parents for each RESTORED branch';
  const parkOff = await parkOf(false);
  ok(!parkOff.includes('This is a fix block, so its round 1 restored') && !parkOff.includes(SUPERSEDE) && !parkOff.includes('Then delete each RESTORED branch'),
    'continues false: the park takes no restored branch as a parent and deletes none');
  ok(parkOff.includes('Return superseded_entries=[], since round 1 restored no branch.') && !parkOff.includes('whenever step 1 makes no commit')
    && !parkOff.includes('When superseded_entries is not empty') && !parkOff.includes('in superseded_entries names') && !parkOff.includes('the pulled list is not empty'),
    'continues false: the park returns no superseded entry and carries no supersede or Pulled text');
  eq(syncOf((await parkRun(false, ['i-1'])).out), 'fix-a=backlogged,i-1=needs-attention', 'continues false: the engine ignores a superseded list the park returns anyway');
  ok((await parkOf(true)).includes(SUPERSEDE), 'continues true: the park still supersedes each restored branch');
  const BRANCH_HUNKS = 'When it also carries a "- branch:" line, the developer restored that branch\'s work';
  for (const [label, args] of [
    ['continues true', { ...FIX_ONE, plans: [{ ...FIX_ONE.plans[0], continues: true }] }],
    ['continues absent', FIX_ONE],
    ['proactive with continues true', { ...PRO_FIX_ONE, plans: [{ ...FIX_ONE.plans[0], continues: true }] }],
  ]) {
    const on = promptsOf(await fixRun(args), 'fix-a');
    eq(shows(on).join(','), 'true,true,true,true,true', `${label}: every park-continuation text renders`);
    ok(on.a.includes('9. LIST LANDED BRANCHES') && on.a.includes(BRANCH_HUNKS), `${label}: acceptance reads the restored hunks and lists the landed branches`);
  }

  // A pulled entry never carries a "- branch:" line, so a proactive block whose own entries continue nothing keeps only
  // the origin text, and drops that too once round 1 reports it pulled nothing.
  const proOff = { ...PRO_FIX_ONE, plans: [{ ...FIX_ONE.plans[0], continues: false }] };
  const proRun = (pulled) => run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }], { pulled_results: pulled.map((id) => ({ issue_id: id, status: 'FIXED' })) }),
    quality: CLEAN, acceptance: { ...FIX_PASS, pulled_checks: pulledChecks(pulled.map((id) => [id, true])) } }, proOff);
  const ORIGIN_NO_BRANCH = 'An ACTIONABLE entry with an "- origin:" line holds a parked block\'s unfinished work. On top of its branch\'s work, or on the accepted baseline when it carries no "- branch:" line, close the gaps its **What:** lists';
  const PULLED_ORIGIN = 'An entry you pull below may still carry an "- origin:" line, so the next two paragraphs apply to it.';
  const LEDGER_PARA = 'An ACTIONABLE entry\'s "- ledger:" line names the DISMISSED ledger of the parked block whose work it continues.';
  for (const [label, pulled] of [['a pulled entry', [PULL_A]], ['pulled_results []', []]]) {
    const r = await proRun(pulled);
    const { d, a } = promptsOf(r, 'fix-a');
    ok(d.includes(`fix this block's entries on top of the accepted baseline. ${NO_RESTORE} ${PULLED_ORIGIN} ${ORIGIN_NO_BRANCH}`) && d.includes(LEDGER_PARA),
      `proactive, continues false, ${label}: round 1 reports no restore, then names a pulled entry as the subject of the origin and ledger paragraphs`);
    ok(!d.includes(RESTORE) && !d.includes('which step b restored') && !d.includes('If the restore FAILS') && !d.includes('The restored diff is THIS block\'s own unstaged work'),
      `proactive, continues false, ${label}: round 1 carries no restore step, restored-diff sentence or restore-failure paragraph`);
    ok(!a.includes(BRANCH_HUNKS) && a.includes(`9. ${NO_LANDING}`) && !a.includes('LIST LANDED BRANCHES'), `proactive, continues false, ${label}: acceptance reads no restored hunk and lists no landed branch`);
    const keepsOrigin = pulled.length > 0;
    eq([a.includes(ORIGIN), a.includes(LEDGER_BULLET), a.includes(AMENDED_LINE), a.includes(pulledRegressionItem('fix-a'))].join(','), [keepsOrigin, keepsOrigin, keepsOrigin, keepsOrigin].join(','),
      `proactive, continues false, ${label}: acceptance ${keepsOrigin ? 'keeps' : 'drops'} the origin, ledger and amended text and the pulled regression item`);
  }
  const proPark = flat((await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: PARK_OK }, { ...proOff, maxRounds: 1 })).prompt('park:fix-a'));
  ok(!proPark.includes('This is a fix block, so its round 1 restored') && !proPark.includes(SUPERSEDE) && proPark.includes('Return superseded_entries=[], since round 1 restored no branch.'),
    'proactive, continues false: the park takes no restored branch as a parent and supersedes none');
  eq(syncOf((await run({ develop: fixDev([{ issue_id: 'i-1', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_GAP, park: { ...PARK_OK, superseded_entries: ['i-1'] } }, { ...proOff, maxRounds: 1 })).out),
    'fix-a=backlogged,i-1=needs-attention', 'proactive, continues false: the engine ignores a superseded list the park returns anyway');
  const passOf = (a, b) => ({ ...PASS_ARGS, plans: [{ ...PASS, blocks: [{ ...PASS.blocks[0], continues: a }, { ...PASS.blocks[1], continues: b }] }] });
  const passRun = (args) => run({ develop: passDev([{ issue_id: 'i-1', status: 'FIXED' }, { issue_id: 'i-2', status: 'FIXED' }, { issue_id: 'i-3', status: 'FIXED' }]), quality: CLEAN, acceptance: FIX_PASS }, args);
  eq(shows(promptsOf(await passRun(passOf(false, false)), 'fix-a-plus-1')).join(','), 'false,false,false,false,false', 'a pass whose every member continues nothing skips the text');
  eq(shows(promptsOf(await passRun(passOf(false, true)), 'fix-a-plus-1')).join(','), 'true,true,true,true,true', 'a pass with one continuing member renders the text');

  for (const [label, args] of [
    ['a row', { ...FIX_ONE, plans: [{ ...FIX_ONE.plans[0], continues: 'no' }] }],
    ['a pass member', { ...PASS_ARGS, plans: [{ ...PASS, blocks: [PASS.blocks[0], { ...PASS.blocks[1], continues: 0 }] }] }],
  ]) {
    const msg = await throwsWith(ENGINE, { args, respond: {} });
    ok(/plan continues value\(s\) \[/.test(msg) && /is not a boolean|are not a boolean/.test(msg), `a non-boolean continues on ${label} throws naming it: ${msg.slice(0, 90)}`);
  }
}
