// tools/project-settings.mjs: the per-repo settings store and backlog folder, driven as a child process against real git.
//
// Fixtures live under mkdtemp(os.tmpdir(), 'aipg-settings-') and never under REPO_ROOT, as in wt-helpers.mjs, and each is
// removed in `finally`. Every git child, the tool's included, reads only a config file inside the fixture and stops
// its repository search at the fixture, so the machine's own git config never reaches a case.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { foldsCase } from '../tools/trash.mjs';
import { EFFORTS, MODELS, ROLE_KEYS, STORE_FILE, projectName, repoKey, savedKey, withCommit, withPolicy, withRoles } from '../tools/project-settings.mjs';

const CLI = join(REPO_ROOT, 'tools/project-settings.mjs');
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

const toPosix = (p) => p.replace(/\\/g, '/');
/** The key the tool stores for a main checkout or a git dir. */
const keyOf = (dir) => toPosix(realpathSync.native(dir));
/** The backlog folder the tool prints for a key, computed here from the rule, apart from the tool's own code. */
const backlogOf = (state, key, segment) => {
  const hash = createHash('sha256').update(FOLDS_CASE ? key.toLowerCase() : key).digest('hex').slice(0, 8);
  return `${toPosix(state)}/backlog/${segment}-${hash}/\n`;
};

// git reads safe.directory only from system and global config, so the fixture's global config grants what the
// machine's own config may grant.
const configText = (email) => `[safe]\n\tdirectory = *\n${email === null ? '' : `[user]\n\temail = ${email}\n`}`;

function withFixture(fn) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aipg-settings-')));
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
      if (r.code !== 0) throw new Error(`project-settings.test: a fixture commit failed: ${r.stderr}`);
    },
    check: (dir) => cli('check', '--root', state, '--repo', dir),
    backlog: (dir) => cli('backlog', '--root', state, '--repo', dir),
    set: (dir, policy) => cli('set', '--root', state, '--repo', dir, '--policy', policy),
    setWith: (dir, ...flags) => cli('set', '--root', state, '--repo', dir, ...flags),
    commitOf: (dir) => cli('commit', '--root', state, '--repo', dir),
    roles: (dir) => cli('roles', '--root', state, '--repo', dir),
    setRoles: (dir, ...flags) => cli('set-roles', '--root', state, '--repo', dir, ...flags),
    store: () => JSON.parse(readFileSync(storePath, 'utf8')),
  };
  fx.setEmail(USER);
  try {
    fn(fx);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

section('set --policy auto saves auto, check prints it in the form of the other two, and an illegal policy is still rejected');
withFixture((fx) => {
  const repo = fx.repo('auto');
  const set = fx.set(repo, 'auto');
  eq(set.code, 0, 'set --policy auto exits 0');
  eq(set.stdout, `set ${keyOf(repo)} auto in ${fx.storePath}
`, 'set names the key, auto and the store');
  eq(JSON.stringify(fx.store()), JSON.stringify({ [keyOf(repo)]: { changePolicy: 'auto' } }), 'the store holds changePolicy auto');
  eq(fx.check(repo).stdout, `auto ${keyOf(repo)}
`, 'check prints auto <key>');
  const bytes = readFileSync(fx.storePath, 'utf8');
  const bad = fx.set(repo, 'automatic');
  ok(bad.code === 1 && /--policy "automatic" is none of focused \| proactive \| auto/.test(bad.stderr),
    `an illegal policy still exits 1 naming the cause (${bad.stderr.trim()})`);
  eq(readFileSync(fx.storePath, 'utf8'), bytes, 'the rejected policy leaves the store unchanged');
});

section('set then check returns the saved policy, and a second repo\'s key survives the write');
withFixture((fx) => {
  const one = fx.repo('one');
  const two = fx.repo('two');
  ok(!existsSync(fx.state), 'the state root does not exist yet');
  const first = fx.set(one, 'proactive');
  eq(first.code, 0, 'set exits 0 and creates the missing root');
  eq(first.stdout, `set ${keyOf(one)} proactive in ${fx.storePath}\n`, 'set names the key, the policy and the store');
  eq(fx.set(two, 'focused').code, 0, 'a second repo\'s set exits 0');
  eq(fx.check(one).stdout, `proactive ${keyOf(one)}\n`, 'check prints the first repo\'s saved policy');
  eq(fx.check(two).stdout, `focused ${keyOf(two)}\n`, 'check prints the second repo\'s saved policy');
  eq(JSON.stringify(fx.store()),
    JSON.stringify({ [keyOf(one)]: { changePolicy: 'proactive' }, [keyOf(two)]: { changePolicy: 'focused' } }),
    'a store that holds only policies maps each key to an object whose one field is changePolicy');
  eq(fx.set(one, 'focused').code, 0, 'set replaces a saved policy');
  eq(JSON.stringify(fx.store()),
    JSON.stringify({ [keyOf(two)]: { changePolicy: 'focused' }, [keyOf(one)]: { changePolicy: 'focused' } }),
    'the replaced key appears once, and the other key survives');
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'no temp file is left beside the store');
  mkdirSync(join(one, 'sub'));
  eq(fx.check(join(one, 'sub')).stdout, `focused ${keyOf(one)}\n`, 'a subdirectory reads its repo\'s key');
  eq(fx.cliIn(join(one, 'sub'), 'check', '--root', fx.state, '--repo', '.').stdout, `focused ${keyOf(one)}\n`,
    'a relative --repo resolves against the working directory');
});

