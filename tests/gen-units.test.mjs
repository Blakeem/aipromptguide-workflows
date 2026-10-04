// workflows/debug/gen-units.mjs — ordinary Node, run as a child process (it is NOT a Workflow engine).
// Focus: the numeric CLI bounds. A coerced one does not error, it silently DISABLES the limit it sets.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';

const SCRIPT = join(REPO_ROOT, 'workflows/debug/gen-units.mjs');

// Returns { code, stderr, stdout } — never throws, so a non-zero exit is an assertable value.
const runCli = (argv) => {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...argv], { stdio: 'pipe', encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
};

section('a non-numeric or out-of-range cap exits 1 instead of coercing to NaN');
// NaN fails open on every comparison in this file: `curLoc + it.loc > NaN` is false (no LOC cap),
// `loc(f) > NaN` is false (no big-file split), `!(NaN > 0)` is true (packing silently skipped, exactly
// as if 0 had been passed). The only trace was `null` in the manifest's caps block.
{
  const cases = [
    ['cap-loc', ['--cap-loc', 'abc']],
    ['cap-files', ['--cap-files', 'abc']],
    ['big-file', ['--big-file', 'abc']],
    ['pack-loc', ['--pack-loc', 'abc']],
    ['cap-loc below its minimum', ['--cap-loc', '0']],
    ['pack-loc below its minimum', ['--pack-loc', '-1']],
  ];
  for (const [name, argv] of cases) {
    const r = runCli(argv);
    eq(r.code, 1, `--${name} exits 1`);
    ok(/must be a number >=/.test(r.stderr), `--${name} says what was wrong: ${r.stderr.split('\n')[0]}`);
  }
}

section('a BARE numeric flag is rejected too');
// parseArgs gives a valueless flag the string 'true', which is NaN — the same silent no-op by another
// route, and the one a hurried command line actually produces.
{
  const r = runCli(['--pack-loc', '--repo', REPO_ROOT]);
  eq(r.code, 1, 'exits 1');
  ok(r.stderr.includes('got "true"'), `the bare flag is quoted back: ${r.stderr.split('\n')[0]}`);
}

section('valid caps still reach the manifest, and pack-loc 0 stays legal');
{
  const out = join(tmpdir(), 'aipg-gen-units-test', 'manifest.json');
  try {
    const r = runCli(['--repo', REPO_ROOT, '--src', 'tools', '--ext', '.mjs', '--pack-loc', '0', '--cap-loc', '1500', '--out', out]);
    eq(r.code, 0, `a valid run succeeds: ${r.stderr.split('\n')[0]}`);
    const caps = JSON.parse(readFileSync(out, 'utf8')).caps;
    eq(caps.PACK_LOC, 0, 'pack-loc 0 is kept, not rejected — it disables packing');
    eq(caps.CAP_LOC, 1500, 'an explicit cap is carried through');
    eq(caps.CAP_FILES, 24, 'an absent flag still gets its default');
  } finally {
    rmSync(join(tmpdir(), 'aipg-gen-units-test'), { recursive: true, force: true });
  }
}

section('a dangling link and a link to its own parent dir are skipped, not followed');
// statSync followed links: a dangling one threw ENOENT and a link to an ancestor recursed to ELOOP,
// both crashing the generator before any manifest was written.
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-links-'));
  const src = join(dir, 'src');
  const out = join(dir, 'manifest.json');
  try {
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'a.mjs'), 'export const a = 1;\n');
    writeFileSync(join(src, 'sub', 'b.mjs'), 'export const b = 2;\n');
    const linkedAs = (target, path, type) => {
      try { symlinkSync(target, path, type); return true; } catch (e) {
        if (e.code !== 'EPERM') throw e;
        console.log(`      note: symlinkSync raised EPERM (no symlink privilege), ${path} not created`);
        return false;
      }
    };
    const dangling = linkedAs(join(src, 'missing.mjs'), join(src, 'dangling.mjs'), 'file');
    const loop = linkedAs(src, join(src, 'sub', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    const r = runCli(['--repo', dir, '--src', 'src', '--ext', '.mjs', '--pack-loc', '0', '--out', out]);
    eq(r.code, 0, `the run succeeds (dangling link: ${dangling}, parent-dir link: ${loop}): ${r.stderr.split('\n')[0]}`);
    const files = JSON.parse(readFileSync(out, 'utf8')).units.flatMap((u) => u.files.map((f) => f.path)).sort();
    eq(JSON.stringify(files), JSON.stringify(['src/a.mjs', 'src/sub/b.mjs']), 'the manifest holds only the real files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
