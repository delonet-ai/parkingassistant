'use strict';

// Места — which parking places exist at all (the inventory editor).

const { escapeHtml } = require('../../../../packages/shared/html');
const { PLACE_ROLE_OPTIONS, renderPlaceLines } = require('../components/place-lines');
const { mapCodeToFloorLabel, parkingMaps } = require('../config');
const { todayIsoDate } = require('../components/format');
const { configuredMaps } = require('../components/maps');
const { nextFreePlaceCode } = require('../components/places-table');

function renderPlacesTab(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const places = model.places?.data?.places || [];
  const activeMaps = configuredMaps(model);
  const diagnostics = model.mapDiagnostics?.data?.diagnostics || {};
  const selectedMapCode = model.selectedMapCode || parkingMaps[0]?.id || 'g4';
  const selectedMap = activeMaps.find((map) => map.id === selectedMapCode) || activeMaps[0];
  // The floor selector speaks map codes (g4); parking_places.floor_label is the bare digit.
  const selectedFloorLabel = mapCodeToFloorLabel(selectedMapCode);
  const allLines = model.placeLines?.data?.lines || [];
  const floorLines = allLines.filter((line) => String(line.floorLabel || '') === selectedFloorLabel);
  const activePlaceCount = places.length;
  const floorOptions = activeMaps
    .map((map) => `<option value="${escapeHtml(map.id)}"${selectedMapCode === map.id ? ' selected' : ''}>${escapeHtml(map.title)}</option>`)
    .join('');
  const uploadForms = activeMaps
    .map((map) => {
      const metadata = map.metadata;
      const checksum = metadata?.sourceChecksum ? metadata.sourceChecksum.slice(0, 12) : '—';
      const version = metadata?.version || 0;
      const filePath = metadata?.filePath || `/maps/${map.filename}`;

      return `
        <form class="map-upload-form" method="post" action="/admin/map-backgrounds" enctype="multipart/form-data">
          <input type="hidden" name="mapCode" value="${escapeHtml(map.id)}" />
          <input type="hidden" name="mapTitle" value="${escapeHtml(map.title)}" />
          <input type="hidden" name="floorLabel" value="${escapeHtml(mapCodeToFloorLabel(map.id))}" />
          <div>
            <strong>${escapeHtml(map.title)}</strong>
            <span class="muted">v${escapeHtml(version)} · ${escapeHtml(checksum)} · ${escapeHtml(filePath)}</span>
          </div>
          <label>
            <span>Файл</span>
            <input type="file" name="mapFile" accept=".png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml" required />
          </label>
          <button type="submit">Заменить</button>
        </form>
      `;
    })
    .join('');
  const diagnosticGroups = [
    {
      title: 'Место без линии',
      rows: diagnostics.placeWithoutLine || [],
      render: (item) => `
        <tr>
          <td>${escapeHtml(item.parkingPlace?.code || '—')}</td>
          <td>${escapeHtml(item.parkingPlace?.title || '—')}</td>
          <td>${escapeHtml(item.parkingPlace?.floorLabel || '—')}</td>
        </tr>
      `
    },
    {
      title: 'Размер линии не совпадает с числом мест',
      rows: diagnostics.lineCapacityMismatch || [],
      render: (item) => `
        <tr>
          <td>${escapeHtml(item.code || '—')}</td>
          <td>${escapeHtml(item.floorLabel || '—')}</td>
          <td>${escapeHtml(`${item.slotCount} из ${item.capacity}`)}</td>
        </tr>
      `
    }
  ];
  const diagnosticHtml = diagnosticGroups
    .map((group) => {
      const rows = group.rows.map(group.render).join('');
      return `
        <article class="map-diagnostic">
          <div class="map-card-head">
            <h3>${escapeHtml(group.title)}</h3>
            <span class="tag">${escapeHtml(group.rows.length)}</span>
          </div>
          ${
            group.rows.length
              ? `<table>
                  <thead>
                    <tr>
                      <th>Объект</th>
                      <th>Название</th>
                      <th>Детали</th>
                    </tr>
                  </thead>
                  <tbody>${rows}</tbody>
                </table>`
              : '<p class="empty">Проблем не найдено.</p>'
          }
        </article>
      `;
    })
    .join('');
  const slotFields = [1, 2, 3]
    .map(
      (position) => `
        <fieldset class="place-slot-fields" data-slot-position="${position}">
          <legend>Место ${position}</legend>
          <label>
            <span>Код</span>
            <input name="code" required />
          </label>
          <label>
            <span>Название</span>
            <input name="title" />
          </label>
          <label>
            <span>Роль</span>
            <select name="placeRole">
              ${PLACE_ROLE_OPTIONS.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}
            </select>
          </label>
          <label>
            <span>Guest priority</span>
            <input type="number" min="1" max="99" name="guestPriorityRank" />
          </label>
        </fieldset>
      `
    )
    .join('');

  return `
    <section class="card">
      <div class="map-card-head">
        <div>
          <h2 class="section-title">Места</h2>
          <p class="section-copy">
            Инвентарь парковки: какие места вообще существуют. Элемент — это линия на 1–3 места;
            добавление тройного элемента создает три реальных места и меняет вместимость системы.
            Операционная работа по дню — на вкладке “День”.
          </p>
        </div>
        <form class="map-floor-form" method="get" action="/">
          <input type="hidden" name="view" value="places" />
          <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
          <label>
            <span>Этаж</span>
            <select name="mapCode" onchange="this.form.submit()">
              ${floorOptions}
            </select>
          </label>
        </form>
      </div>

      <div class="place-toolbar">
        <button type="button" class="place-line-add" data-capacity="1">+ Одинарное</button>
        <button type="button" class="place-line-add" data-capacity="2">+ Двойное</button>
        <button type="button" class="place-line-add" data-capacity="3">+ Тройное</button>
        <span class="muted">Активных мест: ${escapeHtml(activePlaceCount)}</span>
      </div>
      <p class="notice notice-ok" id="place-lines-output">Этаж ${escapeHtml(selectedMap?.title || selectedMapCode)}: линий ${escapeHtml(floorLines.length)}.</p>

      <div class="map-workspace">
        <img class="place-floor-plan" src="/maps/${escapeHtml(selectedMap?.filename || '')}" alt="План парковки ${escapeHtml(selectedMap?.title || '')}" />
      </div>

      ${renderPlaceLines({ lines: floorLines, selectedDate, mapCode: selectedMapCode }, { mode: 'editor' })}

      <div class="map-upload-panel">
        <p class="label">Подложки G3/G4/G5</p>
        <div class="map-upload-grid">${uploadForms}</div>
      </div>
      <div class="map-diagnostics">${diagnosticHtml}</div>
    </section>

    <dialog id="place-line-dialog">
      <form method="dialog" id="place-line-form">
        <h3 id="place-line-dialog-title">Новый элемент</h3>
        <p class="muted" id="place-line-dialog-hint"></p>
        <div class="place-slot-field-grid">${slotFields}</div>
        <p class="notice notice-error" id="place-line-dialog-error" hidden></p>
        <menu>
          <button type="button" class="button-secondary" data-close-dialog>Отмена</button>
          <button type="button" id="place-line-submit">Создать</button>
        </menu>
      </form>
    </dialog>

    <dialog id="place-line-archive-dialog">
      <form method="dialog" id="place-line-archive-form">
        <h3>Удалить линию</h3>
        <p id="place-line-archive-summary"></p>
        <p class="notice notice-error" id="place-line-archive-error" hidden></p>
        <menu>
          <button type="button" class="button-secondary" data-close-dialog>Отмена</button>
          <button type="button" id="place-line-archive-submit">Удалить</button>
        </menu>
      </form>
    </dialog>

    <script>
      (() => {
        const selectedDate = ${JSON.stringify(selectedDate)};
        const floorLabel = ${JSON.stringify(selectedFloorLabel)};
        const nextCode = ${JSON.stringify(nextFreePlaceCode(places, selectedFloorLabel))};
        const activePlaceCount = ${JSON.stringify(activePlaceCount)};
        const output = document.getElementById('place-lines-output');
        const dialog = document.getElementById('place-line-dialog');
        const dialogTitle = document.getElementById('place-line-dialog-title');
        const dialogHint = document.getElementById('place-line-dialog-hint');
        const dialogError = document.getElementById('place-line-dialog-error');
        const archiveDialog = document.getElementById('place-line-archive-dialog');
        const archiveSummary = document.getElementById('place-line-archive-summary');
        const archiveError = document.getElementById('place-line-archive-error');
        const slotFieldsets = Array.from(document.querySelectorAll('.place-slot-fields'));
        const capacityLabels = { 1: 'одинарное', 2: 'двойное', 3: 'тройное' };
        let pendingCapacity = 1;
        let pendingLineId = '';

        function setOutput(text, isError = false) {
          output.textContent = text;
          output.classList.toggle('notice-error', isError);
          output.classList.toggle('notice-ok', !isError);
        }

        function showDialogError(element, message) {
          element.textContent = message;
          element.hidden = !message;
        }

        function reload() {
          window.location.reload();
        }

        for (const button of document.querySelectorAll('[data-close-dialog]')) {
          button.addEventListener('click', () => button.closest('dialog').close());
        }

        for (const button of document.querySelectorAll('.place-line-add')) {
          button.addEventListener('click', () => {
            pendingCapacity = Number(button.dataset.capacity);
            dialogTitle.textContent = 'Новый элемент: ' + capacityLabels[pendingCapacity];
            dialogHint.textContent =
              'Этаж G' + floorLabel + '. Мест в элементе: ' + pendingCapacity +
              '. Первое свободное числовое имя: ' + nextCode + '.';
            showDialogError(dialogError, '');

            slotFieldsets.forEach((fieldset, index) => {
              const visible = index < pendingCapacity;
              fieldset.hidden = !visible;
              fieldset.disabled = !visible;
              const codeInput = fieldset.querySelector('input[name="code"]');
              const titleInput = fieldset.querySelector('input[name="title"]');
              codeInput.value = visible ? String(Number(nextCode) + index) : '';
              titleInput.value = '';
            });

            dialog.showModal();
          });
        }

        document.getElementById('place-line-submit').addEventListener('click', async () => {
          const slots = slotFieldsets.slice(0, pendingCapacity).map((fieldset) => ({
            code: fieldset.querySelector('input[name="code"]').value.trim(),
            title: fieldset.querySelector('input[name="title"]').value.trim(),
            placeRole: fieldset.querySelector('select[name="placeRole"]').value,
            guestPriorityRank: fieldset.querySelector('input[name="guestPriorityRank"]').value || null
          }));

          if (slots.some((slot) => !slot.code)) {
            showDialogError(dialogError, 'Заполните код каждого места.');
            return;
          }

          const response = await fetch('/admin/place-lines', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ floorLabel, capacity: pendingCapacity, slots })
          });
          const data = await response.json().catch(() => ({}));

          if (!response.ok) {
            showDialogError(dialogError, data.error || ('Не удалось создать элемент (' + response.status + ')'));
            return;
          }

          dialog.close();
          setOutput('Элемент создан: мест добавлено ' + pendingCapacity + '.');
          reload();
        });

        for (const button of document.querySelectorAll('.place-line-archive')) {
          button.addEventListener('click', () => {
            pendingLineId = button.dataset.lineId;
            const codes = button.dataset.placeCodes || '—';
            const affected = codes === '—' ? 0 : codes.split(',').length;
            archiveSummary.textContent =
              'Линия ' + button.dataset.lineCode + ': будут архивированы места ' + codes +
              '. Активных мест станет ' + (activePlaceCount - affected) + ' вместо ' + activePlaceCount + '.';
            showDialogError(archiveError, '');
            archiveDialog.showModal();
          });
        }

        document.getElementById('place-line-archive-submit').addEventListener('click', async () => {
          const response = await fetch('/admin/place-lines/archive', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lineId: pendingLineId })
          });
          const data = await response.json().catch(() => ({}));

          if (!response.ok) {
            const blockers = (data.blockers || [])
              .map((blocker) => blocker.placeCode + ': ' + blocker.type + ' ' + (blocker.detail || '') + ' ' + (blocker.userDisplayName || ''))
              .join('; ');
            showDialogError(archiveError, (data.error || 'Не удалось удалить линию') + (blockers ? ' — ' + blockers : ''));
            return;
          }

          archiveDialog.close();
          setOutput('Линия архивирована.');
          reload();
        });

        // In the inventory editor a slot click opens the place card in Справочники;
        // selecting a place for day operations is the Day tab's job.
        for (const slot of document.querySelectorAll('.place-slot')) {
          slot.addEventListener('click', () => {
            window.location.href =
              '/?view=catalog&date=' + encodeURIComponent(selectedDate) +
              '&placeId=' + encodeURIComponent(slot.dataset.placeId);
          });
        }
      })();
    </script>
  `;
}

module.exports = {
  renderPlacesTab
};
