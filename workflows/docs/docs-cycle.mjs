export const meta = {
  name: 'docs-cycle',
  description: 'Documentation curation, lean/file-bus design: fan out ONE gatherer per source (web / repo / local files) that COPIES the docs the brief needs VERBATIM into a folder — selection and subtraction happen at capture, never paraphrase — a SCRUBBER cleans each WEB source in place (capture junk only: nav fragments, widgets, broken markup; repo and files sources skip it), then a CURATOR reads the whole set, organizes and splits it, deletes what the brief does not need, writes INDEX.md, and checks cross-source consistency + coverage, and finally spot-checks a bounded sample of files against their cited sources; coverage holes and files needing recapture (including a failed spot-check) become id-tagged Coverage-notes entries that drive a bounded gap-fill round, in which ONE gatherer fills every gap and scrubs its own web captures, and each recapture is spot-checked before the file it replaces is deleted. There is NO claim-verifier AGENT: verbatim capture removes the paraphrase gap a verifier would exist to check, and the one sample that tests that promise lives inside the curator. The harness only routes paths + counts; every doc lives in files.',
  whenToUse: 'Provision the local doc set a project needs to build against — an API integration (the official reference), an upgrade (release notes + migration guide + current docs), a complex feature touching several systems. The main agent frames the BRIEF (what the docs are FOR, versions in scope) + the SOURCES with the user, then runs this engine; the deliverable is the folder itself (verbatim docs + INDEX.md) — the ideal input to a plan file that refine-cycle converges and develop-cycle builds. For a synthesized ANSWER to a question use the deep-research skill; to DECIDE among options use decide-cycle.',
  phases: [
    { title: 'Gather', detail: 'Round 1: one gatherer per source (CONCURRENT). Each copies its brief-relevant slice VERBATIM into <outDir>/<source>/ — one file per page/topic, each with a source header (URL or path, version, retrieval date). Subtraction at capture: skip nav, marketing, other versions, features the brief does not touch. Returns thin counts. A gap-fill round: ONE gatherer reads the Coverage-notes entry of every gap in INDEX.md by path, captures each gap into <outDir>/<gap id>/, and scrubs its own web captures under the scrub rules.' },
    { title: 'Scrub', detail: 'Round 1 only: one scrubber per WEB source (pipelined off its gather — no barrier); repo and files sources skip it, their captures usually being markdown already with no HTML chrome. Cleans the source dir IN PLACE: removes capture junk (nav/menu fragments, cookie banners, feedback widgets, broken markup), fixes mangled markdown formatting, changes no words, keeps source headers. Unsure → keep; the curator judges relevance.' },
    { title: 'Curate', detail: 'One curator reads the WHOLE set: organizes + splits at heading boundaries (text moves verbatim), deletes what the brief does not need (outDir is a dedicated, engine-owned folder for THIS doc set — anything it finds there that is neither a source-headed capture for this set (this or an earlier run) nor a curator-written file is left alone and reported), writes INDEX.md (one line per file + Coverage notes holding cross-source inconsistencies and one id-tagged entry per open gap, naming the file, the source and the reason), spot-checks each recapture against its source before deleting the file it replaces, then spot-checks up to fidelitySample files against the source cited in their own header. Gaps it returns as { kind, id } (missing coverage, or a recapture — wrong version, failed spot-check) spawn a bounded gap-fill Gather round (maxRounds).' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
// Docs is a PROVISION workflow: the deliverable is the folder itself, so content is copied, split, and
// deleted — never rewritten (#2/#11/#13). That also eliminates the claim-verifier by construction: a
// verifier exists to catch the gap between a gatherer's PARAPHRASE and its source, and verbatim capture
// leaves no such gap. What remains checkable — coverage vs. the brief and CROSS-SOURCE consistency —
// needs the whole set at once, so it lives in the curator (#4: no separate checker re-reading the same
// files). A SCRUB pass per round-1 WEB source between gather and curate strips mechanical capture junk
// (haiku); repo and files sources skip it, a gap-fill gatherer scrubs its own captures, and relevance
// deletion stays with the curator. There is NO review
// loop — a provision workflow is happy-path (Scope: the user judges); the bounded gap loop is the only
// feedback.
// The one thing verbatim capture ASSERTS and nothing tested is that the files really are the source's
// own words, so the curator ends its turn (after the index is safely written) by comparing a bounded
// sample — fidelitySample, default 3 — against the sources those files cite; a failure re-enters the
// gap loop as a recapture. Sampled evidence, not a new role (#4), and it degrades to 0 checked when a
// source is unreachable rather than failing the run.
// The engine writes ONLY inside outDir (default: run-state) and never touches, stages, or
// commits any repo. outDir is ENGINE-OWNED and must be a FRESH directory dedicated to ONE doc set: the
// curator deletes freely inside it (that whole-set authority is what makes cross-source dedup and
// re-curation work), so pre-existing hand-authored docs must not live there. The curator leaves content
// that is neither a source-headed capture for this set (this or an earlier run) nor a curator-written
// file in place and reports it (foreign_content) — a signal that outDir was pointed at a shared folder,
// not a guard that makes one safe.
// The main agent frames the brief + sources + a dedicated outDir with the user BEFOREHAND (#4).
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
  throw new Error('args must include at least { runId, root, sources, brief|planPath }; got typeof=' + (typeof args));
}
if (!A.root) {
  throw new Error('args.root is required: pass the ABSOLUTE path the run-state should hang off (normally this workflow tool\'s own directory).');
}

const RUN_ID      = A.runId;
const TARGET      = A.target ?? {};                         // { repo, lang, framework } — OPTIONAL (for repo sources)
// Static lead clause: gen-flows labels the throw node from it. No coercion: Number('') is a finite 0,
// and fidelitySample: 0 is legal (spot-check off), so a coerced '' would silently skip the spot-check.
const num = (v, name, min, dflt, max = 1_000_000) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid numeric arg: args.${name} must be a number between ${min} and ${max}; got ${JSON.stringify(v)}. It is not coerced — a bound that absorbs garbage produces a zero-round run, or silently disables the fidelity spot-check, and reports either as an ordinary result.`);
  }
  return Math.floor(v);
};
const MAX_ROUNDS  = num(A.maxRounds, 'maxRounds', 1, 2, 50);    // curate passes: the initial one + gap-fill rounds
const TESTBED     = A.testbed ?? '';                        // OPTIONAL: how agents may empirically verify claims (e.g. read-only curl against a live API)
const FIDELITY_N  = num(A.fidelitySample, 'fidelitySample', 0, 3);     // files the curator spot-checks against their cited source (0 disables)

// Per-role model tiers + OPTIONAL custom subagent types. Docs work is simple next to code — every role
// defaults to a fast tier: gather + curate copy/organize/judge (sonnet); scrub strips junk (haiku).
const ROLE_KEYS = ['gather', 'scrub', 'curate'];
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
const M  = { gather: 'sonnet', scrub: 'haiku', curate: 'sonnet', ...roleMap('models', A.models, VALID_MODELS) };
const EF = { gather: DEFAULT_EFFORT, scrub: DEFAULT_EFFORT, curate: DEFAULT_EFFORT, ...roleMap('efforts', A.efforts, VALID_EFFORTS) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], effort: EF[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });
log(`docs: roles ${ROLE_KEYS.map((r) => `${r}=${M[r]}/${EF[r]}`).join(', ')}`);

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
const slug        = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const REPO        = TARGET.repo ? abs(TARGET.repo) : '';
const STATE_DIR   = abs(A.stateDir ?? `runs/${RUN_ID}`);
const OUT_DIR     = A.outDir ? abs(A.outDir) : `${STATE_DIR}/docs`;  // the curated set — a FRESH dir dedicated to this one set (usually <project>/docs/<system>/), created if missing; the curator deletes freely inside it
const INDEX_FILE  = `${OUT_DIR}/INDEX.md`;

// The brief: what the docs are FOR — the single source of truth (#11) that decides relevance, read
// verbatim (#2) by every agent. Either a plan-mode file (planPath) or an inline string. Inline is for
// SHORT briefs only — it is interpolated into every prompt; a long brief belongs in planPath (linked).
const PLAN_PATH   = A.planPath ? abs(A.planPath) : '';
const BRIEF       = (!PLAN_PATH && A.brief) ? String(A.brief) : '';
if (!PLAN_PATH && !BRIEF) {
  throw new Error('Provide the brief: either planPath (a framing file) or brief (an inline string of what the project needs these docs for — task, systems touched, versions in scope).');
}
const B_REF       = PLAN_PATH ? `the brief at ${PLAN_PATH} (read it verbatim — the task, systems, and versions in scope)` : `the brief below:\n-----\n${BRIEF}\n-----`;

// Sources — the doc sets to pull, one gatherer each. Accept strings (treated as web sources) or
// { id, kind, focus }. kind ∈ web | repo | files ("docs"/"source" accepted as legacy aliases).
const normKind = (k) => { const v = k === 'docs' ? 'files' : k; return ['web', 'repo', 'files'].includes(v) ? v : 'web'; };
const SOURCES = (Array.isArray(A.sources) ? A.sources : []).map((s, i) => {
  if (typeof s === 'string') return { id: slug(s) || `source-${i + 1}`, kind: 'web', focus: s };
  const focus = s.focus || s.id || '';
  return { id: slug(s.id || focus) || `source-${i + 1}`, kind: normKind(s.kind ?? s.source), focus };
}).filter((s) => s.focus);
if (!SOURCES.length) {
  throw new Error('args.sources is required: a non-empty array of doc sets to pull — strings (web sources) or { id, kind: "web"|"repo"|"files", focus }. The main agent frames these with the user beforehand (#4).');
}
const dupes = [...new Set(SOURCES.map((s) => s.id).filter((id, i, a) => a.indexOf(id) !== i))];
if (dupes.length) {
  throw new Error(`source ids collide after slugging (${dupes.join(', ')}): two gatherers would write into the same directory — give each source a distinct id.`);
}
// Every source id used this run. A gap-fill id is slugged from the curator's gap id, which repeats when a
// gap is carried to a later round and can slug to a round-1 source id, so a counter disambiguates it.
const usedIds = new Set(SOURCES.map((s) => s.id));

// Per-kind how-to-capture guidance handed to the gatherer (the only thing that varies by kind).
const KIND_GUIDE = {
  web:   'Fetch the OFFICIAL documentation pages for the version in scope (for an external API, its official reference), preferring primary sources over blogs/forums.',
  repo:  `Copy the relevant docs/READMEs/reference material from the repo at ${REPO || '(no repo configured — this source needs target.repo)'}, READ-ONLY. Cite the file path (and line range for extracts) in each header.`,
  files: 'Copy from the local doc set your source names; cite each source file path in the header.',
};

// =============================================================================
// Schemas — DECISIONS/COUNTS ONLY (control plane, #8). The docs ARE the files. A gap is a kind and the
// id of its Coverage-notes entry, which holds its file, source and reason for the gatherer to read.
// =============================================================================
const RELAYED_REQUEST = { type: 'boolean', description: 'true when your context holds a user request that the Workflow harness relayed ahead of this task, apart from the task text itself. false when it holds only this task. TRUE HALTS the run before any later agent.' };
const GATHER_SCHEMA = {
  type: 'object',
  required: ['files_written', 'relayed_request'],
  properties: {
    relayed_request: RELAYED_REQUEST,
    files_written: { type: 'integer', description: 'doc files you created under the directories you were given' },
    skipped:       { type: 'integer', description: 'pages/sections skipped as irrelevant to the brief (0 if none)' },
    missing_entries: { type: 'array', items: { type: 'string' }, description: 'gap-fill only: the gap ids with no Coverage-notes entry, which you skipped ([] if none)' },
  },
};

const SCRUB_SCHEMA = {
  type: 'object',
  required: ['files_cleaned'],
  properties: {
    files_cleaned: { type: 'integer', description: 'files you cleaned in place (0 if the dir was already clean)' },
  },
};

const CURATE_SCHEMA = {
  type: 'object',
  required: ['wrote_index', 'files', 'inconsistencies', 'gaps', 'fidelity_checked', 'foreign_content'],
  properties: {
    wrote_index:     { type: 'boolean' },
    files:           { type: 'integer', description: 'doc files in the final set (excluding INDEX.md)' },
    deleted:         { type: 'integer', description: 'files/sections removed as irrelevant or duplicate (0 if none)' },
    inconsistencies: { type: 'integer', description: 'cross-source conflicts recorded in Coverage notes' },
    fidelity_checked:  { type: 'integer', description: 'files you compared against their cited source (0 is valid)' },
    fidelity_failures: { type: 'integer', description: 'of those, how many were not a verbatim copy (0 if none), each also returned as a recapture gap' },
    foreign_content:   { type: 'boolean', description: 'true ONLY if the out dir holds content that is neither a source-headed capture for this doc set (from this run or an earlier run into this out dir) nor a curator-written file such as INDEX.md. You must NOT delete that content' },
    foreign_paths:     { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'paths of that content ([] when foreign_content is false)' },
    gaps: {
      type: 'array',
      maxItems: 6,
      description: 'holes a NEW gather could fix — missing coverage, or a file needing recapture (paraphrased, wrong version); [] when the set covers the brief; judgment calls belong in Coverage notes, not here',
      items: {
        type: 'object',
        required: ['kind', 'id'],
        properties: {
          kind: { type: 'string', enum: ['web', 'repo', 'files'] },
          id:   { type: 'string', description: 'the id of the gap\'s entry in the Coverage notes of the index, which names the file, the source and the reason' },
        },
      },
    },
  },
};

// =============================================================================
// Shared fragment + role prompts
// =============================================================================
// A relaunch into the same outDir finds the earlier launch's files, and the Write tool refuses to overwrite
// a file the agent has not read. An agent that ignores the refusal reports a file it never wrote.
const REPLACE_NOTE = "The file may hold an earlier launch's text, so Read it first, if it exists, and then replace its entire content.";
const WROTE_NOTE = 'A write the tool rejected has not written the file, so report a file as written (a wrote flag true, a count of files written, or the path or id of a file returned) only after the tool reported success.';
// Agents that wrote files through a shell heredoc lost backslashes and backticks.
const FILE_WRITE_NOTE = 'Write file content with the file-editing tool, since a shell heredoc can alter backslashes and backticks.';
// Named fragments so the scrubber, which judges no relevance, can take the rules without the brief.
const BRIEF_LINE = `PROJECT BRIEF (what the docs are FOR, so it decides relevance): ${B_REF}`;
const VERBATIM_RULE = `VERBATIM RULE: doc content is COPIED, SPLIT, and DELETED — never rewritten, paraphrased, or summarized.
Converting HTML to clean markdown is fine (keep headings, tables, and code blocks whole); changing the
words is not. Brevity comes from leaving irrelevant content OUT, never from compressing what you keep.
Every doc file starts with a source header: source (URL, or file path/range, or doc#section), version,
retrieval date.`;
const WRITE_BOUNDARY = `Write ONLY inside ${OUT_DIR}; do NOT touch any repo, stage, or commit.`;
const ENV = `${BRIEF_LINE}\n${VERBATIM_RULE}\n${WRITE_BOUNDARY}`;

// The testbed may carry a credential — least-privilege: it is handed ONLY to the roles that verify
// (gather, curate), never to the scrubber, whose prompt would persist the secret for no purpose.
const TESTBED_ENV = TESTBED ? `
TESTBED — verify claims EMPIRICALLY where you can: ${TESTBED}
Claims from NON-OFFICIAL sources (forums, blogs, Q&A) are hypotheses: verify each against the testbed
BEFORE recording it, and record the exact command + response excerpt VERBATIM next to the claim. What
you cannot verify, mark UNVERIFIED or leave out. Official docs are captured as-is. Treat the testbed strictly READ-ONLY.` : '';

const gatherPrompt = (src) => `
You are a DOC GATHERER building a local documentation set for a coding LLM. Cover YOUR source
thoroughly; other gatherers cover the others.
${ENV}${TESTBED_ENV}
YOUR SOURCE: ${src.focus}
KIND: ${src.kind} — ${KIND_GUIDE[src.kind] || KIND_GUIDE.web}

PROCEDURE:
1. Find everything in your source the brief needs. Skip at capture: navigation, marketing, other
   versions, features the brief does not touch.
2. Copy what you keep VERBATIM into ${OUT_DIR}/${src.id}/ (create it): one kebab-case .md file per
   page/topic, each with its source header. ${REPLACE_NOTE} Replace it only when it
   starts with a source header. Otherwise leave it and write under another name.
   ${WROTE_NOTE} ${FILE_WRITE_NOTE}
Return files_written + skipped via the schema.`;

// Shared by the round-1 scrubber and the gap-fill gatherer, which scrubs its own captures.
const SCRUB_RULES = `DELETE ONLY capture junk: leftover navigation/menu/breadcrumb fragments, cookie/consent banners,
feedback/share/"was this helpful" widgets, marketing blocks, broken image/link remnants, stray HTML tags,
duplicated headings, excess blank lines. Fix mangled markdown FORMATTING (tables, code fences) without
touching the words. Keep every source header intact. Unsure whether something is doc content → KEEP it;
the curator judges relevance.`;

const scrubPrompt = (src) => `
You are a DOC SCRUBBER cleaning freshly captured docs for a coding LLM. Edit every .md file in
${OUT_DIR}/${src.id}/ IN PLACE. ${FILE_WRITE_NOTE}
${VERBATIM_RULE}
${WRITE_BOUNDARY}
${SCRUB_RULES}
Return files_cleaned via the schema.`;

// One agent fills every gap of a round. Each gap's directive lives in its Coverage-notes entry, read by path.
const gapGatherPrompt = (gaps) => `
You are the GAP-FILL DOC GATHERER for a documentation set built for a coding LLM. The curator found the
gaps below. Fill every one of them.
${ENV}${TESTBED_ENV}
YOUR GAPS: each one is an entry under its id in the Coverage notes of ${INDEX_FILE}. Read each entry
first: it names the file to recapture (or none), the source to capture from and the reason. A gap
whose id has no entry gets no capture: never guess its source, and list its id in missing_entries.
${gaps.map((g) => `  - ${g.gapId} (${g.kind}): write its captures into ${OUT_DIR}/${g.id}/`).join('\n')}
HOW TO CAPTURE, BY KIND:
${[...new Set(gaps.map((g) => g.kind))].map((k) => `  - ${k}: ${KIND_GUIDE[k]}`).join('\n')}

PROCEDURE, for each gap:
1. Capture from the source its entry names what its reason says is missing or wrong. Skip at capture:
   navigation, marketing, other versions, features the brief does not touch.
2. Copy what you keep VERBATIM into that gap's directory (create it): one kebab-case .md file per
   page/topic, each with its source header. ${REPLACE_NOTE} Replace it only when it
   starts with a source header. Otherwise leave it and write under another name.
3. SCRUB each web capture in place once it is written, under these rules:
${SCRUB_RULES}
${WROTE_NOTE} ${FILE_WRITE_NOTE}
Return files_written + skipped via the schema, summed over every gap, and missing_entries.`;

// The Coverage-notes entry a gap travels as. The gap-fill gatherer reads it, and the next curator keeps it.
const gapEntry = (round) => `### [gap-r${round}-<n>] <short title>
- kind: <web | repo | files>
- file: <the captured file to recapture, or none for missing coverage>
- source: <the URL, repo path or local doc to capture from>
- reason: <what the brief needs that no file covers, or why the file fails: wrong version, failed spot-check>`;

const curatePrompt = (round, newDirs) => `
You are the CURATOR of the documentation set at ${OUT_DIR}. Read every file, then make the folder the
best working set for a coding LLM on this brief.
${ENV}${TESTBED_ENV}
${round > 1 ? `This is curate round ${round}: the gap-fill gatherer added files to the already curated +
indexed set. Re-read the whole set, integrate the new files, and rewrite the index in full. This round's
gap-fill captures were written under: ${newDirs.join(', ')}\n` : ''}If ${INDEX_FILE} already exists
(an earlier round, or an earlier run into this folder, wrote it), READ the previous ${INDEX_FILE} before
you rewrite it: its Coverage notes hold one id'd entry per gap, and an entry whose file line names a
file is a recapture (a failed fidelity check or a wrong version).
RECAPTURE CHECK: before you delete a file that a newer capture recaptures, open the source cited in the
NEW capture's own header and compare ONE substantive passage (a code block, or a parameter/field table)
word for word, and count the check in fidelity_checked. A recapture that matches: DELETE the superseded
file and drop it from the index. A reworded, condensed or reordered recapture fails: count it in
fidelity_failures, delete the failed recapture, keep the superseded file, and return its gap again. When
the source cannot be reached, keep both files, leave the check out of the count, and say so in the gap's
entry.
A gap that no newer capture fills stays open: keep its entry and return it again under the same id.

YOUR FOLDER: ${OUT_DIR} is dedicated to THIS doc set. Everything in it is either a source-headed capture
made for this doc set (by this run's gatherers or by an earlier run into this folder), or a file a
curator wrote (${INDEX_FILE}). Inside it you have FULL delete authority: delete freely to serve the brief.
SAFETY CATCH: if you nonetheless find content under ${OUT_DIR} that is clearly NEITHER (no source header
and unrelated to any source, hand-authored notes, an unrelated project's docs), the folder is not
dedicated to this set. Do NOT delete, move, split, or rewrite that content: leave it exactly as it is,
list its paths under Coverage notes, and return foreign_content=true with foreign_paths. Everything else
stays under your full authority.

JOBS (in order):
1. ORGANIZE: consistent kebab-case names, grouped by topic. SPLIT any file too big for one focused read
   at heading boundaries, carrying the source header into every part. DELETE files and sections the
   brief does not need, and exact duplicates (keep the more authoritative source).
2. CHECK — as you read, record: (a) INCONSISTENCIES between sources — version mismatches, contradicting
   statements — citing both files; when the fix is recapturing a source (e.g. the wrong version was
   pulled), return it as a gap; (b) GAPS — things the brief needs that no file covers.
3. INDEX — write ${INDEX_FILE}. ${REPLACE_NOTE} ${WROTE_NOTE} ${FILE_WRITE_NOTE} It holds one line per file (path — what it covers — when to read it), then a
   "Coverage notes" section holding the inconsistencies (with citations) and one entry per open gap, in
   this format (the gap-fill gatherer reads the entry as its directive, so name the source precisely):
${gapEntry(round)}
   Number this round's new gaps in sequence, the first one past the highest <n> any entry of the
   ${INDEX_FILE} on disk when your turn began uses under gap-r${round}- (from 1 when none does).${FIDELITY_N > 0 ? ` A gap the
   FIDELITY SPOT-CHECK adds continues that sequence.` : ''} Keep the id of a gap carried from an earlier round.
${FIDELITY_N > 0 ? `4. FIDELITY SPOT-CHECK: LAST, after the index is written. Test on a sample that the files are the
   source's OWN WORDS. ${round > 1 ? `This round,
   pick ONLY from the files this round's gap-fill gatherer captured: the files under the directories named
   above when your turn began, wherever ORGANIZE then moved them, apart from a recapture the RECAPTURE
   CHECK already compared. The order below applies inside that
   pool. If the pool is empty, sample nothing and say why in Coverage notes.
   ` : ''}Pick up to ${FIDELITY_N} captured file(s), preferring first any file that reads as
   paraphrase/summary or lacks a source header, then files captured from a repo/local path (an exact,
   nearly free local read), then the largest and least official web files. For each, open the source
   cited in its OWN header and compare ONE substantive passage (a code block, or a parameter/field
   table) word for word.
   A reworded, condensed, or reordered passage is a FAILURE: rewrite ${INDEX_FILE} with a gap entry for
   it added to Coverage notes, naming the file, the source and the failure, and return it as a
   { kind, id } recapture gap.
   If a source cannot be reached (no web access, path gone), do NOT guess and do NOT fail: skip it, leave
   it out of the count, and say so in Coverage notes. fidelity_checked: 0 is a valid, honest answer.
` : `The sample spot-check is disabled for this run, so fidelity_checked counts only RECAPTURE CHECK comparisons.\n`}Return via the schema: wrote_index, files, deleted, inconsistencies, fidelity_checked,
fidelity_failures, foreign_content (+ foreign_paths), and gaps as { kind, id } (ONLY what a fresh gather
could fix, each with its entry in Coverage notes).`;

// =============================================================================
// [GATHER → SCRUB] ⇄ CURATE — round 1 pipelines gather→scrub per source (a web source is scrubbed as soon
// as its gather lands, no barrier; repo and files sources skip the scrub); the curate barrier is genuine
// (consistency + coverage need the WHOLE set); curator-returned gaps drive a bounded gap-fill round, whose
// one gatherer carries every gap and scrubs its own web captures.
// =============================================================================
phase('Gather');
log(`docs: ${SOURCES.length} source(s) [${SOURCES.map((s) => s.kind).join(', ')}] → curated set at ${OUT_DIR} (max ${MAX_ROUNDS} round(s))`);
if (SOURCES.some((s) => s.kind === 'repo') && !REPO) log(`  ⚠ a "repo" source was given but no target.repo — that gatherer has nothing to read.`);

let curate = null;
const failed = [];   // { id: source or gap dir id, stage: 'gather' | 'scrub' } per agent that returned nothing, across rounds
const fidelity = { checked: 0, failures: 0 };   // summed over rounds: a gap-fill curator samples only its own captures
// A curator that repeats a gap id would send two directories after one entry, so the first one wins.
const gapsOf = (gaps) => {
  const seen = new Set();
  return (Array.isArray(gaps) ? gaps : []).filter((g) => {
    const id = g && typeof g.id === 'string' ? g.id.trim() : '';
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};
let toGather = SOURCES;
let rounds = 0;
// The gatherers that reported a relayed user request. The first one stops every later scrubber.
const relayedSourceIds = [];
// A run launched inside a user turn relays that message to every agent, so the first gatherers stop it before the curator.
const haltIfRelayed = () => {
  if (relayedSourceIds.length) {
    throw new Error(`A user request was relayed into the context of the gatherer for ${relayedSourceIds.join(', ')} ahead of its task. The Workflow runtime does this when the run is launched inside a user turn, and it relays the message to every agent. Relaunch from a notification turn, as the root CLAUDE.md rule "Launch from a notification turn" says: start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts.`);
  }
};

while (rounds < MAX_ROUNDS) {
  rounds++;

  if (rounds === 1) {
    // -- Gather → Scrub (pipelined per source) ------------------------------------
    const gathered = await pipeline(
      toGather,
      (src) => callAgent(gatherPrompt(src), roleOpts('gather', {
        schema: GATHER_SCHEMA, phase: 'Gather', label: `gather:${src.id}`,
      })).then((g) => {
        if (!g) {
          failed.push({ id: src.id, stage: 'gather' });
          log(`  ⚠ gather:${src.id} returned nothing (agent skipped or died) — files it wrote, if any, are still curated (and scrubbed first for a web source); re-run this source if coverage is thin`);
        } else {
          if (g.relayed_request === true) relayedSourceIds.push(src.id);
          log(`  ✓ gathered ${src.id}: ${g.files_written ?? 0} file(s)${g.skipped ? `, ${g.skipped} skipped` : ''}`);
        }
        return { src, g };
      }),
      (prev) => {
        if (relayedSourceIds.length) return prev;   // halts after the pipeline, and a scrubber would read the relayed request too
        if (prev.src.kind !== 'web') return prev;   // repo/files captures are usually markdown already, with no HTML chrome
        if (prev.g && (prev.g.files_written ?? 0) === 0) return prev;   // gather REPORTED zero captures
        // g == null → the gatherer died before returning; files it already wrote are on disk — scrub them.
        return callAgent(scrubPrompt(prev.src), roleOpts('scrub', {
          schema: SCRUB_SCHEMA, phase: 'Scrub', label: `scrub:${prev.src.id}`,
        })).then((s) => {
          // Scrub is auxiliary: the curator still indexes what the gatherer wrote, so a death is logged and
          // recorded in failed, never reported as a success line.
          if (!s) {
            failed.push({ id: prev.src.id, stage: 'scrub' });
            log(`  ⚠ scrub:${prev.src.id} returned nothing (agent skipped or died) — that source's captured files were NOT scrubbed, so nav chrome/ads may survive into the set; re-run this source or clean them by hand.`);
          } else {
            log(`  ✓ scrubbed ${prev.src.id}: ${s.files_cleaned ?? 0} file(s)`);
          }
          return prev;
        });
      },
    );
    haltIfRelayed();
    const results = gathered.filter(Boolean);
    const empty = results.filter((d) => d.g && (d.g.files_written ?? 0) === 0).length;
    const died  = toGather.length - results.filter((d) => d.g).length;
    if (empty === toGather.length) {
      throw new Error('Every source reported zero doc files — nothing to curate. Check the sources/brief (and web access for web sources) and re-run.');
    }
    if (empty) log(`  ⚠ ${empty} source(s) reported no files this round`);
    if (died) log(`  ⚠ ${died} gatherer(s) died before returning — anything they wrote is on disk and still gets curated (and scrubbed first for a web source)`);
  } else {
    // -- Gap-fill gather: one agent for every gap of the round -------------------------
    const filled = await callAgent(gapGatherPrompt(toGather), roleOpts('gather', {
      schema: GATHER_SCHEMA, phase: 'Gather', label: `gather:r${rounds}`,
    }));
    if (!filled) {
      for (const s of toGather) failed.push({ id: s.id, stage: 'gather' });
      log(`  ⚠ gather:r${rounds} returned nothing (agent skipped or died) — the gap-fill gatherer died before returning; anything it wrote is on disk and still gets curated, and its gaps may stay open: ${toGather.map((s) => s.gapId).join(', ')}`);
    } else {
      if (filled.relayed_request === true) relayedSourceIds.push(`gap-fill r${rounds}`);
      log(`  ✓ gap-fill gathered ${toGather.length} gap(s): ${filled.files_written ?? 0} file(s)${filled.skipped ? `, ${filled.skipped} skipped` : ''}`);
      if ((filled.files_written ?? 0) === 0) log(`  ⚠ the gap-fill gatherer reported no files this round`);
      const missing = (Array.isArray(filled.missing_entries) ? filled.missing_entries : []).filter(Boolean);
      if (missing.length) log(`  ⚠ no Coverage-notes entry in ${INDEX_FILE} for gap(s) ${missing.join(', ')} — nothing was captured for them`);
    }
  }

  haltIfRelayed();

  // -- Curate (barrier: reads the whole set) ------------------------------------
  // A dead gatherer is survivable (its writes are on disk, above); a dead curator is not — it is the
  // only role that organizes, splits and indexes, and `gaps: []` from a null would look like "complete,
  // zero gaps" and exit the loop into a success-shaped return with no set behind it.
  const newDirs = toGather.map((s) => `${OUT_DIR}/${s.id}/${s.gapId ? ` (gap ${s.gapId})` : ''}`);
  const c = await callAgent(curatePrompt(rounds, newDirs), roleOpts('curate', {
    schema: CURATE_SCHEMA, phase: 'Curate', label: `curate:r${rounds}`,
  }));
  if (!c) throw new Error(`Curator returned nothing in round ${rounds} (agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  curate = c;
  const returnedCount = Array.isArray(curate.gaps) ? curate.gaps.length : 0;
  const gaps = gapsOf(curate.gaps);
  if (gaps.length < returnedCount) log(`  ⚠ ignored ${returnedCount - gaps.length} gap(s) with a blank or repeated id — check the Coverage notes in ${INDEX_FILE}`);
  const fidChecked = curate?.fidelity_checked ?? 0;
  const fidFailed  = curate?.fidelity_failures ?? 0;
  fidelity.checked += fidChecked;
  fidelity.failures += fidFailed;
  log(`  ✓ curated r${rounds}: ${curate?.files ?? '?'} file(s)${curate?.deleted ? `, ${curate.deleted} deleted` : ''}, ${curate?.inconsistencies ?? 0} inconsistency(ies)${FIDELITY_N > 0 || fidChecked > 0 ? `, fidelity ${Math.max(0, fidChecked - fidFailed)}/${fidChecked}` : ''}, ${gaps.length} gap(s)`);
  if (FIDELITY_N > 0 && fidChecked === 0) log(`  ⚠ no file was checked against its source this round — the verbatim promise is unverified; see Coverage notes for why`);
  if (fidFailed) log(`  ⚠ ${fidFailed} file(s) failed the verbatim check — returned as recapture gap(s)`);

  if (!gaps.length) break;
  if (rounds >= MAX_ROUNDS) {
    log(`  ⚠ ${gaps.length} gap(s) remain at maxRounds — left open in Coverage notes`);
    break;
  }
  toGather = gaps.map((g, i) => {
    const gapId = g.id.trim();
    const base = slug(gapId) || `gap-r${rounds}-${i + 1}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return { id, kind: normKind(g.kind), gapId };
  });
  log(`  ↻ gap-fill round ${rounds + 1}: ${toGather.map((s) => s.gapId).join(', ')}`);
}

