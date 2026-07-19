'use strict';

// System context — the liveness/bootstrap reads that belong to no business context:
// the database health probe and the `auth_users` bootstrap state. Authentication itself
// is deferred post-MVP; this is only what the health endpoints and the users list read.

async function selectDatabaseIdentity(db) {
  return db.queryOne('select current_database() as database, now() as server_time, 1 as ok');
}

async function findBootstrapSysadmin(db) {
  return db.queryOne(
    `
      select
        au.id,
        au.login,
        au.display_name,
        au.status,
        count(aur.id) filter (where ar.code = 'system_admin') as system_admin_role_count
      from auth_users au
      left join auth_user_roles aur on aur.auth_user_id = au.id
      left join auth_roles ar on ar.id = aur.auth_role_id
      where lower(au.login) = 'sysadmin'
      group by au.id, au.login, au.display_name, au.status
    `
  );
}

async function listAuthUsers(db) {
  return db.queryMany(
    `
      select
        au.id,
        au.login,
        au.display_name,
        au.status,
        au.last_login_at,
        au.created_at,
        coalesce(
          json_agg(
            json_build_object(
              'code', ar.code,
              'name', ar.name
            )
            order by ar.code
          ) filter (where ar.id is not null),
          '[]'::json
        ) as roles
      from auth_users au
      left join auth_user_roles aur on aur.auth_user_id = au.id
      left join auth_roles ar on ar.id = aur.auth_role_id
      where au.deleted_at is null
      group by au.id, au.login, au.display_name, au.status, au.last_login_at, au.created_at
      order by lower(au.login)
    `
  );
}

module.exports = {
  findBootstrapSysadmin,
  listAuthUsers,
  selectDatabaseIdentity
};
