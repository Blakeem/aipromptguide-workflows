// feature/feature-cycle.mjs — the roadmap loop.
// Focus: the terminal outcomes. Park-and-CONTINUE is what separates this engine from its migrate
// sibling, and every other exit is a status string the operator resumes from — so each is asserted
// whole rather than sniffed for a substring (the engine stopped sniffing prose too: see haltKind).
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/feature/feature-cycle.mjs';

const PLANS = [{ id: 'plan-a', plan: '## Feature\nA', gate: 'build-only' },
  { id: 'plan-b', plan: '## Feature\nB', gate: 'build-only' }];
const baseArgs = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' }, plans: PLANS };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

// Agent returns carrying every attestation the engine checks.
const DEV_OK   = { baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false };
const CLEAN    = { clean: true, issue_count: 0 };
const ACC_PASS = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 3, criteria_met: 3, evidence_recorded: true, gap_count: 0 };
const ACC_FAIL = { pass: false, staged: false, reachable: false, regression: false, criteria_total: 3, criteria_met: 1, evidence_recorded: true, gap_count: 2 };
const PARK_OK  = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };

section('a plan that never accepts is parked and the roadmap carries on');
// The whole point of clearing the tree: plan-b's blind reviewer sees a diff that is purely its own, so
// plan-a's failure costs plan-a only. Nothing is discarded — the patch path must reach the operator.
{
  const { out, labels } = await run({
    'develop': DEV_OK,
    'quality': CLEAN,
    'acceptance plan-a': ACC_FAIL,     // longest prefix wins over the plain 'acceptance' below
    'acceptance': ACC_PASS,
    'park': PARK_OK,
  });
  ok(labels.includes('park:plan-a'), 'plan-a was PARKED');
  ok(labels.some((l) => l.includes('plan-b')), 'the roadmap CONTINUED to plan-b');
  ok(out.halted === false, 'the run did not halt');
  eq(out.plansDone.join(), 'plan-b', 'plan-b is the only one done');
  eq(out.parked.length, 1, 'one entry in parked[]');
  ok(out.parked[0].patch?.endsWith('parked-plan-a.patch'), `patch path surfaced: ${out.parked[0].patch}`);
  eq(out.status, 'roadmap complete with 1 plan(s) parked', 'status counts the parked plan');
  ok(/PARKED: plan-a/.test(out.followups) && /git apply --3way/.test(out.followups),
    'followups names the parked plan and the restore command');
}

section('a developer escalation parks first, then stops the roadmap');
{
  const { out, labels, prompt } = await run({
    'develop': { ...DEV_OK, needs_user: true },
    'park': { ...PARK_OK, strays_saved: 2 },
  });
  ok(labels.includes('park:plan-a'), 'PARK ran on the halt path');
  eq(out.status, 'BLOCKED (needs user input)', 'status');
  ok(!labels.some((l) => l.includes('plan-b')), 'roadmap stopped — only the user can unblock it');
  ok(out.parked[0]?.strays?.endsWith('-newfiles'), `strays dir surfaced: ${out.parked[0]?.strays}`);
  // parked[] is keyed on the PATCH, not the status prose: an escalated plan keeps its BLOCKED status
  // and would otherwise have its patch path reported nowhere in the return.
  eq(out.parked[0].status, 'BLOCKED (needs user)', 'the escalated plan keeps its BLOCKED status');
  ok(/the tree is clean/.test(out.followups) && !/still holds/.test(out.followups),
    'followups says the tree is clean, never that it still holds the work');
  ok(/hit a BLOCKER the developer escalated/.test(prompt('park')), 'park prompt uses the escalation wording');
}

section('a dirty baseline halts without parking');
// Parking here would take the operator's own uncommitted changes hostage, and nothing was built anyway.
{
  const { out, calls, labels } = await run({ 'develop': { ...DEV_OK, baseline_dirty_files: 4 } });
  eq(calls.length, 1, 'only the developer ran — no reviewer spawned');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park the operator\'s changes');
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'status');
  eq(out.parked.length, 0, 'nothing in parked[]');
  ok(/4 file\(s\)/.test(out.haltReason), 'halt reason names the count');
}

