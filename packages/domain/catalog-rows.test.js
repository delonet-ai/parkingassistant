'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROBLEM_REPORT_LIMIT,
  clean,
  inferPositionHint,
  isGuest,
  mapCatalogRows,
  missingCatalogColumns,
  normalizeCode,
  normalizeFloor
} = require('./catalog-rows');

// The sheet's own header spelling, trailing spaces included — the importer reads these keys
// verbatim, so a test that tidies them up would pass while the real file maps to nothing.
// Shaped after CATALOG_ROWS in apps/api/integration/e2e-day.itest.js.
function row({ level = 'G4', place = '101', status = 'Закреплено', department = 'ИТ', assignee = 'Иванов' } = {}) {
  return {
    'Уровень': level,
    'Место ': place,
    'Статус': status,
    'Дирекция ': department,
    'Кем': assignee
  };
}

const SOURCE = { sourceFile: 'parking-catalog.xlsx', sourceSheet: 'Лист1' };

/**
 * The place one row maps to, or `null` for a row that maps to none.
 *
 * Through `mapCatalogRows`, because that is the only entry point production has: a helper that
 * classified a row on its own would be a second path these assertions could pass against while
 * the importers took the first.
 */
function placeOf(cells, source = SOURCE) {
  return mapCatalogRows([row(cells)], source).places[0] ?? null;
}

test('a closed-assignment row becomes a regular place', () => {
  const place = placeOf({ place: '110', department: 'Финансы', assignee: 'Кузнецов' });

  assert.deepEqual(place, {
    code: '110',
    title: '110',
    floorLabel: '4',
    linePositionHint: null,
    placeRole: 'regular',
    guestPriorityRank: null,
    metadata: {
      sourceFile: 'parking-catalog.xlsx',
      sourceSheet: 'Лист1',
      sourceFloor: 'G4',
      sourcePlace: '110',
      sourceStatus: 'Закреплено',
      sourceDepartment: 'Финансы',
      sourceAssignee: 'Кузнецов'
    }
  });
});

test('a guest row becomes the rotatable pool with the first priority rank', () => {
  const place = placeOf({ place: '120', status: 'Гостевое', assignee: '' });

  assert.equal(place.placeRole, 'rotatable');
  assert.equal(place.guestPriorityRank, 1);
  assert.equal(place.metadata.sourceStatus, 'Гостевое');
});

test('a position word becomes a hint and is then discarded', () => {
  const front = placeOf({ place: '101 передний' });
  const middle = placeOf({ place: '102 средний' });
  const rear = placeOf({ place: '103 задний' });

  assert.deepEqual(
    [front.linePositionHint, middle.linePositionHint, rear.linePositionHint],
    [1, 2, 3]
  );

  // The code is the digits only: the word survives in the title and the metadata, and the
  // line the import derives from the hints is what decides place_type.
  assert.deepEqual([front.code, middle.code, rear.code], ['101', '102', '103']);
  assert.equal(front.title, '101 передний');
  assert.equal(front.metadata.sourcePlace, '101 передний');
});

test('a row with no position word has no hint and still becomes a place', () => {
  const place = placeOf({ place: '110' });

  assert.equal(place.linePositionHint, null);
  assert.equal(place.code, '110');
});

test('rows the catalog does not describe a place with are refused', () => {
  // A section heading: a place cell with no digit in it.
  assert.equal(placeOf({ place: 'Резерв' }), null);
  assert.equal(placeOf({ place: '' }), null);
  assert.equal(placeOf({ level: '' }), null);
  assert.equal(placeOf({ status: '' }), null);
  assert.equal(mapCatalogRows([{}], SOURCE).places[0] ?? null, null);
});

test('the source labels are recorded, and are null when the caller names no file', () => {
  const place = placeOf({}, {});

  assert.equal(place.metadata.sourceFile, null);
  assert.equal(place.metadata.sourceSheet, null);
});

