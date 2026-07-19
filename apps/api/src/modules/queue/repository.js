'use strict';

// Queue context — the ordering over employee requests for one date, and the run that
// turns that ordering into reservations. A queue entry mirrors its request's fate, so
// every state change here is paired with one in employee-requests inside a transaction.

// Serializes the whole run for a date, so two concurrent runs cannot hand the same
// released place to two employees.
async function lockQueueForDate(db, queueDate) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`process_queue:${queueDate}`]);
}

async function lockEmployeeQueueForDate(db, requestDate) {
  return db.queryOne('select pg_advisory_xact_lock(hashtext($1))', [`employee_queue:${requestDate}`]);
}

async function nextQueuePosition(db, queueDate) {
  return db.queryOne(
    `
      select coalesce(max(queue_position), 0) + 1 as next_position
      from queue_entries
      where queue_date = $1::date
    `,
    [queueDate]
  );
}

async function insertQueueEntry(db, { employeeParkingRequestId, queueDate, queuePosition }) {
  return db.queryOne(
    `
      insert into queue_entries (
        employee_parking_request_id,
        queue_date,
        queue_position
      )
      values ($1, $2::date, $3)
      returning id, queue_position, status
    `,
    [employeeParkingRequestId, queueDate, queuePosition]
  );
}

// The candidates for a run, in queue order. `existing_reservation_id` is joined in so the
// run can tell "already served" apart from "still waiting" without a second query.
async function listWaitingEntriesForUpdate(db, queueDate) {
  return db.queryMany(
    `
      select
        qe.id as queue_entry_id,
        qe.queue_position,
        epr.id as request_id,
        epr.user_id,
        u.display_name as user_display_name,
        existing.id as existing_reservation_id
      from queue_entries qe
      join employee_parking_requests epr on epr.id = qe.employee_parking_request_id
      join users u on u.id = epr.user_id
      left join reservations existing
        on existing.user_id = epr.user_id
        and existing.reservation_date = $1::date
        and existing.status = 'active'
      where qe.queue_date = $1::date
        and qe.status = 'waiting'
        and epr.status = 'queued'
      order by qe.queue_position
      for update of qe, epr
    `,
    [queueDate]
  );
}

async function assignQueueEntry(db, { queueEntryId, reservationId }) {
  return db.queryMany(
    `
      update queue_entries
      set
        status = 'assigned',
        assigned_reservation_id = $1,
        processed_at = now(),
        updated_at = now()
      where id = $2
    `,
    [reservationId, queueEntryId]
  );
}

async function assignWaitingEntriesForRequest(db, { employeeParkingRequestId, reservationId }) {
  return db.queryMany(
    `
      update queue_entries
      set
        status = 'assigned',
        assigned_reservation_id = $1,
        processed_at = now(),
        updated_at = now()
      where employee_parking_request_id = $2
        and status = 'waiting'
    `,
    [reservationId, employeeParkingRequestId]
  );
}

async function markEntriesSkipped(db, queueEntryIds) {
  return db.queryMany(
    `
      update queue_entries
      set
        status = 'skipped',
        processed_at = now(),
        updated_at = now()
      where id = any($1::uuid[])
        and status = 'waiting'
    `,
    [queueEntryIds]
  );
}

async function cancelWaitingEntriesForRequest(db, employeeParkingRequestId) {
  return db.queryMany(
    `
      update queue_entries
      set
        status = 'canceled',
        updated_at = now()
      where employee_parking_request_id = $1
        and status = 'waiting'
    `,
    [employeeParkingRequestId]
  );
}

async function reopenAssignedEntriesForRequest(db, employeeParkingRequestId) {
  return db.queryMany(
    `
      update queue_entries
      set
        status = 'waiting',
        assigned_reservation_id = null,
        processed_at = null,
        updated_at = now()
      where employee_parking_request_id = $1
        and status = 'assigned'
    `,
    [employeeParkingRequestId]
  );
}

// How many of the waiting employees an employee pool of `employeePoolSize` would serve.
async function summarizeWaitingQueue(db, { queueDate, employeePoolSize }) {
  return db.queryOne(
    `
      select
        count(*)::int as waiting_count,
        count(*) filter (where qe.queue_position <= $2)::int as servable_count
      from queue_entries qe
      join employee_parking_requests epr on epr.id = qe.employee_parking_request_id
      where qe.queue_date = $1::date
        and qe.status = 'waiting'
        and epr.status = 'queued'
    `,
    [queueDate, employeePoolSize]
  );
}

module.exports = {
  assignQueueEntry,
  assignWaitingEntriesForRequest,
  cancelWaitingEntriesForRequest,
  insertQueueEntry,
  listWaitingEntriesForUpdate,
  lockEmployeeQueueForDate,
  lockQueueForDate,
  markEntriesSkipped,
  nextQueuePosition,
  reopenAssignedEntriesForRequest,
  summarizeWaitingQueue
};
