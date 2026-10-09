'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const { hashPassword, verifyPassword } = require('../../../../../packages/shared/passwords');
const { SESSION_COOKIE_NAME } = require('../../support/cookies');
const { withTransaction } = require('../../repositories/db');
const { abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const repository = require('./repository');

const MIN_PASSWORD_LENGTH = 10;

// One message for every state in which activation is refused — a second attempt, a login
// that does not exist, a database that already has more than the bootstrap user. Telling
// them apart would let the endpoint confirm which logins exist.
const ACTIVATION_REFUSED = 'Activation is not available';

// The same rule for the login path: a wrong password, an unknown login and an account that
// may not sign in all answer this.
const LOGIN_REFUSED = 'Invalid login or password';
const NOT_AUTHENTICATED = 'Authentication required';

const LOGIN_TAKEN = 'A user with this login already exists';
const USER_NOT_FOUND = 'Auth user not found';
const ROLE_REQUIRED = 'A user must hold at least one role';
const SELF_DEMOTION_REFUSED =
  'You cannot remove your own system_admin role — ask another system administrator to do it';
const SELF_DISABLE_REFUSED =
  'You cannot disable your own account — ask another system administrator to do it';

// The role that manages accounts. Named here because the self-demotion rule is about this
// role specifically: losing `parking_admin` is an inconvenience, losing the last way into
// user management is a locked door.
const SYSTEM_ADMIN_ROLE = 'system_admin';

const SESSION_TTL_SECONDS = 43200; // 12 hours — one working day plus the evening jobs.
const SESSION_TOKEN_BYTES = 32;

// 32 random bytes as the cookie value; the database stores only the SHA-256 of it, which is
// what `auth_sessions_token_hash_uniq` indexes. A database dump therefore does not hand over
// live sessions, and a stolen hash cannot be replayed as a cookie.
function createSessionToken() {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

// `ip_address` is `inet`, so a value Postgres cannot parse would turn a login into a 500.
// `req.socket.remoteAddress` is normally an address but need not be one (a UNIX socket has
// none), and the column is diagnostic rather than load-bearing.
function normalizeIpAddress(value) {
  return typeof value === 'string' && net.isIP(value) !== 0 ? value : null;
}

function createAuthService({ dbRepository, pool }) {
  // A syntactically valid stored hash that no password matches, built once per process and
  // reused. The login path verifies against it whenever there is no usable credential, so a
  // refusal costs the same scrypt as an acceptance: without it, an unknown login would answer
  // measurably faster than a wrong password and the endpoint would enumerate logins by timing.
  let decoyHashPromise = null;

  function decoyHash() {
    if (!decoyHashPromise) {
      decoyHashPromise = hashPassword(crypto.randomBytes(32).toString('base64'));
    }

    return decoyHashPromise;
  }

  // First-run activation: the bootstrap `sysadmin` seeded by 001_bootstrap_system_admin.sql
  // has a placeholder hash, and this is how it gets a real one. Allowed only while the
  // database holds exactly one auth user and it is still `invited`; after that, passwords are
  // set by a system_admin. The rule is enforced here, not in the UI.
  async function activate({ login, password }) {
    // Hashed before the transaction opens: scrypt is the slow part, and the rows stay locked
    // only for the check and the write. It also means a refused attempt costs the same as an
    // accepted one.
    const passwordHash = await hashPassword(password);

    return withTransaction(pool, async (repo) => {
      const users = await repository.lockAllAuthUsers(repo);
      const [user] = users;

      if (users.length !== 1 || user.status !== 'invited' || user.login.toLowerCase() !== login.toLowerCase()) {
        throw abortWith(409, ACTIVATION_REFUSED);
      }

      const activated = await repository.activateAuthUser(repo, { id: user.id, passwordHash });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'auth_user',
        entityId: activated.id,
        action: 'auth_user_activated',
        actorAuthUserId: activated.id,
        actorService: 'admin-ui',
        metadata: { login: activated.login }
      });

      return activated;
    });
  }

  // Verifies the password and opens a session. The verify runs on every path, including the
  // ones that are already lost, which is why the decoy hash exists above — the refusal is one
  // message and one timing profile whatever the real reason was.
  async function login({ login: rawLogin, password, ipAddress, userAgent }) {
    const user = await repository.findAuthUserByLogin(dbRepository, rawLogin);
    const canSignIn = Boolean(user) && user.status === 'active';
    const stored = canSignIn ? user.password_hash : await decoyHash();
    const passwordMatches = await verifyPassword(password, stored);

    if (!canSignIn || !passwordMatches) {
      throw abortWith(401, LOGIN_REFUSED);
    }

    const token = createSessionToken();

    const session = await withTransaction(pool, async (repo) => {
      const inserted = await repository.insertSession(repo, {
        authUserId: user.id,
        tokenHash: hashSessionToken(token),
        ttlSeconds: SESSION_TTL_SECONDS,
        ipAddress: normalizeIpAddress(ipAddress),
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent.slice(0, 500) : null
      });

      await repository.markLastLogin(repo, user.id);

      return inserted;
    });

    const roles = await repository.listRoleCodes(dbRepository, user.id);

    return {
      token,
      expiresAt: session.expires_at,
      user: { id: user.id, login: user.login, displayName: user.display_name, status: user.status },
      roles
    };
  }

  // Resolves a cookie value to the operator behind it, or to null. Null is the answer for
  // every failure — no cookie, a value that hashes to nothing, a session past `expires_at`,
  // a revoked one, a user that has since been disabled or deleted — because the caller (the
  // router's guard, from Task 3 on) must not be able to act on a half-resolved session.
  async function resolveSession(token) {
    if (typeof token !== 'string' || token.length === 0) {
      return null;
    }

    const row = await repository.touchLiveSession(dbRepository, hashSessionToken(token));

    if (!row || row.status !== 'active') {
      return null;
    }

    return {
      session: { id: row.session_id, expiresAt: row.expires_at },
      authUser: {
        id: row.auth_user_id,
        login: row.login,
        displayName: row.display_name,
        status: row.status
      },
      roles: row.role_codes || []
    };
  }

  // Idempotent: logging out twice, or with a cookie that resolves to nothing, is not an error.
  // The caller clears the cookie either way, so the browser ends up in the same state.
  async function logout(token) {
    if (typeof token !== 'string' || token.length === 0) {
      return { revoked: false };
    }

    const revoked = await repository.revokeSessionByTokenHash(dbRepository, hashSessionToken(token));

    return { revoked: Boolean(revoked) };
  }

  // --- user management (Task 5) -------------------------------------------------------------
  //
  // Reached only by a `system_admin` — the router refuses everyone else before a handler runs,
  // so nothing below re-checks the caller's role. What it does check is the two mistakes the
  // role cannot protect against: an administrator removing their own `system_admin` role, and
  // one disabling their own account. Both would leave the system with one fewer way in and,
  // with a single administrator, with none at all.

  // Every user carries at least one role. The router treats a closed route without a `roles`
  // list as "any signed-in operator", so a user with no roles would still reach every parking
  // endpoint — "no access" has to be `disabled`, not an empty role set.
  async function resolveRoles(repo, roleCodes) {
    if (roleCodes.length === 0) {
      throw abortWith(400, ROLE_REQUIRED);
    }

    const roles = await repository.findRolesByCodes(repo, roleCodes);

    if (roles.length !== roleCodes.length) {
      const known = new Set(roles.map((role) => role.code));
      const unknown = roleCodes.filter((code) => !known.has(code));

      throw abortWith(400, `Unknown role: ${unknown.join(', ')}`);
    }

    return roles;
  }

  function rolePayload(roles) {
    return roles.map((role) => ({ code: role.code, name: role.name }));
  }

  async function auditUserChange(repo, { actor, user, action, metadata }) {
    await auditRepository.insertAuditLog(repo, {
      entityType: 'auth_user',
      entityId: user.id,
      action,
      actorAuthUserId: actor ? actor.id : null,
      actorService: 'admin-ui',
      metadata: { login: user.login, ...metadata }
    });
  }

  async function createUser({ actor, login, displayName, password, roleCodes }) {
    // Outside the transaction: scrypt is the slow part and the rows below stay locked only
    // for the check and the writes.
    const passwordHash = await hashPassword(password);

    return withTransaction(pool, async (repo) => {
      const existing = await repository.findAnyAuthUserByLogin(repo, login);

      if (existing) {
        throw abortWith(409, LOGIN_TAKEN);
      }

      const roles = await resolveRoles(repo, roleCodes);
      // `active`, not `invited`: the password is set here, so there is nothing left to
      // activate. `invited` exists for the seeded bootstrap user, whose hash is a placeholder.
      const user = await repository.insertAuthUser(repo, {
        login,
        displayName,
        passwordHash,
        status: 'active'
      });

      await repository.replaceAuthUserRoles(repo, {
        authUserId: user.id,
        roleIds: roles.map((role) => role.id),
        createdByAuthUserId: actor ? actor.id : null
      });

      await auditUserChange(repo, {
        actor,
        user,
        action: 'auth_user_created',
        metadata: { displayName: user.display_name, roles: roles.map((role) => role.code) }
      });

      return { user, roles: rolePayload(roles) };
    });
  }

  async function setUserRoles({ actor, authUserId, roleCodes }) {
    return withTransaction(pool, async (repo) => {
      const user = await repository.lockAuthUserById(repo, authUserId);

      if (!user) {
        throw abortWith(404, USER_NOT_FOUND);
      }

      const roles = await resolveRoles(repo, roleCodes);

      if (actor && actor.id === user.id && !roles.some((role) => role.code === SYSTEM_ADMIN_ROLE)) {
        throw abortWith(409, SELF_DEMOTION_REFUSED);
      }

      await repository.replaceAuthUserRoles(repo, {
        authUserId: user.id,
        roleIds: roles.map((role) => role.id),
        createdByAuthUserId: actor ? actor.id : null
      });

      await auditUserChange(repo, {
        actor,
        user,
        action: 'auth_user_roles_set',
        metadata: { roles: roles.map((role) => role.code) }
      });

      return { user, roles: rolePayload(roles) };
    });
  }

  async function setUserPassword({ actor, authUserId, password }) {
    const passwordHash = await hashPassword(password);

    return withTransaction(pool, async (repo) => {
      const user = await repository.lockAuthUserById(repo, authUserId);

      if (!user) {
        throw abortWith(404, USER_NOT_FOUND);
      }

      // An `invited` user cannot sign in, so setting their password and leaving the status
      // alone would hand the operator a credential that does not work. A `disabled` user
      // stays disabled: the password is not what is stopping them.
      const activated = user.status === 'invited';
      const updated = await repository.setAuthUserPassword(repo, {
        id: user.id,
        passwordHash,
        status: activated ? 'active' : null
      });

      await auditUserChange(repo, {
        actor,
        user,
        action: 'auth_user_password_set',
        metadata: { activated }
      });

      return { user: updated, roles: rolePayload(await repository.listAuthUserRoles(repo, user.id)) };
    });
  }

  // `disabled` → the account is refused at login and its live sessions are revoked in the
  // same transaction, so the change takes effect now rather than at the next expiry.
  // `active` → the account is usable again; the revoked sessions stay revoked and the
  // operator signs in anew, which is the honest meaning of "re-enable".
  async function setUserStatus({ actor, authUserId, status }) {
    return withTransaction(pool, async (repo) => {
      const user = await repository.lockAuthUserById(repo, authUserId);

      if (!user) {
        throw abortWith(404, USER_NOT_FOUND);
      }

      if (status === 'disabled' && actor && actor.id === user.id) {
        throw abortWith(409, SELF_DISABLE_REFUSED);
      }

      const updated = await repository.setAuthUserStatus(repo, { id: user.id, status });
      const revoked = status === 'disabled' ? await repository.revokeSessionsForAuthUser(repo, user.id) : [];

      await auditUserChange(repo, {
        actor,
        user,
        action: status === 'disabled' ? 'auth_user_disabled' : 'auth_user_enabled',
        metadata: { revokedSessions: revoked.length }
      });

      return {
        user: updated,
        roles: rolePayload(await repository.listAuthUserRoles(repo, user.id)),
        revokedSessions: revoked.length
      };
    });
  }

  return {
    activate,
    createUser,
    login,
    logout,
    resolveSession,
    setUserPassword,
    setUserRoles,
    setUserStatus
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  NOT_AUTHENTICATED,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  SYSTEM_ADMIN_ROLE,
  createAuthService
};
