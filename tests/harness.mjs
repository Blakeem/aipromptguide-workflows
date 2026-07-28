// Simulator for Workflow engines — runs a real engine against SCRIPTED agent responses, with no model
// calls at all. Fast (milliseconds), free, and deterministic.
//
// WHY THIS IS POSSIBLE AT ALL. Principle #1: the harness routes control signals and never interprets
// content. So an engine's whole control plane is a pure function of what its agents return — feed it
// scripted returns and you can assert exactly what it does. That also bounds what these tests prove:
// they test the ENGINE, never the AGENTS. A prompt that is misleading, or a model that ignores it, is
// invisible here. Prompt quality is what the review loops are for.
//
// The engine is loaded as TEXT, not imported: `export const meta` is rewritten to a plain const (so it
// is no longer an ES module) and the body is wrapped in an async function with the harness globals
// injected as parameters — the same shape the real runtime uses. This is also why top-level `return`
// and `await` work in an engine but `node --check` rejects it.
//
// Two ways in. `runEngine` drives a run and throws what the engine throws (what the test files use).
// `runTrace` never throws and hands back the COMPLETE path — every call with its `seq` and fan-out
// group, the `phase()` sequence, and the terminal state, including for a run that died halfway. Both
// go through ONE loader (`execute`), so a runtime global cannot land in one wrap and not the other.
// The static readers at the bottom answer questions about an engine WITHOUT running it.

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

// Every Workflow engine. gen-units.mjs is NOT here — it is ordinary Node (real imports, run directly),
// so it gets a real `node --check` in static.test.mjs instead.
export const ENGINES = [
  'workflows/feature/feature-cycle.mjs',
  'workflows/migrate/migrate-cycle.mjs',
  'workflows/debug/review.mjs',
  'workflows/debug/resolve-cycle.mjs',
  'workflows/enhance/enhance-cycle.mjs',
  'workflows/decide/decide-cycle.mjs',
  'workflows/docs/docs-cycle.mjs',
  'workflows/brainstorm/brainstorm-cycle.mjs',
  'workflows/investigate/investigate-cycle.mjs',
];

// ---------------------------------------------------------------------------------------------
// Reporting — module-level so a test file just calls section()/ok() and run.mjs reads the tally.
// ---------------------------------------------------------------------------------------------
export const results = { passed: 0, failed: 0, failures: [] };
let currentFile = '(unknown)';
let currentSection = '';

export const setFile = (name) => { currentFile = name; currentSection = ''; };
export const section = (name) => { currentSection = name; console.log(`  ${name}`); };

export function ok(cond, msg) {
  if (cond) {
    results.passed++;
    console.log(`    ✓ ${msg}`);
  } else {
    results.failed++;
    results.failures.push(`${currentFile} :: ${currentSection} :: ${msg}`);
    console.log(`    ✗ FAIL ${msg}`);
  }
}

