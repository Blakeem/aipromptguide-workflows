// Preloaded into a wt child with `node --import`, so tools/wt.mjs imports this module in place of
// node:child_process. The git subcommand that AIPG_GIT_OVERFLOW names overflows the output cap, which a
// real tree reaches only with a listing larger than that cap. AIPG_GIT_OVERFLOW_ARG, when set, limits the
// overflow to the calls of that subcommand that pass that argument. AIPG_SHELL_OVERFLOW, when set,
// overflows every command run through a shell, such as a provision, whose cap is more than a test can write.
import { execFileSync as realExecFileSync } from 'node:child_process';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && context.parentURL?.endsWith('/tools/wt.mjs')) return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

export function execFileSync(cmd, args, opts) {
  const subcommand = process.env.AIPG_GIT_OVERFLOW;
  const arg = process.env.AIPG_GIT_OVERFLOW_ARG;
  const shell = Boolean(process.env.AIPG_SHELL_OVERFLOW);
  if (!subcommand && !shell) throw new Error('git-overflow-stub: AIPG_GIT_OVERFLOW must name the git subcommand to overflow, or AIPG_SHELL_OVERFLOW must be set');
  // tools/wt.mjs runs every git call as `git -C <dir> <subcommand> ...`.
  const gitOverflows = cmd === 'git' && args[2] === subcommand && (!arg || args.includes(arg));
  if (gitOverflows || (shell && opts?.shell)) {
    throw Object.assign(new Error(`spawnSync ${cmd} ENOBUFS`), { code: 'ENOBUFS' });
  }
  return realExecFileSync(cmd, args, opts);
}
