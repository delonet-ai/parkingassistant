'use strict';

// Floor-plan markup (ADR 008): one document per plan, saved whole, guarded by a revision.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createFixtures, getJson, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

const SQUARE = [[100, 100], [160, 100], [160, 220], [100, 220]];

describe('floor plan markup (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let fixtures = null;
  let sequence = 0;

  before(async () => {
    db = await createTestDatabase();
    fixtures = createFixtures(db);
    api = await startApi({ databaseUrl: db.connectionString });
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  /** A plan for floor `floorLabel`, with its own code so tests do not share a document. */
  async function insertMap({ floorLabel = '4', checksum = 'sha-1' } = {}) {
    sequence += 1;
    const code = `t${sequence}`;
    await db.query(
      `
        insert into parking_place_maps (code, title, floor_label, file_type, file_path, source_checksum)
        values ($1, $2, $3, 'png', $4, $5)
      `,
      [code, `T${sequence}`, floorLabel, `plan-${code}.png`, checksum]
    );
    return code;
  }

  function document(mapCode, places, revision = null) {
    return { mapCode, imageWidth: 2000, imageHeight: 1500, places, editor: { rows: [{ k: 2 }] }, revision };
  }

  it('answers null for a plan nobody has marked up, and 404 for an unknown plan', async () => {
    const mapCode = await insertMap();

    const empty = await getJson(api.baseUrl, `/admin/map-markup?mapCode=${mapCode}`);
    assert.equal(empty.status, 200);
    assert.equal(empty.payload.markup, null);

    const unknown = await getJson(api.baseUrl, '/admin/map-markup?mapCode=nope');
    assert.equal(unknown.status, 404);

    const missing = await getJson(api.baseUrl, '/admin/map-markup');
    assert.equal(missing.status, 400);
  });

  it('saves a document, reads it back as saved, bumps the revision and writes an audit row', async () => {
    const mapCode = await insertMap();
    const place = await fixtures.insertPlace({ floorLabel: '4' });

    const first = await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [place.id]: { polygon: SQUARE } }));
    assert.equal(first.status, 200, JSON.stringify(first.payload));
    assert.equal(first.payload.markup.revision, 1);
    assert.deepEqual(first.payload.markup.places, { [place.id]: { polygon: SQUARE } });
    assert.deepEqual(first.payload.markup.editor, { rows: [{ k: 2 }] });
    assert.equal(first.payload.markup.imageWidth, 2000);
    assert.equal(first.payload.markup.planChanged, false);
    assert.ok(first.payload.markup.updatedBy, 'the operator who saved is named');

    const read = await getJson(api.baseUrl, `/admin/map-markup?mapCode=${mapCode}`);
    assert.deepEqual(read.payload.markup, first.payload.markup);

    const moved = [[200, 100], [260, 100], [260, 220], [200, 220]];
    const second = await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [place.id]: { polygon: moved } }, 1));
    assert.equal(second.status, 200, JSON.stringify(second.payload));
    assert.equal(second.payload.markup.revision, 2);
    assert.deepEqual(second.payload.markup.places[place.id].polygon, moved);

    const audit = await db.query(
      "select metadata from audit_logs where action = 'parking_place_map_markup_saved' and metadata->>'mapCode' = $1 order by occurred_at",
      [mapCode]
    );
    assert.deepEqual(audit.rows.map((row) => [row.metadata.revision, row.metadata.placeCount]), [[1, 1], [2, 1]]);
  });

  it('refuses a save made against a stale revision with 409 and keeps the newer document', async () => {
    const mapCode = await insertMap();
    const place = await fixtures.insertPlace({ floorLabel: '4' });

    await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [place.id]: { polygon: SQUARE } }));

    // A second operator loaded the plan before the first save and saves "as the first".
    const stale = await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, {}, null));
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.code, 'conflict');
    assert.match(stale.payload.error, /reload/);

    const read = await getJson(api.baseUrl, `/admin/map-markup?mapCode=${mapCode}`);
    assert.deepEqual(Object.keys(read.payload.markup.places), [place.id]);
  });

  it('refuses unknown places and places from another floor, naming them', async () => {
    const mapCode = await insertMap({ floorLabel: '4' });
    const elsewhere = await fixtures.insertPlace({ floorLabel: '5' });

    const unknownId = '00000000-0000-4000-8000-000000000000';
    const unknown = await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [unknownId]: { polygon: SQUARE } }));
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.payload.details, { placeIds: [unknownId] });

    const otherFloor = await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [elsewhere.id]: { polygon: SQUARE } }));
    assert.equal(otherFloor.status, 400);
    assert.deepEqual(otherFloor.payload.details, { placeCodes: [elsewhere.code] });

    const read = await getJson(api.baseUrl, `/admin/map-markup?mapCode=${mapCode}`);
    assert.equal(read.payload.markup, null, 'a refused save writes nothing');
  });

  it('refuses malformed geometry before touching the database', async () => {
    const mapCode = await insertMap();
    const place = await fixtures.insertPlace({ floorLabel: '4' });

    const bad = await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [place.id]: { polygon: [[0, 0], [1, 1]] } }));
    assert.equal(bad.status, 400);
    assert.match(bad.payload.error, /points/);
    assert.deepEqual(bad.payload.details, { placeId: place.id });
  });

  it('flags the markup once the plan image it was drawn on is replaced', async () => {
    const mapCode = await insertMap({ checksum: 'sha-before' });
    const place = await fixtures.insertPlace({ floorLabel: '4' });

    await postJson(api.baseUrl, '/admin/map-markup', document(mapCode, { [place.id]: { polygon: SQUARE } }));
    await db.query("update parking_place_maps set source_checksum = 'sha-after' where code = $1", [mapCode]);

    const read = await getJson(api.baseUrl, `/admin/map-markup?mapCode=${mapCode}`);
    assert.equal(read.payload.markup.planChanged, true);
    assert.equal(read.payload.markup.sourceChecksum, 'sha-before');
    assert.equal(read.payload.markup.mapChecksum, 'sha-after');
  });

  it('is closed to anonymous callers', async () => {
    const mapCode = await insertMap();
    const response = await fetch(`${api.baseUrl}/admin/map-markup?mapCode=${mapCode}`);
    assert.equal(response.status, 401);
  });
});
