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

test('currentDateInTimezone returns an ISO date for a valid zone', () => {
  const value = currentDateInTimezone('Europe/Moscow');
  assert.equal(isIsoDate(value), true);
});

test('currentTimeInTimezone returns a valid HH:MM for a valid zone', () => {
  const value = currentTimeInTimezone('Europe/Moscow');
  assert.equal(isValidTime(value), true);
});
