// The notes arg: every engine ends each agent prompt with the exit-survey instruction when it is set, changes no
// prompt when it is unset, and throws on a notes arg that lacks a path. tools/survey.mjs groups the answers.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, ENGINES, runTrace, throwsWith, section, ok, eq } from './harness.mjs';
import { parseAnswers, parseQuestions, renderSurvey, run as survey, SURVEY_FILE } from '../tools/survey.mjs';
import brainstormFlow from '../tools/flows/brainstorm.flow.mjs';
import decideFlow from '../tools/flows/decide.flow.mjs';
import developFlow from '../tools/flows/develop.flow.mjs';
import docsFlow from '../tools/flows/docs.flow.mjs';
import enhanceFlow from '../tools/flows/enhance.flow.mjs';
import investigateFlow from '../tools/flows/investigate.flow.mjs';
import refineFlow from '../tools/flows/refine.flow.mjs';
import reviewFlow from '../tools/flows/review.flow.mjs';

const FLOWS = [developFlow, refineFlow, reviewFlow, enhanceFlow, decideFlow, docsFlow, brainstormFlow, investigateFlow];
// Backslashes and a trailing slash, so each engine's normalization is exercised.
const NOTES = { dir: 'E:\\state\\notes\\', survey: 'E:\\aipg\\tools\\EXIT-SURVEY.md' };
const noteFor = (label) => `\n\nEXIT SURVEY: before your final return, read E:/aipg/tools/EXIT-SURVEY.md and append your answers to E:/state/notes/${label.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}.md in the format it names, creating the folder if needed. That file is the one write allowed beyond your task's own writes, and you read no other file in that folder. The survey never changes your task or your return.`;
const runnable = (flow) => flow.scenarios.filter((s) => s.respond && s.args && typeof s.args === 'object');

section('every flow table drives each engine');
eq(FLOWS.map((f) => f.engine).sort().join(), [...ENGINES].sort().join(), 'the tables cover every engine');

section('each engine calls agent() in one place, so no call site skips the survey');
for (const engine of ENGINES) {
  const src = readFileSync(`${REPO_ROOT}/${engine}`, 'utf8');
  eq((src.match(/(?<![\w.$])agent\((?!\))/g) ?? []).length, 1, `${engine}: one agent( call, inside callAgent`);
}

section('notes set: every prompt ends with the survey instruction. notes unset: no prompt carries it');
for (const flow of FLOWS) {
  let calls = 0;
  let matched = 0;
  let plainClean = true;
  let sameAgents = true;
  for (const scenario of runnable(flow)) {
    const plain = await runTrace(flow.engine, scenario);
    const noted = await runTrace(flow.engine, { ...scenario, args: { ...scenario.args, notes: NOTES } });
    if (noted.labels.join() !== plain.labels.join()) sameAgents = false;
    for (const [i, call] of noted.calls.entries()) {
      calls++;
      if (call.label !== '(unlabeled)' && call.prompt === `${plain.calls[i]?.prompt}${noteFor(call.label)}`) matched++;
    }
    if (plain.calls.some((c) => c.prompt.includes('EXIT SURVEY'))) plainClean = false;
  }
  ok(calls > 0, `${flow.engine}: the scenarios spawn agents (${calls})`);
  ok(sameAgents, `${flow.engine}: notes run the same agents in the same order`);
  eq(matched, calls, `${flow.engine}: every noted prompt is the plain prompt plus the instruction naming its own file`);
  ok(plainClean, `${flow.engine}: with notes unset, no prompt names the survey`);
}

section('a notes arg without both absolute paths throws, naming the arg');
const BAD_NOTES = [
  ['dir only', { dir: 'E:/notes' }],
  ['survey only', { survey: 'E:/aipg/tools/EXIT-SURVEY.md' }],
  ['a relative dir', { dir: 'notes', survey: 'E:/aipg/tools/EXIT-SURVEY.md' }],
  ['a blank survey', { dir: 'E:/notes', survey: '  ' }],
  ['null', null],
  ['a string', 'E:/notes'],
  ['an array', ['E:/notes', 'E:/aipg/tools/EXIT-SURVEY.md']],
];
for (const flow of FLOWS) {
  const scenario = runnable(flow)[0];
  for (const [what, notes] of BAD_NOTES) {
    const msg = await throwsWith(flow.engine, { ...scenario, args: { ...scenario.args, notes } });
    ok(msg.startsWith('Invalid notes arg: args.notes must be { dir, survey }'), `${flow.engine}: ${what} throws (${msg.slice(0, 60)})`);
  }
}

section('develop, refine and debug refuse a notes folder inside the target repo');
for (const flow of [developFlow, refineFlow, reviewFlow]) {
  const scenario = runnable(flow)[0];
  const repo = scenario.args.target.repo;
  const msg = await throwsWith(flow.engine, { ...scenario, args: { ...scenario.args, notes: { dir: `${repo}/notes`, survey: 'E:/aipg/tools/EXIT-SURVEY.md' } } });
  ok(msg.startsWith('args.notes.dir is inside the target repo.'), `${flow.engine}: a notes dir under ${repo} throws (${msg.slice(0, 60)})`);
}

