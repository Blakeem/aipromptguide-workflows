#!/usr/bin/env node
// Renders each generated FLOW.md through REAL Mermaid in headless Chrome, then measures the result and
// reports labels that overlap. Plain Node, run directly (the gen-units.mjs precedent) — and, like the
// rest of this repo, ZERO npm dependencies: it drives the browser already on the machine with
// `--dump-dom`, so there is no puppeteer, no playwright, no driver library.
//
// WHY THIS EXISTS. gen-flows.mjs can guarantee a diagram is CORRECT — every node, edge and terminal is
// traced from a real run — but it cannot tell whether the picture is READABLE. Mermaid does no collision
// avoidance on edge labels: two long ones leaving the same node render on top of each other and neither
// can be read. That is invisible to every text assertion, so it was being caught by a human squinting at
// screenshots and reporting back. This closes that loop: the browser lays the diagram out for real and
// hands back the bounding boxes, so an overlap is a measurement rather than an opinion.
//
// Usage:
//   node tools/render-flows.mjs                 # measure every map, report overlaps, exit 1 if any
//   node tools/render-flows.mjs investigate     # just one
//   node tools/render-flows.mjs --png           # ALSO write PNGs to tools/.cache/render/
//   node tools/render-flows.mjs --json          # raw measurements
//
// Chrome is located via $CHROME, else the usual install paths. Mermaid itself is downloaded ONCE to
// tools/.cache/ (gitignored) and reused offline afterwards; only that download touches the network —
// the diagrams are never sent anywhere, they are rendered locally.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const CACHE = join(HERE, '.cache');
// PINNED on purpose. `mermaid@11` was a FLOATING tag: the cached build silently moved to 11.16.0, whose
// self-loop layout change (one SVG path through two dummy nodes, label width never fed into layout) made
// two maps' labels unreadable. The gate's verdict changed because a CDN moved, not because the maps did —
// and a gate anchored to a floating tag is not reproducible, which is the byte-stability rule applied to
// the measuring instrument rather than the artifact. The cache is keyed by version, so bumping this line
// re-downloads instead of silently measuring against the old build.
// Pinned to the NEWEST version measured, so a map that passes here also passes on older renderers.
// GitHub renders the committed files and was last observed serving 11.4.1 (community/discussions/70672,
// Apr 2025); bump this when GitHub moves, and re-run to see what its readers will actually see.
const MERMAID_VERSION = '11.16.0';
const MERMAID = join(CACHE, `mermaid-${MERMAID_VERSION}.min.js`);
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
const OUT = join(CACHE, 'render');

const argv = process.argv.slice(2);
const WANT_PNG = argv.includes('--png');
const WANT_JSON = argv.includes('--json');
const names = argv.filter((a) => !a.startsWith('--'));

// A few pixels of contact is just anti-aliasing; a real collision buries text.
const OVERLAP_MIN_PX = 4;

// ---------------------------------------------------------------------------------------------
// Inputs: Chrome, Mermaid, and the committed maps
// ---------------------------------------------------------------------------------------------
function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    console.error('No Chrome/Edge found. Set $CHROME to a browser executable.');
    process.exit(1);
  }
  return hit;
}

async function mermaidSource() {
  if (existsSync(MERMAID)) return readFileSync(MERMAID, 'utf8');
  mkdirSync(CACHE, { recursive: true });
  process.stderr.write(`fetching mermaid once → ${MERMAID}\n`);
  const res = await fetch(MERMAID_URL);
  if (!res.ok) throw new Error(`could not download mermaid (${res.status}). Place it at ${MERMAID} by hand.`);
  const js = await res.text();
  writeFileSync(MERMAID, js);
  return js;
}

/** Every committed FLOW.md, with its fenced mermaid block extracted. */
function collectMaps() {
  const maps = [];
  const wf = join(REPO, 'workflows');
  for (const dir of readdirSync(wf)) {
    for (const file of readdirSync(join(wf, dir)).filter((f) => /^FLOW.*\.md$/.test(f))) {
      const path = join(wf, dir, file);
      const m = readFileSync(path, 'utf8').match(/```mermaid\n([\s\S]*?)```/);
      if (!m) continue;
      const id = file === 'FLOW.md' ? dir : `${dir}/${file.replace(/^FLOW-|\.md$/g, '')}`;
      maps.push({ id, rel: `workflows/${dir}/${file}`, code: m[1] });
    }
  }
  return maps.filter((x) => !names.length || names.some((n) => x.id.includes(n)));
}

// ---------------------------------------------------------------------------------------------
// The page: render with real Mermaid, then measure every label box and report the overlaps.
// ---------------------------------------------------------------------------------------------
const page = (mermaidJs, code) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #0b1020; }
  #out svg { max-width: none !important; height: auto; }
