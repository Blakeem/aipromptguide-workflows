# tools — repo development machinery (for Claude)

Plain Node, run directly, **zero dependencies**. These are NOT Workflow engines: they use real imports,
`node --check` works on them, and they are judged as ordinary code (`../tests/CLAUDE.md` §2). Nothing here
runs during a workflow — they exist to build and verify this repo's own artifacts.

| File | What it does |
|---|---|
| `gen-flows.mjs` | Generates `workflows/<x>/FLOW.md` — the Mermaid flow map of an engine's complete agent flow. Runs each engine through `tests/harness.mjs` against a scenario table and draws what it **watched**, so a diagram can only ever show a path that really executes. |
| `render-flows.mjs` | Lays every generated map out in **real Mermaid** (headless Chrome) and reports labels that overlap. Answers "is the picture legible", which `gen-flows.mjs` cannot. |
| `flows/<name>.flow.mjs` | One scenario table per engine: the args + scripted agent replies that drive each distinct path. The only hand-written part of a flow map. |
| `.cache/` | Gitignored. Downloaded Mermaid + rendered PNGs. Safe to delete. |

`workflows/debug/gen-units.mjs` is the same *kind* of thing but lives with debug, because you run it as
part of that workflow rather than to maintain this repo.

## gen-flows.mjs

```bash
node tools/gen-flows.mjs              # regenerate every map
node tools/gen-flows.mjs migrate      # one
node tools/gen-flows.mjs --check      # write nothing; exit 1 naming stale files (what the suite runs)
node tools/gen-flows.mjs migrate --json   # the intermediate graph, for rendering elsewhere
```

**Its header comment is the contract** — spec shape, terminal identity, and every graph-derivation rule.
Read it before writing or changing a scenario table. The short version: node identity, concurrency,
loops, loop bounds and unit boundaries are all *derived* from a trace; only each scenario's `when` string
is authored.

Output is byte-stable (no timestamps), so `--check` is a meaningful gate. Change an engine's control flow
and you must regenerate, or `node tests/run.mjs` goes red.

## render-flows.mjs

```bash
node tools/render-flows.mjs           # measure all, report overlaps, exit 1 if any
node tools/render-flows.mjs --png     # also write PNGs to tools/.cache/render/
```

Drives the Chrome already on the machine via `--dump-dom` — no puppeteer, no playwright. Mermaid does no
collision avoidance on edge labels, and that failure is invisible to every text assertion, so this
measures the real bounding boxes instead of guessing.

**Deliberately not part of `node tests/run.mjs`**: it needs a browser and, once, the network, and the
suite has to stay runnable anywhere. Run it by hand after anything that affects layout. Raise the spacing
constants in `gen-flows.mjs` before shortening label text — room is free, dropped information is not.

## The two gates these feed

- `tests/flows.test.mjs` — the emitter's own rules (determinism, concurrency, loop counts, escaping).
- `tests/flow-coverage.test.mjs` — every role, throw site and terminal state reached by some scenario,
  `meta.phases` agreement, and map freshness.

Full working notes, including what the coverage gate structurally *cannot* see, are in
[`../tests/CLAUDE.md`](../tests/CLAUDE.md) §7.
