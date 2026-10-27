// tools/plan-edit.mjs — the ONE tool that WRITES a plan file: upsert one metadata line, move one issue
// entry between blocks, or fold finished develop runs into the plans and print the next launch's args.
//
// Why this is a separate file from plan-block.mjs rather than two more subcommands of it. The run-time
// permission rule allowlists every subcommand of the file it names, so a write subcommand sharing that file
// would hand every agent in a run the ability to rewrite the approved plan it is building against. This tool
// is operator-invoked BETWEEN runs and is never given to an agent.
//
//   node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>
//   node tools/plan-edit.mjs move <src.md|src-name> <issue-id> <dest.md|dest-name> <block-id>
//   node tools/plan-edit.mjs args [<plan.md|plan-name> ...] [--expect <wf-run-id>] [--backlog <dir>] [--pack <repo> [--loc-cap <n>] | --fold-only]
//
// It parses nothing of its own. plan-block.mjs locates the metadata runs and reports their positions in the
// RAW bytes, so a BOM'd or CRLF file splices without corruption, and the edited text goes back through that
// same validator before anything reaches disk: an unknown key, an illegal enum value, a gate the block's
// mode forbids and a colliding id all throw with the file untouched.
//
// Everything outside the edited span stays byte-identical — a BOM, the line endings, and the presence or
// absence of a trailing newline. A newly appended line inherits the file's dominant line ending.
//
// Exit 0 on success; exit 1 with the reason on stderr and NOTHING written — every failure the grammar can
// see is caught before the first byte reaches disk, and each one names the id, key or value at fault: an
// approved plan is what agents build against, so a half-applied or silently coerced edit is worse than no
// edit at all. The one fault validation cannot pre-empt is an I/O error BETWEEN a cross-file move's two
// writes: the write order leaves the entry duplicated rather than deleted, and the error names the manual
// cut, since a single-file parse never sees a duplicate across two plans. `args` builds and validates every
// file's edited text before writing any, and the `synced:` file key keeps a run from applying twice.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_KEYS, TITLE_SPLIT_RE, listObject, parseBlocks, parseFileKeys, resolveRoadmap, validate } from './plan-block.mjs';

const USAGE = `usage:
  node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>
      upsert ONE metadata line. A plan id targets the block preamble (mode, gate, status,
      test_selector, depends_on, model, effort); an issue id targets that entry's "- key:" run.
  node tools/plan-edit.mjs move <src.md|src-name> <issue-id> <dest.md|dest-name> <block-id>
      cut one "### [<id>]" entry and append it, verbatim, to the end of a fix-mode block.
  node tools/plan-edit.mjs args [<plan.md|plan-name> ...] [--expect <wf-run-id>] [--backlog <dir>]
                            [--pack <repo> [--loc-cap <lines>] | --fold-only]
      fold every finished develop run's status edits into the plan files, then print develop's
      args { goal, ordered, suite, sweep, plans, blockTool }, where blockTool is the plan-block.mjs
      beside this tool. --expect fails unless that run's record exists.
      --backlog adds each backlog file in <dir> whose status is todo or done and that holds an open
      ACTIONABLE entry with no "- pulled:" or "**Parked with:**" line and no needs-attention
      ACTIONABLE entry, and sets a done one to todo. It leaves out a file while the block that wrote
      it, which the run records name, is not done, skip or backlogged in its plan file. It also
      leaves out a file whose ready entry names, in its "- file:" line, a file that the text of a
      blocked or parked block names, in a given plan or in a plan a develop run on <dir> built. It cuts the
      "**Parked with:** block <id>" line of an open ACTIONABLE entry once that block, in the run
      the file's header names, is done or skip in its plan file. It writes the folded statuses and
      cuts of every todo or done backlog file with an ACTIONABLE entry. It needs a plan set with
      ordered: false, and it lets the plan list be empty.
      --pack groups todo fix blocks into passes of at most --loc-cap lines (default 5000) of the
      files their open ACTIONABLE issues name, so one set of agents builds several small blocks.
      A pass runs on the strongest model and the highest effort among its members.
      --fold-only writes the same folds and cuts, sets no done file to todo, and prints nothing.
      All-or-nothing: one bad edit in any file writes no file at all.

a bare plan-name resolves to <CLAUDE_CONFIG_DIR | ~/.claude>/plans/<name>.md`;

// =============================================================================
// Bytes — everything here works on the raw text, never on a re-serialized parse
// =============================================================================

const splice = (text, from, to, insert) => text.slice(0, from) + insert + text.slice(to);

/** The file's dominant line ending, which a newly appended line inherits. A file with none takes LF. */
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return crlf > lf - crlf ? '\r\n' : '\n';
}

/**
 * Two `<file>` arguments can spell ONE file (a link, a junction, a different case on Windows). Writing it
 * twice would clobber the cut with the pre-cut bytes, so identity is resolved rather than compared as text.
 */
function sameFile(a, b) {
  if (a === b) return true;
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch { return false; }   // one of them does not exist yet — the read below is what reports that
}

function readPlanFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no such plan file: ${path}`);
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

/** A plan file read and fully validated — a file with a structural fault is never edited, only reported. */
function loadPlan(arg) {
  const path = resolveRoadmap(arg);
  const text = readPlanFile(path);
  return { path, text, blocks: validate(parseBlocks(text), path) };
}

// =============================================================================
// Addressing — block ids and issue ids are ONE namespace, which validate() enforces
// =============================================================================

const everyId = (blocks) => blocks.flatMap((b) => [b.id, ...b.issues.map((e) => e.id)]);

/** The block, or the block and the issue entry, an id addresses. */
function findTarget(plan, id) {
  const owner = plan.blocks.find((b) => b.id === id);
  if (owner) return { block: owner, entry: null };

  for (const block of plan.blocks) {
    const entry = block.issues.find((e) => e.id === id);
    if (entry) return { block, entry };
  }
  throw new Error(`no id "${id}" in ${plan.path} — it has: ${everyId(plan.blocks).join(', ')}`);
}

/** The issue entry an id addresses. A BLOCK id lands here too, and is refused: only an entry can move. */
function findIssue(plan, id) {
  for (const block of plan.blocks) {
    const entry = block.issues.find((e) => e.id === id);
    if (entry) return entry;
  }
  const entries = plan.blocks.flatMap((b) => b.issues.map((e) => e.id));
  throw new Error(`no issue "${id}" in ${plan.path} — its entries are: ${entries.join(', ') || '(none)'}`);
}

// =============================================================================
// set — one metadata line, replaced in place or appended to its own run
// =============================================================================

/** The only text this tool takes apart itself. Split at the FIRST "=", so a value may contain one. */
function splitAssignment(arg) {
  const at = arg.indexOf('=');
  if (at < 1) throw new Error(`"${arg}" is not <key>=<value> — the key is everything before the first "="`);

  const key = arg.slice(0, at);
  const value = arg.slice(at + 1);
  checkOneLine(key, value);
  return { key, value };
}

/**
 * A metadata run ends at the first line that misses its shape, so a second line would land in the body as
 * prose and the key would silently keep only its first line.
 */
function checkOneLine(key, value) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`the value of "${key}" contains a line break — a metadata value is one line`);
  }
}

/**
 * The file's bytes with ONE metadata line upserted. A key already in the run has its VALUE span overwritten,
 * so the line's own spacing survives; an absent one is appended after the run's last line, or directly under
 * the header when the run is empty.
 */
function withKeySet(plan, id, key, value) {
  const { block, entry, keys } = findKeyRun(plan, id, key);

  const present = keys.find((k) => k.key === key);
  if (present) return splice(plan.text, present.valueStart, present.valueEnd, value);

  const eol = dominantEol(plan.text);
  const line = entry ? `- ${key}: ${value}` : `${key}: ${value}`;
  if (keys.length) {
    const last = keys[keys.length - 1];
    return splice(plan.text, last.end, last.end, `${eol}${line}`);   // last.end excludes the terminator
  }
  // Both run starts CLAMP to end of file, so on a file whose last line is the heading itself the insertion
  // point is mid-line: appending there welds the metadata onto the heading, which still parses as the same
  // entry, so nothing throws and the key is simply never set. Only the entry twin is reachable — a block
  // whose header is the last line has an empty body, which validate() already refuses.
  const at = entry ? entry.runFrom : block.preambleStart;
  const welds = at === plan.text.length && at > 0 && !plan.text.endsWith('\n');
  return splice(plan.text, at, at, welds ? `${eol}${line}` : `${line}${eol}`);
}

/**
 * The file's bytes with ONE metadata line removed, with its own line terminator, or with the one before it
 * when it ends the file. An absent key leaves the bytes as they are, so a repeated removal is a no-op.
 */
function withKeyRemoved(plan, id, key) {
  const { keys } = findKeyRun(plan, id, key);
  const present = keys.find((k) => k.key === key);
  if (!present) return plan.text;

  const own = plan.text.startsWith('\r\n', present.end) ? 2 : plan.text.startsWith('\n', present.end) ? 1 : 0;
  if (own) return splice(plan.text, present.start, present.end + own, '');
  const before = plan.text.slice(0, present.start).endsWith('\r\n') ? 2 : Math.min(present.start, 1);
  return splice(plan.text, present.start - before, present.end, '');
}

/** The block or entry an id addresses, with the metadata run a known `key` belongs to. */
function findKeyRun(plan, id, key) {
  const { block, entry } = findTarget(plan, id);
  const { keys: schema, what, renamed } = entry ? RUN_KEYS.issue : RUN_KEYS.preamble;
  const keys = entry ? entry.keys : block.preamble.keys;

  // Checked HERE rather than by the caller's round-trip parse, which structurally cannot see it: a key
  // outside `[a-z_]+` — `test-selector` for `test_selector`, a capitalized `Status`, a leading space —
  // builds a line that ENDS the run instead of joining it, so the reparse finds nothing to reject and the
  // file gains a junk line while the setting the operator asked for is silently dropped, at exit 0. A
  // removal of such a key would match no line and exit 0 as a silent no-op.
  // OWN property, never `in`: `in` walks Object.prototype, so `valueOf` and eleven other inherited names
  // passed this guard and were spliced in as exactly that junk line.
  if (renamed && Object.hasOwn(renamed, key)) {
    throw new Error(`the ${what} "${key}" was renamed to "${renamed[key]}", so use ${renamed[key]} in its place`);
  }
  if (!Object.hasOwn(schema, key)) {
    throw new Error(`unknown ${what} "${key}" — the ${what}s are: ${Object.keys(schema).join(', ')}`);
  }
  return { block, entry, keys };
}

function runSet(argv) {
  // Input
  if (argv.length !== 3) throw new Error(USAGE);
  const [rawPath, id, assignment] = argv;
  const { key, value } = splitAssignment(assignment);

  // Process
  const plan = loadPlan(rawPath);
  const next = withKeySet(plan, id, key, value);
  // The grammar decides what is legal, not a second copy of it here: the edited text goes back through the
  // parser that reported the positions, so an unknown key, an illegal enum and a gate the block's mode
  // forbids each throw before the write rather than being discovered by the next run.
  validate(parseBlocks(next), plan.path);

  // Output
  writeFileSync(plan.path, next);
  return `set ${key} on ${id} in ${plan.path}\n`;
}

// =============================================================================
// move — one issue entry, cut from its source and appended to a fix-mode block
// =============================================================================

/** The destination block, which must exist and must be the one mode an entry is legal under. */
function findDestBlock(dest, blockId) {
  const block = dest.blocks.find((b) => b.id === blockId);
  if (!block) {
    throw new Error(`no plan "${blockId}" in ${dest.path} — it has: ${dest.blocks.map((b) => b.id).join(', ')}`);
  }
  if (block.mode !== 'fix') {
    throw new Error(`plan "${blockId}" in ${dest.path} is mode ${block.mode} — a "### [<id>]" entry is legal only under a fix-mode plan`);
  }
  return block;
}

/** The destination's id space must be free, or the two units would share one review file and one ledger. */
function checkIdFree(dest, issueId, oneFile) {
  // Regrouping inside one file is not a collision: the entry already holds its own id there.
  const taken = everyId(dest.blocks).filter((x) => !(oneFile && x === issueId));
  if (taken.includes(issueId)) {
    throw new Error(`id "${issueId}" is already claimed in ${dest.path} — plan ids and issue ids are one namespace`);
  }
}

/**
 * The entry's bytes spliced in verbatim. A line terminator is added only where the join would otherwise weld
 * two lines together — a source file with no trailing newline glues its last entry onto the destination's
 * next header, and that parses as ONE merged block at exit 0.
 */
function insertEntry(text, at, bytes, eol) {
  const before = text.slice(0, at);
  const after = text.slice(at);
  const lead = before && !before.endsWith('\n') ? eol : '';
  const tail = after && !bytes.endsWith('\n') ? eol : '';
  return `${before}${lead}${bytes}${tail}${after}`;
}

function runMove(argv) {
  // Input
  if (argv.length !== 4) throw new Error(USAGE);
  const [srcArg, issueId, destArg, blockId] = argv;

  // Process
  const src = loadPlan(srcArg);
  const oneFile = sameFile(src.path, resolveRoadmap(destArg));
  const dest = oneFile ? src : loadPlan(destArg);
  const entry = findIssue(src, issueId);
  const block = findDestBlock(dest, blockId);
  checkIdFree(dest, issueId, oneFile);

  const bytes = src.text.slice(entry.start, entry.end);
  const cut = splice(src.text, entry.start, entry.end, '');
  // A block boundary never falls INSIDE an entry, so within one file the insertion point is either wholly
  // before the cut (unmoved) or wholly after it (back by the entry's length).
  const at = oneFile && block.end >= entry.end ? block.end - bytes.length : block.end;
  const nextDest = insertEntry(oneFile ? cut : dest.text, at, bytes, dominantEol(dest.text));
  const nextSrc = oneFile ? nextDest : cut;

  validate(parseBlocks(nextSrc), src.path);
  if (!oneFile) validate(parseBlocks(nextDest), dest.path);

  // Output — both texts are built and validated first, so a grammar fault leaves both files alone. The
  // DESTINATION is written first so an I/O fault between the two writes duplicates the entry instead of
  // deleting it. No parse catches a duplicate across two files, so the error names the manual cut.
  if (!oneFile) writeFileSync(dest.path, nextDest);
  try {
    writeFileSync(src.path, nextSrc);
  } catch (err) {
    if (oneFile) throw err;
    throw new Error(`${dest.path} already holds ${issueId}, but cutting it from ${src.path} failed (${err.message}) — delete the "### [${issueId}]" entry from ${src.path} by hand, or the issue exists in both plans`);
  }
  return `moved ${issueId} to ${blockId} in ${dest.path}\n`;
}

// =============================================================================
// Run records — what the Claude Code runtime writes when a Workflow run ends
// =============================================================================

// The line prefix develop-cycle.mjs logs each finished block's status edits under (its STATUS_LOG).
const STATUS_LOG = 'status-sync ';
const RECORD_STATUSES = ['completed', 'failed', 'killed'];
const FORMAT_CHANGED = 'the Claude Code run-record format changed: update readRunRecord in tools/plan-edit.mjs';

/** Every run record on this machine: <config>/projects/<project>/<session>/workflows/wf_*.json. */
export function findRunRecords(configDir) {
  const found = [];
  const subdirs = (path) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(path, d.name));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  };
  for (const session of subdirs(join(configDir, 'projects')).flatMap(subdirs)) {
    for (const dir of subdirs(session).filter((d) => d === join(session, 'workflows'))) {
      for (const name of readdirSync(dir)) if (/^wf_.*\.json$/.test(name)) found.push(join(dir, name));
    }
  }
  return found;
}

/**
 * The runtime fields the fold depends on, as the names of those that are missing or malformed. Exported so
 * the suite can check every real record on the machine and flag a Claude Code format change early.
 */
export function envelopeFaults(data) {
  return [
    typeof data?.workflowName !== 'string' && 'workflowName',
    typeof data?.runId !== 'string' && 'runId',
    !RECORD_STATUSES.includes(data?.status) && 'status',
    Number.isNaN(Date.parse(data?.timestamp)) && 'timestamp',
    !(Array.isArray(data?.logs) && data.logs.every((l) => typeof l === 'string')) && 'logs',
  ].filter(Boolean);
}

// The runtime keeps a long log line's head and tail and replaces its middle with this marker.
const CUT_MARK = /\n\n\.\.\. \[\d+ characters truncated\] \.\.\.\n\n/;

/**
 * A develop run's record as { path, runId, developRunId, backlogDir, rows, status, time, edits, cut }, or null for any
 * other workflow. `runId` is the runtime's wf_ id, `developRunId` the runId arg develop names its backlog files with
 * (null when the record keeps neither its args nor its result), `backlogDir` its backlogDir arg (null when the record
 * keeps none), and `rows` its `plans` arg. `cut` holds each status line the runtime cut short, which no longer parses.
 */
export function readRunRecord(path) {
  let data = null;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read run record ${path}: ${err.message}`);
  }
  if (typeof data?.workflowName !== 'string') throw new Error(`${path} has no workflowName — ${FORMAT_CHANGED}`);
  if (data.workflowName !== 'develop-cycle') return null;
  const faults = envelopeFaults(data);
  if (faults.length) throw new Error(`${path} has no valid ${faults.join(', ')} — ${FORMAT_CHANGED}`);

  // A completed run returns every edit uncut. A failed or stopped run has no result, so its edits come from
  // the per-block log lines, which the runtime may cut.
  const fromResult = Array.isArray(data.result?.statusSync);
  const edits = fromResult ? [...data.result.statusSync] : [];
  const cut = [];
  const lines = fromResult ? [] : data.logs.filter((l) => l.startsWith(STATUS_LOG));
  for (const line of lines) {
    if (CUT_MARK.test(line)) {
      cut.push(line);
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(line.slice(STATUS_LOG.length));
    } catch {
      throw new Error(`${path} has a status line that is not JSON — ${FORMAT_CHANGED}`);
    }
    edits.push(...[].concat(parsed));
  }
  edits.forEach((e, i) => {
    const typed = e && ['planPath', 'id', 'key'].every((k) => typeof e[k] === 'string') && (typeof e.value === 'string' || e.value === null);
    if (!typed || !isAbsolute(e.planPath)) {
      throw new Error(`status edit [${i}] in ${path} is not { planPath (absolute), id, key, value (a string, or null to remove the line) }: ${JSON.stringify(e)}`);
    }
  });
  // Older records keep no args, so the result's echo of the runId arg stands in for it. develop takes a numeric
  // runId too and writes it into a backlog file's header as text.
  const runIdArg = [data.args?.runId, data.result?.runId].find((v) => typeof v === 'string' || Number.isFinite(v));
  const developRunId = runIdArg === undefined ? null : String(runIdArg);
  const backlogDir = typeof data.args?.backlogDir === 'string' ? data.args.backlogDir : null;
  const rows = Array.isArray(data.args?.plans) ? data.args.plans : [];
  return { path, runId: data.runId, developRunId, backlogDir, rows, status: data.status, time: Date.parse(data.timestamp), edits, cut };
}

