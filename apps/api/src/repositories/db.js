'use strict';

// The one database access pattern (ADR 003). Everything that talks to Postgres does it
// through a repository built here: `createDbRepository(pool)` for pool-scoped reads,
// `withTransaction(pool, fn)` for anything that needs a transaction boundary. Both hand
// out the same `queryOne` / `queryMany` surface, so a query moves between them without
// being rewritten.

function buildQueries(executor, missingMessage) {
  async function queryOne(text, params = []) {
    if (!executor) {
      throw new Error(missingMessage);
    }

    const result = await executor.query(text, params);
    return result.rows[0] || null;
  }

  async function queryMany(text, params = []) {
    if (!executor) {
      throw new Error(missingMessage);
    }

    const result = await executor.query(text, params);
    return result.rows;
  }

  return { queryMany, queryOne };
}

function createDbRepository(pool) {
  return buildQueries(pool, 'DATABASE_URL is not configured');
}

function createClientRepository(client) {
  return {
    ...buildQueries(client, 'transaction client is not available'),
    client
  };
}

// Runs `fn` inside a single transaction and hands it a client-bound repository.
// Commits when `fn` returns, rolls back when it throws, always releases the client.
// The return value is never inspected: a service that wants to abort throws, because
// "returned a 404 payload" and "returned a success payload" must not be distinguishable
// to the transaction helper.
async function withTransaction(pool, fn) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const result = await fn(createClientRepository(client));

    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      // A failed rollback must not mask the error that caused it; the client is released
      // below either way and pg discards a connection that errored.
      error.rollbackError = rollbackError;
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  createClientRepository,
  createDbRepository,
  withTransaction
};
