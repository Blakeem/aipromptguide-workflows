#!/usr/bin/env node
// Deterministic Mermaid flow-map generator (plain Node — run it directly, unlike the engines it reads).
//
// It runs a per-engine SCENARIO TABLE through tests/harness.mjs (`runTrace` — scripted agent returns, no
// model calls), folds every resulting trace into ONE graph, and writes a `FLOW.md` beside the engine.
// Nothing is parsed out of the engine's control flow: the graph is WATCHED, so it can only ever show
// paths that really run. The only static facts used are the three the harness readers already expose
// (roles, throw sites, `meta`).
//
// Usage:
//   node tools/gen-flows.mjs                  # regenerate every spec in tools/flows/
//   node tools/gen-flows.mjs investigate      # just that one
//   node tools/gen-flows.mjs --check          # write nothing; exit 1 naming stale files
//   node tools/gen-flows.mjs investigate --json   # print the graph instead of writing a file
//
// =================================================================================================
// THE SPEC CONTRACT — this header is the specification the per-engine spec plans are written against.
// The tool does not change for them; if a rule below does not cover an engine, that is a finding, not
// a licence to edit the emitter.
//
//   tools/flows/<name>.flow.mjs   default-exports
//   { engine: 'workflows/investigate/investigate-cycle.mjs',   // repo-relative, must exist
//     out:    'workflows/investigate/FLOW.md',                 // repo-relative, the generated file
//     title:  'investigate-cycle',                             // the FLOW.md heading
//     scenarios: [{ name, when, args, respond, budget?, terminal? }],
//     allowUncovered: { throws: [{ prefix, reason }] } }        // optional; coverage bookkeeping only
//
// `name` identifies the scenario in the coverage table; `when` is the human-readable condition and is
// what edge labels are built from. Loading validates: the engine file exists, there is at least one
// scenario, and every scenario carries a non-empty `name` and `when`.
//
// `budget` is optional and is passed STRAIGHT THROUGH to runTrace. Without it the harness default is
// `{ total: null, remaining: () => Infinity }`, which makes every engine's budget-floor branch dead
// code — investigate's `stopped on token budget` terminal is unreachable without one. `remaining` may
// close over run state (e.g. the live `calls` array a `respond` function is handed) so that "stopped
// cleanly BETWEEN items" is expressible and not just "stopped before the first" — but it must not carry
// state ACROSS runs. Every scenario is run more than once (the determinism test alone runs each twice),
// and a counter that survives a run silently changes the diagram on the second pass.
//
// TERMINAL IDENTITY — three sources, in priority order:
//   1. DERIVED   `out.status`, whenever it is non-empty (feature, migrate, investigate, decide).
//   2. DECLARED  the scenario's `terminal`, used when `out.status` is empty, and REQUIRED there. Five
//      engines return no `status` at all (brainstorm, review, enhance, docs, resolve); without a
//      declared label every non-throwing scenario of theirs collapses into one blank end node. A
//      declared `terminal` that CONTRADICTS a non-empty `out.status` is an error — authored text never
//      overrides derived truth.
//   3. THROWS    keyed to the STATIC THROW SITE (`readThrows` + longest-prefix match on the message),
//      and labelled from the site's prefix, never from the raw message. Three of investigate's six
//      throw messages interpolate the round number, so a scenario dying in round 1 and another in
//      round 3 would otherwise mint two nodes for one site — and break byte-stability.
// Digits in a terminal label are normalized to `N` for identity AND display
// (`roadmap complete with 1 plan(s) parked` -> `... with N plan(s) parked`). feature-cycle's is the
// repo's only interpolated status; without this, two scenarios parking different counts mint two
// terminals for one outcome. The FLOW.md terminal table marks each terminal derived or declared.
//
// GRAPH DERIVATION:
//   • NODE IDENTITY IS DERIVED. An observed label maps to a node by longest-prefix match against
//     `readRoles(engineSrc)`. A label matching no known role is a hard ERROR naming the label — never a
//     silently-created node, which would hide a role the static reader failed to see.
//   • CONCURRENCY VS. SEQUENCE inside a fan-out. Calls in one group at the same `stage`:
//       - different `group.item` -> CONCURRENT siblings: collapsed into one node annotated with the
//         observed multiplicity, and NO edge between them;
//       - same `group.item`, repeated -> SEQUENTIAL repeat: a self-loop labelled from the scenario's
//         `when`. review.mjs runs its lenses in a `for` loop inside a single pipeline stage, so both
//         shapes occur at once (2 units x 2 lenses = 4 calls at stage 0). `group.item` is the only
//         correct discriminator; treating every repeat as a back-edge draws a loop that does not exist.
//   • STAGES: calls in one group at stage `s` edge to stage `s+1`, matched by `group.item` so one
//     lane's chain never crosses into another's.
//   • UNIT-BOUNDARY EDGES. Strip the matched role prefix and any trailing `<sep>r<N>` round marker —
//     `sep` being the same `[\s:/]` class `readRoles` trims, since docs-cycle writes its round as
//     `curate:r${rounds}` — to get an observed label's ITEM ID (`develop plan-a r2` -> `plan-a`;
//     `investigate r3` -> `''`; `curate:r1` -> `''`). Consecutive calls with different non-empty item
//     ids make a BOUNDARY edge, drawn thick and labelled as advancing to the next item. That is what
//     separates "loop again on the same plan" from "advance to the next plan" in
//     feature/migrate/resolve, which would otherwise fold into one
//     `acceptance -> develop` edge meaning two different things. It is derived from labels alone;
//     nothing parses a label's internals for meaning. INSIDE one fan-out lane the boundary rule is off:
//     `group.item` is authoritative there, so review's `review:u1/x -> review:u1/y` is the sequential
//     repeat it really is, not an advance to a new unit. A boundary edge is a SEPARATE edge from a
//     same-item one between the same pair — feature-cycle observes both `acceptance -> develop` shapes
//     (retry this plan / advance to the next), and merging them on the node pair alone would re-fold the
//     exact pair this rule exists to split, printing only the "next item" advance.
//   • LOOPS: an edge into a role already seen earlier in the same trace, that is not a boundary edge,
//     is a BACK-EDGE — dotted, labelled with that scenario's `when`, annotated with the MEASURED max
//     repeat count (read from the trace, never from the engine's source). "Already seen earlier" means
//     seen no later than the SOURCE role was first seen: on round 2 investigate's `investigate ->
//     critique` also targets a role seen in round 1, and a plain "seen at all" test would draw the
//     loop body's forward edges as loop-backs — every multi-node loop would come out dotted end to end.
//   • PHASES come from each call's `opts.phase` (the runtime's per-agent assignment), NOT from fired
//     `phase()` calls — 2 of 9 engines never call `phase()` and carry the phase entirely on
//     `opts.phase`. The phases TABLE comes from `meta.phases`, which is authored prose.
//     A phase is drawn as a `subgraph` ONLY when it holds 2+ agents. No engine does that today, so none
//     is emitted — deliberately. A box around a single node labels it twice (`Investigate` wrapping
//     `investigate`) and forces Mermaid to route every crossing edge AROUND the boundary, which is what
//     made back-edges vanish behind neighbouring boxes. Instead the phase rides on the node, and only
//     when it differs from the role name (`criteria-critic` → Refine earns it; `develop` → Develop
//     does not).
//
// OUTPUT is byte-stable: no timestamps (a timestamp makes `--check` always fail), every collection in a
// fixed order (source order for roles, phases and throw sites; spec order for scenarios and terminals).
// It is also DASH-FREE: the finished document is flattened to ASCII hyphens (`dedash`), because the maps
// are published on a user-facing site whose house style takes no em dash. That is the last step before
// the bytes are returned, so it covers authored engine prose, spec `when` strings and this generator's
// own headings alike — and nothing upstream needs to know about it.
// All Mermaid node and edge text is quoted, which is what lets a terminal such as
// `exhaustive (search closed, critic agreed)` render — unescaped parentheses break the parser. Inside
// the quotes only the two characters that still delimit the syntax being emitted are escaped: `"` (ends
// the string) and `|` (ends an edge label), as `#quot;` / `#124;`.
//
// ONE GRAPH COMPUTATION: `buildGraph(spec)` runs the scenarios once and returns
// `{ nodes, edges, terminals, phases, loops, coverage }`; `generate(spec, graph)` only formats it. The
// coverage line in FLOW.md and the numbers a linter asserts are therefore the SAME computation — two
// independent derivations can disagree, and then the committed diagram contradicts the gate.
// =================================================================================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runTrace, readMeta, readRoles, readThrows, readHaltStatus, INTERP, REPO_ROOT } from '../tests/harness.mjs';