/**
 * Whether the surviving text of a cut status line names *planPath*: a whole `planPath` value that resolves to
 * the same file, or the path's text in any slash direction or case, as the log escapes it.
 */
function namesPlan(line, planPath) {
  const key = fileKey(planPath);
  const resolved = [...line.matchAll(/"planPath":("(?:[^"\\]|\\.)*")/g)].some((m) => {
    try {
      return fileKey(JSON.parse(m[1])) === key;
    } catch { return false; }
  });
  const spellings = [planPath, key].flatMap((p) => [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')]);
  const haystack = line.toLowerCase();
  return resolved || spellings.some((p) => haystack.includes(JSON.stringify(p).slice(1, -1).toLowerCase()));
}

// =============================================================================
// args — fold finished runs into the plan files, then print develop's args
// =============================================================================

/** Two spellings of one file must compare equal, or a record's edits would miss the plan they name. */
function fileKey(path) {
  try {
    return realpathSync.native(path);
  } catch { return path; }   // a missing file — loadPlan reports that
}

/**
 * The plan with each edit applied in order, re-validated after each so every splice reads fresh positions. A null
 * value removes the key's line.
 */
function applyEdits(plan, edits, source) {
  let next = plan;
  for (const { id, key, value } of edits) {
    const removes = value === null;
    try {
      if (!removes) checkOneLine(key, value);
      const text = removes ? withKeyRemoved(next, id, key) : withKeySet(next, id, key, value);
      next = { path: next.path, text, blocks: validate(parseBlocks(text), next.path) };
    } catch (err) {
      const what = removes ? `removes the ${key} line of ${id}` : `sets ${id} ${key}=${value}`;
      throw new Error(`${source} ${what} in ${plan.path}, which fails: ${err.message}. Fix the plan, or set its "synced:" file key to that run's timestamp to skip the run`);
    }
  }
  return next;
}

/** The file's bytes with its `synced:` file key upserted. */
function withSyncedSet(plan, iso) {
  const { keys, start } = parseFileKeys(plan.text);
  const present = keys.find((k) => k.key === 'synced');
  if (present) return splice(plan.text, present.valueStart, present.valueEnd, iso);

  const eol = dominantEol(plan.text);
  const last = keys[keys.length - 1];
  if (last) return splice(plan.text, last.end, last.end, `${eol}synced: ${iso}`);
  // No file keys yet: the new run needs a blank line under it, or the heading below reads as its prose.
  const gap = plan.text.startsWith(eol, start) ? '' : eol;
  return splice(plan.text, start, start, `synced: ${iso}${eol}${gap}`);
}

/** One plan with every run record newer than its `synced:` key applied, oldest first. */
function foldRecords(plan, records, note) {
  const marker = Date.parse(parseFileKeys(plan.text).values.synced ?? '') || 0;
  const key = fileKey(plan.path);
  const [lost] = records
    .filter((r) => r.time > marker && r.cut.some((line) => namesPlan(line, plan.path)))
    .sort((a, b) => a.time - b.time);
  if (lost) {
    const iso = new Date(lost.time).toISOString();
    const older = records.filter((r) => r.time > marker && r.time < lost.time && r.edits.some((e) => fileKey(e.planPath) === key));
    const skipped = older.length ? ` after applying by hand the edits of the older run(s) ${older.map((r) => r.runId).join(', ')}, which that key also skips` : '';
    throw new Error(`run ${lost.runId} (${lost.path}, ${iso}) logged a status line the runtime cut short, and it names ${plan.path}, so its status edits cannot be applied. The record's logs hold what survived. Set those statuses by hand, then set the plan's "synced:" file key to ${iso}${skipped}`);
  }
  const fresh = records
    .filter((r) => r.time > marker)
    .map((r) => ({ ...r, edits: r.edits.filter((e) => fileKey(e.planPath) === key) }))
    .filter((r) => r.edits.length)
    .sort((a, b) => a.time - b.time);

  let next = plan;
  for (const r of fresh) {
    next = applyEdits(next, r.edits, `run ${r.runId} (${r.path})`);
    note(`applied ${r.edits.length} status edit(s) from run ${r.runId} (${r.status}) to ${plan.path}\n`);
  }
  if (!fresh.length) return next;
  const text = withSyncedSet(next, new Date(fresh[fresh.length - 1].time).toISOString());
  return { path: plan.path, text, blocks: validate(parseBlocks(text), plan.path) };
}

/**
 * develop's args: one set of file keys, which every plan must agree on, and every block as a row. A backlog
 * file carries no file keys of its own, so it takes the given plans' keys, and the defaults when none is given.
 */
function mergeArgs(plans, backlog = []) {
  const headOf = (p) => ({ path: p.path, ...listObject(p.blocks, p.path, parseFileKeys(p.text)) });
  const heads = plans.map(headOf);
  const added = backlog.map(headOf);
  const [first] = heads.length ? heads : added;
  for (const h of heads) {
    for (const k of ['goal', 'ordered', 'suite', 'sweep']) {
      if (h[k] !== first[k]) {
        throw new Error(`${first.path} and ${h.path} disagree on ${k} (${JSON.stringify(first[k])} vs ${JSON.stringify(h[k])}) — one run takes one value`);
      }
    }
  }
  const plansRows = [...heads, ...added].flatMap((h) => h.blocks.map((b) => ({ ...b, planPath: h.path })));
  return { goal: first.goal, ordered: first.ordered, suite: first.suite, sweep: first.sweep, plans: plansRows };
}

// =============================================================================
// --backlog — the project's ready backlog files join the plan set
// =============================================================================

export const keyOf = (entry, key) => entry.keys.find((k) => k.key === key)?.value;
const blockStatus = (block) => block.preamble.values.status ?? 'todo';
const BACKLOG_STATUSES = ['todo', 'done'];
/** The repo path an entry's `- file:` line names, without its `:<line>` suffix, or '' when it names none. */
export const entryPath = (entry) => (keyOf(entry, 'file') ?? '').replace(/:\d+$/, '');
/** A repo path as an entry's "- file:" line spells it: forward slashes, no leading "./". */
export const repoPath = (path) => path.trim().replace(/\\/g, '/').replace(/^\.\//, '');

const isOpenActionable = (entry) => keyOf(entry, 'decision') === 'ACTIONABLE' && (keyOf(entry, 'status') ?? 'open') === 'open';

// The hold develop puts on an entry whose code sits on its block's branch or is not built yet. Only a line at column 0
// counts, since an entry's **What:** indents every line it copies from a file. A line that names no block as
// `block <id>` still holds, since the developer prompts count every such line as a hold.
const PARKED_WITH = /^\*\*Parked with:\*\*(?: block ([a-z0-9]+(?:-[a-z0-9]+)*)\b)?[^\n]*(?:\n|$)/m;
// A landed block, or one the user dropped, no longer holds the code its parked-with entries name.
const PARK_RELEASED = ['done', 'skip'];
// The way out of a hold whose block `args` cannot look up.
const PARKED_WAY_OUT = 'Once that block is done or skip, release each entry it holds by deleting that entry\'s **Parked with:** line';

/**
 * An entry's `**Parked with:**` line as { blockId, start, end } in raw file positions, or null. `blockId` is undefined
 * for a line that names no block. `text` starts at raw position `base`.
 */
function parkedLine(text, entry, base = 0) {
  const hit = text.slice(entry.start - base, entry.end - base).match(PARKED_WITH);
  return hit ? { blockId: hit[1], start: entry.start + hit.index, end: entry.start + hit.index + hit[0].length } : null;
}
const isHeld = (entry, block) => Boolean(parkedLine(block.text, entry, block.start));

/**
 * An entry of `block` a run can build without the user: ACTIONABLE, neither closed nor waiting on the user, not taken by
 * a developer beside its own block, whose run syncs that entry or whose park entry carries its work, and not held by a
 * `**Parked with:**` line.
 */
export const isReady = (entry, block) => isOpenActionable(entry) && !keyOf(entry, 'pulled') && !isHeld(entry, block);

/** An ACTIONABLE entry whose fix failed. A fix-mode developer rebuilds it with its file, so its file waits for triage. */
const waitsOnUser = (entry) => keyOf(entry, 'decision') === 'ACTIONABLE' && keyOf(entry, 'status') === 'needs-attention';

/** A block a --backlog launch builds: a todo block, or a done one that took a new ready entry, with no entry waiting on the user. */
export const isBacklogBlock = (block) => BACKLOG_STATUSES.includes(blockStatus(block))
  && block.issues.some((e) => isReady(e, block)) && !block.issues.some(waitsOnUser);

/** The `.md` files of the backlog folder. A folder no run has written an entry to yet does not exist, and holds none. */
function backlogPaths(dir, note) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.md')).sort().map((name) => join(dir, name));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read the backlog folder ${dir}: ${err.message}`);
    note(`no backlog folder at ${dir}, so --backlog adds nothing\n`);
    return [];
  }
}

