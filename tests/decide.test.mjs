// decide/decide-cycle.mjs: the bounded investigator chain, the decider, the final reviewer, and what the run
// hands back. No stage loops back, so what the engine controls is the chain's order and its two stops, the
// halt on each unattested write, the throw on each dead agent, the terminal the reviewer's counts pick, and
// the files each prompt names.
import { runEngine, runTrace, throwsWith, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';

const ENGINE = 'workflows/decide/decide-cycle.mjs';
const S = 'E:/r/runs/t';
// Every file a launch writes lies in its launch folder.
const L = `${S}/launch-1`;
const I = (k) => `${L}/investigations/i${k}.md`;

const baseArgs = { runId: 't', root: 'E:/r', planPath: 'E:/r/plans/t/requirements.md', launchDir: L };
const LAUNCH_PATH = 'start the pre-launch command with run_in_background, end the turn, and call the Workflow tool in the turn its notification starts';
const RELAUNCH = `${LAUNCH_PATH}. That pre-launch command is node <launch.mjs> reserve '${S}', and launchDir is the folder it prints`;
const REPLACE_NOTE = 'The file exists before you write it only when an interrupted attempt of this launch left it, which a replay meets, so Read it first, if it exists, and then replace its entire content.';
const run = (respond, args = baseArgs) => runEngine(ENGINE, { args, respond });

const OPEN      = { wrote_file: true, relayed_request: false };
const CHALLENGE = { wrote_file: true, contributed: true };
const DRY       = { ...CHALLENGE, contributed: false };
const RANKING   = [{ rank: 1, title: 'in-process LRU', combines_with: [], excludes: [2] }, { rank: 2, title: 'redis', combines_with: [], excludes: [1] }];
const DECIDE    = { wrote_file: true, ranking: RANKING, flip: 'robust', user_checks: 0 };
const REVIEW    = { wrote_file: true, defects: 0, edits: 0, flags: 0, ranking: RANKING, flip: 'robust' };
// The responder matches the longest label prefix, so i1 gets OPEN and every later challenger CHALLENGE.
const CLEAN     = { 'investigate i1': OPEN, 'investigate i': CHALLENGE, decide: DECIDE, review: REVIEW };
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ');
// The indexes of each needle in the text, so a test can pin the order a prompt names files in.
const positions = (text, needles) => needles.map((n) => text.indexOf(n));
const ascending = (xs) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));

section('every challenger contributing runs the chain to maxInvestigators, then the decider and the reviewer');
{
  const { out, labels, calls, logs } = await run(CLEAN);
  eq(labels.join(','), 'investigate i1,investigate i2,investigate i3,investigate i4,decide,review', 'maxInvestigators defaults to 4, and the six agents run in order');
  ok(calls.every((c) => c.group === null), 'no agent runs in a fan-out, since each reads the file before it');
  eq(JSON.stringify(out.investigators), JSON.stringify({ ran: 4, stop: 'cap' }), 'investigators reports the cap stop');
  eq(JSON.stringify(out.agents), JSON.stringify({ investigate: 4, decide: 1, review: 1 }), 'agents counts the agents started per phase');
  eq(out.status, 'decided (the final reviewer made no edit and raised no flag)', 'status');
  ok(out.halted === false && out.haltReason === '', 'not halted');
  eq(out.chosen, 'in-process LRU', 'chosen is rank 1\'s title');
  eq(out.decisionFile, `${L}/decision.md`, 'decisionFile');
  eq(out.reviewFile, `${L}/review.md`, 'reviewFile');
  eq(JSON.stringify(out.investigationFiles), JSON.stringify([I(1), I(2), I(3), I(4)]), 'investigationFiles lists every investigation file in chain order');
  ok(Array.isArray(out.failed) && out.failed.length === 0, 'failed is an empty array, since no agent is auxiliary');
  eq(calls.map((c) => c.opts.phase).join(','), 'Investigate,Investigate,Investigate,Investigate,Decide,Review', 'each agent runs under its phase');
  ok(logs.includes('  → the chain stops at the cap: maxInvestigators (4) ran'), 'the log names the cap stop');
  ok(!['agreed', 'reviewRounds', 'research', 'lensFiles', 'shortlist', 'selection', 'needsUserFile', 'caveats', 'reviewTrail'].some((k) => k in out),
    'the retired return fields are gone');
}

section('a challenger that contributes nothing stops the chain dry, and the decider still runs');
{
  const { out, labels, logs } = await run({ ...CLEAN, 'investigate i': DRY });
  eq(labels.join(','), 'investigate i1,investigate i2,decide,review', 'i2 returns contributed false, so i3 never runs');
  eq(JSON.stringify(out.investigators), JSON.stringify({ ran: 2, stop: 'dry' }), 'investigators reports the dry stop and two investigators');
  eq(JSON.stringify(out.investigationFiles), JSON.stringify([I(1), I(2)]), 'the dry challenger\'s file is still an investigation file');
  ok(logs.includes('  ✓ i2 contributed nothing → the chain stops dry after 2 investigator(s)'), 'the log names the stop and the count');
  const later = await run({ ...CLEAN, 'investigate i': (label) => (label === 'investigate i3' ? DRY : CHALLENGE) });
  eq(later.labels.join(','), 'investigate i1,investigate i2,investigate i3,decide,review', 'a later dry challenger stops the chain at itself');
  eq(later.out.investigators.ran, 3, 'and ran counts it');
  // Only an explicit false stops the chain, so a missing flag spends an investigator rather than ending research early.
  const missing = await run({ ...CLEAN, 'investigate i': { wrote_file: true } });
  eq(missing.out.investigators.stop, 'cap', 'a challenger that omits contributed does not stop the chain');
}

