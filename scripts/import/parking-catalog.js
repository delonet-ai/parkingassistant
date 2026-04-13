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

function inferPlaceType(rawPlace) {
  const text = clean(rawPlace).toLowerCase();

  if (text.includes('средн')) {
    return 'triple';
  }

  if (text.includes('перед') || text.includes('задн')) {
    return 'double';
  }

  return 'single';
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
  const placeType = inferPlaceType(placeRaw);
  const linePositionHint = inferPositionHint(placeRaw);

  return {
    code,
    title: placeRaw,
    floorLabel,
    placeType,
    linePositionHint,
    guestPriorityRank: isGuest(statusRaw) ? 1 : null,
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

    for (const place of places) {
      await client.query(
        `
          insert into parking_places (
            code,
            title,
            floor_label,
            place_type,
            line_position_hint,
            guest_priority_rank,
            catalog_source,
            catalog_external_id,
            metadata
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
          on conflict (code) do update
            set title = excluded.title,
                floor_label = excluded.floor_label,
                place_type = excluded.place_type,
                line_position_hint = excluded.line_position_hint,
                guest_priority_rank = excluded.guest_priority_rank,
                catalog_source = excluded.catalog_source,
                catalog_external_id = excluded.catalog_external_id,
                metadata = excluded.metadata,
                updated_at = now(),
                deleted_at = null
        `,
        [
          place.code,
          place.title,
          place.floorLabel,
          place.placeType,
          place.linePositionHint,
          place.guestPriorityRank,
          'xlsx',
          place.code,
          JSON.stringify(place.metadata)
        ]
      );
    }

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
