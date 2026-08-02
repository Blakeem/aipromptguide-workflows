export const meta = {
  name: 'docs-cycle',
  description: 'Documentation curation, lean/file-bus design: fan out ONE gatherer per source (web / repo / local files) that COPIES the docs the brief needs VERBATIM into a folder — selection and subtraction happen at capture, never paraphrase — a SCRUBBER cleans each source in place (capture junk only: nav fragments, widgets, broken markup), then a CURATOR reads the whole set, organizes and splits it, deletes what the brief does not need, writes INDEX.md, and checks cross-source consistency + coverage, and finally spot-checks a bounded sample of files against their cited sources; coverage holes and files needing recapture (including a failed spot-check) drive a bounded gap-fill gather round. There is NO claim-verifier AGENT: verbatim capture removes the paraphrase gap a verifier would exist to check, and the one sample that tests that promise lives inside the curator. The harness only routes paths + counts; every doc lives in files.',
  whenToUse: 'Provision the local doc set a project needs to build against — an API integration (the official reference), an upgrade (release notes + migration guide + current docs), a complex feature touching several systems. The main agent frames the BRIEF (what the docs are FOR, versions in scope) + the SOURCES with the user, then runs this engine; the deliverable is the folder itself (verbatim docs + INDEX.md) — the ideal input to a feature-cycle/migrate-cycle plan. For a synthesized ANSWER to a question use the deep-research skill; to DECIDE among options use decide-cycle.',
  phases: [
    { title: 'Gather', detail: 'One gatherer per source (CONCURRENT). Each copies its brief-relevant slice VERBATIM into <outDir>/<source>/ — one file per page/topic, each with a source header (URL or path, version, retrieval date). Subtraction at capture: skip nav, marketing, other versions, features the brief does not touch. Returns thin counts.' },
    { title: 'Scrub', detail: 'One scrubber per source (pipelined off its gather — no barrier). Cleans the source dir IN PLACE: removes capture junk (nav/menu fragments, cookie banners, feedback widgets, broken markup), fixes mangled markdown formatting, changes no words, keeps source headers. Unsure → keep; the curator judges relevance.' },
    { title: 'Curate', detail: 'One curator reads the WHOLE set: organizes + splits at heading boundaries (text moves verbatim), deletes what the brief does not need (outDir is a dedicated, engine-owned folder for THIS doc set — anything it finds there that this run neither captured nor wrote is left alone and reported), writes INDEX.md (one line per file + Coverage notes holding cross-source inconsistencies and open gaps), then spot-checks up to fidelitySample files against the source cited in their own header. Gaps it returns (missing coverage, or a recapture — wrong version, failed spot-check) spawn a bounded gap-fill Gather round (maxRounds).' },
  ],
};

// =============================================================================
// Config — everything project-specific arrives via args so the engine stays general.
// Docs is a PROVISION workflow: the deliverable is the folder itself, so content is copied, split, and
// deleted — never rewritten (#2/#11/#13). That also eliminates the claim-verifier by construction: a
// verifier exists to catch the gap between a gatherer's PARAPHRASE and its source, and verbatim capture
// leaves no such gap. What remains checkable — coverage vs. the brief and CROSS-SOURCE consistency —
// needs the whole set at once, so it lives in the curator (#4: no separate checker re-reading the same
// files). A per-source SCRUB pass between gather and curate strips mechanical capture junk (haiku);
// relevance deletion stays with the curator. There is NO review loop — a provision workflow is
// happy-path (Scope: the user judges); the bounded gap loop is the only feedback.
// The one thing verbatim capture ASSERTS and nothing tested is that the files really are the source's
// own words, so the curator ends its turn (after the index is safely written) by comparing a bounded
// sample — fidelitySample, default 3 — against the sources those files cite; a failure re-enters the
// gap loop as a recapture. Sampled evidence, not a new role (#4), and it degrades to 0 checked when a
// source is unreachable rather than failing the run.
// The engine writes ONLY inside outDir (default: run-state) and never touches, stages, or
// commits any repo. outDir is ENGINE-OWNED and must be a FRESH directory dedicated to ONE doc set: the
// curator deletes freely inside it (that whole-set authority is what makes cross-source dedup and
// re-curation work), so pre-existing hand-authored docs must not live there. The curator leaves content
// it neither captured nor wrote in place and reports it (foreign_content) — a signal that outDir was
// pointed at a shared folder, not a guard that makes one safe.
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
// A non-numeric bound must THROW, never coerce. `round < 'three'` is false on the first test, so the
// round loop would never run and the engine would hand back a zero-agent run as an ordinary result. The
// same coercion silently turned a bad `fidelitySample` into 0 — which reads as "spot-check disabled" and
// leaves the verbatim promise asserted but never tested. A documented default is not a licence to accept
// garbage.
// Nothing is COERCED: `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite. That
// matters most for `fidelitySample`, where 0 is a LEGAL value meaning "spot-check disabled" — so a
// coercing check turned `fidelitySample: ''` into a silently untested verbatim promise, which is the
// exact failure this guard exists to stop. The message leads with a STATIC clause because
// tools/gen-flows.mjs labels a throw node with the first clause of its static prefix.
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
const M  = { gather: 'sonnet', scrub: 'haiku', curate: 'sonnet', ...(A.models ?? {}) };
const AT = { ...(A.agentTypes ?? {}) };
const roleOpts = (role, extra) => ({ model: M[role], ...(AT[role] ? { agentType: AT[role] } : {}), ...extra });

