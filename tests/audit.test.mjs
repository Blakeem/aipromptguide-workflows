// audit/audit.mjs — the kind arg that picks the defects flow or the enhancements flow.
// tests/review.test.mjs pins the defects kind and tests/enhance.test.mjs the enhancements kind. This file pins
// the kind itself: its default, its legal values, and the guard that refuses a payload built for the other kind.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';

const ENGINE = 'workflows/audit/audit.mjs';
const UNIT = { id: 'u1', hash: 'h', files: [{ path: 'a.js', loc: 10 }] };
const LDIR = 'E:/r/runs/t/launch-1';
const DEFECTS_ARGS = { runId: 't', root: 'E:/r', launchDir: LDIR, target: { repo: 'E:/repo' }, conventions: 'c', units: [UNIT] };
const ENHANCEMENTS_ARGS = { kind: 'enhancements', runId: 't', root: 'E:/r', launchDir: LDIR, target: { repo: 'E:/repo' }, scope: ['workflows/'], lenses: ['efficiency'] };
const MATRIX = { clarity: 'clear', size: 'small', blast_radius: 'local', scope: 'in-scope', architectural: false };
const DEFECTS_RESPOND = {
  review: { finding_count: 1, wrote_file: true, wrote_clean_marker: false },
  verify: { wrote_file: true, verdicts: [{ finding_id: 'u1-1', file: 'a.js', is_real: true, severity: 'high', decision: 'ACTIONABLE', matrix: MATRIX }] },
};
const ENHANCEMENTS_RESPOND = {
  find: { candidate_ids: ['efficiency-1'], wrote_candidates: true, wrote_clean_marker: false },
  verify: { wrote_lenses: ['efficiency'], verdicts: [{ candidate_id: 'efficiency-1', is_real: true, impact: 'high', size: 'small', decision: 'ADOPT', theme: 't' }] },
};

section('kind defects is the default, so a payload with no kind runs the defects flow it ran before the merge');
{
  const unset = await runEngine(ENGINE, { args: DEFECTS_ARGS, respond: DEFECTS_RESPOND });
  const named = await runEngine(ENGINE, { args: { ...DEFECTS_ARGS, kind: 'defects' }, respond: DEFECTS_RESPOND });
  eq(unset.labels.join(), 'review:u1,verify:u1', 'no kind spawns the defects reviewer and verifier');
  eq(named.labels.join(), unset.labels.join(), 'kind: defects spawns the same agents');
  ok(JSON.stringify(named.out) === JSON.stringify(unset.out), 'and returns the same value');
  ok(named.calls.map((c) => c.prompt).join('\n') === unset.calls.map((c) => c.prompt).join('\n'), 'with the same prompts');
  // A null arg reads as unset, as every other defaulted arg does.
  const nulled = await runEngine(ENGINE, { args: { ...DEFECTS_ARGS, kind: null }, respond: DEFECTS_RESPOND });
  ok(JSON.stringify(nulled.out) === JSON.stringify(unset.out), 'kind: null runs the default defects kind');
  eq(unset.out.issuesDir, 'E:/r/runs/t/issues', 'the defects return names the issues folder');
  eq(unset.out.inventory?.actionable, 1, 'and counts the kept finding');
}

section('kind enhancements runs the enhancements flow and writes proposals, never issues');
{
  const { labels, out } = await runEngine(ENGINE, { args: ENHANCEMENTS_ARGS, respond: ENHANCEMENTS_RESPOND });
  eq(labels.join(), 'find:efficiency,verify:efficiency', 'it spawns the finder and the verifier');
  eq(out.proposalsDir, 'E:/r/runs/t/proposals', 'it returns the proposals folder');
  eq(out.lenses?.[0]?.file, 'E:/r/runs/t/proposals/efficiency.md', 'and the lens\'s proposal file');
  ok(!('issuesDir' in out), 'and no issues folder');
}

