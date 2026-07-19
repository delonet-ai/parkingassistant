'use strict';

const {
  blockingContactResolution,
  describeBlockingContact,
  isValidLinePosition
} = require('../../../../../packages/domain');
const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { mapLineOccupancy } = require('../../serializers/line-occupancy');
const { uuidValidationError } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');

// This module owns the whole `/admin/line-groups*` and `/bot/line/*` URL space — the lines as
// the operator meets them day to day: who stands where today, and who has to be called to move.
// `place-lines` owns `/admin/place-lines*`, the inventory writes that decide which lines and
// places exist at all. The split is by question asked, not by table touched, so the roster read
// behind `GET /admin/line-groups` goes through `services.placeLines` rather than a second copy
// of the inventory queries here.
function createLineOccupancyController({ appTimezone, services }) {
  const service = services.lineOccupancy;

  async function handleAdminLineGroupsList() {
    const groups = await services.placeLines.listLineGroupsWithPlaces();

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        lineGroups: groups.map((group) => ({
          id: group.id,
          code: group.code,
          name: group.name,
          capacity: group.capacity,
          floorLabel: group.floor_label,
          notes: group.notes,
          places: group.places || []
        }))
      }
    };
  }

  async function handleAdminLineGroupOccupancy(lineGroupId, searchParams) {
    const occupancyDate = searchParams.get('date') || currentDateInTimezone(appTimezone);

    if (!lineGroupId || !isIsoDate(occupancyDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'line group id and date=YYYY-MM-DD are required'
        }
      };
    }

    const invalidId = uuidValidationError({ lineGroupId });

    if (invalidId) {
      return invalidId;
    }

    const lineGroup = await services.placeLines.findLineGroupById(lineGroupId);

    if (!lineGroup) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Line group not found'
        }
      };
    }

    const rows = await service.getLineOccupancyRows(lineGroupId, occupancyDate);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date: occupancyDate,
        lineGroup: {
          id: lineGroup.id,
          code: lineGroup.code,
          name: lineGroup.name,
          capacity: lineGroup.capacity,
          floorLabel: lineGroup.floor_label
        },
        occupancy: rows.map(mapLineOccupancy)
      }
    };
  }

  async function handleAdminLineOccupancyList(searchParams) {
    const occupancyDate = searchParams.get('date') || currentDateInTimezone(appTimezone);

    if (!isIsoDate(occupancyDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    const rows = await service.listOccupancyForDate(occupancyDate);

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date: occupancyDate,
        occupancy: rows.map(mapLineOccupancy)
      }
    };
  }

  async function handleLineOccupancySet(req, actorService = 'admin-web') {
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

    const occupancyDate = body.occupancyDate || body.date;
    const lineGroupId = body.lineGroupId;
    const parkingPlaceId = body.parkingPlaceId;
    const position = Number(body.position);
    const subjectType = body.subjectType || 'employee';
    const userId = body.userId || null;
    const guestParkingRequestId = body.guestParkingRequestId || null;

    if (!isIsoDate(occupancyDate) || !lineGroupId || !parkingPlaceId || !isValidLinePosition(position)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'occupancyDate, lineGroupId, parkingPlaceId and position 1..3 are required'
        }
      };
    }

    if ((subjectType === 'employee' && !userId) || (subjectType === 'guest' && !guestParkingRequestId) || !['employee', 'guest'].includes(subjectType)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'employee occupancy requires userId; guest occupancy requires guestParkingRequestId'
        }
      };
    }

    const invalidId = uuidValidationError({
      lineGroupId,
      parkingPlaceId,
      userId,
      guestParkingRequestId,
      reservationId: body.reservationId || null
    });

    if (invalidId) {
      return invalidId;
    }

    try {
      const { occupancyId, occupancy } = await service.setLineOccupancy({
        occupancyDate,
        lineGroupId,
        parkingPlaceId,
        position,
        subjectType,
        userId,
        guestParkingRequestId,
        reservationId: body.reservationId || null,
        actorService
      });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          occupancy: occupancy ? mapLineOccupancy(occupancy) : { id: occupancyId }
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
            error: 'Line position or parking place is already occupied for this date'
          }
        };
      }

      return internalError(error, 'handleLineOccupancySet');
    }
  }

  async function handleBotBlockingContacts(searchParams) {
    const requesterUserId = searchParams.get('requesterUserId') || searchParams.get('userId');
    const occupancyDate = searchParams.get('date') || currentDateInTimezone(appTimezone);

    if (!requesterUserId || !isIsoDate(occupancyDate)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'requesterUserId and date=YYYY-MM-DD are required'
        }
      };
    }

    const invalidId = uuidValidationError({ requesterUserId });

    if (invalidId) {
      return invalidId;
    }

    // Deliberately not a transaction: the original ran these on one pooled client without
    // ever issuing `begin`, so each log row committed on its own. Reading a contact and
    // recording that it was read are independent facts, and a failure part-way through
    // should keep the rows already written.
    const requester = await service.findEmployeeOccupancy({
      occupancyDate,
      userId: requesterUserId
    });

    if (!requester) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Requester line occupancy was not found for this date'
        }
      };
    }

    const blockers = await service.listBlockersAhead({
      occupancyDate,
      lineGroupId: requester.line_group_id,
      position: requester.position
    });

    if (!blockers.length) {
      await services.contactAccess.recordNoBlockers({
        requesterUserId,
        occupancyDate,
        lineGroupId: requester.line_group_id,
        metadata: {
          requesterPosition: requester.position
        }
      });
    }

    const contacts = [];

    for (const blocker of blockers) {
      const resolution = blockingContactResolution(blocker.subject_type);

      await services.contactAccess.recordContactAccess({
        requesterUserId,
        occupancyDate,
        lineGroupId: requester.line_group_id,
        targetUserId: blocker.user_id,
        targetGuestParkingRequestId: blocker.guest_parking_request_id,
        resolution,
        metadata: {
          requesterPosition: requester.position,
          blockerPosition: blocker.position,
          blockerSubjectType: blocker.subject_type
        }
      });

      contacts.push(describeBlockingContact(blocker));
    }

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date: occupancyDate,
        lineGroup: {
          id: requester.line_group_id,
          code: requester.line_group_code,
          name: requester.line_group_name
        },
        requesterPosition: requester.position,
        contacts
      }
    };
  }

  return {
    name: 'line-occupancy',
    routes: [
      {
        method: 'GET',
        path: '/admin/line-groups',
        advertise: true,
        handler: () => handleAdminLineGroupsList()
      },
      {
        method: 'GET',
        path: '/admin/line-occupancy',
        advertise: true,
        handler: ({ searchParams }) => handleAdminLineOccupancyList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/line-occupancy',
        handler: ({ req }) => handleLineOccupancySet(req, 'admin-web')
      },
      {
        method: 'GET',
        pattern: /^\/admin\/line-groups\/([^/]+)\/occupancy$/,
        advertise: '/admin/line-groups/:id/occupancy',
        handler: ({ params, searchParams }) => handleAdminLineGroupOccupancy(params[0], searchParams)
      },
      {
        method: 'POST',
        paths: ['/bot/line/position', '/bot/line-occupancy'],
        advertise: '/bot/line/position',
        handler: ({ req }) => handleLineOccupancySet(req, 'bot')
      },
      {
        method: 'GET',
        path: '/bot/line/blocking-contacts',
        advertise: true,
        handler: ({ searchParams }) => handleBotBlockingContacts(searchParams)
      }
    ]
  };
}

module.exports = {
  createLineOccupancyController
};
