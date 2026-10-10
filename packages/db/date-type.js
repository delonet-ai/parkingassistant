'use strict';

const { types } = require('pg');

// A Postgres `date` must leave the driver as the text Postgres wrote, never as a JS `Date`.
//
// `pg`'s default parser for `date` builds a `Date` at *local* midnight. Every container sets
// `TZ=Europe/Moscow` (`infra/docker/*.Dockerfile`), so `2026-10-10` became
// `2026-10-09T21:00:00.000Z` — which is what `JSON.stringify` then put in the response, and
// what `formatDateForSql`'s `toISOString().slice(0, 10)` read back as `2026-10-09`. Every date
// the API returned was a day early on the stand: the day a reservation is for, the window a
// release covers, the date a job ran for. The test suites run in UTC, where local midnight *is*
// the ISO date, which is why nothing caught it.
//
// Reading the column as its own text has no timezone in it at all. The repositories that
// already cast (`::text`, `to_char(...)`) keep returning exactly what they did; the ones that
// return the column bare now agree with them instead of contradicting them.
//
// `setTypeParser` is process-wide in `pg`, not per pool, so one call covers every pool a
// process opens — but it has to happen before a query runs, which is why the callers below
// call it at bootstrap rather than near a query.
const DATE_OID = 1082;

function registerDateTypeParser() {
  types.setTypeParser(DATE_OID, (value) => value);
}

module.exports = {
  DATE_OID,
  registerDateTypeParser
};
