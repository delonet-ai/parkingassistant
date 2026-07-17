# Plan: Finalize Parking Assistant — single-user MVP

## Overview

Scope for this plan is a **single-operator MVP**: one person runs the admin UI, there is **no
multi-user authentication or RBAC**, and **Yandex Messenger / bot-adapter integration is
deferred** until the core logic and UI are finalized. The goal is a correct, maintainable
single-user product, not the full multi-channel system.

The codebase is feature-broad but unfinished where it matters: ~12k lines of business logic in
two monolithic `server.js` files, `packages/domain`/`packages/jobs` empty, **two competing
DB-access patterns** (`repositories/db.js` `queryOne/queryMany` vs. inline `client.query` in
`services/availability.js`), and almost no test coverage.

Order of work:

1. **Phase 0 — build the test safety net first** (characterization + a Postgres integration harness).
2. **Phase 1 — decompose the monoliths the right way** (strangler-fig: lock behavior with golden
   tests, then peel off layers repository → domain → controller, one bounded context at a time,
   with enforced dependency direction).
3. **Phase 2 — finalize the core single-operator logic and UI** (jobs/scheduling + a defect sweep).
4. **Phase 3 — MVP wrap-up** (end-to-end test, minimal runnable deploy, light review).

**Target architecture (the contract the split converges on):**

```
controller  → HTTP I/O only: parse/validate request, call service, serialize response
service     → use-case orchestration + transaction boundaries (withTransaction)
repository  → ALL SQL; the only layer that talks to pg
domain      → pure business rules, ZERO I/O deps (no pg, no node:http, no shared/http)
```

Dependency direction is one-way: `controller → service → repository`, any layer → `domain`.
`router.js` already injects a `handlers` object — that is the seam we widen, not rewrite.

**Ordering rule:** no behavior-changing task ships without tests pinning the behavior first, and
no task is complete unless every validation command passes.

**How to run this with ralphex:**
- One task at a time first: `ralphex --tasks-only docs/plans/finalize-development.md`
- Full loop with reviews once trusted: `ralphex docs/plans/finalize-development.md`
- `--serve` for the dashboard. Start on a throwaway branch; review every commit.

## Validation Commands

- `npm run check`
- `npm run lint`
- `npm test`

