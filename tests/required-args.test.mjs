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
// not enforced. It stays in review's baseline args (mirroring its test file) precisely so a future guard
// on it would show up here as a baseline that still runs.
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
const UNIT     = { id: 'u1', hash: 'h', files: [{ path: 'a.js', loc: 10 }] };

// Both blocks are build-only, so this baseline deliberately carries NO test command: it is the
// condition-FALSE payload, and the baseline assertion below is what proves gates.test is optional there.
// The top-level planPath is what makes bodyless entries legal — every block is a "## Plan: <id>" block
// inside it, and an entry with no path anywhere throws.
const DEVELOP_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b' },
  planPath: 'plans/bus.md',
  plans: [{ id: 'block-a', mode: 'feature', gate: 'build-only' },
    { id: 'block-b', mode: 'section', gate: 'build-only' }] };
// refine converges a plan FILE and builds nothing, so it takes no gates at all. `planPath` carries the
// whole subject of the run: there is no inline plan and no default, and an omitted one would spawn a
// critic against nothing and report a clean round for a plan it never saw.
const REFINE_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, planPath: 'plans/bus.md' };
const ENHANCE_ARGS = { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' },
  scope: ['workflows/'], lenses: ['efficiency', 'simplification'] };
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
    engine: 'workflows/develop/develop-cycle.mjs',
    baseArgs: DEVELOP_ARGS,
    respond: {},
    required: ['runId', 'root', 'target.repo', 'gates.build', 'plans',
      // Both baseline blocks are gate:"build-only", which needs no test command — so this one needs a
      // variant whose block actually asks for verification, and that block must be TODO: the guard is
      // scoped to the PENDING slice, so a done/skip block asking for green must NOT demand the command.
      { path: 'gates.test', when: 'a todo block has gate:"green"',
        args: { ...DEVELOP_ARGS, gates: { build: 'b', test: 't' },
          plans: [{ id: 'block-a', mode: 'feature', gate: 'green', status: 'todo' }] } }],
  },
  {
    engine: 'workflows/refine/refine-cycle.mjs',
    baseArgs: REFINE_ARGS,
    respond: {},
    // No gates row: refine stages nothing and runs no build, so it never reads args.gates.
    required: ['runId', 'root', 'planPath', 'target.repo'],
  },
  {
    engine: 'workflows/debug/review.mjs',
    baseArgs: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, conventions: 'c', units: [UNIT] },
    respond: {},
    required: ['runId', 'root', 'target.repo', 'units'],
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
    baseArgs: { runId: 't', root: 'E:/r', criteria: '## Question\nQ\n## Acceptance Criteria\n- c1', priorRounds: 0 },
    respond: {},
    required: ['runId', 'root', 'criteria', 'priorRounds'],
  },
];

// ---------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------
for (const { engine, baseArgs, respond, required } of SWEEP) {
  section(`${engine.split('/').pop()} — every documented-required arg throws when missing`);

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

// ---------------------------------------------------------------------------------------------
// develop-cycle's control VALUES. The sweep above only deletes an arg, and develop's whole control array
// is data the operator copies off `plan-block.mjs --list` by hand — so the live failure is a value that
// is PRESENT and wrong, not one that is missing. Every one of these used to coerce somewhere in the
// family: a miscopied gate got the green default that demands the very tests a test-first block leaves
// failing, and a typoed status silently dropped its block from the run.
// ---------------------------------------------------------------------------------------------
{
  const engine = 'workflows/develop/develop-cycle.mjs';
  section('develop-cycle.mjs — a malformed plans array and every miscopied enum value throws');
  const VALUES = [
    ['plans', 'the --list object pasted in whole', { ...DEVELOP_ARGS, plans: { blocks: DEVELOP_ARGS.plans } }],
    ['plans[].mode', 'mode:"bogus", which names no frame this engine holds', { ...DEVELOP_ARGS, plans: [{ id: 'block-a', mode: 'bogus' }] }],
    ['plans[].gate', 'gate:"red-baseline" on a FEATURE block (a section gate)', { ...DEVELOP_ARGS, plans: [{ id: 'block-a', mode: 'feature', gate: 'red-baseline' }] }],
    ['plans[].status', 'status:"wip"', { ...DEVELOP_ARGS, plans: [{ id: 'block-a', mode: 'feature', status: 'wip' }] }],
    ['suite', 'suite:"all"', { ...DEVELOP_ARGS, suite: 'all' }],
    ['sweep', 'sweep:"always"', { ...DEVELOP_ARGS, sweep: 'always' }],
  ];
  for (const [path, what, args] of VALUES) {
    const msg = await throwsWith(engine, { args, respond: {} });
    ok(msg !== '', `${path} = ${what} throws: ${msg.slice(0, 50)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// refine-cycle's severity FLOOR is a control VALUE, not a missing arg, so the deletion sweep above cannot
// reach it: `critiqueSeverity` has a documented default, and OMITTING it is legal. A typo that coerced
// would silently redefine what a clean plan is — the floor decides which gaps count as gaps and which are
// demoted to the critique file's FYI section, and the loop ends on one round with no counted gaps.
// ---------------------------------------------------------------------------------------------
{
  const engine = 'workflows/refine/refine-cycle.mjs';
  section('refine-cycle.mjs — an illegal severity floor throws instead of coercing');
  const msg = await throwsWith(engine, { args: { ...REFINE_ARGS, critiqueSeverity: 'nit' }, respond: {} });
  ok(msg !== '', `critiqueSeverity = "nit" throws: ${msg.slice(0, 50)}`);
}
