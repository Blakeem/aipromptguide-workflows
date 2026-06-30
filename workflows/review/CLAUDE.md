# review-cycle — operator guide (for Claude)

This repo is a **two-phase Claude Code Workflow** (`review-cycle.mjs` + `gen-manifest.mjs`) built to
the rules in `../../principles/WORKFLOW-PRINCIPLES.md`, the same as its siblings `feature-cycle` and
`upgrade-cycle`. Phase `review` fans out over bounded units READ-ONLY and writes one
verbatim **issue file per unit** (the inventory + the user's triage doc), then STOPS. Phase `resolve`
batches the approved issues and fixes each batch behind a two-stage review, staging accepted work.

**You are the conductor's setup + triage layer.** The engine reads NO files and spawns NO loader,
scribe, baseline, or organizer agent — *you* do that work with the user (principle #4): you run
`gen-manifest.mjs`, read it, pass the units in `args`; you present and triage the inventory; you grep
the approved issues into `args.issues`; you ensure a clean baseline; and you verify ground truth at
the end. Below is what is NOT obvious from the prompts inside the engine.

## How the engine is structured (so you can adapt, not rewrite)

- The engine is **general**. Everything project-specific arrives via `args`. Do not hardcode project
  specifics into the engine.
- It runs under the **Workflow tool runtime** — `agent()`, `pipeline()`, `phase()`, `log()`, `args`,
  `budget` are harness globals. You can NOT `node review-cycle.mjs` it. `gen-manifest.mjs` IS plain
  Node — run that directly.
- `meta` must stay a pure literal. Top-level `return`/`await` are legal (the harness wraps the body).
- Syntax-check trick (top-level return breaks `node --check`):
  `node -e "const s=require('fs').readFileSync('review-cycle.mjs','utf8').replace('export const meta','const meta'); new Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return (async()=>{'+s+'})()'); console.log('OK')"`
- `agentTypes` is empty by default on purpose — every role runs as the standard workflow subagent.
  Only pass an agentType that exists in the user's registry; an unknown type fails `agent()`.

## The roles (5 total, down from 13 in the old design)

**Review phase (read-only, units run CONCURRENTLY via `pipeline`):**
- **Reviewer** (sonnet) — finds production defects in ONE unit's files. Returns findings; writes nothing.
- **Verifier** (opus; sonnet when the unit is clean) — confirms each finding against the real code,
  corrects inflated severity, routes via the decision matrix, **and writes `runs/<runId>/issues/<unit>.md`**
  verbatim. That file is the inventory AND the triage doc. Every unit gets a file (clean ones get a
  "No issues found" marker with the unit hash), which is what makes hash-based resume work.

**Resolve phase (batches run SEQUENTIALLY — staging serializes):**
- **Fixer** (opus) — reads its batch's `issues/<unit>.md` file(s) verbatim, **verify-first** (vanished
  issues → STALE), fixes minimally, runs gates, leaves work UNSTAGED, owns the decision matrix, logs
  declines to `DISMISSED-<batch>.md`, escalates to `NEEDS-USER.md`. Only the fixer halts the run.
- **Blind quality reviewer** (sonnet) — reads ONLY the unstaged diff, no issue text. Catches anything
  the fix **introduced or broke** (this is the agent that catches "the fix solved the report but
  created a different problem"). Must be clean before acceptance runs.
- **Issue-aware acceptance verifier** (opus) — reads the batch's issue file(s), **re-derives each
  claimed fix's root cause** from current code, and passes only if the fix closes it *completely* (not
  just the literal edit) with no regression and green gates. Stages the batch on pass — the only agent
  that stages.
- **Rollback** (fixer role, failure-only) — if a batch can't pass within `maxRounds`, restores it to
  the staged baseline so the next batch starts from a clean diff; its issues become needs-attention.
- **Sweep** (sonnet, optional, after the last batch) — full gates, staged-diff spot-check, accounting.
  Writes `SWEEP.md`.

## The contracts that make it safe — keep them intact

- **Read-only phase 1.** Reviewer/verifier never touch source. Only the verifier writes, and only its
  own unit's file (a path it exclusively owns), so the fan-out is parallel-safe. There is no shared
  doc written during the concurrent phase — phase-1 "needs-your-decision" items live INSIDE each unit
  file (a shared `NEEDS-USER.md` written by concurrent verifiers would race). `NEEDS-USER.md` is only
  for phase-2 fixer escalations, where the fixer is sequential.
- **The inventory is CLOSED after phase 1.** Resolve never re-reviews; it only works the issues you
  approved. This is what makes medium-severity fixing converge — an open review loop finds a fresh
  batch of mediums every pass, forever. Don't reintroduce a re-review step into resolve.
- **Content travels verbatim via files.** The verifier writes the issue file; the fixer and acceptance
  read it byte-for-byte. The harness routes only paths, round numbers, and verdict booleans. There is
  no parse-and-rebuild and no `issues.json` — the per-unit markdown files ARE the inventory.
- **Two-stage escalating review (principle #5).** The blind reviewer is blind by instruction (no issue
  text, no inventory path); it catches confirmation-bias-proof regressions. The acceptance reviewer is
  issue-aware and re-derives root cause; it catches under-scoped fixes. Both must pass to stage; any
  code change re-enters at the blind stage. Reviewers read `DISMISSED-<batch>.md` + `NEEDS-USER.md` but
  NEVER prior review files (fresh, not amnesiac); a `CONTESTS DISMISSAL:` must be fixed-or-escalated.
- **Verify-first fixing.** The inventory is a snapshot; code may have moved. The fixer confirms each
  issue still exists before touching it and marks vanished ones STALE. Stale is normal, not a bug.
- **Staging = the batch boundary.** Staged index + HEAD = accepted baseline; unstaged tree = the
  current batch (the reviewers' scope). Fixer never stages (except `git add -N` for new files). The
  acceptance gate stages on pass. **Nothing is ever committed — the user commits.**
- **Failed batches roll back.** A batch that can't pass within `maxRounds` is restored to baseline so
  the next batch's diff is clean; its issues are marked needs-attention with the acceptance-review file
  as the retry context.
- **Severity floors.** `reviewSeverity` (default medium) keeps nitpicks out of the inventory; the
  engine also drops below-floor findings in JS. `criticSeverity` (default high) floors what the blind
  reviewer reports in a fix diff. Do not lower these "to be thorough" — that is the noise spiral.

## Running it — the playbook

1. **Manifest:** `node gen-manifest.mjs --repo <abs> --src src --out runs/<runId>/manifest.json`.
   Show the user the printed unit list. Tune `--cap-loc/--big-file` if units look lopsided.
2. **Read the manifest yourself** and pass its `units` array in `args` (the engine reads no files).
   Also pass `root` (THIS tool's directory — you know it from the Workflow result's scriptPath, so
   run-state lands here, gitignored, not in the target repo), `target.repo` (absolute), `gates`, and
   `conventions` (distill the project's CLAUDE.md into ~10 lines — it's the reviewer's rubric).
3. **Phase `review`.** It writes `runs/<runId>/issues/<unit>.md` per unit and returns counts + the
   hottest areas + `needsUserFiles`. Then PRESENT the inventory: read the issue files, walk the user
   through totals by severity/decision, the hot areas, and every NEEDS_USER item with its options +
   recommendation. This is a planning conversation — help them decide scope.
4. **Triage by EDITING the issue files** (`runs/<runId>/issues/*.md`) — they are the single source of
   truth:
   - skip an issue → set its `- decision:` line to `SKIP` (anything ≠ ACTIONABLE is skipped by resolve)
   - approve a NEEDS_USER with a chosen option → set `- decision: ACTIONABLE` and REWRITE its `**Fix:**`
     line to encode the user's chosen option precisely
   - a DEFER the user wants done anyway → ACTIONABLE only if genuinely batchable; large cross-cutting
     work belongs in the sibling upgrade-workflow as a goal, not in a batch here.
5. **Grep the approved issues into `args.issues`.** After triage, read the issue files and build the
   array of ACTIONABLE issues — each entry `{ id, unit, file, line, loc, severity, category, decision,
   effort, theme }` from the `- ` header lines. Pass that as `args.issues`. (The harness can't read
   files; this is the resolve-phase analog of the sibling main agent reading the plan to build the
   section list.)
6. **Clean baseline (your job, #4).** Before resolve, ensure the target repo's unstaged tree is clean:
   fold any pre-existing local changes into the staged baseline (`git add`), so each batch's unstaged
   diff is purely that batch's work. Gates must be GREEN before starting — resolve assumes a green
   baseline and will thrash otherwise.
7. **Phase `resolve`.** First run scoped: `"resolveOnly": ["src/oneArea/"]` (issue ids or path
   prefixes) to sanity-check cost and quality. Then the rest.
8. **Verify ground truth YOURSELF.** Run the full gates in the real environment, read
   `git diff --cached --stat`, spot-read the riskiest fixes, read `SWEEP.md`. The returned ledger is
   what agents reported; you confirm reality before telling the user it's done.
9. **Resume after any stop.** Review: re-run gen-manifest, then pass only the units whose
   `issues/<unit>.md` is missing or whose embedded `hash:` differs from the fresh manifest (Glob the
   issue dir, read the hash lines, diff against the manifest). Resolve: re-grep `issues/*.md` and pass
   the still-open issues — already-fixed issues are now staged; verify-first re-marks stale ones cheaply.

## Gotchas burned in from real runs

- **The review WILL re-phrase the same concern across passes.** Dedup is by `file:category`, not title
  — keep it that way or duplicates flood the inventory when `reviewPasses` > 1.
- **Reviewer severity is inflated.** That's why the verifier re-scores it; don't skip verify to save
  tokens — an unverified inventory wastes far more user-triage time than verify costs.
- **`git diff` omits brand-new files.** The engine handles it (`add -N`, reviewers read untracked);
  when YOU verify by hand, check `git status --porcelain` too.
- **The blind reviewer is blind by instruction, not placement.** The issue files sit in the same
  run-state dir, so the prompt explicitly forbids reading any inventory/issue file. If you ever change
  where issue files live, keep them off any path the blind reviewer is handed.
- **A needs-attention batch left the tree CLEAN** (it was rolled back). Read its
  `acceptance-review-<batch>-rN.md` to see what failed, and offer to retry those issues interactively
  with that context.
- **The issue files are the source of truth for WHAT to fix.** User triage edits them; the engine
  never mutates them after phase 1. The returned ledger is WHAT HAPPENED (in-memory, not a file) —
  don't "helpfully" write status back into the issue files.
- **Token budget:** the user can append a budget directive (e.g. "+2m") — the engine stops cleanly
  between batches under `minBatchBudget`. Resume continues where it left off.

## State files (under `runs/<runId>/`)

`manifest.json` (units; from gen-manifest, read by YOU) · `issues/<unit>.md` (per-unit inventory +
triage doc, written by the verifier — user-editable decisions) · `quality-review-<batch>-rN.md` (blind
review messages) · `acceptance-review-<batch>-rN.md` (issue-aware review messages) ·
`DISMISSED-<batch>.md` (fixer's declined-findings ledger) · `NEEDS-USER.md` (fixer escalations) ·
`SWEEP.md` (optional final accounting). All gitignored. There is no `issues.json`, no per-unit/per-issue
progress JSON, no `LEDGER.md`/`CHANGELOG.md` — git staging + these files are the whole trail.

## When you're done

Report: issues fixed / stale / needs-attention, the full-suite result (run it yourself), what's staged
(`git diff --cached --stat`), and any NEEDS-USER items. **Never commit** — tell the user what to review
and let them commit.
