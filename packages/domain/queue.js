'use strict';

// Queue allocation: who gets which released place, in what order, and why someone
// was passed over. Pure — it decides, the service writes.

const { employeePoolSize } = require('./guest-reserve');

/**
 * Decide the outcome for every waiting queue entry.
 *
 * `entries` arrive in queue order and `places` in the pick order the repository
 * established (`double → triple → single`, then `guest_priority_rank NULLS LAST`).
 * Both orders are contract: the caller must not re-sort either.
 *
 * Three outcomes:
 *  - `close`  — the user already holds a reservation for the date (served manually,
 *               or by an earlier partial run). They are done, not a candidate;
 *               assigning a second place would trip `reservations_active_user_date_uniq`
 *               and, since the run is one transaction, fail the whole batch.
 *  - `assign` — paired with a place.
 *  - `skip`   — the reserve floor is reached, or no place is left.
 *
 * `placeIndex` is deliberately monotonic across entries: a place skipped because it
 * belongs to the candidate themselves stays skipped for that candidate only, and the
 * cursor never rewinds — nobody is ever handed back the place they released.
 */
function planQueueAssignments({ entries, places, guestReserveMinimum }) {
  const queueEntries = entries || [];
  const availablePlaces = places || [];
  const maxEmployeeAssignments = employeePoolSize(availablePlaces.length, guestReserveMinimum);
  const decisions = [];

  let placeIndex = 0;
  let assignedCount = 0;

  for (const entry of queueEntries) {
    if (entry.existing_reservation_id) {
      decisions.push({
        entry,
        outcome: 'close',
        reason: 'already_has_reservation',
        reservationId: entry.existing_reservation_id
      });
      continue;
    }

    if (assignedCount >= maxEmployeeAssignments) {
      decisions.push({ entry, outcome: 'skip', reason: 'guest_reserve_minimum_reached' });
      continue;
    }

    while (placeIndex < availablePlaces.length && availablePlaces[placeIndex].owner_user_id === entry.user_id) {
      placeIndex += 1;
    }

    const place = availablePlaces[placeIndex];

    if (!place) {
      decisions.push({ entry, outcome: 'skip', reason: 'no_available_released_place' });
      continue;
    }

    decisions.push({ entry, outcome: 'assign', place });
    assignedCount += 1;
    placeIndex += 1;
  }

  return { maxEmployeeAssignments, decisions };
}

module.exports = {
  planQueueAssignments
};
