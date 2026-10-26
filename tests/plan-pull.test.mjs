// tools/plan-pull.mjs — the read-only backlog query a proactive round-1 developer runs.
//
// What matters here is that it lists exactly the entries `plan-edit.mjs args --backlog` would build, narrowed to the
// files a block changes, and that it writes nothing: a developer agent holds its allowlist rule.
//
// Fixtures live under os.tmpdir(), never under tests/fixtures/, as in plan-edit.test.mjs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { run } from '../tools/plan-pull.mjs';

const CLI = join(REPO_ROOT, 'tools/plan-pull.mjs');
const dirs = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'aipg-plan-pull-')); dirs.push(d); return d; };
const read = (p) => readFileSync(p, 'utf8');

/** A backlog file named `name`, one fix block with the file's status, and one entry per `entries` item. */
function backlogFile(dir, name, status, entries, title = 'findings') {
  const lines = [`## Plan: ${name} - ${title}`, 'mode: fix', 'gate: green', `status: ${status}`, ''];
  for (const e of entries) {
    lines.push(`### [${e.id}] ${e.id} title`, `- id: ${e.id}`, `- file: ${e.file}`, `- decision: ${e.decision ?? 'ACTIONABLE'}`,
      ...(e.status ? [`- status: ${e.status}`] : []), ...(e.size ? [`- size: ${e.size}`] : []),
      ...(e.branch ? [`- branch: ${e.branch}`] : []), ...(e.pulled ? [`- pulled: ${e.pulled}`] : []), '', 'What.', '');
  }
  const path = join(dir, `${name}.md`);
  writeFileSync(path, lines.join('\n'));
  return path;
}

/** A config dir holding the given develop run records where the runtime puts them. */
function configWith(records) {
  const dir = tmpDir();
  records.forEach((r, i) => {
    const runs = join(dir, 'projects', 'proj', `session-${i}`, 'workflows');
    mkdirSync(runs, { recursive: true });
    writeFileSync(join(runs, `${r.runId}.json`), JSON.stringify(r));
  });
  return dir;
}

/** pullable under a config dir: { entries, notes } on success, { err } on failure. */
function pullable(configDir, ...argv) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const notes = [];
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return { entries: JSON.parse(run(['pullable', ...argv], (l) => notes.push(l))), notes: notes.join('') };
  } catch (e) {
    return { err: e.message, notes: notes.join('') };
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

/** Every file under `dir` with its bytes, so a test can prove nothing was written. */
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).map((name) => [name, read(join(dir, name))]));

