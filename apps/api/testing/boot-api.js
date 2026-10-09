'use strict';

// Boots apps/api/src/server.js as a child process against a given DATABASE_URL.
// The API entrypoint self-starts its listener on require, so an out-of-process
// boot is the only way to exercise the handler layer without restructuring it.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { Client } = require('pg');

const { hashPassword } = require('../../../packages/shared/passwords');
const { SESSION_COOKIE_NAME } = require('../src/support/cookies');
const { forgetSessionCookie, rememberSessionCookie } = require('./session');

const SERVER_ENTRY = path.join(__dirname, '..', 'src', 'server.js');

// The operator every suite runs as. The scratch schema applies
// `packages/db/seeds/001_bootstrap_system_admin.sql`, so `sysadmin` exists and is `invited`
// with a placeholder hash. It carries `system_admin`, which is what lets one session reach
// both the parking routes and the user-management ones. A suite that needs a `parking_admin`
// creates one of its own.
const TEST_OPERATOR_LOGIN = 'sysadmin';
const TEST_OPERATOR_PASSWORD = 'integration-test-password';

// Reads the port out of the child's startup line. Picking a free port here and handing
// it to the child loses the race: between closing the probe socket and the child binding,
// a parallel suite can take the same port, and the child dies with EADDRINUSE. Letting the
// OS assign it inside the process that keeps it is the only version without a window.
function readBoundPort(child, chunks, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`api did not report a port in ${timeoutMs}ms`));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    }

    function onData() {
      const match = /listening on port (\d+)/.exec(chunks.join(''));
      if (match) {
        cleanup();
        resolve(Number(match[1]));
      }
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`api exited before listening (code ${code}, signal ${signal})`));
    }

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function waitForHealth(baseUrl, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`/health responded with ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`api did not become healthy in ${timeoutMs}ms: ${lastError && lastError.message}`);
}

// `name=value` only, which is what a request's `cookie` header carries. The attributes the
// API sets — HttpOnly, SameSite, Max-Age — describe what a browser should do with the cookie
// and have no meaning on the way back.
function readSessionCookie(response) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);

  for (const header of headers) {
    const match = new RegExp(`(?:^|[;,\\s])(${SESSION_COOKIE_NAME}=[^;]+)`).exec(header);

    if (match) {
      return match[1];
    }
  }

  return null;
}

async function postAuthJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  return { response, status: response.status, payload: await response.json() };
}

// Gives the seeded bootstrap operator a real password, in the database rather than through
// `POST /auth/activate`.
//
// Activation is the subject of apps/api/integration/auth.itest.js, which covers it and each
// of its refusals; what every *other* suite needs from the harness is simply an authenticated
// client. Going through the endpoint would also write an `auth_user_activated` audit row into
// every scratch schema — and the golden suite records the audit journal, where one extra row
// consumes an identifier token and renumbers every `<id:N>` after it. The sign-in below is
// still the real `POST /auth/login` against a real scrypt hash, so nothing about session
// handling is stubbed; only the one-time password-setting step is.
async function seedOperatorCredential(databaseUrl, { login, password }) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query(
      `
        update auth_users
        set password_hash = $2,
            status = 'active'
        where lower(login) = lower($1)
          and deleted_at is null
        returning id
      `,
      [login, await hashPassword(password)]
    );

    if (result.rowCount !== 1) {
      throw new Error(`expected exactly one auth user named ${login}, found ${result.rowCount}`);
    }
  } finally {
    await client.end();
  }
}

async function authenticateOperator(baseUrl, databaseUrl, { login, password }) {
  await seedOperatorCredential(databaseUrl, { login, password });

  const signedIn = await postAuthJson(baseUrl, '/auth/login', { login, password });

  if (signedIn.status !== 200) {
    throw new Error(`could not sign in as ${login}: ${signedIn.status} ${JSON.stringify(signedIn.payload)}`);
  }

  const cookie = readSessionCookie(signedIn.response);

  if (!cookie) {
    throw new Error(`login as ${login} returned no ${SESSION_COOKIE_NAME} cookie`);
  }

  return { cookie, login, password, user: signedIn.payload.user };
}

/**
 * @param {{
 *   databaseUrl: string,
 *   env?: Record<string, string>,
 *   authenticate?: boolean,
 *   operator?: { login?: string, password?: string }
 * }} options
 * @returns {Promise<{
 *   baseUrl: string, port: number, cookie: string | null, operator: object | null,
 *   stop: () => Promise<void>, output: () => string
 * }>}
 */
async function startApi(options) {
  const chunks = [];

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      ...process.env,
      PORT: '0',
      DATABASE_URL: options.databaseUrl,
      APP_TIMEZONE: process.env.APP_TIMEZONE || 'Europe/Moscow',
      ...(options.env || {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => chunks.push(chunk.toString()));
  child.stderr.on('data', (chunk) => chunks.push(chunk.toString()));

  const output = () => chunks.join('');

  const stop = () =>
    new Promise((resolve) => {
      if (baseUrl) {
        forgetSessionCookie(baseUrl);
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    });

  let port = null;
  let baseUrl = null;
  let operator = null;

  try {
    port = await readBoundPort(child, chunks);
    baseUrl = `http://127.0.0.1:${port}`;
    await waitForHealth(baseUrl);

    // `authenticate: false` is for the auth suite itself, which is about activation and login
    // and must meet a database where neither has happened.
    if (options.authenticate !== false) {
      operator = await authenticateOperator(baseUrl, options.databaseUrl, {
        login: (options.operator && options.operator.login) || TEST_OPERATOR_LOGIN,
        password: (options.operator && options.operator.password) || TEST_OPERATOR_PASSWORD
      });

      rememberSessionCookie(baseUrl, operator.cookie);
    }
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n--- api output ---\n${output()}`);
  }

  return {
    baseUrl,
    port,
    cookie: operator ? operator.cookie : null,
    operator,
    stop,
    output
  };
}

module.exports = { startApi, waitForHealth };
