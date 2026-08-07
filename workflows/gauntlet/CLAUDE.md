# gauntlet-cycle — operator guide (for Claude)

`gauntlet-cycle.mjs` builds a product to a **working, code-sound MVP** (`phase:"mvp"`), then **climbs
it toward an inspectable quality bar** (`phase:"refine"`) — the Gauntlet Loop pattern (builder + fresh
critic A/B-ing the *running product* against an exemplar) adapted to
`../../principles/WORKFLOW-PRINCIPLES.md`. The standard is **flagship / AAA / mission-critical**, baked
into every builder and critic prompt; the user's `cycles` wave budget is the brake on a climb that has
no natural end. Built to the `#N` markers below; follow those before changing the engine.

## 1. Scope (check FIRST)

Right size: something whose "done" is **comparative quality against an exemplar** — a game, a product
surface, a site, a tool that should look and behave like a shipped thing. Two entry points:
- **From scratch:** `phase:"mvp"` builds every component of an approved decomposition to alpha, then
  `phase:"refine"` climbs it.
- **Existing product:** skip mvp entirely — point `phase:"refine"` at the repo with `ASPECTS.md` +
  `BAR.md`. This is the "feed it one of my existing sites and let it iterate" mode.

Wrong tool: one bounded feature inside an existing codebase with enumerable acceptance criteria →
**feature-cycle**; hunting defects → **debug**; a human-triaged improvement list, nothing applied →
**enhance**. The tell: if "done" is a checklist, use feature; if a human should judge the list, use
enhance; if "done" is *a blind critic prefers ours to the exemplar*, use gauntlet.

