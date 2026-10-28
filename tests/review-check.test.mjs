// tools/review-check.mjs: the staged-review checker a decide reviewer runs on its own blind review, and the
// only copy of the review file format.
//
// The dangerous cases are the ones that would let a reviewer see the decision before its blind judgment is
// fixed, or let a withdrawal through that no sourced fact supports: a lock written for an incomplete file,
// a reveal printed before the lock, a blind review edited after the lock, and a quote the decision file
// does not hold. The format cases pin each error the grammar reports, in both files, and the skeletons the
// tool writes. Each case runs the CLI the way the agents do, against files in its own temp folder.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { GRAMMAR, MIN_QUOTE_CHARS, pathsFor, skeleton } from '../tools/review-check.mjs';

const CLI = join(REPO_ROOT, 'tools/review-check.mjs');
const REVEAL = 'Your blind review is locked. Now read the decision file.';
const FACT = 'p99 latency measured at 41 ms with `wrk -t4 -c64` on the staging host';
const DECISION = `# Decision\n\n## Matrix\n\nThe LRU option: ${FACT.slice(0, 30)}\n${FACT.slice(30)}.\n`;
const BLIND_REJECT = '## Scores\n| c | r |\n## Objections\n- O1: redis beats the winner. Requirement: speed. Evidence: x\n- O2: the winner breaks the p99 must. Requirement: p99. Evidence: y\n## Caveats\nNone.\nVerdict: reject\n';
const BLIND_ACCEPT = '## Scores\n| c | r |\n## Objections\nNone.\n## Caveats\nNone.\nVerdict: accept\n';
// A final file for BLIND_REJECT that passes: O1 kept, O2 downgraded into the one caveat.
const FINAL_KEPT = '## Objections\n- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\n## Caveats\n- C1: O2, downgraded\nVerdict: reject\n';

const roots = [];
/** A run folder with review/, decide/ and locks/, the spec and the reveal written, and the blind file given. */
function fixture(blind) {
  const root = mkdtempSync(join(tmpdir(), 'review-check-'));
  roots.push(root);
  for (const d of ['review', 'decide', 'locks']) mkdirSync(join(root, d));
  const file = join(root, 'review', 'review-r1.md');
  const paths = { file, spec: join(root, 'locks', 'review-r1.json'), final: join(root, 'decide', 'review-r1-final.md'), decision: join(root, 'decide', 'decision-r1.md'), reveal: join(root, 'locks', 'review-r1.reveal.md'), lock: join(root, 'locks', 'review-r1.lock') };
  writeFileSync(paths.spec, JSON.stringify({ stage2: paths.final, decision: paths.decision, reveal: paths.reveal }));
  writeFileSync(paths.reveal, `${REVEAL}\n`);
  writeFileSync(paths.decision, DECISION);
  if (blind !== null) writeFileSync(file, blind);
  return paths;
}

/** The CLI as an agent runs it: `{ out, code }`, never throwing. */
function cli(...argv) {
  try {
    return { out: execFileSync(process.execPath, [CLI, ...argv], { encoding: 'utf8', stdio: 'pipe' }), code: 0 };
  } catch (e) {
    return { out: String(e.stdout || ''), code: e.status ?? 1 };
  }
}
const lastLine = (out) => out.trimEnd().split('\n').pop();
const read = (path) => readFileSync(path, 'utf8');
/** A fixture whose blind review is locked, with `final` written as the final file. */
function locked(blind, final) {
  const p = fixture(blind);
  cli(p.file);
  if (final !== undefined) writeFileSync(p.final, final);
  return p;
}

section('the spec and lock sit in the locks folder beside the review file\'s folder, named by its stem');
{
  const p = pathsFor('E:/r/runs/t/review/review-r3.md');
  eq(p.spec.replace(/\\/g, '/'), 'E:/r/runs/t/locks/review-r3.json', 'spec path');
  eq(p.lock.replace(/\\/g, '/'), 'E:/r/runs/t/locks/review-r3.lock', 'lock path');
}

