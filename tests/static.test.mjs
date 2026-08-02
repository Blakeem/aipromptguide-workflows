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

section('no CR — and no other control byte — anywhere in the repo text');
// Two failures of the same shape: a byte no editor renders, changing how a TOOL reads the whole file.
// CR makes the Workflow tool reject the file outright. Any other C0 byte (NUL is the one that shipped,
// twice, as an invisible separator inside a template literal in tests/dead-agent.test.mjs) is the
// binary-detection sentinel for grep/ripgrep/git grep: the file still parses, still diffs as text, still
// passes every other check here, and drops out of every content search silently.
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
  const rel = (p) => p.slice(REPO_ROOT.length + 1).replace(/\\/g, '/');
  const bad = files.filter((p) => readFileSync(p).includes(13)).map(rel);
  ok(bad.length === 0, `${files.length} files scanned${bad.length ? ` — CR in: ${bad.join(', ')}` : ''}`);

  const ctrl = files
    .map((p) => [p, readFileSync(p).findIndex((b) => b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d)])
    .filter(([, at]) => at !== -1)
    .map(([p, at]) => `${rel(p)} (byte ${at})`);
  ok(ctrl.length === 0, `${files.length} files scanned${ctrl.length ? ` — control byte in: ${ctrl.join(', ')}` : ''}`);
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
//
// SCOPED TO EACH SITE'S OWN RECEIVER, which is what makes the rule mean anything. The first version
// matched a field name anywhere in the engine file, so two schemas in one engine that share a property
// name covered for each other: resolve's `pk?.notes` alone made FIX_SCHEMA's `notes` look read, and the
// same collision hid PARK_SCHEMA's `notes` in feature and migrate. Census 2026-08-02: 29 `schema:` sites
// across 9 engines — 25 bind their return to a variable and are checked through it; 4 do not and keep the
// old name-level match, listed in FALLBACK below so the degraded coverage is visible rather than assumed.
{
  // Sites where a top-level field genuinely has no consumer. `reason` is mandatory, and an entry whose
  // field turns out to BE consumed fails below — the cannot-rot rule, mirroring flow-coverage's
  // allowUncovered. Empty today: every offender the sharpened sweep exposed was resolved rather than
  // allowlisted (the three `notes` fields are surfaced in their engines' log lines).
  const ALLOW = [];   // { engine, schema, field, reason }

  // The sites whose return the receiver grammar cannot bind to a variable. Each keeps the OLD file-wide
  // name-level match, so on these four the sweep still cannot tell two same-named fields apart — which is
  // exactly why they are enumerated rather than silently degraded. A `.then` callback parameter is not
  // resolved in v1: a stated choice, not a claim that it cannot be done. Keyed on (engine, schema) rather
  // than a line number so an unrelated edit above the site does not redden the suite; the live line is
  // printed by the assertion.
  const FALLBACK = [
    { engine: 'workflows/decide/decide-cycle.mjs', schema: 'ANALYST_SCHEMA',
      reason: 'inside parallel(LENSES.map((lens) => () => agent(...))) — the return is never named' },
    { engine: 'workflows/docs/docs-cycle.mjs', schema: 'GATHER_SCHEMA',
      reason: 'agent(...).then((g) => ...) — the return reaches a callback parameter, not a variable' },
    { engine: 'workflows/docs/docs-cycle.mjs', schema: 'SCRUB_SCHEMA',
      reason: 'return agent(...).then((s) => ...) — handed straight back out of the pipeline stage' },
    { engine: 'workflows/brainstorm/brainstorm-cycle.mjs', schema: 'GENERATE_SCHEMA',
      reason: 'inside parallel(LENSES.map((lens) => () => agent(...))) — the return is never named' },
  ];

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

  // ---- Receiver grammar -------------------------------------------------------------------------
  // Every site is `agent(<prompt>, roleOpts('<role>', { schema: … }))`, so the variable a return lands in
  // is found by walking LEFT from `schema:` bracket-aware — out through the options brace, out through the
  // `roleOpts(` wrapper, to agent's own paren — and reading what sits in front of it. TWO forms are
  // accepted and both are in use: a declaration (`const fix = await agent(`) and a bare assignment to a
  // variable declared earlier (migrate's `sweep`, investigate's `crit`, each `let … = null` above the call).
  const RX = (n) => n.replace(/\$/g, '\\$');
  const AGENT_CALL = /([^\w$.]|^)(?:await\s+)?agent\s*$/;
  const DECL   = /(?:^|[\s;{}()])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/;
  const ASSIGN = /(?:^|[\s;{}()])([A-Za-z_$][\w$]*)\s*=\s*$/;

  const receiverAt = (masked, at) => {
    let depth = 0;
    for (let i = at - 1; i >= 0; i--) {
      const c = masked[i];
      if (c === ')' || c === ']' || c === '}') { depth++; continue; }
      if (c !== '(' && c !== '[' && c !== '{') continue;
      if (depth > 0) { depth--; continue; }
      if (c !== '(') continue;                                  // an unclosed brace (the options object)
      const before = masked.slice(Math.max(0, i - 200), i);
      if (!AGENT_CALL.test(before)) continue;                   // roleOpts's paren — keep walking outward
      const head = before.replace(AGENT_CALL, '$1');            // '$1' keeps the delimiter the match ate
      const d = DECL.exec(head);
      if (d) return { kind: 'decl', name: d[1] };
      const a = ASSIGN.exec(head);
      if (a) return { kind: 'assign', name: a[1] };
      return { kind: 'none', name: '' };                        // `return agent(`, `(src) => agent(`, …
    }
    return { kind: 'none', name: '' };
  };

  // A name is a usable receiver only if it means ONE thing in the file. `r` was bound five times in
  // review.mjs — the agent return plus four callback parameters — and a scoped scan against a name that
  // means five things proves nothing, so ambiguity is an ERROR a local rename fixes, never a quiet pass.
  // `function`-declaration parameters are deliberately NOT counted: feature and migrate each route the
  // develop return straight into `gateOk(gate, dev)`, whose parameter is also named `dev`, so the reads
  // inside it ARE reads of that receiver — and calling that a collision would strand `tests_run_count`,
  // the one DEVELOP_SCHEMA field only that helper reads. Arrow parameters ARE counted: `.map((r) => …)`
  // is the callback idiom, and it is where every collision measured here came from.
  const bindings = (masked, n) => {
    const decls = [
      new RegExp(`\\b(?:const|let|var)\\s+${RX(n)}\\b`, 'g'),                            // const x = …
      new RegExp(`\\b(?:const|let|var)\\s*\\{[^{}]*\\b${RX(n)}\\b[^{}]*\\}\\s*=`, 'g'),  // const { x } = …
    ];
    let count = decls.reduce((sum, re) => sum + [...masked.matchAll(re)].length, 0);
    for (const m of masked.matchAll(/\(([^()]*)\)\s*=>|(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*=>/g)) {
      if (new RegExp(`\\b${RX(n)}\\b`).test(m[1] ?? m[2] ?? '')) count++;
    }
    return count;
  };

  // Alias: a statement-position `X = <receiver>;` extends the receiver set, transitively. docs-cycle keeps
  // the curator's return in a loop-scoped `const c` and republishes it to the outer `curate`, which is what
  // every later `curate?.field` reads — without this rule all 9 CURATE_SCHEMA fields would read as dead.
  const receiverSet = (masked, seed) => {
    const set = [seed];
    for (let i = 0; i < set.length; i++) {
      const re = new RegExp(`(?:^|[;{}])\\s*([A-Za-z_$][\\w$]*)\\s*=\\s*${RX(set[i])}\\s*;`, 'gm');
      for (const m of masked.matchAll(re)) if (!set.includes(m[1])) set.push(m[1]);
    }
    return set;
  };

  /**
   * Every schema an agent() call is handed, ONE RECORD PER SITE — never a flattened per-engine field set,
   * which is what let two schemas' same-named fields cover for each other.
   * Driven off `schema:` sites rather than `*_SCHEMA` consts on purpose: review.mjs passes
   * `reviewSchema(lens.categories)`, and review.mjs is the engine the motivating `wrote_file` defect lived
   * in — an extractor blind to a function-built schema would miss the very file it exists for.
   * @returns {{sites:Array<{line:number,name:string,recv:string[],recvKind:string,keys:string[]}>,
   *            scan:string, errors:string[]}} `scan` is the masked source with the schema declarations
   *          themselves blanked, i.e. where a CONSUMER must appear.
   */
  const readSchemas = (src) => {
    const masked = maskNonCode(src);
    const out = { sites: [], spans: [], errors: [] };
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
      // Nor is a schema whose receiver is ambiguous: the scoped read below would be attributing `.field`
      // to whichever binding it happened to find. Name the site and stop, exactly as an unreadable one does.
      const r = receiverAt(masked, m.index);
      let recv = [];
      if (r.kind !== 'none') {
        recv = receiverSet(masked, r.name);
        const bad = recv.map((v) => [v, bindings(masked, v)]).filter(([, n]) => n !== 1);
        if (bad.length) {
          out.errors.push(`${line}: schema ${name} — receiver ${bad.map(([v, n]) => `\`${v}\` is bound ${n}× here`).join(', ')}, not exactly once; rename it locally so a scoped read can be attributed`);
          continue;
        }
      }
      out.sites.push({ line, name, recv, recvKind: r.kind, keys: [...keys] });
      out.spans.push([a, b]);
    }
    const scan = masked.split('');
    for (const [a, b] of out.spans) for (let k = a; k < b; k++) if (scan[k] !== '\n') scan[k] = ' ';
    out.scan = scan.join('');
    return out;
  };

  // The two ways this codebase reads a returned field: `x.field` / `x?.field`, and a destructure —
  // SCOPED to the site's own receiver set, so a sibling schema's reader can no longer stand in. The
  // destructure form demands a following `= <receiver>` so an ordinary object literal that merely CONTAINS
  // the name (`{ schema: X, phase: 'Fix', label }`) cannot pass as a read.
  // A bracket read (`x['field']`) is deliberately NOT matched, and could not be: masking blanks string
  // CONTENTS, so `pk['notes']` reaches the scan as `pk[       ]` with the key gone. No engine uses the
  // form; one that did would report the field as unread — a loud false positive, never a silent pass.
  const consumedBy = (scan, recv, f) => {
    const R = `(?:${recv.map(RX).join('|')})`;
    return new RegExp(`\\b${R}\\s*\\??\\s*\\.\\s*${f}\\b|\\{[^{}]*\\b${f}\\b[^{}]*\\}\\s*=\\s*${R}\\b`).test(scan);
  };

  // FALLBACK sites only: the pre-2026-08-02 rule, file-wide and name-level, with no receiver to bind to.
  const consumed = (scan, f) => new RegExp(
    `\\.\\s*${f}\\b|\\{[^{}]*\\b${f}\\b[^{}]*\\}\\s*=(?![=>])`,
  ).test(scan);

  const suppressed = new Map(ALLOW.map((a) => [a, 0]));
  const fellBack = new Map(FALLBACK.map((f) => [f, 0]));
  for (const rel of ENGINES) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    const s = readSchemas(src);
    ok(s.errors.length === 0,
      `${rel} — every schema handed to agent() resolves, receiver and all${s.errors.length ? `: ${s.errors.join(' | ')}`
        : ` (${s.sites.map((x) => `${x.name}→${x.recvKind === 'none' ? 'FALLBACK' : x.recv.join('/')}`).join(', ')})`}`);
    const empty = s.sites.filter((x) => x.keys.length === 0).map((x) => `${x.name}@${x.line}`);
    ok(s.sites.length > 0 && empty.length === 0,
      `${rel} — ${s.sites.length} schema site(s), each with top-level fields${empty.length ? ` — 0 fields at: ${empty.join(', ')} (the sweep would be scanning nothing there)` : ''}`);

    const undeclared = [];
    const unread = [];
    for (const site of s.sites) {
      const fb = FALLBACK.find((f) => f.engine === rel && f.schema === site.name);
      if (site.recvKind === 'none') {
        if (!fb) { undeclared.push(`${site.name}@${site.line}`); continue; }
        fellBack.set(fb, fellBack.get(fb) + 1);
      }
      for (const f of site.keys) {
        const entry = ALLOW.find((a) => a.engine === rel && a.schema === site.name && a.field === f);
        if (entry) { suppressed.set(entry, suppressed.get(entry) + 1); continue; }
        const read = site.recvKind === 'none' ? consumed(s.scan, f) : consumedBy(s.scan, site.recv, f);
        if (!read) unread.push(`${site.name}.${f}`);
      }
    }
    ok(undeclared.length === 0,
      `${rel} — every receiver-less site is declared in FALLBACK${undeclared.length ? ` — undeclared: ${undeclared.join(', ')}. Bind the return to a variable, or add the site to FALLBACK with a reason` : ''}`);
    ok(unread.length === 0,
      `${rel} — no attestation theater${unread.length ? ` — declared but never read THROUGH ITS OWN RECEIVER: ${unread.join(', ')}. Consume each (a guard, or surface it in the log line) or delete it from the schema AND the prompt text demanding it` : ''}`);
  }
  // The function-built schema specifically. `wrote_clean_marker` is reachable ONLY through
  // reviewSchema(categories), so this is what fails if the extractor ever regresses to `*_SCHEMA` consts —
  // silently, since every const-declared schema would still resolve and the sweep would look green. Asserted
  // on the SITE, not on a per-engine union: a union would still pass if some other schema grew that name.
  {
    const s = readSchemas(readFileSync(join(REPO_ROOT, 'workflows/debug/review.mjs'), 'utf8'));
    const site = s.sites.find((x) => x.name === 'reviewSchema');
    ok(!!site && site.keys.includes('wrote_clean_marker'),
      `the extractor reads FUNCTION-BUILT schemas too — review.mjs's reviewSchema(categories) SITE contributed wrote_clean_marker${site ? '' : ' — no reviewSchema site was found at all'}`);
  }
  // Cannot-rot: a FALLBACK entry whose site is gone, or whose return is bound to a variable now, is a
  // permanent excuse for coverage nobody is missing anymore.
  for (const f of FALLBACK) {
    ok(fellBack.get(f) > 0,
      `FALLBACK ${f.engine} ${f.schema} still has no resolvable receiver${fellBack.get(f) ? ` — ${f.reason}` : ' — MATCHES NOTHING (site gone, or its return is named now): delete the entry'}`);
  }
  // Cannot-rot: an allowlisted field that no longer exists, or that IS consumed now, is a hole nobody
  // would notice, so it fails on its own rather than quietly widening the sweep.
  for (const a of ALLOW) {
    const s = readSchemas(readFileSync(join(REPO_ROOT, a.engine), 'utf8'));
    const site = s.sites.find((x) => x.name === a.schema);
    ok(suppressed.get(a) > 0, `allowlisted ${a.engine} ${a.schema}.${a.field} is still declared${suppressed.get(a) ? '' : ' — MATCHES NOTHING: delete the entry'}`);
    ok(!!site && !(site.recvKind === 'none' ? consumed(s.scan, a.field) : consumedBy(s.scan, site.recv, a.field)),
      `allowlisted ${a.engine} ${a.schema}.${a.field} is still unread through its own receiver — ${a.reason}`);
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
