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
// The two workflows that build code, which ask every setup answer through the onboarding tool.
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
  // itself its own folder. The onboarding check asks for that access along with the build settings.
  const accessCheck = body.indexOf('node "${CLAUDE_PLUGIN_ROOT}/tools/plugin-access.mjs" check');
  const onboardCheck = body.indexOf('node "${CLAUDE_PLUGIN_ROOT}/tools/onboard.mjs" check --root "${CLAUDE_PLUGIN_DATA}" --repo <target.repo>`');
  const handover = body.indexOf(`Read \`\${CLAUDE_PLUGIN_ROOT}/workflows/${name}/CLAUDE.md\` and follow it exactly`);
  ok(handover >= 0, 'body hands over to this workflow\'s guide');
  if (POLICY_SKILLS.includes(name)) {
    ok(onboardCheck >= 0 && onboardCheck < handover,
      'body runs the onboarding check on the run\'s target.repo before it hands over to the guide');
    ok(accessCheck < 0, 'body runs no separate plugin-access check, since the onboarding check asks for access');
    // The working directory may be a repo other than the one the run works on.
    ok(body.replace(/\s+/g, ' ').includes('When the task does not name that repo, ask the user for it'),
      'body asks the user for a target.repo the task does not name, in place of the working directory\'s repo');
    ok(body.replace(/\s+/g, ' ').includes('ask the questions it prints in one AskUserQuestion call and run the save command it prints'),
      'body asks the printed questions together and saves the answers');
    for (const [label, tool] of [['Onboarding', 'onboard'], ['Project-settings', 'project-settings'], ['Worktree', 'wt']]) {
      ok(body.includes(`- ${label} tool (operator-side): \`\${CLAUDE_PLUGIN_ROOT}/tools/${tool}.mjs\``),
        `the path list maps the guide's ${tool} tool`);
    }
  } else {
    ok(accessCheck >= 0 && accessCheck < handover,
      'body runs the plugin-access check before it hands over to the guide');
    ok(onboardCheck < 0, 'body runs no onboarding check, since this workflow builds no code');
  }
  ok(/\$ARGUMENTS\s*$/.test(body), 'body ends with $ARGUMENTS');
}
