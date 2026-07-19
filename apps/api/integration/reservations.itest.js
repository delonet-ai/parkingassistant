'use strict';

// Characterization tests for the assignment flows: manual employee assignment,
// guest assignment, the per-place/date concurrency guard, and the `warnings`
// payload that both flows compute and audit-log.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createFixtures, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

const DATE = '2026-09-14';

describe('reservations (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let fixtures = null;

  before(async () => {
    db = await createTestDatabase();
    fixtures = createFixtures(db);
    // guestReserveMinimum is read once at module load, so it has to be set on
    // the child process. 0 keeps the reserve out of the way of these cases;
    // the reserve itself is pinned by its own test below.
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

  describe('manual employee assignment', () => {
    it('assigns an employee to a released place and audit-logs it', async () => {
      const { place } = await fixtures.insertReleasedPlace({ date: DATE });
      // A second released place keeps availableReleasedPlaces above the reserve
      // after the first one is taken.
      await fixtures.insertReleasedPlace({ date: DATE });
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: DATE,
        reason: 'Covering for a colleague'
      });

      assert.equal(status, 201);
      assert.equal(payload.status, 'ok');
      assert.equal(payload.reservation.source, 'manual');
      assert.equal(payload.reservation.status, 'active');
      assert.equal(payload.reservation.user.id, employee.id);
      assert.equal(payload.reservation.parkingPlace.code, place.code);
      assert.deepEqual(payload.warnings, []);

      const reservations = await db.query(
        "select source, status, reason from reservations where parking_place_id = $1 and reservation_date = $2::date and status = 'active'",
        [place.id, DATE]
      );
      assert.equal(reservations.rowCount, 1);
      assert.equal(reservations.rows[0].reason, 'Covering for a colleague');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'manual_reservation_created' and entity_id = $1",
        [payload.reservation.id]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.userId, employee.id);
      assert.equal(audit.rows[0].metadata.parkingPlaceCode, place.code);

      // The flow also records a movement and a reservation event.
      const movements = await db.query(
        "select movement_type from parking_movements where reservation_id = $1",
        [payload.reservation.id]
      );
      assert.equal(movements.rows[0].movement_type, 'manual_reassign');

      const events = await db.query(
        'select event_type, source from reservation_events where reservation_id = $1',
        [payload.reservation.id]
      );
      assert.equal(events.rows[0].event_type, 'reservation_created');
      assert.equal(events.rows[0].source, 'manual');
    });

    it('rejects a second assignment to the same place and date (concurrency guard)', async () => {
      const { place } = await fixtures.insertReleasedPlace({ date: DATE });
      await fixtures.insertReleasedPlace({ date: DATE });
      await fixtures.insertReleasedPlace({ date: DATE });
      const first = await fixtures.insertEmployee();
      const second = await fixtures.insertEmployee();

      const initial = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: first.id,
        parkingPlaceId: place.id,
        reservationDate: DATE
      });
      assert.equal(initial.status, 201);

      const duplicate = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: second.id,
        parkingPlaceId: place.id,
        reservationDate: DATE
      });

      assert.equal(duplicate.status, 409);
      assert.equal(duplicate.payload.status, 'error');
      assert.match(duplicate.payload.error, /already has an active reservation/i);

      // The guard is the partial unique index, so exactly one active
      // reservation survives — the rollback left nothing behind.
      const active = await db.query(
        "select count(*)::int as count from reservations where parking_place_id = $1 and reservation_date = $2::date and status = 'active'",
        [place.id, DATE]
      );
      assert.equal(active.rows[0].count, 1);
    });

    it('refuses a place that is not released for the date', async () => {
      const place = await fixtures.insertPlace();
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: DATE
      });

      assert.equal(status, 409);
      assert.match(payload.error, /only for places released for the selected date/i);
    });

    it('refuses to assign the released place back to its own owner', async () => {
      const { owner, place } = await fixtures.insertReleasedPlace({ date: DATE });
      await fixtures.insertReleasedPlace({ date: DATE });

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: owner.id,
        parkingPlaceId: place.id,
        reservationDate: DATE
      });

      assert.equal(status, 409);
      assert.match(payload.error, /owner cannot be manually assigned/i);
    });

    it('rejects a body missing required fields with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: null,
        parkingPlaceId: null,
        reservationDate: '14.09.2026'
      });

      assert.equal(status, 400);
      assert.match(payload.error, /YYYY-MM-DD/);
    });
  });

  describe('guest assignment', () => {
    it('creates the guest, the request and the reservation in one call', async () => {
      const date = '2026-09-15';
      const { place } = await fixtures.insertReleasedPlace({ date });
      const host = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: date,
        guestName: 'Гостев Гость',
        guestPhone: '+79001234567',
        vehiclePlateNumber: 'А123ВС777'
      });

      assert.equal(status, 201);
      assert.equal(payload.request.status, 'assigned');
      assert.equal(payload.request.host.id, host.id);
      assert.equal(payload.request.assignedReservation.source, 'guest');
      assert.equal(payload.request.assignedReservation.parkingPlace.code, place.code);
      assert.deepEqual(payload.warnings, []);

      const guest = await db.query("select kind, display_name from users where id = $1", [
        payload.request.guest.id
      ]);
      assert.equal(guest.rows[0].kind, 'guest');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'guest_parking_request_created_and_assigned' and entity_id = $1",
        [payload.request.id]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.parkingPlaceCode, place.code);
    });

    it('returns 409 when no released place is free for the date', async () => {
      const host = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: '2026-09-16',
        guestName: 'Гостев Гость'
      });

      assert.equal(status, 409);
      assert.match(payload.error, /No released parking place is available/i);
    });

    it('picks single before double before triple, then by guest priority rank', async () => {
      const date = '2026-09-17';
      // Insert in an order that does NOT match the expected pick order, so a
      // passing assertion really is about the ORDER BY and not insertion order.
      await fixtures.insertReleasedPlace({ date, place: { placeType: 'triple' } });
      const expected = await fixtures.insertReleasedPlace({
        date,
        place: { placeType: 'single', guestPriorityRank: 1 }
      });
      await fixtures.insertReleasedPlace({
        date,
        place: { placeType: 'single', guestPriorityRank: 5 }
      });
      const host = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: date,
        guestName: 'Приоритетный Гость'
      });

      assert.equal(status, 201);
      assert.equal(
        payload.request.assignedReservation.parkingPlace.code,
        expected.place.code,
        'guest allocation must prefer single places ordered by guest_priority_rank'
      );
    });

    it('rejects a request without a host or a valid date with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: null,
        requestDate: '2026-09-18',
        guestName: 'Гостев'
      });

      assert.equal(status, 400);
      assert.match(payload.error, /hostUserId, guestName and requestDate are required/);
    });
  });

  describe('assignment warnings', () => {
    it('warns about an early departure the assignment would block, and audits it', async () => {
      const date = '2026-09-20';
      const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });

      // The place being assigned sits at the front of the line (position 1).
      const { place: frontPlace } = await fixtures.insertReleasedPlace({
        date,
        place: { placeType: 'double', lineGroupId: lineGroup.id, linePositionHint: 1 }
      });
      await fixtures.insertReleasedPlace({ date });

      // Someone parked deeper in the same line (position 2) plans to leave early,
      // so parking in front of them is a warning — not a rejection.
      const blocked = await fixtures.insertEmployee({ displayName: 'Раннева Ранняя' });
      const rearPlace = await fixtures.insertPlace({
        lineGroupId: lineGroup.id,
        linePositionHint: 2
      });
      await fixtures.insertLineOccupancy({
        date,
        lineGroupId: lineGroup.id,
        parkingPlaceId: rearPlace.id,
        position: 2,
        userId: blocked.id
      });
      await fixtures.insertDeparturePlan({
        userId: blocked.id,
        date,
        departureTime: '16:30',
        isEarly: true
      });

      const employee = await fixtures.insertEmployee();
      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: frontPlace.id,
        reservationDate: date
      });

      assert.equal(status, 201);
      assert.equal(payload.warnings.length, 1);

      const warning = payload.warnings[0];
      assert.equal(warning.type, 'early_departure_blocking_risk');
      assert.equal(warning.affectedUser.id, blocked.id);
      assert.equal(warning.affectedPosition, 2);
      assert.equal(warning.departureTime, '16:30');
      assert.equal(warning.assignedParkingPlaceCode, frontPlace.code);
      assert.equal(warning.lineGroupCode, lineGroup.code);

      // The warning is not just returned — it is persisted in the audit trail.
      const audit = await db.query(
        "select metadata from audit_logs where action = 'manual_reservation_created' and entity_id = $1",
        [payload.reservation.id]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.warnings.length, 1);
      assert.equal(
        audit.rows[0].metadata.warnings[0].type,
        'early_departure_blocking_risk'
      );
    });

    it('does not warn when the blocked employee is parked ahead, not behind', async () => {
      const date = '2026-09-21';
      const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });

      // This time the assigned place is at the REAR (position 2); the early
      // departure is in front of it and therefore cannot be blocked by it.
      const { place: rearPlace } = await fixtures.insertReleasedPlace({
        date,
        place: { placeType: 'double', lineGroupId: lineGroup.id, linePositionHint: 2 }
      });
      await fixtures.insertReleasedPlace({ date });

      const other = await fixtures.insertEmployee();
      const frontPlace = await fixtures.insertPlace({
        lineGroupId: lineGroup.id,
        linePositionHint: 1
      });
      await fixtures.insertLineOccupancy({
        date,
        lineGroupId: lineGroup.id,
        parkingPlaceId: frontPlace.id,
        position: 1,
        userId: other.id
      });
      await fixtures.insertDeparturePlan({
        userId: other.id,
        date,
        departureTime: '16:30',
        isEarly: true
      });

      const employee = await fixtures.insertEmployee();
      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: rearPlace.id,
        reservationDate: date
      });

      assert.equal(status, 201);
      assert.deepEqual(payload.warnings, []);
    });
  });

  describe('guest reserve', () => {
    it('refuses a manual assignment that would eat into the guest reserve', async () => {
      const date = '2026-09-22';
      const reserved = await startApi({
        databaseUrl: db.connectionString,
        env: { GUEST_RESERVE_MINIMUM: '2' }
      });

      try {
        // Two released places, minimum 2 → the count is not ABOVE the minimum,
        // so the assignment is refused before any reservation is written.
        const { place } = await fixtures.insertReleasedPlace({ date });
        await fixtures.insertReleasedPlace({ date });
        const employee = await fixtures.insertEmployee();

        const { status, payload } = await postJson(reserved.baseUrl, '/admin/reservations/manual', {
          userId: employee.id,
          parkingPlaceId: place.id,
          reservationDate: date
        });

        assert.equal(status, 409);
        assert.match(payload.error, /guest reserve below 2 places/i);
        assert.equal(payload.guestReserve.minimum, 2);
        assert.equal(payload.guestReserve.availablePlaces, 2);

        const written = await db.query(
          "select count(*)::int as count from reservations where reservation_date = $1::date",
          [date]
        );
        assert.equal(written.rows[0].count, 0);
      } finally {
        await reserved.stop();
      }
    });
  });
});
