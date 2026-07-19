'use strict';

// Task 20 — one integration test walking a full operating day.
//
// Every other integration file exercises one context in isolation: reservations,
// the queue, releases, line occupancy, the jobs, the place inventory. This one
// walks a single day straight through all of them, in the order an operator
// actually meets them, on one scratch schema — from an empty database with no
// places at all to an archived element and a readable audit trail.
//
// That makes it the only test that can fail on the *seams*: a step that hands
// the next one an id, a date or a place it cannot use. The per-context suites
// each build their own preconditions with fixtures, so none of them would
// notice if, say, the catalog import produced lines the queue could not pick
// from, or if the guest allocator ignored a place the release endpoint had just
// handed to the pool. Nothing here is set up by writing SQL directly — every
// precondition is created through the HTTP API, because the seam is the point.
//
// The cases are therefore ORDERED and share state through `day`; each `it` is a
// step of the same day, not an independent scenario. node:test runs the cases in
// a file sequentially, which is what makes that legal.
//
// The day, in one paragraph: the catalog is imported (a triple line 101/102/103
// and two singles on floor 4), a new triple element is added on floor 5, four
// owners and two other employees are created, C releases the rear slot 103 and D
// releases the single 110, an employee request goes through the queue and lands
// on 103 (the queue prefers a triple over a single), that employee takes line
// position 3 and files an early departure, D takes their release back, A releases
// the front slot 101, a guest is auto-assigned to it and is *warned* that it
// blocks the early departure behind it, the guest takes position 1, the blocked
// employee looks up who is ahead of them, and the floor-5 element is archived
// again.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const xlsx = require('xlsx');

const { startApi } = require('../testing/boot-api');
const { addDays, getJson, postJson } = require('../testing/fixtures');
const { createTestDatabase, skipWithoutDatabase } = require('../../../packages/db/testing/harness');
const { currentDateInTimezone } = require('../../../packages/shared/dates');

const execFileAsync = promisify(execFile);

const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Europe/Moscow';
const IMPORT_SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'import', 'parking-catalog.js');

// A release may not be created for a past date, and the 07:00 lock only applies to
// today's departure plans — so the whole day is staged a few days out. Anchoring on
// "today" rather than a literal keeps the file from going stale.
const DAY = addDays(currentDateInTimezone(APP_TIMEZONE), 3);

// The catalog sheet: a title row (the importer reads from row 2), then the header,
// then the places. The position words are the ones the real spreadsheet uses — the
// importer derives the line from them and then throws them away, deriving
// place_type from the resulting capacity instead.
const CATALOG_ROWS = [
  ['Парковочный каталог', '', '', '', ''],
  ['Уровень', 'Место ', 'Статус', 'Дирекция ', 'Кем'],
  ['G4', '101 передний', 'Закреплено', 'ИТ', 'Иванов'],
  ['G4', '102 средний', 'Закреплено', 'ИТ', 'Петров'],
  ['G4', '103 задний', 'Закреплено', 'ИТ', 'Сидоров'],
  ['G4', '110', 'Закреплено', 'Финансы', 'Кузнецов'],
  ['G4', '120', 'Гостевое', 'Финансы', '']
];

function writeCatalogWorkbook(directory) {
  const filePath = path.join(directory, 'parking-catalog.xlsx');
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(CATALOG_ROWS), 'Лист1');
  xlsx.writeFile(workbook, filePath);

  return filePath;
}

