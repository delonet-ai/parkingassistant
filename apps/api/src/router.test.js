'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, describe, it } = require('node:test');

const { sendJson: writeJson } = require('../../../packages/shared/http');
const { createApiRouter } = require('./router');

// Every route the error-handling cases below register is `public: true`: they are about what
// the router does with a handler's result, and a guard refusal would answer before the handler
// ran. The guard itself has its own describe block at the bottom.
const SESSION = {
  session: { id: 'session-1', expiresAt: '2026-01-02T00:00:00.000Z' },
  authUser: { id: 'user-1', login: 'operator', displayName: 'Operator', status: 'active' },
  roles: ['parking_admin']
};

// A handler that throws used to be fatal. Routes carried a `safe` flag, and only the ones
// marked with it were dispatched inside a try/catch; on every write endpoint a rejection
// escaped the request listener, became an unhandled rejection, and took the process down
// under Node's default. A malformed uuid in a POST body was enough to trigger it, so this
// was a remote DoS rather than a tidiness problem. The router now catches every route.
function startServer(routes, { resolveSession = async () => SESSION, serviceToken } = {}) {
  const modules = [{ name: 'test', routes }];
  const server = http.createServer(createApiRouter({ modules, sendJson: writeJson, resolveSession, serviceToken }));

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        url: (path) => `http://127.0.0.1:${server.address().port}${path}`
      });
    });
  });
}

