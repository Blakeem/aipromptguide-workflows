export const meta = {
  name: 'decide-cycle',
  description: 'Convergent decision, lean/file-bus design: fan out ONE researcher per lens (each finds options through its lens, gathers cited evidence for them and scores them, written to its own file), then a DECIDER funnels them into one conclusion via a global weighted decision matrix that pulls in the best of each. Each open issue the decider names (a question whose answer could change the winner) gets a researcher, up to maxResearchers per round, round after round, until the issues are covered, two research rounds in a row find no new evidence, or maxResearchRounds is spent. Then ONE final reviewer per review round judges the answer in two stages: first BLIND, scoring every candidate on the fixed requirements from an evidence ledger that holds the sourced facts and no score, then, once a check tool locks that judgment, against the decision file, where it may withdraw an objection only by quoting a sourced fact. An objection is a non-negotiable the winner violates or a challenger that scores higher on the same rubric; every other concern is a caveat. A check agent verifies the lock and counts the objections and caveats, and a kept objection sends the decision back to the decider. Looped until the reviewer accepts. The harness only routes paths + verdicts; rich content lives in files.',
  whenToUse: 'Have the AI reach a JUSTIFIED conclusion among approaches, weighing real trade-offs. Set selection:"ranked" instead when the answer is legitimately a PORTFOLIO rather than a choice — "give me the best N, I will pick or combine" — e.g. ranking a large pool of candidates surfaced by many agents over a big corpus; same matrix, same citation discipline, same adversarial review, but the output is an ordered shortlist with combine/exclusive notes and no single winner. The main agent authors the REQUIREMENTS (non-negotiable constraints + weighted criteria — the rubric both the decider and reviewer judge against) in PLAN MODE, approves them with the user, picks the LENSES (e.g. efficiency, simplest, robustness, best-practice), then runs this engine. It diverges into lensed option-generation, then converges via a decider ⇄ research loop gated by a decider ⇄ review loop. To explore open-ended creative variations for a HUMAN to pick (no AI verdict) use brainstorm-cycle; to BUILD the chosen approach, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.',
  phases: [
    { title: 'Diverge', detail: 'One researcher per lens (CONCURRENT). Each reads the requirements (verbatim) + its lens, generates 2–4 options, gathers cited evidence for them, scores them under its lens, recommends one, and writes lenses/<lens>.md. Returns a thin index.' },
    { title: 'Decide', detail: 'The decider reads the requirements + every lens file (+ the research files of the latest research round, + the previous review round\'s final review), combines the best elements, builds a GLOBAL weighted decision matrix: musts pass/fail, wants met / partly met / missed, every cell citing its evidence or marked own judgment. It picks the winner, writes decide/decision-rN.md with an Open issues section and a Checks for the user section, writes review/ledger-rN.md (the answer under review, the candidates and the sourced facts, no score or reasoning), and returns the choice + the open issue slugs.' },
    { title: 'Research', detail: 'One researcher per open issue, for the first maxResearchers issues the decider lists (CONCURRENT). The rest are carried to the next decider pass. Each reads the requirements, the issue in the decision file and the files the decider names for it, searches with the tools it has, and writes research/r<N>-<slug>.md with its findings cited, or a check for the user when no agent can settle it. Returns whether it found new evidence. The decider then runs again. Research stops on covered (no open issue), saturated (two research rounds in a row with no new evidence) or cap (maxResearchRounds).' },
    { title: 'Review', detail: 'A check agent writes the round\'s check spec and reveal text to locks/. ONE fresh reviewer reads the requirements + the ledger, scores every candidate blind and fills in review/review-rN.md, whose skeleton review-check.mjs writes, with its objections and verdict. Its next run of the check locks that file, writes the final file\'s skeleton and prints the reveal: read the decision file, sort each objection into withdrawn (by a quoted sourced fact), kept or downgraded, fill in the final file and run the check again. The check agent then runs review-check.mjs --verify: a matching lock gives the verdict from the kept count and names the caveat count, a mismatch falls back to the locked blind verdict, and a missing lock reruns the reviewer once, then blocks. A kept objection drives another Decide round.' },
  ],
};

