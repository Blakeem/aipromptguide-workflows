// tools/plan-block.mjs: print ONE unit's block out of a multi-unit plan file, byte-exact.
//
//   node tools/plan-block.mjs <plan.md|plan-name> <id>              # that block, verbatim, on stdout
//   node tools/plan-block.mjs <plan.md|plan-name> --list            # the file's control OBJECT as JSON
//
// tools/CLAUDE.md holds the metadata grammar, bare plan-name resolution and the loud-failure list.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `id — title`: the separator needs surrounding space, so a kebab id keeps its own hyphens.
const TITLE_SPLIT_RE = /[ \t]+[—–-][ \t]+/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// =============================================================================
// Parsing — pure functions over the file's text. Exported for the test suite.
// =============================================================================

const FENCE_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** Is this line inside a fenced code block? Threaded through a line scan as `fence` state. */
function fenceState(line, fence) {
  const hit = line.match(FENCE_RE);
  if (!hit) return fence;
  if (!fence) return hit[1];                                    // opened
  return hit[1][0] === fence[0] && hit[1].length >= fence.length ? '' : fence;   // closed, or noise
}

// =============================================================================
// The metadata grammar — file keys, block preamble, issue entries
// =============================================================================

// One table per run, so an unrecognized key can name the run it was found in. `null` is free text, an
// array is the key's legal enum, and a RegExp is the shape its value must match.
const FILE_KEYS = {
  goal: null,
  ordered: ['true', 'false'],
  suite: ['green', 'scoped'],
  sweep: ['goal-coverage', 'none'],
  synced: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,   // the newest run record plan-edit applied
};
const PREAMBLE_KEYS = {
  mode: ['feature', 'section', 'fix'],
  gate: null,                                  // the legal set is the block's own mode's (MODE_GATES)
  status: ['todo', 'done', 'skip', 'parked', 'blocked'],
  test_selector: null,
  depends_on: null,
};
const ISSUE_KEYS = {
  id: null,                                    // kebab, and equal to its heading's id (checked in validate)
  status: ['open', 'fixed', 'stale', 'needs-attention'],
  file: null,
  loc: null,
  severity: ['critical', 'high', 'medium', 'low'],
  category: null,
  effort: null,
  decision: ['ACTIONABLE', 'NEEDS_USER', 'DEFER', 'SKIP'],
  theme: null,
};

// The two runs a write tool upserts into, each with the noun its failures name. Exported because a key
// must be checked against its table BEFORE a line is spliced in: a key outside `[a-z_]+` builds a line
// that ENDS the run instead of joining it, so a round-trip parse afterwards never sees it and the edit is
// written as junk prose at exit 0. One copy of the grammar, read here and by tools/plan-edit.mjs.
export const RUN_KEYS = {
  file: { keys: FILE_KEYS, what: 'file key' },
  preamble: { keys: PREAMBLE_KEYS, what: 'preamble key' },
  issue: { keys: ISSUE_KEYS, what: 'issue key' },
};

const MODE_GATES = {
  feature: ['green', 'build-only'],
  section: ['green', 'red-baseline', 'build-only'],
  fix: ['green'],
};
const FILE_DEFAULTS = { goal: '', ordered: false, suite: 'green', sweep: 'none' };
// A file carrying a section-mode block is a migration: its units run in order, the goal is swept at the
// end, and a test-first unit may leave the rest of the suite red. Only the DEFAULTS flip — an explicit
// file key still wins.
const SECTION_FILE_DEFAULTS = { ordered: true, suite: 'scoped', sweep: 'goal-coverage' };

const KEY_LINE_RE = /^([a-z_]+):[ \t]/;
const ISSUE_KEY_LINE_RE = /^- ([a-z_]+):[ \t]/;
const ISSUE_HEADING_RE = /^###[ \t]+\[([^\]]*)\][ \t]*(.*)$/;
const ENTRY_END_RE = /^#{2,3}[ \t]/;
const BOM = '\uFEFF';   // escaped: the character itself is invisible in an editor

