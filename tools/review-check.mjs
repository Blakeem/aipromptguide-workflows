// tools/review-check.mjs: the staged-review checker. A reviewer agent runs it on its own review file,
// and an engine's check agent runs it with --verify after the reviewer returns.
//
//   node tools/review-check.mjs <review.md>            # first run: format check, then lock + reveal. Later: the final-file check
//   node tools/review-check.mjs --verify <review.md>   # lock state and counts. Exit 0 match, 2 no lock, 3 mismatch.
//                                                      # The locked verdict prints on 3, and on 0 with no final file
//
// tools/CLAUDE.md holds the spec, lock and file formats.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXIT = { ok: 0, error: 1, noLock: 2, mismatch: 3 };
const USAGE = 'usage: node review-check.mjs [--verify] <review file>';
const VERDICT_RE = /^Verdict:[ \t]*(accept|reject)[ \t]*$/i;
const OBJECTION_RE = /^[ \t]*[-*][ \t]+(O\d+)[ \t]*:/;
const SORT_RE = /^[ \t]*[-*][ \t]+(O\d+)[ \t]*:[ \t]*(withdrawn|kept|downgraded)\b(.*)$/i;
const QUOTE_RE = /"([^"]+)"|“([^”]+)”/;
// A short quote matches nearly any decision file, so it proves no fact answers the objection.
export const MIN_QUOTE_CHARS = 20;

// =============================================================================
// Parsing and checks: pure functions over file text.
// =============================================================================

/** The spec and lock paths of a review file: `<parent of its folder>/locks/<stem>.json|.lock`. */
export function pathsFor(reviewFile) {
  const locks = join(dirname(dirname(reviewFile)), 'locks');
  const stem = basename(reviewFile, extname(reviewFile));
  return { spec: join(locks, `${stem}.json`), lock: join(locks, `${stem}.lock`) };
}

/** The spec's fields, or an error naming the first bad one. */
function parseSpec(text, path) {
  let spec = null;
  try { spec = JSON.parse(text); } catch (e) { return { error: `the check spec ${path} is not JSON (${e.message})` }; }
  const headingsOk = Array.isArray(spec?.headings) && spec.headings.length > 0 && spec.headings.every((h) => typeof h === 'string' && h.trim());
  if (!headingsOk) return { error: `the check spec ${path} needs "headings", a non-empty array of heading lines` };
  const missing = ['stage2', 'decision', 'reveal'].filter((k) => typeof spec[k] !== 'string' || !spec[k].trim());
  if (missing.length) return { error: `the check spec ${path} needs the file paths ${missing.map((k) => `"${k}"`).join(', ')}` };
  return { spec };
}

const linesOf = (text) => String(text).split(/\r?\n/);
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const verdictsOf = (text) => linesOf(text).map((l) => l.match(VERDICT_RE)?.[1]?.toLowerCase()).filter(Boolean);

/** The objection ids of a blind review, in file order, duplicates included. */
const objectionIds = (text) => linesOf(text).map((l) => l.match(OBJECTION_RE)?.[1]).filter(Boolean);

/** The blind review's format errors, its objection ids and its verdict. */
function checkStage1(text, headings) {
  const errors = [];
  const lines = linesOf(text).map((l) => l.trim());
  for (const h of headings) {
    if (!lines.includes(h.trim())) errors.push(`missing the heading line "${h.trim()}"`);
  }
  const ids = objectionIds(text);
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) errors.push(`objection id(s) used twice: ${dupes.join(', ')}. Give each objection its own O<n>`);
  const verdicts = verdictsOf(text);
  const verdict = verdicts.length === 1 ? verdicts[0] : '';
  if (!verdicts.length) errors.push('no verdict line: end the file with "Verdict: accept" or "Verdict: reject"');
  if (verdicts.length > 1) errors.push(`${verdicts.length} verdict lines: keep one`);
  if (verdict === 'reject' && !ids.length) errors.push('a reject needs at least one objection line "- O<n>: ..."');
  if (verdict === 'accept' && ids.length) errors.push('an accept holds no objection: reject, or make each concern that is not an objection a caveat');
  return { errors, ids: [...new Set(ids)], verdict };
}

/**
 * The final file checked against the blind review's objection ids and the decision file. Counts treat an
 * unsorted objection, and a withdrawal whose quote is missing or not found, as kept.
 */
function checkStage2(text, ids, decisionText) {
  const errors = [];
  const decision = squash(decisionText);
  const sorted = new Map();
  for (const line of linesOf(text)) {
    const m = line.match(SORT_RE);
    if (!m) continue;
    const [, id, rawSort, rest] = m;
    const sort = rawSort.toLowerCase();
    if (!ids.includes(id)) { errors.push(`${id} is not an objection of the blind review`); continue; }
    if (sorted.has(id)) { errors.push(`${id} is sorted twice: keep one line`); continue; }
    if (sort !== 'withdrawn') { sorted.set(id, sort); continue; }
    const q = rest.match(QUOTE_RE);
    const quote = squash(q?.[1] ?? q?.[2] ?? '');
    const problem = !quote ? `withdrawn ${id} quotes no text: quote the sourced fact in double quotes`
      : quote.length < MIN_QUOTE_CHARS ? `withdrawn ${id} quotes ${quote.length} characters: quote the entire sourced fact, at least ${MIN_QUOTE_CHARS}`
        : !decision.includes(quote) ? `withdrawn ${id} quotes text the decision file does not hold word for word: "${quote}"`
          : '';
    if (problem) errors.push(problem);
    sorted.set(id, problem ? 'kept' : 'withdrawn');
  }
  for (const id of ids) {
    if (!sorted.has(id)) { errors.push(`${id} is not sorted: mark it withdrawn, kept or downgraded`); sorted.set(id, 'kept'); }
  }
  const tally = (s) => [...sorted.values()].filter((v) => v === s).length;
  const counts = { raised: ids.length, withdrawn: tally('withdrawn'), kept: tally('kept'), downgraded: tally('downgraded') };
  const verdicts = verdictsOf(text);
  if (!verdicts.length) errors.push('no verdict line: end the final file with "Verdict: accept" or "Verdict: reject"');
  if (verdicts.length > 1) errors.push(`${verdicts.length} verdict lines in the final file: keep one`);
  if (verdicts.length === 1 && verdicts[0] === 'reject' && !counts.kept) errors.push('a reject keeps at least one objection');
  if (verdicts.length === 1 && verdicts[0] === 'accept' && counts.kept) errors.push(`an accept keeps no objection, and ${counts.kept} are kept`);
  return { errors, counts };
}

