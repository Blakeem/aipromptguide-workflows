// workflows/debug/gen-units.mjs — ordinary Node, run as a child process (it is NOT a Workflow engine).
// Focus: the numeric CLI bounds. A coerced one does not error, it silently DISABLES the limit it sets.
import { execFileSync, spawnSync } from 'node:child_process';
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
// `loc(f) > NaN` is false (no big-file split), and packing's `> NaN` never flushes (every unit merges
// into one). The only trace was `null` in the manifest's caps block.
{
  const cases = [
    ['unit-loc', ['--unit-loc', 'abc']],
    ['cap-files', ['--cap-files', 'abc']],
    ['unit-loc below its minimum', ['--unit-loc', '0']],
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
  const r = runCli(['--unit-loc', '--repo', REPO_ROOT]);
  eq(r.code, 1, 'exits 1');
  ok(r.stderr.includes('got "true"'), `the bare flag is quoted back: ${r.stderr.split('\n')[0]}`);
}

section('valid caps reach the manifest, and --no-pack is recorded as PACK false');
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-caps-'));
  const out = join(dir, 'manifest.json');
  try {
    const r = runCli(['--repo', REPO_ROOT, '--src', 'tools', '--ext', '.mjs', '--no-pack', '--unit-loc', '1500', '--out', out]);
    eq(r.code, 0, `a valid run succeeds: ${r.stderr.split('\n')[0]}`);
    const caps = JSON.parse(readFileSync(out, 'utf8')).caps;
    eq(caps.PACK, false, 'a bare --no-pack disables packing');
    eq(caps.UNIT_LOC, 1500, 'an explicit cap is carried through');
    eq(caps.CAP_FILES, 24, 'an absent flag still gets its default');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('the --unit-loc default is 3500, and only a single-file unit past it warns, citing the measured review context');
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-default-'));
  const out = join(dir, 'manifest.json');
  try {
    mkdirSync(join(dir, 'src', 'big'), { recursive: true });
    mkdirSync(join(dir, 'src', 'edge'), { recursive: true });
    writeFileSync(join(dir, 'src', 'big', 'big.mjs'), 'x\n'.repeat(3500) + 'x');
    writeFileSync(join(dir, 'src', 'edge', 'edge.mjs'), 'x\n'.repeat(3499) + 'x');
    // spawnSync keeps a successful run's stderr, where the warning goes.
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--src', 'src', '--ext', '.mjs', '--out', out], { encoding: 'utf8' });
    eq(r.status, 0, `a run with no --unit-loc succeeds: ${r.stderr.split('\n')[0]}`);
    const manifest = JSON.parse(readFileSync(out, 'utf8'));
    eq(manifest.caps.UNIT_LOC, 3500, 'the absent flag gets the 3500-line default');
    eq(manifest.units.map((u) => `${u.id}:${u.loc}`).sort().join(','), 'src/big/big.mjs:3501,src/edge:3500', 'the file over the default is its own unit');
    ok(r.stderr.includes('warning: unit src/big/big.mjs is 3501 LOC, past the 3500-line default that aims at about 200k tokens of review context (measured median: 123k at 2000 lines); split the file'),
      `the unit past the default warns with the measured context: ${r.stderr.trim()}`);
    ok(!r.stderr.includes('src/edge'), 'a unit at the default draws no warning');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    const r = runCli(['--repo', dir, '--src', 'src', '--ext', '.mjs', '--no-pack', '--out', out]);
    eq(r.code, 0, `the run succeeds (dangling link: ${dangling}, parent-dir link: ${loop}): ${r.stderr.split('\n')[0]}`);
    const files = JSON.parse(readFileSync(out, 'utf8')).units.flatMap((u) => u.files.map((f) => f.path)).sort();
    eq(JSON.stringify(files), JSON.stringify(['src/a.mjs', 'src/sub/b.mjs']), 'the manifest holds only the real files');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('a retired or unknown flag exits 1 before any walk, naming the fix');
// parseArgs keeps every flag it sees, so an unread one was ignored: a scripted `--pack-loc 0` left
// packing on and the run reviewed units its operator never asked for.
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-flags-'));
  const valid = ['--repo', REPO_ROOT, '--src', 'tools', '--ext', '.mjs', '--out', join(dir, 'manifest.json')];
  try {
    for (const argv of [['--cap-loc', '2000'], ['--big-file', '2000'], ['--pack-loc', '0']]) {
      const r = runCli([...valid, ...argv]);
      eq(r.code, 1, `${argv.join(' ')} exits 1`);
      ok(r.stderr.includes('--unit-loc'), `${argv[0]} names --unit-loc: ${r.stderr.split('\n')[0]}`);
    }
    const packLoc = runCli([...valid, '--pack-loc', '0']);
    ok(packLoc.stderr.includes('--no-pack'), `--pack-loc also names --no-pack: ${packLoc.stderr.split('\n')[0]}`);
    // An Object.prototype name is unknown too: `__proto__` must not vanish into the inherited setter,
    // and `constructor` must not read as retired through an inherited member.
    for (const flag of ['--bogus', '--__proto__', '--constructor']) {
      const r = runCli([...valid, flag, '1']);
      eq(r.code, 1, `${flag} 1 exits 1`);
      ok(r.stderr.includes(`unknown flag ${flag} (known: `), `${flag} is named with the known flags: ${r.stderr.split('\n')[0]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('--no-pack given a value exits 1');
// parseArgs hands `--no-pack 0` the value '0'. Whichever way it were read, one reading runs a review
// its operator did not ask for.
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-nopack-'));
  try {
    const r = runCli(['--repo', REPO_ROOT, '--src', 'tools', '--ext', '.mjs', '--no-pack', '0', '--out', join(dir, 'manifest.json')]);
    eq(r.code, 1, 'exits 1');
    ok(r.stderr.includes('--no-pack'), `the message names --no-pack: ${r.stderr.split('\n')[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('--unit-loc bounds the big-file split, the directory split and packing');
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-loc-'));
  const src = join(dir, 'src');
  const out = join(dir, 'manifest.json');
  const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  const unitsFor = (argv) => {
    const r = runCli(['--repo', dir, '--src', 'src', '--ext', '.mjs', '--out', out, ...argv]);
    eq(r.code, 0, `${argv.join(' ')} succeeds: ${r.stderr.split('\n')[0]}`);
    return r.code === 0 ? JSON.parse(readFileSync(out, 'utf8')).units : [];
  };
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'big.mjs'), lines(30));
    for (const name of ['a.mjs', 'b.mjs', 'c.mjs']) writeFileSync(join(src, name), lines(7));

    const unpacked = unitsFor(['--unit-loc', '20', '--no-pack']);
    const bigUnit = unpacked.find((u) => u.files.some((f) => f.path === 'src/big.mjs'));
    eq(bigUnit?.fileCount, 1, 'the file over --unit-loc is its own unit');
    const smallUnits = unpacked.filter((u) => u !== bigUnit);
    eq(smallUnits.reduce((s, u) => s + u.fileCount, 0), 3, 'every small file is in a unit');
    ok(smallUnits.length > 1, `the small files split into ${smallUnits.length} chunks`);
    ok(smallUnits.every((u) => u.loc <= 20), `every chunk is at most 20 LOC: ${smallUnits.map((u) => u.loc).join(', ')}`);

    const packed = unitsFor(['--unit-loc', '20']);
    const over = packed.filter((u) => u.loc > 20).map((u) => u.files.map((f) => f.path));
    eq(JSON.stringify(over), JSON.stringify([['src/big.mjs']]), 'next-fit packing leaves no group under a third of 20 LOC here, so only the big file is over 20 LOC');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('a packed group under a directory named like an Object member is numbered like any other');
// The per-prefix counter is keyed by a directory of the target repo. A plain object read `constructor` as
// the inherited Object function and `__proto__` as Object.prototype, so the unit id took that text as its number.
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-names-'));
  const out = join(dir, 'manifest.json');
  const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  try {
    for (const prefix of ['constructor', '__proto__']) {
      for (const sub of ['a', 'b']) {
        mkdirSync(join(dir, prefix, sub), { recursive: true });
        writeFileSync(join(dir, prefix, sub, 'x.mjs'), lines(5));
      }
    }
    const r = runCli(['--repo', dir, '--src', 'constructor,__proto__', '--ext', '.mjs', '--unit-loc', '15', '--out', out]);
    eq(r.code, 0, `the run succeeds: ${r.stderr.split('\n')[0]}`);
    const ids = JSON.parse(readFileSync(out, 'utf8')).units.map((u) => u.id).sort();
    eq(JSON.stringify(ids), JSON.stringify(['__proto__#p1', 'constructor#p1']), 'each prefix gets #p1 for its first packed group');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('packing is next-fit, then a leftover group under a third of --unit-loc joins its smaller neighbor up to 1.15x');
// Next-fit alone left 3400/200/3400 as three units, so one reviewer paid its full context cost for 200 lines.
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-gen-units-small-'));
  const out = join(dir, 'manifest.json');
  const exactly = (n) => 'x\n'.repeat(n - 1) + 'x';
  // spawnSync keeps a successful run's stderr, where a warning goes.
  const run = (sizes, flags = []) => {
    rmSync(join(dir, 'src'), { recursive: true, force: true });
    sizes.forEach((n, i) => {
      mkdirSync(join(dir, 'src', `d${i}`), { recursive: true });
      writeFileSync(join(dir, 'src', `d${i}`, 'f.mjs'), exactly(n));
    });
    const r = spawnSync(process.execPath, [SCRIPT, '--repo', dir, '--src', 'src', '--ext', '.mjs', '--out', out, ...flags], { encoding: 'utf8' });
    eq(r.status, 0, `${sizes.join('/')} succeeds: ${r.stderr.split('\n')[0]}`);
    const units = r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')).units.map((u) => u.files.map((f) => f.path.split('/')[1]).join('+')).sort().join(', ') : '';
    return { units, stderr: r.stderr };
  };
  try {
    const merged = run([3400, 200, 3400]);
    eq(merged.units, 'd0+d1, d2', '3400/200/3400: the 200-line group joins a neighbor, since 3600 stays under 1.15x');
    // The overrun is the merge's own choice, so advising a lower --unit-loc would shrink every unit for nothing.
    eq(merged.stderr.includes('warning:'), false, `the 3600-line merge under the default draws no warning: ${merged.stderr.trim()}`);
    eq(run([3400, 200, 3350]).units, 'd0, d1+d2', '3400/200/3350: it joins the smaller neighbor');
    eq(run([3400, 1100, 3400]).units, 'd0, d1, d2', '3400/1100/3400: no merge, since 4500 passes 1.15x');
    eq(run([3400, 1200, 3400]).units, 'd0, d1, d2', '3400/1200/3400: no merge, since 1200 is not under a third');
    eq(run([3600, 200]).units, 'd0, d1', '3600/200: no merge, since a single file at or over --unit-loc is never a merge target');
    const raised = run([3500, 200, 3500], ['--unit-loc', '3600']);
    eq(raised.units, 'd0+d1, d2', 'under --unit-loc 3600, the 200-line group joins a neighbor');
    ok(raised.stderr.includes('warning: unit src#p1 is 3700 LOC') && raised.stderr.includes('lower --unit-loc'),
      `a merge past the 3500-line aim warns when --unit-loc is set above the aim: ${raised.stderr.trim()}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