section('the checkout ignores the store, its temp file and the backlog, since a run\'s root can be the checkout');
withFixture((fx) => {
  const repo = fx.repo('ignores');
  copyFileSync(join(REPO_ROOT, '.gitignore'), join(repo, '.gitignore'));
  // A crash between the write and the rename leaves the temp file, named this way, beside the store.
  for (const name of [STORE_FILE, `${STORE_FILE}.4242.tmp`, 'backlog/r-0123abcd/run-block.md']) {
    eq(fx.git(repo, 'check-ignore', '-q', '--no-index', name).code, 0, `the checkout's .gitignore ignores ${name} at its root`);
  }
});

section('backlog prints the project\'s folder under the root, reads no setting and creates nothing');
withFixture((fx) => {
  const same = fx.repo('a/same');
  const twin = fx.repo('b/same');
  const printed = fx.backlog(same);
  eq(printed.code, 0, 'backlog exits 0');
  eq(printed.stdout, backlogOf(fx.state, keyOf(same), 'same'),
    'backlog prints <root>/backlog/<last segment>-<8 hex digits of the folded key\'s SHA-256>/ with forward slashes');
  ok(!printed.stdout.includes('\\'), 'the printed folder holds no backslash');
  const twinPrinted = fx.backlog(twin).stdout;
  eq(twinPrinted, backlogOf(fx.state, keyOf(twin), 'same'), 'a second repo with the same folder name prints its own key\'s folder');
  ok(twinPrinted !== printed.stdout, 'two repos with the same last segment get different backlog folders');
  ok(!existsSync(fx.state), 'backlog creates neither the folder nor the root');
  eq(fx.cliIn(fx.root, 'backlog', '--root', 'state', '--repo', join('a', 'same')).stdout, printed.stdout,
    'a relative --root and --repo print the same absolute folder');
  eq(fx.set(same, 'proactive').code, 0, 'set exits 0');
  eq(fx.backlog(same).stdout, printed.stdout, 'a saved policy does not change the folder');
  writeFileSync(fx.storePath, '{ "E:/r": ');
  eq(fx.backlog(same).stdout, printed.stdout, 'a store that does not parse does not stop backlog, which reads no setting');
  if (FOLDS_CASE) eq(fx.backlog(same.toUpperCase()).stdout, printed.stdout, 'an upper-case spelling of --repo prints the same folder');
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'backlog leaves the root as it found it');
});

section('the backlog folder name is a valid folder name for every key');
const NAME = /^(.*)-([0-9a-f]{8})$/;
const segmentOf = (name) => NAME.exec(name)?.[1] ?? null;
const hashOf = (name) => NAME.exec(name)?.[2] ?? null;
eq(segmentOf(projectName('C:/', true)), 'C', 'a drive root\'s segment drops the colon');
eq(segmentOf(projectName('/', false)), '', 'a file system root has an empty segment');
eq(segmentOf(projectName('/w/a<b>:c"d|e?f*g\\h\u0001i', false)), 'abcdefghi', 'the segment drops each character a Windows file name refuses');
eq(segmentOf(projectName(`/w/${'x'.repeat(250)}`, false)), 'x'.repeat(48), 'a long segment is cut to 48 characters');
eq(segmentOf(projectName(`/w/${'\u{1d4b3}'.repeat(60)}`, false)), '\u{1d4b3}'.repeat(48),
  'the cut counts characters and never splits a surrogate pair');
eq(hashOf(projectName('E:/Work/R', true)), hashOf(projectName('e:/work/r', true)), 'a folding name hashes the key after case folding');
ok(hashOf(projectName('/w/R', false)) !== hashOf(projectName('/w/r', false)), 'a case-sensitive name hashes the key as it is');

section('a linked worktree reads its main checkout\'s key and backlog folder');
withFixture((fx) => {
  const main = fx.repo('main');
  fx.commit(main, USER);
  const linked = join(fx.root, 'linked');
  eq(fx.git(main, 'worktree', 'add', '-q', linked, '-b', 'side').code, 0, 'the fixture worktree is added');
  eq(fx.set(main, 'proactive').code, 0, 'set on the main checkout exits 0');
  eq(fx.check(linked).stdout, `proactive ${keyOf(main)}\n`, 'check from the worktree prints the main checkout\'s policy and key');
  eq(fx.backlog(linked).stdout, fx.backlog(main).stdout, 'backlog from the worktree prints the main checkout\'s folder');
  eq(fx.set(linked, 'focused').stdout, `set ${keyOf(main)} focused in ${fx.storePath}\n`, 'set from the worktree writes the main checkout\'s key');
  eq(Object.keys(fx.store()).join(','), keyOf(main), 'the store holds one key');
});

