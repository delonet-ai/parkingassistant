'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const { Pool } = require('pg');

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const databaseUrl = process.env.DATABASE_URL;

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl
    })
  : null;

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function isIsoDate(value) {
  return typeof value === 'string' && isoDatePattern.test(value);
}

async function queryOne(text, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function queryMany(text, params = []) {
  if (!pool) {
    throw new Error('DATABASE_URL is not configured');
  }

  const result = await pool.query(text, params);
  return result.rows;
}

async function handleDbHealth() {
  if (!pool) {
    return {
      ok: false,
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        check: 'db',
        error: 'DATABASE_URL is not configured'
      }
    };
  }

  try {
    const result = await pool.query('select current_database() as database, now() as server_time, 1 as ok');

    return {
      ok: true,
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        check: 'db',
        database: result.rows[0].database,
        serverTime: result.rows[0].server_time
      }
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        check: 'db',
        error: error.message
      }
    };
  }
}

async function handleAuthBootstrapStatus() {
  try {
    const sysadmin = await queryOne(
      `
        select
          au.id,
          au.login,
          au.display_name,
          au.status,
          count(aur.id) filter (where ar.code = 'system_admin') as system_admin_role_count
        from auth_users au
        left join auth_user_roles aur on aur.auth_user_id = au.id
        left join auth_roles ar on ar.id = aur.auth_role_id
        where lower(au.login) = 'sysadmin'
        group by au.id, au.login, au.display_name, au.status
      `
    );

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        check: 'auth-bootstrap',
        bootstrapUserExists: Boolean(sysadmin),
        bootstrapUser: sysadmin
          ? {
              id: sysadmin.id,
              login: sysadmin.login,
              displayName: sysadmin.display_name,
              authStatus: sysadmin.status,
              hasSystemAdminRole: Number(sysadmin.system_admin_role_count) > 0
            }
          : null
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        check: 'auth-bootstrap',
        error: error.message
      }
    };
  }
}

async function handleAdminUsersList() {
  try {
    const users = await queryMany(
      `
        select
          au.id,
          au.login,
          au.display_name,
          au.status,
          au.last_login_at,
          au.created_at,
          coalesce(
            json_agg(
              json_build_object(
                'code', ar.code,
                'name', ar.name
              )
              order by ar.code
            ) filter (where ar.id is not null),
            '[]'::json
          ) as roles
        from auth_users au
        left join auth_user_roles aur on aur.auth_user_id = au.id
        left join auth_roles ar on ar.id = aur.auth_role_id
        where au.deleted_at is null
        group by au.id, au.login, au.display_name, au.status, au.last_login_at, au.created_at
        order by lower(au.login)
      `
    );

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        users: users.map((user) => ({
          id: user.id,
          login: user.login,
          displayName: user.display_name,
          authStatus: user.status,
          lastLoginAt: user.last_login_at,
          createdAt: user.created_at,
          roles: user.roles
        }))
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  }
}