/** The plan with each done block that holds a ready entry set back to todo. */
function reopenDone(plan) {
  let next = plan;
  for (const block of plan.blocks.filter((b) => blockStatus(b) === 'done' && isBacklogBlock(b))) {
    const text = withKeySet(next, block.id, 'status', 'todo');
    next = { path: next.path, text, blocks: validate(parseBlocks(text), next.path) };
  }
  return next;
}

// The title develop-cycle's headerLines gives a backlog file's block. A block id is a kebab slug, so the first
// " of run " ends it.
const WRITER_TITLE = /^backlog from block ([a-z0-9]+(?:-[a-z0-9]+)*) of run (.+)$/;
// A relaunch of the writing block may still append to its file, so develop works the file only after these.
const WRITER_FINISHED = ['done', 'skip', 'backlogged'];
// A block status edit, as against an issue's: the two status sets share no value.
const BLOCK_STATUSES = RUN_KEYS.preamble.keys.status;

/** A runId as a parsed header title holds it, since the title parser splits at a spaced dash and rejoins with " - ". */
const titleRunId = (runId) => runId.split(TITLE_SPLIT_RE).join(' - ').trim();

/** A folder's comparable form, so a trailing slash or another separator still names the same folder. */
const dirKey = (path) => fileKey(resolve(path));