section('acceptance that passed without staging halts without parking');
// The work is good and one `git add` both preserves it and cleans the tree — parking would be strictly
// worse. But the roadmap cannot advance onto an unstaged baseline either.
{
  const { out, labels } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': { ...ACC_PASS, staged: false } });
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park good accepted work');
  ok(!labels.some((l) => l.includes('plan-b')), 'roadmap did not advance past the broken staging boundary');
  eq(out.status, 'BLOCKED (a plan passed but was not staged — stage it, then resume)', 'status');
}

section('a park that cannot clear the tree halts the roadmap');
{
  const { out, labels } = await run({
    'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_FAIL,
    'park': { saved: true, cleared: false, gates_green: true, patch_bytes: 100, strays_saved: 0 },
  });
  ok(out.halted === true, 'halted rather than starting plan-b on a dirty tree');
  ok(!labels.some((l) => l.includes('plan-b')), 'plan-b never started');
  eq(out.status, 'BLOCKED (a parked plan left the tree unsafe — inspect before resuming)', 'status');
  ok(/IS saved to/.test(out.haltReason), 'halt reason confirms the work was still saved');
}

section('a self-contradictory park report halts and still surfaces the patch');
// saved=false with bytes on disk: the report is wrong, the patch is real. Never tell the operator
// nothing was saved when 4KB exists.
{
  const { out } = await run({
    'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_FAIL,
    'park': { saved: false, cleared: true, gates_green: true, patch_bytes: 4096, strays_saved: 0 },
  });
  eq(out.status, 'BLOCKED (a parked plan left the tree unsafe — inspect before resuming)', 'status');
  ok(/contradicts itself/.test(out.haltReason), 'halt reason says so');
  ok(out.parked[0].patch !== null, 'patch path surfaced, NOT reported as "nothing saved"');
}

section('acceptance that stages while reporting a regression halts the roadmap');
// The work is STAGED, so park may not touch it and a re-round would be invisible to the next blind
// reviewer. What stops is everything AFTER it: that diff is now the baseline later plans are judged on.
{
  const { out, labels } = await run({
    'develop': DEV_OK, 'quality': CLEAN, 'acceptance': { ...ACC_PASS, regression: true },
  });
  ok(out.halted === true, 'halted');
  ok(!labels.some((l) => l.startsWith('park')), 'did NOT park (the work is staged)');
  ok(!labels.some((l) => l.includes('plan-b')), 'roadmap did NOT continue onto a poisoned baseline');
  eq(out.status, 'BLOCKED (a plan staged while self-reporting a regression — inspect the staged diff before continuing)', 'status');
  eq(out.plansDone.join(), 'plan-a', 'the plan itself still counts as done (staged)');
}

section('acceptance that stages while reporting unreachable is only flagged');
// Same class of self-contradiction, but inert: an unreachable feature does not corrupt the baseline, so
// it is an audit flag rather than a halt.
{
  const { out, labels } = await run({
    'develop': DEV_OK, 'quality': CLEAN, 'acceptance': { ...ACC_PASS, reachable: false },
  });
  ok(out.halted === false, 'did NOT halt');
  ok(labels.some((l) => l.includes('plan-b')), 'roadmap continued');
  ok(out.ledger.every((r) => r.contradicted === true), 'every plan flagged contradicted in the ledger');
  eq(out.status, 'done (all plans staged)', 'status is still done');
}

section('a single top-level plan still returns the back-compat single-plan fields');
// One feature is the common invocation: no `plans` array, and the caller reads accepted/staged/rounds
// off the top level rather than digging through the ledger.
{
  const { out } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS },
    { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b' }, planPath: 'plans/one.md', gate: 'build-only' });
  eq(out.status, 'done (staged)', 'the one-plan status, not the roadmap one');
  eq(out.plansTotal, 1, 'the top-level plan was synthesized as one plan');
  ok(out.accepted === true && out.staged === true && out.reachable === true, 'solo fields populated');
  eq(out.rounds, 1, 'round count surfaced');
}

