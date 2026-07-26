# brainstorm-cycle

An autonomous Claude Code workflow that generates several **distinct, fully-realized variations** of one
creative thing — a web/slideshow design, a product idea, a business-plan angle — **one per lens**, so you
can pick one, ask for a hybrid, or cherry-pick the best parts of each.

You name what you're exploring and the angles to explore it from. Claude spawns one generator per angle,
each committing fully to its lens, and drops every variation in its own folder for you to compare. It's
**divergent on purpose**: no scoring, no AI review, no "winner" — you're the judge.

### What sets it apart

A deliberately **lean, loose** workflow built on the shared [Workflow Principles](../../principles/):

- **Divergence, not convergence.** Each generator pushes its lens as far as it sensibly goes instead of
  hedging toward a safe average. That spread is what makes the variations worth comparing.
- **One brief, read verbatim.** Every generator works from the same brief (a one-liner, or a richer
  requirements file you write in plan mode for a complex problem). Nothing is paraphrased between agents.
- **The harness only routes.** The script fans out and passes folder paths and control signals — never
  paraphrased content.
- **Your repo is untouched.** Variations land in `runs/<runId>/variations/`; nothing is written to,
  staged, or committed in your codebase. You adopt what you like afterward.

To have the AI *conclude* among options with a weighted decision matrix, use the sibling
[`decide-cycle`](../decide/). To *build* a chosen direction, use [`feature-cycle`](../feature/).

---

## Scope: is this the right tool?

- ✅ **Right size:** one creative problem worth several genuinely different takes (≥2 lenses) — site or
  slideshow designs, product/feature concepts, business-plan angles, naming/branding directions.
- ❌ **One obvious approach:** just produce it directly.
- ❌ **You want a decision, not options:** use [`decide-cycle`](../decide/).
- ❌ **You want it built:** use [`feature-cycle`](../feature/).

---

## How to use it

Ships in the [AI Prompt Guide workflows](../../README.md) repo (clone as `aipg/`, copy the slash
commands). Trigger it:

- **Slash command:** `/aipg-brainstorm 4 landing-page designs: minimalist, bold/editorial, corporate, playful`
- **Plain pointer:** tell Claude to *use the brainstorm-cycle **workflow** in `aipg/workflows/brainstorm/`*
  and what to explore.

Claude reads `aipg/workflows/brainstorm/CLAUDE.md`, agrees the brief + lenses with you (and, for a
complex problem, writes a shared brief in plan mode), then runs `brainstorm-cycle.mjs` **by path**.

1. **Frames it.** Agrees what you're exploring and the lenses (proposes them if you have none).
2. **Generates.** One generator per lens, concurrently, each a complete variation in its own folder.
3. **Presents.** Walks you through each distinct take so you can pick, hybridize, or cherry-pick.

---

## Reviewing the result

Variations land under `runs/<runId>/variations/<lens>/` — open each entry and compare. There are no
review or status files (it's divergent; you're the judge). Pick one, combine elements, then either build
it with [`feature-cycle`](../feature/) or copy it into your repo yourself.

---

## Requirements

- **Claude Code** with the background **Workflow** capability.
- A target git repo is **not** required (brainstorm often needs none). If you point it at one, it's
  read-only context only.
