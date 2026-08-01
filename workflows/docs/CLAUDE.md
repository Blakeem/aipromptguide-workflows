# docs-cycle — operator guide (for Claude)

`docs-cycle.mjs` provisions the **local doc set a project needs to build against**: one **gatherer** per
source (web / repo / local files) **copies the relevant docs verbatim** into a folder — selection and
subtraction at capture, never paraphrase — a **scrubber** cleans each source of capture junk in place,
then a **curator** organizes and splits the set, deletes what the brief doesn't need, writes `INDEX.md`,
checks **cross-source consistency + coverage**, and finally **spot-checks a bounded sample** of files
against their cited sources; gaps it finds (missing coverage *or* files needing recapture) drive a
bounded gap-fill gather round. Built to `../../principles/WORKFLOW-PRINCIPLES.md` — a
*provision* workflow honoring the core (#1–4, #6, #8, #11–14). It is deliberately **happy-path**: no
review loop or blind reviewer (Scope: the user judges); the gap loop is the only feedback. There is
**no claim-verifier agent by design**:
a verifier exists to catch the gap between a gatherer's *paraphrase* and its source, and verbatim capture
leaves no such gap. What remains checkable — coverage, cross-source consistency, and the one sample that
tests the verbatim promise — needs the whole set at once, so it lives in the curator (#4). Nothing is
written outside `outDir` (an engine-owned folder), staged, or committed.

## 1. Scope (check FIRST)

Right size: a task worth a **curated local doc set** — an API integration (the official reference), an
upgrade (release notes + migration guide + current docs), a complex feature touching several documented
systems. Too small (one doc page answers it) → just read/fetch it. Want a synthesized **answer** to a
question → the `deep-research` **skill**. Want to **decide** among options → `decide-cycle`. The output
folder here is the ideal input to a `feature-cycle`/`migrate-cycle` plan — the implementer reads the
official docs verbatim instead of a rewritten spec.

## 2. The flow

Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `docs-cycle.mjs` + args.
No mid-run questions — frame it with the user first:

1. **Frame the brief + sources + destination with the user.** The brief says what the docs are **for** —
   task, systems touched, and **versions in scope** (it decides every keep/skip). The sources are the
   doc sets to pull: for an API, usually just its official reference; for an upgrade or cross-system
   work, several (release notes, migration guide, each system's docs). Settle **where the set should
   live** (`outDir`): a **fresh directory dedicated to this one doc set** — e.g. `<repo>/docs/stripe/`,
   one folder per system/API, created if missing. The engine owns that folder (§3); no destination →
   run-state, copy out later. A complex brief goes in **`EnterPlanMode`**, approve, pass `planPath`; a
   simple one inline as `brief`.
2. **Run** the engine (`sources` + `brief`/`planPath` + `outDir`). It gathers verbatim, scrubs capture
   junk, curates + indexes, fills gaps (bounded by `maxRounds`), and returns the folder + index paths
   and counts.
3. **Present** the set: read `INDEX.md` (including **Coverage notes**) and relay what was gathered, any
   cross-source inconsistencies, unresolved gaps, and the fidelity spot-check (`fidelity.checked` /
   `fidelity.failures` — a low or zero count means the verbatim promise went *untested*, not that it
   held). If the return sets `foreignContent`, **warn the user first**: `outDir` was not a dedicated
   folder (§3). If `indexWritten` is false the curator never confirmed writing `INDEX.md` — say so and
   check the file exists before relying on the set. Without `outDir` the set sits in gitignored
   run-state — copy it into the project (or re-run with `outDir`) if it should persist. Point the
   working agent/plan at the INDEX.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (this checkout — or, from the installed
  aipg plugin, the persistent data dir the skill resolves, never the version-swapped install dir).
- **`sources` — REQUIRED:** the array from §4 (strings = web sources, or `{ id, kind, focus }`).
- **`brief` (inline) OR `planPath` — one REQUIRED.** Include the versions in scope — the gatherers
  capture for those versions and the curator flags mismatches.
- **`target.repo`** is required only if any source has `kind:"repo"` (else that gatherer has nothing to
  read — the engine warns).
- **Web sources need web access** in your session (WebSearch/WebFetch). Repo/files sources don't.
- **`testbed` (optional):** how agents may **empirically verify** claims (e.g. read-only `curl` against
  a live API — include required headers/rate limits). With it set, claims from **non-official** sources
  are treated as hypotheses: verified against the testbed before capture, the exact command + response
  recorded verbatim next to the claim (#14); unverifiable → marked UNVERIFIED or left out. Official
  docs are captured as-is. Keep it read-only by construction, and **pre-allowlist the commands** (e.g.
  `Bash(curl *)`) in the project's settings — a background run can't answer permission prompts. If the
  testbed carries a **credential** (an API key), pair it with a redaction rule ("record commands with
  the key as REDACTED") so it never enters a doc file; the engine hands the testbed only to the roles
  that verify (gather, curate) — the scrubber never sees it — but it still lands in those agents'
  prompts and transcripts, so use a low-stakes key.
- **`outDir` (optional but usually wanted) — the folder is ENGINE-OWNED:** where the curated set lands,
  decided with the user (§2.1). Point it at a **fresh directory dedicated to this one doc set**
  (`<project>/docs/<system-or-api>/`, created if missing) — never a shared or pre-existing docs folder:
  the curator **deletes freely inside it**, and that whole-set authority is what makes curation, dedup
  and re-curation work. Anything it finds there that this run neither captured nor wrote is left alone
  and reported (`foreignContent` + `foreignPaths` in the return) — that report means `outDir` was
  pointed at the wrong folder; move the content out or pick another dir before re-running. Still never
  staged or committed. Default without it: `runs/<runId>/docs` (gitignored run-state you copy out later).
- **`fidelitySample` (optional, default 3; `0` disables):** after the index is written, the curator
  spot-checks up to N captured files against the source cited in each file's own header (§6). Leave it
  on unless the sources are unreachable — at `0` the verbatim promise is asserted and never tested.
- **Fresh vs. resume.** A re-run with the same `runId` gathers into and re-curates the same folder; use
  a new `runId` (or clear the folder) for a genuinely fresh set.

## 4. Sources — the doc sets to pull

Each source is one gatherer: `{ id, kind, focus }` (a bare string = a web source); ids that collide
after slugging throw, since two gatherers would write into the same `<outDir>/<id>/`. If **every** source
reports zero files in round 1 the engine throws — nothing was captured, so check the sources/brief (and
web access for `web` sources) and re-run.
- **`web`** — official documentation pages for the version in scope; an external API means its official
  reference. Prefer primary sources over blogs.
- **`repo`** — docs/READMEs/reference material inside `target.repo` (read-only, cited by path).
- **`files`** — a local doc set the `focus` names (cited by path).

Match sources to the brief: an API integration usually needs **one** (the official reference); an
upgrade or cross-system task needs **several**. The curator's gap loop backfills what you miss, but a
well-framed source list converges in one round.

## 5. Roles (in the engine)

The JS conductor routes only paths + counts (#1). Each agent is fresh. Docs work is simple next to
code, so every role defaults to a fast tier (override via `models`).

- **Gatherer** (gather · sonnet) — one per source; **copies** the brief-relevant docs verbatim into
  `<outDir>/<id>/`, one file per page/topic, each with a source header (URL or path, version, retrieval
  date). Subtraction at capture: skips nav, marketing, other versions, irrelevant features. HTML→markdown
  conversion is fine; changing words is not.
- **Scrubber** (scrub · haiku) — one per source, pipelined off its gather (no barrier). Cleans the
  source dir in place: removes capture junk (nav/menu fragments, cookie banners, feedback widgets,
  broken markup), fixes mangled markdown formatting, changes no words, keeps source headers. Unsure →
  keep; relevance deletion belongs to the curator.
- **Curator** (curate · sonnet) — one per round, after all sources land (the one genuine barrier —
  consistency and coverage need the whole set). Organizes + splits at heading boundaries (text moves
  verbatim, headers carried into every part), deletes irrelevant/duplicate content, writes `INDEX.md`
  (one line per file + Coverage notes), then — last, once the index is safe on disk — **spot-checks up
  to `fidelitySample` files against their cited source**. Returns gaps a fresh gather could fix: missing
  coverage **or** a recapture (wrong version pulled, failed spot-check). Reports (never deletes) content
  in `outDir` it neither captured nor wrote. A dead gatherer is survivable (what it wrote is on disk and
  still gets scrubbed + curated); a dead **curator throws** — nothing else produces the set, so re-invoke
  with the same args/`runId` and pass the `Workflow` tool's `resumeFromRunId` to replay from cache.

## 6. Contracts (keep intact)

- **Verbatim rule (#2/#11/#13).** Doc content is copied, split, and deleted — never rewritten,
  paraphrased, or summarized. Brevity comes from leaving content out, never from compressing what's
  kept. Deleted web content stays re-fetchable via its cited URL — the source remains the single truth.
- **That promise is sampled, not asserted.** After the index is written the curator opens the source a
  file's own header cites and compares one substantive passage (a code block, a parameter table) word
  for word — up to `fidelitySample` files, default 3. A reworded, condensed or reordered passage fails
  and re-enters the gap loop as a recapture. An unreachable source is skipped honestly:
  `fidelity.checked: 0` is valid and means *untested*, not clean. `fidelitySample: 0` removes the
  signal entirely.
- **The curator is the checker.** Cross-source inconsistencies (version mismatches, contradictions) and
  coverage gaps are found by the one agent that reads everything — no separate verifier re-reading the
  same files (#4).
- **Scrub is junk-only.** The scrubber strips mechanical capture artifacts and fixes formatting — it
  never judges relevance and never changes words; when unsure it keeps.
- **Bounded gap loop.** `[gather → scrub → curate]×N`, up to `maxRounds` (default 2). Gaps returned are
  thin routing directives (`{kind, focus}`, #8) covering missing coverage *and* recaptures (wrong
  version, failed spot-check); their rationale lives in Coverage notes. A gap-fill id that would collide
  with an id already used this run is suffixed (`-2`, `-3`, …), so no gather overwrites another's
  captures. Gaps still open at the bound stay listed there for the user.
- **INDEX.md is the entry point.** One line per file — path, what it covers, when to read it — plus
  Coverage notes. The consuming agent starts there.
- **`outDir` is engine-owned; everything outside it is read-only.** The engine writes only the doc set +
  index and never touches, stages, or commits any repo. Inside `outDir` the curator has full delete
  authority — which is why it must be a fresh directory per doc set (§3). Foreign content there is
  reported (`foreignContent`/`foreignPaths`), never deleted: a signal that the folder was wrong, not a
  guard that makes a shared one safe.

## 7. Args reference

Full schema + defaults: the Config block atop `docs-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `sources` (§4) · `brief` (inline) **or** `planPath` (absolute
  path to a framing file).
- **Optional:** `outDir` (a fresh dir dedicated to this set, usually `<project>/docs/<system>/`; default
  `runs/<runId>/docs`) · `fidelitySample` (3; a literal `0` disables the spot-check, but **throws** on a
  non-number — `""`, `false` and `[]` all coerce to `0`, and silently turning the verbatim check off is
  exactly the failure it exists to prevent) · `maxRounds`
  (2; **throws** unless it is a number in 1–50) · `testbed` (how to empirically verify non-official
  claims — §3) · `target.repo` (absolute —
  required for `repo` sources) · `models` (per-role tier: gather/scrub/curate) · `agentTypes` (custom
  subagent per role — must exist in your registry) · `stateDir` (override `runs/<runId>`).

## 8. State files (`runs/<runId>/`, outside every repo — or `outDir`)

- `docs/<source-id>/*.md` — the verbatim docs, one file per page/topic, source-headed. The curator may
  reorganize/split these.
- `docs/INDEX.md` — one line per file + Coverage notes (cross-source inconsistencies, open gaps).

Report when done: the folder + `INDEX.md` paths, file count, rounds run, inconsistencies, unresolved
gaps, and the fidelity result (`fidelity.checked` / `fidelity.failures`) — then relay the Coverage notes.
Lead with the `foreignContent` warning if the return carries one. **Nothing is staged or committed**;
copy the set into the project (or re-run with `outDir`) if it should persist.