section('a common dir not named .git keys the git dir itself');
withFixture((fx) => {
  const bare = join(fx.root, 'b.git');
  eq(fx.git(fx.root, 'init', '-q', '--bare', bare).code, 0, 'the fixture bare repository is created');
  eq(fx.check(bare).stdout, `missing ${keyOf(bare)} recommend=proactive\n`, 'a bare repository is keyed by its git dir');
  eq(fx.backlog(bare).stdout, backlogOf(fx.state, keyOf(bare), 'b.git'), 'a bare repository\'s backlog folder names its git dir');
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
const focused = { changePolicy: 'focused' };
const proactive = { changePolicy: 'proactive' };
eq(savedKey({ 'E:/Work/R': focused }, 'e:/work/r', true), 'E:/Work/R', 'a folding lookup finds another spelling');
eq(savedKey({ 'E:/Work/R': focused }, 'e:/work/r', false), null, 'a case-sensitive lookup does not');
eq(savedKey({}, 'constructor', false), null, 'a lookup never resolves to an inherited member');
eq(JSON.stringify(withPolicy({ 'E:/Work/R': focused, 'E:/x': focused }, 'e:/work/r', 'proactive', true)),
  JSON.stringify({ 'E:/x': focused, 'e:/work/r': proactive }), 'a folding set replaces the other spelling and keeps the other key');
eq(JSON.stringify(withPolicy({ 'E:/Work/R': focused }, 'e:/work/r', 'proactive', false)),
  JSON.stringify({ 'E:/Work/R': focused, 'e:/work/r': proactive }), 'a case-sensitive set keeps both spellings');
eq(JSON.stringify(withPolicy({ 'E:/Work/R': { changePolicy: 'focused', later: 1 } }, 'e:/work/r', 'proactive', true)),
  JSON.stringify({ 'e:/work/r': { changePolicy: 'proactive', later: 1 } }), 'a set keeps the other settings of the spelling it replaces');
withFixture((fx) => {
  const repo = fx.repo('Repo');
  const key = keyOf(repo);
  if (FOLDS_CASE) {
    eq(fx.set(repo, 'proactive').code, 0, 'set exits 0');
    eq(fx.check(repo.toUpperCase()).stdout, `proactive ${key}\n`, 'an upper-case spelling of --repo finds the same key');
    writeFileSync(fx.storePath, JSON.stringify({ [key.toUpperCase()]: focused }));
    eq(fx.check(repo).stdout, `focused ${key}\n`, 'a stored key in another case is found');
    eq(fx.set(repo.toLowerCase(), 'proactive').code, 0, 'set through a lower-case spelling exits 0');
    eq(JSON.stringify(fx.store()), JSON.stringify({ [key]: proactive }), 'the store keeps one spelling, the real path');
  } else {
    mkdirSync(fx.state);
    writeFileSync(fx.storePath, JSON.stringify({ [key.toUpperCase()]: focused }));
    eq(fx.check(repo).stdout, `missing ${key} recommend=proactive\n`, 'a stored key in another case is another repo here');
  }
});

section('the recommendation: proactive for no commits or only the user\'s email, focused otherwise');
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
  eq(fx.check(shared).stdout, `missing ${keyOf(shared)} recommend=focused\n`, 'a second author recommends focused');
  const branched = fx.repo('branched');
  fx.commit(branched, USER);
  fx.git(branched, 'checkout', '-q', '-b', 'theirs');
  fx.commit(branched, 'other@example.invalid');
  fx.git(branched, 'checkout', '-q', 'main');
  eq(fx.check(branched).stdout, `missing ${keyOf(branched)} recommend=focused\n`,
    'a second author on a branch that HEAD does not reach recommends focused');
  fx.setEmail(null);
  eq(fx.check(mine).stdout, `missing ${keyOf(mine)} recommend=focused\n`, 'commits and an unset user.email recommend focused');
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

section('a store that is not a JSON object of repo settings fails every verb that reads it, and a write leaves its bytes');
for (const [what, bytes, cause] of [
  ['a store that does not parse', '{ "E:/r": ', /does not parse as JSON/],
  ['a store that holds an array', '[{ "changePolicy": "focused" }]\n', /does not hold a JSON object/],
  ['a store value that is a bare policy', '{ "E:/x": "focused" }\n', /maps "E:\/x" to "focused", which is not an object of repo settings/],
  ['a store value with an unknown field', '{ "E:/x": { "changePolicy": "focused", "theme": "dark" } }\n',
    /gives "E:\/x" the field "theme", and the fields a repo takes are changePolicy, commit, provision, worktreeDir, models, efforts/],
  ['a changePolicy outside the three policies', '{ "E:/x": { "changePolicy": "lenient" } }\n',
    /gives "E:\/x" a changePolicy of "lenient", which is none of focused \| proactive \| auto/],
  ['a changePolicy of the retired name strict', '{ "E:/x": { "changePolicy": "strict" } }\n',
    /gives "E:\/x" a changePolicy of "strict", which is none of focused \| proactive \| auto/],
  ['a commit that is a string', '{ "E:/x": { "commit": "on" } }\n',
    /gives "E:\/x" a commit of "on", which is neither true nor false/],
  ['a commit that is null', '{ "E:/x": { "commit": null } }\n',
    /gives "E:\/x" a commit of null, which is neither true nor false/],
  ['a models value that is not an object', '{ "E:/x": { "models": "opus" } }\n',
    /gives "E:\/x" models of "opus", which is not an object that maps a role key to a value/],
  ['an efforts value that is an array', '{ "E:/x": { "efforts": ["high"] } }\n',
    /gives "E:\/x" efforts of \["high"\], which is not an object that maps a role key to a value/],
  ['a models role outside the five', '{ "E:/x": { "models": { "reviewer": "opus" } } }\n',
    /gives "E:\/x" the role "reviewer" in models, and the role keys are develop \| park \| quality \| acceptance \| sweep/],
  ['a models value outside the model names', '{ "E:/x": { "models": { "develop": "gpt" } } }\n',
    /gives "E:\/x" the models value of "gpt" for develop, which is none of opus \| sonnet \| haiku \| fable/],
  ['an efforts value outside the reasoning levels', '{ "E:/x": { "efforts": { "sweep": "extreme" } } }\n',
    /gives "E:\/x" the efforts value of "extreme" for sweep, which is none of low \| medium \| high \| xhigh \| max/],
  ['an efforts value that is not a string', '{ "E:/x": { "efforts": { "park": 3 } } }\n',
    /gives "E:\/x" the efforts value of 3 for park/],
]) {
  withFixture((fx) => {
    const repo = fx.repo('r');
    mkdirSync(fx.state);
    writeFileSync(fx.storePath, bytes);
    for (const [verb, result] of [['check', fx.check(repo)], ['roles', fx.roles(repo)], ['commit', fx.commitOf(repo)]]) {
      ok(result.code === 1 && cause.test(result.stderr) && result.stderr.includes(fx.storePath) && result.stdout === '',
        `${what}: ${verb} exits 1 naming the store and the cause (${result.stderr.trim()})`);
    }
    for (const [verb, result] of [['set', fx.set(repo, 'focused')], ['set --commit', fx.setWith(repo, '--commit', 'on')],
      ['set-roles', fx.setRoles(repo, '--models', 'develop=opus')]]) {
      ok(result.code === 1 && cause.test(result.stderr) && result.stderr.includes(fx.storePath),
        `${what}: ${verb} exits 1 naming the store and the cause`);
      eq(readFileSync(fx.storePath, 'utf8'), bytes, `${what}: ${verb} leaves the store byte-identical`);
    }
    eq(readdirSync(fx.state).join(','), STORE_FILE, `${what}: a write leaves no temp file`);
  });
}

section('a store value with no field is a valid empty settings object');
withFixture((fx) => {
  const repo = fx.repo('r');
  mkdirSync(fx.state);
  writeFileSync(fx.storePath, `${JSON.stringify({ 'E:/x': {} })}\n`);
  eq(fx.check(repo).stdout, `missing ${keyOf(repo)} recommend=proactive\n`, 'check reads another key\'s empty settings as valid');
  eq(fx.roles(repo).stdout, '{"models":{},"efforts":{}}\n', 'roles reads the same store as valid');
});

section('roles prints the saved maps, an empty object for a map not saved, and never asks or recommends');
withFixture((fx) => {
  const repo = fx.repo('r');
  fx.commit(repo, 'other@example.invalid');
  const none = fx.roles(repo);
  eq(none.stdout, '{"models":{},"efforts":{}}\n', 'a repo with no store prints two empty maps');
  ok(none.code === 0 && none.stderr === '', 'roles exits 0 with no output on stderr');
  ok(!existsSync(fx.state), 'roles writes nothing');
  mkdirSync(fx.state);
  writeFileSync(fx.storePath, `${JSON.stringify({ [keyOf(repo)]: { changePolicy: 'proactive', models: { quality: 'sonnet' } } })}\n`);
  eq(fx.roles(repo).stdout, '{"models":{"quality":"sonnet"},"efforts":{}}\n', 'a saved models map prints beside an empty efforts map');
  writeFileSync(fx.storePath, `${JSON.stringify({ [keyOf(repo)]: { efforts: { develop: 'max', sweep: 'low' } } })}\n`);
  eq(fx.roles(repo).stdout, '{"models":{},"efforts":{"develop":"max","sweep":"low"}}\n', 'a saved efforts map prints beside an empty models map');
});

section('set-roles merges each named role, keeps every other setting and prints what it saved');
withFixture((fx) => {
  const repo = fx.repo('r');
  const other = fx.repo('other');
  const key = keyOf(repo);
  eq(fx.set(repo, 'proactive').code, 0, 'the fixture policy is saved');
  eq(fx.set(other, 'focused').code, 0, 'a second repo\'s policy is saved');
  const first = fx.setRoles(repo, '--models', 'develop=sonnet,quality=opus', '--efforts', 'develop=xhigh');
  eq(first.code, 0, 'set-roles exits 0');
  eq(first.stdout, `set-roles ${key} {"models":{"develop":"sonnet","quality":"opus"},"efforts":{"develop":"xhigh"}} in ${fx.storePath}\n`,
    'set-roles names the key, the saved maps and the store');
  eq(fx.store()[key].changePolicy, 'proactive', 'the saved policy survives');
  eq(fx.store()[keyOf(other)].changePolicy, 'focused', 'the second repo survives');
  const merged = fx.setRoles(repo, '--models', 'quality=haiku,sweep=fable');
  eq(merged.stdout, `set-roles ${key} {"models":{"develop":"sonnet","quality":"haiku","sweep":"fable"},"efforts":{"develop":"xhigh"}} in ${fx.storePath}\n`,
    'a named role replaces its value, a new role joins, and an unnamed role and the other map stay');
  eq(fx.roles(repo).stdout, '{"models":{"develop":"sonnet","quality":"haiku","sweep":"fable"},"efforts":{"develop":"xhigh"}}\n', 'roles prints the merged maps');
  eq(fx.check(repo).stdout, `proactive ${key}\n`, 'check still prints the saved policy');
  const removed = fx.setRoles(repo, '--models', 'develop=default,quality=default,sweep=default', '--efforts', 'park=default');
  eq(removed.code, 0, 'the value default exits 0');
  eq(fx.roles(repo).stdout, '{"models":{},"efforts":{"develop":"xhigh"}}\n', 'default removes each named role, and removing an unsaved role is a no-op');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ changePolicy: 'proactive', efforts: { develop: 'xhigh' } }), 'a map left empty leaves the store');
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'no temp file is left beside the store');
});

