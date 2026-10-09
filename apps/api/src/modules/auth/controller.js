'use strict';

const { readJsonBody } = require('../../../../../packages/shared/http');
const { readCookie, serializeCookie } = require('../../support/cookies');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');
const {
  MIN_PASSWORD_LENGTH,
  NOT_AUTHENTICATED,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS
} = require('./service');

function badRequest(error) {
  return {
    statusCode: 400,
    payload: {
      status: 'error',
      service: 'api',
      error
    }
  };
}

function unauthorized(error) {
  return {
    statusCode: 401,
    payload: {
      status: 'error',
      service: 'api',
      error
    }
  };
}

function userPayload(user, roles) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName,
    authStatus: user.status,
    roles
  };
}

function sessionCookie(token) {
  return serializeCookie(SESSION_COOKIE_NAME, token, { maxAge: SESSION_TTL_SECONDS });
}

// Max-Age=0 rather than an omitted value: the browser drops the cookie now instead of at the
// end of the session, so a logout on a shared machine takes effect immediately.
function clearedSessionCookie() {
  return serializeCookie(SESSION_COOKIE_NAME, '', { maxAge: 0 });
}

function createAuthController({ services }) {
  const service = services.auth;

  function readCredentials(body) {
    return {
      login: body && typeof body.login === 'string' ? body.login.trim() : '',
      password: body && typeof body.password === 'string' ? body.password : ''
    };
  }

  async function handleActivate(req) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return badRequest('Request body must be valid JSON');
    }

    const { login, password } = readCredentials(body);

    if (!login) {
      return badRequest('login is required');
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return badRequest(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }

    try {
      const user = await service.activate({ login, password });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          user: {
            id: user.id,
            login: user.login,
            displayName: user.display_name,
            authStatus: user.status
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleActivate');
    }
  }

  // No length check on the password here: `MIN_PASSWORD_LENGTH` is a rule about the passwords
  // this system issues, and applying it on the way in would tell an attacker that a short
  // guess is not worth making — and would 400 where the honest answer is 401.
  async function handleLogin(req) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return badRequest('Request body must be valid JSON');
    }

    const { login, password } = readCredentials(body);

    if (!login || !password) {
      return badRequest('login and password are required');
    }

    try {
      const result = await service.login({
        login,
        password,
        ipAddress: req.socket && req.socket.remoteAddress,
        userAgent: req.headers['user-agent']
      });

      return {
        statusCode: 200,
        headers: { 'set-cookie': sessionCookie(result.token) },
        payload: {
          status: 'ok',
          service: 'api',
          expiresAt: result.expiresAt,
          user: userPayload(result.user, result.roles)
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleLogin');
    }
  }

  async function handleMe(req) {
    try {
      const resolved = await service.resolveSession(readCookie(req.headers.cookie, SESSION_COOKIE_NAME));

      if (!resolved) {
        return unauthorized(NOT_AUTHENTICATED);
      }

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          expiresAt: resolved.session.expiresAt,
          user: userPayload(resolved.authUser, resolved.roles)
        }
      };
    } catch (error) {
      return internalError(error, 'handleMe');
    }
  }

  // Answers 200 whatever the cookie was: a logout whose session is already gone has reached
  // the state the caller asked for. The cookie is cleared either way, so a browser holding a
  // stale value does not keep sending it.
  async function handleLogout(req) {
    try {
      const result = await service.logout(readCookie(req.headers.cookie, SESSION_COOKIE_NAME));

      return {
        statusCode: 200,
        headers: { 'set-cookie': clearedSessionCookie() },
        payload: {
          status: 'ok',
          service: 'api',
          revoked: result.revoked
        }
      };
    } catch (error) {
      return internalError(error, 'handleLogout');
    }
  }

  // Not advertised: the endpoint index at `GET /` is pinned by a golden snapshot, and the
  // auth routes change who may ask, not what the API offers.
  //
  // All four are `public: true`, which is the one place in the API where that is not a
  // weakness: these are the routes that *establish* a session, so requiring one would close
  // the only door in. Each enforces its own rule instead — activation only while the database
  // holds the single `invited` bootstrap user, login only against a verified password, and
  // `/auth/me` answers 401 for a cookie that resolves to nobody.
  return {
    name: 'auth',
    routes: [
      { method: 'POST', path: '/auth/activate', public: true, handler: ({ req }) => handleActivate(req) },
      { method: 'POST', path: '/auth/login', public: true, handler: ({ req }) => handleLogin(req) },
      { method: 'GET', path: '/auth/me', public: true, handler: ({ req }) => handleMe(req) },
      { method: 'POST', path: '/auth/logout', public: true, handler: ({ req }) => handleLogout(req) }
    ]
  };
}

module.exports = {
  createAuthController
};
