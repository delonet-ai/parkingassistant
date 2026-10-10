'use strict';

// How one row of the parking catalog spreadsheet becomes one parking place.
//
// Lifted out of scripts/import/parking-catalog.js so the CLI and the upload endpoint decide a
// row the same way; the staged upsert that writes the places lives in
// apps/api/src/modules/catalog-import, which both of them call. Pure: rows in, places and
// problems out, and the source labels recorded in a place's metadata are passed in rather
// than read from the environment.
//
// Required by path, not through packages/domain/index.js: `clean` and `normalizeCode` are too
// generic to put in the barrel every service imports from.

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeFloor(value) {
  const text = clean(value).toLowerCase();
  const match = text.match(/\d+/);
  return match ? match[0] : clean(value);
}

function normalizeCode(value) {
  const text = clean(value);
  const match = text.match(/\d+/);
  return match ? match[0] : text;
}

function inferPositionHint(rawPlace) {
  const text = clean(rawPlace).toLowerCase();

  if (text.includes('перед')) {
    return 1;
  }

  if (text.includes('средн')) {
    return 2;
  }

  if (text.includes('задн')) {
    return 3;
  }

  return null;
}

function isGuest(status) {
  return clean(status).toLowerCase().includes('гост');
}

// Why a row was not understood. Returned by `mapCatalogRows` so the operator importing a
// workbook from the UI is told which lines were dropped and why, instead of getting a count
// that silently disagrees with the sheet. Codes, not sentences: the UI labels them.
const REFUSAL_MISSING_CELLS = 'missing_required_cells';
const REFUSAL_PLACE_WITHOUT_DIGITS = 'place_without_digits';
const REFUSAL_DUPLICATE_CODE = 'duplicate_code';

// The sheet's first data row. The importer reads the sheet with `range: 1`, so row 1 is the
// title, row 2 the header, and the first mapped row is the third — which is the number the
// operator sees in Excel and therefore the number a problem has to quote.
const FIRST_DATA_ROW = 3;

function readCells(row) {
  return {
    floor: clean(row['Уровень']),
    place: clean(row['Место ']),
    status: clean(row['Статус']),
    department: clean(row['Дирекция ']),
    assignee: clean(row['Кем'])
  };
}

/**
 * One row, classified: either a place or the reason it is not one. `rowToPlace` and
 * `mapCatalogRows` both go through here so the rules that refuse a row exist once — a second
 * copy is what would let the CLI and the upload endpoint drift apart on the same file.
 *
 * `source` names where the row came from — `{ sourceFile, sourceSheet }` — and is recorded in
 * the place's metadata beside the raw cells, which is the only trace of the spreadsheet left
 * after the import derives everything else.
 */
function classifyRow(row, source = {}) {
  const cells = readCells(row);

  // A row the catalog does not describe a place with: a missing level, place or status, or a
  // place cell with no digit in it (the sheet uses those for section headings).
  if (!cells.floor || !cells.place || !cells.status) {
    return { cells, place: null, refusal: REFUSAL_MISSING_CELLS };
  }

  if (!/\d/.test(cells.place)) {
    return { cells, place: null, refusal: REFUSAL_PLACE_WITHOUT_DIGITS };
  }

  const guest = isGuest(cells.status);

  // place_type is deliberately absent: line_groups.capacity is its source of truth and
  // the import derives it from the group it lands the place in (see importPlaces).
  return {
    cells,
    refusal: null,
    place: {
      code: normalizeCode(cells.place),
      title: cells.place,
      floorLabel: normalizeFloor(cells.floor),
      linePositionHint: inferPositionHint(cells.place),
      // A guest place is the guest pool, which is what place_role = 'rotatable' means.
      placeRole: guest ? 'rotatable' : 'regular',
      guestPriorityRank: guest ? 1 : null,
      metadata: {
        sourceFile: source.sourceFile ?? null,
        sourceSheet: source.sourceSheet ?? null,
        sourceFloor: cells.floor,
        sourcePlace: cells.place,
        sourceStatus: cells.status,
        sourceDepartment: cells.department,
        sourceAssignee: cells.assignee
      }
    }
  };
}

/**
 * The place a row describes, or `null` for a row that describes none.
 */
function rowToPlace(row, source = {}) {
  return classifyRow(row, source).place;
}

/**
 * A whole sheet: the places to write, and the rows that will not be written.
 *
 * Duplicate codes are dropped rather than merged — the first occurrence wins, which is what
 * the CLI has always done — and reported, because a sheet that names a place twice is an
 * editing mistake the operator should see rather than a silent choice between two rows.
 *
 * Pure: no database, no file system, no environment. The CLI and `POST /admin/catalog-import`
 * both map a sheet through this, so neither can decide a row the other would not.
 */
function mapCatalogRows(rows, source = {}) {
  const places = [];
  const problems = [];
  const firstRowOfCode = new Map();

  (rows || []).forEach((row, index) => {
    const sheetRow = index + FIRST_DATA_ROW;
    const { cells, place, refusal } = classifyRow(row, source);

    function reject(reason, code = null) {
      problems.push({
        row: sheetRow,
        reason,
        code,
        floor: cells.floor,
        place: cells.place,
        status: cells.status
      });
    }

    if (!place) {
      reject(refusal);
      return;
    }

    if (firstRowOfCode.has(place.code)) {
      reject(REFUSAL_DUPLICATE_CODE, place.code);
      return;
    }

    firstRowOfCode.set(place.code, sheetRow);
    places.push(place);
  });

  return { places, problems };
}

module.exports = {
  REFUSAL_DUPLICATE_CODE,
  clean,
  inferPositionHint,
  isGuest,
  mapCatalogRows,
  normalizeCode,
  normalizeFloor,
  rowToPlace
};
