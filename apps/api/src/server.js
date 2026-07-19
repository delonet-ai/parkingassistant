'use strict';

const http = require('node:http');
const { Pool } = require('pg');
const { normalizeApiErrorPayload } = require('../../../packages/shared/errors');
const { sendJson: writeJson } = require('../../../packages/shared/http');
const { createModules } = require('./modules');
const { createDbRepository } = require('./repositories/db');
const { createApiRouter } = require('./router');

// Bootstrap only: read the environment, open the pool, build the modules, listen, shut down.
// Every handler lives in apps/api/src/modules/<context>/controller.js and every query in the
// matching repository.js — see docs/adr/003-modular-architecture.md.

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

const { modules } = createModules({
  appTimezone,
  dbRepository,
  guestReserveMinimum,
  pool,
  startedAt
});

const server = http.createServer(createApiRouter({ modules, sendJson }));

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant api listening on port ${port}`);
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