section('a lens id past 60 characters keeps the proposal file name a saved run holds, and a shared 60-character prefix collides');
{
  // The name the enhance engine wrote for this lens before the merge, recorded from a pre-merge run.
  const LONG = 'operator effort across every engine guide and every skill entry point today';
  const FILE = 'E:/r/runs/t/proposals/operator_effort_across_every_engine_guide_and_every_skill_en.md';
  const id = 'operator-effort-across-every-engine-guide-and-every-skill-en';
  const { labels, out } = await runEngine(ENGINE, {
    args: { ...ENHANCEMENTS_ARGS, lenses: [LONG] },
    respond: {
      find: { candidate_ids: [`${id}-1`], wrote_candidates: true, wrote_clean_marker: false },
      verify: { wrote_lenses: [id], verdicts: [{ candidate_id: `${id}-1`, is_real: true, impact: 'high', size: 'small', decision: 'ADOPT', theme: 't' }] },
    },
  });
  eq(labels.join(), `find:${id},verify:${id}`, 'the lens id is the 60-character cut of its slug');
  eq(out.lenses?.[0]?.file, FILE, 'and its proposal file keeps the pre-merge name');
  const msg = await throwsWith(ENGINE, { args: { ...ENHANCEMENTS_ARGS, lenses: [`${LONG} one`, `${LONG} two`] } });
  ok(msg.startsWith(`lens ids collide after slugging (${id})`), `two lenses that share a 60-character prefix throw the collision error: ${msg.slice(0, 120)}`);
}

section('a kind outside defects | enhancements throws, naming both kinds');
{
  for (const kind of ['other', 'Defects', '', 3]) {
    const msg = await throwsWith(ENGINE, { args: { ...DEFECTS_ARGS, kind } });
    ok(msg.startsWith('Invalid args.kind') && msg.includes('defects') && msg.includes('enhancements'), `kind ${JSON.stringify(kind)} throws: ${msg.slice(0, 90)}`);
  }
}

section('an arg only the other kind reads throws before any other check, naming the arg and its kind');
{
  // No runId and no root: the guard still speaks first, so the operator learns the payload's kind is wrong.
  for (const key of ['scope', 'lenses', 'minImpact', 'goals', 'context', 'categories']) {
    const msg = await throwsWith(ENGINE, { args: { [key]: ['x'] } });
    ok(msg.startsWith(`Wrong kind for args.${key}:`) && msg.includes('pass kind: enhancements'), `a kind-less payload holding ${key} throws "pass kind: enhancements": ${msg.slice(0, 120)}`);
  }
  const scope = await throwsWith(ENGINE, { args: { ...DEFECTS_ARGS, scope: ['src/'] } });
  ok(scope.includes('pass kind: enhancements') && scope.includes('(the default)'), `a kind-less defects payload holding scope says the default kind ran: ${scope.slice(0, 160)}`);
  const named = await throwsWith(ENGINE, { args: { ...DEFECTS_ARGS, kind: 'defects', lenses: ['efficiency'] } });
  ok(named.startsWith('Wrong kind for args.lenses:') && named.includes('pass kind: enhancements') && !named.includes('(the default)'), `kind: defects holding lenses throws: ${named.slice(0, 120)}`);
  for (const key of ['units', 'lens', 'gates', 'changePolicy', 'reviewSeverity']) {
    const msg = await throwsWith(ENGINE, { args: { ...ENHANCEMENTS_ARGS, [key]: ['x'] } });
    ok(msg.startsWith(`Wrong kind for args.${key}:`) && msg.includes('pass kind: defects'), `kind: enhancements holding ${key} throws naming kind: defects: ${msg.slice(0, 120)}`);
  }
  const both = await throwsWith(ENGINE, { args: { ...ENHANCEMENTS_ARGS, units: [UNIT], gates: {} } });
  ok(both.startsWith('Wrong kind for args.units, args.gates:') && both.includes('reads them'), `two stray args are named together: ${both.slice(0, 120)}`);
}

section('the missing-runId message lists the kind\'s own required args');
{
  const defects = await throwsWith(ENGINE, { args: {} });
  ok(defects.includes('units') && !defects.includes('lenses'), `no kind names units: ${defects.slice(0, 90)}`);
  const enhancements = await throwsWith(ENGINE, { args: { kind: 'enhancements' } });
  ok(enhancements.includes('scope, lenses') && !enhancements.includes('units'), `kind: enhancements names scope and lenses: ${enhancements.slice(0, 90)}`);
}

section('the missing-root message keeps each kind\'s pre-merge wording');
{
  // Only the pre-merge defects engine ever spawned a root-detecting agent, so only that kind says it no longer does.
  const defects = await throwsWith(ENGINE, { args: { runId: 't' } });
  ok(defects.startsWith('args.root is required') && defects.endsWith('The engine no longer spawns an agent to auto-detect it.'), `kind defects names the retired agent: ${defects}`);
  const enhancements = await throwsWith(ENGINE, { args: { kind: 'enhancements', runId: 't' } });
  ok(enhancements.startsWith('args.root is required') && enhancements.endsWith('own directory).'), `kind enhancements ends at the directory: ${enhancements}`);
}

