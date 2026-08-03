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

section('every workflow ships a skill, and every skill is a known workflow');
ok(SKILLS.join(',') === 'brainstorm,debug,decide,docs,enhance,feature,investigate,migrate',
  `skills/ holds exactly the eight workflows — got: ${SKILLS.join(',')}`);

// All eight skills stay model-invocable, so naming a workflow in prose ("use the aipg feature
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
  ok(/\$ARGUMENTS\s*$/.test(body), 'body ends with $ARGUMENTS');
}
