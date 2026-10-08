// Flow-map scenarios for decide-cycle — a LENSED FAN-OUT feeding a BOUNDED CONVERGENCE LOOP.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs decide`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all four terminal states, the agree-gate ending the loop versus a review that
// buys another round, BOTH needs-user escalations (the decider's and the reviewer's — two separate exits
// landing on ONE status string, so terminal coverage alone leaves half the engine undrawn), BOTH
// unattested-write halts (the decider's and the reviewer's, for the same reason), a PARTIAL
// analyst failure the run survives on the remaining lenses, and each of the ten throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  planPath: 'E:/flow/plans/flow/requirements.md',
  lenses: ['efficiency', 'simplest', 'robustness'],
};

const ANALYST = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, open_questions: 0, needs_user: false };
const AGREE   = { wrote_file: true, agree: true, gap_ids: [], needs_user: false };
const GAPS    = { ...AGREE, agree: false, gap_ids: ['slug-a', 'slug-b'] };

export default {
  engine: 'workflows/decide/decide-cycle.mjs',
  out: 'workflows/decide/FLOW.md',
  title: 'decide-cycle',
  scenarios: [
    // ---- the three terminal states --------------------------------------------------------------
    {
      name: 'reviewer agrees',
      when: 'the reviewer agrees the conclusion holds',
      args: base,
      respond: { analyst: ANALYST, decide: DECIDE, review: AGREE },
    },
    {
      name: 'gaps to the round budget',
      when: 'the reviewer keeps finding gaps',
      args: base,
      respond: { analyst: ANALYST, decide: DECIDE, review: GAPS },
    },
    {
      // The decider's escalation: it breaks BEFORE the reviewer runs.
      name: 'decider escalates',
      when: 'the decider hits a user-only call',
      args: base,
      respond: { analyst: ANALYST, decide: { ...DECIDE, needs_user: true }, review: AGREE },
    },
    {
      // The reviewer's escalation: a different exit, a different halt reason, the SAME status string.
      // Without this scenario the diagram would show one edge into BLOCKED and hide the other.
      name: 'reviewer escalates',
      when: 'the reviewer finds a requirement contradiction',
      args: base,
      respond: { analyst: ANALYST, decide: DECIDE, review: { ...GAPS, needs_user: true } },
    },
    {
      // One terminal, two writers: each halt names a different file, so each needs its own edge.
      name: 'decider does not attest its file',
      when: 'the decider does not confirm writing its decision file',
      args: base,
      respond: { analyst: ANALYST, decide: { ...DECIDE, wrote_file: false }, review: AGREE },
    },
    {
      name: 'reviewer does not attest its file',
      when: 'the reviewer does not confirm writing its review file',
      args: base,
      respond: { analyst: ANALYST, decide: DECIDE, review: { ...GAPS, wrote_file: false } },
    },

    // ---- survivable failure ---------------------------------------------------------------------
    {
      // One lens dies inside parallel() (null, not a throw): it is dropped from convergence and the
      // decider runs over the surviving two. Distinct from the all-failed throw below.
      name: 'one lens dies',
      when: 'one analyst produces no lens file',
      args: base,
      respond: { 'analyst:robustness': null, analyst: ANALYST, decide: DECIDE, review: AGREE },
    },

    // ---- the ten throw sites -------------------------------------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    {
      name: 'every lens dies',
      when: 'no analyst produced a lens file',
      args: base,
      respond: { analyst: null },
    },
    {
      name: 'dead decider',
      when: 'the decider dies',
      args: base,
      respond: { analyst: ANALYST, decide: null },
    },
    {
      name: 'dead reviewer',
      when: 'the reviewer dies',
      args: base,
      respond: { analyst: ANALYST, decide: DECIDE, review: null },
    },
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN, the
    // decide loop never runs, and a zero-agent run comes back naming a decision-r0.md nothing wrote.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'bad selection', when: 'selection is neither single nor ranked', args: { runId: 'flow', root: 'E:/flow', selection: 'best' } },
    { name: 'no planPath', when: 'args carry no planPath', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'one lens only', when: 'fewer than two lenses', args: { ...base, lenses: ['efficiency'] } },
    { name: 'colliding lens ids', when: 'two lenses slug to one file', args: { ...base, lenses: ['Fast path', 'fast-path'] } },
  ],
};
