'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { planQueueAssignments } = require('./queue');

function entry(position, userId, extra = {}) {
  return {
    queue_position: position,
    queue_entry_id: `q${position}`,
    request_id: `r${position}`,
    user_id: userId,
    user_display_name: `User ${userId}`,
    ...extra
  };
}

function place(id, ownerUserId = null) {
  return {
    parking_place_id: id,
    parking_place_code: id.toUpperCase(),
    release_id: `rel-${id}`,
    owner_user_id: ownerUserId
  };
}

test('candidates are served in queue order from the places in pick order', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1'), entry(2, 'u2')],
    places: [place('a'), place('b'), place('c')],
    guestReserveMinimum: 0
  });

  assert.deepEqual(
    decisions.map((d) => [d.entry.user_id, d.outcome, d.place?.parking_place_id]),
    [
      ['u1', 'assign', 'a'],
      ['u2', 'assign', 'b']
    ]
  );
});

test('the pool stops at the guest reserve floor and the rest are skipped by reason', () => {
  const { maxEmployeeAssignments, decisions } = planQueueAssignments({
    entries: [entry(1, 'u1'), entry(2, 'u2'), entry(3, 'u3')],
    places: [place('a'), place('b'), place('c')],
    guestReserveMinimum: 2
  });

  assert.equal(maxEmployeeAssignments, 1);
  assert.deepEqual(
    decisions.map((d) => [d.outcome, d.reason]),
    [
      ['assign', undefined],
      ['skip', 'guest_reserve_minimum_reached'],
      ['skip', 'guest_reserve_minimum_reached']
    ]
  );
});

test('a reserve larger than the inventory serves nobody', () => {
  const { maxEmployeeAssignments, decisions } = planQueueAssignments({
    entries: [entry(1, 'u1')],
    places: [place('a')],
    guestReserveMinimum: 5
  });

  assert.equal(maxEmployeeAssignments, 0);
  assert.equal(decisions[0].outcome, 'skip');
  assert.equal(decisions[0].reason, 'guest_reserve_minimum_reached');
});

test('nobody is handed back the place they released themselves', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1')],
    places: [place('own', 'u1'), place('other')],
    guestReserveMinimum: 0
  });

  assert.equal(decisions[0].outcome, 'assign');
  assert.equal(decisions[0].place.parking_place_id, 'other');
});

test('a candidate whose only remaining place is their own is skipped, not stalled', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1')],
    places: [place('own', 'u1')],
    guestReserveMinimum: 0
  });

  assert.deepEqual(decisions.map((d) => [d.outcome, d.reason]), [['skip', 'no_available_released_place']]);
});

test('the place cursor never rewinds: a place skipped for one candidate is gone for the next', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1'), entry(2, 'u2')],
    places: [place('own', 'u1'), place('b')],
    guestReserveMinimum: 0
  });

  assert.deepEqual(
    decisions.map((d) => [d.entry.user_id, d.outcome, d.reason, d.place?.parking_place_id]),
    [
      ['u1', 'assign', undefined, 'b'],
      ['u2', 'skip', 'no_available_released_place', undefined]
    ]
  );
});

// The pool ceiling is checked before the inventory is consulted, so exhausting a
// zero-reserve pool reports 'guest_reserve_minimum_reached' rather than
// 'no_available_released_place'. The latter is reached only when a candidate is still
// inside the pool but every remaining place is their own.
test('a pool exhausted by earlier candidates skips the tail as reserve-limited', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1'), entry(2, 'u2'), entry(3, 'u3')],
    places: [place('a')],
    guestReserveMinimum: 0
  });

  assert.deepEqual(
    decisions.map((d) => [d.outcome, d.reason]),
    [
      ['assign', undefined],
      ['skip', 'guest_reserve_minimum_reached'],
      ['skip', 'guest_reserve_minimum_reached']
    ]
  );
});

// This is the Task 7 defect: a user served manually still holds a queued request. Giving
// them a second place trips reservations_active_user_date_uniq, and because the run is one
// transaction that used to 409 the entire batch — including everyone queued behind them.
test('a candidate who already holds a reservation is closed against it, not assigned again', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1', { existing_reservation_id: 'res-1' }), entry(2, 'u2')],
    places: [place('a')],
    guestReserveMinimum: 0
  });

  assert.deepEqual(decisions[0], {
    entry: decisions[0].entry,
    outcome: 'close',
    reason: 'already_has_reservation',
    reservationId: 'res-1'
  });
  assert.equal(decisions[1].outcome, 'assign');
  assert.equal(decisions[1].place.parking_place_id, 'a');
});

test('closing an already-served candidate consumes neither a place nor a pool slot', () => {
  const { decisions } = planQueueAssignments({
    entries: [entry(1, 'u1', { existing_reservation_id: 'res-1' }), entry(2, 'u2'), entry(3, 'u3')],
    places: [place('a'), place('b')],
    guestReserveMinimum: 1
  });

  assert.deepEqual(
    decisions.map((d) => [d.outcome, d.reason]),
    [
      ['close', 'already_has_reservation'],
      ['assign', undefined],
      ['skip', 'guest_reserve_minimum_reached']
    ]
  );
});

test('an empty queue or an empty inventory is a no-op, not a crash', () => {
  assert.deepEqual(planQueueAssignments({ entries: [], places: [place('a')], guestReserveMinimum: 0 }).decisions, []);
  assert.deepEqual(planQueueAssignments({ guestReserveMinimum: 0 }).decisions, []);

  const { decisions } = planQueueAssignments({ entries: [entry(1, 'u1')], places: [], guestReserveMinimum: 0 });
  assert.deepEqual(decisions.map((d) => [d.outcome, d.reason]), [['skip', 'guest_reserve_minimum_reached']]);
});