section('the token budget stops cleanly between plans');
{
  const { out, calls } = await run({}, baseArgs, { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(calls.length, 0, 'stopped before spawning anything');
  eq(out.status, 'stopped on token budget (resume where it left off)', 'status');
  ok(/startAt:"plan-a"/.test(out.haltReason), 'halt reason carries the resume point');
}

section('a partial slice builds only its plans and is never reported as done');
{
  const green = { 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS };
  const only = await run(green, { ...baseArgs, runOnly: ['plan-b'] });
  ok(!only.labels.some((l) => l.includes('plan-a')), 'runOnly skipped plan-a');
  eq(only.out.status, 'partial slice complete', 'runOnly status');
  const from = await run(green, { ...baseArgs, startAt: 'plan-b' });
  eq(from.out.plansDone.join(), 'plan-b', 'startAt built from plan-b to the end');
  eq(from.out.status, 'partial slice complete', 'startAt status');
}

section('a plan id matching nothing throws instead of building a smaller roadmap');
{
  for (const scope of [{ runOnly: ['nope'] }, { startAt: 'nope' }]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, ...scope } });
    ok(/nope/.test(msg) && /plan-a, plan-b/.test(msg),
      `${Object.keys(scope)[0]} "nope" throws and lists the valid ids: ${msg.slice(0, 60)}`);
  }
}

section('phase:"refine" refuses a roadmap-shaped args object');
// `plans` alone satisfies the top-level check, so refine would otherwise spawn the opus critic against
// an EMPTY plan reference — and get back a plausible verdict:"ready" for a plan it never saw.
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, phase: 'refine' } });
  ok(/roadmap array is NOT read/.test(msg), `throws instead of critiquing nothing: ${msg.slice(0, 60)}`);
  const { out, calls } = await run({ 'plan-critic': { verdict: 'needs-changes', gaps: [{ title: 'g', evidence: 'e' }], questions: [] } },
    { ...baseArgs, phase: 'refine', planPath: 'plans/one.md' });
  eq(calls.length, 1, 'one critic, and the phase stops there');
  eq(out.verdict, 'needs-changes', 'the verdict is returned, never written to a file');
  ok(/Fold the gap fixes/.test(out.nextStep), 'nextStep routes the gaps back into the plan file');
}

section('a dead plan critic throws — a review that never happened is not a clean plan');
// `verdict: critique?.verdict ?? 'ready'` made a dead critic byte-identical to a clean one: verdict
// "ready", 0 gaps, 0 questions, nextStep "Plan is sound". Refine is the ONLY gate on a plan before an
// autonomous developer builds against it, so that laundering did not degrade the review — it deleted it
// and reported success. The engine already guards the adjacent case (a critic spawned against an empty
// plan reference, above); this is the same bad outcome reached by the other door.
{
  const msg = await throwsWith(ENGINE, {
    args: { ...baseArgs, phase: 'refine', planPath: 'plans/one.md' },
    respond: { 'plan-critic': null },
  });
  ok(/skipped or died/.test(msg), `dead plan critic throws instead of reporting ready: ${msg.slice(0, 60)}`);
}

// The 'required args throw rather than silently defaulting' section (target.repo, gates.build,
// gates.test with a green plan, root, any plan) moved to required-args.test.mjs, which sweeps the same
// keys across EVERY engine — the axis this defect class actually travels on.

