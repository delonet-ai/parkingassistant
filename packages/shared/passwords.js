'use strict';

const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);

// Password hashing on `node:crypto` scrypt — no dependency to add, no plaintext anywhere.
//
// The stored value carries its own cost parameters:
//   scrypt$<N>$<r>$<p>$<base64 salt>$<base64 hash>
// so the defaults below can be raised later and every existing hash still verifies with the
// parameters it was made with.
const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Upper bounds on what a stored value may ask for. The parameters come from the database,
// and a corrupted or planted row must not be able to make one verify burn a gigabyte.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;

function scryptOptions({ N, r, p }) {
  // scrypt needs roughly 128 * N * r bytes; the default `maxmem` (32 MiB) is below what a
  // raised N would need, so it is sized from the parameters rather than left implicit.
  return { N, r, p, maxmem: 256 * N * r };
}

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new TypeError('password must be a non-empty string');
  }

  const params = DEFAULT_PARAMS;
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await scrypt(plain, salt, KEY_BYTES, scryptOptions(params));

  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function parsePositiveInteger(text) {
  return /^[1-9][0-9]*$/.test(text) ? Number(text) : null;
}

function isBase64(text) {
  return typeof text === 'string' && text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text);
}

function parseStoredHash(stored) {
  if (typeof stored !== 'string') {
    return null;
  }

  const parts = stored.split('$');

  if (parts.length !== 6 || parts[0] !== 'scrypt') {
    return null;
  }

  const [, nText, rText, pText, saltText, hashText] = parts;
  const N = parsePositiveInteger(nText);
  const r = parsePositiveInteger(rText);
  const p = parsePositiveInteger(pText);

  // N must be a power of two greater than one — scrypt itself refuses anything else.
  if (!N || N < 2 || N > MAX_N || (N & (N - 1)) !== 0) {
    return null;
  }

  if (!r || r > MAX_R || !p || p > MAX_P) {
    return null;
  }

  if (!isBase64(saltText) || !isBase64(hashText)) {
    return null;
  }

  const salt = Buffer.from(saltText, 'base64');
  const hash = Buffer.from(hashText, 'base64');

  if (salt.length === 0 || hash.length === 0) {
    return null;
  }

  return { params: { N, r, p }, salt, hash };
}

// Answers false for a wrong password AND for a stored value that is not a hash this module
// wrote — the bootstrap placeholder `{PENDING_IMPLEMENTATION}` included. Never throws on bad
// input: a caller checking a login must not be able to turn a corrupt row into a 500.
async function verifyPassword(plain, stored) {
  const parsed = parseStoredHash(stored);

  if (!parsed || typeof plain !== 'string') {
    return false;
  }

  try {
    const candidate = await scrypt(plain, parsed.salt, parsed.hash.length, scryptOptions(parsed.params));
    return candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_PARAMS,
  hashPassword,
  verifyPassword
};
