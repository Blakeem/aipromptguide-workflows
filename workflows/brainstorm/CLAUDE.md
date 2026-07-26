# brainstorm-cycle — operator guide (for Claude)

`brainstorm-cycle.mjs` generates several **distinct, fully-realized variations** of one creative thing —
a web/slideshow design, a product idea, a business-plan angle — one per **lens**, so the user can pick
one, ask for a hybrid, or cherry-pick across them. **Divergent and loose by design:** no scoring, no AI
review, no convergence. Built to `../../principles/WORKFLOW-PRINCIPLES.md` — a *generative* workflow, so
it honors only the **core** principles (#1–4, #6, #8, #11–14); the build-loop rules (#5/#7/#9) do not
apply (no code, no staging, no commit).

## 1. Scope (check FIRST)

Right size: one creative problem worth exploring from **several genuinely different angles** (≥2 lenses).
Too small (one obvious approach) → just produce it directly. Need the AI to *conclude* among options
(weighted decision matrix, a single answer) → that's **`decide-cycle`**, not this. Need to *build* a
chosen direction → **`feature-cycle`**. Brainstorm only diverges; the human judges.

## 2. The flow

Pick a `runId`. Every `Workflow` call loads by path: `scriptPath` = absolute path to
`brainstorm-cycle.mjs`, plus args. There is **one phase** and **no mid-run questions**, so settle
everything with the user first:

1. **Frame it with the user.** Agree the **brief** (what's being designed/ideated, the goal, audience)
   and the **lenses** — the variation axes, one per output. Propose 3–5 lenses yourself if the user has
   none (e.g. for a site: `minimalist`, `bold/editorial`, `corporate-trust`, `playful`; for a system
   idea: `efficiency-first`, `simplest`, `robustness-first`). The lens is the whole point — make them
   genuinely distinct, not shades of one idea.
2. **(Optional) Plan mode for a complex brief.** A one-line "design this landing page" needs no plan —
   pass it as `brief`. A complex problem (a business plan, a multi-surface system) deserves shared
   **requirements** every generator works from: author them in **`EnterPlanMode`**, `ExitPlanMode` to
   approve, and pass that file as `planPath` (absolute). All lenses read it verbatim (#2/#11).
3. **Run** the engine (one shot). It fans out one generator per lens into
   `runs/<runId>/variations/<lens>/` and returns each entry path + a one-line differentiator.
4. **Present** the variations: open each entry (or relay the summaries), walk the user through each
   distinct take. Help them pick / hybridize / cherry-pick. To build the chosen direction, hand it to
   `feature-cycle`; to have the AI conclude among them, hand the brief to `decide-cycle`.

## 3. Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (normally this tool's own directory) so
  `runs/` lands beside the tool, not in any target repo.
- **`lenses` — REQUIRED:** the array you agreed in §2 (strings or `{ id, focus }`). Ids must stay
  distinct **after slugging** — a collision throws rather than sending two generators into one
  `variations/<lens>/` folder; give near-identical lenses explicit `{ id, focus }`.
- **`brief` OR `planPath` — one REQUIRED.**
- **Fresh vs. resume.** A re-run with the same `runId` overwrites each lens folder. Want to keep an old
  batch? Use a new `runId` (or `stateDir`).

## 4. Roles (in the engine)

One role. The JS conductor only fans out and passes paths (#1); each generator is fresh and throwaway.

- **Generator** (opus) — reads the brief (+ optional references + read-only repo context) and ITS lens;
  produces one complete variation fully committed to that lens; writes it into `variations/<lens>/`;
  returns the entry path + a one-line differentiator. It does **not** review, compare, modify the repo,
  stage, or commit.

## 5. Contracts (keep intact)

- **Divergence, not convergence.** No scoring, no review, no "best" — the user judges. If you find
  yourself wanting an AI verdict, you want `decide-cycle`.
- **Output is read-state, not the repo.** Variations live under `runs/<runId>/variations/` (gitignored);
  the engine never writes to, stages, or commits the target repo. To adopt one, you copy it into the
  repo afterward (or build it via `feature-cycle`).
- **Brief verbatim, single source (#2/#11).** Every generator reads the same brief from one place — a
  `planPath` file or the inline `brief`. References are handed as paths, never pasted.
- **Thin return (#8).** Each generator returns only the entry path + one-line differentiator; the
  variation itself is the file.

## 6. Args reference

Full schema + defaults: the Config block atop `brainstorm-cycle.mjs`. Pass `args` inline.
- **Required:** `runId` · `root` (§3) · `lenses` (array of axes) · `brief` (inline string) **or**
  `planPath` (absolute path to a brief/requirements file).
- **Optional:** `outputFormat` (what each variation IS — e.g. `"a single self-contained HTML file"`,
  `"a 1-page Markdown proposal"`; default a Markdown doc) · `kind` (noun for the thing, e.g. `"web
  design"`, `"product idea"`) · `constraints` (shared, applied to every lens) · `references` (array of
  doc paths each generator may draw on — the "refs" mode) · `target.repo` (absolute path, read-only
  context only) · `target.lang`/`target.framework` (hints) · `models.generate` (default opus) ·
  `agentTypes.generate` (custom subagent — must exist in your registry) · `stateDir` (override
  `runs/<runId>`).

## 7. State files (`runs/<runId>/`, gitignored)

- `variations/<lens>/` — one folder per lens, holding that generator's complete variation (entry +
  any supporting files). These ARE the output; there are no review/status/log files.

Report when done: how many variations landed, where (`variationsDir`), and the one-line differentiator
of each — then help the user compare and choose. **Nothing is staged or committed.**
