// tools/wt.mjs land: merging, conflicts, unaccepted work, the gate and --scope-file.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { runCli, at, git, norm, firstLine, readOr, sha, withFixture, land, batchOf, stage, gateCmd, GATE_GREEN, GATE_ONE_OWNER, lockOf, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('land: two chains with disjoint edits, in order — the first skips the sync, the second merges it');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  // Counts its own runs, so "the gate was skipped" is an assertion rather than an absence of complaint.
  const ledger = join(root, 'gate-runs.txt');
  const gate = gateCmd(root, 'count', `require('fs').appendFileSync(${JSON.stringify(ledger)}, process.cwd() + '\\n');\n`);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  const a = land(repo, 'alpha', gate);
  eq(a.code, 0, `land alpha exits 0 (${firstLine(a.stderr)})`);
  ok(/sync skipped/.test(a.stderr), '...the FIRST lander finds integration already an ancestor and skips the sync (M28)');
  eq(readOr(ledger), '', '...and the gate too: it merged nothing, so there is no combined state its own run did not already gate');
  eq(norm(a.stdout.trim()), norm(intWt), '...and prints the integration worktree it landed into');

  const b = land(repo, 'beta', gate);
  eq(b.code, 0, `land beta exits 0 (${firstLine(b.stderr)})`);
  ok(/synced aipg\/int-b1/.test(b.stderr), '...the SECOND lander syncs integration in first');
  const gateRuns = readOr(ledger).split('\n').filter(Boolean);
  eq(gateRuns.length, 1, '...and gates exactly once, on the merge it just made');
  eq(norm(gateRuns[0]), norm(chains.beta), '...in the CHAIN worktree, on the merged state');

  const log = git(intWt, ['log', '--format=%s']).stdout;
  ok(/land alpha/.test(log), 'the integration log records landing alpha');
  ok(/land beta/.test(log), '...and landing beta');
  ok(existsSync(at(intWt, 'alpha.txt')) && existsSync(at(intWt, 'beta.txt')), "both chains' work is in the integration tree");
  eq(git(intWt, ['status', '--porcelain']).stdout.trim(), '', 'the integration worktree is clean throughout');
  ok(!existsSync(lockOf(repo)), 'and no land lock is left behind');
});

