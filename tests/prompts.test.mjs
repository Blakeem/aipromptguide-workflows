// tests/snapshots/<name>.prompts.md — every distinct prompt variant each engine sends, kept in git so a
// prompt edit shows in the diff under every role, mode and round it reaches. Regenerate with
// `node tools/gen-prompts.mjs` after changing any prompt text.
import { readFileSync } from 'node:fs';
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
