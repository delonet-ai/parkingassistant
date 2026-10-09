'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_PARAMS, hashPassword, verifyPassword } = require('./passwords');

test('a hash verifies against its own password', async () => {
  const stored = await hashPassword('correct horse battery');

  assert.equal(await verifyPassword('correct horse battery', stored), true);
});

test('a hash fails against another password', async () => {
  const stored = await hashPassword('correct horse battery');

  assert.equal(await verifyPassword('correct horse battery!', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('two hashes of the same password differ, because the salt is real', async () => {
  const first = await hashPassword('same password twice');
  const second = await hashPassword('same password twice');

  assert.notEqual(first, second);
  assert.notEqual(first.split('$')[4], second.split('$')[4]);
  assert.equal(await verifyPassword('same password twice', first), true);
  assert.equal(await verifyPassword('same password twice', second), true);
});

test('the stored value carries its own parameters', async () => {
  const stored = await hashPassword('parameters inside');
  const [scheme, N, r, p, salt, hash] = stored.split('$');

  assert.equal(scheme, 'scrypt');
  assert.deepEqual({ N: Number(N), r: Number(r), p: Number(p) }, DEFAULT_PARAMS);
  assert.equal(Buffer.from(salt, 'base64').length, 16);
  assert.equal(Buffer.from(hash, 'base64').length, 64);
});

test('a hash made with other parameters still verifies with them', async () => {
  // Simulates a hash written before the defaults were raised: the stored N wins.
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync('older hash', salt, 64, { N: 1024, r: 8, p: 1 });
  const stored = ['scrypt', 1024, 8, 1, salt.toString('base64'), hash.toString('base64')].join('$');

  assert.equal(await verifyPassword('older hash', stored), true);
  assert.equal(await verifyPassword('other', stored), false);
});

test('a malformed stored value is refused rather than throwing', async () => {
  const valid = await hashPassword('anything at all');
  const [, , , , salt, hash] = valid.split('$');

  const malformed = [
    undefined,
    null,
    42,
    '',
    '{PENDING_IMPLEMENTATION}',
    'scrypt',
    `bcrypt$16384$8$1$${salt}$${hash}`,
    `scrypt$16384$8$1$${salt}`,
    `scrypt$16384$8$1$${salt}$${hash}$extra`,
    `scrypt$1000$8$1$${salt}$${hash}`,
    `scrypt$0$8$1$${salt}$${hash}`,
    `scrypt$-16384$8$1$${salt}$${hash}`,
    `scrypt$16384$0$1$${salt}$${hash}`,
    `scrypt$16384$8$x$${salt}$${hash}`,
    `scrypt$${2 ** 30}$8$1$${salt}$${hash}`,
    `scrypt$16384$8$1$$${hash}`,
    `scrypt$16384$8$1$${salt}$not*base64`
  ];

  for (const stored of malformed) {
    assert.equal(await verifyPassword('anything at all', stored), false, `accepted ${String(stored)}`);
  }
});

test('a non-string password is refused by verify and rejected by hash', async () => {
  const stored = await hashPassword('a real password');

  assert.equal(await verifyPassword(undefined, stored), false);
  assert.equal(await verifyPassword(null, stored), false);
  await assert.rejects(() => hashPassword(''), TypeError);
  await assert.rejects(() => hashPassword(undefined), TypeError);
});