const FLOWS_DIR = fileURLToPath(new URL('flows/', import.meta.url));
const START_ID = 'S0';

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

/** Digits -> N, so two terminals differing only in a count are ONE outcome. */
const normDigits = (s) => String(s).replace(/\d+/g, 'N');

/** Mermaid text: everything is quoted, so only the two characters that still delimit need an entity. */
const esc = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/"/g, '#quot;').replace(/\|/g, '#124;');

/** A markdown table cell: `|` would end the cell, `<...>` would be eaten as a tag by some renderers. */
const cell = (s) => String(s).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * House style for the published maps takes no em dash, so the finished document is flattened to ASCII
 * hyphens — em, en and horizontal bar alike (`2–4` -> `2-4`). It runs ONCE over the whole text rather
 * than inside `esc`/`cell`, so the generator's own headings are covered too and a later literal cannot
 * slip a dash past it. PRESENTATION ONLY: the graph, and every engine string it carries, is untouched —
 * `--json` still prints a halt status byte-exact, and the terminal-identity rules above still compare
 * the engine's real text. Substitution is 1:1 in characters, so no label changes width and the tuned
 * layout constants keep meaning what they measured.
 */
const dedash = (s) => s.replace(/[\u2013\u2014\u2015]/g, '-');

/**
 * A throw node is keyed to its SITE; its LABEL is the first clause of that site's static prefix —
 * three of investigate's messages continue into a paragraph of resume instructions, and several end in
 * `; got typeof=` + an interpolation, so the whole prefix (up to 289 characters) belongs in no box.
 * The clause cut is the ONLY reduction; what survives it is emitted WHOLE.
 *
 * The separators are matched against ENGINE SOURCE, which keeps its em dashes — `dedash` runs on the
 * finished document, long after this. Do not "tidy" the ` — ` entry away.
 *
 * There used to be a further 52-character ellipsis cap here. It is gone, and should not come back:
 *   • Its reason was that a throw box is wide and a neighbouring SELF-LOOP's label lands on top of one.
 *     Self-loops have carried a bounded marker (`L1 ×4`) instead of authored text since, so the
 *     collision it guarded against can no longer happen (tests/CLAUDE.md §7).
 *   • It was not even the binding constraint. The longest clause in the repo is 78 characters, while the
 *     widest box on these maps is already a 104-character TERMINAL, which nothing caps. Capping throws
 *     alone shortened the diagram by nothing and cost a published page its text.
 * §7: room is free, dropped information is not. If a map is ever genuinely too wide, raise the spacing
 * constants or wrap the label with `<br/>` — do not silently drop characters.
 */
const CLAUSE_SEPS = [' — ', ': ', ' (', '; ', '. '];
const CLOSER = { '(': ')', '[': ']', '{': '}' };

