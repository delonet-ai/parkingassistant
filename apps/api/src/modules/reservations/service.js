'use strict';

const { earlyDepartureBlockingWarnings } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const { countAvailableReleasedPlaces } = require('../../services/availability');
const { AbortTransaction, abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const conflictsRepository = require('../conflicts/repository');
const employeeRequestsRepository = require('../employee-requests/repository');
const employeesRepository = require('../employees/repository');
const guestRequestsRepository = require('../guest-requests/repository');
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

  async function createManualReservation({ userId, parkingPlaceId, reservationDate, reason }) {
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
        actorService: 'admin-web',
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

  async function cancelReservation(reservationId) {
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
        actorService: 'admin-web',
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
    listReservationsForUser
  };
}

module.exports = {
  createReservationsService
};