/**
 * The { planPath, id } of each plan block a run's block id stood for: the block itself, or each member of a pass.
 * Only the runs that wrote to `backlogDir`, or that keep no backlogDir arg, count, since another project's run may
 * share the runId and block id.
 */
function writerBlocks(records, backlogDir, developRunId, blockId) {
  const found = new Map();
  const add = (planPath, id) => {
    if (typeof planPath === 'string' && isAbsolute(planPath) && typeof id === 'string') found.set(`${fileKey(planPath)}\u0000${id}`, { planPath, id });
  };
  const folder = dirKey(backlogDir);
  const runId = titleRunId(developRunId);
  const wrote = (r) => r.developRunId !== null && titleRunId(r.developRunId) === runId && (r.backlogDir === null || dirKey(r.backlogDir) === folder);
  for (const r of records.filter(wrote)) {
    for (const e of r.edits.filter((x) => x.id === blockId && x.key === 'status' && BLOCK_STATUSES.includes(x.value))) add(e.planPath, e.id);
    for (const row of r.rows) {
      const members = Array.isArray(row?.blocks) ? row.blocks : [];
      if (row?.id === blockId && members.length === 0) add(row.planPath, row.id);
      // A pass's park file names the pass, and a member's own backlog file names the member.
      for (const m of members.filter((x) => row.id === blockId || x?.id === blockId)) add(m?.planPath, m?.id);
    }
  }
  return [...found.values()];
}

// What a looked-up block's status decides, for the messages of `heldStatus`.
const WRITER_HOLD = { role: 'the block that wrote a backlog file', held: 'that file', unknown: 'its status does not hold back its backlog file' };
const PARKED_HOLD = {
  role: 'the block a backlog entry is parked with',
  held: 'that entry',
  unknown: `the entries parked with it stay held. ${PARKED_WAY_OUT}`,
};

/**
 * The block's status with every record folded into its plan in memory, or null when its plan file or its block is
 * gone. A plan that exists but fails to load or to fold its records throws, since its status is unknown and releasing
 * what it holds could build that early.
 */
function heldStatus({ planPath, id }, records, note, { role, held, unknown }) {
  let plan = null;
  try {
    plan = loadPlan(planPath);
  } catch (err) {
    if (!err.message.startsWith('no such plan file:')) {
      throw new Error(`cannot load ${planPath}, which holds ${id}, ${role} (${err.message}). Its status decides whether ${held} is held back, so fix the plan file and run again`);
    }
    note(`cannot read ${planPath}, which holds ${id} (${err.message}), so ${unknown}\n`);
    return null;
  }
  let block = null;
  try {
    block = foldRecords(plan, records, () => {}).blocks.find((b) => b.id === id);
  } catch (err) {
    throw new Error(`cannot fold the run records into ${planPath}, which holds ${id}, ${role} (${err.message}). Its status decides whether ${held} is held back, so fix the plan file or the record and run again`);
  }
  if (!block) note(`${planPath} no longer holds ${id}, so ${unknown}\n`);
  return block ? blockStatus(block) : null;
}

/** The first writer block of `plan`'s blocks, a file of `backlogDir`, that is not finished, as { planPath, id, status }, or null. */
function unfinishedWriter(plan, backlogDir, records, note) {
  for (const block of plan.blocks) {
    const [, blockId, developRunId] = block.title.match(WRITER_TITLE) ?? [];
    if (!blockId) continue;
    for (const writer of writerBlocks(records, backlogDir, developRunId, blockId)) {
      const status = heldStatus(writer, records, note, WRITER_HOLD);
      if (status && !WRITER_FINISHED.includes(status)) return { ...writer, status };
    }
  }
  return null;
}

