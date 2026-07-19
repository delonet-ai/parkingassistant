-- Durable state for the scheduled jobs (Task 7).
--
-- Two jobs previously did nothing but write an audit row, which made them
-- impossible to make idempotent and impossible to enforce:
--
--   * freeze-next-day now writes place_releases.frozen_at (the column already
--     existed and was never written). status stays 'active' on purpose: a
--     frozen release is still a released place that the next morning's queue
--     run must be able to hand out. "Frozen" means "can no longer be
--     withdrawn", not "no longer released".
--   * lock-departure-plans now writes departure_plans.locked_at, added here.
--     The 07:00 rule was a wall-clock check in the upsert handler only, so it
--     evaporated on the next day rollover and could not be replayed.

BEGIN;

ALTER TABLE departure_plans
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

CREATE INDEX IF NOT EXISTS departure_plans_plan_date_idx
  ON departure_plans (plan_date);

CREATE INDEX IF NOT EXISTS place_releases_frozen_at_idx
  ON place_releases (frozen_at)
  WHERE frozen_at IS NULL;

COMMIT;
