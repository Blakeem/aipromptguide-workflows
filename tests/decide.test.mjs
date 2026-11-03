// decide/decide-cycle.mjs: the bounded investigator chain, the decider, the final reviewer, and what the run
// hands back. No stage loops back, so what the engine controls is the chain's order and its two stops, the
// halt on each unattested write, the throw on each dead agent, the terminal the reviewer's counts pick, and
// the files each prompt names.
import { runEngine, runTrace, throwsWith, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';

const ENGINE = 'workflows/decide/decide-cycle.mjs';
const S = 'E:/r/runs/t';
const I = (k) => `${S}/investigations/i${k}.md`;

const baseArgs = { runId: 't', root: 'E:/r', planPath: 'E:/r/plans/t/requirements.md' };
const run = (respond, args = baseArgs) => runEngine(ENGINE, { args, respond });

const OPEN      = { wrote_file: true, relayed_request: false };
const CHALLENGE = { wrote_file: true, contributed: true };
const DRY       = { ...CHALLENGE, contributed: false };
const RANKING   = [{ rank: 1, title: 'in-process LRU', combines_with: [], excludes: [2] }, { rank: 2, title: 'redis', combines_with: [], excludes: [1] }];
const DECIDE    = { wrote_file: true, ranking: RANKING, flip: 'robust', user_checks: 0 };
const REVIEW    = { wrote_file: true, edits: 0, flags: 0, ranking: RANKING, flip: 'robust' };
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
  eq(out.decisionFile, `${S}/decision.md`, 'decisionFile');
  eq(out.reviewFile, `${S}/review.md`, 'reviewFile');
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
  ok(flat(empty.out.nextStep).startsWith(`No option passes every non-negotiable: present \`## Ruled out\` in ${S}/decision.md, with the edits under \`## Edits\``),
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
    ['the decider', { decide: { ...DECIDE, wrote_file: false } }, 'decide', `${S}/decision.md`, [I(1), I(2), I(3), I(4)]],
    ['the final reviewer', { review: { ...REVIEW, wrote_file: false } }, 'review', `${S}/review.md`, [I(1), I(2), I(3), I(4)]],
  ];
  for (const [who, override, last, file, files] of cases) {
    const { out, labels } = await run({ ...CLEAN, ...override });
    eq(labels[labels.length - 1], last, `${who}: no agent runs after it`);
    eq(out.status, 'BLOCKED (an agent did not confirm writing its file)', `${who}: the halt status`);
    ok(out.halted === true && out.haltReason.includes(file), `${who}: haltReason names ${file}: ${out.haltReason}`);
    eq(JSON.stringify(out.investigationFiles), JSON.stringify(files), `${who}: investigationFiles holds only the attested files`);
    ok(flat(out.nextStep).includes('relaunch with the same args and no resumeFromRunId'), `${who}: nextStep says to relaunch without a resume`);
  }
  const { out: chainHalt } = await run({ ...CLEAN, 'investigate i': { ...CHALLENGE, wrote_file: false } });
  ok(chainHalt.investigators.stop === '' && chainHalt.decisionFile === '' && chainHalt.reviewFile === '' && chainHalt.chosen === '',
    'a halt inside the chain has no stop, no decision, no review and no choice');
  const { out: decHalt } = await run({ ...CLEAN, decide: { ...DECIDE, wrote_file: false } });
  ok(decHalt.investigators.stop === 'cap' && decHalt.decisionFile === '' && decHalt.ranking.length === 0, 'a decider halt keeps the chain\'s stop and names no decision');
  const { out: revHalt } = await run({ ...CLEAN, review: { ...REVIEW, wrote_file: false } });
  ok(revHalt.decisionFile === `${S}/decision.md` && revHalt.reviewFile === '', 'a reviewer halt names the attested decision and no review');
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
    ok(msg.includes('same runId') && msg.includes('resumeFromRunId'), `${who}: the message says to relaunch with the same runId and resumeFromRunId`);
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
  const missing = await throwsWith(ENGINE, { args: { runId: 't', root: 'E:/r' }, respond: CLEAN });
  ok(missing.startsWith('args.planPath is required'), `the rubric is a planPath only: ${missing.slice(0, 60)}`);
  const noRun = await throwsWith(ENGINE, { args: {}, respond: CLEAN });
  ok(noRun.includes('{ runId, root, planPath }'), `the missing-runId message names the required args: ${noRun.slice(0, 70)}`);
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
  ok(review.includes(`THE DECISION FILE (read it verbatim): ${S}/decision.md`), 'the reviewer reads the decision file');
  ok(review.includes(`WRITE ${S}/review.md.`), 'and writes the review file');
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
    `Save any script it ran under ${S}/scripts/ (create it if needed) with a file name that no file there holds yet, and never change a script already there, so a later agent can rerun it and get the result its citer got.`,
    'test it against each of five hostile inputs: a failure, a concurrent edit, a human-set value, state saved before the change',
    'A defect found that way is a con of the option, or, for a challenger, a contribution when it also fixes it.',
    'A breach reachable only through operator action is a con, never a must failure.',
  ];
  for (const c of calls) {
    const text = flat(c.prompt);
    const missing = RULES.filter((r) => !text.includes(r));
    eq(missing.join(' | '), '', `${c.label}: the prompt states every rubric rule`);
  }
  ok(flat(calls.find((c) => c.label === 'review').prompt).includes(`Rerun each script under ${S}/scripts/ and each testbed command such a cell rests on.`),
    'with a testbed the reviewer reruns the testbed commands too');
  const plain = flat((await run(CLEAN)).prompt('review'));
  ok(plain.includes(`Rerun each script under ${S}/scripts/ such a cell rests on.`), 'without one it reruns the saved scripts');
}

