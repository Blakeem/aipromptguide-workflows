# Working on the engines — gotchas (for Claude)

**Who this is for.** This file is for *changing* the workflows. The root `CLAUDE.md` and each
`workflows/<x>/CLAUDE.md` are for *running* them inside someone's project — they happen to be useful
reference when editing, but they are not where development lore belongs. It goes here.

Everything below was learned the expensive way. Read it before you change an engine.

---

## 1. Fix it in EVERY engine, not the one you found it in

**The single most productive habit in this repo.** The engines are deliberately standalone copies
(#11 does not apply across them — see §5), so a defect in one is usually a defect in three. And the
review workflow structurally *cannot* see this: each reviewer gets one unit, so a sibling's copy of the
same bug is invisible to it. Finding the twins is the **operator's** job at triage.

Real examples, all from one week:

| Defect | Found in | Actually in |
|---|---|---|
| `target.repo` documented Required, defaulted to `'.'` | migrate | feature, migrate, resolve, review (+ enhance) |
| `gates.build` unvalidated → `build-only` auto-passes | migrate | feature, migrate, resolve |
| `runOnly` ids never validated (a typo = silent no-op) | feature | feature, migrate |
| Acceptance stages on `pass` without reading `regression` | feature | feature, migrate |
| Park names a review file that was never written | migrate | migrate, feature |
| Lens/source id collision overwrites a sibling's file | brainstorm | brainstorm, decide, docs, enhance |
| Non-numeric `maxRounds` → NaN → zero-round run reported as a normal terminal state | investigate | investigate, decide, docs, feature, migrate, resolve |

**The families** — a fix in one member almost always belongs in the others:

- **Build loops:** `feature-cycle` · `migrate-cycle` · `debug/resolve-cycle`
  (develop → blind quality → acceptance, park, staging, `DISMISSED-<id>.md`, `NEEDS-USER.md`)
- **Read-only fan-outs:** `debug/review` · `enhance-cycle`
  (finder → verifier, one output file per unit/lens, clean-marker written by the finder)
- **Lensed generative:** `brainstorm` · `decide` · `docs` · `enhance`
  (an id-keyed array fanned out to one file each)
- **Non-blind review loops:** `decide` · `investigate`
  (producer ⇄ adversarial critic against a fixed rubric, bounded by `maxRounds`, solo critical agents
  that **throw** on a null return rather than defaulting to a clean verdict)

`investigate` is the family's odd member: its candidates are *found* round by round rather than fanned
out once, so its loop state lives in a ledger (`DISQUALIFIED.md`) instead of an up-front id array. When
fixing a loop defect in `decide`, check whether investigate's round loop has the same shape — and note
that the reverse is often NOT true, since decide's two-variable `reviewPath`/`lastReviewFile` split
(`decide-cycle.mjs:304-305`) is correct there only because it has an agree-gate investigate lacks.

**Do it by grep, not memory.** `grep -n "TARGET.repo" workflows/*/*.mjs` finds in seconds what a reviewer
cannot find at all. Then fix each in its own file with parallel wording — never by extracting a shared
module (§5).

---

## 2. The runtime contract — things that break silently

An engine is **not** an ordinary Node module. The harness executes the file body with
`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/`workflow` injected as globals.

- **`node --check` does not work on an engine** — top-level `return` is legal here and a syntax error
  there. Use the harness wrap (`tests/harness.mjs`, or `node tests/run.mjs`).
- **`meta` must be a PURE LITERAL.** No variables, no calls, no `${}`. The tool parses it statically;
  interpolation breaks discovery at launch, not at edit time.
- **`Date.now()`, `Math.random()`, argless `new Date()` THROW.** They would break resume. Pass timestamps
  in via `args`; vary by index instead of randomly.
- **LF only.** One CR byte and the Workflow tool rejects the file outright. `.gitattributes` enforces it
  and the suite checks it, but an editor can still reintroduce it.
- **`gen-units.mjs` is the exception** — ordinary Node with real imports, run directly. Judge it normally.
- **The harness is not an LLM.** No context window, no tools: it cannot read a file, run git, or shell
  out. "The harness should just read X" is never a valid fix — that work belongs to an agent, or to the
  main agent before the run (#4).

---

## 3. Recurring defect shapes — check these first

**A dead agent is the number one source of real bugs.** `agent()` inside `parallel()`/`pipeline()`
resolves to `null` when that agent dies. Every one of these launders a dead agent into a plausible value:

```js
const gaps = curate?.gaps ?? [];   if (!gaps.length) break;   // dead curator == "finished, no gaps"
const dirty = fix?.baseline_dirty_files ?? -1;                // -1 means "n/a"; null collapses into it
const verdicts = v?.verdicts || [];                           // dead verifier == "nothing to report"
```

Ask of every `?.` on an agent return: **does the failure case look identical to a success case?** If yes,
guard it. The house pattern is a `throw` for a solo critical agent (decide, docs curator) and an explicit
halt for one inside a loop (resolve's fixer).

**Sentinel collisions.** Any `?? -1` / `?? 0` / `|| []` meaning "not applicable" must not be reachable by
a *missing* value. Check the null path separately, before the sentinel logic.

**Attestation theater.** A schema field the prompt demands and the harness never reads does nothing.
`unstaged_confirmed` was `required`, instructed in bold, and read nowhere for months. Grep every schema
field for a consumer.

**Write-confirmation asymmetry.** If one role's schema has `wrote_file` and its siblings don't, the ones
without can report success having written nothing. Make the set consistent.

**Prose-sniffing for control flow.** `status = haltReason.includes('needs user') ? … : …` silently
reports the wrong thing the moment someone adds a halt reason. Set an explicit `haltKind` at every halt
site and map it. feature did this; migrate had to catch up.

**A coerced numeric bound turns a bad arg into a silent no-op run.** `Math.max(1, 'three')` is NaN, and so
is `Number('three')` — but `round < NaN` is **false on the first test**, so the loop body never runs. The
engine then returns a zero-agent run wearing an ordinary terminal state: a search that never happened,
reported as one that ran out of rounds. Every numeric arg that bounds a loop or arms a floor must
`Number.isFinite` and **throw**, never absorb (`static.test.mjs` sweeps every engine for this). Note the
second-order version: any flag derived from a halt-kind **default** inherits the lie. `haltKind` starts as
`'rounds'`, so `determination: haltKind === 'rounds' ? FILE : ''` named a file nothing wrote. Gate such a
flag on `round > 0` — the proof an agent actually ran — the way decide's `round ? decisionFile(round) : ''`
already did.

**A pre-filter that drops candidates before the verifier makes the floor invisible.** enhance cut
below-floor candidates on the *finder's own unverified score*, logged the count, and dropped it — so a
`minImpact` set too high was indistinguishable from a clean system, and those candidates appeared in no
proposal file at all. If a knob silently removes work, its count belongs in the return (#8: a count is
control plane), or the operator cannot tell the knob from the verdict.

**Documented-Required-but-defaulted.** `abs()` resolves a relative path against `ROOT`, and `ROOT` is the
*tool's* directory — so `TARGET.repo ?? '.'` silently means "operate on the workflow tool itself." For an
engine that runs `git checkout --` and deletes files, that is the destructive case. If a doc says
Required, the engine must throw.

**Self-contradictory agent returns.** `{pass: true, regression: true}` violates `pass`'s own schema
description. Decide deliberately whether each contradiction halts or is merely flagged — the test we
settled on is *does the harm compound?* A regression poisons the baseline every later unit is judged
against (halt); an unreachable feature does not (flag).

---

## 4. Invariants you must not break

- **Every terminal exit leaves a clean unstaged tree.** Accepted work is staged, unfinished work is
  *parked* (saved to `parked-<id>.patch`, then cleared). This is load-bearing: it is what makes the
  round-1 clean-baseline precondition correct **on a resume**, not just a fresh run. Add a new exit path
  and it must either park or have changed nothing. The two deliberate exceptions are a dirty baseline
  (nothing was changed; that work is the operator's) and passed-but-unstaged (the work is good and one
  `git add` fixes it — parking would be worse).
- **Save strictly before clear.** If the patch cannot be written, leave the tree exactly as it is.
- **Never tell a user to apply a parked patch and then resume.** It makes the tree dirty and the round-1
  precondition rejects it. The honest options are *resume clean and redo* or *apply and finish by hand* —
  and never `git add -A` the restored work, which promotes un-reviewed code into the accepted baseline
  where the blind reviewer cannot see it and every later regression check treats it as known-good.
- **Staging is the only boundary, and nothing is ever committed.** The user commits.
- **The blind reviewer is blind by *placement*.** Run-state lives outside the target repo so it cannot
  reach the issue files. Never hand it a path into `runs/`.
- **debug hunts defects only.** Its inventory feeds an autonomous fixer, and an improvement list never
  converges. Improvements are `enhance`, which deliberately has no resolve sibling.

---

## 5. Not defects — don't spend review cycles here

- **Duplication between sibling engines.** Deliberate: each is standalone and copyable. Never extract a
  shared module or import across workflows. (#11 governs *facts*, not code across independent tools.)
- **Long WHY comments.** The house style. Prose is terse; explanation is not.
- **Missing JSDoc, "this function is long", naming preferences, formatting.**
- **No prompt-quality tests.** Not testable here by construction — see §6.

---

## 6. Testing

`node tests/run.mjs`. See [`README.md`](README.md) for the API; the short version:

- **Test failure paths.** The happy path is exercised constantly by real runs. Halts, parks, dead agents,
  contradictory returns and bad args are what rot silently — and are where every real defect has been.
- **`respond: { 'label': null }` simulates a dead agent** — one character, and it covers §3's number-one
  defect shape.
- **Verify a regression test fails against the old code** before trusting it. Reintroduce the bug, watch
  it go red, put it back. A green test that would never have caught the bug is worse than none.
- **A cross-engine sweep must RUN each engine, not grep it.** The numeric-bound sweep started as a source
  grep for `Number.isFinite` and was a false gate: the pattern was satisfied by a *different* arg's
  validator in the same file, so an engine could reintroduce `Number(A.maxRounds)` on the arg that
  mattered and still pass — proven with a mutant that produced a zero-agent run. Grepping for the shape of
  a fix cannot tell you the fix is wired to the thing it must guard. Same trap as attestation theater, one
  level up.
- **Don't hand an unguarded loop a huge bound to prove a cap exists.** Probing `maxRounds: 1e21` against an
  engine that lost its cap does not fail the assertion — it runs until V8 dies, and a heap-exhaustion
  stack trace buries every other result. Probe just above the cap (`51`).
- **Prompt *correctness* is testable; prompt *quality* is not.** "Does this interpolate a path that
  exists" is a contract — assert it with `prompt(prefix)`. "Is this well written" is what the review
  loops are for.
- **The suite tests the ENGINE, never the AGENTS.** Green does not mean the workflows work; it means the
  control plane does.

---

## 7. Flow maps — the diagrams are a gate, not decoration

`workflows/<x>/FLOW.md` is **generated**: `tools/gen-flows.mjs` runs each engine through
`tests/harness.mjs` against a scenario table in `tools/flows/<name>.flow.mjs` and draws what it watched.
Change an engine's control flow and you must regenerate, or the suite goes red:

```bash
node tools/gen-flows.mjs            # regenerate all
node tools/gen-flows.mjs migrate    # just one
node tools/gen-flows.mjs --check    # what the gate runs; exit 1 lists the stale files
```

`tests/flow-coverage.test.mjs` is the part that earns its keep. Per engine it asserts that every
`agent()` role, every `throw new Error(` site and every `HALT_STATUS` value is reached by some scenario,
that the committed map is fresh, and that **`meta.phases` matches the phases agents really run under**.

Three things to know before you touch it:

- **Phases are read from each call's `opts.phase`, never from fired `phase()` calls.** `review.mjs` and
  `enhance-cycle` never call `phase()` at all, and `docs-cycle` calls it once against three declared
  phases — measuring the calls would report three engines as drifted and the "fix" would be deleting
  correct launch documentation.
- **Coverage cannot see a branch that adds no role, no throw and no new terminal.** A dead-agent path, a
  skipped stage, or a second route into an existing terminal is invisible to every assertion. The
  scenario tables carry comments saying which branches are load-bearing for exactly this reason — read
  them before deleting a scenario that looks redundant.
- **Add a scenario, don't loosen a check.** `allowUncovered` demands a reason and fails if the item turns
  out to be covered, so it cannot quietly become a dumping ground.
- **The maps are published, so they are dash-free.** `dedash` flattens em/en/horizontal-bar dashes to
  ASCII hyphens in the finished document, and a coverage assertion holds every map to it. Do **not** strip
  dashes from engine prose to satisfy it: a `HALT_STATUS` string is an engine return value that tests
  assert verbatim, and the normalization is presentation-only by design.

The tables are deliberately **parallel to** the `*.test.mjs` files rather than shared with them: the tests
optimize for failure paths, the maps for complete terminal coverage, and a test deleted as redundant
would otherwise blank a branch of the diagram.

### Is the diagram READABLE? — `tools/render-flows.mjs`

`gen-flows.mjs` proves a map is **correct**; it cannot tell you the picture is legible. Mermaid does no
collision avoidance on edge labels, so two long ones leaving the same node render on top of each other
and neither can be read — invisible to every text assertion, and for a while it was only caught by a
human squinting at screenshots.

```bash
node tools/render-flows.mjs            # lay every map out in real Mermaid, report overlapping labels
node tools/render-flows.mjs feature    # one
node tools/render-flows.mjs --png      # also write PNGs to tools/.cache/render/ (gitignored)
```

It drives the Chrome already on the machine with `--dump-dom` — no puppeteer, no playwright, still zero
npm dependencies. Mermaid itself is fetched once into `tools/.cache/`. **It is not wired into
`node tests/run.mjs`**, deliberately: it needs a browser and (once) the network, and the suite must stay
runnable anywhere. Run it by hand after changing anything that affects layout.

Layout knobs, all tuned against it — raise spacing before shortening text, because room is free and
dropped information is not:

- `NODE_SPACING` / `RANK_SPACING` in `gen-flows.mjs` (override via `FLOW_NODE_SPACING` /
  `FLOW_RANK_SPACING` to re-run the sweep). 60/90 left 8 of 9 maps colliding; 80/200 leaves 2.
- `WHEN_BUDGET` caps an edge label by length. It bounds the string Mermaid receives (before `esc()`) —
  the `· +N more` tail and the `(×N)` repeat count are charged against it, not added after. They used to
  be added after, so a 34-char budget could emit 50 characters. The budget decides **how many conditions
  to show**, never how many characters of the last one: a single over-budget condition is emitted whole,
  because a back edge is not a terminal and no table below carries its text, so truncating destroys the
  only copy.
- **Two edge kinds carry a reference instead of their text, and never collide as a result:** edges into a
  terminal are drawn **unlabelled** (one agent often fans out to six endings) with their conditions in the
  Terminal states table; **self-loops carry a marker** (`L1 ×4`) with their conditions in the **Loops**
  table. Both are indexed by the question a reader actually asks, both are complete rather than truncated
  to fit on an arrow, and both are **bounded by construction** — which is the property that matters, since
  it cannot regress when a diagram grows a node or a renderer retunes its layout.
  **That only works while the tables are actually populated.** `buildGraph` collected the terminals'
  conditions and the projection dropped the field, so for nine committed maps the "Reached when" column
  was blank: the conditions were on no arrow *and* in no table. Moving text off an arrow is only half the
  fix — assert the destination, which `flow-coverage.test.mjs` now does on the rendered row.
- **Node labels are NOT capped, and a cap is not the fix for a wide map.** Throw labels used to ellipsise
  at 52 characters, which shipped `throw: args must include at least { runId, root, target, s…` to a
  published page. Removing it was measured with `render-flows.mjs`: **+24px on 3 of 9 maps, 6 unchanged**,
  because the widest box on these maps is a ~104-character *terminal* that nothing caps — the throw boxes
  were never the binding constraint. The clause cut in `firstClause` stays (messages run to 289 characters
  and continue into resume instructions); what survives it is emitted whole. If a map is genuinely too
  wide, raise the spacing constants or wrap with `<br/>`.
- **`readThrows` returns TWO forms of each message, and they are not interchangeable.** `prefix` stops at
  the first `${` because it is the key a runtime message is matched against (`startsWith`) — it must stay
  a literal head. `template` is the whole message with values elided to `INTERP` (`...`), and it is what a
  LABEL is built from. Labelling off the key printed `throw: plan id(s) [` for a message that goes on to
  say what is wrong with them. A test that only checks "the label is part of the message" cannot tell the
  two apart, since the key is itself a prefix of the template — assert the rendered node.
- **A clause cut must know what it is cutting inside of.** `firstClause` treats three spans as atomic, and
  each was a shipped defect: **brackets** (` (` inside `{ runId, planPath | plan (markdown string) … }`
  cut to a dangling `| plan`), **double quotes** (`: ` inside `"## Plan: <id>"` ended a node mid-quote),
  and **the elided value** (`...` + a space reads as the `. ` sentence separator, cutting
  `args.runOnly ... matches no plan id` down to `args.runOnly ..`). Single quotes are deliberately NOT
  tracked — the messages are prose full of apostrophes, and one opener leaves the scan unbalanced for the
  rest of the message. Unbalanced input falls back to the depth-blind cut, never to the whole message.

**Solved — all 9 maps render clean. Keep it that way by never putting authored text in a self-loop
label.** The history is worth knowing, because the obvious fixes are all wrong:

Mermaid **11.16.0** changed self-loops to a single SVG path through two dummy nodes
(`layout-algorithms/dagre/index.js`, `getSelfLoopSide`: *"so loops are not always forced above the node"*),
tucking the loop into a fixed-width side gutter without ever feeding the label's width into layout.
Bisected: **11.4.1 / 11.8.0 / 11.12.0 / 11.15.0 clean; 11.16.0 broke two maps.** `render-flows.mjs` had
been fetching `mermaid@11`, a **floating** tag, so the gate's verdict changed when the CDN moved rather
than when the maps did. It is pinned now, cache keyed by version.

Measured and ruled out — do not re-run these sweeps: `RANK_SPACING` to 340 changes nothing (the gutter
does not scale with it); *shortening* a self-loop character budget makes it **worse** (relayout put a
third map into collision); `layout: elk` renders byte-identically to no config at all (ELK left mermaid
core in v11 and GitHub has not installed the separate package). **`defaultRenderer: "elk"` is a trap** —
it reports zero overlaps and is a false positive: not ELK at all, it reverts to the legacy self-loop path
and scores "clean" by dangling the label in whitespace at the tip of a long teardrop.

The fix was structural, not a constant: self-loops carry a marker and their conditions live in the Loops
table (above). Verified clean on **both** 11.4.1 (what GitHub was last observed serving) and 11.16.0 (the
strictest layout measured), which is the point — a bounded label cannot regress when a renderer retunes.
The Loops table also carries the **full** condition list, where the arrow had been truncating to `+N more`.

## 8. Before you call a change done

- [ ] Grepped the sibling engines for the same defect shape (§1) and fixed each in its own file
- [ ] `node tests/run.mjs` green, **and** a new case covering what you changed
- [ ] Any new agent return is guarded for `null` (§3)
- [ ] Any new exit path parks or changed nothing (§4)
- [ ] The workflow's `CLAUDE.md` updated — a new required arg, return field, written file, or halt
      condition is a documented behavior change; its `README.md` too if a human-visible behavior changed
- [ ] `meta` still a pure literal, still LF-only (the suite checks both)
- [ ] Control flow changed? `node tools/gen-flows.mjs` re-run and the updated `FLOW.md` committed (§7);
      a new agent, guard or terminal state needs a scenario in `tools/flows/<name>.flow.mjs` too
- [ ] Root `README.md` changelog updated if a user would notice
