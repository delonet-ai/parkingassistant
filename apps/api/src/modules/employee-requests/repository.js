'use strict';

// Employee requests context — an employee asking for a place on a date. The request is
// the durable record; the queue entry beside it is the ordering. The two always move
// together, which is why closing/reopening happens in one transaction with the queue.

async function listRequestsForDate(db, requestDate) {
  return db.queryMany(
    `
      select
        epr.id,
        epr.request_date,
        epr.status,
        epr.requested_at,
        epr.canceled_at,
        epr.notes,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        qe.id as queue_entry_id,
        qe.queue_position,
        qe.status as queue_status,
        qe.processed_at,
        r.id as reservation_id,
        pp.code as assigned_place_code
      from employee_parking_requests epr
      join users u on u.id = epr.user_id
      left join queue_entries qe on qe.employee_parking_request_id = epr.id
      left join reservations r on r.id = epr.assigned_reservation_id
      left join parking_places pp on pp.id = r.parking_place_id
      where ($1::date is null or epr.request_date = $1::date)
      order by epr.request_date desc, qe.queue_position nulls last, epr.requested_at
    `,
    [requestDate]
  );
}

async function insertRequest(db, { userId, requestDate, notes }) {
  return db.queryOne(
    `
      insert into employee_parking_requests (
        user_id,
        request_date,
        status,
        notes
      )
      values ($1, $2::date, 'queued', $3)
      returning id, request_date, status, requested_at
    `,
    [userId, requestDate, notes]
  );
}

async function findRequestForUpdate(db, requestId) {
  return db.queryOne(
    `
      select
        epr.id,
        epr.request_date,
        epr.status,
        epr.assigned_reservation_id,
        u.display_name as user_display_name
      from employee_parking_requests epr
      join users u on u.id = epr.user_id
      where epr.id = $1
      for update
    `,
    [requestId]
  );
}

async function cancelRequest(db, requestId) {
  return db.queryOne(
    `
      update employee_parking_requests
      set
        status = 'canceled',
        canceled_at = now(),
        updated_at = now()
      where id = $1
      returning id, request_date, status, canceled_at
    `,
    [requestId]
  );
}

async function assignRequest(db, { requestId, reservationId }) {
  return db.queryMany(
    `
      update employee_parking_requests
      set
        status = 'assigned',
        assigned_reservation_id = $1,
        updated_at = now()
      where id = $2
    `,
    [reservationId, requestId]
  );
}

// Serving an employee manually answers whatever request they had open for the date.
// Leaving it 'queued' used to make them a candidate for the next queue run, which then
// tripped the one-reservation-per-user-per-day constraint and failed the whole batch.
async function closeOpenRequestForUserDate(db, { userId, requestDate, reservationId }) {
  return db.queryOne(
    `
      update employee_parking_requests
      set
        status = 'assigned',
        assigned_reservation_id = $1,
        updated_at = now()
      where user_id = $2
        and request_date = $3::date
        and status in ('active', 'queued')
      returning id
    `,
    [reservationId, userId, requestDate]
  );
}

async function reopenAssignedRequest(db, requestId) {
  return db.queryMany(
    `
      update employee_parking_requests
      set
        status = 'queued',
        assigned_reservation_id = null,
        updated_at = now()
      where id = $1
        and status = 'assigned'
    `,
    [requestId]
  );
}

async function listRequestsForUser(db, userId) {
  return db.queryMany(
    `
      select
        epr.id,
        epr.request_date::text as request_date,
        epr.status,
        epr.requested_at,
        epr.canceled_at,
        epr.notes,
        qe.queue_position,
        qe.status as queue_status,
        pp.code as parking_place_code
      from employee_parking_requests epr
      left join queue_entries qe on qe.employee_parking_request_id = epr.id
      left join reservations r on r.id = epr.assigned_reservation_id
      left join parking_places pp on pp.id = r.parking_place_id
      where epr.user_id = $1
      order by epr.request_date desc, epr.created_at desc
      limit 100
    `,
    [userId]
  );
}

module.exports = {
  assignRequest,
  cancelRequest,
  closeOpenRequestForUserDate,
  findRequestForUpdate,
  insertRequest,
  listRequestsForDate,
  listRequestsForUser,
  reopenAssignedRequest
};
