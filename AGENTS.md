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
API entrypoint self-starts its listener on require and exports nothing.

Ephemeral database for local runs:

```bash
docker compose -f docker-compose.test.yml up -d
export DATABASE_URL_TEST=postgresql://parkingassistant_test:parkingassistant_test@127.0.0.1:5433/parkingassistant_test
npm run test:integration
docker compose -f docker-compose.test.yml down
```
