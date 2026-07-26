// Test runner. `node tests/run.mjs` — exit 0 green, 1 red. No dependencies, no config.
// This IS the project's build+test gate: point args.gates.build/test at it when running a workflow
// against this repo.
//
// Add a case: edit the matching tests/<engine>.test.mjs (or add a new one — it is picked up
// automatically). See tests/README.md.

import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { results, setFile } from './harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const only = process.argv[2];   // optional substring filter: `node tests/run.mjs migrate`

const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!files.length) {
  console.error(only ? `no test file matches "${only}"` : 'no *.test.mjs files found in tests/');
  process.exit(1);
}

for (const f of files) {
  console.log(`\n${f}`);
  setFile(f);
  try {
    await import(pathToFileURL(`${HERE}${f}`).href);
  } catch (e) {
    results.failed++;
    results.failures.push(`${f} :: threw before/while running :: ${e.message}`);
    console.log(`    ✗ FAIL the test file itself threw: ${e.message}`);
  }
}

const total = results.passed + results.failed;
console.log(`\n${'-'.repeat(60)}`);
if (results.failed) {
  console.log(`FAILED — ${results.failed} of ${total} assertions:\n`);
  for (const f of results.failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`OK — ${total} assertions passed across ${files.length} file(s)`);
