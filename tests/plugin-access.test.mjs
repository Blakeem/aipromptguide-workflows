// tools/plugin-access.mjs: the Read rule that lets an installed plugin's skills launch its engines.
//
// The rule spellings `~/...` and `//c/...` were measured against the Workflow tool's scriptPath check
// (Claude Code 2.1.285). What matters here is that each install layout gets the right folder, and that
// grant never damages the user's settings file.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync, symlinkSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { grantDir, ruleFor, withRule } from '../tools/plugin-access.mjs';

const CLI = join(REPO_ROOT, 'tools/plugin-access.mjs');

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

/** symlinkSync, or false with a logged note when the host lacks the symlink privilege (EPERM on Windows). */
function linked(target, path) {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch (e) {
    if (e.code !== 'EPERM') throw e;
    console.log('      note: symlinkSync raised EPERM (no symlink privilege), linked-settings case skipped');
    return false;
  }
}

section('a cache install grants the plugin folder above the version, so updates keep the rule');
eq(grantDir('C:/Users/b/.claude/plugins/cache/aipromptguide/aipg/976fbab91d86', 'aipg'),
  'C:/Users/b/.claude/plugins/cache/aipromptguide/aipg', 'the version folder is dropped');
eq(grantDir('E:/aipromptguide-workflows', 'aipg'), 'E:/aipromptguide-workflows',
  'a directory-marketplace or checkout install grants its own root');

section('the rule is spelled the way the permission matcher reads it');
eq(ruleFor('C:\\Users\\b\\.claude\\plugins\\cache\\aipromptguide\\aipg', 'C:\\Users\\b'),
  'Read(~/.claude/plugins/cache/aipromptguide/aipg/**)', 'under home: ~/ with forward slashes');
eq(ruleFor('c:\\users\\B\\x', 'C:\\Users\\b'), 'Read(~/x/**)', 'a Windows home matches case-insensitively');
eq(ruleFor('E:\\aipromptguide-workflows\\', 'C:\\Users\\b'), 'Read(//e/aipromptguide-workflows/**)',
  'another drive: //<letter>/..., trailing separator dropped');
eq(ruleFor('/home/b/aipg', '/home/b'), 'Read(~/aipg/**)', 'POSIX under home');
eq(ruleFor('/srv/aipg', '/home/b'), 'Read(//srv/aipg/**)', 'POSIX outside home: // absolute');
eq(ruleFor('/home/B/aipg', '/home/b'), 'Read(//home/B/aipg/**)', 'a POSIX home matches case-sensitively');
ok(/network path/.test(failsWith(() => ruleFor('\\\\server\\share\\aipg', 'C:\\Users\\b'))),
  'a network root fails loud: the Workflow tool refuses network scriptPaths anyway');

section('withRule adds the rule once and keeps everything else');
{
  const before = { model: 'opus', permissions: { defaultMode: 'auto', allow: ['Bash(ls:*)'] } };
  const { settings, present } = withRule(before, 'Read(~/p/**)');
  ok(!present, 'reported as newly added');
  eq(JSON.stringify(settings), JSON.stringify({ model: 'opus', permissions: { defaultMode: 'auto', allow: ['Bash(ls:*)', 'Read(~/p/**)'] } }),
    'appended after the existing rules, other keys intact');
  eq(before.permissions.allow.length, 1, 'the input object is not mutated');
  const again = withRule(settings, 'Read(~/p/**)');
  ok(again.present && again.settings === settings, 'a present rule is a no-op');
  eq(JSON.stringify(withRule({}, 'Read(~/p/**)').settings), '{"permissions":{"allow":["Read(~/p/**)"]}}',
    'an empty settings object gains permissions.allow');
  ok(/not an array/.test(failsWith(() => withRule({ permissions: { allow: 'x' } }, 'r'))), 'a non-array allow fails loud');
  ok(/not an array/.test(failsWith(() => withRule({ permissions: { allow: null } }, 'r'))),
    'a null allow fails loud rather than becoming [rule]');
  ok(/JSON object/.test(failsWith(() => withRule([], 'r'))), 'a non-object settings file fails loud');
  ok(/permissions in the settings file/.test(failsWith(() => withRule({ permissions: ['x'] }, 'r'))),
    'a non-object permissions fails loud');
}

