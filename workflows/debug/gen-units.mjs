#!/usr/bin/env node
// Deterministic review-unit manifest generator (plain Node — run it directly, unlike the engine).
//
// Divides source directories into bounded "review units" so each review agent has limited focus.
// Rule: a unit = one directory's direct files, EXCEPT
//   - any single file > --big-file LOC becomes its own unit
//   - a direct-file group over --cap-loc / --cap-files is split into sequential chunks
//   - subdirectories recurse into their own units
// Then a bin-packing pass merges adjacent (path-sorted) base units first-fit-greedy up to --pack-loc
// LOC each (default 2000 ≈ ~215k tokens per review agent), because walk() never merges sibling dirs on
// its own. A base unit already at/over the target stays solo; merged units get a `<common-dir>#p<n>` id
// and a recomputed hash. --pack-loc 0 disables the pass (old per-directory units).
// Output is stable (sorted) so the same tree always yields the same manifest, and each unit
// carries a content hash so the engine re-reviews only units whose files changed.
//
// Usage:
//   node gen-units.mjs --repo /abs/path/to/repo --src src --out runs/myrun/manifest.json
//
// Flags:
//   --repo <path>       target git repo (default: cwd). All manifest paths are relative to it.
//   --src <dirs>        comma-separated source dirs under the repo to scan (default: src)
//   --ext <exts>        comma-separated source extensions to include (default: a broad
//                       multi-language set; pass --ext to scope it to just your stack)
//   --skip <regex>      filename regex to exclude (default: generated/minified JS markers —
//                       harmless on other stacks; override for your own generated-file pattern)
//   --exclude <dirs>    comma-separated directory names to skip anywhere (default: common
//                       dependency/build dirs across ecosystems)
//   --cap-loc <n>       max LOC per multi-file unit before splitting (default: 2000)
//   --cap-files <n>     max files per multi-file unit before splitting (default: 24)
//   --big-file <n>      a single file this big gets reviewed alone (default: 2000)
//   --pack-loc <n>      target LOC per unit for the sibling-merge bin-packing pass (default: 2000;
//                       0 disables packing → old per-directory units)
//   --out <path>        where to write the manifest (default: manifest.json in cwd)
//   --issues-dir <path> RESUME: a completed review's runs/<runId>/issues/ dir. Each unit is joined
//                       against <issues-dir>/<fileSafe(id)>.md and tagged state: new|changed|unchanged
//                       by its frontmatter `hash:`; the manifest then also carries `staleUnits` (the
//                       new + changed ones) to pass straight into review.mjs's args.units. Without the
//                       flag the output is exactly as before.

import { readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
  }
  return out;
}
const opt = parseArgs(process.argv.slice(2));

// Nothing is COERCED. `Number('abc')` and a bare flag's `Number('true')` are both NaN, and every
// comparison against NaN is false — so a typo does not error, it silently DISABLES the bound it was
// meant to set (no LOC cap, no big-file split, no bin-packing) and the run pays for review agents
// scoped by a limit that was never applied. Fail fast instead, in the same style as --issues-dir below.
const num = (raw, name, min, dflt) => {
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    console.error(`--${name} must be a number >= ${min} (got "${raw}")`);
    process.exit(1);
  }
  return n;
};

