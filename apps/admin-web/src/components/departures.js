'use strict';

// Departure plans and the conflicts derived from them.

const { escapeHtml } = require('../../../../packages/shared/html');
const { todayIsoDate } = require('./format');

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

module.exports = {
  renderDepartureAndConflictsPanel
};
