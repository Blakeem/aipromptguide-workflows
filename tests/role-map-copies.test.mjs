// Every engine holds its own copy of develop's roleMap and agentTypeMap functions and its two value sets,
// since an engine cannot import. A copy that drifts would accept a model, effort or agent type key that
// develop rejects, or the reverse.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINES, REPO_ROOT, section, ok } from './harness.mjs';

const DEVELOP = ENGINES[0];

/** The roleMap and agentTypeMap functions and the two value-set lines of one engine's source, or null for a part it lacks. */
function rolePartsOf(src) {
  const fn = src.match(/^const roleMap = [\s\S]*?\n\};\n/m);
  const types = src.match(/^const agentTypeMap = [\s\S]*?\n\};\n/m);
  const models = src.match(/^const VALID_MODELS = .*$/m);
  const efforts = src.match(/^const VALID_EFFORTS = .*$/m);
  return { roleMap: fn?.[0] ?? null, agentTypeMap: types?.[0] ?? null, VALID_MODELS: models?.[0] ?? null, VALID_EFFORTS: efforts?.[0] ?? null };
}
const sourceOf = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');

section('every engine holds develop\'s roleMap and agentTypeMap functions and value sets, byte for byte');
{
  const reference = rolePartsOf(sourceOf(DEVELOP));
  for (const [part, text] of Object.entries(reference)) ok(text !== null, `develop holds ${part}`);
  for (const rel of ENGINES.slice(1)) {
    const copy = rolePartsOf(sourceOf(rel));
    for (const part of Object.keys(reference)) ok(copy[part] === reference[part], `${rel} holds develop's ${part}`);
  }
}

section('a copy that differs from develop in one word is caught');
// Proves the comparison above can fail: each mutated copy of develop's source must differ from develop's parts.
{
  const reference = rolePartsOf(sourceOf(DEVELOP));
  const src = sourceOf(DEVELOP);
  const mutations = [
    ['roleMap', src.replace('Unknown role key in a role map', 'Unknown role key')],
    ['roleMap', src.replace('ROLE_KEYS.includes(role)', 'role in M')],
    ['agentTypeMap', src.replace('!keys.includes(role) || ', '')],
    ['VALID_MODELS', src.replace("'fable'", "'gpt'")],
    ['VALID_EFFORTS', src.replace("'xhigh', ", '')],
  ];
  for (const [part, mutated] of mutations) {
    ok(mutated !== src, `the mutation for ${part} changed the source`);
    ok(rolePartsOf(mutated)[part] !== reference[part], `a copy with a changed ${part} differs from develop's`);
  }
}
