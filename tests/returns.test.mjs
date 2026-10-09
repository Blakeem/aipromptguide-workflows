// WORKFLOW-PRINCIPLES.md Mechanics, "Shared return fields", enforced on every returning scenario of every
// engine's flow spec, so the hand-back an operator reads has one shape across engines.
import { loadSpecs } from '../tools/gen-flows.mjs';
import { runTrace, section, ok } from './harness.mjs';

const HALTING = ['develop', 'refine', 'decide'];
const RETIRED_KEYS = ['followups', 'gatherFailed', 'scrubFailed', 'sweepFailed'];
const STATUS_FORM = /^[^()]+ \(.+\)$/;
const INSTRUCTION = /\b(?:relaunch|resum|replay|re-?run|re-?invoke|inspect|check|unstage(?!d)|repair|restructure)\w*|\bstage (?:it|that|its)\b|\bnever stage\b/i;

// No engine list, so a new engine's flow spec is checked without an edit here.
const specs = await loadSpecs();

for (const spec of specs) {
  section(`${spec.name}: every return carries the shared return fields`);
  let returned = 0;

  for (const sc of spec.scenarios) {
    const trace = await runTrace(spec.engine, { args: sc.args, respond: sc.respond ?? {}, budget: sc.budget });
    if (trace.terminal.kind !== 'return') continue;
    returned++;

    const where = `${spec.name} "${sc.name}"`;
    const out = trace.out ?? {};
    const failed = Array.isArray(out.failed) ? out.failed : [];
    const nextStep = typeof out.nextStep === 'string' ? out.nextStep : '';
    const stages = new Set(trace.calls.map((c) => String(c.opts.phase ?? '').toLowerCase()).filter(Boolean));
    const badEntries = failed.filter((e) => !(typeof e?.id === 'string' && e.id
      && typeof e.stage === 'string' && e.stage && stages.has(e.stage)));
    const unnamed = failed.filter((e) => typeof e?.id === 'string' && e.id && !nextStep.includes(e.id));
    const retired = RETIRED_KEYS.filter((k) => k in out);
    const halts = HALTING.includes(spec.name) || (spec.name === 'investigate' && out.phase === 'run');

    ok(nextStep !== '', `${where}: nextStep is a non-empty string`);
    ok(Array.isArray(out.failed), `${where}: failed is an array`);
    ok(!badEntries.length,
      `${where}: every failed entry has a non-empty string id and a stage that is the lowercased phase of an agent call${badEntries.length ? ` (got ${JSON.stringify(badEntries)})` : ''}`);
    ok(!unnamed.length, `${where}: nextStep names every failed entry's id${unnamed.length ? ` (missing ${unnamed.map((e) => e.id).join(', ')})` : ''}`);
    ok(!retired.length, `${where}: the return carries no retired key${retired.length ? ` (got ${retired.join(', ')})` : ''}`);
    ok(!failed.some((e) => e && typeof e === 'object' && 'unit' in e), `${where}: no failed entry has a unit key`);
    if (spec.name !== 'investigate') ok(!('phase' in out), `${where}: the return carries no phase key`);
    for (const entry of Array.isArray(out.ledger) ? out.ledger : []) {
      const status = String(entry?.status ?? '');
      ok(STATUS_FORM.test(status), `${where}: ledger ${entry?.id} status reads "<token> (<meaning>)" (got ${JSON.stringify(entry?.status)})`);
      ok(!INSTRUCTION.test(status), `${where}: ledger ${entry?.id} status carries no instruction (got ${JSON.stringify(entry?.status)})`);
    }
    if (!halts) continue;

    ok(typeof out.status === 'string' && out.status !== '', `${where}: status is a non-empty string`);
    ok(typeof out.halted === 'boolean', `${where}: halted is a boolean`);
    ok(typeof out.haltReason === 'string', `${where}: haltReason is a string`);
    ok(out.halted === (out.haltReason !== ''), `${where}: halted is true exactly when haltReason is non-empty`);
    ok(STATUS_FORM.test(String(out.status ?? '')), `${where}: status reads "<token> (<meaning>)" (got ${JSON.stringify(out.status)})`);
    ok(!INSTRUCTION.test(String(out.status ?? '')), `${where}: status carries no instruction (got ${JSON.stringify(out.status)})`);
  }

  ok(returned > 0, `${spec.name}: at least one flow scenario returns, so the rules above ran`);
}
