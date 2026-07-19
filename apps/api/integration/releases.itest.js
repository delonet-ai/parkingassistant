'use strict';

// Characterization tests for place releases and the freeze job.
//
// NOTE ON THE 19:00 CUT-OFF
// -------------------------
// The plan asks this task to pin "post-19:00 same-day return rejected once the
// day is frozen". That rule is NOT implemented today, and these tests pin what
// the code actually does rather than what it should do:
//
//   * `POST /admin/jobs/freeze-next-day` is a read-only snapshot. It writes a
//     job_runs row and an `availability_frozen` audit row, and never sets
//     place_releases.status = 'frozen' or place_releases.frozen_at, even though
//     the enum value and the column both exist in the schema.
//   * No release endpoint compares the request date against the current date or
//     against 19:00 in APP_TIMEZONE, so a same-day — or even past-dated —
//     release can still be created and cancelled after the freeze ran.
//   * The only guard that actually refuses a cancel is an active reservation
//     standing on the released place.
//
// Implementing the cut-off belongs to Task 7 ("Harden scheduled jobs"). The
// tests below are written so that they fail loudly when that lands, which is the
// point of a characterization test.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { addDays, createFixtures, getJson, postJson } = require('../testing/fixtures');
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

    it('CHARACTERIZATION: /admin/reservations/cancel is broken and always 500s', async () => {
      // DEFECT. handleAdminReservationCancel selects with `for update` over a
      // query that LEFT JOINs users, and Postgres refuses:
      //   "FOR UPDATE cannot be applied to the nullable side of an outer join"
      //
      // Every cancel therefore fails, for every reservation. Because
      // /admin/place-releases/cancel refuses while an active reservation stands
      // on the place, the operator has no way to undo an assignment at all:
      // the reservation cannot be cancelled and the release cannot be taken
      // back. The fix is to move `users` out of the locked relation (or lock
      // only `r`), and it belongs to the Task 12 defect sweep.
      const date = '2026-11-14';
      const { place } = await fixtures.insertReleasedPlace({ date });
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

      assert.equal(status, 500);
      assert.match(payload.error, /FOR UPDATE cannot be applied to the nullable side/);

      // The reservation is untouched, so the place stays occupied.
      const stored = await db.query('select status from reservations where id = $1', [
        assigned.payload.reservation.id
      ]);
      assert.equal(stored.rows[0].status, 'active');
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

    it('CHARACTERIZATION: releases can be created for dates already in the past', async () => {
      // Same gap seen from the other side — no endpoint compares the requested
      // date against today in APP_TIMEZONE.
      const pastDate = '2020-01-15';
      const { place } = await ownedPlace(pastDate);

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases', {
        parkingPlaceId: place.id,
        dateFrom: pastDate
      });

      assert.equal(status, 201, 'no past-date gate exists today');
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