test('whitespace in a cell is collapsed, not preserved', () => {
  const place = placeOf({ place: ' 101   передний ', level: ' G4 ' });

  assert.equal(place.title, '101 передний');
  assert.equal(place.floorLabel, '4');
  assert.equal(place.linePositionHint, 1);
});

test('clean turns anything into a single-spaced string', () => {
  assert.equal(clean('  a\n b\t'), 'a b');
  assert.equal(clean(null), '');
  assert.equal(clean(0), '');
  assert.equal(clean(120), '120');
});

test('normalizeFloor takes the digits, and keeps the label when there are none', () => {
  assert.equal(normalizeFloor('G4'), '4');
  assert.equal(normalizeFloor('Уровень 3'), '3');
  assert.equal(normalizeFloor('подземный'), 'подземный');
});

test('normalizeCode takes the digits, and keeps the text when there are none', () => {
  assert.equal(normalizeCode('101 передний'), '101');
  assert.equal(normalizeCode('A-12'), '12');
  assert.equal(normalizeCode('VIP'), 'VIP');
});

test('inferPositionHint reads the sheet wording and nothing else', () => {
  assert.equal(inferPositionHint('101 ПЕРЕДНИЙ'), 1);
  assert.equal(inferPositionHint('102 средняя'), 2);
  assert.equal(inferPositionHint('103 заднее'), 3);
  assert.equal(inferPositionHint('110'), null);
});

test('isGuest matches the status stem, whatever the ending', () => {
  assert.equal(isGuest('Гостевое'), true);
  assert.equal(isGuest('гостевая стоянка'), true);
  assert.equal(isGuest('Закреплено'), false);
  assert.equal(isGuest(''), false);
});

// mapCatalogRows is what both importers call: the CLI renders its problems as warnings, the
// upload endpoint answers with them. The row numbers it reports are Excel's, counted from the
// sheet the importer reads with `range: 1` — title on 1, header on 2, first place on 3.

test('a whole sheet maps to the places to write and the rows that will not be written', () => {
  const { places, problems } = mapCatalogRows(
    [
      row({ place: '101 передний' }),
      row({ place: 'Резерв' }),
      row({ place: '110', level: '' }),
      row({ place: '120', status: 'Гостевое' })
    ],
    SOURCE
  );

  assert.deepEqual(
    places.map((place) => place.code),
    ['101', '120']
  );
  assert.deepEqual(problems, [
    { row: 4, reason: 'place_without_digits', code: null, floor: 'G4', place: 'Резерв', status: 'Закреплено' },
    { row: 5, reason: 'missing_required_cells', code: null, floor: '', place: '110', status: 'Закреплено' }
  ]);
});

test('a repeated code keeps the first row and reports the second', () => {
  const { places, problems } = mapCatalogRows(
    [row({ place: '101 передний' }), row({ place: '101', assignee: 'Петров' })],
    SOURCE
  );

  assert.equal(places.length, 1);
  // The first occurrence won: the title still carries the position word from row 3.
  assert.equal(places[0].title, '101 передний');
  assert.deepEqual(problems, [
    { row: 4, reason: 'duplicate_code', code: '101', floor: 'G4', place: '101', status: 'Закреплено' }
  ]);
});

test('an empty sheet maps to nothing at all, not to an error', () => {
  assert.deepEqual(mapCatalogRows([], SOURCE), { places: [], problems: [], problemsTotal: 0 });
  assert.deepEqual(mapCatalogRows(undefined, SOURCE), { places: [], problems: [], problemsTotal: 0 });
});

// The sheet groups places with empty lines. `sheet_to_json` drops a row with no cells at all,
// but keeps one whose cells exist and hold nothing — a styled or once-filled separator — and
// reporting those as refusals buried the two that matter under one warning per blank line.
test('a blank separator line is skipped without being reported as a refused row', () => {
  const { places, problems, problemsTotal } = mapCatalogRows(
    [
      row({ place: '101' }),
      row({ level: '', place: '', status: '', department: '', assignee: '' }),
      // Whitespace is blank too: `clean` collapses it, so this is the same row to the mapping.
      row({ level: ' ', place: '  ', status: '', department: ' ', assignee: '' }),
      row({ place: '102' })
    ],
    SOURCE
  );

  assert.deepEqual(places.map((place) => place.code), ['101', '102']);
  assert.deepEqual(problems, []);
  assert.equal(problemsTotal, 0);
});

