BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE user_kind AS ENUM ('employee', 'guest');
CREATE TYPE auth_user_status AS ENUM ('active', 'disabled', 'invited');
CREATE TYPE vehicle_status AS ENUM ('active', 'inactive');
CREATE TYPE parking_place_type AS ENUM ('single', 'double', 'triple');
CREATE TYPE assignment_source AS ENUM ('manual', 'auto', 'queue', 'guest', 'permanent');
CREATE TYPE reservation_status AS ENUM ('active', 'canceled', 'completed');
CREATE TYPE request_status AS ENUM ('active', 'queued', 'assigned', 'canceled', 'rejected');
CREATE TYPE queue_status AS ENUM ('waiting', 'processed', 'skipped', 'assigned', 'canceled');
CREATE TYPE release_status AS ENUM ('active', 'partially_canceled', 'canceled', 'frozen');
CREATE TYPE movement_type AS ENUM ('manual_reassign', 'auto_reassign', 'queue_assignment', 'guest_assignment', 'admin_override');
CREATE TYPE occupancy_subject_type AS ENUM ('employee', 'guest');
CREATE TYPE map_file_type AS ENUM ('pdf', 'svg', 'png', 'jpg', 'webp');
CREATE TYPE audit_entity_type AS ENUM (
  'auth_user',
  'user',
  'vehicle',
  'parking_place',
  'parking_place_map',
  'parking_place_map_zone',
  'permanent_assignment',
  'place_release',
  'employee_parking_request',
  'guest_parking_request',
  'reservation',
  'reservation_event',
  'parking_movement',
  'queue_entry',
  'departure_plan',
  'line_occupancy',
  'contact_access_log',
  'system'
);

CREATE TABLE auth_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status auth_user_status NOT NULL DEFAULT 'invited',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT auth_users_login_lower_uniq UNIQUE (lower(login))
);

CREATE TABLE auth_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_roles_code_uniq UNIQUE (code)
);

CREATE TABLE auth_user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  auth_role_id uuid NOT NULL REFERENCES auth_roles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  CONSTRAINT auth_user_roles_uniq UNIQUE (auth_user_id, auth_role_id)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  session_token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_token_hash_uniq UNIQUE (session_token_hash)
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind user_kind NOT NULL DEFAULT 'employee',
  employee_no text,
  first_name text NOT NULL,
  last_name text NOT NULL,
  middle_name text,
  display_name text NOT NULL,
  email text,
  phone text,
  department text,
  yandex_messenger_user_id text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT users_employee_no_uniq UNIQUE NULLS DISTINCT (employee_no),
  CONSTRAINT users_email_uniq UNIQUE NULLS DISTINCT (email),
  CONSTRAINT users_yandex_messenger_user_id_uniq UNIQUE NULLS DISTINCT (yandex_messenger_user_id)
);

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate_number text NOT NULL,
  brand text,
  model text,
  color text,
  is_primary boolean NOT NULL DEFAULT false,
  status vehicle_status NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT vehicles_plate_number_uniq UNIQUE (plate_number)
);

CREATE UNIQUE INDEX vehicles_one_primary_per_user_idx
  ON vehicles (user_id)
  WHERE is_primary = true AND deleted_at IS NULL;

CREATE TABLE line_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  capacity integer NOT NULL CHECK (capacity IN (2, 3)),
  floor_label text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT line_groups_code_uniq UNIQUE (code)
);

CREATE TABLE parking_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  title text NOT NULL,
  floor_label text,
  place_type parking_place_type NOT NULL,
  line_group_id uuid REFERENCES line_groups(id) ON DELETE SET NULL,
  line_position_hint smallint,
  guest_priority_rank smallint,
  is_active boolean NOT NULL DEFAULT true,
  catalog_source text,
  catalog_external_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT parking_places_code_uniq UNIQUE (code),
  CONSTRAINT parking_places_line_position_hint_chk CHECK (
    line_position_hint IS NULL OR line_position_hint BETWEEN 1 AND 3
  )
);

