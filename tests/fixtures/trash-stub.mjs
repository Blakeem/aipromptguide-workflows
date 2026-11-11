// Preloaded into a wt child with `node --import`, so tools/wt.mjs imports this module in place of
// tools/trash.mjs. It acts out trash outcomes the real backends give only under a race, on a volume with no 8.3
// short names, under a process that holds the folder or under permissions that deny the delete.
import { execFileSync } from 'node:child_process';
import { renameSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { TrashError, classifyWindows, trash as realTrash } from '../../tools/trash.mjs';

// The local `trash` below shadows the star export of the same name.
export * from '../../tools/trash.mjs';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './trash.mjs' && context.parentURL?.endsWith('/tools/wt.mjs')) return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

/** Throws the Windows backend's refusal of a fabricated helper report on an item left whole at its path. */
function refuseAsWindows(path, outcome, longestPath) {
  const verdict = classifyWindows({
    target: path, preIno: 1, countBefore: 1, longestPath, outcome: { Success: false, Target: path, ...outcome }, after: { targetIno: 1, targetCount: 1 },
  });
  throw new TrashError(verdict.state, path, verdict.reason, verdict.causeId);
}

const OUTCOMES = {
  // The folder leaves its path before the outcome is lost, so a prune after it would drop the registration.
  unknown(path) {
    renameSync(path, `${path}.partial`);
    throw new TrashError('unknown', path, 'the stub moved the folder aside and reports unknown');
  },
  // The Windows backend's refusal of each measured cause, which a test can reach only on a volume with no 8.3 short
  // names, under a process that holds the folder or under permissions that deny the delete.
  longPath: (path) => refuseAsWindows(path, { Veto: 'a second item or a per-item fallback' }, 286),
  held: (path) => refuseAsWindows(path, { PerformHr: '0x80270027', DeleteHr: '0x80270027' }, 0),
  denied: (path) => refuseAsWindows(path, { PerformHr: '0x80270021', DeleteHr: '0x80270021' }, 0),
  // A success report for a folder that never moved, which `git worktree prune` keeps registered.
  unmoved: (path) => ({ state: 'trashed', target: path, location: `${path}.nowhere`, verified: true }),
  // The folder moves to the trash, then the index of the repo named by AIPG_TRASH_STUB_REPO is emptied, as a user
  // unstaging the work would between close's staging and its branch delete.
  unstage(path) {
    const repo = process.env.AIPG_TRASH_STUB_REPO;
    if (!repo) throw new Error('trash-stub: the unstage outcome needs AIPG_TRASH_STUB_REPO');
    const outcome = realTrash(path);
    execFileSync('git', ['-C', repo, 'reset', '-q']);
    return outcome;
  },
};

export function trash(path) {
  const outcome = OUTCOMES[process.env.AIPG_TRASH_STUB];
  if (!outcome) throw new Error(`trash-stub: AIPG_TRASH_STUB must be one of ${Object.keys(OUTCOMES).join(', ')}`);
  return outcome(path);
}
