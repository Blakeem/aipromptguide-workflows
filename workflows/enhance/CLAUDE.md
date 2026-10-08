# enhance-cycle — operator guide (for Claude)

`enhance-cycle.mjs` audits a system that **already works** for **enhancements** — bigger changes worth
writing up, not nits. It fans out one **finder per lens** across the WHOLE scope (breadth, not file
slices — cross-cutting enhancements are the point), then a **verifier per lens** that kills anything the
system already does, scores impact × effort, routes each survivor, and writes one verbatim
`proposals/<lens>.md`. Then it **STOPS**. Built to `../../principles/WORKFLOW-PRINCIPLES.md` — a
*generative* workflow honoring the core (#1–4, #6, #8, #11–15); it writes no code, stages nothing, and
never commits.

**There is deliberately NO fix-mode output.** Nothing here is ever applied automatically. That is not an
omission — see §6.

## 1. Scope (check FIRST)

Right size: an existing system worth auditing from **several genuinely different angles** (≥2 lenses) for
changes that make it faster, cheaper, simpler, smaller, more robust, less work to operate, or newly
capable.

- **A defect — anything the system gets WRONG today** (bug, typo, edge case, destructive behavior) → the
  **debug** workflow. Not this one; the verifier rejects defects on sight and tells you to route them.
- **Open-ended creative variations** for a human to pick → `brainstorm-cycle`.
- **Concluding among competing approaches** → `decide-cycle`.
- **Building** an adopted proposal → a `feature` block in a `develop-cycle` plan file (several adopted
  items become several blocks), or `section` blocks for one goal spanning many call sites.
- Too small (you already know the change) → just make it.

**Enhancement, not improvement — the floor is deliberately high.** A typo IS an improvement, but nobody
writes it up as an enhancement, and debug catches it anyway. The test the agents are given: *would a
competent engineer write this up as an enhancement ticket?* **Removal counts** — deleting a role, a file,
an argument, a phase, or a code path is a first-class enhancement, and the finder is told to hunt for it
deliberately because most audits only add.

## 2. The flow

Launch every run from a notification turn (root `CLAUDE.md`, "Launch from a notification turn").
Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `enhance-cycle.mjs` + args.
One phase, no mid-run questions — settle everything with the user first:

1. **Settle the scope and the lenses with the user.** The scope is the paths every finder reads; the
   lenses are the axes of enhancement, one finder + one proposal file each. Propose lenses if the user
   has none (e.g. `efficiency`, `simplification`, `operator-effort`, `robustness`, `cost`). Distinct
   lenses find distinct things — near-duplicate lenses just pay twice for the same list.
2. **Agree what "better" MEANS here** (`goals`) — the north star every lens serves. Without it each lens
   optimizes for its own idea of better and you triage a pile of contradictions.
3. **Run** the engine. It returns per-lens counts + the proposal file paths.
4. **Present and triage** per §7.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (this checkout — or, from the installed
  aipg plugin, the persistent data dir the skill resolves, never the version-swapped install dir) so
  `runs/` lands outside the target repo.
- **`scope` — REQUIRED:** the file/dir paths every finder reads. Each lens sees **all** of it, so keep it
  to what one agent can genuinely read in a turn. Larger than that → run per subsystem with a narrower
  scope. Every proposal targets the scope. Agents may read and cite files outside it as evidence.
- **`lenses` — REQUIRED:** ≥1 axis (strings, or `{ id, focus, criteria }`). Ids that collide after
  slugging throw — two lenses would write the same proposal file.
- **`target.repo`:** the absolute path to the system under audit — the directory holding its `.git`.
  REQUIRED whenever any `scope` path is relative (it is what they resolve against); the engine throws
  otherwise rather than guessing, since defaulting to `root` would audit the run-state base (this
  checkout, or the plugin data dir). Give every `scope` path as an absolute path and you can omit it.
- **`goals` (strongly recommended):** what "better" means for this system.
- **`conventions`:** house rules an enhancement must fit — or argue explicitly for changing.
- **`minImpact`** (default `moderate`): the floor. `marginal` is below it on purpose. Lower it only if
  you genuinely want the long tail; that is the noise spiral. The verifier rejects a candidate it scores
  below the floor and names it in that lens file's `## Rejected` section. That section is where a thin
  run shows whether the floor or the system thinned it.
- **Relaunch vs. new run.** A re-run with the same `runId` overwrites the proposal file of each lens that
  produces one in this run. A lens in `failed` keeps any earlier file, so present only the paths in
  `lenses[].file`. Keep an old batch → new `runId` (or `stateDir`).

## 4. Lenses — the fan-out axis

Each lens is ONE finder (+ verifier) → ONE proposal file. `{ id, focus, criteria }`; a bare string is
both id and focus.
- **`focus`** — the perspective, pushed hard. The finder is told not to hedge toward the other lenses.
- **`criteria`** (optional) — what to weigh under this lens.

**Why lens and not file-slice.** Slicing by file is debug's axis and is right for local defects. An
enhancement is frequently cross-cutting — "every engine re-implements this", "these three roles could be
two" — and is *invisible* to a reader holding one file at a time. So each finder gets breadth.

**Cross-lens overlap is signal, not duplication.** Two lenses landing on the same change independently is
the strongest evidence the run produces. The engine keeps the lens files separate and lets you see the
convergence — there is no merge agent (#4/#6).

## 5. Roles (in the engine)

The JS conductor routes only paths + verdicts (#1). Each agent is fresh. Both roles are **opus**: the
finder needs breadth and judgment across the whole scope, the verifier is the quality gate that kills the
noise.

- **Finder** (find · opus) — reads the whole scope through ONE lens. Every candidate must be grounded in
  the code as it is: **what the system does today** (cited `file:line`) → **what it would do instead** →
  **the specific cost that removes** (tokens, wall-clock, agent count, operator steps, a failure mode,
  maintenance surface). No nameable cost = not an enhancement. Zero candidates is a legitimate outcome —
  the finder then writes its own clean `proposals/<lens>.md` marker. A finder that verifies a defect in
  passing reports it as a `DEFECT:` candidate.
- **Verifier** (verify · opus) — spawned ONLY for lenses with candidates. It reads the code each
  candidate cites plus what the REJECT rules need, and for rule 1 searches the scope for an existing
  mechanism by what it does, not only by the candidate's words. Rejects ruthlessly, first match
  wins: (1) **the system already does this** — the most common failure of a find pass; (2) the claimed
  cost is not real or cannot be substantiated from the code; (3) it is taste; (4) it is a **defect**, not
  an enhancement — rejected with `is_defect`, so you can route it to debug; (5) its verified **risk
  outweighs** the cost removed, such as breaking something the system needs or leaving a required
  instruction ambiguous — rejected with `too_risky`. Then it re-scores impact/effort (finders over-rate)
  and **writes** `proposals/<lens>.md` verbatim. A real candidate it scores below the floor keeps
  `is_real` true and is rejected as below the floor.

## 6. Contracts (keep intact)

- **Nothing is auto-applied, and there is no fix-mode output.** This is the load-bearing design decision.
  Debug's inventory feeds develop's fix mode, an autonomous fixer. Enhancements must never enter that path.
  They would be auto-applied behind a two-round gate, which is the exact scope creep debug exists to
  prevent. So this engine writes to `proposals/`, **never `issues/`**, and stops at the inventory.
- **An enhancement list does not converge.** There is always another enhancement. Debug's *closed*
  inventory is what makes its fix loop terminate; an open-ended proposal list has no such property, which
  is the second reason it must not drive a fixer.
- **Defects are out of scope, both directions.** A finder reports a defect it found in passing as a
  `DEFECT:` candidate, never as an enhancement. The verifier rejects it with `is_defect=true` and lists
  every defect, including one split from a kept candidate, under `## Defects to route` so you can route
  it. Do not relax this — the two workflows stay clean by staying separate.
- **Read-only.** The only files written are the per-lens proposal files. Source is never modified,
  nothing is staged, nothing is committed.
- **One writer per proposal file** — the finder when the lens is clean, the verifier when it has
  candidates; never both (parallel-safe, same contract as debug's `review.mjs`). For the same reason
  there is **no shared `NEEDS-USER.md`**: the lenses run concurrently and an agent "append" is a
  read-modify-write, so two verifiers would silently clobber each other. A user-only call goes in that
  candidate's block in its own lens file, options + recommendation included — nothing is lost.
- **Thin returns (#8).** Counts and routing decisions only; every proposal's prose lives in its file.

## 7. Presenting the result (the deliverable is a triage conversation)

Follow the return's `nextStep`. It names the counts, the files to present, the order to present them
in, where each decision routes and every caveat. The return's `summary.unjudged` counts the candidates
the verifier returned no verdict for, which are in no other count.

What each decision means:
- **ADOPT**: well-scoped and ready to hand to a builder as-is.
- **ROADMAP**: real, but it needs planning rather than a single change.
- **NEEDS_USER**: a genuine product or design call, with options and a recommendation in its block.
  These are the items that need the conversation.

## 8. State files (`runs/<runId>/`, outside every repo)

- `proposals/<lens>.md` — one per lens (non-alphanumerics in the lens id become underscores:
  `operator-effort` → `operator_effort.md`): the verified, impact-scored proposals, a
  `## Defects to route` section (one line per defect, written only when it has one) and a `## Rejected`
  section (one line each). This IS the deliverable. A verifier-written file (a lens that had candidates)
  carries `lens`, `focus`, `reviewed` and a `note` stating these are proposals requiring human triage;
  a clean lens's finder-written marker carries only `lens` and `reviewed`. A lens reports NO file when
  its finder died, its finder returned no candidate without attesting its marker, its verifier died, or
  its verifier did not confirm writing the file. Each of those lands the lens in `failed`. The run logs
  a ⚠ naming the lens in each case. Re-run it.
- No shared `NEEDS-USER.md` (§6) — a user-only call lives in its candidate's block in the lens file.

No `issues/` directory (deliberately — §6), no status files, no run summary.

## 9. Args reference

Full schema + defaults: the Config block atop `enhance-cycle.mjs` (the canonical source). Pass `args`
inline.
- **Required:** `runId` · `root` (§3) · `scope` (array of paths every finder reads) · `lenses` (array of
  axes — strings or `{ id, focus, criteria }`).
- **Optional:** `target.repo` (absolute) · `goals` (what "better" means — strongly recommended) ·
  `conventions` (house rules) · `context` (domain facts the agents won't infer) · `minImpact`
  (`transformative`|`high`|`moderate`|`marginal`; default `moderate`) · `categories` (override the
  finding enum — default `efficiency`, `simplification`, `removal`, `robustness`, `capability`,
  `operator-effort`, `consistency`, `observability`, `cost`) · `target.lang`/`target.framework` (hints) ·
  `models` (per-role tier: find/verify; both default opus) · `agentTypes` (custom subagent per role —
  must exist in your registry) · `stateDir` (override `runs/<runId>`).

Agent count is bounded and visible up front: **≤ 2 × lenses** (one finder each, plus a verifier only
where candidates exist).
