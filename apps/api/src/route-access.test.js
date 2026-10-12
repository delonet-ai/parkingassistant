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

// The five writes the scheduler posts to, and nothing else. A token resolves nobody, so every
// route that carries this flag hands work to an unattended caller — which is why the set is
// enumerated here and not left to review. `GET /admin/jobs/runs` is a read for the operator's
// screen and stays session-only.
const EXPECTED_SERVICE_ROUTES = [
  'POST /admin/jobs/freeze-next-day',
  'POST /admin/jobs/lock-departure-plans',
  'POST /admin/jobs/process-queue',
  'POST /admin/jobs/rebuild-conflicts',
  'POST /admin/jobs/unlock-employee-pool'
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

  it('accepts the service token on exactly the five scheduler routes', () => {
    const serviceRoutes = allRoutes()
      .filter((entry) => entry.route.service === true)
      .map((entry) => entry.key)
      .sort();

    assert.deepEqual(
      serviceRoutes,
      EXPECTED_SERVICE_ROUTES,
      'a route started (or stopped) accepting the service token: say so here on purpose'
    );
  });

  it('declares no service route public or role-scoped, both of which would be contradictions', () => {
    // Public would make the token pointless; a role is a property of a person, and the token
    // resolves nobody, so a role-scoped service route could only ever refuse the scheduler.
    const contradictory = allRoutes()
      .filter(
        (entry) =>
          entry.route.service === true &&
          (entry.route.public === true || (Array.isArray(entry.route.roles) && entry.route.roles.length))
      )
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
  // concrete path — it has to be built back from the pattern. Doing that by hand cost a hole:
  // the list used to name the two history journals literally, and
  // `GET /admin/line-groups/:id/occupancy` was added later and never probed anonymously.
  // Deriving the path means a pattern route registered tomorrow is probed the day it appears.
  //
  // The uuid never reaches a query: the guard answers before the handler parses it.
  const PROBE_ID = '00000000-0000-0000-0000-000000000000';

  function probePathFor(pattern) {
    const literal = pattern.source
      .replace(/^\^/, '')
      .replace(/\$$/, '')
      .replace(/\(\[\^\/\]\+\)/g, PROBE_ID)
      .replace(/\\\//g, '/');

    assert.ok(
      literal.startsWith('/') && !/[()[\]\\?*+|]/.test(literal),
      `cannot build a concrete path from ${pattern} — teach probePathFor the new syntax`
    );

    return literal;
  }

  const closedPatternRoutes = table.patternRoutes.filter((route) => route.public !== true);

  // The enumeration is the claim: these probes *are* the table's closed routes, exact and
  // pattern alike, mapped one to one. Nothing filters, so nothing can be dropped — which is
  // why the coverage below needs no assertion of its own, only the floor that catches a table
  // that stopped composing.
  const anonymousProbes = [
    ...[...table.exactRoutes.entries()]
      .filter(([, route]) => route.public !== true)
      .map(([key]) => key.split(' ')),
    ...closedPatternRoutes.map((route) => [route.method, probePathFor(route.pattern)])
  ];

  it('has a closed route to probe for every context', () => {
    // Guards the loop below against passing vacuously if the table stops composing.
    assert.ok(anonymousProbes.length >= 45, `expected the closed routes to be enumerated, got ${anonymousProbes.length}`);
  });

  // Each derived path has to actually reach the route it was derived from; a pattern whose
  // probe fell through to another route (or to the 404 branch) would assert nothing.
  it('derives a probe path that matches the pattern it came from', () => {
    assert.ok(closedPatternRoutes.length >= 3, 'the three journals and the occupancy read');

    for (const route of closedPatternRoutes) {
      const pathname = probePathFor(route.pattern);

      assert.match(pathname, route.pattern, `${pathname} does not match ${route.pattern}`);
      assert.equal(
        table.exactRoutes.has(`${route.method} ${pathname}`),
        false,
        `${pathname} collides with an exact route, so the probe would not reach the pattern`
      );
    }
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

// The token against the real composed table. The suite above pins which routes carry the flag;
// this one pins what the flag does where it is set and, more importantly, what it does not do
// anywhere else — a header the scheduler sends on every request must not become a second way
// into the rest of the API.
describe('service token over the real table', () => {
  const { modules } = buildModules();
  const table = buildRouteTable(modules);
  const SERVICE_TOKEN = 'f'.repeat(64);

  let server = null;

  function start() {
    if (server) {
      return Promise.resolve(server);
    }

    server = http.createServer(
      createApiRouter({ modules, sendJson, resolveSession: async () => null, serviceToken: SERVICE_TOKEN })
    );

    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  after(() => new Promise((resolve) => (server ? server.close(resolve) : resolve())));

  async function call(method, pathname, headers = {}) {
    await start();
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers,
      body: method === 'POST' ? '{}' : undefined
    });

    return { status: response.status, payload: await response.json() };
  }

  for (const key of EXPECTED_SERVICE_ROUTES) {
    const [method, pathname] = key.split(' ');

    it(`${key} lets the token past the guard`, async () => {
      const { status } = await call(method, pathname, { 'x-service-token': SERVICE_TOKEN });

      // Not 200: there is no pool here, so the handler fails on the first query and the
      // dispatcher answers 500. What matters is that access control did not answer.
      assert.notEqual(status, 401, `${key} refused the configured service token`);
      assert.notEqual(status, 403);
    });

    it(`${key} still refuses a wrong token`, async () => {
      const { status, payload } = await call(method, pathname, { 'x-service-token': 'wrong' });

      assert.equal(status, 401);
      assert.equal(payload.code, 'unauthorized');
    });
  }

  // Derived from the table, like the anonymous probes above: a route added tomorrow is probed
  // with the token the day it appears, instead of waiting for someone to extend a list.
  const nonServiceProbes = [...table.exactRoutes.entries()]
    .filter(([, route]) => route.public !== true && route.service !== true)
    .map(([key]) => key.split(' '));

  it('has a closed non-service route to probe', () => {
    assert.ok(nonServiceProbes.length >= 40, `expected the closed routes to be enumerated, got ${nonServiceProbes.length}`);
  });

  for (const [method, pathname] of nonServiceProbes) {
    it(`${method} ${pathname} refuses the service token`, async () => {
      const { status } = await call(method, pathname, { 'x-service-token': SERVICE_TOKEN });

      assert.equal(status, 401, `${method} ${pathname} accepted the service token`);
    });
  }
});
