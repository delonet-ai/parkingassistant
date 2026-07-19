'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyConflict, earlyDepartureBlockingWarnings } = require('./conflicts');

// A guest blocker is a warning because the employee cannot simply ask them to move;
// another employee is only informational.
test('a guest blocker is a warning, an employee blocker is informational', () => {
  assert.deepEqual(classifyConflict('guest'), {
    type: 'guest_blocks_early_departure',
    severity: 'warning'
  });

  assert.deepEqual(classifyConflict('employee'), {
    type: 'employee_blocks_early_departure',
    severity: 'info'
  });
});

test('an unknown subject type is treated as an employee, not dropped', () => {
  assert.deepEqual(classifyConflict(undefined), {
    type: 'employee_blocks_early_departure',
    severity: 'info'
  });
});

test('an assignment warning names the place, the affected user and the time', () => {
  const warnings = earlyDepartureBlockingWarnings({
    placeCode: '120',
    risks: [
      {
        user_id: 'u1',
        display_name: 'Иванов И.',
        departure_time: '16:30:00',
        line_group_code: 'line-4-118',
        parking_place_code: '118',
        position: 1
      }
    ]
  });

  assert.deepEqual(warnings, [
    {
      type: 'early_departure_blocking_risk',
      message: 'Назначение на место 120 может перекрыть ранний выезд Иванов И. в 16:30.',
      lineGroupCode: 'line-4-118',
      assignedParkingPlaceCode: '120',
      affectedUser: { id: 'u1', displayName: 'Иванов И.' },
      affectedParkingPlaceCode: '118',
      affectedPosition: 1,
      departureTime: '16:30'
    }
  ]);
});

test('one warning is raised per affected early departure, in the order given', () => {
  const warnings = earlyDepartureBlockingWarnings({
    placeCode: '120',
    risks: [
      { user_id: 'u1', display_name: 'A', departure_time: '16:00:00', position: 1 },
      { user_id: 'u2', display_name: 'B', departure_time: '17:00:00', position: 2 }
    ]
  });

  assert.deepEqual(warnings.map((warning) => warning.affectedUser.id), ['u1', 'u2']);
  assert.deepEqual(warnings.map((warning) => warning.departureTime), ['16:00', '17:00']);
});

test('no risks means no warnings, not an empty-ish placeholder', () => {
  assert.deepEqual(earlyDepartureBlockingWarnings({ placeCode: '120', risks: [] }), []);
  assert.deepEqual(earlyDepartureBlockingWarnings({ placeCode: '120' }), []);
});
