'use strict';

// Integration tests for place releases, reservation cancellation and the freeze
// job.
//
// NOTE ON THE CUT-OFF RULES
// -------------------------
// These started as Task 3 characterization tests pinning three gaps. All three
// are now closed and the assertions are inverted in place:
//
//   * Task 7 made `POST /admin/jobs/freeze-next-day` write place_releases.frozen_at
//     and made a frozen day refuse release cancellation with 409. `status` stays
//     'active' on purpose — a frozen release is still a released place the next
//     morning's queue run hands out; "frozen" means "cannot be withdrawn".
//   * Task 12 added the past-date gate on release creation, so a day that has
//     already ended can no longer be released.
//   * Task 12 fixed `POST /admin/reservations/cancel`, which used to 500 for
//     every reservation and left the operator with no way to undo an assignment.
//
// Each of those tests carries a comment saying what it used to pin, so the
// history stays readable without keeping the dead assertions around.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { addDays, createFixtures, getJson, postJson } = require('../testing/fixtures');
const { currentDateInTimezone } = require('../../../packages/shared/dates');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

describe('place releases (integration)', { skip: skipWithoutDatabase() }, () => {
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

  /** An owned place with no release yet — the starting point for create tests. */
  async function ownedPlace(date) {
    const owner = await fixtures.insertEmployee();
    const place = await fixtures.insertPlace({ placeType: 'double' });
    await fixtures.insertPermanentAssignment({
      userId: owner.id,
      parkingPlaceId: place.id,
      dateFrom: addDays(date, -30),
      dateTo: addDays(date, 30)
    });
    return { owner, place };
  }

  describe('creating a release', () => {
    it('releases an owned place for a date range and audit-logs it', async () => {
      const date = '2026-11-02';
      const { owner, place } = await ownedPlace(date);

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: date,
        dateTo: addDays(date, 2),
        notes: 'Отпуск'
      });

      assert.equal(status, 201);
      assert.equal(payload.release.status, 'active');
      assert.equal(payload.release.createdVia, 'admin_web');
      assert.equal(payload.release.user.id, owner.id);
      assert.equal(payload.release.parkingPlace.code, place.code);

      // The range is stored half-open, so dateTo is inclusive on read-back.
      const stored = await db.query(
        `select lower(release_during)::text as date_from,
                (upper(release_during) - 1)::text as date_to,
                status, notes
         from place_releases where id = $1`,
        [payload.release.id]
      );
      assert.equal(stored.rows[0].date_from, date);
      assert.equal(stored.rows[0].date_to, addDays(date, 2));
      assert.equal(stored.rows[0].notes, 'Отпуск');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'place_release_created' and entity_id = $1",
        [payload.release.id]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].metadata.parkingPlaceCode, place.code);
    });

    it('refuses a place with no permanent owner for the range', async () => {
      const place = await fixtures.insertPlace();

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: '2026-11-03'
      });

      assert.equal(status, 409);
      assert.match(payload.error, /no permanent owner/i);
    });

    it('refuses a range overlapping an existing active release', async () => {
      const date = '2026-11-04';
      const { place } = await ownedPlace(date);

      const first = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: date,
        dateTo: addDays(date, 3)
      });
      assert.equal(first.status, 201);

      const overlapping = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: addDays(date, 2),
        dateTo: addDays(date, 5)
      });

      assert.equal(overlapping.status, 409);
      assert.match(overlapping.payload.error, /already has an active release overlapping/i);
    });

    it('rejects dateTo before dateFrom, and malformed dates', async () => {
      const date = '2026-11-05';
      const { place } = await ownedPlace(date);

      const reversed = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: addDays(date, 3),
        dateTo: date
      });
      assert.equal(reversed.status, 400);
      assert.match(reversed.payload.error, /dateTo must be greater than or equal to dateFrom/);

      const malformed = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: '05.11.2026'
      });
      assert.equal(malformed.status, 400);
      assert.match(malformed.payload.error, /YYYY-MM-DD/);
    });
  });

  describe('cancelling a release (the owner taking the place back)', () => {
    it('cancels an untouched release and audit-logs it', async () => {
      const date = '2026-11-10';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(status, 200);
      assert.equal(payload.release.status, 'canceled');

      const stored = await db.query(
        'select status, canceled_at from place_releases where id = $1',
        [release.id]
      );
      assert.equal(stored.rows[0].status, 'canceled');
      assert.ok(stored.rows[0].canceled_at);

      const audit = await db.query(
        "select id from audit_logs where action = 'place_release_canceled' and entity_id = $1",
        [release.id]
      );
      assert.equal(audit.rowCount, 1);
    });

    it('refuses to cancel while somebody else holds an active reservation', async () => {
      const date = '2026-11-11';
      const { place, release } = await fixtures.insertReleasedPlace({ date });
      await fixtures.insertReleasedPlace({ date });
      const employee = await fixtures.insertEmployee();

      const assigned = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: date
      });
      assert.equal(assigned.status, 201);

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, /active reservations/i);

      const stored = await db.query('select status from place_releases where id = $1', [release.id]);
      assert.equal(stored.rows[0].status, 'active', 'the refused cancel must not have mutated the release');
    });

    it('succeeds once the blocking reservation is cancelled (cancelled directly in the DB)', async () => {
      // The blocking reservation is cleared with SQL rather than through
      // /admin/reservations/cancel because that endpoint is currently broken —
      // see the characterization test below. Once it is fixed this should go
      // through the API like the rest of the flow.
      const date = '2026-11-12';
      const { place, release } = await fixtures.insertReleasedPlace({ date });
      await fixtures.insertReleasedPlace({ date });
      const employee = await fixtures.insertEmployee();

      const assigned = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: date
      });
      assert.equal(assigned.status, 201);

      await db.query(
        "update reservations set status = 'canceled', canceled_at = now() where id = $1",
        [assigned.payload.reservation.id]
      );

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(status, 200);
      assert.equal(payload.release.status, 'canceled');
    });

    it('cancels a manual reservation and frees the place again', async () => {
      // Was a CHARACTERIZATION test in Task 3: handleAdminReservationCancel
      // selected `for update` over a query that LEFT JOINs users, which Postgres
      // refuses ("FOR UPDATE cannot be applied to the nullable side of an outer
      // join"), so *every* cancel 500'd. Combined with /admin/place-releases/cancel
      // refusing while an active reservation stands on the place, the operator had
      // no way at all to undo an assignment — both exits were closed. Task 12
      // narrowed the lock to `for update of r`; the assertions are inverted here.
      const date = '2026-11-14';
      const { place, release } = await fixtures.insertReleasedPlace({ date });
      await fixtures.insertReleasedPlace({ date });
      const employee = await fixtures.insertEmployee();

      const assigned = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: date
      });
      assert.equal(assigned.status, 201);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/cancel', {
        reservationId: assigned.payload.reservation.id
      });

      assert.equal(status, 200);
      assert.equal(payload.reservation.status, 'canceled');

      const stored = await db.query('select status, canceled_at from reservations where id = $1', [
        assigned.payload.reservation.id
      ]);
      assert.equal(stored.rows[0].status, 'canceled');
      assert.ok(stored.rows[0].canceled_at, 'the cancel is stamped');

      // The place is released again, so it is back in availability...
      const availability = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(availability.payload.availability.availablePlaces, 2);

      // ...and the other exit the defect had closed is open too: with no active
      // reservation left, the underlying release can now be taken back.
      const canceledRelease = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });
      assert.equal(canceledRelease.status, 200);
      assert.equal(canceledRelease.payload.release.status, 'canceled');
    });

    it('cancels a guest reservation too', async () => {
      const date = '2026-11-15';
      await fixtures.insertReleasedPlace({ date });

      const host = await fixtures.insertEmployee();
      const guest = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
        hostUserId: host.id,
        requestDate: date,
        guestName: 'Гость Отменяемый'
      });
      assert.equal(guest.status, 201);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/cancel', {
        reservationId: guest.payload.request.assignedReservation.id
      });

      assert.equal(status, 200);
      assert.equal(payload.reservation.status, 'canceled');
    });

    it('cancels a reservation whose user_id is null', async () => {
      // This is the shape that made the defect unavoidable rather than incidental:
      // `users` is LEFT JOINed because reservations.user_id is nullable — the
      // schema CHECK only demands a user *or* a guest request — and `for update`
      // over the whole join is what Postgres refused. The guest endpoint happens
      // to mint a users row, so it does not exercise the null on its own; this
      // test writes the legal user-less row directly and pins the narrowed lock.
      const date = '2026-11-17';
      const { place } = await fixtures.insertReleasedPlace({ date });
      const host = await fixtures.insertEmployee();

      const guestUser = await db.query(
        `
          insert into users (kind, first_name, last_name, display_name)
          values ('guest', 'Гость', 'Без Профиля', 'Гость Без Профиля')
          returning id
        `
      );

      const request = await db.query(
        `
          insert into guest_parking_requests (guest_user_id, host_user_id, request_date, guest_name, status)
          values ($1, $2, $3, 'Гость Без Профиля', 'assigned')
          returning id
        `,
        [guestUser.rows[0].id, host.id, date]
      );

      const reservation = await db.query(
        `
          insert into reservations (reservation_date, parking_place_id, user_id, guest_parking_request_id, source)
          values ($1, $2, null, $3, 'guest')
          returning id, user_id
        `,
        [date, place.id, request.rows[0].id]
      );
      assert.equal(reservation.rows[0].user_id, null);

      const { status, payload } = await postJson(api.baseUrl, '/admin/reservations/cancel', {
        reservationId: reservation.rows[0].id
      });

      assert.equal(status, 200);
      assert.equal(payload.reservation.status, 'canceled');
    });

    it('is idempotent — cancelling a reservation twice stays 200', async () => {
      const date = '2026-11-16';
      const { place } = await fixtures.insertReleasedPlace({ date });
      const employee = await fixtures.insertEmployee();

      const assigned = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: date
      });

      const first = await postJson(api.baseUrl, '/admin/reservations/cancel', {
        reservationId: assigned.payload.reservation.id
      });
      const second = await postJson(api.baseUrl, '/admin/reservations/cancel', {
        reservationId: assigned.payload.reservation.id
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(second.payload.reservation.status, 'canceled');
    });

    it('is idempotent — cancelling twice stays 200 and writes one audit row', async () => {
      const date = '2026-11-13';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const first = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });
      const second = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(second.payload.release.status, 'canceled');

      const audit = await db.query(
        "select count(*)::int as count from audit_logs where action = 'place_release_canceled' and entity_id = $1",
        [release.id]
      );
      assert.equal(audit.rows[0].count, 1);
    });

    it('rejects a missing releaseId with 400 and an unknown one with 404', async () => {
      const missing = await postJson(api.baseUrl, '/admin/place-releases/cancel', {});
      assert.equal(missing.status, 400);
      assert.match(missing.payload.error, /releaseId is required/);

      const unknown = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: '00000000-0000-0000-0000-000000000000'
      });
      assert.equal(unknown.status, 404);
      assert.match(unknown.payload.error, /not found/i);
    });
  });

  describe('the freeze job and the 19:00 cut-off', () => {
    it('snapshots availability and stamps the releases it froze', async () => {
      const date = '2026-11-20';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', {
        date
      });

      assert.equal(status, 200);
      assert.equal(payload.releaseCount, 1);
      assert.equal(payload.frozenCount, 1);
      assert.equal(payload.frozenReleases[0].id, release.id);
      assert.equal(payload.jobRun.jobName, 'freeze_next_day');
      assert.equal(payload.jobRun.status, 'success');

      const audit = await db.query(
        "select metadata from audit_logs where action = 'availability_frozen' and metadata->>'targetDate' = $1",
        [date]
      );
      assert.equal(audit.rowCount, 1);

      const stored = await db.query(
        'select status, frozen_at from place_releases where id = $1',
        [release.id]
      );
      assert.ok(stored.rows[0].frozen_at, 'Task 7 made freeze-next-day write frozen_at');
      assert.equal(
        stored.rows[0].status,
        'active',
        'the release stays active — a frozen release is still handed out by the morning queue run'
      );
    });

    it('refuses to cancel a release after the day was frozen', async () => {
      // Was a CHARACTERIZATION test in Task 3 (no freeze gate existed). Task 7
      // implemented the cut-off, so the assertion is inverted here on purpose.
      const date = '2026-11-21';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const frozen = await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });
      assert.equal(frozen.status, 200);

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, /frozen/i);

      const stored = await db.query('select status from place_releases where id = $1', [release.id]);
      assert.equal(stored.rows[0].status, 'active');
    });

    it('refuses to create a release for a date already in the past', async () => {
      // Was a CHARACTERIZATION test in Task 3: no endpoint compared the requested
      // date against today in APP_TIMEZONE, so a place could be "released" for a
      // day that had already ended — a slot nobody could ever have taken, which
      // only pollutes availability and history. Task 12 added the gate.
      const pastDate = '2020-01-15';
      const { place } = await ownedPlace(pastDate);

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: pastDate
      });

      assert.equal(status, 400);
      assert.match(payload.error, /must not be in the past/);

      const stored = await db.query(
        'select count(*)::int as count from place_releases where parking_place_id = $1',
        [place.id]
      );
      assert.equal(stored.rows[0].count, 0, 'nothing was written');
    });

    it('accepts a release for today, which is the common case', async () => {
      // The gate is "before today", not "not today": releasing your place on the
      // morning you decide to work from home is the flow the operator uses most.
      const today = currentDateInTimezone(process.env.APP_TIMEZONE || 'Europe/Moscow');
      const { place } = await ownedPlace(today);

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: today
      });

      assert.equal(status, 201);
      assert.equal(payload.release.status, 'active');
    });

    it('rejects a malformed freeze date with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', {
        date: '20-11-2026'
      });

      assert.equal(status, 400);
      assert.match(payload.error, /YYYY-MM-DD/);
    });
  });

  describe('availability reflects releases', () => {
    it('counts an active release and drops it once reserved', async () => {
      const date = '2026-11-25';
      const { place } = await fixtures.insertReleasedPlace({ date });

      const before = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(before.status, 200);
      assert.equal(before.payload.availability.availablePlaces, 1);

      const employee = await fixtures.insertEmployee();
      const assigned = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: employee.id,
        parkingPlaceId: place.id,
        reservationDate: date
      });
      assert.equal(assigned.status, 201);

      const afterAssignment = await getJson(api.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(afterAssignment.payload.availability.availablePlaces, 0);
    });
  });
});
