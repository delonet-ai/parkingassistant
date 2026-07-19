'use strict';

// Guest requests context — a host inviting a visitor for a day, and the reservation the
// invitation is eventually answered with.

async function listGuestRequestsForDate(db, date) {
  return db.queryMany(
    `
      select
        gpr.id,
        gpr.request_date,
        gpr.status,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.vehicle_plate_number,
        gpr.created_at,
        gpr.canceled_at,
        gpr.notes,
        host.id as host_user_id,
        host.display_name as host_display_name,
        host.department as host_department,
        r.id as reservation_id,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from guest_parking_requests gpr
      join users host on host.id = gpr.host_user_id
      left join reservations r on r.id = gpr.assigned_reservation_id
      left join parking_places pp on pp.id = r.parking_place_id
      where gpr.request_date = $1::date
      order by gpr.created_at desc
    `,
    [date]
  );
}


async function listGuestRequests(db, requestDate) {
  return db.queryMany(
    `
      select
        gpr.id,
        gpr.request_date,
        gpr.status,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.vehicle_plate_number,
        gpr.created_at,
        gpr.canceled_at,
        gpr.notes,
        guest.id as guest_user_id,
        guest.display_name as guest_display_name,
        host.id as host_user_id,
        host.display_name as host_display_name,
        host.department as host_department,
        r.id as reservation_id,
        r.status as reservation_status,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from guest_parking_requests gpr
      join users guest on guest.id = gpr.guest_user_id
      join users host on host.id = gpr.host_user_id
      left join reservations r on r.id = gpr.assigned_reservation_id
      left join parking_places pp on pp.id = r.parking_place_id
      where ($1::date is null or gpr.request_date = $1::date)
      order by gpr.request_date desc, gpr.created_at desc
    `,
    [requestDate]
  );
}

// Serializes guest assignment for a date so two hosts cannot be handed the same place.
async function lockGuestAssignmentForDate(db, requestDate) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`guest_assignment:${requestDate}`]);
}

async function findActiveHost(db, hostUserId) {
  return db.queryOne(
    `
      select id, display_name, department
      from users
      where id = $1
        and kind = 'employee'
        and is_active = true
        and deleted_at is null
    `,
    [hostUserId]
  );
}

// A guest is a real `users` row so reservations, line occupancy and history can point at
// it the same way they point at an employee.
async function insertGuestUser(db, { firstName, lastName, displayName, phone }) {
  return db.queryOne(
    `
      insert into users (
        kind,
        first_name,
        last_name,
        display_name,
        phone
      )
      values ('guest', $1, $2, $3, $4)
      returning id, display_name, phone
    `,
    [firstName, lastName, displayName, phone]
  );
}

async function insertAssignedGuestRequest(
  db,
  { guestUserId, hostUserId, requestDate, guestName, guestPhone, vehiclePlateNumber, notes }
) {
  return db.queryOne(
    `
      insert into guest_parking_requests (
        guest_user_id,
        host_user_id,
        request_date,
        status,
        guest_name,
        guest_phone,
        vehicle_plate_number,
        notes
      )
      values ($1, $2, $3::date, 'assigned', $4, $5, $6, $7)
      returning id, request_date, status, created_at
    `,
    [guestUserId, hostUserId, requestDate, guestName, guestPhone, vehiclePlateNumber, notes]
  );
}

async function attachReservation(db, { guestRequestId, reservationId }) {
  return db.queryMany(
    `
      update guest_parking_requests
      set
        assigned_reservation_id = $1,
        updated_at = now()
      where id = $2
    `,
    [reservationId, guestRequestId]
  );
}

async function markAssigned(db, { guestRequestId, reservationId }) {
  return db.queryMany(
    `
      update guest_parking_requests
      set
        status = 'assigned',
        assigned_reservation_id = $1,
        updated_at = now()
      where id = $2
    `,
    [reservationId, guestRequestId]
  );
}

async function findGuestRequestForUpdate(db, requestId) {
  return db.queryOne(
    `
      select
        gpr.id,
        gpr.request_date,
        gpr.status,
        gpr.guest_user_id,
        gpr.host_user_id,
        gpr.guest_name,
        gpr.assigned_reservation_id,
        host.display_name as host_display_name
      from guest_parking_requests gpr
      join users host on host.id = gpr.host_user_id
      where gpr.id = $1
      for update of gpr
    `,
    [requestId]
  );
}

async function cancelGuestRequest(db, requestId) {
  return db.queryOne(
    `
      update guest_parking_requests
      set
        status = 'canceled',
        canceled_at = now(),
        updated_at = now()
      where id = $1
      returning id, request_date, status, canceled_at
    `,
    [requestId]
  );
}

async function cancelGuestRequestIfNotCanceled(db, requestId) {
  return db.queryMany(
    `
      update guest_parking_requests
      set
        status = 'canceled',
        canceled_at = now(),
        updated_at = now()
      where id = $1
        and status <> 'canceled'
    `,
    [requestId]
  );
}

async function listHostedRequestsForUser(db, userId) {
  return db.queryMany(
    `
      select
        gpr.id,
        gpr.request_date::text as request_date,
        gpr.status,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.vehicle_plate_number,
        gpr.requested_at,
        gpr.canceled_at,
        pp.code as parking_place_code
      from guest_parking_requests gpr
      left join reservations r on r.id = gpr.assigned_reservation_id
      left join parking_places pp on pp.id = r.parking_place_id
      where gpr.host_user_id = $1
      order by gpr.request_date desc, gpr.created_at desc
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  attachReservation,
  cancelGuestRequest,
  cancelGuestRequestIfNotCanceled,
  findActiveHost,
  findGuestRequestForUpdate,
  insertAssignedGuestRequest,
  insertGuestUser,
  listGuestRequests,
  listGuestRequestsForDate,
  listHostedRequestsForUser,
  lockGuestAssignmentForDate,
  markAssigned
};
