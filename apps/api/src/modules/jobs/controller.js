'use strict';

const { addDaysToIsoDate, currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { mapJobRun } = require('../../serializers/job-runs');
const { requestActor } = require('../../support/actor');

function createJobsController({ appTimezone, services }) {
  const service = services.jobs;

  // Every job endpoint answers a failure the same way: the finished `job_runs` row the
  // service attached to the error, under an explicit status. Only process-queue lets the
  // error pick the status (409 on a colliding reservation); the other four always send 500.
  function jobFailure(error, statusCode) {
    return {
      statusCode,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message,
        jobRun: error.jobRun || null
      }
    };
  }

  function jobSuccess(result) {
    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        ...result
      }
    };
  }

  async function handleAdminJobProcessQueue(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    // The other four job endpoints default the date; this one demanded it, so the same
    // "run today's job" call worked against four of the five.
    const queueDate = body.date || currentDateInTimezone(appTimezone);

    if (!isIsoDate(queueDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date is required and must use YYYY-MM-DD format'
        }
      };
    }

    try {
      return jobSuccess(await service.runProcessQueue({ actor, queueDate }));
    } catch (error) {
      return jobFailure(error, error.statusCode || 500);
    }
  }

  async function handleAdminJobFreezeNextDay(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const targetDate = body.date || addDaysToIsoDate(currentDateInTimezone(appTimezone), 1);

    if (!isIsoDate(targetDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    try {
      return jobSuccess(await service.runFreezeNextDay({ actor, targetDate }));
    } catch (error) {
      return jobFailure(error, 500);
    }
  }

  async function handleAdminJobLockDeparturePlans(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const targetDate = body.date || currentDateInTimezone(appTimezone);

    if (!isIsoDate(targetDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    try {
      return jobSuccess(await service.runLockDeparturePlans({ actor, targetDate }));
    } catch (error) {
      return jobFailure(error, 500);
    }
  }

  async function handleAdminJobUnlockEmployeePool(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const targetDate = body.date || addDaysToIsoDate(currentDateInTimezone(appTimezone), 1);

    if (!isIsoDate(targetDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    try {
      return jobSuccess(await service.runUnlockEmployeePool({ actor, targetDate }));
    } catch (error) {
      return jobFailure(error, 500);
    }
  }

  async function handleAdminJobRebuildConflicts(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const targetDate = body.date || currentDateInTimezone(appTimezone);

    if (!isIsoDate(targetDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    try {
      return jobSuccess(await service.runRebuildConflicts({ actor, targetDate }));
    } catch (error) {
      return jobFailure(error, 500);
    }
  }

  async function handleAdminJobRunsList(searchParams) {
    // Kept as the monolith wrote it rather than routed through `parsePositiveLimit`:
    // this clamp has its own floor of 1 and passes a non-numeric `limit` through as NaN.
    const limit = Math.min(Math.max(Number(searchParams.get('limit') || 20), 1), 100);
    const jobName = searchParams.get('jobName');
    const targetDate = searchParams.get('date');

    if (targetDate && !isIsoDate(targetDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    const { runs, latestSuccessfulRuns } = await service.listJobRuns({
      jobName: jobName || null,
      targetDate: targetDate || null,
      limit
    });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        timezone: appTimezone,
        runs: runs.map(mapJobRun),
        latestSuccessfulRuns: latestSuccessfulRuns.map(mapJobRun)
      }
    };
  }

  // `service: true` on the five writes, and on nothing else: these are the routes the
  // scheduler in `apps/jobs` posts to with `X-Service-Token` and no cookie. `/admin/jobs/runs`
  // is a read for the operator's screen and stays session-only — a token must not be able to
  // ask what ran.
  return {
    name: 'jobs',
    routes: [
      {
        method: 'POST',
        path: '/admin/jobs/process-queue',
        advertise: true,
        service: true,
        handler: (context) => handleAdminJobProcessQueue(context.req, requestActor(context))
      },
      {
        method: 'POST',
        path: '/admin/jobs/freeze-next-day',
        advertise: true,
        service: true,
        handler: (context) => handleAdminJobFreezeNextDay(context.req, requestActor(context))
      },
      {
        method: 'POST',
        path: '/admin/jobs/lock-departure-plans',
        advertise: true,
        service: true,
        handler: (context) => handleAdminJobLockDeparturePlans(context.req, requestActor(context))
      },
      {
        method: 'POST',
        path: '/admin/jobs/unlock-employee-pool',
        advertise: true,
        service: true,
        handler: (context) => handleAdminJobUnlockEmployeePool(context.req, requestActor(context))
      },
      {
        method: 'POST',
        path: '/admin/jobs/rebuild-conflicts',
        advertise: true,
        service: true,
        handler: (context) => handleAdminJobRebuildConflicts(context.req, requestActor(context))
      },
      {
        method: 'GET',
        path: '/admin/jobs/runs',
        advertise: true,
        handler: ({ searchParams }) => handleAdminJobRunsList(searchParams)
      }
    ]
  };
}

module.exports = {
  createJobsController
};
