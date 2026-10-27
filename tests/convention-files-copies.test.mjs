// debug's review.mjs and refine-cycle.mjs each hold a copy of conventionFilesOf, since an engine cannot
// import. A copy that drifts would accept or resolve a conventionFiles path that the other engine rejects.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, section, ok } from './harness.mjs';

const REFERENCE = 'workflows/debug/review.mjs';
const COPIES = ['workflows/refine/refine-cycle.mjs'];

/** The conventionFilesOf function of one engine's source, or null when it lacks one. */
const helperOf = (src) => src.match(/^const conventionFilesOf = [\s\S]*?\n\};\n/m)?.[0] ?? null;
const sourceOf = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

section('every copy of conventionFilesOf matches debug\'s, byte for byte');
{
  const reference = helperOf(sourceOf(REFERENCE));
  ok(reference !== null, `${REFERENCE} holds conventionFilesOf`);
  for (const rel of COPIES) ok(helperOf(sourceOf(rel)) === reference, `${rel} holds ${REFERENCE}'s conventionFilesOf`);
}

section('a copy that differs in one word is caught');
// Proves the comparison above can fail.
{
  const src = sourceOf(REFERENCE);
  const mutated = src.replace('each absolute or relative to target.repo', 'each absolute');
  ok(mutated !== src, 'the mutation changed the source');
  ok(helperOf(mutated) !== helperOf(src), 'a copy with a changed message differs from the reference');
}
