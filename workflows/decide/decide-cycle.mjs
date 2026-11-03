export const meta = {
  name: 'decide-cycle',
  description: 'Convergent decision, lean/file-bus design, as a bounded chain with no loop back. An OPENING INVESTIGATOR searches for every option worth weighing and writes investigations/i1.md. Then up to maxInvestigators - 1 CHALLENGERS run one at a time: each reads the rubric and every earlier investigation file, tries to replace the leading option by rejecting one assumption it rests on, tries to improve any option, and writes its own file of contributions. The chain stops at the first challenger that shows it can add nothing, or at maxInvestigators. ONE DECIDER then scores every option, every combination it builds and the do-nothing option in one weighted matrix and writes decision.md, a ranked list. ONE FINAL REVIEWER verifies decision.md against the sources, reruns the saved scripts, recomputes the totals, corrects each error it can prove in place and writes review.md with its edits and its flags. The run starts at most maxInvestigators + 2 agents. The harness only routes paths + counts; rich content lives in files.',
  whenToUse: 'Have the AI reach a JUSTIFIED, RANKED answer among approaches, weighing real trade-offs. Rank 1 is the top answer, and the user may combine the entries marked as combinable. The main agent authors the REQUIREMENTS (non-negotiable constraints + weighted criteria, the rubric every agent judges against) in PLAN MODE and approves them with the user, then runs this engine. To explore open-ended creative variations for a HUMAN to pick (no AI verdict) use brainstorm-cycle; to find an answer that already exists against pass/fail criteria use investigate-cycle; to BUILD a pick, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle.',
  phases: [
    { title: 'Investigate', detail: 'A serial chain of at most maxInvestigators agents. The opening investigator reads the requirements (verbatim), searches the web, and the codebase when target.repo is passed, for every option worth weighing and writes investigations/i1.md: the options with their pros and cons, the assumptions the leader rests on, the standing and the directions searched. Each challenger k reads the requirements and every earlier investigation file in order, tries to replace the leader and to improve any option, and writes investigations/i<k>.md with its contributions. The chain stops at the first challenger that returns contributed false (dry) or after maxInvestigators agents (cap).' },
    { title: 'Decide', detail: 'One decider reads the requirements and every investigation file, scores every option, every combination it builds and the do-nothing option in one weighted matrix, every cell citing its source or marked own judgment, and writes decision.md: the ranking, the options, the matrix, the flip check, the options ruled out, the investigation facts its own research changed and the checks for the user. Returns the ranking index, the flip grade and the count of checks for the user.' },
    { title: 'Review', detail: 'One final reviewer reads the requirements, every investigation file and decision.md, opens the source behind every cell of the three top-ranked options, every must judgment and every ruled-out entry, reruns each saved script and testbed command they rest on, and recomputes every total. It corrects in decision.md each error a source, a rerun or the arithmetic proves, redoes the flip check when an edit moves rank 1 or rank 2, and writes review.md with its edits and its flags. Returns the counts, the ranking index and the flip grade after its edits.' },
  ],
};

// =============================================================================
// Config — everything decision-specific arrives via args so the engine stays general.
// Decide is a CONVERGENCE workflow: it produces a ranked conclusion, not code, so nothing is staged or
// committed. No stage loops back. A decision has no clean convergence point, so maxInvestigators bounds
// the run instead of agreement, and the most agents it starts is known at launch. The main agent authors the
// requirements with the user BEFOREHAND (#4), so the engine spawns no setup agent.
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
  throw new Error('args must include at least { runId, root, planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

// Retired args throw, never ignored: an old payload would otherwise run a chain its operator never chose.
const RETIRED_ARGS = {
  lenses: 'the investigator chain finds the options, so no lens list is passed',
  checkTool: 'the final reviewer verifies decision.md directly, so no check tool runs',
  selection: 'every run returns a ranked list, and rank 1 is the top answer',
  shortlist: 'the decider ranks every option that passes every must',
  maxRounds: 'no stage loops back, so maxInvestigators bounds the run',
  maxResearchRounds: 'each investigator researches as it goes, so maxInvestigators bounds the research',
  maxResearchers: 'the investigators run one at a time, so maxInvestigators bounds them',
};
for (const [name, replacement] of Object.entries(RETIRED_ARGS)) {
  if (A[name] !== undefined) {
    throw new Error(`Retired arg: args.${name} is retired, since ${replacement}. Drop it and relaunch. Got ${name} ${JSON.stringify(A[name])}.`);
  }
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL read-only context
const CONTEXT     = A.context ?? '';                       // short extra framing (domain facts the agents won't know)
const TESTBED     = A.testbed ?? '';                       // OPTIONAL: how agents may empirically test claims (e.g. a read-only sqlite db + how to query it)
// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0.
// The upper bound stops a fat-fingered maxInvestigators from spawning agents until something dies.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round run and reports it as an ordinary result.`);
  }
  return Math.floor(v);
};
const MAX_INVESTIGATORS = num(A.maxInvestigators, 'maxInvestigators', 1, 4, 10);

