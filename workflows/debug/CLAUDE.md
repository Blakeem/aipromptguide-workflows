# debug workflows — operator guide (for Claude)

Three files:
- **`gen-units.mjs`** — plain Node; slices the repo into bounded review units → `manifest.json`. Run it
  directly (it is NOT a Workflow engine).
- **`review.mjs`** — Workflow engine; a read-only fan-out that reviews every unit concurrently and writes
  one verbatim **issue file per unit** (the inventory + the user's triage doc), then **STOPS** for triage.
- **`resolve-cycle.mjs`** — Workflow engine; a batched fix loop that fixes each batch behind a two-stage
  review (blind quality, then issue-aware acceptance), **staging** accepted work.

Built to `../../principles/WORKFLOW-PRINCIPLES.md` (the `#N` markers below).

**Scope caveat.** Debug does NOT diagnose a live symptom (no repro/bisect). "X crashes" → YOU diagnose it
first (Bug Hunt & Repro), then feed the result in as an external inventory (see below). Debug FINDS
production defects across a codebase and/or FIXES a verified issue inventory — it does not hunt a reported
bug for you.

**DEFECTS ONLY — this is load-bearing, not a preference.** Something the system gets WRONG today. An
improvement, an efficiency idea, a new capability → the sibling **`enhance`** workflow. The prohibition is
unconditional (a lens narrows which defects matter; it never licenses proposing a better design) for two
reasons: this inventory feeds `resolve-cycle`'s autonomous fixer, so an improvement list would be
auto-applied behind a two-round gate — the exact scope creep this workflow exists to prevent — and an
improvement list never converges, which the CLOSED-inventory contract depends on.

**You are the setup + triage layer (#4).** The engines read NO files and spawn no loader/scribe/baseline
agent — you run `gen-units.mjs`, pass the units in `args`, present and triage the inventory, hand the
approved issues to `resolve-cycle`, and verify ground truth at the end.

## Adapting the engines (not running them)

- Both engines are **general** — everything project-specific arrives via `args`; don't hardcode specifics.
- They run under the Workflow runtime (`agent()`/`pipeline()`/`phase()`/`args`/`budget` are harness
  globals) — you can NOT `node review.mjs` or `node resolve-cycle.mjs`. `gen-units.mjs` IS plain Node —
  run it directly. `meta` stays a pure literal; top-level `return`/`await` are legal.
- Syntax-check either engine (top-level return breaks `node --check`) — pass the filename in `$f`:
  `for f in review.mjs resolve-cycle.mjs; do node -e "const s=require('fs').readFileSync('$f','utf8').replace('export const meta','const meta'); new Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return (async()=>{'+s+'})()'); console.log('$f OK')"; done`

## Roles (5)

**`review.mjs` (read-only; units run CONCURRENTLY via `pipeline`):**
- **Reviewer** (opus) — finds production defects in ONE unit's files through ONE lens; returns findings.
  When it finds NOTHING it writes the clean `issues/<unit>.md` marker itself (frontmatter + "No issues
  found." + unit hash — what makes hash-based resume work); with findings it writes nothing and hands off
  to the verifier. With a lens ARRAY the unit gets one reviewer per lens, and only the LAST may write the
  marker (the unit is clean only if every lens found nothing).
- **Verifier** (opus) — spawned ONLY for units with findings; **ONE per unit regardless of lens count**.
  Confirms each against the real code, corrects inflated severity, folds cross-lens duplicates, routes via
  the decision matrix, and **writes `issues/<unit>.md`** verbatim (the inventory AND triage doc). Clean
  units never reach it — the reviewer already wrote their marker.

**`resolve-cycle.mjs` (batches run SEQUENTIALLY — staging serializes):**
- **Fixer** (opus) — reads its batch's `issues/<unit>.md` verbatim, **verify-first** (vanished → STALE),
  fixes minimally, runs gates, leaves work UNSTAGED, owns the matrix, declines → `DISMISSED-<batch>.md`,
  a verified defect in an issue's own **Fix:** instruction (6a) → fixed + recorded in
  `AMENDED-<batch>.md` (acceptance-only, pointer in `NEEDS-USER.md`),
  escalates → `NEEDS-USER.md`. Only the fixer halts the run for the user — Park halts too, but on an
  unsafe tree. On round 1 it also reports two preconditions before touching anything (see Contracts).
- **Blind quality reviewer** (opus) — reads ONLY the unstaged diff, no issue text — catches anything
  the fix introduced or broke. Must be clean before acceptance.
- **Acceptance verifier** (opus) — reads the batch's issue file(s), **re-derives each fix's root cause**
  from current code, passes only if the fix closes it *completely* with no regression and green gates.
  Stages the batch on pass — the only agent that stages.
- **Park** (fixer role, failure-only) — a batch that can't pass within `maxRounds` has its work **saved to
  `parked-<batch>.patch` and then cleared** from the tree, so the next batch starts clean *and* nothing is
  thrown away. Its issues become needs-attention; `NEEDS-USER.md` gets the diagnosis + restore command.

There is **no sweep**. Acceptance already runs the full gates on every accepted batch, park re-runs them
after clearing, and the accounting is the harness's own ledger — a `SWEEP.md` would restate numbers the
run already has, which is also what #6 forbids. (`migrate-cycle` keeps its sweep: that one re-greps the
change surface from the goal and finds coverage gaps no per-section agent could see.) The single check a
sweep did cover that the harness cannot — *did acceptance leave anything unstaged?* — is in `followups`.

## Contracts (keep intact)

- **`review.mjs` is read-only.** One writer per unit file — the reviewer writes it when the unit is
  clean, the verifier when it has findings; never both, only ever its own unit's file (parallel-safe).
  Review-phase needs-decision items live INSIDE each unit file (a shared file written by concurrent
  verifiers would race); `NEEDS-USER.md` is only for resolve-phase fixer escalations (sequential).
- **The inventory is CLOSED after `review.mjs`.** `resolve-cycle` never re-reviews — it only works the
  issues you approved. This is what makes medium-severity fixing converge; don't add a re-review step
  into resolve.
- **The issue file is the contract between the two engines.** `review.mjs` writes it; `resolve-cycle`'s
  fixer + acceptance read it byte-for-byte and parse the `- ` header lines. Both engines compute the same
  `runs/<runId>/issues/<unit>.md` path from `runId` + `root` (+ `stateDir` if overridden) — reuse the
  SAME values across both (see the `CONTRACT` comments in each engine); a mismatch silently points the
  fixer at missing issue files. No `issues.json` — the per-unit markdown files ARE the inventory.
- **Two-stage escalating review (#5).** The blind reviewer (no issue text/path) catches
  confirmation-bias-proof regressions; the acceptance reviewer (issue-aware, re-derives root cause)
  catches under-scoped fixes. Both must pass to stage; any code change re-enters at blind. Reviewers read
  `DISMISSED-<batch>.md` + `NEEDS-USER.md` but NEVER prior review files; a `CONTESTS DISMISSAL:` must be
  fixed or escalated.
- **Verify-first fixing.** The inventory is a snapshot; code may have moved. The fixer confirms each
  issue still exists before touching it and marks vanished ones STALE (normal, not a bug).
- **Staging = the batch boundary.** Staged + HEAD = accepted baseline; unstaged = the current batch (the
  reviewers' scope). The fixer never stages (except `git add -N` for new files); acceptance stages on
  pass. Nothing is ever committed. The fixer **attests** that with `unstaged_confirmed` every round —
  without it the run halts, because neither review layer looks at the staged index (the blind reviewer is
  told it's the accepted baseline; acceptance compares against it), so anything the fixer staged itself
  would reach the user's commit unseen.
- **Failed batches are PARKED, never discarded.** `git diff --binary > parked-<batch>.patch` (binary is
  required — a plain diff records "Binary files differ" and won't re-apply), untracked strays the patch
  can't carry are copied to `parked-<batch>-newfiles/`, THEN the tree is cleared and the gates re-run.
  Save always precedes clear; if the patch can't be written the tree is left exactly as it is and the run
  halts. `NEEDS-USER.md` gets the diagnosis, the patch path, and the verbatim
  `git apply --3way` restore command. The issues become needs-attention with that batch's
  acceptance-review file as retry context.
- **Every exit leaves a clean tree — that's what makes the precondition below unconditional.** Accepted
  work is staged, unfinished work is parked. A resume therefore starts from the same clean baseline a
  fresh run does. **One exception, and it halts:** Park reporting `saved=false` with a non-empty patch
  (the report contradicts itself), a tree it could not clear, or red gates after clearing. That is the
  one exit where the tree may be dirty, and it halts precisely so a human inspects before anything else
  touches the repo — `git status --porcelain` before the next batch or workflow.
- **Two round-1 preconditions, checked before the fixer touches anything.** `baseline_dirty_files` — the
  unstaged tree must be empty, because the unstaged diff IS the reviewers' scope and pre-existing changes
  would be attributed to the batch and fail it for someone else's edits. `issue_entries_found` — the fixer
  must locate at least one `### [<id>]` block for its batch; zero means `runId`/`root`/`stateDir` don't
  match what wrote the inventory, and without the guard every issue would be reported STALE and the run
  would end claiming false success. Either halts immediately, changing nothing — as does a round-1 fixer
  that returns nothing at all, since then neither precondition was checked and no work can be assumed.
- **A lens narrows WHICH defects, never widens into improvements.** `args.lens` (or per-unit `unit.lens`)
  aims the same machinery at a class of defect. "Report DEFECTS, not redesigns" and the verifier's
  `scope-creep → REJECT` are UNCONDITIONAL — see the scope caveat at the top. Improvements are `enhance`.
- **Severity floors.** `reviewSeverity` (default medium) keeps nitpicks out of the inventory;
  `criticSeverity` (default high) floors the blind reviewer. Don't lower these — that's the noise spiral.

## Lenses (optional — `review.mjs`)

Unset, the reviewer hunts production defects generally; every existing call is unaffected. Set `lens` to
aim it at a narrower class — a destructiveness audit, a data-loss sweep, a compliance pass, a
document/drawing review. Fields (all optional, each falls back to the defect-hunting default):
`{ id, mandate, criteria, categories, findingNoun, matters }` — `mandate` replaces the reviewer's one-line
charter, `categories` the finding enum, the rest the floor wording.

- **`args.lens`** sets the default for every unit; **`unit.lens`** REPLACES it for that unit (it does not
  merge — element-wise merging of arrays is unpredictable; per-field defaults still apply). An **empty
  array reads as unset** for `args.lens` and `unit.lens` alike — otherwise it would replace a real lens
  set with nothing and that unit would get zero reviewers while still counting as processed.
- **An ARRAY of lenses** reviews each unit once per lens and merges the results into that unit's SINGLE
  issue file behind ONE verifier. Use it to sweep the same code from genuinely different angles in one
  pass. Dedup is per-lens (`lens:file:category`), so two lenses may both report the same file+category —
  that's the point, and the verifier folds true duplicates.
- **Fan out by lens instead of file-slice** for a small codebase: pass the same files as N units with
  distinct ids and a different `unit.lens` each → one issue file per lens, reviewed concurrently.
- Agent ceiling per unit: one reviewer per lens + at most one verifier. It's logged at run start.

(`reviewPasses` is **gone**. It re-ran an identical prompt, so pass 2 re-hunted pass 1's ground at full
cost. Passing the same lens twice reproduces it exactly if you ever want that.)

## Playbook

1. **Units:** `node <path to gen-units.mjs> --repo <abs> --src src --out <root>/runs/<runId>/manifest.json`
   (`gen-units.mjs` sits beside this guide — `workflows/debug/` in a checkout, the path the skill
   resolves from the installed plugin; the `--out` base is `root`, never your cwd). A bin-packing
   pass merges adjacent units up to `--pack-loc` LOC (default 2000 ≈ ~215k tokens/agent — a right-sized
   review turn); base caps are `--cap-loc 2000 --cap-files 24 --big-file 2000`. Show the user the printed
   unit list; tune `--pack-loc` (0 disables packing) or `--cap-loc/--big-file` if units look lopsided.
2. **Read the manifest yourself** and pass its `units` array in `args`. Also pass `root` (this checkout
   — or, from the installed aipg plugin, the persistent data dir the skill resolves, never the
   version-swapped install dir — so run-state lands outside the target repo), `target.repo` (absolute),
   `gates`, and `conventions` (the project's CLAUDE.md distilled to ~10 lines — the reviewer's rubric).
3. **Run `review.mjs`** (`scriptPath` = its absolute path). It writes `issues/<unit>.md` per unit and
   returns counts + the hottest areas + `needsUserFiles`. Then PRESENT the inventory: read the issue
   files, walk the user through totals by severity/decision, the hot areas, and every NEEDS_USER item
   with its options + recommendation. This is a scoping conversation.
4. **Triage by EDITING the issue files** (`runs/<runId>/issues/*.md` — the single source of truth):
   - skip → set its `- decision:` line to `SKIP` (anything ≠ ACTIONABLE is skipped by resolve)
   - approve a NEEDS_USER with a chosen option → set `- decision: ACTIONABLE` and REWRITE its `**Fix:**`
     line to encode that option precisely
   - a DEFER the user still wants → ACTIONABLE only if genuinely batchable; large cross-cutting work
     belongs in the migrate workflow as a goal.
5. **Build `args.issues` from `review.mjs`'s returned `issues` array** — it is already in resolve's exact
   shape (`{ id, unit, file, line, loc, severity, category, decision, effort, title, theme }`). Apply your
   triage on top: drop what the user set to SKIP, flip approved NEEDS_USER items to ACTIONABLE (re-reading
   their rewritten `**Fix:**` lines). **Do not hand-rebuild it by grepping** — that's error-prone busywork
   (a hand rebuild is how a `file.py:224-276` range once became the number `224276`). Only an *external*
   inventory (no `review.mjs` run) needs the array built by hand.
6. **Clean baseline (#4).** Fold any pre-existing local changes into the staged baseline (`git add -A`) or
   stash them, so each batch's unstaged diff is purely that batch's work — the engine now halts on round 1
   if the tree is dirty. Ask the user which they want *before* starting. Gates must be GREEN — resolve
   thrashes otherwise.
7. **Run `resolve-cycle.mjs`** (its absolute path; **same `runId` + `root`** as `review.mjs`). First run scoped —
   `"resolveOnly": ["src/oneArea/"]` (issue ids or path prefixes) — to sanity-check cost and quality,
   then the rest.
8. **Verify ground truth yourself:** run the full gates for real, `git diff --cached --stat`, and
   `git status --porcelain` to confirm nothing was left unstaged (an acceptance verifier that missed a
   newly-created file is the one gap the engine can't see). Spot-read the riskiest fixes.
9. **Resume.** `review.mjs`: re-run `gen-units.mjs` with `--issues-dir runs/<runId>/issues` — it joins each
   unit against its issue file's `hash:` frontmatter, tags them `new`/`changed`/`unchanged`, and emits
   `manifest.staleUnits`. Pass that array as `args.units`. `resolve-cycle`: re-grep `issues/*.md` for the
   still-open issues — fixed ones are now staged, verify-first re-marks stale ones cheaply, and a parked
   batch's work is in its patch (the tree is clean).

## External inventory (skip `review.mjs`)

When findings come from somewhere other than the code review — live/manual testing, a bug bash, user
reports, or a symptom YOU diagnosed first (Bug Hunt & Repro) — `resolve-cycle` works unchanged: it has NO
dependency on `review.mjs` beyond the issue files + `args.issues`. You act as the verifier: hand-author
`runs/<runId>/issues/<unit>.md` in the exact verifier format (frontmatter + `### [<id>]` blocks with the
`- ` header lines and a precise `**Fix:**`), anchoring each behavior-level finding to `file:line`
yourself, and record skipped findings with `- decision: SKIP` so the triage is on file. Then playbook
steps 6–8 (build `args.issues` by hand here — there's no `review.mjs` return to start from).

**The `### [<id>]` heading is a contract, not a style choice.** The round-1 `issue_entries_found`
precondition counts those blocks; a file that uses some other heading reads as an empty inventory and
halts the run. The threshold is "at least one", never an exact match, so a hand-authored file with extra
or differently-numbered entries stays safe.

Mind the floors: pass `fixSeverity: "low"` if the inventory includes LOW polish items. Verify-first makes
loose anchors safe — the fixer re-confirms each issue against current code.
(First used: `runs/live-test-fixes`, an inventory from live MCP-tool testing.)

## Gotchas

- **The review re-phrases the same concern.** Dedup is by `lens:file:category`, not title — keep it that
  way, or one lens's findings would silently suppress another's on the same file.
- **Reviewer severity is inflated** — that's why the verifier re-scores it; don't skip verify to save
  tokens (an unverified inventory wastes far more user-triage time than verify costs).
- **`git diff` omits new files** — when verifying by hand, check `git status --porcelain` too.
- **The blind reviewer is blind by instruction, not placement** (issue files share the run-state dir), so
  the prompt forbids reading any inventory/issue file. If you ever move issue files, keep them off any
  path the blind reviewer is handed.
- **A parked batch left the tree CLEAN, and its work is NOT gone.** It's in
  `parked-<batch>.patch` (plus `parked-<batch>-newfiles/` when the batch created untracked files the
  patch couldn't carry — those need a second copy-back step after `git apply --3way`). Read the batch's
  `acceptance-review-<batch>-rN.md` for what failed, then offer the user the three real options: restore
  the patch and finish by hand, re-run resolve scoped to those ids after sharpening their `**Fix:**`
  lines, or drop the patch.
- **The issue files are the source of truth for WHAT to fix** — the engines never mutate them after
  `review.mjs`. The returned ledger is WHAT HAPPENED (in-memory, not a file) — don't write status back
  into the issue files.
- **Token budget:** the user can append a directive (e.g. "+2m"); `resolve-cycle` stops cleanly between
  batches under `minBatchBudget`. Resume continues where it left off.

## State files (`runs/<runId>/`, outside every repo)

`manifest.json` (units; from `gen-units.mjs`, read by YOU) · `issues/<unit>.md` (per-unit inventory +
triage doc, verifier-written, user-editable) · `quality-review-<batch>-rN.md` (blind) ·
`acceptance-review-<batch>-rN.md` (issue-aware) · `DISMISSED-<batch>.md` (fixer's declines) ·
`AMENDED-<batch>.md` (Fix instructions the fixer overrode as verified-defective; correct the issue
file if you agree) ·
`NEEDS-USER.md` (fixer escalations + every parked batch's diagnosis and restore command) ·
`parked-<batch>.patch` (a failed batch's saved work) · `parked-<batch>-newfiles/` (only when the batch
created untracked files the patch couldn't carry). No `issues.json`, no `SWEEP.md`, no progress JSON, no
`LEDGER.md`/`CHANGELOG.md`.

Report when done: issues fixed / stale / needs-attention, the full-suite result (you ran it), what's
staged (`git diff --cached --stat`), any NEEDS-USER items, and **every parked batch with its patch path
and what the user's options are**. **Never commit** — tell the user to review and commit.

## Args reference

Full schema + defaults: the Config block atop each engine (the canonical source). Pass `args` inline; the
bulky fields you build per the playbook (`units` from `gen-units.mjs` for `review.mjs`, `issues` grepped
from the triaged files for `resolve-cycle`). There is no `phase` arg — each engine is invoked by its own
`scriptPath`.

**Common (both engines):** `runId` · `root` (this checkout, or the plugin data dir the skill resolves)
— REUSE both across engines ·
`target.repo` (absolute) · `conventions` (the reviewer's/fixer's rubric, ~10 lines) · optional
`gates.testSetup` · `target.lang`/`target.framework` (hints) · `models`/`agentTypes` · `stateDir`.

**`review.mjs`:**
- **Required:** `runId` · `root` · `target.repo` · `units` (from `gen-units.mjs`). `conventions` is
  strongly recommended, not enforced — omitted, the reviewer runs on a placeholder rubric; supply it.
  `gates` is informational context for the reviewer here. Missing `runId`, `root`, `target.repo` or
  `units` **throws** — `target.repo` has no default, so a bogus inventory can't be built against `.`.
- **Optional tuning:** `reviewSeverity` (inventory floor, default medium) · `lens` (one lens or an ARRAY —
  see Lenses; per-unit override via `unit.lens`).
- **Returns** `issues` (the machine-built index in resolve's exact shape — start step 5 from this),
  `inventory` counts, `hottest` areas, and `needsUserFiles`.

**`resolve-cycle.mjs`:**
- **Required:** `runId` · `root` · `target.repo` · `gates.build` + `gates.test` (shell commands; `test`
  must be GREEN before resolve) · `issues` (review's returned array + your triage).
  Missing `runId`, `root`, `target.repo`, either gate, or `issues` **throws** — `target.repo` has no
  default (park's `git checkout --` and delete run against it) and an unset gate would silently no-op
  its half of the green check. `conventions` is strongly recommended, not enforced — omitted, the
  fixer runs on a placeholder rubric; supply it.
- **Optional tuning:** `fixSeverity` (resolve-fix floor, medium) · `criticSeverity` (floor for NEW
  defects the blind reviewer reports, high) · `batch.locCap` (3000) / `batch.maxIssues` (10) — both now
  **throw** below 1 or on a non-number (`0` used to be accepted and produced zero batches, i.e. a run
  reporting nothing to do) ·
  `minBatchBudget` (stop cleanly between batches under a token target, 150000) · `resolveOnly` (ids/path
  prefixes for a scoped first run) · `maxRounds` (2; **throws** unless it is a number in 1–50 — it used to
  coerce, and a NaN bound returned every batch as needs-attention without ever spawning a fixer).
  `minBatchBudget` throws on a non-number too, including `""`/`false`/`[]`, which all coerce to a legal
  `0` and would silently disable the floor.
- **Returns** `summary` counts, `parked` (each parked batch with its patch + strays paths and issue ids),
  the per-batch `ledger`, and `followups`.
