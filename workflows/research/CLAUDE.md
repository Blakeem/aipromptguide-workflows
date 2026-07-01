# research-cycle — operator guide (for Claude)

`research-cycle.mjs` answers a question that needs **gathering + cross-checking across several sources**,
then a synthesized, cited deliverable. It fans out one **gatherer** per angle (web / repo / external API
/ docs) writing cited findings, **adversarially verifies** each load-bearing claim (tries to refute it),
then **synthesizes** the verified findings into a `report`, a `spec`, or an `assessment`. Built to
`../../principles/WORKFLOW-PRINCIPLES.md` — a *read-only* workflow that honors the core (#1–4, #6, #8,
#11, #13); the verify stage is the **independent-check-before-trust** pass in the spirit of #5. Nothing
is written to the target repo, staged, or committed.

It **absorbs three old prompts**: general research (`outputKind:"report"`), documenting an external API
or an internal feature contract (`"spec"` — replaces `spec-external`/`spec-feature`), and the
knowns/unknowns pre-action pass (`"assessment"` — the planning-style residual).

## 1. Scope (check FIRST)

Right size: a question worth mining **≥2 sources** and cross-checking before you trust the answer — an
API/library evaluation, a "how does X actually work" dig across the repo + docs, a spec to hand an
implementer, a go/no-go assessment. Too small (one doc page answers it) → just read it. A pure
web-only deep dive with no repo/API/spec output is also well served by the `deep-research` **skill** —
reach for this **engine** when you want persisted per-source files, repo/API angles, or a spec/assessment
that feeds `feature-cycle`/`decide-cycle`.

## 2. The flow

Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `research-cycle.mjs` + args.
No mid-run questions — frame it with the user first:

1. **Frame the question + angles with the user.** Decide what "done" means and the **angles** — each a
   source to mine: a **web** search theme, a **repo** area, an external **api**/SDK, or a **docs** set.
   For a complex brief, author it in **`EnterPlanMode`**, approve, and pass `planPath`; a simple one goes
   inline as `question`. Pick `outputKind`: `report` (default) | `spec` | `assessment` (§4).
2. **Run** the engine (`angles` + `question`/`planPath` + `outputKind`). It pipelines gather → verify per
   angle, then synthesizes the deliverable, and returns its path + evidence counts + confidence.
3. **Present** the deliverable: read it, relay the answer + confidence + open questions; the per-angle
   `findings/` and `verify/` files are the audit trail. The deliverable is in gitignored run-state —
   copy it into the repo/docs if the user wants to keep it. A `spec` is a strong input to a
   `feature-cycle` plan; an `assessment` informs a go/no-go.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (normally this tool's own directory).
- **`angles` — REQUIRED:** the array from §1 (strings = web themes, or `{ id, source, focus }`).
- **`question` (inline) OR `planPath` — one REQUIRED.**
- **`target.repo`** is required only if any angle has `source:"repo"` (else that gatherer has nothing to
  read — the engine warns).
- **Web/API angles need web access** in your session (WebSearch/WebFetch). Repo/docs angles don't.
- **Fresh vs. resume.** A re-run with the same `runId` overwrites the files; use a new `runId` to keep an
  old run.

## 4. `outputKind` — the deliverable

The synthesizer's template (full shapes in the engine's `DELIVERABLE_SHAPE`):
- **`report`** → `REPORT.md`: answer-first summary, sections per finding (each cited + confidence-marked),
  what's uncertain/disputed, open questions.
- **`spec`** → `SPEC.md`: the contract an implementer needs + **acceptance criteria**. For an external
  API: auth, endpoints, request/response with examples, errors, rate limits, version gates. For an
  internal feature: behaviour, signatures, examples, edge cases. (Pair with a `source:"api"` angle for
  the external case.)
- **`assessment`** → `ASSESSMENT.md`: Certainties / Uncertainties (+ what resolves each) / Consequence
  map / a confidence-calibrated recommendation.

## 5. Roles (in the engine)

The JS conductor pipelines `agent()` calls, passing only paths + counts (#1). Each agent is fresh.

- **Gatherer** (gather · sonnet) — one per angle; mines its source per the source-specific guidance,
  writes `findings/<angle>.md` with claims + citations + per-claim confidence.
- **Verifier** (verify · sonnet) — one per angle; **adversarial** — tries to refute each load-bearing
  claim against the cited sources, writes `verify/<angle>.md` (confirmed / refuted / uncertain).
- **Synthesizer** (synthesize · opus) — after all angles verify (barrier), reads each findings file with
  its verdict file, builds the deliverable on **confirmed** claims, excludes refuted ones, flags
  uncertain ones, and answers the brief. Writes the `report`/`spec`/`assessment`.

## 6. Contracts (keep intact)

- **Verify before trust (spirit of #5).** The verifier is independent and adversarial; the synthesizer
  trusts the **verdict** over the raw finding and never presents an uncertain/refuted claim as settled.
- **Gather → verify pipelines per angle** (no barrier); **synthesize is the one barrier** — it genuinely
  needs every verified angle at once.
- **Cite everything.** Every claim carries a source; the per-angle files are the audit trail behind the
  deliverable. Don't let the synthesizer assert beyond the verified evidence.
- **Read-only.** Findings/verify/deliverable live in run-state; the engine never writes to, stages, or
  commits the target repo. You copy the deliverable out if you want to keep it.
- **Thin returns (#8).** Schemas carry only counts + confidence; claims and prose live in the files.

## 7. Args reference

Full schema + defaults: the Config block atop `research-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `angles` (array of sources) · `question` (inline) **or**
  `planPath` (absolute path to a framing/scope file).
- **Optional:** `outputKind` (`report` | `spec` | `assessment`, default `report`) · `audience` (who the
  deliverable is for) · `target.repo` (absolute — required for `repo` angles) ·
  `target.lang`/`target.framework` (hints) · `models` (per-role tier: gather/verify/synthesize) ·
  `agentTypes` (custom subagent per role — must exist in your registry) · `stateDir` (override
  `runs/<runId>`).

## 8. State files (`runs/<runId>/`, gitignored)

- `findings/<angle>.md` — each gatherer's cited claims + confidence.
- `verify/<angle>.md` — each verifier's per-claim confirmed/refuted/uncertain verdict.
- `REPORT.md` / `SPEC.md` / `ASSESSMENT.md` — the synthesized deliverable.

Report when done: the deliverable path, overall confidence, evidence counts (confirmed/refuted/
uncertain), and open questions — then relay the answer. **Nothing is staged or committed**; copy the
deliverable into the repo/docs yourself if it should persist.