// Per-role model tiers + OPTIONAL custom subagent types. Every role reads and judges the rubric, so every role is opus.
const ROLE_KEYS = ['investigate', 'decide', 'review'];
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
const M  = { investigate: 'opus', decide: 'opus', review: 'opus', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { investigate: DEFAULT_EFFORT, decide: DEFAULT_EFFORT, review: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
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
const MAX_AGENTS = MAX_INVESTIGATORS + 2;
log(`decide: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}, at most ${MAX_AGENTS} agents (${MAX_INVESTIGATORS} investigator(s), the decider and the reviewer)`);

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

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const INV_DIR     = `${STATE_DIR}/investigations`;
const invFile     = (k) => `${INV_DIR}/i${k}.md`;
const SCRIPTS_DIR = `${STATE_DIR}/scripts`;
const DECISION_FILE = `${STATE_DIR}/decision.md`;
const REVIEW_FILE = `${STATE_DIR}/review.md`;

// Requirements: the FIXED rubric of non-negotiable constraints and weighted criteria, read verbatim
// (#2/#11) by every agent. It lives in a file (planPath).
if (typeof A.planPath !== 'string' || !A.planPath.trim()) {
  throw new Error('args.planPath is required: pass the ABSOLUTE path to the requirements FILE (the rubric every agent judges against). There is no inline `requirements` arg. A rubric written without plan mode goes to plans/<runId>/ under root first.');
}
const PLAN_PATH   = abs(A.planPath);
const REQ_REF     = `the requirements at ${PLAN_PATH} (read them verbatim: the fixed rubric)`;

// =============================================================================
// Schemas — DECISIONS ONLY (control plane). All reasoning/matrices live in files (#8).
// =============================================================================
const RELAYED_REQUEST = { type: 'boolean', description: 'true when your context holds a user request that the Workflow harness relayed ahead of this task, apart from the task text itself. false when it holds only this task. TRUE HALTS the run before any later agent.' };
const RANKING = {
  type: 'array',
  description: 'the ranking, best first, as an INDEX only: the reasoning and the matrix live in the decision file',
  items: {
    type: 'object',
    required: ['rank', 'title'],
    properties: {
      rank:          { type: 'integer', description: '1 = the top answer' },
      title:         { type: 'string' },
      combines_with: { type: 'array', items: { type: 'integer' }, description: 'ranks of the other ranked options this one genuinely composes with' },
      excludes:      { type: 'array', items: { type: 'integer' }, description: 'ranks of the ranked options that are MUTUALLY EXCLUSIVE with this one' },
    },
  },
};
const FLIP_GRADES = ['dominant', 'robust', 'fragile'];

const OPEN_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'relayed_request'],
  properties: {
    wrote_file:      { type: 'boolean', description: 'true if you wrote your investigation file' },
    relayed_request: RELAYED_REQUEST,
  },
};

const CHALLENGE_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'contributed'],
  properties: {
    wrote_file:  { type: 'boolean', description: 'true if you wrote your investigation file' },
    contributed: { type: 'boolean', description: 'false only when your `## Contributions` section reads "None." and your `## Searched` section holds the attempts the prompt names. false ends the chain.' },
  },
};

const DECIDE_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'ranking', 'flip', 'user_checks'],
  properties: {
    wrote_file:  { type: 'boolean', description: 'true if you wrote the decision file' },
    ranking:     RANKING,
    flip:        { type: 'string', enum: FLIP_GRADES, description: 'your flip-check grade from the decision file: dominant = rank 1 is at least as good as rank 2 on every criterion, robust = the smallest swap is larger than the uncertainty of the input it moves, fragile = it is not' },
    user_checks: { type: 'integer', description: 'count of entries under `## Checks for the user` in the decision file (0 if none)' },
  },
};

