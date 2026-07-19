-- Demo dataset teardown.
--
-- Removes every row the demo dataset created and nothing else. Demo rows are recognised by
-- a tag on their owning table, never by id:
--
--   users              email like '%@demo.invalid'
--   parking_places     catalog_source = 'demo'
--   line_groups        code like 'demo-%'
--   parking_place_maps source_checksum = 'demo'
--   audit_logs         actor_service = 'db_seed_demo'
--
-- Everything else (imported catalogs, real employees, the bootstrap system admin) is left
-- untouched. Running this against a database with no demo data is a no-op.
--
-- Deletion order follows the ON DELETE RESTRICT edges: line occupancy and reservations
-- must go before the users and places they point at.

BEGIN;

CREATE TEMP TABLE demo_reset_users ON COMMIT DROP AS
  SELECT id FROM users WHERE email LIKE '%@demo.invalid';

CREATE TEMP TABLE demo_reset_places ON COMMIT DROP AS
  SELECT id FROM parking_places WHERE catalog_source = 'demo';

DELETE FROM contact_access_logs
WHERE requester_user_id IN (SELECT id FROM demo_reset_users)
   OR target_user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM line_occupancy
WHERE parking_place_id IN (SELECT id FROM demo_reset_places)
   OR user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM departure_plans
WHERE user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM queue_entries
WHERE employee_parking_request_id IN (
  SELECT id FROM employee_parking_requests WHERE user_id IN (SELECT id FROM demo_reset_users)
);

-- reservation_events and parking_movements cascade from reservations.
DELETE FROM reservations
WHERE parking_place_id IN (SELECT id FROM demo_reset_places)
   OR user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM employee_parking_requests
WHERE user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM guest_parking_requests
WHERE guest_user_id IN (SELECT id FROM demo_reset_users)
   OR host_user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM place_releases
WHERE user_id IN (SELECT id FROM demo_reset_users)
   OR parking_place_id IN (SELECT id FROM demo_reset_places);

DELETE FROM permanent_assignments
WHERE user_id IN (SELECT id FROM demo_reset_users)
   OR parking_place_id IN (SELECT id FROM demo_reset_places);

DELETE FROM audit_logs
WHERE actor_service = 'db_seed_demo';

DELETE FROM parking_place_map_zones
WHERE parking_place_id IN (SELECT id FROM demo_reset_places);

DELETE FROM parking_place_maps
WHERE source_checksum = 'demo';

DELETE FROM vehicles
WHERE user_id IN (SELECT id FROM demo_reset_users);

DELETE FROM users
WHERE id IN (SELECT id FROM demo_reset_users);

DELETE FROM parking_places
WHERE id IN (SELECT id FROM demo_reset_places);

DELETE FROM line_groups
WHERE code LIKE 'demo-%';

COMMIT;