section('maxInvestigators bounds the chain, from 1 to 10, and the launch line names the most agents the run starts');
{
  const one = await run(CLEAN, { ...baseArgs, maxInvestigators: 1 });
  eq(one.labels.join(','), 'investigate i1,decide,review', 'maxInvestigators 1 runs the opening investigator, the decider and the reviewer');
  eq(JSON.stringify(one.out.investigators), JSON.stringify({ ran: 1, stop: 'cap' }), 'and stops at the cap');
  ok(one.logs.includes('decide: roles investigate=opus/high, decide=opus/high, review=opus/high, at most 3 agents (1 investigator(s), the decider and the reviewer)'),
    `the launch line names the role settings and the agent bound: ${one.logs[0]}`);
  // The longest prefix of `investigate i10` is `investigate i1`, so that key's responder tells the labels apart.
  const tenth = (label) => (label === 'investigate i1' ? OPEN : label === 'investigate i10' ? DRY : CHALLENGE);
  const ten = await run({ ...CLEAN, 'investigate i1': tenth }, { ...baseArgs, maxInvestigators: 10 });
  eq(ten.out.agents.investigate, 10, 'maxInvestigators 10 runs ten investigators');
  eq(JSON.stringify(ten.out.investigators), JSON.stringify({ ran: 10, stop: 'dry' }), 'the tenth challenger gets its own return, and a dry last challenger stops dry, not at the cap');
  for (const bad of [0, 11, 'four', '']) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, maxInvestigators: bad }, respond: CLEAN });
    ok(msg.startsWith('Invalid numeric arg: args.maxInvestigators must be a number between 1 and 10'), `maxInvestigators ${JSON.stringify(bad)} throws: ${msg.slice(0, 80)}`);
  }
}

section('the reviewer\'s counts pick the terminal, flags over corrections, and the ranking comes from the reviewer');
{
  const corrected = await run({ ...CLEAN, review: { ...REVIEW, edits: 2 } });
  eq(corrected.out.status, 'decided with corrections (the final reviewer made 2 edits)', 'edits alone end decided with corrections');
  eq(corrected.out.edits, 2, 'edits returns the count');
  const single = await run({ ...CLEAN, review: { ...REVIEW, edits: 1 } });
  eq(single.out.status, 'decided with corrections (the final reviewer made 1 edit)', 'one edit reads singular');
  const flagged = await run({ ...CLEAN, review: { ...REVIEW, edits: 3, flags: 2 } });
  eq(flagged.out.status, 'decided with flags (the final reviewer flags 2 judgment calls for the user)', 'a flag takes precedence over corrections');
  ok(flagged.out.edits === 3 && flagged.out.flags === 2, 'both counts reach the return');
  const oneFlag = await run({ ...CLEAN, review: { ...REVIEW, flags: 1 } });
  eq(oneFlag.out.status, 'decided with flags (the final reviewer flags 1 judgment call for the user)', 'one flag reads singular');
  const fixed = [{ rank: 1, title: 'redis', combines_with: [], excludes: [] }, { rank: 2, title: 'in-process LRU', combines_with: [], excludes: [] }];
  const reordered = await run({ ...CLEAN, review: { ...REVIEW, edits: 1, ranking: fixed } });
  eq(reordered.out.chosen, 'redis', 'chosen follows the reviewer\'s corrected ranking');
  eq(JSON.stringify(reordered.out.ranking), JSON.stringify(fixed), 'ranking is the reviewer\'s index');
  const unattested = await run({ ...CLEAN, review: { ...REVIEW, wrote_file: false, ranking: fixed } });
  eq(unattested.out.chosen, 'in-process LRU', 'an unattested review leaves the decider\'s ranking');
  eq(unattested.out.reviewFile, '', 'and names no review file');
  // A reorder moves rank 1 and rank 2, so the decider's grade no longer describes the pair the return names.
  const regraded = await run({ ...CLEAN, review: { ...REVIEW, edits: 2, ranking: fixed, flip: 'fragile' } });
  eq(regraded.out.flip, 'fragile', 'flip is the reviewer\'s grade after its edits');
  ok(flat(regraded.out.nextStep).includes('The flip check is graded FRAGILE.'), 'and the reviewer\'s fragile grade adds the flip note');
  const keptGrade = await run({ ...CLEAN, decide: { ...DECIDE, flip: 'fragile' }, review: { ...REVIEW, wrote_file: false, flip: 'robust' } });
  eq(keptGrade.out.flip, 'fragile', 'an unattested review leaves the decider\'s grade');
}

