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
5. **Plan-defect wedge — the round loop cannot converge when the PLAN is what's wrong.** Observed
   2026-08-01, wt-tooling/wt-land: the roadmap's lock spec was itself defective (`startedAt`-only
   staleness), conventions said "follow the plan text exactly, do not improve", so every round the
   builder faithfully re-implemented the flaw and the quality reviewer correctly re-rejected it —
   4/4 rounds burned, plan parked, resolved only by a human amending the plan and relaunching.
   Rounds fix implementations; nothing in the loop can fix the plan. Candidate fixes: (a) let the
   developer flag "this finding indicts the plan text, not my code" as a distinct halt-kind that
   short-circuits remaining rounds straight to park/escalate with a plan-defect diagnosis; (b) have
   the harness detect the same quality finding recurring against the same plan clause across rounds
   and park early; (c) a bounded plan-amendment step (acceptance-side, plan-aware, never the blind
   reviewer) that proposes a spec patch for the user instead of more build rounds. (a) is cheapest
   and honors the file-bus design — the developer already reads the review and the plan side by side
   and is the only agent positioned to see the contradiction.
   *Related near-miss, same family:* the round-1 dirty-baseline halt assumes nothing else writes to
   the target tree mid-run — but the OPERATOR is part of "anything else" (an unstaged docs edit made
   while a run was in flight missed halting it by seconds). The engines cannot guard the operator;
   the guides should state the rule: while a build run is in flight, the target repo's tree is
   frozen to everyone, including the person driving.
6. **`land`'s gate has no heartbeat inside it** (`tools/wt.mjs`) — liveness beats are written at step
   boundaries only, and the gate is the one long stretch between beats, so a gate slower than
   `--stale-ms` invites a takeover; the loser then refuses to merge and exits 75 (safe by DETECTION —
   the pre-merge ownership re-check). Prevention would be running the gate via async `spawn` with an
   interval heartbeat, which the wt-land reviewer noted and the build declined because wt.mjs is
   wholly synchronous. Worth doing only if real gates start tripping 75 mid-gate; until then the
   playbook's rule (set `--stale-ms` above the slowest gate) covers it.

## Judgment-only (stays in tests/CLAUDE.md §3 — not mechanically checkable)

- A flag derived from a halt-kind DEFAULT inheriting a lie (gate on `round > 0`).
- A pre-filter knob that silently drops work (its count belongs in the return).
- Halt-vs-flag policy for self-contradictory agent returns (does the harm compound?).

## Done since filing

- **Worktree parallelism** — BUILT 2026-08-01 (wt-tooling roadmap: `tools/wt.mjs`, `tests/wt.test.mjs`,
  playbook `docs/worktree-batches.md`). First live parallel batch still pending: the debug+migrate
  guide links to the playbook, run as two chains.
