// tools/project-settings.mjs: each project's settings, saved under a state root so Claude asks for them once, and
// the folder that holds the project's backlog.
//
// The store is <root>/projects.json, a JSON object that maps a repo key to the repo's settings, an object whose
// optional fields are `changePolicy` (the policy develop and debug take, focused or proactive), `commit` (a
// boolean, whether develop commits each accepted block) and `models` and `efforts` (each maps a role key to the
// model or reasoning level develop gives that role). The key is the repo's main checkout, so a linked worktree
// shares its settings and its backlog folder.
//
//   node tools/project-settings.mjs check --root <dir> --repo <dir>      # "<policy> <key>" or "missing <key> recommend=<policy>"
//   node tools/project-settings.mjs backlog --root <dir> --repo <dir>    # "<root>/backlog/<project>/"
//   node tools/project-settings.mjs set --root <dir> --repo <dir> [--policy focused|proactive] [--commit on|off]
//                                                                         # "set <key> [<policy>] [commit=<on|off>] in <store>"
//   node tools/project-settings.mjs commit --root <dir> --repo <dir>     # "on <key>", "off <key>" or "missing <key>"
//   node tools/project-settings.mjs roles --root <dir> --repo <dir>      # {"models":{...},"efforts":{...}}
//   node tools/project-settings.mjs set-roles --root <dir> --repo <dir> [--models <role>=<value>,...] [--efforts <role>=<value>,...]
//                                                                         # "set-roles <key> {...} in <store>"
//
// The recommendation is proactive when the repo has no commits or every commit's author email is the user's
// `git config user.email`, and focused otherwise. A repo that saved no policy reads `missing` from check, whatever else
// it saved. set needs --policy or --commit and keeps every other saved setting. backlog reads no setting and creates
// nothing. commit and roles never ask or recommend. set-roles merges each named role
// into the saved map, and the value `default` removes that role's saved value. Every failure exits 1 with its cause
// on stderr, and a write never replaces a store it cannot parse. Ordinary Node: `node --check` applies.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUN_KEYS } from './plan-block.mjs';
import { foldsCase } from './trash.mjs';

const POLICIES = ['focused', 'proactive'];
// The old name of focused, which set rejects with the rename.
const RETIRED_POLICY = 'strict';
export const STORE_FILE = 'projects.json';
const BACKLOG_DIR = 'backlog';
// At most 4 bytes each in UTF-8, so a backlog folder name stays inside the 255-byte limit of common file systems.
const SEGMENT_MAX = 48;
const NOT_IN_FILE_NAMES = /[<>:"\\|?*\u0000-\u001f]/g;
// The engine cannot import tools, so workflows/develop/develop-cycle.mjs holds its own copy of the role keys, and a
// test compares it. The two enums come from the plan block grammar, which already holds them for `model:` and `effort:`.
export const ROLE_KEYS = ['develop', 'park', 'quality', 'acceptance', 'sweep'];
export const MODELS = RUN_KEYS.preamble.keys.model;
export const EFFORTS = RUN_KEYS.preamble.keys.effort;
const ROLE_SETS = { models: MODELS, efforts: EFFORTS };
const SETTING_FIELDS = ['changePolicy', 'commit', ...Object.keys(ROLE_SETS)];
const COMMIT_CHOICES = { on: true, off: false };
const UNSET = 'default';
const VERBS = {
  check: { required: ['root', 'repo'], anyOf: [] },
  backlog: { required: ['root', 'repo'], anyOf: [] },
  set: { required: ['root', 'repo'], anyOf: ['policy', 'commit'] },
  commit: { required: ['root', 'repo'], anyOf: [] },
  roles: { required: ['root', 'repo'], anyOf: [] },
  'set-roles': { required: ['root', 'repo'], anyOf: Object.keys(ROLE_SETS) },
};
const USAGE = 'usage: node tools/project-settings.mjs check|backlog|commit|roles --root <dir> --repo <dir>'
  + ' | set --root <dir> --repo <dir> [--policy focused|proactive] [--commit on|off]'
  + ' | set-roles --root <dir> --repo <dir> [--models <role>=<value>,...] [--efforts <role>=<value>,...]';
const FOLDS_CASE = foldsCase(process.platform);

const toPosix = (p) => p.replace(/\\/g, '/');
const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fold = (key, foldCase) => (foldCase ? key.toLowerCase() : key);
const firstLine = (text) => String(text).split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';

/** The role map that `<role>=<value>,...` names for `--<flag>`, each value in `legal` or the word that removes the
 *  role's saved value. Throws on a malformed pair, a role outside the role keys, a value outside its set or a role named twice. */
function parseRolePairs(flag, text, legal) {
  // Input
  const map = {};

  // Process
  for (const pair of text.split(',')) {
    const parts = pair.split('=');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      throw new Error(`--${flag} has the pair ${JSON.stringify(pair)}, which is not <role>=<value>`);
    }
    const [role, value] = parts;
    if (!ROLE_KEYS.includes(role)) throw new Error(`--${flag} names the role ${JSON.stringify(role)}, and the role keys are ${ROLE_KEYS.join(' | ')}`);
    if (!legal.includes(value) && value !== UNSET) {
      throw new Error(`--${flag} gives ${role} the value ${JSON.stringify(value)}, which is none of ${[...legal, UNSET].join(' | ')}`);
    }
    if (Object.hasOwn(map, role)) throw new Error(`--${flag} names the role ${role} twice`);
    map[role] = value;
  }

  // Output
  return map;
}

