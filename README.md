# AI Prompt Guide — Workflows

**[aipromptguide.com](https://aipromptguide.com)** · A collection of production-grade **Claude Code
dynamic workflows**: the prompts and orchestration that *guide the AI* through real engineering work,
plus the shared design principles they're all built to.

Each workflow is a background **Workflow engine** (a `.mjs` script) paired with a `CLAUDE.md` operator
guide. The guide is the prompt: it drives **plan mode** and the human approval gate *outside* the engine,
then runs the engine to do the work. The **build** workflows leave the result test-verified, wired in,
and staged for you to commit. The **generative** ones leave cited files for you to use. Either way,
**nothing is ever committed for you**.

## The workflows

| Workflow | Trigger | Flow | Use it for |
|----------|---------|------|------------|
| **[feature](workflows/feature/)** | `/aipg:feature` | [map](workflows/feature/FLOW.md) | Build **one bounded feature** (new MCP tool, endpoint, page, form) from a plan you approve, or an ordered **roadmap** of them with one approved plan each. |
| **[debug](workflows/debug/)** | `/aipg:debug` | [review](workflows/debug/FLOW-review.md) · [resolve](workflows/debug/FLOW-resolve.md) | Find **production defects** in a repo or change → triaged issues → batched fixes. The fix loop also accepts an external inventory: findings from live/manual testing or bug reports. |
| **[migrate](workflows/migrate/)** | `/aipg:migrate` | [map](workflows/migrate/FLOW.md) | A **breadth-spanning migration/upgrade** decomposed into ordered, section-gated changes across many call sites. |
| **[gauntlet](workflows/gauntlet/)** | `/aipg:gauntlet` | [map](workflows/gauntlet/FLOW.md) | **Build-then-climb**: get a working MVP down, then climb it toward an inspectable **quality bar** (exemplar A/B, critic-led waves) — or point the climb at an existing product. You set the wave budget. |
| **[enhance](workflows/enhance/)** | `/aipg:enhance` | [map](workflows/enhance/FLOW.md) | **Audit**: what a working system could do *better*. One lens per angle → verified, impact-scored proposals you triage. Nothing auto-applied. |
| **[brainstorm](workflows/brainstorm/)** | `/aipg:brainstorm` | [map](workflows/brainstorm/FLOW.md) | **Diverge**: one fully-committed variation per lens (designs, ideas) for you to pick or combine. No AI verdict. |
| **[decide](workflows/decide/)** | `/aipg:decide` | [map](workflows/decide/FLOW.md) | **Converge**: lensed analysis → a weighted decision matrix → a justified conclusion, adversarially reviewed. |
| **[investigate](workflows/investigate/)** | `/aipg:investigate` | [map](workflows/investigate/FLOW.md) | **Search**: find an answer that already exists and qualify it against fixed **pass/fail** criteria, until nothing qualifying is left unsearched. |
| **[docs](workflows/docs/)** | `/aipg:docs` | [map](workflows/docs/FLOW.md) | **Provision**: copy the docs a project needs **verbatim** (web/repo/files) → curate + index into a folder the LLM builds against. |

The first four are **build** workflows (code, reviewed and staged). The last five are
**generative/read-only**: proposals, creative options, a decision, a determination, or a curated doc set,
with no code and nothing staged or committed.

Two pairs are worth keeping straight. `debug` and `enhance`: something the system gets **wrong** is a
defect, which debug fixes; something it could do **better** is an enhancement, which enhance proposes and
you decide on. `decide` and `investigate`: when no established answer exists and the work is **weighing
trade-offs**, that's decide; when the answer is already out there and the work is **finding it and proving
it fits**, that's investigate. The tell is whether missing a requirement is a trade-off or simply
disqualifying.

All nine share the design rules in **[principles/](principles/)**:
the fifteen [Workflow Principles](principles/WORKFLOW-PRINCIPLES.md) (lean, file-bus, no busy-work
agents).

**The Flow column is a diagram of what a run actually does** — every agent, gate, loop and terminal
state, rendered inline by GitHub. Read one before starting a run you have not done before: the terminal
states in particular are the part worth knowing in advance, since "ran out of rounds" and "proved there
is no answer" are different results that look alike in a summary.

Those maps are **generated, never hand-drawn**. `tools/gen-flows.mjs` runs each engine against scripted
agent replies and watches which agents it spawns, so a diagram can only ever show a path that really
runs. That makes it a linter as much as a picture: it fails `node tests/run.mjs` when a map goes stale,
when an engine grows a branch no scenario reaches, or when `meta.phases` stops matching the phases the
agents actually run under.

## Why it's built this way

This repo is a **Claude Code plugin** (`aipg`), and its skills are **thin and stable**. Each carries
*no* workflow prompt, only the install's resolved paths and a pointer to the matching
`workflows/<x>/CLAUDE.md`. That split is deliberate:

- **The prompt lives in the workflow, not the skill.** Plan mode (and its approval gate) must run
  *outside* a background Workflow, so the `CLAUDE.md` guide, not the engine, drives it. Loading a
  workflow the ordinary way wouldn't include that prompt. Pointing at the `CLAUDE.md` does.
- **One update moves everything together.** Skills, guides, engines and the `plan-block` tool ship as
  one plugin version — nothing to copy, nothing to drift.

```
You run /aipg:feature  →  Claude reads the plugin's workflows/feature/CLAUDE.md  →  plan mode + your
approval (or the autonomous path when you hand it a finished plan)  →  runs feature-cycle.mjs by path
→  staged result you review & commit
```

## Install (plugin)

```
/plugin marketplace add Blakeem/aipromptguide-workflows
/plugin install aipg@aipromptguide
```

That's it — the workflows land in the plugin cache and run-state goes to the plugin's persistent
data dir (`~/.claude/plugins/data/…`), outside every project. Run one:
`/aipg:feature add a search_docs MCP tool. Plan it first.`

## Install (checkout — for development, or driving workflows by path)

1. **Clone it anywhere** (in a project, gitignore it):

   ```bash
   git clone https://github.com/Blakeem/aipromptguide-workflows.git aipg
   echo "aipg/" >> .gitignore
   ```

2. **Open the checkout in Claude Code** — the root `CLAUDE.md` routes to each workflow's guide, with
   `root` = the checkout. To use the plugin's skills against a local clone, add it as a local
   marketplace instead: `/plugin marketplace add ./aipg` then `/plugin install aipg@aipromptguide`.

## One checkout, many projects

Every engine takes two separate paths, and they are deliberately **not** the same directory:

```
E:/myproject/          ← target.repo   the project itself, the folder holding .git
├── .git/
├── src/
└── aipg/              ← root          run-state lands at aipg/runs/<runId>/
    └── workflows/
```

- **`target.repo`** is the repo being worked on. Agents run `git -C <target.repo> …` against it, and it
  is the only place code is ever changed or staged.
- **`root`** is the base the run-state hangs off. `<root>/runs/<runId>/` holds the review files, the
  ledgers, and any parked patch. Normally the checkout's own folder, so nothing lands in your project.

Keeping them apart is what makes the blind review work: the issue files live outside the repo under
review, so a reviewer that is supposed to judge a diff on its own merits **cannot** wander into them.
The build and debug engines warn if you point run-state inside the target repo, and the build engines (feature, migrate, gauntlet) warn when a plan file — or gauntlet's run documents (canon/bar/components/aspects) — resolves inside it.

It also means **one checkout can drive any number of projects**. Point `target.repo` at each in turn and
give each its own `runId`. The run-state stacks up under `root`, so you can queue work across several
repos and still read every trail in one place:

```
aipg/runs/api-v2-migration/     ← target.repo E:/work/api
aipg/runs/dashboard-search/     ← target.repo E:/work/dashboard
```

You never type these yourself. Tell Claude which project you mean and it fills them in as pre-run setup.
There is no default for `target.repo` on the engines that write code, because guessing wrong would point
a build, or a park's `git checkout`, at the wrong repo. They fail loudly instead.

**Installed as the plugin, the same two-path rule holds — only `root` moves.** The plugin install dir
is version-swapped on every update, so run-state cannot live beside the engines there. The skills point
`root` at the plugin's persistent data dir instead, and everything stacks up the same way, still outside
every project:

```
~/.claude/plugins/cache/aipromptguide/aipg/<version>/   ← the engines (read-only, swapped on update)
~/.claude/plugins/data/aipg-aipromptguide/              ← root: runs/<runId>/ + plans/<runId>/
```

## Updating

Plugin: `/plugin` → **Installed** → `aipg` → update (auto-update lives under **Marketplaces**, off by
default) — skills, guides and engines move together, and every commit is a new version (`plugin.json`
carries no `version` field, so the git commit SHA is the version). Checkout:

```bash
cd aipg && git pull        # refreshes every workflow's CLAUDE.md + engine
```

## Changelog

What's changed, newest first: new workflows, changes to how they work, and bugs worth knowing about.

### 2026-08-06

- **New workflow: `gauntlet`** (`/aipg:gauntlet`) — the Gauntlet Loop pattern (builder + fresh blind
  critic vs. an inspectable exemplar) adapted to the house principles. `phase:"mvp"` builds an approved
  `COMPONENTS.md` decomposition to a working, code-sound alpha: per component, builder → blind code
  gate (defects AND structural debt) → staged; a component that cannot pass parks and STOPS.
  `phase:"refine"` — also the entry point for an **existing** product — climbs the staged product
  toward `BAR.md` in waves: one fresh critic per open quality aspect observes the RUNNING product with
  its own persistent `testbed/` tooling, A/Bs it blind against the exemplar, names ONE largest gap with
  evidence; an improver closes exactly that gap; the wave diff is blind-reviewed and staged. `cycles`
  (the wave budget) is required with no default — you are the brake — and every stop lands on a staged
  clean tree, so resume = buy more waves (`startWave`). No mid-run user escalation by design: agents
  settle judgment calls via decision matrix into `SETTLED.md`, the end-of-run audit; only environment
  faults halt. Ships with `plan-block.mjs --kind component`, 49 flow scenarios, and full dead-agent
  coverage. Known cosmetic: its FLOW.md renders one overlapping edge label (`code-gate → build` carries
  two); the structural fix belongs in `gen-flows.mjs`.

### 2026-08-02

- **All eight skills are model-invocable, and the auditor agent is gone.** The three build skills'
  `disable-model-invocation` flag also hid them from Claude's context, so calling one out by name
  ("use the aipg feature workflow") only worked as a slash command — dropped; the opt-in gate is each
  description's "only when the user explicitly asks" clause, which `tests/skills.test.mjs` now
  enforces in the new direction. The `workflow-principles-auditor` agent registered in every project
  a user-level install touched — deleted; audit an engine by running debug with
  `principles/WORKFLOW-PRINCIPLES.md` as a lens, keeping the principles doc the single source of truth.
- **Principle #15 is now machine-checked, and the plan-defect wedge is closed** (batch h2, phased):
  `tests/dead-agent.test.mjs` kills every agent role once per engine and demands a visibly different
  outcome — building it exposed and fixed four real launderers (feature-cycle's dead develop/quality/
  acceptance read as `done (staged)`; docs-cycle's dead scrubber logged `✓ scrubbed: 0 file(s)`).
  And a blind-review finding that indicts the PLAN's own text is no longer a dead end: a developer
  that VERIFIES the defect fixes it and records the override in `AMENDED-<id>.md` (read by
  acceptance, never the blind reviewer), so the wt-land-style wedge cannot recur.
- **First live parallel batch shipped two hardening features** (`planpath-guard` + `attestation-scoping`),
  built simultaneously in worktrees and landed through `aipg/int-h1` — the wt.mjs lifecycle's own
  shakedown. The features: feature + migrate now **warn when a plan file resolves inside `target.repo`**
  (blindness by placement made structural), and the attestation sweep **binds each schema's consumer
  check to its `agent()` call's receiver variable** (closing the shared-field-name mask; three
  previously-hidden dead `notes` fields got real consumers).
- **Every code-review role now runs on opus** (feature/migrate/resolve blind quality critics + debug's
  review finder). Measured on the wt-tooling build: the fast tier surfaced one deep-verified defect per
  round on large diffs, serializing discovery across rounds and burning the round budget.

### 2026-08-01

- **Parallel runs via batch worktrees: `tools/wt.mjs` + [`docs/worktree-batches.md`](docs/worktree-batches.md).**
  Run several engine runs at once, each chain in its own git worktree (`init`/`prep`), landed one at a
  time into a per-batch integration branch (`land`: index-only accept commit → sync → gate on the merged
  state → merge, serialized by a heartbeat-liveness lock) and cleaned without `--force` so unlanded work
  is refused, not deleted. A `reference-transaction` hook refuses `git stash` inside `aipg-*` worktrees —
  `refs/stash` is the one stack every worktree shares, and a stray `pop` would inject one chain's work
  into a sibling's blind-review diff. Built from the `worktree-parallelism-1` decide run (E-c); engines
  unchanged — a worktree is just a different `target.repo`.
- **New principle #15: "A missing result is its own outcome — fail loud, resume clean."** A dead/null
  agent must never be conflatable with success, a clean verdict, or an empty result; every `agent()`
  consumption site states its death policy (solo critical → throw, build loop → park, auxiliary → log +
  record), write-attestations must be consumed, and any failure resumes through the same clean-tree +
  durable-trail mechanism as everything else. A debug run over the engines themselves found and fixed
  the five engines that violated it (dead-agent visibility guards in review, resolve, enhance, migrate;
  plus gate and numeric-arg validation).
- **Plan mode is now the agent's judgment call** (feature + migrate guides): default INTO plan mode when
  the task is complex, needs the user's answers, or touches something important; skip it when simple,
  obvious, or already planned — the user always has the final say. A plan authored without plan mode
  lives at `plans/<runId>/` under `root` (the plugin data dir when installed), same rules as snapshots.
- **The repo is now a Claude Code plugin (`aipg`) and its own marketplace (`aipromptguide`).**
  `/plugin marketplace add Blakeem/aipromptguide-workflows` → `/plugin install aipg@aipromptguide`.
  The copy-me command templates in `commands/` became plugin **skills** (`skills/<x>/SKILL.md`), so the
  triggers are now namespaced: `/aipg-feature` → **`/aipg:feature`**, and likewise for all eight. A
  bare checkout still works exactly as before (root `CLAUDE.md` router, `root` = the checkout); the
  old copied `/aipg-*` commands keep working against a checkout but no longer ship.
- **Run-state moved out of reach of plugin updates.** Installed, the engines live in the version-swapped
  plugin cache; the skills therefore point `root` at the plugin's persistent data dir
  (`~/.claude/plugins/data/…`), where `runs/<runId>/` and `plans/<runId>/` survive updates — and stay
  outside every target repo, where the blind reviewer cannot reach them.
- **`feature` and `migrate` take `blockTool`** (optional): the absolute path to `plan-block.mjs` for
  the roadmap/section block command, defaulting to `<root>/tools/plan-block.mjs` as before. Required in
  practice when `root` is not a checkout (the plugin data dir has no `tools/`); the skills pass it
  automatically.
- **`feature` and `migrate` document an autonomous path** — the user hands a finished plan (or says to
  run unattended): skip plan mode, snapshot the plan to `plans/<runId>/` if a reviewer could reach it
  (inside `target.repo` or `runs/`), refine as usual, resolve refine's questions conservatively when
  unattended, then build. Approval comes from the user's own plan; the blind reviewer still never sees
  one.
- **The official Claude Code plugin docs are captured under `docs/claude-code-plugins/`** (verbatim,
  via docs-cycle) for building against.

### 2026-07-29

- **`investigate` knows when to stop looking — and says so without claiming it finished.** Two new
  terminal states, never folded into "exhaustive". **`stopped on saturation`**: from round 2 the
  investigator watches its own yield collapse, writes a determination with a new **WHERE NEXT** section
  (the unswept avenues, and the premise change that would open new space) and the critic verifies the
  collapse before the run ends — the search is reported **open**, not closed. **`stalled`**: a round that
  adds nothing at all — no option, no ledger line, no claim — stops the run immediately instead of buying
  another empty round. A round that rules candidates out is still progress and keeps going.
- **`investigate` remembers which ground it swept, not just which candidates died.** A second append-only
  file, `SEARCHED.md`, records every avenue each round covered — with the search terms it used and what
  they yielded — plus the most promising avenue still untried. Until now that survived only in the
  *terminating* round's determination, so every other round was free to re-run the last one's searches with
  the same terms and call the same candidates new.
- **A coverage contest now costs the critic a citation.** Contesting "the search is finished" used to be
  free: name any avenue, buy a whole round. It must now carry a source and locator connecting that avenue
  to the criterion or search-space bound it puts back in play.
- **`decide` says why it could not converge instead of guessing.** The reviewer now slugs every gap it
  raises, so a run that spends its round budget can tell two opposite failures apart: the same gaps
  coming back (the decider is not resolving them — the hand-back names them and the reviews that first
  raised them) versus new gaps every round (the question is under-specified). The per-round split is on
  the return as `gapRounds`, and the last non-agreeing review ends with a **WHERE NEXT** section — the
  requirement axis the rubric does not settle, and the change that would let a decision converge.

### 2026-07-28

- **`investigate` produces a real determination.** `DETERMINATION.md` now has a fixed shape — the
  qualifying options, a comparison over the axes they actually *differ* on, which to pick when, the near
  misses, and the coverage evidence — and it is written even when the search runs out of rounds (labelled
  a partial result) instead of leaving you a folder of option files with no comparison. Options stay
  **unranked** on purpose: qualification is pass/fail, and ranking is `decide`'s job.
- **`investigate` keeps near misses.** A candidate that failed *exactly one* criterion is marked in the
  ledger with the shortfall in numbers and gets its own section in the determination. When nothing
  qualifies, that is usually the most useful thing the run found — it is what relaxing a criterion would
  put back on the table.
- **Fixed: `investigate` could report an option the critic had disqualified.** A later round knocking out
  an option an earlier round upheld left it in the answer set, contradicting the run's own ledger.
- **Fixed: a malformed `maxRounds` silently did nothing.** A non-number coerced to NaN and the round loop
  exited before its first pass — in `investigate`, `decide` and `docs` the run finished having spawned
  **no agents at all** and reported it as an ordinary "ran out of rounds"; in `feature`, `migrate` and
  `debug/resolve` the unit parked without a developer ever running. All six throw now, as do values that
  merely *coerce* to a legal number (`""`, `false` and `[]` are each `0`) and used to switch off a budget
  floor or `docs`' verbatim spot-check.
- **`enhance` reports what its impact floor cut.** Candidates below `minImpact` are removed before
  verification and appear in no proposal file, so a floor set too high used to look identical to a clean
  system. `summary.belowFloor` tells you which one you are looking at.
- **A `feature` roadmap is ONE approved plan file** of `## Plan: <id>` blocks — no more hand-splitting into
  per-feature files. Each agent in `feature` and `migrate` is handed a command that prints only its own
  block, so the other units never enter its context.
- **Flow maps render reliably.** Self-loop conditions moved into a Loops table below the diagram, so a long
  label can no longer land on a neighbouring box. All nine render clean on both the current Mermaid and the
  version GitHub serves.

### 2026-07-27

- **New workflow: [investigate](workflows/investigate/)** (`/aipg-investigate`) — finds an answer that
  already exists and qualifies it against **pass/fail** criteria, stopping when the search can be
  *evidenced* as complete rather than when the first answer works. "Nothing qualifies" is a verified
  result, not a failure. Use `decide` when the work is weighing trade-offs instead.
- **Every workflow ships a flow map** — a `FLOW.md` beside each engine (linked in the table above)
  diagramming every agent, gate, loop and terminal state, rendered inline by GitHub. They are generated by
  *watching* each engine run, so a diagram can only show a path that really executes. Worth reading before
  a run you haven't done before: the terminal states are where two very different outcomes read alike.
- **Fixed: dead agents reported success.** In `feature` and `migrate` a `refine` plan critic that died
  returned a verdict indistinguishable from "your plan is sound"; in `migrate` a died final sweep read as
  zero coverage gaps. Both now fail loudly instead.
- **Fixed: `migrate` told you to resume into a red build.** A parked section that cleared the tree but left
  the build broken now halts as unsafe, matching `feature` and `debug`.

### 2026-07-26

- **New workflow: [enhance](workflows/enhance/)** (`/aipg-enhance`) — audits a working system for
  enhancements worth writing up, and stops for you to triage. Defects still belong in `debug`.
- **Work is never discarded.** A feature, section, or fix batch that can't pass is now **parked**: saved to
  `runs/<runId>/parked-<id>.patch`, cleared from the tree, with the `git apply` restore command written
  into `NEEDS-USER.md`. It used to be rolled back and lost. A parked feature no longer stops a `feature`
  roadmap either — it parks and builds the next plan; `migrate` still stops, because its sections depend
  on each other.
- **The build engines check your working tree first.** A dirty tree halts before any agent does work,
  naming the two commands that fix it, rather than reviewing your uncommitted changes as its own.
- **`target.repo` is now required** on every engine that writes code, instead of quietly defaulting to the
  checkout's own folder, so a typo can't retarget the wrong project (see *One checkout, many projects*).
- **`debug`'s review pass takes a lens *array*** — sweep the same code from several angles in one pass,
  merged into one issue file per unit — and returns the issue index, so there's no hand-grepping to build
  the fix loop's input.
- **`decide` gains `selection: "ranked"`** — a ranked shortlist instead of one winner, when the answer is
  legitimately a portfolio.
- **`docs` spot-checks captured files against their source**, so the verbatim promise is tested rather than
  asserted.

### Earlier

- **2026-07-07** — the research workflow became **docs**: verbatim capture, curated and indexed.
- **2026-07-04** — renamed `upgrade` → **migrate** and `review` → **debug**. `feature` gained the `plans`
  roadmap, so several approved features can be built in one run.
- **2026-07-01** — `decide` gained a `testbed` so claims get measured instead of asserted.

## Requirements

- **Claude Code** with the background **Workflow** capability.
- The target is a **git repository** (staging is how regressions are caught, and you do the commit).
- **Build and test commands** for your project. You provide them, and the engines run them and read
  pass/fail.
- For frontend work: optionally a browser/MCP driver (Chrome DevTools MCP, Playwright, MCP inspector),
  else a `curl`/manual fallback.

## Support

If these workflows save you time, you can sponsor their development via
[GitHub Sponsors](https://github.com/sponsors/Blakeem).

## License

[MIT](LICENSE) © Blakeem
