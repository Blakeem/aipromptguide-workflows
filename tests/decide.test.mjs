// decide/decide-cycle.mjs: the convergence loop, the staged final review, and what the run hands back.
// The final reviewer judges in two stages: blind on an evidence ledger, then against the decision file once
// review-check.mjs has locked its blind review. The engine cannot see either stage, so what it controls is
// pinned here: the reviewer prompt names nothing the blind stage must not see, the check agent's counts
// decide the verdict, a lock mismatch falls back to the locked blind verdict, and a reviewer that never ran
// the check is rerun once, then blocks. The baseline cases pin the terminal states and the dead-agent
// throws around it.
import { runEngine, throwsWith, section, ok, eq } from './harness.mjs';
import { pinRoleMaps, pinWriteNotes, pinFileWriteNote } from './role-map-pin.mjs';
import { pathsFor } from '../tools/review-check.mjs';

const ENGINE = 'workflows/decide/decide-cycle.mjs';
const S = 'E:/r/runs/t';
const TOOL = 'E:/r/tools/review-check.mjs';

const baseArgs = {
  runId: 't',
  root: 'E:/r',
  planPath: 'E:/r/plans/t/requirements.md',
  lenses: ['efficiency', 'simplest'],
  checkTool: TOOL,
};
const RANKED = { ...baseArgs, selection: 'ranked' };
const run = (respond, args = baseArgs, budget) => runEngine(ENGINE, { args, respond, budget });

const LENS = { wrote_file: true, top_pick: 'in-process LRU' };
const DECIDE  = { wrote_file: true, chosen: 'in-process LRU', meets_all_requirements: true, flip: 'robust', open_issue_ids: [], user_checks: 0, needs_user: false };
const ACCEPT  = { wrote_file: true, verdict: 'accept', needs_user: false };
const REJECT  = { ...ACCEPT, verdict: 'reject' };
// One object answers both check-agent calls: the setup reads wrote_file, the verify the other three.
const CHECK   = { wrote_file: true, exit_code: 0, final_line: 'raised 0, withdrawn 0, kept 0, downgraded 0, caveats 0', stage1_verdict: '' };
const KEPT    = { ...CHECK, final_line: 'raised 2, withdrawn 1, kept 1, downgraded 0, caveats 0' };
const CAVEATED = { ...CHECK, final_line: 'raised 1, withdrawn 0, kept 0, downgraded 1, caveats 2' };
const NO_LOCK = { ...CHECK, exit_code: 2 };
const MISMATCH = (verdict) => ({ ...CHECK, exit_code: 3, stage1_verdict: verdict });
const CLEAN = { research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK };
const roundOf = (label) => Number(label.match(/ r(\d+)/)?.[1] ?? 0);
// The reviewer rejects through review round n and accepts after, and its check counts agree.
const rejectsThrough = (n) => ({
  review: (label) => (roundOf(label) <= n ? REJECT : ACCEPT),
  check: (label) => (roundOf(label) <= n ? KEPT : CHECK),
});
const list = (v) => (Array.isArray(v) ? v : []);
const flat = (s) => String(s ?? '').replace(/\s+/g, ' ');
const promptsOf = (byLabel, prefix) => byLabel(prefix).map((c) => flat(c.prompt));
const reviewersOf = (calls) => calls.filter((c) => /^review r\d+( rerun)?$/.test(c.label));
const revealOf = (prompt) => String(prompt).slice(String(prompt).indexOf('BEGIN TEXT\n') + 11, String(prompt).indexOf('\nEND TEXT'));

section('the reviewer accepting ends the loop inside the round budget');
{
  const { out, byLabel } = await run(CLEAN, { ...baseArgs, maxRounds: 4 });
  eq(byLabel('decide').length, 1, 'ended on round 1, well inside maxRounds=4');
  eq(out.status, 'decided (the final reviewer accepts the decision)', 'status');
  ok(out.agreed === true && out.halted === false, 'the return carries the flags');
  eq(out.decisionFile, `${S}/decide/decision-r1.md`, 'the decision lives in the decide/ folder');
  eq(JSON.stringify(out.reviewFiles), JSON.stringify([`${S}/review/review-r1.md`, `${S}/decide/review-r1-final.md`]),
    'reviewFiles names the blind review and the final review');
  eq(out.needsUserFile, '', 'and no escalation file — nothing was escalated');
  eq(JSON.stringify(out.reviewRounds), JSON.stringify([{ round: 1, verdict: 'accept', raised: 0, withdrawn: 0, kept: 0, downgraded: 0, caveats: 0, lockMatched: true }]),
    'reviewRounds records the round\'s counts');
  ok(!['gapRounds', 'caveatFiles'].some((k) => k in out), 'the retired gap and caveat file fields are gone');
  eq(out.caveats, 0, 'caveats counts none');
  ok(String(out.nextStep).startsWith('Present the conclusion'), `with no caveat, nextStep carries no caveat note: ${String(out.nextStep).slice(0, 120)}`);
  ok(flat(out.nextStep).includes('Present the conclusion the final reviewer accepted in round 1:')
    && flat(out.nextStep).includes('(the matrix + rationale + why-not-others + trade-off + flip check)'),
  'the hand-back names the acceptance, its round and what to relay');
  ok(String(out.reviewTrail).includes(`${S}/review/`) && String(out.reviewTrail).includes(`${S}/decide/`), `reviewTrail names both folders: ${out.reviewTrail}`);
  const { out: ranked } = await run({ ...CLEAN, decide: { ...DECIDE, shortlist: [{ rank: 1, title: 'in-process LRU' }, { rank: 2, title: 'redis' }] } }, RANKED);
  ok(flat(ranked.nextStep).includes('Present the SHORTLIST the final reviewer accepted in round 1:')
    && flat(ranked.nextStep).includes('the combine-vs-exclusive section + the flip check)')
    && ranked.nextStep.includes('(several picks become several blocks of one plan file)'),
  'and so does a ranked run\'s, with the flip check and the several-picks note');
}

section('an accept that names caveats ends decided with caveats, counted from the check\'s counts line');
{
  const { out, logs } = await run({ ...CLEAN, check: CAVEATED });
  eq(out.status, 'decided with caveats (the final reviewer accepts the decision and names 2 caveats)', 'the status names the caveat count');
  ok(out.agreed === true, 'and the run agreed');
  eq(out.caveats, 2, 'caveats returns the count');
  eq(out.reviewRounds?.[0]?.caveats, 2, 'and reviewRounds records it');
  ok(String(out.nextStep).startsWith(`Carry the 2 caveat(s) under "## Caveats" in ${S}/decide/review-r1-final.md into the plan's design section.`),
    `nextStep leads with the caveat note: ${String(out.nextStep).slice(0, 120)}`);
  ok(logs.some((l) => l === '  ✓ r1: the reviewer ACCEPTS (raised 1, withdrawn 0, kept 0, downgraded 1, caveats 2)'), 'the log names the caveats');
  const { out: one } = await run({ ...CLEAN, check: { ...CHECK, final_line: 'raised 0, withdrawn 0, kept 0, downgraded 0, caveats 1' } });
  eq(one.status, 'decided with caveats (the final reviewer accepts the decision and names 1 caveat)', 'one caveat reads singular');
  const { out: rejected } = await run({ ...CLEAN, review: REJECT, check: { ...KEPT, final_line: 'raised 2, withdrawn 1, kept 1, downgraded 0, caveats 3' } }, { ...baseArgs, maxRounds: 1 });
  ok(rejected.status.startsWith('needs-attention') && rejected.caveats === 3, `a reject keeps its status and still returns the count: ${rejected.status}`);
  // A counts line with no caveat count is not one the tool prints, so it never reads as zero caveats.
  const msg = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, check: { ...CHECK, final_line: 'raised 0, withdrawn 0, kept 0, downgraded 0' } } });
  ok(msg.startsWith('Check agent returned an unreadable result in round 1'), `a counts line without caveats throws: ${msg.slice(0, 80)}`);
}

section('the reviewer and the reveal name the caveat line shape, and the reveal names the objections heading');
{
  const { byLabel } = await run(CLEAN);
  const rev = flat(byLabel('review r1')[0]?.prompt);
  ok(rev.includes('a `## Caveats` section: one line per caveat, `- C<n>: <the caveat>. Evidence: <the evidence>`, numbered from C1, or "None.";'), 'the blind review format names - C<n>:');
  const reveal = flat(revealOf(byLabel('check-setup r1')[0]?.prompt));
  ok(reveal.includes('Write a `## Objections` section with one line per objection of your review,') && reveal.includes('one line each, `- C<n>: <the caveat>`, numbered from C1, or "None."'),
    `the reveal names the objections heading and the caveat shape: ${reveal.slice(reveal.indexOf('WRITE'), reveal.indexOf('WRITE') + 200)}`);
}

