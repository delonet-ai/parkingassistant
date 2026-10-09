'use strict';

// Integration tests for the auth context: first-run activation (Task 1) and sessions (Task 2).
//
// Activation is the only way the bootstrap `sysadmin` gets a real password, and it must stop
// working the moment it has been used once. Each test builds its own scratch database, because
// the rule under test is about the whole `auth_users` table, not about one row.

const assert = require('node:assert/strict');
const { after, afterEach, before, describe, it } = require('node:test');

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

// Sessions (Task 2): login, `/auth/me`, logout, and the four ways a session stops resolving.
//
// The suite activates the bootstrap user first, because a password is the only way in. It
// drives `fetch` directly rather than through `fixtures.js` — the cookie is the subject here,
// and two of the cases need to send one the harness would never produce.

const SESSION_COOKIE = 'pa_session';

describe('auth sessions (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  before(async () => {
    db = await createTestDatabase();
    api = await startApi({ databaseUrl: db.connectionString });

    const activated = await postJson(api.baseUrl, '/auth/activate', {
      login: 'sysadmin',
      password: GOOD_PASSWORD
    });
    assert.equal(activated.status, 200, JSON.stringify(activated.payload));
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  function readSessionCookie(response) {
    const header = response.headers.get('set-cookie');
    if (!header) {
      return null;
    }
    const match = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(header);
    return match ? decodeURIComponent(match[1]) : null;
  }

  async function post(pathname, body, cookieToken) {
    const headers = { 'content-type': 'application/json' };
    if (cookieToken) {
      headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(cookieToken)}`;
    }

    const response = await fetch(`${api.baseUrl}${pathname}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {})
    });

    return { response, status: response.status, payload: await response.json() };
  }

  async function get(pathname, cookieToken) {
    const response = await fetch(`${api.baseUrl}${pathname}`, {
      headers: cookieToken ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookieToken)}` } : {}
    });

    return { response, status: response.status, payload: await response.json() };
  }

  async function signIn(password = GOOD_PASSWORD) {
    const result = await post('/auth/login', { login: 'sysadmin', password });
    assert.equal(result.status, 200, JSON.stringify(result.payload));
    const token = readSessionCookie(result.response);
    assert.ok(token, 'login must set the session cookie');
    return { token, ...result };
  }

  async function sessionRow(token) {
    const hash = require('node:crypto').createHash('sha256').update(token, 'utf8').digest('hex');
    const result = await db.query(
      `
        select id, auth_user_id, expires_at, last_seen_at, revoked_at, ip_address, user_agent
        from auth_sessions
        where session_token_hash = $1
      `,
      [hash]
    );
    return result.rows[0] || null;
  }

  it('logs in, sets an HttpOnly session cookie and answers the user with their roles', async () => {
    const { response, payload, token } = await signIn();

    const header = response.headers.get('set-cookie');
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Lax/);
    assert.match(header, /Path=\//);
    assert.match(header, /Max-Age=43200/);
    assert.equal(/\bSecure\b/.test(header), false, 'the stand is plain HTTP — see the ADR');

    assert.equal(payload.user.login, 'sysadmin');
    assert.equal(payload.user.authStatus, 'active');
    assert.deepEqual(payload.user.roles, ['system_admin']);
    assert.equal(JSON.stringify(payload).includes(token), false, 'the token belongs in the cookie only');
    assert.equal(JSON.stringify(payload).includes('scrypt$'), false);
  });

  it('stores only the hash of the token, and bumps last_login_at', async () => {
    const { token } = await signIn();

    const stored = await db.query('select session_token_hash from auth_sessions');
    for (const row of stored.rows) {
      assert.equal(row.session_token_hash.includes(token), false, 'a dump must not hand over live sessions');
      assert.match(row.session_token_hash, /^[0-9a-f]{64}$/);
    }

    const user = await db.query(`select last_login_at from auth_users where lower(login) = 'sysadmin'`);
    assert.ok(user.rows[0].last_login_at, 'last_login_at must be set by a successful login');
  });

  it('resolves the cookie at /auth/me and bumps last_seen_at', async () => {
    const { token } = await signIn();
    const before = await sessionRow(token);
    assert.ok(before.last_seen_at);

    const me = await get('/auth/me', token);

    assert.equal(me.status, 200, JSON.stringify(me.payload));
    assert.equal(me.payload.user.login, 'sysadmin');
    assert.deepEqual(me.payload.user.roles, ['system_admin']);
    assert.equal(me.payload.expiresAt, before.expires_at.toISOString());

    const after = await sessionRow(token);
    assert.ok(after.last_seen_at >= before.last_seen_at, 'a successful resolve bumps last_seen_at');
  });

  it('answers 401 at /auth/me without a cookie, and with a tampered one', async () => {
    const anonymous = await get('/auth/me');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.payload.code, 'unauthorized');
    assert.equal(anonymous.payload.status, 'error');

    const { token } = await signIn();
    const tampered = await get('/auth/me', `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`);
    assert.equal(tampered.status, 401);
    assert.deepEqual(tampered.payload, anonymous.payload, 'a forged cookie must not be distinguishable');

    const garbage = await get('/auth/me', 'not-a-token-at-all');
    assert.equal(garbage.status, 401);
  });

  it('logs out: the session is revoked, the cookie is cleared and /auth/me is 401', async () => {
    const { token } = await signIn();
    assert.equal((await get('/auth/me', token)).status, 200);

    const loggedOut = await post('/auth/logout', {}, token);

    assert.equal(loggedOut.status, 200);
    assert.equal(loggedOut.payload.revoked, true);
    assert.match(loggedOut.response.headers.get('set-cookie'), /pa_session=;/);
    assert.match(loggedOut.response.headers.get('set-cookie'), /Max-Age=0/);

    assert.ok((await sessionRow(token)).revoked_at, 'logout must set revoked_at');
    assert.equal((await get('/auth/me', token)).status, 401);
  });

  it('logs out idempotently, including with no session at all', async () => {
    const { token } = await signIn();
    assert.equal((await post('/auth/logout', {}, token)).payload.revoked, true);

    const second = await post('/auth/logout', {}, token);
    assert.equal(second.status, 200);
    assert.equal(second.payload.revoked, false);

    const anonymous = await post('/auth/logout', {});
    assert.equal(anonymous.status, 200);
    assert.equal(anonymous.payload.revoked, false);
  });

  it('stops resolving a session past its expires_at', async () => {
    const { token } = await signIn();
    await db.query(
      `update auth_sessions set expires_at = now() - interval '1 second' where id = $1`,
      [(await sessionRow(token)).id]
    );

    const expired = await get('/auth/me', token);

    assert.equal(expired.status, 401);
    assert.equal(expired.payload.code, 'unauthorized');
  });

  it('stops resolving a session whose user has been disabled', async () => {
    const { token } = await signIn();
    await db.query(`update auth_users set status = 'disabled' where lower(login) = 'sysadmin'`);

    try {
      assert.equal((await get('/auth/me', token)).status, 401);
      assert.equal((await post('/auth/login', { login: 'sysadmin', password: GOOD_PASSWORD })).status, 401);
    } finally {
      await db.query(`update auth_users set status = 'active' where lower(login) = 'sysadmin'`);
    }
  });

  it('answers a wrong password and an unknown login with the same 401 body', async () => {
    const wrongPassword = await post('/auth/login', { login: 'sysadmin', password: 'definitely-wrong-password' });
    const unknownLogin = await post('/auth/login', { login: 'nobody-at-all', password: GOOD_PASSWORD });

    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownLogin.status, 401);
    assert.deepEqual(wrongPassword.payload, unknownLogin.payload);
    assert.equal(wrongPassword.payload.code, 'unauthorized');
    assert.equal(wrongPassword.response.headers.get('set-cookie'), null, 'a refused login opens no session');
  });

  // The failure path must still run a verify: an unknown login that skipped scrypt would
  // answer an order of magnitude faster and the endpoint would enumerate logins by timing.
  // The bound is loose on purpose — this asserts that the work happens, not how fast the
  // machine is.
  it('spends real work refusing an unknown login, not a shortcut', async () => {
    await post('/auth/login', { login: 'warm-the-decoy', password: GOOD_PASSWORD });

    const started = process.hrtime.bigint();
    await post('/auth/login', { login: 'nobody-at-all', password: GOOD_PASSWORD });
    const unknownMs = Number(process.hrtime.bigint() - started) / 1e6;

    const startedWrong = process.hrtime.bigint();
    await post('/auth/login', { login: 'sysadmin', password: 'definitely-wrong-password' });
    const wrongMs = Number(process.hrtime.bigint() - startedWrong) / 1e6;

    assert.ok(unknownMs > 5, `an unknown login answered in ${unknownMs.toFixed(1)}ms — no scrypt ran`);
    assert.ok(
      unknownMs > wrongMs / 10,
      `an unknown login (${unknownMs.toFixed(1)}ms) must not be an order of magnitude faster than a wrong password (${wrongMs.toFixed(1)}ms)`
    );
  });

  it('refuses a login with a missing field as 400, before it reaches a verify', async () => {
    assert.equal((await post('/auth/login', { login: 'sysadmin' })).status, 400);
    assert.equal((await post('/auth/login', { password: GOOD_PASSWORD })).status, 400);
    assert.equal((await post('/auth/login', {})).status, 400);
  });

  it('records the session with the caller it was opened for', async () => {
    const { token } = await signIn();
    const row = await sessionRow(token);

    assert.equal(row.auth_user_id, (await db.query(`select id from auth_users where lower(login) = 'sysadmin'`)).rows[0].id);
    assert.ok(row.expires_at > new Date(), 'a fresh session must not already be expired');
    assert.equal(row.revoked_at, null);
  });

  it('keeps two sessions for the same user independent', async () => {
    const first = await signIn();
    const second = await signIn();

    assert.notEqual(first.token, second.token);
    await post('/auth/logout', {}, first.token);

    assert.equal((await get('/auth/me', first.token)).status, 401);
    assert.equal((await get('/auth/me', second.token)).status, 200);
  });
});
