'use strict';

// Time-of-day rules. Pure: every function takes the clock reading as an argument
// rather than reading it, so a rule can be replayed for any moment.
//
// All comparisons are string comparisons over zero-padded `HH:MM` in h23 form,
// which sort chronologically (pinned in `packages/shared/dates.test.js`).

const { isValidTime } = require('../shared/dates');

/** A departure before this counts as early and can be blocked by the cars behind it. */
const EARLY_DEPARTURE_CUTOFF = '18:00';

/** After this, the current day's departure time is settled and can no longer be edited. */
const DEPARTURE_EDIT_CUTOFF = '07:00';

/** Postgres hands back `HH:MM:SS`; every rule here works on `HH:MM`. */
function normalizeDepartureTime(value) {
  return typeof value === 'string' ? value.slice(0, 5) : '';
}

function isEarlyDeparture(value) {
  return isValidTime(value) && value < EARLY_DEPARTURE_CUTOFF;
}

/**
 * The 07:00 wall-clock rule: only *today's* plan is frozen, and only once the
 * cut-off has passed. A future date is always editable.
 */
function isDepartureEditClosed({ planDate, today, currentTime }) {
  return planDate === today && currentTime >= DEPARTURE_EDIT_CUTOFF;
}

/**
 * `departure_plans.is_early` is stamped at write time and never revisited, so it
 * drifts if the rule changes or a row is written by hand. Returns only the plans
 * whose stored flag disagrees with the rule, each with the value it should carry.
 */
function findDriftedDeparturePlans(plans) {
  const drifted = [];

  for (const plan of plans) {
    const isEarly = isEarlyDeparture(normalizeDepartureTime(plan.departure_time));

    if (isEarly !== plan.is_early) {
      drifted.push({ id: plan.id, isEarly });
    }
  }

  return drifted;
}

module.exports = {
  DEPARTURE_EDIT_CUTOFF,
  EARLY_DEPARTURE_CUTOFF,
  findDriftedDeparturePlans,
  isDepartureEditClosed,
  isEarlyDeparture,
  normalizeDepartureTime
};
