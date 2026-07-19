'use strict';

// Линии — who stands in which position in a line today.

const {
  renderLineOccupancyPanel,
  renderLineOccupancyTable
} = require('../components/line-occupancy');
const { renderDepartureAndConflictsPanel } = require('../components/departures');
const { renderContactAccessLogsTable } = require('../components/audit-tables');

function renderLinesTab(model) {
  return `
    <section class="card">
      <h2 class="section-title">Фактические позиции в линиях</h2>
      <p class="section-copy">
        Кто на какой позиции стоит на выбранную дату. Состав линий — какие элементы
        существуют и сколько в них мест — живёт на вкладке «Места».
      </p>
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

module.exports = {
  renderLinesTab
};
