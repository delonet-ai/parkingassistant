# Architecture Overview

## Workspace Layout

```text
apps/
  api/
  admin-web/
  bot-adapter/
packages/
  db/
  domain/
  jobs/
  shared/
docs/
  api/
  adr/
  catalog/
infra/
```

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

The contexts are `employees`, `places`, `place-lines`, `permanent-assignments`, `place-releases`, `employee-requests`, `guest-requests`, `reservations`, `queue`, `line-occupancy`, `departure-plans`, `conflicts`, `contact-access`, `maps`, `dashboard`, `audit`, `jobs`, `system`. `availability` is a read model over `place-releases`, `places` and `reservations` rather than a context of its own; `dashboard` owns no repository, because its handler is a composition of three other contexts' reads.

`queue` has a service but no controller: it serves no route of its own and runs only under the process-queue job.

Every SQL string in the API lives in an `apps/api/src/modules/<context>/repository.js`, and nowhere else — a test asserts it. A repository function takes the query surface as its first argument, so the same function serves a pool-bound repository and the client-bound one `withTransaction` yields.

A service may require any context's repository — a transaction spans contexts by nature. A controller may require none: it reaches the database only through `deps.services`, and `apps/api/src/module-boundary.test.js` fails the build if one requires a repository, `pg`, `repositories/db` or `services/availability`.

The lint rules cover every layer, not just the two the boundary started with: `packages/domain/**` and `packages/shared/**` (leaves, no `pg`, no HTTP, no reaching up into an application), `**/controller.js` (no `pg`, no repository), `**/service.js` (no `pg`, no HTTP, no HTML, no controller) and `**/repository.js` (no HTTP, no HTML, no service, no controller). `architecture.test.js` proves each rule actually fires by linting synthetic sources at each layer's path, then lints the real tree and asserts zero violations — so `npm test` catches a boundary break without anyone running `npm run lint`. It also reads the sources directly to assert that no controller contains raw SQL and no domain module holds a SQL statement or a forbidden `require`, which no import rule can see. `dead-exports.test.js` asserts no file exports a name nothing else requires.

`apps/api/src/server.js` is a bootstrap: read the environment, open the pool, build the modules, listen, shut down. `apps/api/src/modules/index.js` is the composition root — it builds every service into one registry, hands that registry to every factory, and lists the controllers in the order the endpoint index at `GET /` is published. `apps/api/src/router.js` owns no routes; it composes the per-module route tables and derives that index from the entries marked `advertise`, so a route and its documentation cannot drift apart.

All database access goes through `apps/api/src/repositories/db.js`: `createDbRepository(pool)` for pool-scoped reads, `withTransaction(pool, fn)` for anything transactional. `withTransaction` yields a client-bound repository with the same `queryOne` / `queryMany` surface, issues `begin`/`commit`/`rollback` around the callback, and always releases the client. A service that needs to abort throws — the helper never inspects the return value.

### `apps/admin-web`

Administrative web interface for parking admins and system admins. Server-rendered HTML, no
framework and no build step.

It is layered the same way the API is, with the layers renamed to what they actually do here:

```text
apps/admin-web/src/
  server.js            bootstrap: config + listen, nothing else
  config.js            the only reader of process.env
  api-client.js        fetchJson / postJson — the only caller of the API
  http/
    router.js          dispatches into the route groups in order
    routes/
      assets.js        /health, floor-plan files, JSON proxies, the place drawer
      page.js          GET / — builds the page model and hands it to renderPage()
      forms.js         the form POSTs: post to the API, redirect back with a notice flag
  pages/               one renderer per tab, plus the shared shell (layout.js)
  components/          the tables, forms and panels the pages compose
```

The dependency direction is one-way — `routes → pages → components` — and the rule that makes
it worth having is that **nothing under `pages/` or `components/` performs I/O**. A page is a
pure function from a model to an HTML string, so `pages/pages.test.js` renders every tab
directly from a fixture. `tabs.test.js` still drives the real process over HTTP against a
stubbed API, which is what catches the wiring the pure tests cannot see.

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

`packages/domain/index.js` is the barrel the API imports; a renderer that needs one rule
(admin-web's place drawer and `derivePlaceStatus`) requires the single module directly.
- conflict detection

### `packages/db`

Database schema, migrations, repositories, import scripts, and seed data.

### `packages/jobs`

Background jobs for:

- `19:00` day freeze and employee pool opening
- `07:00` departure edit lock
- start-of-day queue processing
- conflict rebuilds

### `packages/shared`

Common DTOs, enums, time helpers, error codes, and logging primitives used across apps.

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

## Key Design Rules

- business logic lives only in backend and domain packages
- admin web and bot adapter use backend API only
- all date and cutoff rules use one explicit timezone, `APP_TIMEZONE` — including every
  "today" default, which must never be derived in UTC
- every important assignment change is traceable with actor and source
- the floor plan is a static reference image; the element list is the view layer over
  canonical `parking_places`, and `line_groups.capacity` is the source of truth for
  element size
- a place is never hard-deleted, only archived, so history stays readable
- there is exactly one write path per concern: places are added and removed through
  `/admin/place-lines`, and `is_active` is written only by that service