// =============================================================================
// Config — everything decision-specific arrives via args so the engine stays general.
// Decide is a CONVERGENCE workflow: it produces a conclusion, not code — nothing is staged or
// committed. Its review is STAGED (WORKFLOW-PRINCIPLES.md #3/#5). A judge shown a prior score anchors on
// it, so the reviewer scores the candidates blind from an evidence ledger first, and sees the decision
// only after a check tool has locked that judgment. The fixed requirements file is the anti-spin rubric.
// Both agents check against it, so the loop converges. The main agent authors the requirements + picks the
// lenses with the user BEFOREHAND (#4) — the engine spawns no setup/loader agent.
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
  throw new Error('args must include at least { runId, root, lenses, planPath, checkTool }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL read-only context
const CONTEXT     = A.context ?? '';                       // short extra framing (domain facts the agents won't know)
const TESTBED     = A.testbed ?? '';                       // OPTIONAL: how agents may empirically test claims (e.g. a read-only sqlite db + how to query it)
// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0.
// The upper bound stops a fat-fingered maxRounds from spawning agents until something dies.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round run and reports it as an ordinary result.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 3, 50);    // decider ⇄ reviewer rounds before "needs-attention"
const MAX_RESEARCH_ROUNDS = num(A.maxResearchRounds, 'maxResearchRounds', 0, 3, 50);   // run-wide research rounds
// The decider sets the open issue count, so this bounds the researchers one research round launches at once.
const MAX_RESEARCHERS = num(A.maxResearchers, 'maxResearchers', 1, 10, 50);

// SELECTION — what the decider is asked to produce.
//   'single' (default) : ONE justified winner + why-not-each-runner-up. The normal decision.
//   'ranked'           : a RANKED SHORTLIST of the strongest options, no single winner, with what each
//                        buys and costs and which of them combine. Use when the answer is legitimately
//                        a portfolio rather than a choice — "give me the best N, I'll pick" — e.g.
//                        ranking a large pool of candidates surfaced by many agents over a big corpus.
// Both modes run the SAME weighted matrix with the same citation discipline (#14) and the same
// adversarial review; only the shape of the conclusion (and what the reviewer checks) differs. In
// 'single' the decider may still build a HYBRID that combines the best of several lenses — that has
// always been in scope and is not what 'ranked' is for.
const SELECTION   = A.selection ?? 'single';
if (SELECTION !== 'single' && SELECTION !== 'ranked') {
  throw new Error(`args.selection must be 'single' (one justified winner — the default) or 'ranked' (a ranked shortlist, no single winner); got "${SELECTION}".`);
}
const RANKED      = SELECTION === 'ranked';
const SHORTLIST_N = num(A.shortlist, 'shortlist', 2, 5, 50);    // ranked only: how many to carry on the list

// Per-role model tiers + OPTIONAL custom subagent types. Decider + reviewer are opus (high stakes);
// the researchers and the check agent, which only writes and runs fixed text, are the fast tier by default.
const ROLE_KEYS = ['research', 'decide', 'review', 'check'];
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
const M  = { research: 'sonnet', decide: 'opus', review: 'opus', check: 'sonnet', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { research: DEFAULT_EFFORT, decide: DEFAULT_EFFORT, review: DEFAULT_EFFORT, check: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
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
log(`decide: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
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
const SLUG_MAX    = 50;
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, SLUG_MAX);

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const LENS_DIR    = `${STATE_DIR}/lenses`;
const lensFile    = (id) => `${LENS_DIR}/${id}.md`;
const RESEARCH_DIR = `${STATE_DIR}/research`;
const researchFile = (n, id) => `${RESEARCH_DIR}/r${n}-${id}.md`;
// The reviewer's prompt names only review/ files, so every file that holds a score or reasoning lives
// elsewhere: decide/ (the decisions and the reviewer's own final files), lenses/, research/ and locks/.
const DECIDE_DIR  = `${STATE_DIR}/decide`;
const REVIEW_DIR  = `${STATE_DIR}/review`;
const LOCK_DIR    = `${STATE_DIR}/locks`;
const decisionFile = (n) => `${DECIDE_DIR}/decision-r${n}.md`;
const ledgerFile   = (n) => `${REVIEW_DIR}/ledger-r${n}.md`;
const blindFile    = (r) => `${REVIEW_DIR}/review-r${r}.md`;
const finalFile    = (r) => `${DECIDE_DIR}/review-r${r}-final.md`;
// review-check.mjs finds these from the blind file's path: <its folder's parent>/locks/<its stem>.json|.lock
const specFile     = (r) => `${LOCK_DIR}/review-r${r}.json`;
const revealFile   = (r) => `${LOCK_DIR}/review-r${r}.reveal.md`;
const lockFile     = (r) => `${LOCK_DIR}/review-r${r}.lock`;
const NEEDS_USER  = `${STATE_DIR}/NEEDS-USER.md`;          // user-only escalations (may halt the run)

// Requirements: the FIXED rubric — non-negotiable constraints + weighted criteria — read verbatim
// (#2/#11) by the researchers, the decider, AND the reviewer. The single source of truth that makes the
// loop converge. It lives in a file (planPath).
if (typeof A.planPath !== 'string' || !A.planPath.trim()) {
  throw new Error('args.planPath is required: pass the ABSOLUTE path to the requirements FILE (the rubric both the decider and reviewer judge against). There is no inline `requirements` arg. A rubric written without plan mode goes to plans/<runId>/ under root first.');
}
const PLAN_PATH   = abs(A.planPath);
const REQ_REF     = `the requirements at ${PLAN_PATH} (read them verbatim: the fixed rubric)`;
if (typeof A.checkTool !== 'string' || !A.checkTool.trim()) {
  throw new Error(`Missing args.checkTool: pass the absolute path of tools/review-check.mjs, the command the reviewer runs to lock its blind review. Got ${JSON.stringify(A.checkTool)}.`);
}
const CHECK_TOOL  = abs(A.checkTool);

// Lenses — the evaluation perspectives. Each becomes ONE researcher → ONE file. Accept strings or {id, focus}.
const LENSES = (Array.isArray(A.lenses) ? A.lenses : []).map((l, i) => {
  if (typeof l === 'string') return { id: slug(l) || `lens-${i + 1}`, focus: l };
  const focus = l.focus || l.id || '';
  return { id: slug(l.id || focus) || `lens-${i + 1}`, focus };
}).filter((l) => l.focus);
if (LENSES.length < 2) {
  throw new Error('args.lenses requires >=2 evaluation perspectives (strings, or { id, focus }), e.g. ["efficiency","simplest","robustness","best-practice"] — one lens has no cross-lens trade-off to weigh; just decide directly. The main agent picks these with the user beforehand (#4).');
}
const dupes = [...new Set(LENSES.map((l) => l.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`lens ids collide after slugging (${dupes.join(', ')}): two researchers would write the same file — give each lens a distinct id.`);
}

// =============================================================================
// Schemas — DECISIONS ONLY (control plane). All reasoning/matrices live in files (#8).
// =============================================================================
const RELAYED_REQUEST = { type: 'boolean', description: 'true when your context holds a user request that the Workflow harness relayed ahead of this task, apart from the task text itself. false when it holds only this task. TRUE HALTS the run before any later agent.' };
const LENS_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'top_pick', 'relayed_request'],
  properties: {
    wrote_file:    { type: 'boolean', description: 'true if you wrote your lens file' },
    top_pick:      { type: 'string', description: 'short title of the option your lens favours' },
    relayed_request: RELAYED_REQUEST,
  },
};

const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'new_evidence'],
  properties: {
    wrote_file:   { type: 'boolean', description: 'true if you wrote your research file' },
    new_evidence: { type: 'boolean', description: 'true when your file holds a cited fact that no earlier file of the run holds' },
  },
};

const DECIDE_SCHEMA = {
  type: 'object',
  required: RANKED ? ['wrote_file', 'chosen', 'shortlist', 'meets_all_requirements', 'flip', 'open_issue_ids', 'user_checks', 'needs_user'] : ['wrote_file', 'chosen', 'meets_all_requirements', 'flip', 'open_issue_ids', 'user_checks', 'needs_user'],
  properties: {
    wrote_file:             { type: 'boolean', description: 'true only if you wrote both the decision file and the evidence ledger' },
    chosen:                 { type: 'string', description: RANKED ? 'short title of the RANK-1 option (the list itself is in the file)' : 'short title of the chosen conclusion (may be a hybrid)' },
    ...(RANKED ? {
      shortlist: {
        type: 'array',
        description: 'the ranked shortlist, best first — an INDEX only; the reasoning and matrix live in the decision file',
        items: {
          type: 'object',
          required: ['rank', 'title'],
          properties: {
            rank:  { type: 'integer', description: '1 = strongest' },
            title: { type: 'string' },
            combines_with: { type: 'array', items: { type: 'integer' }, description: 'ranks of the other listed options this genuinely composes with' },
            excludes:      { type: 'array', items: { type: 'integer' }, description: 'ranks of listed options that are MUTUALLY EXCLUSIVE with this one' },
          },
        },
      },
    } : {}),
    meets_all_requirements: { type: 'boolean', description: RANKED ? 'true if EVERY option on the shortlist satisfies every non-negotiable' : 'true if the conclusion satisfies every non-negotiable + criterion in the requirements (your own honest assessment)' },
    flip:                   { type: 'string', enum: ['robust', 'fragile', 'dominant'], description: 'your flip-check grade from the decision file: dominant = the winner gives up nothing against the runner-up, robust = the smallest flip is larger than the uncertainty of the input it moves, fragile = it is not' },
    open_issue_ids:         { type: 'array', items: { type: 'string' }, description: `one SHORT kebab-case slug of at most ${SLUG_MAX} characters per entry under \`## Open issues\` in the decision file. Reuse an issue's slug while it stays open. [] when the section says "None."` },
    user_checks:            { type: 'integer', description: 'count of entries under `## Checks for the user` in the decision file (0 if none)' },
    needs_user:             { type: 'boolean', description: 'true ONLY if a genuine choice/contradiction only the USER can resolve blocks you; you wrote a full entry to NEEDS-USER.md and cannot proceed' },
  },
};

// Neutral on purpose: the reviewer reads its schema before the check tool reveals the decision file, so no
// field may name a stage, a withdrawal or that file.
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'verdict', 'needs_user'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true if you wrote your review file' },
    verdict:    { type: 'string', enum: ['accept', 'reject'], description: 'the verdict your review ends on' },
    needs_user: { type: 'boolean', description: 'true ONLY if you found a requirement contradiction only the USER can resolve; you wrote it to NEEDS-USER.md' },
  },
};

const CHECK_SETUP_SCHEMA = {
  type: 'object',
  required: ['wrote_file'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true only if you wrote all five files' },
  },
};

