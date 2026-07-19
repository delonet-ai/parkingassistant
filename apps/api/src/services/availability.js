'use strict';

// Availability is a read model, not a bounded context (ADR 003): every number below is a
// property of released places, so the SQL lives in the place-releases repository, the
// arithmetic lives in `packages/domain`, and this file only joins the two.

const { buildAvailabilitySnapshot } = require('../../../../packages/domain/guest-reserve');
const placeReleasesRepository = require('../modules/place-releases/repository');

async function countAvailableReleasedPlaces(repo, date) {
  const row = await placeReleasesRepository.countUnreservedReleasedPlaces(repo, date);

  return row?.available_places || 0;
}

async function calculateAvailabilitySnapshot(repo, date, options) {
  const { appTimezone, guestReserveMinimum } = options;
  const row = await placeReleasesRepository.summarizeAvailability(repo, { date, guestReserveMinimum });

  return buildAvailabilitySnapshot(row, { date, timezone: appTimezone, guestReserveMinimum });
}

module.exports = {
  calculateAvailabilitySnapshot,
  countAvailableReleasedPlaces
};
