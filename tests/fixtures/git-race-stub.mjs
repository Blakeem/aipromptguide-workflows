// Preloaded into a wt child with `node --import`, so tools/wt.mjs imports this module in place of
// node:child_process. Around wt's `git branch --no-track` that creates a new branch, it acts out another process
// that won the race to create the same branch, as two concurrent opens or preps of one name do. AIPG_GIT_RACE names
// what that process has done by then. AIPG_GIT_TRANSLATED, when set, acts out a git that translates its refusal of
// the create, which git leaves untranslated when GIT_TEXTDOMAINDIR names no directory.
import { execFileSync as realExecFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:child_process' && context.parentURL?.endsWith('/tools/wt.mjs')) return { url: import.meta.url, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const gitIn = (repo, args) => realExecFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });

// Each race runs before the create, and may return what the other process does once the create has failed.
const RACES = {
  // The other process created the branch and has not yet registered its worktree.
  branch: (repo, branch, start) => { gitIn(repo, ['branch', branch, start]); },
  // The other process created the branch and its worktree, at `<branch with dashes>-racer` beside the repo.
  worktree: (repo, branch, start) => {
    gitIn(repo, ['worktree', 'add', '-q', '-b', branch, resolve(dirname(repo), `${branch.replaceAll('/', '-')}-racer`), start]);
  },
  // The other process holds the branch's ref lock when the create takes it, after the create found the branch new,
  // and then creates the branch.
  locked: (repo, branch, start) => {
    const lock = resolve(repo, gitIn(repo, ['rev-parse', '--git-common-dir']).trim(), 'refs', 'heads', `${branch}.lock`);
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, '');
    return () => {
      rmSync(lock);
      gitIn(repo, ['branch', branch, start]);
    };
  },
};

/** Whether git translates its messages under `env`. With no GIT_TEXTDOMAINDIR, git reads its own translations. */
function translates(env) {
  const dir = env?.GIT_TEXTDOMAINDIR;
  if (dir === undefined) return true;
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

const translate = (stderr) => String(stderr ?? '').replace(/a branch named '(.*)' already exists/, "ein Branch namens '$1' existiert bereits");

export function execFileSync(cmd, args, opts) {
  const race = RACES[process.env.AIPG_GIT_RACE];
  if (!race) throw new Error(`git-race-stub: AIPG_GIT_RACE must be one of ${Object.keys(RACES).join(', ')}`);
  // tools/wt.mjs runs every git call as `git -C <dir> <subcommand> ...`, and its new-branch create is
  // `branch --no-track <branch> <start>`.
  if (!(cmd === 'git' && args[2] === 'branch' && args[3] === '--no-track')) return realExecFileSync(cmd, args, opts);
  const finish = race(args[1], args[4], args[5]);
  try {
    return realExecFileSync(cmd, args, opts);
  } catch (err) {
    if (process.env.AIPG_GIT_TRANSLATED && translates(opts?.env ?? process.env)) err.stderr = translate(err.stderr);
    throw err;
  } finally {
    finish?.();
  }
}