section('kind enhancements runs with no target.repo when every scope path is absolute, and kind defects never does');
{
  const noRepo = { kind: 'enhancements', runId: 't', root: 'E:/r', launchDir: LDIR, scope: ['E:/repo/workflows/'], lenses: ['efficiency'] };
  const ran = await throwsWith(ENGINE, { args: noRepo, respond: ENHANCEMENTS_RESPOND });
  eq(ran, '', 'an all-absolute enhancements scope needs no repo');
  const defectsNoRepo = { runId: 't', root: 'E:/r', launchDir: LDIR, conventions: 'c', units: [UNIT] };
  ok((await throwsWith(ENGINE, { args: defectsNoRepo })).startsWith('args.target.repo is required'), 'a defects payload with no repo throws');
}

section('each kind writes its review and candidates files in its own launch folder, and its triage documents in the stateDir');
// A relaunch under one runId would otherwise replace the review and candidates files an earlier launch wrote.
{
  for (const [kind, base] of [['defects', DEFECTS_ARGS], ['enhancements', ENHANCEMENTS_ARGS]]) {
    const { launchDir: _, ...noLaunch } = base;
    for (const args of [noLaunch, { ...base, launchDir: null }, { ...base, launchDir: ' ' }, { ...base, launchDir: 3 }]) {
      const msg = await throwsWith(ENGINE, { args });
      ok(msg.startsWith('Missing args.launchDir: pass the launchDir that the reserve command of the workflow guide\'s pre-launch step prints'),
        `kind ${kind} with launchDir ${JSON.stringify(args.launchDir)} throws naming the arg: ${msg.slice(0, 50)}`);
    }
    for (const [launchDir, what] of [
      ['E:/r/runs/other/launch-1', 'a launch folder of another stateDir'],
      ['E:/r/runs/t/launch-1/x', 'a folder below a launch folder'],
      ['E:/r/runs/t/launch-0', 'launch-0, since launches count from 1'],
      ['E:/r/runs/t', 'the stateDir itself'],
    ]) {
      const msg = await throwsWith(ENGINE, { args: { ...base, launchDir } });
      ok(msg.startsWith('Invalid args.launchDir: it must be a folder named launch-<n> directly inside the stateDir E:/r/runs/t'),
        `kind ${kind} with ${what} throws: ${msg.slice(0, 70)}`);
    }
    const spelled = await throwsWith(ENGINE, { args: { ...base, launchDir: 'e:\\R\\runs\\t\\launch-3\\' }, respond: kind === 'defects' ? DEFECTS_RESPOND : ENHANCEMENTS_RESPOND });
    eq(spelled, '', `kind ${kind} accepts a Windows spelling of a launch folder`);
  }

  const L2 = 'E:/r/runs/t/launch-2';
  const lens = [{ id: 'x', mandate: 'auditing X' }, { id: 'y', mandate: 'auditing Y' }];
  const defects = await runEngine(ENGINE, {
    args: { ...DEFECTS_ARGS, launchDir: L2, units: [{ ...UNIT, lens }] },
    respond: {
      review: { finding_count: 1, wrote_file: true, wrote_clean_marker: false },
      verify: { wrote_file: true, verdicts: ['u1-a1', 'u1-b1'].map((id) => ({ finding_id: id, file: 'a.js', is_real: true, severity: 'high', decision: 'ACTIONABLE', matrix: MATRIX })) },
    },
  });
  ok(defects.prompt('review:u1/x').includes(`WRITE ${L2}/reviews/u1-x.md (create ${L2}/reviews/ if`), 'a reviewer writes its review file in launch-2');
  ok(defects.prompt('review:u1/y').includes(`[x] ${L2}/reviews/u1-x.md`), 'the next lens reads the earlier lens\'s review file in launch-2');
  const verifier = defects.prompt('verify');
  ok(verifier.includes(`[x] ${L2}/reviews/u1-x.md (u1-a1 to u1-a1)`) && verifier.includes(`[y] ${L2}/reviews/u1-y.md (u1-b1 to u1-b1)`),
    'the verifier reads both review files in launch-2');
  ok(verifier.includes('INVENTORY FILE: write E:/r/runs/t/issues/u1.md (create E:/r/runs/t/issues/ if needed).'), 'and writes the issue file in the stateDir');
  const clean = await runEngine(ENGINE, { args: { ...DEFECTS_ARGS, launchDir: L2 }, respond: { review: { finding_count: 0, wrote_file: false, wrote_clean_marker: true } } });
  ok(clean.prompt('review').includes('WRITE the file E:/r/runs/t/issues/u1.md (create\nE:/r/runs/t/issues/ if needed).'), 'a clean reviewer writes its marker in the stateDir');

  const enhancements = await runEngine(ENGINE, { args: { ...ENHANCEMENTS_ARGS, launchDir: L2 }, respond: ENHANCEMENTS_RESPOND });
  ok(enhancements.prompt('find').includes(`WRITE the file ${L2}/candidates/efficiency.md (create\n${L2}/candidates/ if needed).`), 'a finder writes its candidates file in launch-2');
  const v = enhancements.prompt('verify');
  ok(v.includes(`candidates file: ${L2}/candidates/efficiency.md`), 'the verifier reads the candidates file in launch-2');
  ok(v.includes('proposal file:   E:/r/runs/t/proposals/efficiency.md'), 'and writes the proposal file in the stateDir');
  const marker = await runEngine(ENGINE, { args: { ...ENHANCEMENTS_ARGS, launchDir: L2 }, respond: { find: { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: true } } });
  ok(marker.prompt('find').includes('WRITE the file E:/r/runs/t/proposals/efficiency.md\n(create E:/r/runs/t/proposals/ if needed).'), 'a clean finder writes its marker in the stateDir');

  // No prompt names a review or candidates file outside its own launch folder.
  const named = [defects, clean, enhancements, marker].flatMap((r) => r.calls.flatMap((c) => c.prompt.match(/E:\/r\/runs\/t\/[^\s`'"()]*(?:reviews|candidates)\/[^\s`'"()]*/g) ?? []));
  ok(named.length > 0 && named.every((p) => p.startsWith(`${L2}/`)), `every review and candidates path a prompt names lies in launch-2: ${[...new Set(named)].join(', ')}`);
}

section('a relaunch reserves a new launch folder that keeps the triage documents, and a relayed request relaunches in one');
{
  const keep = (what) => `start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts. That pre-launch command is node <launch.mjs> reserve 'E:/r/runs/t' --keep ${what}, and launchDir is the folder it prints`;
  const { out } = await runEngine(ENGINE, { args: DEFECTS_ARGS, respond: { review: null } });
  const first = String(out.nextStep ?? '').split('\n')[0];
  ok(first.includes(`under this runId and with a newly reserved launchDir in place of ${LDIR}, manifest.staleUnits`) && first.endsWith(`To relaunch, ${keep('issues')}.`),
    `the re-review reserves a new launch folder that keeps the issue files: ${first.slice(-200)}`);
  const relayedDefects = await throwsWith(ENGINE, { args: DEFECTS_ARGS, respond: { review: { finding_count: 0, wrote_file: false, wrote_clean_marker: false, relayed_request: true } } });
  ok(relayedDefects.endsWith(`${keep('issues')}. Pass that newly reserved launchDir in place of ${LDIR}.`), `a relayed request to a reviewer relaunches in a new launch folder: ${relayedDefects.slice(-120)}`);

  const { out: lost } = await runEngine(ENGINE, { args: ENHANCEMENTS_ARGS, respond: { find: null } });
  ok(String(lost.nextStep ?? '').includes(`Re-run those lenses with the same runId and a newly reserved launchDir in place of ${LDIR}. To relaunch, ${keep('proposals')}.`),
    'a lens re-run reserves a new launch folder that keeps the proposal files');
  const { out: partial } = await runEngine(ENGINE, { args: { ...ENHANCEMENTS_ARGS, lenses: ['efficiency', 'simplification'] }, respond: { 'find:simplification': null, ...ENHANCEMENTS_RESPOND } });
  ok(String(partial.nextStep ?? '').includes(`offer to re-run just those, with the same runId and a newly reserved launchDir in place of ${LDIR}.`)
    && String(partial.nextStep ?? '').includes(`To relaunch, ${keep('proposals')}.`), 'a failed lens\'s re-run reserves a new launch folder too');
  const relayedEnhancements = await throwsWith(ENGINE, { args: ENHANCEMENTS_ARGS, respond: { find: { candidate_ids: [], wrote_candidates: false, wrote_clean_marker: false, relayed_request: true } } });
  ok(relayedEnhancements.endsWith(`${keep('proposals')}. Pass that newly reserved launchDir in place of ${LDIR}.`), `a relayed request to a finder relaunches in a new launch folder: ${relayedEnhancements.slice(-120)}`);
}
