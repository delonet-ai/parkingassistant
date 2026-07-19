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

#### Golden HTTP snapshots

`apps/api/test/golden/*.json` holds a recorded `(status, payload)` per endpoint group, replayed by
`apps/api/integration/golden.itest.js` against a scratch schema loaded with the demo dataset. These
snapshots are the behavior contract the Phase 3 decomposition must preserve — moving SQL into a
repository or a handler into a controller must not change one byte of them.

```bash
npm run test:golden                   # replay and compare
GOLDEN_UPDATE=1 npm run test:golden   # rewrite the snapshots — then read the whole diff
```

Three things to know before touching it:

- **Snapshot files are `.json` under `test/` on purpose.** The runner cannot live there: `node --test`
  picks up every `.js` file under a directory named `test/`, which would drag a Postgres-backed suite
  into the `npm test` gate.
- **Identifier tokens are numbered across the whole run** (`<id:1>`, `<id:2>`, …), which is what makes
  "the id `POST` returned is the id `GET` returns" assertable. Inserting a request in the middle of a
  group renumbers the ids after it, so the diff of a regeneration is large by design — read it anyway.
- **Lists whose SQL ordering has ties are marked `unordered` in the scenario.** `/admin/audit-logs`
  orders by `occurred_at desc` with no tiebreaker and every row one transaction writes shares a
  timestamp, so Postgres may return them in any order. Sorting alone does not fix it (a reshuffle
  renumbers the id tokens), so inside those lists identity is made opaque and the rows are sorted by
  normalized content.

One defect is pinned rather than fixed, and its scenario name says so: `GET /admin/places/:id/history`
with a malformed id returns **500** with the raw Postgres cast error (`invalid input syntax for type
uuid`) instead of a 400. Task 14 records behavior; the fix belongs to the Task 21 review pass, and the
snapshot will fail loudly when it lands.

#### Rendering the admin UI in a test

`apps/admin-web/testing/stub-api.js` boots the real `admin-web` process against a canned HTTP API,
so every tab can be rendered and asserted without a database. admin-web is a pure proxy over the API
— each tab is `fetchJson` plus a renderer — so a fixed payload per path exercises the real handler,
the real renderers and the real HTML. `apps/admin-web/src/tabs.test.js` is the tab walk built on it,
and it runs inside `npm test`. Use it for anything about *rendered markup*; use a `.itest.js` only
when the assertion needs real SQL.

The stub records every path the UI requested, which is how a test asserts a request is **not** made
(e.g. no page may fetch data no renderer reads).

#### Characterization tests pin defects, they do not hide them

Phase 0's job was to pin current behavior before refactoring, because a defect that is not pinned
gets silently preserved or silently changed. Tests prefixed `CHARACTERIZATION:` asserted behavior
that was **wrong** and named the task that should fix it.

**There are none left.** Every one has been inverted in place, and each carries a comment saying what
it used to pin so the history stays readable without the dead assertions.

Fixed in Task 12, and the tests that pinned them now assert the corrected behavior:

- `POST /admin/reservations/cancel` always returned 500: `for update` over a select that `left join`s
  `users`, which Postgres refuses. Combined with `/admin/place-releases/cancel` refusing while an
  active reservation stands on the place, the operator had **no way to undo an assignment** — both
  exits were closed. The lock is now narrowed to `for update of r`.
- Releases could be created for dates already in the past — no endpoint compared the requested date
  against "now" in `APP_TIMEZONE`. `POST /admin/place-releases` now refuses a `dateFrom` before today.

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
