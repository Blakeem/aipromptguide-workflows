# decide-cycle — operator guide (for Claude)

`decide-cycle.mjs` drives the AI to a **justified conclusion** among approaches: it **diverges** into one
lensed analyst per perspective (each finds + scores the best option through its lens), then **converges**
via a **decider** that builds a global weighted decision matrix pulling in the best of each, gated by a
**non-blind adversarial reviewer** — looped until decider and reviewer agree against fixed requirements.
Built to `../../principles/WORKFLOW-PRINCIPLES.md`. A *convergence* workflow: it honors the core (#1–4,
#6, #8, #11–14) and runs a review loop in the **spirit of #5 but non-blind by design** — the reviewer
must see the decision and the rubric to judge them (#3 guards code-regression anchoring, not argument
evaluation). It produces a conclusion, **not code**: nothing is staged or committed.

## 1. Scope (check FIRST)

Right size: one real decision with **genuine trade-offs** worth weighing from several perspectives
(≥2 lenses) — an architecture/pattern choice, a build-vs-buy, a data-model or algorithm selection. Too
small (one obvious answer, or a reversible coin-flip) → just decide and move on. Want open-ended creative
options for a *human* to pick with no AI verdict → **`brainstorm-cycle`**. Want to *build* the chosen
approach → **`feature-cycle`**.

**Believe the answer already EXISTS and just needs finding → `investigate-cycle`.** That is the adjacent
workflow most often reached for by mistake. Decide *generates* options through lenses and weighs them;
investigate *searches* for something that already exists and qualifies it against pass/fail criteria,
keeping a ledger of what failed so each round diverges, until it can evidence nothing was left unsearched.
The tell is your requirements: if you want to trade criterion A off against criterion B, you want the
weighted matrix here. If missing A is simply disqualifying, you want investigate.

**One winner, or a ranked shortlist?** `selection` (§8) picks the deliverable. Default `single`: one
justified conclusion. Set `"ranked"` when the answer is legitimately a *portfolio* rather than a choice —
"give me the best N, I'll pick or combine", e.g. ranking a large candidate pool surfaced by many agents
over a big corpus. Same weighted matrix, same citation discipline, same adversarial loop; only the shape
of the conclusion changes. An ordinary architecture/pattern decision stays on `single` — a hybrid that
fuses the best of several lenses is already in scope there, and is not what `ranked` is for.

## 2. The flow

Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `decide-cycle.mjs` + args.
No mid-run questions — settle the rubric with the user first:

1. **Author the requirements in `EnterPlanMode`.** This is the **fixed rubric** both the decider and the
   reviewer judge against — and the anti-spin ground that makes the loop converge. Capture (§4): the
   decision to be made, the **non-negotiable constraints** (pass/fail), and the **weighted criteria**
   (what "best" means, and how much each axis matters). `AskUserQuestion` for anything ambiguous —
   getting the rubric right is the whole game.
2. **`ExitPlanMode`** — user approves (the human gate).
3. **Pick the lenses** with the user — the evaluation perspectives, one analyst each (e.g. `efficiency`,
   `simplest`, `robustness`, `best-practice`, `risk`, `ux`). Propose them if the user has none. Distinct
   lenses surface distinct options; that spread is what the decider then balances.
4. **Run** the engine (`planPath` = the plan-mode file's **absolute** path, plus `lenses`). It diverges
   (analysts) then converges (decider ⇄ reviewer) and returns the chosen conclusion + the file trail.
5. **Present** the conclusion: relay the latest `decision-rN.md` (matrix + rationale + why-not-others)
   and let the user read each `lenses/<lens>.md` to see the source perspectives. To build it, hand the
   chosen approach to `feature-cycle`. In `ranked` mode there is deliberately **no winner**: relay the
   shortlist (what each option buys/costs + the combine-vs-exclusive section) and let the user pick or
   combine — several picks become `feature-cycle`'s `plans[]` roadmap.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (normally this tool's own directory).
- **`requirements` (inline) OR `planPath` — one REQUIRED.** The rubric (§4).
- **`lenses` — REQUIRED:** the perspectives from §2 (strings or `{ id, focus }`); ids that collide after
  slugging throw, since two analysts would write the same `lenses/<lens>.md`.
- **`target.repo` (optional):** pass it for a decision about existing code — all three roles (analysts,
  decider, reviewer) read it **read-only** for pattern-fit and feasibility; the engine never modifies it.
- **`testbed` (optional):** how agents may **empirically test** claims (e.g. a sqlite db + how to query
  it, a script to benchmark against). All three roles are told to prefer measured evidence — run the
  check, cite command + result (#14) — and the reviewer re-runs measurements to verify. Set it up
  read-only by construction (e.g. `sqlite3 "file:path.db?mode=ro"`, or a copy), and **pre-allowlist the
  commands** in the target project's settings — a background run can't answer permission prompts
  unattended.
- **Fresh vs. resume.** `NEEDS-USER.md` is cumulative. A re-run with the same `runId` overwrites the
  round files; clear `runs/<runId>/` for a genuinely fresh decision, preserve it on resume.

## 4. Requirements-file shape (you write it; agents read it VERBATIM, #2)

Plain markdown — the engine does **not** parse it. Keep it tight; this is the rubric, not an essay.

```markdown
## Decision
One line: the choice to be made.

## Non-negotiables   # pass/fail — an option that violates one scores 0 and cannot win
- e.g. "must run in the existing Node 20 runtime", "no new paid dependency", "p99 < 50ms".

## Weighted criteria  # what "best" means + how much each matters (weights need not sum to 100)
- performance (weight 3)
- maintainability (weight 3)
- migration effort (weight 2)
- ...

## Context / constraints   # domain facts the agents won't infer; what's in/out of scope.
```

## 5. Roles (in the engine)

The JS conductor sequences `agent()` calls, passing only paths + verdicts (#1). Each agent is fresh.

- **Analyst** (diverge · sonnet) — one per lens; reads the requirements + its lens, generates 2–4
  scored options, recommends one, notes keep-worthy elements, writes `lenses/<lens>.md`.
- **Decider** (decide · opus) — reads the requirements + every lens file (+ the latest review);
  consolidates options, may build a hybrid, scores a **global weighted matrix** (non-negotiables forced
  to 0, **every cell citing its lens evidence or marked "own judgment, low-confidence"**, #14), picks
  the winner with why-not-others, writes `decision-rN.md`. Escalates a user-only call to `NEEDS-USER.md`
  (halts on a hard blocker) — **and so may the reviewer**, for a requirement contradiction (§7); those are
  two distinct halt paths, not one. In `ranked` mode it instead ranks the strongest options (up to `shortlist`), each
  with what it **buys**, what it **costs**, its rank rationale, plus a **combine / exclude** section —
  an option violating a non-negotiable is off the list entirely, and it is told not to pad.
- **Reviewer** (review · opus) — **non-blind, adversarial**; reads the decision + requirements + lens
  files and tries to break the conclusion (unmet requirement, uncited/unsupported score — **it verifies
  matrix citations against the lens files** (#14) — overlooked option, violated non-negotiable). Reads
  no prior review file (re-checks fresh). Writes `decision-review-rN.md`. Agreement ends the loop. In
  `ranked` mode it also attacks the **order** (does anything dominate the option ranked above it?),
  **padding**, and the **combine/exclude claims** — two options sold as combinable that actually
  conflict is the most damaging error the list can carry.

## 6. Loop & contracts (keep intact)

`diverge (once) → [decide → review]×N`, up to `maxRounds` (default 3). Each non-agreeing review hands
the decider that one file's path next round; the decider revises rather than restarting.

- **The requirements file is the fixed rubric and the anti-spin ground.** Both agents judge against it,
  so the loop converges; there is no `DISMISSED.md` (the reviewer isn't blind-reviewing a diff, it's
  checking one conclusion against fixed requirements). If it won't converge, the rubric is usually
  under-specified — refine it, don't just raise `maxRounds`.
- **Non-blind is deliberate (#3/#5).** The reviewer must see the decision and rubric; never make it
  blind. It still reads no prior review file, to re-check fresh.
- **`selection` shapes the deliverable, not the rigor.** `single` (default) → one winner + why-not-each
  runner-up. `ranked` → an ordered shortlist (≤ `shortlist`, default 5, floor 2) where every listed
  option must satisfy every non-negotiable — a violator is excluded, never ranked last — and each
  carries explicit `combines_with` / `excludes` notes, because a shortlist the user can't safely mix is
  a trap. Both modes run the same matrix, citation rule, and review loop.
- **No code, no git.** Decide produces files only; it never stages or commits. The conclusion feeds
  `feature-cycle`/`migrate-cycle` next.
- **Thin returns (#8).** Schemas carry only `chosen` / `meets_all_requirements` / `agree` / counts, a
  `wrote_file` write confirmation per role (unconfirmed ⇒ a `⚠` in the log, never a halt — open that
  file before relaying it) — plus, in `ranked` mode, the shortlist **index** (rank + title +
  `combines_with`/`excludes`); the matrices, buys/costs, and reasoning live in the files.

## 7. Resume

Halts only when the decider or reviewer writes a user-only call to `NEEDS-USER.md`. Resume: read it,
resolve with the user (usually by editing the requirements file), preserve `runs/<runId>/`, re-invoke
with the same args.

The run can also stop by **throwing**: no analyst produced a lens file, or the decider/reviewer returned
nothing (agent skipped or died). Re-invoke with the same args/`runId` and pass the `Workflow` tool's
`resumeFromRunId` to replay completed agents from cache, as the thrown message says.

## 8. Args reference

Full schema + defaults: the Config block atop `decide-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `lenses` (array of ≥2 perspectives, distinct ids — both
  enforced) · `requirements`
  (inline) **or** `planPath` (absolute path to the rubric file).
- **Optional:** `selection` (`"single"` default | `"ranked"` — §1/§6; anything else throws) ·
  `shortlist` (ranked only: how many options to carry, default 5; **throws** below 2 or non-numeric) ·
  `context` (extra framing / domain facts) · `testbed` (how to empirically test claims —
  §3) · `target.repo` (absolute, read-only context) ·
  `target.lang`/`target.framework` (hints) · `maxRounds` (3; **throws** below 1 or non-numeric — it used
  to coerce, and a NaN bound silently produced a zero-round run reported as an ordinary result) ·
  `models` (per-role tier: analyst/decide/review) · `agentTypes` (custom subagent per role — must exist
  in your registry) · `stateDir` (override `runs/<runId>`).

## 9. State files (`runs/<runId>/`, gitignored)

- `lenses/<lens>.md` — each analyst's options + lens scores + recommendation.
- `decision-rN.md` — the decider's matrix + conclusion + why-not-others for round N (in `ranked` mode:
  the matrix + the ranked options with buys/costs + the combine-vs-exclusive section).
- `decision-review-rN.md` — the adversarial reviewer's gaps (or agreement) for round N.
- `NEEDS-USER.md` — user-only escalations; a hard blocker here halted the run.

Report when done: status (agreed / needs-attention / blocked), the chosen conclusion, where the matrix
is (`decisionFile`), and the lens files for the user to inspect. The return carries the paths
(`decisionFile` / `reviewFile` / `needsUserFile`), each lens's top pick (`lensPicks`), and `selection`
as structured fields; in `ranked` mode it adds the ordered `shortlist` index and `chosen` is the rank-1
option. **Nothing is staged or committed.**
