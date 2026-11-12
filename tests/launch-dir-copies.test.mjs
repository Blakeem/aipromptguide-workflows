// Every engine that writes its records in a launch folder holds its own copy of the launchDirOf check, since
// an engine cannot import. A copy that drifts would accept a launchDir that another engine rejects, and a
// launch could then write where an earlier launch did.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, section, ok } from './harness.mjs';

// The first engine's copy is the reference. Each engine that moves its records into a launch folder joins the list.
const ENGINES = [
  'workflows/refine/refine-cycle.mjs',
  'workflows/investigate/investigate-cycle.mjs',
  'workflows/develop/develop-cycle.mjs',
];

/** The launchDirOf function of one engine's source, or null when it lacks one. */
const checkOf = (src) => src.match(/^const launchDirOf = [\s\S]*?\n\};\n/m)?.[0] ?? null;
const sourceOf = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

section('every engine with a launch folder holds the same launchDirOf check, byte for byte');
{
  const reference = checkOf(sourceOf(ENGINES[0]));
  ok(reference !== null, `${ENGINES[0]} holds launchDirOf`);
  for (const rel of ENGINES.slice(1)) ok(checkOf(sourceOf(rel)) === reference, `${rel} holds ${ENGINES[0]}'s launchDirOf`);
  for (const rel of ENGINES) {
    ok(/^const LAUNCH_DIR\s+= launchDirOf\(A\.launchDir, STATE_DIR\);$/m.test(sourceOf(rel)), `${rel} checks args.launchDir against its own STATE_DIR`);
  }
}

section('a copy that differs in one word is caught');
// Proves the comparison above can fail: each mutated copy of the reference source must differ from the reference.
{
  const src = sourceOf(ENGINES[0]);
  const reference = checkOf(src);
  const mutations = [
    src.replace('!/^launch-[1-9]\\d*$/.test', '!/^launch-\\d+$/.test'),
    src.replace('key(dir.slice(0, cut)) !== key(stateDir)', 'dir.slice(0, cut) !== stateDir'),
    src.replace('Missing args.launchDir', 'Missing launchDir'),
  ];
  for (const [i, mutated] of mutations.entries()) {
    ok(mutated !== src, `mutation ${i + 1} changed the source`);
    ok(checkOf(mutated) !== null && checkOf(mutated) !== reference, `a copy with mutation ${i + 1} differs from the reference`);
  }
}
