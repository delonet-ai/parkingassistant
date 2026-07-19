'use strict';

const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');

function createConflictsController({ appTimezone, services }) {
  const service = services.conflicts;

  async function handleConflictsList(searchParams) {
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
        conflicts: await service.getConflictsForDate(date)
      }
    };
  }

  return {
    name: 'conflicts',
    routes: [
      {
        method: 'GET',
        path: '/admin/conflicts',
        advertise: true,
        safe: true,
        handler: ({ searchParams }) => handleConflictsList(searchParams)
      }
    ]
  };
}

module.exports = {
  createConflictsController
};
