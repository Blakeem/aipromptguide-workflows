// A FIXTURE engine (not a real workflow — it is not in ENGINES and ships to nobody). One ungrouped call
// loops back into a fan-out of two lanes for two rounds, the shape whose loop count must read per round
// and never per entered lane. No shipped engine loops a single call back into a fan-out any more.
//
// It lives in tests/fixtures/ and NEVER in tools/flows/ — that directory is the CLI's
// regenerate-everything root, so a fixture dropped there would get a FLOW.md emitted for it.
export const meta = {
  name: 'fanout-loop-fixture',
  description: 'Fixture engine: a two-lane fan-out, then one check, for two rounds.',
  phases: [
    { title: 'Fixture', detail: 'Every call runs here.' },
  ],
};

for (let round = 1; round <= 2; round++) {
  await parallel(['a', 'b'].map((lane) => () => agent(`work ${lane}`, { label: `work:${lane}`, phase: 'Fixture', model: 'sonnet' })));
  await agent('check', { label: `check:r${round}`, phase: 'Fixture', model: 'sonnet' });
}

return { status: 'fixture done' };