section('land: a textual conflict parks the branch and leaves integration untouched (exit 20)');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'a.txt', 'beta edit\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 20, 'the second land of the same line exits 20 conflict');
  ok(/CONFLICTED/.test(r.stderr), `...saying so and naming the file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...INTEGRATION IS UNTOUCHED (the invariant, asserted by SHA)');
  ok(git(chains.beta, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0, '...MERGE_HEAD is gone — the merge was aborted');
  eq(git(chains.beta, ['status', '--porcelain']).stdout.trim(), '', '...the chain worktree is clean again');
  eq(git(repo, ['show', 'aipg/b1/beta:a.txt']).stdout, 'beta edit\n', "...and the branch still holds beta's accepted work");
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
  eq(git(intWt, ['status', '--porcelain']).stdout.trim(), '', '...and a clean integration worktree');
});

section('land: a conflict RESOLVED BY HAND still lands — a clean tree is not an empty branch');
await withFixture(({ root, repo }) => {
  // The recovery this tool's own conflict message prescribes ("resolve it on <chain> and land again"),
  // completed the way git's own conflict output prescribes (fix it, add it, commit it). That leaves the
  // chain worktree CLEAN with an EMPTY index — byte for byte the shape of a chain that accepted nothing —
  // while its BRANCH carries a resolved merge integration has never seen. Read as nothing-to-land, the
  // orchestrator moves on (exit 10 is documented as "not an error") and that work never reaches
  // integration, with no error anywhere.
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'a.txt', 'beta edit\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first');
  eq(land(repo, 'beta', gate).code, 20, 'beta conflicts, and its work is parked on its branch');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  ok(git(chains.beta, ['merge', 'aipg/int-b1']).code !== 0, 'the hand merge conflicts too, as the land did');
  writeFileSync(at(chains.beta, 'a.txt'), 'alpha edit\nbeta edit\n');
  eq(git(chains.beta, ['add', '--', 'a.txt']).code, 0, '...the operator resolves it');
  eq(git(chains.beta, ['commit', '-qm', 'resolve sync']).code, 0, '...and COMMITS the resolution');
  eq(git(chains.beta, ['status', '--porcelain']).stdout.trim(), '', '...leaving a clean tree and an empty index');

  const r = land(repo, 'beta', gate);
  eq(r.code, 0, `the resolved chain LANDS (${firstLine(r.stderr)})`);
  ok(!/nothing to land/.test(r.stderr), '...it is never reported as nothing-to-land');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...integration really moved (SHA)');
  eq(readOr(at(intWt, 'a.txt')), 'alpha edit\nbeta edit\n', '...carrying the hand-resolved content into the integration tree');
  ok(/land beta/.test(git(intWt, ['log', '--format=%s']).stdout), '...recorded in the integration log');
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: unaccepted work that a sync would touch is exit 40, not a conflict — and nothing is aborted');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'a.txt', 'alpha edit\n');
  stage(chains.beta, 'beta.txt', 'beta\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands, so the sync into beta now touches a.txt');

  // UNSTAGED — so it survives the index-only accept commit, and the land refuses before any sync.
  writeFileSync(at(chains.beta, 'a.txt'), 'unaccepted local edit\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'unaccepted work over an overlapping sync exits 40, NOT 20');
  ok(/NOT accepted/.test(r.stderr), `...naming the refusal: ${firstLine(r.stderr)}`);
  ok(/a\.txt/.test(r.stderr), '...and the file that holds the unaccepted work');
  ok(!/no merge to abort/.test(r.stderr), '...with no "there is no merge to abort" fatal');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  eq(readOr(at(chains.beta, 'a.txt')), 'unaccepted local edit\n', '...and the unaccepted edit is still there, untouched');
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: unaccepted work the sync never touches is still exit 40 — the gate would judge what does not land');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'needs-fixed', "if (!require('fs').readFileSync('a.txt', 'utf8').includes('fixed')) process.exit(1);\n");
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip), so beta must sync and gate');

  // The gate passes only because of the UNSTAGED edit, which the land would never carry into integration.
  stage(chains.beta, 'b.txt', 'accepted\n');
  writeFileSync(at(chains.beta, 'a.txt'), 'fixed, but never accepted\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'a staged b.txt beside an unstaged a.txt edit exits 40, never 0');
  ok(/NOT accepted/.test(r.stderr) && /a\.txt/.test(r.stderr), `...naming the unaccepted file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  eq(readOr(at(intWt, 'a.txt')), 'one\n', "...and integration's a.txt never read as fixed");
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');

  eq(git(chains.beta, ['checkout', '--', 'a.txt']).code, 0, 'the operator discards the unaccepted edit');
  const again = land(repo, 'beta', gate);
  eq(again.code, 30, `land again judges only the accepted work, and the gate is red on it (${firstLine(again.stderr)})`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...so integration is still untouched');
});

