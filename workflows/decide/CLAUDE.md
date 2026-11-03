# decide-cycle — operator guide (for Claude)

`decide-cycle.mjs` drives the AI to a **justified, ranked conclusion** among approaches. A bounded **chain
of investigators** runs one at a time: the opening investigator finds the options, and each challenger reads
every earlier file and must beat or improve it. One **decider** then ranks every option in one weighted
matrix, and one **final reviewer** verifies the ranking against the sources and corrects each error it can
prove. No stage loops back, so the run starts at most `maxInvestigators + 2` agents. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`. A *convergence* workflow: it honors the core (#1–4, #6, #8,
#11–19). It produces a conclusion, **not code**: nothing is staged or committed.

## 1. Scope (check FIRST)

Right size: one real decision with **genuine trade-offs**, such as an architecture or pattern choice, a
build-vs-buy, or a data-model or algorithm selection. Too small (one obvious answer, or a reversible
coin-flip) → just decide and move on. Want open-ended creative options for a *human* to pick with no AI
verdict → **`brainstorm-cycle`**. Want to *build* a pick → a plan file built by **`develop-cycle`**.

**Believe the answer already EXISTS and just needs finding → `investigate-cycle`.** That is the adjacent
workflow most often reached for by mistake. Decide *generates* options and weighs them. Investigate
*searches* for something that already exists and qualifies it against pass/fail criteria, keeping a ledger of
what failed so each round diverges, until it can evidence nothing was left unsearched. The tell is your
requirements: if you want to trade criterion A off against criterion B, you want the weighted matrix here. If
missing A is simply disqualifying, you want investigate.

The output is always a **ranked list**. Rank 1 is the top answer, and the user may combine the entries the
ranking marks as combinable.

## 2. The flow

```
rubric file (written in plan mode, approved by the user: the one human gate)
  -> Investigate: serial, at most maxInvestigators agents
       opening investigator (investigate i1) writes investigations/i1.md
       challenger k (investigate i<k>, k = 2 .. maxInvestigators) reads the rubric and every earlier
         investigation file, writes investigations/i<k>.md, returns contributed true or false
       the chain stops at the first challenger that returns contributed false (dry),
         or after maxInvestigators agents (cap)
  -> Decide: one decider reads every investigation file, writes decision.md
  -> Review: one final reviewer verifies decision.md, corrects it in place, writes review.md
  -> return
```

Every agent writes only its own file and the scripts it saves under `scripts/`, apart from the final
reviewer, which also corrects `decision.md` in place and logs each correction under `review.md`'s
`## Edits`. The investigation files, `decision.md`'s `## Changes to investigation facts` section and
`review.md` together are the run's edit log.

The steps:

1. **Author the rubric in `EnterPlanMode`** (§4). It is the fixed ground every agent judges against.
   `AskUserQuestion` for anything ambiguous: getting the rubric right is the whole game.
2. **`ExitPlanMode`**: the user approves (the human gate).
3. **Launch from a notification turn** (root `CLAUDE.md`, "Launch from a notification turn"). The opening
   investigator says whether its context holds a relayed user request, and the engine throws before any
   later agent when it does. `Workflow` loads by path: `scriptPath` = absolute path to `decide-cycle.mjs`,
   plus the args (§8). No mid-run questions.
4. **Present** the result: follow the return's `nextStep`.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` (required):** the absolute base run-state hangs off (this checkout, or, from the installed aipg
  plugin, the persistent data dir the skill resolves, never the version-swapped install dir).
- **`planPath` (required):** the absolute path to the rubric file (§4). There is no inline `requirements`
  arg. A rubric written without plan mode goes to `plans/<runId>/` under `root` first.
- **`target.repo` (optional):** pass it for a decision about existing code. Every agent reads it
  **read-only** for pattern-fit and feasibility, and the engine never modifies it.
