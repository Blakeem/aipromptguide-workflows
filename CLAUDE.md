# AI Prompt Guide workflows — router (for Claude)

This is the **AI Prompt Guide workflows** checkout (usually `aipg/`). This file only routes — it carries
no workflow instructions. Pick the match, then read that workflow's `CLAUDE.md` and follow it exactly
(it drives plan mode + approval *before* the engine runs):

| Want to… | Read & follow |
|----------|---------------|
| **Build** from an approved plan file: one bounded feature, an ordered roadmap of them, a migration across many call sites, or a triaged issue inventory. Each `## Plan:` block's `mode` (`feature`, `section`, `fix`) picks the frame | `workflows/develop/CLAUDE.md` |
| **Refine** a plan file before develop builds it: a read-only critic under a fixed defect bar and a minimal-fold editor, until one clean round | `workflows/refine/CLAUDE.md` |
| **Debug**: find production defects in a repo or change. Its triaged issue files are fix-mode plan files develop builds. Bring your own inventory from manual testing the same way | `workflows/debug/CLAUDE.md` |
| **Enhance** a system that already works — lensed audit → verified, impact-scored proposals you triage (nothing auto-applied) | `workflows/enhance/CLAUDE.md` |
| **Brainstorm** several fully-committed variations (one per lens) for a human to pick/combine — creative, no AI verdict | `workflows/brainstorm/CLAUDE.md` |
| **Decide** among approaches — lensed analysis → weighted matrix → a justified conclusion, adversarially reviewed | `workflows/decide/CLAUDE.md` |
| **Investigate** — find an answer that already exists and qualify it against fixed pass/fail criteria, until nothing qualifying is left unsearched | `workflows/investigate/CLAUDE.md` |
| Gather the **docs** a project needs — verbatim capture (web/repo/files) → curate + index into a working folder | `workflows/docs/CLAUDE.md` |
| Audit a workflow engine against the design rules | `principles/WORKFLOW-PRINCIPLES.md` — e.g. as a lens in a debug run |
| Run several engine runs **in parallel** — one batch, one worktree per chain, landed into an integration branch | `docs/worktree-batches.md` (`tools/wt.mjs`) |

Right-size first: trivial one-liner/rename → just edit, no workflow. Then by intent. **Build** → author a
plan file (one `feature` block per bounded change, `section` blocks for one goal spanning many files),
refine it, approve it, develop it. Find production defects → debug, then develop its fix-mode files.
**Audit** (what a working system could do better; human triages) → enhance; **diverge** (creative options,
human judges) → brainstorm; **converge** (AI concludes among options it generates) → decide; **search**
(the answer already exists; find it and prove it meets fixed criteria) → investigate; **provision** (copy +
curate the docs to build against) → docs. The last five are generative/read-only: no code, no staging, no
commit (they honor only the core principles — see WORKFLOW-PRINCIPLES.md "Scope").

**Defect vs. enhancement is the sharpest split here.** Something the system gets *wrong* → debug, whose
inventory feeds an autonomous fixer. Something it could do *better* → enhance, which stops at proposals
and never auto-applies. Keep them apart: an improvement list would not converge the way debug's closed
inventory does.

**Decide vs. investigate is the other one.** No established answer, and the work is *weighing trade-offs*
among approaches the AI generates → decide, which converges on reviewer agreement about an argument. The
answer is already out there, and the work is *finding it and proving it fits* → investigate, which
converges on evidenced coverage. The tell: if you want to trade requirement A off against requirement B,
that is decide's weighted matrix; if missing A is simply disqualifying, that is investigate's pass/fail
gate.

**Into the plan bus.** The generative workflows feed develop through plan files you author from their
outputs. enhance's approved proposals map by class: ADOPT → a feature-mode block, a ROADMAP proposal
spanning many call sites → a section-mode block, a proposal the verifier flagged `is_defect` → a
hand-authored fix-mode block in debug's verifier format. brainstorm's picked variation, decide's
conclusion, and investigate's determination feed a plan's design section — convention, not tooling.
Authored blocks then flow refine → your approval → develop, and debug's review writes fix-mode blocks
develop consumes directly.

Each engine loads **by path** (no global registry): pass `scriptPath` = the absolute path to the
workflow's `.mjs`. Its `CLAUDE.md` covers the full flow, args, and contracts.

**Launch from a notification turn.** The Workflow runtime copies the user message of the launching turn
into every agent's prompt, ahead of its task. That breaks blind placement, and a sonnet agent may follow
the message over its task. A turn started by a background task's notification carries no user message.
So run the workflow's pre-launch command with `run_in_background`, and call the Workflow tool in the turn
its notification starts. The pre-launch command is `plan-edit.mjs args` for develop,
`plan-block.mjs <planPath> --list` for refine, and `git -C <target.repo> status --short` for the rest.

**Two paths, never the same directory:** `target.repo` = the project being worked on (the folder holding
its `.git`); `root` = where run-state lands (`<root>/runs/<runId>/`), normally this checkout. Keeping
them apart is what keeps the issue files out of reach of the blind reviewer, and is what lets one
checkout drive many projects. The engines that write code **throw** rather than default `target.repo` —
see the root README, "One checkout, many projects".

**This repo is also the `aipg` Claude Code plugin** (manifests in `.claude-plugin/`, entry points in
`skills/<x>/SKILL.md` → `/aipg:<x>`). Installed, the skills resolve the plugin paths and point `root`
at the plugin's persistent data dir instead of a checkout. The Workflow tool refuses a `scriptPath`
the session cannot already read, and an installed plugin's folder is outside every project. So each
skill first runs `tools/plugin-access.mjs`, which adds one Read rule for the plugin folder once the
user agrees. Rename an engine, guide, `tools/plan-block.mjs`, `tools/plugin-access.mjs`, or
`workflows/debug/gen-units.mjs` and the matching `skills/<x>/SKILL.md` paths must move with it.

**Want to see what a run actually does?** Each workflow ships a generated `FLOW.md` beside its engine
(`workflows/<x>/FLOW.md`; debug's is `FLOW-review.md`) — every agent, gate, loop and
terminal state, drawn from real traced runs. Read one before driving a workflow you have not run before.
Edit an engine and you must re-run `node tools/gen-flows.mjs`, or the suite goes red.
The generator and the rest of the repo's own machinery are catalogued in [`tools/CLAUDE.md`](tools/CLAUDE.md).

**Changing anything here?** Read [`tests/CLAUDE.md`](tests/CLAUDE.md) first — the development gotchas
(this file and each workflow's `CLAUDE.md` are for *running* the workflows; that one is for *editing*
them). Above all: a defect found in one engine is usually in its siblings too — grep before you call it
fixed. `node tests/run.mjs` is the gate; run it before and after, add a case for what you changed
([`tests/README.md`](tests/README.md)), and point a workflow's `gates.build`/`gates.test` at it when
working on this repo.

## House style

Write everything here — prompts, guides, reviews, commits, replies to me — **laconic by subtraction**
([`principles/WORKFLOW-PRINCIPLES.md`](principles/WORKFLOW-PRINCIPLES.md) #13): cut filler, what I
already know, and the irrelevant; never compress away what I need to act on.
