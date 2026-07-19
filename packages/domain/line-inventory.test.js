'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLACE_ROLES,
  PLACE_STATUSES,
  PLACE_TYPES,
  assignSlotPositions,
  buildLineDefinition,
  derivePlaceStatus,
  describeArchiveBlockers,
  isValidCapacity,
  isValidPlaceType,
  normalizeGuestPriorityRank,
  normalizePlaceRole,
  placeSlotStatus,
  placeTypeForCapacity
} = require('./line-inventory');

test('place type is derived from capacity and nowhere else', () => {
  assert.equal(placeTypeForCapacity(1), 'single');
  assert.equal(placeTypeForCapacity(2), 'double');
  assert.equal(placeTypeForCapacity(3), 'triple');
  assert.equal(placeTypeForCapacity(4), null);
  assert.deepEqual(PLACE_TYPES, ['single', 'double', 'triple']);
});

test('capacity 1..3 is valid and 0 or 4 is not', () => {
  assert.equal(isValidCapacity(1), true);
  assert.equal(isValidCapacity(3), true);
  assert.equal(isValidCapacity(0), false);
  assert.equal(isValidCapacity(4), false);
  assert.equal(isValidCapacity('2'), false);
});

test('isValidPlaceType accepts exactly the derived types', () => {
  assert.equal(isValidPlaceType('double'), true);
  assert.equal(isValidPlaceType('quad'), false);
  assert.equal(isValidPlaceType(undefined), false);
});

test('normalizePlaceRole falls back for an unknown role and honours an explicit fallback', () => {
  assert.deepEqual(PLACE_ROLES, ['regular', 'rotatable', 'blocked']);
  assert.equal(normalizePlaceRole('rotatable'), 'rotatable');
  assert.equal(normalizePlaceRole('nonsense'), 'regular');
  assert.equal(normalizePlaceRole(undefined), 'regular');
  assert.equal(normalizePlaceRole('nonsense', null), null);
});

// null and undefined are genuinely different answers: null means "not in the guest
// pool", undefined means "you sent something that is not a rank" and becomes a 400.
test('an absent guest priority rank is null and a malformed one is undefined', () => {
  assert.equal(normalizeGuestPriorityRank(undefined), null);
  assert.equal(normalizeGuestPriorityRank(null), null);
  assert.equal(normalizeGuestPriorityRank(''), null);
  assert.equal(normalizeGuestPriorityRank(1), 1);
  assert.equal(normalizeGuestPriorityRank('42'), 42);
  assert.equal(normalizeGuestPriorityRank(99), 99);
  assert.equal(normalizeGuestPriorityRank(0), undefined);
  assert.equal(normalizeGuestPriorityRank(100), undefined);
  assert.equal(normalizeGuestPriorityRank(1.5), undefined);
  assert.equal(normalizeGuestPriorityRank('high'), undefined);
});

test('slot positions run front to rear in the order given', () => {
  assert.deepEqual(assignSlotPositions([{ code: 'a' }, { code: 'b' }, { code: 'c' }]), [
    { code: 'a', position: 1 },
    { code: 'b', position: 2 },
    { code: 'c', position: 3 }
  ]);
  assert.deepEqual(assignSlotPositions([]), []);
});

test('status precedence: occupancy beats a release, a release beats the role', () => {
  assert.equal(derivePlaceStatus({ hasReservation: true, hasRelease: true, placeRole: 'blocked' }), 'occupied');
  assert.equal(derivePlaceStatus({ hasReservation: true, reservationSource: 'guest' }), 'guest');
  assert.equal(derivePlaceStatus({ hasRelease: true, placeRole: 'blocked' }), 'released');
  assert.equal(derivePlaceStatus({ placeRole: 'blocked' }), 'blocked');
  assert.equal(derivePlaceStatus({ placeRole: 'rotatable' }), 'rotatable');
  assert.equal(derivePlaceStatus({ placeRole: 'regular' }), 'free');
  assert.equal(derivePlaceStatus(), 'free');
});

test('every derived status is one of the six the legend paints', () => {
  const produced = new Set([
    derivePlaceStatus({ hasReservation: true }),
    derivePlaceStatus({ hasReservation: true, reservationSource: 'guest' }),
    derivePlaceStatus({ hasRelease: true }),
    derivePlaceStatus({ placeRole: 'blocked' }),
    derivePlaceStatus({ placeRole: 'rotatable' }),
    derivePlaceStatus()
  ]);

  assert.deepEqual([...produced].sort(), [...PLACE_STATUSES].sort());
});

test('placeSlotStatus is the same rule over a database row', () => {
  assert.equal(placeSlotStatus({ reservation_id: 'r', reservation_source: 'queue' }), 'occupied');
  assert.equal(placeSlotStatus({ reservation_id: 'r', reservation_source: 'guest' }), 'guest');
  assert.equal(placeSlotStatus({ release_id: 'rel', place_role: 'rotatable' }), 'released');
  assert.equal(placeSlotStatus({ place_role: 'blocked' }), 'blocked');
  assert.equal(placeSlotStatus({ place_role: 'regular' }), 'free');
  assert.equal(placeSlotStatus({}), 'free');
});

