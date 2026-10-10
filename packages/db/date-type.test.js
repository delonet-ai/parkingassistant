'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { types } = require('pg');

const { DATE_OID, registerDateTypeParser } = require('./date-type');

// The regression this guards is invisible in UTC, so the test states the timezone it is
// about: `pg`'s default `date` parser builds a `Date` at local midnight, which east of
// Greenwich serializes to the previous day. `node --test` runs one process per file and the
// parser registry is process-wide, so mutating it here affects nothing else.
describe('date type parser', () => {
  it('parses a date as a Date at local midnight by default — the shape that loses a day', () => {
    const parsed = types.getTypeParser(DATE_OID)('2026-10-10');

    assert.ok(parsed instanceof Date);
    // Asserted as local parts rather than as an ISO string: the ISO string depends on the
    // runner's timezone, and that dependency is the defect, not the assertion.
    assert.equal(parsed.getFullYear(), 2026);
    assert.equal(parsed.getMonth(), 9);
    assert.equal(parsed.getDate(), 10);
    assert.equal(parsed.getHours(), 0);
  });

  it('hands back the text Postgres wrote once registered', () => {
    registerDateTypeParser();

    assert.equal(types.getTypeParser(DATE_OID)('2026-10-10'), '2026-10-10');
    assert.equal(types.getTypeParser(DATE_OID)('2026-01-01'), '2026-01-01');
  });
});
