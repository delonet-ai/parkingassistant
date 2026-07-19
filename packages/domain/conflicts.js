'use strict';

// Early-departure conflicts: someone parked behind an employee who leaves early will
// have to move. A guest blocker is a warning because the employee cannot simply ask
// them to move; another employee is only informational.

const { normalizeDepartureTime } = require('./scheduling');

function classifyConflict(blockerSubjectType) {
  return blockerSubjectType === 'guest'
    ? { type: 'guest_blocks_early_departure', severity: 'warning' }
    : { type: 'employee_blocks_early_departure', severity: 'info' };
}

/**
 * Warnings raised when a place is about to be assigned: everyone ahead of that slot
 * in the same line who plans to leave early would be blocked by the new occupant.
 * The caller has already narrowed `risks` to the plans that qualify.
 */
function earlyDepartureBlockingWarnings({ placeCode, risks }) {
  return (risks || []).map((risk) => {
    const departureTime = normalizeDepartureTime(risk.departure_time);

    return {
      type: 'early_departure_blocking_risk',
      message: `Назначение на место ${placeCode} может перекрыть ранний выезд ${risk.display_name} в ${departureTime}.`,
      lineGroupCode: risk.line_group_code,
      assignedParkingPlaceCode: placeCode,
      affectedUser: {
        id: risk.user_id,
        displayName: risk.display_name
      },
      affectedParkingPlaceCode: risk.parking_place_code,
      affectedPosition: risk.position,
      departureTime
    };
  });
}

module.exports = {
  classifyConflict,
  earlyDepartureBlockingWarnings
};
