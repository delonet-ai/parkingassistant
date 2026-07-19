'use strict';

// Per-entity history cards (place, employee).

const { escapeHtml } = require('../../../../packages/shared/html');
const { formatDateTime, todayIsoDate } = require('./format');
const { renderAuditLogsTable, renderContactAccessLogsTable } = require('./audit-tables');

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
        <p class="section-copy">${escapeHtml(details.place.floorLabel || 'без этажа')} · ${escapeHtml(details.place.placeType)} · ${details.place.isActive === false ? 'в архиве' : 'в эксплуатации'}</p>
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

module.exports = {
  renderEmployeeHistoryCard,
  renderPlaceHistoryCard
};
