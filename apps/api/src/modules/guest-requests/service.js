'use strict';

const { formatDateForSql } = require('../../../../../packages/shared/dates');
const { withTransaction } = require('../../repositories/db');
const { AbortTransaction, abortWith } = require('../../support/transaction');
const auditRepository = require('../audit/repository');
const placeReleasesRepository = require('../place-releases/repository');
const repository = require('./repository');
const reservationsRepository = require('../reservations/repository');

function createGuestRequestsService({ pool, dbRepository, services }) {
  async function listGuestRequests(requestDate) {
    return repository.listGuestRequests(dbRepository, requestDate);
  }

  // Creating a guest request auto-assigns it: the place is picked, reserved, journaled and
  // audited in one transaction, so a caller never observes an unassigned guest request here.
  async function createAssignedGuestRequest({
    hostUserId,
    requestDate,
    guestName,
    guestPhone,
    vehiclePlateNumber,
    notes,
    firstName,
    lastName
  }) {
    return withTransaction(pool, async (repo) => {
      await repository.lockGuestAssignmentForDate(repo, requestDate);

      const host = await repository.findActiveHost(repo, hostUserId);

      if (!host) {
        throw abortWith(404, 'Host employee not found');
      }

      const place = await placeReleasesRepository.findPlaceForGuestAssignment(repo, requestDate);

      if (!place) {
        throw abortWith(409, 'No released parking place is available for guest assignment on this date');
      }

      const warnings = await services.reservations.calculateAssignmentWarnings(
        repo,
        requestDate,
        place.parking_place_id
      );

      const guest = await repository.insertGuestUser(repo, {
        firstName,
        lastName,
        displayName: guestName,
        phone: guestPhone
      });

      const guestRequest = await repository.insertAssignedGuestRequest(repo, {
        guestUserId: guest.id,
        hostUserId,
        requestDate,
        guestName,
        guestPhone,
        vehiclePlateNumber,
        notes
      });

      const reservation = await reservationsRepository.insertReservation(repo, {
        reservationDate: requestDate,
        parkingPlaceId: place.parking_place_id,
        userId: guest.id,
        guestParkingRequestId: guestRequest.id,
        source: 'guest',
        reason: `Guest assignment hosted by ${host.display_name}`
      });

      await repository.attachReservation(repo, {
        guestRequestId: guestRequest.id,
        reservationId: reservation.id
      });

      await reservationsRepository.insertReservationEvent(repo, {
        reservationId: reservation.id,
        eventType: 'reservation_created',
        source: 'guest',
        payload: {
          releaseId: place.release_id,
          guestParkingRequestId: guestRequest.id,
          guestUserId: guest.id,
          guestName,
          hostUserId,
          hostDisplayName: host.display_name,
          parkingPlaceId: place.parking_place_id,
          requestDate
        }
      });

      await reservationsRepository.insertMovement(repo, {
        reservationId: reservation.id,
        movementDate: requestDate,
        toParkingPlaceId: place.parking_place_id,
        movementType: 'guest_assignment',
        reason: `Guest assignment hosted by ${host.display_name}`
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'guest_parking_request',
        entityId: guestRequest.id,
        action: 'guest_parking_request_created_and_assigned',
        actorService: 'admin-web',
        metadata: {
          guestUserId: guest.id,
          guestName,
          hostUserId,
          hostDisplayName: host.display_name,
          reservationId: reservation.id,
          parkingPlaceId: place.parking_place_id,
          parkingPlaceCode: place.parking_place_code,
          requestDate,
          warnings
        }
      });

      return { guest, guestRequest, host, place, reservation, warnings };
    });
  }

  async function assignGuestRequest(requestId) {
    return withTransaction(pool, async (repo) => {
      const guestRequest = await repository.findGuestRequestForUpdate(repo, requestId);

      if (!guestRequest) {
        throw abortWith(404, 'Guest parking request not found');
      }

      if (guestRequest.status === 'canceled') {
        throw abortWith(409, 'Canceled guest requests cannot be assigned');
      }

      if (guestRequest.assigned_reservation_id || guestRequest.status === 'assigned') {
        throw abortWith(409, 'Guest request is already assigned');
      }

      const requestDate = formatDateForSql(guestRequest.request_date);
      await repository.lockGuestAssignmentForDate(repo, requestDate);

      const place = await placeReleasesRepository.findPlaceForGuestAssignment(repo, requestDate);

      if (!place) {
        throw abortWith(409, 'No released parking place is available for guest assignment on this date');
      }

      const reservation = await reservationsRepository.insertReservation(repo, {
        reservationDate: requestDate,
        parkingPlaceId: place.parking_place_id,
        userId: guestRequest.guest_user_id,
        guestParkingRequestId: guestRequest.id,
        source: 'guest',
        reason: `Guest assignment hosted by ${guestRequest.host_display_name}`
      });

      const warnings = await services.reservations.calculateAssignmentWarnings(
        repo,
        requestDate,
        place.parking_place_id
      );

      await repository.markAssigned(repo, {
        guestRequestId: guestRequest.id,
        reservationId: reservation.id
      });

      await reservationsRepository.insertReservationEvent(repo, {
        reservationId: reservation.id,
        eventType: 'reservation_created',
        source: 'guest',
        payload: {
          releaseId: place.release_id,
          guestParkingRequestId: guestRequest.id,
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          parkingPlaceId: place.parking_place_id,
          requestDate
        }
      });

      await reservationsRepository.insertMovement(repo, {
        reservationId: reservation.id,
        movementDate: requestDate,
        toParkingPlaceId: place.parking_place_id,
        movementType: 'guest_assignment',
        reason: `Guest assignment hosted by ${guestRequest.host_display_name}`
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'guest_parking_request',
        entityId: guestRequest.id,
        action: 'guest_parking_request_assigned',
        actorService: 'admin-web',
        metadata: {
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          reservationId: reservation.id,
          parkingPlaceId: place.parking_place_id,
          parkingPlaceCode: place.parking_place_code,
          requestDate,
          warnings
        }
      });

      return { guestRequest, place, reservation, warnings };
    });
  }

  async function cancelGuestRequest(requestId) {
    return withTransaction(pool, async (repo) => {
      const guestRequest = await repository.findGuestRequestForUpdate(repo, requestId);

      if (!guestRequest) {
        throw abortWith(404, 'Guest parking request not found');
      }

      // Cancelling twice is not an error: the caller gets the same 200 it got the first
      // time, but the transaction still rolls back because nothing was written.
      if (guestRequest.status === 'canceled') {
        throw new AbortTransaction({
          statusCode: 200,
          payload: {
            status: 'ok',
            service: 'api',
            request: {
              id: guestRequest.id,
              requestDate: guestRequest.request_date,
              status: guestRequest.status
            }
          }
        });
      }

      let canceledReservation = null;

      if (guestRequest.assigned_reservation_id) {
        canceledReservation = await reservationsRepository.cancelActiveReservation(
          repo,
          guestRequest.assigned_reservation_id
        );

        if (canceledReservation) {
          await reservationsRepository.insertReservationEvent(repo, {
            reservationId: canceledReservation.id,
            eventType: 'reservation_canceled',
            source: 'guest',
            payload: {
              guestParkingRequestId: guestRequest.id,
              guestUserId: guestRequest.guest_user_id,
              hostUserId: guestRequest.host_user_id,
              requestDate: guestRequest.request_date
            }
          });
        }
      }

      const canceledRequest = await repository.cancelGuestRequest(repo, requestId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'guest_parking_request',
        entityId: requestId,
        action: 'guest_parking_request_canceled',
        actorService: 'admin-web',
        metadata: {
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          hostDisplayName: guestRequest.host_display_name,
          reservationId: guestRequest.assigned_reservation_id,
          canceledReservationId: canceledReservation?.id || null,
          requestDate: guestRequest.request_date
        }
      });

      return { canceledRequest, canceledReservation };
    });
  }

  // Read wrapper used by the employee history journal.
  async function listHostedRequestsForUser(userId) {
    return repository.listHostedRequestsForUser(dbRepository, userId);
  }

  return {
    assignGuestRequest,
    cancelGuestRequest,
    createAssignedGuestRequest,
    listGuestRequests,
    listHostedRequestsForUser
  };
}

module.exports = {
  createGuestRequestsService
};
