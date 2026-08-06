# Trailhead — MVP components

Three components in build order: the store lands before the screens that read it. Each block is one
gauntlet component; the body is the shape `workflows/gauntlet` builders are handed, unchanged. Only a
`## Component: <id>` header ends the previous block.

## Component: trail-store — the offline trail cache

## Component
A local store that keeps downloaded trails available with no network: read, write, evict by age. No UI
here, and no sync — the screens come next.

## Acceptance Criteria
- A trail written while online is readable with the network disabled.
- Eviction drops trails older than the retention window and nothing newer.
- A corrupt cache entry is discarded and re-fetched rather than thrown at the caller.

## Integration Points
- Exported from `src/store/index.js`; the two screens read trails through it, never through fetch.

## Implementation Steps
1. Write the failing tests against the interface above.
2. Implement the store over IndexedDB with a versioned schema.

## Files
- src/store/trails.js (new)
- src/store/index.js

## Test Strategy
kind: tdd · method: unit
details: npm test -- src/store

## Gate
green

## Component: trail-list — the browse screen

## Component
The list of cached trails: distance, ascent, last-walked, sorted by proximity. The first screen the app
opens on.

## Acceptance Criteria
- With an empty store the screen shows the empty state, not a spinner that never resolves.
- Sorting by proximity is stable when two trails share a distance.

## Integration Points
- Routed at `/`, mounted in `src/app/routes.js`.

## Implementation Steps
1. Build the list component against the store.
2. Wire the route and the empty state.

## Files
- src/screens/trail-list.js (new)
- src/app/routes.js

## Test Strategy
kind: tests-after · method: unit
details: npm test -- src/screens

## Gate
green

## Component: about-panel — the static about panel

## Component
A static panel with version, licence and attribution. No data, no state.

## Acceptance Criteria
- Reachable from the list screen's overflow menu.
- Renders the version string from the build metadata rather than a hardcoded literal.

## Integration Points
- Registered in the overflow menu in `src/screens/trail-list.js`.

## Implementation Steps
1. Add the panel and its menu entry.

## Files
- src/screens/about.js (new)

## Test Strategy
kind: none · method: manual
details: open the app, use the overflow menu, read the version against package.json.

## Gate
build-only
