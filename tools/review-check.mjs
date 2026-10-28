// tools/review-check.mjs: the staged-review checker and the only copy of the review file format. A reviewer
// agent runs it on its own review file, and an engine's check agent runs it with --verify after the reviewer returns.
//
//   node tools/review-check.mjs <review.md>            # no file: write its skeleton. Then format check, lock + reveal. Later: the final-file check
//   node tools/review-check.mjs --verify <review.md>   # lock state and counts. Exit 0 match, 2 no lock, 3 mismatch.
//                                                      # The locked verdict prints on 3, and on 0 with no final file
//
// tools/CLAUDE.md holds the commands, the spec and the lock. GRAMMAR below holds the file formats.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXIT = { ok: 0, error: 1, noLock: 2, mismatch: 3 };
const USAGE = 'usage: node review-check.mjs [--verify] <review file>';
const VERDICT_RE = /^Verdict:[ \t]*(accept|reject)[ \t]*$/i;
const VERDICT_SHAPE = '`Verdict: accept` or `Verdict: reject`';
const HEADING_RE = /^##(?:[ \t]|$)/;
const ITEM_RE = /^[-*][ \t]+([OC])(\d+)[ \t]*:/;
const NONE_RE = /^None\.?$/i;
const SORT_RE = /^[-*][ \t]+(O\d+)[ \t]*:[ \t]*(withdrawn|kept|downgraded)\b(.*)$/i;
const QUOTE_RE = /"([^"]+)"|“([^”]+)”/;
// A short quote matches nearly any decision file, so it proves no fact answers the objection.
export const MIN_QUOTE_CHARS = 20;
// Each placeholder fails the check, so a skeleton never locks and never counts as a written final file.
const TODO = 'TODO: replace this line.';
const SORT_TODO = 'TODO: withdrawn, kept or downgraded.';
const VERDICT_TODO = 'Verdict: TODO: accept or reject.';
const OBJECTIONS = '## Objections';
const CAVEATS = '## Caveats';

/**
 * The review file format. Each file's sections run in this order, each under its heading line, and the
 * verdict line is the file's last non-blank line. A list or sort section holds its id lines or `None.` alone,
 * an id line sits in no list, sort or table section but the one whose `id` it carries, and a text section holds any prose.
 */
export const GRAMMAR = {
  blind: [
    { heading: '## Scores', kind: 'table', shape: 'a table of every candidate against every requirement, each cell with its evidence, and each candidate\'s weighted total. Every line is a table row that starts with "|"' },
    { heading: OBJECTIONS, kind: 'list', id: 'O', shape: 'one line per objection, `- O<n>: <the objection>. Requirement: <the requirement>. Evidence: <the evidence>`, numbered from O1, or `None.` when there is none' },
    { heading: CAVEATS, kind: 'list', id: 'C', shape: 'one line per caveat, `- C<n>: <the caveat>. Evidence: <the evidence>`, numbered from C1, or `None.` when there is none' },
  ],
  final: [
    { heading: OBJECTIONS, kind: 'sort', id: 'O', shape: 'one line per objection of the blind review, `- O<n>: withdrawn "<the quoted fact>"`, `- O<n>: kept: <the objection and its evidence>` or `- O<n>: downgraded: <why>`, or `None.` when the blind review holds none' },
    { heading: CAVEATS, kind: 'list', id: 'C', shape: 'every caveat, the blind review\'s and one per downgraded objection, one line each, `- C<n>: <the caveat>`, numbered from C1, or `None.` when there is none' },
    { heading: '## WHERE NEXT', kind: 'text', optional: true, shape: 'prose, only when the reveal text asks for this section' },
  ],
};

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
  const missing = ['stage2', 'decision', 'reveal'].filter((k) => typeof spec?.[k] !== 'string' || !spec[k].trim());
  if (missing.length) return { error: `the check spec ${path} needs the file paths ${missing.map((k) => `"${k}"`).join(', ')}` };
  return { spec };
}

const linesOf = (text) => String(text).split(/\r?\n/);
const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
const clip = (line) => line.slice(0, 80);
const isPlaceholder = (line) => line === TODO || line === VERDICT_TODO || (ITEM_RE.test(line) && line.endsWith(SORT_TODO));

