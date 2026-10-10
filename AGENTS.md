# AGENTS.md

Guidance for AI coding agents (ralphex, Claude Code, Codex, Copilot CLI) working in this repo.

## What this project is

Office parking management system. Node.js 22 monorepo, **CommonJS** (`require`/`module.exports`),
plain Node `http` (no web framework), PostgreSQL 16. Only runtime deps are `pg` and `xlsx`.

## Layout

- `apps/api` — HTTP API. `src/server.js` is a bootstrap only; every bounded context lives in
  `src/modules/<context>/{controller,service,repository}.js` and the router composes their
  route tables. See `docs/adr/003-modular-architecture.md` for the layer rules.
- `apps/admin-ui` — the admin UI: **Vue 3 + Vite on the Vision UI design system**. It replaced
  the server-rendered `apps/admin-web`, which is deleted (see
  `docs/adr/006-admin-ui-on-vision-ui.md`). The one
  ESM package in the repo, the one with a build step, and the one with its own test runner
  (vitest + happy-dom). Its specs are `*.spec.js`, not `*.test.js`, so `node --test` does not
  try to load them as CommonJS. Run them with `npm run test:ui`.

  Three rules there are not stylistic:
  - component props are **read from the design system, never guessed** — Vision UI inputs expose
    `value` and bind with `v-model:value`, and a plain `v-model` renders fine while posting
    nothing;
  - colours, radii and spacing come from tokens (`rgb(var(--vi-color-…))`, `var(--vi-radius-…)`,
    `var(--vi-vr-…)`); a hard-coded hex is a defect;
  - no parking rule is evaluated in the UI. Statuses and "today" come from the API.
  One file crosses the CommonJS line on purpose: `server.js` imports
  `packages/shared/multipart.js`, which is CommonJS, and Node's named-export interop carries it
  — so that file must keep a literal `module.exports` and must not gain ESM syntax. Because the
  import is relative, `infra/docker/admin-ui.Dockerfile` mirrors the repository tree
  (`WORKDIR /app/apps/admin-ui`) instead of flattening into `/app`; `infra/deployment.test.js`,
  part of `npm test`, fails if a new relative import of `server.js` is not copied to the same
  depth in that image.
- `apps/bot-adapter` — Yandex Messenger bot.
- `apps/jobs` — scheduled jobs (19:00, 07:00, daily rules).
- `packages/shared` — leaf utilities, no app imports: `dates`, `errors`, `http`, `multipart`,
  `passwords`. Easiest place to add tests.
- `packages/domain` — pure rules, zero I/O: `queue`, `guest-reserve`, `scheduling`, `conflicts`,
  `line-inventory`, `line-ordering`, `catalog-rows`. `index.js` is a barrel; a module whose names
  are too generic for every service to import (`catalog-rows`, with its `clean` and
  `normalizeCode`) is deliberately left out of it and required by path.
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
- Prefer adding pure, testable functions in `packages/shared` (no domain knowledge) or
  `packages/domain` (parking rules, still no I/O) and covering them with `*.test.js` files
  colocated next to the source (see `packages/shared/dates.test.js`).
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
`insertDeparturePlan`) plus `postJson`/`postForm`/`getJson`. Prefer it over inline SQL so a test
states what it needs, not how the tables are wired. `postForm` deliberately sets no
`content-type`: `fetch` derives it and the boundary from the `FormData`, and a header written by
hand would name a boundary the body does not use.

The harness serializes schema application on a `pg_advisory_lock`: `node --test` runs one process per
file, and `CREATE EXTENSION IF NOT EXISTS` races against concurrent creation of the same
database-wide extension.

#### Every request needs a session

The API is closed by default (ADR 007): a route answers without a session only if its route table
entry says `public: true`, and seven do. So practically every request a suite makes has to carry a
session cookie — **and that is already handled**, as long as you use the helpers:

- `startApi()` signs in as the seeded bootstrap operator and registers the cookie it got against
  the base URL it is listening on. It returns `{ cookie, operator, ... }` alongside `baseUrl`.
- `postJson`/`postForm`/`getJson` in `fixtures.js` look the cookie up by base URL, so a test
  does not restate it per call. A suite that boots two APIs gets two independent sessions without
  saying anything.

