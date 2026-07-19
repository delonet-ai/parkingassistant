'use strict';

const { withTransaction } = require('../../repositories/db');
const { AbortTransaction, abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const permanentAssignmentsRepository = require('../permanent-assignments/repository');
const repository = require('./repository');
const reservationsRepository = require('../reservations/repository');

function createPlaceReleasesService({ pool, dbRepository, appTimezone }) {
  async function listReleasesInRange({ dateFrom, dateTo }) {
    return repository.listReleasesInRange(dbRepository, { dateFrom, dateTo });
  }

  // Read-only journal lookup shared with the employees context, which fans a user's
  // history out across every context that stores rows about them.
  async function listReleasesForUser(userId) {
    return repository.listReleasesForUser(dbRepository, userId);
  }

  // The owner lookup, the overlap check and the insert have to agree on one snapshot:
  // two admins releasing the same place for overlapping ranges would otherwise both
  // pass the overlap check before either insert lands.
  async function createRelease({ parkingPlaceId, dateFrom, dateTo, notes }) {
    return withTransaction(pool, async (repo) => {
      const owner = await permanentAssignmentsRepository.findOwnerForRange(repo, {
        parkingPlaceId,
        dateFrom,
        dateTo
      });

      if (!owner) {
        throw abortWith(409, 'Parking place has no permanent owner for the selected date range');
      }

      const overlap = await repository.findOverlappingRelease(repo, {
        parkingPlaceId,
        dateFrom,
        dateTo
      });

      if (overlap) {
        throw abortWith(409, 'Parking place already has an active release overlapping this date range');
      }

      const release = await repository.insertRelease(repo, {
        userId: owner.user_id,
        parkingPlaceId,
        dateFrom,
        dateTo,
        notes
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'place_release',
        entityId: release.id,
        action: 'place_release_created',
        actorService: 'admin-web',
        metadata: {
          userId: owner.user_id,
          userDisplayName: owner.user_display_name,
          parkingPlaceId,
          parkingPlaceCode: owner.parking_place_code,
          dateFrom,
          dateTo,
          createdVia: 'admin_web'
        }
      });

      return { owner, release };
    });
  }

  // Cancelling re-reads the release under a row lock, so the frozen check and the
  // reservation check cannot race the freeze job or a queue assignment.
  async function cancelRelease(releaseId) {
    return withTransaction(pool, async (repo) => {
      const release = await repository.findReleaseForUpdate(repo, releaseId);

      if (!release) {
        throw abortWith(404, 'Place release not found');
      }

      // Cancelling an already-canceled release answers 200 with the release as it
      // stands. It aborts rather than returns so the transaction rolls back, exactly
      // as the monolith did.
      if (release.status === 'canceled') {
        throw new AbortTransaction({
          statusCode: 200,
          payload: {
            status: 'ok',
            service: 'api',
            release: {
              id: release.id,
              status: release.status,
              dateFrom: release.date_from,
              dateTo: release.date_to
            }
          }
        });
      }

      // Once freeze-next-day has run for the released day, the release is part of
      // that day's settled pool and cannot be taken back — someone may already be
      // counting on the place.
      if (release.frozen_at) {
        throw abortWith(409, 'Cannot cancel a release for a day that is already frozen', {
          frozenAt: release.frozen_at,
          timezone: appTimezone
        });
      }

      const activeReservation = await reservationsRepository.findActiveReservationInRange(repo, {
        parkingPlaceId: release.parking_place_id,
        releaseDuring: release.release_during
      });

      if (activeReservation) {
        throw abortWith(409, 'Cannot cancel release while it has active reservations');
      }

      const canceledRelease = await repository.cancelRelease(repo, releaseId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'place_release',
        entityId: releaseId,
        action: 'place_release_canceled',
        actorService: 'admin-web',
        metadata: {
          userId: release.user_id,
          userDisplayName: release.user_display_name,
          parkingPlaceId: release.parking_place_id,
          parkingPlaceCode: release.parking_place_code,
          dateFrom: release.date_from,
          dateTo: release.date_to
        }
      });

      return canceledRelease;
    });
  }

  return {
    cancelRelease,
    createRelease,
    listReleasesForUser,
    listReleasesInRange
  };
}

module.exports = {
  createPlaceReleasesService
};
