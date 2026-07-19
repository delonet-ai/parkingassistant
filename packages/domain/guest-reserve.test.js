'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAvailabilitySnapshot,
  employeePoolSize,
  guestReserveStatus,
  summarizeEmployeePool
} = require('./guest-reserve');

// The snapshot assertions below are the Phase 0 (Task 1) characterization tests for
// `services/availability.js`, relocated in Task 16 now that the arithmetic is here and
// the service is only the repository call. The SQL-parameter assertions stayed behind.

const fullRow = {
  released_places: 12,
  available_places: 8,
  before_19_employee_places: 6,
  after_19_employee_places: 3,
  available_single_places: 2,
  available_double_places: 4,
  available_triple_places: 2
};

const options = { date: '2026-07-17', timezone: 'Europe/Moscow', guestReserveMinimum: 5 };

test('buildAvailabilitySnapshot maps a full row into the public snapshot shape', () => {
  assert.deepEqual(buildAvailabilitySnapshot(fullRow, options), {
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

test('every counter defaults to 0 when the row is missing', () => {
  const snapshot = buildAvailabilitySnapshot(null, options);

  assert.equal(snapshot.releasedPlaces, 0);
  assert.equal(snapshot.availablePlaces, 0);
  assert.deepEqual(snapshot.employeeAvailability, { before19: 0, after19: 0 });
  assert.deepEqual(snapshot.byType, { single: 0, double: 0, triple: 0 });
  assert.equal(snapshot.guestReserve.status, 'low');
});

test('the snapshot echoes the date and timezone it was given', () => {
  const snapshot = buildAvailabilitySnapshot(fullRow, {
    date: '2027-01-01',
    timezone: 'UTC',
    guestReserveMinimum: 5
  });

  assert.equal(snapshot.date, '2027-01-01');
  assert.equal(snapshot.timezone, 'UTC');
});

test('guest reserve status is ok at exactly the minimum and low below it', () => {
  assert.equal(guestReserveStatus(5, 5), 'ok');
  assert.equal(guestReserveStatus(6, 5), 'ok');
  assert.equal(guestReserveStatus(4, 5), 'low');
  assert.equal(guestReserveStatus(0, 5), 'low');
});

test('a zero guest reserve minimum is never low', () => {
  assert.equal(guestReserveStatus(0, 0), 'ok');

  const snapshot = buildAvailabilitySnapshot({ ...fullRow, available_places: 0 }, {
    ...options,
    guestReserveMinimum: 0
  });

  assert.equal(snapshot.guestReserve.status, 'ok');
  assert.equal(snapshot.guestReserve.minimum, 0);
});

test('the employee pool is everything available beyond the reserve, never negative', () => {
  assert.equal(employeePoolSize(12, 5), 7);
  assert.equal(employeePoolSize(5, 5), 0);
  assert.equal(employeePoolSize(2, 5), 0);
  assert.equal(employeePoolSize(0, 5), 0);
  assert.equal(employeePoolSize(7, 0), 7);
});

test('summarizeEmployeePool caps the servable count at the pool size', () => {
  assert.deepEqual(summarizeEmployeePool({ employeePoolSize: 2, waitingCount: 5, servableCount: 5 }), {
    waitingCount: 5,
    servableCount: 2,
    unservableCount: 3
  });
});

test('summarizeEmployeePool reports nobody unservable when the pool covers the queue', () => {
  assert.deepEqual(summarizeEmployeePool({ employeePoolSize: 9, waitingCount: 3, servableCount: 3 }), {
    waitingCount: 3,
    servableCount: 3,
    unservableCount: 0
  });
});

test('summarizeEmployeePool treats missing counts as zero rather than NaN', () => {
  assert.deepEqual(summarizeEmployeePool({ employeePoolSize: 0 }), {
    waitingCount: 0,
    servableCount: 0,
    unservableCount: 0
  });
});
