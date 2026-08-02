# TODO — open work items

Programmatic hardening items not yet built (all test/engine-side, no new agent complexity), plus the
judgment-only gotchas that stay manual. Context: the 2026-08-01 hardening-sweeps roadmap shipped the
args-JSON guard, prose-sniff tripwire, top-level attestation sweep, and required-args sweep.

## Buildable (feature-cycle candidates)

3. **Write-confirmation asymmetry heuristic** — a prompt that instructs writing a file should carry a
   consumed `wrote_*`/marker boolean in its schema. Only approximately formalizable (detecting "this
   prompt instructs a write" is heuristic); scope a v1 to prompts that interpolate a state-file path.
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
  playbook `docs/worktree-batches.md`). First live parallel batch ran 2026-08-02 (batch h1, below).
- **Item 2, schema-scoped attestation matching** — BUILT 2026-08-02 (batch h1, `attestation-scoping`):
  receiver-bound `consumed()`, alias rule, ambiguity = extractor error (three local renames), explicit
  fallback list, per-site ALLOW shape; three hidden dead `notes` fields got real consumers. The
  nested-field rider (all-depth: 33 false positives of 36 measured) remains open by choice.
- **Item 1, kill-one-role dead-agent sweep** — BUILT 2026-08-02 (batch h2, `dead-agent-sweep`):
  `tests/dead-agent.test.mjs` kills each role once per engine (kill-first wrapper, PARK_OK merged,
  explicit per-engine signal table) and requires a visibly different outcome. Fixed the four
  launderers it was built to catch: feature-cycle's three round roles now halt `agent-dead`
  (mirroring migrate), docs-cycle's dead scrubber is loudly logged. Plus `tests/docs.test.mjs` (new).
- **Item 5, plan-defect wedge** — BUILT 2026-08-02 (batch h2, `plan-amend-protocol`): MATRIX case 6
  split 6a/6b in feature/migrate/resolve — a VERIFIED defect in what the plan (or an issue's Fix)
  prescribes is fixed and recorded in `AMENDED-<id>.md` (acceptance-only; plan-text-free pointer in
  NEEDS-USER.md; required `plan_amendments` attestation; followups name amended ids). The related
  operator rule (tree frozen mid-run) is in the guides.
- **Item 4, planPath-inside-target-repo guard** — BUILT 2026-08-02 (batch h1, `planpath-guard`):
  feature (top-level + `plans[]`, deduped) and migrate (top-level) warn loudly, mirroring the
  run-state placement guard.
