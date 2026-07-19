'use strict';

const { isIsoDate } = require('../../../../../packages/shared/dates');
const { mapContactAccessLog } = require('../../serializers/contact-access');
const { parsePositiveLimit } = require('../../support/params');

function createContactAccessController({ services }) {
  const service = services.contactAccess;

  async function handleAdminContactAccessLogsList(searchParams) {
    const date = searchParams.get('date');
    const limit = parsePositiveLimit(searchParams, 100, 300);

    if (date && !isIsoDate(date)) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'date must use YYYY-MM-DD format'
        }
      };
    }

    const rows = await service.listContactAccessLogs({ date, limit });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        contactAccessLogs: rows.map(mapContactAccessLog)
      }
    };
  }

  return {
    name: 'contact-access',
    routes: [
      {
        method: 'GET',
        path: '/admin/contact-access-logs',
        advertise: true,
        handler: ({ searchParams }) => handleAdminContactAccessLogsList(searchParams)
      }
    ]
  };
}

module.exports = {
  createContactAccessController
};
