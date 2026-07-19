# AGENTS.md

Guidance for AI coding agents (ralphex, Claude Code, Codex, Copilot CLI) working in this repo.

## What this project is

Office parking management system. Node.js 22 monorepo, **CommonJS** (`require`/`module.exports`),
plain Node `http` (no web framework), PostgreSQL 16. Only runtime deps are `pg` and `xlsx`.

## Layout

- `apps/api` — HTTP API. Business logic lives in `apps/api/src/server.js` and `apps/api/src/services/`.
- `apps/admin-web` — server-rendered admin UI.
- `apps/bot-adapter` — Yandex Messenger bot.
- `apps/jobs` — scheduled jobs (19:00, 07:00, daily rules).
- `packages/shared` — pure utilities (`dates`, `errors`, `http`, `html`). Easiest place to add tests.
- `packages/db/schema` — SQL migrations (source of truth for the data model).

## Validation gate — run before marking any task complete

```bash
npm run check   # node --check syntax on all entrypoints
npm run lint    # eslint (must be 0 errors)
npm test        # node --test runner
```

All three must pass. This is the definition of "done" for automated loops — do not mark a task
complete or commit if any of them fail. CI (`.github/workflows/ci.yml`) runs the same three steps.

## Conventions

- CommonJS only. No ESM `import`/`export`, no TypeScript, no build step.
- Match the surrounding style: `'use strict'` at file top, 2-space indent, single quotes.
- Prefer adding pure, testable functions in `packages/shared` and covering them with `*.test.js`
  files colocated next to the source (see `packages/shared/dates.test.js`).
- Keep the dependency list minimal — justify any new runtime dependency.

## Testing

Uses the built-in Node test runner (`node:test` + `node:assert/strict`) — no external framework.
Add tests as `<name>.test.js` next to the code. Business rules worth covering first: queue
processing, multi-line occupancy limits, guest 5-place reserve, and the timed jobs.

### Integration tests (Postgres-backed)

```bash
npm run test:integration   # node --test "**/*.itest.js"
```

Integration tests are named `<name>.itest.js` and are **not** part of the `npm test` gate — they need
a live Postgres. Two naming rules keep the two suites apart, and both matter:

- `*.itest.js` does not match the runner's default `*.test.js` pattern, so `npm test` ignores it.
- Never put an integration test inside a directory named `test/` — the default runner picks up
  **every** `.js` file under such a directory regardless of its name.

`packages/db/testing/harness.js` provides the setup helper. `createTestDatabase()` creates a scratch
schema (`itest_<pid>_<n>`) in `DATABASE_URL_TEST`, applies every `packages/db/schema/*.sql` and
`packages/db/seeds/*.sql` in order, and returns `{ connectionString, pool, query, drop }`. Call
`drop()` in `after()` — it removes the schema, so runs never collide and nothing is left behind.
Guard each suite with `{ skip: skipWithoutDatabase() }` so the suite skips cleanly when
`DATABASE_URL_TEST` is unset rather than failing.

`apps/api/testing/boot-api.js` boots `apps/api/src/server.js` as a child process on a free port
against a given `databaseUrl` and waits for `/health`. An out-of-process boot is required because the
API entrypoint self-starts its listener on require and exports nothing. Pass `env` to override
process-level configuration — `GUEST_RESERVE_MINIMUM` in particular is read once at module load, so
a suite that wants a different reserve has to boot its own API with that value.

`apps/api/testing/fixtures.js` builds the domain preconditions (`insertEmployee`, `insertPlace`,
`insertLineGroup`, `insertReleasedPlace`, `insertQueuedRequest`, `insertLineOccupancy`,
`insertDeparturePlan`) plus `postJson`/`getJson`. Prefer it over inline SQL so a test states what it
needs, not how the tables are wired.

The harness serializes schema application on a `pg_advisory_lock`: `node --test` runs one process per
file, and `CREATE EXTENSION IF NOT EXISTS` races against concurrent creation of the same
database-wide extension.

#### Characterization tests pin defects, they do not hide them

Several integration tests are prefixed `CHARACTERIZATION:` and assert behavior that is **wrong**.
They exist because Phase 0's job is to pin current behavior before refactoring, and a defect that is
not pinned gets silently preserved or silently changed. Each one names the task that should fix it
and will fail loudly when it does — that failure is the signal, not a regression. Known ones:

- `POST /admin/reservations/cancel` always returns 500 (`FOR UPDATE` over a `LEFT JOIN`), so an
  assignment cannot be undone through the API at all. → Task 12.
- Releases can still be created for dates already in the past — no endpoint compares the requested
  date against "now" in `APP_TIMEZONE`. → Task 12.

Fixed in Task 7, and the tests that pinned them now assert the corrected behavior:

- `freeze-next-day` was a read-only snapshot. It now writes `place_releases.frozen_at`, and a frozen
  day refuses release cancellation with `409`. `status` deliberately stays `'active'` — a frozen
  release is still a released place the next morning's queue run has to be able to hand out, so the
  `frozen` enum value stays unused.
- A manual reservation did not close the employee's queue request, so the next `queue/process` run
  tripped the per-user unique index and 409'd the **whole batch**. The manual endpoint now closes the
  request it answers, and the queue run skips anyone already holding a reservation for the date.

Ephemeral database for local runs:

```bash
docker compose -f docker-compose.test.yml up -d
export DATABASE_URL_TEST=postgresql://parkingassistant_test:parkingassistant_test@127.0.0.1:5433/parkingassistant_test
npm run test:integration
docker compose -f docker-compose.test.yml down
```
