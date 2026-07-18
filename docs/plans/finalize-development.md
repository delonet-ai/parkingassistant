# Plan: Finalize Parking Assistant — single-user MVP

## Overview

Scope is a **single-operator MVP**: one person runs the admin UI, **no multi-user auth/RBAC**, and
**Yandex Messenger / bot-adapter is deferred** until the core logic and UI are finalized.

Primary near-term goal: **get the business logic complete enough that the UI is fully testable on
the test stand.** The plan is ordered so that milestone is reached before the (optional-for-testing)
monolith decomposition:

1. **Phase 0 — test safety net** (characterization + Postgres integration harness).
2. **Phase 1 — runtime & data** so the stack deploys to the stand with a working DB and demo data.
3. **Phase 2 — finalize core logic & UI** (jobs + a defect sweep across every tab). → **UI testable.**
4. **Phase 3 — decompose the monoliths** (strangler-fig; maintainability, do after UI is testable).
5. **Phase 4 — wrap-up** (end-to-end test, review).

**Test stand** (see `docs/TECHNICAL_README.md` → Deployment → Test Stand): `192.168.0.100`, Portainer
stack from `main`, ports API `3330` / Admin `3340` / Bot `3350`. Deploy flow = push `main` → Portainer
Git stack redeploy. Secrets (Portainer token, SSH) live outside the repo.

**Target architecture (the contract the Phase 3 split converges on):**

```
controller  → HTTP I/O only: parse/validate request, call service, serialize response
service     → use-case orchestration + transaction boundaries (withTransaction)
repository  → ALL SQL; the only layer that talks to pg
domain      → pure business rules, ZERO I/O deps (no pg, no node:http, no shared/http)
```

Dependency direction is one-way: `controller → service → repository`, any layer → `domain`.

**Ordering rule:** no behavior-changing task ships without tests pinning the behavior first, and no
task is complete unless every validation command passes.

**How to run this with ralphex:** see the run command at the bottom of the repo README / the
session notes. Start on a branch that has the guardrails, `--tasks-only` first, review every commit.

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
- [ ] Identify pure/near-pure logic in `apps/api/src/server.js` and `apps/api/src/services/availability.js` (19:00/07:00 cut-offs, 5-guest reserve math, conflict/early-departure calc, line-position ordering). Do not move code yet — just pin behavior.
- [ ] Add `node:test` unit tests asserting current behavior (happy path + boundary + invalid input).
- [ ] Cover `packages/shared/http.js` and `packages/shared/html.js` if not already covered.
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
- [ ] Reservations: manual + guest assignment succeed; a second assignment to the same place/date is rejected (concurrency guard); `warnings` is returned and audit-logged.
- [ ] Queue: `process` skips manually-assigned users and respects ordering.
- [ ] Releases: post-19:00 same-day return rejected once the day is frozen.
- [ ] Line occupancy: position uniqueness per date; "who is ahead" derivation.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

---

## Phase 1 — Runtime & data (make the app deployable and UI-testable on the stand)

### Task 4: Schema + seed apply automation
- [ ] Add an idempotent DB init/migrate step (`npm run db:migrate`) that applies `packages/db/schema/*.sql` in order and the base seeds, safe to re-run.
- [ ] Ensure it runs on stack startup (init container or entrypoint) so a fresh Portainer deploy comes up with the full schema.
- [ ] Integration test: applying migrations twice on a clean DB is a no-op the second time and leaves the expected tables.
- [ ] Document in `docs/TECHNICAL_README.md` and `SETUP.md`.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 5: Demo/test dataset for UI
- [ ] Add a `packages/db/seeds` demo dataset + `npm run db:seed:demo` that loads realistic data so every admin tab renders content: parking places (single/double/triple), a line group, employees (with/without permanent places), permanent assignments, an active release, an employee request, a guest request, a reservation, a departure plan.
- [ ] Make it idempotent / clearly separated from production seeds; document how to load and reset it.
- [ ] Integration test: after `db:seed:demo`, the dashboard and each list endpoint return non-empty data.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 6: Stand deployment readiness & smoke checks
- [ ] Ensure `postgres` + `api` + `admin-web` + `jobs` are all defined in `docker-compose.yml` / the Portainer stack, with the storage mounts from the README (`postgres`, `maps`, `imports`, `logs`, `backups`) and the migrate/seed step wired in. (bot-adapter stays excluded until the Yandex phase.)
- [ ] Add the missing `jobs` Dockerfile; confirm `api`/`admin-web` images build without mounting sources.
- [ ] Add/verify `/health` on api and a basic reachability check for admin-web; add a `npm run smoke:stand` that checks API `3330`, Admin `3340` health after deploy.
- [ ] Document the redeploy + smoke flow (push `main` → Portainer redeploy → `smoke:stand`) in `docs/TECHNICAL_README.md`. The actual Portainer redeploy is a human/API step, not an agent step.
- [ ] `docker compose config` validates; `npm run check && npm run lint && npm test` green.
- [ ] Mark completed.

---

## Phase 2 — Finalize core single-operator logic & UI  →  UI becomes fully testable

### Task 7: Harden scheduled jobs
- [ ] Ensure freeze-next-day (19:00), unlock-employee-pool (19:00, honoring the 5-guest reserve), lock-departure-edit (07:00), process-queue (day start), and rebuild-conflicts exist and are idempotent, and that the `apps/jobs` scheduler actually invokes them on schedule.
- [ ] Record each run in `job_runs` with status/outcome; re-runs are safe.
- [ ] Integration tests: each job produces the expected state transition and is a no-op on second run.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