const REVIEW_SCHEMA = {
  type: 'object',
  required: ['wrote_file', 'edits', 'flags', 'ranking', 'flip'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true if you wrote your review file and the decision file holds every edit it lists' },
    edits:      { type: 'integer', description: 'count of lines under `## Edits` in your review file (0 when it reads "None.")' },
    flags:      { type: 'integer', description: 'count of entries under `## Flags` in your review file (0 when it reads "None.")' },
    ranking:    { ...RANKING, description: 'the ranking of the decision file after your edits, best first, as an INDEX only' },
    flip:       { type: 'string', enum: FLIP_GRADES, description: 'the grade under `## Flip check` in the decision file after your edits: dominant, robust or fragile, as the prompt defines them' },
  },
};

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';
// Agents that edited files through a Bash command or a script it carried lost backslashes, in single quotes too.
const FILE_WRITE_NOTE = 'Write file content, and any script that edits a file, with the Write or Edit tool, since text sent through a Bash command can lose backslashes and alter backticks.';

// =============================================================================
// Shared prompt fragments
// =============================================================================
const CITE = 'Cite each factual claim to its original source: a file:line, a measurement (the exact command and its result), a source URL, or "own judgment" where you have none.';
const NO_AGENT_CHECK = "such as one that needs a testbed the run lacks, a source no agent can open or the user's own hardware";
const HOSTILE_INPUTS = 'a failure, a concurrent edit, a human-set value, state saved before the change (a legacy row, a migration, a value an older version stored), and an edit by another program that no scan has seen yet';
// The decider and the reviewer apply the same tie rule and flip rule, so each is stated once.
// The weights have no fixed scale, so the margin is a share of their sum. A pairwise margin has no order
// for a chain of near totals (12, 11.4, 10.8 with a margin of 1), so the rule forms groups down one list.
const TIE_RULE = `sort the ranked options by total, best first. The options whose totals lie at most M below
   the highest total, where M is 5% of the sum of every criterion's weight, form a tie group, ranked
   simplest first. Form each next group the same way from the options left.`;
const FLIP_RULE = `the smallest single change to one cell or one weight that swaps rank 1 and rank 2. Grade
   it DOMINANT when rank 1 is at least as good as rank 2 on every criterion, ROBUST when the smallest swap
   is larger than the uncertainty of the input it moves, FRAGILE when it is not. When one option ranks
   alone, say so and grade it DOMINANT.`;

const DEFAULT_PATH = `Normal use, an edit by another program or tool, and a failure such as an outage, a timeout or a
locked file are all on the default path. Operator action means only a deliberate configuration change or
command by the user that the requirements neither list as a scenario nor require the decision to provide.
A path they list or require, such as a human commit, a revert or a manual apply path, is on the default
path. A breach reachable only through operator action is a con, never a must failure.`;

const ENV = `THE DECISION + RUBRIC: ${REQ_REF}
${REPO ? `CODEBASE (read-only context — pattern-fit / feasibility only; do NOT modify): ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})\n` : ''}${CONTEXT ? `EXTRA CONTEXT: ${CONTEXT}\n` : ''}${TESTBED ? `TESTBED — ground claims EMPIRICALLY where you can: ${TESTBED}\nPrefer MEASURED evidence over reasoning: run the check and cite the exact command + result in your file,
so a later agent can rerun it. Treat the testbed as READ-ONLY unless it says otherwise. Leave no artifacts in it.
A measured difference smaller than the spread across repeated runs decides nothing: score it own judgment,
low-confidence, and state the spread.\n` : ''}NON-NEGOTIABLES (musts) are pass/fail: an option that fails one is ruled out and never ranked.
Judge each non-negotiable at the depth the requirements state. Where they state none, judge it on the
DEFAULT PATH: the default configuration and the paths the design runs with no operator action.
${DEFAULT_PATH}
WEIGHTED CRITERIA (wants) are scored per option as MET, PARTLY MET or MISSED, each with its cited evidence.
The weighted total counts met as the criterion's full weight, partly met as half its weight and missed as
zero. A want scores met only on a cited source or a measurement, and own judgment scores at most partly met.
Score each weighted criterion on what the option achieves against it, never on its change from the current
state. When not acting is possible, a DO-NOTHING option is scored on the same rubric.
Prefer the SIMPLEST option that meets all requirements. If a more complex option ranks above it, the
evidence must show why the simpler one is inadequate.
${CITE}
A MEASUREMENT cites its exact command and its result. Save any script it ran under ${SCRIPTS_DIR}/ (create it
if needed) with a file name that no file there holds yet, and never change a script already there, so a later
agent can rerun it and get the result its citer got.
When an option is a design of software or a process, test it against each of five hostile inputs: ${HOSTILE_INPUTS}. A defect found that way is a con of the option, or, for a challenger, a
contribution when it also fixes it.`;

