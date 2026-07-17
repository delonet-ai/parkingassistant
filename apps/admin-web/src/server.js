'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { escapeHtml } = require('../../../packages/shared/html');
const { readFormBody, readJsonBody } = require('../../../packages/shared/http');
const { createRenderModules, renderActiveTab } = require('./render-modules');

const port = Number(process.env.PORT || 3100);
const apiBaseUrl = process.env.API_BASE_URL || 'http://api:3000';
const mapStoragePath = process.env.MAP_STORAGE_PATH || '/app/storage/maps';

const parkingMaps = [
  {
    id: 'g3',
    title: 'G3',
    description: 'Underground parking level G3',
    filename: 'parking-g3.png',
    width: 2105,
    height: 1490
  },
  {
    id: 'g4',
    title: 'G4',
    description: 'Underground parking level G4',
    filename: 'parking-g4.png',
    width: 2105,
    height: 1490
  },
  {
    id: 'g5',
    title: 'G5',
    description: 'Underground parking level G5',
    filename: 'parking-g5.png',
    width: 2105,
    height: 1490
  }
];

const allowedMapExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);

function contentTypeForMap(filename) {
  if (filename.endsWith('.svg')) {
    return 'image/svg+xml';
  }
  if (filename.endsWith('.webp')) {
    return 'image/webp';
  }
  if (filename.endsWith('.png')) {
    return 'image/png';
  }
  return 'image/jpeg';
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

function formatDate(value) {
  if (!value) {
    return '';
  }

  return String(value).slice(0, 10);
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  return new Date(value).toLocaleString('ru-RU');
}

function renderJsonPreview(value) {
  if (!value || (typeof value === 'object' && !Object.keys(value).length)) {
    return '—';
  }

  return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function filenameFromMapFilePath(filePath, fallbackFilename) {
  if (!filePath) {
    return fallbackFilename;
  }

  return path.basename(String(filePath));
}

function configuredMaps(model = {}) {
  const mapsByCode = new Map((model.mapDiagnostics?.data?.maps || []).map((map) => [map.code, map]));

  return parkingMaps.map((fallback) => {
    const metadata = mapsByCode.get(fallback.id) || null;
    return {
      ...fallback,
      filename: filenameFromMapFilePath(metadata?.filePath, fallback.filename),
      metadata
    };
  });
}

async function readRawBody(req, limitBytes = 15 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipartFormData(contentType, body) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];

  if (!boundary) {
    throw new Error('Multipart boundary is missing');
  }

  const delimiter = `--${boundary}`;
  const parts = body.toString('binary').split(delimiter).slice(1, -1);
  const fields = new Map();
  const files = new Map();

  for (const rawPart of parts) {
    const trimmed = rawPart.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const headerEnd = trimmed.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      continue;
    }

    const rawHeaders = trimmed.slice(0, headerEnd);
    const rawContent = trimmed.slice(headerEnd + 4);
    const headers = new Map(
      rawHeaders.split('\r\n').map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
      })
    );
    const disposition = headers.get('content-disposition') || '';
    const name = /name="([^"]+)"/.exec(disposition)?.[1];
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];

    if (!name) {
      continue;
    }

    const content = Buffer.from(rawContent, 'binary');
    if (filename) {
      files.set(name, {
        filename,
        contentType: headers.get('content-type') || 'application/octet-stream',
        buffer: content
      });
    } else {
      fields.set(name, content.toString('utf8'));
    }
  }

  return { fields, files };
}

function renderTabs(activeView, selectedDate) {
  const dayHref = `/?view=day&date=${encodeURIComponent(selectedDate)}`;
  const requestsHref = `/?view=requests&date=${encodeURIComponent(selectedDate)}`;
  const catalogHref = `/?view=catalog&date=${encodeURIComponent(selectedDate)}`;
  const linesHref = `/?view=lines&date=${encodeURIComponent(selectedDate)}`;
  const auditHref = `/?view=audit&date=${encodeURIComponent(selectedDate)}`;
  const mapsHref = `/?view=maps&date=${encodeURIComponent(selectedDate)}`;

  return `
    <nav class="tabs" aria-label="Admin sections">
      <a class="${activeView === 'day' ? 'active' : ''}" href="${dayHref}">День</a>
      <a class="${activeView === 'requests' ? 'active' : ''}" href="${requestsHref}">Заявки</a>
      <a class="${activeView === 'lines' ? 'active' : ''}" href="${linesHref}">Линии</a>
      <a class="${activeView === 'catalog' ? 'active' : ''}" href="${catalogHref}">Справочники</a>
      <a class="${activeView === 'audit' ? 'active' : ''}" href="${auditHref}">Журнал</a>
      <a class="${activeView === 'maps' ? 'active' : ''}" href="${mapsHref}">Карта</a>
    </nav>
  `;
}

