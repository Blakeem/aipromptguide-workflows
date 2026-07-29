# Stop criteria — knowing when to stop investigating (and deciding)

**Status: PLANNED (2026-07-28).** Nothing implemented. This file collects the ideas worth keeping from a
`decide-cycle` run on the question plus the operator's own design, and marks what still has to be settled
— above all **which parts belong in `investigate` and which in `decide`**, since both engines show the
same failure and almost certainly do not want the same fix.

**The reported failure**, from the operator of a real run:

> *"It is very good at proving a negative and weak at knowing when to stop. Both runs needed you or me to
> intervene on scope."*

---

## 1. The problem, precisely

The loop **asks for a reason to continue and never asks for a reason to stop.**

- The critic can only ever EXTEND the search. `agree` is consulted *only* alongside a termination claim
  the investigator already made (`investigate-cycle.mjs:502`); `contests_exhaustion` buys another round.
  There is no verdict meaning "you should have stopped."
- The critic cannot originate a claim: on a silent round no critic is spawned at all (`:431`).
- The prompts push the same way. The investigator is warned its claim will be attacked; the critic is
  told to *"Name ONE avenue, source, phrasing or adjacent domain it did not sweep."* That is an
  instruction to generate work, and a capable model always satisfies it.
- If the investigator never claims termination, the run has **no early exit at all** — it falls through
  `maxRounds`, which reports `not exhaustive (round budget spent)` whether or not the search was
  genuinely finished three rounds earlier.

**This is not primarily hallucination.** It is an unfalsifiable request: nothing bounds what an "avenue"
is, so no answer to "name one you missed" can ever be wrong.

`decide-cycle` has the same shape — see §5.3.

---

## 2. Evidence base

Everything below should be checked against these before it is trusted.

| Artifact | What it establishes |
|---|---|
| `E:/swim-spa/aipg/workflows/investigate/runs/lateral-freestanding-1/` | A complete real run: `CRITERIA.md` (12 pass/fail criteria), `DISQUALIFIED.md` (~96 adjudicated candidates), `acceptance-review-r1/-r2.md`, `DETERMINATION.md` (528 lines, `no_solution` + `exhaustive` after 2 rounds) |
| `runs/stop-criteria-1/` (this repo) | The `decide-cycle` run: two lens files, `decision-r1..r3.md`, `decision-review-r1..r3.md` |

**Two findings from that run that any design must respect:**

1. **Round 2 did not change the answer — it repaired the evidence.** The terminal state was the same
   after r2 as the claim in r1; the r2 critic accepted it. But round 2 contributed **43 of 96** ledger
   entries. So it was *high-yield and answer-neutral*. This is the single most important data point here:
   it means **raw yield is not a proxy for progress**, and it is why a naive "ledger stopped growing"
   gate would have kept this run going for the wrong reason.
2. **Stopping early costs evidence quality, not correctness** — at least on this run. That makes the loss
   bounded and statable, which is what lets a saturation stop be honest rather than reckless.

---

## 3. The reframe that unblocks this

The `decide` run scored the operator's diminishing-returns idea **1/10** on "terminates a finished
search" and ranked it 127/250. That verdict answers the wrong question, and the mistake is instructive:

- **Saturation is not a closure signal.** "The ledger stopped growing" never proves the space is closed.
  The run was right about that.
- **It was never offered as one.** The claim is that saturation marks the point where *"we start going
  down the rabbit hole or inventing things"* — a **reliability** signal, not a coverage one. Past it,
  additional rounds degrade the answer rather than improve it.

These route to **different terminal states**, which is precisely what the engine's five-distinct-states
rule already demands. They compose; they do not compete.

> **Keep these separate in any design.** *Are we done?* → coverage → `exhausted`.
> *Is continuing still productive?* → saturation → a **stopped**, not finished, state.

---

## 4. Ideas worth keeping

### 4.1 Saturation stop — *operator* · the core of this plan

Track the **trajectory of what is being learned**, not the total. When new material per round collapses,
stop and say so — as a stopped state, never as exhaustion.

**The metric is already in the schemas.** `new_options` and `disqualified_added` are returned every round.
Falling new material *is* the signal; nothing new needs computing.

**Gaming is not a concern, and this is the key simplification.** An investigator that under-reports
rediscovery in order to look busy is still not adding new material — and absence of new material is the
only signal the loop needs. There is no incentive to defend against, because the metric measures the
thing the cheater cannot fake.