section('set-roles that changes nothing writes no store');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  const empty = fx.setRoles(repo, '--models', 'develop=default');
  eq(empty.code, 0, 'removing a role of an unsaved repo exits 0');
  eq(empty.stdout, `set-roles ${key} {"models":{},"efforts":{}} in ${fx.storePath}\n`, 'it prints the empty maps');
  ok(!existsSync(fx.storePath), 'it creates no store');
  eq(fx.setRoles(repo, '--models', 'develop=opus').code, 0, 'a role is saved');
  // An old mtime, so any rewrite of the store shows as a new one.
  const past = new Date('2000-01-01T00:00:00Z');
  utimesSync(fx.storePath, past, past);
  const before = readFileSync(fx.storePath, 'utf8');
  eq(fx.setRoles(repo, '--models', 'develop=opus', '--efforts', 'park=default').code, 0, 'the saved value and an unsaved removal exit 0');
  eq(statSync(fx.storePath).mtimeMs, past.getTime(), 'the store file is not rewritten');
  eq(readFileSync(fx.storePath, 'utf8'), before, 'the store stays byte-for-byte unchanged');
  eq(fx.setRoles(repo, '--models', 'develop=default').code, 0, 'removing the last saved role exits 0');
  eq(JSON.stringify(fx.store()), JSON.stringify({}), 'the repo it leaves with no setting has no store entry');
});

