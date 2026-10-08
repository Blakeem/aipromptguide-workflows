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
