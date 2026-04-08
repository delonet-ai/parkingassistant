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

### `apps/admin-web`

Administrative web interface for parking admins and system admins.

### `apps/bot-adapter`

Adapter layer for `Yandex Messenger`. It receives webhook events, calls backend APIs, and formats responses for employees.

### `packages/domain`

Core parking rules and policies:

- reservation rules
- guest reserve
- queue processing
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
- all date and cutoff rules use one explicit timezone
- every important assignment change is traceable with actor and source
- map interaction is a view layer over canonical `parking_places`