</style></head>
<body>
<div id="out"></div>
<div id="report" data-json=""></div>
<script>${mermaidJs}</script>
<script>
(async () => {
  const report = { ok: false, error: '', width: 0, height: 0, labels: 0, overlaps: [] };
  try {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });
    const { svg } = await mermaid.render('graph', ${JSON.stringify(code)});
    document.getElementById('out').innerHTML = svg;
    await new Promise((r) => setTimeout(r, 100));

    // Force NATURAL size. Mermaid ships the svg at width:100% with a max-width, so in a narrow window it
    // scales down and every distance shrinks with it — measuring that would report overlaps the reader
    // never sees (or hide ones they do). Pin width/height to the viewBox and measure the real geometry.
    const el = document.querySelector('#out svg');
    const vb = el.viewBox.baseVal;
    el.removeAttribute('style');
    el.setAttribute('width', vb.width);
    el.setAttribute('height', vb.height);
    await new Promise((r) => setTimeout(r, 100));
    report.width = Math.round(vb.width);
    report.height = Math.round(vb.height);

    // Edge labels are what collide; node boxes are included so a label parked ON a node is caught too.
    // An edgeLabel NESTS inside another edgeLabel in Mermaid 11, so keep only the innermost — otherwise
    // every label "overlaps" its own wrapper and the report is nothing but false positives.
    const innermost = (list) => list.filter((n) => !list.some((o) => o !== n && n.contains(o)));
    const take = (sel, kind) => innermost([...document.querySelectorAll(sel)])
      .map((n) => ({ kind, text: (n.textContent || '').replace(/\\s+/g, ' ').trim(), r: n.getBoundingClientRect() }))
      .filter((x) => x.text && x.r.width > 1 && x.r.height > 1);
    const labels = take('#out .edgeLabel', 'edge');
    const nodes = take('#out .node .nodeLabel, #out .node .label', 'node');
    report.labels = labels.length;

    const overlap = (a, b) => {
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      return (w > ${OVERLAP_MIN_PX} && h > ${OVERLAP_MIN_PX}) ? { w: Math.round(w), h: Math.round(h) } : null;
    };

    // edge-vs-edge (the reported failure), then edge-vs-node.
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const o = overlap(labels[i], labels[j]);
        if (o) report.overlaps.push({ kind: 'edge/edge', a: labels[i].text, b: labels[j].text, ...o });
      }
      for (const n of nodes) {
        const o = overlap(labels[i], n);
        if (o) report.overlaps.push({ kind: 'edge/node', a: labels[i].text, b: n.text, ...o });
      }
    }
    report.ok = true;
  } catch (e) {
    report.error = String((e && e.message) || e);
  }
  // base64 so the JSON survives --dump-dom's HTML escaping intact.
  document.getElementById('report').setAttribute(
    'data-json', btoa(unescape(encodeURIComponent(JSON.stringify(report)))));
})();
</script>
</body></html>`;

// ---------------------------------------------------------------------------------------------
// Process: drive Chrome once per map (measure), and once more per map when PNGs were asked for.
// ---------------------------------------------------------------------------------------------
const CHROME = findChrome();
const chrome = (args) => execFileSync(CHROME, [
  '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=1',
  ...args,
], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

function measure(map, html) {
  const file = join(CACHE, `page-${map.id.replace(/[^a-z0-9]+/gi, '-')}.html`);
  writeFileSync(file, html);
  // A wide window so the diagram lays out at natural size instead of reflowing against a narrow body.
  const dom = chrome(['--window-size=4000,4000', '--virtual-time-budget=20000', '--dump-dom', pathToFileURL(file).href]);
  const m = dom.match(/data-json="([A-Za-z0-9+/=]*)"/);
  if (!m || !m[1]) return { ok: false, error: 'the page produced no report (Mermaid never finished)', overlaps: [] };
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

const mermaidJs = await mermaidSource();
const maps = collectMaps();
if (!maps.length) {
  console.error(names.length ? `no FLOW map matches "${names.join(' ')}"` : 'no FLOW maps found');
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const results = [];
for (const map of maps) {
  const html = page(mermaidJs, map.code);
  const r = measure(map, html);
  results.push({ id: map.id, rel: map.rel, ...r });

  if (WANT_PNG && r.ok) {
    const file = join(CACHE, `page-${map.id.replace(/[^a-z0-9]+/gi, '-')}.html`);
    const png = join(OUT, `${map.id.replace(/[^a-z0-9]+/gi, '-')}.png`);
    chrome([
      `--window-size=${Math.min(r.width + 40, 4000)},${Math.min(r.height + 40, 8000)}`,
      '--virtual-time-budget=20000', `--screenshot=${png}`, pathToFileURL(file).href,
    ]);
  }
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
if (WANT_JSON) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (!r.ok) { console.log(`✗ ${r.id} — ${r.error}`); continue; }
    const head = `${r.overlaps.length ? '✗' : '✓'} ${r.id.padEnd(18)} ${String(r.width).padStart(5)}×${String(r.height).padEnd(5)} ${r.labels} labels`;
    console.log(`${head}${r.overlaps.length ? `  — ${r.overlaps.length} OVERLAP(S)` : ''}`);
    for (const o of r.overlaps) {
      console.log(`    ${o.kind} ${o.w}×${o.h}px`);
      console.log(`      A: ${o.a.slice(0, 90)}`);
      console.log(`      B: ${o.b.slice(0, 90)}`);
    }
  }
  if (WANT_PNG) console.log(`\nPNGs → ${OUT}`);
}

const bad = results.filter((r) => !r.ok || r.overlaps.length);
if (bad.length) {
  console.log(`\n${bad.length} of ${results.length} map(s) have unreadable regions.`);
  process.exit(1);
}
console.log(`\nall ${results.length} map(s) render with no overlapping labels.`);
