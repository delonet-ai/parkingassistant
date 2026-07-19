'use strict';

const { formatDateForSql } = require('../../../../packages/shared/dates');

// Row → JSON for contact_access_logs. Shared by the audit tab and the employee journal.

function mapContactAccessLog(row) {
  return {
    id: row.id,
    occupancyDate: formatDateForSql(row.occupancy_date),
    resolution: row.resolution,
    createdAt: row.created_at,
    metadata: row.metadata || {},
    requester: {
      id: row.requester_user_id,
      displayName: row.requester_display_name,
      department: row.requester_department,
      email: row.requester_email,
      phone: row.requester_phone
    },
    lineGroup: row.line_group_id
      ? {
          id: row.line_group_id,
          code: row.line_group_code,
          name: row.line_group_name
        }
      : null,
    targetUser: row.target_user_id
      ? {
          id: row.target_user_id,
          displayName: row.target_user_display_name,
          department: row.target_user_department,
          email: row.target_user_email,
          phone: row.target_user_phone
        }
      : null,
    targetGuestParkingRequest: row.target_guest_parking_request_id
      ? {
          id: row.target_guest_parking_request_id,
          guestName: row.target_guest_name,
          hostDisplayName: row.target_guest_host_display_name
        }
      : null
  };
}

module.exports = {
  mapContactAccessLog
};
