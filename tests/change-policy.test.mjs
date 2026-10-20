// tools/change-policy.mjs: the per-repo change policy store, driven as a child process against real git.
//
// Fixtures live under mkdtemp(os.tmpdir(), 'aipg-policy-') and never under REPO_ROOT, as in wt.test.mjs, and each is
// removed in `finally`. Every git child, the tool's included, reads only a config file inside the fixture and stops
// its repository search at the fixture, so the machine's own git config never reaches a case.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { foldsCase } from '../tools/trash.mjs';
import { STORE_FILE, repoKey, savedKey, withPolicy } from '../tools/change-policy.mjs';

const CLI = join(REPO_ROOT, 'tools/change-policy.mjs');
const FOLDS_CASE = foldsCase(process.platform);
// Mixed case, so a compare that folds only one side fails.
const USER = 'Me@Example.invalid';
// Their author lines pass 1 MiB, the default output buffer of spawnSync and execFileSync.
const LONG_HISTORY = 60000;

function run(cmd, args, env, input, cwd) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', env, input, cwd, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/** The key the tool stores for a main checkout or a git dir. */
const keyOf = (dir) => realpathSync.native(dir).replace(/\\/g, '/');

// git reads safe.directory only from system and global config, so the fixture's global config grants what the
// machine's own config may grant.
const configText = (email) => `[safe]\n\tdirectory = *\n${email === null ? '' : `[user]\n\temail = ${email}\n`}`;

function withFixture(fn) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aipg-policy-')));
  const gitconfig = join(root, 'gitconfig');
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: gitconfig, GIT_CEILING_DIRECTORIES: root };
  const state = join(root, 'state');
  const storePath = join(state, STORE_FILE);
  const git = (cwd, ...args) => run('git', ['-C', cwd, ...args], env);
  const cli = (...argv) => run(process.execPath, [CLI, ...argv], env);
  const fx = {
    root, env, state, storePath, git, cli,
    cliIn: (cwd, ...argv) => run(process.execPath, [CLI, ...argv], env, undefined, cwd),
    setEmail: (email) => writeFileSync(gitconfig, configText(email)),
    repo(name) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      return dir;
    },
    commit(dir, author) {
      const ident = { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: author };
      const r = run('git', ['-C', dir, 'commit', '--allow-empty', '-qm', 'c'], { ...env, ...ident });
      if (r.code !== 0) throw new Error(`change-policy.test: a fixture commit failed: ${r.stderr}`);
    },
    check: (dir) => cli('check', '--root', state, '--repo', dir),
    set: (dir, policy) => cli('set', '--root', state, '--repo', dir, '--policy', policy),
    store: () => JSON.parse(readFileSync(storePath, 'utf8')),
  };
  fx.setEmail(USER);
  try {
    fn(fx);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

section('set then check returns the saved policy, and a second repo\'s key survives the write');
withFixture((fx) => {
  const one = fx.repo('one');
  const two = fx.repo('two');
  ok(!existsSync(fx.state), 'the state root does not exist yet');
  const first = fx.set(one, 'proactive');
  eq(first.code, 0, 'set exits 0 and creates the missing root');
  eq(first.stdout, `set ${keyOf(one)} proactive in ${fx.storePath}\n`, 'set names the key, the policy and the store');
  eq(fx.set(two, 'strict').code, 0, 'a second repo\'s set exits 0');
  eq(fx.check(one).stdout, `proactive ${keyOf(one)}\n`, 'check prints the first repo\'s saved policy');
  eq(fx.check(two).stdout, `strict ${keyOf(two)}\n`, 'check prints the second repo\'s saved policy');
  eq(JSON.stringify(fx.store()), JSON.stringify({ [keyOf(one)]: 'proactive', [keyOf(two)]: 'strict' }),
    'the store holds both keys');
  eq(fx.set(one, 'strict').code, 0, 'set replaces a saved policy');
  eq(JSON.stringify(fx.store()), JSON.stringify({ [keyOf(two)]: 'strict', [keyOf(one)]: 'strict' }),
    'the replaced key appears once, and the other key survives');
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'no temp file is left beside the store');
  mkdirSync(join(one, 'sub'));
  eq(fx.check(join(one, 'sub')).stdout, `strict ${keyOf(one)}\n`, 'a subdirectory reads its repo\'s key');
  eq(fx.cliIn(join(one, 'sub'), 'check', '--root', fx.state, '--repo', '.').stdout, `strict ${keyOf(one)}\n`,
    'a relative --repo resolves against the working directory');
});

section('the checkout ignores the store and its temp file, since a run\'s root is normally the checkout');
withFixture((fx) => {
  const repo = fx.repo('ignores');
  copyFileSync(join(REPO_ROOT, '.gitignore'), join(repo, '.gitignore'));
  // A crash between the write and the rename leaves the temp file, named this way, beside the store.
  for (const name of [STORE_FILE, `${STORE_FILE}.4242.tmp`]) {
    eq(fx.git(repo, 'check-ignore', '-q', '--no-index', name).code, 0, `the checkout's .gitignore ignores ${name} at its root`);
  }
});