**Open:** the exact rule (consecutive low-yield rounds? a ratio? relative to round 1?). §2's finding that
a high-yield round can be answer-neutral means yield alone is not enough — see 4.3.

### 4.2 Premise hand-back — *operator*, with an existing precedent in the engine

*"It would usually require updating the premise to find something new."* When a search saturates, the fix
is a different question, not more rounds — and the criteria file is deliberately fixed, so only the user
can supply that.

**The engine already does this, for exactly one exit.** The `no_solution` branch instructs the
investigator to name *"which single criterion the user could relax to change that."* Generalising it to
the saturation exit is applying a demonstrated mechanism to a second terminal state, not inventing one.

This is what actually removes the human-intervenes-on-scope problem: the run stops *and* hands back the
premise change that would unblock it.

### 4.3 Novelty / repetition tracking — *both sources, independently*

Operator: *"If similar issues or information keeps coming up, we also stop."*
Workflow: option **K″** — track contested avenue ids in a `Set`; a repeat ends the run honestly.

K″ scored **186** against the winner's **191**, and the decider's own note says the gap decides nothing:

> *"The margin over L is 3 points and over K″ is 5. Neither decides anything — both are inside my scoring
> noise."*

**Why this matters more than raw yield:** §2's round 2 was high-yield *and* answer-neutral. Repetition
catches what yield misses — the loop re-treading the same ground at volume. Two cheap forms:

- **Critic side, no agent needed:** the harness does set-equality on returned avenue ids across rounds. A
  repeated objection is a fact the harness can establish by itself.
- **Investigator side, one integer:** `rediscovered` — candidates found that the ledger had already
  closed. The investigator reads the whole ledger every round anyway. Corroborating, not load-bearing
  (see 4.1).

### 4.4 Declared-space closure — *workflow winner (`M`)*

