# review-cycle — operator guide (for Claude)

`review-cycle.mjs` + `gen-manifest.mjs`. Phase `review` fans out over bounded units READ-ONLY and writes
one verbatim **issue file per unit** (the inventory + the user's triage doc), then STOPS. Phase `resolve`
batches the approved issues and fixes each batch behind a two-stage review, staging accepted work. Built
to `../../principles/WORKFLOW-PRINCIPLES.md` (the `#N` markers below).

**You are the setup + triage layer (#4).** The engine reads NO files and spawns no loader/scribe/baseline
agent — you run `gen-manifest.mjs`, pass the units in `args`, present and triage the inventory, grep the
approved issues into `args.issues`, ensure a clean baseline, and verify ground truth at the end.

## Adapting the engine (not running it)

- It's **general** — everything project-specific arrives via `args`; don't hardcode specifics into it.
- Runs under the Workflow runtime (`agent()`/`pipeline()`/`phase()`/`args`/`budget` are harness globals)
  — you can NOT `node review-cycle.mjs`. `gen-manifest.mjs` IS plain Node — run it directly. `meta` stays
  a pure literal; top-level `return`/`await` are legal.
- Syntax-check (top-level return breaks `node --check`):
  `node -e "const s=require('fs').readFileSync('review-cycle.mjs','utf8').replace('export const meta','const meta'); new Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return (async()=>{'+s+'})()'); console.log('OK')"`

## Roles (5)

**Review phase (read-only, units run CONCURRENTLY via `pipeline`):**
- **Reviewer** (sonnet) — finds production defects in ONE unit's files; returns findings, writes nothing.
- **Verifier** (opus; sonnet when the unit is clean) — confirms each finding against the real code,
  corrects inflated severity, routes via the decision matrix, **writes `issues/<unit>.md`** verbatim
  (the inventory AND triage doc). Every unit gets a file (clean ones get a "No issues found" marker +
  unit hash — this is what makes hash-based resume work).

**Resolve phase (batches run SEQUENTIALLY — staging serializes):**
- **Fixer** (opus) — reads its batch's `issues/<unit>.md` verbatim, **verify-first** (vanished → STALE),
  fixes minimally, runs gates, leaves work UNSTAGED, owns the matrix, declines → `DISMISSED-<batch>.md`,
  escalates → `NEEDS-USER.md`. Only the fixer halts the run.
- **Blind quality reviewer** (sonnet) — reads ONLY the unstaged diff, no issue text — catches anything
  the fix introduced or broke. Must be clean before acceptance.
- **Acceptance verifier** (opus) — reads the batch's issue file(s), **re-derives each fix's root cause**
  from current code, passes only if the fix closes it *completely* with no regression and green gates.
  Stages the batch on pass — the only agent that stages.
- **Rollback** (fixer role, failure-only) — a batch that can't pass within `maxRounds` is restored to the
  staged baseline so the next batch starts clean; its issues become needs-attention.
- **Sweep** (sonnet, optional, after the last batch) — full gates, staged-diff spot-check, accounting →
  `SWEEP.md`.

## Contracts (keep intact)

- **Read-only phase 1.** Only the verifier writes, only its own unit's file (parallel-safe). Phase-1
  needs-decision items live INSIDE each unit file (a shared file written by concurrent verifiers would
  race); `NEEDS-USER.md` is only for phase-2 fixer escalations (sequential).
- **The inventory is CLOSED after phase 1.** Resolve never re-reviews — it only works the issues you
  approved. This is what makes medium-severity fixing converge; don't add a re-review step into resolve.
- **Content verbatim via files.** The verifier writes the issue file; the fixer + acceptance read it
  byte-for-byte. No `issues.json` — the per-unit markdown files ARE the inventory.
- **Two-stage escalating review (#5).** The blind reviewer (no issue text/path) catches
  confirmation-bias-proof regressions; the acceptance reviewer (issue-aware, re-derives root cause)
  catches under-scoped fixes. Both must pass to stage; any code change re-enters at blind. Reviewers read
  `DISMISSED-<batch>.md` + `NEEDS-USER.md` but NEVER prior review files; a `CONTESTS DISMISSAL:` must be
  fixed or escalated.
- **Verify-first fixing.** The inventory is a snapshot; code may have moved. The fixer confirms each
  issue still exists before touching it and marks vanished ones STALE (normal, not a bug).
- **Staging = the batch boundary.** Staged + HEAD = accepted baseline; unstaged = the current batch (the
  reviewers' scope). The fixer never stages (except `git add -N` for new files); acceptance stages on
  pass. Nothing is ever committed.
- **Failed batches roll back** to baseline; their issues are marked needs-attention with the
  acceptance-review file as retry context.
- **Severity floors.** `reviewSeverity` (default medium) keeps nitpicks out of the inventory;
  `criticSeverity` (default high) floors the blind reviewer. Don't lower these — that's the noise spiral.

## Playbook

1. **Manifest:** `node gen-manifest.mjs --repo <abs> --src src --out runs/<runId>/manifest.json`. Show
   the user the printed unit list; tune `--cap-loc/--big-file` if units look lopsided.
2. **Read the manifest yourself** and pass its `units` array in `args`. Also pass `root` (THIS tool's
   directory — from the Workflow result's scriptPath — so run-state lands here, gitignored, not in the
   target repo), `target.repo` (absolute), `gates`, and `conventions` (the project's CLAUDE.md distilled
   to ~10 lines — the reviewer's rubric).
3. **Phase `review`** writes `issues/<unit>.md` per unit and returns counts + the hottest areas +
   `needsUserFiles`. Then PRESENT the inventory: read the issue files, walk the user through totals by
   severity/decision, the hot areas, and every NEEDS_USER item with its options + recommendation. This is
   a scoping conversation.
4. **Triage by EDITING the issue files** (`runs/<runId>/issues/*.md` — the single source of truth):
   - skip → set its `- decision:` line to `SKIP` (anything ≠ ACTIONABLE is skipped by resolve)
   - approve a NEEDS_USER with a chosen option → set `- decision: ACTIONABLE` and REWRITE its `**Fix:**`
     line to encode that option precisely
   - a DEFER the user still wants → ACTIONABLE only if genuinely batchable; large cross-cutting work
     belongs in the upgrade-workflow as a goal.
5. **Grep the approved issues into `args.issues`.** Read the issue files, build the array of ACTIONABLE
   issues — each `{ id, unit, file, line, loc, severity, category, decision, effort, theme }` from the
   `- ` header lines. (The harness can't read files — this is the resolve-phase analog of reading the
   plan to build the section list.)
6. **Clean baseline (#4).** Fold any pre-existing local changes into the staged baseline (`git add`) so
   each batch's unstaged diff is purely that batch's work. Gates must be GREEN before starting — resolve
   thrashes otherwise.
7. **Phase `resolve`.** First run scoped — `"resolveOnly": ["src/oneArea/"]` (issue ids or path
   prefixes) — to sanity-check cost and quality, then the rest.
8. **Verify ground truth yourself:** run the full gates for real, `git diff --cached --stat`, spot-read
   the riskiest fixes, read `SWEEP.md`.
9. **Resume.** Review: re-run gen-manifest, then pass only the units whose `issues/<unit>.md` is missing
   or whose embedded `hash:` differs from the fresh manifest (Glob the dir, read the hash lines, diff
   against the manifest). Resolve: re-grep `issues/*.md` and pass the still-open issues — fixed ones are
   now staged; verify-first re-marks stale ones cheaply.

## External inventory (skip phase `review`)

When findings come from somewhere other than the code review — live/manual testing, a bug bash, user
reports — resolve works unchanged: it has NO dependency on phase `review` beyond the issue files +
`args.issues`. You act as the verifier: hand-author `runs/<runId>/issues/<unit>.md` in the exact
verifier format (frontmatter + `### [<id>]` blocks with the `- ` header lines and a precise `**Fix:**`),
anchoring each behavior-level finding to `file:line` yourself, and record skipped findings with
`- decision: SKIP` so the triage is on file. Then playbook steps 5–8 as normal. Mind the floors: pass
`fixSeverity: "low"` if the inventory includes LOW polish items. Verify-first makes loose anchors safe —
the fixer re-confirms each issue against current code. (First used: `runs/live-test-fixes`, an inventory
from live MCP-tool testing.)

## Gotchas

- **The review re-phrases the same concern across passes.** Dedup is by `file:category`, not title —
  keep it that way or duplicates flood the inventory when `reviewPasses` > 1.
- **Reviewer severity is inflated** — that's why the verifier re-scores it; don't skip verify to save
  tokens (an unverified inventory wastes far more user-triage time than verify costs).
- **`git diff` omits new files** — when verifying by hand, check `git status --porcelain` too.
- **The blind reviewer is blind by instruction, not placement** (issue files share the run-state dir), so
  the prompt forbids reading any inventory/issue file. If you ever move issue files, keep them off any
  path the blind reviewer is handed.
- **A needs-attention batch left the tree CLEAN** (it was rolled back). Read its
  `acceptance-review-<batch>-rN.md` for what failed; offer to retry those issues with that context.
- **The issue files are the source of truth for WHAT to fix** — the engine never mutates them after
  phase 1. The returned ledger is WHAT HAPPENED (in-memory, not a file) — don't write status back into
  the issue files.
- **Token budget:** the user can append a directive (e.g. "+2m"); the engine stops cleanly between
  batches under `minBatchBudget`. Resume continues where it left off.

## State files (`runs/<runId>/`, gitignored)

`manifest.json` (units; from gen-manifest, read by YOU) · `issues/<unit>.md` (per-unit inventory + triage
doc, verifier-written, user-editable) · `quality-review-<batch>-rN.md` (blind) ·
`acceptance-review-<batch>-rN.md` (issue-aware) · `DISMISSED-<batch>.md` (fixer's declines) ·
`NEEDS-USER.md` (fixer escalations) · `SWEEP.md` (optional). No `issues.json`, no progress JSON, no
`LEDGER.md`/`CHANGELOG.md`.

Report when done: issues fixed / stale / needs-attention, the full-suite result (you ran it), what's
staged (`git diff --cached --stat`), any NEEDS-USER items. **Never commit** — tell the user to review and
commit.

## Args reference

Full schema + defaults: the Config block atop `review-cycle.mjs` (the canonical source). Pass `args`
inline; the bulky fields you build per the playbook (`units` from gen-manifest for `review`, `issues`
greped from the triaged files for `resolve`).
- **Required:** `runId` · `root` (THIS tool's directory) · `target.repo` (absolute) · `gates.build` +
  `gates.test` (shell commands; `test` must be GREEN before `resolve`) · `conventions` (the reviewer's
  rubric, ~10 lines) · plus `units` (`review`) / `issues` (`resolve`).
- **Optional tuning:** `phase` (`review`|`resolve`, default `review`) · `reviewSeverity` (inventory
  floor, default medium) · `fixSeverity` (resolve-fix floor, medium) · `criticSeverity` (floor for NEW
  defects the blind reviewer reports, high) · `reviewPasses` (independent passes per unit, 1) ·
  `batch.locCap` (3000) / `batch.maxIssues` (10) · `minBatchBudget` (stop cleanly between batches under a
  token target, 150000) · `resolveOnly` (ids/path prefixes for a scoped first run) · `finalSweep` (true)
  · `maxRounds` (2) · `gates.testSetup` · `target.lang`/`target.framework` (hints) · `models`/`agentTypes`
  · `stateDir`.
