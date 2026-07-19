'use strict';

// Заявки: guest side.

const { escapeHtml } = require('../../../../packages/shared/html');
const { formatDate, todayIsoDate } = require('./format');

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

module.exports = {
  renderGuestRequestForm,
  renderGuestRequestsTable
};
