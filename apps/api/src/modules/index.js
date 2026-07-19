'use strict';

const { createAuditController } = require('./audit/controller');
const { createAuditService } = require('./audit/service');
const { createConflictsController } = require('./conflicts/controller');
const { createConflictsService } = require('./conflicts/service');
const { createContactAccessController } = require('./contact-access/controller');
const { createContactAccessService } = require('./contact-access/service');
const { createDashboardController } = require('./dashboard/controller');
const { createDashboardService } = require('./dashboard/service');
const { createDeparturePlansController } = require('./departure-plans/controller');
const { createDeparturePlansService } = require('./departure-plans/service');
const { createEmployeeRequestsController } = require('./employee-requests/controller');
const { createEmployeeRequestsService } = require('./employee-requests/service');
const { createEmployeesController } = require('./employees/controller');
const { createEmployeesService } = require('./employees/service');
const { createGuestRequestsController } = require('./guest-requests/controller');
const { createGuestRequestsService } = require('./guest-requests/service');
const { createJobsController } = require('./jobs/controller');
const { createJobsService } = require('./jobs/service');
const { createLineOccupancyController } = require('./line-occupancy/controller');
const { createLineOccupancyService } = require('./line-occupancy/service');
const { createMapsController } = require('./maps/controller');
const { createMapsService } = require('./maps/service');
const { createPermanentAssignmentsController } = require('./permanent-assignments/controller');
const { createPermanentAssignmentsService } = require('./permanent-assignments/service');
const { createPlaceLinesController } = require('./place-lines/controller');
const { createPlaceLinesService } = require('./place-lines/service');
const { createPlaceReleasesController } = require('./place-releases/controller');
const { createPlaceReleasesService } = require('./place-releases/service');
const { createPlacesController } = require('./places/controller');
const { createPlacesService } = require('./places/service');
const { createQueueService } = require('./queue/service');
const { createReservationsController } = require('./reservations/controller');
const { createReservationsService } = require('./reservations/service');
const { createSystemController } = require('./system/controller');
const { createSystemService } = require('./system/service');

// The composition root for the bounded contexts enumerated in ADR 003.
//
// Services are built first into one registry, then handed to every factory as `deps.services`.
// The registry is filled before the HTTP server starts listening, so a service that needs a
// sibling — jobs → queue, guest-requests → reservations — reads it off the registry at call
// time rather than capturing it at construction time. That is what lets two contexts depend
// on each other without an import cycle or a load-order rule to remember.
//
// `queue` has no controller: it serves no route of its own and is driven only by the
// process-queue job. `dashboard` has no repository: after Task 15 its reads are a fan-out
// over three other contexts.
function createServices(deps) {
  return {
    audit: createAuditService(deps),
    conflicts: createConflictsService(deps),
    contactAccess: createContactAccessService(deps),
    dashboard: createDashboardService(deps),
    departurePlans: createDeparturePlansService(deps),
    employeeRequests: createEmployeeRequestsService(deps),
    employees: createEmployeesService(deps),
    guestRequests: createGuestRequestsService(deps),
    jobs: createJobsService(deps),
    lineOccupancy: createLineOccupancyService(deps),
    maps: createMapsService(deps),
    permanentAssignments: createPermanentAssignmentsService(deps),
    placeLines: createPlaceLinesService(deps),
    placeReleases: createPlaceReleasesService(deps),
    places: createPlacesService(deps),
    queue: createQueueService(deps),
    reservations: createReservationsService(deps),
    system: createSystemService(deps)
  };
}

// Controller order IS the order of the endpoint index served at `GET /`, since the router
// derives that list from these route tables. Reordering this array changes that payload.
function createControllers(deps) {
  return [
    createSystemController(deps),
    createEmployeesController(deps),
    createPlacesController(deps),
    createPlaceLinesController(deps),
    createPermanentAssignmentsController(deps),
    createAuditController(deps),
    createContactAccessController(deps),
    createLineOccupancyController(deps),
    createDeparturePlansController(deps),
    createConflictsController(deps),
    createMapsController(deps),
    createDashboardController(deps),
    createPlaceReleasesController(deps),
    createEmployeeRequestsController(deps),
    createGuestRequestsController(deps),
    createJobsController(deps),
    createReservationsController(deps)
  ];
}

function createModules(config) {
  const services = {};
  const deps = { ...config, services };

  Object.assign(services, createServices(deps));

  return {
    modules: createControllers(deps),
    services
  };
}

module.exports = {
  createModules
};
