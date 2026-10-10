'use strict';

const xlsx = require('xlsx');

const {
  CATALOG_COLUMNS,
  mapCatalogRows,
  missingCatalogColumns
} = require('../../../../../packages/domain/catalog-rows');
const { withTransaction } = require('../../repositories/db');
const { AbortTransaction } = require('../../support/transaction');
const { auditActor } = require('../../support/actor');
const auditRepository = require('../audit/repository');
const repository = require('./repository');

// The parking catalog, imported from an Excel workbook.
//
// Two callers, one implementation: `POST /admin/catalog-import` hands over the bytes a browser
// uploaded, and `scripts/import/parking-catalog.js` hands over a file it read from the imports
// mount. Everything after "here is a workbook" is this module — the sheet it reads, the rows it
// refuses, the transaction it writes in and the audit row it leaves — because the one way for an
// upload feature to go wrong is to decide a row differently from the CLI that has been importing
// the real file all along.
//
// The sheet the catalog actually lives on. The CLI reads it from CATALOG_XLSX_SHEET and has
// always defaulted to this, so it stays the default here; a workbook saved with a renamed sheet
// is named explicitly instead.
const DEFAULT_SHEET = 'Лист1';

// How many rows of one sheet the import will read. The real catalog is a few hundred places,
// and the limit is three orders of magnitude of headroom — but an .xlsx is a zip, so a sheet of
// repeated junk rows stays well under the upload limit at two hundred thousand rows, and each
// row read becomes an `INSERT` into the staging table inside the open transaction.
//
// Counted on the rows `sheet_to_json` returned, not on the sheet's declared `!ref` range.
// Excel writes `<dimension>` over every row it has ever formatted, so a catalog of two hundred
// places can declare the sheet's full million — refusing the file by that number would refuse
// the real workbook, and tell the operator it "is not the parking catalog". The declaration is
// no cheaper a guard anyway: `xlsx.read` has already parsed the worksheet into cells before
// either number exists, so what this limit bounds is the write (one staging INSERT per row
// inside the open transaction), not the parse. Bounding the parse would mean reading the zip's
// central directory first, or parsing outside this process; neither is done here, and the
// upload limit in the controller is the only thing standing in front of it.
const MAX_SHEET_ROWS = 5000;

/** A workbook this module cannot read: not a spreadsheet, or no such sheet in it. */
class CatalogWorkbookError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CatalogWorkbookError';
  }
}

/**
 * The rows of one catalog sheet, mapped to places and problems.
 *
 * `range: 1` skips the workbook's title row — row 2 is the header and row 3 the first place,
 * which is the numbering `mapCatalogRows` quotes back in a problem. `defval: ''` keeps an empty
 * cell as an empty string so a row with gaps is still refused by the mapping rather than by a
 * property lookup on `undefined`.
 */
function readSheet(workbook, { sheetName, sourceFile = null } = {}) {
  const resolved = sheetName || DEFAULT_SHEET;

  // Asked of `SheetNames`, not of `Sheets[resolved]`: the sheet name is a client-supplied
  // string, and `sheet=__proto__` (or `constructor`, or `toString`) finds a truthy *inherited*
  // property on the map of sheets, skipping this refusal to fail later and less clearly.
  if (!workbook.SheetNames.includes(resolved)) {
    throw new CatalogWorkbookError(
      `Sheet not found: ${resolved} (workbook has ${workbook.SheetNames.join(', ') || 'no sheets'})`
    );
  }

  const sheet = workbook.Sheets[resolved];
  const rows = xlsx.utils.sheet_to_json(sheet, { range: 1, defval: '' });

  // Blank rows are not in `rows` — `sheet_to_json` drops them unless asked for — so this is
  // the count of rows that carry something, which is also the count that would be staged.
  if (rows.length > MAX_SHEET_ROWS) {
    throw new CatalogWorkbookError(
      `Sheet ${resolved} has ${rows.length} rows, more than the ${MAX_SHEET_ROWS} this import reads:` +
        ' this is not the parking catalog'
    );
  }

  // Before the rows: a sheet whose header is missing maps every row to empty cells, which the
  // mapping reads as blank separator lines and skips silently — so the refusal below would be
  // "nothing was understood" with nothing said about why.
  const missingColumns = rows.length > 0 ? missingCatalogColumns(rows) : [];

  if (missingColumns.length > 0) {
    throw new CatalogWorkbookError(
      `Sheet ${resolved} has no header row with ${missingColumns.join(', ')}:` +
        ` the header belongs in row 2, with the columns ${CATALOG_COLUMNS.join(', ')}`
    );
  }

  const { places, problems, problemsTotal } = mapCatalogRows(rows, {
    sourceFile,
    sourceSheet: resolved
  });

  return {
    sheetName: resolved,
    sourceFile,
    rowsRead: rows.length,
    places,
    problems,
    problemsTotal
  };
}

