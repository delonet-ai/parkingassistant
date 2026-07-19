'use strict';

// Row → JSON for audit_logs. Shared by the audit list and the two history journals.

function mapAuditLog(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actorService: row.actor_service,
    actorUser: row.actor_user_id
      ? {
          id: row.actor_user_id,
          displayName: row.actor_user_display_name
        }
      : null,
    actorAuthUser: row.actor_auth_user_id
      ? {
          id: row.actor_auth_user_id,
          login: row.actor_auth_login,
          displayName: row.actor_auth_display_name
        }
      : null,
    occurredAt: row.occurred_at,
    metadata: row.metadata || {}
  };
}

module.exports = {
  mapAuditLog
};