CREATE TABLE parking_place_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  title text NOT NULL,
  floor_label text NOT NULL,
  file_type map_file_type NOT NULL,
  file_path text NOT NULL,
  source_checksum text,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT parking_place_maps_code_uniq UNIQUE (code)
);

CREATE TABLE parking_place_map_zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parking_place_map_id uuid NOT NULL REFERENCES parking_place_maps(id) ON DELETE CASCADE,
  parking_place_id uuid NOT NULL REFERENCES parking_places(id) ON DELETE CASCADE,
  zone_key text NOT NULL,
  geometry jsonb NOT NULL,
  label_x numeric(10, 2),
  label_y numeric(10, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parking_place_map_zones_zone_key_uniq UNIQUE (parking_place_map_id, zone_key),
  CONSTRAINT parking_place_map_zones_place_map_uniq UNIQUE (parking_place_map_id, parking_place_id)
);

CREATE TABLE permanent_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parking_place_id uuid NOT NULL REFERENCES parking_places(id) ON DELETE RESTRICT,
  valid_during daterange NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  notes text,
  CONSTRAINT permanent_assignments_valid_during_not_empty CHECK (NOT isempty(valid_during))
);

CREATE INDEX permanent_assignments_user_range_idx
  ON permanent_assignments USING gist (user_id, valid_during);

CREATE INDEX permanent_assignments_place_range_idx
  ON permanent_assignments USING gist (parking_place_id, valid_during);

ALTER TABLE permanent_assignments
  ADD CONSTRAINT permanent_assignments_user_no_overlap_excl
  EXCLUDE USING gist (user_id WITH =, valid_during WITH &&);

ALTER TABLE permanent_assignments
  ADD CONSTRAINT permanent_assignments_place_no_overlap_excl
  EXCLUDE USING gist (parking_place_id WITH =, valid_during WITH &&);

CREATE TABLE place_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  parking_place_id uuid NOT NULL REFERENCES parking_places(id) ON DELETE RESTRICT,
  release_during daterange NOT NULL,
  status release_status NOT NULL DEFAULT 'active',
  created_via text NOT NULL DEFAULT 'bot',
  frozen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  notes text,
  CONSTRAINT place_releases_release_during_not_empty CHECK (NOT isempty(release_during))
);

CREATE INDEX place_releases_user_range_idx
  ON place_releases USING gist (user_id, release_during);

CREATE INDEX place_releases_place_range_idx
  ON place_releases USING gist (parking_place_id, release_during);

CREATE TABLE employee_parking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_date date NOT NULL,
  status request_status NOT NULL DEFAULT 'active',
  requested_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  assigned_reservation_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX employee_parking_requests_active_user_date_uniq
  ON employee_parking_requests (user_id, request_date)
  WHERE status IN ('active', 'queued', 'assigned');

CREATE TABLE guest_parking_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  host_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_date date NOT NULL,
  status request_status NOT NULL DEFAULT 'active',
  guest_name text NOT NULL,
  guest_phone text,
  vehicle_plate_number text,
  assigned_reservation_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  notes text
);

CREATE UNIQUE INDEX guest_parking_requests_active_guest_date_uniq
  ON guest_parking_requests (guest_user_id, request_date)
  WHERE status IN ('active', 'queued', 'assigned');

CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_date date NOT NULL,
  parking_place_id uuid NOT NULL REFERENCES parking_places(id) ON DELETE RESTRICT,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  guest_parking_request_id uuid REFERENCES guest_parking_requests(id) ON DELETE SET NULL,
  employee_parking_request_id uuid REFERENCES employee_parking_requests(id) ON DELETE SET NULL,
  source assignment_source NOT NULL,
  status reservation_status NOT NULL DEFAULT 'active',
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  completed_at timestamptz,
  CHECK (user_id IS NOT NULL OR guest_parking_request_id IS NOT NULL)
);

CREATE UNIQUE INDEX reservations_active_place_date_uniq
  ON reservations (parking_place_id, reservation_date)
  WHERE status = 'active';

CREATE UNIQUE INDEX reservations_active_user_date_uniq
  ON reservations (user_id, reservation_date)
  WHERE status = 'active' AND user_id IS NOT NULL;

