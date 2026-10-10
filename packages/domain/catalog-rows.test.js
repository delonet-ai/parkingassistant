'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  clean,
  inferPositionHint,
  isGuest,
  normalizeCode,
  normalizeFloor,
  rowToPlace
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

test('a closed-assignment row becomes a regular place', () => {
  const place = rowToPlace(row({ place: '110', department: 'Финансы', assignee: 'Кузнецов' }), SOURCE);

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
  const place = rowToPlace(row({ place: '120', status: 'Гостевое', assignee: '' }), SOURCE);

  assert.equal(place.placeRole, 'rotatable');
  assert.equal(place.guestPriorityRank, 1);
  assert.equal(place.metadata.sourceStatus, 'Гостевое');
});

test('a position word becomes a hint and is then discarded', () => {
  const front = rowToPlace(row({ place: '101 передний' }), SOURCE);
  const middle = rowToPlace(row({ place: '102 средний' }), SOURCE);
  const rear = rowToPlace(row({ place: '103 задний' }), SOURCE);

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
  const place = rowToPlace(row({ place: '110' }), SOURCE);

  assert.equal(place.linePositionHint, null);
  assert.equal(place.code, '110');
});

test('rows the catalog does not describe a place with are refused', () => {
  // A section heading: a place cell with no digit in it.
  assert.equal(rowToPlace(row({ place: 'Резерв' }), SOURCE), null);
  assert.equal(rowToPlace(row({ place: '' }), SOURCE), null);
  assert.equal(rowToPlace(row({ level: '' }), SOURCE), null);
  assert.equal(rowToPlace(row({ status: '' }), SOURCE), null);
  assert.equal(rowToPlace({}, SOURCE), null);
});

test('the source labels are recorded, and are null when the caller names no file', () => {
  const place = rowToPlace(row(), {});

  assert.equal(place.metadata.sourceFile, null);
  assert.equal(place.metadata.sourceSheet, null);
});

test('whitespace in a cell is collapsed, not preserved', () => {
  const place = rowToPlace(row({ place: ' 101   передний ', level: ' G4 ' }), SOURCE);

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
