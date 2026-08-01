// Flow-map scenarios for brainstorm-cycle — the CONCURRENT FAN-OUT shape.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs brainstorm`; `--check` fails the gate while FLOW.md is stale.
//
// The engine returns no `status` at all, so BOTH non-throwing exits need a declared `terminal` —
// "variations produced" and "every generator failed" are genuinely different outcomes and would
// otherwise collapse into one blank end node.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  brief: 'Design a landing page for a developer tool',
  lenses: ['minimalist', 'bold editorial', 'playful'],
};

const GEN = { entry: 'index.md', summary: 'one line', files: ['index.md'] };

export default {
  engine: 'workflows/brainstorm/brainstorm-cycle.mjs',
  out: 'workflows/brainstorm/FLOW.md',
  title: 'brainstorm-cycle',
  scenarios: [
    {
      name: 'three lenses',
      when: 'every generator returns a variation',
      args: base,
      respond: { generate: GEN },
      terminal: 'variations produced',
    },
    {
      // A dead agent inside parallel() resolves to null rather than throwing; the lens lands in `failed`
      // and the run still returns its other variations.
      name: 'one generator dies',
      when: 'one lens produces nothing',
      args: base,
      respond: { 'generate:playful': null, generate: GEN },
      terminal: 'variations produced',
    },
    {
      name: 'every generator dies',
      when: 'no lens produced anything',
      args: base,
      respond: { generate: null },
      terminal: 'nothing produced (every generator failed)',
    },

    // ---- the six throw sites, in the order the engine checks them -----------------------------
    // The guard on the parse itself. `args` reaches an engine verbatim from the Workflow tool, so a
    // hand-built payload with a missing `}` arrives as an unparseable STRING rather than an object.
    { name: 'malformed args JSON', when: 'args is a string that is not valid JSON', args: '{broken' },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no brief', when: 'neither brief nor planPath', args: { runId: 'flow', root: 'E:/flow', lenses: ['a'] } },
    { name: 'no lenses', when: 'args.lenses is empty', args: { runId: 'flow', root: 'E:/flow', brief: 'b' } },
    {
      name: 'colliding lens ids',
      when: 'two lenses slug to one folder',
      args: { runId: 'flow', root: 'E:/flow', brief: 'b', lenses: ['Fast path', 'fast-path'] },
    },
  ],
};