section('a missing or blank blind review gets its skeleton and the format of each section, and no lock');
{
  for (const [what, blind] of [['a missing file', null], ['a blank file', '\n  \n']]) {
    const p = fixture(blind);
    const { out, code } = cli(p.file);
    eq(code, 0, `${what}: exit 0`);
    eq(read(p.file), skeleton(GRAMMAR.blind), `${what}: the file holds the blind skeleton`);
    ok(out.startsWith(`Wrote the skeleton of ${p.file}.`) && GRAMMAR.blind.every((s) => out.includes(`- ${s.heading}: ${s.shape}.`)) && out.includes('- the last line: `Verdict: accept` or `Verdict: reject`.'),
      `${what}: prints the format of each section and the verdict line: ${out.slice(0, 160)}`);
    ok(!out.includes(REVEAL) && !existsSync(p.lock), `${what}: prints no reveal and writes no lock`);
  }
  const p = fixture(null);
  cli(p.file);
  const unfilled = cli(p.file);
  ok(unfilled.code === 1 && GRAMMAR.blind.every((s) => unfilled.out.includes(`a placeholder is left under "${s.heading}"`)) && unfilled.out.includes('a placeholder is left on the last line'),
    `the unfilled skeleton names each placeholder: ${unfilled.out.slice(0, 200)}`);
  ok(!existsSync(p.lock), 'and is never locked');
  eq(read(p.file), skeleton(GRAMMAR.blind), 'and a second run leaves the skeleton as it was');
  eq(lastLine(cli('--verify', p.file).out), 'raised 0, withdrawn 0, kept 0, downgraded 0, caveats 0', '--verify counts no placeholder as a caveat');
}

section('a missing folder is created for the blind skeleton and the final skeleton');
{
  const p = fixture(null);
  rmSync(dirname(p.file), { recursive: true });
  const blind = cli(p.file);
  ok(blind.code === 0 && read(p.file) === skeleton(GRAMMAR.blind), `the blind skeleton lands in a review folder the tool creates: ${blind.out.slice(0, 160)}`);
  const q = fixture(BLIND_REJECT);
  const final = join(dirname(q.final), 'missing', 'review-r1-final.md');
  writeFileSync(q.spec, JSON.stringify({ stage2: final, decision: q.decision, reveal: q.reveal }));
  const locks = cli(q.file);
  ok(locks.code === 0 && read(final) === skeleton(GRAMMAR.final, ['O1', 'O2']), `the final skeleton lands in a folder the tool creates: ${locks.out.slice(0, 160)}`);
}

section('an incomplete blind review prints its format errors only: no lock, no reveal');
{
  const cases = [
    ['a missing section and no verdict line', '## Scores\n| c |\n## Objections\nNone.\n', ['missing the section "## Caveats"', 'the last line is no verdict line']],
    ['a reject with no objection', BLIND_ACCEPT.replace('Verdict: accept', 'Verdict: reject'), ['a reject needs at least one objection']],
    ['an accept that holds an objection', BLIND_REJECT.replace('Verdict: reject', 'Verdict: accept'), ['an accept holds no objection']],
    ['an objection id used twice', BLIND_REJECT.replace('- O2:', '- O1:'), ['objection id(s) used twice: O1']],
    ['two verdict lines', `${BLIND_REJECT}Verdict: accept\n`, ['1 verdict line(s) above the last line']],
    ['a verdict that is not the last line', `${BLIND_REJECT}Thanks.\n`, ['1 verdict line(s) above the last line', 'the last line is no verdict line']],
    ['sections out of order', BLIND_ACCEPT.replace('## Objections\nNone.\n## Caveats\nNone.\n', '## Caveats\nNone.\n## Objections\nNone.\n'), ['the sections are out of order']],
    ['an empty section', BLIND_ACCEPT.replace('## Caveats\nNone.\n', '## Caveats\n\n'), ['the section "## Caveats" is empty']],
    ['a scores line that is no table row', BLIND_ACCEPT.replace('| c | r |', 'redis wins'), ['a line under "## Scores" matches no allowed shape: "redis wins"']],
    ['an objection line that is no O<n> line', BLIND_REJECT.replace('- O2: the winner', 'The winner'), ['a line under "## Objections" matches no allowed shape: "The winner']],
    ['a caveat line under the objections', BLIND_REJECT.replace('- O2: the winner', '- C1: the winner'), ['an id line sits under "## Objections", outside its own section: "- C1: the winner']],
    ['an objection line in the scores', BLIND_ACCEPT.replace('| c | r |', '| c | r |\n- O1: redis wins'), ['an id line sits under "## Scores", outside its own section', 'Put it under "## Objections"']],
    ['"None." beside an objection', BLIND_REJECT.replace('## Caveats\nNone.', '## Caveats\nNone.\n- C1: the cache may grow'), ['"None." under "## Caveats" stands alone']],
    ['text above the first section', `# Review\n${BLIND_ACCEPT}`, ['text above the first section: "# Review"']],
    ['a heading the format does not hold', BLIND_ACCEPT.replace('## Caveats', '## Notes\nx\n## Caveats'), ['the heading line "## Notes" is no section of this file']],
    ['a section twice', BLIND_ACCEPT.replace('## Caveats\nNone.\n', '## Caveats\nNone.\n## Caveats\nNone.\n'), ['the heading line "## Caveats" appears twice']],
  ];
  for (const [what, text, errors] of cases) {
    const p = fixture(text);
    const { out, code } = cli(p.file);
    eq(code, 1, `${what}: exit 1`);
    ok(errors.every((e) => out.includes(e)), `${what}: names the error: ${out.trim().slice(0, 160)}`);
    ok(!out.includes(REVEAL), `${what}: prints no reveal`);
    ok(!existsSync(p.lock), `${what}: writes no lock`);
  }
}

