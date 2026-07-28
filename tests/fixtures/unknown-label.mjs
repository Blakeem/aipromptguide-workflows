// A FIXTURE engine (not a real workflow — it is not in ENGINES and ships to nobody). It spawns one
// agent whose label is built at runtime, so `readRoles` cannot see it: that is the only way to produce
// the "label matches no known role" case gen-flows.mjs must reject rather than invent a node for.
//
// It lives in tests/fixtures/ and NEVER in tools/flows/ — that directory is the CLI's
// regenerate-everything root, so a fixture dropped there would get a FLOW.md emitted for it.
export const meta = {
  name: 'unknown-label-fixture',
  description: 'Fixture engine: one static label, one built at runtime.',
  phases: [
    { title: 'Fixture', detail: 'Both calls run here.' },
  ],
};

const runtimeLabel = ['ghost', 'role'].join('-');   // invisible to the static reader, by construction

await agent('first', { label: 'known', phase: 'Fixture', model: 'sonnet' });
await agent('second', { label: runtimeLabel, phase: 'Fixture', model: 'sonnet' });

return { status: 'fixture done' };
