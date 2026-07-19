'use strict';

// Справочники — places, employees and permanent assignments.

const { renderPlacesTable } = require('../components/places-table');
const { renderEmployeesTable } = require('../components/employees-table');
const { renderEmployeeHistoryCard, renderPlaceHistoryCard } = require('../components/history-cards');
const {
  renderEmployeeEditForm,
  renderPermanentAssignmentForm,
  renderPermanentAssignmentsTable,
  renderPlaceEditForm
} = require('../components/catalog-forms');

function renderCatalogTab(model) {
  const places = model.places?.data?.places || [];

  return `
    <section class="card">
      <h2 class="section-title">Создать место</h2>
      <p class="muted">
        Места создаются только на вкладке «Места», целым элементом (линией на 1–3 места):
        <code>capacity</code> линии — источник истины для типа места, поэтому одиночная
        форма «создать место» неизбежно расходилась бы с составом линии.
        Здесь карточка места только редактируется.
      </p>
    </section>

    <section class="card">
      <h2 class="section-title">Постоянное закрепление</h2>
      ${renderPermanentAssignmentForm(model)}
      <h3>Текущие и будущие закрепления</h3>
      ${renderPermanentAssignmentsTable(model)}
    </section>

    <section class="card">
      <h2 class="section-title">История места</h2>
      ${renderPlaceHistoryCard(model)}
      <h3>Редактировать место</h3>
      ${renderPlaceEditForm(model)}
    </section>

    <section class="card">
      <h2 class="section-title">История сотрудника</h2>
      ${renderEmployeeHistoryCard(model)}
      <h3>Редактировать сотрудника</h3>
      ${renderEmployeeEditForm(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Сотрудники</h2>
      <p class="section-copy">Создание сотрудника остается в операционной вкладке; здесь справочник и переход в историю.</p>
      ${renderEmployeesTable(model)}
    </section>

    <section class="card">
      <h2 class="section-title">Места и закрепления</h2>
      <p class="section-copy">Каталог мест, текущий владелец и переход в историю места.</p>
      ${renderPlacesTable(places, model.selectedDate)}
    </section>
  `;
}

module.exports = {
  renderCatalogTab
};
