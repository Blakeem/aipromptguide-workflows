# refine-cycle — operator guide (for Claude)

`refine-cycle.mjs` converges **ONE plan file** before develop-cycle builds from it: a read-only
**critic** judges every todo block against the real repo under a fixed defect bar, and a minimal-fold
**editor** folds each verified gap into the file, alternating up to `maxRounds`. The loop ends on ONE
clean round. It replaces feature-cycle `phase:"refine"`, which does not converge (run five times on
one plan it keeps adding detail and never stops). Nothing here builds, stages, or commits. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`.

## 1. What converges it (do not weaken these)

Four things together — remove any one and the plan grows every round instead of settling:
- **The defect bar.** The plan states what the user wants, and the critic judges only whether its
  text is correct. A gap names plan text that is wrong, in one of four classes: a contradiction within
  the plan or with the repo or a file the plan cites, a wrong prescription (built as written, the code
  crashes, loses or corrupts data, or gives wrong output on an input the repo or the plan accepts), a bad
  practice the text prescribes, or a dependency-ordering error. Text a block tells the developer to write is
  output, so a sentence the repo contradicts is a wrong prescription. The critic confirms a prescribed
  command, flag or dependency behavior the repo does not already use the same way, against the
  dependency's docs or source or a probe in a temporary directory outside the repo and the stateDir.
  What the plan does not say is never a gap: a missing step, test, wiring point, edge case, file or
  detail is the developer's call, so a lean block passes. A gap's change corrects or removes the wrong
  text and never adds a requirement, step, file, test or detail the plan does not already state. A
  clause that makes a stated sentence true is a correction, and a new obligation is an addition.
  Improvements, alternatives, and style are excluded unconditionally.
- **The severity floor** (`critiqueSeverity`: `blocking | major | minor`, default `major`).
  The critic grades a gap by what the built code would do. A crash, lost or corrupted data, or wrong
  output on an input the repo or the plan accepts is major, and so is a contradiction about what to
  build or a prescribed bad practice. The size of the fix never lowers a grade. When an earlier block
  makes an existing sentence false and a later block rewrites it, that is a dependency-ordering error
  graded major, since develop's acceptance counts the sentence against the earlier block.
  Below-floor findings never block convergence and no editor folds them. The critic writes them in the
  FYI section of the converged round only, beside the defects outside the plan, and the user reads
  that section with the plan. `belowFloor` returns the section's item count.
- **The dismissal ledger** (`DISMISSED-PLAN.md`). A declined gap stays declined. The critic skips
  settled items and may contest one once. It never contests a line marked `USER-RULED:`, which records
  the user's own ruling.
- **The minimal-fold editor.** It confirms each gap's defect against the plan and the repo first, and
  treats the critic's change as a hint. It writes the correction that closes the confirmed defect, and
  declines a gap only when the defect is not confirmed or no correction, as opposed to an addition,
  closes it. It changes NOTHING a gap does not name, and re-validates the file through the plan-block
  tool after its last edit.

## 2. The flow

1. Author the plan file (plan-bus format, at `<root>/plans/<runId>/`, outside every repo).
2. Launch refine with `planPath` = that file and `blockTool` = the absolute path of the
   `plan-block.mjs` that the pre-launch command `node <plan-block.mjs> <planPath> --list` runs, from a
   notification turn (root `CLAUDE.md`, "Launch from a notification turn"). Follow the return's
   `nextStep`, which names the files to read and the relaunch or replay for each terminal. The
   `status` token says what the state means:
   - `converged` — one clean round: no gaps at or above the floor, and no questions.
   - `needs-answers` — the critic raised things only the user can settle: a dependency-ordering error
     whose fix restructures blocks, a gap in a closed block (any status but `todo`), or a defect in a
     file key (`goal`, `ordered`, `suite`, `sweep`) at or above the floor.
   - `dismissal-contested` — the critic contested a declined gap, and the editor escalated it to
     `NEEDS-USER.md`.
   - `rounds-exhausted` — the last round's gaps were folded but never re-verified, so the plan is not
     converged.
   - `BLOCKED (...)` — one of the halts §3 names, with its cause in `haltReason`. A critic that reports a
     relayed user request halts the run as `relayed-request` before any editor. The cause is a launch
     inside a user turn, so relaunch from a notification turn.
3. **Run refine once per plan.** A `converged` plan goes to the user for approval, never back into
   refine. A relaunch of a converged plan tends to find new detail to fold, so repeated relaunches keep
   growing the plan. Relaunch only to finish a terminal that is not `converged`: after the user settles
   `needs-answers` or `dismissal-contested`, after `rounds-exhausted`, or after the repair a `BLOCKED`
   halt names.

The critic judges only blocks whose `status` is `todo` (or absent), so a relaunch never re-judges a
block develop already built. Blocks added after a plan converged go in a new plan file, which gets its
own single refine run. One develop launch takes both files when their file keys agree (develop guide
§2 step 3).

## 3. Roles

- **Critic** (opus, read-only on the repo) — writes `plan-critique-<round>.md` (gaps with file:line
  evidence, no evidence no gap; questions). In a round with no gap and no question, the converged
  round, it writes the FYI section when it has items, and writes "No gaps." when it has none. That section
  has one subsection per block with below-floor findings, then `File preamble` (plan text above the
  first block, other than the file keys, at any grade, plus a file-key finding below the floor), then
  `Outside the plan` (defects no plan text holds, in files the critic read to judge the plan, at every
  floor). Its items are numbered F1, F2 across the section. No editor reads it, and the user reads it
  with the plan. Returns counts plus a `wrote_file` attestation and a `relayed_request` flag, nothing
  else — content crosses through the file. The critic writes its file every round, so `wrote_file` false
  halts (`critique-unwritten`) whatever the counts, and `relayed_request` true halts
  (`relayed-request`). A DEAD critic **throws** — zero gaps from a dead agent would be byte-identical to
  convergence.
- **Editor** (opus) — runs only on a round with countable gaps and no questions. Checks each gap
  against the plan and the repo first, as §1 says. Folds, declines to the ledger, then re-runs
  `node '<blockTool>' '<planPath>' --list` and attests `plan_parses`.
  Halts: dead editor (`agent-dead` — the critique file survives, but the plan may be partly edited),
  folded gaps with `wrote_file` false (`fold-unattested`), `plan_parses` false (`plan-broken`),
  `needs_user` true (`dismissal-contested`, since it escalated a contested dismissal to
  `NEEDS-USER.md`).

## 4. State files

Default stateDir is `<root>/runs/<runId>-refine/` — the `-refine` suffix is a mechanism, not taste:
reusing one runId across a phase's runs would otherwise land critique files (which quote plan
content) in the exact directory develop's blind reviewer treats as its world's parent. Files:
`plan-critique-<round>.md` per round · `DISMISSED-PLAN.md` · `NEEDS-USER.md`. Every relaunch of one
plan keeps the same runId and stateDir and never clears it, since `DISMISSED-PLAN.md` and its
`USER-RULED:` lines are what stop the next critic re-raising declined gaps. `NEEDS-USER.md` is
cumulative across relaunches of one stateDir, so entries from earlier halts were already settled. Each
entry opens with `## r<round> critic` or `## r<round> editor`, and `nextStep` names the round whose
entries at the end of the file are new.

