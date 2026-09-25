// tools/plan-block.mjs — print ONE unit's block out of a multi-unit plan file, byte-exact.
//
// Why this exists. feature-cycle's roadmap, migrate-cycle's decomposition and gauntlet-cycle's component
// list all live in ONE approved file, carrying one block per unit — `## Plan: <id>` for a feature,
// `## Section: <id>` for a migration section, `## Component: <id>` for a gauntlet MVP component.
// Agents are handed a COMMAND that prints their own block
// instead of a path to the whole file, which buys two things:
//
//   1. A five-unit plan does not enter every developer's and every acceptance verifier's context.
//   2. The end of a block is decided by a parser, not by an agent's judgment. feature's plan bodies use
//      `##` headers (`## Feature`, `## Acceptance Criteria`, ...), so an agent told to "read the block
//      headed ## Plan: auth" can legitimately stop at the next `##` — one paragraph in — and build
//      against a truncated spec that looks complete. Here, only the unit header ends a block.
//
// Nothing is ever written. The plan file stays the single source of truth (#11) and what is printed is
// a slice of it, unmodified (#2) — no second copy of a plan body exists anywhere.
//
//   node tools/plan-block.mjs <plan.md|plan-name> <id>              # that block, verbatim, on stdout
//   node tools/plan-block.mjs <plan.md|plan-name> --list            # the file's control OBJECT as JSON
//   node tools/plan-block.mjs <plan.md|plan-name> <id> --kind section    # migrate's blocks + gates
//   node tools/plan-block.mjs <plan.md|plan-name> <id> --kind component  # gauntlet's blocks + gates
//
// The default kind carries a metadata grammar, read from THREE contiguous runs of `key: value` lines and
// nowhere else — the file keys that open the file, the preamble under each `## Plan:` header, and the
// `- key:` run under each `### [<id>]` issue entry. A line that misses the run shape ends the run, which
// is what keeps a plan body's own prose (`kind:` and `details:` under `## Test Strategy`) out of the
// metadata. The blank line markdown puts above a run — under a heading, under a `---` fence — is crossed
// to FIND that run, never to continue one. `--kind section` and `--kind component` see none of it.
//
// A bare <plan-name> (no path separator, no .md) resolves to
// <CLAUDE_CONFIG_DIR | ~/.claude>/plans/<name>.md — where plan mode puts its files.
//
// Exit 0 on success; exit 1 with the reason on stderr. Every failure is loud and names the id: an
// unknown id, a duplicate id, an empty body or a missing gate must never resolve to a plausible-looking
// default, because the consumer is an agent that would build against it.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The three engines that decompose one plan file into id-addressed units. `gates` mirrors each engine's
// own VALID_GATES: a value outside the set falls back to `green` inside the engine, silently.
// `gateStyle` is the ONE place that kind's gate may be written — deliberately not "either shape
// anywhere in the body", which let a `gate:` line in prose outrank the real one and emit a confident
// `build-only` (the engine then accepts a feature on a green build with nothing tested).
// `metadata` marks the kind that parses the grammar in the header comment. It carries no `gates` or
// `withTitle` of its own: its gate set is per BLOCK (MODE_GATES, keyed by the block's mode), and its
// `--list` object always carries a title. Both of those belong to the alias kinds' array emitter.
export const KINDS = {
  plan: {
    noun: 'plan', keyword: 'Plan', metadata: true,
    gateStyle: 'preamble-then-heading',   // the preamble `gate:` line, else the LAST "## Gate" heading
  },
  section: {
    noun: 'section', keyword: 'Section', withTitle: true,
    gates: ['green', 'red-baseline', 'build-only'],
    gateStyle: 'preamble',  // migrate's template: a "gate:" line above the first "###" subheading
  },
  component: {
    noun: 'component', keyword: 'Component', withTitle: true,
    // No red-baseline: gauntlet builds an MVP forward, so there is no intentionally-red step to declare.
    gates: ['green', 'build-only'],
    gateStyle: 'heading',   // gauntlet's COMPONENTS.md: the LAST "## Gate" heading, value on the next line
  },
};