section('each review round runs the check agent, one reviewer, then the check, in sequence, with a neutral review schema');
{
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { calls } = await run(CLEAN, args);
    const review = calls.filter((c) => c.opts.phase === 'Review');
    eq(review.map((c) => c.label).join(','), 'check-setup r1,review r1,check r1', `${sel}: setup, one reviewer, verify`);
    ok(review.every((c) => c.group === null), `${sel}: no fan-out`);
    const schema = review.find((c) => c.label === 'review r1')?.opts.schema;
    eq(JSON.stringify(Object.keys(schema?.properties ?? {})), JSON.stringify(['wrote_file', 'verdict', 'needs_user']), `${sel}: the review schema holds only wrote_file, verdict and needs_user`);
    eq(JSON.stringify(schema?.required), JSON.stringify(['wrote_file', 'verdict', 'needs_user']), `${sel}: and requires all three`);
    ok(!/stage|withdraw|decision|reveal/i.test(JSON.stringify(schema)), `${sel}: and no description names a stage, a withdrawal or the decision file`);
    const checks = review.filter((c) => c.label.startsWith('check'));
    ok(checks.every((c) => c.opts.model === 'sonnet' && c.opts.effort === 'high'), `${sel}: the check agent runs on sonnet at high`);
  }
}

section('the reviewer prompt is blind: in every selection and round it names no decide, research or lens path and no later stage');
// A real pass and a mutant check: the mutant adds what the assertion forbids, so the assertion is proven to bite.
{
  const ISSUE = { wrote_file: true, new_evidence: true };
  const FORBIDDEN = [/reveal/i, /stage 2/i, /stage-2/i, /withdraw/i, /decider's scoring/i];
  const DIRS = [`${S}/decide/`, `${S}/research/`, `${S}/lenses/`];
  const leaks = (p) => [...DIRS.filter((d) => p.includes(d)), ...FORBIDDEN.filter((re) => re.test(p)).map(String)];
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    for (const testbed of ['', 'sqlite3 "file:bench.db?mode=ro"']) {
      const { calls } = await run({
        research: LENS, 'research-issue': ISSUE, ...rejectsThrough(2),
        decide: (label) => (label === 'decide r1' ? { ...DECIDE, open_issue_ids: ['p99-unproven'] } : DECIDE),
      }, { ...args, maxRounds: 3, ...(testbed ? { testbed, target: { repo: 'E:/repo' } } : {}) });
      const tag = `${sel}${testbed ? ' + testbed' : ''}`;
      const reviewers = reviewersOf(calls);
      eq(reviewers.map((c) => c.label).join(','), 'review r1,review r2,review r3', `${tag}: a fresh reviewer each round`);
      for (const c of reviewers) {
        const p = String(c.prompt);
        eq(leaks(p).join(', '), '', `${tag}/${c.label}: the prompt names no decide, research or lens path and no later stage`);
        ok(p.includes(`${S}/review/ledger-r`) && p.includes(`WRITE ${S}/review/review-r${roundOf(c.label)}.md`), `${tag}/${c.label}: it names its ledger and its own blind file`);
        ok(flat(p).trimEnd().endsWith(`When the review file is complete, run \`node '${TOOL}' '${S}/review/review-r${roundOf(c.label)}.md'\` and follow what it prints.`),
          `${tag}/${c.label}: its task text ends with the check command`);
      }
      // The reviewer of round 1 scores the decision of pass 2, which the research round produced.
      ok(reviewers[0].prompt.includes(`${S}/review/ledger-r2.md`), `${tag}: the reviewer reads the ledger of the latest attested decision`);
    }
  }
  const mutant = `${'x'.repeat(10)} ${S}/decide/decision-r1.md then withdraw`;
  ok(leaks(mutant).length === 2, 'the leak check catches a decide path and a forbidden word in a mutant prompt');
}

section('the check agent writes the spec and the reveal, and the spec path follows the tool\'s convention');
{
  const { byLabel } = await run({ research: LENS, decide: DECIDE, ...rejectsThrough(1) }, { ...baseArgs, maxRounds: 2 });
  const setup = String(byLabel('check-setup r1')[0]?.prompt);
  const json = setup.slice(setup.indexOf('exactly this JSON:\n') + 19, setup.indexOf('\n2. WRITE'));
  let spec = {};
  try { spec = JSON.parse(json); } catch { spec = {}; }
  eq(JSON.stringify(spec), JSON.stringify({ headings: ['## Scores', '## Objections', '## Caveats'], stage2: `${S}/decide/review-r1-final.md`, decision: `${S}/decide/decision-r1.md`, reveal: `${S}/locks/review-r1.reveal.md` }),
    'the spec names the headings, the final file, the reviewed decision and the reveal file');
  const specPath = pathsFor(`${S}/review/review-r1.md`).spec.replace(/\\/g, '/');
  ok(setup.includes(`WRITE ${specPath} `), `the setup writes the spec where review-check.mjs looks for it: ${specPath}`);
  const lockPath = pathsFor(`${S}/review/review-r1.md`).lock.replace(/\\/g, '/');
  ok(flat(setup).includes(`WRITE ${lockPath} with the content {} and ${S}/decide/review-r1-final.md with no content`),
    'the setup resets the lock and the final file, so no file of an earlier launch stands in for this round');
  const reviewer = String(byLabel('review r1')[0]?.prompt);
  ok(spec.headings?.every((h) => reviewer.includes(h)), 'the reviewer is told every heading the spec checks');
  const reveal = flat(revealOf(setup));
  ok(reveal.includes(`read the decision file ${S}/decide/decision-r1.md`) && reveal.includes(`WRITE ${S}/decide/review-r1-final.md.`),
    'the reveal names the decision file and the final file');
  ok(reveal.includes('Quote that fact word for word in double quotes. The decider\'s opinion, weight or argument never withdraws an objection.'),
    'a withdrawal needs a quoted sourced fact, never the decider\'s argument');
  ok(reveal.includes('A reject keeps at least one objection: a non-negotiable the winner violates, or a challenger with its scores. An accept keeps none.'),
    'a reject keeps an objection');
  ok(reveal.includes(`run \`node '${TOOL}' '${S}/review/review-r1.md'\` again`), 'and the reviewer runs the check again');
  ok(!reveal.includes('WHERE NEXT'), 'round 1 of 2 is not the last round');
  ok(flat(revealOf(byLabel('check-setup r2')[0]?.prompt)).includes('This is the run\'s LAST round: no decider round follows. If your final verdict is reject, put a `## WHERE NEXT` section just above the verdict line.'),
    'the last round\'s reveal asks for WHERE NEXT');
  ok(flat(byLabel('check r1')[0]?.prompt).includes(`node '${TOOL}' --verify '${S}/review/review-r1.md'`), 'the verify runs the tool on the blind file');
  const { byLabel: ranked } = await run(CLEAN, RANKED);
  ok(flat(revealOf(ranked('check-setup r1')[0]?.prompt)).includes('A reject keeps at least one objection: a listed option that violates a non-negotiable, a challenger with its scores, or a combine or exclude claim the evidence contradicts.'),
    'ranked: a combine or exclude claim the evidence contradicts is an objection too');
}

section('a kept objection sends the decider the final review, and a fresh reviewer judges the revision');
{
  const CHALLENGER = { single: 'A CHALLENGER, an option the reviewer scores above the winner: score the winner and the challenger side by side on the same rubric, every cell cited, and keep the higher.',
    ranked: 'A CHALLENGER, an option the reviewer scores above a listed option it would displace or above the option ranked just above it: score the two side by side on the same rubric, every cell cited, and order them by that score.' };
  const MUST = { single: 'A NON-NEGOTIABLE VIOLATION: repair the winner so it passes, or replace it with the best option that passes.',
    ranked: 'A NON-NEGOTIABLE VIOLATION: repair the listed option so it passes, or take it off the list.' };
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { out, byLabel, logs } = await run({ research: LENS, decide: DECIDE, ...rejectsThrough(1) }, { ...args, maxRounds: 3 });
    const d2 = flat(byLabel('decide r2')[0]?.prompt);
    ok(d2.includes(`THE REVIEWER REJECTED the decision of review round 1. READ its final review ${S}/decide/review-r1-final.md, which sorts each objection of its blind review ${S}/review/review-r1.md into withdrawn, kept or downgraded to a caveat. Act on each KEPT objection.`),
      `${sel}: the decider reads the final review`);
    ok(d2.includes(CHALLENGER[sel]) && d2.includes(MUST[sel]), `${sel}: a challenger is scored side by side, and a must violation repaired or replaced`);
    ok(d2.includes(`Then redo the totals, ${sel === 'ranked' ? 'the order' : 'the trade-off'} and the flip check.`), `${sel}: the closing fold rule matches its selection`);
    ok(d2.includes(`WRITE ${S}/review/ledger-r2.md`), `${sel}: the revision writes a new ledger`);
    ok(String(byLabel('review r2')[0]?.prompt).includes(`${S}/review/ledger-r2.md`), `${sel}: the round-2 reviewer judges the revision's ledger`);
    ok(logs.some((l) => l === '  ↻ r1: the reviewer REJECTS (raised 2, withdrawn 1, kept 1, downgraded 0, caveats 0) → decider revises'), `${sel}: the log names the counts`);
    eq(JSON.stringify(out.reviewRounds?.[0]), JSON.stringify({ round: 1, verdict: 'reject', raised: 2, withdrawn: 1, kept: 1, downgraded: 0, caveats: 0, lockMatched: true }), `${sel}: and so does reviewRounds`);
    eq(out.status, 'decided (the final reviewer accepts the decision)', `${sel}: round 2 accepts`);
    ok(!flat(byLabel('decide r1')[0]?.prompt).includes('THE REVIEWER REJECTED'), `${sel}: round 1 has no review to act on`);
  }
}