/** The BOM stripped, plus the shift a position measured on the stripped text needs to point at raw bytes. */
function stripBom(rawText) {
  const has = rawText.startsWith(BOM);
  return { text: has ? rawText.slice(BOM.length) : rawText, shift: has ? BOM.length : 0 };
}

/**
 * Lines of `text` from `from`, as `{ text, start, end }`. `end` excludes CR and LF, so a slice of the
 * span is the line's own bytes and a write tool splicing there cannot eat a CRLF terminator.
 */
function* eachLine(text, from = 0) {
  let i = Math.max(0, from);
  while (i <= text.length) {
    const nl = text.indexOf('\n', i);
    const stop = nl === -1 ? text.length : nl;
    const end = stop > i && text[stop - 1] === '\r' ? stop - 1 : stop;
    yield { text: text.slice(i, end), start: i, end };
    if (nl === -1) return;
    i = nl + 1;
  }
}

/** The index just past the line terminator at or after `i` — where the next line starts. */
function nextLineStart(text, i) {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl + 1;
}

/**
 * Where a run begins: the first NON-BLANK line at or after `i`. Markdown puts a blank line under a
 * heading and under a `---` frontmatter fence, and a blank misses the run shape — so without this skip
 * the run is EMPTY rather than read, and every key the author declared is silently replaced by its
 * default at exit 0. A blank INSIDE the run still ends it; only the gap above the run is crossed.
 */
function runStart(text, i) {
  for (const line of eachLine(text, i)) {
    if (line.text.trim() !== '') return line.start;
  }
  return text.length;
}

/** The value of a metadata line: everything after the first colon and its whitespace, to end of line. */
function valueSpan(line, colonAt) {
  const ws = (ch) => ch === ' ' || ch === '\t';
  let s = colonAt + 1;
  let e = line.text.length;
  while (s < e && ws(line.text[s])) s++;
  while (e > s && ws(line.text[e - 1])) e--;
  return { value: line.text.slice(s, e), valueStart: line.start + s, valueEnd: line.start + e };
}

/**
 * The contiguous run of metadata lines starting at `from`. A line that misses the run's shape ENDS the
 * run — that is what keeps prose and body bullets out of the metadata — while a line that matches it
 * must carry a known key, because a typo'd key that read as prose would silently take the default.
 *
 * The enum guard lives here rather than in validate(): this is the only place that sees all three runs,
 * and validate() never receives the file keys at all.
 *
 * @returns {{values:object, keys:Array, start:number, end:number}} positions are into `text` itself.
 */
function scanRun(text, from, schema, lineRe, what) {
  const values = {};
  const keys = [];
  let end = from;

  for (const line of eachLine(text, from)) {
    const hit = line.text.match(lineRe);
    if (!hit) break;
    const key = hit[1];
    const quoted = line.text.trim();

    // OWN properties on both, never `in`: `in` walks Object.prototype, so `constructor` and `__proto__`
    // would pass the unknown-key guard and then read as set twice, a key nobody set.
    if (!Object.hasOwn(schema, key)) {
      throw new Error(`unknown ${what} "${key}" in "${quoted}" — the ${what}s are: ${Object.keys(schema).join(', ')}`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`${what} "${key}" is set twice in one run ("${quoted}") — two values for one key have no defined winner`);
    }
    const { value, valueStart, valueEnd } = valueSpan(line, line.text.indexOf(':'));
    const allowed = schema[key];
    const legal = !allowed || (allowed instanceof RegExp ? allowed.test(value) : allowed.includes(value));
    if (!legal) {
      const takes = allowed instanceof RegExp ? `a value matching ${allowed}` : allowed.join(' | ');
      throw new Error(`illegal ${what} "${key}: ${value}" — ${key} takes ${takes}`);
    }
    values[key] = value;
    keys.push({ key, value, start: line.start, end: line.end, valueStart, valueEnd });
    end = line.end;
  }
  return { values, keys, start: from, end };
}