/**
 * The first clause separator that is not inside something, or -1. Three spans are ATOMIC to the scan:
 *   • BRACKETS. feature-cycle's arg list is
 *     `{ runId, planPath | plan (markdown string) | plans:[{…}], target, gates }; got typeof=`, whose
 *     first ` (` sits inside the braces — cutting there produced `args must include at least { runId,
 *     planPath | plan`: an unbalanced brace ending on a dangling `|`.
 *   • DOUBLE QUOTES. `holding their "## Plan: <id>" blocks — …` has a `: ` inside the quotes, and
 *     cutting there ended a node mid-quote at `their "## Plan`. Single quotes are NOT tracked: these
 *     messages are English prose full of apostrophes ("this section's review files"), and treating one
 *     as an opener leaves the scan unbalanced for the rest of the message.
 *   • THE ELIDED VALUE. `INTERP` is `...`, whose last character plus the following space IS the `. `
 *     sentence separator — `args.runOnly ${…} matches no plan id` cut down to `args.runOnly ..`.
 * An unbalanced message (a stray bracket, an unpaired quote) leaves the scan open and returns -1 rather
 * than the whole 289-character message; the caller falls back to the depth-blind cut.
 */
function clauseEnd(s) {
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith(INTERP, i)) { i += INTERP.length - 1; continue; }
    if (!stack.length) for (const sep of CLAUSE_SEPS) if (s.startsWith(sep, i)) return i;
    const ch = s[i];
    if (ch === '"') stack[stack.length - 1] === '"' ? stack.pop() : stack.push('"');
    else if (CLOSER[ch]) stack.push(CLOSER[ch]);
    else if (ch === stack[stack.length - 1]) stack.pop();
  }
  return stack.length ? -1 : s.length;
}

