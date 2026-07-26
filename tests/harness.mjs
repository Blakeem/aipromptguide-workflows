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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

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
 * Run an engine against scripted agents.
 * @param {string} enginePath  repo-relative, e.g. 'workflows/feature/feature-cycle.mjs'
 * @param {object} o
 * @param {object} o.args      the args the engine sees
 * @param {object|function} o.respond  scripted agent returns (see toResponder)
 * @param {object} [o.budget]  overrides the default unlimited budget
 * @returns {{out:any, calls:Array, logs:string[], labels:string[], prompt:function, byLabel:function}}
 */
export async function runEngine(enginePath, { args, respond = {}, budget } = {}) {
  const src = readFileSync(`${REPO_ROOT}/${enginePath}`, 'utf8')
    .replace('export const meta', 'const meta');
  const responder = toResponder(respond);
  const calls = [];
  const logs = [];

  const agent = async (prompt, opts = {}) => {
    const label = opts.label || '(unlabeled)';
    const r = responder(label, prompt, calls);
    const resp = r === undefined ? {} : r;
    calls.push({ label, prompt, opts, resp });
    return resp;
  };

  // Real contracts: parallel() is a barrier and turns a thrown thunk into null; pipeline() runs each
  // item through every stage independently, and a stage that throws drops that item to null.
  const parallel = async (thunks) =>
    Promise.all(thunks.map((f) => Promise.resolve().then(f).catch(() => null)));
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, idx) => {
      let v = item;
      try {
        for (const s of stages) v = await s(v, item, idx);
      } catch { return null; }
      return v;
    }));

  const out = await new Function(
    'agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow',
    'return (async()=>{' + src + '})()',
  )(
    agent, parallel, pipeline, () => {}, (m) => logs.push(String(m)), args,
    budget || { total: null, spent: () => 0, remaining: () => Infinity }, null,
  );

  return {
    out,
    calls,
    logs,
    labels: calls.map((c) => c.label),
    /** full prompt text of the first call whose label starts with `prefix` */
    prompt: (prefix) => calls.find((c) => c.label.startsWith(prefix))?.prompt || '',
    /** every call whose label starts with `prefix` */
    byLabel: (prefix) => calls.filter((c) => c.label.startsWith(prefix)),
  };
}

/** Run an engine expecting it to THROW; returns the message, or '' if it did not throw. */
export async function throwsWith(enginePath, opts) {
  try {
    await runEngine(enginePath, opts);
    return '';
  } catch (e) {
    return e.message;
  }
}
