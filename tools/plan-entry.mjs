// tools/plan-entry.mjs: the backlog entry writer a develop agent runs at run time, and the only copy of a backlog
// file's header and entry shape. It reads and checks each file by plan-block's grammar.
//
//   node tools/plan-entry.mjs new --file <backlog.md> --block <id> --run <runId> --file-ref <path:line> --category <c>
//        --size <s> --decision <d> [--severity <s>] [--branch <b>] [--origin <o>] [--ledger <path>] [--amended <paths>]
//   node tools/plan-entry.mjs check <backlog.md>
//
// It is a separate file from plan-edit.mjs because the run-time allowlist rule covers every subcommand of the
// file it names, and plan-edit.mjs rewrites approved plans. This file only appends to a backlog file.
// tools/CLAUDE.md holds the contract.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEBAB_RE, listObject, parseBlocks, parseFileKeys, RUN_KEYS, validate } from './plan-block.mjs';
import { dominantEol, isPlaceholderLine, PLACEHOLDER } from './plan-edit.mjs';

// The backlog writers set only these, a narrower set than the issue grammar's, which debug's files also use.
const SIZES = ['trivial', 'small', 'medium', 'large'];
const DECISIONS = ['ACTIONABLE', 'NEEDS_USER'];
// Each entry flag of `new`, in the order its issue key line sits in the entry.
const ENTRY_FLAGS = [
  { flag: '--file-ref', key: 'file', required: true },
  { flag: '--severity', key: 'severity', legal: RUN_KEYS.issue.keys.severity },
  { flag: '--category', key: 'category', required: true },
  { flag: '--size', key: 'size', required: true, legal: SIZES },
  { flag: '--decision', key: 'decision', required: true, legal: DECISIONS },
  { flag: '--branch', key: 'branch' },
  { flag: '--origin', key: 'origin' },
  { flag: '--ledger', key: 'ledger' },
  { flag: '--amended', key: 'amended' },
];
const FILE_FLAGS = ['--file', '--block', '--run'];
const FLAGS = [...FILE_FLAGS, ...ENTRY_FLAGS.map((f) => f.flag)];

const USAGE = `usage:
  node tools/plan-entry.mjs new --file <backlog.md> --block <id> --run <runId> --file-ref <path:line>
      --category <category> --size <${SIZES.join('|')}> --decision <${DECISIONS.join('|')}>
      [--severity <${RUN_KEYS.issue.keys.severity.join('|')}>] [--branch <b>] [--origin <o>] [--ledger <path>] [--amended <paths>]
      append an entry with the next free id "<file name>-<n>" to the backlog file, writing the file's header
      first when the file is missing or blank, and print the id. The title, **What:** and **Fix:** hold
      "${PLACEHOLDER}" for the agent to replace.
  node tools/plan-entry.mjs check <backlog.md>
      report the file's first grammar error and each placeholder left in place, or print "ok: <file>".`;

// =============================================================================
// Text: pure functions over a file's content.
// =============================================================================

/** The file's header, as develop's backlog writers name a block and a run. */
const headerOf = (fileId, blockId, runId, eol) => [
  `## Plan: ${fileId} - backlog from block ${blockId} of run ${runId}`, 'mode: fix', 'gate: green', 'status: todo', '', '',
].join(eol);

/** The entry skeleton: the heading, the key lines in grammar order, and the two placeholder body lines. */
const entryOf = (id, values, eol) => [
  `### [${id}] ${PLACEHOLDER}`,
  `- id: ${id}`,
  '- status: open',
  ...ENTRY_FLAGS.filter((f) => values[f.key] !== undefined).map((f) => `- ${f.key}: ${values[f.key]}`),
  `**What:** ${PLACEHOLDER}`,
  `**Fix:** ${PLACEHOLDER}`,
  '',
].join(eol);

/** What goes between the file's last byte and a new entry, so the entry starts after one blank line. */
function separatorOf(text, eol) {
  if (!text.endsWith('\n')) return eol + eol;
  return /(?:^|\n)[ \t]*\r?\n$/.test(text) ? '' : eol;
}

/**
 * The file's one block, parsed and validated, or an error that says why the file is no backlog file. A header
 * with no entry yet skips the control-object check, which refuses a todo fix block with no entry.
 */
function backlogBlock(text, path, fileId, { complete = true } = {}) {
  parseFileKeys(text);
  const blocks = validate(parseBlocks(text), path);
  if (complete) listObject(blocks, path);
  const [block] = blocks;
  if (blocks.length !== 1 || block.mode !== 'fix' || block.id !== fileId) {
    throw new Error(`${path} is not a backlog file: one fix-mode block "## Plan: ${fileId}" is what a backlog file holds, and it holds ${blocks.map((b) => `"${b.id}" (mode ${b.mode})`).join(', ')}`);
  }
  return block;
}

/** The next free entry id: one past the highest <n> of the file's "<file name>-<n>" ids. */
function nextId(block, fileId) {
  const prefix = `${fileId}-`;
  const numbers = block.issues
    .map((entry) => entry.id)
    .filter((id) => id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length)))
    .map((id) => Number(id.slice(prefix.length)));
  return `${prefix}${Math.max(0, ...numbers) + 1}`;
}

