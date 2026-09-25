# tools — repo development machinery (for Claude)

Plain Node, run directly, **zero dependencies**. These are NOT Workflow engines: they use real imports,
`node --check` works on them, and they are judged as ordinary code (`../tests/CLAUDE.md` §2).

Most of them build and verify this repo's own artifacts. **`plan-block.mjs` is the exception: it runs
DURING a workflow**, invoked by agents that develop-cycle and refine-cycle hand a command. Its argv
shape, its stdout bytes and its exit codes are a run-time contract two engines depend on — change them
and you change what a developer agent receives, so treat it as engine surface, not dev machinery.

| File | What it does |
|---|---|
| `plan-block.mjs` | Prints ONE `## Plan: <id>` block out of a multi-unit plan file, byte-exact, or `--list`s the file's control data. It reads the plan-bus metadata grammar. **Called by agents at run time** (see above). Keeps a multi-unit plan out of every agent's context and makes the block's end a parser's decision rather than an agent's. |
| `plan-edit.mjs` | Writes plan files, the only tool that does: `set` upserts one block or issue metadata line, `move` relocates an issue entry (a cut, never a copy), `sync` applies the `statusSync` edits a develop result returns. **Operator-invoked between runs**, never handed to a run-time agent. It is a separate file from `plan-block.mjs` because the run-time allowlist rule covers every subcommand of the file it names. Imports plan-block's exported grammar. |
| `wt.mjs` | The batch-worktree lifecycle (`init`/`prep`/`land`/`clean`) for running several engine runs in **parallel**, each in its own git worktree. **Operator-invoked around the runs** — no agent ever calls it, no engine knows it exists. Its header comment is the contract (hook bytes, lock liveness, exit codes — all measured decisions); the operator playbook is [`../docs/worktree-batches.md`](../docs/worktree-batches.md). |
| `gen-flows.mjs` | Generates `workflows/<x>/FLOW.md` — the Mermaid flow map of an engine's complete agent flow. Runs each engine through `tests/harness.mjs` against a scenario table and draws what it **watched**, so a diagram can only ever show a path that really executes. |
| `render-flows.mjs` | Lays every generated map out in **real Mermaid** (headless Chrome) and reports labels that overlap. Answers "is the picture legible", which `gen-flows.mjs` cannot. |
| `flows/<name>.flow.mjs` | One scenario table per engine: the args + scripted agent replies that drive each distinct path. The only hand-written part of a flow map. |
| `.cache/` | Gitignored. Downloaded Mermaid + rendered PNGs. Safe to delete. |

`workflows/debug/gen-units.mjs` is the same *kind* of thing but lives with debug, because you run it as
part of that workflow rather than to maintain this repo.

## plan-block.mjs

```bash
node tools/plan-block.mjs <plan.md|plan-name> <id>            # that block, verbatim, on stdout
node tools/plan-block.mjs <plan.md|plan-name> --list          # { goal, ordered, suite, sweep, blocks: [...] }
```

It parses the plan-bus metadata grammar: file keys (`goal`, `ordered`, `suite`,
`sweep`), a block preamble (`mode`, `gate`, `status`, plus informational
`test_selector`/`depends_on`), and `### [<id>]` issue entries in fix-mode blocks. `--list` emits the
file keys plus a `blocks` array of `{ id, title, mode, gate, status }`, defaults applied. Each
metadata run is the contiguous `key: value` lines under its heading, leading blank lines crossed. A
blank line above a run is crossed to find it, never to continue one, and body prose never registers
as metadata. Every block's gate is its preamble `gate:` line. A bare plan-name resolves
against `<CLAUDE_CONFIG_DIR | ~/.claude>/plans/`.

**Every failure is loud** — unknown id, duplicate id (across the block AND issue namespaces), empty
body, missing or invalid gate, a gate outside its mode's set, an unknown or illegal metadata key or
value, an indented
header, a **malformed** header (colon forgotten, a colon with no id, a space before the colon, or a `###`
level), an **unclosed code fence**, no blocks at all. Nothing may resolve to a plausible default, because
the consumer is an agent that would build against it. Two silent-wrong-answer classes are guarded and
have tests: a header inside a **fenced code block** is an example (it used to mint a phantom unit and
truncate the real one), and the gate is read only from the **block preamble** (a `gate:` in
prose used to outrank the real one and yield `build-only`, which makes the engine accept a feature with
nothing tested).
The last two loud failures share one shape: a block that merges into its predecessor deletes a unit from
the control array AND flips the survivor's gate to the merged tail's, in one exit-0 answer.

The engines cannot verify the command ran — the harness has no tools. `plan_obtained` on develop's developer
and acceptance schemas is that signal, and develop halts on an explicit `false`. The refine editor's
`plan_parses` is the same signal for its re-validation run, and refine halts on `false`.

## plan-edit.mjs

```bash
node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>          # upsert one metadata line
node tools/plan-edit.mjs move <src> <issue-id> <dest> <block-id>             # relocate one issue entry
node tools/plan-edit.mjs sync <result.json>                                  # apply develop's statusSync edits
```

The write surface, kept out of plan-block.mjs on purpose: the run-time allowlist rule
(`Bash(node '<blockTool>':*)`) covers every subcommand of the file it names, and an agent must never
hold a write path to a plan. `set` addresses a block or an issue through the file's single id space
and rewrites exactly one line, or appends it to the right run. `move` cuts an entry's bytes verbatim
into another fix-mode block, same file or another. Failures are loud and leave every file untouched:
unknown id, unrecognized key, illegal value, a gate the target's mode forbids, a duplicate id at the
destination, a non-fix destination block. Paths resolve through the same `resolveRoadmap` as
plan-block, so a bare name addresses the same file in both tools. BOM'd and CRLF files round-trip
byte-identically, and an appended line inherits the file's dominant line ending. `sync` reads the result
develop returned and applies its `statusSync` edits.

## gen-flows.mjs

```bash
node tools/gen-flows.mjs              # regenerate every map
node tools/gen-flows.mjs develop      # one
node tools/gen-flows.mjs --check      # write nothing; exit 1 naming stale files (what the suite runs)
node tools/gen-flows.mjs develop --json   # the intermediate graph, for rendering elsewhere
```

**Its header comment is the contract** — spec shape, terminal identity, and every graph-derivation rule.
Read it before writing or changing a scenario table. The short version: node identity, concurrency,
loops, loop bounds and unit boundaries are all *derived* from a trace; only each scenario's `when` string
is authored.

Output is byte-stable (no timestamps), so `--check` is a meaningful gate. Change an engine's control flow
and you must regenerate, or `node tests/run.mjs` goes red.

It is also **dash-free**: `dedash` flattens the finished document to ASCII hyphens (em, en and horizontal
bar) because the maps are published on a user-facing site. Presentation only, applied once at the end of
`generate()` — engine prose, `--json` and terminal identity keep the real characters, and the substitution
is 1:1 so no label changes width. Write your prose however you like; only the emitted page is normalized.
`tests/flow-coverage.test.mjs` asserts it over every spec.

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
