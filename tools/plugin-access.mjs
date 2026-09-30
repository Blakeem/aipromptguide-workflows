// tools/plugin-access.mjs: the one Read allow rule that lets the Workflow tool launch this plugin's engines.
//
// The Workflow tool takes a scriptPath only when the session may already read it, and an installed
// plugin's folder sits outside every project. A plugin cannot grant itself access, so each skill runs
// `check` first and, after the user agrees, `grant`. Claude Code reloads settings live, so the next
// launch in the same session passes.
//
//   node tools/plugin-access.mjs check    # "granted <rule> in <settings>" or "missing <rule> in <settings>"
//   node tools/plugin-access.mjs grant    # adds the rule to the user settings, a no-op when present
//
// The user settings are <$CLAUDE_CONFIG_DIR or ~/.claude>/settings.json. Ordinary Node: `node --check` applies.

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'usage: node tools/plugin-access.mjs check|grant';
const VERBS = ['check', 'grant'];
const DRIVE_RE = /^([A-Za-z]):\//;

const toPosix = (p) => p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
const isJsonObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The folder to grant. A cache install sits at <cache>/<marketplace>/<plugin>/<version>, and the
 *  version folder changes on every update, so the rule covers the plugin folder above it. */
export function grantDir(root, pluginName) {
  const parent = dirname(root);
  return basename(parent) === pluginName ? parent : root;
}

/** The permission-rule spelling of an absolute folder, measured on Windows: `~/` under home, else
 *  `//c/...` for a drive letter and `//...` for a POSIX root. */
export function ruleFor(dir, home) {
  // Input
  const folder = toPosix(dir);
  const homeFolder = toPosix(home);
  const windows = DRIVE_RE.test(folder);
  const fold = (p) => (windows ? p.toLowerCase() : p);
  let spelled = null;

  // Process
  if (folder.startsWith('//')) {
    throw new Error(`${dir} is a network path, and the Workflow tool refuses network scriptPaths`);
  }
  if (fold(folder).startsWith(`${fold(homeFolder)}/`)) spelled = `~/${folder.slice(homeFolder.length + 1)}`;
  else if (windows) spelled = folder.replace(DRIVE_RE, (_, letter) => `//${letter.toLowerCase()}/`);
  else spelled = `/${folder}`;

  // Output
  return `Read(${spelled}/**)`;
}

/** The settings with `rule` in permissions.allow, and whether it was already there. Never mutates. */
export function withRule(settings, rule) {
  // Input
  if (!isJsonObject(settings)) throw new Error('the settings file does not hold a JSON object');
  if (settings.permissions !== undefined && !isJsonObject(settings.permissions)) {
    throw new Error('permissions in the settings file is not a JSON object');
  }
  const permissions = settings.permissions ?? {};
  if (permissions.allow !== undefined && !Array.isArray(permissions.allow)) {
    throw new Error('permissions.allow in the settings file is not an array');
  }
  const allow = permissions.allow ?? [];

  // Process
  if (allow.includes(rule)) return { settings, present: true };

  // Output
  return { settings: { ...settings, permissions: { ...permissions, allow: [...allow, rule] } }, present: false };
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path} is not valid JSON (${err.message}). Nothing was written.`);
  }
}

// Through a temp file and a rename, so a failed write cannot leave the user's settings half-written.
// The rename lands on a link's target with the target's mode, so a dotfiles link and a 600 file survive.
function writeSettings(path, settings) {
  // Input
  const existed = existsSync(path);
  const dangling = !existed && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  // A rename onto a dangling link replaces the link, and writing through would invent a missing dotfiles folder.
  if (dangling) throw new Error(`${path} links to ${readlinkSync(path)}, which does not exist. Nothing was written.`);
  const target = existed ? realpathSync(path) : path;
  const mode = existed ? statSync(target).mode & 0o777 : null;
  const temp = `${target}.${process.pid}.tmp`;

  // Process
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: mode ?? 0o666 });
  // The umask can strip bits from the create mode, so the target's mode is then set exactly.
  if (mode !== null) chmodSync(temp, mode);
  renameSync(temp, target);
}

function main(argv) {
  // Input
  const [verb] = argv;
  if (argv.length !== 1 || !VERBS.includes(verb)) throw new Error(USAGE);
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  const pluginName = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  const settingsPath = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
  const settings = readSettings(settingsPath);

  // Process
  const rule = ruleFor(grantDir(root, pluginName), homedir());
  const { settings: granted, present } = withRule(settings, rule);

  // Output
  if (present) return `granted ${rule} in ${settingsPath}\n`;
  if (verb === 'check') return `missing ${rule} in ${settingsPath}\n`;
  writeSettings(settingsPath, granted);
  return `granted ${rule} in ${settingsPath} (added)\n`;
}

// Realpath both sides, as the other tools do: a link in the script path otherwise made the CLI a no-op.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`plugin-access: ${err.message}\n`);
    process.exit(1);
  }
}
