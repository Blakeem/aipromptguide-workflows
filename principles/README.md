# Workflow Principles

The shared design rules every [AI Prompt Guide workflow](../README.md) is built to, kept in one place
so they stay in sync.

## What's here

- **[`WORKFLOW-PRINCIPLES.md`](WORKFLOW-PRINCIPLES.md)** — the fourteen principles for designing a
  background `Workflow` engine, the mechanics that follow from them, and a yes/no review checklist.
- **[`workflow-principles-auditor`](../.claude/agents/workflow-principles-auditor.md)** — an agent that
  audits a workflow against those principles and reports violations, gaps, and over-engineering smells.

## In brief

The goal of every workflow is the simplest, lowest-friction path to the outcome — no fluff, no extra
agents. The harness only routes control signals (paths, counts, booleans) and never re-interprets
content; agents exchange full content verbatim through files. Reviews are staged and escalating (blind
pure-code review, then plan-aware acceptance), agents stay stateless and unanchored, and the only
things ever written are numbered inter-agent review files plus the developer's terse ledger and user
notes. Read [`WORKFLOW-PRINCIPLES.md`](WORKFLOW-PRINCIPLES.md) for the full set.

## Using the auditor

1. Copy the agent into your Claude Code agents folder:

   ```bash
   cp ../.claude/agents/workflow-principles-auditor.md ~/.claude/agents/
   ```

2. Have it read `WORKFLOW-PRINCIPLES.md` before you build a new workflow.
3. After building or modifying a workflow engine, run the `workflow-principles-auditor` agent against
   it to catch principle violations and over-engineering.

## Built with these

**Build loops** (code, reviewed and staged): [feature-cycle](../workflows/feature/) ·
[migrate-cycle](../workflows/migrate/) · [debug](../workflows/debug/) (review + resolve)

**Generative / read-only** (no code, nothing staged or committed):
[enhance-cycle](../workflows/enhance/) · [brainstorm-cycle](../workflows/brainstorm/) ·
[decide-cycle](../workflows/decide/) · [investigate-cycle](../workflows/investigate/) ·
[docs-cycle](../workflows/docs/)

Which principles apply to which kind is spelled out in
[`WORKFLOW-PRINCIPLES.md` → Scope](WORKFLOW-PRINCIPLES.md#scope--which-principles-apply-to-which-workflow-kind).