section('a role-only repo reads missing from check, and set then adds its policy');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  eq(fx.setRoles(repo, '--efforts', 'develop=high').code, 0, 'set-roles creates the store for a repo with no policy');
  eq(fx.check(repo).stdout, `missing ${key} recommend=proactive\n`, 'check prints missing with the recommendation, as for an unsaved repo');
  eq(fx.set(repo, 'focused').code, 0, 'set saves the policy');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ efforts: { develop: 'high' }, changePolicy: 'focused' }), 'the saved efforts survive the policy');
  eq(fx.check(repo).stdout, `focused ${key}\n`, 'check prints the policy');
});

section('commit prints on, off or missing, never asks or recommends, and writes nothing');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  fx.commit(repo, 'other@example.invalid');
  const none = fx.commitOf(repo);
  eq(none.stdout, `missing ${key}\n`, 'a repo with no store prints missing and the key, with no recommendation');
  ok(none.code === 0 && none.stderr === '', 'commit exits 0 with no output on stderr');
  ok(!existsSync(fx.state), 'commit writes nothing');
  eq(fx.set(repo, 'focused').code, 0, 'the fixture policy is saved');
  eq(fx.commitOf(repo).stdout, `missing ${key}\n`, 'a repo that saved only a policy prints missing');
  writeFileSync(fx.storePath, `${JSON.stringify({ [key]: { changePolicy: 'focused', commit: true } })}\n`);
  eq(fx.commitOf(repo).stdout, `on ${key}\n`, 'a saved true prints on');
  writeFileSync(fx.storePath, `${JSON.stringify({ [key]: { commit: false } })}\n`);
  eq(fx.commitOf(repo).stdout, `off ${key}\n`, 'a saved false prints off, with no policy saved');
  const linked = join(fx.root, 'linked');
  eq(fx.git(repo, 'worktree', 'add', '-q', linked, '-b', 'side').code, 0, 'the fixture worktree is added');
  eq(fx.commitOf(linked).stdout, `off ${key}\n`, 'a linked worktree reads its main checkout\'s choice');
});

section('set --commit saves the choice and keeps every other saved setting');
withFixture((fx) => {
  const repo = fx.repo('r');
  const other = fx.repo('other');
  const key = keyOf(repo);
  eq(fx.set(other, 'focused').code, 0, 'a second repo\'s policy is saved');
  eq(fx.set(repo, 'proactive').code, 0, 'the fixture policy is saved');
  eq(fx.setRoles(repo, '--models', 'develop=sonnet', '--efforts', 'park=low').code, 0, 'the fixture roles are saved');
  const on = fx.setWith(repo, '--commit', 'on');
  eq(on.code, 0, 'set --commit on exits 0');
  eq(on.stdout, `set ${key} commit=on in ${fx.storePath}\n`, 'set names the key, the commit choice and the store');
  eq(JSON.stringify(fx.store()[key]),
    JSON.stringify({ changePolicy: 'proactive', models: { develop: 'sonnet' }, efforts: { park: 'low' }, commit: true }),
    'the commit field is the boolean true, and the policy and both role maps stay');
  eq(fx.store()[keyOf(other)].changePolicy, 'focused', 'the second repo survives');
  eq(fx.commitOf(repo).stdout, `on ${key}\n`, 'commit prints on');
  eq(fx.check(repo).stdout, `proactive ${key}\n`, 'check prints the policy as before');
  const off = fx.setWith(repo, '--commit', 'off');
  eq(off.stdout, `set ${key} commit=off in ${fx.storePath}\n`, 'set --commit off names the choice');
  eq(JSON.stringify(fx.store()[key]),
    JSON.stringify({ changePolicy: 'proactive', models: { develop: 'sonnet' }, efforts: { park: 'low' }, commit: false }),
    'the commit field is the boolean false, and every other setting stays');
  eq(fx.commitOf(repo).stdout, `off ${key}\n`, 'commit prints off');
  eq(fx.set(repo, 'focused').code, 0, 'a later set --policy exits 0');
  eq(fx.store()[key].commit, false, 'a later set --policy keeps the commit choice');
  eq(fx.setRoles(repo, '--models', 'develop=default').code, 0, 'a later set-roles exits 0');
  eq(fx.store()[key].commit, false, 'a later set-roles keeps the commit choice');
  eq(fx.roles(repo).stdout, '{"models":{},"efforts":{"park":"low"}}\n', 'roles prints the maps that set-roles left');
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'no temp file is left beside the store');
});

