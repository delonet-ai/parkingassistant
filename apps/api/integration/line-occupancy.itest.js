'use strict';

// Characterization tests for line occupancy: setting a position, the per-date
// uniqueness constraints, and the "who is ahead of me" derivation that the bot
// uses to surface blocking contacts.
//
// Position semantics: position 1 is the front of the line, higher numbers are
// deeper in. A car at position N is blocked by everyone at positions < N.

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const { startApi } = require('../testing/boot-api');
const { createFixtures, getJson, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');

const DATE = '2026-12-01';

describe('line occupancy (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let fixtures = null;

  before(async () => {
    db = await createTestDatabase();
    fixtures = createFixtures(db);
    api = await startApi({
      databaseUrl: db.connectionString,
      env: { GUEST_RESERVE_MINIMUM: '0' }
    });
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
  });

  /** A line group with `capacity` places attached, at hints 1..capacity. */
  async function lineWithPlaces(capacity, prefix) {
    const lineGroup = await fixtures.insertLineGroup({ capacity });
    const places = [];

    for (let position = 1; position <= capacity; position += 1) {
      places.push(
        await fixtures.insertPlace({
          code: `${prefix}-${position}`,
          placeType: capacity === 3 ? 'triple' : 'double',
          lineGroupId: lineGroup.id,
          linePositionHint: position
        })
      );
    }

    return { lineGroup, places };
  }

  describe('setting a position', () => {
    it('records an employee at a position and audit-logs it', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-A');
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        subjectType: 'employee',
        userId: employee.id
      });

      assert.equal(status, 201);
      assert.equal(payload.occupancy.position, 1);
      assert.equal(payload.occupancy.subjectType, 'employee');
      assert.equal(payload.occupancy.user.id, employee.id);
      assert.equal(payload.occupancy.parkingPlace.code, places[0].code);

      const audit = await db.query(
        "select actor_service, metadata from audit_logs where action = 'line_position_set' and entity_id = $1",
        [payload.occupancy.id]
      );
      assert.equal(audit.rowCount, 1);
      assert.equal(audit.rows[0].actor_service, 'admin-web');
      assert.equal(audit.rows[0].metadata.position, 1);
    });

    it('attributes the bot route to the bot actor service', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-B');
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/bot/line/position', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        userId: employee.id
      });

      assert.equal(status, 201);

      const audit = await db.query(
        "select actor_service from audit_logs where action = 'line_position_set' and entity_id = $1",
        [payload.occupancy.id]
      );
      assert.equal(audit.rows[0].actor_service, 'bot');
    });

    it('moves an employee rather than duplicating them when they set a new position', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-C');
      const employee = await fixtures.insertEmployee();

      await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        userId: employee.id
      });

      const moved = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[1].id,
        position: 2,
        userId: employee.id
      });

      assert.equal(moved.status, 201);
      assert.equal(moved.payload.occupancy.position, 2);

      const rows = await db.query(
        'select position from line_occupancy where occupancy_date = $1::date and user_id = $2',
        [DATE, employee.id]
      );
      assert.equal(rows.rowCount, 1, 'the previous row must be replaced, not kept alongside');
      assert.equal(rows.rows[0].position, 2);
    });

    it('refuses a place that does not belong to the line group', async () => {
      const { lineGroup } = await lineWithPlaces(2, 'LO-D');
      const foreign = await fixtures.insertPlace();
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: foreign.id,
        position: 1,
        userId: employee.id
      });

      assert.equal(status, 404);
      assert.match(payload.error, /not attached to the selected line group/i);
    });

    it('refuses a position beyond the line capacity', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-E');
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 3,
        userId: employee.id
      });

      assert.equal(status, 400);
      assert.match(payload.error, /Position 3 exceeds line capacity 2/);
    });

    it('rejects invalid payloads with 400', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-F');
      const employee = await fixtures.insertEmployee();

      const outOfRange = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 0,
        userId: employee.id
      });
      assert.equal(outOfRange.status, 400);
      assert.match(outOfRange.payload.error, /position 1\.\.3 are required/);

      const employeeWithoutUser = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        subjectType: 'employee'
      });
      assert.equal(employeeWithoutUser.status, 400);
      assert.match(employeeWithoutUser.payload.error, /employee occupancy requires userId/);
    });
  });

  describe('uniqueness per date', () => {
    it('refuses a position already taken in the same line on the same date', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-G');
      const first = await fixtures.insertEmployee();
      const second = await fixtures.insertEmployee();

      const initial = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        userId: first.id
      });
      assert.equal(initial.status, 201);

      // Same line, same date, same position — different place and person.
      const conflicting = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[1].id,
        position: 1,
        userId: second.id
      });

      assert.equal(conflicting.status, 409);
      assert.match(conflicting.payload.error, /already occupied for this date/i);

      const rows = await db.query(
        'select count(*)::int as count from line_occupancy where occupancy_date = $1::date and line_group_id = $2',
        [DATE, lineGroup.id]
      );
      assert.equal(rows.rows[0].count, 1);
    });

    it('refuses a place already occupied on the same date', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-H');
      const first = await fixtures.insertEmployee();
      const second = await fixtures.insertEmployee();

      await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        userId: first.id
      });

      // Same place, different position — blocked by line_occupancy_place_date_uniq.
      const conflicting = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 2,
        userId: second.id
      });

      assert.equal(conflicting.status, 409);
      assert.match(conflicting.payload.error, /already occupied for this date/i);
    });

    it('allows the same position on a different date', async () => {
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-I');
      const employee = await fixtures.insertEmployee();

      const today = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: DATE,
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        userId: employee.id
      });
      const tomorrow = await postJson(api.baseUrl, '/admin/line-occupancy', {
        occupancyDate: '2026-12-02',
        lineGroupId: lineGroup.id,
        parkingPlaceId: places[0].id,
        position: 1,
        userId: employee.id
      });

      assert.equal(today.status, 201);
      assert.equal(tomorrow.status, 201);
    });
  });

  describe('reading a line', () => {
    it('returns the line ordered by position', async () => {
      const { lineGroup, places } = await lineWithPlaces(3, 'LO-J');
      const front = await fixtures.insertEmployee();
      const middle = await fixtures.insertEmployee();
      const rear = await fixtures.insertEmployee();

      // Fill back-to-front so a passing assertion is about ORDER BY position.
      await fixtures.insertLineOccupancy({
        date: DATE, lineGroupId: lineGroup.id, parkingPlaceId: places[2].id, position: 3, userId: rear.id
      });
      await fixtures.insertLineOccupancy({
        date: DATE, lineGroupId: lineGroup.id, parkingPlaceId: places[0].id, position: 1, userId: front.id
      });
      await fixtures.insertLineOccupancy({
        date: DATE, lineGroupId: lineGroup.id, parkingPlaceId: places[1].id, position: 2, userId: middle.id
      });

      const { status, payload } = await getJson(
        api.baseUrl,
        `/admin/line-groups/${lineGroup.id}/occupancy?date=${DATE}`
      );

      assert.equal(status, 200);
      assert.equal(payload.lineGroup.capacity, 3);
      assert.deepEqual(payload.occupancy.map((row) => row.position), [1, 2, 3]);
      assert.deepEqual(
        payload.occupancy.map((row) => row.user.id),
        [front.id, middle.id, rear.id]
      );
    });

    it('404s for an unknown line group', async () => {
      const { status, payload } = await getJson(
        api.baseUrl,
        `/admin/line-groups/00000000-0000-0000-0000-000000000000/occupancy?date=${DATE}`
      );

      assert.equal(status, 404);
      assert.match(payload.error, /Line group not found/i);
    });
  });

  describe('who is ahead (blocking contacts)', () => {
    it('lists everyone in front, nearest blocker first, and logs the access', async () => {
      const date = '2026-12-05';
      const { lineGroup, places } = await lineWithPlaces(3, 'LO-K');
      const front = await fixtures.insertEmployee({ displayName: 'Первый Первов' });
      const middle = await fixtures.insertEmployee({ displayName: 'Второй Второв' });
      const requester = await fixtures.insertEmployee({ displayName: 'Третий Третьев' });

      await fixtures.insertLineOccupancy({
        date, lineGroupId: lineGroup.id, parkingPlaceId: places[0].id, position: 1, userId: front.id
      });
      await fixtures.insertLineOccupancy({
        date, lineGroupId: lineGroup.id, parkingPlaceId: places[1].id, position: 2, userId: middle.id
      });
      await fixtures.insertLineOccupancy({
        date, lineGroupId: lineGroup.id, parkingPlaceId: places[2].id, position: 3, userId: requester.id
      });

      const { status, payload } = await getJson(
        api.baseUrl,
        `/bot/line/blocking-contacts?requesterUserId=${requester.id}&date=${date}`
      );

      assert.equal(status, 200);
      assert.equal(payload.requesterPosition, 3);
      assert.equal(payload.lineGroup.code, lineGroup.code);
      assert.equal(payload.contacts.length, 2);

      // Nearest blocker first: position 2 before position 1.
      assert.deepEqual(payload.contacts.map((contact) => contact.position), [2, 1]);
      assert.equal(payload.contacts[0].user.id, middle.id);
      assert.equal(payload.contacts[1].user.id, front.id);
      assert.equal(payload.contacts[0].user.displayName, 'Второй Второв');
      assert.ok(payload.contacts[0].user.phone, 'employee contacts expose a phone number');

      // Every disclosure is recorded — one row per blocker.
      const logs = await db.query(
        `select target_user_id, resolution, metadata
         from contact_access_logs
         where requester_user_id = $1 and occupancy_date = $2::date
         order by (metadata->>'blockerPosition')::int desc`,
        [requester.id, date]
      );
      assert.equal(logs.rowCount, 2);
      assert.ok(logs.rows.every((row) => row.resolution === 'employee_contact_shown'));
      assert.equal(logs.rows[0].target_user_id, middle.id);
      assert.equal(logs.rows[1].target_user_id, front.id);
    });

    it('returns no blockers for the car at the front, and logs that too', async () => {
      const date = '2026-12-06';
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-L');
      const front = await fixtures.insertEmployee();
      const rear = await fixtures.insertEmployee();

      await fixtures.insertLineOccupancy({
        date, lineGroupId: lineGroup.id, parkingPlaceId: places[0].id, position: 1, userId: front.id
      });
      await fixtures.insertLineOccupancy({
        date, lineGroupId: lineGroup.id, parkingPlaceId: places[1].id, position: 2, userId: rear.id
      });

      const { status, payload } = await getJson(
        api.baseUrl,
        `/bot/line/blocking-contacts?requesterUserId=${front.id}&date=${date}`
      );

      assert.equal(status, 200);
      assert.equal(payload.requesterPosition, 1);
      assert.deepEqual(payload.contacts, []);

      const logs = await db.query(
        'select resolution, target_user_id from contact_access_logs where requester_user_id = $1 and occupancy_date = $2::date',
        [front.id, date]
      );
      assert.equal(logs.rowCount, 1);
      assert.equal(logs.rows[0].resolution, 'no_blockers');
      assert.equal(logs.rows[0].target_user_id, null);
    });

    it('ignores cars in other line groups on the same date', async () => {
      const date = '2026-12-07';
      const own = await lineWithPlaces(2, 'LO-M');
      const other = await lineWithPlaces(2, 'LO-N');
      const requester = await fixtures.insertEmployee();
      const stranger = await fixtures.insertEmployee();

      await fixtures.insertLineOccupancy({
        date, lineGroupId: own.lineGroup.id, parkingPlaceId: own.places[1].id, position: 2, userId: requester.id
      });
      // Ahead of the requester by position number, but in a different line.
      await fixtures.insertLineOccupancy({
        date, lineGroupId: other.lineGroup.id, parkingPlaceId: other.places[0].id, position: 1, userId: stranger.id
      });

      const { status, payload } = await getJson(
        api.baseUrl,
        `/bot/line/blocking-contacts?requesterUserId=${requester.id}&date=${date}`
      );

      assert.equal(status, 200);
      assert.deepEqual(payload.contacts, [], 'only the requester’s own line can block them');
    });

    it('redacts guest contacts behind the administrator', async () => {
      const date = '2026-12-08';
      const { lineGroup, places } = await lineWithPlaces(2, 'LO-O');
      const host = await fixtures.insertEmployee({ displayName: 'Хостов Хост' });
      const requester = await fixtures.insertEmployee();

      const guestUser = await db.query(
        `insert into users (kind, first_name, last_name, display_name, phone)
         values ('guest', 'Гость', 'Гостев', 'Гостев Гость', '+79005550101')
         returning id`
      );
      const guestRequest = await db.query(
        `insert into guest_parking_requests (guest_user_id, host_user_id, request_date, status, guest_name)
         values ($1, $2, $3::date, 'assigned', 'Гостев Гость')
         returning id`,
        [guestUser.rows[0].id, host.id, date]
      );

      await db.query(
        `insert into line_occupancy (occupancy_date, line_group_id, parking_place_id, position, subject_type, guest_parking_request_id)
         values ($1::date, $2, $3, 1, 'guest', $4)`,
        [date, lineGroup.id, places[0].id, guestRequest.rows[0].id]
      );
      await fixtures.insertLineOccupancy({
        date, lineGroupId: lineGroup.id, parkingPlaceId: places[1].id, position: 2, userId: requester.id
      });

      const { status, payload } = await getJson(
        api.baseUrl,
        `/bot/line/blocking-contacts?requesterUserId=${requester.id}&date=${date}`
      );

      assert.equal(status, 200);
      assert.equal(payload.contacts.length, 1);

      const contact = payload.contacts[0];
      assert.equal(contact.subjectType, 'guest');
      assert.equal(contact.guestName, 'Гостев Гость');
      assert.equal(contact.host.id, host.id);
      assert.equal(contact.user, undefined, 'a guest must not expose a user contact block');
      assert.match(contact.message, /администратору парковки/);

      const logs = await db.query(
        'select resolution, target_guest_parking_request_id from contact_access_logs where requester_user_id = $1 and occupancy_date = $2::date',
        [requester.id, date]
      );
      assert.equal(logs.rows[0].resolution, 'guest_contact_via_admin');
      assert.equal(logs.rows[0].target_guest_parking_request_id, guestRequest.rows[0].id);
    });

    it('404s when the requester is not parked in any line that date', async () => {
      const employee = await fixtures.insertEmployee();

      const { status, payload } = await getJson(
        api.baseUrl,
        `/bot/line/blocking-contacts?requesterUserId=${employee.id}&date=2026-12-09`
      );

      assert.equal(status, 404);
      assert.match(payload.error, /Requester line occupancy was not found/i);
    });

    it('rejects a missing requester or malformed date with 400', async () => {
      const { status, payload } = await getJson(
        api.baseUrl,
        '/bot/line/blocking-contacts?date=09.12.2026'
      );

      assert.equal(status, 400);
      assert.match(payload.error, /requesterUserId and date=YYYY-MM-DD are required/);
    });
  });
});
