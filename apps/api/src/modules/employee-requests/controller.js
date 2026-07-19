'use strict';

const { isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { uuidValidationError } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');

function createEmployeeRequestsController({ services }) {
  const service = services.employeeRequests;

  async function handleAdminEmployeeParkingRequestsList(searchParams) {
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

    const requests = await service.listRequestsForDate(requestDate || null);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        requests: requests.map((request) => ({
          id: request.id,
          requestDate: request.request_date,
          status: request.status,
          requestedAt: request.requested_at,
          canceledAt: request.canceled_at,
          notes: request.notes,
          user: {
            id: request.user_id,
            displayName: request.user_display_name,
            department: request.user_department
          },
          queueEntry: request.queue_entry_id
            ? {
                id: request.queue_entry_id,
                position: request.queue_position,
                status: request.queue_status,
                processedAt: request.processed_at
              }
            : null,
          assignedReservation: request.reservation_id
            ? {
                id: request.reservation_id,
                parkingPlaceCode: request.assigned_place_code
              }
            : null
        }))
      }
    };
  }

  async function handleAdminEmployeeParkingRequestCreate(req) {
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
    const requestDate = body.requestDate;
    const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

    if (!userId || !isIsoDate(requestDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'userId and requestDate are required; date must use YYYY-MM-DD format'
        }
      };
    }

    const invalidId = uuidValidationError({ userId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { employee, parkingRequest, queueEntry } = await service.createRequest({ userId, requestDate, notes });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          request: {
            id: parkingRequest.id,
            requestDate: parkingRequest.request_date,
            status: parkingRequest.status,
            requestedAt: parkingRequest.requested_at,
            user: {
              id: userId,
              displayName: employee.display_name
            },
            queueEntry: {
              id: queueEntry.id,
              position: queueEntry.queue_position,
              status: queueEntry.status
            }
          }
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
            error: 'Employee already has an active request for the selected date'
          }
        };
      }

      return internalError(error, 'handleAdminEmployeeParkingRequestCreate');
    }
  }

  async function handleAdminEmployeeParkingRequestCancel(req) {
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
      const canceledRequest = await service.cancelRequest(requestId);

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
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleAdminEmployeeParkingRequestCancel');
    }
  }

  return {
    name: 'employee-requests',
    routes: [
      {
        method: 'GET',
        path: '/admin/employee-parking-requests',
        advertise: true,
        handler: ({ searchParams }) => handleAdminEmployeeParkingRequestsList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/employee-parking-requests',
        handler: ({ req }) => handleAdminEmployeeParkingRequestCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/employee-parking-requests/cancel',
        handler: ({ req }) => handleAdminEmployeeParkingRequestCancel(req)
      }
    ]
  };
}

module.exports = {
  createEmployeeRequestsController
};
