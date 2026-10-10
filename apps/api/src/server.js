'use strict';

const http = require('node:http');
const { Pool } = require('pg');
const { registerDateTypeParser } = require('../../../packages/db/date-type');
const { normalizeApiErrorPayload } = require('../../../packages/shared/errors');
const { sendJson: writeJson } = require('../../../packages/shared/http');
const { createModules } = require('./modules');
const { createDbRepository } = require('./repositories/db');
const { createApiRouter } = require('./router');

// Bootstrap only: read the environment, open the pool, build the modules, listen, shut down.
// Every handler lives in apps/api/src/modules/<context>/controller.js and every query in the
// matching repository.js — see docs/adr/003-modular-architecture.md.

// Before the first query: a `date` column has to reach a handler as `YYYY-MM-DD`, not as a
// `Date` at local midnight that serializes to the previous day under `TZ=Europe/Moscow`.
registerDateTypeParser();

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const databaseUrl = process.env.DATABASE_URL;
const appTimezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
const guestReserveMinimum = Number(process.env.GUEST_RESERVE_MINIMUM || 5);

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl
    })
  : null;

const dbRepository = createDbRepository(pool);

function sendJson(res, statusCode, payload) {
  writeJson(res, statusCode, normalizeApiErrorPayload(payload, statusCode));
}

const { modules, services } = createModules({
  appTimezone,
  dbRepository,
  guestReserveMinimum,
  pool,
  startedAt
});

// The guard's session lookup is the auth context's `resolveSession`; the router reads the
// cookie and never learns how a session is stored.
const server = http.createServer(
  createApiRouter({ modules, sendJson, resolveSession: services.auth.resolveSession })
);

server.listen(port, '0.0.0.0', () => {
  // The bound port, not the requested one: PORT=0 lets the OS pick, and the test
  // harness reads this line to learn which port it got.
  console.log(`parkingassistant api listening on port ${server.address().port}`);
});

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);

  server.close(async () => {
    if (pool) {
      await pool.end();
    }

    process.exit(0);
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
