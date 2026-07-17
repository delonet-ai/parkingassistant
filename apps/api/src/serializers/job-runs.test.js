'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapJobRun } = require('./job-runs');

test('mapJobRun maps snake_case db columns to camelCase api fields', () => {
  const row = {
    id: 7,
    job_name: 'freeze-next-day',
    target_date: '2026-07-18',
    status: 'success',
    started_at: '2026-07-17T19:00:00Z',
    finished_at: '2026-07-17T19:00:05Z',
    actor_service: 'admin-web',
    summary: { frozen: 12 },
    error: null
  };

  assert.deepEqual(mapJobRun(row), {
    id: 7,
    jobName: 'freeze-next-day',
    targetDate: '2026-07-18',
    status: 'success',
    startedAt: '2026-07-17T19:00:00Z',
    finishedAt: '2026-07-17T19:00:05Z',
    actorService: 'admin-web',
    summary: { frozen: 12 },
    error: null
  });
});

test('mapJobRun returns null for a null/undefined run (boundary)', () => {
  assert.equal(mapJobRun(null), null);
  assert.equal(mapJobRun(undefined), null);
});

test('mapJobRun carries through undefined columns as undefined (invalid/partial input)', () => {
  const result = mapJobRun({ id: 1 });
  assert.equal(result.id, 1);
  assert.equal(result.jobName, undefined);
  assert.equal(result.status, undefined);
  assert.equal(result.error, undefined);
});
