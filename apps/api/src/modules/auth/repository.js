'use strict';

// Auth context — credentials and sessions. Every function takes the query surface as its
// first argument, like every other repository here (ADR 003).

// Every auth user, deleted or not, locked for the rest of the transaction. First-run
// activation is allowed only while the table holds exactly one row, so the count must not
// be able to change underneath the check: the row lock serialises two activations racing
// for the same bootstrap user, and the second one re-reads it as already `active`.
async function lockAllAuthUsers(db) {
  return db.queryMany(
    `
      select id, login, display_name, status
      from auth_users
      order by created_at, id
      for update
    `
  );
}

async function activateAuthUser(db, { id, passwordHash }) {
  return db.queryOne(
    `
      update auth_users
      set password_hash = $2,
          status = 'active',
          updated_at = now()
      where id = $1
      returning id, login, display_name, status
    `,
    [id, passwordHash]
  );
}

// The login path's only read. `password_hash` leaves the repository because verification is
// the service's job — the comparison is `timingSafeEqual` in packages/shared/passwords.js —
// and it must never leave the service.
async function findAuthUserByLogin(db, login) {
  return db.queryOne(
    `
      select id, login, display_name, status, password_hash
      from auth_users
      where lower(login) = lower($1)
        and deleted_at is null
    `,
    [login]
  );
}

async function listRoleCodes(db, authUserId) {
  const rows = await db.queryMany(
    `
      select ar.code
      from auth_user_roles aur
      join auth_roles ar on ar.id = aur.auth_role_id
      where aur.auth_user_id = $1
      order by ar.code
    `,
    [authUserId]
  );

  return rows.map((row) => row.code);
}

async function markLastLogin(db, id) {
  return db.queryOne(
    `
      update auth_users
      set last_login_at = now(),
          updated_at = now()
      where id = $1
      returning id, login, display_name, status, last_login_at
    `,
    [id]
  );
}

// `expires_at` is computed from the database clock, the same clock the expiry check below
// reads, so an app server whose clock drifts cannot hand out a session that is already dead
// or one that outlives its window.
async function insertSession(db, { authUserId, tokenHash, ttlSeconds, ipAddress, userAgent }) {
  return db.queryOne(
    `
      insert into auth_sessions (
        auth_user_id,
        session_token_hash,
        expires_at,
        last_seen_at,
        ip_address,
        user_agent
      )
      values ($1, $2, now() + make_interval(secs => $3::double precision), now(), $4, $5)
      returning id, auth_user_id, expires_at
    `,
    [authUserId, tokenHash, ttlSeconds, ipAddress, userAgent]
  );
}

// Resolve, touch and read the operator in one statement. The `where` clause is the expiry
// and revocation check, so a row comes back only if the session is still live; doing it as an
// update means a resolve cannot race the revocation it is checking for. One round trip
// matters here more than anywhere else: from Task 3 on, this runs on every request.
async function touchLiveSession(db, tokenHash) {
  return db.queryOne(
    `
      with live as (
        update auth_sessions
        set last_seen_at = now()
        where session_token_hash = $1
          and revoked_at is null
          and expires_at > now()
        returning id, auth_user_id, expires_at
      )
      select
        live.id as session_id,
        live.expires_at,
        au.id as auth_user_id,
        au.login,
        au.display_name,
        au.status,
        coalesce(
          array_agg(ar.code order by ar.code) filter (where ar.code is not null),
          '{}'::text[]
        ) as role_codes
      from live
      join auth_users au on au.id = live.auth_user_id and au.deleted_at is null
      left join auth_user_roles aur on aur.auth_user_id = au.id
      left join auth_roles ar on ar.id = aur.auth_role_id
      group by live.id, live.expires_at, au.id, au.login, au.display_name, au.status
    `,
    [tokenHash]
  );
}

async function revokeSessionByTokenHash(db, tokenHash) {
  return db.queryOne(
    `
      update auth_sessions
      set revoked_at = now()
      where session_token_hash = $1
        and revoked_at is null
      returning id, auth_user_id
    `,
    [tokenHash]
  );
}

module.exports = {
  activateAuthUser,
  findAuthUserByLogin,
  insertSession,
  listRoleCodes,
  lockAllAuthUsers,
  markLastLogin,
  revokeSessionByTokenHash,
  touchLiveSession
};
