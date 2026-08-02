# AI Prompt Guide workflows — router (for Claude)

This is the **AI Prompt Guide workflows** checkout (usually `aipg/`). This file only routes — it carries
no workflow instructions. Pick the match, then read that workflow's `CLAUDE.md` and follow it exactly
(it drives plan mode + approval *before* the engine runs):

| Want to… | Read & follow |
|----------|---------------|
| Build **one bounded feature** — or an ordered **roadmap** of them (one approved plan each): new MCP tool, endpoint, page, form, contained enhancement, design-needing bugfix | `workflows/feature/CLAUDE.md` |
| **Debug** — find production defects and/or fix a verified issue inventory (bring your own from manual testing) — triage → batched fixes | `workflows/debug/CLAUDE.md` |
| Drive **one plan across many call sites** — migration/upgrade/port/refactor, in ordered sections | `workflows/migrate/CLAUDE.md` |
| **Enhance** a system that already works — lensed audit → verified, impact-scored proposals you triage (nothing auto-applied) | `workflows/enhance/CLAUDE.md` |
| **Brainstorm** several fully-committed variations (one per lens) for a human to pick/combine — creative, no AI verdict | `workflows/brainstorm/CLAUDE.md` |
| **Decide** among approaches — lensed analysis → weighted matrix → a justified conclusion, adversarially reviewed | `workflows/decide/CLAUDE.md` |
| **Investigate** — find an answer that already exists and qualify it against fixed pass/fail criteria, until nothing qualifying is left unsearched | `workflows/investigate/CLAUDE.md` |
| Gather the **docs** a project needs — verbatim capture (web/repo/files) → curate + index into a working folder | `workflows/docs/CLAUDE.md` |
| Audit a workflow engine against the design rules | `principles/WORKFLOW-PRINCIPLES.md` + the `workflow-principles-auditor` agent |
| Run several engine runs **in parallel** — one batch, one worktree per chain, landed into an integration branch | `docs/worktree-batches.md` (`tools/wt.mjs`) |

Right-size first: trivial one-liner/rename → just edit, no workflow. Then by intent — **build** one
bounded change → feature (several features → feature's `plans` array); one goal spanning many files →
migrate; find production defects → debug.
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

Each engine loads **by path** (no global registry): pass `scriptPath` = the absolute path to the
workflow's `.mjs`. Its `CLAUDE.md` covers the full flow, args, and contracts.

**Two paths, never the same directory:** `target.repo` = the project being worked on (the folder holding
its `.git`); `root` = where run-state lands (`<root>/runs/<runId>/`), normally this checkout. Keeping
them apart is what keeps the issue files out of reach of the blind reviewer, and is what lets one
checkout drive many projects. The engines that write code **throw** rather than default `target.repo` —
see the root README, "One checkout, many projects".

**This repo is also the `aipg` Claude Code plugin** (manifests in `.claude-plugin/`, entry points in
`skills/<x>/SKILL.md` → `/aipg:<x>`). Installed, the skills resolve the plugin paths and point `root`
at the plugin's persistent data dir instead of a checkout. Rename an engine, guide,
`tools/plan-block.mjs`, or `workflows/debug/gen-units.mjs` and the matching `skills/<x>/SKILL.md`
paths must move with it.

**Want to see what a run actually does?** Each workflow ships a generated `FLOW.md` beside its engine
(`workflows/<x>/FLOW.md`; debug has `FLOW-review.md` + `FLOW-resolve.md`) — every agent, gate, loop and
terminal state, drawn from real traced runs. Read one before driving a workflow you have not run before.
Change an engine's control flow and you must re-run `node tools/gen-flows.mjs`, or the suite goes red.
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
