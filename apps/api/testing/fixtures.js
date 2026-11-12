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

const { sessionHeaders } = require('./session');

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

  const CAPACITY_BY_PLACE_TYPE = { single: 1, double: 2, triple: 3 };

  /**
   * Every place belongs to a line group — parking_places.line_group_id is NOT NULL since
   * 005_place_inventory.sql. A caller that does not name a group gets one of its own,
   * sized to match the requested place_type so the two stay in agreement.
   */
  async function insertPlace(overrides = {}) {
    const suffix = nextSuffix();
    const placeType = overrides.placeType || 'double';
    const floorLabel = overrides.floorLabel || '4';

    const lineGroupId =
      overrides.lineGroupId ||
      (
        await insertLineGroup({
          capacity: CAPACITY_BY_PLACE_TYPE[placeType],
          floorLabel
        })
      ).id;

    const result = await db.query(
      `
        insert into parking_places (
          code, title, floor_label, place_type, place_role,
          line_group_id, line_position_hint, guest_priority_rank
        )
        values ($1, $2, $3, $4, $5::parking_place_role, $6, $7, $8)
        returning
          id, code, title, place_type, place_role,
          line_group_id, line_position_hint, guest_priority_rank
      `,
      [
        overrides.code || `P-${suffix}`,
        overrides.title || `Place ${suffix}`,
        floorLabel,
        placeType,
        overrides.placeRole || 'regular',
        lineGroupId,
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
   * An owned place that its owner has released for `date` — the classic way into the
   * day's free supply that every assignment flow (manual, guest, queue) draws from.
   *
   * The ownership is open-ended, not a window around `date`: on any date outside an
   * ownership window the place would have no permanent owner and so be free supply,
   * leaking into the counts and picks of every other test in the same file.
   */
  async function insertReleasedPlace({ date, place = {}, ownerId = null }) {
    const { owner, place: parkingPlace } = await insertHeldPlace({ place, ownerId });

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

  /**
   * A place its permanent owner holds and has not released — so it is NOT part of
   * the day's free supply. Since the supply rule changed, a bare `insertPlace()` has
   * no owner and is free every day; use this when a test needs "just a place" that
   * must stay out of the pool, the counters and the pick order.
   *
   * Without `date` the ownership is unbounded, so the place stays held on every date
   * the suite touches; with `date` (and optionally `dateTo`) it covers only that range.
   */
  async function insertHeldPlace({ date = null, dateTo = null, place = {}, ownerId = null } = {}) {
    const owner = ownerId ? { id: ownerId } : await insertEmployee();
    const parkingPlace = await insertPlace(place);
    const validDuring = date ? dayRange(date, dateTo || date) : '(,)';

    await db.query(
      `
        insert into permanent_assignments (user_id, parking_place_id, valid_during)
        values ($1, $2, $3::daterange)
      `,
      [owner.id, parkingPlace.id, validDuring]
    );

    return { owner, place: parkingPlace };
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
    insertHeldPlace,
    insertLineGroup,
    insertLineOccupancy,
    insertPermanentAssignment,
    insertPlace,
    insertQueuedRequest,
    insertReleasedPlace
  };
}

/**
 * `target` is a base URL or the object `startApi` returned — both work, and the object reads
 * better now that it carries the session too.
 */
function baseUrlOf(target) {
  return typeof target === 'string' ? target : target.baseUrl;
}

/**
 * POST helper — every admin write endpoint takes and returns JSON.
 *
 * The session cookie comes from the jar `startApi` filled (see testing/session.js), so a test
 * does not restate it per call. `options.cookie = null` sends none, which is how the 401 paths
 * are asserted; `options.cookie = '<name=value>'` sends another operator's session.
 */
async function postJson(target, pathname, body, options = {}) {
  const baseUrl = baseUrlOf(target);

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders(baseUrl, options) },
    body: JSON.stringify(body)
  });

  return { status: response.status, payload: await response.json() };
}

/**
 * The multipart variant, for the one endpoint that takes a file.
 *
 * `fetch` derives the content type and the boundary from the FormData, which is exactly what a
 * browser does — setting the header by hand here would send a boundary the body does not use
 * and the parser would find no parts. The session travels the same way as for a JSON write.
 */
async function postForm(target, pathname, form, options = {}) {
  const baseUrl = baseUrlOf(target);

  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: sessionHeaders(baseUrl, options),
    body: form
  });

  return { status: response.status, payload: await response.json() };
}

async function getJson(target, pathname, options = {}) {
  const baseUrl = baseUrlOf(target);

  const response = await fetch(`${baseUrl}${pathname}`, { headers: sessionHeaders(baseUrl, options) });

  return { status: response.status, payload: await response.json() };
}

module.exports = { addDays, baseUrlOf, createFixtures, dayRange, getJson, postForm, postJson };
