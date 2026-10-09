# migrate the remaining admin tabs to apps/admin-ui on Vision UI

## Overview

`apps/admin-ui` (Vue 3 + Vite on `@vi-frontend/vision-ui`) has taken over the `День` tab. Five
tabs still run in the old server-rendered `apps/admin-web`: `Заявки`, `Линии`, `Справочники`,
`Журнал` and `Места`. This plan moves each of them, then deletes `apps/admin-web` entirely —
its sources, its Dockerfile, its compose service, its tests and its port.

The decision and its constraints are [ADR 006](../adr/006-admin-ui-on-vision-ui.md). Nothing
about the API changes: not an endpoint, not a payload, so the 122 golden snapshots must stay
byte-identical throughout. If one moves, the migration broke something.

**Approach:** one tab per task, each ending with its own vitest specs and a green gate, so a
failure halfway leaves every earlier tab working and the stand deployable. Each tab is built
from the component mapping already read out of the design system (see **Technical Details**) —
props are taken from the Vision UI docs through the `vision-ui-local` MCP or the mirror files,
never guessed. The old tab is deleted only in the final task, when nothing still points at it,
because deleting each one as it goes would leave the stand without that screen for the length
of the migration.

## Context

- **files involved:**
  - Create: `apps/admin-ui/src/pages/{RequestsPage,LinesPage,CatalogPage,AuditPage,PlacesPage}.vue`
  - Create: `apps/admin-ui/src/components/*.vue` per tab, plus a `*.spec.js` beside each
  - Modify: `apps/admin-ui/src/store.js` — one loader per tab, following `loadDay()`
  - Modify: `apps/admin-ui/src/App.vue` — register each page in `PAGES` as it lands
  - Delete (final task): `apps/admin-web/`, `infra/docker/admin-web.Dockerfile`, the
    `admin-web` service in `docker-compose.yml`, `ADMIN_WEB_PORT` in `.env.example`
  - Modify (final task): `infra/deployment.test.js`, `scripts/smoke/stand.js`,
    `docs/TECHNICAL_README.md`, `SETUP.md`, `README.md`, `AGENTS.md`
- **existing patterns:**
  - `apps/admin-ui/src/pages/DayPage.vue` and its components are the reference for structure,
    naming and comment density; `PlaceDrawer.vue` is the reference for write actions
  - every write goes through `submit()` in `store.js`, which shows the API message on failure,
    renders API warning objects, and reloads on success
  - specs are `*.spec.js` (vitest), never `*.test.js` — `node --test` would try to load those
  - `ViInput` / `ViSelect` bind with `v-model:value`; a plain `v-model` posts nothing
- **constraints:**
  - no parking rule may be evaluated in the UI: statuses, `today` and warnings come from the API
  - colour never carries meaning alone — every status prints its word; selection is `aria-pressed`
  - colours, radii and spacing are tokens only — `var(--vi-color-…)`, `var(--vi-radius-…)`,
    `var(--vi-vr-…)`; a hard-coded hex is a defect. **Never wrap a `--vi-color-*` token in
    `rgb()`**: that layer holds hex values, only the deprecated `--vi-primary` layer holds
    triplets, and `rgb(#cfeed7)` makes the browser drop the whole declaration
  - `vendor/*.tgz` must be present to build; CI cannot build this app at all
  - `apps/admin-web` stays deployed and working until the final task
- **assumptions:**
  - tab order follows operational importance (`Заявки` first, `Места` last among the five),
    not the order of the tab strip
  - the `Места` tab keeps the floor-plan upload (`multipart/form-data` to
    `/admin/map-backgrounds`), since that endpoint is genuinely useful and unchanged
  - `Журнал` stays read-only apart from the manual job runs it already offers

## Development Approach

- **testing approach**: regular — build the tab, then write its specs against the rendered DOM
- verification command: `npm run test:ui && npm run check && npm run lint && npm test`
- complete each task fully before moving to the next
- **CRITICAL: all checks must pass before starting the next task**
- **CRITICAL: update this plan file when scope changes during implementation**

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix
- document issues/blockers with ⚠️ prefix

