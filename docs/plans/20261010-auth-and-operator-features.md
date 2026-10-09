# close the admin UI behind a login and finish the operator's day

## Overview

The admin UI is open: anyone who can reach port `3340` operates the parking. The schema for
access control has been there since `001_initial_schema.sql` — `auth_users`, `auth_roles`,
`auth_user_roles`, `auth_sessions`, and an `actor_auth_user_id` column on every history table —
and two read endpoints exist (`/auth/bootstrap-status`, `/admin/users`). What is missing is
everything that writes: password verification, sessions, a guard on the API, and the screens.

This plan closes that, and then spends the access control it just built: the audit trail starts
naming the person who acted instead of an application, and two chores the operator still does
outside the UI — moving someone between places, importing the Excel catalog — move into it.

Nothing here needs an external system. Yandex Messenger (M8), the employee self-service UI (M11,
which needs employee identity and therefore this plan first), CI builds of `apps/admin-ui` and
backup/restore are all out of scope.

**Approach:** the API is secured first and completely — deny by default at the router, so a route
added later is closed unless it says otherwise — and only then does the UI get a login screen. The
order matters: a login screen over an open API is theatre. Expect the whole test layer to need an
authenticated client in Task 3; that is the task's real work, not an afterthought.

## Context

- **files involved:**
  - Create: `apps/api/src/modules/auth/{controller,service,repository}.js` — credentials and sessions
  - Create: `packages/shared/passwords.js` — scrypt hashing, no dependency
  - Create: `packages/shared/multipart.js` — moved from `apps/admin-ui/multipart.js`, used by both
  - Modify: `apps/api/src/router.js` — the guard, and `public: true` on the routes that stay open
  - Modify: `apps/api/src/modules/index.js` — register the auth context
  - Modify: `apps/api/testing/boot-api.js`, `apps/api/testing/fixtures.js`,
    `apps/api/testing/golden-scenarios.js` — every test client now logs in
  - Modify: `apps/admin-ui/server.js` — pass `cookie` through the proxy and `set-cookie` back
  - Create: `apps/admin-ui/src/pages/LoginPage.vue`, `apps/admin-ui/src/pages/UsersPage.vue`
  - Modify: `apps/admin-ui/src/store.js`, `src/App.vue`, `src/api.js`
- **existing patterns:**
  - a bounded context is `modules/<name>/{controller,service,repository}.js`; the controller does
    HTTP only, the service owns the transaction, the repository owns the SQL
  - `apps/admin-ui` specs are `*.spec.js` on vitest; assert the rendered result, never the prop
  - every UI write goes through `submit()` in `store.js`, which shows the API's message on failure
  - design-system traps worth re-reading before writing a screen:
    `ViInput`/`ViSelect` bind with `v-model:value`; `ViSelect` needs `track-by-value` for a
    primitive; `ViModal` needs `use-model` and teleports to `document.body`; `ViTableSimple` hands
    a cell to the `#cell` slot only when it has no `text` key; a `--vi-color-*` token is never
    wrapped in `rgb()`
- **constraints:**
  - no new runtime dependency: `node:crypto` has scrypt and `timingSafeEqual`
  - the 122 golden snapshots stay byte-identical except where a task says otherwise, and the one
    task that changes them (Task 6) regenerates them deliberately and reviews the diff
  - the stand is plain HTTP, so the session cookie cannot be `Secure`; it is `HttpOnly` and
    `SameSite=Lax`, and that limitation is written down rather than silently accepted
- **assumptions:**
  - first-run activation is allowed only while the database holds exactly one auth user and it is
    `invited` — the bootstrap `sysadmin` seeded by `001_bootstrap_system_admin.sql`. After that,
    passwords are set by a `system_admin`. This avoids inventing an invitation-token flow for a
    single-operator system, and the restriction is enforced server-side
  - roles stay the two the seed defines, `system_admin` and `parking_admin`; `parking_admin` may
    use every `/admin/*` route except the user-management ones
  - the Excel import reuses `scripts/import/parking-catalog.js`'s mapping rules; this plan moves
    where it runs, not what it decides

## Development Approach

- **testing approach**: regular — build the behaviour, then cover it, including the refusal paths
- verification command: `npm run test:ui && npm run check && npm run lint && npm test`
- integration command (Tasks 1–3, 6–8): `npm run test:integration` with `DATABASE_URL_TEST` set
- complete each task fully before moving to the next
- **CRITICAL: all checks must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Password credentials and first-run activation

