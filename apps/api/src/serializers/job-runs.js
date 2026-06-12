'use strict';

function mapJobRun(run) {
  if (!run) {
    return null;
  }

  return {
    id: run.id,
    jobName: run.job_name,
    targetDate: run.target_date,
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    actorService: run.actor_service,
    summary: run.summary,
    error: run.error
  };
}

module.exports = {
  mapJobRun
};
