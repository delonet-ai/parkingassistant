'use strict';

// A fixture page model for the render smoke tests.
//
// This is the shape the GET / route builds and hands to renderPage(): one `{ ok, status,
// data }` envelope per API call plus the query-string state. Because the renderers are
// now pure, a test can build this by hand and call a page directly — no child process,
// no stub HTTP server, no database.
//
// Every free-text field carries an injection probe (`INJECTION`), so a renderer that
// interpolates a value without escapeHtml() fails the escaping assertion rather than
// silently shipping an XSS.

const INJECTION = '<script>alert("xss")</script>';

const DATE = '2026-07-19';
const PLACE_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PLACE_ID = '11111111-1111-4111-8111-111111111112';
const LINE_ID = '22222222-2222-4222-8222-222222222221';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333331';
const RELEASE_ID = '44444444-4444-4444-8444-444444444441';
const RESERVATION_ID = '55555555-5555-4555-8555-555555555551';
const REQUEST_ID = '77777777-7777-4777-8777-777777777771';
const GUEST_REQUEST_ID = '88888888-8888-4888-8888-888888888881';
const ASSIGNMENT_ID = '99999999-9999-4999-8999-999999999991';

/** Wraps a payload the way api-client.fetchJson() does. */
function ok(data) {
  return { ok: true, status: 200, data };
}

const lineGroup = { id: LINE_ID, code: 'L-118', name: `Линия ${INJECTION}`, capacity: 2 };

const places = [
  {
    id: PLACE_ID,
    code: 'G4-118',
    title: `Место ${INJECTION}`,
    placeType: 'double',
    floorLabel: '4',
    placeRole: 'regular',
    isActive: true,
    linePositionHint: 1,
    guestPriorityRank: 2,
    lineGroup,
    permanentOwner: { id: EMPLOYEE_ID, displayName: `Иванов ${INJECTION}` }
  },
  {
    id: SECOND_PLACE_ID,
    code: 'G4-119',
    title: 'G4-119',
    placeType: 'double',
    floorLabel: '4',
    placeRole: 'blocked',
    isActive: true,
    linePositionHint: 2,
    guestPriorityRank: null,
    lineGroup,
    permanentOwner: null
  }
];

const employees = [
  {
    id: EMPLOYEE_ID,
    displayName: `Иванов ${INJECTION}`,
    department: `ИТ ${INJECTION}`,
    email: 'ivanov@example.com',
    phone: '+79000000001',
    isActive: true,
    permanentPlace: { id: PLACE_ID, code: 'G4-118' }
  }
];

/**
 * @param {object} [overrides] merged over the base model, so a test can vary one tab's
 *   data without restating the other eighteen envelopes.
 */