Exhaustion is only decidable relative to a **declared finite space**. The operator declares the admissible
source classes (from the criteria file's own admissibility criterion); the investigator must account for
every class — **swept** or **closed by rule** — to claim termination; the critic may only contest by
naming a declared class; **absence of a contest closes the run**; an out-of-bounds objection gets its own
terminal state so a refused objection can never read as closure.

**Well grounded:** the determination in the real run already argues its own closure this way — *"Form (b)
is closed by exhausting C1's own six-item list."* The mechanism formalises what a good run does anyway.

**Ships with a known blocking defect — use `M′`, not `M`.** The closing branch reads only
`contests_exhaustion`, never `agree`, so a critic returning `agree:false, contests:false` (normal
vocabulary per the engine's own prompt) closes the run as `exhausted`. That is "didn't object" posing as
"verified closure" — the exact shape the first non-negotiable forbids. Fix is one branch plus one terminal
row: require `agree === true` to close, and give `contests=false && agree=false` its own NOT-finished row.

**Cost to weigh:** the operator must declare the class list correctly, and a class that is neither
sweepable nor closable by a criterion stalls the run to `maxRounds` forever. That may move the problem
rather than solve it. See §7.

### 4.5 Citation-linked contest — *operator* · prompt-only, cheapest item here

> *"There can't be pushback without a citation and one must follow into the other and be connected."*

Today the critic's objection needs no evidentiary standing at all, which is what makes "name an unswept
avenue" free. Requiring every contest to carry a citation, and requiring that citation to **connect to
the criterion it threatens**, raises the cost of a manufactured objection without bounding what an avenue
may be.

Prompt change only — no schema, no harness, no new role. Should be done regardless of which larger
mechanism wins, and it is the natural companion to 4.4's in-bounds test (which bounds *what* may be
named; this bounds *on what basis*).

### 4.6 Swept-avenue memory — *operator* · fixes a real gap in the artifact

> *"AI tends to lock into a single path and we don't have a signal over a long context since we are
> running many fresh agents."*

`DISQUALIFIED.md` records **rejected candidates**, not **searches performed**. So a fresh investigator can
re-run the same query, rediscover the same dead candidates, and the ledger never says *"this avenue was
already swept, these ways."*

The run **does** produce that record — `DETERMINATION.md` §13, *"Swept, with the primary source opened and
read"* — but only on the **terminating** round. Rounds 1..n−1 have no such memory.

Adding swept avenues to the ledger is memory that changes the next round's behaviour, which is the same
test the ledger already passes (#6 bans narration, not product). Also feeds 4.3 directly.

---

## 5. What applies where — **the main thing to settle**

The two engines share the failure but not the shape. Do not assume a fix ports.

### 5.1 Investigate

Converges on **coverage**. Its terminal states are already carefully distinct, and a saturation stop must
join them without blurring `exhausted`. Likely relevant: **all of 4.1–4.6**.

Sequencing to decide: 4.5 and 4.6 are cheap and independently useful — they may be worth landing first
and re-measuring before committing to 4.1 or 4.4, since better memory and costlier objections might move
the saturation point on their own.

### 5.2 Decide

Converges on **reviewer agreement about an argument** — there is no ledger, no coverage claim, and no
search space. So 4.4 and 4.6 do **not** port. What does:

- **4.3 (repetition)**, in a different form: does the reviewer raise a **new** gap each round, or repeat
  one? `gap_count` is already returned; the **trajectory is not tracked**. New gaps each round = a
  genuinely hard or underspecified question. Repeated gaps = the decider is not listening. Different
  diagnoses, currently indistinguishable.
- **4.2 (premise hand-back)** — for decide this means "the requirements are underspecified, here is the
  axis they do not settle," which is more actionable than the current generic advice.

### 5.3 The `stop-criteria-1` run is itself evidence for 5.2

It ended `needs-attention (no agreement within round budget)` after 3 rounds. That is the **correct**
outcome and a useful signal — the operator's read is that the hard cap already does churn detection, and
non-convergence on a broad question is itself information. Nothing is broken here.

The gap is only diagnostic: the reviewer found **6 new gaps** in the final round, which says "hard
question," not "decider ignoring feedback" — but the return cannot tell those apart today.

---

## 6. Rejected — do not re-litigate

| Idea | Why not |
|---|---|
| Lower `maxRounds` | Already the fallback, and it is exactly what makes a stopped search indistinguishable from a finished one. |
| Saturation → `exhausted` | Saturation never proves closure. It must route to a stopped state. This is the whole of §3. |
| A per-class contest budget ("one objection per class") | Killed by evidence: the r1 critic filed **two** independent, both-correct, both-load-bearing objections inside one class (`acceptance-review-r1.md:103` and `:135-144`). A budget would have refused the second. Withholding a true `no_solution` is the worst failure available. |
| Gate coverage on the criteria file's prose "Search Space" section | Would have failed round 2 of the real run and destroyed a verified `no_solution`. The admissibility criterion is the right list; the Search Space is a *procedure*, and its members are not all admissible sources. |
| A new agent role to judge "are we done" | #4. Also: the harness cannot judge content, and a fresh agent has no more signal than the critic already has. |

---

## 7. Open questions

1. **Does saturation need a coverage partner?** 4.1 alone stops honestly but cannot conclude. 4.4 alone
   concludes but depends on a well-declared class list. Is the answer both, or is 4.1 + 4.2 enough — stop
   honestly, hand back the premise, let the user decide?
2. **What exactly is the saturation rule?** §2 proves raw yield is not enough (high-yield, answer-neutral
   round). Candidate: yield **and** novelty together (4.3), not yield alone.
3. **Does 4.4's class-list burden move the problem?** A class neither sweepable nor closable stalls the
   run. The refine critic can advise but the harness cannot check it was heeded.
4. **What is the new terminal state called**, and does it fit the existing five without blurring them?
   Naming matters here more than usual — the whole point is that a stopped search never reads as a
   finished one.
5. **How much of this is prompt-only?** 4.5 certainly; possibly part of 4.3. Prompt-only changes are
   cheap to try and cheap to revert — worth exhausting before touching the loop.

---

## 8. Also found, unrelated — file separately

The near-miss marker added on 2026-07-28 has a **one-directional** contradiction guard. The engine warns
when `near_misses > disqualified_added` (over-claiming) but is blind to the inverse: near misses described
in prose with **no** `NEAR-MISS:` line in the ledger. The real run shows exactly that — its `CRITERIA.md`
hand-ordered *"Still record it as a documented near-miss"* (the operator inventing the concept because the
engine lacked it), the determination has a full near-miss section, and the ledger has **zero** markers.
The ledger is what the next round reads, so that is the direction that actually costs coverage.