const list = (paths) => paths.map((p) => `  - ${p}`).join('\n');

// A challenger's contributions are what the next agent must beat, so the rule is stated where it is applied.
const contributionRule = (latest) => `CONTRIBUTION: a change, inside the scope the rubric decides, to what would be built or done. It is one of
four kinds: a NEW OPTION, a FEATURE ADDED to an option, a FEATURE REMOVED from an option for a stated
reason (it is overkill, or it serves an edge case too unlikely to justify its cost), or a CORRECTION of an
error in an earlier file. It must make the option better on at least one weighted criterion or on a plain
measure the rubric does not name, such as simpler, more efficient, faster, or more robust where robustness
is needed, and it cites its evidence. No size threshold applies, since several small contributions can lift
an option over another. A FEATURE ADDED, FEATURE REMOVED or CORRECTION contribution targets one of the
three leading options (every option when fewer stand) under \`## Standing\` in ${latest}, unless it names the shortcoming that holds a lower option down and gives evidence that the
contribution resolves it.`;

// =============================================================================
// Role prompts
// =============================================================================
const openPrompt = () => `
You are the OPENING INVESTIGATOR of a decision. Find the best answer: every option worth weighing, with
the evidence for and against each.
${ENV}

PROCEDURE:
1. Search the web${REPO ? ' and the codebase above' : ''} with the tools you have for the options that address the decision, including
   a simple baseline. Read the sources, search, and measure where you can.
2. Judge each option against every non-negotiable and weighted criterion of the rubric.
WRITE ${invFile(1)} (create ${INV_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE}
It holds these sections, in this order:
- \`## Options\`: every option you weighed, each under a run-wide id (O1, O2 and so on) with a description
  of what would be built or done, its pros and its cons. Each pro and con names the non-negotiable or
  criterion it bears on and its source.
- \`## Leader assumptions\`: the assumptions the leading option rests on.
- \`## Standing\`: every option in order, best first, one line each saying which criteria place it there.
- \`## Searched\`: each direction you tried that yielded no option, with why.
Be concrete and terse. A later investigator reads your file and tries to beat or improve its leader.
Do NOT modify any repo, stage, or commit.
Return via the schema.`;

const challengePrompt = (k) => `
You are CHALLENGER ${k} of an investigator chain on a decision. Each investigator reads every earlier
file of the chain and must beat or improve what it holds.
${ENV}
EARLIER INVESTIGATION FILES (read each VERBATIM, in this order):
${list(Array.from({ length: k - 1 }, (_, i) => invFile(i + 1)))}
${contributionRule(invFile(k - 1))}

PROCEDURE:
1. REPLACE THE LEADER: reject one assumption under \`## Leader assumptions\` in ${invFile(k - 1)} and
   search for an option that does better without it. Think past the framing the earlier files share.
2. IMPROVE: try to improve any option under the contribution rule above.
3. Contribute one or more things whenever you can. Never repeat a contribution an earlier file holds,
   and never edit an earlier file.
WRITE ${invFile(k)}. ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE}
It holds these sections, in this order:
- \`## Contributions\`: each under an id C${k}.1, C${k}.2 and so on, with its kind, the option id it targets
  or, for a new option, the next free option id, what changes in what would be built or done, its pros and
  its cons (each naming the non-negotiable or criterion it bears on and its source), and the earlier
  statement it corrects, if any. With no contribution the section reads \`None.\`
- \`## Leader assumptions\`: the assumptions the leading option now rests on.
- \`## Standing\`: every option of the run in order after your contributions, best first, one line each
  saying which criteria place it there.
- \`## Searched\`: each replacement and improvement attempt that added nothing, with why.
Set contributed=false only when \`## Contributions\` reads \`None.\` and \`## Searched\` holds at least one
replacement attempt against the leader's assumptions and one improvement attempt for each of the three
leading options (every option when fewer stand) under \`## Standing\` in ${invFile(k - 1)}, each with the reason it adds nothing under the contribution rule.
contributed=false ends the chain, and the decider runs next.
Do NOT modify any repo, stage, or commit.
Return via the schema.`;

