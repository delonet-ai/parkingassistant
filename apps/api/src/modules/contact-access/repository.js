'use strict';

// Contact access context — the audit trail of "who was shown whose contact details".
// Every lookup of a blocking neighbour is logged, including the case where there was no
// blocker at all: that a driver asked is itself the fact worth recording.

async function insertNoBlockersLog(db, { requesterUserId, occupancyDate, lineGroupId, metadata }) {
  return db.queryMany(
    `
      insert into contact_access_logs (
        requester_user_id,
        occupancy_date,
        line_group_id,
        resolution,
        metadata
      )
      values ($1, $2::date, $3, 'no_blockers', $4::jsonb)
    `,
    [requesterUserId, occupancyDate, lineGroupId, JSON.stringify(metadata)]
  );
}

async function insertContactAccessLog(
  db,
  { requesterUserId, occupancyDate, lineGroupId, targetUserId, targetGuestParkingRequestId, resolution, metadata }
) {
  return db.queryMany(
    `
      insert into contact_access_logs (
        requester_user_id,
        occupancy_date,
        line_group_id,
        target_user_id,
        target_guest_parking_request_id,
        resolution,
        metadata
      )
      values ($1, $2::date, $3, $4, $5, $6, $7::jsonb)
    `,
    [
      requesterUserId,
      occupancyDate,
      lineGroupId,
      targetUserId,
      targetGuestParkingRequestId,
      resolution,
      JSON.stringify(metadata)
    ]
  );
}


const CONTACT_LOG_SELECT = `
      select
        cal.id,
        cal.occupancy_date,
        cal.requester_user_id,
        requester.display_name as requester_display_name,
        requester.department as requester_department,
        requester.email as requester_email,
        requester.phone as requester_phone,
        cal.line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        cal.target_user_id,
        target_user.display_name as target_user_display_name,
        target_user.department as target_user_department,
        target_user.email as target_user_email,
        target_user.phone as target_user_phone,
        cal.target_guest_parking_request_id,
        gpr.guest_name as target_guest_name,
        host.display_name as target_guest_host_display_name,
        cal.resolution,
        cal.created_at,
        cal.metadata
      from contact_access_logs cal
      join users requester on requester.id = cal.requester_user_id
      left join line_groups lg on lg.id = cal.line_group_id
      left join users target_user on target_user.id = cal.target_user_id
      left join guest_parking_requests gpr on gpr.id = cal.target_guest_parking_request_id
      left join users host on host.id = gpr.host_user_id
`;

async function listContactAccessLogs(db, { date, limit }) {
  const params = [];
  const where = [];

  if (date) {
    params.push(date);
    where.push(`cal.occupancy_date = $${params.length}::date`);
  }

  params.push(limit);

  return db.queryMany(
    `
      ${CONTACT_LOG_SELECT}
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by cal.created_at desc, cal.id desc
      limit $${params.length}
    `,
    params
  );
}

// Both sides of the exchange: what this user asked for, and when someone was shown theirs.
async function listContactAccessLogsForUser(db, userId) {
  return db.queryMany(
    `
      ${CONTACT_LOG_SELECT}
      where cal.requester_user_id = $1
         or cal.target_user_id = $1
      order by cal.created_at desc, cal.id desc
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  insertContactAccessLog,
  insertNoBlockersLog,
  listContactAccessLogs,
  listContactAccessLogsForUser
};
