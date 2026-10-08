# debug workflows — operator guide (for Claude)

Two files here, and one engine elsewhere:
- **`gen-units.mjs`** — plain Node; slices the repo into bounded review units → `manifest.json`. Run it
  directly (it is NOT a Workflow engine).
- **`review.mjs`** — Workflow engine; a read-only fan-out that reviews every unit concurrently and writes
  one verbatim **issue file per unit** (the inventory + the user's triage doc), then **STOPS** for triage.
  Each issue file is a fix-mode plan file.
- **Fixing** is `../develop/develop-cycle.mjs` in fix mode. It builds the triaged issue files behind
  the same two-stage review every build gets (blind quality, then issue-aware acceptance) and stages
  accepted work. Its guide is `../develop/CLAUDE.md`.

Built to `../../principles/WORKFLOW-PRINCIPLES.md` (the `#N` markers below).

**Scope caveat.** Debug does NOT diagnose a live symptom (no repro/bisect). "X crashes" → YOU diagnose it
first (Bug Hunt & Repro), then feed the result in as an external inventory (see below). Debug FINDS
production defects across a codebase and/or FIXES a verified issue inventory — it does not hunt a reported
bug for you.

**DEFECTS ONLY — this is load-bearing, not a preference.** Something the system gets WRONG today. An
improvement, an efficiency idea, a new capability → the sibling **`enhance`** workflow. The prohibition is
unconditional (a lens narrows which defects matter; it never licenses proposing a better design) for two
reasons: this inventory feeds develop's autonomous fix mode, so an improvement list would be
auto-applied behind a two-round gate — the exact scope creep this workflow exists to prevent — and an
improvement list never converges, which the CLOSED-inventory contract depends on.

**You are the setup + triage layer (#4).** The engines read NO files and spawn no loader/scribe/baseline
agent — you run `gen-units.mjs`, pass the units in `args`, present and triage the inventory, hand the
triaged files to develop, and verify ground truth at the end.

## Adapting the engines (not running them)

- The engine is **general** — everything project-specific arrives via `args`; don't hardcode specifics.
- They run under the Workflow runtime (`agent()`/`pipeline()`/`phase()`/`args`/`budget` are harness
  globals) — you can NOT `node review.mjs`. `gen-units.mjs` IS plain Node —
  run it directly. `meta` stays a pure literal; top-level `return`/`await` are legal.
- Syntax-check the engine (top-level return breaks `node --check`) — pass the filename in `$f`:
  `for f in review.mjs; do node -e "const s=require('fs').readFileSync('$f','utf8').replace('export const meta','const meta'); new Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return (async()=>{'+s+'})()'); console.log('$f OK')"; done`

## Roles (2)

**`review.mjs` (read-only; units run CONCURRENTLY via `pipeline`):**
- **Reviewer** (opus) — finds production defects in ONE unit's files through ONE lens; returns findings.
  When it finds NOTHING it writes the clean `issues/<unit>.md` marker itself (frontmatter + "No issues
  found." + unit hash — what makes hash-based resume work); with findings it writes nothing and hands off
  to the verifier. With a lens ARRAY the unit gets one reviewer per lens, and only the LAST may write the
  marker (the unit is clean only if every lens found nothing).
- **Verifier** (opus) — spawned ONLY for units with findings; **ONE per unit regardless of lens count**.
  Confirms each against the real code, corrects inflated severity, folds duplicates (across lenses or within one), routes via
  the decision matrix, and **writes `issues/<unit>.md`** verbatim (the inventory AND triage doc). Clean
  units never reach it — the reviewer already wrote their marker.

Fixing roles (developer, blind quality, acceptance, park) are develop's, in `../develop/CLAUDE.md`.

## Contracts (keep intact)

- **`review.mjs` is read-only.** One writer per unit file — the reviewer writes it when the unit is
  clean, the verifier when it has findings; never both, only ever its own unit's file (parallel-safe).
  Review-phase needs-decision items live INSIDE each unit file (a shared file written by concurrent
  verifiers would race); `NEEDS-USER.md` is only for develop's fix-phase escalations (sequential).
- **The inventory is CLOSED after `review.mjs`.** develop's fix mode never re-reviews — it only works the
  issues you approved. This is what makes medium-severity fixing converge; don't add a re-review step
  into the fix loop.
- **The issue file is a plan-bus fix block.** The verifier writes each unit's inventory as a
  `## Plan: <slug(unit.id)>` block (preamble `mode: fix`, `gate: green`, `status: todo`) holding the
  `### [<id>]` entries, each with a `- status: open` line — so `issues/<unit>.md` parses under
  `tools/plan-block.mjs` and `develop-cycle` can build it directly. The clean marker keeps its old
  format (a clean unit is not a plan). Frontmatter (`unit:`/`hash:`/`reviewed:`) is unchanged, so
  gen-units' hash resume still joins.
- **The issue file is the contract between the engines.** `review.mjs` writes it. develop's fix
  developer and acceptance verifier read it through `tools/plan-block.mjs` and parse the `- ` header
  lines. No `issues.json` — the per-unit markdown files ARE the inventory.
- **The fix loop's contracts are develop's** (two-stage review, verify-first, staging as the block
  boundary, park-never-discard, the clean-tree preconditions). They are in `../develop/CLAUDE.md`.
- **A lens narrows WHICH defects, never widens into improvements.** `args.lens` (or per-unit `unit.lens`)
  aims the same machinery at a class of defect. "Report DEFECTS, not redesigns" and the verifier's
  `scope-creep → REJECT` are UNCONDITIONAL — see the scope caveat at the top. Improvements are `enhance`.
- **Severity floor.** `reviewSeverity` (default medium) keeps nitpicks out of the inventory. Don't lower
  it, since that starts the noise spiral. The reviewer and verifier grade on one written impact scale,
  `SEVERITY_SCALE` in `review.mjs`, and the size of the fix never lowers a grade.

## Lenses (optional — `review.mjs`)

Unset, the reviewer hunts production defects generally; every existing call is unaffected. Set `lens` to
aim it at a narrower class — a destructiveness audit, a data-loss sweep, a compliance pass, a
document/drawing review. Fields (all optional, each falls back to the defect-hunting default):
`{ id, mandate, criteria, categories, findingNoun, matters }` — `mandate` replaces the reviewer's one-line
charter, `criteria` its assessment list, `categories` the finding enum, and `findingNoun`/`matters` the
floor wording.

- **`args.lens`** sets the default for every unit; **`unit.lens`** REPLACES it for that unit (it does not
  merge — element-wise merging of arrays is unpredictable; per-field defaults still apply). An **empty
  array reads as unset** for `args.lens` and `unit.lens` alike — otherwise it would replace a real lens
  set with nothing and that unit would get zero reviewers while still counting as processed.
- **An ARRAY of lenses** reviews each unit once per lens and merges the results into that unit's SINGLE
  issue file behind ONE verifier. Use it to sweep the same code from genuinely different angles in one
  pass. The engine does not dedup, so two lenses may both report the same file+category — that's the
  point, and the verifier folds true duplicates.
- **Fan out by lens instead of file-slice** for a small codebase: pass the same files as N units with
  distinct ids and a different `unit.lens` each → one issue file per lens, reviewed concurrently.
- Agent ceiling per unit: one reviewer per lens + at most one verifier. It's logged at run start.

(`reviewPasses` is **gone**. It re-ran an identical prompt, so pass 2 re-hunted pass 1's ground at full
cost. Passing the same lens twice reproduces it exactly if you ever want that.)

## Playbook

1. **Units:** `node <path to gen-units.mjs> --repo <abs> --src src --out <root>/runs/<runId>/manifest.json`
   (`gen-units.mjs` sits beside this guide — `workflows/debug/` in a checkout, the path the skill
   resolves from the installed plugin; the `--out` base is `root`, never your cwd). `--unit-loc`
   (default 2000 ≈ ~215k tokens/agent — a right-sized review turn) is the one LOC bound: a file over it
   is its own unit, a directory's files split at it, and a bin-packing pass merges adjacent units up to
   it. `--no-pack` keeps per-directory units. `--cap-files` (default 24) caps files per unit only under
   `--no-pack`, since packing checks no file count. Show the user the printed unit list; tune
   `--unit-loc` if units look lopsided. `gen-units.mjs` skips symlinks and junctions, as git does, so
   code reached only through a link is in no unit.
2. **Read the manifest yourself** and pass its `units` array in `args`. Also pass `root` (this checkout
   — or, from the installed aipg plugin, the persistent data dir the skill resolves, never the
   version-swapped install dir — so run-state lands outside the target repo), `target.repo` (absolute),
   `gates`, and `conventions` (the project's CLAUDE.md distilled to ~10 lines — the reviewer's rubric).
3. **Run `review.mjs`** (`scriptPath` = its absolute path) from a notification turn (root `CLAUDE.md`,
   "Launch from a notification turn"). It writes `issues/<unit>.md` per unit and
   returns counts + the hottest areas + `needsUserFiles`. When the return's `failed` lists units to
   re-review (Args reference), resume them through step 4 (Resume the review) before step 5 (triage).
   Then PRESENT the inventory: read the issue files, walk the user through totals by severity/decision,
   the hot areas, and every NEEDS_USER item with its options + recommendation. This is a scoping
   conversation.
4. **Resume the review.** Re-run `gen-units.mjs` with `--issues-dir <root>/runs/<runId>/issues`, under
   the same runId. gen-units resolves the flag against your cwd, and run-state hangs off `root`. It
   joins each unit against its issue file's `hash:` frontmatter, tags them `new`/`changed`/`unchanged`,
   and emits `manifest.staleUnits`.
   - Pass `manifest.staleUnits` as `args.units`, plus every unit the last return's `failed` names for
     re-review that `staleUnits` lacks. A clean reviewer or a verifier that wrote its file and then did
     not attest it leaves the unit's real hash, so gen-units reads that unit `unchanged`.
   - Run the resume before any triage edit and before develop. A re-review rewrites each re-reviewed
     unit's issue file from scratch, and develop's fixes make every fixed unit read `changed`.
   - `staleUnits` carries gen-units ids and no `unit.lens`. If the run set `unit.lens`, re-attach each
     unit's lens before passing it. For a lens fan-out, pass your own lens units instead, each with its
     unit's current gen-units hash, and keep only those whose `issues/<fileSafe(id)>.md` is missing or
     whose `hash:` line differs from that hash, `incomplete` included.
5. **Triage by EDITING the issue files** (`runs/<runId>/issues/*.md` — the single source of truth):
   - skip → set its `- decision:` line to `SKIP` (anything ≠ ACTIONABLE is skipped by the fix loop)
   - approve a NEEDS_USER with a chosen option → set `- decision: ACTIONABLE` and REWRITE its `**Fix:**`
     line to encode that option precisely
   - a DEFER the user still wants → ACTIONABLE only if genuinely batchable. Large cross-cutting work
     belongs in its own plan file as `section` blocks.
   - regroup lopsided files with `node tools/plan-edit.mjs move <src> <issue-id> <dest> <block-id>`.
6. **Build the triaged files with develop.**
   - Each triaged issue file with findings is one fix-mode block.
     `node tools/plan-edit.mjs args <issueFile> [<issueFile> ...] --pack <target.repo>` prints one args
     object for all of them, with small blocks packed into shared passes. Clean-marker files are not
     plans, so leave them out. A file with no `- decision: ACTIONABLE` entry after triage is not a plan
     either: set its block `status: skip` (or leave it out). Start with one file, or `runOnly` naming
     one block, to sanity-check cost and quality.
   - Before launch, ask the user how to settle a dirty tree, under the rules in develop §4, and confirm
     the gates are green.
   - Then follow `../develop/CLAUDE.md` from §2 step 3.
   - After the run, add `git status --porcelain` and a spot-read of the riskiest fixes to develop §6's
     ground-truth checks.
   - When done, report the issues fixed, stale and needs-attention, the full-suite result you ran, what
     is staged (`git diff --cached --stat`), any NEEDS-USER items, and every parked block with its patch
     path and the user's options, and **never commit**: the user reviews and commits.

## External inventory (skip `review.mjs`)

When findings come from somewhere other than the code review — live/manual testing, a bug bash, user
reports, or a symptom YOU diagnosed first (Bug Hunt & Repro) — develop's fix mode works unchanged,
since it depends on `review.mjs` only through the issue files. You act as the verifier:
hand-author the inventory in the exact verifier format — the `## Plan: <id>` fix-block header with
its preamble, then `### [<id>]` blocks with the `- ` header lines (including `- status: open`) and a
precise `**Fix:**` — anchoring each behavior-level finding to `file:line` yourself, and record
skipped findings with `- decision: SKIP` so the triage is on file. Check it parses:
`node <plan-block.mjs> <file> --list`. Then playbook step 6 (Build the triaged files with develop).

`--list` rejects a todo fix block with no `### [<id>]` entry, so a file that uses another heading fails
the parse check above.

Only the `- decision:` line selects what gets fixed, so a LOW entry marked ACTIONABLE is fixed.
Verify-first makes loose anchors safe — the fixer re-confirms each issue against current code.
(First used: `runs/live-test-fixes`, an inventory from live MCP-tool testing.)

## Gotchas

- **The review re-phrases the same concern.** The engine does not dedup findings: a `file:category` key
  dropped distinct real defects from a closed inventory. Every finding reaches the verifier, and the
  verifier folds true duplicates.
- **Reviewer severity is inflated** — that's why the verifier re-scores it; don't skip verify to save
  tokens (an unverified inventory wastes far more user-triage time than verify costs).
- **`git diff` omits new files** — when verifying by hand, check `git status --porcelain` too.
- **The blind reviewer is blind by placement AND instruction.** Its prompt's only run-state paths point
  into `runs/<runId>/gate/`; the issue files live at the run-state root, off every path it is handed,
  and the prompt still forbids reading any inventory/issue file as defense-in-depth.
- **The issue files are the source of truth for WHAT to fix.** `review.mjs` writes them, and a
  `review.mjs` re-run rewrites each unit file it re-reviews from scratch, triage edits and statuses
  included. Otherwise only you write them, at triage and through `plan-edit.mjs args` before each develop
  launch. develop's verifier writes only its own `NEW-ISSUES-<block id>.md` files, never these.

## State files (`runs/<runId>/`, outside every repo)

`manifest.json` (units; from `gen-units.mjs`, read by YOU) · `issues/<unit>.md` (per-unit inventory +
triage doc, verifier-written, user-editable, a fix-mode plan file). The fix loop's files (reviews,
ledgers, parked patches) land in develop's state dir, listed in `../develop/CLAUDE.md`.

## Args reference

Full schema + defaults: the Config block atop `review.mjs` (the canonical source). Pass `args` inline,
with `units` from `gen-units.mjs`.

**`review.mjs`:**
- **Required:** `runId` · `root` · `target.repo` · `units` (from `gen-units.mjs`). `conventions` is
  strongly recommended, not enforced — omitted, the reviewer runs on a placeholder rubric; supply it.
  `gates` is informational context for the reviewer here. Missing `runId`, `root`, `target.repo` or
  `units` **throws** — `target.repo` has no default, so a bogus inventory can't be built against `.`.
- **Optional tuning:** `reviewSeverity` (inventory floor, default medium; a name outside
  low|medium|high|critical **throws**) · `lens` (one lens or an ARRAY —
  see Lenses; per-unit override via `unit.lens`).
- **Returns** `inventory` counts, `hottest` areas, `needsUserFiles`, and `failed`. `failed` holds every
  dead reviewer `{ unit, stage: 'review', lens }`, every clean unit whose reviewer did not attest its
  marker `{ unit, stage: 'review', marker: false }`, every verifier that did not attest its write
  `{ unit, stage: 'verify' }`, and every verifier whose verdicts miss or miscopy a finding id
  `{ unit, stage: 'verify', unmatched, unverdicted }`. `unitsReviewed` excludes units with a `failed`
  entry. Re-review those, except a unit whose entry carries `unmatched` and `unverdicted`. For that unit,
  `inventory` is incomplete, so triage from its issue file.
- **Throws** when two unit ids map to one issue file or one plan id, naming both.
