'use strict';

// The Справочники place catalog table.

const { escapeHtml } = require('../../../../packages/shared/html');
const { PLACE_ROLE_OPTIONS } = require('./place-lines');
const { todayIsoDate } = require('./format');

const PLACE_ROLE_LABELS = Object.fromEntries(PLACE_ROLE_OPTIONS);

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
        PLACE_ROLE_LABELS[place.placeRole] || PLACE_ROLE_LABELS.regular
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

function nextFreePlaceCode(places, floorLabel) {
  const numbers = places
    .filter((place) => String(place.floorLabel || '') === String(floorLabel))
    .map((place) => Number.parseInt(String(place.code || '').replace(/\D+/g, ''), 10))
    .filter((value) => Number.isFinite(value));

  return numbers.length ? String(Math.max(...numbers) + 1) : `${floorLabel}01`;
}

module.exports = {
  nextFreePlaceCode,
  renderPlacesTable
};
