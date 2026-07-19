'use strict';

// День — who is parked where today, and what do I change about today?

const { escapeHtml } = require('../../../../packages/shared/html');
const { parkingMaps } = require('../config');
const { todayIsoDate } = require('../components/format');
const { renderDateSelector } = require('../components/date-selector');
const { renderOperationalMap } = require('../components/operational-map');
const { renderDayDashboard, renderDayKpis } = require('../components/dashboard');

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
      <p class="section-copy">Выбранная дата: ${escapeHtml(selectedDate)}. Основная работа администратора: статус мест и быстрые действия по выбранному месту.</p>
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

module.exports = {
  renderDayPage
};
