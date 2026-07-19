'use strict';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { LEDGER_TABLE, plannedMigrations, runMigrations } = require('../migrate');
const { createTestDatabase, skipWithoutDatabase } = require('../testing/harness');

// Tables every deploy must end up with; a subset chosen to cover each schema file
// (001 the baseline, 002 job_runs, 003 the line-group data migration's target).
const EXPECTED_TABLES = [
  'auth_users',
  'users',
  'parking_places',
  'line_groups',
  'permanent_assignments',
  'place_releases',
  'reservations',
  'employee_parking_requests',
  'guest_parking_requests',
  'line_occupancy',
  'audit_logs',
  'job_runs'
];

describe('db:migrate (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let firstRun = null;
  let secondRun = null;

  before(async () => {
    db = await createTestDatabase({ apply: false });

    const client = await db.pool.connect();
    try {
      firstRun = await runMigrations({ client });
      secondRun = await runMigrations({ client });
    } finally {
      client.release();
    }
  });

  after(async () => {
    if (db) {
      await db.drop();
    }
  });

  it('applies every schema file and seed on a clean database', () => {
    const expected = plannedMigrations().map((migration) => migration.key);

    assert.deepEqual(firstRun.applied, expected);
    assert.deepEqual(firstRun.skipped, []);
    assert.ok(expected.includes('schema/001_initial_schema.sql'));
    assert.ok(expected.some((key) => key.startsWith('seeds/')));
  });

  it('is a no-op on the second run', () => {
    assert.deepEqual(secondRun.applied, []);
    assert.deepEqual(secondRun.skipped, firstRun.applied);
  });

  it('records one ledger row per applied file and no duplicates', async () => {
    const result = await db.query(
      `select filename from ${LEDGER_TABLE} order by filename`
    );
    const filenames = result.rows.map((row) => row.filename);

    assert.deepEqual(filenames, [...firstRun.applied].sort());
    assert.equal(new Set(filenames).size, filenames.length);
  });

  it('leaves the expected tables in place', async () => {
    const result = await db.query(
      `select table_name
         from information_schema.tables
        where table_schema = $1`,
      [db.schemaName]
    );
    const tables = new Set(result.rows.map((row) => row.table_name));

    for (const table of EXPECTED_TABLES) {
      assert.ok(tables.has(table), `expected table ${table} to exist after db:migrate`);
    }
  });

  it('does not duplicate seeded rows across runs', async () => {
    const result = await db.query(
      "select count(*)::int as count from auth_users where lower(login) = 'sysadmin'"
    );

    assert.equal(result.rows[0].count, 1);
  });

  it('applies nothing new when a third run follows the second', async () => {
    const client = await db.pool.connect();
    try {
      const thirdRun = await runMigrations({ client });
      assert.deepEqual(thirdRun.applied, []);
    } finally {
      client.release();
    }
  });
});
