'use strict';

const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { uuidValidationError } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');

function createPlaceReleasesController({ appTimezone, services }) {
  const service = services.placeReleases;

  async function handleAdminPlaceReleasesList(searchParams) {
    const dateFrom = searchParams.get('dateFrom');
    const dateTo = searchParams.get('dateTo');

    if ((dateFrom && !isIsoDate(dateFrom)) || (dateTo && !isIsoDate(dateTo))) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'dateFrom and dateTo must use YYYY-MM-DD format'
        }
      };
    }

    const releases = await service.listReleasesInRange({
      dateFrom: dateFrom || null,
      dateTo: dateTo || dateFrom || null
    });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        releases: releases.map((release) => ({
          id: release.id,
          dateFrom: release.date_from,
          dateTo: release.date_to,
          status: release.status,
          createdVia: release.created_via,
          createdAt: release.created_at,
          notes: release.notes,
          user: {
            id: release.user_id,
            displayName: release.user_display_name,
            department: release.user_department
          },
          parkingPlace: {
            id: release.parking_place_id,
            code: release.parking_place_code,
            title: release.parking_place_title,
            placeType: release.parking_place_type
          }
        }))
      }
    };
  }

  async function handleAdminPlaceReleaseCreate(req) {
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

    const parkingPlaceId = body.parkingPlaceId;
    const dateFrom = body.dateFrom;
    const dateTo = body.dateTo || dateFrom;
    const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

    if (!parkingPlaceId || !isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'parkingPlaceId, dateFrom and dateTo are required; dates must use YYYY-MM-DD format'
        }
      };
    }

    const invalidId = uuidValidationError({ parkingPlaceId });

    if (invalidId) {
      return invalidId;
    }

    if (dateTo < dateFrom) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'dateTo must be greater than or equal to dateFrom'
        }
      };
    }

    // A release hands a place to the pool for a day that has not happened yet.
    // Releasing a day that already ended cannot change who parked — it only
    // pollutes availability and history with a slot nobody could ever have taken.
    const today = currentDateInTimezone(appTimezone);

    if (dateFrom < today) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: `dateFrom must not be in the past (today is ${today} in ${appTimezone})`
        }
      };
    }

    try {
      const { owner, release } = await service.createRelease({ parkingPlaceId, dateFrom, dateTo, notes });

      return {
        statusCode: 201,
        payload: {
          status: 'ok',
          service: 'api',
          release: {
            id: release.id,
            dateFrom: release.date_from,
            dateTo: release.date_to,
            status: release.status,
            createdVia: release.created_via,
            createdAt: release.created_at,
            user: {
              id: owner.user_id,
              displayName: owner.user_display_name
            },
            parkingPlace: {
              id: parkingPlaceId,
              code: owner.parking_place_code
            }
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleAdminPlaceReleaseCreate');
    }
  }

  async function handleAdminPlaceReleaseCancel(req) {
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

    const releaseId = body.releaseId;

    if (!releaseId) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'releaseId is required'
        }
      };
    }

    const invalidId = uuidValidationError({ releaseId });

    if (invalidId) {
      return invalidId;
    }

    try {
      const canceledRelease = await service.cancelRelease(releaseId);

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          release: {
            id: canceledRelease.id,
            dateFrom: canceledRelease.date_from,
            dateTo: canceledRelease.date_to,
            status: canceledRelease.status,
            canceledAt: canceledRelease.canceled_at
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleAdminPlaceReleaseCancel');
    }
  }

  return {
    name: 'place-releases',
    routes: [
      {
        method: 'GET',
        path: '/admin/place-releases',
        advertise: true,
        handler: ({ searchParams }) => handleAdminPlaceReleasesList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/place-releases',
        handler: ({ req }) => handleAdminPlaceReleaseCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/place-releases/cancel',
        advertise: true,
        handler: ({ req }) => handleAdminPlaceReleaseCancel(req)
      }
    ]
  };
}

module.exports = {
  createPlaceReleasesController
};