section('a complete blind review is locked, the final skeleton written and the reveal printed, and printed again until the final file is filled in');
{
  const p = fixture(BLIND_REJECT);
  writeFileSync(p.final, '## Objections\n- O1: kept: from an earlier launch\nVerdict: reject\n');
  const first = cli(p.file);
  eq(first.code, 0, 'exit 0');
  ok(first.out.startsWith(`${REVEAL}\n`) && first.out.includes(`Wrote the skeleton of ${p.final}.`) && GRAMMAR.final.every((s) => first.out.includes(s.heading)),
    `prints the reveal text, then the final file's format: ${first.out.slice(0, 200)}`);
  const lock = JSON.parse(read(p.lock));
  ok(/^[0-9a-f]{64}$/.test(lock.sha256) && lock.verdict === 'reject', `the lock holds the sha256 and the verdict: ${JSON.stringify(lock)}`);
  eq(read(p.final), skeleton(GRAMMAR.final, ['O1', 'O2']), 'the final skeleton replaces any earlier file and holds one sort line per objection');
  ok(read(p.final).includes('- O1: TODO: withdrawn, kept or downgraded.\n- O2: TODO: withdrawn, kept or downgraded.'), 'each sort line waits for its sort word');
  const again = cli(p.file);
  const repeatOut = first.out.replace(`Wrote the skeleton of ${p.final}.`, `The skeleton is already in ${p.final}.`);
  ok(again.code === 0 && repeatOut !== first.out && again.out === repeatOut, `a second run on the unfilled skeleton prints the reveal and the format again, and says it wrote nothing: ${again.out.slice(-400)}`);
  eq(JSON.stringify(JSON.parse(read(p.lock))), JSON.stringify(lock), 'and leaves the lock as it was');
  const v = cli('--verify', p.file);
  ok(v.code === 0 && v.out.includes('locked verdict: reject') && lastLine(v.out) === 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0',
    `--verify reads the unfilled skeleton as no final file: ${v.out.trim()}`);
  writeFileSync(p.final, '');
  ok(cli(p.file).out === first.out && read(p.final) === skeleton(GRAMMAR.final, ['O1', 'O2']), 'a blanked final file gets its skeleton back');
  const accept = locked(BLIND_ACCEPT);
  ok(read(accept.final).startsWith('## Objections\nNone.\n'), 'a blind accept\'s final skeleton holds "None." under its objections');
}

section('a partly filled final skeleton names each placeholder left');
{
  const p = locked(BLIND_REJECT);
  writeFileSync(p.final, read(p.final).replace('- O1: TODO: withdrawn, kept or downgraded.', '- O1: kept: redis scores 7.5 against 6.0'));
  const r = cli(p.file);
  ok(r.code === 1 && r.out.includes('a placeholder is left under "## Objections": replace "- O2: TODO:') && r.out.includes('a placeholder is left under "## Caveats"')
    && r.out.includes('a placeholder is left on the last line') && r.out.includes('O2 is not sorted'), `names each placeholder: ${r.out.trim().slice(0, 240)}`);
}

