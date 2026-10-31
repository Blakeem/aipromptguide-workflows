// tools/risk-check.mjs: the risk file checker and the only copy of the risk file format. A develop developer
// runs it on its risk file in its CLASSIFY phase, and acceptance runs it on the latest audited one in its risk audit.
//
//   node tools/risk-check.mjs <risk file> --repo <repo> --snapshot <tree id>
//
// A missing file gets a skeleton. A written one is checked: its format, its Snapshot line against --snapshot, and
// each sweep search, rerun in the repo's working tree in its plain and source-escaped forms. Exit 0 prints
// `ok: <file>`, 1 lists each problem and, after a format or Snapshot error, the format, and 2 is a usage or git
// error. Both 0 and 1 end `low risk: yes|no` once every answer parses. tools/CLAUDE.md holds the contract. FORMAT below holds the file format.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXIT = { ok: 0, problems: 1, usage: 2 };
// develop-cycle.mjs cannot import, so it holds its own copies of these three. A test compares the copies.
export const SNAPSHOT_LINE = 'Snapshot:';
export const SWEEP_HEADING = '## Sweep';
export const NO_CHANGES = 'No changes.';
// The names of the four RISK QUESTIONS develop-cycle.mjs renders. A test compares the two copies.
export const RISK_KEYS = ['Systems', 'Paths', 'Critical code', 'Assumptions'];

const TREE_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SNAPSHOT_RE = /^Snapshot:[ \t]*(\S*)[ \t]*$/;
const HEADING_RE = /^##[ \t]+(.*?)[ \t]*$/;
const CHANGE_NAME_RE = /^\S.*:\d+(?:-\d+)?$/;
const ANSWER_LINE_RE = /^-[ \t]+([^:]+?)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const NO_RE = /^no\.?$|^no[ \t]*:[ \t]*\S/i;
const YES_RE = /^yes[ \t]*:[ \t]*\S/i;
const SEARCH_RE = /^search:[ \t]*(.*?)[ \t]*$/;
const SCOPE_RE = /^scope:[ \t]*(.*?)[ \t]*$/;
const HIT_COUNT_RE = /^-[ \t]+(.+?)[ \t]+\((\d+) hits?\)[ \t]+(updated|unaffected)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const HIT_LINE_RE = /^-[ \t]+(.+?):(\d+)[ \t]+(updated|unaffected)[ \t]*:[ \t]*(.*?)[ \t]*$/;
const ANSWER_SHAPE = '`no`, `no: <note>` or `yes: <evidence>`';
const HIT_SHAPE = '`- <path>:<line> updated|unaffected: <reason>` or `- <path> (<n> hits) updated|unaffected: <reason>`';
// A git grep of a common word can print megabytes, which the default child buffer would cut.
const MAX_BUFFER = 256 * 1024 * 1024;

export const FORMAT = `A risk file holds, in this order:
  ${SNAPSHOT_LINE} <tree id>
      the first line: the tree id of the working tree after the round's last change.
  ## <path>:<line>
  - ${RISK_KEYS.join(': <answer>\n  - ')}: <answer>
      one section per change, named by the first line it changes, with one line per risk question.
      Each <answer> is ${ANSWER_SHAPE}.
  ${SWEEP_HEADING}
  search: <text>
  scope: <pathspec> [<pathspec> ...]
  - <path>:<line> updated|unaffected: <reason>
  - <path> (<n> hits) updated|unaffected: <reason>
      after the change sections, one block per search, every block under the one ${SWEEP_HEADING} heading.
      <text> is one literal string, matched case-sensitively as written and as a '...', "..." or \`...\`
      source string escapes it. The scope names repo paths, \`.\` for the entire repo. Each hit the search
      finds takes one line, marked updated or unaffected with its reason. The <n> hits form covers every
      hit in one generated file the gate checks.
A round that changed nothing holds the ${SNAPSHOT_LINE} line and the line \`${NO_CHANGES}\` alone.`;

const USAGE = `usage: node tools/risk-check.mjs <risk file> --repo <repo> --snapshot <tree id>
  writes a skeleton when the file is missing. Otherwise it checks the file, reruns each sweep search in the
  repo's working tree, prints "ok: <file>" or each problem, and ends "low risk: yes|no" once every answer parses.

${FORMAT}`;

// Each skeleton slot is refused as written, so a skeleton never passes as a filled file.
const SLOTS = {
  change: '## TODO: <path>:<line> of the change',
  answer: (key) => `- ${key}: TODO: ${ANSWER_SHAPE}`,
  search: 'search: TODO: <one literal string, such as the old wording of a changed phrase>',
  scope: 'scope: TODO: <pathspec> ...',
  hit: '- TODO: <path>:<line> updated|unaffected: <reason>',
};
const SLOT_LINES = new Set([SLOTS.change, ...RISK_KEYS.map(SLOTS.answer), SLOTS.search, SLOTS.scope, SLOTS.hit]);

