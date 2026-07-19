'use strict';

// Place-lines context — the inventory: which elements (1–3 slot lines) exist at all.
// `line_groups.capacity` is the source of truth for element size and `parking_places`
// rows are its slots. This is the only context that writes `parking_places.is_active`.

async function listLineGroupsWithPlaces(db) {
  return db.queryMany(
    `
      select
        lg.id,
        lg.code,
        lg.name,
        lg.capacity,
        lg.floor_label,
        lg.notes,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', pp.id,
              'code', pp.code,
              'title', pp.title,
              'placeType', pp.place_type,
              'positionHint', pp.line_position_hint
            )
            order by pp.line_position_hint nulls last, pp.code
          ) filter (where pp.id is not null),
          '[]'::jsonb
        ) as places
      from line_groups lg
      left join parking_places pp
        on pp.line_group_id = lg.id
        and pp.deleted_at is null
      group by lg.id
      order by lg.floor_label nulls last, lg.code
    `
  );
}

async function findLineGroupById(db, lineGroupId) {
  return db.queryOne('select id, code, name, capacity, floor_label from line_groups where id = $1', [lineGroupId]);
}


// The two diagnostics the Места tab shows. `line_group_id` is NOT NULL since
// 005_place_inventory.sql, so the first should always be empty; it is checked anyway, so
// that a dropped constraint surfaces here rather than through a broken element list.
async function listPlacesWithoutLine(db) {
  return db.queryMany(
    `
      select
        pp.id,
        pp.code,
        pp.title,
        pp.floor_label,
        pp.place_type
      from parking_places pp
      where pp.deleted_at is null
        and pp.is_active = true
        and pp.line_group_id is null
      order by pp.floor_label nulls last, pp.code
    `
  );
}

async function listLinesWithCapacityMismatch(db) {
  return db.queryMany(
    `
      select
        lg.id,
        lg.code,
        lg.name,
        lg.floor_label,
        lg.capacity,
        count(pp.id)::int as slot_count
      from line_groups lg
      left join parking_places pp
        on pp.line_group_id = lg.id
        and pp.deleted_at is null
        and pp.is_active = true
      where lg.archived_at is null
      group by lg.id, lg.code, lg.name, lg.floor_label, lg.capacity
      having count(pp.id) <> lg.capacity
      order by lg.floor_label nulls last, lg.code
    `
  );
}


// The element grid: one row per slot, ordered so the caller can fold consecutive rows
// into lines. `display_order` is what puts the elements in the order the operator sees.
async function listPlaceLineSlots(db, { date, floor }) {
  return db.queryMany(
    `
      select
        lg.id as line_id,
        lg.code as line_code,
        lg.name as line_name,
        lg.capacity,
        lg.floor_label,
        lg.display_order,
        pp.id as place_id,
        pp.code as place_code,
        pp.title as place_title,
        pp.place_type,
        pp.place_role,
        pp.line_position_hint,
        pp.guest_priority_rank,
        r.id as reservation_id,
        r.source as reservation_source,
        u.display_name as user_display_name,
        rel.id as release_id
      from line_groups lg
      join parking_places pp
        on pp.line_group_id = lg.id
        and pp.deleted_at is null
        and pp.is_active = true
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $1::date
        and r.status = 'active'
      left join users u on u.id = r.user_id
      left join lateral (
        select pr.id
        from place_releases pr
        where pr.parking_place_id = pp.id
          and pr.status = 'active'
          and pr.release_during @> $1::date
        limit 1
      ) rel on true
      where lg.archived_at is null
        and ($2::text is null or lg.floor_label = $2::text)
      order by
        lg.display_order nulls last,
        lg.code,
        pp.line_position_hint nulls last,
        pp.code
    `,
    [date, floor]
  );
}

async function insertLineGroup(db, { code, name, capacity, floorLabel, notes }) {
  return db.queryOne(
    `
      insert into line_groups (code, name, capacity, floor_label, notes)
      values ($1, $2, $3, $4, $5)
      returning id, code, name, capacity, floor_label, display_order, archived_at
    `,
    [code, name, capacity, floorLabel, notes]
  );
}