section('a blind review edited after its lock fails the check, and --verify exits 3 with the locked verdict');
{
  const p = locked(BLIND_REJECT);
  writeFileSync(p.file, BLIND_ACCEPT);
  const later = cli(p.file);
  eq(later.code, 1, 'the later run fails');
  ok(later.out.includes('changed after it was locked'), `and says why: ${later.out.trim()}`);
  const v = cli('--verify', p.file);
  eq(v.code, 3, '--verify exits 3');
  ok(v.out.includes('locked verdict: reject'), 'and prints the locked verdict');
  ok(/^raised \d+, withdrawn \d+, kept \d+, downgraded \d+, caveats \d+$/.test(lastLine(v.out)), `with the counts line last: ${lastLine(v.out)}`);
  rmSync(p.file);
  ok(cli(p.file).out.includes('changed after it was locked'), 'a locked blind review that is gone fails the same way');
}

section('a withdrawal stands only on a quote the decision file holds word for word');
{
  const final = (o1, verdict) => `## Objections\n- ${o1}\n- O2: downgraded: the must holds at the depth the rubric states\n## Caveats\n- C1: O2, downgraded\nVerdict: ${verdict}\n`;
  // The quote spans a line break in the decision file, and curly quotes delimit it.
  const found = locked(BLIND_REJECT, final(`O1: withdrawn \u201c${FACT}\u201d`, 'accept'));
  const okRun = cli(found.file);
  eq(okRun.code, 0, `a found quote passes: ${okRun.out.trim()}`);
  eq(okRun.out.trim(), 'raised 2, withdrawn 1, kept 0, downgraded 1, caveats 1', 'and prints the counts');
  const v = cli('--verify', found.file);
  ok(v.code === 0 && lastLine(v.out) === 'raised 2, withdrawn 1, kept 0, downgraded 1, caveats 1', `--verify exits 0 with the same counts: ${v.out.trim()}`);
  ok(!v.out.includes('locked verdict:'), 'and prints no locked verdict once the final file is written');

  const missing = locked(BLIND_REJECT, final('O1: withdrawn "the decider weighed speed lower than simplicity"', 'accept'));
  const bad = cli(missing.file);
  eq(bad.code, 1, 'a quote the decision file does not hold fails');
  ok(bad.out.includes('withdrawn O1 quotes text the decision file does not hold word for word'), `and names it: ${bad.out.trim()}`);
  ok(bad.out.includes('an accept keeps no objection, and 1 are kept'), 'and the accept that now keeps it');
  const vBad = cli('--verify', missing.file);
  eq(vBad.code, 0, '--verify still exits 0 on a matching lock');
  eq(lastLine(vBad.out), 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1', 'and counts the unfound withdrawal as kept');

  const short = locked(BLIND_REJECT, final('O1: withdrawn "41 ms"', 'accept'));
  ok(cli(short.file).out.includes(`quote the entire sourced fact, at least ${MIN_QUOTE_CHARS}`), 'a quote too short to prove anything fails');
}

section('the final file sorts every objection once, by its grammar, and its verdict agrees with what it keeps');
{
  const caveats = '## Caveats\nNone.\n';
  const cases = [
    ['an unsorted objection', `## Objections\n- O1: kept: still stands\n${caveats}Verdict: reject\n`, 'O2 is not sorted'],
    ['an unknown id', `## Objections\n- O1: kept: x\n- O2: kept: y\n- O3: kept: z\n${caveats}Verdict: reject\n`, 'O3 is not an objection of the blind review'],
    ['an objection sorted twice', `## Objections\n- O1: kept: x\n- O1: downgraded: y\n- O2: kept: z\n## Caveats\n- C1: y\nVerdict: reject\n`, 'O1 is sorted twice'],
    ['a reject that keeps nothing', `## Objections\n- O1: downgraded: x\n- O2: downgraded: y\n## Caveats\n- C1: x\n- C2: y\nVerdict: reject\n`, 'a reject keeps at least one objection'],
    ['no verdict line', `## Objections\n- O1: kept: x\n- O2: kept: y\n${caveats}`, 'the last line is no verdict line'],
    ['a sort line with no sort word', `## Objections\n- O1: kept: x\n- O2: the p99 must still fails\n${caveats}Verdict: reject\n`, 'a line under "## Objections" matches no allowed shape: "- O2: the p99 must still fails"'],
    ['a missing section', `## Objections\n- O1: kept: x\n- O2: kept: y\nVerdict: reject\n`, 'missing the section "## Caveats"'],
    ['sections out of order', `${caveats}## Objections\n- O1: kept: x\n- O2: kept: y\nVerdict: reject\n`, 'the sections are out of order'],
    ['an empty caveats section', `## Objections\n- O1: kept: x\n- O2: kept: y\n## Caveats\nVerdict: reject\n`, 'the section "## Caveats" is empty'],
    ['a WHERE NEXT above the caveats', `## Objections\n- O1: kept: x\n- O2: kept: y\n## WHERE NEXT\nmore evidence\n${caveats}Verdict: reject\n`, 'the sections are out of order'],
    ['a verdict above the WHERE NEXT', `## Objections\n- O1: kept: x\n- O2: kept: y\n${caveats}Verdict: reject\n## WHERE NEXT\nmore evidence\n`, 'the last line is no verdict line'],
  ];
  for (const [what, text, error] of cases) {
    const r = cli(locked(BLIND_REJECT, text).file);
    ok(r.code === 1 && r.out.includes(error), `${what}: fails naming it: ${r.out.trim().slice(0, 160)}`);
  }
  const r = cli(locked(BLIND_REJECT, FINAL_KEPT).file);
  ok(r.code === 0 && r.out.trim() === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1', `a reject that keeps one passes: ${r.out.trim()}`);
  const where = cli(locked(BLIND_REJECT, FINAL_KEPT.replace('Verdict: reject', '\n## WHERE NEXT\nAnother revision could answer O1.\nVerdict: reject')).file);
  ok(where.code === 0, `an optional WHERE NEXT section just above the verdict line passes: ${where.out.trim()}`);
  const idProse = cli(locked(BLIND_REJECT, FINAL_KEPT.replace('Verdict: reject', '\n## WHERE NEXT\n- O1: rests on evidence another revision could answer\nVerdict: reject')).file);
  ok(idProse.code === 0 && idProse.out.trim() === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1',
    `an id-shaped line in the WHERE NEXT prose is no misplaced item and counts nowhere: ${idProse.out.trim()}`);
}

section('a line counts by its section: an id line outside its own section is a format error and counts nowhere else');
{
  const blindCases = [
    ['an objection line under the caveats of an accept', BLIND_ACCEPT.replace('## Caveats\nNone.', '## Caveats\n- O1: redis beats the winner'), 'an id line sits under "## Caveats", outside its own section: "- O1: redis beats the winner"'],
    ['a prose line under the caveats', BLIND_ACCEPT.replace('## Caveats\nNone.', '## Caveats\nThe cache may grow.'), 'a line under "## Caveats" matches no allowed shape: "The cache may grow."'],
  ];
  for (const [what, text, error] of blindCases) {
    const p = fixture(text);
    const { out, code } = cli(p.file);
    ok(code === 1 && out.includes(error), `${what}: a format error that quotes the line: ${out.trim().slice(0, 160)}`);
    ok(!out.includes('an accept holds no objection'), `${what}: the line is no objection of the accept`);
    ok(!existsSync(p.lock), `${what}: writes no lock`);
  }
  const p = locked(BLIND_REJECT, FINAL_KEPT.replace('- C1: O2, downgraded', '- C1: O2, downgraded\n- O1: kept: the p99 must fails'));
  const r = cli(p.file);
  ok(r.code === 1 && r.out.includes('an id line sits under "## Caveats", outside its own section'), `the final file: an objection line under the caveats is a format error: ${r.out.trim().slice(0, 160)}`);
  ok(!r.out.includes('O1 is sorted twice'), 'and is no second sort of O1');
  writeFileSync(p.final, '- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\nVerdict: reject\n');
  const bare = cli(p.file);
  ok(bare.code === 1 && bare.out.includes('text above the first section') && bare.out.includes('missing the section "## Objections"') && bare.out.includes('missing the section "## Caveats"') && bare.out.includes('O1 is not sorted'),
    `a final file with no headings names both and sorts nothing: ${bare.out.trim().slice(0, 200)}`);
}

section('the counts line counts the caveats of the final file once it is written, and of the blind review before');
{
  const blind = BLIND_REJECT.replace('## Caveats\nNone.', '## Caveats\n- C1: the cache may grow. Evidence: x\n- C2: the docs lag. Evidence: y');
  const p = fixture(blind);
  eq(lastLine(cli('--verify', p.file).out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 2', 'no lock: the blind review\'s caveats');
  eq(cli(p.file).code, 0, 'a blind review with caveat lines locks');
  eq(lastLine(cli('--verify', p.file).out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 2', 'no final file: the blind review\'s caveats');
  const sorts = '## Objections\n- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\n';
  writeFileSync(p.final, `${sorts}## Caveats\n- C1: the cache may grow\n- C2: the docs lag\n- C3: O2, downgraded\n\n## WHERE NEXT\nAnother revision could answer O1.\nVerdict: reject\n`);
  const r = cli(p.file);
  ok(r.code === 0 && r.out.trim() === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 3', `the final file's caveats, ended by the next heading: ${r.out.trim()}`);
  eq(lastLine(cli('--verify', p.file).out), 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 3', '--verify counts the same caveats');
  writeFileSync(p.final, `${sorts}## Caveats\nThe cache may grow.\nVerdict: reject\n`);
  const prose = cli('--verify', p.file);
  ok(prose.code === 0 && prose.out.includes('matches no allowed shape') && lastLine(prose.out) === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1',
    `--verify counts a prose caveat line beside its format error: ${prose.out.trim().slice(-160)}`);
  writeFileSync(p.final, `${sorts}Verdict: reject\n`);
  const headless = cli('--verify', p.file);
  ok(headless.out.includes('missing the section "## Caveats"') && lastLine(headless.out) === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 3',
    `a final file with no caveats section counts the blind review's caveats and the downgraded objection: ${headless.out.trim().slice(-160)}`);
}

section('the final file\'s caveats hold at least one line per downgraded objection');
{
  const p = locked(BLIND_REJECT, FINAL_KEPT.replace('- C1: O2, downgraded', 'None.'));
  const r = cli(p.file);
  ok(r.code === 1 && r.out.includes('"## Caveats" holds 0 caveat(s), fewer than the 1 downgraded objection(s): put each downgraded objection under "## Caveats" as a "- C<n>:" line'),
    `"None." beside a downgraded objection fails naming both counts: ${r.out.trim()}`);
  const v = cli('--verify', p.file);
  ok(v.code === 0 && lastLine(v.out) === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1', `--verify never drops the downgraded objection: ${v.out.trim()}`);
  const merged = cli(locked(BLIND_REJECT.replace('## Caveats\nNone.', '## Caveats\n- C1: no breach on the default path. Evidence: y'), FINAL_KEPT).file);
  ok(merged.code === 0 && merged.out.trim() === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1', `a downgraded objection merged into a blind caveat passes: ${merged.out.trim()}`);
}

section('--verify exits 2 with no lock, and counts every objection kept');
{
  const p = fixture(BLIND_REJECT);
  const v = cli('--verify', p.file);
  eq(v.code, 2, 'exit 2');
  ok(v.out.includes('no lock at'), `names the missing lock: ${v.out.trim()}`);
  eq(lastLine(v.out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0', 'with the counts line last');
  const clean = cli('--verify', locked(BLIND_ACCEPT).file);
  ok(clean.code === 0 && lastLine(clean.out) === 'raised 0, withdrawn 0, kept 0, downgraded 0, caveats 0', `a locked accept with no final file verifies clean: ${clean.out.trim()}`);
  ok(clean.out.includes('locked verdict: accept'), 'and prints the locked verdict, since the blind review is the only one written');
}

section('a reset lock and a blank final file count as unwritten, so an earlier launch never stands in for a round');
{
  // An earlier launch of the same run left a lock and a final file. The check agent resets both.
  const p = fixture(BLIND_REJECT);
  writeFileSync(p.lock, '{}');
  writeFileSync(p.final, '');
  const v = cli('--verify', p.file);
  eq(v.code, 2, `--verify reads a reset lock as no lock: ${v.out.trim()}`);
  const first = cli(p.file);
  ok(first.code === 0 && first.out.startsWith(REVEAL), 'the first run locks the new blind review and prints the reveal');
  ok(JSON.parse(read(p.lock)).sha256, 'and writes a real lock over the reset one');
  const vBlank = cli('--verify', p.file);
  ok(vBlank.code === 0 && lastLine(vBlank.out) === 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0', `--verify counts every objection kept: ${vBlank.out.trim()}`);
  ok(vBlank.out.includes('locked verdict: reject'), 'and prints the locked verdict for an unfilled final file');
  const garbled = fixture(BLIND_REJECT);
  writeFileSync(garbled.lock, 'not json');
  eq(cli('--verify', garbled.file).code, 2, 'a lock that is not JSON reads as no lock');
}

section('--verify reports a missing review file through the lock state');
{
  const unlocked = fixture(null);
  eq(cli('--verify', unlocked.file).code, 2, 'no review file and no lock: exit 2');
  ok(!existsSync(unlocked.file), 'and --verify writes no skeleton');
  const lockedGone = locked(BLIND_REJECT);
  rmSync(lockedGone.file);
  const v = cli('--verify', lockedGone.file);
  ok(v.code === 3 && v.out.includes('locked verdict: reject'), `a locked review file that is gone is a mismatch: ${v.out.trim()}`);
}

section('a missing spec, a bad spec or a bad argument fails loudly');
{
  const p = fixture(BLIND_REJECT);
  rmSync(p.spec);
  const noSpec = cli(p.file);
  ok(noSpec.code === 1 && noSpec.out.includes('no check spec at'), `no spec: ${noSpec.out.trim()}`);
  for (const argv of [[], ['--verify'], ['a.md', 'b.md']]) {
    const u = cli(...argv);
    ok(u.code === 1 && u.out.includes('usage:'), `argv ${JSON.stringify(argv)} prints the usage`);
  }
  const badSpec = fixture(BLIND_REJECT);
  writeFileSync(badSpec.spec, '{}');
  const bad = cli(badSpec.file);
  ok(bad.code === 1 && bad.out.includes('needs the file paths "stage2", "decision", "reveal"') && !existsSync(badSpec.lock), `a spec with no paths fails naming them: ${bad.out.trim()}`);
}

section('a missing reveal text leaves no lock, and a missing decision file keeps every objection');
{
  // The lock is written only after the reveal is read, so a reviewer is never locked without seeing it.
  const noReveal = fixture(BLIND_REJECT);
  rmSync(noReveal.reveal);
  const first = cli(noReveal.file);
  ok(first.code === 1 && first.out.includes(`no reveal text at ${noReveal.reveal}`), `the first run names the missing reveal: ${first.out.trim()}`);
  ok(!existsSync(noReveal.lock), 'and writes no lock');
  const lostReveal = locked(BLIND_REJECT);
  rmSync(lostReveal.reveal);
  const later = cli(lostReveal.file);
  ok(later.code === 1 && later.out.includes(`no reveal text at ${lostReveal.reveal}`), `a later run with no final file names the missing reveal: ${later.out.trim()}`);

  const noDecision = locked(BLIND_REJECT, `## Objections\n- O1: withdrawn "${FACT}"\n- O2: kept: the p99 must fails\n## Caveats\nNone.\nVerdict: reject\n`);
  rmSync(noDecision.decision);
  const r = cli(noDecision.file);
  ok(r.code === 1 && r.out.includes(`no decision file at ${noDecision.decision}`), `a later run names the missing decision file: ${r.out.trim()}`);
  const v = cli('--verify', noDecision.file);
  ok(v.code === 0 && v.out.includes('no decision file at'), `--verify exits 0 on a matching lock and names the missing file: ${v.out.trim()}`);
  eq(lastLine(v.out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0', 'and counts every objection kept');
  ok(!v.out.includes('locked verdict:'), 'and prints no locked verdict, since the final file is written');
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
