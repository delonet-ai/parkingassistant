'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const xlsx = require('xlsx');
const { Pool } = require('pg');

const sourcePath =
  process.env.CATALOG_XLSX_PATH || '/app/storage/imports/parking-catalog.xlsx';
const sheetName = process.env.CATALOG_XLSX_SHEET || 'Лист1';
const validFrom = process.env.PERMANENT_ASSIGNMENTS_VALID_FROM || '2024-10-01';
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCode(value) {
  const text = clean(value);
  const match = text.match(/\d+/);
  return match ? match[0] : text;
}

function normalizePerson(value) {
  return clean(value).toLowerCase();
}

function employeeNo(displayName) {
  const digest = crypto
    .createHash('sha1')
    .update(normalizePerson(displayName))
    .digest('hex')
    .slice(0, 12);

  return `xlsx-${digest}`;
}

function nameParts(displayName) {
  const parts = clean(displayName).split(' ').filter(Boolean);

  if (parts.length === 0) {
    return {
      firstName: 'Unknown',
      lastName: 'Unknown'
    };
  }

  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: 'Unknown'
    };
  }

  return {
    firstName: parts[1],
    lastName: parts[0],
    middleName: parts.slice(2).join(' ') || null
  };
}

function isAssigned(status) {
  return clean(status).toLowerCase().includes('закреп');
}

function rowToAssignment(row) {
  const placeRaw = clean(row['Место ']);
  const statusRaw = clean(row['Статус']);
  const departmentRaw = clean(row['Дирекция ']);
  const assigneeRaw = clean(row['Кем']);

  if (!placeRaw || !/\d/.test(placeRaw) || !isAssigned(statusRaw) || !assigneeRaw) {
    return null;
  }

  return {
    placeCode: normalizeCode(placeRaw),
    displayName: assigneeRaw,
    department: departmentRaw || null,
    source: {
      sourceFile: path.basename(sourcePath),
      sourceSheet: sheetName,
      sourcePlace: placeRaw,
      sourceStatus: statusRaw,
      sourceDepartment: departmentRaw,
      sourceAssignee: assigneeRaw
    }
  };
}

function readAssignments() {
  const workbook = xlsx.readFile(sourcePath);
  const sheet = workbook.Sheets[sheetName];

  if (!sheet) {
    throw new Error(`Sheet not found: ${sheetName}`);
  }

  const rows = xlsx.utils.sheet_to_json(sheet, {
    range: 1,
    defval: ''
  });

  return rows.map(rowToAssignment).filter(Boolean);
}

async function upsertUser(client, assignment) {
  const displayName = clean(assignment.displayName);
  const { firstName, lastName, middleName } = nameParts(displayName);

  const result = await client.query(
    `
      insert into users (
        kind,
        employee_no,
        first_name,
        last_name,
        middle_name,
        display_name,
        department
      )
      values ('employee', $1, $2, $3, $4, $5, $6)
      on conflict (employee_no) do update
        set first_name = excluded.first_name,
            last_name = excluded.last_name,
            middle_name = excluded.middle_name,
            display_name = excluded.display_name,
            department = excluded.department,
            is_active = true,
            updated_at = now(),
            deleted_at = null
      returning id
    `,
    [
      employeeNo(displayName),
      firstName,
      lastName,
      middleName,
      displayName,
      assignment.department
    ]
  );

  return result.rows[0].id;
}

async function findPlaceId(client, placeCode) {
  const result = await client.query(
    'select id from parking_places where code = $1 and deleted_at is null',
    [placeCode]
  );

  return result.rows[0]?.id || null;
}

async function activeAssignmentExists(client, userId) {
  const result = await client.query(
    `
      select 1
      from permanent_assignments
      where user_id = $1
        and valid_during && daterange($2::date, null, '[)')
      limit 1
    `,
    [userId, validFrom]
  );

  return Boolean(result.rows[0]);
}

async function upsertPermanentAssignment(client, userId, placeId) {
  await client.query(
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
        daterange($3::date, null, '[)'),
        'Imported from parking Excel catalog'
      )
      on conflict on constraint permanent_assignments_place_no_overlap_excl do nothing
    `,
    [userId, placeId, validFrom]
  );
}

async function importAssignments(assignments) {
  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  const stats = {
    sourceAssignments: assignments.length,
    usersUpserted: 0,
    assignmentsCreatedOrKept: 0,
    skippedDuplicateUserAssignments: 0,
    skippedMissingPlaces: 0
  };

  try {
    await client.query('begin');

    for (const assignment of assignments) {
      const placeId = await findPlaceId(client, assignment.placeCode);

      if (!placeId) {
        console.warn(`Skipping missing place ${assignment.placeCode}`);
        stats.skippedMissingPlaces += 1;
        continue;
      }

      const userId = await upsertUser(client, assignment);
      stats.usersUpserted += 1;

      if (await activeAssignmentExists(client, userId)) {
        stats.skippedDuplicateUserAssignments += 1;
        continue;
      }

      await upsertPermanentAssignment(client, userId, placeId);
      stats.assignmentsCreatedOrKept += 1;
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
          'permanent_assignment',
          'permanent_assignments_imported',
          'catalog_import',
          $1::jsonb
        )
      `,
      [JSON.stringify(stats)]
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  return stats;
}

async function main() {
  const assignments = readAssignments();
  const stats = await importAssignments(assignments);
  console.log(JSON.stringify(stats, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
