'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, describe, it } = require('node:test');

const { normalizeApiErrorPayload } = require('../../../packages/shared/errors');
const { sendJson: writeJson } = require('../../../packages/shared/http');
const { createModules } = require('./modules');
const { buildRouteTable, createApiRouter } = require('./router');

// Deny by default, asserted rather than reviewed.
//
// The router closes a route unless its table entry says `public: true`. That makes the right
// thing the default, but it does not stop someone from writing `public: true` on a route that
// should be closed — and a plan that adds routes in Tasks 5, 7 and 8 is exactly when that
// happens. So this file enumerates the *composed* table and pins two things:
//
//   - the set of public routes, exhaustively. A new public route fails here and has to be
//     added to the list deliberately, in a diff a reviewer sees.
//   - that every other registered route, driven through a real router with a session store
//     that resolves nobody, answers 401. Not "is marked closed" — answers 401, which is the
//     property an operator can actually observe.
//
// The second is why this is an HTTP test and not a property of the table: a route could be
// unmarked and still be reachable if the guard had a hole for, say, pattern routes.

// `/health` and `/health/db` answer before anyone can sign in (the container probes them),
// `/auth/bootstrap-status` is what the login screen reads to choose between "sign in" and
// "set the first password", and the four `/auth/*` routes are the ones that establish a
// session — requiring one would close the only door in. Nothing else belongs here.
const EXPECTED_PUBLIC_ROUTES = [
  'GET /auth/bootstrap-status',
  'GET /auth/me',
  'GET /health',
  'GET /health/db',
  'POST /auth/activate',
  'POST /auth/login',
  'POST /auth/logout'
];

// Account management, not parking. Every other `/admin/*` route accepts either seeded role.
// The five writes are Task 5's; a `parking_admin` runs the day and may not touch accounts.
const EXPECTED_ROLE_SCOPED_ROUTES = [
  ['GET /admin/users', ['system_admin']],
  ['POST /admin/users', ['system_admin']],
  ['POST /admin/users/disable', ['system_admin']],
  ['POST /admin/users/enable', ['system_admin']],
  ['POST /admin/users/password', ['system_admin']],
  ['POST /admin/users/roles', ['system_admin']]
];

function sendJson(res, statusCode, payload) {
  writeJson(res, statusCode, normalizeApiErrorPayload(payload, statusCode));
}

function buildModules() {
  return createModules({
    appTimezone: 'Europe/Moscow',
    dbRepository: null,
    guestReserveMinimum: 5,
    pool: null,
    startedAt: '2026-01-01T00:00:00.000Z'
  });
}

function allRoutes() {
  const { modules } = buildModules();
  const routes = [];

  for (const module of modules) {
    for (const route of module.routes) {
      const paths = route.pattern
        ? [route.pattern.source]
        : [].concat(route.path || route.paths);

      for (const path of paths) {
        routes.push({ key: `${route.method} ${path}`, module: module.name, route });
      }
    }
  }

  return routes;
}

describe('route access control', () => {
  it('marks exactly the expected routes public — nothing else may default to open', () => {
    const publicRoutes = allRoutes()
      .filter((entry) => entry.route.public === true)
      .map((entry) => entry.key)
      .sort();

    assert.deepEqual(
      publicRoutes,
      EXPECTED_PUBLIC_ROUTES,
      'a route became public (or stopped being): say so here on purpose, or drop the flag'
    );
  });

  it('scopes exactly the expected routes to a role', () => {
    const scoped = allRoutes()
      .filter((entry) => Array.isArray(entry.route.roles) && entry.route.roles.length > 0)
      .map((entry) => [entry.key, [...entry.route.roles].sort()])
      .sort((left, right) => left[0].localeCompare(right[0]));

    assert.deepEqual(scoped, EXPECTED_ROLE_SCOPED_ROUTES);
  });

  it('declares no route both public and role-scoped, which would be a contradiction', () => {
    const contradictory = allRoutes()
      .filter((entry) => entry.route.public === true && Array.isArray(entry.route.roles) && entry.route.roles.length)
      .map((entry) => entry.key);

    assert.deepEqual(contradictory, []);
  });

  it('guards every /admin and /bot route — none of them is public', () => {
    const open = allRoutes()
      .filter((entry) => entry.route.public === true)
      .map((entry) => entry.key)
      .filter((key) => / \/(admin|bot)/.test(key));

    assert.deepEqual(open, []);
  });
});

