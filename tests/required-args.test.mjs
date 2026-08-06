// Every engine × every documented-required arg: delete it and the engine must THROW before it works.
//
// WHY A SWEEP RATHER THAN A CASE PER ENGINE. "Documented-Required-but-defaulted" is this repo's worst
// historical defect class: `target.repo ?? '.'` resolves against ROOT, which is the TOOL's directory, so
// an omitted repo pointed park's `git checkout --` and delete at the workflow checkout itself. It was
// found in migrate and turned out to be in feature, resolve, review and enhance too (tests/CLAUDE.md §1).
// A per-engine case cannot catch the sibling that never got one; a table that must name every engine can.
//
// It is BEHAVIORAL on purpose — each row RUNS the engine (tests/CLAUDE.md §6). A source grep for the
// shape of a guard cannot tell you the guard is wired to the arg that matters; the numeric-bound sweep
// was a false gate for exactly that reason until it started running the engines.
//
// The baseline assertion is what keeps the sweep honest: if a row's args were already invalid, every
// deletion under it would throw for the wrong reason and the row would pass having tested nothing. Same
// for the delete helper — a path whose parent is missing removes nothing, leaving args identical to the
// baseline, which RUNS, so the case fails loudly instead of passing vacuously.
//
// What is deliberately NOT swept: `conventions`. debug's guide carried a "Required" marker until
// 2026-08-01; the engines fall back to a placeholder rubric by design, so it is strongly recommended and
// not enforced. It stays in review's and resolve's baseline args (mirroring their test files) precisely
// so a future guard on it would show up here as a baseline that still runs.
//
// Exact wording is NOT asserted — only that the engine throws rather than runs. The per-engine test files
// own the message contracts (investigate.test.mjs keeps its own section: it asserts its two guards cannot
// pass for each other's message, a distinction this sweep does not make).
import { runEngine, throwsWith, section, ok } from './harness.mjs';

/**
 * A deep copy of `args` with the single (possibly nested) `path` removed — 'target.repo', 'gates.build'.
 * A missing parent deletes nothing on purpose: the case then runs the untouched baseline and FAILS, which
 * is the honest outcome for a path that does not exist where the table says it does.
 */
function without(args, path) {
  const copy = structuredClone(args);
  const keys = path.split('.');
  const leaf = keys.pop();
  let node = copy;
  for (const k of keys) node = node?.[k];
  if (node && typeof node === 'object') delete node[leaf];
  return copy;
}

// ---------------------------------------------------------------------------------------------
// Fixtures — mirrored from the per-engine test files (and tools/flows/*.flow.mjs for the two engines
// that have no test file of their own), so "minimal valid args" has ONE definition per engine.
// ---------------------------------------------------------------------------------------------
const PLANS    = [{ id: 'plan-a', plan: '## Feature\nA', gate: 'build-only' },
  { id: 'plan-b', plan: '## Feature\nB', gate: 'build-only' }];
const SECTIONS = [{ id: 'sec-a', title: 'A' }, { id: 'sec-b', title: 'B' }];
const UNIT     = { id: 'u1', hash: 'h', files: [{ path: 'a.js', loc: 10 }] };
const ISSUE    = { id: 'i1', unit: 'u1', file: 'src/a.js', line: '1', loc: 10, severity: 'high',
  category: 'correctness', decision: 'ACTIONABLE', effort: 'small', title: 'T', theme: 'x' };

// Both plans are build-only, so this baseline deliberately carries NO test command: it is the
// condition-FALSE payload, and the baseline assertion below is what proves gates.test is optional there.
const FEATURE_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  gates: { build: 'b' }, plans: PLANS };
const MIGRATE_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  gates: { build: 'b', test: 't' }, plan: '## Section: sec-a\nA\n## Section: sec-b\nB\n', sections: SECTIONS };
const ENHANCE_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  scope: ['workflows/'], lenses: ['efficiency', 'simplification'] };
// Both components are build-only, so this baseline deliberately carries NO test command: it is the
// condition-FALSE payload, and the baseline assertion below is what proves gates.test is optional there.
const GAUNTLET_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b' },
  canonPath: 'plans/t/CANON.md', componentsPath: 'plans/t/COMPONENTS.md',
  components: [{ id: 'comp-a', gate: 'build-only' }, { id: 'comp-b', gate: 'build-only' }] };
