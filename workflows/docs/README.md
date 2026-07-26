# docs-cycle

An autonomous Claude Code workflow that builds the **local doc set a project needs** — copying official
documentation **verbatim** from the web, a repo, or local files, then curating it into an organized,
**indexed** folder a coding LLM can work from.

You frame the brief (what the docs are *for*, which versions), the sources to pull, and where the set
should live — a fresh folder dedicated to this one doc set, usually `docs/<system>/` in your project.
Claude runs one gatherer per source (each copying the relevant pages verbatim, with source + version
headers), a fast scrub pass that strips capture junk, then a curator that organizes and splits the set,
deletes what the brief doesn't need, writes `INDEX.md`, and checks the sources against each other —
filling coverage gaps with a bounded follow-up gather.

### What sets it apart

A **gather → curate** loop built on the shared [Workflow Principles](../../principles/):

- **Docs are copied, never rewritten.** Content travels verbatim; cleanup is *subtraction* — dropping
  nav, marketing, and irrelevant versions — never summarizing. What lands in the folder is what the
  source says, with its URL/path, version, and retrieval date on every file.
- **No busy-work verifier.** A claim-verifier exists to catch paraphrase drift; verbatim capture leaves
  none. The curator — the one agent that reads the whole set — does the checks that still matter:
  **cross-source inconsistencies** (version mismatches, contradictions) and **coverage gaps** vs. the
  brief.
- **The verbatim promise is tested, not asserted.** Once the index is written, the curator re-opens the
  source a handful of captured files cite and compares a passage word for word. A rewritten passage
  fails and gets recaptured; an unreachable source is reported as *unchecked* rather than passed.
- **Indexed for LLM use.** `INDEX.md` gives one line per file — what it covers, when to read it — plus
  Coverage notes, so the agent building your feature finds the right doc without reading everything.
- **Gap-fill loop.** Gaps the curator finds spawn targeted gathers (bounded by `maxRounds`); anything
  still open is listed in Coverage notes rather than silently missing.
- **Community claims get tested, not trusted.** An optional `testbed` (e.g. read-only `curl` against a
  live API) makes gatherers verify non-official claims empirically — command + response recorded
  verbatim — before they enter the set; official docs are captured as-is.
- **Read-only.** Writes only the doc folder (run-state by default, or an `outDir` you choose); nothing
  is ever staged or committed.

---

## Scope: is this the right tool?

- ✅ **Right size:** a task worth a curated local doc set — an API integration (official reference), an
  upgrade (release notes + migration guide + current docs), a feature touching several documented systems.
- ❌ **One doc page answers it:** just read/fetch it.
- ❌ **You want an answer, not docs:** a synthesized, fact-checked report is the `deep-research` skill;
  deciding among options is [`decide-cycle`](../decide/).
- ➡️ **Then build:** point a [`feature-cycle`](../feature/) or [`migrate-cycle`](../migrate/) plan at the
  folder + `INDEX.md` — the implementer reads the official docs verbatim instead of a rewritten spec.

---

## How to use it

Ships in the [AI Prompt Guide workflows](../../README.md) repo (clone as `aipg/`, copy the slash
commands). Trigger it:

- **Slash command:** `/aipg-docs pull the Stripe Payment Intents docs (API v2024-06-20) for our checkout integration`
- **Plain pointer:** tell Claude to *use the docs-cycle **workflow** in `aipg/workflows/docs/`* and what
  the project needs.

Claude reads `aipg/workflows/docs/CLAUDE.md`, frames the brief + sources with you, then runs
`docs-cycle.mjs` **by path**.

1. **Gathers.** One gatherer per source copies the brief-relevant docs verbatim, source-headed.
2. **Scrubs.** A fast pass per source strips capture junk (nav fragments, widgets, broken markup) in
   place — no words changed.
3. **Curates.** A curator organizes + splits the set, deletes the irrelevant, writes `INDEX.md`, and
   flags cross-source inconsistencies.
4. **Fills gaps.** Coverage holes — or files needing recapture — trigger a bounded follow-up gather,
   then a re-index.

---

## Reviewing the result

Under `runs/<runId>/docs/` (or your `outDir`): the curated set — `<source>/*.md` verbatim docs plus
`INDEX.md`. Start at the index: one line per file, then **Coverage notes** with any cross-source
inconsistencies, unresolved gaps, and how many files were spot-checked against their source. Copy the
folder into your repo if you want to keep it, or pass `outDir` up front.

**Give it its own folder.** The output directory belongs to the run: the curator deletes freely inside
it, which is what lets it dedup, split, and re-curate the whole set. Point it at a fresh directory per
doc set (`docs/stripe/`, not `docs/`). Anything in there the run neither captured nor wrote is left
untouched and reported back — a sign the folder was shared, and to move that content out before the
next run.

---

## Requirements

- **Claude Code** with the background **Workflow** capability.
- **Web access** in your session (WebSearch/WebFetch) for `web` sources; not needed for `repo`/`files`
  sources.
- A target git repo only for `repo` sources (read-only). Nothing is ever written to it.
