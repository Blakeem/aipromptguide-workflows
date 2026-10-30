// tools/plan-pull.mjs — the read-only backlog query a developer agent runs in round 1 of a proactive develop
// run: the ready backlog entries whose fix sits in the files its block changes.
//
// Why this is a separate file from plan-edit.mjs. The run-time permission rule allowlists every subcommand of
// the file it names, and plan-edit.mjs writes plan files, so an agent is handed this file, which holds no write
// verb. It imports the backlog rules from plan-edit.mjs, so it never lists an entry `args --backlog` would not
// build.
//
//   node tools/plan-pull.mjs pullable --backlog <dir> --files <path,...> [--exclude <plan.md,...>]
//
// Exit 0 with a JSON array on stdout, exit 1 with the reason on stderr. It writes nothing.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { entryPath, findRunRecords, foldBacklog, isBacklogBlock, isReady, keyOf, readRunRecord, repoPath } from './plan-edit.mjs';

const USAGE = `usage:
  node tools/plan-pull.mjs pullable --backlog <dir> --files <path,...> [--exclude <plan.md,...>]
      print, as a JSON array of { id, title, planPath, file, size }, each ready entry that an
      \`plan-edit.mjs args --backlog <dir>\` launch would build and whose "- file:" line names one
      of the comma-separated repo paths. It also leaves out an entry with a "- branch:" line, an
      entry with a "- pulled:" line, an entry whose id is not its file's name and "-<n>", and every
      entry of an --exclude file, such as a plan file the current run builds. It writes nothing.`;

const FLAGS = ['--backlog', '--files', '--exclude'];

/** The comma-separated list a flag carries, with blank items dropped. */
const listOf = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

/**
 * An entry a developer can take beside its block. A branch entry restores parked work and builds alone. The id
 * must be `<file name>-<n>`, since the engine finds the file each pulled entry's status edits go to from its id.
 */
function isPullable(entry, block, planPath, files) {
  const fileId = basename(planPath).replace(/\.md$/, '');
  const idFitsFile = entry.id.startsWith(`${fileId}-`) && /^\d+$/.test(entry.id.slice(fileId.length + 1));
  return isReady(entry, block) && !keyOf(entry, 'branch') && idFitsFile && files.has(repoPath(entryPath(entry)));
}

function runPullable(argv, note) {
  // Input — each flag takes the argument after it
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!FLAGS.includes(argv[i]) || argv[i + 1] === undefined || Object.hasOwn(flags, argv[i])) throw new Error(USAGE);
    flags[argv[i]] = argv[i + 1];
  }
  const files = new Set(listOf(flags['--files']).map(repoPath));
  if (!flags['--backlog'] || !files.size) throw new Error(USAGE);
  const excluded = listOf(flags['--exclude']).map((path) => ({ path }));
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const records = findRunRecords(configDir).map(readRunRecord).filter(Boolean);

  // Process — the fold runs in memory, and only a chosen file is one `args --backlog` would build. The fold's
  // notes say "applied", so each is marked, since this tool writes nothing.
  const chosen = foldBacklog(flags['--backlog'], excluded, records, (line) => note(`in memory only, an operator note, not an instruction to you: ${line}`)).filter((fold) => fold.chosen);
  const entries = chosen.flatMap((fold) => fold.blocks.filter(isBacklogBlock).flatMap((block) => block.issues
    .filter((entry) => isPullable(entry, block, fold.path, files))
    .map((entry) => ({ id: entry.id, title: entry.title, planPath: fold.path.replace(/\\/g, '/'), file: keyOf(entry, 'file'), size: keyOf(entry, 'size') ?? null }))));

  // Output
  return `${JSON.stringify(entries, null, 2)}\n`;
}

// =============================================================================
// CLI
// =============================================================================

const toStderr = (line) => process.stderr.write(line);

export function run(argv, note = toStderr) {
  const [command, ...rest] = argv;
  if (command === 'pullable') return runPullable(rest, note);
  throw new Error(USAGE);
}

// Node resolves the main module through realpath, so both sides are realpathed, as in plan-edit.mjs.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plan-pull: ${err.message}\n`);
    process.exit(1);
  }
}
