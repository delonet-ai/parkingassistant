'use strict';

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return typeof value === 'string' && isoDatePattern.test(value);
}

function formatDateForSql(value) {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return String(value).slice(0, 10);
}

function currentDateInTimezone(timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function currentTimeInTimezone(timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(new Date());
}

function addDaysToIsoDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + days));
  return nextDate.toISOString().slice(0, 10);
}

function isValidTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// The 18:00 early-departure cut-off is a business rule, not a date utility: it lives in
// `packages/domain/scheduling.js` alongside the 07:00 edit lock.

module.exports = {
  addDaysToIsoDate,
  currentDateInTimezone,
  currentTimeInTimezone,
  formatDateForSql,
  isIsoDate,
  isValidTime
};