/** Every position in a scanned run moved by `shift`, so they point into the raw text as read from disk. */
function shiftRun(run, shift) {
  if (!shift) return run;
  const move = (k) => ({
    ...k, start: k.start + shift, end: k.end + shift, valueStart: k.valueStart + shift, valueEnd: k.valueEnd + shift,
  });
  return { values: run.values, keys: run.keys.map(move), start: run.start + shift, end: run.end + shift };
}

/** Where the file keys begin: after a `--- ... ---` frontmatter fence, which is skipped without reading. */
function afterFrontmatter(text) {
  const it = eachLine(text, 0);
  const first = it.next().value;
  if (!first || first.text !== '---') return 0;

  for (const line of it) {
    if (line.text === '---') return nextLineStart(text, line.end);
  }
  return 0;   // never closed, so it is not frontmatter — the file keys start at the top
}

/**
 * The file-level keys — the run that opens the file, the blank line markdown puts under a `---` fence
 * crossed. Positions are into `rawText` as read from disk: the BOM is skipped for matching but still
 * counted, so a write tool splicing here cannot corrupt it.
 */
export function parseFileKeys(rawText) {
  const { text, shift } = stripBom(rawText);
  const from = runStart(text, afterFrontmatter(text));
  return shiftRun(scanRun(text, from, FILE_KEYS, KEY_LINE_RE, 'file key'), shift);
}

/**
 * The block preamble — the first run of `key: value` lines under a `## Plan:` header, the blank line the
 * template puts between the two crossed. `from` indexes `text` directly. The skip lives here rather than
 * at the two call sites so `parseBlocks` and `readGate` cannot disagree about where one block's run is.
 */
export function parsePreamble(text, from) {
  const { keys, what } = RUN_KEYS.preamble;
  return scanRun(text, runStart(text, from), keys, KEY_LINE_RE, what);
}

/**
 * The `### [<id>] <title>` issue entries between `from` and `to`, each with its own `- key:` run.
 * Fenced regions are skipped, so an entry shown as an example is not an entry. An entry runs to the next
 * `##`/`###` header or to `to`; positions index `text` directly. `runFrom` is the line under the heading —
 * where a write tool appends the first `- key:` line when the run is empty, the twin of a block's
 * `preambleStart`.
 */
export function parseIssues(text, from, to) {
  const headings = [];
  const bounds = [];                 // every header that can close an entry, the entry headings included
  let fence = '';

  for (const line of eachLine(text, from)) {
    if (line.start >= to) break;
    const was = fence;
    fence = fenceState(line.text, fence);
    if (was || fence || !ENTRY_END_RE.test(line.text)) continue;

    bounds.push(line.start);
    const hit = line.text.match(ISSUE_HEADING_RE);
    if (hit) headings.push({ id: hit[1].trim(), title: hit[2].trim(), start: line.start, headingEnd: line.end });
  }

  const { keys: schema, what } = RUN_KEYS.issue;
  return headings.map(({ id, title, start, headingEnd }) => {
    const runFrom = nextLineStart(text, headingEnd);
    const run = scanRun(text, runStart(text, runFrom), schema, ISSUE_KEY_LINE_RE, what);
    return { id, title, values: run.values, keys: run.keys, runFrom, start, end: bounds.find((b) => b > start) ?? to };
  });
}

/** A block body starts at the END of its header line, so its preamble run starts one line down. */
function bodyRunStart(body) {
  if (body.startsWith('\r\n')) return 2;
  return body.startsWith('\n') ? 1 : 0;
}

