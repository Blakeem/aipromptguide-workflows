# research-cycle

An autonomous Claude Code workflow that answers a question needing **several sources cross-checked** —
gathering from the web, your repo, an external API, or a doc set, **adversarially verifying** each
load-bearing claim, then synthesizing a **cited** deliverable.

You frame the question and the angles to mine. Claude runs one gatherer per angle (each writing cited
findings), an independent verifier per angle that *tries to refute* every key claim, then a synthesizer
that builds the answer from what survived — excluding refuted claims and flagging what's still uncertain.

### What sets it apart

A **gather → verify → synthesize** pipeline built on the shared [Workflow Principles](../../principles/):

- **Verify before trust.** Findings don't go straight into the answer — an adversarial pass checks each
  load-bearing claim against its source first. Refuted claims are dropped; uncertain ones are flagged,
  never presented as settled.
- **Cited end to end.** Every claim carries its source; the per-angle findings and verdicts are the
  audit trail behind the deliverable.
- **One engine, three deliverables.** `report` (answer a question), `spec` (document an external API or
  an internal feature contract — with acceptance criteria), or `assessment` (knowns/unknowns +
  consequences for a go/no-go).
- **Reach beyond the web.** Mine your repo and external APIs too, and persist per-source files that feed
  [`feature-cycle`](../feature/) and [`decide-cycle`](../decide/) — where a web-only deep dive is better
  served by the `deep-research` skill.
- **Read-only.** Nothing is written to, staged, or committed in your repo; the deliverable lands in
  run-state for you to keep or discard.

---

## Scope: is this the right tool?

- ✅ **Right size:** a question worth mining ≥2 sources and cross-checking — an API/library evaluation, a
  "how does X actually work" dig across repo + docs, a spec to hand an implementer, a go/no-go.
- ❌ **One doc page answers it:** just read it.
- ❌ **Pure web deep dive, no repo/API/spec output:** the `deep-research` skill fits better.
- ➡️ **Then decide or build:** feed the output to [`decide-cycle`](../decide/) or [`feature-cycle`](../feature/).

---

## How to use it

Ships in the [AI Prompt Guide workflows](../../README.md) repo (clone as `aipg/`, copy the slash
commands). Trigger it:

- **Slash command:** `/aipg-research evaluate Stripe vs Adyen for our checkout — fees, API ergonomics, SCA support`
- **Plain pointer:** tell Claude to *use the research-cycle **workflow** in `aipg/workflows/research/`*
  and what to find out.

Claude reads `aipg/workflows/research/CLAUDE.md`, frames the question + angles + output kind with you,
then runs `research-cycle.mjs` **by path**.

1. **Gathers.** One researcher per angle (web/repo/api/docs) writes cited findings.
2. **Verifies.** An adversarial pass refutes what it can, per angle.
3. **Synthesizes.** Builds the report/spec/assessment from the verified evidence and answers the brief.

---

## Reviewing the result

Under `runs/<runId>/`: the deliverable (`REPORT.md` / `SPEC.md` / `ASSESSMENT.md`), the per-angle
`findings/`, and the `verify/` verdicts. Read the deliverable for the answer + confidence + open
questions; the findings and verdicts are the audit trail. Copy the deliverable into your repo/docs if you
want to keep it.

---

## Requirements

- **Claude Code** with the background **Workflow** capability.
- **Web access** in your session (WebSearch/WebFetch) for `web`/`api` angles; not needed for
  `repo`/`docs` angles.
- A target git repo only for `repo` angles (read-only). Nothing is ever written to it.
