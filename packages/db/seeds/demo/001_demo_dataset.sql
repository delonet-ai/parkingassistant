-- Demo dataset for the test stand.
--
-- Loads a small but complete parking day so every admin tab renders real content:
-- lines of each size, employees with and without a permanent place, permanent
-- assignments, active releases, an employee request that went through the queue, a
-- pending one, an assigned guest request, a pending one, reservations, departure plans
-- (one of them early and blocked — so the conflicts view is non-empty), today's line
-- occupancy and a contact-access log.
--
-- This file assumes 000_reset.sql ran immediately before it in the same transaction, so
-- it inserts unconditionally; reload = reset + insert, which makes `npm run db:seed:demo`
-- idempotent by construction (see packages/db/seed-demo.js).
--
-- Every row carries a demo tag so the reset can find it again — see 000_reset.sql.
--
-- Dates are anchored on "today" in Europe/Moscow, the APP_TIMEZONE default, so the data
-- stays current no matter when the stand is seeded.

BEGIN;

CREATE TEMP TABLE demo_ctx ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'Europe/Moscow')::date AS today;

-- ---------------------------------------------------------------------------
-- Inventory: 9 elements — two doubles, two triples and five singles.
--
-- Every element is a line_groups row, singles included (see 005_place_inventory.sql):
-- the UI has exactly one kind of identity to juggle. capacity is the source of truth
-- for element size and place_type is derived from it, so the two always agree here.
-- ---------------------------------------------------------------------------

INSERT INTO line_groups (code, name, capacity, floor_label, notes, display_order)
VALUES
  ('demo-line-3-201', 'Линия G3 / 201', 2, '3', 'Demo dataset', 1),
  ('demo-line-3-210', 'Линия G3 / 210', 1, '3', 'Demo dataset', 2),
  ('demo-line-4-101', 'Линия G4 / 101', 2, '4', 'Demo dataset', 3),
  ('demo-line-4-110', 'Линия G4 / 110', 3, '4', 'Demo dataset', 4),
  ('demo-line-4-120', 'Линия G4 / 120', 1, '4', 'Demo dataset', 5),
  ('demo-line-4-121', 'Линия G4 / 121', 1, '4', 'Demo dataset', 6),
  ('demo-line-4-122', 'Линия G4 / 122', 1, '4', 'Demo dataset', 7),
  ('demo-line-5-301', 'Линия G5 / 301', 3, '5', 'Demo dataset', 8),
  ('demo-line-5-310', 'Линия G5 / 310', 1, '5', 'Demo dataset', 9);

INSERT INTO parking_places (
  code, title, floor_label, place_type, place_role,
  line_group_id, line_position_hint, guest_priority_rank, catalog_source
)
SELECT
  v.code,
  concat('Место ', v.code),
  v.floor_label,
  (CASE lg.capacity WHEN 1 THEN 'single' WHEN 2 THEN 'double' ELSE 'triple' END)
    ::parking_place_type,
  v.place_role::parking_place_role,
  lg.id,
  v.position_hint,
  v.guest_rank,
  'demo'
FROM (
  VALUES
    ('101', '4', 'demo-line-4-101', 1::smallint, 'regular', NULL::smallint),
    ('102', '4', 'demo-line-4-101', 2, 'regular', NULL),
    ('110', '4', 'demo-line-4-110', 1, 'rotatable', 1),
    ('111', '4', 'demo-line-4-110', 2, 'regular', NULL),
    ('112', '4', 'demo-line-4-110', 3, 'blocked', NULL),
    ('120', '4', 'demo-line-4-120', 1, 'regular', NULL),
    ('121', '4', 'demo-line-4-121', 1, 'regular', NULL),
    ('122', '4', 'demo-line-4-122', 1, 'regular', NULL),
    ('201', '3', 'demo-line-3-201', 1, 'regular', NULL),
    ('202', '3', 'demo-line-3-201', 2, 'rotatable', 2),
    ('210', '3', 'demo-line-3-210', 1, 'regular', NULL),
    ('301', '5', 'demo-line-5-301', 1, 'regular', NULL),
    ('302', '5', 'demo-line-5-301', 2, 'regular', NULL),
    ('303', '5', 'demo-line-5-301', 3, 'rotatable', 3),
    ('310', '5', 'demo-line-5-310', 1, 'regular', NULL)
) AS v(code, floor_label, line_code, position_hint, place_role, guest_rank)
JOIN line_groups lg ON lg.code = v.line_code;

