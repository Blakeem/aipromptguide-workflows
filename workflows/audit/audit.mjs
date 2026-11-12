export const meta = {
  name: 'audit',
  description: 'Read-only fan-out audit, lean/file-bus design, in two kinds whose products stay apart. kind defects (the default) fans out over bounded units (a reviewer, then a verifier only where findings exist) and writes one verbatim issue file per unit, the closed defect inventory and your triage doc, which develop-cycle.mjs in fix mode then builds behind a two-stage review. A clean unit is written by the reviewer itself, and a unit with findings goes to a verifier, so each file has one writer. kind enhancements fans out ONE finder per lens across the whole scope (breadth, not slices, since cross-cutting enhancements are the point), each writing its candidates to candidates/<lens>.md, then verifiers bin-packed across lenses that confirm each candidate against the real code, kill anything the system ALREADY does, score impact x size, and write one verbatim proposals/<lens>.md. Nothing an enhancements run writes is auto-applied. Both kinds then STOP. Agents exchange messages as verbatim files, and the harness only routes paths + verdicts.',
  whenToUse: 'kind defects: review a whole codebase (or subsystem) for production DEFECTS as a planned campaign. The main agent runs gen-units.mjs and passes the units in args. Each unit gets a reviewer, a clean unit gets its runs/<runId>/issues/<unit>.md marker from the reviewer, and a unit with findings gets a verifier that writes that file. You triage by editing those files (flip a decision to SKIP, answer a NEEDS_USER by writing the chosen option into its Fix line), then run develop-cycle.mjs in fix mode, one plans entry per triaged issue file with findings. An OPTIONAL lens (args.lens, or per-unit unit.lens) narrows WHICH defects a unit hunts, and an ARRAY of lenses sweeps the same files from several angles behind ONE verifier per unit. A lens never widens the pass into proposing improvements, because the inventory feeds an autonomous fixer. kind enhancements: audit a system you already have for ENHANCEMENTS, bigger changes worth writing up, not nits: make it more efficient, simpler, cheaper, more robust, less work to operate, or smaller (removing a role/file/arg/code path is a first-class enhancement). The main agent settles the scope + the lenses with the user. Each lens gets the whole scope and returns a verified, impact-scored, human-triage-ready proposal file. YOU triage, and adopted proposals become plan-file blocks that refine-cycle converges and develop-cycle builds. NOT for open-ended creative variations (brainstorm-cycle) or for concluding among competing approaches (decide-cycle).',
  phases: [
    { title: 'Review', detail: 'kind defects. Reviewer finds production defects in ONE bounded unit (units run concurrently, read-only) and writes them, with the evidence for each, to reviews/<unit>-<lens>.md, returning only their count; when it finds nothing it writes the clean issues/<unit>.md marker itself.' },
    { title: 'Find', detail: 'kind enhancements. One finder per lens (CONCURRENT), each reading the WHOLE scope through its lens. Grounded candidates only: what the system does today (file:line) -> what it would do instead -> the concrete cost that removes, with the evidence for each, written to candidates/<lens>.md. The finder returns only the candidate ids. A lens that finds nothing writes its own clean proposals/<lens>.md marker.' },
    { title: 'Verify', detail: 'kind defects: spawned ONLY for units with findings, one per unit. It reads the review files by path, confirms each finding against real code, corrects severity, checks the Fix line it writes against the code it changes, routes via the decision matrix, and WRITES runs/<runId>/issues/<unit>.md verbatim (the inventory), returning a slim verdict index. kind enhancements: spawned ONLY for lenses with candidates, bin-packed: lenses join one verify unit up to a candidate cap, and a lens never splits across units. Each verifier reads its lenses\' candidates files by path, re-checks each candidate against the real code, REJECTS anything the system already does / any unsubstantiated benefit / any nit / anything that is really a defect, scores impact x size, routes ADOPT | ROADMAP | NEEDS_USER | REJECT, and WRITES proposals/<lens>.md verbatim for each of its lenses.' },
  ],
};

// =============================================================================
// Config. Everything project-specific arrives via args so the engine stays general, and the harness
// reads NO files (WORKFLOW-PRINCIPLES.md #2/#4/#6).
//
// TWO KINDS, ONE SHAPE, TWO PRODUCTS. Both kinds fan out finders, verify only where findings exist,
// write one product file per unit or lens, and STOP. kind defects writes issues/<unit>.md, a CLOSED
// defect inventory that develop-cycle's autonomous fix mode builds. kind enhancements writes
// proposals/<lens>.md, which a human triages and nothing auto-applies. An enhancement must never enter
// the fix inventory: it would be auto-applied behind a two-round gate, and an enhancement list does not
// converge the way a closed defect inventory does, since there is always another enhancement.
//
// kind defects slices by file, which is right for local defects. kind enhancements fans out by LENS over
// the WHOLE scope, since an enhancement is frequently cross-cutting ("every engine re-implements this"
// is invisible to a unit-scoped reader). For a corpus too large for one turn, run per subsystem with a
// narrower scope.
//
// ENHANCEMENT, not improvement. The impact floor is deliberately high: a typo or a nit IS an improvement
// but nobody would write it up as an enhancement, and kind defects catches it anyway. REMOVAL counts:
// deleting a role, a file, an arg, or a code path is a first-class enhancement when it makes the system
// simpler, cheaper, or more reliable.
// =============================================================================
// args arrives from the Workflow tool VERBATIM and unvalidated, so a structural typo in a hand-built
// payload dies here as a bare parse error naming the runtime. Name the payload and the fix instead.
let A;
try {
  A = typeof args === 'string' ? JSON.parse(args) : args;
} catch (e) {
  throw new Error('Invalid args JSON (' + e.message + '). The Workflow tool delivers args verbatim and unvalidated, so this is the payload the operator passed - validate the JSON locally (a missing } in a hand-built payload is the common cause) and relaunch.');
}

// A payload built for the other kind would otherwise run this kind and ignore the args it came for.
const KINDS = ['defects', 'enhancements'];
const KIND = A?.kind ?? 'defects';
if (!KINDS.includes(KIND)) {
  throw new Error(`Invalid args.kind: it must be one of ${KINDS.join(' | ')}, and it defaults to defects; got ${JSON.stringify(A.kind)}.`);
}
const KIND_ARGS = {
  defects: ['units', 'lens', 'gates', 'changePolicy', 'reviewSeverity'],
  enhancements: ['scope', 'lenses', 'minImpact', 'goals', 'context', 'categories'],
};
const OTHER_KIND = KIND === 'defects' ? 'enhancements' : 'defects';
const strayArgs = A && typeof A === 'object' ? KIND_ARGS[OTHER_KIND].filter((key) => Object.hasOwn(A, key)) : [];
if (strayArgs.length) {
  const named = strayArgs.map((key) => `args.${key}`).join(', ');
  throw new Error(`Wrong kind for ${named}: only kind: ${OTHER_KIND} reads ${strayArgs.length > 1 ? 'them' : 'it'}, and this run is kind: ${KIND}${(A.kind ?? null) === null ? ' (the default)' : ''}. To audit for ${OTHER_KIND}, pass kind: ${OTHER_KIND}. To audit for ${KIND}, drop ${named}.`);
}