section('provision prints the saved command, none or null, and set --provision keeps every other setting');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  const provisionOf = () => fx.cli('provision', '--root', fx.state, '--repo', repo);
  eq(provisionOf().stdout, `${JSON.stringify({ key, provision: null, worktreeDir: null })}\n`, 'a repo with no store prints a null provision and a null worktreeDir');
  ok(!existsSync(fx.state), 'provision writes nothing');
  eq(fx.setWith(repo, '--policy', 'focused', '--commit', 'on').code, 0, 'the fixture policy and commit choice are saved');
  const saved = fx.setWith(repo, '--provision', 'pnpm install --frozen-lockfile');
  eq(saved.stdout, `set ${key} provision in ${fx.storePath}\n`, 'set names the provision it saved');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ changePolicy: 'focused', commit: true, provision: 'pnpm install --frozen-lockfile' }),
    'the command is saved beside the policy and the commit choice');
  eq(provisionOf().stdout, `${JSON.stringify({ key, provision: 'pnpm install --frozen-lockfile', worktreeDir: null })}\n`, 'provision prints the command');
  eq(fx.setWith(repo, '--provision', 'none').code, 0, 'set --provision none exits 0');
  eq(JSON.parse(provisionOf().stdout).provision, 'none', 'provision prints none');
  const blank = fx.setWith(repo, '--provision', ' ');
  ok(blank.code === 1 && /--provision needs a value/.test(blank.stderr), `a blank --provision exits 1: ${blank.stderr.trim()}`);
  for (const bad of ['', 3]) {
    writeFileSync(fx.storePath, `${JSON.stringify({ [key]: { provision: bad } })}\n`);
    const r = provisionOf();
    ok(r.code === 1 && /not a command or "none"/.test(r.stderr), `a stored provision of ${JSON.stringify(bad)} exits 1: ${r.stderr.trim()}`);
  }
});

section('set --worktree-dir saves the folder that holds the run worktrees, provision prints it, and default removes it');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  const dir = join(fx.root, 'trees');
  const provisionOf = () => fx.cli('provision', '--root', fx.state, '--repo', repo);
  eq(fx.setWith(repo, '--policy', 'focused', '--provision', 'none').code, 0, 'the fixture policy and provision are saved');
  const saved = fx.setWith(repo, '--worktree-dir', dir);
  eq(saved.stdout, `set ${key} worktreeDir in ${fx.storePath}\n`, 'set names the worktreeDir it saved');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ changePolicy: 'focused', provision: 'none', worktreeDir: dir }), 'the folder is saved beside the other settings');
  eq(JSON.parse(provisionOf().stdout).worktreeDir, dir, 'provision prints the folder');
  eq(fx.setWith(repo, '--worktree-dir', 'default').code, 0, 'set --worktree-dir default exits 0');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ changePolicy: 'focused', provision: 'none' }), '...and removes the field, keeping the other settings');
  eq(JSON.parse(provisionOf().stdout).worktreeDir, null, 'provision prints null again');
  const relative = fx.setWith(repo, '--worktree-dir', 'trees');
  ok(relative.code === 1 && /--worktree-dir "trees" is neither an absolute path nor default/.test(relative.stderr), `a relative folder exits 1: ${relative.stderr.trim()}`);
  writeFileSync(fx.storePath, `${JSON.stringify({ [key]: { worktreeDir: 'trees' } })}\n`);
  const stored = provisionOf();
  ok(stored.code === 1 && /a worktreeDir of "trees", which is not an absolute path/.test(stored.stderr), `a stored relative folder exits 1: ${stored.stderr.trim()}`);
});

section('set takes --policy and --commit together, and a repo that saved only a commit choice reads missing from check');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  const both = fx.setWith(repo, '--policy', 'focused', '--commit', 'on');
  eq(both.code, 0, 'set with both flags exits 0');
  eq(both.stdout, `set ${key} focused commit=on in ${fx.storePath}\n`, 'set names the policy and the commit choice');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ changePolicy: 'focused', commit: true }), 'both fields are saved');
  const reversed = fx.setWith(repo, '--commit', 'off', '--policy', 'proactive');
  eq(reversed.stdout, `set ${key} proactive commit=off in ${fx.storePath}\n`, 'the flag order does not change the output');
  eq(JSON.stringify(fx.store()[key]), JSON.stringify({ changePolicy: 'proactive', commit: false }), 'both fields are replaced');
  const only = fx.repo('only');
  eq(fx.setWith(only, '--commit', 'on').code, 0, 'set --commit alone creates the store entry for a repo with no policy');
  eq(fx.check(only).stdout, `missing ${keyOf(only)} recommend=proactive\n`, 'check prints missing with the recommendation');
  eq(fx.set(only, 'focused').code, 0, 'set saves the policy');
  eq(JSON.stringify(fx.store()[keyOf(only)]), JSON.stringify({ commit: true, changePolicy: 'focused' }), 'the saved commit choice survives the policy');
  eq(fx.check(only).stdout, `focused ${keyOf(only)}\n`, 'check prints only the policy, though the repo saved a commit choice');
});

