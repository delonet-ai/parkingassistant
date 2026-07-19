'use strict';

// The date picker every tab carries.

const { escapeHtml } = require('../../../../packages/shared/html');

function renderDateSelector(selectedDate, view = 'day', extraHidden = '') {
  return `
    <form class="date-form" method="get" action="/">
      <input type="hidden" name="view" value="${escapeHtml(view)}" />
      ${extraHidden}
      <label>
        <span>Операционный день</span>
        <input type="date" name="date" value="${escapeHtml(selectedDate)}" required />
      </label>
      <button type="submit">Показать день</button>
    </form>
  `;
}

module.exports = {
  renderDateSelector
};