/** The skeleton of a file: each required heading over a placeholder, the sort lines of `ids`, and the verdict placeholder. */
export function skeleton(grammar, ids = []) {
  const lines = [];
  for (const section of grammar.filter((s) => !s.optional)) {
    const sortLines = ids.length ? ids.map((id) => `- ${id}: ${SORT_TODO}`) : ['None.'];
    lines.push(section.heading, ...(section.kind === 'sort' ? sortLines : [TODO]), '');
  }
  return `${[...lines, VERDICT_TODO].join('\n')}\n`;
}

/** What the tool prints beside a skeleton: the file, whether this run wrote it, and the format of each section. */
const formatLines = (file, grammar, wrote) => [
  `${wrote ? 'Wrote the skeleton of' : 'The skeleton is already in'} ${file}. Replace each line that holds "TODO:" with the Write or Edit tool, then run this command again. Keep this format, in this order:`,
  ...grammar.map((s) => `- ${s.heading}${s.optional ? ' (optional)' : ''}: ${s.shape}.`),
  `- the last line: ${VERDICT_SHAPE}.`,
];

/** Whether a line fits its section's shape, placeholders and id lines of other sections aside. */
function fitsShape(section, line) {
  if (section.kind === 'table') return line.startsWith('|');
  if (section.kind === 'text') return true;
  if (NONE_RE.test(line)) return true;
  return section.kind === 'sort' ? SORT_RE.test(line) : line.match(ITEM_RE)?.[1] === section.id;
}

/** The format errors of one section's non-blank lines. */
function sectionErrors(section, lines, owners) {
  const where = `under "${section.heading}"`;
  if (!lines.length) return [`the section "${section.heading}" is empty: it holds ${section.shape}`];
  const errors = [];
  for (const line of lines) {
    // A text section is free prose, so an id-shaped line there is a sentence, not a misplaced item.
    const owner = section.kind === 'text' ? undefined : owners[line.match(ITEM_RE)?.[1]];
    if (isPlaceholder(line)) errors.push(`a placeholder is left ${where}: replace "${clip(line)}" with ${section.shape}`);
    else if (owner && owner !== section.heading) errors.push(`an id line sits ${where}, outside its own section: "${clip(line)}". Put it under "${owner}"`);
    else if (!fitsShape(section, line)) errors.push(`a line ${where} matches no allowed shape: "${clip(line)}". The section holds ${section.shape}`);
  }
  if (section.kind !== 'table' && section.kind !== 'text' && lines.length > 1 && lines.some((l) => NONE_RE.test(l))) {
    errors.push(`"None." ${where} stands alone: drop it, or drop the other lines`);
  }
  return errors;
}

/** A file read by its grammar: its format errors, its verdict ('' when the last line is none) and each section's non-blank lines. */
function parseFile(text, grammar) {
  // Input
  const lines = linesOf(text).map((l) => l.trim());
  const lastIndex = lines.findLastIndex(Boolean);
  const last = lastIndex < 0 ? '' : lines[lastIndex];
  const verdict = last.match(VERDICT_RE)?.[1]?.toLowerCase() ?? '';
  const body = verdict || last === VERDICT_TODO ? lines.slice(0, lastIndex) : lines;
  const known = grammar.map((s) => s.heading);
  const owners = Object.fromEntries(grammar.filter((s) => s.id).map((s) => [s.id, s.heading]));
  const sections = new Map();
  const above = [];
  const errors = [];
  let strayVerdicts = 0;
  let current = null;

  // Process: split the body into sections
  for (const line of body) {
    if (VERDICT_RE.test(line)) { strayVerdicts++; continue; }
    if (HEADING_RE.test(line)) {
      if (sections.has(line)) errors.push(`the heading line "${line}" appears twice: keep one section under it`);
      else sections.set(line, []);
      current = line;
      continue;
    }
    if (!line) continue;
    if (current === null) above.push(line);
    else sections.get(current).push(line);
  }

  // Process: check the sections against the grammar
  if (above.length) errors.push(`text above the first section: "${clip(above[0])}". Start the file with the heading line "${known[0]}"`);
  const present = [...sections.keys()];
  for (const heading of present.filter((h) => !known.includes(h))) {
    errors.push(`the heading line "${heading}" is no section of this file, whose sections are ${known.map((h) => `"${h}"`).join(', ')}`);
  }
  const ordered = present.filter((h) => known.includes(h)).map((h) => known.indexOf(h));
  if (ordered.some((n, i) => i > 0 && n < ordered[i - 1])) errors.push(`the sections are out of order: put them in this order, ${known.map((h) => `"${h}"`).join(', ')}`);
  for (const section of grammar) {
    if (sections.has(section.heading)) errors.push(...sectionErrors(section, sections.get(section.heading), owners));
    else if (!section.optional) errors.push(`missing the section "${section.heading}": it holds ${section.shape}`);
  }
  if (!verdict) {
    errors.push(last === VERDICT_TODO ? `a placeholder is left on the last line: replace "${VERDICT_TODO}" with ${VERDICT_SHAPE}` : `the last line is no verdict line: end the file with ${VERDICT_SHAPE}`);
  }
  if (strayVerdicts) errors.push(`${strayVerdicts} verdict line(s) above the last line: keep one verdict line, the file's last`);

  // Output
  return { errors, verdict, sections };
}

