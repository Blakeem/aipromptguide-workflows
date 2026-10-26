// tools/onboard.mjs: asks every missing setup answer at once and saves the answers where each tool keeps them.
//
// What matters here is that a repo with every answer saved prints one ready line, that each missing answer shows its
// question and no other, that save writes each answer to its own file, and that a bad argument writes nothing.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';

const CLI = join(REPO_ROOT, 'tools/onboard.mjs');
const USER = 'me@example.invalid';
const toPosix = (p) => p.replace(/\\/g, '/');

function run(cmd, args, env, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', env, cwd });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/** A repo with one commit by `author`, a state root and a user settings folder, all under one temp folder. */
function withFixture(author, fn) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aipg-onboard-')));
  const gitconfig = join(root, 'gitconfig');
  const config = join(root, 'config');
  const state = join(root, 'state');
  const repo = join(root, 'repo');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitconfig, GIT_CEILING_DIRECTORIES: root, CLAUDE_CONFIG_DIR: config };
  const ident = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: author };
  writeFileSync(gitconfig, `[safe]\n\tdirectory = *\n[user]\n\temail = ${USER}\n`);
  mkdirSync(repo);
  run('git', ['-C', repo, 'init', '-q', '-b', 'main'], env);
  run('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'c'], { ...env, ...ident });
  const fx = {
    root, repo, state,
    key: toPosix(repo),
    settingsPath: join(config, 'settings.json'),
    check: (cwd = root) => run(process.execPath, [CLI, 'check', '--root', state, '--repo', repo], env, cwd),
    save: (...flags) => run(process.execPath, [CLI, 'save', '--root', state, '--repo', repo, ...flags], env, root),
    raw: (...argv) => run(process.execPath, [CLI, ...argv], env, root),
    settings: () => JSON.parse(readFileSync(fx.settingsPath, 'utf8')),
    store: () => JSON.parse(readFileSync(join(state, 'projects.json'), 'utf8')),
  };
  try {
    fn(fx);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const questionsOf = (stdout) => [...stdout.matchAll(/^Question "([^"]+)"/gm)].map((m) => m[1]).join(', ');
const optionsOf = (stdout, flag) => [...stdout.matchAll(new RegExp(`^  --${flag} (\\w+):`, 'gm'))].map((m) => m[1]).join(' ');

section('a fresh repo asks every question in one ask block, the recommended option first, and writes nothing');
withFixture(USER, (fx) => {
  const r = fx.check();
  eq(r.code, 0, 'check exits 0');
  ok(r.stdout.startsWith(`ask ${fx.key}\n`), 'the first line is ask and the repo key');
  eq(questionsOf(r.stdout), 'Plugin access, Change policy, Delivery, Attribution', 'all four questions, in order');
  eq(optionsOf(r.stdout, 'policy'), 'proactive focused auto', 'the user\'s own repo recommends proactive');
  eq(optionsOf(r.stdout, 'delivery'), 'commit stage', '...and commit');
  ok(/one AskUserQuestion call/.test(r.stdout), 'the operator is told to ask them in one call');
  ok(r.stdout.includes(`Save: node "${CLI}" save --root "${fx.state}" --repo "${fx.repo}" <flags>`), 'the save command names the tool, root and repo');
  ok(!existsSync(fx.settingsPath) && !existsSync(fx.state), 'check writes nothing');
});

section('a repo with other authors recommends focused and stage');
withFixture('someone-else@example.invalid', (fx) => {
  const r = fx.check();
  eq(optionsOf(r.stdout, 'policy'), 'focused proactive auto', 'focused comes first');
  eq(optionsOf(r.stdout, 'delivery'), 'stage commit', 'stage comes first');
});

section('save writes each answer to its own file, and check then prints one ready line');
withFixture(USER, (fx) => {
  const r = fx.save('--access', 'allow', '--policy', 'proactive', '--delivery', 'commit', '--attribution', 'hide');
  eq(r.code, 0, `save exits 0 (${r.stderr.trim()})`);
  eq(r.stdout, `ready ${fx.key} policy=proactive delivery=commit\n`, 'save prints the ready line');
  ok(fx.settings().permissions.allow.some((rule) => rule.startsWith('Read(')), 'the Read rule is in the user settings');
  eq(JSON.stringify(fx.settings().attribution), JSON.stringify({ commit: '', pr: '', sessionUrl: false }), 'attribution is hidden');
  eq(JSON.stringify(fx.store()[fx.key]), JSON.stringify({ changePolicy: 'proactive', commit: true }), 'the store holds the policy and commit');
  eq(fx.check().stdout, `ready ${fx.key} policy=proactive delivery=commit\n`, 'check prints the same ready line');
});

section('a partial answer leaves only the open questions, and attribution goes with the delivery question');
withFixture(USER, (fx) => {
  eq(fx.save('--access', 'allow', '--delivery', 'stage').code, 0, 'save of access and delivery exits 0');
  const r = fx.check();
  eq(questionsOf(r.stdout), 'Change policy', 'only the policy question is left, with no attribution question');
  ok(!existsSync(fx.settingsPath) || fx.settings().attribution === undefined, 'attribution was never written');
  eq(fx.save('--policy', 'auto').stdout, `ready ${fx.key} policy=auto delivery=stage\n`, 'the last answer makes it ready');
});

section('the access question is skipped when the working directory holds the plugin folder');
withFixture(USER, (fx) => {
  eq(questionsOf(fx.check(REPO_ROOT).stdout), 'Change policy, Delivery, Attribution', 'a session in the plugin checkout is not asked for access');
});

section('a declined access question is settled for the call by --access session, which writes nothing');
withFixture(USER, (fx) => {
  eq(optionsOf(fx.check().stdout, 'access'), 'allow session', 'the access question offers allow, then the session-only decline');
  eq(fx.save('--policy', 'focused', '--delivery', 'stage').code, 0, 'save of the policy and delivery exits 0');
  eq(questionsOf(fx.check().stdout), 'Plugin access', 'only the access question is left');
  const r = fx.raw('check', '--root', fx.state, '--repo', fx.repo, '--access', 'session');
  eq(r.code, 0, `check --access session exits 0 (${r.stderr.trim()})`);
  eq(r.stdout, `ready ${fx.key} policy=focused delivery=stage
`, '...and prints the ready line');
  ok(!existsSync(fx.settingsPath), '...writing no user settings');
});

section('save --access session with no other answer is a valid save');
withFixture(USER, (fx) => {
  const r = fx.save('--access', 'session');
  eq(r.code, 0, `save --access session exits 0 (${r.stderr.trim()})`);
  eq(questionsOf(r.stdout), 'Change policy, Delivery, Attribution', 'it settles access and prints the open questions');
  ok(!existsSync(fx.settingsPath) && !existsSync(fx.state), 'nothing was written');
});

section('a bad argument exits 1 with its cause and writes nothing');
withFixture(USER, (fx) => {
  const cases = [
    [['save', '--root', fx.state, '--repo', fx.repo], /save needs at least one of/],
    [['save', '--root', fx.state, '--repo', fx.repo, '--policy', 'strict'], /--policy "strict" is now named focused/],
    [['save', '--root', fx.state, '--repo', fx.repo, '--policy', 'lax'], /--policy "lax" is none of focused \| proactive \| auto/],
    [['check', '--root', fx.state, '--repo', fx.repo, '--access', 'allow'], /--access "allow" is none of session/],
    [['save', '--root', fx.state, '--repo', fx.repo, '--delivery', 'on'], /--delivery "on" is none of/],
    [['check', '--root', fx.state, '--repo', fx.repo, '--policy', 'auto'], /unknown flag "--policy" for check/],
    [['check', '--root', fx.state], /check needs --repo/],
    [['nope'], /unknown verb "nope"/],
    [[], /no verb given/],
  ];
  for (const [argv, cause] of cases) {
    const r = fx.raw(...argv);
    ok(r.code === 1 && cause.test(r.stderr), `${JSON.stringify(argv.filter((a) => !a.includes(fx.root)))} exits 1 with the cause: ${r.stderr.trim()}`);
  }
  ok(!existsSync(fx.settingsPath) && !existsSync(fx.state), 'nothing was written');
});
