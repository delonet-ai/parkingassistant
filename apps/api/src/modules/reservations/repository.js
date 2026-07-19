'use strict';

// Reservations context — who holds which place on which date.
// A reservation is never deleted; cancelling sets `status = 'canceled'` so the day's
// history stays readable.

async function findActiveReservationOnPlaceDate(db, { parkingPlaceId, reservationDate }) {
  return db.queryOne(
    `
      select id, user_id, guest_parking_request_id, source
      from reservations
      where parking_place_id = $1
        and reservation_date = $2::date
        and status = 'active'
      limit 1
    `,
    [parkingPlaceId, reservationDate]
  );
}


async function listActiveReservationsForDate(db, date) {
  return db.queryMany(
    `
      select
        r.id,
        r.reservation_date,
        r.source,
        r.reason,
        r.created_at,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from reservations r
      join parking_places pp on pp.id = r.parking_place_id
      left join users u on u.id = r.user_id
      where r.status = 'active'
        and r.reservation_date = $1::date
      order by pp.code
    `,
    [date]
  );
}


async function insertReservation(
  db,
  { reservationDate, parkingPlaceId, userId, guestParkingRequestId = null, employeeParkingRequestId = null, source, reason }
) {
  return db.queryOne(
    `
      insert into reservations (
        reservation_date,
        parking_place_id,
        user_id,
        guest_parking_request_id,
        employee_parking_request_id,
        source,
        reason
      )
      values ($1::date, $2, $3, $4, $5, $6::assignment_source, $7)
      returning id, reservation_date, source, status, created_at
    `,
    [reservationDate, parkingPlaceId, userId, guestParkingRequestId, employeeParkingRequestId, source, reason]
  );
}

async function insertReservationEvent(db, { reservationId, eventType, payload, source }) {
  return db.queryMany(
    `
      insert into reservation_events (
        reservation_id,
        event_type,
        payload,
        source
      )
      values ($1, $2, $3::jsonb, $4)
    `,
    [reservationId, eventType, JSON.stringify(payload), source]
  );
}

async function insertMovement(db, { reservationId, movementDate, toParkingPlaceId, movementType, reason }) {
  return db.queryMany(
    `
      insert into parking_movements (
        reservation_id,
        movement_date,
        to_parking_place_id,
        movement_type,
        reason
      )
      values ($1, $2::date, $3, $4, $5)
    `,
    [reservationId, movementDate, toParkingPlaceId, movementType, reason]
  );
}

// `for update of r` and not a bare `for update`: `user_id` is nullable by schema (the
// CHECK demands a user *or* a guest request), so the join to `users` has to stay outer,
// and Postgres refuses to lock the nullable side of an outer join.
async function findReservationForUpdate(db, reservationId) {
  return db.queryOne(
    `
      select
        r.id,
        r.reservation_date,
        r.parking_place_id,
        r.user_id,
        r.employee_parking_request_id,
        r.guest_parking_request_id,
        r.source,
        r.status,
        u.display_name as user_display_name,
        pp.code as parking_place_code
      from reservations r
      join parking_places pp on pp.id = r.parking_place_id
      left join users u on u.id = r.user_id
      where r.id = $1
      for update of r
    `,
    [reservationId]
  );
}

async function cancelReservation(db, reservationId) {
  return db.queryOne(
    `
      update reservations
      set
        status = 'canceled',
        canceled_at = now(),
        updated_at = now()
      where id = $1
      returning id, reservation_date, status, canceled_at
    `,
    [reservationId]
  );
}

async function cancelActiveReservation(db, reservationId) {
  return db.queryOne(
    `
      update reservations
      set
        status = 'canceled',
        canceled_at = now(),
        updated_at = now()
      where id = $1
        and status = 'active'
      returning id, reservation_date, parking_place_id, status, canceled_at
    `,
    [reservationId]
  );
}

async function findActiveReservationInRange(db, { parkingPlaceId, releaseDuring }) {
  return db.queryOne(
    `
      select id
      from reservations
      where parking_place_id = $1
        and status = 'active'
        and reservation_date <@ $2::daterange
      limit 1
    `,
    [parkingPlaceId, releaseDuring]
  );
}

async function listReservationsForPlace(db, placeId) {
  return db.queryMany(
    `
      select
        r.id,
        r.reservation_date::text as reservation_date,
        r.source,
        r.status,
        r.reason,
        r.created_at,
        r.canceled_at,
        u.id as user_id,
        u.display_name,
        u.department,
        gpr.id as guest_parking_request_id,
        gpr.guest_name
      from reservations r
      left join users u on u.id = r.user_id
      left join guest_parking_requests gpr on gpr.id = r.guest_parking_request_id
      where r.parking_place_id = $1
      order by r.reservation_date desc, r.created_at desc
      limit 100
    `,
    [placeId]
  );
}

async function listReservationsForUser(db, userId) {
  return db.queryMany(
    `
      select
        r.id,
        r.reservation_date::text as reservation_date,
        r.source,
        r.status,
        r.reason,
        r.created_at,
        r.canceled_at,
        pp.id as parking_place_id,
        pp.code as parking_place_code
      from reservations r
      join parking_places pp on pp.id = r.parking_place_id
      where r.user_id = $1
      order by r.reservation_date desc, r.created_at desc
      limit 100
    `,
    [userId]
  );
}

async function listMovementsForPlace(db, placeId) {
  return db.queryMany(
    `
      select
        pm.id,
        pm.movement_date::text as movement_date,
        pm.movement_type,
        pm.reason,
        pm.created_at,
        from_place.code as from_place_code,
        to_place.code as to_place_code,
        r.source,
        u.display_name as user_display_name,
        gpr.guest_name
      from parking_movements pm
      join reservations r on r.id = pm.reservation_id
      left join parking_places from_place on from_place.id = pm.from_parking_place_id
      join parking_places to_place on to_place.id = pm.to_parking_place_id
      left join users u on u.id = r.user_id
      left join guest_parking_requests gpr on gpr.id = r.guest_parking_request_id
      where pm.from_parking_place_id = $1
         or pm.to_parking_place_id = $1
      order by pm.movement_date desc, pm.created_at desc
      limit 100
    `,
    [placeId]
  );
}

module.exports = {
  cancelActiveReservation,
  cancelReservation,
  findActiveReservationInRange,
  findActiveReservationOnPlaceDate,
  findReservationForUpdate,
  insertMovement,
  insertReservation,
  insertReservationEvent,
  listActiveReservationsForDate,
  listMovementsForPlace,
  listReservationsForPlace,
  listReservationsForUser
};
