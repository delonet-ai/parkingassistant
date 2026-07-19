'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { calculateAvailabilitySnapshot, countAvailableReleasedPlaces } = require('./availability');

// Characterization tests: they pin the behavior that exists today, including the
// parameters handed to Postgres, so the Phase 3 repository extraction can be
// checked against them. The SQL-evaluated parts (the `greatest(available - $2, 0)`
// after-19:00 pool, the per-place-type counters) are pinned here only at the
// mapping level; their arithmetic is covered by the Task 3 integration tests.

function createMockClient(rows) {
  const calls = [];

  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      return { rows };
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

test('guest reserve status is ok at exactly the minimum and low below it', async () => {
  const atMinimum = await calculateAvailabilitySnapshot(
    createMockClient([{ ...fullRow, available_places: 5 }]),
    '2026-07-17',
    options
  );
  assert.equal(atMinimum.guestReserve.status, 'ok');

  const belowMinimum = await calculateAvailabilitySnapshot(
    createMockClient([{ ...fullRow, available_places: 4 }]),
    '2026-07-17',
    options
  );
  assert.equal(belowMinimum.guestReserve.status, 'low');

  const empty = await calculateAvailabilitySnapshot(
    createMockClient([{ ...fullRow, available_places: 0 }]),
    '2026-07-17',
    options
  );
  assert.equal(empty.guestReserve.status, 'low');
  assert.equal(empty.guestReserve.availablePlaces, 0);
});

test('a zero guest reserve minimum is never low', async () => {
  const snapshot = await calculateAvailabilitySnapshot(
    createMockClient([{ ...fullRow, available_places: 0 }]),
    '2026-07-17',
    { appTimezone: 'Europe/Moscow', guestReserveMinimum: 0 }
  );

  assert.equal(snapshot.guestReserve.status, 'ok');
  assert.equal(snapshot.guestReserve.minimum, 0);
});

test('calculateAvailabilitySnapshot defaults every counter to 0 when the row is missing', async () => {
  const snapshot = await calculateAvailabilitySnapshot(createMockClient([]), '2026-07-17', options);

  assert.equal(snapshot.releasedPlaces, 0);
  assert.equal(snapshot.availablePlaces, 0);
  assert.deepEqual(snapshot.employeeAvailability, { before19: 0, after19: 0 });
  assert.deepEqual(snapshot.byType, { single: 0, double: 0, triple: 0 });
  assert.equal(snapshot.guestReserve.status, 'low');
});

test('calculateAvailabilitySnapshot echoes the date and timezone it was given', async () => {
  const snapshot = await calculateAvailabilitySnapshot(createMockClient([fullRow]), '2027-01-01', {
    appTimezone: 'UTC',
    guestReserveMinimum: 5
  });

  assert.equal(snapshot.date, '2027-01-01');
  assert.equal(snapshot.timezone, 'UTC');
});

test('countAvailableReleasedPlaces returns the count for the requested date', async () => {
  const client = createMockClient([{ count: 7 }]);

  assert.equal(await countAvailableReleasedPlaces(client, '2026-07-17'), 7);
  assert.deepEqual(client.calls[0].params, ['2026-07-17']);
});

test('countAvailableReleasedPlaces falls back to 0 for an empty or null count', async () => {
  assert.equal(await countAvailableReleasedPlaces(createMockClient([]), '2026-07-17'), 0);
  assert.equal(await countAvailableReleasedPlaces(createMockClient([{ count: null }]), '2026-07-17'), 0);
  assert.equal(await countAvailableReleasedPlaces(createMockClient([{ count: 0 }]), '2026-07-17'), 0);
});

test('countAvailableReleasedPlaces excludes places already reserved for the date', async () => {
  const client = createMockClient([{ count: 0 }]);

  await countAvailableReleasedPlaces(client, '2026-07-17');

  assert.match(client.calls[0].text, /r\.status = 'active'/);
  assert.match(client.calls[0].text, /and r\.id is null/);
});