-- ---------------------------------------------------------------------------
-- Floor plans. Static reference images only — the element list underneath them is
-- the source of truth for what exists, and the place role lives on parking_places.
-- ---------------------------------------------------------------------------

INSERT INTO parking_place_maps (code, title, floor_label, file_type, file_path, source_checksum)
VALUES
  ('g3', 'Паркинг G3', '3', 'png', 'parking-g3.png', 'demo'),
  ('g4', 'Паркинг G4', '4', 'png', 'parking-g4.png', 'demo'),
  ('g5', 'Паркинг G5', '5', 'png', 'parking-g5.png', 'demo');

-- ---------------------------------------------------------------------------
-- People. Employees 001-004 and 008-013 own a place; 005-007 do not and are the
-- ones competing for released places. Guests are hosted by an employee.
-- ---------------------------------------------------------------------------

INSERT INTO users (
  kind, employee_no, first_name, last_name, middle_name, display_name, email, phone, department
)
VALUES
  ('employee', 'DEMO-001', 'Иван', 'Иванов', 'Иванович', 'Иванов Иван Иванович', 'demo.001@demo.invalid', '+7 900 000-00-01', 'ИТ'),
  ('employee', 'DEMO-002', 'Пётр', 'Петров', 'Сергеевич', 'Петров Пётр Сергеевич', 'demo.002@demo.invalid', '+7 900 000-00-02', 'ИТ'),
  ('employee', 'DEMO-003', 'Анна', 'Сидорова', 'Павловна', 'Сидорова Анна Павловна', 'demo.003@demo.invalid', '+7 900 000-00-03', 'Финансы'),
  ('employee', 'DEMO-004', 'Дмитрий', 'Кузнецов', 'Олегович', 'Кузнецов Дмитрий Олегович', 'demo.004@demo.invalid', '+7 900 000-00-04', 'Логистика'),
  ('employee', 'DEMO-005', 'Ольга', 'Смирнова', 'Андреевна', 'Смирнова Ольга Андреевна', 'demo.005@demo.invalid', '+7 900 000-00-05', 'Маркетинг'),
  ('employee', 'DEMO-006', 'Артём', 'Волков', 'Викторович', 'Волков Артём Викторович', 'demo.006@demo.invalid', '+7 900 000-00-06', 'Продажи'),
  ('employee', 'DEMO-007', 'Егор', 'Морозов', 'Николаевич', 'Морозов Егор Николаевич', 'demo.007@demo.invalid', '+7 900 000-00-07', 'HR'),
  ('employee', 'DEMO-008', 'Мария', 'Николаева', 'Ивановна', 'Николаева Мария Ивановна', 'demo.008@demo.invalid', '+7 900 000-00-08', 'Финансы'),
  ('employee', 'DEMO-009', 'Илья', 'Фёдоров', 'Романович', 'Фёдоров Илья Романович', 'demo.009@demo.invalid', '+7 900 000-00-09', 'Логистика'),
  ('employee', 'DEMO-010', 'Дарья', 'Зайцева', 'Сергеевна', 'Зайцева Дарья Сергеевна', 'demo.010@demo.invalid', '+7 900 000-00-10', 'ИТ'),
  ('employee', 'DEMO-011', 'Роман', 'Орлов', 'Дмитриевич', 'Орлов Роман Дмитриевич', 'demo.011@demo.invalid', '+7 900 000-00-11', 'Продажи'),
  ('employee', 'DEMO-012', 'Ксения', 'Лебедева', 'Олеговна', 'Лебедева Ксения Олеговна', 'demo.012@demo.invalid', '+7 900 000-00-12', 'HR'),
  ('employee', 'DEMO-013', 'Глеб', 'Тихонов', 'Андреевич', 'Тихонов Глеб Андреевич', 'demo.013@demo.invalid', '+7 900 000-00-13', 'Логистика'),
  ('guest', NULL, 'Сергей', 'Николаев', NULL, 'Николаев Сергей', 'demo.guest.1@demo.invalid', '+7 900 100-00-01', NULL),
  ('guest', NULL, 'Елена', 'Тихонова', NULL, 'Тихонова Елена', 'demo.guest.2@demo.invalid', '+7 900 100-00-02', NULL);