/**
 * The plan with the `**Parked with:**` line cut from each open ACTIONABLE entry of a todo or done block when the block
 * the line names is done or skip in its plan file, so the entry builds like any other. The line names a block of the run
 * its file's header names. An entry whose block no record names keeps its hold, since its code may still sit on that
 * block's branch.
 */
function releaseParked(plan, backlogDir, records, note) {
  const cuts = [];
  const statusOf = new Map();
  const released = (holder) => {
    const key = `${holder.planPath}\u0000${holder.id}`;
    if (!statusOf.has(key)) statusOf.set(key, heldStatus(holder, records, note, PARKED_HOLD));
    return PARK_RELEASED.includes(statusOf.get(key));
  };
  for (const block of plan.blocks.filter((b) => BACKLOG_STATUSES.includes(blockStatus(b)))) {
    const [, , developRunId] = block.title.match(WRITER_TITLE) ?? [];
    for (const entry of block.issues.filter(isOpenActionable)) {
      const line = parkedLine(plan.text, entry);
      if (!line) continue;
      const holders = developRunId && line.blockId ? writerBlocks(records, backlogDir, developRunId, line.blockId) : [];
      if (!holders.length) {
        const why = line.blockId ? `no run record names block ${line.blockId}${developRunId ? ` of run ${developRunId}` : ''}` : 'its **Parked with:** line names no block as "block <id>"';
        note(`kept the hold on ${entry.id} in ${plan.path}: ${why}. ${PARKED_WAY_OUT}\n`);
        continue;
      }
      if (holders.every(released)) cuts.push(line);
    }
  }
  if (!cuts.length) return plan;
  const text = cuts.sort((a, b) => b.start - a.start).reduce((t, c) => splice(t, c.start, c.end, ''), plan.text);
  return { path: plan.path, text, blocks: validate(parseBlocks(text), plan.path) };
}

/** The way out of a hold by a `parked` block, an older engine's park, which develop never selects, so only the user releases it. */
function parkedWayOut(id, status) {
  return status === 'parked'
    ? ` A parked block is never relaunched, so set ${id} in its plan file to skip to drop it, to todo to rebuild it, or to backlogged only when a backlog entry carries its work.`
    : '';
}

/** The note for a backlog file its unfinished writer holds back. */
function heldBackNote(path, { planPath, id, status }) {
  return `left out ${path}: the block that wrote it, ${id} (${status}) in ${planPath}, is not done, skip or backlogged.${parkedWayOut(id, status)}\n`;
}

// A block a relaunch may still build: `blocked`, or an older engine's `parked` once the user sets it todo.
const RELAUNCHABLE = ['blocked', 'parked'];

/**
 * Each `blocked` or `parked` block, with the run records folded in memory, of the plans `given` names and of every
 * plan whose block a develop run on `backlogDir` built, as { planPath, id, status, text }. A plan file that is gone
 * holds none. One that exists but fails to read, validate or fold throws, since its blocked blocks are unknown.
 */
