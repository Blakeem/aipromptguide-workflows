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
//   node tools/plan-edit.mjs args <plan.md|plan-name> [<plan> ...] [--expect <wf-run-id>] [--pack <repo> [--loc-cap <n>]]
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

import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_KEYS, listObject, parseBlocks, parseFileKeys, resolveRoadmap, validate } from './plan-block.mjs';

const USAGE = `usage:
  node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>
      upsert ONE metadata line. A plan id targets the block preamble (mode, gate, status,
      test_selector, depends_on); an issue id targets that entry's "- key:" run.
  node tools/plan-edit.mjs move <src.md|src-name> <issue-id> <dest.md|dest-name> <block-id>
      cut one "### [<id>]" entry and append it, verbatim, to the end of a fix-mode block.
  node tools/plan-edit.mjs args <plan.md|plan-name> [<plan> ...] [--expect <wf-run-id>]
                            [--pack <repo> [--loc-cap <lines>]]
      fold every finished develop run's status edits into the plan files, then print develop's
      args { goal, ordered, suite, sweep, plans }. --expect fails unless that run's record exists.
      --pack groups todo fix blocks into passes of at most --loc-cap lines (default 5000) of the
      files their open ACTIONABLE issues name, so one set of agents builds several small blocks.
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
  const { block, entry } = findTarget(plan, id);
  const { keys: schema, what } = entry ? RUN_KEYS.issue : RUN_KEYS.preamble;
  const keys = entry ? entry.keys : block.preamble.keys;

  // Checked HERE rather than by the round-trip parse below, which structurally cannot see it: a key
  // outside `[a-z_]+` — `test-selector` for `test_selector`, a capitalized `Status`, a leading space —
  // builds a line that ENDS the run instead of joining it, so the reparse finds nothing to reject and the
  // file gains a junk line while the setting the operator asked for is silently dropped, at exit 0.
  // OWN property, never `in`: `in` walks Object.prototype, so `valueOf` and eleven other inherited names
  // passed this guard and were spliced in as exactly that junk line.
  if (!Object.hasOwn(schema, key)) {
    throw new Error(`unknown ${what} "${key}" — the ${what}s are: ${Object.keys(schema).join(', ')}`);
  }

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

/** A develop run's record as { path, runId, status, time, edits }, or null for any other workflow. */
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

  const edits = data.logs.filter((l) => l.startsWith(STATUS_LOG)).flatMap((l) => JSON.parse(l.slice(STATUS_LOG.length)));
  edits.forEach((e, i) => {
    const typed = e && ['planPath', 'id', 'key', 'value'].every((k) => typeof e[k] === 'string');
    if (!typed || !isAbsolute(e.planPath)) {
      throw new Error(`status edit [${i}] in ${path} is not { planPath (absolute), id, key, value }: ${JSON.stringify(e)}`);
    }
  });
  return { path, runId: data.runId, status: data.status, time: Date.parse(data.timestamp), edits };
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

/** The plan with each edit applied in order, re-validated after each so every splice reads fresh positions. */
function applyEdits(plan, edits, source) {
  let next = plan;
  for (const { id, key, value } of edits) {
    try {
      checkOneLine(key, value);
      const text = withKeySet(next, id, key, value);
      next = { path: next.path, text, blocks: validate(parseBlocks(text), next.path) };
    } catch (err) {
      throw new Error(`${source} sets ${id} ${key}=${value} in ${plan.path}, which fails: ${err.message}. Fix the plan, or set its "synced:" file key to that run's timestamp to skip the run`);
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

/** develop's args: one set of file keys, which every plan must agree on, and every block as a row. */
function mergeArgs(plans) {
  const heads = plans.map((p) => ({ path: p.path, ...listObject(p.blocks, p.path, parseFileKeys(p.text)) }));
  const [first] = heads;
  for (const h of heads) {
    for (const k of ['goal', 'ordered', 'suite', 'sweep']) {
      if (h[k] !== first[k]) {
        throw new Error(`${first.path} and ${h.path} disagree on ${k} (${JSON.stringify(first[k])} vs ${JSON.stringify(h[k])}) — one run takes one value`);
      }
    }
  }
  const plansRows = heads.flatMap((h) => h.blocks.map((b) => ({ ...b, planPath: h.path })));
  return { goal: first.goal, ordered: first.ordered, suite: first.suite, sweep: first.sweep, plans: plansRows };
}

// =============================================================================
// --pack — several small fix blocks into one develop pass
// =============================================================================

// Scaled from resolve's old 3000-line batches, which ran each agent at about 150-200k tokens, to the
// ~350k-token ceiling past which token cost climbs. Recalibrate against real runs' token counts.
const DEFAULT_LOC_CAP = 5000;
const UNKNOWN_FILE_LOC = 200;   // a file the entry names that no longer exists still costs a read

const keyOf = (entry, key) => entry.keys.find((k) => k.key === key)?.value;

