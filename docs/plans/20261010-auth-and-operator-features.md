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
  - Create: `packages/domain/catalog-rows.js` — the catalog row mapping lifted out of
    `scripts/import/parking-catalog.js`, so the CLI and the upload endpoint decide a row alike
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
- integration command (Tasks 1–3, 6–10): `npm run test:integration` with `DATABASE_URL_TEST` set
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

- [x] add the write endpoints behind `system_admin`: create a user with an initial password and roles, set roles, set a new password, disable and re-enable — each writing an audit row naming the actor
- [x] refuse the two self-inflicted mistakes explicitly: a user may not remove their own `system_admin` role, and may not disable themselves — both `409` with a message that says why
- [x] revoke a disabled user's sessions in the same transaction, so disabling takes effect now rather than at the next expiry
- [x] add a `Доступ` tab rendered only for a `system_admin`, listing users with their roles, status and last login, with the four actions
- [x] write integration tests for the role guard (a `parking_admin` gets `403` on every user-management route) and the two self-inflicted refusals; write UI specs for the tab being absent without the role
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 6 (142 UI specs, 349 node tests, lint clean, 333/333 integration twice, `npm run admin-ui:build` clean)

➕ the five writes are `POST /admin/users`, `/admin/users/{roles,password,disable,enable}`, and
they live in the **auth** context while the list `GET /admin/users` stays in `system`. The read
predates authentication and is pinned by a golden snapshot at that path; moving it would have
changed nothing an operator sees and reshuffled a snapshot for no reason. None of the five is
`advertise`d, so the endpoint index at `GET /` — and `health.json` with it — is byte-identical.

➕ **a user must hold at least one role, enforced on both writes with `400`.** Task 3's guard
reads a closed route with no `roles` list as "any signed-in operator", so an account with an
empty role set would have reached every `/admin/*` route except these five. "No access" is
`disabled`, not a user with no roles — otherwise the role editor would quietly be a way to
grant full parking access.

➕ setting a password on an `invited` user **activates** them, and on a `disabled` user does
not. Leaving `invited` alone would hand the operator a credential that cannot sign in (login
requires `active`), while a disabled account is not being stopped by its password. A password
change deliberately does **not** revoke sessions: an administrator rotating their own password
would log themselves out mid-action. Disabling is the operation that closes sessions, and the
UI says so.

➕ the UI's refusals are the API's. `allowedTabs()` hides the `Доступ` tab without the role and
`enterApp()` drops a pasted `?view=access` back to the day, but the screen never re-checks a
rule: the two self-inflicted refusals are server-side and the table carries a line saying what
they are, so a `409` reads as a rule rather than a bug. An account write reloads the account
list, not the parking day — `submitUser()` beside `submit()`, both on one `postAndReload`.

⚠️ **a design-system trap worth the note:** `ViCheckbox` toggles on the input's `change` event,
not on a click, and with an array `model-value` it emits the **whole new array**. A spec that
triggers `click` on the box changes nothing and passes for the wrong reason. The screen hands
the event to a `toggleRole` that recomputes the set itself, so the checked box and the posted
list cannot disagree whatever the component emits. Added to the trap list in `AGENTS.md`.

### Task 6: Name the person in the audit trail

**Files:**
- Modify: `apps/api/src/modules/*/service.js` (32 call sites), `apps/api/src/modules/audit/repository.js`
- Modify: `apps/api/test/golden/*.json` (deliberate regeneration)

- [x] thread the resolved session from the router into the services, and write `actor_auth_user_id` on every audit row an operator's request produces — the column has existed since the initial schema and has never been filled
- [x] replace the hard-coded `actorService: 'admin-web'` with `'admin-ui'` in all 32 places; it names an application that was deleted
- [x] leave the jobs scheduler's own label alone — a job has no operator, and `actorService` is the only honest answer there
- [x] show the operator in the `Журнал` tab's «Кто» column, falling back to the service for rows a job wrote
- [x] regenerate the golden snapshots with `GOLDEN_UPDATE=1 npm run test:golden` and read the diff line by line: only the actor fields may move, and the count of changed entries must match the endpoints an operator can call (25 lines, all `actorService`, all in `jobs.json`; no `<id:N>` renumbered)
- [x] run `npm run test:integration` twice: stable, and no entry changed beyond the actor fields (340/340 twice)
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 7 (147 UI specs, 357 node tests, lint clean, `npm run admin-ui:build` clean)

