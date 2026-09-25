// WORKFLOW-PRINCIPLES.md #15, enforced mechanically across EVERY engine x role.
//
// The defect shape #15 names is the absorbing idiom (`r?.findings || []`, `verdict ?? 'ready'`, `?? 0`):
// it makes the DEAD path byte-identical to a healthy one, so a run that lost an agent reports as a run
// that finished. Per-engine test files each catch that where someone thought to look; this file catches
// it everywhere, by construction, and a NEW role cannot ship without a death policy.
//
// HOW ONE CHECK IS BUILT (per engine x role):
//   1. ROLES come from `readRoles(engineSrc)` — the same static reader the flow maps use. Coverage
//      therefore equals the role list itself; a role nothing kills is a FAILURE here, not an absence.
//   2. SCENARIO = the first one in the engine's flow spec whose HEALTHY trace spawns that role. Reusing
//      the maintained scenario table is what keeps this file from growing a second set of fixtures that
//      drifts from the first.
//   3. BASELINE = that scenario's own healthy run.
//   4. KILL = the same scenario, run again through a responder WRAPPER that intercepts the FIRST call
//      whose longest-prefix role match is the target and returns `null`; every other call passes
//      through untouched.
//   5. PREDICATE = the entry this file records for that engine x role in EXPECTED, below.
//
// FOUR DECISIONS THAT LOOK ARBITRARY AND ARE NOT — each was measured against the alternative:
//
//   KILL-FIRST, VIA A WRAPPER, not `respond[role] = null`. Killing EVERY call of a role manufactures a
//   "visible difference" out of MAX_ROUNDS plus a park on engines that have no death policy at all —
//   the round loop simply runs out — so a laundering engine passes. Merging a key into the scenario's
//   own `respond` object also destroys its longest-prefix matching: develop scripts `acceptance block-a`
//   separately from `acceptance`, and a merged `acceptance: null` kills the wrong call.
//
//   PARK_OK IS MERGED INTO KILL RUNS on every park engine. A park label the scenario never scripted
//   returns `{}` from the harness, `pk?.cleared !== true` then rewrites the halt to `park-unsafe`, and
//   the terminal differs from baseline for a reason that has nothing to do with the death — the sweep
//   would stay green with the engine's death guards deleted. The merge FILLS IN only where the scenario
//   is silent (its own park script always wins), and PARK_UNSAFE below asserts no non-park kill lands
//   on the park-unsafe terminal.
//
//   THE PREDICATE IS EXPLICIT PER SITE. "Any diff at all" is vacuous: measured 2026-08-02, 0 of 29 kills
//   were indistinguishable under it — laundering sites included, because a dead agent shifts a round
//   count or a log line while the run still reports success. EXPECTED records the ONE signal each site
//   must produce; a weaker one fails. `signal:'log'` additionally requires the line to speak the death
//   vocabulary (DEATH_WORDS) — a success-shaped line saying `0 file(s)` is exactly the bug.
//
//   THE ALLOWLIST CANNOT ROT. An entry whose kill now DOES signal is itself red, so an exemption cannot
//   outlive the hole it documents. It is empty, and should stay that way.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSpecs } from '../tools/gen-flows.mjs';
import { REPO_ROOT, readHaltStatus, readRoles, runTrace, section, ok, toResponder } from './harness.mjs';

// ---------------------------------------------------------------------------------------------
// The expected-signal table — one entry per engine x role, keyed `<spec name> x <role>`
// ---------------------------------------------------------------------------------------------
// signal: 'terminal' — the run's terminal kind/status/message must DIFFER from baseline, and the kill's
//                      status (or thrown message) must match `expect`. The strongest signal: the run
//                      itself ended differently.
// signal: 'log'      — a log line the baseline did NOT emit, matching BOTH DEATH_WORDS and `expect`.
//                      The right signal for an AUXILIARY role, whose death cannot stop the run.
// signal: 'field'    — the NAMED return field must differ from baseline. For roles whose death is
//                      recorded in the return rather than the log or the terminal.
const DEATH_WORDS = /died|returned nothing|no output|DIED|✋|was NOT/;