// gauntlet's OTHER phase is a second row: refine requires a different set (aspects + bar + cycles) and
// requires NONE of the mvp inputs, which is what makes it usable as an entry point on its own. A single
// row could not express that — deleting componentsPath from a refine payload must NOT throw.
const GAUNTLET_REFINE_ARGS = { runId: 't', root: 'E:/r', phase: 'refine', target: { repo: 'E:/repo' },
  gates: { build: 'b', test: 't' }, canonPath: 'plans/t/CANON.md', barPath: 'plans/t/BAR.md',
  aspectsPath: 'plans/t/ASPECTS.md', aspects: [{ id: 'aspect-a' }], cycles: 1 };

// decide and docs are the two engines that do NOT reach a terminal on empty returns (measured
// 2026-08-01: decide throws "No analyst produced a lens file", docs throws "Every source reported zero
// doc files"), so their rows script the returns their per-engine table already uses.
const ANALYST = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, open_questions: 0, needs_user: false };
const AGREE   = { wrote_file: true, agree: true, gap_count: 0, gap_ids: [], needs_user: false };
const GATHER  = { files_written: 6, skipped: 2 };
const SCRUB   = { files_cleaned: 4 };
const CURATE  = { wrote_index: true, files: 11, deleted: 1, inconsistencies: 0, fidelity_checked: 3,
  fidelity_failures: 0, foreign_content: false, foreign_paths: [], gaps: [] };

