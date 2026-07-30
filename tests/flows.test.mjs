// tools/gen-flows.mjs — the flow-map generator.
// Focus: the derivation rules a wrong diagram would break SILENTLY. A flow map that draws an edge
// between two concurrent agents, folds two terminal states into one node, or mints a second node for
// one throw site still renders beautifully — it just lies, and nothing else in this repo would notice.
// The committed FLOW.md files are checked against a fresh generation here, so drift turns the gate red.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph, generate, loadSpecs, whenLabel } from '../tools/gen-flows.mjs';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';

// ---------------------------------------------------------------------------------------------
// Fixtures + tiny helpers
// ---------------------------------------------------------------------------------------------
const [brainstorm, investigate, resolve] = await loadSpecs(['brainstorm', 'investigate', 'resolve']);

const nodeByLabel = (g, label) => g.nodes.find((n) => n.label === label);
const edgeBetween = (g, from, to) => {
  const f = nodeByLabel(g, from);
  const t = nodeByLabel(g, to);
  return f && t ? g.edges.find((e) => e.fromId === f.id && e.toId === t.id) : undefined;
};
const errorFrom = async (fn) => { try { await fn(); return ''; } catch (e) { return e.message; } };

const unit = (id, extra = {}) => ({ id, hash: 'h', files: [{ path: `${id}.js`, loc: 10 }], ...extra });
const FINDING = { file: 'a.js', line: '1', category: 'correctness', severity: 'high', title: 'T', detail: 'd' };
// review.mjs returns no `status`, so every scenario over it needs a declared terminal.
const reviewSpec = (units) => ({
  engine: 'workflows/debug/review.mjs',
  out: 'workflows/debug/NEVER-WRITTEN.md',      // buildGraph only — review's own spec lands in a later plan
  title: 'review (in-memory)',
  scenarios: [{
    name: 'units with findings',
    when: 'every unit has findings',
    args: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, conventions: 'c', units },
    respond: { review: { wrote_clean_marker: false, findings: [FINDING] }, verify: { wrote_file: true, verdicts: [] } },
    terminal: 'inventory written',
  }],
});

const DEV = { build_passed: true, test_outcome: 'passed', tests_run_count: 3, full_suite_outcome: 'passed', unstaged_confirmed: true, baseline_dirty_files: 0, needs_user: false };
const featureScenario = (name, plans) => ({
  name,
  when: `${plans.length} plan(s) park`,
  // planPath is what makes these bodyless entries legal: each is a "## Plan: <id>" block inside it.
  args: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' }, maxRounds: 1, planPath: 'plans/roadmap.md', plans },
  respond: {
    develop: DEV,
    quality: { clean: true },
    acceptance: { pass: false, gap_count: 1 },
    park: { saved: true, cleared: true, gates_green: true, patch_bytes: 900 },
  },
});
const featureSpec = {
  engine: 'workflows/feature/feature-cycle.mjs',
  out: 'workflows/feature/NEVER-WRITTEN.md',
  title: 'feature (in-memory)',
  scenarios: [
    featureScenario('one plan parks', [{ id: 'plan-a' }]),
    featureScenario('two plans park', [{ id: 'plan-a' }, { id: 'plan-b' }]),
  ],
};

// ONE scenario in which `acceptance -> develop` happens twice, meaning two different things: plan-a's
// round-1 gaps send it back for round 2 (a retry), and plan-a's round-2 pass stages it and starts plan-b
// (an advance). Only a build loop can produce that pair, so it is unreachable from the specs on disk that
// pre-date feature's.
const retrySpec = {
  engine: 'workflows/feature/feature-cycle.mjs',
  out: 'workflows/feature/NEVER-WRITTEN.md',
  title: 'feature retry (in-memory)',
  scenarios: [{
    name: 'gaps, then a pass, then the next plan',
    when: 'acceptance finds gaps',
    args: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' }, planPath: 'plans/roadmap.md', plans: [{ id: 'plan-a' }, { id: 'plan-b' }] },
    respond: {
      develop: DEV,
      quality: { clean: true },
      acceptance: (label) => (/plan-a r1$/.test(label)
        ? { pass: false, gap_count: 1 }
        : { pass: true, staged: true, reachable: true, criteria_total: 1, criteria_met: 1, evidence_recorded: true }),
    },
  }],
};

