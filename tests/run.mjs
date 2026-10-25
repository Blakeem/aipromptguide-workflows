// Test runner. `node tests/run.mjs [filter] [--jobs <n>]` — exit 0 green, 1 red. No dependencies, no config.
// This IS the project's build+test gate: point args.gates.build/test at it when running a workflow
// against this repo.
//
// A child reports its tally over the IPC channel, which test output cannot forge. tests/README.md
// describes the rest of how the runner runs files.
//
// Add a case: edit the matching tests/<engine>.test.mjs (or add a new one — it is picked up
// automatically). See tests/README.md.

import { fork } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { results, setFile } from './harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--run-file';   // internal: the parent forks this file with it, one per test file
const USAGE = 'usage: node tests/run.mjs [filter] [--jobs <n>]';

function fail(message) {
  console.error(`${message}\n${USAGE}`);
  process.exit(1);
}

/** Reads the filter and --jobs off argv. A bad argument exits 1 before any file runs. */
function parseArgs(argv) {
  let filter = '';
  let jobs = null;
  let childFile = '';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--jobs') {
      const value = argv[++i] ?? '';
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) fail(`--jobs must be a positive integer, got ${JSON.stringify(value)}`);
      jobs = Number(value);
    } else if (arg === CHILD_FLAG) {
      childFile = argv[++i] ?? '';
    } else if (arg.startsWith('--')) {
      fail(`unknown flag ${JSON.stringify(arg)}`);
    } else if (filter) {
      fail(`one filter at most, got ${JSON.stringify(filter)} and ${JSON.stringify(arg)}`);
    } else {
      filter = arg;
    }
  }
  return { filter, jobs, childFile };
}

/** Child mode: run one test file in this process, then send its tally to the parent. */
async function runOneFile(file) {
  if (!process.send) fail(`${CHILD_FLAG} is internal: only this runner sets it, over an IPC channel`);
  setFile(file);
  try {
    await import(pathToFileURL(join(HERE, file)).href);
  } catch (e) {
    results.failed++;
    process.exitCode = 1;
    results.failures.push(`${file} :: threw before/while running :: ${e.message}`);
    console.log(`    ✗ FAIL the test file itself threw: ${e.message}`);
  }
  process.send({ passed: results.passed, failed: results.failed, failures: results.failures });
}

const isReport = (m) => Boolean(m) && Number.isSafeInteger(m.passed) && Number.isSafeInteger(m.failed)
  && Array.isArray(m.failures) && m.failures.every((line) => typeof line === 'string');

/** One file's output and tally. Each unexplained way to end adds a failure line that names the file and the cause. */
function tally(file, output, report, spawnError, code, signal) {
  const ended = signal ? `was killed by signal ${signal}` : `exited with code ${code}`;
  const problems = [];
  if (spawnError) problems.push(`its process could not run: ${spawnError.message}`);
  else if (!report) problems.push(`its process ${ended} without reporting its assertions (a crash, a process.exit inside a test, or a kill)`);
  else if (signal) problems.push(`its process reported, then ${ended}`);
  else if (code !== 0 && !(report.failed > 0 && code === 1)) problems.push(`its process reported ${report.failed} failed assertion(s) but ${ended}`);

  const lines = problems.map((p) => `${file} :: ran as a child process :: ${p}`);
  const suffix = problems.map((p) => `    ✗ FAIL ${p}\n`).join('');
  return {
    text: `\n${file}\n${output}${output && !output.endsWith('\n') ? '\n' : ''}${suffix}`,
    passed: report?.passed ?? 0,
    failed: (report?.failed ?? 0) + lines.length,
    failures: [...(report?.failures ?? []), ...lines],
  };
}

/** Runs one test file in a child. Every way the child can end becomes part of the returned tally. */
function runInChild(file) {
  return new Promise((resolve) => {
    // AIPG_RUN_EXEC_PATH is a seam for tests/run.test.mjs: a missing executable reaches the spawn-error path.
    const child = fork(SELF, [CHILD_FLAG, file], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execPath: process.env.AIPG_RUN_EXEC_PATH });
    const chunks = [];
    let report = null;
    let spawnError = null;
    let closed = false;
    let disconnected = false;

    const settle = () => {
      if (!closed || !disconnected) return;
      resolve(tally(file, Buffer.concat(chunks).toString('utf8'), report, spawnError, child.exitCode, child.signalCode));
    };
    // Each stream keeps its own order. Lines across the two streams may interleave out of order.
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('message', (m) => { if (report === null && isReport(m)) report = m; });
    // A process that never started has no exit or IPC close to wait for.
    child.on('error', (e) => {
      spawnError = e;
      if (child.pid === undefined) resolve(tally(file, Buffer.concat(chunks).toString('utf8'), null, e, null, null));
    });
    child.on('disconnect', () => { disconnected = true; settle(); });
    // The IPC channel can outlive the process by a tick, and a message may still be queued on it.
    child.on('close', () => { closed = true; disconnected = disconnected || !child.connected; settle(); });
  });
}

/** Runs every file, `jobs` at a time, and prints each file's chunk once it and every file before it have finished. */
async function runAll(files, jobs) {
  const outcomes = new Array(files.length);
  let started = 0;
  let printed = 0;
  const worker = async () => {
    while (started < files.length) {
      const i = started++;
      outcomes[i] = await runInChild(files[i]);
      for (; printed < files.length && outcomes[printed]; printed++) process.stdout.write(outcomes[printed].text);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  return outcomes;
}

const { filter, jobs: requestedJobs, childFile } = parseArgs(process.argv.slice(2));

if (childFile) {
  await runOneFile(childFile);
} else {
  const files = readdirSync(HERE)
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => !filter || f.includes(filter))
    .sort();

  if (!files.length) {
    console.error(filter ? `no test file matches "${filter}"` : 'no *.test.mjs files found in tests/');
    process.exit(1);
  }

  const outcomes = await runAll(files, Math.min(requestedJobs ?? availableParallelism(), files.length));
  const passed = outcomes.reduce((n, o) => n + o.passed, 0);
  const failed = outcomes.reduce((n, o) => n + o.failed, 0);
  const total = passed + failed;
  console.log(`\n${'-'.repeat(60)}`);
  if (failed) {
    console.log(`FAILED — ${failed} of ${total} assertions:\n`);
    for (const line of outcomes.flatMap((o) => o.failures)) console.log(`  ✗ ${line}`);
    process.exit(1);
  }
  console.log(`OK — ${total} assertions passed across ${files.length} file(s)`);
}