/** Scanned line by line, not by one /gm regex: a fenced header is an example, not a unit. */
export function parseBlocks(rawText) {
  // A BOM sits before the first `^`, so header 1 would not match and its whole block would be swallowed
  // as "text before the first block" — one unit silently missing, exit 0. Stripped here rather than at
  // the file read, so every caller of the parser is covered. `shift` puts the reported positions back on
  // the raw bytes the caller read, which is what a write tool splices against.
  const { text, shift } = stripBom(rawText);
  const headerRe = /^##[ \t]+Plan:[ \t]*(.+?)[ \t]*$/;
  // 1-3 leading spaces still renders as a heading in most markdown, but is not a block boundary here.
  // Silently dropping it would delete a whole unit the human can see, so it is a hard error.
  const indentedRe = /^[ \t]{1,3}##[ \t]+Plan:/;
  // A header that misses the shape any OTHER way (colon forgotten, a colon with no id, a space before the
  // colon, or written as `###`) is a hard error. Read as body text, its block would merge into the
  // previous one at exit 0.
  // The kebab-token requirement in `noColonRe` is load-bearing: it is what keeps a prose heading such as
  // "## Plan Rationale" from throwing. The other three need no such guard — `## Plan :` and a bare
  // `## Plan:` have no legitimate reading as prose, and a `#{3,6}` header is the same class as the 1-3
  // space indent below: a heading the human reads as a boundary that the parser does not. All three were
  // scanned against every `.md`/`.mjs` in the repo: zero matches.
  const emptyIdRe = /^##[ \t]+Plan:[ \t]*$/;
  const noColonRe = /^##[ \t]+Plan[ \t]+[a-z0-9]+(?:-[a-z0-9]+)*[ \t]*(?:$|[—–-][ \t])/;
  const spacedColonRe = /^##[ \t]+Plan[ \t]+:/;
  const deepHeaderRe = /^#{3,6}[ \t]+Plan:/;
  const nearMissRes = [emptyIdRe, noColonRe, spacedColonRe, deepHeaderRe];
  const headers = [];
  const indented = [];
  const malformed = [];
  let offset = 0;
  let fence = '';

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const wasFenced = fence;
    fence = fenceState(line, fence);

    if (!wasFenced && !fence) {
      const hit = line.match(headerRe);
      if (hit) {
        headers.push({
          start: offset,
          bodyStart: offset + line.length,
          nextLine: Math.min(text.length, offset + raw.length + 1),
          label: hit[1],
        });
      }
      else if (indentedRe.test(line)) indented.push(line.trim());
      else if (nearMissRes.some((re) => re.test(line))) malformed.push(line.trim());
    }
    offset += raw.length + 1;
  }

  // One unbalanced fence marker leaves `fence` open to EOF, and every later header is read as an example —
  // every remaining unit silently deleted from the control array at exit 0. An open fence at end of file is
  // always malformed markdown, so there is no false-positive surface here.
  if (fence) {
    throw new Error(`unclosed "${fence}" code fence in this file — it swallows every plan header after it; close the fence`);
  }

  if (indented.length) {
    throw new Error(`indented "## Plan:" header(s) in this file: ${indented.join(' | ')} — a plan header must start at column 0 to be a block boundary; un-indent it, or fence it if it is an example`);
  }

  if (malformed.length) {
    throw new Error(`malformed "## Plan:" header(s) in this file: ${malformed.join(' | ')} — a plan header must be "## Plan: <id>"; fix the header, or fence it if it is an example`);
  }

  return headers.map((header, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].start : text.length;
    const [rawId, ...titleParts] = header.label.split(TITLE_SPLIT_RE);
    const block = {
      id: rawId.trim(),
      title: titleParts.join(' - ').trim(),
      text: text.slice(header.start, end),        // header + body, what the agent is given
      body: text.slice(header.bodyStart, end),    // body alone, what gate/emptiness checks read
      start: header.start + shift,                // raw positions: `rawText.slice(start, end)` is `text`
      end: end + shift,
      preambleStart: header.nextLine + shift,     // where this block's metadata run begins
    };
    const preamble = parsePreamble(rawText, block.preambleStart);
    return {
      ...block,
      preamble,
      mode: preamble.values.mode ?? 'feature',
      // Found for every mode; validate() is what refuses them outside a fix-mode block.
      issues: parseIssues(rawText, block.preambleStart, block.end),
    };
  });
}

/** Gate from the preamble only: a prose build-only would skip every test. */
export function readGate(body) {
  return parsePreamble(body, bodyRunStart(body)).values.gate ?? null;
}

