'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { uuidValidationError } = require('./params');

describe('uuidValidationError', () => {
  const validUuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

  it('passes a well-formed uuid', () => {
    assert.equal(uuidValidationError({ userId: validUuid }), null);
  });

  it('passes an uppercase uuid, since Postgres accepts either case', () => {
    assert.equal(uuidValidationError({ userId: validUuid.toUpperCase() }), null);
  });

  // Absent is the caller's own required-check to report. Folding the two together would
  // relabel every existing "X is required" 400 — including 15 pinned golden snapshots.
  for (const [label, value] of [
    ['null', null],
    ['undefined', undefined],
    ['empty string', '']
  ]) {
    it(`skips an absent field (${label})`, () => {
      assert.equal(uuidValidationError({ userId: value }), null);
    });
  }

  for (const [label, value] of [
    ['plain text', 'not-a-uuid'],
    ['a number', 42],
    ['too short', '3f2504e0-4f89-11d3-9a0c'],
    ['a trailing character', `${validUuid}x`],
    ['a non-hex digit', '3f2504e0-4f89-11d3-9a0c-0305e82c330z'],
    ['a SQL fragment', "' or 1=1 --"]
  ]) {
    it(`rejects ${label}`, () => {
      const result = uuidValidationError({ userId: value });

      assert.equal(result.statusCode, 400);
      assert.equal(result.payload.error, 'userId must be a valid uuid');
      assert.equal(result.payload.service, 'api');
      assert.equal(result.payload.status, 'error');
    });
  }

  it('names every invalid field, not just the first', () => {
    const result = uuidValidationError({
      userId: 'nope',
      parkingPlaceId: validUuid,
      reservationId: 'also-nope'
    });

    assert.equal(result.payload.error, 'userId, reservationId must be a valid uuid');
  });

  // The whole point: the offending value must not come back to the client, because that is
  // what the raw driver message ("invalid input syntax for type uuid: ...") used to do.
  it('does not echo the rejected value', () => {
    const result = uuidValidationError({ userId: "'; drop table users; --" });

    assert.ok(!result.payload.error.includes('drop table'));
  });
});
