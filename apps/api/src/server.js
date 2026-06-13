'use strict';

const http = require('node:http');
const { Pool } = require('pg');
const { addDaysToIsoDate, currentDateInTimezone, currentTimeInTimezone, formatDateForSql, isEarlyDeparture, isIsoDate, isValidTime } = require('../../../packages/shared/dates');
const { normalizeApiErrorPayload } = require('../../../packages/shared/errors');
const { readJsonBody, sendJson: writeJson } = require('../../../packages/shared/http');
const { createDbRepository } = require('./repositories/db');
const { createApiRouter } = require('./router');
const { mapJobRun } = require('./serializers/job-runs');
const { calculateAvailabilitySnapshot, countAvailableReleasedPlaces } = require('./services/availability');

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const databaseUrl = process.env.DATABASE_URL;
const appTimezone = process.env.APP_TIMEZONE || 'Europe/Moscow';

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl
    })
  : null;

const guestReserveMinimum = Number(process.env.GUEST_RESERVE_MINIMUM || 5);
const dbRepository = createDbRepository(pool);

function sendJson(res, statusCode, payload) {
  writeJson(res, statusCode, normalizeApiErrorPayload(payload, statusCode));
}

function splitDisplayName(displayName) {
  const nameParts = displayName.split(/\s+/).filter(Boolean);
  return {
    lastName: nameParts[0] || displayName,
    firstName: nameParts.length > 1 ? nameParts.slice(1).join(' ') : displayName
  };
}

function normalizeOptionalString(value) {
  return typeof value === 'string' ? value.trim() || null : null;
}

async function withJobRun(jobName, targetDate, runner) {
  const started = await queryOne(
    `
      insert into job_runs (
        job_name,
        target_date,
        status,
        actor_service
      )
      values ($1, $2::date, 'running', 'admin-web')
      returning id, job_name, target_date, status, started_at
    `,
    [jobName, targetDate]
  );

  try {
    const payload = await runner();
    const finished = await queryOne(
      `
        update job_runs
        set
          status = 'success',
          finished_at = now(),
          summary = $1::jsonb
        where id = $2
        returning id, job_name, target_date, status, started_at, finished_at, actor_service, summary, error
      `,
      [JSON.stringify(payload), started.id]
    );

    await queryOne(
      `
        insert into audit_logs (
          entity_type,
          action,
          actor_service,
          metadata
        )
        values ('system', $1, 'admin-web', $2::jsonb)
        returning id
      `,
      [
        `job_${jobName}_success`,
        JSON.stringify({
          jobRunId: started.id,
          jobName,
          targetDate,
          summary: payload
        })
      ]
    );

    return {
      ...payload,
      jobRun: mapJobRun(finished)
    };
  } catch (error) {
    const failed = await queryOne(
      `
        update job_runs
        set
          status = 'failed',
          finished_at = now(),
          error = $1
        where id = $2
        returning id, job_name, target_date, status, started_at, finished_at, actor_service, summary, error
      `,
      [error.message, started.id]
    );

    await queryOne(
      `
        insert into audit_logs (
          entity_type,
          action,
          actor_service,
          metadata
        )
        values ('system', $1, 'admin-web', $2::jsonb)
        returning id
      `,
      [
        `job_${jobName}_failed`,
        JSON.stringify({
          jobRunId: started.id,
          jobName,
          targetDate,
          error: error.message
        })
      ]
    );

    error.jobRun = mapJobRun(failed);
    throw error;
  }
}

async function queryOne(text, params = []) {
  return dbRepository.queryOne(text, params);
}

async function queryMany(text, params = []) {
  return dbRepository.queryMany(text, params);
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
          isActive: employee.is_active,
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

  const { firstName, lastName } = splitDisplayName(displayName);

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

async function handleAdminEmployeeUpdate(req) {
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

  const employeeId = body.employeeId;
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
  const department = normalizeOptionalString(body.department);
  const email = normalizeOptionalString(body.email);
  const phone = normalizeOptionalString(body.phone);
  const yandexMessengerUserId = normalizeOptionalString(body.yandexMessengerUserId);
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

  if (!employeeId || !displayName) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'employeeId and displayName are required'
      }
    };
  }

  const { firstName, lastName } = splitDisplayName(displayName);

  try {
    const employee = await queryOne(
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

    if (!employee) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee not found'
        }
      };
    }

    await queryOne(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('user', $1, 'employee_updated', 'admin-web', $2::jsonb)
        returning id
      `,
      [
        employeeId,
        JSON.stringify({
          displayName,
          email,
          phone,
          department,
          yandexMessengerUserId,
          isActive
        })
      ]
    );

    return {
      statusCode: 200,
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
          isActive: employee.is_active,
          updatedAt: employee.updated_at
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

async function handleAdminEmployeeDisable(req) {
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

  const employeeId = body.employeeId;

  if (!employeeId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'employeeId is required'
      }
    };
  }

  const employee = await queryOne(
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

  if (!employee) {
    return {
      statusCode: 404,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Employee not found'
      }
    };
  }

  await queryOne(
    `
      insert into audit_logs (
        entity_type,
        entity_id,
        action,
        actor_service,
        metadata
      )
      values ('user', $1, 'employee_disabled', 'admin-web', $2::jsonb)
      returning id
    `,
    [
      employeeId,
      JSON.stringify({
        displayName: employee.display_name
      })
    ]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      employee: {
        id: employee.id,
        displayName: employee.display_name
      }
    }
  };
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
          pp.line_position_hint,
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
          linePositionHint: place.line_position_hint,
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

async function handleAdminParkingPlaceCreate(req) {
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

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : code;
  const floorLabel = normalizeOptionalString(body.floorLabel);
  const placeType = body.placeType;
  const lineGroupId = normalizeOptionalString(body.lineGroupId);
  const linePositionHint = body.linePositionHint ? Number(body.linePositionHint) : null;
  const guestPriorityRank = body.guestPriorityRank ? Number(body.guestPriorityRank) : null;
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

  if (!code || !title || !['single', 'double', 'triple'].includes(placeType)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'code, title and placeType(single|double|triple) are required'
      }
    };
  }

  if (linePositionHint !== null && (linePositionHint < 1 || linePositionHint > 3)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'linePositionHint must be between 1 and 3'
      }
    };
  }

  try {
    const place = await queryOne(
      `
        insert into parking_places (
          code,
          title,
          floor_label,
          place_type,
          line_group_id,
          line_position_hint,
          guest_priority_rank,
          is_active,
          catalog_source
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, 'admin-web')
        returning id, code, title, floor_label, place_type, line_group_id, line_position_hint, guest_priority_rank, is_active, created_at
      `,
      [code, title, floorLabel, placeType, lineGroupId, linePositionHint, guestPriorityRank, isActive]
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
        values ('parking_place', $1, 'parking_place_created', 'admin-web', $2::jsonb)
        returning id
      `,
      [
        place.id,
        JSON.stringify({
          code,
          title,
          floorLabel,
          placeType,
          lineGroupId,
          linePositionHint,
          guestPriorityRank,
          isActive
        })
      ]
    );

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        place
      }
    };
  } catch (error) {
    if (error.code === '23505') {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place with the same code already exists'
        }
      };
    }

    if (error.code === '23503') {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Line group not found'
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

async function handleAdminParkingPlaceUpdate(req) {
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

  const placeId = body.placeId;
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const floorLabel = normalizeOptionalString(body.floorLabel);
  const placeType = body.placeType;
  const lineGroupId = normalizeOptionalString(body.lineGroupId);
  const linePositionHint = body.linePositionHint ? Number(body.linePositionHint) : null;
  const guestPriorityRank = body.guestPriorityRank ? Number(body.guestPriorityRank) : null;
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

  if (!placeId || !code || !title || !['single', 'double', 'triple'].includes(placeType)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'placeId, code, title and placeType(single|double|triple) are required'
      }
    };
  }

  if (linePositionHint !== null && (linePositionHint < 1 || linePositionHint > 3)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'linePositionHint must be between 1 and 3'
      }
    };
  }

  try {
    const place = await queryOne(
      `
        update parking_places
        set
          code = $2,
          title = $3,
          floor_label = $4,
          place_type = $5,
          line_group_id = $6,
          line_position_hint = $7,
          guest_priority_rank = $8,
          is_active = $9,
          updated_at = now()
        where id = $1
          and deleted_at is null
        returning id, code, title, floor_label, place_type, line_group_id, line_position_hint, guest_priority_rank, is_active, updated_at
      `,
      [placeId, code, title, floorLabel, placeType, lineGroupId, linePositionHint, guestPriorityRank, isActive]
    );

    if (!place) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place not found'
        }
      };
    }

    await queryOne(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('parking_place', $1, 'parking_place_updated', 'admin-web', $2::jsonb)
        returning id
      `,
      [
        placeId,
        JSON.stringify({
          code,
          title,
          floorLabel,
          placeType,
          lineGroupId,
          linePositionHint,
          guestPriorityRank,
          isActive
        })
      ]
    );

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        place
      }
    };
  } catch (error) {
    if (error.code === '23505') {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place with the same code already exists'
        }
      };
    }

    if (error.code === '23503') {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Line group not found'
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

async function handleAdminParkingPlaceDisable(req) {
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

  const placeId = body.placeId;

  if (!placeId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'placeId is required'
      }
    };
  }

  const place = await queryOne(
    `
      update parking_places
      set
        is_active = false,
        deleted_at = now(),
        updated_at = now()
      where id = $1
        and deleted_at is null
      returning id, code, title
    `,
    [placeId]
  );

  if (!place) {
    return {
      statusCode: 404,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Parking place not found'
      }
    };
  }

  await queryOne(
    `
      insert into audit_logs (
        entity_type,
        entity_id,
        action,
        actor_service,
        metadata
      )
      values ('parking_place', $1, 'parking_place_disabled', 'admin-web', $2::jsonb)
      returning id
    `,
    [
      placeId,
      JSON.stringify({
        code: place.code,
        title: place.title
      })
    ]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      place
    }
  };
}

async function handleAdminPermanentAssignmentsList(searchParams) {
  const date = searchParams.get('date') || currentDateInTimezone(appTimezone);
  const status = searchParams.get('status') || 'all';

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

  if (!['all', 'active', 'future', 'ended'].includes(status)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'status must be one of all, active, future, ended'
      }
    };
  }

  const rows = await queryMany(
    `
      with assignment_statuses as (
        select
          pa.id,
          pa.user_id,
          pa.parking_place_id,
          lower(pa.valid_during)::text as date_from,
          (upper(pa.valid_during) - interval '1 day')::date::text as date_to,
          pa.notes,
          pa.created_at,
          pa.updated_at,
          u.display_name as user_display_name,
          u.department as user_department,
          u.email as user_email,
          u.phone as user_phone,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.floor_label as parking_place_floor_label,
          pp.place_type as parking_place_type,
          case
            when pa.valid_during @> $1::date then 'active'
            when lower(pa.valid_during) > $1::date then 'future'
            else 'ended'
          end as assignment_status
        from permanent_assignments pa
        join users u on u.id = pa.user_id
        join parking_places pp on pp.id = pa.parking_place_id
        where u.deleted_at is null
          and pp.deleted_at is null
      )
      select *
      from assignment_statuses
      where ($2::text = 'all' or assignment_status = $2::text)
      order by
        case assignment_status
          when 'active' then 1
          when 'future' then 2
          else 3
        end,
        date_from desc,
        parking_place_code
    `,
    [date, status]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date,
      filterStatus: status,
      permanentAssignments: rows.map((assignment) => ({
        id: assignment.id,
        dateFrom: assignment.date_from,
        dateTo: assignment.date_to,
        status: assignment.assignment_status,
        notes: assignment.notes,
        createdAt: assignment.created_at,
        updatedAt: assignment.updated_at,
        user: {
          id: assignment.user_id,
          displayName: assignment.user_display_name,
          department: assignment.user_department,
          email: assignment.user_email,
          phone: assignment.user_phone
        },
        parkingPlace: {
          id: assignment.parking_place_id,
          code: assignment.parking_place_code,
          title: assignment.parking_place_title,
          floorLabel: assignment.parking_place_floor_label,
          placeType: assignment.parking_place_type
        }
      }))
    }
  };
}

async function handleAdminPermanentAssignmentCreate(req) {
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
  const dateFrom = body.dateFrom;
  const dateTo = normalizeOptionalString(body.dateTo);
  const notes = normalizeOptionalString(body.notes);

  if (!userId || !parkingPlaceId || !isIsoDate(dateFrom) || (dateTo && !isIsoDate(dateTo))) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'userId, parkingPlaceId, dateFrom and optional dateTo=YYYY-MM-DD are required'
      }
    };
  }

  try {
    const assignment = await queryOne(
      `
        insert into permanent_assignments (
          user_id,
          parking_place_id,
          valid_during,
          notes
        )
        values (
          $1,
          $2,
          daterange($3::date, coalesce(($4::date + interval '1 day')::date, null), '[)'),
          $5
        )
        returning id, user_id, parking_place_id, lower(valid_during)::text as date_from, (upper(valid_during) - interval '1 day')::date::text as date_to, notes, created_at
      `,
      [userId, parkingPlaceId, dateFrom, dateTo, notes]
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
        values ('permanent_assignment', $1, 'permanent_assignment_created', 'admin-web', $2::jsonb)
        returning id
      `,
      [
        assignment.id,
        JSON.stringify({
          userId,
          parkingPlaceId,
          dateFrom,
          dateTo,
          notes
        })
      ]
    );

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        permanentAssignment: assignment
      }
    };
  } catch (error) {
    if (error.code === '23P01') {
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Permanent assignment overlaps existing assignment for this user or place'
        }
      };
    }

    if (error.code === '23503') {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee or parking place not found'
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

async function handleAdminPermanentAssignmentEnd(req) {
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

  const assignmentId = body.assignmentId;
  const dateTo = body.dateTo;

  if (!assignmentId || !isIsoDate(dateTo)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'assignmentId and dateTo=YYYY-MM-DD are required'
      }
    };
  }

  const assignment = await queryOne(
    `
      update permanent_assignments
      set
        valid_during = daterange(lower(valid_during), ($2::date + interval '1 day')::date, '[)'),
        updated_at = now()
      where id = $1
        and lower(valid_during) <= $2::date
      returning id, user_id, parking_place_id, lower(valid_during)::text as date_from, (upper(valid_during) - interval '1 day')::date::text as date_to, updated_at
    `,
    [assignmentId, dateTo]
  );

  if (!assignment) {
    return {
      statusCode: 404,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Permanent assignment not found or dateTo is before assignment start'
      }
    };
  }

  await queryOne(
    `
      insert into audit_logs (
        entity_type,
        entity_id,
        action,
        actor_service,
        metadata
      )
      values ('permanent_assignment', $1, 'permanent_assignment_ended', 'admin-web', $2::jsonb)
      returning id
    `,
    [
      assignmentId,
      JSON.stringify({
        userId: assignment.user_id,
        parkingPlaceId: assignment.parking_place_id,
        dateTo
      })
    ]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      permanentAssignment: assignment
    }
  };
}