section('the ranking index is sorted by rank and drops an entry it cannot relay');
{
  const messy = [{ rank: 2, title: 'redis' }, { rank: 1, title: 'in-process LRU' }, null, { rank: 3, title: '  ' }, { title: 'unranked' }, 'loose'];
  const { out } = await run({ ...CLEAN, review: { ...REVIEW, ranking: messy } });
  eq(out.ranking.map((r) => r.title).join(','), 'in-process LRU,redis,unranked', 'sorted by rank, an unranked entry last, a blank or non-object entry dropped');
  const empty = await run({ ...CLEAN, review: { ...REVIEW, ranking: [] } });
  eq(empty.out.chosen, '', 'an empty ranking chooses nothing');
  ok(flat(empty.out.nextStep).startsWith(`No option passes every non-negotiable: present \`## Ruled out\` in ${L}/decision.md, with the edits under \`## Edits\``),
    `and the hand-back says no option passes: ${String(empty.out.nextStep).slice(0, 90)}`);
  ok(!/Rank 1|To build a pick|Present the ranking/.test(empty.out.nextStep), 'and names no rank 1 to present or build');
}

section('a relayed request on the opening investigator throws before any other agent');
{
  const respond = { ...CLEAN, 'investigate i1': { ...OPEN, relayed_request: true } };
  const msg = await throwsWith(ENGINE, { args: baseArgs, respond });
  ok(msg.startsWith('A user request was relayed into the context of the opening investigator'), `the throw names the opening investigator: ${msg.slice(0, 80)}`);
  ok(msg.includes('Launch from a notification turn'), 'and the launch rule');
  const { labels } = await runTrace(ENGINE, { args: baseArgs, respond });
  eq(labels.join(','), 'investigate i1', 'no agent after the opening investigator ran');
}

section('an unattested write halts before the next agent, and the return names only attested files');
{
  const cases = [
    ['the opening investigator', { 'investigate i1': { ...OPEN, wrote_file: false } }, 'investigate i1', I(1), []],
    ['challenger i3', { 'investigate i': (label) => (label === 'investigate i3' ? { ...CHALLENGE, wrote_file: false } : CHALLENGE) }, 'investigate i3', I(3), [I(1), I(2)]],
    ['the decider', { decide: { ...DECIDE, wrote_file: false } }, 'decide', `${L}/decision.md`, [I(1), I(2), I(3), I(4)]],
    ['the final reviewer', { review: { ...REVIEW, wrote_file: false } }, 'review', `${L}/review.md`, [I(1), I(2), I(3), I(4)]],
  ];
  for (const [who, override, last, file, files] of cases) {
    const { out, labels } = await run({ ...CLEAN, ...override });
    eq(labels[labels.length - 1], last, `${who}: no agent runs after it`);
    eq(out.status, 'BLOCKED (an agent did not confirm writing its file)', `${who}: the halt status`);
    ok(out.halted === true && out.haltReason.includes(file), `${who}: haltReason names ${file}: ${out.haltReason}`);
    eq(JSON.stringify(out.investigationFiles), JSON.stringify(files), `${who}: investigationFiles holds only the attested files`);
    ok(flat(out.nextStep).includes(`relaunch with the same args and runId, a newly reserved launchDir in place of ${L} and no resumeFromRunId`),
      `${who}: nextStep says to relaunch in a new launch folder without a resume`);
    ok(flat(out.nextStep).includes(`To relaunch, ${RELAUNCH}.`), `${who}: and names the reserve command`);
  }
  const { out: chainHalt } = await run({ ...CLEAN, 'investigate i': { ...CHALLENGE, wrote_file: false } });
  ok(chainHalt.investigators.stop === '' && chainHalt.decisionFile === '' && chainHalt.reviewFile === '' && chainHalt.chosen === '',
    'a halt inside the chain has no stop, no decision, no review and no choice');
  const { out: decHalt } = await run({ ...CLEAN, decide: { ...DECIDE, wrote_file: false } });
  ok(decHalt.investigators.stop === 'cap' && decHalt.decisionFile === '' && decHalt.ranking.length === 0, 'a decider halt keeps the chain\'s stop and names no decision');
  const { out: revHalt } = await run({ ...CLEAN, review: { ...REVIEW, wrote_file: false } });
  ok(revHalt.decisionFile === `${L}/decision.md` && revHalt.reviewFile === '', 'a reviewer halt names the attested decision and no review');
}

section('an agent that returns nothing throws, with the resume instruction');
{
  const cases = [
    ['the opening investigator', { 'investigate i1': null }, 'Opening investigator returned nothing (investigate i1'],
    ['a challenger', { 'investigate i': null }, 'Challenger returned nothing (investigate i2'],
    ['the decider', { decide: null }, 'Decider returned nothing'],
    ['the reviewer', { review: null }, 'Reviewer returned nothing'],
  ];
  for (const [who, override, lead] of cases) {
    const msg = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, ...override } });
    ok(msg.startsWith(lead), `${who} throws: ${msg.slice(0, 70)}`);
    ok(msg.includes(`Replay with the same args and runId, launchDir ${L} included, plus the Workflow tool's resumeFromRunId`),
      `${who}: the message says to replay with the same launchDir and resumeFromRunId`);
    ok(msg.includes(`To replay, ${LAUNCH_PATH}. A replay keeps its launchDir, so that pre-launch command is node --version, which reserves no launch folder.`),
      `${who}: the message names the notification-turn launch path and a pre-launch command that reserves no folder`);
  }
}