test('buildLineDefinition derives code, name, notes, type and positions from capacity', () => {
  const { line, error } = buildLineDefinition({
    floorLabel: '4',
    capacity: 3,
    slots: [{ code: '118' }, { code: '119', title: 'Середина' }, { code: '120' }]
  });

  assert.equal(error, undefined);
  assert.deepEqual(line, {
    floorLabel: '4',
    capacity: 3,
    placeType: 'triple',
    code: 'line-4-118',
    name: 'Линия 4 / 118',
    notes: 'triple element',
    slots: [
      { code: '118', title: '118', placeRole: 'regular', guestPriorityRank: null, position: 1 },
      { code: '119', title: 'Середина', placeRole: 'regular', guestPriorityRank: null, position: 2 },
      { code: '120', title: '120', placeRole: 'regular', guestPriorityRank: null, position: 3 }
    ]
  });
});

test('a single is an element too, with one slot and no special case', () => {
  const { line } = buildLineDefinition({ floorLabel: '3', capacity: 1, slots: [{ code: '7' }] });

  assert.equal(line.capacity, 1);
  assert.equal(line.placeType, 'single');
  assert.equal(line.slots.length, 1);
  assert.equal(line.slots[0].position, 1);
});

test('capacity is a numeric string too, since it arrives from a form', () => {
  const { line } = buildLineDefinition({ floorLabel: '3', capacity: '2', slots: [{ code: 'a' }, { code: 'b' }] });

  assert.equal(line.capacity, 2);
  assert.equal(line.placeType, 'double');
});

test('slot role and guest rank survive into the definition', () => {
  const { line } = buildLineDefinition({
    floorLabel: '5',
    capacity: 1,
    slots: [{ code: 'g1', placeRole: 'rotatable', guestPriorityRank: '3' }]
  });

  assert.equal(line.slots[0].placeRole, 'rotatable');
  assert.equal(line.slots[0].guestPriorityRank, 3);
});

test('a missing floor, a bad capacity and a slot count mismatch are each a 400', () => {
  assert.deepEqual(buildLineDefinition({ capacity: 1, slots: [{ code: 'a' }] }).error, {
    statusCode: 400,
    error: 'floorLabel is required'
  });

  assert.deepEqual(buildLineDefinition({ floorLabel: '4', capacity: 4, slots: [] }).error, {
    statusCode: 400,
    error: 'capacity must be 1, 2 or 3'
  });

  assert.deepEqual(buildLineDefinition({ floorLabel: '4', capacity: 3, slots: [{ code: 'a' }] }).error, {
    statusCode: 400,
    error: 'slots must contain exactly 3 entries to match capacity'
  });
});

test('a slot without a code and a malformed guest rank are each a 400', () => {
  assert.deepEqual(buildLineDefinition({ floorLabel: '4', capacity: 1, slots: [{ code: '   ' }] }).error, {
    statusCode: 400,
    error: 'every slot needs a code'
  });

  assert.deepEqual(
    buildLineDefinition({ floorLabel: '4', capacity: 1, slots: [{ code: 'a', guestPriorityRank: 0 }] }).error,
    { statusCode: 400, error: 'guestPriorityRank must be an integer between 1 and 99' }
  );
});

test('a duplicate code inside one request is a 409 naming the code', () => {
  assert.deepEqual(
    buildLineDefinition({ floorLabel: '4', capacity: 2, slots: [{ code: '11' }, { code: '11' }] }).error,
    { statusCode: 409, error: 'Duplicate place code in request: 11' }
  );
});

test('buildLineDefinition never throws on a hostile body', () => {
  assert.equal(buildLineDefinition({ floorLabel: '4', capacity: 1, slots: 'nope' }).error.statusCode, 400);
  assert.equal(buildLineDefinition({ floorLabel: '4', capacity: 1, slots: [null] }).error.statusCode, 400);
  assert.equal(buildLineDefinition({}).error.statusCode, 400);
});

test('archive blockers are named back with a null display name rather than undefined', () => {
  assert.deepEqual(
    describeArchiveBlockers([
      { blocker_type: 'reservation', place_code: '118', detail: '2026-07-20', user_display_name: 'Иванов И.' },
      { blocker_type: 'permanent_assignment', place_code: '119', detail: 'до 2026-08-01', user_display_name: null }
    ]),
    [
      { type: 'reservation', placeCode: '118', detail: '2026-07-20', userDisplayName: 'Иванов И.' },
      { type: 'permanent_assignment', placeCode: '119', detail: 'до 2026-08-01', userDisplayName: null }
    ]
  );
});

test('no blockers means the line may be archived', () => {
  assert.deepEqual(describeArchiveBlockers([]), []);
  assert.deepEqual(describeArchiveBlockers(undefined), []);
});
