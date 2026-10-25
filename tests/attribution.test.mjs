// tools/attribution.mjs: hides Claude Code's author details on commits and pull requests in the user settings.
//
// What matters here is which keys each settings shape reports as shown, that set writes only those keys,
// and that no failure and no no-op touches the file.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { shownKeys, withHidden } from '../tools/attribution.mjs';

const CLI = join(REPO_ROOT, 'tools/attribution.mjs');

/** The CLI with its settings in `configDir`: `{ stdout, stderr, code }`, never throwing. */
function cli(configDir, ...argv) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...argv],
      { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
    return { stdout, stderr: '', code: 0 };
  } catch (e) {
    return { stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), code: e.status ?? 1 };
  }
}

/** The message from a call that should throw, or '' if it wrongly succeeded. */
function failsWith(fn) {
  try {
    fn();
    return '';
  } catch (e) { return e.message; }
}

const fileOf = (settings) => `${JSON.stringify(settings, null, 2)}\n`;
const HIDING = { commit: '', pr: '', sessionUrl: false };

section('shownKeys names each attribution key that does not hold its hiding value');
{
  eq(shownKeys({}).join(), 'commit,pr,sessionUrl', 'no attribution key: all three keys are shown');
  eq(shownKeys({ attribution: {} }).join(), 'commit,pr,sessionUrl', 'an empty attribution object: all three keys are shown');
  eq(shownKeys({ attribution: false }).join(), '', 'attribution false is hidden');
  eq(shownKeys({ attribution: HIDING }).join(), '', 'all three hiding values is hidden');
  eq(shownKeys({ attribution: { ...HIDING, commit: 'Co-Authored-By: x' } }).join(), 'commit', 'a commit text is shown');
  eq(shownKeys({ attribution: { ...HIDING, pr: 'made by x' } }).join(), 'pr', 'a pr text is shown');
  eq(shownKeys({ attribution: { ...HIDING, sessionUrl: true } }).join(), 'sessionUrl', 'sessionUrl true is shown');
  eq(shownKeys({ attribution: { commit: '' } }).join(), 'pr,sessionUrl', 'a missing key is shown');
  for (const bad of [true, null, 'off', 0, []]) {
    ok(/neither a JSON object nor false/.test(failsWith(() => shownKeys({ attribution: bad }))),
      `attribution ${JSON.stringify(bad)} fails loud`);
  }
  ok(/JSON object/.test(failsWith(() => shownKeys([]))), 'a settings file that is not an object fails loud');
}

section('withHidden adds only the shown keys, keeps the rest, and never mutates');
{
  const before = { model: 'opus', attribution: { commit: 'x', note: 'keep' } };
  const after = withHidden(before);
  eq(JSON.stringify(after), JSON.stringify({ model: 'opus', attribution: { commit: '', note: 'keep', pr: '', sessionUrl: false } }),
    'a commit text becomes "", the extra key stays, the missing keys are added');
  eq(before.attribution.commit, 'x', 'the input object is not mutated');
  const hidden = { attribution: false };
  ok(withHidden(hidden) === hidden, 'attribution false is returned as it is, never turned into an object');
}

section('the CLI checks, sets once, and never damages the settings file');
{
  const configDir = mkdtempSync(join(tmpdir(), 'aipg-attribution-'));
  const settingsPath = join(configDir, 'settings.json');
  const reset = (text) => writeFileSync(settingsPath, text);
  const bytes = () => readFileSync(settingsPath, 'utf8');
  try {
    const missing = cli(configDir, 'check');
    eq(missing.stdout, `shown commit, pr, sessionUrl in ${settingsPath}\n`, 'check on a missing file shows all three keys');
    ok(!existsSync(settingsPath), 'check writes nothing');

    const created = cli(configDir, 'set');
    eq(created.stdout, `hidden ${settingsPath} (set commit, pr, sessionUrl)\n`, 'set on a missing file reports the keys it set');
    eq(bytes(), fileOf({ attribution: HIDING }), 'and creates the file with the three hiding values');
    eq(cli(configDir, 'check').stdout, `hidden ${settingsPath}\n`, 'check now says hidden');

    const partial = { model: 'opus', permissions: { allow: ['Bash(ls:*)'] }, attribution: { commit: 'Co-Authored-By: x', pr: '', note: 'keep' } };
    reset(fileOf(partial));
    eq(cli(configDir, 'check').stdout, `shown commit, sessionUrl in ${settingsPath}\n`, 'check names only the partial keys');
    const set = cli(configDir, 'set');
    eq(set.stdout, `hidden ${settingsPath} (set commit, sessionUrl)\n`, 'set names the keys it wrote');
    eq(bytes(), fileOf({ ...partial, attribution: { commit: '', pr: '', note: 'keep', sessionUrl: false } }),
      'set writes only the named keys and keeps every other setting and attribution key');

    for (const hiddenSettings of [{ attribution: false, model: 'opus' }, { attribution: { ...HIDING, note: 'keep' } }]) {
      const text = `${JSON.stringify(hiddenSettings)}\n`;
      reset(text);
      eq(cli(configDir, 'check').stdout, `hidden ${settingsPath}\n`, `check says hidden for ${JSON.stringify(hiddenSettings)}`);
      const again = cli(configDir, 'set');
      eq(again.stdout, `hidden ${settingsPath}\n`, 'set on a hidden file reports hidden');
      eq(bytes(), text, 'and leaves the file byte for byte unchanged, its formatting included');
    }

    const failures = [
      ['{ "model": ', /not valid JSON/, 'invalid JSON'],
      ['[]\n', /JSON object/, 'an array settings file'],
      ['{"attribution":"off"}\n', /neither a JSON object nor false/, 'a string attribution'],
      ['{"attribution":true}\n', /neither a JSON object nor false/, 'attribution true'],
      ['{"attribution":null}\n', /neither a JSON object nor false/, 'a null attribution'],
      ['{"attribution":[]}\n', /neither a JSON object nor false/, 'an array attribution'],
    ];
    for (const [text, cause, label] of failures) {
      for (const verb of ['check', 'set']) {
        reset(text);
        const failed = cli(configDir, verb);
        ok(failed.code === 1 && cause.test(failed.stderr), `${verb} on ${label} exits 1 with the cause: ${failed.stderr.trim()}`);
        eq(bytes(), text, `and leaves the file byte for byte unchanged on ${label}`);
      }
    }

    for (const argv of [[], ['nope'], ['check', 'extra']]) {
      const bad = cli(configDir, ...argv);
      ok(bad.code === 1 && /usage:/.test(bad.stderr), `argv ${JSON.stringify(argv)} exits 1 with usage`);
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}
