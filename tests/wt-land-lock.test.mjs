// tools/wt.mjs land: the repo-global lock, its heartbeat and takeover, and the clean --batch lock sweep.
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { section, ok, eq } from './harness.mjs';
import { heartbeat, takeoverLock } from '../tools/wt.mjs';
import { wt, at, git, firstLine, readOr, sha, withFixture, trashedNames, trashedName, land, batchOf, stage, gateCmd, GATE_GREEN, lockOf, writeLock, deadPid, hasGit } from './wt-helpers.mjs';

if (!hasGit) {
  console.log('  ! SKIPPED — git is not on PATH, and every check in this file drives a real repo');
} else {

section('land: the repo-global lock serializes landing — held is 75, dead is taken over');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');

  // A LIVE holder: this test process itself, which is unambiguously running.
  writeLock(repo, { pid: process.pid, key: 'other', startedAt: Date.now() });
  const held = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(held.code, 75, 'a lock held by a LIVE owner exits 75 retry-later after --wait-ms');
  ok(new RegExp(`pid ${process.pid} landing "other"`).test(held.stderr), `...naming the holder: ${firstLine(held.stderr)}`);
  ok(existsSync(lockOf(repo)), "...and does NOT touch someone else's lock");
  eq(sha(repo, 'refs/heads/aipg/int-b1'), sha(repo, 'refs/heads/main'), '...integration never moved');

  // The same lock, owned by a process that is gone.
  writeLock(repo, { pid: deadPid(), key: 'crashed', startedAt: Date.now() });
  const taken = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(taken.code, 0, 'a lock whose owner is GONE is taken over and the land proceeds');
  ok(/TAKING OVER/.test(taken.stderr), `...loudly: ${firstLine(taken.stderr)}`);
  ok(/is GONE/.test(taken.stderr), '...saying the owner is dead, not merely old');
  ok(!existsSync(lockOf(repo)), '...and the lock is released on the way out');
});

section('land: a lock goes stale by its HEARTBEAT, never by how long its holder has been running');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha']);
  const gate = gateCmd(root, 'green', GATE_GREEN);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  const HOUR = 3600000;
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  // A holder that has been landing for an HOUR and is still progressing: a pid that is unambiguously
  // alive (this test process), an ancient startedAt, and a heartbeat written just now. Measured from
  // startedAt this lock is long past --stale-ms and gets stolen out from under a land that may be
  // mid-merge; measured from the heartbeat it is simply busy. A gate that IS the project's test suite
  // makes that an ordinary Tuesday, not an edge case.
  //
  // Nothing here races: --stale-ms is 10 minutes and the waiter is allowed 300ms, so the heartbeat
  // cannot cross the staleness bound inside the wait window whatever the machine is doing.
  writeLock(repo, { pid: process.pid, key: 'slow-but-alive', startedAt: Date.now() - HOUR, heartbeatAt: Date.now() });
  const waited = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(waited.code, 75, 'an hour-old holder whose heartbeat is FRESH is waited for, then reported retry-later');
  ok(!/TAKING OVER/.test(waited.stderr), `...with no takeover anywhere in the report: ${firstLine(waited.stderr)}`);
  ok(/pid \d+ landing "slow-but-alive"/.test(waited.stderr), '...naming the holder it is waiting for');
  ok(existsSync(lockOf(repo)), '...and the lock is left exactly where it is');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...integration never moved');

  // The mirror image: the same live pid, started seconds ago, but WEDGED — no heartbeat for an hour.
  writeLock(repo, { pid: process.pid, key: 'wedged', startedAt: Date.now(), heartbeatAt: Date.now() - HOUR });
  const taken = land(repo, 'alpha', gate, ['--wait-ms', '300', '--stale-ms', '600000']);
  eq(taken.code, 0, 'a LIVE holder that has not heartbeat for an hour IS taken over, and the land proceeds');
  ok(/TAKING OVER/.test(taken.stderr), `...loudly: ${firstLine(taken.stderr)}`);
  ok(/has not heartbeat/.test(taken.stderr), '...saying it went quiet, not that it died');
  ok(!/is GONE/.test(taken.stderr), '...because its pid is still there');
  ok(sha(repo, 'refs/heads/aipg/int-b1') !== before, '...and the work really landed (SHA)');
  ok(!existsSync(lockOf(repo)), '...leaving no lock behind');
});

