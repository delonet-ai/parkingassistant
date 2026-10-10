'use strict';

const path = require('node:path');
const xlsx = require('xlsx');
const { Pool } = require('pg');

// Arguments, a connection and a console — nothing else.
//
// What the import *decides* is shared with `POST /admin/catalog-import`: the row mapping lives
// in packages/domain/catalog-rows.js and the staged upsert in the catalog-import module, which
// this script calls with its own pool. There is deliberately no second copy here: a CLI that
// imported the real file slightly differently from the upload the operator uses would be a
// fork nobody notices until the two disagree about the catalog.
const {
  CatalogWorkbookError,
  createCatalogImportService,
  readCatalogSheet
} = require('../../apps/api/src/modules/catalog-import/service');
const { REFUSAL_DUPLICATE_CODE } = require('../../packages/domain/catalog-rows');

const sourcePath =
  process.env.CATALOG_XLSX_PATH || '/app/storage/imports/parking-catalog.xlsx';
const sheetName = process.env.CATALOG_XLSX_SHEET || 'Лист1';
const databaseUrl = process.env.DATABASE_URL;
// A scheduled run has no operator; `catalog_import` is what the audit trail has recorded for
// this script since the first import, and keeping it is what lets the journal tell a CLI
// import apart from an operator's upload.
const ACTOR = { authUserId: null, service: 'catalog_import' };

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function readPlaces() {
  const { places, problems } = readCatalogSheet(xlsx.readFile(sourcePath), {
    sheetName,
    sourceFile: path.basename(sourcePath)
  });

  // The script has always warned about duplicate codes and silently dropped rows it could not
  // read; both are now reported the same way, so the warning is a rendering of the problems
  // the upload endpoint answers with.
  for (const problem of problems) {
    if (problem.reason === REFUSAL_DUPLICATE_CODE) {
      console.warn(`Skipping duplicate place code ${problem.code}`);
    }
  }

  return places;
}

async function main() {
  const places = readPlaces();
  const pool = new Pool({ connectionString: databaseUrl });
  const service = createCatalogImportService({ pool });

  try {
    await service.importCatalog({
      actor: ACTOR,
      places,
      source: { sourceFile: path.basename(sourcePath), sourceSheet: sheetName }
    });
  } finally {
    await pool.end();
  }

  console.log(`Imported parking places: ${places.length}`);
}

main().catch((error) => {
  // A workbook this import cannot read is the operator's problem to fix, not a stack trace.
  console.error(error instanceof CatalogWorkbookError ? error.message : error);
  process.exit(1);
});
