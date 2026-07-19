'use strict';

const { isIsoDate } = require('../../../../../packages/shared/dates');
const { mapAuditLog } = require('../../serializers/audit-logs');
const { parsePositiveLimit, uuidValidationError } = require('../../support/params');

function createAuditController({ services }) {
  const service = services.audit;

  async function handleAdminAuditLogsList(searchParams) {
    const date = searchParams.get('date');
    const entityType = searchParams.get('entityType');
    const entityId = searchParams.get('entityId');
    const action = searchParams.get('action');
    const actor = searchParams.get('actor');
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

    const invalidId = uuidValidationError({ entityId });

    if (invalidId) {
      return invalidId;
    }

    const rows = await service.listAuditLogs({
      date,
      entityType,
      entityId,
      action,
      actor,
      limit
    });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        auditLogs: rows.map(mapAuditLog)
      }
    };
  }

  return {
    name: 'audit',
    routes: [
      {
        method: 'GET',
        path: '/admin/audit-logs',
        advertise: true,
        handler: ({ searchParams }) => handleAdminAuditLogsList(searchParams)
      }
    ]
  };
}

module.exports = {
  createAuditController
};
