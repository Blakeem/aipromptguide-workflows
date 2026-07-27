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
(`decide-cycle.mjs:277-278`) is correct there only because it has an agree-gate investigate lacks.

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
- **Prompt *correctness* is testable; prompt *quality* is not.** "Does this interpolate a path that
  exists" is a contract — assert it with `prompt(prefix)`. "Is this well written" is what the review
  loops are for.
- **The suite tests the ENGINE, never the AGENTS.** Green does not mean the workflows work; it means the
  control plane does.

---

## 7. Before you call a change done

- [ ] Grepped the sibling engines for the same defect shape (§1) and fixed each in its own file
- [ ] `node tests/run.mjs` green, **and** a new case covering what you changed
- [ ] Any new agent return is guarded for `null` (§3)
- [ ] Any new exit path parks or changed nothing (§4)
- [ ] The workflow's `CLAUDE.md` updated — a new required arg, return field, written file, or halt
      condition is a documented behavior change; its `README.md` too if a human-visible behavior changed
- [ ] `meta` still a pure literal, still LF-only (the suite checks both)
- [ ] Root `README.md` changelog updated if a user would notice
