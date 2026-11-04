# audit workflow — operator guide (for Claude)

One engine, two kinds, two products:
- **`audit.mjs`** — Workflow engine; a read-only fan-out audit. Its `kind` arg picks the flow.
  - **`kind: defects`** (the default, the `/aipg:debug` skill) reviews bounded units of a codebase and
    writes one verbatim **issue file per unit** (the inventory + the user's triage doc), then **STOPS**
    for triage. Each issue file is a fix-mode plan file.
  - **`kind: enhancements`** (the `/aipg:enhance` skill) fans out one finder per lens across the WHOLE
    scope and writes one verbatim **proposal file per lens**, then **STOPS**. Nothing it writes is ever
    applied automatically.
- **`gen-units.mjs`** — plain Node; slices the repo into bounded review units for the defects kind →
  `manifest.json`. Run it directly (it is NOT a Workflow engine).
- **Fixing** is `../develop/develop-cycle.mjs` in fix mode, for the defects kind only. It builds the
  triaged issue files behind the same two-stage review every build gets (blind quality, then issue-aware
  acceptance) in a run worktree of its own, and lands the accepted work on the user's branch, staged or
  committed. Its guide is `../develop/CLAUDE.md`.

Built to `../../principles/WORKFLOW-PRINCIPLES.md` (the `#N` markers below). Generated flow maps:
`FLOW-defects.md` and `FLOW-enhancements.md` beside this guide.

## 0. Checklist

Work every step in order. Each step cites the section that holds its rule, and a step that opens with a
condition in parentheses runs only under it. A heading that both kinds hold, such as "Args reference", is
the one under the list's kind.

### Before a defects run

1. Pick the kind ("Scope (pick the kind FIRST)"). Output: `kind: defects`, or the other workflow that
   section names for the job.
2. (when the findings come from outside the code review, such as live testing, a bug bash, user reports or
   a symptom you diagnosed) Hand-author the inventory in the verifier format ("External inventory (skip
   the review)"). Output: the issue file.
3. (for step 2's issue file) Check that it parses with `node <plan-block.mjs> <file> --list`, then go to
   step 14 ("External inventory (skip the review)"). Output: the block list it prints.
4. Choose the `runId` and `root` args ("Playbook" step 2, "State files (`runs/<runId>/`, outside every
   repo)"). Output: a value for each.
5. Slice the repo into units with `node <gen-units.mjs> --repo <abs> --src src --out
   <root>/runs/<runId>/manifest.json`, and show the user the printed unit list ("Playbook" step 1).
   Output: `manifest.json` and its unit list shown to the user.
6. Read the manifest and choose the other args: `units`, `target.repo`, `gates`, `conventions`,
   `conventionFiles`, `changePolicy` and, when wanted, `reviewSeverity`, `lens`, `models`, `efforts`,
   `agentTypes` and `notes` ("Playbook" step 2, "Lenses (optional)", "Args reference"). Output: a value
   for each arg.
7. Run `git -C <target.repo> status --short` (`node --version` when the run has no `target.repo`) with
   run_in_background, then end the turn (root `CLAUDE.md`, "Launch from a notification turn"). Output:
   that tool call is the last one of this turn.
8. In the turn the notification starts, call Workflow with `scriptPath` set to the absolute path of
   `audit.mjs`, `kind: defects` and the args steps 4 and 6 chose ("Playbook" step 3, root `CLAUDE.md`,
   "Launch from a notification turn"). Output: the Workflow run id (`wf_...`).

### After a defects run

9. (when the return's `failed` lists units to re-review, which `nextStep` names first) Resume the review
   through steps 7 and 8, with `args.units` built as "Playbook" step 4 says, under the same `runId`, then
   work this list again from step 9 on that run's return ("Playbook" step 4, "Args reference"). Output: a
   return whose `failed` lists no unit to re-review.
10. (when `nextStep` names units whose verifier verdicts did not match every finding id) Count those units'
    findings from their issue files ("Args reference"). Output: totals that include those findings.
11. Read the issue files `nextStep` names and present the inventory from those files: totals by severity
    and decision, the hottest areas and each NEEDS_USER item with its options and recommendation, since
    after a resume the returned `inventory`, `hottest` and `needsUserFiles` cover only the re-reviewed units
    ("Playbook" step 3, "Args reference"). Output: the inventory presented to the user.
12. Triage the inventory with the user by editing the issue files ("Playbook" step 5). Output: each entry's
    `- decision:` line as the user chose it, and each approved NEEDS_USER item's rewritten `**Fix:**` line.
13. Set each issue file's developer model with `node <plan-edit.mjs> set <file> <block-id> model=<model>`
    ("Playbook" step 5). Output: a `model:` line in each issue file with findings.
14. (for an issue file with no `- decision: ACTIONABLE` entry) Set its block `status: skip`, or leave the
    file out of step 16 ("Playbook" step 6). Output: each such file at `status: skip` or left out.
15. Confirm the gates are green in the user's checkout ("Playbook" step 6). Output: the gates' green result.
16. Build the triaged issue files through `../develop/CLAUDE.md` §0 steps 2 to 33, with those files as its
    plan files and its step 5 done by steps 11 to 14 of this list. Its steps 4, 6 to 8 and 12, which author,
    refine and approve a plan file, do not run for an issue file, the file this list's step 2 writes
    included, since "Playbook" step 6 starts develop at its §2 step 3. Start with one file, or a `runOnly`
    that names one block ("Playbook" step 6, "External inventory (skip the review)", `../develop/CLAUDE.md`
    §2 step 1). Output: the output of each develop §0 step that ran.
17. Spot-read the riskiest fixes beside `../develop/CLAUDE.md` §6's checks, before the landing ("Playbook"
    step 6). Output: what each spot-read fix showed.
18. (in stage delivery) Record `git -C <run worktree> diff --cached --stat` before the landing ("Playbook"
    step 6). Output: the recorded stat.
19. Work `../develop/CLAUDE.md` §0 from its step 34 through step 43, with its step 37's summary also
    holding each item that the last bullet of "Playbook" step 6 names. When its step 38 relaunches, work its
    steps 18 to 33 on that run's result, then this list again from step 17 ("Playbook" step 6). Output:
    develop §0 step 37's summary, holding those items.
20. (when issue files that step 14 kept are still unbuilt, such as after step 16 started with one file)
    Work this list again from step 15, with those files as step 16's plan files, under the same `runId`
    ("Playbook" step 6, `../develop/CLAUDE.md` §4, "Relaunch vs. new run"). Output: develop §0 step 37's
    summary for those files.
21. (when `notes` is set) Run `node <survey's folder>/survey.mjs <notes.dir>` and report the themes, for
    this run and for each develop run that steps 16 to 20 launched with `notes` set ("Args reference",
    `../develop/CLAUDE.md` §0 step 44). Output: the themes of each `SURVEY.md` it writes.

### Before an enhancements run

22. Pick the kind ("Scope (pick the kind FIRST)"). Output: `kind: enhancements`, or the other workflow that
    section names for the job.
23. Settle the scope and the lenses with the user ("The flow" step 1, "Pre-run setup (your job — no setup
    agent, #4)", "Lenses — the fan-out axis"). Output: the `scope` and `lenses` values.
24. Agree with the user what better means for this system ("The flow" step 2, "Pre-run setup (your job — no
    setup agent, #4)"). Output: the `goals` value.
25. Choose the other args: `runId`, `root`, `target.repo` (when a `scope` or `conventionFiles` path is
    relative) and, when wanted, `conventions`, `conventionFiles`, `context`, `minImpact`, `categories`,
    `target.lang`, `target.framework`, `models`, `efforts`, `agentTypes`, `stateDir` and `notes` ("The
    flow", "Pre-run setup (your job — no setup agent, #4)", "Args reference"). Output: a value for each arg.
26. Run `git -C <target.repo> status --short` (`node --version` when the run has no `target.repo`) with
    run_in_background, then end the turn (root `CLAUDE.md`, "Launch from a notification turn"). Output:
    that tool call is the last one of this turn.
27. In the turn the notification starts, call Workflow with `scriptPath` set to the absolute path of
    `audit.mjs`, `kind: enhancements` and the args steps 23 to 25 chose ("The flow" step 3, root
    `CLAUDE.md`, "Launch from a notification turn"). Output: the Workflow run id (`wf_...`).

### After an enhancements run

28. (when `nextStep` says NOTHING was audited) Tell the user no lens was audited, re-run the failed lenses
    with the same `runId` through steps 26 and 27, and work this list again from step 28 on that run's
    return ("Presenting the result (the deliverable is a triage conversation)", "State files
    (`runs/<runId>/`, outside every repo)"). Output: the re-run's Workflow run id.
29. Read the proposal files `nextStep` lists, and only those, and present them in its order: the ADOPT
    items, then ROADMAP, then each NEEDS_USER item with its options and recommendation ("Presenting the
    result (the deliverable is a triage conversation)", "Pre-run setup (your job — no setup agent, #4)").
    Output: every listed file presented to the user.
30. Name each change that two or more lenses landed on independently ("Lenses — the fan-out axis",
    "Presenting the result (the deliverable is a triage conversation)"). Output: each convergence named to
    the user.
31. (when `summary.unjudged` is above 0) Check the unjudged candidates in the files `nextStep` names before
    triage ("Presenting the result (the deliverable is a triage conversation)"). Output: each unjudged
    candidate read in its file.
32. (when `nextStep` names failed lenses) Tell the user those lenses were not audited and offer to re-run
    them through steps 26 and 27. When the user accepts, run that re-run once step 35 is done, then work
    this list again from step 28 on its return ("Presenting the result (the deliverable is a triage
    conversation)", "State files (`runs/<runId>/`, outside every repo)"). Output: the user's answer.
33. Triage the proposals with the user ("Presenting the result (the deliverable is a triage
    conversation)"). Output: the user's decision on each item.
34. Build the items the user adopts through `../develop/CLAUDE.md` §0 from its step 1 through step 43,
    writing at its step 6 an ADOPT item, or a NEEDS_USER item with the option the user chose, as a
    feature-mode block, and a ROADMAP item as a section-mode block when it spans many call sites and as a
    feature-mode plan of its own otherwise ("Scope (pick the kind FIRST)", root `CLAUDE.md`, "Into the plan
    bus", the return's `nextStep`). Output: develop §0 step 37's summary.
35. (when a proposal file holds `## Defects to route`) Route each block under it to the defects kind as a
    fix-mode block you write in the defects verifier's format, and build it through `../develop/CLAUDE.md`
    §0 from its step 1 through step 43 ("Contracts (keep intact)", root `CLAUDE.md`, "Into the plan bus").
    Output: develop §0 step 37's summary for those blocks.
36. (when `notes` is set) Run `node <survey's folder>/survey.mjs <notes.dir>` and report the themes, for
    this run and for each develop run that steps 34 and 35 launched with `notes` set ("Args reference",
    `../develop/CLAUDE.md` §0 step 44). Output: the themes of each `SURVEY.md` it writes.

## Scope (pick the kind FIRST)

- **A defect — anything the system gets WRONG today** (bug, typo, edge case, destructive behavior) →
  **`kind: defects`**. It FINDS production defects across a codebase, and develop's fix mode FIXES the
  verified inventory.
- **An enhancement — a bigger change worth writing up** for a system that already works: faster,
  cheaper, simpler, smaller, more robust, less work to operate, or newly capable → **`kind:
  enhancements`**, from several genuinely different angles (≥2 lenses).
- **A live symptom** ("X crashes") is neither kind. Neither kind diagnoses it (no repro/bisect). YOU
  diagnose it first (Bug Hunt & Repro), then feed the result in as an external inventory (defects kind,
  "External inventory").
- **Open-ended creative variations** for a human to pick → `brainstorm-cycle`.
- **Concluding among competing approaches** → `decide-cycle`.
- **Building** an adopted proposal → a `feature` block in a `develop-cycle` plan file (several adopted
  items become several blocks), or `section` blocks for one goal spanning many call sites.
- Too small (you already know the change) → just make it.

**The two products stay apart — this is load-bearing, not a preference.** A defects run ends in a
CLOSED issue inventory that develop's autonomous fix mode builds. An enhancements run ends in proposals
the user triages, and nothing there is applied automatically. An improvement list never enters the fix
inventory, for two reasons: it would be auto-applied behind a two-round gate, the exact scope creep the
defects kind exists to prevent, and an improvement list never converges, which the CLOSED-inventory
contract depends on. So the defects kind hunts DEFECTS ONLY (a lens narrows which defects matter; it
never licenses proposing a better design), and the enhancements kind rejects a defect and lists it for
you to route to the defects kind.

**Pass the kind.** `kind` takes `defects` or `enhancements` and defaults to `defects`, so a payload
built before the merge runs unchanged. Any other value **throws**, naming both. Before any other arg
check, an arg only the other kind reads **throws**, naming the arg and the kind that takes it: a payload
with no `kind` holding `scope`, `lenses`, `minImpact`, `goals`, `context` or `categories` says to pass
`kind: enhancements`, and a `kind: enhancements` payload holding `units`, `lens`, `gates`, `changePolicy`
or `reviewSeverity` says to pass `kind: defects`.

**You are the setup + triage layer (#4).** The engine reads NO files and spawns no loader/scribe/baseline
agent. You settle the kind and its inputs with the user, launch, present and triage the result, and, for
the defects kind, hand the triaged files to develop and land and report the result at the end.

## Adapting the engine (not running it)

- The engine is **general** — everything project-specific arrives via `args`; don't hardcode specifics.
- It runs under the Workflow runtime (`agent()`/`pipeline()`/`phase()`/`args`/`budget` are harness
  globals) — you can NOT `node audit.mjs`. `gen-units.mjs` IS plain Node —
  run it directly. `meta` stays a pure literal; top-level `return`/`await` are legal.
- Syntax-check the engine (top-level return breaks `node --check`) — pass the filename in `$f`:
  `for f in audit.mjs; do node -e "const s=require('fs').readFileSync('$f','utf8').replace('export const
  meta','const meta'); new
  Function('agent','parallel','pipeline','phase','log','args','budget','workflow','return
  (async()=>{'+s+'})()'); console.log('$f OK')"; done`

## Kind defects

Launch `audit.mjs` with `kind: defects`, or with no `kind`. The defects nextStep's playbook steps are
the ones below.

### Roles (2)

**The defects kind (read-only; units run CONCURRENTLY via `pipeline`):**
- **Reviewer** (opus) — finds production defects in ONE unit's files through ONE lens. It writes its
  findings, with the evidence for each, to `reviews/<unit>-<lens>.md` and returns only their count and
  whether it wrote that file. `<unit>` and `<lens>` are the unit id and the lens id (`lens1` when no
  lens is set) in file-safe form: lowercase, each run of other characters than letters and digits
  replaced by `_`. A lens whose id shares its file-safe form with an earlier lens of the unit gets a
  `-<n>` suffix, its position in the unit's lens array. With a lens array, each lens numbers its
  findings under its own letter tag, such as `<unit>-a1` and `<unit>-b1`. A reviewer whose count or
  file attestation is unusable counts as a lens with no coverage, as a dead one does.
  When it finds NOTHING it writes no review file and writes the clean `issues/<unit>.md` marker itself
  (frontmatter + "No issues found." + unit hash — what makes hash-based resume work). With a lens ARRAY
  the unit gets one reviewer per lens, each later lens reads the earlier lenses' review files as its
  ALREADY FOUND list, and only the LAST may write the marker (the unit is clean only if every lens found
  nothing).
- **Verifier** (opus) — spawned ONLY for units with findings; **ONE per unit regardless of lens count**.
  Reads the unit's review files by path, confirms each finding against the real code, corrects inflated
  severity, folds duplicates (across lenses or within one), routes via the decision matrix, and **writes
  `issues/<unit>.md`** verbatim (the inventory AND triage doc). Each entry's `**Evidence:**` line holds
  what it confirmed: the triggering input, the probe command and its output, or the cited document.
  It treats a reviewer's suggested fix as a hint, and checks the `**Fix:**` line it writes against the
  text it changes, its callers and every other place with the same string or rule. It rejects a
  finding its review file grades below the floor as `below-floor`. Clean
  units never reach it — the reviewer already wrote their marker. When it rejects a finding, it ends
  the file with a `## Rejected` heading and one line per rejected finding,
  `<finding_id> [<file:line>] <title>: <refutation>`, and with no rejection it writes no such heading.
  It routes a finding it can
  neither confirm nor refute to NEEDS_USER. Before a **Fix:** line prescribes a command, flag or API
  behavior the repo does not already use the same way, it confirms that behavior in the dependency's docs
  or source, or with a probe in a fresh temporary directory outside the repo and the run-state dir, which
  it removes before it returns. A fix that rests on a behavior it cannot confirm routes to NEEDS_USER.

Fixing roles (developer, blind quality, acceptance, park) are develop's, in `../develop/CLAUDE.md`.

### Contracts (keep intact)

- **The defects kind is read-only.** One writer per unit file — the reviewer writes it when the unit is
  clean, the verifier when it has findings; never both, only ever its own unit's file (parallel-safe).
  Each reviewer also writes its own `reviews/<unit>-<lens>.md` when it has findings, and nothing else
  writes that file. The verifier's one other write is its own temporary probe directory, outside the
  repo and run-state.
  Review-phase needs-decision items live INSIDE each unit file (a shared file written by concurrent
  verifiers would race). `NEEDS-USER.md` and `question-<id>.md` are only for develop's fix-phase escalations,
  which one agent writes at a time (develop guide §5).
- **The inventory is CLOSED after the defects run.** develop's fix mode never re-reviews — it only works the
  issues you approved. This is what makes medium-severity fixing converge; don't add a re-review step
  into the fix loop.
- **The issue file is a plan-bus fix block.** The verifier writes each unit's inventory as a
  `## Plan: <unitSlug(unit.id)>` block (preamble `mode: fix`, `gate: green`, `status: todo`) holding the
  `### [<id>]` entries, each with a `- status: open` line — so `issues/<unit>.md` parses under
  `tools/plan-block.mjs` and `develop-cycle` can build it directly. The clean marker keeps its old
  format (a clean unit is not a plan). It may end with a `## Rejected` section, and is still not a
  plan. Frontmatter (`unit:`/`hash:`/`reviewed:`) is unchanged, so gen-units' hash resume still joins.
- **The issue file is the contract between the engines.** The defects kind writes it. develop's fix
  developer and acceptance verifier read it through `tools/plan-block.mjs` and parse the `- ` header
  lines. No `issues.json` — the per-unit markdown files ARE the inventory.
- **The fix loop's contracts are develop's** (two-stage review, verify-first, staging as the block
  boundary, park-never-discard, the clean-tree preconditions). They are in `../develop/CLAUDE.md`.
- **A lens narrows WHICH defects, never widens into improvements.** `args.lens` (or per-unit `unit.lens`)
  aims the same machinery at a class of defect. "Report DEFECTS, not redesigns" and the verifier's
  `scope-creep → REJECT` are UNCONDITIONAL — see Scope at the top. Improvements are the enhancements kind.
- **Severity floor.** `reviewSeverity` (default medium) keeps nitpicks out of the inventory. Don't lower
  it, since that starts the noise spiral. The reviewer and verifier grade on one written impact scale,
  `SEVERITY_SCALE` in `audit.mjs`, and the size of the fix never lowers a grade.

### Lenses (optional)

Unset, the reviewer hunts production defects generally; every existing call is unaffected. Set `lens` to
aim it at a narrower class — a destructiveness audit, a data-loss sweep, a compliance pass, a
document/drawing review. Fields (all optional, each falls back to the defect-hunting default):
`{ id, mandate, criteria, categories, findingNoun, matters }` — `mandate` replaces the reviewer's one-line
charter, `criteria` its assessment list, `categories` the category list in its review-file template
(nothing validates a reviewer's category), and `findingNoun`/`matters` the floor wording.

- **`args.lens`** sets the default for every unit; **`unit.lens`** REPLACES it for that unit (it does not
  merge — element-wise merging of arrays is unpredictable; per-field defaults still apply). An **empty
  array reads as unset** for `args.lens` and `unit.lens` alike — otherwise it would replace a real lens
  set with nothing and that unit would get zero reviewers while still counting as processed.
- **An ARRAY of lenses** reviews each unit once per lens and merges the results into that unit's SINGLE
  issue file behind ONE verifier. Use it to sweep the same code from genuinely different angles in one
  pass. The engine does not dedup, so two lenses may both report the same file+category — that's the
  point, and the verifier folds true duplicates.
- **Each entry from a lensed run records the lens that found it** on a `- lens:` line after
  `- category:`. A fold across lenses lists each lens id, comma-separated. Unset, an entry has no lens line.
  A set lens with no `id` records its default `lens<N>`, so give each lens an `id`.
- **For a small codebase, pass its files as ONE unit with a lens array**, not as one unit per lens. One
  unit per lens spawns a verifier and writes an issue file per lens, and no verifier folds a defect two
  lenses both found.
- Agent ceiling per unit: one reviewer per lens + at most one verifier. It's logged at run start.

(`reviewPasses` is **gone**. It re-ran an identical prompt, so pass 2 re-hunted pass 1's ground at full
cost. Passing the same lens twice reproduces it exactly if you ever want that.)

### Playbook

1. **Units:** `node <path to gen-units.mjs> --repo <abs> --src src --out <root>/runs/<runId>/manifest.json`
   (`gen-units.mjs` sits beside this guide — `workflows/audit/` in a checkout, the path the skill
   resolves from the installed plugin; the `--out` base is `root`, never your cwd). `--unit-loc`
   (default 3500, which aims at about 200k tokens of review context per agent, since the measured
   median was 123k at 2000 lines) is the one LOC bound: a file over it
   is its own unit, a directory's files split at it, and a next-fit packing pass merges adjacent units
   up to it. The pass then merges a leftover group under a third of it into its smaller neighbor while
   the sum stays at or under 1.15 times it. A single-file unit past 3500 lines warns, and so does a
   multi-file unit past 3500 lines when `--unit-loc` is set above 3500. `--no-pack` keeps per-directory units.
   `--cap-files` (default 24) caps files per unit only under `--no-pack`, since packing checks no file count.
   Show the user the printed unit list; tune `--unit-loc` if units look lopsided. `gen-units.mjs` skips
   symlinks and junctions, as git does, so code reached only through a link is in no unit.
2. **Read the manifest yourself** and pass its `units` array in `args`. Also pass `root` (this checkout
   — or, from the installed aipg plugin, the persistent data dir the skill resolves, never the
   version-swapped install dir — so run-state lands outside the target repo), `target.repo` (absolute),
   `gates`, `conventions` (the project's CLAUDE.md distilled to ~10 lines, an index into those files)
   and `conventionFiles` (the paths of the project's CLAUDE.md files, which every agent reads in full).
   Choose `changePolicy` as `../develop/CLAUDE.md` §4 "Choosing the change policy" says, which settles
   `auto` into `focused` or `proactive` for the run, and pass it.
3. **Run `audit.mjs`** (`scriptPath` = its absolute path) with `kind: defects`, from a notification
   turn (root `CLAUDE.md`, "Launch from a notification turn"). The first reviewer says whether its
   context holds a relayed user request, and the engine halts before any verifier when it does. It
   writes `issues/<unit>.md` per unit and returns counts + the hottest areas + `needsUserFiles`. When the
   return's `failed` lists units to re-review (Args reference), resume them through step 4 (Resume the
   review) before step 5 (triage). Then follow the return's `nextStep`. It leads with any unit to
   re-review, then names the files to present and the triage and develop steps after it.
4. **Resume the review.** Re-run `gen-units.mjs` with `--issues-dir <root>/runs/<runId>/issues`, under
   the same runId. gen-units resolves the flag against your cwd, and run-state hangs off `root`. It
   joins each unit against its issue file's `hash:` frontmatter, tags them `new`/`changed`/`unchanged`,
   and emits `manifest.staleUnits`.
   - Pass `manifest.staleUnits` as `args.units`, plus the unit of every `id` in the last return's
     `failed` that needs re-review and that `staleUnits` lacks. A clean reviewer or a verifier that
     wrote its file and then did not attest it leaves the unit's real hash, so gen-units reads that
     unit `unchanged`.
   - Run the resume before any triage edit and before develop. A re-review rewrites each re-reviewed
     unit's issue file from scratch, and develop's fixes make every fixed unit read `changed`.
   - `staleUnits` carries gen-units ids and no `unit.lens`. If the run set `unit.lens`, re-attach each
     unit's lens before passing it. For a run that passed the same files as one unit per lens, pass your own
     lens units instead, each with its unit's current gen-units hash, and keep only those whose
     `issues/<fileSafe(id)>.md` is missing or whose `hash:` line differs from that hash, `incomplete`
     included.
5. **Triage by EDITING the issue files** (`runs/<runId>/issues/*.md` — the single source of truth):
   - skip → set its `- decision:` line to `SKIP` (anything ≠ ACTIONABLE is skipped by the fix loop)
   - approve a NEEDS_USER with a chosen option → set `- decision: ACTIONABLE` and REWRITE its `**Fix:**`
     line to encode that option precisely
   - a DEFER the user still wants → ACTIONABLE only if genuinely batchable. Large cross-cutting work
     belongs in its own plan file as `section` blocks.
   - a rejected finding the user wants after all → add it back as an entry in the verifier format, above
     the `## Rejected` heading. An entry below that heading still counts as an entry, such as one
     `plan-edit.mjs move` appended at the end of the file. Only the one-line rejections under the heading
     are rejected. In a clean-marker file, first add the `## Plan: <slug>` header and its mode/gate/status
     preamble in the verifier format.
   - regroup lopsided files with `node tools/plan-edit.mjs move <src> <issue-id> <dest> <block-id>`.
   - set each issue file's developer model with `node tools/plan-edit.mjs set <file> <block-id>
     model=<opus|sonnet|haiku|fable>`, judged as develop guide §3 ("Choosing a block's developer model") says.
6. **Build the triaged files with develop.**
   - Each triaged issue file with findings is one fix-mode block.
     `node tools/plan-edit.mjs args <issueFile> [<issueFile> ...] --pack <target.repo>` prints one args
     object for all of them, with small blocks packed into shared passes. Clean-marker files are not
     plans, so leave them out. A file with no `- decision: ACTIONABLE` entry after triage is not a plan
     either: set its block `status: skip` (or leave it out). Start with one file, or `runOnly` naming
     one block, to sanity-check cost and quality.
   - Before launch, confirm the gates are green in the user's checkout.
   - Then follow `../develop/CLAUDE.md` from §2 step 3 through step 6, with `commit` as develop §4
     "Choosing the delivery" settles it. The fixes build in a run worktree and land on the user's branch.
   - After the run, add a spot-read of the riskiest fixes to develop §6's checks, before the landing. In
     stage delivery, also record `git -C <run worktree> diff --cached --stat` then, since develop §2 step 6
     removes the run worktree and the user's checkout may also hold the user's own staged work.
   - When done, report the issues fixed, stale and needs-attention, the full-suite result you ran, the files
     the run staged in stage delivery, as that record lists them, or each commit
     with its sha and the issue files it holds (from the run's `nextStep`) in commit delivery, each file you
     resolved or fixed at the landing, the NEEDS-USER questions after the research step in
     `../develop/CLAUDE.md` §6 (the settled ones with their evidence, the rest with a recommendation
     each), the entries in `DECISIONS.md`, and every parked block with its branch and the backlog entry
     that links it (`../develop/CLAUDE.md` §7). In stage delivery, **never commit**: the user reviews and
     commits.

### External inventory (skip the review)

When findings come from somewhere other than the code review — live/manual testing, a bug bash, user
reports, or a symptom YOU diagnosed first (Bug Hunt & Repro) — develop's fix mode works unchanged,
since it depends on the defects kind only through the issue files. You act as the verifier:
hand-author the inventory in the exact verifier format — the `## Plan: <id>` fix-block header with
its preamble, then `### [<id>]` blocks with the `- ` header lines (including `- status: open`), an
`**Evidence:**` line with what confirmed the finding, and a precise `**Fix:**` — anchoring each behavior-level
finding to `file:line` yourself, and record skipped findings with `- decision: SKIP` so the triage is on file.
Check it parses: `node <plan-block.mjs> <file> --list`. Then playbook step 6 (Build the triaged files with
develop).

`--list` rejects a todo fix block with no `### [<id>]` entry, so a file that uses another heading fails
the parse check above.

Only the `- decision:` line selects what gets fixed, so a LOW entry marked ACTIONABLE is fixed.
Verify-first makes loose anchors safe — the fixer re-confirms each issue against current code.
(First used: `runs/live-test-fixes`, an inventory from live MCP-tool testing.)

### Gotchas

- **The review re-phrases the same concern.** The engine does not dedup findings: a `file:category` key
  dropped distinct real defects from a closed inventory. Every finding reaches the verifier, and the
  verifier folds true duplicates.
- **Reviewer severity is inflated** — that's why the verifier re-scores it; don't skip verify to save
  tokens (an unverified inventory wastes far more user-triage time than verify costs).
- **`git diff` omits new files** — when verifying by hand, check `git status --porcelain` too.
- **The blind reviewer is blind by placement AND instruction.** Its prompt's only run-state paths point
  into `runs/<runId>/gate/`; the issue files live at the run-state root, off every path it is handed,
  and the prompt still forbids reading any inventory/issue file as defense-in-depth.
- **The issue files are the source of truth for WHAT to fix.** `audit.mjs` writes them, and a
  `audit.mjs` re-run rewrites each unit file it re-reviews from scratch, triage edits and statuses
  included. Otherwise only you write them, at triage and through `plan-edit.mjs args` before each develop
  launch. develop's developer and verifier write new entries only to their own block's files in the
  project's backlog folder (`../develop/CLAUDE.md` §10), never to these.

### State files (`runs/<runId>/`, outside every repo)

`manifest.json` (units; from `gen-units.mjs`, read by YOU) · `reviews/<unit>-<lens>.md` (each
reviewer's findings with their evidence, the message its verifier and the unit's later lenses read) ·
`issues/<unit>.md` (per-unit inventory + triage doc, verifier-written, user-editable, a fix-mode plan
file). The fix loop's files (develop's quality and
acceptance reviews, ledgers) land in develop's state dir, a parked block's work on a branch of the repo,
listed in `../develop/CLAUDE.md`.

A review that starts over takes a new `runId`, since a defects re-run rewrites each unit file it
re-reviews, triage edits included. The resume in playbook step 4 keeps the `runId`, so it re-reviews
only the units it names. Never clear `runs/<runId>/`.

### Args reference

Full schema + defaults: the Config block atop `audit.mjs` (the canonical source). Pass `args` inline,
with `units` from `gen-units.mjs`.

- **Kind:** `kind: defects`, or no `kind`, since `defects` is its default. An enhancements-only arg
  **throws** (Scope, "Pass the kind").
- **Required:** `runId` · `root` · `target.repo` · `units` (from `gen-units.mjs`). `conventions` and
  `conventionFiles` are strongly recommended, not enforced — omitted, the reviewer runs on a
  placeholder rubric; supply them. `conventionFiles` is an array of paths, each absolute or relative to
  `target.repo`, and a value that is not an array of non-empty paths **throws**.
  `gates` is informational context for the reviewer here. Missing `runId`, `root`, `target.repo` or
  `units` **throws** — `target.repo` has no default, so a bogus inventory can't be built against `.`.
- **Optional tuning:** `reviewSeverity` (inventory floor, default medium; a name outside
  low|medium|high|critical **throws**) · `lens` (one lens or an ARRAY —
  see Lenses; per-unit override via `unit.lens`) · `changePolicy` (`focused|proactive`, default `focused`,
  any other value **throws**. `focused` makes each **Fix:** line the minimal fix. `proactive` makes it the
  fix with the best long-term result. Neither changes what counts as a finding. The reviewer prompt and
  the verifier prompt each say the policy and that prompt's own scope and routing rules override any
  other instruction about scope, a memory line or a CLAUDE.md included) · `models`/`efforts`/`agentTypes`
  (`models` and `efforts` map a role key to a value. The role keys are `review` and `verify`. A model is
  `opus | sonnet | haiku | fable` and an effort is `low | medium | high | xhigh | max`. Both roles default to
  opus, and every role defaults to `high`. The engine **throws** at launch, naming the arg, on a value that is
  not an object, a key outside the role keys, and a value outside its set. Choose each role's model by the
  task and the change's risk, as the develop guide §3 says. `agentTypes` maps the same role keys to a custom
  subagent that must exist in your registry, and **throws** at launch on a value that is not an object, a key
  outside the role keys and a blank name. One launch log line names each role's model and effort).
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for
  the agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and
  outside `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of
  this checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt
  then ends with an instruction to append the survey's answers to its own file in `dir`.
  A `notes` arg without both paths, or with a `dir` inside `target.repo`, **throws**. Once the run ends, run
  `node <survey's folder>/survey.mjs <dir>` and report the themes of the `SURVEY.md` it writes to the user.
- **Returns** `inventory` counts, `hottest` areas, `needsUserFiles`, and `failed`. The first three cover
  only the units this run reviewed, so after a resume they leave out the other units' issue files.
  `failed` holds every dead reviewer `{ id, stage: 'review', lens }`, every reviewer whose count is
  not a whole number at or above 0, or whose count and `wrote_file` disagree (findings with no
  confirmed review file, or a confirmed review file with a zero count),
  `{ id, stage: 'review', lens, finding_count, wrote_file }` with the values it returned (`null` when
  missing), every clean unit whose reviewer
  did not attest its marker `{ id, stage: 'review', marker: false }`, every verifier that did not
  attest its write `{ id, stage: 'verify' }`, and every verifier whose verdicts miss or miscopy a
  finding id `{ id, stage: 'verify', unmatched, unverdicted }`. Each `id` is the unit id.
  `unitsReviewed` excludes units with a `failed` entry. Re-review those, except a unit whose only
  entry carries `unmatched` and `unverdicted`. For that unit, `inventory` is incomplete, so triage from
  its issue file.
- **Throws** when two unit ids map to one issue file or one plan id, naming both.

## Kind enhancements

Launch `audit.mjs` with `kind: enhancements`. It audits a system that **already works** for
**enhancements** — bigger changes worth writing up, not nits. It fans out one **finder per lens** across
the WHOLE scope (breadth, not file slices — cross-cutting enhancements are the point), each writing its
candidates to `candidates/<lens>.md`, then **verifiers bin-packed across lenses** that kill anything the
system already does, score impact × size, route each survivor, and write one verbatim
`proposals/<lens>.md` per lens. Then it **STOPS**. This kind is a *generative* workflow honoring the core
(#1–4, #6, #8, #11–20); it writes no code, stages nothing, and never commits.

**There is deliberately NO fix-mode output.** Nothing here is ever applied automatically. That is not an
omission — see Contracts below.

**Enhancement, not improvement — the floor is deliberately high.** A typo IS an improvement, but nobody
writes it up as an enhancement, and the defects kind catches it anyway. The test the agents are given:
*would a competent engineer write this up as an enhancement ticket?* **Removal counts** — deleting a role,
a file, an argument, a phase, or a code path is a first-class enhancement, and the finder is told to hunt
for it deliberately because most audits only add.

### The flow

Launch every run from a notification turn (root `CLAUDE.md`, "Launch from a notification turn").
The first agent of a run says whether its context holds a relayed user request, and the engine halts
before any later agent when it does.
Pick a `runId`. `Workflow` loads by path: `scriptPath` = absolute path to `audit.mjs` + args with
`kind: enhancements`. One phase, no mid-run questions — settle everything with the user first:

1. **Settle the scope and the lenses with the user.** The scope is the paths every finder reads; the
   lenses are the axes of enhancement, one finder + one proposal file each. Propose lenses if the user
   has none (e.g. `efficiency`, `simplification`, `operator-effort`, `robustness`, `cost`). Distinct
   lenses find distinct things — near-duplicate lenses just pay twice for the same list.
2. **Agree what "better" MEANS here** (`goals`) — the north star every lens serves. Without it each lens
   optimizes for its own idea of better and you triage a pile of contradictions.
3. **Run** the engine. It returns per-lens counts + the proposal file paths.
4. **Present and triage** per Presenting the result below.

### Pre-run setup (your job — no setup agent, #4)

- **`root` — REQUIRED:** the absolute base run-state hangs off (this checkout — or, from the installed
  aipg plugin, the persistent data dir the skill resolves, never the version-swapped install dir) so
  `runs/` lands outside the target repo.
- **`scope` — REQUIRED:** the file/dir paths every finder reads. Each lens sees **all** of it, so keep it
  to what one agent can genuinely read in a turn. Larger than that → run per subsystem with a narrower
  scope. Every proposal targets the scope. Agents may read and cite files outside it as evidence.
- **`lenses` — REQUIRED:** ≥1 axis (strings, or `{ id, focus, criteria }`). Ids that collide after
  slugging throw — two lenses would write the same proposal file.
- **`target.repo`:** the absolute path to the system under audit — the directory holding its `.git`.
  REQUIRED whenever any `scope` path is relative (it is what they resolve against); the engine throws
  otherwise rather than guessing, since defaulting to `root` would audit the run-state base (this
  checkout, or the plugin data dir). Give every `scope` path as an absolute path and you can omit it.
- **`goals` (strongly recommended):** what "better" means for this system.
- **`conventions`:** house rules an enhancement must fit — or argue explicitly for changing.
- **`conventionFiles`:** the paths of the project's own instruction files, such as its CLAUDE.md files,
  which both roles read in full. Each is absolute or relative to `target.repo`, and a relative entry with no
  `target.repo` throws.
- **`minImpact`** (default `moderate`): the floor. `marginal` is below it on purpose. Lower it only if
  you genuinely want the long tail; that is the noise spiral. The verifier rejects a candidate it scores
  below the floor and names it in that lens file's `## Rejected` section. That section is where a thin
  run shows whether the floor or the system thinned it.
- **Relaunch vs. new run.** A re-run with the same `runId` overwrites the proposal file of each lens that
  produces one in this run. A lens in `failed`, listed with the stage that dropped it, keeps any earlier
  file, so present only the paths in `lenses[].file`. Keep an old batch → new `runId` (or `stateDir`).

### Lenses — the fan-out axis

Each lens is ONE finder → ONE candidates file → ONE proposal file, which the verifier that carries the
lens writes. `{ id, focus, criteria }`; a bare string is both id and focus.
- **`focus`** — the perspective, pushed hard. The finder is told not to hedge toward the other lenses.
- **`criteria`** (optional) — what to weigh under this lens.

**Why lens and not file-slice.** Slicing by file is the defects kind's axis and is right for local defects. An
enhancement is frequently cross-cutting — "every engine re-implements this", "these three roles could be
two" — and is *invisible* to a reader holding one file at a time. So each finder gets breadth.

**Cross-lens overlap is signal, not duplication.** Two lenses landing on the same change independently is
the strongest evidence the run produces. The engine keeps the lens files separate and lets you see the
convergence — there is no merge agent (#4/#6).

### Roles (in the engine)

The JS conductor routes only paths + verdicts (#1). Each agent is fresh. Both roles are **opus**: the
finder needs breadth and judgment across the whole scope, the verifier is the quality gate that kills the
noise.

- **Finder** (find · opus) — reads the whole scope through ONE lens. Every candidate must be grounded in
  the code as it is: **what the system does today** (cited `file:line`) → **what it would do instead** →
  **the specific cost that removes** (tokens, wall-clock, agent count, operator steps, a failure mode,
  maintenance surface). No nameable cost = not an enhancement. It writes each candidate whole, with an
  `**Evidence:**` line naming what it read and ran, to `candidates/<lens>.md`, and returns only the
  candidate ids, numbered `<lens>-<n>`. Zero candidates is a legitimate outcome — the finder then writes
  its own clean `proposals/<lens>.md` marker. A finder that verifies a defect in passing reports it as a
  `DEFECT:` candidate.
- **Verifier** (verify · opus) — spawned ONLY for lenses with candidates, and **bin-packed across
  lenses**, as the defects kind packs small units: in lens order, a lens joins the current verifier while
  their candidates total at most 12, a lens with more gets a verifier of its own, and a lens never splits
  across verifiers. It reads each of its lenses' candidates files by path, treats the finder's Today,
  Removes and Evidence lines as claims to confirm, reads the code each candidate cites plus what the
  REJECT rules need, and for rule 1 searches the scope for an existing mechanism by what it does, not only
  by the candidate's words. Rejects ruthlessly, first match wins: (1) **the system already does this** —
  the most common failure of a find pass; (2) the claimed cost is not real or cannot be substantiated
  from the code; (3) it is taste; (4) it is a **defect**, not an enhancement — rejected with `is_defect`,
  so you can route it to the defects kind (`/aipg:debug`); (5) its verified **risk outweighs** the cost
  removed, such as breaking something the system needs or leaving a required
  instruction ambiguous — rejected with `too_risky`. Then it re-scores impact/size (finders over-rate)
  and **writes** `proposals/<lens>.md` verbatim for each of its lenses. A real candidate it scores below the
  floor keeps `is_real` true and is rejected as below the floor.

### Contracts (keep intact)

- **Nothing is auto-applied, and there is no fix-mode output.** This is the load-bearing design decision.
  The defects kind's inventory feeds develop's fix mode, an autonomous fixer. Enhancements must never enter
  that path. They would be auto-applied behind a two-round gate, which is the exact scope creep the defects
  kind exists to prevent. So this kind writes to `proposals/`, **never `issues/`**, and stops at the
  inventory.
- **An enhancement list does not converge.** There is always another enhancement. The defects kind's
  *closed* inventory is what makes its fix loop terminate; an open-ended proposal list has no such
  property, which is the second reason it must not drive a fixer.
- **Defects are out of scope, both directions.** A finder reports a defect it found in passing as a
  `DEFECT:` candidate, never as an enhancement. The verifier rejects it with `is_defect=true` and lists
  every defect, including one split from a kept candidate, under `## Defects to route` so you can route
  it to the defects kind (`/aipg:debug`), each as a block that reuses the defects kind's issue-entry
  `- file:` and `**What:**` lines: `- file:` holds where, and `**What:**` what is broken and its harm. An
  `**Evidence:**` line holds the trigger and what the verifier confirmed. A kept candidate whose defect
  half was split off carries `defect_split`, so the return's `defects` counts include it beside each
  `is_defect` candidate. Do not relax this — the two kinds stay clean by keeping their products separate.
- **Read-only.** The only files written are the per-lens candidates and proposal files. Source is never
  modified, nothing is staged, nothing is committed.
- **One writer per file** — the finder writes its lens's candidates file, and its proposal file when the
  lens is clean. The verifier that carries the lens writes its proposal file when it has candidates, and
  a packed verifier writes only its own lenses' files. Never two writers (parallel-safe, same contract as
  the defects kind). For the same reason
  there is **no shared `NEEDS-USER.md`**: the lenses run concurrently and an agent "append" is a
  read-modify-write, so two verifiers would silently clobber each other. A user-only call goes in that
  candidate's block in its own lens file, options + recommendation included — nothing is lost.
- **Thin returns (#8).** Counts and routing decisions only; every proposal's prose lives in its file.

### Presenting the result (the deliverable is a triage conversation)

Follow the return's `nextStep`. It names the counts, the files to present, the order to present them
in, where each decision routes and every caveat. The return's `summary.unjudged` counts the candidates
the verifier returned no verdict for, which are in no other count.

What each decision means:
- **ADOPT**: well-scoped and ready to hand to a builder as-is.
- **ROADMAP**: real, but it needs planning rather than a single change.
- **NEEDS_USER**: a genuine product or design call, with options and a recommendation in its block.
  These are the items that need the conversation.

### State files (`runs/<runId>/`, outside every repo)

- `proposals/<lens>.md` — one per lens (non-alphanumerics in the lens id become underscores:
  `operator-effort` → `operator_effort.md`): the verified, impact-scored proposals, a
  `## Defects to route` section (one block per defect, written only when it has one) and a `## Rejected`
  section (one line each, and a rejection for a cost the verifier cannot substantiate starts `UNPROVEN:`
  and names the evidence that would substantiate it). This IS the deliverable. A verifier-written file (a lens
  that had candidates) carries `lens`, `focus`, `reviewed` and a `note` stating these are proposals requiring
  human triage; a clean lens's finder-written marker carries only `lens` and `reviewed`. A lens reports NO
  file when its finder died, its finder returned candidate ids without attesting its candidates file, its
  finder returned only ids that do not read `<lens>-<n>`, its finder returned no candidate without attesting
  its marker, its verifier died, or its verifier did not list the lens in `wrote_lenses`. Each of those
  lands the lens in `failed` as `{ id, stage }` with the stage that dropped it: `find` for the four
  finder cases, `verify` for the two verifier cases. A finder id that repeats or does not read
  `<lens>-<n>` is ignored and logged. A dead packed
  verifier fails every lens it carried. The run logs a ⚠ naming the lens in each case, and `nextStep`
  names it as `<lens> (<stage>)`. Re-run it.
- `candidates/<lens>.md` — the finder's candidates, each with its evidence, that the verifier reads. A
  clean lens's finder writes none, so a candidates file on disk for a clean lens is from an earlier
  launch.
- No shared `NEEDS-USER.md` (Contracts) — a user-only call lives in its candidate's block in the lens file.

No `issues/` directory (deliberately — Contracts), no status files, no run summary.

### Args reference

Full schema + defaults: the Config block atop `audit.mjs` (the canonical source). Pass `args`
inline.
- **Required:** `kind: enhancements` (a defects-only arg **throws**, Scope, "Pass the kind") · `runId` ·
  `root` (Pre-run setup) · `scope` (array of paths every finder reads) · `lenses` (array of axes —
  strings or `{ id, focus, criteria }`).
- **Optional:** `target.repo` (absolute) · `goals` (what "better" means — strongly recommended) ·
  `conventions` (house rules) · `conventionFiles` (an array of instruction file paths, Pre-run setup) ·
  `context` (domain facts the agents won't infer) · `minImpact`
  (`transformative`|`high`|`moderate`|`marginal`; default `moderate`) · `categories` (override the
  finder's category list — default `efficiency`, `simplification`, `removal`, `robustness`, `capability`,
  `operator-effort`, `consistency`, `observability`, `cost`) · `target.lang`/`target.framework` (hints) ·
  `models`/`efforts` (`models` and `efforts` map a role key to a value. The role keys are `find` and
  `verify`. A model is `opus | sonnet | haiku | fable` and an effort is
  `low | medium | high | xhigh | max`. Both roles default to opus, and every role defaults to
  `high`. The engine **throws** at launch, naming the arg, on a value that is not an object, a key
  outside the role keys, and a value outside its set. Choose each role's model by the task and how much
  judgment the role needs, as the develop guide §3 says. One launch log line names each role's model and
  effort) · `agentTypes` (custom subagent per role — must exist in your registry. It takes the same role keys
  and **throws** at launch on a value that is not an object, a key outside the role keys and a blank name) ·
  `stateDir` (override `runs/<runId>`).
- **Exit survey:** `notes` (`{ dir, survey }`, two absolute paths). Set it when the user asks for
  the agents' feedback on a run. `dir` is the folder the answers go to, outside the target repo and
  outside `runs/<runId>/`, such as `<root>/runs/<runId>-notes`. `survey` is `tools/EXIT-SURVEY.md` of
  this checkout, or of the plugin folder the skill names in an installed plugin. Every agent prompt
  then ends with an instruction to append the survey's answers to its own file in `dir`.
  A `notes` arg without both paths **throws**. Once the run ends, run `node <survey's folder>/survey.mjs
  <dir>` and report the themes of the `SURVEY.md` it writes to the user.

Agent count is bounded and visible up front: **≤ 2 × lenses** (one finder each, plus at most one
verifier per lens with candidates, fewer when lenses share a verifier).
