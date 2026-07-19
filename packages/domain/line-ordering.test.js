'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_LINE_POSITION,
  MIN_LINE_POSITION,
  blockersAhead,
  blockingContactResolution,
  describeBlockingContact,
  isPositionWithinCapacity,
  isValidLinePosition
} = require('./line-ordering');

test('positions run 1..3, matching the largest line capacity', () => {
  assert.equal(MIN_LINE_POSITION, 1);
  assert.equal(MAX_LINE_POSITION, 3);
  assert.equal(isValidLinePosition(1), true);
  assert.equal(isValidLinePosition(3), true);
  assert.equal(isValidLinePosition(0), false);
  assert.equal(isValidLinePosition(4), false);
});

test('a non-integer position is not a position', () => {
  assert.equal(isValidLinePosition(1.5), false);
  assert.equal(isValidLinePosition('2'), false);
  assert.equal(isValidLinePosition(NaN), false);
  assert.equal(isValidLinePosition(undefined), false);
});

test('a line never has more positions than slots', () => {
  assert.equal(isPositionWithinCapacity(2, 2), true);
  assert.equal(isPositionWithinCapacity(3, 2), false);
  assert.equal(isPositionWithinCapacity(1, 1), true);
  assert.equal(isPositionWithinCapacity(2, 1), false);
});

test('blockers ahead are the lower positions, nearest first', () => {
  const occupants = [{ position: 1 }, { position: 2 }, { position: 3 }];

  assert.deepEqual(blockersAhead(occupants, 3), [{ position: 2 }, { position: 1 }]);
  assert.deepEqual(blockersAhead(occupants, 2), [{ position: 1 }]);
  assert.deepEqual(blockersAhead(occupants, 1), []);
});

test('nobody is ahead in an empty or missing line', () => {
  assert.deepEqual(blockersAhead([], 3), []);
  assert.deepEqual(blockersAhead(undefined, 3), []);
});

// A guest's phone is never handed to an employee: the guest is reachable only through
// the parking administrator, and the resolution recorded in contact_access_logs says so.
test('a guest blocker resolves through the administrator, an employee directly', () => {
  assert.equal(blockingContactResolution('guest'), 'guest_contact_via_admin');
  assert.equal(blockingContactResolution('employee'), 'employee_contact_shown');
});

test('an employee blocker is described with their contacts', () => {
  assert.deepEqual(
    describeBlockingContact({
      position: 1,
      subject_type: 'employee',
      user_id: 'u1',
      user_display_name: 'Иванов И.',
      user_department: 'IT',
      user_email: 'i@example.com',
      user_phone: '+7000'
    }),
    {
      position: 1,
      subjectType: 'employee',
      user: {
        id: 'u1',
        displayName: 'Иванов И.',
        department: 'IT',
        email: 'i@example.com',
        phone: '+7000'
      }
    }
  );
});

test('a guest blocker is described without a phone, naming the host instead', () => {
  const contact = describeBlockingContact({
    position: 1,
    subject_type: 'guest',
    guest_name: 'Гость',
    guest_phone: '+7999',
    host_user_id: 'u2',
    host_display_name: 'Петров П.'
  });

  assert.deepEqual(contact, {
    position: 1,
    subjectType: 'guest',
    guestName: 'Гость',
    message: 'Впереди стоит гость. В экстренном случае напишите администратору парковки.',
    host: { id: 'u2', displayName: 'Петров П.' }
  });
  assert.equal(JSON.stringify(contact).includes('+7999'), false);
});

test('a guest with no recorded host reports host null rather than a partial object', () => {
  const contact = describeBlockingContact({ position: 2, subject_type: 'guest', guest_name: 'Гость' });

  assert.equal(contact.host, null);
});
