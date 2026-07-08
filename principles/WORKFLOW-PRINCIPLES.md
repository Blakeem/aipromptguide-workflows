# Workflow Principles

Design rules for **Claude Code Workflows** (the background `Workflow` engines I author, e.g.
`feature-cycle.mjs`). Use this to **write** new workflows and to **review** existing ones. The goal
is always the **simplest, lowest-friction path** to the outcome — *no fluff, no extra agents.* We
**engineer around** a need rather than spawn a new role for it. An agent earns its place only if no
other agent, the harness, or the main agent (talking to the user beforehand) can do its job without
hurting quality.

Two terms used throughout:
- **Harness / conductor** — the JS workflow script itself. It is **not an LLM**, has **no context
  window**, and has **no tools** (it cannot read files, run git, or write anything). It only
  sequences `agent()` calls and passes small control values.
- **Agent** — one `agent()` call. Born with an **empty context** (only its prompt), does its work
  with its own tools, returns **one structured value**, then is **destroyed**. Agents cannot message
  each other and cannot keep "warm" context across calls.

---

## The principles

### 1. The harness routes; it never re-interprets
The conductor sequences agents and passes **only control signals** — a round number, a file path, a
boolean verdict. It never reads, summarizes, rewrites, or re-encodes the *content* agents exchange.
The moment the harness (or a middle-man agent) paraphrases a message, fidelity is lost and bias
creeps in.

### 2. Content travels verbatim, agent-to-agent, via files
The approved plan and every review are **read from their source file by the consuming agent**.
Nothing is parsed-into-fields-and-rebuilt. The text an agent reads is the *exact* text its author
wrote — the plan the developer reads is byte-for-byte the plan the user approved. **No mutation,
no reinterpretation, no lossy copy.**

### 3. Need-to-know by file *placement*, not by instruction
An agent that must not see a document is simply **never given its path**, and that document **never
appears in a directory the agent reads**. Do not rely on "please don't read X." Example: the plan
from plan mode lives at `~/.claude/plans/<random-name>.md`; the blind reviewer is given no path to
it and works only inside the repo + its own review directory, so the plan **cannot** enter its
context.

### 4. No busy-work agents — setup happens before the run
Every preparatory or clerical step — clean working tree, config, supplying the plan, deciding the
gate — is done by the **main agent with the user, beforehand**. If the harness or the main agent can
do a job, **no agent is spawned for it**. Never invent a role another agent already covers (a
"loader," a "scribe," a "baseline-prep" are smells: fold them in or eliminate them).

### 5. Staged, escalating reviews
When building to a spec, gate it in **stages that must each be passed**:
1. an **unbiased pure-code review** — *no spec, no goal, no plan* — judging the code on its own
   merits for real defects, then
2. a **plan-aware acceptance review** — verifies every requirement is met, the feature is reachable,
   and **nothing regressed**.

Stage 1 must be clean before stage 2 runs. **Any code change re-enters at stage 1.**

**Reviewers stay fresh, but not amnesiac.** A blind reviewer that re-runs each round would otherwise
re-flag every finding the developer already, deliberately, declined — an unbounded re-litigation that
never converges. So reviewers read the **dismissed-findings ledger** and the **user-notes file**
(#6) — the settled decisions — but **never the prior review files**. Reading the last review anchors a
reviewer to *that one finding* and it misses the similar bug introduced two lines away; reading only
the *dismissed list* lets it re-review the whole current diff fresh, so it both skips settled noise
**and** independently re-verifies prior fixes (catching nearby/similar issues). A reviewer may
**contest** a dismissal it believes is wrong (`CONTESTS DISMISSAL: <why>`) for a genuinely
production-blocking defect; the developer must then **fix or escalate it — never silently re-dismiss**
(this bounds the loop and prevents a wrongly-dismissed real defect from being silently suppressed).

### 6. The only writes are inter-agent messages (numbered) and notes for the user
The **numbered, stage-named review files** (`quality-review-N.md`, `acceptance-review-N.md`) ARE the
reviewers' messages — and they double as the **transparent progress trail** (the count of each file
shows how many times each loop ran). Write **nothing else**: no status files, no run summaries, no
"what I did" logs.

The **developer's *only* outputs besides code** are two append files:
- **`DISMISSED.md`** — the dismissed-findings ledger: one **terse line** per review finding the
  developer declined (false positive, intentional, conflicts-with-spec, not-a-real-path), just enough
  context for a reviewer not to be in the dark — `<file:line> — <gist> — SKIPPED: <≤15-word reason>`.
  This is an inter-agent message (developer → reviewers) and the user's end-of-run audit of every
  judgment call made.