const EXPECTED = {
  // solo critical -> throws
  'decide x decide':                { signal: 'terminal', expect: /Decider returned nothing/ },
  'decide x review':                { signal: 'terminal', expect: /Reviewer returned nothing/ },
  'docs x curate':                  { signal: 'terminal', expect: /Curator returned nothing/ },
  'investigate x criteria-critic':  { signal: 'terminal', expect: /Criteria critic returned nothing/ },
  'investigate x investigate':      { signal: 'terminal', expect: /Investigator returned nothing/ },
  'investigate x critique':         { signal: 'terminal', expect: /Acceptance critic returned nothing/ },
  // refine's critic is solo-critical for the sharpest reason in the family: zero gaps from an agent that
  // DIED is byte-identical to the one signal this loop converges on, so a null would report a plan nobody
  // read as converged. Its editor is the exception below — the critique file survives it.
  'refine x plan-critic':           { signal: 'terminal', expect: /Plan critic returned nothing/ },

  // inside a build loop -> halts and parks through the ordinary park path
  'develop x develop':              { signal: 'terminal', expect: /BLOCKED \(an agent returned nothing/ },
  'develop x quality':              { signal: 'terminal', expect: /BLOCKED \(an agent returned nothing/ },
  'develop x acceptance':           { signal: 'terminal', expect: /BLOCKED \(an agent returned nothing/ },
  // refine-cycle halts WITHOUT parking, alone among the loop engines: it writes no repo code, so there is
  // no tree to save. Its editor halts rather than throws because the round's critique file is already on
  // disk and a relaunch resumes the fold.
  'refine x plan-editor':           { signal: 'terminal', expect: /BLOCKED \(the plan editor returned nothing/ },

  // the park agent itself: its death IS the unsafe tree, and that is the terminal it must reach
  'develop x park':                 { signal: 'terminal', expect: /BLOCKED \(a parked block left the tree unsafe/ },

  // auxiliary -> the death is logged and recorded; the run legitimately carries on
  'brainstorm x generate':          { signal: 'log', expect: /no output from/ },
  'docs x gather':                  { signal: 'log', expect: /gatherer\(s\) died before returning/ },
  'docs x scrub':                   { signal: 'log', expect: /scrub:\S+ returned nothing/ },
  'enhance x find':                 { signal: 'log', expect: /the finder DIED/ },
  'enhance x verify':               { signal: 'log', expect: /the verifier DIED/ },
  'develop x final-sweep':          { signal: 'log', expect: /completeness check DIED/ },
  'review x review':                { signal: 'log', expect: /reviewer returned nothing/ },
  'review x verify':                { signal: 'log', expect: /agent returned nothing/ },
  // decide drops the dead analyst's lens from convergence and says so; the fact reaches the caller in
  // the lens list rather than the log, because a lens file that was never written cannot be cited.
  'decide x analyst':               { signal: 'field', field: 'lensFiles' },
};

/** Sites whose kill is knowingly invisible. `{ engine, role, reason }`. Expected: EMPTY. */
const ALLOW = [];

// ---------------------------------------------------------------------------------------------
// Machinery
// ---------------------------------------------------------------------------------------------
const PARK_OK = { saved: true, cleared: true, gates_green: true, patch_bytes: 2048, strays_saved: 0 };
const PARK_ENGINES = new Set(['develop']);

/** Longest-prefix match of a label against the engine's static roles; '' when nothing matches. */
const roleOf = (label, roles) => {
  let best = '';
  for (const r of roles) if (label.startsWith(r) && r.length > best.length) best = r;
  return best;
};

// The harness's OWN responder is reused (not re-implemented) so the two traces cannot be scripted by
// different rules: the BASELINE goes through `execute` -> `toResponder`, and the KILL wraps this same
// function. A private copy drifting would make every comparison below measure script divergence rather
// than the death — silently green.
/** Nulls the FIRST call whose role is `role` and delegates every other call; `applied`/`label` record the hit. */
function killFirst(spec, roles, role, respond) {
  const killer = { applied: false, label: '' };
  const delegate = toResponder(respond ?? {});
  killer.responder = (label, prompt, calls) => {
    const r = roleOf(label, roles);
    if (!killer.applied && r === role) { killer.applied = true; killer.label = label; return null; }
    const v = delegate(label, prompt, calls);
    // Fill in an unscripted park ONLY — the scenario's own park script always wins.
    if (v === undefined && PARK_ENGINES.has(spec.name) && r === 'park') return PARK_OK;
    return v;
  };
  return killer;
}
const j = (v) => JSON.stringify(v ?? null);
const termOf = (t) => `${t.kind} | ${t.status} | ${t.message}`;
/** What `expect` is matched against: the status of a return, the message of a throw. */
const termText = (t) => t.status || t.message;

// ---------------------------------------------------------------------------------------------
// Run every kill
// ---------------------------------------------------------------------------------------------
const specs = await loadSpecs();
const results = [];

for (const spec of specs) {
  const src = readFileSync(join(REPO_ROOT, spec.engine), 'utf8');
  const roles = readRoles(src);
  // EVERY unsafe terminal, not just the `park-unsafe` key: an engine may carry several, and a scenario that
  // can reach only one of them would print a PASS from a single-key lookup for a case it could not see.
  const unsafeStatuses = new Set(Object.entries(readHaltStatus(src))
    .filter(([k]) => /unsafe/.test(k))
    .map(([, v]) => v));

  // Walk the scenario table in order, tracing each one ONCE, until every role has its first spawning
  // scenario. Order is the spec's own, so the pick is deterministic and re-reading the spec explains it.
  const pick = new Map();
  for (const sc of spec.scenarios) {
    if (pick.size === roles.length) break;
    const trace = await runTrace(spec.engine, { args: sc.args, respond: sc.respond ?? {}, budget: sc.budget });
    for (const call of trace.calls) {
      const r = roleOf(call.label, roles);
      if (r && !pick.has(r)) pick.set(r, { sc, baseline: trace });
    }
  }

  for (const role of roles) {
    const key = `${spec.name} x ${role}`;
    const hit = pick.get(role);
    if (!hit) { results.push({ key, spec, role, unspawned: true }); continue; }
    const { sc, baseline } = hit;

    const killer = killFirst(spec, roles, role, sc.respond);
    const kill = await runTrace(spec.engine, { args: sc.args, respond: killer.responder, budget: sc.budget });

    const newLogs = kill.logs.filter((l) => !baseline.logs.includes(l));
    results.push({
      key,
      spec,
      role,
      scenario: sc.name,
      killApplied: killer.applied,
      unsafeStatuses,
      killStatus: kill.terminal.status,
      terminalDiffers: termOf(baseline.terminal) !== termOf(kill.terminal),
      terminalText: termText(kill.terminal),
      deathLogs: newLogs.filter((l) => DEATH_WORDS.test(l)),
      newLogs,
      fieldDiffers: (field) => j(baseline.out?.[field]) !== j(kill.out?.[field]),
    });
  }
}

const allowKey = (a) => `${a.engine} x ${a.role}`;
const allowed = new Set(ALLOW.map(allowKey));
/** Did this kill produce the signal its table entry demands? */
function signalled(r, entry) {
  if (entry.signal === 'terminal') return r.terminalDiffers && entry.expect.test(r.terminalText);
  if (entry.signal === 'log') return r.deathLogs.some((l) => entry.expect.test(l));
  if (entry.signal === 'field') return r.fieldDiffers(entry.field);
  return false;
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

section(`${results.length} engine x role kills across ${specs.length} engine(s)`);
ok(results.length > 0, results.length
  ? `sweeping ${specs.map((s) => `${s.name}`).join(', ')}`
  : 'no engine x role pair was enumerated — every check below would be vacuously green');

section('every role of every engine is spawned by some scenario, so every role can be killed');
// flow-coverage.test.mjs already gates this from the map's side; asserted again here because a role no
// scenario spawns silently costs this file a whole check rather than failing it.
for (const r of results) {
  ok(!r.unspawned, r.unspawned
    ? `${r.key}: no scenario of ${r.spec.name}.flow.mjs spawns this role — add one, or the death policy for ${r.role} is untested`
    : `${r.key}: killed inside "${r.scenario}"`);
}

section('the expected-signal table names every engine x role, and nothing else');
// The table is the specification. A role missing from it is an untested death policy; a stale entry is a
// role (or an engine) that no longer exists, and would go on excusing nothing forever.
{
  const live = results.map((r) => r.key);
  const missing = live.filter((k) => !(k in EXPECTED));
  const stale = Object.keys(EXPECTED).filter((k) => !live.includes(k));
  ok(missing.length === 0, missing.length
    ? `EXPECTED has no entry for ${missing.join(', ')} — record the signal that role's death must produce`
    : `all ${live.length} engine x role pair(s) carry an expected signal`);
  ok(stale.length === 0, stale.length
    ? `EXPECTED still names ${stale.join(', ')}, which no engine spawns — drop the entry`
    : 'no stale entries');
}

section('the kill actually landed on every run');
// A null that was never delivered (a shadowed prefix, a role the scenario stopped reaching) makes the
// comparison meaningless — and meaninglessly GREEN. Loud, never skipped.
for (const r of results.filter((x) => !x.unspawned)) {
  ok(r.killApplied, r.killApplied
    ? `${r.key}: the null reached the ${r.role} agent`
    : `${r.key}: the null was NEVER delivered inside "${r.scenario}" — the comparison below proves nothing`);
}

section('a dead agent produces the signal its death policy promises');
for (const r of results.filter((x) => !x.unspawned && x.killApplied)) {
  const entry = EXPECTED[r.key];
  if (!entry) continue;                                  // already reported by the table check above
  if (allowed.has(r.key)) continue;                      // handled by the allowlist section below
  const got = signalled(r, entry);
  const want = entry.signal === 'field'
    ? `out.${entry.field} to differ from the healthy run`
    : `a ${entry.signal} matching ${entry.expect}`;
  ok(got, got
    ? `${r.key}: ${entry.signal} signal — ${entry.signal === 'field' ? `out.${entry.field} changed` : `"${(entry.signal === 'log' ? r.deathLogs.find((l) => entry.expect.test(l)) : r.terminalText).trim().slice(0, 80)}"`}`
    : `${r.key}: killing ${r.role} inside "${r.scenario}" left ${want} unproduced — the dead path is laundered into a healthy one (WORKFLOW-PRINCIPLES.md #15). Terminal ${r.terminalDiffers ? 'differed' : 'was IDENTICAL'}; ${r.deathLogs.length} new death-vocabulary log line(s)`);
}

section('develop: a dead developer, quality reviewer or acceptance verifier inside a FIX block');
// The sweep kills each role in the FIRST scenario that spawns it, which is always a feature block. The fix
// frame reaches the same three roles through its own branches (derived `produced`, the round-1 terminals),
// so each is killed again inside a fix block, and each death must name its own role.
{
  const FIX_SCENARIO = 'a fix block closes its issues';
  const REASONS = { develop: 'Developer', quality: 'Quality reviewer', acceptance: 'Acceptance verifier' };
  const spec = specs.find((s) => s.name === 'develop');
  const sc = spec?.scenarios.find((s) => s.name === FIX_SCENARIO);
  const fixId = sc?.args.plans.find((b) => b.mode === 'fix')?.id ?? '';
  ok(fixId !== '', fixId
    ? `develop.flow.mjs "${FIX_SCENARIO}" runs fix block ${fixId}`
    : `develop.flow.mjs has no "${FIX_SCENARIO}" scenario with a fix block — the three kills below cannot run`);
  if (fixId) {
    const roles = readRoles(readFileSync(join(REPO_ROOT, spec.engine), 'utf8'));
    const baseline = await runTrace(spec.engine, { args: sc.args, respond: sc.respond });
    const reasons = new Set();
    for (const [role, who] of Object.entries(REASONS)) {
      const killer = killFirst(spec, roles, role, sc.respond);
      const kill = await runTrace(spec.engine, { args: sc.args, respond: killer.responder });
      const reason = kill.out?.haltReason ?? '';
      reasons.add(reason);
      ok(killer.applied && killer.label.includes(fixId), `${role}: the null landed on "${killer.label}", inside the fix block`);
      ok(termOf(kill.terminal) !== termOf(baseline.terminal), `${role}: the run ended differently from the healthy fix run`);
      ok(/BLOCKED \(an agent returned nothing/.test(kill.terminal.status), `${role}: on the agent-dead terminal: ${kill.terminal.status}`);
      ok(reason.startsWith(`${who} for block ${fixId} returned nothing`), `${role}: the halt reason names the ${who.toLowerCase()}`);
      ok(kill.out?.ledger?.[0]?.status === 'BLOCKED (agent died)', `${role}: the ledger says the agent died`);
      ok(kill.calls.some((c) => c.label === `park:${fixId}`), `${role}: the fix block's work is parked`);
    }
    ok(reasons.size === Object.keys(REASONS).length, 'each of the three deaths reads differently, so the operator knows which agent to replay');
  }
}

section('no non-park kill is disguised as an unsafe park');
// The PARK_OK merge exists for exactly this: without it the halt these engines take on a dead round-loop
// agent gets rewritten to `park-unsafe` by the unscripted park, and the sweep reads a difference that
// would still be there with the death guard deleted.
for (const r of results.filter((x) => !x.unspawned && x.unsafeStatuses.size && x.role !== 'park')) {
  const disguised = r.unsafeStatuses.has(r.killStatus);
  ok(!disguised, disguised
    ? `${r.key}: the kill ended on "${r.killStatus}" — one of ${r.spec.name}'s unsafe-park terminals, not on a death signal; the park response was not scripted`
    : `${r.key}: ends on a death signal, not on any of ${r.spec.name}'s ${r.unsafeStatuses.size} unsafe-park terminal(s)`);
}

section('every allowlist entry is explained and still needed');
// Cannot-rot: an entry whose kill DOES signal now is itself red. Empty today, and meant to stay empty.
for (const a of ALLOW) {
  const key = allowKey(a);
  const r = results.find((x) => x.key === key);
  const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
  ok(reason !== '', reason
    ? `${key}: allowed — ${reason}`
    : `${key}: an allowlist entry needs a non-empty reason — an unexplained exemption is a hole nobody can review`);
  ok(!!r, r ? `${key}: names a live engine x role` : `${key}: matches no engine x role — drop it`);
  if (!r) continue;
  const entry = EXPECTED[key];
  ok(!(entry && signalled(r, entry)), entry && signalled(r, entry)
    ? `${key}: drop this allowlist entry — the kill produces its expected signal now`
    : `${key}: still invisible, so the exemption is still load-bearing`);
}