section('park never names a review file that was never written');
// The park entry in NEEDS-USER.md is the one record an operator reads days later. When a plan's gate
// never went green no reviewer ran, so there IS no review file — and the call site used to substitute a
// concrete `acceptance-review-<id>-rN.md` path, making parkPrompt's own "no review file yet" fallback
// unreachable and sending the user to a file that does not exist. (migrate had the identical bug.)
{
  const { prompt } = await run({
    'develop': { ...DEV_OK, build_passed: false },   // gate never green -> no reviewer ever runs
    'park': PARK_OK,
  });
  const p = prompt('park:plan-a');
  ok(p !== '', 'park still ran');
  ok(!/acceptance-review-plan-a-r\d+\.md/.test(p), 'no fabricated acceptance-review path in the prompt');
  ok(/produced NO review file/.test(p), 'the prompt says outright that no review file exists');
}

section('a roadmap block reaches the developer as a plan-block COMMAND, not the whole file');
// The context+truncation fix: bodyless entries address "## Plan: <id>" blocks in the top-level plan
// file. Handing over the file path would put every other feature in the developer's context AND let it
// stop at the first `## Feature` (plan bodies are all h2) with a truncated spec that looks complete.
{
  const ROADMAP = { ...baseArgs, planPath: 'E:/plans/roadmap.md', plans: [{ id: 'plan-a' }, { id: 'plan-b' }] };
  const { prompt } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS }, ROADMAP);
  const dev = prompt('develop plan-a');
  ok(/node 'E:\/r\/tools\/plan-block\.mjs' 'E:\/plans\/roadmap\.md' 'plan-a'/.test(dev), 'the command uses the <root>/tools default, this plan only, every path quoted');
  ok(!/plan-block\.mjs \S+ plan-b/.test(dev), 'and never a sibling plan');
  ok(/plan_obtained=false and STOP/.test(dev), 'a non-zero exit is reported through the schema, not guessed around');
  ok(/node 'E:\/r\/tools\/plan-block\.mjs' 'E:\/plans\/roadmap\.md' 'plan-a'/.test(prompt('acceptance plan-a')),
    'acceptance is handed the same block, so it judges the same criteria the developer built to');
  ok(!/plan-block|roadmap\.md/.test(prompt('quality plan-a')),
    'the BLIND reviewer still gets no route to any plan (#3)');
}

section('run-state pointed inside the target repo draws the placement warning');
// The blind reviewer is blind by PLACEMENT (#3): a root/stateDir inside target.repo lets it reach the
// review/ledger files. The engine warns loudly rather than halting (the operator may be mid-resume).
{
  const { logs } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS },
    { ...baseArgs, stateDir: 'E:/repo/runs/t' });
  ok(logs.some((l) => l.includes('INSIDE the target repo')), 'the warning names the placement hazard');
  ok(logs.some((l) => l.includes('never the plugin install dir')), 'and steers away from the version-swapped install dir');
}

section('args.blockTool points the block command at an installed plugin\'s own tools/ copy');
// An installed plugin splits ROOT (the persistent data dir run-state hangs off) from the versioned
// cache dir that ships tools/plan-block.mjs. Without the override the command names a file ROOT does
// not hold, exits non-zero, and halts the run on plan_obtained=false.
{
  const ROADMAP = { ...baseArgs, planPath: 'E:/plans/roadmap.md', plans: [{ id: 'plan-a' }],
    blockTool: 'C:\\plug\\cache\\aipg\\1.0.0\\tools\\plan-block.mjs' };
  const { prompt } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS }, ROADMAP);
  const dev = prompt('develop plan-a');
  ok(/node 'C:\/plug\/cache\/aipg\/1\.0\.0\/tools\/plan-block\.mjs' 'E:\/plans\/roadmap\.md' 'plan-a'/.test(dev),
    'the command uses the passed path, backslashes normalized');
  ok(!/E:\/r\/tools\/plan-block\.mjs/.test(dev), 'and not the ROOT default');
}

section('planContext:"full" hands the file instead — for a plan that needs its neighbours');
{
  const ROADMAP = { ...baseArgs, planPath: 'E:/plans/roadmap.md', plans: [{ id: 'plan-a', planContext: 'full' }] };
  const { prompt } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS }, ROADMAP);
  const dev = prompt('develop plan-a');
  ok(/"## Plan: plan-a" inside the roadmap at E:\/plans\/roadmap\.md/.test(dev), 'the block is named inside the file');
  ok(!/plan-block\.mjs/.test(dev), 'and no extraction command is issued');
}