/** `<verb> --flag value...`, validated: every required flag of the verb is present, and nothing is coerced. */
function parseArgv(argv) {
  // Input
  const [verb, ...rest] = argv;
  if (!verb || !Object.hasOwn(VERBS, verb)) throw new Error(`${verb ? `unknown verb "${verb}"` : 'no verb given'}. ${USAGE}`);
  const { required, anyOf } = VERBS[verb];
  const flags = [...required, ...anyOf];
  const opt = {};

  // Process
  for (let i = 0; i < rest.length; i += 2) {
    const token = rest[i];
    const value = rest[i + 1];
    const name = token.startsWith('--') ? token.slice(2) : null;
    if (name === null) throw new Error(`unexpected argument "${token}". Every value follows its own flag. ${USAGE}`);
    if (!flags.includes(name)) throw new Error(`unknown flag "${token}" for ${verb}, which takes ${flags.map((f) => `--${f}`).join(' ')}`);
    if (Object.hasOwn(opt, name)) throw new Error(`${token} was given twice`);
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`${token} needs a value`);
    opt[name] = value;
  }
  const missing = required.filter((f) => !Object.hasOwn(opt, f));
  if (missing.length) throw new Error(`${verb} needs ${missing.map((f) => `--${f}`).join(' ')}. ${USAGE}`);
  if (anyOf.length && !anyOf.some((f) => Object.hasOwn(opt, f))) {
    throw new Error(`${verb} needs ${anyOf.map((f) => `--${f}`).join(' or ')}. ${USAGE}`);
  }
  if (Object.hasOwn(opt, 'policy') && !POLICIES.includes(opt.policy)) {
    throw new Error(opt.policy === RETIRED_POLICY
      ? `--policy "${RETIRED_POLICY}" is now named focused. Pass --policy focused.`
      : `--policy "${opt.policy}" is neither focused nor proactive`);
  }
  if (Object.hasOwn(opt, 'commit')) {
    if (!Object.hasOwn(COMMIT_CHOICES, opt.commit)) throw new Error(`--commit "${opt.commit}" is neither on nor off`);
    opt.commit = COMMIT_CHOICES[opt.commit];
  }
  for (const [name, legal] of Object.entries(ROLE_SETS)) {
    if (Object.hasOwn(opt, name)) opt[name] = parseRolePairs(name, opt[name], legal);
  }

  // Output
  return { verb, opt };
}

/** The key for the real path of a git common dir. A common dir named .git keys its main checkout. Any other,
 *  such as a bare repository, a submodule or a separate git dir, keys itself. */
export function repoKey(commonDir) {
  return toPosix(basename(commonDir) === '.git' ? dirname(commonDir) : commonDir);
}

/** The store's own key that names `key`, or null. */
export function savedKey(store, key, foldCase) {
  return Object.keys(store).find((k) => fold(k, foldCase) === fold(key, foldCase)) ?? null;
}

/** The store with `change` applied to `key`'s settings, every other key kept, and any spelling of `key` the fold
 *  matches dropped. `change` maps the saved settings to the new ones, and settings with no field leave no entry for
 *  `key`. Never mutates. */
function withSettings(store, key, change, foldCase) {
  const saved = savedKey(store, key, foldCase);
  const settings = saved === null ? {} : store[saved];
  const others = Object.entries(store).filter(([k]) => fold(k, foldCase) !== fold(key, foldCase));
  const changed = change(settings);
  return Object.fromEntries(Object.keys(changed).length ? [...others, [key, changed]] : others);
}

/** The store with `key`'s policy set to `policy`. */
export function withPolicy(store, key, policy, foldCase) {
  return withSettings(store, key, (settings) => ({ ...settings, changePolicy: policy }), foldCase);
}

/** The store with `key`'s commit choice set to the boolean `commit`. */
export function withCommit(store, key, commit, foldCase) {
  return withSettings(store, key, (settings) => ({ ...settings, commit }), foldCase);
}