INSERT INTO vehicles (user_id, plate_number, brand, model, color, is_primary)
SELECT u.id, v.plate_number, v.brand, v.model, v.color, true
FROM (
  VALUES
    ('demo.001@demo.invalid', 'А123ВС777', 'Toyota', 'Camry', 'белый'),
    ('demo.002@demo.invalid', 'О456ТТ199', 'Kia', 'Rio', 'серый'),
    ('demo.005@demo.invalid', 'Е789КХ777', 'Lada', 'Vesta', 'синий'),
    ('demo.guest.1@demo.invalid', 'Х555ХХ777', 'Skoda', 'Octavia', 'чёрный')
) AS v(email, plate_number, brand, model, color)
JOIN users u ON u.email = v.email;

-- ---------------------------------------------------------------------------
-- Permanent assignments: open-ended, started three months ago.
-- ---------------------------------------------------------------------------

INSERT INTO permanent_assignments (user_id, parking_place_id, valid_during, notes)
SELECT
  u.id,
  pp.id,
  daterange((SELECT today FROM demo_ctx) - 90, NULL, '[)'),
  'Demo dataset'
FROM (
  VALUES
    ('demo.001@demo.invalid', '101'),
    ('demo.002@demo.invalid', '102'),
    ('demo.003@demo.invalid', '110'),
    ('demo.004@demo.invalid', '120'),
    ('demo.008@demo.invalid', '201'),
    ('demo.009@demo.invalid', '301'),
    ('demo.010@demo.invalid', '121'),
    ('demo.011@demo.invalid', '302'),
    ('demo.012@demo.invalid', '122'),
    ('demo.013@demo.invalid', '210')
) AS v(email, place_code)
JOIN users u ON u.email = v.email
JOIN parking_places pp ON pp.code = v.place_code AND pp.catalog_source = 'demo';

-- ---------------------------------------------------------------------------
-- Releases. Seven are active today (two of them already taken), one starts
-- tomorrow so its owner is still standing in the line today.
-- ---------------------------------------------------------------------------

INSERT INTO place_releases (user_id, parking_place_id, release_during, status, created_via, notes)
SELECT
  u.id,
  pp.id,
  daterange((SELECT today FROM demo_ctx) + v.starts_in, (SELECT today FROM demo_ctx) + v.ends_before, '[)'),
  'active',
  'admin',
  v.notes
FROM (
  VALUES
    ('demo.004@demo.invalid', '120', 0, 3, 'Командировка'),
    ('demo.003@demo.invalid', '110', 0, 1, 'Работа из дома'),
    ('demo.008@demo.invalid', '201', 0, 5, 'Отпуск'),
    ('demo.009@demo.invalid', '301', 1, 4, 'Отпуск со следующего дня'),
    ('demo.010@demo.invalid', '121', 0, 7, 'Больничный'),
    ('demo.011@demo.invalid', '302', 0, 3, 'Командировка'),
    ('demo.012@demo.invalid', '122', 0, 1, 'Работа из дома'),
    ('demo.013@demo.invalid', '210', 0, 2, 'Работа из дома')
) AS v(email, place_code, starts_in, ends_before, notes)
JOIN users u ON u.email = v.email
JOIN parking_places pp ON pp.code = v.place_code AND pp.catalog_source = 'demo';

-- ---------------------------------------------------------------------------
-- Requests. Employee 005 was served by the queue, 006 is still waiting, 007 has
-- just asked. Guest 1 is placed, guest 2 is pending.
-- ---------------------------------------------------------------------------

INSERT INTO employee_parking_requests (user_id, request_date, status, notes)
SELECT u.id, (SELECT today FROM demo_ctx), v.status::request_status, v.notes
FROM (
  VALUES
    ('demo.005@demo.invalid', 'queued', 'Демо: выдано из очереди'),
    ('demo.006@demo.invalid', 'queued', 'Демо: ожидает в очереди'),
    ('demo.007@demo.invalid', 'active', 'Демо: только что подана')
) AS v(email, status, notes)
JOIN users u ON u.email = v.email;

INSERT INTO guest_parking_requests (
  guest_user_id, host_user_id, request_date, status, guest_name, guest_phone, vehicle_plate_number, notes
)
SELECT
  guest.id,
  host.id,
  (SELECT today FROM demo_ctx),
  v.status::request_status,
  guest.display_name,
  guest.phone,
  v.plate_number,
  v.notes