function mapLineOccupancy(row) {
  return {
    id: row.occupancy_id,
    occupancyDate: formatDateForSql(row.occupancy_date),
    position: row.position,
    subjectType: row.subject_type,
    createdAt: row.occupancy_created_at,
    updatedAt: row.occupancy_updated_at,
    lineGroup: {
      id: row.line_group_id,
      code: row.line_group_code,
      name: row.line_group_name,
      capacity: row.line_group_capacity
    },
    parkingPlace: {
      id: row.parking_place_id,
      code: row.parking_place_code,
      title: row.parking_place_title,
      placeType: row.parking_place_type
    },
    user: row.user_id
      ? {
          id: row.user_id,
          displayName: row.user_display_name,
          department: row.user_department,
          email: row.user_email,
          phone: row.user_phone
        }
      : null,
    guestParkingRequest: row.guest_parking_request_id
      ? {
          id: row.guest_parking_request_id,
          guestName: row.guest_name,
          guestPhone: row.guest_phone,
          hostUserId: row.host_user_id,
          hostDisplayName: row.host_display_name
        }
      : null,
    reservation: row.reservation_id
      ? {
          id: row.reservation_id,
          source: row.reservation_source
        }
      : null
  };
}

async function handleAdminLineGroupsList() {
  const groups = await queryMany(
    `
      select
        lg.id,
        lg.code,
        lg.name,
        lg.capacity,
        lg.floor_label,
        lg.notes,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'id', pp.id,
              'code', pp.code,
              'title', pp.title,
              'placeType', pp.place_type,
              'positionHint', pp.line_position_hint
            )
            order by pp.line_position_hint nulls last, pp.code
          ) filter (where pp.id is not null),
          '[]'::jsonb
        ) as places
      from line_groups lg
      left join parking_places pp
        on pp.line_group_id = lg.id
        and pp.deleted_at is null
      group by lg.id
      order by lg.floor_label nulls last, lg.code
    `
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      lineGroups: groups.map((group) => ({
        id: group.id,
        code: group.code,
        name: group.name,
        capacity: group.capacity,
        floorLabel: group.floor_label,
        notes: group.notes,
        places: group.places || []
      }))
    }
  };
}

async function getLineOccupancyRows(lineGroupId, occupancyDate) {
  return queryMany(
    `
      select
        lo.id as occupancy_id,
        lo.occupancy_date::text as occupancy_date,
        lo.position,
        lo.subject_type,
        lo.created_at as occupancy_created_at,
        lo.updated_at as occupancy_updated_at,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        lg.capacity as line_group_capacity,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        u.email as user_email,
        u.phone as user_phone,
        gpr.id as guest_parking_request_id,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.host_user_id,
        host.display_name as host_display_name,
        r.id as reservation_id,
        r.source as reservation_source
      from line_occupancy lo
      join line_groups lg on lg.id = lo.line_group_id
      join parking_places pp on pp.id = lo.parking_place_id
      left join users u on u.id = lo.user_id
      left join guest_parking_requests gpr on gpr.id = lo.guest_parking_request_id
      left join users host on host.id = gpr.host_user_id
      left join reservations r on r.id = lo.reservation_id
      where lo.line_group_id = $1
        and lo.occupancy_date = $2::date
      order by lo.position
    `,
    [lineGroupId, occupancyDate]
  );
}

async function handleAdminLineGroupOccupancy(lineGroupId, searchParams) {
  const occupancyDate = searchParams.get('date') || currentDateInTimezone(appTimezone);

  if (!lineGroupId || !isIsoDate(occupancyDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'line group id and date=YYYY-MM-DD are required'
      }
    };
  }

  const lineGroup = await queryOne('select id, code, name, capacity, floor_label from line_groups where id = $1', [lineGroupId]);

  if (!lineGroup) {
    return {
      statusCode: 404,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Line group not found'
      }
    };
  }

  const rows = await getLineOccupancyRows(lineGroupId, occupancyDate);

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date: occupancyDate,
      lineGroup: {
        id: lineGroup.id,
        code: lineGroup.code,
        name: lineGroup.name,
        capacity: lineGroup.capacity,
        floorLabel: lineGroup.floor_label
      },
      occupancy: rows.map(mapLineOccupancy)
    }
  };
}