**Additive features during refine** are legal only as evidenced UX big-wins that fit CANON (the critic
must state the evidence; the improver's decision matrix still weighs scope cost). The climb perfects
what exists — it does not grow the product by default.

## 2. The flow

Pick a `runId`; reuse it for both phases. `scriptPath` = the absolute path to `gauntlet-cycle.mjs`.

1. **Author the run documents with the user** (§4), under `<root>/plans/<runId>/` — never inside the
   target repo, never under `runs/` (#3). CANON and BAR are worth real user time: CANON is the only
   control surface the climb obeys, and BAR is the only definition of "better" it has.
2. **Derive the components array** (mvp only):
   `node <blockTool> <COMPONENTS.md> --list --kind component` → pass its output as `components`.
   The engine never runs the tool (the harness has no tools, #1).
3. **Prep** (§3): clean unstaged tree, fresh-vs-resume state dir.
4. **`phase:"mvp"`** — per component, in order: build → BLIND code gate (defects AND structural debt;
   stages on clean) → next component. A component that cannot pass **parks and the run STOPS** (later
   components build on it — migrate's asymmetry, not feature's continue).
5. **Verify the MVP yourself** (§7), then **`phase:"refine"`** with `cycles` = how many waves you are
   buying this invocation. Per wave, per open aspect: a **fresh critic** observes the running product
   (its testbed tools), A/Bs blind against BAR, names **ONE largest gap** with evidence; the improver
   closes exactly that gap. After a wave that changed anything: the same blind code gate reviews the
   whole wave diff and **stages the wave**. Aspects close on `achieved` (bar met) or `saturated`
   (every remaining gap already settled in the ledger). All closed → done; waves spent → stop, resume
   with more (§8). Every stop lands on a staged, clean tree.
6. **Read the trail** (§7) and report. **Never commit.**

Plan mode: the run documents replace the plan file, and authoring them with the user IS the approval
conversation — use `AskUserQuestion` for canon rules, the bar choice, and the aspect list. There is no
engine refine-critic pass; the user's read of CANON/BAR/COMPONENTS/ASPECTS is the gate (#4).

## 3. Pre-run setup (your job — no setup agent, #4)

- **Clean unstaged tree — engine-enforced.** The round-1 builder (mvp) or first critic (refine) runs
  STEP 0 and halts the run before anything else spawns if the unstaged tree is dirty. Settle it with
  the user first: `git add -A` (keep as baseline) or `git stash -u`.
- **Fresh vs. resume.** `SETTLED.md`/`NEEDS-USER.md`/`gate/DISMISSED-*.md` are cumulative; `testbed/`
  deliberately persists (wave 5's critic reuses wave 1's screenshot harness). Clear `runs/<runId>/`
  only for a genuinely new run; **preserve it on every resume**.
- **`root` — REQUIRED.** The absolute base run-state hangs off (this checkout, or the plugin data dir
  the skill resolves — never the plugin install dir). `blockTool` = the plugin's own `plan-block.mjs`
  when `root` is not this checkout.
- **Gates are the per-stack adapter.** `gates.build` required always; `gates.test` required when any
  component is `gate:"green"`. Refine improvers run the same gates.
- **`cycles` is a real decision the user makes** — there is no default. Small (2–4) to sample the
  climb cheaply; large to let it run to saturation. Every wave stages, so a small budget costs nothing
  but the resume call.

## 4. Run-document shapes (you write them; agents read them VERBATIM, #2)

`CANON.md` — the goal paragraph + the hard rules (theme, mechanics, tech choices, the don'ts). Read by
builder/critic/improver in both phases; **never** by the code gate. A canon violation outranks any
polish gap. Tight canon = controlled build; near-empty canon = maximum freedom.

`BAR.md` — pointers to the exemplar (screenshot dirs, a reference product/repo/URL, exemplar text) +
one line per pointer saying **what it witnesses** (visuals, feel, latency…). The bar is direction: it
may be deliberately unreachable, and failing to meet it is an expected outcome, not a failure.

`COMPONENTS.md` (mvp) — `## Component: <id> — <title>` blocks, each: what it is, how it integrates,
rough implementation notes, and a `## Gate` heading (`green` | `build-only`). Sliced verbatim by
`plan-block.mjs --kind component`; validate with `--list` before running. Order = build order; put an
integration/boot component last ("runs end-to-end").

`ASPECTS.md` (refine) — `## Aspect: <id> — <title>` sections: WHAT quality dimension to judge and HOW
to observe it (launch command, screenshot flow, probe, metric). Critics are handed the whole file plus
their id — sections are short and not secret from each other. Include a `coherence` aspect last if the
product should read as one whole.

## 5. Roles (in the engine)

- **build** (mvp · opus) — gets its spec via the block command (reports `spec_obtained`), reads CANON
  (+BAR if given) + the latest flagging review; implements to the quality frame; gates green; leaves
  work UNSTAGED. Owns the decision matrix: settles every judgment call itself (SETTLED.md), declines
  code-gate findings to `gate/DISMISSED-<id>.md`, escalates NOTHING except an environment fault.
- **code-gate** (both phases · opus) — **BLIND BY PLACEMENT**: the ONLY paths in its prompt are the target
  repo and `runs/<runId>/gate/` — its own review file and the DISMISSED ledger it reads. It is never told
  `runs/<runId>/` itself, because the critique files sitting there ARE the wave's spec (#3: a directory the
  agent reads is a disclosure; "please don't read X" is not). Unstaged diff only, no canon/bar/spec paths,
  no NEEDS-USER. Production-blocking defects AND structural debt; never prior reviews; may CONTEST a
  dismissal once. Writes `gate/code-review-<unit>-rN.md`. **On clean it is the staging agent** (`git add`,
  never commit) — per component in mvp, per wave in refine.
- **critic** (refine · opus) — fresh per aspect per wave; observes the RUNNING product per its
  ASPECTS.md section, building tools in `runs/<runId>/testbed/` (full write access there, read-only
  on the repo); blind A/B vs BAR + canon check; writes `critique-<aspect>-wN.md` with ONE largest gap
  + evidence (#14). Reads SETTLED.md (never re-opens a settled call; may CONTEST one once), never
  prior critiques. Returns `behind | achieved | saturated`.
- **improve** (refine · opus) — reads its critique file verbatim + CANON + BAR; closes exactly the ONE
  gap (or the code review's findings in a gate round); gates green; UNSTAGED; settles trade-offs to
  SETTLED.md — declining the gap is legitimate, but only as a written, settled call.
- **park** (both · build tier) — saves the unit's work to `parked-<unit>.patch` (+ strays dir), clears
  the tree, re-runs the build gate, records diagnosis + restore command in NEEDS-USER.md.

## 6. Loop & contracts (keep intact)

- **mvp:** per component, `build → code-gate`, up to `maxRounds` (default 4). Clean → the gate stages;
  baseline advances. Can't pass → **park, then STOP** (`BLOCKED (component parked — MVP incomplete;
  resolve before refining)`). Clean-but-unstaged **HALTS** — `BLOCKED (a component passed clean but was
  not staged — stage it, then resume from the next component)` — with ledger status `done (gate clean,
  NOT staged — stage it yourself)` and nothing parked: the work is ACCEPTED, only its boundary is missing.
  Going on cannot work; the next component's round-1 builder would count those files as a dirty baseline
  and halt anyway, blaming you. `git add` them, then re-invoke with `startAt:"<next component>"`.
- **refine:** waves `startWave .. startWave+cycles-1`; per wave each OPEN aspect gets critic → (if
  `behind`) improve — a critic that does not confirm `gap_actionable` only draws a ⚠; the improver still
  runs; then one code-gate pass over the whole wave diff, `maxGateRounds` (default 3) fix rounds, stages
  on clean. A wave that cannot gate-clean **parks the wave diff and halts**. Aspect bookkeeping:
  `achieved`/`saturated` close it; closed aspects drop from later waves.
  Every aspect closed → `done (all aspects closed)`, the one refine ending that is not a halt — but under
  `runOnly` that is only the SLICE closing, so it reports `done (this runOnly slice closed — N aspect(s)
  outside the slice were not climbed)` with `halted:true` and a resume naming the aspects left.
- **No user escalation except environment faults.** Agents resolve ambiguity via their decision matrix
  (top-weighted criterion: the quality frame within CANON) and log one terse SETTLED.md line each. A
  contested settle is re-decided once with the critic's argument in view, then final. `env_blocked`
  halts with `BLOCKED (environment fault — see NEEDS-USER.md)`.
- **Death policies (#15):** any per-round role returning nothing halts distinctly (`BLOCKED (an agent
  returned nothing…)`); a dead critic is never a clean/achieved verdict.
- **Budget floors:** `minComponentBudget` (150k) / `minWaveBudget` (200k) stop cleanly between units
  with `stopped on token budget (resume where it left off)`.
- **Every terminal leaves a clean tree** — staged (accepted), parked (saved + cleared), or untouched
  (dirty-baseline halt). Nothing is ever committed.

## 7. Verify ground truth yourself

- Run the gates for real; `git -C <repo> diff --cached --stat`; `git status --porcelain` clean.
- **Run the product yourself** — the whole point is observable quality; confirm what the critics
  reported seeing (their testbed tools in `runs/<runId>/testbed/` are re-runnable).
- Read the latest `critique-<aspect>-wN.md` per aspect (the ONE-gap trail is the climb's story), the
  `gate/code-review-*` files, and **audit `SETTLED.md`** — every judgment call the agents made without you,
  including declined gaps and `SETTLED (contested)` finals. That file is the price of no-user-halts;
  read all of it.
- Check each aspect's terminal state in the result ledger: `achieved` vs `saturated` are different
  claims (bar met vs. nothing actionable left).
- Surface `NEEDS-USER.md` (park records + environment faults only).

## 8. Resume (no progress file by design, #6/#10)

Durable progress = git staging + the numbered critique/review trail + the ledgers. Preserve
`runs/<runId>/`.
- **mvp:** re-invoke with `startAt:"<first not-done component id>"` (or `runOnly:[ids]`). A parked
  component: sharpen its block, re-run from it — or restore the patch and finish by hand (never
  `git add -A` restored work into the baseline un-reviewed).
- **refine:** re-invoke with `startWave` = last wave + 1 and more `cycles`; `runOnly:[open aspect
  ids]` to narrow. The result's per-aspect ledger says which are open. Wave numbering continues so
  critique files never collide.
- **Crash mid-wave** leaves unstaged partial work: settle it yourself first (`git add -A` to keep it
  as reviewed-by-next-wave baseline is wrong — prefer `git stash -u`, or re-run the wave after
  clearing), then resume. The engine's STEP-0 check will refuse a dirty tree either way.

## 9. Gotchas

- **An unknown component `gate` value silently becomes `green`** (the stricter legal gate) — typo'd
  `"gren"` costs a test run, not a silent pass.
- **`cycles` too small looks like failure.** `cycles spent (N aspect(s) open…)` is a normal stop, not
  a defect — the climb is resumable by design.
- **The critic needs the product to be RUNNABLE.** Every ASPECTS.md section must say how to launch and
  observe; an aspect a critic cannot witness cannot be judged (it will settle or env-fault).
- **`blockTool`** must point at the installed plugin's `plan-block.mjs` when `root` is the plugin data
  dir; the default `<root>/tools/plan-block.mjs` only exists in a checkout.
- **Run documents inside the target repo** draw a loud ⚠ — the blind gate could read the goal from the
  repo tree. Move them under `<root>/plans/<runId>/`.
- **A marked node pair carries one label by design.** In FLOW.md, `code-gate → build` shows a bare
  thick edge + an `E<n>` marker; the conditions and the next-item advance live in the `## Edges`
  table (mermaid renders both labels of a pair at one midpoint, so a pair carries at most one).

## 10. State files (`runs/<runId>/`, outside every repo)

- `gate/` — **the blind gate's whole world**, and the only directory its prompt names. Put nothing else
  in it: anything here is one `ls` away from the reviewer that must not know what the code is for.
  - `gate/code-review-<unit>-rN.md` — blind gate findings (`<unit>` = component id, or `wave-N`).
  - `gate/DISMISSED-<unit>.md` — terse declined code-gate findings (anti-spin ledger).
- `critique-<aspect>-wN.md` — the critic's message to the improver; the climb's trail. It IS the wave's
  spec, which is exactly why it sits here and not in `gate/`.
- `SETTLED.md` — cumulative: every self-settled judgment call, declined gap, contested-final. **Your
  end-of-run audit.**
- `NEEDS-USER.md` — park records + environment faults ONLY (no decisions live here by design). The gate
  is not given this either — the anti-spin ledger it needs is DISMISSED, which moved with it.
- `parked-<unit>.patch` (+ `parked-<unit>-newfiles/`) — a parked unit's saved work; restore command in
  NEEDS-USER.md. A SECOND park of the same unit preserves the first as `parked-<unit>-prev<N>.patch`
  (+ `parked-<unit>-newfiles-prev<N>/`) and says so in NEEDS-USER.md.
- `testbed/` — critics' verification tooling; persists across waves; never in any reviewed diff.

## 11. Args reference

Full schema + defaults: the Config block atop `gauntlet-cycle.mjs` (the canonical source).
- **Required (both phases):** `runId` · `root` · `target.repo` · `canonPath` · `gates.build`.
- **mvp:** `componentsPath` · `components` `[{id, gate}]` (derived pre-run via
  `plan-block.mjs --list --kind component`) · `gates.test` when any gate is `green`.
- **refine:** `aspectsPath` · `aspects` `[{id}]` · `barPath` · `cycles` (1..10000, NO default).
- **Optional:** `phase` (`mvp` default | `refine`) · `barPath` in mvp (recommended — builders build
  toward it) · `blockTool` · `gates.testSetup` (how to bring the test harness up when it is missing —
  interpolated into the builder's and the improver's procedure) · `maxRounds` (4) · `maxGateRounds` (3) ·
  `startWave` (1) · `startAt`/`runOnly` (component ids in mvp; aspect ids in refine) ·
  `minComponentBudget` (150k) · `minWaveBudget` (200k) ·
  `models` (`build`/`codeGate`/`critic`/`improve`, all opus) · `agentTypes` ·
  `stateDir` · `conventions` · `target.lang`/`target.framework`.
