'use strict';

// The operational place drawer — the aside the Day tab swaps in when a slot is clicked.
// Its status comes from the same derivePlaceStatus() the slot itself uses, so the two
// can no longer disagree (Task 12, defect 5).

const { escapeHtml } = require('../../../../packages/shared/html');
const { derivePlaceStatus, statusLabel } = require('./place-lines');
const { parkingMaps } = require('../config');
const { todayIsoDate } = require('./format');

function getPlaceOperationalState(model, placeId) {
  if (!placeId) {
    return null;
  }

  const place = (model.places?.data?.places || []).find((item) => item.id === placeId);
  if (!place) {
    return null;
  }

  const dashboard = model.dashboard?.data || {};
  const release = (dashboard.releasedPlaces || []).find((item) => item.parkingPlace.id === placeId) || null;
  const reservation = (dashboard.reservations || []).find((item) => item.parkingPlace.id === placeId) || null;
  const guestRequest = (dashboard.guestRequests || []).find((request) => request.assignedReservation?.parkingPlace?.id === placeId) || null;
  const lineOccupancy = (model.lineOccupancy?.data?.occupancy || []).find((item) => item.parkingPlace.id === placeId) || null;
  const status = derivePlaceStatus({
    hasReservation: Boolean(reservation),
    reservationSource: reservation?.source,
    hasRelease: Boolean(release),
    placeRole: place.placeRole
  });

  return {
    place,
    release,
    reservation,
    guestRequest,
    lineOccupancy,
    status
  };
}