section('pullable lists the ready entries in the given files, and leaves out every entry args --backlog would not build');
{
  const backlog = tmpDir();
  const plans = tmpDir();
  backlogFile(backlog, 'ready', 'todo', [
    { id: 'ready-1', file: 'src/a.js:10', status: 'open', size: 'small' },
    { id: 'ready-2', file: 'src/b.js:4' },
    { id: 'ready-3', file: 'src/other.js:1', status: 'open' },
    { id: 'ready-4', file: 'src/a.js:2', decision: 'NEEDS_USER' },
    { id: 'ready-5', file: 'src/a.js:3', status: 'fixed' },
    { id: 'ready-6', file: 'src/a.js:5', branch: 'aipg-unfinished/x' },
    { id: 'ready-7', file: 'src/a.js:6', pulled: 'r0#blk' },
    { id: 'other-name-8', file: 'src/a.js:7' },
  ]);
  backlogFile(backlog, 'reopened', 'done', [{ id: 'reopened-1', file: 'src/a.js:9' }]);
  backlogFile(backlog, 'waiting', 'todo', [{ id: 'waiting-1', file: 'src/a.js:1' }, { id: 'waiting-2', file: 'src/a.js:2', status: 'needs-attention' }]);
  backlogFile(backlog, 'parked', 'backlogged', [{ id: 'parked-1', file: 'src/a.js:1' }]);
  backlogFile(backlog, 'skipped', 'skip', [{ id: 'skipped-1', file: 'src/a.js:1' }]);
  const excluded = backlogFile(backlog, 'in-run', 'todo', [{ id: 'in-run-1', file: 'src/a.js:1' }]);
  // A file whose writer block is still blocked in its plan is held back, as args --backlog holds it.
  const writerPlan = backlogFile(plans, 'writer-plan', 'todo', [{ id: 'w-1', file: 'x.js:1' }]);
  backlogFile(backlog, 'held', 'todo', [{ id: 'held-1', file: 'src/a.js:1' }], 'backlog from block writer-plan of run p1');
  const record = { runId: 'wf_p1', timestamp: '2026-09-25T10:00:00.000Z', workflowName: 'develop-cycle', status: 'completed', args: { runId: 'p1', backlogDir: backlog },
    logs: [`status-sync ${JSON.stringify([{ planPath: writerPlan, id: 'writer-plan', key: 'status', value: 'blocked' }])}`], result: null };
  const before = { backlog: snapshot(backlog), plans: snapshot(plans) };

  const { entries, notes, err } = pullable(configWith([record]), '--backlog', backlog, '--files', 'src/a.js, ./src/b.js', '--exclude', excluded);
  ok(!err, `it succeeds: ${err ?? ''}`);
  eq((entries ?? []).map((e) => e.id).join(','), 'ready-1,ready-2,reopened-1',
    'only open or status-less ACTIONABLE entries of todo or done files in the given files, with no branch or pulled line and an id of the file\'s name, are listed');
  const [first] = entries ?? [];
  eq(JSON.stringify(first), JSON.stringify({ id: 'ready-1', title: 'ready-1 title', planPath: join(backlog, 'ready.md').replace(/\\/g, '/'), file: 'src/a.js:10', size: 'small' }), 'each entry names its title, its file with forward slashes, its file line and its size');
  ok(/in memory only: left out .*held\.md: the block that wrote it, writer-plan \(blocked\)/.test(notes), `a file its unfinished writer holds back is left out with the note args gives, marked as in memory: ${notes.trim()}`);
  eq(JSON.stringify({ backlog: snapshot(backlog), plans: snapshot(plans) }), JSON.stringify(before), 'it writes nothing, not even the fold args would write or the done file\'s reopening');
}

section('pullable fails on a missing flag or file list, and a missing folder lists nothing');
{
  const backlog = tmpDir();
  for (const [why, argv] of [['no --files', ['--backlog', backlog]], ['an empty --files', ['--backlog', backlog, '--files', ' , ']], ['no --backlog', ['--files', 'a.js']],
    ['an unknown flag', ['--backlog', backlog, '--files', 'a.js', '--write', 'x']], ['a flag with no value', ['--backlog', backlog, '--files']], ['a repeated flag', ['--backlog', backlog, '--files', 'a.js', '--files', 'b.js']]]) {
    ok(/usage:/.test(pullable(configWith([]), ...argv).err ?? ''), `${why} is a usage error`);
  }
  ok(/usage:/.test((() => { try { run(['args']); return ''; } catch (e) { return e.message; } })()), 'a verb other than pullable is a usage error, so the file holds no write verb');
  const missing = pullable(configWith([]), '--backlog', join(backlog, 'none'), '--files', 'a.js');
  eq(JSON.stringify(missing.entries), '[]', 'a backlog folder no run has written yet lists nothing');
  ok(/no backlog folder at/.test(missing.notes), 'and the note says so');
}

section('the CLI prints the JSON on stdout and exits 1 with the reason on stderr');
{
  const backlog = tmpDir();
  backlogFile(backlog, 'cli', 'todo', [{ id: 'cli-1', file: 'a.js:1' }]);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configWith([]) };
  const out = execFileSync(process.execPath, [CLI, 'pullable', '--backlog', backlog, '--files', 'a.js'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  eq(JSON.parse(out).map((e) => e.id).join(','), 'cli-1', 'exit 0 prints the entries');
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'pullable'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; stderr = String(e.stderr); }
  ok(code === 1 && /^plan-pull: usage:/.test(stderr), `a usage error exits 1 with the reason on stderr (exit ${code})`);
}

for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
