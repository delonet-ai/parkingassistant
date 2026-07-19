'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

describe('api smoke (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  before(async () => {
    db = await createTestDatabase();
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

  it('applies every schema migration and seed into the scratch schema', () => {
    assert.ok(db.appliedFiles.includes('schema/001_initial_schema.sql'));
    assert.ok(db.appliedFiles.some((file) => file.startsWith('seeds/')));
    assert.match(db.schemaName, /^itest_\d+_\d+$/);
  });

  it('answers GET /health with 200 and the service envelope', async () => {
    const response = await fetch(`${api.baseUrl}/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.service, 'api');
    assert.equal(typeof payload.startedAt, 'string');
  });

  it('answers GET /health/db with 200 against the scratch schema', async () => {
    const response = await fetch(`${api.baseUrl}/health/db`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
    assert.equal(payload.check, 'db');
    assert.equal(typeof payload.database, 'string');
  });

  it('answers the GET /admin/places read endpoint with 200 and a places array', async () => {
    const response = await fetch(`${api.baseUrl}/admin/places`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, 'ok');
    assert.ok(Array.isArray(payload.places), 'expected payload.places to be an array');
  });

  it('reads the seeded bootstrap administrator through the pool', async () => {
    const result = await db.query("select login, status from auth_users where lower(login) = 'sysadmin'");

    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].login, 'sysadmin');
  });
});
