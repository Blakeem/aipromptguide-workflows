// gauntlet/gauntlet-cycle.mjs — phase:"mvp": build -> BLIND code gate (stages on clean) -> next component;
// phase:"refine": per wave, per open aspect: critic -> improve, then ONE blind code gate over the wave diff.
// Failure paths only: the happy path is what a real run exercises constantly, and tools/flows/gauntlet.flow.mjs
// already walks every terminal. What is here is the set of collapses that would each report a broken run as a
// finished one — a dead agent read as a verdict, a halt that leaves work in the tree, a review path handed
// over for a file nobody wrote, and the blind gate learning what it is reviewing.
import { runEngine, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/gauntlet/gauntlet-cycle.mjs';

const CANON = 'E:/flow/plans/t/CANON.md';
const BAR = 'E:/flow/plans/t/BAR.md';
const COMPONENTS_MD = 'E:/flow/plans/t/COMPONENTS.md';
const baseArgs = {
  runId: 't',
  root: 'E:/flow',
  target: { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' },
  gates: { build: 'npm run build', test: 'npm test' },
  canonPath: CANON,
  barPath: BAR,
  componentsPath: COMPONENTS_MD,
  components: [{ id: 'comp-a', gate: 'green' }, { id: 'comp-b', gate: 'green' }],
};
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

const BUILD_OK = { spec_obtained: true, baseline_dirty_files: 0, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, env_blocked: false, settled_appended: 0 };
const CLEAN = { clean: true, issue_count: 0, staged: true, wrote_file: true, contested_dismissals: 0 };
const FLAGGED = { clean: false, issue_count: 2, staged: false, wrote_file: true, contested_dismissals: 0 };
const PARK_OK = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };

const STATE = 'E:/flow/runs/t';
/**
 * Every run-state path the BLIND gate's prompt discloses must sit under `runs/<runId>/gate/`. Naming the
 * state dir at all is a disclosure of everything IN it — `critique-<aspect>-wN.md` IS the wave's spec (the
 * named gap, the A/B against the bar, what "closed" looks like) and SETTLED.md is the design record — and
 * #3 forbids relying on "please don't read X". So the gate's own two files live one directory down, and
 * this is the assertion that keeps a later edit from interpolating a state-dir path back into the prompt.
 */
const stateRefsOutsideGate = (p) =>
  (p.match(/E:\/flow\/runs\/t\/[^\s`'")]*/g) ?? []).filter((s) => !s.startsWith(`${STATE}/gate/`));

section('the code gate is blind BY PLACEMENT — its prompt carries no route to the goal');
// WORKFLOW-PRINCIPLES.md #3: blindness is a property of what the agent is HANDED, not of a polite
// instruction. One interpolated canon path and the gate is reviewing against the spec like every other
// reviewer, and the second opinion this workflow is built on is gone.
{
  const { prompt } = await run({ build: BUILD_OK, 'code-gate': CLEAN });
  const gate = prompt('code-gate');
  ok(gate !== '', 'the code gate ran');
  ok(!gate.includes(CANON), 'no CANON.md path');
  ok(!gate.includes(BAR), 'no BAR.md path');
  ok(!gate.includes(COMPONENTS_MD), 'no COMPONENTS.md path');
  ok(!gate.includes('plan-block.mjs'), 'and no block command it could run to fetch the spec itself');
  ok(gate.includes(`${STATE}/gate/DISMISSED-comp-a.md`),
    'it IS given the anti-spin ledger — fresh, but not amnesiac (#5)');
  ok(!gate.includes('NEEDS-USER.md'),
    'but NOT NEEDS-USER: park records and env faults are nothing it reviews, and it sits beside the critiques');
  eq(stateRefsOutsideGate(gate).join(', '), '',
    'and no run-state path outside gate/ — not the state dir itself, which would disclose the critiques in it');

  // The other half of #5: a reviewer handed its own last round anchors on that one finding and misses the
  // similar bug two lines away. Round 2's gate is given ONLY the path it must write.
  const second = await run({
    build: BUILD_OK,
    'code-gate': (label) => (/r1$/.test(label) ? FLAGGED : CLEAN),
    park: PARK_OK,
  });
  const r2 = second.prompt('code-gate comp-a r2');
  ok(r2.includes(`${STATE}/gate/code-review-comp-a-r2.md`), 'round 2 is given its own output path');
  ok(!r2.includes('code-review-comp-a-r1.md'), 'and never round 1\'s review file');
}

section('a dirty tree halts before the code gate spawns, and parks NOTHING');
// The unstaged diff IS the gate's scope, so pre-existing work would be reviewed and judged as this run's.
// It must NOT be parked either: that work is the operator's, and parking takes their changes hostage.
{
  const { out, labels } = await run({ build: { ...BUILD_OK, baseline_dirty_files: 3 } });
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'its own status');
  ok(!labels.some((l) => l.startsWith('code-gate')), 'no code gate was spawned');
  ok(!labels.some((l) => l.startsWith('park')), 'and nothing was parked');
  ok(out.parked.length === 0, 'the parked list is empty');
  ok(/git -C E:\/repo add -A/.test(out.haltReason) && /stash -u/.test(out.haltReason),
    'and the reason names both one-command fixes');
}

section('a dead builder halts and parks — it is not an ordinary gate miss');
// Unguarded, a null builder falls into `gateOk(!dev) === false`, burns the whole round budget and parks as
// "did not pass", pointing the operator at the component spec when the real action is a replay.
{
  const { out, labels } = await run({ build: null, park: PARK_OK });
  eq(out.status, 'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)', 'the dead-agent status');
  eq(labels.filter((l) => l.startsWith('build')).length, 1, 'one build round, not the whole budget');
  ok(labels.includes('park:comp-a'), 'its work is parked rather than left in the tree');
  ok(/resumeFromRunId/.test(out.haltReason), 'and the reason says how to replay it');
}

section('a dead code gate is not a clean review, and nothing is staged');
{
  const { out, ledger } = await run({ build: BUILD_OK, 'code-gate': null, park: PARK_OK })
    .then((r) => ({ ...r, ledger: r.out.ledger }));
  eq(out.status, 'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)', 'the dead-agent status');
  ok(out.componentsDone.length === 0, 'no component is reported done');
  ok(ledger[0].staged === false, 'and the ledger does not claim it staged');
}

section('a builder that never got its spec halts on its OWN status, before the code gate');
// The block command runs in the agent's shell, so this attestation is the only signal the spec arrived.
// `=== false`, so a DEAD builder (null) is caught by the death guard above instead of being laundered here.
{
  const { out, labels } = await run({ build: { ...BUILD_OK, spec_obtained: false }, park: PARK_OK });
  eq(out.status, 'BLOCKED (an agent could not obtain its component spec — nothing was built from a guess)', 'its own status');
  ok(!labels.some((l) => l.startsWith('code-gate')), 'no code gate was spawned');
  ok(labels.includes('park:comp-a'), 'work it may have started is parked');
  ok(out.haltReason.includes('--kind component'), 'and the reason quotes the command to run by hand');
}

section('an environment fault is the ONE escalation, and it has its own status');
// Everything else the builder settles itself (#7 adapted: there is no user in this loop). Folding an env
// fault into "could not pass" would send the operator to sharpen a spec when a credential is missing.
{
  const { out, labels } = await run({ build: { ...BUILD_OK, env_blocked: true }, park: PARK_OK });
  eq(out.status, 'BLOCKED (environment fault — see NEEDS-USER.md)', 'its own status');
  ok(labels.includes('park:comp-a'), 'the work in the tree is parked, not abandoned');
  ok(/NEEDS-USER\.md/.test(out.haltReason), 'and the reason points at the write-up');
}

section('a flagged review the gate did not confirm writing is never handed to the next builder');
// The review file IS the message to the next round (#2). Handing over a path to a file nobody wrote is the
// defect migrate shipped in its park record: the builder is told to READ a file that does not exist.
{
  const { logs, prompt } = await run({
    build: BUILD_OK,
    'code-gate': (label) => (/r1$/.test(label) ? { ...FLAGGED, wrote_file: false } : CLEAN),
    park: PARK_OK,
  });
  const r2 = prompt('build comp-a r2');
  ok(r2 !== '', 'round 2 ran');
  ok(!r2.includes('code-review-comp-a-r1.md'), 'round 2 is NOT pointed at the unwritten review file');
  ok(logs.some((l) => /did NOT confirm writing/.test(l)), 'and the missing write is logged');
}

section('the builder is told WHICH kind of round it is — red gates and an unwritten review are not the same');
// An empty reviewPath has two producers: the gates were red (the gate never ran), and the gate flagged the
// diff but did not confirm writing its file. Collapsing them told a builder the gates were red when the
// round had reached the gate only by passing them — so it re-ran a green gate, had no stated task, and the
// next gate re-found the same findings on an unchanged diff: two opus spawns and two rounds of the budget.
{
  const flaggedNoFile = await run({
    build: BUILD_OK,
    'code-gate': (label) => (/r1$/.test(label) ? { ...FLAGGED, wrote_file: false } : CLEAN),
    park: PARK_OK,
  });
  const r2 = flaggedNoFile.prompt('build comp-a r2');
  ok(!r2.includes('was not green'), 'a green tree is never described as red');
  ok(/THE GATES ARE GREEN/.test(r2) && /QUALITY FRAME/.test(r2),
    'it is told the gates are green and to re-check its own diff against the frame');

  const redGates = await run({ build: { ...BUILD_OK, build_passed: false }, park: PARK_OK },
    { ...baseArgs, maxRounds: 2, components: [{ id: 'comp-a', gate: 'green' }] });
  ok(redGates.prompt('build comp-a r2').includes('was not green'),
    'and a genuinely red tree still gets the red-gate brief');
}

section('a confirmed review IS handed over, verbatim by path');
{
  const { prompt } = await run({
    build: BUILD_OK,
    'code-gate': (label) => (/r1$/.test(label) ? FLAGGED : CLEAN),
    park: PARK_OK,
  });
  ok(prompt('build comp-a r2').includes(`${STATE}/gate/code-review-comp-a-r1.md`),
    'round 2 reads exactly the file round 1 wrote');
}

section('a clean gate that did not stage HALTS, parks nothing, and still reports the component done');
// The work is ACCEPTED — so nothing is parked and `interrupted` stays false — but the staging boundary was
// never drawn. Continuing is what this engine used to do and it cannot work: the NEXT component's round-1
// builder counts these same files as ITS dirty baseline and halts one opus spawn later under
// `dirty-baseline`, whose text blames the operator for dirt this run created.
{
  const { out, labels, logs } = await run({ build: BUILD_OK, 'code-gate': { ...CLEAN, staged: false } });
  eq(out.status, 'BLOCKED (a component passed clean but was not staged — stage it, then resume from the next component)',
    'its own terminal, not the dirty-baseline one the next component would have reached');
  ok(logs.some((l) => /did NOT confirm staging/.test(l)), 'the log says so');
  ok(out.ledger[0].staged === false, 'the ledger records it');
  ok(/NOT staged/.test(out.ledger[0].status), 'and the component status does not read as a plain "done (staged)"');
  ok(out.componentsDone.includes('comp-a'), 'the component is still DONE — accepted work, missing only its boundary');
  ok(!labels.some((l) => l.includes('comp-b')), 'comp-b never starts on a tree still holding comp-a\'s diff');
  ok(!labels.some((l) => l.startsWith('park')), 'and nothing is parked — accepted work is never parked');
  eq(out.parked.length, 0, 'the parked list is empty');
  ok(/git -C E:\/repo add/.test(out.haltReason) && /startAt:"comp-b"/.test(out.haltReason),
    'the reason names the stage command and the component to resume from');
}

section('a component that cannot pass parks AND STOPS — the next component is never attempted');
// The asymmetry vs feature-cycle: components decompose ONE product, so component N+1 builds on N having
// landed (migrate-cycle's rule). Continuing would build the next component on a baseline that never arrived.
{
  const { out, labels } = await run({ build: BUILD_OK, 'code-gate': FLAGGED, park: PARK_OK });
  eq(out.status, 'BLOCKED (component parked — MVP incomplete; resolve before refining)', 'the parked status');
  ok(!labels.some((l) => l.includes('comp-b')), 'comp-b was never started');
  eq(out.parked.length, 1, 'one parked component');
  eq(out.parked[0].patch, 'E:/flow/runs/t/parked-comp-a.patch', 'and its patch path is reported');
}

section('every park contradiction reaches the park-unsafe status rather than a plain park');
// A tree park could not clear, a report that contradicts itself, and a red build after clearing are three
// different operator problems from a clean park — and each leaves the repo unsafe to resume into.
{
  const UNSAFE = 'BLOCKED (a parked component left the tree unsafe — inspect before resuming)';
  const notCleared = await run({ build: BUILD_OK, 'code-gate': FLAGGED, park: { ...PARK_OK, cleared: false } });
  eq(notCleared.out.status, UNSAFE, 'cleared=false');
  ok(/could NOT be cleared/.test(notCleared.out.haltReason), 'and the reason says which');

  const contradictory = await run({ build: BUILD_OK, 'code-gate': FLAGGED, park: { ...PARK_OK, saved: false, patch_bytes: 4096 } });
  eq(contradictory.out.status, UNSAFE, 'saved=false with bytes on disk');
  ok(/contradicts itself/.test(contradictory.out.haltReason), 'and the reason says the patch is real');
  eq(contradictory.out.parked[0].patch, 'E:/flow/runs/t/parked-comp-a.patch',
    'the patch is still named — telling the user nothing was saved would be actively wrong');

  const redBuild = await run({ build: BUILD_OK, 'code-gate': FLAGGED, park: { ...PARK_OK, gates_green: false } });
  eq(redBuild.out.status, UNSAFE, 'gates_green=false');
  ok(/BUILD is RED/.test(redBuild.out.haltReason), 'and the reason names the red build');
}

section('a park with nothing to save is reported as such, not as a patch that exists');
{
  const { out } = await run({
    build: BUILD_OK, 'code-gate': FLAGGED,
    park: { saved: false, cleared: true, gates_green: true, patch_bytes: 0, strays_saved: 0, notes: 'git diff was already empty' },
  });
  eq(out.parked[0].patch, null, 'no patch path is invented');
  eq(out.status, 'BLOCKED (component parked — MVP incomplete; resolve before refining)', 'and it is still an ordinary park');
}

section('the token floor stops CLEANLY between components, with a resume instruction');
{
  const { out, labels } = await run({ build: BUILD_OK, 'code-gate': CLEAN, park: PARK_OK }, baseArgs,
    { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(out.status, 'stopped on token budget (resume where it left off)', 'the budget status');
  eq(labels.length, 0, 'no agent was spawned at all');
  ok(/startAt:"comp-a"/.test(out.haltReason), 'and the reason says exactly how to resume');
}

section('the round budget is per component, and the gate never sees a red build');
// A build that is not green re-develops with NO code gate spawned: reviewing a diff that does not compile
// spends an opus pass on findings the build already reported.
{
  const { labels, out } = await run({ build: { ...BUILD_OK, build_passed: false }, park: PARK_OK },
    { ...baseArgs, maxRounds: 2, components: [{ id: 'comp-a', gate: 'green' }] });
  eq(labels.filter((l) => l.startsWith('build')).length, 2, 'exactly maxRounds build rounds');
  ok(!labels.some((l) => l.startsWith('code-gate')), 'and the code gate was never spawned');
  ok(/produced no review file/.test(out.haltReason), 'the park record admits there is no review to read');
}

section('a gate:"build-only" component passes on the BUILD alone — and only after the build is green');
// The one line that lets a component be ACCEPTED and STAGED with zero tests executed. Every other case in
// this file is gate:"green", so nothing reached it: move that early return above the build check and a RED
// build would stage, with every assertion here still passing. This is tests/CLAUDE.md §1's recorded family
// ("gates.build unvalidated -> build-only auto-passes"), pinned for gauntlet.
{
  const buildOnlyArgs = { ...baseArgs, gates: { build: 'npm run build' }, components: [{ id: 'comp-a', gate: 'build-only' }] };
  const NO_TESTS = { ...BUILD_OK, test_outcome: 'not-run', tests_run_count: 0, full_suite_outcome: 'not-run' };

  const passed = await run({ build: NO_TESTS, 'code-gate': CLEAN }, buildOnlyArgs);
  eq(passed.out.status, 'done (MVP staged)', 'a green build with nothing tested is enough for this gate');

  const red = await run({ build: { ...NO_TESTS, build_passed: false }, 'code-gate': CLEAN, park: PARK_OK }, buildOnlyArgs);
  eq(red.out.status, 'BLOCKED (component parked — MVP incomplete; resolve before refining)',
    'a RED build is not — build-only relaxes the TESTS, never the build');
  ok(!red.labels.some((l) => l.startsWith('code-gate')), 'and no code gate was ever spawned on it');
}

// =============================================================================
// phase:"refine" — the wave loop. Same rule as above: only the collapses.
// =============================================================================
const ASPECTS_MD = 'E:/flow/plans/t/ASPECTS.md';
const refineArgs = {
  runId: 't',
  root: 'E:/flow',
  phase: 'refine',
  target: { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' },
  gates: { build: 'npm run build', test: 'npm test' },
  canonPath: CANON,
  barPath: BAR,
  aspectsPath: ASPECTS_MD,
  aspects: [{ id: 'aspect-a' }, { id: 'aspect-b' }],
  cycles: 1,
};
const refine = (respond, args = refineArgs, budget) => runEngine(ENGINE, { args, respond, budget });

const BEHIND = { wrote_file: true, status: 'behind', gap_actionable: true, canon_violation: false, additive: false, contested_settled: 0, baseline_dirty_files: 0, env_blocked: false };
const IMPROVED = { build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, env_blocked: false, settled_appended: 1, gap_addressed: true, declined: false };

section('refine needs NONE of the mvp inputs — it is an entry point of its own');
// The refine-only shape: a product this run never built, no COMPONENTS.md, no components array. If any mvp
// input crept into refine's required set, this run would throw instead of climbing.
{
  const { out, labels } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN });
  ok(labels[0] === 'critic aspect-a w1', 'the first agent is a critic, not a builder');
  eq(out.phase, 'refine', 'and it reports the refine phase');
  eq(out.status, 'cycles spent (2 aspect(s) open — resume with more cycles)', 'ending on the wave budget');
}

section('a dead critic is NOT an "achieved" verdict — the aspect stays open');
// The sharpest collapse in this phase: a critic's verdict CLOSES an aspect for the whole run, so a null
// falling through the status routing as "not behind" retires an aspect nobody looked at, and a climb that
// lost an agent reports as one that reached the bar.
{
  const { out, labels } = await refine({ critic: null, improve: IMPROVED, 'code-gate': CLEAN, park: PARK_OK });
  eq(out.status, 'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)', 'the dead-agent status');
  eq(out.aspectsClosed.length, 0, 'no aspect is reported closed');
  eq(out.aspectsOpen.join(','), 'aspect-a,aspect-b', 'both stay open');
  ok(!labels.some((l) => l.startsWith('improve')), 'and no improver was spawned on a gap nobody named');
  ok(!labels.some((l) => l.startsWith('park')), 'nothing is parked: no improver ran, so the tree holds nothing of ours');
}

section('a critic that returns no usable status does not close the aspect either');
// One step short of death, and the same absorbing shape: a malformed return must not retire an aspect.
{
  const { out, labels, logs } = await refine({ critic: { ...BEHIND, status: 'good-enough' }, improve: IMPROVED, 'code-gate': CLEAN });
  eq(out.aspectsClosed.length, 0, 'nothing closed on a status outside the enum');
  ok(labels.includes('improve aspect-a w1'), 'it is taken as BEHIND, so the improver still runs');
  ok(logs.some((l) => /not behind\|achieved\|saturated/.test(l)), 'and the log names the value it refused');
}

section('"achieved" alongside a canon violation is contradictory, and read as BEHIND');
// The critic's own instructions make a canon break the largest gap by definition, so the two cannot both
// be true. Closing would retire the aspect for the whole run on a verdict that contradicts itself.
{
  const { out, labels, logs } = await refine({
    critic: { ...BEHIND, status: 'achieved', canon_violation: true },
    improve: IMPROVED, 'code-gate': CLEAN,
  });
  eq(out.aspectsClosed.length, 0, 'the aspect is NOT closed');
  ok(labels.includes('improve aspect-a w1'), 'an improver is spawned on the canon break');
  ok(logs.some((l) => /achieved WITH canon_violation/.test(l)), 'and the contradiction is logged');
}

section('a dirty tree halts the refine entry point before anything is improved, and parks NOTHING');
// refine is an entry point, so no builder ran ahead of it — the FIRST critic carries STEP 0. The wave gate
// STAGES what it clears, so pre-existing work would be folded into the accepted baseline. That work is the
// operator's: parking it would take their changes hostage.
{
  const { out, labels } = await refine({ critic: { ...BEHIND, baseline_dirty_files: 4 }, improve: IMPROVED });
  eq(out.status, 'BLOCKED (working tree was not clean — nothing was built)', 'its own status');
  ok(!labels.some((l) => l.startsWith('improve')), 'no improver was spawned');
  ok(!labels.some((l) => l.startsWith('park')), 'and nothing was parked');
  eq(out.parked.length, 0, 'the parked list is empty');
  ok(/git -C E:\/repo add -A/.test(out.haltReason) && /stash -u/.test(out.haltReason),
    'and the reason names both one-command fixes');
}

section('the clean-tree attestation is REQUIRED of every critic, so the halt above cannot be opted out of');
// The halt above is the ONLY thing standing between the operator's pre-existing work and this run's
// staging/park machinery, and its consumer reads an ABSENT baseline_dirty_files as "not verified, carry on"
// (deliberate parity with mvp's builder). So `required` is what makes the guard a guard: leave it out and a
// schema-valid critic that simply omits the field downgrades the halt to a warning line, after which the
// wave gate stages the operator's changes as this run's. Asserted on the schema OBJECT the runtime is
// handed, never on the source text — a grep cannot tell which role's schema it matched.
{
  const { calls } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN });
  const critic = calls.find((c) => c.label.startsWith('critic'));
  ok(critic, 'the critic ran');
  ok(critic.opts.schema.required.includes('baseline_dirty_files'),
    'and its schema cannot come back without the attestation');

  // The mvp builder is the twin: it consumes the field identically and downgrades an ABSENT one to a
  // warning line, so `required` is the whole guard there too. static.test.mjs's sweep only proves a field
  // is READ, never that it is required — leave it out of the builder's schema and the suite stays green
  // while the blind gate stages the operator's pre-existing work as this run's accepted baseline.
  const mvp = await run({ build: BUILD_OK, 'code-gate': CLEAN });
  const builder = mvp.calls.find((c) => c.label.startsWith('build'));
  ok(builder, 'the mvp builder ran');
  ok(builder.opts.schema.required.includes('baseline_dirty_files'),
    'and its schema cannot come back without the same attestation');
}

section('a critique the critic did not confirm writing is never handed to its improver');
// The critique file IS the improver's whole brief (#2). Handing over a path to a file nobody wrote tells it
// to READ something that does not exist — the defect migrate shipped in its park record.
{
  const { prompt, logs } = await refine({
    critic: { ...BEHIND, wrote_file: false }, improve: IMPROVED, 'code-gate': CLEAN,
  });
  const imp = prompt('improve aspect-a w1');
  ok(imp !== '', 'the improver still ran');
  ok(!imp.includes('critique-aspect-a-w1.md'), 'it is NOT pointed at the unwritten critique file');
  ok(imp.includes(ASPECTS_MD) && imp.includes(BAR), 'it is told to re-observe the aspect itself instead');
  ok(logs.some((l) => /did NOT confirm writing/.test(l)), 'and the missing write is logged');
}

section('a confirmed critique IS handed over, verbatim by path');
{
  const { prompt } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN });
  ok(prompt('improve aspect-a w1').includes('E:/flow/runs/t/critique-aspect-a-w1.md'),
    'the improver reads exactly the file its critic wrote');
}

section('the WAVE code gate is blind by placement too');
// Same #3 rule as the mvp gate, and the same one interpolated path would end it: the gate reviewing the
// wave diff must not learn what the product is supposed to be.
{
  const { prompt } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN });
  const gate = prompt('code-gate wave-1');
  ok(gate !== '', 'the wave gate ran');
  ok(!gate.includes(CANON) && !gate.includes(BAR) && !gate.includes(ASPECTS_MD),
    'with no canon, bar or aspects path anywhere in its prompt');
  ok(gate.includes(`${STATE}/gate/DISMISSED-wave-1.md`), 'but it IS given the wave ledger it must not re-raise from');
  // The refine half is where the placement rule earns its keep: `critique-<aspect>-wN.md` is THIS wave's
  // spec, and it sits directly under the state dir. Naming that dir at all would put it one `ls` away.
  eq(stateRefsOutsideGate(gate).join(', '), '', 'and no run-state path outside gate/, where the critiques live');
}

section('the wave gate never reviews a red tree');
// mvp's rule, one level up: a diff that does not build spends an opus review on findings the gates already
// reported. The gate round goes to the improver instead, and the wave parks with no review file.
{
  const { labels, out } = await refine({
    critic: BEHIND, improve: { ...IMPROVED, build_passed: false }, park: PARK_OK,
  }, { ...refineArgs, maxGateRounds: 2 });
  ok(!labels.some((l) => l.startsWith('code-gate')), 'the code gate was never spawned');
  eq(labels.filter((l) => /^improve wave-1/.test(l)).length, 1, 'the gate rounds went to the improver');
  eq(out.status, 'BLOCKED (wave parked — its diff never cleared the code gate; resolve before climbing further)',
    'and the wave parks on its OWN status, not the component one');
  ok(/produced no review file/.test(out.haltReason), 'the park record admits there is no review to read');
}

section('a wave that cannot clear the gate parks its diff, and the MVP stays staged');
{
  const { out, labels } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: PARK_OK });
  eq(out.status, 'BLOCKED (wave parked — its diff never cleared the code gate; resolve before climbing further)', 'the wave-park status');
  ok(labels.includes('park:wave-1'), 'the WAVE is the park unit, not an aspect');
  eq(out.parked[0].patch, 'E:/flow/runs/t/parked-wave-1.patch', 'and its patch path is reported');
  ok(/startWave:1/.test(out.haltReason) === false && /Everything up to wave 1 is STAGED/.test(out.haltReason),
    'the reason says the accepted work survives');
}

section('the refine phase has its OWN three death guards, and none of them is the mvp one');
// dead-agent.test.mjs kills one call site per ROLE, and for gauntlet those three sites all land in the mvp
// phase or in the aspect pass — so the wave-level trio below is swept by nothing. Each is a live branch:
// drop the wave gate's `!wcg` guard and a dead gate reads as `clean !== true`, burning the gate rounds and
// parking a wave nothing reviewed, with the whole suite still green.
{
  const deadAgent = 'BLOCKED (an agent returned nothing — it was skipped or died; re-invoke to replay it)';

  // (1) the WAVE code gate — this engine's staging agent for a whole wave.
  const gate = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': null, park: PARK_OK });
  eq(gate.out.status, deadAgent, 'a dead wave gate is not a flagged review');
  eq(gate.out.stagedWaves.length, 0, 'and nothing it never read is reported as staged');

  // (2) the GATE-ROUND improver — a different call site from the aspect improver the sweep kills.
  const fix = await refine({
    critic: BEHIND, improve: (l) => (l.startsWith('improve wave-1') ? null : IMPROVED),
    'code-gate': FLAGGED, park: PARK_OK,
  });
  eq(fix.out.status, deadAgent, 'a dead gate-round improver halts too');
  ok(fix.labels.includes('improve wave-1 r1'), 'and the kill really landed on the wave improver, not the aspect one');

  // (3) the WAVE park itself — its death IS the unsafe tree, so it gets the unsafe terminal, not the above.
  const park = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: null });
  eq(park.out.status, 'BLOCKED (a parked wave left the tree unsafe — inspect before resuming)',
    'a dead wave park is an unsafe tree, not a plain dead agent');
}

section('every wave-park contradiction reaches the wave-park-unsafe status');
// Three different operator problems, one status, and each leaves the repo unsafe to resume into — so each
// needs its own case or two of them ride on a green count.
{
  const UNSAFE = 'BLOCKED (a parked wave left the tree unsafe — inspect before resuming)';
  const notCleared = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: { ...PARK_OK, cleared: false } });
  eq(notCleared.out.status, UNSAFE, 'cleared=false');
  ok(/could NOT be cleared/.test(notCleared.out.haltReason), 'and the reason says which');

  const contradictory = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: { ...PARK_OK, saved: false, patch_bytes: 4096 } });
  eq(contradictory.out.status, UNSAFE, 'saved=false with bytes on disk');
  ok(/contradicts itself/.test(contradictory.out.haltReason), 'and the reason says the patch is real');
  eq(contradictory.out.parked[0].patch, 'E:/flow/runs/t/parked-wave-1.patch',
    'the patch is still named — telling the user nothing was saved would be actively wrong');

  const redBuild = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': FLAGGED, park: { ...PARK_OK, gates_green: false } });
  eq(redBuild.out.status, UNSAFE, 'gates_green=false');
  ok(/BUILD is RED/.test(redBuild.out.haltReason), 'and the reason names the red build');
}

section('a parked wave never points at an EARLIER wave\'s code review');
// The review path is per wave. A wave that halts in its aspect pass never reaches the gate, so its park
// record must say there is no review — naming the last wave's would send the operator to a diagnosis of a
// diff that is already staged and accepted.
{
  const { prompt, labels } = await refine({
    critic: BEHIND,
    improve: (label) => (label === 'improve aspect-a w2' ? null : IMPROVED),
    'code-gate': (label) => (/r1$/.test(label) ? FLAGGED : CLEAN),
    park: PARK_OK,
  }, { ...refineArgs, cycles: 2 });
  ok(labels.includes('code-gate wave-1 r1') && labels.includes('park:wave-2'),
    'wave 1 wrote a review, then wave 2 halted and parked');
  const park = prompt('park:wave-2');
  ok(!park.includes('code-review-wave-1-r1.md'), 'the park record does not name wave 1\'s review');
  ok(/produced NO review file/.test(park), 'it says there is none instead');
}

section('a staged wave is never parked, even when the gate forgot to stage it');
// The passed-but-unstaged exception, one level up: the work is ACCEPTED, so parking it would be strictly
// worse than one `git add`. Loud, because the NEXT wave's blind diff would otherwise carry it.
{
  const { out, labels, logs } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': { ...CLEAN, staged: false } });
  ok(!labels.some((l) => l.startsWith('park')), 'nothing is parked');
  eq(out.stagedWaves.length, 0, 'the return does not claim the wave was staged');
  ok(logs.some((l) => /did NOT confirm staging/.test(l)), 'and the log says to stage it by hand');
}

section('an aspect closes exactly once, and the trajectory shows the climb');
// `open` falling wave over wave is the only signal that separates a product still closing distance from one
// grinding over settled ground — a single wave cannot tell them apart.
{
  const { out } = await refine({
    critic: (label) => (/w1$/.test(label) ? BEHIND : { ...BEHIND, status: 'achieved' }),
    improve: IMPROVED, 'code-gate': CLEAN,
  }, { ...refineArgs, cycles: 2 });
  eq(out.status, 'done (all aspects closed)', 'the climb finishes');
  eq(JSON.stringify(out.trajectory), JSON.stringify([
    { wave: 1, open: 2, improved: 2, gateRounds: 1 },
    { wave: 2, open: 0, improved: 0, gateRounds: 0 },
  ]), 'and each wave records only counts');
  eq(out.ledger.filter((r) => r.closedWave === 2).length, 2, 'both aspects closed in wave 2');
  eq(out.halted, false, 'the only refine ending that is not a halt');
}

section('the wave budget stop and the token floor are DIFFERENT facts');
// One is the user's brake being spent (ordinary, resume with more cycles); the other is the run running out
// of tokens between waves. Folding them together would tell the operator to buy cycles it already had.
{
  const spent = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN });
  eq(spent.out.status, 'cycles spent (2 aspect(s) open — resume with more cycles)', 'the cycles status');
  ok(/startWave:2/.test(spent.out.haltReason) && /runOnly:\["aspect-a", "aspect-b"\]/.test(spent.out.haltReason),
    'and its reason says exactly how to resume');

  const { out, labels } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN }, refineArgs,
    { total: 400_000, spent: () => 0, remaining: () => 40_000 });
  eq(out.status, 'stopped on token budget (resume where it left off)', 'the budget status');
  eq(labels.length, 0, 'no agent was spawned at all');
  ok(/startWave:1/.test(out.haltReason), 'and it resumes at the wave that never started');
}

section('startWave and runOnly name the wave and the aspects, not a component');
// The resume contract: file names carry the wave number, so a resumed run cannot collide with the trail the
// last one wrote, and runOnly under refine scopes ASPECT ids — a typo must fail loud, not climb nothing.
{
  const { labels } = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CLEAN },
    { ...refineArgs, startWave: 7, runOnly: ['aspect-b'] });
  eq(labels[0], 'critic aspect-b w7', 'the run starts at wave 7 on the named aspect only');
  ok(labels.includes('code-gate wave-7 r1'), 'and the wave unit carries that number');

  let msg = '';
  try {
    await refine({ critic: BEHIND }, { ...refineArgs, runOnly: ['nope'] });
  } catch (e) { msg = e.message; }
  ok(/unknown aspect id/.test(msg) && /aspect-a, aspect-b/.test(msg), 'an unknown id throws, naming the valid ones');
}

section('a runOnly SLICE closing is not the climb finishing');
// `aspects` is built from the runOnly-filtered list, so the completion test only ever asks whether the
// SLICE is closed. Reported as `done (all aspects closed)` with halted:false, that is the difference
// between "stop, we're done" and "resume the other one" — on aspects no critic ever looked at.
{
  const { out } = await refine({ critic: { ...BEHIND, status: 'achieved' }, improve: IMPROVED, 'code-gate': CLEAN },
    { ...refineArgs, runOnly: ['aspect-a'] });
  eq(out.status, 'done (this runOnly slice closed — 1 aspect(s) outside the slice were not climbed)', 'its own terminal');
  eq(out.halted, true, 'and it reports HALTED — the product still has an aspect nobody climbed');
  ok(/aspect-b/.test(out.haltReason) && /startWave:2/.test(out.haltReason),
    'the reason names what was left out and how to resume it');

  // A slice that happens to name every aspect IS the whole climb: nothing sits outside it, so the ordinary
  // terminal is the correct one and "0 aspect(s) were not climbed" would be a halt over nothing.
  const whole = await refine({ critic: { ...BEHIND, status: 'achieved' }, improve: IMPROVED, 'code-gate': CLEAN },
    { ...refineArgs, runOnly: ['aspect-a', 'aspect-b'] });
  eq(whole.out.status, 'done (all aspects closed)', 'a slice covering every aspect is just done');
  eq(whole.out.halted, false, 'and stays the one refine ending that is not a halt');
}

section('a code gate that returns clean=true WITH findings is taken as FLAGGED, in both phases');
// `clean` is "no defects and no structural debt were found" and `issue_count` is "findings written to the
// review file" — the pair contradicts the schema's own words. The gate is ALSO the staging agent here, so
// reading it as clean stages a diff carrying N written findings into the baseline every later unit is
// judged against, and the file holding them reaches nobody (tests/CLAUDE.md §3: the harm compounds).
{
  const CONTRADICTORY = { clean: true, issue_count: 3, staged: true, wrote_file: true, contested_dismissals: 0 };

  const mvp = await run({ build: BUILD_OK, 'code-gate': CONTRADICTORY, park: PARK_OK },
    { ...baseArgs, maxRounds: 2, components: [{ id: 'comp-a', gate: 'green' }] });
  eq(mvp.out.status, 'BLOCKED (component parked — MVP incomplete; resolve before refining)',
    'mvp: the component is never accepted on it');
  eq(mvp.out.componentsDone.length, 0, '...and nothing is reported done');
  ok(mvp.logs.some((l) => /clean=true WITH issue_count=3/.test(l)), '...with the contradiction named in the log');
  ok(mvp.prompt('build comp-a r2').includes(`${STATE}/gate/code-review-comp-a-r1.md`),
    '...and the review it DID write is handed to the next round, which the clean reading dropped on the floor');

  const wave = await refine({ critic: BEHIND, improve: IMPROVED, 'code-gate': CONTRADICTORY, park: PARK_OK },
    { ...refineArgs, maxGateRounds: 2 });
  eq(wave.out.status, 'BLOCKED (wave parked — its diff never cleared the code gate; resolve before climbing further)',
    'refine: the wave does not clear on it either');
  eq(wave.out.stagedWaves.length, 0, '...and no wave is reported staged');
  ok(wave.logs.some((l) => /clean=true WITH issue_count=3/.test(l)), '...same contradiction, same log');
}

section('the clean-baseline guard reads the VALUE, not what Number() makes of it');
// `Number(undefined)` is NaN and warns, but `Number(null)`, `Number(false)`, `Number('')` and `Number([])`
// are all 0 and all FINITE — so a coercing check read every one of them as "0 = clean" and waved the
// precondition through silently. This engine already refuses that coercion for its own numeric args.
{
  for (const bad of [null, false, '', []]) {
    const label = JSON.stringify(bad);
    const mvp = await run({ build: { ...BUILD_OK, baseline_dirty_files: bad }, 'code-gate': CLEAN });
    ok(mvp.logs.some((l) => /precondition was NOT verified/.test(l)),
      `mvp builder: ${label} is not silently a clean tree`);
    const wave = await refine({ critic: { ...BEHIND, baseline_dirty_files: bad }, improve: IMPROVED, 'code-gate': CLEAN });
    ok(wave.logs.some((l) => /precondition was NOT verified/.test(l)),
      `refine critic: ${label} is not silently a clean tree`);
  }
}
