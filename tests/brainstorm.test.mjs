// brainstorm/brainstorm-cycle.mjs: the concurrent generator fan-out.
// Focus: the control plane. Each variation lives in its folder, so the schema and the return carry only its index.
import { runEngine, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';

const ENGINE = 'workflows/brainstorm/brainstorm-cycle.mjs';
const baseArgs = { runId: 't', root: 'E:/r', brief: 'Design a landing page', lenses: ['minimalist', 'playful'] };
const GEN = { entry: 'index.md', summary: 'one line' };

section('the generate schema holds the index only, and each variation returns exactly its index fields');
{
  const { out, calls } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: GEN } });
  const genProps = calls.find((c) => c.label.startsWith('generate'))?.opts.schema?.properties || {};
  ok(!('files' in genProps), 'the generate schema has no files property');
  eq(out.variations.length, 2, 'one variation per lens');
  ok(out.variations.every((v) => Object.keys(v).join() === 'lens,focus,entry,summary'),
    'each variation holds exactly lens, focus, entry and summary');
}

section('nextStep names how many variations landed and relays each entry with its summary');
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: GEN } });
  ok(out.nextStep.startsWith('Present the 2 of 2 variation(s) that landed under E:/r/runs/t/variations/:'),
    'the non-empty nextStep opens with the landed count out of the lens count and the variations dir');
  ok(out.nextStep.includes("relay each one's entry path with its one-line summary"),
    'the non-empty nextStep says to relay each entry path with its summary');
}
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { 'generate:playful': null, generate: GEN } });
  ok(out.nextStep.startsWith('Present the 1 of 2 variation(s)'), 'a failed lens lowers the landed count');
  ok(out.nextStep.includes('these lenses produced NOTHING: playful'), 'the failed-lens clause names the lens');
}

section('a dead generator lands in failed as one { id, stage } entry, and the return carries no phase');
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { 'generate:playful': null, generate: GEN } });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'playful', stage: 'generate' }]),
    'failed holds one entry naming the dead lens and the generate stage');
  ok(!('phase' in out), 'the return has no phase key');
}

section('the generator lists every file in its folder in its entry file, so an earlier run\'s file is visible');
// A same-runId re-run leaves an earlier run's files beside the new ones, such as an old index.html beside a new index.md.
{
  const { prompt } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: GEN } });
  const p = prompt('generate:minimalist').replace(/\s+/g, ' ');
  ok(p.includes('3. LIST every file in E:/r/runs/t/variations/minimalist/ in a final "Files in this folder" section of your entry file, in that file\'s own format'),
    'the generator lists its own folder in its entry file');
  ok(p.includes('mark each file you did not write in this run "(earlier run, not part of this variation)".'), 'and marks each earlier run\'s file');
}

await pinRoleMaps({
  engine: ENGINE, name: 'brainstorm', defaults: { generate: 'opus' },
  runs: [{ args: baseArgs, respond: { generate: GEN }, labels: { generate: 'generate' } }],
});

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite one the agent has not read.
section("every prompt that writes a file says to Read an earlier launch's file first, and a rejected write is not a write");
{
  const { prompt } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: GEN } });
  const sites = [["the generator's variation files", prompt('generate'), 1, 1]];
  pinWriteNotes(sites);
  pinFileWriteNote(sites);
}
