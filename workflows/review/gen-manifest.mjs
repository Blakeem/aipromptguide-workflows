#!/usr/bin/env node
// Deterministic review-unit manifest generator (plain Node — run it directly, unlike the engine).
//
// Divides source directories into bounded "review units" so each review agent has limited focus.
// Rule: a unit = one directory's direct files, EXCEPT
//   - any single file > --big-file LOC becomes its own unit
//   - a direct-file group over --cap-loc / --cap-files is split into sequential chunks
//   - subdirectories recurse into their own units
// Output is stable (sorted) so the same tree always yields the same manifest, and each unit
// carries a content hash so the engine re-reviews only units whose files changed.
//
// Usage:
//   node gen-manifest.mjs --repo /abs/path/to/repo --src src --out runs/myrun/manifest.json
//
// Flags:
//   --repo <path>       target git repo (default: cwd). All manifest paths are relative to it.
//   --src <dirs>        comma-separated source dirs under the repo to scan (default: src)
//   --ext <exts>        comma-separated file extensions to include (default: .ts,.tsx,.js,.mjs)
//   --skip <regex>      filename regex to exclude (default: \.d\.ts$|\.min\.)
//   --exclude <dirs>    comma-separated directory names to skip anywhere
//                       (default: node_modules,dist,build,out,vendor,coverage,.git)
//   --cap-loc <n>       max LOC per multi-file unit before splitting (default: 800)
//   --cap-files <n>     max files per multi-file unit before splitting (default: 6)
//   --big-file <n>      a single file this big gets reviewed alone (default: 700)
//   --out <path>        where to write the manifest (default: manifest.json in cwd)

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

const REPO      = resolve(opt.repo ?? '.');
const SRC_DIRS  = (opt.src ?? 'src').split(',').map((s) => s.trim()).filter(Boolean);
const EXTS      = (opt.ext ?? '.ts,.tsx,.js,.mjs').split(',').map((s) => s.trim()).filter(Boolean);
const SKIP_RE   = new RegExp(opt.skip ?? String.raw`\.d\.ts$|\.min\.`);
const EXCLUDES  = new Set((opt.exclude ?? 'node_modules,dist,build,out,vendor,coverage,.git').split(',').map((s) => s.trim()));
const CAP_LOC   = Number(opt['cap-loc'] ?? 800);
const CAP_FILES = Number(opt['cap-files'] ?? 6);
const BIG_FILE  = Number(opt['big-file'] ?? 700);
const OUT       = isAbsolute(opt.out ?? '') ? opt.out : resolve(opt.out ?? 'manifest.json');

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

const units = SRC_DIRS
  .flatMap((d) => {
    const p = join(REPO, d);
    try { statSync(p); } catch { console.error(`warning: ${p} does not exist — skipped`); return []; }
    return walk(p);
  })
  .sort((a, b) => a.id.localeCompare(b.id));

if (!units.length) {
  console.error('No units produced — check --repo / --src / --ext.');
  process.exit(1);
}

const manifest = {
  repo: REPO,
  src: SRC_DIRS,
  caps: { CAP_LOC, CAP_FILES, BIG_FILE },
  totalUnits: units.length,
  totalLoc: units.reduce((s, u) => s + u.loc, 0),
  units,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');

console.log(`${units.length} units, ${manifest.totalLoc} LOC → ${OUT}\n`);
for (const u of [...units].sort((a, b) => a.loc - b.loc)) {
  console.log(`${String(u.loc).padStart(6)} LOC  ${String(u.fileCount).padStart(2)}f  ${u.id}`);
}
