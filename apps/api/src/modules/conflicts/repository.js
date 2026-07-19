'use strict';

// Conflicts context — the read model that pairs an early departure with everyone parked
// in front of it in the same line on the same date. It owns no table of its own; the
// conflict set is derived, which is why `rebuild_conflicts` repairs `is_early` rather
// than rewriting a stored list.

async function listConflictsForDate(db, date) {
  return db.queryMany(
    `
      select
        dp.id as departure_plan_id,
        dp.departure_time::text as departure_time,
        early_lo.position as early_position,
        early_user.id as early_user_id,
        early_user.display_name as early_user_display_name,
        early_place.code as early_place_code,
        blocker_lo.position as blocker_position,
        blocker_lo.subject_type as blocker_subject_type,
        blocker_user.id as blocker_user_id,
        blocker_user.display_name as blocker_user_display_name,
        gpr.id as blocker_guest_request_id,
        gpr.guest_name as blocker_guest_name,
        blocker_place.code as blocker_place_code,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name
      from departure_plans dp
      join line_occupancy early_lo
        on early_lo.user_id = dp.user_id
        and early_lo.subject_type = 'employee'
        and early_lo.occupancy_date = dp.plan_date
      join users early_user on early_user.id = dp.user_id
      join parking_places early_place on early_place.id = early_lo.parking_place_id
      join line_groups lg on lg.id = early_lo.line_group_id
      join line_occupancy blocker_lo
        on blocker_lo.occupancy_date = dp.plan_date
        and blocker_lo.line_group_id = early_lo.line_group_id
        and blocker_lo.position < early_lo.position
      join parking_places blocker_place on blocker_place.id = blocker_lo.parking_place_id
      left join users blocker_user on blocker_user.id = blocker_lo.user_id
      left join guest_parking_requests gpr on gpr.id = blocker_lo.guest_parking_request_id
      where dp.plan_date = $1::date
        and dp.is_early = true
      order by lg.code, early_lo.position, blocker_lo.position
    `,
    [date]
  );
}

// The blocking risk a specific assignment would create: everyone behind the assigned
// position in the same line who already plans an early departure that day.
async function listEarlyDepartureRisksBehind(db, { reservationDate, lineGroupId, linePositionHint }) {
  return db.queryMany(
    `
      select
        dp.id as departure_plan_id,
        dp.departure_time::text as departure_time,
        lo.position,
        u.id as user_id,
        u.display_name,
        pp.code as parking_place_code,
        lg.code as line_group_code
      from departure_plans dp
      join line_occupancy lo
        on lo.user_id = dp.user_id
        and lo.subject_type = 'employee'
        and lo.occupancy_date = dp.plan_date
      join users u on u.id = dp.user_id
      join parking_places pp on pp.id = lo.parking_place_id
      join line_groups lg on lg.id = lo.line_group_id
      where dp.plan_date = $1::date
        and dp.is_early = true
        and lo.line_group_id = $2
        and lo.position > $3
      order by lo.position
    `,
    [reservationDate, lineGroupId, linePositionHint]
  );
}

module.exports = {
  listConflictsForDate,
  listEarlyDepartureRisksBehind
};
