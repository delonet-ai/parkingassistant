'use strict';

// Integration-test harness: applies packages/db/schema/*.sql and packages/db/seeds/*.sql
// into a throwaway Postgres schema so every run starts from a known, isolated state.
//
// Requires DATABASE_URL_TEST pointing at a database the test user may create schemas in.
// See SETUP.md → "Integration test database".

const { Pool } = require('pg');

const {
  MIGRATION_LOCK_KEY,
  plannedMigrations,
  readSqlDirectory,
  runMigrations,
  stripPsqlMetaCommands
} = require('../migrate');

const SKIP_REASON =
  'DATABASE_URL_TEST is not set — see SETUP.md → "Integration test database"';

let scratchCounter = 0;

function testDatabaseUrl() {
  const url = process.env.DATABASE_URL_TEST;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

function integrationTestsEnabled() {
  return testDatabaseUrl() !== null;
}

// node:test accepts `{ skip: <string> }` — false means "do not skip".
function skipWithoutDatabase() {
  return integrationTestsEnabled() ? false : SKIP_REASON;
}

function scratchSchemaName() {
  scratchCounter += 1;
  return `itest_${process.pid}_${scratchCounter}`;
}

function connectionStringForSchema(baseUrl, schemaName) {
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${schemaName},public`);
  return url.toString();
}

/**
 * Create a scratch schema, apply the schema migrations and (optionally) the base seeds.
 *
 * `apply: false` returns an empty scratch schema instead — for tests that drive
 * runMigrations() themselves (see packages/db/integration/migrate.itest.js).
 *
 * @param {{ seed?: boolean, apply?: boolean }} [options]
 * @returns {Promise<{
 *   schemaName: string,
 *   connectionString: string,
 *   pool: import('pg').Pool,
 *   query: (text: string, params?: unknown[]) => Promise<import('pg').QueryResult>,
 *   appliedFiles: string[],
 *   drop: () => Promise<void>
 * }>}
 */
async function createTestDatabase(options = {}) {
  const baseUrl = testDatabaseUrl();
  if (!baseUrl) {
    throw new Error(SKIP_REASON);
  }

  const seed = options.seed !== false;
  const apply = options.apply !== false;
  const schemaName = scratchSchemaName();
  const adminPool = new Pool({ connectionString: baseUrl });

  try {
    // The extensions must live in `public`, not in the scratch schema.
    //
    // 001_initial_schema.sql says `CREATE EXTENSION IF NOT EXISTS`, and an extension is
    // database-wide: with the scratch schema first on the search_path, the FIRST harness
    // to run plants btree_gist inside its own schema and every later scratch schema
    // silently borrows that one's operator classes for its exclusion constraints. Then
    // one file's `drop schema ... cascade` has to cascade into another file's live
    // constraints, and the two deadlock against each other mid-test (40P01).
    //
    // Creating them in public up front makes the IF NOT EXISTS in 001 a no-op, so each
    // scratch schema is genuinely self-contained and can be dropped in isolation.
    const client = await adminPool.connect();
    try {
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query('create extension if not exists pgcrypto with schema public');
      await client.query('create extension if not exists btree_gist with schema public');
      await client.query(`drop schema if exists ${schemaName} cascade`);
      await client.query(`create schema ${schemaName}`);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
    }
  } finally {
    await adminPool.end();
  }

  const connectionString = connectionStringForSchema(baseUrl, schemaName);
  const pool = new Pool({
    connectionString: baseUrl,
    options: `-c search_path=${schemaName},public`
  });

  const appliedFiles = [];

  const drop = async () => {
    await pool.end();
    const cleanupPool = new Pool({ connectionString: baseUrl });
    const client = await cleanupPool.connect();
    try {
      // `CREATE EXTENSION` runs with the scratch schema on the search_path, so the
      // extension lives inside it and `drop schema cascade` drops it too. That takes the
      // same catalog locks a concurrent harness takes while creating it, which deadlocks
      // once several test files run at once — so teardown waits on the migration lock.
      await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      await client.query(`drop schema if exists ${schemaName} cascade`);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
      client.release();
      await cleanupPool.end();
    }
  };

  try {
    // Same apply path as `npm run db:migrate`: the scratch schema is on the search_path,
    // so the ledger and every created object land inside it. node --test runs one process
    // per file, and runMigrations serializes the apply on an advisory lock — without it
    // concurrent `CREATE EXTENSION IF NOT EXISTS` (database-wide, not atomic) races.
    if (apply) {
      const client = await pool.connect();

      try {
        const result = await runMigrations({ client, seed });
        appliedFiles.push(...result.applied);
      } finally {
        client.release();
      }
    }
  } catch (error) {
    await drop();
    throw new Error(`failed to apply SQL into schema ${schemaName}: ${error.message}`, {
      cause: error
    });
  }

  return {
    schemaName,
    connectionString,
    pool,
    appliedFiles,
    query: (text, params) => pool.query(text, params),
    drop
  };
}

module.exports = {
  connectionStringForSchema,
  createTestDatabase,
  plannedMigrations,
  readSqlDirectory,
  skipWithoutDatabase,
  stripPsqlMetaCommands,
  testDatabaseUrl
};