section('the counts decide the verdict, so a returned verdict they contradict is flagged and overruled');
{
  const { out: keptAccept, logs } = await run({ ...CLEAN, check: KEPT }, { ...baseArgs, maxRounds: 1 });
  eq(keptAccept.status, 'needs-attention (no agreement within round budget)', 'an accept whose check keeps an objection is a reject');
  eq(keptAccept.contradicted, true, 'and is flagged');
  ok(logs.some((l) => l.includes('the reviewer returned "accept" but its check counts give "reject" → the counts decide')), 'and logged');
  // A withdrawal whose quote the tool could not find already counts as kept in the line the tool prints.
  const { out: rejectNone } = await run({ ...CLEAN, review: REJECT });
  eq(rejectNone.status, 'decided (the final reviewer accepts the decision)', 'a reject that keeps no objection is an accept');
  ok(String(rejectNone.nextStep).startsWith(`The reviewer returned reject while its review keeps no objection: audit ${S}/decide/review-r1-final.md before presenting.`),
    `nextStep leads with the audit: ${String(rejectNone.nextStep).slice(0, 140)}`);
  const { out: clean } = await run(CLEAN);
  eq(clean.contradicted, false, 'a verdict the counts agree with is not flagged');
}

section('a lock mismatch falls back to the locked blind verdict');
{
  const { out, byLabel, logs } = await run({ ...CLEAN, check: (label) => (roundOf(label) === 1 ? MISMATCH('reject') : CHECK) }, { ...baseArgs, maxRounds: 2 });
  ok(logs.some((l) => l.includes(`⚠ r1: ${S}/review/review-r1.md does not match its lock → the locked blind verdict "reject" stands`)), 'the fallback is logged');
  eq(JSON.stringify(out.reviewRounds?.[0]), JSON.stringify({ round: 1, verdict: 'reject', raised: 0, withdrawn: 0, kept: 0, downgraded: 0, caveats: 0, lockMatched: false }), 'the locked verdict outranks the counts');
  const d2 = flat(byLabel('decide r2')[0]?.prompt);
  ok(d2.includes(`Its blind review changed after its lock, so act on every objection in the blind review ${S}/review/review-r1.md.`)
    && !d2.includes('READ its final review'), 'the decider acts on the blind review alone');

  const { out: accepted } = await run({ ...CLEAN, review: REJECT, check: MISMATCH('accept') });
  eq(accepted.status, 'decided (the final reviewer accepts the decision)', 'a locked accept is an accept, whatever the reviewer returned');
  eq(JSON.stringify(accepted.reviewFiles), JSON.stringify([`${S}/review/review-r1.md`]), 'reviewFiles names only the blind review');
  ok(String(accepted.nextStep).startsWith(`The reviewer's blind review ${S}/review/review-r1.md changed after its lock, so its locked verdict stands: audit it before presenting.`),
    `nextStep leads with the audit: ${String(accepted.nextStep).slice(0, 140)}`);
  eq(accepted.contradicted, false, 'a fallback is not a contradiction');
}

section('a locked blind review with no final review stands, and its file is the one handed on');
{
  const BLIND_ONLY = (verdict, n) => ({ ...CHECK, final_line: `raised ${n}, withdrawn 0, kept ${n}, downgraded 0, caveats 1`, stage1_verdict: verdict });
  const { out, logs } = await run({ ...CLEAN, check: BLIND_ONLY('accept', 0) });
  eq(out.status, 'decided with caveats (the final reviewer accepts the decision and names 1 caveat)', 'a blind accept with no final review is an accept, with the blind review\'s caveat');
  eq(JSON.stringify(out.reviewFiles), JSON.stringify([`${S}/review/review-r1.md`]), 'reviewFiles names only the blind review');
  ok(String(out.nextStep ?? '').includes(`Carry the 1 caveat(s) under "## Caveats" in ${S}/review/review-r1.md into the plan's design section.`),
    'the caveats are carried from the blind review, not the unwritten final file');
  ok(logs.some((l) => l.includes(`⚠ r1: the reviewer wrote no final review ${S}/decide/review-r1-final.md → its locked blind verdict "accept" stands`)), 'the fallback is logged');
  eq(JSON.stringify(out.reviewRounds?.[0]), JSON.stringify({ round: 1, verdict: 'accept', raised: 0, withdrawn: 0, kept: 0, downgraded: 0, caveats: 1, lockMatched: true }), 'the lock still matched');

  const { out: rejected, byLabel } = await run({ ...CLEAN, review: (label) => (roundOf(label) === 1 ? REJECT : ACCEPT), check: (label) => (roundOf(label) === 1 ? BLIND_ONLY('reject', 2) : CHECK) }, { ...baseArgs, maxRounds: 2 });
  eq(JSON.stringify(rejected.reviewRounds?.[0]), JSON.stringify({ round: 1, verdict: 'reject', raised: 2, withdrawn: 0, kept: 2, downgraded: 0, caveats: 1, lockMatched: true }), 'a blind reject keeps every objection');
  const d2 = flat(byLabel('decide r2')[0]?.prompt);
  ok(d2.includes(`It wrote no final review, so act on every objection in the blind review ${S}/review/review-r1.md.`)
    && !d2.includes('READ its final review'), 'the decider acts on the blind review alone');
}

section('a reviewer that never ran the check is rerun once, then the run blocks');
{
  const { out, labels, logs } = await run({ ...CLEAN, check: (label) => (label === 'check r1' ? NO_LOCK : CHECK) });
  eq(labels.filter((l) => /^(review|check) r1/.test(l)).join(','), 'review r1,check r1,review r1 rerun,check r1 rerun', 'one rerun of the reviewer and its check');
  ok(logs.some((l) => l.includes(`no lock on ${S}/review/review-r1.md: the reviewer never ran the check → rerunning the reviewer once`)), 'the rerun is logged');
  eq(out.status, 'decided (the final reviewer accepts the decision)', 'and the rerun\'s verdict counts');

  const { out: twice, labels: twiceLabels } = await run({ ...CLEAN, check: NO_LOCK }, { ...baseArgs, maxRounds: 3 });
  eq(twice.status, 'BLOCKED (the reviewer did not complete its review)', 'a second miss ends on the new terminal');
  ok(twice.halted === true && twice.agreed === false, 'reported halted');
  ok(twice.haltReason.includes(`${S}/review/review-r1.md`), `haltReason names the blind file: ${twice.haltReason}`);
  eq(twiceLabels.filter((l) => l.startsWith('review')).length, 2, 'no third reviewer');
  ok(!twiceLabels.includes('decide r2'), 'and no decider round follows');
  eq(JSON.stringify(twice.reviewFiles), '[]', 'no review file is named');
  ok(flat(twice.nextStep).includes(`Check that this project's settings allow Bash(node '${TOOL}':*), so the reviewer can run the check unattended, then relaunch with the same args and no resumeFromRunId: a resume replays the cached returns`),
    'nextStep says to allow the check command, then relaunch with no resumeFromRunId');
}

section('a check result outside the tool\'s documented exits throws');
{
  for (const [what, check] of [['exit 1', { ...CHECK, exit_code: 1, final_line: 'usage' }], ['exit 0 with no counts line', { ...CHECK, final_line: 'done' }],
    ['exit 3 with no locked verdict', MISMATCH('')], ['a non-integer exit', { ...CHECK, exit_code: '0' }],
    ['exit 0 with a locked verdict outside the verdicts', { ...CHECK, stage1_verdict: 'maybe' }]]) {
    const msg = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, check } });
    ok(/^Check agent returned an unreadable result in round 1/.test(msg) && /no resumeFromRunId/.test(msg), `${what} throws: ${msg.slice(0, 80)}`);
  }
}