async function handleAdminEmployeesList(searchParams) {
  const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);

  if (!isIsoDate(date)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  try {
    const employees = await queryMany(
      `
        select
          u.id,
          u.employee_no,
          u.display_name,
          u.email,
          u.phone,
          u.yandex_messenger_user_id,
          u.department,
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

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date,
        employees: employees.map((employee) => ({
          id: employee.id,
          employeeNo: employee.employee_no,
          displayName: employee.display_name,
          email: employee.email,
          phone: employee.phone,
          yandexMessengerUserId: employee.yandex_messenger_user_id,
          department: employee.department,
          permanentPlace: employee.permanent_place_id
            ? {
                id: employee.permanent_place_id,
                code: employee.permanent_place_code
              }
            : null,
          createdAt: employee.created_at
        }))
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  }
}

async function handleAdminEmployeeCreate(req) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body must be valid JSON'
      }
    };
  }

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const department = typeof body.department === 'string' ? body.department.trim() || null : null;
  const email = typeof body.email === 'string' ? body.email.trim() || null : null;
  const phone = typeof body.phone === 'string' ? body.phone.trim() || null : null;
  const yandexMessengerUserId =
    typeof body.yandexMessengerUserId === 'string' ? body.yandexMessengerUserId.trim() || null : null;

  if (!displayName) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'displayName is required'
      }
    };
  }

  const nameParts = displayName.split(/\s+/).filter(Boolean);
  const lastName = nameParts[0] || displayName;
  const firstName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : displayName;

  try {
    const employee = await queryOne(
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

    await queryOne(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values (
          'user',
          $1,
          'employee_created',
          'admin-web',
          $2::jsonb
        )
        returning id
      `,
      [
        employee.id,
        JSON.stringify({
          displayName,
          email,
          phone,
          department,
          yandexMessengerUserId
        })
      ]
    );

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        employee: {
          id: employee.id,
          employeeNo: employee.employee_no,
          displayName: employee.display_name,
          email: employee.email,
          phone: employee.phone,
          department: employee.department,
          yandexMessengerUserId: employee.yandex_messenger_user_id,
          createdAt: employee.created_at
        }
      }
    };
  } catch (error) {
    if (error.code === '23505') {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee with the same email or messenger id already exists'
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  }
}

async function handleAdminPlacesList() {
  try {
    const places = await queryMany(
      `
        select
          pp.id,
          pp.code,
          pp.title,
          pp.floor_label,
          pp.place_type,
          pp.guest_priority_rank,
          pp.is_active,
          u.id as owner_user_id,
          u.display_name as owner_display_name,
          u.department as owner_department,
          lg.id as line_group_id,
          lg.code as line_group_code,
          lg.name as line_group_name,
          lg.capacity as line_group_capacity
        from parking_places pp
        left join permanent_assignments pa
          on pa.parking_place_id = pp.id
          and pa.valid_during @> current_date
        left join users u on u.id = pa.user_id
        left join line_groups lg on lg.id = pp.line_group_id
        where pp.deleted_at is null
        order by pp.floor_label nulls last, pp.code
      `
    );

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        places: places.map((place) => ({
          id: place.id,
          code: place.code,
          title: place.title,
          floorLabel: place.floor_label,
          placeType: place.place_type,
          guestPriorityRank: place.guest_priority_rank,
          isActive: place.is_active,
          permanentOwner: place.owner_user_id
            ? {
                id: place.owner_user_id,
                displayName: place.owner_display_name,
                department: place.owner_department
              }
            : null,
          lineGroup: place.line_group_id
            ? {
                id: place.line_group_id,
                code: place.line_group_code,
                name: place.line_group_name,
                capacity: place.line_group_capacity
              }
            : null
        }))
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  }
}

async function handleAdminDashboard(searchParams) {
  const date = searchParams.get('date') || new Date().toISOString().slice(0, 10);

  if (!isIsoDate(date)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  const [releasedPlaces, reservations] = await Promise.all([
    queryMany(
      `
        select
          pr.id as release_id,
          pr.notes as release_notes,
          u.id as owner_user_id,
          u.display_name as owner_display_name,
          u.department as owner_department,
          pp.id as parking_place_id,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.place_type as parking_place_type,
          r.id as reservation_id
        from place_releases pr
        join users u on u.id = pr.user_id
        join parking_places pp on pp.id = pr.parking_place_id
        left join reservations r
          on r.parking_place_id = pp.id
          and r.reservation_date = $1::date
          and r.status = 'active'
        where pr.status = 'active'
          and pr.release_during @> $1::date
        order by pp.code
      `,
      [date]
    ),
    queryMany(
      `
        select
          r.id,
          r.reservation_date,
          r.source,
          r.reason,
          r.created_at,
          u.id as user_id,
          u.display_name as user_display_name,
          u.department as user_department,
          pp.id as parking_place_id,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.place_type as parking_place_type
        from reservations r
        join parking_places pp on pp.id = r.parking_place_id
        left join users u on u.id = r.user_id
        where r.status = 'active'
          and r.reservation_date = $1::date
        order by pp.code
      `,
      [date]
    )
  ]);

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date,
      releasedPlaces: releasedPlaces.map((place) => ({
        releaseId: place.release_id,
        releaseNotes: place.release_notes,
        isReserved: Boolean(place.reservation_id),
        owner: {
          id: place.owner_user_id,
          displayName: place.owner_display_name,
          department: place.owner_department
        },
        parkingPlace: {
          id: place.parking_place_id,
          code: place.parking_place_code,
          title: place.parking_place_title,
          placeType: place.parking_place_type
        }
      })),
      reservations: reservations.map((reservation) => ({
        id: reservation.id,
        reservationDate: reservation.reservation_date,
        source: reservation.source,
        reason: reservation.reason,
        createdAt: reservation.created_at,
        user: reservation.user_id
          ? {
              id: reservation.user_id,
              displayName: reservation.user_display_name,
              department: reservation.user_department
            }
          : null,
        parkingPlace: {
          id: reservation.parking_place_id,
          code: reservation.parking_place_code,
          title: reservation.parking_place_title,
          placeType: reservation.parking_place_type
        }
      }))
    }
  };
}

