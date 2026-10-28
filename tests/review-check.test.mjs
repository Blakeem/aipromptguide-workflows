// tools/review-check.mjs: the staged-review checker a decide reviewer runs on its own blind review.
//
// The dangerous cases are the ones that would let a reviewer see the decision before its blind judgment is
// fixed, or let a withdrawal through that no sourced fact supports: a lock written for an incomplete file,
// a reveal printed before the lock, a blind review edited after the lock, and a quote the decision file
// does not hold. Each case runs the CLI the way the agents do, against files in its own temp folder.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, section, ok, eq } from './harness.mjs';
import { MIN_QUOTE_CHARS, pathsFor } from '../tools/review-check.mjs';

const CLI = join(REPO_ROOT, 'tools/review-check.mjs');
const REVEAL = 'Your blind review is locked. Now read the decision file.';
const FACT = 'p99 latency measured at 41 ms with `wrk -t4 -c64` on the staging host';
const DECISION = `# Decision\n\n## Matrix\n\nThe LRU option: ${FACT.slice(0, 30)}\n${FACT.slice(30)}.\n`;
const BLIND_REJECT = '## Scores\n| c | r |\n## Objections\n- O1: redis beats the winner. Requirement: speed. Evidence: x\n- O2: the winner breaks the p99 must. Requirement: p99. Evidence: y\n## Caveats\nNone.\nVerdict: reject\n';
const BLIND_ACCEPT = '## Scores\n| c | r |\n## Objections\nNone.\n## Caveats\nNone.\nVerdict: accept\n';

