'use strict';

// Request-shaped helpers shared by more than one controller. Pure: they read strings and
// URLSearchParams and return plain values, so they carry no layer of their own.

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
  splitDisplayName
};
