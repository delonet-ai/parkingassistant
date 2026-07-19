# Plan: Finalize Parking Assistant — single-user MVP

## Overview

Scope is a **single-operator MVP**: one person runs the admin UI, **no multi-user auth/RBAC**, and
**Yandex Messenger / bot-adapter is deferred** until the core logic and UI are finalized.

Primary near-term goal: **get the business logic complete enough that the UI is fully testable on
the test stand.** The plan is ordered so that milestone is reached before the (optional-for-testing)
monolith decomposition:

1. **Phase 0 — test safety net** (characterization + Postgres integration harness).
2. **Phase 1 — runtime & data** so the stack deploys to the stand with a working DB and demo data.
3. **Phase 2 — finalize core logic & UI**, including the **place-inventory redesign** that replaces
   map-zone drawing with an interactive place list. → **UI testable.**
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

**Language rule:** this plan, all commit messages, code identifiers, comments, and documentation are
written in **English**. End-user-facing UI strings stay in Russian — that is the operator's language.

**No compatibility layers.** This is a pre-release MVP with no production deployment and no external
consumers, so nothing is deprecated, aliased, or kept "just in case". When a task replaces something,
the replaced code, columns, routes, styles, and docs are **deleted in the same task** — not left
behind a flag or a redirect. A task that adds a replacement without removing what it replaced is not
complete. The only thing that survives a replacement is *data* that still has meaning
(see the `place_role` backfill in Task 8).

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

## Design decision: place inventory replaces map-zone drawing

The current Map tab lets the operator **drag a rectangle over a floor plan** to bind a normalized
`{x, y, width, height}` zone to an existing `parking_places` row. That geometry editor is removed
entirely and replaced by a **list of interactive place elements rendered underneath a static floor
plan image**. The rationale: drawing rectangles is fiddly, the geometry carries no business meaning,
and the operator's real task is managing *how many places of which shape exist*, not where the
pixels are.

### What the new model is

- **The floor plan stays, as a static reference image only.** No zones, no click targets, no
  dragging. Per-floor background upload/replace is kept as-is (it is genuinely useful).
- **An "element" is a parking line holding 1–3 slots.** Single = 1 slot, double = 2, triple = 3.
  Each slot is one `parking_places` row; the element itself is one `line_groups` row.
- Adding a triple element **creates three real parking places** and therefore changes the system-wide
  place count, guest reserve math, dashboard totals, and queue capacity. Deleting archives them.
  This is inventory management, not decoration.
- **Element identity is uniform:** every element — including singles — is a `line_groups` row, so the
  UI never has two kinds of identity to juggle. This requires relaxing
  `line_groups.capacity CHECK (capacity IN (2, 3))` to `IN (1, 2, 3)` and backfilling a capacity-1
  group for every currently group-less active place.
- **`line_groups.capacity` is the source of truth for element size;** `parking_places.place_type`
  becomes derived from it and is written by the same transaction. The two must never be edited
  independently — an integration assertion enforces `capacity == count(slots) == place_type`.
- **Place role survives the zone deletion.** The `regular` / `rotatable` / `blocked` classification
  currently lives *inside* `parking_place_map_zones.geometry.zoneType` and nowhere else. It is not
  cosmetic: `rotatable` marks guest-pool places, and guest allocation orders by
  `guest_priority_rank NULLS LAST` (`apps/api/src/server.js:4388`, `:4738`). It is promoted to a
  first-class `parking_places.place_role` column **before** the zones table is dropped, and the
  element UI keeps a per-slot control for it (replacing the old "Тип зоны" select).
- **Delete = archive**, never a hard delete: set `parking_places.is_active = false` and
  `deleted_at = now()`. Reservations, releases, line occupancy, and audit history stay intact and
  readable. Archiving is refused with `409` while the place still has an active reservation for
  today or a future date, or a live permanent assignment — the operator must clear those first, and
  the response names the blockers.

### The interaction principle (carried over unchanged)

Clicking an element slot does exactly what clicking a map zone does today: it **selects that place**
and swaps in the operational place drawer (status, owner, release/assign/cancel actions, guest
request) without a page reload, pushing the day URL via `history.pushState`. Selection is visually
marked on the slot. Everything the drawer offers today it still offers. Only the *selector* changes
— from a rectangle on a canvas to a labelled element in a list.

The editor/operational split is also preserved: the **Day** tab selects and operates, the inventory
tab manages what exists (add/archive). The Day tab must not be able to create or archive places.

### The Map tab becomes the Places tab

Once the tab manages line inventory, calling it "Карта" is wrong twice over: it no longer edits the
map, and it collides with the existing **Линии** tab, which means something entirely different
(`line_occupancy` — who stands in which position *today*). Two adjacent tabs both about "линии",
one about today's occupancy and one about what exists at all, is a trap for the operator.

So the tab is renamed **Места**, and the split reads cleanly:

| Tab | Question it answers |
|---|---|
| **День** | Who is parked where today, and what do I change about today? |
| **Линии** | Who stands in which position in a line today? |
| **Места** | Which parking places exist at all? |

The rename is not just a label — the route key, the whitelist, and the renderer name all carry
`maps` today and must move together (see Task 10).

### UI element specification

Chosen controls — plain HTML, no framework, no build step, consistent with the existing SSR approach:

| Concern | Control | Why |
|---|---|---|
| The element (line) | `<article class="place-line" data-line-id data-capacity>` | Semantic container; capacity drives layout via CSS attribute selector. |
| A slot inside it | `<button type="button" class="place-slot" data-place-id aria-pressed>` | A real button gets keyboard focus, Enter/Space activation, and a native selected state for free. This is what makes the list *more* accessible than the SVG zones were. |
| Add | Toolbar buttons `+ Одинарное` / `+ Двойное` / `+ Тройное` opening a native `<dialog>` | `<dialog>` needs no dependency, traps focus, and closes on Esc. |
| Delete | Per-element button + `<dialog>` confirm naming the affected place codes | The count change must be explicit before it happens. |
| Grouping | One `<section>` per floor (G3/G4/G5), matching the plan image above it | Keeps the list aligned with the drawing the operator is looking at. |
| Layout | CSS grid, `repeat(auto-fill, minmax(...))` | Cards wrap naturally; a triple is a taller card with three stacked slots. |

