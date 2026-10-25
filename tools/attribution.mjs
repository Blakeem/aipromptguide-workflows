// tools/attribution.mjs: whether Claude Code adds its author details to the commits and pull requests it makes.
//
// The `attribution` setting in the user settings holds the text Claude Code appends. The tool counts the setting as
// hidden when `attribution` is `false`, or when `commit` is "", `pr` is "" and `sessionUrl` is `false`.
//
//   node tools/attribution.mjs check    # "hidden <settings>" or "shown <keys> in <settings>"
//   node tools/attribution.mjs set      # writes the hiding value of each shown key, a no-op when hidden
//
// set keeps every other setting and every other `attribution` key, and never writes `"attribution": false`.
// A settings file that does not parse, or whose `attribution` is neither an object nor `false`, exits 1 with
// the cause and writes nothing. A missing file reads as empty settings, and set creates it.
// The settings path, read and write come from plugin-access.mjs. Ordinary Node: `node --check` applies.

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isJsonObject, readSettings, settingsPath, writeSettings } from './plugin-access.mjs';

const USAGE = 'usage: node tools/attribution.mjs check|set';
const VERBS = ['check', 'set'];
const HIDING_VALUES = { commit: '', pr: '', sessionUrl: false };

/** The attribution keys that do not hold their hiding value, `[]` when the settings hide attribution. */
export function shownKeys(settings) {
  // Input
  if (!isJsonObject(settings)) throw new Error('the settings file does not hold a JSON object');
  const attribution = settings.attribution;
  if (attribution === false) return [];
  if (attribution !== undefined && !isJsonObject(attribution)) {
    throw new Error('attribution in the settings file is neither a JSON object nor false');
  }

  // Output
  return Object.keys(HIDING_VALUES).filter((key) => (attribution ?? {})[key] !== HIDING_VALUES[key]);
}

/** The settings with the hiding value of each key `shownKeys` names. Never mutates. */
export function withHidden(settings) {
  // Input
  const keys = shownKeys(settings);
  const hiddenValues = Object.fromEntries(keys.map((key) => [key, HIDING_VALUES[key]]));

  // Output
  if (keys.length === 0) return settings;
  return { ...settings, attribution: { ...settings.attribution, ...hiddenValues } };
}

function main(argv) {
  // Input
  const [verb] = argv;
  if (argv.length !== 1 || !VERBS.includes(verb)) throw new Error(USAGE);
  const userSettings = settingsPath();
  const settings = readSettings(userSettings);
  const keys = shownKeys(settings);

  // Output
  if (keys.length === 0) return `hidden ${userSettings}\n`;
  if (verb === 'check') return `shown ${keys.join(', ')} in ${userSettings}\n`;
  writeSettings(userSettings, withHidden(settings));
  return `hidden ${userSettings} (set ${keys.join(', ')})\n`;
}

// Realpath both sides, as the other tools do. A link in the script path otherwise makes the CLI a no-op.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`attribution: ${err.message}\n`);
    process.exit(1);
  }
}
