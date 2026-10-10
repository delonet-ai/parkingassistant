'use strict';

// The staged catalog upsert, moved here from scripts/import/parking-catalog.js so the CLI and
// `POST /admin/catalog-import` write a workbook the same way. Nothing in the SQL changed in
// the move: the temp tables, the line derivation and the two `on conflict` clauses are the
// ones the script has been running since 005_place_inventory.sql.
//
// Every function takes the transaction-bound repository from `withTransaction`, because the
// temp tables are declared `on commit drop` and the whole import — staging, lines, places,
// re-derivation and the audit row — is one transaction by design. A dry run is that same
// transaction rolled back.

async function createStagingTable(db) {
  // Every place must belong to a line group (parking_places.line_group_id is NOT NULL
  // since 005_place_inventory.sql), so the rows are staged first, the lines are derived
  // from the whole batch, and only then are the places written.
  await db.queryMany(`
    create temp table import_places (
      code text primary key,
      title text not null,
      floor_label text,
      line_position_hint smallint,
      place_role parking_place_role not null,
      guest_priority_rank smallint,
      metadata jsonb not null
    ) on commit drop
  `);
}

async function stagePlace(db, place) {
  await db.queryMany(
    `
      insert into import_places (
        code, title, floor_label, line_position_hint,
        place_role, guest_priority_rank, metadata
      )
      values ($1, $2, $3, $4, $5::parking_place_role, $6, $7::jsonb)
    `,
    [
      place.code,
      place.title,
      place.floorLabel,
      place.linePositionHint,
      place.placeRole,
      place.guestPriorityRank,
      JSON.stringify(place.metadata)
    ]
  );
}

async function deriveLines(db) {
  // Resolve each staged place to the line it fronts or stands in. The catalog labels a
  // line's rear "задний" whether the line holds two places or three, so a hint of 3 only
  // means "front + 2" when a middle place actually exists one code below — the same rule
  // 003_infer_line_groups.sql applies. Anything without a hint, or with a non-numeric
  // code, is its own single-slot line.
  await db.queryMany(`
    create temp table import_lines on commit drop as
    with numbered as (
      select
        ip.code,
        ip.floor_label,
        ip.line_position_hint as hint,
        case when ip.code ~ '^[0-9]+$' then ip.code::bigint end as numeric_code
      from import_places ip
    )
    select
      n.code,
      concat(
        'line-',
        coalesce(n.floor_label, 'na'),
        '-',
        coalesce(front.code, n.code)
      ) as line_code
    from numbered n
    left join lateral (
      select m.code
      from numbered m
      where n.numeric_code is not null
        and n.hint in (2, 3)
        and m.floor_label is not distinct from n.floor_label
        and m.hint = 1
        and m.numeric_code = n.numeric_code - (
          case
            when n.hint = 3 and exists (
              select 1
              from numbered mid
              where mid.floor_label is not distinct from n.floor_label
                and mid.hint = 2
                and mid.numeric_code = n.numeric_code - 1
            ) then 2
            else 1
          end
        )
      limit 1
    ) as front on true
  `);
}

/**
 * How many of the derived lines already exist, and how many do not — read *before* the upsert,
 * which is the only moment the answer can still be observed. This is what makes a dry run
 * able to report "would create 3, would update 12" without a second code path.
 */
async function countLineChanges(db) {
  return db.queryOne(`
    select
      count(*) filter (where lg.id is null)::integer as created,
      count(*) filter (where lg.id is not null)::integer as updated
    from (select distinct line_code from import_lines) il
    left join line_groups lg on lg.code = il.line_code
  `);
}

/** The same count for the places; `deleted_at` is irrelevant, the upsert revives a row by code. */
async function countPlaceChanges(db) {
  return db.queryOne(`
    select
      count(*) filter (where pp.id is null)::integer as created,
      count(*) filter (where pp.id is not null)::integer as updated
    from import_places ip
    left join parking_places pp on pp.code = ip.code
  `);
}

async function upsertLineGroups(db) {
  await db.queryMany(`
    insert into line_groups (code, name, capacity, floor_label, notes)
    select
      il.line_code,
      concat('Линия ', coalesce(max(ip.floor_label), '?'), ' / ', min(ip.code)),
      least(count(*), 3)::integer,
      max(ip.floor_label),
      'Imported from parking catalog'
    from import_lines il
    join import_places ip on ip.code = il.code
    group by il.line_code
    on conflict (code) do update
      set capacity = excluded.capacity,
          floor_label = excluded.floor_label,
          archived_at = null,
          updated_at = now()
  `);
}

async function upsertPlaces(db) {
  // place_type and line_position_hint both follow from the group, never from the
  // spreadsheet wording: capacity decides the type, and physical order inside the line
  // is the code order.
  await db.queryMany(`
    insert into parking_places (
      code,
      title,
      floor_label,
      place_type,
      place_role,
      line_group_id,
      line_position_hint,
      guest_priority_rank,
      catalog_source,
      catalog_external_id,
      metadata
    )
    select
      staged.code,
      staged.title,
      staged.floor_label,
      staged.place_type,
      staged.place_role,
      staged.line_group_id,
      staged.position,
      staged.guest_priority_rank,
      'xlsx',
      staged.code,
      staged.metadata
    from (
      select
        ip.code,
        ip.title,
        ip.floor_label,
        ip.place_role,
        ip.guest_priority_rank,
        ip.metadata,
        lg.id as line_group_id,
        (case lg.capacity when 1 then 'single' when 2 then 'double' else 'triple' end)
          ::parking_place_type as place_type,
        (row_number() over (
          partition by il.line_code
          order by
            case when ip.code ~ '^[0-9]+$' then ip.code::bigint end nulls last,
            ip.code
        ))::smallint as position
      from import_places ip
      join import_lines il on il.code = ip.code
      join line_groups lg on lg.code = il.line_code
    ) as staged
    on conflict (code) do update
      set title = excluded.title,
          floor_label = excluded.floor_label,
          place_type = excluded.place_type,
          place_role = excluded.place_role,
          line_group_id = excluded.line_group_id,
          line_position_hint = excluded.line_position_hint,
          guest_priority_rank = excluded.guest_priority_rank,
          catalog_source = excluded.catalog_source,
          catalog_external_id = excluded.catalog_external_id,
          metadata = excluded.metadata,
          updated_at = now(),
          deleted_at = null
  `);
}

// Reconciles capacity against the slots that actually landed, re-derives place_type,
// gives any place the batch left group-less its own single-slot line, and refreshes
// display_order. Same function 005_place_inventory.sql uses — one implementation.
async function assignPlaceLines(db) {
  return db.queryOne('select assign_place_lines()');
}

module.exports = {
  assignPlaceLines,
  countLineChanges,
  countPlaceChanges,
  createStagingTable,
  deriveLines,
  stagePlace,
  upsertLineGroups,
  upsertPlaces
};
