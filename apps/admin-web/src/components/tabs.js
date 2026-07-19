'use strict';

// The tab strip.

function renderTabs(activeView, selectedDate) {
  const dayHref = `/?view=day&date=${encodeURIComponent(selectedDate)}`;
  const requestsHref = `/?view=requests&date=${encodeURIComponent(selectedDate)}`;
  const catalogHref = `/?view=catalog&date=${encodeURIComponent(selectedDate)}`;
  const linesHref = `/?view=lines&date=${encodeURIComponent(selectedDate)}`;
  const auditHref = `/?view=audit&date=${encodeURIComponent(selectedDate)}`;
  const placesHref = `/?view=places&date=${encodeURIComponent(selectedDate)}`;

  return `
    <nav class="tabs" aria-label="Admin sections">
      <a class="${activeView === 'day' ? 'active' : ''}" href="${dayHref}">День</a>
      <a class="${activeView === 'requests' ? 'active' : ''}" href="${requestsHref}">Заявки</a>
      <a class="${activeView === 'lines' ? 'active' : ''}" href="${linesHref}">Линии</a>
      <a class="${activeView === 'catalog' ? 'active' : ''}" href="${catalogHref}">Справочники</a>
      <a class="${activeView === 'audit' ? 'active' : ''}" href="${auditHref}">Журнал</a>
      <a class="${activeView === 'places' ? 'active' : ''}" href="${placesHref}">Места</a>
    </nav>
  `;
}

module.exports = {
  renderTabs
};
