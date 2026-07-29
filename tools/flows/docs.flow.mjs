// Flow-map scenarios for docs-cycle — a PER-SOURCE PIPELINE (gather → scrub) under a bounded gap loop.
// Contract + every derivation rule: the header of ../gen-flows.mjs. Regenerate with
// `node tools/gen-flows.mjs docs`; `--check` fails the gate while FLOW.md is stale.
//
// The engine returns NO `status` field at all, so every non-throwing scenario needs a declared
// `terminal`: its outcomes differ only in `rounds`/`unresolvedGaps`, never in a status string, and
// without a label they collapse into one blank end node.
//
// Coverage aimed at here: both exits of the gap loop (curated clean vs. a gap surviving the round
// budget), and the two survivable per-source branches the coverage assertions CANNOT force — a dead
// gatherer (scrubbed anyway: what it wrote is already on disk) and a zero-file source (scrub SKIPPED,
// the run continues). Neither throws and neither has its own terminal, so this table is the only thing
// holding them in the diagram. Plus each of the seven throw sites.

const base = {
  runId: 'flow',
  root: 'E:/flow',
  brief: 'Integrate the payments API v2: auth, webhooks, error codes.',
  sources: [
    { id: 'api-reference', kind: 'web', focus: 'the official payments API reference (v2)' },
    { id: 'release-notes', kind: 'web', focus: 'the v2 release notes and migration guide' },
  ],
};

const GATHER = { files_written: 6, skipped: 2 };
const SCRUB  = { files_cleaned: 4 };
const CURATE = {
  wrote_index: true, files: 11, deleted: 1, inconsistencies: 0,
  fidelity_checked: 3, fidelity_failures: 0, foreign_content: false, foreign_paths: [], gaps: [],
};
const CURATE_GAP = { ...CURATE, gaps: [{ kind: 'web', focus: 'webhook signature verification' }] };

const CURATED = 'curated set indexed (no gaps left)';

export default {
  engine: 'workflows/docs/docs-cycle.mjs',
  out: 'workflows/docs/FLOW.md',
  title: 'docs-cycle',
  scenarios: [
    // ---- the pipeline, and both exits of the gap loop --------------------------------------------
    {
      name: 'two sources, one round',
      when: 'every source captures files and the curator finds no gap',
      args: base,
      respond: { gather: GATHER, scrub: SCRUB, curate: CURATE },
      terminal: CURATED,
    },
    {
      // The curator's gap spawns a fresh gather → scrub for it, then round 2 comes back clean.
      // Keyed off the round in the label, not a counter: every scenario is run more than once.
      name: 'gap-fill round',
      when: 'the curator returns a gap the next round fills',
      args: base,
      respond: {
        gather: GATHER,
        scrub: SCRUB,
        curate: (label) => (/r1$/.test(label) ? CURATE_GAP : CURATE),
      },
      terminal: CURATED,
    },
    {
      name: 'gap survives the budget',
      when: 'a gap is still open at maxRounds',
      args: base,
      respond: { gather: GATHER, scrub: SCRUB, curate: CURATE_GAP },
      terminal: 'gap(s) left open at the round budget',
    },

    // ---- the two survivable per-source branches --------------------------------------------------
    {
      // A dead gatherer resolves to null inside pipeline() rather than throwing. The scrubber still
      // runs for it ON PURPOSE — files it wrote before dying are on disk and need cleaning.
      name: 'a gatherer dies',
      when: 'a gatherer dies mid-capture',
      args: base,
      respond: { 'gather:release-notes': null, gather: GATHER, scrub: SCRUB, curate: CURATE },
      terminal: CURATED,
    },
    {
      // Zero files REPORTED is the other half of that pair: the pipeline returns early and the
      // scrubber is skipped for that source while the run carries on with the other.
      name: 'a source captures nothing',
      when: 'one source reports zero files',
      args: base,
      respond: { 'gather:release-notes': { files_written: 0, skipped: 9 }, gather: GATHER, scrub: SCRUB, curate: CURATE },
      terminal: CURATED,
    },

    // ---- the seven throw sites -------------------------------------------------------------------
    {
      // Fires only when EVERY source is empty in round 1 — distinct from the single zero-file source above.
      name: 'every source empty',
      when: 'no source captured anything in round 1',
      args: base,
      respond: { gather: { files_written: 0, skipped: 4 } },
    },
    {
      name: 'dead curator',
      when: 'the curator dies',
      args: base,
      respond: { gather: GATHER, scrub: SCRUB, curate: null },
    },
    // One throw site serves every numeric bound. Without it a non-numeric maxRounds coerces to NaN and
    // the round loop never runs; a bad fidelitySample silently became 0, leaving the verbatim promise
    // asserted but never tested.
    { name: 'non-numeric bound', when: 'maxRounds is not a number', args: { ...base, maxRounds: 'three' } },
    { name: 'no runId', when: 'args carry no runId', args: {} },
    { name: 'no root', when: 'args.root is missing', args: { runId: 'flow' } },
    { name: 'no brief', when: 'neither brief nor planPath', args: { runId: 'flow', root: 'E:/flow' } },
    { name: 'no sources', when: 'args.sources is empty', args: { runId: 'flow', root: 'E:/flow', brief: 'b' } },
    { name: 'colliding source ids', when: 'two sources slug to one directory', args: { ...base, sources: ['Fast path', 'fast-path'] } },
  ],
};