// ---------------------------------------------------------------------------------------------
// The table. `required` entries are either a bare path (deleted from baseArgs) or
// { path, when, args? } for a CONDITIONAL requirement — `when` names the documented condition, and
// `args` supplies the variant baseline that makes the condition true when baseArgs does not.
// Each engine's list comes from its workflows/<x>/CLAUDE.md "Args reference" checked against the
// engine's own validation block; where they could disagree, the engine is canonical and it is noted.
// ---------------------------------------------------------------------------------------------
const SWEEP = [
  {
    engine: 'workflows/feature/feature-cycle.mjs',
    baseArgs: FEATURE_ARGS,
    respond: {},
    required: ['runId', 'root', 'target.repo', 'gates.build', 'plans',
      // Both baseline plans are gate:"build-only", which needs no test command — so this one needs a
      // variant whose plan actually asks for verification. The baseline carries no gates.test at all, so
      // the line-197 assertion above covers the OTHER direction: the arg is NOT required when no plan
      // asks for green. Without that, an over-strict guard (the condition lost) stays green here while
      // every build-only roadmap throws at launch.
      { path: 'gates.test', when: 'a plan has gate:"green"',
        args: { ...FEATURE_ARGS, gates: { build: 'b', test: 't' },
          plans: [{ id: 'plan-a', plan: '## Feature\nA', gate: 'green' }] } }],
  },
  {
    engine: 'workflows/migrate/migrate-cycle.mjs',
    baseArgs: MIGRATE_ARGS,
    respond: {},
    required: ['runId', 'root', 'target.repo', 'gates.build', 'plan', 'sections',
      // Same documented condition as feature's, but it is already true in the baseline: a section that
      // omits `gate` takes the 'green' default, so no variant args are needed.
      { path: 'gates.test', when: 'a section has gate:"green" — the default the baseline sections take' }],
  },
  {
    engine: 'workflows/gauntlet/gauntlet-cycle.mjs',
    phase: 'mvp',
    baseArgs: GAUNTLET_ARGS,
    respond: {},
    required: ['runId', 'root', 'target.repo', 'canonPath', 'componentsPath', 'components', 'gates.build',
      // Both baseline components are gate:"build-only", which needs no test command — so this one needs a
      // variant whose component actually asks for verification. The baseline carries no gates.test at all,
      // so the line-197 assertion above covers the OTHER direction: the arg is NOT required when no
      // component asks for green — the half an over-strict guard would break silently.
      { path: 'gates.test', when: 'a component has gate:"green"',
        args: { ...GAUNTLET_ARGS, gates: { build: 'b', test: 't' },
          components: [{ id: 'comp-a', gate: 'green' }] } }],
  },
  {
    engine: 'workflows/gauntlet/gauntlet-cycle.mjs',
    phase: 'refine',
    baseArgs: GAUNTLET_REFINE_ARGS,
    respond: {},
    // `cycles` is here because it deliberately has NO default: the wave budget is the user's only brake on
    // a climb, so an engine-chosen number would be a run length nobody agreed to pay for.
    required: ['runId', 'root', 'target.repo', 'canonPath', 'barPath', 'aspectsPath', 'aspects', 'cycles',
      'gates.build'],
  },
  {
    engine: 'workflows/debug/review.mjs',
    baseArgs: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, conventions: 'c', units: [UNIT] },
    respond: {},
    required: ['runId', 'root', 'target.repo', 'units'],
  },
  {
    engine: 'workflows/debug/resolve-cycle.mjs',
    baseArgs: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
      gates: { build: 'b', test: 't' }, conventions: 'c', issues: [ISSUE] },
    respond: {},
    // Unlike feature/migrate, BOTH gates are unconditionally required here: the test suite must already
    // be green before resolve runs, so there is no build-only mode for it to be optional under.
    required: ['runId', 'root', 'target.repo', 'gates.build', 'gates.test', 'issues'],
  },
  {
    engine: 'workflows/enhance/enhance-cycle.mjs',
    baseArgs: ENHANCE_ARGS,
    respond: {},
    required: ['runId', 'root', 'scope', 'lenses',
      // §9 lists target.repo under Optional and §3 states the condition: it is what a RELATIVE scope path
      // resolves against, and the baseline scope ('workflows/') is relative. An all-absolute scope needs
      // no repo at all — the one engine here where the requirement is a property of another arg's value.
      { path: 'target.repo', when: 'any scope path is relative' }],
  },
  {
    engine: 'workflows/decide/decide-cycle.mjs',
    baseArgs: { runId: 't', root: 'E:/r', lenses: ['efficiency', 'simplest'],
      requirements: '## Decision\nWhich cache layer?\n## Weighted criteria\n- latency (weight 3)' },
    respond: { analyst: ANALYST, decide: DECIDE, review: AGREE },
    required: ['runId', 'root', 'requirements', 'lenses'],
  },
  {
    engine: 'workflows/docs/docs-cycle.mjs',
    baseArgs: { runId: 't', root: 'E:/r', brief: 'Integrate the payments API v2.',
      sources: [{ id: 'api-reference', kind: 'web', focus: 'the official payments API reference (v2)' }] },
    respond: { gather: GATHER, scrub: SCRUB, curate: CURATE },
    required: ['runId', 'root', 'brief', 'sources'],
  },
  {
    engine: 'workflows/brainstorm/brainstorm-cycle.mjs',
    baseArgs: { runId: 't', root: 'E:/r', brief: 'Design a landing page for a developer tool',
      lenses: ['minimalist', 'bold editorial'] },
    respond: {},
    required: ['runId', 'root', 'brief', 'lenses'],
  },
  {
    engine: 'workflows/investigate/investigate-cycle.mjs',
    baseArgs: { runId: 't', root: 'E:/r', criteria: '## Question\nQ\n## Acceptance Criteria\n- c1' },
    respond: {},
    required: ['runId', 'root', 'criteria'],
  },
];

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------
for (const { engine, baseArgs, respond, required, phase } of SWEEP) {
  // `phase` names the row when one engine takes more than one shape (gauntlet's mvp vs refine), so two
  // rows of the same engine cannot print the same heading and the same `missing runId throws` line.
  const name = `${engine.split('/').pop()}${phase ? ` (phase:"${phase}")` : ''}`;
  section(`${name} — every documented-required arg throws when missing`);

  // The guard on this row's own validity: a baseline that already threw would make every deletion below
  // pass for the wrong reason.
  let baseErr = '';
  try { await runEngine(engine, { args: baseArgs, respond }); } catch (e) { baseErr = e.message; }
  ok(baseErr === '', `the baseline args RUN${baseErr ? ` — but threw: ${baseErr.slice(0, 70)}` : ''}`);

  for (const entry of required) {
    const { path, when, args } = typeof entry === 'string' ? { path: entry } : entry;
    const from = args ?? baseArgs;
    // A variant baseline is a second args object, so it needs the same vacuity guard.
    if (args) {
      let variantErr = '';
      try { await runEngine(engine, { args, respond }); } catch (e) { variantErr = e.message; }
      ok(variantErr === '', `the ${when} variant args RUN${variantErr ? ` — but threw: ${variantErr.slice(0, 70)}` : ''}`);
    }
    const msg = await throwsWith(engine, { args: without(from, path), respond });
    ok(msg !== '', `missing ${path}${when ? ` (required when ${when})` : ''} throws: ${msg.slice(0, 50)}`);
  }
}
