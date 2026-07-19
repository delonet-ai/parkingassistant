'use strict';

// Demo dataset loader.
//
// The demo data is deliberately NOT part of the migrate ledger: `npm run db:migrate`
// applies packages/db/schema/*.sql and packages/db/seeds/*.sql only, so a production
// deploy never picks it up. The demo files live one level down, in
// packages/db/seeds/demo/, and are loaded explicitly with `npm run db:seed:demo`.
//
// Reloading is idempotent by construction: the reset file removes every demo-tagged row
// first, then the dataset file inserts the same content again. Both run inside one
// connection so the temp tables they use are visible to the statements that follow.
//
// See SETUP.md → "Demo dataset" and docs/TECHNICAL_README.md.

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { stripPsqlMetaCommands } = require('./migrate');

const DEMO_DIR = path.join(__dirname, 'seeds', 'demo');

const RESET_FILE = '000_reset.sql';
const DATASET_FILE = '001_demo_dataset.sql';

function readDemoSql(filename) {
  return stripPsqlMetaCommands(fs.readFileSync(path.join(DEMO_DIR, filename), 'utf8'));
}

/**
 * Remove every demo-tagged row. No-op on a database that never had demo data.
 *
 * @param {{ client: import('pg').ClientBase, logger?: { log: (m: string) => void } | null }} options
 */
async function resetDemoData({ client, logger = null }) {
  if (!client) {
    throw new Error('resetDemoData requires a connected pg client');
  }

  await client.query(readDemoSql(RESET_FILE));

  if (logger) {
    logger.log('demo dataset removed');
  }
}

/**
 * Reset, then load the demo dataset. Safe to run repeatedly.
 *
 * @param {{ client: import('pg').ClientBase, logger?: { log: (m: string) => void } | null }} options
 */
async function loadDemoData({ client, logger = null }) {
  if (!client) {
    throw new Error('loadDemoData requires a connected pg client');
  }

  await client.query(readDemoSql(RESET_FILE));
  await client.query(readDemoSql(DATASET_FILE));

  if (logger) {
    logger.log('demo dataset loaded');
  }
}

/**
 * loadDemoData/resetDemoData against a connection string, managing the pool itself.
 *
 * @param {{ connectionString: string, reset?: boolean, logger?: object | null }} options
 */
async function seedDemoDatabase({ connectionString, reset = false, logger = null }) {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();

  try {
    if (reset) {
      return await resetDemoData({ client, logger });
    }

    return await loadDemoData({ client, logger });
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

  const reset = process.argv.includes('--reset');

  try {
    await seedDemoDatabase({ connectionString, reset, logger: console });
  } catch (error) {
    console.error(`demo seed failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEMO_DIR,
  DATASET_FILE,
  RESET_FILE,
  loadDemoData,
  readDemoSql,
  resetDemoData,
  seedDemoDatabase
};