section('each retired arg and each retired role key throws at launch, naming it');
{
  const RETIRED = { lenses: ['efficiency', 'simplest'], checkTool: 'E:/r/tools/x.mjs', selection: 'ranked', shortlist: 3, maxRounds: 3, maxResearchRounds: 2, maxResearchers: 4 };
  for (const [name, value] of Object.entries(RETIRED)) {
    const { calls } = await runTrace(ENGINE, { args: { ...baseArgs, [name]: value }, respond: CLEAN });
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, [name]: value }, respond: CLEAN });
    ok(msg.startsWith(`Retired arg: args.${name} is retired, since `), `${name} throws naming the arg: ${msg.slice(0, 80)}`);
    eq(calls.length, 0, `${name}: no agent runs`);
  }
  for (const key of ['research', 'check', 'analyst']) {
    for (const arg of ['models', 'efforts']) {
      const msg = await throwsWith(ENGINE, { args: { ...baseArgs, [arg]: { [key]: arg === 'models' ? 'opus' : 'high' } }, respond: CLEAN });
      ok(msg.includes(`args.${arg} names "${key}"`) && msg.includes('investigate | decide | review'), `${arg}.${key} throws as an unknown role key: ${msg.slice(0, 90)}`);
    }
    const types = await throwsWith(ENGINE, { args: { ...baseArgs, agentTypes: { [key]: 'my-agent' } }, respond: CLEAN });
    ok(types.startsWith('Invalid agentTypes arg') && types.includes(`"${key}"`), `agentTypes.${key} throws naming the key: ${types.slice(0, 90)}`);
  }
  const missing = await throwsWith(ENGINE, { args: { runId: 't', root: 'E:/r', launchDir: L }, respond: CLEAN });
  ok(missing.startsWith('args.planPath is required'), `the rubric is a planPath only: ${missing.slice(0, 60)}`);
  const noRun = await throwsWith(ENGINE, { args: {}, respond: CLEAN });
  ok(noRun.includes('{ runId, root, planPath, launchDir }'), `the missing-runId message names the required args: ${noRun.slice(0, 70)}`);
}

section('each prompt names the files its agent reads, in chain order');
{
  const { prompt, byLabel } = await run(CLEAN);
  const i4 = flat(prompt('investigate i4'));
  ok(ascending(positions(i4, [I(1), I(2), I(3)])), 'challenger i4 names i1, i2 and i3 in order');
  ok(i4.includes(`WRITE ${I(4)}.`), 'and writes its own file');
  ok(i4.includes(`reject one assumption under \`## Leader assumptions\` in ${I(3)}`), 'it rejects an assumption of the latest file');
  ok(i4.includes(`three leading options (every option when fewer stand) under \`## Standing\` in ${I(3)}`), 'and targets the latest standing, with fewer than three options too');
  const i2 = flat(prompt('investigate i2'));
  ok(i2.includes(I(1)) && !i2.includes(I(3)), 'challenger i2 names i1 and no later file');
  for (const role of ['decide', 'review']) {
    const text = flat(byLabel(role)[0]?.prompt);
    ok(ascending(positions(text, [I(1), I(2), I(3), I(4)])), `the ${role} prompt names every investigation file in order`);
  }
  const dry = await run({ ...CLEAN, 'investigate i': DRY });
  const dec = flat(dry.prompt('decide'));
  ok(dec.includes(I(2)) && !dec.includes(I(3)), 'after a dry stop the decider names only the files the chain wrote');
  const review = flat(prompt('review'));
  ok(review.includes(`THE DECISION FILE (read it verbatim): ${L}/decision.md`), 'the reviewer reads the decision file');
  ok(review.includes(`WRITE ${L}/review.md.`), 'and writes the review file');
}

section('the shared rubric text holds the scoring rules and the three rules the chain adds, in every prompt');
{
  const { calls } = await run(CLEAN, { ...baseArgs, testbed: 'sqlite3 file:x.db?mode=ro' });
  const RULES = [
    'NON-NEGOTIABLES (musts) are pass/fail',
    'A want scores met only on a cited source or a measurement, and own judgment scores at most partly met.',
    'Score each weighted criterion on what the option achieves against it, never on its change from the current state.',
    'When not acting is possible, a DO-NOTHING option is scored on the same rubric.',
    'Prefer the SIMPLEST option that meets all requirements.',
    'Cite each factual claim to its original source',
    `Save any script it ran under ${L}/scripts/ (create it if needed) with a file name that no file there holds yet, and never change a script already there, so a later agent can rerun it and get the result its citer got.`,
    'DEFECT RULE: a defect is a concrete failure of an option as stated: the input or path that triggers it, the step that fails and the wrong result, with its source or a trace through the option\'s text.',
    'Record each defect you find in an option you read, verify or build on at the moment you find it, where your procedure says. An investigator also fixes the defect when a fix is within its reach.',
    'For an option that is a design of software or a process, the defect test is each of five hostile inputs: a failure, a concurrent edit, a human-set value, state saved before the change',
    // A fix inside a DEFECT contribution lives in the file that records the defect, so that file's fix must count.
    'A recorded defect holds until a file fixes it, the file that records it included, so never treat the defective part as working or build on it.',
    'A breach reachable only through operator action is a con, never a must failure.',
  ];
  for (const c of calls) {
    const text = flat(c.prompt);
    const missing = RULES.filter((r) => !text.includes(r));
    eq(missing.join(' | '), '', `${c.label}: the prompt states every rubric rule`);
    // A defect counts without a fix now, so the old clause would tell a challenger to stop on a known defect.
    ok(!text.includes('a contribution when it also fixes it'), `${c.label}: the prompt holds no fix-only defect clause`);
  }
  ok(flat(calls.find((c) => c.label === 'review').prompt).includes(`Rerun each script under ${L}/scripts/ and each testbed command such a cell rests on.`),
    'with a testbed the reviewer reruns the testbed commands too');
  const plain = flat((await run(CLEAN)).prompt('review'));
  ok(plain.includes(`Rerun each script under ${L}/scripts/ such a cell rests on.`), 'without one it reruns the saved scripts');
}

