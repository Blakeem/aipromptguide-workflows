// tools/freeze-notes.mjs — a copy of an engine for a live test of the workflow itself.
//
// The suite tests an engine's control flow and never its agents. The only test of how agents handle a
// prompt is a real run, and this makes that run report back: every agent prompt gains a note asking the
// agent to write down, from its own seat, what in the workflow was unclear, wrong or wasteful. The repo
// engine is never touched, so a run can test an engine while another change to it is in progress.
//
//   node tools/freeze-notes.mjs <engine.mjs> <out.mjs> <notesDir> <workflowName>
//
// Put <out.mjs> under this checkout (the Workflow tool refuses a scriptPath outside the working
// directory), for example runs/_engines/<runId>/, which git ignores. Ordinary Node: `node --check` applies.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = 'usage: node tools/freeze-notes.mjs <engine.mjs> <out.mjs> <notesDir> <workflowName>';

// Every call, awaited or not: brainstorm, decide and docs spawn agents inside parallel() and pipeline()
// thunks with no `await`. `agent()` with nothing inside is prose in a comment, not a call.
const CALL_RE = /(?<![\w.$])agent\((?!\))/g;

/** The engine's source with every agent call routed through a wrapper that appends the note. */
export function freeze(code, notesDir, name) {
  const sites = (code.match(CALL_RE) ?? []).length;
  if (!sites) throw new Error('no agent( call sites to wrap');
  const notes = notesDir.replace(/\\/g, '/');
  const helper = `

function __noteAgent(prompt, opts) {
  const slug = String(opts?.label || opts?.phase || 'agent').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return agent(prompt + \`

---
WORKFLOW TEST NOTE. This run is a live test of the ${name} workflow itself. It does not change your
task: do everything above exactly as instructed, and return exactly what your schema asks.
Before your final structured return, write a short note to ${notes}/\${slug}.md (create the directory if
needed; if the file exists, append a new section) about the WORKFLOW from your seat, not about the
code you judged: instructions that were unclear, contradictory or missing; commands or tools that
failed; files you were pointed at that did not exist; schema fields that did not fit what you had to
report; effort the instructions made you waste; what would make this role more effective. Cite
evidence (the instruction text, the command and its output). At most 20 lines. Write
"No workflow issues." if there were none. Never read any other file in that directory.\`, opts);
}
`;
  return { text: code.replace(CALL_RE, '__noteAgent(').replace(/\r\n/g, '\n') + helper, sites };
}

function main(argv) {
  // Input
  const [src, out, notesDir, name] = argv;
  if (!src || !out || !notesDir || !name) throw new Error(USAGE);
  const code = readFileSync(src, 'utf8');

  // Process
  const { text, sites } = freeze(code, notesDir, name);

  // Output
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  return `froze ${src} -> ${out} (${sites} call sites wrapped, notes -> ${notesDir})\n`;
}

// Realpath both sides, as the other tools do: a link in the script path otherwise made the CLI a no-op.
let invokedDirectly = false;
try {
  invokedDirectly = Boolean(process.argv[1])
    && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
} catch { invokedDirectly = false; }

if (invokedDirectly) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`freeze-notes: ${err.message}\n`);
    process.exit(1);
  }
}
