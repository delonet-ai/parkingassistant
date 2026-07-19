'use strict';

const { escapeHtml } = require('../../../../packages/shared/html');
const {
  PLACE_STATUS_LABELS,
  normalizedStatus,
  renderPlaceLines,
  statusLabel
} = require('./place-lines');

/**
 * Pure renderer for the Day tab's operational floor panel.
 *
 * The floor plan is a static reference <img> and the element grid underneath it is the
 * selector: clicking a slot selects that place and swaps in the place drawer without a
 * reload. The panel takes data and returns HTML; it never fetches or queries.
 */

// place_type is derived from line_groups.capacity, so the type filter is a line-level
// question and every slot in a line answers it the same way.
const PLACE_TYPE_BY_CAPACITY = {
  1: 'single',
  2: 'double',
  3: 'triple'
};

const PLACE_TYPE_FILTERS = [
  ['', 'Все типы'],
  ['single', 'single · одинарное'],
  ['double', 'double · двойное'],
  ['triple', 'triple · тройное']
];

const STATUS_FILTERS = [['', 'Все статусы']].concat(
  PLACE_STATUS_LABELS.map(([status, label]) => [status, `${status} · ${label}`])
);

/**
 * The status/type filters, applied to elements. A line survives a status filter when at
 * least one of its slots matches — hiding a whole line because its rear slot is occupied
 * would hide the free front slot with it.
 *
 * @param {Array} lines
 * @param {{ floorLabel?: string, status?: string, type?: string }} filters
 * @returns {Array}
 */
function filterDayLines(lines, { floorLabel = '', status = '', type = '' } = {}) {
  const source = Array.isArray(lines) ? lines : [];

  return source.filter((line) => {
    if (floorLabel && String(line.floorLabel || '') !== String(floorLabel)) {
      return false;
    }

    if (type && (PLACE_TYPE_BY_CAPACITY[Number(line.capacity)] || '') !== type) {
      return false;
    }

    const slots = Array.isArray(line.slots) ? line.slots : [];

    if (status && !slots.some((slot) => normalizedStatus(slot.status) === status)) {
      return false;
    }

    return true;
  });
}