// docs-cycle labels its curator `curate:r${rounds}` — the repo's only COLON-separated round marker, and
// the only engine that puts a fan-out on BOTH sides of a loop. Built in memory so the rule below is
// asserted independently of whatever tools/flows/docs.flow.mjs happens to script.
const CURATE_BASE = { wrote_index: true, files: 5, inconsistencies: 0, fidelity_checked: 1, fidelity_failures: 0, foreign_content: false };
const docsSpec = {
  engine: 'workflows/docs/docs-cycle.mjs',
  out: 'workflows/docs/NEVER-WRITTEN.md',
  title: 'docs (in-memory)',
  scenarios: [{
    name: 'gap-fill round',
    when: 'the curator returns a gap',
    args: { runId: 't', root: 'E:/r', brief: 'b', sources: ['api reference', 'release notes'] },
    respond: {
      gather: { files_written: 3 },
      scrub: { files_cleaned: 1 },
      curate: (label) => ({ ...CURATE_BASE, gaps: /r1$/.test(label) ? [{ kind: 'web', focus: 'webhooks' }] : [] }),
    },
    terminal: 'curated',
  }],
};

// ---------------------------------------------------------------------------------------------

section('generating twice produces identical bytes');
// A timestamp, an unordered Set, or a scenario carrying state between runs all pass a single-run smoke
// test and then make --check fail forever. `resolve` is here because it is the only spec whose budget
// closes over run state — it has to stop BETWEEN batches, which a constant `remaining` cannot express —
// and a reference to the previous run's calls left lying around draws a different graph on pass two.
for (const spec of [brainstorm, investigate, resolve]) {
  const first = generate(spec, await buildGraph(spec));
  const second = generate(spec, await buildGraph(spec));
  ok(first === second, `${spec.name}: byte-identical across two full runs`);
}

section('the committed FLOW.md matches what the tool generates now');
// This is the drift gate: change an engine's flow and the diagram beside it goes stale until regenerated.
for (const spec of [brainstorm, investigate]) {
  const fresh = generate(spec, await buildGraph(spec));
  const committed = readFileSync(join(REPO_ROOT, spec.out), 'utf8');
  ok(fresh === committed, `${spec.out} is fresh (regenerate: node tools/gen-flows.mjs ${spec.name})`);
}

section('concurrent agents collapse to ONE node with a multiplicity, and get NO edge between them');
{
  const g = await buildGraph(brainstorm);
  const gen = nodeByLabel(g, 'generate');
  eq(gen.concurrency, 3, 'three lenses are three lanes of one node');
  ok(!edgeBetween(g, 'generate', 'generate'), 'no generate → generate edge — they run at the same time');
}

section('a pipeline stage edges to the NEXT stage');
// investigate has no fan-out at all and brainstorm's is always stage 0, so review is the only engine
// that can prove the stage rule.
{
  const g = await buildGraph(reviewSpec([unit('u1'), unit('u2')]));
  const e = edgeBetween(g, 'review', 'verify');
  ok(!!e, 'review (stage 0) → verify (stage 1)');
  ok(e && !e.back && !e.boundary, 'as a plain forward edge');
  ok(!edgeBetween(g, 'review', 'review'), 'and two concurrent units draw NO review → review edge');
}

section('a repeat inside ONE fan-out lane is a self-loop, not concurrency');
// 2 units x 2 lenses = 4 calls at stage 0. Telling them apart by group.item is the whole rule: treat
// every repeat as a loop and the diagram invents one; treat every same-stage pair as concurrent and the
// lens loop disappears.
{
  const lens = [{ id: 'x', mandate: 'auditing X' }, { id: 'y', mandate: 'auditing Y' }];
  const g = await buildGraph(reviewSpec([unit('u1', { lens }), unit('u2', { lens })]));
  const loop = edgeBetween(g, 'review', 'review');
  ok(!!loop, 'the same unit reviewed twice produces a review → review edge');
  ok(loop && loop.back, 'flagged as a repeat (dotted), because both calls share one group.item');
  ok(!!edgeBetween(g, 'review', 'verify'), 'and the stage edge still holds');
}

