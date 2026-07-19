'use strict';

// Jobs context — `job_runs` bookkeeping for the five scheduled runs.
// The state transitions the jobs themselves perform live in the context that owns the
// affected table (freeze → place-releases, lock → departure-plans, and so on); this
// repository only records that a run happened and how it ended.

async function startJobRun(db, { jobName, targetDate }) {
  return db.queryOne(
    `
      insert into job_runs (
        job_name,
        target_date,
        status,
        actor_service
      )
      values ($1, $2::date, 'running', 'admin-web')
      returning id, job_name, target_date, status, started_at
    `,
    [jobName, targetDate]
  );
}

async function markJobRunSucceeded(db, { jobRunId, summary }) {
  return db.queryOne(
    `
      update job_runs
      set
        status = 'success',
        finished_at = now(),
        summary = $1::jsonb
      where id = $2
      returning id, job_name, target_date, status, started_at, finished_at, actor_service, summary, error
    `,
    [JSON.stringify(summary), jobRunId]
  );
}

async function markJobRunFailed(db, { jobRunId, error }) {
  return db.queryOne(
    `
      update job_runs
      set
        status = 'failed',
        finished_at = now(),
        error = $1
      where id = $2
      returning id, job_name, target_date, status, started_at, finished_at, actor_service, summary, error
    `,
    [error, jobRunId]
  );
}


const JOB_RUN_COLUMNS = `
        id,
        job_name,
        target_date,
        status,
        started_at,
        finished_at,
        actor_service,
        summary,
        error
`;

async function listJobRuns(db, { jobName, targetDate, limit }) {
  return db.queryMany(
    `
      select ${JOB_RUN_COLUMNS}
      from job_runs
      where ($1::text is null or job_name = $1)
        and ($2::date is null or target_date = $2::date)
      order by started_at desc
      limit $3
    `,
    [jobName, targetDate, limit]
  );
}

async function listLatestSuccessfulRuns(db, jobName) {
  return db.queryMany(
    `
      select distinct on (job_name) ${JOB_RUN_COLUMNS}
      from job_runs
      where status = 'success'
        and ($1::text is null or job_name = $1)
      order by job_name, finished_at desc nulls last, started_at desc
    `,
    [jobName]
  );
}

module.exports = {
  listJobRuns,
  listLatestSuccessfulRuns,
  markJobRunFailed,
  markJobRunSucceeded,
  startJobRun
};
