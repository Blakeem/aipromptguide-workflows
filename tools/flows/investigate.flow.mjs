// Flow-map scenarios for investigate-cycle — the BOUNDED ROUND LOOP shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs investigate`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all seven terminal states (they are seven different FACTS — folding any pair is
// how a stopped search gets reported as a finished one), the critic gate in BOTH directions (skipped over
// a round with nothing to check, forced open on the last round because a determination is due), a
// contested claim of EACH kind buying another round, and each of the eight throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  criteria: '## Question\nWhich library qualifies?\n## Acceptance Criteria\n- runs on Node 24',
};

// An EMPTY round: nothing found, nothing ruled out, nothing claimed. This one now STALLS the run, so it
// is the stalled scenario's script and nothing else's.
const INV = { wrote_files: true, new_options: 0, disqualified_added: 0, near_misses: 0, rediscovered: 0, next_avenue_confidence: 'medium', exhausted: false, no_solution: false, saturated: false, needs_user: false, option_ids: [] };
const CRIT = { wrote_file: true, upheld: [], disqualified: [], near_misses: 0, contests_exhaustion: false, contests_saturation: false, agree: false, needs_user: false };
const FOUND = { ...INV, new_options: 1, option_ids: ['opt-a'] };
// A LEARNING round: it qualifies nothing but closes candidates, so the critic gate stays shut and the loop
// keeps going. This is what a multi-round scenario has to be scripted with now — an all-zero filler round
// stalls at r1 and the rounds after it never happen.
const LEARN = { ...INV, disqualified_added: 1 };

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

    // ---- phase: run — the seven terminal states ------------------------------------------------
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
      // Saturation is a STOPPED search, not a closed one, and it has its own terminal for exactly that
      // reason — folding it into 'exhausted' is how "I stopped looking" becomes "nothing else is there".
      name: 'saturation agreed',
      when: 'the critic agrees the search has run dry',
      args: base,
      respond: { investigate: { ...FOUND, saturated: true }, critique: { ...CRIT, upheld: ['opt-a'], agree: true } },
    },
    {
      // Its own contest flag, so its own back-edge: a saturation claim waved through by a coverage verdict
      // would be a stop nobody checked.
      name: 'saturation contested',
      when: 'the critic contests the saturation claim',
      args: base,
      respond: { investigate: { ...FOUND, saturated: true }, critique: { ...CRIT, contests_saturation: true } },
    },
    {
      // The backstop, and the one terminal reached WITHOUT a critic ever running: an empty round leaves
      // the next round nothing to diverge from, so buying one gets the same empty round at full price.
      name: 'stalled',
      when: 'a round adds nothing at all',
      args: base,
      respond: { investigate: INV },
    },
    {
      // Rounds 1..n-1 skip the critic (nothing to check); the LAST round still spawns one, because it
      // owes a determination and that file is what reaches the user. So this scenario draws BOTH edges
      // out of the investigator — the skip and the gate opening on the final round. It must RULE THINGS
      // OUT while qualifying nothing: an all-zero round stalls at r1 and there is no r2 to draw.
      name: 'quiet rounds',
      when: 'a round only rules candidates out',
      args: base,
      respond: { investigate: LEARN, critique: CRIT },
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

    // ---- the seven throw sites -------------------------------------------------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    {
      name: 'dead investigator (round 1)',
      when: 'the investigator dies',
      args: base,
      respond: { investigate: null },
    },
    {
      // Same SITE, different round: the message interpolates the round number, so keying on the message
      // would mint two nodes for one throw. This scenario is what proves it does not. The filler rounds
      // are LEARN, not INV — an all-zero r1 stalls the run and r3 never happens.
      name: 'dead investigator (round 3)',
      when: 'the investigator dies mid-search',
      args: base,
      respond: { investigate: (label) => (/r3$/.test(label) ? null : LEARN) },
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
