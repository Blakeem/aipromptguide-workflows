// brainstorm/brainstorm-cycle.mjs: the concurrent generator fan-out.
// Focus: the control plane. Each variation lives in its folder, so the schema and the return carry only its index.
import { runEngine, runTrace, throwsWith, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';

const ENGINE = 'workflows/brainstorm/brainstorm-cycle.mjs';
const S = 'E:/r/runs/t';
// Every lens folder a launch writes lies in its launch folder.
const L = `${S}/launch-1`;
const baseArgs = { runId: 't', root: 'E:/r', launchDir: L, brief: 'Design a landing page', lenses: ['minimalist', 'playful'] };
const GEN = { entry: 'index.md', summary: 'one line' };
const RELAUNCH = `start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts. That pre-launch command is node <launch.mjs> reserve '${S}', and launchDir is the folder it prints`;
const REPLACE_NOTE = 'The file exists before you write it only when an interrupted attempt of this launch left it, which a replay meets, so Read it first, if it exists, and then replace its entire content.';

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
  ok(out.nextStep.startsWith(`Present the 2 of 2 variation(s) that landed under ${L}/variations/:`),
    'the non-empty nextStep opens with the landed count out of the lens count and the variations dir');
  ok(out.nextStep.includes("relay each one's entry path with its one-line summary"),
    'the non-empty nextStep says to relay each entry path with its summary');
}
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { 'generate:playful': null, generate: GEN } });
  ok(out.nextStep.startsWith('Present the 1 of 2 variation(s)'), 'a failed lens lowers the landed count');
  ok(out.nextStep.includes('these lenses produced NOTHING: playful'), 'the failed-lens clause names the lens');
  ok(out.nextStep.includes(`offer to re-run just those with the same runId and a newly reserved launchDir in place of ${L}, so the re-run writes them in its own launch folder while the variations above stay in ${L}/variations/. To relaunch, ${RELAUNCH}.`),
    'and the re-run reserves a new launch folder and names the notification-turn launch path');
}
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: null } });
  ok(out.nextStep.includes(`re-run those lenses with the same runId and a newly reserved launchDir in place of ${L} (`) && out.nextStep.endsWith(`To relaunch, ${RELAUNCH}.`),
    `a run that produced nothing re-runs in a new launch folder: ${out.nextStep.slice(-120)}`);
}

section('a dead generator lands in failed as one { id, stage } entry, and the return carries no phase');
{
  const { out } = await runEngine(ENGINE, { args: baseArgs, respond: { 'generate:playful': null, generate: GEN } });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'playful', stage: 'generate' }]),
    'failed holds one entry naming the dead lens and the generate stage');
  ok(!('phase' in out), 'the return has no phase key');
}

section('the generator lists every file in its folder in its entry file, so a file an interrupted attempt left is visible');
// A replay meets the files its interrupted attempt left beside the new ones, such as an old index.html beside a new index.md.
{
  const { prompt } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: GEN } });
  const p = prompt('generate:minimalist').replace(/\s+/g, ' ');
  ok(p.includes(`3. LIST every file in ${L}/variations/minimalist/ in a final "Files in this folder" section of your entry file, in that file's own format`),
    'the generator lists its own folder in its entry file');
  ok(p.includes('An interrupted attempt of this launch, which a replay meets, may have left files there, so mark each file you did not write in this attempt "(interrupted attempt, not part of this variation)".'),
    'and marks each file an interrupted attempt left');
  ok(!p.includes('earlier run'), 'and names no earlier run, since a launch folder holds none');
}

section('a launch writes every lens folder in its own launch folder, so a second launch replaces no file of the first');
{
  const L2 = `${S}/launch-2`;
  const { out, calls } = await runEngine(ENGINE, { args: { ...baseArgs, launchDir: L2 }, respond: { generate: GEN } });
  eq(out.variationsDir, `${L2}/variations`, 'variationsDir lies inside launch-2');
  for (const c of calls) {
    const p = c.prompt.replace(/\s+/g, ' ');
    const lens = c.label.slice('generate:'.length);
    ok(p.includes(`2. WRITE it into ${L2}/variations/${lens}/ (create it)`), `${c.label}: the generator writes its lens folder inside launch-2`);
    const named = p.match(/E:\/r\/runs\/t\/[^\s`'"),]*/g) ?? [];
    eq(named.filter((path) => !path.startsWith(`${L2}/`)).join(', '), '', `${c.label}: every run-state path the prompt names lies inside launch-2`);
  }
}

section('a launch without a valid launchDir throws, naming the arg, before any agent runs');
{
  const { launchDir: _, ...NO_LAUNCH } = baseArgs;
  for (const args of [NO_LAUNCH, { ...baseArgs, launchDir: '' }]) {
    const msg = await throwsWith(ENGINE, { args, respond: { generate: GEN } });
    ok(msg.startsWith('Missing args.launchDir: pass the launchDir that the reserve command of the workflow guide\'s pre-launch step prints'),
      `launchDir ${JSON.stringify(args.launchDir)} throws naming the arg: ${msg.slice(0, 50)}`);
  }
  for (const launchDir of ['E:/r/runs/other/launch-1', `${S}/variations`]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, launchDir }, respond: { generate: GEN } });
    ok(msg.startsWith(`Invalid args.launchDir: it must be a folder named launch-<n> directly inside the stateDir ${S}`), `${launchDir} throws: ${msg.slice(0, 60)}`);
    const { calls } = await runTrace(ENGINE, { args: { ...baseArgs, launchDir }, respond: { generate: GEN } });
    eq(calls.length, 0, `${launchDir}: no generator runs`);
  }
  const noRun = await throwsWith(ENGINE, { args: {}, respond: { generate: GEN } });
  ok(noRun.includes('{ runId, root, launchDir, lenses, brief|planPath }'), `the missing-runId message names launchDir: ${noRun.slice(0, 80)}`);
}

section('a relayed request relaunches in a new launch folder');
{
  const msg = await throwsWith(ENGINE, { args: baseArgs, respond: { generate: { ...GEN, relayed_request: true } } });
  ok(msg.includes(`Relaunch with the same args and runId and a newly reserved launchDir in place of ${L}, from a notification turn`) && msg.endsWith(`${RELAUNCH}.`),
    `the throw names the new launch folder and the reserve command: ${msg.slice(-160)}`);
}

await pinRoleMaps({
  engine: ENGINE, name: 'brainstorm', defaults: { generate: 'opus' },
  runs: [{ args: baseArgs, respond: { generate: GEN }, labels: { generate: 'generate' } }],
});

// A replay meets the files its interrupted attempt left, and the Write tool refuses to overwrite one the agent has not read.
section("every prompt that writes a file says to Read a file an interrupted attempt of its launch left first, and a rejected write is not a write");
{
  const { prompt } = await runEngine(ENGINE, { args: baseArgs, respond: { generate: GEN } });
  const sites = [["the generator's variation files", prompt('generate'), 1, 1]];
  pinWriteNotes(sites, REPLACE_NOTE);
  pinFileWriteNote(sites);
}
