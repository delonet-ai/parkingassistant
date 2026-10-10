# Import Scripts

## Parking Catalog

Imports parking places from the source Excel workbook into `parking_places`.

Expected source path inside app containers:

```text
/app/storage/imports/parking-catalog.xlsx
```

Run from an app container:

```bash
npm run db:import:parking-catalog
```

The first importer intentionally loads only place catalog data. Source status, department, and assignee are stored in `parking_places.metadata` until permanent assignment import rules are confirmed.

The same import is available to the operator from the admin UI, on the `Места` tab: it uploads
the workbook to `POST /admin/catalog-import`, which previews the counts first and writes only on
an explicit second step. The script and the endpoint share both the row mapping
(`packages/domain/catalog-rows.js`) and the staged upsert
(`apps/api/src/modules/catalog-import`), so they cannot disagree about a file — this script is
argument and connection handling around the same service.

Three things the shared reader decides, for both callers:

- **A re-import revives an archived place whole.** The upsert sets `is_active = true` beside
  `deleted_at = null`, because archiving a slot clears both — and clearing only one left a place
  that `/admin/places`, releases and reservations could see while the `Места` grid could not. The
  consequence to know: a slot archived by hand comes back on the next import if its code is still
  in the sheet.
- **The file must be an .xlsx.** The reader refuses anything that is not a zip archive before
  handing the bytes to the parser, which otherwise reads arbitrary text as a one-sheet workbook
  and sends the operator looking for a missing sheet. A legacy `.xls` or a `.csv` export has to be
  saved as `.xlsx` first.
- **The header belongs in row 2**, under the title row, spelled `Уровень`, `Место `, `Статус`,
  `Дирекция `, `Кем` — trailing spaces included, because the cells are read by those literal
  keys. A sheet without the title row is refused naming the columns rather than reported as
  "nothing was understood", and a sheet declaring more than 5000 rows is refused as not being the
  catalog at all.

## Permanent Assignments

Imports employees from the same workbook and creates active `permanent_assignments` for rows marked as `Закреплено`.

Run from an app container:

```bash
npm run db:import:permanent-assignments
```

Default assignment start date:

```text
2024-10-01
```

If the same source assignee appears on more than one active place, the importer keeps the first active assignment and skips the rest to respect the database rule "one active permanent place per user".