## Implementation Steps

### Task 1: Заявки — employee requests, guests and the queue

**Files:**
- Create: `apps/admin-ui/src/pages/RequestsPage.vue`
- Create: `apps/admin-ui/src/components/EmployeeRequests.vue`, `GuestRequests.vue`, `QueuePanel.vue`
- Create: `apps/admin-ui/src/components/EmployeeRequests.spec.js`, `GuestRequests.spec.js`, `QueuePanel.spec.js`
- Modify: `apps/admin-ui/src/store.js`, `apps/admin-ui/src/App.vue`

- [x] add `loadRequests()` to `store.js` reading `/admin/employee-parking-requests`, `/admin/guest-parking-requests` and `/admin/dashboard` for the selected date — **not added**: `loadDay()` already fetches all three for the selected date, and a second loader would have duplicated every request. The tab reads the same state.
- [x] build `EmployeeRequests.vue`: `ViTableSimple` of requests with status and reason, a create form (`ViSelect` employee + date) posting `/admin/employee-parking-requests`, and per-row cancel posting `/admin/employee-parking-requests/cancel`
- [x] build `GuestRequests.vue`: table of guest requests, create form posting `/admin/guest-parking-requests`, per-row `assign` and `cancel` posting `/admin/guest-parking-requests/assign` and `/cancel`
- [x] build `QueuePanel.vue`: queue state for the date plus a button posting `/admin/queue-run`, showing assigned/skipped counts from the response
- [x] register `requests` in `PAGES` in `App.vue`
- [x] write specs: tables render, a refused write shows the API message, an assign with warnings shows the warning text
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — 63 UI specs, 299 node tests, all green.

⚠️ Two payload shapes differ between endpoints and both silently rendered a dash until the
screenshot showed it: `/admin/employee-parking-requests` flattens the place to
`assignedReservation.parkingPlaceCode`, while `/admin/guest-parking-requests` and
`/admin/dashboard` nest a whole `parkingPlace` object; and the guest request calls the
inviting employee `host`, not `hostUser`. Worth aligning in the API later — the UI now
follows each endpoint as it is, and the specs use real payload shapes.

### Task 2: Линии — positions, occupancy, departures and contact access

**Files:**
- Create: `apps/admin-ui/src/pages/LinesPage.vue`
- Create: `apps/admin-ui/src/components/LineOccupancy.vue`, `DeparturePlans.vue`, `ContactAccessLog.vue`
- Create: a `*.spec.js` beside each
- Modify: `apps/admin-ui/src/store.js`, `apps/admin-ui/src/App.vue`

- [x] add the five reads to `loadDay()` rather than a second loader, matching Task 1 — `/admin/line-groups`, `/admin/line-occupancy`, `/admin/departure-plans`, `/admin/conflicts`, `/admin/contact-access-logs`
- [x] build `LineOccupancy.vue`: who stands in which position today, with the contact column (`телефон · email`, and the route-to-admin wording when the one in front is a guest), and a form posting `/admin/line-occupancy` whose position select is built from the chosen line rather than hardcoded 1/2/3
- [x] build `DeparturePlans.vue`: plans with the early flag, conflicts list, and a form posting `/admin/departure-plans`; a `409` from the 07:00 lock must render as the API's message, not as a crash
- [x] build `ContactAccessLog.vue`: read-only `ViTableSimple` of contact requests
- [x] register `lines` in `PAGES`
- [x] write specs: the position select follows the line's capacity, the guest-in-front wording appears, a locked plan shows the `409` message
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — 85 UI specs, 299 node tests, green.

⚠️ A masked `ViInput` emits the **unmasked** value: `mask="##:##"` shows `15:30` in the field
and emits `"1530"`. Posting that would have been refused by the API with a format error, after
the operator typed the time correctly. `src/time.js` puts the separator back, rejects an
incomplete or impossible reading, and the save button follows it.