(Integration tests are introduced in Task 2 and run explicitly via `npm run test:integration`
inside the tasks that need a Postgres test database; they are intentionally NOT global validation
commands so early tasks don't fail on a not-yet-created script.)

---

## Phase 0 — Test safety net (before any refactor or feature work)

### Task 1: Characterization tests for pure business logic
- [ ] Identify pure/near-pure logic in `apps/api/src/server.js` and `apps/api/src/services/availability.js` (19:00/07:00 cut-offs, 5-guest reserve math, conflict/early-departure calc, line-position ordering).
- [ ] Add `node:test` unit tests asserting current behavior (happy path + boundary + invalid input). Do not move code yet — just pin behavior.
- [ ] Cover `packages/shared/http.js` and `packages/shared/html.js` (escaping), which have no tests.
- [ ] Run `npm run check && npm run lint && npm test`; all green.
- [ ] Mark completed.

### Task 2: Postgres-backed integration test harness
- [ ] Add a `test:integration` npm script running `node --test` over `**/*.itest.js`.
- [ ] Provide an ephemeral Postgres (compose service or documented `DATABASE_URL_TEST`) and a setup helper that applies `packages/db/schema/*.sql` + seeds into a scratch schema per run.
- [ ] Add one smoke integration test: boot the api handler layer against the test DB, hit `/health` and one read endpoint, assert 200 + payload shape.
- [ ] Document the harness in `AGENTS.md` and `SETUP.md`.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 3: Core-flow integration tests
- [ ] Reservations: `handleAdminManualReservationCreate` and `handleAdminGuestParkingRequestAssign` succeed, and a second assignment to the same place/date is rejected (concurrency guard); assert `warnings` is returned and audit-logged.
- [ ] Queue: `handleAdminQueueProcess`/`handleAdminJobProcessQueue` skip manually-assigned users and respect ordering.
- [ ] Releases: post-19:00 same-day return rejected once the day is frozen.
- [ ] Line occupancy: position uniqueness per date and "who is ahead" derivation.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

---

## Phase 1 — Decompose the monoliths (strangler-fig, behind the Phase 0 net)

### Task 4: Define target architecture, module map, and boundary enforcement
- [ ] Write `docs/adr/003-modular-architecture.md` capturing the controller/service/repository/domain contract and the one-way dependency rule.
- [ ] Reconcile the two DB patterns: standardize on `repositories/` (`queryOne`/`queryMany`) and add a `withTransaction(pool, fn)` helper yielding a client-bound repository; declare inline `client.query` in services deprecated.
- [ ] Lock the layout `apps/api/src/modules/<context>/{controller,service,repository}.js` and enumerate the bounded contexts: `employees`, `places`, `permanent-assignments`, `place-releases`, `employee-requests`, `guest-requests`, `reservations`, `queue`, `line-occupancy`, `departure-plans`, `conflicts`, `contact-access`, `maps`, `dashboard`, `audit`, `jobs`.
- [ ] Add ESLint `no-restricted-imports` rules: `packages/domain/**` may not import `pg`, `node:http`, or `packages/shared/http|html`; `**/controller.js` may not import `pg`.
- [ ] No code moves yet. `npm run check && npm run lint && npm test` green.
- [ ] Mark completed.

### Task 5: HTTP golden/characterization harness (behavior lock)
- [ ] Build a golden-response test over the test DB: for a representative request per endpoint group, snapshot `(status, payload)` under `apps/api/test/golden/`.
- [ ] These snapshots are the contract the split must preserve; every later Phase 1 task re-runs them and they must stay identical unless a change is explicitly intended.
- [ ] Document how to regenerate snapshots deliberately (never blindly).
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 6: Extract the repository layer (isolate all SQL) — iterate per context
- [ ] For ONE bounded context per iteration, move every SQL string out of `server.js`/`services` into `modules/<context>/repository.js`, using `queryOne`/`queryMany` and `withTransaction` for multi-statement operations. No behavior change.
- [ ] Convert `services/availability.js` inline SQL into the relevant repositories.
- [ ] After each context, re-run golden + integration tests; keep green before moving on.
- [ ] When all contexts are done, no raw SQL remains outside `repository.js` files. Run all validation commands; green.
- [ ] Mark completed.

### Task 7: Extract pure business rules into packages/domain
- [ ] Move scheduling/reserve/queue/early-departure/line-ordering/conflict rules into `packages/domain` as pure functions with no I/O imports; services call them with data fetched via repositories.
- [ ] Relocate and expand the Phase 0 unit tests next to the domain code.
- [ ] Golden tests unchanged; run all validation commands; green.
- [ ] Mark completed.

### Task 8: Extract controllers and per-module route tables
- [ ] Move each handler group into `modules/<context>/controller.js` (request parse + validation → service → serialize). Services own transactions; controllers hold no SQL.
- [ ] Replace `router.js`'s monolithic `if/else` + `rootEndpoints` list with per-module route tables the router composes; keep every URL, method, and payload identical.
- [ ] Reduce `apps/api/src/server.js` to a thin bootstrap (pool, handler wiring, http server).
- [ ] Golden + integration tests unchanged; run all validation commands; green.
- [ ] Mark completed.

### Task 9: Turn on and verify the boundaries
- [ ] Enable the dependency-direction ESLint rules repo-wide and fix all violations.
- [ ] Verify no controller contains raw SQL and no domain module imports pg/http; add a small test or lint check asserting it.
- [ ] Remove now-orphaned code from the former monolith; confirm no dead exports remain.
- [ ] Run `npm run check && npm run lint && npm test && npm run test:integration`; all green.
- [ ] Mark completed.

### Task 10: Split apps/admin-web the same way
- [ ] Extract `render*` into `pages/` and `components/`; separate data-fetching (api-client calls) from pure HTML rendering functions.
- [ ] Add render smoke tests: each page renderer given a fixture model returns non-empty, correctly-escaped HTML.
- [ ] Keep tabs and HTML output identical. Run all validation commands; green.
- [ ] Mark completed.

---

## Phase 2 — Finalize core single-operator logic & UI

### Task 11: Harden scheduled jobs
- [ ] Ensure freeze-next-day (19:00), unlock-employee-pool (19:00, honoring the 5-guest reserve), lock-departure-edit (07:00), process-queue (day start), and rebuild-conflicts live in `packages/jobs`/`modules/jobs` and are idempotent.
- [ ] Record each run in `job_runs` with status/outcome; make re-runs safe.
- [ ] Integration tests: each job produces the expected state transition and is a no-op on second run.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

### Task 12: Logic & UI finalization sweep
- [ ] Walk each admin-web tab (День, Заявки, Линии, Справочники, Журнал, Карта) and its backing endpoints end-to-end for the single-operator flow; list any defects, placeholders, or dead UI.
- [ ] Fix the defects surfaced here and by the Phase 0 tests; remove placeholder/dead UI.
- [ ] Add focused tests for each defect fixed so it can't regress.
- [ ] Run all validation commands; green.
- [ ] Mark completed.

---

## Phase 3 — MVP wrap-up

### Task 13: End-to-end happy-path integration test
- [ ] One integration test walking a full day: import catalog → permanent assignment → release → employee request → queue process → guest assignment with warning → line occupancy → contact access → audit-trail assertions.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 14: Minimal runnable deployment
- [ ] Add the missing `jobs` Dockerfile and wire `postgres` + `api` + `admin-web` + `jobs` into `docker-compose.yml` (bot-adapter excluded until the Yandex phase).
- [ ] Provide a documented `.env` for the single-operator setup; `docker compose config` validates and the stack starts locally.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

### Task 15: Lightweight review pass
- [ ] Run `ralphex --review` on the accumulated branch; triage findings.
- [ ] Confirm: all SQL parameterized (no string-concatenated user input), input validation on every write endpoint, consistent error payloads, boundaries still enforced.
- [ ] Fix issues; re-run all validation commands; all green.
- [ ] Mark completed.

---

## Deferred — post-MVP (do NOT build now)

These are intentionally out of scope for the single-user MVP. Revisit after the logic and UI
above are finalized.

- **Yandex Messenger integration & bot-adapter scenarios** — release-place, request-parking,
  guest-request, departure-plan, line-position, blocking-contacts; shared-helper reuse; the
  backend api-client and service-to-service auth. Build **after** full logic & UI finalization.
- **Authentication, sessions, RBAC, admin-users management** — only needed when moving beyond a
  single operator. The schema (`auth_users`/`auth_sessions`/`auth_roles`) is already in place for
  when this is picked up.
- **Structured logging + correlation ids** across services.
- **OpenAPI / API documentation** for Bot/Admin/System-admin APIs.
- **Remaining ADRs** (messenger integration, timezone strategy, floor-map storage, Excel import,
  auth & RBAC) beyond the modular-architecture ADR written in Task 4.
- **Deployment hardening** — reverse proxy, secret management, bot-adapter Dockerfile, deploy
  templates, persistent storage policies.
