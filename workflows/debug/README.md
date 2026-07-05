# debug

An autonomous Claude Code workflow that hardens a codebase as a planned campaign: first it builds a
verified, effort-scored inventory of real production defects, then, after you triage it, it fixes the
approved issues in batches behind a two-stage review and stages the result. You commit. The fix loop also
accepts an **external inventory** — findings from live/manual testing, a bug bash, or a symptom you
diagnosed yourself — so you can skip the review pass and go straight to fixing.

The two stages are the point. You cannot prioritize issues or estimate the work until you have actually
reviewed, so `review.mjs` is read-only: it sweeps the codebase in bounded units (concurrently, so it is
fast), verifies every finding against the real code, scores each one, and writes one issue file per unit.
Then it stops. You read those files, answer anything flagged for your decision, drop what you disagree
with, and only then run `resolve-cycle.mjs`, which batches the approved issues by area, fixes them, has a
blind critic and an issue-aware verifier tear each batch apart, and stages each accepted batch.

Debug does **not** hunt a reported bug for you — there is no repro/bisect step. If you have a live symptom
("X crashes"), diagnose it first, then feed the result in as an external inventory (below).

### What sets it apart

This is a deliberately **lean** workflow. A default Claude workflow tends to spawn an agent for every
step; this one engineers those away and follows a strict set of principles:

- **No busy-work agents.** There is no loader, scribe, baseline, or organizer agent. Setup (the unit
  manifest, triage, a clean baseline) happens up front in the main session. No agent is spawned for a
  job the main session can already do.
- **The inventory travels verbatim.** Each unit's issue file is written once by the verifier and read
  byte-for-byte by the fixer and the acceptance gate. Nothing is parsed into fields and rebuilt, so
  nothing about a finding is lost or reinterpreted. There is no monolithic JSON inventory.
- **Two-stage review on every fix.** A blind critic judges the diff with no idea what issue it was
  meant to fix (so it catches a fix that solved the report but broke something else), then an
  issue-aware gate re-derives each defect's root cause and confirms it is fully closed with no
  regression.
- **The fix list is closed.** The fix loop only ever works the inventory you approved. No fresh
  review mid-fix keeps finding "just one more thing", which is what makes fixing medium issues
  converge instead of spiraling.
- **Staging is the boundary, never a commit.** Accepted batches are staged; a batch that cannot pass
  is rolled back so the next batch starts clean. Only the acceptance gate stages, only on pass. You
  always do the commit.

---

## Scope: is this the right tool?

This workflow reviews and hardens an existing codebase. It pays off when you want a thorough, verified
pass over a body of code, not a single targeted change:

- ✅ **Right size:** a production-readiness review of a codebase or a subsystem, where you want the
  issues found, triaged, and the approved ones fixed safely in batches — or a verified inventory (from
  manual testing) you want fixed the same way.
- ❌ **One bounded feature** (a single new tool, endpoint, or form): use the sibling
  [`feature-cycle`](../feature/).
- ❌ **One breadth-spanning goal** (a migration, version upgrade, or framework port): use the sibling
  [`migrate-cycle`](../migrate/). Large, cross-cutting items this tool routes to DEFER make good
  migrate-cycle goals.

---

## How to use it

This workflow ships in the [AI Prompt Guide workflows](../../README.md) repo. Install once — clone it
into your project as `aipg/`, gitignore it, and copy the slash commands (see the
[root README](../../README.md)) — then trigger it two ways:

- **Slash command:** `/aipg-debug` — then *"review this repo for production readiness; build is
  `<your build command>`, tests are `<your test command>`; start with the review pass."*
- **Plain pointer:** tell Claude to *use the debug **workflow** in `aipg/workflows/debug/`* to review a
  target, with your build and test commands.

Either way Claude reads `aipg/workflows/debug/CLAUDE.md` and runs `review.mjs` + `resolve-cycle.mjs`
(and `gen-units.mjs`) **by path** — the engines are in no global registry, so the folder pointer is how
they're discovered; nothing to build.

From there Claude drives everything:

1. **Splits the work.** It runs `gen-units.mjs` to divide your source tree into bounded review units,
   and shows you the unit list.
2. **Reviews it.** The reviewer and verifier run over every unit concurrently and write one issue file
   per unit under `runs/<runId>/issues/`. Then it stops.
3. **Walks you through triage.** Claude presents the inventory (totals, the hottest areas, every item
   that needs your decision) and helps you decide scope. You approve or skip issues by editing the
   issue files.