const decidePrompt = (files) => `
You are the DECIDER. Rank every option the investigation files hold, and every combination you build from
them, in one weighted decision matrix.
${ENV}
INVESTIGATION FILES (read each VERBATIM, in this order):
${list(files)}
You MAY search the web${REPO ? ' and the codebase' : ''} to fill a gap the files leave.

PROCEDURE:
1. Collect every option of the investigation files under its id, with the contributions it carries. You
   MAY build a combination of options where they genuinely compose (no Frankenstein), under the next free
   option id.
2. Build ONE decision matrix under the rubric: every option, every combination and, when not acting is
   possible, the do-nothing option, judged pass or fail on every non-negotiable and scored on every
   weighted criterion, with its weighted total. Each cell cites its source (the investigation file and the
   claim, with the original source it cites) or is marked "own judgment". Never fabricate a citation.
3. RANK every option that passes every non-negotiable by weighted total under the TIE RULE: ${TIE_RULE}
   The file says where a tie group puts a simpler option above a higher total. When the do-nothing
   option ranks first, the answer is not to act.
4. FLIP CHECK: ${FLIP_RULE}
WRITE ${DECISION_FILE}. ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE}
It holds these sections, in this order:
- \`## Ranking\`: every option that passes every non-negotiable, best first, one line each with its rank,
  title, total, \`combines with\` (the ranks it genuinely composes with) and \`excludes\` (the ranks it is
  mutually exclusive with).
- \`## Options\`: per ranked option, what would be built or done, its pros, its cons and the contributions
  it carries, by id.
- \`## Matrix\`: the matrix table, every option scored.
- \`## Flip check\`: the swap and the grade.
- \`## Ruled out\`: each option that fails a non-negotiable, with the non-negotiable, the evidence that
  rules it out (a cited locator, or a complete search of a named scope that found no support) and the
  one observation that would reverse that.
- \`## Changes to investigation facts\`: each fact of an investigation file your own research changed,
  with the old fact, the new fact and the source, or \`None.\`
- \`## Checks for the user\`: each question no agent can settle, ${NO_AGENT_CHECK}, with
  the check and the result that would change the ranking, or \`None.\` When the decision is about what to
  test, these checks are part of the deliverable.
Every option an investigation file holds appears under \`## Ranking\` or \`## Ruled out\`.
Do NOT modify any repo, stage, or commit.
Return via the schema.`;

const reviewPrompt = (files) => `
You are the FINAL REVIEWER. Verify the decision file against its sources and correct each error you can
prove.
${ENV}
INVESTIGATION FILES (read each VERBATIM, in this order):
${list(files)}
THE DECISION FILE (read it verbatim): ${DECISION_FILE}

PROCEDURE:
1. Open the source behind every cell of the three top-ranked options, behind every non-negotiable
   judgment of every ranked option and behind the evidence of every \`## Ruled out\` entry. Rerun each script under ${SCRIPTS_DIR}/${TESTBED ? ' and each testbed command' : ''} such a cell rests on.
   Sample the sources behind the other cells.
2. Recompute every total. Check that the order follows the TIE RULE: ${TIE_RULE}
   Check that every option of the investigation files is ranked or ruled out, and that each
   \`combines with\` and \`excludes\` claim agrees with the entry it names.
3. Fix in ${DECISION_FILE}, with the Edit tool, each error a source, a rerun or the arithmetic proves,
   such as a wrong citation, a fact the source contradicts, a wrong total, an order that does not follow
   the totals, a missing option, a ranked option that fails a non-negotiable (move it to
   \`## Ruled out\`), or a ruled-out option whose failing non-negotiable a source disproves (score it in
   \`## Matrix\` and rank it). Change no judgment you cannot prove wrong. An edit that moves an option
   to another rank or out of the ranking updates every \`combines with\` and \`excludes\` rank that names a
   moved option.
4. When an edit changes rank 1 or rank 2, or a cell, weight or total either one rests on, redo
   \`## Flip check\` in ${DECISION_FILE} and log it as an edit. The FLIP CHECK is ${FLIP_RULE}
WRITE ${REVIEW_FILE}. ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE}
It holds these sections, in this order:
- \`## Edits\`: one line per edit you made to the decision file: the section, the text before, the text
  after and the evidence, or \`None.\`
- \`## Flags\`: each score or order you would judge differently with no proven error, with your reason,
  or \`None.\`
Do NOT modify any repo, stage, or commit.
Return via the schema.`;

