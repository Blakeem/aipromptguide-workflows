# Workflow Principles

Design rules for Claude Code Workflows, the background `Workflow` engines such as `develop-cycle.mjs`.
Use them to write new workflows and to review existing ones. The goal is the simplest, lowest-friction
path to the outcome, with no fluff or extra agents. Engineer around a need instead of spawning a new
role for it. An agent earns its place only if no other agent, the harness, or the main agent (talking to
the user beforehand) can do its job without hurting quality.

Two terms used throughout:
- **Harness / conductor**: the JS workflow script. It is not an LLM and has no context window. It has no
  tools, so it cannot read files, run git, or write anything. It only sequences `agent()` calls and
  passes small control values.
- **Agent**: one `agent()` call. It starts with an empty context that holds only its prompt, works with
  its own tools, returns one structured value, and is then destroyed. Agents cannot message each other
  or keep context warm across calls.

---

## Principles

### 1. The harness routes and never reinterprets
The conductor sequences agents and passes only control signals, such as a round number, a file path, or a
boolean verdict. It never reads, summarizes, rewrites, or re-encodes the content agents exchange. Once the
harness or a middleman agent paraphrases a message, fidelity is lost and bias creeps in.

### 2. Content travels verbatim between agents through files
Each consuming agent reads the approved plan and every review from its source file. Nothing is parsed
into fields and rebuilt. The text an agent reads is the exact text its author wrote, so the plan the
developer reads is byte for byte the plan the user approved.

### 3. Need-to-know by file placement, not instruction
An agent that must not see a document is never given its path, and the document never sits in a
directory the agent reads. Do not rely on an instruction such as "don't read X." For example, the plan
from plan mode lives at `~/.claude/plans/<random-name>.md`. The blind reviewer is given no path to it and
works only inside the repo and its own review directory, so the plan cannot enter its context.

### 4. No busy work
The main agent does every preparatory or clerical step with the user before the run, such as cleaning
the working tree, config, supplying the plan, and deciding the gate. If the harness or the main agent can
do a job, no agent is spawned for it. Never invent a role another agent already covers. A "loader", a
"scribe", or a "baseline-prep" agent is a smell, so fold it in or remove it.

The same rule covers the operator's steps between runs. Anything carried between runs, such as a status,
a pending decision, or a launch condition, lives in durable state that an already-required step reads or
writes. It is never a step someone must remember. For example, develop's statuses reach the plan file
through `plan-edit.mjs args`, which every launch needs. A block waiting on the user stays `blocked`, so
`args` never selects it until someone flips it, and the launch waits on that same command's
notification. When a new need appears, fold it into the required step, or make it a required argument so
that it is a decision and cannot be skipped. Never add an agent or a checklist line for it.

### 5. Staged, escalating reviews
When building to a spec, gate the work in stages that must each pass:
1. an unbiased pure-code review with no spec, goal, or plan, which judges the code on its own merits for
   real defects, then
2. a plan-aware acceptance review, which verifies every requirement is met, the feature is reachable, and
   nothing regressed.

Stage 1 must be clean before stage 2 runs. Any code change re-enters at stage 1.

