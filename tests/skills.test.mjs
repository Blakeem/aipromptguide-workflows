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

// The three build skills spawn engines that write code and stage work — user-invoked only (the
// Workflow tool's own opt-in rule, enforced structurally instead of by prose). The five generative/
// read-only skills stay model-invocable so "use the aipg docs workflow to gather X" keeps working.
const USER_ONLY = new Set(['feature', 'debug', 'migrate']);

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
  ok(USER_ONLY.has(name) === (fields['disable-model-invocation'] === 'true'),
    USER_ONLY.has(name) ? 'build skill is user-invoked only' : 'generative skill stays model-invocable');
  ok(body.includes('${CLAUDE_PLUGIN_ROOT}'), 'body resolves the plugin root');
  ok(body.includes('${CLAUDE_PLUGIN_DATA}'), 'body resolves the data dir (run-state root)');
  ok(body.includes(`/workflows/${name}/CLAUDE.md`), 'body points at this workflow\'s guide');
  ok(/\$ARGUMENTS\s*$/.test(body), 'body ends with $ARGUMENTS');
}
