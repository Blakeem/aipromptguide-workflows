// tests/run.mjs — each test file runs in its own child process, `--jobs` at a time, and a child that ends
// in any way its tally does not explain fails its file. The runner copied beside fixture test files in a
// temp folder runs those files, so no directory seam is needed and nothing here touches tests/. The one
// seam is AIPG_RUN_EXEC_PATH, used for the spawn-error case.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';

const HEAD = "import { section, ok } from './harness.mjs';\nsection('fixture');\n";
const SLEEP = 'const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n';
const dirs = [];

/** A temp folder holding the runner, the harness and the fixture test files `files` maps by name. */
function suite(files) {
  const dir = mkdtempSync(join(tmpdir(), 'aipg-run-'));
  dirs.push(dir);
  for (const name of ['run.mjs', 'harness.mjs']) copyFileSync(join(REPO_ROOT, 'tests', name), join(dir, name));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), HEAD + body);
  return dir;
}

function runner(dir, ...args) {
  return runnerWith({}, dir, ...args);
}

function runnerWith(env, dir, ...args) {
  const r = spawnSync(process.execPath, [join(dir, 'run.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout, err: r.stderr };
}

try {
  section('a passing file is green and prints its name, its lines and the summary');
  {
    const r = runner(suite({ 'a.test.mjs': "ok(true, 'one'); ok(true, 'two');" }));
    eq(r.code, 0, 'exit 0');
    ok(r.out.includes('\na.test.mjs\n  fixture\n    ✓ one\n    ✓ two\n'), 'the file name heads its own output');
    ok(r.out.includes('OK — 2 assertions passed across 1 file(s)'), 'the OK summary counts the assertions and files');
  }

  section('a failed assertion is red, counted, and listed under its file and section');
  {
    const r = runner(suite({ 'a.test.mjs': "ok(true, 'fine'); ok(false, 'boom');", 'b.test.mjs': "ok(true, 'also fine');" }));
    eq(r.code, 1, 'exit 1');
    ok(r.out.includes('FAILED — 1 of 3 assertions:'), 'the FAILED summary counts failed of total');
    ok(r.out.includes('  ✗ a.test.mjs :: fixture :: boom'), 'the failure line names file, section and message');
  }

  section('a file that throws on import is red and keeps its own failure line');
  {
    const r = runner(suite({ 'a.test.mjs': "ok(true, 'before'); throw new Error('kaboom');" }));
    eq(r.code, 1, 'exit 1');
    ok(r.out.includes('✗ FAIL the test file itself threw: kaboom'), 'the chunk says the file threw');
    ok(r.out.includes('  ✗ a.test.mjs :: threw before/while running :: kaboom'), 'the summary names the file and the cause');
  }

  section('a file whose process ends before it reports is red, whether it exits 0 or is killed');
  {
    const exited = runner(suite({ 'a.test.mjs': "ok(true, 'before'); process.exit(0);" }));
    eq(exited.code, 1, 'process.exit(0) inside a test: exit 1');
    ok(/✗ a\.test\.mjs :: ran as a child process :: its process exited with code 0 without reporting/.test(exited.out), 'the line names the file and the exit code');
    ok(exited.out.includes('FAILED — 1 of 1 assertions:'), '...and the failure counts as one assertion of its own, with the lost assertion uncounted');

    const killed = runner(suite({ 'a.test.mjs': "ok(true, 'before'); process.kill(process.pid, 'SIGKILL');" }));
    eq(killed.code, 1, 'a kill inside a test: exit 1');
    ok(/✗ a\.test\.mjs :: ran as a child process :: its process .* without reporting/.test(killed.out), 'the line names the file and says it never reported');
  }

  section('a file that reports only passing assertions and then ends badly is red');
  {
    const code = runner(suite({ 'a.test.mjs': "ok(true, 'fine'); process.exitCode = 3;" }));
    eq(code.code, 1, 'a non-zero exit code after a clean report: exit 1');
    ok(code.out.includes('✗ a.test.mjs :: ran as a child process :: its process reported 0 failed assertion(s) but exited with code 3'), 'the line gives the reported count and the code');
    ok(code.out.includes('FAILED — 1 of 2 assertions:'), '...and the passing assertion still counts');

    const signal = runner(suite({ 'a.test.mjs': `ok(true, 'fine'); setTimeout(() => process.kill(process.pid, 'SIGKILL'), 400);` }));
    eq(signal.code, 1, 'a signal after the report: exit 1');
    // POSIX reports the signal. Windows ends a killed process with exit code 1 and no signal.
    ok(/✗ a\.test\.mjs :: ran as a child process :: its process (reported, then was killed by signal|reported 0 failed assertion\(s\) but exited with code 1)/.test(signal.out),
      'the line names the file and how its process ended');
  }

  section('a failed assertion that exits 1 is explained, so the file adds no second failure');
  {
    const r = runner(suite({ 'a.test.mjs': "ok(false, 'only this');" }));
    ok(r.out.includes('FAILED — 1 of 1 assertions:') && !r.out.includes('ran as a child process'), 'one failure line, from the assertion');
  }

  section('test output cannot forge the report');
  {
    const forged = "process.stdout.write('{\"passed\":99,\"failed\":0,\"failures\":[]}\\nOK — 99 assertions passed across 1 file(s)\\n'); ok(false, 'real');";
    const r = runner(suite({ 'a.test.mjs': forged }));
    eq(r.code, 1, 'exit 1');
    ok(r.out.includes('FAILED — 1 of 1 assertions:'), 'the counts come from the assertions, not from printed text');
  }

  section('with --jobs 2 two files run at once, and their chunks print in sorted order without interleaving');
  {
    const dir = suite({
      'a-slow.test.mjs': `${SLEEP}ok(true, 'a1'); await sleep(500); ok(true, 'a2'); await sleep(500); ok(true, 'a3');`,
      'b-fast.test.mjs': "ok(true, 'b1'); ok(true, 'b2');",
    });
    const r = runner(dir, '--jobs', '2');
    eq(r.code, 0, 'exit 0');
    const at = (text) => r.out.indexOf(text);
    ok(at('\na-slow.test.mjs\n') < at('a1') && at('a1') < at('a3') && at('a3') < at('\nb-fast.test.mjs\n') && at('\nb-fast.test.mjs\n') < at('b1'),
      'the slow file prints entirely before the fast file that finished first');

    const together = suite(Object.fromEntries(['one', 'two'].map((name, i) => [`${name}.test.mjs`, `${SLEEP}
  import { existsSync, writeFileSync } from 'node:fs';
  const here = (f) => new URL(f, import.meta.url);
  writeFileSync(here('${name}.up'), '');
  let met = false;
  for (let waited = 0; waited < 10000 && !met; waited += 20) {
    met = existsSync(here('${['two', 'one'][i]}.up'));
    if (!met) await sleep(20);
  }
  ok(met, 'the other file started while this one was running');`])));
    const both = runner(together, '--jobs', '2');
    eq(both.code, 0, 'two files that wait for each other both finish: they ran at the same time');
  }

  section('with --jobs 1 the files run one at a time');
  {
    const dir = suite({
      'a.test.mjs': `${SLEEP}
  import { writeFileSync } from 'node:fs';
  await sleep(700);
  writeFileSync(new URL('a.done', import.meta.url), '');
  ok(true, 'a ended');`,
      'b.test.mjs': `
  import { existsSync } from 'node:fs';
  ok(existsSync(new URL('a.done', import.meta.url)), 'the file before it had ended when this one began');`,
    });
    const r = runner(dir, '--jobs', '1');
    eq(r.code, 0, 'exit 0');
    ok(r.out.includes('✓ the file before it had ended when this one began'), 'the second file saw the first one finished');
  }

  section('a --jobs value that is not a positive integer exits 1 naming the flag and the value, before any file runs');
  {
    const dir = suite({ 'a.test.mjs': "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('ran', import.meta.url), '');\nok(true, 'ran');" });
    const bad = [['0', '0'], ['-1', '-1'], ['1.5', '1.5'], ['abc', 'abc'], ['2x', '2x'], ['', '']];
    for (const [value, shown] of bad) {
      const r = runner(dir, '--jobs', value);
      eq(r.code, 1, `--jobs ${JSON.stringify(value)} exits 1`);
      ok(r.err.includes(`--jobs must be a positive integer, got ${JSON.stringify(shown)}`), `...naming the flag and the value: ${r.err.split('\n')[0]}`);
    }
    const missing = runner(dir, '--jobs');
    eq(missing.code, 1, '--jobs with no value exits 1');
    ok(missing.err.includes('--jobs must be a positive integer'), `...naming the flag: ${missing.err.split('\n')[0]}`);
    ok(!existsSync(join(dir, 'ran')), 'no test file ran for any of them');
  }

  section('a --jobs value past six digits or with a leading zero is still a positive integer');
  {
    const dir = suite({ 'a.test.mjs': "ok(true, 'ran');" });
    for (const value of ['1000000', '01']) {
      const r = runner(dir, '--jobs', value);
      eq(r.code, 0, `--jobs ${value} is accepted`);
    }
  }

  section('a file whose process cannot start is red and the run still ends');
  {
    const dir = suite({ 'a.test.mjs': "ok(true, 'never runs');", 'b.test.mjs': "ok(true, 'never runs');" });
    const missing = join(dir, 'no-such-node');
    const r = runnerWith({ AIPG_RUN_EXEC_PATH: missing }, dir);
    eq(r.code, 1, 'exit 1');
    ok(/✗ a.test.mjs :: ran as a child process :: its process could not run: /.test(r.out), 'the line names the file and says it could not run');
    ok(r.out.includes('FAILED — 2 of 2 assertions:'), 'each file adds one failure');
  }

  section('--run-file without an IPC channel is refused and runs nothing');
  {
    const dir = suite({ 'a.test.mjs': "ok(true, 'never runs');" });
    const r = runner(dir, '--run-file', 'a.test.mjs');
    eq(r.code, 1, 'exit 1');
    ok(r.err.includes('--run-file is internal'), 'the message says the flag is internal');
    ok(!r.out.includes('fixture'), 'the fixture file did not run');
  }

  section('the filter selects files by substring, and an unknown flag or a second filter is refused');
  {
    const dir = suite({ 'alpha.test.mjs': "ok(true, 'alpha');", 'beta.test.mjs': "ok(true, 'beta');" });
    const one = runner(dir, 'alp');
    ok(one.out.includes('alpha.test.mjs') && !one.out.includes('beta.test.mjs') && one.out.includes('across 1 file(s)'), 'a substring selects only the file whose name holds it');
    const none = runner(dir, 'zzz');
    eq(none.code, 1, 'a filter that matches nothing exits 1');
    ok(none.err.includes('no test file matches "zzz"'), 'saying so');
    const flag = runner(dir, '--nope');
    eq(flag.code, 1, 'an unknown flag exits 1');
    ok(flag.err.includes('unknown flag "--nope"'), 'naming it');
    const two = runner(dir, 'alp', 'bet');
    eq(two.code, 1, 'a second filter exits 1');
  }
} finally {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