### Task 8: Logic & UI finalization sweep (against the seeded stand)
- [ ] With the demo data loaded, walk each admin-web tab (День, Заявки, Линии, Справочники, Журнал, Карта) and its backing endpoints end-to-end; list every defect, placeholder, dead control, or incomplete flow.
- [ ] Fix the defects surfaced here and by the Phase 0/3 tests; remove placeholder/dead UI.
- [ ] Add a focused test for each defect fixed so it can't regress.
- [ ] Confirm the single operator can complete every core flow from the UI: create place/employee, assign permanent, release, employee request → queue process, create+assign guest (with warning), set line position, view blocking contacts, read audit/history, use the map.
- [ ] Run all validation commands; green.
- [ ] Mark completed.

> 🎯 **Milestone:** after Task 8 the business logic is complete for one operator and the UI is fully
> testable on the stand. Phases 3–4 below are maintainability/hardening and can follow at any pace.

---

## Phase 3 — Decompose the monoliths (strangler-fig, behind the test net)

### Task 9: Define target architecture, module map, and boundary enforcement
- [ ] Write `docs/adr/003-modular-architecture.md` capturing the controller/service/repository/domain contract and the one-way dependency rule.
- [ ] Reconcile the two DB patterns: standardize on `repositories/` (`queryOne`/`queryMany`) and add a `withTransaction(pool, fn)` helper yielding a client-bound repository; declare inline `client.query` in services deprecated.
- [ ] Lock the layout `apps/api/src/modules/<context>/{controller,service,repository}.js` and enumerate the bounded contexts (employees, places, permanent-assignments, place-releases, employee-requests, guest-requests, reservations, queue, line-occupancy, departure-plans, conflicts, contact-access, maps, dashboard, audit, jobs).
- [ ] Add ESLint `no-restricted-imports` rules: `packages/domain/**` may not import `pg`/`node:http`/`packages/shared/http|html`; `**/controller.js` may not import `pg`.
- [ ] No code moves yet. `npm run check && npm run lint && npm test` green.
- [ ] Mark completed.

### Task 10: HTTP golden/characterization harness (behavior lock)
- [ ] Golden-response test over the test DB: snapshot `(status, payload)` per endpoint group under `apps/api/test/golden/`.
- [ ] These snapshots are the contract the split must preserve; every later Phase 3 task re-runs them and they must stay identical unless a change is explicitly intended.
- [ ] Document how to regenerate snapshots deliberately.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 11: Extract the repository layer (isolate all SQL) — iterate per context
- [ ] For ONE bounded context per iteration, move every SQL string into `modules/<context>/repository.js` using `queryOne`/`queryMany` and `withTransaction`. No behavior change.
- [ ] Convert `services/availability.js` inline SQL into the repositories.
- [ ] Re-run golden + integration tests after each context; keep green.
- [ ] When done, no raw SQL remains outside `repository.js` files. All validation commands green.
- [ ] Mark completed.

### Task 12: Extract pure business rules into packages/domain
- [ ] Move scheduling/reserve/queue/early-departure/line-ordering/conflict rules into `packages/domain` as pure functions with no I/O imports; services call them with data from repositories.
- [ ] Relocate and expand the Phase 0 unit tests next to the domain code.
- [ ] Golden tests unchanged; all validation commands green.
- [ ] Mark completed.

### Task 13: Extract controllers and per-module route tables
- [ ] Move each handler group into `modules/<context>/controller.js`; controllers hold no SQL, services own transactions.
- [ ] Replace `router.js`'s monolithic `if/else` + `rootEndpoints` list with per-module route tables the router composes; keep every URL/method/payload identical.
- [ ] Reduce `apps/api/src/server.js` to a thin bootstrap.
- [ ] Golden + integration tests unchanged; all validation commands green.
- [ ] Mark completed.

### Task 14: Turn on and verify the boundaries
- [ ] Enable the dependency-direction ESLint rules repo-wide; fix all violations.
- [ ] Verify no controller contains raw SQL and no domain module imports pg/http; add a check asserting it.
- [ ] Remove orphaned code from the former monolith; confirm no dead exports.
- [ ] `npm run check && npm run lint && npm test && npm run test:integration` all green.
- [ ] Mark completed.

### Task 15: Split apps/admin-web the same way
- [ ] Extract `render*` into `pages/` and `components/`; separate data-fetching from pure HTML rendering.
- [ ] Add render smoke tests: each page renderer given a fixture model returns non-empty, escaped HTML.
- [ ] Keep tabs and HTML output identical. All validation commands green.
- [ ] Mark completed.

---

## Phase 4 — Wrap-up

### Task 16: End-to-end happy-path integration test
- [ ] One integration test walking a full day: import catalog → permanent assignment → release → employee request → queue process → guest assignment with warning → line occupancy → contact access → audit-trail assertions.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 17: Lightweight review pass
- [ ] Run `ralphex --review` on the accumulated branch; triage findings.
- [ ] Confirm: all SQL parameterized (no string-concatenated user input), input validation on every write endpoint, consistent error payloads, boundaries still enforced.
- [ ] Fix issues; re-run all validation commands; all green.
- [ ] Mark completed.

---

## Deferred — post-MVP (do NOT build now)

- **Yandex Messenger integration & bot-adapter scenarios** — build after full logic & UI finalization.
- **Authentication, sessions, RBAC, admin-users** — only when moving beyond a single operator (schema already exists).
- **Structured logging + correlation ids**, **OpenAPI docs**, remaining **ADRs**, and **deployment
  hardening** (reverse proxy, secret management, bot Dockerfile, deploy templates).