### Task 3: Справочники — employees, places and permanent assignments

**Files:**
- Create: `apps/admin-ui/src/pages/CatalogPage.vue`
- Create: `apps/admin-ui/src/components/EmployeesTable.vue`, `PlacesTable.vue`, `PermanentAssignments.vue`, `HistoryCards.vue`
- Create: a `*.spec.js` beside each
- Modify: `apps/admin-ui/src/store.js`, `apps/admin-ui/src/App.vue`

- [x] add `loadCatalog()` reading `/admin/employees`, `/admin/places`, `/admin/permanent-assignments` and, on selection, `/admin/places/:id/history` and `/admin/employees/:id/history`
- [x] build `EmployeesTable.vue` with create (`/admin/employees`), update (`/admin/employees/update`) and disable (`/admin/employees/disable`)
- [x] build `PlacesTable.vue` with the per-place role and guest-priority controls posting `/admin/places/update`, and **no place-create form** — places are created only on the `Места` tab
- [x] build `PermanentAssignments.vue` with create (`/admin/permanent-assignments`), end (`/admin/permanent-assignments/end`) and the status filter (`all`/`active`/`future`/`ended`)
- [x] build `HistoryCards.vue`: place and employee history timelines opened from the tables
- [x] register `catalog` in `PAGES`
- [x] write specs: the second place-create form is absent, disabling an employee shows the API message on refusal, the history card renders events
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 4

### Task 4: Журнал — audit log, contact logs and job runs

**Files:**
- Create: `apps/admin-ui/src/pages/AuditPage.vue`
- Create: `apps/admin-ui/src/components/AuditTable.vue`, `JobsPanel.vue`
- Create: `apps/admin-ui/src/components/AuditTable.spec.js`, `JobsPanel.spec.js`
- Modify: `apps/admin-ui/src/store.js`, `apps/admin-ui/src/App.vue`

- [x] add `loadAudit()` reading `/admin/audit-logs` with the `entityType`/`action`/`actor` filters, `/admin/contact-access-logs` and `/admin/jobs/runs`
- [x] build `AuditTable.vue`: filters as `ViSelect`/`ViInput`, results as `ViTableSimple`, actor and entity columns
- [x] build `JobsPanel.vue`: latest successful run per job, recent runs, and buttons running all five jobs manually (`/admin/jobs/{process-queue,freeze-next-day,lock-departure-plans,unlock-employee-pool,rebuild-conflicts}`)
- [x] register `audit` in `PAGES`
- [x] write specs: all five jobs are runnable, a filter narrows the request query, a failed job run shows its error
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — must pass before task 5

### Task 5: Места — the inventory editor

**Files:**
- Create: `apps/admin-ui/src/pages/PlacesPage.vue`
- Create: `apps/admin-ui/src/components/InventoryEditor.vue`, `MapUpload.vue`
- Create: `apps/admin-ui/src/components/InventoryEditor.spec.js`, `MapUpload.spec.js`
- Modify: `apps/admin-ui/src/store.js`, `apps/admin-ui/src/App.vue`

- [x] reuse `PlaceLines.vue` in an `editor` mode: the same element grid, plus the per-slot place-role control and the per-element archive button — the Day tab must stay unable to create or archive a place
- [x] build the add dialog on `ViModal`: `+ Одинарное` / `+ Двойное` / `+ Тройное` posting `/admin/place-lines` with `{floorLabel, capacity, slots}`
- [x] build the archive confirm on `ViModal`, naming the affected place codes before the count changes, posting `/admin/place-lines/archive`; a `409` must render the blockers the API names
- [x] build `MapUpload.vue`: per-floor background replace, `multipart/form-data` to `/admin/map-backgrounds`, showing version and checksum
- [x] carry over the diagnostics from `/admin/map-diagnostics` (place without a line, capacity vs slot-count mismatch)
- [x] keep the populated-floor default: the editor opens on the first floor that actually has lines
- [x] register `places` in `PAGES` and delete `NotMigratedPage.vue`, which now has nothing to say
- [x] write specs: archiving asks before it acts, a `409` lists blockers, the Day tab offers no add/archive control
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — 108 UI specs, 299 node tests, green.

