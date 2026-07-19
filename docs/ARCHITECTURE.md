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

The contexts are `employees`, `places`, `place-lines`, `permanent-assignments`, `place-releases`, `employee-requests`, `guest-requests`, `reservations`, `queue`, `line-occupancy`, `departure-plans`, `conflicts`, `contact-access`, `maps`, `dashboard`, `audit`, `jobs`. `availability` is a read model over `place-releases`, `places` and `reservations` rather than a context of its own.

All database access goes through `apps/api/src/repositories/db.js`: `createDbRepository(pool)` for pool-scoped reads, `withTransaction(pool, fn)` for anything transactional. `withTransaction` yields a client-bound repository with the same `queryOne` / `queryMany` surface, issues `begin`/`commit`/`rollback` around the callback, and always releases the client. A service that needs to abort throws — the helper never inspects the return value.

### `apps/admin-web`

Administrative web interface for parking admins and system admins.

### `apps/bot-adapter`

Adapter layer for `Yandex Messenger`. It receives webhook events, calls backend APIs, and formats responses for employees.

### `packages/domain`

Core parking rules and policies:

- reservation rules
- guest reserve
- queue processing
- place inventory: capacity ↔ slot count, slot position assignment, archive-blocker detection
- line occupancy
- departure constraints
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