section('the CLI checks, grants once, and never damages the settings file');
{
  const configDir = mkdtempSync(join(tmpdir(), 'aipg-access-'));
  const settingsPath = join(configDir, 'settings.json');
  const rule = ruleFor(grantDir(REPO_ROOT, 'aipg'), homedir());
  try {
    const missing = cli(configDir, 'check');
    eq(missing.code, 0, 'check exits 0 when the rule is missing');
    eq(missing.stdout, `missing ${rule} in ${settingsPath}\n`, 'and says missing, with the exact rule');
    ok(!existsSync(settingsPath), 'check writes nothing');

    writeFileSync(settingsPath, '{\n  "model": "opus",\n  "permissions": {\n    "defaultMode": "auto"\n  }\n}\n');
    const granted = cli(configDir, 'grant');
    eq(granted.stdout, `granted ${rule} in ${settingsPath} (added)\n`, 'grant adds the rule');
    eq(readFileSync(settingsPath, 'utf8'),
      `{\n  "model": "opus",\n  "permissions": {\n    "defaultMode": "auto",\n    "allow": [\n      ${JSON.stringify(rule)}\n    ]\n  }\n}\n`,
      'the file keeps its keys and two-space LF format');

    const regrant = cli(configDir, 'grant');
    eq(regrant.stdout, `granted ${rule} in ${settingsPath}\n`, 'a second grant reports it present');
    eq(JSON.parse(readFileSync(settingsPath, 'utf8')).permissions.allow.length, 1, 'and adds no duplicate');
    eq(cli(configDir, 'check').stdout, `granted ${rule} in ${settingsPath}\n`, 'check now says granted');

    writeFileSync(settingsPath, '{ "model": ');
    const broken = cli(configDir, 'grant');
    ok(broken.code === 1 && /not valid JSON/.test(broken.stderr), `invalid JSON exits 1 naming the file: ${broken.stderr.trim()}`);
    eq(readFileSync(settingsPath, 'utf8'), '{ "model": ', 'and leaves the file byte-identical');

    for (const argv of [[], ['nope'], ['check', 'extra']]) {
      const bad = cli(configDir, ...argv);
      ok(bad.code === 1 && /usage:/.test(bad.stderr), `argv ${JSON.stringify(argv)} exits 1 with usage`);
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

section('grant writes through a linked settings file, so a dotfiles link keeps the rule');
{
  const linkRoot = mkdtempSync(join(tmpdir(), 'aipg-access-link-'));
  const configDir = join(linkRoot, 'config');
  const dotfile = join(linkRoot, 'dot', 'settings.json');
  const settingsPath = join(configDir, 'settings.json');
  const rule = ruleFor(grantDir(REPO_ROOT, 'aipg'), homedir());
  try {
    mkdirSync(join(linkRoot, 'dot'));
    mkdirSync(configDir);
    writeFileSync(dotfile, '{"model":"opus"}\n');
    if (linked(dotfile, settingsPath)) {
      eq(cli(configDir, 'grant').code, 0, 'grant through the link exits 0');
      ok(lstatSync(settingsPath).isSymbolicLink(), 'the settings link is still a link');
      ok(JSON.parse(readFileSync(dotfile, 'utf8')).permissions?.allow?.includes(rule) === true,
        'the dotfile holds the rule');
    }
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }
}

section('grant refuses a dangling settings link, so the link survives for the dotfiles checkout');
{
  const linkRoot = mkdtempSync(join(tmpdir(), 'aipg-access-dangling-'));
  const configDir = join(linkRoot, 'config');
  const settingsPath = join(configDir, 'settings.json');
  try {
    mkdirSync(configDir);
    if (linked(join(linkRoot, 'dot', 'settings.json'), settingsPath)) {
      const refused = cli(configDir, 'grant');
      ok(refused.code === 1 && /which does not exist\. Nothing was written\./.test(refused.stderr),
        `grant through a dangling link exits 1 naming it: ${refused.stderr.trim()}`);
      ok(lstatSync(settingsPath).isSymbolicLink(), 'the dangling link is still a link');
      ok(!existsSync(join(linkRoot, 'dot')), 'no dotfiles folder is invented');
    }
  } finally {
    rmSync(linkRoot, { recursive: true, force: true });
  }
}
