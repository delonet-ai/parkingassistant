'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { errorPayload, normalizeApiErrorPayload } = require('./errors');

test('normalizeApiErrorPayload fills status, code, and details from the status code', () => {
  const result = normalizeApiErrorPayload({ error: 'missing' }, 404);
  assert.deepEqual(result, {
    status: 'error',
    error: 'missing',
    code: 'not_found',
    details: null
  });
});

test('normalizeApiErrorPayload preserves an explicit code and details', () => {
  const result = normalizeApiErrorPayload(
    { error: 'bad', code: 'custom_code', details: { field: 'name' } },
    400
  );
  assert.equal(result.code, 'custom_code');
  assert.deepEqual(result.details, { field: 'name' });
});

test('normalizeApiErrorPayload maps known statuses to their default codes', () => {
  assert.equal(normalizeApiErrorPayload({ error: 'x' }, 400).code, 'bad_request');
  assert.equal(normalizeApiErrorPayload({ error: 'x' }, 409).code, 'conflict');
  assert.equal(normalizeApiErrorPayload({ error: 'x' }, 422).code, 'validation_error');
  assert.equal(normalizeApiErrorPayload({ error: 'x' }, 500).code, 'internal_error');
  assert.equal(normalizeApiErrorPayload({ error: 'x' }, 418).code, 'error');
});

test('normalizeApiErrorPayload passes through payloads without an error field', () => {
  assert.equal(normalizeApiErrorPayload(null, 500), null);
  assert.deepEqual(normalizeApiErrorPayload({ ok: true }, 500), { ok: true });
});

test('errorPayload builds a payload from an Error instance', () => {
  const result = errorPayload(new Error('boom'), 409);
  assert.equal(result.status, 'error');
  assert.equal(result.error, 'boom');
  assert.equal(result.code, 'conflict');
  assert.equal(result.details, null);
});

test('errorPayload accepts a plain string and custom details', () => {
  const result = errorPayload('invalid input', 422, { field: 'date' });
  assert.equal(result.error, 'invalid input');
  assert.equal(result.code, 'validation_error');
  assert.deepEqual(result.details, { field: 'date' });
});

test('errorPayload defaults to a 500 internal error', () => {
  const result = errorPayload(new Error('kaboom'));
  assert.equal(result.code, 'internal_error');
});