**the shape:** `apps/api/src/support/actor.js` is the one place that turns the router's
`authUser` into the two columns `audit_logs` has for the question. A controller builds
`requestActor(context)` and hands it to the service; the service spreads `auditActor(actor)`
into its insert. Nothing else about the session reaches a service — it cannot read the roles
or touch `auth_sessions`, because naming the actor is all it is entitled to do.

➕ **two more sites named the deleted application, and were not `actorService`:**
`job_runs.actor_service` was the SQL literal `'admin-web'` in `jobs/repository.js` (now a
parameter, so an operator-started run records the operator's application and a scheduled one
records `jobs`), and `parking_places.catalog_source` was `'admin-web'` in
`place-lines/repository.js` (now `'admin-ui'`). `place_releases.created_via = 'admin_web'` was
deliberately **left alone**: it is an exposed API field (`payload.release.createdVia`) that
integration tests and golden snapshots assert, so changing it would move a payload beyond the
actor fields, which this task forbids.

⚠️ **the jobs scheduler cannot reach the API since Task 3, and this task does not fix it.**
`apps/jobs/src/scheduler.js` posts to `/admin/jobs/*` with no cookie, and those routes are
closed — every scheduled run now answers `401`. Task 6's job is to name the actor, and it does:
the `jobs` fallback in `support/actor.js` is what a run with no session records, so the shape is
ready. But giving the scheduler a way *in* means a service account or a shared secret, which is
a design decision this plan never took. It needs its own task before the stand's 07:00 and 19:00
jobs work again.

### Task 7: Move a reservation between places in one action

**Files:**
- Modify: `apps/api/src/modules/reservations/{controller,service}.js`
- Modify: `apps/admin-ui/src/components/PlaceDrawer.vue` and its spec

- [x] add `POST /admin/reservations/move` taking `{reservationId, toParkingPlaceId, reason}`, moving the reservation and writing one `parking_movements` row with `movementType: 'manual_reassign'` in a single transaction — **not** `'manual'`, which is not a member of the `movement_type` enum (`001_initial_schema.sql:15`); do not extend the enum, `manual_reassign` already means this — `insertMovement` in `reservations/repository.js` already exists and is already called by the assignment path
- [x] refuse with the same rules an assignment obeys: a target that is occupied on that date, archived, or blocked answers `409` naming the blocker, and the move leaves nothing behind
- [x] return the warnings an assignment returns, so moving a guest in front of an early departure warns exactly as placing one does
- [x] add «Перевести на другое место» to the place drawer: a `ViSelect` of candidate places plus a reason, posting the new endpoint
- [x] write integration tests for the happy path (one movement row, not a cancel plus an insert), the three refusals, and the warning; write a UI spec for the posted body
- [x] run `npm run test:integration` and `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 8 (348/348 integration, 151 UI specs, 358 node tests, lint clean, no golden moved)

**the shape:** the move updates `reservations.parking_place_id` in place, so the id, the source
and the request it answers survive, and `parking_movements` gets one row with both
`from_parking_place_id` and `to_parking_place_id` (and the operator in `actor_auth_user_id`).
It takes the same per-date advisory lock a manual assignment takes, and checks the target in
the order archived → blocked → taken → not released; each `409` carries a `blocker` object
naming what stood in the way. The route is not advertised in the `GET /` index, like Task 5's
account routes, so `health.json` does not move.

➕ **a fourth refusal, not released for the date.** The assignment rule this mirrors requires an
active release on the target; without it the owner would arrive to find someone on their place.

➕ **a moved holder's line position is cleared.** A `line_occupancy` row tied to the reservation
at the old place would claim they still stand there; the move deletes it and audits the count,
and the holder reports the new position afresh.

### Task 8: Share the import logic without changing what it decides

A refactor with no new behaviour, kept separate on purpose: the one way to get this wrong is to
leave the old rules in place and write a second copy beside them, and a copy passes every test
while quietly forking what the importer decides. Splitting the move from the feature is what makes
that visible in review.

**Files:**
- Move: `apps/admin-ui/multipart.js` → `packages/shared/multipart.js` (update both importers)
- Create: `packages/domain/catalog-rows.js` and its test — the pure row mapping lifted out of the script
- Modify: `scripts/import/parking-catalog.js` — imports what was lifted, keeps no copy
- Modify: `infra/docker/admin-ui.Dockerfile`

- [x] move the multipart parser into `packages/shared`: it is ESM today because `apps/admin-ui` is `"type": "module"`, while `packages/shared` is CJS — convert it to `module.exports = { parseMultipartFormData, readRawBody }`, which Node's named-export interop keeps working for `server.js`'s `import { ... }`, and prove the UI server still starts and still parses an upload with a test rather than by eye
- [x] update `infra/docker/admin-ui.Dockerfile`, which names `apps/admin-ui/multipart.js` in the `COPY` at line 41: miss this and the image builds fine and then cannot start
- [x] lift the pure row mapping out of `scripts/import/parking-catalog.js` — `clean`, `normalizeFloor`, `normalizeCode`, `inferPositionHint`, `isGuest`, `rowToPlace` (lines 17–96) — into `packages/domain/catalog-rows.js`, and make the script import them; the script must keep **no** copy
- [x] write unit tests for the lifted mapping on rows shaped like the real sheet (see `CATALOG_ROWS` in `apps/api/integration/e2e-day.itest.js:63`): a guest row, a closed-assignment row, a position word that becomes a hint and is then discarded, a row with no hint, and a row that must be refused
- [x] leave `importPlaces` (the staged upsert, lines 124–335) where it is — moving the SQL is Task 9's problem, and mixing it in here is what makes a refactor unreviewable
- [x] the proof that nothing changed is the e2e suite: it already writes a catalog workbook and imports it, so `apps/api/integration/e2e-day.itest.js` must stay green with no edit to its assertions
- [x] run `npm run test:integration` and `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 9, and no golden snapshot may move, because no endpoint answers anything new yet (348/348 integration, 154 UI specs, 379 node tests, lint clean, `npm run admin-ui:build` clean, no golden snapshot touched)

