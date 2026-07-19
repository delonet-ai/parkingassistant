'use strict';

// День: the KPI strip and the availability dashboard.

const { escapeHtml } = require('../../../../packages/shared/html');
const { formatDate } = require('./format');

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

module.exports = {
  renderDayDashboard,
  renderDayKpis
};
