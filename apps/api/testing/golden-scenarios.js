'use strict';

// The endpoint groups the golden harness records, in execution order.
//
// Order is load-bearing: every read group runs against the pristine demo dataset first,
// then the write groups mutate it, then the job group runs last because the five
// scheduled jobs touch releases, plans and the queue at once. Re-ordering the groups
// changes the recorded payloads and requires a deliberate regeneration.
//
// A group is one snapshot file under apps/api/test/golden/.

const { currentDateInZone } = require('./golden');

const TIMEZONE = 'Europe/Moscow';

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildScenarios() {
  const today = currentDateInZone(TIMEZONE);
  const tomorrow = addDays(today, 1);

  // Fresh inventory for the write scenarios lives on a floor the demo dataset does not
  // use, so a write can never collide with a demo code and the read snapshots above stay
  // describable as "the demo dataset, untouched".
  const floor = '9';
  const code = (n) => `G9-${n}`;

  return [
    {
      group: 'health',
      description: 'Service envelopes and the router fall-through.',
      requests: [
        { name: 'GET /health', path: '/health' },
        { name: 'GET /health/db', path: '/health/db' },
        { name: 'GET / (endpoint index)', path: '/' },
        { name: 'GET /auth/bootstrap-status', path: '/auth/bootstrap-status' },
        { name: 'GET /nope (unrouted path)', path: '/nope' },
        { name: 'POST /health (wrong method falls through)', method: 'POST', path: '/health', body: {} }
      ]
    },

    {
      group: 'catalog',
      description: 'Employees, places, line groups and permanent assignments.',
      requests: [
        { name: 'GET /admin/users', path: '/admin/users' },
        {
          name: 'GET /admin/employees',
          path: '/admin/employees',
          capture(payload, refs) {
            for (const employee of payload.employees || []) {
              refs.employeeByNo.set(employee.employeeNo, employee.id);
            }
          }
        },
        { name: 'GET /admin/employees?search=Иванов', path: '/admin/employees?search=%D0%98%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2' },
        {
          name: 'GET /admin/places',
          path: '/admin/places',
          capture(payload, refs) {
            for (const place of payload.places || []) {
              refs.placeByCode.set(place.code, place.id);
            }
          }
        },
        {
          name: 'GET /admin/line-groups',
          path: '/admin/line-groups',
          capture(payload, refs) {
            for (const group of payload.lineGroups || []) {
              refs.lineByCode.set(group.code, group.id);
            }
          }
        },
        { name: 'GET /admin/permanent-assignments', path: '/admin/permanent-assignments' },
        { name: 'GET /admin/permanent-assignments?status=active', path: '/admin/permanent-assignments?status=active' }
      ]
    },

    {
      group: 'inventory',
      description: 'The place-inventory read model behind the Места tab.',
      requests: [
        { name: 'GET /admin/place-lines', path: '/admin/place-lines' },
        { name: 'GET /admin/place-lines?floor=4', path: '/admin/place-lines?floor=4' },
        { name: `GET /admin/place-lines?date=<today+1>`, resolve: () => ({ path: `/admin/place-lines?date=${tomorrow}` }) },
        { name: 'GET /admin/place-lines?floor=nope (empty)', path: '/admin/place-lines?floor=nope' },
        { name: 'GET /admin/map-diagnostics', path: '/admin/map-diagnostics' }
      ]
    },

    {
      group: 'day',
      description: 'The Day tab read model: dashboard, availability, releases, occupancy.',
      requests: [
        { name: 'GET /admin/dashboard', path: '/admin/dashboard' },
        { name: 'GET /admin/availability', path: '/admin/availability' },
        { name: `GET /admin/availability?date=<today+1>`, resolve: () => ({ path: `/admin/availability?date=${tomorrow}` }) },
        { name: 'GET /admin/place-releases', path: '/admin/place-releases' },
        { name: 'GET /admin/line-occupancy', path: '/admin/line-occupancy' },
        {
          name: 'GET /admin/line-groups/:id/occupancy',
          resolve: (refs) => ({ path: `/admin/line-groups/${refs.lineByCode.get('demo-line-4-101')}/occupancy` })
        },
        { name: 'GET /admin/departure-plans', path: '/admin/departure-plans' },
        { name: 'GET /admin/conflicts', path: '/admin/conflicts' },
        {
          name: 'GET /bot/line/blocking-contacts',
          resolve: (refs) => ({
            path: `/bot/line/blocking-contacts?userId=${refs.employeeByNo.get('DEMO-002')}&date=${today}`
          })
        }
      ]
    },

    {
      group: 'requests',
      description: 'Employee and guest parking requests.',
      requests: [
        { name: 'GET /admin/employee-parking-requests', path: '/admin/employee-parking-requests' },
        {
          name: 'GET /admin/guest-parking-requests',
          path: '/admin/guest-parking-requests',
          capture(payload, refs) {
            // The demo dataset holds one guest request that is still waiting for a place.
            // It is the only way to exercise POST /assign on its happy path: creating a
            // guest request auto-assigns it when a place is free, so a freshly created
            // one is already `assigned` by the time /assign could be called.
            const pending = (payload.requests || []).find((request) => request.status === 'active');
            refs.pendingGuestRequestId = pending && pending.id;
          }
        }
      ]
    },

    {
      group: 'history',
      description: 'Per-entity history endpoints.',
      requests: [
        {
          name: 'GET /admin/employees/:id/history',
          resolve: (refs) => ({ path: `/admin/employees/${refs.employeeByNo.get('DEMO-001')}/history` }),
          unordered: ['auditLogs']
        },
        {
          name: 'GET /admin/places/:id/history',
          resolve: (refs) => ({ path: `/admin/places/${refs.placeByCode.get('101')}/history` }),
          unordered: ['auditLogs']
        },
        {
          name: 'GET /admin/employees/:id/history (unknown id)',
          path: '/admin/employees/00000000-0000-0000-0000-000000000000/history'
        },
        {
          // Was a DEFECT pinned by Task 14: an unvalidated id reached Postgres, and the
          // cast error escaped as a 500 quoting the offending value back at the client.
          // Fixed in Task 21 — the id is shape-checked before any query runs.
          name: 'GET /admin/places/:id/history (malformed id is rejected as 400)',
          path: '/admin/places/not-a-uuid/history'
        }
      ]
    },

    {
      group: 'audit',
      description: 'Audit and contact-access journals.',
      requests: [
        {
          name: 'GET /admin/audit-logs?limit=200',
          path: '/admin/audit-logs?limit=200',
          unordered: ['auditLogs']
        },
        {
          name: 'GET /admin/audit-logs?action=parking_place_created',
          path: '/admin/audit-logs?action=parking_place_created&limit=200',
          unordered: ['auditLogs']
        },
        {
          name: 'GET /admin/contact-access-logs',
          path: '/admin/contact-access-logs',
          unordered: ['contactAccessLogs']
        },
        { name: 'GET /admin/jobs/runs (before any job ran)', path: '/admin/jobs/runs' }
      ]
    },

    {
      group: 'validation-errors',
      description:
        'The 400 payloads every write endpoint returns for a missing field, and for an id ' +
        'that is present but not uuid-shaped. The two are deliberately separate answers: ' +
        'a missing field keeps its own "X is required" message, so adding the shape check ' +
        'in Task 21 left every message below untouched.',
      requests: [
        { name: 'POST /admin/employees (no displayName)', method: 'POST', path: '/admin/employees', body: {} },
        { name: 'POST /admin/place-lines (no floorLabel)', method: 'POST', path: '/admin/place-lines', body: { capacity: 1, slots: [] } },
        {
          name: 'POST /admin/place-lines (slot count != capacity)',
          method: 'POST',
          path: '/admin/place-lines',
          body: { floorLabel: '9', capacity: 2, slots: [{ code: 'G9-x', title: 'x' }] }
        },
        {
          name: 'POST /admin/place-lines (bad capacity)',
          method: 'POST',
          path: '/admin/place-lines',
          body: { floorLabel: '9', capacity: 4, slots: [] }
        },
        { name: 'POST /admin/place-lines/archive (no lineId)', method: 'POST', path: '/admin/place-lines/archive', body: {} },
        {
          name: 'POST /admin/place-lines/archive (unknown lineId)',
          method: 'POST',
          path: '/admin/place-lines/archive',
          body: { lineId: '00000000-0000-0000-0000-000000000000' }
        },
        { name: 'POST /admin/reservations/manual (no fields)', method: 'POST', path: '/admin/reservations/manual', body: {} },
        { name: 'POST /admin/reservations/cancel (no reservationId)', method: 'POST', path: '/admin/reservations/cancel', body: {} },
        { name: 'POST /admin/place-releases (no fields)', method: 'POST', path: '/admin/place-releases', body: {} },
        {
          name: 'POST /admin/place-releases (dateFrom in the past)',
          method: 'POST',
          path: '/admin/place-releases',
          resolve: (refs) => ({
            body: {
              parkingPlaceId: refs.placeByCode.get('101'),
              dateFrom: addDays(today, -1)
            }
          })
        },
        { name: 'POST /admin/permanent-assignments (no fields)', method: 'POST', path: '/admin/permanent-assignments', body: {} },
        { name: 'POST /admin/guest-parking-requests (no fields)', method: 'POST', path: '/admin/guest-parking-requests', body: {} },
        { name: 'POST /admin/employee-parking-requests (no fields)', method: 'POST', path: '/admin/employee-parking-requests', body: {} },
        { name: 'POST /admin/line-occupancy (no fields)', method: 'POST', path: '/admin/line-occupancy', body: {} },
        { name: 'POST /admin/departure-plans (no fields)', method: 'POST', path: '/admin/departure-plans', body: {} },

        // Malformed ids. Before Task 21 each of these reached Postgres, which raised 22P02
        // and answered 500 with the offending value quoted back in `error`; on the two
        // endpoints whose handler had no try/catch it was worse than a leak, because the
        // rejection escaped the request listener and took the process down.
        {
          name: 'POST /admin/reservations/cancel (malformed reservationId)',
          method: 'POST',
          path: '/admin/reservations/cancel',
          body: { reservationId: 'not-a-uuid' }
        },
        {
          name: 'POST /admin/employees/disable (malformed employeeId — used to crash the process)',
          method: 'POST',
          path: '/admin/employees/disable',
          body: { employeeId: 'not-a-uuid' }
        },
        {
          name: 'POST /admin/permanent-assignments/end (malformed assignmentId — used to crash the process)',
          method: 'POST',
          path: '/admin/permanent-assignments/end',
          resolve: () => ({ body: { assignmentId: 'not-a-uuid', dateTo: today } })
        },
        {
          name: 'POST /admin/reservations/manual (names every malformed id, not just the first)',
          method: 'POST',
          path: '/admin/reservations/manual',
          resolve: () => ({
            body: { userId: 'nope', parkingPlaceId: 'also-nope', reservationDate: today }
          })
        },
        {
          name: 'POST /admin/place-lines/archive (malformed lineId)',
          method: 'POST',
          path: '/admin/place-lines/archive',
          body: { lineId: "'; drop table parking_places; --" }
        },
        {
          name: 'GET /admin/audit-logs (malformed entityId)',
          path: '/admin/audit-logs?entityId=not-a-uuid'
        },
        {
          name: 'POST /admin/places/update (guestPriorityRank out of smallint range)',
          method: 'POST',
          path: '/admin/places/update',
          resolve: (refs) => ({
            body: {
              placeId: refs.placeByCode.get('101'),
              code: '101',
              title: '101',
              placeType: 'triple',
              guestPriorityRank: 99999
            }
          })
        }
      ]
    },

    {
      group: 'inventory-writes',
      description:
        'Creating and archiving elements, and the archive blockers. Runs after every read group.',
      requests: [
        {
          name: 'POST /admin/employees (create)',
          method: 'POST',
          path: '/admin/employees',
          body: {
            displayName: 'Голдин Голден Голденович',
            department: 'QA',
            email: 'golden@demo.invalid',
            phone: '+7 900 999-00-01'
          },
          capture(payload, refs) {
            refs.goldenEmployeeId = payload.employee && payload.employee.id;
          }
        },
        {
          name: 'POST /admin/place-lines (single)',
          method: 'POST',
          path: '/admin/place-lines',
          body: {
            floorLabel: floor,
            capacity: 1,
            slots: [{ code: code(1), title: 'Голден одинарное', placeRole: 'regular' }]
          },
          capture(payload, refs) {
            refs.singleLineId = payload.line && payload.line.lineId;
          }
        },
        {
          name: 'POST /admin/place-lines (double)',
          method: 'POST',
          path: '/admin/place-lines',
          body: {
            floorLabel: floor,
            capacity: 2,
            slots: [
              { code: code(2), title: 'Голден двойное 1' },
              { code: code(3), title: 'Голден двойное 2' }
            ]
          },
          capture(payload, refs) {
            refs.doubleLineId = payload.line && payload.line.lineId;
            const slots = (payload.line && payload.line.slots) || [];
            refs.doubleFrontPlaceId = slots[0] && slots[0].placeId;
          }
        },
        {
          name: 'POST /admin/place-lines (triple, rotatable with a guest rank)',
          method: 'POST',
          path: '/admin/place-lines',
          body: {
            floorLabel: floor,
            capacity: 3,
            slots: [
              { code: code(4), title: 'Голден тройное 1', placeRole: 'rotatable', guestPriorityRank: 1 },
              { code: code(5), title: 'Голден тройное 2' },
              { code: code(6), title: 'Голден тройное 3', placeRole: 'blocked' }
            ]
          },
          capture(payload, refs) {
            refs.tripleLineId = payload.line && payload.line.lineId;
            const slots = (payload.line && payload.line.slots) || [];
            refs.triplePlaceIds = slots.map((slot) => slot.placeId);
          }
        },
        {
          name: 'POST /admin/place-lines (duplicate code)',
          method: 'POST',
          path: '/admin/place-lines',
          body: {
            floorLabel: floor,
            capacity: 1,
            slots: [{ code: code(1), title: 'Дубликат' }]
          }
        },
        { name: 'GET /admin/place-lines?floor=9 (after create)', path: '/admin/place-lines?floor=9' },
        { name: 'GET /admin/availability (inventory grew)', path: '/admin/availability' },

        // Manual assignment is only allowed onto a place that was released for the date,
        // so the blocker scenarios below have to build the whole chain first:
        // permanent assignment -> release -> reservation.
        {
          name: 'POST /admin/permanent-assignments (owner of the new double)',
          method: 'POST',
          path: '/admin/permanent-assignments',
          resolve: (refs) => ({
            body: {
              userId: refs.goldenEmployeeId,
              parkingPlaceId: refs.doubleFrontPlaceId,
              dateFrom: today,
              notes: 'golden snapshot'
            }
          }),
          capture(payload, refs) {
            refs.doubleAssignmentId = payload.permanentAssignment && payload.permanentAssignment.id;
          }
        },
        {
          name: 'POST /admin/place-releases (owner releases it for today)',
          method: 'POST',
          path: '/admin/place-releases',
          resolve: (refs) => ({
            body: { parkingPlaceId: refs.doubleFrontPlaceId, dateFrom: today, notes: 'golden snapshot' }
          }),
          capture(payload, refs) {
            refs.doubleReleaseId = payload.release && payload.release.id;
          }
        },
        {
          name: 'POST /admin/place-releases (overlapping the first)',
          method: 'POST',
          path: '/admin/place-releases',
          resolve: (refs) => ({ body: { parkingPlaceId: refs.doubleFrontPlaceId, dateFrom: today } })
        },
        { name: 'GET /admin/availability (a released place appeared)', path: '/admin/availability' },
        {
          // The one endpoint that edits a place's attributes. It overwrites the columns it
          // is given rather than coalescing them, so the caller has to resend the ones it
          // is not changing — that shape is part of what this snapshot pins.
          name: 'POST /admin/places/update (place role on the triple rear slot)',
          method: 'POST',
          path: '/admin/places/update',
          resolve: (refs) => ({
            body: {
              placeId: refs.triplePlaceIds[2],
              code: code(6),
              title: 'Голден тройное 3',
              floorLabel: floor,
              placeType: 'triple',
              linePositionHint: 3,
              placeRole: 'regular'
            }
          })
        },
        {
          name: 'POST /admin/employees/update',
          method: 'POST',
          path: '/admin/employees/update',
          resolve: (refs) => ({
            body: {
              employeeId: refs.goldenEmployeeId,
              displayName: 'Голдин Голден Голденович',
              department: 'QA / golden',
              email: 'golden@demo.invalid',
              phone: '+7 900 999-00-01',
              isActive: true
            }
          })
        },
        {
          name: 'POST /admin/reservations/manual (onto the released double)',
          method: 'POST',
          path: '/admin/reservations/manual',
          resolve: (refs) => ({
            body: {
              userId: refs.employeeByNo.get('DEMO-006'),
              parkingPlaceId: refs.doubleFrontPlaceId,
              reservationDate: today,
              reason: 'golden snapshot'
            }
          }),
          capture(payload, refs) {
            refs.goldenReservationId = payload.reservation && payload.reservation.id;
          }
        },
        {
          name: 'POST /admin/place-lines/archive (blocked: reservation + permanent assignment)',
          method: 'POST',
          path: '/admin/place-lines/archive',
          resolve: (refs) => ({ body: { lineId: refs.doubleLineId } })
        },
        {
          name: 'POST /admin/reservations/cancel',
          method: 'POST',
          path: '/admin/reservations/cancel',
          resolve: (refs) => ({ body: { reservationId: refs.goldenReservationId } })
        },
        {
          name: 'POST /admin/place-lines/archive (still blocked: the permanent assignment stands)',
          method: 'POST',
          path: '/admin/place-lines/archive',
          resolve: (refs) => ({ body: { lineId: refs.doubleLineId } })
        },
        {
          name: 'POST /admin/place-lines/archive (single, no blockers)',
          method: 'POST',
          path: '/admin/place-lines/archive',
          resolve: (refs) => ({ body: { lineId: refs.singleLineId } })
        },
        {
          name: 'POST /admin/place-lines/archive (already archived)',
          method: 'POST',
          path: '/admin/place-lines/archive',
          resolve: (refs) => ({ body: { lineId: refs.singleLineId } })
        },
        { name: 'GET /admin/place-lines?floor=9 (after archive)', path: '/admin/place-lines?floor=9' },
        { name: 'GET /admin/availability (inventory shrank back)', path: '/admin/availability' },
        { name: 'GET /admin/map-diagnostics (after archive)', path: '/admin/map-diagnostics' }
      ]
    },

    {
      group: 'operational-writes',
      description: 'Requests, the guest assignment flow, departure plans and the undo paths.',
      requests: [
        {
          name: 'POST /admin/employee-parking-requests (for tomorrow)',
          method: 'POST',
          path: '/admin/employee-parking-requests',
          resolve: (refs) => ({
            body: { userId: refs.employeeByNo.get('DEMO-006'), requestDate: tomorrow, notes: 'golden snapshot' }
          }),
          capture(payload, refs) {
            refs.goldenEmployeeRequestId = payload.request && payload.request.id;
          }
        },
        {
          name: 'POST /admin/employee-parking-requests (duplicate for the same date)',
          method: 'POST',
          path: '/admin/employee-parking-requests',
          resolve: (refs) => ({
            body: { userId: refs.employeeByNo.get('DEMO-006'), requestDate: tomorrow }
          })
        },
        {
          // Creating a guest request assigns a place in the same transaction when one is
          // free — the response carries the reservation and any early-departure warnings.
          name: 'POST /admin/guest-parking-requests (auto-assigns)',
          method: 'POST',
          path: '/admin/guest-parking-requests',
          resolve: (refs) => ({
            body: {
              hostUserId: refs.goldenEmployeeId,
              guestName: 'Голденов Гость',
              guestPhone: '+7 900 999-00-02',
              vehiclePlateNumber: 'А001АА777',
              requestDate: today
            }
          }),
          capture(payload, refs) {
            refs.goldenGuestRequestId = payload.request && payload.request.id;
          }
        },
        {
          name: 'POST /admin/guest-parking-requests/assign (the demo request still waiting)',
          method: 'POST',
          path: '/admin/guest-parking-requests/assign',
          resolve: (refs) => ({ body: { requestId: refs.pendingGuestRequestId } })
        },
        {
          name: 'POST /admin/guest-parking-requests/assign (replay, already assigned)',
          method: 'POST',
          path: '/admin/guest-parking-requests/assign',
          resolve: (refs) => ({ body: { requestId: refs.pendingGuestRequestId } })
        },
        {
          name: 'POST /admin/guest-parking-requests/cancel',
          method: 'POST',
          path: '/admin/guest-parking-requests/cancel',
          resolve: (refs) => ({ body: { requestId: refs.goldenGuestRequestId } })
        },
        {
          name: 'POST /admin/departure-plans',
          method: 'POST',
          path: '/admin/departure-plans',
          resolve: (refs) => ({
            body: { userId: refs.employeeByNo.get('DEMO-001'), planDate: today, departureTime: '15:30' }
          })
        },
        {
          name: 'POST /admin/departure-plans (upsert, same user and date)',
          method: 'POST',
          path: '/admin/departure-plans',
          resolve: (refs) => ({
            body: { userId: refs.employeeByNo.get('DEMO-001'), planDate: today, departureTime: '20:15' }
          })
        },
        {
          name: 'POST /admin/line-occupancy',
          method: 'POST',
          path: '/admin/line-occupancy',
          resolve: (refs) => ({
            body: {
              lineGroupId: refs.lineByCode.get('demo-line-3-201'),
              parkingPlaceId: refs.placeByCode.get('201'),
              userId: refs.employeeByNo.get('DEMO-006'),
              occupancyDate: today,
              position: 1
            }
          })
        },
        {
          name: 'POST /admin/place-releases/cancel (undo the release)',
          method: 'POST',
          path: '/admin/place-releases/cancel',
          resolve: (refs) => ({ body: { releaseId: refs.doubleReleaseId } })
        },
        {
          name: 'POST /admin/permanent-assignments/end',
          method: 'POST',
          path: '/admin/permanent-assignments/end',
          resolve: (refs) => ({ body: { assignmentId: refs.doubleAssignmentId, dateTo: today } })
        },
        {
          name: 'POST /admin/employee-parking-requests/cancel',
          method: 'POST',
          path: '/admin/employee-parking-requests/cancel',
          resolve: (refs) => ({ body: { requestId: refs.goldenEmployeeRequestId } })
        },
        { name: 'GET /admin/dashboard (after the operational writes)', path: '/admin/dashboard' },
        { name: 'GET /admin/conflicts (after the operational writes)', path: '/admin/conflicts' }
      ]
    },

    {
      group: 'jobs',
      description:
        'The five scheduled jobs and their replay. Runs last: each one touches releases, plans and the queue.',
      requests: [
        { name: 'POST /admin/jobs/freeze-next-day', method: 'POST', path: '/admin/jobs/freeze-next-day', body: {} },
        { name: 'POST /admin/jobs/freeze-next-day (replay)', method: 'POST', path: '/admin/jobs/freeze-next-day', body: {} },
        { name: 'POST /admin/jobs/unlock-employee-pool', method: 'POST', path: '/admin/jobs/unlock-employee-pool', body: {} },
        { name: 'POST /admin/jobs/unlock-employee-pool (replay)', method: 'POST', path: '/admin/jobs/unlock-employee-pool', body: {} },
        { name: 'POST /admin/jobs/lock-departure-plans', method: 'POST', path: '/admin/jobs/lock-departure-plans', body: {} },
        { name: 'POST /admin/jobs/lock-departure-plans (replay)', method: 'POST', path: '/admin/jobs/lock-departure-plans', body: {} },
        { name: 'POST /admin/jobs/rebuild-conflicts', method: 'POST', path: '/admin/jobs/rebuild-conflicts', body: {} },
        { name: 'POST /admin/jobs/rebuild-conflicts (replay)', method: 'POST', path: '/admin/jobs/rebuild-conflicts', body: {} },
        { name: 'POST /admin/jobs/process-queue', method: 'POST', path: '/admin/jobs/process-queue', body: {} },
        { name: 'POST /admin/jobs/process-queue (replay)', method: 'POST', path: '/admin/jobs/process-queue', body: {} },
        {
          name: 'GET /admin/jobs/runs (after every job)',
          path: '/admin/jobs/runs',
          unordered: ['runs', 'latestSuccessfulRuns']
        }
      ]
    }
  ];
}

module.exports = { TIMEZONE, addDays, buildScenarios };