if (!curate?.wrote_index) log(`  ⚠ curator did not confirm writing ${INDEX_FILE} — check it exists before relying on the set.`);

// outDir is meant to be a fresh directory dedicated to THIS doc set (the curator deletes freely inside
// it). If the curator found content that is neither a source-headed capture for this set nor a
// curator-written file, the operator pointed at a shared folder — it was left untouched, but say so
// loudly: the next run against this outDir may not be so lucky.
const foreignPaths = (curate?.foreign_paths ?? []).filter(Boolean);
const foreignFound = curate?.foreign_content === true;
if (foreignFound) {
  log(`  ⚠⚠ ${OUT_DIR} is NOT a dedicated folder: the curator found content that is neither a source-headed capture for this set nor a curator-written file (left in place, NOT deleted):`);
  for (const p of foreignPaths) log(`       - ${p}`);
  if (!foreignPaths.length) log(`       (the curator reported no paths — inspect the folder yourself)`);
  log(`     Point outDir at a fresh directory per doc set before re-running.`);
}

const failedGatherIds = failed.filter((f) => f.stage === 'gather').map((f) => f.id);
const failedScrubIds = failed.filter((f) => f.stage === 'scrub').map((f) => f.id);
const degradedWarning = failed.length
  ? `WARN THE USER FIRST: ${[
    failedGatherIds.length ? `these gatherers returned nothing, so coverage may be partial: ${failedGatherIds.join(', ')}` : '',
    failedScrubIds.length ? `these sources' files were NOT scrubbed, so nav chrome or ads may remain: ${failedScrubIds.join(', ')}` : '',
  ].filter(Boolean).join('. ')}. `
  : '';
const foreignWarning = foreignFound
  ? `WARN THE USER FIRST: ${OUT_DIR} held ${foreignPaths.length || 'some'} file(s)/folder(s) that are neither a source-headed capture for this set (this or an earlier run) nor a curator-written file (${foreignPaths.join(', ') || 'paths not reported'}). They were left alone, but outDir must be a fresh directory dedicated to one doc set — move that content out or pick a different outDir before re-running. `
  : '';
const fileCount = curate?.files ?? 0;
const inconsistencyCount = curate?.inconsistencies ?? 0;
const unresolvedGaps = gapsOf(curate?.gaps).length;

return {
  runId: RUN_ID,
  outDir: OUT_DIR,
  index: INDEX_FILE,
  files: fileCount,
  rounds,
  inconsistencies: inconsistencyCount,
  fidelity,
  indexWritten: curate?.wrote_index === true,
  foreignContent: foreignFound,
  foreignPaths,
  unresolvedGaps,
  failed,
  stateDir: STATE_DIR,
  nextStep: `${degradedWarning}${curate?.wrote_index === true ? '' : `WARN THE USER FIRST: the curator did not confirm writing ${INDEX_FILE} — verify it exists before relying on the set. `}${foreignWarning}Present the set (${fileCount} file(s), ${inconsistencyCount} cross-source inconsistency(ies), ${unresolvedGaps} unresolved gap(s)): read ${INDEX_FILE} (including Coverage notes) and relay what was gathered, any cross-source inconsistencies, unresolved gaps, and the fidelity spot-check result (${fidelity.checked} file(s) compared against their source across all ${rounds} curate round(s), ${fidelity.failures} failed, each failure returned as a recapture gap) — a low or zero check count means the verbatim promise went untested, not that it held. ${A.outDir ? '' : `The set lives in gitignored run-state — copy ${OUT_DIR}/ into the project (or re-run with outDir) if it should persist. `}Point the working agent or plan at the INDEX. Nothing is staged or committed.`,
};
