// Flow-map scenarios for investigate-cycle — the BOUNDED ROUND LOOP shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs investigate`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all five terminal states (they are five different FACTS — folding any pair is
// how a stopped search gets reported as a finished one), the critic gate in BOTH directions (skipped over
// an empty round, forced open on the last round because a determination is due), a contested claim buying
// another round, and each of the six throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  criteria: '## Question\nWhich library qualifies?\n## Acceptance Criteria\n- runs on Node 24',
};

// A quiet round: nothing found, nothing claimed. Spread over these to script the interesting rounds.
const INV = { wrote_files: true, new_options: 0, disqualified_added: 0, near_misses: 0, exhausted: false, no_solution: false, needs_user: false, option_ids: [] };
const CRIT = { wrote_file: true, upheld: [], disqualified: [], near_misses: 0, contests_exhaustion: false, agree: false, needs_user: false };
const FOUND = { ...INV, new_options: 1, option_ids: ['opt-a'] };

export default {
  engine: 'workflows/investigate/investigate-cycle.mjs',
  out: 'workflows/investigate/FLOW.md',
  title: 'investigate-cycle',
  scenarios: [
    // ---- phase: refine (its own entry point; the return carries no status) ----------------------
    {
      name: 'refine the criteria',
      when: 'phase:"refine"',
      args: { ...base, phase: 'refine' },
      respond: { 'criteria-critic': { gaps: [{ title: 'no evidence standard' }], questions: [], unfalsifiable: [] } },
      terminal: 'criteria critique returned (refine stops here)',
    },
    {
      name: 'dead criteria critic',
      when: 'the criteria critic dies',
      args: { ...base, phase: 'refine' },
      respond: { 'criteria-critic': null },
    },

    // ---- phase: run — the five terminal states -------------------------------------------------
    {
      name: 'exhaustion agreed',
      when: 'the critic agrees the search is closed',
      args: base,
      respond: { investigate: { ...FOUND, exhausted: true }, critique: { ...CRIT, upheld: ['opt-a'], agree: true } },
    },
    {
      name: 'no solution verified',
      when: 'the critic agrees nothing can qualify',
      args: base,
      respond: { investigate: { ...INV, no_solution: true }, critique: { ...CRIT, agree: true } },
    },
    {
      name: 'exhaustion contested',
      when: 'the critic contests the coverage claim',
      args: base,
      respond: { investigate: { ...FOUND, exhausted: true }, critique: { ...CRIT, contests_exhaustion: true } },
    },
    {
      // Rounds 1..n-1 skip the critic (nothing to check); the LAST round still spawns one, because it
      // owes a determination and that file is what reaches the user. So this scenario draws BOTH edges
      // out of the investigator — the skip and the gate opening on the final round.
      name: 'quiet rounds',
      when: 'a round adds no option and claims nothing',
      args: base,
      respond: { investigate: INV, critique: CRIT },
    },
    {
      // Without a budget the harness default is unlimited, which makes the floor dead code and this
      // terminal unreachable. Stateless on purpose: the scenario is run more than once.
      name: 'token budget floor',
      when: 'too few tokens left to start a round',
      args: base,
      budget: { total: 400_000, spent: () => 0, remaining: () => 40_000 },
      respond: {},
    },
    {
      name: 'investigator escalates',
      when: 'the investigator hits a user-only call',
      args: base,
      respond: { investigate: { ...FOUND, needs_user: true }, critique: { ...CRIT, upheld: ['opt-a'] } },
    },
    {
      name: 'critic escalates',
      when: 'the critic finds a criteria contradiction',
      args: base,
      respond: { investigate: FOUND, critique: { ...CRIT, needs_user: true } },
    },
    {
      // Both escalations above add an option, so the critic gate opens and the halt is drawn leaving the
      // CRITIC. An investigator that escalates in a QUIET round (nothing found, nothing claimed) skips
      // the critic entirely and halts straight out of the investigator — probably the commonest shape,
      // since a criteria contradiction usually surfaces before any candidate does. Nothing can force
      // this scenario: `BLOCKED (needs user input)` is already covered, so terminal coverage stays green
      // while the edge is missing from the map.
      name: 'investigator escalates in a quiet round',
      when: 'the investigator escalates before finding anything',
      args: base,
      respond: { investigate: { ...INV, needs_user: true } },
    },

    // ---- the six throw sites -------------------------------------------------------------------
    {
      name: 'dead investigator (round 1)',
      when: 'the investigator dies',
      args: base,
      respond: { investigate: null },
    },
    {
      // Same SITE, different round: the message interpolates the round number, so keying on the message
      // would mint two nodes for one throw. This scenario is what proves it does not.
      name: 'dead investigator (round 3)',
      when: 'the investigator dies mid-search',
      args: base,
      respond: { investigate: (label) => (/r3$/.test(label) ? null : INV) },
    },
    {
      name: 'dead acceptance critic',
      when: 'the critic dies with options unverified',
      args: base,
      respond: { investigate: FOUND, critique: null },
    },
    {
      // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN,
      // the round loop never runs, and a zero-agent run comes back dressed as a round-budget exit.
      name: 'non-numeric bound',
      when: 'maxRounds is not a number',
      args: { ...base, maxRounds: 'three' },
    },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no criteria', when: 'neither criteria nor planPath', args: { runId: 'flow', root: 'E:/flow' } },
  ],
};