const CHECK_VERIFY_SCHEMA = {
  type: 'object',
  required: ['exit_code', 'final_line', 'stage1_verdict'],
  properties: {
    exit_code:      { type: 'integer', description: 'the exit code the command returned' },
    final_line:     { type: 'string', description: 'the last line the command printed, verbatim' },
    stage1_verdict: { type: 'string', description: 'the word after "locked verdict:" when the command printed that line, else ""' },
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
const ENV = `THE DECISION + RUBRIC: ${REQ_REF}
${REPO ? `CODEBASE (read-only context — pattern-fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}${TESTBED ? `TESTBED — ground claims EMPIRICALLY where you can: ${TESTBED}\nPrefer MEASURED evidence over reasoning: run the check and cite the exact command + result in your file,
so the reviewer can re-run it. Treat the testbed as READ-ONLY unless it says otherwise. Leave no artifacts.
A measured difference smaller than the spread across repeated runs decides nothing: score it own judgment,
low-confidence, and state the spread.\n` : ''}NON-NEGOTIABLES (musts) are pass/fail: an option that fails one cannot win.
Judge each non-negotiable at the depth the requirements state. Where they state none, judge it on the
DEFAULT PATH: the default configuration and the paths the design runs with no operator action.
WEIGHTED CRITERIA (wants) are scored per option as MET, PARTLY MET or MISSED, each with its cited evidence.
The weighted total counts met as the criterion's full weight, partly met as half its weight and missed as
zero. A want scores met only on a cited source or a measurement, and own judgment scores at most partly met.
Prefer the SIMPLEST option that meets all requirements. If a more complex option wins, the matrix must
justify why the simpler one is inadequate.`;

// =============================================================================
// Role prompts
// =============================================================================
const CITE = 'Cite each factual claim to its original source: a file:line, a measurement (the exact command and its result), a source URL, or "own judgment" where you have none.';
const NO_AGENT_CHECK = "such as one that needs a testbed the run lacks, a source no agent can open or the user's own hardware";

const lensPrompt = (lens) => `
You are a RESEARCHER evaluating the decision THROUGH ONE LENS. Find the best answer your lens can offer.
Push that perspective hard and do NOT pre-compromise: the decider balances lenses later.
${ENV}
YOUR LENS: ${lens.focus}

PROCEDURE:
1. Generate 2–4 DISTINCT options that address the decision, including a simple baseline.
2. Gather evidence for each option with the tools you have: read the sources, search, and measure where
   you can.
3. Score each option FROM YOUR LENS under the scoring rule above: pass or fail on each non-negotiable,
   met, partly met or missed on each weighted criterion.
4. Recommend the one option your lens favours, say what it gives up against your runner-up, and name
   the ELEMENTS of it worth keeping even if another option wins (so the decider can build a hybrid).
WRITE ${lensFile(lens.id)} (create ${LENS_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} Per option, write a short block with title,
description, and its scores with the evidence behind each. For your pick, add the keep-worthy elements. Be
concrete and terse. ${CITE} The final reviewer sees only the original sources, never your file, and
re-checks the source behind each fact that moves the outcome. Do NOT modify any repo, stage, or commit.
Return via the schema.`;

// The engine routes on open_issue_ids alone, so each issue's question and files live in the decision file.
const OPEN_ISSUES = `OPEN ISSUES: an open issue is a question whose answer could change ${RANKED ? 'rank 1 or the order of an adjacent pair' : 'the winner'}: one the flip
check names, or a non-negotiable or criterion the evidence does not yet settle. Write each one under
\`## Open issues\` with a short kebab-case slug, the question, the requirement it bears on and the files a
researcher should read for it, and return the slugs in open_issue_ids. A research round launches at most
${MAX_RESEARCHERS} researchers, one per issue, so merge the issues that one researcher would settle from the same
sources or within the same domain into one issue that holds several questions. List the issues, and their
slugs in open_issue_ids, in order of how far each could move ${RANKED ? 'rank 1 or an adjacent pair' : 'the winner'}, the furthest first: a round
researches the first ${MAX_RESEARCHERS}, and the rest stay open for a later round. A question whose answer cannot
change ${RANKED ? 'rank 1 or an adjacent pair' : 'the winner'} is a caveat: note it in the file, never as an open issue. A question no agent can
settle, ${NO_AGENT_CHECK}, goes under \`## Checks for the user\` with
the check and the result that would change the answer, and never becomes an open issue again. When the
decision is about what to test, these checks are part of the deliverable. Return their count in
user_checks. An empty section says "None."`;

const list = (paths) => paths.map((p) => `  - ${p}`).join('\n');

// The reviewer scores from the ledger before it sees the decision, so the ledger reveals no score or reasoning.
const LEDGER = (n) => `EVIDENCE LEDGER: also WRITE ${ledgerFile(n)} (create ${REVIEW_DIR}/ if needed). ${REPLACE_NOTE}
A reviewer scores the candidates from this file alone before it sees your decision, so it holds facts,
never judgment, in three sections:
- \`## Answer under review\`: ${RANKED ? 'the listed options in rank order, then each combine and exclude claim' : 'the winner'}.
- \`## Candidates\`: every candidate your matrix scored${RANKED ? ', listed or left off the list' : ''}, one line each saying what it is.
- \`## Facts\`: for each candidate, every fact its scores rest on, each with its original source: a
  file:line, a measurement (the exact command and its result) or a source URL.
The ledger holds no score, weight, total, rationale or lens recommendation, and it cites no lens,
research or decision file: copy the original source such a file cites instead. A fact with no original
source stays out.`;

const decidePrompt = (pass, { review, researchRound, researchPaths, carried, olderResearch }) => `
You are the DECIDER. Converge the lensed analyses into ${RANKED
    ? `a RANKED SHORTLIST of the strongest options (up to ${SHORTLIST_N}) via a global weighted decision
matrix. You are NOT picking one winner: the user wants the best options in order, to choose among or
combine.`
    : `ONE justified conclusion via a global weighted decision matrix.`}
${ENV}
LENS ANALYSES — read each VERBATIM:
${LIVE.map((l) => `  - ${lensFile(l.id)}  (lens: ${l.focus})`).join('\n')}
${olderResearch.length ? `EARLIER RESEARCH FILES, which the decision you revise cites:
${list(olderResearch)}
` : ''}${pass === 1 ? '' : `REVISE your decision at ${decisionFile(pass - 1)} into a complete new file.
`}${!researchPaths.length ? '' : `RESEARCH ROUND ${researchRound} answered ${carried.length ? `the first ${MAX_RESEARCHERS} of ` : ''}your open issues. READ every research file of that round:
${list(researchPaths)}
Fold each finding by its cited source: rescore each cell it settles and close the open issue it answers.
A finding written as a check for the user moves its issue under \`## Checks for the user\`. Keep an issue
open only while its answer can still change ${RANKED ? 'rank 1 or an adjacent pair' : 'the winner'} and a researcher could still settle it.
${carried.length ? `No researcher took these issues, since a round researches at most ${MAX_RESEARCHERS}: ${carried.join(', ')}. Keep each one
open under that rule, since no research has answered it yet.
` : ''}`}${!review ? '' : `THE REVIEWER REJECTED the decision of review round ${review.round}. ${review.fallback
    ? `${review.fallback}, so act on every objection in the blind review ${review.blind}.`
    : `READ its final review ${review.final}, which sorts each objection of its blind review
${review.blind} into withdrawn, kept or downgraded to a caveat. Act on each KEPT objection.`}
- An objection is another agent's claim. Before you act on one, confirm its evidence against its
  source: open the file:line, URL or requirements text it cites, and re-run a measurement it cites
  where you can run it.
- A CHALLENGER, ${RANKED
    ? `an option the reviewer scores above a listed option it would displace or above the option ranked
  just above it: score the two side by side on the same rubric, every cell cited, and order them by that
  score.`
    : `an option the reviewer scores above the winner: score the winner and the challenger side by side on
  the same rubric, every cell cited, and keep the higher.`}
- A NON-NEGOTIABLE VIOLATION: ${RANKED
    ? 'repair the listed option so it passes, or take it off the list.'
    : 'repair the winner so it passes, or replace it with the best option that passes.'}
${RANKED ? `- A COMBINE OR EXCLUDE CLAIM the evidence contradicts: correct it to what the evidence supports.
` : ''}- An objection whose evidence you refute is rebutted under a \`## Rebuttals\` heading with evidence: a
  lens or research claim, a file:line, a measurement or the requirements text. A rebuttal without
  evidence is not one. An objection you can neither confirm nor refute, or one that names evidence no
  file of the run holds, becomes an open issue, so a research round settles it before the next review.
- You MAY fold a caveat or a downgraded objection whose fix is one sentence. Leave every other one
  alone: the review files carry it to the user.
- A repair patches the option it repairs. Never add a repaired variant as a new rival option. When a
  fold repairs one option against a defect another option shares, repair that option the same way and
  keep it scored in the matrix.
- Before you write a fold, test it against one hostile input of each kind it touches, such as a failure,
  a concurrent edit, a human-set value, state saved before the change (a legacy row, a migration, a
  value an older version stored), or an edit by another program that no scan has seen yet, so the fold
  does not open a new defect.
- Change nothing that an objection or a research finding does not name.
`}${pass === 1 ? '' : `Then redo the totals, ${RANKED ? 'the order' : 'the trade-off'} and the flip check.
`}
PROCEDURE:
1. Consolidate the options across all lens files and dedupe near-identical ones. You MAY build a hybrid
   of the best elements of several, but only where they genuinely compose (no Frankenstein).
2. Take the non-negotiables, the weighted CRITERIA and their weights from the requirements. Build a
   decision matrix: each candidate (incl. any hybrid) judged pass or fail on every non-negotiable and
   scored on every weighted criterion under the scoring rule above, with its weighted total. The highest
   defensible total wins.
   GROUND every cell: cite the evidence behind the score (the lens or research file and the specific
   claim, with the original source it cites). Where none exists (a legitimate cross-lens synthesis), mark
   it "own judgment, low-confidence". Never fabricate a citation. Each option you rule out, by a
   non-negotiable or as a runner-up, cites what rules it out and names the one observation that would
   reverse that.
${RANKED
    ? `3. RANK the strongest options by weighted total, best first, up to ${SHORTLIST_N}. An option that
   violates a non-negotiable is OFF the list, never ranked last. Do NOT pad: three real options beat
   ${SHORTLIST_N} with filler, and if one option truly dominates, say so at rank 1 rather than
   manufacturing rivals.
4. FLIP CHECK: for each adjacent pair on the list, the smallest change to one cell or one weight that
   swaps them. Grade the rank-1 position: DOMINANT when rank 1 is at least as good as rank 2 on every
   criterion, ROBUST when the smallest swap is larger than the uncertainty of the input it moves, FRAGILE
   when it is not.
WRITE ${decisionFile(pass)} (create ${DECIDE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} Write the matrix (table, all candidates scored),
then the RANKED SHORTLIST (one block per option: what it BUYS, what it COSTS, and why it sits above the one
below it), then a "Combine / exclude" section stating which listed options genuinely COMBINE and which are
MUTUALLY EXCLUSIVE (a shortlist the user cannot safely mix is a trap), then the flip check, then anything
you considered and left OFF the list with one line why, then an \`## Open issues\` section and a
\`## Checks for the user\` section. Do NOT modify any repo, stage, or commit.`
    : `3. State the WINNER, WHY it wins, and WHY NOT each runner-up (the disqualifying trade-offs). Confirm it
   satisfies every non-negotiable and criterion. Note any residual risk or follow-up.
4. TRADE-OFF: the winner against the runner-up as two columns, GAINS and GIVES UP, one row per criterion
   where they differ, written as weight x credit gap, where credit is 1 for met, 0.5 for partly met and 0
   for missed, so the columns net to the difference in totals. An
   empty GIVES UP column means the winner dominates: say so. A consideration the requirements have no
   criterion for goes below the table, unweighted and marked outside the rubric.
5. FLIP CHECK: the smallest single change to one cell or one weight that changes the winner (from, to),
   and the joint effect of moving every low-confidence cell by its uncertainty together. Grade the choice
   DOMINANT when the GIVES UP column is empty, ROBUST when the smallest flip is larger than the uncertainty
   of the input it moves, FRAGILE when it is not. For FRAGILE, name the input that decides it and the
   evidence or user call that would settle it: an open issue, or a check for the user.
WRITE ${decisionFile(pass)} (create ${DECIDE_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} Write the matrix (table), the chosen conclusion
with its rationale, the why-not-others, a \`## Trade-off\` section, a \`## Flip check\` section, an
\`## Open issues\` section and a \`## Checks for the user\` section. Do NOT modify any repo, stage, or commit.`}
${LEDGER(pass)}
${OPEN_ISSUES}
If a genuine contradiction in the requirements (or a choice only the user can make) blocks you, append a
full entry to ${NEEDS_USER} and set needs_user=true (the run HALTS).
Return via the schema.`;

const researchPrompt = (entry, file, decFile, earlierResearch) => `
You are a RESEARCHER settling ONE open issue of a decision. Find the evidence that answers it.
${ENV}
THE OPEN ISSUE: the entry "${entry}" under \`## Open issues\` in ${decFile}. Read that entry: it holds
the question, the requirement it bears on and the files to read for it. Read those files.

PROCEDURE:
1. Search with the tools you have for the evidence that answers the question: read the sources, search,
   and measure where you can.
2. State the answer with its evidence, or say the question stays open and what you searched. ${CITE}
3. When no agent can settle the question, ${NO_AGENT_CHECK}, write it as a
   CHECK FOR THE USER: the check to run and the result that would change the answer.
WRITE ${file} (create ${RESEARCH_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE}
Set new_evidence=true only when your file holds a cited fact that no earlier file of this run holds: the
lens files in ${LENS_DIR}/${earlierResearch.length ? `, ${decFile} and the research files ${earlierResearch.join(', ')}` : ` and ${decFile}`}.
Do NOT modify any repo, stage, or commit.
Return via the schema.`;

// The reviewer's prompt holds only the blind stage and the judgment rules. The check tool owns the file format,
// locks the blind review and prints the reveal, so nothing the reviewer reads before that lock names a
// decision file or a later stage.
const VERDICTS = REVIEW_SCHEMA.properties.verdict.enum;

const OBJECTIONS = RANKED
  ? `An objection is one of these four, and each cites the requirement it rests on:
   - a listed option that violates a non-negotiable;
   - an adjacent pair of listed options whose order your scores reverse, with both totals;
   - a candidate off the list that scores above a listed option, with both totals;
   - a combine or exclude claim the evidence contradicts.`
  : `An objection is one of two kinds, and each cites the requirement it rests on:
   - the winner violates a non-negotiable;
   - a challenger: a candidate that scores higher than the winner on the same rubric, with both totals.`;

const DEFAULT_PATH = `Normal use, an edit by another program or tool, and a failure such as an outage, a timeout or a
locked file are all on the default path. Operator action means only a deliberate configuration change or
command by the user that the requirements neither list as a scenario nor require the decision to provide.
A path they list or require, such as a human commit, a revert or a manual apply path, is on the default
path. A breach reachable only through operator action is a caveat.`;

const reviewPrompt = (round, ledger) => `
You are an INDEPENDENT REVIEWER. Judge ${RANKED ? 'the ranked answer' : 'the answer'} under review on the fixed rubric, from the evidence.
${ENV}
THE EVIDENCE LEDGER (read it verbatim): ${ledger}
It names the answer under review, every candidate and the facts behind each, with their original
sources. For each fact that moves a score, open its original source and confirm it says what the ledger
claims${TESTBED ? ', and re-run each testbed command it rests on' : ''}. A fact you cannot confirm counts for nothing.

PROCEDURE:
1. Score every candidate on every requirement: pass or fail on each non-negotiable, met, partly met or
   missed on each weighted criterion, each with its evidence, and each candidate's weighted total.
2. List your OBJECTIONS. ${OBJECTIONS}
   Every other concern is a caveat. No evidence, no objection.
3. Reject when you hold at least one objection, else accept.
${DEFAULT_PATH}
WRITE ${blindFile(round)} through its check command. The file may hold an earlier reviewer's text, so when it
holds any, Read it and write it with no content. Then run \`node '${CHECK_TOOL}' '${blindFile(round)}'\`, which
writes the file's skeleton and prints the format of each section. Read the skeleton and fill in every
section with the Write or Edit tool. ${WROTE_NOTE} ${FILE_WRITE_NOTE}
Do NOT modify any repo, stage, or commit. If a requirement contradiction only the user can resolve
surfaces, append it to ${NEEDS_USER} and set needs_user=true. Return via the schema once you are done.
When the review file is complete, run \`node '${CHECK_TOOL}' '${blindFile(round)}'\` again and follow what it prints.`;

// The check tool prints this once it locks the blind review. It reaches the reviewer only through that tool.
const revealText = (round, decFile, isFinal) => `Your blind review is locked. Now read the decision file ${decFile}, which holds the decider's
matrix and reasoning, and sort each objection of your review into one of three:
- withdrawn: only when a sourced fact in the decision file answers it. Quote that fact word for word in
  double quotes. The decider's opinion, weight or argument never withdraws an objection.
- kept: it still stands. Restate it in full with its evidence.
- downgraded: it is a caveat after all. Say why.
A reject keeps at least one objection: ${RANKED
    ? 'a listed option that violates a non-negotiable, a challenger with its scores, or a combine or exclude claim the evidence contradicts'
    : 'a non-negotiable the winner violates, or a challenger with its scores'}. An accept keeps none.${isFinal ? `
This is the run's LAST round: no decider round follows. If your final verdict is reject, add the
optional section the format below lists. Say whether the kept objections rest on evidence
another revision could answer, or on a requirement the rubric does not settle, such as how far a
non-negotiable reaches or a trade-off the decision lands on the other side of. For a requirement, name
the ONE requirement and the ONE change to it (a weight, a non-negotiable's depth, a missing criterion)
that would let a decision converge.` : ''}
Leave your blind review unchanged, since the check compares it with its lock. The check wrote the skeleton
of your final review, ${finalFile(round)}, and prints its format below. Read it and fill in every section
with the Write or Edit tool. ${FILE_WRITE_NOTE} Then run \`node '${CHECK_TOOL}' '${blindFile(round)}'\` again,
fix each error it prints, and return via the schema with your final verdict.`;

const checkSetupPrompt = (round, decFile, isFinal) => `
You are the CHECK AGENT of review round ${round}. Write five files exactly as given below, and change no other file.
1. WRITE ${specFile(round)} (create ${LOCK_DIR}/ if needed). ${REPLACE_NOTE} Its content is exactly this JSON:
${JSON.stringify({ stage2: finalFile(round), decision: decFile, reveal: revealFile(round) }, null, 2)}
2. WRITE ${revealFile(round)}. ${REPLACE_NOTE} Its content is exactly the text between the line BEGIN TEXT and
the line END TEXT below, without those two lines:
BEGIN TEXT
${revealText(round, decFile, isFinal)}
END TEXT
3. WRITE ${lockFile(round)} with the content {}, and ${blindFile(round)} (create ${REVIEW_DIR}/ if needed) and
${finalFile(round)} with no content, so no lock or review from an earlier launch stands in for this round's.
${REPLACE_NOTE}
${WROTE_NOTE} ${FILE_WRITE_NOTE} Do NOT modify any repo, stage, or commit.
Return via the schema.`;

const checkVerifyPrompt = (round) => `
You are the CHECK AGENT of review round ${round}. Run this command once, and read no file and change no file:
  node '${CHECK_TOOL}' --verify '${blindFile(round)}'
Return its exit code in exit_code and the last line it printed, verbatim, in final_line. When it printed a
line that starts "locked verdict:", return the word after it in stage1_verdict, else "".
Return via the schema.`;

// review-check.mjs --verify prints this line last on every exit it documents.
const COUNTS_RE = /^raised (\d+), withdrawn (\d+), kept (\d+), downgraded (\d+), caveats (\d+)$/;
const countsOf = (line) => {
  const m = String(line ?? '').trim().match(COUNTS_RE);
  return m ? { raised: Number(m[1]), withdrawn: Number(m[2]), kept: Number(m[3]), downgraded: Number(m[4]), caveats: Number(m[5]) } : null;
};

// =============================================================================
// DIVERGE — fan out one researcher per lens, concurrently (read-only, write own lens file).
// =============================================================================
phase('Diverge');
log(`decide: ${LENSES.length} lens(es) → ${LENS_DIR} [selection=${SELECTION}${RANKED ? ` (top ${SHORTLIST_N})` : ''}, maxRounds=${MAX_ROUNDS}, maxResearchRounds=${MAX_RESEARCH_ROUNDS}, maxResearchers=${MAX_RESEARCHERS}]`);
const lensResearch = await parallel(LENSES.map((lens) => () =>
  callAgent(lensPrompt(lens), roleOpts('research', {
    schema: LENS_SCHEMA, phase: 'Diverge', label: `research:${lens.id}`,
  })).then((r) => ({ lens: lens.id, ok: r?.wrote_file === true, top: r?.top_pick || '', relayed: r?.relayed_request === true }))
));
// A run launched inside a user turn relays that message to every agent, so the first researchers stop it before any decider.
const relayedLensIds = lensResearch.filter((a) => a?.relayed).map((a) => a.lens);
if (relayedLensIds.length) {
  throw new Error(`A user request was relayed into the context of the researcher for ${relayedLensIds.join(', ')} ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts.`);
}
const ready = lensResearch.filter(Boolean).filter((a) => a.ok);
for (const a of ready) log(`  ✓ ${a.lens}: favours "${a.top}"`);
if (!ready.length) throw new Error('No lens researcher produced a lens file — cannot converge. Check the requirements/lenses and re-run.');
// Converge only over lenses whose file exists; a dropped lens is logged, never silently assumed.
const LIVE = LENSES.filter((l) => ready.some((a) => a.lens === l.id));
const failedLensIds = LENSES.filter((l) => !LIVE.includes(l)).map((l) => l.id);
for (const id of failedLensIds) log(`  ✗ ${id}: no lens file (researcher failed/skipped) — dropped from convergence`);

// =============================================================================
// CONVERGE — decider ⇄ researchers until the open issues are covered or research stops, then decider ⇄
// staged reviewer, until the reviewer accepts or the round budget is spent.
// =============================================================================
let round = 0, agreed = false, haltReason = '';
let pass = 0;                   // decider passes, run-wide: each one writes decisionFile(pass)
let researchRound = 0;          // research rounds, run-wide, bounded by MAX_RESEARCH_ROUNDS
let researchStop = '';          // why research last handed the decision to review: '' | covered | saturated | cap
let researchPaths = [];         // the latest research round's files the next decider pass must fold
let carriedIssues = [];         // the latest research round's open issues past MAX_RESEARCHERS, which no researcher took
const researchFiles = [];       // every attested research file of the run, in round order
let lastOpenIssues = [];        // the latest attested decision's open issue slugs
let lastUserChecks = 0;         // the latest attested decision's count of checks for the user
const RESEARCH_STOPS = {
  covered: 'the decider named no open issue',
  saturated: 'two research rounds in a row found no new evidence',
  cap: `maxResearchRounds (${MAX_RESEARCH_ROUNDS}) spent`,
};
let haltKind = '';              // '' (not halted) | 'needs-user' | 'write-unattested' | 'review-incomplete'
let review = null;              // the latest rejecting review the decider must act on: { round, blind, final, fallback }, fallback naming why the blind review stands, or ''
let lastReviewFiles = [];       // the latest round's review files: the blind file, plus the final file when its lock matched and it was written
const reviewRounds = [];        // [{ round, verdict, raised, withdrawn, kept, downgraded, caveats, lockMatched }] — counts only (#8)
let contradicted = false;       // the latest reviewer returned a verdict its own check counts overturn
let lastDecisionFile = '';      // latest decision whose writer attested it: a same-runId re-run can leave stale ones
let lastLedgerFile = '';        // the evidence ledger the same decider pass attested with it
let lastChosen = '';
let lastShortlist = [];         // ranked mode: the ordered index the decider returned (reasoning is in the file)
let lastMeetsAll = false;       // the decider's own rubric attestation for the latest decision file
let lastFlip = '';              // the decider's flip-check grade for the latest decision file, '' when off the enum
// Slugs are control plane, so they are filtered like one: non-strings and blanks are dropped.
const slugs = (ids) => (Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id);

converge: while (round < MAX_ROUNDS) {
  round++;
  // A review round asks new questions, so the saturation streak restarts with it. The cap is run-wide.
  let dryRounds = 0;
  researchStop = '';

  for (;;) {
    // ---- DECIDE ------------------------------------------------------------
    pass++;
    phase('Decide');
    const dec = await callAgent(decidePrompt(pass, {
      review, researchRound, researchPaths, carried: carriedIssues,
      olderResearch: researchFiles.filter((f) => !researchPaths.includes(f)),
    }), roleOpts('decide', { schema: DECIDE_SCHEMA, phase: 'Decide', label: `decide r${pass}` }));
    if (!dec) throw new Error(`Decider returned nothing in round ${round} (agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
    researchPaths = [];
    carriedIssues = [];
    // The reviewer and the return would name these paths, and a same-runId re-run can leave stale files there.
    if (dec.wrote_file !== true && dec.needs_user !== true) {
      haltKind = 'write-unattested'; haltReason = `The decider did not confirm writing ${decisionFile(pass)} and ${ledgerFile(pass)} in round ${round}.`;
      log(`  ✋ r${round}: decider did NOT confirm writing ${decisionFile(pass)} and ${ledgerFile(pass)} → halting before the researchers and reviewers`);
      break converge;
    }
    // Per pass, no carry-over: an empty shortlist is a valid ranked return and must not pair an older
    // pass's options with this pass's decision file. Set together, so they describe the file named.
    if (dec.wrote_file === true) {
      lastDecisionFile = decisionFile(pass);
      lastLedgerFile = ledgerFile(pass);
      lastChosen = typeof dec.chosen === 'string' ? dec.chosen : '';
      if (RANKED) {
        lastShortlist = Array.isArray(dec.shortlist) ? [...dec.shortlist].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) : [];
      }
      lastMeetsAll = dec.meets_all_requirements === true;
      lastFlip = DECIDE_SCHEMA.properties.flip.enum.includes(dec.flip) ? dec.flip : '';
      // A slug names a research file, so it is deduped on its path-safe form. The entry keeps the
      // decider's spelling, since the researcher looks it up in the decision file.
      const byPath = new Map();
      for (const entry of slugs(dec.open_issue_ids)) {
        const id = slug(entry);
        const kept = byPath.get(id);
        if (!id) log(`  ⚠ r${round}: open issue "${entry}" has no letter or digit for a research file name → not researched`);
        else if (kept === undefined) byPath.set(id, entry);
        else if (kept !== entry) log(`  ⚠ r${round}: open issue "${entry}" shares research id ${id} with "${kept}" → researched as "${kept}" only`);
      }
      lastOpenIssues = [...byPath.values()];
      lastUserChecks = Number.isInteger(dec.user_checks) && dec.user_checks > 0 ? dec.user_checks : 0;
    }
    if (dec.needs_user === true) {
      haltKind = 'needs-user'; haltReason = `Decider escalated a user-only call in round ${round} (see ${NEEDS_USER}).`;
      log(`  ✋ r${round}: decider escalated → halting (see ${NEEDS_USER})`);
      break converge;
    }
    const tally = `meets_all=${dec.meets_all_requirements}, flip=${lastFlip || '?'}, open=${lastOpenIssues.length}, checks=${lastUserChecks}`;
    log(RANKED
      ? `  r${round}: decision ${pass} shortlisted ${lastShortlist.length} option(s), rank 1 = "${dec.chosen || '?'}" (${tally})`
      : `  r${round}: decision ${pass} chose "${dec.chosen || '?'}" (${tally})`);

    // ---- RESEARCH GATE -----------------------------------------------------
    researchStop = !lastOpenIssues.length ? 'covered'
      : dryRounds >= 2 ? 'saturated'
      : researchRound >= MAX_RESEARCH_ROUNDS ? 'cap'
      : '';
    if (researchStop) {
      log(`  → r${round}: research ${researchStop} (${RESEARCH_STOPS[researchStop]})${lastOpenIssues.length ? `, ${lastOpenIssues.length} open issue(s) on record: ${lastOpenIssues.join(', ')}` : ''} → review`);
      break;
    }

    // ---- RESEARCH ------------------------------------------------------------
    researchRound++;
    phase('Research');
    const earlier = [...researchFiles];
    // The decider lists the issues by how far each could move the answer, so the cap keeps the first ones.
    const issues = lastOpenIssues.slice(0, MAX_RESEARCHERS).map((entry) => {
      const id = slug(entry);
      return { entry, file: researchFile(researchRound, id), label: `research-issue r${researchRound} ${id}` };
    });
    const carried = lastOpenIssues.slice(MAX_RESEARCHERS);
    if (carried.length) log(`  ⚠ research r${researchRound}: ${lastOpenIssues.length} open issues, over maxResearchers (${MAX_RESEARCHERS}) → researching the first ${MAX_RESEARCHERS}, carried: ${carried.join(', ')}`);
    const found = await parallel(issues.map((u) => () =>
      callAgent(researchPrompt(u.entry, u.file, lastDecisionFile, earlier), roleOpts('research', {
        schema: RESEARCH_SCHEMA, phase: 'Research', label: u.label,
      }))));
    const deadResearch = issues.filter((u, i) => !found[i]);
    if (deadResearch.length) throw new Error(`Researcher returned nothing in research round ${researchRound} (${deadResearch.map((u) => u.label).join(', ')}: agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
    // The next decider and the reviewers would name these paths, so an unconfirmed one halts like a review.
    const unwritten = issues.filter((u, i) => found[i].wrote_file !== true).map((u) => u.file);
    if (unwritten.length) {
      haltKind = 'write-unattested'; haltReason = `A researcher did not confirm writing ${unwritten.join(', ')} in research round ${researchRound}.`;
      log(`  ✋ research r${researchRound}: researcher did NOT confirm writing ${unwritten.join(', ')} → halting before the decider reads it`);
      break converge;
    }
    researchPaths = issues.map((u) => u.file);
    carriedIssues = carried;
    researchFiles.push(...researchPaths);
    const fresh = found.filter((r) => r.new_evidence === true).length;
    dryRounds = fresh ? 0 : dryRounds + 1;
    log(`  ↻ research r${researchRound}: ${issues.length} issue(s), ${fresh} with new evidence → decider revises`);
  }

  // ---- REVIEW (staged: blind on the ledger, then the decision) --------------
  phase('Review');
  const blind = blindFile(round);
  const setup = await callAgent(checkSetupPrompt(round, lastDecisionFile, round === MAX_ROUNDS), roleOpts('check', {
    schema: CHECK_SETUP_SCHEMA, phase: 'Review', label: `check-setup r${round}`,
  }));
  if (!setup) throw new Error(`Check agent returned nothing before the review in round ${round} (check-setup r${round}: agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  // review-check.mjs reads these files, and a same-runId re-run can leave an earlier round's spec there.
  if (setup.wrote_file !== true) {
    haltKind = 'write-unattested'; haltReason = `The check agent did not confirm writing ${specFile(round)}, ${revealFile(round)}, ${lockFile(round)}, ${blind} and ${finalFile(round)} in round ${round}.`;
    log(`  ✋ r${round}: check agent did NOT confirm writing the check spec → halting before the reviewer`);
    break;
  }
  // A missing lock means the reviewer never ran the check, so it never saw the decision: one rerun, then a halt.
  let rev = null;
  let check = null;
  for (const tag of ['', ' rerun']) {
    rev = await callAgent(reviewPrompt(round, lastLedgerFile), roleOpts('review', {
      schema: REVIEW_SCHEMA, phase: 'Review', label: `review r${round}${tag}`,
    }));
    if (!rev) throw new Error(`Reviewer returned nothing in round ${round} (review r${round}${tag}: agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
    if (rev.needs_user === true || rev.wrote_file !== true) break;
    check = await callAgent(checkVerifyPrompt(round), roleOpts('check', {
      schema: CHECK_VERIFY_SCHEMA, phase: 'Review', label: `check r${round}${tag}`,
    }));
    if (!check) throw new Error(`Check agent returned nothing after the review in round ${round} (check r${round}${tag}: agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
    if (check.exit_code !== 2) break;
    log(`  ⚠ r${round}: no lock on ${blind}: the reviewer never ran the check${tag ? '' : ' → rerunning the reviewer once'}`);
  }
  if (rev.needs_user === true) {
    haltKind = 'needs-user'; haltReason = `The reviewer surfaced a requirement contradiction only the user can resolve in round ${round} (see ${NEEDS_USER}).`;
    log(`  ✋ r${round}: reviewer escalated → halting (see ${NEEDS_USER})`);
    break;
  }
  // The next decider and the return would name this path, so its verdict must not be read either.
  if (rev.wrote_file !== true) {
    haltKind = 'write-unattested'; haltReason = `The reviewer did not confirm writing ${blind} in round ${round}.`;
    log(`  ✋ r${round}: reviewer did NOT confirm writing ${blind} → halting before its verdict is read`);
    break;
  }
  if (check.exit_code === 2) {
    haltKind = 'review-incomplete'; haltReason = `The reviewer never ran the check on ${blind} in round ${round}, and its rerun did not either.`;
    log(`  ✋ r${round}: the reviewer and its rerun never ran the check → halting`);
    break;
  }

  // A matching lock: the kept count decides, so a withdrawal the check could not confirm stays an objection.
  // A mismatch: the blind review changed after its lock, so only its locked verdict is the reviewer's own.
  // A matching lock with a locked verdict: the final review is unwritten, so the blind review is the one to read.
  const counts = countsOf(check.final_line);
  const lockMatched = check.exit_code === 0;
  const lockedVerdict = String(check.stage1_verdict ?? '').trim().toLowerCase();
  const finalWritten = lockMatched && lockedVerdict === '';
  if (!counts || !(finalWritten || ((lockMatched || check.exit_code === 3) && VERDICTS.includes(lockedVerdict)))) {
    throw new Error(`Check agent returned an unreadable result in round ${round} (exit_code ${JSON.stringify(check.exit_code)}, final_line ${JSON.stringify(check.final_line)}, stage1_verdict ${JSON.stringify(check.stage1_verdict)}): review-check.mjs --verify exits 0, 2 or 3, prints its counts line last, and prints the locked verdict on 3 and on 0 with no final review. Relaunch with the same args and no resumeFromRunId, since a resume replays this cached return.`);
  }
  // With no final review every objection counts as kept, so the counts give the locked blind verdict.
  const verdict = lockMatched ? (counts.kept > 0 ? 'reject' : 'accept') : lockedVerdict;
  const tally = `raised ${counts.raised}, withdrawn ${counts.withdrawn}, kept ${counts.kept}, downgraded ${counts.downgraded}, caveats ${counts.caveats}`;
  reviewRounds.push({ round, verdict, ...counts, lockMatched });
  lastReviewFiles = finalWritten ? [blind, finalFile(round)] : [blind];
  const verdictFile = lastReviewFiles[lastReviewFiles.length - 1];
  // Flagged, not halted: the counts already decide the verdict, so the contradiction cannot compound.
  contradicted = lockMatched && rev.verdict !== verdict;
  if (!lockMatched) log(`  ⚠ r${round}: ${blind} does not match its lock → the locked blind verdict "${verdict}" stands`);
  if (lockMatched && !finalWritten) log(`  ⚠ r${round}: the reviewer wrote no final review ${finalFile(round)} → its locked blind verdict "${verdict}" stands`);
  if (contradicted) log(`  ⚠ r${round}: the reviewer returned "${rev.verdict}" but its check counts give "${verdict}" → the counts decide; audit ${verdictFile}`);

  if (verdict === 'accept') {
    agreed = true;
    if (!lastMeetsAll) log(`  ⚠ r${round}: the reviewer ACCEPTS but the decider reported meets_all_requirements=false — audit ${lastDecisionFile}`);
    log(`  ✓ r${round}: the reviewer ACCEPTS (${tally})`);
    break;
  }
  review = { round, blind, final: finalFile(round), fallback: !lockMatched ? 'Its blind review changed after its lock' : !finalWritten ? 'It wrote no final review' : '' };
  if (round >= MAX_ROUNDS) { log(`  ⚠ r${round}: the reviewer REJECTS (${tally}) at the round budget (see ${lastReviewFiles.join(', ')})`); break; }
  log(`  ↻ r${round}: the reviewer REJECTS (${tally}) → decider revises`);
}

const halted = haltKind !== '';
const HALT_STATUS = {
  'write-unattested': 'BLOCKED (an agent did not confirm writing its file)',
  'needs-user': 'BLOCKED (needs user input)',
  'review-incomplete': 'BLOCKED (the reviewer did not complete its review)',
};
const lastReview = reviewRounds.length ? reviewRounds[reviewRounds.length - 1] : null;
// review-check.mjs counts the caveats of the final review once it is written, else of the blind review.
const caveatCount = lastReview ? lastReview.caveats : 0;
const status = halted ? HALT_STATUS[haltKind]
  : agreed && caveatCount > 0 ? `decided with caveats (the final reviewer accepts the decision and names ${caveatCount} caveat${caveatCount === 1 ? '' : 's'})`
  : agreed ? 'decided (the final reviewer accepts the decision)'
  : 'needs-attention (no agreement within round budget)';
log(`decide: ${status} after ${round} round(s)`);

const agreeCaveats = [
  agreed && contradicted ? `The reviewer returned reject while its review keeps no objection: audit ${lastReviewFiles[lastReviewFiles.length - 1]} before presenting. ` : '',
  agreed && lastReview && !lastReview.lockMatched ? `The reviewer's blind review ${blindFile(round)} changed after its lock, so its locked verdict stands: audit it before presenting. ` : '',
  agreed && !lastMeetsAll ? `The decider itself reported that ${RANKED ? 'a shortlisted option' : 'the conclusion'} does not meet every requirement: check ${lastDecisionFile} before presenting. ` : '',
].join('');
const FLIP_NOTES = RANKED
  ? {
    fragile: 'The decider graded rank 1 FRAGILE. Present its flip check, since rank 1 turns on the input it names, and let the user settle it. ',
    dominant: 'Rank 1 is at least as good as rank 2 on every criterion. ',
  }
  : {
    fragile: 'The decider graded the choice FRAGILE. Present its Flip check and Trade-off sections, since the winner turns on the input the Flip check names, and let the user settle it. ',
    dominant: 'The winner dominates the runner-up: the Trade-off section shows nothing given up. ',
  };
const flipNote = FLIP_NOTES[lastFlip] ?? '';
// Research ran out before the evidence settled these, so they travel with the decision instead of blocking it.
const researchNote = (researchStop === 'saturated' || researchStop === 'cap') && lastOpenIssues.length
  ? `Research stopped on ${researchStop} (${RESEARCH_STOPS[researchStop]}) with ${lastOpenIssues.length} open issue(s) on record (${lastOpenIssues.join(', ')}). Present the \`## Open issues\` section of ${lastDecisionFile} with the decision, since each could still change ${RANKED ? 'rank 1 or an adjacent pair' : 'the winner'}. `
  : '';
// More open issues than one research round takes is a sign the decision holds more questions than one run settles.
// An unhalted run with open issues stopped research on saturated or cap, so researchNote lists them all first.
const carriedNote = lastOpenIssues.length > MAX_RESEARCHERS
  ? `The latest decision lists ${lastOpenIssues.length} open issues, more than the ${MAX_RESEARCHERS} one research round takes (maxResearchers). The issues past that cap are the ones after the first ${MAX_RESEARCHERS} in that list. The decision may need splitting into narrower decide runs. `
  : '';
const checksNote = lastUserChecks
  ? `Present the ${lastUserChecks} check(s) under \`## Checks for the user\` in ${lastDecisionFile}: each names the result that would change the answer. `
  : '';
const caveatNote = caveatCount > 0 && lastReviewFiles.length
  ? `Carry the ${caveatCount} caveat(s) under "## Caveats" in ${lastReviewFiles[lastReviewFiles.length - 1]} into the plan's design section. The reviewer judged that none changes the choice, but each is a gap the plan must close, so refine the plan before building. `
  : '';
// A lock mismatch or an unwritten final review leaves only the blind review, which has no WHERE NEXT section.
const budgetStart = lastReviewFiles.length > 1
  ? 'starting with the kept objections and the WHERE NEXT section of the final review, which says whether another revision could answer them or names the one requirement change that would let a decision converge'
  : 'starting with the objections of the blind review, since the last round left no final review the run could use and so no WHERE NEXT section';
// A halt's relaunch already redoes every lens and leaves no decision to relay, so it gets the short form.
const droppedLenses = !failedLensIds.length
  ? ''
  : ` These lenses did not confirm a lens file and were left out of the decision: ${failedLensIds.join(', ')}.` + (halted
    ? ' The relaunch with the same args redoes them.'
    : ' The engine cannot re-run single lenses. Bringing them in takes a full relaunch with the full lens list and no resumeFromRunId, which redoes every lens and round. Relay this run\'s decision first, then relaunch under a new runId so this run\'s files stay intact.');
const relaunchFromStart = 'The relaunch re-runs the run from the lens analyses and round 1 and overwrites the round files.';

return {
  runId: RUN_ID,
  status,
  agreed,
  halted,
  selection: SELECTION,
  chosen: lastChosen,
  ...(RANKED ? { shortlist: lastShortlist } : {}),
  flip: lastFlip,
  rounds: round,
  research: { rounds: researchRound, stop: researchStop },
  openIssues: lastOpenIssues,
  userChecks: lastUserChecks,
  reviewRounds,
  caveats: caveatCount,
  stateDir: STATE_DIR,
  haltReason: halted ? haltReason : '',
  decisionFile: lastDecisionFile,
  reviewFiles: lastReviewFiles,
  needsUserFile: haltKind === 'needs-user' ? NEEDS_USER : '',
  lensFiles: LIVE.map((l) => lensFile(l.id)),
  failed: failedLensIds.map((id) => ({ id, stage: 'diverge' })),
  lensPicks: LIVE.map((l) => ({ lens: l.id, focus: l.focus, top: ready.find((a) => a.lens === l.id)?.top || '' })),
  contradicted,
  meetsAllRequirements: lastMeetsAll,
  reviewTrail: `Lens analyses in ${LENS_DIR}/, research files in ${RESEARCH_DIR}/, decisions and final reviews in ${DECIDE_DIR}/, and evidence ledgers and blind reviews in ${REVIEW_DIR}/ show every round.`,
  nextStep: (halted
    ? (haltKind === 'needs-user'
      ? `Run halted — ${haltReason} Read ${NEEDS_USER}, resolve it with the user, then relaunch with the same args and no resumeFromRunId. ${relaunchFromStart}`
      : haltKind === 'review-incomplete'
      ? `Run halted — ${haltReason} Check that this project's settings allow Bash(node '${CHECK_TOOL}':*), so the reviewer can run the check unattended, then relaunch with the same args and no resumeFromRunId: a resume replays the cached returns and halts the same way. ${relaunchFromStart}`
      : `Run halted — ${haltReason} Check that file, then relaunch with the same args and no resumeFromRunId: a resume replays the cached return and halts the same way. ${relaunchFromStart}`)
    : (agreed
      ? agreeCaveats + flipNote + researchNote + carriedNote + checksNote + caveatNote + (RANKED
        ? `Present the SHORTLIST the final reviewer accepted in round ${round}: relay ${lastDecisionFile} (the matrix + the ranked options with what each buys/costs + the combine-vs-exclusive section + the flip check) and let the user read each lens file in ${LENS_DIR}/ to see the source perspectives. There is deliberately NO single winner — the user picks, or combines the options marked as composable. To build what they pick, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle (several picks become several blocks of one plan file).`
        : `Present the conclusion the final reviewer accepted in round ${round}: relay ${lastDecisionFile} (the matrix + rationale + why-not-others + trade-off + flip check) and let the user read each lens file in ${LENS_DIR}/ to see the source perspectives. To build the chosen approach, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.`)
      : `No agreement within ${MAX_ROUNDS} rounds. ${researchNote}${carriedNote}${checksNote}Read the latest ${lastDecisionFile} + ${lastReviewFiles.join(', ')} with the user, ${budgetStart}. Refine the requirements, then relaunch with the same args and no resumeFromRunId: the relaunch re-runs the run from the lens analyses and round 1 and overwrites the round files, while a resume would replay the cached returns and never read the edit. Or raise maxRounds and relaunch with the same args plus the Workflow tool's resumeFromRunId: the finished rounds replay from cache and the loop continues past round ${round}.`)) + droppedLenses,
};
