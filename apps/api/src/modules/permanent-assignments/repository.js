'use strict';

// Permanent assignments context — who owns which place, and for how long.
// The validity window is a `daterange`, so "ending" an assignment is an update of the
// range's upper bound rather than a delete: history stays readable.

async function listPermanentAssignments(db, { date, status }) {
  return db.queryMany(
    `
      with assignment_statuses as (
        select
          pa.id,
          pa.user_id,
          pa.parking_place_id,
          lower(pa.valid_during)::text as date_from,
          (upper(pa.valid_during) - interval '1 day')::date::text as date_to,
          pa.notes,
          pa.created_at,
          pa.updated_at,
          u.display_name as user_display_name,
          u.department as user_department,
          u.email as user_email,
          u.phone as user_phone,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.floor_label as parking_place_floor_label,
          pp.place_type as parking_place_type,
          case
            when pa.valid_during @> $1::date then 'active'
            when lower(pa.valid_during) > $1::date then 'future'
            else 'ended'
          end as assignment_status
        from permanent_assignments pa
        join users u on u.id = pa.user_id
        join parking_places pp on pp.id = pa.parking_place_id
        where u.deleted_at is null
          and pp.deleted_at is null
      )
      select *
      from assignment_statuses
      where ($2::text = 'all' or assignment_status = $2::text)
      order by
        case assignment_status
          when 'active' then 1
          when 'future' then 2
          else 3
        end,
        date_from desc,
        parking_place_code
    `,
    [date, status]
  );
}

async function insertPermanentAssignment(db, { userId, parkingPlaceId, dateFrom, dateTo, notes }) {
  return db.queryOne(
    `
      insert into permanent_assignments (
        user_id,
        parking_place_id,
        valid_during,
        notes
      )
      values (
        $1,
        $2,
        daterange($3::date, coalesce(($4::date + interval '1 day')::date, null), '[)'),
        $5
      )
      returning id, user_id, parking_place_id, lower(valid_during)::text as date_from, (upper(valid_during) - interval '1 day')::date::text as date_to, notes, created_at
    `,
    [userId, parkingPlaceId, dateFrom, dateTo, notes]
  );
}

async function endPermanentAssignment(db, { assignmentId, dateTo }) {
  return db.queryOne(
    `
      update permanent_assignments
      set
        valid_during = daterange(lower(valid_during), ($2::date + interval '1 day')::date, '[)'),
        updated_at = now()
      where id = $1
        and lower(valid_during) <= $2::date
      returning id, user_id, parking_place_id, lower(valid_during)::text as date_from, (upper(valid_during) - interval '1 day')::date::text as date_to, updated_at
    `,
    [assignmentId, dateTo]
  );
}


async function findActiveAssignmentForUserDate(db, { userId, date }) {
  return db.queryOne(
    `
      select id
      from permanent_assignments
      where user_id = $1
        and valid_during @> $2::date
      limit 1
    `,
    [userId, date]
  );
}

// The owner who may hand this place to the pool for the whole requested range. Both ends
// must fall inside one assignment, so a range that spans a handover is refused.
async function findOwnerForRange(db, { parkingPlaceId, dateFrom, dateTo }) {
  return db.queryOne(
    `
      select
        pa.user_id,
        u.display_name as user_display_name,
        pp.code as parking_place_code
      from permanent_assignments pa
      join users u on u.id = pa.user_id
      join parking_places pp on pp.id = pa.parking_place_id
      where pa.parking_place_id = $1
        and pa.valid_during @> $2::date
        and pa.valid_during @> $3::date
      order by lower(pa.valid_during) desc
      limit 1
    `,
    [parkingPlaceId, dateFrom, dateTo]
  );
}

async function listAssignmentsForPlace(db, placeId) {
  return db.queryMany(
    `
      select
        pa.id,
        lower(pa.valid_during)::text as date_from,
        (upper(pa.valid_during) - interval '1 day')::date::text as date_to,
        pa.created_at,
        pa.notes,
        u.id as user_id,
        u.display_name,
        u.department
      from permanent_assignments pa
      join users u on u.id = pa.user_id
      where pa.parking_place_id = $1
      order by lower(pa.valid_during) desc, pa.created_at desc
      limit 100
    `,
    [placeId]
  );
}

async function listAssignmentsForUser(db, userId) {
  return db.queryMany(
    `
      select
        pa.id,
        lower(pa.valid_during)::text as date_from,
        (upper(pa.valid_during) - interval '1 day')::date::text as date_to,
        pa.created_at,
        pa.notes,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title
      from permanent_assignments pa
      join parking_places pp on pp.id = pa.parking_place_id
      where pa.user_id = $1
      order by lower(pa.valid_during) desc, pa.created_at desc
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  endPermanentAssignment,
  findActiveAssignmentForUserDate,
  findOwnerForRange,
  listAssignmentsForPlace,
  listAssignmentsForUser,
  insertPermanentAssignment,
  listPermanentAssignments
};