section('every review prompt names the default-path rule, and the round-2 decider the fold rules');
{
  const RULE1 = 'Operator action means only a deliberate configuration change or command by the user that the requirements neither list as a scenario nor require the decision to provide. A path they list or require, such as a human commit, a revert or a manual apply path, is on the default path.';
  const HOSTILE = 'Before you write a fold, test it against one hostile input of each kind it touches, such as a failure, a concurrent edit, a human-set value, state saved before the change (a legacy row, a migration, a value an older version stored), or an edit by another program that no scan has seen yet, so the fold does not open a new defect.';
  const SYMMETRIC = 'Never add a repaired variant as a new rival option. When a fold repairs one option against a defect another option shares, repair that option the same way and keep it scored in the matrix.';
  const CONFIRM = 'An objection is another agent\'s claim. Before you act on one, confirm its evidence against its source: open the file:line, URL or requirements text it cites, and re-run a measurement it cites where you can run it.';
  const TO_RESEARCH = 'An objection you can neither confirm nor refute, or one that names evidence no file of the run holds, becomes an open issue, so a research round settles it before the next review.';
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { byLabel } = await run({ research: LENS, decide: DECIDE, ...rejectsThrough(1) }, { ...args, maxRounds: 3 });
    const reviews = promptsOf(byLabel, 'review r');
    ok(reviews.length === 2 && reviews.every((p) => p.includes(RULE1)), `${sel}: every reviewer holds the default-path rule`);
    const d2 = flat(byLabel('decide r2')[0]?.prompt);
    ok([HOSTILE, SYMMETRIC, CONFIRM, TO_RESEARCH].every((rule) => d2.includes(rule)), `${sel}: the round-2 decider holds the fold rules`);
    ok(![HOSTILE, CONFIRM].some((rule) => flat(byLabel('decide r1')[0]?.prompt).includes(rule)), `${sel}: round 1 has nothing to fold`);
  }
}

section('the decider writes an evidence ledger that holds facts and no judgment');
{
  const NO_JUDGMENT = 'The ledger holds no score, weight, total, rationale or lens recommendation, and it cites no lens, research or decision file: copy the original source such a file cites instead. A fact with no original source stays out.';
  for (const [sel, args, answer] of [['single', baseArgs, '`## Answer under review`: the winner.'], ['ranked', RANKED, '`## Answer under review`: the listed options in rank order, then each combine and exclude claim.']]) {
    const { byLabel } = await run(CLEAN, args);
    const d = flat(byLabel('decide r1')[0]?.prompt);
    ok(d.includes(`EVIDENCE LEDGER: also WRITE ${S}/review/ledger-r1.md`), `${sel}: the decider writes the ledger to the review folder`);
    ok(d.includes(NO_JUDGMENT), `${sel}: the ledger rules forbid scores, rationale and links to judgment files`);
    ok(d.includes(answer), `${sel}: the ledger names the answer under review`);
    ok(d.includes('`## Facts`: for each candidate, every fact its scores rest on, each with its original source'), `${sel}: and each fact with its original source`);
    ok(d.includes(`WRITE ${S}/decide/decision-r1.md (create ${S}/decide/ if needed)`), `${sel}: the decision goes to the decide folder`);
  }
}

section('the lens researcher cites each claim, and the reviewer re-checks the original source behind each fact');
{
  const CITE = 'Cite each factual claim to its original source: a file:line, a measurement (the exact command and its result), a source URL, or "own judgment" where you have none.';
  const OWNER = 'The final reviewer sees only the original sources, never your file, and re-checks the source behind each fact that moves the outcome.';
  const SOURCE = 'For each fact that moves a score, open its original source and confirm it says what the ledger claims';
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    for (const testbed of ['', 'sqlite3 "file:bench.db?mode=ro"']) {
      const { byLabel } = await run(CLEAN, testbed ? { ...args, testbed } : args);
      const tag = `${sel}${testbed ? ' + testbed' : ''}`;
      ok(promptsOf(byLabel, 'research:').every((p) => p.includes(CITE) && p.includes(OWNER)), `${tag}: every lens researcher cites each claim and knows who re-checks it`);
      const p = flat(byLabel('review r1')[0]?.prompt);
      ok(p.includes(SOURCE), `${tag}: the reviewer re-checks the original source`);
      ok(p.includes(', and re-run each testbed command it rests on.') === Boolean(testbed), `${tag}: ${testbed ? 're-runs' : 'names no'} testbed command`);
    }
  }
}

section('the decider writes a flip check in both selections, and a trade-off in single');
{
  const { byLabel: single } = await run(CLEAN);
  const s = flat(single('decide r1')[0]?.prompt);
  ok(s.includes('4. TRADE-OFF:') && s.includes('5. FLIP CHECK:'), 'single: TRADE-OFF and FLIP CHECK steps');
  ok(s.includes('a `## Trade-off` section, a `## Flip check` section'), 'single: both sections are written');
  const { byLabel: ranked } = await run(CLEAN, RANKED);
  const r = flat(ranked('decide r1')[0]?.prompt);
  ok(r.includes('4. FLIP CHECK: for each adjacent pair on the list') && !r.includes('TRADE-OFF:'), 'ranked: a FLIP CHECK over adjacent pairs, no trade-off');
  ok(r.includes('"Combine / exclude" section') && r.indexOf('then the flip check') > r.indexOf('"Combine / exclude" section'),
    'ranked: the flip check is written after the combine/exclude section');
}

section('flip returns the grade, and nextStep carries the FRAGILE and DOMINANT notes in each selection');
{
  const NOTES = {
    single: {
      fragile: 'The decider graded the choice FRAGILE. Present its Flip check and Trade-off sections, since the winner turns on the input the Flip check names, and let the user settle it. ',
      dominant: 'The winner dominates the runner-up: the Trade-off section shows nothing given up. ',
    },
    ranked: {
      fragile: 'The decider graded rank 1 FRAGILE. Present its flip check, since rank 1 turns on the input it names, and let the user settle it. ',
      dominant: 'Rank 1 is at least as good as rank 2 on every criterion. ',
    },
  };
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    for (const grade of ['fragile', 'dominant']) {
      const { out, logs } = await run({ ...CLEAN, decide: { ...DECIDE, flip: grade } }, args);
      eq(String(out.flip ?? ''), grade, `${sel}: flip returns ${grade}`);
      ok(String(out.nextStep).startsWith(NOTES[sel][grade] + 'Present the'), `${sel}: the ${grade} note leads: ${String(out.nextStep).slice(0, 90)}`);
      ok(logs.some((l) => l.includes(`flip=${grade}, open=0, checks=0)`)), `${sel}: the decider's log line reads flip, open issues and checks`);
    }
    const { out: robust } = await run(CLEAN, args);
    eq(String(robust.flip ?? ''), 'robust', `${sel}: robust is returned`);
    ok(/^Present the/.test(robust.nextStep), `${sel}: and adds no note`);
    const { out: junk, logs } = await run({ ...CLEAN, decide: { ...DECIDE, flip: 'shaky' } }, args);
    ok(junk.flip === '', `${sel}: a grade outside the enum returns '' (got ${JSON.stringify(junk.flip)})`);
    ok(logs.some((l) => l.includes('flip=?, open=0, checks=0)')), `${sel}: and logs as ?`);
  }
  // The flip describes the latest attested decision, never an earlier round's.
  const { out } = await run({
    research: LENS, ...rejectsThrough(1),
    decide: (label) => (/r1$/.test(label) ? { ...DECIDE, flip: 'fragile' } : { ...DECIDE, flip: 'dominant' }),
  }, { ...baseArgs, maxRounds: 3 });
  eq(String(out.flip ?? ''), 'dominant', 'the latest round\'s grade wins');
  // Notes compose in order: the audit, the flip note, the caveat note, then the present sentence.
  const { out: all } = await run({ ...CLEAN, check: CAVEATED, decide: { ...DECIDE, flip: 'fragile', meets_all_requirements: false } });
  const n = String(all.nextStep);
  const at = ['The decider itself reported', 'The decider graded the choice FRAGILE', 'Carry the 2 caveat(s)', 'Present the conclusion'].map((s) => n.indexOf(s));
  ok(at.every((i, k) => i >= 0 && (k === 0 || i > at[k - 1])), `audit, flip, caveat, present, in that order: ${n.slice(0, 160)}`);
}

section('both escalations halt on the same status, and the decider\'s runs no reviewer');
{
  const { out, labels } = await run({ ...CLEAN, decide: { ...DECIDE, needs_user: true } });
  eq(out.status, 'BLOCKED (needs user input)', 'the decider\'s escalation');
  ok(!labels.some((l) => l.startsWith('review') || l.startsWith('check')), 'it breaks BEFORE the review — nothing reviews a decision that was not made');
  ok(out.needsUserFile.endsWith('NEEDS-USER.md'), 'the escalation file is named');

  const { out: byReviewer, labels: revLabels } = await run({ ...CLEAN, review: { ...REJECT, needs_user: true } });
  eq(byReviewer.status, 'BLOCKED (needs user input)', 'the reviewer\'s escalation lands on the same status');
  ok(revLabels.includes('review r1') && !revLabels.includes('check r1'), 'but by a different route — the reviewer ran, and no check follows it');
  ok(byReviewer.needsUserFile.endsWith('NEEDS-USER.md'), 'and names the same file');
  // The engine keeps no state across invocations, so a relaunch restarts, and a resume replays the halt.
  for (const halt of [out, byReviewer]) {
    ok(/relaunch with the same args and no resumeFromRunId/.test(halt.nextStep) && /round 1 and overwrites the round files/.test(halt.nextStep),
      `the halt relaunches with no resumeFromRunId and says it restarts: ${halt.nextStep.slice(-200)}`);
    ok(!/to continue/.test(halt.nextStep), 'and never promises to continue the halted run');
  }
}

