// Flow-map scenarios for enhance-cycle — the READ-ONLY FAN-OUT shape (finder → CONDITIONAL verifier),
// fanned out by LENS rather than by unit. Contract + every derivation rule: the header of
// ../gen-flows.mjs. Regenerate with `node tools/gen-flows.mjs enhance`; `--check` fails the gate while
// FLOW.md is stale.
//
// A lens with nothing above the impact floor never reaches the verifier (enhance-cycle.mjs:366-370), so
// the graph has two exits from `find`: straight to a terminal, or on through `verify`. The engine returns
// no `status`, so every non-throwing scenario declares its `terminal`.
//
// A dead finder is dropped at stage 1 and reported in `failed`, like brainstorm's dead generator. It
// spawns no extra agent, so its own declared terminal is the only place the map can tell it apart.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  target: { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' },
  scope: ['workflows/', 'tools/'],
  goals: 'fewer agents, fewer tokens, less operator babysitting',
};

const CANDIDATE = {
  title: 'fold the two verifier roles into one',
  category: 'simplification',
  impact: 'high',
  effort: 'small',
  files: ['workflows/enhance/enhance-cycle.mjs:330'],
  today: 'each lens spawns its own verifier',
  instead: 'one verifier reads every lens',
  cost_removed: 'one agent per lens',
  risk: 'a single verifier turn gets longer',
};
const FOUND = { wrote_clean_marker: false, candidates: [CANDIDATE] };
// Reported, then floored out by the engine before verify (:356-357).
const BELOW_FLOOR = { wrote_clean_marker: false, candidates: [{ ...CANDIDATE, impact: 'marginal' }] };

// Verdict ids are the ones the ENGINE minted (`<slug(lens)>-<n>`), read back off the label: a stray id is
// dropped by the engine's own guard (:384-392), so hard-coding one would quietly stop exercising the
// counting and return-building code the trace runs through.
const verifier = (label) => ({
  wrote_file: true,
  verdicts: [{
    candidate_id: `${label.replace(/^verify:/, '')}-1`,
    is_real: true,
    impact: 'high',
    effort: 'small',
    decision: 'ADOPT',
    theme: 'roles',
  }],
});

export default {
  engine: 'workflows/enhance/enhance-cycle.mjs',
  out: 'workflows/enhance/FLOW.md',
  title: 'enhance-cycle',
  scenarios: [
    {
      name: 'two lenses propose',
      when: 'both finders return candidates above the floor',
      args: { ...base, lenses: ['efficiency', 'simplification'] },
      respond: { find: FOUND, verify: verifier },
      terminal: 'proposals written',
    },
    {
      // A dead finder returns null at stage 1, stage 2 passes the null on, and the lens lands in `failed`
      // (:352-355, :363, :419).
      name: 'a dead finder',
      when: 'the finder dies (the lens is reported in failed)',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: null },
      terminal: 'lens NOT audited (finder died, lens reported in failed)',
    },
    {
      name: 'nothing above the floor',
      when: 'every candidate scores below the impact floor',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: BELOW_FLOOR },
      terminal: 'no proposal file (the lens produced nothing)',
    },

    // ---- the eight throw sites, in the order the engine checks them ------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'bad minImpact', when: 'args.minImpact names no rank', args: { runId: 'flow', root: 'E:/flow', minImpact: 'enormous' } },
    { name: 'no scope', when: 'args.scope is empty', args: { runId: 'flow', root: 'E:/flow' } },
    {
      // The relative-scope guard: with no repo to resolve `workflows/` against, every finder would read
      // the wrong tree — so the repo is required exactly when a scope path is relative.
      name: 'relative scope, no repo',
      when: 'a scope path is relative and target.repo is missing',
      args: { runId: 'flow', root: 'E:/flow', scope: ['workflows/'] },
    },
    { name: 'no lenses', when: 'args.lenses is empty', args: { ...base } },
    { name: 'colliding lens ids', when: 'two lenses slug to one id', args: { ...base, lenses: ['Fast path', 'fast-path'] } },
  ],
};
