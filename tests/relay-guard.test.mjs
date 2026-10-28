// The Workflow runtime copies the launching turn's user message into every agent's context. Each engine
// asks its first agent whether it holds such a message and halts before any later agent when it does.
// Both branches are driven off the engines' flow scenarios, so a new engine or a renamed scenario goes red here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, runTrace, section, ok, eq, toResponder } from './harness.mjs';
import { loadSpecs } from '../tools/gen-flows.mjs';

const RULE = 'Launch from a notification turn';

// laterRoles: label prefixes of agents that run only after the first agent's check. A scenario named in
// noLater halts at a later stage of its engine, so no role is checked for it.
// A throw engine reports the halt as a thrown message, and a returning engine as halted + haltReason.
const EXPECT = {
  'brainstorm': { how: 'throw', laterRoles: [] },
  'decide': { how: 'throw', laterRoles: ['decide', 'review', 'check'] },
  'docs': { how: 'throw', laterRoles: ['scrub', 'curate'], noLater: ['a user request is relayed to the gap-fill gatherer'] },
  'enhance': { how: 'throw', laterRoles: ['verify'] },
  'investigate': { how: 'throw', laterRoles: ['critique'], noLater: ['a user request is relayed to the criteria critic'] },
  'refine': { how: 'return', laterRoles: ['plan-editor'] },
  'review': { how: 'throw', laterRoles: ['verify'] },
  'develop': { how: 'return', laterRoles: ['quality', 'acceptance', 'park', 'final-sweep'] },
};

const specs = await loadSpecs();
const hasRole = (labels, role) => labels.some((l) => l === role || l.startsWith(`${role}:`) || l.startsWith(`${role} `));
const relayedOff = (respond) => {
  const responder = toResponder(respond);
  return (label, prompt, calls) => {
    const reply = responder(label, prompt, calls);
    return reply && typeof reply === 'object' ? { ...reply, relayed_request: false } : reply;
  };
};

section('every engine has a flow scenario for a relayed user request');
for (const spec of specs) {
  const relayed = spec.scenarios.filter((s) => s.name.startsWith('a user request is relayed'));
  ok(EXPECT[spec.name] !== undefined, `${spec.name} has an expectation row in this test`);
  ok(relayed.length > 0, `${spec.name} has a relayed-request scenario`);
}

section('a relayed user request halts the run before any later agent, naming the launch rule');
for (const spec of specs) {
  const want = EXPECT[spec.name];
  if (!want) continue;
  for (const scenario of spec.scenarios.filter((s) => s.name.startsWith('a user request is relayed'))) {
    const trace = await runTrace(spec.engine, { args: scenario.args, respond: scenario.respond });
    const where = `${spec.name} "${scenario.name}"`;
    if (want.how === 'throw') {
      ok(trace.terminal.kind === 'throw' && trace.terminal.message.startsWith('A user request was relayed'), `${where}: throws the relayed-request message`);
      ok(trace.terminal.message.includes(RULE), `${where}: the message names the root CLAUDE.md launch rule`);
    } else {
      ok(trace.terminal.kind === 'return' && trace.out?.halted === true, `${where}: returns halted`);
      ok(String(trace.out?.haltReason).includes(RULE), `${where}: the halt reason names the root CLAUDE.md launch rule`);
      ok(/launched inside a user turn/.test(String(trace.out?.status)), `${where}: the status says the run was launched inside a user turn`);
    }
    const later = want.noLater?.includes(scenario.name) ? [] : want.laterRoles;
    for (const role of later) ok(!hasRole(trace.labels, role), `${where}: no ${role} agent ran`);
    // The gap-fill gatherer runs after the first curator, which must stay the only one.
    if (scenario.name.includes('gap-fill')) eq(trace.labels.filter((l) => l.startsWith('curate')).length, 1, `${where}: no second curator ran`);
  }
}

section('a first agent that reports no relayed request lets the run go on');
for (const spec of specs) {
  const want = EXPECT[spec.name];
  if (!want) continue;
  for (const scenario of spec.scenarios.filter((s) => s.name.startsWith('a user request is relayed'))) {
    const trace = await runTrace(spec.engine, { args: scenario.args, respond: relayedOff(scenario.respond) });
    const where = `${spec.name} "${scenario.name}" with relayed_request false`;
    ok(!trace.terminal.message.startsWith('A user request was relayed'), `${where}: does not throw the relayed-request message`);
    ok(!/relayed/i.test(String(trace.out?.haltReason ?? '')), `${where}: does not halt on a relayed request`);
    if (want.laterRoles.length && !want.noLater?.includes(scenario.name)) ok(want.laterRoles.some((role) => hasRole(trace.labels, role)), `${where}: a later agent ran`);
  }
}

section('the first agent of every engine is asked, and the question reads the same in every engine');
{
  const reference = readFileSync(join(REPO_ROOT, 'workflows/develop/develop-cycle.mjs'), 'utf8').match(/^const RELAYED_REQUEST = .*$/m)?.[0];
  ok(!!reference, 'develop holds the RELAYED_REQUEST constant');
  for (const spec of specs) {
    const want = EXPECT[spec.name];
    if (!want) continue;
    const copy = readFileSync(join(REPO_ROOT, spec.engine), 'utf8').match(/^const RELAYED_REQUEST = .*$/m)?.[0];
    ok(copy === reference, `${spec.engine} holds develop's RELAYED_REQUEST line, byte for byte`);
    for (const relayed of spec.scenarios.filter((s) => s.name.startsWith('a user request is relayed'))) {
      const first = (await runTrace(spec.engine, { args: relayed.args, respond: relayed.respond })).calls[0];
      eq(first?.opts.schema?.properties?.relayed_request?.type, 'boolean', `${spec.name} "${relayed.name}": the first agent's schema carries relayed_request`);
      ok(first?.opts.schema?.required?.includes('relayed_request'), `${spec.name} "${relayed.name}": the first agent's schema requires relayed_request`);
    }
  }
}
