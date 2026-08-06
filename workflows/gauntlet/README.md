# gauntlet-cycle

Build something to a **working MVP**, then **climb it toward a quality bar you can point at** — an
exemplar product, a screenshot set, a reference implementation. The Gauntlet Loop pattern (builder +
fresh critic judging the *running product* blind against the exemplar, one largest gap per round),
rebuilt on this repo's principles: bounded, resumable, ledgered, and code-reviewed.

### What sets it apart

- **The bar is direction, not a checklist.** It may be deliberately unreachable; the product of a run
  is the climb, and the report says how far each quality aspect got (`achieved` vs `saturated`).
- **You set the brake.** `cycles` (how many waves to run) is required and has no default. Every wave
  ends staged on a clean tree, so stopping and resuming later costs nothing.
- **No mid-run questions.** Agents settle every judgment call themselves with a decision matrix and
  write it to `SETTLED.md` — your end-of-run audit. Only an environment fault stops the run for you.
- **Code quality is co-equal.** A blind code gate (defects AND structural debt) reviews every diff
  before it stages — the polish never rots the codebase.
- **Critics build their own instruments.** Each aspect critic gets a persistent `testbed/` dir for
  screenshot harnesses, probes, and metrics tooling — reused wave after wave, never in the product.

### gauntlet or feature?

If "done" is an enumerable spec the user approves up front, that is **feature**. If "done" is *a
fresh critic, comparing blind, prefers ours to the exemplar*, that is gauntlet. Refining a system a
human should triage instead → **enhance**; hunting defects → **debug**.

## Scope: is this the right tool?

Games, product surfaces, sites, demos, tools that should look and feel shipped — anywhere flagship /
AAA / polished is the standard and an exemplar exists to compare against. Also: point `phase:"refine"`
at an **existing** product (no mvp phase at all) to iterate and improve it in place.

## How to use it

1. Author four documents with Claude before the run: `CANON.md` (goal + hard rules — your control
   surface), `BAR.md` (the exemplar + what each pointer witnesses), `COMPONENTS.md` (the MVP
   decomposition), `ASPECTS.md` (the quality dimensions to climb + how to observe each).
2. `phase:"mvp"` — components build in order, each blind-reviewed and staged.
3. `phase:"refine"` with a `cycles` wave budget — critic-led waves polish each open aspect; each wave
   is blind-reviewed and staged. Resume any time with more cycles.

The operator guide Claude follows is [`CLAUDE.md`](CLAUDE.md); the observed flow map is
[`FLOW.md`](FLOW.md).

## Reviewing the result

Run the product yourself; read the per-aspect `critique-*.md` trail (the ONE-gap-per-wave story of
the climb); audit `SETTLED.md` — every call the agents made without you; check `git diff --cached`.
Nothing is ever committed — you commit.

## Requirements

A git repo for the target, shell commands for `gates.build`/`gates.test`, and a way for critics to
observe the product (launch command, screenshots, probes — stated per aspect in `ASPECTS.md`).