section('the takeover guard re-reads the lock and removes it ONLY if it is still the same one');
await withFixture(({ repo }) => {
  // Between deciding a lock is stale and unlinking it, the holder can release and a THIRD land can take
  // it — and unlinking THAT hands a fourth land a free run into the same integration branch, which is
  // the one overlap this lock exists to prevent. The guard is the re-read, and it is exercised here
  // directly on both owner shapes: no sleeping, no racing processes, nothing timing-dependent.
  const lock = lockOf(repo);
  const decided = { pid: deadPid(), key: 'crashed', startedAt: 1000, heartbeatAt: 1000 };

  writeLock(repo, decided);
  eq(takeoverLock(lock, decided), 'removed', 'the lock the staleness decision was made about is removed');
  ok(!existsSync(lock), '...and is really gone');

  writeLock(repo, { pid: process.pid, key: 'next', startedAt: 2000, heartbeatAt: 2000 });
  eq(takeoverLock(lock, decided), 'changed', 'a lock that changed hands is NOT removed');
  eq(JSON.parse(readOr(lock) || '{}').key, 'next', "...the new holder's lock is left byte-for-byte alone");

  // Same pid, same key, a LATER run of it — startedAt is what tells the two apart.
  writeLock(repo, { ...decided, startedAt: 3000 });
  eq(takeoverLock(lock, decided), 'changed', 'a later run of the same pid and key is a different owner');
  ok(existsSync(lock), '...so its lock survives too');

  // heartbeatAt is deliberately NOT part of the identity: the holder rewrites it at every step boundary,
  // and matching on it would make every stale lock un-takeable the moment it was refreshed once.
  writeLock(repo, { ...decided, heartbeatAt: 9999 });
  eq(takeoverLock(lock, decided), 'removed', 'a refreshed heartbeat does not make it a different owner');

  eq(takeoverLock(lock, decided), 'gone', 'a lock already released reports gone — nothing was taken over');
});

section('the heartbeat refreshes the lock in place, and never writes over one that changed hands');
await withFixture(({ repo }) => {
  // Timestamps seeded in 1970, so "was it refreshed" is a comparison against Date.now() with fifty years
  // of margin rather than a measurement of how long anything took.
  const lock = lockOf(repo);
  const token = { pid: process.pid, key: 'alpha', startedAt: 1000, heartbeatAt: 1000 };

  writeLock(repo, token);
  heartbeat(lock, { ...token });
  const beat = JSON.parse(readOr(lock) || '{}');
  ok(beat.heartbeatAt > 1000, 'the heartbeat moves heartbeatAt forward');
  eq(beat.startedAt, 1000, '...leaving startedAt alone — it dates the holder, not its progress');
  eq(beat.pid, token.pid, '...and the pid');
  eq(beat.key, 'alpha', '...and the key, so the release still recognises its own lock');

  // The other half: a holder that lost the lock must not stamp its identity back over the new one, or
  // the new holder's release would refuse to unlink a lock it no longer recognises — landing would be
  // wedged for the whole repo with nothing left running.
  const other = { pid: deadPid(), key: 'next', startedAt: 2000, heartbeatAt: 2000 };
  writeLock(repo, other);
  heartbeat(lock, { ...token });
  eq(JSON.parse(readOr(lock) || '{}').key, 'next', "a lock that changed hands is NOT written over");
  eq(JSON.parse(readOr(lock) || '{}').heartbeatAt, 2000, '...not even its heartbeat');
});

section('land heartbeats at its step boundaries, and the rewrites keep it the SAME lock');
await withFixture(({ root, repo }) => {
  const { chains } = batchOf(root, repo, ['alpha', 'beta']);
  const ledger = join(root, 'lock-at-gate.json');
  // The gate runs INSIDE the land, while the lock is held — the one moment the live lock file is
  // readable from outside. By then the holder has heartbeat twice, after COMMIT and after SYNC.
  const gate = gateCmd(root, 'peek', `require('fs').copyFileSync(${JSON.stringify(lockOf(repo))}, ${JSON.stringify(ledger)});\n`);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its gate never runs)');
  const b = land(repo, 'beta', gate);
  eq(b.code, 0, `beta lands, gating the merged state (${firstLine(b.stderr)})`);

  const held = JSON.parse(readOr(ledger) || '{}');
  eq(held.key, 'beta', 'the lock held during the gate names the chain being landed');
  ok(Number.isInteger(held.pid) && held.pid !== process.pid, '...and carries the land process pid, not this one');
  // Acquisition writes startedAt and heartbeatAt from ONE Date.now(), so they are equal until a boundary
  // refreshes one of them. Two git subprocesses (the accept commit and the sync merge) run in between,
  // which is tens of milliseconds of real work against a 1ms clock tick — a lower bound, not a race.
  ok(held.heartbeatAt > held.startedAt,
    `...and a heartbeatAt the COMMIT and SYNC boundaries moved past startedAt (+${held.heartbeatAt - held.startedAt}ms)`);
  // A rewrite that changed pid, startedAt or key would leave `releaseLock` unable to recognise its own
  // lock, and it would outlive the land that made it.
  ok(!existsSync(lockOf(repo)), 'the release still recognises the lock after those rewrites, and removes it');
});