const countsLine = (c) => `raised ${c.raised}, withdrawn ${c.withdrawn}, kept ${c.kept}, downgraded ${c.downgraded}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// =============================================================================
// CLI: every read and write happens here.
// =============================================================================

const readOr = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
// A caller resets a round by writing `{}` to the lock and a blank final file, so neither counts as written.
const written = (text) => (text !== null && text.trim() ? text : null);
const lockOf = (text) => {
  try {
    const lock = text === null ? null : JSON.parse(text);
    return typeof lock?.sha256 === 'string' && lock.sha256 ? lock : null;
  } catch { return null; }
};
const fail = (lines) => ({ lines, code: EXIT.error });

/** The final-file check: its errors, its counts, every objection kept when a file is missing, and whether the final file is written. */
function finalCheck(spec, ids) {
  const stage2 = written(readOr(spec.stage2));
  const decision = readOr(spec.decision);
  const allKept = { raised: ids.length, withdrawn: 0, kept: ids.length, downgraded: 0 };
  if (stage2 === null) return { errors: [`no final file at ${spec.stage2}`], counts: allKept, finalWritten: false };
  if (decision === null) return { errors: [`no decision file at ${spec.decision}`], counts: allKept, finalWritten: true };
  return { ...checkStage2(stage2, ids, decision), finalWritten: true };
}

export function run(argv) {
  // Input
  const verify = argv[0] === '--verify';
  const file = verify ? argv[1] : argv[0];
  if (!file || argv.length !== (verify ? 2 : 1)) return fail([USAGE]);
  const paths = pathsFor(file);
  const specText = readOr(paths.spec);
  if (specText === null) return fail([`no check spec at ${paths.spec}: it is written before the review starts`]);
  const { spec, error } = parseSpec(specText, paths.spec);
  if (error) return fail([error]);
  const review = readOr(file);
  // --verify reports a missing review file through the lock state, so the engine still gets its exit.
  if (review === null && !verify) return fail([`no review file at ${file}`]);
  const lock = lockOf(readOr(paths.lock));

  // Process and output: --verify
  const ids = [...new Set(objectionIds(review ?? ''))];
  if (verify) {
    if (!lock) {
      return { lines: [`no lock at ${paths.lock}: the reviewer never ran the check on ${file}`, countsLine({ raised: ids.length, withdrawn: 0, kept: ids.length, downgraded: 0 })], code: EXIT.noLock };
    }
    const { errors, counts, finalWritten } = finalCheck(spec, ids);
    const lockedVerdict = `locked verdict: ${lock.verdict ?? ''}`;
    if (review === null || lock.sha256 !== sha256(review)) {
      return { lines: [`${file} does not match its lock`, lockedVerdict, countsLine(counts)], code: EXIT.mismatch };
    }
    // With no final file the blind review is the reviewer's only verdict, so the caller is told to read it.
    return { lines: [...errors, ...(finalWritten ? [] : [lockedVerdict]), countsLine(counts)], code: EXIT.ok };
  }

  // Process and output: first run
  if (!lock) {
    const stage1 = checkStage1(review, spec.headings);
    if (stage1.errors.length) return fail(stage1.errors);
    const reveal = readOr(spec.reveal);
    if (reveal === null) return fail([`no reveal text at ${spec.reveal}: it is written before the review starts`]);
    writeFileSync(paths.lock, `${JSON.stringify({ sha256: sha256(review), verdict: stage1.verdict })}\n`);
    return { lines: [reveal.replace(/\s+$/, '')], code: EXIT.ok };
  }

  // Process and output: later runs
  if (lock.sha256 !== sha256(review)) {
    return fail([`${file} changed after it was locked: the blind review is final, so put back its locked text and leave it unchanged`]);
  }
  // The reveal is shown again until the final file is written, so a reviewer that lost it can still go on.
  if (!written(readOr(spec.stage2))) {
    const reveal = readOr(spec.reveal);
    return reveal === null ? fail([`no reveal text at ${spec.reveal}`]) : { lines: [reveal.replace(/\s+$/, '')], code: EXIT.ok };
  }
  const { errors, counts } = finalCheck(spec, ids);
  return errors.length ? fail(errors) : { lines: [countsLine(counts)], code: EXIT.ok };
}

// Node resolves the main module through realpath, so both sides are realpathed, as in plan-block.mjs.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  const { lines, code } = run(process.argv.slice(2));
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(code);
}