/**
 * A catalog sheet, read from the bytes of a workbook. The only reader: the CLI reads the file
 * from the imports mount and the endpoint takes an upload, and both hand over a buffer, so
 * neither can be refused for a reason the other would not be.
 *
 * The signature check is not belt-and-braces: `xlsx.read` is deliberately forgiving and parses
 * arbitrary text as a one-sheet workbook called `Sheet1`, so a renamed .txt would otherwise be
 * refused with "Sheet not found: Лист1" — an answer that sends the operator looking for the
 * wrong mistake. An .xlsx is a zip archive, and every zip starts with `PK`.
 */
function readCatalogBuffer(buffer, options = {}) {
  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new CatalogWorkbookError('Workbook could not be read: the file is not an .xlsx workbook');
  }

  const sheetName = options.sheetName || DEFAULT_SHEET;
  let workbook;

  try {
    // Only the sheet the import reads is materialized; `SheetNames` is still the whole list, so
    // "Sheet not found" can still say what the workbook does have. A catalog file carries one
    // sheet, but a workbook with a megabyte of unrelated sheets would otherwise be parsed in
    // full to read one of them.
    workbook = xlsx.read(buffer, { type: 'buffer', sheets: [sheetName] });
  } catch (error) {
    throw new CatalogWorkbookError(`Workbook could not be read: ${error.message}`);
  }

  return readSheet(workbook, { ...options, sheetName });
}

function createCatalogImportService({ pool }) {
  /**
   * Writes the places a sheet mapped to, or reports what writing them would do.
   *
   * Takes the reader's whole result rather than its places plus the source labels again: the
   * labels stamped into every place's metadata and the ones on the audit row then cannot
   * disagree, which they could while each caller threaded them separately.
   *
   * Returns the same summary either way, so neither caller has to know which mode it asked
   * for to read the answer.
   */
  async function importCatalog({ actor, dryRun = false, sheet }) {
    const places = sheet.places;
    try {
      return await withTransaction(pool, async (repo) => {
        await repository.createStagingTable(repo);

        for (const place of places) {
          await repository.stagePlace(repo, place);
        }

        await repository.deriveLines(repo);

        // Before the upserts: afterwards every staged row exists and the question
        // "created or updated?" has no answer left.
        const lines = await repository.countLineChanges(repo);
        const placeCounts = await repository.countPlaceChanges(repo);

        await repository.upsertLineGroups(repo);
        await repository.upsertPlaces(repo);
        await repository.assignPlaceLines(repo);

        await auditRepository.insertAuditLog(repo, {
          entityType: 'parking_place',
          action: 'parking_catalog_imported',
          ...auditActor(actor),
          metadata: {
            sourceFile: sheet.sourceFile ?? null,
            sourceSheet: sheet.sheetName ?? null,
            importedPlaces: places.length
          }
        });

        const summary = {
          dryRun,
          placesStaged: places.length,
          placesCreated: placeCounts.created,
          placesUpdated: placeCounts.updated,
          linesCreated: lines.created,
          linesUpdated: lines.updated
        };

        // A dry run runs the *whole* import — staging, lines, places, `assign_place_lines()`,
        // the audit row — and then aborts, which `withTransaction` turns into a rollback. The
        // counts it reports are therefore measured against the real tables with the real
        // constraints in force; a second, write-free code path would be a different program
        // reporting on behalf of this one, and would pass its tests while the apply it
        // predicts fails. `AbortTransaction` is the repo's carrier for exactly this — roll
        // back and still answer with a payload — and nothing else in the block throws it.
        if (dryRun) {
          throw new AbortTransaction(summary);
        }

        return summary;
      });
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      throw error;
    }
  }

  return { importCatalog };
}

module.exports = {
  CatalogWorkbookError,
  MAX_SHEET_ROWS,
  createCatalogImportService,
  readCatalogBuffer
};
