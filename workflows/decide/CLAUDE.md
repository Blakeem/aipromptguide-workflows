# decide-cycle — operator guide (for Claude)

`decide-cycle.mjs` drives the AI to a **justified conclusion** among approaches: it **diverges** into one
lensed analyst per perspective (each finds + scores the best option through its lens), then **converges**
via a **decider** that builds a global weighted decision matrix pulling in the best of each, gated by
**non-blind adversarial reviewers** — looped until no reviewer holds a blocking gap against fixed
requirements. Built to `../../principles/WORKFLOW-PRINCIPLES.md`. A *convergence* workflow: it honors the
core (#1–4, #6, #8, #11–19) and runs a review loop in the **spirit of #5 but non-blind by design** — the
reviewers must see the decision and the rubric to judge them (#3 guards code-regression anchoring, not argument
evaluation). It produces a conclusion, **not code**: nothing is staged or committed.

## 1. Scope (check FIRST)

Right size: one real decision with **genuine trade-offs** worth weighing from several perspectives
(≥2 lenses) — an architecture/pattern choice, a build-vs-buy, a data-model or algorithm selection. Too
small (one obvious answer, or a reversible coin-flip) → just decide and move on. Want open-ended creative
options for a *human* to pick with no AI verdict → **`brainstorm-cycle`**. Want to *build* the chosen
approach → a plan file built by **`develop-cycle`**.

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

Launch every run from a notification turn (root `CLAUDE.md`, "Launch from a notification turn").
Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `decide-cycle.mjs` + args.
No mid-run questions — settle the rubric with the user first:

1. **Author the requirements in `EnterPlanMode`.** This is the **fixed rubric** the decider and the
   reviewers judge against — and the anti-spin ground that makes the loop converge. Capture (§4): the
   decision to be made, the **non-negotiable constraints** (pass/fail), and the **weighted criteria**
   (what "best" means, and how much each axis matters). `AskUserQuestion` for anything ambiguous —
   getting the rubric right is the whole game.
2. **`ExitPlanMode`** — user approves (the human gate).
3. **Pick the lenses** with the user — the evaluation perspectives, one analyst each (e.g. `efficiency`,
   `simplest`, `robustness`, `best-practice`, `risk`, `ux`). Propose them if the user has none. Distinct
   lenses surface distinct options; that spread is what the decider then balances.
4. **Run** the engine (`planPath` = the plan-mode file's **absolute** path, plus `lenses`). It diverges
   (analysts) then converges (decider ⇄ reviewers) and returns the chosen conclusion + the file trail.
5. **Present** the result: follow the return's `nextStep`. It names the terminal state, the files to
   show and every caveat.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (this checkout — or, from the installed
  aipg plugin, the persistent data dir the skill resolves, never the version-swapped install dir).
- **`planPath` REQUIRED:** the absolute path to the rubric file (§4). There is no inline `requirements`
  arg. A rubric written without plan mode goes to `plans/<runId>/` under `root` first.
- **`lenses` — REQUIRED:** the perspectives from §2 (strings or `{ id, focus }`); ids that collide after
  slugging throw, since two analysts would write the same `lenses/<lens>.md`.
- **`target.repo` (optional):** pass it for a decision about existing code — all three roles (analysts,
  decider, reviewers) read it **read-only** for pattern-fit and feasibility; the engine never modifies it.
- **`testbed` (optional):** how agents may **empirically test** claims (e.g. a sqlite db + how to query
  it, a script to benchmark against). All three roles are told to prefer measured evidence — run the
  check, cite command + result (#14) — and the `choice` reviewer (`order` in `ranked` mode) re-runs each
  testbed command behind a matrix cell that moves the outcome. Set it up
  read-only by construction (e.g. `sqlite3 "file:path.db?mode=ro"`, or a copy), and **pre-allowlist the
  commands** in the target project's settings — a background run can't answer permission prompts
  unattended.
- **Relaunch vs. new run.** The engine keeps no state across invocations. A same-runId relaunch with no
  `resumeFromRunId` re-runs the run from Diverge and round 1. It overwrites the lens files and the round
  files it reaches, and it leaves an earlier run's higher-numbered round files in place. Extending
  finished rounds is a relaunch with `maxRounds` raised plus the Workflow tool's `resumeFromRunId`, which
  replays the finished agents from cache. Starting over takes a new runId, so the earlier run's files
  stay intact. Never clear `runs/<runId>/`. `NEEDS-USER.md` is cumulative. Relay the return's
  `decisionFile`, never the highest-numbered file.

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

State each non-negotiable's **depth**: the paths and inputs it covers. Where the rubric states none, the
engine judges it on the **default path**, which holds normal use, another program's edit and a failure
such as an outage. A path the rubric lists as a scenario or requires, such as a human commit, a revert or
a manual apply path, is on the default path. A breach reachable only through operator action is a
caveat, so a rubric that wants it judged names it under a weighted criterion.

## 5. Roles (in the engine)

The JS conductor sequences `agent()` calls, passing only paths + verdicts (#1). Each agent is fresh.

- **Analyst** (analyst · sonnet) — one per lens; reads the requirements + its lens, generates 2–4
  scored options, recommends one, notes keep-worthy elements, writes `lenses/<lens>.md`. It cites a
  file:line, a measurement, a source URL or "own judgment" for each factual claim.
- **Decider** (decide · opus) — reads the requirements + every lens file (+ every review file of the
  previous round); consolidates options, may build a hybrid, scores a **global weighted matrix**
  (non-negotiables forced to 0, **every cell citing its lens evidence or marked "own judgment,
  low-confidence"**, #14), cites for **each option it rules out** what rules it out and the one
  observation that would reverse that, picks the winner with why-not-others, writes `decision-rN.md`.
  The file holds a **`## Trade-off`** section (the winner against the runner-up, one row per criterion
  where they differ, as weight × score gap: what the winner gains and gives up) and a **`## Flip check`**
  section (the smallest single change to one cell or weight that changes the winner, plus the joint
  effect of moving every low-confidence cell by its uncertainty). It grades the choice **dominant**
  (gives up nothing), **robust** (the smallest flip is larger than the uncertainty of the input it moves)
  or **fragile** (it is not), and returns the grade as `flip`. From round 2 it revises its prior
  decision into a complete new file under fixed **fold rules**: it confirms each blocking gap's evidence
  against its source and treats the gap's smallest change as a hint; a confirmed gap gets the smallest
  fold that closes it, a refuted one a rebuttal under `## Rebuttals` with evidence, and one it can
  neither confirm nor refute goes under `## Rebuttals` marked unverified, with the check that would
  settle it; it may fold a caveat whose fix is one
  sentence and leaves every other caveat to the review files; it tests each fold against one hostile
  input of each kind it touches (a failure, a concurrent edit, a human-set value, state saved before the
  change, an edit by another program that no scan has seen yet); a fold that repairs one option against
  a defect another option shares repairs that option the same way and keeps it scored; it never adds a
  repaired variant as a new rival, but an option a reviewer raised as missed in two rounds goes into
  the matrix, scored; and it changes nothing a gap does not name. Escalates a user-only call to
  `NEEDS-USER.md` (halts on a hard blocker) — **and so may a reviewer**, for a requirement contradiction
  (§7); those are two distinct halt paths, not one. In `ranked` mode it instead ranks the strongest
  options (up to `shortlist`), each with what it **buys**, what it **costs**, its rank rationale, plus a
  **combine / exclude** section and a flip check over each adjacent pair, graded on rank 1 (no
  trade-off section) — an option violating a non-negotiable is off the list entirely, and it is told
  not to pad.
- **Reviewers** (review · opus) — **non-blind, adversarial**; each reads the decision + requirements +
  lens files. **Round 1** runs three **focused reviewers** in parallel, each writing
  `decision-review-r1-<focus>.md`. In `single` mode the focuses are `choice` (verifies every matrix
  citation against its lens file (#14), re-derives the totals, the trade-off and the flip check,
  re-checks the cited source behind each cell that moves the outcome and re-runs each testbed command
  such a cell rests on, and hunts a missed option or a strawmanned runner-up), `requirements` (every
  non-negotiable path by path, every criterion) and `design` (does the specified design work as written
  on every input the rubric accepts). In `ranked` mode they are `order` (the matrix and the order, with
  the same source re-check), `requirements` and `combine`
  (the combine/exclude claims — two options sold as combinable that actually conflict is the most
  damaging error the list can carry). Only the `choice` and `order` reviewers re-derive the matrix.
  **Round 2 and later** run one **verifier** that reads every review file of the previous round, checks
  each blocking gap was closed or rebutted with evidence that holds, keeps a gap the decider marked
  unverified blocking unless the check it names refutes it, judges every changed or added
  passage in full, re-derives the totals, the trade-off (in `ranked` mode, the order) and the flip check,
  blocks only on a non-negotiable violation in unchanged text, lists only new caveats, and writes
  `decision-review-rN.md`.
  **Severity.** Every gap is **blocking** or a **caveat**, and every gap carries its evidence. A gap
  blocks only when it is a non-negotiable violation (judged at the depth the rubric states, else on the
  default path, §4), a correctness defect in the design, a wrong choice (the reviewer's evidenced
  corrections, applied together, change the winner, or in `ranked` mode swap an adjacent pair, by more
  than the uncertainty of the moved cells) or a missed option that beats the winner by more than that
  uncertainty. The first two judge the winner (in `ranked` mode, each listed option) on its own, so a
  defect the runner-up shares, or one with no measured instance on an input the rubric accepts, still
  blocks. Every other real gap is a caveat, and a caveat
  never blocks. Each review writes `## Blocking` and `## Caveats` sections, returns blocking slugs in
  `gap_ids` and caveat slugs in `caveat_ids`, and agrees exactly when its Blocking section is empty. From
  round 2 the verifier is handed the earlier rounds' blocking slugs and reuses one, or the slug of a
  caveat in a review file it is handed, when re-raising the same issue, which is what makes repeated-vs-new measurable (§6). From round 3 it is also handed every
  earlier review file that holds a counted caveat and that the previous round did not write, so it
  lists no caveat that is already on record. On the **last** round
  a non-agreeing review ends with a **WHERE NEXT** section: whether the open blocking gaps sit in text
  the latest revision changed (the folds open new defects) or in a requirement the rubric does not
  settle, and for a requirement the one change that would let a decision converge. A final verifier
  (round 2 or later) first walks every non-negotiable over the entire design, unchanged text included.

## 6. Loop & contracts (keep intact)

`diverge (once) → [decide → review]×N`, up to `maxRounds` (default 3). Each non-agreeing round hands
the decider every review file of that round next round; the decider revises rather than restarting.

- **The requirements file is the fixed rubric and the anti-spin ground.** The decider and the reviewers
  judge against it, so the loop converges; there is no `DISMISSED.md` (the reviewers aren't
  blind-reviewing a diff, they check one conclusion against fixed requirements). If it won't converge,
  **`gapRounds` on the return says which failure it is** — `[{ round, gaps, new, repeated, caveats }]`,
  one entry per review round, where `gaps`, `new` and `repeated` count blocking gaps and `caveats`
  counts the round's caveats. Mostly *repeated* blocking gaps: the decider is not resolving objections
  it already has, and another round buys the same review. Mostly *new* ones: either the folds open new
  defects or the rubric is under-specified, so each round finds fresh ground — the final review's
  WHERE NEXT says which, and a rubric gap is fixed by refining the rubric rather than raising
  `maxRounds`. The hand-back names whichever it is when the last review ran in round 2 or later, names
  the review file that first raised each repeated gap, and points at the WHERE NEXT section of each
  review that did not agree. A run of one round gets no diagnosis, since the decider had no round to
  address a gap.
- **Non-blind is deliberate (#3/#5).** The reviewers must see the decision and rubric; never make them
  blind. Round-1 reviewers judge fresh. The verifier reads the previous round's reviews, because its job
  is to check the folds the decider made for them.
- **Agreement means no blocking gap.** The loop ends when every reviewer agrees. A caveat never blocks:
  caveats reach the plan through the return (`caveats`, `caveatFiles`) and the status
  `decided with caveats (no blocking gap, and the reviews list caveats for the plan)`, whose `nextStep`
  says to carry them into the plan's design section.
- **`selection` shapes the deliverable, not the rigor.** `single` (default) → one winner + why-not-each
  runner-up. `ranked` → an ordered shortlist (≤ `shortlist`, default 5, floor 2) where every listed
  option must satisfy every non-negotiable — a violator is excluded, never ranked last — and each
  carries explicit `combines_with` / `excludes` notes, because a shortlist the user can't safely mix is
  a trap. Both modes run the same matrix, citation rule, and review loop.
- **No code, no git.** Decide produces files only; it never stages or commits. The conclusion feeds
  a plan file's design section, which `develop-cycle` builds next.
- **Thin returns (#8).** Schemas carry only `chosen` / `meets_all_requirements` / `flip` / `agree` /
  `gap_ids` / `caveat_ids` / counts, a `wrote_file` write confirmation per role — plus, in `ranked` mode, the shortlist **index** (rank + title +
  `combines_with`/`excludes`); the matrices, buys/costs, and reasoning live in the files. An analyst
  whose `wrote_file` is not true is dropped: a `✗` in the log, listed in `failed`, left out of the
  decision, and the run throws when no analyst confirms (§7). An unconfirmed decider or reviewer write
  halts the run on `BLOCKED (an agent did not confirm writing its file)` (§7), unless that agent
  escalated, because the next agent and the return would otherwise name a path a stale file can hold.

## 7. Resume

Two halts. The decider or a reviewer writes a user-only call to `NEEDS-USER.md`
(`BLOCKED (needs user input)`), or it does not confirm writing its file (`BLOCKED (an agent did not
confirm writing its file)`). For an escalation, read `NEEDS-USER.md`, resolve it with the user
(usually by editing the requirements file), then relaunch with the same args and no `resumeFromRunId`.
A `resumeFromRunId` replay sends the same prompts, which name the requirements file by path, so it
replays the cached returns and halts the same way. The relaunch re-runs the run from Diverge and round 1
(§3). For an unattested write, check the file `haltReason` names, then relaunch the same way: a resume
replays the cached return and halts the same way.

A `needs-attention` run takes one of two relaunches. After refining the requirements, relaunch with the
same args and no `resumeFromRunId`, since a resume would never read the edit. After raising `maxRounds`,
relaunch with `resumeFromRunId`, so the finished rounds replay from cache and the loop continues past them.

The run can also stop by **throwing**. If no analyst produced a lens file, check the requirements and
lenses and re-run without `resumeFromRunId`. If the decider or a reviewer returned nothing (agent skipped
or died), re-invoke with the same args/`runId` and pass the `Workflow` tool's `resumeFromRunId` to
replay completed agents from cache, as the thrown message says.

## 8. Args reference

Full schema + defaults: the Config block atop `decide-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `lenses` (array of ≥2 perspectives, distinct ids — both
  enforced) · `planPath` (absolute path to the rubric file).
- **Optional:** `selection` (`"single"` default | `"ranked"` — §1/§6; anything else throws) ·
  `shortlist` (ranked only: how many options to carry, default 5; **throws** below 2 or non-numeric) ·
  `context` (extra framing / domain facts) · `testbed` (how to empirically test claims —
  §3) · `target.repo` (absolute, read-only context) ·
  `target.lang`/`target.framework` (hints) · `maxRounds` (3; **throws** below 1 or non-numeric — it used
  to coerce, and a NaN bound silently produced a zero-round run reported as an ordinary result) ·
  `models`/`efforts` (`models` and `efforts` map a role key to a value. The role keys are `analyst`,
  `decide` and `review`. A model is `opus | sonnet | haiku | fable` and an effort is
  `low | medium | high | xhigh | max`. The analyst role defaults to sonnet, the decide and review
  roles default to opus, and every role defaults to `high`. The engine **throws** at launch, naming
  the arg, on a value that is not an object, a key outside the role keys, and a value outside its
  set. Choose each role's model by the task and how much judgment the role needs, as the develop guide §3 says. One
  launch log line names each role's model and effort) · `agentTypes` (custom subagent per role — must exist
  in your registry) · `stateDir` (override `runs/<runId>`).
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for
  the agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and
  outside `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of
  this checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt
  then ends with an instruction to append the survey's answers to its own file in `dir`.
  A `notes` arg without both paths **throws**. Once the run ends, run `node <survey's folder>/survey.mjs <dir>`
  and report the themes of the `SURVEY.md` it writes to the user.

## 9. State files (`runs/<runId>/`, outside every repo)

- `lenses/<lens>.md` — each analyst's options + lens scores + recommendation.
- `decision-rN.md` — the decider's matrix + conclusion + why-not-others + trade-off + flip check for
  round N (in `ranked` mode: the matrix + the ranked options with buys/costs + the combine-vs-exclusive
  section + the flip check).
- `decision-review-r1-<focus>.md` — each round-1 focused reviewer's `## Blocking` and `## Caveats`
  sections.
- `decision-review-rN.md` for N of 2 or more — the verifier's `## Blocking` and `## Caveats` sections for
  round N.
- `NEEDS-USER.md` — user-only escalations; a hard blocker here halted the run.

The return carries the paths (`decisionFile` / `reviewFiles` / `needsUserFile`), each lens's top pick
(`lensPicks`), the lenses whose analyst did not confirm writing a lens file (a file may still exist on
disk) and so were left out of the decision (`failed`, one `{ id, stage: 'diverge' }` entry per lens),
the per-round gap split (`gapRounds`, §6), two agreement flags and `selection` as structured fields.
`reviewFiles` lists the latest round's review files. `decisionFile` and `reviewFiles` name only files
whose writer attested, so after a halt either can be empty or name an earlier round. A halt also returns
its `haltReason`. `flip` is the latest decision's grade (`dominant`, `robust` or `fragile`), or empty when
the decider returned none of the three. `caveats` counts the run's caveat slugs, and `caveatFiles` lists,
in round order, every review file whose reviewer returned a caveat that counted. A slug one reviewer
lists as blocking and another as a caveat counts as blocking only. An agreed run ends
`decided (decider + reviewers agree)` when it holds no caveat and
`decided with caveats (no blocking gap, and the reviews list caveats for the plan)` otherwise, and both
set `agreed`. On agreement `nextStep` carries a flip note for a fragile or dominant grade and a caveat
note naming `caveatFiles`. `contradicted` is true when a reviewer agreed while listing blocking gaps.
`meetsAllRequirements` is false when the latest decider reported that its conclusion, or a shortlisted
option, misses a requirement. An agreed run with either flag raised keeps its agreed status, and its
hand-back names the file to audit before presenting. In `ranked` mode the return adds the ordered `shortlist` index and `chosen` is the rank-1
option, both from the latest round only.