section('a bad --commit argument exits 1 with its cause and leaves the store byte-for-byte unchanged');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  mkdirSync(fx.state);
  const bytes = `${JSON.stringify({ [key]: { changePolicy: 'focused', commit: true } }, null, 2)}\n`;
  writeFileSync(fx.storePath, bytes);
  for (const [what, flags, cause] of [
    ['true as the value', ['--commit', 'true'], /--commit "true" is neither on nor off/],
    ['an upper-case value', ['--commit', 'ON'], /--commit "ON" is neither on nor off/],
    ['an inherited member name', ['--commit', 'constructor'], /--commit "constructor" is neither on nor off/],
    ['a flag with no value', ['--commit'], /--commit needs a value/],
    ['a flag given twice', ['--commit', 'on', '--commit', 'off'], /--commit was given twice/],
    ['a valid --policy and a bad --commit', ['--policy', 'proactive', '--commit', 'maybe'], /--commit "maybe" is neither on nor off/],
    ['a bad --policy and a valid --commit', ['--commit', 'off', '--policy', 'lenient'], /--policy "lenient" is none of focused \| proactive \| auto/],
    ['neither flag', [], /set needs --policy or --commit/],
  ]) {
    const r = fx.setWith(repo, ...flags);
    ok(r.code === 1 && cause.test(r.stderr) && r.stderr.startsWith('project-settings: ') && r.stdout === '',
      `${what} exits 1 naming the cause (${r.stderr.trim().slice(0, 140)})`);
    eq(readFileSync(fx.storePath, 'utf8'), bytes, `${what} leaves the store byte-for-byte unchanged`);
  }
  for (const verb of ['commit', 'check']) {
    const r = fx.cli(verb, '--root', fx.state, '--repo', repo, '--commit', 'on');
    ok(r.code === 1 && r.stderr.includes(`unknown flag "--commit" for ${verb}`), `${verb} takes no --commit (${r.stderr.trim().slice(0, 100)})`);
  }
  eq(readFileSync(fx.storePath, 'utf8'), bytes, 'the unknown flags leave the store byte-for-byte unchanged');
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'no rejection leaves a temp file');
});

section('set-roles rejects a bad argument with its cause and leaves the store byte-for-byte unchanged');
withFixture((fx) => {
  const repo = fx.repo('r');
  const key = keyOf(repo);
  mkdirSync(fx.state);
  const bytes = `${JSON.stringify({ [key]: { changePolicy: 'focused', models: { develop: 'opus' } } }, null, 2)}\n`;
  writeFileSync(fx.storePath, bytes);
  for (const [what, flags, cause] of [
    ['no role flag', [], /set-roles needs --models or --efforts/],
    ['a role outside the five', ['--models', 'reviewer=opus'], /--models names the role "reviewer", and the role keys are develop \| park \| quality \| acceptance \| sweep/],
    ['a model outside its set', ['--models', 'develop=gpt'], /--models gives develop the value "gpt", which is none of opus \| sonnet \| haiku \| fable \| default/],
    ['an effort outside its set', ['--efforts', 'develop=extreme'], /--efforts gives develop the value "extreme", which is none of low \| medium \| high \| xhigh \| max \| default/],
    ['a model given to --efforts', ['--efforts', 'develop=opus'], /--efforts gives develop the value "opus"/],
    ['an effort given to --models', ['--models', 'develop=high'], /--models gives develop the value "high"/],
    ['a pair with no value', ['--models', 'develop'], /--models has the pair "develop", which is not <role>=<value>/],
    ['a pair with an empty value', ['--models', 'develop='], /--models has the pair "develop=", which is not <role>=<value>/],
    ['a pair with an empty role', ['--efforts', '=high'], /--efforts has the pair "=high", which is not <role>=<value>/],
    ['a pair with two equals signs', ['--models', 'develop=opus=sonnet'], /--models has the pair "develop=opus=sonnet"/],
    ['an empty pair after a comma', ['--models', 'develop=opus,'], /--models has the pair "", which is not <role>=<value>/],
    ['a role named twice', ['--models', 'develop=opus,develop=sonnet'], /--models names the role develop twice/],
    ['a valid --models and a bad --efforts', ['--models', 'develop=sonnet', '--efforts', 'park=extreme'], /--efforts gives park the value "extreme"/],
    ['a flag given twice', ['--models', 'develop=opus', '--models', 'park=opus'], /--models was given twice/],
    ['a value that looks like a flag', ['--models', '--efforts'], /--models needs a value/],
    ['an unknown flag', ['--policy', 'focused'], /unknown flag "--policy" for set-roles/],
  ]) {
    const r = fx.setRoles(repo, ...flags);
    ok(r.code === 1 && cause.test(r.stderr) && r.stderr.startsWith('project-settings: ') && r.stdout === '',
      `${what} exits 1 naming the cause (${r.stderr.trim().slice(0, 140)})`);
    eq(readFileSync(fx.storePath, 'utf8'), bytes, `${what} leaves the store byte-for-byte unchanged`);
  }
  eq(readdirSync(fx.state).join(','), STORE_FILE, 'no rejection leaves a temp file');
  const absent = fx.repo('absent');
  eq(fx.setRoles(absent, '--models', 'develop=gpt').code, 1, 'a rejection on a repo with no store exits 1');
  eq(readFileSync(fx.storePath, 'utf8'), bytes, 'and writes no key for it');
});

section('withCommit keeps the other settings, folds the key and never mutates');
eq(JSON.stringify(withCommit({ 'E:/Work/R': { changePolicy: 'focused', models: { park: 'haiku' } }, 'E:/x': focused }, 'e:/work/r', true, true)),
  JSON.stringify({ 'E:/x': focused, 'e:/work/r': { changePolicy: 'focused', models: { park: 'haiku' }, commit: true } }),
  'a folding set adds the choice to the other spelling and keeps the other key');
eq(JSON.stringify(withCommit({ k: { commit: true } }, 'k', false, false)), JSON.stringify({ k: { commit: false } }),
  'a later choice replaces the saved one, and false stays a saved field');