// =============================================================================
// Text: pure functions over a file's content.
// =============================================================================

/** A new risk file holding the snapshot id and one placeholder per slot. */
export const skeleton = (snapshot) => [
  `${SNAPSHOT_LINE} ${snapshot}`, '', SLOTS.change, ...RISK_KEYS.map(SLOTS.answer), '', SWEEP_HEADING, SLOTS.search, SLOTS.scope, SLOTS.hit, '',
].join('\n');

/** The literal and each form a JavaScript or JSON string writes it in, so a hit inside a quoted string is found. */
export function searchForms(literal) {
  const escapedFor = (quote) => literal.replace(/\\/g, '\\\\').split(quote).join(`\\${quote}`);
  return [...new Set([literal, escapedFor("'"), escapedFor('"'), escapedFor('`').replace(/\$\{/g, '\\${')])];
}

/** A hit path as git prints it: forward slashes, no leading `./`, and relative to the repo when written absolute. */
export function repoPath(path, top) {
  const slashed = path.replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = `${top.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  return slashed.toLowerCase().startsWith(prefix.toLowerCase()) ? slashed.slice(prefix.length) : slashed;
}

/** The answer's verdict, true for yes and false for no, or null when the answer has neither shape. */
function answerVerdict(value) {
  if (NO_RE.test(value)) return false;
  if (YES_RE.test(value)) return true;
  return null;
}

/**
 * The file's parts and each format error, by line. `changes` holds each change section's answers, `searches`
 * each sweep block, and `lowRisk` is null when an answer does not parse.
 */
export function parseRiskFile(text) {
  // Input
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const errors = [];
  const changes = [];
  const searches = [];
  let snapshot = null;
  let noChangesLine = 0;
  let sweepLine = 0;
  let section = null;
  let search = null;

  // Process
  const snapshotMatch = lines[0].match(SNAPSHOT_RE);
  if (!snapshotMatch) errors.push(`line 1 must be \`${SNAPSHOT_LINE} <tree id>\`, got "${lines[0].slice(0, 80)}"`);
  else if (!TREE_RE.test(snapshotMatch[1])) errors.push(`line 1 holds "${snapshotMatch[1]}", which is no tree id (40 or 64 lowercase hex digits)`);
  else snapshot = snapshotMatch[1];
  lines.slice(1).forEach((raw, index) => {
    const n = index + 2;
    const line = raw.trim();
    const heading = line.match(HEADING_RE);
    if (!line) return;
    if (SLOT_LINES.has(line)) { errors.push(`line ${n} still holds the skeleton's placeholder: "${line}"`); return; }
    if (line === NO_CHANGES) { noChangesLine = n; return; }
    if (heading && line === SWEEP_HEADING) {
      if (sweepLine) errors.push(`line ${n} is a second \`${SWEEP_HEADING}\` section, after the one on line ${sweepLine}`);
      sweepLine = sweepLine || n;
      section = 'sweep';
      return;
    }
    if (heading) {
      if (sweepLine) errors.push(`line ${n} starts a change section after \`${SWEEP_HEADING}\`, which comes last`);
      if (!CHANGE_NAME_RE.test(heading[1])) errors.push(`line ${n} names a change "${heading[1]}", and a change section is named \`## <path>:<line>\``);
      changes.push({ name: heading[1], line: n, answers: {} });
      section = 'change';
      return;
    }
    if (section === 'change') { readAnswer(changes.at(-1), line, n, errors); return; }
    if (section === 'sweep') { search = readSweepLine(searches, search, line, n, errors); return; }
    errors.push(`line ${n} sits before any section: "${line.slice(0, 80)}"`);
  });

  if (noChangesLine && (changes.length || sweepLine)) errors.push(`line ${noChangesLine} reads \`${NO_CHANGES}\`, which stands alone after the ${SNAPSHOT_LINE} line, and the file also holds sections`);
  if (!noChangesLine && !changes.length) errors.push(`the file holds no change section and no \`${NO_CHANGES}\` line`);
  for (const change of changes) {
    const missing = RISK_KEYS.filter((key) => !Object.hasOwn(change.answers, key));
    if (missing.length) errors.push(`the change section on line ${change.line} has no answer line for ${missing.join(', ')}`);
  }
  if (changes.length && !sweepLine) errors.push(`the file holds no \`${SWEEP_HEADING}\` section`);
  if (sweepLine && !searches.length) errors.push(`the \`${SWEEP_HEADING}\` section on line ${sweepLine} holds no \`search:\` line`);
  for (const s of searches) {
    if (!s.scope) errors.push(`the search on line ${s.line} has no \`scope:\` line`);
  }
  const verdicts = changes.flatMap((c) => RISK_KEYS.map((key) => c.answers[key] ?? null));
  const parsed = verdicts.every((v) => v !== null);

  // Output
  return {
    snapshot, errors, changes, searches,
    lowRisk: noChangesLine && !changes.length ? true : parsed && changes.length ? verdicts.every((v) => v === false) : null,
  };
}

