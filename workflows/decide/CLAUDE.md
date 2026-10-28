# decide-cycle — operator guide (for Claude)

`decide-cycle.mjs` drives the AI to a **justified conclusion** among approaches: it **diverges** into one
lensed researcher per perspective (each finds options through its lens, gathers cited evidence and scores
them), then **converges** via a **decider** that builds a global weighted decision matrix pulling in the
best of each. Each **open issue** the decider names goes to a researcher, round after round, until the
evidence covers it or research stops. Then one **final reviewer** per review round gates the decision in
two stages: it scores the candidates **blind** from an evidence ledger, then checks itself against the
decision once a check tool has locked that judgment (§5a). The loop runs until the reviewer keeps no
objection against fixed requirements. Built to `../../principles/WORKFLOW-PRINCIPLES.md`. A
*convergence* workflow: it honors the core (#1–4, #6, #8, #11–19) and runs a review loop in the **spirit
of #5, staged rather than blind**: the reviewer must see the decision to check it, but a judge shown a
prior score anchors on it, so it sees the decision only after its own judgment is locked. It produces a
conclusion, **not code**: nothing is staged or committed.

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
The first agent of a run says whether its context holds a relayed user request, and the engine halts
before any later agent when it does.
Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `decide-cycle.mjs` + args.
No mid-run questions — settle the rubric with the user first:

1. **Author the requirements in `EnterPlanMode`.** This is the **fixed rubric** the decider and the final
   reviewer judge against — and the anti-spin ground that makes the loop converge. Capture (§4): the
   decision to be made, the **non-negotiable constraints** (pass/fail), and the **weighted criteria**
   (what "best" means, and how much each axis matters). `AskUserQuestion` for anything ambiguous —
   getting the rubric right is the whole game.
2. **`ExitPlanMode`** — user approves (the human gate).
3. **Pick the lenses** with the user — the evaluation perspectives, one researcher each (e.g. `efficiency`,
   `simplest`, `robustness`, `best-practice`, `risk`, `ux`). Propose them if the user has none. Distinct
   lenses surface distinct options; that spread is what the decider then balances.
4. **Run** the engine (`planPath` = the plan-mode file's **absolute** path, plus `lenses` and
   `checkTool`). It diverges (lens researchers) then converges (decider ⇄ researchers, then decider ⇄
   the staged final reviewer) and returns the
   chosen conclusion + the file trail.
5. **Present** the result: follow the return's `nextStep`. It names the terminal state, the files to
   show and every caveat.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (this checkout — or, from the installed
  aipg plugin, the persistent data dir the skill resolves, never the version-swapped install dir).
- **`planPath` REQUIRED:** the absolute path to the rubric file (§4). There is no inline `requirements`
  arg. A rubric written without plan mode goes to `plans/<runId>/` under `root` first.
- **`lenses` — REQUIRED:** the perspectives from §2 (strings or `{ id, focus }`); ids that collide after
  slugging throw, since two researchers would write the same `lenses/<lens>.md`.
- **`checkTool` — REQUIRED:** the absolute path of `tools/review-check.mjs` in this checkout (or in the
  plugin folder the skill names). The reviewer runs it to lock its blind review, and the check agent runs
  it with `--verify` (§5a). Both run it unattended, so **pre-allowlist** the command exactly as agents
  run it, `Bash(node '<checkTool>':*)`, in the settings of the project the run works in.
- **`target.repo` (optional):** pass it for a decision about existing code — the researchers, the
  decider and the reviewer read it **read-only** for pattern-fit and feasibility; the engine never modifies it.
- **`testbed` (optional):** how agents may **empirically test** claims (e.g. a sqlite db + how to query
  it, a script to benchmark against). The researchers, the decider and the reviewer are told to prefer
  measured evidence — run the check, cite command + result (#14) — and the reviewer re-runs each testbed
  command behind a fact that moves a score. Set it up
  read-only by construction (e.g. `sqlite3 "file:path.db?mode=ro"`, or a copy), and **pre-allowlist the
  commands** in the target project's settings — a background run can't answer permission prompts
  unattended.
- **Relaunch vs. new run.** The engine keeps no state across invocations. A same-runId relaunch with no
  `resumeFromRunId` re-runs the run from Diverge and round 1. It overwrites the lens files and the
  research and round files it reaches, and it leaves an earlier run's higher-numbered files in place. Extending
  finished rounds is a relaunch with `maxRounds` raised plus the Workflow tool's `resumeFromRunId`, which
  replays the finished agents from cache. Starting over takes a new runId, so the earlier run's files
  stay intact. Never clear `runs/<runId>/`. `NEEDS-USER.md` is cumulative. Relay the return's
  `decisionFile`, never the highest-numbered file.

## 4. Requirements-file shape (you write it; agents read it VERBATIM, #2)

Plain markdown — the engine does **not** parse it. Keep it tight; this is the rubric, not an essay.

```markdown
## Decision
One line: the choice to be made.

## Non-negotiables   # musts: pass/fail — an option that fails one cannot win
- e.g. "must run in the existing Node 20 runtime", "no new paid dependency", "p99 < 50ms".

## Weighted criteria  # wants: what "best" means + how much each matters (weights need not sum to 100)
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

**Scoring rule** (every role's prompt states it once, through one constant): a non-negotiable (a must) is
pass/fail, and an option that fails one cannot win. A weighted criterion (a want) is scored per option
as **met**, **partly met** or **missed**, each with its cited evidence. The weighted total counts met as
full weight, partly met as half and missed as zero. A want scores met only on a cited source or a
measurement, and own judgment scores at most partly met.

- **Researcher** (research · sonnet) — two jobs. In Diverge, one per lens: reads the requirements + its
  lens, generates 2–4 options, gathers evidence for them, scores them under the scoring rule, recommends
  one, notes keep-worthy elements, and writes `lenses/<lens>.md`. In each research round, one per open
  issue, up to `maxResearchers` (§6): reads the requirements, the issue's entry in the decision file and
  the files that entry names, searches with the tools it has, and writes `research/r<N>-<slug>.md`. A
  question no agent can settle (no testbed, a source no agent can open, a check that needs the user's
  hardware) it writes as a **check for the user**: the check and the result that would change the answer.
  It returns `new_evidence`, true when its file holds a cited fact no earlier file of the run holds.
  Either job cites each factual claim to its original source: a file:line, a measurement with its exact
  command and result, a source URL, or "own judgment".
- **Decider** (decide · opus) — reads the requirements + every lens file (+ the research files of the
  latest research round, + the previous review round's final review); consolidates options, may
  build a hybrid, scores a **global weighted matrix** under the scoring rule (**every cell citing its
  evidence or marked "own judgment, low-confidence"**, #14), cites for **each option it rules out** what
  rules it out and the one observation that would reverse that, picks the winner with why-not-others,
  writes `decide/decision-rN.md`. Every decision file ends with an **`## Open issues`** section and a
  **`## Checks for the user`** section. An open issue is a question whose answer could change the
  winner (in `ranked` mode, rank 1 or an adjacent pair): one the flip check names, or a must or want the
  evidence does not yet settle. Each has a slug, the question, the requirement it bears on and the files
  a researcher should read, and the decider returns the slugs as `open_issue_ids`. A research round
  researches at most `maxResearchers` issues, so the decider merges the issues one researcher would
  settle from the same sources or within the same domain into one issue that holds several questions,
  and lists the issues in order of how far each could move the winner, the furthest first. A question that
  cannot change the winner is a caveat in the file. A question no agent can settle goes under
  `## Checks for the user` with the result that would change the answer, never becomes an open issue
  again, and is counted in `user_checks`. For a decision about what to test, these checks are part of
  the deliverable. After a research round the decider revises its decision with the round's findings.
  The decision file also holds a **`## Trade-off`** section (the winner against the runner-up, one row
  per criterion where they differ, as weight × credit gap, where credit is 1 for met, 0.5 for partly
  met and 0 for missed: what the winner gains and gives up) and a **`## Flip check`** section (the
  smallest single change to one cell or weight that changes the winner, plus the joint effect of
  moving every low-confidence cell by its uncertainty). It grades the choice **dominant**
  (gives up nothing), **robust** (the smallest flip is larger than the uncertainty of the input it moves)
  or **fragile** (it is not), and returns the grade as `flip`. Each pass also writes an **evidence
  ledger**, `review/ledger-rN.md`: the answer under review (in `ranked` mode, the listed options in rank
  order with their combine and exclude claims), every candidate (in `ranked` mode, listed or left off),
  and for each candidate the facts its scores rest on, each with its original source. The ledger holds
  no score, weight, total, rationale or lens recommendation, and cites no lens, research or decision
  file, so reading it reveals no judgment. `wrote_file` attests both files. After a reject it revises
  its prior decision into a complete new file under fixed **fold rules**: it confirms each kept
  objection's evidence against its source; for a **challenger** it scores the winner and the challenger
  side by side on the same rubric and keeps the higher (in `ranked` mode it orders the two by that
  score); for a **must violation** it repairs the winner or replaces it (in `ranked` mode it repairs the
  listed option or takes it off the list); in `ranked` mode it corrects a combine or exclude claim the
  evidence contradicts; a refuted objection gets a rebuttal under `## Rebuttals` with evidence, and one
  it can neither confirm nor refute, or one that names evidence no file of the run holds, becomes an
  open issue, so a research round settles it before the next review; it may fold a caveat or a
  downgraded objection whose fix is one sentence and leaves every other one to the review files; it
  tests each fold against one hostile input of each kind it touches (a failure, a concurrent edit, a
  human-set value, state saved before the change, an edit by another program that no scan has seen
  yet); a fold that repairs one option against a defect another option shares repairs that option the
  same way and keeps it scored; it never adds a repaired variant as a new rival; and it changes nothing
  that an objection or a research finding does not name. After a lock mismatch or an unwritten final
  review (§5a) it acts on every objection of the blind review instead. Escalates a user-only call to `NEEDS-USER.md` (halts on a hard
  blocker) — **and so may the reviewer**, for a requirement contradiction (§7); those are two distinct
  halt paths, not one. In `ranked` mode it instead ranks the strongest options (up to `shortlist`), each
  with what it **buys**, what it **costs**, its rank rationale, plus a **combine / exclude** section and
  a flip check over each adjacent pair, graded on rank 1 (no trade-off section) — an option violating a
  non-negotiable is off the list entirely, and it is told not to pad.
- **Final reviewer** (review · opus) — one fresh reviewer per review round, in two stages (§5a). Its
  prompt holds only the blind stage: the requirements, the ledger and its blind file
  `review/review-rN.md`. It opens the original source behind each fact that moves a score (and re-runs
  each testbed command such a fact rests on), scores every candidate on every requirement (pass or fail
  on each must; met, partly met or missed on each want, each with its evidence), lists its
  **objections** and writes a verdict line. An objection cites the requirement it rests on and is a
  must the winner violates or a **challenger** that scores higher on the same rubric (in `ranked` mode: a
  listed option that violates a must, an adjacent pair whose order its scores reverse, a candidate off
  the list that scores above a listed one, or a combine or exclude claim the evidence contradicts).
  Musts are judged at the depth the rubric states, else on the default path (§4). Every other concern
  is a caveat. It rejects exactly when it holds an objection. The blind file holds `## Scores`,
  `## Objections` (`- O<n>: ...` lines), `## Caveats` (`- C<n>: ...` lines, or `None.`) and a last
  `Verdict: accept|reject` line. Its
  prompt ends with one instruction: run `node '<checkTool>' '<blind file>'` and follow what it prints. Its
  return is neutral: `wrote_file`, `verdict` and `needs_user`.
- **Check agent** (check · sonnet) — writes and runs fixed text only. Before each review it writes the
  round's check spec and reveal text and resets its lock and final file (§5a). After the reviewer returns it runs `--verify` and returns
  `exit_code`, `final_line` and `stage1_verdict`.

## 5a. The staged review (for the operator — no prompt points here)

A judge shown a prior score or verdict anchors on it, so the final reviewer judges blind before it sees
the decision:

1. The check agent writes `locks/review-rN.json` (the headings the blind file must hold, the final file
   `decide/review-rN-final.md`, the decision file and the reveal path) and `locks/review-rN.reveal.md`,
   the reveal text the engine renders. It also writes `{}` to `locks/review-rN.lock` and empties the final
   file, so a same-runId relaunch never finds an earlier launch's lock or final review standing in for
   this round's.
2. The reviewer writes its blind file and runs `tools/review-check.mjs` on it. While the file is
   incomplete the tool prints the format errors only. Once it is complete the tool writes
   `locks/review-rN.lock` (the file's sha256 and its verdict) and prints the reveal: read the decision
   file, then sort each objection into **withdrawn** (only by quoting, word for word, a sourced fact the
   decision file holds, never the decider's opinion, weight or argument), **kept** or **downgraded** to
   a caveat, write the final file (an `## Objections` section with one sort line per objection, a
   `## Caveats` section of `- C<n>:` lines or `None.`, and the final verdict), and run the check again.
   Later runs check that the blind file still matches the lock and that each withdrawal's quote is in the
   decision file. A reject keeps at least one objection. In the last round a reject ends with a **WHERE
   NEXT** section: whether the kept objections rest on evidence another revision could answer, or on a
   requirement the rubric does not settle, and for a requirement the one change that would let a decision
   converge.
3. The check agent runs `review-check.mjs --verify <blind file>`. Exit 0, the lock matches: the engine
   takes the verdict from the counts line (`raised, withdrawn, kept, downgraded, caveats`), reject when an
   objection is kept, and a withdrawal whose quote the tool did not find counts as kept. Exit 0 with a
   `locked verdict:` line, the final file unwritten: every objection counts as kept, so the locked blind
   verdict stands, the engine logs it, and the blind file is the review the decider and the hand-back
   read. Exit 3, the blind file changed after its lock: the engine uses the locked blind verdict and logs
   the fallback.
   Exit 2, no lock: the reviewer never ran the check, so the engine reruns the reviewer once, and a
   second miss ends on `BLOCKED (the reviewer did not complete its review)`. Any other result throws.

The reviewer is blind by **prompt**, not by placement: the decision files sit in the same run folder,
and nothing stops an agent that lists it. Two more paths reach it. Every agent of a run reads the
session's memory index, so keep the staged mechanics (the reveal, the lock, the decision paths) out of
auto-memory. A relayed user message reaches every agent prompt and can describe the reveal, so launch
every run from a notification turn (root `CLAUDE.md`, "Launch from a notification turn").

## 6. Loop & contracts (keep intact)

`diverge (once) → [decide → (research → decide)* → review]×N`, up to `maxRounds` (default 3). A reject
hands the decider that round's final review next round; the decider revises rather than restarting.

- **The research gate.** After each decider pass the engine reads `open_issue_ids`. Empty: the decision
  goes to review, and research stops as `covered`. Otherwise a research round runs one researcher per
  distinct slug, concurrently, for the first `maxResearchers` slugs in the decider's order (default
  10), and the decider runs again over that round's research files. The decider sets the issue count,
  so this cap bounds the agents one round launches. The log names each slug past the cap as carried,
  and the next decider pass is told no researcher took it and keeps it open. When the latest decision
  lists more open issues than `maxResearchers`, `nextStep` names each issue past the cap and says the
  decision may need splitting into narrower decide runs. Research
  stops, and the decision goes to review with its open issues on record, on the first of: two research
  rounds in a row in which no researcher returned `new_evidence` true (`saturated`), or
  `maxResearchRounds` research rounds in the run (`cap`, default 3). The dry-round streak restarts with
  each review round, since a review asks new questions, and the cap counts every research round of the
  run. The log names each stop. Research rounds and the decider passes between them do not spend
  `maxRounds`. Each decider pass writes the next `decision-rN.md` and `ledger-rN.md`, so N counts
  decider passes, while `review-rN.md` counts review rounds.
- **An objection no agent can settle never loops.** An objection that names missing evidence becomes an
  open issue, so it goes to a research round before the revision reaches review. A question no agent
  can settle becomes a check for the user.
- **The requirements file is the fixed rubric and the anti-spin ground.** The decider and the reviewer
  judge against it, so the loop converges; there is no `DISMISSED.md`. A reject must keep a must
  violation or a challenger that scores higher on the same rubric, and the decider keeps the higher of
  the two, so each revision moves toward a stronger answer. `reviewRounds` on the return holds one
  `{ round, verdict, raised, withdrawn, kept, downgraded, caveats, lockMatched }` entry per review round. A run
  that does not converge hands back the final review, whose kept objections and WHERE NEXT section say
  whether another revision or a rubric change is the fix, and a rubric gap is fixed by refining the
  rubric rather than raising `maxRounds`. When the last round fell back to its blind review (§5a), the
  hand-back starts from that review's objections, since no WHERE NEXT section exists.
- **Staged, not blind (#3/#5).** The reviewer must see the decision to check itself against it, but only
  after its blind judgment is locked (§5a). Each round's reviewer is fresh and reads no earlier review.
- **Acceptance means no kept objection.** The loop ends when the reviewer accepts. A caveat never
  blocks. `review-check.mjs` counts the caveats under `## Caveats`, in the final review once it is
  written and in the blind review otherwise. A malformed caveat line still counts (tools/CLAUDE.md,
  "review-check.mjs"). An accepted run with caveats ends `decided with caveats
  (the final reviewer accepts the decision and names <n> caveats)`, and its `nextStep` says to carry the
  `## Caveats` section of the last file `reviewFiles` lists (§9) into the plan's design section.
- **`selection` shapes the deliverable, not the rigor.** `single` (default) → one winner + why-not-each
  runner-up. `ranked` → an ordered shortlist (≤ `shortlist`, default 5, floor 2) where every listed
  option must satisfy every non-negotiable — a violator is excluded, never ranked last — and each
  carries explicit `combines_with` / `excludes` notes, because a shortlist the user can't safely mix is
  a trap. Both modes run the same matrix, citation rule, and review loop.
- **No code, no git.** Decide produces files only; it never stages or commits. The conclusion feeds
  a plan file's design section, which `develop-cycle` builds next.
- **Thin returns (#8).** Schemas carry only `chosen` / `meets_all_requirements` / `flip` /
  `open_issue_ids` / `user_checks` / `new_evidence` / `verdict` / the check agent's `exit_code`,
  `final_line` and `stage1_verdict`, a `wrote_file` write confirmation per writing role — plus, in
  `ranked` mode, the shortlist **index** (rank + title + `combines_with`/`excludes`); the matrices,
  buys/costs, findings and reasoning live in the files. A lens
  researcher whose `wrote_file` is not true is dropped: a `✗` in the log, listed in `failed`, left out of
  the decision, and the run throws when no lens researcher confirms (§7). An unconfirmed decider,
  research-round researcher, check agent or reviewer write halts the run on
  `BLOCKED (an agent did not confirm writing its file)` (§7), unless that decider or reviewer escalated,
  because the next agent and the return would otherwise name a path a stale file can hold.

## 7. Resume

Three halts. The decider or the reviewer writes a user-only call to `NEEDS-USER.md`
(`BLOCKED (needs user input)`), the decider, a research-round researcher, the check agent or the
reviewer does not confirm writing its file (`BLOCKED (an agent did not confirm writing its file)`), or
the reviewer and its rerun never run the check (`BLOCKED (the reviewer did not complete its review)`).
For an escalation, read `NEEDS-USER.md`, resolve it with the user (usually by editing the requirements
file), then relaunch with the same args and no `resumeFromRunId`. A `resumeFromRunId` replay sends the
same prompts, which name the requirements file by path, so it replays the cached returns and halts the
same way. The relaunch re-runs the run from Diverge and round 1 (§3). For an unattested write, check the
file `haltReason` names, then relaunch the same way: a resume replays the cached return and halts the
same way. For an incomplete review, check that `Bash(node '<checkTool>':*)` is allowlisted (§3), then
relaunch the same way.

A `needs-attention` run takes one of two relaunches. After refining the requirements, relaunch with the
same args and no `resumeFromRunId`, since a resume would never read the edit. After raising `maxRounds`,
relaunch with `resumeFromRunId`, so the finished rounds replay from cache and the loop continues past them.

The run can also stop by **throwing**. If no lens researcher produced a lens file, check the requirements
and lenses and re-run without `resumeFromRunId`. If the decider, a research-round researcher, the check
agent or the reviewer returned nothing (agent skipped or died), re-invoke with the same args/`runId` and
pass the `Workflow` tool's `resumeFromRunId` to replay completed agents from cache, as the thrown message
says. If the check agent returned a result outside the tool's documented exits, relaunch with the same
args and no `resumeFromRunId`, since a resume replays that cached return.

## 8. Args reference

Full schema + defaults: the Config block atop `decide-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `lenses` (array of ≥2 perspectives, distinct ids — both
  enforced) · `planPath` (absolute path to the rubric file) · `checkTool` (absolute path to
  `tools/review-check.mjs`, §3).
- **Optional:** `selection` (`"single"` default | `"ranked"` — §1/§6; anything else throws) ·
  `shortlist` (ranked only: how many options to carry, default 5; **throws** below 2 or non-numeric) ·
  `context` (extra framing / domain facts) · `testbed` (how to empirically test claims —
  §3) · `target.repo` (absolute, read-only context) ·
  `target.lang`/`target.framework` (hints) · `maxRounds` (3; **throws** below 1 or non-numeric — it used
  to coerce, and a NaN bound silently produced a zero-round run reported as an ordinary result) ·
  `maxResearchRounds` (3, run-wide research rounds, §6; `0` runs none; **throws** below 0 or
  non-numeric) · `maxResearchers` (10, the researchers one research round launches, §6; **throws**
  below 1 or non-numeric) ·
  `models`/`efforts` (`models` and `efforts` map a role key to a value. The role keys are `research`,
  `decide`, `review` and `check`, and the retired key `analyst` throws like any unknown key. A model is
  `opus | sonnet | haiku | fable` and an effort is
  `low | medium | high | xhigh | max`. The research and check roles default to sonnet, the decide and
  review roles default to opus, and every role defaults to `high`. The engine **throws** at launch, naming
  the arg, on a value that is not an object, a key outside the role keys, and a value outside its
  set. Choose each role's model by the task and how much judgment the role needs, as the develop guide §3 says. One
  launch log line names each role's model and effort) · `agentTypes` (custom subagent per role — must exist
  in your registry. It takes the same role keys and **throws** on a value that is not an object, a key
  outside the role keys, `analyst` included, and a blank name) · `stateDir` (override `runs/<runId>`).
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for
  the agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and
  outside `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of
  this checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt
  then ends with an instruction to append the survey's answers to its own file in `dir`.
  A `notes` arg without both paths **throws**. Once the run ends, run `node <survey's folder>/survey.mjs <dir>`
  and report the themes of the `SURVEY.md` it writes to the user.

## 9. State files (`runs/<runId>/`, outside every repo)

- `lenses/<lens>.md` — each lens researcher's options + evidence + lens scores + recommendation.
- `research/r<N>-<slug>.md` — research round N's findings on the open issue `<slug>`, or its check for
  the user.
- `decide/decision-rN.md` — the decider's Nth pass: the matrix + conclusion + why-not-others + trade-off
  + flip check (in `ranked` mode: the matrix + the ranked options with buys/costs + the
  combine-vs-exclusive section + the flip check), then `## Open issues` and `## Checks for the user`.
- `review/ledger-rN.md` — the evidence ledger of the decider's Nth pass (§5).
- `review/review-rN.md` — review round N's blind review: `## Scores`, `## Objections`, `## Caveats` (one
  `- C<n>:` line per caveat, or `None.`) and the verdict line.
- `decide/review-rN-final.md` — review round N's final review: `## Objections` with each objection
  withdrawn, kept or downgraded, `## Caveats`, the final verdict and, on a last-round reject,
  `## WHERE NEXT`.
- `locks/review-rN.json`, `locks/review-rN.reveal.md`, `locks/review-rN.lock` — the check spec, the
  reveal text and the lock of review round N (§5a).
- `NEEDS-USER.md` — user-only escalations; a hard blocker here halted the run.

The return carries the paths (`decisionFile` / `reviewFiles` / `needsUserFile`), each lens's top pick
(`lensPicks`), the lenses whose researcher did not confirm writing a lens file (a file may still exist on
disk) and so were left out of the decision (`failed`, one `{ id, stage: 'diverge' }` entry per lens),
the per-round review counts (`reviewRounds`, §6), two agreement flags and `selection` as structured fields.
`research` is `{ rounds, stop }`: the run's research rounds and why research last handed the decision to
review, `covered`, `saturated` or `cap` (§6), or empty when the run halted in a round before research
handed that round's decision to review. `openIssues` lists
the latest attested decision's open issue slugs, and `userChecks` counts its checks for the user. When
research stopped on `saturated` or `cap` with open issues, `nextStep` says to present them with the
decision, and when `openIssues` holds more issues than `maxResearchers` it names the issues past the cap
(§6). When `userChecks` is above 0 it says to present the checks.
`reviewFiles` lists the latest round's blind review, and its final review when the lock matched and
the reviewer wrote it.
`decisionFile` and `reviewFiles` name only files whose writer attested, so after a halt either can be
empty or name an earlier round. A halt also returns its `haltReason`. `flip` is the latest decision's
grade (`dominant`, `robust` or `fragile`), or empty when the decider returned none of the three.
`caveats` is the latest review round's caveat count (§6), and 0 when no review ran. An accepted run
ends `decided with caveats (the final reviewer accepts the decision and names <n> caveats)` when
`caveats` is above 0, else `decided (the final reviewer accepts the decision)`, and sets `agreed`. On
acceptance `nextStep` carries a flip note for a fragile or dominant grade and, when `caveats` is above
0, a note to carry the caveats of the last file `reviewFiles` lists into the plan. `contradicted` is true
when the latest reviewer returned a verdict its own check counts overturn, since the counts decide.
`meetsAllRequirements` is false when the latest decider reported that its conclusion, or a shortlisted
option, misses a requirement. An accepted run with `contradicted` raised, `meetsAllRequirements` false or
a lock mismatch in its last round keeps its status, and its hand-back names the file to audit before
presenting. In `ranked` mode the return adds the ordered `shortlist` index and `chosen` is the rank-1
option, both from the latest decision only.
