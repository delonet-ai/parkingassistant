'use strict';

const path = require('node:path');
const xlsx = require('xlsx');
const { Pool } = require('pg');

const sourcePath =
  process.env.CATALOG_XLSX_PATH || '/app/storage/imports/parking-catalog.xlsx';
const sheetName = process.env.CATALOG_XLSX_SHEET || 'Лист1';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeFloor(value) {
  const text = clean(value).toLowerCase();
  const match = text.match(/\d+/);
  return match ? match[0] : clean(value);
}

function normalizeCode(value) {
  const text = clean(value);
  const match = text.match(/\d+/);
  return match ? match[0] : text;
}

function inferPositionHint(rawPlace) {
  const text = clean(rawPlace).toLowerCase();

  if (text.includes('перед')) {
    return 1;
  }

  if (text.includes('средн')) {
    return 2;
  }

  if (text.includes('задн')) {
    return 3;
  }

  return null;
}

function isGuest(status) {
  return clean(status).toLowerCase().includes('гост');
}

function rowToPlace(row) {
  const floorRaw = clean(row['Уровень']);
  const placeRaw = clean(row['Место ']);
  const statusRaw = clean(row['Статус']);
  const departmentRaw = clean(row['Дирекция ']);
  const assigneeRaw = clean(row['Кем']);

  if (!floorRaw || !placeRaw || !statusRaw) {
    return null;
  }

  if (!/\d/.test(placeRaw)) {
    return null;
  }

  const code = normalizeCode(placeRaw);
  const floorLabel = normalizeFloor(floorRaw);
  const linePositionHint = inferPositionHint(placeRaw);
  const guest = isGuest(statusRaw);

  // place_type is deliberately absent: line_groups.capacity is its source of truth and
  // the import derives it from the group it lands the place in (see importPlaces).
  return {
    code,
    title: placeRaw,
    floorLabel,
    linePositionHint,
    // A guest place is the guest pool, which is what place_role = 'rotatable' means now
    // that the zone geometry that used to carry it is gone.
    placeRole: guest ? 'rotatable' : 'regular',
    guestPriorityRank: guest ? 1 : null,
    metadata: {
      sourceFile: path.basename(sourcePath),
      sourceSheet: sheetName,
      sourceFloor: floorRaw,
      sourcePlace: placeRaw,
      sourceStatus: statusRaw,
      sourceDepartment: departmentRaw,
      sourceAssignee: assigneeRaw
    }
  };
}

function readPlaces() {
  const workbook = xlsx.readFile(sourcePath);
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }

  const rows = xlsx.utils.sheet_to_json(sheet, {
    range: 1,
    defval: ''
  });

  const places = rows.map(rowToPlace).filter(Boolean);
  const seen = new Set();

  return places.filter((place) => {
    if (seen.has(place.code)) {
      console.warn(`Skipping duplicate place code ${place.code}`);
      return false;
    }

    seen.add(place.code);
    return true;
  });
}

async function importPlaces(places) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();

  try {
    await client.query('begin');

    // Every place must belong to a line group (parking_places.line_group_id is NOT NULL
    // since 005_place_inventory.sql), so the rows are staged first, the lines are derived
    // from the whole batch, and only then are the places written.
    await client.query(`
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

    for (const place of places) {
      await client.query(
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

    // Resolve each staged place to the line it fronts or stands in. The catalog labels a
    // line's rear "задний" whether the line holds two places or three, so a hint of 3 only
    // means "front + 2" when a middle place actually exists one code below — the same rule
    // 003_infer_line_groups.sql applies. Anything without a hint, or with a non-numeric
    // code, is its own single-slot line.
    await client.query(`
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

    await client.query(`
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

    // place_type and line_position_hint both follow from the group, never from the
    // spreadsheet wording: capacity decides the type, and physical order inside the line
    // is the code order.
    await client.query(`
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

    // Reconciles capacity against the slots that actually landed, re-derives place_type,
    // gives any place the batch left group-less its own single-slot line, and refreshes
    // display_order. Same function 005_place_inventory.sql uses — one implementation.
    await client.query('select assign_place_lines()');

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          action,
          actor_service,
          metadata
        )
        values (
          'parking_place',
          'parking_catalog_imported',
          'catalog_import',
          $1::jsonb
        )
      `,
      [
        JSON.stringify({
          sourceFile: path.basename(sourcePath),
          sourceSheet: sheetName,
          importedPlaces: places.length
        })
      ]
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const places = readPlaces();
  await importPlaces(places);
  console.log(`Imported parking places: ${places.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
