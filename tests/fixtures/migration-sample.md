# Port the reporting module off moment.js

Ordered by dependency: the shim lands before the call sites that use it.

## Section: date-shim — a Temporal-backed replacement for the moment helpers

gate: green
test_selector: test/date/shim.test.js
depends_on: -

### Acceptance Criteria
- `formatDate`, `parseDate` and `addDays` match moment's output for the twelve cases in the fixture.
- A naive date string with no timezone is interpreted as UTC, as moment did.

### Integration Points
- Exported from `src/date/index.js`; nothing imports `moment` through this module afterwards.

### Implementation Steps
1. Write the parity tests against moment's current output.
2. Implement the three helpers on Temporal.

### Files
- src/date/shim.js (new)
- src/date/index.js

### Test Strategy
kind: tdd · method: unit
details: node --test test/date/shim.test.js

## Section: report-callsites — convert the 14 report builders

gate: green
test_selector: test/reports/
depends_on: date-shim

### Acceptance Criteria
- No file under `src/reports/` imports moment.
- Every existing report test still passes unchanged.

### Integration Points
- All 14 builders in `src/reports/*.js`, plus the two in `src/exports/`.

### Implementation Steps
1. Replace each `moment(...)` call with the shim equivalent.
2. Delete the now-unused moment import from each file.

### Files
- src/reports/*.js
- src/exports/csv.js
- src/exports/pdf.js

### Test Strategy
kind: tests-after · method: unit
details: node --test test/reports/

## Section: drop-moment — remove the dependency

gate: build-only
test_selector:
depends_on: report-callsites

### Acceptance Criteria
- `moment` is absent from package.json and the lockfile.
- A repo-wide grep for `require('moment')` and `from 'moment'` returns nothing.

### Integration Points
- package.json, the lockfile.

### Implementation Steps
1. Remove the dependency and regenerate the lockfile.
2. Grep to confirm no call site survives.

### Files
- package.json

### Test Strategy
kind: none · method: manual
details: npm ci then npm run build; the grep above returns nothing.