// Driving the real table through the real router, with a session store that resolves nobody.
// A closed route must answer 401 here; a `public: true` route must answer something else,
// which proves the list above is describing reachability and not just a flag.
describe('route access control over HTTP', () => {
  const { modules } = buildModules();
  const table = buildRouteTable(modules);

  let server = null;

  function start() {
    if (server) {
      return Promise.resolve(server);
    }

    // The same `sendJson` as src/server.js: a handler that builds a refusal by hand relies on
    // the normalizer for `code` and `details`, so a harness that skipped it would record a
    // payload shape production never emits.
    server = http.createServer(
      createApiRouter({ modules, sendJson, resolveSession: async () => null })
    );

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  async function call(method, pathname) {
    await start();
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json' } : {},
      body: method === 'POST' ? '{}' : undefined
    });

    return { status: response.status, payload: await response.json() };
  }

  // Pattern routes are registered as a regular expression, so the table cannot be asked for a
  // concrete path. These are the two history journals; the uuid never reaches a query because
  // the guard answers first.
  const PATTERN_PROBES = [
    ['GET', '/admin/employees/00000000-0000-0000-0000-000000000000/history'],
    ['GET', '/admin/places/00000000-0000-0000-0000-000000000000/history']
  ];

  const anonymousProbes = [
    ...[...table.exactRoutes.entries()]
      .filter(([, route]) => route.public !== true)
      .map(([key]) => key.split(' ')),
    ...PATTERN_PROBES
  ];

  it('has a closed route to probe for every context', () => {
    // Guards the loop below against passing vacuously if the table stops composing.
    assert.ok(anonymousProbes.length >= 45, `expected the closed routes to be enumerated, got ${anonymousProbes.length}`);
  });

  for (const [method, pathname] of anonymousProbes) {
    it(`${method} ${pathname} answers 401 without a session`, async () => {
      const { status, payload } = await call(method, pathname);

      assert.equal(status, 401, `${method} ${pathname} answered ${status} anonymously`);
      assert.equal(payload.code, 'unauthorized');
      assert.equal(payload.error, 'Authentication required');
    });
  }

  // `/auth/me` is the one public route that answers 401 on its own: it exists to report who
  // the caller is, and "nobody" is a 401 by Task 2's design — which is what the UI's boot
  // reads to decide between the day and the login screen. The guard is not what answered;
  // that a public route never consults the session store at all is asserted in router.test.js.
  const PUBLIC_ROUTES_ANSWERING_401 = new Set(['GET /auth/me']);

  for (const key of EXPECTED_PUBLIC_ROUTES) {
    const [method, pathname] = key.split(' ');

    it(`${key} is reachable without a session`, async () => {
      const { status } = await call(method, pathname);

      // Not 200: `/health/db` has no pool here and `/auth/login` has no credentials worth
      // accepting. What matters is that access control did not answer.
      if (!PUBLIC_ROUTES_ANSWERING_401.has(key)) {
        assert.notEqual(status, 401, `${key} is listed public but answered 401`);
      }

      assert.notEqual(status, 403, `${key} is listed public but answered 403`);
    });
  }

  it('answers GET /auth/me with 401 for a caller holding no session, from the handler', async () => {
    const { status, payload } = await call('GET', '/auth/me');

    assert.equal(status, 401);
    assert.equal(payload.code, 'unauthorized');
  });

  it('answers the derived endpoint index at GET / without a session', async () => {
    const { status, payload } = await call('GET', '/');

    assert.equal(status, 200);
    assert.ok(Array.isArray(payload.endpoints));
  });

  it('still answers 404 for an unrouted path rather than 401', async () => {
    const { status, payload } = await call('GET', '/nope');

    assert.equal(status, 404);
    assert.equal(payload.code, 'not_found');
  });
});
