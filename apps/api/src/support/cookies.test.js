'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCookies, readCookie, serializeCookie } = require('./cookies');

test('parseCookies reads the pairs of a normal header', () => {
  assert.deepEqual(parseCookies('pa_session=abc; other=1'), { pa_session: 'abc', other: '1' });
});

test('parseCookies tolerates spacing, an empty header and a missing one', () => {
  assert.deepEqual(parseCookies('  pa_session = abc  '), { pa_session: 'abc' });
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(null), {});
});

// The header is client-controlled, so every shape below must answer rather than throw.
test('parseCookies skips malformed pairs instead of throwing', () => {
  assert.deepEqual(parseCookies('novalue; =orphan; pa_session=abc'), { pa_session: 'abc' });
  assert.deepEqual(parseCookies(';;;'), {});
});

test('parseCookies keeps the first occurrence of a repeated name', () => {
  assert.deepEqual(parseCookies('pa_session=first; pa_session=second'), { pa_session: 'first' });
});

test('parseCookies decodes a percent-encoded value and keeps an undecodable one raw', () => {
  assert.equal(parseCookies('pa_session=a%2Bb')['pa_session'], 'a+b');
  assert.equal(parseCookies('pa_session=100%')['pa_session'], '100%');
});

test('readCookie answers null for a missing or empty value', () => {
  assert.equal(readCookie('pa_session=abc', 'pa_session'), 'abc');
  assert.equal(readCookie('other=abc', 'pa_session'), null);
  assert.equal(readCookie('pa_session=', 'pa_session'), null);
  assert.equal(readCookie(undefined, 'pa_session'), null);
});

// Not `Secure`: the stand is plain HTTP and the browser would drop the cookie.
test('serializeCookie builds the session cookie with its lifetime', () => {
  assert.equal(
    serializeCookie('pa_session', 'token-value', { maxAge: 43200 }),
    'pa_session=token-value; Path=/; Max-Age=43200; SameSite=Lax; HttpOnly'
  );
});

test('serializeCookie builds the clearing cookie', () => {
  assert.equal(
    serializeCookie('pa_session', '', { maxAge: 0 }),
    'pa_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly'
  );
});

test('serializeCookie encodes a value that would break the header', () => {
  assert.match(serializeCookie('pa_session', 'a;b c', { maxAge: 1 }), /^pa_session=a%3Bb%20c; /);
});
