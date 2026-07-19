'use strict';

// GET / — the one HTML route.
//
// This is the whole data-fetching half of the admin UI: it reads the query string,
// fans out to the API, maps the redirect flags to a notice, and hands one plain model
// to renderPage(). Not a byte of HTML is built here.

const { escapeHtml } = require('../../../../../packages/shared/html');
const { fetchJson } = require('../../api-client');
const { parkingMaps } = require('../../config');
const { todayIsoDate } = require('../../components/format');
const { renderPage } = require('../../pages/layout');

async function handlePageRoute(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const selectedDate = url.searchParams.get('date') || todayIsoDate();
      const requestedView = url.searchParams.get('view') || 'day';
      const activeView = ['day', 'requests', 'catalog', 'lines', 'audit', 'places'].includes(requestedView) ? requestedView : 'day';
      const placeId = url.searchParams.get('placeId');
      const employeeId = url.searchParams.get('employeeId');
      const requestedMapCode = url.searchParams.get('mapCode') || parkingMaps[0]?.id || 'g4';
      const selectedMapCode = parkingMaps.some((map) => map.id === requestedMapCode) ? requestedMapCode : parkingMaps[0]?.id || 'g4';
      const requestedStatusFilter = url.searchParams.get('status') || '';
      const mapStatusFilter = ['free', 'released', 'occupied', 'guest', 'rotatable', 'blocked'].includes(requestedStatusFilter) ? requestedStatusFilter : '';
      const requestedTypeFilter = url.searchParams.get('type') || '';
      const mapTypeFilter = ['single', 'double', 'triple'].includes(requestedTypeFilter) ? requestedTypeFilter : '';
      const requestedAssignmentStatus = url.searchParams.get('assignmentStatus') || 'all';
      const assignmentStatusFilter = ['all', 'active', 'future', 'ended'].includes(requestedAssignmentStatus) ? requestedAssignmentStatus : 'all';
      const auditEntityType = url.searchParams.get('entityType') || '';
      const auditAction = url.searchParams.get('action') || '';
      const auditActor = url.searchParams.get('actor') || '';
      const auditParams = new URLSearchParams({
        date: selectedDate,
        limit: '120'
      });
      if (auditEntityType) {
        auditParams.set('entityType', auditEntityType);
      }
      if (auditAction) {
        auditParams.set('action', auditAction);
      }
      if (auditActor) {
        auditParams.set('actor', auditActor);
      }
      const [
        health,
        db,
        bootstrap,
        places,
        employees,
        permanentAssignments,
        dashboard,
        employeeRequests,
        guestRequests,
        jobRuns,
        lineGroups,
        lineOccupancy,
        departurePlans,
        conflicts,
        auditLogs,
        contactAccessLogs,
        mapDiagnostics,
        placeLines,
        placeHistory,
        employeeHistory
      ] = await Promise.all([
        fetchJson('/health'),
        fetchJson('/health/db'),
        fetchJson('/auth/bootstrap-status'),
        fetchJson('/admin/places'),
        fetchJson(`/admin/employees?date=${encodeURIComponent(selectedDate)}`),
        fetchJson(`/admin/permanent-assignments?date=${encodeURIComponent(selectedDate)}&status=${encodeURIComponent(assignmentStatusFilter)}`),
        fetchJson(`/admin/dashboard?date=${encodeURIComponent(selectedDate)}`),
        fetchJson(`/admin/employee-parking-requests?date=${encodeURIComponent(selectedDate)}`),
        fetchJson(`/admin/guest-parking-requests?date=${encodeURIComponent(selectedDate)}`),
        fetchJson('/admin/jobs/runs?limit=8'),
        fetchJson('/admin/line-groups'),
        fetchJson(`/admin/line-occupancy?date=${encodeURIComponent(selectedDate)}`),
        fetchJson(`/admin/departure-plans?date=${encodeURIComponent(selectedDate)}`),
        fetchJson(`/admin/conflicts?date=${encodeURIComponent(selectedDate)}`),
        fetchJson(`/admin/audit-logs?${auditParams.toString()}`),
        fetchJson(`/admin/contact-access-logs?date=${encodeURIComponent(selectedDate)}&limit=120`),
        fetchJson('/admin/map-diagnostics'),
        fetchJson(`/admin/place-lines?date=${encodeURIComponent(selectedDate)}`),
        placeId ? fetchJson(`/admin/places/${encodeURIComponent(placeId)}/history`) : Promise.resolve({ ok: true, status: 200, data: null }),
        employeeId ? fetchJson(`/admin/employees/${encodeURIComponent(employeeId)}/history`) : Promise.resolve({ ok: true, status: 200, data: null })
      ]);
      const notice =
        url.searchParams.get('released') === '1'
          ? { type: 'ok', text: 'Отдача места создана.' }
          : url.searchParams.get('releaseCanceled') === '1'
            ? { type: 'ok', text: 'Отдача места отменена.' }
          : url.searchParams.get('reserved') === '1'
            ? { type: 'ok', text: `Ручное назначение создано.${url.searchParams.get('warning') ? ` Предупреждение: ${url.searchParams.get('warning')}` : ''}` }
          : url.searchParams.get('reservationCanceled') === '1'
            ? { type: 'ok', text: 'Назначение отменено.' }
          : url.searchParams.get('requested') === '1'
            ? { type: 'ok', text: 'Заявка сотрудника добавлена в очередь.' }
          : url.searchParams.get('requestCanceled') === '1'
            ? { type: 'ok', text: 'Заявка сотрудника отменена.' }
          : url.searchParams.get('guestCreated') === '1'
            ? { type: 'ok', text: `Гостевая заявка создана, место назначено.${url.searchParams.get('warning') ? ` Предупреждение: ${url.searchParams.get('warning')}` : ''}` }
          : url.searchParams.get('guestCanceled') === '1'
            ? { type: 'ok', text: 'Гостевая заявка отменена.' }
          : url.searchParams.get('guestAssigned') === '1'
            ? { type: 'ok', text: `Гостевое место назначено.${url.searchParams.get('warning') ? ` Предупреждение: ${url.searchParams.get('warning')}` : ''}` }
          : url.searchParams.get('employeeCreated') === '1'
            ? { type: 'ok', text: 'Сотрудник создан. Теперь его можно поставить в очередь.' }
          : url.searchParams.get('employeeUpdated') === '1'
            ? { type: 'ok', text: 'Сотрудник обновлен.' }
          : url.searchParams.get('employeeDisabled') === '1'
            ? { type: 'ok', text: 'Сотрудник отключен.' }
          : url.searchParams.get('placeUpdated') === '1'
            ? { type: 'ok', text: 'Место обновлено.' }
          : url.searchParams.get('assignmentCreated') === '1'
            ? { type: 'ok', text: 'Постоянное закрепление создано.' }
          : url.searchParams.get('assignmentEnded') === '1'
            ? { type: 'ok', text: 'Постоянное закрепление завершено.' }
          : url.searchParams.get('queueProcessed')
            ? {
                type: 'ok',
                text: `Очередь обработана: назначено ${url.searchParams.get('assigned') || 0}, пропущено ${url.searchParams.get('skipped') || 0}.`
              }
          : url.searchParams.get('jobDone')
            ? { type: 'ok', text: `Job выполнен: ${url.searchParams.get('jobDone')}.` }
          : url.searchParams.get('mapUploaded') === '1'
            ? { type: 'ok', text: 'Подложка карты заменена, версия и checksum обновлены.' }
          : url.searchParams.get('linePositionSet') === '1'
            ? { type: 'ok', text: 'Фактическая позиция в линии сохранена.' }
          : url.searchParams.get('departurePlanSet') === '1'
            ? { type: 'ok', text: 'Плановое время выезда сохранено.' }
          : url.searchParams.get('error')
            ? { type: 'error', text: url.searchParams.get('error') }
            : null;

      const pageHtml = renderPage({
          health,
          db,
          bootstrap,
          places,
          employees,
          permanentAssignments,
          dashboard,
          employeeRequests,
          guestRequests,
          jobRuns,
          lineGroups,
          lineOccupancy,
          departurePlans,
          conflicts,
          auditLogs,
          contactAccessLogs,
          mapDiagnostics,
          placeLines,
          placeHistory,
          employeeHistory,
          selectedDate,
          activeView,
          selectedPlaceId: placeId,
          selectedMapCode,
          mapStatusFilter,
          mapTypeFilter,
          assignmentStatusFilter,
          auditFilters: {
            entityType: auditEntityType,
            action: auditAction,
            actor: auditActor
          },
          notice
        });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pageHtml);
      return true;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>Admin Web Error</h1><pre>${escapeHtml(error.message)}</pre>`);
      return true;
    }
  }

  return false;
}

module.exports = {
  handlePageRoute
};