function buildPageModel(overrides = {}) {
  return {
    health: ok({ status: 'ok', service: 'api' }),
    db: ok({ status: 'ok', database: { status: 'ok' } }),
    bootstrap: ok({ status: 'ok', bootstrapUser: { login: `admin ${INJECTION}`, authStatus: 'active' } }),
    places: ok({ status: 'ok', places }),
    employees: ok({ status: 'ok', employees }),
    permanentAssignments: ok({
      status: 'ok',
      permanentAssignments: [
        {
          id: ASSIGNMENT_ID,
          status: 'active',
          dateFrom: DATE,
          dateTo: null,
          notes: `Закрепление ${INJECTION}`,
          user: employees[0],
          parkingPlace: places[0]
        }
      ]
    }),
    dashboard: ok({
      status: 'ok',
      date: DATE,
      totals: { totalPlaces: 5, releasedPlaces: 1, reservations: 1 },
      releasedPlaces: [
        {
          releaseId: RELEASE_ID,
          releaseNotes: `Отпуск ${INJECTION}`,
          isReserved: false,
          owner: employees[0],
          parkingPlace: places[0]
        }
      ],
      reservations: [
        {
          id: RESERVATION_ID,
          reservationDate: DATE,
          source: 'manual',
          reason: `Причина ${INJECTION}`,
          createdAt: '2026-07-19T08:00:00.000Z',
          user: employees[0],
          parkingPlace: places[0]
        }
      ],
      guestRequests: [],
      guestReserve: { minimum: 5, availablePlaces: 3, status: 'low' }
    }),
    employeeRequests: ok({
      status: 'ok',
      requests: [
        {
          id: REQUEST_ID,
          requestDate: DATE,
          status: 'queued',
          queuePosition: 1,
          createdAt: '2026-07-19T07:00:00.000Z',
          notes: `Заявка ${INJECTION}`,
          user: employees[0]
        }
      ]
    }),
    guestRequests: ok({
      status: 'ok',
      requests: [
        {
          id: GUEST_REQUEST_ID,
          requestDate: DATE,
          status: 'pending',
          guestName: `Гость ${INJECTION}`,
          guestPhone: '+79000000002',
          carPlate: `A001AA ${INJECTION}`,
          notes: null,
          host: employees[0],
          parkingPlace: null
        }
      ]
    }),
    jobRuns: ok({
      status: 'ok',
      runs: [
        {
          id: 'job-run-1',
          jobName: 'process_queue',
          targetDate: DATE,
          status: 'succeeded',
          startedAt: '2026-07-19T05:00:00.000Z',
          finishedAt: '2026-07-19T05:00:01.000Z',
          summary: { assigned: 1, skipped: 0, note: INJECTION },
          errorMessage: null
        }
      ]
    }),
    lineGroups: ok({
      status: 'ok',
      lineGroups: [
        {
          ...lineGroup,
          floorLabel: '4',
          places: [
            { id: PLACE_ID, code: 'G4-118', positionHint: 1 },
            { id: SECOND_PLACE_ID, code: 'G4-119', positionHint: 2 }
          ]
        }
      ]
    }),
    lineOccupancy: ok({
      status: 'ok',
      occupancy: [
        {
          id: 'occupancy-1',
          occupancyDate: DATE,
          position: 1,
          subjectType: 'employee',
          guestParkingRequest: null,
          reservation: { id: RESERVATION_ID, source: 'manual' },
          lineGroup,
          parkingPlace: places[0],
          user: employees[0]
        }
      ]
    }),
    departurePlans: ok({
      status: 'ok',
      plans: [
        {
          id: 'plan-1',
          planDate: DATE,
          departureTime: '17:30',
          isEarly: true,
          user: employees[0],
          lineOccupancy: { position: 2, lineGroup, parkingPlace: places[0] }
        }
      ]
    }),
    conflicts: ok({
      status: 'ok',
      conflicts: [
        {
          type: 'employee_blocks_early_departure',
          severity: 'info',
          lineGroup,
          earlyDeparture: {
            departurePlanId: 'plan-1',
            departureTime: '17:30',
            parkingPlaceCode: 'G4-119',
            position: 2,
            user: employees[0]
          },
          blocker: {
            subjectType: 'employee',
            parkingPlaceCode: 'G4-118',
            position: 1,
            guestParkingRequest: null,
            user: employees[0]
          }
        }
      ]
    }),
    auditLogs: ok({
      status: 'ok',
      auditLogs: [
        {
          id: 'audit-1',
          createdAt: '2026-07-19T09:00:00.000Z',
          actorService: `admin ${INJECTION}`,
          action: 'place_line_created',
          entityType: 'parking_place',
          entityId: PLACE_ID,
          metadata: { note: INJECTION }
        }
      ]
    }),
    contactAccessLogs: ok({
      status: 'ok',
      contactAccessLogs: [
        {
          id: 'contact-1',
          createdAt: '2026-07-19T09:30:00.000Z',
          requester: employees[0],
          targetUser: employees[0],
          targetGuestParkingRequest: null,
          lineGroup,
          resolution: `Контакт выдан ${INJECTION}`,
          metadata: { note: INJECTION }
        }
      ]
    }),
    mapDiagnostics: ok({
      status: 'ok',
      maps: [
        {
          code: 'g4',
          title: 'G4',
          filePath: '/maps/parking-g4.png',
          version: 3,
          sourceChecksum: 'abc123',
          updatedAt: '2026-07-18T10:00:00.000Z'
        }
      ],
      diagnostics: {
        placeWithoutLine: [{ id: PLACE_ID, code: `G4-118 ${INJECTION}` }],
        lineCapacityMismatch: [{ id: LINE_ID, code: `L-118 ${INJECTION}`, capacity: 2, slotCount: 1 }]
      }
    }),
    placeLines: ok({
      status: 'ok',
      lines: [
        {
          lineId: LINE_ID,
          code: `L-118 ${INJECTION}`,
          capacity: 2,
          floorLabel: '4',
          slots: [
            {
              placeId: PLACE_ID,
              code: 'G4-118',
              title: 'G4-118',
              position: 1,
              placeType: 'double',
              placeRole: 'regular',
              guestPriorityRank: 2,
              status: 'occupied',
              userDisplayName: `Сидоров ${INJECTION}`
            },
            {
              placeId: SECOND_PLACE_ID,
              code: 'G4-119',
              title: 'G4-119',
              position: 2,
              placeType: 'double',
              placeRole: 'blocked',
              guestPriorityRank: null,
              status: 'blocked',
              userDisplayName: null
            }
          ]
        }
      ]
    }),
    placeHistory: ok(null),
    employeeHistory: ok(null),
    selectedDate: DATE,
    activeView: 'day',
    selectedPlaceId: null,
    selectedMapCode: 'g4',
    mapStatusFilter: '',
    mapTypeFilter: '',
    assignmentStatusFilter: 'all',
    auditFilters: { entityType: '', action: '', actor: '' },
    notice: null,
    ...overrides
  };
}

/** The history envelopes, which the base model deliberately leaves null. */
function buildPlaceHistory() {
  return ok({
    status: 'ok',
    place: places[0],
    permanentAssignments: [],
    releases: [],
    reservations: [],
    auditLogs: []
  });
}

function buildEmployeeHistory() {
  return ok({
    status: 'ok',
    employee: employees[0],
    permanentAssignments: [],
    releases: [],
    reservations: [],
    requests: [],
    auditLogs: []
  });
}

module.exports = {
  DATE,
  EMPLOYEE_ID,
  INJECTION,
  LINE_ID,
  PLACE_ID,
  buildEmployeeHistory,
  buildPageModel,
  buildPlaceHistory
};
