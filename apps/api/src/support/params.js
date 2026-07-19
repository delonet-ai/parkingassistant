'use strict';

// Request-shaped helpers shared by more than one controller. Pure: they read strings and
// URLSearchParams and return plain values, so they carry no layer of their own.

// Postgres raises 22P02 on a malformed uuid, which the driver reports with the offending
// value quoted in the message. Rejecting the shape here keeps that out of the response and
// turns "the id is not an id" into the 400 it always was.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && uuidPattern.test(value);
}

// Returns a ready-to-return 400 naming every field that is present but not uuid-shaped, or
// null when they all pass. Absent fields are skipped on purpose: "missing" is the caller's
// own required-check to report, and folding the two together would relabel every existing
// "X is required" response.
function uuidValidationError(fields) {
  const invalid = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && !isUuid(value))
    .map(([name]) => name);

  if (invalid.length === 0) {
    return null;
  }

  return {
    statusCode: 400,
    payload: {
      status: 'error',
      service: 'api',
      error: `${invalid.join(', ')} must be a valid uuid`
    }
  };
}

function splitDisplayName(displayName) {
  const nameParts = displayName.split(/\s+/).filter(Boolean);
  return {
    lastName: nameParts[0] || displayName,
    firstName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : displayName
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() || null : null;
}

function parsePositiveLimit(searchParams, fallback = 100, maximum = 300) {
  const rawLimit = Number(searchParams.get('limit') || fallback);

  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(rawLimit), maximum);
}

module.exports = {
  normalizeOptionalString,
  parsePositiveLimit,
  splitDisplayName,
  uuidValidationError
};
