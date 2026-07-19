'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEPARTURE_EDIT_CUTOFF,
  EARLY_DEPARTURE_CUTOFF,
  findDriftedDeparturePlans,
  isDepartureEditClosed,
  isEarlyDeparture,
  normalizeDepartureTime
} = require('./scheduling');

// Relocated from `packages/shared/dates.test.js` (Phase 0, Task 1) in Task 16: the
// 18:00 cut-off is a business rule, so it lives next to the rule now.
test('isEarlyDeparture is true only for valid times before 18:00', () => {
  assert.equal(isEarlyDeparture('17:59'), true);
  assert.equal(isEarlyDeparture('09:00'), true);
  assert.equal(isEarlyDeparture('18:00'), false);
  assert.equal(isEarlyDeparture('19:30'), false);
  assert.equal(isEarlyDeparture('not-a-time'), false);
});

test('isEarlyDeparture rejects anything that is not a zero-padded HH:MM string', () => {
  assert.equal(isEarlyDeparture('9:00'), false);
  assert.equal(isEarlyDeparture('17:59:00'), false);
  assert.equal(isEarlyDeparture('24:00'), false);
  assert.equal(isEarlyDeparture(''), false);
  assert.equal(isEarlyDeparture(null), false);
  assert.equal(isEarlyDeparture(1759), false);
});

test('the cut-offs are the documented ones', () => {
  assert.equal(EARLY_DEPARTURE_CUTOFF, '18:00');
  assert.equal(DEPARTURE_EDIT_CUTOFF, '07:00');
});

test('normalizeDepartureTime trims the seconds Postgres adds', () => {
  assert.equal(normalizeDepartureTime('17:30:00'), '17:30');
  assert.equal(normalizeDepartureTime('17:30'), '17:30');
  assert.equal(normalizeDepartureTime(undefined), '');
  assert.equal(normalizeDepartureTime(null), '');
});

test('a plan for today is locked from 07:00 and editable before it', () => {
  const today = '2026-07-19';

  assert.equal(isDepartureEditClosed({ planDate: today, today, currentTime: '06:59' }), false);
  assert.equal(isDepartureEditClosed({ planDate: today, today, currentTime: '07:00' }), true);
  assert.equal(isDepartureEditClosed({ planDate: today, today, currentTime: '23:59' }), true);
});

test('a plan for another date is never closed by the wall clock', () => {
  const today = '2026-07-19';

  assert.equal(isDepartureEditClosed({ planDate: '2026-07-20', today, currentTime: '23:59' }), false);
  assert.equal(isDepartureEditClosed({ planDate: '2026-07-18', today, currentTime: '12:00' }), false);
});

test('findDriftedDeparturePlans returns only the rows whose stored flag disagrees', () => {
  const drifted = findDriftedDeparturePlans([
    { id: 'a', departure_time: '17:00:00', is_early: true },
    { id: 'b', departure_time: '17:00:00', is_early: false },
    { id: 'c', departure_time: '19:00:00', is_early: true },
    { id: 'd', departure_time: '19:00:00', is_early: false }
  ]);

  assert.deepEqual(drifted, [
    { id: 'b', isEarly: true },
    { id: 'c', isEarly: false }
  ]);
});

test('findDriftedDeparturePlans is empty for an empty list, so a replay changes nothing', () => {
  assert.deepEqual(findDriftedDeparturePlans([]), []);

  const consistent = [{ id: 'a', departure_time: '17:00:00', is_early: true }];
  assert.deepEqual(findDriftedDeparturePlans(consistent), []);
  assert.deepEqual(findDriftedDeparturePlans(consistent), []);
});
