// tests/snapshots/<name>.prompts.md — every distinct prompt variant each engine sends, kept in git so a
// prompt edit shows in the diff under every role, mode and round it reaches. Regenerate with
// `node tools/gen-prompts.mjs` after changing any prompt text. Each role's largest prompt also stays within
// its budget in tests/prompt-budgets.json.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { loadSpecs } from '../tools/gen-flows.mjs';
import { BUDGET_PATH, budgetProblems, collectCalls, readBudgets, renderSnapshot, roleSizes, snapshotPath } from '../tools/gen-prompts.mjs';

section('a prompt repeated per block is one variant once its per-block hash is masked');
{
  const call = (n, hash) => ({ scenario: 's', label: `developer block-${n}`, role: 'developer', schema: 'null',
    prompt: `append to t-block-${n}-${hash}.md` });
  const snapshot = renderSnapshot({ name: 'hash' }, [call(1, 'cc75ebfa'), call(2, '75fb16e3')]);
  eq(snapshot.match(/^## developer · variant /gm)?.length, 1, 'two blocks whose prompts differ only in the hash give one variant');
}

section('every committed prompt snapshot matches what the engine sends today');
const specs = await loadSpecs();
const callsBySpec = new Map();
for (const spec of specs) {
  let current = null;
  try { current = readFileSync(snapshotPath(spec.name), 'utf8'); } catch { current = null; }
  callsBySpec.set(spec.name, await collectCalls(spec));
  const fresh = renderSnapshot(spec, callsBySpec.get(spec.name));
  ok(current === fresh, `${spec.name}: ${current === null ? 'missing' : current === fresh ? 'fresh' : 'STALE'} — run \`node tools/gen-prompts.mjs ${spec.name}\` and review the diff`);
}

section('each role\'s largest prompt stays within its budget in tests/prompt-budgets.json');
{
  const budgets = readBudgets();
  for (const spec of specs) {
    const problems = budgetProblems(spec.name, roleSizes(callsBySpec.get(spec.name)), budgets);
    ok(problems.length === 0, `${spec.name}: ${problems.length ? problems.join(' | ') : 'within budget'} — review the growth, then set the budget in ${BUDGET_PATH} to the count \`node tools/gen-prompts.mjs ${spec.name}\` prints`);
  }
  const unknown = Object.keys(budgets).filter((name) => !specs.some((s) => s.name === name));
  eq(unknown.join(), '', 'every budget names a spec that gen-prompts snapshots');
}

section('budgetProblems names a role over its budget, a role with none and a budget no role uses');
{
  const calls = [{ role: 'dev', prompt: 'x'.repeat(10) }, { role: 'dev', prompt: 'x'.repeat(12) }, { role: 'qa', prompt: 'x'.repeat(5) }];
  const sizes = roleSizes(calls);
  eq(JSON.stringify([...sizes]), JSON.stringify([['dev', 12], ['qa', 5]]), 'each role counts its largest prompt');
  eq(budgetProblems('s', sizes, { s: { dev: 12, qa: 5 } }).length, 0, 'a count equal to its budget passes');
  eq(JSON.stringify(budgetProblems('s', sizes, { s: { dev: 11, qa: 5, gone: 3 } })), JSON.stringify(['s dev: 12 chars, over its budget of 11 by 1', 's gone: a budget for a role no scenario of s sends']),
    'a count over its budget and a budget for a role the spec no longer sends are each a problem');
  eq(JSON.stringify(budgetProblems('s', sizes, { s: { dev: '12' } })), JSON.stringify(['s dev: 12 chars and no whole-number budget', 's qa: 5 chars and no whole-number budget']),
    'a role with no budget, or a budget that is no whole number, is a problem');
  eq(budgetProblems('s', sizes, {}).length, 2, 'a spec with no budgets names each role');
  const dir = mkdtempSync(join(tmpdir(), 'aipg-prompt-budgets-'));
  try {
    writeFileSync(join(dir, 'bad.json'), '{ "develop": ');
    let msg = '';
    try { readBudgets(join(dir, 'bad.json')); } catch (e) { msg = e.message; }
    ok(msg.startsWith(`cannot read the prompt budgets at ${join(dir, 'bad.json')}:`), `a budgets file that does not parse fails naming the file, got: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('an engine that throws a SyntaxError before its first call, or that no scenario drives to an agent call, throws instead of yielding an empty snapshot');
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-prompts-broken-'));
  const specFor = (file, body, scenarios) => {
    writeFileSync(join(dir, file), body);
    return { name: 'broken', engine: join(dir, file), scenarios };
  };
  const errorFrom = async (spec) => { try { await collectCalls(spec); return ''; } catch (e) { return e.message; } };
  try {
    const syntax = specFor('syntax.mjs', "export const meta = { name: 'it's broken' };\nawait agent('x', { label: 'role' });\n", [{ name: 'one' }]);
    const loadError = await errorFrom(syntax);
    ok(loadError.includes('syntax.mjs threw a SyntaxError before its first agent call in scenario "one"'), `a syntax error names the engine and the scenario, got: ${loadError}`);

    const runtime = specFor('runtime.mjs', "export const meta = { name: 'runtime' };\nconst parsed = JSON.parse(args.raw);\nawait agent('x', { label: 'role' });\n", [{ name: 'bad json', args: { raw: '{' } }]);
    ok((await errorFrom(runtime)).includes('threw a SyntaxError before its first agent call'), 'a runtime SyntaxError before the first call is reported with the same wording');

    const silent = specFor('silent.mjs', "export const meta = { name: 'silent' };\nreturn { status: 'done' };\n", [{ name: 'one' }, { name: 'two' }]);
    const silentError = await errorFrom(silent);
    ok(silentError.includes('no scenario of broken made an agent call'), `a spec whose scenarios make no call throws, got: ${silentError}`);

    const guard = specFor('guard.mjs', "export const meta = { name: 'guard' };\nif (!args.go) throw new Error('args.go is required');\nawait agent('x', { label: 'role' });\n",
      [{ name: 'no go', args: {} }, { name: 'go', args: { go: true } }]);
    eq((await collectCalls(guard)).length, 1, 'a scenario that throws before its first call by design still lets the other scenarios snapshot');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