describe('createApiRouter error handling', () => {
  const servers = [];

  after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

  async function withRoutes(routes, options) {
    const started = await startServer(
      routes.map((route) => ({ public: true, ...route })),
      options
    );
    servers.push(started.server);
    return started;
  }

  it('answers 500 instead of crashing when a POST handler throws', async () => {
    const rejections = [];
    const onRejection = (error) => rejections.push(error);
    process.on('unhandledRejection', onRejection);

    const { url } = await withRoutes([
      {
        method: 'POST',
        path: '/boom',
        handler: async () => {
          throw new Error('invalid input syntax for type uuid: "not-a-uuid"');
        }
      }
    ]);

    try {
      const response = await fetch(url('/boom'), { method: 'POST' });
      const body = await response.json();

      assert.equal(response.status, 500);
      assert.equal(body.status, 'error');
      assert.equal(body.service, 'api');
      assert.equal(body.code, 'internal_error');

      // The driver message quotes the input that caused it. It belongs in the log.
      assert.equal(body.error, 'Internal server error');

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('answers 500 when a GET handler throws', async () => {
    const { url } = await withRoutes([
      {
        method: 'GET',
        path: '/read',
        handler: async () => {
          throw new Error('relation "parking_places" does not exist');
        }
      }
    ]);

    const response = await fetch(url('/read'));
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Internal server error');
    assert.ok(!body.error.includes('parking_places'));
  });

  it('carries service and code on the 404 fallback, matching handler-built payloads', async () => {
    const { url } = await withRoutes([]);
    const response = await fetch(url('/nope'));
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.deepEqual(body, {
      status: 'error',
      service: 'api',
      error: 'Not found',
      code: 'not_found',
      details: null
    });
  });

  it('still returns a handler payload untouched when nothing throws', async () => {
    const { url } = await withRoutes([
      {
        method: 'GET',
        path: '/fine',
        handler: async () => ({ statusCode: 201, payload: { status: 'ok', service: 'api' } })
      }
    ]);

    const response = await fetch(url('/fine'));

    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { status: 'ok', service: 'api' });
  });

  // The session cookie is the first thing a handler needs to put in a header rather than in
  // the body, and `writeHead` would have dropped it had `sendJson` been left to win.
  it('sends the headers a handler returns alongside the payload', async () => {
    const { url } = await withRoutes([
      {
        method: 'POST',
        path: '/with-cookie',
        handler: async () => ({
          statusCode: 200,
          headers: { 'set-cookie': 'pa_session=token; Path=/; HttpOnly' },
          payload: { status: 'ok' }
        })
      }
    ]);

    const response = await fetch(url('/with-cookie'), { method: 'POST' });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie'), 'pa_session=token; Path=/; HttpOnly');
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok' });
  });

  // The second crash vector, and the cheaper one: no route, body or method had to be valid.
  // `Host` is client-controlled and used to be interpolated into the URL base, so a header
  // `new URL` could not parse threw before dispatch and escaped the request listener.
  it('routes normally despite a malformed Host header', async () => {
    const rejections = [];
    const onRejection = (error) => rejections.push(error);
    process.on('unhandledRejection', onRejection);

    const { server } = await withRoutes([
      {
        method: 'GET',
        path: '/health',
        handler: async () => ({ statusCode: 200, payload: { status: 'ok' } })
      }
    ]);

    try {
      const net = require('node:net');
      const { port } = server.address();

      const firstLine = await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write('GET /health HTTP/1.1\r\nHost: ]bad host[\r\n\r\n');
        });

        let received = '';
        socket.on('data', (chunk) => {
          received += chunk;
          if (received.includes('\r\n\r\n')) {
            socket.end();
          }
        });
        socket.on('close', () => resolve(received.split('\r\n')[0]));
        socket.on('error', reject);
      });

      assert.match(firstLine, /^HTTP\/1\.1 200 /);

      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(rejections, []);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('answers 400 for a request target that is not parseable as a URL', async () => {
    const { server } = await withRoutes([]);
    const net = require('node:net');
    const { port } = server.address();

    const firstLine = await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('GET //[ HTTP/1.1\r\nHost: api.local\r\n\r\n');
      });

      let received = '';
      socket.on('data', (chunk) => {
        received += chunk;
        if (received.includes('\r\n\r\n')) {
          socket.end();
        }
      });
      socket.on('close', () => resolve(received.split('\r\n')[0]));
      socket.on('error', reject);
    });

    assert.match(firstLine, /^HTTP\/1\.1 400 /);
  });

  it('registers no route carrying the removed `safe` flag', () => {
    const controllers = require('node:fs')
      .readdirSync(`${__dirname}/modules`, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${__dirname}/modules/${entry.name}/controller.js`)
      .filter((path) => require('node:fs').existsSync(path));

    assert.ok(controllers.length > 0, 'expected to find controllers');

    for (const path of controllers) {
      assert.ok(
        !require('node:fs').readFileSync(path, 'utf8').includes('safe:'),
        `${path} still carries a \`safe\` route flag, which the router no longer reads`
      );
    }
  });
});