**Files:**
- Create: `packages/shared/passwords.js`, `packages/shared/passwords.test.js`
- Create: `apps/api/src/modules/auth/{controller,service,repository}.js`
- Modify: `apps/api/src/modules/index.js`

- [x] write `packages/shared/passwords.js`: `hashPassword(plain)` and `verifyPassword(plain, stored)` on `node:crypto` scrypt, a random 16-byte salt per hash, `timingSafeEqual` for the comparison, and a stored format that carries its own parameters (`scrypt$N$r$p$salt$hash`) so they can be raised later without invalidating existing hashes
- [x] write unit tests: a hash verifies against its own password, fails against another, two hashes of the same password differ (the salt is real), and a malformed stored value is refused rather than throwing
- [x] add `POST /auth/activate` accepting `{login, password}`: allowed **only** when exactly one row exists in `auth_users` and its status is `invited`; sets the hash, flips status to `active`, writes an audit row
- [x] add the refusal paths: a second activation attempt answers `409`, a password shorter than 10 characters answers `400`, an unknown login answers the same `409` as a wrong state so the endpoint does not enumerate logins
- [x] write integration tests in `apps/api/integration/auth.itest.js` for activation and each refusal
- [x] run `npm run check && npm run lint && npm test` — must pass before task 2

### Task 2: Sessions — login, logout, and who am I

**Files:**
- Modify: `apps/api/src/modules/auth/{controller,service,repository}.js`
- Modify: `apps/api/integration/auth.itest.js`

- [x] add `POST /auth/login`: verifies the password, creates an `auth_sessions` row holding **only** the SHA-256 of the token, sets `pa_session` as `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`, updates `last_login_at`, and answers the user with their roles
- [x] add `GET /auth/me` resolving the cookie to the user and their roles, and `POST /auth/logout` setting `revoked_at` and clearing the cookie
- [x] expire and revoke on read: a session past `expires_at` or with `revoked_at` set resolves to nobody, and a successful resolve bumps `last_seen_at`
- [x] make a wrong password and an unknown login answer the same `401` with the same body and no timing shortcut — the failure path must still run a verify
- [x] write integration tests: login then `/auth/me`, logout then `/auth/me` is `401`, an expired session is `401`, a tampered cookie is `401`
- [x] run `npm run check && npm run lint && npm test` — must pass before task 3

➕ the router now applies a handler's `headers` alongside its payload — `set-cookie` is the
first response header a handler has needed, and `writeHead` in `sendJson` would otherwise have
dropped it. `apps/api/src/support/cookies.js` parses and serializes the cookie; Task 3's guard
reads the request header through the same helper.

➕ `packages/shared/errors.js` maps 401 to `unauthorized` and 403 to `forbidden`, so the
refusals Tasks 2 and 3 add carry a code like every other error payload. No existing endpoint
answers either status, so no golden snapshot moved.

### Task 3: Close the API — deny by default at the router

**Files:**
- Modify: `apps/api/src/router.js`, `apps/api/src/modules/*/controller.js` (route tables)
- Modify: `apps/api/testing/boot-api.js`, `apps/api/testing/fixtures.js`, `apps/api/testing/golden-scenarios.js`

- [x] add session resolution to the router and require it for every route, with `public: true` as the only exemption; mark `/health`, `/health/db`, `/` and the `/auth/*` routes public and nothing else
- [x] require the `system_admin` role for `/admin/users` and the user-management routes added in Task 5; every other `/admin/*` route accepts either role
- [x] answer `401` with the standard error payload when there is no session and `403` when the session lacks the role — never `404`, which would hide the route's existence from an operator who simply lacks a role
- [x] teach `apps/api/testing/boot-api.js` to activate and log in a test operator, and expose the cookie to callers so `fixtures.js` and the golden harness send it on every request
- [x] add a router test asserting that **every** registered route is either `public: true` or reachable only with a session — a new route must not be able to default to open
- [x] run `npm run test:integration` with `DATABASE_URL_TEST` set: all suites green (315/315, twice) — two golden entries regenerated, see the ⚠️ below
- [x] run `npm run check && npm run lint && npm test` — must pass before task 4

➕ `SESSION_COOKIE_NAME` moved from the auth service into `apps/api/src/support/cookies.js`.
Two layers need it now — the auth controller builds the `set-cookie`, the router's guard reads
the request header on every request — and the router must not import a bounded context to
learn how to find a session. The auth service re-exports it, so its callers did not move.

