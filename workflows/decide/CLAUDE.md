# decide-cycle — operator guide (for Claude)

`decide-cycle.mjs` drives the AI to a **justified, ranked conclusion** among approaches. A bounded **chain
of investigators** runs one at a time: the opening investigator finds the options, and each challenger reads
every earlier file and must beat or improve it. One **decider** then ranks every option in one weighted
matrix, and one **final reviewer** verifies the ranking against the sources and corrects each error it can
prove. No stage loops back, so the run starts at most `maxInvestigators + 2` agents. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`. A *convergence* workflow: it honors the core (#1–4, #6, #8,
#11–20). It produces a conclusion, **not code**: nothing is staged or committed.

## 0. Checklist

Work every step in order. Each step cites the section that holds its rule, and a step that opens with a
condition in parentheses runs only under it.

### Before the run

1. Check that the job is one decision with genuine trade-offs (§1). Output: that decision, or the other
   workflow §1 names for the job.
2. Author the rubric in `EnterPlanMode` in the shape of §4, asking the user with `AskUserQuestion` about
   anything ambiguous (§2 step 1, §4). Output: the rubric file.
3. Get the user's approval of the rubric with `ExitPlanMode` (§2 step 2). Output: the user's approval.
4. Choose the `runId` and `root` args (§3, §7, §8). Output: a value for each.
5. Set `planPath` to the rubric file's absolute path (§3). Output: the `planPath` value.
6. (for a decision about existing code) Set `target.repo` to that repo's absolute path (§3). Output: the
   `target.repo` value.
7. (when agents can test claims empirically) Set up the `testbed`, read-only by construction (§3). Output:
   the `testbed` value.
8. (when step 7 set a `testbed`) Pre-allowlist its commands in the target project's settings (§3). Output:
   an allow rule for each testbed command.
9. Choose the optional args the run needs: `maxInvestigators`, `context`, `target.lang`,
   `target.framework`, `stateDir`, `models`, `efforts`, `agentTypes` and, when the user wants the agents'
   feedback, `notes` (§8). Output: a value for each arg chosen.
10. Check that the `MEMORY.md` index this session loaded at its start, and each topic file it points to,
    holds no line on this run's plan or goal, and when one does, remove the line and launch from a new
    session. Then run `git -C <target.repo> status --short` (`node --version` when the run has no
    `target.repo`) with run_in_background, then end the turn (root `CLAUDE.md`, "Launch from a notification
    turn"). Output: the index checked, and that tool call is the last one of this turn.
11. In the turn the notification starts, call Workflow with `scriptPath` set to the absolute path of
    `decide-cycle.mjs` and the args steps 4 to 9 chose (§2 step 3, root `CLAUDE.md`, "Launch from a
    notification turn"). Output: the Workflow run id (`wf_...`).

### After the run

12. (when the run threw because an agent returned nothing) Relaunch through steps 10 and 11 with the same
    args and `runId` plus the Workflow tool's `resumeFromRunId`. Stop this pass of the list there, and work
    it again from step 12 once that run ends (§6, §7). Output: the resumed run's Workflow run id.
13. (when the run threw on a relayed user request) Relaunch through steps 10 and 11 with the same args and
    `runId` and no `resumeFromRunId`. Stop this pass of the list there, and work it again from step 12 once
    that run ends (§2 step 3, root `CLAUDE.md`, "Launch from a notification turn"). Output: the relaunch's
    Workflow run id.
14. (when `halted` is true) Check the file `haltReason` names (§6, §7). Output: that file's state, checked.
15. (when `halted` is true) Relaunch through steps 10 and 11 with the same args and no `resumeFromRunId`.
    Stop this pass of the list there, and work it again from step 12 once that run ends (§7). Output: the
    relaunch's Workflow run id.
16. (when `ranking` is empty, since no option passes every must) Present `## Ruled out` in `decision.md`
    (§5, the return's `nextStep`). Output: each ruled-out option presented with its evidence.
17. (when `ranking` is not empty) Present the ranking under `## Ranking` in `decision.md`. Rank 1 is the top
    answer, the user may combine the entries marked combinable, and a do-nothing rank 1 means not to act
    (§1, §2 step 4, the return's `nextStep`). Output: the ranking presented.
18. Present each edit under `## Edits` and every flag under `## Flags` in `review.md` (§5, the return's
    `nextStep`). Output: each edit and flag presented.
19. (when `flip` is `fragile`) Present `## Flip check` in `decision.md` and let the user settle the input
    rank 1 turns on (§5, the return's `nextStep`). Output: the user's answer.
20. (when `userChecks` is above 0) Present each check under `## Checks for the user` in `decision.md`, with
    what its result would change (§5, §7, the return's `nextStep`). Output: each check presented.
21. Name the return's `decisionFile` and `investigationFiles`, never a listing of the folder (§7). Output:
    those paths, told to the user.
22. (when `ranking` is empty) Refine the rubric with the user and relaunch through steps 2 to 11, editing
    the existing rubric file at step 2. Stop this pass of the list there, and work it again from step 12
    once that run ends (§7, the return's `nextStep`). Output: the relaunch's Workflow run id.
23. (when the user picks an option to build) Build it through `../develop/CLAUDE.md` §0 from its step 1
    through step 43, writing at its step 6 one plan file that holds a block per pick and, in each block,
    each defect under `## Defects` in `review.md` that names its pick, with the fix when the defect names
    one (§6, the return's `nextStep`). Output: develop §0 step 37's summary.
24. (when `notes` is set) Run `node <survey's folder>/survey.mjs <notes.dir>` and report the themes, for
    this run and for each develop run that step 23 launched with `notes` set (§8, `../develop/CLAUDE.md` §0
    step 44). Output: the themes of each `SURVEY.md` it writes.

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
  -> Review: one final reviewer hunts defects in the top options, verifies decision.md, corrects it in
       place, writes review.md
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

## Given options   # optional: each entry is an option the run must weigh
- <name>: <one line on what would be built or done>. Source: <path, when one exists>
```

State each criterion as an **absolute target**, since agents score what an option achieves against it, never
its change from the current state. State each want so that a source or a measurement can show it met, since
own judgment scores at most partly met. Under the context, list each evidence path the agents should read,
with one line saying what it holds. For a decision that moves, renames or removes files in a repo, list under
the context the tests, generators and tools that read those paths. State each non-negotiable's **depth**:
the paths and inputs it covers. Where the rubric states none, agents judge it on the **default path**, which
holds normal use, another program's edit and a failure such as an outage. A path the rubric lists as a
scenario or requires, such as a human commit, a revert or a manual apply path, is on the default path. A
breach reachable only through operator action is a con, so a rubric that wants it judged names it under a
weighted criterion.

## 5. Roles (in the engine)

The JS conductor sequences `agent()` calls, passing only paths and counts (#1). Each agent is fresh, and
every role defaults to opus at effort `high`.

**The rubric rules** every prompt states through one constant: a must is pass/fail. A want scores **met**,
**partly met** or **missed**, each with cited evidence, and the weighted total counts met as full weight,
partly met as half and missed as zero. A want scores met only on a cited source or a measurement, and own
judgment scores at most partly met. Each want is scored on what the option achieves, never on its change from
the current state, and a **do-nothing** option is scored on the same rubric whenever not acting is possible.
The simplest option that meets every requirement is preferred. The simplest option has the fewest parts to
run and maintain once it is in place (components, steps and rules), and the smaller build breaks a tie that
remains. Each claim cites its original source. A measurement cites its exact command and result, and any
script it ran is saved under `scripts/` with a file name no file there holds yet, never changing a script
already there, so a later agent can rerun it.
**The defect rule:** a defect is a concrete failure of an option as stated, which names the input or path
that triggers it, the step that fails and the wrong result, with its source or a trace through the option's
text. Every agent records each defect it finds in an option it reads, verifies or builds on, at the moment
it finds it, and an investigator also fixes it when a fix is within its reach. For a design of software or a
process the defect test is five hostile inputs: a failure, a concurrent edit, a human-set value, state saved
before the change, and an edit by another program that no scan has seen yet. A recorded defect holds until a
file fixes it, the file that records it included, so no agent treats the defective part as working or builds
on it.

- **Opening investigator** (`investigate i1`) searches the web, and the codebase when `target.repo` is
  passed, for the options and writes `investigations/i1.md`: `## Options` (each under a run-wide id O1, O2
  and so on, with what would be built or done, its pros and its cons, each naming the must or criterion it
  bears on and its source, each defect it finds and does not fix written as a con with its failure, and
  each defect it fixes written into the option's description with the failure the fix removes),
  `## Leader assumptions`, `## Standing` (every option in order, with the criteria that place it there) and
  `## Searched` (each direction that yielded no option, with why). Each entry under the rubric's
  `## Given options` is an option of `i1.md` under its own id, ahead of the options it finds. It returns
  `wrote_file` and `relayed_request`.
- **Challenger k** (`investigate i<k>`) reads the rubric and every earlier investigation file in order. It
  first rejects one assumption under the latest file's `## Leader assumptions` and searches for an option
  that does better without it, then tries to improve any option under the contribution rule (§6). It records
  each defect it comes across while it replaces, improves or verifies as a DEFECT contribution, and builds no
  contribution on a part a recorded defect names unless that contribution fixes it. It writes
  `investigations/i<k>.md`: `## Contributions` (each under an id C<k>.<n>, with its kind, the option id it
  targets or the next free one, the option ids under `also fits`, what changes, its pros and cons, and the
  earlier statement it corrects, or `None.`), `## Leader assumptions`, `## Standing` (with each recorded
  defect no file fixes yet weighed) and `## Searched`. It never repeats an earlier contribution and never
  edits an earlier file. It returns `wrote_file` and `contributed`.
- **Decider** (`decide`) reads the rubric and every investigation file, and may search to fill a gap. It
  builds no option and no combination, since the chain builds them. A contribution counts in the option it
  targets and in each option under its `also fits`. It scores every option the files hold and the do-nothing
  option in one matrix, each cell citing its source or marked own judgment, with each defect it finds, or that
  a file records and no file fixes, as a con of that option. A defect in a contribution is a con of every
  option that carries it, and one that breaks a must rules out each such option as stated. The decider writes
  the option without that contribution under `## Checks for the user`, with the check that would rank it. It
  writes `decision.md`: `## Ranking` (every option that passes every must, best first, each with its total and
  its `combines with` and `excludes` ranks), `## Options`, `## Matrix`, `## Flip check` (the smallest change
  to one cell or weight that swaps rank 1 and rank 2, graded **dominant**, **robust** or **fragile**),
  `## Ruled out` (each option that fails a must, with the evidence and the one observation that would reverse
  it, #16), `## Changes to investigation facts` and `## Checks for the user` (each question no agent can
  settle, with the check and the result that would change the ranking, each option the decider sends there,
  and each combination the files do not hold as an untested combination, with the option ids it would join,
  the check that would test it and the result that would change the ranking, never ranked). A `combines with`
  mark says only that two ranked options compose, and adds no check. **The tie rule:** down the list sorted by
  total, the options whose totals lie at most M below the highest total left, where M is 5% of the sum of
  every criterion's weight, form a tie group, ranked simplest first as the rubric rules define it. The margin
  is a share of the weights, since they have no fixed scale. Every option an investigation file gives an
  option id, under `## Options`, `## Contributions` or `## Searched`, is ranked or ruled out, and a candidate
  named without an option id is not an option. Each `## Given options` entry that no file gives an option id
  goes under `## Checks for the user` as a given option no agent weighed, with the check that would weigh it.
  It returns `wrote_file`, the `ranking` index (`rank`, `title`, `combines_with`, `excludes`), `flip` and
  `user_checks`.
- **Final reviewer** (`review`) reads the rubric, every investigation file and `decision.md`. It first hunts
  defects under the defect rule: it tests what would be built under each of the three top-ranked options,
  checks that the parts of a combination fit together, and checks each contribution of the last investigation
  file, or each option when that file is `i1.md`, since no later investigator read it. A defect it shows with
  a concrete failure cited to the option's text is an edit: a con under that option in `## Options` with the
  cells it bears on rescored, or a move to `## Ruled out` when it breaks a must. It never writes the fix into
  the option, since no agent would check a fix added after the chain. A defect in a contribution is a con of
  every option that carries it, and one that breaks a must rules out each such option as stated. The reviewer
  flags the option without that contribution. A defect it suspects and cannot show is a flag. Then it opens
  the source behind every cell of the three top-ranked options, every must judgment of every ranked option and
  the evidence of every `## Ruled out` entry, reruns each saved script and testbed command those cells rest
  on, and samples the rest. It recomputes every total and checks the order, the tie rule, that every option is
  ranked or ruled out, that each given option is an option or a check for the user, and that the
  `combines with` and `excludes` claims agree. It fixes in `decision.md` each error a source, a rerun or the
  arithmetic proves, which includes moving a ranked option that fails a must to `## Ruled out` and ranking a
  ruled-out option whose failing must a source disproves. It changes no judgment it cannot prove wrong. An
  edit that moves a ranked option updates every `combines with` and `excludes` rank naming it. When an edit
  changes rank 1 or rank 2, or a cell, weight or total either one rests on, it redoes `## Flip check`. It
  writes `review.md`: `## Defects` (each defect it showed, with the option id, its failure and the fix it
  would take when one is within reach), `## Edits` (one line per edit: the section, the text before and after,
  and the evidence) and `## Flags` (each score or order it would judge differently with no proven error, each
  option without a ruling-out contribution that it flags, and each defect it suspects and cannot show, each
  with its reason). It returns `wrote_file`, `defects`, `edits`, `flags`, and the `ranking` index and `flip`
  grade after its edits.

## 6. Contribution and stop rules (keep intact)

- **A contribution** is one of five kinds: a new option (a combination of options that genuinely compose
  included, each part named by its option id), a feature added to an option, a feature removed for a stated
  reason (overkill, or an edge case too unlikely to justify its cost), a correction of an error in an
  earlier file, or a defect under the defect rule (§5), with its fix when the challenger has one. Each of
  the first four is a change, inside the rubric's scope, to what would be built or done. It makes the option
  better on at least one weighted criterion or on a plain measure the rubric does not name, such as simpler,
  faster or more robust where robustness is needed, and it cites its evidence. A defect counts with or
  without a fix, since it records a failure no later agent may build on, so a challenger that finds one
  earns the next challenger. No size threshold applies. A feature added, a feature removed or a correction
  targets one of the three leading options of the latest standing (every option when fewer stand), unless it
  names the shortcoming that holds a lower option down and gives evidence that the contribution resolves it.
  A contribution that other options can carry unchanged names each of them under `also fits`, by option id,
  and counts in each option it names. A defect targets the option it is found in, at any standing. A defect
  in a contribution names that contribution's id and holds against every option that carries it.
- **The early stop.** `contributed` false is valid only with a `## Contributions` section that reads `None.`
  and a `## Searched` section that holds a replacement attempt against the leader's assumptions, and an
  improvement attempt and a defect check for each of the three leading options (every option when fewer
  stand), each with the reason it adds nothing. A defect check on a design of software or a process names each
  of the five hostile inputs with its result. A defect check on the do-nothing option names no hostile inputs,
  and reports each defect in today's design the challenger comes across as a DEFECT contribution. The engine
  stops the chain at the first challenger that returns `contributed` false (`dry`), or after
  `maxInvestigators` agents (`cap`), and the decider runs either way. Only an explicit false stops it. Expect
  most runs to stop at `cap`, since a DEFECT on any option counts without a fix, and `dry` saves the rest of
  the chain on a decision with little left to find.
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
- `review.md`: the final reviewer's `## Defects`, `## Edits` and `## Flags`.

The return carries `runId`, `status`, `halted`, `haltReason`, `chosen` (rank 1's title), `ranking` (the
reviewer's index when it attested its file, else the decider's), `flip` (`dominant`, `robust` or `fragile`,
from the same agent as `ranking`, or empty when that agent returned none of the three), `investigators`
(`{ ran, stop }`, where `stop` is `dry`, `cap`, or empty when the run halted inside the chain), `agents`
(the agents started per phase), `userChecks`, `defects`, `edits`, `flags`, `stateDir`, `decisionFile`,
`reviewFile`, `investigationFiles`, `failed` (always an empty array, since no agent is auxiliary) and
`nextStep`. `defects`, `edits` and `flags` are the final reviewer's counts, and a defect's edits count under
`edits`, so a defect picks no terminal of its own. `decisionFile`, `reviewFile` and `investigationFiles` name
only files whose writer attested. `nextStep` says to present the ranking with the review's edits and flags,
adds the flip check when the grade is fragile and the checks for the user when there are any, and says how a
pick is built. When `defects` is above zero it also says to carry each defect under `## Defects` in
`review.md`, with its fix when it names one, into the plan file of any pick it names. When no option passes
every must, it says to present `## Ruled out` and refine the rubric.
