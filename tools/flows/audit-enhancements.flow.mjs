// Flow-map scenarios for audit's enhancements kind, the READ-ONLY FAN-OUT shape (finder → CONDITIONAL
// verifier): finders fan out by LENS, and verifiers by packed unit of lenses. Contract + every derivation rule:
// the header of ../gen-flows.mjs. Regenerate with `node tools/gen-flows.mjs audit-enhancements`; `--check`
// fails the gate while FLOW-enhancements.md is stale. Role and throw coverage of audit.mjs is the union of
// this spec and audit-defects.flow.mjs.
//
// A lens whose finder returns no candidate never reaches the verifier, so the graph has two exits from
// `find`: straight to a terminal, or on through `verify`. The engine returns no `status`, so every
// non-throwing scenario declares its `terminal`.
//
// A dead finder, a finder with candidate ids and no attested candidates file, a finder whose every id is
// unroutable, and a finder with no candidate and no attested marker each land the lens in `failed` with
// stage `find`, like brainstorm's dead generator. None spawns an extra agent, so its own declared
// terminal is the only place the map can tell it apart from a clean lens.

const KIND = { kind: 'enhancements' };
const LAUNCH_DIR = 'E:/flow/runs/flow/launch-1';
const base = {
  ...KIND,
  runId: 'flow',
  root: 'E:/flow',
  launchDir: LAUNCH_DIR,
  target: { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' },
  scope: ['workflows/', 'tools/'],
  goals: 'fewer agents, fewer tokens, less operator babysitting',
};

// 75 slug characters, so the lens id is cut at 60.
const LONG_LENS = 'operator effort across every engine guide and every skill entry point today';

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
  engine: 'workflows/audit/audit.mjs',
  out: 'workflows/audit/FLOW-enhancements.md',
  title: 'audit (kind enhancements)',
  coverageNote: 'audit.mjs also runs the defects kind, drawn in FLOW-defects.md, so the roles and throw sites only that kind reaches are listed uncovered here. The suite checks coverage over both maps.',
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
    {
      // A saved run's proposal file names stay where they were: the lens id is cut at 60 characters, not hashed.
      name: 'a lens id past 60 characters',
      when: 'a lens id slugs past 60 characters, so its file name is the 60-character cut',
      args: { ...base, lenses: [LONG_LENS] },
      respond: { find: FOUND, verify: verifier },
      terminal: 'proposals written',
    },

    // ---- the enhancements kind's throw sites and the kind guard, in the order the engine checks them ----
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'a defects arg under kind enhancements', when: 'a kind: enhancements payload holds an arg only the defects kind reads', args: { ...base, lenses: ['efficiency'], units: [{ id: 'u1', hash: 'h', files: [] }] } },
    { name: 'no runId', when: 'args carry no runId', args: { ...KIND } },
    { name: 'no root', when: 'args.root is missing', args: { ...KIND, runId: 'flow' } },
    { name: 'bad minImpact', when: 'args.minImpact names no rank', args: { ...KIND, runId: 'flow', root: 'E:/flow', minImpact: 'enormous' } },
    // A role map that coerced would send an agent to an unintended model or effort without a word in any log line.
    { name: 'models is not an object', when: 'models is an array in place of an object', args: { ...base, models: ['opus'] } },
    { name: 'models names an unknown role', when: 'models carries a key outside find | verify', args: { ...base, models: { planner: 'opus' } } },
    { name: 'models names an unknown model', when: 'models maps a role to a model outside opus | sonnet | haiku | fable', args: { ...base, models: { find: 'gpt' } } },
    { name: 'efforts names an unknown level', when: 'efforts maps a role to a level outside low | medium | high | xhigh | max', args: { ...base, efforts: { find: 'ultra' } } },
    { name: 'agentTypes names an unknown role', when: 'agentTypes is not an object, carries a key outside find | verify, or maps one to a blank name', args: { ...base, agentTypes: { planner: 'my-planner' } } },
    { name: 'notes missing a path', when: 'notes lacks dir or survey, or names a relative path', args: { ...base, notes: { dir: 'E:/flow/notes' } } },
    // Each launch writes its candidates files in its own launch folder, so a launch without one, or with a
    // folder outside the stateDir, would write where another launch did.
    { name: 'no launch folder', when: 'args.launchDir is missing or blank', args: { ...base, launchDir: undefined } },
    { name: 'launch folder outside the stateDir', when: 'args.launchDir is not a launch-<n> folder directly inside the stateDir', args: { ...base, launchDir: 'E:/flow/runs/other/launch-1' } },
    { name: 'no scope', when: 'args.scope is empty', args: { ...KIND, runId: 'flow', root: 'E:/flow', launchDir: LAUNCH_DIR } },
    {
      // The relative-scope guard: with no repo to resolve `workflows/` against, every finder would read
      // the wrong tree — so the repo is required exactly when a scope path is relative.
      name: 'relative scope, no repo',
      when: 'a scope path is relative and target.repo is missing',
      args: { ...KIND, runId: 'flow', root: 'E:/flow', launchDir: LAUNCH_DIR, scope: ['workflows/'] },
    },
    {
      name: 'relative conventionFiles, no repo',
      when: 'a conventionFiles entry is relative and target.repo is missing',
      args: { ...KIND, runId: 'flow', root: 'E:/flow', launchDir: LAUNCH_DIR, scope: ['E:/repo/workflows/'], conventionFiles: ['CLAUDE.md'] },
    },
    { name: 'conventionFiles is not a path list', when: 'args.conventionFiles is not an array of non-empty paths', args: { ...base, conventionFiles: 'CLAUDE.md' } },
    { name: 'no lenses', when: 'args.lenses is empty', args: { ...base } },
    { name: 'colliding lens ids', when: 'two lenses slug to one id', args: { ...base, lenses: ['Fast path', 'fast-path'] } },
    { name: 'lens ids sharing a 60-character prefix', when: 'two lenses differ only past their 60th slug character', args: { ...base, lenses: [`${LONG_LENS} one`, `${LONG_LENS} two`] } },
    // A run launched inside a user turn relays that message to every agent, and the first agent says so.
    { name: 'a user request is relayed', when: 'a finder reports a user request relayed into its context, so no verifier runs', args: { ...base, lenses: ['efficiency', 'simplification'] }, respond: { find: (label) => ({ ...FOUND(label), relayed_request: true }), verify: verifier } },
  ],
};
