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
// migrate runs, so its syntax is a run-time dependency of two engines, not just dev machinery. wt.mjs
// is run by the operator around a batch of runs, and a syntax error there strands live worktrees.
for (const rel of ['workflows/debug/gen-units.mjs', 'tools/plan-block.mjs', 'tools/gen-flows.mjs', 'tools/wt.mjs']) {
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

section('no engine sniffs control flow out of a prose status/haltReason string');
// A halt reason is PROSE written for a human, and `status` is usually that same prose handed back to the
// operator. Branch on a substring of either and the routing is silently wrong the day someone adds a new
// reason: `status = haltReason.includes('needs user') ? ... : ...` is the shape that actually shipped, and
// the fix everywhere was an explicit `haltKind` set at each halt site and mapped. `.includes(` on those
// names has zero hits today — this is what keeps it that way, and it covers the near neighbours
// (`startsWith`/`indexOf`/`match`, plus the regex-first `RE.test(x.status)` form) that read identically.
// Source-level on purpose: unlike the numeric-bound sweep below, there is no arg to feed and no terminal
// to observe — the defect is the SPELLING, and every instance of it is visible in the text.
{
  const SNIFF = [
    /(?:haltReason|status)\s*\.\s*(?:includes|startsWith|indexOf|match)\s*\(/g,
    /\.\s*test\s*\(\s*[^)]*(?:haltReason|status)\s*\)/g,
  ];
  // Sites that match the shape but are NOT prose-sniffing. `pattern` is the exact source text of one site
  // and must still suppress a real match — an entry whose site was rewritten or deleted fails below rather
  // than quietly widening the sweep over whatever lands on that line next. Suppression is per SITE, not per
  // line: the pattern text is cut out and the remainder re-scanned, so a genuine sniff appended to an
  // allowlisted line (the likeliest place for the next one) is still caught.
  const ALLOW = [
    {
      engine: 'workflows/feature/feature-cycle.mjs',
      pattern: "typeof r.status === 'string' && r.status.startsWith('parked')",
      reason: 'parked[] reads back the per-plan status LABEL the engine itself assigned — an enum, not free prose',
    },
    {
      engine: 'workflows/migrate/migrate-cycle.mjs',
      pattern: "typeof r.status === 'string' && r.status.startsWith('parked')",
      reason: 'parked[] reads back the per-section status LABEL the engine itself assigned — an enum, not free prose',
    },
  ];

  const suppressed = new Map(ALLOW.map((a) => [a, 0]));
  for (const rel of ENGINES) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const lines = src.split('\n');
    const hitLines = new Set();
    for (const re of SNIFF) {
      for (const m of src.matchAll(re)) hitLines.add(src.slice(0, m.index).split('\n').length);
    }
    const offenders = [];
    for (const n of [...hitLines].sort((a, b) => a - b)) {
      let text = lines[n - 1];
      for (const a of ALLOW) {
        if (a.engine !== rel || !text.includes(a.pattern)) continue;
        text = text.split(a.pattern).join('');
        suppressed.set(a, suppressed.get(a) + 1);
      }
      // A fresh RegExp per test: the SNIFF literals carry /g, and reusing one with .test() carries
      // `lastIndex` across calls and starts the next scan mid-line.
      if (SNIFF.some((re) => new RegExp(re.source).test(text))) offenders.push(`${n}: ${lines[n - 1].trim()}`);
    }
    ok(offenders.length === 0,
      `${rel}${offenders.length ? ` — set an explicit haltKind instead of reading the prose: ${offenders.join(' | ')}` : ''}`);
  }
  // Cannot-rot: a stale entry is a hole in the sweep nobody would notice, so it is a failure on its own.
  for (const a of ALLOW) {
    ok(suppressed.get(a) > 0,
      `allowlisted site still present in ${a.engine}${suppressed.get(a) ? ` — ${a.reason}` : ' — MATCHES NOTHING: delete the entry'}`);
  }
}

