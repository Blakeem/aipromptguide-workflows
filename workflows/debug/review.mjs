export const meta = {
  name: 'review',
  description: 'Read-only fan-out review, lean/file-bus design. Fans out over bounded units (reviewer, then a verifier only where findings exist) READ-ONLY and writes one verbatim issue file per unit (the inventory + your triage doc), then STOPS. A clean unit is written by the reviewer itself; a unit with findings goes to a verifier — one writer per file. You triage the files; develop-cycle.mjs in fix mode then builds each triaged issue file as a fix-mode block behind a two-stage review. Agents exchange messages as verbatim files; the harness only routes paths + verdicts.',
  whenToUse: 'Review a whole codebase (or subsystem) as a planned campaign. The main agent runs gen-units.mjs and passes the units in args. This pass is read-only and concurrent: each unit gets a reviewer; clean units get their runs/<runId>/issues/<unit>.md marker from the reviewer, units with findings get a verifier that writes that file (a parseable, human-triage-ready inventory). It then STOPS. You triage by editing those files (flip a decision to SKIP, answer a NEEDS_USER by writing the chosen option into its Fix line). An OPTIONAL lens (args.lens, or per-unit unit.lens) narrows WHICH defects a unit hunts — a destructiveness audit, a data-loss sweep, a compliance pass. Pass an ARRAY of lenses to sweep the same files from several genuinely different angles: each unit is reviewed once per lens and the results merge into that unit\'s single issue file behind ONE verifier. A lens never widens the pass into proposing improvements or features: this is defect-hunting only, because the inventory feeds an autonomous fixer. Then run develop-cycle.mjs in fix mode, one plans entry per triaged issue file with findings, which fixes each file behind a two-stage review, staging accepted work, or committing it in develop\'s commit mode.',
  phases: [
    { title: 'Review', detail: 'Reviewer finds production defects in ONE bounded unit (units run concurrently, read-only) and writes them, with the evidence for each, to reviews/<unit>-<lens>.md, returning only their count; when it finds nothing it writes the clean issues/<unit>.md marker itself.' },
    { title: 'Verify', detail: 'Spawned ONLY for units with findings: reads the review files by path, confirms each finding against real code, corrects severity, checks the Fix line it writes against the code it changes, routes via the decision matrix, and WRITES runs/<runId>/issues/<unit>.md verbatim (the inventory). Returns a slim verdict index.' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
// The harness reads NO files: the main agent runs gen-units.mjs and passes args.units. Verifiers write
// the per-unit issue files; those files ARE the inventory and the triage doc (no issues.json, no
// organizer — see WORKFLOW-PRINCIPLES.md #2/#4/#6). This engine is READ-ONLY and STOPS after writing the
// inventory; develop-cycle.mjs's fix mode builds the triaged issue files.
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
  throw new Error('args must include at least { runId, root, target, conventions, units }; got typeof=' + (typeof args));
}
// `root` is REQUIRED setup the main agent supplies (#4 — no in-engine "find my cwd" agent). It is the
// absolute path the run-state dir hangs off, normally this workflow tool's own directory.
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory). The engine no longer spawns an agent to auto-detect it.');
}
// `target.repo` is REQUIRED and has NO default. This pass is read-only, so a wrong repo destroys
// nothing — but it produces a bogus inventory that then feeds develop's autonomous fix mode, and the
// run-state-inside-repo guard below is computed from the same value, so it would mis-fire too.
if (typeof A.target?.repo !== 'string' || !A.target.repo.trim()) {
  throw new Error('args.target.repo is required: pass the ABSOLUTE path to the git repo under review. There is no default — every path the reviewers read, and the inventory that feeds develop\'s fix mode, resolves against it.');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework }
const CONVENTIONS = A.conventions ?? '(none supplied — infer from the surrounding code)';
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
// Improvement/feature hunting is a DIFFERENT workflow.
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