async function handleAdminPlaceReleasesList(searchParams) {
  const dateFrom = searchParams.get('dateFrom');
  const dateTo = searchParams.get('dateTo');

  if ((dateFrom && !isIsoDate(dateFrom)) || (dateTo && !isIsoDate(dateTo))) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'dateFrom and dateTo must use YYYY-MM-DD format'
      }
    };
  }

  const releases = await queryMany(
    `
      select
        pr.id,
        lower(pr.release_during)::date as date_from,
        (upper(pr.release_during)::date - 1) as date_to,
        pr.status,
        pr.created_via,
        pr.created_at,
        pr.notes,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from place_releases pr
      join users u on u.id = pr.user_id
      join parking_places pp on pp.id = pr.parking_place_id
      where pr.status = 'active'
        and ($1::date is null or pr.release_during && daterange($1::date, ($2::date + 1), '[)'))
      order by lower(pr.release_during), pp.code
    `,
    [dateFrom || null, dateTo || dateFrom || null]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      releases: releases.map((release) => ({
        id: release.id,
        dateFrom: release.date_from,
        dateTo: release.date_to,
        status: release.status,
        createdVia: release.created_via,
        createdAt: release.created_at,
        notes: release.notes,
        user: {
          id: release.user_id,
          displayName: release.user_display_name,
          department: release.user_department
        },
        parkingPlace: {
          id: release.parking_place_id,
          code: release.parking_place_code,
          title: release.parking_place_title,
          placeType: release.parking_place_type
        }
      }))
    }
  };
}