section('a linked worktree reads its main checkout\'s key');
withFixture((fx) => {
  const main = fx.repo('main');
  fx.commit(main, USER);
  const linked = join(fx.root, 'linked');
  eq(fx.git(main, 'worktree', 'add', '-q', linked, '-b', 'side').code, 0, 'the fixture worktree is added');
  eq(fx.set(main, 'proactive').code, 0, 'set on the main checkout exits 0');
  eq(fx.check(linked).stdout, `proactive ${keyOf(main)}\n`, 'check from the worktree prints the main checkout\'s policy and key');
  eq(fx.set(linked, 'strict').stdout, `set ${keyOf(main)} strict in ${fx.storePath}\n`, 'set from the worktree writes the main checkout\'s key');
  eq(Object.keys(fx.store()).join(','), keyOf(main), 'the store holds one key');
});

section('a common dir not named .git keys the git dir itself');
withFixture((fx) => {
  const bare = join(fx.root, 'b.git');
  eq(fx.git(fx.root, 'init', '-q', '--bare', bare).code, 0, 'the fixture bare repository is created');
  eq(fx.check(bare).stdout, `missing ${keyOf(bare)} recommend=proactive\n`, 'a bare repository is keyed by its git dir');
  const work = join(fx.root, 'work');
  const separate = join(fx.root, 'separate-git');
  eq(fx.git(fx.root, 'init', '-q', '--separate-git-dir', separate, work).code, 0, 'the fixture separate git dir is created');
  eq(fx.check(work).stdout, `missing ${keyOf(separate)} recommend=proactive\n`, 'a separate git dir is keyed by its git dir');
});
if (process.platform === 'win32') {
  eq(repoKey('C:\\.git'), 'C:/', 'a checkout at a drive root keeps the root\'s slash');
  eq(repoKey('E:\\work\\r\\.git'), 'E:/work/r', 'a Windows key uses forward slashes');
} else {
  eq(repoKey('/.git'), '/', 'a checkout at the file system root keeps the root\'s slash');
  eq(repoKey('/work/r/.git'), '/work/r', 'a POSIX key is the checkout');
}

section('keys compare case-insensitively where foldsCase is true');
eq(savedKey({ 'E:/Work/R': 'strict' }, 'e:/work/r', true), 'E:/Work/R', 'a folding lookup finds another spelling');
eq(savedKey({ 'E:/Work/R': 'strict' }, 'e:/work/r', false), null, 'a case-sensitive lookup does not');
eq(savedKey({}, 'constructor', false), null, 'a lookup never resolves to an inherited member');
eq(JSON.stringify(withPolicy({ 'E:/Work/R': 'strict', 'E:/x': 'strict' }, 'e:/work/r', 'proactive', true)),
  JSON.stringify({ 'E:/x': 'strict', 'e:/work/r': 'proactive' }), 'a folding set replaces the other spelling and keeps the other key');
eq(JSON.stringify(withPolicy({ 'E:/Work/R': 'strict' }, 'e:/work/r', 'proactive', false)),
  JSON.stringify({ 'E:/Work/R': 'strict', 'e:/work/r': 'proactive' }), 'a case-sensitive set keeps both spellings');
withFixture((fx) => {
  const repo = fx.repo('Repo');
  const key = keyOf(repo);
  if (FOLDS_CASE) {
    eq(fx.set(repo, 'proactive').code, 0, 'set exits 0');
    eq(fx.check(repo.toUpperCase()).stdout, `proactive ${key}\n`, 'an upper-case spelling of --repo finds the same key');
    writeFileSync(fx.storePath, JSON.stringify({ [key.toUpperCase()]: 'strict' }));
    eq(fx.check(repo).stdout, `strict ${key}\n`, 'a stored key in another case is found');
    eq(fx.set(repo.toLowerCase(), 'proactive').code, 0, 'set through a lower-case spelling exits 0');
    eq(JSON.stringify(fx.store()), JSON.stringify({ [key]: 'proactive' }), 'the store keeps one spelling, the real path');
  } else {
    mkdirSync(fx.state);
    writeFileSync(fx.storePath, JSON.stringify({ [key.toUpperCase()]: 'strict' }));
    eq(fx.check(repo).stdout, `missing ${key} recommend=proactive\n`, 'a stored key in another case is another repo here');
  }
});

