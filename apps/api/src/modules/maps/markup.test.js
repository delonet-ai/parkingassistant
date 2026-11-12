'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { MAX_EDITOR_BYTES, MAX_POLYGON_POINTS, readMarkupDocument } = require('./markup');

const PLACE = '11111111-2222-4333-8444-555555555555';
const SQUARE = [[10, 10], [60, 10], [60, 120], [10, 120]];

function body(overrides = {}) {
  return {
    mapCode: 'G4',
    imageWidth: 3504,
    imageHeight: 2496,
    places: { [PLACE]: { polygon: SQUARE } },
    editor: { rows: [] },
    revision: null,
    ...overrides
  };
}

describe('readMarkupDocument', () => {
  it('accepts a well-formed document and normalizes the map code', () => {
    const { value, error } = readMarkupDocument(body());

    assert.equal(error, undefined);
    assert.equal(value.mapCode, 'g4');
    assert.deepEqual(value.places[PLACE].polygon, SQUARE);
    assert.deepEqual(value.editor, { rows: [] });
    assert.equal(value.revision, null);
  });

  it('rounds coordinates to a tenth of a pixel and lowercases place ids', () => {
    const { value } = readMarkupDocument(
      body({ places: { [PLACE.toUpperCase()]: { polygon: [[1.234, 2.25], [3, 4], [5.06, 6]] } } })
    );

    assert.deepEqual(Object.keys(value.places), [PLACE]);
    assert.deepEqual(value.places[PLACE].polygon, [[1.2, 2.3], [3, 4], [5.1, 6]]);
  });

  it('treats a missing editor as empty and keeps an explicit revision', () => {
    const { value } = readMarkupDocument(body({ editor: undefined, revision: 7 }));

    assert.deepEqual(value.editor, {});
    assert.equal(value.revision, 7);
  });

  it('refuses a body that is not an object, or has no map code', () => {
    assert.match(readMarkupDocument(null).error, /JSON object/);
    assert.match(readMarkupDocument([]).error, /JSON object/);
    assert.match(readMarkupDocument(body({ mapCode: '  ' })).error, /mapCode is required/);
  });

  it('refuses image sizes that are not positive integers within bounds', () => {
    for (const imageWidth of [0, -1, 1.5, '3504', null, 20001]) {
      assert.match(readMarkupDocument(body({ imageWidth })).error, /imageWidth/);
    }
  });

  it('refuses a revision that is not a positive integer', () => {
    for (const revision of [0, -2, 1.5, '3']) {
      assert.match(readMarkupDocument(body({ revision })).error, /revision/);
    }
  });

  it('names the place whose key or polygon is bad', () => {
    const notUuid = readMarkupDocument(body({ places: { 'p-1': { polygon: SQUARE } } }));
    assert.match(notUuid.error, /parking place id/);
    assert.deepEqual(notUuid.details, { placeId: 'p-1' });

    const tooFew = readMarkupDocument(body({ places: { [PLACE]: { polygon: [[0, 0], [1, 1]] } } }));
    assert.match(tooFew.error, /3 to 64 points/);
    assert.deepEqual(tooFew.details, { placeId: PLACE });

    const tooMany = Array.from({ length: MAX_POLYGON_POINTS + 1 }, (_, i) => [i, i]);
    assert.match(readMarkupDocument(body({ places: { [PLACE]: { polygon: tooMany } } })).error, /points/);

    assert.match(
      readMarkupDocument(body({ places: { [PLACE]: { polygon: [[0, 0], [1, 'x'], [2, 2]] } } })).error,
      /finite numbers/
    );
    assert.match(readMarkupDocument(body({ places: { [PLACE]: { polygon: [[0, 0], [1], [2, 2]] } } })).error, /\[x, y\]/);
    assert.match(readMarkupDocument(body({ places: { [PLACE]: SQUARE } })).error, /points/);
  });

  it('allows a polygon slightly over the edge but refuses one far outside the image', () => {
    const overEdge = [[-50, 0], [100, 0], [100, 2550], [-50, 2550]];
    assert.equal(readMarkupDocument(body({ places: { [PLACE]: { polygon: overEdge } } })).error, undefined);

    const farOutside = [[9000, 0], [9100, 0], [9100, 100]];
    assert.match(readMarkupDocument(body({ places: { [PLACE]: { polygon: farOutside } } })).error, /outside/);
  });

  it('refuses places that is not an object and an editor that is not an object or too large', () => {
    assert.match(readMarkupDocument(body({ places: [] })).error, /places must be an object/);
    assert.match(readMarkupDocument(body({ editor: [1] })).error, /editor must be an object/);
    assert.match(
      readMarkupDocument(body({ editor: { blob: 'x'.repeat(MAX_EDITOR_BYTES) } })).error,
      /at most 256 KB/
    );
  });
});
