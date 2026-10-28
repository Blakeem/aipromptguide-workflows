// tools/plan-entry.mjs: the backlog entry writer every develop backlog writer runs.
//
// What matters here is that each entry it appends reads back through plan-block's grammar with the next free id,
// that the files plan-edit.mjs and plan-pull.mjs parse keep their header, and that a refused call writes nothing.
//
// Fixtures live under os.tmpdir(), never under tests/fixtures/, as in plan-edit.test.mjs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { parseBlocks } from '../tools/plan-block.mjs';
import { PLACEHOLDER } from '../tools/plan-edit.mjs';
import { appendEntry, run } from '../tools/plan-entry.mjs';

const CLI = join(REPO_ROOT, 'tools/plan-entry.mjs');
const dirs = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'aipg-plan-entry-')); dirs.push(d); return d; };
const read = (p) => readFileSync(p, 'utf8');
const BASE = ['--block', 'blk-a', '--run', 'Judgment Review', '--file-ref', 'src/a.js:3', '--category', 'correctness', '--size', 'small', '--decision', 'ACTIONABLE'];
const newEntry = (path, extra = []) => run(['new', '--file', path, ...BASE, ...extra]);
const throwsWith = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const entriesOf = (path) => parseBlocks(read(path))[0].issues;

section('new writes the header of a missing file, then appends entries with the next free id');
{
  const path = join(tmpDir(), 'bk-run-blk-a-1234abcd.md');
  const out = newEntry(path, ['--severity', 'low']);
  ok(out.startsWith('bk-run-blk-a-1234abcd-1\n'), `it prints the new id on its first line: ${JSON.stringify(out.split('\n')[0])}`);
  ok(read(path).startsWith('## Plan: bk-run-blk-a-1234abcd - backlog from block blk-a of run Judgment Review\nmode: fix\ngate: green\nstatus: todo\n\n### [bk-run-blk-a-1234abcd-1] '),
    'the header names the block and the run, as the writer hold of plan-edit.mjs args --backlog reads it');
  newEntry(path, ['--branch', 'aipg-unfinished/x', '--origin', 'E:/p/plan.md#blk-a', '--ledger', 'E:/s/gate/DISMISSED-blk-a.md', '--amended', 'E:/s/AMENDED-blk-a.md']);
  const [first, second] = entriesOf(path);
  eq(second.id, 'bk-run-blk-a-1234abcd-2', 'the second entry takes one past the highest n');
  eq(first.keys.map((k) => k.key).join(','), 'id,status,file,severity,category,size,decision', 'the key lines sit in grammar order');
  eq(JSON.stringify(second.values), JSON.stringify({ id: 'bk-run-blk-a-1234abcd-2', status: 'open', file: 'src/a.js:3', category: 'correctness', size: 'small', decision: 'ACTIONABLE',
    branch: 'aipg-unfinished/x', origin: 'E:/p/plan.md#blk-a', ledger: 'E:/s/gate/DISMISSED-blk-a.md', amended: 'E:/s/AMENDED-blk-a.md' }), 'a park entry carries its branch, origin, ledger and amended lines');
  ok(!('severity' in second.values), 'an entry given no --severity holds no severity line');
  ok(read(path).includes(`\n\n### [bk-run-blk-a-1234abcd-2] ${PLACEHOLDER}\n`), 'one blank line separates two entries');
}

section('new numbers past the highest n, keeps the header and sets a skip file to todo');
{
  const path = join(tmpDir(), 'bk-x.md');
  const text = '\uFEFF## Plan: bk-x - backlog from block old of run r0\r\nmode: fix\r\ngate: green\r\nstatus: skip\r\n\r\n### [bk-x-7] t\r\n- id: bk-x-7\r\n- status: fixed\r\n**What:** w\r\n**Fix:** f';
  writeFileSync(path, text);
  newEntry(path);
  const after = read(path);
  ok(after.startsWith('\uFEFF## Plan: bk-x - backlog from block old of run r0\r\n'), 'the BOM and the existing header stay');
  ok(after.includes('status: todo\r\n') && !after.includes('status: skip'), 'a skip file is set to todo');
  ok(after.includes('**Fix:** f\r\n\r\n### [bk-x-8] '), 'an unterminated last line is ended, a blank line follows, and the id is one past 7');
  ok(!after.replace(/\r\n/g, '').includes('\n'), 'the appended text takes the file\'s CRLF line ending');
}

