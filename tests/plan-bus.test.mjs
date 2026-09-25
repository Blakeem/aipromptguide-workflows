// The plan bus end to end: the real tools on either side of the real engines, chained through the files
// and run records that connect them. Every other suite feeds one side a hand-built fixture, so a format
// change on one side leaves both green while the handoff between them breaks. Here each side is fed the
// other's real output.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEngine, runTrace, section, ok, eq } from './harness.mjs';
import { listObject, parseBlocks, parseFileKeys, validate } from '../tools/plan-block.mjs';
import { envelopeFaults, findRunRecords, run as planEdit } from '../tools/plan-edit.mjs';
import reviewFlow from '../tools/flows/review.flow.mjs';

const DEVELOP = 'workflows/develop/develop-cycle.mjs';
const REVIEW = 'workflows/debug/review.mjs';

const dirs = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'aipg-plan-bus-')); dirs.push(d); return d; };
const read = (p) => readFileSync(p, 'utf8');

/** plan-edit args under a config dir, as the parsed args object. */
function argsFrom(configDir, ...plans) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return JSON.parse(planEdit(['args', ...plans], () => {}));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

/** Writes a harness run's logs where the runtime writes a record, as the runtime shapes it. */
function writeRecord(configDir, runId, logs, status = 'completed', timestamp = new Date().toISOString()) {
  const runs = join(configDir, 'projects', 'proj', 'session', 'workflows');
  mkdirSync(runs, { recursive: true });
  writeFileSync(join(runs, `${runId}.json`), JSON.stringify({ runId, timestamp, workflowName: 'develop-cycle', status, logs, result: null }));
}

const statuses = (args) => args.plans.map((r) => `${r.id}=${r.status}`).join(',');
const issueStatus = (path, id) => validate(parseBlocks(read(path)), path)
  .flatMap((b) => b.issues).find((e) => e.id === id)?.keys.find((k) => k.key === 'status')?.value;

// ---------------------------------------------------------------------------------------------
// review → a fix-mode plan file
// ---------------------------------------------------------------------------------------------

const VERIFIER_PROMPT = (await runTrace(REVIEW, reviewFlow.scenarios[0])).calls.find((c) => c.label.startsWith('verify')).prompt;

/**
 * The inventory file review's verifier is told to write, filled in the way a verifier fills it. A new
 * placeholder in a metadata line is left unfilled on purpose, so the parse below fails and names it.
 */
function inventoryFromVerifierPrompt(ids) {
  const template = VERIFIER_PROMPT.match(/\n-----\n([\s\S]*?)\n-----\n/)[1];
  const [head, entryAndBody] = template.split(/\n\(for EACH kept verdict[^\n]*\n/);
  const fill = (id) => entryAndBody
    .replaceAll('<finding_id>', id)
    .replace('<title>', `the ${id} defect`)
    .replace('<file>:<line>', 'src/u2.js:42')
    .replace("<that file's LOC from UNIT FILES>", '120')
    .replace('<your confirmed severity>', 'high')
    .replace('<category>', 'correctness')
    .replace('<matrix effort>', 'small')
    .replace('<ACTIONABLE | NEEDS_USER | DEFER>', 'ACTIONABLE')
    .replace('<theme>', 'null-guards');
  return `${head}\n${ids.map(fill).join('\n')}\n`;
}

section('the inventory format review\'s verifier writes is a fix-mode plan file plan-block parses');
{
  const text = inventoryFromVerifierPrompt(['f-1', 'f-2']);
  let blocks = [];
  let err = '';
  try { blocks = validate(parseBlocks(text), 'inventory'); } catch (e) { err = e.message; }
  ok(!err, `it parses: ${err}`);
  const list = blocks.length ? listObject(blocks, 'inventory', parseFileKeys(text)) : { blocks: [] };
  eq(list.blocks.map((b) => `${b.mode}/${b.gate}/${b.status}`).join(','), 'fix/green/todo', 'one fix block, gate green, todo');
  eq(blocks[0]?.issues.map((e) => `${e.id}:${e.keys.find((k) => k.key === 'status')?.value}`).join(','), 'f-1:open,f-2:open',
    'with each entry an issue whose status is open');
  ok(!/^- [a-z_]+: <[^>]*>$/m.test(text), 'and every metadata placeholder was filled, so none is new');
}

// ---------------------------------------------------------------------------------------------
// plan-edit args → develop → the run record → plan-edit args
// ---------------------------------------------------------------------------------------------

const ROADMAP = [
  '## Plan: store - the session store',
  'mode: feature',
  'gate: build-only',
  '',
  'Build the store.',
  '',
  '## Plan: export - the export endpoint',
  'mode: feature',
  'gate: build-only',
  '',
  'Build the endpoint.',
  '',
].join('\n');

const DEV_OK = { baseline_dirty_files: 0, produced: true, build_passed: true, test_outcome: 'passed', tests_run_count: 5, full_suite_outcome: 'passed', unstaged_confirmed: true, needs_user: false, plan_amendments: 0, plan_obtained: true };
const DEV_FIX = { ...DEV_OK, entries_found: 2, results: [{ issue_id: 'f-1', status: 'FIXED' }, { issue_id: 'f-2', status: 'STALE' }] };
const CLEAN = { clean: true, issue_count: 0, contested_dismissals: 0 };
const ACC_PASS = { pass: true, staged: true, reachable: true, regression: false, criteria_total: 2, criteria_met: 2, evidence_recorded: true, gap_count: 0, plan_obtained: true };
const ACC_FAIL = { ...ACC_PASS, pass: false, staged: false, criteria_met: 1, gap_count: 1 };
const ACC_FIX = { pass: true, staged: true, regression: false, gap_count: 0, plan_obtained: true, suite_result: 'green',
  fix_checks: [{ issue_id: 'f-1', actually_fixed: true }, { issue_id: 'f-2', actually_fixed: true }] };
const PARK_OK = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };

const launch = (args, respond) => runEngine(DEVELOP, {
  args: { ...args, runId: 'bus', root: 'E:/state', target: { repo: 'E:/repo' }, gates: { build: 'b', test: 't' }, maxRounds: 1 },
  respond,
});
const RESPOND = {
  'develop inventory': DEV_FIX, develop: DEV_OK, quality: CLEAN,
  'acceptance inventory': ACC_FIX, 'acceptance export': ACC_FAIL, acceptance: ACC_PASS, park: PARK_OK,
};

section('a run\'s statuses reach the plan files through its run record, and a relaunch builds only what is left');
{
  const dir = tmpDir();
  const config = tmpDir();
  const roadmap = join(dir, 'roadmap.md');
  const inventory = join(dir, 'inventory.md');
  writeFileSync(roadmap, ROADMAP);
  writeFileSync(inventory, inventoryFromVerifierPrompt(['f-1', 'f-2']).replace(/## Plan: [^ ]+/, '## Plan: inventory'));

  const first = argsFrom(config, roadmap, inventory);
  eq(statuses(first), 'store=todo,export=todo,inventory=todo', 'the first launch sees every block todo');
  const { out, logs, labels } = await launch(first, RESPOND);
  eq(out.status.startsWith('run complete'), true, `the run ends with a parked block: ${out.status}`);
  ok(labels.includes('develop inventory r1'), 'the fix block from the second file was built in the same run');

  writeRecord(config, 'wf_first', logs);
  const second = argsFrom(config, roadmap, inventory);
  eq(statuses(second), 'store=done,export=parked,inventory=done', 'the next args carries every block status the run decided');
  eq(`${issueStatus(inventory, 'f-1')},${issueStatus(inventory, 'f-2')}`, 'fixed,stale', 'and each issue status, written into the inventory file');

  const relaunch = await launch(second, RESPOND);
  eq(relaunch.out.status, 'nothing to run (no todo blocks)', 'a relaunch builds nothing that landed or parked');

  planEdit(['set', roadmap, 'export', 'status=todo']);
  const third = argsFrom(config, roadmap, inventory);
  eq(statuses(third), 'store=done,export=todo,inventory=done', 'a block flipped back to todo stays todo, since the old run is already applied');
  const retry = await launch(third, { ...RESPOND, 'acceptance export': ACC_PASS });
  ok(retry.labels.filter((l) => l.startsWith('develop')).join() === 'develop export r1', 'and the retry builds only that block');
}

section('a stopped run still reaches the plan: the blocks it finished are applied from its logs');
// The runtime keeps a stopped run's logs but no result. Here the second block's developer dies, so the run
// ends early. That is the same record shape a stop or an API failure leaves, minus the result.
{
  const dir = tmpDir();
  const config = tmpDir();
  const roadmap = join(dir, 'roadmap.md');
  writeFileSync(roadmap, ROADMAP);
  const { logs } = await launch(argsFrom(config, roadmap), { ...RESPOND, 'develop export': null });
  writeRecord(config, 'wf_killed', logs, 'killed');
  eq(statuses(argsFrom(config, roadmap)), 'store=done,export=blocked', 'the finished block is done, and the one that died is blocked');
}

section('runOnly scopes a pilot run to the blocks it names, the way resolve\'s resolveOnly did');
{
  const dir = tmpDir();
  const roadmap = join(dir, 'roadmap.md');
  writeFileSync(roadmap, ROADMAP);
  const { labels } = await launch({ ...argsFrom(tmpDir(), roadmap), runOnly: ['export'] }, { ...RESPOND, 'acceptance export': ACC_PASS });
  eq(labels.filter((l) => l.startsWith('develop')).join(), 'develop export r1', 'only the named block is built');
}

// ---------------------------------------------------------------------------------------------
// The Claude Code side: the records this machine's runtime actually wrote
// ---------------------------------------------------------------------------------------------

section('every recent run record on this machine still has the fields plan-edit args reads');
// The record format is Claude Code's, undocumented, and free to change. The fold fails loudly on a changed
// develop record at launch time, and this check fails on ANY changed record the next time the suite runs
// after a real run, before a develop launch depends on it. A machine with no records skips it.
{
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const newest = findRunRecords(configDir)
    .map((path) => ({ path, text: read(path) }))
    .map(({ path, text }) => ({ path, data: JSON.parse(text) }))
    .sort((a, b) => String(b.data.timestamp).localeCompare(String(a.data.timestamp)))
    .slice(0, 20);
  if (!newest.length) console.log('    - no run records under this config dir, nothing to check');
  for (const { path, data } of newest) {
    const faults = envelopeFaults(data);
    ok(!faults.length, `${data.workflowName ?? path} ${data.runId ?? ''} (${data.status}) has ${faults.length ? `no valid ${faults.join(', ')}: the Claude Code run-record format changed, update tools/plan-edit.mjs` : 'every field'}`);
  }
}

for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
