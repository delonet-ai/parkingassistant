'use strict';

const { escapeHtml } = require('../../../packages/shared/html');

/**
 * Pure renderer for the place-inventory element grid.
 *
 * An "element" is a parking line holding 1-3 slots; one slot is one parking_places row.
 * The renderer takes data and returns escaped HTML — no SQL, no fetching, no globals — so
 * both the operational Day tab and the Места inventory editor render the same markup and
 * only differ in `mode`:
 *
 *   'operational' — slots are selectors: clicking one opens the place drawer.
 *   'editor'      — slots additionally carry the per-slot place-role control and the line
 *                   carries its archive button.
 */

// The replacement for the old per-zone "Тип зоны" select: place_role is a first-class
// parking_places column since 005_place_inventory.sql. 'rotatable' is the guest pool,
// 'blocked' takes a single slot out of service without archiving the whole line.
const PLACE_ROLE_OPTIONS = [
  ['regular', 'Обычное'],
  ['rotatable', 'Ротируемое/гостевое'],
  ['blocked', 'Недоступное']
];

// Status is never conveyed by colour alone — every slot prints the word too, so the list
// stays readable for colour-blind operators and in print.
const PLACE_STATUS_LABELS = [
  ['free', 'свободно'],
  ['released', 'отдано'],
  ['occupied', 'занято'],
  ['guest', 'гостевое'],
  ['rotatable', 'ротируемое'],
  ['blocked', 'недоступно']
];

const PLACE_STATUSES = PLACE_STATUS_LABELS.map(([status]) => status);

const CAPACITY_LABELS = {
  1: 'одинарное',
  2: 'двойное',
  3: 'тройное'
};

// Slots are stacked in physical order, front on top, so the card mirrors the real line.
const POSITION_LABELS = {
  2: ['перёд', 'зад'],
  3: ['перёд', 'середина', 'зад']
};

function statusLabel(status) {
  const match = PLACE_STATUS_LABELS.find(([value]) => value === status);

  return match ? match[1] : status;
}

function normalizedStatus(status) {
  return PLACE_STATUSES.includes(status) ? status : 'free';
}

function capacityLabel(capacity) {
  return CAPACITY_LABELS[capacity] || `${capacity} мест`;
}

function positionLabel(capacity, position, index) {
  const labels = POSITION_LABELS[capacity];

  if (!labels) {
    return '';
  }

  const slotIndex = Number.isInteger(position) && position >= 1 ? position - 1 : index;

  return labels[slotIndex] || '';
}