function blockedBlocks(backlogDir, given, records) {
  const folder = dirKey(backlogDir);
  const paths = new Map();
  const add = (path) => {
    if (typeof path === 'string' && isAbsolute(path) && !paths.has(fileKey(path))) paths.set(fileKey(path), path);
  };
  for (const p of given) add(resolve(p.path));
  for (const r of records.filter((x) => x.backlogDir !== null && dirKey(x.backlogDir) === folder)) {
    for (const row of r.rows) {
      add(row?.planPath);
      for (const m of Array.isArray(row?.blocks) ? row.blocks : []) add(m?.planPath);
    }
  }
  const found = [];
  for (const planPath of paths.values()) {
    let plan = null;
    try {
      plan = foldRecords(loadPlan(planPath), records, () => {});
    } catch (err) {
      if (err.message.startsWith('no such plan file:')) continue;
      throw new Error(`cannot read the blocked blocks of ${planPath}, a plan a develop run on ${backlogDir} built or one named here (${err.message}). A blocked or parked block holds back each ready backlog entry whose file its text names, so fix the plan file or the record and run again`);
    }
    for (const block of plan.blocks.filter((b) => RELAUNCHABLE.includes(blockStatus(b)))) found.push({ planPath, id: block.id, status: blockStatus(block), text: block.text });
  }
  return found;
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `text` names the repo path `path` as an entire path, with or without a leading "./", in either slash direction. */
function namesRepoFile(text, path) {
  const edge = '[\\w./-]';
  return new RegExp(`(?:(?<!${edge})|(?<=(?<!${edge})\\./))${escapeRe(path)}(?!\\.?[\\w/-])`).test(text.replace(/\\/g, '/'));
}

/**
 * Each ready entry of `plan`'s todo or done blocks whose `- file:` path a blocked or parked block's text names, as
 * { entry, file, holder }, since a relaunch of that block may change that file.
 */
function blockedHolds(plan, blocked) {
  const holds = [];
  for (const block of plan.blocks.filter((b) => BACKLOG_STATUSES.includes(blockStatus(b)))) {
    for (const entry of block.issues.filter((e) => isReady(e, block))) {
      const file = repoPath(entryPath(entry));
      const holder = file ? blocked.find((b) => namesRepoFile(b.text, file)) : null;
      if (holder) holds.push({ entry: entry.id, file, holder });
    }
  }
  return holds;
}

/**
 * The todo or done backlog files of `dir` that hold an ACTIONABLE entry, each with its run records folded in and the
 * line of each released parked-with entry cut, as plans with their `original` text. A `chosen` file also has its done
 * blocks set to todo. A file whose writing block, which the
 * records of runs on `dir` name through the file's header, is not done, skip or backlogged is never chosen. A file whose writing block no
 * record names is chosen when it meets the other rules. A file with a ready entry whose file a blocked or parked block's text names
 * is never chosen, since develop builds every ACTIONABLE entry of a file it builds. Every folded file is returned, so
 * the caller writes the fold of a file no launch builds, such as one whose fix failed. A fold never changes an
 * entry's decision, so a file with no ACTIONABLE entry is skipped before it is folded, which keeps its records
 * from blocking the launch. With `choose` false, no file is chosen, and the writer hold and the blocked-block hold are
 * not looked up.
 */
export function foldBacklog(dir, given, records, note, { choose = true } = {}) {
  const taken = new Set(given.map((p) => fileKey(p.path)));
  const judged = [];
  for (const path of backlogPaths(dir, note)) {
    if (taken.has(fileKey(path))) continue;
    const plan = loadPlan(path);
    const holdsActionable = plan.blocks.some((b) => BACKLOG_STATUSES.includes(blockStatus(b)) && b.issues.some((e) => keyOf(e, 'decision') === 'ACTIONABLE'));
    if (!holdsActionable) continue;
    const folded = releaseParked(foldRecords(plan, records, note), dir, records, note);
    const buildable = choose && folded.blocks.some(isBacklogBlock);
    const writer = buildable ? unfinishedWriter(folded, dir, records, note) : null;
    if (writer) note(heldBackNote(path, writer));
    judged.push({ path, plan, folded, open: buildable && !writer });
  }
  // Looked up once every file's own holds are read, and only when a file may still build.
  const blocked = judged.some((j) => j.open) ? blockedBlocks(dir, given, records) : [];
  return judged.map(({ path, plan, folded, open }) => {
    const holds = open ? blockedHolds(folded, blocked) : [];
    for (const { entry, file, holder } of holds) {
      note(`held ${entry} in ${path}: block ${holder.id} (${holder.status}) in ${holder.planPath} names ${file}, and a relaunch of it may change that file, so the file is left out.${parkedWayOut(holder.id, holder.status)}\n`);
    }
    const chosen = open && !holds.length;
    return { ...(chosen ? reopenDone(folded) : folded), original: plan.text, chosen };
  });
}

// =============================================================================
// --pack — several small fix blocks into one develop pass
// =============================================================================

// Scaled from resolve's old 3000-line batches, which ran each agent at about 150-200k tokens, to the
// ~350k-token ceiling past which token cost climbs. Recalibrate against real runs' token counts.
const DEFAULT_LOC_CAP = 5000;
const UNKNOWN_FILE_LOC = 200;   // a file the entry names that no longer exists still costs a read
// Strongest first. A member with no line runs on the run's default, which --pack cannot see, so only the
// first value of each list is at least as strong as every default.
export const STRENGTH = { model: ['fable', 'opus', 'sonnet', 'haiku'], effort: ['max', 'xhigh', 'high', 'medium', 'low'] };

/**
 * The entries a developer will actually work: ACTIONABLE, not already closed by an earlier run, not taken by another
 * block's developer, and not held by a `**Parked with:**` line.
 */
const openActionable = (block) => block.issues.filter((e) => keyOf(e, 'decision') === 'ACTIONABLE'
  && !['fixed', 'stale'].includes(keyOf(e, 'status')) && !keyOf(e, 'pulled') && !isHeld(e, block));

/** The line count of every distinct file a block's open entries name: its `- loc:` line, else the file itself. */
function blockFiles(block, repo) {
  const files = new Map();
  for (const entry of openActionable(block)) {
    const path = entryPath(entry);
    if (!path || files.has(path)) continue;
    const stated = Number(keyOf(entry, 'loc'));
    if (Number.isInteger(stated) && stated > 0) { files.set(path, stated); continue; }
    try {
      files.set(path, readFileSync(join(repo, path), 'utf8').split('\n').length);
    } catch { files.set(path, UNKNOWN_FILE_LOC); }
  }
  return files;
}

/**
 * The `key` value one developer runs a pass on: the strongest of its members' values, '' when no member sets
 * one, and null when they cannot share a developer, since a member with no line joins only the top rank (fable or max).
 */
function passSetting(key, values) {
  const order = STRENGTH[key];
  const stated = values.filter(Boolean);
  const unranked = stated.find((v) => !order.includes(v));
  if (unranked) throw new Error(`--pack has no strength rank for ${key} ${unranked}: add it to STRENGTH in tools/plan-edit.mjs`);
  if (!stated.length) return '';
  const strongest = order.find((v) => stated.includes(v));
  if (stated.length < values.length && strongest !== order[0]) return null;
  return strongest;
}

/** 0 for a stated value other than the top rank (fable or max), 1 for the top rank, 2 for no line. */
const shareRank = (key, value) => (!value ? 2 : value === STRENGTH[key][0] ? 1 : 0);

/**
 * The args with every todo fix block that has open ACTIONABLE work packed into passes of at most `cap`
 * lines. Blocks are sorted by the `shareRank` of their developer model, then of their effort, then by the
 * first file they touch, so neighbouring code packs together. Each block joins the first pass it fits, one
 * under the cap whose members it can share a developer with and whose issues it does not repeat, and opens a
 * new pass only when none fits. A block over the cap alone, one with nothing ACTIONABLE, or one whose open
 * ACTIONABLE entry carries a `- branch:` line stays its own row. A pass sits where its first member did.
 */
function packPasses(args, folded, repo, cap, note) {
  if (args.ordered) throw new Error('--pack regroups fix blocks, so it needs a plan set with ordered: false');
  const blockOf = new Map(folded.flatMap((p) => p.blocks.map((b) => [`${p.path}\u0000${b.id}`, b])));
  const candidates = [];
  for (const [index, row] of args.plans.entries()) {
    if (row.mode !== 'fix' || row.status !== 'todo') continue;
    const block = blockOf.get(`${row.planPath}\u0000${row.id}`);
    const files = blockFiles(block, repo);
    if (!files.size) { note(`not packed: ${row.id} has no open ACTIONABLE entry without a "- pulled:" or "**Parked with:**" line, so it is not a plan to build\n`); continue; }
    // Two parked branches cut from one baseline tend to touch the same lines, so a second restore in one round 1 may not apply.
    if (openActionable(block).some((e) => keyOf(e, 'branch'))) { note(`not packed: ${row.id} restores an unfinished branch, so it builds alone\n`); continue; }
    candidates.push({ index, row, files, issues: block.issues.map((e) => e.id), first: [...files.keys()].sort()[0], model: row.model ?? '', effort: row.effort ?? '' });
  }
  candidates.sort((a, b) => shareRank('model', a.model) - shareRank('model', b.model)
    || shareRank('effort', a.effort) - shareRank('effort', b.effort) || a.first.localeCompare(b.first) || a.index - b.index);

  const passes = [];
  const fits = (pass, c) => {
    const added = [...c.files].filter(([f]) => !pass.files.has(f)).reduce((sum, [, loc]) => sum + loc, 0);
    const clash = c.issues.some((id) => pass.issues.has(id));
    const joined = [...pass.members, c];
    const shared = passSetting('model', joined.map((m) => m.model)) !== null && passSetting('effort', joined.map((m) => m.effort)) !== null;
    return !clash && shared && pass.loc + added <= cap;
  };
  for (const c of candidates) {
    let open = passes.find((pass) => fits(pass, c));
    if (!open) {
      open = { members: [], files: new Map(), issues: new Set(), loc: 0 };
      passes.push(open);
    }
    open.members.push(c);
    for (const [f, loc] of c.files) if (!open.files.has(f)) { open.files.set(f, loc); open.loc += loc; }
    for (const id of c.issues) open.issues.add(id);
  }

  const taken = new Set(args.plans.map((r) => r.id));
  const replaced = new Map();
  for (const pass of passes.filter((x) => x.members.length > 1)) {
    const [head] = [...pass.members].sort((a, b) => a.index - b.index);
    const id = `${head.row.id}-plus-${pass.members.length - 1}`;
    if (taken.has(id)) throw new Error(`pass id ${id} collides with a block id — rename that block`);
    const members = pass.members.map((m) => ({ id: m.row.id, planPath: m.row.planPath, issues: m.issues }));
    const settings = Object.fromEntries(['model', 'effort'].map((key) => [key, passSetting(key, pass.members.map((m) => m[key]))]).filter(([, v]) => v));
    // The approval summary must name each member a pass runs above its own line, and only this note carries that.
    const raises = Object.entries(settings).flatMap(([key, to]) => pass.members.filter((m) => m[key] !== to).map((m) => `${m.row.id} ${key} ${m[key] || 'default'} -> ${to}`));
    replaced.set(head.index, { id, title: `pass of ${members.map((m) => m.id).join(', ')}`, mode: 'fix', gate: 'green', status: 'todo', ...settings, blocks: members });
    for (const m of pass.members) if (m !== head) replaced.set(m.index, null);
    note(`packed ${members.map((m) => m.id).join(', ')} into ${id} (${pass.loc} lines)${raises.length ? `, raising ${raises.join(', ')}` : ''}\n`);
  }
  const plans = args.plans.flatMap((row, i) => (replaced.has(i) ? (replaced.get(i) ? [replaced.get(i)] : []) : [row]));
  return { ...args, plans };
}

/**
 * The plan-block.mjs the launch args name, spelled as the caller ran this tool. A link to this FILE leaves no
 * plan-block.mjs beside that spelling, so the path then falls back to the folder this module's import resolved from.
 */
function blockToolPath(invokedScript) {
  const invokedDir = dirname(resolve(invokedScript));
  const toolDir = existsSync(join(invokedDir, 'plan-block.mjs')) ? invokedDir : dirname(fileURLToPath(import.meta.url));
  return join(toolDir, 'plan-block.mjs').replace(/\\/g, '/');
}

function runArgs(argv, note, invokedScript) {
  // Input — each flag takes the argument after it
  const flags = {};
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { paths.push(argv[i]); continue; }
    if (argv[i] === '--fold-only') { flags[argv[i]] = true; continue; }
    if (!['--expect', '--backlog', '--pack', '--loc-cap'].includes(argv[i]) || !argv[i + 1]) throw new Error(USAGE);
    flags[argv[i]] = argv[++i];
  }
  const cap = flags['--loc-cap'] === undefined ? DEFAULT_LOC_CAP : Number(flags['--loc-cap']);
  const foldOnly = flags['--fold-only'] === true;
  if ((!paths.length && !flags['--backlog']) || !Number.isInteger(cap) || cap < 1 || (flags['--loc-cap'] && !flags['--pack'])) throw new Error(USAGE);
  if (foldOnly && flags['--pack']) throw new Error(USAGE);
  const expect = flags['--expect'] ?? null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const records = findRunRecords(configDir).map(readRunRecord).filter(Boolean);
  const plans = paths.map(loadPlan);
  const blockTool = blockToolPath(invokedScript);

  // Process — every file is folded in memory first, so a fault in the LAST file still writes none.
  if (expect && !records.some((r) => r.runId === expect)) {
    throw new Error(`no develop run record for ${expect} under ${join(configDir, 'projects')} — the run is still going, or Claude Code moved its run records (update findRunRecords in tools/plan-edit.mjs)`);
  }
  const backlog = flags['--backlog'] ? foldBacklog(flags['--backlog'], plans, records, note, { choose: !foldOnly }) : [];
  const known = [...plans, ...backlog];
  for (const r of records.filter((x) => x.cut.length && !known.some((p) => x.cut.some((line) => namesPlan(line, p.path))))) {
    note(`skipped ${r.cut.length} status line(s) the runtime cut short in run ${r.runId} (${r.path}), since their surviving text names no plan given here\n`);
  }
  const folded = plans.map((p) => foldRecords(p, records, note));
  const added = backlog.filter((f) => f.chosen);
  const writes = [...folded.map((f, i) => ({ f, was: plans[i].text })), ...backlog.map((f) => ({ f, was: f.original }))];
  const flush = () => { for (const { f, was } of writes) if (f.text !== was) writeFileSync(f.path, f.text); };
  if (foldOnly) {
    flush();
    return '';
  }
  if (!folded.length && !added.length) {
    flush();
    throw new Error(`no backlog file in ${flags['--backlog']} is todo or done and holds an entry with decision ACTIONABLE, status open and no pulled line or held Parked with line, and no ACTIONABLE entry with status needs-attention, with the block that wrote it done, skip or backlogged, and no ready entry whose file a blocked or parked block names, so there is nothing to build`);
  }
  const merged = mergeArgs(folded, added);
  if (flags['--backlog'] && merged.ordered) throw new Error('--backlog adds fix files that build unordered, so it needs a plan set with ordered: false');
  const args = flags['--pack'] ? packPasses(merged, [...folded, ...added], flags['--pack'], cap, note) : merged;

  // Output
  flush();
  return `${JSON.stringify({ ...args, blockTool }, null, 2)}\n`;
}

// =============================================================================
// CLI
// =============================================================================

const toStderr = (line) => process.stderr.write(line);

/**
 * `invokedScript` is the path this tool ran as. The CLI passes argv[1], since Node realpaths the main module, so
 * `blockTool` keeps the spelling of the permission rules the caller wrote (plugin-access.mjs grants both spellings).
 */
export function run(argv, note = toStderr, invokedScript = fileURLToPath(import.meta.url)) {
  const [command, ...rest] = argv;
  if (command === 'set') return runSet(rest);
  if (command === 'move') return runMove(rest);
  if (command === 'args') return runArgs(rest, note, invokedScript);
  throw new Error(USAGE);
}

// Node resolves the MAIN module through realpath by default, so `import.meta.url` is canonical while argv[1]
// is whatever the caller typed. A raw comparison of the two is false through any link or junction, and the
// process then writes nothing at exit 0, the plausible-looking default this tool forbids. Realpath BOTH
// sides, so it holds under `--preserve-symlinks-main` too.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2), toStderr, process.argv[1]));
  } catch (err) {
    process.stderr.write(`plan-edit: ${err.message}\n`);
    process.exit(1);
  }
}