section('the challenger carries the contribution rule and the early-stop proof');
{
  const i2Raw = String((await run(CLEAN)).prompt('investigate i2'));
  const i2 = flat(i2Raw);
  for (const piece of [
    'CONTRIBUTION: one of five kinds:',
    '- a NEW OPTION, which includes a COMBINATION of options that genuinely compose (no Frankenstein), naming each part by its option id',
    '- a FEATURE ADDED to an option',
    '- a FEATURE REMOVED from an option for a stated reason',
    '- a CORRECTION of an error in an earlier file',
    '- a DEFECT in an option under the DEFECT RULE, with its fix when you have one',
    'A NEW OPTION, FEATURE ADDED, FEATURE REMOVED or CORRECTION is a change, inside the scope the rubric decides, to what would be built or done. It must make the option better on at least one weighted criterion or on a plain measure the rubric does not name',
    'A DEFECT counts with or without a fix, since it records a failure that no later agent may build on.',
    'No size threshold applies, since several small contributions can lift an option over another.',
    'unless it names the shortcoming that holds a lower option down and gives evidence that the contribution resolves it. A contribution that other options can carry unchanged names each of them under `also fits`, by option id, and counts in each option it names. A DEFECT targets the option it is found in, at any standing.',
    'A DEFECT in a contribution names that contribution\'s id and holds against every option that carries it.',
    'Record each defect you come across while you replace, improve or verify as a DEFECT contribution. Never build a contribution on a part a recorded defect names unless that contribution fixes it.',
    'Never repeat a contribution an earlier file holds, and never edit an earlier file.',
    '`## Contributions`: each under an id C2.1, C2.2 and so on',
    'or, for a new option, the next free option id, the option ids under `also fits`, if any, what changes',
    '`## Standing`: every option of the run in order after your contributions, with each recorded defect no file fixes yet weighed against its option',
    'Set contributed=false only when `## Contributions` reads `None.` and `## Searched` holds at least one replacement attempt against the leader\'s assumptions, and an improvement attempt and a defect check for each of the three leading options (every option when fewer stand) under `## Standing`',
    'A defect check on a design of software or a process names each of the five hostile inputs with its result. A defect check on the do-nothing option names no hostile inputs, and reports each defect in today\'s design that you come across as a DEFECT contribution. Each attempt and check gives the reason it adds nothing under the contribution rule.',
  ]) ok(i2.includes(piece), `the challenger prompt holds: ${piece.slice(0, 70)}`);
  ok(/^3\. /m.test(i2Raw) && !/^4\. /m.test(i2Raw), 'the challenger procedure keeps three numbered steps, the defect record inside them');
  const i1 = flat((await run(CLEAN)).prompt('investigate i1'));
  ok(['## Options', '## Leader assumptions', '## Standing', '## Searched'].every((h) => i1.includes(`\`${h}\``)), 'the opening investigator writes the four sections');
  ok(!i1.includes('CONTRIBUTION:'), 'and carries no contribution rule, since it has nothing to beat');
  ok(i1.includes('Each defect you find in one of your options and do not fix is a con of that option that states the failure.'), 'and writes each defect it does not fix as a con');
  ok(i1.includes('A defect you fix goes into that option\'s description, with the failure the fix removes.'), 'and writes each defect it fixes into the option');
}

section('a challenger whose only contribution is a DEFECT with no fix contributes, so the chain runs on');
{
  // The engine sees only the flag, so this pins that contributed true continues the chain and that the schema says a fix-less DEFECT is a contribution.
  const defectOnly = { wrote_file: true, contributed: true };
  const { labels, calls } = await run({ ...CLEAN, 'investigate i': (label) => (label === 'investigate i2' ? defectOnly : DRY) });
  eq(labels.join(','), 'investigate i1,investigate i2,investigate i3,decide,review', 'the next challenger runs after a defect-only challenger');
  const schema = calls.find((c) => c.label === 'investigate i2').opts.schema;
  ok(String(schema?.properties?.contributed?.description ?? '').includes('A DEFECT contribution with no fix is a contribution.'), 'the contributed description counts a fix-less DEFECT');
}

