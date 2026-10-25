// tools/onboard.mjs: every setup answer develop and debug need from the user, asked together once at the start.
//
// The answers live where each tool already keeps them: the plugin's Read rules and the attribution setting in the user
// settings, and the repo's change policy and commit choice in <root>/projects.json. So check reads them every time and
// prints one `ready` line once nothing is missing, which is what lets a skill call it before every run.
//
//   node tools/onboard.mjs check --root <dir> --repo <dir>    # "ready <key> policy=<p> delivery=<commit|stage>",
//                                                              # or "ask <key>" and the questions to ask
//   node tools/onboard.mjs save --root <dir> --repo <dir> [--access allow] [--policy focused|proactive|auto]
//                               [--delivery commit|stage] [--attribution hide|keep]   # then prints what check prints
//
// The access question is skipped when the working directory holds the plugin folder, since the session can then read
// it. The attribution question rides with the delivery question, so a repo asks it at most once. Every failure exits 1
// with its cause on stderr. check writes nothing, and save writes each answer idempotently, so a save run again after a
// failure finishes it. Ordinary Node: `node --check` applies.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shownKeys, withHidden } from './attribution.mjs';
import { accessState, writeSettings } from './plugin-access.mjs';
import { recommendedPolicy, repoSettings, saveRepoSettings } from './project-settings.mjs';
import { foldsCase, isWithin } from './trash.mjs';

const POLICIES = ['focused', 'proactive', 'auto'];
const CHOICES = {
  access: ['allow'],
  policy: POLICIES,
  delivery: ['commit', 'stage'],
  attribution: ['hide', 'keep'],
};
const VERBS = { check: [], save: Object.keys(CHOICES) };
const USAGE = 'usage: node tools/onboard.mjs check --root <dir> --repo <dir>'
  + ' | save --root <dir> --repo <dir> [--access allow] [--policy focused|proactive|auto] [--delivery commit|stage] [--attribution hide|keep]';
const FOLDS_CASE = foldsCase(process.platform);

const POLICY_OPTIONS = {
  proactive: 'Takes ownership of code quality and fixes defects near the task, with a low-risk fix of each defect noticed in'
    + ' the code a block\'s changes connect to. It fits code the user leads that is new or actively developed, with time'
    + ' to test. It uses more tokens.',
  focused: 'A light touch. Each change stays on its task. It fits production fixes that ship fast, legacy code, code other'
    + ' developers own, and experiments such as A/B tests. It uses fewer tokens.',
  auto: 'Claude picks per run: focused when money or user data is at stake with little time to test, when the code is old'
    + ' and due for replacement, or when others own it, and proactive when the user is the main developer, the code is'
    + ' new or active, and there is time to test. It asks when unsure.',
};
const DELIVERY_OPTIONS = {
  commit: 'Each accepted block becomes one commit with the block\'s title as its message, and the run\'s commits land on'
    + ' the current branch when the run finishes. The repo\'s commit hooks run. It fits a repo where Claude commits.',
  stage: 'The run\'s accepted work lands staged on the current branch when the run finishes, for the user to review and'
    + ' commit. It fits a repo where the user reviews every change before it is committed.',
};

/** `<verb> --flag value...`, validated against the verb's flags and each flag's choices. Nothing is coerced. */
function parseArgv(argv) {
  // Input
  const [verb, ...rest] = argv;
  if (!verb || !Object.hasOwn(VERBS, verb)) throw new Error(`${verb ? `unknown verb "${verb}"` : 'no verb given'}. ${USAGE}`);
  const flags = ['root', 'repo', ...VERBS[verb]];
  const opt = {};

  // Process
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i].startsWith('--') ? rest[i].slice(2) : null;
    const value = rest[i + 1];
    if (name === null) throw new Error(`unexpected argument "${rest[i]}". Every value follows its own flag. ${USAGE}`);
    if (!flags.includes(name)) throw new Error(`unknown flag "--${name}" for ${verb}, which takes ${flags.map((f) => `--${f}`).join(' ')}`);
    if (Object.hasOwn(opt, name)) throw new Error(`--${name} was given twice`);
    if (value === undefined || value.trim() === '' || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    if (Object.hasOwn(CHOICES, name) && !CHOICES[name].includes(value)) {
      throw new Error(`--${name} "${value}" is none of ${CHOICES[name].join(' | ')}`);
    }
    opt[name] = value;
  }
  const missing = ['root', 'repo'].filter((f) => !Object.hasOwn(opt, f));
  if (missing.length) throw new Error(`${verb} needs ${missing.map((f) => `--${f}`).join(' ')}. ${USAGE}`);
  if (verb === 'save' && !VERBS.save.some((f) => Object.hasOwn(opt, f))) {
    throw new Error(`save needs at least one of ${VERBS.save.map((f) => `--${f}`).join(' ')}. ${USAGE}`);
  }

  // Output
  return { verb, opt };
}

