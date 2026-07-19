'use strict';

// Idempotent schema/seed applier.
//
// Every file under packages/db/schema and packages/db/seeds is applied exactly once and
// recorded in a `schema_migrations` ledger, so re-running against an already-migrated
// database is a no-op. This is the single apply path: the integration harness, the CLI
// (`npm run db:migrate`) and the stack startup step all go through runMigrations().
//
// See docs/TECHNICAL_README.md → Deployment → Schema migrations.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const SCHEMA_DIR = path.join(__dirname, 'schema');
const SEEDS_DIR = path.join(__dirname, 'seeds');

// Arbitrary but stable key; only the migration runner takes it.
const MIGRATION_LOCK_KEY = 918273645;

const LEDGER_TABLE = 'schema_migrations';

const CREATE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

// The seed files are written for psql and start with `\set ON_ERROR_STOP on`,
// which the wire protocol does not understand.
function stripPsqlMetaCommands(sql) {
  return sql
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
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

/**
 * The files this runner would apply to an empty database, in apply order.
 *
 * @param {{ seed?: boolean }} [options]
 * @returns {Array<{ key: string, sql: string }>}
 */
function plannedMigrations(options = {}) {
  const seed = options.seed !== false;

  const planned = readSqlDirectory(SCHEMA_DIR).map((file) => ({
    key: `schema/${file.name}`,
    sql: file.sql
  }));

  if (seed) {
    for (const file of readSqlDirectory(SEEDS_DIR)) {
      planned.push({ key: `seeds/${file.name}`, sql: file.sql });
    }
  }

  return planned;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function appliedKeys(client) {
  const result = await client.query(`SELECT filename FROM ${LEDGER_TABLE}`);
  return new Set(result.rows.map((row) => row.filename));
}

/**
 * Apply every not-yet-applied schema and seed file.
 *
 * Safe to run concurrently and repeatedly: the whole apply is serialized on a database-wide
 * advisory lock, and each file is skipped once its ledger row exists.
 *
 * @param {{
 *   client: import('pg').ClientBase,
 *   seed?: boolean,
 *   logger?: { log: (message: string) => void } | null
 * }} options
 * @returns {Promise<{ applied: string[], skipped: string[] }>}
 */
async function runMigrations({ client, seed = true, logger = null }) {
  if (!client) {
    throw new Error('runMigrations requires a connected pg client');
  }

  const applied = [];
  const skipped = [];

  // `CREATE EXTENSION IF NOT EXISTS` is not atomic against a concurrent creation of the
  // same extension, and extensions are database-wide rather than per-schema. Serializing
  // the apply step removes that race; it costs nothing because the DDL takes milliseconds.
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

  try {
    await client.query(CREATE_LEDGER_SQL);
    const done = await appliedKeys(client);

    for (const migration of plannedMigrations({ seed })) {
      if (done.has(migration.key)) {
        skipped.push(migration.key);
        continue;
      }

      // The migration files carry their own BEGIN/COMMIT, so the ledger insert is appended
      // to the same multi-statement query string: if the file fails, the insert is never
      // reached and the file stays unrecorded.
      const ledgerInsert = `INSERT INTO ${LEDGER_TABLE} (filename) VALUES (${quoteLiteral(
        migration.key
      )}) ON CONFLICT (filename) DO NOTHING;`;

      await client.query(`${migration.sql}\n${ledgerInsert}`);
      applied.push(migration.key);

      if (logger) {
        logger.log(`applied ${migration.key}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
  }

  if (logger) {
    logger.log(
      applied.length === 0
        ? `nothing to apply — ${skipped.length} migration(s) already recorded`
        : `applied ${applied.length} migration(s), skipped ${skipped.length}`
    );
  }

  return { applied, skipped };
}

/**
 * runMigrations against a connection string, managing the pool itself.
 *
 * @param {{ connectionString: string, seed?: boolean, logger?: object | null }} options
 */
async function migrateDatabase({ connectionString, seed = true, logger = null }) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    return await runMigrations({ client, seed, logger });
  } finally {
    client.release();
    await pool.end();
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const seed = !process.argv.includes('--no-seed');

  try {
    await migrateDatabase({ connectionString, seed, logger: console });
  } catch (error) {
    console.error(`migration failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  LEDGER_TABLE,
  MIGRATION_LOCK_KEY,
  plannedMigrations,
  readSqlDirectory,
  runMigrations,
  stripPsqlMetaCommands
};
