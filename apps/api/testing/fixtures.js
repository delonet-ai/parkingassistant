'use strict';

// Fixture builders for the core-flow integration tests.
//
// Every helper writes directly to the scratch schema created by
// packages/db/testing/harness.js and returns the inserted row, so a test can
// state its preconditions in one readable block instead of a wall of SQL.
//
// Codes and employee numbers are suffixed from a per-process counter because a
// single test file shares one scratch schema across all of its cases, and
// parking_places.code / line_groups.code are unique.

let sequence = 0;

function nextSuffix() {
  sequence += 1;
  return String(sequence).padStart(3, '0');
}

/**
 * A single-day daterange literal. Postgres dateranges are half-open, so the
 * upper bound is the day *after* the last covered date.
 */
function dayRange(dateFrom, dateTo = dateFrom) {
  return `[${dateFrom},${addDays(dateTo, 1)})`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function createFixtures(db) {
  async function insertEmployee(overrides = {}) {
    const suffix = nextSuffix();
    const firstName = overrides.firstName || `Employee${suffix}`;
    const lastName = overrides.lastName || 'Testov';

    const result = await db.query(
      `
        insert into users (kind, first_name, last_name, display_name, department, phone, employee_no)
        values ('employee', $1, $2, $3, $4, $5, $6)
        returning id, display_name, phone, department
      `,
      [
        firstName,
        lastName,
        overrides.displayName || `${lastName} ${firstName}`,
        overrides.department || 'IT',
        overrides.phone || `+7900000${suffix}`,
        overrides.employeeNo || `EMP-${suffix}`
      ]
    );

    return result.rows[0];
  }

  async function insertLineGroup(overrides = {}) {
    const suffix = nextSuffix();

    const result = await db.query(
      `
        insert into line_groups (code, name, capacity, floor_label)
        values ($1, $2, $3, $4)
        returning id, code, name, capacity, floor_label
      `,
      [
        overrides.code || `LINE-${suffix}`,
        overrides.name || `Line ${suffix}`,
        overrides.capacity || 2,
        overrides.floorLabel || '4'
      ]
    );

    return result.rows[0];
  }

  async function insertPlace(overrides = {}) {
    const suffix = nextSuffix();

    const result = await db.query(
      `
        insert into parking_places (
          code, title, floor_label, place_type,
          line_group_id, line_position_hint, guest_priority_rank
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        returning id, code, title, place_type, line_group_id, line_position_hint, guest_priority_rank
      `,
      [
        overrides.code || `P-${suffix}`,
        overrides.title || `Place ${suffix}`,
        overrides.floorLabel || '4',
        overrides.placeType || 'double',
        overrides.lineGroupId || null,
        overrides.linePositionHint || null,
        overrides.guestPriorityRank === undefined ? null : overrides.guestPriorityRank
      ]
    );

    return result.rows[0];
  }

  /** Give `userId` permanent ownership of `parkingPlaceId` around `date`. */
  async function insertPermanentAssignment({ userId, parkingPlaceId, dateFrom, dateTo }) {
    const result = await db.query(
      `
        insert into permanent_assignments (user_id, parking_place_id, valid_during)
        values ($1, $2, $3::daterange)
        returning id, user_id, parking_place_id
      `,
      [userId, parkingPlaceId, dayRange(dateFrom, dateTo || dateFrom)]
    );

    return result.rows[0];
  }

  /**
   * An owned place that its owner has released for `date` — the precondition
   * every assignment flow (manual, guest, queue) is built on.
   */
  async function insertReleasedPlace({ date, place = {}, ownerId = null }) {
    const owner = ownerId ? { id: ownerId } : await insertEmployee();
    const parkingPlace = await insertPlace(place);

    // The permanent assignment must span the release, so widen it generously.
    await insertPermanentAssignment({
      userId: owner.id,
      parkingPlaceId: parkingPlace.id,
      dateFrom: addDays(date, -30),
      dateTo: addDays(date, 30)
    });

    const release = await db.query(
      `
        insert into place_releases (user_id, parking_place_id, release_during, created_via)
        values ($1, $2, $3::daterange, 'admin_web')
        returning id, status
      `,
      [owner.id, parkingPlace.id, dayRange(date)]
    );

    return { owner, place: parkingPlace, release: release.rows[0] };
  }

  async function insertQueuedRequest({ userId, date, position }) {
    const request = await db.query(
      `
        insert into employee_parking_requests (user_id, request_date, status)
        values ($1, $2::date, 'queued')
        returning id, status
      `,
      [userId, date]
    );

    const entry = await db.query(
      `
        insert into queue_entries (employee_parking_request_id, queue_date, queue_position)
        values ($1, $2::date, $3)
        returning id, queue_position, status
      `,
      [request.rows[0].id, date, position]
    );

    return { request: request.rows[0], queueEntry: entry.rows[0] };
  }

  async function insertLineOccupancy({
    date,
    lineGroupId,
    parkingPlaceId,
    position,
    userId,
    subjectType = 'employee'
  }) {
    const result = await db.query(
      `
        insert into line_occupancy (
          occupancy_date, line_group_id, parking_place_id, position, subject_type, user_id
        )
        values ($1::date, $2, $3, $4, $5, $6)
        returning id, position
      `,
      [date, lineGroupId, parkingPlaceId, position, subjectType, userId]
    );

    return result.rows[0];
  }

  async function insertDeparturePlan({ userId, date, departureTime, isEarly = true }) {
    const result = await db.query(
      `
        insert into departure_plans (user_id, plan_date, departure_time, is_early)
        values ($1, $2::date, $3::time, $4)
        returning id, departure_time, is_early
      `,
      [userId, date, departureTime, isEarly]
    );

    return result.rows[0];
  }

  async function auditActions(entityType) {
    const result = await db.query(
      'select action, metadata from audit_logs where entity_type = $1 order by occurred_at',
      [entityType]
    );

    return result.rows;
  }

  return {
    auditActions,
    insertDeparturePlan,
    insertEmployee,
    insertLineGroup,
    insertLineOccupancy,
    insertPermanentAssignment,
    insertPlace,
    insertQueuedRequest,
    insertReleasedPlace
  };
}

/** POST helper — every admin write endpoint takes and returns JSON. */
async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  return { status: response.status, payload: await response.json() };
}

async function getJson(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);
  return { status: response.status, payload: await response.json() };
}

module.exports = { addDays, createFixtures, dayRange, getJson, postJson };