section('the decider ranks under the tie rule and writes every section, and the reviewer proves each edit');
{
  const { prompt } = await run(CLEAN);
  const dec = flat(prompt('decide'));
  const order = ['## Ranking', '## Options', '## Matrix', '## Flip check', '## Ruled out', '## Changes to investigation facts', '## Checks for the user'];
  ok(ascending(positions(dec, order.map((h) => `- \`${h}\``))), 'the decision file\'s sections are listed in order');
  // Groups formed down one sorted list give every chain of near totals an order, which a pairwise margin cannot.
  const simplest = 'The simplest option has the fewest parts to run and maintain once it is in place (components, steps and rules), and the smaller build breaks a tie that remains.';
  const tieRule = `sort the ranked options by total, best first. The options whose totals lie at most M below the highest total, where M is 5% of the sum of every criterion's weight, form a tie group, ranked simplest first. ${simplest} Form each next group the same way from the options left.`;
  ok(dec.includes(`under the TIE RULE: ${tieRule} The file says where a tie group puts a simpler option above a higher total.`), 'the tie rule, scaled to the weights and grouped down one list');
  ok(dec.includes(`Prefer the SIMPLEST option that meets all requirements. ${simplest} If a more complex option ranks above it`), 'the rubric rules define simplest as the tie rule does');
  ok(dec.includes('Every option an investigation file gives an option id, under `## Options`, `## Contributions` or `## Searched`, appears under `## Ranking` or `## Ruled out`. A candidate named without an option id is not an option.'), 'every option with an id is ranked or ruled out');
  ok(dec.includes('A contribution counts in the option it targets and in each option under its `also fits`.'), 'a contribution counts in each option it fits');
  const brokenContribution = 'A defect in a contribution is a con of every option that carries it and bears on the cells of each. A defect that breaks a non-negotiable in a contribution an option carries rules out the option as stated.';
  ok(dec.includes(`${brokenContribution} The option without that contribution goes under \`## Checks for the user\`, with the check that would rank it.`),
    'the decider weighs a defective contribution in every option that carries it, and sends an option without its must-breaking contribution to the checks for the user');
  ok(dec.includes('each option step 1 sends here and each untested combination of step 1'), 'and the checks section lists those options');
  ok(dec.includes('Each entry under the rubric\'s `## Given options` that no investigation file gives an option id goes under `## Checks for the user` as a given option no agent weighed, with the check that would weigh it.'),
    'a given option no file names is a check for the user');
  ok(dec.includes('the one observation that would reverse that.'), 'a ruled-out option names what would reverse it');
  const rev = flat(prompt('review'));
  ok(rev.includes('Open the source behind every cell of the three top-ranked options, behind every non-negotiable judgment of every ranked option and behind the evidence of every `## Ruled out` entry.'), 'the reviewer opens the sources, the ruled-out evidence included');
  ok(rev.includes('or a ruled-out option whose failing non-negotiable a source disproves (score it in `## Matrix` and rank it).'), 'and ranks a ruled-out option a source clears');
  ok(rev.includes('When an edit changes rank 1 or rank 2, or a cell, weight or total either one rests on, redo `## Flip check`'), 'and redoes the flip check after an edit that moves the top pair');
  const flipRule = 'the smallest single change to one cell or one weight that swaps rank 1 and rank 2. Grade it DOMINANT when rank 1 is at least as good as rank 2 on every criterion';
  ok(dec.includes(`FLIP CHECK: ${flipRule}`) && rev.includes(`The FLIP CHECK is ${flipRule}`), 'the decider and the reviewer state the same flip rule');
  ok(rev.includes(`Check that the order follows the TIE RULE: ${tieRule}`), 'and checks the same tie rule');
  ok(rev.includes('An edit that moves an option to another rank or out of the ranking updates every `combines with` and `excludes` rank that names a moved option.'),
    'and renumbers the cross references an edit moves');
  ok(rev.includes('Change no judgment you cannot prove wrong.'), 'and changes no unproven judgment');
  ok(ascending(positions(rev, ['- `## Defects`', '- `## Edits`', '- `## Flags`'])), 'review.md holds Defects, then Edits, then Flags');
}

section('the decider builds no option and no combination, and the reviewer hunts defects before the source checks');
{
  const { prompt } = await run(CLEAN);
  const dec = flat(prompt('decide'));
  ok(!/MAY build|every combination you build|under the next free option id/.test(dec), 'the decider holds no instruction to build a combination or a new option');
  ok(dec.includes('You rank only those options: the investigation chain builds every option and every combination.'), 'and ranks only the options the files hold');
  ok(dec.includes('A combination the files do not hold goes under `## Checks for the user` as an untested combination, with the option ids it would join, the check that would test it and the result that would change the ranking, and is not ranked.'),
    'a combination the files do not hold is an untested check for the user');
  ok(dec.includes('A `combines with` mark says only that two ranked options compose, and adds no check.'),
    'a combines-with mark is no untested combination');
  ok(dec.includes('Each defect you find, or that an investigation file records and no file fixes, is a con of that option and bears on its cells.'), 'and each open defect is a con');
  const rev = flat(prompt('review'));
  const hunt = '1. DEFECT HUNT, before the source checks: test what would be built under each of the three top-ranked options against the DEFECT RULE. For a combination, check that its parts fit together.';
  ok(ascending(positions(rev, [hunt, '2. Open the source behind every cell'])), 'the defect hunt comes before the source checks');
  ok(rev.includes(`Check each contribution of ${I(4)}, since no later investigator read it.`), 'and names the last investigation file\'s contributions');
  ok(rev.includes('Never write the fix into the option, since no agent would check a fix added after the chain.'), 'and forbids writing a fix into an option');
  ok(rev.includes('A defect in a contribution is a con of every option that carries it and bears on the cells of each. A defect that breaks a non-negotiable in a contribution an option carries rules out the option as stated. Flag the option without that contribution. A defect you suspect and cannot show is a flag.'),
    'and weighs a defective contribution in every option that carries it, ruling out each one it breaks a must of and flagging the option without it');
  ok(rev.includes('Check that every option an investigation file gives an option id is ranked or ruled out, that each entry under the rubric\'s `## Given options` is such an option or a check for the user'),
    'and checks every option with an id is ranked or ruled out, and every given option is placed');
  ok(rev.includes('A defect you suspect and cannot show is a flag.'), 'and flags a defect it cannot show');
  ok(rev.includes('`## Flags`: each score or order you would judge differently with no proven error, each option without a ruling-out contribution that step 1 flags, and each defect you suspect and cannot show, each with your reason, or `None.`'),
    'and the `## Flags` section admits that defect and the option without a ruling-out contribution');
  ok(rev.includes('as steps 3 to 5 say.') && rev.includes('3. Recompute every total.') && rev.includes('5. When an edit changes rank 1 or rank 2'), 'and points at the renumbered steps');
  const one = flat((await run(CLEAN, { ...baseArgs, maxInvestigators: 1 })).prompt('review'));
  ok(one.includes(`Check each option of ${I(1)}, since no later investigator read it.`), 'with only i1.md the reviewer checks each of its options');
}