async function handleAdminEmployeeParkingRequestsList(searchParams) {
  const requestDate = searchParams.get('date');

  if (requestDate && !isIsoDate(requestDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  const requests = await queryMany(
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
    [requestDate || null]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      requests: requests.map((request) => ({
        id: request.id,
        requestDate: request.request_date,
        status: request.status,
        requestedAt: request.requested_at,
        canceledAt: request.canceled_at,
        notes: request.notes,
        user: {
          id: request.user_id,
          displayName: request.user_display_name,
          department: request.user_department
        },
        queueEntry: request.queue_entry_id
          ? {
              id: request.queue_entry_id,
              position: request.queue_position,
              status: request.queue_status,
              processedAt: request.processed_at
            }
          : null,
        assignedReservation: request.reservation_id
          ? {
              id: request.reservation_id,
              parkingPlaceCode: request.assigned_place_code
            }
          : null
      }))
    }
  };
}

async function handleAdminEmployeeParkingRequestCreate(req) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body must be valid JSON'
      }
    };
  }

  const userId = body.userId;
  const requestDate = body.requestDate;
  const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

  if (!userId || !isIsoDate(requestDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'userId and requestDate are required; date must use YYYY-MM-DD format'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`employee_queue:${requestDate}`]);

    const employeeResult = await client.query(
      `
        select id, display_name
        from users
        where id = $1
          and kind = 'employee'
          and deleted_at is null
      `,
      [userId]
    );
    const employee = employeeResult.rows[0];

    if (!employee) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee not found'
        }
      };
    }

    const permanentAssignmentResult = await client.query(
      `
        select id
        from permanent_assignments
        where user_id = $1
          and valid_during @> $2::date
        limit 1
      `,
      [userId, requestDate]
    );

    if (permanentAssignmentResult.rows[0]) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee has a permanent parking place for the selected date'
        }
      };
    }

    const requestResult = await client.query(
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
    const parkingRequest = requestResult.rows[0];

    const positionResult = await client.query(
      `
        select coalesce(max(queue_position), 0) + 1 as next_position
        from queue_entries
        where queue_date = $1::date
      `,
      [requestDate]
    );
    const queuePosition = Number(positionResult.rows[0].next_position);

    const queueResult = await client.query(
      `
        insert into queue_entries (
          employee_parking_request_id,
          queue_date,
          queue_position
        )
        values ($1, $2::date, $3)
        returning id, queue_position, status
      `,
      [parkingRequest.id, requestDate, queuePosition]
    );
    const queueEntry = queueResult.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values (
          'employee_parking_request',
          $1,
          'employee_parking_request_created',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        parkingRequest.id,
        JSON.stringify({
          userId,
          userDisplayName: employee.display_name,
          requestDate,
          queueEntryId: queueEntry.id,
          queuePosition
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        request: {
          id: parkingRequest.id,
          requestDate: parkingRequest.request_date,
          status: parkingRequest.status,
          requestedAt: parkingRequest.requested_at,
          user: {
            id: userId,
            displayName: employee.display_name
          },
          queueEntry: {
            id: queueEntry.id,
            position: queueEntry.queue_position,
            status: queueEntry.status
          }
        }
      }
    };
  } catch (error) {
    await client.query('rollback');

    if (error.code === '23505') {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee already has an active request for the selected date'
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  } finally {
    client.release();
  }
}

async function handleAdminEmployeeParkingRequestCancel(req) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body must be valid JSON'
      }
    };
  }

  const requestId = body.requestId;

  if (!requestId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'requestId is required'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const requestResult = await client.query(
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
    const parkingRequest = requestResult.rows[0];

    if (!parkingRequest) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee parking request not found'
        }
      };
    }

    if (parkingRequest.assigned_reservation_id) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Assigned requests cannot be canceled here yet'
        }
      };
    }

    if (parkingRequest.status === 'canceled') {
      await client.query('rollback');
      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          request: {
            id: parkingRequest.id,
            requestDate: parkingRequest.request_date,
            status: parkingRequest.status
          }
        }
      };
    }

    const updateResult = await client.query(
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
    const canceledRequest = updateResult.rows[0];

    await client.query(
      `
        update queue_entries
        set
          status = 'canceled',
          updated_at = now()
        where employee_parking_request_id = $1
          and status = 'waiting'
      `,
      [requestId]
    );

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values (
          'employee_parking_request',
          $1,
          'employee_parking_request_canceled',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        requestId,
        JSON.stringify({
          requestDate: parkingRequest.request_date,
          userDisplayName: parkingRequest.user_display_name
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        request: {
          id: canceledRequest.id,
          requestDate: canceledRequest.request_date,
          status: canceledRequest.status,
          canceledAt: canceledRequest.canceled_at
        }
      }
    };
  } catch (error) {
    await client.query('rollback');

    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  } finally {
    client.release();
  }
}

