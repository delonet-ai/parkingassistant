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
