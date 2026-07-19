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
- [ ] Add a `packages/db/seeds` demo dataset + `npm run db:seed:demo` that loads realistic data so every admin tab renders content: parking lines of each size (single/double/triple), employees (with/without permanent places), permanent assignments, an active release, an employee request, a guest request, a reservation, a departure plan.
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

### Task 8: Retire map zones, make every place belong to a line (schema)

Migration `packages/db/schema/004_place_inventory.sql`. **Step order matters** — the zone table is
read for data before it is dropped:

- [ ] 1. Add `CREATE TYPE parking_place_role AS ENUM ('regular', 'rotatable', 'blocked')` and `parking_places.place_role parking_place_role NOT NULL DEFAULT 'regular'`.
- [ ] 2. Backfill it from the zone geometry — `UPDATE parking_places p SET place_role = (z.geometry->>'zoneType')::parking_place_role FROM parking_place_map_zones z WHERE z.parking_place_id = p.id AND z.geometry->>'zoneType' IN ('regular','rotatable','blocked')`. Assert afterwards that the count of `rotatable`/`blocked` places matches the count of such zones — a silent loss here quietly breaks guest allocation.
- [ ] 3. Only now `DROP TABLE parking_place_map_zones`. Keep `parking_place_maps` — the per-floor background image is still used.
- [ ] 4. Relax `line_groups.capacity` to `CHECK (capacity IN (1, 2, 3))`; add `line_groups.display_order integer` and `line_groups.archived_at timestamptz` (the table has **no** archive column today, and Task 9 needs one).
- [ ] 5. Backfill a capacity-1 line group for every active `parking_places` row with `line_group_id IS NULL` (code `line-<floor>-<placeCode>`, `line_position_hint = 1`).
- [ ] 6. Backfill `display_order` from `(floor_label, numeric prefix of place code, code)` — `parking_places.code` is `text` and is **not** guaranteed numeric, so sort non-numeric codes last by collation rather than casting and failing.
- [ ] Do NOT add `NOT NULL` to `parking_places.line_group_id`: the column is declared `REFERENCES line_groups(id) ON DELETE SET NULL`, which contradicts it. Either switch that FK to `ON DELETE RESTRICT` and then add `NOT NULL`, or keep the "every active place has a line group" rule as a documented invariant plus an integration assertion. Prefer `RESTRICT` + `NOT NULL` — a place silently losing its line is worse than a refused group delete.
- [ ] Reconcile `scripts/import/parking-catalog.js` and `003_infer_line_groups.sql` with the new invariant: an import must land every place in a line group, singles included, and set `place_type` from the group capacity.
- [ ] Update the Task 5 demo seed to the new model (it is written before this task and will not survive it unchanged).
- [ ] Integration test: migration is idempotent; no active place is group-less afterwards; `place_role` counts match the pre-migration zone counts; no data outside the zones table was touched.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 9: Place inventory API (list / create / archive elements)

**Reuse before inventing.** `/admin/places`, `/admin/places/update`, and `/admin/line-groups` already
exist (`apps/api/src/router.js:15-23`). The new endpoints are a *line-level composition* over the
existing per-place ones, not a parallel API. After this task there is exactly one way to do each
thing: edit one place's attributes → `/admin/places/update`; take one slot out of service →
`place_role = 'blocked'`; add or remove places → `/admin/place-lines`. `is_active` has a single
write path, in the place-lines service.

