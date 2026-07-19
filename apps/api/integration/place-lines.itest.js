'use strict';

// Integration tests for the place-inventory API (Task 9).
//
// An element is a parking line holding 1..3 slots, and adding or archiving one
// changes the real place count — so these tests do not stop at "the endpoint
// answered 201". They follow the created and archived places outward into the
// dashboard, the availability snapshot, guest allocation order and the queue,
// because that propagation is the whole point of calling this inventory
// management rather than decoration.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { addDays, createFixtures, dayRange, getJson, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

describe('place lines (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let fixtures = null;

  before(async () => {
    db = await createTestDatabase();
    fixtures = createFixtures(db);
    api = await startApi({
      databaseUrl: db.connectionString,
      env: { GUEST_RESERVE_MINIMUM: '0' }
    });
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  let codeCounter = 0;

  /** parking_places.code is unique across the whole scratch schema. */
  function nextCode(prefix) {
    codeCounter += 1;
    return `${prefix}-${String(codeCounter).padStart(3, '0')}`;
  }

  function slotsFor(capacity, prefix, overrides = {}) {
    return Array.from({ length: capacity }, (unused, index) => ({
      code: nextCode(prefix),
      title: `Место ${index + 1}`,
      ...overrides
    }));
  }

  async function createLine(capacity, prefix, { floorLabel = '4', slotOverrides = {} } = {}) {
    const slots = slotsFor(capacity, prefix, slotOverrides);
    const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
      floorLabel,
      capacity,
      slots
    });

    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(payload)}`);

    return payload.line;
  }

  /** A release row without a permanent owner — the archive blockers stay out of the way. */
  async function releasePlace(placeId, date) {
    const owner = await fixtures.insertEmployee();
    await db.query(
      `
        insert into place_releases (user_id, parking_place_id, release_during, created_via)
        values ($1, $2, $3::daterange, 'admin_web')
      `,
      [owner.id, placeId, dayRange(date)]
    );

    return owner;
  }

  describe('POST /admin/place-lines', () => {
    it('creates a single element as one line with one slot', async () => {
      const line = await createLine(1, 'S');

      assert.equal(line.capacity, 1);
      assert.equal(line.slots.length, 1);
      assert.equal(line.slots[0].placeType, 'single');
      assert.equal(line.slots[0].position, 1);
      assert.equal(line.slots[0].placeRole, 'regular');
      assert.ok(Number.isInteger(line.displayOrder), 'display_order must be assigned on creation');

      const stored = await db.query(
        'select place_type, line_position_hint, is_active, deleted_at from parking_places where line_group_id = $1',
        [line.lineId]
      );
      assert.equal(stored.rowCount, 1);
      assert.equal(stored.rows[0].is_active, true);
      assert.equal(stored.rows[0].deleted_at, null);
    });

    it('creates a triple element as three real parking places stacked front to rear', async () => {
      const line = await createLine(3, 'T');

      assert.equal(line.capacity, 3);
      assert.deepEqual(
        line.slots.map((slot) => slot.position),
        [1, 2, 3]
      );
      assert.ok(
        line.slots.every((slot) => slot.placeType === 'triple'),
        'place_type is derived from capacity, never taken from the request'
      );

      const stored = await db.query(
        'select count(*)::int as count from parking_places where line_group_id = $1 and deleted_at is null',
        [line.lineId]
      );
      assert.equal(stored.rows[0].count, 3, 'a triple element creates three real places');
    });

    it('creates a double element and keeps capacity, slot count and place_type in agreement', async () => {
      const line = await createLine(2, 'D');

      const stored = await db.query(
        `
          select lg.capacity, count(pp.id)::int as slot_count, min(pp.place_type::text) as place_type
          from line_groups lg
          join parking_places pp on pp.line_group_id = lg.id and pp.deleted_at is null
          where lg.id = $1
          group by lg.capacity
        `,
        [line.lineId]
      );

      assert.equal(stored.rows[0].capacity, 2);
      assert.equal(stored.rows[0].slot_count, 2);
      assert.equal(stored.rows[0].place_type, 'double');
    });

    it('accepts placeRole and guestPriorityRank at creation', async () => {
      const line = await createLine(1, 'GP', {
        slotOverrides: { placeRole: 'rotatable', guestPriorityRank: 3 }
      });

      assert.equal(line.slots[0].placeRole, 'rotatable');
      assert.equal(line.slots[0].guestPriorityRank, 3);

      const stored = await db.query(
        'select place_role, guest_priority_rank from parking_places where id = $1',
        [line.slots[0].placeId]
      );
      assert.equal(stored.rows[0].place_role, 'rotatable');
      assert.equal(stored.rows[0].guest_priority_rank, 3);
    });

    it('audits the creation with the codes it created', async () => {
      const line = await createLine(2, 'AUD');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'place_line_created' and entity_id = $1",
        [line.lineId]
      );

      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.capacity, 2);
      assert.deepEqual(
        audit.rows[0].metadata.slots.map((slot) => slot.code),
        line.slots.map((slot) => slot.code)
      );
    });

    it('rejects a capacity outside 1..3 with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
        floorLabel: '4',
        capacity: 4,
        slots: slotsFor(4, 'BAD')
      });

      assert.equal(status, 400);
      assert.match(payload.error, /capacity must be 1, 2 or 3/);
    });

    it('rejects a slot count that disagrees with capacity with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
        floorLabel: '4',
        capacity: 3,
        slots: slotsFor(2, 'BAD')
      });

      assert.equal(status, 400);
      assert.match(payload.error, /exactly 3 entries/);
    });

    it('rejects a missing floorLabel with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
        capacity: 1,
        slots: slotsFor(1, 'BAD')
      });

      assert.equal(status, 400);
      assert.match(payload.error, /floorLabel is required/);
    });

    it('rejects a duplicate code inside one request with 409', async () => {
      const code = nextCode('DUP');
      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
        floorLabel: '4',
        capacity: 2,
        slots: [
          { code, title: 'a' },
          { code, title: 'b' }
        ]
      });

      assert.equal(status, 409);
      assert.match(payload.error, /Duplicate place code/);
    });

    it('rejects a code that already exists and writes nothing at all', async () => {
      const existing = await createLine(1, 'EXIST');
      const linesBefore = await db.query('select count(*)::int as count from line_groups');

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
        floorLabel: '4',
        capacity: 2,
        slots: [
          { code: nextCode('NEW'), title: 'fresh' },
          { code: existing.slots[0].code, title: 'collision' }
        ]
      });

      assert.equal(status, 409);
      assert.match(payload.error, /already exists/);

      const linesAfter = await db.query('select count(*)::int as count from line_groups');
      assert.equal(
        linesAfter.rows[0].count,
        linesBefore.rows[0].count,
        'a refused creation must not leave a half-built line behind'
      );
    });
  });

  describe('GET /admin/place-lines', () => {
    it('returns elements ordered by display_order with slots front to rear', async () => {
      const { payload } = await getJson(api.baseUrl, '/admin/place-lines');

      assert.equal(payload.status, 'ok');
      assert.ok(payload.lines.length > 0);

      const orders = payload.lines.map((line) => line.displayOrder);
      assert.deepEqual(orders, [...orders].sort((a, b) => a - b), 'lines must come back in display_order');

      for (const line of payload.lines) {
        assert.equal(line.slots.length, line.capacity, `line ${line.code} must expose capacity slots`);
        assert.deepEqual(
          line.slots.map((slot) => slot.position),
          line.slots.map((unused, index) => index + 1),
          'slots are stacked front (1) to rear'
        );
      }
    });

    it('filters by floor', async () => {
      const line = await createLine(1, 'FLOOR', { floorLabel: '9' });

      const { payload } = await getJson(api.baseUrl, '/admin/place-lines?floor=9');

      assert.deepEqual(
        payload.lines.map((item) => item.lineId),
        [line.lineId]
      );
      assert.equal(payload.floor, '9');
    });

    it('derives slot status with the map-legend precedence', async () => {
      const date = '2027-05-04';

      const plain = await createLine(1, 'ST-FREE');
      const rotatable = await createLine(1, 'ST-ROT', {
        slotOverrides: { placeRole: 'rotatable' }
      });
      const blocked = await createLine(1, 'ST-BLK', {
        slotOverrides: { placeRole: 'blocked' }
      });
      const released = await createLine(1, 'ST-REL');
      const occupied = await createLine(1, 'ST-OCC');

      await releasePlace(released.slots[0].placeId, date);
      const owner = await releasePlace(occupied.slots[0].placeId, date);
      const driver = await fixtures.insertEmployee();
      const assignment = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: driver.id,
        parkingPlaceId: occupied.slots[0].placeId,
        reservationDate: date
      });
      assert.equal(assignment.status, 201, JSON.stringify(assignment.payload));
      assert.ok(owner.id);

      const { payload } = await getJson(api.baseUrl, `/admin/place-lines?date=${date}`);
      const statusByLineId = new Map(payload.lines.map((line) => [line.lineId, line.slots[0]]));

      assert.equal(statusByLineId.get(plain.lineId).status, 'free');
      assert.equal(statusByLineId.get(rotatable.lineId).status, 'rotatable');
      assert.equal(statusByLineId.get(blocked.lineId).status, 'blocked');
      assert.equal(statusByLineId.get(released.lineId).status, 'released');
      assert.equal(statusByLineId.get(occupied.lineId).status, 'occupied');
      assert.equal(statusByLineId.get(occupied.lineId).userDisplayName, driver.display_name);
    });

    it('reports a guest reservation as guest, not occupied', async () => {
      const date = '2027-05-05';
      const line = await createLine(1, 'ST-GUEST');
      await releasePlace(line.slots[0].placeId, date);
      const host = await fixtures.insertEmployee();

      const request = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: date,
        guestName: 'Гостев Гость'
      });
      assert.equal(request.status, 201, JSON.stringify(request.payload));

      const { payload } = await getJson(api.baseUrl, `/admin/place-lines?date=${date}`);
      const slot = payload.lines.find((item) => item.lineId === line.lineId).slots[0];

      assert.equal(slot.status, 'guest');
    });

    it('rejects a malformed date with 400', async () => {
      const { status, payload } = await getJson(api.baseUrl, '/admin/place-lines?date=04.05.2027');

      assert.equal(status, 400);
      assert.match(payload.error, /YYYY-MM-DD/);
    });
  });

  describe('created places propagate through the system', () => {
    it('shows up in the dashboard and the availability snapshot once released', async () => {
      const date = '2027-06-01';
      const line = await createLine(3, 'PROP');

      const before = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(before.payload.availability.byType.triple, 0);

      for (const slot of line.slots) {
        await releasePlace(slot.placeId, date);
      }

      const availability = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(availability.payload.availability.byType.triple, 3);
      assert.equal(availability.payload.availability.releasedPlaces, 3);

      const dashboard = await getJson(api.baseUrl, `/admin/dashboard?date=${date}`);
      const codes = dashboard.payload.releasedPlaces.map((place) => place.parkingPlace.code);
      assert.deepEqual(
        line.slots.map((slot) => slot.code).filter((code) => codes.includes(code)),
        line.slots.map((slot) => slot.code),
        'every slot of the new element must reach the dashboard'
      );
    });

    it('puts a rotatable place created with a guest rank into guest allocation order', async () => {
      const date = '2027-06-02';
      // Created in the order that does NOT match the expected pick, so a pass is
      // about guest_priority_rank and not about insertion order.
      const lowPriority = await createLine(1, 'GR-LOW', {
        slotOverrides: { placeRole: 'rotatable', guestPriorityRank: 5 }
      });
      const highPriority = await createLine(1, 'GR-HIGH', {
        slotOverrides: { placeRole: 'rotatable', guestPriorityRank: 1 }
      });

      await releasePlace(lowPriority.slots[0].placeId, date);
      await releasePlace(highPriority.slots[0].placeId, date);

      const host = await fixtures.insertEmployee();
      const { status, payload } = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: date,
        guestName: 'Гостев Приоритетный'
      });

      assert.equal(status, 201, JSON.stringify(payload));
      assert.equal(
        payload.request.assignedReservation.parkingPlace.code,
        highPriority.slots[0].code,
        'a place created with guestPriorityRank must sort ahead of a higher rank'
      );
    });
  });

  describe('POST /admin/place-lines/archive', () => {
    it('archives every slot of the element and marks the line archived', async () => {
      const line = await createLine(2, 'ARCH');

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines/archive', {
        lineId: line.lineId
      });

      assert.equal(status, 200, JSON.stringify(payload));
      assert.deepEqual(
        payload.archivedPlaces.map((place) => place.code).sort(),
        line.slots.map((slot) => slot.code).sort()
      );

      const places = await db.query(
        'select is_active, deleted_at from parking_places where line_group_id = $1',
        [line.lineId]
      );
      assert.ok(places.rows.every((row) => row.is_active === false && row.deleted_at !== null));

      const group = await db.query('select archived_at from line_groups where id = $1', [line.lineId]);
      assert.ok(group.rows[0].archived_at, 'the line itself must be marked archived');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'place_line_archived' and entity_id = $1",
        [line.lineId]
      );
      assert.equal(audit.rowCount, 1);
      assert.deepEqual(audit.rows[0].metadata.archivedPlaceCodes.sort(), line.slots.map((slot) => slot.code).sort());
    });

    it('refuses with 409 and names the blocking reservation', async () => {
      const date = addDays(new Date().toISOString().slice(0, 10), 3);
      const line = await createLine(1, 'BLK-RES');
      await releasePlace(line.slots[0].placeId, date);
      const driver = await fixtures.insertEmployee();

      const assignment = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: driver.id,
        parkingPlaceId: line.slots[0].placeId,
        reservationDate: date
      });
      assert.equal(assignment.status, 201, JSON.stringify(assignment.payload));

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines/archive', {
        lineId: line.lineId
      });

      assert.equal(status, 409);
      assert.equal(payload.blockers.length, 1);
      assert.equal(payload.blockers[0].type, 'reservation');
      assert.equal(payload.blockers[0].placeCode, line.slots[0].code);
      assert.equal(payload.blockers[0].userDisplayName, driver.display_name);

      const places = await db.query(
        'select is_active from parking_places where line_group_id = $1',
        [line.lineId]
      );
      assert.ok(places.rows.every((row) => row.is_active === true), 'a refused archive changes nothing');
    });

    it('refuses with 409 and names the blocking permanent assignment, then succeeds once it is cleared', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const line = await createLine(1, 'BLK-PERM');
      const owner = await fixtures.insertEmployee();
      const assignment = await fixtures.insertPermanentAssignment({
        userId: owner.id,
        parkingPlaceId: line.slots[0].placeId,
        dateFrom: addDays(today, -60),
        dateTo: addDays(today, 60)
      });

      const refused = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: line.lineId });

      assert.equal(refused.status, 409);
      assert.equal(refused.payload.blockers[0].type, 'permanent_assignment');
      assert.equal(refused.payload.blockers[0].placeCode, line.slots[0].code);
      assert.equal(refused.payload.blockers[0].userDisplayName, owner.display_name);

      // Ending it *today* is not enough — the owner still holds the place today.
      const ended = await postJson(api.baseUrl, '/admin/permanent-assignments/end', {
        assignmentId: assignment.id,
        dateTo: addDays(today, -1)
      });
      assert.equal(ended.status, 200, JSON.stringify(ended.payload));

      const accepted = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: line.lineId });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.payload));
    });

    it('ignores a reservation that is already in the past', async () => {
      const line = await createLine(1, 'OLD-RES');
      const driver = await fixtures.insertEmployee();
      await db.query(
        `
          insert into reservations (reservation_date, parking_place_id, user_id, source, status)
          values (current_date - 10, $1, $2, 'manual', 'active')
        `,
        [line.slots[0].placeId, driver.id]
      );

      const { status } = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: line.lineId });

      assert.equal(status, 200, 'yesterday cannot be stranded — only today and later block an archive');
    });

    it('drops the archived element out of the list, availability and the queue, but keeps its history', async () => {
      const date = '2027-07-01';
      const line = await createLine(1, 'GONE');
      await releasePlace(line.slots[0].placeId, date);

      const before = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(before.payload.availability.availablePlaces, 1);

      const archived = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: line.lineId });
      assert.equal(archived.status, 200, JSON.stringify(archived.payload));

      const after = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(after.payload.availability.availablePlaces, 0, 'an archived place is not available');
      assert.equal(after.payload.availability.guestReserve.availablePlaces, 0, 'nor does it pad the guest reserve');

      const list = await getJson(api.baseUrl, `/admin/place-lines?date=${date}`);
      assert.ok(
        !list.payload.lines.some((item) => item.lineId === line.lineId),
        'an archived element is gone from the inventory list'
      );

      const employee = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });
      const queue = await postJson(api.baseUrl, '/admin/jobs/process-queue', { date });
      assert.equal(queue.payload.assignedCount, 0, 'the queue cannot hand out an archived place');

      // The place stays readable — reservations, releases and audit history are the
      // reason archiving exists instead of a delete.
      const history = await getJson(api.baseUrl, `/admin/places/${line.slots[0].placeId}/history`);
      assert.equal(history.status, 200);
      assert.equal(history.payload.place.code, line.slots[0].code);
      assert.equal(history.payload.place.isActive, false);
    });

    it('answers 404 for an unknown or already archived line', async () => {
      const line = await createLine(1, 'TWICE');
      const first = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: line.lineId });
      assert.equal(first.status, 200);

      const second = await postJson(api.baseUrl, '/admin/place-lines/archive', { lineId: line.lineId });
      assert.equal(second.status, 404);
    });

    it('rejects a missing lineId with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines/archive', {});

      assert.equal(status, 400);
      assert.match(payload.error, /lineId is required/);
    });
  });

  describe('is_active has exactly one write path', () => {
    it('ignores isActive on /admin/places/update', async () => {
      const line = await createLine(1, 'ACT');
      const place = line.slots[0];

      const { status } = await postJson(api.baseUrl, '/admin/places/update', {
        placeId: place.placeId,
        code: place.code,
        title: place.title,
        placeType: 'single',
        isActive: false
      });

      assert.equal(status, 200);

      const stored = await db.query('select is_active from parking_places where id = $1', [place.placeId]);
      assert.equal(
        stored.rows[0].is_active,
        true,
        'only /admin/place-lines/archive may deactivate a place'
      );
    });

    it('no longer exposes /admin/places/disable', async () => {
      const { status } = await postJson(api.baseUrl, '/admin/places/disable', { placeId: null });

      assert.equal(status, 404);
    });

    it('updates place_role through /admin/places/update', async () => {
      const line = await createLine(1, 'ROLE');
      const place = line.slots[0];

      const { status } = await postJson(api.baseUrl, '/admin/places/update', {
        placeId: place.placeId,
        code: place.code,
        title: place.title,
        placeType: 'single',
        placeRole: 'blocked'
      });

      assert.equal(status, 200);

      const stored = await db.query('select place_role from parking_places where id = $1', [place.placeId]);
      assert.equal(stored.rows[0].place_role, 'blocked');
    });
  });

  describe('GET /admin/map-diagnostics', () => {
    it('reports lines whose slot count disagrees with their capacity', async () => {
      const group = await fixtures.insertLineGroup({ capacity: 3, floorLabel: '7' });
      await fixtures.insertPlace({ lineGroupId: group.id, floorLabel: '7', linePositionHint: 1 });

      const { status, payload } = await getJson(api.baseUrl, '/admin/map-diagnostics');

      assert.equal(status, 200);
      assert.deepEqual(payload.diagnostics.placeWithoutLine, [], 'every place belongs to a line');

      const mismatch = payload.diagnostics.lineCapacityMismatch.find((item) => item.lineId === group.id);
      assert.ok(mismatch, 'a capacity-3 line holding one slot must be reported');
      assert.equal(mismatch.capacity, 3);
      assert.equal(mismatch.slotCount, 1);
    });
  });
});
