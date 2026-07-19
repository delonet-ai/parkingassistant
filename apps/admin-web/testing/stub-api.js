'use strict';

// A canned stand-in for the backend API, so the admin UI can be rendered and asserted
// without a database.
//
// admin-web is a pure proxy over the API — every tab is `fetchJson` plus a renderer — so
// serving a fixed payload per path is enough to exercise the real request handler, the
// real renderers and the real HTML. `server.js` self-starts its listener on require and
// exports nothing, which is why this boots it as a child process rather than importing it.

const { spawn } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const PLACE_ID = '11111111-1111-4111-8111-111111111111';
const BLOCKED_PLACE_ID = '11111111-1111-4111-8111-111111111112';
const LINE_ID = '22222222-2222-4222-8222-222222222221';
const TRIPLE_LINE_ID = '22222222-2222-4222-8222-222222222223';
const EMPLOYEE_ID = '33333333-3333-4333-8333-333333333331';
const DISABLED_EMPLOYEE_ID = '33333333-3333-4333-8333-333333333332';
const RELEASE_ID = '44444444-4444-4444-8444-444444444441';
const RESERVATION_ID = '55555555-5555-4555-8555-555555555551';

const places = [
  {
    id: PLACE_ID,
    code: 'G4-118',
    title: 'G4-118',
    placeType: 'double',
    floorLabel: '4',
    placeRole: 'regular',
    isActive: true,
    linePositionHint: 1,
    guestPriorityRank: null,
    lineGroup: { id: LINE_ID, code: 'L-118', name: 'Линия 118', capacity: 2 },
    permanentOwner: { id: EMPLOYEE_ID, displayName: 'Иванов Иван' }
  },
  {
    id: BLOCKED_PLACE_ID,
    code: 'G4-119',
    title: 'G4-119',
    placeType: 'double',
    floorLabel: '4',
    placeRole: 'blocked',
    isActive: true,
    linePositionHint: 2,
    guestPriorityRank: null,
    lineGroup: { id: LINE_ID, code: 'L-118', name: 'Линия 118', capacity: 2 },
    permanentOwner: null
  }
];

const employees = [
  {
    id: EMPLOYEE_ID,
    displayName: 'Иванов Иван',
    department: 'ИТ',
    email: 'ivanov@example.com',
    phone: '+79000000001',
    isActive: true,
    permanentPlace: { id: PLACE_ID, code: 'G4-118' }
  },
  {
    id: DISABLED_EMPLOYEE_ID,
    displayName: 'Петров Пётр',
    department: 'Логистика',
    email: 'petrov@example.com',
    phone: null,
    isActive: false,
    permanentPlace: null
  }
];

const lineGroups = [
  {
    id: LINE_ID,
    code: 'L-118',
    name: 'Линия 118',
    capacity: 2,
    floorLabel: '4',
    places: [
      { id: PLACE_ID, code: 'G4-118', positionHint: 1 },
      { id: BLOCKED_PLACE_ID, code: 'G4-119', positionHint: 2 }
    ]
  },
  {
    id: TRIPLE_LINE_ID,
    code: 'L-200',
    name: 'Линия 200',
    capacity: 3,
    floorLabel: '4',
    places: [
      { id: '66666666-6666-4666-8666-666666666661', code: 'G4-200', positionHint: 1 },
      { id: '66666666-6666-4666-8666-666666666662', code: 'G4-201', positionHint: 2 },
      { id: '66666666-6666-4666-8666-666666666663', code: 'G4-202', positionHint: 3 }
    ]
  }
];

const placeLines = [
  {
    lineId: LINE_ID,
    code: 'L-118',
    capacity: 2,
    floorLabel: '4',
    slots: [
      {
        placeId: PLACE_ID,
        code: 'G4-118',
        title: 'G4-118',
        position: 1,
        placeType: 'double',
        placeRole: 'regular',
        guestPriorityRank: null,
        status: 'occupied',
        userDisplayName: 'Сидоров Сидор'
      },
      {
        placeId: BLOCKED_PLACE_ID,
        code: 'G4-119',
        title: 'G4-119',
        position: 2,
        placeType: 'double',
        placeRole: 'blocked',
        guestPriorityRank: null,
        status: 'blocked',
        userDisplayName: null
      }
    ]
  }
];

