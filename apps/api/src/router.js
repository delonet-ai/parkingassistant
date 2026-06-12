'use strict';

const { URL } = require('node:url');
const { errorPayload } = require('../../../packages/shared/errors');

const rootEndpoints = [
  '/health',
  '/health/db',
  '/auth/bootstrap-status',
  '/admin/users',
  '/admin/employees',
  '/admin/employees/update',
  '/admin/employees/disable',
  '/admin/employees/:id/history',
  '/admin/places',
  '/admin/places/update',
  '/admin/places/disable',
  '/admin/places/:id/history',
  '/admin/permanent-assignments',
  '/admin/permanent-assignments/end',
  '/admin/audit-logs',
  '/admin/contact-access-logs',
  '/admin/line-groups',
  '/admin/line-occupancy',
  '/admin/line-groups/:id/occupancy',
  '/bot/line/position',
  '/bot/line/blocking-contacts',
  '/bot/departure-plans',
  '/admin/departure-plans',
  '/admin/conflicts',
  '/admin/map-zones',
  '/admin/dashboard',
  '/admin/availability',
  '/admin/place-releases',
  '/admin/place-releases/cancel',
  '/admin/employee-parking-requests',
  '/admin/guest-parking-requests',
  '/admin/guest-parking-requests/assign',
  '/admin/queue/process',
  '/admin/jobs/process-queue',
  '/admin/jobs/freeze-next-day',
  '/admin/jobs/lock-departure-plans',
  '/admin/jobs/runs',
  '/admin/reservations/manual',
  '/admin/reservations/cancel'
];