const ROOT        = String(A.root).replace(/\\/g, '/').replace(/\/+$/, '');
const norm        = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
const abs         = (p) => { const n = norm(p); return (ROOT && !/^([a-zA-Z]:)?\//.test(n)) ? `${ROOT}/${n}` : n; };
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
// Every source id ever used this run — gap-fill ids are slugged from CURATOR PROSE, so they can collide
// with each other or with a round-1 id. Those are not operator errors, so they are disambiguated with a
// counter (below) rather than thrown on: one gatherer per directory is the invariant that matters.
const usedIds = new Set(SOURCES.map((s) => s.id));

// Per-kind how-to-capture guidance handed to the gatherer (the only thing that varies by kind).
const KIND_GUIDE = {
  web:   'Fetch the OFFICIAL documentation pages for the version in scope (primary sources over blogs/forums; an external API means its official reference). One file per page/topic.',
  repo:  `Copy the relevant docs/READMEs/reference material from the repo at ${REPO || '(no repo configured — this source needs target.repo)'} — READ-ONLY; cite the file path (and line range for extracts) in each header.`,
  files: 'Copy from the local doc set the focus names; cite each source file path in the header.',
};

// =============================================================================
// Schemas — DECISIONS/COUNTS ONLY (control plane, #8). The docs ARE the files. A gap is a routing
// directive (spawn a gather for this), not content — its rationale lives in Coverage notes.
// =============================================================================
const GATHER_SCHEMA = {
  type: 'object',
  required: ['files_written'],
  properties: {
    files_written: { type: 'integer', description: 'doc files you created under your source directory' },
    skipped:       { type: 'integer', description: 'pages/sections judged irrelevant to the brief and not captured (0 if none)' },
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
    fidelity_checked:  { type: 'integer', description: 'files you compared against their cited source — 0 is a valid answer (source unreachable / nothing checkable); say so in Coverage notes' },
    fidelity_failures: { type: 'integer', description: 'of those, how many were paraphrase/summary rather than a verbatim copy (0 if none) — each also returned as a recapture gap' },
    foreign_content:   { type: 'boolean', description: 'true ONLY if the out dir holds content that is neither a capture from this run\'s sources nor a file you wrote — i.e. it is not a dedicated directory for this doc set. You must NOT delete that content' },
    foreign_paths:     { type: 'array', maxItems: 20, items: { type: 'string' }, description: 'paths of that content, so the operator can move it; [] when foreign_content is false' },
    gaps: {
      type: 'array',
      maxItems: 6,
      description: 'holes a NEW gather could fix — missing coverage, or a file needing recapture (paraphrased, wrong version); [] when the set covers the brief; judgment calls belong in Coverage notes, not here',
      items: {
        type: 'object',
        required: ['kind', 'focus'],
        properties: {
          kind:  { type: 'string', enum: ['web', 'repo', 'files'] },
          focus: { type: 'string', description: 'one targeted gather directive, precise enough to act on alone' },
        },
      },
    },
  },
};

// =============================================================================
// Shared fragment + role prompts
// =============================================================================
const ENV = `PROJECT BRIEF (what the docs are FOR — it decides what is relevant): ${B_REF}
VERBATIM RULE: doc content is COPIED, SPLIT, and DELETED — never rewritten, paraphrased, or summarized.
Converting HTML to clean markdown is fine (keep headings, tables, and code blocks whole); changing the
words is not. Brevity comes from leaving irrelevant content OUT (subtraction), never from compressing
what you keep. Every doc file starts with a source header: source (URL, or file path/range, or
doc#section), version, retrieval date.
Write ONLY inside ${OUT_DIR}; do NOT touch any repo, stage, or commit.`;

// The testbed may carry a credential — least-privilege: it is handed ONLY to the roles that verify
// (gather, curate), never to the scrubber, whose prompt would persist the secret for no purpose.
const TESTBED_ENV = TESTBED ? `
TESTBED — verify claims EMPIRICALLY where you can: ${TESTBED}
Claims from NON-OFFICIAL sources (forums, blogs, Q&A) are hypotheses: verify each against the testbed
BEFORE recording it, and record the exact command + response excerpt VERBATIM next to the claim — a
measurement beats an argument, and it lets the next reader re-run it. What you cannot verify, mark
UNVERIFIED or leave out. Official docs are captured as-is. Treat the testbed strictly READ-ONLY.` : '';

const gatherPrompt = (src) => `
You are a DOC GATHERER building a local documentation set for a coding LLM. You capture; you do not
author. Cover YOUR source thoroughly; other gatherers cover the others.
${ENV}${TESTBED_ENV}
YOUR SOURCE: ${src.focus}
KIND: ${src.kind} — ${KIND_GUIDE[src.kind] || KIND_GUIDE.web}

PROCEDURE:
1. Find everything in your source the brief needs. Skip at capture: navigation, marketing, other
   versions, features the brief does not touch.
2. Copy what you keep VERBATIM into ${OUT_DIR}/${src.id}/ (create it) — one kebab-case .md file per
   page/topic, each with its source header, code examples whole.
Return files_written + skipped via the schema (the docs themselves are the files).`;

const scrubPrompt = (src) => `
You are a DOC SCRUBBER making freshly captured docs clean reading for a coding LLM. Edit every .md file
in ${OUT_DIR}/${src.id}/ IN PLACE — remove junk, change no words.
${ENV}
DELETE ONLY capture junk: leftover navigation/menu/breadcrumb fragments, cookie/consent banners,
feedback/share/"was this helpful" widgets, marketing blocks, broken image/link remnants, stray HTML tags,
duplicated headings, excess blank lines. Fix mangled markdown FORMATTING (tables, code fences) without
touching the words. Keep every source header intact. Unsure whether something is doc content → KEEP it;
the curator judges relevance.
Return files_cleaned via the schema.`;

const curatePrompt = (round) => `
You are the CURATOR of the documentation set at ${OUT_DIR} — its librarian, not its author. Read every
file, then make the folder the best working set for a coding LLM on this brief.
${ENV}${TESTBED_ENV}
${round > 1 ? `This is curate round ${round}: the set was already curated + indexed once, then gap-fill
gathers added files. Re-read the whole set, integrate the new files, and rewrite the index in full.\n` : ''}
YOUR FOLDER: ${OUT_DIR} is a dedicated, engine-owned directory for THIS doc set. Everything in it is
either a capture this run's gatherers made from its sources, or a file you yourself wrote. Inside it you
have FULL delete authority — delete freely to serve the brief; whole-set judgment is what makes
cross-source dedup and re-curation work.
SAFETY CATCH: if you nonetheless find content under ${OUT_DIR} that is clearly NEITHER of those two
things — no source header and unrelated to any source, hand-authored notes, an unrelated project's docs
— then the operator pointed the engine at a folder that is not dedicated to this set. Do NOT delete,
move, split, or rewrite that content: leave it exactly as it is, list its paths under Coverage notes,
and return foreign_content=true with foreign_paths. Everything else stays under your full authority.

JOBS (in order):
1. ORGANIZE — consistent kebab-case names, grouped by topic; SPLIT any file too big for one focused read
   at heading boundaries (move the text verbatim; carry the source header into every part); DELETE files
   and sections the brief does not need, and exact duplicates (keep the more authoritative source).
2. CHECK — as you read, record: (a) INCONSISTENCIES between sources — version mismatches, contradicting
   statements — citing both files; when the fix is recapturing a source (e.g. the wrong version was
   pulled), return it as a gap; (b) GAPS — things the brief needs that no file covers.
3. INDEX — write ${INDEX_FILE}: one line per file (path — what it covers — when to read it), then a
   "Coverage notes" section holding the inconsistencies (with citations) and any gaps left open.
${FIDELITY_N > 0 ? `4. FIDELITY SPOT-CHECK — LAST, after the index is written (the curated set must already be safe on
   disk). The whole set's value is that it is the source's OWN WORDS; nothing has tested that yet, so
   test it on a sample instead of asserting it. Pick up to ${FIDELITY_N} captured file(s), preferring in
   this order: any file that read as paraphrase/summary or lacks a source header; files captured from a
   repo/local path (the cited path is a local read — exact and nearly free); then the largest and least
   official web files. For each, open the source cited in its OWN header and compare ONE substantive
   passage word for word — a code block, or a parameter/field table.
   A passage that has been reworded, condensed, or reordered is a FAILURE: name the file + the source in
   Coverage notes and return it as a { kind, focus } recapture gap.
   If a source cannot be reached (no web access, path gone) do NOT guess and do NOT fail: skip it, leave
   it out of the count, and say so in Coverage notes — fidelity_checked: 0 is a valid, honest answer.
   Return fidelity_checked + fidelity_failures.
` : `Fidelity spot-checking is disabled for this run (fidelitySample: 0) — return fidelity_checked: 0.\n`}Return via the schema: wrote_index, files, deleted, inconsistencies, fidelity_checked,
fidelity_failures, foreign_content (+ foreign_paths), and gaps — ONLY gaps a fresh gather could actually
fix, each { kind, focus } actionable on its own ([] when coverage is adequate).`;

// =============================================================================
// [GATHER → SCRUB] ⇄ CURATE — gather→scrub pipelines per source (a source is scrubbed as soon as its
// gather lands, no barrier); the curate barrier is genuine (consistency + coverage need the WHOLE set);
// curator-returned gaps drive a bounded gap-fill round.
// =============================================================================
phase('Gather');
log(`docs: ${SOURCES.length} source(s) [${SOURCES.map((s) => s.kind).join(', ')}] → curated set at ${OUT_DIR} (max ${MAX_ROUNDS} round(s))`);
if (SOURCES.some((s) => s.kind === 'repo') && !REPO) log(`  ⚠ a "repo" source was given but no target.repo — that gatherer has nothing to read.`);

let curate = null;
let toGather = SOURCES;
let rounds = 0;

while (rounds < MAX_ROUNDS) {
  rounds++;

  // -- Gather → Scrub (pipelined per source) ------------------------------------
  if (toGather.length) {
    const gathered = await pipeline(
      toGather,
      (src) => agent(gatherPrompt(src), roleOpts('gather', {
        schema: GATHER_SCHEMA, phase: 'Gather', label: `gather:${src.id}`,
      })).then((g) => {
        log(`  ✓ gathered ${src.id}: ${g?.files_written ?? 0} file(s)${g?.skipped ? `, ${g.skipped} skipped` : ''}`);
        return { src, g };
      }),
      (prev) => {
        if (prev.g && (prev.g.files_written ?? 0) === 0) return prev;   // gather REPORTED zero captures
        // g == null → the gatherer died before returning; files it already wrote are on disk — scrub them.
        return agent(scrubPrompt(prev.src), roleOpts('scrub', {
          schema: SCRUB_SCHEMA, phase: 'Scrub', label: `scrub:${prev.src.id}`,
        })).then((s) => {
          // A dead scrubber and one that found nothing to clean both collapsed onto the `?? 0` sentinel,
          // so `✓ scrubbed <id>: 0 file(s)` was byte-identical either way — and no scrub field reaches the
          // return, so the death was recorded NOWHERE. Scrub is an AUXILIARY role (its death cannot stop
          // the run: what the gatherer wrote is on disk and the curator still indexes it), so its death
          // policy is log + record — never a success line.
          if (!s) log(`  ⚠ scrub:${prev.src.id} returned nothing (agent skipped or died) — that source's captured files were NOT scrubbed, so nav chrome/ads may survive into the set; re-run this source or clean them by hand.`);
          else log(`  ✓ scrubbed ${prev.src.id}: ${s.files_cleaned ?? 0} file(s)`);
          return prev;
        });
      },
    );
    const results = gathered.filter(Boolean);
    const empty = results.filter((d) => d.g && (d.g.files_written ?? 0) === 0).length;
    const died  = toGather.length - results.filter((d) => d.g).length;
    if (rounds === 1 && empty === toGather.length) {
      throw new Error('Every source reported zero doc files — nothing to curate. Check the sources/brief (and web access for web sources) and re-run.');
    }
    if (empty) log(`  ⚠ ${empty} source(s) reported no files this round`);
    if (died) log(`  ⚠ ${died} gatherer(s) died before returning — anything they wrote is on disk and still gets scrubbed + curated`);
  }

  // -- Curate (barrier: reads the whole set) ------------------------------------
  // A dead gatherer is survivable (its writes are on disk, above); a dead curator is not — it is the
  // only role that organizes, splits and indexes, and `gaps: []` from a null would look like "complete,
  // zero gaps" and exit the loop into a success-shaped return with no set behind it.
  const c = await agent(curatePrompt(rounds), roleOpts('curate', {
    schema: CURATE_SCHEMA, phase: 'Curate', label: `curate:r${rounds}`,
  }));
  if (!c) throw new Error(`Curator returned nothing in round ${rounds} (agent skipped or died). Re-invoke with the same args (same runId); pass the Workflow tool's resumeFromRunId to replay completed agents from cache.`);
  curate = c;
  const gaps = (curate?.gaps ?? []).filter((g) => g && g.focus);
  const fidChecked = curate?.fidelity_checked ?? 0;
  const fidFailed  = curate?.fidelity_failures ?? 0;
  log(`  ✓ curated r${rounds}: ${curate?.files ?? '?'} file(s)${curate?.deleted ? `, ${curate.deleted} deleted` : ''}, ${curate?.inconsistencies ?? 0} inconsistency(ies)${FIDELITY_N > 0 ? `, fidelity ${Math.max(0, fidChecked - fidFailed)}/${fidChecked}` : ''}, ${gaps.length} gap(s)`);
  if (FIDELITY_N > 0 && fidChecked === 0) log(`  ⚠ no file was checked against its source this round — the verbatim promise is unverified; see Coverage notes for why`);
  if (fidFailed) log(`  ⚠ ${fidFailed} file(s) failed the verbatim check — returned as recapture gap(s)`);

  if (!gaps.length) break;
  if (rounds >= MAX_ROUNDS) {
    log(`  ⚠ ${gaps.length} gap(s) remain at maxRounds — left open in Coverage notes`);
    break;
  }
  toGather = gaps.map((g, i) => {
    const base = slug(g.focus) || `gap-r${rounds + 1}-${i + 1}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return { id, kind: normKind(g.kind), focus: g.focus };
  });
  log(`  ↻ gap-fill round ${rounds + 1}: ${toGather.map((s) => s.id).join(', ')}`);
}

if (!curate?.wrote_index) log(`  ⚠ curator did not confirm writing ${INDEX_FILE} — check it exists before relying on the set.`);

// outDir is meant to be a fresh directory dedicated to THIS doc set (the curator deletes freely inside
// it). If the curator found content it neither captured nor wrote, the operator pointed at a shared
// folder — it was left untouched, but say so loudly: the next run against this outDir may not be so lucky.
const foreignPaths = (curate?.foreign_paths ?? []).filter(Boolean);
const foreignFound = curate?.foreign_content === true;
if (foreignFound) {
  log(`  ⚠⚠ ${OUT_DIR} is NOT a dedicated folder: the curator found content it neither captured nor wrote (left in place, NOT deleted):`);
  for (const p of foreignPaths) log(`       - ${p}`);
  if (!foreignPaths.length) log(`       (the curator reported no paths — inspect the folder yourself)`);
  log(`     Point outDir at a fresh directory per doc set before re-running.`);
}

return {
  phase: 'docs',
  runId: RUN_ID,
  outDir: OUT_DIR,
  index: INDEX_FILE,
  files: curate?.files ?? 0,
  rounds,
  inconsistencies: curate?.inconsistencies ?? 0,
  fidelity: { checked: curate?.fidelity_checked ?? 0, failures: curate?.fidelity_failures ?? 0 },
  indexWritten: curate?.wrote_index === true,
  foreignContent: foreignFound,
  foreignPaths,
  unresolvedGaps: (curate?.gaps ?? []).filter((g) => g && g.focus).length,
  stateDir: STATE_DIR,
  nextStep: `${curate?.wrote_index === true ? '' : `WARN THE USER FIRST: the curator did not confirm writing ${INDEX_FILE} — verify it exists before relying on the set. `}Present the set: read ${INDEX_FILE} (including Coverage notes) and relay what was gathered, any cross-source inconsistencies, unresolved gaps, and the fidelity spot-check result (${curate?.fidelity_checked ?? 0} file(s) compared against their source, ${curate?.fidelity_failures ?? 0} failed) — a low or zero check count means the verbatim promise went untested, not that it held. ${foreignFound ? `WARN THE USER FIRST: ${OUT_DIR} held ${foreignPaths.length || 'some'} file(s)/folder(s) this run neither captured nor wrote (${foreignPaths.join(', ') || 'paths not reported'}). They were left alone, but outDir must be a fresh directory dedicated to one doc set — move that content out or pick a different outDir before re-running. ` : ''}${A.outDir ? '' : `The set lives in gitignored run-state — copy ${OUT_DIR}/ into the project (or re-run with outDir) if it should persist. `}Point the working agent or plan at the INDEX. Nothing is staged or committed.`,
};
