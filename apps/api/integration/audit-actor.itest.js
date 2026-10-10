'use strict';

// The audit trail names a person (Task 6).
//
// `audit_logs.actor_auth_user_id` has existed since `001_initial_schema.sql` and was never
// written: every row said `admin-web` — an application that has since been deleted — and
// nothing about who acted. Now the router resolves the session once per request and the
// services carry that actor down to the insert.
//
// What this suite pins is the part a reviewer cannot check by reading one service: that the
// actor on the row is *the session that made the request*, not a constant someone wired in
// once. So two operators sign in and each writes, and the rows have to disagree about who
// acted. A suite that only ever had one operator would pass against a hard-coded id.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { createModules } = require('../src/modules');
const { createDbRepository } = require('../src/repositories/db');
const { SESSION_COOKIE_NAME } = require('../src/support/cookies');
const { startApi } = require('../testing/boot-api');
const { createFixtures, getJson, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

const DATE = '2026-11-16';
const SECOND_OPERATOR = { login: 'second-operator', password: 'second-operator-password' };

describe('audit actor (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let fixtures = null;
  let secondOperator = null;

  before(async () => {
    db = await createTestDatabase();
    fixtures = createFixtures(db);
    api = await startApi({
      databaseUrl: db.connectionString,
      env: { GUEST_RESERVE_MINIMUM: '0' }
    });

    // Created through the API rather than with SQL, so the row carries whatever the
    // user-management path actually writes.
    const created = await postJson(api.baseUrl, '/admin/users', {
      login: SECOND_OPERATOR.login,
      displayName: 'Второй оператор',
      password: SECOND_OPERATOR.password,
      roles: ['parking_admin']
    });
    assert.equal(created.status, 201, JSON.stringify(created.payload));

    const signedIn = await fetch(`${api.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SECOND_OPERATOR)
    });
    assert.equal(signedIn.status, 200);

    const header = signedIn.headers.get('set-cookie');
    const match = new RegExp(`(${SESSION_COOKIE_NAME}=[^;]+)`).exec(header);
    assert.ok(match, 'the second login must set a session cookie');

    secondOperator = { id: created.payload.user.id, cookie: match[1] };
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  async function auditRow(action, entityId) {
    const result = await db.query(
      `
        select actor_service, actor_auth_user_id, actor_user_id
        from audit_logs
        where action = $1
          and ($2::uuid is null or entity_id = $2)
        order by occurred_at desc, id desc
        limit 1
      `,
      [action, entityId || null]
    );

    return result.rows[0] || null;
  }

  it('names the operator who created an employee, and the admin UI they used', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/employees', {
      displayName: 'Актёров А. А.',
      department: 'IT'
    });

    assert.equal(status, 201, JSON.stringify(payload));

    const row = await auditRow('employee_created', payload.employee.id);
    assert.equal(row.actor_service, 'admin-ui');
    assert.equal(row.actor_auth_user_id, api.operator.user.id);
  });

  it('names the operator on a permanent assignment', async () => {
    const employee = await fixtures.insertEmployee();
    const place = await fixtures.insertPlace({ code: 'AA-100' });

    const { status, payload } = await postJson(api.baseUrl, '/admin/permanent-assignments', {
      userId: employee.id,
      parkingPlaceId: place.id,
      dateFrom: DATE
    });

    assert.equal(status, 201, JSON.stringify(payload));

    const row = await auditRow('permanent_assignment_created', payload.permanentAssignment.id);
    assert.equal(row.actor_service, 'admin-ui');
    assert.equal(row.actor_auth_user_id, api.operator.user.id);
  });

  // The one case a single-operator suite cannot see: the id on the row has to follow the
  // cookie, not the code.
  it('names the second operator on the row the second operator wrote', async () => {
    const released = await fixtures.insertReleasedPlace({ date: DATE, place: { code: 'AA-200' } });

    const canceled = await postJson(
      api.baseUrl,
      '/admin/place-releases/cancel',
      { releaseId: released.release.id },
      { cookie: secondOperator.cookie }
    );

    assert.equal(canceled.status, 200, JSON.stringify(canceled.payload));

    const row = await auditRow('place_release_canceled', released.release.id);
    assert.equal(row.actor_service, 'admin-ui');
    assert.equal(row.actor_auth_user_id, secondOperator.id);
    assert.notEqual(row.actor_auth_user_id, api.operator.user.id);
  });

  it('keeps the employee in actor_user_id while naming the operator who typed it', async () => {
    const employee = await fixtures.insertEmployee();
    const lineGroup = await fixtures.insertLineGroup({ capacity: 2 });
    const place = await fixtures.insertPlace({
      code: 'AA-300',
      placeType: 'double',
      lineGroupId: lineGroup.id,
      linePositionHint: 1
    });
    await fixtures.insertPlace({
      code: 'AA-301',
      placeType: 'double',
      lineGroupId: lineGroup.id,
      linePositionHint: 2
    });
    await fixtures.insertPlace({ code: 'AA-302' });

    const assigned = await postJson(api.baseUrl, '/admin/permanent-assignments', {
      userId: employee.id,
      parkingPlaceId: place.id,
      dateFrom: DATE
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.payload));

    const { status, payload } = await postJson(api.baseUrl, '/admin/departure-plans', {
      userId: employee.id,
      planDate: DATE,
      departureTime: '15:30'
    });

    assert.equal(status, 200, JSON.stringify(payload));

    const row = await auditRow('departure_plan_upserted', payload.departurePlan.id);
    assert.equal(row.actor_service, 'admin-ui');
    assert.equal(row.actor_auth_user_id, api.operator.user.id);
    assert.equal(row.actor_user_id, employee.id);
  });

  // A job a person started is theirs. The scheduler's own runs are the case that stays
  // service-only, which is what the `jobs` fallback in `support/actor.js` is for.
  it('names the operator who started a job, on the run and on its audit row', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/rebuild-conflicts', { date: DATE });

    assert.equal(status, 200, JSON.stringify(payload));

    // By the run's id, like the case below: both write this action, and "the latest row" would
    // make each case's answer depend on the order the file happens to declare them in.
    const audit = await db.query(
      `
        select actor_service, actor_auth_user_id
        from audit_logs
        where action = 'job_rebuild_conflicts_success' and metadata->>'jobRunId' = $1
      `,
      [payload.jobRun.id]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_service, 'admin-ui');
    assert.equal(audit.rows[0].actor_auth_user_id, api.operator.user.id);

    const run = await db.query(
      'select actor_service from job_runs where id = $1',
      [payload.jobRun.id]
    );
    assert.equal(run.rows[0].actor_service, 'admin-ui');
  });

  // The other half of the same question, and the half no HTTP request can ask today: a run
  // nobody started. The scheduler posts to `/admin/jobs/*` with no cookie, so since Task 3 it
  // is refused at the guard and never reaches the service — which is why this case drives the
  // service in-process against the same scratch schema, with the `actor` the scheduler's
  // request would produce once it has a way in: none.
  //
  // What it pins is that `jobs` is written because nobody was signed in, not because a label
  // was hard-coded: the cases above show the same code path naming a person.
  it('names the service, and no person, on a job run that no operator started', async () => {
    const { services } = createModules({
      appTimezone: 'Europe/Moscow',
      dbRepository: createDbRepository(db.pool),
      guestReserveMinimum: 0,
      pool: db.pool,
      startedAt: new Date().toISOString()
    });

    const result = await services.jobs.runRebuildConflicts({ actor: null, targetDate: DATE });
    const jobRunId = result.jobRun.id;

    const run = await db.query('select actor_service from job_runs where id = $1', [jobRunId]);
    assert.equal(run.rows[0].actor_service, 'jobs');

    // By the run's id, not by "the latest row": the operator-started run above writes the
    // same action, and picking the newest would let the two cases assert each other's row.
    const audit = await db.query(
      `
        select actor_service, actor_auth_user_id
        from audit_logs
        where action = 'job_rebuild_conflicts_success' and metadata->>'jobRunId' = $1
      `,
      [jobRunId]
    );

    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].actor_service, 'jobs');
    assert.equal(audit.rows[0].actor_auth_user_id, null);
  });

  it('serves the operator to the journal reader, by login and display name', async () => {
    const employee = await fixtures.insertEmployee();
    const created = await postJson(api.baseUrl, '/admin/employees/update', {
      employeeId: employee.id,
      displayName: 'Актёров Б. Б.',
      department: 'IT'
    });
    assert.equal(created.status, 200, JSON.stringify(created.payload));

    const { status, payload } = await getJson(api.baseUrl, `/admin/employees/${employee.id}/history`);

    assert.equal(status, 200);

    const entry = payload.history.auditLogs.find((log) => log.action === 'employee_updated');
    assert.ok(entry, 'the update must appear in the journal');
    assert.equal(entry.actorService, 'admin-ui');
    assert.equal(entry.actorAuthUser.id, api.operator.user.id);
    assert.equal(entry.actorAuthUser.login, 'sysadmin');
    assert.ok(entry.actorAuthUser.displayName, 'the journal has to carry a name, not only a login');
  });

  // Nothing in the journal may still name the deleted server-rendered application.
  it('writes no row attributed to admin-web', async () => {
    const result = await db.query("select count(*)::int as count from audit_logs where actor_service = 'admin-web'");

    assert.equal(result.rows[0].count, 0);
  });
});