function renderPlacesTable(places, selectedDate = todayIsoDate()) {
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
          <td><a href="/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeId=${encodeURIComponent(place.id)}">История</a></td>
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
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderEmployeesTable(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];

  if (!employees.length) {
    return '<p class="empty">Сотрудников пока нет.</p>';
  }

  const rows = employees
    .map(
      (employee) => `
        <tr>
          <td>${escapeHtml(employee.displayName)}</td>
          <td>${employee.department ? escapeHtml(employee.department) : '—'}</td>
          <td>${employee.email ? escapeHtml(employee.email) : '—'}</td>
          <td>${employee.phone ? escapeHtml(employee.phone) : '—'}</td>
          <td>${employee.permanentPlace ? escapeHtml(employee.permanentPlace.code) : '—'}</td>
          <td>${employee.yandexMessengerUserId ? escapeHtml(employee.yandexMessengerUserId) : '—'}</td>
          <td><a href="/?view=catalog&date=${encodeURIComponent(selectedDate)}&employeeId=${encodeURIComponent(employee.id)}">История</a></td>
        </tr>
      `
    )
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Email</th>
          <th>Телефон</th>
          <th>Постоянное место</th>
          <th>Messenger ID</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderMapEditorTab(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const places = model.places?.data?.places || [];
  const activeMaps = configuredMaps(model);
  const diagnostics = model.mapDiagnostics?.data?.diagnostics || {};
  const placeOptions = places
    .map((place) => `<option value="${escapeHtml(place.id)}">${escapeHtml(`${place.code} · ${place.title}`)}</option>`)
    .join('');
  const uploadForms = activeMaps
    .map((map) => {
      const metadata = map.metadata;
      const checksum = metadata?.sourceChecksum ? metadata.sourceChecksum.slice(0, 12) : '—';
      const version = metadata?.version || 0;
      const filePath = metadata?.filePath || `/maps/${map.filename}`;

      return `
        <form class="map-upload-form" method="post" action="/admin/map-backgrounds" enctype="multipart/form-data">
          <input type="hidden" name="mapCode" value="${escapeHtml(map.id)}" />
          <input type="hidden" name="mapTitle" value="${escapeHtml(map.title)}" />
          <input type="hidden" name="floorLabel" value="${escapeHtml(map.id.replace(/^g/, ''))}" />
          <div>
            <strong>${escapeHtml(map.title)}</strong>
            <span class="muted">v${escapeHtml(version)} · ${escapeHtml(checksum)} · ${escapeHtml(filePath)}</span>
          </div>
          <label>
            <span>Файл</span>
            <input type="file" name="mapFile" accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml" required />
          </label>
          <button type="submit">Заменить</button>
        </form>
      `;
    })
    .join('');
  const diagnosticGroups = [
    {
      title: 'Зона без места',
      rows: diagnostics.zoneWithoutPlace || [],
      render: (item) => `
        <tr>
          <td>${escapeHtml(item.mapCode || '—')}</td>
          <td>${escapeHtml(item.zoneKey || item.zoneId || '—')}</td>
          <td>${item.parkingPlace ? escapeHtml(`${item.parkingPlace.code} · удалено`) : 'нет связи'}</td>
        </tr>
      `
    },
    {
      title: 'Место без зоны',
      rows: diagnostics.placeWithoutZone || [],
      render: (item) => `
        <tr>
          <td>${escapeHtml(item.mapCode || '—')}</td>
          <td>${escapeHtml(item.parkingPlace?.code || '—')}</td>
          <td>${escapeHtml(item.parkingPlace?.title || '—')}</td>
        </tr>
      `
    },
    {
      title: 'Неактивное место с активной зоной',
      rows: diagnostics.inactivePlaceWithActiveZone || [],
      render: (item) => `
        <tr>
          <td>${escapeHtml(item.mapCode || '—')}</td>
          <td>${escapeHtml(item.parkingPlace?.code || '—')}</td>
          <td>${escapeHtml(item.zoneKey || '—')}</td>
        </tr>
      `
    }
  ];
  const diagnosticHtml = diagnosticGroups
    .map((group) => {
      const rows = group.rows.map(group.render).join('');
      return `
        <article class="map-diagnostic">
          <div class="map-card-head">
            <h3>${escapeHtml(group.title)}</h3>
            <span class="tag">${escapeHtml(group.rows.length)}</span>
          </div>
          ${
            group.rows.length
              ? `<table>
                  <thead>
                    <tr>
                      <th>Карта</th>
                      <th>Объект</th>
                      <th>Детали</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>`
              : '<p class="empty">Проблем не найдено.</p>'
          }
        </article>
      `;
    })
    .join('');

  const cards = activeMaps
    .map(
      (map) => `
        <article class="map-card" data-map-id="${escapeHtml(map.id)}" data-map-title="${escapeHtml(map.title)}" data-map-filename="${escapeHtml(map.filename)}">
          <div class="map-card-head">
            <div>
              <h3>${escapeHtml(map.title)}</h3>
              <p>${escapeHtml(map.description)} · v${escapeHtml(map.metadata?.version || 0)} · ${escapeHtml(map.metadata?.sourceChecksum ? map.metadata.sourceChecksum.slice(0, 12) : 'checksum —')}</p>
            </div>
            <span class="tag">markup</span>
          </div>
          <div class="map-workspace">
            <svg
              class="map-svg"
              data-map-id="${escapeHtml(map.id)}"
              data-map-width="${escapeHtml(map.width)}"
              data-map-height="${escapeHtml(map.height)}"
              viewBox="0 0 ${escapeHtml(map.width)} ${escapeHtml(map.height)}"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Карта парковки ${escapeHtml(map.title)}"
            >
              <image href="/maps/${escapeHtml(map.filename)}" x="0" y="0" width="${escapeHtml(map.width)}" height="${escapeHtml(map.height)}" preserveAspectRatio="none"></image>
              <g class="map-zones-layer" aria-label="Размеченные места ${escapeHtml(map.title)}"></g>
              <rect class="map-draft-zone" hidden x="0" y="0" width="0" height="0"></rect>
            </svg>
          </div>
        </article>
      `
    )
    .join('');

  return `
    <section class="card">
      <h2 class="section-title">Редактор карт</h2>
      <p class="section-copy">Технический режим: разметка зон, изменение типа места на карте и удаление зон. Операционная работа по местам вынесена на вкладку “День”.</p>
      <div class="map-upload-panel">
        <p class="label">Подложки G3/G4/G5</p>
        <div class="map-upload-grid">${uploadForms}</div>
      </div>
      <div class="map-diagnostics">${diagnosticHtml}</div>
      <label class="map-edit-toggle">
        <input id="map-edit-mode" type="checkbox" />
        <span>Редактирование мест</span>
      </label>
      <div class="map-toolbar">
        <label>
          <span>Место для разметки</span>
          <select id="map-place-select">
            <option value="">Выберите место</option>
            ${placeOptions}
          </select>
        </label>
        <label>
          <span>Тип зоны</span>
          <select id="map-zone-type">
            <option value="rotatable">Ротируемое/гостевое</option>
            <option value="regular">Обычное</option>
            <option value="blocked">Недоступное</option>
          </select>
        </label>
      </div>
      <p class="notice notice-ok" id="map-click-output">SVG overlay готов. Свободные зоны зеленые, занятые медовые, ротируемые красные.</p>
      <div class="maps-grid">${cards}</div>
      <h3>Размеченные места</h3>
      <div id="map-zones-list">
        <p class="empty">Зоны пока не загружены.</p>
      </div>
    </section>
    <script>
      const selectedDate = ${JSON.stringify(selectedDate)};
      const editModeToggle = document.getElementById('map-edit-mode');
      const placeSelect = document.getElementById('map-place-select');
      const zoneTypeSelect = document.getElementById('map-zone-type');
      const output = document.getElementById('map-click-output');
      const maps = ${JSON.stringify(activeMaps.map(({ metadata, ...map }) => map))};
      const mapConfigs = new Map(maps.map((map) => [map.id, map]));
      const places = ${JSON.stringify(places.map((place) => ({ id: place.id, code: place.code, title: place.title })))};
      const placesById = new Map(places.map((place) => [place.id, place]));
      const zonesByMap = new Map();
      const zonesList = document.getElementById('map-zones-list');
      const SVG_NS = 'http://www.w3.org/2000/svg';

      function setOutput(text, isError = false) {
        output.textContent = text;
        output.classList.toggle('notice-error', isError);
        output.classList.toggle('notice-ok', !isError);
      }

      function isEditMode() {
        return editModeToggle.checked;
      }

      function syncEditMode() {
        const editing = isEditMode();
        document.body.classList.toggle('map-editing-enabled', editing);
        placeSelect.disabled = !editing;
        zoneTypeSelect.disabled = !editing;

        for (const control of zonesList.querySelectorAll('.map-zone-type-select, .map-zone-delete')) {
          control.disabled = !editing;
        }

        setOutput(
          editing
            ? 'Редактирование включено: выберите место и протяните прямоугольник по карте.'
            : 'Режим просмотра: можно нажимать на места и смотреть статус, разметка и удаление выключены.'
        );
      }

      function setSvgRectAttributes(rect, box) {
        rect.setAttribute('x', box.x);
        rect.setAttribute('y', box.y);
        rect.setAttribute('width', box.width);
        rect.setAttribute('height', box.height);
      }

      function pixelBoxFromGeometry(mapConfig, geometry) {
        const mapWidth = Number(mapConfig?.width || 1);
        const mapHeight = Number(mapConfig?.height || 1);
        return {
          x: Number(((geometry.x || 0) * mapWidth).toFixed(2)),
          y: Number(((geometry.y || 0) * mapHeight).toFixed(2)),
          width: Number(((geometry.width || 0) * mapWidth).toFixed(2)),
          height: Number(((geometry.height || 0) * mapHeight).toFixed(2))
        };
      }

      function renderZone(layer, zone, mapConfig) {
        const geometry = zone.geometry || {};
        const box = pixelBoxFromGeometry(mapConfig, geometry);
        const group = document.createElementNS(SVG_NS, 'g');
        group.classList.add('map-zone-group');
        group.dataset.zoneId = zone.id;
        group.dataset.placeId = zone.parkingPlace?.id || '';

        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.classList.add('map-zone-rect', 'map-zone-' + (zone.status || 'free'));
        setSvgRectAttributes(rect, box);

        const title = document.createElementNS(SVG_NS, 'title');
        const titleText = [
          zone.parkingPlace?.code || '',
          zone.status || 'free',
          zone.reservation?.userDisplayName || ''
        ].filter(Boolean).join(' · ');
        title.textContent = titleText;

        group.appendChild(title);
        group.appendChild(rect);

        const label = zone.parkingPlace?.code || zone.zoneKey || '?';
        if (box.width >= 36 && box.height >= 18) {
          const text = document.createElementNS(SVG_NS, 'text');
          text.classList.add('map-zone-label');
          text.setAttribute('x', box.x + box.width / 2);
          text.setAttribute('y', box.y + box.height / 2);
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('dominant-baseline', 'middle');
          text.textContent = label;
          group.appendChild(text);
        }

        group.addEventListener('click', (event) => {
          event.stopPropagation();
          if (!isEditMode() && zone.parkingPlace?.id) {
            window.location.href = '/?view=catalog&date=' + encodeURIComponent(selectedDate) + '&placeId=' + encodeURIComponent(zone.parkingPlace.id);
            return;
          }
          setOutput(titleText || label);
        });
        layer.appendChild(group);
      }

      function zoneTypeLabel(zoneType) {
        if (zoneType === 'rotatable') {
          return 'Ротируемое/гостевое';
        }
        if (zoneType === 'blocked') {
          return 'Недоступное';
        }
        return 'Обычное';
      }

      function renderZonesList() {
        const zones = Array.from(zonesByMap.entries()).flatMap(([mapId, mapZones]) =>
          mapZones.map((zone) => ({ ...zone, mapId }))
        );

        if (!zones.length) {
          zonesList.innerHTML = '<p class="empty">Размеченных мест пока нет. Выберите место сверху и протяните прямоугольник по карте.</p>';
          syncEditMode();
          return;
        }

        const rows = zones
          .sort((left, right) => String(left.parkingPlace?.code || '').localeCompare(String(right.parkingPlace?.code || ''), 'ru'))
          .map((zone) => {
            const geometry = zone.geometry || {};
            const zoneType = geometry.zoneType || 'regular';
            const coords = [
              'x=' + Number(geometry.x || 0).toFixed(4),
              'y=' + Number(geometry.y || 0).toFixed(4),
              'w=' + Number(geometry.width || 0).toFixed(4),
              'h=' + Number(geometry.height || 0).toFixed(4)
            ].join(', ');

            return \`
              <tr>
                <td>\${zone.mapId.toUpperCase()}</td>
                <td>\${zone.parkingPlace?.code || '—'}</td>
                <td>\${zone.parkingPlace?.title || '—'}</td>
                <td>
                  <select class="map-zone-type-select" data-zone-id="\${zone.id}" data-map-id="\${zone.mapId}">
                    <option value="regular"\${zoneType === 'regular' ? ' selected' : ''}>Обычное</option>
                    <option value="rotatable"\${zoneType === 'rotatable' ? ' selected' : ''}>Ротируемое/гостевое</option>
                    <option value="blocked"\${zoneType === 'blocked' ? ' selected' : ''}>Недоступное</option>
                  </select>
                </td>
                <td><span class="tag map-zone-status-\${zone.status || 'free'}">\${zone.status || 'free'}</span></td>
                <td>\${coords}</td>
                <td>
                  <button class="button-secondary map-zone-delete" type="button" data-zone-id="\${zone.id}" data-map-id="\${zone.mapId}">
                    Удалить с карты
                  </button>
                </td>
              </tr>
            \`;
          })
          .join('');

        zonesList.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Карта</th>
                <th>Место</th>
                <th>Название</th>
                <th>Тип зоны</th>
                <th>Статус</th>
                <th>Координаты</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>\${rows}</tbody>
          </table>
        \`;
        syncEditMode();
      }

      async function loadZones(card) {
        const mapId = card.dataset.mapId;
        const layer = card.querySelector('.map-zones-layer');
        const mapConfig = mapConfigs.get(mapId);
        layer.innerHTML = '';

        const response = await fetch('/admin/map-zones?mapCode=' + encodeURIComponent(mapId) + '&date=' + encodeURIComponent(selectedDate));
        const data = await response.json();

        if (!response.ok) {
          setOutput(data.error || 'Не удалось загрузить зоны', true);
          return;
        }

        zonesByMap.set(mapId, data.zones || []);
        for (const zone of data.zones || []) {
          renderZone(layer, zone, mapConfig);
        }
        renderZonesList();
      }

      async function updateZoneType(zoneId, zoneType, mapId) {
        const response = await fetch('/admin/map-zones/update', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ zoneId, zoneType })
        });
        const data = await response.json();

        if (!response.ok) {
          setOutput(data.error || 'Не удалось изменить тип зоны', true);
          return;
        }

        setOutput('Тип зоны изменен: ' + zoneTypeLabel(zoneType));
        const card = document.querySelector('.map-card[data-map-id="' + mapId + '"]');
        if (card) {
          await loadZones(card);
        }
      }

      async function deleteZone(zoneId, mapId) {
        const response = await fetch('/admin/map-zones/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ zoneId })
        });
        const data = await response.json();

        if (!response.ok) {
          setOutput(data.error || 'Не удалось удалить зону', true);
          return;
        }

        setOutput('Зона удалена с карты.');
        const card = document.querySelector('.map-card[data-map-id="' + mapId + '"]');
        if (card) {
          await loadZones(card);
        }
      }

      async function saveZone(card, geometry) {
        const parkingPlaceId = placeSelect.value;
        const selectedPlace = placesById.get(parkingPlaceId);

        if (!selectedPlace) {
          setOutput('Сначала выберите место для разметки.', true);
          return;
        }

        const payload = {
          mapCode: card.dataset.mapId,
          mapTitle: card.dataset.mapTitle,
          floorLabel: card.dataset.mapId.replace('g', ''),
          filePath: '/maps/' + card.dataset.mapFilename,
          parkingPlaceId,
          zoneType: zoneTypeSelect.value,
          geometry
        };

        const response = await fetch('/admin/map-zones', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await response.json();

        if (!response.ok) {
          setOutput(data.error || 'Не удалось сохранить зону', true);
          return;
        }

        setOutput('Зона сохранена: ' + selectedPlace.code + ' на карте ' + card.dataset.mapId.toUpperCase());
        await loadZones(card);
      }

      function svgPoint(svg, event) {
        const matrix = svg.getScreenCTM();
        if (!matrix) {
          return { x: 0, y: 0 };
        }

        const point = svg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const transformed = point.matrixTransform(matrix.inverse());
        const mapWidth = Number(svg.dataset.mapWidth || 1);
        const mapHeight = Number(svg.dataset.mapHeight || 1);

        return {
          x: Math.min(Math.max(transformed.x, 0), mapWidth),
          y: Math.min(Math.max(transformed.y, 0), mapHeight)
        };
      }

      function normalizedRect(svg, startPoint, currentPoint) {
        const mapWidth = Number(svg.dataset.mapWidth || 1);
        const mapHeight = Number(svg.dataset.mapHeight || 1);
        const startX = Math.min(Math.max(startPoint.x, 0), mapWidth);
        const startY = Math.min(Math.max(startPoint.y, 0), mapHeight);
        const currentX = Math.min(Math.max(currentPoint.x, 0), mapWidth);
        const currentY = Math.min(Math.max(currentPoint.y, 0), mapHeight);
        const left = Math.min(startX, currentX);
        const top = Math.min(startY, currentY);
        const width = Math.abs(currentX - startX);
        const height = Math.abs(currentY - startY);

        return {
          x: Number((left / mapWidth).toFixed(6)),
          y: Number((top / mapHeight).toFixed(6)),
          width: Number((width / mapWidth).toFixed(6)),
          height: Number((height / mapHeight).toFixed(6))
        };
      }

      for (const card of document.querySelectorAll('.map-card')) {
        const svg = card.querySelector('.map-svg');
        const draft = card.querySelector('.map-draft-zone');
        let pointerStart = null;

        loadZones(card);

        svg.addEventListener('pointerdown', (event) => {
          if (event.target.closest && event.target.closest('.map-zone-group')) {
            return;
          }
          if (!isEditMode()) {
            return;
          }
          event.preventDefault();
          pointerStart = svgPoint(svg, event);
          draft.hidden = false;
          setSvgRectAttributes(draft, { x: pointerStart.x, y: pointerStart.y, width: 0, height: 0 });
          svg.setPointerCapture(event.pointerId);
        });

        svg.addEventListener('pointermove', (event) => {
          if (!pointerStart) {
            return;
          }
          const geometry = normalizedRect(svg, pointerStart, svgPoint(svg, event));
          setSvgRectAttributes(draft, pixelBoxFromGeometry(mapConfigs.get(card.dataset.mapId), geometry));
        });

        svg.addEventListener('pointerup', async (event) => {
          if (!pointerStart) {
            return;
          }
          const currentPoint = svgPoint(svg, event);
          const geometry = normalizedRect(svg, pointerStart, currentPoint);
          pointerStart = null;
          draft.hidden = true;

          if (geometry.width < 0.001 || geometry.height < 0.001) {
            const x = (currentPoint.x / Number(svg.dataset.mapWidth || 1)).toFixed(4);
            const y = (currentPoint.y / Number(svg.dataset.mapHeight || 1)).toFixed(4);
            setOutput('Карта ' + card.dataset.mapId.toUpperCase() + ': x=' + x + ', y=' + y + '. Для зоны протяните прямоугольник хотя бы на пару пикселей.');
            return;
          }

          await saveZone(card, geometry);
        });
      }

      zonesList.addEventListener('change', async (event) => {
        if (!event.target.classList.contains('map-zone-type-select')) {
          return;
        }
        if (!isEditMode()) {
          event.preventDefault();
          syncEditMode();
          return;
        }

        await updateZoneType(event.target.dataset.zoneId, event.target.value, event.target.dataset.mapId);
      });

      zonesList.addEventListener('click', async (event) => {
        const button = event.target.closest('.map-zone-delete');
        if (!button) {
          return;
        }
        if (!isEditMode()) {
          setOutput('Включите "Редактирование мест", чтобы удалять зоны с карты.');
          return;
        }

        if (!window.confirm('Удалить это место с карты?')) {
          return;
        }

        await deleteZone(button.dataset.zoneId, button.dataset.mapId);
      });

      editModeToggle.addEventListener('change', syncEditMode);
      syncEditMode();
    </script>
  `;
}

function getPlaceOperationalState(model, placeId) {
  if (!placeId) {
    return null;
  }

  const place = (model.places?.data?.places || []).find((item) => item.id === placeId);
  if (!place) {
    return null;
  }

  const dashboard = model.dashboard?.data || {};
  const release = (dashboard.releasedPlaces || []).find((item) => item.parkingPlace.id === placeId) || null;
  const reservation = (dashboard.reservations || []).find((item) => item.parkingPlace.id === placeId) || null;
  const guestRequest = (dashboard.guestRequests || []).find((request) => request.assignedReservation?.parkingPlace?.id === placeId) || null;
  const lineOccupancy = (model.lineOccupancy?.data?.occupancy || []).find((item) => item.parkingPlace.id === placeId) || null;
  const status = reservation
    ? reservation.source === 'guest'
      ? 'guest'
      : 'occupied'
    : release
      ? 'released'
      : place.isActive
        ? 'free'
        : 'blocked';

  return {
    place,
    release,
    reservation,
    guestRequest,
    lineOccupancy,
    status
  };
}

function renderOperationalPlaceCard(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const selected = getPlaceOperationalState(model, model.selectedPlaceId);
  const employees = model.employees?.data?.employees || [];
  const selectedMapCode = model.selectedMapCode || parkingMaps[0]?.id || 'g4';

  if (!selected) {
    return `
      <aside class="place-drawer card">
        <h3>Место не выбрано</h3>
        <p class="empty">Нажмите на размеченное место на карте, чтобы открыть операционную карточку.</p>
      </aside>
    `;
  }

  const { place, release, reservation, guestRequest, lineOccupancy, status } = selected;
  const employeeOptions = employees
    .map((employee) => {
      const department = employee.department ? ` · ${employee.department}` : '';
      const permanent = employee.permanentPlace ? ` · место ${employee.permanentPlace.code}` : ' · без места';
      return `<option value="${escapeHtml(employee.id)}">${escapeHtml(`${employee.displayName}${department}${permanent}`)}</option>`;
    })
    .join('');
  const hostOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.displayName)}</option>`)
    .join('');
  const owner = place.permanentOwner;
  const canRelease = Boolean(owner);
  const canManualAssign = Boolean(release && !reservation);

  return `
    <aside class="place-drawer card">
      <div class="history-head">
        <div>
          <h3>${escapeHtml(place.code)} · ${escapeHtml(place.title)}</h3>
          <p class="section-copy">${escapeHtml(place.floorLabel || 'без этажа')} · ${escapeHtml(place.placeType)} · ${place.lineGroup ? escapeHtml(`линия ${place.lineGroup.code}`) : 'без линии'}</p>
        </div>
        <span class="tag map-zone-status-${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>

      <div class="mini-grid">
        <article>
          <p class="label">Владелец</p>
          <p>${owner ? escapeHtml(owner.displayName) : '—'}</p>
        </article>
        <article>
          <p class="label">Назначение</p>
          <p>${reservation ? escapeHtml(`${reservation.source} · ${reservation.user?.displayName || guestRequest?.guestName || 'гость'}`) : '—'}</p>
        </article>
        <article>
          <p class="label">Отдача</p>
          <p>${release ? escapeHtml(`${release.owner.displayName}${release.releaseNotes ? ` · ${release.releaseNotes}` : ''}`) : '—'}</p>
        </article>
        <article>
          <p class="label">Позиция</p>
          <p>${lineOccupancy ? escapeHtml(`${lineOccupancy.lineGroup.code} · позиция ${lineOccupancy.position}`) : '—'}</p>
        </article>
      </div>

      <h4>Операции по месту</h4>
      ${
        canRelease
          ? `<form class="action-form compact-form" method="post" action="/admin/place-releases">
              <input type="hidden" name="parkingPlaceId" value="${escapeHtml(place.id)}" />
              <input type="hidden" name="dateFrom" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="dateTo" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
              <label class="wide">
                <span>Отдать место на день</span>
                <input name="notes" placeholder="Комментарий" />
              </label>
              <button type="submit">Отдать на ${escapeHtml(selectedDate)}</button>
            </form>`
          : '<p class="empty">У места нет постоянного владельца, отдача недоступна.</p>'
      }

      ${
        canManualAssign
          ? `<form class="action-form compact-form" method="post" action="/admin/reservations/manual">
              <input type="hidden" name="reservationDate" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="parkingPlaceId" value="${escapeHtml(place.id)}" />
              <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
              <label>
                <span>Назначить сотрудника</span>
                <select name="userId" required>
                  <option value="">Кому назначить</option>
                  ${employeeOptions}
                </select>
              </label>
              <label>
                <span>Причина</span>
                <input name="reason" placeholder="Ручное назначение с карты" />
              </label>
              <button type="submit">Назначить</button>
            </form>`
          : '<p class="empty">Ручное назначение доступно только для отданного и свободного места.</p>'
      }

      ${
        reservation
          ? `<form class="inline-action-form" method="post" action="/admin/reservations/cancel">
              <input type="hidden" name="reservationId" value="${escapeHtml(reservation.id)}" />
              <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
              <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
              <button class="button-secondary" type="submit">Отменить назначение</button>
              <span>${escapeHtml(reservation.source)}</span>
            </form>`
          : ''
      }

      <details>
        <summary>Создать гостевую заявку</summary>
        <p class="empty">Место для гостя выбирается backend по приоритету single → double → triple и резерву.</p>
        <form class="action-form compact-form" method="post" action="/admin/guest-parking-requests">
          <input type="hidden" name="requestDate" value="${escapeHtml(selectedDate)}" />
          <input type="hidden" name="returnView" value="day" />
          <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
          <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
          <label>
            <span>Приглашающий</span>
            <select name="hostUserId" required>
              <option value="">Выберите сотрудника</option>
              ${hostOptions}
            </select>
          </label>
          <label>
            <span>Гость</span>
            <input name="guestName" required />
          </label>
          <label>
            <span>Телефон</span>
            <input name="guestPhone" />
          </label>
          <label>
            <span>Авто</span>
            <input name="vehiclePlateNumber" />
          </label>
          <button type="submit">Создать гостя</button>
        </form>
      </details>

      <p>
        <a href="/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeId=${encodeURIComponent(place.id)}">Открыть историю места</a>
      </p>
    </aside>
  `;
}

async function buildOperationalPlaceCardModel({ selectedDate, selectedPlaceId, selectedMapCode }) {
  const [places, employees, dashboard, lineOccupancy] = await Promise.all([
    fetchJson('/admin/places'),
    fetchJson(`/admin/employees?date=${encodeURIComponent(selectedDate)}`),
    fetchJson(`/admin/dashboard?date=${encodeURIComponent(selectedDate)}`),
    fetchJson(`/admin/line-occupancy?date=${encodeURIComponent(selectedDate)}`)
  ]);

  return {
    places,
    employees,
    dashboard,
    lineOccupancy,
    selectedDate,
    selectedPlaceId,
    selectedMapCode
  };
}

function renderOperationalMap(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const selectedMapCode = model.selectedMapCode || parkingMaps[0]?.id || 'g4';
  const selectedStatusFilter = model.mapStatusFilter || '';
  const selectedTypeFilter = model.mapTypeFilter || '';
  const activeMaps = configuredMaps(model);
  const mapOptions = activeMaps
    .map((map) => `<option value="${escapeHtml(map.id)}"${selectedMapCode === map.id ? ' selected' : ''}>${escapeHtml(map.title)}</option>`)
    .join('');
  const statusOptions = [
    ['', 'Все статусы'],
    ['free', 'free'],
    ['released', 'released'],
    ['occupied', 'occupied'],
    ['guest', 'guest'],
    ['rotatable', 'rotatable'],
    ['blocked', 'blocked']
  ]
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${selectedStatusFilter === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  const typeOptions = [
    ['', 'Все типы'],
    ['single', 'single'],
    ['double', 'double'],
    ['triple', 'triple']
  ]
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${selectedTypeFilter === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');
  const cards = activeMaps
    .map(
      (map) => `
        <article class="map-card operational-map-card${selectedMapCode === map.id ? ' active' : ''}" data-map-id="${escapeHtml(map.id)}" data-map-title="${escapeHtml(map.title)}">
          <div class="map-card-head">
            <div>
              <h3>${escapeHtml(map.title)}</h3>
              <p>${escapeHtml(map.description)}</p>
            </div>
            <span class="tag">операционный слой</span>
          </div>
          <div class="map-workspace">
            <svg
              class="map-svg operational-map-svg"
              data-map-id="${escapeHtml(map.id)}"
              data-map-width="${escapeHtml(map.width)}"
              data-map-height="${escapeHtml(map.height)}"
              viewBox="0 0 ${escapeHtml(map.width)} ${escapeHtml(map.height)}"
              preserveAspectRatio="xMidYMid meet"
              role="img"
              aria-label="Операционная карта парковки ${escapeHtml(map.title)}"
            >
              <image href="/maps/${escapeHtml(map.filename)}" x="0" y="0" width="${escapeHtml(map.width)}" height="${escapeHtml(map.height)}" preserveAspectRatio="none"></image>
              <g class="map-zones-layer" aria-label="Места ${escapeHtml(map.title)}"></g>
            </svg>
          </div>
        </article>
      `
    )
    .join('');

  return `
    <section class="card">
      <div class="map-card-head">
        <div>
          <h2 class="section-title">Карта дня</h2>
          <p class="section-copy">Операционный режим: просмотр статусов и действия по выбранному месту. Разметка и изменение зон здесь отключены.</p>
        </div>
        <form class="map-floor-form" method="get" action="/">
          <input type="hidden" name="view" value="day" />
          <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
          ${model.selectedPlaceId ? `<input type="hidden" name="placeId" value="${escapeHtml(model.selectedPlaceId)}" />` : ''}
          <label>
            <span>Этаж</span>
            <select name="mapCode" onchange="this.form.submit()">
              ${mapOptions}
            </select>
          </label>
          <label>
            <span>Статус</span>
            <select name="status" onchange="this.form.submit()">
              ${statusOptions}
            </select>
          </label>
          <label>
            <span>Тип</span>
            <select name="type" onchange="this.form.submit()">
              ${typeOptions}
            </select>
          </label>
        </form>
      </div>
      <div class="map-legend">
        <span class="tag map-zone-status-free">free</span>
        <span class="tag map-zone-status-released">released</span>
        <span class="tag map-zone-status-occupied">occupied</span>
        <span class="tag map-zone-status-guest">guest</span>
        <span class="tag map-zone-status-rotatable">rotatable</span>
        <span class="tag map-zone-status-blocked">blocked</span>
      </div>
      <div class="operational-layout">
        <div class="maps-grid operational-maps-grid">${cards}</div>
        ${renderOperationalPlaceCard(model)}
      </div>
    </section>
    <script>
      (() => {
        const selectedDate = ${JSON.stringify(selectedDate)};
        const selectedMapCode = ${JSON.stringify(selectedMapCode)};
        let currentSelectedPlaceId = ${JSON.stringify(model.selectedPlaceId || '')};
        const selectedStatusFilter = ${JSON.stringify(selectedStatusFilter)};
        const selectedTypeFilter = ${JSON.stringify(selectedTypeFilter)};
        const releasedPlaceIds = new Set(${JSON.stringify((model.dashboard?.data?.releasedPlaces || []).map((item) => item.parkingPlace.id))});
        const maps = ${JSON.stringify(activeMaps.map(({ metadata, ...map }) => map))};
        const mapConfigs = new Map(maps.map((map) => [map.id, map]));
        const SVG_NS = 'http://www.w3.org/2000/svg';

        function pixelBoxFromGeometry(mapConfig, geometry) {
          const mapWidth = Number(mapConfig?.width || 1);
          const mapHeight = Number(mapConfig?.height || 1);
          return {
            x: Number(((geometry.x || 0) * mapWidth).toFixed(2)),
            y: Number(((geometry.y || 0) * mapHeight).toFixed(2)),
            width: Number(((geometry.width || 0) * mapWidth).toFixed(2)),
            height: Number(((geometry.height || 0) * mapHeight).toFixed(2))
          };
        }

        function setSvgRectAttributes(rect, box) {
          rect.setAttribute('x', box.x);
          rect.setAttribute('y', box.y);
          rect.setAttribute('width', box.width);
          rect.setAttribute('height', box.height);
        }

        function effectiveStatus(zone) {
          if (zone.reservation?.source === 'guest') {
            return 'guest';
          }
          if (!zone.reservation && zone.parkingPlace?.id && releasedPlaceIds.has(zone.parkingPlace.id) && zone.status === 'free') {
            return 'released';
          }
          return zone.status || 'free';
        }

        function renderZone(layer, zone, mapConfig) {
          const geometry = zone.geometry || {};
          const box = pixelBoxFromGeometry(mapConfig, geometry);
          const status = effectiveStatus(zone);
          const placeType = zone.parkingPlace?.placeType || '';
          if (selectedStatusFilter && status !== selectedStatusFilter) {
            return;
          }
          if (selectedTypeFilter && placeType !== selectedTypeFilter) {
            return;
          }
          const group = document.createElementNS(SVG_NS, 'g');
          group.classList.add('map-zone-group', 'operational-zone-group');
          group.dataset.placeId = zone.parkingPlace?.id || '';

          const rect = document.createElementNS(SVG_NS, 'rect');
          rect.classList.add('map-zone-rect', 'map-zone-' + status);
          if (zone.parkingPlace?.id === currentSelectedPlaceId) {
            rect.classList.add('map-zone-selected');
          }
          setSvgRectAttributes(rect, box);

          const title = document.createElementNS(SVG_NS, 'title');
          title.textContent = [zone.parkingPlace?.code, status, zone.reservation?.userDisplayName].filter(Boolean).join(' · ');
          group.appendChild(title);
          group.appendChild(rect);

          const label = zone.parkingPlace?.code || zone.zoneKey || '?';
          if (box.width >= 36 && box.height >= 18) {
            const text = document.createElementNS(SVG_NS, 'text');
            text.classList.add('map-zone-label');
            text.setAttribute('x', box.x + box.width / 2);
            text.setAttribute('y', box.y + box.height / 2);
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'middle');
            text.textContent = label;
            group.appendChild(text);
          }

          group.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!zone.parkingPlace?.id) {
              return;
            }
            loadOperationalPlaceCard(zone.parkingPlace.id, true);
          });
          layer.appendChild(group);
        }

        function dayUrl(placeId) {
          const params = new URLSearchParams({
            view: 'day',
            date: selectedDate,
            mapCode: selectedMapCode
          });

          if (placeId) {
            params.set('placeId', placeId);
          }
          if (selectedStatusFilter) {
            params.set('status', selectedStatusFilter);
          }
          if (selectedTypeFilter) {
            params.set('type', selectedTypeFilter);
          }

          return '/?' + params.toString();
        }

        function setSelectedZone(placeId) {
          currentSelectedPlaceId = placeId || '';
          for (const rect of document.querySelectorAll('.operational-zone-group .map-zone-rect')) {
            const group = rect.closest('.operational-zone-group');
            rect.classList.toggle('map-zone-selected', Boolean(group && group.dataset.placeId === currentSelectedPlaceId));
          }
        }

        function replacePlaceCard(html) {
          const currentCard = document.querySelector('.place-drawer');
          if (currentCard) {
            currentCard.outerHTML = html;
          }
        }

        async function loadOperationalPlaceCard(placeId, shouldPushState) {
          setSelectedZone(placeId);
          const params = new URLSearchParams({
            date: selectedDate,
            mapCode: selectedMapCode
          });

          if (placeId) {
            params.set('placeId', placeId);
          }

          const response = await fetch('/admin/operational-place-card?' + params.toString(), {
            headers: { accept: 'application/json' }
          });
          const data = await response.json();

          if (!response.ok) {
            replacePlaceCard('<aside class="place-drawer card"><h3>Место не выбрано</h3><p class="empty">Не удалось загрузить карточку места.</p></aside>');
            return;
          }

          replacePlaceCard(data.html);
          if (shouldPushState) {
            window.history.pushState({ placeId: placeId || '' }, '', dayUrl(placeId));
          }
        }

        async function loadZones(card) {
          const mapId = card.dataset.mapId;
          const layer = card.querySelector('.map-zones-layer');
          const mapConfig = mapConfigs.get(mapId);
          layer.innerHTML = '';

          const response = await fetch('/admin/map-zones?mapCode=' + encodeURIComponent(mapId) + '&date=' + encodeURIComponent(selectedDate));
          const data = await response.json();
          if (!response.ok) {
            return;
          }

          for (const zone of data.zones || []) {
            renderZone(layer, zone, mapConfig);
          }
        }

        for (const card of document.querySelectorAll('.operational-map-card')) {
          card.hidden = card.dataset.mapId !== selectedMapCode;
          loadZones(card);
        }

        window.addEventListener('popstate', () => {
          const params = new URLSearchParams(window.location.search);
          const placeId = params.get('placeId') || '';
          loadOperationalPlaceCard(placeId, false);
        });
      })();
    </script>
  `;
}

function renderDateSelector(selectedDate, view = 'day', extraHidden = '') {
  return `
    <form class="date-form" method="get" action="/">
      <input type="hidden" name="view" value="${escapeHtml(view)}" />
      ${extraHidden}
      <label>
        <span>Операционный день</span>
        <input type="date" name="date" value="${escapeHtml(selectedDate)}" required />
      </label>
      <button type="submit">Показать день</button>
    </form>
  `;
}

function renderLineOccupancyPanel(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const places = (model.places?.data?.places || []).filter((place) => place.lineGroup);
  const employees = model.employees?.data?.employees || [];
  const lineGroups = model.lineGroups?.data?.lineGroups || [];

  const lineGroupOptions = lineGroups
    .map((lineGroup) => `<option value="${escapeHtml(lineGroup.id)}">${escapeHtml(`${lineGroup.code} · ${lineGroup.name}`)}</option>`)
    .join('');
  const placeOptions = places
    .map((place) => `<option value="${escapeHtml(place.id)}">${escapeHtml(`${place.code} · ${place.title} · ${place.lineGroup.code}`)}</option>`)
    .join('');
  const employeeOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.displayName)}</option>`)
    .join('');
  const lineRows = lineGroups
    .map(
      (lineGroup) => `
        <tr>
          <td>${escapeHtml(lineGroup.code)}</td>
          <td>${escapeHtml(lineGroup.name)}</td>
          <td>${escapeHtml(lineGroup.capacity)}</td>
          <td>${lineGroup.floorLabel ? escapeHtml(lineGroup.floorLabel) : '—'}</td>
          <td>${(lineGroup.places || []).map((place) => escapeHtml(`${place.code} (${place.positionHint || '—'})`)).join(', ') || '—'}</td>
        </tr>
      `
    )
    .join('');

  if (!lineGroups.length) {
    return '<p class="empty">Линии пока не настроены. Примените миграцию line groups после импорта каталога.</p>';
  }

  return `
    <form class="action-form" method="post" action="/admin/line-occupancy">
      <input type="hidden" name="occupancyDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Линия</span>
        <select name="lineGroupId" required>
          <option value="">Выберите линию</option>
          ${lineGroupOptions}
        </select>
      </label>
      <label>
        <span>Место</span>
        <select name="parkingPlaceId" required>
          <option value="">Выберите место линии</option>
          ${placeOptions}
        </select>
      </label>
      <label>
        <span>Позиция</span>
        <select name="position" required>
          <option value="1">1 · первый</option>
          <option value="2">2 · второй</option>
          <option value="3">3 · третий</option>
        </select>
      </label>
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Кто фактически стоит</option>
          ${employeeOptions}
        </select>
      </label>
      <button type="submit">Зафиксировать позицию</button>
    </form>
    <table>
      <thead>
        <tr>
          <th>Линия</th>
          <th>Название</th>
          <th>Мест</th>
          <th>Этаж</th>
          <th>Места</th>
        </tr>
      </thead>
      <tbody>${lineRows}</tbody>
    </table>
  `;
}

