'use strict';

const { earlyDepartureBlockingWarnings } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const { countAvailableReleasedPlaces } = require('../../services/availability');
const { AbortTransaction, abortWith } = require('../../support/transaction');
const { auditActor } = require('../../support/actor');
const auditRepository = require('../audit/repository');
const conflictsRepository = require('../conflicts/repository');
const employeeRequestsRepository = require('../employee-requests/repository');
const employeesRepository = require('../employees/repository');
const guestRequestsRepository = require('../guest-requests/repository');
const lineOccupancyRepository = require('../line-occupancy/repository');
const placeReleasesRepository = require('../place-releases/repository');
const placesRepository = require('../places/repository');
const queueRepository = require('../queue/repository');
const repository = require('./repository');

function createReservationsService({ pool, dbRepository, guestReserveMinimum }) {
  // Client-bound on purpose: the warnings are read inside whichever transaction is about to
  // write the assignment, so the caller passes its own repository handle in. The guest-requests
  // service calls this from inside its own transaction via `services.reservations`.
  async function calculateAssignmentWarnings(repo, reservationDate, parkingPlaceId) {
    const place = await placesRepository.findPlaceLineContext(repo, parkingPlaceId);

    if (!place?.line_group_id) {
      return [];
    }

    const risks = await conflictsRepository.listEarlyDepartureRisksBehind(repo, {
      reservationDate,
      lineGroupId: place.line_group_id,
      linePositionHint: place.line_position_hint
    });

    return earlyDepartureBlockingWarnings({ placeCode: place.code, risks });
  }

  async function createManualReservation({ actor, userId, parkingPlaceId, reservationDate, reason }) {
    return withTransaction(pool, async (repo) => {
      await placeReleasesRepository.lockManualAssignmentForDate(repo, reservationDate);

      const releasedPlace = await placeReleasesRepository.findActiveReleaseForPlaceDate(repo, {
        parkingPlaceId,
        reservationDate
      });

      if (!releasedPlace) {
        throw abortWith(409, 'Manual assignment is currently allowed only for places released for the selected date');
      }

      if (releasedPlace.owner_user_id === userId) {
        throw abortWith(409, 'Released place owner cannot be manually assigned to the same released place');
      }

      const employee = await employeesRepository.findEmployeeById(repo, userId);

      if (!employee) {
        throw abortWith(404, 'Employee not found');
      }

      const availableReleasedPlacesCount = await countAvailableReleasedPlaces(repo, reservationDate);

      if (availableReleasedPlacesCount <= guestReserveMinimum) {
        throw abortWith(409, `Manual employee assignment would reduce guest reserve below ${guestReserveMinimum} places`, {
          guestReserve: {
            minimum: guestReserveMinimum,
            availablePlaces: availableReleasedPlacesCount
          }
        });
      }

      const warnings = await calculateAssignmentWarnings(repo, reservationDate, parkingPlaceId);

      const reservation = await repository.insertReservation(repo, {
        reservationDate,
        parkingPlaceId,
        userId,
        source: 'manual',
        reason
      });

      // Serving the employee manually answers their parking request, so close it
      // and its queue entry here. Leaving them 'queued' used to make them a
      // candidate for the next queue run, which then tripped the one-reservation-
      // per-user-per-day constraint and failed the whole batch.
      const closedRequest = await employeeRequestsRepository.closeOpenRequestForUserDate(repo, {
        userId,
        requestDate: reservationDate,
        reservationId: reservation.id
      });

      if (closedRequest) {
        await queueRepository.assignWaitingEntriesForRequest(repo, {
          employeeParkingRequestId: closedRequest.id,
          reservationId: reservation.id
        });
      }

      await repository.insertReservationEvent(repo, {
        reservationId: reservation.id,
        eventType: 'reservation_created',
        source: 'manual',
        payload: {
          releaseId: releasedPlace.release_id,
          userId,
          parkingPlaceId,
          reservationDate,
          closedEmployeeRequestId: closedRequest?.id || null
        }
      });

      await repository.insertMovement(repo, {
        reservationId: reservation.id,
        movementDate: reservationDate,
        toParkingPlaceId: parkingPlaceId,
        movementType: 'manual_reassign',
        reason: reason || 'Manual admin assignment'
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'reservation',
        entityId: reservation.id,
        action: 'manual_reservation_created',
        ...auditActor(actor),
        metadata: {
          releaseId: releasedPlace.release_id,
          userId,
          userDisplayName: employee.display_name,
          parkingPlaceId,
          parkingPlaceCode: releasedPlace.parking_place_code,
          reservationDate,
          closedEmployeeRequestId: closedRequest?.id || null,
          warnings
        }
      });

      return { employee, releasedPlace, reservation, warnings };
    });
  }

  async function cancelReservation({ actor, reservationId }) {
    return withTransaction(pool, async (repo) => {
      const reservation = await repository.findReservationForUpdate(repo, reservationId);

      if (!reservation) {
        throw abortWith(404, 'Reservation not found');
      }

      // Cancelling twice is not an error: the caller gets the same 200 it got the first
      // time, but the transaction still rolls back because nothing was written.
      if (reservation.status === 'canceled') {
        throw new AbortTransaction({
          statusCode: 200,
          payload: {
            status: 'ok',
            service: 'api',
            reservation: {
              id: reservation.id,
              reservationDate: reservation.reservation_date,
              status: reservation.status
            }
          }
        });
      }

      if (reservation.status !== 'active') {
        throw abortWith(409, 'Only active reservations can be canceled');
      }

      const canceledReservation = await repository.cancelReservation(repo, reservationId);

      if (reservation.employee_parking_request_id) {
        await employeeRequestsRepository.reopenAssignedRequest(repo, reservation.employee_parking_request_id);
        await queueRepository.reopenAssignedEntriesForRequest(repo, reservation.employee_parking_request_id);
      }

      if (reservation.guest_parking_request_id) {
        await guestRequestsRepository.cancelGuestRequestIfNotCanceled(repo, reservation.guest_parking_request_id);
      }

      await repository.insertReservationEvent(repo, {
        reservationId,
        eventType: 'reservation_canceled',
        source: reservation.source,
        payload: {
          reservationDate: reservation.reservation_date,
          parkingPlaceId: reservation.parking_place_id,
          parkingPlaceCode: reservation.parking_place_code,
          userId: reservation.user_id,
          employeeParkingRequestId: reservation.employee_parking_request_id,
          guestParkingRequestId: reservation.guest_parking_request_id
        }
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'reservation',
        entityId: reservationId,
        action: 'reservation_canceled',
        ...auditActor(actor),
        metadata: {
          reservationDate: reservation.reservation_date,
          parkingPlaceId: reservation.parking_place_id,
          parkingPlaceCode: reservation.parking_place_code,
          userId: reservation.user_id,
          userDisplayName: reservation.user_display_name,
          source: reservation.source
        }
      });

      return { canceledReservation };
    });
  }

  // A move is one reservation changing place, not a cancel plus a new booking: the id, the
  // source and the request it answers all survive, and `parking_movements` gets one row
  // with both ends. The target obeys the rules an assignment obeys — released for the date,
  // free, not archived, not blocked — and every refusal names what stood in the way.
  async function moveReservation({ actor, reservationId, toParkingPlaceId, reason }) {
    return withTransaction(pool, async (repo) => {
      const reservation = await repository.findReservationForUpdate(repo, reservationId);

      if (!reservation) {
        throw abortWith(404, 'Reservation not found');
      }

      if (reservation.status !== 'active') {
        throw abortWith(409, 'Only active reservations can be moved');
      }

      if (reservation.parking_place_id === toParkingPlaceId) {
        throw abortWith(409, `The reservation is already on place ${reservation.parking_place_code}`);
      }

      const reservationDate = reservation.reservation_date_iso;

      // The same per-date lock a manual assignment takes, so a move and an assignment
      // racing for one target cannot both pass the checks below.
      await placeReleasesRepository.lockManualAssignmentForDate(repo, reservationDate);

      const target = await placesRepository.findPlaceForMoveForUpdate(repo, toParkingPlaceId);

      if (!target) {
        throw abortWith(404, 'Target parking place not found');
      }

      if (target.deleted_at || !target.is_active) {
        throw abortWith(409, `Place ${target.code} is archived`, {
          blocker: { type: 'archived', parkingPlaceCode: target.code }
        });
      }

      if (target.place_role === 'blocked') {
        throw abortWith(409, `Place ${target.code} is blocked`, {
          blocker: { type: 'blocked', parkingPlaceCode: target.code }
        });
      }

      const holder = await repository.findActiveHolderOnPlaceDate(repo, {
        parkingPlaceId: toParkingPlaceId,
        reservationDate
      });

      if (holder) {
        const holderName = holder.user_display_name || holder.guest_name || 'unknown';

        throw abortWith(409, `Place ${target.code} is already taken on ${reservationDate} by ${holderName}`, {
          blocker: {
            type: 'reservation',
            parkingPlaceCode: target.code,
            reservationId: holder.id,
            holderName
          }
        });
      }

      const release = await placeReleasesRepository.findActiveReleaseForPlaceDate(repo, {
        parkingPlaceId: toParkingPlaceId,
        reservationDate
      });

      if (!release) {
        throw abortWith(409, `Place ${target.code} is not released for ${reservationDate}`, {
          blocker: { type: 'not_released', parkingPlaceCode: target.code }
        });
      }

      if (reservation.user_id && release.owner_user_id === reservation.user_id) {
        throw abortWith(409, 'Released place owner cannot be moved onto the same released place');
      }

      const warnings = await calculateAssignmentWarnings(repo, reservationDate, toParkingPlaceId);

      const moved = await repository.moveReservation(repo, { reservationId, toParkingPlaceId });

      const clearedOccupancy = await lineOccupancyRepository.deleteOccupancyForReservationPlace(repo, {
        reservationId,
        parkingPlaceId: reservation.parking_place_id
      });

      await repository.insertMovement(repo, {
        reservationId,
        movementDate: reservationDate,
        fromParkingPlaceId: reservation.parking_place_id,
        toParkingPlaceId,
        movementType: 'manual_reassign',
        reason: reason || 'Manual admin move',
        actorAuthUserId: auditActor(actor).actorAuthUserId
      });

      await repository.insertReservationEvent(repo, {
        reservationId,
        eventType: 'reservation_moved',
        source: reservation.source,
        payload: {
          reservationDate,
          fromParkingPlaceId: reservation.parking_place_id,
          toParkingPlaceId,
          releaseId: release.release_id
        }
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'reservation',
        entityId: reservationId,
        action: 'reservation_moved',
        ...auditActor(actor),
        metadata: {
          reservationDate,
          userId: reservation.user_id,
          userDisplayName: reservation.user_display_name,
          guestParkingRequestId: reservation.guest_parking_request_id,
          fromParkingPlaceId: reservation.parking_place_id,
          fromParkingPlaceCode: reservation.parking_place_code,
          toParkingPlaceId,
          toParkingPlaceCode: target.code,
          releaseId: release.release_id,
          reason,
          clearedOccupancyCount: clearedOccupancy.length,
          warnings
        }
      });

      return {
        reservation: moved,
        from: { id: reservation.parking_place_id, code: reservation.parking_place_code },
        to: { id: target.id, code: target.code },
        warnings
      };
    });
  }

  // Read wrappers used by the history journals other contexts serve.
  async function listReservationsForUser(userId) {
    return repository.listReservationsForUser(dbRepository, userId);
  }

  async function listReservationsForPlace(placeId) {
    return repository.listReservationsForPlace(dbRepository, placeId);
  }

  async function listMovementsForPlace(placeId) {
    return repository.listMovementsForPlace(dbRepository, placeId);
  }

  return {
    calculateAssignmentWarnings,
    cancelReservation,
    createManualReservation,
    listMovementsForPlace,
    listReservationsForPlace,
    listReservationsForUser,
    moveReservation
  };
}

module.exports = {
  createReservationsService
};