function renderOptions(options, selected) {
  return options
    .map(
      ([value, label]) =>
        `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
    )
    .join('');
}

function renderLegend() {
  return PLACE_STATUS_LABELS.map(
    ([status]) =>
      `<span class="tag place-status-${escapeHtml(status)}">${escapeHtml(`${status} · ${statusLabel(status)}`)}</span>`
  ).join('\n        ');
}

/**
 * @param {{
 *   maps: Array<{ id: string, title: string, description?: string, filename?: string }>,
 *   selectedMapCode: string,
 *   selectedFloorLabel: string,
 *   selectedDate: string,
 *   selectedPlaceId?: string,
 *   statusFilter?: string,
 *   typeFilter?: string,
 *   lines?: Array,
 *   placeCardHtml: string
 * }} options
 * @returns {string} HTML for the Day tab's floor panel, drawer and selection script
 */
function renderDayMap({
  maps = [],
  selectedMapCode = '',
  selectedFloorLabel = '',
  selectedDate = '',
  selectedPlaceId = '',
  statusFilter = '',
  typeFilter = '',
  lines = [],
  placeCardHtml = ''
} = {}) {
  const selectedMap = maps.find((map) => map.id === selectedMapCode) || maps[0] || null;
  const visibleLines = filterDayLines(lines, {
    floorLabel: selectedFloorLabel,
    status: statusFilter,
    type: typeFilter
  });
  const slotCount = visibleLines.reduce((total, line) => total + (line.slots?.length || 0), 0);

  return `
    <section class="card">
      <div class="map-card-head">
        <div>
          <h2 class="section-title">Места дня</h2>
          <p class="section-copy">Операционный режим: выберите место в списке, чтобы открыть карточку дня. План этажа — статичная справочная картинка, инвентарь редактируется на вкладке “Места”.</p>
        </div>
        <form class="map-floor-form" method="get" action="/">
          <input type="hidden" name="view" value="day" />
          <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
          ${selectedPlaceId ? `<input type="hidden" name="placeId" value="${escapeHtml(selectedPlaceId)}" />` : ''}
          <label>
            <span>Этаж</span>
            <select name="mapCode" onchange="this.form.submit()">
              ${renderOptions(maps.map((map) => [map.id, map.title]), selectedMapCode)}
            </select>
          </label>
          <label>
            <span>Статус</span>
            <select name="status" onchange="this.form.submit()">
              ${renderOptions(STATUS_FILTERS, statusFilter)}
            </select>
          </label>
          <label>
            <span>Тип</span>
            <select name="type" onchange="this.form.submit()">
              ${renderOptions(PLACE_TYPE_FILTERS, typeFilter)}
            </select>
          </label>
        </form>
      </div>
      <div class="map-legend">
        ${renderLegend()}
      </div>
      <div class="operational-layout">
        <div class="operational-places">
          <div class="map-workspace">
            <img
              class="place-floor-plan"
              src="/maps/${escapeHtml(selectedMap?.filename || '')}"
              alt="План парковки ${escapeHtml(selectedMap?.title || '')}"
            />
          </div>
          <p class="muted" id="day-place-lines-summary">Этаж ${escapeHtml(selectedMap?.title || selectedMapCode)}: линий ${escapeHtml(visibleLines.length)}, мест ${escapeHtml(slotCount)}.</p>
          ${renderPlaceLines(
            {
              lines: visibleLines,
              selectedPlaceId,
              selectedDate,
              mapCode: selectedMapCode
            },
            { mode: 'operational' }
          )}
        </div>
        ${placeCardHtml}
      </div>
    </section>
    <script>
      (() => {
        const selectedDate = ${JSON.stringify(selectedDate)};
        const selectedMapCode = ${JSON.stringify(selectedMapCode)};
        const statusFilter = ${JSON.stringify(statusFilter)};
        const typeFilter = ${JSON.stringify(typeFilter)};
        let currentSelectedPlaceId = ${JSON.stringify(selectedPlaceId || '')};

        function dayUrl(placeId) {
          const params = new URLSearchParams({
            view: 'day',
            date: selectedDate,
            mapCode: selectedMapCode
          });

          if (placeId) {
            params.set('placeId', placeId);
          }
          if (statusFilter) {
            params.set('status', statusFilter);
          }
          if (typeFilter) {
            params.set('type', typeFilter);
          }

          return '/?' + params.toString();
        }

        function setSelectedSlot(placeId) {
          currentSelectedPlaceId = placeId || '';
          for (const slot of document.querySelectorAll('.place-slot')) {
            const selected = Boolean(currentSelectedPlaceId) && slot.dataset.placeId === currentSelectedPlaceId;
            slot.setAttribute('aria-pressed', selected ? 'true' : 'false');
            slot.classList.toggle('place-slot--selected', selected);
          }
        }

        function replacePlaceCard(html) {
          const currentCard = document.querySelector('.place-drawer');
          if (currentCard) {
            currentCard.outerHTML = html;
          }
        }

        async function loadOperationalPlaceCard(placeId, shouldPushState) {
          setSelectedSlot(placeId);
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
          const data = await response.json().catch(() => ({}));

          if (!response.ok) {
            replacePlaceCard('<aside class="place-drawer card"><h3>Место не выбрано</h3><p class="empty">Не удалось загрузить карточку места.</p></aside>');
            return;
          }

          replacePlaceCard(data.html);
          if (shouldPushState) {
            window.history.pushState({ placeId: placeId || '' }, '', dayUrl(placeId));
          }
        }

        // A real <button> already gives us focus, Enter/Space activation and a native
        // pressed state, so the click handler is the whole keyboard story too.
        for (const slot of document.querySelectorAll('.place-slot')) {
          slot.addEventListener('click', (event) => {
            event.preventDefault();
            const placeId = slot.dataset.placeId;
            if (!placeId) {
              return;
            }
            loadOperationalPlaceCard(placeId, true);
          });
        }

        window.addEventListener('popstate', () => {
          const params = new URLSearchParams(window.location.search);
          loadOperationalPlaceCard(params.get('placeId') || '', false);
        });
      })();
    </script>
  `;
}

module.exports = {
  PLACE_TYPE_BY_CAPACITY,
  filterDayLines,
  renderDayMap
};
