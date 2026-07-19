'use strict';

// Availability is a read model, not a bounded context (ADR 003): every number below is a
// property of released places, so the SQL lives in the place-releases repository and this
// file only folds one row into the shape the API answers with.

const placeReleasesRepository = require('../modules/place-releases/repository');

async function countAvailableReleasedPlaces(repo, date) {
  const row = await placeReleasesRepository.countUnreservedReleasedPlaces(repo, date);

  return row?.available_places || 0;
}

async function calculateAvailabilitySnapshot(repo, date, options) {
  const { appTimezone, guestReserveMinimum } = options;
  const row = (await placeReleasesRepository.summarizeAvailability(repo, { date, guestReserveMinimum })) || {};
  const availablePlaces = row.available_places || 0;

  return {
    date,
    timezone: appTimezone,
    releasedPlaces: row.released_places || 0,
    availablePlaces,
    employeeAvailability: {
      before19: row.before_19_employee_places || 0,
      after19: row.after_19_employee_places || 0
    },
    guestReserve: {
      minimum: guestReserveMinimum,
      availablePlaces,
      status: availablePlaces >= guestReserveMinimum ? 'ok' : 'low'
    },
    byType: {
      single: row.available_single_places || 0,
      double: row.available_double_places || 0,
      triple: row.available_triple_places || 0
    }
  };
}

module.exports = {
  calculateAvailabilitySnapshot,
  countAvailableReleasedPlaces
};
