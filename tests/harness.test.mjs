// tests/harness.mjs itself — the tracer everything else is about to be built on.
// Focus: the record SURVIVES a throw (a run that dies halfway must still hand back every call it made),
// the fan-out stamping matches what the REAL engines do rather than a fixture, and the static readers
// prove they found every site against the source instead of against a pinned number.
import { readFileSync } from 'node:fs';
import {
  runTrace, readMeta, readRoles, readThrows, readHaltStatus, ENGINES, REPO_ROOT, section, ok, eq,
} from './harness.mjs';

const INVESTIGATE = 'workflows/investigate/investigate-cycle.mjs';
const BRAINSTORM  = 'workflows/brainstorm/brainstorm-cycle.mjs';
const REVIEW      = 'workflows/debug/review.mjs';

const srcOf = (rel) => readFileSync(`${REPO_ROOT}/${rel}`, 'utf8');
const invArgs = { runId: 't', root: 'E:/r', criteria: '## Question\nQ' };
const unit = (id, extra = {}) => ({ id, hash: 'h', files: [{ path: `${id}.js`, loc: 10 }], ...extra });
const reviewArgs = (units) => ({ runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, conventions: 'c', units });
const FINDING = { file: 'a.js', line: '1', category: 'correctness', severity: 'high', title: 'T', detail: 'd' };

section('a throw AFTER an agent call keeps every call the run had already made');
// THE case for the never-throws contract. Build it the other way — let execute() throw and catch in
// runTrace — and the record dies with the run, silently losing every pre-throw call.
{
  const t = await runTrace(INVESTIGATE, { args: invArgs, respond: { 'investigate': null } });
  eq(t.terminal.kind, 'throw', 'terminal kind');
  ok(/Investigator returned nothing/.test(t.terminal.message), 'the thrown message is carried');
  eq(t.terminal.status, '', 'no status on a throw');
  eq(t.out, undefined, 'and no return value');
  eq(t.calls.length, 1, 'the call made BEFORE the throw survived');
  eq(t.calls[0].label, 'investigate r1', 'and it is the right one');
}

section('an arg-validation throw legitimately has no calls at all');
// Kept only to make the case above meaningful: this one passes green against an implementation that
// loses every pre-throw call, so on its own it proves nothing.
{
  const t = await runTrace(INVESTIGATE, { args: { runId: 't' } });
  eq(t.terminal.kind, 'throw', 'terminal kind');
  ok(/args\.root is required/.test(t.terminal.message), 'the guard message');
  eq(t.calls.length, 0, 'nothing had run yet');
}

section('a normal run reports kind:return and the engine\'s own status');
{
  const t = await runTrace(INVESTIGATE, { args: { ...invArgs, maxRounds: 1 } });
  eq(t.terminal.kind, 'return', 'terminal kind');
  eq(t.terminal.status, 'not exhaustive (round budget spent)', 'status');
  eq(t.terminal.status, t.out.status, 'which is out.status verbatim');
  eq(t.terminal.message, '', 'no message on a return');

  const noStatus = await runTrace(BRAINSTORM, { args: { runId: 't', root: 'E:/r', brief: 'b', lenses: ['a'] } });
  eq(noStatus.terminal.kind, 'return', 'brainstorm returns normally');
  eq(noStatus.terminal.status, '', 'and reports \'\' — it has no status field');
}

section('parallel: one fan-out is one group, and item indexes the thunk');
{
  const t = await runTrace(BRAINSTORM, {
    args: { runId: 't', root: 'E:/r', brief: 'b', lenses: ['one', 'two', 'three'] },
  });
  eq(t.calls.length, 3, 'one generator per lens');
  eq(new Set(t.calls.map((c) => c.group.id)).size, 1, 'all three share ONE group id');
  ok(t.calls.every((c) => c.group.kind === 'parallel' && c.group.stage === 0), 'kind parallel, stage 0');
  eq(t.calls.map((c) => `${c.label}#${c.group.item}`).join(),
    'generate:one#0,generate:two#1,generate:three#2', 'item tracks the lens position');
  eq(t.calls.map((c) => c.seq).join(), '0,1,2', 'seq is the call order');
  eq(t.groups.length, 1, 'exactly one fan-out opened');
}

