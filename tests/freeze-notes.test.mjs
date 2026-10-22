// tools/freeze-notes.mjs — the frozen copy a live test runs must still BE the engine: the same agents in
// the same order, each prompt the original plus the note, and nothing else changed.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { REPO_ROOT, ENGINES, runTrace, section, ok, eq } from './harness.mjs';
import { freeze } from '../tools/freeze-notes.mjs';
import developFlow from '../tools/flows/develop.flow.mjs';
import brainstormFlow from '../tools/flows/brainstorm.flow.mjs';

section('every engine freezes, with each agent call site wrapped, awaited or not');
for (const engine of ENGINES) {
  const { text, sites } = freeze(readFileSync(`${REPO_ROOT}/${engine}`, 'utf8'), 'E:\\state\\notes', 'test');
  const body = text.replace(/\n\nfunction __noteAgent[\s\S]*$/, '');
  eq((body.match(/__noteAgent\(/g) ?? []).length, sites, `${engine}: ${sites} site(s) wrapped`);
  ok(!/(?<![\w.$])agent\((?!\))/.test(body) && !text.includes('\r'), `${engine}: none left unwrapped, and LF only`);
}

section('a frozen engine runs the same path, and every prompt ends with the note');
// Under runs/, which git ignores: the harness loads an engine by its path in this checkout. brainstorm is
// here because its only call sits in a parallel() thunk with no `await`, which the first version missed.
for (const flow of [developFlow, brainstormFlow]) {
  const dir = `${REPO_ROOT}/runs/_engines/_freeze-test`;
  const frozenPath = `runs/_engines/_freeze-test/${flow.engine.split('/').pop()}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${REPO_ROOT}/${frozenPath}`, freeze(readFileSync(`${REPO_ROOT}/${flow.engine}`, 'utf8'), 'E:/state/notes', 'test').text);
  try {
    const scenario = flow.scenarios.find((s) => s.respond);
    const plain = await runTrace(flow.engine, scenario);
    const frozen = await runTrace(frozenPath, scenario);
    eq(frozen.calls.map((c) => c.label).join(), plain.calls.map((c) => c.label).join(), `${flow.engine}: the same agents run in the same order`);
    ok(frozen.calls.length > 0 && frozen.calls.every((c, i) => c.prompt.startsWith(plain.calls[i].prompt) && c.prompt.includes('write a short note to E:/state/notes/')),
      `${flow.engine}: each prompt is the original plus the note naming the notes directory`);
    ok(frozen.calls.length > 0 && frozen.calls.every((c) => /more effective\.\s+That note file is the one write allowed beyond the writes your task allows\./.test(c.prompt)),
      `${flow.engine}: each prompt names the notes file as the one extra write, right after the notes-file sentence`);
    ok(frozen.calls.length > 0 && frozen.calls.every((c) => /Start the section with a heading line\s+"## <label> <date>", where <label> is this file's name without \.md and <date> is the output of the date\s+command run when you write the note\./.test(c.prompt)),
      `${flow.engine}: each prompt tells the agent to head its section with its label and the date from the date command`);
    ok(frozen.calls.every((c, i) => !/\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}:\d{2}/.test(c.prompt.slice(plain.calls[i].prompt.length))),
      `${flow.engine}: the note text holds no date or time the engine computed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