function renderRoleControl(slot, line, selectedDate, mapCode) {
  const options = PLACE_ROLE_OPTIONS.map(
    ([value, label]) =>
      `<option value="${escapeHtml(value)}"${(slot.placeRole || 'regular') === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
  ).join('');

  // /admin/places/update overwrites linePositionHint and guestPriorityRank rather than
  // coalescing them, so a role-only edit has to resend the slot's current values.
  return `
    <form class="place-slot-role" method="post" action="/admin/places/update">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="returnView" value="places" />
      <input type="hidden" name="mapCode" value="${escapeHtml(mapCode)}" />
      <input type="hidden" name="placeId" value="${escapeHtml(slot.placeId)}" />
      <input type="hidden" name="code" value="${escapeHtml(slot.code || '')}" />
      <input type="hidden" name="title" value="${escapeHtml(slot.title || slot.code || '')}" />
      <input type="hidden" name="floorLabel" value="${escapeHtml(line.floorLabel || '')}" />
      <input type="hidden" name="placeType" value="${escapeHtml(slot.placeType || 'single')}" />
      <input type="hidden" name="linePositionHint" value="${escapeHtml(slot.position || '')}" />
      <input type="hidden" name="guestPriorityRank" value="${escapeHtml(slot.guestPriorityRank || '')}" />
      <label>
        <span class="sr-only">Роль места ${escapeHtml(slot.code || '')}</span>
        <select name="placeRole" onchange="this.form.submit()">${options}</select>
      </label>
      <noscript><button type="submit">Сохранить</button></noscript>
    </form>
  `;
}

function renderSlot(slot, line, index, { mode, selectedPlaceId, selectedDate, mapCode }) {
  const status = normalizedStatus(slot.status);
  const position = positionLabel(line.capacity, slot.position, index);
  const selected = Boolean(selectedPlaceId) && slot.placeId === selectedPlaceId;
  const owner = slot.userDisplayName
    ? `<span class="place-slot-owner">${escapeHtml(slot.userDisplayName)}</span>`
    : '';

  return `
    <div class="place-slot-row">
      <button
        type="button"
        class="place-slot place-slot--${escapeHtml(status)}${selected ? ' place-slot--selected' : ''}"
        data-place-id="${escapeHtml(slot.placeId)}"
        data-place-code="${escapeHtml(slot.code || '')}"
        data-status="${escapeHtml(status)}"
        data-place-type="${escapeHtml(slot.placeType || '')}"
        data-place-role="${escapeHtml(slot.placeRole || 'regular')}"
        aria-pressed="${selected ? 'true' : 'false'}"
      >
        <span class="place-slot-code">${escapeHtml(slot.code || '—')}</span>
        ${position ? `<span class="place-slot-position">${escapeHtml(position)}</span>` : ''}
        <span class="place-slot-status">${escapeHtml(statusLabel(status))}</span>
        ${owner}
      </button>
      ${mode === 'editor' ? renderRoleControl(slot, line, selectedDate, mapCode) : ''}
    </div>
  `;
}

function renderLine(line, options) {
  const capacity = Number(line.capacity) || line.slots?.length || 1;
  const slots = (line.slots || [])
    .map((slot, index) => renderSlot(slot, { ...line, capacity }, index, options))
    .join('');
  const archive =
    options.mode === 'editor'
      ? `<button
           type="button"
           class="button-secondary place-line-archive"
           data-line-id="${escapeHtml(line.lineId)}"
           data-line-code="${escapeHtml(line.code || '')}"
           data-place-codes="${escapeHtml((line.slots || []).map((slot) => slot.code).join(', '))}"
         >Удалить линию</button>`
      : '';

  return `
    <article
      class="place-line"
      data-line-id="${escapeHtml(line.lineId)}"
      data-capacity="${escapeHtml(capacity)}"
      data-floor-label="${escapeHtml(line.floorLabel || '')}"
    >
      <header class="place-line-head">
        <h4>Линия ${escapeHtml(line.code || line.lineId)}</h4>
        <span class="tag">${escapeHtml(capacityLabel(capacity))}</span>
      </header>
      <div class="place-line-slots">${slots}</div>
      ${archive ? `<footer class="place-line-foot">${archive}</footer>` : ''}
    </article>
  `;
}

/**
 * @param {{ lines?: Array, selectedPlaceId?: string, selectedDate?: string, mapCode?: string }} model
 * @param {{ mode?: 'operational' | 'editor' }} options
 * @returns {string} escaped HTML for the element grid, grouped into one section per floor
 */
function renderPlaceLines(model = {}, { mode = 'operational' } = {}) {
  const lines = Array.isArray(model.lines) ? model.lines : [];
  const renderOptions = {
    mode: mode === 'editor' ? 'editor' : 'operational',
    selectedPlaceId: model.selectedPlaceId || '',
    selectedDate: model.selectedDate || '',
    mapCode: model.mapCode || ''
  };

  if (!lines.length) {
    return '<p class="empty">Линий пока нет. Добавьте элемент кнопками выше.</p>';
  }

  const byFloor = new Map();

  for (const line of lines) {
    const floorLabel = line.floorLabel || '';
    if (!byFloor.has(floorLabel)) {
      byFloor.set(floorLabel, []);
    }
    byFloor.get(floorLabel).push(line);
  }

  return Array.from(byFloor.entries())
    .map(
      ([floorLabel, floorLines]) => `
        <section class="place-floor" data-floor-label="${escapeHtml(floorLabel)}">
          <h3 class="place-floor-title">${escapeHtml(floorLabel ? `Этаж G${floorLabel}` : 'Без этажа')}</h3>
          <div class="place-line-grid">${floorLines.map((line) => renderLine(line, renderOptions)).join('')}</div>
        </section>
      `
    )
    .join('');
}

module.exports = {
  CAPACITY_LABELS,
  PLACE_ROLE_OPTIONS,
  PLACE_STATUSES,
  PLACE_STATUS_LABELS,
  renderPlaceLines,
  statusLabel
};
