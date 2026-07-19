'use strict';

const { currentDateInTimezone, isIsoDate } = require('../../../../../packages/shared/dates');
const { readJsonBody } = require('../../../../../packages/shared/http');
const { mapAuditLog } = require('../../serializers/audit-logs');
const { mapContactAccessLog } = require('../../serializers/contact-access');
const { normalizeOptionalString, splitDisplayName } = require('../../support/params');

function createEmployeesController({ appTimezone, services }) {
  const service = services.employees;

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
      const employees = await service.listEmployeesWithPermanentPlace(date);

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
      const employee = await service.createEmployee({
        firstName,
        lastName,
        displayName,
        email,
        phone,
        department,
        yandexMessengerUserId
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
      const employee = await service.updateEmployee({
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

    const employee = await service.disableEmployee(employeeId);

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

  async function handleAdminEmployeeHistory(userId) {
    const history = await service.getEmployeeHistory(userId);

    if (!history) {
      return {
        statusCode: 404,
        payload: {
          status: 'error',
          service: 'api',
          error: 'Employee not found'
        }
      };
    }

    const {
      employee,
      permanentAssignments,
      releases,
      employeeRequests,
      hostedGuestRequests,
      reservations,
      lineOccupancy,
      departurePlans,
      contactLogs,
      auditLogs
    } = history;

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

  return {
    name: 'employees',
    routes: [
      {
        method: 'GET',
        path: '/admin/employees',
        advertise: true,
        handler: ({ searchParams }) => handleAdminEmployeesList(searchParams)
      },
      {
        method: 'POST',
        path: '/admin/employees',
        handler: ({ req }) => handleAdminEmployeeCreate(req)
      },
      {
        method: 'POST',
        path: '/admin/employees/update',
        advertise: true,
        handler: ({ req }) => handleAdminEmployeeUpdate(req)
      },
      {
        method: 'POST',
        path: '/admin/employees/disable',
        advertise: true,
        handler: ({ req }) => handleAdminEmployeeDisable(req)
      },
      {
        method: 'GET',
        pattern: /^\/admin\/employees\/([^/]+)\/history$/,
        advertise: '/admin/employees/:id/history',
        safe: true,
        handler: ({ params }) => handleAdminEmployeeHistory(params[0])
      }
    ]
  };
}

module.exports = {
  createEmployeesController
};