async function handleLineOccupancySet(req, actorService = 'admin-web') {
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

  const occupancyDate = body.occupancyDate || body.date;
  const lineGroupId = body.lineGroupId;
  const parkingPlaceId = body.parkingPlaceId;
  const position = Number(body.position);
  const subjectType = body.subjectType || 'employee';
  const userId = body.userId || null;
  const guestParkingRequestId = body.guestParkingRequestId || null;

  if (!isIsoDate(occupancyDate) || !lineGroupId || !parkingPlaceId || !Number.isInteger(position) || position < 1 || position > 3) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'occupancyDate, lineGroupId, parkingPlaceId and position 1..3 are required'
      }
    };
  }

  if ((subjectType === 'employee' && !userId) || (subjectType === 'guest' && !guestParkingRequestId) || !['employee', 'guest'].includes(subjectType)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'employee occupancy requires userId; guest occupancy requires guestParkingRequestId'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`line_occupancy:${occupancyDate}:${lineGroupId}`]);

    const placeResult = await client.query(
      `
        select
          pp.id,
          pp.code,
          pp.title,
          pp.line_group_id,
          lg.capacity
        from parking_places pp
        join line_groups lg on lg.id = pp.line_group_id
        where pp.id = $1
          and pp.line_group_id = $2
          and pp.deleted_at is null
        for update of pp
      `,
      [parkingPlaceId, lineGroupId]
    );
    const place = placeResult.rows[0];

    if (!place) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place is not attached to the selected line group'
        }
      };
    }

    if (position > place.capacity) {
      await client.query('rollback');
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: `Position ${position} exceeds line capacity ${place.capacity}`
        }
      };
    }

    const warnings = await calculateAssignmentWarnings(client, requestDate, place.parking_place_id);

    const reservationResult = await client.query(
      `
        select id, user_id, guest_parking_request_id, source
        from reservations
        where parking_place_id = $1
          and reservation_date = $2::date
          and status = 'active'
        limit 1
      `,
      [parkingPlaceId, occupancyDate]
    );
    const reservation = reservationResult.rows[0] || null;

    if (reservation && subjectType === 'employee' && reservation.user_id && reservation.user_id !== userId) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Active reservation on this place belongs to another user'
        }
      };
    }

    if (reservation && subjectType === 'guest' && reservation.guest_parking_request_id && reservation.guest_parking_request_id !== guestParkingRequestId) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Active reservation on this place belongs to another guest request'
        }
      };
    }

    await client.query(
      `
        delete from line_occupancy
        where occupancy_date = $1::date
          and (
            ($2 = 'employee' and subject_type = 'employee' and user_id = $3)
            or
            ($2 = 'guest' and subject_type = 'guest' and guest_parking_request_id = $4)
          )
      `,
      [occupancyDate, subjectType, userId, guestParkingRequestId]
    );

    const occupancyResult = await client.query(
      `
        insert into line_occupancy (
          occupancy_date,
          line_group_id,
          parking_place_id,
          position,
          subject_type,
          user_id,
          guest_parking_request_id,
          reservation_id
        )
        values ($1::date, $2, $3, $4, $5, $6, $7, $8)
        returning id
      `,
      [
        occupancyDate,
        lineGroupId,
        parkingPlaceId,
        position,
        subjectType,
        userId,
        guestParkingRequestId,
        reservation?.id || body.reservationId || null
      ]
    );
    const occupancyId = occupancyResult.rows[0].id;

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('line_occupancy', $1, 'line_position_set', $2, $3::jsonb)
      `,
      [
        occupancyId,
        actorService,
        JSON.stringify({
          occupancyDate,
          lineGroupId,
          parkingPlaceId,
          parkingPlaceCode: place.code,
          position,
          subjectType,
          userId,
          guestParkingRequestId,
          reservationId: reservation?.id || body.reservationId || null
        })
      ]
    );

    await client.query('commit');

    const rows = await getLineOccupancyRows(lineGroupId, occupancyDate);
    const occupancy = rows.find((row) => row.occupancy_id === occupancyId);

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        occupancy: occupancy ? mapLineOccupancy(occupancy) : { id: occupancyId }
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
          error: 'Line position or parking place is already occupied for this date'
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

async function handleBotBlockingContacts(searchParams) {
  const requesterUserId = searchParams.get('requesterUserId') || searchParams.get('userId');
  const occupancyDate = searchParams.get('date') || currentDateInTimezone(appTimezone);

  if (!requesterUserId || !isIsoDate(occupancyDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'requesterUserId and date=YYYY-MM-DD are required'
      }
    };
  }

  const client = await pool.connect();

  try {
    const requesterResult = await client.query(
      `
        select
          lo.id,
          lo.line_group_id,
          lo.position,
          lg.code as line_group_code,
          lg.name as line_group_name
        from line_occupancy lo
        join line_groups lg on lg.id = lo.line_group_id
        where lo.occupancy_date = $1::date
          and lo.subject_type = 'employee'
          and lo.user_id = $2
        limit 1
      `,
      [occupancyDate, requesterUserId]
    );
    const requester = requesterResult.rows[0];

    if (!requester) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Requester line occupancy was not found for this date'
        }
      };
    }

    const blockers = await client.query(
      `
        select
          lo.id as occupancy_id,
          lo.position,
          lo.subject_type,
          u.id as user_id,
          u.display_name as user_display_name,
          u.department as user_department,
          u.email as user_email,
          u.phone as user_phone,
          gpr.id as guest_parking_request_id,
          gpr.guest_name,
          gpr.host_user_id,
          host.display_name as host_display_name
        from line_occupancy lo
        left join users u on u.id = lo.user_id
        left join guest_parking_requests gpr on gpr.id = lo.guest_parking_request_id
        left join users host on host.id = gpr.host_user_id
        where lo.occupancy_date = $1::date
          and lo.line_group_id = $2
          and lo.position < $3
        order by lo.position desc
      `,
      [occupancyDate, requester.line_group_id, requester.position]
    );

    if (!blockers.rows.length) {
      await client.query(
        `
          insert into contact_access_logs (
            requester_user_id,
            occupancy_date,
            line_group_id,
            resolution,
            metadata
          )
          values ($1, $2::date, $3, 'no_blockers', $4::jsonb)
        `,
        [
          requesterUserId,
          occupancyDate,
          requester.line_group_id,
          JSON.stringify({
            requesterPosition: requester.position
          })
        ]
      );
    }

    const contacts = [];

    for (const blocker of blockers.rows) {
      const resolution = blocker.subject_type === 'guest' ? 'guest_contact_via_admin' : 'employee_contact_shown';

      await client.query(
        `
          insert into contact_access_logs (
            requester_user_id,
            occupancy_date,
            line_group_id,
            target_user_id,
            target_guest_parking_request_id,
            resolution,
            metadata
          )
          values ($1, $2::date, $3, $4, $5, $6, $7::jsonb)
        `,
        [
          requesterUserId,
          occupancyDate,
          requester.line_group_id,
          blocker.user_id,
          blocker.guest_parking_request_id,
          resolution,
          JSON.stringify({
            requesterPosition: requester.position,
            blockerPosition: blocker.position,
            blockerSubjectType: blocker.subject_type
          })
        ]
      );

      contacts.push(
        blocker.subject_type === 'guest'
          ? {
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
            }
          : {
              position: blocker.position,
              subjectType: 'employee',
              user: {
                id: blocker.user_id,
                displayName: blocker.user_display_name,
                department: blocker.user_department,
                email: blocker.user_email,
                phone: blocker.user_phone
              }
            }
      );
    }

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        date: occupancyDate,
        lineGroup: {
          id: requester.line_group_id,
          code: requester.line_group_code,
          name: requester.line_group_name
        },
        requesterPosition: requester.position,
        contacts
      }
    };
  } finally {
    client.release();
  }
}

async function calculateAssignmentWarnings(client, reservationDate, parkingPlaceId) {
  const placeResult = await client.query(
    `
      select
        pp.id,
        pp.code,
        pp.line_group_id,
        coalesce(pp.line_position_hint, 1) as line_position_hint
      from parking_places pp
      where pp.id = $1
    `,
    [parkingPlaceId]
  );
  const place = placeResult.rows[0];

  if (!place?.line_group_id) {
    return [];
  }

  const riskResult = await client.query(
    `
      select
        dp.id as departure_plan_id,
        dp.departure_time::text as departure_time,
        lo.position,
        u.id as user_id,
        u.display_name,
        pp.code as parking_place_code,
        lg.code as line_group_code
      from departure_plans dp
      join line_occupancy lo
        on lo.user_id = dp.user_id
        and lo.subject_type = 'employee'
        and lo.occupancy_date = dp.plan_date
      join users u on u.id = dp.user_id
      join parking_places pp on pp.id = lo.parking_place_id
      join line_groups lg on lg.id = lo.line_group_id
      where dp.plan_date = $1::date
        and dp.is_early = true
        and lo.line_group_id = $2
        and lo.position > $3
      order by lo.position
    `,
    [reservationDate, place.line_group_id, place.line_position_hint]
  );

  return riskResult.rows.map((risk) => ({
    type: 'early_departure_blocking_risk',
    message: `Назначение на место ${place.code} может перекрыть ранний выезд ${risk.display_name} в ${risk.departure_time.slice(0, 5)}.`,
    lineGroupCode: risk.line_group_code,
    assignedParkingPlaceCode: place.code,
    affectedUser: {
      id: risk.user_id,
      displayName: risk.display_name
    },
    affectedParkingPlaceCode: risk.parking_place_code,
    affectedPosition: risk.position,
    departureTime: risk.departure_time.slice(0, 5)
  }));
}

async function getDeparturePlansForDate(date) {
  const rows = await queryMany(
    `
      select
        dp.id,
        dp.plan_date::text as plan_date,
        dp.departure_time::text as departure_time,
        dp.is_early,
        dp.created_at,
        dp.updated_at,
        u.id as user_id,
        u.display_name,
        u.department,
        lo.position,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title
      from departure_plans dp
      join users u on u.id = dp.user_id
      left join line_occupancy lo
        on lo.user_id = dp.user_id
        and lo.subject_type = 'employee'
        and lo.occupancy_date = dp.plan_date
      left join line_groups lg on lg.id = lo.line_group_id
      left join parking_places pp on pp.id = lo.parking_place_id
      where dp.plan_date = $1::date
      order by dp.is_early desc, dp.departure_time, u.display_name
    `,
    [date]
  );

  return rows.map((row) => ({
    id: row.id,
    planDate: row.plan_date,
    departureTime: row.departure_time.slice(0, 5),
    isEarly: row.is_early,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    user: {
      id: row.user_id,
      displayName: row.display_name,
      department: row.department
    },
    lineOccupancy: row.line_group_id
      ? {
          position: row.position,
          lineGroup: {
            id: row.line_group_id,
            code: row.line_group_code,
            name: row.line_group_name
          },
          parkingPlace: {
            id: row.parking_place_id,
            code: row.parking_place_code,
            title: row.parking_place_title
          }
        }
      : null
  }));
}

async function getConflictsForDate(date) {
  const rows = await queryMany(
    `
      select
        dp.id as departure_plan_id,
        dp.departure_time::text as departure_time,
        early_lo.position as early_position,
        early_user.id as early_user_id,
        early_user.display_name as early_user_display_name,
        early_place.code as early_place_code,
        blocker_lo.position as blocker_position,
        blocker_lo.subject_type as blocker_subject_type,
        blocker_user.id as blocker_user_id,
        blocker_user.display_name as blocker_user_display_name,
        gpr.id as blocker_guest_request_id,
        gpr.guest_name as blocker_guest_name,
        blocker_place.code as blocker_place_code,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name
      from departure_plans dp
      join line_occupancy early_lo
        on early_lo.user_id = dp.user_id
        and early_lo.subject_type = 'employee'
        and early_lo.occupancy_date = dp.plan_date
      join users early_user on early_user.id = dp.user_id
      join parking_places early_place on early_place.id = early_lo.parking_place_id
      join line_groups lg on lg.id = early_lo.line_group_id
      join line_occupancy blocker_lo
        on blocker_lo.occupancy_date = dp.plan_date
        and blocker_lo.line_group_id = early_lo.line_group_id
        and blocker_lo.position < early_lo.position
      join parking_places blocker_place on blocker_place.id = blocker_lo.parking_place_id
      left join users blocker_user on blocker_user.id = blocker_lo.user_id
      left join guest_parking_requests gpr on gpr.id = blocker_lo.guest_parking_request_id
      where dp.plan_date = $1::date
        and dp.is_early = true
      order by lg.code, early_lo.position, blocker_lo.position
    `,
    [date]
  );

  return rows.map((row) => ({
    type: row.blocker_subject_type === 'guest' ? 'guest_blocks_early_departure' : 'employee_blocks_early_departure',
    severity: row.blocker_subject_type === 'guest' ? 'warning' : 'info',
    lineGroup: {
      id: row.line_group_id,
      code: row.line_group_code,
      name: row.line_group_name
    },
    earlyDeparture: {
      departurePlanId: row.departure_plan_id,
      departureTime: row.departure_time.slice(0, 5),
      position: row.early_position,
      parkingPlaceCode: row.early_place_code,
      user: {
        id: row.early_user_id,
        displayName: row.early_user_display_name
      }
    },
    blocker: {
      position: row.blocker_position,
      subjectType: row.blocker_subject_type,
      parkingPlaceCode: row.blocker_place_code,
      user: row.blocker_user_id
        ? {
            id: row.blocker_user_id,
            displayName: row.blocker_user_display_name
          }
        : null,
      guestParkingRequest: row.blocker_guest_request_id
        ? {
            id: row.blocker_guest_request_id,
            guestName: row.blocker_guest_name
          }
        : null
    }
  }));
}

async function handleDeparturePlansList(searchParams) {
  const date = searchParams.get('date') || currentDateInTimezone(appTimezone);

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

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date,
      departurePlans: await getDeparturePlansForDate(date)
    }
  };
}

async function handleConflictsList(searchParams) {
  const date = searchParams.get('date') || currentDateInTimezone(appTimezone);

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

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date,
      conflicts: await getConflictsForDate(date)
    }
  };
}

async function handleDeparturePlanUpsert(req, actorService = 'bot') {
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
  const planDate = body.planDate || body.date;
  const departureTime = typeof body.departureTime === 'string' ? body.departureTime.slice(0, 5) : '';

  if (!userId || !isIsoDate(planDate) || !isValidTime(departureTime)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'userId, planDate and departureTime HH:MM are required'
      }
    };
  }

  if (planDate === currentDateInTimezone(appTimezone) && currentTimeInTimezone(appTimezone) >= '07:00') {
    return {
      statusCode: 409,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Departure time for the current day can be edited only before 07:00',
        timezone: appTimezone
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const userResult = await client.query(
      `
        select id, display_name
        from users
        where id = $1
          and kind = 'employee'
          and deleted_at is null
      `,
      [userId]
    );
    const user = userResult.rows[0];

    if (!user) {
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

    const multiAccessResult = await client.query(
      `
        select pp.id
        from parking_places pp
        left join permanent_assignments pa
          on pa.parking_place_id = pp.id
          and pa.user_id = $1
          and pa.valid_during @> $2::date
        left join reservations r
          on r.parking_place_id = pp.id
          and r.user_id = $1
          and r.reservation_date = $2::date
          and r.status = 'active'
        where pp.line_group_id is not null
          and (pa.id is not null or r.id is not null)
        limit 1
      `,
      [userId, planDate]
    );

    if (!multiAccessResult.rows[0]) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Departure time can be set only for users with a multi-line place or multi-line reservation on this date'
        }
      };
    }

    const planResult = await client.query(
      `
        insert into departure_plans (
          user_id,
          plan_date,
          departure_time,
          is_early,
          created_by_user_id
        )
        values ($1, $2::date, $3::time, $4, $1)
        on conflict (user_id, plan_date) do update
          set departure_time = excluded.departure_time,
              is_early = excluded.is_early,
              updated_at = now()
        returning id, user_id, plan_date::text as plan_date, departure_time::text as departure_time, is_early, created_at, updated_at
      `,
      [userId, planDate, departureTime, isEarlyDeparture(departureTime)]
    );
    const plan = planResult.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_user_id,
          actor_service,
          metadata
        )
        values ('departure_plan', $1, 'departure_plan_upserted', $2, $3, $4::jsonb)
      `,
      [
        plan.id,
        userId,
        actorService,
        JSON.stringify({
          userId,
          userDisplayName: user.display_name,
          planDate,
          departureTime,
          isEarly: plan.is_early
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        departurePlan: {
          id: plan.id,
          planDate: plan.plan_date,
          departureTime: plan.departure_time.slice(0, 5),
          isEarly: plan.is_early,
          createdAt: plan.created_at,
          updatedAt: plan.updated_at,
          user: {
            id: userId,
            displayName: user.display_name
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

async function ensureParkingPlaceMap(mapCode, mapTitle, floorLabel, filePath) {
  return queryOne(
    `
      insert into parking_place_maps (
        code,
        title,
        floor_label,
        file_type,
        file_path
      )
      values ($1, $2, $3, 'png', $4)
      on conflict (code)
      do update set
        title = excluded.title,
        floor_label = excluded.floor_label,
        file_type = excluded.file_type,
        file_path = excluded.file_path,
        is_active = true,
        updated_at = now()
      returning id, code, title, floor_label, file_type, file_path, version, is_active
    `,
    [mapCode, mapTitle, floorLabel, filePath]
  );
}

function mapParkingPlaceMap(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    floorLabel: row.floor_label,
    fileType: row.file_type,
    filePath: row.file_path,
    sourceChecksum: row.source_checksum,
    version: row.version,
    isActive: row.is_active,
    updatedAt: row.updated_at
  };
}

async function handleAdminMapDiagnostics(searchParams) {
  const mapCode = searchParams.get('mapCode');
  const mapFilter = mapCode ? 'where ppm.code = $1' : '';
  const values = mapCode ? [mapCode] : [];

  const maps = await queryMany(
    `
      select
        ppm.id,
        ppm.code,
        ppm.title,
        ppm.floor_label,
        ppm.file_type,
        ppm.file_path,
        ppm.source_checksum,
        ppm.version,
        ppm.is_active,
        ppm.updated_at
      from parking_place_maps ppm
      ${mapFilter}
      order by ppm.floor_label nulls last, ppm.code
    `,
    values
  );

  const zoneWithoutPlace = await queryMany(
    `
      select
        ppm.code as map_code,
        ppm.title as map_title,
        z.id as zone_id,
        z.zone_key,
        z.geometry,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.deleted_at as parking_place_deleted_at
      from parking_place_map_zones z
      join parking_place_maps ppm on ppm.id = z.parking_place_map_id
      left join parking_places pp on pp.id = z.parking_place_id
      where ppm.is_active = true
        and (pp.id is null or pp.deleted_at is not null)
        ${mapCode ? 'and ppm.code = $1' : ''}
      order by ppm.code, z.zone_key
    `,
    values
  );

  const inactivePlaceWithActiveZone = await queryMany(
    `
      select
        ppm.code as map_code,
        ppm.title as map_title,
        z.id as zone_id,
        z.zone_key,
        z.geometry,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.is_active
      from parking_place_map_zones z
      join parking_place_maps ppm on ppm.id = z.parking_place_map_id
      join parking_places pp on pp.id = z.parking_place_id
      where ppm.is_active = true
        and pp.deleted_at is null
        and pp.is_active = false
        ${mapCode ? 'and ppm.code = $1' : ''}
      order by ppm.code, pp.code
    `,
    values
  );

  const placeWithoutZone = await queryMany(
    `
      select
        ppm.code as map_code,
        ppm.title as map_title,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.floor_label,
        pp.place_type
      from parking_place_maps ppm
      join parking_places pp
        on pp.deleted_at is null
        and pp.is_active = true
        and (
          pp.floor_label = ppm.floor_label
          or pp.floor_label = regexp_replace(ppm.code, '^g', '', 'i')
        )
      left join parking_place_map_zones z
        on z.parking_place_map_id = ppm.id
        and z.parking_place_id = pp.id
      where ppm.is_active = true
        and z.id is null
        ${mapCode ? 'and ppm.code = $1' : ''}
      order by ppm.code, pp.code
    `,
    values
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      maps: maps.map(mapParkingPlaceMap),
      diagnostics: {
        zoneWithoutPlace: zoneWithoutPlace.map((item) => ({
          mapCode: item.map_code,
          mapTitle: item.map_title,
          zoneId: item.zone_id,
          zoneKey: item.zone_key,
          geometry: item.geometry,
          parkingPlace: item.parking_place_id
            ? {
                id: item.parking_place_id,
                code: item.parking_place_code,
                title: item.parking_place_title,
                deletedAt: item.parking_place_deleted_at
              }
            : null
        })),
        placeWithoutZone: placeWithoutZone.map((item) => ({
          mapCode: item.map_code,
          mapTitle: item.map_title,
          parkingPlace: {
            id: item.parking_place_id,
            code: item.parking_place_code,
            title: item.parking_place_title,
            floorLabel: item.floor_label,
            placeType: item.place_type
          }
        })),
        inactivePlaceWithActiveZone: inactivePlaceWithActiveZone.map((item) => ({
          mapCode: item.map_code,
          mapTitle: item.map_title,
          zoneId: item.zone_id,
          zoneKey: item.zone_key,
          geometry: item.geometry,
          parkingPlace: {
            id: item.parking_place_id,
            code: item.parking_place_code,
            title: item.parking_place_title,
            isActive: item.is_active
          }
        }))
      }
    }
  };
}

async function handleAdminMapBackgroundUpdate(req) {
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

  const mapCode = typeof body.mapCode === 'string' ? body.mapCode.trim().toLowerCase() : '';
  const mapTitle = typeof body.mapTitle === 'string' ? body.mapTitle.trim() : mapCode.toUpperCase();
  const floorLabel = typeof body.floorLabel === 'string' ? body.floorLabel.trim() : mapCode.replace(/^g/i, '');
  const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
  const fileType = typeof body.fileType === 'string' ? body.fileType.trim().toLowerCase() : '';
  const sourceChecksum = typeof body.sourceChecksum === 'string' ? body.sourceChecksum.trim() : '';

  if (!mapCode || !filePath || !fileType || !sourceChecksum) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'mapCode, filePath, fileType and sourceChecksum are required'
      }
    };
  }

  if (!['pdf', 'svg', 'png', 'jpg', 'webp'].includes(fileType)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'fileType must be one of pdf, svg, png, jpg, webp'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const result = await client.query(
      `
        insert into parking_place_maps (
          code,
          title,
          floor_label,
          file_type,
          file_path,
          source_checksum,
          version
        )
        values ($1, $2, $3, $4::map_file_type, $5, $6, 1)
        on conflict (code)
        do update set
          title = excluded.title,
          floor_label = excluded.floor_label,
          file_type = excluded.file_type,
          file_path = excluded.file_path,
          source_checksum = excluded.source_checksum,
          version = parking_place_maps.version + 1,
          is_active = true,
          updated_at = now()
        returning id, code, title, floor_label, file_type, file_path, source_checksum, version, is_active, updated_at
      `,
      [mapCode, mapTitle || mapCode.toUpperCase(), floorLabel || mapCode.replace(/^g/i, ''), fileType, filePath, sourceChecksum]
    );
    const map = result.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('parking_place_map', $1, 'parking_place_map_background_replaced', 'admin-web', $2::jsonb)
      `,
      [
        map.id,
        JSON.stringify({
          mapCode,
          filePath,
          fileType,
          sourceChecksum,
          version: map.version
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        map: mapParkingPlaceMap(map)
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

async function handleAdminMapZonesList(searchParams) {
  const mapCode = searchParams.get('mapCode');
  const date = searchParams.get('date') || currentDateInTimezone(appTimezone);

  if (!mapCode) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'mapCode is required'
      }
    };
  }

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

  const map = await queryOne(
    `
      select id, code, title, floor_label, file_type, file_path, source_checksum, version, is_active, updated_at
      from parking_place_maps
      where code = $1
        and is_active = true
    `,
    [mapCode]
  );

  if (!map) {
    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        map: null,
        zones: []
      }
    };
  }

  const zones = await queryMany(
    `
      select
        z.id,
        z.zone_key,
        z.geometry,
        z.label_x,
        z.label_y,
        z.created_at,
        z.updated_at,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type,
        pp.guest_priority_rank,
        r.id as reservation_id,
        r.source as reservation_source,
        r.status as reservation_status,
        u.display_name as reserved_user_display_name
      from parking_place_map_zones z
      join parking_places pp on pp.id = z.parking_place_id
      left join reservations r
        on r.parking_place_id = pp.id
        and r.reservation_date = $2::date
        and r.status = 'active'
      left join users u on u.id = r.user_id
      where z.parking_place_map_id = $1
      order by pp.code
    `,
    [map.id, date]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date,
      map: {
        id: map.id,
        ...mapParkingPlaceMap(map)
      },
      zones: zones.map((zone) => ({
        id: zone.id,
        zoneKey: zone.zone_key,
        geometry: zone.geometry,
        labelX: zone.label_x,
        labelY: zone.label_y,
        createdAt: zone.created_at,
        updatedAt: zone.updated_at,
        parkingPlace: {
          id: zone.parking_place_id,
          code: zone.parking_place_code,
          title: zone.parking_place_title,
          placeType: zone.place_type,
          guestPriorityRank: zone.guest_priority_rank
        },
        status: zone.reservation_id
          ? 'occupied'
          : zone.geometry?.zoneType === 'blocked'
            ? 'blocked'
            : zone.geometry?.zoneType === 'rotatable'
              ? 'rotatable'
              : 'free',
        reservation: zone.reservation_id
          ? {
              id: zone.reservation_id,
              source: zone.reservation_source,
              status: zone.reservation_status,
              userDisplayName: zone.reserved_user_display_name
            }
          : null
      }))
    }
  };
}

async function handleAdminMapZoneSave(req) {
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

  const mapCode = typeof body.mapCode === 'string' ? body.mapCode.trim().toLowerCase() : '';
  const mapTitle = typeof body.mapTitle === 'string' ? body.mapTitle.trim() : mapCode.toUpperCase();
  const floorLabel = typeof body.floorLabel === 'string' ? body.floorLabel.trim() : mapCode.replace(/^g/, '');
  const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : `/maps/parking-${mapCode}.png`;
  const parkingPlaceId = body.parkingPlaceId;
  const zoneType = ['regular', 'rotatable', 'blocked'].includes(body.zoneType) ? body.zoneType : 'regular';
  const geometry = body.geometry;

  if (!mapCode || !parkingPlaceId || !geometry) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'mapCode, parkingPlaceId and geometry are required'
      }
    };
  }

  const x = Number(geometry.x);
  const y = Number(geometry.y);
  const width = Number(geometry.width);
  const height = Number(geometry.height);

  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'geometry must contain normalized x, y, width and height values between 0 and 1'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const mapResult = await client.query(
      `
        insert into parking_place_maps (
          code,
          title,
          floor_label,
          file_type,
          file_path
        )
        values ($1, $2, $3, 'png', $4)
        on conflict (code)
        do update set
          title = excluded.title,
          floor_label = excluded.floor_label,
          file_type = excluded.file_type,
          file_path = excluded.file_path,
          is_active = true,
          updated_at = now()
        returning id, code, title, floor_label, file_type, file_path
      `,
      [mapCode, mapTitle || mapCode.toUpperCase(), floorLabel || null, filePath]
    );
    const map = mapResult.rows[0];

    const placeResult = await client.query(
      `
        select id, code, title, place_type, guest_priority_rank
        from parking_places
        where id = $1
          and deleted_at is null
      `,
      [parkingPlaceId]
    );
    const place = placeResult.rows[0];

    if (!place) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Parking place not found'
        }
      };
    }

    const zoneKey = `${mapCode}:${place.code}`;
    const zoneResult = await client.query(
      `
        insert into parking_place_map_zones (
          parking_place_map_id,
          parking_place_id,
          zone_key,
          geometry,
          label_x,
          label_y
        )
        values ($1, $2, $3, $4::jsonb, $5, $6)
        on conflict (parking_place_map_id, parking_place_id)
        do update set
          zone_key = excluded.zone_key,
          geometry = excluded.geometry,
          label_x = excluded.label_x,
          label_y = excluded.label_y,
          updated_at = now()
        returning id, zone_key, geometry, label_x, label_y, created_at, updated_at
      `,
      [
        map.id,
        place.id,
        zoneKey,
        JSON.stringify({ type: 'rect', zoneType, x, y, width, height }),
        x + width / 2,
        y + height / 2
      ]
    );
    const zone = zoneResult.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('parking_place_map_zone', $1, 'parking_place_map_zone_saved', 'admin-web', $2::jsonb)
      `,
      [
        zone.id,
        JSON.stringify({
          mapCode,
          parkingPlaceId: place.id,
          parkingPlaceCode: place.code,
          geometry: zone.geometry,
          zoneType
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        zone: {
          id: zone.id,
          zoneKey: zone.zone_key,
          geometry: zone.geometry,
          labelX: zone.label_x,
          labelY: zone.label_y,
          parkingPlace: {
            id: place.id,
            code: place.code,
            title: place.title,
            placeType: place.place_type,
            guestPriorityRank: place.guest_priority_rank
          },
          map: {
            id: map.id,
            code: map.code,
            title: map.title
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
          error: 'Map zone conflicts with an existing zone key or place mapping'
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

async function handleAdminMapZoneUpdate(req) {
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

  const zoneId = body.zoneId;
  const zoneType = ['regular', 'rotatable', 'blocked'].includes(body.zoneType) ? body.zoneType : null;

  if (!zoneId || !zoneType) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'zoneId and valid zoneType are required'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const zoneResult = await client.query(
      `
        select
          z.id,
          z.geometry,
          pp.code as parking_place_code,
          ppm.code as map_code
        from parking_place_map_zones z
        join parking_places pp on pp.id = z.parking_place_id
        join parking_place_maps ppm on ppm.id = z.parking_place_map_id
        where z.id = $1
        for update of z
      `,
      [zoneId]
    );
    const existingZone = zoneResult.rows[0];

    if (!existingZone) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Map zone not found'
        }
      };
    }

    const nextGeometry = {
      ...(existingZone.geometry || {}),
      zoneType
    };

    const updatedResult = await client.query(
      `
        update parking_place_map_zones
        set
          geometry = $1::jsonb,
          updated_at = now()
        where id = $2
        returning id, zone_key, geometry, label_x, label_y, updated_at
      `,
      [JSON.stringify(nextGeometry), zoneId]
    );
    const updatedZone = updatedResult.rows[0];

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('parking_place_map_zone', $1, 'parking_place_map_zone_type_changed', 'admin-web', $2::jsonb)
      `,
      [
        zoneId,
        JSON.stringify({
          mapCode: existingZone.map_code,
          parkingPlaceCode: existingZone.parking_place_code,
          zoneType
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        zone: {
          id: updatedZone.id,
          zoneKey: updatedZone.zone_key,
          geometry: updatedZone.geometry,
          labelX: updatedZone.label_x,
          labelY: updatedZone.label_y,
          updatedAt: updatedZone.updated_at
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

async function handleAdminMapZoneDelete(req) {
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

  const zoneId = body.zoneId;

  if (!zoneId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'zoneId is required'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const deletedResult = await client.query(
      `
        delete from parking_place_map_zones z
        using parking_places pp, parking_place_maps ppm
        where z.parking_place_id = pp.id
          and z.parking_place_map_id = ppm.id
          and z.id = $1
        returning
          z.id,
          z.zone_key,
          z.geometry,
          pp.code as parking_place_code,
          ppm.code as map_code
      `,
      [zoneId]
    );
    const deletedZone = deletedResult.rows[0];

    if (!deletedZone) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Map zone not found'
        }
      };
    }

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          entity_id,
          action,
          actor_service,
          metadata
        )
        values ('parking_place_map_zone', $1, 'parking_place_map_zone_deleted', 'admin-web', $2::jsonb)
      `,
      [
        zoneId,
        JSON.stringify({
          mapCode: deletedZone.map_code,
          parkingPlaceCode: deletedZone.parking_place_code,
          zoneKey: deletedZone.zone_key,
          geometry: deletedZone.geometry
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        deletedZone: {
          id: deletedZone.id,
          zoneKey: deletedZone.zone_key,
          mapCode: deletedZone.map_code,
          parkingPlaceCode: deletedZone.parking_place_code
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

  const [releasedPlaces, reservations, guestRequests, guestReserve] = await Promise.all([
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
    ),
    queryMany(
      `
        select
          gpr.id,
          gpr.request_date,
          gpr.status,
          gpr.guest_name,
          gpr.guest_phone,
          gpr.vehicle_plate_number,
          gpr.created_at,
          gpr.canceled_at,
          gpr.notes,
          host.id as host_user_id,
          host.display_name as host_display_name,
          host.department as host_department,
          r.id as reservation_id,
          pp.id as parking_place_id,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.place_type as parking_place_type
        from guest_parking_requests gpr
        join users host on host.id = gpr.host_user_id
        left join reservations r on r.id = gpr.assigned_reservation_id
        left join parking_places pp on pp.id = r.parking_place_id
        where gpr.request_date = $1::date
        order by gpr.created_at desc
      `,
      [date]
    ),
    queryOne(
      `
        select count(*)::int as available_places
        from place_releases pr
        join parking_places pp on pp.id = pr.parking_place_id
        left join reservations r
          on r.parking_place_id = pp.id
          and r.reservation_date = $1::date
          and r.status = 'active'
        where pr.status = 'active'
          and pr.release_during @> $1::date
          and r.id is null
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
      })),
      guestReserve: {
        minimum: guestReserveMinimum,
        availablePlaces: guestReserve?.available_places || 0,
        status: (guestReserve?.available_places || 0) >= guestReserveMinimum ? 'ok' : 'low'
      },
      guestRequests: guestRequests.map((request) => ({
        id: request.id,
        requestDate: request.request_date,
        status: request.status,
        guestName: request.guest_name,
        guestPhone: request.guest_phone,
        vehiclePlateNumber: request.vehicle_plate_number,
        createdAt: request.created_at,
        canceledAt: request.canceled_at,
        notes: request.notes,
        host: {
          id: request.host_user_id,
          displayName: request.host_display_name,
          department: request.host_department
        },
        assignedReservation: request.reservation_id
          ? {
              id: request.reservation_id,
              parkingPlace: {
                id: request.parking_place_id,
                code: request.parking_place_code,
                title: request.parking_place_title,
                placeType: request.parking_place_type
              }
            }
          : null
      })),
      guestReservations: reservations
        .filter((reservation) => reservation.source === 'guest')
        .map((reservation) => ({
          id: reservation.id,
          reservationDate: reservation.reservation_date,
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

async function handleAdminAvailability(searchParams) {
  const date = searchParams.get('date') || currentDateInTimezone(appTimezone);

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

  const client = await pool.connect();

  try {
    const availability = await calculateAvailabilitySnapshot(client, date, { appTimezone, guestReserveMinimum });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        availability
      }
    };
  } finally {
    client.release();
  }
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

async function handleAdminGuestParkingRequestsList(searchParams) {
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
        gpr.id,
        gpr.request_date,
        gpr.status,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.vehicle_plate_number,
        gpr.created_at,
        gpr.canceled_at,
        gpr.notes,
        guest.id as guest_user_id,
        guest.display_name as guest_display_name,
        host.id as host_user_id,
        host.display_name as host_display_name,
        host.department as host_department,
        r.id as reservation_id,
        r.status as reservation_status,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type
      from guest_parking_requests gpr
      join users guest on guest.id = gpr.guest_user_id
      join users host on host.id = gpr.host_user_id
      left join reservations r on r.id = gpr.assigned_reservation_id
      left join parking_places pp on pp.id = r.parking_place_id
      where ($1::date is null or gpr.request_date = $1::date)
      order by gpr.request_date desc, gpr.created_at desc
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
        guestName: request.guest_name,
        guestPhone: request.guest_phone,
        vehiclePlateNumber: request.vehicle_plate_number,
        createdAt: request.created_at,
        canceledAt: request.canceled_at,
        notes: request.notes,
        guest: {
          id: request.guest_user_id,
          displayName: request.guest_display_name
        },
        host: {
          id: request.host_user_id,
          displayName: request.host_display_name,
          department: request.host_department
        },
        assignedReservation: request.reservation_id
          ? {
              id: request.reservation_id,
              status: request.reservation_status,
              parkingPlace: {
                id: request.parking_place_id,
                code: request.parking_place_code,
                title: request.parking_place_title,
                placeType: request.parking_place_type
              }
            }
          : null
      }))
    }
  };
}

async function handleAdminGuestParkingRequestCreate(req) {
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

  const hostUserId = body.hostUserId;
  const requestDate = body.requestDate;
  const guestName = typeof body.guestName === 'string' ? body.guestName.trim() : '';
  const guestPhone = typeof body.guestPhone === 'string' ? body.guestPhone.trim() || null : null;
  const vehiclePlateNumber =
    typeof body.vehiclePlateNumber === 'string' ? body.vehiclePlateNumber.trim() || null : null;
  const notes = typeof body.notes === 'string' ? body.notes.trim() || null : null;

  if (!hostUserId || !isIsoDate(requestDate) || !guestName) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'hostUserId, guestName and requestDate are required; date must use YYYY-MM-DD format'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`guest_assignment:${requestDate}`]);

    const hostResult = await client.query(
      `
        select id, display_name, department
        from users
        where id = $1
          and kind = 'employee'
          and is_active = true
          and deleted_at is null
      `,
      [hostUserId]
    );
    const host = hostResult.rows[0];

    if (!host) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Host employee not found'
        }
      };
    }

    const placeResult = await client.query(
      `
        select
          pr.id as release_id,
          pp.id as parking_place_id,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.place_type
        from place_releases pr
        join parking_places pp on pp.id = pr.parking_place_id
        left join reservations r
          on r.parking_place_id = pp.id
          and r.reservation_date = $1::date
          and r.status = 'active'
        where pr.status = 'active'
          and pr.release_during @> $1::date
          and r.id is null
        order by
          case pp.place_type
            when 'single' then 1
            when 'double' then 2
            when 'triple' then 3
            else 4
          end,
          pp.guest_priority_rank nulls last,
          pp.code
        limit 1
        for update of pr, pp
      `,
      [requestDate]
    );
    const place = placeResult.rows[0];

    if (!place) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'No released parking place is available for guest assignment on this date'
        }
      };
    }

    const warnings = await calculateAssignmentWarnings(client, requestDate, place.parking_place_id);

    const { firstName, lastName } = splitDisplayName(guestName);
    const guestResult = await client.query(
      `
        insert into users (
          kind,
          first_name,
          last_name,
          display_name,
          phone
        )
        values ('guest', $1, $2, $3, $4)
        returning id, display_name, phone
      `,
      [firstName, lastName, guestName, guestPhone]
    );
    const guest = guestResult.rows[0];

    const requestResult = await client.query(
      `
        insert into guest_parking_requests (
          guest_user_id,
          host_user_id,
          request_date,
          status,
          guest_name,
          guest_phone,
          vehicle_plate_number,
          notes
        )
        values ($1, $2, $3::date, 'assigned', $4, $5, $6, $7)
        returning id, request_date, status, created_at
      `,
      [guest.id, hostUserId, requestDate, guestName, guestPhone, vehiclePlateNumber, notes]
    );
    const guestRequest = requestResult.rows[0];

    const reservationResult = await client.query(
      `
        insert into reservations (
          reservation_date,
          parking_place_id,
          user_id,
          guest_parking_request_id,
          source,
          reason
        )
        values ($1::date, $2, $3, $4, 'guest', $5)
        returning id, reservation_date, source, status, created_at
      `,
      [
        requestDate,
        place.parking_place_id,
        guest.id,
        guestRequest.id,
        `Guest assignment hosted by ${host.display_name}`
      ]
    );
    const reservation = reservationResult.rows[0];

    await client.query(
      `
        update guest_parking_requests
        set
          assigned_reservation_id = $1,
          updated_at = now()
        where id = $2
      `,
      [reservation.id, guestRequest.id]
    );

    await client.query(
      `
        insert into reservation_events (
          reservation_id,
          event_type,
          payload,
          source
        )
        values ($1, 'reservation_created', $2::jsonb, 'guest')
      `,
      [
        reservation.id,
        JSON.stringify({
          releaseId: place.release_id,
          guestParkingRequestId: guestRequest.id,
          guestUserId: guest.id,
          guestName,
          hostUserId,
          hostDisplayName: host.display_name,
          parkingPlaceId: place.parking_place_id,
          requestDate
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
        values ($1, $2::date, $3, 'guest_assignment', $4)
      `,
      [reservation.id, requestDate, place.parking_place_id, `Guest assignment hosted by ${host.display_name}`]
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
          'guest_parking_request',
          $1,
          'guest_parking_request_created_and_assigned',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        guestRequest.id,
        JSON.stringify({
          guestUserId: guest.id,
          guestName,
          hostUserId,
          hostDisplayName: host.display_name,
          reservationId: reservation.id,
          parkingPlaceId: place.parking_place_id,
          parkingPlaceCode: place.parking_place_code,
          requestDate,
          warnings
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
          id: guestRequest.id,
          requestDate: guestRequest.request_date,
          status: guestRequest.status,
          guestName,
          guestPhone,
          vehiclePlateNumber,
          createdAt: guestRequest.created_at,
          guest: {
            id: guest.id,
            displayName: guest.display_name,
            phone: guest.phone
          },
          host: {
            id: host.id,
            displayName: host.display_name,
            department: host.department
          },
          assignedReservation: {
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            source: reservation.source,
            status: reservation.status,
            parkingPlace: {
              id: place.parking_place_id,
              code: place.parking_place_code,
              title: place.parking_place_title,
              placeType: place.place_type
            }
          }
        },
        warnings
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
          error: 'Guest request or reservation already exists for this date'
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

async function handleAdminGuestParkingRequestAssign(req) {
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
          gpr.id,
          gpr.request_date,
          gpr.status,
          gpr.guest_user_id,
          gpr.host_user_id,
          gpr.guest_name,
          gpr.assigned_reservation_id,
          host.display_name as host_display_name
        from guest_parking_requests gpr
        join users host on host.id = gpr.host_user_id
        where gpr.id = $1
        for update of gpr
      `,
      [requestId]
    );
    const guestRequest = requestResult.rows[0];

    if (!guestRequest) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Guest parking request not found'
        }
      };
    }

    if (guestRequest.status === 'canceled') {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Canceled guest requests cannot be assigned'
        }
      };
    }

    if (guestRequest.assigned_reservation_id || guestRequest.status === 'assigned') {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Guest request is already assigned'
        }
      };
    }

    const requestDate = formatDateForSql(guestRequest.request_date);
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`guest_assignment:${requestDate}`]);

    const placeResult = await client.query(
      `
        select
          pr.id as release_id,
          pp.id as parking_place_id,
          pp.code as parking_place_code,
          pp.title as parking_place_title,
          pp.place_type
        from place_releases pr
        join parking_places pp on pp.id = pr.parking_place_id
        left join reservations r
          on r.parking_place_id = pp.id
          and r.reservation_date = $1::date
          and r.status = 'active'
        where pr.status = 'active'
          and pr.release_during @> $1::date
          and r.id is null
        order by
          case pp.place_type
            when 'single' then 1
            when 'double' then 2
            when 'triple' then 3
            else 4
          end,
          pp.guest_priority_rank nulls last,
          pp.code
        limit 1
        for update of pr, pp
      `,
      [requestDate]
    );
    const place = placeResult.rows[0];

    if (!place) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'No released parking place is available for guest assignment on this date'
        }
      };
    }

    const reservationResult = await client.query(
      `
        insert into reservations (
          reservation_date,
          parking_place_id,
          user_id,
          guest_parking_request_id,
          source,
          reason
        )
        values ($1::date, $2, $3, $4, 'guest', $5)
        returning id, reservation_date, source, status, created_at
      `,
      [
        requestDate,
        place.parking_place_id,
        guestRequest.guest_user_id,
        guestRequest.id,
        `Guest assignment hosted by ${guestRequest.host_display_name}`
      ]
    );
    const reservation = reservationResult.rows[0];

    await client.query(
      `
        update guest_parking_requests
        set
          status = 'assigned',
          assigned_reservation_id = $1,
          updated_at = now()
        where id = $2
      `,
      [reservation.id, guestRequest.id]
    );

    await client.query(
      `
        insert into reservation_events (
          reservation_id,
          event_type,
          payload,
          source
        )
        values ($1, 'reservation_created', $2::jsonb, 'guest')
      `,
      [
        reservation.id,
        JSON.stringify({
          releaseId: place.release_id,
          guestParkingRequestId: guestRequest.id,
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          parkingPlaceId: place.parking_place_id,
          requestDate
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
        values ($1, $2::date, $3, 'guest_assignment', $4)
      `,
      [reservation.id, requestDate, place.parking_place_id, `Guest assignment hosted by ${guestRequest.host_display_name}`]
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
          'guest_parking_request',
          $1,
          'guest_parking_request_assigned',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        guestRequest.id,
        JSON.stringify({
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          reservationId: reservation.id,
          parkingPlaceId: place.parking_place_id,
          parkingPlaceCode: place.parking_place_code,
          requestDate,
          warnings
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
          id: guestRequest.id,
          requestDate: reservation.reservation_date,
          status: 'assigned',
          guestName: guestRequest.guest_name,
          assignedReservation: {
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            source: reservation.source,
            status: reservation.status,
            parkingPlace: {
              id: place.parking_place_id,
              code: place.parking_place_code,
              title: place.parking_place_title,
              placeType: place.place_type
            }
          }
        },
        warnings
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
          error: 'Guest reservation already exists for this date'
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

async function handleAdminGuestParkingRequestCancel(req) {
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
          gpr.id,
          gpr.request_date,
          gpr.status,
          gpr.guest_user_id,
          gpr.host_user_id,
          gpr.guest_name,
          gpr.assigned_reservation_id,
          host.display_name as host_display_name
        from guest_parking_requests gpr
        join users host on host.id = gpr.host_user_id
        where gpr.id = $1
        for update of gpr
      `,
      [requestId]
    );
    const guestRequest = requestResult.rows[0];

    if (!guestRequest) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Guest parking request not found'
        }
      };
    }

    if (guestRequest.status === 'canceled') {
      await client.query('rollback');
      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          request: {
            id: guestRequest.id,
            requestDate: guestRequest.request_date,
            status: guestRequest.status
          }
        }
      };
    }

    let canceledReservation = null;

    if (guestRequest.assigned_reservation_id) {
      const reservationResult = await client.query(
        `
          update reservations
          set
            status = 'canceled',
            canceled_at = now(),
            updated_at = now()
          where id = $1
            and status = 'active'
          returning id, reservation_date, parking_place_id, status, canceled_at
        `,
        [guestRequest.assigned_reservation_id]
      );
      canceledReservation = reservationResult.rows[0] || null;

      if (canceledReservation) {
        await client.query(
          `
            insert into reservation_events (
              reservation_id,
              event_type,
              payload,
              source
            )
            values ($1, 'reservation_canceled', $2::jsonb, 'guest')
          `,
          [
            canceledReservation.id,
            JSON.stringify({
              guestParkingRequestId: guestRequest.id,
              guestUserId: guestRequest.guest_user_id,
              hostUserId: guestRequest.host_user_id,
              requestDate: guestRequest.request_date
            })
          ]
        );
      }
    }

    const canceledRequestResult = await client.query(
      `
        update guest_parking_requests
        set
          status = 'canceled',
          canceled_at = now(),
          updated_at = now()
        where id = $1
        returning id, request_date, status, canceled_at
      `,
      [requestId]
    );
    const canceledRequest = canceledRequestResult.rows[0];

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
          'guest_parking_request',
          $1,
          'guest_parking_request_canceled',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        requestId,
        JSON.stringify({
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          hostDisplayName: guestRequest.host_display_name,
          reservationId: guestRequest.assigned_reservation_id,
          canceledReservationId: canceledReservation?.id || null,
          requestDate: guestRequest.request_date
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
        },
        canceledReservation: canceledReservation
          ? {
              id: canceledReservation.id,
              reservationDate: canceledReservation.reservation_date,
              status: canceledReservation.status,
              canceledAt: canceledReservation.canceled_at
            }
          : null
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

async function processQueueForDate(queueDate) {
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`process_queue:${queueDate}`]);

    const queueResult = await client.query(
      `
        select
          qe.id as queue_entry_id,
          qe.queue_position,
          epr.id as request_id,
          epr.user_id,
          u.display_name as user_display_name
        from queue_entries qe
        join employee_parking_requests epr on epr.id = qe.employee_parking_request_id
        join users u on u.id = epr.user_id
        where qe.queue_date = $1::date
          and qe.status = 'waiting'
          and epr.status = 'queued'
        order by qe.queue_position
        for update of qe, epr
      `,
      [queueDate]
    );

    const availablePlacesResult = await client.query(
      `
        select
          pr.id as release_id,
          pp.id as parking_place_id,
          pp.code as parking_place_code,
          pp.place_type,
          pr.user_id as owner_user_id
        from place_releases pr
        join parking_places pp on pp.id = pr.parking_place_id
        left join reservations r
          on r.parking_place_id = pp.id
          and r.reservation_date = $1::date
          and r.status = 'active'
        where pr.status = 'active'
          and pr.release_during @> $1::date
          and r.id is null
        order by
          case pp.place_type
            when 'double' then 1
            when 'triple' then 2
            else 3
          end,
          pp.code
        for update of pr, pp
      `,
      [queueDate]
    );

    const queueEntries = queueResult.rows;
    const availablePlaces = availablePlacesResult.rows;
    const maxEmployeeAssignments = Math.max(0, availablePlaces.length - guestReserveMinimum);
    const assignments = [];
    const skipped = [];
    let placeIndex = 0;

    for (const entry of queueEntries) {
      if (assignments.length >= maxEmployeeAssignments) {
        skipped.push({
          requestId: entry.request_id,
          queueEntryId: entry.queue_entry_id,
          queuePosition: entry.queue_position,
          userId: entry.user_id,
          userDisplayName: entry.user_display_name,
          reason: 'guest_reserve_minimum_reached'
        });
        continue;
      }

      while (placeIndex < availablePlaces.length && availablePlaces[placeIndex].owner_user_id === entry.user_id) {
        placeIndex += 1;
      }

      const place = availablePlaces[placeIndex];

      if (!place) {
        skipped.push({
          requestId: entry.request_id,
          queueEntryId: entry.queue_entry_id,
          queuePosition: entry.queue_position,
          userId: entry.user_id,
          userDisplayName: entry.user_display_name,
          reason: 'no_available_released_place'
        });
        continue;
      }

      const reservationResult = await client.query(
        `
          insert into reservations (
            reservation_date,
            parking_place_id,
            user_id,
            employee_parking_request_id,
            source,
            reason
          )
          values ($1::date, $2, $3, $4, 'queue', $5)
          returning id, reservation_date, source, status, created_at
        `,
        [
          queueDate,
          place.parking_place_id,
          entry.user_id,
          entry.request_id,
          `Queue assignment #${entry.queue_position}`
        ]
      );
      const reservation = reservationResult.rows[0];

      await client.query(
        `
          update employee_parking_requests
          set
            status = 'assigned',
            assigned_reservation_id = $1,
            updated_at = now()
          where id = $2
        `,
        [reservation.id, entry.request_id]
      );

      await client.query(
        `
          update queue_entries
          set
            status = 'assigned',
            assigned_reservation_id = $1,
            processed_at = now(),
            updated_at = now()
          where id = $2
        `,
        [reservation.id, entry.queue_entry_id]
      );

      await client.query(
        `
          insert into reservation_events (
            reservation_id,
            event_type,
            payload,
            source
          )
          values ($1, 'reservation_created', $2::jsonb, 'queue')
        `,
        [
          reservation.id,
          JSON.stringify({
            releaseId: place.release_id,
            queueEntryId: entry.queue_entry_id,
            queuePosition: entry.queue_position,
            requestId: entry.request_id,
            userId: entry.user_id,
            parkingPlaceId: place.parking_place_id,
            queueDate
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
          values ($1, $2::date, $3, 'queue_assignment', $4)
        `,
        [
          reservation.id,
          queueDate,
          place.parking_place_id,
          `Assigned from queue position #${entry.queue_position}`
        ]
      );

      assignments.push({
        requestId: entry.request_id,
        queueEntryId: entry.queue_entry_id,
        queuePosition: entry.queue_position,
        reservationId: reservation.id,
        user: {
          id: entry.user_id,
          displayName: entry.user_display_name
        },
        parkingPlace: {
          id: place.parking_place_id,
          code: place.parking_place_code
        }
      });

      placeIndex += 1;
    }

    if (skipped.length) {
      await client.query(
        `
          update queue_entries
          set
            status = 'skipped',
            processed_at = now(),
            updated_at = now()
          where id = any($1::uuid[])
            and status = 'waiting'
        `,
        [skipped.map((item) => item.queueEntryId)]
      );
    }

    await client.query(
      `
        insert into audit_logs (
          entity_type,
          action,
          actor_service,
          metadata
        )
        values (
          'queue_entry',
          'queue_processed',
          'admin-web',
          $1::jsonb
        )
      `,
      [
        JSON.stringify({
          queueDate,
          waitingCount: queueEntries.length,
          availableReleasedPlacesCount: availablePlaces.length,
          guestReserveMinimum,
          assignedCount: assignments.length,
          skippedCount: skipped.length,
          assignments,
          skipped
        })
      ]
    );

    await client.query('commit');

    return {
      date: queueDate,
      guestReserveMinimum,
      availableReleasedPlacesCount: availablePlaces.length,
      assignedCount: assignments.length,
      skippedCount: skipped.length,
      assignments,
      skipped
    };
  } catch (error) {
    await client.query('rollback');

    if (error.code === '23505') {
      error.statusCode = 409;
      error.message = 'Queue processing hit an existing active reservation for this date';
    }

    throw error;
  } finally {
    client.release();
  }
}

async function handleAdminQueueProcess(req) {
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

  const queueDate = body.date;

  if (!isIsoDate(queueDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date is required and must use YYYY-MM-DD format'
      }
    };
  }

  try {
    const result = await withJobRun('process_queue', queueDate, () => processQueueForDate(queueDate));

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        ...result
      }
    };
  } catch (error) {
    return {
      statusCode: error.statusCode || 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message,
        jobRun: error.jobRun || null
      }
    };
  }
}

async function handleAdminJobProcessQueue(req) {
  return handleAdminQueueProcess(req);
}

async function handleAdminJobFreezeNextDay(req) {
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

  const targetDate = body.date || addDaysToIsoDate(currentDateInTimezone(appTimezone), 1);

  if (!isIsoDate(targetDate)) {
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
    const result = await withJobRun('freeze_next_day', targetDate, async () => {
      const client = await pool.connect();

      try {
        const snapshot = await calculateAvailabilitySnapshot(client, targetDate, { appTimezone, guestReserveMinimum });
        const releaseResult = await client.query(
          `
            select
              pr.id,
              pp.id as parking_place_id,
              pp.code as parking_place_code,
              pp.place_type,
              pr.user_id as owner_user_id
            from place_releases pr
            join parking_places pp on pp.id = pr.parking_place_id
            where pr.status = 'active'
              and pr.release_during @> $1::date
            order by pp.code
          `,
          [targetDate]
        );

        await client.query(
          `
            insert into audit_logs (
              entity_type,
              action,
              actor_service,
              metadata
            )
            values ('system', 'availability_frozen', 'admin-web', $1::jsonb)
          `,
          [
            JSON.stringify({
              targetDate,
              timezone: appTimezone,
              releaseCount: releaseResult.rows.length,
              availability: snapshot
            })
          ]
        );

        return {
          date: targetDate,
          timezone: appTimezone,
          releaseCount: releaseResult.rows.length,
          availability: snapshot,
          frozenReleases: releaseResult.rows.map((release) => ({
            id: release.id,
            parkingPlaceId: release.parking_place_id,
            parkingPlaceCode: release.parking_place_code,
            placeType: release.place_type,
            ownerUserId: release.owner_user_id
          }))
        };
      } finally {
        client.release();
      }
    });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        ...result
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message,
        jobRun: error.jobRun || null
      }
    };
  }
}

async function handleAdminJobLockDeparturePlans(req) {
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

  const targetDate = body.date || currentDateInTimezone(appTimezone);

  if (!isIsoDate(targetDate)) {
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
    const result = await withJobRun('lock_departure_plans', targetDate, async () => {
      const summary = await queryOne(
        `
          select
            count(*)::int as plans_count,
            count(*) filter (where is_early = true)::int as early_plans_count
          from departure_plans
          where plan_date = $1::date
        `,
        [targetDate]
      );

      await queryOne(
        `
          insert into audit_logs (
            entity_type,
            action,
            actor_service,
            metadata
          )
          values ('system', 'departure_plan_editing_locked', 'admin-web', $1::jsonb)
          returning id
        `,
        [
          JSON.stringify({
            targetDate,
            timezone: appTimezone,
            plansCount: summary?.plans_count || 0,
            earlyPlansCount: summary?.early_plans_count || 0
          })
        ]
      );

      return {
        date: targetDate,
        timezone: appTimezone,
        plansCount: summary?.plans_count || 0,
        earlyPlansCount: summary?.early_plans_count || 0
      };
    });

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        ...result
      }
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        status: 'error',
        service: 'api',
        error: error.message,
        jobRun: error.jobRun || null
      }
    };
  }
}

async function handleAdminJobRunsList(searchParams) {
  const limit = Math.min(Math.max(Number(searchParams.get('limit') || 20), 1), 100);
  const jobName = searchParams.get('jobName');
  const targetDate = searchParams.get('date');

  if (targetDate && !isIsoDate(targetDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  const runs = await queryMany(
    `
      select
        id,
        job_name,
        target_date,
        status,
        started_at,
        finished_at,
        actor_service,
        summary,
        error
      from job_runs
      where ($1::text is null or job_name = $1)
        and ($2::date is null or target_date = $2::date)
      order by started_at desc
      limit $3
    `,
    [jobName || null, targetDate || null, limit]
  );
  const latestSuccessfulRuns = await queryMany(
    `
      select distinct on (job_name)
        id,
        job_name,
        target_date,
        status,
        started_at,
        finished_at,
        actor_service,
        summary,
        error
      from job_runs
      where status = 'success'
        and ($1::text is null or job_name = $1)
      order by job_name, finished_at desc nulls last, started_at desc
    `,
    [jobName || null]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      timezone: appTimezone,
      runs: runs.map(mapJobRun),
      latestSuccessfulRuns: latestSuccessfulRuns.map(mapJobRun)
    }
  };
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
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`manual_assignment:${reservationDate}`]);

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

    const availableReleasedPlacesCount = await countAvailableReleasedPlaces(client, reservationDate);
    if (availableReleasedPlacesCount <= guestReserveMinimum) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: `Manual employee assignment would reduce guest reserve below ${guestReserveMinimum} places`,
          guestReserve: {
            minimum: guestReserveMinimum,
            availablePlaces: availableReleasedPlacesCount
          }
        }
      };
    }

    const warnings = await calculateAssignmentWarnings(client, reservationDate, parkingPlaceId);

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
          reservationDate,
          warnings
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
        },
        warnings
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