export const eq = (actual, expected, msg) =>
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)})`);

// ---------------------------------------------------------------------------------------------
// The simulator
// ---------------------------------------------------------------------------------------------

// `respond` is either a function (label, prompt, callsSoFar) => response, or an object keyed by label
// PREFIX (longest match wins) whose values are responses or functions of the same shape.
//   undefined  -> the agent returns {}   (no script for this label)
//   null       -> the agent DIED         (what parallel()/pipeline() hand back on failure)
function toResponder(respond) {
  if (typeof respond === 'function') return respond;
  const keys = Object.keys(respond || {}).sort((a, b) => b.length - a.length);
  return (label, prompt, calls) => {
    const k = keys.find((key) => label.startsWith(key));
    if (k === undefined) return undefined;
    const v = respond[k];
    return typeof v === 'function' ? v(label, prompt, calls) : v;
  };
}

/**
 * Load, wrap and drive an engine — THE one engine loader. It NEVER throws: the accumulators live here
 * and the engine body runs inside a try, so a run that dies halfway still hands back every call it made
 * up to that point. Catching in the caller instead would destroy exactly that record.
 * @returns the trace record; `terminal.kind === 'throw'` carries the failure (and `thrown` the Error).
 */
async function execute(enginePath, { args, respond = {}, budget } = {}) {
  // ---- Inputs ---------------------------------------------------------------------------------
  const responder = toResponder(respond);

  // ---- Accumulators (owned here so a throw cannot lose them) ------------------------------------
  const calls = [];
  const logs = [];
  const phases = [];
  const groups = [];

  // Fan-out context. AsyncLocalStorage rather than a synchronous set/restore, because the store has to
  // survive `await` and `.then()` boundaries inside a thunk (brainstorm's generator chains a `.then`),
  // and a plain variable would be clobbered by whichever concurrent branch ran last.
  const groupCtx = new AsyncLocalStorage();
  let nextGroupId = 0;

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '(unlabeled)';
    const r = responder(label, prompt, calls);
    const resp = r === undefined ? {} : r;
    calls.push({ seq: calls.length, label, prompt, opts, resp, group: groupCtx.getStore() ?? null });
    return resp;
  };

  const phase = (title) => { phases.push({ title: String(title), beforeCall: calls.length }); };
  const log = (m) => { logs.push(String(m)); };

  // Real contracts: parallel() is a barrier and turns a thrown thunk into null; pipeline() runs each
  // item through every stage independently, and a stage that throws drops that item to null.
  // Each fan-out opens ONE group and stamps every agent call underneath with its (id, item, stage).
  // Several calls may legitimately share one triple — review.mjs loops its lenses sequentially inside a
  // single stage — so nothing here collapses or renumbers them.
  const parallel = async (thunks) => {
    const id = nextGroupId++;
    groups.push({ id, kind: 'parallel', items: thunks.length, stages: 1 });
    return Promise.all(thunks.map((f, item) => Promise.resolve()
      .then(() => groupCtx.run({ id, kind: 'parallel', item, stage: 0 }, f))
      .catch(() => null)));
  };
  const pipeline = async (items, ...stages) => {
    const id = nextGroupId++;
    groups.push({ id, kind: 'pipeline', items: items.length, stages: stages.length });
    return Promise.all(items.map(async (item, idx) => {
      let v = item;
      try {
        for (let stage = 0; stage < stages.length; stage++) {
          v = await groupCtx.run({ id, kind: 'pipeline', item: idx, stage }, () => stages[stage](v, item, idx));
        }
      } catch { return null; }
      return v;
    }));
  };

  // ---- Run --------------------------------------------------------------------------------------
  let out;
  let thrown = null;
  let terminal = { kind: 'return', status: '', message: '' };
  try {
    const src = readFileSync(`${REPO_ROOT}/${enginePath}`, 'utf8')
      .replace('export const meta', 'const meta');
    out = await new Function(
      'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
      'return (async()=>{' + src + '})()',
    )(
      agent, parallel, pipeline, phase, log, args,
      budget || { total: null, spent: () => 0, remaining: () => Infinity }, null,
    );
    terminal = { kind: 'return', status: out?.status ?? '', message: '' };
  } catch (e) {
    thrown = e;
    terminal = { kind: 'throw', status: '', message: e?.message ?? String(e) };
  }

  // ---- Output -----------------------------------------------------------------------------------
  return {
    out,
    calls,
    logs,
    phases,
    groups,
    terminal,
    // The Error itself, so runEngine rethrows the original rather than a lookalike.
    thrown,
    labels: calls.map((c) => c.label),
    /** full prompt text of the first call whose label starts with `prefix` */
    prompt: (prefix) => calls.find((c) => c.label.startsWith(prefix))?.prompt || '',
    /** every call whose label starts with `prefix` */
    byLabel: (prefix) => calls.filter((c) => c.label.startsWith(prefix)),
  };
}

/**
 * Run an engine against scripted agents. Throws whatever the engine throws.
 * @param {string} enginePath  repo-relative, e.g. 'workflows/feature/feature-cycle.mjs'
 * @param {object} o
 * @param {object} o.args      the args the engine sees
 * @param {object|function} o.respond  scripted agent returns (see toResponder)
 * @param {object} [o.budget]  overrides the default unlimited budget
 * @returns {{out:any, calls:Array, logs:string[], labels:string[], prompt:function, byLabel:function}}
 *          plus everything runTrace adds (phases, groups, terminal).
 */
export async function runEngine(enginePath, opts = {}) {
  const record = await execute(enginePath, opts);
  if (record.terminal.kind === 'throw') throw record.thrown;
  return record;
}

/**
 * Run an engine and hand back the COMPLETE trace — including for a run that throws. NEVER throws.
 * Same args as runEngine, and everything runEngine returns, plus:
 *   calls[i].seq    0-based call index
 *   calls[i].group  null outside a fan-out, else { id, kind: 'parallel'|'pipeline', item, stage }.
 *                   Several calls may share one (id, item, stage) triple — review.mjs loops its lenses
 *                   sequentially inside one stage. Tell sequential repeats from concurrency by `item`.
 *   phases          [{ title, beforeCall }], beforeCall = the seq the NEXT agent call will take.
 *                   An EMPTY list is CORRECT for an engine that carries its phase on opts.phase and
 *                   never calls phase() (debug/review.mjs, enhance-cycle.mjs) — not a tracing failure.
 *   groups          one entry per fan-out: { id, kind, items, stages }
 *   terminal        { kind: 'return'|'throw', status, message }. On a throw `out` is undefined and
 *                   `status` is '', but every call made BEFORE the throw is still in `calls`.
 */
export const runTrace = (enginePath, opts = {}) => execute(enginePath, opts);

/** Run an engine expecting it to THROW; returns the message, or '' if it did not throw. */
export async function throwsWith(enginePath, opts) {
  const { terminal } = await execute(enginePath, opts);
  return terminal.kind === 'throw' ? terminal.message : '';
}

// ---------------------------------------------------------------------------------------------
// Static readers — facts about an engine from its SOURCE TEXT, without running it.
// ---------------------------------------------------------------------------------------------

/**
 * Read the string literal at/after `fromIndex`, stopping at the first `${` or at the closing quote,
 * whichever comes first. Stopping at the interpolation is what makes NESTED templates safe: review.mjs's
 * label nests a template inside a ternary inside a template, and a reader hunting for the closing
 * backtick would run straight past it.
 * @returns {{text:string, interpolated:boolean}}  text is '' when there is no literal there at all.
 */
function leadingLiteral(src, fromIndex) {
  let i = fromIndex;
  while (i < src.length && /\s/.test(src[i])) i++;
  const quote = src[i];
  if (quote !== "'" && quote !== '"' && quote !== '`') return { text: '', interpolated: false };

  let text = '';
  for (i++; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { text += src[i + 1] ?? ''; i++; continue; }
    if (ch === quote) return { text, interpolated: false };
    if (quote === '`' && ch === '$' && src[i + 1] === '{') return { text, interpolated: true };
    text += ch;
  }
  return { text, interpolated: false };
}

