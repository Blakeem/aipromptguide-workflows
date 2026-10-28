// Flow-map scenarios for decide-cycle — a LENSED FAN-OUT feeding a BOUNDED CONVERGENCE LOOP.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs decide`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all five terminal states, the reviewer accepting versus a reject that buys
// another round (a challenger and a must violation take the same engine path, so each gets its own
// scenario only to name it on the map), the research loop's three stops (covered, saturated, cap), the
// staged review's check results (a matching lock, a lock mismatch that falls back to the locked blind
// verdict, a missing lock rerun once and then BLOCKED), BOTH needs-user escalations (the decider's and the
// reviewer's — two separate exits landing on ONE status string, so terminal coverage alone leaves half the
// engine undrawn), ALL FOUR unattested-write halts (the decider's, the researchers', the check agent's and
// the reviewer's, for the same reason), a PARTIAL lens researcher failure the run survives on the
// remaining lenses, and each throw site.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  planPath: 'E:/flow/plans/flow/requirements.md',
  lenses: ['efficiency', 'simplest', 'robustness'],
  checkTool: 'E:/flow/tools/review-check.mjs',
};

const LENS    = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, flip: 'robust', open_issue_ids: [], user_checks: 0, needs_user: false };
const OPEN    = { ...DECIDE, open_issue_ids: ['p99-unproven'] };
const ISSUE   = { wrote_file: true, new_evidence: true };
// The decider names an open issue on its first pass only, so one research round covers it.
const OPEN_ONCE = (label) => (label === 'decide r1' ? OPEN : DECIDE);
const ACCEPT  = { wrote_file: true, verdict: 'accept', needs_user: false };
const REJECT  = { ...ACCEPT, verdict: 'reject' };
// One object answers both check-agent calls: the setup reads wrote_file, the verify the other three.
const CHECK   = { wrote_file: true, exit_code: 0, final_line: 'raised 0, withdrawn 0, kept 0, downgraded 0', stage1_verdict: '' };
const KEPT    = { ...CHECK, final_line: 'raised 2, withdrawn 1, kept 1, downgraded 0' };
const NO_LOCK = { ...CHECK, exit_code: 2 };
// Round 1's reviewer keeps an objection, and round 2's withdraws or downgrades it.
const REJECT_ONCE = (label) => (label.startsWith('check r1') ? KEPT : CHECK);

