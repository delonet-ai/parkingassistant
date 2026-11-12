'use strict';

// Integration tests for the auth context: first-run activation (Task 1) and sessions (Task 2).
//
// Activation is the only way the bootstrap `sysadmin` gets a real password, and it must stop
// working the moment it has been used once. Each test builds its own scratch database, because
// the rule under test is about the whole `auth_users` table, not about one row.

const assert = require('node:assert/strict');
const { after, afterEach, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { getJson, postJson } = require('../testing/fixtures');
const { createModules } = require('../src/modules');
const { buildRouteTable } = require('../src/router');
const { verifyPassword } = require('../../../packages/shared/passwords');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

// Every route the composed table scopes to a role, read from the table rather than listed
// here. The role guard is only worth as much as its coverage, and a seventh account route
// added next month would otherwise be refused by nothing this suite looks at.
//
// Pattern routes included, and that is not hypothetical tidiness: reading only `exactRoutes`
// is the exact hole `route-access.test.js` was rewritten to close, where a pattern route added
// later went unprobed for months. A role-scoped pattern route would land here as its source,
// which no literal path can match — so this suite fails and has to say what it probes.
function roleScopedRoutes() {
  const { modules } = createModules({
    appTimezone: 'Europe/Moscow',
    dbRepository: null,
    guestReserveMinimum: 5,
    pool: null,
    startedAt: '2026-01-01T00:00:00.000Z'
  });
  const table = buildRouteTable(modules);
  const scoped = (route) => Array.isArray(route.roles) && route.roles.length > 0;

  return [
    ...[...table.exactRoutes.entries()].filter(([, route]) => scoped(route)).map(([key]) => key),
    ...table.patternRoutes.filter(scoped).map((route) => `${route.method} ${route.pattern.source}`)
  ];
}

const GOOD_PASSWORD = 'first-run-password';

describe('auth activation (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;

  async function boot() {
    db = await createTestDatabase();
    // `authenticate: false`: the harness normally activates and signs in the bootstrap
    // operator so the rest of the suites can reach the closed API, and this suite is the one
    // that has to meet a database where neither has happened yet.
    api = await startApi({ databaseUrl: db.connectionString, authenticate: false });
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

  // The one body an anonymous client can push at this API. Unbounded, the reader held all of it
  // and then built a string from it, so a few concurrent requests to a `public: true` route
  // could exhaust the process without a credential, a route or even valid JSON. 413, not 400:
  // there is nothing here the client fixes by correcting its JSON.
  it('refuses an oversized body on the public routes with 413, holding none of it', async () => {
    await boot();

    for (const pathname of ['/auth/activate', '/auth/login']) {
      const response = await fetch(`${api.baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: 'sysadmin', password: 'x'.repeat(2 * 1024 * 1024) })
      });

      assert.equal(response.status, 413);
      assert.match((await response.json()).error, /too large/);
    }

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
    // `authenticate: false`: the harness normally activates and signs in the bootstrap
    // operator so the rest of the suites can reach the closed API, and this suite is the one
    // that has to meet a database where neither has happened yet.
    api = await startApi({ databaseUrl: db.connectionString, authenticate: false });

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

// User management (Task 5): the five writes behind `system_admin`, the role guard that keeps
// a `parking_admin` out of all six account routes, and the two self-inflicted mistakes the
// role cannot prevent — an administrator removing their own `system_admin` role or disabling
// their own account.
//
// One scratch database for the whole suite: the harness signs in the seeded `sysadmin`, which
// is the operator every case acts as unless it says otherwise.

describe('auth user management (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let sysadminId = null;

  before(async () => {
    db = await createTestDatabase();
    api = await startApi({ databaseUrl: db.connectionString });
    sysadminId = api.operator.user.id;
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  let loginSequence = 0;

  function nextLogin(prefix) {
    loginSequence += 1;
    return `${prefix}-${loginSequence}`;
  }

  async function createUser(overrides = {}, options = {}) {
    const login = overrides.login || nextLogin('operator');

    return postJson(
      api.baseUrl,
      '/admin/users',
      {
        login,
        // `??`, not `||`: a case that asserts an empty display name is refused has to be
        // able to send one.
        displayName: overrides.displayName ?? `Operator ${login}`,
        password: overrides.password || 'a-new-operator-password',
        roles: overrides.roles || ['parking_admin'],
        ...(overrides.extra || {})
      },
      options
    );
  }

  // A session of this user's own, as a `name=value` cookie the request helpers accept.
  async function sessionCookieFor(login, password) {
    const response = await fetch(`${api.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password })
    });

    assert.equal(response.status, 200, `could not sign in as ${login}`);

    const header = response.headers.get('set-cookie');
    const match = /(pa_session=[^;]+)/.exec(header);
    assert.ok(match, 'login must set the session cookie');

    return match[1];
  }

  async function auditRowsFor(entityId) {
    const result = await db.query(
      `
        select action, actor_auth_user_id, actor_service, metadata
        from audit_logs
        where entity_type = 'auth_user' and entity_id = $1
        order by occurred_at, id
      `,
      [entityId]
    );

    return result.rows;
  }

  async function userRow(id) {
    const result = await db.query('select id, login, display_name, status, password_hash from auth_users where id = $1', [id]);
    return result.rows[0] || null;
  }

  async function roleCodesOf(id) {
    const result = await db.query(
      `
        select ar.code
        from auth_user_roles aur
        join auth_roles ar on ar.id = aur.auth_role_id
        where aur.auth_user_id = $1
        order by ar.code
      `,
      [id]
    );

    return result.rows.map((row) => row.code);
  }

  it('creates a user with an initial password and roles, and names the actor in the audit row', async () => {
    const login = nextLogin('created');
    const { status, payload } = await createUser({ login, roles: ['parking_admin'] });

    assert.equal(status, 201, JSON.stringify(payload));
    assert.equal(payload.user.login, login);
    assert.equal(payload.user.authStatus, 'active');
    assert.deepEqual(
      payload.user.roles.map((role) => role.code),
      ['parking_admin']
    );
    assert.ok(payload.user.roles.every((role) => typeof role.name === 'string' && role.name.length > 0));
    assert.equal(JSON.stringify(payload).includes('scrypt$'), false, 'the hash must not leave the API');

    const row = await userRow(payload.user.id);
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);
    assert.equal(await verifyPassword('a-new-operator-password', row.password_hash), true);

    const audit = await auditRowsFor(payload.user.id);
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ['auth_user_created']
    );
    assert.equal(audit[0].actor_auth_user_id, sysadminId, 'the audit row must name the operator who acted');
    assert.equal(audit[0].actor_service, 'admin-ui');
    assert.deepEqual(audit[0].metadata.roles, ['parking_admin']);
  });

  it('lets the new user sign in with the password it was created with', async () => {
    const login = nextLogin('signs-in');
    const created = await createUser({ login, password: 'brand-new-password' });
    assert.equal(created.status, 201);

    const cookie = await sessionCookieFor(login, 'brand-new-password');
    const me = await getJson(api.baseUrl, '/auth/me', { cookie });

    assert.equal(me.status, 200);
    assert.equal(me.payload.user.login, login);
    assert.deepEqual(me.payload.user.roles, ['parking_admin']);
  });

  it('shows the new user in GET /admin/users with their roles and status', async () => {
    const login = nextLogin('listed');
    const created = await createUser({ login, roles: ['parking_admin', 'system_admin'] });
    assert.equal(created.status, 201);

    const { status, payload } = await getJson(api.baseUrl, '/admin/users');

    assert.equal(status, 200);
    const listed = payload.users.find((user) => user.login === login);
    assert.ok(listed, 'the created user must appear in the list');
    assert.equal(listed.authStatus, 'active');
    assert.deepEqual(
      listed.roles.map((role) => role.code),
      ['parking_admin', 'system_admin']
    );
  });

  it('refuses a login that is already taken with 409, and writes nothing', async () => {
    const login = nextLogin('taken');
    assert.equal((await createUser({ login })).status, 201);

    const before = await db.query('select count(*)::int as count from auth_users');
    const { status, payload } = await createUser({ login, displayName: 'Someone else' });

    assert.equal(status, 409);
    assert.equal(payload.code, 'conflict');
    assert.match(payload.error, /already exists/);
    assert.deepEqual((await db.query('select count(*)::int as count from auth_users')).rows, before.rows);
  });

  it('refuses a creation whose fields the system would not accept, with 400 each', async () => {
    const refusals = await Promise.all([
      createUser({ password: '123456789' }),
      createUser({ roles: ['nope'] }),
      createUser({ roles: [] }),
      createUser({ login: 'ab' }),
      createUser({ displayName: '' })
    ]);

    assert.deepEqual(
      refusals.map((refusal) => refusal.status),
      [400, 400, 400, 400, 400]
    );
    assert.match(refusals[0].payload.error, /10 characters/);
    assert.match(refusals[1].payload.error, /Unknown role: nope/);
    assert.match(refusals[2].payload.error, /at least one role/);
  });

  it('replaces the role set, in both directions', async () => {
    const created = await createUser({ roles: ['parking_admin'] });
    const id = created.payload.user.id;

    const granted = await postJson(api.baseUrl, '/admin/users/roles', {
      authUserId: id,
      roles: ['parking_admin', 'system_admin']
    });

    assert.equal(granted.status, 200, JSON.stringify(granted.payload));
    assert.deepEqual(
      granted.payload.user.roles.map((role) => role.code),
      ['parking_admin', 'system_admin']
    );
    assert.deepEqual(await roleCodesOf(id), ['parking_admin', 'system_admin']);

    const revoked = await postJson(api.baseUrl, '/admin/users/roles', {
      authUserId: id,
      roles: ['parking_admin']
    });

    assert.equal(revoked.status, 200);
    assert.deepEqual(await roleCodesOf(id), ['parking_admin']);
    assert.deepEqual(
      (await auditRowsFor(id)).map((entry) => entry.action),
      ['auth_user_created', 'auth_user_roles_set', 'auth_user_roles_set']
    );
  });

  it('refuses to remove the acting administrator’s own system_admin role, with 409', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/users/roles', {
      authUserId: sysadminId,
      roles: ['parking_admin']
    });

    assert.equal(status, 409);
    assert.equal(payload.code, 'conflict');
    assert.match(payload.error, /your own system_admin role/);
    assert.deepEqual(await roleCodesOf(sysadminId), ['system_admin'], 'the role set must be untouched');
    assert.equal((await getJson(api.baseUrl, '/admin/users')).status, 200, 'the door must still be open');
  });

  it('lets the acting administrator keep system_admin while adding another role', async () => {
    const { status } = await postJson(api.baseUrl, '/admin/users/roles', {
      authUserId: sysadminId,
      roles: ['parking_admin', 'system_admin']
    });

    assert.equal(status, 200);
    assert.deepEqual(await roleCodesOf(sysadminId), ['parking_admin', 'system_admin']);

    // Back to where the suite found it, so the cases after this one see one role.
    await postJson(api.baseUrl, '/admin/users/roles', { authUserId: sysadminId, roles: ['system_admin'] });
    assert.deepEqual(await roleCodesOf(sysadminId), ['system_admin']);
  });

  it('refuses to disable the acting administrator’s own account, with 409', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/users/disable', { authUserId: sysadminId });

    assert.equal(status, 409);
    assert.equal(payload.code, 'conflict');
    assert.match(payload.error, /your own account/);
    assert.equal((await userRow(sysadminId)).status, 'active');
    assert.equal((await getJson(api.baseUrl, '/auth/me')).status, 200, 'the acting session must survive');
  });

  it('disables a user, revokes their live sessions in the same breath and refuses their login', async () => {
    const login = nextLogin('disabled');
    const created = await createUser({ login, password: 'about-to-be-disabled' });
    const id = created.payload.user.id;
    const cookie = await sessionCookieFor(login, 'about-to-be-disabled');
    assert.equal((await getJson(api.baseUrl, '/auth/me', { cookie })).status, 200);

    const { status, payload } = await postJson(api.baseUrl, '/admin/users/disable', { authUserId: id });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.user.authStatus, 'disabled');
    assert.equal(payload.revokedSessions, 1);

    assert.equal((await userRow(id)).status, 'disabled');
    assert.equal(
      (await getJson(api.baseUrl, '/auth/me', { cookie })).status,
      401,
      'a disabled account must not keep a live session'
    );
    assert.equal((await getJson(api.baseUrl, '/admin/places', { cookie })).status, 401);

    const refused = await fetch(`${api.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password: 'about-to-be-disabled' })
    });
    assert.equal(refused.status, 401);

    const revokedSessions = await db.query(
      'select count(*)::int as count from auth_sessions where auth_user_id = $1 and revoked_at is not null',
      [id]
    );
    assert.equal(revokedSessions.rows[0].count, 1);

    const audit = await auditRowsFor(id);
    assert.equal(audit[audit.length - 1].action, 'auth_user_disabled');
    assert.equal(audit[audit.length - 1].metadata.revokedSessions, 1);
  });

  it('re-enables a disabled user, who then signs in anew', async () => {
    const login = nextLogin('re-enabled');
    const created = await createUser({ login, password: 'off-and-on-again' });
    const id = created.payload.user.id;

    assert.equal((await postJson(api.baseUrl, '/admin/users/disable', { authUserId: id })).status, 200);
    const enabled = await postJson(api.baseUrl, '/admin/users/enable', { authUserId: id });

    assert.equal(enabled.status, 200);
    assert.equal(enabled.payload.user.authStatus, 'active');
    assert.equal((await userRow(id)).status, 'active');

    const cookie = await sessionCookieFor(login, 'off-and-on-again');
    assert.equal((await getJson(api.baseUrl, '/auth/me', { cookie })).status, 200);

    const audit = await auditRowsFor(id);
    assert.deepEqual(
      audit.map((entry) => entry.action),
      ['auth_user_created', 'auth_user_disabled', 'auth_user_enabled']
    );
  });

  it('sets a new password: the new one works and the old one does not', async () => {
    const login = nextLogin('rotated');
    const created = await createUser({ login, password: 'the-first-password' });
    const id = created.payload.user.id;

    const { status, payload } = await postJson(api.baseUrl, '/admin/users/password', {
      authUserId: id,
      password: 'the-second-password'
    });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.deepEqual(
      payload.user.roles.map((role) => role.code),
      ['parking_admin'],
      'the answer must still describe the user, roles included'
    );

    const row = await userRow(id);
    assert.equal(await verifyPassword('the-second-password', row.password_hash), true);
    assert.equal(await verifyPassword('the-first-password', row.password_hash), false);

    const refused = await fetch(`${api.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, password: 'the-first-password' })
    });
    assert.equal(refused.status, 401);
    await sessionCookieFor(login, 'the-second-password');
  });

  it('renames an account: the login stays, the new name is what /auth/me and the list show', async () => {
    const login = nextLogin('renamed');
    const created = await createUser({ login, password: 'keeps-its-password' });
    const id = created.payload.user.id;
    const before = (await userRow(id)).display_name;

    const { status, payload } = await postJson(api.baseUrl, '/admin/users/display-name', {
      authUserId: id,
      displayName: '  Иванова Мария  '
    });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.user.displayName, 'Иванова Мария', 'the name is trimmed');
    assert.equal(payload.user.login, login, 'a rename never changes the login');
    assert.deepEqual(payload.user.roles.map((role) => role.code), ['parking_admin']);

    const cookie = await sessionCookieFor(login, 'keeps-its-password');
    assert.equal((await getJson(api.baseUrl, '/auth/me', { cookie })).payload.user.displayName, 'Иванова Мария');

    const audit = await auditRowsFor(id);
    const renamed = audit[audit.length - 1];
    assert.equal(renamed.action, 'auth_user_renamed');
    assert.deepEqual(
      { from: renamed.metadata.from, to: renamed.metadata.to },
      { from: before, to: 'Иванова Мария' },
      'the old name stays readable in the audit trail'
    );

    // Saving the same name again is a no-op for the journal.
    await postJson(api.baseUrl, '/admin/users/display-name', { authUserId: id, displayName: 'Иванова Мария' });
    assert.equal((await auditRowsFor(id)).length, audit.length);
  });

  it('refuses an empty or overlong name with 400 and leaves the account as it was', async () => {
    const created = await createUser();
    const id = created.payload.user.id;
    const before = (await userRow(id)).display_name;

    for (const displayName of ['', '   ', 'я'.repeat(500), null]) {
      const { status, payload } = await postJson(api.baseUrl, '/admin/users/display-name', { authUserId: id, displayName });
      assert.equal(status, 400, JSON.stringify(payload));
      assert.match(payload.error, /displayName is required/);
    }

    assert.equal((await userRow(id)).display_name, before);
  });

  it('activates an invited user when their password is set — a credential that works', async () => {
    const login = nextLogin('invited');
    const inserted = await db.query(
      `
        insert into auth_users (login, password_hash, display_name, status)
        values ($1, '{PENDING_IMPLEMENTATION}', 'Invited Operator', 'invited')
        returning id
      `,
      [login]
    );
    const id = inserted.rows[0].id;
    await postJson(api.baseUrl, '/admin/users/roles', { authUserId: id, roles: ['parking_admin'] });

    const { status, payload } = await postJson(api.baseUrl, '/admin/users/password', {
      authUserId: id,
      password: 'finally-a-real-password'
    });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.user.authStatus, 'active');
    assert.equal((await userRow(id)).status, 'active');
    await sessionCookieFor(login, 'finally-a-real-password');

    const audit = await auditRowsFor(id);
    assert.equal(audit[audit.length - 1].action, 'auth_user_password_set');
    assert.equal(audit[audit.length - 1].metadata.activated, true);
  });

  it('leaves a disabled user disabled when their password is set', async () => {
    const created = await createUser();
    const id = created.payload.user.id;
    await postJson(api.baseUrl, '/admin/users/disable', { authUserId: id });

    const { status, payload } = await postJson(api.baseUrl, '/admin/users/password', {
      authUserId: id,
      password: 'still-not-allowed-in'
    });

    assert.equal(status, 200);
    assert.equal(payload.user.authStatus, 'disabled', 'a password is not what is stopping them');
  });

  it('answers 404 for a user that does not exist and 400 for an id that is not one', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';

    for (const [pathname, body] of [
      ['/admin/users/roles', { authUserId: missing, roles: ['parking_admin'] }],
      ['/admin/users/password', { authUserId: missing, password: 'a-valid-password' }],
      ['/admin/users/display-name', { authUserId: missing, displayName: 'Nobody' }],
      ['/admin/users/disable', { authUserId: missing }],
      ['/admin/users/enable', { authUserId: missing }]
    ]) {
      const { status, payload } = await postJson(api.baseUrl, pathname, body);
      assert.equal(status, 404, `${pathname} answered ${status}`);
      assert.equal(payload.code, 'not_found');
    }

    const malformed = await postJson(api.baseUrl, '/admin/users/disable', { authUserId: 'not-a-uuid' });
    assert.equal(malformed.status, 400);
    assert.match(malformed.payload.error, /valid uuid/);

    const absent = await postJson(api.baseUrl, '/admin/users/enable', {});
    assert.equal(absent.status, 400);
    assert.match(absent.payload.error, /authUserId is required/);
  });

  // The role guard, which is the point of the whole task: a `parking_admin` runs the parking
  // and may not see or touch an account. 403, never 404 — an operator who simply lacks a role
  // must be told that, not that the route does not exist.
  it('refuses a parking_admin on every user-management route with 403, while the parking stays open', async () => {
    const login = nextLogin('parking-admin');
    const created = await createUser({ login, password: 'only-runs-the-parking', roles: ['parking_admin'] });
    assert.equal(created.status, 201);
    const cookie = await sessionCookieFor(login, 'only-runs-the-parking');
    const victim = await createUser();

    const list = await getJson(api.baseUrl, '/admin/users', { cookie });
    assert.equal(list.status, 403);
    assert.equal(list.payload.code, 'forbidden');

    const writes = [
      ['/admin/users', { login: 'sneaky-operator', displayName: 'Sneaky', password: 'a-valid-password', roles: ['system_admin'] }],
      ['/admin/users/roles', { authUserId: victim.payload.user.id, roles: ['system_admin'] }],
      ['/admin/users/password', { authUserId: victim.payload.user.id, password: 'a-valid-password' }],
      ['/admin/users/display-name', { authUserId: victim.payload.user.id, displayName: 'Hijacked' }],
      ['/admin/users/disable', { authUserId: victim.payload.user.id }],
      ['/admin/users/enable', { authUserId: victim.payload.user.id }]
    ];

    // "Every" means every: the probes above plus the list read, against the table itself.
    // A role-scoped route this case does not call fails here rather than going unchecked.
    assert.deepEqual(
      ['GET /admin/users', ...writes.map(([pathname]) => `POST ${pathname}`)].sort(),
      roleScopedRoutes().sort(),
      'a role-scoped route is not probed for a parking_admin — add it to this case'
    );

    for (const [pathname, body] of writes) {
      const { status, payload } = await postJson(api.baseUrl, pathname, body, { cookie });

      assert.equal(status, 403, `${pathname} answered ${status} for a parking_admin`);
      assert.equal(payload.code, 'forbidden');
      assert.notEqual(status, 404, 'a missing role must not be reported as a missing route');
    }

    // Nothing was written by any of the five.
    assert.equal(
      (await db.query(`select count(*)::int as count from auth_users where login = 'sneaky-operator'`)).rows[0].count,
      0
    );
    assert.deepEqual(await roleCodesOf(victim.payload.user.id), ['parking_admin']);
    assert.equal((await userRow(victim.payload.user.id)).status, 'active');
    assert.notEqual((await userRow(victim.payload.user.id)).display_name, 'Hijacked');

    // And the day is still theirs to run.
    assert.equal((await getJson(api.baseUrl, '/admin/places', { cookie })).status, 200);
    assert.equal((await getJson(api.baseUrl, '/admin/dashboard', { cookie })).status, 200);
  });

  it('refuses every user-management route without a session at all, with 401', async () => {
    for (const [method, pathname] of [
      ['GET', '/admin/users'],
      ['POST', '/admin/users'],
      ['POST', '/admin/users/roles'],
      ['POST', '/admin/users/password'],
      ['POST', '/admin/users/disable'],
      ['POST', '/admin/users/enable']
    ]) {
      const result =
        method === 'GET'
          ? await getJson(api.baseUrl, pathname, { cookie: null })
          : await postJson(api.baseUrl, pathname, {}, { cookie: null });

      assert.equal(result.status, 401, `${method} ${pathname} answered ${result.status} anonymously`);
      assert.equal(result.payload.code, 'unauthorized');
    }
  });

  it('keeps the bootstrap operator usable throughout — the suite never locked itself out', async () => {
    const me = await getJson(api.baseUrl, '/auth/me');

    assert.equal(me.status, 200);
    assert.equal(me.payload.user.login, 'sysadmin');
    assert.deepEqual(me.payload.user.roles, ['system_admin']);
    assert.equal((await userRow(sysadminId)).status, 'active');
  });
});