/** The file's text with the entry appended, and a skip status set to todo, since a backlog build takes only todo and done files. */
export function appendEntry(text, path, { blockId, runId, values }) {
  // Input
  const fileId = basename(path).replace(/\.md$/i, '');
  const eol = dominantEol(text);
  const blank = !text.trim();
  const base = blank ? headerOf(fileId, blockId, runId, eol) : text;
  const block = backlogBlock(base, path, fileId, { complete: false });
  const status = block.preamble.keys.find((k) => k.key === 'status');
  const id = nextId(block, fileId);

  // Process
  const reopened = status?.value === 'skip' ? base.slice(0, status.valueStart) + 'todo' + base.slice(status.valueEnd) : base;
  const next = reopened + separatorOf(reopened, eol) + entryOf(id, values, eol);
  // The appended text goes back through the parser, so a value the grammar refuses never reaches disk.
  const entry = backlogBlock(next, path, fileId).issues.find((e) => e.id === id);
  const lost = ENTRY_FLAGS.filter((f) => values[f.key] !== undefined && entry?.values[f.key] !== values[f.key]);
  if (!entry || lost.length) {
    throw new Error(`the entry ${id} would not read back from ${path}${lost.length ? ` (${lost.map((f) => f.flag).join(', ')})` : ''}, so nothing was written`);
  }

  // Output
  return { id, text: next };
}

/** The file's problems: its first grammar error, then each placeholder left in place, by line and entry. */
function checkText(text, path) {
  const problems = [];
  try {
    backlogBlock(text, path, basename(path).replace(/\.md$/i, ''));
  } catch (err) {
    problems.push(`grammar: ${err.message}`);
  }
  let entryId = '';
  text.split('\n').forEach((line, i) => {
    const heading = line.match(/^###[ \t]+\[([^\]]*)\]/);
    if (heading) entryId = heading[1].trim();
    if (isPlaceholderLine(line)) problems.push(`placeholder on line ${i + 1}${entryId ? ` of entry ${entryId}` : ''}: "${line.trim().slice(0, 80)}"`);
  });
  return problems;
}

// =============================================================================
// CLI: every read and write happens here.
// =============================================================================

/** Each flag's value, refused when a flag is unknown, repeated, valueless, blank or more than one line. */
function flagValues(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!FLAGS.includes(flag) || value === undefined || Object.hasOwn(flags, flag)) throw new Error(USAGE);
    if (!value.trim() || /[\r\n]/.test(value)) throw new Error(`${flag} takes one non-blank line, got ${JSON.stringify(value)}`);
    flags[flag] = value.trim();
  }
  const missing = [...FILE_FLAGS, ...ENTRY_FLAGS.filter((f) => f.required).map((f) => f.flag)].filter((f) => !Object.hasOwn(flags, f));
  if (missing.length) throw new Error(`missing ${missing.join(', ')}\n${USAGE}`);
  for (const { flag, legal } of ENTRY_FLAGS) {
    if (legal && Object.hasOwn(flags, flag) && !legal.includes(flags[flag])) throw new Error(`${flag} takes ${legal.join(' | ')}, got "${flags[flag]}"`);
  }
  return flags;
}

function runNew(argv) {
  // Input
  const flags = flagValues(argv);
  const path = flags['--file'];
  if (!/\.md$/i.test(path)) throw new Error(`--file names a backlog file, which ends .md, got "${path}"`);
  // plan-edit.mjs args --backlog reads the writer block from the header only when its id is a kebab slug.
  if (!KEBAB_RE.test(flags['--block'])) throw new Error(`--block takes a block id, a kebab slug (a-z, 0-9, single hyphens), got "${flags['--block']}"`);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const values = Object.fromEntries(ENTRY_FLAGS.filter((f) => Object.hasOwn(flags, f.flag)).map((f) => [f.key, flags[f.flag]]));

  // Process
  const { id, text: next } = appendEntry(text, path, { blockId: flags['--block'], runId: flags['--run'], values });

  // Output
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next);
  return `${id}\nAppended the entry ${id} to ${path}. Replace its title and each "${PLACEHOLDER}" in it with the Edit tool, then run this tool's check verb on the file.\n`;
}

function runCheck(argv) {
  const [path, ...rest] = argv;
  if (!path || rest.length) throw new Error(USAGE);
  if (!existsSync(path)) throw new Error(`no backlog file at ${path}`);
  const problems = checkText(readFileSync(path, 'utf8'), path);
  if (problems.length) throw new Error(`${path} has ${problems.length} problem(s):\n${problems.join('\n')}`);
  return `ok: ${path}\n`;
}

export function run(argv) {
  const [command, ...rest] = argv;
  if (command === 'new') return runNew(rest);
  if (command === 'check') return runCheck(rest);
  throw new Error(USAGE);
}

// Node resolves the main module through realpath, so both sides are realpathed, as in plan-block.mjs.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plan-entry: ${err.message}\n`);
    process.exit(1);
  }
}
