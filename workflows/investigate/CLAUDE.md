# investigate-cycle — operator guide (for Claude)

`investigate-cycle.mjs` finds an answer that **already exists** and qualifies it against **fixed pass/fail
criteria**: ONE **investigator** per round hunts for candidates, self-checks each against every criterion,
writes each qualifier to `options/<id>.md` and every reject to an append-only **`DISQUALIFIED.md`** ledger
it re-reads at the top of the next round — so each round diverges from what already failed instead of
circling — and an adversarial **non-blind critic** verifies each new option (and each citation against its
source) before it counts. The loop ends when the investigator can **evidence** that no avenues remain and
the critic agrees, not when the first answer works. Built to `../../principles/WORKFLOW-PRINCIPLES.md`. A
*convergence* workflow of the **search** shape: it honors the core (#1–4, #6, #8, #11–14) and runs a review
loop in the **spirit of #5 but non-blind by design** — a critic that cannot see the option or the criteria
cannot verify either. It produces a determination, **not code**: nothing is staged or committed.

## 1. Scope (check FIRST)

Right size: a question whose answer **likely already exists** and must satisfy **every** one of several
hard constraints — a library, tool, API, config, technique, standard, or precedent — plus the evidence
that nothing better was left unsearched. The domain need not be code: everything domain-specific arrives
through the criteria file.

- **No established answer, and the real work is weighing trade-offs** among approaches the AI generates →
  **`decide-cycle`**. That is the sharpest split here: decide converges on *reviewer agreement about an
  argument*; investigate converges on *coverage* — the claim that nothing qualifying was left unsearched.
- **Creative variations for a human to pick between** (no AI verdict) → `brainstorm-cycle`.
- **Provisioning the docs** to build against → `docs-cycle`.
- **Building what the determination names** → `feature-cycle`.
- Too small (you already know the answer, or one search settles it) → just look it up.

**Pass/fail, not weighted.** Every criterion is a gate. A candidate that misses one is disqualified however
strong it is elsewhere. If you catch yourself wanting to trade criterion A off against criterion B, you
want `decide-cycle` instead — that is exactly what its weighted matrix is for.

## 2. The flow

Pick a `runId`; reuse it for every phase. `Workflow` loads by path: `scriptPath` = absolute path to
`investigate-cycle.mjs` + args. **Two invocations: refine the criteria, then run.** No mid-run questions.

1. **`EnterPlanMode`.** Author the criteria (§4) — the question, the pass/fail criteria, the evidence
   standard, the search space. `AskUserQuestion` for anything ambiguous. Getting the criteria right is the
   whole game: they are what makes qualification decidable and the loop terminable.
2. **`ExitPlanMode`** — user approves (the human gate).
3. **`phase:"refine"`** (MANDATORY, same `runId`) with `planPath` = that file's **absolute** path. An
   independent Criteria Critic returns `gaps` / `questions` / `unfalsifiable` in the tool result and
   **writes nothing**.
4. **Fold the findings in.** Fix gaps directly in the criteria file; relay each question via
   `AskUserQuestion`. **Replace every `unfalsifiable` criterion with one evidence can settle** — a
   criterion nothing can decide keeps every candidate arguable forever and the loop never converges.
5. **`phase:"run"`** (same `runId` + `planPath`). It loops investigator ⇄ critic and returns the qualifying
   options, the determination, and which terminal state it reached.
6. **Present** per §7 — and lead with *which* terminal state, because they mean very different things.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (normally this tool's own directory).
- **`criteria` (inline) OR `planPath` — one REQUIRED.** The pass/fail rubric (§4). The guard is
  unconditional: it fires for `refine` as well as `run`.
- **`sources` (optional but useful):** a starting set of avenues (strings, or `{ id, focus }`). It is
  deliberately **not** a fan-out key — one investigator per round sweeps them all, and it is explicitly an
  opening list, not a closed one. An avenue the investigator finds itself counts just as much, and one it
  rules out goes in the ledger.
- **`target.repo` (optional):** pass it when the answer must fit existing code. All roles read it
  **read-only**; the engine never modifies it.
- **`testbed` (optional):** how a candidate may be **empirically checked** (a scratch project to install
  into, a script, a read-only endpoint). Both roles are told to prefer measured evidence and cite the exact
  command + result, and the critic re-runs measurements. Keep it read-only by construction and
  **pre-allowlist the commands** — a background run cannot answer permission prompts.
- **`maxRounds`** (default 5) and **`minRoundBudget`** (default 100k) bound the search — §6.
- **Fresh vs. resume.** The ledger IS the search's memory, so **preserving `runs/<runId>/` is what makes a
  resume cheaper than a restart.** Clear it only for a genuinely different question.

## 4. Criteria-file shape (you write it; agents read it VERBATIM, #2)

Plain markdown — the engine does **not** parse it.

```markdown
## Question
One line: what you need to know.

## Acceptance Criteria   # PASS/FAIL gates — missing ONE disqualifies a candidate outright
- Each must be decidable from evidence. "Must run on Node 20", not "must be maintainable".

## Evidence Standard     # what COUNTS as proof a criterion is met
- e.g. "cite the official docs for the version in scope", "a passing check against the testbed",
  "the code section AND confirmation no local amendment supersedes it".

## Search Space          # where the answer is expected to live; what is in and out of scope
- Bounded enough that an exhaustion claim over it could ever be evidenced.

## Context / constraints  # domain facts the agents will not infer
```

**The Evidence Standard is the section people skip and then regret.** Without it, "meets criterion 3" is
one agent's opinion against another's, and the critic has nothing to check a citation *against*.

## 5. Roles (in the engine)

The JS conductor routes only ids, paths + verdicts (#1). Each agent is fresh. All three default to **opus**:
the search is the hard part, the critic re-verifies citations against their sources, and there are few
agents per run, so a fast tier buys nothing.

- **Criteria Critic** (`criteria` · refine phase only) — reads the criteria, returns `gaps`, `questions`,
  and **`unfalsifiable`** (its distinctive job: criteria no evidence could settle, or that contradict each
  other). Writes nothing. A dead critic **throws** — "no gaps" and "no critic" must never look alike.
- **Investigator** (`investigate`) — one per round, sequential. Reads the criteria verbatim, **the whole
  ledger**, and the last critique; searches; self-checks every candidate against every criterion; writes
  `options/<id>.md` per qualifier and a ledger line per reject, marking `NEAR-MISS:` the ones that failed
  **exactly one** criterion; writes `DETERMINATION.md` (§6) on a terminating round **and on the last round
  the budget allows**. Escalates a user-only call to `NEEDS-USER.md` — **and so may the critic**, for a
  criteria contradiction; those are two distinct halt paths, not one.
- **Acceptance Critic** (`critique`) — adversarial, non-blind, **skipped only in a round that adds no
  option, claims no termination and owes no determination**. Verifies each new option against every
  criterion and each citation against its source, disqualifies what fails (appending to the same ledger),
  re-checks every `NEAR-MISS` marker (an over-claimed one poisons the determination), attacks any
  exhaustion or no-solution claim, and checks the determination whenever one was written. Only ids it
  **upholds** reach the caller.

## 6. Loop & contracts (keep intact)

`refine (once) → [investigate → (critique, when there is something to check)] × maxRounds`. The loop
**starts and ends with the investigator**; the critic only ever judges what a round produced.

- **The ledger is the convergence mechanism.** One investigator per round, strictly sequential
  (investigator, then critic), is the *only* reason a single append-only file with two writers is safe.
  Do not parallelize the investigator without splitting the ledger per candidate first.
- **Exhaustion must be evidenced and survives an attack.** `exhausted` requires naming which avenues were
  swept and why what remains cannot hold a qualifier. The critic may set `contests_exhaustion`, which buys
  another round. That contest is what makes "these are all of them" worth anything.
- **`DETERMINATION.md` has a fixed shape** — ANSWER, COMPARISON, WHICH TO PICK WHEN, NEAR MISSES,
  COVERAGE (plus, on a no-solution, the criterion to relax). The **comparison tables the axes the
  qualifiers actually differ on** — what each buys and costs — never the criteria, since every qualifier
  passes all of those and a criteria table compares nothing. "Which to pick when" is a discriminator, not
  a ranking. Loosen this and a multi-option run degrades into a bag of files, which is what it did before
  the shape was specified.
- **It is written on the LAST round too, not only a terminating one.** A search that merely ran out of
  rounds still owes its comparison and its near misses, and the investigator that just ran is the only
  agent left to write them — so the final round is told to write it and to label it a **partial result**.
  This is also why the critic gate opens on that round: the determination is the file the user reads, and
  nothing unvetted may reach them.
- **Near misses are first-class.** A candidate failing **exactly one** criterion gets a `NEAR-MISS:` ledger
  line with the shortfall in numbers, its own determination section, and a count in the return. On a
  no-solution or round-budget run it is often the only actionable thing the search produced, and one line
  among hundreds in the ledger is where it would otherwise die. The marker is a **fact** — two failed
  criteria is not a near miss.
  **Both writers mark and count**, so an option the critic itself knocks out on one criterion counts too
  (that is the most interesting kind: it got far enough to look like an answer). The critic also re-checks
  the investigator's markers, but its corrections land in the **review file and the ledger, not in the
  count** — `nearMisses` is a tally of ledger markers, not a critic-verified figure. Read the latest
  `acceptance-review-rN.md` before quoting the number. It counts **this invocation's** markers, while
  `DISQUALIFIED.md` is cumulative across resumes — a resumed run reporting 2 against a ledger holding 9 is
  correct, not a bug.
- **Five terminal states, never folded together.** "Ran out of rounds", "ran out of tokens" and "nothing
  can qualify" are three different facts, and collapsing any pair is how a *stopped* search gets reported
  as a *finished* one:

  | `status` | What it means |
  |---|---|
  | `exhaustive (search closed, critic agreed)` | The answer set is complete as far as the criteria reach. |
  | `not exhaustive (round budget spent)` | Options may be valid, but **nothing was proved complete**. |
  | `no qualifying option exists (verified)` | Critic-verified: nothing can meet these criteria. |
  | `stopped on token budget (resume where it left off)` | Clean stop between rounds; the ledger resumes it. |
  | `BLOCKED (needs user input)` | Criteria contradiction or a user-only call. Halted. |

- **Nothing unvetted reaches you.** The return carries the critic's **upheld ids only**, never a listing of
  `options/`. An escalation raised alongside new options still gets those options critiqued *before* the
  halt is honored.
- **A dead agent throws.** All three roles are solo and critical, so death is never laundered into "found
  nothing, swept everything" — which is exactly the shape of a successful exhaustive search.
- **No code, no git.** Files only; nothing staged, nothing committed.
- **Thin returns (#8).** Counts, ids and verdicts; every citation, comparison and rejection reason is in a
  file.

## 7. Presenting the result (lead with the terminal state)

- **`exhaustive`** — relay `DETERMINATION.md` (the options, the comparison, which to pick when, the near
  misses, the coverage evidence), then the per-criterion evidence in each `options/<id>.md`. Several
  qualifying options is a normal, good outcome: they are **unranked by design**, because qualification is
  pass/fail and weighing them is `decide-cycle`'s job. Present the trade-offs and let the user choose —
  and if they then want them ranked, that is a `decide-cycle` run over this option set, not a re-run here.
  Read the latest `acceptance-review-rN.md` alongside it: any defect the critic found *in the
  determination* is recorded there and nowhere else (it deliberately does not change `agree` — a malformed
  determination is not an open search).
- **`no qualifying option exists (verified)`** — this is a real answer, not a failure. Relay the
  determination and the ledger, and take the criterion it names to the user: **relaxing one criterion is
  the only thing that changes this result.** **Lead with the near misses** when `nearMisses` is non-zero:
  each failed exactly one criterion, so they are precisely what relaxing a criterion would make available,
  and some are worth doing on their own merits even though they do not qualify. Do not re-run unchanged.
- **`not exhaustive`** — say so plainly. Options found so far may be fine, but **do not present them as a
  complete answer**. `DETERMINATION.md` exists here too, written on the final round and labelled a partial
  result — relay it *with that caveat attached*, never on its own. Re-invoke with the same `runId` (and a
  higher `maxRounds`) to continue from the ledger.
- **`BLOCKED`** — read `NEEDS-USER.md`, resolve with the user (usually by editing the criteria), re-invoke.
- Always offer `DISQUALIFIED.md`. What was ruled out and why is often the most useful artifact in the run,
  and it is what makes a later re-run cheap.

## 8. Resume

Preserve `runs/<runId>/` and re-invoke `phase:"run"` with the same args. The ledger means the search
**continues** rather than restarting — a fresh investigator reads what is already closed and does not
re-walk it. Halts to resolve first: a `needs_user` escalation, or a token-budget stop (nothing to resolve
there, just re-invoke).

The run can also stop by **throwing**: any of the three agents returned nothing. Re-invoke with the same
args/`runId` and pass the `Workflow` tool's `resumeFromRunId` to replay completed agents from cache.

## 9. Args reference

Full schema + defaults: the Config block atop `investigate-cycle.mjs` (the canonical source). Pass `args`
inline.
- **Required:** `runId` · `root` (§3) · `criteria` (inline) **or** `planPath` (absolute path to the
  criteria file).
- **Optional:** `phase` (`refine` | `run`, default `run`) · `sources` (starting avenues — §3) · `context`
  (domain facts) · `testbed` (how to check a candidate empirically) · `target.repo` (absolute, read-only) ·
  `target.lang`/`target.framework` (hints) · `maxRounds` (5; **throws** below 1 or non-numeric — it used
  to coerce, and a NaN bound silently produced a zero-round run reported as an ordinary round-budget
  exit) ·
  `minRoundBudget` (100k) · `models` (per-role tier: criteria/investigate/critique; all opus) ·
  `agentTypes` (custom subagent per role — must exist in your registry) · `stateDir` (override
  `runs/<runId>`).

## 10. State files (`runs/<runId>/`, gitignored)

- `options/<id>.md` — one per qualifying option: per-criterion evidence with citations, what it buys, what
  it costs, sources.
- `DISQUALIFIED.md` — the append-only ledger: one terse line per rejected candidate naming the criterion it
  fails, with `NEAR-MISS: ` prefixing the ones that failed exactly one. **This is the search's memory** and
  the reason each round diverges from the last.
- `acceptance-review-rN.md` — the critic's findings for round N: per-option verdicts, near-miss
  corrections, any contested termination claim, and any defect in the determination. Sparse by design: a
  round with nothing to check produces none.
- `DETERMINATION.md` — the run's product file, in the fixed shape of §6, linking to `options/<id>.md`
  rather than restating them (#11). Written on a terminating round **and** on the last round the budget
  allows (labelled a partial result). **The return names it only where the run ENDED in one of those two
  states** — which is narrower than where one was written: a run that claims termination in round 1, gets
  contested, then stops on the token budget has a real (stale) determination on disk that `determination`
  does not name, and so does a last round that escalated instead of concluding. That gap is deliberate,
  and it errs the safe way: the field never names a file nothing wrote. When a run halts, look in
  `stateDir` before assuming there is nothing there.
- `NEEDS-USER.md` — escalations; on a verified no-solution, which criterion the user might relax.

Report when done: the terminal state **first**, the qualifying options, `nearMisses` if non-zero, where the
determination and ledger are, and what was ruled out. **Nothing is staged or committed.**
