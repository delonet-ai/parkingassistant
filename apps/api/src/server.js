'use strict';

const http = require('node:http');
const { Pool } = require('pg');
const { addDaysToIsoDate, currentDateInTimezone, currentTimeInTimezone, formatDateForSql, isEarlyDeparture, isIsoDate, isValidTime } = require('../../../packages/shared/dates');
const { normalizeApiErrorPayload } = require('../../../packages/shared/errors');
const { readJsonBody, sendJson: writeJson } = require('../../../packages/shared/http');
const { createDbRepository, withTransaction } = require('./repositories/db');
const auditRepository = require('./modules/audit/repository');
const conflictsRepository = require('./modules/conflicts/repository');
const contactAccessRepository = require('./modules/contact-access/repository');
const departurePlansRepository = require('./modules/departure-plans/repository');
const employeeRequestsRepository = require('./modules/employee-requests/repository');
const employeesRepository = require('./modules/employees/repository');
const jobsRepository = require('./modules/jobs/repository');
const lineOccupancyRepository = require('./modules/line-occupancy/repository');
const mapsRepository = require('./modules/maps/repository');
const permanentAssignmentsRepository = require('./modules/permanent-assignments/repository');
const guestRequestsRepository = require('./modules/guest-requests/repository');
const placeLinesRepository = require('./modules/place-lines/repository');
const placeReleasesRepository = require('./modules/place-releases/repository');
const placesRepository = require('./modules/places/repository');
const queueRepository = require('./modules/queue/repository');
const reservationsRepository = require('./modules/reservations/repository');
const systemRepository = require('./modules/system/repository');
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

// `withTransaction` never inspects what the callback returns, so a handler that wants to
// roll back and still answer with a normal payload throws this instead of returning it.
// The caller re-reads the payload off the error; every other error keeps its own mapping.
class AbortTransaction extends Error {
  constructor(result) {
    super('transaction aborted');
    this.name = 'AbortTransaction';
    this.result = result;
  }
}

