// tests/snapshots/<name>.prompts.md — every distinct prompt variant each engine sends, kept in git so a
// prompt edit shows in the diff under every role, mode and round it reaches. Regenerate with
// `node tools/gen-prompts.mjs` after changing any prompt text.
import { readFileSync } from 'node:fs';
import { section, ok } from './harness.mjs';
import { loadSpecs } from '../tools/gen-flows.mjs';
import { collectCalls, renderSnapshot, snapshotPath } from '../tools/gen-prompts.mjs';

section('every committed prompt snapshot matches what the engine sends today');
for (const spec of await loadSpecs()) {
  let current = null;
  try { current = readFileSync(snapshotPath(spec.name), 'utf8'); } catch { current = null; }
  const fresh = renderSnapshot(spec, await collectCalls(spec));
  ok(current === fresh, `${spec.name}: ${current === null ? 'missing' : current === fresh ? 'fresh' : 'STALE'} — run \`node tools/gen-prompts.mjs ${spec.name}\` and review the diff`);
}