async function handleAdminManualReservationCreate(req) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body must be valid JSON'
      }
    };
  }

  const userId = body.userId;
  const parkingPlaceId = body.parkingPlaceId;
  const reservationDate = body.reservationDate;
  const reason = typeof body.reason === 'string' ? body.reason.trim() || null : null;

  if (!userId || !parkingPlaceId || !isIsoDate(reservationDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'userId, parkingPlaceId and reservationDate are required; date must use YYYY-MM-DD format'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const releasedPlaceResult = await client.query(
      `
        select
          pr.id as release_id,
          pr.user_id as owner_user_id,
          pp.code as parking_place_code
        from place_releases pr
        join parking_places pp on pp.id = pr.parking_place_id
        where pr.parking_place_id = $1
          and pr.status = 'active'
          and pr.release_during @> $2::date
        limit 1
      `,
      [parkingPlaceId, reservationDate]
    );

    const releasedPlace = releasedPlaceResult.rows[0];
    if (!releasedPlace) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Manual assignment is currently allowed only for places released for the selected date'
        }
      };
    }

    if (releasedPlace.owner_user_id === userId) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Released place owner cannot be manually assigned to the same released place'
        }
      };
    }

    const employeeResult = await client.query(
      `
        select id, display_name
        from users
        where id = $1
          and kind = 'employee'
          and deleted_at is null
      `,
      [userId]
    );

    const employee = employeeResult.rows[0];
    if (!employee) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee not found'
        }
      };
    }

    const reservationResult = await client.query(
      `
        insert into reservations (
          reservation_date,
          parking_place_id,
          user_id,
          source,
          reason
        )
        values (
          $1::date,
          $2,
          $3,
          'manual',
          $4
        )
        returning id, reservation_date, source, status, created_at
      `,
      [reservationDate, parkingPlaceId, userId, reason]
    );

    const reservation = reservationResult.rows[0];

    await client.query(
      `
        insert into reservation_events (
          reservation_id,
          event_type,
          payload,
          source
        )
        values ($1, 'reservation_created', $2::jsonb, 'manual')
      `,
      [
        reservation.id,
        JSON.stringify({
          releaseId: releasedPlace.release_id,
          userId,
          parkingPlaceId,
          reservationDate
        })
      ]
    );

    await client.query(
      `
        insert into parking_movements (
          reservation_id,
          movement_date,
          to_parking_place_id,
          movement_type,
          reason
        )
        values ($1, $2::date, $3, 'manual_reassign', $4)
      `,
      [reservation.id, reservationDate, parkingPlaceId, reason || 'Manual admin assignment']
    );

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values (
          'reservation',
          $1,
          'manual_reservation_created',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        reservation.id,
        JSON.stringify({
          releaseId: releasedPlace.release_id,
          userId,
          userDisplayName: employee.display_name,
          parkingPlaceId,
          parkingPlaceCode: releasedPlace.parking_place_code,
          reservationDate
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        reservation: {
          id: reservation.id,
          reservationDate: reservation.reservation_date,
          source: reservation.source,
          status: reservation.status,
          createdAt: reservation.created_at,
          user: {
            id: userId,
            displayName: employee.display_name
          },
          parkingPlace: {
            id: parkingPlaceId,
            code: releasedPlace.parking_place_code
          }
        }
      }
    };
  } catch (error) {
    await client.query('rollback');

    if (error.code === '23505') {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'This place or employee already has an active reservation for the selected date'
        }
      };
    }

    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  } finally {
    client.release();
  }
}