section('a terminal with parens and quotes survives into quoted Mermaid; its em dash is flattened');
{
  const spec = {
    engine: 'workflows/brainstorm/brainstorm-cycle.mjs',
    out: 'workflows/brainstorm/NEVER-WRITTEN.md',
    title: 'escaping (in-memory)',
    scenarios: [{
      name: 'awkward label',
      when: 'anything',
      args: { runId: 't', root: 'E:/r', brief: 'b', lenses: ['one'] },
      respond: { generate: { entry: 'i.md', summary: 's' } },
      terminal: 'wrapped up — "done" (all lenses)',
    }],
  };
  const g = await buildGraph(spec);
  const md = generate(spec, g);
  ok(md.includes('(["wrapped up - #quot;done#quot; (all lenses)"])'),
    'quotes become #quot;, parentheses pass through, and the em dash flattens to a hyphen');
  ok(!/\[\("[^"\n]*"[^"\n]*"/.test(md), 'no bare quote is left to close the Mermaid string early');
  // Presentation only: the graph still carries the label the scenario declared, so terminal identity and
  // the `--json` output are judged against the engine's real text, not against a rewritten copy.
  ok(g.terminals.some((t) => t.label === 'wrapped up — "done" (all lenses)'),
    'and the graph keeps the em dash — only the emitted document drops it');
}

section('investigate keeps its SEVEN status terminals distinct — asserted by their exact strings');
// A count alone passes just as well when two of them are wrong, and folding any pair is how a stopped
// search gets reported as a finished one. The two newest are the likeliest to be folded: a critic agrees
// to a SATURATION claim exactly as it agrees to exhaustion, and a STALLED round is not a round budget
// running out.
{
  const g = await buildGraph(investigate);
  const derived = g.terminals.filter((t) => t.source === 'derived').map((t) => t.label).sort();
  eq(derived.length, 7, 'seven derived terminals');
  eq(derived.join(' | '), [
    'BLOCKED (needs user input)',
    'exhaustive (search closed, critic agreed)',
    'no qualifying option exists (verified)',
    'not exhaustive (round budget spent)',
    'stalled (a round added nothing new and claimed nothing — stopped unverified)',
    'stopped on saturation (diminishing returns, critic agreed — the search is open, not closed)',
    'stopped on token budget (resume where it left off)',
  ].join(' | '), 'and each is the engine\'s own string');
  eq(g.coverage.statuses.uncovered.length, 0, 'every HALT_STATUS entry was reached by some scenario');
}

section('whenLabel budgets the WHOLE rendered string, and never shortens the last survivor');
// Mermaid does no collision avoidance on edge labels, so the budget is the only thing standing between a
// long condition and an unreadable diagram. Two ways it has been wrong: charging only the conditions while
// appending " · +N more" and " (×N)" afterwards (a 34-char budget emitting 50), and "fixing" that by
// ellipsising the last condition — which destroys text the Terminal-states table does not carry for a
// back edge, to save a character or two.
{
  const A = 'alpha condition here', B = 'bravo condition here', C = 'charlie condition here';

  eq(whenLabel([A]), A, 'one short condition passes through untouched');
  eq(whenLabel([A, B], 100), `${A} · ${B}`, 'two that fit are both shown');

  // The tail is priced the moment truncation happens, so the RESULT fits — not just the part before it.
  const tight = whenLabel([A, B, C], 45);
  ok(tight.length <= 45, `the rendered label fits the budget: ${tight.length} <= 45 ("${tight}")`);
  ok(/\+\d more$/.test(tight), 'and it says how many conditions it left out');

  // `reserve` is the caller's suffix (the "(×N)" repeat count), charged against the same budget. At 55
  // two conditions fit; reserving 6 for the suffix drops it to one, rather than overflowing the gutter.
  eq(whenLabel([A, B, C], 55), `${A} · ${B} · +1 more`, 'at 55 two conditions fit');
  const withSuffix = whenLabel([A, B, C], 55, 6);
  ok(withSuffix.length + 6 <= 55, `reserve is charged too: ${withSuffix.length} + 6 <= 55`);
  ok(withSuffix.length < whenLabel([A, B, C], 55).length,
    'so reserving room shows strictly less, rather than overflowing');

  // The one thing it must NEVER do: shave characters off a condition it is still showing.
  const single = whenLabel([C], 8);
  eq(single, C, 'a single condition over budget is emitted WHOLE — truncating it would lose the only copy');
  ok(!single.includes('…'), 'and carries no ellipsis');

  // Always at least one, whatever the budget.
  ok(whenLabel([A, B, C], 1).startsWith(A), 'an impossible budget still shows the first condition');
}

section('two scenarios dying at DIFFERENT rounds map to ONE throw node');
// The message interpolates the round number, so keying on the message would mint a node per round and
// break byte-stability the moment a scenario's round count changed.
{
  const g = await buildGraph(investigate);
  const throwNodes = g.terminals.filter((t) => t.source === 'throw');
  eq(throwNodes.length, 7, 'seven throw sites, seven nodes');
  const dead = throwNodes.filter((t) => t.label.includes('Investigator returned nothing'));
  eq(dead.length, 1, 'the two dead-investigator scenarios share one node');
  eq(dead[0].scenarios.join(', '), 'dead investigator (round 1), dead investigator (round 3)', 'both are credited to it');
  eq(g.coverage.throws.uncovered.length, 0, 'every throw site is covered');
}

section('a status-less return gets its DECLARED terminal, and different declarations stay different');
{
  const b = await buildGraph(brainstorm);
  const declared = b.terminals.filter((t) => t.source === 'declared').map((t) => t.label);
  eq(declared.join(' | '), 'variations produced | nothing produced (every generator failed)',
    'brainstorm\'s two non-throwing exits are two nodes, not one blank one');
  const i = await buildGraph(investigate);
  ok(i.terminals.some((t) => t.source === 'declared' && t.label.startsWith('criteria critique returned')),
    'investigate\'s status-less refine return is its own node');
}

section('terminals differing only in a number fold into one N-form node');
// feature-cycle's is the repo's only interpolated status; two scenarios parking different counts are
// one outcome, and without this they would be two.
{
  const g = await buildGraph(featureSpec);
  const parked = g.terminals.filter((t) => t.label.includes('roadmap complete'));
  eq(parked.length, 1, 'one terminal, not one per count');
  eq(parked[0].label, 'roadmap complete with N plan(s) parked', 'digits normalized for identity and display');
  eq(parked[0].scenarios.length, 2, 'both scenarios reached it');
}

section('advancing to the NEXT item is a boundary edge, not a loop');
// Without it, "loop again on the same plan" and "advance to the next plan" fold into one edge meaning
// two different things.
{
  const g = await buildGraph(featureSpec);
  const e = edgeBetween(g, 'park', 'develop');
  ok(!!e && e.boundary, 'park:plan-a → develop plan-b is a boundary edge');
  ok(e && !e.back, 'and NOT a back-edge — nothing looped');
}

section('one node pair carrying BOTH shapes stays TWO edges');
// Keying an edge on its node pair alone re-folds exactly what the boundary rule exists to split: the two
// collapse into one edge whose boundary flag wins in edgeLine, so the diagram claims every acceptance
// advances to the next plan and the retry loop — the engine's whole inner cycle — vanishes.
{
  const g = await buildGraph(retrySpec);
  const from = nodeByLabel(g, 'acceptance').id;
  const to = nodeByLabel(g, 'develop').id;
  const pair = g.edges.filter((e) => e.fromId === from && e.toId === to);
  eq(pair.length, 2, 'acceptance → develop is drawn twice');
  ok(pair.some((e) => e.boundary && !e.back), 'once as the advance to the NEXT plan');
  ok(pair.some((e) => e.back && !e.boundary), 'once as the SAME plan going round again');

  const md = generate(retrySpec, g);
  ok(md.includes(`${from} ==>|"next item"| ${to}`), 'the advance renders thick');
  ok(md.includes(`${from} -.->|"acceptance finds gaps`), 'the retry renders dotted and keeps its condition');
}

section('a COLON-separated round marker is a round, not an item');
// Strip the marker on whitespace alone and `curate:r1` yields the ITEM id `r1`, which makes every edge
// touching the curator a unit boundary: the gap loop draws as a thick "next item" advance carrying no
// round count and no condition, and scrub → curate claims an item advance across a whole-set barrier.
// Both still render perfectly — they just describe a flow the engine does not have.
{
  const g = await buildGraph(docsSpec);
  const loop = edgeBetween(g, 'curate', 'gather');
  ok(!!loop && loop.back, 'curate:r1 → gather (the gap-fill round) is a back-edge');
  ok(loop && !loop.boundary, 'and NOT an advance to the next item');
  const barrier = edgeBetween(g, 'scrub', 'curate');
  ok(!!barrier && !barrier.boundary && !barrier.back, 'scrub → curate is a plain forward edge into the barrier');
}

section('a loop is annotated with the MEASURED round count');
{
  const g = await buildGraph(investigate);
  const inv = nodeByLabel(g, 'investigate');
  const backIn = g.loops.filter((l) => l.to === inv.id);
  ok(backIn.length > 0, 'the round loop produces back-edges into the investigator');
  ok(backIn.every((l) => l.repeat === 5), 'each reports 5 rounds — read from the trace, not from maxRounds in the source');
  ok(!edgeBetween(g, 'investigate', 'critique').back,
    'and the loop BODY\'s forward edge is not dotted just because round 2 revisits the critic');
}

section('edge labels stay inside a length budget — Mermaid will not stop them overlapping');
// Mermaid does no collision avoidance on edge labels: two long ones leaving the same node render on top
// of each other and NEITHER is readable. This is the only thing keeping them apart, so it is asserted
// over every committed map rather than one sample.
{
  const specs = await loadSpecs();
  let longest = '';
  for (const spec of specs) {
    const md = generate(spec, await buildGraph(spec));
    for (const m of md.matchAll(/\|"([^"]*)"\|/g)) {
      if (m[1].length > longest.length) longest = m[1];
    }
  }
  ok(longest.length <= 90, `longest edge label across all 9 maps is ${longest.length} chars: "${longest}"`);
}

