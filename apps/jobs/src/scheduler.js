'use strict';

const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000';
const appTimezone = process.env.APP_TIMEZONE || 'Europe/Moscow';
const schedulerEnabled = process.env.JOBS_SCHEDULER_ENABLED !== 'false';
const tickIntervalMs = Number(process.env.JOBS_TICK_INTERVAL_MS || 60_000);

// Declaration order is execution order within a tick: jobs due at the same
// minute run sequentially, top to bottom. freeze_next_day must settle the
// released pool before unlock_employee_pool measures it, and both share 19:00.
const jobs = [
  {
    name: 'lock_departure_plans',
    endpoint: '/admin/jobs/lock-departure-plans',
    runAt: process.env.JOB_LOCK_DEPARTURE_PLANS_TIME || '07:00',
    targetDate: (clock) => clock.date
  },
  {
    name: 'process_queue',
    endpoint: '/admin/jobs/process-queue',
    runAt: process.env.JOB_PROCESS_QUEUE_TIME || '08:00',
    targetDate: (clock) => clock.date
  },
  {
    name: 'rebuild_conflicts',
    endpoint: '/admin/jobs/rebuild-conflicts',
    runAt: process.env.JOB_REBUILD_CONFLICTS_TIME || '08:05',
    targetDate: (clock) => clock.date
  },
  {
    name: 'freeze_next_day',
    endpoint: '/admin/jobs/freeze-next-day',
    runAt: process.env.JOB_FREEZE_NEXT_DAY_TIME || '19:00',
    targetDate: (clock) => addDaysToIsoDate(clock.date, 1)
  },
  {
    name: 'unlock_employee_pool',
    endpoint: '/admin/jobs/unlock-employee-pool',
    runAt: process.env.JOB_UNLOCK_EMPLOYEE_POOL_TIME || '19:00',
    targetDate: (clock) => addDaysToIsoDate(clock.date, 1)
  }
];

const completedRuns = new Set();
let tickInProgress = false;

function log(message, payload = {}) {
  console.log(
    JSON.stringify({
      service: 'jobs',
      timestamp: new Date().toISOString(),
      message,
      ...payload
    })
  );
}

function currentClock(timeZone = appTimezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
    timezone: timeZone
  };
}

function addDaysToIsoDate(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + days));
  return nextDate.toISOString().slice(0, 10);
}

function isDue(job, clock) {
  return clock.time === job.runAt;
}

async function postJson(pathname, payload) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data?.error || `API error ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function runKeyFor(job, clock) {
  return `${job.name}:${clock.date}`;
}

/**
 * Forget run keys from previous days. The set only exists to stop a job firing
 * twice within the same minute-resolution window, so anything not stamped with
 * today's date is dead weight in a long-lived container.
 */
function pruneCompletedRuns(clock) {
  for (const key of completedRuns) {
    if (!key.endsWith(`:${clock.date}`)) {
      completedRuns.delete(key);
    }
  }
}

async function runJob(job, clock) {
  const targetDate = job.targetDate(clock);
  const runKey = runKeyFor(job, clock);

  if (completedRuns.has(runKey) || !isDue(job, clock)) {
    return;
  }

  completedRuns.add(runKey);
  log('job_started', {
    jobName: job.name,
    runAt: job.runAt,
    schedulerDate: clock.date,
    schedulerTime: clock.time,
    targetDate
  });

  try {
    const result = await postJson(job.endpoint, { date: targetDate });
    log('job_finished', {
      jobName: job.name,
      targetDate,
      status: result.status,
      jobRunId: result.jobRun?.id || null,
      summary: {
        assignedCount: result.assignedCount,
        skippedCount: result.skippedCount,
        releaseCount: result.releaseCount,
        plansCount: result.plansCount,
        earlyPlansCount: result.earlyPlansCount
      }
    });
  } catch (error) {
    log('job_failed', {
      jobName: job.name,
      targetDate,
      status: error.status || null,
      error: error.message,
      data: error.data || null
    });
  }
}

async function tick() {
  if (tickInProgress) {
    return;
  }

  tickInProgress = true;
  const clock = currentClock();

  try {
    pruneCompletedRuns(clock);

    // Sequential, not Promise.all: same-minute jobs have a required order.
    for (const job of jobs) {
      await runJob(job, clock);
    }
  } finally {
    tickInProgress = false;
  }
}

function start() {
  if (!schedulerEnabled) {
    log('scheduler_disabled', { appTimezone });
    return;
  }

  log('scheduler_started', {
    apiBaseUrl,
    appTimezone,
    tickIntervalMs,
    jobs: jobs.map((job) => ({ name: job.name, runAt: job.runAt }))
  });
  tick().catch((error) => log('scheduler_tick_failed', { error: error.message }));
  setInterval(() => {
    tick().catch((error) => log('scheduler_tick_failed', { error: error.message }));
  }, tickIntervalMs);
}

// Only self-start when run as the container entrypoint, so the schedule itself
// can be unit-tested without spawning timers or hitting the API.
if (require.main === module) {
  start();
}

module.exports = {
  addDaysToIsoDate,
  currentClock,
  isDue,
  jobs,
  start
};
