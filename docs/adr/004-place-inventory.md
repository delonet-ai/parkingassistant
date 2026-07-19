# ADR 004: Place Inventory Replaces Map-Zone Geometry

## Status

Accepted, implemented in Phase 2 (Tasks 8–12). Supersedes the map-zone part of
[ADR 002](002-database-baseline.md).

## Context

The original model let the operator drag a rectangle over a floor plan image and bind the
resulting normalized `{x, y, width, height}` to an existing `parking_places` row. The
rectangle lived in `parking_place_map_zones.geometry`, together with a `zoneType` field
that carried the `regular` / `rotatable` / `blocked` classification.

Three things were wrong with it:

1. The geometry carried **no business meaning**. Nothing read the coordinates except the
   renderer that drew them back.
2. The operator's actual task is *how many places of which shape exist* — inventory — and
   the geometry editor could not answer that. Adding a parking place meant a separate
   form, and the two write paths drifted (Task 12 found the Справочники form producing
   places that violated the capacity invariant).
3. `zoneType` — genuinely load-bearing, since `rotatable` marks the guest pool and guest
   allocation orders by `guest_priority_rank NULLS LAST` — was buried inside a JSON column
   on a *presentation* table. Deleting the drawing would have deleted the classification.

The tab holding the editor was also called «Карта», adjacent to a «Линии» tab that means
something entirely different (`line_occupancy` — who stands in which position *today*).

## Decision

### An element is a parking line holding 1–3 slots

Single = 1 slot, double = 2, triple = 3. Each slot is one `parking_places` row; the
element itself is one `line_groups` row. Element identity is **uniform** — a single is a
capacity-1 `line_groups` row, not a special case — so the UI never juggles two kinds of
identity. This required relaxing `line_groups.capacity CHECK (capacity IN (2, 3))` to
`IN (1, 2, 3)` and backfilling a capacity-1 group for every group-less place, archived
ones included (`parking_places.line_group_id` is now `NOT NULL` / `ON DELETE RESTRICT`).

### `line_groups.capacity` is the single source of truth for element size

`parking_places.place_type` is derived from it and written by the same transaction;
`line_position_hint` is assigned 1..capacity in code order, never read from spreadsheet
wording. The rule has one implementation — the `assign_place_lines()` SQL function
installed by `005_place_inventory.sql` — shared by the API and the catalog import. An
integration assertion enforces `capacity == count(slots) == place_type`.

### Inventory, not decoration

Adding a triple **creates three real parking places** and therefore moves the system-wide
place count, guest reserve math, dashboard totals, availability, and queue capacity.
Archiving one moves them back. `/admin/place-lines` is the only way places are added or
removed, and the place-lines service is the only write path to `parking_places.is_active`.

### Place role is a first-class column

`parking_places.place_role` (`parking_place_role` enum: `regular` / `rotatable` /
`blocked`) was added and backfilled from `geometry.zoneType` **before**
`parking_place_map_zones` was dropped, with a count assertion that raises rather than
warns. A place can carry a zone on more than one floor plan, so the backfill is a
`DISTINCT ON (parking_place_id)` with precedence `blocked` > `rotatable` > `regular`.

### Delete means archive

Never a hard delete: `is_active = false`, `deleted_at = now()`, `line_groups.archived_at`
on the element. Reservations, releases, line occupancy and audit history stay intact and
readable — including the place's own history endpoint. Archiving is refused with `409` and
a **named list of blockers** while any slot holds an active reservation for today or later
(evaluated in `APP_TIMEZONE`) or a live permanent assignment.

### The floor plan stays as a static reference image

Per-floor background upload/replace is kept; there are no zones, no click targets, no
dragging. Positioning elements on the plan is explicitly out of scope (see the plan's
Deferred section).

### The Карта tab becomes Места

| Tab | Question it answers |
|---|---|
| **День** | Who is parked where today, and what do I change about today? |
| **Линии** | Who stands in which position in a line today? |
| **Места** | Which parking places exist at all? |

The rename carried through the route key, the `activeView` whitelist, every `?view=maps`
link and the renderer name. No alias for the old URL — `?view=maps` falls through to
`day`, per the plan's no-compatibility rule.

### The selector changed, the interaction did not

Clicking a slot does exactly what clicking a zone did: selects the place, swaps in the
operational place drawer over `fetch`, marks the selection, and `history.pushState`s the
day URL. A slot is a real `<button type="button" aria-pressed>`, so it is keyboard
reachable — the SVG `<g>` it replaces was not. Status is conveyed by background colour
**plus** a status word, never colour alone; the six tokens (`free`, `released`,
`occupied`, `guest`, `rotatable`, `blocked`) are the old map-legend palette, renamed
rather than rewritten.

## Rationale

Why archive rather than delete: a deleted place takes its reservation history, its line
occupancy and its audit trail with it, or forces `ON DELETE SET NULL` holes into all of
them. The operator's question after an archive is «кто там стоял», which only survives if
the row does.

Why `line_groups` for singles too: the alternative — a nullable `line_group_id` with
singles outside the model — leaves every consumer branching on "grouped or not", which is
exactly where the pre-005 code kept getting `place_type` wrong.

Why the role column rather than keeping the zone table for its `zoneType`: keeping a
presentation table alive purely as a lookup for a business classification is the
compatibility layer this project's rules forbid.

## Consequences

Positive:

- adding places is one action with correct downstream arithmetic, instead of a form that
  could produce an invariant-violating row
- the element list is more accessible than the SVG it replaces (focus, Enter/Space, a
  status word next to every colour)
- one write path to `is_active`, asserted by test rather than by convention

Negative:

- the floor plan and the element list are two separate visuals; the operator maps between
  them by floor label and place code, not by looking at a picture
- `005_place_inventory.sql` is a destructive migration — the geometry is gone, and only
  the role classification was carried over
- `003_infer_line_groups.sql` is deliberately left as it was (it is already in the ledger
  of every existing database), so it carries a header saying what it does not do
