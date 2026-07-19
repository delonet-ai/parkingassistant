'use strict';

const auditRepository = require('../audit/repository');
const permanentAssignmentsRepository = require('../permanent-assignments/repository');
const placeReleasesRepository = require('../place-releases/repository');
const repository = require('./repository');
const reservationsRepository = require('../reservations/repository');

function createPlacesService({ dbRepository }) {
  async function listPlacesWithOwnerAndLine() {
    return repository.listPlacesWithOwnerAndLine(dbRepository);
  }

  // is_active is deliberately NOT writable here. Removing a place from service goes
  // through /admin/place-lines/archive and nowhere else; a single slot is taken out of
  // rotation with place_role = 'blocked'. Two write paths to one column is the drift
  // this endpoint used to have with the now-deleted /admin/places/disable.
  async function updatePlace(input) {
    const place = await repository.updatePlace(dbRepository, input);

    if (!place) {
      return null;
    }

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'parking_place',
      entityId: input.placeId,
      action: 'parking_place_updated',
      actorService: 'admin-web',
      metadata: {
        code: input.code,
        title: input.title,
        floorLabel: input.floorLabel,
        placeType: input.placeType,
        lineGroupId: input.lineGroupId,
        linePositionHint: input.linePositionHint,
        guestPriorityRank: input.guestPriorityRank,
        placeRole: input.placeRole
      }
    });

    return place;
  }

  // The place journal is a fan-out read across five contexts. It stays one round trip
  // per context in one Promise.all, exactly as the monolith ran it.
  async function getPlaceHistory(placeId) {
    const place = await repository.findPlaceForHistory(dbRepository, placeId);

    if (!place) {
      return null;
    }

    const [permanentAssignments, releases, reservations, movements, auditLogs] = await Promise.all([
      permanentAssignmentsRepository.listAssignmentsForPlace(dbRepository, placeId),
      placeReleasesRepository.listReleasesForPlace(dbRepository, placeId),
      reservationsRepository.listReservationsForPlace(dbRepository, placeId),
      reservationsRepository.listMovementsForPlace(dbRepository, placeId),
      auditRepository.listAuditLogsForPlace(dbRepository, placeId)
    ]);

    return {
      place,
      permanentAssignments,
      releases,
      reservations,
      movements,
      auditLogs
    };
  }

  return {
    getPlaceHistory,
    listPlacesWithOwnerAndLine,
    updatePlace
  };
}

module.exports = {
  createPlacesService
};
