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