const roots = [];
/** A run folder with review/, decide/ and locks/, the spec and the reveal written, and the blind file given. */
function fixture(blind) {
  const root = mkdtempSync(join(tmpdir(), 'review-check-'));
  roots.push(root);
  for (const d of ['review', 'decide', 'locks']) mkdirSync(join(root, d));
  const file = join(root, 'review', 'review-r1.md');
  const paths = { file, final: join(root, 'decide', 'review-r1-final.md'), decision: join(root, 'decide', 'decision-r1.md'), reveal: join(root, 'locks', 'review-r1.reveal.md'), lock: join(root, 'locks', 'review-r1.lock') };
  writeFileSync(join(root, 'locks', 'review-r1.json'), JSON.stringify({ headings: ['## Scores', '## Objections', '## Caveats'], stage2: paths.final, decision: paths.decision, reveal: paths.reveal }));
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

section('the spec and lock sit in the locks folder beside the review file\'s folder, named by its stem');
{
  const p = pathsFor('E:/r/runs/t/review/review-r3.md');
  eq(p.spec.replace(/\\/g, '/'), 'E:/r/runs/t/locks/review-r3.json', 'spec path');
  eq(p.lock.replace(/\\/g, '/'), 'E:/r/runs/t/locks/review-r3.lock', 'lock path');
}

section('an incomplete blind review prints its format errors only: no lock, no reveal');
{
  const cases = [
    ['a missing heading and no verdict line', '## Scores\n## Objections\nNone.\n', ['missing the heading line "## Caveats"', 'no verdict line']],
    ['a reject with no objection', BLIND_ACCEPT.replace('Verdict: accept', 'Verdict: reject'), ['a reject needs at least one objection']],
    ['an accept that holds an objection', BLIND_REJECT.replace('Verdict: reject', 'Verdict: accept'), ['an accept holds no objection']],
    ['an objection id used twice', BLIND_REJECT.replace('- O2:', '- O1:'), ['objection id(s) used twice: O1']],
    ['two verdict lines', `${BLIND_REJECT}Verdict: accept\n`, ['2 verdict lines']],
  ];
  for (const [what, text, errors] of cases) {
    const p = fixture(text);
    const { out, code } = cli(p.file);
    eq(code, 1, `${what}: exit 1`);
    ok(errors.every((e) => out.includes(e)), `${what}: names the error: ${out.trim().slice(0, 120)}`);
    ok(!out.includes(REVEAL), `${what}: prints no reveal`);
    ok(!existsSync(p.lock), `${what}: writes no lock`);
  }
}

section('a complete blind review is locked and the reveal printed, and printed again until the final file exists');
{
  const p = fixture(BLIND_REJECT);
  const first = cli(p.file);
  eq(first.code, 0, 'exit 0');
  eq(first.out.trim(), REVEAL, 'prints the reveal text only');
  const lock = JSON.parse(readFileSync(p.lock, 'utf8'));
  ok(/^[0-9a-f]{64}$/.test(lock.sha256) && lock.verdict === 'reject', `the lock holds the sha256 and the verdict: ${JSON.stringify(lock)}`);
  const again = cli(p.file);
  ok(again.code === 0 && again.out.trim() === REVEAL, 'a second run before the final file exists prints the reveal again');
  eq(JSON.stringify(JSON.parse(readFileSync(p.lock, 'utf8'))), JSON.stringify(lock), 'and leaves the lock as it was');
}

section('a blind review edited after its lock fails the check, and --verify exits 3 with the locked verdict');
{
  const p = fixture(BLIND_REJECT);
  cli(p.file);
  writeFileSync(p.file, BLIND_ACCEPT);
  const later = cli(p.file);
  eq(later.code, 1, 'the later run fails');
  ok(later.out.includes('changed after it was locked'), `and says why: ${later.out.trim()}`);
  const v = cli('--verify', p.file);
  eq(v.code, 3, '--verify exits 3');
  ok(v.out.includes('locked verdict: reject'), 'and prints the locked verdict');
  ok(/^raised \d+, withdrawn \d+, kept \d+, downgraded \d+, caveats \d+$/.test(lastLine(v.out)), `with the counts line last: ${lastLine(v.out)}`);
}

section('a withdrawal stands only on a quote the decision file holds word for word');
{
  const final = (o1, verdict) => `## Objections\n- ${o1}\n- O2: downgraded: the must holds at the depth the rubric states\n## Caveats\nNone.\nVerdict: ${verdict}\n`;
  const found = fixture(BLIND_REJECT);
  cli(found.file);
  // The quote spans a line break in the decision file, and curly quotes delimit it.
  writeFileSync(found.final, final(`O1: withdrawn \u201c${FACT}\u201d`, 'accept'));
  const okRun = cli(found.file);
  eq(okRun.code, 0, `a found quote passes: ${okRun.out.trim()}`);
  eq(okRun.out.trim(), 'raised 2, withdrawn 1, kept 0, downgraded 1, caveats 0', 'and prints the counts');
  const v = cli('--verify', found.file);
  ok(v.code === 0 && lastLine(v.out) === 'raised 2, withdrawn 1, kept 0, downgraded 1, caveats 0', `--verify exits 0 with the same counts: ${v.out.trim()}`);
  ok(!v.out.includes('locked verdict:'), 'and prints no locked verdict once the final file is written');

  const missing = fixture(BLIND_REJECT);
  cli(missing.file);
  writeFileSync(missing.final, final('O1: withdrawn "the decider weighed speed lower than simplicity"', 'accept'));
  const bad = cli(missing.file);
  eq(bad.code, 1, 'a quote the decision file does not hold fails');
  ok(bad.out.includes('withdrawn O1 quotes text the decision file does not hold word for word'), `and names it: ${bad.out.trim()}`);
  ok(bad.out.includes('an accept keeps no objection, and 1 are kept'), 'and the accept that now keeps it');
  const vBad = cli('--verify', missing.file);
  eq(vBad.code, 0, '--verify still exits 0 on a matching lock');
  eq(lastLine(vBad.out), 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 0', 'and counts the unfound withdrawal as kept');

  const short = fixture(BLIND_REJECT);
  cli(short.file);
  writeFileSync(short.final, final('O1: withdrawn "41 ms"', 'accept'));
  ok(cli(short.file).out.includes(`quote the entire sourced fact, at least ${MIN_QUOTE_CHARS}`), 'a quote too short to prove anything fails');
}

section('the final file sorts every objection once, and its verdict agrees with what it keeps');
{
  const cases = [
    ['an unsorted objection', '## Objections\n- O1: kept: still stands\n## Caveats\nNone.\nVerdict: reject\n', 'O2 is not sorted'],
    ['an unknown id', '## Objections\n- O1: kept: x\n- O2: kept: y\n- O3: kept: z\nVerdict: reject\n', 'O3 is not an objection of the blind review'],
    ['an objection sorted twice', '## Objections\n- O1: kept: x\n- O1: downgraded: y\n- O2: kept: z\nVerdict: reject\n', 'O1 is sorted twice'],
    ['a reject that keeps nothing', '## Objections\n- O1: downgraded: x\n- O2: downgraded: y\nVerdict: reject\n', 'a reject keeps at least one objection'],
    ['no verdict line', '## Objections\n- O1: kept: x\n- O2: kept: y\n', 'no verdict line'],
  ];
  for (const [what, text, error] of cases) {
    const p = fixture(BLIND_REJECT);
    cli(p.file);
    writeFileSync(p.final, text);
    const r = cli(p.file);
    ok(r.code === 1 && r.out.includes(error), `${what}: fails naming it: ${r.out.trim().slice(0, 120)}`);
  }
  const kept = fixture(BLIND_REJECT);
  cli(kept.file);
  writeFileSync(kept.final, '## Objections\n- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\n## Caveats\nNone.\nVerdict: reject\n');
  const r = cli(kept.file);
  ok(r.code === 0 && r.out.trim() === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 0', `a reject that keeps one passes: ${r.out.trim()}`);
}

section('a line counts by its section: an objection line under the caveats is no objection, and a caveats line is a caveat or "None."');
{
  const PROSE = 'a format error';
  const blindCases = [
    ['an objection line under the caveats of an accept', BLIND_ACCEPT.replace('## Caveats\nNone.', '## Caveats\n- O1: redis beats the winner'), '- O1: redis beats the winner'],
    ['a prose line under the caveats', BLIND_ACCEPT.replace('## Caveats\nNone.', '## Caveats\nThe cache may grow.'), 'The cache may grow.'],
  ];
  for (const [what, text, line] of blindCases) {
    const p = fixture(text);
    const { out, code } = cli(p.file);
    ok(code === 1 && out.includes(`a line under "## Caveats" is neither a caveat "- C<n>: ..." nor "None.": "${line}"`), `${what}: ${PROSE} that quotes the line: ${out.trim().slice(0, 160)}`);
    ok(!out.includes('an accept holds no objection'), `${what}: the line is no objection of the accept`);
    ok(!existsSync(p.lock), `${what}: writes no lock`);
  }
  const p = fixture(BLIND_REJECT);
  cli(p.file);
  writeFileSync(p.final, '## Objections\n- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\n## Caveats\n- O1: kept: the p99 must fails\nVerdict: reject\n');
  const r = cli(p.file);
  ok(r.code === 1 && r.out.includes('neither a caveat'), `the final file: an objection line under the caveats is ${PROSE}: ${r.out.trim().slice(0, 160)}`);
  ok(!r.out.includes('O1 is sorted twice'), 'and is no second sort of O1');
  writeFileSync(p.final, '- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\nVerdict: reject\n');
  const bare = cli(p.file);
  ok(bare.code === 1 && bare.out.includes('missing the heading line "## Objections"') && bare.out.includes('missing the heading line "## Caveats"') && bare.out.includes('O1 is not sorted'),
    `a final file with no headings names both and sorts nothing: ${bare.out.trim().slice(0, 160)}`);
}

section('the counts line counts the caveats of the final file once it is written, and of the blind review before');
{
  const blind = BLIND_REJECT.replace('## Caveats\nNone.', '## Caveats\n- C1: the cache may grow. Evidence: x\n- C2: the docs lag. Evidence: y');
  const p = fixture(blind);
  eq(lastLine(cli('--verify', p.file).out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 2', 'no lock: the blind review\'s caveats');
  eq(cli(p.file).code, 0, 'a blind review with caveat lines locks');
  eq(lastLine(cli('--verify', p.file).out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 2', 'no final file: the blind review\'s caveats');
  writeFileSync(p.final, '## Objections\n- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\n## Caveats\n- C1: the cache may grow\n- C2: the docs lag\n- C3: O2, downgraded\n\n## WHERE NEXT\nAnother revision could answer O1.\nVerdict: reject\n');
  const r = cli(p.file);
  ok(r.code === 0 && r.out.trim() === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 3', `the final file's caveats, ended by the next heading: ${r.out.trim()}`);
  eq(lastLine(cli('--verify', p.file).out), 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 3', '--verify counts the same caveats');
  const sorts = '## Objections\n- O1: kept: redis scores 7.5 against 6.0\n- O2: downgraded: no breach on the default path\n';
  writeFileSync(p.final, `${sorts}## Caveats\nThe cache may grow.\nVerdict: reject\n`);
  const prose = cli('--verify', p.file);
  ok(prose.code === 0 && prose.out.includes('neither a caveat') && lastLine(prose.out) === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 1',
    `--verify counts a prose caveat line beside its format error: ${prose.out.trim().slice(-160)}`);
  writeFileSync(p.final, `${sorts}Verdict: reject\n`);
  const headless = cli('--verify', p.file);
  ok(headless.out.includes('missing the heading line "## Caveats"') && lastLine(headless.out) === 'raised 2, withdrawn 0, kept 1, downgraded 1, caveats 3',
    `a final file with no caveats heading counts the blind review's caveats and the downgraded objection: ${headless.out.trim().slice(-160)}`);
}

section('--verify exits 2 with no lock, and counts every objection kept');
{
  const p = fixture(BLIND_REJECT);
  const v = cli('--verify', p.file);
  eq(v.code, 2, 'exit 2');
  ok(v.out.includes('no lock at'), `names the missing lock: ${v.out.trim()}`);
  eq(lastLine(v.out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0', 'with the counts line last');
  const lockedAccept = fixture(BLIND_ACCEPT);
  cli(lockedAccept.file);
  const clean = cli('--verify', lockedAccept.file);
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
  ok(first.code === 0 && first.out.trim() === REVEAL, 'the first run locks the new blind review and prints the reveal');
  ok(JSON.parse(readFileSync(p.lock, 'utf8')).sha256, 'and writes a real lock over the reset one');
  ok(cli(p.file).out.trim() === REVEAL, 'a blank final file reads as not written, so the reveal prints again');
  const vBlank = cli('--verify', p.file);
  ok(vBlank.code === 0 && lastLine(vBlank.out) === 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0', `--verify counts every objection kept: ${vBlank.out.trim()}`);
  ok(vBlank.out.includes('locked verdict: reject'), 'and prints the locked verdict for a blank final file');
  const garbled = fixture(BLIND_REJECT);
  writeFileSync(garbled.lock, 'not json');
  eq(cli('--verify', garbled.file).code, 2, 'a lock that is not JSON reads as no lock');
}

section('--verify reports a missing review file through the lock state');
{
  const unlocked = fixture(null);
  eq(cli('--verify', unlocked.file).code, 2, 'no review file and no lock: exit 2');
  const locked = fixture(BLIND_REJECT);
  cli(locked.file);
  rmSync(locked.file);
  const v = cli('--verify', locked.file);
  ok(v.code === 3 && v.out.includes('locked verdict: reject'), `a locked review file that is gone is a mismatch: ${v.out.trim()}`);
}

section('a missing spec, review file or argument fails loudly');
{
  const p = fixture(BLIND_REJECT);
  rmSync(join(p.file, '..', '..', 'locks', 'review-r1.json'));
  const noSpec = cli(p.file);
  ok(noSpec.code === 1 && noSpec.out.includes('no check spec at'), `no spec: ${noSpec.out.trim()}`);
  const noFile = fixture(null);
  const r = cli(noFile.file);
  ok(r.code === 1 && r.out.includes('no review file at'), `no review file: ${r.out.trim()}`);
  for (const argv of [[], ['--verify'], ['a.md', 'b.md']]) {
    const u = cli(...argv);
    ok(u.code === 1 && u.out.includes('usage:'), `argv ${JSON.stringify(argv)} prints the usage`);
  }
  const badSpec = fixture(BLIND_REJECT);
  writeFileSync(join(badSpec.file, '..', '..', 'locks', 'review-r1.json'), '{"headings":[]}');
  ok(cli(badSpec.file).out.includes('needs "headings"'), 'a spec with no headings fails naming the field');
  const otherSections = fixture(BLIND_REJECT);
  writeFileSync(join(otherSections.file, '..', '..', 'locks', 'review-r1.json'), JSON.stringify({ headings: ['## Scores', '## Concerns'], stage2: otherSections.final, decision: otherSections.decision, reveal: otherSections.reveal }));
  const other = cli(otherSections.file);
  ok(other.code === 1 && other.out.includes('lacks "## Objections", "## Caveats"') && !existsSync(otherSections.lock),
    `a spec whose headings omit the sections the counts read from fails before any lock: ${other.out.trim()}`);
}

section('a missing reveal text leaves no lock, and a missing decision file keeps every objection');
{
  // The lock is written only after the reveal is read, so a reviewer is never locked without seeing it.
  const noReveal = fixture(BLIND_REJECT);
  rmSync(noReveal.reveal);
  const first = cli(noReveal.file);
  ok(first.code === 1 && first.out.includes(`no reveal text at ${noReveal.reveal}`), `the first run names the missing reveal: ${first.out.trim()}`);
  ok(!existsSync(noReveal.lock), 'and writes no lock');
  const lostReveal = fixture(BLIND_REJECT);
  cli(lostReveal.file);
  rmSync(lostReveal.reveal);
  const later = cli(lostReveal.file);
  ok(later.code === 1 && later.out.includes(`no reveal text at ${lostReveal.reveal}`), `a later run with no final file names the missing reveal: ${later.out.trim()}`);

  const noDecision = fixture(BLIND_REJECT);
  cli(noDecision.file);
  writeFileSync(noDecision.final, `## Objections\n- O1: withdrawn "${FACT}"\n- O2: kept: the p99 must fails\n## Caveats\nNone.\nVerdict: reject\n`);
  rmSync(noDecision.decision);
  const r = cli(noDecision.file);
  ok(r.code === 1 && r.out.includes(`no decision file at ${noDecision.decision}`), `a later run names the missing decision file: ${r.out.trim()}`);
  const v = cli('--verify', noDecision.file);
  ok(v.code === 0 && v.out.includes('no decision file at'), `--verify exits 0 on a matching lock and names the missing file: ${v.out.trim()}`);
  eq(lastLine(v.out), 'raised 2, withdrawn 0, kept 2, downgraded 0, caveats 0', 'and counts every objection kept');
  ok(!v.out.includes('locked verdict:'), 'and prints no locked verdict, since the final file is written');
}

for (const root of roots) rmSync(root, { recursive: true, force: true });