➕ `createApiRouter` now **throws** without a `resolveSession` function rather than defaulting.
A router that cannot resolve a session could only refuse everything or allow everything, and a
wiring mistake would silently produce the second. `apps/api/src/server.js` passes
`services.auth.resolveSession`; the guard reads the cookie and never learns how a session is
stored.

➕ `apps/api/testing/session.js` is a cookie jar keyed by base URL: `startApi` registers the
session it obtained, and `postJson`/`getJson`/`recordRequest` look it up. Threading a cookie
through the ~200 call sites would have stated the same fact 200 times and made every future
test remember it. `{ cookie: null }` opts one call out, which is how the 401 paths are
asserted; `request.anonymous` does the same for a golden scenario.

➕ the deny-by-default test is `apps/api/src/route-access.test.js`, and it asserts two things
rather than one: the set of public routes *exhaustively* (a new `public: true` fails the test
and has to be added to the list in a diff a reviewer sees), and that every other registered
route, driven through a real router whose session store resolves nobody, actually **answers
401** — reachability, not a flag. `GET /auth/me` is the one public route that answers 401 from
its own handler, which is noted there.

⚠️ **two golden entries moved after all, and they had to.** The plan expected zero on the
grounds that authentication changes who may ask rather than what the answer is — true for
every parking endpoint, and all 122 of those are byte-identical. But two endpoints *report the
auth state itself*: `GET /auth/bootstrap-status` and `GET /admin/users` both show the
bootstrap operator, and the harness can only hold a session if that operator is `active` and
has signed in. The regenerated diff is three lines — `authStatus: invited → active` in both,
and `lastLoginAt: null → <timestamp>` — with no identifier renumbering. There is no way to be
authenticated and still record `invited`; the alternative was a production backdoor.

⚠️ **the harness seeds the operator's password in the database instead of calling
`POST /auth/activate`.** Activating over HTTP writes an `auth_user_activated` audit row into
every scratch schema, and the golden suite records the audit journal: that one extra row
consumes an identifier token and renumbers every `<id:N>` after it, which turned the diff
above into 37 changed entries of pure mechanical noise. Activation is the subject of
`auth.itest.js` and is covered there with each of its refusals; what every other suite needs
from the harness is an authenticated client. The sign-in is still the real `POST /auth/login`
against a real scrypt hash — only the one-time password-setting step is seeded.

⚠️ **the four `/bot/*` routes are now closed too**, per "public and nothing else".
`apps/bot-adapter/src/server.js` calls `/bot/departure-plans` and
`/bot/line/blocking-contacts` and will get 401 until it carries a credential. Yandex Messenger
(M8) is out of scope here and the adapter is not in service, so this is deliberate rather than
a regression — but M8 now has a prerequisite it did not have: a service identity for the bot.

### Task 4: The login screen and the session the UI holds

**Files:**
- Modify: `apps/admin-ui/server.js`
- Create: `apps/admin-ui/src/pages/LoginPage.vue`, `apps/admin-ui/src/pages/LoginPage.spec.js`
- Modify: `apps/admin-ui/src/{api.js,store.js,App.vue}`, `apps/admin-ui/src/App.spec.js`

- [x] fix the proxy first: `apps/admin-ui/server.js` forwards only `content-type`, so it must also pass `cookie` upstream and return `set-cookie` downstream — without this the login succeeds and the next request is anonymous
- [x] add `boot()` resolution through `GET /auth/me`: a resolved user renders the app, a `401` renders the login screen, and the bootstrap state from `/auth/bootstrap-status` renders a first-run "set a password" form instead
- [x] build `LoginPage.vue` on `ViCard` + `ViInput` (`type="password"`) + `ViButton`, showing the API's message on refusal and nothing more specific than the API said
- [x] make `api.js` treat a `401` on any call as "the session ended": drop to the login screen rather than leaving a half-loaded day behind an error toast
- [x] show the signed-in operator and a logout control in the header
- [x] write specs: a `401` on boot shows the login screen and not the tab strip, a successful login renders the day, a `401` mid-session returns to the login screen, the first-run form appears only for the bootstrap state
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 5 (130 UI specs, 342 node tests, lint clean, `npm run admin-ui:build` clean)

