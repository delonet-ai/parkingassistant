'use strict';

// How one row of the parking catalog spreadsheet becomes one parking place.
//
// Lifted out of scripts/import/parking-catalog.js so the CLI and the upload endpoint decide a
// row the same way; the staged upsert that writes the places stays in the importer. Pure: a
// row in, a place or `null` out, and the source labels it records are passed in rather than
// read from the environment.
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

/**
 * `source` names where the row came from — `{ sourceFile, sourceSheet }` — and is recorded in
 * the place's metadata beside the raw cells, which is the only trace of the spreadsheet left
 * after the import derives everything else.
 *
 * Returns `null` for a row the catalog does not describe a place with: a missing level, place
 * or status, or a place cell with no digit in it (the sheet uses those for section headings).
 */
function rowToPlace(row, source = {}) {
  const floorRaw = clean(row['Уровень']);
  const placeRaw = clean(row['Место ']);
  const statusRaw = clean(row['Статус']);
  const departmentRaw = clean(row['Дирекция ']);
  const assigneeRaw = clean(row['Кем']);

  if (!floorRaw || !placeRaw || !statusRaw) {
    return null;
  }

  if (!/\d/.test(placeRaw)) {
    return null;
  }

  const code = normalizeCode(placeRaw);
  const floorLabel = normalizeFloor(floorRaw);
  const linePositionHint = inferPositionHint(placeRaw);
  const guest = isGuest(statusRaw);

  // place_type is deliberately absent: line_groups.capacity is its source of truth and
  // the import derives it from the group it lands the place in (see importPlaces).
  return {
    code,
    title: placeRaw,
    floorLabel,
    linePositionHint,
    // A guest place is the guest pool, which is what place_role = 'rotatable' means.
    placeRole: guest ? 'rotatable' : 'regular',
    guestPriorityRank: guest ? 1 : null,
    metadata: {
      sourceFile: source.sourceFile ?? null,
      sourceSheet: source.sourceSheet ?? null,
      sourceFloor: floorRaw,
      sourcePlace: placeRaw,
      sourceStatus: statusRaw,
      sourceDepartment: departmentRaw,
      sourceAssignee: assigneeRaw
    }
  };
}

module.exports = {
  clean,
  normalizeFloor,
  normalizeCode,
  inferPositionHint,
  isGuest,
  rowToPlace
};
