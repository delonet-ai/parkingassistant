'use strict';

// The form POSTs.
//
// Every one is the same shape: read the form body, post it to the API, and redirect
// back to the tab the operator came from with a notice flag. No rendering happens here
// — the redirect target re-renders through the page route.

const { readFormBody } = require('../../../../../packages/shared/http');
const { postJson } = require('../../api-client');
const { todayIsoDate } = require('../../components/format');

async function handleFormRoutes(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/admin/places/update') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const placeId = form.get('placeId');
    const payload = {
      placeId,
      code: form.get('code'),
      title: form.get('title'),
      floorLabel: form.get('floorLabel'),
      placeType: form.get('placeType'),
      lineGroupId: form.get('lineGroupId'),
      linePositionHint: form.get('linePositionHint'),
      guestPriorityRank: form.get('guestPriorityRank'),
      placeRole: form.get('placeRole')
    };
    // The per-slot role control on the Места tab posts the same form; returnView keeps the
    // operator on the tab they edited from instead of bouncing them into Справочники.
    const returnView = form.get('returnView') === 'places' ? 'places' : 'catalog';
    const mapCodeParam = form.get('mapCode') ? `&mapCode=${encodeURIComponent(form.get('mapCode'))}` : '';
    const result = await postJson('/admin/places/update', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=${returnView}&date=${encodeURIComponent(selectedDate)}${mapCodeParam}&placeUpdated=1&placeId=${encodeURIComponent(placeId || '')}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=${returnView}&date=${encodeURIComponent(selectedDate)}${mapCodeParam}&placeId=${encodeURIComponent(placeId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employees/update') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const employeeId = form.get('employeeId');
    const payload = {
      employeeId,
      displayName: form.get('displayName'),
      department: form.get('department'),
      email: form.get('email'),
      phone: form.get('phone'),
      yandexMessengerUserId: form.get('yandexMessengerUserId'),
      isActive: form.get('isActive') !== 'false'
    };
    const result = await postJson('/admin/employees/update', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&employeeUpdated=1&employeeId=${encodeURIComponent(employeeId || '')}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&employeeId=${encodeURIComponent(employeeId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employees/disable') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const payload = {
      employeeId: form.get('employeeId')
    };
    const result = await postJson('/admin/employees/disable', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&employeeDisabled=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/permanent-assignments') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const payload = {
      userId: form.get('userId'),
      parkingPlaceId: form.get('parkingPlaceId'),
      dateFrom: form.get('dateFrom'),
      dateTo: form.get('dateTo'),
      notes: form.get('notes')
    };
    const result = await postJson('/admin/permanent-assignments', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&assignmentCreated=1&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}&employeeId=${encodeURIComponent(payload.userId || '')}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/permanent-assignments/end') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const assignmentStatus = form.get('assignmentStatus') || 'all';
    const payload = {
      assignmentId: form.get('assignmentId'),
      dateTo: form.get('dateTo')
    };
    const result = await postJson('/admin/permanent-assignments/end', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&assignmentStatus=${encodeURIComponent(assignmentStatus)}&assignmentEnded=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&assignmentStatus=${encodeURIComponent(assignmentStatus)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/place-releases') {
    const form = await readFormBody(req);
    const mapCode = form.get('mapCode') || '';
    const payload = {
      parkingPlaceId: form.get('parkingPlaceId'),
      dateFrom: form.get('dateFrom'),
      dateTo: form.get('dateTo'),
      notes: form.get('notes')
    };
    const result = await postJson('/admin/place-releases', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(payload.dateFrom)}&mapCode=${encodeURIComponent(mapCode)}&released=1&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(payload.dateFrom || todayIsoDate())}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/place-releases/cancel') {
    const form = await readFormBody(req);
    const payload = {
      releaseId: form.get('releaseId')
    };
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/place-releases/cancel', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(date)}&releaseCanceled=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/reservations/manual') {
    const form = await readFormBody(req);
    const mapCode = form.get('mapCode') || '';
    const payload = {
      userId: form.get('userId'),
      parkingPlaceId: form.get('parkingPlaceId'),
      reservationDate: form.get('reservationDate'),
      reason: form.get('reason')
    };
    const result = await postJson('/admin/reservations/manual', payload);

    if (result.ok) {
      const warnings = result.data?.warnings || [];
      const warningText = warnings.length ? `&warning=${encodeURIComponent(warnings.map((warning) => warning.message || warning.type).join('; '))}` : '';
      res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(payload.reservationDate)}&mapCode=${encodeURIComponent(mapCode)}&reserved=1&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}${warningText}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(payload.reservationDate || '')}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/line-occupancy') {
    const form = await readFormBody(req);
    const payload = {
      occupancyDate: form.get('occupancyDate'),
      lineGroupId: form.get('lineGroupId'),
      parkingPlaceId: form.get('parkingPlaceId'),
      position: Number(form.get('position')),
      subjectType: 'employee',
      userId: form.get('userId')
    };
    const result = await postJson('/admin/line-occupancy', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=lines&date=${encodeURIComponent(payload.occupancyDate)}&linePositionSet=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=lines&date=${encodeURIComponent(payload.occupancyDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/departure-plans') {
    const form = await readFormBody(req);
    const payload = {
      userId: form.get('userId'),
      planDate: form.get('planDate'),
      departureTime: form.get('departureTime')
    };
    const result = await postJson('/admin/departure-plans', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=lines&date=${encodeURIComponent(payload.planDate)}&departurePlanSet=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=lines&date=${encodeURIComponent(payload.planDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/reservations/cancel') {
    const form = await readFormBody(req);
    const placeId = form.get('placeId') || '';
    const mapCode = form.get('mapCode') || '';
    const payload = {
      reservationId: form.get('reservationId')
    };
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/reservations/cancel', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(date)}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(placeId)}&reservationCanceled=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(date)}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(placeId)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employees') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const payload = {
      displayName: form.get('displayName'),
      department: form.get('department'),
      email: form.get('email'),
      phone: form.get('phone'),
      yandexMessengerUserId: form.get('yandexMessengerUserId')
    };
    const result = await postJson('/admin/employees', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(selectedDate)}&employeeCreated=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employee-parking-requests') {
    const form = await readFormBody(req);
    const payload = {
      userId: form.get('userId'),
      requestDate: form.get('requestDate'),
      notes: form.get('notes')
    };
    const result = await postJson('/admin/employee-parking-requests', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(payload.requestDate)}&requested=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(payload.requestDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/employee-parking-requests/cancel') {
    const form = await readFormBody(req);
    const payload = {
      requestId: form.get('requestId')
    };
    const requestDate = form.get('requestDate') || todayIsoDate();
    const result = await postJson('/admin/employee-parking-requests/cancel', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&requestCanceled=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/guest-parking-requests') {
    const form = await readFormBody(req);
    const returnView = form.get('returnView') === 'day' ? 'day' : 'requests';
    const returnPlaceId = form.get('placeId') || '';
    const returnMapCode = form.get('mapCode') || '';
    const payload = {
      hostUserId: form.get('hostUserId'),
      requestDate: form.get('requestDate'),
      guestName: form.get('guestName'),
      guestPhone: form.get('guestPhone'),
      vehiclePlateNumber: form.get('vehiclePlateNumber'),
      notes: form.get('notes')
    };
    const result = await postJson('/admin/guest-parking-requests', payload);

    if (result.ok) {
      const warnings = result.data?.warnings || [];
      const warningText = warnings.length ? `&warning=${encodeURIComponent(warnings.map((warning) => warning.message || warning.type).join('; '))}` : '';
      const location =
        returnView === 'day'
          ? `/?view=day&date=${encodeURIComponent(payload.requestDate)}&mapCode=${encodeURIComponent(returnMapCode)}&placeId=${encodeURIComponent(returnPlaceId)}&guestCreated=1${warningText}`
          : `/?view=requests&date=${encodeURIComponent(payload.requestDate)}&guestCreated=1${warningText}`;
      res.writeHead(303, { location });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    const location =
      returnView === 'day'
        ? `/?view=day&date=${encodeURIComponent(payload.requestDate || '')}&mapCode=${encodeURIComponent(returnMapCode)}&placeId=${encodeURIComponent(returnPlaceId)}&error=${encodeURIComponent(message)}`
        : `/?view=requests&date=${encodeURIComponent(payload.requestDate || '')}&error=${encodeURIComponent(message)}`;
    res.writeHead(303, { location });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/guest-parking-requests/cancel') {
    const form = await readFormBody(req);
    const payload = {
      requestId: form.get('requestId')
    };
    const requestDate = form.get('requestDate') || todayIsoDate();
    const result = await postJson('/admin/guest-parking-requests/cancel', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&guestCanceled=1` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/guest-parking-requests/assign') {
    const form = await readFormBody(req);
    const payload = {
      requestId: form.get('requestId')
    };
    const requestDate = form.get('requestDate') || todayIsoDate();
    const result = await postJson('/admin/guest-parking-requests/assign', payload);

    if (result.ok) {
      const warnings = result.data?.warnings || [];
      const warningText = warnings.length ? `&warning=${encodeURIComponent(warnings.map((warning) => warning.message || warning.type).join('; '))}` : '';
      res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&guestAssigned=1${warningText}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/admin/queue-run') {
    const form = await readFormBody(req);
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/jobs/process-queue', { date });

    if (result.ok) {
      const assigned = result.data?.assignedCount || 0;
      const skipped = result.data?.skippedCount || 0;
      res.writeHead(303, {
        location: `/?view=requests&date=${encodeURIComponent(date)}&queueProcessed=1&assigned=${encodeURIComponent(assigned)}&skipped=${encodeURIComponent(skipped)}`
      });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  // All five scheduled jobs are manually runnable from the Журнал tab for a chosen
  // date. They differ only in name, so one proxy serves them instead of five copies.
  const manualJobRoutes = new Map([
    ['/admin/jobs/lock-departure-plans', 'lock_departure_plans'],
    ['/admin/jobs/process-queue', 'process_queue'],
    ['/admin/jobs/rebuild-conflicts', 'rebuild_conflicts'],
    ['/admin/jobs/freeze-next-day', 'freeze_next_day'],
    ['/admin/jobs/unlock-employee-pool', 'unlock_employee_pool']
  ]);

  if (req.method === 'POST' && manualJobRoutes.has(url.pathname)) {
    const jobName = manualJobRoutes.get(url.pathname);
    const form = await readFormBody(req);
    const date = form.get('date') || todayIsoDate();
    const result = await postJson(url.pathname, { date });

    if (result.ok) {
      res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&jobDone=${encodeURIComponent(jobName)}` });
      res.end();
      return true;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return true;
  }

  return false;
}

module.exports = {
  handleFormRoutes
};