if (!A || !A.runId) {
  throw new Error(`args must include at least { runId, root, target, ${KIND === 'defects' ? 'conventions, units' : 'scope, lenses'} }; got typeof=` + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally this workflow tool's own directory.
if (!A.root) {
  throw new Error(`args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool's own directory).${KIND === 'defects' ? ' The engine no longer spawns an agent to auto-detect it.' : ''}`);
}

// -- kind defects: the repo and the floors ------------------------------------------------------
// `target.repo` is REQUIRED and has NO default. This pass is read-only, so a wrong repo destroys
// nothing — but it produces a bogus inventory that then feeds develop's autonomous fix mode, and the
// run-state-inside-repo guard below is computed from the same value, so it would mis-fire too.
if (KIND === 'defects' && (typeof A.target?.repo !== 'string' || !A.target.repo.trim())) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the git repo under review. There is no default — every path the reviewers read, and the inventory that feeds develop\'s fix mode, resolves against it.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? (KIND === 'defects' ? '(none supplied — infer from the surrounding code)' : '(none supplied — infer from the code)');
const GATES       = A.gates ?? {};                          // { build, test, testSetup } — informational context for reviewers

// Severity floor. This pass reports >= reviewSeverity into the CLOSED inventory that develop's fix
// mode then fixes (because the inventory is closed here, fixing mediums downstream converges — no fresh
// review surfaces a new batch each round).
const SEV_RANK    = { low: 1, medium: 2, high: 3, critical: 4 };
// A plain lookup resolves an inherited name such as `constructor` to a function, which no comparison drops.
const sevRank     = (name) => (Object.hasOwn(SEV_RANK, name) ? SEV_RANK[name] : undefined);
const REVIEW_SEV_NAME = A.reviewSeverity ?? 'medium';
const REVIEW_SEV  = sevRank(REVIEW_SEV_NAME);
if (REVIEW_SEV === undefined) throw new Error(`reviewSeverity "${REVIEW_SEV_NAME}" is not one of low|medium|high|critical`);
// A typo that coerced would silently widen or narrow the scope of every Fix line the fixer later builds.
const VALID_CHANGE_POLICY = new Set(['focused', 'proactive']);
const CHANGE_POLICY = A.changePolicy ?? 'focused';
if (!VALID_CHANGE_POLICY.has(CHANGE_POLICY)) {
  const renamed = CHANGE_POLICY === 'strict' ? ' The policy strict is now named focused, so pass "focused" instead.' : '';
  throw new Error(`Invalid args.changePolicy: it must be one of focused, proactive; got ${JSON.stringify(A.changePolicy)}.${renamed} It is not coerced, since it decides how far each Fix line reaches.`);
}
const PROACTIVE = CHANGE_POLICY === 'proactive';
// The reviewer and the verifier both grade on this one written scale, so the floor cuts where both expect it.
const SEVERITY_SCALE = `SEVERITY - grade by impact, never by the size of the fix. When two grades fit, take the higher.
  critical - loses or corrupts data, opens a security hole, or breaks the main path on every input.
  high     - crashes or gives wrong output on an input the code accepts.
  medium   - a real defect with a bounded impact, such as a leak, a wrong error path, or a misleading
             result the caller can detect.
  low      - a real defect with no effect on any input the code accepts today.`;

// -- kind enhancements: what better means and the impact floor ----------------------------------
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
  'robustness',      // fewer ways to fail, better failure behavior (NOT a present bug — that is the defects kind)
  'capability',      // a genuinely new capability the system should have
  'operator-effort', // less manual work / fewer steps / less babysitting for the human
  'consistency',     // one way to do a thing instead of N divergent ones
  'observability',   // the operator can see what happened and why
  'cost',            // money, quota, storage
];

// =============================================================================
// Shared by both kinds
// =============================================================================
// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType
// that exists in YOUR registry. Every role defaults to opus: kind defects' verifier is high stakes, and
// its reviewer under-reports on large surfaces on the fast tier (measured 2026-08-01, wt-tooling), so a
// missed finding never reaches verify. kind enhancements' finder needs breadth and judgment across the
// whole scope, and its verifier is the quality gate that kills the noise.
const ROLE_KEYS = KIND === 'defects' ? ['review', 'verify'] : ['find', 'verify'];
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
const M  = { ...Object.fromEntries(ROLE_KEYS.map((role) => [role, 'opus'])), ...roleMap('models', A.models, VALID_MODELS) };
const EF = { ...Object.fromEntries(ROLE_KEYS.map((role) => [role, DEFAULT_EFFORT])), ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
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
log(`${KIND === 'defects' ? 'review' : 'enhance'}: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

// ROOT is the ABSOLUTE base run-state hangs off (supplied by the main agent), so every agent +
// `git -C` call is cwd-independent. Run-state lands in `<ROOT>/runs/<runId>` unless args.stateDir overrides.
const ROOT      = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm      = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const isAbsPath = (p) => /^([a-zA-Z]:)?\//.test(norm(p));
const abs       = (p) => { const n = norm(p); return (ROOT && !isAbsPath(n)) ? `${ROOT}/${n}` : n; };
// args.notes = { dir, survey } makes every agent answer the exit survey in its own file under dir.
const notesArg = (value) => {
  if (value === undefined) return null;
  const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
    && [value.dir, value.survey].every((p) => typeof p === 'string' && isAbsPath(p.trim()));
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
// No `?? '.'` default. `abs()` resolves a relative path against ROOT, the TOOL's directory, so a default
// would audit the tool. kind defects requires target.repo above. kind enhancements requires it only when
// a scope path is relative (checked below), since an all-absolute scope needs no repo.
const REPO      = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
// `conventions` is a distilled index, so each agent also reads the project's own instruction files in full.
// refine-cycle.mjs and develop-cycle.mjs hold copies, since an engine cannot import: a test pins the copies equal.
// Static lead clause: gen-flows labels the throw node from it.
const conventionFilesOf = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.trim())) {
    throw new Error(`Invalid args.conventionFiles: it must be an array of file paths, each absolute or relative to target.repo; got ${JSON.stringify(value)}.`);
  }
  return value.map((p) => { const n = norm(p.trim()); return /^([a-zA-Z]:)?\//.test(n) ? n : `${REPO}/${n}`; });
};
// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';
// Agents that edited files through a Bash command or a script it carried lost backslashes, in single quotes too.
const FILE_WRITE_NOTE = 'Write file content, and any script that edits a file, with the Write or Edit tool, since text sent through a Bash command can lose backslashes and alter backticks.';
// A launch inside a user turn relays that turn's message to every agent (root CLAUDE.md, "Launch from a notification turn").
const LAUNCH = 'start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts';
const RELAYED_REQUEST = { type: 'boolean', description: 'true when your context holds a user request that the Workflow harness relayed ahead of this task, apart from the task text itself. false when it holds only this task. TRUE HALTS the run before any later agent.' };
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

// -- kind enhancements: the scope, and convention files that need a repo -------------------------
// Scope — the paths every finder reads. Enhancements are cross-cutting, so a lens sees ALL of it.
const SCOPE = (Array.isArray(A.scope) ? A.scope : (A.scope ? [A.scope] : [])).map(String).filter(Boolean);
if (KIND === 'enhancements' && !SCOPE.length) {
  throw new Error('args.scope is required: the file/dir paths (repo-relative or absolute) every finder reads through its lens. Enhancements are cross-cutting, so each lens sees the WHOLE scope — keep it to what one agent can genuinely read in a turn, and split the run by subsystem if it is larger than that.');
}
// A relative scope path is meaningless without a repo to resolve it against — and guessing would send
// every finder to read the wrong tree and return a confidently wrong proposal list.
const RELATIVE_SCOPE = SCOPE.filter((p) => !isAbsPath(p));
if (RELATIVE_SCOPE.length && !REPO) {
  throw new Error(`args.target.repo is required when any args.scope path is relative (${RELATIVE_SCOPE.join(', ')}): pass the ABSOLUTE path to the system under audit — the directory holding its .git — since relative scope paths resolve against it. There is no default: args.root is THIS tool's directory, so defaulting would audit the tool. Give every scope path as an absolute path instead if the audit target is not one repo.`);
}
// With no repo, conventionFilesOf would resolve a relative entry to a root-level path such as /CLAUDE.md.
const RELATIVE_CONVENTION_FILES = (Array.isArray(A.conventionFiles) ? A.conventionFiles : [])
  .filter((p) => typeof p === 'string' && p.trim() && !isAbsPath(p.trim()));
if (RELATIVE_CONVENTION_FILES.length && !REPO) {
  throw new Error(`args.target.repo is required when any args.conventionFiles entry is relative (${RELATIVE_CONVENTION_FILES.join(', ')}): pass each entry as an absolute path, or set target.repo so a relative entry resolves against it.`);
}
const CONVENTION_FILES = conventionFilesOf(A.conventionFiles);

// =============================================================================
// kind defects: paths, guards and lenses
// =============================================================================
const ISSUES_DIR = `${STATE_DIR}/issues`;
const REVIEWS_DIR = `${STATE_DIR}/reviews`;
// Windows folds case in a drive or UNC path, so E:/Repo/x lies inside e:/repo there.
// A POSIX path keeps its case, so a macOS spelling in another case draws no warning.
const pathKey    = (p) => (/^(?:[a-zA-Z]:\/|\/\/)/.test(p) ? p.toLowerCase() : p);
const insideRepo = (p) => {
  const path = pathKey(p);
  const repo = pathKey(REPO);
  return path === repo || path.startsWith(`${repo}/`);
};
// Blind-reviewer placement guard (#3): run-state (incl. the issue files) must live OUTSIDE the target
// repo so the blind quality reviewer (in develop's fix mode) cannot wander into it. Warn loudly if root was set wrong.
if (KIND === 'defects' && insideRepo(STATE_DIR)) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the issue files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
if (KIND === 'defects' && NOTES && insideRepo(NOTES.dir)) {
  throw new Error(`args.notes.dir is inside the target repo. Every agent appends its survey answers there, so the reviewers could read those files as part of the repo under review, and a later develop run would see them in its unstaged diff. Got ${NOTES.dir}, inside ${REPO}. Pass a folder outside the target repo, such as <root>/runs/<runId>-notes.`);
}

// LENS — WHICH defects this pass hunts. Unset reproduces the defect-hunting text verbatim, so an
// existing call is unaffected. Set it to aim the same machinery at a narrower class of defect (a
// destructive-behavior audit, a data-loss sweep, a compliance pass, a document/drawing review):
// `mandate` replaces the reviewer's one-line charter, `criteria` its assessment list, `categories` the
// category list in its review-file template (nothing validates a reviewer's category), `findingNoun`/
// `matters` the floor wording.
//
// A lens NEVER licenses proposing new capability. "Report DEFECTS, not redesigns" and the verifier's
// `scope-creep -> REJECT` are UNCONDITIONAL and must stay that way: this inventory feeds
// develop's autonomous fix mode, so an improvement list here would be auto-applied behind a
// two-round gate — exactly the scope creep the workflow exists to prevent. It also would not converge
// (there is always another improvement), which is what the CLOSED-inventory contract depends on.
// Improvement/feature hunting is the enhancements kind, whose proposals never enter this inventory.
//
// args.lens sets the default for every unit; a unit may override it with `unit.lens` (same shape).
// `lens` may be ONE lens or an ARRAY of them. An array reviews each unit once per lens and merges the
// results into that unit's SINGLE issue file behind ONE verifier — genuinely different angles over the
// same files, which is what the old `reviewPasses` arg was reaching for and never achieved (it re-ran
// the IDENTICAL prompt, so pass 2 re-hunted pass 1's ground at full cost). Passing the same lens twice reproduces `reviewPasses: 2` exactly, so the arg
// is subsumed, not lost.
const BASE_CRITERIA = `correctness, security, error-handling, resource-leak (unclosed handles/timers/sockets),
  data-integrity, types, api-contract, concurrency (races, shared state), testing (missing coverage
  of risky paths), performance, maintainability, convention adherence`;
const BASE_CATEGORIES = ['correctness', 'security', 'error-handling', 'resource-leak', 'data-integrity', 'types', 'api-contract', 'concurrency', 'testing', 'performance', 'maintainability', 'convention'];
// Field-level defaulting: a lens that sets only `mandate` still gets the base criteria and categories.
const oneLens = (L, i) => ({
  id:          L.id ?? `lens${i + 1}`,
  mandate:     L.mandate ?? 'examining ONE bounded unit of a codebase for PRODUCTION READINESS',
  criteria:    L.criteria ?? BASE_CRITERIA,
  categories:  Array.isArray(L.categories) && L.categories.length ? L.categories : BASE_CATEGORIES,
  findingNoun: L.findingNoun ?? 'production DEFECTS',
  matters:     L.matters ?? ' in production',   // "…why it matters<matters>"
});
const asList = (v) => (Array.isArray(v) ? v : (v ? [v] : [{}]));
// Text an operator or agent acts on, a nextStep or a prompt's PROCEDURE, lists each action as a numbered
// line (principles #20).
// A falsy entry is a step whose condition is false.
const numberedSteps = (steps) => steps.filter(Boolean).map((s, i) => `${i + 1}. ${s}`).join('\n');
// A unit's own lens list REPLACES the run default (it does not merge into it) — with arrays in play,
// element-wise merging would be unpredictable, and per-field defaults already cover the common case.
// An EMPTY array reads as unset, for `unit.lens` and `A.lens` alike: `[]` is truthy, so without this it
// would replace a real lens set with nothing and the per-lens loop would never run — the unit gets zero
// reviewers, contributes 0 to every count, and still looks processed. Silent zero coverage is exactly
// what the `args.units` throw exists to prevent. The dangerous shape is the mixed one — `args.lens: []`
// ("no default, each unit brings its own") plus a unit whose `unit.lens` was forgotten.
const pick = (v) => (Array.isArray(v) ? (v.length ? v : null) : (v || null));
// `isSet` separates a caller's lens from the unset default, whose `lens1` id would mean nothing to a reviewer.
const lensesOf = (unit) => {
  const chosen = pick(unit && unit.lens) ?? pick(A.lens);
  return asList(chosen).map((L, i) => ({ ...oneLens(L, i), isSet: chosen !== null }));
};

// A long slug keeps a hash of its full form: gen-units chunk ids sharing a 60-char prefix would otherwise
// mint one plan id and one finding-id prefix for two issue files.
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const unitSlug = (s) => {
  const full = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (full.length <= 60) return full;
  return `${full.slice(0, 51).replace(/-$/, '')}-${fnv1a(full)}`;
};

// The issue-file path scheme runs/<runId>/issues/<fileSafe(unit)>.md is the user's triage surface and
// the planPath each develop fix-mode entry is handed, so a moved scheme points the fixer at missing files.
const issueFile      = (unitId) => `${ISSUES_DIR}/${fileSafe(unitId)}.md`;
// One review file per lens of a unit. fileSafe never emits `-`, so the unit part cannot collide across
// units, and a lens whose id shares its file-safe form with an earlier lens of the unit takes its position
// as a suffix.
const reviewFiles = (unit, lenses) => {
  const taken = new Set();
  return lenses.map((L, p) => {
    const base = `${fileSafe(unit.id)}-${fileSafe(L.id)}`;
    const name = taken.has(base) ? `${base}-${p + 1}` : base;
    taken.add(name);
    return `${REVIEWS_DIR}/${name}.md`;
  });
};
// Each lens of a multi-lens unit numbers under its own letter tag (a, b, ..., z, aa), so no lens's ids
// rest on another reviewer's self-reported count, and a miscount surfaces as an unmatched verdict.
const lensTag = (p) => (p >= 26 ? lensTag(Math.floor(p / 26) - 1) : '') + String.fromCharCode(97 + (p % 26));
// The tag holds no `-`, so the id minus its last `-` segment is always the unit slug.
const findingId = (unit, n, tag = '') => `${unitSlug(unit.id)}-${tag}${n}`;

// =============================================================================
// kind enhancements: paths and lenses
// =============================================================================
const PROPOSALS_DIR = `${STATE_DIR}/proposals`;
const CANDIDATES_DIR = `${STATE_DIR}/candidates`;
// The most candidates a verifier carrying several lenses judges. A larger lens gets its own, never split.
const VERIFY_UNIT_CANDIDATES = 12;

// Cut, never hashed as unitSlug is, so a saved run keeps its proposals/<lens>.md paths, and two lenses that
// share a 60-character prefix throw the collision error below.
const lensSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
// NOT issues/<unit>.md — that path is develop's fix-mode input and nothing here may be auto-applied.
const proposalFile = (lensId) => `${PROPOSALS_DIR}/${fileSafe(lensId)}.md`;
const candidatesFile = (lensId) => `${CANDIDATES_DIR}/${fileSafe(lensId)}.md`;
// The finder mints each id, so the prefix is what ties a verdict back to its lens inside a packed unit.
const candidatePrefix = (lensId) => `${lensSlug(lensId)}-`;
// And deliberately NO shared NEEDS-USER.md. Every lens verifies concurrently, and an agent "append" is a
// read-modify-write, so two of them would silently clobber each other's entries in an unattended run. A
// user-only call belongs in that lens's own proposal file, where its options + recommendation already go.

// Lenses — the axes of enhancement. Each becomes ONE finder (+ verifier) → ONE proposal file.
const LENSES = (Array.isArray(A.lenses) ? A.lenses : []).map((l, i) => {
  if (typeof l === 'string') return { id: lensSlug(l) || `lens-${i + 1}`, focus: l, criteria: '' };
  const focus = l.focus || l.id || '';
  return { id: lensSlug(l.id || focus) || `lens-${i + 1}`, focus, criteria: l.criteria || '' };
}).filter((l) => l.focus);
if (KIND === 'enhancements' && !LENSES.length) {
  throw new Error('args.lenses is required: a non-empty array of enhancement axes (strings, or { id, focus, criteria }), e.g. ["efficiency","simplification","operator-effort"]. The main agent picks these with the user beforehand (#4).');
}
const dupes = [...new Set(LENSES.map((l) => l.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`lens ids collide after slugging (${dupes.join(', ')}): two lenses would write the same proposal file — give each a distinct id.`);
}

// =============================================================================
// kind defects: structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['finding_count', 'wrote_file', 'wrote_clean_marker', 'relayed_request'],
  properties: {
    relayed_request: RELAYED_REQUEST,
    finding_count: { type: 'integer', minimum: 0, description: 'the number of finding entries in your review file, 0 when you report none' },
    wrote_file: { type: 'boolean', description: 'true ONLY if you wrote your review file, false when you report no finding' },
    wrote_clean_marker: { type: 'boolean', description: 'true ONLY if you wrote the clean-unit marker file, false whenever you report any finding' },
  },
};

const REVIEW_VERIFY_SCHEMA = {
  type: 'object',
  required: ['verdicts', 'wrote_file'],
  properties: {
    wrote_file: { type: 'boolean', description: 'true if you wrote the unit issue file (always required, even when clean)' },
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['finding_id', 'file', 'is_real', 'severity', 'decision', 'matrix'],
        properties: {
          finding_id: { type: 'string' },
          file: { type: 'string', description: 'the repo-relative path of the file the finding is in' },
          is_real: { type: 'boolean' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'YOUR confirmed severity (reviewers over-rate; correct it)' },
          decision: { type: 'string', enum: ['ACTIONABLE', 'NEEDS_USER', 'DEFER', 'REJECT'] },
          // No harness line reads matrix: it is the verifier's routing scaffold and the source of each entry's `- size:` line.
          matrix: {
            type: 'object',
            required: ['clarity', 'size', 'blast_radius', 'scope', 'architectural'],
            properties: {
              clarity: { type: 'string', enum: ['clear', 'ambiguous'] },
              size: { type: 'string', enum: ['trivial', 'small', 'medium', 'large'] },
              blast_radius: { type: 'string', enum: ['local', 'cross-cutting'] },
              scope: { type: 'string', enum: ['in-scope', 'scope-creep'] },
              architectural: { type: 'boolean' },
            },
          },
        },
      },
    },
  },
};

