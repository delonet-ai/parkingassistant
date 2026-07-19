'use strict';

// Verifies the demo dataset does what it exists for: after `npm run db:seed:demo` every
// admin list endpoint and the dashboard return content, and reloading it is idempotent.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../../../apps/api/testing/boot-api');
const { createTestDatabase, skipWithoutDatabase } = require('../testing/harness');
const { loadDemoData, resetDemoData } = require('../seed-demo');

const DEMO_PLACE_COUNT = 15;
// Every element is a line group, singles included — 2 doubles + 2 triples + 5 singles.
const DEMO_LINE_COUNT = 9;
const DEMO_USER_COUNT = 15; // 13 employees + 2 guests
const RELEASED_TODAY = 7;
const AVAILABLE_TODAY = 5;

describe('demo dataset (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  const withClient = async (fn) => {
    const client = await db.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  };

  const count = async (sql) => {
    const result = await db.query(sql);
    return Number(result.rows[0].count);
  };

  const getJson = async (pathname) => {
    const response = await fetch(`${api.baseUrl}${pathname}`);
    const payload = await response.json();
    assert.equal(response.status, 200, `${pathname} → ${response.status}`);
    return payload;
  };

  before(async () => {
    db = await createTestDatabase();
    await withClient((client) => loadDemoData({ client }));
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

  it('creates elements of every size, each one a line group', async () => {
    const result = await db.query(`
      select place_type, count(*)::int as count
      from parking_places
      where catalog_source = 'demo'
      group by place_type
      order by place_type
    `);

    const byType = Object.fromEntries(result.rows.map((row) => [row.place_type, row.count]));

    assert.equal(byType.single, 5);
    assert.equal(byType.double, 4);
    assert.equal(byType.triple, 6);
    assert.equal(await count("select count(*) from line_groups where code like 'demo-%'"), DEMO_LINE_COUNT);

    // No place is group-less, and place_role carries the guest/blocked classification —
    // the Места tab needs both to render anything.
    assert.equal(
      await count(
        "select count(*) from parking_places where catalog_source = 'demo' and line_group_id is null"
      ),
      0
    );

    const roles = await db.query(`
      select place_role, count(*)::int as count
      from parking_places
      where catalog_source = 'demo'
      group by place_role
      order by place_role
    `);

    assert.deepEqual(
      Object.fromEntries(roles.rows.map((row) => [row.place_role, row.count])),
      { regular: 11, rotatable: 3, blocked: 1 }
    );
  });

  it('creates employees with and without a permanent place', async () => {
    const withPlace = await count(`
      select count(distinct pa.user_id)
      from permanent_assignments pa
      join users u on u.id = pa.user_id
      where u.email like '%@demo.invalid'
    `);

    const withoutPlace = await count(`
      select count(*)
      from users u
      where u.email like '%@demo.invalid'
        and u.kind = 'employee'
        and not exists (select 1 from permanent_assignments pa where pa.user_id = u.id)
    `);

    assert.equal(withPlace, 10);
    assert.equal(withoutPlace, 3);
  });

  it('leaves the base seeds and the bootstrap admin untouched', async () => {
    assert.equal(await count("select count(*) from auth_users where lower(login) = 'sysadmin'"), 1);
    assert.equal(await count('select count(*) from auth_roles'), 2);
  });

  it('returns non-empty dashboard content for today', async () => {
    const payload = await getJson('/admin/dashboard');

    assert.ok(payload.releasedPlaces.length > 0, 'releasedPlaces');
    assert.ok(payload.reservations.length > 0, 'reservations');
    assert.ok(payload.guestRequests.length > 0, 'guestRequests');
    assert.ok(
      payload.releasedPlaces.some((place) => place.isReserved),
      'at least one released place is already taken'
    );
  });

  it('reports a coherent availability snapshot', async () => {
    const { availability } = await getJson('/admin/availability');

    assert.equal(availability.releasedPlaces, RELEASED_TODAY);
    assert.equal(availability.availablePlaces, AVAILABLE_TODAY);
    assert.ok(availability.byType.single > 0);
    assert.ok(availability.byType.double > 0);
    assert.ok(availability.byType.triple > 0);
    assert.equal(availability.guestReserve.status, 'ok');
  });

  it('returns non-empty data from every admin list endpoint', async () => {
    const checks = [
      ['/admin/employees', 'employees'],
      ['/admin/places', 'places'],
      ['/admin/permanent-assignments', 'permanentAssignments'],
      ['/admin/place-releases', 'releases'],
      ['/admin/employee-parking-requests', 'requests'],
      ['/admin/guest-parking-requests', 'requests'],
      ['/admin/line-groups', 'lineGroups'],
      ['/admin/line-occupancy', 'occupancy'],
      ['/admin/departure-plans', 'departurePlans'],
      ['/admin/conflicts', 'conflicts'],
      ['/admin/audit-logs', 'auditLogs']
    ];

    for (const [pathname, key] of checks) {
      const payload = await getJson(pathname);
      assert.ok(Array.isArray(payload[key]), `${pathname} → ${key} is an array`);
      assert.ok(payload[key].length > 0, `${pathname} → ${key} is empty`);
    }
  });

  it('seeds an early departure that is actually blocked, so conflicts render', async () => {
    const payload = await getJson('/admin/conflicts');
    const conflict = payload.conflicts[0];

    assert.equal(conflict.type, 'employee_blocks_early_departure');
    assert.equal(conflict.lineGroup.code, 'demo-line-4-101');
    assert.equal(conflict.earlyDeparture.parkingPlaceCode, '102');
    assert.equal(conflict.blocker.parkingPlaceCode, '101');
  });

  it('places both an employee (via the queue) and a guest', async () => {
    const employeeRequests = await getJson('/admin/employee-parking-requests');
    const guestRequests = await getJson('/admin/guest-parking-requests');

    assert.ok(employeeRequests.requests.some((request) => request.status === 'assigned'));
    assert.ok(employeeRequests.requests.some((request) => request.status === 'queued'));
    assert.ok(guestRequests.requests.some((request) => request.status === 'assigned'));
    assert.ok(guestRequests.requests.some((request) => request.status === 'active'));
  });

  it('is idempotent — reloading leaves the same row counts', async () => {
    const before = {
      places: await count("select count(*) from parking_places where catalog_source = 'demo'"),
      users: await count("select count(*) from users where email like '%@demo.invalid'"),
      reservations: await count('select count(*) from reservations'),
      releases: await count('select count(*) from place_releases'),
      audit: await count("select count(*) from audit_logs where actor_service = 'db_seed_demo'")
    };

    assert.equal(before.places, DEMO_PLACE_COUNT);
    assert.equal(before.users, DEMO_USER_COUNT);

    await withClient((client) => loadDemoData({ client }));
    await withClient((client) => loadDemoData({ client }));

    assert.deepEqual(
      {
        places: await count("select count(*) from parking_places where catalog_source = 'demo'"),
        users: await count("select count(*) from users where email like '%@demo.invalid'"),
        reservations: await count('select count(*) from reservations'),
        releases: await count('select count(*) from place_releases'),
        audit: await count("select count(*) from audit_logs where actor_service = 'db_seed_demo'")
      },
      before
    );
  });

  it('reset removes the demo rows and only those', async () => {
    await withClient((client) => resetDemoData({ client }));

    assert.equal(await count("select count(*) from parking_places where catalog_source = 'demo'"), 0);
    assert.equal(await count("select count(*) from users where email like '%@demo.invalid'"), 0);
    assert.equal(await count("select count(*) from line_groups where code like 'demo-%'"), 0);
    assert.equal(await count('select count(*) from reservations'), 0);
    assert.equal(await count('select count(*) from place_releases'), 0);
    assert.equal(await count('select count(*) from line_occupancy'), 0);
    assert.equal(await count("select count(*) from audit_logs where actor_service = 'db_seed_demo'"), 0);

    // The bootstrap seed and the role catalogue survive.
    assert.equal(await count("select count(*) from auth_users where lower(login) = 'sysadmin'"), 1);
    assert.equal(await count('select count(*) from auth_roles'), 2);

    // Reset is a no-op the second time.
    await withClient((client) => resetDemoData({ client }));
    assert.equal(await count("select count(*) from users where email like '%@demo.invalid'"), 0);
  });
});
