// tools/launch.mjs — reserves a new launch folder in a workflow's stateDir, so each launch writes its record
// files where no other launch writes, and no relaunch replaces a record an earlier launch wrote.
//
//   node tools/launch.mjs reserve <stateDir> [--keep <path>]...
//
// `reserve` creates the stateDir when it is missing and then `<stateDir>/launch-<n>`, with <n> one past the
// highest launch folder there, or 1 when there is none. Each `--keep` path, absolute or relative to the
// stateDir, that exists is copied into `<launchDir>/kept/` under its own base name, a link as the file or
// folder it names, so a working document is kept as it was before a launch that may rewrite it. A path that
// does not exist is skipped. It prints one JSON line,
// `{"launchDir":"<absolute path with forward slashes>","kept":[<each copy's path>]}`, each path in the
// caller's spelling of the stateDir.
//
// Exit 0 on success. Exit 1 with the reason on stderr, and nothing created, on a usage error: a missing or
// relative stateDir or more than one, an unknown verb or flag, and a `--keep` with no path, with no base
// name, that is the stateDir or a folder that holds it, or that shares its base name, case ignored, with
// another `--keep`.
// A copy that fails exits 1 and names the launch folder it reserved, which no later reserve returns.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PLUGIN_ROOT, orphanRefusal } from './plugin-access.mjs';

const USAGE = 'usage: node tools/launch.mjs reserve <stateDir> [--keep <path>]...';
const LAUNCH_DIR_NAME = /^launch-([1-9]\d*)$/;
const KEPT_DIR = 'kept';

const slashed = (path) => path.replace(/\\/g, '/');

/** True when `path` is `dir` or a folder that holds it, so copying it into `dir` would copy into itself. */
const holds = (path, dir) => {
  const rel = relative(path, dir);
  // A child folder may be named `..cache`, so only a `..` segment leads out.
  const leadsOut = rel === '..' || rel.startsWith(`..${sep}`);
  return rel === '' || (!leadsOut && !isAbsolute(rel));
};

/** The `dev:ino` key of `path` after links, or null when it is missing or its file system gives no inode. */
const identity = (path) => {
  const stats = statSync(path, { bigint: true, throwIfNoEntry: false });
  return stats && stats.ino !== 0n ? `${stats.dev}:${stats.ino}` : null;
};

/**
 * The identity of `dir` and of each existing folder above it. A link, a case-folded spelling or an 8.3 short
 * name of one of them has the same identity, which a comparison of spellings misses.
 */
function ancestorIdentities(dir) {
  const ids = new Set();
  for (let current = dir; ; current = dirname(current)) {
    const id = identity(current);
    if (id) ids.add(id);
    if (dirname(current) === current) return ids;
  }
}

/**
 * Copies the file or folder `source` to the new path `copy`, a link at any depth as the file or folder it
 * names. Node 24's cpSync applies `dereference` to the top source only and keeps a nested symlink as a link.
 */
function copyDereferenced(source, copy, openFolders = new Set()) {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, copy, constants.COPYFILE_EXCL);
    return;
  }
  const id = identity(source);
  // A link to a folder that holds it would copy without end.
  if (id && openFolders.has(id)) throw new Error(`${slashed(source)} is a link to a folder that holds it`);
  mkdirSync(copy);
  const inside = new Set(openFolders).add(id);
  for (const name of readdirSync(source)) copyDereferenced(join(source, name), join(copy, name), inside);
}

