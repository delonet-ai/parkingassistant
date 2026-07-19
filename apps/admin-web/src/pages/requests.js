'use strict';

// Заявки — employee and guest parking requests.

const { escapeHtml } = require('../../../../packages/shared/html');
const { todayIsoDate } = require('../components/format');
const { renderDateSelector } = require('../components/date-selector');
const {
  renderEmployeeCreateForm,
  renderEmployeeRequestForm,
  renderEmployeeRequestsTable,
  renderQueueProcessForm,
  renderQueueTable
} = require('../components/employee-requests');
const { renderGuestRequestForm, renderGuestRequestsTable } = require('../components/guest-requests');

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

module.exports = {
  renderRequestsTab
};
