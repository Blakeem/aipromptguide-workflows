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
| Gather the **docs** a project needs — verbatim capture (web/repo/files) → curate + index into a working folder | `workflows/docs/CLAUDE.md` |
| Audit a workflow engine against the design rules | `principles/WORKFLOW-PRINCIPLES.md` + the `workflow-principles-auditor` agent |

Right-size first: trivial one-liner/rename → just edit, no workflow. Then by intent — **build** one
bounded change → feature (several features → feature's `plans` array); one goal spanning many files →
migrate; find production defects → debug.
**Audit** (what a working system could do better; human triages) → enhance; **diverge** (creative options,
human judges) → brainstorm; **converge** (AI concludes among options) → decide; **provision** (copy +
curate the docs to build against) → docs. The last four are generative/read-only: no code, no staging, no
commit (they honor only the core principles — see WORKFLOW-PRINCIPLES.md "Scope").

**Defect vs. enhancement is the sharpest split here.** Something the system gets *wrong* → debug, whose
inventory feeds an autonomous fixer. Something it could do *better* → enhance, which stops at proposals
and never auto-applies. Keep them apart: an improvement list would not converge the way debug's closed
inventory does.

Each engine loads **by path** (no global registry): pass `scriptPath` = the absolute path to the
workflow's `.mjs`. Its `CLAUDE.md` covers the full flow, args, and contracts.

## House style

Write everything here — prompts, guides, reviews, commits, replies to me — **laconic by subtraction**
([`principles/WORKFLOW-PRINCIPLES.md`](principles/WORKFLOW-PRINCIPLES.md) #13): cut filler, what I
already know, and the irrelevant; never compress away what I need to act on.