FROM (
  VALUES
    ('demo.guest.1@demo.invalid', 'demo.007@demo.invalid', 'active', 'Х555ХХ777', 'Демо: гость размещён'),
    ('demo.guest.2@demo.invalid', 'demo.001@demo.invalid', 'active', 'У777УУ199', 'Демо: гость ожидает места')
) AS v(guest_email, host_email, status, plate_number, notes)
JOIN users guest ON guest.email = v.guest_email
JOIN users host ON host.email = v.host_email;

-- ---------------------------------------------------------------------------
-- Reservations for today, then the request rows are closed against them (same
-- order the API uses: reservation first, request updated to 'assigned' after).
-- ---------------------------------------------------------------------------

INSERT INTO reservations (
  reservation_date, parking_place_id, user_id, employee_parking_request_id, source, reason
)
SELECT
  (SELECT today FROM demo_ctx),
  pp.id,
  u.id,
  epr.id,
  'queue',
  'Queue assignment #1'
FROM users u
JOIN parking_places pp ON pp.code = '120' AND pp.catalog_source = 'demo'
JOIN employee_parking_requests epr
  ON epr.user_id = u.id AND epr.request_date = (SELECT today FROM demo_ctx)
WHERE u.email = 'demo.005@demo.invalid';

INSERT INTO reservations (
  reservation_date, parking_place_id, user_id, guest_parking_request_id, source, reason
)
SELECT
  (SELECT today FROM demo_ctx),
  pp.id,
  guest.id,
  gpr.id,
  'guest',
  'Guest assignment hosted by Морозов Егор Николаевич'
FROM users guest
JOIN guest_parking_requests gpr ON gpr.guest_user_id = guest.id
JOIN parking_places pp ON pp.code = '110' AND pp.catalog_source = 'demo'
WHERE guest.email = 'demo.guest.1@demo.invalid';

UPDATE employee_parking_requests epr
SET status = 'assigned',
    assigned_reservation_id = r.id,
    updated_at = now()
FROM reservations r
WHERE r.employee_parking_request_id = epr.id;

UPDATE guest_parking_requests gpr
SET status = 'assigned',
    assigned_reservation_id = r.id,
    updated_at = now()
FROM reservations r
WHERE r.guest_parking_request_id = gpr.id;

INSERT INTO reservation_events (reservation_id, event_type, payload, source)
SELECT r.id, 'reservation_created', jsonb_build_object('seed', 'demo'), r.source
FROM reservations r
WHERE r.reservation_date = (SELECT today FROM demo_ctx)
  AND r.parking_place_id IN (SELECT id FROM parking_places WHERE catalog_source = 'demo');

INSERT INTO parking_movements (
  reservation_id, movement_date, to_parking_place_id, movement_type, reason
)
SELECT
  r.id,
  r.reservation_date,
  r.parking_place_id,
  CASE WHEN r.source = 'guest' THEN 'guest_assignment' ELSE 'queue_assignment' END::movement_type,
  'Demo dataset'
FROM reservations r
WHERE r.reservation_date = (SELECT today FROM demo_ctx)
  AND r.parking_place_id IN (SELECT id FROM parking_places WHERE catalog_source = 'demo');

-- ---------------------------------------------------------------------------
-- Queue: position 1 was served, position 2 is still waiting.
-- ---------------------------------------------------------------------------

INSERT INTO queue_entries (
  employee_parking_request_id, queue_date, queue_position, status, processed_at, assigned_reservation_id
)
SELECT
  epr.id,
  epr.request_date,
  v.position,
  v.status::queue_status,
  CASE WHEN v.status = 'assigned' THEN now() ELSE NULL END,
  epr.assigned_reservation_id
FROM (
  VALUES
    ('demo.005@demo.invalid', 1, 'assigned'),
    ('demo.006@demo.invalid', 2, 'waiting')
) AS v(email, position, status)
JOIN users u ON u.email = v.email
JOIN employee_parking_requests epr
  ON epr.user_id = u.id AND epr.request_date = (SELECT today FROM demo_ctx);

-- ---------------------------------------------------------------------------
-- Departure plans. 002 leaves early from the rear of line demo-line-4-101 and is
-- therefore blocked by 001 in front — that pair is what /admin/conflicts reports.
-- ---------------------------------------------------------------------------

