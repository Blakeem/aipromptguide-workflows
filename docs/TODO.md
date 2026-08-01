# TODO — open work items

Programmatic hardening items not yet built (all test/engine-side, no new agent complexity), plus the
judgment-only gotchas that stay manual. Context: the 2026-08-01 hardening-sweeps roadmap shipped the
args-JSON guard, prose-sniff tripwire, top-level attestation sweep, and required-args sweep.

## Buildable (feature-cycle candidates)

1. **Kill-one-role dead-agent sweep** — the mechanical enforcement of principle #15. For each engine,
   take its healthy scenario from `tools/flows/<name>.flow.mjs`, null one role at a time
   (`respond[role] = null`), and assert the outcome is VISIBLY different from the healthy run: a
   different terminal status, a `failed`/`needsAttention`/`sweepFailed` entry, a throw, or a log line
   naming the death. Any Stage-4 expression that launders the null makes dead ≡ healthy and the sweep
   goes red. Highest value, largest build of the set.
2. **Schema-scoped attestation matching** — closes the known name-collision blind spot (two schemas in
   one engine sharing a field name, e.g. FIX_SCHEMA.notes vs PARK_SCHEMA.notes: consuming one masks
   the other). Fix is test-side only: bind each schema's consumer check to the RECEIVER variable of
   its `agent()` call (`const fix = await agent(...)` → only `fix.notes` counts), falling back to the
   current file-wide match where the receiver is anonymous (pipeline stage returns). Do NOT rename
   schema fields — they are the runtime contract. Optional rider: nested-field coverage as a separate
   allowlist-heavy block (measured 2026-08-01: all-depth flags 33 false positives of 36).
3. **Write-confirmation asymmetry heuristic** — a prompt that instructs writing a file should carry a
   consumed `wrote_*`/marker boolean in its schema. Only approximately formalizable (detecting "this
   prompt instructs a write" is heuristic); scope a v1 to prompts that interpolate a state-file path.
4. **planPath-inside-target-repo guard** — engines warn (or throw) when a `planPath`/`plans[].planPath`
   resolves inside `target.repo`, mirroring the existing run-state placement guard. The guide's
   snapshot rule covers this by instruction today; this makes it structural (#3).

## Judgment-only (stays in tests/CLAUDE.md §3 — not mechanically checkable)

- A flag derived from a halt-kind DEFAULT inheriting a lie (gate on `round > 0`).
- A pre-filter knob that silently drops work (its count belongs in the return).
- Halt-vs-flag policy for self-contradictory agent returns (does the harm compound?).

## In flight elsewhere

- **Worktree parallelism** — decided (E-c: worktree-per-issue, main-agent orchestrated, one
  deterministic lander + scoped stash hook) in `runs/worktree-parallelism-1/decision-r3.md`; open
  questions at its end await triage, then a feature-cycle build of `tools/wt.mjs` + docs.