section('the recommendation: proactive for no commits or only the user\'s email, strict otherwise');
withFixture((fx) => {
  const empty = fx.repo('empty');
  eq(fx.check(empty).stdout, `missing ${keyOf(empty)} recommend=proactive\n`, 'no commits recommends proactive');
  const mine = fx.repo('mine');
  fx.commit(mine, USER);
  fx.commit(mine, 'me@EXAMPLE.INVALID');
  eq(fx.check(mine).stdout, `missing ${keyOf(mine)} recommend=proactive\n`,
    'only the user\'s email, in any case, recommends proactive');
  const shared = fx.repo('shared');
  fx.commit(shared, USER);
  fx.commit(shared, 'other@example.invalid');
  fx.commit(shared, USER);
  eq(fx.check(shared).stdout, `missing ${keyOf(shared)} recommend=strict\n`, 'a second author recommends strict');
  const branched = fx.repo('branched');
  fx.commit(branched, USER);
  fx.git(branched, 'checkout', '-q', '-b', 'theirs');
  fx.commit(branched, 'other@example.invalid');
  fx.git(branched, 'checkout', '-q', 'main');
  eq(fx.check(branched).stdout, `missing ${keyOf(branched)} recommend=strict\n`,
    'a second author on a branch that HEAD does not reach recommends strict');
  fx.setEmail(null);
  eq(fx.check(mine).stdout, `missing ${keyOf(mine)} recommend=strict\n`, 'commits and an unset user.email recommend strict');
  eq(fx.check(empty).stdout, `missing ${keyOf(empty)} recommend=proactive\n`, 'no commits and an unset user.email recommend proactive');
  ok(!existsSync(fx.state), 'check writes nothing');
});

section('reading the authors works on a repo with a long history');
withFixture((fx) => {
  const long = fx.repo('long');
  let stream = '';
  for (let i = 1; i <= LONG_HISTORY; i++) {
    const ident = `A <${USER}> ${1700000000 + i} +0000`;
    stream += `commit refs/heads/main\nmark :${i}\nauthor ${ident}\ncommitter ${ident}\ndata 0\n${i > 1 ? `from :${i - 1}\n` : ''}\n`;
  }
  const imported = run('git', ['-C', long, 'fast-import', '--quiet'], fx.env, stream);
  eq(imported.code, 0, `the fixture history of ${LONG_HISTORY} commits is imported`);
  const r = fx.check(long);
  eq(r.stdout, `missing ${keyOf(long)} recommend=proactive\n`, `${LONG_HISTORY} commits by the user recommend proactive (${r.stderr.trim()})`);
});

section('a store that is not a JSON object of policies fails check and set, and set leaves its bytes');
for (const [what, bytes, cause] of [
  ['a store that does not parse', '{ "E:/r": ', /does not parse as JSON/],
  ['a store that holds an array', '["strict"]\n', /does not hold a JSON object/],
  ['a store value outside the two policies', '{ "E:/x": "lenient" }\n', /maps "E:\/x" to "lenient", which is neither strict nor proactive/],
]) {
  withFixture((fx) => {
    const repo = fx.repo('r');
    mkdirSync(fx.state);
    writeFileSync(fx.storePath, bytes);
    const check = fx.check(repo);
    ok(check.code === 1 && cause.test(check.stderr) && check.stderr.includes(fx.storePath),
      `${what}: check exits 1 naming the store and the cause (${check.stderr.trim()})`);
    const set = fx.set(repo, 'strict');
    ok(set.code === 1 && cause.test(set.stderr) && set.stderr.includes(fx.storePath),
      `${what}: set exits 1 naming the store and the cause`);
    eq(readFileSync(fx.storePath, 'utf8'), bytes, `${what}: set leaves the store byte-identical`);
  });
}

section('a bad argument exits 1 and writes nothing');
withFixture((fx) => {
  const repo = fx.repo('r');
  const plain = join(fx.root, 'plain');
  mkdirSync(plain);
  for (const [what, argv, cause] of [
    ['an invalid policy', ['set', '--root', fx.state, '--repo', repo, '--policy', 'lenient'], /--policy "lenient" is neither strict nor proactive/],
    ['a --repo outside any git repository', ['check', '--root', fx.state, '--repo', plain], /is not in a git repository/],
    ['an unknown verb', ['get', '--root', fx.state, '--repo', repo], /unknown verb "get"/],
    ['no verb', [], /no verb given/],
    ['an unknown flag', ['check', '--root', fx.state, '--repo', repo, '--policy', 'strict'], /unknown flag "--policy" for check/],
    ['a missing flag', ['set', '--root', fx.state, '--repo', repo], /set needs --policy/],
    ['a flag with no value', ['check', '--root', fx.state, '--repo'], /--repo needs a value/],
    ['a blank value', ['check', '--root', ' ', '--repo', repo], /--root needs a value/],
    ['a flag given twice', ['check', '--root', fx.state, '--repo', repo, '--repo', repo], /--repo was given twice/],
    ['a bare value', ['check', fx.state], /unexpected argument/],
  ]) {
    const r = fx.cli(...argv);
    ok(r.code === 1 && cause.test(r.stderr), `${what} exits 1 naming the cause (${r.stderr.trim().slice(0, 120)})`);
  }
  ok(fx.cliIn(fx.root, 'check', '--root', fx.state, '--repo', 'plain').stderr.includes(plain),
    'the repo failure names the absolute path of a relative --repo');
  ok(!existsSync(fx.state), 'no failure writes the store');
});