- [ ] Delete the zone endpoints and their handlers: `handleAdminMapZonesList`, `handleAdminMapZoneSave`, `handleAdminMapZoneUpdate`, `handleAdminMapZoneDelete`, plus their routes and the geometry validation helpers. Keep background upload and map diagnostics.
- [ ] Add `GET /admin/place-lines?floor=&date=` returning elements ordered by `display_order`: `{ lineId, code, capacity, floorLabel, slots: [{ placeId, code, position, placeRole, status, userDisplayName }] }`. `status` keeps the old precedence, now reading `place_role` instead of `geometry.zoneType`: `occupied` → `guest` → `released` → `blocked` → `rotatable` → `free`.
- [ ] Add `POST /admin/place-lines` — body `{ floorLabel, capacity: 1|2|3, slots: [{ code, title, placeRole, guestPriorityRank }] }`. In one transaction: create the `line_groups` row, create `capacity` `parking_places` rows with `place_type` derived from capacity and `line_position_hint` 1..capacity, audit `place_line_created`. Reject on duplicate place code (`409`), bad capacity, or slot count ≠ capacity (`400`).
- [ ] `guestPriorityRank` must be settable at creation. Guest allocation orders by `guest_priority_rank NULLS LAST`, so a new place created without it silently sorts last forever — the operator has to be able to say "this new place is in the guest pool" without a second trip to `/admin/places/update`.
- [ ] Add `POST /admin/place-lines/archive` — body `{ lineId }`. Refuse with `409` and a named list of blockers if any slot has an active reservation for today or later, or a live permanent assignment. Otherwise set `is_active = false, deleted_at = now()` on all slots, set `line_groups.archived_at`, and audit `place_line_archived`.
- [ ] **Delete `/admin/places/disable`** rather than teaching it the new blocker rule. Once `place_role = 'blocked'` marks a single slot out of service and line archiving removes places, a third way to deactivate one place is redundant — and a second write path to `is_active` is exactly the kind of drift the no-compatibility rule exists to prevent. Remove the route (`apps/api/src/router.js:17`, `:136`), its handler, the admin-web proxy (`apps/admin-web/src/server.js:3965-3971`), and the form at `:2698`, replacing that form with the place-role control.
- [ ] Rewrite the map diagnostics to the new model: report places missing a line group, and groups whose slot count disagrees with `capacity`. Drop the zone-based diagnostics.
- [ ] Integration tests: create single/double/triple; created places appear in dashboard counts and availability; a `rotatable` place created with a guest rank lands in guest allocation order; archive is blocked by an active reservation and succeeds once it is cleared; `is_active` has no other write path (asserted by test, not by convention); archived places disappear from availability, guest reserve math, and the queue but remain readable in history.
- [ ] Run `npm run test:integration`; green.
- [ ] Mark completed.

### Task 10: Shared place-element renderer + Места tab (inventory editor)
- [ ] Add a pure renderer in `apps/admin-web/src/` producing the element grid from a model — `renderPlaceLines(model, { mode })` where `mode` is `'operational'` or `'editor'`. No SQL, no fetching; it takes data and returns escaped HTML.
- [ ] Render per the spec above: `<article class="place-line" data-capacity>` containing `<button class="place-slot" aria-pressed>` per slot, stacked front→rear, each showing place code, position label (multi-slot only), and status as colour **plus** word. Reuse the six existing status colour tokens.
- [ ] Rewrite `renderMapEditorTab` → `renderPlacesTab`: keep the per-floor background upload panel and the diagnostics tables; delete the edit-mode checkbox, place/zone-type selects, the `.maps-grid` SVG cards, and the entire inline drawing script (`pointerdown`/`pointermove`/`pointerup`, `svgPoint`, `normalizedRect`, `saveZone`, `updateZoneType`, `deleteZone`, `renderZonesList`). Render the static floor plan as a plain `<img>` and the element grid below it in `'editor'` mode.
- [ ] Carry the rename through every place the old key appears — do these together or the tab 404s to `day`: the label at `apps/admin-web/src/server.js:230` (`Карта` → `Места`), the `activeView` whitelist at `:3742` (`'maps'` → `'places'`), the `mapsHref` variable and `?view=maps` links, and the `maps:` module key in `apps/admin-web/src/render-modules.js:17`.
- [ ] No alias for the old `?view=maps` URL — the key is renamed outright and the old one stops existing (see the no-compatibility-layer rule above).
- [ ] Delete what the static `<img>` makes dead: the `width`/`height` fields in the `parkingMaps` catalog (`apps/admin-web/src/server.js:16-41`) existed only to compute the SVG `viewBox`, and the `.map-zone-*`, `.maps-grid`, `.map-draft-zone`, `.map-zone-selected` CSS rules (`:3429-3505`) have no remaining consumers.
- [ ] Add the `+ Одинарное` / `+ Двойное` / `+ Тройное` toolbar and its `<dialog>`: floor is prefilled from the selected floor, one code+title field per slot, next free numeric code suggested. Submits to `POST /admin/place-lines`, then refreshes the list and reports the API error inline on `409`/`400`.
- [ ] Add per-element archive with a confirm `<dialog>` that names every affected place code and states the resulting place count. Surfaces the `409` blocker list verbatim.
- [ ] Keep a per-slot **place role** control (Обычное / Ротируемое-гостевое / Недоступное) in editor mode — this is the replacement for the old per-row "Тип зоны" select, and without it the operator can no longer mark a place as guest-pool or unavailable. It writes `place_role` via `/admin/places/update`.
- [ ] Render smoke tests: the renderer given single/double/triple fixtures returns non-empty escaped HTML with the right slot count, order, status classes, and `aria-pressed` state.
- [ ] Run the validation commands; green.
- [ ] Mark completed.

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