section('an unattested decider, check agent or reviewer write halts, and the return names only attested files');
// A same-runId re-run restarts at round 1, so an earlier run's file can sit at the path an unattested write names.
{
  const UNATTESTED = 'BLOCKED (an agent did not confirm writing its file)';
  const { out, labels } = await run({ ...CLEAN, decide: { ...DECIDE, wrote_file: false } });
  eq(out.status, UNATTESTED, 'an unattested decision halts on its own status');
  ok(out.halted === true && out.agreed === false, 'reported halted, never agreed');
  ok(!labels.some((l) => l.startsWith('review') || l.startsWith('check')), 'no reviewer judges a decision file nobody attested');
  ok(out.haltReason.includes(`${S}/decide/decision-r1.md and ${S}/review/ledger-r1.md`), `haltReason names both files: ${out.haltReason}`);
  eq(out.decisionFile, '', 'and the return names no decision file');
  eq(out.chosen, '', 'nor a chosen option from the unattested round');
  eq(out.needsUserFile, '', 'nothing was escalated');
  ok(/no resumeFromRunId: a resume replays the cached return/.test(out.nextStep), 'nextStep relaunches with no resumeFromRunId and says why');
  ok(/Check that file, then relaunch with the same args/.test(out.nextStep), 'nextStep holds the check the status no longer gives');

  const { out: setup, labels: setupLabels } = await run({ ...CLEAN, 'check-setup': { wrote_file: false } });
  eq(setup.status, UNATTESTED, 'an unattested check spec halts on the same status');
  ok(!setupLabels.includes('review r1'), 'before the reviewer runs against a spec nobody attested');
  ok(setup.haltReason.includes(`${S}/locks/review-r1.json`), `haltReason names the spec: ${setup.haltReason}`);

  const { out: rev, labels: revLabels } = await run({ research: LENS, decide: DECIDE, ...rejectsThrough(1), review: (label) => (roundOf(label) === 1 ? REJECT : { ...REJECT, wrote_file: false }) }, { ...baseArgs, maxRounds: 3 });
  eq(rev.status, UNATTESTED, 'an unattested reviewer halts on the same status');
  ok(!revLabels.includes('check r2') && !revLabels.includes('decide r3'), 'before its check runs or any decider is sent to it');
  eq(JSON.stringify(rev.reviewFiles), JSON.stringify([`${S}/review/review-r1.md`, `${S}/decide/review-r1-final.md`]), 'reviewFiles keeps the last attested round\'s files');
  eq(rev.decisionFile, `${S}/decide/decision-r2.md`, 'and the attested round-2 decision');
  ok(rev.haltReason.includes(`${S}/review/review-r2.md`), 'haltReason names the unattested review');
  eq(rev.reviewRounds.length, 1, 'the unattested review\'s round is never recorded');

  const { out: esc } = await run({ ...CLEAN, decide: { ...DECIDE, wrote_file: false, needs_user: true } });
  eq(esc.status, 'BLOCKED (needs user input)', 'a decider escalation keeps its own terminal');
  eq(esc.decisionFile, '', 'and still names no unattested decision file');
}

section('the rubric is a planPath only, the check tool is required, and every role names its file');
{
  const { planPath, ...noRubric } = baseArgs;
  const PLANPATH_REQUIRED = /^args\.planPath is required/;
  const inline = await throwsWith(ENGINE, { args: { ...noRubric, requirements: '## Decision\nWhich cache layer?' }, respond: {} });
  ok(PLANPATH_REQUIRED.test(inline), `an inline requirements arg with no planPath throws the planPath message: ${inline.slice(0, 60)}`);
  const neither = await throwsWith(ENGINE, { args: noRubric, respond: {} });
  ok(PLANPATH_REQUIRED.test(neither), `no rubric at all throws the same message: ${neither.slice(0, 60)}`);
  const { checkTool, ...noTool } = baseArgs;
  for (const bad of [undefined, '', '  ', 42]) {
    const msg = await throwsWith(ENGINE, { args: bad === undefined ? noTool : { ...noTool, checkTool: bad }, respond: {} });
    ok(msg.startsWith('Missing args.checkTool: pass the absolute path of tools/review-check.mjs'), `checkTool ${JSON.stringify(bad)} throws: ${msg.slice(0, 60)}`);
  }

  const { prompt } = await run(CLEAN);
  for (const role of ['research:', 'decide', 'review']) {
    ok(prompt(role).includes(`the requirements at ${planPath}`), `the ${role} prompt names the planPath`);
    ok(!prompt(role).includes('the requirements below'), `the ${role} prompt carries no inline rubric`);
  }
}

section('a solo agent that dies throws — it must never read as a decision nobody made');
{
  const dead = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, decide: null } });
  ok(/Decider returned nothing/.test(dead) && /resumeFromRunId/.test(dead), `dead decider throws with the resume hint: ${dead.slice(0, 50)}`);
  const deadRev = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, review: null } });
  ok(/^Reviewer returned nothing in round 1 \(review r1: agent skipped or died\)/.test(deadRev) && /resumeFromRunId/.test(deadRev), `dead reviewer too: ${deadRev.slice(0, 70)}`);
  const deadRerun = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, check: NO_LOCK, 'review r1 rerun': null } });
  ok(/^Reviewer returned nothing in round 1 \(review r1 rerun: agent skipped or died\)/.test(deadRerun), `a dead rerun names its label: ${deadRerun.slice(0, 70)}`);
  const deadSetup = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, 'check-setup': null } });
  ok(/^Check agent returned nothing before the review in round 1 \(check-setup r1: agent skipped or died\)/.test(deadSetup), `a dead setup throws: ${deadSetup.slice(0, 80)}`);
  const deadVerify = await throwsWith(ENGINE, { args: baseArgs, respond: { ...CLEAN, check: null, 'check-setup': CHECK } });
  ok(/^Check agent returned nothing after the review in round 1 \(check r1: agent skipped or died\)/.test(deadVerify), `a dead verify throws: ${deadVerify.slice(0, 80)}`);
}

section('rejects every round spend the round budget and report it as needs-attention');
{
  const { out, byLabel, logs } = await run({ research: LENS, decide: DECIDE, review: REJECT, check: KEPT }, { ...baseArgs, maxRounds: 3 });
  eq(byLabel('decide').length, 3, 'the loop spun to the bound');
  eq(out.status, 'needs-attention (no agreement within round budget)', 'status');
  ok(out.agreed === false && out.halted === false, 'nothing claims agreement');
  eq(out.rounds, 3, 'and the round count is reported');
  eq(out.reviewRounds?.length, 3, 'one reviewRounds entry per round');
  ok(logs.some((l) => l.includes(`⚠ r3: the reviewer REJECTS (raised 2, withdrawn 1, kept 1, downgraded 0, caveats 0) at the round budget (see ${S}/review/review-r3.md, ${S}/decide/review-r3-final.md)`)), 'the last round logs the budget');
  ok(flat(out.nextStep).includes(`Read the latest ${S}/decide/decision-r3.md + ${S}/review/review-r3.md, ${S}/decide/review-r3-final.md with the user, starting with the kept objections and the WHERE NEXT section of the final review`),
    `nextStep starts the user at the final review: ${flat(out.nextStep).slice(0, 200)}`);
  ok(!/UNDER-SPECIFIED|not RESOLVING/.test(out.nextStep), 'and gives no slug-based churn diagnosis');
  // The two remedies need opposite cache modes: a resume never reads an edited rubric, a restart drops the finished rounds.
  ok(/Refine the requirements, then relaunch with the same args and no resumeFromRunId/.test(out.nextStep)
    && /a resume would replay the cached returns and never read the edit/.test(out.nextStep), 'refining relaunches with no resumeFromRunId');
  ok(/raise maxRounds and relaunch with the same args plus the Workflow tool's resumeFromRunId/.test(out.nextStep)
    && /continues past round 3\./.test(out.nextStep), 'raising maxRounds resumes from cache past the finished round');
}

section('a budget spent on a round that fell back to its blind review names no WHERE NEXT section');
{
  const blindOnly = { ...CHECK, final_line: 'raised 1, withdrawn 0, kept 1, downgraded 0, caveats 0', stage1_verdict: 'reject' };
  for (const [what, check] of [['a lock mismatch', MISMATCH('reject')], ['an unwritten final review', blindOnly]]) {
    const { out } = await run({ ...CLEAN, review: REJECT, check }, { ...baseArgs, maxRounds: 1 });
    const next = flat(out.nextStep ?? '');
    eq(out.status, 'needs-attention (no agreement within round budget)', `${what}: status`);
    ok(next.includes(`Read the latest ${S}/decide/decision-r1.md + ${S}/review/review-r1.md with the user, starting with the objections of the blind review, since the last round left no final review the run could use and so no WHERE NEXT section.`)
      && !next.includes('WHERE NEXT section of the final review'), `${what}: the hand-back starts from the blind review: ${next.slice(0, 220)}`);
  }
}