section('land: a land that LOST the lock refuses to merge into integration (75) instead of merging anyway');
await withFixture(({ root, repo }) => {
  // The heartbeat is written at step BOUNDARIES, so the gate — a whole test suite — is the one stretch a
  // takeover can land inside: past --stale-ms a waiter correctly sees an idle lock and steals it while
  // this land is still mid-gate. `heartbeat` then silently no-ops and, unguarded, the merge into the
  // SHARED integration worktree went ahead anyway at exit 0, with the loss reported only in passing on
  // the way out. That is the whole serialization guarantee, lost in the one step that needs it.
  //
  // The gate below IS the takeover, performed deterministically: it overwrites the live lock with a
  // different owner and exits green, at exactly the moment a real steal would land. Nothing sleeps,
  // nothing races, no second process is involved.
  const { intWt, chains } = batchOf(root, repo, ['alpha', 'beta']);
  const hostile = { pid: process.pid, key: 'hostile-taker', startedAt: 1000, heartbeatAt: 1000 };
  const gate = gateCmd(root, 'steal',
    `require('fs').writeFileSync(${JSON.stringify(lockOf(repo))}, ${JSON.stringify(`${JSON.stringify(hostile)}\n`)});\n`);
  stage(chains.alpha, 'alpha.txt', 'alpha\n');
  stage(chains.beta, 'beta.txt', 'beta\n');

  eq(land(repo, 'alpha', gate).code, 0, 'alpha lands first (ancestor skip — its gate never runs, so nothing is stolen yet)');
  const before = sha(repo, 'refs/heads/aipg/int-b1');

  const r = land(repo, 'beta', gate);
  eq(r.code, 75, 'a land whose lock was taken over DURING the gate exits 75 retry-later, not 0');
  ok(/NO LONGER held/.test(r.stderr), `...saying the lock is gone from under it: ${firstLine(r.stderr)}`);
  ok(/hostile-taker/.test(r.stderr), '...naming who holds it now');
  eq(sha(repo, 'refs/heads/aipg/int-b1'), before, '...and INTEGRATION IS UNTOUCHED (the invariant, asserted by SHA)');
  ok(!/land beta/.test(git(intWt, ['log', '--format=%s']).stdout), '...with no landing commit in its log');
  ok(!existsSync(at(intWt, 'beta.txt')), "...and none of beta's work in the integration tree");
  eq(git(intWt, ['status', '--porcelain']).stdout.trim(), '', '...and a clean integration worktree');
  ok(/sync aipg\/int-b1/.test(git(repo, ['log', '--format=%s', 'aipg/b1/beta']).stdout),
    'the chain keeps its synced, gated work, so the retry the exit code asks for has something to land');
  eq(JSON.parse(readOr(lockOf(repo)) || '{}').key, 'hostile-taker', "...and the new holder's lock is left exactly where it is");
});

section('clean --batch clears a DEAD land lock and leaves a live one alone');
await withFixture(({ root, repo }) => {
  const { intWt, chains } = batchOf(root, repo, ['alpha']);
  eq(wt(['clean', '--repo', repo, '--key', 'alpha']).code, 0, 'the chain is cleaned first (clean --batch requires it)');
  ok(trashedName(root, chains.alpha) !== '', '...moving it to the trash');

  writeLock(repo, { pid: process.pid, key: 'in-flight', startedAt: Date.now() });
  const live = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(live.code, 0, 'clean --batch still tears the batch down with a lock present');
  eq(trashedNames(root, intWt).length, 1, '...moving the integration worktree to the trash');
  ok(existsSync(lockOf(repo)), '...but a LIVE land lock is left exactly where it is');
  ok(/left the land lock/.test(live.stderr), `...saying so: ${firstLine(live.stderr)}`);
  rmSync(lockOf(repo), { force: true });

  eq(wt(['init', '--repo', repo, '--batch', 'b1']).code, 0, 'the batch is re-initialised');
  writeLock(repo, { pid: deadPid(), key: 'crashed', startedAt: Date.now() });
  const stray = join(intWt, 'stray.txt');
  writeFileSync(stray, 'not landed\n');
  const refused = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(refused.code, 40, `clean --batch exits 40 for an integration worktree with untracked work (${firstLine(refused.stderr)})`);
  ok(existsSync(lockOf(repo)), '...and leaves the dead lock in place, since a refused clean changes nothing');
  rmSync(stray);
  const dead = wt(['clean', '--repo', repo, '--batch', 'b1']);
  eq(dead.code, 0, 'clean --batch exits 0 with a dead-pid lock');
  eq(trashedNames(root, intWt).length, 2, '...moving the re-initialised integration worktree to the trash beside the first');
  ok(!existsSync(lockOf(repo)), '...having removed it');
  ok(/removed a STALE land lock/.test(dead.stderr), `...loudly: ${firstLine(dead.stderr)}`);
});

}
