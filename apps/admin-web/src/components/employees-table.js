'use strict';

// The Справочники employee table.

const { escapeHtml } = require('../../../../packages/shared/html');
const { todayIsoDate } = require('./format');

function renderEmployeesTable(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];

  if (!employees.length) {
    return '<p class="empty">Сотрудников пока нет.</p>';
  }

  const rows = employees
    .map(
      (employee) => `
        <tr>
          <td>${escapeHtml(employee.displayName)}</td>
          <td>${employee.department ? escapeHtml(employee.department) : '—'}</td>
          <td>${employee.email ? escapeHtml(employee.email) : '—'}</td>
          <td>${employee.phone ? escapeHtml(employee.phone) : '—'}</td>
          <td>${employee.permanentPlace ? escapeHtml(employee.permanentPlace.code) : '—'}</td>
          <td>${employee.yandexMessengerUserId ? escapeHtml(employee.yandexMessengerUserId) : '—'}</td>
          <td><a href="/?view=catalog&date=${encodeURIComponent(selectedDate)}&employeeId=${encodeURIComponent(employee.id)}">История</a></td>
        </tr>
      `
    )
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Email</th>
          <th>Телефон</th>
          <th>Постоянное место</th>
          <th>Messenger ID</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

module.exports = {
  renderEmployeesTable
};