// The guard (Task 3). What is asserted here is the router's half of it: a closed route needs
// a session, a role-scoped route needs the role, and a public one needs neither. Which routes
// are closed is asserted over the real composed table in route-access.test.js.
describe('createApiRouter access control', () => {
  const servers = [];

  after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

  async function withRoutes(routes, options) {
    const started = await startServer(routes, options);
    servers.push(started.server);
    return started;
  }

  const okHandler = async () => ({ statusCode: 200, payload: { status: 'ok', service: 'api' } });

  it('refuses a route with no `public` flag when no session resolves', async () => {
    const { url } = await withRoutes([{ method: 'GET', path: '/admin/thing', handler: okHandler }], {
      resolveSession: async () => null
    });

    const response = await fetch(url('/admin/thing'));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      status: 'error',
      service: 'api',
      error: 'Authentication required',
      code: 'unauthorized',
      details: null
    });
  });

  it('serves a public route without consulting the session store at all', async () => {
    let resolveCalls = 0;

    const { url } = await withRoutes([{ method: 'GET', path: '/health', public: true, handler: okHandler }], {
      resolveSession: async () => {
        resolveCalls += 1;
        return null;
      }
    });

    const response = await fetch(url('/health'));

    assert.equal(response.status, 200);
    // `/health` has to answer while the database is down, which it cannot do if resolving a
    // session — a query — happens first.
    assert.equal(resolveCalls, 0);
  });

  it('hands the resolved operator and roles to the handler', async () => {
    let seen = null;

    const { url } = await withRoutes([
      {
        method: 'GET',
        path: '/admin/thing',
        handler: async (context) => {
          seen = { authUser: context.authUser, roles: context.roles, session: context.session };
          return okHandler();
        }
      }
    ]);

    assert.equal((await fetch(url('/admin/thing'))).status, 200);
    assert.deepEqual(seen, { authUser: SESSION.authUser, roles: SESSION.roles, session: SESSION.session });
  });

  it('passes a role-scoped route when the session holds one of the required roles', async () => {
    const { url } = await withRoutes(
      [{ method: 'GET', path: '/admin/users', roles: ['system_admin'], handler: okHandler }],
      { resolveSession: async () => ({ ...SESSION, roles: ['parking_admin', 'system_admin'] }) }
    );

    assert.equal((await fetch(url('/admin/users'))).status, 200);
  });

  // 403 and not 404: an operator who is signed in but holds the wrong role has to be told
  // that the route exists and is not theirs, or they report a broken screen instead of a
  // missing role.
  it('answers 403, not 404, when the session lacks the required role', async () => {
    const { url } = await withRoutes([
      { method: 'GET', path: '/admin/users', roles: ['system_admin'], handler: okHandler }
    ]);

    const response = await fetch(url('/admin/users'));

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      status: 'error',
      service: 'api',
      error: 'Your role does not allow this action',
      code: 'forbidden',
      details: null
    });
  });

  it('refuses before the handler runs, so a closed route cannot do work anonymously', async () => {
    let handlerCalls = 0;

    const { url } = await withRoutes(
      [
        {
          method: 'POST',
          path: '/admin/write',
          handler: async () => {
            handlerCalls += 1;
            return okHandler();
          }
        }
      ],
      { resolveSession: async () => null }
    );

    assert.equal((await fetch(url('/admin/write'), { method: 'POST' })).status, 401);
    assert.equal(handlerCalls, 0);
  });

  it('answers 500 without leaking the driver message when session resolution throws', async () => {
    const { url } = await withRoutes([{ method: 'GET', path: '/admin/thing', handler: okHandler }], {
      resolveSession: async () => {
        throw new Error('relation "auth_sessions" does not exist');
      }
    });

    const response = await fetch(url('/admin/thing'));
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Internal server error');
  });

  // A router that cannot resolve a session could only refuse everything or allow everything,
  // and a wiring mistake would silently produce the second.
  it('refuses to be constructed without a resolveSession function', () => {
    assert.throws(() => createApiRouter({ modules: [], sendJson: writeJson }), /resolveSession/);
  });
});