export default {
  engine: 'workflows/decide/decide-cycle.mjs',
  out: 'workflows/decide/FLOW.md',
  title: 'decide-cycle',
  scenarios: [
    // ---- the terminal states --------------------------------------------------------------------
    {
      name: 'reviewer accepts',
      when: 'the reviewer keeps no objection',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK },
    },
    {
      name: 'reject with a challenger',
      when: 'the reviewer keeps a challenger that scores above the winner',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: (label) => (label.startsWith('review r1') ? REJECT : ACCEPT), check: REJECT_ONCE },
    },
    {
      name: 'reject with a must violation',
      when: 'the reviewer keeps a non-negotiable the winner violates',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: (label) => (label.startsWith('review r1') ? REJECT : ACCEPT), check: REJECT_ONCE },
    },
    {
      name: 'rejects to the round budget',
      when: 'the reviewer keeps an objection every round',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: REJECT, check: KEPT },
    },
    {
      // The blind review changed after its lock, so the locked blind verdict stands in for the counts.
      name: 'lock mismatch',
      when: 'the blind review changed after its lock, and its locked verdict is accept',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: { ...CHECK, exit_code: 3, stage1_verdict: 'accept' } },
    },
    {
      name: 'reviewer skips the check once',
      when: 'the reviewer never runs the check, and its rerun does',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: (label) => (label === 'check r1' ? NO_LOCK : CHECK) },
    },
    {
      name: 'reviewer never runs the check',
      when: 'the reviewer and its rerun never run the check',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: NO_LOCK },
    },
    // ---- the research loop's three stops ---------------------------------------------------------
    {
      // Covered: one research round settles the open issue, and the next decider pass names none.
      name: 'research covers the open issues',
      when: 'the decider names an open issue and the next pass names none',
      args: base,
      respond: { research: LENS, 'research-issue': ISSUE, decide: OPEN_ONCE, review: ACCEPT, check: CHECK },
    },
    {
      name: 'research saturates',
      when: 'two research rounds in a row find no new evidence',
      args: base,
      respond: { research: LENS, 'research-issue': { ...ISSUE, new_evidence: false }, decide: OPEN, review: ACCEPT, check: CHECK },
    },
    {
      name: 'research hits the cap',
      when: 'every research round finds new evidence until maxResearchRounds is spent',
      args: base,
      respond: { research: LENS, 'research-issue': ISSUE, decide: OPEN, review: ACCEPT, check: CHECK },
    },
    {
      name: 'researcher does not attest its file',
      when: 'a researcher does not confirm writing its research file',
      args: base,
      respond: { research: LENS, 'research-issue': { ...ISSUE, wrote_file: false }, decide: OPEN, review: ACCEPT, check: CHECK },
    },
    {
      // The decider's escalation: it breaks BEFORE the reviewer runs.
      name: 'decider escalates',
      when: 'the decider hits a user-only call',
      args: base,
      respond: { research: LENS, decide: { ...DECIDE, needs_user: true }, review: ACCEPT, check: CHECK },
    },
    {
      // The reviewer's escalation: a different exit, a different halt reason, the SAME status string.
      // Without this scenario the diagram would show one edge into BLOCKED and hide the other.
      name: 'reviewer escalates',
      when: 'the reviewer finds a requirement contradiction',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: { ...REJECT, needs_user: true }, check: CHECK },
    },
    {
      // One terminal, several writers: each halt names a different file, so each needs its own edge.
      name: 'decider does not attest its file',
      when: 'the decider does not confirm writing its decision file and ledger',
      args: base,
      respond: { research: LENS, decide: { ...DECIDE, wrote_file: false }, review: ACCEPT, check: CHECK },
    },
    {
      name: 'check agent does not attest its files',
      when: 'the check agent does not confirm writing the check spec and reveal text',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: { ...CHECK, wrote_file: false } },
    },
    {
      name: 'reviewer does not attest its file',
      when: 'the reviewer does not confirm writing its blind review',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: { ...REJECT, wrote_file: false }, check: CHECK },
    },

    // ---- survivable failure ---------------------------------------------------------------------
    {
      // One lens dies inside parallel() (null, not a throw): it is dropped from convergence and the
      // decider runs over the surviving two. Distinct from the all-failed throw below.
      name: 'one lens dies',
      when: 'one lens researcher produces no lens file',
      args: base,
      respond: { 'research:robustness': null, research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK },
    },

    // ---- the throw sites ----------------------------------------------------------------------------
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
      respond: { research: LENS, 'research-issue': null, decide: OPEN, review: ACCEPT, check: CHECK },
    },
    {
      name: 'dead reviewer',
      when: 'the reviewer dies',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: null, check: CHECK },
    },
    {
      name: 'dead check agent before the review',
      when: 'the check agent dies writing the check spec',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK, 'check-setup': null },
    },
    {
      name: 'dead check agent after the review',
      when: 'the check agent dies running the check',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: null, 'check-setup': CHECK },
    },
    {
      // A result outside the tool's documented exits must not read as a verdict.
      name: 'unreadable check result',
      when: 'the check agent returns an exit code or a last line the tool never prints',
      args: base,
      respond: { research: LENS, decide: DECIDE, review: ACCEPT, check: { ...CHECK, exit_code: 1, final_line: 'usage' } },
    },
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN, the
    // decide loop never runs, and a zero-agent run comes back naming a decision-r0.md nothing wrote.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'bad selection', when: 'selection is neither single nor ranked', args: { runId: 'flow', root: 'E:/flow', selection: 'best' } },
    // A role map that coerced would send an agent to an unintended model or effort without a word in any log line.
    { name: 'models is not an object', when: 'models is an array in place of an object', args: { ...base, models: ['opus'] } },
    { name: 'models names an unknown role', when: 'models carries a key outside research | decide | review | check', args: { ...base, models: { planner: 'opus' } } },
    { name: 'models names an unknown model', when: 'models maps a role to a model outside opus | sonnet | haiku | fable', args: { ...base, models: { research: 'gpt' } } },
    { name: 'efforts names an unknown level', when: 'efforts maps a role to a level outside low | medium | high | xhigh | max', args: { ...base, efforts: { research: 'ultra' } } },
    { name: 'agentTypes names an unknown role', when: 'agentTypes is not an object, carries a key outside research | decide | review | check, or maps one to a blank name', args: { ...base, agentTypes: { analyst: 'my-analyst' } } },
    { name: 'notes missing a path', when: 'notes lacks dir or survey, or names a relative path', args: { ...base, notes: { dir: 'E:/flow/notes' } } },
    { name: 'no planPath', when: 'args carry no planPath', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'no checkTool', when: 'args carry no checkTool', args: { runId: 'flow', root: 'E:/flow', planPath: 'E:/flow/plans/flow/requirements.md' } },
    { name: 'one lens only', when: 'fewer than two lenses', args: { ...base, lenses: ['efficiency'] } },
    { name: 'colliding lens ids', when: 'two lenses slug to one file', args: { ...base, lenses: ['Fast path', 'fast-path'] } },
    // A run launched inside a user turn relays that message to every agent, and the first agent says so.
    { name: 'a user request is relayed', when: 'a lens researcher reports a user request relayed into its context', args: base, respond: { research: { ...LENS, relayed_request: true } } },
  ],
};