section('the decider cites what rules out each option it rejects, and what would reverse it, in both selections');
{
  const RULE = 'Each option you rule out, by a non-negotiable or as a runner-up, cites what rules it out and names the one observation that would reverse that.';
  for (const args of [baseArgs, RANKED]) {
    const { byLabel } = await run(CLEAN, args);
    const p = byLabel('decide')[0].prompt.replace(/\s+/g, ' ');
    ok(p.includes(RULE), `${args.selection ?? 'single'}: the decider is told to cite and reverse each ruled-out option`);
  }
}

section('a dead lens researcher is recorded in the return and named in the hand-back');
// One lens of many is auxiliary (#15): its death must not read as a full run that converged over every lens.
{
  const { out } = await run({ ...CLEAN, 'research:simplest': null });
  eq(JSON.stringify(out.failed), JSON.stringify([{ id: 'simplest', stage: 'diverge' }]), 'the dead lens is in failed at the diverge stage');
  ok(!('phase' in out), 'the return has no phase key');
  eq(out.lensFiles.length, 1, 'and only the surviving lens file is listed');
  ok(/left out of the decision: simplest\./.test(out.nextStep), `nextStep names the dropped lens: ${out.nextStep.slice(-120)}`);
  // No arg selects lenses to redo, and a same-runId relaunch overwrites the decision this nextStep presents.
  ok(/relaunch under a new runId/.test(out.nextStep), 'nextStep sends the relaunch to a new runId');
  ok(!/Re-run them with the same runId/.test(out.nextStep), 'and never to a per-lens same-runId re-run');

  const { out: full } = await run(CLEAN);
  eq(JSON.stringify(full.failed), '[]', 'a full run has an empty failed list');
  ok(!/left out of the decision/.test(full.nextStep), 'and no dropped-lens sentence');

  // A halt's relaunch reruns every lens, so the agreed and stalled terminals' relay-first advice does not apply.
  for (const decide of [{ ...DECIDE, needs_user: true }, { ...DECIDE, wrote_file: false }]) {
    const { out: halt } = await run({ ...CLEAN, 'research:simplest': null, decide });
    ok(halt.halted === true, 'a run that drops a lens can still halt');
    ok(/left out of the decision: simplest\./.test(halt.nextStep), `a halt's nextStep names the dropped lens: ${halt.nextStep.slice(-200)}`);
    ok(/relaunch with the same args redoes them/.test(halt.nextStep), 'and says the halt\'s relaunch redoes it');
    ok(!/Relay this run's decision first|new runId/.test(halt.nextStep), 'and never sends a halt to relay first or to a new runId');
  }
}

section('an empty ranked shortlist or a blank chosen replaces the earlier round\'s, never carries it over');
// The return pairs shortlist with decisionFile, which names the LATEST round's file.
{
  const SHORT = { ...DECIDE, shortlist: [{ rank: 2, title: 'redis' }, { rank: 1, title: 'in-process LRU' }] };
  const { out } = await run({
    research: LENS, review: REJECT, check: KEPT,
    decide: (label) => (/r1$/.test(label) ? SHORT : { ...SHORT, chosen: '', shortlist: [] }),
  }, { ...RANKED, maxRounds: 2 });
  eq(out.decisionFile, `${S}/decide/decision-r2.md`, 'the return names round 2\'s decision file');
  eq(JSON.stringify(out.shortlist), '[]', 'and round 2\'s empty shortlist, not round 1\'s');
  eq(out.chosen, '', 'and round 2\'s blank chosen');

  const { out: r1 } = await run({ ...CLEAN, decide: SHORT }, RANKED);
  eq(r1.shortlist.map((s) => s.rank).join(','), '1,2', 'a non-empty shortlist is still sorted by rank');
}

section('an accept over a decision the decider says misses a requirement is flagged');
{
  const { out, logs } = await run({ ...CLEAN, decide: { ...DECIDE, meets_all_requirements: false } });
  eq(out.status, 'decided (the final reviewer accepts the decision)', 'the status is unchanged');
  eq(out.meetsAllRequirements, false, 'the decider\'s attestation is returned');
  ok(logs.some((l) => /the reviewer ACCEPTS but the decider reported meets_all_requirements=false — audit .*decision-r1\.md/.test(l)), 'the contradiction is logged');
  ok(/^The decider itself reported that the conclusion does not meet every requirement: check .*decision-r1\.md before presenting\./.test(out.nextStep), 'nextStep leads with the check');

  const { out: ranked } = await run({ ...CLEAN, decide: { ...DECIDE, meets_all_requirements: false, shortlist: [] } }, RANKED);
  ok(/a shortlisted option does not meet every requirement/.test(ranked.nextStep), 'ranked mode names a shortlisted option');

  const { out: both } = await run({ ...CLEAN, review: REJECT, decide: { ...DECIDE, meets_all_requirements: false } });
  ok(/^The reviewer returned reject while its review keeps no objection: .* The decider itself reported/.test(both.nextStep), 'both audits compose, the reviewer\'s first');

  const { out: ok1 } = await run(CLEAN);
  eq(ok1.meetsAllRequirements, true, 'a met rubric returns true');
}

// ---------------------------------------------------------------------------------------------
// The research loop: open issues go to researchers until they are covered, saturated or capped.
// ---------------------------------------------------------------------------------------------

const ISSUE = { wrote_file: true, new_evidence: true };
const DRY = { ...ISSUE, new_evidence: false };
const opens = (...ids) => ({ ...DECIDE, open_issue_ids: ids });
// The decider names open issues on its first `n` passes, then none.
const openFor = (n, ...ids) => (label) => (Number(label.replace(/^decide r/, '')) <= n ? opens(...ids) : DECIDE);
const researchOf = (out) => ({ rounds: out.research?.rounds, stop: out.research?.stop });

section('open issues run one researcher per slug, and the next decider names every research file of that round');
{
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { out, calls, byLabel, logs } = await run({
      research: LENS, 'research-issue': ISSUE, decide: openFor(1, 'p99-unproven', 'p99-unproven', 'Cost Axis', 'cost-axis', '', 42, '../'), review: ACCEPT, check: CHECK,
    }, args);
    const r1 = calls.filter((c) => c.label.startsWith('research-issue r1 '));
    eq(r1.map((c) => c.label).join(','), 'research-issue r1 p99-unproven,research-issue r1 cost-axis', `${sel}: one researcher per distinct path-safe slug, non-strings and blanks dropped`);
    ok(logs.some((l) => l.includes('open issue "cost-axis" shares research id cost-axis with "Cost Axis" → researched as "Cost Axis" only')),
      `${sel}: an entry the dedupe folds into another is logged by name`);
    ok(logs.some((l) => l.includes('open issue "../" has no letter or digit for a research file name → not researched')), `${sel}: an entry with no path-safe slug is logged`);
    ok(!logs.some((l) => l.includes('open issue "p99-unproven"')), `${sel}: a slug listed twice verbatim is one issue and logs nothing`);
    ok(r1.every((c) => c.group?.kind === 'parallel' && c.opts.phase === 'Research'), `${sel}: the researchers run concurrently in the Research phase`);
    const rp = flat(r1[0]?.prompt);
    ok(rp.includes('the entry "p99-unproven" under `## Open issues` in E:/r/runs/t/decide/decision-r1.md') && rp.includes('E:/r/runs/t/research/r1-p99-unproven.md'),
      `${sel}: the researcher reads its issue in the decision file and writes its own research file`);
    ok(rp.includes('CHECK FOR THE USER: the check to run and the result that would change the answer.'), `${sel}: a question no agent can settle becomes a check for the user`);
    const cost = flat(r1[1]?.prompt);
    ok(cost.includes('the entry "Cost Axis" under `## Open issues`') && cost.includes('WRITE E:/r/runs/t/research/r1-cost-axis.md'),
      `${sel}: the researcher looks up the decider's spelling and writes the path-safe file`);
    const d2 = flat(byLabel('decide r2')[0]?.prompt);
    ok(['research/r1-p99-unproven.md', 'research/r1-cost-axis.md'].every((f) => d2.includes(`E:/r/runs/t/${f}`)), `${sel}: the next decider pass names every research file of the round`);
    ok(d2.includes('REVISE your decision at E:/r/runs/t/decide/decision-r1.md into a complete new file.') && d2.includes('RESEARCH ROUND 1 answered your open issues.'),
      `${sel}: and revises the decision the researchers read`);
    ok(!d2.includes('THE REVIEWER REJECTED'), `${sel}: no review ran yet, so it gets no fold rules`);
    ok(calls.findIndex((c) => c.label === 'decide r2') < calls.findIndex((c) => c.label === 'review r1'), `${sel}: research runs before the review`);
    const rev = flat(byLabel('review r1')[0]?.prompt);
    ok(rev.includes(`${S}/review/ledger-r2.md`) && !rev.includes('research/'), `${sel}: the reviewer reads the latest decision's ledger and no research file`);
    ok(flat(byLabel('check-setup r1')[0]?.prompt).includes(`"decision": "${S}/decide/decision-r2.md"`), `${sel}: and its check reveals the latest decision`);
    eq(JSON.stringify(researchOf(out)), JSON.stringify({ rounds: 1, stop: 'covered' }), `${sel}: the return carries research { rounds, stop }`);
    ok(out.decisionFile.endsWith('decision-r2.md') && out.rounds === 1, `${sel}: two decider passes inside one review round`);
    ok(logs.some((l) => l.includes('research covered (the decider named no open issue) → review')), `${sel}: the log names the stop reason`);
  }
  const { out } = await run({ research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK });
  eq(JSON.stringify(researchOf(out)), JSON.stringify({ rounds: 0, stop: 'covered' }), 'no open issue: no research round, stop covered');
  ok(Array.isArray(out.openIssues) && out.openIssues.length === 0 && out.userChecks === 0, 'and no open issue or check on record');
}

