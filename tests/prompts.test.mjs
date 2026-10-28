// tests/snapshots/<name>.prompts.md — every distinct prompt variant each engine sends, kept in git so a
// prompt edit shows in the diff under every role, mode and round it reaches. Regenerate with
// `node tools/gen-prompts.mjs` after changing any prompt text.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { loadSpecs } from '../tools/gen-flows.mjs';
import { collectCalls, renderSnapshot, snapshotPath } from '../tools/gen-prompts.mjs';

section('a prompt repeated per block is one variant once its per-block hash is masked');
{
  const call = (n, hash) => ({ scenario: 's', label: `developer block-${n}`, role: 'developer', schema: 'null',
    prompt: `append to t-block-${n}-${hash}.md` });
  const snapshot = renderSnapshot({ name: 'hash' }, [call(1, 'cc75ebfa'), call(2, '75fb16e3')]);
  eq(snapshot.match(/^## developer · variant /gm)?.length, 1, 'two blocks whose prompts differ only in the hash give one variant');
}

section('every committed prompt snapshot matches what the engine sends today');
for (const spec of await loadSpecs()) {
  let current = null;
  try { current = readFileSync(snapshotPath(spec.name), 'utf8'); } catch { current = null; }
  const fresh = renderSnapshot(spec, await collectCalls(spec));
  ok(current === fresh, `${spec.name}: ${current === null ? 'missing' : current === fresh ? 'fresh' : 'STALE'} — run \`node tools/gen-prompts.mjs ${spec.name}\` and review the diff`);
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
