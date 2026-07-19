'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createModules } = require('./modules');
const { buildRouteTable } = require('./router');

// Task 17's contract, asserted rather than left to a code review:
//   controller.js  → services only. No repository, no pg, no transaction helper.
//   service.js     → owns the repository calls and the transactions.
//   router.js      → composes per-module route tables; the endpoint index is derived,
//                    not hand-kept, so a route and its documentation cannot drift.

const modulesRoot = path.join(__dirname, 'modules');

function contextDirectories() {
  return fs
    .readdirSync(modulesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function controllerFiles() {
  return contextDirectories()
    .map((context) => path.join(modulesRoot, context, 'controller.js'))
    .filter((file) => fs.existsSync(file));
}

// The four ways a controller could reach past its service and talk to the database.
const FORBIDDEN_CONTROLLER_REQUIRE = /require\('(?:pg|[^']*repository|[^']*repositories\/db|[^']*services\/availability)'\)/;

test('no controller requires a repository, the pg driver or the transaction helper', () => {
  const offenders = controllerFiles()
    .filter((file) => FORBIDDEN_CONTROLLER_REQUIRE.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(modulesRoot, file));

  assert.deepEqual(offenders, [], `controller reaching past its service: ${offenders.join(', ')}`);
});

test('every bounded context with a controller also has a service', () => {
  const missing = controllerFiles()
    .map((file) => path.join(path.dirname(file), 'service.js'))
    .filter((file) => !fs.existsSync(file))
    .map((file) => path.relative(modulesRoot, file));

  assert.deepEqual(missing, [], `controller without a service: ${missing.join(', ')}`);
});

test('the extraction actually produced controllers', () => {
  // Guards the two tests above against passing vacuously if the modules tree disappears.
  assert.ok(controllerFiles().length >= 15, `expected the module controllers to exist, found ${controllerFiles().length}`);
});

function buildTable() {
  const { modules } = createModules({
    appTimezone: 'Europe/Moscow',
    dbRepository: null,
    guestReserveMinimum: 5,
    pool: null,
    startedAt: '2026-01-01T00:00:00.000Z'
  });

  return { modules, table: buildRouteTable(modules) };
}

test('the modules compose without a database', () => {
  const { modules } = buildTable();

  assert.ok(modules.length >= 15);
  assert.ok(modules.every((module) => typeof module.name === 'string' && Array.isArray(module.routes)));
});

// The index served at `GET /` is part of the HTTP contract and is pinned by a golden
// snapshot. Asserting it here too means a route table reordered during a refactor fails in
// `npm test`, before anyone needs a Postgres to find out.
test('the composed route tables reproduce the published endpoint index, in order', () => {
  const { table } = buildTable();

  assert.deepEqual(table.endpoints, [
    '/health',
    '/health/db',
    '/auth/bootstrap-status',
    '/admin/users',
    '/admin/employees',
    '/admin/employees/update',
    '/admin/employees/disable',
    '/admin/employees/:id/history',
    '/admin/places',
    '/admin/places/update',
    '/admin/places/:id/history',
    '/admin/place-lines',
    '/admin/place-lines/archive',
    '/admin/permanent-assignments',
    '/admin/permanent-assignments/end',
    '/admin/audit-logs',
    '/admin/contact-access-logs',
    '/admin/line-groups',
    '/admin/line-occupancy',
    '/admin/line-groups/:id/occupancy',
    '/bot/line/position',
    '/bot/line/blocking-contacts',
    '/bot/departure-plans',
    '/admin/departure-plans',
    '/admin/conflicts',
    '/admin/map-diagnostics',
    '/admin/map-backgrounds',
    '/admin/dashboard',
    '/admin/availability',
    '/admin/place-releases',
    '/admin/place-releases/cancel',
    '/admin/employee-parking-requests',
    '/admin/guest-parking-requests',
    '/admin/guest-parking-requests/assign',
    '/admin/jobs/process-queue',
    '/admin/jobs/freeze-next-day',
    '/admin/jobs/lock-departure-plans',
    '/admin/jobs/unlock-employee-pool',
    '/admin/jobs/rebuild-conflicts',
    '/admin/jobs/runs',
    '/admin/reservations/manual',
    '/admin/reservations/cancel'
  ]);
});

// Every route the pre-split router dispatched, with the method it answered and whether it
// used the catch-all dispatcher. Unlisted-but-registered routes are caught by the count.
test('every route the monolith served is still registered, with the same method', () => {
  const { table } = buildTable();
  const registered = [...table.exactRoutes.keys()].sort();

  const expected = [
    'GET /admin/audit-logs',
    'GET /admin/availability',
    'GET /admin/conflicts',
    'GET /admin/contact-access-logs',
    'GET /admin/dashboard',
    'GET /admin/departure-plans',
    'GET /admin/employee-parking-requests',
    'GET /admin/employees',
    'GET /admin/guest-parking-requests',
    'GET /admin/jobs/runs',
    'GET /admin/line-groups',
    'GET /admin/line-occupancy',
    'GET /admin/map-diagnostics',
    'GET /admin/permanent-assignments',
    'GET /admin/place-lines',
    'GET /admin/place-releases',
    'GET /admin/places',
    'GET /admin/users',
    'GET /auth/bootstrap-status',
    'GET /bot/line/blocking-contacts',
    'GET /health',
    'GET /health/db',
    'POST /admin/departure-plans',
    'POST /admin/employee-parking-requests',
    'POST /admin/employee-parking-requests/cancel',
    'POST /admin/employees',
    'POST /admin/employees/disable',
    'POST /admin/employees/update',
    'POST /admin/guest-parking-requests',
    'POST /admin/guest-parking-requests/assign',
    'POST /admin/guest-parking-requests/cancel',
    'POST /admin/jobs/freeze-next-day',
    'POST /admin/jobs/lock-departure-plans',
    'POST /admin/jobs/process-queue',
    'POST /admin/jobs/rebuild-conflicts',
    'POST /admin/jobs/unlock-employee-pool',
    'POST /admin/line-occupancy',
    'POST /admin/map-backgrounds',
    'POST /admin/permanent-assignments',
    'POST /admin/permanent-assignments/end',
    'POST /admin/place-lines',
    'POST /admin/place-lines/archive',
    'POST /admin/place-releases',
    'POST /admin/place-releases/cancel',
    'POST /admin/places/update',
    'POST /admin/reservations/cancel',
    'POST /admin/reservations/manual',
    'POST /bot/departure-plans',
    'POST /bot/line-occupancy',
    'POST /bot/line/position'
  ];

  assert.deepEqual(registered, expected);
});

test('the two history journals are still pattern routes', () => {
  const { table } = buildTable();
  const patterns = table.patternRoutes.map((route) => `${route.method} ${route.pattern.source}`).sort();

  assert.deepEqual(patterns, [
    'GET ^\\/admin\\/employees\\/([^/]+)\\/history$',
    'GET ^\\/admin\\/line-groups\\/([^/]+)\\/occupancy$',
    'GET ^\\/admin\\/places\\/([^/]+)\\/history$'
  ]);
});
