'use strict';

const { planQueueAssignments } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const auditRepository = require('../audit/repository');
const employeeRequestsRepository = require('../employee-requests/repository');
const placeReleasesRepository = require('../place-releases/repository');
const repository = require('./repository');
const reservationsRepository = require('../reservations/repository');

// The queue context serves no route of its own: the only way to run it is the
// `POST /admin/jobs/process-queue` endpoint, which reaches it as
// `services.queue.processQueueForDate(date)`.
function createQueueService({ pool, guestReserveMinimum }) {
  // Everything runs inside one transaction behind `lockQueueForDate`: the waiting entries
  // and the released places have to be read from the same snapshot the reservations are
  // written into, otherwise two concurrent runs could hand out the same place.
  async function processQueueForDate(queueDate) {
    try {
      return await withTransaction(pool, async (repo) => {
        await repository.lockQueueForDate(repo, queueDate);

        const queueEntries = await repository.listWaitingEntriesForUpdate(repo, queueDate);
        const availablePlaces = await placeReleasesRepository.listPlacesForQueueAssignment(repo, queueDate);

        const { decisions } = planQueueAssignments({
          entries: queueEntries,
          places: availablePlaces,
          guestReserveMinimum
        });

        const assignments = [];
        const skipped = [];

        for (const decision of decisions) {
          const { entry } = decision;
          const identity = {
            requestId: entry.request_id,
            queueEntryId: entry.queue_entry_id,
            queuePosition: entry.queue_position,
            userId: entry.user_id,
            userDisplayName: entry.user_display_name
          };

          if (decision.outcome === 'close') {
            await employeeRequestsRepository.assignRequest(repo, {
              requestId: entry.request_id,
              reservationId: decision.reservationId
            });

            await repository.assignQueueEntry(repo, {
              queueEntryId: entry.queue_entry_id,
              reservationId: decision.reservationId
            });

            skipped.push({ ...identity, reservationId: decision.reservationId, reason: decision.reason });
            continue;
          }

          if (decision.outcome === 'skip') {
            skipped.push({ ...identity, reason: decision.reason });
            continue;
          }

          const { place } = decision;
          const reservation = await reservationsRepository.insertReservation(repo, {
            reservationDate: queueDate,
            parkingPlaceId: place.parking_place_id,
            userId: entry.user_id,
            employeeParkingRequestId: entry.request_id,
            source: 'queue',
            reason: `Queue assignment #${entry.queue_position}`
          });

          await employeeRequestsRepository.assignRequest(repo, {
            requestId: entry.request_id,
            reservationId: reservation.id
          });

          await repository.assignQueueEntry(repo, {
            queueEntryId: entry.queue_entry_id,
            reservationId: reservation.id
          });

          await reservationsRepository.insertReservationEvent(repo, {
            reservationId: reservation.id,
            eventType: 'reservation_created',
            source: 'queue',
            payload: {
              releaseId: place.release_id,
              queueEntryId: entry.queue_entry_id,
              queuePosition: entry.queue_position,
              requestId: entry.request_id,
              userId: entry.user_id,
              parkingPlaceId: place.parking_place_id,
              queueDate
            }
          });

          await reservationsRepository.insertMovement(repo, {
            reservationId: reservation.id,
            movementDate: queueDate,
            toParkingPlaceId: place.parking_place_id,
            movementType: 'queue_assignment',
            reason: `Assigned from queue position #${entry.queue_position}`
          });

          assignments.push({
            requestId: entry.request_id,
            queueEntryId: entry.queue_entry_id,
            queuePosition: entry.queue_position,
            reservationId: reservation.id,
            user: {
              id: entry.user_id,
              displayName: entry.user_display_name
            },
            parkingPlace: {
              id: place.parking_place_id,
              code: place.parking_place_code
            }
          });
        }

        // Entries closed against a reservation the user already held are excluded:
        // they were marked 'assigned' above and must not be downgraded to 'skipped'.
        const skippedEntryIds = skipped
          .filter((item) => item.reason !== 'already_has_reservation')
          .map((item) => item.queueEntryId);

        if (skippedEntryIds.length) {
          await repository.markEntriesSkipped(repo, skippedEntryIds);
        }

        await auditRepository.insertAuditLog(repo, {
          entityType: 'queue_entry',
          action: 'queue_processed',
          actorService: 'admin-web',
          metadata: {
            queueDate,
            waitingCount: queueEntries.length,
            availableReleasedPlacesCount: availablePlaces.length,
            guestReserveMinimum,
            assignedCount: assignments.length,
            skippedCount: skipped.length,
            assignments,
            skipped
          }
        });

        return {
          date: queueDate,
          guestReserveMinimum,
          availableReleasedPlacesCount: availablePlaces.length,
          assignedCount: assignments.length,
          skippedCount: skipped.length,
          assignments,
          skipped
        };
      });
    } catch (error) {
      if (error.code === '23505') {
        error.statusCode = 409;
        error.message = 'Queue processing hit an existing active reservation for this date';
      }

      throw error;
    }
  }

  return {
    processQueueForDate
  };
}

module.exports = {
  createQueueService
};
