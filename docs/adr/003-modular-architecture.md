# ADR 003: Modular Architecture for `apps/api`

## Status

Accepted. Supersedes nothing; it records the target the Phase 3 strangler-fig split
(Tasks 14–19) converges on. No code moves as part of this ADR.

## Context

`apps/api/src/server.js` is a ~6 800-line module that mixes HTTP parsing, business rules,
and SQL in the same function bodies, and self-starts an HTTP listener on `require` while
exporting nothing. That last property is the expensive one: none of its rules are unit
reachable, so every assertion about them has to go through a live Postgres and a spawned
process (`apps/api/testing/boot-api.js`). `apps/admin-web/src/server.js` has the same
shape on the rendering side, which is why Tasks 10–12 had to extract pure renderers
(`render-place-lines.js`, `render-day-map.js`) before those tabs could be tested at all.

Two database access patterns coexist today:

- `apps/api/src/repositories/db.js` — `createDbRepository(pool)` exposing `queryOne` /
  `queryMany`, used for pool-scoped reads.
- inline `pool.connect()` + `client.query('begin')` blocks (19 of them in `server.js`),
  used wherever a transaction is needed.

Nothing enforces the direction of dependencies, so a handler is free to reach for `pg`
and a rule is free to reach for `node:http`.

## Decision

### Layer contract

```
controller  → HTTP I/O only: parse/validate request, call service, serialize response
service     → use-case orchestration + transaction boundaries (withTransaction)
repository  → ALL SQL; the only layer that talks to pg
domain      → pure business rules, ZERO I/O deps (no pg, no node:http, no shared/http)
```

Dependency direction is one-way: `controller → service → repository`, and any layer may
depend on `domain`. Nothing depends on a controller. `domain` depends on nothing but the
standard library and other `domain` modules.

Concretely, per layer:

| Layer | May import | Must not contain |
|---|---|---|
| `controller.js` | its own `service.js`, `packages/shared/http`, `packages/domain` | SQL, `pg`, transaction control |
| `service.js` | its own and other contexts' `repository.js`, `packages/domain` | SQL strings, `node:http`, HTML |
| `repository.js` | `pg` types, `packages/shared` helpers | business branching, HTTP status codes |
| `packages/domain/**` | node stdlib, other `domain` modules | `pg`, `node:http`, `packages/shared/http`, `packages/shared/html` |

### Module layout

Every bounded context lives at `apps/api/src/modules/<context>/` and holds at most three
files: `controller.js`, `service.js`, `repository.js`. A context that needs none of a
layer simply does not have that file. Tests live next to the code they cover
(`*.test.js` for unit, `*.itest.js` for Postgres-backed).

### Bounded contexts

The split is by the question the operator is answering, not by table. Eighteen contexts:

| Context | Owns |
|---|---|
| `employees` | employee catalog, activation, contacts |
| `places` | per-place attributes, `place_role`, place history |
| `place-lines` | line inventory: create / list / archive elements |
| `permanent-assignments` | long-lived place ownership (`daterange`) |
| `place-releases` | releasing a place for a date range, freeze, cancel |
| `employee-requests` | employee asks for a place |
| `guest-requests` | guest asks for a place, guest minting |
| `reservations` | assignment for a date: manual, queue, guest; cancel |
| `queue` | ordering and the `process-queue` run |
| `line-occupancy` | who stands in which position today, blocking contacts |
| `departure-plans` | planned departure time, early-departure flag, lock |
| `conflicts` | conflict set derivation and rebuild |
| `contact-access` | contact disclosure and its access log |
| `maps` | floor plan images: upload, replace, diagnostics |
| `dashboard` | cross-context read model for the KPI panel |
| `audit` | audit log reads |
| `jobs` | the five scheduled runs and `job_runs` bookkeeping |
| `system` | the database health probe and `auth_users` bootstrap state |

`availability` is deliberately not a context: it is a read model over `place-releases`,
`places` and `reservations`, and its SQL lives in those repositories (done in Task 15 —
`countUnreservedReleasedPlaces` and `summarizeAvailability` in `place-releases`).

`dashboard` is a context in the list but owns **no repository**: after Task 15 its handler
is a `Promise.all` over three other contexts' reads, so a `dashboard/repository.js` would
have held nothing. `system` was added in Task 15 for the two reads that belong to no
business context — the `/health/db` probe and the `auth_users` bootstrap state — which had
nowhere else to go once no SQL was allowed to remain in `server.js`.