const dashboard = {
  date: null,
  totals: { totalPlaces: 5, releasedPlaces: 1, reservations: 1 },
  releasedPlaces: [
    {
      releaseId: RELEASE_ID,
      releaseNotes: 'Отпуск',
      isReserved: true,
      owner: { id: EMPLOYEE_ID, displayName: 'Иванов Иван', department: 'ИТ' },
      parkingPlace: { id: PLACE_ID, code: 'G4-118', title: 'G4-118', placeType: 'double' }
    }
  ],
  reservations: [
    {
      id: RESERVATION_ID,
      reservationDate: null,
      source: 'manual',
      reason: 'Ручное назначение',
      createdAt: '2026-07-19T08:00:00.000Z',
      user: { id: EMPLOYEE_ID, displayName: 'Сидоров Сидор', department: 'ИТ' },
      parkingPlace: { id: PLACE_ID, code: 'G4-118', title: 'G4-118', placeType: 'double' }
    }
  ],
  guestRequests: [],
  guestReserve: { minimum: 5, availablePlaces: 3, status: 'ok' }
};

/** Path (without query) → canned payload. Anything unlisted answers `{}`. */
const responses = new Map([
  ['/health', { status: 'ok', service: 'api' }],
  ['/health/db', { status: 'ok', service: 'api', database: { status: 'ok' } }],
  ['/auth/bootstrap-status', { status: 'ok', bootstrap: { required: false } }],
  ['/admin/places', { status: 'ok', places }],
  ['/admin/employees', { status: 'ok', employees }],
  ['/admin/permanent-assignments', { status: 'ok', permanentAssignments: [] }],
  ['/admin/dashboard', { status: 'ok', ...dashboard }],
  ['/admin/employee-parking-requests', { status: 'ok', requests: [] }],
  ['/admin/guest-parking-requests', { status: 'ok', requests: [] }],
  ['/admin/jobs/runs', { status: 'ok', runs: [], latestRuns: [] }],
  ['/admin/line-groups', { status: 'ok', lineGroups }],
  ['/admin/line-occupancy', { status: 'ok', occupancy: [] }],
  ['/admin/departure-plans', { status: 'ok', plans: [] }],
  ['/admin/conflicts', { status: 'ok', conflicts: [] }],
  ['/admin/audit-logs', { status: 'ok', auditLogs: [] }],
  ['/admin/contact-access-logs', { status: 'ok', contactAccessLogs: [] }],
  ['/admin/map-diagnostics', { status: 'ok', diagnostics: { placeWithoutLine: [], lineCapacityMismatch: [] } }],
  ['/admin/place-lines', { status: 'ok', lines: placeLines }]
]);

/** `/admin/{places,employees}/:id/history` — matched by shape, not by exact path. */
function historyPayload(pathname) {
  const placeMatch = pathname.match(/^\/admin\/places\/([^/]+)\/history$/);
  if (placeMatch) {
    const place = places.find((item) => item.id === placeMatch[1]) || places[0];

    return {
      status: 'ok',
      place,
      permanentAssignments: [],
      releases: [],
      reservations: [],
      auditLogs: []
    };
  }

  const employeeMatch = pathname.match(/^\/admin\/employees\/([^/]+)\/history$/);
  if (employeeMatch) {
    const employee = employees.find((item) => item.id === employeeMatch[1]) || employees[0];

    return {
      status: 'ok',
      employee,
      permanentAssignments: [],
      releases: [],
      reservations: [],
      requests: [],
      auditLogs: []
    };
  }

  return null;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Records every path the UI asked for, so a test can assert a request is NOT made. */
function startStubApi() {
  const requestedPaths = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requestedPaths.push(url.pathname);
    const payload = responses.get(url.pathname) || historyPayload(url.pathname) || { status: 'ok' };

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        requestedPaths,
        stop: () => new Promise((done) => server.close(done))
      });
    });
  });
}

/** Boots the real admin-web process against the stub and waits for /health. */
async function startAdminWeb({ apiBaseUrl }) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, PORT: String(port), API_BASE_URL: apiBaseUrl },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;

  for (;;) {
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error('admin-web did not become healthy in time');
    }

    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        break;
      }
    } catch {
      // not listening yet
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    baseUrl,
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      })
  };
}

async function getHtml(baseUrl, pathname) {
  const response = await fetch(`${baseUrl}${pathname}`);

  return { status: response.status, html: await response.text() };
}

module.exports = {
  BLOCKED_PLACE_ID,
  DISABLED_EMPLOYEE_ID,
  PLACE_ID,
  RELEASE_ID,
  getHtml,
  startAdminWeb,
  startStubApi
};
