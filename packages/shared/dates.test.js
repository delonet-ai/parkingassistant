'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addDaysToIsoDate,
  currentDateInTimezone,
  currentTimeInTimezone,
  formatDateForSql,
  isEarlyDeparture,
  isIsoDate,
  isValidTime
} = require('./dates');

test('isIsoDate accepts YYYY-MM-DD and rejects everything else', () => {
  assert.equal(isIsoDate('2026-07-17'), true);
  assert.equal(isIsoDate('2026-7-7'), false);
  assert.equal(isIsoDate('17-07-2026'), false);
  assert.equal(isIsoDate('2026-07-17T10:00:00Z'), false);
  assert.equal(isIsoDate(20260717), false);
  assert.equal(isIsoDate(null), false);
});

test('formatDateForSql trims a Date or string to the date part', () => {
  assert.equal(formatDateForSql(new Date('2026-07-17T23:30:00Z')), '2026-07-17');
  assert.equal(formatDateForSql('2026-07-17T10:00'), '2026-07-17');
  assert.equal(formatDateForSql('2026-07-17'), '2026-07-17');
});

test('addDaysToIsoDate handles month and year rollover in both directions', () => {
  assert.equal(addDaysToIsoDate('2026-07-17', 1), '2026-07-18');
  assert.equal(addDaysToIsoDate('2026-07-31', 1), '2026-08-01');
  assert.equal(addDaysToIsoDate('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToIsoDate('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysToIsoDate('2026-03-01', -1), '2026-02-28');
  assert.equal(addDaysToIsoDate('2026-07-17', 0), '2026-07-17');
});

test('isValidTime accepts 24h HH:MM only', () => {
  assert.equal(isValidTime('00:00'), true);
  assert.equal(isValidTime('18:00'), true);
  assert.equal(isValidTime('23:59'), true);
  assert.equal(isValidTime('24:00'), false);
  assert.equal(isValidTime('7:00'), false);
  assert.equal(isValidTime('23:60'), false);
  assert.equal(isValidTime('noon'), false);
});

test('isEarlyDeparture is true only for valid times before 18:00', () => {
  assert.equal(isEarlyDeparture('17:59'), true);
  assert.equal(isEarlyDeparture('09:00'), true);
  assert.equal(isEarlyDeparture('18:00'), false);
  assert.equal(isEarlyDeparture('19:30'), false);
  assert.equal(isEarlyDeparture('not-a-time'), false);
});

// The 07:00 departure-edit lock (apps/api/src/server.js) and the 19:00 / 08:00 / 07:00
// job triggers (apps/jobs/src/scheduler.js) all compare `currentTimeInTimezone()` output
// against a literal `HH:MM` string. That only works because zero-padded h23 times sort
// chronologically as strings — pin it here so the comparison style stays safe.
test('zero-padded HH:MM strings compare chronologically', () => {
  assert.equal('07:00' >= '07:00', true);
  assert.equal('06:59' >= '07:00', false);
  assert.equal('07:01' >= '07:00', true);
  assert.equal('18:59' >= '19:00', false);
  assert.equal('19:00' >= '19:00', true);
  assert.equal('23:59' >= '19:00', true);
  assert.equal('00:00' >= '07:00', false);
  assert.equal('09:00' < '10:00', true);
});

test('currentTimeInTimezone output is zero-padded, so cut-off comparisons hold', () => {
  const value = currentTimeInTimezone('Europe/Moscow');
  assert.equal(value.length, 5);
  assert.equal(isValidTime(value), true);
  assert.equal(value[2], ':');
});

test('currentDateInTimezone returns an ISO date for a valid zone', () => {
  const value = currentDateInTimezone('Europe/Moscow');
  assert.equal(isIsoDate(value), true);
});

test('currentTimeInTimezone returns a valid HH:MM for a valid zone', () => {
  const value = currentTimeInTimezone('Europe/Moscow');
  assert.equal(isValidTime(value), true);
});
