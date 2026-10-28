export const meta = {
  name: 'enhance-cycle',
  description: 'Read-only ENHANCEMENT audit of an existing system, lean/file-bus design. Fans out ONE finder per lens across the whole scope (breadth, not slices — cross-cutting enhancements are the point), each writing its candidates to candidates/<lens>.md, then verifiers bin-packed across lenses that confirm each candidate against the real code, kills anything the system ALREADY does, scores impact x size, and writes one verbatim proposals/<lens>.md, then STOPS. Enhancements only: a defect belongs in the debug workflow, and NOTHING here is auto-applied — there is deliberately no fix sibling. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Audit a system you already have for ENHANCEMENTS — bigger changes worth writing up, not nits: make it more efficient, simpler, cheaper, more robust, less work to operate, or smaller (removing a role/file/arg/code path is a first-class enhancement). The main agent settles the scope + the lenses with the user, then runs this engine. Each lens gets the whole scope and returns a verified, impact-scored, human-triage-ready proposal file. It then STOPS: YOU triage, and adopted proposals become plan-file blocks that refine-cycle converges and develop-cycle builds (feature mode, or section mode for a goal spanning many call sites). NOT for defects/bugs/typos — those are the debug workflow, whose inventory feeds an autonomous fixer. NOT for open-ended creative variations (brainstorm-cycle) or for concluding among competing approaches (decide-cycle).',
  phases: [
    { title: 'Find', detail: 'One finder per lens (CONCURRENT), each reading the WHOLE scope through its lens. Grounded candidates only: what the system does today (file:line) -> what it would do instead -> the concrete cost that removes, with the evidence for each, written to candidates/<lens>.md. The finder returns only the candidate ids. A lens that finds nothing writes its own clean proposals/<lens>.md marker.' },
    { title: 'Verify', detail: 'Spawned ONLY for lenses with candidates, bin-packed: lenses join one verify unit up to a candidate cap, and a lens never splits across units. Each verifier reads its lenses\' candidates files by path, re-checks each candidate against the real code, REJECTS anything the system already does / any unsubstantiated benefit / any nit / anything that is really a defect, scores impact x size, routes ADOPT | ROADMAP | NEEDS_USER | REJECT, and WRITES proposals/<lens>.md verbatim for each of its lenses.' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
//
// WHY THIS IS NOT THE DEBUG WORKFLOW. debug/review.mjs hunts DEFECTS and its inventory feeds
// develop-cycle's autonomous fix mode. Enhancements must never enter that path: they would be auto-applied
// behind a two-round gate (the exact scope creep debug exists to prevent), and an enhancement list does
// not converge the way a closed defect inventory does — there is always another enhancement. So this
// engine writes to proposals/ (never issues/), has NO fix sibling, and STOPS at the inventory. A
// human triages; adopted items become feature-mode or section-mode blocks of a plan file for develop.
//
// ENHANCEMENT, not improvement. The floor is deliberately high: a typo or a nit IS an improvement but
// nobody would write it up as an enhancement — and debug catches it anyway. Ask "would this be worth an
// enhancement ticket?"; if not, it is below the floor. REMOVAL counts: deleting a role, a file, an arg,
// or a code path is a first-class enhancement when it makes the system simpler, cheaper, or more
// reliable.
//
// Fan-out is by LENS over the WHOLE scope, not by file-slice (that is debug's axis, right for local
// defects). Enhancements are frequently cross-cutting — "every engine re-implements this" is invisible
// to a unit-scoped reader. For a corpus too large for one turn, run per subsystem with a
// narrower scope. Verification is local to each candidate, so verifiers pack several lenses' candidates
// into one unit, as debug packs small units, and each unit writes only its own lenses' files.
// =============================================================================
// args arrives from the Workflow tool VERBATIM and unvalidated, so a structural typo in a hand-built
// payload dies here as a bare parse error naming the runtime. Name the payload and the fix instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}
if (!A || !A.runId) {
  throw new Error('args must include at least { runId, root, target, scope, lenses }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent).
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                        // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the code)';
const GOALS       = A.goals ?? '';                         // what "better" MEANS for this system (the north star every lens serves)
const CONTEXT     = A.context ?? '';                       // domain facts the agents will not infer

// Impact floor — the "enhancement, not nit" gate. Marginal is below the default floor on purpose.
const IMPACT_RANK = { marginal: 1, moderate: 2, high: 3, transformative: 4 };
const MIN_IMPACT_NAME = A.minImpact ?? 'moderate';
// A plain lookup resolves an inherited name such as `constructor` to a function, which passes a truthiness check.
if (!Object.hasOwn(IMPACT_RANK, MIN_IMPACT_NAME)) {
  throw new Error(`args.minImpact must be one of ${Object.keys(IMPACT_RANK).join(' | ')} (got "${MIN_IMPACT_NAME}").`);
}

// Categories the finder must classify into. Overridable per run; a lens may narrow further in prose.
const CATEGORIES = Array.isArray(A.categories) && A.categories.length ? A.categories : [
  'efficiency',      // less time / tokens / compute for the same result
  'simplification',  // same behavior, less machinery
  'removal',         // delete something — a role, file, arg, code path — and the system gets better
  'robustness',      // fewer ways to fail, better failure behavior (NOT a present bug — that is debug)
  'capability',      // a genuinely new capability the system should have
  'operator-effort', // less manual work / fewer steps / less babysitting for the human
  'consistency',     // one way to do a thing instead of N divergent ones
  'observability',   // the operator can see what happened and why
  'cost',            // money, quota, storage
];

// Per-role model tiers + OPTIONAL custom subagent types. Both roles are opus: the finder needs breadth
// and judgment across the whole scope, the verifier is the quality gate that kills the noise.
const ROLE_KEYS = ['find', 'verify'];
const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku', 'fable']);
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'high';
// Copy of develop's roleMap, since an engine cannot import: a test pins the copies equal.
// Static lead clauses: gen-flows labels each throw node from them.
const roleMap = (name, value, legal) => {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid role map: args.${name} must be an object that maps a role key to a value; got ${JSON.stringify(value)}.`);
  }
  const entries = Object.entries(value);
  for (const [role, setting] of entries) {
    if (!ROLE_KEYS.includes(role)) {
      throw new Error(`Unknown role key in a role map: args.${name} names ${JSON.stringify(role)}, and the role keys are ${ROLE_KEYS.join(' | ')}.`);
    }
    if (!legal.has(setting)) {
      throw new Error(`Illegal role value in a role map: args.${name}.${role} is ${JSON.stringify(setting)}, and it must be one of ${[...legal].join(' | ')}.`);
    }
  }
  return Object.fromEntries(entries);
};
const M  = { find: 'opus', verify: 'opus', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { find: DEFAULT_EFFORT, verify: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
// agentTypes values name subagents in the caller's registry, so only the keys have a fixed set. A key
// outside them must throw, or its subagent is dropped without a word. A test pins the copies equal.
const agentTypeMap = (value, keys) => {
  if (value === undefined) return {};
  const entries = (value !== null && typeof value === 'object' && !Array.isArray(value)) ? Object.entries(value) : null;
  const invalid = !entries || entries.some(([role, type]) => !keys.includes(role) || typeof type !== 'string' || !type.trim());
  if (invalid) {
    throw new Error(`Invalid agentTypes arg: args.agentTypes must map a role key (${keys.join(' | ')}) to a subagent type name; got ${JSON.stringify(value)}.`);
  }
  return Object.fromEntries(entries);
};
const AT = agentTypeMap(A.agentTypes, ROLE_KEYS);
const roleOpts = (role, extra) => ({ model: M[role], effort: EF[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });
log(`enhance: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

const ROOT      = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm      = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs       = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
// args.notes = { dir, survey } makes every agent answer the exit survey in its own file under dir.
const notesArg = (value) => {
  if (value === undefined) return null;
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && [value.dir, value.survey].every((p) => typeof p === 'string' && /^([a-zA-Z]:)?\//.test(norm(p.trim())));
  if (!valid) {
    throw new Error(`Invalid notes arg: args.notes must be { dir, survey }, the absolute paths of the answers folder and of the EXIT-SURVEY.md file; got ${JSON.stringify(value)}. Omit it to run with no survey.`);
  }
  return { dir: norm(value.dir.trim()), survey: norm(value.survey.trim()) };
};
const NOTES = notesArg(A.notes);
const notesFile = (label) => `${NOTES.dir}/${String(label || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.md`;
// Every agent call goes through callAgent, so a notes run reaches each prompt and a run without notes changes none.
const callAgent = (prompt, opts) => agent(NOTES
  ? `${prompt}\n\nEXIT SURVEY: before your final return, read ${NOTES.survey} and append your answers to ${notesFile(opts?.label)} in the format it names, creating the folder if needed. That file is the one write allowed beyond your task's own writes, and you read no other file in that folder. The survey never changes your task or your return.`
  : prompt, opts);
// No `?? '.'` default. `abs()` resolves a relative path against ROOT, and ROOT is this TOOL's directory
// — so a default would silently point the audit at the tool instead of the system under audit. Unlike
// the build engines this one is read-only, so it is required only when it is actually load-bearing:
// when a scope path is relative and therefore has to resolve against something (checked below, once
// SCOPE exists). An all-absolute scope needs no repo at all.
const REPO      = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
const PROPOSALS_DIR = `${STATE_DIR}/proposals`;
const CANDIDATES_DIR = `${STATE_DIR}/candidates`;
// The most candidates a verifier carrying several lenses judges. A larger lens gets its own, never split.
const VERIFY_UNIT_CANDIDATES = 12;

const slug     = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();
// NOT issues/<unit>.md — that path is develop's fix-mode input and nothing here may be auto-applied.
const proposalFile = (lensId) => `${PROPOSALS_DIR}/${fileSafe(lensId)}.md`;
const candidatesFile = (lensId) => `${CANDIDATES_DIR}/${fileSafe(lensId)}.md`;
// The finder mints each id, so the prefix is what ties a verdict back to its lens inside a packed unit.
const candidatePrefix = (lensId) => `${slug(lensId)}-`;
// And deliberately NO shared NEEDS-USER.md. Every lens verifies concurrently, and an agent "append" is a
// read-modify-write, so two of them would silently clobber each other's entries in an unattended run. A
// user-only call belongs in that lens's own proposal file, where its options + recommendation already go.

// Scope — the paths every finder reads. Enhancements are cross-cutting, so a lens sees ALL of it.
const SCOPE = (Array.isArray(A.scope) ? A.scope : (A.scope ? [A.scope] : [])).map(String).filter(Boolean);
if (!SCOPE.length) {
  throw new Error('args.scope is required: the file/dir paths (repo-relative or absolute) every finder reads through its lens. Enhancements are cross-cutting, so each lens sees the WHOLE scope — keep it to what one agent can genuinely read in a turn, and split the run by subsystem if it is larger than that.');
}
// A relative scope path is meaningless without a repo to resolve it against — and guessing would send
// every finder to read the wrong tree and return a confidently wrong proposal list.
const RELATIVE_SCOPE = SCOPE.filter((p) => !/^([a-zA-Z]:)?\//.test(norm(p)));
if (RELATIVE_SCOPE.length && !REPO) {
  throw new Error(`args.target.repo is required when any args.scope path is relative (${RELATIVE_SCOPE.join(', ')}): pass the ABSOLUTE path to the system under audit — the directory holding its .git — since relative scope paths resolve against it. There is no default: args.root is THIS tool's directory, so defaulting would audit the tool. Give every scope path as an absolute path instead if the audit target is not one repo.`);
}

// Lenses — the axes of enhancement. Each becomes ONE finder (+ verifier) → ONE proposal file.
const LENSES = (Array.isArray(A.lenses) ? A.lenses : []).map((l, i) => {
  if (typeof l === 'string') return { id: slug(l) || `lens-${i + 1}`, focus: l, criteria: '' };
  const focus = l.focus || l.id || '';
  return { id: slug(l.id || focus) || `lens-${i + 1}`, focus, criteria: l.criteria || '' };
}).filter((l) => l.focus);
if (!LENSES.length) {
  throw new Error('args.lenses is required: a non-empty array of enhancement axes (strings, or { id, focus, criteria }), e.g. ["efficiency","simplification","operator-effort"]. The main agent picks these with the user beforehand (#4).');
}
const dupes = [...new Set(LENSES.map((l) => l.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`lens ids collide after slugging (${dupes.join(', ')}): two lenses would write the same proposal file — give each a distinct id.`);
}

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose lives in the candidates and
// proposal files.
// =============================================================================
const RELAYED_REQUEST = { type: 'boolean', description: 'true when your context holds a user request that the Workflow harness relayed ahead of this task, apart from the task text itself. false when it holds only this task. TRUE HALTS the run before any later agent.' };
const FIND_SCHEMA = {
  type: 'object',
  required: ['candidate_ids', 'wrote_candidates', 'wrote_clean_marker', 'relayed_request'],
  properties: {
    candidate_ids:      { type: 'array', items: { type: 'string' }, description: 'the id of each candidate in your candidates file, in file order ([] for a clean lens)' },
    wrote_candidates:   { type: 'boolean', description: 'true ONLY if you wrote the candidates file, false for a clean lens' },
    wrote_clean_marker: { type: 'boolean', description: 'true ONLY if you wrote the clean-lens marker file, false whenever you report any candidate' },
    relayed_request:    RELAYED_REQUEST,
  },
};

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'wrote_lenses'],
  properties: {
    wrote_lenses: { type: 'array', items: { type: 'string' }, description: 'the id of each lens whose proposal file you wrote (every lens of your unit is required, even when everything was rejected)' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['candidate_id', 'is_real', 'impact', 'size', 'decision'],
        properties: {
          candidate_id: { type: 'string' },
          is_real:      { type: 'boolean', description: 'false if the system ALREADY does this, the claimed cost does not exist, or you could not substantiate it from the code. A real candidate below the impact floor stays true: its impact score rejects it.' },
          impact:       { type: 'string', enum: ['transformative', 'high', 'moderate', 'marginal'], description: 'YOUR confirmed impact (finders over-rate; correct it)' },
          size:         { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
          decision:     { type: 'string', enum: ['ADOPT', 'ROADMAP', 'NEEDS_USER', 'REJECT'] },
          is_defect:    { type: 'boolean', description: 'true if this is really a BUG in current behavior, not an enhancement. Always REJECT these, and say so.' },
          too_risky:    { type: 'boolean', description: 'true if the risk you verified outweighs the cost removed. Always REJECT these, and name the risk.' },
          theme:        { type: 'string', description: 'short grouping keyword so related proposals can be planned together' },
        },
      },
    },
  },
};

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';
// Agents that wrote files through a shell heredoc lost backslashes and backticks.
const FILE_WRITE_NOTE = 'Write file content with the file-editing tool, since a shell heredoc can alter backslashes and backticks.';

// =============================================================================
// Shared prompt fragment
// =============================================================================
const ENV = `${REPO ? `TARGET REPO: ${REPO}  ` : 'NO TARGET REPO — every scope path below is absolute.  '}(lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
SCOPE — the paths under audit (repo-relative unless absolute). Every proposal targets the scope:
${SCOPE.map((p) => `  - ${p}`).join('\n')}
Files outside the scope may be read and cited as evidence. A proposal may also name a file outside the
scope that its change must touch.
CONVENTIONS / house rules (an enhancement must fit these, or argue explicitly for changing them):
${CONVENTIONS}
${GOALS ? `WHAT "BETTER" MEANS HERE (the north star every lens serves):\n${GOALS}\n` : ''}${CONTEXT ? `CONTEXT: ${CONTEXT}\n` : ''}
THIS IS AN ENHANCEMENT AUDIT:
  • An ENHANCEMENT makes a system that already WORKS work better: faster, cheaper, simpler, smaller,
    more robust, less work to operate, or newly capable.
  • A DEFECT (something the system gets WRONG today: a bug, a typo, an edge case, a destructive
    behavior) is NOT an enhancement and is never dressed up as one. A finder that verifies a defect in
    passing reports it as its own candidate whose title starts \`DEFECT:\`, with its Today line naming
    what is broken, its Instead line the fix and its Removes line the harm. It is routed to the defect
    workflow.
  • REMOVAL IS A FIRST-CLASS ENHANCEMENT. Deleting a role, a file, an argument, a phase, or a code path
    is one of the best outcomes available. Look for it deliberately.
  • THE FLOOR IS HIGH. Report ONLY ${MIN_IMPACT_NAME}+ impact. The test: would a competent engineer
    write this up as an enhancement ticket? A nit, a rename, a preference, or a tidy-up would not.
BE TOKEN-ECONOMICAL: don't restate large files back.`;

// =============================================================================
// Role prompts
// =============================================================================
const findPrompt = (lens) => `
You are an ENHANCEMENT FINDER examining an EXISTING, WORKING system through ONE lens. This is a
FIND-ONLY pass: you propose, a verifier confirms, and a HUMAN decides. Do NOT modify any file in the
target repo (the ONLY file you may write is the candidates file or the clean-lens marker described below,
in the run-state dir).
${ENV}
YOUR LENS: ${lens.focus}
${lens.criteria ? `WHAT TO WEIGH UNDER THIS LENS: ${lens.criteria}\n` : ''}
Read the WHOLE scope through your lens, and push it hard. Cross-cutting findings ("every engine
re-implements X", "these three roles could be two") are the most valuable thing you can return. Other
lenses run in parallel. Do not hedge toward them.

RULES:
- GROUND EVERY CANDIDATE IN THE CODE AS IT IS. For each: what the system does TODAY (cite file:line),
  what it would do INSTEAD, and the SPECIFIC cost that removes (tokens, wall-clock, agent count,
  operator steps, a failure mode, maintenance surface). If you cannot name the cost, it is not an
  enhancement. Drop it.
- READ BEFORE YOU PROPOSE. The most common failure of this pass is proposing something the system
  ALREADY DOES. Check the current code first, or the verifier rejects it.
- NO VAGUE PROPOSALS. "Consider refactoring", "add more tests", "improve error handling", "make it more
  modular" are not proposals. Name the change.
- NO RESTATING THE DESIGN. Describing back what the system does is not a finding.
- BE HONEST ABOUT RISK. What could this break or make worse? A proposal with no stated downside reads
  as unexamined.
- Impact is the SYSTEM's outcome, not how interesting the change is. Size is the work to land it.
  Score both honestly. Inflated impact gets rejected.
- QUALITY over count. Five substantiated enhancements beat twenty speculative ones.

CANDIDATES FILE: if you have ANY candidate, WRITE the file ${candidatesFile(lens.id)} (create
${CANDIDATES_DIR}/ if needed). ${REPLACE_NOTE} The verifier reads it by path, so it holds every
candidate whole. Number the candidates ${candidatePrefix(lens.id)}1, ${candidatePrefix(lens.id)}2 and so on, in file order. Its format is EXACTLY this:
-----
---
lens: ${lens.id}
---
# Candidates: ${lens.id}

(one block per candidate:)
### [<candidate_id>] <title: short, specific, stable>
- id: <candidate_id>
- category: <one of ${CATEGORIES.join(' | ')}>
- impact: <transformative | high | moderate | marginal>
- size: <trivial | small | medium | large>
- files: <the file(s) this touches, repo-relative, with line numbers where you can give them>

**Today:** <what the system ACTUALLY DOES today, citing file:line, not a paraphrase of the design>
**Instead:** <what it would do instead, concrete enough to hand to a builder>
**Removes:** <the SPECIFIC cost this removes>
**Risk:** <what this could break or make worse ("none" is rarely true)>
**Evidence:** <what grounds Today and Removes: each file:line you read, and each command you ran with its output>
-----
Then set wrote_candidates=true and wrote_clean_marker=false, and return every candidate id in file order.

CLEAN-LENS MARKER: if AND ONLY IF you have ZERO candidates, WRITE the file ${proposalFile(lens.id)}
(create ${PROPOSALS_DIR}/ if needed). ${REPLACE_NOTE} Write EXACTLY this content, then set wrote_clean_marker=true,
wrote_candidates=false and candidate_ids=[]:
-----
---
lens: ${lens.id}
reviewed: true
---
# Enhancements: ${lens.id}

No enhancements found above the ${MIN_IMPACT_NAME} impact floor.
-----
If you report ANY candidate, write no marker.
${WROTE_NOTE} ${FILE_WRITE_NOTE}
Return the ids and the two flags via the schema. A clean lens is a normal, good outcome.`;

const verifyPrompt = (unit) => `
You are the ENHANCEMENT VERIFIER, read-only on SOURCE: you write exactly one proposal file per lens
below and nothing else. For each candidate, inspect the ACTUAL code to decide whether it is REAL and
WORTH THE USER'S ATTENTION, correct its impact, and route it.
${ENV}
YOUR LENSES (judge each lens's candidates under that lens's focus):
${unit.map((m) => `  - LENS ${m.lens.id}: ${m.lens.focus}
      candidates file: ${candidatesFile(m.lens.id)}   (read it in full: every candidate with its evidence)
      candidate ids:   ${m.ids.join(', ')}
      proposal file:   ${proposalFile(m.lens.id)}`).join('\n')}
Judge only the candidate ids listed above. A block of a candidates file whose id is not listed for its
lens gets no verdict and stays out of every proposal file, since the run counts only listed ids.
A candidate's Today, Removes and Evidence lines are the finder's claims, not facts. Confirm each one
against the source it cites before you rely on it.

READING RULE: read the code each candidate cites, plus what you need to apply the REJECT rules. For
rule 1, search the scope for an existing mechanism that does what the candidate proposes, by what the
mechanism does and not only by the candidate's words.

REJECT RUTHLESSLY — in this order, first match wins. Set is_real=false for 1–3:
  1. THE SYSTEM ALREADY DOES THIS, the find pass's most common failure. Check every candidate against
     the current code before anything else.
  2. THE CLAIMED COST IS NOT REAL, or you cannot substantiate it from the code. A cost the code refutes
     is NOT REAL: cite the code that refutes it. A cost you cannot substantiate is UNPROVEN: its Rejected
     line starts \`UNPROVEN:\` and names the evidence that would substantiate it. A benefit that holds
     only under an assumption the code does not make is not a benefit.
  3. IT IS TASTE: a preference, a rename, a restructure with no named cost removed.
  4. IT IS A DEFECT, not an enhancement — the system gets this WRONG today. Set is_defect=true and
     REJECT it. Its block naming what is broken goes under \`## Defects to route\`, not
     \`## Rejected\`, so the user can route it to the defect workflow. Do NOT smuggle it through as an
     enhancement. A candidate that mixes a defect with a separable enhancement keeps its enhancement
     half: score and route that half with is_defect=false, narrow its Today and Instead lines to it,
     and put the defect half under \`## Defects to route\`.
  5. ITS RISK OUTWEIGHS IT. Check the stated risk against the code, and look for one the finder missed.
     A change that would break or weaken something the system needs, or leave ambiguous an instruction
     or contract that must be exact, is rejected unless the cost removed clearly outweighs it. Set
     too_risky=true and REJECT it with a one-line note under \`## Rejected\` naming the risk.

For each SURVIVOR, score and route:
  impact : transformative | high | moderate | marginal   (YOUR honest score, not the finder's)
  size   : trivial | small | medium | large
A real candidate you score below the ${MIN_IMPACT_NAME} floor keeps is_real=true and its honest impact, and the
ROUTING line "impact below the ${MIN_IMPACT_NAME} floor -> REJECT (below floor)" rejects it.
ROUTING (apply in order; first match wins):
  - is_real == false OR is_defect == true OR too_risky == true -> REJECT (one line under \`## Rejected\`,
    or one block under \`## Defects to route\` for an is_defect candidate)
  - impact below the ${MIN_IMPACT_NAME} floor -> REJECT (below floor)
  - a genuine product/design call only the USER can make (changes what the system IS, trades off two
    things the user values differently, or rests on intent you cannot read from the code)
    -> NEEDS_USER (fill its **Options:** and **Recommendation:** lines)
  - size == large OR the change alters a contract across files (a return field, an arg, a status
    string or a file format that more than one file reads or writes) -> ROADMAP (real, but needs
    planning, not a single change). A doc-only edit across many files is not a contract change and
    does not trigger ROADMAP.
  - otherwise -> ADOPT (well-scoped, ready to hand to a builder as-is)
Set a short \`theme\` keyword per verdict.

WRITE each lens's proposal file at the path listed with that lens (create ${PROPOSALS_DIR}/ if needed).
It holds that lens's candidates only. ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} Its format is EXACTLY this:
-----
---
lens: <the lens id>
focus: <the lens focus>
reviewed: true
note: PROPOSALS. Human triage required. Not a defect inventory. Nothing here is applied automatically.
---
# Enhancements: <the lens id>

(for EACH kept verdict — ADOPT, then ROADMAP, then NEEDS_USER — one block, highest impact first:)
### [<candidate_id>] <title>
- id: <candidate_id>
- files: <file:line, comma-separated>
- category: <category>
- impact: <your confirmed impact>
- size: <your confirmed size>
- decision: <ADOPT | ROADMAP | NEEDS_USER>
- theme: <theme>

**Today:** <what the system actually does now, with the file:line you confirmed it at>
**Instead:** <the change, concrete enough to hand to a builder>
**Removes:** <the specific cost this removes>
**Risk:** <what it could break or make worse>
**Options:** <the distinct choices and their tradeoffs>  (NEEDS_USER only)
**Recommendation:** <your suggested direction>           (NEEDS_USER only)

## Defects to route
(one block per defect, covering every is_defect candidate and every defect half split from a kept
candidate. A rejected defect goes here only, never also under Rejected. Write this section only when it
has a block:)
### [<candidate_id>] <what is broken, as a short title>
- file: <file>:<line>

**What:** <what is broken and its harm>
**Evidence:** <the trigger and what you confirmed: the triggering input, the probe command and its output, or the cited document>

## Rejected
(one line each: \`<title>: <why, with the file:line it rests on>\`)
-----
If NOTHING survived, write the frontmatter + heading + "No enhancements found above the
${MIN_IMPACT_NAME} impact floor." followed by the Defects to route section when it has a block, then the
Rejected section.
A question only the user can answer stays in that candidate's NEEDS_USER block in its lens's file. Its
**Options:** + **Recommendation:** lines ARE the escalation. Write no shared escalation file.
Do NOT write into any issues/ directory, and do NOT stage or commit.
List in wrote_lenses the id of each lens whose proposal file you wrote, and return all verdicts via the schema.`;

// =============================================================================
// Find per LENS, pack the lenses with candidates into verify units, verify each unit (read-only,
// concurrent), then STOP.
// =============================================================================
log(`enhance: ${LENSES.length} lens(es) over ${SCOPE.length} scope path(s) → ${PROPOSALS_DIR} [floor=${MIN_IMPACT_NAME}]`);
log(`spawn ceiling: ≤ ${LENSES.length * 2} agents (${LENSES.length} finder(s) + ≤${LENSES.length} verifier(s) — verify spawns only where candidates exist, packing lenses up to ${VERIFY_UNIT_CANDIDATES} candidates per verifier)`);

// The phase of the last agent each lens reached. A lost lens reports it as its `failed` stage, so a lens
// nobody searched reads apart from one whose search went unverified, even when a stage threw.
// Null prototype, so a lens id named like an Object member never reads an inherited value.
const lensStage = Object.create(null);
// The result row of each lens whose file an agent attested. A lens with no row lands in `failed`.
const lensResult = Object.create(null);
// The lenses whose finder reported a relayed user request. Any one of them halts the run before the verifiers.
const relayedLensIds = [];
const emptyCounts = () => ({ found: 0, adopt: 0, roadmap: 0, needs_user: 0, rejected: 0, defects: 0 });
// Digits only after the prefix, so lens `a`'s ids can never read as lens `a-2`'s inside one unit.
const isCandidateId = (lensId, id) => new RegExp(`^${candidatePrefix(lensId)}\\d+$`).test(id);

// -- Find: one agent per lens, reading the whole scope ------------------------------------------
const findLens = async (lens) => {
  lensStage[lens.id] = 'find';
  // `found`, not `r`: the attestation sweep in tests/static.test.mjs scopes each schema's consumer check
  // to the variable its agent return lands in, so the receiver name stays unique in this file.
  const found = await callAgent(findPrompt(lens), roleOpts('find', {
    schema: FIND_SCHEMA, phase: 'Find', label: `find:${lens.id}`,
  }));
  // A DEAD finder is not a clean lens: zero candidates from a null would report the lens as audited.
  if (!found) {
    log(`  ⚠ ${lens.id}: the finder DIED — this lens was NOT audited (no candidates, and any ${proposalFile(lens.id)} on disk is unverified). Re-run it.`);
    return null;
  }
  if (found.relayed_request === true) {
    relayedLensIds.push(lens.id);
    return null;
  }
  const returned = (Array.isArray(found.candidate_ids) ? found.candidate_ids : []).map(String);
  const ids = [...new Set(returned.filter((id) => isCandidateId(lens.id, id)))];
  if (ids.length < returned.length) log(`  ⚠ ${lens.id}: ignored ${returned.length - ids.length} candidate id(s) that repeat or do not read ${candidatePrefix(lens.id)}<n> — check ${candidatesFile(lens.id)}`);
  if (ids.length) {
    // An unattested candidates file may be an earlier launch's, so the verifier would judge stale candidates.
    if (found.wrote_candidates !== true) {
      log(`  ⚠ ${lens.id}: the finder did NOT confirm writing ${candidatesFile(lens.id)} — this lens was NOT audited. Re-run it.`);
      return null;
    }
    return { lens, ids };
  }
  // Candidates the harness cannot route would be dropped from every count, so the lens must not read as clean.
  if (returned.length) {
    log(`  ⚠ ${lens.id}: no candidate id the finder returned reads ${candidatePrefix(lens.id)}<n> — this lens was NOT audited (its candidates in ${candidatesFile(lens.id)} reach no verifier). Re-run it.`);
    return null;
  }
  // No candidate and no attested marker leaves no file anyone vouches for, so the lens goes to `failed`.
  if (found.wrote_clean_marker !== true) {
    log(`  ⚠ ${lens.id}: the finder did NOT confirm writing its marker — this lens was NOT audited (no candidates, and any ${proposalFile(lens.id)} on disk is unverified). Re-run it.`);
    return null;
  }
  log(`  ✓ ${lens.id}: nothing above the floor — finder wrote the marker, verify skipped`);
  lensResult[lens.id] = { lens: lens.id, focus: lens.focus, file: proposalFile(lens.id), counts: emptyCounts(), kept: [] };
  return null;
};
const toVerify = (await parallel(LENSES.map((lens) => () => findLens(lens)))).filter(Boolean);
if (relayedLensIds.length) {
  throw new Error(`A user request was relayed into the context of the finder for ${relayedLensIds.join(', ')} ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts.`);
}

// -- Pack: next-fit in lens order, as debug's gen-units packs small units -------------------------
const verifyUnits = [];
for (const member of toVerify) {
  const open = verifyUnits[verifyUnits.length - 1];
  if (open && open.count + member.ids.length <= VERIFY_UNIT_CANDIDATES) {
    open.members.push(member);
    open.count += member.ids.length;
  } else {
    verifyUnits.push({ members: [member], count: member.ids.length });
  }
}
if (verifyUnits.length) log(`enhance: ${toVerify.length} lens(es) with candidates → ${verifyUnits.length} verifier(s)`);

// -- Verify + write each lens's proposal file — ONLY for lenses with candidates -------------------
const verifyUnit = async (unit) => {
  const lensIds = unit.members.map((m) => m.lens.id);
  for (const id of lensIds) lensStage[id] = 'verify';
  const verified = await callAgent(verifyPrompt(unit.members), roleOpts('verify', {
    schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${lensIds.join('+')}`,
  }));
  // A dead verifier, or one that did not attest a lens's proposal file, leaves that lens unverified: no
  // row puts it in `failed` with no path reported, the one place the operator sees it.
  if (!verified) {
    for (const id of lensIds) log(`  ⚠ ${id}: the verifier DIED — this lens was NOT verified and any ${proposalFile(id)} on disk is unverified. Re-run it.`);
    return;
  }
  const wrote = new Set((Array.isArray(verified.wrote_lenses) ? verified.wrote_lenses : []).map(String));
  // Match every verdict back to a candidate we actually submitted (same guard as debug/review.mjs):
  // a hallucinated or repeated candidate_id would inflate the counts and put a phantom row in `kept`,
  // and the main agent would report adoption numbers the proposal file does not contain.
  const lensOf = new Map(unit.members.flatMap((m) => m.ids.map((id) => [id, m.lens.id])));
  const seen = new Set();
  const allVerdicts = verified.verdicts || [];
  const verdicts = allVerdicts.filter((x) => {
    if (!lensOf.has(x.candidate_id) || seen.has(x.candidate_id)) return false;
    seen.add(x.candidate_id);
    return true;
  });
  const stray = allVerdicts.length - verdicts.length;
  if (stray) log(`  ⚠ ${lensIds.join(', ')}: ignored ${stray} verdict(s) with an unknown or duplicate candidate_id`);
  for (const { lens, ids } of unit.members) {
    if (!wrote.has(lens.id)) {
      log(`  ⚠ ${lens.id}: the verifier did NOT confirm writing ${proposalFile(lens.id)} — this lens was NOT verified. Re-run it.`);
      continue;
    }
    const mine = verdicts.filter((x) => lensOf.get(x.candidate_id) === lens.id);
    const unjudged = ids.filter((id) => !seen.has(id));
    if (unjudged.length) log(`  ⚠ ${lens.id}: the verifier returned no verdict for ${unjudged.join(', ')} — they are in no count; check ${proposalFile(lens.id)} before triaging`);
    const by = (d) => mine.filter((x) => x.decision === d).length;
    const counts = {
      found: ids.length,
      adopt: by('ADOPT'),
      roadmap: by('ROADMAP'),
      needs_user: by('NEEDS_USER'),
      rejected: by('REJECT'),
      defects: mine.filter((x) => x.is_defect === true).length,
      tooRisky: mine.filter((x) => x.too_risky === true).length,
      unjudged: unjudged.length,
    };
    log(`  ✓ ${lens.id}: ${counts.found} candidate(s) → ${counts.adopt} adopt, ${counts.roadmap} roadmap, ${counts.needs_user} needs-user, ${counts.rejected} rejected${counts.defects ? ` (${counts.defects} were DEFECTS → debug workflow)` : ''}${counts.tooRisky ? ` (${counts.tooRisky} too risky)` : ''}`);
    lensResult[lens.id] = {
      lens: lens.id, focus: lens.focus, file: proposalFile(lens.id), counts,
      kept: mine.filter((x) => x.decision !== 'REJECT')
        .map((x) => ({ id: x.candidate_id, decision: x.decision, impact: x.impact, size: x.size, theme: x.theme || '' })),
    };
  }
};
await parallel(verifyUnits.map((unit) => () => verifyUnit(unit)));

const live = LENSES.map((l) => lensResult[l.id]).filter(Boolean);
const failed = LENSES.filter((l) => !lensResult[l.id]).map((l) => ({ id: l.id, stage: lensStage[l.id] }));
const failedLabels = failed.map((f) => `${f.id} (${f.stage})`).join(', ');
if (failed.length) log(`  ⚠ no verified proposal file from: ${failedLabels} — re-run these lenses`);

const total = (k) => live.reduce((s, r) => s + (r.counts[k] || 0), 0);
const adopt = total('adopt'), roadmap = total('roadmap'), needsUser = total('needs_user');
const unjudgedTotal = total('unjudged');
const unjudgedFiles = live.filter((r) => r.counts.unjudged > 0).map((r) => r.file);
const defects = total('defects');
log(`enhance: ${adopt} adopt, ${roadmap} roadmap, ${needsUser} needs-user across ${live.length} lens(es)${defects ? `; ${defects} candidate(s) were defects (debug workflow)` : ''}`);

return {
  runId: RUN_ID,
  proposalsDir: PROPOSALS_DIR,
  summary: { lenses: live.length, adopt, roadmap, needsUser, rejected: total('rejected'), defects, tooRisky: total('tooRisky'), unjudged: unjudgedTotal },
  // Cross-lens overlap is SIGNAL, not duplication: two lenses landing on the same change independently
  // is the strongest evidence in the run. The engine keeps lens files separate and lets the human see
  // the convergence (matching how brainstorm/decide treat their lenses) — no merge agent (#4/#6).
  lenses: live.map((r) => ({ lens: r.lens, focus: r.focus, file: r.file, counts: r.counts, kept: r.kept })),
  failed,
  nextStep: live.length === 0
    ? `NOTHING was audited: every lens failed: ${failedLabels}. There are no proposals to present — do NOT report a clean audit. Tell the user, then re-run those lenses with the same runId.`
    : `Read these proposal files and PRESENT them to the user: ${live.map((r) => r.file).join(', ')}. They hold ${adopt} ADOPT, ${roadmap} ROADMAP and ${needsUser} NEEDS_USER item(s) across ${live.length} lens(es). Present only the listed files: any other file in ${PROPOSALS_DIR}/ is from an earlier run or an agent that did not finish. Present the ADOPT items first (highest impact), then ROADMAP, then every NEEDS_USER with its options + recommendation. Call out any change TWO OR MORE lenses landed on independently — that convergence is the strongest signal in the run. Then triage with the user: adopted items become feature-mode blocks of a plan file, ROADMAP items a section-mode block when they span many call sites (otherwise a feature-mode plan of their own) — refine that file with refine-cycle, then build it with develop-cycle — and every block under a file's \`## Defects to route\` goes to the debug workflow. NOTHING here is applied automatically and there is no fix step — the user decides what gets built.${unjudgedTotal > 0 ? ` The verifier returned no verdict for ${unjudgedTotal} candidate(s) (summary.unjudged), so they are in no count: check them in ${unjudgedFiles.join(', ')} before triage.` : ''}${failed.length ? ` TELL THE USER these lenses were NOT audited and produced no verified proposal file: ${failedLabels} — offer to re-run just those. Any proposal file on disk for them is not presented until the lens is re-run.` : ''}`,
};