function renderOperationalPlaceCard(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const selected = getPlaceOperationalState(model, model.selectedPlaceId);
  const employees = model.employees?.data?.employees || [];
  const selectedMapCode = model.selectedMapCode || parkingMaps[0]?.id || 'g4';

  if (!selected) {
    return `
      <aside class="place-drawer card">
        <h3>Место не выбрано</h3>
        <p class="empty">Выберите место в списке элементов, чтобы открыть операционную карточку.</p>
      </aside>
    `;
  }

  const { place, release, reservation, guestRequest, lineOccupancy, status } = selected;
  const employeeOptions = employees
    .map((employee) => {
      const department = employee.department ? ` · ${employee.department}` : '';
      const permanent = employee.permanentPlace ? ` · место ${employee.permanentPlace.code}` : ' · без места';
      return `<option value="${escapeHtml(employee.id)}">${escapeHtml(`${employee.displayName}${department}${permanent}`)}</option>`;
    })
    .join('');
  const hostOptions = employees
    .map((employee) => `<option value="${escapeHtml(employee.id)}">${escapeHtml(employee.displayName)}</option>`)
    .join('');
  const owner = place.permanentOwner;
  const canRelease = Boolean(owner);
  const canManualAssign = Boolean(release && !reservation);

  return `
    <aside class="place-drawer card">
      <div class="history-head">
        <div>
          <h3>${escapeHtml(place.code)} · ${escapeHtml(place.title)}</h3>
          <p class="section-copy">${escapeHtml(place.floorLabel || 'без этажа')} · ${escapeHtml(place.placeType)} · ${place.lineGroup ? escapeHtml(`линия ${place.lineGroup.code}`) : 'без линии'}</p>
        </div>
        <span class="tag place-status-${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>
      </div>

      <div class="mini-grid">
        <article>
          <p class="label">Владелец</p>
          <p>${owner ? escapeHtml(owner.displayName) : '—'}</p>
        </article>
        <article>
          <p class="label">Назначение</p>
          <p>${reservation ? escapeHtml(`${reservation.source} · ${reservation.user?.displayName || guestRequest?.guestName || 'гость'}`) : '—'}</p>
        </article>
        <article>
          <p class="label">Отдача</p>
          <p>${release ? escapeHtml(`${release.owner.displayName}${release.releaseNotes ? ` · ${release.releaseNotes}` : ''}`) : '—'}</p>
        </article>
        <article>
          <p class="label">Позиция</p>
          <p>${lineOccupancy ? escapeHtml(`${lineOccupancy.lineGroup.code} · позиция ${lineOccupancy.position}`) : '—'}</p>
        </article>
      </div>

      <h4>Операции по месту</h4>
      ${
        canRelease
          ? `<form class="action-form compact-form" method="post" action="/admin/place-releases">
              <input type="hidden" name="parkingPlaceId" value="${escapeHtml(place.id)}" />
              <input type="hidden" name="dateFrom" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="dateTo" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
              <label class="wide">
                <span>Отдать место на день</span>
                <input name="notes" placeholder="Комментарий" />
              </label>
              <button type="submit">Отдать на ${escapeHtml(selectedDate)}</button>
            </form>`
          : '<p class="empty">У места нет постоянного владельца, отдача недоступна.</p>'
      }

      ${
        canManualAssign
          ? `<form class="action-form compact-form" method="post" action="/admin/reservations/manual">
              <input type="hidden" name="reservationDate" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="parkingPlaceId" value="${escapeHtml(place.id)}" />
              <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
              <label>
                <span>Назначить сотрудника</span>
                <select name="userId" required>
                  <option value="">Кому назначить</option>
                  ${employeeOptions}
                </select>
              </label>
              <label>
                <span>Причина</span>
                <input name="reason" placeholder="Ручное назначение с карты" />
              </label>
              <button type="submit">Назначить</button>
            </form>`
          : '<p class="empty">Ручное назначение доступно только для отданного и свободного места.</p>'
      }

      ${
        reservation
          ? `<form class="inline-action-form" method="post" action="/admin/reservations/cancel">
              <input type="hidden" name="reservationId" value="${escapeHtml(reservation.id)}" />
              <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
              <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
              <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
              <button class="button-secondary" type="submit">Отменить назначение</button>
              <span>${escapeHtml(reservation.source)}</span>
            </form>`
          : ''
      }

      ${
        release
          ? `<form class="inline-action-form" method="post" action="/admin/place-releases/cancel">
              <input type="hidden" name="releaseId" value="${escapeHtml(release.releaseId)}" />
              <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
              <button class="button-secondary" type="submit"${reservation ? ' disabled' : ''}>Вернуть место владельцу</button>
              <span>${
                reservation
                  ? 'Сначала отмените назначение — место уже отдано кому-то на этот день.'
                  : 'Отменяет отдачу: место снова закреплено за владельцем.'
              }</span>
            </form>`
          : ''
      }

      <details>
        <summary>Создать гостевую заявку</summary>
        <p class="empty">Место для гостя выбирается backend по приоритету single → double → triple и резерву.</p>
        <form class="action-form compact-form" method="post" action="/admin/guest-parking-requests">
          <input type="hidden" name="requestDate" value="${escapeHtml(selectedDate)}" />
          <input type="hidden" name="returnView" value="day" />
          <input type="hidden" name="placeId" value="${escapeHtml(place.id)}" />
          <input type="hidden" name="mapCode" value="${escapeHtml(selectedMapCode)}" />
          <label>
            <span>Приглашающий</span>
            <select name="hostUserId" required>
              <option value="">Выберите сотрудника</option>
              ${hostOptions}
            </select>
          </label>
          <label>
            <span>Гость</span>
            <input name="guestName" required />
          </label>
          <label>
            <span>Телефон</span>
            <input name="guestPhone" />
          </label>
          <label>
            <span>Авто</span>
            <input name="vehiclePlateNumber" />
          </label>
          <button type="submit">Создать гостя</button>
        </form>
      </details>

      <p>
        <a href="/?view=catalog&date=${encodeURIComponent(selectedDate)}&placeId=${encodeURIComponent(place.id)}">Открыть историю места</a>
      </p>
    </aside>
  `;
}

module.exports = {
  getPlaceOperationalState,
  renderOperationalPlaceCard
};