CREATE UNIQUE INDEX reservations_active_guest_request_uniq
  ON reservations (guest_parking_request_id)
  WHERE status = 'active' AND guest_parking_request_id IS NOT NULL;

CREATE UNIQUE INDEX reservations_active_employee_request_uniq
  ON reservations (employee_parking_request_id)
  WHERE status = 'active' AND employee_parking_request_id IS NOT NULL;

ALTER TABLE employee_parking_requests
  ADD CONSTRAINT employee_parking_requests_assigned_reservation_fk
  FOREIGN KEY (assigned_reservation_id) REFERENCES reservations(id) ON DELETE SET NULL;

ALTER TABLE guest_parking_requests
  ADD CONSTRAINT guest_parking_requests_assigned_reservation_fk
  FOREIGN KEY (assigned_reservation_id) REFERENCES reservations(id) ON DELETE SET NULL;

CREATE TABLE reservation_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source assignment_source,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reservation_events_reservation_id_created_at_idx
  ON reservation_events (reservation_id, created_at DESC);

CREATE TABLE parking_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  movement_date date NOT NULL,
  from_parking_place_id uuid REFERENCES parking_places(id) ON DELETE RESTRICT,
  to_parking_place_id uuid NOT NULL REFERENCES parking_places(id) ON DELETE RESTRICT,
  movement_type movement_type NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parking_movements_from_to_diff_chk CHECK (
    from_parking_place_id IS NULL OR from_parking_place_id <> to_parking_place_id
  )
);

CREATE TABLE queue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_parking_request_id uuid NOT NULL REFERENCES employee_parking_requests(id) ON DELETE CASCADE,
  queue_date date NOT NULL,
  queue_position integer NOT NULL CHECK (queue_position > 0),
  status queue_status NOT NULL DEFAULT 'waiting',
  processed_at timestamptz,
  assigned_reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_entries_request_uniq UNIQUE (employee_parking_request_id),
  CONSTRAINT queue_entries_position_uniq UNIQUE (queue_date, queue_position)
);

CREATE TABLE departure_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_date date NOT NULL,
  departure_time time NOT NULL,
  is_early boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  CONSTRAINT departure_plans_user_date_uniq UNIQUE (user_id, plan_date)
);

CREATE TABLE line_occupancy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occupancy_date date NOT NULL,
  line_group_id uuid NOT NULL REFERENCES line_groups(id) ON DELETE RESTRICT,
  parking_place_id uuid NOT NULL REFERENCES parking_places(id) ON DELETE RESTRICT,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  subject_type occupancy_subject_type NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  guest_parking_request_id uuid REFERENCES guest_parking_requests(id) ON DELETE RESTRICT,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  CHECK (
    (subject_type = 'employee' AND user_id IS NOT NULL AND guest_parking_request_id IS NULL)
    OR
    (subject_type = 'guest' AND guest_parking_request_id IS NOT NULL)
  ),
  CONSTRAINT line_occupancy_line_position_uniq UNIQUE (occupancy_date, line_group_id, position),
  CONSTRAINT line_occupancy_place_date_uniq UNIQUE (occupancy_date, parking_place_id)
);

CREATE TABLE contact_access_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  occupancy_date date NOT NULL,
  line_group_id uuid REFERENCES line_groups(id) ON DELETE SET NULL,
  target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_guest_parking_request_id uuid REFERENCES guest_parking_requests(id) ON DELETE SET NULL,
  resolution text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type audit_entity_type NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_auth_user_id uuid REFERENCES auth_users(id) ON DELETE SET NULL,
  actor_service text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_logs_entity_idx
  ON audit_logs (entity_type, entity_id, occurred_at DESC);

CREATE INDEX audit_logs_actor_auth_idx
  ON audit_logs (actor_auth_user_id, occurred_at DESC);

CREATE INDEX audit_logs_actor_user_idx
  ON audit_logs (actor_user_id, occurred_at DESC);

INSERT INTO auth_roles (code, name, description)
VALUES
  ('system_admin', 'System Administrator', 'Manages web UI accounts and role assignments'),
  ('parking_admin', 'Parking Administrator', 'Operates parking assignments, guests, queue, maps, and audit');

COMMIT;