section('pipeline: stages are numbered, and a call outside any fan-out has group null');
{
  const t = await runTrace(REVIEW, {
    args: reviewArgs([unit('u1'), unit('u2')]),
    respond: {
      'review': { wrote_clean_marker: false, findings: [FINDING] },
      'verify': { wrote_file: true, verdicts: [] },
    },
  });
  const reviews = t.calls.filter((c) => c.label.startsWith('review:'));
  const verifies = t.calls.filter((c) => c.label.startsWith('verify:'));
  eq(reviews.length, 2, 'one reviewer per unit');
  eq(verifies.length, 2, 'both units had findings, so both reached a verifier');
  eq(new Set(t.calls.map((c) => c.group.id)).size, 1, 'the whole pipeline is ONE group');
  ok(t.calls.every((c) => c.group.kind === 'pipeline'), 'kind pipeline');
  ok(reviews.every((c) => c.group.stage === 0), 'reviewers at stage 0');
  ok(verifies.every((c) => c.group.stage === 1), 'verifiers at stage 1');
  eq(reviews.map((c) => c.group.item).join(), '0,1', 'item is the unit index');
  eq(t.groups[0].stages, 2, 'the group records both stages');

  const solo = await runTrace(INVESTIGATE, { args: { ...invArgs, phase: 'refine' } });
  eq(solo.calls[0].group, null, 'a call made outside any fan-out carries group null');
}

section('several calls may share ONE (id,item,stage) triple — review loops its lenses sequentially');
// That is correct, not a collision: the consumer tells sequential repeats from concurrency by comparing
// `item`. Collapsing or renumbering them here would erase the difference.
{
  const lens = [{ id: 'x', mandate: 'auditing X' }, { id: 'y', mandate: 'auditing Y' }];
  const t = await runTrace(REVIEW, {
    args: reviewArgs([unit('u1', { lens }), unit('u2', { lens })]),
    respond: { 'review': { wrote_clean_marker: false, findings: [] } },
  });
  const stage0 = t.calls.filter((c) => c.group.stage === 0);
  eq(stage0.length, 4, 'two units x two lenses');
  eq(new Set(stage0.map((c) => c.group.id)).size, 1, 'all four in the same group');
  const itemsOf = (prefix) => [...new Set(stage0.filter((c) => c.label.startsWith(prefix)).map((c) => c.group.item))];
  eq(itemsOf('review:u1').length, 1, 'u1\'s two lens calls share one item');
  eq(itemsOf('review:u2').length, 1, 'u2\'s two share one item as well');
  ok(itemsOf('review:u1')[0] !== itemsOf('review:u2')[0], 'and the two units differ in item');
}

section('phases records every phase() call and where it falls in the call sequence');
{
  const t = await runTrace(INVESTIGATE, {
    args: { ...invArgs, maxRounds: 1 },
    respond: {
      'investigate': { wrote_files: true, new_options: 1, disqualified_added: 0, exhausted: false, no_solution: false, needs_user: false, option_ids: ['o'] },
      'critique': { wrote_file: true, upheld: ['o'], disqualified: [], contests_exhaustion: false, agree: false, needs_user: false },
    },
  });
  eq(t.phases.map((p) => p.title).join(), 'Investigate,Critique', 'both titles, in order');
  eq(t.phases[0].beforeCall, 0, 'Investigate fires before call 0');
  eq(t.phases[1].beforeCall, 1, 'Critique fires before call 1');

  const refine = await runTrace(INVESTIGATE, { args: { ...invArgs, phase: 'refine' } });
  eq(refine.phases.map((p) => p.title).join(), 'Refine', 'the refine phase names itself');
}

section('an EMPTY phases list is a CORRECT result, not a tracing failure');
// review.mjs and enhance-cycle never call phase() — they carry it on each agent's opts.phase. A consumer
// that reads [] as a bug would be reading those two engines wrong.
{
  const t = await runTrace(REVIEW, {
    args: reviewArgs([unit('u1')]),
    respond: { 'review': { wrote_clean_marker: true, findings: [] } },
  });
  eq(t.phases.length, 0, 'review.mjs calls phase() zero times');
  eq(t.calls[0].opts.phase, 'Review', 'the phase is on the agent call instead');
}

