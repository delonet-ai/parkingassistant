BEGIN;

CREATE TABLE IF NOT EXISTS job_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  target_date date,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  actor_service text NOT NULL DEFAULT 'scheduler',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

CREATE INDEX IF NOT EXISTS job_runs_name_started_at_idx
  ON job_runs (job_name, started_at DESC);

CREATE INDEX IF NOT EXISTS job_runs_target_date_idx
  ON job_runs (target_date, started_at DESC);

COMMIT;
