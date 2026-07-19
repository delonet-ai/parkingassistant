'use strict';

// Line occupancy context — who physically stands in which position of a line on a given
// date. This is today's occupancy, not the inventory of what exists: that is place-lines.

// The two occupancy reads differ only in their filter and ordering, so the projection is
// written once. `mapLineOccupancy` in the caller depends on every column here.
const OCCUPANCY_SELECT = `
      select
        lo.id as occupancy_id,
        lo.occupancy_date::text as occupancy_date,
        lo.position,
        lo.subject_type,
        lo.created_at as occupancy_created_at,
        lo.updated_at as occupancy_updated_at,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        lg.capacity as line_group_capacity,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        u.email as user_email,
        u.phone as user_phone,
        gpr.id as guest_parking_request_id,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.host_user_id,
        host.display_name as host_display_name,
        r.id as reservation_id,
        r.source as reservation_source
      from line_occupancy lo
      join line_groups lg on lg.id = lo.line_group_id
      join parking_places pp on pp.id = lo.parking_place_id
      left join users u on u.id = lo.user_id
      left join guest_parking_requests gpr on gpr.id = lo.guest_parking_request_id
      left join users host on host.id = gpr.host_user_id
      left join reservations r on r.id = lo.reservation_id
`;

async function listOccupancyForLineAndDate(db, { lineGroupId, occupancyDate }) {
  return db.queryMany(
    `
      ${OCCUPANCY_SELECT}
      where lo.line_group_id = $1
        and lo.occupancy_date = $2::date
      order by lo.position
    `,
    [lineGroupId, occupancyDate]
  );
}

// Serializes concurrent writes to one line on one date. Held for the transaction, so it
// is released by the commit or the rollback and never leaks.
async function lockLineForDate(db, { lineGroupId, occupancyDate }) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`line_occupancy:${occupancyDate}:${lineGroupId}`]);
}

async function deleteOccupancyForSubject(db, { occupancyDate, subjectType, userId, guestParkingRequestId }) {
  return db.queryMany(
    `
      delete from line_occupancy
      where occupancy_date = $1::date
        and (
          ($2 = 'employee' and subject_type = 'employee' and user_id = $3)
          or
          ($2 = 'guest' and subject_type = 'guest' and guest_parking_request_id = $4)
        )
    `,
    [occupancyDate, subjectType, userId, guestParkingRequestId]
  );
}

async function insertOccupancy(
  db,
  { occupancyDate, lineGroupId, parkingPlaceId, position, subjectType, userId, guestParkingRequestId, reservationId }
) {
  return db.queryOne(
    `
      insert into line_occupancy (
        occupancy_date,
        line_group_id,
        parking_place_id,
        position,
        subject_type,
        user_id,
        guest_parking_request_id,
        reservation_id
      )
      values ($1::date, $2, $3, $4, $5, $6, $7, $8)
      returning id
    `,
    [occupancyDate, lineGroupId, parkingPlaceId, position, subjectType, userId, guestParkingRequestId, reservationId]
  );
}

async function findEmployeeOccupancy(db, { occupancyDate, userId }) {
  return db.queryOne(
    `
      select
        lo.id,
        lo.line_group_id,
        lo.position,
        lg.code as line_group_code,
        lg.name as line_group_name
      from line_occupancy lo
      join line_groups lg on lg.id = lo.line_group_id
      where lo.occupancy_date = $1::date
        and lo.subject_type = 'employee'
        and lo.user_id = $2
      limit 1
    `,
    [occupancyDate, userId]
  );
}

// Everyone standing in front of `position` in the same line, nearest blocker first.
async function listBlockersAhead(db, { occupancyDate, lineGroupId, position }) {
  return db.queryMany(
    `
      select
        lo.id as occupancy_id,
        lo.position,
        lo.subject_type,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        u.email as user_email,
        u.phone as user_phone,
        gpr.id as guest_parking_request_id,
        gpr.guest_name,
        gpr.host_user_id,
        host.display_name as host_display_name
      from line_occupancy lo
      left join users u on u.id = lo.user_id
      left join guest_parking_requests gpr on gpr.id = lo.guest_parking_request_id
      left join users host on host.id = gpr.host_user_id
      where lo.occupancy_date = $1::date
        and lo.line_group_id = $2
        and lo.position < $3
      order by lo.position desc
    `,
    [occupancyDate, lineGroupId, position]
  );
}

async function listOccupancyForDate(db, { occupancyDate }) {
  return db.queryMany(
    `
      ${OCCUPANCY_SELECT}
      where lo.occupancy_date = $1::date
      order by lg.floor_label nulls last, lg.code, lo.position
    `,
    [occupancyDate]
  );
}


async function listOccupancyForUser(db, userId) {
  return db.queryMany(
    `
      select
        lo.id,
        lo.occupancy_date::text as occupancy_date,
        lo.position,
        lo.subject_type,
        lo.created_at,
        lg.code as line_group_code,
        pp.code as parking_place_code
      from line_occupancy lo
      join line_groups lg on lg.id = lo.line_group_id
      join parking_places pp on pp.id = lo.parking_place_id
      where lo.user_id = $1
      order by lo.occupancy_date desc, lo.position
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  deleteOccupancyForSubject,
  listOccupancyForUser,
  findEmployeeOccupancy,
  insertOccupancy,
  listBlockersAhead,
  listOccupancyForDate,
  listOccupancyForLineAndDate,
  lockLineForDate
};
