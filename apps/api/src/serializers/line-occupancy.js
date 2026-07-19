'use strict';

const { formatDateForSql } = require('../../../../packages/shared/dates');

// Row → JSON for line_occupancy joined with its line, place, subject and reservation.

function mapLineOccupancy(row) {
  return {
    id: row.occupancy_id,
    occupancyDate: formatDateForSql(row.occupancy_date),
    position: row.position,
    subjectType: row.subject_type,
    createdAt: row.occupancy_created_at,
    updatedAt: row.occupancy_updated_at,
    lineGroup: {
      id: row.line_group_id,
      code: row.line_group_code,
      name: row.line_group_name,
      capacity: row.line_group_capacity
    },
    parkingPlace: {
      id: row.parking_place_id,
      code: row.parking_place_code,
      title: row.parking_place_title,
      placeType: row.parking_place_type
    },
    user: row.user_id
      ? {
          id: row.user_id,
          displayName: row.user_display_name,
          department: row.user_department,
          email: row.user_email,
          phone: row.user_phone
        }
      : null,
    guestParkingRequest: row.guest_parking_request_id
      ? {
          id: row.guest_parking_request_id,
          guestName: row.guest_name,
          guestPhone: row.guest_phone,
          hostUserId: row.host_user_id,
          hostDisplayName: row.host_display_name
        }
      : null,
    reservation: row.reservation_id
      ? {
          id: row.reservation_id,
          source: row.reservation_source
        }
      : null
  };
}

module.exports = {
  mapLineOccupancy
};