const REPO      = resolve(opt.repo ?? '.');
const SRC_DIRS  = (opt.src ?? 'src').split(',').map((s) => s.trim()).filter(Boolean);
const EXTS      = (opt.ext ?? '.ts,.tsx,.js,.jsx,.mjs,.cjs,.py,.go,.rs,.java,.kt,.rb,.php,.cs,.cpp,.cc,.c,.h,.hpp,.swift,.scala').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP_RE   = new RegExp(opt.skip ?? String.raw`\.d\.ts$|\.min\.`);
const EXCLUDES  = new Set((opt.exclude ?? 'node_modules,dist,build,out,vendor,coverage,.git,target,__pycache__,.venv,venv,.tox,.gradle').split(',').map((s) => s.trim()));
const CAP_LOC   = num(opt['cap-loc'], 'cap-loc', 1, 2000);
const CAP_FILES = num(opt['cap-files'], 'cap-files', 1, 24);
const BIG_FILE  = num(opt['big-file'], 'big-file', 1, 2000);
const PACK_LOC  = num(opt['pack-loc'], 'pack-loc', 0, 2000);   // 0 stays legal — it disables packing
const CEIL_LOC  = 3500;                          // ~350k-token review ceiling; warn on any unit past it
const OUT       = isAbsolute(opt.out ?? '') ? opt.out : resolve(opt.out ?? 'manifest.json');
const ISSUES    = opt['issues-dir'] ? resolve(opt['issues-dir']) : '';
// A bare flag or a mistyped path would report every unit as `new` — the exact false signal the flag
// exists to remove (the operator re-reviews the whole campaign believing the join worked). Fail instead.
if (ISSUES) {
  if (opt['issues-dir'] === 'true') { console.error('--issues-dir needs a path: the runs/<runId>/issues/ dir of the review you are resuming.'); process.exit(1); }
  try { if (!statSync(ISSUES).isDirectory()) throw 0; } catch {
    console.error(`--issues-dir ${ISSUES} is not a directory — every unit would read as new. Check the path.`);
    process.exit(1);
  }
}

const loc = (p) => readFileSync(p, 'utf8').split('\n').length;
const rel = (p) => relative(REPO, p).replace(/\\/g, '/');
const wanted = (name) => EXTS.some((e) => name.endsWith(e)) && !SKIP_RE.test(name);

function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(rel(f) + '\0' + readFileSync(f, 'utf8'));
  return h.digest('hex').slice(0, 12);
}

function makeUnit(id, filePaths) {
  const files = filePaths.map((p) => ({ path: rel(p), loc: loc(p) }));
  return {
    id,
    files,
    fileCount: files.length,
    loc: files.reduce((s, f) => s + f.loc, 0),
    hash: hashFiles(filePaths),
  };
}

