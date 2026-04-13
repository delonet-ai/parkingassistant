'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const port = Number(process.env.PORT || 3100);
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000';

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

function renderPage(model) {
  const placesCount = Array.isArray(model.places?.data?.places) ? model.places.data.places.length : 0;
  const bootstrap = model.bootstrap?.data?.bootstrapUser;
  const bootstrapState = bootstrap
    ? `${bootstrap.login} (${bootstrap.authStatus})`
    : 'не найден';

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

      .empty {
        margin: 0;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Parking Assistant</h1>
      <p class="subhead">Минимальная админка для проверки backend, каталога мест и bootstrap-состояния системы.</p>

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

      <section class="card">
        <h2 class="section-title">Parking Places</h2>
        ${renderPlacesTable(model.places?.data?.places || [])}
      </section>
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

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const [health, db, bootstrap, places] = await Promise.all([
        fetchJson('/health'),
        fetchJson('/health/db'),
        fetchJson('/auth/bootstrap-status'),
        fetchJson('/admin/places')
      ]);

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage({ health, db, bootstrap, places }));
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>Admin Web Error</h1><pre>${escapeHtml(error.message)}</pre>`);
      return;
    }
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant admin-web listening on port ${port}`);
});
