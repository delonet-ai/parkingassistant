# Architecture Overview

## Workspace Layout

```text
apps/
  api/
  admin-ui/
  bot-adapter/
  jobs/
packages/
  db/
  domain/
  shared/
docs/
  api/
  adr/
  catalog/
  plans/
infra/
```

`packages/jobs/` exists as an empty placeholder and is not a package: the scheduler lives in
`apps/jobs` and the work itself in the API's job endpoints (see `TASKS.md` → Status).

## Bounded Areas

### `apps/api`

Backend API and orchestration layer. Holds controllers, application services, auth entrypoints, and integration-facing contracts.

Internally it is split by bounded context, one directory per context, at most three files each:

```text
apps/api/src/modules/<context>/
  controller.js   HTTP I/O only: parse/validate, call the service, serialize
  service.js      use-case orchestration + transaction boundaries (withTransaction)
  repository.js   ALL SQL; the only place that talks to pg
```

Dependency direction is one-way — `controller → service → repository`, any layer → `packages/domain` — and is enforced by `no-restricted-imports` / `no-restricted-syntax` rules in `eslint.config.js`, not by convention. See [ADR 003](adr/003-modular-architecture.md).

The contexts are `auth`, `catalog-import`, `employees`, `places`, `place-lines`, `permanent-assignments`, `place-releases`, `employee-requests`, `guest-requests`, `reservations`, `queue`, `line-occupancy`, `departure-plans`, `conflicts`, `contact-access`, `maps`, `dashboard`, `audit`, `jobs`, `system`. `availability` is a read model over `place-releases`, `places` and `reservations` rather than a context of its own; `dashboard` owns no repository, because its handler is a composition of three other contexts' reads.

`queue` has a service but no controller: it serves no route of its own and runs only under the process-queue job.

Every SQL string in the API lives in an `apps/api/src/modules/<context>/repository.js`, and nowhere else — a test asserts it. A repository function takes the query surface as its first argument, so the same function serves a pool-bound repository and the client-bound one `withTransaction` yields.

A service may require any context's repository — a transaction spans contexts by nature. A controller may require none: it reaches the database only through `deps.services`, and `apps/api/src/module-boundary.test.js` fails the build if one requires a repository, `pg`, `repositories/db` or `services/availability`.

The lint rules cover every layer, not just the two the boundary started with: `packages/domain/**` and `packages/shared/**` (leaves, no `pg`, no HTTP, no reaching up into an application), `**/controller.js` (no `pg`, no repository), `**/service.js` (no `pg`, no HTTP, no HTML, no controller) and `**/repository.js` (no HTTP, no HTML, no service, no controller). `architecture.test.js` proves each rule actually fires by linting synthetic sources at each layer's path, then lints the real tree and asserts zero violations — so `npm test` catches a boundary break without anyone running `npm run lint`. It also reads the sources directly to assert that no controller contains raw SQL and no domain module holds a SQL statement or a forbidden `require`, which no import rule can see. `dead-exports.test.js` asserts no file exports a name nothing else requires.

`apps/api/src/server.js` is a bootstrap: read the environment, open the pool, build the modules, listen, shut down. `apps/api/src/modules/index.js` is the composition root — it builds every service into one registry, hands that registry to every factory, and lists the controllers in the order the endpoint index at `GET /` is published. `apps/api/src/router.js` owns no routes; it composes the per-module route tables and derives that index from the entries marked `advertise`, so a route and its documentation cannot drift apart.

All database access goes through `apps/api/src/repositories/db.js`: `createDbRepository(pool)` for pool-scoped reads, `withTransaction(pool, fn)` for anything transactional. `withTransaction` yields a client-bound repository with the same `queryOne` / `queryMany` surface, issues `begin`/`commit`/`rollback` around the callback, and always releases the client. A service that needs to abort throws — the helper never inspects the return value.

### `apps/admin-ui`

The administrative web interface for parking admins and system admins: Vue 3 + Vite on the
Vision UI design system. It replaced the server-rendered `apps/admin-web`, which is deleted
(see [ADR 006](adr/006-admin-ui-on-vision-ui.md)) — the one ESM package in the repo, the one
with a build step, and the one with its own test runner (vitest + happy-dom, `npm run test:ui`,
specs named `*.spec.js`).