**Reviewer memory.** Reviewers stay fresh but keep the settled decisions. A blind reviewer that reruns
each round would otherwise re-flag every finding the developer declined on purpose, and that
re-litigation never converges. So the blind reviewer reads the dismissed-findings ledger. Per #3, it
reads the ledger from its own `gate/` directory, the only run-state path its prompt discloses. User
notes, amendments, critiques, and every plan-adjacent file live outside that directory. The plan-aware
acceptance stage reads the ledger and the user-notes file (#6). Neither stage reads the prior review
files. Reading the last review anchors a reviewer to that one finding, and it misses the similar bug two
lines away. Reading only the dismissed list lets it re-review the entire current diff fresh, so it skips
settled noise and independently re-verifies prior fixes, catching nearby or similar issues.

A reviewer may contest a dismissal it believes is wrong (`CONTESTS DISMISSAL: <why>`) for a
production-blocking defect. The developer must then fix or escalate it and never silently re-dismiss it.
This bounds the loop and keeps a wrongly dismissed real defect from being suppressed.

### 6. Only messages, ledgers, user notes, and product are written
The numbered, stage-named review files (`quality-review-N.md`, `acceptance-review-N.md`) are the
reviewers' messages. They also form the progress trail, since the count of each file shows how many
times each loop ran.

Narration about the run is forbidden, such as status files, run summaries, progress logs, and "what I
did" reports. A run writes only three kinds of file. These are the numbered inter-agent messages, the
ledgers and user notes below, and the workflow's own product, the thing the run exists to produce. The
product files are `issues/`, `proposals/`, `variations/`, `lenses/`, the decision files, investigate's
`options/` and `DETERMINATION.md`, the docs set and `INDEX.md`, develop's `SWEEP.md`, and a parked patch
(`parked-<id>.patch`, plus a `parked-<id>-newfiles/` directory when needed). `DETERMINATION.md` earns its
place the same way develop's `SWEEP.md` does. It holds the cross-option comparison and the coverage
evidence, which no per-option file contains, and it links to `options/<id>.md` instead of restating them.

A file that restates numbers the harness already has is narration whatever its title, so "product"
cannot be stretched to license a status file. For this reason the retired `resolve-cycle` deleted its
`SWEEP.md` while develop keeps its own. Develop's sweep re-derives the change surface from the goal by
grep and produces findings no per-block agent could reach. Resolve's sweep only retold the harness's own
accounting.

The developer's only outputs besides code are two append files:
- **`DISMISSED-<id>.md`**, the dismissed-findings ledger, one per plan, section, or batch. It holds one
  terse line per review finding the developer declined (false positive, intentional, conflicts with
  spec, not a real path), with just enough context that a reviewer is not in the dark. The line format
  is `<file:line> — <gist> — SKIPPED: <≤15-word reason>`. The ledger is an inter-agent message from the
  developer to the reviewers and the user's end-of-run audit of every judgment call.
- **`NEEDS-USER.md`**, the user-facing notes of blockers, questions, and decisions only the user can
  make. These may be as full as the user needs to decide. A hard blocker also stops its block (#7). A
  flag-and-proceed item is recorded, and the developer continues with a defensible default.

A search-shaped workflow carries two more ledgers on the same terms, investigate's **`DISQUALIFIED.md`**
and **`SEARCHED.md`**. `DISQUALIFIED.md` holds one terse line per rejected candidate, naming the
criterion it fails. `SEARCHED.md` holds the avenues each round swept, with the terms used, and the one
still untried. Like `DISMISSED-<id>.md` they are inter-agent messages, since each round's investigator
reads both before searching so that the round diverges from what already failed and from ground already
covered. They are the run's convergence mechanism, not a record of it. Their writers are strictly
sequential, which is the only reason a shared append-only file is safe.

The developer writes no "what I did" report, since its code is its output (#8). Reviewers write only
their numbered review files. Nothing outside this list is written.

### 7. The developer owns the decision matrix and is the only escalation point
The developer resolves ambiguity itself, with a decision matrix, before flagging anything. It logs a
declined finding tersely to `DISMISSED-<id>.md` (#6) so that reviewers don't re-raise it. It must fix or
escalate a contested dismissal (#5). Only a choice no agent can make, such as a real design or business
decision or an unresolvable blocker, goes to `NEEDS-USER.md`. If the developer cannot proceed without
the answer, its block stops immediately and is parked. The run halts only when later work depends on
that block (an ordered run), and independent blocks continue. Reviewers report to the developer through
their review files and never halt the run.

### 8. Control plane and data plane
Thin structured returns drive the loop (`clean?`, `pass?`, `needs_user?`). Rich content lives in files.
Every schema holds only decisions, never prose. A return value exists so that the harness can branch, not
to carry a message.

### 9. One staging, at the end
Only the final acceptance gate stages (`git add`), and only on pass. Nothing is ever committed, since
the user commits. Staging at the end is the regression boundary (staged is the accepted baseline,
unstaged is the work under review), and it lets features be built back to back without overlap.

A deterministic script the operator invokes may commit on `aipg/*` batch branches, since no agent
decides those commits. These are the accept, sync, and landing commits of `tools/wt.mjs land`. The user
still makes every commit that reaches their own branches.

### 10. Statelessness is a feature
Each agent starts cold and re-reads what it needs. For one bounded feature the re-read is cheap, and it
keeps every review independent and unanchored. Don't contort the design to keep agents warm.

### 11. Single source of truth
Each piece of working information lives in one canonical place. Every agent that needs it is handed the
path and reads it there (#2). No agent receives a copy pasted into its prompt or re-saved into a second
file, and no prompt restates a document's content. An agent may be handed more than one source when
each is distinct, such as a research agent comparing several references, since the rule forbids
duplication, not a second link. Make duplication structurally impossible with one path per fact, so
that nothing drifts out of sync. Copy only when the copy has a clearly different purpose with a
stated reason, such as a snapshot of the plan into `runs/<id>/PLAN.md` for a long-delayed resume. #2
governs content that moves verbatim when it moves. This principle governs not duplicating content unless
the copy earns its place.

### 12. Right-size before you run
Each run builds one bounded feature. A job too small to deserve a reviewed plan, such as a one-liner or
a rename, is too small for the workflow, so make the edit directly. A job too big, such as a
breadth-spanning migration, is split or built as section-mode blocks.

### 13. Laconic by subtraction
Every prompt, review file, ledger line, user note, and message maximizes signal, not shortness. Brevity
comes from deletion, never compression. Delete only three things:
- filler, such as preambles, sign-posting, self-narration, and the request restated back
- what the reader already knows, such as general knowledge, the spec quoted back, and anything already
  in the code, diff, or file in front of them
- what is not directly relevant to the action or decision at hand

Never cut information the reader needs to act. That is compression, and it is forbidden. Removing noise
raises brevity and clarity together, so there is no tradeoff to balance. The test is binary, per
sentence. Does the reader need this to act? If not, cut it. If so, keep all of it. A prompt gives its
agent concise instructions and does not restate content a linked file holds (#11).

The same test governs code comments and guides. A comment in an engine or tool states only the why the
code cannot show, such as a constraint, a workaround, or a measured decision, in one or two lines. It
never narrates what the code does, records history (what a line used to be, which review found it, a
date), or repeats the workflow's `CLAUDE.md`, which loads for anyone editing a file in that folder. A
guide never repeats another guide. For prompts, a guide does not count as something the reader already
has. Run-time agents work in the user's project and never load this repo's `CLAUDE.md` files. So a
prompt states each rule its agent needs, once, and cutting that rule because a guide holds it is
compression.

### 14. Evidence-grounded judgment
Every score, severity, verdict, and finding names the evidence it rests on, such as a `file:line`, a lens
claim, a test output, or a source URL. The citation is precise enough that a checker can verify it
exists and supports the judgment without trusting the judge. Where no evidence exists, such as a
legitimate synthesis or an estimate, the judge marks the claim as its own judgment with its confidence
and never fabricates support. This makes review loops converge on substance, since an objection states
"cell X cites lens Y, but Y says Z" instead of one assertion against another. For reviewers the rule
reads "no evidence, no gap". For researchers it reads "a claim without a source is a hypothesis, so mark
it as one".

### 15. A missing result is its own outcome
An agent that returns nothing (died mid-run, killed, empty output) is a distinct outcome. It is never
conflated with success, a clean verdict, or a legitimately empty result set. The defect shape is the
absorbing idiom, such as `r?.findings || []`, `verdict ?? 'ready'`, or `?? -1`. Each makes the dead
path byte-identical to a real one, so a run that lost an agent reports as a run that finished. Three
rules close it:
- **Every `agent()` consumption site states its death policy.** A solo critical agent, the only
  producer of the run's product, throws, since a dead searcher looks the same as a completed one. An
  agent inside a build loop halts and parks through the same park path any failure takes. An auxiliary
  agent, such as a sweep or one lens of many, logs the death and records it in the return (`failed`,
  `sweepFailed`, a needs-attention entry), so degraded coverage is reported and never absorbed.
- **Success is attested, and the harness reads the attestation.** An agent asked to write a file
  confirms it (`wrote_file`), and the harness reads that field. A required field that nothing reads has
  no effect (#8). The file bus then shows a death by absence, since the stage's expected file does not
  exist, and nothing downstream may fabricate a path to one.
- **Failure resumes through the normal mechanism.** There is no special recovery path. Every exit
  leaves the tree clean, with accepted work staged and unfinished work parked (Mechanics). So a run that
  lost an agent at any stage resumes like a fresh run that reads the durable trail of staging, numbered
  files, and ledgers, and nothing is lost. If a failure needs bespoke cleanup to resume, the exit path
  is wrong, not the resume.

---

## Scope

Principles #1 to #4, #6, #8, and #11 to #15 are core, and every workflow honors them. The rest are build-loop
rules and apply only where they fit.

- **Build loops** produce code (develop, plus debug's review that feeds it). They honor every principle,
  including the staged escalating review (#5), developer-owned escalation (#7), and one staging at the
  end (#9).
- **Generative and read-only workflows** do creative divergence, information provisioning, or read-only
  auditing (brainstorm, docs, enhance). They write no code, stage nothing, and never commit, so #7 and
  #9 don't apply. The user is the judge, and there is no AI review gate unless the workflow needs one.
  An audit that produces an inventory still gates it (enhance verifies every proposal against the real
  code). That gate keeps the list honest and approves no change.
- **An open-ended inventory never drives an autonomous fixer.** A closed inventory, such as debug's,
  which is fixed at triage, is what makes a fix loop converge. A proposal list has no such property,
  since there is always another enhancement. So a workflow that generates one stops at the inventory
  and hands it to a human. For this reason enhance has no fix-mode output and writes to `proposals/`,
  never `issues/`.
- **Convergence workflows** reach a conclusion (decide, investigate, refine). They run a review loop in
  the spirit of #5 but are non-blind by design. The reviewer must see the conclusion and the
  requirements it is judged against, since a reviewer blind to the decision can't evaluate it.
  Blindness (#3) guards against code-regression anchoring and is wrong for evaluating an argument. Each
  of the three shapes converges on something different:
  - **Argument** (decide) converges when reviewer and decider agree against a fixed requirements rubric,
    bounded by `maxRounds`. One up-front fan-out fixes the candidate set.
  - **Plan review** (refine) converges on one round in which a read-only critic finds no gap at or above
    a fixed defect floor. Its editor changes only the plan file, and only what a gap names.
  - **Search** (investigate) converges on coverage, an evidenced claim that nothing qualifying was left
    unsearched, which an adversarial critic may contest. Candidates are found round by round instead of
    generated up front. The ledger of what already failed makes each round diverge instead of circling.
    Since the product is a claim about absence, the engine keeps its terminal states distinct. Running
    out of rounds, running out of tokens, and proving nothing can qualify are three different facts, and
    folding any pair together lets fatigue pass as proof. For the same reason every solo critical agent
    throws when it returns nothing (#15).

## Mechanics

- **How files iterate.** The harness tracks the round number and hands each reviewer the exact output
  path (`…/quality-review-<round>.md`). The reviewer writes its findings there verbatim and returns a
  thin verdict. The developer is handed the path of the most recent review that flagged issues and reads
  it directly. Round N+1's developer is a fresh agent that rediscovers state from the working tree and
  that one review file.
- **First round.** The working tree must be clean of unstaged changes at the start. The main agent
  ensures this beforehand (#4), and the round-1 developer confirms it as its first act. If the tree is
  dirty, the developer halts before any reviewer is spawned. The check exists because the unstaged tree
  is the reviewers' scope, so a dirty start attributes someone else's work to the run. Verifying a
  precondition differs from an agent that establishes it, so there is no baseline agent or progress
  file. On round 1 there is no review file and nothing to address, and the developer implements the
  plan.
- **Park, don't discard.** Work that cannot pass within its round budget is saved to a patch file and
  then cleared from the tree. It is never deleted or left unstaged. Clearing is required, since the next
  unit's blind diff must be clean and the tree must be buildable. Destroying the work never is. The
  restore command goes in the user notes. A parked patch is the work itself, so it is product, one of
  #6's listed outputs.
- **Resume.** There is no progress file by design (#6). Durable progress is git staging plus the
  numbered review trail. Every terminal exit leaves the tree clean, with accepted work staged and
  unfinished work parked. So a resumed run starts from the same clean baseline as a fresh one, and the
  round-1 precondition applies unconditionally, including on resume. A parked unit's work lives in its
  patch, and the user decides whether to restore it before re-running that unit. This invariant is
  load-bearing, since an engine that halts leaving work in the tree would false-halt its own resume.
- **Preventing review spin.** The `DISMISSED-<id>.md` ledger stops a blind reviewer from re-flagging
  settled findings forever. Reviewers skip ledger items for the stated reason and may contest a clearly
  wrong one once. The developer must fix or escalate a contested item (#5).
- **Fresh and resumed state directory.** `DISMISSED-<id>.md` and `NEEDS-USER.md` are cumulative. The
  per-unit ledgers append across rounds, and `NEEDS-USER.md` is one global file. The main agent clears
  `runs/<id>/` for a fresh feature and preserves it on resume, so a halted run keeps its ledger and user
  notes. This is pre-run setup (#4), not an engine job.

---

## Workflow review checklist

Use these as yes/no checks when reviewing any workflow.

- [ ] Does the harness pass only control signals (paths, counts, booleans) and never paraphrased
      content? (#1)
- [ ] Does every agent that needs the spec or plan read it verbatim from its file, with no
      parse-and-rebuild step? (#2)
- [ ] Is every blind agent blind by placement (no path, not in its directories) instead of by instruction?
      (#3)
- [ ] Could any agent be eliminated, with its job folded into another agent, the harness, or the main
      agent's pre-run setup, without losing quality? If yes, eliminate it. Does everything carried
      between runs ride a step the operator must run anyway, with nothing left for someone to
      remember? (#4)
- [ ] Must an unbiased code review pass before the plan-aware acceptance review runs? (#5)
- [ ] Are the only files written the numbered inter-agent reviews, the developer's terse
      `DISMISSED-<id>.md` ledger (or investigate's `DISQUALIFIED.md`), the full user-facing
      `NEEDS-USER.md`, and the workflow's own product (`issues/`, `proposals/`, `variations/`,
      `lenses/`, decision files, investigate's `options/` and `DETERMINATION.md`, the docs set and
      `INDEX.md`, develop's `SWEEP.md`, a parked patch)? Any status, summary, progress, or "what I did"
      file is narration and a violation, including one that restates numbers the harness already has.
      (#6)
- [ ] Does the blind reviewer read the dismissed ledger from its own `gate/` directory (#3), and the
      acceptance stage the ledger and user notes, with neither reading the prior review files? (#5)
- [ ] Can a reviewer contest a wrong dismissal, and must the developer then fix or escalate it and never
      silently re-dismiss it? (#5)
- [ ] Does the developer own ambiguity resolution and log declines tersely? Is it the only thing that
      stops for the user, stopping its block immediately on a hard blocker and halting the run only when
      later work depends on that block? (#7)
- [ ] Do return schemas hold decisions only, with content in files? (#8)
- [ ] Is there a single staging step, at the end, on pass, and never a commit? (#9)
- [ ] Does every terminal outcome leave the working tree clean, with unfinished work saved to a patch
      instead of discarded or left unstaged? Is the restore command in the user notes? (#9, Mechanics)
- [ ] Is each fact kept in one canonical place, with agents linked to it and never handed copies or
      restated content? Does every copy serve a clearly different, stated purpose? (#11)
- [ ] Is every prompt, review, and ledger line laconic by subtraction, with filler, known context, and
      irrelevant detail cut and nothing the reader needs to act on compressed away? Does every code
      comment state only a why the code cannot show, with no history and nothing the folder's
      `CLAUDE.md` already says? (#13)
- [ ] Does every score, severity, verdict, and finding cite checkable evidence (file:line, source, lens
      claim) or mark itself the judge's own judgment with a confidence? Are there no asserted numbers
      and no fabricated citations? (#14)
- [ ] Does every `agent()` consumption site have an explicit death policy (solo critical throws, build
      loop halts and parks, auxiliary logs and records it in the return)? Is there no absorbing idiom
      (`|| []`, `?? default`) that makes a dead agent identical to a legitimate outcome? Does the harness
      read every write-attestation field? (#15)
- [ ] Can a run that lost an agent at any stage resume through the same mechanism as a normal resume
      (clean tree and durable trail), with no bespoke recovery step and nothing lost? (#15)