section('land: an UNTRACKED unaccepted file is exit 40 even when status.showUntrackedFiles is no');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'needs-c', "if (!require('fs').existsSync('c.txt')) process.exit(1);\n");
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  eq(land(repo, 'alpha', gateCmd(root, 'green', GATE_GREEN)).code, 0, 'alpha lands first, so beta must sync and gate');

  // The repo config reaches every worktree, and it hides untracked files from a plain `git status`.
  eq(git(repo, ['config', 'status.showUntrackedFiles', 'no']).code, 0, 'the operator hides untracked files');
  stage(chains.beta, 'b.txt', 'accepted\n');
  writeFileSync(at(chains.beta, 'c.txt'), 'never accepted\n');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 40, 'a staged b.txt beside an untracked c.txt exits 40, never 0');
  ok(/NOT accepted/.test(r.stderr) && /c\.txt/.test(r.stderr), `...naming the untracked file: ${firstLine(r.stderr)}`);
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  ok(!existsSync(at(intWt, 'c.txt')), '...and integration never received c.txt');
  eq(readOr(at(chains.beta, 'c.txt')), 'never accepted\n', '...while the untracked file stays in the chain');
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: disjoint FILES can still break the build — a red gate on the merged state is exit 30');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const gate = gateCmd(root, 'one-owner', GATE_ONE_OWNER);
  stage(chains.alpha, 'a.txt', 'OWNER\n');
  stage(chains.beta, 'b.txt', 'OWNER\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its own run already gated that state)');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 30, 'beta touches no file of alpha\'s and still exits 30 on the SYNCED state');
  ok(/two files claim OWNER/.test(r.stderr), "...surfacing the gate's own output");
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration is untouched (SHA)');
  ok(/sync aipg\/int-b1/.test(git(repo, ['log', '--format=%s', 'aipg/b1/beta']).stdout),
    '...the sync merge is KEPT on the branch, recording the combined state a fix run must address');
  eq(runCli(process.execPath, [join(root, 'gate-one-owner.cjs')], { cwd: intWt }).code, 0, "...and integration's own gate is still green");
  ok(!existsSync(lockOf(repo)), '...with no lock left behind');
});

section('land: a RETRY after a red gate is GATED AGAIN — the kept sync merge is not a free pass');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const ledger = join(root, 'retry-gate-runs.txt');
  // Counts its runs AND enforces the cross-file invariant, so "was it gated at all" and "what did it
  // say" are both assertable against the same command.
  const gate = gateCmd(root, 'counted-owner', `const fs = require('fs');
fs.appendFileSync(${JSON.stringify(ledger)}, process.cwd() + '\\n');
const has = (f) => { try { return fs.readFileSync(f, 'utf8').includes('OWNER'); } catch { return false; } };
if (has('a.txt') && has('b.txt')) { console.error('two files claim OWNER'); process.exit(1); }
`);
  const gateRuns = () => readOr(ledger).split('\n').filter(Boolean).length;

  stage(chains.alpha, 'a.txt', 'OWNER\n');
  stage(chains.beta, 'b.txt', 'OWNER\n');
  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip, no sync merge on it yet)');
  eq(land(repo, 'beta', gate).code, 30, 'beta exits 30 on the merged state');
  eq(gateRuns(), 1, '...having gated exactly once');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  // Exit 30 deliberately KEEPS the sync merge on the branch, so from here on integration is an ancestor
  // of the chain forever. The documented recovery — fix it on the chain and land again — was therefore
  // the one path that read "int is an ancestor" as "already gated", skipped the gate entirely and merged
  // a RED combined state into integration at exit 0. A retry that fixes NOTHING must still be caught.
  stage(chains.beta, 'unrelated.txt', 'a change that fixes nothing\n');
  const retry = land(repo, 'beta', gate);
  eq(retry.code, 30, 'a retry that does NOT fix the breakage exits 30 again');
  ok(!/sync skipped/.test(retry.stderr), '...the kept sync merge is not mistaken for an already-gated state');
  eq(gateRuns(), 2, '...because the gate really ran a second time');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...and integration is still untouched (SHA)');

  stage(chains.beta, 'b.txt', 'no claim here\n');
  const fixed = land(repo, 'beta', gate);
  eq(fixed.code, 0, `a retry that DOES fix it lands (${firstLine(fixed.stderr)})`);
  eq(gateRuns(), 3, '...gated a third time, on the exact state it landed');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...and only now does integration move');
  eq(runCli(process.execPath, [join(root, 'gate-counted-owner.cjs')], { cwd: intWt }).code, 0,
    "...leaving integration's own gate green, which is the invariant the retry path had been breaking");
  ok(!existsSync(lockOf(repo)), 'and no lock survives any of it');
});