section('a phase is a box only when it groups 2+ agents, and rides on the node otherwise');
// A subgraph around ONE node labels it twice and makes Mermaid route crossing edges around the box —
// which is what hid the loop back-edges. No engine puts two agents in one phase, so no box should be
// emitted at all; the assertion is written against the RULE, not that number, so it keeps holding if one
// ever does.
{
  const g = await buildGraph(investigate);
  const md = generate(investigate, g);
  const boxed = g.phases.filter((p) => p.nodes.length >= 2);
  eq(boxed.length, 0, 'investigate has no phase holding 2+ agents');
  ok(!md.includes('subgraph'), 'so the diagram draws no phase box');
  ok(md.includes('criteria-critic · opus<br/>Refine'),
    'the phase still rides on the node where it differs from the role name');
  ok(!/investigate · opus<br\/>Investigate/.test(md),
    'and is suppressed where it would just repeat the role');
}

section('the round count is per LANE — fan-out width and roadmap length never inflate it');
// The number on a back-edge is the one figure a reader quotes, and it renders just as prettily when it
// is wrong. Both inflations below shipped in the first cut: the count was visits to the target node
// across the whole trace, so a wider fan-out or a longer roadmap silently raised it.
{
  const [review, feature] = await loadSpecs(['review', 'feature']);

  const rg = await buildGraph(review);
  const lens = edgeBetween(rg, 'review', 'review');
  ok(lens?.back, 'review has a lens self-loop');
  eq(lens.repeat, 2, 'it reports 2 LENSES, not the 4 review calls 2 units x 2 lenses make');

  const fg = await buildGraph(feature);
  eq(edgeBetween(fg, 'quality', 'develop').repeat, 2,
    'feature retries a plan twice — not 3, which is what summing BOTH plans\' traversals gives');
  // acceptance -> develop exists TWICE by design (the thick advance to the next plan, and the dotted
  // retry of this one), so the count has to be read off the back-edge specifically.
  const acc = nodeByLabel(fg, 'acceptance');
  const dev = nodeByLabel(fg, 'develop');
  const retry = fg.edges.filter((e) => e.fromId === acc.id && e.toId === dev.id && e.back);
  eq(retry.length, 1, 'exactly one of the two acceptance -> develop edges is the retry');
  eq(retry[0].repeat, 4, 'and a plan that never accepts still measures its full maxRounds of 4');
}

