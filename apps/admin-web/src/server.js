'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');

const port = Number(process.env.PORT || 3100);
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000';
const mapStoragePath = process.env.MAP_STORAGE_PATH || '/app/storage/maps';

const parkingMaps = [
  {
    id: 'g4',
    title: 'G4',
    description: 'Underground parking level G4',
    filename: 'parking-g4.jpg'
  },
  {
    id: 'g5',
    title: 'G5',
    description: 'Underground parking level G5',
    filename: 'parking-g5.jpg'
  }
];

const knownMapFiles = new Set(parkingMaps.map((map) => map.filename));

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function fetchJson(pathname) {
  const response = await fetch(`${apiBaseUrl}${pathname}`);
  const text = await response.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function postJson(pathname, payload) {
  const response = await fetch(`${apiBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();

  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

async function readFormBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  return String(value).slice(0, 10);
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function renderTabs(activeView, selectedDate) {
  const dashboardHref = `/?date=${encodeURIComponent(selectedDate)}`;
  const mapsHref = `/?view=maps&date=${encodeURIComponent(selectedDate)}`;

  return `
    <nav class="tabs" aria-label="Admin sections">
      <a class="${activeView === 'dashboard' ? 'active' : ''}" href="${dashboardHref}">Операции</a>
      <a class="${activeView === 'maps' ? 'active' : ''}" href="${mapsHref}">Карты</a>
    </nav>
  `;
}

function renderPlacesTable(places) {
  if (!places.length) {
    return '<p class="empty">Места пока не загружены в каталог.</p>';
  }

  const rows = places
    .map((place) => {
      const tags = [
        place.placeType,
        place.floorLabel || 'без этажа',
        place.lineGroup ? `линия ${place.lineGroup.code}` : 'без линии',
        place.isActive ? 'active' : 'inactive'
      ]
        .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
        .join('');

      return `
        <tr>
          <td>${escapeHtml(place.code)}</td>
          <td>${escapeHtml(place.title)}</td>
          <td>${tags}</td>
          <td>${place.permanentOwner ? escapeHtml(place.permanentOwner.displayName) : '—'}</td>
          <td>${place.permanentOwner?.department ? escapeHtml(place.permanentOwner.department) : '—'}</td>
          <td>${place.guestPriorityRank == null ? '—' : escapeHtml(place.guestPriorityRank)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Код</th>
          <th>Название</th>
          <th>Атрибуты</th>
          <th>Владелец</th>
          <th>Дирекция</th>
          <th>Guest priority</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMapsTab() {
  const cards = parkingMaps
    .map(
      (map) => `
        <article class="map-card">
          <div class="map-card-head">
            <div>
              <h3>${escapeHtml(map.title)}</h3>
              <p>${escapeHtml(map.description)}</p>
            </div>
            <span class="tag">clickable</span>
          </div>
          <button class="map-click-catcher" type="button" data-map-id="${escapeHtml(map.id)}" aria-label="Карта ${escapeHtml(map.title)}">
            <img src="/maps/${escapeHtml(map.filename)}" alt="Карта парковки ${escapeHtml(map.title)}" loading="lazy" />
          </button>
        </article>
      `
    )
    .join('');

  return `
    <section class="card">
      <h2 class="section-title">Parking Maps</h2>
      <p class="section-copy">Черновая вкладка карт. Сейчас клик по изображению показывает координаты точки; следующим шагом на эти координаты можно навесить зоны конкретных мест.</p>
      <p class="notice notice-ok" id="map-click-output">Кликните по карте, чтобы увидеть координаты точки.</p>
      <div class="maps-grid">${cards}</div>
    </section>
    <script>
      for (const button of document.querySelectorAll('.map-click-catcher')) {
        button.addEventListener('click', (event) => {
          const rect = button.getBoundingClientRect();
          const x = ((event.clientX - rect.left) / rect.width).toFixed(4);
          const y = ((event.clientY - rect.top) / rect.height).toFixed(4);
          const output = document.getElementById('map-click-output');
          output.textContent = 'Карта ' + button.dataset.mapId.toUpperCase() + ': x=' + x + ', y=' + y;
        });
      }
    </script>
  `;
}

function renderReleaseForm(places, model) {
  const ownedPlaces = places.filter((place) => place.permanentOwner);
  const today = todayIsoDate();
  const selectedPlaceId = model.form?.parkingPlaceId || '';
  const dateFrom = model.form?.dateFrom || today;
  const dateTo = model.form?.dateTo || dateFrom;
  const notes = model.form?.notes || '';

  const options = ownedPlaces
    .map((place) => {
      const owner = place.permanentOwner.displayName;
      const selected = place.id === selectedPlaceId ? ' selected' : '';
      return `<option value="${escapeHtml(place.id)}"${selected}>${escapeHtml(`${place.code} · ${owner}`)}</option>`;
    })
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/place-releases">
      <label>
        <span>Закрепленное место</span>
        <select name="parkingPlaceId" required>
          <option value="">Выберите место</option>
          ${options}
        </select>
      </label>
      <label>
        <span>С даты</span>
        <input type="date" name="dateFrom" value="${escapeHtml(dateFrom)}" required />
      </label>
      <label>
        <span>По дату</span>
        <input type="date" name="dateTo" value="${escapeHtml(dateTo)}" required />
      </label>
      <label class="wide">
        <span>Комментарий</span>
        <input type="text" name="notes" value="${escapeHtml(notes)}" placeholder="Например: отпуск, командировка, удаленка" />
      </label>
      <button type="submit">Отдать место</button>
    </form>
  `;
}

function renderDateSelector(selectedDate) {
  return `
    <form class="date-form" method="get" action="/">
      <label>
        <span>Операционный день</span>
        <input type="date" name="date" value="${escapeHtml(selectedDate)}" required />
      </label>
      <button type="submit">Показать день</button>
    </form>
  `;
}

function renderReleasesTable(releases) {
  if (!releases.length) {
    return '<p class="empty">Активных отдач пока нет.</p>';
  }

  const rows = releases
    .map(
      (release) => `
        <tr>
          <td>${escapeHtml(formatDate(release.dateFrom))}</td>
          <td>${escapeHtml(formatDate(release.dateTo))}</td>
          <td>${escapeHtml(release.parkingPlace.code)}</td>
          <td>${escapeHtml(release.user.displayName)}</td>
          <td>${release.user.department ? escapeHtml(release.user.department) : '—'}</td>
          <td>${release.notes ? escapeHtml(release.notes) : '—'}</td>
        </tr>
      `
    )
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>С даты</th>
          <th>По дату</th>
          <th>Место</th>
          <th>Владелец</th>
          <th>Дирекция</th>
          <th>Комментарий</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderManualReservationForm(model) {
  const employees = model.employees?.data?.employees || [];
  const dashboard = model.dashboard?.data || {};
  const selectedDate = dashboard.date || model.selectedDate;
  const availablePlaces = (dashboard.releasedPlaces || []).filter((place) => !place.isReserved);

  if (!availablePlaces.length) {
    return '<p class="empty">На выбранную дату пока нет свободных отданных мест для ручного назначения.</p>';
  }

  const placeOptions = availablePlaces
    .map((item) => {
      const label = `${item.parkingPlace.code} · владелец ${item.owner.displayName}`;
      return `<option value="${escapeHtml(item.parkingPlace.id)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  const employeeOptions = employees
    .map((employee) => {
      const department = employee.department ? ` · ${employee.department}` : '';
      return `<option value="${escapeHtml(employee.id)}">${escapeHtml(`${employee.displayName}${department}`)}</option>`;
    })
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/reservations/manual">
      <input type="hidden" name="reservationDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Отданное место</span>
        <select name="parkingPlaceId" required>
          <option value="">Выберите место</option>
          ${placeOptions}
        </select>
      </label>
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Кому назначить</option>
          ${employeeOptions}
        </select>
      </label>
      <label class="wide">
        <span>Причина</span>
        <input type="text" name="reason" placeholder="Например: ручное назначение администратором" />
      </label>
      <button type="submit">Назначить</button>
    </form>
  `;
}

function renderDayDashboard(model) {
  const dashboard = model.dashboard?.data || {};
  const releasedPlaces = dashboard.releasedPlaces || [];
  const reservations = dashboard.reservations || [];
  const freeCount = releasedPlaces.filter((place) => !place.isReserved).length;

  const releaseRows = releasedPlaces.length
    ? releasedPlaces
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(item.parkingPlace.code)}</td>
              <td>${escapeHtml(item.owner.displayName)}</td>
              <td>${item.owner.department ? escapeHtml(item.owner.department) : '—'}</td>
              <td>${item.isReserved ? '<span class="tag reserved">назначено</span>' : '<span class="tag free">свободно</span>'}</td>
              <td>${item.releaseNotes ? escapeHtml(item.releaseNotes) : '—'}</td>
            </tr>
          `
        )
        .join('')
    : '';

  const reservationRows = reservations.length
    ? reservations
        .map(
          (reservation) => `
            <tr>
              <td>${escapeHtml(reservation.parkingPlace.code)}</td>
              <td>${reservation.user ? escapeHtml(reservation.user.displayName) : '—'}</td>
              <td>${reservation.user?.department ? escapeHtml(reservation.user.department) : '—'}</td>
              <td>${escapeHtml(reservation.source)}</td>
              <td>${reservation.reason ? escapeHtml(reservation.reason) : '—'}</td>
            </tr>
          `
        )
        .join('')
    : '';

  return `
    <div class="mini-grid">
      <article>
        <p class="label">Отдано мест</p>
        <p class="value">${escapeHtml(releasedPlaces.length)}</p>
      </article>
      <article>
        <p class="label">Доступно к назначению</p>
        <p class="value">${escapeHtml(freeCount)}</p>
      </article>
      <article>
        <p class="label">Активных назначений</p>
        <p class="value">${escapeHtml(reservations.length)}</p>
      </article>
    </div>

    <h3>Ручное назначение</h3>
    ${renderManualReservationForm(model)}

    <h3>Отданные места на день</h3>
    ${
      releasedPlaces.length
        ? `<table>
            <thead>
              <tr>
                <th>Место</th>
                <th>Владелец</th>
                <th>Дирекция</th>
                <th>Статус</th>
                <th>Комментарий</th>
              </tr>
            </thead>
            <tbody>${releaseRows}</tbody>
          </table>`
        : '<p class="empty">На выбранную дату активных отдач нет.</p>'
    }

    <h3>Назначения на день</h3>
    ${
      reservations.length
        ? `<table>
            <thead>
              <tr>
                <th>Место</th>
                <th>Кому</th>
                <th>Дирекция</th>
                <th>Источник</th>
                <th>Причина</th>
              </tr>
            </thead>
            <tbody>${reservationRows}</tbody>
          </table>`
        : '<p class="empty">На выбранную дату назначений пока нет.</p>'
    }
  `;
}

function renderPage(model) {
  const placesCount = Array.isArray(model.places?.data?.places) ? model.places.data.places.length : 0;
  const places = model.places?.data?.places || [];
  const releases = model.releases?.data?.releases || [];
  const selectedDate = model.selectedDate || todayIsoDate();
  const activeView = model.activeView || 'dashboard';
  const bootstrap = model.bootstrap?.data?.bootstrapUser;
  const bootstrapState = bootstrap
    ? `${bootstrap.login} (${bootstrap.authStatus})`
    : 'не найден';
  const notice = model.notice
    ? `<p class="notice ${model.notice.type === 'error' ? 'notice-error' : 'notice-ok'}">${escapeHtml(model.notice.text)}</p>`
    : '';

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Parking Assistant Admin</title>
    <style>
      :root {
        --bg: #f4efe7;
        --card: #fffaf2;
        --line: #d8cfc0;
        --text: #1f2328;
        --muted: #6c706f;
        --accent: #1f6f78;
        --accent-soft: #d8eeef;
        --danger: #9f3a2a;
        --ok: #2f6846;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(31,111,120,0.08), transparent 28%),
          linear-gradient(180deg, #f8f2e8 0%, var(--bg) 100%);
      }

      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(34px, 5vw, 56px);
        line-height: 0.95;
      }

      .subhead {
        margin: 0 0 26px;
        color: var(--muted);
        font-size: 18px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 8px 30px rgba(31, 35, 40, 0.06);
      }

      h3 {
        margin: 24px 0 12px;
        font-size: 20px;
      }

      .label {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .value {
        margin: 0;
        font-size: 28px;
      }

      .status-ok {
        color: var(--accent);
      }

      .status-error {
        color: var(--danger);
      }

      .section-title {
        margin: 0 0 16px;
        font-size: 26px;
      }

      .section-copy {
        margin: -8px 0 18px;
        color: var(--muted);
      }

      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 0 0 22px;
      }

      .tabs a {
        display: inline-flex;
        align-items: center;
        min-height: 42px;
        padding: 10px 16px;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--text);
        background: rgba(255, 250, 242, 0.74);
        text-decoration: none;
      }

      .tabs a.active {
        border-color: var(--accent);
        color: #fff;
        background: var(--accent);
      }

      .notice {
        margin: 0 0 18px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: #fff;
      }

      .notice-ok {
        color: var(--ok);
      }

      .notice-error {
        color: var(--danger);
      }

      .action-form,
      .date-form {
        display: grid;
        grid-template-columns: minmax(240px, 2fr) repeat(2, minmax(150px, 1fr));
        gap: 14px;
        align-items: end;
        margin-bottom: 22px;
      }

      .date-form {
        grid-template-columns: minmax(220px, 320px) 180px;
      }

      .action-form label,
      .date-form label {
        display: grid;
        gap: 7px;
      }

      .action-form label.wide {
        grid-column: span 2;
      }

      .action-form span,
      .date-form span {
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      select,
      input,
      button {
        width: 100%;
        min-height: 43px;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        font: inherit;
        background: #fff;
      }

      button {
        border-color: var(--accent);
        color: #fff;
        background: var(--accent);
        cursor: pointer;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        padding: 14px 10px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
      }

      th {
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .tag {
        display: inline-block;
        margin: 0 8px 8px 0;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        font-size: 13px;
      }

      .tag.free {
        background: #dcefd7;
      }

      .tag.reserved {
        background: #ead8c4;
      }

      .mini-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 8px;
      }

      .mini-grid article {
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.44);
      }

      .maps-grid {
        display: grid;
        gap: 18px;
      }

      .map-card {
        display: grid;
        gap: 12px;
      }

      .map-card-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }

      .map-card h3,
      .map-card p {
        margin: 0;
      }

      .map-card p {
        color: var(--muted);
      }

      .map-click-catcher {
        display: block;
        width: 100%;
        padding: 0;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
        cursor: crosshair;
      }

      .map-click-catcher img {
        display: block;
        width: 100%;
        height: auto;
      }

      .empty {
        margin: 0;
        color: var(--muted);
      }

      @media (max-width: 760px) {
        .action-form,
        .date-form,
        .action-form label.wide {
          display: grid;
          grid-template-columns: 1fr;
          grid-column: auto;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Parking Assistant</h1>
      <p class="subhead">Минимальная админка для проверки backend, каталога мест и bootstrap-состояния системы.</p>
      ${renderTabs(activeView, selectedDate)}
      ${notice}

      <section class="grid">
        <article class="card">
          <p class="label">API Health</p>
          <p class="value ${model.health.ok ? 'status-ok' : 'status-error'}">${escapeHtml(model.health.data?.status || 'error')}</p>
        </article>
        <article class="card">
          <p class="label">DB Health</p>
          <p class="value ${model.db.ok ? 'status-ok' : 'status-error'}">${escapeHtml(model.db.data?.status || 'error')}</p>
        </article>
        <article class="card">
          <p class="label">Bootstrap Admin</p>
          <p class="value">${escapeHtml(bootstrapState)}</p>
        </article>
        <article class="card">
          <p class="label">Places In Catalog</p>
          <p class="value">${escapeHtml(placesCount)}</p>
        </article>
      </section>

      ${
        activeView === 'maps'
          ? renderMapsTab()
          : `
            <section class="card">
              <h2 class="section-title">Day Dashboard</h2>
              <p class="section-copy">Выбранная дата: ${escapeHtml(selectedDate)}. Здесь видны отданные места, свободный пул и ручные назначения.</p>
              ${renderDateSelector(selectedDate)}
              ${renderDayDashboard(model)}
            </section>

            <section class="card">
              <h2 class="section-title">Place Releases</h2>
              <p class="section-copy">Первая рабочая операция: администратор может отметить, что владелец отдал закрепленное место на дату или диапазон.</p>
              ${renderReleaseForm(places, model)}
              ${renderReleasesTable(releases)}
            </section>

            <section class="card">
              <h2 class="section-title">Parking Places</h2>
              ${renderPlacesTable(places)}
            </section>
          `
      }
    </main>
  </body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ status: 'ok', service: 'admin-web' }));
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/maps/')) {
    const filename = path.basename(decodeURIComponent(url.pathname.replace('/maps/', '')));

    if (!knownMapFiles.has(filename)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: 'Map not found' }));
      return;
    }

    const mapPath = path.join(mapStoragePath, filename);

    if (!fs.existsSync(mapPath)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: 'Map file is not uploaded yet' }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'cache-control': 'public, max-age=300'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(mapPath).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const selectedDate = url.searchParams.get('date') || todayIsoDate();
      const activeView = url.searchParams.get('view') === 'maps' ? 'maps' : 'dashboard';
      const [health, db, bootstrap, places, releases, employees, dashboard] = await Promise.all([
        fetchJson('/health'),
        fetchJson('/health/db'),
        fetchJson('/auth/bootstrap-status'),
        fetchJson('/admin/places'),
        fetchJson('/admin/place-releases'),
        fetchJson('/admin/employees'),
        fetchJson(`/admin/dashboard?date=${encodeURIComponent(selectedDate)}`)
      ]);
      const notice =
        url.searchParams.get('released') === '1'
          ? { type: 'ok', text: 'Отдача места создана.' }
          : url.searchParams.get('reserved') === '1'
            ? { type: 'ok', text: 'Ручное назначение создано.' }
          : url.searchParams.get('error')
            ? { type: 'error', text: url.searchParams.get('error') }
            : null;

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage({ health, db, bootstrap, places, releases, employees, dashboard, selectedDate, activeView, notice }));
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>Admin Web Error</h1><pre>${escapeHtml(error.message)}</pre>`);
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/place-releases') {
    const form = await readFormBody(req);
    const payload = {
      parkingPlaceId: form.get('parkingPlaceId'),
      dateFrom: form.get('dateFrom'),
      dateTo: form.get('dateTo'),
      notes: form.get('notes')
    };
    const result = await postJson('/admin/place-releases', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?date=${encodeURIComponent(payload.dateFrom)}&released=1` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/reservations/manual') {
    const form = await readFormBody(req);
    const payload = {
      userId: form.get('userId'),
      parkingPlaceId: form.get('parkingPlaceId'),
      reservationDate: form.get('reservationDate'),
      reason: form.get('reason')
    };
    const result = await postJson('/admin/reservations/manual', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?date=${encodeURIComponent(payload.reservationDate)}&reserved=1` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?date=${encodeURIComponent(payload.reservationDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant admin-web listening on port ${port}`);
});