➕ the proxy fix needed a **behavioural** test, not a stubbed one: a cookie crossing a
process is exactly what a `fetch` stub cannot prove. `apps/admin-ui/server.spec.js` spawns the
real `server.js` against a stub API over the loopback and asserts both directions. It carries
`// @vitest-environment node`, because happy-dom's `fetch` applies the browser's same-origin
policy to a loopback call. The floor-plan upload forwards the cookie too — it is the one
request this server makes on the operator's behalf, and it would otherwise 401 after Task 3.

➕ `App.vue` renders the login screen **instead of** the shell rather than over it: no tab
strip, no page component, so nothing can fetch or flash a day the API has not authorised. The
spec asserts the negative — that boot made exactly two requests, `/auth/me` and
`/auth/bootstrap-status`, and that no tab title is on the screen.

➕ `authStage` is set to `'ready'` *before* the day loads, not after. A signed-in operator
whose day fails to load has a data problem and should see it inside the app; sending them back
to a login form would blame them for something a password cannot fix. The same split applies to
`/auth/me` answering anything other than 401 — the login screen then carries the API's own
message instead of an invitation to sign in.

⚠️ **a design-system trap that cost a test:** `ViInput` decides whether it has an `#error` or
`#note` slot from the slots object it was mounted with, so `<template v-if="mismatch" #error>`
never appears, however the condition changes. The slot must be declared unconditionally with
the `v-if` **inside** it. Added to the trap list in `AGENTS.md`.

### Task 5: Users and roles, for the system administrator

**Files:**
- Modify: `apps/api/src/modules/auth/{controller,service,repository}.js`
- Create: `apps/admin-ui/src/pages/UsersPage.vue`, `apps/admin-ui/src/pages/UsersPage.spec.js`
- Modify: `apps/admin-ui/src/store.js`, `src/App.vue`

- [ ] add the write endpoints behind `system_admin`: create a user with an initial password and roles, set roles, set a new password, disable and re-enable — each writing an audit row naming the actor
- [ ] refuse the two self-inflicted mistakes explicitly: a user may not remove their own `system_admin` role, and may not disable themselves — both `409` with a message that says why
- [ ] revoke a disabled user's sessions in the same transaction, so disabling takes effect now rather than at the next expiry
- [ ] add a `Доступ` tab rendered only for a `system_admin`, listing users with their roles, status and last login, with the four actions
- [ ] write integration tests for the role guard (a `parking_admin` gets `403` on every user-management route) and the two self-inflicted refusals; write UI specs for the tab being absent without the role
- [ ] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 6

### Task 6: Name the person in the audit trail

**Files:**
- Modify: `apps/api/src/modules/*/service.js` (32 call sites), `apps/api/src/modules/audit/repository.js`
- Modify: `apps/api/test/golden/*.json` (deliberate regeneration)

- [ ] thread the resolved session from the router into the services, and write `actor_auth_user_id` on every audit row an operator's request produces — the column has existed since the initial schema and has never been filled
- [ ] replace the hard-coded `actorService: 'admin-web'` with `'admin-ui'` in all 32 places; it names an application that was deleted
- [ ] leave the jobs scheduler's own label alone — a job has no operator, and `actorService` is the only honest answer there
- [ ] show the operator in the `Журнал` tab's «Кто» column, falling back to the service for rows a job wrote
- [ ] regenerate the golden snapshots with `GOLDEN_UPDATE=1 npm run test:golden` and read the diff line by line: only the actor fields may move, and the count of changed entries must match the endpoints an operator can call
- [ ] run `npm run test:integration` twice: stable, and no entry changed beyond the actor fields
- [ ] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 7

### Task 7: Move a reservation between places in one action

**Files:**
- Modify: `apps/api/src/modules/reservations/{controller,service}.js`
- Modify: `apps/admin-ui/src/components/PlaceDrawer.vue` and its spec