/** The store with each role that `updates` names merged into `key`'s saved `models` and `efforts` maps. `updates`
 *  maps a field to a role map. The value `default` removes a role, and a map left empty is dropped. */
export function withRoles(store, key, updates, foldCase) {
  const change = (settings) => {
    const next = { ...settings };
    for (const [field, roles] of Object.entries(updates)) {
      const merged = { ...settings[field], ...roles };
      for (const [role, value] of Object.entries(merged)) if (value === UNSET) delete merged[role];
      if (Object.keys(merged).length) next[field] = merged;
      else delete next[field];
    }
    return next;
  };
  return withSettings(store, key, change, foldCase);
}

/** The backlog folder name for `key`. The hash keeps apart two repos with the same folder name, and the segment
 *  loses each character a Windows file name refuses, such as a drive's colon, so the name is valid everywhere. */
export function projectName(key, foldCase) {
  const lastSegment = key.split('/').filter(Boolean).pop() ?? '';
  const segment = Array.from(lastSegment.replace(NOT_IN_FILE_NAMES, '')).slice(0, SEGMENT_MAX).join('');
  const hash = createHash('sha256').update(fold(key, foldCase)).digest('hex').slice(0, 8);
  return `${segment}-${hash}`;
}

/** What is wrong with the role map that a store gives `name` in `field`, or null. */
function roleMapProblem(name, field, map, legal) {
  if (!isJsonObject(map)) return `gives ${name} ${field} of ${JSON.stringify(map)}, which is not an object that maps a role key to a value`;
  const unknownRole = Object.keys(map).find((role) => !ROLE_KEYS.includes(role));
  if (unknownRole !== undefined) {
    return `gives ${name} the role ${JSON.stringify(unknownRole)} in ${field}, and the role keys are ${ROLE_KEYS.join(' | ')}`;
  }
  const badRole = Object.keys(map).find((role) => !legal.includes(map[role]));
  if (badRole !== undefined) {
    return `gives ${name} the ${field} value of ${JSON.stringify(map[badRole])} for ${badRole}, which is none of ${legal.join(' | ')}`;
  }
  return null;
}

/** What is wrong with the settings a store holds for `key`, or null. */
function settingsProblem(key, settings) {
  const name = JSON.stringify(key);
  if (!isJsonObject(settings)) return `maps ${name} to ${JSON.stringify(settings)}, which is not an object of repo settings`;
  const unknown = Object.keys(settings).find((field) => !SETTING_FIELDS.includes(field));
  if (unknown !== undefined) return `gives ${name} the field ${JSON.stringify(unknown)}, and the fields a repo takes are ${SETTING_FIELDS.join(', ')}`;
  if (Object.hasOwn(settings, 'changePolicy') && !POLICIES.includes(settings.changePolicy)) {
    return `gives ${name} a changePolicy of ${JSON.stringify(settings.changePolicy)}, which is neither focused nor proactive`;
  }
  if (Object.hasOwn(settings, 'commit') && typeof settings.commit !== 'boolean') {
    return `gives ${name} a commit of ${JSON.stringify(settings.commit)}, which is neither true nor false`;
  }
  const problems = Object.entries(ROLE_SETS)
    .filter(([field]) => Object.hasOwn(settings, field))
    .map(([field, legal]) => roleMapProblem(name, field, settings[field], legal));
  return problems.find((p) => p !== null) ?? null;
}