// =============================================================================
// Run state
// =============================================================================
const RESUME = "Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.";
const agents = { investigate: 0, decide: 0, review: 0 };   // agents started per phase
const investigationFiles = [];  // every attested investigation file, in chain order
let stop = '';                  // why the chain ended: '' (halted inside it) | dry | cap
let haltKind = '';              // '' (not halted) | 'write-unattested'
let haltReason = '';
let decisionFile = '';          // named only once its writer attested, since a same-runId relaunch can leave a stale file there
let reviewFile = '';
let ranking = [];
let flip = '';
let userChecks = 0;
let edits = 0;
let flags = 0;
const unattested = (who, file) => { haltKind = 'write-unattested'; haltReason = `The ${who} did not confirm writing ${file}.`; log(`  ✋ the ${who} did NOT confirm writing ${file} → halting before any later agent`); };
// The ranking is an index, so an entry with no title cannot be relayed, and an unranked one sorts last.
const rankingOf = (value) => (Array.isArray(value) ? value : [])
  .filter((item) => item !== null && typeof item === 'object' && typeof item.title === 'string' && item.title.trim())
  .sort((a, b) => (Number.isFinite(a.rank) ? a.rank : Infinity) - (Number.isFinite(b.rank) ? b.rank : Infinity));
const countOf = (value) => (Number.isInteger(value) && value > 0 ? value : 0);

run: {
  // ===========================================================================
  // INVESTIGATE: a serial chain, since each agent reads every earlier file.
  // ===========================================================================
  phase('Investigate');
  log(`decide: investigator chain of at most ${MAX_INVESTIGATORS} → ${INV_DIR}`);
  agents.investigate++;
  const opened = await callAgent(openPrompt(), roleOpts('investigate', { schema: OPEN_SCHEMA, phase: 'Investigate', label: 'investigate i1' }));
  if (!opened) throw new Error(`Opening investigator returned nothing (investigate i1: agent skipped or died). ${RESUME}`);
  // A run launched inside a user turn relays that message to every agent, so the first agent stops it before any later one.
  if (opened.relayed_request === true) {
    throw new Error('A user request was relayed into the context of the opening investigator ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts.');
  }
  if (opened.wrote_file !== true) { unattested('opening investigator', invFile(1)); break run; }
  investigationFiles.push(invFile(1));
  log(`  ✓ i1 wrote ${invFile(1)}`);

  for (let k = 2; k <= MAX_INVESTIGATORS; k++) {
    agents.investigate++;
    const challenge = await callAgent(challengePrompt(k), roleOpts('investigate', { schema: CHALLENGE_SCHEMA, phase: 'Investigate', label: `investigate i${k}` }));
    if (!challenge) throw new Error(`Challenger returned nothing (investigate i${k}: agent skipped or died). ${RESUME}`);
    if (challenge.wrote_file !== true) { unattested(`challenger i${k}`, invFile(k)); break run; }
    investigationFiles.push(invFile(k));
    if (challenge.contributed === false) {
      stop = 'dry';
      log(`  ✓ i${k} contributed nothing → the chain stops dry after ${k} investigator(s)`);
      break;
    }
    log(`  ✓ i${k} contributed → ${invFile(k)}`);
  }
  if (!stop) {
    stop = 'cap';
    log(`  → the chain stops at the cap: maxInvestigators (${MAX_INVESTIGATORS}) ran`);
  }

  // ===========================================================================
  // DECIDE: one decider ranks every option of every investigation file.
  // ===========================================================================
  phase('Decide');
  agents.decide++;
  const dec = await callAgent(decidePrompt(investigationFiles), roleOpts('decide', { schema: DECIDE_SCHEMA, phase: 'Decide', label: 'decide' }));
  if (!dec) throw new Error(`Decider returned nothing (decide: agent skipped or died). ${RESUME}`);
  if (dec.wrote_file !== true) { unattested('decider', DECISION_FILE); break run; }
  decisionFile = DECISION_FILE;
  ranking = rankingOf(dec.ranking);
  flip = FLIP_GRADES.includes(dec.flip) ? dec.flip : '';
  userChecks = countOf(dec.user_checks);
  log(`  decision ranks ${ranking.length} option(s), rank 1 = "${ranking[0]?.title ?? '?'}" (flip=${flip || '?'}, checks=${userChecks})`);

  // ===========================================================================
  // REVIEW: one final reviewer verifies decision.md and corrects what it can prove.
  // ===========================================================================
  phase('Review');
  agents.review++;
  const rev = await callAgent(reviewPrompt(investigationFiles), roleOpts('review', { schema: REVIEW_SCHEMA, phase: 'Review', label: 'review' }));
  if (!rev) throw new Error(`Reviewer returned nothing (review: agent skipped or died). ${RESUME}`);
  if (rev.wrote_file !== true) { unattested('final reviewer', REVIEW_FILE); break run; }
  reviewFile = REVIEW_FILE;
  ranking = rankingOf(rev.ranking);
  flip = FLIP_GRADES.includes(rev.flip) ? rev.flip : '';
  edits = countOf(rev.edits);
  flags = countOf(rev.flags);
  log(`  ✓ the final reviewer made ${edits} edit(s) and raised ${flags} flag(s), rank 1 = "${ranking[0]?.title ?? '?'}" (flip=${flip || '?'})`);
}

