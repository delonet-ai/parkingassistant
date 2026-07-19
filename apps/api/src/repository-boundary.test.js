'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Task 15's contract: after the extraction there is no raw SQL anywhere in the API except
// inside a `modules/<context>/repository.js`. Asserting it here rather than trusting the
// convention is the point — the monolith drifted back into inline `client.query` twice
// before, and a grep in a code review does not run on every commit.

const apiRoot = path.join(__dirname);

function collectJsFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js')) {
      files.push(full);
    }
  }

  return files;
}

// A statement-shaped keyword at the start of a line inside a template literal. Matching
// line starts rather than the bare word keeps `updated_at`, `selected` and prose in
// comments out of it.
const SQL_STATEMENT = /^\s*(select\s|insert\s+into\s|update\s+\w|delete\s+from\s)/im;

// The two ways to reach Postgres. Neither may appear outside a repository: `pool.connect`
// would re-open the hand-rolled transaction blocks `withTransaction` replaced.
const RAW_DRIVER_CALL = /\b(client|pool)\.query\s*\(|\bpool\.connect\s*\(/;

const files = collectJsFiles(apiRoot).filter((file) => !file.endsWith('.test.js'));

test('every API source file that contains SQL is a repository', () => {
  const offenders = files
    .filter((file) => path.basename(file) !== 'repository.js')
    .filter((file) => SQL_STATEMENT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(apiRoot, file));

  assert.deepEqual(offenders, [], `SQL outside a repository.js: ${offenders.join(', ')}`);
});

test('no API source file outside repositories/db.js talks to the pg driver directly', () => {
  const offenders = files
    .filter((file) => path.relative(apiRoot, file) !== path.join('repositories', 'db.js'))
    .filter((file) => RAW_DRIVER_CALL.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(apiRoot, file));

  assert.deepEqual(offenders, [], `raw driver access outside repositories/db.js: ${offenders.join(', ')}`);
});

test('the extraction actually produced repositories', () => {
  const repositories = files.filter((file) => path.basename(file) === 'repository.js');

  // Guards the two tests above against passing vacuously if the modules tree disappears.
  assert.ok(repositories.length >= 15, `expected the module repositories to exist, found ${repositories.length}`);
});
