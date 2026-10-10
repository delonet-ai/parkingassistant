'use strict';

const { isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { normalizeUuid, uuidValidationError } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');
const { requestActor } = require('../../support/actor');

function createReservationsController({ services }) {
  const service = services.reservations;

  async function handleAdminManualReservationCreate(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const userId = body.userId;
    const parkingPlaceId = body.parkingPlaceId;
    const reservationDate = body.reservationDate;
    const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;

    if (!userId || !parkingPlaceId || !isIsoDate(reservationDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'userId, parkingPlaceId and reservationDate are required; date must use YYYY-MM-DD format'
        }
      };
    }

    const invalidId = uuidValidationError({ userId, parkingPlaceId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { employee, releasedPlace, reservation, warnings } = await service.createManualReservation({
        actor,
        userId,
        parkingPlaceId,
        reservationDate,
        reason
      });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          reservation: {
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            source: reservation.source,
            status: reservation.status,
            createdAt: reservation.created_at,
            user: {
              id: userId,
              displayName: employee.display_name
            },
            parkingPlace: {
              id: parkingPlaceId,
              code: releasedPlace.parking_place_code
            }
          },
          warnings
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      if (error.code === '23505') {
        return {
          statusCode: 409,
          payload: {
            status: 'error',
            service: 'api',
            error: 'This place or employee already has an active reservation for the selected date'
          }
        };
      }

      return internalError(error, 'handleAdminManualReservationCreate');
    }
  }

  async function handleAdminReservationCancel(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    const reservationId = body.reservationId;

    if (!reservationId) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'reservationId is required'
        }
      };
    }

    const invalidId = uuidValidationError({ reservationId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { canceledReservation } = await service.cancelReservation({ actor, reservationId });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          reservation: {
            id: canceledReservation.id,
            reservationDate: canceledReservation.reservation_date,
            status: canceledReservation.status,
            canceledAt: canceledReservation.canceled_at
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleAdminReservationCancel');
    }
  }

  async function handleAdminReservationMove(req, actor) {
    let body;

    try {
      body = await readJsonBody(req);
    } catch {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Request body must be valid JSON'
        }
      };
    }

    // Lowercased, because the uuid shape accepts either case while the service compares the
    // target against the id Postgres returned — which is lowercase. An uppercase id would slip
    // past "already on this place" and be refused as "taken by" its own holder instead.
    const reservationId = normalizeUuid(body.reservationId);
    const toParkingPlaceId = normalizeUuid(body.toParkingPlaceId);
    const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;

    if (!reservationId || !toParkingPlaceId) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'reservationId and toParkingPlaceId are required'
        }
      };
    }

    const invalidId = uuidValidationError({ reservationId, toParkingPlaceId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { reservation, from, to, warnings } = await service.moveReservation({
        actor,
        reservationId,
        toParkingPlaceId,
        reason
      });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          reservation: {
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            source: reservation.source,
            status: reservation.status,
            fromParkingPlace: from,
            parkingPlace: to
          },
          warnings
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      // The partial unique index is the last word on "one active reservation per place and
      // date", should a write slip past the lock-guarded check.
      if (error.code === '23505') {
        return {
          statusCode: 409,
          payload: {
            status: 'error',
            service: 'api',
            error: 'The target place already has an active reservation for this date'
          }
        };
      }

      return internalError(error, 'handleAdminReservationMove');
    }
  }

  return {
    name: 'reservations',
    routes: [
      {
        method: 'POST',
        path: '/admin/reservations/manual',
        advertise: true,
        handler: (context) => handleAdminManualReservationCreate(context.req, requestActor(context))
      },
      {
        method: 'POST',
        path: '/admin/reservations/cancel',
        advertise: true,
        handler: (context) => handleAdminReservationCancel(context.req, requestActor(context))
      },
      {
        method: 'POST',
        path: '/admin/reservations/move',
        handler: (context) => handleAdminReservationMove(context.req, requestActor(context))
      }
    ]
  };
}

module.exports = {
  createReservationsController
};
