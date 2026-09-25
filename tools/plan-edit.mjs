// tools/plan-edit.mjs — the ONE tool that WRITES a plan file: upsert one metadata line, move one issue
// entry between blocks, or apply the status edits a develop run returned.
//
// Why this is a separate file from plan-block.mjs rather than two more subcommands of it. The run-time
// permission rule allowlists every subcommand of the file it names, so a write subcommand sharing that file
// would hand every agent in a run the ability to rewrite the approved plan it is building against. This tool
// is operator-invoked BETWEEN runs and is never given to an agent.
//
//   node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>
//   node tools/plan-edit.mjs move <src.md|src-name> <issue-id> <dest.md|dest-name> <block-id>
//   node tools/plan-edit.mjs sync <result.json>
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
// cut, since a single-file parse never sees a duplicate across two plans. `sync` builds and validates every
// file's edited text before writing any, and a re-run over an applied result writes nothing.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_KEYS, parseBlocks, resolveRoadmap, validate } from './plan-block.mjs';

const USAGE = `usage:
  node tools/plan-edit.mjs set <plan.md|plan-name> <id> <key>=<value>
      upsert ONE metadata line. A plan id targets the block preamble (mode, gate, status,
      test_selector, depends_on); an issue id targets that entry's "- key:" run.
  node tools/plan-edit.mjs move <src.md|src-name> <issue-id> <dest.md|dest-name> <block-id>
      cut one "### [<id>]" entry and append it, verbatim, to the end of a fix-mode block.
  node tools/plan-edit.mjs sync <result.json>
      apply every { planPath, id, key, value } edit in a develop result's statusSync (or a bare
      array of them). All-or-nothing: one bad edit in any file writes no file at all.

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
// sync — every status edit a develop run returned, validated as one set before any file is written
// =============================================================================

/** The edits a result file holds: a develop return object's statusSync, or a bare array of edits. */
function readSyncEdits(path) {
  let data = null;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no such result file: ${path}`);
    throw new Error(`cannot read ${path} as JSON: ${err.message}`);
  }
  const edits = Array.isArray(data) ? data : data?.statusSync;
  if (!Array.isArray(edits)) {
    throw new Error(`${path} holds neither a develop result with a statusSync array nor a bare array of edits`);
  }
  edits.forEach((e, i) => {
    const typed = e && ['planPath', 'id', 'key', 'value'].every((k) => typeof e[k] === 'string');
    if (!typed) throw new Error(`edit [${i}] in ${path} is not { planPath, id, key, value } strings: ${JSON.stringify(e)}`);
    // A relative path would resolve against wherever the operator happens to stand, or read as a plan-name.
    if (!isAbsolute(e.planPath)) throw new Error(`edit [${i}] in ${path} has a relative planPath "${e.planPath}" — develop emits absolute paths`);
  });
  return edits;
}

/** Two spellings of one file must share one group, or the second write would clobber the first's edits. */
function fileKey(path) {
  try {
    return realpathSync.native(path);
  } catch { return path; }   // a missing file — loadPlan reports that
}

/** One file's edited text, each edit re-validated before the next so every splice reads fresh positions. */
function withEditsApplied(path, edits) {
  const original = loadPlan(path);
  let plan = original;
  for (const { id, key, value } of edits) {
    try {
      checkOneLine(key, value);
      const text = withKeySet(plan, id, key, value);
      plan = { path: plan.path, text, blocks: validate(parseBlocks(text), plan.path) };
    } catch (err) {
      throw new Error(`${path}: ${id} ${key}=${value}: ${err.message}`);
    }
  }
  return { path: plan.path, text: plan.text, changed: plan.text !== original.text };
}

function runSync(argv) {
  // Input
  if (argv.length !== 1) throw new Error(USAGE);
  const edits = readSyncEdits(argv[0]);

  // Process — every file is edited in memory first, so a fault in the LAST file still writes none.
  const groups = new Map();
  for (const e of edits) {
    const key = fileKey(e.planPath);
    if (!groups.has(key)) groups.set(key, { path: e.planPath, edits: [] });
    groups.get(key).edits.push(e);
  }
  const files = [...groups.values()].map((g) => ({ ...withEditsApplied(g.path, g.edits), count: g.edits.length }));
  const changed = files.filter((f) => f.changed);

  // Output
  for (const f of changed) writeFileSync(f.path, f.text);
  if (!changed.length) return `nothing to change: ${edits.length} edit(s) across ${files.length} file(s) already applied\n`;
  return changed.map((f) => `synced ${f.count} edit(s) in ${f.path}\n`).join('');
}

// =============================================================================
// CLI
// =============================================================================

export function run(argv) {
  const [command, ...rest] = argv;
  if (command === 'set') return runSet(rest);
  if (command === 'move') return runMove(rest);
  if (command === 'sync') return runSync(rest);
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
