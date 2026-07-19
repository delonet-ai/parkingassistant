'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { after, describe, it } = require('node:test');

const { sendJson: writeJson } = require('../../../packages/shared/http');
const { createApiRouter } = require('./router');

// A handler that throws used to be fatal. Routes carried a `safe` flag, and only the ones
// marked with it were dispatched inside a try/catch; on every write endpoint a rejection
// escaped the request listener, became an unhandled rejection, and took the process down
// under Node's default. A malformed uuid in a POST body was enough to trigger it, so this
// was a remote DoS rather than a tidiness problem. The router now catches every route.
function startServer(routes) {
  const modules = [{ name: 'test', routes }];
  const server = http.createServer(createApiRouter({ modules, sendJson: writeJson }));

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

  async function withRoutes(routes) {
    const started = await startServer(routes);
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
