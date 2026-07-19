'use strict';

// Employees context — the `users` rows with `kind = 'employee'` and their reads.

async function listEmployeesWithPermanentPlace(db, date) {
  return db.queryMany(
    `
      select
        u.id,
        u.employee_no,
        u.display_name,
        u.email,
        u.phone,
        u.yandex_messenger_user_id,
        u.department,
        u.is_active,
        u.created_at,
        pp.id as permanent_place_id,
        pp.code as permanent_place_code
      from users u
      left join permanent_assignments pa
        on pa.user_id = u.id
        and pa.valid_during @> $1::date
      left join parking_places pp on pp.id = pa.parking_place_id
      where u.kind = 'employee'
        and u.deleted_at is null
      order by lower(u.display_name)
    `,
    [date]
  );
}

async function insertEmployee(db, { firstName, lastName, displayName, email, phone, department, yandexMessengerUserId }) {
  return db.queryOne(
    `
      insert into users (
        kind,
        first_name,
        last_name,
        display_name,
        email,
        phone,
        department,
        yandex_messenger_user_id
      )
      values (
        'employee',
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
      returning
        id,
        employee_no,
        display_name,
        email,
        phone,
        department,
        yandex_messenger_user_id,
        created_at
    `,
    [firstName, lastName, displayName, email, phone, department, yandexMessengerUserId]
  );
}

async function updateEmployee(
  db,
  { employeeId, firstName, lastName, displayName, email, phone, department, yandexMessengerUserId, isActive }
) {
  return db.queryOne(
    `
      update users
      set
        first_name = $2,
        last_name = $3,
        display_name = $4,
        email = $5,
        phone = $6,
        department = $7,
        yandex_messenger_user_id = $8,
        is_active = $9,
        updated_at = now()
      where id = $1
        and kind = 'employee'
        and deleted_at is null
      returning
        id,
        employee_no,
        display_name,
        email,
        phone,
        department,
        yandex_messenger_user_id,
        is_active,
        updated_at
    `,
    [employeeId, firstName, lastName, displayName, email, phone, department, yandexMessengerUserId, isActive]
  );
}

async function disableEmployee(db, employeeId) {
  return db.queryOne(
    `
      update users
      set
        is_active = false,
        deleted_at = now(),
        updated_at = now()
      where id = $1
        and kind = 'employee'
        and deleted_at is null
      returning id, display_name
    `,
    [employeeId]
  );
}


// The employee-exists check every write path runs before touching a dependent table.
async function findEmployeeById(db, employeeId) {
  return db.queryOne(
    `
      select id, display_name
      from users
      where id = $1
        and kind = 'employee'
        and deleted_at is null
    `,
    [employeeId]
  );
}


async function findEmployeeProfile(db, userId) {
  return db.queryOne(
    `
      select id, employee_no, display_name, email, phone, department, yandex_messenger_user_id, created_at
      from users
      where id = $1
        and kind = 'employee'
        and deleted_at is null
    `,
    [userId]
  );
}

module.exports = {
  disableEmployee,
  findEmployeeById,
  findEmployeeProfile,
  insertEmployee,
  listEmployeesWithPermanentPlace,
  updateEmployee
};