4. **Resolves it.** The fix, blind review, and issue-aware acceptance loop runs each batch unattended,
   staging it on acceptance and rolling back any batch it cannot pass. An optional sweep checks the end
   state.

A workflow runs in the background and **cannot ask you questions mid-run**, so Claude settles scope and
decisions with you between the two stages, not during them. Tip: have it resolve just **one area** first
(a `resolveOnly` scope) to sanity-check cost and quality before letting the rest go.

### Bring your own findings (skip the review pass)

The fix loop doesn't require the review pass — it only needs the issue files. When the findings come
from somewhere other than a code review (a **live testing session**, a bug bash, user reports, or a
symptom you diagnosed yourself), tell Claude to feed them into the debug workflow's fix loop: it authors
the per-unit issue files itself in the verifier's format (each finding anchored to `file:line` with a
precise fix instruction, and anything you decline recorded as a SKIP so the triage is on file), then
runs `resolve-cycle.mjs` as normal. Every safeguard still applies — each issue is re-confirmed against
the current code before it is touched, every batch passes the blind critic and the issue-aware
acceptance gate, and accepted work is staged for you to commit. If your findings include low-severity
polish, have Claude pass `fixSeverity: "low"` so they aren't filtered out by the default floor.

---

## The agents

Each is a fresh, throwaway context that does one job and returns one decision:

- **Reviewer** (review pass): reads one unit's files and reports production defects at or above your
  severity floor. Returns findings, writes nothing.
- **Verifier** (review pass): confirms each finding against the real code, corrects inflated
  severity, routes it (actionable, needs-your-decision, defer, or reject), and writes the unit's issue
  file. That file is both the inventory and your triage document.
- **Fixer** (fix loop): reads its batch's issue file verbatim, re-confirms each issue still exists
  (stale ones are skipped, never re-fixed), applies minimal fixes, writes pinning tests where
  warranted, runs your gates, and leaves the work **unstaged**. Owns the call on every review finding,
  logging declines with a reason and escalating only a decision you must make.
- **Blind quality reviewer** (fix loop): a blind code critic. Given no idea what the diff was
  meant to fix, it reviews **only the unstaged diff** for defects the fix introduced or broke. Must be
  clean before acceptance runs.
- **Acceptance verifier** (fix loop): the issue-aware gate. It re-derives each claimed fix's root
  cause from the current code and passes only if the fix closes it completely with no regression and
  green gates. On pass it stages the batch, and it is the only agent that stages.
- **Sweep** (after the last batch, optional): an independent end-state check. Runs the full gates,
  spot-checks the staged diff, and writes `SWEEP.md`.

The fix loop is **fix, then blind review, then acceptance**, repeated each round until acceptance
passes. Any code change re-enters at the blind review. A batch that cannot pass within its round budget
is rolled back to the staged baseline and its issues are marked needs-attention for you to retry.

---

## Reviewing the result

Nothing is committed; everything is staged in your repo. Review it like a PR:

```bash
cd /path/to/repo
git diff --cached            # everything staged
<your build + test command>  # confirm green yourself
```

The run leaves a transparent trail under `runs/<runId>/`:

- `issues/<unit>.md`: the per-unit inventory and your triage document (the deliverable of the review
  pass). Read these to plan, and edit decisions in them.
- `acceptance-review-<batch>-rN.md`: the issue-aware verdict per batch (root-cause check, regression,
  gate result). Read the latest before committing.
- `quality-review-<batch>-rN.md`: what the blind critic found each round.
- `DISMISSED-<batch>.md`: every finding the fixer declined, one line each with a reason. Audit this.
- `NEEDS-USER.md`: anything flagged for you. If a run stopped, the reason is here.
- `SWEEP.md`: the optional final accounting (full-suite result plus any gaps).

Run the gates yourself, spot-check the riskiest fixes, then commit. Issues marked needs-attention were
attempted and rolled back; retry them interactively with the batch's acceptance-review file as context.

---

## Requirements

- **Claude Code** with the Workflow capability.
- The target is a **git repository** (staging is how regressions are caught). The working tree should
  be clean-ish before resolve; pre-existing changes are folded into the staged baseline.
- Commands to **build and test** your project locally. You provide them; the workflow runs them and
  reads pass/fail. Resolve only accepts a batch on green gates, so the suite should be green before you
  start.
