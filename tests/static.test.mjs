// Static integrity of every engine. These are the checks a compiler would do if this project had one.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINES, REPO_ROOT, section, ok, throwsWith } from './harness.mjs';

section('every engine parses under the harness contract');
for (const rel of ENGINES) {
  let err = '';
  try {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8').replace('export const meta', 'const meta');
    new Function('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
      'return (async()=>{' + src + '})()');
  } catch (e) { err = e.message; }
  ok(err === '', `${rel}${err ? ` — ${err}` : ''}`);
}

section('meta is a pure literal (the Workflow tool parses it statically)');
for (const rel of ENGINES) {
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  const m = src.match(/export const meta = \{[\s\S]*?\n\};/);
  ok(m !== null, `${rel} has an "export const meta = {...};" block`);
  if (m) ok(!/\$\{/.test(m[0]), `${rel} meta has no template interpolation`);
}

section('the ordinary-Node scripts pass node --check (the harness contract does not apply to them)');
// gen-units.mjs is run by hand as part of debug; plan-block.mjs is run BY AGENTS during feature and
// migrate runs, so its syntax is a run-time dependency of two engines, not just dev machinery.
for (const rel of ['workflows/debug/gen-units.mjs', 'tools/plan-block.mjs', 'tools/gen-flows.mjs']) {
  let err = '';
  try {
    execFileSync(process.execPath, ['--check', join(REPO_ROOT, rel)], { stdio: 'pipe' });
  } catch (e) { err = String(e.stderr || e.message).split('\n')[0]; }
  ok(err === '', `${rel}${err ? ` — ${err}` : ''}`);
}

section('no CR bytes anywhere (a CR makes the Workflow tool reject the file outright)');
{
  const SKIP = new Set(['.git', 'node_modules', 'runs', 'plans']);
  const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(mjs|js|md|json)$/.test(name)) out.push(p);
    }
    return out;
  };
  const files = walk(REPO_ROOT);
  const bad = files.filter((p) => readFileSync(p).includes(13))
    .map((p) => p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'));
  ok(bad.length === 0, `${files.length} files scanned${bad.length ? ` — CR in: ${bad.join(', ')}` : ''}`);
}

section('every engine requires args.root (run-state must never guess its own location)');
for (const rel of ENGINES) {
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  ok(/args\.root is required/.test(src), rel);
}

section('every engine with a round loop REJECTS a garbage bound instead of absorbing it');
// `Math.max(1, 'three')` is NaN and so is `Number('three')`; `round < NaN` is false on the FIRST test, so
// the loop body never runs and the engine hands back a zero-agent run wearing an ordinary terminal state —
// a search/build/decision that never happened, reported as one that ran out of rounds.
// This is BEHAVIOURAL on purpose. It began as a source grep for `Number.isFinite`, which was a false gate:
// the pattern was satisfied by the OTHER numeric arg's validator, so an engine could reintroduce
// `Number(A.maxRounds)` on maxRounds alone and still pass. Grepping for the shape of a fix cannot tell you
// the fix is wired to the arg that matters — only running it can.
// `Number(false)`, `Number('')` and `Number([])` are all 0 and all finite, so each is checked too: those
// are the values that silently disable a floor rather than shorten a loop.
// A superset of every engine's required args, so the numeric guard is the FIRST thing each run can trip
// on. Whatever else is missing throws later and with a different message, which the assertion excludes.
const NUM_ARGS = {
  runId: 'num', root: 'E:/r', target: { repo: 'E:/repo' },
  planPath: 'p.md', criteria: 'c', requirements: 'r', brief: 'b', conventions: 'c',
  lenses: ['alpha', 'beta'], sources: ['s'], scope: ['x'],
  units: [{ id: 'u', files: ['f'] }],
  issues: [{ id: 'i', unit: 'u', file: 'f', decision: 'ACTIONABLE', severity: 'high' }],
  gates: { build: 'b', test: 't' },
};
for (const rel of ENGINES) {
  const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
  if (!/A\.maxRounds/.test(src)) continue;      // brainstorm + review are single-pass; nothing to bound
  // 51 probes the UPPER bound (the cap is 50). Deliberately not a huge number: against an engine that
  // lost its cap, a value like 1e21 does not fail the assertion, it runs the loop until V8 dies — and a
  // heap-exhaustion stack trace is a far worse signal than a red assertion. Verified: this is what the
  // original engines did when the sweep was first run against them.
  for (const bad of ['three', 0, false, [], '', 51]) {
    const msg = await throwsWith(rel, { args: { ...NUM_ARGS, maxRounds: bad } });
    ok(/Invalid numeric arg: args\.maxRounds/.test(msg),
      `${rel} rejects maxRounds ${JSON.stringify(bad)}${/Invalid numeric arg/.test(msg) ? '' : ` — got "${msg.slice(0, 60)}"`}`);
  }
}