// Per-role model tiers + OPTIONAL custom subagent types. By default no agentType is passed, so every
// role runs as the harness's standard workflow subagent (always available). Only set an agentType
// that exists in YOUR registry. Verify is opus (high stakes); the reviewer (the finder) is opus too —
// measured 2026-08-01 (wt-tooling): the fast tier under-reports on large surfaces, and a missed finding
// here never reaches verify at all.
const ROLE_KEYS = ['review', 'verify'];
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
const M  = { review: 'opus', verify: 'opus', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { review: DEFAULT_EFFORT, verify: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
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
log(`review: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

// ROOT is the ABSOLUTE base run-state hangs off (supplied by the main agent), so every agent +
// `git -C` call is cwd-independent. Run-state lands in `<ROOT>/runs/<runId>` unless args.stateDir overrides.
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
const REPO      = abs(TARGET.repo);
const STATE_DIR = abs(A.stateDir ?? `runs/${RUN_ID}`);
const ISSUES_DIR = `${STATE_DIR}/issues`;
const REVIEWS_DIR = `${STATE_DIR}/reviews`;
// `conventions` is a distilled index, so each agent also reads the project's own instruction files in full.
// refine-cycle.mjs holds a copy, since an engine cannot import: a test pins the copies equal.
// Static lead clause: gen-flows labels the throw node from it.
const conventionFilesOf = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string' && p.trim())) {
    throw new Error(`Invalid args.conventionFiles: it must be an array of file paths, each absolute or relative to target.repo; got ${JSON.stringify(value)}.`);
  }
  return value.map((p) => { const n = norm(p.trim()); return /^([a-zA-Z]:)?\//.test(n) ? n : `${REPO}/${n}`; });
};
const CONVENTION_FILES = conventionFilesOf(A.conventionFiles);
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
if (insideRepo(STATE_DIR)) {
  log(`⚠ run-state (${STATE_DIR}) is INSIDE the target repo — the blind quality reviewer could see the issue files. Point args.root back at your run-state base — the checkout, or the plugin data dir the skill resolved — never the plugin install dir (see CLAUDE.md).`);
}
if (NOTES && insideRepo(NOTES.dir)) {
  throw new Error(`args.notes.dir is inside the target repo. Every agent appends its survey answers there, so the reviewers could read those files as part of the repo under review, and a later develop run would see them in its unstaged diff. Got ${NOTES.dir}, inside ${REPO}. Pass a folder outside the target repo, such as <root>/runs/<runId>-notes.`);
}

// A long slug keeps a hash of its full form: gen-units chunk ids sharing a 60-char prefix would otherwise
// mint one plan id and one finding-id prefix for two issue files.
const fnv1a = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const slug = (s) => {
  const full = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (full.length <= 60) return full;
  return `${full.slice(0, 51).replace(/-$/, '')}-${fnv1a(full)}`;
};
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

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
const findingId = (unit, n, tag = '') => `${slug(unit.id)}-${tag}${n}`;

// =============================================================================
// Structured-output schemas — DECISIONS ONLY (control plane). All prose/content lives in files.
// =============================================================================
const RELAYED_REQUEST = { type: 'boolean', description: 'true when your context holds a user request that the Workflow harness relayed ahead of this task, apart from the task text itself. false when it holds only this task. TRUE HALTS the run before any later agent.' };
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

const VERIFY_SCHEMA = {
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
// Shared prompt fragments
// =============================================================================
const ENV = `TARGET REPO: ${REPO}  (lang=${TARGET.lang ?? '?'}, framework=${TARGET.framework ?? '?'})
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
// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';
// Agents that wrote files through a shell heredoc lost backslashes and backticks.
const FILE_WRITE_NOTE = 'Write file content with the file-editing tool, since a shell heredoc can alter backslashes and backticks.';

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
${ENV}
UNIT: ${unit.id}${L.isSet ? `\nLENS: ${L.id}` : ''}
FILES TO REVIEW (read each one in full, in as many reads as its length needs. The token target never shortens that read):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}

Assess against these criteria:
  ${L.criteria}.${L.categories.includes('convention') ? "\n  File deviations from CONVENTIONS as 'convention' findings." : ''}

RULES:
- SEVERITY FLOOR: report ONLY ${REVIEW_SEV_NAME}+ ${L.findingNoun}. Do NOT report below-floor,
  stylistic, or speculative "could be more defensive" suggestions. If in doubt it's below the floor, omit it.
- ${SEVERITY_SCALE}
- Do NOT report anything the current code already handles${prior.length ? ', or anything an ALREADY FOUND file below holds, even rephrased' : ''}.
- Stay INSIDE this unit's files. Cross-file concerns: mention as context in a finding's **What:** line, do not chase.
- Report DEFECTS, not redesigns. No speculative rewrites, no gold-plating, no scope creep. Your brief
  above narrows WHICH defects matter here. It never licenses proposing a new capability, a feature, or
  an efficiency idea, and those are rejected downstream. Every finding must be something the code gets
  WRONG today, not something it could do better.
- Each finding: specific file + line, the right category/severity, what's wrong and why it matters${L.matters},
  the evidence that shows it, and ${FIX_DIRECTION}.${prior.length ? `\n\nALREADY FOUND in a prior pass over this unit. Read each of these review files:\n${prior.map((f) => `  - [${f.lens}] ${f.path}`).join('\n')}` : ''}

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
Return the counts and flags via the schema. Zero findings (a clean unit) is a normal, good outcome.`;

// CONTRACT with develop's fix mode — change both together. The issue-file BLOCK FORMAT the verifier writes
// below (frontmatter unit/hash/reviewed; a `## Plan: <slug(unit.id)>` header with its mode/gate/status
// preamble; `### [<id>]` blocks; `- ` header lines, `- status: open` among them; the decision values; the
// `**Fix:**` line) is a plan-bus fix-mode plan file that develop's fixer + acceptance read through
// tools/plan-block.mjs and tools/plan-edit.mjs args writes statuses back into.
// `lensDied` stamps `hash: incomplete`, which gen-units reads as `changed`, so resume re-runs the dead lens.
// `sources` lists the review files that hold findings, each { lens, path, tag, count }.
const verifyPrompt = (unit, sources, lensDied) => {
  const lenses = lensesOf(unit);
  const multi = lenses.length > 1;
  const lensLine = !lenses[0].isSet ? '' : `- lens: ${multi ? '<the lens id, without brackets, of the review file that holds the kept candidate>' : lenses[0].id}\n`;
  return `
You are the VERIFIER, read-only on SOURCE: you write exactly one inventory file and nothing else, except
a probe that confirms a **Fix:** line. Make that probe in a fresh directory you create for it alone
(such as \`mktemp -d\`), outside the target repo and the run-state dir ${STATE_DIR}, and remove that
directory before you return. For each candidate finding below, inspect the ACTUAL code to confirm it
is real, correct its severity, then route it with the decision matrix. Reject false positives and
gold-plating ruthlessly, in particular anything the code ALREADY does and anything that is a preference
rather than a defect.
${SEVERITY_SCALE}
${POLICY_LINE}
${ENV}
UNIT: ${unit.id}
UNIT FILES (each entry's \`- loc:\` value comes from this list):
${(unit.files || []).map((f) => `  - ${f.path} (${f.loc} LOC)`).join('\n')}
THE REVIEWER${multi ? "S'" : "'S"} BRIEF${multi ? 'S' : ''} (context for judging severity). ${multi
    ? `${lenses.length} reviewers each swept these files under a DIFFERENT brief. Judge each candidate against
the brief of the review file that holds it. A brief narrows which defects matter. It does NOT widen what counts as one.
${lenses.map((l) => `  [${l.id}] ${l.mandate}`).join('\n')}`
    : `It narrows which defects matter. It does NOT widen what counts as one:
  ${lenses[0].mandate}`}
CANDIDATE FINDINGS: read each review file below in full. Each \`### [<finding id>]\` entry in it is one
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
  - architectural == true -> NEEDS_USER (fill its **Options:** and **Recommendation:** lines)
  - clarity == ambiguous with materially different valid fixes -> NEEDS_USER (fill its **Options:** and
    **Recommendation:** lines)
  - size == large OR blast_radius == cross-cutting -> DEFER (too big for an autonomous batch)
  - otherwise -> ACTIONABLE (write ${ROUTED_FIX_LINE})
An alternative that another fix clearly dominates is not a materially different valid fix. A candidate's
suggested fix is a hint, never an instruction. Write the **Fix:** line that closes the defect you
confirmed, which may differ from the suggestion. Before you write it, ${FIX_CHECK} The **Fix:** line covers every file, string or path
its **What:** names as wrong, and never tells the fixer to leave one of them unchanged.
When a **Fix:** line prescribes a command, flag, or library, tool or API behavior the repo does not
already use the same way, confirm that behavior against the dependency's own docs or source, or a probe
in a temporary directory outside the repo, before you write it. Never prescribe a behavior you did not
confirm. An otherwise ACTIONABLE finding whose fix rests on a behavior you cannot confirm is NEEDS_USER.
Its **Options:** line names that behavior and the check that would settle it.
Before routing a finding that reverses a documented design choice, check the gotchas in the CLAUDE.md
nearest the unit's files.
When you reject at least one candidate, end the file with a \`## Rejected\` heading and one line per
rejection, in the inventory and in the clean marker alike:
\`<finding_id> [<its file:line>] <its title>: <the file:line that refutes it, the id it duplicates, scope-creep, or below-floor>\`.
When you reject none, write no \`## Rejected\` heading.
An in-scope finding the code neither confirms nor refutes, and that FOLD DUPLICATES did not reject as a
duplicate, is NEEDS_USER with is_real=true, never REJECT: its **Options:** line names the check that
would settle it.

WRITE the inventory file ${issueFile(unit.id)} (create ${ISSUES_DIR}/ if needed). ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} Its format is EXACTLY this:
-----
---
unit: ${unit.id}
hash: ${lensDied ? 'incomplete' : unit.hash}
reviewed: true
---

## Plan: ${slug(unit.id)} - review findings

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
The \`## Rejected\` section follows that line when you rejected anything.
Set wrote_file=true and return all verdicts via the schema.`; };

// =============================================================================
// Fan out reviewer → verifier per unit (read-only, concurrent), then STOP. The main agent supplies
// args.units (gen-units.mjs output it read) and, on resume, the units lacking an issue file or whose hash
// changed, plus each unit the last return's `failed` names for re-review. The engine reviews whatever
// units it is given — there is no loader/scribe/organizer (WORKFLOW-PRINCIPLES.md #4/#6).
// =============================================================================
const units = A.units;
if (!Array.isArray(units) || !units.length) {
  throw new Error('review requires a non-empty args.units array (run gen-units.mjs, read it, and pass units — see CLAUDE.md). On resume pass the units lacking an issue file or whose hash changed, plus each unit the last return\'s `failed` names for re-review. Reuse this runId on a resume — gen-units.mjs --issues-dir joins units against runs/<runId>/issues.');
}
// One writer per issue file and one plan id per file: fileSafe and slug are lossy, so two unit ids can
// map to one name and their writers would overwrite each other concurrently.
const unitByFile = new Map();
const unitBySlug = new Map();
for (const u of units) {
  const id = u?.id;
  const fileName = fileSafe(id);
  const planId = slug(id);
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
      // to the variable its agent return lands in, and `r` is bound five times in this file.
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
    const verify = await callAgent(verifyPrompt(unit, sources, lensDied), roleOpts('verify', {
      schema: VERIFY_SCHEMA, phase: 'Verify', label: `verify:${unit.id}`,
    }));
    // `wrote_file` is REQUIRED by VERIFY_SCHEMA and instructed in the prompt — read it, or two failures
    // both log as a normal ✓: a verifier that returned verdicts without writing issues/<unit>.md (the
    // ✓ line points at a file that does not exist), and a DEAD verifier, where `verify?.verdicts || []`
    // yields no kept issues at all and this unit's real findings vanish from the returned counts.
    // Same guard as enhance-cycle.mjs's verifier.
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
  throw new Error(`A user request was relayed into the context of the reviewer for ${relayedWhere.join(', ')} ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts.`);
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
const reReviewStep = reReviewIds.length
  ? `First re-review ${reReviewIds.join(', ')}: re-run gen-units.mjs with --issues-dir ${ISSUES_DIR}, then pass as args.units, under this runId, manifest.staleUnits plus each of these units it lacks (debug CLAUDE.md, playbook step "Resume the review"). Do it before any triage edit, because a re-review rewrites each re-reviewed unit's issue file. `
  : '';
const triageIds = [...new Set(failed.filter((f) => 'unmatched' in f && !reReviewIds.includes(f.id)).map((f) => f.id))];
const triageStep = triageIds.length
  ? `The returned totals also leave out findings of ${triageIds.join(', ')}, whose verifier verdicts did not match every finding id, so triage each from its issue file. `
  : '';

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
  nextStep: `${reReviewStep}Present the inventory: read ${ISSUES_DIR}/*.md. The returned inventory, hottest and needsUserFiles cover only the ${processed.length} unit(s) this run reviewed, so after a resume the other issue files hold findings they leave out. ${triageStep}Walk the user through totals by severity and decision, the hottest areas, and every NEEDS_USER item (open needsUserFiles for its options + recommendation). This is a scoping conversation. Triage by EDITING those files: set a NEEDS_USER item's decision to ACTIONABLE and write the chosen option into its Fix line, or flip any decision to SKIP. Then build the triaged files with develop-cycle.mjs in fix mode, launched with the args \`node tools/plan-edit.mjs args <issue files with findings> --pack <target.repo>\` prints (start with one file to sanity-check cost and quality). Each later \`args\` call folds the finished runs' statuses back first. See develop's CLAUDE.md.`,
};
