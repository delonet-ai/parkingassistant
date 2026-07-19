'use strict';

const { calculateAvailabilitySnapshot } = require('../../services/availability');
const guestRequestsRepository = require('../guest-requests/repository');
const placeReleasesRepository = require('../place-releases/repository');
const reservationsRepository = require('../reservations/repository');

// The dashboard is a read-only composition over other contexts, so it owns no
// repository of its own (see the note under Task 15 in the finalization plan).
function createDashboardService({ dbRepository, appTimezone, guestReserveMinimum }) {
  // One Promise.all, exactly as the monolith ran it: four independent reads of the
  // same date, none of which depends on another.
  async function getDashboardSnapshot(date) {
    const [releasedPlaces, reservations, guestRequests, guestReserve] = await Promise.all([
      placeReleasesRepository.listActiveReleasesForDate(dbRepository, date),
      reservationsRepository.listActiveReservationsForDate(dbRepository, date),
      guestRequestsRepository.listGuestRequestsForDate(dbRepository, date),
      placeReleasesRepository.countUnreservedReleasedPlaces(dbRepository, date)
    ]);

    return { releasedPlaces, reservations, guestRequests, guestReserve };
  }

  async function getAvailability(date) {
    return calculateAvailabilitySnapshot(dbRepository, date, { appTimezone, guestReserveMinimum });
  }

  return {
    getAvailability,
    getDashboardSnapshot
  };
}

module.exports = {
  createDashboardService
};