/** Records one answer line of a change section, or the error that says why it is none. */
function readAnswer(change, line, n, errors) {
  const match = line.match(ANSWER_LINE_RE);
  const key = match && RISK_KEYS.find((k) => k.toLowerCase() === match[1].toLowerCase());
  if (!key) { errors.push(`line ${n} is no answer line: a change section holds only \`- <question>: <answer>\` for ${RISK_KEYS.join(', ')}, got "${line.slice(0, 80)}"`); return; }
  if (Object.hasOwn(change.answers, key)) { errors.push(`line ${n} answers ${key} a second time for the change on line ${change.line}`); return; }
  const verdict = answerVerdict(match[2]);
  if (verdict === null) errors.push(`line ${n}: the ${key} answer is ${ANSWER_SHAPE}, got "${match[2].slice(0, 80)}"`);
  change.answers[key] = verdict;
}

/** Records one line of the sweep section and returns the search block it belongs to. */
function readSweepLine(searches, search, line, n, errors) {
  const searchMatch = line.match(SEARCH_RE);
  if (searchMatch) {
    if (!searchMatch[1]) errors.push(`line ${n} is a \`search:\` line with no text`);
    const next = { literal: searchMatch[1], line: n, scope: null, hits: [] };
    searches.push(next);
    return next;
  }
  if (!search) { errors.push(`line ${n} comes before the first \`search:\` line of the sweep: "${line.slice(0, 80)}"`); return search; }
  const scopeMatch = line.match(SCOPE_RE);
  if (scopeMatch) {
    if (search.scope) errors.push(`line ${n} is a second \`scope:\` line for the search on line ${search.line}`);
    else if (!scopeMatch[1]) errors.push(`line ${n} is a \`scope:\` line with no path, and \`.\` names the entire repo`);
    else search.scope = scopeMatch[1].split(/[ \t]+/);
    return search;
  }
  const count = line.match(HIT_COUNT_RE);
  const single = count ? null : line.match(HIT_LINE_RE);
  const hit = count ? { path: count[1], lineNo: null, count: Number(count[2]), reason: count[4] } : single ? { path: single[1], lineNo: Number(single[2]), count: null, reason: single[4] } : null;
  if (!hit) { errors.push(`line ${n} is no sweep line: a search block holds \`search:\`, \`scope:\` and hit lines ${HIT_SHAPE}, got "${line.slice(0, 80)}"`); return search; }
  if (!search.scope) errors.push(`line ${n} lists a hit before the \`scope:\` line of the search on line ${search.line}`);
  if (!hit.reason) errors.push(`line ${n} marks a hit with no reason`);
  search.hits.push({ ...hit, line: n });
  return search;
}

/**
 * Each problem of the sweep against what its searches find now. `found(search)` returns the search's hits as
 * `{ path, line, text }`, and `scopeMatches(pathspec)` whether a pathspec names a file.
 */
export function sweepProblems(searches, { found, scopeMatches, top }) {
  const errors = [];
  const leftOut = [];
  for (const s of searches.filter((x) => x.literal && x.scope)) {
    const empty = s.scope.filter((spec) => !scopeMatches(spec));
    if (empty.length) { errors.push(`line ${s.line}: the scope ${empty.map((e) => `"${e}"`).join(', ')} names no file in the repo`); continue; }
    const hits = found(s);
    const keyOf = (path, lineNo) => `${path}:${lineNo}`;
    const foundKeys = new Set(hits.map((h) => keyOf(h.path, h.line)));
    const listed = new Set();
    const counted = new Set();
    for (const hit of s.hits) {
      const path = repoPath(hit.path, top);
      if (hit.count !== null) {
        const inPath = hits.filter((h) => h.path === path).length;
        if (counted.has(path)) errors.push(`line ${hit.line} counts the hits in ${path} a second time`);
        else if (inPath !== hit.count) errors.push(`line ${hit.line} counts ${hit.count} hit(s) in ${path}, and the search finds ${inPath} there`);
        counted.add(path);
        continue;
      }
      const key = keyOf(path, hit.lineNo);
      if (listed.has(key)) errors.push(`line ${hit.line} lists ${key} a second time for the search on line ${s.line}`);
      else if (!foundKeys.has(key)) errors.push(`line ${hit.line} lists ${key}, where the search on line ${s.line} finds no hit`);
      listed.add(key);
    }
    for (const h of hits) {
      if (!listed.has(keyOf(h.path, h.line)) && !counted.has(h.path)) leftOut.push(`left out: the search on line ${s.line} ("${s.literal.slice(0, 60)}") finds ${h.path}:${h.line}: ${h.text.trim().slice(0, 120)}`);
    }
  }
  return { errors, leftOut };
}