const halted = haltKind !== '';
const HALT_STATUS = {
  'write-unattested': 'BLOCKED (an agent did not confirm writing its file)',
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// Flags take precedence: a flag is a judgment the user settles, an edit one the reviewer already proved.
const status = halted ? HALT_STATUS[haltKind]
  : flags > 0 ? `decided with flags (the final reviewer flags ${plural(flags, 'judgment call')} for the user)`
  : edits > 0 ? `decided with corrections (the final reviewer made ${plural(edits, 'edit')})`
  : 'decided (the final reviewer made no edit and raised no flag)';
log(`decide: ${status}, ${agents.investigate + agents.decide + agents.review} of at most ${MAX_AGENTS} agents started`);

const reviewNote = `the edits under \`## Edits\` and every flag under \`## Flags\` in ${REVIEW_FILE}`;
const flipNote = flip === 'fragile'
  ? `The flip check is graded FRAGILE. Present \`## Flip check\` in ${DECISION_FILE}, since rank 1 turns on the input it names, and let the user settle it. `
  : '';
const checksNote = userChecks
  ? `Present the ${userChecks} check(s) under \`## Checks for the user\` in ${DECISION_FILE}: each names the result that would change the ranking. `
  : '';
// With nothing ranked there is no rank 1 to present or build, so that hand-back names only the ruled-out options.
const decidedStep = ranking.length
  ? `Present the ranking under \`## Ranking\` in ${DECISION_FILE}, with ${reviewNote}. ${flipNote}${checksNote}Rank 1 is the top answer, and the user may combine the entries marked as combinable. When rank 1 is the do-nothing option, the answer is not to act. To build a pick, author it as a plan file, refine it with refine-cycle, then build it with develop-cycle (several picks become several blocks of one plan file).`
  : `No option passes every non-negotiable: present \`## Ruled out\` in ${DECISION_FILE}, with ${reviewNote}. ${checksNote}Refine the requirements with the user before a relaunch.`;

return {
  runId: RUN_ID,
  status,
  halted,
  haltReason: halted ? haltReason : '',
  chosen: ranking[0]?.title ?? '',
  ranking,
  flip,
  // Every path where a started investigator does not return throws, so the started count is the count that ran.
  investigators: { ran: agents.investigate, stop },
  agents,
  userChecks,
  edits,
  flags,
  stateDir: STATE_DIR,
  decisionFile,
  reviewFile,
  investigationFiles,
  failed: [],
  nextStep: halted
    ? `Run halted — ${haltReason} Check that file, then relaunch with the same args and no resumeFromRunId: a resume replays the cached return and halts the same way. The relaunch reruns the chain from the opening investigator and replaces each file it reaches.`
    : decidedStep,
};
