// skills/<x>/SKILL.md — the plugin's entry points.
// `claude plugin validate` at the repo root runs MARKETPLACE-mode only (source "./" makes plugin root
// == marketplace root), so broken skill frontmatter passes it green and only fails at load time — with
// every frontmatter field silently dropped. This is the check that holds: YAML here is one flat map of
// double-quoted scalars, asserted as such so an unquoted `: ` inside a description can never recur.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, section, ok } from './harness.mjs';

const SKILLS_DIR = join(REPO_ROOT, 'skills');
const SKILLS = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
// The two workflows that take a changePolicy.
const POLICY_SKILLS = ['debug', 'develop'];

section('every workflow ships a skill, and every skill is a known workflow');
ok(SKILLS.join(',') === 'brainstorm,debug,decide,develop,docs,enhance,investigate,refine',
  `skills/ holds exactly the eight workflows — got: ${SKILLS.join(',')}`);

// All eight skills stay model-invocable, so naming a workflow in prose ("use the aipg develop
// workflow on X") is enough — no slash command required. The Workflow tool's opt-in rule is carried
// by each description's "Use only when the user explicitly asks" clause. The build skills used to set
// disable-model-invocation instead, but that flag also hides the skill from the model's context, so
// the model could not even recognize the workflow's name when the operator called it out.

for (const name of SKILLS) {
  section(`skills/${name}/SKILL.md frontmatter is well-formed`);
  const src = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
  ok(!src.includes('\r'), 'LF only');
  const m = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  ok(m !== null, 'has a frontmatter block');
  if (!m) continue;
  const [, fm, body] = m;
  const fields = {};
  for (const line of fm.split('\n')) {
    // One flat map, every value a double-quoted scalar ending at line end — the shape that cannot
    // mis-parse. An unquoted value with `: ` inside (e.g. "— diverge: one…") loads as EMPTY metadata.
    const kv = line.match(/^([a-z-]+): "([^"]*)"$/);
    ok(kv !== null, `frontmatter line is a double-quoted scalar: ${line}`);
    if (kv) fields[kv[1]] = kv[2];
  }
  ok(!!fields.description, 'description present (the invocation gate)');
  ok(!!fields['argument-hint'], 'argument-hint present');
  ok(!('disable-model-invocation' in fields),
    'skill stays model-invocable (the opt-in gate lives in the description prose)');
  ok(body.includes('${CLAUDE_PLUGIN_ROOT}'), 'body resolves the plugin root');
  ok(body.includes('${CLAUDE_PLUGIN_DATA}'), 'body resolves the data dir (run-state root)');
  ok(body.includes(`/workflows/${name}/CLAUDE.md`), 'body points at this workflow\'s guide');
  // The Workflow tool refuses a scriptPath the session cannot already read, and a plugin cannot grant
  // itself its own folder.
  const accessCheck = body.indexOf('node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check');
  const handover = body.indexOf(`Read \`\${CLAUDE_PLUGIN_ROOT}/workflows/${name}/CLAUDE.md\` and follow it exactly`);
  ok(handover >= 0, 'body hands over to this workflow\'s guide');
  ok(accessCheck >= 0 && accessCheck < handover,
    'body runs the plugin-access check before it hands over to the guide');
  const policyCheck = body.indexOf('node "${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs" check --root "${CLAUDE_PLUGIN_DATA}" --repo');
  if (POLICY_SKILLS.includes(name)) {
    ok(policyCheck > accessCheck && policyCheck < handover,
      'body runs the project-settings check after the plugin-access check and before it hands over to the guide');
    // The working directory may be a repo other than the one the run works on.
    ok(body.includes('--root "${CLAUDE_PLUGIN_DATA}" --repo <target.repo>`'),
      'the check reads the policy of the run\'s target.repo');
    ok(body.replace(/\s+/g, ' ').includes('When the task does not name that repo, ask the user for it'),
      'body asks the user for a target.repo the task does not name, in place of the working directory\'s repo');
    ok(body.includes('`${CLAUDE_PLUGIN_ROOT}/workflows/develop/CLAUDE.md` §4 "Choosing the change policy"'),
      'body follows the develop guide\'s policy procedure on the check\'s output');
    ok(body.includes('- Project-settings tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs`'),
      'the path list maps the guide\'s project-settings tool');
    // Only develop commits, so debug runs no commit step.
    const commitCheck = body.indexOf('node "${CLAUDE_PLUGIN_ROOT}/tools/project-settings.mjs" commit --root "${CLAUDE_PLUGIN_DATA}" --repo <target.repo>');
    if (name === 'develop') {
      ok(commitCheck > policyCheck && commitCheck < handover, 'body settles commit mode after the change policy and before it hands over to the guide');
      ok(body.includes('§4 "Choosing commit mode"'), 'body follows the develop guide\'s commit mode procedure on the commit verb\'s output');
      ok(body.includes('- Attribution tool (operator-side): `${CLAUDE_PLUGIN_ROOT}/tools/attribution.mjs`'),
        'the path list maps the guide\'s attribution tool');
    } else {
      ok(commitCheck < 0, 'body runs no commit step, since this workflow does not commit');
    }
  } else {
    ok(policyCheck < 0, 'body runs no project-settings check, since this workflow takes no change policy');
  }
  ok(/\$ARGUMENTS\s*$/.test(body), 'body ends with $ARGUMENTS');
}