// `id — title`: the separator needs surrounding space, so a kebab id keeps its own hyphens.
const TITLE_SPLIT_RE = /[ \t]+[—–-][ \t]+/;
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The kind's rules, or a loud failure — never a silent fallback to `plan`. */
export function kindOf(name = 'plan') {
  const kind = KINDS[name];
  if (!kind) throw new Error(`unknown --kind "${name}" — it is one of: ${Object.keys(KINDS).join(', ')}`);
  return kind;
}

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

/** Blank out fenced regions, preserving line count — for scans that must ignore examples. */
function stripFences(text) {
  let fence = '';
  return text.split('\n').map((raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const was = fence;
    fence = fenceState(line, fence);
    return (was || fence) ? '' : raw;   // drop the fence markers themselves and everything between
  }).join('\n');
}

// =============================================================================
// The default kind's metadata grammar — file keys, block preamble, issue entries
// =============================================================================

// One table per run, so an unrecognized key can name the run it was found in. `null` is free text; an
// array is the key's legal enum.
const FILE_KEYS = {
  goal: null,
  ordered: ['true', 'false'],
  suite: ['green', 'scoped'],
  sweep: ['goal-coverage', 'none'],
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
  preamble: { keys: PREAMBLE_KEYS, what: 'preamble key' },
  issue: { keys: ISSUE_KEYS, what: 'issue key' },
};

