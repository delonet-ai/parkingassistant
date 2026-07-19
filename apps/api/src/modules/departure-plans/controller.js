'use strict';

const { isDepartureEditClosed, normalizeDepartureTime } = require('../../../../../packages/domain');
const { currentDateInTimezone, currentTimeInTimezone, isIsoDate, isValidTime } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { uuidValidationError } = require('../../support/params');
const { AbortTransaction } = require('../../support/transaction');
const { internalError } = require('../../support/http-errors');

function createDeparturePlansController({ appTimezone, services }) {
  const service = services.departurePlans;

  async function handleDeparturePlansList(searchParams) {
    const date = searchParams.get('date') || currentDateInTimezone(appTimezone);

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

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date,
        departurePlans: await service.getPlansForDate(date)
      }
    };
  }

  async function handleDeparturePlanUpsert(req, actorService = 'bot') {
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
    const planDate = body.planDate || body.date;
    const departureTime = normalizeDepartureTime(body.departureTime);

    if (!userId || !isIsoDate(planDate) || !isValidTime(departureTime)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'userId, planDate and departureTime HH:MM are required'
        }
      };
    }

    const invalidId = uuidValidationError({ userId });

    if (invalidId) {
      return invalidId;
    }

    // Cheap wall-clock rejection before the transaction opens; the persisted lock is
    // checked inside it, because only there can it be read consistently with the write.
    if (
      isDepartureEditClosed({
        planDate,
        today: currentDateInTimezone(appTimezone),
        currentTime: currentTimeInTimezone(appTimezone)
      })
    ) {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Departure time for the current day can be edited only before 07:00',
          timezone: appTimezone
        }
      };
    }

    try {
      const { plan, user } = await service.upsertPlan({ userId, planDate, departureTime, actorService });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          departurePlan: {
            id: plan.id,
            planDate: plan.plan_date,
            departureTime: plan.departure_time.slice(0, 5),
            isEarly: plan.is_early,
            createdAt: plan.created_at,
            updatedAt: plan.updated_at,
            user: {
              id: userId,
              displayName: user.display_name
            }
          }
        }
      };
    } catch (error) {
      if (error instanceof AbortTransaction) {
        return error.result;
      }

      return internalError(error, 'handleDeparturePlanUpsert');
    }
  }

  return {
    name: 'departure-plans',
    routes: [
      {
        method: 'POST',
        paths: ['/bot/departure-plans', '/admin/departure-plans'],
        advertise: true,
        handler: ({ req, pathname }) => handleDeparturePlanUpsert(req, pathname.startsWith('/bot/') ? 'bot' : 'admin-web')
      },
      {
        // Deliberately not advertised: the POST route above already published
        // `/admin/departure-plans`, and the endpoint index de-duplicates paths.
        method: 'GET',
        path: '/admin/departure-plans',
        handler: ({ searchParams }) => handleDeparturePlansList(searchParams)
      }
    ]
  };
}

module.exports = {
  createDeparturePlansController
};
