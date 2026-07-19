'use strict';

// The guest reserve: a fixed number of released places held back from employees so a
// guest arriving unannounced always has somewhere to park. Everything here is
// arithmetic over counts a repository produced — no I/O.

/**
 * How many released places employees may be given: everything available minus the
 * reserve, never negative.
 */
function employeePoolSize(availablePlaces, guestReserveMinimum) {
  return Math.max(0, (availablePlaces || 0) - (guestReserveMinimum || 0));
}

/** `ok` at exactly the minimum — the reserve is a floor, not a target above it. */
function guestReserveStatus(availablePlaces, guestReserveMinimum) {
  return (availablePlaces || 0) >= (guestReserveMinimum || 0) ? 'ok' : 'low';
}

/**
 * Fold one availability row into the snapshot the API answers with. A missing row
 * means "nothing released", not an error, so every counter defaults to 0.
 */
function buildAvailabilitySnapshot(row, { date, timezone, guestReserveMinimum }) {
  const counters = row || {};
  const availablePlaces = counters.available_places || 0;

  return {
    date,
    timezone,
    releasedPlaces: counters.released_places || 0,
    availablePlaces,
    employeeAvailability: {
      before19: counters.before_19_employee_places || 0,
      after19: counters.after_19_employee_places || 0
    },
    guestReserve: {
      minimum: guestReserveMinimum,
      availablePlaces,
      status: guestReserveStatus(availablePlaces, guestReserveMinimum)
    },
    byType: {
      single: counters.available_single_places || 0,
      double: counters.available_double_places || 0,
      triple: counters.available_triple_places || 0
    }
  };
}

/**
 * What the 19:00 unlock announces: the pool is the ceiling on how many queued
 * employees can be served, so a queue longer than the pool reports the remainder
 * as unservable rather than silently truncating.
 */
function summarizeEmployeePool({ employeePoolSize: poolSize, waitingCount, servableCount }) {
  const waiting = waitingCount || 0;
  const servable = Math.min(servableCount || 0, poolSize || 0);

  return {
    waitingCount: waiting,
    servableCount: servable,
    unservableCount: Math.max(0, waiting - servable)
  };
}

module.exports = {
  buildAvailabilitySnapshot,
  employeePoolSize,
  guestReserveStatus,
  summarizeEmployeePool
};