section('the reviewer\'s defects count reaches the return, the log line and the hand-back');
{
  const found = await run({ ...CLEAN, review: { ...REVIEW, defects: 2, edits: 3 } });
  eq(found.out.defects, 2, 'defects returns the count');
  ok(found.logs.some((l) => l.includes('the final reviewer showed 2 defect(s), made 3 edit(s)')), 'the log line names the defects');
  ok(flat(found.out.nextStep).includes(`Carry each defect under \`## Defects\` in ${L}/review.md, with its fix when it names one, into the plan file of any pick it names.`),
    `nextStep says to carry each defect into the plan file: ${flat(found.out.nextStep).slice(-140)}`);
  eq(found.out.status, 'decided with corrections (the final reviewer made 3 edits)', 'a defect\'s edits count under edits, so the terminal is unchanged');
  const none = await run(CLEAN);
  eq(none.out.defects, 0, 'no defect returns 0');
  ok(!String(none.out.nextStep ?? '').includes('## Defects'), 'and the hand-back carries no defects sentence');
  const odd = await run({ ...CLEAN, review: { ...REVIEW, defects: -1 } });
  eq(odd.out.defects, 0, 'a negative count reads as none');
  const { calls } = await run(CLEAN);
  ok(calls.find((c) => c.label === 'review').opts.schema.required.includes('defects'), 'the review schema requires defects');
}

section('target.repo adds the codebase to the shared rubric and to the opening and decider search steps');
{
  const codebase = 'CODEBASE (read-only context — pattern-fit / feasibility only; do NOT modify): E:/repo';
  const withRepo = await run(CLEAN, { ...baseArgs, target: { repo: 'E:/repo' } });
  const without = await run(CLEAN);
  for (const label of ['investigate i1', 'investigate i2', 'decide', 'review']) {
    ok(flat(withRepo.prompt(label)).includes(codebase), `${label} names the codebase when target.repo is passed`);
    ok(!flat(without.prompt(label)).includes('CODEBASE'), `${label} names no codebase without it`);
  }
  ok(flat(withRepo.prompt('investigate i1')).includes('1. Search the web and the codebase above with the tools you have'), 'the opening investigator searches the codebase');
  ok(flat(without.prompt('investigate i1')).includes('1. Search the web with the tools you have'), 'and only the web without it');
  ok(flat(withRepo.prompt('decide')).includes('You MAY search the web and the codebase to fill a gap the files leave.'), 'the decider may search the codebase');
  ok(flat(without.prompt('decide')).includes('You MAY search the web to fill a gap the files leave.'), 'and only the web without it');
}

section('the opening investigator makes each given option of the rubric an option of i1.md');
// The engine does not parse the rubric, so a given option reaches the chain only through this sentence.
{
  const i1 = flat((await run(CLEAN)).prompt('investigate i1'));
  ok(i1.includes(`Read the sources, search, and measure where you can. When the rubric holds \`## Given options\`, each entry there is an option of ${I(1)} under its own id, ahead of the options you find, and is judged like the rest.`),
    'each given option is an option of i1.md, ahead of the ones the investigator finds');
  ok(i1.includes('including a simple baseline.'), 'and the search keeps the simple baseline');
}

section('the hand-back presents the ranking, a fragile flip check and the checks for the user');
{
  const { out } = await run(CLEAN);
  const next = flat(out.nextStep);
  ok(next.startsWith(`Present the ranking under \`## Ranking\` in ${L}/decision.md, with the edits under \`## Edits\` and every flag under \`## Flags\` in ${L}/review.md.`), `nextStep leads with the ranking: ${next.slice(0, 100)}`);
  ok(next.includes('Rank 1 is the top answer, and the user may combine the entries marked as combinable.'), 'rank 1 and combining');
  ok(next.includes('author it as a plan file, refine it with refine-cycle, then build it with develop-cycle'), 'and how a pick is built');
  ok(!next.includes('FRAGILE') && !next.includes('## Checks for the user'), 'a robust run with no checks carries neither note');
  eq(out.flip, 'robust', 'flip returns the grade');
  const fragile = await run({ ...CLEAN, decide: { ...DECIDE, user_checks: 2 }, review: { ...REVIEW, flip: 'fragile' } });
  ok(flat(fragile.out.nextStep).includes(`The flip check is graded FRAGILE. Present \`## Flip check\` in ${L}/decision.md`), 'a fragile grade adds the flip note');
  ok(flat(fragile.out.nextStep).includes('Present the 2 check(s) under `## Checks for the user`'), 'and checks for the user add their note');
  ok(flat(fragile.out.nextStep).includes('each names the check to run and what its result would change.'), 'and the note covers every kind of check');
  eq(fragile.out.userChecks, 2, 'userChecks returns the count');
  const odd = await run({ ...CLEAN, decide: { ...DECIDE, user_checks: -1 }, review: { ...REVIEW, flip: 'shaky' } });
  ok(odd.out.flip === '' && odd.out.userChecks === 0, 'a grade off the enum and a negative count read as none');
}