A multi-slot element renders its slots **stacked in physical order** — front (`line_position_hint`
1) on top, rear at the bottom — so the card visually mirrors the real line and makes "who blocks
whom" obvious at a glance:

```
┌─── Линия G4-118 ──────── тройное ──┐
│  118   перёд      ● свободно       │
│  119   середина   ● занято         │
│  120   зад        ● гостевое       │
└────────────────────── [ удалить ] ─┘
```

Each slot shows the **place code**, its position label (omitted for singles), and its status. Status
is conveyed by **background colour plus a status word** — never colour alone, so the list stays
readable for colour-blind operators and in print. The six existing statuses and their palette are
reused verbatim from the current map legend (`apps/admin-web/src/server.js:3429-3486`):
`free` green, `released` teal, `occupied` honey, `guest` orange, `rotatable` red, `blocked`
graphite. The existing status/type filters carry over and simply hide non-matching elements.

---

## Phase 0 — Test safety net (before any refactor or feature work)

### Task 1: Characterization tests for pure business logic
- [x] Identify pure/near-pure logic in `apps/api/src/server.js` and `apps/api/src/services/availability.js` (19:00/07:00 cut-offs, 5-guest reserve math, conflict/early-departure calc, line-position ordering). Do not move code yet — just pin behavior. — `apps/api/src/server.js` self-starts an HTTP listener on require and exports nothing, so its inline rules are not unit-reachable without moving code (forbidden here); the reachable surface pinned instead is `services/availability.js`, `packages/shared/dates.js` (cut-off comparison semantics, `isEarlyDeparture`), and the existing serializers. The SQL-bound rules (conflict/early-departure query, line-position ordering, queue place-type ordering) are covered by the Task 3 integration tests.
- [x] Add `node:test` unit tests asserting current behavior (happy path + boundary + invalid input). — `apps/api/src/services/availability.test.js` (reserve status at/below minimum, zero minimum, missing row defaults, SQL params) + cut-off comparison tests in `packages/shared/dates.test.js`.
- [x] Cover `packages/shared/http.js` and `packages/shared/html.js` if not already covered. — already covered by `packages/shared/http.test.js` and `html.test.js`.
- [x] Run `npm run check && npm run lint && npm test`; all green. — 40 tests pass.
- [x] Mark completed.

### Task 2: Postgres-backed integration test harness
- [x] Add a `test:integration` npm script running `node --test` over `**/*.itest.js`. — note: integration tests must never live in a directory named `test/`; the default `node --test` discovery picks up *every* `.js` file under such a directory regardless of name, which would drag them into the `npm test` gate.
- [x] Provide an ephemeral Postgres (compose service or documented `DATABASE_URL_TEST`) and a setup helper that applies `packages/db/schema/*.sql` + seeds into a scratch schema per run. — `docker-compose.test.yml` (tmpfs postgres on `5433`) + `packages/db/testing/harness.js` (`createTestDatabase()` → scratch schema `itest_<pid>_<n>`, schema+seed apply, `drop()`); psql meta-commands are stripped since the seeds are written for `psql`.
- [x] Add one smoke integration test: boot the api handler layer against the test DB, hit `/health` and one read endpoint, assert 200 + payload shape. — `apps/api/integration/smoke.itest.js` covers `/health`, `/health/db`, and `/admin/places`; `apps/api/testing/boot-api.js` spawns the API on a free port because `server.js` self-starts its listener on require.
- [x] Document the harness in `AGENTS.md` and `SETUP.md`.
- [x] Run `npm run test:integration`; green. — 5/5 pass against a live Postgres; skips cleanly (not fails) when `DATABASE_URL_TEST` is unset.
- [x] Mark completed.

### Task 3: Core-flow integration tests
- [x] Reservations: manual + guest assignment succeed; a second assignment to the same place/date is rejected (concurrency guard); `warnings` is returned and audit-logged. — `apps/api/integration/reservations.itest.js` (12 tests): manual assignment writes reservation + movement + event + audit; the duplicate is refused by `reservations_active_place_date_uniq` with exactly one active row surviving; guest assignment mints the guest, request and reservation in one call and honours the `single → double → triple, guest_priority_rank NULLS LAST` pick order; the early-departure `warnings` array is asserted both in the response and inside the persisted audit metadata; the guest-reserve refusal is pinned too.
- [x] Queue: `process` skips manually-assigned users and respects ordering. — `apps/api/integration/queue.itest.js` (10 tests): `queue_position` ordering, the `double → triple → single` place preference, the never-give-back-your-own-place skip, the guest-reserve skip, second-run no-op, and `job_runs`/audit bookkeeping. **The premise of this checkbox is false and the test says so:** a manual reservation never closes the employee's queue request, so the user stays a candidate and the run trips `reservations_active_user_date_uniq` and 409s the *whole batch*. Pinned as `CHARACTERIZATION:` — fix belongs to Task 7.
- [x] Releases: post-19:00 same-day return rejected once the day is frozen. — **This rule does not exist in the code.** `apps/api/integration/releases.itest.js` (15 tests) pins what is actually there: create/cancel/overlap/owner validation, the active-reservation cancel guard, cancel idempotency, and availability round-tripping. Three `CHARACTERIZATION:` tests record the gaps — `freeze-next-day` is a read-only snapshot that never sets `frozen_at` or `status='frozen'`, a release is still cancellable after the freeze ran, and releases can be created for past dates. No endpoint compares a date against `APP_TIMEZONE` "now". Implementing the cut-off is Task 7; these tests will fail when it lands, which is the intent.
- [x] Line occupancy: position uniqueness per date; "who is ahead" derivation. — `apps/api/integration/line-occupancy.itest.js` (17 tests): both uniqueness constraints (`line_position_uniq` and `place_date_uniq`) mapping to the same 409, same position allowed on another date, move-not-duplicate semantics, capacity and membership rejection, position-ordered reads, and blocking contacts nearest-first with per-blocker `contact_access_logs`, other-line isolation, and guest redaction.
- [x] Run the validation commands; green. — `npm run check`, `npm run lint`, `npm test` (45) all green; `npm run test:integration` 59/59, verified stable over 12 consecutive runs.
- [x] Mark completed.

