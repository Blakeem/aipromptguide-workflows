// Flow-map scenarios for enhance-cycle — the READ-ONLY FAN-OUT shape (finder → CONDITIONAL verifier):
// finders fan out by LENS, and verifiers by packed unit of lenses. Contract + every derivation rule: the header of
// ../gen-flows.mjs. Regenerate with `node tools/gen-flows.mjs enhance`; `--check` fails the gate while
// FLOW.md is stale.
//
// A lens whose finder returns no candidate never reaches the verifier, so the graph has two exits from
// `find`: straight to a terminal, or on through `verify`. The engine returns no `status`, so every
// non-throwing scenario declares its `terminal`.
//
// A dead finder, a finder with candidate ids and no attested candidates file, a finder whose every id is
// unroutable, and a finder with no candidate and no attested marker each land the lens in `failed` with
// stage `find`, like brainstorm's dead generator. None spawns an extra agent, so its own declared
// terminal is the only place the map can tell it apart from a clean lens.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  target: { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' },
  scope: ['workflows/', 'tools/'],
  goals: 'fewer agents, fewer tokens, less operator babysitting',
};

// The finder writes its candidates to a file and returns only their ids, minted as `<lens>-<n>`.
const FOUND = (label) => ({ candidate_ids: [`${label.replace(/^find:/, '')}-1`], wrote_candidates: true, wrote_clean_marker: false });

// One verifier carries every lens its label names (`verify:<lens>+<lens>`), so the verdict ids are read
// back off the label: a stray id is dropped by the engine's own guard, so hard-coding one would quietly
// stop exercising the counting and return-building code the trace runs through.
const verifier = (label) => {
  const lenses = label.replace(/^verify:/, '').split('+');
  return {
    wrote_lenses: lenses,
    verdicts: lenses.map((id) => ({
      candidate_id: `${id}-1`,
      is_real: true,
      impact: 'high',
      size: 'small',
      decision: 'ADOPT',
      theme: 'roles',
    })),
  };
};

export default {
  engine: 'workflows/enhance/enhance-cycle.mjs',
  out: 'workflows/enhance/FLOW.md',
  title: 'enhance-cycle',
  scenarios: [
    {
      name: 'two lenses propose',
      when: 'both finders return candidates, and one packed verifier carries both lenses',
      args: { ...base, lenses: ['efficiency', 'simplification'] },
      respond: { find: FOUND, verify: verifier },
      terminal: 'proposals written',
    },
    {
      // A dead finder returns null, and the lens lands in `failed` as `{ id, stage: 'find' }`.
      name: 'a dead finder',
      when: 'the finder dies (the lens is reported in failed at stage find)',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: null },
      terminal: 'lens NOT audited (finder died, lens in failed at stage find)',
    },
    {
      name: 'a clean lens',
      when: 'the finder returns no candidate and attests its marker',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: true } },
      terminal: 'clean lens (the finder wrote the marker, verify skipped)',
    },
    {
      name: 'candidates file not attested',
      when: 'the finder returns candidate ids and does not attest its candidates file',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: { candidate_ids: ['efficiency-1'], wrote_candidates: false, wrote_clean_marker: false } },
      terminal: 'lens NOT audited (candidates file not attested, lens in failed at stage find)',
    },
    {
      name: 'only unroutable ids',
      when: 'every candidate id the finder returns does not read <lens>-<n>',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: { candidate_ids: ['eff-1'], wrote_candidates: true, wrote_clean_marker: false } },
      terminal: 'lens NOT audited (no routable candidate id, lens in failed at stage find)',
    },
    {
      name: 'no candidate, no marker',
      when: 'the finder returns no candidate and does not attest its marker',
      args: { ...base, lenses: ['efficiency'] },
      respond: { find: { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: false } },
      terminal: 'lens NOT audited (no marker attested, lens in failed at stage find)',
    },

    // ---- the thirteen throw sites, in the order the engine checks them ------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'bad minImpact', when: 'args.minImpact names no rank', args: { runId: 'flow', root: 'E:/flow', minImpact: 'enormous' } },
    // A role map that coerced would send an agent to an unintended model or effort without a word in any log line.
    { name: 'models is not an object', when: 'models is an array in place of an object', args: { ...base, models: ['opus'] } },
    { name: 'models names an unknown role', when: 'models carries a key outside find | verify', args: { ...base, models: { planner: 'opus' } } },
    { name: 'models names an unknown model', when: 'models maps a role to a model outside opus | sonnet | haiku | fable', args: { ...base, models: { find: 'gpt' } } },
    { name: 'efforts names an unknown level', when: 'efforts maps a role to a level outside low | medium | high | xhigh | max', args: { ...base, efforts: { find: 'ultra' } } },
    { name: 'notes missing a path', when: 'notes lacks dir or survey, or names a relative path', args: { ...base, notes: { dir: 'E:/flow/notes' } } },
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
    // A run launched inside a user turn relays that message to every agent, and the first agent says so.
    { name: 'a user request is relayed', when: 'a finder reports a user request relayed into its context, so no verifier runs', args: { ...base, lenses: ['efficiency', 'simplification'] }, respond: { find: (label) => ({ ...FOUND(label), relayed_request: true }), verify: verifier } },
  ],
};
