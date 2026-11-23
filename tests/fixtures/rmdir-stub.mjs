// Preloaded into a wt child with `node --import`, so every rmdirSync that tools/wt.mjs runs fails as it does on Windows
// for a folder another process holds, which no test can arrange on every platform.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

fs.rmdirSync = (path) => {
  const err = new Error(`EBUSY: resource busy or locked, rmdir '${path}'`);
  err.code = 'EBUSY';
  throw err;
};
// Carries the replacement into the named export that `import { rmdirSync } from 'node:fs'` binds.
syncBuiltinESMExports();
