'use strict';

// Integration-test harness: applies packages/db/schema/*.sql and packages/db/seeds/*.sql
// into a throwaway Postgres schema so every run starts from a known, isolated state.
//
// Requires DATABASE_URL_TEST pointing at a database the test user may create schemas in.
// See SETUP.md → "Integration test database".

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA_DIR = path.join(__dirname, '..', 'schema');
const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

const SKIP_REASON =
  'DATABASE_URL_TEST is not set — see SETUP.md → "Integration test database"';

// Arbitrary but stable key; only this harness takes it.
const SCHEMA_APPLY_LOCK_KEY = 918273645;

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

function readSqlDirectory(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: stripPsqlMetaCommands(fs.readFileSync(path.join(directory, name), 'utf8'))
    }));
}

// The seed files are written for psql and start with `\set ON_ERROR_STOP on`,
// which the wire protocol does not understand.
function stripPsqlMetaCommands(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
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
 * @param {{ seed?: boolean }} [options]
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
  const schemaName = scratchSchemaName();
  const adminPool = new Pool({ connectionString: baseUrl });

  try {
    await adminPool.query(`drop schema if exists ${schemaName} cascade`);
    await adminPool.query(`create schema ${schemaName}`);
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
    try {
      await cleanupPool.query(`drop schema if exists ${schemaName} cascade`);
    } finally {
      await cleanupPool.end();
    }
  };

  try {
    // node --test runs one process per file, so several harnesses apply the
    // schema at the same time. `CREATE EXTENSION IF NOT EXISTS` is not atomic
    // against a concurrent creation of the same extension — the losers get
    // `duplicate key value violates unique constraint "pg_extension_name_index"`
    // — and extensions are database-wide, not per-schema. Serializing the apply
    // step on a database-wide advisory lock removes the race; it costs nothing
    // because applying the DDL takes milliseconds.
    const client = await pool.connect();

    try {
      await client.query('select pg_advisory_lock($1)', [SCHEMA_APPLY_LOCK_KEY]);

      for (const file of readSqlDirectory(SCHEMA_DIR)) {
        await client.query(file.sql);
        appliedFiles.push(`schema/${file.name}`);
      }

      if (seed) {
        for (const file of readSqlDirectory(SEEDS_DIR)) {
          await client.query(file.sql);
          appliedFiles.push(`seeds/${file.name}`);
        }
      }
    } finally {
      await client.query('select pg_advisory_unlock($1)', [SCHEMA_APPLY_LOCK_KEY]).catch(() => {});
      client.release();
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
  SKIP_REASON,
  connectionStringForSchema,
  createTestDatabase,
  integrationTestsEnabled,
  readSqlDirectory,
  skipWithoutDatabase,
  stripPsqlMetaCommands,
  testDatabaseUrl
};
