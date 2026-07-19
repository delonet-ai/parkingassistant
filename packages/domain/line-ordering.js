'use strict';

// Ordering inside a line: positions run front (1) to rear, and whoever stands in a
// lower position blocks everyone behind them. "Who is ahead of me" is the derivation
// the bot's blocking-contacts flow is built on.

const { LINE_CAPACITIES } = require('./line-inventory');

const MIN_LINE_POSITION = 1;
const MAX_LINE_POSITION = Math.max(...LINE_CAPACITIES);

function isValidLinePosition(position) {
  return Number.isInteger(position) && position >= MIN_LINE_POSITION && position <= MAX_LINE_POSITION;
}

/** A line never has more positions than it has slots. */
function isPositionWithinCapacity(position, capacity) {
  return position <= capacity;
}

/** Positions strictly ahead of the requester, nearest blocker first. */
function blockersAhead(occupants, position) {
  return (occupants || [])
    .filter((occupant) => occupant.position < position)
    .sort((a, b) => b.position - a.position);
}

/**
 * A guest's phone number is never handed to an employee — the guest is reachable
 * only through the parking administrator, and the host is named instead.
 */
function blockingContactResolution(subjectType) {
  return subjectType === 'guest' ? 'guest_contact_via_admin' : 'employee_contact_shown';
}

function describeBlockingContact(blocker) {
  if (blocker.subject_type === 'guest') {
    return {
      position: blocker.position,
      subjectType: 'guest',
      guestName: blocker.guest_name,
      message: 'Впереди стоит гость. В экстренном случае напишите администратору парковки.',
      host: blocker.host_user_id
        ? {
            id: blocker.host_user_id,
            displayName: blocker.host_display_name
          }
        : null
    };
  }

  return {
    position: blocker.position,
    subjectType: 'employee',
    user: {
      id: blocker.user_id,
      displayName: blocker.user_display_name,
      department: blocker.user_department,
      email: blocker.user_email,
      phone: blocker.user_phone
    }
  };
}

module.exports = {
  MAX_LINE_POSITION,
  MIN_LINE_POSITION,
  blockersAhead,
  blockingContactResolution,
  describeBlockingContact,
  isPositionWithinCapacity,
  isValidLinePosition
};
