// Preloaded into a wt child with `node --import`, so tools/wt.mjs imports this module in place of
// tools/trash.mjs. It acts out trash outcomes the real backends give only under a race.
import { renameSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { TrashError } from '../../tools/trash.mjs';

// The local `trash` below shadows the star export of the same name.
export * from '../../tools/trash.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './trash.mjs' && context.parentURL?.endsWith('/tools/wt.mjs')) return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const OUTCOMES = {
  // The folder leaves its path before the outcome is lost, so a prune after it would drop the registration.
  unknown(path) {
    renameSync(path, `${path}.partial`);
    throw new TrashError('unknown', path, 'the stub moved the folder aside and reports unknown');
  },
  // A success report for a folder that never moved, which `git worktree prune` keeps registered.
  unmoved: (path) => ({ state: 'trashed', target: path, location: `${path}.nowhere`, verified: true }),
};

export function trash(path) {
  const outcome = OUTCOMES[process.env.AIPG_TRASH_STUB];
  if (!outcome) throw new Error(`trash-stub: AIPG_TRASH_STUB must be one of ${Object.keys(OUTCOMES).join(', ')}`);
  return outcome(path);
}
