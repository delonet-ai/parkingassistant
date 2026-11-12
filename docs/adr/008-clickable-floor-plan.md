# ADR 008: Clickable Floor Plan Over the Place Inventory

## Status

Accepted. Builds on [ADR 004](004-place-inventory.md), which it does not reverse.

## Context

ADR 004 removed the map-zone editor: a zone was a rectangle drawn one at a time, it carried
the place role inside a JSON blob, it was a second write path to the inventory, and nothing
but the renderer read its coordinates. The plan became a static picture.

Operators still need to *see* the parking: which stall is free, who stands in front of whom.
Three standalone prototypes were built on the real G4 plan and data (SVG with a row tool,
Leaflet + Geoman, Konva). The product owner chose the SVG one. What made it work where the old
editor did not:

- **The row tool.** Stalls on a plan stand in rows. One rectangle over a row, cut into
  K lines × depth 1–3 with a chosen front, marks a dozen places at once; free rotation snaps
  to the row's neighbours.
- **Binding to the inventory as part of drawing.** Polygons are created for existing lines
  (front → rear by slot position), never as free-floating zones.
- **Zoom.** A 3–4k px scan is unusable without it.

## Decision

### Markup is presentation keyed by the inventory

`parking_place_map_markup` holds one document per floor plan (`parking_place_maps` row):
`places` — `{ placeId: { polygon: [[x, y], …] } }` in pixels of the plan image, origin top-left —
plus `editor`, the rows the polygons were cut from, opaque to the API so a row stays
re-cuttable after reload. A polygon never creates, archives or classifies a place; adding and
archiving stay in `/admin/place-lines`, the role stays `parking_places.place_role`
(ADR 004 holds).

### Saved whole, guarded by a revision

`POST /admin/map-markup` replaces the document. The caller sends the `revision` it loaded;
a mismatch is `409` rather than last-writer-wins, because a lost polygon is invisible until
someone looks for the stall. Each save is one `parking_place_map_markup_saved` audit row.

The API checks what it can know: shapes (3–64 finite points near the image), that every place
id exists, and that it belongs to the plan's floor. Archived places may keep their polygon.

### Bound to the image it was drawn on

The document stores the plan's `source_checksum` at save time. When the plan image is replaced,
`planChanged` tells the UI the polygons may no longer sit on the stalls; the markup is kept, not
dropped, because a re-scan of the same plan usually lines up.

### Where it shows

- **Места** — the editor (row tool, single rectangle/polygon, vertex editing, undo, save).
- **День** — the plan with places filled by the API's slot status; a click selects the place and
  opens the same place drawer as the element list. No parking rule is evaluated on the plan.

## Consequences

- An unmarked floor still works exactly as before: the element list is the work surface and
  the plan is optional.
- Marking a floor is a one-time job of minutes per row rather than per stall.
- The plan image's pixel size is part of the document; replacing the image with a different
  resolution needs a re-mark (or the polygons scaled), and `planChanged` is the prompt for it.