section('a bodyless roadmap with no plan file THROWS before any agent is spawned');
// Previously ALL_PLANS kept the entry, planPath/plan both defaulted to '', and planRef emitted an empty
// fence — the developer built against nothing and the run reported success.
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [{ id: 'plan-a' }, { id: 'plan-b' }] } });
  ok(/plan-a, plan-b/.test(msg), 'the message names every bodyless plan');
  ok(/top-level planPath/.test(msg), 'and says how to fix it');
}

section('an agent that never got its plan halts the run — the attestation has a consumer');
// The block command runs in the AGENT's shell; the harness has no tools, so it cannot verify it. This
// field is the only signal the plan ever arrived. Without the halt, a denied command or an id matching
// no block builds something plausible and the run reports `done (staged)`.
{
  const { out, calls, labels } = await run({ 'develop': { ...DEV_OK, plan_obtained: false }, 'park': PARK_OK });
  ok(!labels.some((l) => l.startsWith('quality')), 'no reviewer was spawned on a plan nobody read');
  eq(out.status, 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)', 'status');
  ok(/could not obtain its plan/.test(out.haltReason), 'halt reason says what happened');
  ok(/plan-a/.test(out.haltReason), 'and names the plan');
  ok(calls.length >= 1, 'the developer did run');
}

section('the acceptance verifier has the same channel — a verdict without the spec is worthless');
// Its pass=false would otherwise read as an ordinary gap and park the plan, hiding "the spec never
// arrived" behind a routine round-budget failure.
{
  const { out } = await run({
    'develop': DEV_OK, 'quality': CLEAN,
    'acceptance': { ...ACC_FAIL, plan_obtained: false },
    'park': PARK_OK,
  });
  eq(out.status, 'BLOCKED (an agent could not obtain its plan — nothing was built from a guess)', 'status');
  ok(/Acceptance verifier/.test(out.haltReason), 'halt reason names the role');
}

section('a dead agent is NOT laundered into the plan_obtained halt');
// `=== false` on purpose: null must fall through to the existing guards, not become "never got it".
{
  const { out } = await run({ 'develop': null, 'park': PARK_OK });
  ok(!/could not obtain/.test(out.haltReason || ''), 'a dead developer takes a different path');
}

section('a non-kebab plan id throws — it names files AND enters a shell command');
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [{ id: 'Plan A!', plan: 'x' }] } });
  ok(/not kebab slugs/.test(msg), `throws: ${msg.slice(0, 60)}`);
  ok(/Plan A!/.test(msg), 'and names the offender');
}

section('a gate that never goes green surfaces the developer\'s own diagnostics');
// `gate_output`/`verification_method` were collected every round and read NOWHERE (attestation theater,
// tests/CLAUDE.md §3). The developer re-runs the gate live, so once the round budget is gone the run log
// holds the only copy of why it was red — the operator otherwise has to re-run the gate to find out.
{
  const DEV_RED = { ...DEV_OK, build_passed: false, verification_method: 'pytest -q tests/x.py', gate_output: 'E   assert 1 == 2\n1 failed' };
  const { logs } = await run({ 'develop': DEV_RED, 'park': PARK_OK }, { ...baseArgs, plans: [PLANS[0]], maxRounds: 2 });
  ok(logs.some((l) => /another develop round/.test(l) && /via=pytest -q tests\/x\.py/.test(l)),
    'the retry line names what was actually run');
  const budget = logs.find((l) => /not green at round budget/.test(l));
  ok(!!budget && /via=pytest -q tests\/x\.py/.test(budget) && /last gate output: E   assert 1 == 2/.test(budget),
    `the round-budget line carries the failing output: ${budget}`);
}