// A row missing only *some* cells is still a refusal: it was meant to be a place.
test('a half-filled row is still reported, unlike a blank one', () => {
  const { problems } = mapCatalogRows([row({ level: '', place: '110', assignee: '' })], SOURCE);

  assert.deepEqual(
    problems.map((problem) => problem.reason),
    ['missing_required_cells']
  );
});

// An .xlsx is a zip: 200 000 junk rows compress to about 8 MB, under the endpoint's 10 MB
// limit. Reporting one entry per row would answer with tens of megabytes of JSON and ask the
// UI to render an element for each. The count survives in full; the list is the first few.
test('the reported problems are capped while the count is not', () => {
  const rows = [];

  for (let index = 0; index < PROBLEM_REPORT_LIMIT + 50; index += 1) {
    rows.push(row({ place: 'итого' }));
  }

  const { places, problems, problemsTotal } = mapCatalogRows(rows, SOURCE);

  assert.deepEqual(places, []);
  assert.equal(problems.length, PROBLEM_REPORT_LIMIT);
  assert.equal(problemsTotal, PROBLEM_REPORT_LIMIT + 50);
  // The ones kept are the first ones, so the row numbers point at the top of the sheet.
  assert.equal(problems[0].row, 3);
});

test('every mapped place carries the source labels the sheet was read under', () => {
  const { places } = mapCatalogRows([row({ place: '101' })], SOURCE);

  assert.equal(places[0].metadata.sourceFile, 'parking-catalog.xlsx');
  assert.equal(places[0].metadata.sourceSheet, 'Лист1');
});

// The one thing the row number cannot be derived from is the array index: `sheet_to_json`
// omits a fully blank row, so the reader records the sheet's own position on each object and
// the mapping quotes that. A problem that named the wrong line would send the operator to edit
// a row that is fine.
test('a problem quotes the row of the sheet, not the position in the array', () => {
  function atSheetRow(sheetRow, cells) {
    // `__rowNum__` is 0-based and non-enumerable, exactly as the reader leaves it.
    return Object.defineProperty(row(cells), '__rowNum__', { value: sheetRow - 1 });
  }

  const { places, problems } = mapCatalogRows(
    [atSheetRow(3, { place: '101' }), atSheetRow(7, { place: 'Резерв' }), atSheetRow(9, { place: '101' })],
    SOURCE
  );

  assert.deepEqual(places.map((place) => place.code), ['101']);
  assert.deepEqual(
    problems.map((problem) => [problem.row, problem.reason]),
    [
      [7, 'place_without_digits'],
      [9, 'duplicate_code']
    ]
  );
});

// The header is the one thing the row-level problems cannot report: without it every row maps
// to five empty cells, which the mapping reads as a blank separator line and skips. A reader
// that did not ask this question refused the file with an empty problem list.
test('missingCatalogColumns names the required columns the header does not have', () => {
  assert.deepEqual(missingCatalogColumns([row({})]), []);
  // A sheet read one row too low: the first data row became the header.
  assert.deepEqual(missingCatalogColumns([{ 'G4': 'G4', '101': '102', 'Закреплено': 'Закреплено' }]), [
    'Уровень',
    'Место ',
    'Статус'
  ]);
  // The trailing space in `Место ` is part of the key the cells are read by.
  assert.deepEqual(missingCatalogColumns([{ 'Уровень': 'G4', 'Место': '101', 'Статус': 'Закреплено' }]), [
    'Место '
  ]);
  // The two optional columns are not required: a sheet without them still describes places.
  assert.deepEqual(missingCatalogColumns([{ 'Уровень': 'G4', 'Место ': '101', 'Статус': 'Закреплено' }]), []);
  assert.deepEqual(missingCatalogColumns([]), ['Уровень', 'Место ', 'Статус']);
});
