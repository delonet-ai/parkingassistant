'use strict';

const { PayloadTooLargeError, readJsonBody } = require('../../../../../packages/shared/http');
const { readCookie, serializeCookie } = require('../../support/cookies');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');
const { uuidValidationError } = require('../../support/params');
const {
  MIN_PASSWORD_LENGTH,
  NOT_AUTHENTICATED,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SYSTEM_ADMIN_ROLE
} = require('./service');

const MAX_LOGIN_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 200;

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

// What the body reader refused, as a response. Told apart by type, because the two refusals are
// different statuses: a body past the reader's limit is 413 and nothing the client can fix by
// correcting its JSON, and 400 "must be valid JSON" would send it round the same request again.
//
// These four routes are the ones that need the distinction most: they are `public: true`, so
// theirs is the one body a client that has not signed in can push.
function bodyRefusal(error) {
  if (error instanceof PayloadTooLargeError) {
    return {
      statusCode: 413,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body is too large'
      }
    };
  }

  return badRequest('Request body must be valid JSON');
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
    } catch (error) {
      return bodyRefusal(error);
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
    } catch (error) {
      return bodyRefusal(error);
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

  // --- user management (Task 5) -------------------------------------------------------------
  //
  // All five routes are `roles: [SYSTEM_ADMIN_ROLE]`, so the router has already refused anyone
  // else by the time a handler runs. `authUser` is the acting operator, threaded from the
  // router's resolved session: it names the actor on the audit row, and it is what the
  // service compares against to catch an administrator demoting or disabling themselves.
  //
  // The list these five write to is `GET /admin/users`, which lives in the `system` context
  // with the other read that existed before authentication did.

  function userResponse(result, statusCode = 200) {
    return {
      statusCode,
      payload: {
        status: 'ok',
        service: 'api',
        user: {
          id: result.user.id,
          login: result.user.login,
          displayName: result.user.display_name,
          authStatus: result.user.status,
          lastLoginAt: result.user.last_login_at,
          createdAt: result.user.created_at,
          roles: result.roles
        },
        ...(typeof result.revokedSessions === 'number' ? { revokedSessions: result.revokedSessions } : {})
      }
    };
  }

  // One body reader for the five, because they all need the same two things: a parsed body
  // and the acting operator. A handler that cannot parse its body answers 400 before it
  // reaches the service.
  async function readBody(req) {
    try {
      return { body: await readJsonBody(req) };
    } catch (error) {
      return { refusal: bodyRefusal(error) };
    }
  }

  function readLogin(body) {
    const login = body && typeof body.login === 'string' ? body.login.trim() : '';

    if (login.length < 3 || login.length > MAX_LOGIN_LENGTH || /\s/.test(login)) {
      return { error: `login must be 3 to ${MAX_LOGIN_LENGTH} characters and contain no whitespace` };
    }

    return { login };
  }

  function readDisplayName(body) {
    const displayName = body && typeof body.displayName === 'string' ? body.displayName.trim() : '';

    if (!displayName || displayName.length > MAX_DISPLAY_NAME_LENGTH) {
      return { error: `displayName is required and must be at most ${MAX_DISPLAY_NAME_LENGTH} characters` };
    }

    return { displayName };
  }

  function readPassword(body) {
    const password = body && typeof body.password === 'string' ? body.password : '';

    if (password.length < MIN_PASSWORD_LENGTH) {
      return { error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` };
    }

    return { password };
  }

  // Deduplicated, because `['system_admin', 'system_admin']` would otherwise make the
  // service's "I asked for two codes and got one row back" check report a role as unknown.
  function readRoleCodes(body) {
    const raw = body && Array.isArray(body.roles) ? body.roles : null;

    if (!raw || raw.some((code) => typeof code !== 'string' || !code.trim())) {
      return { error: 'roles must be an array of role codes' };
    }

    return { roleCodes: [...new Set(raw.map((code) => code.trim()))] };
  }

  function actorOf(authUser) {
    return authUser ? { id: authUser.id, login: authUser.login } : null;
  }

  async function handleUserCreate({ req, authUser }) {
    const { body, refusal } = await readBody(req);

    if (refusal) {
      return refusal;
    }

    const login = readLogin(body);
    const displayName = readDisplayName(body);
    const password = readPassword(body);
    const roles = readRoleCodes(body);
    const invalid = [login, displayName, password, roles].find((field) => field.error);

    if (invalid) {
      return badRequest(invalid.error);
    }

    try {
      const created = await service.createUser({
        actor: actorOf(authUser),
        login: login.login,
        displayName: displayName.displayName,
        password: password.password,
        roleCodes: roles.roleCodes
      });

      return userResponse(created, 201);
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleUserCreate');
    }
  }

  // The target is named by id rather than by login: a login can be changed and an id cannot,
  // and the UI already has the id from `GET /admin/users`.
  function readTargetId(body) {
    const authUserId = body && typeof body.authUserId === 'string' ? body.authUserId.trim() : '';

    if (!authUserId) {
      return { error: 'authUserId is required' };
    }

    const invalidId = uuidValidationError({ authUserId });

    if (invalidId) {
      return { refusal: invalidId };
    }

    return { authUserId };
  }

  async function handleUserRoles({ req, authUser }) {
    const { body, refusal } = await readBody(req);

    if (refusal) {
      return refusal;
    }

    const target = readTargetId(body);

    if (target.refusal) {
      return target.refusal;
    }

    const roles = readRoleCodes(body);
    const invalid = [target, roles].find((field) => field.error);

    if (invalid) {
      return badRequest(invalid.error);
    }

    try {
      return userResponse(
        await service.setUserRoles({
          actor: actorOf(authUser),
          authUserId: target.authUserId,
          roleCodes: roles.roleCodes
        })
      );
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleUserRoles');
    }
  }

  async function handleUserPassword({ req, authUser }) {
    const { body, refusal } = await readBody(req);

    if (refusal) {
      return refusal;
    }

    const target = readTargetId(body);

    if (target.refusal) {
      return target.refusal;
    }

    const password = readPassword(body);
    const invalid = [target, password].find((field) => field.error);

    if (invalid) {
      return badRequest(invalid.error);
    }

    try {
      return userResponse(
        await service.setUserPassword({
          actor: actorOf(authUser),
          authUserId: target.authUserId,
          password: password.password
        })
      );
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleUserPassword');
    }
  }

  async function handleUserDisplayName({ req, authUser }) {
    const { body, refusal } = await readBody(req);

    if (refusal) {
      return refusal;
    }

    const target = readTargetId(body);

    if (target.refusal) {
      return target.refusal;
    }

    const displayName = readDisplayName(body);
    const invalid = [target, displayName].find((field) => field.error);

    if (invalid) {
      return badRequest(invalid.error);
    }

    try {
      return userResponse(
        await service.setUserDisplayName({
          actor: actorOf(authUser),
          authUserId: target.authUserId,
          displayName: displayName.displayName
        })
      );
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleUserDisplayName');
    }
  }

  async function handleUserStatus({ req, authUser }, status) {
    const { body, refusal } = await readBody(req);

    if (refusal) {
      return refusal;
    }

    const target = readTargetId(body);

    if (target.refusal) {
      return target.refusal;
    }

    if (target.error) {
      return badRequest(target.error);
    }

    try {
      return userResponse(
        await service.setUserStatus({
          actor: actorOf(authUser),
          authUserId: target.authUserId,
          status
        })
      );
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleUserStatus');
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
      { method: 'POST', path: '/auth/logout', public: true, handler: ({ req }) => handleLogout(req) },
      {
        method: 'POST',
        path: '/admin/users',
        roles: [SYSTEM_ADMIN_ROLE],
        handler: (context) => handleUserCreate(context)
      },
      {
        method: 'POST',
        path: '/admin/users/roles',
        roles: [SYSTEM_ADMIN_ROLE],
        handler: (context) => handleUserRoles(context)
      },
      {
        method: 'POST',
        path: '/admin/users/password',
        roles: [SYSTEM_ADMIN_ROLE],
        handler: (context) => handleUserPassword(context)
      },
      {
        method: 'POST',
        path: '/admin/users/display-name',
        roles: [SYSTEM_ADMIN_ROLE],
        handler: (context) => handleUserDisplayName(context)
      },
      {
        method: 'POST',
        path: '/admin/users/disable',
        roles: [SYSTEM_ADMIN_ROLE],
        handler: (context) => handleUserStatus(context, 'disabled')
      },
      {
        method: 'POST',
        path: '/admin/users/enable',
        roles: [SYSTEM_ADMIN_ROLE],
        handler: (context) => handleUserStatus(context, 'active')
      }
    ]
  };
}

module.exports = {
  createAuthController
};