### One database pattern

`repositories/` and `queryOne` / `queryMany` win; inline `client.query` in a service is
not deprecated-but-tolerated, it is removed outright by Task 15, which leaves no SQL
outside a `repository.js`. Transactions go through one helper:

```js
const { withTransaction } = require('./repositories/db');

const result = await withTransaction(pool, async (repo) => {
  const place = await repo.queryOne('select ... for update', [placeId]);
  await repo.queryMany('insert ...', [...]);
  return place;
});
```

`withTransaction` yields a **client-bound repository** with the same `queryOne` /
`queryMany` surface as the pool-bound one, so a query moves between the two without being
rewritten. It issues `begin` before the callback, `commit` after it returns, `rollback` if
it throws, and always releases the client. A callback that wants to abort without an error
throws a sentinel and the caller maps it — the helper never inspects the return value,
because "returned a 404 payload" and "returned a success payload" must not be
distinguishable by the transaction helper.

### Enforcement

The boundary is a lint rule, not a convention. `eslint.config.js` carries
`no-restricted-imports` plus `no-restricted-syntax` selectors over `require()` — the
project is CommonJS, so the import-shaped rule alone would never fire:

- `packages/domain/**` may not require `pg`, `node:http`/`node:https`, or
  `packages/shared/http|html`.
- `**/controller.js` may not require `pg`.

Task 18 verifies these repo-wide and adds the "no raw SQL in a controller" check.

## Rationale

Why layers rather than one file per table: the rules that make this system non-trivial —
the 19:00 cut-off, the five-guest reserve, queue ordering, capacity ↔ slot count — read
across several tables each. A table-shaped split would scatter every one of them.

Why `RESTRICT`-style strictness on the dependency direction: the two defects Phase 0
pinned (the `for update` over a `left join`, the queue batch 409) were both HTTP-layer
code reaching directly into SQL semantics it did not model. Making that import impossible
is cheaper than catching it in review.

Why not extract to separate packages: the contexts share a connection pool and a
transaction boundary, and npm-workspace boundaries would add build steps to a project
that deliberately has none.

## Consequences

Positive:

- rules become unit-testable without Postgres or a spawned process
- SQL has exactly one home per context, so a query is found by grepping one directory
- the golden snapshots from Task 14 make the split verifiable rather than hopeful

Negative:

- more files and one more indirection per request
- Task 15 must move ~19 transaction blocks by hand, each behind the golden tests
- until Task 18 turns the rules on repo-wide, the boundary holds only where code has moved

## Addendum — how the split actually landed (Task 17)

The layout above is now the code, not the plan. Three points the original text did not
settle, decided while moving the handlers:

**A service may require any context's repository; a controller may require none.** The
one-way rule in this ADR is about *layers*, not contexts, and a transaction inherently
spans contexts — the manual-assignment use case writes reservations, closes an employee
request and touches the queue in one `withTransaction`. Forcing each of those through a
sibling service would have produced ~60 pass-through methods and no extra safety. What is
enforced instead, by `apps/api/src/module-boundary.test.js`, is the layer boundary that
actually protects anything: no `controller.js` requires a `repository.js`, `pg`,
`repositories/db` or `services/availability`.

**The transaction lives in the service, the status mapping in the controller.** The
sentinel this ADR describes (`AbortTransaction` / `abortWith`, now in
`src/support/transaction.js`) is thrown from inside the service's transaction and caught
by the controller, which turns it into a status and payload. Pg error codes are mapped the
same way. That is what keeps `withTransaction` blind to the return value while still
letting a rolled-back use case answer 404 or 409.

**Routes are per-module tables and the endpoint index is derived from them.** `router.js`
holds no routes and no `rootEndpoints` array; it composes the tables in the order
`modules/index.js` lists the contexts, and builds the `GET /` index from the entries marked
`advertise`. That index is part of the HTTP contract and is pinned twice — by a golden
snapshot and, so it fails without a database, by a unit test.

`queue` ended up with a service and no controller: it serves no route of its own and is
driven only by the process-queue job. With `dashboard` (a context with no repository) and
`system` (a repository for reads that belong to no business context), that makes three of
the eighteen contexts that do not have all three files. The layer rules hold regardless;
the file set is not the contract.