// The service token (Task 12). The scheduler in `apps/jobs` has no operator, so the five job
// writes accept a shared secret in `X-Service-Token` as an alternative to a cookie. Which
// routes carry `service: true` is pinned over the real table in route-access.test.js; what is
// asserted here is the guard's behaviour, and above all the two ways it could be a hole: an
// unset token must not authenticate an absent header, and the token must not open anything
// else.
describe('createApiRouter service token', () => {
  const servers = [];

  after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));

  const TOKEN = 'a'.repeat(64);

  async function withRoutes(routes, options) {
    const started = await startServer(routes, options);
    servers.push(started.server);
    return started;
  }

  const okHandler = async () => ({ statusCode: 200, payload: { status: 'ok', service: 'api' } });

  function serviceRoute(handler = okHandler) {
    return [{ method: 'POST', path: '/admin/jobs/process-queue', service: true, handler }];
  }

  it('lets a correct token into a route that says `service: true`', async () => {
    const { url } = await withRoutes(serviceRoute(), {
      resolveSession: async () => null,
      serviceToken: TOKEN
    });

    const response = await fetch(url('/admin/jobs/process-queue'), {
      method: 'POST',
      headers: { 'x-service-token': TOKEN }
    });

    assert.equal(response.status, 200);
  });

  it('resolves nobody: the handler sees the service client and no authUser', async () => {
    let seen = null;

    const { url } = await withRoutes(
      serviceRoute(async (context) => {
        seen = {
          authUser: context.authUser,
          roles: context.roles,
          session: context.session,
          serviceClient: context.serviceClient
        };
        return okHandler();
      }),
      { resolveSession: async () => null, serviceToken: TOKEN }
    );

    await fetch(url('/admin/jobs/process-queue'), { method: 'POST', headers: { 'x-service-token': TOKEN } });

    // `jobs`, not an operator: this is what makes the audit row say `jobs` with a null
    // `actor_auth_user_id` instead of borrowing the admin UI's label.
    assert.deepEqual(seen, { authUser: null, roles: [], session: null, serviceClient: 'jobs' });
  });

  it('does not consult the session store when the token matches', async () => {
    let resolveCalls = 0;

    const { url } = await withRoutes(serviceRoute(), {
      resolveSession: async () => {
        resolveCalls += 1;
        return null;
      },
      serviceToken: TOKEN
    });

    await fetch(url('/admin/jobs/process-queue'), { method: 'POST', headers: { 'x-service-token': TOKEN } });

    assert.equal(resolveCalls, 0);
  });

  it('still accepts a session on a `service: true` route, so the operator can run a job by hand', async () => {
    const { url } = await withRoutes(serviceRoute(), { serviceToken: TOKEN });

    const response = await fetch(url('/admin/jobs/process-queue'), { method: 'POST' });

    assert.equal(response.status, 200);
  });

  // The hole this design can actually have: a deployment that forgot the variable would turn
  // every job route into a public one if an absent expectation matched an absent header.
  it('refuses every token when none is configured, including an absent header', async () => {
    const { url } = await withRoutes(serviceRoute(), { resolveSession: async () => null });

    for (const headers of [{}, { 'x-service-token': '' }, { 'x-service-token': TOKEN }]) {
      const response = await fetch(url('/admin/jobs/process-queue'), { method: 'POST', headers });

      assert.equal(response.status, 401, `headers ${JSON.stringify(headers)} were let in`);
    }
  });

  it('refuses a wrong token, of equal and of different length', async () => {
    const { url } = await withRoutes(serviceRoute(), {
      resolveSession: async () => null,
      serviceToken: TOKEN
    });

    // The short one is the case `timingSafeEqual` would throw on if the two sides were
    // compared raw instead of as digests, which the guard answers 500 to rather than 401.
    for (const presented of ['b'.repeat(64), 'short', `${TOKEN}x`]) {
      const response = await fetch(url('/admin/jobs/process-queue'), {
        method: 'POST',
        headers: { 'x-service-token': presented }
      });

      assert.equal(response.status, 401, `token ${presented} was let in`);
    }
  });

  it('refuses the token on a route that does not say `service: true`', async () => {
    const { url } = await withRoutes([{ method: 'GET', path: '/admin/jobs/runs', handler: okHandler }], {
      resolveSession: async () => null,
      serviceToken: TOKEN
    });

    const response = await fetch(url('/admin/jobs/runs'), { headers: { 'x-service-token': TOKEN } });

    assert.equal(response.status, 401);
  });

  it('refuses before the handler runs, so a wrong token cannot do work', async () => {
    let handlerCalls = 0;

    const { url } = await withRoutes(
      serviceRoute(async () => {
        handlerCalls += 1;
        return okHandler();
      }),
      { resolveSession: async () => null, serviceToken: TOKEN }
    );

    await fetch(url('/admin/jobs/process-queue'), {
      method: 'POST',
      headers: { 'x-service-token': 'wrong' }
    });

    assert.equal(handlerCalls, 0);
  });
});