/** The highest <n> among the `launch-<n>` entries of `stateDir`, or 0 when it holds none. */
function highestLaunch(stateDir) {
  let highest = 0;
  for (const name of readdirSync(stateDir)) {
    const match = LAUNCH_DIR_NAME.exec(name);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest;
}

/**
 * Reserves the next `launch-<n>` folder in the absolute `stateDir` and copies each existing `keepPaths` entry
 * into its `kept/` folder. Returns `{ launchDir, kept }`, every path absolute with forward slashes.
 */
export function reserve(stateDir, keepPaths = []) {
  // Input
  let launchDir = null;
  let next = 0;
  const kept = [];

  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error(`missing stateDir. ${USAGE}`);
  if (!isAbsolute(stateDir)) throw new Error(`stateDir must be an absolute path, since an engine compares launchDir with its own absolute stateDir. Got ${JSON.stringify(stateDir)}.`);
  const root = resolve(stateDir);
  // The printed paths keep the caller's spelling, since POSIX resolves a leading `//` to `/` and an engine
  // reads `//` as a UNC path, so a resolved spelling may name another stateDir to the engine.
  const printedRoot = slashed(stateDir).replace(/\/+$/, '');
  const sources = keepPaths.map((path) => resolve(root, path));
  // Taken before the reservation, so a path that only the new launch folder makes exist is skipped.
  const existing = sources.filter((source) => existsSync(source));
  const rootIds = ancestorIdentities(root);
  const seen = new Map();
  for (const [i, source] of sources.entries()) {
    const name = basename(source);
    // Windows and macOS fold case in a file name, where Plan.md and plan.md are one copy in kept/.
    const nameKey = name.toLowerCase();
    if (!name) throw new Error(`--keep ${JSON.stringify(keepPaths[i])} has no base name to copy it under.`);
    if (seen.has(nameKey)) throw new Error(`--keep ${JSON.stringify(seen.get(nameKey))} and --keep ${JSON.stringify(keepPaths[i])} share the base name ${name}, case ignored, so one copy would replace the other in ${KEPT_DIR}/.`);
    if (holds(source, root) || rootIds.has(identity(source))) throw new Error(`--keep ${JSON.stringify(keepPaths[i])} is the stateDir or a folder that holds it, so it would be copied into itself.`);
    seen.set(nameKey, keepPaths[i]);
  }

  // Process
  mkdirSync(root, { recursive: true });
  next = highestLaunch(root) + 1;
  // A reserve that runs at the same moment may take the same number, and mkdirSync without recursive fails on
  // a folder that exists, so each launch gets a folder no other reserve returned.
  for (;;) {
    const candidate = join(root, `launch-${next}`);
    try {
      mkdirSync(candidate);
      launchDir = candidate;
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      next += 1;
    }
  }
  for (const source of existing) {
    const copy = join(launchDir, KEPT_DIR, basename(source));
    try {
      mkdirSync(join(launchDir, KEPT_DIR), { recursive: true });
      // A link would show every later edit of its target, so the copy holds the bytes the link names.
      copyDereferenced(source, copy);
    } catch (err) {
      throw new Error(`copying ${slashed(source)} into ${slashed(join(launchDir, KEPT_DIR))} failed (${err.message}). The launch folder ${slashed(launchDir)} is reserved but incomplete, so reserve another.`);
    }
    kept.push(`${printedRoot}/launch-${next}/${KEPT_DIR}/${basename(source)}`);
  }

  // Output
  return { launchDir: `${printedRoot}/launch-${next}`, kept };
}

/** Runs one CLI call and returns its stdout text. Throws with the reason on any usage error. */
function run(argv) {
  // Input
  const [verb, ...rest] = argv;
  const positional = [];
  const keepPaths = [];

  if (verb !== 'reserve') throw new Error(verb === undefined ? `no verb given. ${USAGE}` : `unknown verb ${JSON.stringify(verb)}. ${USAGE}`);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--keep') {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--keep needs a path. ${USAGE}`);
      keepPaths.push(value);
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}. ${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) throw new Error(`reserve takes one stateDir, got ${positional.length}. ${USAGE}`);

  // Process + Output
  return `${JSON.stringify(reserve(positional[0], keepPaths))}\n`;
}

// Node resolves the MAIN module through realpath, so both sides are realpathed, as plan-edit.mjs does.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

// An orphaned plugin copy refuses before any verb, so a stale copy creates no folder. An import runs no check.
if (invokedDirectly) {
  try {
    const refusal = orphanRefusal(PLUGIN_ROOT);
    if (refusal) throw new Error(refusal);
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`launch: ${err.message}\n`);
    process.exit(1);
  }
}