/** The ids of the `- <id><n>:` lines of a section, in file order, duplicates included. */
const itemIds = (lines, id) => (lines ?? []).map((l) => l.match(ITEM_RE)).filter((m) => m?.[1] === id).map((m) => `${m[1]}${m[2]}`);

/** The caveat count of a caveats section, null when the file lacks it. A malformed line still counts, so a format error never drops a caveat. */
const caveatCount = (lines) => (lines === undefined ? null : lines.filter((l) => !NONE_RE.test(l) && !isPlaceholder(l)).length);

/** The blind review's format errors, its objection ids, its verdict and its caveat count. */
function checkStage1(text) {
  const parsed = parseFile(text, GRAMMAR.blind);
  const errors = [...parsed.errors];
  const ids = itemIds(parsed.sections.get(OBJECTIONS), 'O');
  const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (dupes.length) errors.push(`objection id(s) used twice: ${dupes.join(', ')}. Give each objection its own O<n>`);
  if (parsed.verdict === 'reject' && !ids.length) errors.push('a reject needs at least one objection line "- O<n>: ..."');
  if (parsed.verdict === 'accept' && ids.length) errors.push('an accept holds no objection: reject, or make each concern that is not an objection a caveat');
  return { errors, ids: [...new Set(ids)], verdict: parsed.verdict, caveats: caveatCount(parsed.sections.get(CAVEATS)) };
}

/**
 * The final file checked against the blind review's objection ids and the decision file. Counts treat an
 * unsorted objection, and a withdrawal whose quote is missing or not found, as kept.
 */
function checkStage2(text, ids, decisionText, blindCaveats) {
  const parsed = parseFile(text, GRAMMAR.final);
  const errors = [...parsed.errors];
  const decision = squash(decisionText);
  const sorted = new Map();
  for (const line of parsed.sections.get(OBJECTIONS) ?? []) {
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
  const downgraded = tally('downgraded');
  const listed = caveatCount(parsed.sections.get(CAVEATS));
  // A downgraded objection may merge into a blind caveat, so only the downgraded tally bounds the section.
  if (listed !== null && listed < downgraded) {
    errors.push(`"${CAVEATS}" holds ${listed} caveat(s), fewer than the ${downgraded} downgraded objection(s): put each downgraded objection under "${CAVEATS}" as a "- C<n>:" line`);
  }
  // A final file with no caveats section still owes the blind review's caveats and each downgraded objection.
  const caveats = listed === null ? blindCaveats + downgraded : Math.max(listed, downgraded);
  const counts = { raised: ids.length, withdrawn: tally('withdrawn'), kept: tally('kept'), downgraded, caveats };
  if (parsed.verdict === 'reject' && !counts.kept) errors.push('a reject keeps at least one objection');
  if (parsed.verdict === 'accept' && counts.kept) errors.push(`an accept keeps no objection, and ${counts.kept} are kept`);
  return { errors, counts };
}

const countsLine = (c) => `raised ${c.raised}, withdrawn ${c.withdrawn}, kept ${c.kept}, downgraded ${c.downgraded}, caveats ${c.caveats}`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// =============================================================================
// CLI: every read and write happens here.
// =============================================================================

const readOr = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
// A caller resets a round by writing `{}` to the lock and a blank blind and final file, so none counts as written.
const written = (text) => (text !== null && text.trim() ? text : null);
const lockOf = (text) => {
  try {
    const lock = text === null ? null : JSON.parse(text);
    return typeof lock?.sha256 === 'string' && lock.sha256 ? lock : null;
  } catch { return null; }
};
const fail = (lines) => ({ lines, code: EXIT.error });
const writeFile = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };

