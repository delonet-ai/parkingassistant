'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const xlsx = require('xlsx');

const { CATALOG_COLUMNS } = require('../../../../../packages/domain/catalog-rows');
const {
  CatalogWorkbookError,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  readCatalogBuffer,
  readSheet
} = require('./service');

// What the reader does with a sheet whose *declared* extent disagrees with its cells.
//
// `sheet_to_json` walks the range from the worksheet's `<dimension ref>` tag, cell by cell, and
// that tag is written by whoever saved the file. Before the bounds below, a 16 KB workbook
// holding three real rows could declare `A1:ZZ100000` and cost ~36 seconds of synchronous cell
// lookups inside the API process — a signed-in operator could stall every route with one small
// upload, and the file was *accepted*, because the row limit counted the rows that came back
// (three) rather than the rows that were walked.
//
// No database here on purpose: this is the parse, and it is the half of the import that runs
// before a transaction is opened.

const TITLE_ROW = ['Парковочный каталог', '', '', '', ''];

function placeRow(index) {
  return ['G4', String(100 + index), 'Закреплено', 'ИТ', 'Иванов'];
}

function catalogRows(dataRows) {
  const rows = [TITLE_ROW, CATALOG_COLUMNS.slice()];

  for (let index = 0; index < dataRows; index += 1) {
    rows.push(placeRow(index));
  }

  return rows;
}

function workbookBuffer(rows) {
  const workbook = xlsx.utils.book_new();

  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), 'Лист1');

  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * A parsed workbook with a `<dimension>` wider and taller than its cells — the shape `xlsx.read`
 * hands back for a file saved from a formatted template. Assembled rather than written and read
 * back: `xlsx.write` walks the declared range as well, so a million-row declaration would cost
 * the test the very minutes the reader no longer costs the API.
 */
function workbookWithDeclaredRef(rows, declaredRef) {
  const sheet = xlsx.utils.aoa_to_sheet(rows);

  sheet['!fullref'] = sheet['!ref'];
  sheet['!ref'] = declaredRef;

  return { SheetNames: ['Лист1'], Sheets: { 'Лист1': sheet } };
}

function catalogBuffer(dataRows) {
  return workbookBuffer(catalogRows(dataRows));
}

test('reads a sheet whose declared range is orders of magnitude larger than its cells', () => {
  // Excel declares `<dimension>` over every row it has ever formatted, so refusing the file for
  // this would refuse the real catalog: the three rows must still be read.
  const workbook = workbookWithDeclaredRef(catalogRows(3), 'A1:ZZ100000');

  const startedAt = process.hrtime.bigint();
  const sheet = readSheet(workbook, { sheetName: 'Лист1', sourceFile: 'inflated.xlsx' });
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  assert.equal(sheet.rowsRead, 3);
  assert.equal(sheet.places.length, 3);
  assert.equal(sheet.problemsTotal, 0);

  // Deliberately loose — a regression bound on the *walk*, not a benchmark. The defect it pins
  // took ~36 seconds on this very sheet, so two orders of magnitude of slack still fails it and
  // leaves a slow machine alone.
  //
  // `A1:ZZ100000` and not the sheet maximum the real template declares, even though that is the
  // worse case: the walk is synchronous, so a regression has to be able to *finish* and fail
  // this assertion. A million rows by 16384 columns would hang the suite instead of failing it.
  assert.ok(elapsedMs < 2000, `reading a bloated declared range took ${elapsedMs.toFixed(0)}ms`);
});


test('stops reading columns past the limit', () => {
  // The row bound alone would not be enough: the limit's worth of rows across a sheet's full
  // 16384 columns is the same order of work as the defect above, so the column span is clamped
  // too. Asserted by putting a column the catalog needs out past the clamp and watching the
  // header refusal fire — the clamp has no other observable effect on a well-formed sheet, and
  // a declared-only span of 16384 columns costs minutes to *write* in a test.
  // `Уровень` — the first column, and one of the two the header refusal is keyed on; the
  // trailing ones are optional, so moving those out of reach would prove nothing.
  const far = MAX_SHEET_COLUMNS + 6;
  const header = CATALOG_COLUMNS.slice();
  const row = placeRow(0);
  const moved = header.shift();

  header[far] = moved;
  row[far] = row.shift();

  assert.throws(
    () => readCatalogBuffer(workbookBuffer([TITLE_ROW, header, row])),
    (error) => error instanceof CatalogWorkbookError && error.message.includes(moved)
  );
  assert.ok(MAX_SHEET_COLUMNS < 16384, 'the column clamp has to be below a sheet maximum to bound anything');
});

test('reads a sheet of exactly the row limit', () => {
  const sheet = readCatalogBuffer(catalogBuffer(MAX_SHEET_ROWS));

  assert.equal(sheet.rowsRead, MAX_SHEET_ROWS);
  assert.equal(sheet.places.length, MAX_SHEET_ROWS);
});

test('refuses a sheet one row past the limit rather than importing a truncated catalog', () => {
  // The bound on the walk stops one data row past the limit precisely so this refusal can still
  // fire: clamping to exactly the limit would have imported the first 5000 rows of a bigger
  // sheet and reported success.
  assert.throws(
    () => readCatalogBuffer(catalogBuffer(MAX_SHEET_ROWS + 1)),
    (error) => error instanceof CatalogWorkbookError && /more than the 5000 rows/.test(error.message)
  );
});

test('refuses a file that is not a workbook before handing it to the parser', () => {
  assert.throws(
    () => readCatalogBuffer(Buffer.from('Уровень;Место;Статус\n')),
    (error) => error instanceof CatalogWorkbookError && /not an \.xlsx workbook/.test(error.message)
  );
});