section('readRoles reads the static label prefixes in source order');
{
  eq(readRoles(srcOf('workflows/feature/feature-cycle.mjs')).join(),
    'plan-critic,develop,quality,acceptance,park', 'feature-cycle, exactly');
  // The normalization edge cases, each taken from the engine that actually has it.
  eq(readRoles(srcOf('workflows/docs/docs-cycle.mjs')).join(), 'gather,scrub,curate',
    '`curate:r${rounds}` loses the trailing :r');
  eq(readRoles(srcOf(REVIEW)).join(), 'review,verify',
    'a label nesting a template inside a ternary inside a template still yields review');
  ok(readRoles(srcOf(INVESTIGATE)).join() === 'criteria-critic,investigate,critique',
    'hyphenated ids survive whole, and `investigate r${round}` loses the bare r');
  ok(readRoles(srcOf('workflows/migrate/migrate-cycle.mjs')).includes('final-sweep'), 'so does final-sweep');
  for (const rel of ENGINES) {
    const roles = readRoles(srcOf(rel));
    ok(roles.length > 0, `${rel} -> ${roles.join(', ')}`);
  }
  // Dedup has no real-engine case today (no engine labels two sites with the same prefix), so it is
  // asserted against an inline source string — readRoles parses text, and the "verify against real
  // engines" rule is about control flow, not string parsing.
  eq(readRoles('label: `develop ${a} r${b}`\nlabel: \'develop\'\nlabel: `park:${p}`').join(),
    'develop,park', 'deduped, still in source order');
}

section('readThrows finds EVERY throw site — proven against the source, never a pinned count');
// Throw sites are added routinely across engines; a snapshot count would turn the gate red on a correct
// change, so the total is logged rather than asserted.
{
  let total = 0;
  for (const rel of ENGINES) {
    const src = srcOf(rel);
    const found = readThrows(src);
    eq(found.length, (src.match(/throw new Error\(/g) || []).length, `${rel}: every site found`);
    total += found.length;
  }
  console.log(`      ${total} throw sites across ${ENGINES.length} engines`);

  const src = srcOf(INVESTIGATE);
  const lines = src.split('\n');
  ok(readThrows(src).every((s) => lines[s.line - 1].includes('throw new Error(')),
    'every reported line really holds a throw site');
  ok(readThrows(src).some((s) => s.prefix.startsWith('args.root is required')),
    'and the prefix is the message text');
}

section('a throw whose message STARTS with an interpolation is returned with an empty prefix');
// No engine has one today, so this is an inline source string. A dropped site would read as covered to
// anything counting sites — which is the whole point of the self-consistency check above.
{
  const sites = readThrows('if (x) {\n  throw new Error(`${x} died in round ${r}`);\n}\n');
  eq(sites.length, 1, 'the site is found');
  eq(sites[0].prefix, '', 'and reported with an empty prefix rather than dropped');
  eq(sites[0].line, 2, 'on the right line');
}

section('readMeta evaluates the meta literal of every engine');
for (const rel of ENGINES) {
  const m = readMeta(srcOf(rel));
  ok(!!m && typeof m.name === 'string' && m.name !== ''
    && typeof m.description === 'string' && m.description !== '' && Array.isArray(m.phases),
    `${rel} -> ${m?.name} (${m?.phases?.length} phase(s))`);
}

section('readHaltStatus evaluates the map where there is one, and {} where there is not');
{
  const keysInBlock = (src) => {
    const block = src.match(/const HALT_STATUS = \{[\s\S]*?\n\};/);
    return block ? (block[0].match(/^\s+'[^']+':/gm) || []).length : 0;
  };
  for (const rel of ENGINES) {
    const src = srcOf(rel);
    eq(Object.keys(readHaltStatus(src)).length, keysInBlock(src), `${rel}: matches its literal block`);
  }
  eq(readHaltStatus(srcOf(INVESTIGATE))['no-solution'], 'no qualifying option exists (verified)',
    'the values are the engine\'s own strings');
  eq(Object.keys(readHaltStatus(srcOf(BRAINSTORM))).length, 0,
    'brainstorm has no HALT_STATUS — {}, not a throw');
}
