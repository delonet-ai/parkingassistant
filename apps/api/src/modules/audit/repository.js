'use strict';

// Audit context — every write to `audit_logs` and the audit journal reads.
//
// Every repository function in this project takes the query surface as its first
// argument (`db`), so the same function serves a pool-bound repository and the
// client-bound one `withTransaction` yields. See ADR 003.

// One insert shape for all 27 audit call sites the monolith used to carry.
// `actor_user_id` is written explicitly rather than omitted: the column is nullable
// and an explicit null is what the omitting variants produced anyway.
async function insertAuditLog(db, { entityType, entityId = null, action, actorUserId = null, actorService, metadata = {} }) {
  return db.queryOne(
    `
      insert into audit_logs (
        entity_type,
        entity_id,
        action,
        actor_user_id,
        actor_service,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6::jsonb)
      returning id
    `,
    [entityType, entityId, action, actorUserId, actorService, JSON.stringify(metadata)]
  );
}

// The filters are optional and combine, so the where clause is assembled here rather
// than in the caller: building SQL text is repository work even when it is conditional.
async function listAuditLogs(db, { date, entityType, entityId, action, actor, limit }) {
  const where = [];
  const params = [];

  if (date) {
    params.push(date);
    where.push(`al.occurred_at >= $${params.length}::date and al.occurred_at < ($${params.length}::date + interval '1 day')`);
  }

  if (entityType) {
    params.push(entityType);
    where.push(`al.entity_type = $${params.length}`);
  }

  if (entityId) {
    params.push(entityId);
    where.push(`al.entity_id = $${params.length}::uuid`);
  }

  if (action) {
    params.push(`%${action}%`);
    where.push(`al.action ilike $${params.length}`);
  }

  if (actor) {
    params.push(`%${actor}%`);
    where.push(`(
      al.actor_service ilike $${params.length}
      or actor_user.display_name ilike $${params.length}
      or actor_auth.login ilike $${params.length}
      or actor_auth.display_name ilike $${params.length}
    )`);
  }

  params.push(limit);

  return db.queryMany(
    `
      select
        al.id,
        al.entity_type,
        al.entity_id,
        al.action,
        al.actor_service,
        al.actor_user_id,
        actor_user.display_name as actor_user_display_name,
        al.actor_auth_user_id,
        actor_auth.login as actor_auth_login,
        actor_auth.display_name as actor_auth_display_name,
        al.occurred_at,
        al.metadata
      from audit_logs al
      left join users actor_user on actor_user.id = al.actor_user_id
      left join auth_users actor_auth on actor_auth.id = al.actor_auth_user_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by al.occurred_at desc
      limit $${params.length}
    `,
    params
  );
}


// The journal projection the three history readers share.
const AUDIT_JOURNAL_SELECT = `
      select
        al.id,
        al.entity_type,
        al.entity_id,
        al.action,
        al.actor_service,
        al.actor_user_id,
        actor_user.display_name as actor_user_display_name,
        al.actor_auth_user_id,
        actor_auth.login as actor_auth_login,
        actor_auth.display_name as actor_auth_display_name,
        al.occurred_at,
        al.metadata
      from audit_logs al
      left join users actor_user on actor_user.id = al.actor_user_id
      left join auth_users actor_auth on actor_auth.id = al.actor_auth_user_id
`;

// Rows about a place are found both by entity id and by the place id recorded in the
// metadata of events whose entity is something else (a reservation, a release).
async function listAuditLogsForPlace(db, placeId) {
  return db.queryMany(
    `
      ${AUDIT_JOURNAL_SELECT}
      where al.entity_id = $1
         or al.metadata->>'parkingPlaceId' = $1::text
      order by al.occurred_at desc
      limit 100
    `,
    [placeId]
  );
}

async function listAuditLogsForUser(db, userId) {
  return db.queryMany(
    `
      ${AUDIT_JOURNAL_SELECT}
      where al.entity_id = $1
         or al.actor_user_id = $1
         or al.metadata->>'userId' = $1::text
         or al.metadata->>'hostUserId' = $1::text
      order by al.occurred_at desc
      limit 100
    `,
    [userId]
  );
}

// unlock-employee-pool is idempotent by looking for its own audit row rather than by a
// state column: the job writes no reservations, so the journal is the only record that
// this date has already been settled.
async function findEmployeePoolUnlockedLog(db, targetDate) {
  return db.queryOne(
    `
      select id
      from audit_logs
      where action = 'employee_pool_unlocked'
        and metadata->>'targetDate' = $1
      limit 1
    `,
    [targetDate]
  );
}

module.exports = {
  findEmployeePoolUnlockedLog,
  insertAuditLog,
  listAuditLogs,
  listAuditLogsForPlace,
  listAuditLogsForUser
};