INSERT INTO departure_plans (user_id, plan_date, departure_time, is_early)
SELECT u.id, (SELECT today FROM demo_ctx), v.departure_time::time, v.is_early
FROM (
  VALUES
    ('demo.001@demo.invalid', '19:30', false),
    ('demo.002@demo.invalid', '15:30', true),
    ('demo.009@demo.invalid', '17:00', true)
) AS v(email, departure_time, is_early)
JOIN users u ON u.email = v.email;

-- ---------------------------------------------------------------------------
-- Today's line occupancy: who physically stands where.
-- ---------------------------------------------------------------------------

INSERT INTO line_occupancy (
  occupancy_date, line_group_id, parking_place_id, position, subject_type, user_id
)
SELECT
  (SELECT today FROM demo_ctx),
  pp.line_group_id,
  pp.id,
  pp.line_position_hint,
  'employee',
  u.id
FROM (
  VALUES
    ('demo.001@demo.invalid', '101'),
    ('demo.002@demo.invalid', '102'),
    ('demo.009@demo.invalid', '301')
) AS v(email, place_code)
JOIN users u ON u.email = v.email
JOIN parking_places pp ON pp.code = v.place_code AND pp.catalog_source = 'demo';

INSERT INTO line_occupancy (
  occupancy_date, line_group_id, parking_place_id, position, subject_type,
  user_id, guest_parking_request_id, reservation_id
)
SELECT
  (SELECT today FROM demo_ctx),
  pp.line_group_id,
  pp.id,
  pp.line_position_hint,
  'guest',
  NULL,
  gpr.id,
  gpr.assigned_reservation_id
FROM guest_parking_requests gpr
JOIN users guest ON guest.id = gpr.guest_user_id
JOIN parking_places pp ON pp.code = '110' AND pp.catalog_source = 'demo'
WHERE guest.email = 'demo.guest.1@demo.invalid';

INSERT INTO contact_access_logs (
  requester_user_id, occupancy_date, line_group_id, target_user_id, resolution, metadata
)
SELECT
  requester.id,
  (SELECT today FROM demo_ctx),
  lg.id,
  target.id,
  'contact_shared',
  jsonb_build_object('seed', 'demo', 'reason', 'early_departure')
FROM users requester
CROSS JOIN users target
JOIN line_groups lg ON lg.code = 'demo-line-4-101'
WHERE requester.email = 'demo.002@demo.invalid'
  AND target.email = 'demo.001@demo.invalid';

-- ---------------------------------------------------------------------------
-- Audit trail, so the Журнал tab has demo entries of its own.
-- ---------------------------------------------------------------------------

INSERT INTO audit_logs (entity_type, entity_id, action, actor_service, metadata)
SELECT 'parking_place', pp.id, 'parking_place_created', 'db_seed_demo',
       jsonb_build_object('code', pp.code, 'placeType', pp.place_type)
FROM parking_places pp
WHERE pp.catalog_source = 'demo';

INSERT INTO audit_logs (entity_type, entity_id, action, actor_service, actor_user_id, metadata)
SELECT 'permanent_assignment', pa.id, 'permanent_assignment_created', 'db_seed_demo', pa.user_id,
       jsonb_build_object('parkingPlaceId', pa.parking_place_id)
FROM permanent_assignments pa
WHERE pa.notes = 'Demo dataset';

INSERT INTO audit_logs (entity_type, entity_id, action, actor_service, actor_user_id, metadata)
SELECT 'place_release', pr.id, 'place_release_created', 'db_seed_demo', pr.user_id,
       jsonb_build_object('parkingPlaceId', pr.parking_place_id, 'releaseDuring', pr.release_during::text)
FROM place_releases pr
WHERE pr.parking_place_id IN (SELECT id FROM parking_places WHERE catalog_source = 'demo');

INSERT INTO audit_logs (entity_type, entity_id, action, actor_service, actor_user_id, metadata)
SELECT 'reservation', r.id, 'reservation_created', 'db_seed_demo', r.user_id,
       jsonb_build_object('source', r.source, 'reservationDate', r.reservation_date::text)
FROM reservations r
WHERE r.parking_place_id IN (SELECT id FROM parking_places WHERE catalog_source = 'demo');

INSERT INTO audit_logs (entity_type, action, actor_service, metadata)
VALUES (
  'system',
  'demo_dataset_loaded',
  'db_seed_demo',
  jsonb_build_object('note', 'Loaded by npm run db:seed:demo')
);

COMMIT;
