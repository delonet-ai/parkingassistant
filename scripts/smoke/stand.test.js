'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { buildChecks, evaluate, DEFAULT_HOST, DEFAULT_API_PORT, DEFAULT_ADMIN_PORT } = require('./stand');

test('buildChecks defaults to the documented stand coordinates', () => {
  const urls = buildChecks().map((check) => check.url);

  assert.deepEqual(urls, [
    `http://${DEFAULT_HOST}:${DEFAULT_API_PORT}/health`,
    `http://${DEFAULT_HOST}:${DEFAULT_API_PORT}/health/db`,
    `http://${DEFAULT_HOST}:${DEFAULT_ADMIN_PORT}/health`,
    `http://${DEFAULT_HOST}:${DEFAULT_ADMIN_PORT}/`,
    `http://${DEFAULT_HOST}:${DEFAULT_ADMIN_PORT}/api/health`
  ]);
});

test('buildChecks honours host and port overrides', () => {
  const checks = buildChecks({ host: 'stand.local', apiPort: 3000, adminPort: 3100 });

  assert.ok(checks.every((check) => check.url.startsWith('http://stand.local:')));
  assert.equal(checks[0].url, 'http://stand.local:3000/health');
  assert.equal(checks[4].url, 'http://stand.local:3100/api/health');
});

test('evaluate passes a healthy api response', () => {
  const [apiHealth] = buildChecks();
  const result = evaluate(apiHealth, { status: 200, body: JSON.stringify({ status: 'ok', service: 'api' }) });

  assert.equal(result.ok, true);
});

test('evaluate fails on the wrong status code', () => {
  const [apiHealth] = buildChecks();
  const result = evaluate(apiHealth, { status: 502, body: 'bad gateway' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /expected 200, got 502/);
});

test('evaluate fails when the api answers for another service', () => {
  const [apiHealth] = buildChecks();
  const result = evaluate(apiHealth, { status: 200, body: JSON.stringify({ status: 'ok', service: 'admin-web' }) });

  assert.equal(result.ok, false);
  assert.match(result.reason, /unexpected payload/);
});

test('evaluate fails when the database health check reports an error', () => {
  const dbHealth = buildChecks()[1];
  const result = evaluate(dbHealth, { status: 200, body: JSON.stringify({ status: 'error', code: 'internal_error' }) });

  assert.equal(result.ok, false);
});

test('evaluate fails when the admin shell is served without a built bundle', () => {
  // The SPA renders client-side, so a shell that loads no bundle is the only thing a
  // read-only check can tell apart from a working screen.
  const shell = buildChecks()[3];

  assert.equal(evaluate(shell, { status: 200, body: '<html><body>502 Bad Gateway</body></html>' }).ok, false);
  assert.equal(
    evaluate(shell, { status: 200, body: '<div id="app"></div><script src="/assets/index-abc123.js"></script>' }).ok,
    true
  );
});