/** The options of a question in the order shown, the recommended one first. */
const ordered = (choices, recommended) => [recommended, ...choices.filter((c) => c !== recommended)];

/** The `ask` text for the questions still open, or the `ready` line when none is. */
async function report(root, repo, invokedScript) {
  // Input
  const access = accessState(invokedScript);
  const { key, settings } = repoSettings(root, repo);
  const sessionReads = isWithin(access.pluginRoot, realpathSync.native(process.cwd()), FOLDS_CASE);
  const askAccess = !access.present && !sessionReads;
  const askPolicy = !Object.hasOwn(settings, 'changePolicy');
  const askDelivery = !Object.hasOwn(settings, 'commit');
  const askAttribution = askDelivery && shownKeys(access.settings).length > 0;
  const questions = [];
  let policyPick = '';

  // Process
  if (!askAccess && !askPolicy && !askDelivery) {
    return `ready ${key} policy=${settings.changePolicy} delivery=${settings.commit ? 'commit' : 'stage'}\n`;
  }
  policyPick = askPolicy || askDelivery ? await recommendedPolicy(repo) : '';
  if (askAccess) {
    questions.push([
      'Question "Plugin access": May every session launch the AIPG workflows? This adds the Read rules'
        + ` ${access.rules.join(' ')} to ${access.userSettings}.`,
      '  --access allow: Add the rules. Claude Code reloads settings live, with no restart.',
      `  (decline): Leave --access out, and tell the user that /add-dir ${access.pluginRoot} allows this session only.`,
    ]);
  }
  if (askPolicy) {
    questions.push([
      'Question "Change policy": How far should each change reach beyond its task?',
      ...ordered(POLICIES, policyPick).map((p) => `  --policy ${p}: ${POLICY_OPTIONS[p]}`),
    ]);
  }
  if (askDelivery) {
    questions.push([
      'Question "Delivery": How should each run\'s accepted work reach the current branch?',
      ...ordered(['commit', 'stage'], policyPick === 'proactive' ? 'commit' : 'stage').map((d) => `  --delivery ${d}: ${DELIVERY_OPTIONS[d]}`),
    ]);
  }
  if (askAttribution) {
    questions.push([
      'Question "Attribution": Should Claude stop adding its author details to the commits and pull requests it makes?',
      '  --attribution hide: Hide them. Commits a run makes carry only the block\'s title either way.',
      '  --attribution keep: Keep them.',
    ]);
  }

  // Output
  return [
    `ask ${key}`,
    'Ask the user every question below in one AskUserQuestion call. Keep each question\'s options in the order shown,'
      + ' and mark the first one (Recommended). Then run the save command with one flag per answer.',
    '',
    ...questions.map((lines) => lines.join('\n')).join('\n\n').split('\n'),
    '',
    `Save: node "${resolve(invokedScript)}" save --root "${resolve(root)}" --repo "${resolve(repo)}" <flags>`,
    '',
  ].join('\n');
}

/** Writes the answers `opt` names. The user settings take one write for access and attribution together. */
function save(root, repo, opt, invokedScript) {
  // Input
  const access = accessState(invokedScript);
  const granted = opt.access === 'allow' ? access.granted : access.settings;
  const userSettings = opt.attribution === 'hide' ? withHidden(granted) : granted;

  // Output
  saveRepoSettings(root, repo, {
    policy: opt.policy,
    commit: opt.delivery === undefined ? undefined : opt.delivery === 'commit',
  });
  if (userSettings !== access.settings) writeSettings(access.userSettings, userSettings);
}

async function main(argv) {
  // Input
  const { verb, opt } = parseArgv(argv);
  const invokedScript = process.argv[1];

  // Process
  if (verb === 'save') save(opt.root, opt.repo, opt, invokedScript);

  // Output
  return report(opt.root, opt.repo, invokedScript);
}

// Realpath both sides, as the other tools do. A link in the script path otherwise makes the CLI a no-op.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(await main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`onboard: ${err.message}\n`);
    process.exitCode = 1;
  }
}