async function handleAdminPlaceReleaseCreate(req) {
  let body;

  try {
    body = await readJsonBody(req);
  } catch {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Request body must be valid JSON'
      }
    };
  }

  const parkingPlaceId = body.parkingPlaceId;
  const dateFrom = body.dateFrom;
  const dateTo = body.dateTo || dateFrom;
  const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

  if (!parkingPlaceId || !isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'parkingPlaceId, dateFrom and dateTo are required; dates must use YYYY-MM-DD format'
      }
    };
  }

  if (dateTo < dateFrom) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'dateTo must be greater than or equal to dateFrom'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const ownerResult = await client.query(
      `
        select
          pa.user_id,
          u.display_name as user_display_name,
          pp.code as parking_place_code
        from permanent_assignments pa
        join users u on u.id = pa.user_id
        join parking_places pp on pp.id = pa.parking_place_id
        where pa.parking_place_id = $1
          and pa.valid_during @> $2::date
          and pa.valid_during @> $3::date
        order by lower(pa.valid_during) desc
        limit 1
      `,
      [parkingPlaceId, dateFrom, dateTo]
    );

    const owner = ownerResult.rows[0];
    if (!owner) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place has no permanent owner for the selected date range'
        }
      };
    }

    const overlapResult = await client.query(
      `
        select id
        from place_releases
        where parking_place_id = $1
          and status = 'active'
          and release_during && daterange($2::date, ($3::date + 1), '[)')
        limit 1
      `,
      [parkingPlaceId, dateFrom, dateTo]
    );

    if (overlapResult.rows[0]) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place already has an active release overlapping this date range'
        }
      };
    }

    const releaseResult = await client.query(
      `
        insert into place_releases (
          user_id,
          parking_place_id,
          release_during,
          created_via,
          notes
        )
        values (
          $1,
          $2,
          daterange($3::date, ($4::date + 1), '[)'),
          'admin_web',
          $5
        )
        returning
          id,
          lower(release_during)::date as date_from,
          (upper(release_during)::date - 1) as date_to,
          status,
          created_via,
          created_at
      `,
      [owner.user_id, parkingPlaceId, dateFrom, dateTo, notes]
    );

    const release = releaseResult.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values (
          'place_release',
          $1,
          'place_release_created',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        release.id,
        JSON.stringify({
          userId: owner.user_id,
          userDisplayName: owner.user_display_name,
          parkingPlaceId,
          parkingPlaceCode: owner.parking_place_code,
          dateFrom,
          dateTo,
          createdVia: 'admin_web'
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        release: {
          id: release.id,
          dateFrom: release.date_from,
          dateTo: release.date_to,
          status: release.status,
          createdVia: release.created_via,
          createdAt: release.created_at,
          user: {
            id: owner.user_id,
            displayName: owner.user_display_name
          },
          parkingPlace: {
            id: parkingPlaceId,
            code: owner.parking_place_code
          }
        }
      }
    };
  } catch (error) {
    await client.query('rollback');

    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message
      }
    };
  } finally {
    client.release();
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'api',
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt,
      timestamp: new Date().toISOString()
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health/db') {
    const result = await handleDbHealth();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/auth/bootstrap-status') {
    const result = await handleAuthBootstrapStatus();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/users') {
    const result = await handleAdminUsersList();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/employees') {
    const result = await handleAdminEmployeesList(url.searchParams);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employees') {
    const result = await handleAdminEmployeeCreate(req);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/places') {
    const result = await handleAdminPlacesList();
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/dashboard') {
    try {
      const result = await handleAdminDashboard(url.searchParams);
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, 500, {
        status: 'error',
        service: 'api',
        error: error.message
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/place-releases') {
    try {
      const result = await handleAdminPlaceReleasesList(url.searchParams);
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, 500, {
        status: 'error',
        service: 'api',
        error: error.message
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/employee-parking-requests') {
    try {
      const result = await handleAdminEmployeeParkingRequestsList(url.searchParams);
      sendJson(res, result.statusCode, result.payload);
    } catch (error) {
      sendJson(res, 500, {
        status: 'error',
        service: 'api',
        error: error.message
      });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/place-releases') {
    const result = await handleAdminPlaceReleaseCreate(req);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employee-parking-requests') {
    const result = await handleAdminEmployeeParkingRequestCreate(req);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employee-parking-requests/cancel') {
    const result = await handleAdminEmployeeParkingRequestCancel(req);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/reservations/manual') {
    const result = await handleAdminManualReservationCreate(req);
    sendJson(res, result.statusCode, result.payload);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'api',
      message: 'Parking Assistant API is running',
      endpoints: [
        '/health',
        '/health/db',
        '/auth/bootstrap-status',
        '/admin/users',
        '/admin/employees',
        '/admin/places',
        '/admin/dashboard',
        '/admin/place-releases',
        '/admin/employee-parking-requests',
        '/admin/reservations/manual'
      ]
    });
    return;
  }

  sendJson(res, 404, {
    status: 'error',
    error: 'Not found'
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant api listening on port ${port}`);
});

async function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);

  server.close(async () => {
    if (pool) {
      await pool.end();
    }

    process.exit(0);
  });
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
