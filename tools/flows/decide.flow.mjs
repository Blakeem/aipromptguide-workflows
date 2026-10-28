// Flow-map scenarios for decide-cycle — a LENSED FAN-OUT feeding a BOUNDED CONVERGENCE LOOP.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs decide`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all five terminal states (agreement splits into decided and decided with
// caveats), the agree-gate ending the loop versus a review that buys another round, the round-1 focused
// reviewers versus the later-round verifier, the research loop's three stops (covered, saturated, cap),
// BOTH needs-user escalations (the decider's and the reviewers' — two separate exits landing on ONE status
// string, so terminal coverage alone leaves half the engine undrawn), ALL THREE unattested-write halts (the
// decider's, the researchers' and the reviewers', for the same reason), a PARTIAL lens researcher failure
// the run survives on the remaining lenses, and each of the seventeen throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  planPath: 'E:/flow/plans/flow/requirements.md',
  lenses: ['efficiency', 'simplest', 'robustness'],
};

const LENS    = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, flip: 'robust', open_issue_ids: [], user_checks: 0, needs_user: false };
const OPEN    = { ...DECIDE, open_issue_ids: ['p99-unproven'] };
const ISSUE   = { wrote_file: true, new_evidence: true };
// The decider names an open issue on its first pass only, so one research round covers it.
const OPEN_ONCE = (label) => (label === 'decide r1' ? OPEN : DECIDE);
const AGREE   = { wrote_file: true, agree: true, gap_ids: [], caveat_ids: [], needs_user: false };
const GAPS    = { ...AGREE, agree: false, gap_ids: ['slug-a', 'slug-b'] };

export default {
  engine: 'workflows/decide/decide-cycle.mjs',
  out: 'workflows/decide/FLOW.md',
  title: 'decide-cycle',
  scenarios: [
    // ---- the terminal states --------------------------------------------------------------------
    {
      name: 'reviewer agrees',
      when: 'every reviewer agrees: no blocking gap, no caveat',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: AGREE },
    },
    {
      // A second agreed terminal: no reviewer blocks, but one review lists a caveat for the plan.
      name: 'agrees with caveats',
      when: 'every reviewer agrees and one lists a caveat',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: AGREE, 'review r1 design': { ...AGREE, caveat_ids: ['slug-c'] } },
    },
    {
      // The round-1 caveat reaches the round-3 verifier as a file path, which the prompt snapshot shows.
      name: 'gaps to the round budget',
      when: 'the reviewers keep finding blocking gaps',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: GAPS, 'review r1 design': { ...GAPS, caveat_ids: ['slug-c'] } },
    },
    // ---- the research loop's three stops ---------------------------------------------------------
    {
      // Covered: one research round settles the open issue, and the next decider pass names none.
      name: 'research covers the open issues',
      when: 'the decider names an open issue and the next pass names none',
      args: base,
      respond: { research: LENS, 'research-issue': ISSUE, decide: OPEN_ONCE, review: AGREE },
    },
    {
      name: 'research saturates',
      when: 'two research rounds in a row find no new evidence',
      args: base,
      respond: { research: LENS, 'research-issue': { ...ISSUE, new_evidence: false }, decide: OPEN, review: AGREE },
    },
    {
      name: 'research hits the cap',
      when: 'every research round finds new evidence until maxResearchRounds is spent',
      args: base,
      respond: { research: LENS, 'research-issue': ISSUE, decide: OPEN, review: AGREE },
    },
    {
      name: 'researcher does not attest its file',
      when: 'a researcher does not confirm writing its research file',
      args: base,
      respond: { research: LENS, 'research-issue': { ...ISSUE, wrote_file: false }, decide: OPEN, review: AGREE },
    },
    {
      // The decider's escalation: it breaks BEFORE the reviewers run.
      name: 'decider escalates',
      when: 'the decider hits a user-only call',
      args: base,
      respond: { research: LENS, decide: { ...DECIDE, needs_user: true }, review: AGREE },
    },
    {
      // The reviewers' escalation: a different exit, a different halt reason, the SAME status string.
      // Without this scenario the diagram would show one edge into BLOCKED and hide the other.
      name: 'reviewer escalates',
      when: 'a reviewer finds a requirement contradiction',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: { ...GAPS, needs_user: true } },
    },
    {
      // One terminal, two writers: each halt names a different file, so each needs its own edge.
      name: 'decider does not attest its file',
      when: 'the decider does not confirm writing its decision file',
      args: base,
      respond: { research: LENS, decide: { ...DECIDE, wrote_file: false }, review: AGREE },
    },
    {
      name: 'reviewer does not attest its file',
      when: 'a reviewer does not confirm writing its review file',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: { ...GAPS, wrote_file: false } },
    },

    // ---- survivable failure ---------------------------------------------------------------------
    {
      // One lens dies inside parallel() (null, not a throw): it is dropped from convergence and the
      // decider runs over the surviving two. Distinct from the all-failed throw below.
      name: 'one lens dies',
      when: 'one lens researcher produces no lens file',
      args: base,
      respond: { 'research:robustness': null, research: LENS, decide: DECIDE, review: AGREE },
    },

    // ---- the seventeen throw sites -----------------------------------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    {
      name: 'every lens dies',
      when: 'no lens researcher produced a lens file',
      args: base,
      respond: { research: null },
    },
    {
      name: 'dead decider',
      when: 'the decider dies',
      args: base,
      respond: { research: LENS, decide: null },
    },
    {
      name: 'dead researcher',
      when: 'a researcher of an open issue dies',
      args: base,
      respond: { research: LENS, 'research-issue': null, decide: OPEN, review: AGREE },
    },
    {
      name: 'dead reviewer',
      when: 'a reviewer dies',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: null },
    },
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN, the
    // decide loop never runs, and a zero-agent run comes back naming a decision-r0.md nothing wrote.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'bad selection', when: 'selection is neither single nor ranked', args: { runId: 'flow', root: 'E:/flow', selection: 'best' } },
    // A role map that coerced would send an agent to an unintended model or effort without a word in any log line.
    { name: 'models is not an object', when: 'models is an array in place of an object', args: { ...base, models: ['opus'] } },
    { name: 'models names an unknown role', when: 'models carries a key outside research | decide | review', args: { ...base, models: { planner: 'opus' } } },
    { name: 'models names an unknown model', when: 'models maps a role to a model outside opus | sonnet | haiku | fable', args: { ...base, models: { research: 'gpt' } } },
    { name: 'efforts names an unknown level', when: 'efforts maps a role to a level outside low | medium | high | xhigh | max', args: { ...base, efforts: { research: 'ultra' } } },
    { name: 'agentTypes names an unknown role', when: 'agentTypes is not an object, carries a key outside research | decide | review, or maps one to a blank name', args: { ...base, agentTypes: { analyst: 'my-analyst' } } },
    { name: 'notes missing a path', when: 'notes lacks dir or survey, or names a relative path', args: { ...base, notes: { dir: 'E:/flow/notes' } } },
    { name: 'no planPath', when: 'args carry no planPath', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'one lens only', when: 'fewer than two lenses', args: { ...base, lenses: ['efficiency'] } },
    { name: 'colliding lens ids', when: 'two lenses slug to one file', args: { ...base, lenses: ['Fast path', 'fast-path'] } },
  ],
};