section('the challenger carries the contribution rule and the early-stop proof');
{
  const i2 = flat((await run(CLEAN)).prompt('investigate i2'));
  for (const piece of [
    'It is one of four kinds: a NEW OPTION, a FEATURE ADDED to an option, a FEATURE REMOVED from an option for a stated reason',
    'or a CORRECTION of an error in an earlier file.',
    'It must make the option better on at least one weighted criterion or on a plain measure the rubric does not name',
    'No size threshold applies, since several small contributions can lift an option over another.',
    'unless it names the shortcoming that holds a lower option down and gives evidence that the contribution resolves it.',
    'Never repeat a contribution an earlier file holds, and never edit an earlier file.',
    '`## Contributions`: each under an id C2.1, C2.2 and so on',
    'Set contributed=false only when `## Contributions` reads `None.` and `## Searched` holds at least one replacement attempt and one improvement attempt for each of the three leading options (every option when fewer stand) under `## Standing`',
  ]) ok(i2.includes(piece), `the challenger prompt holds: ${piece.slice(0, 70)}`);
  const i1 = flat((await run(CLEAN)).prompt('investigate i1'));
  ok(['## Options', '## Leader assumptions', '## Standing', '## Searched'].every((h) => i1.includes(`\`${h}\``)), 'the opening investigator writes the four sections');
  ok(!i1.includes('CONTRIBUTION:'), 'and carries no contribution rule, since it has nothing to beat');
}

section('the decider ranks under the tie rule and writes every section, and the reviewer proves each edit');
{
  const { prompt } = await run(CLEAN);
  const dec = flat(prompt('decide'));
  const order = ['## Ranking', '## Options', '## Matrix', '## Flip check', '## Ruled out', '## Changes to investigation facts', '## Checks for the user'];
  ok(ascending(positions(dec, order.map((h) => `- \`${h}\``))), 'the decision file\'s sections are listed in order');
  // Groups formed down one sorted list give every chain of near totals an order, which a pairwise margin cannot.
  const tieRule = 'sort the ranked options by total, best first. The options whose totals lie within 5% of the sum of the weights of the highest total form a tie group, ranked simplest first. Form each next group the same way from the options left.';
  ok(dec.includes(`under the TIE RULE: ${tieRule} The file says where a tie group puts a simpler option above a higher total.`), 'the tie rule, scaled to the weights and grouped down one list');
  ok(dec.includes('Every option an investigation file holds appears under `## Ranking` or `## Ruled out`.'), 'every option is ranked or ruled out');
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
  ok(ascending(positions(rev, ['- `## Edits`', '- `## Flags`'])), 'review.md holds Edits, then Flags');
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

section('the hand-back presents the ranking, a fragile flip check and the checks for the user');
{
  const { out } = await run(CLEAN);
  const next = flat(out.nextStep);
  ok(next.startsWith(`Present the ranking under \`## Ranking\` in ${S}/decision.md, with the edits under \`## Edits\` and every flag under \`## Flags\` in ${S}/review.md.`), `nextStep leads with the ranking: ${next.slice(0, 100)}`);
  ok(next.includes('Rank 1 is the top answer, and the user may combine the entries marked as combinable.'), 'rank 1 and combining');
  ok(next.includes('author it as a plan file, refine it with refine-cycle, then build it with develop-cycle'), 'and how a pick is built');
  ok(!next.includes('FRAGILE') && !next.includes('## Checks for the user'), 'a robust run with no checks carries neither note');
  eq(out.flip, 'robust', 'flip returns the grade');
  const fragile = await run({ ...CLEAN, decide: { ...DECIDE, user_checks: 2 }, review: { ...REVIEW, flip: 'fragile' } });
  ok(flat(fragile.out.nextStep).includes(`The flip check is graded FRAGILE. Present \`## Flip check\` in ${S}/decision.md`), 'a fragile grade adds the flip note');
  ok(flat(fragile.out.nextStep).includes('Present the 2 check(s) under `## Checks for the user`'), 'and checks for the user add their note');
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

section("every prompt that writes a file says to Read an earlier launch's file first, and a rejected write is not a write");
{
  const { prompt } = await run(CLEAN);
  const sites = [
    ['the opening investigation file', prompt('investigate i1'), 1, 1],
    ['a challenger\'s investigation file', prompt('investigate i2'), 1, 1],
    ['the decision file', prompt('decide'), 1, 1],
    ['the review file', prompt('review'), 1, 1],
  ];
  pinWriteNotes(sites);
  pinFileWriteNote(sites);
}