section('land: a gate that PASSES loudly lands — output past the 1 MiB default is not a red gate');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  // A gate is a build or a test suite by definition, so clearing Node's 1 MiB default child-output cap is
  // ordinary, not adversarial. Over it the child is KILLED with no exit status, and reading that as exit 1
  // reported a gate that had called process.exit(0) as integration-red (30): the chain's accepted work was
  // blocked and the operator was pointed at a failure that never happened.
  const gate = gateCmd(root, 'loud', "process.stdout.write('x'.repeat(2 * 1024 * 1024) + '\\n');\nprocess.exit(0);\n");
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its gate never runs)');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  // No firstLine() on this stderr: it carries the gate's 2 MiB of output, relayed verbatim.
  const r = land(repo, 'beta', gate);
  eq(r.code, 0, 'a gate that writes 2 MiB and exits 0 is GREEN, and beta lands');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...integration really moved (SHA)');
  ok(existsSync(at(intWt, 'beta.txt')), "...carrying beta's work into the integration tree");
  ok(!/exited 1/.test(r.stderr), '...with no fabricated exit code anywhere in the report');
  ok(!existsSync(lockOf(repo)), '...and no lock left behind');
});

section('land: an empty index is nothing-to-land (10) only when the tree is CLEAN — otherwise 40');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['c1', 'c2', 'c3']);
  const gate = gateCmd(root, 'green', GATE_GREEN);

  const nothing = land(repo, 'c1', gate);
  eq(nothing.code, 10, 'an untouched chain exits 10 nothing-to-land');
  ok(/nothing to land/.test(nothing.stderr), `...saying so: ${firstLine(nothing.stderr)}`);

  // develop-cycle's passed-but-unstaged halt: the work is GOOD and one `git add` fixes it. Reporting 10
  // here would let the orchestrator move on, and that work would never land.
  writeFileSync(at(chains.c2, 'a.txt'), 'accepted but never staged\n');
  const dirty = land(repo, 'c2', gate);
  eq(dirty.code, 40, 'an empty index over a DIRTY tree exits 40, never 10');
  ok(/a\.txt/.test(dirty.stderr), '...listing the files');
  ok(/passed-but-unstaged/.test(dirty.stderr), `...and naming the likely cause: ${firstLine(dirty.stderr)}`);

  writeFileSync(at(chains.c3, 'n.txt'), 'created, only intent-to-add\n');
  eq(git(chains.c3, ['add', '-N', '--', 'n.txt']).code, 0, 'a developer round leaves created files intent-to-add');
  const ita = land(repo, 'c3', gate);
  eq(ita.code, 40, 'a residual intent-to-add entry exits 40');
  ok(/intent-to-add/.test(ita.stderr), `...naming it: ${firstLine(ita.stderr)}`);
  ok(/n\.txt/.test(ita.stderr), '...and the file it would have committed EMPTY');
  ok(!existsSync(lockOf(repo)), 'no lock survives any of those exits');
});

section('land: --scope-file WARNS about files outside the declared scope and changes no exit code');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  const scope = join(root, 'scope-alpha.txt');
  writeFileSync(scope, 'src/a/**\nsrc\\c\\**\n');            // second line as a Windows operator would type it
  stage(chains.alpha, 'src/a/y.js', '// in scope\n');
  stage(chains.alpha, 'src/c/z.js', '// in scope, declared with backslashes\n');
  stage(chains.alpha, 'src/b/x.js', '// out of scope\n');

  const r = land(repo, 'alpha', gate, ['--scope-file', scope]);
  eq(r.code, 0, 'an out-of-scope file is a WARNING, never a failure — merge and gate stay the arbiters');
  eq((r.stderr.match(/AIPG scope:/g) ?? []).length, 1, '...exactly one warning line');
  ok(/AIPG scope: alpha touched src\/b\/x\.js outside its declared scope/.test(r.stderr), `...naming chain and file: ${firstLine(r.stderr)}`);
  ok(!/src\/a\/y\.js/.test(r.stderr), '...and saying nothing about the file that IS in scope');
  ok(!/src\/c\/z\.js/.test(r.stderr), '...including one declared with backslashes, since git names files with forward slashes');
});

}
