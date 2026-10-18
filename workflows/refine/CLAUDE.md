# refine-cycle — operator guide (for Claude)

`refine-cycle.mjs` converges **ONE plan file** before develop-cycle builds from it: a read-only
**critic** judges every todo block against the real repo under a fixed defect bar, and a minimal-fold
**editor** folds each verified gap into the file, alternating up to `maxRounds`. The loop ends on ONE
clean round. It replaces feature-cycle `phase:"refine"`, which does not converge (run five times on
one plan it keeps adding detail and never stops). Nothing here builds, stages, or commits. Built to
`../../principles/WORKFLOW-PRINCIPLES.md`.

## 1. What converges it (do not weaken these)

Four things together — remove any one and the plan grows every round instead of settling:
- **The defect bar.** A gap must name something that would build wrong or fail: a missing wiring
  point, a wrong or absent file, a criterion with no implementing step, a dependency-ordering error,
  a block too big for one develop pass, a reference the block states only outside itself, a failure on
  an input the repo or the plan accepts. Text a block tells the developer to write is output, so a
  sentence the repo contradicts is a wrong instruction. Improvements, alternatives, and style are
  excluded unconditionally.
- **The severity floor** (`critiqueSeverity`: `blocking | major | minor`, default `major`).
  The critic grades a gap by what the built code would do. A crash, lost or corrupted data, or wrong
  output on an input the repo or the plan accepts is major, unless it is an omission the block's own
  green gate catches on its first run. The size of the fix never lowers a grade. An existing sentence
  the block makes false and leaves unchanged grades minor. When a later block rewrites that sentence,
  it is a dependency-ordering error graded major instead, since develop's acceptance counts it against
  the earlier block.
  Below-floor findings land in the critique file's FYI section. They never block convergence, and
  `belowFloor` returns their count.
- **The dismissal ledger** (`DISMISSED-PLAN.md`). A declined gap stays declined. The critic skips
  settled items and may contest one once. It never contests a line marked `USER-RULED:`, which records
  the user's own ruling.
- **The minimal-fold editor.** It changes NOTHING a gap does not name, and re-validates the file
  through the plan-block tool after every fold.

## 2. The flow

1. Author the plan file (plan-bus format, at `<root>/plans/<runId>/`, outside every repo), the user
   approves it.
2. Launch refine with `planPath` = that file, from a notification turn (root `CLAUDE.md`, "Launch from
   a notification turn"). Follow the return's `nextStep`, which names the files to read and the relaunch
   or replay for each terminal. The `status` token says what the state means:
   - `converged` — one clean round: no gaps at or above the floor, and no questions.
   - `needs-answers` — the critic raised things only the user can settle: a dependency-ordering error
     or too-big block whose fix restructures blocks, a gap in an already-`done` block, or a defect in a
     file key (`goal`, `ordered`, `suite`, `sweep`).
   - `dismissal-contested` — the critic contested a declined gap, and the editor escalated it to
     `NEEDS-USER.md`.
   - `rounds-exhausted` — the last round's gaps were folded but never re-verified, so the plan is not
     converged.
   - `BLOCKED (...)` — one of the halts §3 names, with its cause in `haltReason`.
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
  evidence, no evidence no gap; a below-floor FYI section; questions). Returns counts plus a
  `wrote_file` attestation, nothing else — content crosses through the file. Nonzero counts with
  `wrote_file` false halt (`critique-unwritten`). A DEAD critic **throws** — zero gaps from a dead
  agent would be byte-identical to convergence.
- **Editor** (opus) — runs only on a round with countable gaps and no questions. Folds, declines to
  the ledger, then re-runs `node '<blockTool>' '<planPath>' --list` and attests `plan_parses`.
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
cumulative across relaunches of one stateDir, so entries from earlier halts were already settled.

## 5. Args reference

Full schema + defaults: the Config block atop `refine-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `planPath` (absolute; no inline plan, no default — an omitted
  path would critique nothing and report a clean plan) · `target.repo` (**throws** if missing — the
  critic greps it).
- **Optional:** `critiqueSeverity` (`blocking|major|minor`, default `major`; illegal values
  **throw**) · `maxRounds` (default 4, 1–50, garbage **throws**) · `blockTool` (default
  `<root>/tools/plan-block.mjs`, the editor's re-validation command — pre-allowlist it) ·
  `conventions` · `reference` · `models`/`agentTypes` (both roles opus) · `stateDir`.
- **Return:** `status` · `halted` (true on `needs-answers`, `dismissal-contested` and every
  `BLOCKED` halt) · `haltReason` (empty when `halted` is false) · `nextStep` (§2) · `failed` (always
  empty: both roles are solo, so a dead critic throws and a dead editor halts) · `rounds` ·
  `openGaps`/`questions` (the LAST round's counts — on `rounds-exhausted` they are
  folded-but-unverified) · `belowFloor` (the LAST round's FYI count) · `dismissedCount` ·
  `lastCritique` · `planPath` · `stateDir`.
