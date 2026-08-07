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
const DEV_OK   = { baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false, plan_amendments: 0 };
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

section('the clean-baseline guard reads the VALUE, not what Number() makes of it');
// `Number(undefined)` is NaN and warns, but `Number(null)`, `Number(false)`, `Number('')` and
// `Number([])` are all 0 and all FINITE — so the coercing check read every one of them as "0 = clean"
// and waved the precondition through silently, after which the blind reviewer judges the operator's
// pre-existing work as this plan's and acceptance stages it into the accepted baseline.
{
  for (const bad of [null, false, '', []]) {
    const { logs } = await run({
      'develop': { ...DEV_OK, baseline_dirty_files: bad }, 'quality': CLEAN, 'acceptance': ACC_PASS,
    });
    ok(logs.some((l) => /precondition was NOT verified/.test(l)),
      `${JSON.stringify(bad)} is not silently a clean tree`);
  }
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
  ok(!logs.some((l) => l.includes('resolves inside the target repo')), 'and does not also fire the PLAN guard');
}

section('a plan file pointed inside the target repo draws its own placement warning');
// Same hazard as run-state, one door over: the plan carries the SPEC, so a planPath inside target.repo
// puts it where the blind reviewer can read it out of the repo tree and the park/diff machinery can sweep
// it. Warns rather than halting, same precedent. The substring is deliberately NOT the run-state guard's
// "INSIDE the target repo" — two guards that match one assertion prove nothing about either.
const planWarnings = (logs) => logs.filter((l) => l.includes('resolves inside the target repo'));
const GREEN = { 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS };
{
  // Top-level planPath. This site is unconditional top-level code, so the refine phase is covered too.
  const { logs } = await run(GREEN, { ...baseArgs, planPath: 'E:/repo/docs/plan.md' });
  const warn = planWarnings(logs);
  eq(warn.length, 1, 'exactly one plan-placement warning');
  ok((warn[0] ?? '').includes('E:/repo/docs/plan.md'), `it names the offending path: ${(warn[0] ?? '(none)').slice(0, 60)}`);
  ok(!logs.some((l) => l.includes('INSIDE the target repo')), 'and it is not the run-state guard firing');
}
{
  // A roadmap ENTRY's own planPath — the top-level file is outside, so only the entry can be the source.
  const ROADMAP = { ...baseArgs, planPath: 'E:/plans/roadmap.md',
    plans: [{ id: 'plan-a', planPath: 'E:/repo/plans/a.md', gate: 'build-only' },
      { id: 'plan-b', plan: '## Feature\nB', gate: 'build-only' }] };
  const warn = planWarnings((await run(GREEN, ROADMAP)).logs);
  eq(warn.length, 1, 'the offending entry warns, its inline sibling does not');
  ok((warn[0] ?? '').includes('E:/repo/plans/a.md'), `it names the entry path: ${(warn[0] ?? '(none)').slice(0, 60)}`);
}
{
  // The repo ROOT itself, reached through backslashes + a trailing slash — the check runs on the
  // abs()-normalized path, so neither separator style nor a trailing slash can dodge it.
  const warn = planWarnings((await run(GREEN, { ...baseArgs, planPath: 'E:\\repo\\' })).logs);
  eq(warn.length, 1, 'a plan path equal to the repo root itself warns, normalization and all');
  ok((warn[0] ?? '').includes('E:/repo'), 'and the path it names is the normalized one');
}
{
  // Back-compat: no `plans`, so ALL_PLANS synthesizes {id:'feature', planPath: A.planPath} — the SAME
  // path both guard sites see. Without the Set the operator gets the identical line twice.
  const { logs } = await run(GREEN, { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
    gates: { build: 'b', test: 't' }, planPath: 'E:/repo/docs/plan.md', gate: 'build-only' });
  eq(planWarnings(logs).length, 1, 'the single-plan back-compat case warns ONCE, not once per site');
}
{
  // Negative, FILE-BACKED: a plan outside the repo is the case the guard must stay silent on.
  const OUTSIDE = { ...baseArgs, planPath: 'E:/plans/roadmap.md', plans: [{ id: 'plan-a' }, { id: 'plan-b' }] };
  eq(planWarnings((await run(GREEN, OUTSIDE)).logs).length, 0, 'a plan file outside the repo draws nothing');
}
{
  // Negative, INLINE: no path exists to compare, so the skip is by construction rather than by check.
  eq(planWarnings((await run(GREEN)).logs).length, 0, 'an inline plan has no path — skipped by construction');
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
// `=== false` on purpose: null must fall through to the dead-agent guard above it, not become
// "never got it".
{
  const { out } = await run({ 'develop': null, 'park': PARK_OK });
  ok(!/could not obtain/.test(out.haltReason || ''), 'a dead developer takes a different path');
}

section('a dead round-loop agent halts and parks — never a "gate miss" or a clean review');
// The number-one defect shape (tests/CLAUDE.md §3) in the three per-round roles, and the twin of
// migrate-cycle's guards. Each was laundered into a success-shaped roadmap: a dead developer read as an
// ordinary gate miss and burned the round budget into `roadmap complete with 1 plan(s) parked`; a dead
// quality/acceptance set reviewPath to a review file nobody wrote, pointed the NEXT developer at it, and
// the run still ended `done (all plans staged)` on the strength of the rounds that did return.
{
  const DEAD = [
    ['developer', { 'develop': null, 'park': PARK_OK }, /Developer for plan plan-a/],
    ['quality reviewer', { 'develop': DEV_OK, 'quality': null, 'acceptance': ACC_PASS, 'park': PARK_OK }, /Quality reviewer for plan plan-a/],
    ['acceptance verifier', { 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': null, 'park': PARK_OK }, /Acceptance verifier for plan plan-a/],
  ];
  for (const [role, respond, names] of DEAD) {
    const { out, labels } = await run(respond);
    eq(out.status, 'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)', `a dead ${role} halts`);
    ok(names.test(out.haltReason) && /skipped or died/.test(out.haltReason), `the reason names the ${role}`);
    ok(/resumeFromRunId/.test(out.haltReason), 'and says how to replay it');
    ok(labels.includes('park:plan-a'), 'its work is PARKED, not abandoned in the tree');
    ok(!labels.some((l) => l.includes('plan-b')), 'the roadmap STOPPED — plan-b never started');
    eq(out.ledger[0].status, 'BLOCKED (agent died)', 'the ledger says the agent died, not "round budget"');
  }
}

section('a dead round-loop agent never points the next round at a review file nobody wrote');
{
  const { calls } = await run({ 'develop': DEV_OK, 'quality': null, 'acceptance': ACC_PASS, 'park': PARK_OK });
  ok(!calls.some((c) => c.label.startsWith('develop plan-a r2')), 'no second develop round after a dead reviewer');
  ok(!calls.some((c) => c.label.startsWith('park')
    && /quality-review-plan-a-r\d+\.md/.test(c.prompt)), 'and park names no phantom quality-review file');
}

section('a non-kebab plan id throws — it names files AND enters a shell command');
{
  const msg = await throwsWith(ENGINE, { args: { ...baseArgs, plans: [{ id: 'Plan A!', plan: 'x' }] } });
  ok(/not kebab slugs/.test(msg), `throws: ${msg.slice(0, 60)}`);
  ok(/Plan A!/.test(msg), 'and names the offender');
}

section('MATRIX case 6 is SPLIT: 6a fixes a VERIFIED plan defect, 6b keeps the old drop');
// The plan-defect wedge: a blind finding that indicts the PLAN's own prescription used to route to case
// 6 (DROP — LOG), the reviewer correctly re-raised it as CONTESTS DISMISSAL, and the round budget burned
// with neither side able to converge. 6a is the escape hatch, gated on the same evidence bar as any FIX.
{
  const { prompt } = await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS });
  const dev = prompt('develop plan-a');
  ok(/6a\. Conflicts with the plan AND you VERIFIED/.test(dev), '6a exists and is gated on verification');
  ok(/the verified defect outranks the\s+prescription/.test(dev), 'and says the verified defect outranks the prescription');
  ok(/that verified defect also outranks the "NO scope creep beyond\s+the plan" instruction above and the\s+CONVENTIONS rubric/.test(dev),
    'the PRECEDENCE clause names both lines that produced the observed wedge');
  ok(/Everywhere else the plan and the\s+conventions still bind/.test(dev), 'and confines the override to that one clause');
  ok(/6b\. Conflicts with the plan but you did NOT verify it/.test(dev), '6b keeps the unverified/intentional case a DROP');
  ok(/DROP \(1 or 6b\): append ONE terse line to E:\/r\/runs\/t\/gate\/DISMISSED-plan-a\.md/.test(dev),
    'and LOGGING re-points the DROP route at 6b, not the whole of 6');
  // Case 7 is unchanged: a plan-conflicting finding that is genuinely a user-only call still escalates.
  ok(/7\. A genuine DESIGN\/BUSINESS choice only the USER can make/.test(dev), 'ESCALATE (case 7) is untouched');
}

section('an amendment is RECORDED in a per-plan AMENDED file, with a pointer line for the user');
{
  const dev = (await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS })).prompt('develop plan-a');
  ok(/AMEND \(6a\): append ONE entry to E:\/r\/runs\/t\/AMENDED-plan-a\.md/.test(dev), 'the record is the per-plan AMENDED file');
  ok(/## Plan amendment: plan-a r1/.test(dev), 'the entry heading uses this engine\'s idiom and carries the round');
  ok(/QUOTED verbatim/.test(dev) && /file:line \+ one line on why it is\s+real/.test(dev) && /what you built instead/.test(dev),
    'the entry shape demands the overridden clause, the defect evidence and what was built');
  ok(/ONE POINTER line to E:\/r\/runs\/t\/NEEDS-USER\.md/.test(dev) && /NO plan text/.test(dev),
    'NEEDS-USER gets a pointer line only — no plan text travels with it');
  ok(/Count every entry you wrote in plan_amendments/.test(dev), 'and the count is reported through the schema');
}

