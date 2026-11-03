// Flow-map scenarios for decide-cycle, a BOUNDED SERIAL CHAIN of investigators, then one decider, then one
// final reviewer, with no loop back. Contract + every derivation rule: the header of ../gen-flows.mjs.
// Regenerate with `node tools/gen-flows.mjs decide`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: the three decided terminals (no edit and no flag, corrections, flags), the chain's
// two stops (dry at the first challenger that contributes nothing, cap at maxInvestigators) and a
// one-investigator run, ALL FOUR unattested-write halts (the opening investigator's, a challenger's, the
// decider's and the reviewer's: one status string, four writers, so each needs its own edge), and each
// throw site.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  planPath: 'E:/flow/plans/flow/requirements.md',
};

const OPEN      = { wrote_file: true, relayed_request: false };
const CHALLENGE = { wrote_file: true, contributed: true };
const RANKING   = [{ rank: 1, title: 'in-process LRU', combines_with: [], excludes: [2] }, { rank: 2, title: 'redis', combines_with: [], excludes: [1] }];
const DECIDE    = { wrote_file: true, ranking: RANKING, flip: 'robust', user_checks: 0 };
const REVIEW    = { wrote_file: true, defects: 0, edits: 0, flags: 0, ranking: RANKING, flip: 'robust' };
const CLEAN     = { 'investigate i1': OPEN, 'investigate i': CHALLENGE, decide: DECIDE, review: REVIEW };

export default {
  engine: 'workflows/decide/decide-cycle.mjs',
  out: 'workflows/decide/FLOW.md',
  title: 'decide-cycle',
  scenarios: [
    // ---- the terminal states --------------------------------------------------------------------
    {
      name: 'every challenger contributes',
      when: 'every challenger contributes, so the chain runs to maxInvestigators',
      args: base,
      respond: CLEAN,
    },
    {
      name: 'reviewer corrects',
      when: 'the final reviewer shows a defect or proves errors and corrects them',
      args: base,
      // A defect's edits count under edits, so a shown defect ends on this terminal too.
      respond: { ...CLEAN, review: { ...REVIEW, defects: 1, edits: 2 } },
    },
    {
      name: 'reviewer flags',
      when: 'the final reviewer flags judgment calls it cannot prove wrong',
      args: base,
      respond: { ...CLEAN, review: { ...REVIEW, edits: 1, flags: 2 } },
    },
    // ---- the chain's stops ------------------------------------------------------------------------
    {
      name: 'a challenger contributes nothing',
      when: 'challenger i2 contributes nothing, so the chain stops dry',
      args: base,
      respond: { ...CLEAN, 'investigate i': { ...CHALLENGE, contributed: false } },
    },
    {
      name: 'one investigator',
      when: 'maxInvestigators is 1, so the opening investigator is the whole chain',
      args: { ...base, maxInvestigators: 1 },
      respond: CLEAN,
    },
    // ---- the unattested-write halts ---------------------------------------------------------------
    {
      name: 'opening investigator does not attest its file',
      when: 'the opening investigator does not confirm writing i1.md',
      args: base,
      respond: { ...CLEAN, 'investigate i1': { ...OPEN, wrote_file: false } },
    },
    {
      name: 'challenger does not attest its file',
      when: 'a challenger does not confirm writing its investigation file',
      args: base,
      respond: { ...CLEAN, 'investigate i': { ...CHALLENGE, wrote_file: false } },
    },
    {
      name: 'decider does not attest its file',
      when: 'the decider does not confirm writing decision.md',
      args: base,
      respond: { ...CLEAN, decide: { ...DECIDE, wrote_file: false } },
    },
    {
      name: 'reviewer does not attest its file',
      when: 'the final reviewer does not confirm writing review.md',
      args: base,
      respond: { ...CLEAN, review: { ...REVIEW, wrote_file: false } },
    },

    // ---- the throw sites ----------------------------------------------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'dead opening investigator', when: 'the opening investigator dies', args: base, respond: { ...CLEAN, 'investigate i1': null } },
    { name: 'dead challenger', when: 'a challenger dies', args: base, respond: { ...CLEAN, 'investigate i': null } },
    { name: 'dead decider', when: 'the decider dies', args: base, respond: { ...CLEAN, decide: null } },
    { name: 'dead reviewer', when: 'the final reviewer dies', args: base, respond: { ...CLEAN, review: null } },
    // An old payload must learn its arg is gone before any agent runs, never run a chain it did not ask for.
    { name: 'retired arg', when: 'args carry an arg the chain retired, such as lenses or checkTool', args: { ...base, lenses: ['efficiency', 'simplest'] } },
    // One throw site serves every numeric bound. Without it a non-numeric bound coerces, no challenger runs, and a one-investigator decision reads as an ordinary result.
    { name: 'non-numeric bound', when: 'maxInvestigators is not a number', args: { ...base, maxInvestigators: 'four' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    // A role map that coerced would send an agent to an unintended model or effort without a word in any log line.
    { name: 'models is not an object', when: 'models is an array in place of an object', args: { ...base, models: ['opus'] } },
    { name: 'models names an unknown role', when: 'models carries a key outside investigate | decide | review, such as the retired research or check', args: { ...base, models: { research: 'opus' } } },
    { name: 'models names an unknown model', when: 'models maps a role to a model outside opus | sonnet | haiku | fable', args: { ...base, models: { investigate: 'gpt' } } },
    { name: 'efforts names an unknown level', when: 'efforts maps a role to a level outside low | medium | high | xhigh | max', args: { ...base, efforts: { investigate: 'ultra' } } },
    { name: 'agentTypes names an unknown role', when: 'agentTypes is not an object, carries a key outside investigate | decide | review, or maps one to a blank name', args: { ...base, agentTypes: { analyst: 'my-analyst' } } },
    { name: 'notes missing a path', when: 'notes lacks dir or survey, or names a relative path', args: { ...base, notes: { dir: 'E:/flow/notes' } } },
    { name: 'no planPath', when: 'args carry no planPath', args: { runId: 'flow', root: 'E:/flow' } },
    // A run launched inside a user turn relays that message to every agent, and the first agent says so.
    { name: 'a user request is relayed', when: 'the opening investigator reports a user request relayed into its context', args: base, respond: { ...CLEAN, 'investigate i1': { ...OPEN, relayed_request: true } } },
  ],
};
