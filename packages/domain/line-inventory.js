'use strict';

// Line-inventory rules (ADR 004). An element is a parking line holding 1–3 slots;
// `line_groups.capacity` is the single source of truth for its size, and both
// `parking_places.place_type` and the 1..capacity position hints are derived from it.
// Nothing here touches a database or a request.

const PLACE_ROLES = ['regular', 'rotatable', 'blocked'];
const LINE_CAPACITIES = [1, 2, 3];
const PLACE_TYPE_BY_CAPACITY = { 1: 'single', 2: 'double', 3: 'triple' };

/** Derived, not independent: the valid place types are exactly the capacities' names. */
const PLACE_TYPES = Object.values(PLACE_TYPE_BY_CAPACITY);

/** The lowest and highest guest priority rank a slot may carry (a smallint rank). */
const GUEST_PRIORITY_RANK_MIN = 1;
const GUEST_PRIORITY_RANK_MAX = 99;

function isValidCapacity(capacity) {
  return LINE_CAPACITIES.includes(capacity);
}

function isValidPlaceType(placeType) {
  return PLACE_TYPES.includes(placeType);
}

function placeTypeForCapacity(capacity) {
  return PLACE_TYPE_BY_CAPACITY[capacity] || null;
}

function normalizePlaceRole(value, fallback = 'regular') {
  return PLACE_ROLES.includes(value) ? value : fallback;
}

/**
 * Guest priority is a smallint rank; an empty value means "not in the guest pool".
 * Returns `undefined` for a value that is present but not a valid rank, which the
 * caller reports as a 400 — `null` and `undefined` are genuinely different answers here.
 */
function normalizeGuestPriorityRank(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const rank = Number(value);

  return Number.isInteger(rank) && rank >= GUEST_PRIORITY_RANK_MIN && rank <= GUEST_PRIORITY_RANK_MAX
    ? rank
    : undefined;
}

/** The six statuses a slot can read, in the precedence below. */
const PLACE_STATUSES = ['occupied', 'guest', 'released', 'blocked', 'rotatable', 'free'];

/**
 * Status precedence for one slot, highest-priority fact first: an actual occupant
 * beats a release, a release beats the slot's static role.
 *
 * This is the single implementation. The API's element list feeds it database rows
 * (`placeSlotStatus` below), while the admin-web place drawer feeds it the dashboard
 * payload — so a slot reading «недоступно» can never open a card reading «свободно».
 */
function derivePlaceStatus({
  hasReservation = false,
  reservationSource = null,
  hasRelease = false,
  placeRole = 'regular'
} = {}) {
  if (hasReservation) {
    return reservationSource === 'guest' ? 'guest' : 'occupied';
  }

  if (hasRelease) {
    return 'released';
  }

  if (placeRole === 'blocked' || placeRole === 'rotatable') {
    return placeRole;
  }

  return 'free';
}

/** The same rule, over a `parking_places` row joined to its reservation and release. */
function placeSlotStatus(row) {
  return derivePlaceStatus({
    hasReservation: Boolean(row.reservation_id),
    reservationSource: row.reservation_source,
    hasRelease: Boolean(row.release_id),
    placeRole: row.place_role
  });
}

/** Positions run front (1) to rear (capacity), in the order the slots were given. */
function assignSlotPositions(slots) {
  return slots.map((slot, index) => ({ ...slot, position: index + 1 }));
}

function lineCodeFor(floorLabel, frontSlotCode) {
  return `line-${floorLabel}-${frontSlotCode}`;
}

function lineNameFor(floorLabel, frontSlotCode) {
  return `Линия ${floorLabel} / ${frontSlotCode}`;
}

function invalid(statusCode, error) {
  return { error: { statusCode, error } };
}

/**
 * Validate a requested element and derive everything the transaction needs.
 *
 * The capacity ↔ slot count agreement is checked here rather than left to the
 * database, because a mismatch is an operator mistake with a precise message, not a
 * constraint violation. Returns `{ error }` or `{ line }`; never throws.
 */
function buildLineDefinition({ floorLabel, capacity, slots }) {
  const size = Number(capacity);
  const rawSlots = Array.isArray(slots) ? slots : [];

  if (!floorLabel) {
    return invalid(400, 'floorLabel is required');
  }

  if (!isValidCapacity(size)) {
    return invalid(400, 'capacity must be 1, 2 or 3');
  }

  if (rawSlots.length !== size) {
    return invalid(400, `slots must contain exactly ${size} entries to match capacity`);
  }

  const normalized = [];

  for (const rawSlot of rawSlots) {
    const code = typeof rawSlot?.code === 'string' ? rawSlot.code.trim() : '';
    const title = typeof rawSlot?.title === 'string' && rawSlot.title.trim() ? rawSlot.title.trim() : code;
    const guestPriorityRank = normalizeGuestPriorityRank(rawSlot?.guestPriorityRank);

    if (!code) {
      return invalid(400, 'every slot needs a code');
    }

    if (guestPriorityRank === undefined) {
      return invalid(400, 'guestPriorityRank must be an integer between 1 and 99');
    }

    normalized.push({
      code,
      title,
      placeRole: normalizePlaceRole(rawSlot?.placeRole),
      guestPriorityRank
    });
  }

  const duplicate = normalized.find(
    (slot, index) => normalized.findIndex((other) => other.code === slot.code) !== index
  );

  if (duplicate) {
    return invalid(409, `Duplicate place code in request: ${duplicate.code}`);
  }

  const placeType = placeTypeForCapacity(size);

  return {
    line: {
      floorLabel,
      capacity: size,
      placeType,
      code: lineCodeFor(floorLabel, normalized[0].code),
      name: lineNameFor(floorLabel, normalized[0].code),
      notes: `${placeType} element`,
      slots: assignSlotPositions(normalized)
    }
  };
}

/**
 * Normalize the rows that refuse an archive. An empty list means the line may be
 * archived; anything in it is named back to the operator so they know what to clear.
 */
function describeArchiveBlockers(rows) {
  return (rows || []).map((row) => ({
    type: row.blocker_type,
    placeCode: row.place_code,
    detail: row.detail,
    userDisplayName: row.user_display_name || null
  }));
}

module.exports = {
  GUEST_PRIORITY_RANK_MAX,
  GUEST_PRIORITY_RANK_MIN,
  LINE_CAPACITIES,
  PLACE_ROLES,
  PLACE_STATUSES,
  PLACE_TYPES,
  PLACE_TYPE_BY_CAPACITY,
  assignSlotPositions,
  buildLineDefinition,
  derivePlaceStatus,
  describeArchiveBlockers,
  isValidCapacity,
  isValidPlaceType,
  lineCodeFor,
  lineNameFor,
  normalizeGuestPriorityRank,
  normalizePlaceRole,
  placeSlotStatus,
  placeTypeForCapacity
};