⚠️ Three Vision UI contracts that fail silently rather than loudly, all found by screenshot:
`ViTableSimple` hands a cell to the `#cell` slot **only if it has no `text` key**, so a
clickable name must travel under another key or it renders as plain text; `ViModal` ignores
`isOpened` unless `use-model` is set and otherwise renders open, which put an empty history
card over the catalog on every load; and `ViModal` teleports to `document.body`, so a spec
must assert on the document rather than on the wrapper.

### Task 6: Remove apps/admin-web

**Files:**
- Delete: `apps/admin-web/`, `infra/docker/admin-web.Dockerfile`
- Modify: `docker-compose.yml`, `.env.example`, `infra/deployment.test.js`, `scripts/smoke/stand.js`, `package.json`

- [x] delete `apps/admin-web/` in full, including `testing/stub-api.js`, `src/tabs.test.js` and `src/pages/pages.test.js` — their subject is gone, so they are not ported
- [x] delete `infra/docker/admin-web.Dockerfile`, the `admin-web` compose service, the `admin-web:start` script and `ADMIN_WEB_PORT`
- [x] move `admin-ui` to the admin port the stand already publishes (`3340`) and drop `ADMIN_UI_PORT=3360`, so the operator's URL does not change
- [x] update `infra/deployment.test.js` to expect exactly `admin-ui`, `api`, `jobs`, `migrate`, `postgres`
- [x] update `scripts/smoke/stand.js`: the admin check hits the SPA shell and `/health` on the new service
- [x] run `npm run test:ui && npm run check && npm run lint && npm test` — 250 node tests, 108 UI specs.

➕ `packages/shared/html.js` was deleted with it: `escapeHtml` existed for the SSR renderers and
had no other consumer, so it would have survived as dead code the guards do not catch.

➕ `scripts/smoke/m1.js` and `apps/api/src/today-default.test.js` both named `admin-web` by path;
m1 now boots `apps/admin-ui/server.js` and the UTC-today guard scans the new app's sources.

⚠️ The API labels an operator's write `actorService: 'admin-web'` in 32 places of its own code,
and 25 of them are in the golden snapshots. Renaming it is an API change with a deliberate
regeneration behind it — deliberately **not** done here, so the migration leaves the snapshots
byte-identical. The audit log therefore still names an application that no longer exists.

### Task 7: Verify acceptance criteria

- [x] verify every tab in the Overview renders and operates: `День`, `Заявки`, `Линии`, `Справочники`, `Журнал`, `Места`
- [x] verify no tab reaches the backend outside `src/api.js` and no parking rule is evaluated in the UI
- [x] grep the app for hard-coded colours: `grep -rnE '#[0-9a-fA-F]{3,8}' apps/admin-ui/src` must return nothing
- [x] run `npm run test:integration` with `DATABASE_URL_TEST` set — 288/288, and **not one golden snapshot regenerated**
- [x] run `npm run admin-ui:build` — must pass with no unresolved-font warnings
- [x] run `npm run test:ui && npm run check && npm run lint && npm test`

### Task 8: Update documentation

- [x] update `docs/TECHNICAL_README.md`: M10 complete, stack composition without `admin-web`, ports
- [x] update `SETUP.md`, `README.md` and `AGENTS.md` for the single admin UI
- [x] record in `docs/adr/006-admin-ui-on-vision-ui.md` that the migration finished and `admin-web` is gone

## Technical Details

Component mapping, read out of Vision UI 1.16.0 and already used by the `День` tab:

