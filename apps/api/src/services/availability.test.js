'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateAvailabilitySnapshot, countAvailableReleasedPlaces } = require('./availability');

// Characterization tests: they pin the behavior that exists today, including the
// parameters handed to Postgres, so the Phase 3 repository extraction can be
// checked against them. The SQL-evaluated parts (the `greatest(available - $2, 0)`
// after-19:00 pool, the per-place-type counters) are pinned here only at the
// mapping level; their arithmetic is covered by the Task 3 integration tests.
//
// Task 15 moved the SQL itself into `modules/place-releases/repository.js`, so the mock
// is now the `queryOne`/`queryMany` surface a repository is handed rather than a raw pg
// client. The assertions on the SQL text still hold — the repository is what runs it now.
//
// Task 16 moved the arithmetic into `packages/domain/guest-reserve.js`, and the snapshot
// shape / reserve-status assertions moved to `guest-reserve.test.js` with it. What is
// left here is what this file is now responsible for: that the service asks the
// repository the right question and hands the answer to the right rule.

function createMockClient(rows) {
  const calls = [];

  return {
    calls,
    async queryOne(text, params) {
      calls.push({ text, params });
      return rows[0] || null;
    },
    async queryMany(text, params) {
      calls.push({ text, params });
      return rows;
    }
  };
}

const options = { appTimezone: 'Europe/Moscow', guestReserveMinimum: 5 };

const fullRow = {
  released_places: 12,
  available_places: 8,
  before_19_employee_places: 6,
  after_19_employee_places: 3,
  available_single_places: 2,
  available_double_places: 4,
  available_triple_places: 2
};

test('calculateAvailabilitySnapshot maps a full row into the public snapshot shape', async () => {
  const client = createMockClient([fullRow]);

  const snapshot = await calculateAvailabilitySnapshot(client, '2026-07-17', options);

  assert.deepEqual(snapshot, {
    date: '2026-07-17',
    timezone: 'Europe/Moscow',
    releasedPlaces: 12,
    availablePlaces: 8,
    employeeAvailability: {
      before19: 6,
      after19: 3
    },
    guestReserve: {
      minimum: 5,
      availablePlaces: 8,
      status: 'ok'
    },
    byType: {
      single: 2,
      double: 4,
      triple: 2
    }
  });
});

test('calculateAvailabilitySnapshot passes the date and the guest reserve minimum to SQL', async () => {
  const client = createMockClient([fullRow]);

  await calculateAvailabilitySnapshot(client, '2026-07-17', options);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params, ['2026-07-17', 5]);
  assert.match(client.calls[0].text, /from place_releases pr/);
  assert.match(client.calls[0].text, /pr\.release_during @> \$1::date/);
});

test('countAvailableReleasedPlaces returns the count for the requested date', async () => {
  const client = createMockClient([{ available_places: 7 }]);

  assert.equal(await countAvailableReleasedPlaces(client, '2026-07-17'), 7);
  assert.deepEqual(client.calls[0].params, ['2026-07-17']);
});

test('countAvailableReleasedPlaces falls back to 0 for an empty or null count', async () => {
  assert.equal(await countAvailableReleasedPlaces(createMockClient([]), '2026-07-17'), 0);
  assert.equal(await countAvailableReleasedPlaces(createMockClient([{ available_places: null }]), '2026-07-17'), 0);
  assert.equal(await countAvailableReleasedPlaces(createMockClient([{ available_places: 0 }]), '2026-07-17'), 0);
});

test('countAvailableReleasedPlaces excludes places already reserved for the date', async () => {
  const client = createMockClient([{ available_places: 0 }]);

  await countAvailableReleasedPlaces(client, '2026-07-17');

  assert.match(client.calls[0].text, /r\.status = 'active'/);
  assert.match(client.calls[0].text, /and r\.id is null/);
});
