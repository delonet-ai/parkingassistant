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

    // The uuid shape accepts either case and Postgres compares uuids by value, so an uppercase
    // id finds the same rows — but the guard above is a JS string comparison against the
    // lowercase id Postgres returned. An uppercase `userId` used to skip it and hand the
    // employee back the very place they had just released.
    it('refuses the owner written in uppercase for the same reason', async () => {
      const { owner, place } = await fixtures.insertReleasedPlace({ date: DATE });
      await fixtures.insertReleasedPlace({ date: DATE });

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: owner.id.toUpperCase(),
        parkingPlaceId: place.id,
        reservationDate: DATE
      });

      assert.equal(status, 409);
      assert.match(payload.error, /owner cannot be manually assigned/i);

      const created = await db.query(
        "select count(*)::int as count from reservations where parking_place_id = $1 and reservation_date = $2::date and status = 'active'",
        [place.id, DATE]
      );
      assert.equal(created.rows[0].count, 0);
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

  describe('moving a reservation', () => {
    // A manual reservation on a fresh released place, plus a second released place to
    // move it to. Each case uses its own date so the pools never meet.
    async function reservationToMove(date, targetPlace = {}) {
      const { place: fromPlace } = await fixtures.insertReleasedPlace({ date });
      const { place: toPlace } = await fixtures.insertReleasedPlace({ date, place: targetPlace });
      await fixtures.insertReleasedPlace({ date });
      const employee = await fixtures.insertEmployee({ displayName: 'Переводов Пётр' });

      const created = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: fromPlace.id,
        reservationDate: date
      });
      assert.equal(created.status, 201);

      return { employee, fromPlace, toPlace, reservationId: created.payload.reservation.id };
    }

    async function placeOf(reservationId) {
      const result = await db.query('select parking_place_id, status from reservations where id = $1', [reservationId]);
      return result.rows[0];
    }

    async function movementsOf(reservationId) {
      const result = await db.query(
        'select from_parking_place_id, to_parking_place_id, movement_type, reason from parking_movements where reservation_id = $1 order by created_at',
        [reservationId]
      );
      return result.rows;
    }

    it('moves the reservation in place and records exactly one movement', async () => {
      const date = '2026-10-01';
      const { fromPlace, toPlace, reservationId } = await reservationToMove(date);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id,
        reason: 'Owner came back early'
      });

      assert.equal(status, 200);
      assert.equal(payload.reservation.id, reservationId);
      assert.equal(payload.reservation.status, 'active');
      assert.equal(payload.reservation.fromParkingPlace.code, fromPlace.code);
      assert.equal(payload.reservation.parkingPlace.code, toPlace.code);
      assert.deepEqual(payload.warnings, []);

      // Same row, new place — not a cancel plus a fresh booking.
      const row = await placeOf(reservationId);
      assert.equal(row.parking_place_id, toPlace.id);
      assert.equal(row.status, 'active');

      const onDate = await db.query('select count(*)::int as count from reservations where reservation_date = $1::date', [date]);
      assert.equal(onDate.rows[0].count, 1);

      // The assignment wrote the first movement; the move adds exactly one more, with both ends.
      const movements = await movementsOf(reservationId);
      assert.equal(movements.length, 2);
      assert.deepEqual(movements[1], {
        from_parking_place_id: fromPlace.id,
        to_parking_place_id: toPlace.id,
        movement_type: 'manual_reassign',
        reason: 'Owner came back early'
      });

      const audit = await db.query(
        "select metadata, actor_auth_user_id from audit_logs where action = 'reservation_moved' and entity_id = $1",
        [reservationId]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.fromParkingPlaceCode, fromPlace.code);
      assert.equal(audit.rows[0].metadata.toParkingPlaceCode, toPlace.code);
      assert.ok(audit.rows[0].actor_auth_user_id, 'the move names the operator');

      const events = await db.query(
        "select count(*)::int as count from reservation_events where reservation_id = $1 and event_type = 'reservation_moved'",
        [reservationId]
      );
      assert.equal(events.rows[0].count, 1);
    });

    it('clears the line position reported at the old place', async () => {
      const date = '2026-10-02';
      const { employee, fromPlace, toPlace, reservationId } = await reservationToMove(date);
      await db.query(
        `insert into line_occupancy (occupancy_date, line_group_id, parking_place_id, position, subject_type, user_id, reservation_id)
         values ($1::date, $2, $3, 1, 'employee', $4, $5)`,
        [date, fromPlace.line_group_id, fromPlace.id, employee.id, reservationId]
      );

      const { status } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id
      });

      assert.equal(status, 200);
      const left = await db.query(
        'select count(*)::int as count from line_occupancy where occupancy_date = $1::date and user_id = $2',
        [date, employee.id]
      );
      assert.equal(left.rows[0].count, 0);
    });

    // The row the move has to find is not always the one that names it. `setLineOccupancy`
    // links an occupancy row to the reservation standing on the *reported* place, so an
    // employee who holds 101 and reports standing in a rear slot leaves a row with another
    // place and no reservation id at all. A clearing keyed on the reservation link would miss
    // it, and `(occupancy_date, parking_place_id)` would keep that slot locked all day.
    it('clears a position reported at a place other than the reservation’s own', async () => {
      const date = '2026-10-09';
      const { employee, toPlace, reservationId } = await reservationToMove(date);
      const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });
      const rearPlace = await fixtures.insertPlace({ lineGroupId: lineGroup.id, linePositionHint: 2 });

      await fixtures.insertLineOccupancy({
        date,
        lineGroupId: lineGroup.id,
        parkingPlaceId: rearPlace.id,
        position: 2,
        userId: employee.id
      });

      const planted = await db.query(
        'select reservation_id from line_occupancy where occupancy_date = $1::date and user_id = $2',
        [date, employee.id]
      );
      assert.equal(planted.rows.length, 1);
      assert.equal(planted.rows[0].reservation_id, null, 'the precondition is a row with no reservation link');

      const { status } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id
      });

      assert.equal(status, 200);
      const left = await db.query(
        'select count(*)::int as count from line_occupancy where occupancy_date = $1::date and user_id = $2',
        [date, employee.id]
      );
      assert.equal(left.rows[0].count, 0, 'the vacated slot must not stay occupied by someone who left');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'reservation_moved' and entity_id = $1",
        [reservationId]
      );
      assert.equal(audit.rows[0].metadata.clearedOccupancyCount, 1);
    });

    // Every refusal must leave the reservation where it was and add no movement.
    async function assertNothingMoved(reservationId, fromPlace) {
      const row = await placeOf(reservationId);
      assert.equal(row.parking_place_id, fromPlace.id);
      assert.equal(row.status, 'active');
      assert.equal((await movementsOf(reservationId)).length, 1);

      const audit = await db.query(
        "select count(*)::int as count from audit_logs where action = 'reservation_moved' and entity_id = $1",
        [reservationId]
      );
      assert.equal(audit.rows[0].count, 0);
    }

    it('refuses a target already taken on that date, naming who holds it', async () => {
      const date = '2026-10-03';
      const { fromPlace, toPlace, reservationId } = await reservationToMove(date);
      const holder = await fixtures.insertEmployee({ displayName: 'Занятов Захар' });
      const taken = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: holder.id,
        parkingPlaceId: toPlace.id,
        reservationDate: date
      });
      assert.equal(taken.status, 201);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, /already taken/);
      assert.match(payload.error, /Занятов Захар/);
      assert.equal(payload.blocker.type, 'reservation');
      assert.equal(payload.blocker.holderName, 'Занятов Захар');
      await assertNothingMoved(reservationId, fromPlace);
    });

    it('refuses an archived target', async () => {
      const date = '2026-10-04';
      const { fromPlace, toPlace, reservationId } = await reservationToMove(date);
      await db.query('update parking_places set is_active = false, deleted_at = now() where id = $1', [toPlace.id]);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, new RegExp(`${toPlace.code} is archived`));
      assert.equal(payload.blocker.type, 'archived');
      await assertNothingMoved(reservationId, fromPlace);
    });

    it('refuses a blocked target', async () => {
      const date = '2026-10-05';
      const { fromPlace, toPlace, reservationId } = await reservationToMove(date, { placeRole: 'blocked' });

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, new RegExp(`${toPlace.code} is blocked`));
      assert.equal(payload.blocker.type, 'blocked');
      await assertNothingMoved(reservationId, fromPlace);
    });

    it('refuses a target that is not released for the date', async () => {
      const date = '2026-10-06';
      const { fromPlace, reservationId } = await reservationToMove(date);
      const unreleased = await fixtures.insertPlace();

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: unreleased.id
      });

      assert.equal(status, 409);
      assert.equal(payload.blocker.type, 'not_released');
      await assertNothingMoved(reservationId, fromPlace);
    });

    it('refuses a reservation that is no longer active', async () => {
      const date = '2026-10-10';
      const { fromPlace, toPlace, reservationId } = await reservationToMove(date);

      const canceled = await postJson(api.baseUrl, '/admin/reservations/cancel', { reservationId });
      assert.equal(canceled.status, 200);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: toPlace.id
      });

      // 409, not the 500 the repository's `and status = 'active'` would produce if the guard
      // went away: the update would match no row and the controller would read `id` off it.
      assert.equal(status, 409);
      assert.match(payload.error, /Only active reservations can be moved/);

      const row = await placeOf(reservationId);
      assert.equal(row.parking_place_id, fromPlace.id);
      assert.equal(row.status, 'canceled');
      assert.equal((await movementsOf(reservationId)).length, 1);
    });

    it('refuses a move to the place the reservation already stands on', async () => {
      const date = '2026-10-11';
      const { fromPlace, reservationId } = await reservationToMove(date);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: fromPlace.id
      });

      // Without this guard the row would violate parking_movements' own
      // `from_parking_place_id <> to_parking_place_id` check and answer 500.
      assert.equal(status, 409);
      assert.match(payload.error, new RegExp(`already on place ${fromPlace.code}`));
      await assertNothingMoved(reservationId, fromPlace);
    });

    // The uuid shape accepts either case and Postgres compares uuids by value, but the guard
    // above is a JS string comparison against the lowercase id Postgres returned. An uppercase
    // id used to slip past it and be refused as "taken by" the reservation's own holder.
    it('refuses the same place written in uppercase for the same reason', async () => {
      const date = '2026-10-19';
      const { fromPlace, reservationId } = await reservationToMove(date);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: fromPlace.id.toUpperCase()
      });

      assert.equal(status, 409);
      assert.match(payload.error, new RegExp(`already on place ${fromPlace.code}`));
      await assertNothingMoved(reservationId, fromPlace);
    });

    it('refuses a target place that does not exist', async () => {
      const date = '2026-10-12';
      const { fromPlace, reservationId } = await reservationToMove(date);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: '00000000-0000-4000-8000-00000000beef'
      });

      assert.equal(status, 404);
      assert.match(payload.error, /Target parking place not found/);
      await assertNothingMoved(reservationId, fromPlace);
    });

    // The parking rule inside the move: the owner of a released place must not be put back
    // onto the place they gave away for the day. Nothing else in the suite covers it.
    it('refuses moving the release owner onto their own released place', async () => {
      const date = '2026-10-13';
      const { place: ownPlace, owner } = await fixtures.insertReleasedPlace({ date });
      const { place: otherPlace } = await fixtures.insertReleasedPlace({ date });
      await fixtures.insertReleasedPlace({ date });

      // The owner of `ownPlace` is holding someone else's released place for the day.
      const created = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: owner.id,
        parkingPlaceId: otherPlace.id,
        reservationDate: date
      });
      assert.equal(created.status, 201, JSON.stringify(created.payload));
      const reservationId = created.payload.reservation.id;

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId,
        toParkingPlaceId: ownPlace.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, /owner cannot be moved onto the same released place/);
      await assertNothingMoved(reservationId, otherPlace);
    });

    it('refuses an unknown reservation and a malformed body', async () => {
      const { toPlace } = await reservationToMove('2026-10-07');

      const unknown = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId: '00000000-0000-4000-8000-000000000000',
        toParkingPlaceId: toPlace.id
      });
      assert.equal(unknown.status, 404);

      const missing = await postJson(api.baseUrl, '/admin/reservations/move', { reservationId: toPlace.id });
      assert.equal(missing.status, 400);
    });

    it('warns when a guest is moved in front of an early departure, as placing one does', async () => {
      const date = '2026-10-08';
      const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });

      // The guest lands on the only released place, then a front-of-line place opens up.
      const { place: guestPlace } = await fixtures.insertReleasedPlace({ date, place: { placeType: 'single' } });
      const host = await fixtures.insertEmployee();
      const guest = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: date,
        guestName: 'Гостев Переезд',
        guestPhone: '+79001234568',
        vehiclePlateNumber: 'В456ОР777'
      });
      assert.equal(guest.status, 201);
      assert.equal(guest.payload.request.assignedReservation.parkingPlace.code, guestPlace.code);

      const { place: frontPlace } = await fixtures.insertReleasedPlace({
        date,
        place: { placeType: 'double', lineGroupId: lineGroup.id, linePositionHint: 1 }
      });
      const blocked = await fixtures.insertEmployee({ displayName: 'Раннева Ранняя' });
      const rearPlace = await fixtures.insertPlace({ lineGroupId: lineGroup.id, linePositionHint: 2 });
      await fixtures.insertLineOccupancy({
        date,
        lineGroupId: lineGroup.id,
        parkingPlaceId: rearPlace.id,
        position: 2,
        userId: blocked.id
      });
      await fixtures.insertDeparturePlan({ userId: blocked.id, date, departureTime: '16:30', isEarly: true });

      const reservation = await db.query(
        "select id from reservations where guest_parking_request_id = $1 and status = 'active'",
        [guest.payload.request.id]
      );

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/move', {
        reservationId: reservation.rows[0].id,
        toParkingPlaceId: frontPlace.id
      });

      assert.equal(status, 200);
      assert.equal(payload.warnings.length, 1);
      assert.equal(payload.warnings[0].type, 'early_departure_blocking_risk');
      assert.equal(payload.warnings[0].affectedUser.id, blocked.id);
      assert.equal(payload.warnings[0].assignedParkingPlaceCode, frontPlace.code);

      const audit = await db.query(
        "select metadata from audit_logs where action = 'reservation_moved' and entity_id = $1",
        [reservation.rows[0].id]
      );
      assert.equal(audit.rows[0].metadata.warnings.length, 1);
    });
  });
});