const STATE = 'E:/r/runs/t';
/**
 * Every run-state path the BLIND quality reviewer's prompt discloses must sit under `runs/<runId>/gate/`.
 * Naming the state dir at all is a disclosure of everything IN it — `acceptance-review-<id>-rN.md`
 * enumerates the plan's acceptance criteria, `AMENDED-<id>.md` quotes the overridden plan clause verbatim,
 * and NEEDS-USER.md carries the pointer line naming that file — and #3 forbids relying on "please don't
 * read X". So the reviewer's own two files live one directory down, and this is the assertion that keeps a
 * later edit from interpolating a state-dir path back into the prompt.
 */
const stateRefsOutsideGate = (p) =>
  (p.match(/E:\/r\/runs\/t\/[^\s`'")]*/g) ?? []).filter((s) => !s.startsWith(`${STATE}/gate/`));

section('the quality reviewer is blind BY PLACEMENT — its prompt carries no run-state path outside gate/');
// WORKFLOW-PRINCIPLES.md #3: blindness is a property of what the agent is HANDED, not of a polite
// instruction. The AMENDED pointer line in NEEDS-USER.md was the live leak — one path to it and the blind
// critic reads the plan clause it quotes verbatim, and the unbiased first stage this engine is built on
// is gone.
{
  const q = (await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS })).prompt('quality plan-a');
  ok(q !== '', 'the blind reviewer ran');
  ok(q.includes(`${STATE}/gate/DISMISSED-plan-a.md`),
    'it IS given the anti-spin ledger — fresh, but not amnesiac (#5)');
  ok(q.includes(`${STATE}/gate/quality-review-plan-a-r1.md`), 'and its own output path, gate-scoped too');
  ok(!q.includes('NEEDS-USER.md'),
    'but NOT NEEDS-USER: its amendment pointer line names the AMENDED file, which quotes the plan verbatim');
  eq(stateRefsOutsideGate(q).join(', '), '',
    'and no run-state path outside gate/ — not the state dir itself, which would disclose the plan-bearing files in it');
}

section('taking NEEDS-USER off the blind reviewer re-routes case 7 through the ledger it still reads');
// Consequence of the placement above, and the half that is easy to forget: case 7's PROCEEDING branch
// (needs_user=false) leaves the developer's defensible default sitting in the diff, and it used to be
// silenced by NEEDS-USER.md — the file the blind critic no longer gets. With nothing in the gate-scoped
// ledger it flags that default, the developer re-routes it to case 7 (still a user-only call), no code
// changes, and the pair spins to maxRounds: a plan that used to accept PARKS. The anti-spin channel (#5)
// has to reach the reviewer through the ONE file it is still handed.
{
  const dev = (await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS })).prompt('develop plan-a');
  ok(/ESCALATE \(7\)[\s\S]*?append ONE terse line to E:\/r\/runs\/t\/gate\/DISMISSED-plan-a\.md/.test(dev),
    'case 7 proceeding also writes the gate-scoped ledger, the only settled-decisions file the blind reviewer is handed');
  ok(/ESCALATED: <the default you took/.test(dev), 'and the line states the default that was taken, not just that it escalated');
  ok(/the blind reviewer is NOT shown E:\/r\/runs\/t\/NEEDS-USER\.md/.test(dev),
    'with the reason attached, so the two halves cannot drift apart again');
}

section('the AMENDED record never reaches the BLIND reviewer, and SETTLED hands it the gate ledger alone');
// Same placement rule as the plan itself (#3): the blind critic must learn nothing about the spec, and
// an amendment quotes the spec verbatim. Mirrors the no-route-to-plan assertion above.
{
  const q = (await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS })).prompt('quality plan-a');
  ok(q !== '', 'the blind reviewer ran');
  ok(!/AMENDED/.test(q) && !/amendment/i.test(q), 'the blind quality prompt gains no AMENDED path and no mention of one');
  ok(/E:\/r\/runs\/t\/gate\/DISMISSED-plan-a\.md/.test(q) && !/NEEDS-USER/.test(q),
    'SETTLED hands it the gate-scoped DISMISSED ledger and nothing else');
  const a = (await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS })).prompt('acceptance plan-a');
  ok(/E:\/r\/runs\/t\/gate\/DISMISSED-plan-a\.md/.test(a) && /E:\/r\/runs\/t\/NEEDS-USER\.md/.test(a),
    'while the plan-aware verifier still reads both settled-decision files');
  ok(!/CONTESTS DISMISSAL/.test(a),
    'and loses the contest paragraph — ACCEPTANCE_SCHEMA has no contest field, so it reported nothing');
  ok(/CONTESTS DISMISSAL/.test(q), 'the blind reviewer, whose schema DOES carry one, keeps it');
}

section('acceptance judges an amended criterion against the AMENDED behavior — with evidence or not at all');
{
  const a = (await run({ 'develop': DEV_OK, 'quality': CLEAN, 'acceptance': ACC_PASS })).prompt('acceptance plan-a');
  ok(/READ E:\/r\/runs\/t\/AMENDED-plan-a\.md if it exists/.test(a), 'acceptance is told to read the record');
  ok(/against the AMENDED behavior, not the superseded clause/.test(a), 'and to judge the amended criterion against what was built');
  ok(/NAME every criterion you\s+judged under an amendment in your review file/.test(a), 'each such criterion must be named in the review file');
  ok(/states NO defect evidence excuses\s+NOTHING/.test(a) && /stays UNMET/.test(a),
    'an evidence-free amendment excuses nothing — the escape hatch is not a free pass');
}

section('a recorded amendment is logged, counted into the ledger and named in followups; zero is silent');
// `plan_amendments` is REQUIRED rather than optional so "none" is an explicit claim — which only means
// something if the harness reads it (attestation theater, tests/CLAUDE.md §3).
{
  const one = await run({ 'develop': { ...DEV_OK, plan_amendments: 1 }, 'quality': CLEAN, 'acceptance': ACC_PASS });
  ok(one.logs.some((l) => /⚠ plan-a r1: 1 plan amendment\(s\) recorded — see E:\/r\/runs\/t\/AMENDED-plan-a\.md/.test(l)),
    `the amendment is logged with the file that holds it: ${one.logs.find((l) => /amendment/.test(l))}`);
  eq(one.out.ledger[0].planAmendments, 1, 'accumulated into the plan\'s ledger record');
  ok(/PLAN AMENDED for: plan-a, plan-b/.test(one.out.followups), 'and followups names every amended plan');

  const none = await run({ 'develop': { ...DEV_OK, plan_amendments: 0 }, 'quality': CLEAN, 'acceptance': ACC_PASS });
  ok(!none.logs.some((l) => /plan amendment\(s\) recorded/.test(l)), 'a zero report logs nothing at all');
  eq(none.out.ledger[0].planAmendments, 0, 'the ledger rec still carries the field, initialized in its literal');
  ok(!/PLAN AMENDED/.test(none.out.followups), 'and followups says nothing about amendments');
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