**Two defects found and pinned (not fixed here — Phase 0 pins, later tasks fix):**
1. `POST /admin/reservations/cancel` returns 500 for *every* reservation: the handler applies `for update` to a select that `left join`s `users`, which Postgres rejects outright. Because `/admin/place-releases/cancel` refuses while an active reservation stands on the place, the operator currently has **no way to undo an assignment** — both exits are closed. → Task 12.
2. Manual assignment leaves the employee's queue request `queued`, so the next queue run 409s the whole batch (above). → Task 7.

**Harness fix required by this task:** applying the schema concurrently (one `node --test` process per file) raced on `CREATE EXTENSION IF NOT EXISTS`, since extensions are database-wide and the statement is not atomic. `packages/db/testing/harness.js` now serializes the apply step on a `pg_advisory_lock`. This was latent in Task 2 because there was only one integration file.

---

## Phase 1 — Runtime & data (make the app deployable and UI-testable on the stand)

### Task 4: Schema + seed apply automation
- [x] Add an idempotent DB init/migrate step (`npm run db:migrate`) that applies `packages/db/schema/*.sql` in order and the base seeds, safe to re-run. — `packages/db/migrate.js`: applies `schema/*.sql` then `seeds/*.sql` lexicographically and records each file in a `schema_migrations` ledger, so idempotency does not depend on every SQL file being individually re-runnable. `--no-seed` applies schema only. The apply is serialized on the same advisory lock the harness used, since `CREATE EXTENSION IF NOT EXISTS` is database-wide and not atomic.
- [x] Ensure it runs on stack startup (init container or entrypoint) so a fresh Portainer deploy comes up with the full schema. — one-shot `migrate` service in `docker-compose.yml`, `depends_on: postgres: service_healthy`; `api` and `jobs` now wait on `migrate: service_completed_successfully`.
- [x] Integration test: applying migrations twice on a clean DB is a no-op the second time and leaves the expected tables. — `packages/db/integration/migrate.itest.js` (6 tests): first run applies the full planned list, second and third apply nothing, the ledger has exactly one row per file, the expected tables exist, and the bootstrap seed is not duplicated. `createTestDatabase({ apply: false })` was added to hand the runner an empty scratch schema.
- [x] Document in `docs/TECHNICAL_README.md` and `SETUP.md`. — plus `packages/db/schema/README.md`.
- [x] Run `npm run test:integration`; green. — 65/65 against a live Postgres, stable over 4 consecutive runs; `npm run check` / `lint` / `test` (45) green. The CLI was also verified end-to-end against a fresh database: run 1 applies 4 files, run 2 reports `nothing to apply`.
- [x] Mark completed.

**Harness fix required by this task:** teardown (`drop schema ... cascade`) now takes the migration
advisory lock too. `CREATE EXTENSION` runs with the scratch schema on the search_path, so the
extension is created *inside* it and the cascading drop takes the same catalog locks a concurrent
harness takes while creating it — with a sixth integration file in the run that deadlocked (`40P01`).

### Task 5: Demo/test dataset for UI
- [x] Add a `packages/db/seeds` demo dataset + `npm run db:seed:demo` that loads realistic data so every admin tab renders content: parking lines of each size (single/double/triple), employees (with/without permanent places), permanent assignments, an active release, an employee request, a guest request, a reservation, a departure plan. — `packages/db/seeds/demo/001_demo_dataset.sql` + loader `packages/db/seed-demo.js`: 4 line groups (2 doubles, 2 triples) and 5 standalone singles across G3/G4/G5, 13 employees (10 with a permanent place, 3 without), 8 releases (7 active today, 1 starting tomorrow so its owner still stands in the line), an employee request served by the queue + one waiting + one just filed, an assigned guest request + a pending one, a queue reservation and a guest reservation with their events/movements, three departure plans — one early *and* blocked, so `/admin/conflicts` is non-empty — today's line occupancy, a contact-access log, floor plans with zones, and audit rows. Dates anchor on "today" in `Europe/Moscow` (the `APP_TIMEZONE` default) so the set never goes stale.
- [x] Make it idempotent / clearly separated from production seeds; document how to load and reset it. — the demo files live in `packages/db/seeds/demo/`, one level below what `db:migrate` reads (`readSqlDirectory` only takes `*.sql` at the top of `seeds/`), so a Portainer deploy can never pick them up. Idempotent by construction: `npm run db:seed:demo` runs `000_reset.sql` then the dataset, and `npm run db:seed:demo:reset` runs the reset alone. Demo rows are found by a per-table tag (`users.email like '%@demo.invalid'`, `parking_places.catalog_source = 'demo'`, `line_groups.code like 'demo-%'`, `parking_place_maps.source_checksum = 'demo'`, `audit_logs.actor_service = 'db_seed_demo'`), never by id, so the imported catalog and the bootstrap admin survive both operations. Documented in `SETUP.md` and `docs/TECHNICAL_README.md`.
- [x] Integration test: after `db:seed:demo`, the dashboard and each list endpoint return non-empty data. — `packages/db/integration/demo-seed.itest.js` (10 tests): the dashboard, `/admin/availability` (7 released / 5 available / all three place types / guest reserve `ok`) and all 11 admin list endpoints return content; the seeded conflict is asserted by line and place code; loading twice more leaves row counts unchanged; reset removes exactly the demo rows and is itself a no-op on the second run.
- [x] Run `npm run test:integration`; green. — 75/75 against a live Postgres. `npm run check` / `lint` / `test` (45) green. The CLI was also verified end-to-end against a fresh database: migrate → seed → seed again (15 users / 15 places / 2 reservations both times) → reset (0 demo rows, bootstrap admin intact).
- [x] Mark completed.