/** The named object literal, evaluated. Safe: `meta` purity is gated by static.test.mjs, and
 *  HALT_STATUS is a literal map. Returns null when the engine has no such block. */
function literalBlock(src, name) {
  const m = src.match(new RegExp(`(?:export )?const ${name} = (\\{[\\s\\S]*?\\n\\});`));
  return m ? new Function('return (' + m[1] + ')')() : null;
}

/** The evaluated `meta` object (name, description, whenToUse, phases), or null. */
export const readMeta = (src) => literalBlock(src, 'meta');

/** The evaluated HALT_STATUS map — `{}` for an engine that has none (most of them). */
export const readHaltStatus = (src) => literalBlock(src, 'HALT_STATUS') ?? {};

/**
 * The static label prefixes — the engine's ROLES — in source order, deduped.
 * THE RULE: take the label literal's text up to the first `${` or the closing quote, then trim any
 * trailing run of `[\s:/]`. A literal cut at an interpolation first loses a trailing bare `r` (the round
 * marker), so `develop ${p.id} r${round}` -> `develop` and `curate:r${rounds}` -> `curate`. `-` is NOT in
 * the trim set, which is what leaves `plan-critic` / `criteria-critic` / `final-sweep` intact.
 */
export function readRoles(src) {
  const roles = [];
  const re = /\blabel:\s*/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const lit = leadingLiteral(src, m.index + m[0].length);
    if (!lit.text) continue;                                   // no static prefix to report
    const bare = lit.interpolated ? lit.text.replace(/([\s:/])r$/, '$1') : lit.text;
    const role = bare.replace(/[\s:/]+$/, '');
    if (role && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

/**
 * Every `throw new Error(` site: `[{ line, prefix }]`, line 1-based.
 * A message that STARTS with an interpolation yields `prefix: ''` and is still RETURNED — dropping it
 * would read as "this site is covered" to anything counting sites against the source.
 */
export function readThrows(src) {
  const NEEDLE = 'throw new Error(';
  const sites = [];
  for (let i = src.indexOf(NEEDLE); i !== -1; i = src.indexOf(NEEDLE, i + NEEDLE.length)) {
    sites.push({
      line: src.slice(0, i).split('\n').length,
      prefix: leadingLiteral(src, i + NEEDLE.length).text,
    });
  }
  return sites;
}
