# AI Prompt Guide workflows — router (for Claude)

You've been pointed at the **AI Prompt Guide workflows** checkout (usually `aipg/` in the user's
project). This file is only a **router** — it carries no workflow instructions. Pick the workflow that
matches the request, then **read that workflow's `CLAUDE.md` and follow it exactly** (it is the
authoritative operator guide and drives plan mode + approval *before* the engine runs):

| If the user wants to… | Read & follow |
|------------------------|---------------|
| Build **one bounded feature** (a new MCP tool, endpoint, page, form, contained enhancement) | `workflows/feature/CLAUDE.md` |
| **Review** a repo or change for production-blocking defects (triage → batched fixes) | `workflows/review/CLAUDE.md` |
| Drive a **breadth-spanning migration/upgrade/refactor** across many call sites | `workflows/upgrade/CLAUDE.md` |
| Audit a workflow engine against the design rules | `principles/WORKFLOW-PRINCIPLES.md` + the `workflow-principles-auditor` agent |

Right-size first: a trivial one-liner/rename → just make the edit (no workflow). Unsure between feature
and upgrade? One bounded change → feature; one goal spanning many files → upgrade.

Each engine loads **by path** (it is in no global registry): pass `scriptPath` = the absolute path to
the workflow's `.mjs`. The matching `CLAUDE.md` explains the full flow, args, and contracts.

## House style: laconic by subtraction

Write everything here — prompts, workflow guides, reviews, commits, and replies to me — to **maximize
signal, not minimize length**. Achieve brevity by **deleting, not compressing**. Delete only three
things: **filler** (preambles, sign-posting, self-narration, my request restated back); **what I
already know** (general knowledge, the spec quoted back, anything already in the code/diff/file in front
of me); and **what is not directly relevant** to the action or decision at hand. **Never** cut
something I need to act on — that is compression, not subtraction, and it is wrong. This is **not a
balance to strike**: cutting noise makes the text shorter *and* clearer at once. Per sentence, ask one
question — *do I need this to act?* No → cut it. Yes → keep it whole. This governs work on this repo,
the `workflow-principles-auditor` review agent, and any new workflow you build
([`principles/WORKFLOW-PRINCIPLES.md`](principles/WORKFLOW-PRINCIPLES.md) #13).