section('every engine names the OPERATOR PAYLOAD when args is not valid JSON');
// The Workflow tool hands `args` over verbatim and unvalidated, so a structural typo in a hand-built
// payload (a missing `}` is the proven case) reaches the engine as a string. Unguarded, `JSON.parse`
// dies as a bare `Expected '}'` that reads as a fault in the runtime, and the operator has no pointer
// back to the thing they typed. Behavioural on purpose, and driven off ENGINES: an engine added or
// rewritten without the guard goes red here rather than shipping the cryptic message again.
for (const rel of ENGINES) {
  const msg = await throwsWith(rel, { args: '{broken' });
  ok(msg.startsWith('Invalid args JSON'),
    `${rel} rejects a malformed args string${msg.startsWith('Invalid args JSON') ? '' : ` — got "${msg.slice(0, 60)}"`}`);
  ok(/verbatim and unvalidated/.test(msg) && /validate the JSON locally/.test(msg),
    `${rel} says whose payload it is and what to do about it`);
}
// The healthy path is untouched: a VALID JSON string still parses and falls through to the engine's own
// arg validation. Without this the guard could "pass" by rejecting every string it is handed.
for (const rel of ENGINES) {
  const msg = await throwsWith(rel, { args: '{"runId":"json"}' });
  ok(msg !== '' && !msg.startsWith('Invalid args JSON'),
    `${rel} parses a valid args string and reaches its own validation — got "${msg.slice(0, 60)}"`);
}

