'use strict';

// Auth context — credentials and, from Task 2 on, sessions. Every function takes the query
// surface as its first argument, like every other repository here (ADR 003).

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

module.exports = {
  activateAuthUser,
  lockAllAuthUsers
};
