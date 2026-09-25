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
  a block too big for one develop pass. Improvements, alternatives, and style are excluded
  unconditionally.
- **The severity floor** (`critiqueSeverity`: `blocking | major | minor`, default `major`).
  Below-floor findings land in the critique file's FYI section and count for nothing.
- **The dismissal ledger** (`DISMISSED-PLAN.md`). A declined gap stays declined; the critic skips
  settled items and may contest one once.
- **The minimal-fold editor.** It changes NOTHING a gap does not name, and re-validates the file
  through the plan-block tool after every fold.

## 2. The flow

1. Author the plan file (plan-bus format, at `<root>/plans/<runId>/`, outside every repo), the user
   approves it.
2. Launch refine with `planPath` = that file. Read the result:
   - `converged` — hand the final text to the user for approval, then derive develop's args from
     `--list` and build.
   - `needs-answers` — read `NEEDS-USER.md`: the critic raised things only you can settle (a
     dependency-ordering error, a too-big block, a gap in an already-`done` block). Restructure the
     plan (new blocks need fresh kebab ids), then relaunch.
   - `rounds-exhausted` — the last round's gaps were folded but never re-verified. Read
     `lastCritique`, decide, relaunch to confirm.
   - A `BLOCKED (...)` status — the halt reason names the repair.
3. **Audit `DISMISSED-PLAN.md`** before trusting a converge — a declined gap is a judgment call.

The critic judges only blocks whose `status` is `todo` (or absent), so a partially-built roadmap can
be re-refined without rewriting the spec its staged code was built against.

## 3. Roles

- **Critic** (opus, read-only on the repo) — writes `plan-critique-<round>.md` (gaps with file:line
  evidence, no evidence no gap; a below-floor FYI section; questions). Returns counts plus a
  `wrote_file` attestation, nothing else — content crosses through the file. Nonzero counts with
  `wrote_file` false halt (`critique-unwritten`). A DEAD critic **throws** — zero gaps from a dead
  agent would be byte-identical to convergence.
- **Editor** (opus) — runs only on a round with countable gaps and no questions. Folds, declines to
  the ledger, then re-runs `node '<blockTool>' '<planPath>' --list` and attests `plan_parses`.
  Halts: dead editor (`agent-dead` — the critique file survives, resume the fold), folded gaps with
  `wrote_file` false (`fold-unattested`), `plan_parses` false (`plan-broken` — repair by hand).

## 4. State files

Default stateDir is `<root>/runs/<runId>-refine/` — the `-refine` suffix is a mechanism, not taste:
reusing one runId across a phase's runs would otherwise land critique files (which quote plan
content) in the exact directory develop's blind reviewer treats as its world's parent. Files:
`plan-critique-<round>.md` per round · `DISMISSED-PLAN.md` · `NEEDS-USER.md`.

## 5. Args reference

Full schema + defaults: the Config block atop `refine-cycle.mjs` (the canonical source).
- **Required:** `runId` · `root` · `planPath` (absolute; no inline plan, no default — an omitted
  path would critique nothing and report a clean plan) · `target.repo` (**throws** if missing — the
  critic greps it).
- **Optional:** `critiqueSeverity` (`blocking|major|minor`, default `major`; illegal values
  **throw**) · `maxRounds` (default 4, 1–50, garbage **throws**) · `blockTool` (default
  `<root>/tools/plan-block.mjs`, the editor's re-validation command — pre-allowlist it) ·
  `conventions` · `reference` · `models`/`agentTypes` (both roles opus) · `stateDir`.
- **Return:** `status` · `rounds` · `openGaps`/`questions` (the LAST round's counts — on
  `rounds-exhausted` they are folded-but-unverified) · `dismissedCount` · `lastCritique` ·
  `planPath` · `stateDir`.
