# Session handling roadmap

Three bounded features in dependency order. Each block below is one `feature-cycle` plan: the body is
the standard plan shape from `workflows/feature/CLAUDE.md` §4, unchanged. Only the `## Plan: <id>`
header is new, and it is the only thing that ends the previous block.

## Plan: session-store — redis-backed session table

## Feature
A `SessionStore` that persists sessions in redis with a TTL, replacing the in-process Map that loses
every session on restart. Read/write/delete only; no login logic here.

## Acceptance Criteria
- `store.put(id, data, ttlSeconds)` round-trips through `store.get(id)`.
- A key past its TTL returns `null` rather than stale data.
- `store.delete(id)` is idempotent: deleting an absent id resolves without throwing.
- Restarting the process does not lose a live session.

## Integration Points
- Exported from `src/session/index.js` so callers stop importing the Map directly.
- Registered in the DI container in `src/container.js` under `sessionStore`.
- Redis URL read from `REDIS_URL` and validated at startup in `src/config.js`.

## Implementation Steps
1. Write the failing tests first, against the interface above.
2. Add `src/session/store.js` with the redis client wired through the container.
3. Delete the in-process Map and repoint its two call sites.

## Files
- src/session/store.js (new)
- src/session/index.js
- src/container.js
- src/config.js

## Test Strategy
kind: tdd
unit: true
method: unit
details: node --test test/session/store.test.js — run against a local redis on 6379, one file per
invocation so the runner cannot silently skip a selector.

## Gate
green

## Plan: login-endpoint — POST /session

## Feature
A login endpoint that verifies credentials and mints a session through the store from the previous
plan. Sets an httpOnly cookie; returns 401 on a bad password without leaking which field was wrong.

## Acceptance Criteria
- Valid credentials return 201 with a `Set-Cookie: sid=...; HttpOnly; SameSite=Lax`.
- An unknown user and a wrong password are indistinguishable in status, body and timing.
- The minted session id is present in the store immediately after the response.
- Five failed attempts from one IP inside a minute return 429.

## Integration Points
- Route mounted at `POST /session` in `src/routes/index.js`.
- Rate limiter registered in the same router, before the handler.

## Implementation Steps
1. Add the handler with argon2 verification against the existing users table. The cookie shape is:

   ```
   Set-Cookie: sid=<id>; HttpOnly; SameSite=Lax; Max-Age=1209600
   gate: build-only
   ## Plan: not-a-real-plan — a fenced example, not a block boundary
   ```

2. Mount the route and the limiter.
3. Add the tests, including the timing-equivalence case.

## Files
- src/routes/session.js (new)
- src/routes/index.js

## Test Strategy
kind: tests-after
unit: true
method: unit
details: node --test test/routes/session.test.js

## Gate
green

## Plan: logout-endpoint — DELETE /session

## Feature
Logout: delete the session server-side and expire the cookie. Deliberately no test beyond the build,
because the behaviour is two calls into code the previous two plans already cover.

## Acceptance Criteria
- `DELETE /session` removes the id from the store and returns 204.
- The response expires the cookie (`Max-Age=0`).
- Called without a cookie it still returns 204 rather than 401.

## Integration Points
- Route mounted at `DELETE /session` in `src/routes/index.js`, beside the login route.

## Implementation Steps
1. Add the handler.
2. Mount it.

## Files
- src/routes/session.js
- src/routes/index.js

## Test Strategy
kind: none
unit: false
method: manual
details: curl -i -X DELETE localhost:3000/session with and without a cookie; confirm 204 and Max-Age=0.

## Gate
build-only
