// Flow-map scenarios for decide-cycle — a LENSED FAN-OUT feeding a BOUNDED CONVERGENCE LOOP.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs decide`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all three terminal states, the agree-gate ending the loop versus a review that
// buys another round, BOTH needs-user escalations (the decider's and the reviewer's — two separate exits
// landing on ONE status string, so terminal coverage alone leaves half the engine undrawn), a PARTIAL
// analyst failure the run survives on the remaining lenses, and each of the ten throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  requirements: '## Decision\nWhich cache layer?\n## Non-negotiables\n- no new paid dependency\n## Weighted criteria\n- latency (weight 3)',
  lenses: ['efficiency', 'simplest', 'robustness'],
};

const ANALYST = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, open_questions: 0, needs_user: false };
const AGREE   = { wrote_file: true, agree: true, gap_count: 0, gap_ids: [], needs_user: false };
// The ids must MATCH gap_count: a review returning a count with no slugs behind it is self-contradictory,
// and the engine logs a ⚠ for it — in two scenarios here, over a return that is meant to be well-formed.
const GAPS    = { ...AGREE, agree: false, gap_count: 2, gap_ids: ['slug-a', 'slug-b'] };

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
    { name: 'no requirements', when: 'neither requirements nor planPath', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'one lens only', when: 'fewer than two lenses', args: { ...base, lenses: ['efficiency'] } },
    { name: 'colliding lens ids', when: 'two lenses slug to one file', args: { ...base, lenses: ['Fast path', 'fast-path'] } },
  ],
};