// =============================================================================
// kind defects: shared prompt fragments
// =============================================================================
const REVIEW_ENV = `TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
Source paths are RELATIVE TO THIS REPO. Use \`git -C ${REPO} …\` for git.
CONVENTIONS (judge against these):
${CONVENTIONS}
${CONVENTION_FILES.length ? `CONVENTION FILES (the project's own rules, which the CONVENTIONS text above indexes. Read each one in full, whatever the token target below):
${CONVENTION_FILES.map((p) => `  - ${p}`).join('\n')}
` : ''}GATES (the build/test commands that define "it works", run from the repo root):
  build: ${GATES.build ?? '(none)'}
  test:  ${GATES.test ?? '(none)'}${GATES.testSetup ? `\n  test setup: ${GATES.testSetup}` : ''}
BE TOKEN-ECONOMICAL (target ~250k tokens for your entire turn): review and report ONLY the files your
task names. The target limits your reads of files beyond those: read them only by targeted search or short
reads, and only to confirm or reject a candidate in your task's files, or to check a fix or its blast
radius. Don't restate large files back.`;

// Every agent also loads the user's CLAUDE.md and auto memory, which may set fix scope another way.
// The prompt's own scope and routing rules carry the policy out, so they are not "other".
const POLICY_LINE = `CHANGE POLICY: ${CHANGE_POLICY}. This policy and the scope and routing rules in this prompt settle the scope of each suggested fix and each **Fix:** line, and override any other instruction about scope, including a memory line or a CLAUDE.md. It does not change what counts as a finding.`;
const BEST_FIX = 'the best long-term result: correct, simple, maintainable and consistent with the repo';
const FIX_DIRECTION = PROACTIVE ? `a suggested fix direction with ${BEST_FIX}` : 'a minimal suggested fix direction';
// develop's SUGGESTION_CHECK wording, aimed at the Fix line the verifier writes from a reviewer's hint.
const FIX_CHECK = 'check it against the text it changes, its callers and every sibling text that must agree with it, such as other call sites, the same string or rule elsewhere, and the docs that describe the behavior. That check is also what scores blast_radius.';
const ROUTED_FIX_LINE = PROACTIVE ? `a precise **Fix:** line that prescribes the fix with ${BEST_FIX}` : 'a precise, minimal **Fix:** line';
const TEMPLATE_FIX_LINE = PROACTIVE ? `a precise instruction for the fixer that prescribes the fix with ${BEST_FIX}` : 'a precise, minimal instruction for the fixer';

// =============================================================================
// Review-phase prompts
// =============================================================================
// `prior` lists the review files of this unit's earlier lenses that hold findings, each { lens, path }.
const reviewPrompt = (unit, L, { reviewFile, tag, prior, cleanEligible }) => `
You are the REVIEWER ${L.mandate}. This is a
FIND-ONLY pass: you report defects, and later phases verify and fix them. Do NOT modify any file in
the target repo. The only files you may write are your review file${cleanEligible
    ? ' and the clean-unit marker, both described below, in the run-state dir.'
    : ', described below, in the run-state dir. Another pass decides the unit\'s marker. Return wrote_clean_marker=false.'}
${POLICY_LINE}
${REVIEW_ENV}
UNIT: ${unit.id}${L.isSet ? `\nLENS: ${L.id}` : ''}
FILES TO REVIEW (read each one in full, in as many reads as its length needs. The token target never shortens that read):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}
PROCEDURE:
${numberedSteps([
  prior.length && `ALREADY FOUND in a prior pass over this unit. Read each of these review files before you review:
${prior.map((f) => `  - [${f.lens}] ${f.path}`).join('\n')}
   Output: the findings they hold, which you do not report again.`,
  'Review the FILES TO REVIEW against the criteria and RULES below. Output: your findings.',
  `WRITE the REVIEW FILE below when you report a finding${cleanEligible ? ', or the CLEAN-UNIT MARKER below when you report none' : ''}. Output: the file, or none.`,
  'Return via the schema. Output: finding_count, wrote_file, wrote_clean_marker and relayed_request.',
])}

Assess against these criteria:
  ${L.criteria}.${L.categories.includes('convention') ? "\n  File deviations from CONVENTIONS as 'convention' findings." : ''}

RULES:
- SEVERITY FLOOR: report ONLY ${REVIEW_SEV_NAME}+ ${L.findingNoun}. Do NOT report below-floor,
  stylistic, or speculative "could be more defensive" suggestions. If in doubt it's below the floor, omit it.
- ${SEVERITY_SCALE}
- Do NOT report anything the current code already handles${prior.length ? ', or anything an ALREADY FOUND file above holds, even rephrased' : ''}.
- Stay INSIDE this unit's files. Cross-file concerns: mention as context in a finding's **What:** line, do not chase.
- Report DEFECTS, not redesigns. No speculative rewrites, no gold-plating, no scope creep. Your brief
  above narrows WHICH defects matter here. It never licenses proposing a new capability, a feature, or
  an efficiency idea, and those are rejected downstream. Every finding must be something the code gets
  WRONG today, not something it could do better.
- Each finding: specific file + line, the right category/severity, what's wrong and why it matters${L.matters},
  the evidence that shows it, and ${FIX_DIRECTION}.

REVIEW FILE: if you report at least one finding, WRITE ${reviewFile} (create ${REVIEWS_DIR}/ if
needed). ${REPLACE_NOTE} Number your findings ${findingId(unit, 1, tag)}, ${findingId(unit, 2, tag)} and on, one entry each, in EXACTLY
this format, then return finding_count (the number of entries) and wrote_file=true:
-----
# Review: ${unit.id}${L.isSet ? ` / ${L.id}` : ''}

### [<finding id>] <short, specific title>

- file: <repo-relative path>:<line number or range>
- category: <one of ${L.categories.join(' | ')}>
- severity: <critical | high | medium | low>

**What:** <what is wrong and why it matters${L.matters}>
**Evidence:** <the input or path that reaches it, the lines that show it, or the check you ran and its output>
**Suggested fix:** <${FIX_DIRECTION}>
-----
If you report no finding, write no review file and return finding_count=0 and wrote_file=false.
${WROTE_NOTE} ${FILE_WRITE_NOTE}
${cleanEligible ? `
CLEAN-UNIT MARKER: if AND ONLY IF you find ZERO ${REVIEW_SEV_NAME}+ findings, WRITE the file ${issueFile(unit.id)} (create
${ISSUES_DIR}/ if needed). ${REPLACE_NOTE} Write EXACTLY this content, then set wrote_clean_marker=true:
-----
---
unit: ${unit.id}
hash: ${unit.hash}
reviewed: true
---
# Review: ${unit.id}

No issues found.
-----
If you report ANY ${REVIEW_SEV_NAME}+ finding, write NO marker and set wrote_clean_marker=false.
` : ''}
Zero findings (a clean unit) is a normal, good outcome.`;

// CONTRACT with develop's fix mode — change both together. The issue-file BLOCK FORMAT the verifier writes
// below (frontmatter unit/hash/reviewed; a `## Plan: <unitSlug(unit.id)>` header with its mode/gate/status
// preamble; `### [<id>]` blocks; `- ` header lines, `- status: open` among them; the decision values; the
// `**Fix:**` line) is a plan-bus fix-mode plan file that develop's fixer + acceptance read through
// tools/plan-block.mjs and tools/plan-edit.mjs args writes statuses back into.
// `lensDied` stamps `hash: incomplete`, which gen-units reads as `changed`, so resume re-runs the dead lens.
// `sources` lists the review files that hold findings, each { lens, path, tag, count }.
const reviewVerifyPrompt = (unit, sources, lensDied) => {
  const lenses = lensesOf(unit);
  const multi = lenses.length > 1;
  const lensLine = !lenses[0].isSet ? '' : `- lens: ${multi ? '<the lens id, without brackets, of the review file that holds the kept candidate>' : lenses[0].id}\n`;
  return `
You are the VERIFIER, read-only on SOURCE: you write exactly one inventory file and nothing else, except
a probe that confirms a **Fix:** line (PROCEDURE step 6). Reject false positives and gold-plating
ruthlessly, in particular anything the code ALREADY does and anything that is a preference rather than a
defect.
PROCEDURE - work these steps in order. Each names its output.
1. Read each review file under CANDIDATE FINDINGS in full. Output: every candidate id its line names.
2. FOLD DUPLICATES as its rule below says. Output: one kept id per underlying defect, each other copy
   REJECTed as the id it duplicates.
3. Inspect the ACTUAL code to confirm each remaining candidate is real. A candidate the code leaves
   unsettled keeps is_real=true, and ROUTING sends it to NEEDS_USER. Output: is_real for each candidate,
   and each candidate the code leaves unsettled.
4. Correct each real finding's severity by the SEVERITY scale. Output: its confirmed severity.
5. Draft the **Fix:** line of each real finding. A candidate's suggested fix is a hint, never an
   instruction. Write the **Fix:** line that closes the defect you confirmed, which may differ from the
   suggestion. Before you write it, ${FIX_CHECK} The **Fix:** line covers every file, string or path its
   **What:** names as wrong, and never tells the fixer to leave one of them unchanged. Then score the
   finding on the DECISION MATRIX. Output: its draft fix and its matrix.
6. When a **Fix:** line prescribes a command, flag, or library, tool or API behavior the repo does not
   already use the same way, confirm that behavior against the dependency's own docs or source, or a probe
   in a temporary directory outside the repo, before step 9 writes it. Never prescribe a behavior you did
   not confirm. Make that probe in a fresh directory you create for it alone (such as \`mktemp -d\`),
   outside the target repo and the run-state dir ${STATE_DIR}, and remove that directory before you
   return. Output: each behavior a draft **Fix:** line rests on, confirmed or unconfirmed.
7. Before routing a finding that reverses a documented design choice, check the gotchas in the CLAUDE.md
   nearest the unit's files. Output: the gotcha that bears on it, or none.
8. Route each finding by ROUTING. Output: its decision.
9. WRITE the INVENTORY FILE below, or the clean marker when no verdict is kept, and end it with the
   \`## Rejected\` section when you rejected a candidate. Output: the file, and wrote_file=true.
10. Return all verdicts via the schema. Output: the verdicts.
${SEVERITY_SCALE}
${POLICY_LINE}
${REVIEW_ENV}
UNIT: ${unit.id}
UNIT FILES (each entry's \`- loc:\` value comes from this list):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}
THE REVIEWER${multi ? "S'" : "'S"} BRIEF${multi ? 'S' : ''} (context for judging severity). ${multi
    ? `${lenses.length} reviewers each swept these files under a DIFFERENT brief. Judge each candidate against
the brief of the review file that holds it. A brief narrows which defects matter. It does NOT widen what counts as one.
${lenses.map((l) => `  [${l.id}] ${l.mandate}`).join('\n')}`
    : `It narrows which defects matter. It does NOT widen what counts as one:
  ${lenses[0].mandate}`}
CANDIDATE FINDINGS: the review files below. Each \`### [<finding id>]\` entry in a file is one
candidate, with its file:line, category, the reviewer's severity, what is wrong, the reviewer's evidence
and a suggested fix. Each file holds the ids its line names${multi ? ', and its [lens] is the lens of every candidate it holds' : ''}:
${sources.map((s) => `  - ${multi ? `[${s.lens.id}] ` : ''}${s.path} (${findingId(unit, 1, s.tag)} to ${findingId(unit, s.count, s.tag)})`).join('\n')}

FOLD DUPLICATES FIRST. ${multi ? 'Different briefs' : 'One reviewer'} can surface the SAME underlying defect in different words. Where
two or more candidates are one defect, keep ONE verdict for it (the clearest id, at the highest
justified severity, with a **Fix:** line that closes the whole thing) and REJECT the others.
Candidates that merely share a file and category are NOT duplicates.

DECISION MATRIX — score each real finding on:
  clarity      : clear (one obvious correct fix) | ambiguous (multiple valid fixes / unclear intent)
  size         : trivial (one-liner) | small (localized, <~30 lines) | medium (<~150 lines, this unit) | large
  blast_radius : local (this unit) | cross-cutting (touches shared contracts / many files)
  scope        : in-scope (a real defect in current behavior) | scope-creep (nice-to-have / new feature)
  architectural: true if it questions a design/structural decision

ROUTING (apply in order; first match wins):
  - is_real == false -> REJECT
  - its review file grades it below ${REVIEW_SEV_NAME} -> REJECT (below-floor)
  - scope == scope-creep -> REJECT (do not pursue)
  - the code neither confirms nor refutes it -> NEEDS_USER with is_real=true, never REJECT (its
    **Options:** line names the check that would settle it)
  - architectural == true -> NEEDS_USER (fill its **Options:** and **Recommendation:** lines)
  - clarity == ambiguous with materially different valid fixes -> NEEDS_USER (fill its **Options:** and
    **Recommendation:** lines)
  - size == large OR blast_radius == cross-cutting -> DEFER (too big for an autonomous batch)
  - its **Fix:** line rests on a behavior step 6 left unconfirmed -> NEEDS_USER (its **Options:** line
    names that behavior and the check that would settle it)
  - otherwise -> ACTIONABLE (write ${ROUTED_FIX_LINE})
An alternative that another fix clearly dominates is not a materially different valid fix.

INVENTORY FILE: write ${issueFile(unit.id)} (create ${ISSUES_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} Its format is EXACTLY this:
-----
---
unit: ${unit.id}
hash: ${lensDied ? 'incomplete' : unit.hash}
reviewed: true
---

## Plan: ${unitSlug(unit.id)} - review findings

mode: fix
gate: green
status: todo

(for EACH kept verdict — ACTIONABLE, NEEDS_USER, or DEFER, in that order — one entry:)
### [<finding_id>] <title>

- id: <finding_id>
- status: open
- file: <file>:<line>
- loc: <that file's LOC from UNIT FILES>
- severity: <your confirmed severity>
- category: <category>
${lensLine}- size: <matrix size>
- decision: <ACTIONABLE | NEEDS_USER | DEFER>

**What:** <detail — what's wrong and why it matters${multi ? '' : lenses[0].matters}>
**Evidence:** <what you confirmed: the triggering input, the probe command and its output, or the cited document>
**Fix:** <${TEMPLATE_FIX_LINE}>  (ACTIONABLE; for NEEDS_USER leave the chosen option for the user)
**Options:** <the distinct choices and their tradeoffs>  (NEEDS_USER only)
**Recommendation:** <your suggested direction>           (NEEDS_USER only)
-----
The \`## Plan:\` line, the three preamble lines under it, and every entry's \`- status: open\` are
REQUIRED: without them the file is not a plan the fixer can build. Write the header id exactly as shown. It is
the slug of the unit id, not the unit id.
The \`- file:\` line takes ONE line number. For a range or a list ("840-842, 880"), write its first line (840).
${multi ? "A fold across lenses lists each folded candidate's lens id on its `- lens:` line, comma-separated.\n" : ''}If there are NO kept verdicts, write NO \`## Plan:\` header at all — the file is the clean marker instead:
the frontmatter above, then \`# Review: ${unit.id}\`, then the single line "No issues found."
When you reject at least one candidate, end the file with a \`## Rejected\` heading and one line per
rejection, in the inventory and in the clean marker alike:
\`<finding_id> [<its file:line>] <its title>: <the file:line that refutes it, the id it duplicates, scope-creep, or below-floor>\`.
When you reject none, write no \`## Rejected\` heading.`; };

// =============================================================================
// kind enhancements: structured-output schemas — DECISIONS ONLY (control plane). All prose lives in the
// candidates and proposal files.
// =============================================================================
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

const ENHANCE_VERIFY_SCHEMA = {
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
          defect_split: { type: 'boolean', description: 'true if you kept this candidate and wrote its defect half under `## Defects to route`.' },
          too_risky:    { type: 'boolean', description: 'true if the risk you verified outweighs the cost removed. Always REJECT these, and name the risk.' },
          theme:        { type: 'string', description: 'short grouping keyword so related proposals can be planned together' },
        },
      },
    },
  },
};