### Task 6: Stand deployment readiness & smoke checks
- [x] Ensure `postgres` + `api` + `admin-web` + `jobs` are all defined in `docker-compose.yml` / the Portainer stack, with the storage mounts from the README (`postgres`, `maps`, `imports`, `logs`, `backups`) and the migrate/seed step wired in. (bot-adapter stays excluded until the Yandex phase.) — all five services (incl. one-shot `migrate`) present with every README mount; `bot-adapter` **removed** from the stack per the deferral, with a comment saying why (entrypoint and npm script stay in the repo). Published ports now default to the documented stand ports (`3330`/`3340`) instead of `3000`/`3100`. `api` and `admin-web` gained container healthchecks (`node -e fetch(/health)`), so `admin-web` and `jobs` wait on `api: service_healthy` rather than `service_started`.
- [x] Add the missing `jobs` Dockerfile; confirm `api`/`admin-web` images build without mounting sources. — `infra/docker/jobs.Dockerfile` added and wired into compose. All three images were **actually built and run on the OMV server** (`docker build` + `docker run`, sources tarred over, no bind mounts): admin-web answered `/health` `{"status":"ok","service":"admin-web"}`, jobs logged `scheduler_disabled`, and the app image ran `db:migrate` to a clean connection refusal (not a missing-module crash). Throwaway images and the temp build dir were deleted afterwards. Also fixed while here: all three Dockerfiles still had `sleep infinity` placeholder `CMD`s, and the deps stage ran `npm install` without the lockfile — now `npm ci --omit=dev` over `package-lock.json`.
- [x] Add/verify `/health` on api and a basic reachability check for admin-web; add a `npm run smoke:stand` that checks API `3330`, Admin `3340` health after deploy. — both `/health` endpoints already existed (`apps/api/src/router.js:69`, `apps/admin-web/src/server.js:3585`). `scripts/smoke/stand.js` checks `3330/health`, `3330/health/db`, `3340/health` and the `3340/?view=day` render; read-only, so it is safe against prod. Host/ports override via `SMOKE_STAND_*`. Verified against the live stand: 4/4 pass.
- [x] Document the redeploy + smoke flow (push `main` → Portainer redeploy → `smoke:stand`) in `docs/TECHNICAL_README.md`. The actual Portainer redeploy is a human/API step, not an agent step. — new "Состав стека" and "Redeploy и smoke-проверка стенда" sections; the Verification Checklist's four ad-hoc `curl`s are replaced by `npm run smoke:stand` (one of them pointed at `?view=maps`, which Task 10 renames anyway). `SETUP.md`'s stale "Current Limitation" section (placeholder commands) is replaced by a stand-deployment section.
- [x] `docker compose config` validates; `npm run check && npm run lint && npm test` green. — `docker compose config` was run on the real server (no docker CLI in the dev container): `COMPOSE_CONFIG_OK`, services `postgres migrate api admin-web jobs`. `check`/`lint` clean, `npm test` 63 pass. New `infra/deployment.test.js` pins the topology inside the normal `npm test` gate — service list, no bot-adapter, every storage mount, migrate ordering, stand ports, healthchecks, referenced Dockerfiles existing, `npm ci` reproducibility, no placeholder `CMD`, and no source bind mounts.
- [x] Mark completed.

---

## Phase 2 — Finalize core single-operator logic & UI  →  UI becomes fully testable

### Task 7: Harden scheduled jobs
- [x] Ensure freeze-next-day (19:00), unlock-employee-pool (19:00, honoring the 5-guest reserve), lock-departure-edit (07:00), process-queue (day start), and rebuild-conflicts exist and are idempotent, and that the `apps/jobs` scheduler actually invokes them on schedule. — two of the five did not exist and two of the three that did were audit-only no-ops. **`freeze_next_day`** now writes `place_releases.frozen_at` (the column existed since `001` and was never written) and a frozen day refuses release cancellation with `409`; `status` deliberately stays `'active'`, because a frozen release is still a released place the next morning's queue run must hand out — "frozen" means "cannot be withdrawn", not "no longer released", so the unused `frozen` enum value stays unused. **`lock_departure_plans`** now writes `departure_plans.locked_at` (new column, migration `packages/db/schema/004_job_state.sql`) and the plan upsert refuses `409` on a locked plan; the previous 07:00 rule was a wall-clock check that evaporated on the next day rollover. **`unlock_employee_pool`** (new, `POST /admin/jobs/unlock-employee-pool`) settles and announces the employee capacity — everything released minus the guest reserve — so the operator sees at 19:00 how many queued employees will actually be served. **`rebuild_conflicts`** (new, `POST /admin/jobs/rebuild-conflicts`) repairs `departure_plans.is_early` that drifted from the cut-off rule and recomputes the conflict set. The scheduler carries all five, ticks **sequentially** rather than `Promise.all` because `freeze_next_day` must settle the pool before `unlock_employee_pool` measures it at the same 19:00 minute, prunes its completed-run keys across a day rollover, and self-starts only under `require.main === module` so the schedule is unit-testable.
- [x] Record each run in `job_runs` with status/outcome; re-runs are safe. — all five go through the existing `withJobRun` wrapper (status/summary/error + an audit row). Idempotency is enforced by **database state**, not by a scheduler-side flag: `frozen_at is null`, `locked_at is null`, an `is_early` value disagreeing with the rule, and — for the queue — a user who already holds an active reservation. A replay changes nothing and writes **no second audit row**; the `job_runs` row is still recorded, which is the correct distinction between "the run happened" and "the run changed something".
- [x] Integration tests: each job produces the expected state transition and is a no-op on second run. — `apps/api/integration/jobs.itest.js` (24 tests): the state transition and the exact-replay no-op for each of the five, `frozen_at`/`locked_at` not being restamped, no duplicate audit rows, `job_runs` bookkeeping for both runs, the freeze gate on cancel, the lock gate on plan edit, and a second API booted with the real `GUEST_RESERVE_MINIMUM=5` to pin the reserve arithmetic (7 released → pool of 2) and the queue stopping at the reserve floor. Plus `apps/jobs/src/scheduler.test.js` (7 unit tests) pinning the job table, the times, the target-date offsets, and the freeze-before-unlock ordering.
- [x] **Both Phase 0 defects assigned to this task are fixed and their `CHARACTERIZATION:` tests are inverted.** The queue defect is fixed on both sides: `POST /admin/reservations/manual` now closes the employee request and queue entry it just answered, and `processQueueForDate` skips a candidate who already holds an active reservation for the date (`reason: 'already_has_reservation'`) instead of tripping `reservations_active_user_date_uniq` and 409-ing the **whole batch**. `queue.itest.js` and `releases.itest.js` now assert the corrected behavior; `AGENTS.md`'s known-defect list moved them to a "fixed in Task 7" section. The remaining pinned defects (reservation cancel 500s, releases creatable for past dates) are Task 12's, untouched here.
- [x] Run the validation commands; green. — `npm run check` / `lint` clean, `npm test` 71 pass, `npm run test:integration` 99/99 against a live Postgres, stable over 6 consecutive full runs. `db:migrate` was also verified end-to-end against a fresh database: run 1 applies 5 files including `004_job_state.sql`, run 2 reports `nothing to apply`, and `departure_plans.locked_at` plus both new indexes are present. Docs updated: a new "Scheduled Jobs" table and rules section in `docs/TECHNICAL_README.md`, the schedule and the two new `JOB_*_TIME` env vars in `docs/DEPLOYMENT.md`, and `packages/db/schema/README.md` (which also had stale absolute `/Users/deliter/...` links and was missing `003`).
- [x] Mark completed.

