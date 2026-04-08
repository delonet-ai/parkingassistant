\set ON_ERROR_STOP on

BEGIN;

WITH upsert_user AS (
  INSERT INTO auth_users (
    login,
    password_hash,
    display_name,
    status
  )
  VALUES (
    'sysadmin',
    '{PENDING_IMPLEMENTATION}',
    'Initial System Administrator',
    'invited'
  )
  ON CONFLICT ((lower(login))) DO UPDATE
    SET display_name = EXCLUDED.display_name,
        updated_at = now()
  RETURNING id
),
resolved_user AS (
  SELECT id FROM upsert_user
  UNION ALL
  SELECT id
  FROM auth_users
  WHERE lower(login) = 'sysadmin'
  LIMIT 1
),
resolved_role AS (
  SELECT id
  FROM auth_roles
  WHERE code = 'system_admin'
)
INSERT INTO auth_user_roles (
  auth_user_id,
  auth_role_id
)
SELECT resolved_user.id, resolved_role.id
FROM resolved_user
CROSS JOIN resolved_role
ON CONFLICT (auth_user_id, auth_role_id) DO NOTHING;

INSERT INTO audit_logs (
  entity_type,
  entity_id,
  action,
  actor_service,
  metadata
)
SELECT
  'auth_user',
  id,
  'bootstrap_system_admin_seeded',
  'db_seed',
  jsonb_build_object(
    'login', login,
    'note', 'Password hash is placeholder until auth implementation is finalized'
  )
FROM auth_users
WHERE lower(login) = 'sysadmin'
AND NOT EXISTS (
  SELECT 1
  FROM audit_logs
  WHERE entity_type = 'auth_user'
    AND action = 'bootstrap_system_admin_seeded'
    AND entity_id = auth_users.id
);

COMMIT;