// =============================================================================
// kind enhancements: shared prompt fragment
// =============================================================================
const ENHANCE_ENV = `${REPO ? `TARGET REPO: ${REPO}  ` : 'NO TARGET REPO — every scope path below is absolute.  '}(lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
SCOPE — the paths under audit (repo-relative unless absolute). Every proposal targets the scope:
${SCOPE.map((p) => `  - ${p}`).join('\n')}
Files outside the scope may be read and cited as evidence. A proposal may also name a file outside the
scope that its change must touch.
CONVENTIONS / house rules (an enhancement must fit these, or argue explicitly for changing them):
${CONVENTIONS}
${CONVENTION_FILES.length ? `CONVENTION FILES (the project's own rules, which the CONVENTIONS text above indexes. Read each one in full):
${CONVENTION_FILES.map((p) => `  - ${p}`).join('\n')}
` : ''}${GOALS ? `WHAT "BETTER" MEANS HERE (the north star every lens serves):\n${GOALS}\n` : ''}${CONTEXT ? `CONTEXT: ${CONTEXT}\n` : ''}
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
${ENHANCE_ENV}
YOUR LENS: ${lens.focus}
${lens.criteria ? `WHAT TO WEIGH UNDER THIS LENS: ${lens.criteria}\n` : ''}PROCEDURE:
${numberedSteps([
  'Read the WHOLE scope through YOUR LENS, and push it hard. Cross-cutting findings ("every engine re-implements X", "these three roles could be two") are the most valuable thing you can return. Other lenses run in parallel. Do not hedge toward them. Output: your candidates.',
  'Ground each candidate in the code as it is, by the RULES below, and drop each one they reject. Output: each kept candidate with its Today, Instead, Removes, Risk and Evidence.',
  'WRITE the CANDIDATES FILE below when you keep a candidate, or the CLEAN-LENS MARKER below when you keep none. Output: the file.',
  'Return via the schema. Output: candidate_ids, wrote_candidates, wrote_clean_marker and relayed_request.',
])}

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
A clean lens is a normal, good outcome.`;

const enhanceVerifyPrompt = (unit) => `
You are the ENHANCEMENT VERIFIER, read-only on SOURCE: you write exactly one proposal file per lens
below and nothing else.
${ENHANCE_ENV}
YOUR LENSES (judge each lens's candidates under that lens's focus):
${unit.map((m) => `  - LENS ${m.lens.id}: ${m.lens.focus}
      candidates file: ${candidatesFile(m.lens.id)}   (read it in full: every candidate with its evidence)
      candidate ids:   ${m.ids.join(', ')}
      proposal file:   ${proposalFile(m.lens.id)}`).join('\n')}
Judge only the candidate ids listed above. A block of a candidates file whose id is not listed for its
lens gets no verdict and stays out of every proposal file, since the run counts only listed ids.
PROCEDURE:
${numberedSteps([
  'Read each candidates file under YOUR LENSES in full, then the code each listed candidate cites, by the READING RULE below. A candidate\'s Today, Removes and Evidence lines are the finder\'s claims, not facts. Confirm each one against the source it cites before you rely on it. Output: each listed candidate\'s claims, confirmed or refuted.',
  'Apply the REJECT rules below to each candidate, in their order. Output: is_real, is_defect, defect_split and too_risky for each candidate, and the reason for each rejection.',
  'Score each survivor by SCORING below, route every candidate by ROUTING below, and set a short `theme` keyword per verdict. Output: each verdict\'s impact, size, decision and theme.',
  'WRITE each lens\'s PROPOSAL FILE below. Output: each file.',
  'Return via the schema. Output: verdicts, and wrote_lenses with the id of each lens whose proposal file you wrote.',
])}

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
     put the defect half under \`## Defects to route\` and set defect_split=true.
  5. ITS RISK OUTWEIGHS IT. Check the stated risk against the code, and look for one the finder missed.
     A change that would break or weaken something the system needs, or leave ambiguous an instruction
     or contract that must be exact, is rejected unless the cost removed clearly outweighs it. Set
     too_risky=true and REJECT it with a one-line note under \`## Rejected\` naming the risk.

SCORING (each survivor):
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

PROPOSAL FILE: WRITE each lens's proposal file at the path listed with that lens (create ${PROPOSALS_DIR}/ if needed).
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
Do NOT write into any issues/ directory, and do NOT stage or commit.`;

// =============================================================================
// kind defects: fan out reviewer → verifier per unit (read-only, concurrent), then STOP. The main agent supplies
// args.units (gen-units.mjs output it read) and, on resume, the units lacking an issue file or whose hash
// changed, plus each unit the last return's `failed` names for re-review. The engine reviews whatever
// units it is given — there is no loader/scribe/organizer (WORKFLOW-PRINCIPLES.md #4/#6).
// =============================================================================
const auditDefects = async () => {
  const units = A.units;
  if (!Array.isArray(units) || !units.length) {
    throw new Error('review requires a non-empty args.units array (run gen-units.mjs, read it, and pass units — see CLAUDE.md). On resume pass the units lacking an issue file or whose hash changed, plus each unit the last return\'s `failed` names for re-review. Reuse this runId on a resume — gen-units.mjs --issues-dir joins units against runs/<runId>/issues.');
  }
  // One writer per issue file and one plan id per file: fileSafe and unitSlug are lossy, so two unit ids can
  // map to one name and their writers would overwrite each other concurrently.
  const unitByFile = new Map();
  const unitBySlug = new Map();
  for (const u of units) {
    const id = u?.id;
    const fileName = fileSafe(id);
    const planId = unitSlug(id);
    if (unitByFile.has(fileName)) throw new Error(`Issue file collision: unit ids "${unitByFile.get(fileName)}" and "${id}" both map to issue file ${fileName}.md — rename one so each unit has its own issue file`);
    if (unitBySlug.has(planId)) throw new Error(`Plan id collision: unit ids "${unitBySlug.get(planId)}" and "${id}" both map to plan id "${planId}" — rename one so each issue file has its own plan id`);
    unitByFile.set(fileName, id);
    unitBySlug.set(planId, id);
  }
  // Dead reviewers and verifiers, so lost coverage is in the return and never reads as a clean unit (#15).
  const failed = [];
  // The units whose reviewer reported a relayed user request. The first one stops every later lens pass and verifier.
  const relayedWhere = [];
  const totalReviewers = units.reduce((s, u) => s + lensesOf(u).length, 0);
  const lensedUnits = units.filter((u) => u && u.lens).length;
  log(`review: ${units.length} unit(s) → ${ISSUES_DIR} [floor=${REVIEW_SEV_NAME}, changePolicy=${CHANGE_POLICY}, ${totalReviewers} reviewer(s)${A.lens ? `, default lens x${asList(A.lens).length}` : ''}${lensedUnits ? `, ${lensedUnits} unit lens override(s)` : ''}]`);
  log(`spawn ceiling: ≤ ${totalReviewers + units.length} agents (${totalReviewers} reviewer(s) = one per unit x lens, + ≤${units.length} verifiers — verify spawns only where findings exist, ONE per unit however many lenses it ran)`);

  // Read-only fan-out: each unit flows reviewer(s) → verifier independently and concurrently.
  const results = await pipeline(
    units,
    // -- Review: one pass per lens, merged into this unit's single finding set --------------------
    async (unit) => {
      const lenses = lensesOf(unit);
      const paths = reviewFiles(unit, lenses);
      const tags = lenses.map((_, p) => (lenses.length > 1 ? lensTag(p) : ''));
      const sources = [];
      let total = 0;
      let markerWritten = false;
      let lensDied = false;
      for (let p = 0; p < lenses.length; p++) {
        if (relayedWhere.length) break;
        const lens = lenses[p];
        const where = `${unit.id}${lenses.length > 1 ? `/${lens.id}` : ''}`;
        // Only the FINAL lens, with no prior finding and no dead sibling, may write the clean marker: an
        // earlier clean pass that wrote it could be left as the terminal on-disk state if a later pass throws
        // or the run is cut before verify overwrites, and a marker after a dead lens stamps the real hash on
        // a unit that lens never looked at. Resume trusts either file and skips the unit.
        const cleanEligible = total === 0 && p === lenses.length - 1 && !lensDied;
        // `rev`, not `r`: the attestation sweep in tests/static.test.mjs scopes each schema's consumer check
        // to the variable its agent return lands in, and `r` names several callback parameters in this file.
        const rev = await callAgent(reviewPrompt(unit, lens, {
          reviewFile: paths[p], tag: tags[p], prior: sources.map((s) => ({ lens: s.lens.id, path: s.path })), cleanEligible,
        }), roleOpts('review', { schema: REVIEW_SCHEMA, phase: 'Review', label: `review:${where}` }));
        // A DEAD reviewer is not a clean lens: zero findings from it while a surviving sibling lens has some
        // would send the unit to verify and log it as normally processed.
        if (!rev) {
          log(`  ⚠ ${where}: reviewer returned nothing (agent died or produced no output) — this lens contributed NO coverage; re-review this unit`);
          lensDied = true;
          failed.push({ id: unit.id, stage: 'review', lens: lens.id });
          continue;
        }
        if (rev.relayed_request === true) {
          relayedWhere.push(where);
          break;
        }
        // A count with no confirmed file hands the verifier nothing, or an earlier launch's file at that path.
        // A confirmed file with a zero count holds findings that no verifier would be handed.
        const count = rev.finding_count;
        if (!Number.isInteger(count) || count < 0 || (count > 0) !== (rev.wrote_file === true)) {
          log(`  ⚠ ${where}: reviewer returned finding_count ${JSON.stringify(count)} with wrote_file ${JSON.stringify(rev.wrote_file)}, so its count and its review file ${paths[p]} disagree — this lens contributed NO coverage; re-review this unit`);
          // That marker carries the real unit hash, so gen-units --issues-dir reads the unit as unchanged.
          if (cleanEligible && rev.wrote_clean_marker === true) log(`  ⚠ ${where}: the reviewer also says it wrote the clean marker ${issueFile(unit.id)} — resume reads a unit with that marker as unchanged, so pass this unit to the re-review yourself, which replaces the marker`);
          lensDied = true;
          failed.push({ id: unit.id, stage: 'review', lens: lens.id, finding_count: count ?? null, wrote_file: rev.wrote_file ?? null });
          continue;
        }
        if (cleanEligible && rev.wrote_clean_marker) markerWritten = true;   // only the final clean pass writes it
        // No dedup here: a file:category key dropped distinct real defects from a CLOSED inventory. The
        // ALREADY FOUND files steer repeat passes, and the verifier folds true duplicates.
        if (count > 0) {
          sources.push({ lens, path: paths[p], tag: tags[p], count });
          total += count;
        }
      }
      return { unit, sources, total, markerWritten, lensDied };
    },
    // -- Verify + write the unit inventory file — ONLY when the unit has findings -------------------
    async (r) => {
      const { unit, sources, total, markerWritten, lensDied } = r;
      if (relayedWhere.length) return null;
      const ids = sources.flatMap((s) => Array.from({ length: s.count }, (_, i) => findingId(unit, i + 1, s.tag)));
      // Clean unit: no findings ⇒ NO verify spawn. The reviewer already wrote issues/<unit>.md itself.
      if (total === 0) {
        if (markerWritten) log(`  ✓ ${unit.id}: clean (0 findings) — reviewer wrote the marker, verify skipped`);
        else if (lensDied) log(`  ⚠ ${unit.id}: no confirmed findings, but a lens contributed no coverage (logged above) — re-review this unit`);
        else {
          log(`  ⚠ ${unit.id}: clean but the reviewer did NOT write ${issueFile(unit.id)} — resume will re-review it`);
          failed.push({ id: unit.id, stage: 'review', marker: false });
        }
        return { unit: unit.id, file: markerWritten ? issueFile(unit.id) : null, counts: { found: 0, actionable: 0, needs_user: 0, deferred: 0, rejected: 0 }, kept: [] };
      }
      const verify = await callAgent(reviewVerifyPrompt(unit, sources, lensDied), roleOpts('verify', {
        schema: REVIEW_VERIFY_SCHEMA, phase: 'Verify', label: `verify:${unit.id}`,
      }));
      // `wrote_file` is REQUIRED by REVIEW_VERIFY_SCHEMA and instructed in the prompt — read it, or two failures
      // both log as a normal ✓: a verifier that returned verdicts without writing issues/<unit>.md (the
      // ✓ line points at a file that does not exist), and a DEAD verifier, where `verify?.verdicts || []`
      // yields no kept issues at all and this unit's real findings vanish from the returned counts.
      // Same guard as the enhancements kind's verifier.
      const verifyWrote = verify?.wrote_file === true;
      if (!verifyWrote) {
        log(`  ⚠ ${unit.id}: verifier did NOT confirm writing ${issueFile(unit.id)} (${verify ? 'no wrote_file' : `agent returned nothing — its ${total} finding(s) were DROPPED`}) — check the file before triaging and re-review this unit`);
        failed.push({ id: unit.id, stage: 'verify' });
      }
      const known = new Set(ids);
      const counts = { found: total, actionable: 0, needs_user: 0, deferred: 0, rejected: 0 };
      const kept = [];
      const unmatched = [];
      const verdicted = new Set();
      for (const v of (verify?.verdicts || [])) {
        // A repeated verdict id is a miscopy of some other id, and counting it twice inflates the totals.
        if (!known.has(v.finding_id) || verdicted.has(v.finding_id)) { unmatched.push(String(v.finding_id)); continue; }
        verdicted.add(v.finding_id);
        if (!v.is_real || v.decision === 'REJECT') { counts.rejected++; continue; }
        if (v.decision === 'ACTIONABLE') counts.actionable++;
        else if (v.decision === 'NEEDS_USER') counts.needs_user++;
        else counts.deferred++;
        kept.push({ file: String(v.file ?? ''), severity: v.severity, decision: v.decision });
      }
      // A dead verifier is already recorded above. A live one that misses or mis-copies an id leaves a kept
      // finding out of the returned totals, though the issue file still holds it.
      const unverdicted = verify ? ids.filter((id) => !verdicted.has(id)) : [];
      if (unmatched.length || unverdicted.length) {
        log(`  ⚠ ${unit.id}: verifier verdicts do not cover the findings (unmatched: ${unmatched.join(', ') || 'none'}, no verdict: ${unverdicted.join(', ') || 'none'}) — the returned totals are incomplete; read ${issueFile(unit.id)}`);
        failed.push({ id: unit.id, stage: 'verify', unmatched, unverdicted });
      }
      log(`  ✓ ${unit.id}: ${counts.found} found → ${counts.actionable} actionable, ${counts.needs_user} needs-you, ${counts.deferred} deferred, ${counts.rejected} rejected`);
      return { unit: unit.id, file: verifyWrote ? issueFile(unit.id) : null, counts, kept };
    },
  );

  if (relayedWhere.length) {
    throw new Error(`A user request was relayed into the context of the reviewer for ${relayedWhere.join(', ')} ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: ${LAUNCH}.`);
  }
  const processed = results.filter(Boolean);
  const all = processed.flatMap((r) => r.kept);
  const sum = (pred) => all.filter(pred).length;
  const bySeverity = { critical: sum((i) => i.severity === 'critical'), high: sum((i) => i.severity === 'high'), medium: sum((i) => i.severity === 'medium'), low: sum((i) => i.severity === 'low') };

  // Hottest areas (directory) by max severity then count — guidance for the triage conversation.
  const area = (f) => (f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)');
  // Null prototype, so a directory named `constructor` or `__proto__` gets its own entry, not an inherited member.
  const areas = Object.create(null);
  for (const i of all) { const a = area(i.file); (areas[a] ??= { area: a, count: 0, maxSev: 0 }); areas[a].count++; areas[a].maxSev = Math.max(areas[a].maxSev, sevRank(i.severity) ?? 1); }
  const hottest = Object.values(areas).sort((x, y) => y.maxSev - x.maxSev || y.count - x.count).slice(0, 8).map((a) => ({ area: a.area, issues: a.count }));

  // A unit whose only entries carry `unmatched` is triaged from its issue file. Every other failed unit needs
  // a re-review, which rewrites its issue file, so the re-review comes before any triage edit.
  const reReviewIds = [...new Set(failed.filter((f) => !('unmatched' in f)).map((f) => f.id))];
  const triageIds = [...new Set(failed.filter((f) => 'unmatched' in f && !reReviewIds.includes(f.id)).map((f) => f.id))];
  const nextSteps = [
    reReviewIds.length && `First re-review ${reReviewIds.join(', ')}: re-run gen-units.mjs with --issues-dir ${ISSUES_DIR}, then pass as args.units, under this runId, manifest.staleUnits plus each of these units it lacks (workflows/audit/CLAUDE.md, defects playbook step "Resume the review"). Do it before any triage edit, because a re-review rewrites each re-reviewed unit's issue file. To relaunch, ${LAUNCH}.`,
    triageIds.length && `Count the findings of ${triageIds.join(', ')} from their issue files, since those units' verifier verdicts did not match every finding id and the returned totals leave those findings out.`,
    `Present the inventory: read ${ISSUES_DIR}/*.md. The returned inventory, hottest and needsUserFiles cover only the ${processed.length} unit(s) this run reviewed, so after a resume the other issue files hold findings they leave out. Walk the user through totals by severity and decision, the hottest areas, and every NEEDS_USER item (open needsUserFiles for its options + recommendation). This is a scoping conversation.`,
    'Triage by EDITING those files: set a NEEDS_USER item\'s decision to ACTIONABLE and write the chosen option into its Fix line, or flip any decision to SKIP.',
    'Set each issue file\'s developer model with `node <plan-edit.mjs> set <file> <block-id> model=<model>`, where `<plan-edit.mjs>` is `tools/plan-edit.mjs` of the aipg checkout or installed plugin, never of your cwd.',
    'Set `status: skip` on each issue file with no `- decision: ACTIONABLE` entry, or leave that file out of the build.',
    'Confirm the gates are green in the user\'s checkout.',
    `Build the triaged files with develop-cycle.mjs in fix mode, under this run's \`runId\` and \`root\`, and its \`stateDir\` when this run set one, so develop's state dir is this run's state dir. Launch it with the args \`node <plan-edit.mjs> args <the issue files that keep an ACTIONABLE entry> --pack <target.repo> --reserve '${STATE_DIR}'\` prints, where \`--reserve\` reserves develop's launch folder in that state dir (start with one file to sanity-check cost and quality). Each later \`args\` call folds the finished runs' statuses back first.`,
  ];

  return {
    runId: RUN_ID,
    unitsReviewed: processed.filter((r) => !failed.some((f) => f.id === r.unit)).length,
    failed,
    issuesDir: ISSUES_DIR,
    inventory: {
      total: all.length,
      actionable: sum((i) => i.decision === 'ACTIONABLE'),
      needsUser: sum((i) => i.decision === 'NEEDS_USER'),
      deferred: sum((i) => i.decision === 'DEFER'),
      bySeverity,
    },
    hottest,
    // Which files hold items that need a triage decision (open these to present options).
    needsUserFiles: processed.filter((r) => r.counts.needs_user > 0 && r.file !== null).map((r) => r.file),
    nextStep: `${numberedSteps(nextSteps)}\nworkflows/audit/CLAUDE.md §0 "After a defects run" holds each of these steps with its output, and the steps after the build.`,
  };
};

// =============================================================================
// kind enhancements: find per LENS, pack the lenses with candidates into verify units, verify each unit
// (read-only, concurrent), then STOP.
// =============================================================================
const auditEnhancements = async () => {
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
    throw new Error(`A user request was relayed into the context of the finder for ${relayedLensIds.join(', ')} ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: ${LAUNCH}.`);
  }

  // -- Pack: next-fit in lens order, as gen-units packs the defects kind's small units --------------
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
    const verified = await callAgent(enhanceVerifyPrompt(unit.members), roleOpts('verify', {
      schema: ENHANCE_VERIFY_SCHEMA, phase: 'Verify', label: `verify:${lensIds.join('+')}`,
    }));
    // A dead verifier, or one that did not attest a lens's proposal file, leaves that lens unverified: no
    // row puts it in `failed` with no path reported, the one place the operator sees it.
    if (!verified) {
      for (const id of lensIds) log(`  ⚠ ${id}: the verifier DIED — this lens was NOT verified and any ${proposalFile(id)} on disk is unverified. Re-run it.`);
      return;
    }
    const wrote = new Set((Array.isArray(verified.wrote_lenses) ? verified.wrote_lenses : []).map(String));
    // Match every verdict back to a candidate we actually submitted (same guard as the defects kind's verifier):
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
        // A kept candidate whose defect half went under `## Defects to route` counts too, or the file holds a defect no count names.
        defects: mine.filter((x) => x.is_defect === true || x.defect_split === true).length,
        tooRisky: mine.filter((x) => x.too_risky === true).length,
        unjudged: unjudged.length,
      };
      log(`  ✓ ${lens.id}: ${counts.found} candidate(s) → ${counts.adopt} adopt, ${counts.roadmap} roadmap, ${counts.needs_user} needs-user, ${counts.rejected} rejected${counts.defects ? ` (${counts.defects} held DEFECTS → the defects kind, /aipg:debug)` : ''}${counts.tooRisky ? ` (${counts.tooRisky} too risky)` : ''}`);
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
  log(`enhance: ${adopt} adopt, ${roadmap} roadmap, ${needsUser} needs-user across ${live.length} lens(es)${defects ? `; ${defects} candidate(s) held defects (the defects kind, /aipg:debug)` : ''}`);

  return {
    runId: RUN_ID,
    proposalsDir: PROPOSALS_DIR,
    summary: { lenses: live.length, adopt, roadmap, needsUser, rejected: total('rejected'), defects, tooRisky: total('tooRisky'), unjudged: unjudgedTotal },
    // Cross-lens overlap is SIGNAL, not duplication: two lenses landing on the same change independently
    // is the strongest evidence in the run. The engine keeps lens files separate and lets the human see
    // the convergence (matching how brainstorm treats its lenses) — no merge agent (#4/#6).
    lenses: live.map((r) => ({ lens: r.lens, focus: r.focus, file: r.file, counts: r.counts, kept: r.kept })),
    failed,
    nextStep: `${numberedSteps(live.length === 0
      ? [
        `NOTHING was audited: every lens failed: ${failedLabels}. There are no proposals to present — do NOT report a clean audit. Tell the user.`,
        `Re-run those lenses with the same runId. To relaunch, ${LAUNCH}.`,
      ]
      : [
        `Read these proposal files and PRESENT them to the user: ${live.map((r) => r.file).join(', ')}. They hold ${adopt} ADOPT, ${roadmap} ROADMAP and ${needsUser} NEEDS_USER item(s) across ${live.length} lens(es). Present only the listed files: any other file in ${PROPOSALS_DIR}/ is from an earlier run or an agent that did not finish. Present the ADOPT items first (highest impact), then ROADMAP, then every NEEDS_USER with its options + recommendation.`,
        'Call out any change TWO OR MORE lenses landed on independently — that convergence is the strongest signal in the run.',
        unjudgedTotal > 0 && `The verifier returned no verdict for ${unjudgedTotal} candidate(s) (summary.unjudged), so they are in no count: check them in ${unjudgedFiles.join(', ')} before triage.`,
        failed.length && `TELL THE USER these lenses were NOT audited and produced no verified proposal file: ${failedLabels} — offer to re-run just those. Any proposal file on disk for them is not presented until the lens is re-run. To relaunch, ${LAUNCH}.`,
        'Triage with the user. NOTHING here is applied automatically and there is no fix step — the user decides what gets built.',
        'Route the triaged items: adopted items become feature-mode blocks of a plan file, ROADMAP items a section-mode block when they span many call sites (otherwise a feature-mode plan of their own) — refine that file with refine-cycle, then build it with develop-cycle — and every block under a file\'s `## Defects to route` goes to the defects kind (`/aipg:debug`).',
      ])}\nworkflows/audit/CLAUDE.md §0 "After an enhancements run" holds each of these steps with its output, and the steps after the triage.`,
  };
};

return KIND === 'defects' ? await auditDefects() : await auditEnhancements();