## 5. Args reference

Full schema + defaults: the Config block atop `refine-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `planPath` (absolute; no inline plan, no default — an omitted
  path would critique nothing and report a clean plan) · `target.repo` (**throws** if missing — the
  critic greps it) · `blockTool` (the absolute path of the `plan-block.mjs` the pre-launch command
  runs. The editor re-validates through it, and the `plan-broken` log line and `nextStep` name it.
  **Throws** when missing or blank, and the message names the pre-launch command. Pre-allowlist
  `Bash(node '<blockTool>':*)`).
- **Optional:** `critiqueSeverity` (`blocking|major|minor`, default `major`; illegal values
  **throw**) · `maxRounds` (default 4, 1–50, garbage **throws**) · `conventions` (the target's CLAUDE.md
  distilled, an index into `conventionFiles`) · `conventionFiles` (the paths of the target's CLAUDE.md
  files, each absolute or relative to `target.repo`, which the critic and the editor read in full. A
  value that is not an array of non-empty paths **throws**) · `reference` ·
  `models`/`efforts`/`agentTypes` (`models` and `efforts` map a role key to a value. The role keys
  are `critic` and `editor`. A model is `opus | sonnet | haiku | fable` and an effort is
  `low | medium | high | xhigh | max`. Both roles default to opus, and every role defaults to
  `high`. The engine **throws** at launch, naming the arg, on a value that is not an object, a key
  outside the role keys, and a value outside its set. Choose each role's model by the task and the
  change's risk, as the develop guide §3 says. `agentTypes` maps the same role keys to a custom subagent that
  must exist in your registry, and **throws** at launch on a value that is not an object, a key outside the
  role keys and a blank name. One launch log line names each role's model and effort) · `stateDir`.
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for
  the agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and
  outside `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of
  this checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt
  then ends with an instruction to append the survey's answers to its own file in `dir`.
  A `notes` arg without both paths, or with a `dir` inside `target.repo`, **throws**. Once the run ends, run
  `node <survey's folder>/survey.mjs <dir>` and report the themes of the `SURVEY.md` it writes to the user.
- **Return:** `status` · `halted` (true on `needs-answers`, `dismissal-contested` and every
  `BLOCKED` halt) · `haltReason` (empty when `halted` is false) · `nextStep` (§2) · `failed` (always
  empty: both roles are solo, so a dead critic throws and a dead editor halts) · `rounds` ·
  `openGaps`/`questions` (the LAST round's counts — on `rounds-exhausted` they are
  folded-but-unverified) · `belowFloor` (the LAST round's FYI item count, written only in a converged
  round) · `dismissedCount` · `lastCritique` · `planPath` · `stateDir`.