const frozenCommit = { k: { changePolicy: 'focused' } };
withCommit(frozenCommit, 'k', true, false);
eq(JSON.stringify(frozenCommit), JSON.stringify({ k: { changePolicy: 'focused' } }), 'withCommit never mutates the store it is given');

section('withRoles keeps the other settings, drops a map it empties and folds the key');
eq(JSON.stringify(withRoles({ 'E:/Work/R': { changePolicy: 'focused', models: { park: 'haiku' } }, 'E:/x': focused }, 'e:/work/r',
  { models: { develop: 'opus' }, efforts: { sweep: 'max' } }, true)),
JSON.stringify({ 'E:/x': focused, 'e:/work/r': { changePolicy: 'focused', models: { park: 'haiku', develop: 'opus' }, efforts: { sweep: 'max' } } }),
'a folding set merges into the other spelling and keeps the other key');
eq(JSON.stringify(withRoles({ k: { models: { park: 'haiku' } } }, 'k', { models: { park: 'default' } }, false)), JSON.stringify({}),
  'default removes the last role, its map and the key it leaves empty');
const frozen = { k: { models: { park: 'haiku' } } };
withRoles(frozen, 'k', { models: { park: 'opus' } }, false);
eq(JSON.stringify(frozen), JSON.stringify({ k: { models: { park: 'haiku' } } }), 'withRoles never mutates the store it is given');

section('the engine\'s role keys, model names and reasoning levels match the copies project-settings uses');
const engineSource = readFileSync(join(REPO_ROOT, 'workflows/develop/develop-cycle.mjs'), 'utf8');
/** The three sets the engine declares, read from its source, or a name for each it fails to declare. */
function engineSets(source) {
  const quoted = (pattern) => {
    const hit = pattern.exec(source);
    return hit === null ? null : [...hit[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  };
  return {
    roleKeys: quoted(/const ROLE_KEYS = \[([^\]]*)\]/),
    models: quoted(/const VALID_MODELS = new Set\(\[([^\]]*)\]\)/),
    efforts: quoted(/const VALID_EFFORTS = new Set\(\[([^\]]*)\]\)/),
  };
}
/** The names of the sets in which `sets` differs from the copies in project-settings, order included. */
const differingSets = (sets) => Object.entries({ roleKeys: ROLE_KEYS, models: MODELS, efforts: EFFORTS })
  .filter(([name, copy]) => JSON.stringify(sets[name]) !== JSON.stringify(copy)).map(([name]) => name);
eq(differingSets(engineSets(engineSource)).join(','), '', 'the engine\'s three sets equal the copies in project-settings');
for (const [name, from, to] of [
  ['roleKeys', "'sweep']", "'sweep', 'extra']"],
  ['models', "'fable'])", "'fable', 'gpt'])"],
  ['efforts', "'max'])", "'max', 'extreme'])"],
]) {
  ok(engineSource.includes(from), `the engine source holds ${from}, which the scratch copy changes`);
  eq(differingSets(engineSets(engineSource.replace(from, to))).join(','), name, `a scratch copy of the engine with a changed ${name} set fails only the ${name} check`);
}
ok(differingSets(engineSets('')).length === 3, 'an engine source that declares none of the sets fails all three checks');

section('a bad argument exits 1 and writes nothing');
withFixture((fx) => {
  const repo = fx.repo('r');
  const plain = join(fx.root, 'plain');
  mkdirSync(plain);
  for (const [what, argv, cause] of [
    ['an invalid policy', ['set', '--root', fx.state, '--repo', repo, '--policy', 'lenient'], /--policy "lenient" is none of focused \| proactive \| auto/],
    ['the retired policy name', ['set', '--root', fx.state, '--repo', repo, '--policy', 'strict'], /--policy "strict" is now named focused\. Pass --policy focused\./],
    ['a --repo outside any git repository', ['check', '--root', fx.state, '--repo', plain], /is not in a git repository/],
    ['a backlog --repo outside any git repository', ['backlog', '--root', fx.state, '--repo', plain], /is not in a git repository/],
    ['an unknown verb', ['get', '--root', fx.state, '--repo', repo], /unknown verb "get"/],
    ['no verb', [], /no verb given/],
    ['an unknown flag', ['check', '--root', fx.state, '--repo', repo, '--policy', 'focused'], /unknown flag "--policy" for check/],
    ['a policy passed to backlog', ['backlog', '--root', fx.state, '--repo', repo, '--policy', 'focused'], /unknown flag "--policy" for backlog/],
    ['a missing flag', ['set', '--root', fx.state, '--repo', repo], /set needs --policy or --commit/],
    ['a backlog with no --root', ['backlog', '--repo', repo], /backlog needs --root/],
    ['a flag with no value', ['check', '--root', fx.state, '--repo'], /--repo needs a value/],
    ['a blank value', ['check', '--root', ' ', '--repo', repo], /--root needs a value/],
    ['a flag given twice', ['check', '--root', fx.state, '--repo', repo, '--repo', repo], /--repo was given twice/],
    ['a bare value', ['check', fx.state], /unexpected argument/],
  ]) {
    const r = fx.cli(...argv);
    ok(r.code === 1 && cause.test(r.stderr) && r.stderr.startsWith('project-settings: ') && r.stdout === '',
      `${what} exits 1 naming the cause (${r.stderr.trim().slice(0, 120)})`);
  }
  ok(fx.cliIn(fx.root, 'check', '--root', fx.state, '--repo', 'plain').stderr.includes(plain),
    'the repo failure names the absolute path of a relative --repo');
  ok(!existsSync(fx.state), 'no failure writes the store');
});
