// tools/plan-block.mjs — print ONE unit's block out of a multi-unit plan file, byte-exact.
//
// Why this exists. feature-cycle's roadmap and migrate-cycle's decomposition both live in ONE approved
// plan file (the file plan mode mints), carrying one block per unit — `## Plan: <id>` for a feature,
// `## Section: <id>` for a migration section. Agents are handed a COMMAND that prints their own block
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
//   node tools/plan-block.mjs <plan.md|plan-name> --list            # [{ id, gate }, ...] as JSON
//   node tools/plan-block.mjs <plan.md|plan-name> <id> --kind section    # migrate's blocks + gates
//
// A bare <plan-name> (no path separator, no .md) resolves to
// <CLAUDE_CONFIG_DIR | ~/.claude>/plans/<name>.md — where plan mode puts its files.
//
// Exit 0 on success; exit 1 with the reason on stderr. Every failure is loud and names the id: an
// unknown id, a duplicate id, an empty body or a missing gate must never resolve to a plausible-looking
// default, because the consumer is an agent that would build against it.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The two engines that decompose one plan file into id-addressed units. `gates` mirrors each engine's
// own VALID_GATES: a value outside the set falls back to `green` inside the engine, silently.
// `gateStyle` is the ONE place that kind's gate may be written — deliberately not "either shape
// anywhere in the body", which let a `gate:` line in prose outrank the real one and emit a confident
// `build-only` (the engine then accepts a feature on a green build with nothing tested).
export const KINDS = {
  plan: {
    noun: 'plan', keyword: 'Plan', withTitle: false,
    gates: ['green', 'build-only'],
    gateStyle: 'heading',   // feature's template: the LAST "## Gate" heading, value on the next line
  },
  section: {
    noun: 'section', keyword: 'Section', withTitle: true,
    gates: ['green', 'red-baseline', 'build-only'],
    gateStyle: 'preamble',  // migrate's template: a "gate:" line above the first "###" subheading
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
  const { keyword, noun } = kindOf(kindName);
  // A BOM sits before the first `^`, so header 1 would not match and its whole block would be swallowed
  // as "text before the first block" — one unit silently missing, exit 0. Stripped here rather than at
  // the file read, so every caller of the parser is covered.
  const text = rawText.replace(/^﻿/, '');
  const headerRe = new RegExp(`^##[ \\t]+${keyword}:[ \\t]*(.+?)[ \\t]*$`);
  // 1-3 leading spaces still renders as a heading in most markdown, but is not a block boundary here.
  // Silently dropping it would delete a whole unit the human can see, so it is a hard error.
  const indentedRe = new RegExp(`^[ \\t]{1,3}##[ \\t]+${keyword}:`);
  const headers = [];
  const indented = [];
  let offset = 0;
  let fence = '';

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const wasFenced = fence;
    fence = fenceState(line, fence);

    if (!wasFenced && !fence) {
      const hit = line.match(headerRe);
      if (hit) headers.push({ start: offset, bodyStart: offset + line.length, label: hit[1] });
      else if (indentedRe.test(line)) indented.push(line.trim());
    }
    offset += raw.length + 1;
  }

  if (indented.length) {
    throw new Error(`indented "## ${keyword}:" header(s) in this file: ${indented.join(' | ')} — a ${noun} header must start at column 0 to be a block boundary; un-indent it, or fence it if it is an example`);
  }

  return headers.map((header, i) => {
    const end = i + 1 < headers.length ? headers[i + 1].start : text.length;
    const [rawId, ...titleParts] = header.label.split(TITLE_SPLIT_RE);
    return {
      id: rawId.trim(),
      title: titleParts.join(' - ').trim(),
      text: text.slice(header.start, end),        // header + body, what the agent is given
      body: text.slice(header.bodyStart, end),    // body alone, what gate/emptiness checks read
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
  const { noun, keyword } = kindOf(kindName);
  const seen = new Set();

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
    seen.add(block.id);
  }
  return blocks;
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

export function emitList(blocks, source, kindName = 'plan') {
  const { noun, gates, withTitle } = kindOf(kindName);
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
  node tools/plan-block.mjs <plan.md|plan-name> --list     print the control array as JSON

  --kind plan (default) | section        feature's "## Plan:" blocks, or migrate's "## Section:"

a bare plan-name resolves to <CLAUDE_CONFIG_DIR | ~/.claude>/plans/<name>.md`;

/** Split `--kind <name>` out of argv, leaving the positionals. */
export function parseArgv(argv) {
  const positional = [];
  let kind = 'plan';

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--kind') {
      kind = argv[++i];
      if (kind === undefined) throw new Error('--kind needs a value (plan or section)');
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
  const blocks = validate(parseBlocks(readPlanFile(path), kind), path, kind);

  // Output
  return selector === '--list' ? emitList(blocks, path, kind) : emitBlock(blocks, selector, path, kind);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plan-block: ${err.message}\n`);
    process.exit(1);
  }
}
