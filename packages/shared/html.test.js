'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { escapeHtml } = require('./html');

test('escapeHtml escapes all five HTML-sensitive characters', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml neutralizes a script-injection attempt', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
});

test('escapeHtml escapes ampersand first so entities are not double-broken', () => {
  assert.equal(escapeHtml('a&<b'), 'a&amp;&lt;b');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
});

test('escapeHtml leaves ordinary text untouched', () => {
  assert.equal(escapeHtml('Место 12'), 'Место 12');
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml coerces non-string input via String()', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
  assert.equal(escapeHtml(true), 'true');
});