### Task 8: Retire map zones, make every place belong to a line (schema)

Migration `packages/db/schema/005_place_inventory.sql` — **note the renumber:** Task 7 took `004`
(`004_job_state.sql`) for the departure-plan lock column. **Step order matters** — the zone table is
read for data before it is dropped:

- [x] 1. Add `CREATE TYPE parking_place_role AS ENUM ('regular', 'rotatable', 'blocked')` and `parking_places.place_role parking_place_role NOT NULL DEFAULT 'regular'`. — the existence guard is `to_regtype('parking_place_role') IS NULL`, **not** a `pg_type.typname` match: the harness runs many scratch schemas in one database and a bare name check sees a sibling schema's type and skips creating this one's.
- [x] 2. Backfill it from the zone geometry; assert the counts match. — a place can carry a zone on more than one floor plan (the unique constraint is per map), so the backfill is a `DISTINCT ON (parking_place_id)` with a deterministic precedence (`blocked` > `rotatable` > `regular`) and the assertion counts `DISTINCT parking_place_id`. It `RAISE EXCEPTION`s rather than warning.
- [x] 3. Only now `DROP TABLE parking_place_map_zones`. Keep `parking_place_maps`.
- [x] 4. Relax `line_groups.capacity` to `CHECK (capacity IN (1, 2, 3))`; add `display_order` and `archived_at`.
- [x] 5. Backfill a capacity-1 line group for every group-less `parking_places` row — **including archived ones**, because step 7's `NOT NULL` applies to every row and not just the active ones. A group that ends up with no active slot is stamped `archived_at` instead of being left dangling.
- [x] 6. Backfill `display_order` from `(floor_label, numeric prefix of the front slot's code, code)`, non-numeric codes last. Pinned by a fixture place with code `G-annex`.
- [x] `RESTRICT` + `NOT NULL` chosen, as the plan prefers. The FK is dropped and re-added as `ON DELETE RESTRICT` before `SET NOT NULL`; the test asserts `delete_rule = 'RESTRICT'` and `is_nullable = 'NO'` from `information_schema` rather than trusting the DDL.
- [x] Reconcile `scripts/import/parking-catalog.js` and `003_infer_line_groups.sql`. — **003 is left as it was on purpose** (it is already in the ledger of every existing database, so editing its behavior would only change fresh ones and let the two drift); it gained a header saying what it deliberately does not do. The import was rewritten: rows are staged in a temp table, lines are derived from the whole batch, and only then are places written with `line_group_id` resolved — `place_type` from `lg.capacity` and `line_position_hint` from code order within the line, never from the spreadsheet wording. This also fixes the old mislabel where a **double's** rear read "задний" → hint 3. `inferPlaceType()` is deleted outright, and a guest place now lands as `place_role = 'rotatable'` — that classification used to live in the zone geometry and would otherwise have been lost at the import boundary. Verified end-to-end against a real generated `.xlsx`: a triple, a double, a guest single and a plain single all land correctly with 0 group-less places.
- [x] Update the Task 5 demo seed to the new model. — 9 elements now (2 doubles, 2 triples, 5 singles, each a `line_groups` row with an explicit `display_order`), `place_role` set directly, the zone INSERT and its reset counterpart deleted, `place_type` derived from `lg.capacity` in the seed itself.
- [x] Integration test. — `packages/db/integration/place-inventory.itest.js` (12 tests) applies 001–004 by hand, plants a pre-redesign fixture (a real double, a group-less single, a group-less *archived* single, a non-numeric code, zones carrying all three roles, plus users/permanent assignments as untouched-data canaries), then applies 005: role promotion, the non-regular count, the table drop with the maps kept, zero group-less places, single-slot adoption, the archived-line rule, capacity ↔ slot count ↔ `place_type` agreement, `display_order` ordering, `NOT NULL` + `RESTRICT` read back from `information_schema`, capacity 1 accepted while 0 and 4 are refused, a byte-for-byte untouched-data comparison, and a second apply changing nothing.
- [x] Run `npm run test:integration`; green. — 111/111 against a live Postgres, stable over 8 consecutive full runs with zero deadlocks. `npm run check` / `lint` clean, `npm test` 71 pass. `db:migrate` verified end-to-end on a fresh database (run 1 applies 6 files including `005_place_inventory.sql`, run 2 reports `nothing to apply`), as were `db:seed:demo`, a reload, and `db:seed:demo:reset` (demo rows gone, imported catalog and bootstrap admin intact).
- [x] Mark completed.

**Harness fix required by this task:** `CREATE EXTENSION IF NOT EXISTS` in `001` ran with the
scratch schema first on the `search_path`, so the *first* test file to run planted `btree_gist`
**inside its own scratch schema** and every later schema silently borrowed that one's operator
classes for its exclusion constraints. One file's `drop schema ... cascade` then had to cascade
into another file's live constraints, and the two deadlocked mid-test (`40P01`) — which is why the
failures landed on unrelated suites and moved around between runs. `packages/db/testing/harness.js`
now creates both extensions `WITH SCHEMA public` before the apply, making the `IF NOT EXISTS` in
`001` a no-op and each scratch schema genuinely self-contained. This was latent since Task 2 and
an eighth integration file made it reproducible.

**Known intermediate state, by the plan's own ordering:** the five zone endpoints
(`/admin/map-zones*`, `/admin/map-diagnostics`) and the admin-web drawing UI still query the table
this task drops, so they now fail at runtime. Task 9 deletes the endpoints and Task 10 the UI. No
test covers them, so every validation command stays green.

### Task 9: Place inventory API (list / create / archive elements)

**Reuse before inventing.** `/admin/places`, `/admin/places/update`, and `/admin/line-groups` already
exist (`apps/api/src/router.js:15-23`). The new endpoints are a *line-level composition* over the
existing per-place ones, not a parallel API. After this task there is exactly one way to do each
thing: edit one place's attributes → `/admin/places/update`; take one slot out of service →
`place_role = 'blocked'`; add or remove places → `/admin/place-lines`. `is_active` has a single
write path, in the place-lines service.