function renderLineOccupancyTable(model) {
  const occupancy = model.lineOccupancy?.data?.occupancy || [];

  if (!occupancy.length) {
    return '<p class="empty">На выбранную дату позиции в линиях еще не зафиксированы.</p>';
  }

  const rows = occupancy
    .map((item) => {
      const subject =
        item.subjectType === 'guest'
          ? `Гость: ${item.guestParkingRequest?.guestName || '—'}`
          : `Сотрудник: ${item.user?.displayName || '—'}`;
      const contacts =
        item.subjectType === 'guest'
          ? `Администратор / приглашающий: ${item.guestParkingRequest?.hostDisplayName || '—'}`
          : [item.user?.phone, item.user?.email].filter(Boolean).join(' · ') || 'контакты не указаны';

      return `
        <tr>
          <td>${escapeHtml(item.lineGroup.code)}</td>
          <td>${escapeHtml(item.position)}</td>
          <td>${escapeHtml(item.parkingPlace.code)}</td>
          <td>${escapeHtml(subject)}</td>
          <td>${escapeHtml(item.subjectType)}</td>
          <td>${escapeHtml(contacts)}</td>
          <td>${item.reservation ? escapeHtml(item.reservation.source) : '—'}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Линия</th>
          <th>Позиция</th>
          <th>Место</th>
          <th>Кто стоит</th>
          <th>Тип</th>
          <th>Контакт/маршрут</th>
          <th>Источник</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderDepartureAndConflictsPanel(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];
  const departurePlans = model.departurePlans?.data?.departurePlans || [];
  const conflicts = model.conflicts?.data?.conflicts || [];
  const employeeOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.displayName)}</option>`)
    .join('');
  const planRows = departurePlans
    .map(
      (plan) => `
        <tr>
          <td>${escapeHtml(plan.user.displayName)}</td>
          <td>${plan.user.department ? escapeHtml(plan.user.department) : '—'}</td>
          <td>${escapeHtml(plan.departureTime)}</td>
          <td>${plan.isEarly ? '<span class="tag reserved">ранний</span>' : '<span class="tag free">обычный</span>'}</td>
          <td>${plan.lineOccupancy ? escapeHtml(`${plan.lineOccupancy.lineGroup.code} · позиция ${plan.lineOccupancy.position}`) : 'позиция не указана'}</td>
        </tr>
      `
    )
    .join('');
  const conflictRows = conflicts
    .map((conflict) => {
      const blocker = conflict.blocker.subjectType === 'guest'
        ? `Гость: ${conflict.blocker.guestParkingRequest?.guestName || '—'}`
        : `Сотрудник: ${conflict.blocker.user?.displayName || '—'}`;

      return `
        <tr>
          <td><span class="tag ${conflict.severity === 'warning' ? 'reserved' : ''}">${escapeHtml(conflict.severity)}</span></td>
          <td>${escapeHtml(conflict.lineGroup.code)}</td>
          <td>${escapeHtml(`${conflict.earlyDeparture.user.displayName} · ${conflict.earlyDeparture.departureTime} · позиция ${conflict.earlyDeparture.position}`)}</td>
          <td>${escapeHtml(`${blocker} · позиция ${conflict.blocker.position}`)}</td>
          <td>${conflict.blocker.subjectType === 'guest' ? 'Писать администратору парковки' : 'Контакт доступен через бот'}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/departure-plans">
      <input type="hidden" name="planDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Кто планирует выезд</option>
          ${employeeOptions}
        </select>
      </label>
      <label>
        <span>Время выезда</span>
        <input type="time" name="departureTime" required />
      </label>
      <button type="submit">Сохранить выезд</button>
    </form>

    <h4>Планы выезда</h4>
    ${
      planRows
        ? `<table>
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th>Дирекция</th>
                <th>Выезд</th>
                <th>Тип</th>
                <th>Линия</th>
              </tr>
            </thead>
            <tbody>${planRows}</tbody>
          </table>`
        : '<p class="empty">Планов выезда на выбранную дату пока нет.</p>'
    }

    <h4>Конфликты раннего выезда</h4>
    ${
      conflictRows
        ? `<table>
            <thead>
              <tr>
                <th>Уровень</th>
                <th>Линия</th>
                <th>Ранний выезд</th>
                <th>Кто впереди</th>
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>${conflictRows}</tbody>
          </table>`
        : '<p class="empty">Конфликтов раннего выезда на выбранную дату нет.</p>'
    }
  `;
}

function renderEmployeeCreateForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();

  return `
    <form class="action-form" method="post" action="/admin/employees">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>ФИО</span>
        <input type="text" name="displayName" placeholder="Иванов Иван" required />
      </label>
      <label>
        <span>Дирекция</span>
        <input type="text" name="department" placeholder="Например: ИТ" />
      </label>
      <label>
        <span>Email</span>
        <input type="email" name="email" placeholder="name@example.com" />
      </label>
      <label>
        <span>Телефон</span>
        <input type="text" name="phone" placeholder="+7..." />
      </label>
      <label class="wide">
        <span>Yandex Messenger ID</span>
        <input type="text" name="yandexMessengerUserId" placeholder="Заполним позже при интеграции" />
      </label>
      <button type="submit">Создать сотрудника</button>
    </form>
  `;
}

function renderEmployeeRequestForm(model) {
  const employees = model.employees?.data?.employees || [];
  const selectedDate = model.selectedDate || todayIsoDate();
  const employeesWithoutPlace = employees.filter((employee) => !employee.permanentPlace);
  const employeeOptions = employees
    .map((employee) => {
      const department = employee.department ? ` · ${employee.department}` : '';
      const permanent = employee.permanentPlace ? ` · место ${employee.permanentPlace.code}` : ' · без места';
      const disabled = employee.permanentPlace ? ' disabled' : '';
      return `<option value="${escapeHtml(employee.id)}"${disabled}>${escapeHtml(`${employee.displayName}${department}${permanent}`)}</option>`;
    })
    .join('');

  if (!employeesWithoutPlace.length) {
    return '<p class="empty">На выбранную дату все сотрудники в справочнике имеют постоянные места. Создайте сотрудника без места выше или смените дату.</p>';
  }

  return `
    <form class="action-form" method="post" action="/admin/employee-parking-requests">
      <input type="hidden" name="requestDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Кто просит место</option>
          ${employeeOptions}
        </select>
      </label>
      <label class="wide">
        <span>Комментарий</span>
        <input type="text" name="notes" placeholder="Например: заявка через администратора" />
      </label>
      <button type="submit">Поставить в очередь</button>
    </form>
  `;
}

function renderEmployeeRequestsTable(model) {
  const requests = model.employeeRequests?.data?.requests || [];

  if (!requests.length) {
    return '<p class="empty">На выбранную дату заявок сотрудников пока нет.</p>';
  }

  const rows = requests
    .map((request) => {
      const canCancel = ['active', 'queued'].includes(request.status);
      const queuePosition = request.queueEntry?.position ? `#${request.queueEntry.position}` : '—';
      const queueStatus = request.queueEntry?.status || '—';
      const assignedPlace = request.assignedReservation?.parkingPlaceCode || '—';
      const statusReason = request.assignedReservation
        ? `Назначено место ${assignedPlace}`
        : request.queueEntry
          ? `Очередь ${queueStatus}${request.queueEntry.processedAt ? ` · обработано ${formatDateTime(request.queueEntry.processedAt)}` : ''}`
          : request.status === 'canceled'
            ? 'Заявка отменена'
            : 'Ожидает обработки очереди';
      const cancelForm = canCancel
        ? `
          <form method="post" action="/admin/employee-parking-requests/cancel">
            <input type="hidden" name="requestId" value="${escapeHtml(request.id)}" />
            <input type="hidden" name="requestDate" value="${escapeHtml(formatDate(request.requestDate))}" />
            <button class="button-secondary" type="submit">Отменить</button>
          </form>
        `
        : '—';

      return `
        <tr>
          <td>${queuePosition}</td>
          <td>${escapeHtml(request.user.displayName)}</td>
          <td>${request.user.department ? escapeHtml(request.user.department) : '—'}</td>
          <td><span class="tag">${escapeHtml(request.status)}</span></td>
          <td>${escapeHtml(queueStatus)}</td>
          <td>${escapeHtml(assignedPlace)}</td>
          <td>${escapeHtml(statusReason)}</td>
          <td>${request.notes ? escapeHtml(request.notes) : '—'}</td>
          <td>${cancelForm}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Очередь</th>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Заявка</th>
          <th>Статус очереди</th>
          <th>Место</th>
          <th>Причина статуса</th>
          <th>Комментарий</th>
          <th>Действие</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderQueueTable(model) {
  const requests = model.employeeRequests?.data?.requests || [];
  const queueEntries = requests
    .filter((request) => request.queueEntry)
    .sort((left, right) => Number(left.queueEntry?.position || 0) - Number(right.queueEntry?.position || 0));

  if (!queueEntries.length) {
    return '<p class="empty">Очередь на выбранную дату пуста.</p>';
  }

  const rows = queueEntries
    .map((request) => {
      const queue = request.queueEntry;
      const assignedPlace = request.assignedReservation?.parkingPlaceCode;
      const reason = assignedPlace
        ? `Назначено место ${assignedPlace}`
        : queue.status === 'waiting'
          ? 'Ожидает запуска обработки'
          : queue.status === 'skipped'
            ? 'Пропущено: место не найдено или сработал гостевой резерв'
            : queue.status === 'canceled'
              ? 'Заявка отменена'
              : `Статус очереди: ${queue.status}`;

      return `
        <tr>
          <td>#${escapeHtml(queue.position)}</td>
          <td>${escapeHtml(request.user.displayName)}</td>
          <td>${request.user.department ? escapeHtml(request.user.department) : '—'}</td>
          <td><span class="tag">${escapeHtml(queue.status)}</span></td>
          <td>${assignedPlace ? escapeHtml(assignedPlace) : '—'}</td>
          <td>${escapeHtml(reason)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Позиция</th>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Статус</th>
          <th>Место</th>
          <th>Причина статуса</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderQueueProcessForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const requests = model.employeeRequests?.data?.requests || [];
  const waitingCount = requests.filter((request) => request.queueEntry?.status === 'waiting').length;

  return `
    <form class="inline-action-form" method="post" action="/admin/queue/process">
      <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
      <button type="submit" ${waitingCount ? '' : 'disabled'}>Обработать очередь</button>
      <span>${escapeHtml(waitingCount)} ожидает обработки</span>
    </form>
  `;
}

function renderGuestRequestForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];
  const options = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.displayName)}</option>`)
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/guest-parking-requests">
      <input type="hidden" name="requestDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Приглашающий</span>
        <select name="hostUserId" required>
          <option value="">Выберите сотрудника</option>
          ${options}
        </select>
      </label>
      <label>
        <span>Гость</span>
        <input type="text" name="guestName" placeholder="Фамилия Имя" required />
      </label>
      <label>
        <span>Телефон гостя</span>
        <input type="tel" name="guestPhone" placeholder="+7..." />
      </label>
      <label>
        <span>Номер авто</span>
        <input type="text" name="vehiclePlateNumber" placeholder="А000АА777" />
      </label>
      <label class="wide">
        <span>Комментарий</span>
        <input type="text" name="notes" placeholder="Например: встреча в 12:00" />
      </label>
      <button type="submit">Создать и назначить гостя</button>
    </form>
  `;
}

function renderGuestRequestsTable(model) {
  const requests = model.guestRequests?.data?.requests || [];

  if (!requests.length) {
    return '<p class="empty">Гостевых заявок на выбранную дату пока нет.</p>';
  }

  const rows = requests
    .map((request) => {
      const canCancel = request.status !== 'canceled';
      const canAssign = !request.assignedReservation && ['active', 'queued'].includes(request.status);
      const place = request.assignedReservation?.parkingPlace;
      const statusReason = place
        ? `Назначено место ${place.code}`
        : request.status === 'canceled'
          ? 'Гостевая заявка отменена'
          : request.status === 'active'
            ? 'Ожидает назначения места'
            : `Статус: ${request.status}`;

      return `
        <tr>
          <td>${escapeHtml(request.guestName)}</td>
          <td>${request.guestPhone ? escapeHtml(request.guestPhone) : '—'}</td>
          <td>${request.vehiclePlateNumber ? escapeHtml(request.vehiclePlateNumber) : '—'}</td>
          <td>${escapeHtml(request.host.displayName)}</td>
          <td><span class="tag ${request.status === 'canceled' ? 'reserved' : 'free'}">${escapeHtml(request.status)}</span></td>
          <td>${place ? escapeHtml(`${place.code} · ${place.placeType}`) : '—'}</td>
          <td>${escapeHtml(statusReason)}</td>
          <td>${request.notes ? escapeHtml(request.notes) : '—'}</td>
          <td>
            ${
              canAssign
                ? `<form method="post" action="/admin/guest-parking-requests/assign">
                    <input type="hidden" name="requestId" value="${escapeHtml(request.id)}" />
                    <input type="hidden" name="requestDate" value="${escapeHtml(formatDate(request.requestDate))}" />
                    <button type="submit">Назначить</button>
                  </form>`
                : ''
            }
            ${
              canCancel
                ? `<form method="post" action="/admin/guest-parking-requests/cancel">
                    <input type="hidden" name="requestId" value="${escapeHtml(request.id)}" />
                    <input type="hidden" name="requestDate" value="${escapeHtml(formatDate(request.requestDate))}" />
                    <button class="button-secondary" type="submit">Отменить</button>
                  </form>`
                : '—'
            }
          </td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Гость</th>
          <th>Телефон</th>
          <th>Авто</th>
          <th>Приглашающий</th>
          <th>Статус</th>
          <th>Место</th>
          <th>Причина статуса</th>
          <th>Комментарий</th>
          <th>Действие</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderJobsPanel(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const runs = model.jobRuns?.data?.runs || [];
  const latestSuccessfulRuns = model.jobRuns?.data?.latestSuccessfulRuns || [];
  const latestRows = latestSuccessfulRuns
    .map(
      (run) => `
        <tr>
          <td>${escapeHtml(run.jobName)}</td>
          <td>${run.targetDate ? escapeHtml(formatDate(run.targetDate)) : '—'}</td>
          <td>${run.finishedAt ? escapeHtml(new Date(run.finishedAt).toLocaleString('ru-RU')) : '—'}</td>
          <td>${renderJsonPreview(run.summary)}</td>
        </tr>
      `
    )
    .join('');
  const rows = runs
    .map(
      (run) => `
        <tr>
          <td>${escapeHtml(run.jobName)}</td>
          <td>${run.targetDate ? escapeHtml(formatDate(run.targetDate)) : '—'}</td>
          <td><span class="tag ${run.status === 'success' ? 'free' : run.status === 'failed' ? 'reserved' : ''}">${escapeHtml(run.status)}</span></td>
          <td>${run.startedAt ? escapeHtml(new Date(run.startedAt).toLocaleString('ru-RU')) : '—'}</td>
          <td>${run.finishedAt ? escapeHtml(new Date(run.finishedAt).toLocaleString('ru-RU')) : '—'}</td>
          <td>${run.error ? escapeHtml(run.error) : '—'}</td>
        </tr>
      `
    )
    .join('');

  return `
    <div class="jobs-actions">
      <form class="inline-action-form" method="post" action="/admin/jobs/process-queue">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job: начало дня</button>
        <span>Обработать очередь на выбранную дату</span>
      </form>
      <form class="inline-action-form" method="post" action="/admin/jobs/freeze-next-day">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job: 19:00</button>
        <span>Зафиксировать snapshot доступности на дату</span>
      </form>
      <form class="inline-action-form" method="post" action="/admin/jobs/lock-departure-plans">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job: 07:00</button>
        <span>Закрыть окно редактирования выездов на дату</span>
      </form>
    </div>
    <h4>Последний успешный запуск</h4>
    ${
      latestRows
        ? `<table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Дата</th>
                <th>Успешно завершен</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>${latestRows}</tbody>
          </table>`
        : '<p class="empty">Успешных запусков jobs пока нет.</p>'
    }
    <h4>Последние запуски</h4>
    ${
      rows
        ? `<table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Дата</th>
                <th>Статус</th>
                <th>Старт</th>
                <th>Финиш</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
        : '<p class="empty">Запусков jobs пока нет.</p>'
    }
  `;
}

function renderDayDashboard(model) {
  const dashboard = model.dashboard?.data || {};
  const releasedPlaces = dashboard.releasedPlaces || [];
  const reservations = dashboard.reservations || [];

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
              <td>
                <form method="post" action="/admin/reservations/cancel">
                  <input type="hidden" name="reservationId" value="${escapeHtml(reservation.id)}" />
                  <input type="hidden" name="date" value="${escapeHtml(formatDate(reservation.reservationDate))}" />
                  <button class="button-secondary" type="submit">Отменить</button>
                </form>
              </td>
            </tr>
          `
        )
        .join('')
    : '';

  return `
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
                <th>Действие</th>
              </tr>
            </thead>
            <tbody>${reservationRows}</tbody>
          </table>`
        : '<p class="empty">На выбранную дату назначений пока нет.</p>'
    }
  `;
}

function renderDayKpis(model) {
  const dashboard = model.dashboard?.data || {};
  const releasedPlaces = dashboard.releasedPlaces || [];
  const reservations = dashboard.reservations || [];
  const employeeRequests = model.employeeRequests?.data?.requests || [];
  const guestRequests = model.guestRequests?.data?.requests || dashboard.guestRequests || [];
  const guestReserve = dashboard.guestReserve || { minimum: 5, availablePlaces: 0, status: 'low' };
  const freeCount = releasedPlaces.filter((place) => !place.isReserved).length;

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
      <article>
        <p class="label">Заявок сотрудников</p>
        <p class="value">${escapeHtml(employeeRequests.length)}</p>
      </article>
      <article>
        <p class="label">Гостевых заявок</p>
        <p class="value">${escapeHtml(guestRequests.length)}</p>
      </article>
      <article>
        <p class="label">Гостевой резерв</p>
        <p class="value ${guestReserve.status === 'ok' ? 'status-ok' : 'status-error'}">${escapeHtml(`${guestReserve.availablePlaces}/${guestReserve.minimum}`)}</p>
      </article>
    </div>
  `;
}

function renderDayPage(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const daySelectorHidden = [
    `<input type="hidden" name="mapCode" value="${escapeHtml(model.selectedMapCode || parkingMaps[0]?.id || 'g4')}" />`,
    model.selectedPlaceId ? `<input type="hidden" name="placeId" value="${escapeHtml(model.selectedPlaceId)}" />` : '',
    model.mapStatusFilter ? `<input type="hidden" name="status" value="${escapeHtml(model.mapStatusFilter)}" />` : '',
    model.mapTypeFilter ? `<input type="hidden" name="type" value="${escapeHtml(model.mapTypeFilter)}" />` : ''
  ].join('');

  return `
    <section class="card">
      <h2 class="section-title">День</h2>
      <p class="section-copy">Выбранная дата: ${escapeHtml(selectedDate)}. Основная работа администратора: карта, статус мест и быстрые действия по выбранному месту.</p>
      ${renderDateSelector(selectedDate, 'day', daySelectorHidden)}
      ${renderDayKpis(model)}
    </section>
    ${renderOperationalMap(model)}
    <section class="card">
      <h2 class="section-title">Таблицы дня</h2>
      ${renderDayDashboard(model)}
    </section>
  `;
}

function renderRequestsTab(model) {
  const dashboard = model.dashboard?.data || {};
  const guestReserve = dashboard.guestReserve || { minimum: 5, availablePlaces: 0, status: 'low' };

  return `
    <section class="card">
      <h2 class="section-title">Заявки и очередь</h2>
      <p class="section-copy">Сотрудники без места, гостевые заявки и ручная обработка очереди на выбранную дату.</p>
      ${renderDateSelector(model.selectedDate || todayIsoDate(), 'requests')}
      <div class="mini-grid">
        <article>
          <p class="label">Заявок сотрудников</p>
          <p class="value">${escapeHtml((model.employeeRequests?.data?.requests || []).length)}</p>
        </article>
        <article>
          <p class="label">Гостевых заявок</p>
          <p class="value">${escapeHtml((model.guestRequests?.data?.requests || []).length)}</p>
        </article>
        <article>
          <p class="label">Гостевой резерв</p>
          <p class="value ${guestReserve.status === 'ok' ? 'status-ok' : 'status-error'}">${escapeHtml(`${guestReserve.availablePlaces}/${guestReserve.minimum}`)}</p>
        </article>
      </div>

      <h3>Создать сотрудника без места</h3>
      ${renderEmployeeCreateForm(model)}

      <h3>Заявки сотрудников</h3>
      ${renderQueueProcessForm(model)}
      ${renderEmployeeRequestForm(model)}
      ${renderEmployeeRequestsTable(model)}

      <h3>Очередь</h3>
      ${renderQueueTable(model)}

      <h3>Гостевые заявки</h3>
      ${renderGuestRequestForm(model)}
      ${renderGuestRequestsTable(model)}
    </section>
  `;
}

function renderAuditLogsTable(auditLogs) {
  if (!auditLogs.length) {
    return '<p class="empty">Записей журнала по выбранным фильтрам нет.</p>';
  }

  const rows = auditLogs
    .map((log) => {
      const actor = log.actorUser?.displayName || log.actorAuthUser?.login || log.actorService || 'system';

      return `
        <tr>
          <td>${escapeHtml(formatDateTime(log.occurredAt))}</td>
          <td>${escapeHtml(log.entityType)}</td>
          <td>${log.entityId ? escapeHtml(log.entityId) : '—'}</td>
          <td>${escapeHtml(log.action)}</td>
          <td>${escapeHtml(actor)}</td>
          <td>${renderJsonPreview(log.metadata)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Время</th>
          <th>Сущность</th>
          <th>ID</th>
          <th>Действие</th>
          <th>Актор</th>
          <th>Metadata</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderContactAccessLogsTable(logs) {
  if (!logs.length) {
    return '<p class="empty">Запросов контактов по выбранной дате нет.</p>';
  }

  const rows = logs
    .map((log) => {
      const target = log.targetUser
        ? `${log.targetUser.displayName} · ${log.targetUser.phone || 'телефон не указан'}`
        : log.targetGuestParkingRequest
          ? `Гость: ${log.targetGuestParkingRequest.guestName}; контакт через администратора`
          : '—';

      return `
        <tr>
          <td>${escapeHtml(formatDateTime(log.createdAt))}</td>
          <td>${escapeHtml(log.requester.displayName)}</td>
          <td>${log.lineGroup ? escapeHtml(log.lineGroup.code) : '—'}</td>
          <td>${escapeHtml(target)}</td>
          <td>${escapeHtml(log.resolution)}</td>
          <td>${renderJsonPreview(log.metadata)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Время</th>
          <th>Кто запросил</th>
          <th>Линия</th>
          <th>Цель</th>
          <th>Результат</th>
          <th>Metadata</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderAuditTab(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const auditLogs = model.auditLogs?.data?.auditLogs || [];
  const contactAccessLogs = model.contactAccessLogs?.data?.contactAccessLogs || [];

  return `
    <section class="card">
      <h2 class="section-title">Audit Log</h2>
      <p class="section-copy">Фильтр по дате, сущности и действию. Пустые поля не применяются.</p>
      <form class="action-form" method="get" action="/">
        <input type="hidden" name="view" value="audit" />
        <label>
          <span>Дата</span>
          <input type="date" name="date" value="${escapeHtml(selectedDate)}" required />
        </label>
        <label>
          <span>Сущность</span>
          <input name="entityType" value="${escapeHtml(model.auditFilters?.entityType || '')}" placeholder="reservation, user..." />
        </label>
        <label>
          <span>Действие</span>
          <input name="action" value="${escapeHtml(model.auditFilters?.action || '')}" placeholder="created, canceled..." />
        </label>
        <label>
          <span>Актор</span>
          <input name="actor" value="${escapeHtml(model.auditFilters?.actor || '')}" placeholder="admin-web, login, ФИО..." />
        </label>
        <button type="submit">Показать</button>
      </form>
      ${renderAuditLogsTable(auditLogs)}
    </section>

    <section class="card">
      <h2 class="section-title">Contact Access Logs</h2>
      <p class="section-copy">Все запросы контактов тех, кто стоит впереди в multi-линии.</p>
      ${renderContactAccessLogsTable(contactAccessLogs)}
    </section>

    <section class="card">
      <h2 class="section-title">Jobs и регламент</h2>
      <p class="section-copy">Ручной запуск ежедневных регламентных задач и последние результаты.</p>
      ${renderJobsPanel(model)}
    </section>
  `;
}

function renderPlaceHistoryCard(model) {
  const details = model.placeHistory?.data;

  if (!details?.place) {
    return '<p class="empty">Выберите место из таблицы ниже, чтобы посмотреть историю.</p>';
  }

  const history = details.history || {};
  const selectedDate = model.selectedDate || todayIsoDate();
  const assignmentRows = (history.permanentAssignments || [])
    .map(
      (assignment) => `
        <tr>
          <td>${escapeHtml(`${assignment.dateFrom} — ${assignment.dateTo || '∞'}`)}</td>
          <td>${escapeHtml(assignment.user.displayName)}</td>
          <td>${assignment.user.department ? escapeHtml(assignment.user.department) : '—'}</td>
          <td>${assignment.notes ? escapeHtml(assignment.notes) : '—'}</td>
          <td>
            <form method="post" action="/admin/permanent-assignments/end">
              <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="assignmentId" value="${escapeHtml(assignment.id)}" />
              <input type="date" name="dateTo" value="${escapeHtml(selectedDate)}" required />
              <button class="button-secondary" type="submit">Завершить</button>
            </form>
          </td>
        </tr>
      `
    )
    .join('');
  const releaseRows = (history.releases || [])
    .map(
      (release) => `
        <tr>
          <td>${escapeHtml(`${release.dateFrom} — ${release.dateTo}`)}</td>
          <td>${escapeHtml(release.user.displayName)}</td>
          <td><span class="tag ${release.status === 'active' ? 'free' : 'reserved'}">${escapeHtml(release.status)}</span></td>
          <td>${escapeHtml(formatDateTime(release.createdAt))}</td>
          <td>${release.canceledAt ? escapeHtml(formatDateTime(release.canceledAt)) : '—'}</td>
        </tr>
      `
    )
    .join('');
  const reservationRows = (history.reservations || [])
    .map(
      (reservation) => `
        <tr>
          <td>${escapeHtml(reservation.reservationDate)}</td>
          <td>${reservation.user ? escapeHtml(reservation.user.displayName) : escapeHtml(reservation.guestParkingRequest?.guestName || '—')}</td>
          <td>${escapeHtml(reservation.source)}</td>
          <td><span class="tag ${reservation.status === 'active' ? 'free' : 'reserved'}">${escapeHtml(reservation.status)}</span></td>
          <td>${reservation.reason ? escapeHtml(reservation.reason) : '—'}</td>
        </tr>
      `
    )
    .join('');
  const movementRows = (history.movements || [])
    .map(
      (movement) => `
        <tr>
          <td>${escapeHtml(movement.movementDate)}</td>
          <td>${escapeHtml(movement.userDisplayName || movement.guestName || '—')}</td>
          <td>${escapeHtml(movement.movementType)}</td>
          <td>${escapeHtml(`${movement.fromPlaceCode || '—'} → ${movement.toPlaceCode}`)}</td>
          <td>${escapeHtml(movement.reason)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <div class="history-head">
      <div>
        <h3>${escapeHtml(details.place.code)} · ${escapeHtml(details.place.title)}</h3>
        <p class="section-copy">${escapeHtml(details.place.floorLabel || 'без этажа')} · ${escapeHtml(details.place.placeType)} · ${details.place.isActive ? 'active' : 'inactive'}</p>
      </div>
      <a href="/?view=catalog&date=${encodeURIComponent(model.selectedDate || todayIsoDate())}">Сбросить выбор</a>
    </div>

    <h4>Постоянные закрепления</h4>
    ${
      assignmentRows
        ? `<table><thead><tr><th>Период</th><th>Сотрудник</th><th>Дирекция</th><th>Комментарий</th><th>Действие</th></tr></thead><tbody>${assignmentRows}</tbody></table>`
        : '<p class="empty">Закреплений по месту нет.</p>'
    }

    <h4>Отдачи места</h4>
    ${
      releaseRows
        ? `<table><thead><tr><th>Период</th><th>Владелец</th><th>Статус</th><th>Создано</th><th>Отменено</th></tr></thead><tbody>${releaseRows}</tbody></table>`
        : '<p class="empty">Отдач места нет.</p>'
    }

    <h4>Назначения</h4>
    ${
      reservationRows
        ? `<table><thead><tr><th>Дата</th><th>Кому</th><th>Источник</th><th>Статус</th><th>Причина</th></tr></thead><tbody>${reservationRows}</tbody></table>`
        : '<p class="empty">Назначений нет.</p>'
    }

    <h4>Перемещения</h4>
    ${
      movementRows
        ? `<table><thead><tr><th>Дата</th><th>Кто</th><th>Тип</th><th>Маршрут</th><th>Причина</th></tr></thead><tbody>${movementRows}</tbody></table>`
        : '<p class="empty">Перемещений нет.</p>'
    }

    <h4>Audit по месту</h4>
    ${renderAuditLogsTable(history.auditLogs || [])}
  `;
}

function renderEmployeeHistoryCard(model) {
  const details = model.employeeHistory?.data;

  if (!details?.employee) {
    return '<p class="empty">Выберите сотрудника из таблицы ниже, чтобы посмотреть историю.</p>';
  }

  const history = details.history || {};
  const selectedDate = model.selectedDate || todayIsoDate();
  const assignmentRows = (history.permanentAssignments || [])
    .map(
      (assignment) => `
        <tr>
          <td>${escapeHtml(`${assignment.dateFrom} — ${assignment.dateTo}`)}</td>
          <td>${escapeHtml(assignment.parkingPlace.code)}</td>
          <td>${assignment.notes ? escapeHtml(assignment.notes) : '—'}</td>
          <td>
            <form method="post" action="/admin/permanent-assignments/end">
              <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="assignmentId" value="${escapeHtml(assignment.id)}" />
              <input type="date" name="dateTo" value="${escapeHtml(selectedDate)}" required />
              <button class="button-secondary" type="submit">Завершить</button>
            </form>
          </td>
        </tr>
      `
    )
    .join('');
  const requestRows = (history.employeeRequests || [])
    .map(
      (request) => `
        <tr>
          <td>${escapeHtml(request.requestDate)}</td>
          <td><span class="tag">${escapeHtml(request.status)}</span></td>
          <td>${request.queueEntry ? escapeHtml(`#${request.queueEntry.position} · ${request.queueEntry.status}`) : '—'}</td>
          <td>${request.parkingPlaceCode ? escapeHtml(request.parkingPlaceCode) : '—'}</td>
        </tr>
      `
    )
    .join('');
  const reservationRows = (history.reservations || [])
    .map(
      (reservation) => `
        <tr>
          <td>${escapeHtml(reservation.reservationDate)}</td>
          <td>${escapeHtml(reservation.parkingPlace.code)}</td>
          <td>${escapeHtml(reservation.source)}</td>
          <td><span class="tag">${escapeHtml(reservation.status)}</span></td>
          <td>${reservation.reason ? escapeHtml(reservation.reason) : '—'}</td>
        </tr>
      `
    )
    .join('');
  const lineRows = (history.lineOccupancy || [])
    .map(
      (occupancy) => `
        <tr>
          <td>${escapeHtml(occupancy.occupancyDate)}</td>
          <td>${escapeHtml(occupancy.lineGroupCode)}</td>
          <td>${escapeHtml(occupancy.parkingPlaceCode)}</td>
          <td>${escapeHtml(occupancy.position)}</td>
        </tr>
      `
    )
    .join('');
  const departureRows = (history.departurePlans || [])
    .map(
      (plan) => `
        <tr>
          <td>${escapeHtml(plan.planDate)}</td>
          <td>${escapeHtml(plan.departureTime)}</td>
          <td>${plan.isEarly ? '<span class="tag reserved">ранний</span>' : '<span class="tag free">обычный</span>'}</td>
        </tr>
      `
    )
    .join('');

  return `
    <div class="history-head">
      <div>
        <h3>${escapeHtml(details.employee.displayName)}</h3>
        <p class="section-copy">${escapeHtml(details.employee.department || 'без дирекции')} · ${escapeHtml(details.employee.email || 'email не указан')} · ${escapeHtml(details.employee.phone || 'телефон не указан')}</p>
      </div>
      <a href="/?view=catalog&date=${encodeURIComponent(model.selectedDate || todayIsoDate())}">Сбросить выбор</a>
    </div>

    <h4>Постоянные закрепления</h4>
    ${
      assignmentRows
        ? `<table><thead><tr><th>Период</th><th>Место</th><th>Комментарий</th><th>Действие</th></tr></thead><tbody>${assignmentRows}</tbody></table>`
        : '<p class="empty">Закреплений нет.</p>'
    }

    <h4>Заявки и очередь</h4>
    ${
      requestRows
        ? `<table><thead><tr><th>Дата</th><th>Статус</th><th>Очередь</th><th>Место</th></tr></thead><tbody>${requestRows}</tbody></table>`
        : '<p class="empty">Заявок нет.</p>'
    }

    <h4>Назначения</h4>
    ${
      reservationRows
        ? `<table><thead><tr><th>Дата</th><th>Место</th><th>Источник</th><th>Статус</th><th>Причина</th></tr></thead><tbody>${reservationRows}</tbody></table>`
        : '<p class="empty">Назначений нет.</p>'
    }

    <h4>Позиции в линиях</h4>
    ${
      lineRows
        ? `<table><thead><tr><th>Дата</th><th>Линия</th><th>Место</th><th>Позиция</th></tr></thead><tbody>${lineRows}</tbody></table>`
        : '<p class="empty">Позиции не фиксировались.</p>'
    }

    <h4>Планы выезда</h4>
    ${
      departureRows
        ? `<table><thead><tr><th>Дата</th><th>Время</th><th>Тип</th></tr></thead><tbody>${departureRows}</tbody></table>`
        : '<p class="empty">Планов выезда нет.</p>'
    }

    <h4>Запросы контактов</h4>
    ${renderContactAccessLogsTable(history.contactAccessLogs || [])}

    <h4>Audit по сотруднику</h4>
    ${renderAuditLogsTable(history.auditLogs || [])}
  `;
}

function renderPlaceCreateForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const lineGroups = model.lineGroups?.data?.lineGroups || [];
  const lineGroupOptions = lineGroups
    .map((group) => `<option value="${escapeHtml(group.id)}">${escapeHtml(`${group.code} · ${group.name}`)}</option>`)
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/places">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Код</span>
        <input name="code" placeholder="4019" required />
      </label>
      <label>
        <span>Название</span>
        <input name="title" placeholder="4019(заднее)" required />
      </label>
      <label>
        <span>Тип</span>
        <select name="placeType" required>
          <option value="single">single</option>
          <option value="double">double</option>
          <option value="triple">triple</option>
        </select>
      </label>
      <label>
        <span>Этаж</span>
        <input name="floorLabel" placeholder="4" />
      </label>
      <label>
        <span>Линия</span>
        <select name="lineGroupId">
          <option value="">Без линии</option>
          ${lineGroupOptions}
        </select>
      </label>
      <label>
        <span>Позиция в линии</span>
        <select name="linePositionHint">
          <option value="">—</option>
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="3">3</option>
        </select>
      </label>
      <label>
        <span>Guest priority</span>
        <input type="number" min="1" max="99" name="guestPriorityRank" placeholder="1" />
      </label>
      <button type="submit">Создать место</button>
    </form>
  `;
}

function renderPlaceEditForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const place = model.placeHistory?.data?.place;

  if (!place) {
    return '<p class="empty">Выберите место из таблицы, чтобы редактировать карточку.</p>';
  }

  const fullPlace = (model.places?.data?.places || []).find((item) => item.id === place.id) || place;
  const lineGroups = model.lineGroups?.data?.lineGroups || [];
  const lineGroupOptions = lineGroups
    .map((group) => {
      const selected = fullPlace.lineGroup?.id === group.id ? ' selected' : '';
      return `<option value="${escapeHtml(group.id)}"${selected}>${escapeHtml(`${group.code} · ${group.name}`)}</option>`;
    })
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/places/update">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
      <label>
        <span>Код</span>
        <input name="code" value="${escapeHtml(fullPlace.code)}" required />
      </label>
      <label>
        <span>Название</span>
        <input name="title" value="${escapeHtml(fullPlace.title)}" required />
      </label>
      <label>
        <span>Тип</span>
        <select name="placeType" required>
          ${['single', 'double', 'triple'].map((type) => `<option value="${type}"${fullPlace.placeType === type ? ' selected' : ''}>${type}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Этаж</span>
        <input name="floorLabel" value="${escapeHtml(fullPlace.floorLabel || '')}" />
      </label>
      <label>
        <span>Линия</span>
        <select name="lineGroupId">
          <option value="">Без линии</option>
          ${lineGroupOptions}
        </select>
      </label>
      <label>
        <span>Позиция в линии</span>
        <select name="linePositionHint">
          <option value="">—</option>
          ${[1, 2, 3].map((position) => `<option value="${position}"${Number(fullPlace.linePositionHint) === position ? ' selected' : ''}>${position}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Guest priority</span>
        <input type="number" min="1" max="99" name="guestPriorityRank" value="${escapeHtml(fullPlace.guestPriorityRank || '')}" />
      </label>
      <label>
        <span>Активно</span>
        <select name="isActive">
          <option value="true"${fullPlace.isActive ? ' selected' : ''}>Да</option>
          <option value="false"${!fullPlace.isActive ? ' selected' : ''}>Нет</option>
        </select>
      </label>
      <button type="submit">Сохранить место</button>
    </form>
    <form class="inline-action-form" method="post" action="/admin/places/disable">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
      <button class="button-secondary" type="submit">Отключить место</button>
      <span>Мягко скрывает место из каталога.</span>
    </form>
  `;
}

function renderEmployeeEditForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employee = model.employeeHistory?.data?.employee;

  if (!employee) {
    return '<p class="empty">Выберите сотрудника из таблицы, чтобы редактировать карточку.</p>';
  }

  return `
    <form class="action-form" method="post" action="/admin/employees/update">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}" />
      <label>
        <span>ФИО</span>
        <input name="displayName" value="${escapeHtml(employee.displayName)}" required />
      </label>
      <label>
        <span>Дирекция</span>
        <input name="department" value="${escapeHtml(employee.department || '')}" />
      </label>
      <label>
        <span>Email</span>
        <input type="email" name="email" value="${escapeHtml(employee.email || '')}" />
      </label>
      <label>
        <span>Телефон</span>
        <input name="phone" value="${escapeHtml(employee.phone || '')}" />
      </label>
      <label class="wide">
        <span>Yandex Messenger ID</span>
        <input name="yandexMessengerUserId" value="${escapeHtml(employee.yandexMessengerUserId || '')}" />
      </label>
      <label>
        <span>Активен</span>
        <select name="isActive">
          <option value="true">Да</option>
          <option value="false">Нет</option>
        </select>
      </label>
      <button type="submit">Сохранить сотрудника</button>
    </form>
    <form class="inline-action-form" method="post" action="/admin/employees/disable">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}" />
      <button class="button-secondary" type="submit">Отключить сотрудника</button>
      <span>Мягко скрывает сотрудника из справочника.</span>
    </form>
  `;
}

function renderPermanentAssignmentForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];
  const places = model.places?.data?.places || [];
  const employeeOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(`${employee.displayName}${employee.department ? ` · ${employee.department}` : ''}`)}</option>`)
    .join('');
  const placeOptions = places
    .map((place) => `<option value="${escapeHtml(place.id)}">${escapeHtml(`${place.code} · ${place.title}`)}</option>`)
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/permanent-assignments">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Выберите сотрудника</option>
          ${employeeOptions}
        </select>
      </label>
      <label>
        <span>Место</span>
        <select name="parkingPlaceId" required>
          <option value="">Выберите место</option>
          ${placeOptions}
        </select>
      </label>
      <label>
        <span>С даты</span>
        <input type="date" name="dateFrom" value="${escapeHtml(selectedDate)}" required />
      </label>
      <label>
        <span>По дату</span>
        <input type="date" name="dateTo" />
      </label>
      <label class="wide">
        <span>Комментарий</span>
        <input name="notes" placeholder="Причина закрепления" />
      </label>
      <button type="submit">Создать закрепление</button>
    </form>
  `;
}

function renderPermanentAssignmentsTable(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const filterStatus = model.assignmentStatusFilter || 'all';
  const assignments = model.permanentAssignments?.data?.permanentAssignments || [];
  const statusOptions = [
    ['all', 'Все'],
    ['active', 'Активные'],
    ['future', 'Будущие'],
    ['ended', 'Завершенные']
  ]
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${filterStatus === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

  const filterForm = `
    <form class="date-form" method="get" action="/">
      <input type="hidden" name="view" value="catalog" />
      <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Статус закрепления</span>
        <select name="assignmentStatus" onchange="this.form.submit()">
          ${statusOptions}
        </select>
      </label>
      <button type="submit">Показать</button>
    </form>
  `;

  if (!assignments.length) {
    return `${filterForm}<p class="empty">Постоянных закреплений по выбранному фильтру нет.</p>`;
  }

  const rows = assignments
    .map((assignment) => {
      const canEnd = assignment.status !== 'ended';
      const endForm = canEnd
        ? `<form method="post" action="/admin/permanent-assignments/end">
            <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
            <input type="hidden" name="assignmentStatus" value="${escapeHtml(filterStatus)}" />
            <input type="hidden" name="assignmentId" value="${escapeHtml(assignment.id)}" />
            <input type="date" name="dateTo" value="${escapeHtml(selectedDate)}" required />
            <button class="button-secondary" type="submit">Завершить</button>
          </form>`
        : '—';

      return `
        <tr>
          <td><span class="tag ${assignment.status === 'active' ? 'free' : assignment.status === 'ended' ? 'reserved' : ''}">${escapeHtml(assignment.status)}</span></td>
          <td>${escapeHtml(assignment.parkingPlace.code)}</td>
          <td>${escapeHtml(assignment.parkingPlace.title)}</td>
          <td>${escapeHtml(assignment.user.displayName)}</td>
          <td>${assignment.user.department ? escapeHtml(assignment.user.department) : '—'}</td>
          <td>${escapeHtml(`${assignment.dateFrom} — ${assignment.dateTo || '∞'}`)}</td>
          <td>${assignment.notes ? escapeHtml(assignment.notes) : '—'}</td>
          <td>${endForm}</td>
        </tr>
      `;
    })
    .join('');

  return `
    ${filterForm}
    <table>
      <thead>
        <tr>
          <th>Статус</th>
          <th>Место</th>
          <th>Название</th>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Период</th>
          <th>Комментарий</th>
          <th>Действие</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderCatalogTab(model) {
  const places = model.places?.data?.places || [];

  return `
    <section class="card">
      <h2 class="section-title">Создать место</h2>
      ${renderPlaceCreateForm(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Постоянное закрепление</h2>
      ${renderPermanentAssignmentForm(model)}
      <h3>Текущие и будущие закрепления</h3>
      ${renderPermanentAssignmentsTable(model)}
    </section>

    <section class="card">
      <h2 class="section-title">История места</h2>
      ${renderPlaceHistoryCard(model)}
      <h3>Редактировать место</h3>
      ${renderPlaceEditForm(model)}
    </section>

    <section class="card">
      <h2 class="section-title">История сотрудника</h2>
      ${renderEmployeeHistoryCard(model)}
      <h3>Редактировать сотрудника</h3>
      ${renderEmployeeEditForm(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Сотрудники</h2>
      <p class="section-copy">Создание сотрудника остается в операционной вкладке; здесь справочник и переход в историю.</p>
      ${renderEmployeesTable(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Места и закрепления</h2>
      <p class="section-copy">Каталог мест, текущий владелец и переход в историю места.</p>
      ${renderPlacesTable(places, model.selectedDate)}
    </section>
  `;
}

function renderLinesTab(model) {
  return `
    <section class="card">
      <h2 class="section-title">Multi-линии и фактические позиции</h2>
      <p class="section-copy">Фиксация позиции и структура линий на выбранную дату.</p>
      ${renderLineOccupancyPanel(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Текущая занятость линий</h2>
      ${renderLineOccupancyTable(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Время выезда и конфликты</h2>
      ${renderDepartureAndConflictsPanel(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Запросы контактов</h2>
      ${renderContactAccessLogsTable(model.contactAccessLogs?.data?.contactAccessLogs || [])}
    </section>
  `;
}

const renderModules = createRenderModules({
  renderAuditTab,
  renderCatalogTab,
  renderDayPage,
  renderLinesTab,
  renderMapEditorTab,
  renderRequestsTab
});

function renderPage(model) {
  const placesCount = Array.isArray(model.places?.data?.places) ? model.places.data.places.length : 0;
  const selectedDate = model.selectedDate || todayIsoDate();
  const activeView = model.activeView || 'day';
  const bootstrap = model.bootstrap?.data?.bootstrapUser;
  const bootstrapState = bootstrap
    ? `${bootstrap.login} (${bootstrap.authStatus})`
    : 'не найден';
  const notice = model.notice
    ? `<p class="notice ${model.notice.type === 'error' ? 'notice-error' : 'notice-ok'}">${escapeHtml(model.notice.text)}</p>`
    : '';

  const mainContent = renderActiveTab(renderModules, activeView, model);

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

      .button-secondary {
        min-height: 34px;
        padding: 7px 10px;
        border-color: var(--line);
        color: var(--danger);
        background: #fff;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.48;
      }

      .inline-action-form {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin: 0 0 16px;
      }

      .inline-action-form button {
        width: auto;
      }

      .inline-action-form span {
        color: var(--muted);
      }

      option:disabled {
        color: var(--muted);
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

      .operational-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
        gap: 18px;
        align-items: start;
      }

      .operational-maps-grid {
        min-width: 0;
      }

      .place-drawer {
        position: sticky;
        top: 16px;
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

      .map-edit-toggle {
        display: inline-flex;
        width: auto;
        align-items: center;
        gap: 10px;
        margin: 0 0 16px;
        padding: 9px 12px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: #fff;
        cursor: pointer;
      }

      .map-edit-toggle input {
        width: 18px;
        min-height: 18px;
      }

      .map-edit-toggle span {
        color: var(--text);
        font-size: 15px;
      }

      .map-toolbar {
        display: grid;
        grid-template-columns: minmax(260px, 1fr) minmax(200px, 260px);
        gap: 14px;
        margin-bottom: 16px;
      }

      .map-toolbar label {
        display: grid;
        gap: 7px;
      }

      .map-toolbar span {
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .map-floor-form {
        display: grid;
        grid-template-columns: repeat(3, minmax(120px, 1fr));
        gap: 10px;
        min-width: min(100%, 440px);
      }

      .map-floor-form label {
        display: grid;
        gap: 7px;
      }

      .map-floor-form span {
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .map-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 14px;
      }

      .map-upload-panel,
      .map-diagnostic {
        margin: 0 0 16px;
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.4);
      }

      .map-upload-grid,
      .map-diagnostics {
        display: grid;
        gap: 12px;
      }

      .map-upload-grid {
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }

      .map-upload-form {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px dashed var(--line);
        border-radius: 8px;
        background: #fff;
      }

      .map-upload-form label {
        display: grid;
        gap: 6px;
      }

      .map-upload-form strong,
      .map-upload-form .muted {
        display: block;
      }

      .map-upload-form .muted {
        margin-top: 4px;
        overflow-wrap: anywhere;
      }

      .map-workspace {
        width: 100%;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
      }

      .map-svg {
        display: block;
        width: 100%;
        height: auto;
        background: #fff;
        cursor: default;
        touch-action: none;
        user-select: none;
      }

      .map-editing-enabled .map-svg {
        cursor: crosshair;
      }

      .map-svg image {
        user-select: none;
        -webkit-user-drag: none;
      }

      .map-zone-group {
        cursor: pointer;
      }

      .map-zone-rect {
        fill: rgba(47, 104, 70, 0.22);
        stroke: rgba(31, 111, 120, 0.88);
        stroke-width: 2;
        vector-effect: non-scaling-stroke;
      }

      .map-zone-occupied {
        fill: rgba(234, 216, 196, 0.52);
        stroke: rgba(159, 58, 42, 0.92);
      }

      .map-zone-released {
        fill: rgba(31, 111, 120, 0.22);
        stroke: rgba(31, 111, 120, 0.92);
      }

      .map-zone-guest {
        fill: rgba(223, 151, 71, 0.44);
        stroke: rgba(159, 94, 22, 0.92);
      }

      .map-zone-rotatable {
        fill: rgba(170, 33, 34, 0.28);
        stroke: rgba(170, 33, 34, 0.92);
      }

      .map-zone-blocked {
        fill: rgba(31, 35, 40, 0.26);
        stroke: rgba(31, 35, 40, 0.76);
      }

      .map-zone-selected {
        stroke: #000;
        stroke-width: 5;
      }

      .map-zone-status-free {
        background: #dcefd7;
      }

      .map-zone-status-released {
        background: #d8eeef;
      }

      .map-zone-status-occupied,
      .map-zone-status-guest {
        background: #ead8c4;
      }

      .map-zone-status-rotatable {
        background: #efc5bd;
      }

      .map-zone-status-blocked {
        color: #fff;
        background: #4b4f52;
      }

      .map-zone-label {
        fill: #111;
        font: 700 22px/1 ui-sans-serif, system-ui, sans-serif;
        paint-order: stroke;
        pointer-events: none;
        stroke: rgba(255, 255, 255, 0.88);
        stroke-linejoin: round;
        stroke-width: 5;
      }

      .map-draft-zone {
        fill: rgba(31, 111, 120, 0.18);
        pointer-events: none;
        stroke: rgba(31, 111, 120, 0.88);
        stroke-dasharray: 12 8;
        stroke-width: 3;
        vector-effect: non-scaling-stroke;
      }

      .empty {
        margin: 0;
        color: var(--muted);
      }

      .history-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }

      .compact-form {
        grid-template-columns: 1fr;
      }

      code {
        display: block;
        max-width: 420px;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
      }

      @media (max-width: 760px) {
        .action-form,
        .date-form,
        .map-toolbar,
        .map-floor-form,
        .operational-layout,
        .action-form label.wide {
          display: grid;
          grid-template-columns: 1fr;
          grid-column: auto;
        }

        .place-drawer {
          position: static;
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

      ${mainContent}
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
    const extension = path.extname(filename).toLowerCase();

    if (!allowedMapExtensions.has(extension) || !/^parking-g[345]\.(png|jpg|jpeg|webp|svg)$/i.test(filename)) {
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
      'content-type': contentTypeForMap(filename),
      'cache-control': 'public, max-age=300'
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(mapPath).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/map-zones') {
    const result = await fetchJson(`/admin/map-zones?${url.searchParams.toString()}`);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/map-diagnostics') {
    const result = await fetchJson(`/admin/map-diagnostics?${url.searchParams.toString()}`);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/map-backgrounds') {
    try {
      const body = await readRawBody(req);
      const form = parseMultipartFormData(req.headers['content-type'] || '', body);
      const mapCode = String(form.fields.get('mapCode') || '').trim().toLowerCase();
      const mapConfig = parkingMaps.find((map) => map.id === mapCode);
      const file = form.files.get('mapFile');

      if (!mapConfig || !file || !file.buffer.length) {
        throw new Error('Выберите карту G3/G4/G5 и файл подложки.');
      }

      const extension = path.extname(file.filename).toLowerCase();
      if (!allowedMapExtensions.has(extension)) {
        throw new Error('Поддерживаются только PNG, JPG, WEBP и SVG.');
      }

      fs.mkdirSync(mapStoragePath, { recursive: true });
      const normalizedExtension = extension === '.jpeg' ? '.jpg' : extension;
      const filename = `parking-${mapCode}${normalizedExtension}`;
      const targetPath = path.join(mapStoragePath, filename);
      fs.writeFileSync(targetPath, file.buffer);

      const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');
      const fileType = normalizedExtension.slice(1);
      const result = await postJson('/admin/map-backgrounds', {
        mapCode,
        mapTitle: form.fields.get('mapTitle') || mapConfig.title,
        floorLabel: form.fields.get('floorLabel') || mapCode.replace(/^g/, ''),
        filePath: `/maps/${filename}`,
        fileType,
        sourceChecksum: checksum
      });

      if (!result.ok) {
        throw new Error(result.data?.error || `API error ${result.status}`);
      }

      res.writeHead(303, { location: `/?view=maps&mapCode=${encodeURIComponent(mapCode)}&mapUploaded=1` });
      res.end();
      return;
    } catch (error) {
      res.writeHead(303, { location: `/?view=maps&error=${encodeURIComponent(error.message)}` });
      res.end();
      return;
    }
  }

  if (
    req.method === 'POST' &&
    (url.pathname === '/admin/map-zones' ||
      url.pathname === '/admin/map-zones/update' ||
      url.pathname === '/admin/map-zones/delete')
  ) {
    let payload;

    try {
      payload = await readJsonBody(req);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: 'Request body must be valid JSON' }));
      return;
    }

    const result = await postJson(url.pathname, payload);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.data));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/admin/operational-place-card') {
    const selectedDate = url.searchParams.get('date') || todayIsoDate();
    const selectedPlaceId = url.searchParams.get('placeId') || '';
    const requestedMapCode = url.searchParams.get('mapCode') || parkingMaps[0]?.id || 'g4';
    const selectedMapCode = parkingMaps.some((map) => map.id === requestedMapCode) ? requestedMapCode : parkingMaps[0]?.id || 'g4';

    try {
      const model = await buildOperationalPlaceCardModel({
        selectedDate,
        selectedPlaceId,
        selectedMapCode
      });
      const html = renderOperationalPlaceCard(model);
      const selected = getPlaceOperationalState(model, selectedPlaceId);

      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          placeId: selected?.place?.id || null,
          html
        })
      );
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'error', error: error.message }));
      return;
    }
  }

  if (req.method === 'GET' && url.pathname === '/') {
    try {
      const selectedDate = url.searchParams.get('date') || todayIsoDate();
      const requestedView = url.searchParams.get('view') || 'day';
      const normalizedView = requestedView === 'dashboard' ? 'day' : requestedView;
      const activeView = ['day', 'requests', 'catalog', 'lines', 'audit', 'maps'].includes(normalizedView) ? normalizedView : 'day';
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
        releases,
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
        placeHistory,
        employeeHistory
      ] = await Promise.all([
        fetchJson('/health'),
        fetchJson('/health/db'),
        fetchJson('/auth/bootstrap-status'),
        fetchJson('/admin/places'),
        fetchJson('/admin/place-releases'),
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
          : url.searchParams.get('placeCreated') === '1'
            ? { type: 'ok', text: 'Место создано.' }
          : url.searchParams.get('placeUpdated') === '1'
            ? { type: 'ok', text: 'Место обновлено.' }
          : url.searchParams.get('placeDisabled') === '1'
            ? { type: 'ok', text: 'Место отключено.' }
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
          releases,
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
      return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<h1>Admin Web Error</h1><pre>${escapeHtml(error.message)}</pre>`);
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/admin/places') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const payload = {
      code: form.get('code'),
      title: form.get('title'),
      floorLabel: form.get('floorLabel'),
      placeType: form.get('placeType'),
      lineGroupId: form.get('lineGroupId'),
      linePositionHint: form.get('linePositionHint'),
      guestPriorityRank: form.get('guestPriorityRank'),
      isActive: true
    };
    const result = await postJson('/admin/places', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeCreated=1&placeId=${encodeURIComponent(result.data?.place?.id || '')}` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

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
      isActive: form.get('isActive') !== 'false'
    };
    const result = await postJson('/admin/places/update', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeUpdated=1&placeId=${encodeURIComponent(placeId || '')}` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeId=${encodeURIComponent(placeId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/places/disable') {
    const form = await readFormBody(req);
    const selectedDate = form.get('selectedDate') || todayIsoDate();
    const payload = {
      placeId: form.get('placeId')
    };
    const result = await postJson('/admin/places/disable', payload);

    if (result.ok) {
      res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeDisabled=1` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&employeeId=${encodeURIComponent(employeeId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=catalog&date=${encodeURIComponent(selectedDate)}&assignmentStatus=${encodeURIComponent(assignmentStatus)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(payload.dateFrom || todayIsoDate())}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(payload.reservationDate || '')}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(payload.parkingPlaceId || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=lines&date=${encodeURIComponent(payload.occupancyDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=lines&date=${encodeURIComponent(payload.planDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=day&date=${encodeURIComponent(date)}&mapCode=${encodeURIComponent(mapCode)}&placeId=${encodeURIComponent(placeId)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(selectedDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(payload.requestDate || '')}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    const location =
      returnView === 'day'
        ? `/?view=day&date=${encodeURIComponent(payload.requestDate || '')}&mapCode=${encodeURIComponent(returnMapCode)}&placeId=${encodeURIComponent(returnPlaceId)}&error=${encodeURIComponent(message)}`
        : `/?view=requests&date=${encodeURIComponent(payload.requestDate || '')}&error=${encodeURIComponent(message)}`;
    res.writeHead(303, { location });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
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
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(requestDate)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/queue/process') {
    const form = await readFormBody(req);
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/queue/process', { date });

    if (result.ok) {
      const assigned = result.data?.assignedCount || 0;
      const skipped = result.data?.skippedCount || 0;
      res.writeHead(303, {
        location: `/?view=requests&date=${encodeURIComponent(date)}&queueProcessed=1&assigned=${encodeURIComponent(assigned)}&skipped=${encodeURIComponent(skipped)}`
      });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=requests&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/jobs/process-queue') {
    const form = await readFormBody(req);
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/jobs/process-queue', { date });

    if (result.ok) {
      res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&jobDone=process_queue` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/jobs/freeze-next-day') {
    const form = await readFormBody(req);
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/jobs/freeze-next-day', { date });

    if (result.ok) {
      res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&jobDone=freeze_next_day` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/admin/jobs/lock-departure-plans') {
    const form = await readFormBody(req);
    const date = form.get('date') || todayIsoDate();
    const result = await postJson('/admin/jobs/lock-departure-plans', { date });

    if (result.ok) {
      res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&jobDone=lock_departure_plans` });
      res.end();
      return;
    }

    const message = result.data?.error || `API error ${result.status}`;
    res.writeHead(303, { location: `/?view=audit&date=${encodeURIComponent(date)}&error=${encodeURIComponent(message)}` });
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ status: 'error', error: 'Not found' }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`parkingassistant admin-web listening on port ${port}`);
});
