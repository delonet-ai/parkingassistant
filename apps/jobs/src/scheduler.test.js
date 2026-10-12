'use strict';

// The schedule itself is worth pinning: the container's whole contribution is
// calling the right endpoint, for the right date, at the right minute. These
// assertions fail loudly if a job is dropped from the table or if the 19:00
// pair loses its required order.

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { addDaysToIsoDate, currentClock, isDue, jobs, requestHeaders } = require('./scheduler');

describe('jobs scheduler', () => {
  it('schedules every job the plan requires', () => {
    assert.deepEqual(
      jobs.map((job) => job.name).sort(),
      ['freeze_next_day', 'lock_departure_plans', 'process_queue', 'rebuild_conflicts', 'unlock_employee_pool']
    );
  });

  it('points each job at its own endpoint', () => {
    const endpoints = jobs.map((job) => job.endpoint);
    assert.equal(new Set(endpoints).size, endpoints.length, 'endpoints must be distinct');
    assert.ok(endpoints.every((endpoint) => endpoint.startsWith('/admin/jobs/')));
  });

  it('runs the cut-off jobs at their documented times', () => {
    const runAt = Object.fromEntries(jobs.map((job) => [job.name, job.runAt]));

    assert.equal(runAt.lock_departure_plans, '07:00');
    assert.equal(runAt.process_queue, '08:00');
    assert.equal(runAt.freeze_next_day, '19:00');
    assert.equal(runAt.unlock_employee_pool, '19:00');
  });

  it('freezes the pool before measuring it when both are due at 19:00', () => {
    const names = jobs.map((job) => job.name);

    assert.ok(
      names.indexOf('freeze_next_day') < names.indexOf('unlock_employee_pool'),
      'unlock_employee_pool reads the pool freeze_next_day settles, so it must run second'
    );
  });

  it('targets tomorrow for the evening jobs and today for the morning ones', () => {
    const clock = { date: '2026-03-14', time: '19:00' };
    const byName = Object.fromEntries(jobs.map((job) => [job.name, job]));

    assert.equal(byName.freeze_next_day.targetDate(clock), '2026-03-15');
    assert.equal(byName.unlock_employee_pool.targetDate(clock), '2026-03-15');
    assert.equal(byName.process_queue.targetDate(clock), '2026-03-14');
    assert.equal(byName.lock_departure_plans.targetDate(clock), '2026-03-14');
    assert.equal(byName.rebuild_conflicts.targetDate(clock), '2026-03-14');
  });

  it('is due only on an exact minute match', () => {
    const job = { runAt: '19:00' };

    assert.equal(isDue(job, { time: '19:00' }), true);
    assert.equal(isDue(job, { time: '18:59' }), false);
    assert.equal(isDue(job, { time: '19:01' }), false);
  });

  it('rolls the target date over month and year boundaries', () => {
    assert.equal(addDaysToIsoDate('2026-01-31', 1), '2026-02-01');
    assert.equal(addDaysToIsoDate('2026-12-31', 1), '2027-01-01');
    assert.equal(addDaysToIsoDate('2028-02-28', 1), '2028-02-29');
  });

  // Since Task 3 the job routes need a caller the API recognizes, and the scheduler has no
  // operator to sign in as: it presents `JOBS_SERVICE_TOKEN` in `X-Service-Token`. Without the
  // header every run answered 401, which is how the stand spent weeks with no 07:00 job.
  it('sends the service token when it has one', () => {
    assert.deepEqual(requestHeaders('secret-token'), {
      'content-type': 'application/json',
      'x-service-token': 'secret-token'
    });
  });

  it('sends no token header at all when the variable is unset', () => {
    // An empty header is a second thing for the API to refuse, and it would read in the log
    // as "the token was wrong" rather than "there was no token".
    // Passed explicitly rather than relying on the default: the default reads the process
    // environment, and a test that asserted it would pass or fail with the shell it ran in.
    assert.deepEqual(requestHeaders(''), { 'content-type': 'application/json' });
  });

  it('reads the clock as a zero-padded date and 24-hour time', () => {
    const clock = currentClock('Europe/Moscow');

    assert.match(clock.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(clock.time, /^([01]\d|2[0-3]):[0-5]\d$/);
    assert.equal(clock.timezone, 'Europe/Moscow');
  });
});