- [x] Delete the zone endpoints and their handlers: `handleAdminMapZonesList`, `handleAdminMapZoneSave`, `handleAdminMapZoneUpdate`, `handleAdminMapZoneDelete`, plus their routes and the geometry validation helpers. Keep background upload and map diagnostics. — all four handlers, their `rootEndpoints` entries, their routes and the normalized-rectangle validation are gone; `handleAdminMapBackgroundUpdate` is untouched. The admin-web drawing UI still calls them and now 404s — that is Task 10's deletion, by the plan's own ordering.
- [x] Add `GET /admin/place-lines?floor=&date=` returning elements ordered by `display_order`: `{ lineId, code, capacity, floorLabel, slots: [{ placeId, code, position, placeRole, status, userDisplayName }] }`. `status` keeps the old precedence, now reading `place_role` instead of `geometry.zoneType`: `occupied` → `guest` → `released` → `blocked` → `rotatable` → `free`. — `placeSlotStatus()` is the single implementation of the precedence; `occupied` vs `guest` is decided by `reservations.source`, `released` by an active release covering the date.
- [x] Add `POST /admin/place-lines` — body `{ floorLabel, capacity: 1|2|3, slots: [{ code, title, placeRole, guestPriorityRank }] }`. In one transaction: create the `line_groups` row, create `capacity` `parking_places` rows with `place_type` derived from capacity and `line_position_hint` 1..capacity, audit `place_line_created`. Reject on duplicate place code (`409`), bad capacity, or slot count ≠ capacity (`400`). — `place_type` and `display_order` are not computed in JS: the transaction calls the `assign_place_lines()` function migration 005 installed, so the "capacity is the source of truth" rule keeps exactly one implementation shared with the catalog import.
- [x] `guestPriorityRank` must be settable at creation. Guest allocation orders by `guest_priority_rank NULLS LAST`, so a new place created without it silently sorts last forever — the operator has to be able to say "this new place is in the guest pool" without a second trip to `/admin/places/update`. — accepted per slot alongside `placeRole`, validated as an integer 1..99, and pinned by a test that creates two rotatable singles out of rank order and asserts the guest lands on the higher-priority one.
- [x] Add `POST /admin/place-lines/archive` — body `{ lineId }`. Refuse with `409` and a named list of blockers if any slot has an active reservation for today or later, or a live permanent assignment. Otherwise set `is_active = false, deleted_at = now()` on all slots, set `line_groups.archived_at`, and audit `place_line_archived`. — blockers come back as `[{ type, placeCode, detail, userDisplayName }]`; a refused archive rolls back and changes nothing. "Today or later" is evaluated in `APP_TIMEZONE`, and a permanent assignment ending *today* still blocks — the owner holds the place until the day is over.
- [x] **Delete `/admin/places/disable`** rather than teaching it the new blocker rule. Once `place_role = 'blocked'` marks a single slot out of service and line archiving removes places, a third way to deactivate one place is redundant — and a second write path to `is_active` is exactly the kind of drift the no-compatibility rule exists to prevent. Remove the route (`apps/api/src/router.js:17`, `:136`), its handler, the admin-web proxy (`apps/admin-web/src/server.js:3965-3971`), and the form at `:2698`, replacing that form with the place-role control. — done, and the **second** write path went with it: `/admin/places/update` no longer writes `is_active` either (the field is silently ignored), so archiving is the only way a place leaves service. `POST /admin/places` no longer accepts `isActive`. Both `/admin/places` and `/admin/places/update` now carry `placeRole` instead.
- [x] Rewrite the map diagnostics to the new model: report places missing a line group, and groups whose slot count disagrees with `capacity`. Drop the zone-based diagnostics. — `placeWithoutLine` (structurally impossible since 005, checked anyway so a dropped constraint surfaces here rather than through a broken list) and `lineCapacityMismatch`. The admin-web diagnostics tables were repointed at the new keys in the same task so they do not silently render three empty boxes.
- [x] Integration tests: create single/double/triple; created places appear in dashboard counts and availability; a `rotatable` place created with a guest rank lands in guest allocation order; archive is blocked by an active reservation and succeeds once it is cleared; `is_active` has no other write path (asserted by test, not by convention); archived places disappear from availability, guest reserve math, and the queue but remain readable in history. — `apps/api/integration/place-lines.itest.js` (28 tests), including the partial-write check that a 409 on a duplicate code leaves no half-built line, both blocker types by name, and the past-dated reservation that deliberately does *not* block.
- [x] Run `npm run test:integration`; green. — 139/139 against a live Postgres, stable over 4 consecutive full runs. `npm run check` / `lint` clean, `npm test` 71 pass.
- [x] Mark completed.

**Three defects found and fixed while wiring the propagation tests** (all three were latent
until archiving existed, and each would have made "delete = archive" a lie):

1. Availability, the dashboard, the guest/employee auto-assign pick and the queue pick all
   join `place_releases → parking_places` without filtering `deleted_at`, so an archived place
   with a surviving release row still counted toward availability, the guest reserve, and the
   queue's inventory. All six sites now filter `pp.deleted_at is null`.
2. `/admin/places/update` wrote `line_group_id = $6` unconditionally, so any update that did not
   resend the line orphaned the place — a `NOT NULL` violation since Task 8, i.e. every update
   posted from the catalog form 500'd. It now coalesces to the current line.
3. `GET /admin/places/:id/history` filtered `deleted_at is null`, so archiving a place made its
   own history unreadable — the exact thing archiving instead of deleting is for. Filter removed.

