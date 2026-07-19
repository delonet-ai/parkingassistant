'use strict';

// Departure plans context — when an employee intends to leave, and whether that counts
// as an early departure. `locked_at` is the persisted form of the 07:00 cut-off: a
// wall-clock check alone evaporates at the next day rollover.

async function listPlansForDate(db, date) {
  return db.queryMany(
    `
      select
        dp.id,
        dp.plan_date::text as plan_date,
        dp.departure_time::text as departure_time,
        dp.is_early,
        dp.created_at,
        dp.updated_at,
        u.id as user_id,
        u.display_name,
        u.department,
        lo.position,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title
      from departure_plans dp
      join users u on u.id = dp.user_id
      left join line_occupancy lo
        on lo.user_id = dp.user_id
        and lo.subject_type = 'employee'
        and lo.occupancy_date = dp.plan_date
      left join line_groups lg on lg.id = lo.line_group_id
      left join parking_places pp on pp.id = lo.parking_place_id
      where dp.plan_date = $1::date
      order by dp.is_early desc, dp.departure_time, u.display_name
    `,
    [date]
  );
}

async function findLockedPlan(db, { userId, planDate }) {
  return db.queryOne(
    `
      select locked_at
      from departure_plans
      where user_id = $1
        and plan_date = $2::date
        and locked_at is not null
    `,
    [userId, planDate]
  );
}

async function upsertPlan(db, { userId, planDate, departureTime, isEarly }) {
  return db.queryOne(
    `
      insert into departure_plans (
        user_id,
        plan_date,
        departure_time,
        is_early,
        created_by_user_id
      )
      values ($1, $2::date, $3::time, $4, $1)
      on conflict (user_id, plan_date) do update
        set departure_time = excluded.departure_time,
            is_early = excluded.is_early,
            updated_at = now()
      returning id, user_id, plan_date::text as plan_date, departure_time::text as departure_time, is_early, created_at, updated_at
    `,
    [userId, planDate, departureTime, isEarly]
  );
}

// `locked_at is null` is the idempotency guard: the second run of the day locks nothing.
async function lockPlansForDate(db, targetDate) {
  return db.queryMany(
    `
      update departure_plans
      set
        locked_at = now(),
        updated_at = now()
      where plan_date = $1::date
        and locked_at is null
      returning id
    `,
    [targetDate]
  );
}

async function summarizePlansForDate(db, targetDate) {
  return db.queryOne(
    `
      select
        count(*)::int as plans_count,
        count(*) filter (where is_early = true)::int as early_plans_count
      from departure_plans
      where plan_date = $1::date
    `,
    [targetDate]
  );
}

async function listPlanEarlyFlagsForDate(db, targetDate) {
  return db.queryMany(
    `
      select id, departure_time::text as departure_time, is_early
      from departure_plans
      where plan_date = $1::date
    `,
    [targetDate]
  );
}

async function updatePlanEarlyFlag(db, { planId, isEarly }) {
  return db.queryOne(
    `
      update departure_plans
      set
        is_early = $1,
        updated_at = now()
      where id = $2
      returning id
    `,
    [isEarly, planId]
  );
}


async function listPlansForUser(db, userId) {
  return db.queryMany(
    `
      select id, plan_date::text as plan_date, departure_time::text as departure_time, is_early, created_at, updated_at
      from departure_plans
      where user_id = $1
      order by plan_date desc
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  findLockedPlan,
  listPlansForUser,
  listPlanEarlyFlagsForDate,
  listPlansForDate,
  lockPlansForDate,
  summarizePlansForDate,
  updatePlanEarlyFlag,
  upsertPlan
};
