'use strict';

const defaultErrorCodeByStatus = new Map([
  [400, 'bad_request'],
  [404, 'not_found'],
  [409, 'conflict'],
  [422, 'validation_error'],
  [500, 'internal_error']
]);

function errorCodeForStatus(statusCode) {
  return defaultErrorCodeByStatus.get(statusCode) || 'error';
}

function normalizeApiErrorPayload(payload, statusCode) {
  if (!payload || typeof payload !== 'object' || !payload.error) {
    return payload;
  }

  return {
    status: payload.status || 'error',
    ...payload,
    error: payload.error,
    code: payload.code || errorCodeForStatus(statusCode),
    details: Object.prototype.hasOwnProperty.call(payload, 'details') ? payload.details : null
  };
}

function errorPayload(error, statusCode = 500, details = null) {
  return normalizeApiErrorPayload(
    {
      status: 'error',
      service: 'api',
      error: error instanceof Error ? error.message : String(error),
      details
    },
    statusCode
  );
}

module.exports = {
  errorPayload,
  normalizeApiErrorPayload
};
