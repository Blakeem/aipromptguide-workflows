# tests

```bash
node tests/run.mjs              # everything
node tests/run.mjs migrate      # just files matching "migrate"
```

Exit 0 green, 1 red. No dependencies, no config, no network — the whole suite runs in about a second.

**This is also the gate.** When you run a workflow *against this repo*, point both gates at it:

```json
"gates": { "build": "node /abs/path/to/aipg/tests/run.mjs",
           "test":  "node /abs/path/to/aipg/tests/run.mjs" }
```

## How it works

An engine never runs its agents here. `tests/harness.mjs` loads the engine **as text**, rewrites
`export const meta` to a plain `const` so it stops being an ES module, and wraps the body in an async
function with the harness globals injected as parameters — the same shape the real runtime uses. Then it
passes an `agent()` that returns **scripted objects** instead of spawning a model.

That works because of principle #1: *the harness routes control signals and never interprets content*.
An engine's control plane is therefore a pure function of what its agents return. Script the returns and
you can drive the engine down any path you like — including ones a real run would take months to hit,
like an acceptance verifier reporting `pass: true` and `regression: true` in the same breath.

**What this proves:** the engine's logic — which agents it spawns, in what order, what it puts in their
prompts, what it does with their answers, when it halts, parks, stages, or throws.

**What it does not:** whether a prompt is any good, or whether a real model would obey it. It tests the
engine, never the agents. Prompt quality is what the review loops are for.

## Adding a case

Edit the matching `<engine>.test.mjs`, or drop in a new `*.test.mjs` — the runner finds it.

```js
import { runEngine, throwsWith, section, ok } from './harness.mjs';

section('a failed plan parks and the roadmap carries on');
const { out, labels } = await runEngine('workflows/feature/feature-cycle.mjs', {
  args: { runId: 't', root: 'E:/r', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' },
          planPath: 'plans/roadmap.md', plans: [{ id: 'plan-a' }, { id: 'plan-b' }] },
  respond: {
    'develop': { build_passed: true, test_outcome: 'passed', unstaged_confirmed: true },
    'accept plan-a': { pass: false },        // longest matching prefix wins
    'accept': { pass: true, staged: true },
    'park': { saved: true, cleared: true, gates_green: true, patch_bytes: 900 },
  },
});
ok(labels.includes('park:plan-a'), 'plan-a parked');
ok(labels.some((l) => l.includes('plan-b')), 'the roadmap continued');
```

`respond` keys are matched against the agent's **label** by prefix, longest first. A value can be a
function `(label, prompt, calls) => response` when the answer depends on the round. An unmatched label
returns `{}`; an explicit `null` simulates a **dead agent**, which is what `parallel()`/`pipeline()` hand
back on failure and is worth testing — several real defects lived exactly there.

`runEngine` returns `{ out, calls, logs, labels, prompt(prefix), byLabel(prefix) }`. Use `prompt()` to
assert what an agent was actually told, and `byLabel()` when you need a call's `.opts` (its schema, model,
or phase). `throwsWith()` returns the thrown message for arg-validation cases, or `''` if it did not
throw.

`runTrace()` takes the same arguments and **never throws** — reach for it when you want the whole path,
including one that dies halfway. On top of `runEngine`'s shape:

- `calls[i].seq` — 0-based call index.
- `calls[i].group` — `null` outside a fan-out, else `{ id, kind: 'parallel'|'pipeline', item, stage }`.
  Several calls may share one `(id, item, stage)` triple: `review.mjs` loops its lenses sequentially
  inside one stage. Compare `item` to tell a sequential repeat from concurrency.
- `phases` — `[{ title, beforeCall }]` from `phase()`; `beforeCall` is the `seq` the next call will take.
  **`[]` is a correct result** for `debug/review.mjs` and `enhance-cycle.mjs`: they carry the phase on
  each agent's `opts.phase` and never call `phase()`.
- `groups` — one entry per fan-out, `{ id, kind, items, stages }`.
- `terminal` — `{ kind: 'return'|'throw', status, message }`. On a throw `out` is `undefined` and
  `status` is `''`, but every call made **before** the throw is still in `calls`.

Four readers answer questions about an engine from its **source text**, no run needed, alongside
`ENGINES` (the nine engine paths):

- `readMeta(src)` — the evaluated `meta` object.
- `readRoles(src)` — the static label prefixes (an engine's roles) in source order, deduped;
  `feature-cycle` → `['plan-critic','develop','quality','acceptance','park']`.
- `readThrows(src)` — `[{ line, prefix }]` per `throw new Error(` site. A message that starts with an
  interpolation yields `prefix: ''` and is still returned — a dropped site would read as covered.
- `readHaltStatus(src)` — the evaluated `HALT_STATUS` map, or `{}` for an engine without one.

## What belongs here

Failure paths, mostly. The happy path is what a real run exercises constantly; the halt, park, dead-agent,
contradictory-return and bad-arg paths are the ones that rot silently. Write the case that would have
caught the bug, and comment **why** it matters when that is not obvious from the assertion.