// Greedy chunking of a directory's small direct files by LOC/file caps.
function chunk(items) {
  const chunks = [];
  let cur = [];
  let curLoc = 0;
  for (const it of items) {
    if (cur.length && (curLoc + it.loc > CAP_LOC || cur.length >= CAP_FILES)) {
      chunks.push(cur);
      cur = [];
      curLoc = 0;
    }
    cur.push(it);
    curLoc += it.loc;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function walk(dir) {
  const entries = readdirSync(dir).sort();
  const files = entries
    .filter((e) => wanted(e))
    .map((e) => join(dir, e))
    .filter((p) => statSync(p).isFile());
  const subdirs = entries
    .filter((e) => !EXCLUDES.has(e))
    .map((e) => join(dir, e))
    .filter((p) => statSync(p).isDirectory());

  const units = [];
  const small = [];
  for (const f of files) {
    if (loc(f) > BIG_FILE) units.push(makeUnit(rel(f), [f]));
    else small.push({ path: f, loc: loc(f) });
  }
  if (small.length) {
    const chunks = chunk(small);
    const base = rel(dir) || '_root';
    chunks.forEach((c, i) => {
      const id = chunks.length === 1 ? base : `${base}#${i + 1}`;
      units.push(makeUnit(id, c.map((x) => x.path)));
    });
  }
  for (const sd of subdirs) units.push(...walk(sd));
  return units;
}

// Longest common directory prefix (by path segment) across every file in a group of units.
function commonDirPrefix(group) {
  const dirs = group.flatMap((u) => u.files.map((f) => {
    const i = f.path.lastIndexOf('/');
    return i >= 0 ? f.path.slice(0, i) : '';
  }));
  let parts = (dirs[0] ?? '').split('/');
  for (const d of dirs.slice(1)) {
    const dp = d.split('/');
    let k = 0;
    while (k < parts.length && k < dp.length && parts[k] === dp[k]) k++;
    parts = parts.slice(0, k);
  }
  return parts.join('/') || '_root';
}

// Bin-packing pass: merge adjacent (already path-sorted) base units first-fit-greedy up to PACK_LOC LOC
// per unit. Singleton groups pass through UNCHANGED (stable id + hash); a base unit already at/over the
// target stays solo. Merged units rebuild abs paths and reuse makeUnit, so the merged hash is the
// existing hashFiles over the merged set. --pack-loc 0 (PACK_LOC <= 0) disables the pass.
function pack(baseUnits) {
  if (!(PACK_LOC > 0)) return baseUnits;
  const groups = [];
  let cur = [];
  let curLoc = 0;
  const flush = () => { if (cur.length) { groups.push(cur); cur = []; curLoc = 0; } };
  for (const u of baseUnits) {
    if (u.loc >= PACK_LOC) { flush(); groups.push([u]); continue; }
    if (cur.length && curLoc + u.loc > PACK_LOC) flush();
    cur.push(u);
    curLoc += u.loc;
  }
  flush();

  const counters = {};
  return groups.map((g) => {
    if (g.length === 1) return g[0];
    const absPaths = g.flatMap((u) => u.files.map((f) => join(REPO, f.path)));
    const prefix = commonDirPrefix(g);
    const n = (counters[prefix] = (counters[prefix] ?? 0) + 1);
    return makeUnit(`${prefix}#p${n}`, absPaths);
  });
}

// --issues-dir join. CONTRACT with review.mjs — change together: the issue-file name scheme
// (fileSafe(unit.id) + '.md', review.mjs:95/102) and the `hash:` frontmatter line both writers stamp
// (review.mjs:216/266) are the whole interface. A file with no readable hash counts as CHANGED — the
// safe direction, since missing a changed unit means its defects are never reviewed.
const fileSafe = (id) => String(id).replace(/[^a-z0-9]+/gi, '_').toLowerCase();

function issueHash(unitId) {
  let text;
  try { text = readFileSync(join(ISSUES, `${fileSafe(unitId)}.md`), 'utf8'); } catch { return null; }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = (fm ? fm[1] : '').match(/^hash:[ \t]*(\S+)/m);
  return m ? m[1] : '';
}

const stateOf = (u) => {
  const h = issueHash(u.id);
  return h === null ? 'new' : h === u.hash ? 'unchanged' : 'changed';
};

const units = pack(
  SRC_DIRS
    .flatMap((d) => {
      const p = join(REPO, d);
      try { statSync(p); } catch { console.error(`warning: ${p} does not exist — skipped`); return []; }
      return walk(p);
    })
    .sort((a, b) => a.id.localeCompare(b.id))
);

if (!units.length) {
  console.error('No units produced — check --repo / --src / --ext.');
  process.exit(1);
}

for (const u of units) {
  if (u.loc > CEIL_LOC) console.error(`warning: unit ${u.id} is ${u.loc} LOC (est. >~350k tokens) — past the review ceiling; lower --pack-loc or split the file`);
}

if (ISSUES) for (const u of units) u.state = stateOf(u);
const stale = ISSUES ? units.filter((u) => u.state !== 'unchanged') : [];

const manifest = {
  repo: REPO,
  src: SRC_DIRS,
  caps: { CAP_LOC, CAP_FILES, BIG_FILE, PACK_LOC },
  totalUnits: units.length,
  totalLoc: units.reduce((s, u) => s + u.loc, 0),
  ...(ISSUES ? { issuesDir: ISSUES, staleUnits: stale } : {}),
  units,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');

console.log(`${units.length} units, ${manifest.totalLoc} LOC → ${OUT}\n`);
if (ISSUES) {
  const n = (s) => units.filter((u) => u.state === s).length;
  console.log(`vs ${ISSUES}: ${n('new')} new, ${n('changed')} changed, ${n('unchanged')} unchanged — pass manifest.staleUnits (${stale.length}) as review.mjs args.units`);
  if (PACK_LOC > 0) console.log(`  approximate after a tree change: packing re-derives merged "<dir>#p<n>" ids, so files added or removed can shift ids and report units as new that were in fact reviewed`);
  console.log('');
}
for (const u of [...units].sort((a, b) => a.loc - b.loc)) {
  console.log(`${String(u.loc).padStart(6)} LOC  ${String(u.fileCount).padStart(2)}f  ${u.id}${u.state ? `  [${u.state}]` : ''}`);
}