section('develop refuses a notes folder inside its run-state, since the blind reviewer\'s prompt names the folder');
{
  const scenario = runnable(developFlow)[0];
  const state = `${scenario.args.root}/runs/${scenario.args.runId}`;
  for (const dir of [state, `${state.toUpperCase()}/gate`]) {
    const msg = await throwsWith(developFlow.engine, { ...scenario, args: { ...scenario.args, notes: { dir, survey: 'E:/aipg/tools/EXIT-SURVEY.md' } } });
    ok(msg.startsWith('args.notes.dir is inside the run-state folder.'), `a notes dir at ${dir} throws (${msg.slice(0, 60)})`);
  }
  const beside = await runTrace(developFlow.engine, { ...scenario, args: { ...scenario.args, notes: { dir: `${state}-notes`, survey: 'E:/aipg/tools/EXIT-SURVEY.md' } } });
  ok(beside.calls.length > 0, `a notes dir at ${state}-notes, beside the run-state, runs`);
}

section('survey.mjs reads the questions of EXIT-SURVEY.md');
{
  const questions = parseQuestions(readFileSync(`${REPO_ROOT}/tools/EXIT-SURVEY.md`, 'utf8'));
  eq([...questions.keys()].join(), '1,2,3,4,5,6', 'six numbered questions');
  ok(questions.get(1).startsWith('Which instruction was unclear'), 'question 1 is the unclear-instruction question');
}

section('survey.mjs groups a folder\'s answers by question and counts the "none" answers');
{
  const dir = mkdtempSync(join(tmpdir(), 'aipg-survey-'));
  try {
    writeFileSync(join(dir, 'develop-a-r1.md'), [
      '## develop-a-r1 Tue Oct 27 10:00:00 2026',
      'Q1: "read it" names no file.',
      'Q2: none',
      'Q3: none.',
      'Q4: none',
      'Q5: the gate log',
      'Q6: name the file',
      '',
      '## develop-a-r1 Tue Oct 27 11:00:00 2026',
      'Q1: None',
      'Q2: plan-pull exited 1',
      '  with no reason',
      'Q5: none',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'quality-a-r1.md'), 'Q1: the ledger rule\r\nQ2: none\r\n');
    writeFileSync(join(dir, SURVEY_FILE), 'an earlier summary, never read as answers\n');
    const out = survey([dir]);
    const text = readFileSync(join(dir, SURVEY_FILE), 'utf8');
    ok(out.includes('3 answer set(s) from 2 file(s)'), `the CLI names the sets and files (${out.trim()})`);
    const section1 = text.slice(text.indexOf('## Q1.'), text.indexOf('## Q2.'));
    ok(section1.includes('- **develop-a-r1** (Tue Oct 27 10:00:00 2026): "read it" names no file.')
      && section1.includes('- **quality-a-r1**: the ledger rule'), 'Q1 holds each agent\'s answer, labelled by agent');
    ok(section1.includes('"none" answers: 1 of 3.') && !section1.includes('None'), 'Q1 counts its one "none" answer and leaves it out');
    const section2 = text.slice(text.indexOf('## Q2.'), text.indexOf('## Q3.'));
    ok(section2.includes('plan-pull exited 1 with no reason') && section2.includes('"none" answers: 2 of 3.'),
      'Q2 joins a wrapped answer and counts two "none" answers');
    const section3 = text.slice(text.indexOf('## Q3.'), text.indexOf('## Q4.'));
    ok(!section3.includes('- **') && section3.includes('"none" answers: 1 of 1.'), 'Q3 lists no answer when every answer is "none"');
    ok(!text.includes('an earlier summary'), 'an earlier SURVEY.md is not read as answers');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

section('survey.mjs keeps a wrapped answer, labels a question the survey no longer asks, and fails on a folder with no answers');
{
  const wrapped = parseAnswers('Q1: first part\n\n  second part\nQ2: none\n', 'wrapped');
  eq(wrapped[0].answers.get(1), 'first part second part', 'a wrapped line after a blank line joins the answer above it');
  const sets = parseAnswers('Q9: an old question\n', 'old');
  ok(renderSurvey(sets, new Map([[1, 'Q one']]), 1).includes('## Q9 (not in the current survey)'), 'an answer to a dropped question keeps its own section');
  const dir = mkdtempSync(join(tmpdir(), 'aipg-survey-'));
  try {
    let msg = '';
    try { survey([dir]); } catch (e) { msg = e.message; }
    ok(msg.includes('holds no answer file'), `an empty folder fails (${msg})`);
    msg = '';
    try { survey([join(dir, 'missing')]); } catch (e) { msg = e.message; }
    ok(msg.includes('is not a folder'), `a missing folder fails (${msg})`);
    msg = '';
    try { survey([]); } catch (e) { msg = e.message; }
    ok(msg.startsWith('usage:'), 'no argument prints the usage');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
