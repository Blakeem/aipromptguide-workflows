// tools/launch.mjs — reserves a new launch folder per launch, so no launch writes where another did.
// Fixtures live under os.tmpdir(), never under tests/fixtures/, as in plan-edit.test.mjs.
import { execFile, execFileSync } from 'node:child_process';
import fs, { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { reserve } from '../tools/launch.mjs';

const dirs = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'aipg-launch-')); dirs.push(d); return d; };
const slashed = (p) => p.replace(/\\/g, '/');
const TOOL = join(REPO_ROOT, 'tools', 'launch.mjs');

/** Runs the CLI of `script` in the folder `cwd` and returns its exit code, stdout and stderr. */
const cli = (argv, script = TOOL, cwd = tmpdir()) => {
  try {
    return { code: 0, stderr: '', stdout: execFileSync(process.execPath, [script, ...argv], { encoding: 'utf8', stdio: 'pipe', cwd }) };
  } catch (e) { return { code: e.status ?? 1, stderr: String(e.stderr || ''), stdout: String(e.stdout || '') }; }
};

try {
  section('reserve creates a missing stateDir and numbers each launch one past the highest');
  {
    const state = join(tmpDir(), 'runs', 't-refine');
    const first = cli(['reserve', state]);
    eq(first.code, 0, 'the first reserve exits 0');
    const out = JSON.parse(first.stdout);
    eq(out.launchDir, `${slashed(state)}/launch-1`, 'it prints launch-1 as an absolute path with forward slashes');
    ok(existsSync(out.launchDir), 'and the folder exists');
    eq(JSON.stringify(out.kept), '[]', 'with nothing kept');
    eq(first.stdout.split('\n').filter(Boolean).length, 1, 'on one JSON line');
    eq(JSON.parse(cli(['reserve', state]).stdout).launchDir, `${slashed(state)}/launch-2`, 'a second reserve prints launch-2');
  }
  {
    const state = tmpDir();
    mkdirSync(join(state, 'launch-1'));
    mkdirSync(join(state, 'launch-3'));
    mkdirSync(join(state, 'launch-x'));
    writeFileSync(join(state, 'launch-9.md'), 'not a launch folder');
    eq(reserve(state).launchDir, `${slashed(state)}/launch-4`, 'launch-1 and launch-3 give launch-4, and other names count for nothing');
    eq(readdirSync(join(state, 'launch-3')).length, 0, 'and the existing folders are untouched');
  }
  {
    // An engine compares launchDir with its own spelling of the stateDir, and POSIX resolves a leading `//` to `/`.
    const base = tmpDir();
    writeFileSync(join(base, 'plan.md'), '# plan\n');
    const out = reserve(`${slashed(base)}/a/../state/`, ['../plan.md']);
    eq(out.launchDir, `${slashed(base)}/a/../state/launch-1`, 'it prints the launchDir in the caller\'s spelling of the stateDir, trailing slash dropped');
    eq(JSON.stringify(out.kept), JSON.stringify([`${slashed(base)}/a/../state/launch-1/kept/plan.md`]), 'and each kept copy in that spelling');
    ok(existsSync(join(base, 'state', 'launch-1', 'kept', 'plan.md')), 'while the folder and the copy sit at the resolved path');
    ok(!existsSync(join(base, 'a')), 'and the .. segment creates no folder');
  }

  section('a reserve that another reserve beats to launch-<n> takes the next free number');
  {
    const state = tmpDir();
    mkdirSync(join(state, 'launch-1'));
    const raced = resolve(state, 'launch-2');
    const realMkdir = fs.mkdirSync;
    let out = null;
    // syncBuiltinESMExports carries the patch into launch.mjs's named import, so the race lands between its scan
    // and its mkdirSync, which no sequence of real reserves reaches.
    fs.mkdirSync = (path, ...rest) => {
      if (resolve(String(path)) === raced && !existsSync(raced)) realMkdir(raced);
      return realMkdir(path, ...rest);
    };
    syncBuiltinESMExports();
    try { out = reserve(state); } finally { fs.mkdirSync = realMkdir; syncBuiltinESMExports(); }
    eq(out.launchDir, `${slashed(state)}/launch-3`, 'it skips the launch-2 that appeared after its scan and prints launch-3');
    eq(readdirSync(state).sort().join(','), 'launch-1,launch-2,launch-3', 'and leaves the other reserve\'s folder in place');
  }
  {
    const state = join(tmpDir(), 'state');
    const COUNT = 6;
    const runs = await Promise.all(Array.from({ length: COUNT }, () => promisify(execFile)(process.execPath, [TOOL, 'reserve', state], { encoding: 'utf8' })));
    const printed = runs.map(({ stdout }) => JSON.parse(stdout).launchDir);
    eq(new Set(printed).size, COUNT, `${COUNT} reserves started together print ${COUNT} distinct launch folders`);
    eq(readdirSync(state).filter((name) => /^launch-\d+$/.test(name)).length, COUNT, 'and create one folder each');
  }

  section('--keep copies each existing file and folder into kept/ and skips a missing path');
  {
    const base = tmpDir();
    const state = join(base, 'state');
    mkdirSync(state);
    writeFileSync(join(base, 'plan.md'), '# plan\n');
    mkdirSync(join(state, 'options', 'deep'), { recursive: true });
    writeFileSync(join(state, 'options', 'deep', 'a.md'), 'a\n');
    const r = cli(['reserve', state, '--keep', join(base, 'plan.md'), '--keep', 'options', '--keep', join(base, 'gone.md')]);
    eq(r.code, 0, 'a reserve with a missing --keep path still exits 0');
    const out = JSON.parse(r.stdout);
    const launch = `${slashed(state)}/launch-1`;
    eq(JSON.stringify(out.kept), JSON.stringify([`${launch}/kept/plan.md`, `${launch}/kept/options`]),
      'kept lists the copied file and the copied folder, the relative one resolved against the stateDir, and not the missing path');
    eq(readFileSync(join(state, 'launch-1', 'kept', 'plan.md'), 'utf8'), '# plan\n', 'the file is copied verbatim');
    eq(readFileSync(join(state, 'launch-1', 'kept', 'options', 'deep', 'a.md'), 'utf8'), 'a\n', 'the folder is copied with its subfolders');
    ok(!existsSync(join(state, 'launch-1', 'kept', 'gone.md')), 'and the missing path has no copy');
    ok(existsSync(join(state, 'options', 'deep', 'a.md')), 'the original folder stays in place');
  }
  {
    const state = tmpDir();
    const out = reserve(state, ['launch-1']);
    eq(JSON.stringify(out.kept), '[]', 'a --keep path that only the new launch folder makes exist is skipped');
  }

  section('--keep copies a link as the file or folder it names');
  {
    const base = tmpDir();
    const state = join(base, 'state');
    writeFileSync(join(base, 'plan.md'), '# plan\n');
    mkdirSync(join(base, 'notes'));
    writeFileSync(join(base, 'notes', 'n.md'), 'n\n');
    mkdirSync(join(base, 'options'));
    // A junction needs no privilege on Windows, and POSIX ignores the type, so this case runs anywhere.
    symlinkSync(join(base, 'notes'), join(base, 'notes-link'), 'junction');
    let fileLink = true;
    // A symlink on Windows needs Developer Mode or an elevated shell, so the cases that need one skip without it.
    try { symlinkSync(join(base, 'plan.md'), join(base, 'plan-link.md'), 'file'); } catch (err) {
      if (err.code !== 'EPERM') throw err;
      fileLink = false;
    }
    // Node 24 copies a junction inside a folder as a folder even without dereference, and keeps a symlink as a link.
    symlinkSync(join(base, 'notes'), join(base, 'options', 'notes'), fileLink ? 'dir' : 'junction');
    const keeps = ['--keep', join(base, 'options'), '--keep', join(base, 'notes-link')];
    if (fileLink) keeps.push('--keep', join(base, 'plan-link.md'));
    const r = cli(['reserve', state, ...keeps]);
    eq(r.code, 0, 'a reserve that keeps links exits 0');
    const kept = join(state, 'launch-1', 'kept');
    writeFileSync(join(base, 'plan.md'), '# plan, edited\n');
    writeFileSync(join(base, 'notes', 'n.md'), 'n, edited\n');
    ok(!lstatSync(join(kept, 'notes-link')).isSymbolicLink(), 'a kept link to a folder is a folder, not a link');
    eq(readFileSync(join(kept, 'notes-link', 'n.md'), 'utf8'), 'n\n', 'and holds the bytes from before the later edit');
    ok(!lstatSync(join(kept, 'options', 'notes')).isSymbolicLink(), 'a link inside a kept folder is copied as a folder');
    eq(readFileSync(join(kept, 'options', 'notes', 'n.md'), 'utf8'), 'n\n', 'with the bytes from before the later edit');
    if (fileLink) {
      ok(!lstatSync(join(kept, 'plan-link.md')).isSymbolicLink(), 'a kept link to a file is a file, not a link');
      eq(readFileSync(join(kept, 'plan-link.md'), 'utf8'), '# plan\n', 'and holds the bytes from before the later edit');
    }
  }
  {
    const base = tmpDir();
    const state = join(base, 'state');
    mkdirSync(join(base, 'gone'));
    mkdirSync(join(base, 'dangling'));
    symlinkSync(join(base, 'gone'), join(base, 'dangling', 'to-gone'), 'junction');
    rmSync(join(base, 'gone'), { recursive: true });
    mkdirSync(join(base, 'loop'));
    symlinkSync(join(base, 'loop'), join(base, 'loop', 'self'), 'junction');
    for (const [name, what] of [['dangling', 'a link to a missing folder'], ['loop', 'a link to a folder that holds it']]) {
      const r = cli(['reserve', state, '--keep', join(base, name)]);
      eq(r.code, 1, `a kept folder that holds ${what} exits 1`);
      ok(r.stderr.includes('is reserved but incomplete, so reserve another'), `and names the reserved folder: ${r.stderr.trim().slice(0, 140)}`);
      if (name === 'loop') ok(r.stderr.includes('is a link to a folder that holds it'), 'and names the loop as the cause');
    }
  }

  section('each usage error exits 1 and creates no folder');
  {
    const base = tmpDir();
    const state = join(base, 'state');
    writeFileSync(join(base, 'x'), 'x');
    mkdirSync(join(base, 'other'));
    writeFileSync(join(base, 'other', 'x'), 'y');
    const CASES = [
      [[], 'no verb'],
      [['reserve'], 'a missing stateDir'],
      [['make', state], 'an unknown verb'],
      [['reserve', state, '--force'], 'an unknown flag'],
      [['reserve', state, '--keep'], 'a --keep with no path'],
      [['reserve', state, state], 'two stateDirs'],
      [['reserve', 'runs/t-refine'], 'a relative stateDir'],
      [['reserve', state, '--keep', join(base, 'x'), '--keep', join(base, 'other', 'x')], 'two --keep paths with one base name'],
      // Windows and macOS fold case, so the second copy would fail after the folder was reserved.
      [['reserve', state, '--keep', join(base, 'x'), '--keep', join(base, 'other', 'X')], 'two --keep base names that differ only in case', 'case ignored'],
      [['reserve', state, '--keep', base], 'a --keep path that holds the stateDir', 'is the stateDir or a folder that holds it'],
      // A root also holds the stateDir, so only the cause on stderr shows which check refused it.
      [['reserve', state, '--keep', parse(base).root], 'a --keep path with no base name', 'has no base name'],
    ];
    for (const [argv, what, cause = ''] of CASES) {
      const r = cli(argv, TOOL, base);
      eq(r.code, 1, `${what} exits 1`);
      ok(r.stderr.startsWith('launch: ') && r.stderr.includes(cause), `and names the cause on stderr: ${r.stderr.trim().slice(0, 90)}`);
      eq(r.stdout, '', `and prints nothing on stdout for ${what}`);
      ok(!existsSync(state) && !existsSync(join(base, 'runs')), `and creates no folder for ${what}`);
    }
    eq(cli(['reserve', state], TOOL, base).code, 0, 'the same stateDir then reserves');
    ok(existsSync(join(state, 'launch-1')), 'and its first folder is launch-1');
  }
  {
    const base = tmpDir();
    const r = cli(['reserve', join(base, '..cache', 'state'), '--keep', base], TOOL, base);
    eq(r.code, 1, 'a --keep path that holds the stateDir through a child folder named ..cache exits 1');
    ok(r.stderr.includes('is the stateDir or a folder that holds it'), `and names that cause: ${r.stderr.trim().slice(0, 90)}`);
    ok(!existsSync(join(base, '..cache')), 'and creates no folder');
  }
  {
    // A link has another spelling than the folder it names, as a case-folded or 8.3 short name has.
    const base = tmpDir();
    mkdirSync(join(base, 'proj'));
    symlinkSync(join(base, 'proj'), join(base, 'proj-link'), 'junction');
    const state = join(base, 'proj', 'runs', 'state');
    const r = cli(['reserve', state, '--keep', join(base, 'proj-link')], TOOL, base);
    eq(r.code, 1, 'a --keep link to a folder that holds the stateDir exits 1');
    ok(r.stderr.includes('is the stateDir or a folder that holds it'), `and names that cause: ${r.stderr.trim().slice(0, 90)}`);
    ok(!existsSync(join(base, 'proj', 'runs')), 'and creates no folder');
  }

  section('an orphaned plugin copy refuses before it reserves, and an import runs no check');
  {
    const dir = tmpDir();
    mkdirSync(join(dir, 'tools'));
    for (const name of ['launch.mjs', 'plugin-access.mjs']) copyFileSync(join(REPO_ROOT, 'tools', name), join(dir, 'tools', name));
    const script = join(dir, 'tools', 'launch.mjs');
    const state = join(dir, 'state');
    eq(cli(['reserve', state], script).code, 0, 'a copy with no marker reserves as before');
    writeFileSync(join(dir, '.orphaned_at'), '1');
    const r = cli(['reserve', state], script);
    eq(r.code, 1, 'the orphaned copy exits 1');
    ok(r.stderr.startsWith('launch: ') && r.stderr.includes('orphaned plugin copy'), 'and prints the refusal on stderr');
    ok(!existsSync(join(state, 'launch-2')), 'and reserves no folder');
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}
