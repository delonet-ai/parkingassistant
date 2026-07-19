'use strict';

// Линии: today's actual positions inside each line.

const { escapeHtml } = require('../../../../packages/shared/html');
const { todayIsoDate } = require('./format');

function renderLineOccupancyPanel(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const employees = model.employees?.data?.employees || [];
  const lineGroups = model.lineGroups?.data?.lineGroups || [];

  if (!lineGroups.length) {
    return '<p class="empty">Линий пока нет. Добавьте элементы на вкладке «Места».</p>';
  }

  // The line drives both other selects: which places can be picked, and how many
  // positions the line actually has. Rendering all places against a hardcoded 1/2/3
  // meant the operator could submit combinations the API can only reject.
  const lineGroupOptions = lineGroups
    .map(
      (lineGroup) =>
        `<option value="${escapeHtml(lineGroup.id)}" data-capacity="${escapeHtml(lineGroup.capacity)}">${escapeHtml(`${lineGroup.code} · ${lineGroup.name}`)}</option>`
    )
    .join('');
  const placeOptions = lineGroups
    .flatMap((lineGroup) =>
      (lineGroup.places || []).map(
        (place) =>
          `<option value="${escapeHtml(place.id)}" data-line-id="${escapeHtml(lineGroup.id)}" hidden>${escapeHtml(`${place.code} · позиция ${place.positionHint || '—'}`)}</option>`
      )
    )
    .join('');
  const employeeOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.displayName)}</option>`)
    .join('');

  return `
    <form class="action-form" method="post" action="/admin/line-occupancy" id="line-occupancy-form">
      <input type="hidden" name="occupancyDate" value="${escapeHtml(selectedDate)}" />
      <label>
        <span>Линия</span>
        <select name="lineGroupId" required>
          <option value="">Выберите линию</option>
          ${lineGroupOptions}
        </select>
      </label>
      <label>
        <span>Место</span>
        <select name="parkingPlaceId" required>
          <option value="">Сначала выберите линию</option>
          ${placeOptions}
        </select>
      </label>
      <label>
        <span>Позиция</span>
        <select name="position" required>
          <option value="">Сначала выберите линию</option>
        </select>
      </label>
      <label>
        <span>Сотрудник</span>
        <select name="userId" required>
          <option value="">Кто фактически стоит</option>
          ${employeeOptions}
        </select>
      </label>
      <button type="submit">Зафиксировать позицию</button>
    </form>
    <script>
      (function () {
        var form = document.getElementById('line-occupancy-form');
        if (!form) {
          return;
        }

        var lineSelect = form.querySelector('select[name="lineGroupId"]');
        var placeSelect = form.querySelector('select[name="parkingPlaceId"]');
        var positionSelect = form.querySelector('select[name="position"]');
        var positionLabels = ['первый', 'второй', 'третий'];

        function syncToLine() {
          var lineId = lineSelect.value;
          var capacity = Number(lineSelect.selectedOptions[0] && lineSelect.selectedOptions[0].dataset.capacity) || 0;

          for (var i = 0; i < placeSelect.options.length; i += 1) {
            var option = placeSelect.options[i];
            if (!option.value) {
              option.textContent = lineId ? 'Выберите место линии' : 'Сначала выберите линию';
              continue;
            }
            var matches = option.dataset.lineId === lineId;
            option.hidden = !matches;
            option.disabled = !matches;
          }

          if (placeSelect.selectedOptions[0] && placeSelect.selectedOptions[0].disabled) {
            placeSelect.value = '';
          }

          positionSelect.innerHTML = '';
          if (!capacity) {
            positionSelect.append(new Option('Сначала выберите линию', ''));
            return;
          }
          for (var position = 1; position <= capacity; position += 1) {
            positionSelect.append(new Option(position + ' · ' + positionLabels[position - 1], String(position)));
          }
        }

        lineSelect.addEventListener('change', syncToLine);
        syncToLine();
      })();
    </script>
  `;
}

function renderLineOccupancyTable(model) {
  const occupancy = model.lineOccupancy?.data?.occupancy || [];

  if (!occupancy.length) {
    return '<p class="empty">На выбранную дату позиции в линиях еще не зафиксированы.</p>';
  }

  const rows = occupancy
    .map((item) => {
      const subject =
        item.subjectType === 'guest'
          ? `Гость: ${item.guestParkingRequest?.guestName || '—'}`
          : `Сотрудник: ${item.user?.displayName || '—'}`;
      const contacts =
        item.subjectType === 'guest'
          ? `Администратор / приглашающий: ${item.guestParkingRequest?.hostDisplayName || '—'}`
          : [item.user?.phone, item.user?.email].filter(Boolean).join(' · ') || 'контакты не указаны';

      return `
        <tr>
          <td>${escapeHtml(item.lineGroup.code)}</td>
          <td>${escapeHtml(item.position)}</td>
          <td>${escapeHtml(item.parkingPlace.code)}</td>
          <td>${escapeHtml(subject)}</td>
          <td>${escapeHtml(item.subjectType)}</td>
          <td>${escapeHtml(contacts)}</td>
          <td>${item.reservation ? escapeHtml(item.reservation.source) : '—'}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Линия</th>
          <th>Позиция</th>
          <th>Место</th>
          <th>Кто стоит</th>
          <th>Тип</th>
          <th>Контакт/маршрут</th>
          <th>Источник</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

module.exports = {
  renderLineOccupancyPanel,
  renderLineOccupancyTable
};