➕ `infra/deployment.test.js` guarded the old flat image layout: it only read `from './x'`
imports and only checked that the Dockerfile named them. It now resolves every relative import
of `server.js` against the repo root and asserts the runtime stage copies each one **to the same
depth** — the image mirrors the repository tree, because a module copied elsewhere resolves
above the image root and the container exits at startup after a build that looked fine.

➕ `rowToPlace(row, source)` takes `{ sourceFile, sourceSheet }` as an argument: in the script
those were module-level constants read from the environment, which a pure function may not do.
The CLI passes exactly what it passed before, so the metadata it writes is unchanged.

⚠️ `packages/domain/catalog-rows.js` is deliberately **not** added to `packages/domain/index.js`:
`clean` and `normalizeCode` are too generic for the barrel every service imports from. It is
required by path, the way `apps/api/src/services/availability.js` requires `guest-reserve`.

### Task 9: Import the Excel catalog from the UI

**Files:**
- Create: `apps/api/src/modules/catalog-import/{controller,service}.js`
- Modify: `scripts/import/parking-catalog.js` — the CLI becomes a thin caller of the service's logic
- Modify: `apps/admin-ui/src/pages/PlacesPage.vue`, add `CatalogImport.vue` and its spec

- [x] add `POST /admin/catalog-import` taking the workbook as multipart plus a `dryRun` flag, mapping rows through `packages/domain/catalog-rows.js` from Task 8 — the endpoint decides nothing about a row that the CLI does not already decide
- [x] move the staged upsert into the module's service so the endpoint and the CLI run the same transaction; the CLI keeps its own argument and connection handling and nothing else
- [x] make the dry run answer counts and problems — how many places would be created, how many updated, which rows were not understood and why — and write nothing, in a transaction that rolls back rather than a code path that merely avoids writing
- [x] make the apply idempotent on a re-upload of the same file, which is the property the CLI already has and the one most likely to be lost (asserted on the rows, not on a count: a re-import must not recreate a place, or every reservation pointing at its id would be orphaned)
- [x] build the UI: upload on the `Места` tab, preview the counts, then apply — the preview being a separate, explicit step
- [x] write integration tests from a generated `.xlsx` covering dry run (and that it wrote nothing), apply, re-apply changing nothing, and a malformed file; write a UI spec for the two-step flow
- [x] run `npm run test:integration` and `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 10 (359/359 integration, 159 UI specs, 386 node tests, lint clean, `npm run admin-ui:build` clean, no golden snapshot touched)

➕ The staged upsert went into `apps/api/src/modules/catalog-import/repository.js` rather than
into the service: it is ~200 lines of SQL, and ADR 003 puts SQL in the repository. The service
owns the transaction and the dry run's rollback, which is the layer rule, not an exception to it.

➕ `dryRun` defaults to **true** — only the exact string `false` writes. A caller that forgets
the flag gets a report, not a rewritten catalog, which is the direction this particular mistake
has to fall: the catalog is every place's title, line and role.

➕ `mapCatalogRows(rows, source)` joined `packages/domain/catalog-rows.js`, and `rowToPlace` is
now a thin reader of the same `classifyRow`. The refusal reasons had to become *data* for the UI
to show which rows were dropped and why, and a second copy of the conditions that refuse a row
is exactly what Task 8 existed to prevent.

➕ The endpoint refuses a workbook that is not a zip (`PK` signature) before handing it to
`xlsx.read`: the library parses arbitrary text into a one-sheet workbook called `Sheet1`, so a
renamed `.txt` would otherwise be refused with "Sheet not found: Лист1" and send the operator
looking for the wrong mistake. A valid workbook that maps to no place at all is a 400 too, with
the problem rows, rather than a 200 that applies nothing.

⚠️ `/admin/catalog-import` is deliberately **not** `advertise`d in the index at `GET /`: that
list is a golden snapshot and this task does not regenerate it — the same choice Task 7 made for
`/admin/reservations/move`. Both belong in the index the next time the snapshots move.

### Task 10: Verify acceptance criteria

- [x] verify no `/admin/*` route answers without a session: enumerate the router's table and call each one anonymously (53 closed routes, each answering 401 — 50 exact plus three pattern routes)
- [x] verify a `parking_admin` cannot reach any user-management route (403 on all six, and the probe set is now checked against the table)
- [x] verify the audit trail names a person for operator actions and a service for job actions (both halves asserted; the service half needed a new case)
- [x] run `npm run test:integration` with `DATABASE_URL_TEST` set — all suites green, twice in a row (360/360 twice)
- [x] run `npm run admin-ui:build` — no unresolved-font warnings (clean, no warnings of any kind)
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` (159 UI specs, 176 files parsed, lint clean, 389 node tests)

⚠️ **the first criterion was not met when this task started, and enumerating by hand is why.**
`route-access.test.js` built its anonymous probes from `table.exactRoutes` — complete by
construction — and then appended a hand-written pair of pattern routes. The table has **three**
closed pattern routes: `GET /admin/line-groups/:id/occupancy` was added later and was never
called anonymously. It does answer 401, so nothing was open; what was missing was the proof,
which is exactly what a hand-maintained list of a derived thing loses. The probes are now
derived from the pattern source (`([^/]+)` → a zero uuid), with two assertions that keep them
honest: that the probe count equals the table's closed-route count, and that each derived path
actually matches the pattern it came from and collides with no exact route.

➕ The `parking_admin` case in `auth.itest.js` listed its six routes by hand too. It still
builds the request bodies explicitly — a role refusal is only interesting against a request
that would otherwise have worked — but the set of routes it probes is now compared against the
role-scoped routes in the composed table, so a seventh account route fails the suite instead of
going unchecked.

➕ **"a service for job actions" had no test, because no request can produce one.** Every
assertion was about an operator-started job, which records `admin-ui` and the person. The
scheduler's own run — `jobs`, no person — is unreachable over HTTP since Task 3 (the gap Task 6
recorded), so `audit-actor.itest.js` now drives the jobs service in-process against the same
scratch schema with `actor: null`, which is the actor the scheduler's request will produce once
it has a way in, and asserts `jobs` with a null `actor_auth_user_id` on both `job_runs` and the
audit row. Verified by mutation: hard-coding the fallback to `admin-ui` fails this case and
nothing else. The row is found by the run's id rather than "the latest row", so this case and
the operator-started one above cannot assert each other's row.

⚠️ The scheduler still cannot reach the API — unchanged by this task, and the one item on the
plan's own acceptance list that remains false on the stand. The 07:00 and 19:00 jobs answer 401
until a service account or shared secret exists. Task 6 recorded it; it needs a task of its own.

### Task 11: Update documentation

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
