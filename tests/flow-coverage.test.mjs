// The flow specs read BACK as assertions about their engine.
// tests/flows.test.mjs tests the EMITTER — whether the derivation draws what really happened. This file
// tests the ENGINES through the specs: a role no scenario spawns, a throw site nothing reaches, a
// HALT_STATUS value no run produces, and `meta.phases` drifting from the phases agents really run under.
// Three of those have no other check in the suite, and `meta` (description / whenToUse / phases) is what
// the Workflow tool shows a user at launch — until now the one part of an engine with no verification at
// all. A committed FLOW.md cannot silently go stale here either, and an untested branch cannot hide
// behind a pretty diagram.
//
// ONE `buildGraph(spec)` PER SPEC feeds every check below. Re-running the scenario table per assertion
// would multiply the suite's runtime for nothing, and re-deriving coverage independently of the emitter
// would create a second source of truth the committed diagram could contradict.
//
// Messages are built AT THE CALL SITE. `ok(cond, msg)` prints the same string whether it passes or
// fails, so a static "add a scenario that reaches investigate-cycle.mjs:345" would print beside a green
// checkmark and a passing run would read as a to-do list.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildGraph, generate, loadSpecs } from '../tools/gen-flows.mjs';
import { ENGINES, REPO_ROOT, readRoles, readThrows, readHaltStatus, readMeta, section, ok, eq } from './harness.mjs';

// ---------------------------------------------------------------------------------------------
// Throw coverage units — the one piece of derivation this file owns
// ---------------------------------------------------------------------------------------------

/**
 * Fold `readThrows` sites into COVERAGE UNITS. The longest-prefix match itself lives in gen-flows'
 * `siteOf` and is what produced `coveredLines`; this only decides what a hit is allowed to PROVE.
 *   • Two sites with an identical prefix are indistinguishable from one another — a message matching
 *     both is credited to whichever comes first, so they are ONE unit, flagged `ambiguous` so the
 *     ambiguity is visible instead of silently satisfied by a scenario that reached only one of them.
 *   • An EMPTY prefix (a message starting with an interpolation) matches every message, so a hit on it
 *     proves nothing: reported `unmatchable`, never covered.
 * @param {{line:number, prefix:string}[]} sites  readThrows-shaped, source order
 * @param {number[]} coveredLines  the lines the graph's scenarios really reached
 */
function throwUnits(sites, coveredLines) {
  const covered = new Set(coveredLines);
  const units = [];
  for (const site of sites) {
    const unmatchable = site.prefix === '';
    const twin = unmatchable ? undefined : units.find((u) => !u.unmatchable && u.prefix === site.prefix);
    if (twin) {
      twin.lines.push(site.line);
      twin.ambiguous = true;
      twin.covered = twin.covered || covered.has(site.line);
      continue;
    }
    units.push({
      prefix: site.prefix,
      lines: [site.line],
      ambiguous: false,
      unmatchable,
      covered: !unmatchable && covered.has(site.line),
    });
  }
  return units;
}

/** The imperative fix for one unreached unit, naming the engine and line. */
function fixFor(engine, unit) {
  const where = `${engine}:${unit.lines.join('/')}`;
  if (unit.unmatchable) {
    return `give ${where} a static message prefix — a message starting with an interpolation can never be keyed to a scenario`;
  }
  if (unit.ambiguous) return `add a scenario that reaches ${where} (identical message at both sites — one unit)`;
  return `add a scenario that reaches ${where} ("${unit.prefix.slice(0, 48)}")`;
}

/** Every `phase('X')` call site's title, source order, deduped. Every engine passes a literal, so this
 *  is a superset of what any run can fire — and it costs no extra run of the scenario table. */