async function handleAdminReservationCancel(req) {
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

  const reservationId = body.reservationId;

  if (!reservationId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'reservationId is required'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const reservationResult = await client.query(
      `
        select
          r.id,
          r.reservation_date,
          r.parking_place_id,
          r.user_id,
          r.employee_parking_request_id,
          r.guest_parking_request_id,
          r.source,
          r.status,
          u.display_name as user_display_name,
          pp.code as parking_place_code
        from reservations r
        join parking_places pp on pp.id = r.parking_place_id
        left join users u on u.id = r.user_id
        where r.id = $1
        for update
      `,
      [reservationId]
    );

    const reservation = reservationResult.rows[0];

    if (!reservation) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Reservation not found'
        }
      };
    }

    if (reservation.status === 'canceled') {
      await client.query('rollback');
      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          reservation: {
            id: reservation.id,
            reservationDate: reservation.reservation_date,
            status: reservation.status
          }
        }
      };
    }

    if (reservation.status !== 'active') {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Only active reservations can be canceled'
        }
      };
    }

    const canceledReservationResult = await client.query(
      `
        update reservations
        set
          status = 'canceled',
          canceled_at = now(),
          updated_at = now()
        where id = $1
        returning id, reservation_date, status, canceled_at
      `,
      [reservationId]
    );
    const canceledReservation = canceledReservationResult.rows[0];

    if (reservation.employee_parking_request_id) {
      await client.query(
        `
          update employee_parking_requests
          set
            status = 'queued',
            assigned_reservation_id = null,
            updated_at = now()
          where id = $1
            and status = 'assigned'
        `,
        [reservation.employee_parking_request_id]
      );

      await client.query(
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
        [reservation.employee_parking_request_id]
      );
    }

    if (reservation.guest_parking_request_id) {
      await client.query(
        `
          update guest_parking_requests
          set
            status = 'canceled',
            canceled_at = now(),
            updated_at = now()
          where id = $1
            and status <> 'canceled'
        `,
        [reservation.guest_parking_request_id]
      );
    }

    await client.query(
      `
        insert into reservation_events (
          reservation_id,
          event_type,
          payload,
          source
        )
        values ($1, 'reservation_canceled', $2::jsonb, $3)
      `,
      [
        reservationId,
        JSON.stringify({
          reservationDate: reservation.reservation_date,
          parkingPlaceId: reservation.parking_place_id,
          parkingPlaceCode: reservation.parking_place_code,
          userId: reservation.user_id,
          employeeParkingRequestId: reservation.employee_parking_request_id,
          guestParkingRequestId: reservation.guest_parking_request_id
        }),
        reservation.source
      ]
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
          'reservation_canceled',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        reservationId,
        JSON.stringify({
          reservationDate: reservation.reservation_date,
          parkingPlaceId: reservation.parking_place_id,
          parkingPlaceCode: reservation.parking_place_code,
          userId: reservation.user_id,
          userDisplayName: reservation.user_display_name,
          source: reservation.source
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        reservation: {
          id: canceledReservation.id,
          reservationDate: canceledReservation.reservation_date,
          status: canceledReservation.status,
          canceledAt: canceledReservation.canceled_at
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

async function handleAdminPlaceReleaseCancel(req) {
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

  const releaseId = body.releaseId;

  if (!releaseId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'releaseId is required'
      }
    };
  }

  const client = await pool.connect();

  try {
    await client.query('begin');

    const releaseResult = await client.query(
      `
        select
          pr.id,
          pr.parking_place_id,
          pr.user_id,
          pr.release_during,
          pr.status,
          lower(pr.release_during)::date as date_from,
          (upper(pr.release_during)::date - 1) as date_to,
          u.display_name as user_display_name,
          pp.code as parking_place_code
        from place_releases pr
        join users u on u.id = pr.user_id
        join parking_places pp on pp.id = pr.parking_place_id
        where pr.id = $1
        for update
      `,
      [releaseId]
    );

    const release = releaseResult.rows[0];

    if (!release) {
      await client.query('rollback');
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Place release not found'
        }
      };
    }

    if (release.status === 'canceled') {
      await client.query('rollback');
      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          release: {
            id: release.id,
            status: release.status,
            dateFrom: release.date_from,
            dateTo: release.date_to
          }
        }
      };
    }

    const reservationResult = await client.query(
      `
        select id
        from reservations
        where parking_place_id = $1
          and status = 'active'
          and reservation_date <@ $2::daterange
        limit 1
      `,
      [release.parking_place_id, release.release_during]
    );

    if (reservationResult.rows[0]) {
      await client.query('rollback');
      return {
        statusCode: 409,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Cannot cancel release while it has active reservations'
        }
      };
    }

    const updateResult = await client.query(
      `
        update place_releases
        set
          status = 'canceled',
          canceled_at = now(),
          updated_at = now()
        where id = $1
        returning
          id,
          lower(release_during)::date as date_from,
          (upper(release_during)::date - 1) as date_to,
          status,
          canceled_at
      `,
      [releaseId]
    );
    const canceledRelease = updateResult.rows[0];

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
          'place_release_canceled',
          'admin-web',
          $2::jsonb
        )
      `,
      [
        releaseId,
        JSON.stringify({
          userId: release.user_id,
          userDisplayName: release.user_display_name,
          parkingPlaceId: release.parking_place_id,
          parkingPlaceCode: release.parking_place_code,
          dateFrom: release.date_from,
          dateTo: release.date_to
        })
      ]
    );

    await client.query('commit');

    return {
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        release: {
          id: canceledRelease.id,
          dateFrom: canceledRelease.date_from,
          dateTo: canceledRelease.date_to,
          status: canceledRelease.status,
          canceledAt: canceledRelease.canceled_at
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

function parsePositiveLimit(searchParams, fallback = 100, maximum = 300) {
  const rawLimit = Number(searchParams.get('limit') || fallback);
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(rawLimit), maximum);
}

function mapAuditLog(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    action: row.action,
    actorService: row.actor_service,
    actorUser: row.actor_user_id
      ? {
          id: row.actor_user_id,
          displayName: row.actor_user_display_name
        }
      : null,
    actorAuthUser: row.actor_auth_user_id
      ? {
          id: row.actor_auth_user_id,
          login: row.actor_auth_login,
          displayName: row.actor_auth_display_name
        }
      : null,
    occurredAt: row.occurred_at,
    metadata: row.metadata || {}
  };
}

async function handleAdminAuditLogsList(searchParams) {
  const date = searchParams.get('date');
  const entityType = searchParams.get('entityType');
  const entityId = searchParams.get('entityId');
  const action = searchParams.get('action');
  const actor = searchParams.get('actor');
  const limit = parsePositiveLimit(searchParams, 100, 300);
  const where = [];
  const params = [];

  if (date) {
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
    params.push(date);
    where.push(`al.occurred_at >= $${params.length}::date and al.occurred_at < ($${params.length}::date + interval '1 day')`);
  }

  if (entityType) {
    params.push(entityType);
    where.push(`al.entity_type = $${params.length}`);
  }

  if (entityId) {
    params.push(entityId);
    where.push(`al.entity_id = $${params.length}::uuid`);
  }

  if (action) {
    params.push(`%${action}%`);
    where.push(`al.action ilike $${params.length}`);
  }

  if (actor) {
    params.push(`%${actor}%`);
    where.push(`(
      al.actor_service ilike $${params.length}
      or actor_user.display_name ilike $${params.length}
      or actor_auth.login ilike $${params.length}
      or actor_auth.display_name ilike $${params.length}
    )`);
  }

  params.push(limit);
  const rows = await queryMany(
    `
      select
        al.id,
        al.entity_type,
        al.entity_id,
        al.action,
        al.actor_service,
        al.actor_user_id,
        actor_user.display_name as actor_user_display_name,
        al.actor_auth_user_id,
        actor_auth.login as actor_auth_login,
        actor_auth.display_name as actor_auth_display_name,
        al.occurred_at,
        al.metadata
      from audit_logs al
      left join users actor_user on actor_user.id = al.actor_user_id
      left join auth_users actor_auth on actor_auth.id = al.actor_auth_user_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by al.occurred_at desc
      limit $${params.length}
    `,
    params
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      auditLogs: rows.map(mapAuditLog)
    }
  };
}

function mapContactAccessLog(row) {
  return {
    id: row.id,
    occupancyDate: formatDateForSql(row.occupancy_date),
    resolution: row.resolution,
    createdAt: row.created_at,
    metadata: row.metadata || {},
    requester: {
      id: row.requester_user_id,
      displayName: row.requester_display_name,
      department: row.requester_department,
      email: row.requester_email,
      phone: row.requester_phone
    },
    lineGroup: row.line_group_id
      ? {
          id: row.line_group_id,
          code: row.line_group_code,
          name: row.line_group_name
        }
      : null,
    targetUser: row.target_user_id
      ? {
          id: row.target_user_id,
          displayName: row.target_user_display_name,
          department: row.target_user_department,
          email: row.target_user_email,
          phone: row.target_user_phone
        }
      : null,
    targetGuestParkingRequest: row.target_guest_parking_request_id
      ? {
          id: row.target_guest_parking_request_id,
          guestName: row.target_guest_name,
          hostDisplayName: row.target_guest_host_display_name
        }
      : null
  };
}

async function handleAdminContactAccessLogsList(searchParams) {
  const date = searchParams.get('date');
  const limit = parsePositiveLimit(searchParams, 100, 300);
  const params = [];
  const where = [];

  if (date) {
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
    params.push(date);
    where.push(`cal.occupancy_date = $${params.length}::date`);
  }

  params.push(limit);
  const rows = await queryMany(
    `
      select
        cal.id,
        cal.occupancy_date,
        cal.requester_user_id,
        requester.display_name as requester_display_name,
        requester.department as requester_department,
        requester.email as requester_email,
        requester.phone as requester_phone,
        cal.line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        cal.target_user_id,
        target_user.display_name as target_user_display_name,
        target_user.department as target_user_department,
        target_user.email as target_user_email,
        target_user.phone as target_user_phone,
        cal.target_guest_parking_request_id,
        gpr.guest_name as target_guest_name,
        host.display_name as target_guest_host_display_name,
        cal.resolution,
        cal.created_at,
        cal.metadata
      from contact_access_logs cal
      join users requester on requester.id = cal.requester_user_id
      left join line_groups lg on lg.id = cal.line_group_id
      left join users target_user on target_user.id = cal.target_user_id
      left join guest_parking_requests gpr on gpr.id = cal.target_guest_parking_request_id
      left join users host on host.id = gpr.host_user_id
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by cal.created_at desc
      limit $${params.length}
    `,
    params
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      contactAccessLogs: rows.map(mapContactAccessLog)
    }
  };
}

async function handleAdminLineOccupancyList(searchParams) {
  const occupancyDate = searchParams.get('date') || currentDateInTimezone(appTimezone);

  if (!isIsoDate(occupancyDate)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  const rows = await queryMany(
    `
      select
        lo.id as occupancy_id,
        lo.occupancy_date::text as occupancy_date,
        lo.position,
        lo.subject_type,
        lo.created_at as occupancy_created_at,
        lo.updated_at as occupancy_updated_at,
        lg.id as line_group_id,
        lg.code as line_group_code,
        lg.name as line_group_name,
        lg.capacity as line_group_capacity,
        pp.id as parking_place_id,
        pp.code as parking_place_code,
        pp.title as parking_place_title,
        pp.place_type as parking_place_type,
        u.id as user_id,
        u.display_name as user_display_name,
        u.department as user_department,
        u.email as user_email,
        u.phone as user_phone,
        gpr.id as guest_parking_request_id,
        gpr.guest_name,
        gpr.guest_phone,
        gpr.host_user_id,
        host.display_name as host_display_name,
        r.id as reservation_id,
        r.source as reservation_source
      from line_occupancy lo
      join line_groups lg on lg.id = lo.line_group_id
      join parking_places pp on pp.id = lo.parking_place_id
      left join users u on u.id = lo.user_id
      left join guest_parking_requests gpr on gpr.id = lo.guest_parking_request_id
      left join users host on host.id = gpr.host_user_id
      left join reservations r on r.id = lo.reservation_id
      where lo.occupancy_date = $1::date
      order by lg.floor_label nulls last, lg.code, lo.position
    `,
    [occupancyDate]
  );

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date: occupancyDate,
      occupancy: rows.map(mapLineOccupancy)
    }
  };
}

async function handleAdminPlaceHistory(placeId) {
  const place = await queryOne(
    `
      select id, code, title, floor_label, place_type, is_active
      from parking_places
      where id = $1
        and deleted_at is null
    `,
    [placeId]
  );

  if (!place) {
    return {
      statusCode: 404,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Parking place not found'
      }
    };
  }

  const [permanentAssignments, releases, reservations, movements, auditLogs] = await Promise.all([
    queryMany(
      `
        select
          pa.id,
          lower(pa.valid_during)::text as date_from,
          (upper(pa.valid_during) - interval '1 day')::date::text as date_to,
          pa.created_at,
          pa.notes,
          u.id as user_id,
          u.display_name,
          u.department
        from permanent_assignments pa
        join users u on u.id = pa.user_id
        where pa.parking_place_id = $1
        order by lower(pa.valid_during) desc, pa.created_at desc
        limit 100
      `,
      [placeId]
    ),
    queryMany(
      `
        select
          pr.id,
          lower(pr.release_during)::text as date_from,
          (upper(pr.release_during) - interval '1 day')::date::text as date_to,
          pr.status,
          pr.created_via,
          pr.created_at,
          pr.canceled_at,
          pr.notes,
          u.id as user_id,
          u.display_name,
          u.department
        from place_releases pr
        join users u on u.id = pr.user_id
        where pr.parking_place_id = $1
        order by lower(pr.release_during) desc, pr.created_at desc
        limit 100
      `,
      [placeId]
    ),
    queryMany(
      `
        select
          r.id,
          r.reservation_date::text as reservation_date,
          r.source,
          r.status,
          r.reason,
          r.created_at,
          r.canceled_at,
          u.id as user_id,
          u.display_name,
          u.department,
          gpr.id as guest_parking_request_id,
          gpr.guest_name
        from reservations r
        left join users u on u.id = r.user_id
        left join guest_parking_requests gpr on gpr.id = r.guest_parking_request_id
        where r.parking_place_id = $1
        order by r.reservation_date desc, r.created_at desc
        limit 100
      `,
      [placeId]
    ),
    queryMany(
      `
        select
          pm.id,
          pm.movement_date::text as movement_date,
          pm.movement_type,
          pm.reason,
          pm.created_at,
          from_place.code as from_place_code,
          to_place.code as to_place_code,
          r.source,
          u.display_name as user_display_name,
          gpr.guest_name
        from parking_movements pm
        join reservations r on r.id = pm.reservation_id
        left join parking_places from_place on from_place.id = pm.from_parking_place_id
        join parking_places to_place on to_place.id = pm.to_parking_place_id
        left join users u on u.id = r.user_id
        left join guest_parking_requests gpr on gpr.id = r.guest_parking_request_id
        where pm.from_parking_place_id = $1
           or pm.to_parking_place_id = $1
        order by pm.movement_date desc, pm.created_at desc
        limit 100
      `,
      [placeId]
    ),
    queryMany(
      `
        select
          al.id,
          al.entity_type,
          al.entity_id,
          al.action,
          al.actor_service,
          al.actor_user_id,
          actor_user.display_name as actor_user_display_name,
          al.actor_auth_user_id,
          actor_auth.login as actor_auth_login,
          actor_auth.display_name as actor_auth_display_name,
          al.occurred_at,
          al.metadata
        from audit_logs al
        left join users actor_user on actor_user.id = al.actor_user_id
        left join auth_users actor_auth on actor_auth.id = al.actor_auth_user_id
        where al.entity_id = $1
           or al.metadata->>'parkingPlaceId' = $1::text
        order by al.occurred_at desc
        limit 100
      `,
      [placeId]
    )
  ]);

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      place: {
        id: place.id,
        code: place.code,
        title: place.title,
        floorLabel: place.floor_label,
        placeType: place.place_type,
        isActive: place.is_active
      },
      history: {
        permanentAssignments: permanentAssignments.map((assignment) => ({
          id: assignment.id,
          dateFrom: assignment.date_from,
          dateTo: assignment.date_to,
          createdAt: assignment.created_at,
          notes: assignment.notes,
          user: {
            id: assignment.user_id,
            displayName: assignment.display_name,
            department: assignment.department
          }
        })),
        releases: releases.map((release) => ({
          id: release.id,
          dateFrom: release.date_from,
          dateTo: release.date_to,
          status: release.status,
          createdVia: release.created_via,
          createdAt: release.created_at,
          canceledAt: release.canceled_at,
          notes: release.notes,
          user: {
            id: release.user_id,
            displayName: release.display_name,
            department: release.department
          }
        })),
        reservations: reservations.map((reservation) => ({
          id: reservation.id,
          reservationDate: reservation.reservation_date,
          source: reservation.source,
          status: reservation.status,
          reason: reservation.reason,
          createdAt: reservation.created_at,
          canceledAt: reservation.canceled_at,
          user: reservation.user_id
            ? {
                id: reservation.user_id,
                displayName: reservation.display_name,
                department: reservation.department
              }
            : null,
          guestParkingRequest: reservation.guest_parking_request_id
            ? {
                id: reservation.guest_parking_request_id,
                guestName: reservation.guest_name
              }
            : null
        })),
        movements: movements.map((movement) => ({
          id: movement.id,
          movementDate: movement.movement_date,
          movementType: movement.movement_type,
          reason: movement.reason,
          createdAt: movement.created_at,
          fromPlaceCode: movement.from_place_code,
          toPlaceCode: movement.to_place_code,
          source: movement.source,
          userDisplayName: movement.user_display_name,
          guestName: movement.guest_name
        })),
        auditLogs: auditLogs.map(mapAuditLog)
      }
    }
  };
}

async function handleAdminEmployeeHistory(userId) {
  const employee = await queryOne(
    `
      select id, employee_no, display_name, email, phone, department, yandex_messenger_user_id, created_at
      from users
      where id = $1
        and kind = 'employee'
        and deleted_at is null
    `,
    [userId]
  );

  if (!employee) {
    return {
      statusCode: 404,
      payload: {
        status: 'error',
        service: 'api',
        error: 'Employee not found'
      }
    };
  }

  const [permanentAssignments, releases, employeeRequests, hostedGuestRequests, reservations, lineOccupancy, departurePlans, contactLogs, auditLogs] =
    await Promise.all([
      queryMany(
        `
          select
            pa.id,
            lower(pa.valid_during)::text as date_from,
            (upper(pa.valid_during) - interval '1 day')::date::text as date_to,
            pa.created_at,
            pa.notes,
            pp.id as parking_place_id,
            pp.code as parking_place_code,
            pp.title as parking_place_title
          from permanent_assignments pa
          join parking_places pp on pp.id = pa.parking_place_id
          where pa.user_id = $1
          order by lower(pa.valid_during) desc, pa.created_at desc
          limit 100
        `,
        [userId]
      ),
      queryMany(
        `
          select
            pr.id,
            lower(pr.release_during)::text as date_from,
            (upper(pr.release_during) - interval '1 day')::date::text as date_to,
            pr.status,
            pr.created_via,
            pr.created_at,
            pr.canceled_at,
            pr.notes,
            pp.id as parking_place_id,
            pp.code as parking_place_code
          from place_releases pr
          join parking_places pp on pp.id = pr.parking_place_id
          where pr.user_id = $1
          order by lower(pr.release_during) desc, pr.created_at desc
          limit 100
        `,
        [userId]
      ),
      queryMany(
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
      ),
      queryMany(
        `
          select
            gpr.id,
            gpr.request_date::text as request_date,
            gpr.status,
            gpr.guest_name,
            gpr.guest_phone,
            gpr.vehicle_plate_number,
            gpr.requested_at,
            gpr.canceled_at,
            pp.code as parking_place_code
          from guest_parking_requests gpr
          left join reservations r on r.id = gpr.assigned_reservation_id
          left join parking_places pp on pp.id = r.parking_place_id
          where gpr.host_user_id = $1
          order by gpr.request_date desc, gpr.created_at desc
          limit 100
        `,
        [userId]
      ),
      queryMany(
        `
          select
            r.id,
            r.reservation_date::text as reservation_date,
            r.source,
            r.status,
            r.reason,
            r.created_at,
            r.canceled_at,
            pp.id as parking_place_id,
            pp.code as parking_place_code
          from reservations r
          join parking_places pp on pp.id = r.parking_place_id
          where r.user_id = $1
          order by r.reservation_date desc, r.created_at desc
          limit 100
        `,
        [userId]
      ),
      queryMany(
        `
          select
            lo.id,
            lo.occupancy_date::text as occupancy_date,
            lo.position,
            lo.subject_type,
            lo.created_at,
            lg.code as line_group_code,
            pp.code as parking_place_code
          from line_occupancy lo
          join line_groups lg on lg.id = lo.line_group_id
          join parking_places pp on pp.id = lo.parking_place_id
          where lo.user_id = $1
          order by lo.occupancy_date desc, lo.position
          limit 100
        `,
        [userId]
      ),
      queryMany(
        `
          select id, plan_date::text as plan_date, departure_time::text as departure_time, is_early, created_at, updated_at
          from departure_plans
          where user_id = $1
          order by plan_date desc
          limit 100
        `,
        [userId]
      ),
      queryMany(
        `
          select
            cal.id,
            cal.occupancy_date,
            cal.requester_user_id,
            requester.display_name as requester_display_name,
            requester.department as requester_department,
            requester.email as requester_email,
            requester.phone as requester_phone,
            cal.line_group_id,
            lg.code as line_group_code,
            lg.name as line_group_name,
            cal.target_user_id,
            target_user.display_name as target_user_display_name,
            target_user.department as target_user_department,
            target_user.email as target_user_email,
            target_user.phone as target_user_phone,
            cal.target_guest_parking_request_id,
            gpr.guest_name as target_guest_name,
            host.display_name as target_guest_host_display_name,
            cal.resolution,
            cal.created_at,
            cal.metadata
          from contact_access_logs cal
          join users requester on requester.id = cal.requester_user_id
          left join line_groups lg on lg.id = cal.line_group_id
          left join users target_user on target_user.id = cal.target_user_id
          left join guest_parking_requests gpr on gpr.id = cal.target_guest_parking_request_id
          left join users host on host.id = gpr.host_user_id
          where cal.requester_user_id = $1
             or cal.target_user_id = $1
          order by cal.created_at desc
          limit 100
        `,
        [userId]
      ),
      queryMany(
        `
          select
            al.id,
            al.entity_type,
            al.entity_id,
            al.action,
            al.actor_service,
            al.actor_user_id,
            actor_user.display_name as actor_user_display_name,
            al.actor_auth_user_id,
            actor_auth.login as actor_auth_login,
            actor_auth.display_name as actor_auth_display_name,
            al.occurred_at,
            al.metadata
          from audit_logs al
          left join users actor_user on actor_user.id = al.actor_user_id
          left join auth_users actor_auth on actor_auth.id = al.actor_auth_user_id
          where al.entity_id = $1
             or al.actor_user_id = $1
             or al.metadata->>'userId' = $1::text
             or al.metadata->>'hostUserId' = $1::text
          order by al.occurred_at desc
          limit 100
        `,
        [userId]
      )
    ]);

  return {
    statusCode: 200,
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
      },
      history: {
        permanentAssignments: permanentAssignments.map((assignment) => ({
          id: assignment.id,
          dateFrom: assignment.date_from,
          dateTo: assignment.date_to,
          createdAt: assignment.created_at,
          notes: assignment.notes,
          parkingPlace: {
            id: assignment.parking_place_id,
            code: assignment.parking_place_code,
            title: assignment.parking_place_title
          }
        })),
        releases: releases.map((release) => ({
          id: release.id,
          dateFrom: release.date_from,
          dateTo: release.date_to,
          status: release.status,
          createdVia: release.created_via,
          createdAt: release.created_at,
          canceledAt: release.canceled_at,
          notes: release.notes,
          parkingPlace: {
            id: release.parking_place_id,
            code: release.parking_place_code
          }
        })),
        employeeRequests: employeeRequests.map((request) => ({
          id: request.id,
          requestDate: request.request_date,
          status: request.status,
          requestedAt: request.requested_at,
          canceledAt: request.canceled_at,
          notes: request.notes,
          queueEntry: request.queue_position
            ? {
                position: request.queue_position,
                status: request.queue_status
              }
            : null,
          parkingPlaceCode: request.parking_place_code
        })),
        hostedGuestRequests: hostedGuestRequests.map((request) => ({
          id: request.id,
          requestDate: request.request_date,
          status: request.status,
          guestName: request.guest_name,
          guestPhone: request.guest_phone,
          vehiclePlateNumber: request.vehicle_plate_number,
          requestedAt: request.requested_at,
          canceledAt: request.canceled_at,
          parkingPlaceCode: request.parking_place_code
        })),
        reservations: reservations.map((reservation) => ({
          id: reservation.id,
          reservationDate: reservation.reservation_date,
          source: reservation.source,
          status: reservation.status,
          reason: reservation.reason,
          createdAt: reservation.created_at,
          canceledAt: reservation.canceled_at,
          parkingPlace: {
            id: reservation.parking_place_id,
            code: reservation.parking_place_code
          }
        })),
        lineOccupancy: lineOccupancy.map((occupancy) => ({
          id: occupancy.id,
          occupancyDate: occupancy.occupancy_date,
          position: occupancy.position,
          subjectType: occupancy.subject_type,
          createdAt: occupancy.created_at,
          lineGroupCode: occupancy.line_group_code,
          parkingPlaceCode: occupancy.parking_place_code
        })),
        departurePlans: departurePlans.map((plan) => ({
          id: plan.id,
          planDate: plan.plan_date,
          departureTime: plan.departure_time,
          isEarly: plan.is_early,
          createdAt: plan.created_at,
          updatedAt: plan.updated_at
        })),
        contactAccessLogs: contactLogs.map(mapContactAccessLog),
        auditLogs: auditLogs.map(mapAuditLog)
      }
    }
  };
}

const routeApiRequest = createApiRouter({
  handlers: {
    handleAdminAuditLogsList,
    handleAdminAvailability,
    handleAdminContactAccessLogsList,
    handleAdminDashboard,
    handleAdminEmployeeCreate,
    handleAdminEmployeeDisable,
    handleAdminEmployeeHistory,
    handleAdminEmployeeParkingRequestCancel,
    handleAdminEmployeeParkingRequestCreate,
    handleAdminEmployeeParkingRequestsList,
    handleAdminEmployeesList,
    handleAdminEmployeeUpdate,
    handleAdminGuestParkingRequestAssign,
    handleAdminGuestParkingRequestCancel,
    handleAdminGuestParkingRequestCreate,
    handleAdminGuestParkingRequestsList,
    handleAdminJobFreezeNextDay,
    handleAdminJobLockDeparturePlans,
    handleAdminJobProcessQueue,
    handleAdminJobRunsList,
    handleAdminLineGroupOccupancy,
    handleAdminLineGroupsList,
    handleAdminLineOccupancyList,
    handleAdminManualReservationCreate,
    handleAdminMapZoneDelete,
    handleAdminMapBackgroundUpdate,
    handleAdminMapDiagnostics,
    handleAdminMapZoneSave,
    handleAdminMapZonesList,
    handleAdminMapZoneUpdate,
    handleAdminParkingPlaceCreate,
    handleAdminParkingPlaceDisable,
    handleAdminParkingPlaceUpdate,
    handleAdminPermanentAssignmentCreate,
    handleAdminPermanentAssignmentEnd,
    handleAdminPermanentAssignmentsList,
    handleAdminPlaceHistory,
    handleAdminPlaceReleaseCancel,
    handleAdminPlaceReleaseCreate,
    handleAdminPlaceReleasesList,
    handleAdminPlacesList,
    handleAdminQueueProcess,
    handleAdminReservationCancel,
    handleAdminUsersList,
    handleAuthBootstrapStatus,
    handleBotBlockingContacts,
    handleConflictsList,
    handleDbHealth,
    handleDeparturePlansList,
    handleDeparturePlanUpsert,
    handleLineOccupancySet
  },
  sendJson,
  startedAt
});

const server = http.createServer(routeApiRequest);

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
