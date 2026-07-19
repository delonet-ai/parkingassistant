'use strict';

// Places context — individual `parking_places` rows and their attributes.
// Adding and archiving places is the place-lines context, not this one: `is_active`
// has exactly one write path and it lives there (Task 9).

async function listPlacesWithOwnerAndLine(db) {
  return db.queryMany(
    `
      select
        pp.id,
        pp.code,
        pp.title,
        pp.floor_label,
        pp.place_type,
        pp.place_role,
        pp.line_position_hint,
        pp.guest_priority_rank,
        pp.is_active,
        u.id as owner_user_id,
        u.display_name as owner_display_name,
        u.department as owner_department,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        lg.capacity as line_group_capacity
      from parking_places pp
      left join permanent_assignments pa
        on pa.parking_place_id = pp.id
        and pa.valid_during @> current_date
      left join users u on u.id = pa.user_id
      left join line_groups lg on lg.id = pp.line_group_id
      where pp.deleted_at is null
      order by pp.floor_label nulls last, pp.code
    `
  );
}

async function updatePlace(
  db,
  { placeId, code, title, floorLabel, placeType, lineGroupId, linePositionHint, guestPriorityRank, placeRole }
) {
  return db.queryOne(
    `
      update parking_places
      set
        code = $2,
        title = $3,
        floor_label = $4,
        place_type = $5,
        place_role = coalesce($9::parking_place_role, place_role),
        -- Every place belongs to a line since 005_place_inventory.sql, so an update
        -- that does not name one keeps the current line instead of orphaning the row.
        line_group_id = coalesce($6, line_group_id),
        line_position_hint = $7,
        guest_priority_rank = $8,
        updated_at = now()
      where id = $1
        and deleted_at is null
      returning id, code, title, floor_label, place_type, place_role, line_group_id, line_position_hint, guest_priority_rank, is_active, updated_at
    `,
    [placeId, code, title, floorLabel, placeType, lineGroupId, linePositionHint, guestPriorityRank, placeRole]
  );
}


// Locks the place row while a line-occupancy write decides whether the requested
// position fits; the join to `line_groups` also proves the place really is in that line.
async function findPlaceInLineForUpdate(db, { parkingPlaceId, lineGroupId }) {
  return db.queryOne(
    `
      select
        pp.id,
        pp.code,
        pp.title,
        pp.line_group_id,
        lg.capacity
      from parking_places pp
      join line_groups lg on lg.id = pp.line_group_id
      where pp.id = $1
        and pp.line_group_id = $2
        and pp.deleted_at is null
      for update of pp
    `,
    [parkingPlaceId, lineGroupId]
  );
}

// The place's position in its line, defaulting to the front. Used to work out which
// early departures an assignment to this place would block.
async function findPlaceLineContext(db, parkingPlaceId) {
  return db.queryOne(
    `
      select
        pp.id,
        pp.code,
        pp.line_group_id,
        coalesce(pp.line_position_hint, 1) as line_position_hint
      from parking_places pp
      where pp.id = $1
    `,
    [parkingPlaceId]
  );
}

// Does this user hold a place in a multi-slot line on this date, by permanent assignment
// or by an active reservation? Only such a user can meaningfully declare a departure time.
async function findMultiLinePlaceForUser(db, { userId, planDate }) {
  return db.queryOne(
    `
      select pp.id
      from parking_places pp
      left join permanent_assignments pa
        on pa.parking_place_id = pp.id
        and pa.user_id = $1
        and pa.valid_during @> $2::date
      left join reservations r
        on r.parking_place_id = pp.id
        and r.user_id = $1
        and r.reservation_date = $2::date
        and r.status = 'active'
      where pp.line_group_id is not null
        and (pa.id is not null or r.id is not null)
      limit 1
    `,
    [userId, planDate]
  );
}


// Archived places stay readable on purpose: archiving is how a place leaves service, and
// its reservations, releases and audit trail are exactly what the operator comes here to
// read afterwards. There is deliberately no `deleted_at is null` filter.
async function findPlaceForHistory(db, placeId) {
  return db.queryOne(
    `
      select id, code, title, floor_label, place_type, is_active
      from parking_places
      where id = $1
    `,
    [placeId]
  );
}

module.exports = {
  findMultiLinePlaceForUser,
  findPlaceForHistory,
  findPlaceInLineForUpdate,
  findPlaceLineContext,
  listPlacesWithOwnerAndLine,
  updatePlace
};
