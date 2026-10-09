'use strict';

// Integration tests for the auth context: first-run activation (Task 1).
//
// Activation is the only way the bootstrap `sysadmin` gets a real password, and it must stop
// working the moment it has been used once. Each test builds its own scratch database, because
// the rule under test is about the whole `auth_users` table, not about one row.

const assert = require('node:assert/strict');
const { afterEach, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { postJson } = require('../testing/fixtures');
const { verifyPassword } = require('../../../packages/shared/passwords');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

const GOOD_PASSWORD = 'first-run-password';

describe('auth activation (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  async function boot() {
    db = await createTestDatabase();
    api = await startApi({ databaseUrl: db.connectionString });
  }

  afterEach(async () => {
    if (api) {
      await api.stop();
      api = null;
    }
    if (db) {
      await db.drop();
      db = null;
    }
  });

  async function sysadminRow() {
    const result = await db.query(
      `select id, password_hash, status from auth_users where lower(login) = 'sysadmin'`
    );
    return result.rows[0];
  }

  async function activationAuditRows() {
    const result = await db.query(
      `
        select entity_id, actor_auth_user_id, actor_service, metadata
        from audit_logs
        where entity_type = 'auth_user' and action = 'auth_user_activated'
      `
    );
    return result.rows;
  }

  it('activates the bootstrap user, stores a real hash and writes an audit row', async () => {
    await boot();
    const before = await sysadminRow();
    assert.equal(before.status, 'invited');

    const { status, payload } = await postJson(api.baseUrl, '/auth/activate', {
      login: 'sysadmin',
      password: GOOD_PASSWORD
    });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.user.login, 'sysadmin');
    assert.equal(payload.user.authStatus, 'active');
    assert.equal(payload.user.id, before.id);
    assert.equal(JSON.stringify(payload).includes('scrypt$'), false, 'the hash must not leave the API');

    const after = await sysadminRow();
    assert.equal(after.status, 'active');
    assert.match(after.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await verifyPassword(GOOD_PASSWORD, after.password_hash), true);

    const audit = await activationAuditRows();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, before.id);
    assert.equal(audit[0].actor_auth_user_id, before.id);
    assert.equal(audit[0].actor_service, 'admin-ui');
    assert.deepEqual(audit[0].metadata, { login: 'sysadmin' });
  });

  it('matches the login case-insensitively, as the unique index does', async () => {
    await boot();

    const { status } = await postJson(api.baseUrl, '/auth/activate', {
      login: 'SysAdmin',
      password: GOOD_PASSWORD
    });

    assert.equal(status, 200);
    assert.equal((await sysadminRow()).status, 'active');
  });

  it('refuses a second activation with 409 and keeps the first password', async () => {
    await boot();
    await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: GOOD_PASSWORD });
    const firstHash = (await sysadminRow()).password_hash;

    const { status, payload } = await postJson(api.baseUrl, '/auth/activate', {
      login: 'sysadmin',
      password: 'someone-elses-password'
    });

    assert.equal(status, 409);
    assert.equal(payload.status, 'error');
    assert.equal(payload.code, 'conflict');
    assert.equal((await sysadminRow()).password_hash, firstHash);
    assert.equal((await activationAuditRows()).length, 1);
  });

  it('lets only one of two concurrent activations through', async () => {
    await boot();

    const results = await Promise.all([
      postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: 'racer-one-password' }),
      postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: 'racer-two-password' })
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    assert.equal((await activationAuditRows()).length, 1);
  });

  it('refuses a password shorter than 10 characters with 400 and changes nothing', async () => {
    await boot();

    const { status, payload } = await postJson(api.baseUrl, '/auth/activate', {
      login: 'sysadmin',
      password: '123456789'
    });

    assert.equal(status, 400);
    assert.equal(payload.code, 'bad_request');
    assert.match(payload.error, /10 characters/);
    assert.equal((await sysadminRow()).status, 'invited');
  });

  it('refuses a missing login, a missing password and a non-JSON body with 400', async () => {
    await boot();

    assert.equal((await postJson(api.baseUrl, '/auth/activate', { password: GOOD_PASSWORD })).status, 400);
    assert.equal((await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin' })).status, 400);
    assert.equal(
      (await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: 1234567890123 })).status,
      400
    );

    const response = await fetch(`${api.baseUrl}/auth/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json'
    });
    assert.equal(response.status, 400);
    assert.equal((await sysadminRow()).status, 'invited');
  });

  it('answers an unknown login with the same 409 as a wrong state, so logins cannot be enumerated', async () => {
    await boot();

    const unknown = await postJson(api.baseUrl, '/auth/activate', { login: 'nobody', password: GOOD_PASSWORD });
    assert.equal(unknown.status, 409);
    assert.equal((await sysadminRow()).status, 'invited');

    await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: GOOD_PASSWORD });
    const repeated = await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: GOOD_PASSWORD });

    assert.equal(repeated.status, 409);
    assert.deepEqual(unknown.payload, repeated.payload);
  });

  it('refuses activation once a second auth user exists, even for the invited bootstrap user', async () => {
    await boot();
    await db.query(
      `
        insert into auth_users (login, password_hash, display_name, status)
        values ('operator', '{PENDING_IMPLEMENTATION}', 'Operator', 'invited')
      `
    );

    const { status } = await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: GOOD_PASSWORD });

    assert.equal(status, 409);
    assert.equal((await sysadminRow()).status, 'invited');
    assert.equal((await activationAuditRows()).length, 0);
  });

  it('refuses activation of a sole user that is not invited', async () => {
    await boot();
    await db.query(`update auth_users set status = 'disabled' where lower(login) = 'sysadmin'`);

    const { status } = await postJson(api.baseUrl, '/auth/activate', { login: 'sysadmin', password: GOOD_PASSWORD });

    assert.equal(status, 409);
    assert.equal((await sysadminRow()).status, 'disabled');
  });
});