section('a label matching no known role is a hard error naming the label');
// Inventing a node would hide a role readRoles failed to see — the one failure that makes every later
// diagram quietly incomplete.
{
  const spec = {
    engine: 'tests/fixtures/unknown-label.mjs',
    out: 'tests/fixtures/NEVER-WRITTEN.md',
    title: 'unknown-label (in-memory)',
    scenarios: [{ name: 'runtime label', when: 'a label is built at runtime', args: {}, respond: {} }],
  };
  const msg = await errorFrom(() => buildGraph(spec));
  ok(/ghost-role/.test(msg) && /matches no role/.test(msg), `throws naming the label: ${msg.slice(0, 70)}`);
}

section('spec validation rejects what would produce a silently wrong map');
{
  const base = { engine: 'workflows/brainstorm/brainstorm-cycle.mjs', out: 'x.md', title: 'v' };
  const sc = { name: 'n', when: 'w', args: { runId: 't', root: 'E:/r', brief: 'b', lenses: ['a'] }, terminal: 'done' };

  eq(await errorFrom(() => buildGraph({ ...base, engine: 'workflows/nope/nope.mjs', scenarios: [sc] })) !== '', true,
    'an engine path that does not exist');
  ok(/at least one scenario/.test(await errorFrom(() => buildGraph({ ...base, scenarios: [] }))), 'an empty scenario table');
  ok(/non-empty when/.test(await errorFrom(() => buildGraph({ ...base, scenarios: [{ ...sc, when: '' }] }))),
    'a scenario with no `when` — it would emit a blank edge label');

  // The two terminal-identity errors. Both are silent corruption otherwise: one blank end node, or a
  // hand-written label overriding what the engine actually returned.
  ok(/needs a declared/.test(await errorFrom(() => buildGraph({ ...base, scenarios: [{ ...sc, terminal: undefined }] }))),
    'a status-less return with no declared terminal');
  const contradiction = await errorFrom(() => buildGraph({
    engine: 'workflows/investigate/investigate-cycle.mjs',
    out: 'x.md',
    title: 'v',
    scenarios: [{ name: 'n', when: 'w', args: { runId: 't', root: 'E:/r', criteria: 'c', maxRounds: 1 }, terminal: 'all good' }],
  }));
  ok(/never override derived truth/.test(contradiction), 'a declared terminal contradicting a non-empty out.status');
}

section('an uncovered throw site is reported, with the reason when one is allowed');
// The coverage numbers in FLOW.md and the ones a linter reads are the SAME computation — two
// derivations can disagree, and then the committed diagram contradicts the gate.
{
  const spec = {
    engine: 'workflows/brainstorm/brainstorm-cycle.mjs',
    out: 'workflows/brainstorm/NEVER-WRITTEN.md',
    title: 'partial (in-memory)',
    scenarios: [{ name: 'no runId', when: 'args carry no runId', args: {} }],
    allowUncovered: { throws: [{ prefix: 'args.root is required', reason: 'covered by the sibling spec' }] },
  };
  const g = await buildGraph(spec);
  eq(g.coverage.throws.covered, 1, 'one site reached');
  eq(g.coverage.throws.uncovered.length, 4, 'the other four are reported, not ignored');
  const allowed = g.coverage.throws.uncovered.filter((t) => t.reason);
  eq(allowed.length, 1, 'exactly the one allowUncovered names');
  eq(allowed[0].reason, 'covered by the sibling spec', 'and its reason rides along');
  ok(generate(spec, g).includes('covered by the sibling spec'), 'which reaches FLOW.md too');
}
