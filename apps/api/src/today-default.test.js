'use strict';

// Regression guard for the Task 12 defect: three handlers derived "today" as
// `new Date().toISOString().slice(0, 10)` — i.e. in UTC — while every parking rule and
// every other handler derives it in APP_TIMEZONE.
//
// For the three hours between 21:00 and 24:00 UTC (the Moscow small hours) the two
// disagree, and the dashboard KPI panel silently answered for *yesterday* while the
// availability panel next to it answered for today. It was caught by the demo-seed
// integration test only because that run happened to land inside the window.
//
// This test asserts the source no longer contains the UTC form, because the wrong
// behaviour is only observable during three hours of the day and a test that reproduced
// it faithfully would itself pass 21 hours out of 24.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const { currentDateInTimezone } = require('../../../packages/shared/dates');

const SOURCES = [
  path.join(__dirname, 'server.js'),
  path.join(__dirname, '..', '..', 'admin-web', 'src', 'server.js')
];

describe('"today" is always derived in APP_TIMEZONE', () => {
  for (const source of SOURCES) {
    it(`${path.relative(path.join(__dirname, '..', '..', '..'), source)} never derives a date in UTC`, () => {
      const code = fs.readFileSync(source, 'utf8');

      assert.doesNotMatch(
        code,
        /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/,
        'use currentDateInTimezone(appTimezone) instead — UTC "today" is wrong for three hours a day'
      );
    });
  }

  it('the two derivations really do disagree, which is why this matters', () => {
    // Pinning the mechanism rather than the moment: a timezone ahead of UTC rolls over
    // first, so there is always a window where the UTC date is a day behind.
    const utcNoon = new Date('2026-07-19T21:30:00.000Z');
    const inMoscow = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Moscow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(utcNoon);

    assert.equal(utcNoon.toISOString().slice(0, 10), '2026-07-19');
    assert.equal(inMoscow, '2026-07-20', 'Moscow is already on the next day');
  });

  it('currentDateInTimezone returns a well-formed ISO date', () => {
    assert.match(currentDateInTimezone('Europe/Moscow'), /^\d{4}-\d{2}-\d{2}$/);
  });
});
