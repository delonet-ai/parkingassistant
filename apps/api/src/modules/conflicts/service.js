'use strict';

const { classifyConflict } = require('../../../../../packages/domain');
const repository = require('./repository');

function createConflictsService({ dbRepository }) {
  // Also read by the jobs context as `services.conflicts.getConflictsForDate(date)`,
  // so the row-to-payload shape lives here rather than in the controller.
  async function getConflictsForDate(date) {
    const rows = await repository.listConflictsForDate(dbRepository, date);

    return rows.map((row) => ({
      ...classifyConflict(row.blocker_subject_type),
      lineGroup: {
        id: row.line_group_id,
        code: row.line_group_code,
        name: row.line_group_name
      },
      earlyDeparture: {
        departurePlanId: row.departure_plan_id,
        departureTime: row.departure_time.slice(0, 5),
        position: row.early_position,
        parkingPlaceCode: row.early_place_code,
        user: {
          id: row.early_user_id,
          displayName: row.early_user_display_name
        }
      },
      blocker: {
        position: row.blocker_position,
        subjectType: row.blocker_subject_type,
        parkingPlaceCode: row.blocker_place_code,
        user: row.blocker_user_id
          ? {
              id: row.blocker_user_id,
              displayName: row.blocker_user_display_name
            }
          : null,
        guestParkingRequest: row.blocker_guest_request_id
          ? {
              id: row.blocker_guest_request_id,
              guestName: row.blocker_guest_name
            }
          : null
      }
    }));
  }

  return {
    getConflictsForDate
  };
}

module.exports = {
  createConflictsService
};
