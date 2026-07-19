'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createClientRepository, createDbRepository, withTransaction } = require('./db');

function createMockClient({ failOn = null, rows = [] } = {}) {
  const calls = [];
  let released = 0;

  return {
    calls,
    get released() {
      return released;
    },
    release() {
      released += 1;
    },
    async query(text, params) {
      calls.push({ text, params });

      if (failOn && text.includes(failOn)) {
        throw new Error(`query failed: ${text}`);
      }

      return { rows };
    }
  };
}

function createMockPool(client) {
  return {
    async connect() {
      return client;
    }
  };
}

test('createDbRepository: queryOne returns the first row and queryMany all rows', async () => {
  const pool = { async query() { return { rows: [{ id: 'a' }, { id: 'b' }] }; } };
  const repo = createDbRepository(pool);

  assert.deepEqual(await repo.queryOne('select 1'), { id: 'a' });
  assert.deepEqual(await repo.queryMany('select 1'), [{ id: 'a' }, { id: 'b' }]);
});

test('createDbRepository: queryOne returns null rather than undefined on no rows', async () => {
  const repo = createDbRepository({ async query() { return { rows: [] }; } });

  assert.equal(await repo.queryOne('select 1'), null);
});

test('createDbRepository: defaults params to an empty array', async () => {
  const calls = [];
  const repo = createDbRepository({
    async query(text, params) {
      calls.push({ text, params });
      return { rows: [] };
    }
  });

  await repo.queryMany('select 1');
  assert.deepEqual(calls[0].params, []);
});

test('createDbRepository: an unconfigured pool fails with the configuration message', async () => {
  const repo = createDbRepository(null);

  await assert.rejects(() => repo.queryOne('select 1'), /DATABASE_URL is not configured/);
  await assert.rejects(() => repo.queryMany('select 1'), /DATABASE_URL is not configured/);
});

test('createClientRepository: exposes the same surface plus the raw client', () => {
  const client = createMockClient();
  const repo = createClientRepository(client);

  assert.equal(typeof repo.queryOne, 'function');
  assert.equal(typeof repo.queryMany, 'function');
  assert.equal(repo.client, client);
});

test('withTransaction: wraps the callback in begin/commit and releases the client', async () => {
  const client = createMockClient({ rows: [{ id: 'place-1' }] });

  const result = await withTransaction(createMockPool(client), async (repo) => {
    return repo.queryOne('select * from parking_places where id = $1', ['place-1']);
  });

  assert.deepEqual(result, { id: 'place-1' });
  assert.deepEqual(
    client.calls.map((call) => call.text),
    ['begin', 'select * from parking_places where id = $1', 'commit']
  );
  assert.equal(client.released, 1);
});

test('withTransaction: rolls back and rethrows when the callback throws', async () => {
  const client = createMockClient();

  await assert.rejects(
    () => withTransaction(createMockPool(client), async () => {
      throw new Error('duplicate place code');
    }),
    /duplicate place code/
  );

  assert.deepEqual(client.calls.map((call) => call.text), ['begin', 'rollback']);
  assert.equal(client.released, 1);
});

test('withTransaction: rolls back when a query inside the callback fails', async () => {
  const client = createMockClient({ failOn: 'insert' });

  await assert.rejects(
    () => withTransaction(createMockPool(client), async (repo) => {
      await repo.queryMany('insert into parking_places default values');
    }),
    /query failed/
  );

  assert.equal(client.calls.at(-1).text, 'rollback');
  assert.equal(client.released, 1);
});

test('withTransaction: a failing rollback does not mask the original error', async () => {
  const client = createMockClient({ failOn: 'rollback' });

  await assert.rejects(
    () => withTransaction(createMockPool(client), async () => {
      throw new Error('original failure');
    }),
    (error) => {
      assert.match(error.message, /original failure/);
      assert.match(error.rollbackError.message, /rollback/);
      return true;
    }
  );

  assert.equal(client.released, 1);
});

test('withTransaction: releases the client even when commit fails', async () => {
  const client = createMockClient({ failOn: 'commit' });

  await assert.rejects(
    () => withTransaction(createMockPool(client), async () => 'value'),
    /query failed: commit/
  );

  assert.equal(client.released, 1);
});

test('withTransaction: the callback return value is passed through untouched', async () => {
  const client = createMockClient();
  const payload = { statusCode: 404, payload: { status: 'error' } };

  // A 404-shaped return still commits: the helper never inspects the value, so a service
  // that wants to abort has to throw (ADR 003).
  const result = await withTransaction(createMockPool(client), async () => payload);

  assert.equal(result, payload);
  assert.ok(client.calls.some((call) => call.text === 'commit'));
});

test('withTransaction: an unconfigured pool fails before connecting', async () => {
  await assert.rejects(
    () => withTransaction(null, async () => 'never'),
    /DATABASE_URL is not configured/
  );
});