/** The final file's text once the reviewer has written it: null while it is blank or still its skeleton. */
const finalText = (path, ids) => {
  const text = written(readOr(path));
  return text === null || squash(text) === squash(skeleton(GRAMMAR.final, ids)) ? null : text;
};

/** Every objection kept, with the caveat count of the file that stands. */
const allKept = (ids, caveats) => ({ raised: ids.length, withdrawn: 0, kept: ids.length, downgraded: 0, caveats });

/**
 * The final-file check: its errors, its counts, every objection kept when a file is missing, and whether the
 * final file is written. The caveats come from the final file once it is written, else from the blind review.
 */
function finalCheck(spec, ids, blindCaveats) {
  const stage2 = finalText(spec.stage2, ids);
  const decision = readOr(spec.decision);
  if (stage2 === null) return { errors: [`no final file written at ${spec.stage2}`], counts: allKept(ids, blindCaveats), finalWritten: false };
  if (decision === null) {
    const caveats = caveatCount(parseFile(stage2, GRAMMAR.final).sections.get(CAVEATS)) ?? blindCaveats;
    return { errors: [`no decision file at ${spec.decision}`], counts: allKept(ids, caveats), finalWritten: true };
  }
  return { ...checkStage2(stage2, ids, decision, blindCaveats), finalWritten: true };
}

/** The reveal text and the final file's format, or an error when the reveal text is missing. */
const revealLines = (spec, wrote) => {
  const reveal = readOr(spec.reveal);
  return reveal === null ? null : [reveal.replace(/\s+$/, ''), '', ...formatLines(spec.stage2, GRAMMAR.final, wrote)];
};

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
  const lock = lockOf(readOr(paths.lock));
  const stage1 = checkStage1(review ?? '');
  const blindCaveats = stage1.caveats ?? 0;

  // Process and output: --verify. A missing review file is reported through the lock state, so the engine still gets its exit.
  if (verify) {
    if (!lock) {
      return { lines: [`no lock at ${paths.lock}: the reviewer never ran the check on ${file}`, countsLine(allKept(stage1.ids, blindCaveats))], code: EXIT.noLock };
    }
    const { errors, counts, finalWritten } = finalCheck(spec, stage1.ids, blindCaveats);
    const lockedVerdict = `locked verdict: ${lock.verdict ?? ''}`;
    if (review === null || lock.sha256 !== sha256(review)) {
      return { lines: [`${file} does not match its lock`, lockedVerdict, countsLine(counts)], code: EXIT.mismatch };
    }
    // With no final file the blind review is the reviewer's only verdict, so the caller is told to read it.
    return { lines: [...errors, ...(finalWritten ? [] : [lockedVerdict]), countsLine(counts)], code: EXIT.ok };
  }

  // Process and output: first run. A blank or missing blind file gets its skeleton, and a complete one is locked.
  if (!lock) {
    if (written(review) === null) {
      writeFile(file, skeleton(GRAMMAR.blind));
      return { lines: formatLines(file, GRAMMAR.blind, true), code: EXIT.ok };
    }
    if (stage1.errors.length) return fail(stage1.errors);
    const reveal = revealLines(spec, true);
    if (reveal === null) return fail([`no reveal text at ${spec.reveal}: it is written before the review starts`]);
    // A final file written before the lock cannot hold this review's sorting, so its skeleton replaces it.
    writeFile(spec.stage2, skeleton(GRAMMAR.final, stage1.ids));
    writeFile(paths.lock, `${JSON.stringify({ sha256: sha256(review), verdict: stage1.verdict })}\n`);
    return { lines: reveal, code: EXIT.ok };
  }

  // Process and output: later runs
  if (review === null || lock.sha256 !== sha256(review)) {
    return fail([`${file} changed after it was locked: the blind review is final, so put back its locked text and leave it unchanged`]);
  }
  // The reveal is shown again until the final file is written, so a reviewer that lost it can still go on.
  if (finalText(spec.stage2, stage1.ids) === null) {
    const blankFinal = written(readOr(spec.stage2)) === null;
    const reveal = revealLines(spec, blankFinal);
    if (reveal === null) return fail([`no reveal text at ${spec.reveal}`]);
    if (blankFinal) writeFile(spec.stage2, skeleton(GRAMMAR.final, stage1.ids));
    return { lines: reveal, code: EXIT.ok };
  }
  const { errors, counts } = finalCheck(spec, stage1.ids, blindCaveats);
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