/** The store `text` holds, or an error naming `path` when it is not a JSON object of repo settings. */
function parseStore(text, path) {
  // Input
  let store = null;
  try {
    store = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path} does not parse as JSON (${err.message}). Nothing was written. Fix the file and run the command again.`);
  }

  // Process
  if (!isJsonObject(store)) throw new Error(`${path} does not hold a JSON object. Nothing was written. Fix the file and run the command again.`);
  const problem = Object.entries(store).map(([key, settings]) => settingsProblem(key, settings)).find((p) => p !== null);
  if (problem !== undefined) throw new Error(`${path} ${problem}. Nothing was written. Fix the file and run the command again.`);

  // Output
  return store;
}

function readStore(path) {
  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`cannot read ${path}: ${err.message}`);
  }
  return parseStore(text, path);
}

// Through a temp file and a rename in the same folder, so a failed write cannot leave the store half-written.
function writeStore(path, store) {
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new Error(`cannot write ${path}: ${err.message}`);
  }
}

function git(repo, args) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error) throw new Error(`cannot run git in ${repo}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

const gitFailure = (r) => firstLine(r.stderr) || `git exited ${r.code}`;

/** The repo's git common dir, as an absolute path. git answers a relative one from the main worktree. */
function gitCommonDir(repo) {
  const r = git(repo, ['rev-parse', '--git-common-dir']);
  if (r.code !== 0) throw new Error(`--repo ${repo} is not in a git repository: ${gitFailure(r)}`);
  const out = r.stdout.trim();
  return isAbsolute(out) ? out : resolve(repo, out);
}

/** `git config user.email` in `repo`, or null when it is unset or blank. */
function userEmail(repo) {
  const r = git(repo, ['config', '--get', 'user.email']);
  if (r.code === 1) return null;
  if (r.code !== 0) throw new Error(`reading git config user.email in ${repo} failed: ${gitFailure(r)}`);
  return r.stdout.trim() || null;
}

/** Whether every commit on every ref has `email` as its author email, compared case-insensitively. A repo with no
 *  commits passes. The authors stream, so a long history fills no buffer, and the walk stops at the first other. */
function onlyAuthor(repo, email) {
  const wanted = email === null ? null : email.toLowerCase();
  return new Promise((settle, reject) => {
    const child = spawn('git', ['-C', repo, 'log', '--all', '--no-show-signature', '--format=%ae'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let other = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (author) => {
      if (other || author.toLowerCase() === wanted) return;
      other = true;
      // Closing the pipe also stops a git that a launcher started, such as Git for Windows' cmd\git.exe, which
      // the kill does not reach.
      child.stdout.destroy();
      child.kill();
      settle(false);
    });
    child.on('error', (err) => reject(new Error(`cannot run git in ${repo}: ${err.message}`)));
    child.on('close', (code) => {
      if (other) return;
      if (code === 0) settle(true);
      else reject(new Error(`reading the commit authors of ${repo} failed: ${firstLine(stderr) || `git exited ${code}`}`));
    });
  });
}

const rolesOf = (settings) => ({ models: settings.models ?? {}, efforts: settings.efforts ?? {} });

async function main(argv) {
  // Input
  const { verb, opt } = parseArgv(argv);
  const repo = resolve(opt.repo);
  const root = resolve(opt.root);
  const storePath = join(root, STORE_FILE);
  const key = repoKey(realpathSync.native(gitCommonDir(repo)));

  // Process and output
  if (verb === 'backlog') return `${toPosix(join(root, BACKLOG_DIR, projectName(key, FOLDS_CASE)))}/\n`;
  const store = readStore(storePath);
  const saved = savedKey(store, key, FOLDS_CASE);
  const savedSettings = saved === null ? {} : store[saved];
  if (verb === 'set') {
    const policyChosen = Object.hasOwn(opt, 'policy');
    const commitChosen = Object.hasOwn(opt, 'commit');
    let next = store;
    if (policyChosen) next = withPolicy(next, key, opt.policy, FOLDS_CASE);
    if (commitChosen) next = withCommit(next, key, opt.commit, FOLDS_CASE);
    writeStore(storePath, next);
    const savedWords = [policyChosen ? opt.policy : null, commitChosen ? `commit=${opt.commit ? 'on' : 'off'}` : null].filter(Boolean);
    return `set ${key} ${savedWords.join(' ')} in ${storePath}\n`;
  }
  if (verb === 'commit') {
    if (!Object.hasOwn(savedSettings, 'commit')) return `missing ${key}\n`;
    return `${savedSettings.commit ? 'on' : 'off'} ${key}\n`;
  }
  if (verb === 'roles') return `${JSON.stringify(rolesOf(savedSettings))}\n`;
  if (verb === 'set-roles') {
    const updates = Object.fromEntries(Object.keys(ROLE_SETS).filter((f) => Object.hasOwn(opt, f)).map((f) => [f, opt[f]]));
    const next = withRoles(store, key, updates, FOLDS_CASE);
    const nextSettings = next[key] ?? {};
    // A change that leaves the settings as saved writes nothing, so removing an unsaved role creates no store entry.
    if (JSON.stringify(nextSettings) !== JSON.stringify(savedSettings)) writeStore(storePath, next);
    return `set-roles ${key} ${JSON.stringify(rolesOf(nextSettings))} in ${storePath}\n`;
  }
  if (Object.hasOwn(savedSettings, 'changePolicy')) return `${savedSettings.changePolicy} ${key}\n`;
  const recommendation = (await onlyAuthor(repo, userEmail(repo))) ? 'proactive' : 'focused';
  return `missing ${key} recommend=${recommendation}\n`;
}

// Realpath both sides, since a link in the script path makes argv[1] differ from import.meta.url and the CLI
// then prints nothing.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(await main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`project-settings: ${err.message}\n`);
    process.exitCode = 1;
  }
}
