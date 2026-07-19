'use strict';

// Integration tests for the five scheduled jobs (Task 7).
//
// Every job must do three things: produce a real state transition, record the
// run in job_runs with a status and a summary, and be a no-op the second time
// it runs for the same date. The "no-op" assertions are the point of this file —
// the scheduler retries on container restart and the operator can re-fire a job
// by hand, so a job that double-applies is a data-corruption bug waiting for a
// bad night.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createFixtures, getJson, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

describe('scheduled jobs (integration)', { skip: skipWithoutDatabase() }, () => {
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

  /** Every run of every job is expected to leave exactly one job_runs row. */
  async function jobRuns(jobName, date) {
    const result = await db.query(
      'select status, summary, error, started_at, finished_at from job_runs where job_name = $1 and target_date = $2::date order by started_at',
      [jobName, date]
    );

    return result.rows;
  }

  async function auditCount(action, date) {
    const result = await db.query(
      "select count(*)::int as count from audit_logs where action = $1 and metadata->>'targetDate' = $2",
      [action, date]
    );

    return result.rows[0].count;
  }

  describe('freeze-next-day', () => {
    it('freezes the active releases for the target date', async () => {
      const date = '2027-02-01';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });

      assert.equal(status, 200);
      assert.equal(payload.frozenCount, 1);
      assert.equal(payload.alreadyFrozen, false);
      assert.equal(payload.releaseCount, 1);

      const stored = await db.query('select status, frozen_at from place_releases where id = $1', [
        release.id
      ]);
      assert.ok(stored.rows[0].frozen_at, 'freeze must stamp frozen_at');
      assert.equal(
        stored.rows[0].status,
        'active',
        'a frozen release is still released — the morning queue run has to be able to hand it out'
      );
    });

    it('is a no-op on the second run', async () => {
      const date = '2027-02-02';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const first = await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });
      assert.equal(first.payload.frozenCount, 1);

      const firstFrozenAt = (
        await db.query('select frozen_at from place_releases where id = $1', [release.id])
      ).rows[0].frozen_at;

      const second = await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });

      assert.equal(second.status, 200);
      assert.equal(second.payload.frozenCount, 0);
      assert.equal(second.payload.alreadyFrozen, true);
      assert.equal(second.payload.releaseCount, 1, 'the release is still reported as part of the day');

      const secondFrozenAt = (
        await db.query('select frozen_at from place_releases where id = $1', [release.id])
      ).rows[0].frozen_at;
      assert.deepEqual(secondFrozenAt, firstFrozenAt, 're-running must not restamp frozen_at');

      assert.equal(await auditCount('availability_frozen', date), 1, 'no duplicate audit row');
    });

    it('records both runs in job_runs with a summary', async () => {
      const date = '2027-02-03';
      await fixtures.insertReleasedPlace({ date });

      await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });
      await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });

      const runs = await jobRuns('freeze_next_day', date);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === 'success'));
      assert.ok(runs.every((run) => run.finished_at !== null));
      assert.equal(runs[0].summary.frozenCount, 1);
      assert.equal(runs[1].summary.frozenCount, 0);
    });

    it('refuses to cancel a release once its day is frozen', async () => {
      // The cut-off rule from the plan: after the 19:00 freeze the day's pool is
      // settled and the owner can no longer take their place back.
      const date = '2027-02-04';
      const { release } = await fixtures.insertReleasedPlace({ date });

      await postJson(api.baseUrl, '/admin/jobs/freeze-next-day', { date });

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(status, 409);
      assert.match(payload.error, /frozen/i);

      const stored = await db.query('select status from place_releases where id = $1', [release.id]);
      assert.equal(stored.rows[0].status, 'active', 'the refused cancel must not change the release');
    });

    it('still allows cancelling a release for a day that was never frozen', async () => {
      const date = '2027-02-05';
      const { release } = await fixtures.insertReleasedPlace({ date });

      const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
        releaseId: release.id
      });

      assert.equal(status, 200);
      assert.equal(payload.release.status, 'canceled');
    });
  });

  describe('unlock-employee-pool', () => {
    it('reports the employee capacity left after the guest reserve', async () => {
      // This suite boots with GUEST_RESERVE_MINIMUM=0, so the reserve is asserted
      // against an API started with the real default of 5 further down.
      const date = '2027-03-01';
      await fixtures.insertReleasedPlace({ date, place: { code: 'U-A1' } });
      await fixtures.insertReleasedPlace({ date, place: { code: 'U-A2' } });

      const waiting = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: waiting.id, date, position: 1 });

      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/unlock-employee-pool', {
        date
      });

      assert.equal(status, 200);
      assert.equal(payload.availableReleasedPlacesCount, 2);
      assert.equal(payload.guestReserveMinimum, 0);
      assert.equal(payload.employeePoolSize, 2);
      assert.equal(payload.waitingCount, 1);
      assert.equal(payload.servableCount, 1);
      assert.equal(payload.unservableCount, 0);
      assert.equal(payload.alreadyUnlocked, false);
    });

    it('counts the employees the pool cannot serve', async () => {
      const date = '2027-03-02';
      await fixtures.insertReleasedPlace({ date, place: { code: 'U-B1' } });

      const first = await fixtures.insertEmployee();
      const second = await fixtures.insertEmployee();
      const third = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: first.id, date, position: 1 });
      await fixtures.insertQueuedRequest({ userId: second.id, date, position: 2 });
      await fixtures.insertQueuedRequest({ userId: third.id, date, position: 3 });

      const { payload } = await postJson(api.baseUrl, '/admin/jobs/unlock-employee-pool', { date });

      assert.equal(payload.employeePoolSize, 1);
      assert.equal(payload.waitingCount, 3);
      assert.equal(payload.servableCount, 1);
      assert.equal(payload.unservableCount, 2);
    });

    it('is a no-op on the second run', async () => {
      const date = '2027-03-03';
      await fixtures.insertReleasedPlace({ date, place: { code: 'U-C1' } });

      const first = await postJson(api.baseUrl, '/admin/jobs/unlock-employee-pool', { date });
      assert.equal(first.payload.alreadyUnlocked, false);

      const second = await postJson(api.baseUrl, '/admin/jobs/unlock-employee-pool', { date });

      assert.equal(second.status, 200);
      assert.equal(second.payload.alreadyUnlocked, true);
      assert.equal(await auditCount('employee_pool_unlocked', date), 1);

      const runs = await jobRuns('unlock_employee_pool', date);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === 'success'));
    });

    it('rejects a malformed date with 400', async () => {
      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/unlock-employee-pool', {
        date: '01-03-2027'
      });

      assert.equal(status, 400);
      assert.match(payload.error, /YYYY-MM-DD/);
    });
  });

  describe('lock-departure-plans', () => {
    /** A departure plan needs an owner standing in a line on that date. */
    async function planForDate(date, departureTime) {
      const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });
      const place = await fixtures.insertPlace({ lineGroupId: lineGroup.id, linePositionHint: 1 });
      const employee = await fixtures.insertEmployee();

      await fixtures.insertPermanentAssignment({
        userId: employee.id,
        parkingPlaceId: place.id,
        dateFrom: date,
        dateTo: date
      });

      const plan = await fixtures.insertDeparturePlan({
        userId: employee.id,
        date,
        departureTime,
        isEarly: true
      });

      return { employee, lineGroup, place, plan };
    }

    it('locks the plans for the target date', async () => {
      const date = '2027-04-01';
      const { plan } = await planForDate(date, '15:30');

      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/lock-departure-plans', {
        date
      });

      assert.equal(status, 200);
      assert.equal(payload.lockedCount, 1);
      assert.equal(payload.plansCount, 1);
      assert.equal(payload.alreadyLocked, false);

      const stored = await db.query('select locked_at from departure_plans where id = $1', [plan.id]);
      assert.ok(stored.rows[0].locked_at, 'the lock must be persisted, not just audited');
    });

    it('refuses to edit a locked plan', async () => {
      const date = '2027-04-02';
      const { employee } = await planForDate(date, '15:30');

      await postJson(api.baseUrl, '/admin/jobs/lock-departure-plans', { date });

      const { status, payload } = await postJson(api.baseUrl, '/admin/departure-plans', {
        userId: employee.id,
        planDate: date,
        departureTime: '16:00'
      });

      assert.equal(status, 409);
      assert.match(payload.error, /locked/i);

      const stored = await db.query(
        'select departure_time::text as departure_time from departure_plans where user_id = $1 and plan_date = $2::date',
        [employee.id, date]
      );
      assert.match(stored.rows[0].departure_time, /^15:30/, 'the refused edit must not land');
    });

    it('is a no-op on the second run', async () => {
      const date = '2027-04-03';
      const { plan } = await planForDate(date, '15:00');

      await postJson(api.baseUrl, '/admin/jobs/lock-departure-plans', { date });
      const firstLockedAt = (
        await db.query('select locked_at from departure_plans where id = $1', [plan.id])
      ).rows[0].locked_at;

      const second = await postJson(api.baseUrl, '/admin/jobs/lock-departure-plans', { date });

      assert.equal(second.payload.lockedCount, 0);
      assert.equal(second.payload.alreadyLocked, true);

      const secondLockedAt = (
        await db.query('select locked_at from departure_plans where id = $1', [plan.id])
      ).rows[0].locked_at;
      assert.deepEqual(secondLockedAt, firstLockedAt, 're-running must not restamp locked_at');

      assert.equal(await auditCount('departure_plan_editing_locked', date), 1);

      const runs = await jobRuns('lock_departure_plans', date);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === 'success'));
    });

    it('locks nothing and succeeds on a date with no plans', async () => {
      const date = '2027-04-04';

      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/lock-departure-plans', {
        date
      });

      assert.equal(status, 200);
      assert.equal(payload.plansCount, 0);
      assert.equal(payload.lockedCount, 0);
      assert.equal(await auditCount('departure_plan_editing_locked', date), 0);
    });
  });

  describe('rebuild-conflicts', () => {
    /**
     * Two employees in one line on the same day: `blocker` stands in front of
     * `early`, so an early departure by `early` is a conflict.
     */
    async function blockedLine(date, departureTime) {
      const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });
      const frontPlace = await fixtures.insertPlace({
        lineGroupId: lineGroup.id,
        linePositionHint: 1
      });
      const rearPlace = await fixtures.insertPlace({ lineGroupId: lineGroup.id, linePositionHint: 2 });

      const blocker = await fixtures.insertEmployee();
      const early = await fixtures.insertEmployee();

      await fixtures.insertPermanentAssignment({
        userId: blocker.id,
        parkingPlaceId: frontPlace.id,
        dateFrom: date,
        dateTo: date
      });
      await fixtures.insertPermanentAssignment({
        userId: early.id,
        parkingPlaceId: rearPlace.id,
        dateFrom: date,
        dateTo: date
      });

      await fixtures.insertLineOccupancy({
        date,
        lineGroupId: lineGroup.id,
        parkingPlaceId: frontPlace.id,
        position: 1,
        userId: blocker.id
      });
      await fixtures.insertLineOccupancy({
        date,
        lineGroupId: lineGroup.id,
        parkingPlaceId: rearPlace.id,
        position: 2,
        userId: early.id
      });

      const plan = await fixtures.insertDeparturePlan({
        userId: early.id,
        date,
        departureTime,
        isEarly: true
      });

      return { blocker, early, plan };
    }

    it('reports the conflicts for the date', async () => {
      const date = '2027-05-01';
      const { early } = await blockedLine(date, '15:00');

      const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/rebuild-conflicts', {
        date
      });

      assert.equal(status, 200);
      assert.equal(payload.conflictCount, 1);
      assert.equal(payload.conflicts[0].earlyDeparture.user.id, early.id);
    });

    it('recomputes is_early that drifted from the cut-off rule', async () => {
      const date = '2027-05-02';
      const { plan } = await blockedLine(date, '15:00');

      // Simulate drift: the stored flag disagrees with what the rule says about
      // a 15:00 departure.
      await db.query('update departure_plans set is_early = false where id = $1', [plan.id]);

      const { payload } = await postJson(api.baseUrl, '/admin/jobs/rebuild-conflicts', { date });

      assert.equal(payload.recalculatedCount, 1);
      assert.equal(payload.changed, true);

      const stored = await db.query('select is_early from departure_plans where id = $1', [plan.id]);
      assert.equal(stored.rows[0].is_early, true, 'the flag must be repaired from the rule');
    });

    it('is a no-op on the second run', async () => {
      const date = '2027-05-03';
      const { plan } = await blockedLine(date, '15:00');
      await db.query('update departure_plans set is_early = false where id = $1', [plan.id]);

      const first = await postJson(api.baseUrl, '/admin/jobs/rebuild-conflicts', { date });
      assert.equal(first.payload.changed, true);

      const second = await postJson(api.baseUrl, '/admin/jobs/rebuild-conflicts', { date });

      assert.equal(second.payload.changed, false);
      assert.equal(second.payload.recalculatedCount, 0);
      assert.equal(
        second.payload.conflictCount,
        first.payload.conflictCount,
        'the conflict set is a pure recomputation and must be stable'
      );
      assert.equal(await auditCount('conflicts_rebuilt', date), 1);

      const runs = await jobRuns('rebuild_conflicts', date);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === 'success'));
    });

    it('leaves a plan that already matches the rule alone', async () => {
      const date = '2027-05-04';
      await blockedLine(date, '15:00');

      const { payload } = await postJson(api.baseUrl, '/admin/jobs/rebuild-conflicts', { date });

      assert.equal(payload.recalculatedCount, 0);
      assert.equal(payload.changed, false);
    });
  });

  describe('process-queue', () => {
    it('skips a manually-served employee instead of failing the whole batch', async () => {
      // The defect pinned in Task 3: a manual assignment left the employee's
      // request 'queued', so the next run tried to give them a second place,
      // tripped reservations_active_user_date_uniq and 409'd every employee in
      // the batch. Both halves are fixed — the manual endpoint closes the
      // request, and the queue run skips anyone already holding a place.
      const date = '2027-06-01';
      const { place } = await fixtures.insertReleasedPlace({
        date,
        place: { code: 'J-A1', placeType: 'double' }
      });
      await fixtures.insertReleasedPlace({ date, place: { code: 'J-A2', placeType: 'double' } });

      const manual = await fixtures.insertEmployee();
      const waiting = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: manual.id, date, position: 1 });
      await fixtures.insertQueuedRequest({ userId: waiting.id, date, position: 2 });

      const assignment = await postJson(api.baseUrl, '/admin/reservations/manual', {
        userId: manual.id,
        parkingPlaceId: place.id,
        reservationDate: date
      });
      assert.equal(assignment.status, 201);

      // The manual endpoint now closes the request it just answered.
      const closed = await db.query(
        'select status, assigned_reservation_id from employee_parking_requests where user_id = $1 and request_date = $2::date',
        [manual.id, date]
      );
      assert.equal(closed.rows[0].status, 'assigned');
      assert.equal(closed.rows[0].assigned_reservation_id, assignment.payload.reservation.id);

      const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

      assert.equal(status, 200, 'the batch must survive a manually-served employee');
      assert.equal(payload.assignedCount, 1);
      assert.equal(payload.assignments[0].user.id, waiting.id);

      const reservations = await db.query(
        "select user_id from reservations where reservation_date = $1::date and status = 'active' order by created_at",
        [date]
      );
      assert.equal(reservations.rowCount, 2, 'one manual, one from the queue — nobody got two');
    });

    it('closes a queue entry against a reservation the user already holds', async () => {
      // Same guard, reached the other way: the request is still 'queued' when
      // the run starts (a reservation written by some other path), so the run
      // has to reconcile it rather than assign a second place.
      const date = '2027-06-02';
      const { place } = await fixtures.insertReleasedPlace({
        date,
        place: { code: 'J-B1', placeType: 'double' }
      });

      const employee = await fixtures.insertEmployee();
      const { request, queueEntry } = await fixtures.insertQueuedRequest({
        userId: employee.id,
        date,
        position: 1
      });

      await db.query(
        `
          insert into reservations (reservation_date, parking_place_id, user_id, source, status)
          values ($1::date, $2, $3, 'manual', 'active')
        `,
        [date, place.id, employee.id]
      );

      const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

      assert.equal(status, 200);
      assert.equal(payload.assignedCount, 0);
      assert.equal(payload.skippedCount, 1);
      assert.equal(payload.skipped[0].reason, 'already_has_reservation');

      const storedEntry = await db.query('select status from queue_entries where id = $1', [
        queueEntry.id
      ]);
      assert.equal(
        storedEntry.rows[0].status,
        'assigned',
        'the entry is settled against the existing reservation, not skipped as unserved'
      );

      const storedRequest = await db.query(
        'select status from employee_parking_requests where id = $1',
        [request.id]
      );
      assert.equal(storedRequest.rows[0].status, 'assigned');
    });

    it('is a no-op on the second run', async () => {
      const date = '2027-06-03';
      await fixtures.insertReleasedPlace({ date, place: { code: 'J-C1', placeType: 'double' } });

      const employee = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });

      const first = await postJson(api.baseUrl, '/admin/queue/process', { date });
      assert.equal(first.payload.assignedCount, 1);

      const second = await postJson(api.baseUrl, '/admin/queue/process', { date });

      assert.equal(second.status, 200);
      assert.equal(second.payload.assignedCount, 0);
      assert.equal(second.payload.skippedCount, 0);

      const reservations = await db.query(
        "select count(*)::int as count from reservations where reservation_date = $1::date and status = 'active'",
        [date]
      );
      assert.equal(reservations.rows[0].count, 1, 'the second run must not duplicate the assignment');

      // /admin/queue/process and /admin/jobs/process-queue are the same handler,
      // so the operator's manual run is booked in job_runs exactly like the
      // scheduled one.
      const runs = await jobRuns('process_queue', date);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === 'success'));
    });

    it('records the run in job_runs when called through the job endpoint', async () => {
      const date = '2027-06-04';
      await fixtures.insertReleasedPlace({ date, place: { code: 'J-D1', placeType: 'double' } });

      const employee = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });

      await postJson(api.baseUrl, '/admin/jobs/process-queue', { date });
      await postJson(api.baseUrl, '/admin/jobs/process-queue', { date });

      const runs = await jobRuns('process_queue', date);
      assert.equal(runs.length, 2);
      assert.ok(runs.every((run) => run.status === 'success'));
      assert.equal(runs[0].summary.assignedCount, 1);
      assert.equal(runs[1].summary.assignedCount, 0, 'the replay assigns nothing');
    });
  });

  describe('the guest reserve is honored with the real default', () => {
    let reserveApi = null;

    before(async () => {
      reserveApi = await startApi({
        databaseUrl: db.connectionString,
        env: { GUEST_RESERVE_MINIMUM: '5' }
      });
    });

    after(async () => {
      if (reserveApi) {
        await reserveApi.stop();
      }
    });

    it('holds five places back from the employee pool', async () => {
      const date = '2027-07-01';

      for (let index = 0; index < 7; index += 1) {
        await fixtures.insertReleasedPlace({ date, place: { code: `R-A${index}` } });
      }

      const { payload } = await postJson(reserveApi.baseUrl, '/admin/jobs/unlock-employee-pool', {
        date
      });

      assert.equal(payload.availableReleasedPlacesCount, 7);
      assert.equal(payload.guestReserveMinimum, 5);
      assert.equal(payload.employeePoolSize, 2, 'seven released minus the five-place guest reserve');
    });

    it('reports an empty pool when the reserve swallows everything released', async () => {
      const date = '2027-07-02';

      for (let index = 0; index < 3; index += 1) {
        await fixtures.insertReleasedPlace({ date, place: { code: `R-B${index}` } });
      }

      const { payload } = await postJson(reserveApi.baseUrl, '/admin/jobs/unlock-employee-pool', {
        date
      });

      assert.equal(payload.availableReleasedPlacesCount, 3);
      assert.equal(payload.employeePoolSize, 0);
      assert.equal(payload.servableCount, 0);
    });

    it('stops the queue at the reserve floor', async () => {
      const date = '2027-07-03';

      for (let index = 0; index < 6; index += 1) {
        await fixtures.insertReleasedPlace({ date, place: { code: `R-C${index}` } });
      }

      const first = await fixtures.insertEmployee();
      const second = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: first.id, date, position: 1 });
      await fixtures.insertQueuedRequest({ userId: second.id, date, position: 2 });

      const unlocked = await postJson(reserveApi.baseUrl, '/admin/jobs/unlock-employee-pool', { date });
      assert.equal(unlocked.payload.employeePoolSize, 1);

      const { payload } = await postJson(reserveApi.baseUrl, '/admin/jobs/process-queue', { date });

      assert.equal(payload.assignedCount, 1, 'the pool size the unlock job announced is what the queue hands out');
      assert.equal(payload.skippedCount, 1);
      assert.equal(payload.skipped[0].reason, 'guest_reserve_minimum_reached');

      const availability = await getJson(reserveApi.baseUrl, `/admin/availability?date=${date}`);
      assert.equal(availability.status, 200);
    });
  });
});
