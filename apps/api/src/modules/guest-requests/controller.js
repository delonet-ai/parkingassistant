'use strict';

const { isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { splitDisplayName, uuidValidationError } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');

function createGuestRequestsController({ services }) {
  const service = services.guestRequests;

  async function handleAdminGuestParkingRequestsList(searchParams) {
    const requestDate = searchParams.get('date');

    if (requestDate && !isIsoDate(requestDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    const requests = await service.listGuestRequests(requestDate || null);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        requests: requests.map((request) => ({
          id: request.id,
          requestDate: request.request_date,
          status: request.status,
          guestName: request.guest_name,
          guestPhone: request.guest_phone,
          vehiclePlateNumber: request.vehicle_plate_number,
          createdAt: request.created_at,
          canceledAt: request.canceled_at,
          notes: request.notes,
          guest: {
            id: request.guest_user_id,
            displayName: request.guest_display_name
          },
          host: {
            id: request.host_user_id,
            displayName: request.host_display_name,
            department: request.host_department
          },
          assignedReservation: request.reservation_id
            ? {
                id: request.reservation_id,
                status: request.reservation_status,
                parkingPlace: {
                  id: request.parking_place_id,
                  code: request.parking_place_code,
                  title: request.parking_place_title,
                  placeType: request.parking_place_type
                }
              }
            : null
        }))
      }
    };
  }

  async function handleAdminGuestParkingRequestCreate(req) {
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

    const hostUserId = body.hostUserId;
    const requestDate = body.requestDate;
    const guestName = typeof body.guestName === 'string' ? body.guestName.trim() : '';
    const guestPhone = typeof body.guestPhone === 'string' ? body.guestPhone.trim() || null : null;
    const vehiclePlateNumber =
      typeof body.vehiclePlateNumber === 'string' ? body.vehiclePlateNumber.trim() || null : null;
    const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

    if (!hostUserId || !isIsoDate(requestDate) || !guestName) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'hostUserId, guestName and requestDate are required; date must use YYYY-MM-DD format'
        }
      };
    }

    const invalidId = uuidValidationError({ hostUserId });

    if (invalidId) {
      return invalidId;
    }

    const { firstName, lastName } = splitDisplayName(guestName);

    try {
      const { guest, guestRequest, host, place, reservation, warnings } = await service.createAssignedGuestRequest({
        hostUserId,
        requestDate,
        guestName,
        guestPhone,
        vehiclePlateNumber,
        notes,
        firstName,
        lastName
      });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          request: {
            id: guestRequest.id,
            requestDate: guestRequest.request_date,
            status: guestRequest.status,
            guestName,
            guestPhone,
            vehiclePlateNumber,
            createdAt: guestRequest.created_at,
            guest: {
              id: guest.id,
              displayName: guest.display_name,
              phone: guest.phone
            },
            host: {
              id: host.id,
              displayName: host.display_name,
              department: host.department
            },
            assignedReservation: {
              id: reservation.id,
              reservationDate: reservation.reservation_date,
              source: reservation.source,
              status: reservation.status,
              parkingPlace: {
                id: place.parking_place_id,
                code: place.parking_place_code,
                title: place.parking_place_title,
                placeType: place.place_type
              }
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
            error: 'Guest request or reservation already exists for this date'
          }
        };
      }

      return internalError(error, 'handleAdminGuestParkingRequestCreate');
    }
  }

  async function handleAdminGuestParkingRequestAssign(req) {
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

    const requestId = body.requestId;

    if (!requestId) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'requestId is required'
        }
      };
    }

    const invalidId = uuidValidationError({ requestId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { guestRequest, place, reservation, warnings } = await service.assignGuestRequest(requestId);

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          request: {
            id: guestRequest.id,
            requestDate: reservation.reservation_date,
            status: 'assigned',
            guestName: guestRequest.guest_name,
            assignedReservation: {
              id: reservation.id,
              reservationDate: reservation.reservation_date,
              source: reservation.source,
              status: reservation.status,
              parkingPlace: {
                id: place.parking_place_id,
                code: place.parking_place_code,
                title: place.parking_place_title,
                placeType: place.place_type
              }
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
            error: 'Guest reservation already exists for this date'
          }
        };
      }

      return internalError(error, 'handleAdminGuestParkingRequestAssign');
    }
  }

  async function handleAdminGuestParkingRequestCancel(req) {
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

    const requestId = body.requestId;

    if (!requestId) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'requestId is required'
        }
      };
    }

    const invalidId = uuidValidationError({ requestId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { canceledRequest, canceledReservation } = await service.cancelGuestRequest(requestId);

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          request: {
            id: canceledRequest.id,
            requestDate: canceledRequest.request_date,
            status: canceledRequest.status,
            canceledAt: canceledRequest.canceled_at
          },
          canceledReservation: canceledReservation
            ? {
                id: canceledReservation.id,
                reservationDate: canceledReservation.reservation_date,
                status: canceledReservation.status,
                canceledAt: canceledReservation.canceled_at
              }
            : null
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleAdminGuestParkingRequestCancel');
    }
  }

  return {
    name: 'guest-requests',
    routes: [
      {
        method: 'GET',
        path: '/admin/guest-parking-requests',
        advertise: true,
        handler: ({ searchParams }) => handleAdminGuestParkingRequestsList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/guest-parking-requests',
        handler: ({ req }) => handleAdminGuestParkingRequestCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/guest-parking-requests/assign',
        advertise: true,
        handler: ({ req }) => handleAdminGuestParkingRequestAssign(req)
      },
      {
        method: 'POST',
        path: '/admin/guest-parking-requests/cancel',
        handler: ({ req }) => handleAdminGuestParkingRequestCancel(req)
      }
    ]
  };
}

module.exports = {
  createGuestRequestsController
};
