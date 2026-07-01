# decide-cycle

An autonomous Claude Code workflow that drives the AI to a **justified conclusion** among approaches —
weighing real trade-offs through several perspectives and defending the choice with a decision matrix.

You write the requirements (the non-negotiables and the weighted criteria) and name the lenses to judge
through. Claude runs one analyst per lens to surface and score options, a **decider** funnels them into a
single conclusion — pulling in the best elements of each where they compose — and a **non-blind
adversarial reviewer** tries to break it. They loop until they agree.

### What sets it apart

A **diverge-then-converge** workflow built on the shared [Workflow Principles](../../principles/):

- **Lensed divergence, weighted convergence.** Each lens pushes its own best answer; the decider
  balances them in a global weighted matrix — non-negotiables are pass/fail, the simplest adequate
  option is preferred, and every runner-up is explicitly disqualified.
- **A fixed rubric both sides judge against.** The requirements file is the single source of truth for
  the decider *and* the reviewer — which is what makes the loop converge instead of bikeshedding.
- **Adversarial, non-blind review.** Unlike a code review, the reviewer *must* see the decision to judge
  it — so it's non-blind by design, and it attacks the conclusion against the requirements rather than
  rubber-stamping it.
- **A conclusion, not code.** Nothing is staged or committed. The decision feeds
  [`feature-cycle`](../feature/) or [`upgrade-cycle`](../upgrade/) next.

For open-ended creative options a *human* picks (no AI verdict), use [`brainstorm-cycle`](../brainstorm/).

---

## Scope: is this the right tool?

- ✅ **Right size:** one decision with genuine trade-offs worth weighing from several angles — an
  architecture or pattern choice, build-vs-buy, data-model or algorithm selection.
- ❌ **One obvious answer / a reversible coin-flip:** just decide.
- ❌ **You want options, not a verdict:** use [`brainstorm-cycle`](../brainstorm/).
- ❌ **You want it built:** use [`feature-cycle`](../feature/).

---

## How to use it

Ships in the [AI Prompt Guide workflows](../../README.md) repo (clone as `aipg/`, copy the slash
commands). Trigger it:

- **Slash command:** `/aipg-decide pick the cache layer — judge by efficiency, simplicity, robustness, best-practice`
- **Plain pointer:** tell Claude to *use the decide-cycle **workflow** in `aipg/workflows/decide/`* and
  what to decide.

Claude reads `aipg/workflows/decide/CLAUDE.md`, writes the requirements with you in plan mode, picks the
lenses, then runs `decide-cycle.mjs` **by path**.

1. **Frames the rubric.** Plan mode: the decision, the non-negotiables, the weighted criteria.
2. **Diverges.** One analyst per lens generates and scores options.
3. **Converges.** The decider builds the matrix and concludes; the reviewer attacks it; they loop to
   agreement.
4. **Presents.** Relays the matrix + rationale, and the lens files so you can see the source views.

---

## Reviewing the result

Under `runs/<runId>/`: the per-lens analyses (`lenses/<lens>.md`), the decider's matrix and conclusion
(`decision-rN.md`), and the reviewer's objections each round (`decision-review-rN.md`). Read the latest
decision file and skim the lens files to see the trade-offs that shaped it. Then build the chosen
approach with [`feature-cycle`](../feature/).

---

## Requirements

- **Claude Code** with the background **Workflow** capability.
- A target git repo is **optional** — pass one for a decision about existing code (read-only context for
  pattern-fit and feasibility). Nothing is ever written to it.