// The service token (Task 12), against a real API and a real database.
//
// The scheduler in `apps/jobs` has no operator and no cookie, so from Task 3 until this
// existed every one of its five daily posts answered 401 and the stand ran no job at all. The
// unit-level counterparts are `router.test.js` (the guard) and `route-access.test.js` (which
// routes carry the flag); what only an integration test can show is that the token actually
// reaches the work: a job run lands in `job_runs`, attributed to the service and to nobody.
describe('jobs service token (integration)', { skip: skipWithoutDatabase() }, () => {
  const TOKEN = 'c3b1e6a1f0'.repeat(6);
  const DATE = '2026-11-18';

  // One per route group the scheduler posts to would be redundant — the guard does not read
  // the path beyond its flag. `rebuild-conflicts` is the cheapest of the five: it needs no
  // places, no queue and no releases to answer 200.
  const JOB_PATH = '/admin/jobs/rebuild-conflicts';

  let db = null;
  let api = null;
  let tokenlessApi = null;

  before(async () => {
    db = await createTestDatabase();
    api = await startApi({
      databaseUrl: db.connectionString,
      authenticate: false,
      env: { JOBS_SERVICE_TOKEN: TOKEN }
    });
    // The other half of the design: the same database, an API that was given no token. A
    // deployment that forgets the variable must get a closed API, not an open one.
    tokenlessApi = await startApi({ databaseUrl: db.connectionString, authenticate: false });
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (tokenlessApi) {
      await tokenlessApi.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  // Plain `fetch`, not the fixtures helpers: no session is involved anywhere in this suite,
  // and the request below is byte for byte what `apps/jobs/src/scheduler.js` sends.
  async function postAsScheduler(baseUrl, pathname, { token, body = { date: DATE } } = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { 'x-service-token': token })
      },
      body: JSON.stringify(body)
    });

    return { status: response.status, payload: await response.json() };
  }

  it('runs a job for the scheduler, with the token and no cookie', async () => {
    const { status, payload } = await postAsScheduler(api.baseUrl, JOB_PATH, { token: TOKEN });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.status, 'ok');
    assert.ok(payload.jobRun && payload.jobRun.id, 'the run has to be recorded');

    // The audit question, which is why the token resolves nobody rather than signing in as a
    // service account: the run names the service and no person. A session-shaped answer here
    // would make `audit-actor.itest.js` describe a system that does not exist.
    const run = await db.query(
      'select job_name, status, actor_service from job_runs where id = $1',
      [payload.jobRun.id]
    );
    assert.deepEqual(run.rows, [{ job_name: 'rebuild_conflicts', status: 'success', actor_service: 'jobs' }]);

    const audit = await db.query(
      `
        select actor_service, actor_auth_user_id
        from audit_logs
        where action = 'job_rebuild_conflicts_success' and metadata->>'jobRunId' = $1
      `,
      [payload.jobRun.id]
    );
    assert.deepEqual(audit.rows, [{ actor_service: 'jobs', actor_auth_user_id: null }]);
  });

  it('refuses a wrong token and an absent one, and writes no run', async () => {
    const before = await db.query('select count(*)::int as count from job_runs');

    for (const token of [undefined, '', 'wrong', `${TOKEN}x`]) {
      const { status, payload } = await postAsScheduler(api.baseUrl, JOB_PATH, { token });

      assert.equal(status, 401, `token ${JSON.stringify(token)} answered ${status}`);
      assert.equal(payload.code, 'unauthorized');
    }

    const after = await db.query('select count(*)::int as count from job_runs');
    assert.equal(after.rows[0].count, before.rows[0].count, 'a refused job must not record a run');
  });

  // The hole this design can actually have, and the reason the check is written as "no
  // configured token refuses everything" rather than "compare the two values".
  it('refuses every caller when the API was given no token, header or not', async () => {
    for (const token of [undefined, '', TOKEN]) {
      const { status } = await postAsScheduler(tokenlessApi.baseUrl, JOB_PATH, { token });

      assert.equal(status, 401, `token ${JSON.stringify(token)} was let into an API with none configured`);
    }
  });

  it('does not open the rest of the API, reads on the same context included', async () => {
    const runs = await fetch(`${api.baseUrl}/admin/jobs/runs`, { headers: { 'x-service-token': TOKEN } });
    assert.equal(runs.status, 401, 'the operator’s jobs screen is session-only');

    const places = await fetch(`${api.baseUrl}/admin/places`, { headers: { 'x-service-token': TOKEN } });
    assert.equal(places.status, 401);
  });

  // A job an operator starts from the jobs screen takes the session path on the same route,
  // and is theirs: the token did not replace the cookie, it was added beside it.
  it('still accepts a session on the same route, attributed to the operator', async () => {
    const operatorApi = await startApi({
      databaseUrl: db.connectionString,
      env: { JOBS_SERVICE_TOKEN: TOKEN }
    });

    try {
      const { status, payload } = await postJson(operatorApi.baseUrl, JOB_PATH, { date: DATE });

      assert.equal(status, 200, JSON.stringify(payload));

      const run = await db.query('select actor_service from job_runs where id = $1', [payload.jobRun.id]);
      assert.deepEqual(run.rows, [{ actor_service: 'admin-ui' }]);
    } finally {
      await operatorApi.stop();
    }
  });
});
