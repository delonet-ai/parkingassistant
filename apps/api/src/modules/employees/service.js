'use strict';

const auditRepository = require('../audit/repository');
const contactAccessRepository = require('../contact-access/repository');
const departurePlansRepository = require('../departure-plans/repository');
const employeeRequestsRepository = require('../employee-requests/repository');
const guestRequestsRepository = require('../guest-requests/repository');
const lineOccupancyRepository = require('../line-occupancy/repository');
const permanentAssignmentsRepository = require('../permanent-assignments/repository');
const placeReleasesRepository = require('../place-releases/repository');
const repository = require('./repository');
const reservationsRepository = require('../reservations/repository');

function createEmployeesService({ dbRepository }) {
  async function listEmployeesWithPermanentPlace(date) {
    return repository.listEmployeesWithPermanentPlace(dbRepository, date);
  }

  async function createEmployee(input) {
    const employee = await repository.insertEmployee(dbRepository, input);

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'user',
      entityId: employee.id,
      action: 'employee_created',
      actorService: 'admin-web',
      metadata: {
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
        department: input.department,
        yandexMessengerUserId: input.yandexMessengerUserId
      }
    });

    return employee;
  }

  async function updateEmployee(input) {
    const employee = await repository.updateEmployee(dbRepository, input);

    if (!employee) {
      return null;
    }

    await auditRepository.insertAuditLog(dbRepository, {
      entityType: 'user',
      entityId: input.employeeId,
      action: 'employee_updated',
      actorService: 'admin-web',
      metadata: {
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
        department: input.department,
        yandexMessengerUserId: input.yandexMessengerUserId,
        isActive: input.isActive
      }
    });

    return employee;
  }

  async function disableEmployee(employeeId) {
    const employee = await repository.disableEmployee(dbRepository, employeeId);

    if (!employee) {
      return null;
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

    return employee;
  }

  // The employee journal is a fan-out read across nine contexts. It stays one round trip
  // per context in one Promise.all, exactly as the monolith ran it.
  async function getEmployeeHistory(userId) {
    const employee = await repository.findEmployeeProfile(dbRepository, userId);

    if (!employee) {
      return null;
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
    };
  }

  return {
    createEmployee,
    disableEmployee,
    getEmployeeHistory,
    listEmployeesWithPermanentPlace,
    updateEmployee
  };
}

module.exports = {
  createEmployeesService
};