describe('end-to-end day (integration)', { skip: skipWithoutDatabase() }, () => {
  let db = null;
  let api = null;
  let workDir = null;

  // Shared state, written by each step and read by the next ones.
  const day = {
    places: new Map(),
    lines: new Map()
  };

  before(async () => {
    db = await createTestDatabase();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-e2e-'));
    api = await startApi({
      databaseUrl: db.connectionString,
      // One place is held back for guests: the queue may hand out everything
      // released except the reserve, which is what makes the pool exactly one
      // place wide at the moment the queue runs below.
      env: { GUEST_RESERVE_MINIMUM: '1' }
    });
  });

  after(async () => {
    if (api) {
      await api.stop();
    }
    if (db) {
      await db.drop();
    }
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  /** The place ids the catalog import produced, looked up by code. */
  async function loadPlacesByCode() {
    const { status, payload } = await getJson(api.baseUrl, '/admin/places');
    assert.equal(status, 200);

    for (const place of payload.places) {
      day.places.set(place.code, place);
    }
  }

  async function createEmployee(displayName, department) {
    const { status, payload } = await postJson(api.baseUrl, '/admin/employees', {
      displayName,
      department,
      phone: `+7900${String(1000000 + day.places.size + displayName.length).slice(-7)}`
    });

    assert.equal(status, 201, `employee ${displayName}: ${JSON.stringify(payload)}`);

    return payload.employee;
  }

  async function ownPlace(employee, code) {
    const place = day.places.get(code);
    assert.ok(place, `place ${code} must exist before it can be assigned`);

    const { status, payload } = await postJson(api.baseUrl, '/admin/permanent-assignments', {
      userId: employee.id,
      parkingPlaceId: place.id,
      // Wide enough that the release and the archive blocker check both see it.
      dateFrom: addDays(DAY, -10),
      dateTo: addDays(DAY, 10)
    });

    assert.equal(status, 201, `permanent assignment ${code}: ${JSON.stringify(payload)}`);

    return payload.permanentAssignment;
  }

  async function releasePlace(code) {
    const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases', {
      parkingPlaceId: day.places.get(code).id,
      dateFrom: DAY
    });

    assert.equal(status, 201, `release ${code}: ${JSON.stringify(payload)}`);

    return payload.release;
  }

  /**
   * The system-wide active place count. `/admin/places` filters `deleted_at is null`,
   * so its length is exactly the inventory an added or archived element moves.
   */
  async function activePlaceCount() {
    const { status, payload } = await getJson(api.baseUrl, '/admin/places');
    assert.equal(status, 200);

    return payload.places.length;
  }

  async function auditActions() {
    const result = await db.query('select action from audit_logs');
    return result.rows.map((row) => row.action);
  }

  it('starts from a database with no parking places at all', async () => {
    const { status, payload } = await getJson(api.baseUrl, '/admin/places');

    assert.equal(status, 200);
    assert.deepEqual(payload.places, [], 'the day must begin before the catalog import, not after it');
  });

  it('step 1: imports the parking catalog into lines and places', async () => {
    const catalogPath = writeCatalogWorkbook(workDir);

    const { stdout } = await execFileAsync(process.execPath, [IMPORT_SCRIPT], {
      env: {
        ...process.env,
        DATABASE_URL: db.connectionString,
        CATALOG_XLSX_PATH: catalogPath,
        CATALOG_XLSX_SHEET: 'Лист1'
      }
    });

    assert.match(stdout, /Imported parking places: 5/);

    await loadPlacesByCode();
    assert.deepEqual([...day.places.keys()].sort(), ['101', '102', '103', '110', '120']);

    const { payload } = await getJson(api.baseUrl, '/admin/place-lines?floor=4');
    const byCapacity = payload.lines.reduce((counts, line) => {
      counts[line.capacity] = (counts[line.capacity] || 0) + 1;
      return counts;
    }, {});

    // 101/102/103 are one triple; the two placeless codes are singles of their own.
    assert.deepEqual(byCapacity, { 1: 2, 3: 1 });

    const triple = payload.lines.find((line) => line.capacity === 3);
    assert.deepEqual(
      triple.slots.map((slot) => slot.code),
      ['101', '102', '103'],
      'physical order inside the line comes from code order, not from the spreadsheet wording'
    );
    assert.ok(
      triple.slots.every((slot) => slot.placeType === 'triple'),
      'place_type is derived from the capacity of the line the import landed the place in'
    );

    day.lines.set('triple', triple);

    // The guest classification used to live in the zone geometry; it must survive
    // the import boundary as place_role, or guest allocation loses its pool.
    assert.equal(day.places.get('120').placeRole, 'rotatable');
    assert.equal(day.places.get('101').placeRole, 'regular');
  });

  it('step 2: adds a triple element, which creates three real parking places', async () => {
    const placesBefore = await activePlaceCount();

    const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines', {
      floorLabel: '5',
      capacity: 3,
      slots: [
        { code: '501', title: 'Место 501' },
        { code: '502', title: 'Место 502' },
        { code: '503', title: 'Место 503' }
      ]
    });

    assert.equal(status, 201, JSON.stringify(payload));
    assert.equal(payload.line.capacity, 3);
    assert.deepEqual(
      payload.line.slots.map((slot) => slot.position),
      [1, 2, 3]
    );

    day.lines.set('added', payload.line);

    day.placesAfterAdd = await activePlaceCount();
    assert.equal(
      day.placesAfterAdd,
      placesBefore + 3,
      'adding an element is inventory management: the system-wide place count moves'
    );
  });

  it('step 3: creates the employees and their permanent places', async () => {
    day.ownerA = await createEmployee('Иванов Иван', 'ИТ');
    day.ownerB = await createEmployee('Петров Пётр', 'ИТ');
    day.ownerC = await createEmployee('Сидоров Сидор', 'ИТ');
    day.ownerD = await createEmployee('Кузнецов Кузьма', 'Финансы');
    day.commuter = await createEmployee('Безместнов Борис', 'Логистика');
    day.host = await createEmployee('Хозяев Харитон', 'Продажи');

    await ownPlace(day.ownerA, '101');
    await ownPlace(day.ownerB, '102');
    await ownPlace(day.ownerC, '103');
    await ownPlace(day.ownerD, '110');

    const { payload } = await getJson(api.baseUrl, `/admin/permanent-assignments?date=${DAY}`);
    assert.equal(payload.permanentAssignments.length, 4);

    // The commuter and the host own nothing — the commuter is who the queue serves.
    assert.ok(
      !payload.permanentAssignments.some((assignment) => assignment.user.id === day.commuter.id),
      'the queue candidate must not already own a place'
    );
  });

  it('step 4: two owners release their places for the day', async () => {
    day.releaseC = await releasePlace('103');
    day.releaseD = await releasePlace('110');

    const { payload } = await getJson(api.baseUrl, `/admin/availability?date=${DAY}`);

    assert.equal(payload.availability.releasedPlaces, 2);
    assert.equal(payload.availability.availablePlaces, 2);
    assert.equal(payload.availability.guestReserve.minimum, 1);
    assert.deepEqual(payload.availability.byType, { single: 1, double: 0, triple: 1 });
  });

  it('step 5: an employee files a request and joins the queue', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/employee-parking-requests', {
      userId: day.commuter.id,
      requestDate: DAY,
      notes: 'Нужна машина на весь день'
    });

    assert.equal(status, 201, JSON.stringify(payload));
    assert.equal(payload.request.status, 'queued');
    assert.equal(payload.request.queueEntry.position, 1);

    day.request = payload.request;
  });

  it('step 6: the queue run serves the request and stops at the guest reserve', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/jobs/process-queue', { date: DAY });

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.assignedCount, 1);
    assert.equal(payload.skippedCount, 0);
    assert.equal(payload.assignments[0].user.id, day.commuter.id);
    assert.equal(
      payload.assignments[0].parkingPlace.code,
      '103',
      'the queue prefers a double, then a triple, then a single — 103 over 110'
    );
    assert.equal(payload.jobRun.jobName, 'process_queue');
    assert.equal(payload.jobRun.status, 'success');

    day.commuterReservation = payload.assignments[0];

    // The request the run answered is closed, so a re-run has nothing to do —
    // this is the seam that used to 409 the whole batch (Task 7).
    const requests = await getJson(api.baseUrl, `/admin/employee-parking-requests?date=${DAY}`);
    const served = requests.payload.requests.find((entry) => entry.id === day.request.id);
    assert.equal(served.status, 'assigned');

    const rerun = await postJson(api.baseUrl, '/admin/jobs/process-queue', { date: DAY });
    assert.equal(rerun.status, 200);
    assert.equal(rerun.payload.assignedCount, 0);
    assert.equal(rerun.payload.skippedCount, 0);

    // One place taken, one still released: exactly the guest reserve.
    const { payload: availability } = await getJson(api.baseUrl, `/admin/availability?date=${DAY}`);
    assert.equal(availability.availability.availablePlaces, 1);
  });

  it('step 7: the served employee takes their line position and plans an early departure', async () => {
    const occupancy = await postJson(api.baseUrl, '/admin/line-occupancy', {
      occupancyDate: DAY,
      lineGroupId: day.lines.get('triple').lineId,
      parkingPlaceId: day.places.get('103').id,
      position: 3,
      userId: day.commuter.id
    });

    assert.equal(occupancy.status, 201, JSON.stringify(occupancy.payload));

    // The owner of the middle slot is at work in their own place.
    const middle = await postJson(api.baseUrl, '/admin/line-occupancy', {
      occupancyDate: DAY,
      lineGroupId: day.lines.get('triple').lineId,
      parkingPlaceId: day.places.get('102').id,
      position: 2,
      userId: day.ownerB.id
    });

    assert.equal(middle.status, 201, JSON.stringify(middle.payload));

    const plan = await postJson(api.baseUrl, '/admin/departure-plans', {
      userId: day.commuter.id,
      planDate: DAY,
      departureTime: '16:30'
    });

    assert.equal(plan.status, 200, JSON.stringify(plan.payload));
    assert.equal(plan.payload.departurePlan.isEarly, true, '16:30 is before the 18:00 cut-off');
  });

  it('step 8: an owner takes their release back, leaving one place in the pool', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/place-releases/cancel', {
      releaseId: day.releaseD.id
    });

    assert.equal(status, 200, JSON.stringify(payload));

    const { payload: availability } = await getJson(api.baseUrl, `/admin/availability?date=${DAY}`);
    assert.equal(availability.availability.releasedPlaces, 1, 'the withdrawn release leaves the pool');
    assert.equal(availability.availability.availablePlaces, 0);
  });

  it('step 9: the front slot is released and a guest is assigned to it — with a warning', async () => {
    day.releaseA = await releasePlace('101');

    const { status, payload } = await postJson(api.baseUrl, '/admin/guest-parking-requests', {
      hostUserId: day.host.id,
      requestDate: DAY,
      guestName: 'Гостев Гость',
      guestPhone: '+79001234567',
      vehiclePlateNumber: 'А123ВС777'
    });

    assert.equal(status, 201, JSON.stringify(payload));
    assert.equal(payload.request.status, 'assigned');
    assert.equal(
      payload.request.assignedReservation.parkingPlace.code,
      '101',
      'the only released and unreserved place is the front slot of the triple'
    );

    // Parking in front of someone who leaves at 16:30 is a warning, not a refusal.
    assert.equal(payload.warnings.length, 1, JSON.stringify(payload.warnings));
    assert.match(JSON.stringify(payload.warnings), /16:30/);

    day.guestRequest = payload.request;

    // The warning is not only shown, it is recorded — the operator can prove later
    // that the conflict was visible at the moment of assignment.
    const audited = await db.query(
      `select metadata from audit_logs
       where action = 'guest_parking_request_created_and_assigned'`
    );
    assert.equal(audited.rowCount, 1);
    assert.equal(audited.rows[0].metadata.warnings.length, 1);
  });

  it('step 10: the guest takes the front line position', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/line-occupancy', {
      occupancyDate: DAY,
      lineGroupId: day.lines.get('triple').lineId,
      parkingPlaceId: day.places.get('101').id,
      position: 1,
      subjectType: 'guest',
      guestParkingRequestId: day.guestRequest.id
    });

    assert.equal(status, 201, JSON.stringify(payload));

    const { payload: line } = await getJson(api.baseUrl, `/admin/line-occupancy?date=${DAY}`);
    assert.deepEqual(
      line.occupancy.map((entry) => entry.position).sort(),
      [1, 2, 3],
      'all three slots of the triple are occupied for the day'
    );
  });

  it('step 11: the blocked employee sees who is ahead of them, nearest first', async () => {
    const { status, payload } = await getJson(
      api.baseUrl,
      `/bot/line/blocking-contacts?requesterUserId=${day.commuter.id}&date=${DAY}`
    );

    assert.equal(status, 200, JSON.stringify(payload));
    assert.equal(payload.requesterPosition, 3);
    assert.deepEqual(
      payload.contacts.map((contact) => contact.position),
      [2, 1],
      'nearest blocker first'
    );

    assert.equal(payload.contacts[0].subjectType, 'employee');
    assert.equal(payload.contacts[0].user.id, day.ownerB.id);
    assert.ok(payload.contacts[0].user.phone, 'an employee blocker exposes a phone number');

    // A guest is never handed out directly — the operator mediates.
    assert.equal(payload.contacts[1].subjectType, 'guest');
    assert.equal(payload.contacts[1].user, undefined);
    assert.equal(payload.contacts[1].host.id, day.host.id);

    const logs = await db.query(
      `select resolution from contact_access_logs
       where requester_user_id = $1 and occupancy_date = $2::date
       order by resolution`,
      [day.commuter.id, DAY]
    );
    assert.deepEqual(
      logs.rows.map((row) => row.resolution),
      ['employee_contact_shown', 'guest_contact_via_admin'],
      'every disclosure is recorded, one row per blocker'
    );
  });

  it('step 12: archives the added element, and the place count comes back down', async () => {
    const line = day.lines.get('added');

    const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines/archive', {
      lineId: line.lineId
    });

    assert.equal(status, 200, JSON.stringify(payload));

    assert.equal(
      await activePlaceCount(),
      day.placesAfterAdd - 3,
      'archiving an element removes its slots from the system-wide count'
    );

    // Archive is not deletion: the slots are gone from the inventory but their
    // history is still readable.
    const { payload: places } = await getJson(api.baseUrl, '/admin/place-lines?floor=5');
    assert.deepEqual(places.lines, []);

    const history = await getJson(api.baseUrl, `/admin/places/${line.slots[0].placeId}/history`);
    assert.equal(history.status, 200, 'an archived place keeps a readable history');
  });

  it('step 13: refuses to archive a line whose slot is still reserved for the day', async () => {
    const { status, payload } = await postJson(api.baseUrl, '/admin/place-lines/archive', {
      lineId: day.lines.get('triple').lineId
    });

    assert.equal(status, 409, JSON.stringify(payload));
    assert.ok(payload.blockers.length > 0);
    assert.ok(
      payload.blockers.some((blocker) => blocker.placeCode === '101' || blocker.placeCode === '103'),
      'the refusal names the places the operator has to clear first'
    );
  });

  it('step 14: the whole day is readable as one audit trail', async () => {
    const actions = await auditActions();

    // Every step of the day left a record, in the order the operator performed it.
    for (const action of [
      'parking_catalog_imported',
      'place_line_created',
      'employee_created',
      'permanent_assignment_created',
      'place_release_created',
      'employee_parking_request_created',
      'queue_processed',
      'line_position_set',
      'place_release_canceled',
      'guest_parking_request_created_and_assigned',
      'place_line_archived'
    ]) {
      assert.ok(actions.includes(action), `the day's audit trail must contain ${action}`);
    }

    // The refused archive rolled back and left nothing behind it.
    assert.equal(
      actions.filter((action) => action === 'place_line_archived').length,
      1,
      'the archive refused in step 13 must not have been audited'
    );

    const { status, payload } = await getJson(api.baseUrl, '/admin/audit-logs?limit=100');
    assert.equal(status, 200);
    assert.ok(payload.auditLogs.length > 0, 'the journal endpoint serves the same trail to the operator');
  });
});