section('a refused call writes nothing and names its cause');
{
  const dir = tmpDir();
  const plan = join(dir, 'plan.md');
  const planText = '## Plan: a\nmode: fix\ngate: green\n\n### [a-1] t\n- id: a-1\n\n## Plan: b\nmode: feature\ngate: green\n\nBody.\n';
  writeFileSync(plan, planText);
  ok(/is not a backlog file/.test(throwsWith(() => newEntry(plan))) && read(plan) === planText, 'a plan file of several blocks is refused and left as it was');
  const path = join(dir, 'bk-y.md');
  ok(/--size takes trivial \| small \| medium \| large/.test(throwsWith(() => run(['new', '--file', path, ...BASE.slice(0, 8), '--size', 'huge', '--decision', 'ACTIONABLE']))), 'a size outside the set is refused');
  ok(/--severity takes critical/.test(throwsWith(() => newEntry(path, ['--severity', 'nit']))), 'a severity outside the grammar is refused');
  ok(/missing --decision/.test(throwsWith(() => run(['new', '--file', path, ...BASE.slice(0, 10)]))), 'a missing required flag is named');
  ok(/one non-blank line/.test(throwsWith(() => newEntry(path, ['--origin', 'a\n- status: fixed']))), 'a multi-line value is refused, so no key line can be smuggled in');
  ok(/usage:/.test(throwsWith(() => newEntry(path, ['--severity', 'low', '--severity', 'low']))), 'a repeated flag is refused');
  ok(/--block takes a block id, a kebab slug/.test(throwsWith(() => run(['new', '--file', path, '--block', 'Block A', ...BASE.slice(2)]))),
    'a block id the WRITER_TITLE pattern of plan-edit.mjs cannot read is refused');
  ok(/ends \.md/.test(throwsWith(() => run(['new', '--file', join(dir, 'bk-y.txt'), ...BASE]))), 'a file that is not .md is refused');
  ok(throwsWith(() => read(path)) !== '', 'no refused call created the file');
  const untrimmed = { file: ' src/a.js:3 ', category: 'correctness', size: 'small', decision: 'ACTIONABLE' };
  ok(/the entry bk-y-1 would not read back from .* \(--file-ref\), so nothing was written/.test(throwsWith(() => appendEntry('', path, { blockId: 'blk-a', runId: 'r1', values: untrimmed }))),
    'a value the parser reads back changed is refused, naming its flag');
}

section('check reports each placeholder and the grammar error, and passes a filled file');
{
  const path = join(tmpDir(), 'bk-z.md');
  newEntry(path);
  const pending = throwsWith(() => run(['check', path]));
  ok(/3 problem\(s\)/.test(pending) && /placeholder on line 6 of entry bk-z-1/.test(pending), `each placeholder is listed by line and entry: ${pending.split('\n')[1]}`);
  writeFileSync(path, read(path).replace(`] ${PLACEHOLDER}`, '] a title').replace(`**What:** ${PLACEHOLDER}`, '**What:** w').replace(`**Fix:** ${PLACEHOLDER}`, '**Fix:** f'));
  eq(run(['check', path]), `ok: ${path}\n`, 'a filled file passes');
  writeFileSync(path, read(path).replace('- size: small', '- effort: small'));
  ok(/grammar: .*renamed to "size"/.test(throwsWith(() => run(['check', path]))), 'a grammar error is reported');
  writeFileSync(path, read(path).replace('- effort: small', '- size: small').replace('**What:** w', `**What:** a check that flags "${PLACEHOLDER}"
    **Fix:** ${PLACEHOLDER}`));
  eq(run(['check', path]), `ok: ${path}
`, 'a placeholder quoted inside a filled field, or on an indented line, is filled text');
}

section('the CLI prints the id on stdout and a refusal on stderr with exit 1');
{
  const path = join(tmpDir(), 'bk-cli.md');
  const out = execFileSync(process.execPath, [CLI, 'new', '--file', path, ...BASE], { encoding: 'utf8' });
  ok(out.startsWith('bk-cli-1\n'), 'exit 0 prints the id first');
  let code = 0;
  let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'check', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; stderr = String(e.stderr); }
  ok(code === 1 && /^plan-entry: .*3 problem\(s\)/.test(stderr), `an unfilled file fails check with exit 1 on stderr (exit ${code})`);
}

for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
