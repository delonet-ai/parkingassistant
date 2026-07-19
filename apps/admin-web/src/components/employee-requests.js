'use strict';

// Заявки: employee side — create, request, queue.

const { escapeHtml } = require('../../../../packages/shared/html');
const { formatDate, formatDateTime, todayIsoDate } = require('./format');

function renderEmployeeCreateForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();

  return `
    <form class="action-form" method="post" action="/admin/employees">
      <input type="hidden" name="selectedDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>ФИО</span>
        <input type="text" name="displayName" placeholder="Иванов Иван" required />
      </label>
      <label>
        <span>Дирекция</span>
        <input type="text" name="department" placeholder="Например: ИТ" />
      </label>
      <label>
        <span>Email</span>
        <input type="email" name="email" placeholder="name@example.com" />
      </label>
      <label>
        <span>Телефон</span>
        <input type="text" name="phone" placeholder="+7..." />
      </label>
      <label class="wide">
        <span>Yandex Messenger ID</span>
        <input type="text" name="yandexMessengerUserId" placeholder="Заполним позже при интеграции" />
      </label>
      <button type="submit">Создать сотрудника</button>
    </form>
  `;
}

function renderEmployeeRequestForm(model) {
  const employees = model.employees?.data?.employees || [];
  const selectedDate = model.selectedDate || todayIsoDate();
  const employeesWithoutPlace = employees.filter((employee) => !employee.permanentPlace);
  const employeeOptions = employees
    .map((employee) => {
      const department = employee.department ? ` · ${employee.department}` : '';
      const permanent = employee.permanentPlace ? ` · место ${employee.permanentPlace.code}` : ' · без места';
      const disabled = employee.permanentPlace ? ' disabled' : '';
      return `<option value="${escapeHtml(employee.id)}"${disabled}>${escapeHtml(`${employee.displayName}${department}${permanent}`)}</option>`;
    })
    .join('');

  if (!employeesWithoutPlace.length) {
    return '<p class="empty">На выбранную дату все сотрудники в справочнике имеют постоянные места. Создайте сотрудника без места выше или смените дату.</p>';
  }

  return `
    <form class="action-form" method="post" action="/admin/employee-parking-requests">
      <input type="hidden" name="requestDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Кто просит место</option>
          ${employeeOptions}
        </select>
      </label>
      <label class="wide">
        <span>Комментарий</span>
        <input type="text" name="notes" placeholder="Например: заявка через администратора" />
      </label>
      <button type="submit">Поставить в очередь</button>
    </form>
  `;
}

function renderEmployeeRequestsTable(model) {
  const requests = model.employeeRequests?.data?.requests || [];

  if (!requests.length) {
    return '<p class="empty">На выбранную дату заявок сотрудников пока нет.</p>';
  }

  const rows = requests
    .map((request) => {
      const canCancel = ['active', 'queued'].includes(request.status);
      const queuePosition = request.queueEntry?.position ? `#${request.queueEntry.position}` : '—';
      const queueStatus = request.queueEntry?.status || '—';
      const assignedPlace = request.assignedReservation?.parkingPlaceCode || '—';
      const statusReason = request.assignedReservation
        ? `Назначено место ${assignedPlace}`
        : request.queueEntry
          ? `Очередь ${queueStatus}${request.queueEntry.processedAt ? ` · обработано ${formatDateTime(request.queueEntry.processedAt)}` : ''}`
          : request.status === 'canceled'
            ? 'Заявка отменена'
            : 'Ожидает обработки очереди';
      const cancelForm = canCancel
        ? `
          <form method="post" action="/admin/employee-parking-requests/cancel">
            <input type="hidden" name="requestId" value="${escapeHtml(request.id)}" />
            <input type="hidden" name="requestDate" value="${escapeHtml(formatDate(request.requestDate))}" />
            <button class="button-secondary" type="submit">Отменить</button>
          </form>
        `
        : '—';

      return `
        <tr>
          <td>${queuePosition}</td>
          <td>${escapeHtml(request.user.displayName)}</td>
          <td>${request.user.department ? escapeHtml(request.user.department) : '—'}</td>
          <td><span class="tag">${escapeHtml(request.status)}</span></td>
          <td>${escapeHtml(queueStatus)}</td>
          <td>${escapeHtml(assignedPlace)}</td>
          <td>${escapeHtml(statusReason)}</td>
          <td>${request.notes ? escapeHtml(request.notes) : '—'}</td>
          <td>${cancelForm}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Очередь</th>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Заявка</th>
          <th>Статус очереди</th>
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

function renderQueueTable(model) {
  const requests = model.employeeRequests?.data?.requests || [];
  const queueEntries = requests
    .filter((request) => request.queueEntry)
    .sort((left, right) => Number(left.queueEntry?.position || 0) - Number(right.queueEntry?.position || 0));

  if (!queueEntries.length) {
    return '<p class="empty">Очередь на выбранную дату пуста.</p>';
  }

  const rows = queueEntries
    .map((request) => {
      const queue = request.queueEntry;
      const assignedPlace = request.assignedReservation?.parkingPlaceCode;
      const reason = assignedPlace
        ? `Назначено место ${assignedPlace}`
        : queue.status === 'waiting'
          ? 'Ожидает запуска обработки'
          : queue.status === 'skipped'
            ? 'Пропущено: место не найдено или сработал гостевой резерв'
            : queue.status === 'canceled'
              ? 'Заявка отменена'
              : `Статус очереди: ${queue.status}`;

      return `
        <tr>
          <td>#${escapeHtml(queue.position)}</td>
          <td>${escapeHtml(request.user.displayName)}</td>
          <td>${request.user.department ? escapeHtml(request.user.department) : '—'}</td>
          <td><span class="tag">${escapeHtml(queue.status)}</span></td>
          <td>${assignedPlace ? escapeHtml(assignedPlace) : '—'}</td>
          <td>${escapeHtml(reason)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Позиция</th>
          <th>Сотрудник</th>
          <th>Дирекция</th>
          <th>Статус</th>
          <th>Место</th>
          <th>Причина статуса</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderQueueProcessForm(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const requests = model.employeeRequests?.data?.requests || [];
  const waitingCount = requests.filter((request) => request.queueEntry?.status === 'waiting').length;

  return `
    <form class="inline-action-form" method="post" action="/admin/queue-run">
      <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
      <button type="submit" ${waitingCount ? '' : 'disabled'}>Обработать очередь</button>
      <span>${escapeHtml(waitingCount)} ожидает обработки</span>
    </form>
  `;
}

module.exports = {
  renderEmployeeCreateForm,
  renderEmployeeRequestForm,
  renderEmployeeRequestsTable,
  renderQueueProcessForm,
  renderQueueTable
};