```text
apps/admin-ui/
  server.js            production host: serves dist/, the floor-plan files and /api/* proxy
  src/
    api.js             the only caller of the API, JSON and multipart alike
    store.js           the one reactive day model every tab reads
    pages/             one component per tab
    components/        the tables, drawers and forms the pages compose
```

Two rules are not stylistic. **No parking rule is evaluated here** — statuses and "today" come
from the API, so the UI cannot disagree with it. And **every call goes through `src/api.js`**,
because that is the only place a `401` becomes a return to the login screen; a component that
reached for `fetch` itself would leave the operator with a toast and a dead session.

`server.js` is ESM but imports `packages/shared/multipart.js`, which is CommonJS. Node's
named-export interop carries that, so the shared file must keep a literal `module.exports`; and
because the import is relative, the runtime image mirrors the repository tree
(`WORKDIR /app/apps/admin-ui`) rather than flattening into `/app`. `infra/deployment.test.js`
pins that topology.

### `apps/bot-adapter`

Adapter layer for `Yandex Messenger`. It receives webhook events, calls backend APIs, and formats responses for employees.

### `packages/domain`

Core parking rules and policies — pure functions with no I/O imports. Services fetch data
through repositories and hand it to these; nothing here knows about Postgres, HTTP, or HTML.

| Module | Rules it owns |
|---|---|
| `scheduling.js` | the 18:00 early-departure and 07:00 departure-edit cut-offs, `is_early` drift detection |
| `guest-reserve.js` | the availability snapshot fold, the employee pool = available − reserve, the `ok`/`low` status |
| `queue.js` | queue allocation: pick order, the never-give-back-your-own-place cursor, every skip reason |
| `line-inventory.js` | capacity ↔ slot count ↔ place type, slot position assignment, place role and guest rank normalization, slot status precedence, archive-blocker naming |
| `line-ordering.js` | line position validity, "who is ahead of me", how a blocking contact may be reached |
| `conflicts.js` | conflict classification (guest = warning, employee = info) and early-departure assignment warnings |
| `catalog-rows.js` | one Excel catalog row → one place: required cells, code and floor normalization, position hint, guest detection, and the reasons a row is refused |

`packages/domain/index.js` is the barrel the API imports. A module whose names are too generic
for every service to pull in — `catalog-rows.js`, with its `clean` and `normalizeCode` — is
deliberately left out of the barrel and required by path instead.
- conflict detection

### `packages/db`

Database schema, migrations, repositories, import scripts, and seed data.

### `apps/jobs`

The scheduler: a minute tick that calls the API's job endpoints. Five runs — the `07:00`
departure-edit lock, start-of-day queue processing, the conflict rebuild, and the two `19:00`
runs that freeze the next day and open the employee pool. The work itself is the API's; this
process only decides when.

### `packages/shared`

Leaf utilities with no knowledge of the domain and no imports from any app: `dates` (the
timezone-aware day arithmetic), `errors` (the API error payload shape), `http` (the JSON
request/response helpers), `multipart` (the form parser both upload paths use) and `passwords`
(scrypt hashing and verification).

## Role Model

### `system_admin`

- manages web UI accounts
- assigns roles
- sees auth and access audit

### `parking_admin`

- manages parking operations
- creates manual assignments
- handles guests, queue, conflicts, and audit

### `employee`

- works only through bot
- releases place, requests place, sets line position, sets departure time

The two web roles are rows in `auth_roles` and are enforced on the route table, not in the UI:
a `parking_admin` who opens an account route gets `403` ([ADR 007](adr/007-session-based-access-control.md)).
`employee` is not a web account — the bot scenarios are still deferred.

## Key Design Rules

- business logic lives only in backend and domain packages
- admin UI and bot adapter use backend API only
- all date and cutoff rules use one explicit timezone, `APP_TIMEZONE` — including every
  "today" default, which must never be derived in UTC
- every important assignment change is traceable with actor and source
- the floor plan is a static reference image; the element list is the view layer over
  canonical `parking_places`, and `line_groups.capacity` is the source of truth for
  element size
- a place is never hard-deleted, only archived, so history stays readable
- there is exactly one write path per concern: places are added and removed through
  `/admin/place-lines`, and `is_active` is written only by that service