const phaseCalls = (src) => [...new Set([...src.matchAll(/\bphase\(\s*'([^']*)'\s*\)/g)].map((m) => m[1]))];

// ---------------------------------------------------------------------------------------------
// Inputs — every spec on disk, one graph each
// ---------------------------------------------------------------------------------------------
const specs = await loadSpecs();

section(`${specs.length} flow spec(s) enumerated from tools/flows/`);
ok(specs.length > 0, specs.length
  ? `checking ${specs.map((s) => s.name).join(', ')}`
  : 'tools/flows/ holds no spec — every check in this file would be vacuously green');

const observed = [];
for (const spec of specs) {
  const src = readFileSync(join(REPO_ROOT, spec.engine), 'utf8');
  const sites = readThrows(src);
  const graph = await buildGraph(spec);
  const uncoveredLines = new Set(graph.coverage.throws.uncovered.map((t) => t.line));
  observed.push({
    spec,
    graph,
    sites,
    roles: readRoles(src),
    halt: readHaltStatus(src),
    meta: readMeta(src) ?? {},
    fired: phaseCalls(src),
    units: throwUnits(sites, sites.filter((s) => !uncoveredLines.has(s.line)).map((s) => s.line)),
    // An uncovered site is EXEMPT only where allowUncovered gave a reason — resolved by buildGraph, so
    // the exemption the diagram prints and the one the gate honors are the same computation.
    exemptLines: new Set(graph.coverage.throws.uncovered.filter((t) => t.reason).map((t) => t.line)),
    uncoveredLines,
  });
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

section('every engine in ENGINES has a flow spec');
// The closing check. Every other assertion in this file iterates the SPECS, so an engine no spec names is
// invisible to all of them: a tenth engine would ship with no map, no role coverage and no throw coverage,
// and the suite would stay green. Driving it off ENGINES — the same list the static checks use — is what
// makes "unmapped" a failure rather than an absence.
{
  const mapped = new Set(specs.map((s) => s.engine));
  const unmapped = ENGINES.filter((e) => !mapped.has(e));
  ok(unmapped.length === 0, unmapped.length
    ? `no flow spec maps ${unmapped.join(', ')} — add tools/flows/<name>.flow.mjs for it`
    : `all ${ENGINES.length} engine(s) in ENGINES are mapped by a spec`);
}

section('every role the engine can spawn is spawned by some scenario');
for (const { spec, graph, roles } of observed) {
  const missing = graph.coverage.roles.uncovered;
  ok(missing.length === 0, missing.length
    ? `${spec.name}: add a scenario that spawns ${missing.join(', ')} of ${spec.engine}`
    : `${spec.name}: all ${roles.length} role(s) spawned — ${roles.join(', ')}`);
}

section('every throw site is reached by some scenario');
for (const { spec, sites, units, exemptLines } of observed) {
  // Reported even when covered: a scenario reaching one of two identical messages says nothing about
  // the other, and burying that in a green count is how a dead branch keeps its checkmark.
  for (const u of units.filter((x) => x.ambiguous)) {
    console.log(`      note: ${spec.engine} lines ${u.lines.join(', ')} share one message — counted as ONE unit`);
  }
  const exempt = (u) => u.lines.every((l) => exemptLines.has(l));
  const missing = units.filter((u) => u.unmatchable || (!u.covered && !exempt(u)));
  const excused = units.filter((u) => !u.covered && !u.unmatchable && exempt(u)).length;
  ok(missing.length === 0, missing.length
    ? `${spec.name}: ${missing.map((u) => fixFor(spec.engine, u)).join('; ')}`
    : `${spec.name}: all ${units.length} throw unit(s) accounted for across ${sites.length} site(s)${excused ? `, ${excused} allowed uncovered` : ''}`);
}

section('every HALT_STATUS value is produced by some scenario');
for (const { spec, graph, halt } of observed) {
  // 6 of 9 engines carry no HALT_STATUS map, so a SILENT skip here would be indistinguishable from a
  // pass for the common case. Name the engine instead.
  if (!Object.keys(halt).length) {
    console.log(`      note: ${spec.engine} has no HALT_STATUS map — terminal coverage not checked`);
    continue;
  }
  const missing = graph.coverage.statuses.uncovered;
  ok(missing.length === 0, missing.length
    ? `${spec.name}: add a scenario ending in ${missing.join(' / ')}`
    : `${spec.name}: all ${graph.coverage.statuses.total} HALT_STATUS terminal(s) produced`);
}

section('meta.phases agrees with the phases agents really run under');
// Measured against `opts.phase` — the runtime's per-agent assignment — NOT against fired phase() calls.
// review.mjs and enhance-cycle never call phase() and docs-cycle calls it once against three declared
// phases; measuring the calls would report three engines as drifted and the "fix" would be deleting
// correct, user-facing launch documentation.
for (const { spec, graph, meta } of observed) {
  const authored = (Array.isArray(meta.phases) ? meta.phases : []).map((p) => String(p.title ?? ''));
  const running = [...new Set(graph.nodes.filter((n) => n.kind === 'agent').map((n) => n.phase).filter(Boolean))];
  const undeclared = running.filter((p) => !authored.includes(p));
  const unreached = authored.filter((p) => !running.includes(p));
  const drift = [
    ...undeclared.map((p) => `agents run under "${p}" but meta.phases never declares it`),
    ...unreached.map((p) => `meta.phases declares "${p}" but no agent runs under it`),
  ];
  ok(drift.length === 0, drift.length
    ? `${spec.name}: ${drift.join('; ')} — fix meta.phases or the agents' opts.phase`
    : `${spec.name}: ${authored.length} declared phase(s) match what runs — ${authored.join(', ')}`);
}

section('every phase() title an engine fires is declared in meta.phases');
// One direction only. A declared phase that phase() never names is correct (docs-cycle), and the
// opts.phase check above already owns the other direction.
for (const { spec, meta, fired } of observed) {
  if (!fired.length) continue;                       // an engine that carries its phase on opts.phase only
  const authored = (Array.isArray(meta.phases) ? meta.phases : []).map((p) => String(p.title ?? ''));
  const stray = fired.filter((t) => !authored.includes(t));
  ok(stray.length === 0, stray.length
    ? `${spec.name}: phase('${stray.join("'), phase('")}') names no entry of meta.phases — add it or rename the call`
    : `${spec.name}: ${fired.length} phase() title(s) all declared — ${fired.join(', ')}`);
}

section('the committed FLOW.md matches a fresh generation from the same graph');
for (const { spec, graph } of observed) {
  const fresh = generate(spec, graph);
  let committed = null;
  try { committed = readFileSync(join(REPO_ROOT, spec.out), 'utf8'); } catch { committed = null; }
  ok(committed === fresh, committed === fresh
    ? `${spec.out} is fresh`
    : `${spec.out} is ${committed === null ? 'missing' : 'stale'} — run \`node tools/gen-flows.mjs ${spec.name}\` and commit the result`);
}

section('a throw label is the WHOLE first clause of its message, never an ellipsised one');
// The clause cut is a deliberate reduction (messages run to 289 characters, into paragraphs of resume
// instructions); a character cap on top of it was not. It used to ellipsise at 52, which put
// "throw: args must include at least { runId, root, target, s…" on a published page. Asserting the label
// is a literal PREFIX of the static message catches any truncation without restating the cut list here —
// two copies of that list is how the diagram and its gate come to disagree.
for (const { spec, graph, sites } of observed) {
  const byLine = new Map(sites.map((s) => [s.line, String(s.prefix ?? '').replace(/\s+/g, ' ').trim()]));
  const throws = graph.terminals.filter((t) => t.source === 'throw');
  const cut = throws.filter((t) => {
    const full = byLine.get(t.line) ?? '';
    return full && !full.startsWith(t.label.replace(/^throw: /, ''));
  });
  ok(cut.length === 0, cut.length
    ? `${spec.name}: ${cut.map((t) => `line ${t.line} shows "${t.label}"`).join('; ')} — not a literal prefix of the thrown message, so the label was truncated`
    : `${spec.name}: all ${throws.length} throw label(s) are whole clauses of their message`);
}

section('the Terminal states table says what reaches each terminal');
// Edges into a terminal are drawn UNLABELLED on purpose — one agent fans out to six endings and Mermaid
// piles those labels on top of each other — so this column is the ONLY place a reader can learn what
// reaches an ending. buildGraph collected the conditions and the projection dropped them, which left the
// column blank in all nine committed maps: the conditions were on no arrow and in no table. Asserted on
// the RENDERED row, so neither the projection nor the emitter can lose them again.
const tableCells = (row) => row.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
for (const { spec, graph } of observed) {
  const body = generate(spec, graph).split('## Terminal states')[1]?.split('\n## ')[0] ?? '';
  const rows = body.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*-+/.test(l)).slice(1);
  const blank = rows.filter((r) => !tableCells(r)[1]).map((r) => tableCells(r)[0]);
  ok(rows.length === graph.terminals.length && blank.length === 0, blank.length
    ? `${spec.name}: ${blank.length} terminal(s) print no condition (${blank.slice(0, 2).join('; ')}) — the "Reached when" column is where an unlabelled edge's conditions live`
    : `${spec.name}: all ${rows.length} terminal row(s) name what reaches them`);
}

section('no generated map carries an em dash');
// The maps are published on a user-facing site whose house style takes no em dash, and every source that
// feeds one is prose someone edits freely: engine HALT_STATUS strings, meta.phases details, throw
// messages, and the scenario `when` lines. `dedash` flattens the finished document precisely so none of
// those has to remember — this asserts it, over every real spec, so the day the emitter grows a path that
// bypasses it the gate says so instead of the site. Asserting the FRESH text is enough: the freshness
// check above already binds the committed bytes to it, and a hand-edited dash fails there.
for (const { spec, graph } of observed) {
  const hits = [...new Set(generate(spec, graph).match(/[–—―]/g) ?? [])];
  ok(hits.length === 0, hits.length
    ? `${spec.out} emits ${hits.join(' ')} — every dash must reach the page as an ASCII hyphen`
    : `${spec.out} is free of em, en and horizontal-bar dashes`);
}

section('allowUncovered exemptions are explained and still needed');
// A stale exemption quietly widens the hole it documents: the throw it excused is covered now (or gone),
// and the entry goes on excusing whatever else its prefix happens to match.
for (const { spec, sites, uncoveredLines } of observed) {
  for (const entry of spec.allowUncovered?.throws ?? []) {
    const named = sites.filter((s) => entry.prefix && s.prefix.startsWith(entry.prefix));
    const stillOpen = named.filter((s) => uncoveredLines.has(s.line));
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    ok(reason !== '', reason
      ? `${spec.name}: allowUncovered "${entry.prefix}" says why — ${reason}`
      : `${spec.name}: allowUncovered "${entry.prefix}" needs a non-empty reason — an unexplained exemption is a hole nobody can review`);
    ok(stillOpen.length > 0, stillOpen.length
      ? `${spec.name}: and still names ${stillOpen.length} uncovered site(s)`
      : `${spec.name}: drop allowUncovered "${entry.prefix}" — it ${named.length ? 'excuses only sites that are covered now' : `matches no throw site of ${spec.engine}`}`);
  }
}

section('the throw matcher folds duplicate messages and refuses an empty prefix');
// Zero of each across every real site, so a synthetic readThrows-shaped list is the only way to exercise
// these two branches — and the two most confusing coverage reports must not be the two nobody has seen.
{
  const synthetic = [
    { line: 10, prefix: 'args.root is required' },
    { line: 20, prefix: 'args.root is required' },   // same message, two sites
    { line: 30, prefix: '' },                        // message starts with an interpolation
    { line: 40, prefix: 'nothing reaches this' },
  ];
  const units = throwUnits(synthetic, [10, 30]);
  eq(units.length, 3, 'four sites fold into three coverage units');

  const twins = units.find((u) => u.prefix === 'args.root is required');
  eq(twins.lines.join('+'), '10+20', 'both lines ride on the one unit');
  ok(twins.ambiguous, 'flagged ambiguous — reaching line 10 proves nothing about line 20');
  ok(twins.covered, 'and covered, because no scenario could tell the two apart');

  const blind = units.find((u) => u.lines.includes(30));
  ok(blind.unmatchable, 'the empty-prefix site is unmatchable');
  ok(!blind.covered, 'and NOT covered even though the graph credited it — an empty prefix matches everything');
  ok(!units.find((u) => u.lines.includes(40)).covered, 'an unreached site with a static prefix is simply uncovered');
  ok(/give e.mjs:30 a static message prefix/.test(fixFor('e.mjs', blind)), 'and its fix says so, rather than "add a scenario"');
}

section('the gen-flows CLI agrees with the assertions above');
// Same graphs, different entry point: --check is what a gate would run, and it must not disagree with
// the staleness assertion two sections up.
{
  let err = '';
  try {
    execFileSync(process.execPath, [join(REPO_ROOT, 'tools/gen-flows.mjs'), '--check'], { stdio: 'pipe' });
  } catch (e) {
    err = String(e.stderr || e.stdout || e.message).trim().split('\n').filter(Boolean).pop() ?? 'exited non-zero';
  }
  ok(err === '', err
    ? `node tools/gen-flows.mjs --check failed — ${err}`
    : 'node tools/gen-flows.mjs --check exits 0 on this tree');
}
