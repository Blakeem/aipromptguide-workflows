// Flow-map scenarios for investigate-cycle — the BOUNDED ROUND LOOP shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs investigate`; `--check` fails the gate while FLOW.md is stale.
//
// Coverage aimed at here: all eight terminal states (they are eight different FACTS — folding any pair is
// how a stopped search gets reported as a finished one), the critic gate in BOTH directions (skipped over
// a later round with nothing to check, forced open on the last round because a determination is due and on
// a run's first round), a contested claim of EACH kind buying another round, and each of the ten throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  criteria: '## Question\nWhich library qualifies?\n## Acceptance Criteria\n- runs on Node 24',
  priorRounds: 0,
};

// An EMPTY round: nothing found, nothing ruled out, nothing claimed. It STALLS the run, so only the
// stalled scenarios script it.
const INV = { wrote_files: true, new_options: 0, disqualified_added: 0, near_misses: 0, rediscovered: 0, next_avenue_confidence: 'medium', exhausted: false, no_solution: false, saturated: false, needs_user: false, option_ids: [] };
const CRIT = { wrote_file: true, upheld: [], verified_ids: [], disqualified: [], near_misses: 0, contests_exhaustion: false, contests_saturation: false, agree: false, needs_user: false, reopened: 0 };
const FOUND = { ...INV, new_options: 1, option_ids: ['opt-a'] };
// A LEARNING round qualifies nothing but closes candidates, so the loop keeps going. A multi-round
// scenario needs it, since an all-zero filler round stalls and ends the run.
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

    // ---- phase: run — the terminal states ------------------------------------------------------
    {
      name: 'exhaustion agreed',
      when: 'the critic agrees the search is closed',
      args: base,
      respond: { investigate: { ...FOUND, exhausted: true }, critique: { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'], agree: true } },
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
      respond: { investigate: { ...FOUND, saturated: true }, critique: { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'], agree: true } },
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
      // The backstop: an empty round leaves the next round nothing to diverge from, so buying one gets the
      // same empty round at full price. A run's first round always runs the critic, so this stall is r2's,
      // reached straight out of the investigator.
      name: 'stalled',
      when: 'a round adds nothing at all',
      args: base,
      respond: { investigate: (label) => (/r1$/.test(label) ? LEARN : INV), critique: CRIT },
    },
    {
      // A run's first round always spawns the critic, even a quiet one: an interrupted earlier attempt may
      // have left option files no critic judged. The stall then leaves the critic, not the investigator.
      name: 'resumed quiet first round',
      when: 'a resumed run\'s first round adds nothing',
      args: { ...base, priorRounds: 2 },
      respond: { investigate: INV, critique: CRIT },
    },
    {
      // Rounds 2..n-1 skip the critic (nothing to check); the LAST round still spawns one, because it
      // owes a determination and that file is what reaches the user. So this scenario draws BOTH edges
      // out of the investigator — the skip and the gate opening on the final round. It must RULE THINGS
      // OUT while qualifying nothing: an all-zero round stalls and there is no later round to draw.
      name: 'quiet rounds',
      when: 'a round only rules candidates out',
      args: base,
      respond: { investigate: LEARN, critique: CRIT },
    },
    {
      // The resumed first round reads the last invocation's review, so its prompt is a variant of its own.
      name: 'resumed search',
      when: 'a search resumes after round 2',
      args: { ...base, priorRounds: 2 },
      respond: { investigate: { ...FOUND, exhausted: true }, critique: { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'], agree: true } },
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
      respond: { investigate: { ...FOUND, needs_user: true }, critique: { ...CRIT, upheld: ['opt-a'], verified_ids: ['opt-a'] } },
    },
    {
      name: 'critic escalates',
      when: 'the critic finds a criteria contradiction',
      args: base,
      respond: { investigate: FOUND, critique: { ...CRIT, needs_user: true } },
    },
    {
      // Both escalations above add an option, so the critic gate opens and the halt is drawn leaving the
      // CRITIC. An investigator that escalates in a QUIET later round (nothing found, nothing claimed)
      // skips the critic entirely and halts straight out of the investigator. Nothing can force this
      // scenario: `BLOCKED (needs user input)` is already covered, so terminal coverage stays green while
      // the edge is missing from the map. r1 is a LEARN round, since a run's first round always runs the critic.
      name: 'investigator escalates in a quiet round',
      when: 'the investigator escalates before finding anything',
      args: base,
      respond: { investigate: (label) => (/r1$/.test(label) ? LEARN : { ...INV, needs_user: true }), critique: CRIT },
    },
    {
      // Two routes into one terminal, one per writer, since coverage cannot see the second route.
      name: 'investigator does not attest its files',
      when: 'the investigator does not confirm writing its files',
      args: base,
      respond: { investigate: { ...FOUND, wrote_files: false } },
    },
    {
      name: 'critic does not attest its review file',
      when: 'the critic does not confirm writing its review file',
      args: base,
      respond: { investigate: FOUND, critique: { ...CRIT, wrote_file: false } },
    },

    // ---- the throw sites -------------------------------------------------------------------------
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
      respond: { investigate: (label) => (/r3$/.test(label) ? null : LEARN), critique: CRIT },
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
    { name: 'unknown phase', when: 'phase is neither refine nor run', args: { ...base, phase: 'Refine' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no criteria', when: 'neither criteria nor planPath', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'no priorRounds', when: 'phase:"run" without priorRounds', args: { runId: 'flow', root: 'E:/flow', criteria: base.criteria } },
  ],
};