- **`testbed` (optional):** how agents may **empirically test** claims, such as a sqlite db and how to query
  it, or a script to benchmark against. Every agent is told to prefer measured evidence and cite the command
  and result (#14), and the final reviewer reruns each testbed command the cells it verifies rest on (§5).
  Set it up read-only by construction (e.g. `sqlite3 "file:path.db?mode=ro"`, or a copy), and
  **pre-allowlist the commands** in the target project's settings, since a background run cannot answer
  permission prompts.

## 4. Rubric shape (you write it, and agents read it VERBATIM, #2)

Plain markdown. The engine does **not** parse it. Keep it tight: this is the rubric, not an essay.

```markdown
## Decision
One line: the choice to be made.

## Non-negotiables   # musts: pass/fail. An option that fails one is ruled out, never ranked
- e.g. "must run in the existing Node 20 runtime", "no new paid dependency", "p99 < 50ms".

## Weighted criteria  # wants: what "best" means + how much each matters (weights need not sum to 100)
- p99 latency under 20ms (weight 3)
- one service to operate, not two (weight 3)
- ...

## Context
Domain facts the agents will not infer, and what is in or out of scope.
- Evidence: <path or URL> holds <one line saying what it holds>
```

State each criterion as an **absolute target**, since agents score what an option achieves against it, never
its change from the current state. Under the context, list each evidence path the agents should read, with
one line saying what it holds. State each non-negotiable's **depth**: the paths and inputs it covers. Where
the rubric states none, agents judge it on the **default path**, which holds normal use, another program's
edit and a failure such as an outage. A path the rubric lists as a scenario or requires, such as a human
commit, a revert or a manual apply path, is on the default path. A breach reachable only through operator
action is a con, so a rubric that wants it judged names it under a weighted criterion.

## 5. Roles (in the engine)

The JS conductor sequences `agent()` calls, passing only paths and counts (#1). Each agent is fresh, and
every role defaults to opus at effort `high`.

**The rubric rules** every prompt states through one constant: a must is pass/fail. A want scores **met**,
**partly met** or **missed**, each with cited evidence, and the weighted total counts met as full weight,
partly met as half and missed as zero. A want scores met only on a cited source or a measurement, and own
judgment scores at most partly met. Each want is scored on what the option achieves, never on its change from
the current state, and a **do-nothing** option is scored on the same rubric whenever not acting is possible.
The simplest option that meets every requirement is preferred. Each claim cites its original source. A
measurement cites its exact command and result, and any script it ran is saved under `scripts/` with a file
name no file there holds yet, never changing a script already there, so a later agent can rerun it. A
design of software or a process is tested against five hostile inputs: a failure, a concurrent edit, a
human-set value, state saved before the change, and an edit by another program that no scan has seen yet. A
defect found that way is a con of the option, or, for a challenger, a contribution when it also fixes it.

- **Opening investigator** (`investigate i1`) searches the web, and the codebase when `target.repo` is
  passed, for the options and writes `investigations/i1.md`: `## Options` (each under a run-wide id O1, O2
  and so on, with what would be built or done, its pros and its cons, each naming the must or criterion it
  bears on and its source), `## Leader assumptions`, `## Standing` (every option in order, with the criteria
  that place it there) and `## Searched` (each direction that yielded no option, with why). It returns
  `wrote_file` and `relayed_request`.
- **Challenger k** (`investigate i<k>`) reads the rubric and every earlier investigation file in order. It
  first rejects one assumption under the latest file's `## Leader assumptions` and searches for an option
  that does better without it, then tries to improve any option under the contribution rule (§6). It writes
  `investigations/i<k>.md`: `## Contributions` (each under an id C<k>.<n>, with its kind, the option id it
  targets or the next free one, what changes, its pros and cons, and the earlier statement it corrects, or
  `None.`), `## Leader assumptions`, `## Standing` and `## Searched`. It never repeats an earlier contribution
  and never edits an earlier file. It returns `wrote_file` and `contributed`.
- **Decider** (`decide`) reads the rubric and every investigation file, and may search to fill a gap. It
  scores every option, every combination it builds and the do-nothing option in one matrix, each cell citing
  its source or marked own judgment, and writes `decision.md`: `## Ranking` (every option that passes every
  must, best first, each with its total and its `combines with` and `excludes` ranks), `## Options`,
  `## Matrix`, `## Flip check` (the smallest change to one cell or weight that swaps rank 1 and rank 2,
  graded **dominant**, **robust** or **fragile**), `## Ruled out` (each option that fails a must, with the
  evidence and the one observation that would reverse it, #16), `## Changes to investigation facts` and
  `## Checks for the user` (each question no agent can settle, with the result that would change the
  ranking). **The tie rule:** down the list sorted by total, the options within 5% of the sum of the weights
  of the highest total left form a tie group, ranked simplest first. The margin is a share of the weights,
  since they have no fixed scale. Every option of the investigation files is ranked or ruled out.
  It returns `wrote_file`, the `ranking` index (`rank`, `title`, `combines_with`, `excludes`), `flip` and
  `user_checks`.
- **Final reviewer** (`review`) reads the rubric, every investigation file and `decision.md`. It opens the
  source behind every cell of the three top-ranked options, every must judgment of every ranked option and
  the evidence of every `## Ruled out` entry, reruns each saved script and testbed command those cells rest
  on, and samples the rest. It recomputes every total and checks the order, the tie rule, that every option
  is ranked or ruled out, and that the `combines with` and `excludes` claims agree. It fixes in `decision.md`
  each error a source, a rerun or the arithmetic proves, which includes moving a ranked option that fails a
  must to `## Ruled out` and ranking a ruled-out option whose failing must a source disproves. It changes no
  judgment it cannot prove wrong. An edit that moves a ranked option updates every `combines with` and
  `excludes` rank naming it. When an edit changes rank 1 or rank 2, or a cell, weight or total either one
  rests on, it redoes `## Flip check`. It writes `review.md`: `## Edits` (one line per edit: the
  section, the text before and after, and the evidence) and `## Flags` (each score or order it would judge
  differently with no proven error, with its reason). It returns `wrote_file`, `edits`, `flags`, and the
  `ranking` index and `flip` grade after its edits.

## 6. Contribution and stop rules (keep intact)

- **A contribution** is a change, inside the rubric's scope, to what would be built or done: a new option,
  a feature added to an option, a feature removed for a stated reason (overkill, or an edge case too unlikely
  to justify its cost), or a correction of an error in an earlier file. It makes the option better on at
  least one weighted criterion or on a plain measure the rubric does not name, such as simpler, faster or
  more robust where robustness is needed, and it cites its evidence. No size threshold applies. It targets
  one of the three leading options of the latest standing (every option when fewer stand), unless it names
  the shortcoming that holds a lower option down and gives evidence that the contribution resolves it.
- **The early stop.** `contributed` false is valid only with a `## Contributions` section that reads `None.`
  and a `## Searched` section that holds a replacement attempt and an improvement attempt for each of the
  three leading options (every option when fewer stand), each with the reason it adds nothing. The engine
  stops the chain at the first challenger that returns `contributed` false (`dry`), or after
  `maxInvestigators` agents (`cap`), and the decider runs either way. Only an explicit false stops it.
- **Every agent is on the critical path**, since the next agent reads its file. An agent that returns nothing
  throws. An agent whose `wrote_file` is not true halts the run on
  `BLOCKED (an agent did not confirm writing its file)` before any later agent, with `haltReason` naming the
  file.
- **No code, no git.** Decide produces files only. A pick feeds a plan file's design section, which
  `develop-cycle` builds next.

## 7. Terminals and resume

An unhalted run ends on one of three:

- `decided (the final reviewer made no edit and raised no flag)`
- `decided with corrections (the final reviewer made <n> edits)`
- `decided with flags (the final reviewer flags <n> judgment calls for the user)`, which takes precedence over
  corrections.

There is no needs-attention terminal and no `NEEDS-USER.md`, since no stage loops: a question only the user
can settle goes under `## Checks for the user`.

**Resume.** The engine keeps no state across invocations. For a thrown dead agent, relaunch with the same args
and `runId` plus the `Workflow` tool's `resumeFromRunId`, so the finished agents replay from cache. For an
unattested write, check the file `haltReason` names, then relaunch with the same args and no
`resumeFromRunId`, since a resume replays the cached return and halts the same way. A same-runId relaunch
reruns the chain from the opening investigator and replaces each file it reaches, and it leaves an earlier
launch's higher-numbered investigation files and its `scripts/` files in place. Starting over takes a new
runId, so the earlier run's files stay intact. Never clear `runs/<runId>/`. Relay the return's
`decisionFile` and `investigationFiles`, never a listing of the folder.

## 8. Args reference

Full schema + defaults: the Config block atop `decide-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `planPath` (absolute path to the rubric file).
- **Optional:** `maxInvestigators` (default 4, from 1 to 10, the most investigators the chain runs.
  It **throws** outside that range or on a non-number) · `context` (extra framing / domain facts) ·
  `testbed` (§3) · `target.repo` (absolute, read-only context) · `target.lang`/`target.framework`
  (hints) · `stateDir` (override `runs/<runId>`) · `models`/`efforts` (each maps a role key to a value.
  The role keys are `investigate`, `decide` and `review`. A model is `opus | sonnet | haiku | fable` and
  an effort is `low | medium | high | xhigh | max`. Every role defaults to opus at `high`. The engine
  **throws** at launch, naming the arg, on a value that is not an object, a key outside the role keys, the
  retired `research`, `check` and `analyst` included, and a value outside its set. Choose each role's model
  by the task and how much judgment the role needs, as the develop guide §3 says. One launch log line names
  each role's model and effort and the most agents the run starts) · `agentTypes` (custom subagent per
  role, which must exist in your registry. It takes the same role keys and **throws** on a value that is
  not an object, a key outside the role keys and a blank name).
- **Retired:** `lenses`, `checkTool`, `selection`, `shortlist`, `maxRounds`, `maxResearchRounds` and
  `maxResearchers` each **throw** at launch with a message that names the arg and says what replaced it.
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for the
  agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and outside
  `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of this
  checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt then ends
  with an instruction to append the survey's answers to its own file in `dir`. A `notes` arg without both
  paths **throws**. Once the run ends, run `node <survey's folder>/survey.mjs <dir>` and report the themes
  of the `SURVEY.md` it writes to the user.

## 9. State files and return (`runs/<runId>/`, outside every repo)

- `investigations/i<k>.md`: investigator k's file (§5).
- `scripts/`: every script a measurement ran, so a later agent can rerun it.
- `decision.md`: the decider's ranking, options, matrix, flip check, ruled-out options, changes to
  investigation facts and checks for the user, with the final reviewer's corrections in place.
- `review.md`: the final reviewer's `## Edits` and `## Flags`.

The return carries `runId`, `status`, `halted`, `haltReason`, `chosen` (rank 1's title), `ranking` (the
reviewer's index when it attested its file, else the decider's), `flip` (`dominant`, `robust` or `fragile`,
from the same agent as `ranking`, or empty when that agent returned none of the three), `investigators`
(`{ ran, stop }`, where `stop` is `dry`, `cap`, or empty when the run halted inside the chain), `agents`
(the agents started per phase), `userChecks`, `edits`, `flags`, `stateDir`, `decisionFile`, `reviewFile`,
`investigationFiles`, `failed` (always an empty array, since no agent is auxiliary) and `nextStep`.
`decisionFile`, `reviewFile` and `investigationFiles` name only files whose writer attested. `nextStep` says
to present the ranking with the review's edits and flags, adds the flip check when the grade is fragile and
the checks for the user when there are any, and says how a pick is built. When no option passes every must,
it says to present `## Ruled out` and refine the rubric.
