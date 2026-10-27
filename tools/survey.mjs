// tools/survey.mjs — gathers the exit-survey answers of a notes run into one file, grouped by question.
//
// A run launched with the `notes` arg has every agent append its answers to EXIT-SURVEY.md, which sits beside
// this file, to its own file in the notes folder. This reads each of those files and writes the folder's
// SURVEY.md: each question's answers labelled by agent, with the "none" answers counted and left out.
//
//   node tools/survey.mjs <dir>
//
// Exit 0 names the file it wrote, exit 1 prints the reason on stderr. It writes nothing but SURVEY.md.
//
// Ordinary Node, not an engine: no harness globals, no deps, `node --check` applies.

import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'usage: node tools/survey.mjs <dir>';
export const SURVEY_FILE = 'SURVEY.md';
const QUESTIONS_FILE = fileURLToPath(new URL('./EXIT-SURVEY.md', import.meta.url));

const HEADING = /^##\s+(\S+)\s*(.*)$/;
const ANSWER = /^\s*Q(\d+):\s*(.*)$/i;
const isNone = (answer) => /^(none\.?)?$/i.test(answer.trim());

/** The numbered questions under the survey's "## Questions" heading, as a Map of number to text. */
export function parseQuestions(text) {
  const questions = new Map();
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) { inSection = /^##\s+Questions\s*$/.test(line); continue; }
    const m = inSection && /^(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) questions.set(Number(m[1]), m[2]);
  }
  return questions;
}

/**
 * Every answer set of one answer file: { label, date, answers: Map of question number to text }.
 * Answers above the first heading belong to a set labelled `fileLabel`. A line that is neither a heading
 * nor an answer continues the answer above it, across blank lines, since an agent may wrap one.
 */
export function parseAnswers(text, fileLabel) {
  const sets = [];
  let current = null;
  let lastQuestion = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { label: heading[1], date: heading[2].trim(), answers: new Map() };
      sets.push(current);
      lastQuestion = null;
      continue;
    }
    const answer = ANSWER.exec(line);
    if (answer) {
      if (!current) { current = { label: fileLabel, date: '', answers: new Map() }; sets.push(current); }
      lastQuestion = Number(answer[1]);
      current.answers.set(lastQuestion, answer[2].trim());
      continue;
    }
    if (!line.trim()) continue;
    if (current && lastQuestion !== null) {
      current.answers.set(lastQuestion, `${current.answers.get(lastQuestion)} ${line.trim()}`.trim());
    }
  }
  return sets;
}

/** SURVEY.md's text: one section per question, its answers labelled by agent and its "none" answers counted. */
export function renderSurvey(sets, questions, fileCount) {
  const numbers = new Set(questions.keys());
  for (const set of sets) for (const n of set.answers.keys()) numbers.add(n);
  const lines = ['# Exit survey answers', '', `${sets.length} answer set(s) from ${fileCount} file(s).`];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const given = sets.filter((s) => s.answers.has(n));
    const kept = given.filter((s) => !isNone(s.answers.get(n)));
    lines.push('', questions.has(n) ? `## Q${n}. ${questions.get(n)}` : `## Q${n} (not in the current survey)`, '');
    for (const s of kept) lines.push(`- **${s.label}**${s.date ? ` (${s.date})` : ''}: ${s.answers.get(n)}`);
    if (kept.length) lines.push('');
    lines.push(`"none" answers: ${given.length - kept.length} of ${given.length}.`);
  }
  return `${lines.join('\n')}\n`;
}

export function run(argv) {
  // Input
  const [dir] = argv;
  if (!dir) throw new Error(USAGE);
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) throw new Error(`${dir} is not a folder. Pass the notes folder the run's notes.dir named.`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== SURVEY_FILE.toLowerCase()).sort();
  if (!files.length) throw new Error(`${dir} holds no answer file, so no agent answered the survey. ${SURVEY_FILE} is not written.`);
  const questions = parseQuestions(readFileSync(QUESTIONS_FILE, 'utf8'));
  if (!questions.size) throw new Error(`${QUESTIONS_FILE} holds no numbered question under "## Questions".`);

  // Process
  const sets = files.flatMap((f) => parseAnswers(readFileSync(join(dir, f), 'utf8'), f.replace(/\.md$/, '')));
  const text = renderSurvey(sets, questions, files.length);

  // Output
  const out = join(dir, SURVEY_FILE);
  writeFileSync(out, text);
  return `wrote ${out} (${sets.length} answer set(s) from ${files.length} file(s))\n`;
}

// Node resolves the main module through realpath, so both sides are realpathed, as in plan-edit.mjs.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`survey: ${err.message}\n`);
    process.exit(1);
  }
}