/** Structural faults that must stop the run rather than reach an agent. */
export function validate(blocks, source) {
  const seen = new Map();   // id -> what claimed it, so a collision names both sides

  if (!blocks.length) {
    throw new Error(`no "## Plan: <id>" blocks in ${source} — it needs one block per plan`);
  }
  for (const block of blocks) {
    if (!KEBAB_RE.test(block.id)) {
      throw new Error(`plan id "${block.id}" in ${source} is not a kebab slug (a-z, 0-9, single hyphens) — it routes file names, so it cannot contain spaces or punctuation`);
    }
    if (seen.has(block.id)) {
      throw new Error(`plan id "${block.id}" appears twice in ${source} — two plans would share one DISMISSED-${block.id}.md and one review file`);
    }
    if (!block.body.trim()) {
      throw new Error(`plan "${block.id}" in ${source} has an empty body — the developer would be handed a header and nothing else`);
    }
    seen.set(block.id, `plan "${block.id}"`);
    validateMetadata(block, source, seen);
  }
  return blocks;
}

/**
 * The per-block metadata rules: the gate against the block's OWN mode, and the issue entries a fix-mode
 * block may carry. Block ids and issue ids share `seen`, because both route file names.
 */
function validateMetadata(block, source, seen) {
  const gates = MODE_GATES[block.mode];
  const gate = block.preamble.values.gate;

  if (gate !== undefined && !gates.includes(gate)) {
    throw new Error(`plan "${block.id}" in ${source} declares "gate: ${gate}", which mode ${block.mode} does not allow — a ${block.mode}-mode plan takes ${gates.join(' | ')}`);
  }
  if (block.mode !== 'fix' && block.issues.length) {
    throw new Error(`plan "${block.id}" in ${source} is mode ${block.mode} but carries issue entries (${block.issues.map((e) => `[${e.id}]`).join(', ')}) — a "### [<id>]" entry is legal only under a fix-mode plan`);
  }
  for (const entry of block.issues) {
    if (!KEBAB_RE.test(entry.id)) {
      throw new Error(`issue id "${entry.id}" in plan "${block.id}" of ${source} is not a kebab slug (a-z, 0-9, single hyphens) — it routes file names, so it cannot contain spaces or punctuation`);
    }
    if (entry.values.id !== undefined && entry.values.id !== entry.id) {
      throw new Error(`issue "${entry.id}" in ${source} carries "- id: ${entry.values.id}" — the heading id and the id key disagree, and there is no rule for which one wins`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`id "${entry.id}" in ${source} is claimed twice (${seen.get(entry.id)} and an issue entry) — plan ids and issue ids are one namespace, so the two would share one file name`);
    }
    seen.set(entry.id, `issue "${entry.id}"`);
  }
}

// =============================================================================
// Input resolution
// =============================================================================

/** A path stays a path; a bare name resolves against the plan-mode directory. */
export function resolveRoadmap(arg) {
  if (/[\\/]/.test(arg) || arg.endsWith('.md')) return isAbsolute(arg) ? arg : resolve(arg);

  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return join(configDir, 'plans', `${arg}.md`);
}

function readPlanFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(`no such plan file: ${path}`);
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
}

// =============================================================================
// Output — one block verbatim, or the plan's control object
// =============================================================================

export function emitBlock(blocks, id, source) {
  const block = blocks.find((b) => b.id === id);

  if (!block) {
    throw new Error(`no plan "${id}" in ${source} — it has: ${blocks.map((b) => b.id).join(', ')}`);
  }
  return block.text;
}

/**
 * The plan file's control object: the file keys with their defaults applied, then one row per block.
 * `fileKeys` is optional — a caller with only the blocks (the test suite) gets the documented defaults.
 */
