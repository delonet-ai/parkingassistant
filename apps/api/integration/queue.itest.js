'use strict';

// Characterization tests for queue processing: candidate ordering, the skip
// rules, what a manual assignment does to a queued user, and the job_runs
// bookkeeping that wraps every run.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createFixtures, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

describe('queue processing (integration)', { skip: skipWithoutDatabase() }, () => {
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

  it('assigns waiting entries in queue_position order', async () => {
    const date = '2026-10-01';
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-A1', placeType: 'double' } });
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-A2', placeType: 'double' } });

    const second = await fixtures.insertEmployee();
    const first = await fixtures.insertEmployee();

    // Insert the LATER queue position first, so passing means the handler
    // ordered by queue_position rather than by insertion order.
    await fixtures.insertQueuedRequest({ userId: second.id, date, position: 2 });
    await fixtures.insertQueuedRequest({ userId: first.id, date, position: 1 });

    const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

    assert.equal(status, 200);
    assert.equal(payload.assignedCount, 2);
    assert.equal(payload.skippedCount, 0);
    assert.deepEqual(
      payload.assignments.map((assignment) => assignment.queuePosition),
      [1, 2]
    );
    assert.equal(payload.assignments[0].user.id, first.id);
    assert.equal(payload.assignments[0].parkingPlace.code, 'Q-A1');
    assert.equal(payload.assignments[1].user.id, second.id);
    assert.equal(payload.assignments[1].parkingPlace.code, 'Q-A2');

    // Request, queue entry and reservation all move together.
    const requests = await db.query(
      "select status, assigned_reservation_id from employee_parking_requests where request_date = $1::date order by requested_at",
      [date]
    );
    assert.ok(requests.rows.every((row) => row.status === 'assigned'));
    assert.ok(requests.rows.every((row) => row.assigned_reservation_id !== null));

    const entries = await db.query(
      "select status, processed_at from queue_entries where queue_date = $1::date",
      [date]
    );
    assert.ok(entries.rows.every((row) => row.status === 'assigned'));
    assert.ok(entries.rows.every((row) => row.processed_at !== null));

    const reservations = await db.query(
      "select source, status from reservations where reservation_date = $1::date",
      [date]
    );
    assert.equal(reservations.rowCount, 2);
    assert.ok(reservations.rows.every((row) => row.source === 'queue' && row.status === 'active'));
  });

  it('prefers double, then triple, then single places, tie-broken by code', async () => {
    const date = '2026-10-02';
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-B3', placeType: 'single' } });
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-B2', placeType: 'triple' } });
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-B1', placeType: 'double' } });

    const employee = await fixtures.insertEmployee();
    await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });

    const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

    assert.equal(status, 200);
    assert.equal(payload.assignedCount, 1);
    assert.equal(payload.assignments[0].parkingPlace.code, 'Q-B1');
  });

  it('never hands a user back the place they released themselves', async () => {
    const date = '2026-10-03';
    const owner = await fixtures.insertEmployee();
    // The only released place on this date belongs to the only queued user.
    await fixtures.insertReleasedPlace({
      date,
      ownerId: owner.id,
      place: { code: 'Q-C1', placeType: 'double' }
    });
    await fixtures.insertQueuedRequest({ userId: owner.id, date, position: 1 });

    const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

    assert.equal(status, 200);
    assert.equal(payload.assignedCount, 0);
    assert.equal(payload.skippedCount, 1);
    assert.equal(payload.skipped[0].userId, owner.id);
    assert.equal(payload.skipped[0].reason, 'no_available_released_place');

    const entries = await db.query(
      "select status from queue_entries where queue_date = $1::date",
      [date]
    );
    assert.equal(entries.rows[0].status, 'skipped');

    // A skipped entry leaves the request queued — only the queue entry moves.
    const request = await db.query(
      'select status from employee_parking_requests where request_date = $1::date',
      [date]
    );
    assert.equal(request.rows[0].status, 'queued');
  });

  it('skips entries once the guest reserve would be breached', async () => {
    const date = '2026-10-04';
    const reserved = await startApi({
      databaseUrl: db.connectionString,
      env: { GUEST_RESERVE_MINIMUM: '1' }
    });

    try {
      // Two released places, reserve 1 → only one employee may be assigned.
      await fixtures.insertReleasedPlace({ date, place: { code: 'Q-D1', placeType: 'double' } });
      await fixtures.insertReleasedPlace({ date, place: { code: 'Q-D2', placeType: 'double' } });

      const first = await fixtures.insertEmployee();
      const second = await fixtures.insertEmployee();
      await fixtures.insertQueuedRequest({ userId: first.id, date, position: 1 });
      await fixtures.insertQueuedRequest({ userId: second.id, date, position: 2 });

      const { status, payload } = await postJson(reserved.baseUrl, '/admin/queue/process', { date });

      assert.equal(status, 200);
      assert.equal(payload.guestReserveMinimum, 1);
      assert.equal(payload.assignedCount, 1);
      assert.equal(payload.skippedCount, 1);
      assert.equal(payload.assignments[0].user.id, first.id);
      assert.equal(payload.skipped[0].userId, second.id);
      assert.equal(payload.skipped[0].reason, 'guest_reserve_minimum_reached');
    } finally {
      await reserved.stop();
    }
  });

  it('does not re-process an already-processed queue (second run is a no-op)', async () => {
    const date = '2026-10-05';
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-E1', placeType: 'double' } });
    const employee = await fixtures.insertEmployee();
    await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });

    const first = await postJson(api.baseUrl, '/admin/queue/process', { date });
    assert.equal(first.payload.assignedCount, 1);

    const second = await postJson(api.baseUrl, '/admin/queue/process', { date });

    assert.equal(second.status, 200);
    assert.equal(second.payload.assignedCount, 0);
    assert.equal(second.payload.skippedCount, 0);

    // No duplicate reservation was written by the second run.
    const reservations = await db.query(
      "select count(*)::int as count from reservations where reservation_date = $1::date and status = 'active'",
      [date]
    );
    assert.equal(reservations.rows[0].count, 1);
  });

  it('records every run in job_runs and audit_logs, including repeat runs', async () => {
    const date = '2026-10-06';
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-F1', placeType: 'double' } });
    const employee = await fixtures.insertEmployee();
    await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });

    const { payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

    assert.equal(payload.jobRun.jobName, 'process_queue');
    assert.equal(payload.jobRun.status, 'success');

    const runs = await db.query(
      "select status, summary from job_runs where job_name = 'process_queue' and target_date = $1::date",
      [date]
    );
    assert.equal(runs.rowCount, 1);
    assert.equal(runs.rows[0].status, 'success');
    assert.equal(runs.rows[0].summary.assignedCount, 1);

    const audit = await db.query(
      "select metadata from audit_logs where action = 'queue_processed' and metadata->>'queueDate' = $1",
      [date]
    );
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].metadata.assignedCount, 1);

    // The bookkeeping row is written per run, not per date.
    await postJson(api.baseUrl, '/admin/queue/process', { date });
    const runsAfter = await db.query(
      "select count(*)::int as count from job_runs where job_name = 'process_queue' and target_date = $1::date",
      [date]
    );
    assert.equal(runsAfter.rows[0].count, 2);
  });

  it('is reachable under both the queue and the jobs route', async () => {
    const date = '2026-10-07';
    await fixtures.insertReleasedPlace({ date, place: { code: 'Q-G1', placeType: 'double' } });
    const employee = await fixtures.insertEmployee();
    await fixtures.insertQueuedRequest({ userId: employee.id, date, position: 1 });

    const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/process-queue', { date });

    assert.equal(status, 200);
    assert.equal(payload.assignedCount, 1);
    assert.equal(payload.jobRun.jobName, 'process_queue');
  });

  it('rejects a missing or malformed date with 400', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', {});

    assert.equal(status, 400);
    assert.match(payload.error, /date is required and must use YYYY-MM-DD format/);
  });

  describe('interaction with manual assignment', () => {
    it('skips a queued user whose request was already assigned', async () => {
      const date = '2026-10-08';
      await fixtures.insertReleasedPlace({ date, place: { code: 'Q-H1', placeType: 'double' } });

      const assigned = await fixtures.insertEmployee();
      const waiting = await fixtures.insertEmployee();
      const alreadyAssigned = await fixtures.insertQueuedRequest({
        userId: assigned.id,
        date,
        position: 1
      });
      await fixtures.insertQueuedRequest({ userId: waiting.id, date, position: 2 });

      // Simulate the request having been satisfied outside the queue.
      await db.query("update employee_parking_requests set status = 'assigned' where id = $1", [
        alreadyAssigned.request.id
      ]);

      const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

      assert.equal(status, 200);
      assert.equal(payload.assignedCount, 1);
      assert.equal(
        payload.assignments[0].user.id,
        waiting.id,
        'the already-assigned request must not be processed again'
      );
    });

    it('a manual reservation closes the queue request, and the run serves everyone behind it', async () => {
      // Was a CHARACTERIZATION test in Task 3: a manually-served employee stayed
      // 'queued', so the next run tried to give them a second place, tripped
      // reservations_active_user_date_uniq and 409'd the WHOLE batch — including
      // the innocent employees queued behind them.
      //
      // Task 7 fixed both halves: the manual endpoint closes the request it just
      // answered, and the queue run skips anyone who already holds a place.
      const date = '2026-10-09';
      const { place } = await fixtures.insertReleasedPlace({
        date,
        place: { code: 'Q-I1', placeType: 'double' }
      });
      await fixtures.insertReleasedPlace({ date, place: { code: 'Q-I2', placeType: 'double' } });

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

      const queued = await db.query(
        'select status, assigned_reservation_id from employee_parking_requests where user_id = $1 and request_date = $2::date',
        [manual.id, date]
      );
      assert.equal(
        queued.rows[0].status,
        'assigned',
        'the manual assignment answers the request, so it must close it'
      );
      assert.equal(queued.rows[0].assigned_reservation_id, assignment.payload.reservation.id);

      const { status, payload } = await postJson(api.baseUrl, '/admin/queue/process', { date });

      assert.equal(status, 200, 'one manually-served employee must not fail the batch');
      assert.equal(payload.assignedCount, 1);
      assert.equal(
        payload.assignments[0].user.id,
        waiting.id,
        'the employee queued behind the manual one still gets served'
      );

      const reservations = await db.query(
        "select user_id from reservations where reservation_date = $1::date and status = 'active' order by created_at",
        [date]
      );
      assert.equal(reservations.rowCount, 2);
      assert.deepEqual(
        reservations.rows.map((row) => row.user_id),
        [manual.id, waiting.id],
        'exactly one place each — nobody was assigned twice'
      );

      const runs = await db.query(
        "select status, error from job_runs where job_name = 'process_queue' and target_date = $1::date",
        [date]
      );
      assert.equal(runs.rowCount, 1);
      assert.equal(runs.rows[0].status, 'success');
      assert.equal(runs.rows[0].error, null);
    });
  });
});