### Task 10: Shared place-element renderer + Места tab (inventory editor)
- [x] Add a pure renderer in `apps/admin-web/src/` producing the element grid from a model — `renderPlaceLines(model, { mode })` where `mode` is `'operational'` or `'editor'`. No SQL, no fetching; it takes data and returns escaped HTML. — `apps/admin-web/src/render-place-lines.js`. It also owns `PLACE_ROLE_OPTIONS` (moved out of `server.js`) and the six status tokens, so the two tabs cannot drift on labels.
- [x] Render per the spec above: `<article class="place-line" data-capacity>` containing `<button class="place-slot" aria-pressed>` per slot, stacked front→rear, each showing place code, position label (multi-slot only), and status as colour **plus** word. Reuse the six existing status colour tokens. — the palette moved verbatim from `.map-zone-status-*` to `.place-slot--*` / `.place-status-*`; an unknown status degrades to `free` rather than emitting an unstyled class.
- [x] Rewrite `renderMapEditorTab` → `renderPlacesTab`: keep the per-floor background upload panel and the diagnostics tables; delete the edit-mode checkbox, place/zone-type selects, the `.maps-grid` SVG cards, and the entire inline drawing script (`pointerdown`/`pointermove`/`pointerup`, `svgPoint`, `normalizedRect`, `saveZone`, `updateZoneType`, `deleteZone`, `renderZonesList`). Render the static floor plan as a plain `<img>` and the element grid below it in `'editor'` mode. — the tab shows one floor at a time (the existing `mapCode` selector), so the plan image and the element list underneath always describe the same floor. The diagnostics table header lost its now-meaningless «Карта» column.
- [x] Carry the rename through every place the old key appears — the tab label, the `activeView` whitelist, `mapsHref` → `placesHref`, every `?view=maps` link (including the two `/admin/map-backgrounds` redirects), and the `maps:` module key in `render-modules.js`. The stale `mapCode.replace(/^g/, '')` conversions collapsed into one documented `mapCodeToFloorLabel()` helper, which Task 11 reuses.
- [x] No alias for the old `?view=maps` URL — verified against a running admin-web: `?view=maps` now falls through the whitelist to `day`.
- [x] Delete what the static `<img>` makes dead: the `width`/`height` fields in the `parkingMaps` catalog and the `.map-zone-*`, `.maps-grid`, `.map-draft-zone`, `.map-zone-selected`, `.map-svg`, `.map-editing-enabled`, `.map-edit-toggle`, `.map-toolbar` CSS rules. The six `.map-zone-status-*` colour rules were **renamed**, not deleted — they are the tokens the new slots and the (still live) place drawer share.
- [x] Add the `+ Одинарное` / `+ Двойное` / `+ Тройное` toolbar and its `<dialog>`: floor is prefilled from the selected floor, one code+title field per slot, next free numeric code suggested. Submits to `POST /admin/place-lines`, then refreshes the list and reports the API error inline on `409`/`400`. — one `<dialog>` serves all three sizes; the slots beyond `capacity` are `hidden` **and** `disabled`, and `nextFreePlaceCode()` suggests max(numeric code on the floor)+1.
- [x] Add per-element archive with a confirm `<dialog>` that names every affected place code and states the resulting place count. Surfaces the `409` blocker list verbatim.
- [x] Keep a per-slot **place role** control (Обычное / Ротируемое-гостевое / Недоступное) in editor mode. It writes `place_role` via `/admin/places/update`. — the form resends `linePositionHint`/`guestPriorityRank`/`placeType`, because that endpoint overwrites those columns instead of coalescing them; a role-only edit that omitted them would silently wipe a guest rank. A new `returnView=places` field keeps the operator on the tab they edited from instead of bouncing them into Справочники.
- [x] Render smoke tests: `apps/admin-web/src/render-place-lines.test.js` (13 tests) — slot count per capacity, front→rear order, position labels present for multi-slot and absent for singles, a class **and** a word for all six statuses, unknown-status fallback, exactly one `aria-pressed="true"`, editor-only controls, the resent update fields, per-floor sectioning, escaping of code/owner/line values, and a non-blank empty state.
- [x] Run the validation commands; green. — `npm run check` / `lint` clean, `npm test` 84 pass (71 + 13). The tab was also rendered end-to-end against a stubbed API: `?view=places` returns 200 with the element grid, both dialogs, the role selects, the diagnostics table and no `undefined` in the markup.
- [x] Mark completed.

**Known intermediate state, by the plan's own ordering:** `renderOperationalMap` (the Day tab) still emits the
zone SVG, whose `/admin/map-zones` endpoint Task 9 already deleted and whose `map.width`/`map.height`
and CSS this task deletes. That map has therefore been non-functional since Task 9; Task 11 replaces it
with `renderPlaceLines(..., { mode: 'operational' })`. The place drawer, the legend and every drawer
action on that tab are untouched and still work.

### Task 11: Day tab operates on elements instead of zones
- [ ] Replace `renderOperationalMap` with the static floor plan `<img>` plus `renderPlaceLines(..., { mode: 'operational' })`. Delete the function's SVG zone rendering, zone click wiring, `.map-zone-selected` handling, the client-side zone filtering loop, and the label-size heuristic (`box.width >= 36 && box.height >= 18`) — none of it has a consumer once zones are gone.
- [ ] Preserve the selection principle exactly: clicking a slot sets `aria-pressed`, fetches `/admin/operational-place-card`, swaps the `.place-drawer` aside without reload, and `history.pushState`s the day URL; `popstate` restores selection. Keyboard: Tab to a slot, Enter/Space selects.
- [ ] Keep the drawer unchanged — status, owner/assignment/release/line-position grid, "Отдать место на день", "Назначить сотрудника", "Отменить назначение", the guest-request `<details>` block, and the link to place history — including the hidden `placeId`/`date` fields that restore the day view after a redirect. Replace the `mapCode` field with the floor selector's value, keeping the existing convention that map code `g4` maps to `parking_places.floor_label` `4` (`mapCode.replace(/^g/, '')`, used today at `apps/admin-web/src/server.js:344` and `:744`) — document it rather than re-deriving it ad hoc in a third place.
- [ ] Keep the status/type filters and the legend, applied to elements instead of zones.
- [ ] Integration/render tests: selecting a slot yields the same drawer payload the zone click produced; every drawer action still round-trips.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