section('every TOP-LEVEL schema field an engine declares is CONSUMED by that same engine');
// ATTESTATION THEATER — a schema property the prompt demands and the harness never reads. It has shipped
// twice: `unstaged_confirmed` was `required`, instructed in bold, and read nowhere for months; `wrote_file`
// sat unread in review.mjs until 2026-08-01. Both look like enforcement and enforce nothing.
//
// TOP-LEVEL ONLY, and that scoping is load-bearing rather than a convenience. A nested item field is
// legitimately consumed by returning or routing its CONTAINER wholesale — REFINE_SCHEMA's gap
// title/evidence/suggestion go into a file the engine never opens, review.mjs's per-finding fields are
// copied through `item.f`. Measured 2026-08-01: an all-depth rule flags 36 fields of which 33 are false
// positives; the top-level rule flags exactly 3, and all 3 were real.
//
// Source-level on purpose, and it does NOT contradict the run-it-don't-grep rule the numeric sweep
// learned (below). That rule bites when you grep for the SHAPE OF A FIX and cannot tell it is wired to the
// thing it guards. Here the fix IS the wiring: the property name is the whole contract between prompt and
// harness, every reference to it is a literal occurrence of that name, and no run can observe a field the
// engine never reads.
{
  // Sites where a top-level field genuinely has no consumer. `reason` is mandatory, and an entry whose
  // field turns out to BE consumed fails below — the cannot-rot rule, mirroring flow-coverage's
  // allowUncovered. Empty today: all three known offenders were resolved rather than allowlisted.
  const ALLOW = [];   // { engine, field, reason }

  // ---- Code vs. prose -------------------------------------------------------------------------
  // Every scan below runs on the source with string literals, comments and regex bodies blanked (length
  // preserved, so indices still line up). Two reasons, and each is a defect the raw text would produce:
  // docs-cycle's curate prompt contains the words "Return via the schema: wrote_index, files," — read as
  // code that is a schema declaration made of prose — and a prompt that merely NAMES a field ("report it
  // as baseline_dirty_files") is exactly the theater being hunted, never proof of a consumer. Template
  // INTERPOLATIONS stay code: `${pk.patch_bytes}` in a log line is a real read.
  const maskNonCode = (src) => {
    const out = src.split('');
    const stack = [];
    const blank = (a, b) => { for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '; };
    const prevSig = (at) => { let k = at - 1; while (k >= 0 && /\s/.test(src[k])) k--; return k >= 0 ? src[k] : ''; };
    let i = 0;
    while (i < src.length) {
      const top = stack[stack.length - 1];
      const ch = src[i];
      if (top === 'line') { if (ch === '\n') stack.pop(); else out[i] = ' '; i++; continue; }
      if (top === 'block') { if (ch === '*' && src[i + 1] === '/') { blank(i, i + 2); stack.pop(); i += 2; continue; } if (ch !== '\n') out[i] = ' '; i++; continue; }
      if (top === "'" || top === '"' || top === '`' || top === 'regex' || top === 'class') {
        if (ch === '\\') { blank(i, i + 2); i += 2; continue; }                                  // escape: consume the pair
        if (top === '`' && ch === '$' && src[i + 1] === '{') { stack.push('code'); blank(i, i + 2); i += 2; continue; }
        if (top === 'regex' && ch === '[') { stack.push('class'); out[i] = ' '; i++; continue; }  // a / inside [...] is literal
        const closer = top === 'regex' ? '/' : top === 'class' ? ']' : top;
        if (ch === closer) { stack.pop(); out[i] = ' '; i++; continue; }
        if (ch !== '\n') out[i] = ' ';
        i++; continue;
      }
      if (ch === '/' && src[i + 1] === '/') { stack.push('line'); blank(i, i + 2); i += 2; continue; }
      if (ch === '/' && src[i + 1] === '*') { stack.push('block'); blank(i, i + 2); i += 2; continue; }
      // Regex-vs-division: a `/` opens a literal only where a value cannot already have ended. Without
      // this, `.replace(/\\/g, '/')` leaves an unbalanced quote and the rest of the file reads as string.
      if (ch === '/' && !/[\w)\]$]/.test(prevSig(i))) { stack.push('regex'); out[i] = ' '; i++; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); out[i] = ' '; i++; continue; }
      if (ch === '}' && top === 'code') { stack.pop(); out[i] = ' '; i++; continue; }             // closes a ${…}
      i++;
    }
    return out.join('');
  };

  const endOfStatement = (masked, from) => {
    let depth = 0;
    for (let i = from; i < masked.length; i++) {
      const c = masked[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ';' && depth === 0) return i;
    }
    return -1;
  };

  // Evaluate a schema expression with every free identifier bound to `unknown`. `with` + a has-trap that
  // declines real globals is what lets FIND_SCHEMA (`enum: CATEGORIES`, derived from args) and
  // DECIDE_SCHEMA (`...(RANKED ? … : {})`, derived from args) evaluate at all outside a run.
  const evalSchema = (expr, unknown) => {
    const scope = new Proxy({}, { has: (t, k) => typeof k === 'string' && !(k in globalThis), get: () => unknown });
    let v = new Function('__s', 'with (__s) { return (' + expr + '); }')(scope);
    if (typeof v === 'function') v = v();     // review.mjs builds its reviewer schema from the unit's lens
    return v;
  };

  /**
   * Every schema an agent() call is handed, resolved to its top-level property names.
   * Driven off `schema:` sites rather than `*_SCHEMA` consts on purpose: review.mjs passes
   * `reviewSchema(lens.categories)`, and review.mjs is the engine the motivating `wrote_file` defect lived
   * in — an extractor blind to a function-built schema would miss the very file it exists for.
   * @returns {{names:string[], fields:Set<string>, scan:string, errors:string[]}} `scan` is the masked
   *          source with the schema declarations themselves blanked, i.e. where a CONSUMER must appear.
   */
  const readSchemas = (src) => {
    const masked = maskNonCode(src);
    const out = { names: [], fields: new Set(), spans: [], errors: [] };
    for (const m of masked.matchAll(/\bschema\s*:\s*/g)) {
      const at = m.index + m[0].length;
      const line = src.slice(0, m.index).split('\n').length;
      const id = /^[A-Za-z_$][\w$]*/.exec(masked.slice(at, at + 64));
      let name = '', a = -1, b = -1;
      if (id) {
        name = id[0];
        const d = new RegExp(`(?:^|\\n)\\s*const\\s+${name}\\s*=\\s*`).exec(masked);
        if (!d) { out.errors.push(`${line}: schema ${name} has no \`const ${name} =\` declaration to resolve`); continue; }
        a = d.index + d[0].length;
        b = endOfStatement(masked, a);
      } else if (masked[at] === '{') {          // an object literal written at the call site
        name = `(inline @${line})`;
        a = at;
        b = endOfStatement(masked, a) + 1;
      } else { out.errors.push(`${line}: unreadable schema expression`); continue; }
      if (b <= a) { out.errors.push(`${line}: schema ${name} never closes`); continue; }
      const expr = src.slice(a, b);
      // Both truth values of every unknown, UNIONED: a property spread in conditionally
      // (`...(RANKED ? { shortlist } : {})`) exists on exactly one branch, and taking only the falsy pass
      // would silently drop it from the sweep — a hole precisely where a field is easiest to forget.
      const keys = new Set();
      let evaluated = false;
      for (const unknown of [undefined, true]) {
        let v;
        try { v = evalSchema(expr, unknown); } catch { continue; }
        if (!v || typeof v.properties !== 'object' || v.properties === null) continue;
        evaluated = true;
        for (const k of Object.keys(v.properties)) keys.add(k);
      }
      // A schema the extractor cannot read is NOT a pass — it is the sweep going blind on that agent.
      if (!evaluated) { out.errors.push(`${line}: schema ${name} did not evaluate to an object with \`properties\``); continue; }
      if (!out.names.includes(name)) out.names.push(name);
      out.spans.push([a, b]);
      for (const k of keys) out.fields.add(k);
    }
    const scan = masked.split('');
    for (const [a, b] of out.spans) for (let k = a; k < b; k++) if (scan[k] !== '\n') scan[k] = ' ';
    out.scan = scan.join('');
    return out;
  };

  // The three ways this codebase reads a returned field: `x.field`, `x['field']`, and a destructure.
  // The destructure form demands a following `=` so an ordinary object literal that merely CONTAINS the
  // name (`{ schema: X, phase: 'Fix', label }`) cannot pass as a read.
  const consumed = (scan, f) => new RegExp(
    `\\.\\s*${f}\\b|\\[\\s*['"]${f}['"]\\s*\\]|\\{[^{}]*\\b${f}\\b[^{}]*\\}\\s*=(?![=>])`,
  ).test(scan);

  const suppressed = new Map(ALLOW.map((a) => [a, 0]));
  for (const rel of ENGINES) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const s = readSchemas(src);
    ok(s.errors.length === 0, `${rel} — every schema handed to agent() resolves${s.errors.length ? `: ${s.errors.join(' | ')}` : ` (${s.names.length}: ${s.names.join(', ')})`}`);
    ok(s.fields.size > 0, `${rel} — the extractor found ${s.fields.size} top-level field(s) (0 would mean the sweep is scanning nothing)`);
    const unread = [];
    for (const f of s.fields) {
      const entry = ALLOW.find((a) => a.engine === rel && a.field === f);
      if (entry) { suppressed.set(entry, suppressed.get(entry) + 1); continue; }
      if (!consumed(s.scan, f)) unread.push(f);
    }
    ok(unread.length === 0,
      `${rel} — no attestation theater${unread.length ? ` — declared but never read: ${unread.join(', ')}. Consume each (a guard, or surface it in the log line) or delete it from the schema AND the prompt text demanding it` : ''}`);
  }
  // The function-built schema specifically. `wrote_clean_marker` is reachable ONLY through
  // reviewSchema(categories), so this is what fails if the extractor ever regresses to `*_SCHEMA` consts —
  // silently, since every const-declared schema would still resolve and the sweep would look green.
  {
    const s = readSchemas(readFileSync(join(REPO_ROOT, 'workflows/debug/review.mjs'), 'utf8'));
    ok(s.fields.has('wrote_clean_marker'),
      'the extractor reads FUNCTION-BUILT schemas too — review.mjs\'s reviewSchema(categories) contributed its fields');
  }
  // Cannot-rot: an allowlisted field that no longer exists, or that IS consumed now, is a hole nobody
  // would notice, so it fails on its own rather than quietly widening the sweep.
  for (const a of ALLOW) {
    const src = readFileSync(join(REPO_ROOT, a.engine), 'utf8');
    ok(suppressed.get(a) > 0, `allowlisted ${a.engine}:${a.field} is still declared${suppressed.get(a) ? '' : ' — MATCHES NOTHING: delete the entry'}`);
    ok(!consumed(readSchemas(src).scan, a.field), `allowlisted ${a.engine}:${a.field} is still unread — ${a.reason}`);
  }
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