export function listObject(blocks, source, fileKeys = null) {
  const sets = Object.entries(MODE_GATES).map(([mode, legal]) => `${mode}: ${legal.join(' | ')}`).join(', ');
  const missing = [];
  const bad = [];

  const rows = blocks.map((block) => {
    const gates = MODE_GATES[block.mode];
    const gate = readGate(block.body);
    if (!gate) missing.push(`${block.id} (mode ${block.mode})`);
    else if (!gates.includes(gate)) bad.push(`${block.id} (${gate}, mode ${block.mode})`);
    return { id: block.id, title: block.title || block.id, mode: block.mode, gate, status: block.preamble.values.status ?? 'todo' };
  });

  if (missing.length) {
    throw new Error(`no gate for: ${missing.join(', ')} in ${source} — add a "gate:" line to the plan's preamble (${sets}); there is deliberately no default`);
  }
  if (bad.length) {
    throw new Error(`invalid gate for: ${bad.join(', ')} in ${source} — a plan takes the set its own mode allows (${sets})`);
  }

  // A section-mode block anywhere in the file moves the DEFAULTS only; an explicit file key still wins.
  const defaults = blocks.some((b) => b.mode === 'section') ? { ...FILE_DEFAULTS, ...SECTION_FILE_DEFAULTS } : FILE_DEFAULTS;
  const values = fileKeys?.values ?? {};
  const head = {
    goal: values.goal ?? defaults.goal,
    ordered: values.ordered === undefined ? defaults.ordered : values.ordered === 'true',
    suite: values.suite ?? defaults.suite,
    sweep: values.sweep ?? defaults.sweep,
  };
  // The sweep re-derives the surface from the goal, so a goalless sweep would audit nothing it can name.
  if (head.sweep === 'goal-coverage' && !head.goal.trim()) {
    throw new Error(`sweep is goal-coverage but no goal is set in ${source} — add a "goal:" file key, or "sweep: none" to skip the sweep`);
  }
  return { ...head, blocks: rows };
}

export function emitList(blocks, source, fileKeys = null) {
  const { blocks: rows, ...head } = listObject(blocks, source, fileKeys);
  const row = (r) => `    { "id": ${JSON.stringify(r.id)}, "title": ${JSON.stringify(r.title)}`
    + `, "mode": ${JSON.stringify(r.mode)}, "gate": ${JSON.stringify(r.gate)}, "status": ${JSON.stringify(r.status)} }`;
  return `{\n  "goal": ${JSON.stringify(head.goal)}, "ordered": ${head.ordered}`
    + `, "suite": ${JSON.stringify(head.suite)}, "sweep": ${JSON.stringify(head.sweep)},\n`
    + `  "blocks": [\n${rows.map(row).join(',\n')}\n  ]\n}\n`;
}

// =============================================================================
// CLI
// =============================================================================

const USAGE = `usage:
  node tools/plan-block.mjs <plan.md|plan-name> <id>       print that block, verbatim
  node tools/plan-block.mjs <plan.md|plan-name> --list     print the control object as JSON

  Blocks are "## Plan: <id>", with file keys (goal, ordered, suite, sweep, synced), a block preamble
  (mode, gate, status, test_selector, depends_on) and, under a fix-mode block, "### [<id>]" issue
  entries. --list emits { goal, ordered, suite, sweep, blocks: [...] }.

a bare plan-name resolves to <CLAUDE_CONFIG_DIR | ~/.claude>/plans/<name>.md`;

// Refused rather than ignored, so a caller still passing it learns the aliases are gone.
const RETIRED_KIND = '--kind is retired: the section and component aliases are gone, and every block is now "## Plan: <id>" with a preamble "gate:" line';

export function run(argv) {
  // Input
  if (argv.some((a) => a === '--kind' || a.startsWith('--kind='))) throw new Error(RETIRED_KIND);
  const [rawPath, selector] = argv;
  if (!rawPath || !selector) throw new Error(USAGE);

  // Process
  const path = resolveRoadmap(rawPath);
  const text = readPlanFile(path);
  const blocks = validate(parseBlocks(text), path);
  // Parsed on every selector, not just --list: an unknown file key is a fault in the plan file itself,
  // and a developer fetching one block must not be the only caller that never sees it.
  const fileKeys = parseFileKeys(text);

  // Output
  return selector === '--list'
    ? emitList(blocks, path, fileKeys)
    : emitBlock(blocks, selector, path);
}

// Realpath BOTH sides: a symlink or junction in the script path makes argv[1] differ from import.meta.url,
// and a false `invokedDirectly` prints nothing at exit 0. Holds under `--preserve-symlinks-main` too.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plan-block: ${err.message}\n`);
    process.exit(1);
  }
}