/** The entries a developer will actually work: ACTIONABLE, and not already closed by an earlier run. */
const openActionable = (block) => block.issues.filter((e) => keyOf(e, 'decision') === 'ACTIONABLE'
  && !['fixed', 'stale'].includes(keyOf(e, 'status')));

/** The line count of every distinct file a block's open entries name: its `- loc:` line, else the file itself. */
function blockFiles(block, repo) {
  const files = new Map();
  for (const entry of openActionable(block)) {
    const path = (keyOf(entry, 'file') ?? '').replace(/:\d+$/, '');
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
 * The args with every todo fix block that has open ACTIONABLE work packed into passes of at most `cap`
 * lines. Blocks are sorted by the first file they touch, so a pass holds neighbouring code. A block over
 * the cap alone, or one with nothing ACTIONABLE, stays its own row. A pass sits where its first member did.
 */
function packPasses(args, folded, repo, cap, note) {
  if (args.ordered) throw new Error('--pack regroups fix blocks, so it needs a plan set with ordered: false');
  const blockOf = new Map(folded.flatMap((p) => p.blocks.map((b) => [`${p.path}\u0000${b.id}`, b])));
  const candidates = [];
  for (const [index, row] of args.plans.entries()) {
    if (row.mode !== 'fix' || row.status !== 'todo') continue;
    const block = blockOf.get(`${row.planPath}\u0000${row.id}`);
    const files = blockFiles(block, repo);
    if (!files.size) { note(`not packed: ${row.id} has no open ACTIONABLE entry, so it is not a plan to build\n`); continue; }
    candidates.push({ index, row, files, issues: block.issues.map((e) => e.id), first: [...files.keys()].sort()[0] });
  }
  candidates.sort((a, b) => a.first.localeCompare(b.first) || a.index - b.index);

  const passes = [];
  let open = null;
  for (const c of candidates) {
    const added = [...c.files].filter(([f]) => !open?.files.has(f)).reduce((sum, [, loc]) => sum + loc, 0);
    const clash = open && c.issues.some((id) => open.issues.has(id));
    if (!open || clash || open.loc + added > cap) {
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
    replaced.set(head.index, { id, title: `pass of ${members.map((m) => m.id).join(', ')}`, mode: 'fix', gate: 'green', status: 'todo', blocks: members });
    for (const m of pass.members) if (m !== head) replaced.set(m.index, null);
    note(`packed ${members.map((m) => m.id).join(', ')} into ${id} (${pass.loc} lines)\n`);
  }
  const plans = args.plans.flatMap((row, i) => (replaced.has(i) ? (replaced.get(i) ? [replaced.get(i)] : []) : [row]));
  return { ...args, plans };
}

function runArgs(argv, note) {
  // Input — each flag takes the argument after it
  const flags = {};
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { paths.push(argv[i]); continue; }
    if (!['--expect', '--pack', '--loc-cap'].includes(argv[i]) || !argv[i + 1]) throw new Error(USAGE);
    flags[argv[i]] = argv[++i];
  }
  const cap = flags['--loc-cap'] === undefined ? DEFAULT_LOC_CAP : Number(flags['--loc-cap']);
  if (!paths.length || !Number.isInteger(cap) || cap < 1 || (flags['--loc-cap'] && !flags['--pack'])) throw new Error(USAGE);
  const expect = flags['--expect'] ?? null;
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const records = findRunRecords(configDir).map(readRunRecord).filter(Boolean);
  const plans = paths.map(loadPlan);

  // Process — every file is folded in memory first, so a fault in the LAST file still writes none.
  if (expect && !records.some((r) => r.runId === expect)) {
    throw new Error(`no develop run record for ${expect} under ${join(configDir, 'projects')} — the run is still going, or Claude Code moved its run records (update findRunRecords in tools/plan-edit.mjs)`);
  }
  const folded = plans.map((p) => foldRecords(p, records, note));
  const merged = mergeArgs(folded);
  const args = flags['--pack'] ? packPasses(merged, folded, flags['--pack'], cap, note) : merged;

  // Output
  for (const [i, f] of folded.entries()) if (f.text !== plans[i].text) writeFileSync(f.path, f.text);
  return `${JSON.stringify(args, null, 2)}\n`;
}

// =============================================================================
// CLI
// =============================================================================

export function run(argv, note = (line) => process.stderr.write(line)) {
  const [command, ...rest] = argv;
  if (command === 'set') return runSet(rest);
  if (command === 'move') return runMove(rest);
  if (command === 'args') return runArgs(rest, note);
  throw new Error(USAGE);
}

// Node resolves the MAIN module through realpath by default, so `import.meta.url` is canonical while argv[1]
// is whatever the caller typed. Comparing the two raw made this false through any link or junction, and the
// process then wrote NOTHING at exit 0 — the plausible-looking default this tool forbids. Realpath BOTH
// sides, so it holds under `--preserve-symlinks-main` too.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plan-edit: ${err.message}\n`);
    process.exit(1);
  }
}