export function firstClause(message) {
  const s = String(message ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '(message built at runtime)';
  const end = clauseEnd(s);
  if (end >= 0) return s.slice(0, end);
  // Unbalanced: fall back to the depth-blind cut rather than emitting the whole message. Still better
  // than no clause at all, and the balanced case above is what every site in the repo actually hits.
  const cuts = CLAUSE_SEPS.map((sep) => s.indexOf(sep)).filter((i) => i > 0);
  return s.slice(0, cuts.length ? Math.min(...cuts) : s.length);
}

/** The scenario conditions on an edge, capped so one shared terminal cannot produce an unreadable label. */
// Edge labels are budgeted by LENGTH, not by a fixed count. Mermaid does no collision avoidance on edge
// labels, so two long ones leaving the same node render on top of each other and neither can be read —
// and conditions vary from ~20 to ~55 characters, so "always show 2" produced 117-character labels.
// Greedy fill to WHEN_BUDGET, always at least one: short pairs still both show (which some specs rely on
// to keep a branch visible), long ones collapse to one plus a count. The terminal table below the
// diagram lists every scenario reaching each terminal, so nothing is lost, only moved.
const WHEN_BUDGET = 70;

// Layout spacing, tuned against tools/render-flows.mjs (real Mermaid, measured boxes). Raise these
// before shortening labels further: room is free, dropped information is not.
// Swept with render-flows.mjs: 60/90 left 8 of 9 maps with colliding labels, 80/200 leaves 1. Past 200
// the diagrams just get taller with nothing gained. The env overrides exist so the sweep is repeatable.
const NODE_SPACING = Number(process.env.FLOW_NODE_SPACING ?? 80);
const RANK_SPACING = Number(process.env.FLOW_RANK_SPACING ?? 200);
// (There is deliberately no self-loop character budget. Tightening one was tried and measured: it moved
// the collision to a third map rather than removing it, because the gutter Mermaid parks those labels in
// is fixed and its width has nothing to do with the text. Self-loops carry a marker instead — edgeLine.)
// The budget bounds the FINAL RENDERED label, so both suffixes are charged against it: the " · +N more"
// tail this function adds when it truncates, and the caller's "(×N)" repeat count via `reserve`. Charging
// only the conditions let a self-loop budgeted at 34 emit 50 characters into a gutter sized for 34 — which
// is exactly how a label came to sit on top of its neighbouring node in two maps. Shrink from the whole
// list rather than filling up to it, so the tail is priced the moment it appears.
export const whenLabel = (whens, budget = WHEN_BUDGET, reserve = 0) => {
  const room = Math.max(8, budget - reserve);
  const render = (n) => whens.slice(0, n).join(' · ') + (whens.length - n > 0 ? ` · +${whens.length - n} more` : '');
  let n = whens.length;
  while (n > 1 && render(n).length > room) n--;
  // A single condition over budget is returned WHOLE, never ellipsised. Truncating it is pure loss: a
  // back-edge label is not a terminal, so the Terminal-states table does not carry it — its `Reached when`
  // column is empty in every generated map — and nothing else in the document does either. The budget's
  // job is to decide HOW MANY conditions to show, not to shave characters off the last survivor; an
  // ellipsis here cost three non-colliding maps their final words to save one character each, and ate the
  // "+N more" tail that told the reader other conditions existed. §7: room is free, dropped text is not.
  return render(n);
};

// ---------------------------------------------------------------------------------------------
// Spec loading + validation
// ---------------------------------------------------------------------------------------------

function validateSpec(spec) {
  const where = spec?.title || spec?.engine || '(spec)';
  const str = (v) => typeof v === 'string' && v.trim() !== '';
  if (!spec || typeof spec !== 'object') throw new Error('flow spec must be an object (default-export it)');
  if (!str(spec.engine)) throw new Error(`${where}: spec.engine must be a repo-relative engine path`);
  if (!str(spec.out)) throw new Error(`${where}: spec.out must be a repo-relative FLOW.md path`);
  if (!str(spec.title)) throw new Error(`${where}: spec.title must be a non-empty string`);
  try {
    if (!statSync(join(REPO_ROOT, spec.engine)).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`${where}: engine ${spec.engine} does not exist under ${REPO_ROOT}`);
  }
  if (!Array.isArray(spec.scenarios) || !spec.scenarios.length) {
    throw new Error(`${where}: spec.scenarios must hold at least one scenario`);
  }
  for (const [i, sc] of spec.scenarios.entries()) {
    if (!str(sc?.name)) throw new Error(`${where}: scenario #${i + 1} needs a non-empty name`);
    if (!str(sc?.when)) throw new Error(`${where}: scenario "${sc?.name ?? i + 1}" needs a non-empty when (it becomes an edge label)`);
    if (sc.terminal !== undefined && !str(sc.terminal)) {
      throw new Error(`${where}: scenario "${sc.name}" declares an empty terminal — drop the field or name the exit`);
    }
  }
}

/** Every spec file in tools/flows/, in name order. `names` filters by file basename. */
export async function loadSpecs(names = []) {
  let files;
  try {
    files = readdirSync(FLOWS_DIR).filter((f) => f.endsWith('.flow.mjs')).sort();
  } catch {
    throw new Error(`no spec directory at ${FLOWS_DIR}`);
  }
  const available = files.map((f) => f.replace(/\.flow\.mjs$/, ''));
  const wanted = names.length ? names : available;
  const unknown = wanted.filter((n) => !available.includes(n));
  if (unknown.length) throw new Error(`no flow spec named ${unknown.join(', ')} — have: ${available.join(', ')}`);

  const specs = [];
  for (const name of wanted) {
    const file = join(FLOWS_DIR, `${name}.flow.mjs`);
    const mod = await import(pathToFileURL(file).href);
    if (!mod.default) throw new Error(`${file} has no default export`);
    // `name` is set by the loader only (it is not part of the spec contract): the banner in FLOW.md has
    // to name the exact command that regenerates it, and that command takes the FILE name.
    specs.push({ ...mod.default, name });
    validateSpec(specs[specs.length - 1]);
  }
  return specs;
}

// ---------------------------------------------------------------------------------------------
// Trace -> graph
// ---------------------------------------------------------------------------------------------

/** Longest-prefix match against the engine's static roles. No match is an ERROR, never a new node. */
function roleOf(label, roles, spec) {
  let best = '';
  for (const r of roles) if (label.startsWith(r) && r.length > best.length) best = r;
  if (!best) {
    throw new Error(`${spec.title}: agent label "${label}" matches no role of ${spec.engine} (readRoles saw: ${roles.join(', ') || '(none)'}). A node is never invented for an unknown label — that would hide a role the static reader missed.`);
  }
  return best;
}

/**
 * `develop plan-a r2` -> `plan-a`; `investigate r3` -> ``; `generate:one` -> `one`; `curate:r1` -> ``.
 * The round marker is stripped across the SAME separator class `readRoles` trims (`[\s:/]`), not
 * whitespace alone: docs-cycle writes its round as `curate:r${rounds}`, and reading that `r1` as an
 * ITEM ID makes every edge touching the curator a unit boundary — the gap loop then draws as a thick
 * "next item" advance instead of the dotted back-edge it is, and `scrub -> curate` claims an item
 * advance across what is actually a whole-set barrier.
 */
const itemIdOf = (label, role) =>
  label.slice(role.length).replace(/[\s:/]+r\d+$/, '').replace(/^[\s:/]+/, '').trim();

/** Longest-prefix match of a thrown message against the engine's static throw sites. */
function siteOf(message, sites, spec) {
  const hits = sites.filter((s) => message.startsWith(s.prefix));
  if (!hits.length) throw new Error(`${spec.title}: thrown message "${message.slice(0, 60)}" matches no throw site in ${spec.engine}`);
  const best = hits.reduce((a, b) => (b.prefix.length > a.prefix.length ? b : a));
  // An empty prefix (a message that STARTS with an interpolation) matches everything, so it is only a
  // last resort — and two of them are indistinguishable from each other.
  if (best.prefix === '' && hits.filter((s) => s.prefix === '').length > 1) {
    throw new Error(`${spec.title}: "${message.slice(0, 60)}" cannot be keyed — ${spec.engine} has several throw sites whose message starts with an interpolation`);
  }
  return best;
}

/**
 * Split a call list into segments: a maximal run of ungrouped calls, or one fan-out's calls. Then each
 * segment becomes CHAINS — one per fan-out lane (`group.item`), or a single chain for ungrouped calls.
 * A chain is sequential; separate chains of one segment are concurrent with each other.
 */
function chainsOf(calls) {
  const segments = [];
  for (const c of calls) {
    const key = c.group ? `g${c.group.id}` : 'solo';
    const last = segments[segments.length - 1];
    if (last && last.key === key && key !== 'solo') last.calls.push(c);
    else segments.push({ key, group: key !== 'solo', calls: [c] });
  }
  return segments.map((seg) => {
    if (!seg.group) return { group: false, chains: [seg.calls] };
    const byItem = new Map();
    for (const c of seg.calls) {
      const list = byItem.get(c.group.item) ?? [];
      list.push(c);
      byItem.set(c.group.item, list);
    }
    const items = [...byItem.keys()].sort((a, b) => a - b);
    return { group: true, chains: items.map((i) => byItem.get(i)) };
  });
}

/**
 * Run every scenario once and fold the traces into one graph.
 * @returns {Promise<{nodes,edges,terminals,phases,loops,coverage}>}
 */
export async function buildGraph(spec) {
  // ---- Inputs ---------------------------------------------------------------------------------
  validateSpec(spec);
  const src = readFileSync(join(REPO_ROOT, spec.engine), 'utf8');
  const roles = readRoles(src);
  const sites = readThrows(src);
  const meta = readMeta(src) ?? {};
  const haltStatus = readHaltStatus(src);

  // ---- Accumulators ---------------------------------------------------------------------------
  const agents = new Map();     // role  -> node
  const terms = new Map();      // label -> node (insertion order = spec order)
  const throwsSeen = new Map(); // line  -> node
  const edges = new Map();      // `${from}\u0000${to}` -> edge
  const coveredRoles = new Set();
  const coveredStatuses = new Set();

  // Phase and model are taken from the FIRST call that reached a role — one role runs under one of each.
  const agentNode = (role, call) => {
    let node = agents.get(role);
    if (!node) {
      node = { key: `a:${role}`, kind: 'agent', role, label: role, phase: call.opts?.phase ?? '', model: call.opts?.model ?? '', concurrency: 1 };
      agents.set(role, node);
    }
    return node;
  };
  // `whens` alongside `scenarios`: the conditions are what the terminal TABLE prints, because the edges
  // into a terminal are drawn unlabelled (see edgeLine). Scenario names stay for the coverage report.
  const termNode = (label, source, scenario, when) => {
    let node = terms.get(label);
    if (!node) {
      node = { key: `t:${label}`, kind: 'terminal', label, source, scenarios: [], whens: [] };
      terms.set(label, node);
    }
    if (!node.scenarios.includes(scenario)) node.scenarios.push(scenario);
    if (when && !node.whens.includes(when)) node.whens.push(when);
    return node;
  };
  const throwNode = (site, scenario, when) => {
    let node = throwsSeen.get(site.line);
    if (!node) {
      // LABEL from `template`, KEY from `prefix` (see readThrows). `prefix` stops at the first `${`, so
      // labelling from it drops every static word after an interpolated value — `plan id(s) [` for a
      // message that goes on to say what is wrong with them. It falls back for a site whose literal the
      // reader could not close, where a partial head still beats a blank node.
      node = { key: `x:${site.line}`, kind: 'throw', label: `throw: ${firstClause(site.template || site.prefix)}`, line: site.line, source: 'throw', scenarios: [], whens: [] };
      throwsSeen.set(site.line, node);
    }
    if (!node.scenarios.includes(scenario)) node.scenarios.push(scenario);
    if (when && !node.whens.includes(when)) node.whens.push(when);
    return node;
  };

  // `boundary` is part of the KEY, not merely a flag on a shared edge. One node pair legitimately carries
  // BOTH shapes — feature-cycle's `acceptance -> develop` is a retry of the SAME plan, and after a staging
  // the advance to the NEXT one — and a single merged edge can only render as one of them (edgeLine gives
  // boundary priority), which silently re-folds the very pair the boundary rule exists to split.
  const addEdge = (from, to, when, { back = false, boundary = false, repeat = 0, labelled = false } = {}) => {
    const k = `${boundary ? 'boundary' : 'plain'} ${from}\u0000${to}`;
    const e = edges.get(k) ?? { from, to, whens: [], back: false, boundary: false, repeat: 0, labelled: false };
    if (!e.whens.includes(when)) e.whens.push(when);
    e.back = e.back || back;
    e.boundary = e.boundary || boundary;
    e.repeat = Math.max(e.repeat, repeat);
    e.labelled = e.labelled || labelled;
    edges.set(k, e);
  };

  // ---- Process: one traversal per scenario -----------------------------------------------------
  for (const sc of spec.scenarios) {
    const trace = await runTrace(spec.engine, { args: sc.args ?? {}, respond: sc.respond ?? {}, budget: sc.budget });

    // Node per call, plus the first-visit order a back-edge is judged against.
    //
    // Loop bounds are MEASURED as traversals of THAT EDGE along ONE lane, plus one — i.e. how many
    // times the node the edge returns to is entered. Counting visits to the target node instead
    // conflates fan-out width with loop depth: docs gathers 2 sources in round 1 and 1 gap source in
    // round 2, so `curate -> gather` would read (×3) for a 2-round loop, and review's per-unit lens
    // self-loop would read (×4) for 2 lenses across 2 units. Per-lane traversals give 2 and 2, and
    // leave investigate's ungrouped round loop at the 5 it already measured.
    const firstSeen = new Map();
    const nodeOf = new Map();
    for (const [i, c] of trace.calls.entries()) {
      const role = roleOf(c.label, roles, spec);
      coveredRoles.add(role);
      const node = agentNode(role, c);
      nodeOf.set(c, node);
      if (!firstSeen.has(node.key)) firstSeen.set(node.key, i);
    }

    // Traversal tally for this scenario: how many times each edge has been walked within one lane.
    // A LANE IS ONE ITEM'S PASS through the graph — a fan-out item where there is a group, else the
    // label's own item id (feature/migrate/resolve have no groups at all, and a roadmap of 2 plans
    // that each retry once must read ×2, not the ×3 that summing both plans' traversals gives).
    // `laneOf` reads the SOURCE call, so an edge crossing back into a fan-out from ungrouped code
    // counts once for the round rather than once per item.
    const laneOf = (call, role) => (call.group ? `g${call.group.id}:${call.group.item}` : itemIdOf(call.label, role));
    const traversals = new Map();
    const traversalOf = (call, role, from, to) => {
      const k = `${laneOf(call, role)}\u0000${from}\u0000${to}`;
      const n = (traversals.get(k) ?? 0) + 1;
      traversals.set(k, n);
      return n + 1;              // n traversals means the target was entered n+1 times
    };
    // A repeat visit is a LOOP-BACK only when its target was already reached before the source role
    // was — otherwise the forward edges inside a loop body (investigate -> critique on round 2) would
    // all read as back-edges once the loop has turned over.
    const isBack = (fromKey, toKey, seenSet) =>
      seenSet.has(toKey) && (firstSeen.get(toKey) ?? 0) <= (firstSeen.get(fromKey) ?? 0);

    // The terminal this scenario reached.
    let end;
    if (trace.terminal.kind === 'throw') {
      end = throwNode(siteOf(trace.terminal.message, sites, spec), sc.name, sc.when);
    } else {
      const derived = normDigits(trace.terminal.status ?? '');
      const declared = sc.terminal ? normDigits(sc.terminal) : '';
      if (derived) {
        if (declared && declared !== derived) {
          throw new Error(`${spec.title}: scenario "${sc.name}" declares terminal "${sc.terminal}" but the engine returned status "${trace.terminal.status}" — authored text must never override derived truth. Drop the declared terminal.`);
        }
        coveredStatuses.add(derived);
        end = termNode(derived, 'derived', sc.name, sc.when);
      } else {
        if (!declared) {
          throw new Error(`${spec.title}: scenario "${sc.name}" returned without a status, so it needs a declared \`terminal\` — otherwise every status-less exit of ${spec.engine} collapses into one blank end node.`);
        }
        end = termNode(declared, 'declared', sc.name, sc.when);
      }
    }

    // Walk the chains. `seen` is what makes an edge a back-edge; concurrent chains share the baseline
    // they started from, so one lane's first call is never "already seen" because a sibling lane ran.
    const seen = new Set();
    let prevExits = [];     // [{ node, call }] — the previous segment's last call per chain
    for (const seg of chainsOf(trace.calls)) {
      const segSeen = new Set(seen);
      const entries = [];
      const exits = [];
      for (const chain of seg.chains) {
        const local = new Set(segSeen);
        let prev = null;
        for (const call of chain) {
          const node = nodeOf.get(call);
          if (prev) {
            const from = itemIdOf(prev.call.label, prev.node.role);
            const to = itemIdOf(call.label, node.role);
            // Inside one fan-out lane `group.item` is authoritative: a repeat there is sequential, not
            // an advance to a new unit, however the two labels differ.
            const boundary = !seg.group && !!from && !!to && from !== to;
            const back = !boundary && isBack(prev.node.key, node.key, local);
            addEdge(prev.node.key, node.key, sc.when, { boundary, back, repeat: back ? traversalOf(prev.call, prev.node.role, prev.node.key, node.key) : 0 });
          } else {
            entries.push({ node, call });
          }
          local.add(node.key);
          prev = { node, call };
        }
        for (const k of local) seen.add(k);
        if (prev) exits.push(prev);
      }
      // Join to whatever ran before this segment.
      for (const to of entries) {
        if (!prevExits.length) addEdge(START_ID, to.node.key, sc.when);
        for (const from of prevExits) {
          const a = itemIdOf(from.call.label, from.node.role);
          const b = itemIdOf(to.call.label, to.node.role);
          const boundary = !!a && !!b && a !== b;
          const back = !boundary && isBack(from.node.key, to.node.key, segSeen);
          addEdge(from.node.key, to.node.key, sc.when, { boundary, back, repeat: back ? traversalOf(from.call, from.node.role, from.node.key, to.node.key) : 0 });
        }
      }
      // Concurrency: how many lanes of this fan-out ran the same role. That count is the node's
      // multiplicity annotation — the only thing left saying "three of these ran at once" once the
      // siblings are collapsed into one node.
      if (seg.group) {
        const lanes = new Map();
        for (const chain of seg.chains) {
          for (const node of new Set(chain.map((c) => nodeOf.get(c)))) lanes.set(node, (lanes.get(node) ?? 0) + 1);
        }
        for (const [node, n] of lanes) node.concurrency = Math.max(node.concurrency, n);
      }
      prevExits = exits;
    }

    // ...and into the terminal.
    if (!prevExits.length) addEdge(START_ID, end.key, sc.when, { labelled: true });
    for (const from of prevExits) addEdge(from.node.key, end.key, sc.when, { labelled: true });
  }

  // ---- Output: stable ids + ordering -----------------------------------------------------------
  const agentList = roles.filter((r) => agents.has(r)).map((r) => agents.get(r));
  const termList = [...terms.values()];
  const throwList = [...throwsSeen.values()].sort((a, b) => a.line - b.line);
  agentList.forEach((n, i) => { n.id = `a${i + 1}`; });
  termList.forEach((n, i) => { n.id = `t${i + 1}`; });
  throwList.forEach((n, i) => { n.id = `x${i + 1}`; });

  const nodes = [...agentList, ...termList, ...throwList];
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const rank = new Map(nodes.map((n, i) => [n.key, i]));
  rank.set(START_ID, -1);

  const edgeList = [...edges.values()]
    .map((e) => ({ ...e, fromId: e.from === START_ID ? START_ID : byKey.get(e.from).id, toId: byKey.get(e.to).id }))
    .sort((a, b) => (rank.get(a.from) - rank.get(b.from)) || (rank.get(a.to) - rank.get(b.to)));

  // Phases: every authored phase (documentation), each carrying whichever nodes really ran under it.
  const authored = Array.isArray(meta.phases) ? meta.phases : [];
  const phases = authored.map((p, i) => ({ id: `p${i + 1}`, title: String(p.title ?? ''), detail: String(p.detail ?? ''), nodes: [] }));
  for (const n of agentList) {
    const p = phases.find((x) => x.title === n.phase);
    if (p) p.nodes.push(n.id);
    else if (n.phase) {
      phases.push({ id: `p${phases.length + 1}`, title: n.phase, detail: '(not in meta.phases)', nodes: [n.id] });
    }
  }

  const uncoveredThrows = sites
    .filter((s) => !throwsSeen.has(s.line))
    .map((s) => ({
      line: s.line,
      label: firstClause(s.template || s.prefix),
      reason: (spec.allowUncovered?.throws ?? []).find((a) => a.prefix && s.prefix.startsWith(a.prefix))?.reason ?? '',
    }));
  const statuses = [...new Set(Object.values(haltStatus).map(normDigits))];

  return {
    nodes,
    edges: edgeList,
    // `whens` is part of the projection, not just of the accumulator: the edges into a terminal are drawn
    // UNLABELLED precisely because this table is their home (see edgeLine), and dropping the field here
    // left the "Reached when" column blank in all nine committed maps — the conditions appeared neither
    // on the arrow nor in the table that replaced it.
    terminals: [...termList, ...throwList].map((n) => ({ id: n.id, label: n.label, source: n.source, line: n.line ?? null, scenarios: n.scenarios, whens: n.whens })),
    phases,
    loops: edgeList.filter((e) => e.back).map((e) => ({ from: e.fromId, to: e.toId, whens: e.whens, repeat: e.repeat })),
    coverage: {
      scenarios: spec.scenarios.length,
      roles: { total: roles.length, covered: coveredRoles.size, uncovered: roles.filter((r) => !coveredRoles.has(r)) },
      throws: { total: sites.length, covered: throwsSeen.size, uncovered: uncoveredThrows },
      statuses: { total: statuses.length, covered: statuses.filter((s) => coveredStatuses.has(s)).length, uncovered: statuses.filter((s) => !coveredStatuses.has(s)) },
      terminals: termList.length + throwList.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------------------------

function nodeText(n) {
  if (n.kind !== 'agent') return esc(n.label);
  const head = esc(n.model ? `${n.label} · ${n.model}` : n.label);
  // The phase rides on the node ONLY when it adds something the role name does not already say. Every
  // engine names most agents after their phase (investigate/Investigate, develop/Develop), so printing
  // both is noise; the ones that differ (criteria-critic in Refine, analyst in Diverge) are worth it.
  const phase = n.phase && n.phase.toLowerCase() !== n.label.toLowerCase() ? `<br/>${esc(n.phase)}` : '';
  return `${head}${phase}${n.concurrency > 1 ? `<br/>×${n.concurrency} concurrent` : ''}`;
}

// Edges INTO a terminal are drawn unlabelled, and their conditions live in the Terminal states table.
// One agent commonly fans out to five or six different endings, and Mermaid places every one of those
// labels in the same band between the two ranks with no collision avoidance — measured with
// tools/render-flows.mjs, that was 8 of 9 maps rendering with text piled on text. The table is the
// better home anyway: it is indexed by TERMINAL, which is the question a reader actually asks ("how do I
// end up BLOCKED?"), and it is complete rather than truncated to fit on an arrow.
// Loop and boundary edges KEEP their labels — they are few, they never fan out, and they carry the
// structural story (which way round the loop goes, where the next item starts) that no table replaces.
// A SELF-loop carries a MARKER (`L1 ×4`), never its conditions — same treatment, and for the same reason,
// as an edge into a terminal. Mermaid parks a self-loop's label in a FIXED-WIDTH gutter beside the node
// and never feeds the label's width into layout, so text long enough to matter lands on whatever box sits
// next to it. That gutter does not scale with nodeSpacing/rankSpacing, and shrinking the text just moves
// the collision elsewhere — both measured (tests/CLAUDE.md §7). A marker is bounded BY CONSTRUCTION, so
// this cannot come back when a diagram grows a node or a renderer retunes its gutter again. The repeat
// count stays on the arrow because it is the loop's bound, which is the structural fact a reader wants
// from the picture; the conditions move to the Loops table, indexed by the loop.
const selfLoopIds = (graph) => {
  const m = new Map();
  for (const e of graph.edges) if (e.back && e.fromId === e.toId) m.set(e, `L${m.size + 1}`);
  return m;
};

function edgeLine(e, terminalIds, loopIds) {
  if (e.boundary) return `  ${e.fromId} ==>|"${esc('next item')}"| ${e.toId}`;
  if (e.back) {
    const marker = loopIds.get(e);
    // A non-self back edge (a3 → a2) is drawn in the open span between two ranks, where a real label fits.
    if (!marker) {
      const suffix = e.repeat > 1 ? ` (×${e.repeat})` : '';
      return `  ${e.fromId} -.->|"${esc(whenLabel(e.whens, WHEN_BUDGET, suffix.length))}${suffix}"| ${e.toId}`;
    }
    return `  ${e.fromId} -.->|"${esc(marker)}${e.repeat > 1 ? ` ×${e.repeat}` : ''}"| ${e.toId}`;
  }
  if (e.labelled && !terminalIds.has(e.toId)) return `  ${e.fromId} -->|"${esc(whenLabel(e.whens))}"| ${e.toId}`;
  return `  ${e.fromId} --> ${e.toId}`;
}

function mermaid(graph, loopIds) {
  // Mermaid does no collision avoidance on edge labels, and these graphs fan several labelled edges out
  // of one node into separate terminals — at default spacing their labels land on top of each other and
  // neither is readable. More room per rank is what separates them; the values are TUNED against
  // tools/render-flows.mjs, which lays each map out in real Mermaid and measures the boxes.
  const lines = [
    `%%{init: {"flowchart": {"nodeSpacing": ${NODE_SPACING}, "rankSpacing": ${RANK_SPACING}}}}%%`,
    'flowchart TD',
    `  ${START_ID}(["${esc('args')}"])`,
  ];
  const placed = new Set();
  // A phase box is drawn ONLY when it actually groups something — i.e. holds 2+ agents. Today no engine
  // puts two agents in one phase, so this emits nothing; that is the point. A subgraph around a single
  // node adds a box whose label just repeats the node inside it, and Mermaid has to route every edge
  // that crosses it AROUND the boundary, which is what sent back-edges disappearing behind neighbouring
  // boxes. The phase itself is not lost: it rides on the node when it differs from the role name, and
  // the Phases table below the diagram carries meta.phases in full.
  for (const p of graph.phases) {
    if (p.nodes.length < 2) continue;
    lines.push(`  subgraph ${p.id}["${esc(p.title)}"]`);
    for (const id of p.nodes) {
      const n = graph.nodes.find((x) => x.id === id);
      placed.add(id);
      lines.push(`    ${id}["${nodeText(n)}"]`);
    }
    lines.push('  end');
  }
  for (const n of graph.nodes) {
    if (placed.has(n.id)) continue;
    if (n.kind === 'agent') lines.push(`  ${n.id}["${nodeText(n)}"]`);
    else if (n.kind === 'terminal') lines.push(`  ${n.id}(["${nodeText(n)}"])`);
    else lines.push(`  ${n.id}[/"${nodeText(n)}"/]`);
  }
  const terminalIds = new Set(graph.nodes.filter((n) => n.kind !== 'agent').map((n) => n.id));
  for (const e of graph.edges) lines.push(edgeLine(e, terminalIds, loopIds));
  return lines.join('\n');
}

/** The whole FLOW.md, from the ONE graph computation. */
export function generate(spec, graph) {
  const cmd = `node tools/gen-flows.mjs ${spec.name ?? spec.title}`;
  const cov = graph.coverage;
  const out = [];

  out.push(`# ${spec.title} flow map`, '');
  out.push(`Generated by \`${cmd}\`. **Do not hand-edit.**`);
  out.push('Every node and edge below was *observed*: the scenarios in `tools/flows/` run the real engine');
  out.push('under the test harness with scripted agent returns, so this is what a run does rather than what');
  out.push('it might do. `node tools/gen-flows.mjs --check` fails the gate while this file is stale.', '');
  const loopIds = selfLoopIds(graph);
  out.push('```mermaid');
  out.push(mermaid(graph, loopIds));
  out.push('```', '');

  out.push('## Phases', '');
  out.push('| Phase | What happens |', '|---|---|');
  for (const p of graph.phases) out.push(`| ${cell(p.title)} | ${cell(p.detail)} |`);
  out.push('');

  // The self-loops' conditions, moved off the arrows (see edgeLine). Indexed by the marker the diagram
  // shows, so a reader goes from `L1` in the picture to what actually keeps that agent looping.
  if (loopIds.size) {
    out.push('## Loops', '');
    out.push('| Loop | Agent | Repeats while |', '|---|---|---|');
    for (const [e, id] of loopIds) {
      const node = graph.nodes.find((n) => n.id === e.fromId);
      out.push(`| ${id} | ${cell(node ? node.label : e.fromId)} | ${cell((e.whens || []).join(' · '))} |`);
    }
    out.push('');
  }

  out.push('## Terminal states', '');
  out.push('| Terminal | Reached when | Source |', '|---|---|---|');
  for (const t of graph.terminals) {
    const source = t.source === 'throw' ? `throw (line ${t.line})` : t.source;
    out.push(`| ${cell(t.label)} | ${cell((t.whens || []).join(' · '))} | ${source} |`);
  }
  out.push('');

  out.push('## Coverage', '');
  out.push(`${cov.scenarios} scenarios · ${cov.roles.covered}/${cov.roles.total} roles · ${cov.throws.covered}/${cov.throws.total} throw sites · ${cov.statuses.covered}/${cov.statuses.total} halt statuses · ${cov.terminals} terminal states.`);
  if (cov.roles.uncovered.length) out.push('', `Uncovered roles: ${cov.roles.uncovered.map(cell).join(', ')}.`);
  if (cov.throws.uncovered.length) {
    out.push('');
    for (const t of cov.throws.uncovered) out.push(`Uncovered throw (line ${t.line}): ${cell(t.label)}${t.reason ? ` (allowed: ${cell(t.reason)})` : ''}`);
  }
  if (cov.statuses.uncovered.length) out.push('', `Unreached halt statuses: ${cov.statuses.uncovered.map(cell).join(', ')}.`);
  out.push('');
  return dedash(out.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

async function main(argv) {
  // ---- Inputs ---------------------------------------------------------------------------------
  const flags = argv.filter((a) => a.startsWith('--'));
  const names = argv.filter((a) => !a.startsWith('--'));
  const unknown = flags.filter((f) => f !== '--check' && f !== '--json');
  if (unknown.length) {
    console.error(`unknown flag ${unknown.join(', ')} — usage: node tools/gen-flows.mjs [<name>...] [--check] [--json]`);
    return 1;
  }
  const check = flags.includes('--check');
  const asJson = flags.includes('--json');
  const specs = await loadSpecs(names);

  // ---- Process --------------------------------------------------------------------------------
  const stale = [];
  for (const spec of specs) {
    const graph = await buildGraph(spec);
    if (asJson) {
      console.log(JSON.stringify(graph, null, 2));
      continue;
    }
    const text = generate(spec, graph);
    const outPath = join(REPO_ROOT, spec.out);
    let current = null;
    try { current = readFileSync(outPath, 'utf8'); } catch { current = null; }
    const cov = graph.coverage;
    const summary = `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${cov.terminals} terminals, ${cov.scenarios} scenarios`;

    if (check) {
      if (current === text) console.log(`fresh    ${spec.out}  (${summary})`);
      else { stale.push(spec.out); console.log(`STALE    ${spec.out}  (${current === null ? 'missing' : 'differs'})`); }
      continue;
    }
    if (current === text) { console.log(`unchanged ${spec.out}  (${summary})`); continue; }
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
    console.log(`wrote    ${spec.out}  (${summary})`);
  }

  // ---- Output ---------------------------------------------------------------------------------
  if (stale.length) {
    console.error(`\n${stale.length} stale flow map(s): ${stale.join(', ')} — run \`node tools/gen-flows.mjs\` and commit the result.`);
    return 1;
  }
  return 0;
}

// Guard: importing this module (tests/flows.test.mjs does) must not run the CLI. Errors are reported as
// the one line they are — a mistyped spec name is not worth a stack trace, and every throw in here
// already names what to fix.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let code = 0;
  try {
    code = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e?.message ?? String(e));
    code = 1;
  }
  process.exit(code);
}
