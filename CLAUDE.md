# AI Prompt Guide workflows — router (for Claude)

This is the **AI Prompt Guide workflows** checkout (usually `aipg/`). This file only routes — it carries
no workflow instructions. Pick the match, then read that workflow's `CLAUDE.md` and follow it exactly
(it drives plan mode + approval *before* the engine runs):

| Want to… | Read & follow |
|----------|---------------|
| Build **one bounded feature** (new MCP tool, endpoint, page, form, contained enhancement, design-needing bugfix) | `workflows/feature/CLAUDE.md` |
| **Review** a repo/change for production-blocking defects (triage → batched fixes) | `workflows/review/CLAUDE.md` |
| Drive a **breadth-spanning migration/upgrade/refactor** across many call sites | `workflows/upgrade/CLAUDE.md` |
| **Brainstorm** several fully-committed variations (one per lens) for a human to pick/combine — creative, no AI verdict | `workflows/brainstorm/CLAUDE.md` |
| **Decide** among approaches — lensed analysis → weighted matrix → a justified conclusion, adversarially reviewed | `workflows/decide/CLAUDE.md` |
| **Research** a question across sources (web/repo/api/docs) → verify → a cited report/spec/assessment | `workflows/research/CLAUDE.md` |
| Audit a workflow engine against the design rules | `principles/WORKFLOW-PRINCIPLES.md` + the `workflow-principles-auditor` agent |

Right-size first: trivial one-liner/rename → just edit, no workflow. Then by intent — **build** one
bounded change → feature; one goal spanning many files → upgrade; find production defects → review.
**Diverge** (creative options, human judges) → brainstorm; **converge** (AI concludes among options) →
decide; **inform** (gather + verify + synthesize) → research. The last three are generative/read-only:
no code, no staging, no commit (they honor only the core principles — see WORKFLOW-PRINCIPLES.md "Scope").

Each engine loads **by path** (no global registry): pass `scriptPath` = the absolute path to the
workflow's `.mjs`. Its `CLAUDE.md` covers the full flow, args, and contracts.

## House style

Write everything here — prompts, guides, reviews, commits, replies to me — **laconic by subtraction**
([`principles/WORKFLOW-PRINCIPLES.md`](principles/WORKFLOW-PRINCIPLES.md) #13): cut filler, what I
already know, and the irrelevant; never compress away what I need to act on.