### Task 12: Logic & UI finalization sweep (against the seeded stand)
- [ ] With the demo data loaded, walk each admin tab (День, Заявки, Линии, Справочники, Журнал, Места) and its backing endpoints end-to-end; list every defect, placeholder, dead control, or incomplete flow.
- [ ] Confirm the Линии / Места boundary holds in practice: Линии shows only today's occupancy, Места shows only what exists. If a control on one tab is really answering the other tab's question, move it.
- [ ] Fix the defects surfaced here and by the Phase 0 tests; remove placeholder/dead UI.
- [ ] Verify the retired code path left nothing behind: `grep -ri 'zone\|geometry\|normalizedRect\|svgPoint\|viewBox\|view=maps'` over `apps/`, `packages/`, `scripts/`, and `docs/` returns hits **only** in migration `004` and its changelog entry. Anything else is a leftover and gets deleted, not documented.
- [ ] Add a focused test for each defect fixed so it can't regress.
- [ ] Confirm the single operator can complete every core flow from the UI: add a single/double/triple element, archive one, create place/employee, assign permanent, release, employee request → queue process, create+assign guest (with warning), set line position, view blocking contacts, read audit/history.
- [ ] Verify the inventory change propagates system-wide: adding and archiving elements moves dashboard totals, availability, the 5-guest reserve, and queue capacity consistently.
- [ ] Update `docs/TECHNICAL_README.md`, `docs/ERD.md`, `docs/ARCHITECTURE.md`, and `README.md` to describe the place-inventory model, the Карта → Места rename, and drop every mention of zone geometry.
- [ ] Run all validation commands; green.
- [ ] Mark completed.

> 🎯 **Milestone:** after Task 12 the business logic is complete for one operator and the UI is fully
> testable on the stand. Phases 3–4 below are maintainability/hardening and can follow at any pace.

---

## Phase 3 — Decompose the monoliths (strangler-fig, behind the test net)

### Task 13: Define target architecture, module map, and boundary enforcement
- [ ] Write `docs/adr/003-modular-architecture.md` capturing the controller/service/repository/domain contract and the one-way dependency rule.
- [ ] Write `docs/adr/004-place-inventory.md` recording the Phase 2 decision: zone geometry removed, elements are 1–3-slot lines, delete means archive.
- [ ] Reconcile the two DB patterns: standardize on `repositories/` (`queryOne`/`queryMany`) and add a `withTransaction(pool, fn)` helper yielding a client-bound repository; inline `client.query` in services is not deprecated but removed outright by Task 15, which leaves no SQL outside `repository.js` files.
- [ ] Lock the layout `apps/api/src/modules/<context>/{controller,service,repository}.js` and enumerate the bounded contexts (employees, places, place-lines, permanent-assignments, place-releases, employee-requests, guest-requests, reservations, queue, line-occupancy, departure-plans, conflicts, contact-access, maps, dashboard, audit, jobs).
- [ ] Add ESLint `no-restricted-imports` rules: `packages/domain/**` may not import `pg`/`node:http`/`packages/shared/http|html`; `**/controller.js` may not import `pg`.
- [ ] No code moves yet. `npm run check && npm run lint && npm test` green.
- [ ] Mark completed.

### Task 14: HTTP golden/characterization harness (behavior lock)
- [ ] Golden-response test over the test DB: snapshot `(status, payload)` per endpoint group under `apps/api/test/golden/`.
- [ ] These snapshots are the contract the split must preserve; every later Phase 3 task re-runs them and they must stay identical unless a change is explicitly intended.
- [ ] Document how to regenerate snapshots deliberately.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 15: Extract the repository layer (isolate all SQL) — iterate per context
- [ ] For ONE bounded context per iteration, move every SQL string into `modules/<context>/repository.js` using `queryOne`/`queryMany` and `withTransaction`. No behavior change.
- [ ] Convert `services/availability.js` inline SQL into the repositories.
- [ ] Re-run golden + integration tests after each context; keep green.
- [ ] When done, no raw SQL remains outside `repository.js` files. All validation commands green.
- [ ] Mark completed.

### Task 16: Extract pure business rules into packages/domain
- [ ] Move scheduling/reserve/queue/early-departure/line-ordering/conflict rules into `packages/domain` as pure functions with no I/O imports; services call them with data from repositories.
- [ ] Include the line-inventory rules: capacity ↔ slot count, position assignment, archive-blocker detection.
- [ ] Relocate and expand the Phase 0 unit tests next to the domain code.
- [ ] Golden tests unchanged; all validation commands green.
- [ ] Mark completed.

### Task 17: Extract controllers and per-module route tables
- [ ] Move each handler group into `modules/<context>/controller.js`; controllers hold no SQL, services own transactions.
- [ ] Replace `router.js`'s monolithic `if/else` + `rootEndpoints` list with per-module route tables the router composes; keep every URL/method/payload identical.
- [ ] Reduce `apps/api/src/server.js` to a thin bootstrap.
- [ ] Golden + integration tests unchanged; all validation commands green.
- [ ] Mark completed.

### Task 18: Turn on and verify the boundaries
- [ ] Enable the dependency-direction ESLint rules repo-wide; fix all violations.
- [ ] Verify no controller contains raw SQL and no domain module imports pg/http; add a check asserting it.
- [ ] Remove orphaned code from the former monolith; confirm no dead exports.
- [ ] `npm run check && npm run lint && npm test && npm run test:integration` all green.
- [ ] Mark completed.

### Task 19: Split apps/admin-web the same way
- [ ] Extract `render*` into `pages/` and `components/`; separate data-fetching from pure HTML rendering. The place-element renderer from Task 10 is the reference shape for a component.
- [ ] Add render smoke tests: each page renderer given a fixture model returns non-empty, escaped HTML.
- [ ] Keep tabs and HTML output identical. All validation commands green.
- [ ] Mark completed.

---

## Phase 4 — Wrap-up

### Task 20: End-to-end happy-path integration test
- [ ] One integration test walking a full day: import catalog → add a triple element → permanent assignment → release → employee request → queue process → guest assignment with warning → line occupancy → contact access → archive an element → audit-trail assertions.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 21: Lightweight review pass
- [ ] Run `ralphex --review` on the accumulated branch; triage findings.
- [ ] Confirm: all SQL parameterized (no string-concatenated user input), input validation on every write endpoint, consistent error payloads, boundaries still enforced.
- [ ] Fix issues; re-run all validation commands; all green.
- [ ] Mark completed.

---

## Deferred — post-MVP (do NOT build now)

- **Yandex Messenger integration & bot-adapter scenarios** — build after full logic & UI finalization.
- **Authentication, sessions, RBAC, admin-users** — only when moving beyond a single operator (schema already exists).
- **Positioning elements on the floor plan** (drag-to-place, highlight-on-select) — deliberately out of
  scope; the plan image is a static reference and the element list is the source of truth.
- **Structured logging + correlation ids**, **OpenAPI docs**, remaining **ADRs**, and **deployment
  hardening** (reverse proxy, secret management, bot Dockerfile, deploy templates).
