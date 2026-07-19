'use strict';

// Справочники edit forms and the permanent-assignment panel.

const { escapeHtml } = require('../../../../packages/shared/html');
const { PLACE_ROLE_OPTIONS } = require('./place-lines');
const { todayIsoDate } = require('./format');

function renderPlaceEditForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const place = model.placeHistory?.data?.place;

  if (!place) {
    return '<p class="empty">Выберите место из таблицы, чтобы редактировать карточку.</p>';
  }

  const fullPlace = (model.places?.data?.places || []).find((item) => item.id === place.id) || place;
  const lineGroups = model.lineGroups?.data?.lineGroups || [];
  const lineGroupOptions = lineGroups
    .map((group) => {
      const selected = fullPlace.lineGroup?.id === group.id ? ' selected' : '';
      return `<option value="${escapeHtml(group.id)}"${selected}>${escapeHtml(`${group.code} · ${group.name}`)}</option>`;
    })
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/places/update">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
      <label>
        <span>Код</span>
        <input name="code" value="${escapeHtml(fullPlace.code)}" required />
      </label>
      <label>
        <span>Название</span>
        <input name="title" value="${escapeHtml(fullPlace.title)}" required />
      </label>
      <label>
        <span>Тип</span>
        <select name="placeType" required>
          ${['single', 'double', 'triple'].map((type) => `<option value="${type}"${fullPlace.placeType === type ? ' selected' : ''}>${type}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Этаж</span>
        <input name="floorLabel" value="${escapeHtml(fullPlace.floorLabel || '')}" />
      </label>
      <label>
        <span>Линия</span>
        <select name="lineGroupId" required>
          ${lineGroupOptions}
        </select>
      </label>
      <label>
        <span>Позиция в линии</span>
        <select name="linePositionHint">
          <option value="">—</option>
          ${[1, 2, 3].map((position) => `<option value="${position}"${Number(fullPlace.linePositionHint) === position ? ' selected' : ''}>${position}</option>`).join('')}
        </select>
      </label>
      <label>
        <span>Guest priority</span>
        <input type="number" min="1" max="99" name="guestPriorityRank" value="${escapeHtml(fullPlace.guestPriorityRank || '')}" />
      </label>
      <label>
        <span>Роль места</span>
        <select name="placeRole">
          ${PLACE_ROLE_OPTIONS.map(
            ([value, label]) =>
              `<option value="${value}"${(fullPlace.placeRole || 'regular') === value ? ' selected' : ''}>${escapeHtml(label)}</option>`
          ).join('')}
        </select>
      </label>
      <button type="submit">Сохранить место</button>
    </form>
    <p class="muted">
      Место выводится из эксплуатации ролью «Недоступное», а удаляется вместе со всей
      линией на вкладке «Места» — отдельного «Отключить место» больше нет.
    </p>
  `;
}

function renderEmployeeEditForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employee = model.employeeHistory?.data?.employee;

  if (!employee) {
    return '<p class="empty">Выберите сотрудника из таблицы, чтобы редактировать карточку.</p>';
  }

  return `
    <form class="action-form" method="post" action="/admin/employees/update">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}" />
      <label>
        <span>ФИО</span>
        <input name="displayName" value="${escapeHtml(employee.displayName)}" required />
      </label>
      <label>
        <span>Дирекция</span>
        <input name="department" value="${escapeHtml(employee.department || '')}" />
      </label>
      <label>
        <span>Email</span>
        <input type="email" name="email" value="${escapeHtml(employee.email || '')}" />
      </label>
      <label>
        <span>Телефон</span>
        <input name="phone" value="${escapeHtml(employee.phone || '')}" />
      </label>
      <label class="wide">
        <span>Yandex Messenger ID</span>
        <input name="yandexMessengerUserId" value="${escapeHtml(employee.yandexMessengerUserId || '')}" />
      </label>
      <label>
        <span>Активен</span>
        <select name="isActive">
          <option value="true"${employee.isActive === false ? '' : ' selected'}>Да</option>
          <option value="false"${employee.isActive === false ? ' selected' : ''}>Нет</option>
        </select>
      </label>
      <button type="submit">Сохранить сотрудника</button>
    </form>
    <form class="inline-action-form" method="post" action="/admin/employees/disable">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <input type="hidden" name="employeeId" value="${escapeHtml(employee.id)}" />
      <button class="button-secondary" type="submit">Отключить сотрудника</button>
      <span>Мягко скрывает сотрудника из справочника.</span>
    </form>
  `;
}

function renderPermanentAssignmentForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];
  const places = model.places?.data?.places || [];
  const employeeOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(`${employee.displayName}${employee.department ? ` · ${employee.department}` : ''}`)}</option>`)
    .join('');
  const placeOptions = places
    .map((place) => `<option value="${escapeHtml(place.id)}">${escapeHtml(`${place.code} · ${place.title}`)}</option>`)
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/permanent-assignments">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Выберите сотрудника</option>
          ${employeeOptions}
        </select>
      </label>
      <label>
        <span>Место</span>
        <select name="parkingPlaceId" required>
          <option value="">Выберите место</option>
          ${placeOptions}
        </select>
      </label>
      <label>
        <span>С даты</span>
        <input type="date" name="dateFrom" value="${escapeHtml(selectedDate)}" required />
      </label>
      <label>
        <span>По дату</span>
        <input type="date" name="dateTo" />
      </label>
      <label class="wide">
        <span>Комментарий</span>
        <input name="notes" placeholder="Причина закрепления" />
      </label>
      <button type="submit">Создать закрепление</button>
    </form>
  `;
}

function renderPermanentAssignmentsTable(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const filterStatus = model.assignmentStatusFilter || 'all';
  const assignments = model.permanentAssignments?.data?.permanentAssignments || [];
  const statusOptions = [
    ['all', 'Все'],
    ['active', 'Активные'],
    ['future', 'Будущие'],
    ['ended', 'Завершенные']
  ]
    .map(([value, label]) => `<option value="${escapeHtml(value)}"${filterStatus === value ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

  const filterForm = `
    <form class="date-form" method="get" action="/">
      <input type="hidden" name="view" value="catalog" />
      <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Статус закрепления</span>
        <select name="assignmentStatus" onchange="this.form.submit()">
          ${statusOptions}
        </select>
      </label>
      <button type="submit">Показать</button>
    </form>
  `;

  if (!assignments.length) {
    return `${filterForm}<p class="empty">Постоянных закреплений по выбранному фильтру нет.</p>`;
  }

  const rows = assignments
    .map((assignment) => {
      const canEnd = assignment.status !== 'ended';
      const endForm = canEnd
        ? `<form method="post" action="/admin/permanent-assignments/end">
            <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
            <input type="hidden" name="assignmentStatus" value="${escapeHtml(filterStatus)}" />
            <input type="hidden" name="assignmentId" value="${escapeHtml(assignment.id)}" />
            <input type="date" name="dateTo" value="${escapeHtml(selectedDate)}" required />
            <button class="button-secondary" type="submit">Завершить</button>
          </form>`
        : '—';

      return `
        <tr>
          <td><span class="tag ${assignment.status === 'active' ? 'free' : assignment.status === 'ended' ? 'reserved' : ''}">${escapeHtml(assignment.status)}</span></td>
          <td>${escapeHtml(assignment.parkingPlace.code)}</td>
          <td>${escapeHtml(assignment.parkingPlace.title)}</td>
          <td>${escapeHtml(assignment.user.displayName)}</td>
          <td>${assignment.user.department ? escapeHtml(assignment.user.department) : '—'}</td>
          <td>${escapeHtml(`${assignment.dateFrom} — ${assignment.dateTo || '∞'}`)}</td>
          <td>${assignment.notes ? escapeHtml(assignment.notes) : '—'}</td>
          <td>${endForm}</td>
        </tr>
      `;
    })
    .join('');

  return `
    ${filterForm}
    <table>
      <thead>
        <tr>
          <th>Статус</th>
          <th>Место</th>
          <th>Название</th>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Период</th>
          <th>Комментарий</th>
          <th>Действие</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

module.exports = {
  renderEmployeeEditForm,
  renderPermanentAssignmentForm,
  renderPermanentAssignmentsTable,
  renderPlaceEditForm
};
