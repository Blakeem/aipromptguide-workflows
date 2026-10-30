# Working on the engines — gotchas (for Claude)

**Who this is for.** This file is for *changing* the workflows. The root `CLAUDE.md` and each
`workflows/<x>/CLAUDE.md` are for *running* them inside someone's project. Development lore goes here, not
there.

Read it before you change an engine.

---

## 1. Fix it in EVERY engine, not the one you found it in

The engines are deliberately standalone copies (#11 does not apply across them — see §5), so a defect in one
is usually a defect in three. And the review workflow structurally *cannot* see this: each reviewer gets one
unit, so a sibling's copy of the same bug is invisible to it. Finding the twins is the **operator's** job at
triage.

**The families** — a fix in one member almost always belongs in the others:

- **Build loop:** `develop-cycle` alone. Its `feature`, `section` and `fix` modes share one loop
  (develop → blind quality → acceptance, park, staging, `DISMISSED-<id>.md`, `NEEDS-USER.md`). A defect in one
  mode's frame can still recur in the other two modes' frames in the same file.
- **Read-only fan-outs:** `debug/review` · `enhance-cycle`
  (finder → verifier, one output file per unit/lens, clean-marker written by the finder)
- **Lensed generative:** `brainstorm` · `decide` · `docs` · `enhance`
  (an id-keyed array fanned out to one file each)
- **Rubric review loops:** `decide` · `investigate` · `refine`
  (producer ⇄ adversarial critic against a fixed rubric, bounded by `maxRounds`, solo critical agents
  that **throw** on a null return rather than defaulting to a clean verdict). `refine` pairs a read-only
  critic with a minimal-fold editor under a fixed defect bar. Its dead critic throws, because zero gaps
  from a dead agent would read as convergence. `decide` stages its critic: the reviewer scores blind
  from an evidence ledger, and `tools/review-check.mjs` locks that judgment before it sees the decision.

`investigate` is the family's odd member: its candidates are *found* round by round rather than fanned
out once, so its loop state lives in a ledger (`DISQUALIFIED.md`) instead of an up-front id array. When
fixing a loop defect in `decide`, check whether investigate's round loop has the same shape — and note
that the reverse is often NOT true, since decide's two-variable `review`/`lastReviewFiles` split
is correct there only because it has an agree-gate investigate lacks.

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
- **The runtime cuts long log lines.** A log line over 11,024 chars keeps its first 5,000 and last 5,000
  chars around a `... [N characters truncated] ...` marker. Only a run's first 1,000 log lines are kept,
  and later lines drop with no marker. So a log line a tool parses back stays under 10,000 chars, and
  develop stops its progress lines at 900 to leave room for its status lines inside the first 1,000.
  A block whose status lines overrun that room halts the next block, and its lines past the cap survive
  only in the result's `statusSync`. The
  run record's `result` is never cut, and its `logs` hold only the engine's own lines (measured in
  2.1.287 to 2.1.289).

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
halt for one inside a loop (develop's round roles).

**Sentinel collisions.** Any `?? -1` / `?? 0` / `|| []` meaning "not applicable" must not be reachable by
a *missing* value. Check the null path separately, before the sentinel logic.

**Attestation theater.** A schema field the prompt demands and the harness never reads does nothing.
**TOP-LEVEL fields are gate-enforced:** `static.test.mjs` resolves every schema a `callAgent()` call is handed
— including the function-built one — and fails any top-level property with no `.field` / `['field']` /
destructured read **through that site's RECEIVER variable** (aliases via bare `x = recv;` assignments count,
transitively; a receiver name with more than one binding in the file is a loud extractor error — rename the
colliding local). Sites with no resolvable receiver (pipeline stages, `.then` chains, bare
`return callAgent(`) fall back to the old file-wide name-level match and are LISTED in the test file, so
degraded coverage is visible. NESTED item fields are still on you: they are excluded deliberately (measured —
an all-depth rule was 33 false positives out of 36) because a container is routinely consumed wholesale, so a
dead field one level down is invisible to the sweep.

**Write-confirmation asymmetry.** If one role's schema has `wrote_file` and its siblings don't, the ones
without can report success having written nothing. Make the set consistent.

**A relaunch's file is a file the agent has not read.** A relaunch with the same `runId` writes to
the paths the earlier launch used, and the Write tool refuses to overwrite a file the agent has not
read. An agent that ignores the refusal still returns `wrote_file: true`, and the next stage's agent
reads the earlier launch's text as the new round's. Every engine holds `REPLACE_NOTE` and
`WROTE_NOTE` once. `REPLACE_NOTE` sits at each site that replaces a file in full, and `WROTE_NOTE`
sits once in each prompt whose return attests a file the agent writes with the Write tool. One
return falls outside that rule and carries no `WROTE_NOTE`: docs' `files_cleaned`, an in-place Edit
count. develop's park carries one for its backlog entry, and its commit is attested by the
`commit_sha` it returns. Two replace sites add a guard after `REPLACE_NOTE`: the investigator's options files
and docs' gatherer capture files. Each engine's test counts both notes in each such
prompt through `pinWriteNotes`, so a new write site needs a row there.
In every engine but develop, `WROTE_NOTE` is followed by `FILE_WRITE_NOTE`, which tells the agent to
write file content with the file-editing tool, and `pinFileWriteNote` counts it in the same rows.
A row's fifth value gives its own count where a prompt embeds another agent's write site, as decide's
check-setup prompt embeds the reveal text.
Docs' scrubber carries `FILE_WRITE_NOTE` without `WROTE_NOTE`, so docs' test gives it its own row.

**Prose-sniffing for control flow.** `status = haltReason.includes('needs user') ? … : …` silently
reports the wrong thing the moment someone adds a halt reason. Set an explicit `haltKind` at every halt
site and map it.

**A flag derived from a halt-kind DEFAULT inherits a lie no sweep can see.** (Its first-order cousin —
a coerced numeric bound silently producing a zero-agent run — is gate-enforced now: `static.test.mjs`
runs every engine against garbage bounds and expects a throw, so it needs no manual vigilance.)
`haltKind` starts as `'rounds'`, so `determination: haltKind === 'rounds' ? FILE : ''` named a file
nothing wrote. Gate such a flag on `round > 0` — the proof an agent actually ran — the way decide's
`round ? decisionFile(round) : ''` already did.

**A pre-filter that drops candidates before the verifier makes the floor invisible.** enhance cut
below-floor candidates on the *finder's own unverified score*, logged the count, and dropped it — so a
`minImpact` set too high was indistinguishable from a clean system, and those candidates appeared in no
proposal file at all. If a knob silently removes work, its count belongs in the return (#8: a count is
control plane), or the operator cannot tell the knob from the verdict. enhance resolved it by removing
the cut: every finder candidate now reaches the verifier, which rejects a sub-floor one by name in its
lens file's `## Rejected` section.

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

- **Every terminal exit leaves a clean unstaged tree.** Accepted work is staged, or committed in commit
  mode. Unfinished work is *parked* (saved as a commit on the branch `aipg-unfinished/<backlog file id>`,
  then cleared, and linked by one backlog entry). This is load-bearing:
  it is what makes the round-1 clean-baseline precondition correct **on a resume**, not just a fresh
  run. Add a new exit path and it must either park or have changed nothing. The deliberate
  exceptions are a dirty or staged baseline (nothing was changed; that work is the operator's), a
  `relayed-request` halt (a park agent would read the same relayed message, so it runs no park),
  passed-but-unstaged (the work is good and one `git add` fixes it — parking would be worse), a commit-mode
  halt whose tree is dirty after the commit step, a `commit-unverified` or `acceptance-regression` halt that
  names the tree dirty check (a hook, the gate run or an unstaged block file may have left the change, so the
  operator inspects it before anything parks it), and a `park-unsafe` halt whose park did not confirm a clear.
- **Save strictly before clear.** If the commit cannot be made, leave the tree exactly as it is.
- **Never tell a user to restore a parked branch and then resume.** It makes the tree dirty and the
  round-1 precondition rejects it. The honest route is the park's backlog entry, whose fix block restores
  the branch after the clean-baseline check, so both reviewers judge the restored work. Never
  `git add -A` restored work, which promotes un-reviewed code into the accepted baseline
  where the blind reviewer cannot see it and every later regression check treats it as known-good.
- **Staging is the boundary, and only acceptance in commit mode commits to the work branch.** A park commits
  only to its `aipg-unfinished/` branch, in either mode. In stage mode the user commits. In commit mode
  acceptance commits each block it accepted, and the accepted baseline is HEAD.
- **The blind reviewer is blind by *placement*.** Run-state lives outside the target repo so it cannot
  reach the issue files, and the blind prompt's only run-state paths point into its own
  `runs/<runId>/gate/` (its review files + DISMISSED ledgers). Never hand it a path into
  `runs/<runId>/` outside `gate/` — NEEDS-USER, AMENDED, critiques and issue files all live there.
- **debug hunts defects only.** Its inventory feeds an autonomous fixer, and an improvement list never
  converges. Improvements are `enhance`, which deliberately has no fix-mode output.
- **The workflows serve any project and any user.** No rule, check or prompt sentence exists only to
  serve the maintainer's own setup, such as a personal writing style, user-level CLAUDE.md rules, skills
  or local paths. A user's own rules reach agents through that user's CLAUDE.md.
- **A fact lives in as few places as possible.** Keep it in at most one copy for users (a README) and
  one for agents (a CLAUDE.md or the prompt constant that renders it), and point every other place to
  one of those. A rule that two prompts share lives in one constant that both render, as
  `DOC_REGRESSION` and `SPEC_CASES` do in `develop-cycle.mjs`.

---

## 5. Not defects — don't spend review cycles here

- **Duplication between sibling engines.** Deliberate: each is standalone and copyable. Never extract a
  shared module or import across workflows. (#11 governs *facts*, not code across independent tools.)
  `role-map-copies.test.mjs` fails when an engine's `roleMap`, its `agentTypeMap` or its two value sets differ
  from develop's, so change all eight together. `convention-files-copies.test.mjs` fails when refine's or
  develop's `conventionFilesOf` differs from debug's, so change all three together. `notes.test.mjs` fails
  when an engine's exit-survey instruction differs from the test's copy, or when an engine calls `agent(`
  anywhere but inside its `callAgent`, so route every new call site through `callAgent` and change all eight
  instructions together. `relay-guard.test.mjs` fails when an engine's `RELAYED_REQUEST` line differs from
  develop's, so change all eight together.
- **WHY comments.** A one or two line comment stating a constraint the code cannot show is the house
  style. A long one, a history note or a restated guide is a #13 finding, not a defect: it belongs to an
  enhance conciseness pass, never to debug.
- **Missing JSDoc, "this function is long", naming preferences, formatting.**
- **No prompt-quality tests.** Not testable here by construction — see §6.

---

## 6. Testing

`node tests/run.mjs`. See [`README.md`](README.md) for the API; the short version:

- **A test file runs beside the others**, so it shares no resource with them. [`README.md`](README.md) lists
  the rules.
- **Guide prose wraps at 110 characters.** `static.test.mjs` fails on a longer prose line in the root
  `CLAUDE.md` and `README.md`, `tools/CLAUDE.md`, `tests/CLAUDE.md`, `workflows/*/CLAUDE.md`,
  `workflows/*/README.md` and `principles/*.md`. It exempts table rows, fenced code blocks and a line with
  one token that no wrap fits under the width, such as a URL. It does not check `docs/`,
  `tests/README.md` or `skills/`. `node tests/run.mjs static` runs that test file without the rest of the
  suite, so a guide edit runs it before the full suite.
- **Test failure paths.** The happy path is exercised constantly by real runs. Halts, parks, dead agents,
  contradictory returns and bad args are what rot silently — and are where every real defect has been.
- **`respond: { 'label': null }` simulates a dead agent** — one character, and it covers §3's number-one
  defect shape.
- **Verify a regression test fails against the old code** before trusting it. Run it against the old
  code with the recipe below and watch it go red. A green test that would never have caught the bug is
  worse than none. The rule covers assertions on new or changed behavior. An assertion that guards kept
  behavior passes on both versions and needs no red run. An assertion that reads a field the change adds
  or renames reads it defensively, such as `String(out.nextStep ?? '')`, so the old code fails that one
  assertion early and visibly instead of throwing and hiding every assertion after it. An absence
  assertion on new behavior, such as a new prompt that must not name some file, passes on the old code by
  construction. Prove it against a mutant that adds what it forbids.
- **The red-run recipe.** Export the code under test at its old version into a NEW, empty scratch folder
  outside the repo. `checkout-index` never overwrites a file that exists, so a reused folder holds stale
  code and the run passes silently. Export the staged version with
  `git -C <repo> checkout-index -a --prefix=<scratch>/`. It is the old code when the index holds earlier
  accepted work and your change is unstaged. Export the committed version with
  `git -C <repo> archive HEAD | tar -x -C <scratch>` only when your own change is staged. Copy the new
  test files over the export and run `node <scratch>/tests/run.mjs <filter>`. For an absence assertion,
  also copy the changed code files over the export and apply the mutant to those copies. Never swap
  files in the working tree for a red run.
- **Edit engine template text with the Edit tool or a script file written by the Write tool**, never
  through a Bash heredoc, as `FILE_WRITE_NOTE` in develop-cycle.mjs tells agents. The shell alters backslashes
  and backticks in a heredoc, so the exact-match replacement it feeds then finds nothing. The Edit tool edits
  only a file the Read tool has read, so a Bash `cat` does not unlock it.
- **A cross-engine sweep must RUN each engine, not grep it.** Grepping for the shape of a fix cannot tell
  you the fix is wired to the thing it must guard.
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
Edit an engine and you must regenerate, or the suite goes red:

```bash
node tools/gen-flows.mjs            # regenerate all
node tools/gen-flows.mjs develop    # just one
node tools/gen-flows.mjs --check    # what the gate runs; exit 1 lists the stale files
```

`tests/flow-coverage.test.mjs` is the part that earns its keep. Per engine it asserts that every
`agent()` role, every `throw new Error(` site and every `HALT_STATUS` value is reached by some scenario,
that the committed map is fresh, and that **`meta.phases` matches the phases agents really run under**.

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
and neither can be read — invisible to every text assertion.

```bash
node tools/render-flows.mjs            # lay every map out in real Mermaid, report overlapping labels
node tools/render-flows.mjs develop    # one
node tools/render-flows.mjs --png      # also write PNGs to tools/.cache/render/ (gitignored)
```

It drives the Chrome already on the machine with `--dump-dom` — no puppeteer, no playwright, still zero
npm dependencies. Mermaid itself is fetched once into `tools/.cache/`. **It is not wired into
`node tests/run.mjs`**, deliberately: it needs a browser and (once) the network, and the suite must stay
runnable anywhere. Run it by hand after changing anything that affects layout.

Layout knobs, all tuned against it — raise spacing before shortening text, because room is free and
dropped information is not:

- `NODE_SPACING` / `RANK_SPACING` in `gen-flows.mjs` (override via `FLOW_NODE_SPACING` / `FLOW_RANK_SPACING`
  to re-run the sweep). 60/90 left 8 of 9 maps colliding and 80/200 left 2, which the self-loop and edge
  markers below cleared.
- `WHEN_BUDGET` caps an edge label by length. It bounds the string Mermaid receives (before `esc()`) — the
  `· +N more` tail and the `(×N)` repeat count are charged against it, not added after. The budget decides
  **how many conditions to show**, never how many characters of the last one: a single over-budget condition
  is emitted whole, because a back edge is not a terminal and no table below carries its text, so truncating
  destroys the only copy.
- **Two edge kinds carry a reference instead of their text, and never collide as a result:** edges into a
  terminal are drawn **unlabelled** (one agent often fans out to six endings) with their conditions in the
  Terminal states table; **self-loops carry a marker** (`L1 ×4`) with their conditions in the **Loops**
  table. Both are indexed by the question a reader actually asks, both are complete rather than truncated
  to fit on an arrow, and both are **bounded by construction** — which is the property that matters, since
  it cannot regress when a diagram grows a node or a renderer retunes its layout.
  **That only works while the tables are actually populated.** Moving text off an arrow is only half the
  fix. Assert the destination, which `flow-coverage.test.mjs` does on the rendered row.
- **Node labels are NOT capped, and a cap is not the fix for a wide map.** Uncapping throw labels was measured
  with `render-flows.mjs`: **+24px on 3 of 9 maps, 6 unchanged**, because the widest box on these maps is a
  ~104-character *terminal* that nothing caps — the throw boxes were never the binding constraint. The clause
  cut in `firstClause` stays (messages run to 289 characters and continue into resume instructions); what
  survives it is emitted whole. If a map is genuinely too wide, raise the spacing constants or wrap with
  `<br/>`.
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

**Every map renders clean. Keep it that way by never putting authored text on a self-loop or on either edge of
a marked node pair.** Both shapes are markered now: self-loops carry `L<n>` (conditions in the Loops table),
the back edge of a boundary+back pair carries `E<n>` (conditions in the Edges table), and the boundary edge of
a marked pair renders caption-less — mermaid places both labels of a multi-edge pair at the same path midpoint
(measured 39×22px overlap at every one of six swept spacings, even with a 5-char marker), so a pair can carry
at most ONE label; the Edges table's fixed sentence carries the next-item advance instead.

`render-flows.mjs` pins the Mermaid version and keys its cache by it, since 11.16.0 moved self-loops into
a fixed-width side gutter and broke two maps that 11.15.0 rendered clean.

Measured and ruled out — do not re-run these sweeps: `RANK_SPACING` to 340 changes nothing (the gutter
does not scale with it); *shortening* a self-loop character budget makes it **worse** (relayout put a
third map into collision); `layout: elk` renders byte-identically to no config at all (ELK left mermaid
core in v11 and GitHub has not installed the separate package). **`defaultRenderer: "elk"` is a trap** —
it reports zero overlaps and is a false positive: not ELK at all, it reverts to the legacy self-loop path
and scores "clean" by dangling the label in whitespace at the tip of a long teardrop.

The markers are verified clean on both 11.4.1 (what GitHub was last observed serving) and 11.16.0 (the
strictest layout measured).

## 8. Before you call a change done

- [ ] Grepped the sibling engines for the same defect shape (§1) and fixed each in its own file
- [ ] `node tests/run.mjs` green, **and** a new case covering what you changed
- [ ] Any new agent return is guarded for `null` (§3)
- [ ] Any new exit path parks or changed nothing (§4)
- [ ] The workflow's `CLAUDE.md` updated — a new required arg, return field, written file, or halt
      condition is a documented behavior change; its `README.md` too if a human-visible behavior changed
- [ ] `meta` still a pure literal, still LF-only (the suite checks both)
- [ ] Prompt text changed? `node tools/gen-prompts.mjs` re-run, and its snapshot diff read for variants
      the change was not meant to reach. Read `tests/snapshots/<engine>.prompts.md` for every prompt that
      changed, as the agent that receives it reads it, since a constant's new sentence sits beside text
      the edit did not show
- [ ] Engine edited? `node tools/gen-flows.mjs` re-run and the updated `FLOW.md` committed (§7);
      a new agent, guard or terminal state needs a scenario in `tools/flows/<name>.flow.mjs` too
- [ ] Root `README.md` changelog updated if a user would notice
- [ ] Merged into `main`, the suite run here, and the worktree and its branch removed (§9)

## 9. Build in a worktree, and remove it when it merges

When this checkout drives runs in other projects, their agents and operators call `tools/` from it
mid-run: develop's `blockTool`, and `plan-edit.mjs args` between passes. Engines are copied at launch,
but an edit or branch switch in this working tree reaches a tool call already in flight. So build each
change in its own worktree off `main`, and point develop's `target.repo` at it:

```
node tools/wt.mjs open --repo <checkout> --name <name> --base main   # build, gate and commit in the path it prints
node tools/wt.mjs close --repo <checkout> --name <name> --into main --gate "node tests/run.mjs"
node tests/run.mjs                                                   # here, after the merge
```

`open` cuts `aipg/<name>` from `main`, whatever branch the checkout is on. Run `close` once the change is
committed, since finished worktrees left for later pile up in the checkout's `.claude/worktrees` folder, where
a tool that walks the checkout reads them. `close` rebases the branch onto `main` when `main` has a commit the
branch lacks, gates the exact commit `main` will point at, and fast-forwards `main` to it. Only then does it
move the worktree folder to the trash and delete the branch. It refuses a worktree with modified, staged or
untracked files, an unfinished operation or submodule git directories, a rebase that would drop a merge commit
of the branch, and a rebase or fast-forward that would delete an ignored file. Run the suite here after the
merge, since a worktree holds only tracked files (docs/worktree-batches.md, "untracked files"). A detached
snapshot worktree that a read-only run audits is removed when that run ends, since its findings name the
commit. Parallel chains use the batch verbs of `tools/wt.mjs`, whose `clean` verb moves the folder to the
trash, runs `git worktree prune` and keeps the branch.