section('research stops saturated after two dry rounds in a row, and the hand-back presents the open issues');
{
  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const { out, labels, logs } = await run({ research: LENS, 'research-issue': DRY, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK }, args);
    eq(labels.filter((l) => l.startsWith('research-issue')).join(','), 'research-issue r1 p99-unproven,research-issue r2 p99-unproven', `${sel}: two dry rounds, then no third`);
    eq(JSON.stringify(researchOf(out)), JSON.stringify({ rounds: 2, stop: 'saturated' }), `${sel}: stop saturated`);
    eq(JSON.stringify(out.openIssues), '["p99-unproven"]', `${sel}: the open issues stay on record`);
    ok(out.agreed === true, `${sel}: the run still goes to review`);
    ok(flat(out.nextStep).includes('Research stopped on saturated (two research rounds in a row found no new evidence) with 1 open issue(s) on record (p99-unproven). Present the `## Open issues` section of E:/r/runs/t/decide/decision-r3.md with the decision'),
      `${sel}: nextStep presents the open issues with the decision: ${flat(out.nextStep).slice(0, 200)}`);
    ok(logs.some((l) => l.includes('research saturated') && l.includes('1 open issue(s) on record: p99-unproven')), `${sel}: the log names the stop and the issues`);
  }
  // One round with new evidence breaks the streak: the dry rounds must be in a row.
  const { out } = await run({
    research: LENS, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK,
    'research-issue': (label) => (label.startsWith('research-issue r2 ') ? ISSUE : DRY),
  }, { ...baseArgs, maxResearchRounds: 10 });
  eq(JSON.stringify(researchOf(out)), JSON.stringify({ rounds: 4, stop: 'saturated' }), 'dry, new, dry, dry: saturated after the fourth round');
}

section('research stops on the cap, run-wide, and maxResearchRounds 0 runs none');
{
  const { out, labels } = await run({ research: LENS, 'research-issue': ISSUE, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK });
  eq(labels.filter((l) => l.startsWith('research-issue')).length, 3, 'the default cap is 3');
  eq(JSON.stringify(researchOf(out)), JSON.stringify({ rounds: 3, stop: 'cap' }), 'stop cap');
  ok(flat(out.nextStep).includes('Research stopped on cap (maxResearchRounds (3) spent) with 1 open issue(s) on record (p99-unproven).'), 'nextStep names the cap');

  const { out: none, labels: noneLabels } = await run({ research: LENS, 'research-issue': ISSUE, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK }, { ...baseArgs, maxResearchRounds: 0 });
  ok(!noneLabels.some((l) => l.startsWith('research-issue')), 'maxResearchRounds 0 runs no research round');
  eq(JSON.stringify(researchOf(none)), JSON.stringify({ rounds: 0, stop: 'cap' }), 'and stops on the cap with the issue on record');

  // A review round restarts the dry streak, while the cap still counts every research round of the run.
  const { out: across, labels: acrossLabels } = await run({
    research: LENS, 'research-issue': DRY, decide: opens('p99-unproven'),
    ...rejectsThrough(1),
  }, { ...baseArgs, maxRounds: 3 });
  eq(acrossLabels.filter((l) => l.startsWith('research-issue')).join(','), 'research-issue r1 p99-unproven,research-issue r2 p99-unproven,research-issue r3 p99-unproven',
    'round 1 saturates after two dry rounds, and round 2 researches again until the run-wide cap');
  eq(JSON.stringify(researchOf(across)), JSON.stringify({ rounds: 3, stop: 'cap' }), 'and the last gate stops on the cap');

  for (const bad of [-1, 'three', 51]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, maxResearchRounds: bad }, respond: {} });
    ok(/^Invalid numeric arg: args\.maxResearchRounds must be a number between 0 and 50/.test(msg), `maxResearchRounds ${JSON.stringify(bad)} throws: ${msg.slice(0, 80)}`);
  }
}

section('a research round launches at most maxResearchers researchers, carries the rest, and the hand-back names them');
{
  const many = Array.from({ length: 12 }, (_, i) => `issue-${i + 1}`);
  const { labels: defaultLabels } = await run({ research: LENS, 'research-issue': ISSUE, decide: openFor(1, ...many), review: ACCEPT, check: CHECK });
  eq(defaultLabels.filter((l) => l.startsWith('research-issue r1 ')).join(','), many.slice(0, 10).map((id) => `research-issue r1 ${id}`).join(','), 'the default cap is 10, and the first 10 issues are researched');

  for (const [sel, args] of [['single', baseArgs], ['ranked', RANKED]]) {
    const capped = { ...args, maxResearchers: 2 };
    const { out, labels, logs, byLabel } = await run({
      research: LENS, 'research-issue': ISSUE, decide: opens('p99-unproven', 'cost-axis', 'ops-burden'), review: ACCEPT, check: CHECK,
    }, capped);
    eq(labels.filter((l) => l.startsWith('research-issue r1 ')).join(','), 'research-issue r1 p99-unproven,research-issue r1 cost-axis', `${sel}: the first maxResearchers issues are researched`);
    ok(logs.some((l) => l === '  ⚠ research r1: 3 open issues, over maxResearchers (2) → researching the first 2, carried: ops-burden'), `${sel}: the carried issue is logged`);
    const d2 = flat(byLabel('decide r2')[0]?.prompt);
    ok(d2.includes('RESEARCH ROUND 1 answered the first 2 of your open issues.') && d2.includes('No researcher took these issues, since a round researches at most 2: ops-burden. Keep each one open under that rule'),
      `${sel}: the next decider pass keeps the carried issue open: ${d2.slice(d2.indexOf('RESEARCH ROUND'), d2.indexOf('RESEARCH ROUND') + 160)}`);
    const d1 = flat(byLabel('decide r1')[0]?.prompt);
    ok(d1.includes('A research round launches at most 2 researchers, one per issue, so merge the issues that one researcher would settle from the same sources or within the same domain into one issue that holds several questions.'),
      `${sel}: the decider is told the cap and the merge rule`);
    ok(d1.includes(`in order of how far each could move ${sel === 'ranked' ? 'rank 1 or an adjacent pair' : 'the winner'}, the furthest first: a round researches the first 2, and the rest stay open for a later round.`),
      `${sel}: and the order rule`);
    const next = flat(out.nextStep);
    ok(next.includes('3 open issue(s) on record (p99-unproven, cost-axis, ops-burden)') && next.includes('The latest decision lists 3 open issues, more than the 2 one research round takes (maxResearchers). The issues past that cap are the ones after the first 2 in that list. The decision may need splitting into narrower decide runs.'),
      `${sel}: nextStep names the carried issue and the split: ${next.slice(0, 200)}`);
    eq(next.split('ops-burden').length - 1, 1, `${sel}: and names the carried issue once`);
    const { out: fits } = await run({ research: LENS, 'research-issue': ISSUE, decide: opens('p99-unproven', 'cost-axis'), review: ACCEPT, check: CHECK }, capped);
    ok(!flat(fits.nextStep).includes('past that cap'), `${sel}: a decision within the cap carries nothing`);
  }
  const { out: unagreed } = await run({ research: LENS, 'research-issue': ISSUE, decide: opens('a', 'b', 'c'), review: REJECT, check: KEPT }, { ...baseArgs, maxResearchers: 2, maxRounds: 1 });
  ok(flat(unagreed.nextStep).includes('on record (a, b, c)') && flat(unagreed.nextStep).includes('The issues past that cap are the ones after the first 2 in that list.'), 'a run with no agreement names the carried issue too');
  const { out: noResearch, labels: noResearchLabels } = await run({ research: LENS, 'research-issue': ISSUE, decide: opens('a', 'b', 'c'), review: ACCEPT, check: CHECK }, { ...baseArgs, maxResearchers: 2, maxResearchRounds: 0 });
  ok(!noResearchLabels.some((l) => l.startsWith('research-issue ')) && flat(noResearch.nextStep).includes('on record (a, b, c)') && flat(noResearch.nextStep).includes('The latest decision lists 3 open issues, more than the 2 one research round takes (maxResearchers). The issues past that cap are the ones after the first 2 in that list.'),
    `a run with no research round names the issues past the cap as a fact about the decision: ${flat(noResearch.nextStep).slice(0, 200)}`);
  const { calls: one } = await run({ research: LENS, 'research-issue': ISSUE, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK });
  ok(!flat(one.find((c) => c.label === 'decide r2')?.prompt).includes('No researcher took these issues'), 'a round within the cap names no carried issue');

  for (const bad of [0, -2, 'ten', 51]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, maxResearchers: bad }, respond: {} });
    ok(/^Invalid numeric arg: args\.maxResearchers must be a number between 1 and 50/.test(msg), `maxResearchers ${JSON.stringify(bad)} throws: ${msg.slice(0, 80)}`);
  }
}

