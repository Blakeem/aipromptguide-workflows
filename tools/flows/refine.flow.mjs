// Flow-map scenarios for refine-cycle — the CONVERGING PLAN-REVIEW loop, over ONE plan file.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs refine`; `--check` fails the gate while FLOW.md is stale.
//
// READ THIS BESIDE tools/flows/investigate.flow.mjs — the same non-blind bounded-round shape, and the same
// rule that every terminal is its OWN fact. Nothing here builds, stages, parks or commits, so there is no
// park scenario and no PARK_* script to fill in: refine's whole exit surface is the seven HALT_STATUS
// values plus the dead-critic throw.
//
// TWO scenarios reach `converged` and both are load-bearing. The round-1 clean round is the only path that
// never spawns the editor at all; the multi-round one is the only path that draws the
// plan-editor -> plan-critic back edge, and the loop is invisible in the map without it.
//
// The two DEAD-AGENT policies are deliberately different, and neither is visible to any other assertion —
// no new role, and the throw adds no HALT_STATUS value — so each needs its own scenario. A dead CRITIC
// throws, because zero gaps from an agent that died is byte-identical to convergence. A dead EDITOR halts
// `agent-dead`, because the round's critique file is already on disk and a resumeFromRunId relaunch
// replays the cached critic and redoes the fold.

const TARGET = { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' };

// planPath resolves against `root`, i.e. OUTSIDE the target repo — which is what keeps the plan and the
// critique files away from develop-cycle's blind reviewer. A path inside the repo only warns, so it would
// draw the identical map and prove nothing.
const base = { runId: 'flow', root: 'E:/flow', target: TARGET, planPath: 'plans/bus.md' };

// Critic returns. Counts plus one attestation are the WHOLE control plane: every gap, grade and citation
// crosses to the editor through the critique file, which the harness never sees.
const CLEAN     = { wrote_file: false, gap_count: 0, question_count: 0 };
const GAPS      = { wrote_file: true, gap_count: 2, question_count: 0 };
const QUESTIONS = { wrote_file: true, gap_count: 0, question_count: 1 };
// Counts saying there was something to write, with nothing written: the findings exist nowhere.
const UNWRITTEN = { wrote_file: false, gap_count: 2, question_count: 0 };

const FOLD_OK = { wrote_file: true, folded: 2, declined: 1, plan_parses: true };

const firstRound = (a, b) => (label) => (/r1$/.test(label) ? a : b);

export default {
  engine: 'workflows/refine/refine-cycle.mjs',
  out: 'workflows/refine/FLOW.md',
  title: 'refine-cycle',
  scenarios: [
    // ---- arg validation, in the order the engine checks it ---------------------------------------
    // `args` reaches an engine verbatim from the Workflow tool, so a hand-built payload with a missing `}`
    // arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'no runId', when: 'args.runId is missing', args: { root: 'E:/flow', target: TARGET, planPath: 'plans/bus.md' } },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow', target: TARGET, planPath: 'plans/bus.md' } },
    // The plan file is the whole subject of the loop. Without it an opus critic would be spawned against
    // nothing and would return a plausible clean round for a plan it never saw.
    { name: 'no plan file', when: 'args.planPath is missing', args: { runId: 'flow', root: 'E:/flow', target: TARGET } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow', planPath: 'plans/bus.md' } },
    // One throw site serves every numeric bound. Without it `round < NaN` is false on the first test, the
    // loop never runs, and the engine reports `converged` on a plan no critic ever read.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    // The floor decides which gaps COUNT and which are demoted to the critique file's FYI section, so a
    // coerced value silently changes what "clean" means.
    { name: 'severity floor is not a known grade', when: 'critiqueSeverity is outside blocking | major | minor', args: { ...base, critiqueSeverity: 'nit' } },

    // ---- the terminal states, one scenario per distinct fact -------------------------------------
    {
      // The success state, and the only path that spawns no editor: a critic that ran, read the ledger,
      // and found nothing at or above the floor.
      name: 'a clean first round',
      when: 'the first critic finds nothing',
      args: base,
      respond: { 'plan-critic': CLEAN },
    },
    {
      // The loop as it is meant to run, and the ONLY scenario that draws the back edge.
      name: 'gaps folded, then a clean round',
      when: 'a fold, then a clean round',
      args: base,
      respond: { 'plan-critic': firstRound(GAPS, CLEAN), 'plan-editor': FOLD_OK },
    },
    {
      // An ordering error, an oversized block, or a gap in an already-done block: the minimal-fold editor
      // has no legal edit for any of them, so the run ends for the operator to restructure.
      name: 'questions for the operator',
      when: 'the critic raises a question',
      args: base,
      respond: { 'plan-critic': QUESTIONS },
    },
    {
      // Its own terminal: the ruling is recorded in DISMISSED-PLAN.md, not by restructuring the plan.
      name: 'the editor escalates a contested dismissal',
      when: 'the editor escalates a contested dismissal',
      args: base,
      respond: { 'plan-critic': GAPS, 'plan-editor': { ...FOLD_OK, needs_user: true } },
    },
    {
      // No maxRounds override, so the back edge's measured repeat shows the engine's real default budget.
      // Its `when` is kept short for the same arrow: an UNMARKED back edge carries its conditions nowhere
      // else, so a condition the label budget drops is a condition the map loses entirely.
      name: 'the round budget runs out',
      when: 'gaps remain at the round budget',
      args: base,
      respond: { 'plan-critic': GAPS, 'plan-editor': FOLD_OK },
    },
    {
      name: 'the critique file was never written',
      when: 'the critic reports findings it did not write',
      args: base,
      respond: { 'plan-critic': UNWRITTEN },
    },
    {
      name: 'the fold is unattested',
      when: 'the editor reports folds it did not write',
      args: base,
      respond: { 'plan-critic': GAPS, 'plan-editor': { ...FOLD_OK, wrote_file: false } },
    },
    {
      // The plan-bus grammar is strict and every later consumer reads this file, so a broken parse is
      // repaired by hand rather than by another round.
      name: 'the folded plan no longer parses',
      when: 'the plan file stops parsing after the fold',
      args: base,
      respond: { 'plan-critic': GAPS, 'plan-editor': { ...FOLD_OK, plan_parses: false } },
    },

    // ---- the two death policies ------------------------------------------------------------------
    {
      name: 'the editor dies',
      when: 'the plan editor dies',
      args: base,
      respond: { 'plan-critic': GAPS, 'plan-editor': null },
    },
    {
      name: 'the critic dies',
      when: 'the plan critic dies',
      args: base,
      respond: { 'plan-critic': null },
    },
  ],
};
