'use strict';

const auditRepository = require('../audit/repository');
const placesRepository = require('../places/repository');
const repository = require('./repository');
const reservationsRepository = require('../reservations/repository');
const { isPositionWithinCapacity } = require('../../../../../packages/domain');
const { withTransaction } = require('../../repositories/db');
const { abortWith } = require('../../support/transaction');

function createLineOccupancyService({ pool, dbRepository }) {
  async function getLineOccupancyRows(lineGroupId, occupancyDate) {
    return repository.listOccupancyForLineAndDate(dbRepository, { lineGroupId, occupancyDate });
  }

  async function listOccupancyForDate(occupancyDate) {
    return repository.listOccupancyForDate(dbRepository, { occupancyDate });
  }

  async function findEmployeeOccupancy({ occupancyDate, userId }) {
    return repository.findEmployeeOccupancy(dbRepository, { occupancyDate, userId });
  }

  async function listBlockersAhead({ occupancyDate, lineGroupId, position }) {
    return repository.listBlockersAhead(dbRepository, { occupancyDate, lineGroupId, position });
  }

  // Writing a line position is the one place where a stale read would hand two cars the same
  // slot, so the whole check-then-write runs inside `withTransaction` behind a lock on the
  // line for that date. The follow-up read is deliberately outside the transaction: it is a
  // presentation read of the committed state, exactly as the monolith ran it.
  async function setLineOccupancy({
    occupancyDate,
    lineGroupId,
    parkingPlaceId,
    position,
    subjectType,
    userId,
    guestParkingRequestId,
    reservationId: requestedReservationId,
    actorService
  }) {
    const occupancyId = await withTransaction(pool, async (repo) => {
      await repository.lockLineForDate(repo, { lineGroupId, occupancyDate });

      const place = await placesRepository.findPlaceInLineForUpdate(repo, { parkingPlaceId, lineGroupId });

      if (!place) {
        throw abortWith(404, 'Parking place is not attached to the selected line group');
      }

      if (!isPositionWithinCapacity(position, place.capacity)) {
        throw abortWith(400, `Position ${position} exceeds line capacity ${place.capacity}`);
      }

      const reservation = await reservationsRepository.findActiveReservationOnPlaceDate(repo, {
        parkingPlaceId,
        reservationDate: occupancyDate
      });

      if (reservation && subjectType === 'employee' && reservation.user_id && reservation.user_id !== userId) {
        throw abortWith(409, 'Active reservation on this place belongs to another user');
      }

      if (reservation && subjectType === 'guest' && reservation.guest_parking_request_id && reservation.guest_parking_request_id !== guestParkingRequestId) {
        throw abortWith(409, 'Active reservation on this place belongs to another guest request');
      }

      await repository.deleteOccupancyForSubject(repo, {
        occupancyDate,
        subjectType,
        userId,
        guestParkingRequestId
      });

      const reservationId = reservation?.id || requestedReservationId || null;
      const occupancy = await repository.insertOccupancy(repo, {
        occupancyDate,
        lineGroupId,
        parkingPlaceId,
        position,
        subjectType,
        userId,
        guestParkingRequestId,
        reservationId
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'line_occupancy',
        entityId: occupancy.id,
        action: 'line_position_set',
        actorService,
        metadata: {
          occupancyDate,
          lineGroupId,
          parkingPlaceId,
          parkingPlaceCode: place.code,
          position,
          subjectType,
          userId,
          guestParkingRequestId,
          reservationId
        }
      });

      return occupancy.id;
    });

    const rows = await getLineOccupancyRows(lineGroupId, occupancyDate);

    return {
      occupancyId,
      occupancy: rows.find((row) => row.occupancy_id === occupancyId)
    };
  }

  return {
    findEmployeeOccupancy,
    getLineOccupancyRows,
    listBlockersAhead,
    listOccupancyForDate,
    setLineOccupancy
  };
}

module.exports = {
  createLineOccupancyService
};