async function insertSlot(db, { code, title, floorLabel, placeType, placeRole, lineGroupId, linePositionHint, guestPriorityRank }) {
  return db.queryMany(
    `
      insert into parking_places (
        code,
        title,
        floor_label,
        place_type,
        place_role,
        line_group_id,
        line_position_hint,
        guest_priority_rank,
        catalog_source
      )
      values ($1, $2, $3, $4::parking_place_type, $5::parking_place_role, $6, $7, $8, 'admin-web')
    `,
    [code, title, floorLabel, placeType, placeRole, lineGroupId, linePositionHint, guestPriorityRank]
  );
}

// The one implementation of "place_type follows capacity" — it also refreshes
// display_order so a new element sorts into the list where it belongs. Shared with the
// catalog import, which is why it lives in the database rather than in JS.
async function assignPlaceLines(db) {
  return db.queryOne('select assign_place_lines()');
}

async function listSlotsForLine(db, lineId) {
  return db.queryMany(
    `
      select
        lg.id as line_id,
        lg.code as line_code,
        lg.name as line_name,
        lg.capacity,
        lg.floor_label,
        lg.display_order,
        pp.id as place_id,
        pp.code as place_code,
        pp.title as place_title,
        pp.place_type,
        pp.place_role,
        pp.line_position_hint,
        pp.guest_priority_rank
      from line_groups lg
      join parking_places pp on pp.line_group_id = lg.id and pp.deleted_at is null
      where lg.id = $1
      order by pp.line_position_hint nulls last, pp.code
    `,
    [lineId]
  );
}

async function findLineForUpdate(db, lineId) {
  return db.queryOne(
    `
      select id, code, name, capacity, floor_label, archived_at
      from line_groups
      where id = $1
      for update
    `,
    [lineId]
  );
}

// A place with a reservation for today or later, or a live permanent owner, is still in
// use — archiving it would strand a person, so the operator has to clear the blocker
// first and the response names every one of them.
async function listArchiveBlockers(db, { lineId, today }) {
  return db.queryMany(
    `
      select
        'reservation' as blocker_type,
        pp.code as place_code,
        to_char(r.reservation_date, 'YYYY-MM-DD') as detail,
        u.display_name as user_display_name
      from reservations r
      join parking_places pp on pp.id = r.parking_place_id
      left join users u on u.id = r.user_id
      where pp.line_group_id = $1
        and r.status = 'active'
        and r.reservation_date >= $2::date

      union all

      select
        'permanent_assignment' as blocker_type,
        pp.code as place_code,
        to_char(lower(pa.valid_during), 'YYYY-MM-DD') as detail,
        u.display_name as user_display_name
      from permanent_assignments pa
      join parking_places pp on pp.id = pa.parking_place_id
      join users u on u.id = pa.user_id
      where pp.line_group_id = $1
        and (upper(pa.valid_during) is null or upper(pa.valid_during) > $2::date)

      order by place_code, blocker_type
    `,
    [lineId, today]
  );
}

// The single write path to `parking_places.is_active` (Task 9). Delete means archive:
// the rows stay readable so reservations, releases and history survive.
async function archiveSlotsOfLine(db, lineId) {
  return db.queryMany(
    `
      update parking_places
      set
        is_active = false,
        deleted_at = now(),
        updated_at = now()
      where line_group_id = $1
        and deleted_at is null
      returning id, code, title
    `,
    [lineId]
  );
}

async function archiveLine(db, lineId) {
  return db.queryMany(
    `
      update line_groups
      set
        archived_at = now(),
        updated_at = now()
      where id = $1
    `,
    [lineId]
  );
}

module.exports = {
  archiveLine,
  archiveSlotsOfLine,
  assignPlaceLines,
  findLineForUpdate,
  findLineGroupById,
  insertLineGroup,
  insertSlot,
  listArchiveBlockers,
  listLineGroupsWithPlaces,
  listLinesWithCapacityMismatch,
  listPlaceLineSlots,
  listPlacesWithoutLine,
  listSlotsForLine
};