| UI element | Vision UI component | Key props |
|---|---|---|
| tab strip | `ViTabs` | `tabs`, `activeTab`, `titleFieldName`, `valueFieldName`, `update:activeTab` |
| headings and copy | `ViText` | `tag`, `variant` (`title-h1…h8`, `body-*`), `margin` |
| notices | `ViAlert` | `type` (`default`/`success`/`info`/`error`/`warning`), `title`, `hasCloseButton` |
| transient notices | `useViToast` + `ViToastProvider` | `component`, `duration`, `props` |
| cards and tiles | `ViCard` from `/next` | `variant` (`shadow`/`outlined`/`toned`), `radius`, `padding` |
| buttons | `ViButton` | `color`, `variant` (`filled`/`outlined`/`link`), `size`, `loading`, `disabled` |
| static tables | `ViTableSimple` | `headers`, `rows`, slots `header`/`cell` — a cell without `text` falls to the `cell` slot |
| sortable/selectable tables | `ViTable` | `headers`, `rows`, `rowKey`, `selectable`, `sortedHeader`, `stickyHeader` |
| status words | `ViNameplate` | `size`, `textColor`, `backgroundColor` — plain CSS colours applied inline, so pass `var(--vi-color-…)` |
| counters | `ViBadge` | `value`, `type`, `size` |
| filter toggles | `ViChip` | `variant`, `color`, `selected`, `interactive` |
| text fields | `ViInput` | `label`, `labelType`, `clearable`, `required`, `mask`; **`v-model:value`**; errors via the `error` slot |
| selects | `ViSelect` | `options`, `textFieldName`, `valueFieldName`, `hasSearch`, `multiple`; **`v-model:value`**; errors via the `error` slot |
| date fields | `ViDateTimeInput` | `pickerType="date"`, `labelType`, `min`, `max`, `update:value` — works with `Date` objects |
| checkboxes | `ViCheckbox` | `modelValue`, `indeterminate`, `isLeftLabel` |
| dialogs | `ViModal` | `isOpened`/`useModel`, `title`, `width`, `hasCloseButton`, `disableOverlayClose` |
| collapsibles | `ViSpoiler` | `title`, `update:isActive` |
| icons | `ViIcon` | `icon` (glyph name from `vi-icons-font.css`), `size`, `spin` |

Two stylesheets must be imported, not one: components from `/next` (`ViCard`,
`ViCardContent`) ship their styles in `@vi-frontend/vision-ui/css/next`, and without it they
render with hashed class names nothing defines — no background, no border, no padding.
`ViCard` has no `padding` prop; padding belongs to `ViCardContent`. `ViSelect` needs
`track-by-value` to match a primitive, or nothing ever shows as selected.

Reading the docs: the `vision-ui-local` MCP server exposes `list_components`,
`search_components`, `get_component`, `get_story` and `get_tokens`. Without it, the mirror files
are the same content — `mirror/index.json`, `mirror/components/<Name>.md`,
`mirror/tokens/Colors.json`. `Components Deprecated` (`ViCard`, `ViOnboarding`) must not be used
in new code; `Components Next` import from `@vi-frontend/vision-ui/next`.

Status palette, carried over unchanged in meaning: `free` → green, `released` → mint,
`occupied` → yellow, `guest` → orange, `rotatable` → red, `blocked` → gray; background `-100`,
text `-800`. The words are `свободно`, `отдано`, `занято`, `гостевое`, `ротируемое`, `недоступно`.

## Post-Completion

*No checkboxes here — these need a human or an external system.*

- place `vendor/vi-frontend-vision-ui-1.16.0.tgz` and `vendor/vi-frontend-svgs-0.92.0.tgz` on the
  stand host before the first `admin-ui` build
- deploy and smoke the stand: `ssh omv /opt/git/parkingassistant/scripts/deploy/stand.sh`, then
  `npm run smoke:stand`
- walk the six tabs in a browser against the seeded stand — the specs assert the DOM, not how it
  looks, and nothing here can judge the visual result
- decide whether this repository stays public: `apps/admin-ui/package.json` names the internal
  design-system packages (ADR 006 → Consequences)
