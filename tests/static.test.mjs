// Static integrity of every engine. These are the checks a compiler would do if this project had one.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, section, ok } from './harness.mjs';

// Every Workflow engine. gen-units.mjs is NOT here — it is ordinary Node (real imports, run directly),
// so it gets a real `node --check` below instead.
export const ENGINES = [
  'workflows/feature/feature-cycle.mjs',
  'workflows/migrate/migrate-cycle.mjs',
  'workflows/debug/review.mjs',
  'workflows/debug/resolve-cycle.mjs',
  'workflows/enhance/enhance-cycle.mjs',
  'workflows/decide/decide-cycle.mjs',
  'workflows/docs/docs-cycle.mjs',
  'workflows/brainstorm/brainstorm-cycle.mjs',
  'workflows/investigate/investigate-cycle.mjs',
];

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

section('gen-units.mjs is ordinary Node');
{
  let err = '';
  try {
    execFileSync(process.execPath, ['--check', join(REPO_ROOT, 'workflows/debug/gen-units.mjs')], { stdio: 'pipe' });
  } catch (e) { err = String(e.stderr || e.message).split('\n')[0]; }
  ok(err === '', `passes node --check${err ? ` — ${err}` : ''}`);
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
