// brainstorm/brainstorm-cycle.mjs: the concurrent generator fan-out.
// Focus: the control plane. Each variation lives in its folder, so the schema and the return carry only its index.
import { runEngine, section, ok, eq } from './harness.mjs';

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
