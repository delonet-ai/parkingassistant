'use strict';

const { isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { AbortTransaction } = require('../../support/transaction');

function createReservationsController({ services }) {
  const service = services.reservations;

  async function handleAdminManualReservationCreate(req) {
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

    try {
      const { employee, releasedPlace, reservation, warnings } = await service.createManualReservation({
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

      return {
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          error: error.message
        }
      };
    }
  }

  async function handleAdminReservationCancel(req) {
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

    try {
      const { canceledReservation } = await service.cancelReservation(reservationId);

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

      return {
        statusCode: 500,
        payload: {
          status: 'error',
          service: 'api',
          error: error.message
        }
      };
    }
  }

  return {
    name: 'reservations',
    routes: [
      {
        method: 'POST',
        path: '/admin/reservations/manual',
        advertise: true,
        handler: ({ req }) => handleAdminManualReservationCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/reservations/cancel',
        advertise: true,
        handler: ({ req }) => handleAdminReservationCancel(req)
      }
    ]
  };
}

module.exports = {
  createReservationsController
};