section('a dead researcher throws, and an unconfirmed research file halts before the decider reads it');
{
  const dead = await throwsWith(ENGINE, { args: baseArgs, respond: { research: LENS, 'research-issue': null, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK } });
  ok(/^Researcher returned nothing in research round 1 \(research-issue r1 p99-unproven: agent skipped or died\)/.test(dead) && /resumeFromRunId/.test(dead),
    `a dead researcher throws naming its label: ${dead.slice(0, 90)}`);
  const { out, labels } = await run({ research: LENS, 'research-issue': { ...ISSUE, wrote_file: false }, decide: opens('p99-unproven'), review: ACCEPT, check: CHECK });
  eq(out.status, 'BLOCKED (an agent did not confirm writing its file)', 'an unconfirmed research file halts on the unattested status');
  ok(/research\/r1-p99-unproven\.md in research round 1/.test(out.haltReason), `haltReason names the file: ${out.haltReason}`);
  ok(!labels.includes('decide r2') && !labels.some((l) => l.startsWith('review') || l.startsWith('check')), 'before any decider or reviewer reads it');
  ok(out.decisionFile.endsWith('decision-r1.md'), 'and the return keeps the attested decision');
  eq(out.research?.stop, '', 'research never handed this round\'s decision to review, so the stop is empty');
}

section('a revision after a review that sends an objection to research reaches the next reviewer as one revision');
{
  // Round 2's first pass opens an issue, research settles it, and the round-2 review judges the last pass.
  const { byLabel } = await run({
    research: LENS, 'research-issue': ISSUE, decide: (label) => (label === 'decide r2' ? opens('p99-unproven') : DECIDE),
    ...rejectsThrough(1),
  }, { ...baseArgs, maxRounds: 3 });
  const d3 = flat(byLabel('decide r3')[0]?.prompt);
  ok(d3.includes('RESEARCH ROUND 1 answered your open issues.') && d3.includes('THE REVIEWER REJECTED the decision of review round 1.'),
    'the pass after research still holds the review it is answering');
  ok(flat(byLabel('review r2')[0]?.prompt).includes(`${S}/review/ledger-r3.md`) && flat(byLabel('check-setup r2')[0]?.prompt).includes(`"decision": "${S}/decide/decision-r3.md"`),
    'the round-2 reviewer judges the ledger of the last pass, and its check reveals that decision');
  // A researcher's new evidence is judged against every file of the run before its own round.
  const { byLabel: twice } = await run({ research: LENS, 'research-issue': ISSUE, decide: openFor(2, 'p99-unproven'), review: ACCEPT, check: CHECK });
  const r2 = flat(twice('research-issue r2')[0]?.prompt);
  ok(r2.includes('no earlier file of this run holds: the lens files in E:/r/runs/t/lenses/, E:/r/runs/t/decide/decision-r2.md and the research files E:/r/runs/t/research/r1-p99-unproven.md.'),
    'the round-2 researcher is handed the earlier research file');
  const d3b = flat(twice('decide r3')[0]?.prompt);
  ok(d3b.includes('EARLIER RESEARCH FILES, which the decision you revise cites: - E:/r/runs/t/research/r1-p99-unproven.md'), 'and the decider is handed the earlier rounds\' files');
}

section('the scoring rule: musts pass/fail, wants met / partly met / missed, met only on a cited source, stated once');
{
  const WANT = 'A want scores met only on a cited source or a measurement, and own judgment scores at most partly met.';
  const TOTAL = 'The weighted total counts met as the criterion\'s full weight, partly met as half its weight and missed as zero.';
  for (const args of [baseArgs, RANKED]) {
    const { prompt } = await run({ research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK }, args);
    const d = flat(prompt('decide'));
    ok(d.includes(WANT), `${args.selection ?? 'single'}: the decider cannot score a want met without a cited source`);
    eq(d.split(TOTAL).length - 1, 1, `${args.selection ?? 'single'}: the weighted total rule is stated once`);
    ok(!/0–10|forced to 0/.test(d), `${args.selection ?? 'single'}: the old 0–10 scale is gone`);
    ok(d.includes('`## Open issues`') && d.includes('`## Checks for the user` with the check and the result that would change the answer, and never becomes an open issue again'),
      `${args.selection ?? 'single'}: the decider writes open issues and checks for the user`);
    ok(flat(prompt('research:')).includes(WANT), `${args.selection ?? 'single'}: the lens researchers score on the same rule`);
  }
}

section('checks for the user reach the return and the hand-back');
{
  const { out } = await run({ research: LENS, decide: { ...DECIDE, user_checks: 2 }, review: ACCEPT, check: CHECK });
  eq(out.userChecks, 2, 'the latest decision\'s count is returned');
  ok(out.nextStep.includes('Present the 2 check(s) under `## Checks for the user` in E:/r/runs/t/decide/decision-r1.md: each names the result that would change the answer.'), 'nextStep presents them');
  const { out: junk } = await run({ research: LENS, decide: { ...DECIDE, user_checks: -1 }, review: ACCEPT, check: CHECK });
  eq(junk.userChecks, 0, 'a count that is not a positive integer reads as none');
}

section('the analyst role key is gone: models, efforts and agentTypes take research, decide, review and check');
{
  for (const arg of ['models', 'efforts']) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, [arg]: { analyst: arg === 'models' ? 'sonnet' : 'high' } }, respond: {} });
    ok(msg.includes(`args.${arg} names "analyst"`) && msg.includes('research | decide | review | check'), `${arg}.analyst throws: ${msg.slice(0, 100)}`);
  }
  for (const agentTypes of [{ analyst: 'my-analyst' }, { research: '  ' }, ['my-researcher'], null]) {
    const msg = await throwsWith(ENGINE, { args: { ...baseArgs, agentTypes }, respond: {} });
    ok(msg.startsWith('Invalid agentTypes arg') && msg.includes('research | decide | review | check'), `agentTypes ${JSON.stringify(agentTypes)} throws: ${msg.slice(0, 100)}`);
  }
  const { calls } = await run({ research: LENS, decide: DECIDE, review: ACCEPT, check: CHECK }, { ...baseArgs, agentTypes: { research: 'my-researcher' } });
  const typed = calls.filter((c) => c.opts?.agentType === 'my-researcher').map((c) => c.label);
  ok(typed.length > 0 && typed.every((l) => l.startsWith('research')), `agentTypes.research reaches only the researchers: ${typed.join(', ')}`);
}

await pinRoleMaps({
  engine: ENGINE, name: 'decide', defaults: { research: 'sonnet', decide: 'opus', review: 'opus', check: 'sonnet' },
  runs: [{ args: baseArgs, respond: { research: LENS, 'research-issue': ISSUE, decide: openFor(1, 'p99-unproven'), review: ACCEPT, check: CHECK }, labels: { research: 'research', decide: 'decide', review: 'review', check: 'check' } }],
});

// A relaunch with the same runId finds the earlier launch's files, and the Write tool refuses to overwrite one the agent has not read.
section("every prompt that writes a file says to Read an earlier launch's file first, and a rejected write is not a write");
{
  const single = await run({ research: LENS, 'research-issue': ISSUE, decide: openFor(1, 'p99-unproven'), review: ACCEPT, check: CHECK });
  const ranked = await run({ research: LENS, decide: { ...DECIDE, shortlist: ['in-process LRU'] }, review: ACCEPT, check: CHECK }, RANKED);
  const sites = [
    ['the lens file', single.prompt('research:'), 1, 1],
    ['the research file', single.prompt('research-issue r1'), 1, 1],
    ['the single-choice decision file and ledger', single.prompt('decide'), 2, 1],
    ['the ranked decision file and ledger', ranked.prompt('decide'), 2, 1],
    ['the round 1 blind review', single.prompt('review r1'), 1, 1],
    // The embedded reveal carries the final review's write site, whose heredoc warning the check agent copies.
    ['the check spec, the reveal, the final review it names and the reset', single.prompt('check-setup r1'), 4, 1, 2],
  ];
  pinWriteNotes(sites);
  pinFileWriteNote(sites);
}