section('models, efforts and agentTypes take investigate, decide and review');
await pinRoleMaps({
  engine: ENGINE, name: 'decide', defaults: { investigate: 'opus', decide: 'opus', review: 'opus' },
  launchTail: ', at most 6 agents (4 investigator(s), the decider and the reviewer)',
  runs: [{ args: baseArgs, respond: CLEAN, labels: { investigate: 'investigate', decide: 'decide', review: 'review' } }],
});

section("every prompt that writes a file says to Read a file an interrupted attempt of its launch left first, and a rejected write is not a write");
{
  const { prompt } = await run(CLEAN);
  const sites = [
    ['the opening investigation file', prompt('investigate i1'), 1, 1],
    ['a challenger\'s investigation file', prompt('investigate i2'), 1, 1],
    ['the decision file', prompt('decide'), 1, 1],
    ['the review file', prompt('review'), 1, 1],
  ];
  pinWriteNotes(sites, REPLACE_NOTE);
  pinFileWriteNote(sites);
}

section('a launch writes every file in its own launch folder, so a second launch replaces no file of the first');
{
  const L2 = `${S}/launch-2`;
  const { out, calls } = await run(CLEAN, { ...baseArgs, launchDir: L2 });
  ok(flat(calls[0].prompt).includes(`WRITE ${L2}/investigations/i1.md (create ${L2}/investigations/ if needed).`),
    'the opening investigator writes the first investigation file inside launch-2');
  eq(out.decisionFile, `${L2}/decision.md`, 'decisionFile lies inside launch-2');
  eq(out.reviewFile, `${L2}/review.md`, 'reviewFile lies inside launch-2');
  ok(out.investigationFiles.every((f) => f.startsWith(`${L2}/investigations/`)), 'every investigation file lies inside launch-2');
  eq(out.stateDir, S, 'stateDir stays the folder that holds the launch folders');
  // Each prompt names the files its agent writes, so a path outside launch-2 there would write over an earlier launch's file.
  for (const c of calls) {
    const named = flat(c.prompt).match(/E:\/r\/runs\/t\/[^\s`'"),]*/g) ?? [];
    const outside = named.filter((p) => !p.startsWith(`${L2}/`) && p !== `${L2}`);
    eq(outside.join(', '), '', `${c.label}: every run-state path the prompt names lies inside launch-2`);
  }
}

section('a launch without a valid launchDir throws, naming the arg, before any agent runs');
{
  const { launchDir: _, ...NO_LAUNCH } = baseArgs;
  for (const args of [NO_LAUNCH, { ...baseArgs, launchDir: ' ' }]) {
    const msg = await throwsWith(ENGINE, { args, respond: CLEAN });
    ok(msg.startsWith('Missing args.launchDir: pass the launchDir that the reserve command of the workflow guide\'s pre-launch step prints'),
      `launchDir ${JSON.stringify(args.launchDir)} throws naming the arg: ${msg.slice(0, 50)}`);
  }
  for (const launchDir of ['E:/r/runs/other/launch-1', `${S}/launch-0`, `${L}/x`]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, launchDir }, respond: CLEAN });
    ok(msg.startsWith(`Invalid args.launchDir: it must be a folder named launch-<n> directly inside the stateDir ${S}`), `${launchDir} throws: ${msg.slice(0, 60)}`);
    const { calls } = await runTrace(ENGINE, { args: { ...baseArgs, launchDir }, respond: CLEAN });
    eq(calls.length, 0, `${launchDir}: no agent runs`);
  }
}

section('a relaunch hand-back reserves a new launch folder, and a relayed request relaunches in one too');
{
  const empty = await run({ ...CLEAN, review: { ...REVIEW, ranking: [] } });
  ok(flat(empty.out.nextStep).includes(`Refine the requirements with the user, then relaunch with the same runId and a newly reserved launchDir in place of ${L}. To relaunch, ${RELAUNCH}.`),
    `an empty ranking's relaunch reserves a new launch folder: ${flat(empty.out.nextStep).slice(-160)}`);
  const relayed = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, 'investigate i1': { ...OPEN, relayed_request: true } } });
  ok(relayed.includes(`Relaunch with the same args and runId and a newly reserved launchDir in place of ${L}, from a notification turn`) && relayed.includes(`${RELAUNCH}.`),
    `the relayed-request throw relaunches in a new launch folder: ${relayed.slice(-160)}`);
  const withRepo = await throwsWith(ENGINE, { args: { ...baseArgs, target: { repo: 'E:/repo' } }, respond: { ...CLEAN, decide: null } });
  ok(withRepo.includes("so that pre-launch command is git -C 'E:/repo' status --short, which reserves no launch folder"),
    'with a target repo the replay\'s pre-launch command is its git status');
}