/** The report lines and exit code for a written file. */
export function checkText(text, { file, snapshot, found, scopeMatches, top }) {
  // Input
  const parsed = parseRiskFile(text);

  // Process
  const errors = [...parsed.errors];
  if (parsed.snapshot && parsed.snapshot !== snapshot) {
    errors.unshift(`line 1 holds the snapshot ${parsed.snapshot}, not ${snapshot}. A file an earlier launch left, or one written before the round's last change, is replaced in full`);
  }
  const sweep = sweepProblems(parsed.searches, { found, scopeMatches, top });
  const problems = [...errors, ...sweep.errors].map((e) => `error: ${e}`).concat(sweep.leftOut);

  // Output
  // A file with a format error or another launch's snapshot is rewritten, and only the skeleton run showed the format.
  const formatHelp = errors.length ? ['', FORMAT] : [];
  const riskLine = parsed.lowRisk === null ? [] : [`low risk: ${parsed.lowRisk ? 'yes' : 'no'}`];
  return problems.length
    ? { lines: [`${problems.length} problem(s):`, ...problems, ...formatHelp, ...riskLine], code: EXIT.problems }
    : { lines: [`ok: ${file}`, ...riskLine], code: EXIT.ok };
}

// =============================================================================
// CLI: every read, write and git call happens here.
// =============================================================================

function git(top, args) {
  const r = spawnSync('git', ['-C', top, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: MAX_BUFFER });
  if (r.error) throw new Error(`cannot run git in ${top}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

const firstLine = (s) => String(s).split('\n')[0].trim();

/** The search's hits in the working tree, untracked files included and ignored ones left out. */
function grepHits(top, search) {
  const forms = searchForms(search.literal).flatMap((f) => ['-e', f]);
  const r = git(top, ['grep', '-n', '-I', '-z', '--full-name', '--untracked', '-F', ...forms, '--', ...search.scope]);
  if (r.code === 1) return [];
  if (r.code !== 0) throw new Error(`git grep failed for the search on line ${search.line}: ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout.split('\n').filter(Boolean).map((row) => {
    const [path, line, ...rest] = row.split('\0');
    return { path, line: Number(line), text: rest.join('\0').replace(/\r$/, '') };
  });
}

function scopeMatches(top, pathspec) {
  const r = git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', pathspec]);
  if (r.code !== 0) throw new Error(`git ls-files failed for the scope "${pathspec}": ${firstLine(r.stderr) || `exit ${r.code}`}`);
  return r.stdout.length > 0;
}

/** The --repo and --snapshot values and the file path, or an error naming the bad argument. */
function parseArgs(argv) {
  const values = { file: null, '--repo': null, '--snapshot': null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo' || arg === '--snapshot') {
      if (values[arg] !== null || argv[i + 1] === undefined) throw new Error(USAGE);
      values[arg] = argv[++i];
    } else if (values.file === null && !arg.startsWith('--')) values.file = arg;
    else throw new Error(USAGE);
  }
  if (!values.file || !values['--repo'] || !values['--snapshot']) throw new Error(USAGE);
  return values;
}

export function run(argv) {
  try {
    // Input
    const { file, '--repo': repo, '--snapshot': snapshot } = parseArgs(argv);
    if (!TREE_RE.test(snapshot)) throw new Error(`--snapshot takes the tree id \`git write-tree\` printed, got "${snapshot}"`);
    const topRun = spawnSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (topRun.error || topRun.status !== 0) throw new Error(`--repo ${repo} is no git work tree: ${firstLine(topRun.stderr) || topRun.error?.message}`);
    const top = topRun.stdout.trim();
    const treeType = git(top, ['cat-file', '-t', snapshot]);
    if (treeType.code !== 0 || treeType.stdout.trim() !== 'tree') throw new Error(`--snapshot ${snapshot} names no tree in ${top}`);

    // Process and output
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, skeleton(snapshot));
      return { lines: [`wrote a skeleton to ${file}. Replace each TODO line, then run this command again.`, '', FORMAT], code: EXIT.problems };
    }
    return checkText(readFileSync(file, 'utf8'), {
      file, snapshot, top, found: (search) => grepHits(top, search), scopeMatches: (pathspec) => scopeMatches(top, pathspec),
    });
  } catch (err) {
    return { lines: [`risk-check: ${err.message}`], code: EXIT.usage };
  }
}

// Node resolves the main module through realpath, so both sides are realpathed, as in plan-block.mjs.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  const { lines, code } = run(process.argv.slice(2));
  (code === EXIT.usage ? process.stderr : process.stdout).write(`${lines.join('\n')}\n`);
  process.exit(code);
}