function abortWith(statusCode, error, extra = {}) {
  return new AbortTransaction({
    statusCode,
    payload: {
      status: 'error',
      service: 'api',
      error,
      ...extra
    }
  });
}

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
  const started = await jobsRepository.startJobRun(dbRepository, { jobName, targetDate });

  try {
    const payload = await runner();
    const finished = await jobsRepository.markJobRunSucceeded(dbRepository, {
      jobRunId: started.id,
      summary: payload
    });

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'system',
      action: `job_${jobName}_success`,
      actorService: 'admin-web',
      metadata: {
        jobRunId: started.id,
        jobName,
        targetDate,
        summary: payload
      }
    });

    return {
      ...payload,
      jobRun: mapJobRun(finished)
    };
  } catch (error) {
    const failed = await jobsRepository.markJobRunFailed(dbRepository, {
      jobRunId: started.id,
      error: error.message
    });

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'system',
      action: `job_${jobName}_failed`,
      actorService: 'admin-web',
      metadata: {
        jobRunId: started.id,
        jobName,
        targetDate,
        error: error.message
      }
    });

    error.jobRun = mapJobRun(failed);
    throw error;
  }
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
    const identity = await systemRepository.selectDatabaseIdentity(dbRepository);

    return {
      ok: true,
      statusCode: 200,
      payload: {
        status: 'ok',
        service: 'api',
        check: 'db',
        database: identity.database,
        serverTime: identity.server_time
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
    const sysadmin = await systemRepository.findBootstrapSysadmin(dbRepository);

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
    const users = await systemRepository.listAuthUsers(dbRepository);

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

  try {
    const employees = await employeesRepository.listEmployeesWithPermanentPlace(dbRepository, date);

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
    const employee = await employeesRepository.insertEmployee(dbRepository, {
      firstName,
      lastName,
      displayName,
      email,
      phone,
      department,
      yandexMessengerUserId
    });

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'user',
      entityId: employee.id,
      action: 'employee_created',
      actorService: 'admin-web',
      metadata: {
        displayName,
        email,
        phone,
        department,
        yandexMessengerUserId
      }
    });

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
    const employee = await employeesRepository.updateEmployee(dbRepository, {
      employeeId,
      firstName,
      lastName,
      displayName,
      email,
      phone,
      department,
      yandexMessengerUserId,
      isActive
    });

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

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'user',
      entityId: employeeId,
      action: 'employee_updated',
      actorService: 'admin-web',
      metadata: {
        displayName,
        email,
        phone,
        department,
        yandexMessengerUserId,
        isActive
      }
    });

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

  const employee = await employeesRepository.disableEmployee(dbRepository, employeeId);

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

  await auditRepository.insertAuditLog(dbRepository, {
    entityType: 'user',
    entityId: employeeId,
    action: 'employee_disabled',
    actorService: 'admin-web',
    metadata: {
      displayName: employee.display_name
    }
  });

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
    const places = await placesRepository.listPlacesWithOwnerAndLine(dbRepository);

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
          placeRole: place.place_role,
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
  // Absent placeRole means "leave it alone" — the field is optional on this endpoint.
  const placeRole = PLACE_ROLES.includes(body.placeRole) ? body.placeRole : null;

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

  // is_active is deliberately NOT writable here. Removing a place from service goes
  // through /admin/place-lines/archive and nowhere else; a single slot is taken out of
  // rotation with place_role = 'blocked'. Two write paths to one column is the drift
  // this endpoint used to have with the now-deleted /admin/places/disable.
  try {
    const place = await placesRepository.updatePlace(dbRepository, {
      placeId,
      code,
      title,
      floorLabel,
      placeType,
      lineGroupId,
      linePositionHint,
      guestPriorityRank,
      placeRole
    });

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

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'parking_place',
      entityId: placeId,
      action: 'parking_place_updated',
      actorService: 'admin-web',
      metadata: {
        code,
        title,
        floorLabel,
        placeType,
        lineGroupId,
        linePositionHint,
        guestPriorityRank,
        placeRole
      }
    });

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

  const rows = await permanentAssignmentsRepository.listPermanentAssignments(dbRepository, { date, status });

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
    const assignment = await permanentAssignmentsRepository.insertPermanentAssignment(dbRepository, {
      userId,
      parkingPlaceId,
      dateFrom,
      dateTo,
      notes
    });

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'permanent_assignment',
      entityId: assignment.id,
      action: 'permanent_assignment_created',
      actorService: 'admin-web',
      metadata: {
        userId,
        parkingPlaceId,
        dateFrom,
        dateTo,
        notes
      }
    });

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

  const assignment = await permanentAssignmentsRepository.endPermanentAssignment(dbRepository, { assignmentId, dateTo });

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

  await auditRepository.insertAuditLog(dbRepository, {
    entityType: 'permanent_assignment',
    entityId: assignmentId,
    action: 'permanent_assignment_ended',
    actorService: 'admin-web',
    metadata: {
      userId: assignment.user_id,
      parkingPlaceId: assignment.parking_place_id,
      dateTo
    }
  });

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
  const groups = await placeLinesRepository.listLineGroupsWithPlaces(dbRepository);

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
  return lineOccupancyRepository.listOccupancyForLineAndDate(dbRepository, { lineGroupId, occupancyDate });
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

  const lineGroup = await placeLinesRepository.findLineGroupById(dbRepository, lineGroupId);

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

  try {
    const occupancyId = await withTransaction(pool, async (repo) => {
      await lineOccupancyRepository.lockLineForDate(repo, { lineGroupId, occupancyDate });

      const place = await placesRepository.findPlaceInLineForUpdate(repo, { parkingPlaceId, lineGroupId });

      if (!place) {
        throw abortWith(404, 'Parking place is not attached to the selected line group');
      }

      if (position > place.capacity) {
        throw abortWith(400, `Position ${position} exceeds line capacity ${place.capacity}`);
      }

      const reservation = await reservationsRepository.findActiveReservationOnPlaceDate(repo, {
        parkingPlaceId,
        reservationDate: occupancyDate
      });

      if (reservation && subjectType === 'employee' && reservation.user_id && reservation.user_id !== userId) {
        throw abortWith(409, 'Active reservation on this place belongs to another user');
      }

      if (reservation && subjectType === 'guest' && reservation.guest_parking_request_id && reservation.guest_parking_request_id !== guestParkingRequestId) {
        throw abortWith(409, 'Active reservation on this place belongs to another guest request');
      }

      await lineOccupancyRepository.deleteOccupancyForSubject(repo, {
        occupancyDate,
        subjectType,
        userId,
        guestParkingRequestId
      });

      const reservationId = reservation?.id || body.reservationId || null;
      const occupancy = await lineOccupancyRepository.insertOccupancy(repo, {
        occupancyDate,
        lineGroupId,
        parkingPlaceId,
        position,
        subjectType,
        userId,
        guestParkingRequestId,
        reservationId
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'line_occupancy',
        entityId: occupancy.id,
        action: 'line_position_set',
        actorService,
        metadata: {
          occupancyDate,
          lineGroupId,
          parkingPlaceId,
          parkingPlaceCode: place.code,
          position,
          subjectType,
          userId,
          guestParkingRequestId,
          reservationId
        }
      });

      return occupancy.id;
    });

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
    if (error instanceof AbortTransaction) {
      return error.result;
    }

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

  // Deliberately not a transaction: the original ran these on one pooled client without
  // ever issuing `begin`, so each log row committed on its own. Reading a contact and
  // recording that it was read are independent facts, and a failure part-way through
  // should keep the rows already written.
  const requester = await lineOccupancyRepository.findEmployeeOccupancy(dbRepository, {
    occupancyDate,
    userId: requesterUserId
  });

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

  const blockers = await lineOccupancyRepository.listBlockersAhead(dbRepository, {
    occupancyDate,
    lineGroupId: requester.line_group_id,
    position: requester.position
  });

  if (!blockers.length) {
    await contactAccessRepository.insertNoBlockersLog(dbRepository, {
      requesterUserId,
      occupancyDate,
      lineGroupId: requester.line_group_id,
      metadata: {
        requesterPosition: requester.position
      }
    });
  }

  const contacts = [];

  for (const blocker of blockers) {
    const resolution = blocker.subject_type === 'guest' ? 'guest_contact_via_admin' : 'employee_contact_shown';

    await contactAccessRepository.insertContactAccessLog(dbRepository, {
      requesterUserId,
      occupancyDate,
      lineGroupId: requester.line_group_id,
      targetUserId: blocker.user_id,
      targetGuestParkingRequestId: blocker.guest_parking_request_id,
      resolution,
      metadata: {
        requesterPosition: requester.position,
        blockerPosition: blocker.position,
        blockerSubjectType: blocker.subject_type
      }
    });

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
}

async function calculateAssignmentWarnings(repo, reservationDate, parkingPlaceId) {
  const place = await placesRepository.findPlaceLineContext(repo, parkingPlaceId);

  if (!place?.line_group_id) {
    return [];
  }

  const risks = await conflictsRepository.listEarlyDepartureRisksBehind(repo, {
    reservationDate,
    lineGroupId: place.line_group_id,
    linePositionHint: place.line_position_hint
  });

  return risks.map((risk) => ({
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
  const rows = await departurePlansRepository.listPlansForDate(dbRepository, date);

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
  const rows = await conflictsRepository.listConflictsForDate(dbRepository, date);

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

  try {
    return await withTransaction(pool, async (repo) => {
      const user = await employeesRepository.findEmployeeById(repo, userId);

      if (!user) {
        throw abortWith(404, 'Employee not found');
      }

      const multiLinePlace = await placesRepository.findMultiLinePlaceForUser(repo, { userId, planDate });

      if (!multiLinePlace) {
        throw abortWith(
          409,
          'Departure time can be set only for users with a multi-line place or multi-line reservation on this date'
        );
      }

      // The wall-clock 07:00 check above only covers "today in APP_TIMEZONE".
      // lock-departure-plans persists the same decision, so a plan stays locked
      // across a day rollover and the rule can be replayed on any date.
      const lockedPlan = await departurePlansRepository.findLockedPlan(repo, { userId, planDate });

      if (lockedPlan) {
        throw abortWith(409, 'Departure plan editing is locked for this date', {
          lockedAt: lockedPlan.locked_at,
          timezone: appTimezone
        });
      }

      const plan = await departurePlansRepository.upsertPlan(repo, {
        userId,
        planDate,
        departureTime,
        isEarly: isEarlyDeparture(departureTime)
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'departure_plan',
        entityId: plan.id,
        action: 'departure_plan_upserted',
        actorUserId: userId,
        actorService,
        metadata: {
          userId,
          userDisplayName: user.display_name,
          planDate,
          departureTime,
          isEarly: plan.is_early
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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

// Inventory diagnostics for the Места tab.
//
// The floor plan is a static reference image and carries no data, so nothing about it
// can be diagnosed. What can still drift is the line invariant: every place belongs to
// a line, and a line's capacity equals the number of active slots in it.
async function handleAdminMapDiagnostics(searchParams) {
  const mapCode = searchParams.get('mapCode');

  const maps = await mapsRepository.listMaps(dbRepository, mapCode);
  const placeWithoutLine = await placeLinesRepository.listPlacesWithoutLine(dbRepository);
  const lineCapacityMismatch = await placeLinesRepository.listLinesWithCapacityMismatch(dbRepository);

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      maps: maps.map(mapParkingPlaceMap),
      diagnostics: {
        placeWithoutLine: placeWithoutLine.map((item) => ({
          parkingPlace: {
            id: item.id,
            code: item.code,
            title: item.title,
            floorLabel: item.floor_label,
            placeType: item.place_type
          }
        })),
        lineCapacityMismatch: lineCapacityMismatch.map((item) => ({
          lineId: item.id,
          code: item.code,
          name: item.name,
          floorLabel: item.floor_label,
          capacity: item.capacity,
          slotCount: item.slot_count
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

  try {
    return await withTransaction(pool, async (repo) => {
      const map = await mapsRepository.upsertMapBackground(repo, {
        mapCode,
        mapTitle: mapTitle || mapCode.toUpperCase(),
        floorLabel: floorLabel || mapCode.replace(/^g/i, ''),
        fileType,
        filePath,
        sourceChecksum
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place_map',
        entityId: map.id,
        action: 'parking_place_map_background_replaced',
        actorService: 'admin-web',
        metadata: {
          mapCode,
          filePath,
          fileType,
          sourceChecksum,
          version: map.version
        }
      });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          map: mapParkingPlaceMap(map)
        }
      };
    });
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

// ---------------------------------------------------------------------------
// Place inventory (Task 9).
//
// An "element" is a parking line holding 1..3 slots: the line_groups row is the
// element, its parking_places rows are the slots. line_groups.capacity is the
// source of truth for the element size and parking_places.place_type is derived
// from it — the derivation lives in the assign_place_lines() database function
// (packages/db/schema/005_place_inventory.sql), shared with the catalog import,
// so there is exactly one implementation of the rule.
//
// These endpoints are a line-level composition over the per-place ones, not a
// parallel API: attribute edits still go to /admin/places/update, and taking a
// single slot out of service is place_role = 'blocked'. Adding and removing
// places happens here and only here — /admin/place-lines/archive is the single
// write path to parking_places.is_active.
// ---------------------------------------------------------------------------

const PLACE_ROLES = ['regular', 'rotatable', 'blocked'];
const PLACE_TYPE_BY_CAPACITY = { 1: 'single', 2: 'double', 3: 'triple' };

/**
 * Slot status, in the precedence the legend uses:
 * occupied → guest → released → blocked → rotatable → free.
 * The last two come from parking_places.place_role.
 */
function placeSlotStatus(row) {
  if (row.reservation_id) {
    return row.reservation_source === 'guest' ? 'guest' : 'occupied';
  }

  if (row.release_id) {
    return 'released';
  }

  if (row.place_role === 'blocked') {
    return 'blocked';
  }

  if (row.place_role === 'rotatable') {
    return 'rotatable';
  }

  return 'free';
}

function normalizePlaceRole(value, fallback = 'regular') {
  return PLACE_ROLES.includes(value) ? value : fallback;
}

/** Guest priority is a smallint rank; an empty value means "not in the guest pool". */
function normalizeGuestPriorityRank(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const rank = Number(value);

  return Number.isInteger(rank) && rank >= 1 && rank <= 99 ? rank : undefined;
}

async function handleAdminPlaceLinesList(searchParams) {
  const floor = normalizeOptionalString(searchParams.get('floor'));
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

  const rows = await placeLinesRepository.listPlaceLineSlots(dbRepository, { date, floor });

  const lines = [];
  const byLineId = new Map();

  for (const row of rows) {
    let line = byLineId.get(row.line_id);

    if (!line) {
      line = {
        lineId: row.line_id,
        code: row.line_code,
        name: row.line_name,
        capacity: row.capacity,
        floorLabel: row.floor_label,
        displayOrder: row.display_order,
        slots: []
      };
      byLineId.set(row.line_id, line);
      lines.push(line);
    }

    line.slots.push({
      placeId: row.place_id,
      code: row.place_code,
      title: row.place_title,
      placeType: row.place_type,
      position: row.line_position_hint,
      placeRole: row.place_role,
      guestPriorityRank: row.guest_priority_rank,
      status: placeSlotStatus(row),
      userDisplayName: row.user_display_name || null
    });
  }

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      date,
      floor: floor || null,
      lines
    }
  };
}

async function handleAdminPlaceLineCreate(req) {
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

  const floorLabel = normalizeOptionalString(body.floorLabel);
  const capacity = Number(body.capacity);
  const rawSlots = Array.isArray(body.slots) ? body.slots : [];

  if (!floorLabel) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'floorLabel is required'
      }
    };
  }

  if (![1, 2, 3].includes(capacity)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'capacity must be 1, 2 or 3'
      }
    };
  }

  if (rawSlots.length !== capacity) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: `slots must contain exactly ${capacity} entries to match capacity`
      }
    };
  }

  const slots = [];

  for (const rawSlot of rawSlots) {
    const code = typeof rawSlot?.code === 'string' ? rawSlot.code.trim() : '';
    const title = typeof rawSlot?.title === 'string' && rawSlot.title.trim() ? rawSlot.title.trim() : code;
    const guestPriorityRank = normalizeGuestPriorityRank(rawSlot?.guestPriorityRank);

    if (!code) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'every slot needs a code'
        }
      };
    }

    if (guestPriorityRank === undefined) {
      return {
        statusCode: 400,
        payload: {
          status: 'error',
          service: 'api',
          error: 'guestPriorityRank must be an integer between 1 and 99'
        }
      };
    }

    slots.push({
      code,
      title,
      placeRole: normalizePlaceRole(rawSlot?.placeRole),
      guestPriorityRank
    });
  }

  const duplicate = slots.find((slot, index) => slots.findIndex((other) => other.code === slot.code) !== index);

  if (duplicate) {
    return {
      statusCode: 409,
      payload: {
        status: 'error',
        service: 'api',
        error: `Duplicate place code in request: ${duplicate.code}`
      }
    };
  }

  const lineCode = `line-${floorLabel}-${slots[0].code}`;

  try {
    const stored = await withTransaction(pool, async (repo) => {
      const line = await placeLinesRepository.insertLineGroup(repo, {
        code: lineCode,
        name: `Линия ${floorLabel} / ${slots[0].code}`,
        capacity,
        floorLabel,
        notes: `${PLACE_TYPE_BY_CAPACITY[capacity]} element`
      });

      for (const [index, slot] of slots.entries()) {
        await placeLinesRepository.insertSlot(repo, {
          code: slot.code,
          title: slot.title,
          floorLabel,
          placeType: PLACE_TYPE_BY_CAPACITY[capacity],
          placeRole: slot.placeRole,
          lineGroupId: line.id,
          linePositionHint: index + 1,
          guestPriorityRank: slot.guestPriorityRank
        });
      }

      await placeLinesRepository.assignPlaceLines(repo);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place',
        entityId: line.id,
        action: 'place_line_created',
        actorService: 'admin-web',
        metadata: {
          lineCode,
          capacity,
          floorLabel,
          slots: slots.map((slot) => ({
            code: slot.code,
            placeRole: slot.placeRole,
            guestPriorityRank: slot.guestPriorityRank
          }))
        }
      });

      return placeLinesRepository.listSlotsForLine(repo, line.id);
    });

    return {
      statusCode: 201,
      payload: {
        status: 'ok',
        service: 'api',
        line: {
          lineId: stored[0].line_id,
          code: stored[0].line_code,
          name: stored[0].line_name,
          capacity: stored[0].capacity,
          floorLabel: stored[0].floor_label,
          displayOrder: stored[0].display_order,
          slots: stored.map((row) => ({
            placeId: row.place_id,
            code: row.place_code,
            title: row.place_title,
            placeType: row.place_type,
            position: row.line_position_hint,
            placeRole: row.place_role,
            guestPriorityRank: row.guest_priority_rank,
            status: placeSlotStatus(row),
            userDisplayName: null
          }))
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
          error: 'A parking place or line with the same code already exists'
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

async function handleAdminPlaceLineArchive(req) {
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

  const lineId = normalizeOptionalString(body.lineId);

  if (!lineId) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'lineId is required'
      }
    };
  }

  const today = currentDateInTimezone(appTimezone);

  try {
    return await withTransaction(pool, async (repo) => {
      const line = await placeLinesRepository.findLineForUpdate(repo, lineId);

      if (!line || line.archived_at) {
        throw abortWith(404, 'Parking line not found');
      }

      const blockerRows = await placeLinesRepository.listArchiveBlockers(repo, { lineId, today });

      if (blockerRows.length > 0) {
        throw abortWith(409, 'Parking line still has active reservations or permanent assignments', {
          blockers: blockerRows.map((row) => ({
            type: row.blocker_type,
            placeCode: row.place_code,
            detail: row.detail,
            userDisplayName: row.user_display_name || null
          }))
        });
      }

      const archived = await placeLinesRepository.archiveSlotsOfLine(repo, lineId);
      await placeLinesRepository.archiveLine(repo, lineId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'parking_place',
        entityId: lineId,
        action: 'place_line_archived',
        actorService: 'admin-web',
        metadata: {
          lineCode: line.code,
          capacity: line.capacity,
          floorLabel: line.floor_label,
          archivedPlaceCodes: archived.map((row) => row.code)
        }
      });

      return {
        statusCode: 200,
        payload: {
          status: 'ok',
          service: 'api',
          line: {
            lineId: line.id,
            code: line.code,
            capacity: line.capacity,
            floorLabel: line.floor_label
          },
          archivedPlaces: archived.map((row) => ({
            placeId: row.id,
            code: row.code,
            title: row.title
          }))
        }
      };
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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
async function handleAdminDashboard(searchParams) {
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

  const [releasedPlaces, reservations, guestRequests, guestReserve] = await Promise.all([
    placeReleasesRepository.listActiveReleasesForDate(dbRepository, date),
    reservationsRepository.listActiveReservationsForDate(dbRepository, date),
    guestRequestsRepository.listGuestRequestsForDate(dbRepository, date),
    placeReleasesRepository.countUnreservedReleasedPlaces(dbRepository, date)
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

  const availability = await calculateAvailabilitySnapshot(dbRepository, date, { appTimezone, guestReserveMinimum });

  return {
    statusCode: 200,
    payload: {
      status: 'ok',
      service: 'api',
      availability
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

  const releases = await placeReleasesRepository.listReleasesInRange(dbRepository, {
    dateFrom: dateFrom || null,
    dateTo: dateTo || dateFrom || null
  });

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

  const requests = await employeeRequestsRepository.listRequestsForDate(dbRepository, requestDate || null);

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

  try {
    return await withTransaction(pool, async (repo) => {
      await queueRepository.lockEmployeeQueueForDate(repo, requestDate);

      const employee = await employeesRepository.findEmployeeById(repo, userId);

      if (!employee) {
        throw abortWith(404, 'Employee not found');
      }

      const permanentAssignment = await permanentAssignmentsRepository.findActiveAssignmentForUserDate(repo, {
        userId,
        date: requestDate
      });

      if (permanentAssignment) {
        throw abortWith(409, 'Employee has a permanent parking place for the selected date');
      }

      const parkingRequest = await employeeRequestsRepository.insertRequest(repo, { userId, requestDate, notes });

      const position = await queueRepository.nextQueuePosition(repo, requestDate);
      const queuePosition = Number(position.next_position);

      const queueEntry = await queueRepository.insertQueueEntry(repo, {
        employeeParkingRequestId: parkingRequest.id,
        queueDate: requestDate,
        queuePosition
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'employee_parking_request',
        entityId: parkingRequest.id,
        action: 'employee_parking_request_created',
        actorService: 'admin-web',
        metadata: {
          userId,
          userDisplayName: employee.display_name,
          requestDate,
          queueEntryId: queueEntry.id,
          queuePosition
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
    }

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

  try {
    return await withTransaction(pool, async (repo) => {
      const parkingRequest = await employeeRequestsRepository.findRequestForUpdate(repo, requestId);

      if (!parkingRequest) {
        throw abortWith(404, 'Employee parking request not found');
      }

      if (parkingRequest.assigned_reservation_id) {
        throw abortWith(409, 'Assigned requests cannot be canceled here yet');
      }

      if (parkingRequest.status === 'canceled') {
        throw new AbortTransaction({
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
        });
      }

      const canceledRequest = await employeeRequestsRepository.cancelRequest(repo, requestId);
      await queueRepository.cancelWaitingEntriesForRequest(repo, requestId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'employee_parking_request',
        entityId: requestId,
        action: 'employee_parking_request_canceled',
        actorService: 'admin-web',
        metadata: {
          requestDate: parkingRequest.request_date,
          userDisplayName: parkingRequest.user_display_name
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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

  const requests = await guestRequestsRepository.listGuestRequests(dbRepository, requestDate || null);

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

  try {
    return await withTransaction(pool, async (repo) => {
      await guestRequestsRepository.lockGuestAssignmentForDate(repo, requestDate);

      const host = await guestRequestsRepository.findActiveHost(repo, hostUserId);

      if (!host) {
        throw abortWith(404, 'Host employee not found');
      }

      const place = await placeReleasesRepository.findPlaceForGuestAssignment(repo, requestDate);

      if (!place) {
        throw abortWith(409, 'No released parking place is available for guest assignment on this date');
      }

      const warnings = await calculateAssignmentWarnings(repo, requestDate, place.parking_place_id);

      const { firstName, lastName } = splitDisplayName(guestName);
      const guest = await guestRequestsRepository.insertGuestUser(repo, {
        firstName,
        lastName,
        displayName: guestName,
        phone: guestPhone
      });

      const guestRequest = await guestRequestsRepository.insertAssignedGuestRequest(repo, {
        guestUserId: guest.id,
        hostUserId,
        requestDate,
        guestName,
        guestPhone,
        vehiclePlateNumber,
        notes
      });

      const reservation = await reservationsRepository.insertReservation(repo, {
        reservationDate: requestDate,
        parkingPlaceId: place.parking_place_id,
        userId: guest.id,
        guestParkingRequestId: guestRequest.id,
        source: 'guest',
        reason: `Guest assignment hosted by ${host.display_name}`
      });

      await guestRequestsRepository.attachReservation(repo, {
        guestRequestId: guestRequest.id,
        reservationId: reservation.id
      });

      await reservationsRepository.insertReservationEvent(repo, {
        reservationId: reservation.id,
        eventType: 'reservation_created',
        source: 'guest',
        payload: {
          releaseId: place.release_id,
          guestParkingRequestId: guestRequest.id,
          guestUserId: guest.id,
          guestName,
          hostUserId,
          hostDisplayName: host.display_name,
          parkingPlaceId: place.parking_place_id,
          requestDate
        }
      });

      await reservationsRepository.insertMovement(repo, {
        reservationId: reservation.id,
        movementDate: requestDate,
        toParkingPlaceId: place.parking_place_id,
        movementType: 'guest_assignment',
        reason: `Guest assignment hosted by ${host.display_name}`
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'guest_parking_request',
        entityId: guestRequest.id,
        action: 'guest_parking_request_created_and_assigned',
        actorService: 'admin-web',
        metadata: {
          guestUserId: guest.id,
          guestName,
          hostUserId,
          hostDisplayName: host.display_name,
          reservationId: reservation.id,
          parkingPlaceId: place.parking_place_id,
          parkingPlaceCode: place.parking_place_code,
          requestDate,
          warnings
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
    }

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

  try {
    return await withTransaction(pool, async (repo) => {
      const guestRequest = await guestRequestsRepository.findGuestRequestForUpdate(repo, requestId);

      if (!guestRequest) {
        throw abortWith(404, 'Guest parking request not found');
      }

      if (guestRequest.status === 'canceled') {
        throw abortWith(409, 'Canceled guest requests cannot be assigned');
      }

      if (guestRequest.assigned_reservation_id || guestRequest.status === 'assigned') {
        throw abortWith(409, 'Guest request is already assigned');
      }

      const requestDate = formatDateForSql(guestRequest.request_date);
      await guestRequestsRepository.lockGuestAssignmentForDate(repo, requestDate);

      const place = await placeReleasesRepository.findPlaceForGuestAssignment(repo, requestDate);

      if (!place) {
        throw abortWith(409, 'No released parking place is available for guest assignment on this date');
      }

      const reservation = await reservationsRepository.insertReservation(repo, {
        reservationDate: requestDate,
        parkingPlaceId: place.parking_place_id,
        userId: guestRequest.guest_user_id,
        guestParkingRequestId: guestRequest.id,
        source: 'guest',
        reason: `Guest assignment hosted by ${guestRequest.host_display_name}`
      });

      const warnings = await calculateAssignmentWarnings(repo, requestDate, place.parking_place_id);

      await guestRequestsRepository.markAssigned(repo, {
        guestRequestId: guestRequest.id,
        reservationId: reservation.id
      });

      await reservationsRepository.insertReservationEvent(repo, {
        reservationId: reservation.id,
        eventType: 'reservation_created',
        source: 'guest',
        payload: {
          releaseId: place.release_id,
          guestParkingRequestId: guestRequest.id,
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          parkingPlaceId: place.parking_place_id,
          requestDate
        }
      });

      await reservationsRepository.insertMovement(repo, {
        reservationId: reservation.id,
        movementDate: requestDate,
        toParkingPlaceId: place.parking_place_id,
        movementType: 'guest_assignment',
        reason: `Guest assignment hosted by ${guestRequest.host_display_name}`
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'guest_parking_request',
        entityId: guestRequest.id,
        action: 'guest_parking_request_assigned',
        actorService: 'admin-web',
        metadata: {
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          reservationId: reservation.id,
          parkingPlaceId: place.parking_place_id,
          parkingPlaceCode: place.parking_place_code,
          requestDate,
          warnings
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
    }

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

  try {
    return await withTransaction(pool, async (repo) => {
      const guestRequest = await guestRequestsRepository.findGuestRequestForUpdate(repo, requestId);

      if (!guestRequest) {
        throw abortWith(404, 'Guest parking request not found');
      }

      if (guestRequest.status === 'canceled') {
        throw new AbortTransaction({
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
        });
      }

      let canceledReservation = null;

      if (guestRequest.assigned_reservation_id) {
        canceledReservation = await reservationsRepository.cancelActiveReservation(
          repo,
          guestRequest.assigned_reservation_id
        );

        if (canceledReservation) {
          await reservationsRepository.insertReservationEvent(repo, {
            reservationId: canceledReservation.id,
            eventType: 'reservation_canceled',
            source: 'guest',
            payload: {
              guestParkingRequestId: guestRequest.id,
              guestUserId: guestRequest.guest_user_id,
              hostUserId: guestRequest.host_user_id,
              requestDate: guestRequest.request_date
            }
          });
        }
      }

      const canceledRequest = await guestRequestsRepository.cancelGuestRequest(repo, requestId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'guest_parking_request',
        entityId: requestId,
        action: 'guest_parking_request_canceled',
        actorService: 'admin-web',
        metadata: {
          guestUserId: guestRequest.guest_user_id,
          guestName: guestRequest.guest_name,
          hostUserId: guestRequest.host_user_id,
          hostDisplayName: guestRequest.host_display_name,
          reservationId: guestRequest.assigned_reservation_id,
          canceledReservationId: canceledReservation?.id || null,
          requestDate: guestRequest.request_date
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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

async function processQueueForDate(queueDate) {
  try {
    return await withTransaction(pool, async (repo) => {
      await queueRepository.lockQueueForDate(repo, queueDate);

      const queueEntries = await queueRepository.listWaitingEntriesForUpdate(repo, queueDate);
      const availablePlaces = await placeReleasesRepository.listPlacesForQueueAssignment(repo, queueDate);

      const maxEmployeeAssignments = Math.max(0, availablePlaces.length - guestReserveMinimum);
      const assignments = [];
      const skipped = [];
      let placeIndex = 0;

      for (const entry of queueEntries) {
        // A user who already holds a place for the date — served manually, or by
        // an earlier partial run — is done, not a candidate. Assigning them a
        // second place trips reservations_active_user_date_uniq, and because the
        // whole run is one transaction that used to fail the ENTIRE batch,
        // including the employees queued behind them. Close their request against
        // the reservation they already have and move on.
        if (entry.existing_reservation_id) {
          await employeeRequestsRepository.assignRequest(repo, {
            requestId: entry.request_id,
            reservationId: entry.existing_reservation_id
          });

          await queueRepository.assignQueueEntry(repo, {
            queueEntryId: entry.queue_entry_id,
            reservationId: entry.existing_reservation_id
          });

          skipped.push({
            requestId: entry.request_id,
            queueEntryId: entry.queue_entry_id,
            queuePosition: entry.queue_position,
            userId: entry.user_id,
            userDisplayName: entry.user_display_name,
            reservationId: entry.existing_reservation_id,
            reason: 'already_has_reservation'
          });
          continue;
        }

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

        const reservation = await reservationsRepository.insertReservation(repo, {
          reservationDate: queueDate,
          parkingPlaceId: place.parking_place_id,
          userId: entry.user_id,
          employeeParkingRequestId: entry.request_id,
          source: 'queue',
          reason: `Queue assignment #${entry.queue_position}`
        });

        await employeeRequestsRepository.assignRequest(repo, {
          requestId: entry.request_id,
          reservationId: reservation.id
        });

        await queueRepository.assignQueueEntry(repo, {
          queueEntryId: entry.queue_entry_id,
          reservationId: reservation.id
        });

        await reservationsRepository.insertReservationEvent(repo, {
          reservationId: reservation.id,
          eventType: 'reservation_created',
          source: 'queue',
          payload: {
            releaseId: place.release_id,
            queueEntryId: entry.queue_entry_id,
            queuePosition: entry.queue_position,
            requestId: entry.request_id,
            userId: entry.user_id,
            parkingPlaceId: place.parking_place_id,
            queueDate
          }
        });

        await reservationsRepository.insertMovement(repo, {
          reservationId: reservation.id,
          movementDate: queueDate,
          toParkingPlaceId: place.parking_place_id,
          movementType: 'queue_assignment',
          reason: `Assigned from queue position #${entry.queue_position}`
        });

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

      // Entries closed against a reservation the user already held are excluded:
      // they were marked 'assigned' above and must not be downgraded to 'skipped'.
      const skippedEntryIds = skipped
        .filter((item) => item.reason !== 'already_has_reservation')
        .map((item) => item.queueEntryId);

      if (skippedEntryIds.length) {
        await queueRepository.markEntriesSkipped(repo, skippedEntryIds);
      }

      await auditRepository.insertAuditLog(repo, {
        entityType: 'queue_entry',
        action: 'queue_processed',
        actorService: 'admin-web',
        metadata: {
          queueDate,
          waitingCount: queueEntries.length,
          availableReleasedPlacesCount: availablePlaces.length,
          guestReserveMinimum,
          assignedCount: assignments.length,
          skippedCount: skipped.length,
          assignments,
          skipped
        }
      });

      return {
        date: queueDate,
        guestReserveMinimum,
        availableReleasedPlacesCount: availablePlaces.length,
        assignedCount: assignments.length,
        skippedCount: skipped.length,
        assignments,
        skipped
      };
    });
  } catch (error) {
    if (error.code === '23505') {
      error.statusCode = 409;
      error.message = 'Queue processing hit an existing active reservation for this date';
    }

    throw error;
  }
}

async function handleAdminJobProcessQueue(req) {
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

  // The other four job endpoints default the date; this one demanded it, so the same
  // "run today's job" call worked against four of the five.
  const queueDate = body.date || currentDateInTimezone(appTimezone);

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
    const result = await withJobRun('freeze_next_day', targetDate, async () =>
      withTransaction(pool, async (repo) => {
        await placeReleasesRepository.lockFreezeForDate(repo, targetDate);

        const snapshot = await calculateAvailabilitySnapshot(repo, targetDate, { appTimezone, guestReserveMinimum });
        const frozen = await placeReleasesRepository.freezeReleasesForDate(repo, targetDate);
        const releases = await placeReleasesRepository.listReleasesWithFrozenState(repo, targetDate);
        const frozenCount = frozen.length;

        // Only a run that changed something leaves an audit trail; re-running
        // the job must not grow the journal with identical rows.
        if (frozenCount > 0) {
          await auditRepository.insertAuditLog(repo, {
            entityType: 'system',
            action: 'availability_frozen',
            actorService: 'admin-web',
            metadata: {
              targetDate,
              timezone: appTimezone,
              releaseCount: releases.length,
              frozenCount,
              availability: snapshot
            }
          });
        }

        return {
          date: targetDate,
          timezone: appTimezone,
          releaseCount: releases.length,
          frozenCount,
          alreadyFrozen: frozenCount === 0,
          availability: snapshot,
          frozenReleases: releases.map((release) => ({
            id: release.id,
            parkingPlaceId: release.parking_place_id,
            parkingPlaceCode: release.parking_place_code,
            placeType: release.place_type,
            ownerUserId: release.owner_user_id
          }))
        };
      })
    );

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
      // `locked_at is null` is the idempotency guard: the second run of the day
      // locks nothing and writes no audit row.
      const lockedResult = await departurePlansRepository.lockPlansForDate(dbRepository, targetDate);
      const summary = await departurePlansRepository.summarizePlansForDate(dbRepository, targetDate);
      const lockedCount = lockedResult.length;

      if (lockedCount > 0) {
        await auditRepository.insertAuditLog(dbRepository, {
          entityType: 'system',
          action: 'departure_plan_editing_locked',
          actorService: 'admin-web',
          metadata: {
            targetDate,
            timezone: appTimezone,
            plansCount: summary?.plans_count || 0,
            earlyPlansCount: summary?.early_plans_count || 0,
            lockedCount
          }
        });
      }

      return {
        date: targetDate,
        timezone: appTimezone,
        plansCount: summary?.plans_count || 0,
        earlyPlansCount: summary?.early_plans_count || 0,
        lockedCount,
        alreadyLocked: lockedCount === 0
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

/**
 * Settle how much of the next day's released pool employees may take.
 *
 * The pool itself is opened by freeze-next-day (which fixes the set of released
 * places) and consumed by process-queue at day start. This job is the step
 * between them: it computes, records and announces the employee capacity —
 * everything released minus the guest reserve — so the operator can see at
 * 19:00 how many of the queued employees will actually get a place, instead of
 * finding out the next morning.
 *
 * It writes no reservations, so it is naturally replay-safe; the audit row is
 * written once per date, which is what makes a second run a true no-op.
 */
async function handleAdminJobUnlockEmployeePool(req) {
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
    const result = await withJobRun('unlock_employee_pool', targetDate, async () =>
      withTransaction(pool, async (repo) => {
        await placeReleasesRepository.lockEmployeePoolForDate(repo, targetDate);

        const availableReleasedPlacesCount = await countAvailableReleasedPlaces(repo, targetDate);
        const employeePoolSize = Math.max(0, availableReleasedPlacesCount - guestReserveMinimum);

        const queueSummary = await queueRepository.summarizeWaitingQueue(repo, {
          queueDate: targetDate,
          employeePoolSize
        });

        const waitingCount = queueSummary?.waiting_count || 0;
        const servableCount = Math.min(queueSummary?.servable_count || 0, employeePoolSize);

        const alreadyUnlocked = await auditRepository.findEmployeePoolUnlockedLog(repo, targetDate);

        if (!alreadyUnlocked) {
          await auditRepository.insertAuditLog(repo, {
            entityType: 'system',
            action: 'employee_pool_unlocked',
            actorService: 'admin-web',
            metadata: {
              targetDate,
              timezone: appTimezone,
              guestReserveMinimum,
              availableReleasedPlacesCount,
              employeePoolSize,
              waitingCount,
              servableCount
            }
          });
        }

        return {
          date: targetDate,
          timezone: appTimezone,
          guestReserveMinimum,
          availableReleasedPlacesCount,
          employeePoolSize,
          waitingCount,
          servableCount,
          unservableCount: Math.max(0, waitingCount - servableCount),
          alreadyUnlocked: Boolean(alreadyUnlocked)
        };
      })
    );

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

/**
 * Recompute the early-departure conflicts for a date.
 *
 * Two things drift: `departure_plans.is_early` is stamped from the cut-off rule
 * at write time and never revisited, and the conflict set depends on line
 * occupancy that moves during the day. Both are pure recomputations from
 * current data, so running this twice in a row is by construction a no-op — the
 * second run reports `changed: false` and writes no audit row.
 */
async function handleAdminJobRebuildConflicts(req) {
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
    const result = await withJobRun('rebuild_conflicts', targetDate, async () => {
      const plans = await departurePlansRepository.listPlanEarlyFlagsForDate(dbRepository, targetDate);

      const drifted = plans.filter(
        (plan) => isEarlyDeparture(plan.departure_time.slice(0, 5)) !== plan.is_early
      );

      for (const plan of drifted) {
        await departurePlansRepository.updatePlanEarlyFlag(dbRepository, {
          planId: plan.id,
          isEarly: isEarlyDeparture(plan.departure_time.slice(0, 5))
        });
      }

      const conflicts = await getConflictsForDate(targetDate);
      const changed = drifted.length > 0;

      if (changed) {
        await auditRepository.insertAuditLog(dbRepository, {
          entityType: 'system',
          action: 'conflicts_rebuilt',
          actorService: 'admin-web',
          metadata: {
            targetDate,
            timezone: appTimezone,
            plansCount: plans.length,
            recalculatedCount: drifted.length,
            conflictCount: conflicts.length
          }
        });
      }

      return {
        date: targetDate,
        timezone: appTimezone,
        plansCount: plans.length,
        recalculatedCount: drifted.length,
        conflictCount: conflicts.length,
        conflicts,
        changed
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

  const runs = await jobsRepository.listJobRuns(dbRepository, {
    jobName: jobName || null,
    targetDate: targetDate || null,
    limit
  });
  const latestSuccessfulRuns = await jobsRepository.listLatestSuccessfulRuns(dbRepository, jobName || null);

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

  try {
    return await withTransaction(pool, async (repo) => {
      await placeReleasesRepository.lockManualAssignmentForDate(repo, reservationDate);

      const releasedPlace = await placeReleasesRepository.findActiveReleaseForPlaceDate(repo, {
        parkingPlaceId,
        reservationDate
      });

      if (!releasedPlace) {
        throw abortWith(409, 'Manual assignment is currently allowed only for places released for the selected date');
      }

      if (releasedPlace.owner_user_id === userId) {
        throw abortWith(409, 'Released place owner cannot be manually assigned to the same released place');
      }

      const employee = await employeesRepository.findEmployeeById(repo, userId);

      if (!employee) {
        throw abortWith(404, 'Employee not found');
      }

      const availableReleasedPlacesCount = await countAvailableReleasedPlaces(repo, reservationDate);

      if (availableReleasedPlacesCount <= guestReserveMinimum) {
        throw abortWith(409, `Manual employee assignment would reduce guest reserve below ${guestReserveMinimum} places`, {
          guestReserve: {
            minimum: guestReserveMinimum,
            availablePlaces: availableReleasedPlacesCount
          }
        });
      }

      const warnings = await calculateAssignmentWarnings(repo, reservationDate, parkingPlaceId);

      const reservation = await reservationsRepository.insertReservation(repo, {
        reservationDate,
        parkingPlaceId,
        userId,
        source: 'manual',
        reason
      });

      // Serving the employee manually answers their parking request, so close it
      // and its queue entry here. Leaving them 'queued' used to make them a
      // candidate for the next queue run, which then tripped the one-reservation-
      // per-user-per-day constraint and failed the whole batch.
      const closedRequest = await employeeRequestsRepository.closeOpenRequestForUserDate(repo, {
        userId,
        requestDate: reservationDate,
        reservationId: reservation.id
      });

      if (closedRequest) {
        await queueRepository.assignWaitingEntriesForRequest(repo, {
          employeeParkingRequestId: closedRequest.id,
          reservationId: reservation.id
        });
      }

      await reservationsRepository.insertReservationEvent(repo, {
        reservationId: reservation.id,
        eventType: 'reservation_created',
        source: 'manual',
        payload: {
          releaseId: releasedPlace.release_id,
          userId,
          parkingPlaceId,
          reservationDate,
          closedEmployeeRequestId: closedRequest?.id || null
        }
      });

      await reservationsRepository.insertMovement(repo, {
        reservationId: reservation.id,
        movementDate: reservationDate,
        toParkingPlaceId: parkingPlaceId,
        movementType: 'manual_reassign',
        reason: reason || 'Manual admin assignment'
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'reservation',
        entityId: reservation.id,
        action: 'manual_reservation_created',
        actorService: 'admin-web',
        metadata: {
          releaseId: releasedPlace.release_id,
          userId,
          userDisplayName: employee.display_name,
          parkingPlaceId,
          parkingPlaceCode: releasedPlace.parking_place_code,
          reservationDate,
          closedEmployeeRequestId: closedRequest?.id || null,
          warnings
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
    }

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

  // A release hands a place to the pool for a day that has not happened yet.
  // Releasing a day that already ended cannot change who parked — it only
  // pollutes availability and history with a slot nobody could ever have taken.
  const today = currentDateInTimezone(appTimezone);

  if (dateFrom < today) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: `dateFrom must not be in the past (today is ${today} in ${appTimezone})`
      }
    };
  }

  try {
    return await withTransaction(pool, async (repo) => {
      const owner = await permanentAssignmentsRepository.findOwnerForRange(repo, {
        parkingPlaceId,
        dateFrom,
        dateTo
      });

      if (!owner) {
        throw abortWith(409, 'Parking place has no permanent owner for the selected date range');
      }

      const overlap = await placeReleasesRepository.findOverlappingRelease(repo, {
        parkingPlaceId,
        dateFrom,
        dateTo
      });

      if (overlap) {
        throw abortWith(409, 'Parking place already has an active release overlapping this date range');
      }

      const release = await placeReleasesRepository.insertRelease(repo, {
        userId: owner.user_id,
        parkingPlaceId,
        dateFrom,
        dateTo,
        notes
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'place_release',
        entityId: release.id,
        action: 'place_release_created',
        actorService: 'admin-web',
        metadata: {
          userId: owner.user_id,
          userDisplayName: owner.user_display_name,
          parkingPlaceId,
          parkingPlaceCode: owner.parking_place_code,
          dateFrom,
          dateTo,
          createdVia: 'admin_web'
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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

  try {
    return await withTransaction(pool, async (repo) => {
      const reservation = await reservationsRepository.findReservationForUpdate(repo, reservationId);

      if (!reservation) {
        throw abortWith(404, 'Reservation not found');
      }

      if (reservation.status === 'canceled') {
        throw new AbortTransaction({
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
        });
      }

      if (reservation.status !== 'active') {
        throw abortWith(409, 'Only active reservations can be canceled');
      }

      const canceledReservation = await reservationsRepository.cancelReservation(repo, reservationId);

      if (reservation.employee_parking_request_id) {
        await employeeRequestsRepository.reopenAssignedRequest(repo, reservation.employee_parking_request_id);
        await queueRepository.reopenAssignedEntriesForRequest(repo, reservation.employee_parking_request_id);
      }

      if (reservation.guest_parking_request_id) {
        await guestRequestsRepository.cancelGuestRequestIfNotCanceled(repo, reservation.guest_parking_request_id);
      }

      await reservationsRepository.insertReservationEvent(repo, {
        reservationId,
        eventType: 'reservation_canceled',
        source: reservation.source,
        payload: {
          reservationDate: reservation.reservation_date,
          parkingPlaceId: reservation.parking_place_id,
          parkingPlaceCode: reservation.parking_place_code,
          userId: reservation.user_id,
          employeeParkingRequestId: reservation.employee_parking_request_id,
          guestParkingRequestId: reservation.guest_parking_request_id
        }
      });

      await auditRepository.insertAuditLog(repo, {
        entityType: 'reservation',
        entityId: reservationId,
        action: 'reservation_canceled',
        actorService: 'admin-web',
        metadata: {
          reservationDate: reservation.reservation_date,
          parkingPlaceId: reservation.parking_place_id,
          parkingPlaceCode: reservation.parking_place_code,
          userId: reservation.user_id,
          userDisplayName: reservation.user_display_name,
          source: reservation.source
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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

  try {
    return await withTransaction(pool, async (repo) => {
      const release = await placeReleasesRepository.findReleaseForUpdate(repo, releaseId);

      if (!release) {
        throw abortWith(404, 'Place release not found');
      }

      if (release.status === 'canceled') {
        throw new AbortTransaction({
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
        });
      }

      // Once freeze-next-day has run for the released day, the release is part of
      // that day's settled pool and cannot be taken back — someone may already be
      // counting on the place.
      if (release.frozen_at) {
        throw abortWith(409, 'Cannot cancel a release for a day that is already frozen', {
          frozenAt: release.frozen_at,
          timezone: appTimezone
        });
      }

      const activeReservation = await reservationsRepository.findActiveReservationInRange(repo, {
        parkingPlaceId: release.parking_place_id,
        releaseDuring: release.release_during
      });

      if (activeReservation) {
        throw abortWith(409, 'Cannot cancel release while it has active reservations');
      }

      const canceledRelease = await placeReleasesRepository.cancelRelease(repo, releaseId);

      await auditRepository.insertAuditLog(repo, {
        entityType: 'place_release',
        entityId: releaseId,
        action: 'place_release_canceled',
        actorService: 'admin-web',
        metadata: {
          userId: release.user_id,
          userDisplayName: release.user_display_name,
          parkingPlaceId: release.parking_place_id,
          parkingPlaceCode: release.parking_place_code,
          dateFrom: release.date_from,
          dateTo: release.date_to
        }
      });

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
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return error.result;
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

  if (date && !isIsoDate(date)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  const rows = await auditRepository.listAuditLogs(dbRepository, {
    date,
    entityType,
    entityId,
    action,
    actor,
    limit
  });

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

  if (date && !isIsoDate(date)) {
    return {
      statusCode: 400,
      payload: {
        status: 'error',
        service: 'api',
        error: 'date must use YYYY-MM-DD format'
      }
    };
  }

  const rows = await contactAccessRepository.listContactAccessLogs(dbRepository, { date, limit });

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

  const rows = await lineOccupancyRepository.listOccupancyForDate(dbRepository, { occupancyDate });

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
  const place = await placesRepository.findPlaceForHistory(dbRepository, placeId);

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
    permanentAssignmentsRepository.listAssignmentsForPlace(dbRepository, placeId),
    placeReleasesRepository.listReleasesForPlace(dbRepository, placeId),
    reservationsRepository.listReservationsForPlace(dbRepository, placeId),
    reservationsRepository.listMovementsForPlace(dbRepository, placeId),
    auditRepository.listAuditLogsForPlace(dbRepository, placeId)
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
  const employee = await employeesRepository.findEmployeeProfile(dbRepository, userId);

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
      permanentAssignmentsRepository.listAssignmentsForUser(dbRepository, userId),
      placeReleasesRepository.listReleasesForUser(dbRepository, userId),
      employeeRequestsRepository.listRequestsForUser(dbRepository, userId),
      guestRequestsRepository.listHostedRequestsForUser(dbRepository, userId),
      reservationsRepository.listReservationsForUser(dbRepository, userId),
      lineOccupancyRepository.listOccupancyForUser(dbRepository, userId),
      departurePlansRepository.listPlansForUser(dbRepository, userId),
      contactAccessRepository.listContactAccessLogsForUser(dbRepository, userId),
      auditRepository.listAuditLogsForUser(dbRepository, userId)
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
    handleAdminJobRebuildConflicts,
    handleAdminJobRunsList,
    handleAdminJobUnlockEmployeePool,
    handleAdminLineGroupOccupancy,
    handleAdminLineGroupsList,
    handleAdminLineOccupancyList,
    handleAdminManualReservationCreate,
    handleAdminMapBackgroundUpdate,
    handleAdminMapDiagnostics,
    handleAdminParkingPlaceUpdate,
    handleAdminPermanentAssignmentCreate,
    handleAdminPermanentAssignmentEnd,
    handleAdminPermanentAssignmentsList,
    handleAdminPlaceHistory,
    handleAdminPlaceLineArchive,
    handleAdminPlaceLineCreate,
    handleAdminPlaceLinesList,
    handleAdminPlaceReleaseCancel,
    handleAdminPlaceReleaseCreate,
    handleAdminPlaceReleasesList,
    handleAdminPlacesList,
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