- [ ] add `POST /admin/reservations/move` taking `{reservationId, toParkingPlaceId, reason}`, moving the reservation and writing one `parking_movements` row with `movementType: 'manual'` in a single transaction — `insertMovement` in `reservations/repository.js` already exists and is already called by the assignment path
- [ ] refuse with the same rules an assignment obeys: a target that is occupied on that date, archived, or blocked answers `409` naming the blocker, and the move leaves nothing behind
- [ ] return the warnings an assignment returns, so moving a guest in front of an early departure warns exactly as placing one does
- [ ] add «Перевести на другое место» to the place drawer: a `ViSelect` of candidate places plus a reason, posting the new endpoint
- [ ] write integration tests for the happy path (one movement row, not a cancel plus an insert), the three refusals, and the warning; write a UI spec for the posted body
- [ ] run `npm run test:integration` and `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 8

### Task 8: Import the Excel catalog from the UI

**Files:**
- Move: `apps/admin-ui/multipart.js` → `packages/shared/multipart.js` (update both importers)
- Create: `apps/api/src/modules/catalog-import/{controller,service}.js`
- Modify: `apps/admin-ui/src/pages/PlacesPage.vue`, add `CatalogImport.vue` and its spec

- [ ] move the multipart parser into `packages/shared` so the API and the UI server share one; `apps/admin-ui/server.js` imports it from there and `infra/docker/admin-ui.Dockerfile` copies what it needs (the deployment test already asserts this)
- [ ] add `POST /admin/catalog-import` with `dryRun`, reusing the column mapping and validation of `scripts/import/parking-catalog.js` rather than re-deriving them — extract the shared logic instead of copying it
- [ ] make the dry run answer counts and problems: how many places would be created, how many updated, which rows were not understood and why
- [ ] make the apply idempotent on a re-upload of the same file, which is the property the CLI script already has and the one most likely to be lost
- [ ] build the UI: upload on the `Места` tab, preview the counts, then apply — with the preview being a separate, explicit step
- [ ] write integration tests from a generated `.xlsx` (the e2e suite already does this) covering dry run, apply, re-apply, and a malformed file
- [ ] run `npm run test:integration` and `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 9

### Task 9: Verify acceptance criteria

- [ ] verify no `/admin/*` route answers without a session: enumerate the router's table and call each one anonymously
- [ ] verify a `parking_admin` cannot reach any user-management route
- [ ] verify the audit trail names a person for operator actions and a service for job actions
- [ ] run `npm run test:integration` with `DATABASE_URL_TEST` set — all suites green, twice in a row
- [ ] run `npm run admin-ui:build` — no unresolved-font warnings
- [ ] run `npm run test:ui && npm run check && npm run lint && npm test`

### Task 10: Update documentation

- [ ] update `docs/TECHNICAL_README.md`: M7 complete, the Known Gaps entries this plan closes removed, the new `Доступ` tab listed
- [ ] write an ADR for the session design: why a server-side session table rather than a JWT, why the cookie cannot be `Secure` on the stand, and what the first-run activation rule is
- [ ] update `SETUP.md` with the first-run step — the operator sets the bootstrap password before anything else works
- [ ] update `AGENTS.md`: tests now need an authenticated client, and how to get one

## Technical Details

**Password storage.** `scrypt` from `node:crypto`, cost parameters stored alongside the hash so
they can be raised later: `scrypt$16384$8$1$<base64 salt>$<base64 hash>`. Comparison is
`timingSafeEqual` on equal-length buffers. There is no dependency to add and no plaintext anywhere.

**Session token.** 32 random bytes, base64url, sent as the cookie value; the database stores only
`sha256(token)` in `auth_sessions.session_token_hash`, which is already unique-indexed. A database
dump therefore does not hand over live sessions.

**Guard shape.** The router resolves the cookie once per request and attaches
`{ authUser, roles }` to the handler argument. A route is closed unless its table entry says
`public: true`. The test that enumerates the route table is what makes "deny by default" true
rather than aspirational — a route added without thinking is closed, and the test proves it.

**Why the golden snapshots do not move in Task 3.** Authentication changes *who may ask*, not what
the answer is. The harness logs in and sends the cookie, so every recorded payload stays
byte-identical. If one moves, the guard changed a response it should not have touched. Task 6 is
the one task that regenerates them, and only the actor fields may differ.

**Roles.** `system_admin` manages accounts; `parking_admin` runs the parking. The seed
(`packages/db/seeds/001_bootstrap_system_admin.sql`) already creates both roles and the bootstrap
user, whose `password_hash` is a placeholder — which is exactly why activation exists.

## Post-Completion

*No checkboxes here — these need a human or an external system.*

- set the bootstrap password on the stand through the first-run screen, then create a
  `parking_admin` for day-to-day use and stop using `sysadmin` for operations
- put the stand behind TLS if it ever leaves the local network: the session cookie is not
  `Secure`, and on plain HTTP it travels in clear
- decide whether `JWT_SECRET` and `SESSION_SECRET` in `staging/env/app.env` are still needed —
  this design uses neither, and both are still `change-me`
- the employee self-service UI (M11) becomes possible after this plan: it needs an identity for
  the employee, which is the piece that was missing