- **`NEEDS-USER.md`** — user-facing notes: blockers, questions, and decisions only the user can make.
  These may be **as full as needed** for the user to decide. A *hard blocker* also halts the run
  (#7); a *flag-and-proceed* item is recorded and the developer continues with a defensible default.

The developer writes **no** "what I did" report — its code is its output (#8). Reviewers write **only**
their numbered review files. Nothing else is ever written.

### 7. The developer owns the decision matrix and is the only escalation point
The developer resolves ambiguity **itself**, via a decision matrix, before flagging anything. A
finding it declines is logged tersely to `DISMISSED.md` (#6) so reviewers don't re-raise it; a
**contested** dismissal must be **fixed or escalated, never silently re-dismissed** (#5). Only a
genuine choice **no agent can make** (a real design/business decision, an unresolvable blocker) goes
to `NEEDS-USER.md`; if the developer cannot proceed without the answer, the run **halts immediately**
so the user decides before anything continues. Reviewers report to the developer (via their review
files); they never halt the run.

### 8. Control plane vs data plane
**Thin structured returns drive the loop** (`clean?`, `pass?`, `needs_user?`). **Rich content lives
in files.** Keep every schema to *decisions*, never prose — a return value exists so the harness can
branch, not to carry a message.

### 9. One staging, at the very end
Only the **final acceptance gate** stages (`git add`), and **only on pass**. **Nothing is ever
committed — the user commits.** Staging at the end is the regression boundary (staged = accepted
baseline, unstaged = the work under review) and lets features be built back-to-back without overlap.

### 10. Statelessness is a feature, not a cost
Each agent starts cold and re-reads what it needs. For one bounded feature this is cheap, and it
keeps every review **independent and unanchored**. Don't contort the design to keep agents "warm" —
the small re-read cost buys integrity.

### 11. Single source of truth — link, don't copy
Each piece of working information lives in **one canonical place**, and every agent that needs it is
**handed the path and reads it there** (#2) — never a copy pasted into a prompt or re-saved into a
second file. Don't restate a document's content back into an agent's instructions; point to the file.
An agent may be handed **more than one source when each is genuinely distinct** (e.g. a research agent
comparing several references) — the rule is *no duplication*, not *exactly one link*. Make duplication
**structurally impossible, not merely discouraged**: one path per fact, so nothing can drift out of
sync. Copy only when the copy serves a **clearly different purpose** with a stated reason (e.g. a
long-delayed-resume snapshot of the plan into `runs/<id>/PLAN.md`). Where #2 governs *content moving
verbatim when it moves*, this governs *not duplicating it at all unless the copy earns its place*.

### 12. Right-size before you run
One **bounded** feature per run. Too small (a one-liner, a rename) → make the edit directly. Too big
(breadth-spanning migration) → split, or use a different engine. A thing too small to deserve a
reviewed plan is too small for the workflow.

### 13. Laconic by subtraction — cut noise, never compress
Every prompt, review file, ledger line, user note, and message **maximizes signal, not minimizes
length**. Get brevity by **deletion, not compression** — and delete only three things: **filler**
(preambles, sign-posting, self-narration, the request restated back); **what the reader already knows**
(general knowledge, the spec quoted back, anything already in the code/diff/file in front of them); and
**what is not directly relevant** to the action or decision at hand. **Never** cut information the
reader needs to act — that is compression, and it is forbidden. This is **not a balancing act**:
removing noise raises brevity *and* clarity together, so there is nothing to trade. The test is binary,
per sentence — *does the reader need this to act?* No → cut it. Yes → keep it whole. (Prompts included —
give each agent concise instructions and don't restate content a linked file already holds; #11 keeps
that content in one canonical place.)

### 14. Evidence-grounded judgment — cite or confess
Every score, severity, verdict, and finding names the **evidence it rests on** — a `file:line`, a lens
claim, a test output, a source URL — precisely enough that a checker can verify the citation **exists
and supports the judgment**, instead of re-deriving it from trust. Where no evidence exists (a
legitimate synthesis, an estimate), the judge **marks it as its own judgment, with its confidence** —
it never fabricates support. This is what makes review loops converge on substance: an objection
becomes "cell X cites lens Y, but Y says Z," not a duel of assertions. The same rule pointed at
reviewers reads *no evidence, no gap*; pointed at researchers, *a claim without a source is a
hypothesis — mark it as such*.

---

## Scope — which principles apply to which workflow kind

Principles #1–4, #6, #8, #11–14 are **core** — every workflow honors them. The rest are
**build-loop** rules and apply only where they fit:

- **Build loops** (produce code — feature/migrate/debug) honor everything, including the staged
  escalating review (#5), developer-owned escalation (#7), and one-staging-at-the-end (#9).
- **Generative & read-only workflows** (creative divergence, information provisioning — e.g. brainstorm,
  docs) write **no code**, stage nothing, and **never commit**, so #7 and #9 don't apply. The user
  is the judge; there is no AI review gate unless the workflow genuinely needs one.
- **Convergence workflows** (the AI reaches a conclusion — e.g. decide) DO run a review loop in the
  spirit of #5, but **non-blind by design**: the reviewer must see the conclusion and the requirements
  it's judged against, because a reviewer blind to the decision can't evaluate it. Blindness (#3) guards
  against *code-regression* anchoring; it is wrong for *evaluating an argument*. Such a loop converges
  when reviewer and decider agree against a fixed requirements rubric, bounded by `maxRounds`.

## Mechanics that follow from these

- **How files iterate.** The harness tracks the round number and hands each reviewer the exact output
  path to write (`…/quality-review-<round>.md`). The reviewer writes its findings there verbatim and
  returns a thin verdict. The developer is handed the path of the **most recent review that flagged
  issues** and reads it directly. Round N+1's developer is a fresh agent that rediscovers state from
  the working tree + that one review file.
- **First round.** The working tree is assumed **clean of unstaged changes** at the start (the main
  agent ensures this beforehand — #4). So on round 1 there is no review file and nothing to
  reconcile; the developer just implements the plan. No baseline agent, no progress file.
- **Resume.** There is no progress file by design (#6). A halted run is resumed by re-invoking it;
  the developer's in-progress work persists **unstaged** in the tree and the next developer builds on
  it. Because staging only happens on final acceptance (#9), in-progress work is never accidentally
  folded into the baseline.
- **Preventing review spin.** The `DISMISSED.md` ledger is what stops a blind reviewer from
  re-flagging settled findings forever. Reviewers skip ledger items *for the stated reason*, may
  contest a clearly-wrong one once, and the developer must fix-or-escalate a contested item — bounding
  the loop and ensuring no wrongly-dismissed real defect is silently suppressed (#5).
- **Fresh vs. resumed state dir.** `DISMISSED.md` and `NEEDS-USER.md` are cumulative single files. The
  main agent **clears `runs/<id>/` for a genuinely fresh feature** and **preserves it on resume** (so
  a halted run keeps its ledger + user notes). This is pre-run setup (#4), not an engine job.

---

## Workflow-review checklist

Use these as yes/no checks when reviewing any workflow against these principles:

- [ ] Does the harness pass **only** control signals (paths, counts, booleans) — never paraphrased
      content? (#1)
- [ ] Is the spec/plan **read from its file verbatim** by every agent that needs it, with **no**
      parse-and-rebuild step? (#2)
- [ ] Is every "blind" agent blind by **placement** (no path, not in its directories), not by polite
      instruction? (#3)
- [ ] Could any agent be **eliminated** — its job folded into another agent, the harness, or the main
      agent's pre-run setup — without losing quality? If yes, eliminate it. (#4)
- [ ] Is there an **unbiased code review** that must pass **before** the plan-aware acceptance review?
      (#5)
- [ ] Are the **only** files written the numbered inter-agent reviews, the developer's terse
      `DISMISSED.md` ledger, and full user-facing `NEEDS-USER.md`? Any status/summary/log file is a
      violation. (#6)
- [ ] Do reviewers read the **dismissed ledger + user notes** (settled decisions) but **never the
      prior review files**, so they stay fresh yet don't re-litigate? (#5)
- [ ] Can a reviewer **contest** a wrong dismissal, and must the developer then **fix or escalate**
      (never silently re-dismiss), so no real defect is suppressed and the loop still converges? (#5)
- [ ] Does the **developer** own ambiguity resolution, log declines tersely, and is it the **only**
      thing that halts for the user — immediately, on a hard blocker? (#7)
- [ ] Are return schemas **decisions only**, with content in files? (#8)
- [ ] Is there **exactly one** staging step, at the end, on pass, and **never** a commit? (#9)
- [ ] Is each fact kept in **one canonical place**, agents **linked to it** (never handed copies or
      content restated into prompts), with duplication only where a copy serves a **clearly different,
      stated purpose**? (#11)
- [ ] Is every prompt, review, and ledger line **laconic by subtraction** — filler, already-known
      context, and irrelevant detail cut, with **nothing the reader needs to act on** compressed away?
      (#13)
- [ ] Does every score, severity, verdict, and finding **cite checkable evidence** (file:line, source,
      lens claim) — or explicitly mark itself the judge's **own judgment with a confidence** — with no
      asserted numbers and no fabricated citations? (#14)