function createApiRouter({ handlers, sendJson, startedAt }) {
  async function dispatch(handler, res) {
    const result = await handler();
    sendJson(res, result.statusCode, result.payload);
  }

  async function dispatchSafely(handler, res) {
    try {
      await dispatch(handler, res);
    } catch (error) {
      sendJson(res, 500, errorPayload(error));
    }
  }

  return async function routeApiRequest(req, res) {
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
      await dispatch(() => handlers.handleDbHealth(), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/auth/bootstrap-status') {
      await dispatch(() => handlers.handleAuthBootstrapStatus(), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/users') {
      await dispatch(() => handlers.handleAdminUsersList(), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/employees') {
      await dispatch(() => handlers.handleAdminEmployeesList(url.searchParams), res);
      return;
    }

    const employeeHistoryMatch = url.pathname.match(/^\/admin\/employees\/([^/]+)\/history$/);
    if (req.method === 'GET' && employeeHistoryMatch) {
      await dispatchSafely(() => handlers.handleAdminEmployeeHistory(employeeHistoryMatch[1]), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/employees') {
      await dispatch(() => handlers.handleAdminEmployeeCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/employees/update') {
      await dispatch(() => handlers.handleAdminEmployeeUpdate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/employees/disable') {
      await dispatch(() => handlers.handleAdminEmployeeDisable(req), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/places') {
      await dispatch(() => handlers.handleAdminPlacesList(), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/places') {
      await dispatch(() => handlers.handleAdminParkingPlaceCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/places/update') {
      await dispatch(() => handlers.handleAdminParkingPlaceUpdate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/places/disable') {
      await dispatch(() => handlers.handleAdminParkingPlaceDisable(req), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/permanent-assignments') {
      await dispatchSafely(() => handlers.handleAdminPermanentAssignmentsList(url.searchParams), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/permanent-assignments') {
      await dispatch(() => handlers.handleAdminPermanentAssignmentCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/permanent-assignments/end') {
      await dispatch(() => handlers.handleAdminPermanentAssignmentEnd(req), res);
      return;
    }

    const placeHistoryMatch = url.pathname.match(/^\/admin\/places\/([^/]+)\/history$/);
    if (req.method === 'GET' && placeHistoryMatch) {
      await dispatchSafely(() => handlers.handleAdminPlaceHistory(placeHistoryMatch[1]), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/audit-logs') {
      await dispatchSafely(() => handlers.handleAdminAuditLogsList(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/contact-access-logs') {
      await dispatchSafely(() => handlers.handleAdminContactAccessLogsList(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/line-groups') {
      await dispatchSafely(() => handlers.handleAdminLineGroupsList(), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/line-occupancy') {
      await dispatchSafely(() => handlers.handleAdminLineOccupancyList(url.searchParams), res);
      return;
    }

    const lineGroupOccupancyMatch = url.pathname.match(/^\/admin\/line-groups\/([^/]+)\/occupancy$/);
    if (req.method === 'GET' && lineGroupOccupancyMatch) {
      await dispatchSafely(() => handlers.handleAdminLineGroupOccupancy(lineGroupOccupancyMatch[1], url.searchParams), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/line-occupancy') {
      await dispatch(() => handlers.handleLineOccupancySet(req, 'admin-web'), res);
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/bot/line/position' || url.pathname === '/bot/line-occupancy')) {
      await dispatch(() => handlers.handleLineOccupancySet(req, 'bot'), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/bot/line/blocking-contacts') {
      await dispatchSafely(() => handlers.handleBotBlockingContacts(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/departure-plans') {
      await dispatchSafely(() => handlers.handleDeparturePlansList(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/conflicts') {
      await dispatchSafely(() => handlers.handleConflictsList(url.searchParams), res);
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/bot/departure-plans' || url.pathname === '/admin/departure-plans')) {
      await dispatch(() => handlers.handleDeparturePlanUpsert(req, url.pathname.startsWith('/bot/') ? 'bot' : 'admin-web'), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/map-zones') {
      await dispatchSafely(() => handlers.handleAdminMapZonesList(url.searchParams), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/map-zones') {
      await dispatch(() => handlers.handleAdminMapZoneSave(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/map-zones/update') {
      await dispatch(() => handlers.handleAdminMapZoneUpdate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/map-zones/delete') {
      await dispatch(() => handlers.handleAdminMapZoneDelete(req), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/dashboard') {
      await dispatchSafely(() => handlers.handleAdminDashboard(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/availability') {
      await dispatchSafely(() => handlers.handleAdminAvailability(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/place-releases') {
      await dispatchSafely(() => handlers.handleAdminPlaceReleasesList(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/employee-parking-requests') {
      await dispatchSafely(() => handlers.handleAdminEmployeeParkingRequestsList(url.searchParams), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/guest-parking-requests') {
      await dispatchSafely(() => handlers.handleAdminGuestParkingRequestsList(url.searchParams), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/place-releases') {
      await dispatch(() => handlers.handleAdminPlaceReleaseCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/place-releases/cancel') {
      await dispatch(() => handlers.handleAdminPlaceReleaseCancel(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/employee-parking-requests') {
      await dispatch(() => handlers.handleAdminEmployeeParkingRequestCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/employee-parking-requests/cancel') {
      await dispatch(() => handlers.handleAdminEmployeeParkingRequestCancel(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/guest-parking-requests') {
      await dispatch(() => handlers.handleAdminGuestParkingRequestCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/guest-parking-requests/assign') {
      await dispatch(() => handlers.handleAdminGuestParkingRequestAssign(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/guest-parking-requests/cancel') {
      await dispatch(() => handlers.handleAdminGuestParkingRequestCancel(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/queue/process') {
      await dispatch(() => handlers.handleAdminQueueProcess(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/jobs/process-queue') {
      await dispatch(() => handlers.handleAdminJobProcessQueue(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/jobs/freeze-next-day') {
      await dispatch(() => handlers.handleAdminJobFreezeNextDay(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/jobs/lock-departure-plans') {
      await dispatch(() => handlers.handleAdminJobLockDeparturePlans(req), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/admin/jobs/runs') {
      await dispatchSafely(() => handlers.handleAdminJobRunsList(url.searchParams), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/reservations/manual') {
      await dispatch(() => handlers.handleAdminManualReservationCreate(req), res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/admin/reservations/cancel') {
      await dispatch(() => handlers.handleAdminReservationCancel(req), res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'api',
        message: 'Parking Assistant API is running',
        endpoints: rootEndpoints
      });
      return;
    }

    sendJson(res, 404, errorPayload('Not found', 404));
  };
}

module.exports = {
  createApiRouter
};