The `cookie` option on those helpers is **tri-state**, which is the whole vocabulary of access
tests: absent means "whatever the jar holds", `null` means send none (how the 401 paths are
asserted), a string means send that one (how a second operator, or a `parking_admin` hitting a
`system_admin` route for its 403, is exercised).

Two escape hatches, both deliberate:

- `startApi({ authenticate: false })` — for the auth suite itself, which has to meet a database
  where activation and login have not happened yet.
- `startApi({ operator: { login, password } })` — seeds and signs in a different account as the
  suite's default session instead of `sysadmin`.

A second account's session is obtained the other way round: create the user over
`POST /admin/users`, `POST /auth/login` as them, and pass the returned `name=value` as `cookie`.
That is how `auth.itest.js` gets its 403s for a `parking_admin` — the jar stays the
`system_admin`'s, and only the cases that need the other role say so.

`seedOperatorCredential` writes the password hash straight into `auth_users` because first-run
activation is a once-per-installation event a suite must be able to skip. The sign-in itself is the
real `POST /auth/login` against a real scrypt hash, so nothing about sessions is stubbed.

Closing the API did **not** move a single golden snapshot — authentication changes who may ask, not
what the answer is. If a snapshot moves when you touch the guard, the guard changed a response it
should not have.

`apps/api/src/route-access.test.js` is the unit-level counterpart and needs no database: it
enumerates the composed route table, pins the public set and the role-scoped set exhaustively, and
drives every other route through a real router whose session store resolves nobody. Adding a route
with `public: true` fails there, in a diff a reviewer sees. Both its probe sets and the anonymous
probes in `auth.itest.js` are **derived from the table** — never extend them by hand, that is the
mistake they already made once (`GET /admin/line-groups/:id/occupancy` was closed but never
actually called anonymously).

#### The end-to-end day

`apps/api/integration/e2e-day.itest.js` is the one suite that crosses every context: it walks a
single operating day from an empty database (catalog import → add an element → permanent assignments
→ releases → queue → guest assignment with a warning → line occupancy → blocking contacts → archive
→ audit trail). Its cases are **ordered** and share state — each `it` is a step of the same day, not
an independent scenario — and every precondition is created through the HTTP API rather than with
fixtures, because the seams between the steps are what it exists to test. The per-context suites stay
the right place for edge cases; add to this one only when a *flow* changes shape.

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
- **Lists whose SQL ordering has ties are still marked `unordered` in the scenario, and must stay
  that way.** Task 21 added `, id desc` to the journal `order by` clauses, which makes a repeated
  read and a `limit` page consistent *within one database* — the actual defect. It does **not** make
  the snapshot orderable: the ids are `gen_random_uuid()`, so the tie order is reshuffled by every
  fresh scratch schema. Inside those lists identity stays opaque and rows stay sorted by normalized
  content.

Both defects Task 14 pinned rather than fixed are now fixed, and no `CHARACTERIZATION:`-style
pinned-defect snapshot remains: `GET /admin/places/:id/history` with a malformed id answers **400**
instead of a 500 quoting the raw Postgres cast error, and the journal ordering above has its
tiebreaker.

#### Rendering the admin UI in a test

The admin UI has its own runner: vitest with happy-dom, `npm run test:ui`, specs named
`*.spec.js` beside the component. They mount the real Vision UI components against a stubbed
`fetch`, so a tab can be rendered and asserted without a database and without a browser —
`src/App.spec.js` boots the whole app the way the browser does, which is what catches a shell
that renders blank while every other check is green.

Five things the design system does silently, each of which cost a defect: `ViTableSimple`
hands a cell to the `#cell` slot **only when it has no `text` key**; `ViModal` ignores
`isOpened` unless `use-model` is passed, and teleports its content to `document.body`, so a
spec must assert on the document; a masked `ViInput` emits the **unmasked** value; `ViInput`
decides whether it has an `#error` or `#note` slot from the slots it was mounted with, so
`<template v-if="…" #error>` never appears — declare the slot and put the `v-if` **inside** it;
`ViCheckbox` toggles on the input's **`change`** event, not on a click, and with an array
`model-value` it emits the whole new array rather than the one value — a spec that triggers
`click` on the box changes nothing and passes for the wrong reason.

Assert the rendered result, never the prop you passed: a spec that checked `isOpened` passed
while an empty modal sat over the screen.

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