const MODE_GATES = {
  feature: ['green', 'build-only'],
  section: ['green', 'red-baseline', 'build-only'],
  fix: ['green'],
};
const FILE_DEFAULTS = { goal: '', ordered: false, suite: 'green', sweep: 'none' };
// A file carrying a section-mode block is a migration: its units run in order and the goal is swept at
// the end. Only the DEFAULTS flip — an explicit file key still wins.
const SECTION_FILE_DEFAULTS = { ordered: true, sweep: 'goal-coverage' };

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
    // passed the unknown-key guard and were then reported as set twice — a key nobody set.
    if (!Object.hasOwn(schema, key)) {
      throw new Error(`unknown ${what} "${key}" in "${quoted}" — the ${what}s are: ${Object.keys(schema).join(', ')}`);
    }
    if (Object.hasOwn(values, key)) {
      throw new Error(`${what} "${key}" is set twice in one run ("${quoted}") — two values for one key have no defined winner`);
    }
    const { value, valueStart, valueEnd } = valueSpan(line, line.text.indexOf(':'));
    const allowed = schema[key];
    if (allowed && !allowed.includes(value)) {
      throw new Error(`illegal ${what} "${key}: ${value}" — ${key} takes ${allowed.join(' | ')}`);
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

/**
 * Locate every unit block. Returns them in file order, bodies sliced verbatim.
 * A block runs from its own header to the next header of the SAME kind, or to end of file.
 *
 * Scanned line by line rather than by one /gm regex, because a header must be ignored inside a fenced
 * code block. A plan that shows the roadmap format in its own Implementation Steps would otherwise mint
 * a PHANTOM unit from the example AND truncate the real block at the opening fence — at exit 0, which
 * is the exact failure this tool exists to prevent.
 */
export function parseBlocks(rawText, kindName = 'plan') {
  const { keyword, noun, metadata } = kindOf(kindName);
  // A BOM sits before the first `^`, so header 1 would not match and its whole block would be swallowed
  // as "text before the first block" — one unit silently missing, exit 0. Stripped here rather than at
  // the file read, so every caller of the parser is covered. `shift` puts the reported positions back on
  // the raw bytes the caller read, which is what a write tool splices against.
  const { text, shift } = stripBom(rawText);
  const headerRe = new RegExp(`^##[ \\t]+${keyword}:[ \\t]*(.+?)[ \\t]*$`);
  // 1-3 leading spaces still renders as a heading in most markdown, but is not a block boundary here.
  // Silently dropping it would delete a whole unit the human can see, so it is a hard error.
  const indentedRe = new RegExp(`^[ \\t]{1,3}##[ \\t]+${keyword}:`);
  // A header that misses the shape any OTHER way (colon forgotten, a colon with no id, a space before the
  // colon, or written as `###`) is today neither a boundary nor an error — it is scanned as ordinary body
  // text, so its block MERGES into the previous one: the unit vanishes from the roadmap array AND the
  // survivor's gate flips to the merged tail's gate, at exit 0. Same silent-wrong-answer class as the
  // indent, so it gets the same hard error.
  // The kebab-token requirement in `noColonRe` is load-bearing: it is what keeps a prose heading such as
  // "## Plan Rationale" from throwing. The other three need no such guard — `## Plan :` and a bare
  // `## Plan:` have no legitimate reading as prose, and a `#{3,6}` header is the same class as the 1-3
  // space indent below: a heading the human reads as a boundary that the parser does not. All three were
  // scanned against every `.md`/`.mjs` in the repo for all three keywords: zero matches.
  const emptyIdRe = new RegExp(`^##[ \\t]+${keyword}:[ \\t]*$`);
  const noColonRe = new RegExp(`^##[ \\t]+${keyword}[ \\t]+[a-z0-9]+(?:-[a-z0-9]+)*[ \\t]*(?:$|[—–-][ \\t])`);
  const spacedColonRe = new RegExp(`^##[ \\t]+${keyword}[ \\t]+:`);
  const deepHeaderRe = new RegExp(`^#{3,6}[ \\t]+${keyword}:`);
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
    throw new Error(`unclosed "${fence}" code fence in this file — it swallows every ${noun} header after it; close the fence`);
  }

  if (indented.length) {
    throw new Error(`indented "## ${keyword}:" header(s) in this file: ${indented.join(' | ')} — a ${noun} header must start at column 0 to be a block boundary; un-indent it, or fence it if it is an example`);
  }

  if (malformed.length) {
    throw new Error(`malformed "## ${keyword}:" header(s) in this file: ${malformed.join(' | ')} — a ${noun} header must be "## ${keyword}: <id>"; fix the header, or fence it if it is an example`);
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
    if (!metadata) return block;                  // the alias kinds carry no metadata grammar at all

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

/**
 * The block's gate, read ONLY from the one place its kind documents (KINDS.gateStyle), with fenced
 * examples ignored. Anywhere-in-the-body matching let a `gate:` mentioned in prose, or a `## Gate` in a
 * quoted example, outrank the real one — and a wrong `build-only` is not a loud failure: the engine
 * accepts the feature the moment the build passes, with no test ever consulted.
 */
export function readGate(body, kindName = 'plan') {
  const { gateStyle } = kindOf(kindName);
  const clean = stripFences(body);

  // migrate: `gate: <x>` in the block's preamble, above the first "###" subheading.
  if (gateStyle === 'preamble') {
    const hit = clean.split(/^#{3,}[ \t]/m)[0].match(/^gate:[ \t]*([^\s#]+)/m);
    return hit ? hit[1] : null;
  }

  // plan: the preamble run's `gate:` line. Only a feature-mode block falls through to the heading below,
  // which is how every plan written before this grammar states its gate; section and fix declare it or
  // fail loudly, because their bodies have no `## Gate` convention to fall back on.
  if (gateStyle === 'preamble-then-heading') {
    const { values } = parsePreamble(body, bodyRunStart(body));
    if (values.gate !== undefined) return values.gate;
    if ((values.mode ?? 'feature') !== 'feature') return null;
  }

  // feature: the LAST "## Gate" heading in the block (its template puts it last), value on the next
  // non-empty line. Last, not first, so an earlier mention in an acceptance criterion cannot win.
  const headingRe = /^#{2,4}[ \t]+Gate[ \t]*\r?$/gm;
  let after = -1;
  let m = null;
  while ((m = headingRe.exec(clean)) !== null) after = m.index + m[0].length;
  if (after < 0) return null;

  const value = clean.slice(after).split(/\r?\n/).find((l) => l.trim() !== '');
  return value ? value.trim().split(/[ \t#]/)[0] || null : null;
}

/** Structural faults that must stop the run rather than reach an agent. */
export function validate(blocks, source, kindName = 'plan') {
  const { noun, keyword, metadata } = kindOf(kindName);
  const seen = new Map();   // id -> what claimed it, so a collision names both sides

  if (!blocks.length) {
    throw new Error(`no "## ${keyword}: <id>" blocks in ${source} — it needs one block per ${noun}`);
  }
  for (const block of blocks) {
    if (!KEBAB_RE.test(block.id)) {
      throw new Error(`${noun} id "${block.id}" in ${source} is not a kebab slug (a-z, 0-9, single hyphens) — it routes file names, so it cannot contain spaces or punctuation`);
    }
    if (seen.has(block.id)) {
      throw new Error(`${noun} id "${block.id}" appears twice in ${source} — two ${noun}s would share one DISMISSED-${block.id}.md and one review file`);
    }
    if (!block.body.trim()) {
      throw new Error(`${noun} "${block.id}" in ${source} has an empty body — the developer would be handed a header and nothing else`);
    }
    seen.set(block.id, `${noun} "${block.id}"`);
    if (metadata) validateMetadata(block, source, noun, seen);
  }
  return blocks;
}

/**
 * The default kind's per-block rules: the gate against the block's OWN mode, and the issue entries a
 * fix-mode block may carry. Block ids and issue ids share `seen`, because both route file names.
 */
function validateMetadata(block, source, noun, seen) {
  const gates = MODE_GATES[block.mode];
  const gate = block.preamble.values.gate;

  if (gate !== undefined && !gates.includes(gate)) {
    throw new Error(`${noun} "${block.id}" in ${source} declares "gate: ${gate}", which mode ${block.mode} does not allow — a ${block.mode}-mode ${noun} takes ${gates.join(' | ')}`);
  }
  if (block.mode !== 'fix' && block.issues.length) {
    throw new Error(`${noun} "${block.id}" in ${source} is mode ${block.mode} but carries issue entries (${block.issues.map((e) => `[${e.id}]`).join(', ')}) — a "### [<id>]" entry is legal only under a fix-mode ${noun}`);
  }
  for (const entry of block.issues) {
    if (!KEBAB_RE.test(entry.id)) {
      throw new Error(`issue id "${entry.id}" in ${noun} "${block.id}" of ${source} is not a kebab slug (a-z, 0-9, single hyphens) — it routes file names, so it cannot contain spaces or punctuation`);
    }
    if (entry.values.id !== undefined && entry.values.id !== entry.id) {
      throw new Error(`issue "${entry.id}" in ${source} carries "- id: ${entry.values.id}" — the heading id and the id key disagree, and there is no rule for which one wins`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`id "${entry.id}" in ${source} is claimed twice (${seen.get(entry.id)} and an issue entry) — ${noun} ids and issue ids are one namespace, so the two would share one file name`);
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
// Output — one block verbatim, or the plan's control array
// =============================================================================

export function emitBlock(blocks, id, source, kindName = 'plan') {
  const { noun } = kindOf(kindName);
  const block = blocks.find((b) => b.id === id);

  if (!block) {
    throw new Error(`no ${noun} "${id}" in ${source} — it has: ${blocks.map((b) => b.id).join(', ')}`);
  }
  return block.text;
}

/**
 * The plan file's control object: the file keys with their defaults applied, then one row per block.
 * `fileKeys` is optional — a caller with only the blocks (the test suite) gets the documented defaults.
 */
function emitObjectList(blocks, source, kindName, fileKeys) {
  const { noun } = kindOf(kindName);
  const sets = Object.entries(MODE_GATES).map(([mode, legal]) => `${mode}: ${legal.join(' | ')}`).join(', ');
  const missing = [];
  const bad = [];

  const rows = blocks.map((block) => {
    const gates = MODE_GATES[block.mode];
    const gate = readGate(block.body, kindName);
    if (!gate) missing.push(`${block.id} (mode ${block.mode})`);
    else if (!gates.includes(gate)) bad.push(`${block.id} (${gate}, mode ${block.mode})`);
    return `    { "id": ${JSON.stringify(block.id)}, "title": ${JSON.stringify(block.title || block.id)}`
      + `, "mode": ${JSON.stringify(block.mode)}, "gate": ${JSON.stringify(gate)}`
      + `, "status": ${JSON.stringify(block.preamble.values.status ?? 'todo')} }`;
  });

  if (missing.length) {
    throw new Error(`no gate for: ${missing.join(', ')} in ${source} — add a "gate:" line to the ${noun}'s preamble (${sets}), or a "## Gate" heading to a feature-mode ${noun}; there is deliberately no default`);
  }
  if (bad.length) {
    throw new Error(`invalid gate for: ${bad.join(', ')} in ${source} — a ${noun} takes the set its own mode allows (${sets})`);
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

  return `{\n  "goal": ${JSON.stringify(head.goal)}, "ordered": ${head.ordered}`
    + `, "suite": ${JSON.stringify(head.suite)}, "sweep": ${JSON.stringify(head.sweep)},\n`
    + `  "blocks": [\n${rows.join(',\n')}\n  ]\n}\n`;
}

export function emitList(blocks, source, kindName = 'plan', fileKeys = null) {
  const { noun, gates, withTitle, metadata } = kindOf(kindName);
  if (metadata) return emitObjectList(blocks, source, kindName, fileKeys);

  // The alias kinds keep the array shape, byte for byte: their engines parse it as it stands today.
  const missing = [];
  const bad = [];

  const entries = blocks.map((block) => {
    const gate = readGate(block.body, kindName);
    if (!gate) missing.push(block.id);
    else if (!gates.includes(gate)) bad.push(`${block.id} (${gate})`);
    const title = withTitle ? ` "title": ${JSON.stringify(block.title || block.id)},` : '';
    return `  { "id": ${JSON.stringify(block.id)},${title} "gate": ${JSON.stringify(gate)} }`;
  });

  if (missing.length) {
    throw new Error(`no gate for: ${missing.join(', ')} in ${source} — add a gate line (${gates.join(' | ')}) to each ${noun}; there is deliberately no default`);
  }
  if (bad.length) {
    throw new Error(`invalid gate for: ${bad.join(', ')} in ${source} — a ${noun} takes ${gates.join(' | ')}`);
  }
  return `[\n${entries.join(',\n')}\n]\n`;
}

// =============================================================================
// CLI
// =============================================================================

const USAGE = `usage:
  node tools/plan-block.mjs <plan.md|plan-name> <id>       print that block, verbatim
  node tools/plan-block.mjs <plan.md|plan-name> --list     print the control object as JSON

  --kind plan (default) | section | component
      plan: "## Plan:" blocks, with file keys (goal, ordered, suite, sweep), a block preamble
      (mode, gate, status, test_selector, depends_on) and, under a fix-mode block,
      "### [<id>]" issue entries. --list emits { goal, ordered, suite, sweep, blocks: [...] }.
      section and component: migrate's "## Section:" and gauntlet's "## Component:" blocks,
      no metadata grammar, --list emits the array those engines read today.

a bare plan-name resolves to <CLAUDE_CONFIG_DIR | ~/.claude>/plans/<name>.md`;

/** Split `--kind <name>` out of argv, leaving the positionals. */
export function parseArgv(argv) {
  const positional = [];
  let kind = 'plan';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kind') {
      kind = argv[++i];
      if (kind === undefined) throw new Error('--kind needs a value (plan, section or component)');
    } else if (argv[i].startsWith('--kind=')) {
      kind = argv[i].slice('--kind='.length);
    } else {
      positional.push(argv[i]);
    }
  }
  return { positional, kind };
}

export function run(argv) {
  // Input
  const { positional, kind } = parseArgv(argv);
  const [rawPath, selector] = positional;
  if (!rawPath || !selector) throw new Error(USAGE);

  // Process
  const path = resolveRoadmap(rawPath);
  const text = readPlanFile(path);
  const blocks = validate(parseBlocks(text, kind), path, kind);
  // Parsed on every selector, not just --list: an unknown file key is a fault in the plan file itself,
  // and a developer fetching one block must not be the only caller that never sees it.
  const fileKeys = kindOf(kind).metadata ? parseFileKeys(text) : null;

  // Output
  return selector === '--list'
    ? emitList(blocks, path, kind, fileKeys)
    : emitBlock(blocks, selector, path, kind);
}

// Node resolves the MAIN module through realpath by default (`--preserve-symlinks-main` off), so
// `import.meta.url` is canonical while argv[1] is whatever the caller typed. A symlink or Windows junction
// anywhere in the script path made the two differ, `invokedDirectly` false, and the process wrote NOTHING
// at exit 0 — every loud failure above bypassed, which is the plausible-looking default this file forbids.
// Realpath BOTH sides, so it holds under `--preserve-symlinks-main` too.
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
