// Flow-map scenarios for debug/review — the READ-ONLY FAN-OUT shape (finder → CONDITIONAL verifier).
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs review`; `--check` fails the gate while FLOW-review.md is stale.
//
// FLOW-review.md, not FLOW.md: review.mjs and resolve-cycle.mjs share workflows/debug/, and they are two
// engines with two runs and two sets of terminal states, with a deliberately non-automatic triage
// conversation between them. resolve gets its own FLOW-resolve.md.
//
// The shape this table exists to draw: a CLEAN unit NEVER reaches the verifier — its reviewer writes the
// marker itself and stage 1 returns without spawning anything. So "clean unit" and "unit with findings"
// are ONE scenario; that pairing is what puts both the review → terminal edge and the
// review → verify → terminal chain in the same graph. The engine returns no `status`, so every
// non-throwing scenario declares its `terminal` (gen-flows' TERMINAL IDENTITY rule 2).

const base = {
  runId: 'flow',
  root: 'E:/flow',
  target: { repo: 'E:/repo', lang: 'JavaScript', framework: 'none' },
  conventions: 'zero dependencies; LF only',
};

const unit = (id, extra = {}) => ({ id, hash: `hash-${id}`, files: [{ path: `src/${id}.js`, loc: 120 }], ...extra });
// Two lenses over the SAME files — the array form, one reviewer per lens behind ONE verifier.
const LENSES = [
  { id: 'destructive', mandate: 'auditing DESTRUCTIVE behavior' },
  { id: 'data-loss', mandate: 'auditing DATA LOSS' },
];

const FINDING = { file: 'src/u1.js', line: '42', category: 'correctness', severity: 'high', title: 'unguarded null', detail: 'the agent return is used without a null check', suggested_fix: 'guard it' };
const FOUND = { wrote_clean_marker: false, findings: [FINDING] };
const CLEAN = { wrote_clean_marker: true, findings: [] };

// Verdicts are keyed back to the ids the ENGINE minted (`<slug(unit)>-<n>`), derived from the label
// rather than hard-coded: an unknown id is dropped by the engine's own guard, so hard-coding one would
// quietly stop exercising the return-building code the trace runs through.
const verifier = (perUnit) => (label) => ({
  wrote_file: true,
  verdicts: Array.from({ length: perUnit }, (_, i) => ({
    finding_id: `${label.replace(/^verify:/, '')}-${i + 1}`,
    is_real: true,
    severity: 'high',
    decision: 'ACTIONABLE',
    matrix: { clarity: 'clear', effort: 'small', blast_radius: 'local', scope: 'in-scope', architectural: false },
    theme: 'null-guards',
  })),
});

export default {
  engine: 'workflows/debug/review.mjs',
  out: 'workflows/debug/FLOW-review.md',
  title: 'debug/review',
  scenarios: [
    {
      // THE conditional-second-stage proof, and why both units live in one scenario: u1 is clean (its
      // reviewer writes the marker, stage 1 returns at review.mjs:378-382 without spawning), u2 has a
      // finding and reaches the verifier. Two paths out of one `review` node.
      name: 'a clean unit beside one with findings',
      when: 'one unit is clean, the other has findings',
      args: { ...base, units: [unit('u1'), unit('u2')] },
      respond: { 'review:u1': CLEAN, review: FOUND, verify: verifier(1) },
      terminal: 'inventory written (the clean unit never reached verify)',
    },
    {
      // A dead reviewer resolves to null, which reads as ZERO findings (review.mjs:358): no verifier, no
      // marker, the run carries on and the unit is left for a resume (:378-382). That is the SAME path a
      // genuinely clean unit takes, so both lanes here share one edge and one terminal — merging into the
      // clean path is what the engine really does, and pretending otherwise would draw a branch it lacks.
      name: 'a dead reviewer beside a clean one',
      when: 'a reviewer dies (its unit reads as clean, unmarked)',
      args: { ...base, units: [unit('u1'), unit('u2')] },
      respond: { 'review:u1': null, review: CLEAN },
      terminal: 'no inventory (every unit read clean)',
    },
    {
      // 2 units x 2 lenses = 4 calls in ONE pipeline stage (review.mjs:346-370 loops lenses INSIDE the
      // stage): two CONCURRENT lanes, each running its lenses SEQUENTIALLY. Expected rendering is one
      // `review` node annotated concurrent, plus a SELF-LOOP for the next lens — and no review → review
      // edge attributable to the differing unit id, which `group.item` is what rules out.
      name: 'two lenses per unit',
      when: 'each unit is swept once per lens',
      args: { ...base, units: [unit('u1', { lens: LENSES }), unit('u2', { lens: LENSES })] },
      respond: { review: FOUND, verify: verifier(2) },
      terminal: 'inventory written (both lenses merged behind one verifier)',
    },

    // ---- the four throw sites, in the order the engine checks them -------------------------------
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no target repo', when: 'args.target.repo is missing', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'no units', when: 'args.units is empty', args: { ...base, units: [] } },
  ],
};
