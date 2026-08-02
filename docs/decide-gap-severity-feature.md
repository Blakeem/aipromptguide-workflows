# Decide: gap severity + "accepted with notes" — feature notes

**Status: PLANNED (2026-07-29). Nothing implemented.** Evidence is from decide run
`worktree-parallelism-1` (first real run after the stop-criteria work). `runs/` is gitignored, so the
key numbers are recorded here.

## The problem

`agree` is a boolean meaning **zero gaps**, and the reviewer is instructed to break the conclusion. For
a design spec of any size there is always one more real, *additive* gap, so a finished decision exits as
`needs-attention (no agreement within round budget)`. This is the mirror image of the investigate defect
the stop-criteria work fixed: there a **stopped** search read as finished; here a **finished** decision
reads as unsettled. The reviewer is contract-correct, not obstinate — it distinguishes "winner-flipping"
from "additive" in prose, but the schema cannot carry that distinction.

## Evidence (run `worktree-parallelism-1`, 2026-07-29)

- The winner's family was unanimous across all four lenses **before the decider ran**; r1 picked the
  final shape and it never changed. Rounds 2–3 changed one enforcement mechanism (non-negotiable #1:
  advice string → engine-string edit → git hook) and hardened the spec.
- `gapRounds`: 5/5 new · 4 new + 1 repeated · 6/6 new. 16 gaps, one repeat — no re-litigation. Every
  round produced measured design changes (r1: the semantic-overlap hole → the sync-and-gate landing
  step; r2: refuted the r1 winner's variant *and* contributed the hook that became the final winner;
  r3: the `merge=union` `.gitattributes` hole).
- The r3 review opens: the winner's shape *"survives every attack I could mount"* — and still could not
  agree, because six (additive) gaps existed. It marked them "not winner-flipping" in prose only.
- The reviewer itself predicted r4 would find *"residual number five and land in exactly the same
  place"* — the loop was not going to converge under the zero-gaps contract.
- The counterfactual cuts both ways: agreement at r2 would have shipped a variant whose protection was
  later measured inert, so **early** convergence is also a real risk; and with `maxRounds: 3` the cap
  spent the budget correctly. The defect is the final *label*, plus wasted rounds only at higher budgets.

## Design sketch

- `REVIEW_SCHEMA`: per-gap severity — `gap_ids` entries gain a `blocking` flag (shape TBD: parallel
  array or `[{ id, blocking }]`). **Blocking** = the winner, the ranking, or a non-negotiable verdict is
  wrong or unsupported. **Non-blocking** = the conclusion stands; the spec needs the addition.
- Close the loop on `agree === true` **or** zero blocking gaps → new terminal `accepted with notes`,
  its own status string, never folded into `agreed` (stopped ≠ finished discipline). The notes must
  reach the user as build-plan input, listed by slug, pointing at the review file.
- Reviewer prompt defines the two severities in claim/attack terms; an unmarked gap defaults to
  **blocking** (conservative).
- `gapRounds` gains the blocking/notes split so the repeated-vs-new churn diagnosis stays sharp.
- Discipline (tests/CLAUDE.md): new terminal ⇒ flow scenario reaching it + exact-string status
  assertion + `gen-flows` regen; count-vs-list mismatch ⚠ pattern already exists for `gap_ids`.
- **Anti-scope:** no numeric grades or thresholds — severity is a claim the reviewer makes and defends,
  not a score. Keep the hard cap. Keep the loop non-blind.

## Rubric-side learning (no engine change — apply when authoring decide rubrics)

When non-negotiables are pass/fail with no enforcement standard, every round re-litigates "is this
residual disqualifying?". The run's WHERE NEXT produced the working template: **violated = breachable on
the default path** (agents/engines/design commands, default repo config); residuals reachable only via
operator action or non-default config score under a weighted criterion instead — **but an unnamed
residual IS a violation** (the completeness teeth that make the loop terminate). Worth folding into
`workflows/decide/CLAUDE.md` §4 as rubric-authoring guidance when this feature is built.

## Trigger

Hold until a second decide run shows the same signature — winner stable early, agreement blocked only by
additive gaps, mostly-new trajectory. One run is one data point.
