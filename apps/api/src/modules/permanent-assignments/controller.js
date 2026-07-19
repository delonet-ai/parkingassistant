'use strict';

const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { normalizeOptionalString } = require('../../support/params');

function createPermanentAssignmentsController({ appTimezone, services }) {
  const service = services.permanentAssignments;

  async function handleAdminPermanentAssignmentsList(searchParams) {
    const date = searchParams.get('date') || currentDateInTimezone(appTimezone);
    const status = searchParams.get('status') || 'all';

    if (!isIsoDate(date)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    if (!['all', 'active', 'future', 'ended'].includes(status)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'status must be one of all, active, future, ended'
        }
      };
    }

    const rows = await service.listPermanentAssignments({ date, status });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date,
        filterStatus: status,
        permanentAssignments: rows.map((assignment) => ({
          id: assignment.id,
          dateFrom: assignment.date_from,
          dateTo: assignment.date_to,
          status: assignment.assignment_status,
          notes: assignment.notes,
          createdAt: assignment.created_at,
          updatedAt: assignment.updated_at,
          user: {
            id: assignment.user_id,
            displayName: assignment.user_display_name,
            department: assignment.user_department,
            email: assignment.user_email,
            phone: assignment.user_phone
          },
          parkingPlace: {
            id: assignment.parking_place_id,
            code: assignment.parking_place_code,
            title: assignment.parking_place_title,
            floorLabel: assignment.parking_place_floor_label,
            placeType: assignment.parking_place_type
          }
        }))
      }
    };
  }

  async function handleAdminPermanentAssignmentCreate(req) {
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
    const dateFrom = body.dateFrom;
    const dateTo = normalizeOptionalString(body.dateTo);
    const notes = normalizeOptionalString(body.notes);

    if (!userId || !parkingPlaceId || !isIsoDate(dateFrom) || (dateTo && !isIsoDate(dateTo))) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'userId, parkingPlaceId, dateFrom and optional dateTo=YYYY-MM-DD are required'
        }
      };
    }

    try {
      const assignment = await service.createPermanentAssignment({
        userId,
        parkingPlaceId,
        dateFrom,
        dateTo,
        notes
      });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          permanentAssignment: assignment
        }
      };
    } catch (error) {
      if (error.code === '23P01') {
        return {
          statusCode: 409,
          payload: {
            status: 'error',
            service: 'api',
            error: 'Permanent assignment overlaps existing assignment for this user or place'
          }
        };
      }

      if (error.code === '23503') {
        return {
          statusCode: 404,
          payload: {
            status: 'error',
            service: 'api',
            error: 'Employee or parking place not found'
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

  async function handleAdminPermanentAssignmentEnd(req) {
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

    const assignmentId = body.assignmentId;
    const dateTo = body.dateTo;

    if (!assignmentId || !isIsoDate(dateTo)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'assignmentId and dateTo=YYYY-MM-DD are required'
        }
      };
    }

    const assignment = await service.endPermanentAssignment({ assignmentId, dateTo });

    if (!assignment) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Permanent assignment not found or dateTo is before assignment start'
        }
      };
    }

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        permanentAssignment: assignment
      }
    };
  }

  return {
    name: 'permanent-assignments',
    routes: [
      {
        method: 'GET',
        path: '/admin/permanent-assignments',
        advertise: true,
        safe: true,
        handler: ({ searchParams }) => handleAdminPermanentAssignmentsList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/permanent-assignments',
        handler: ({ req }) => handleAdminPermanentAssignmentCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/permanent-assignments/end',
        advertise: true,
        handler: ({ req }) => handleAdminPermanentAssignmentEnd(req)
      }
    ]
  };
}

module.exports = {
  createPermanentAssignmentsController
};
