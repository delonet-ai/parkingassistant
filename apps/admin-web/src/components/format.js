'use strict';

// Value formatters shared by every tab. Pure: a value in, a string out.

const { escapeHtml } = require('../../../../packages/shared/html');
const { currentDateInTimezone } = require('../../../../packages/shared/dates');
const { appTimezone } = require('../config');

function formatDate(value) {
  if (!value) {
    return '';
  }

  return String(value).slice(0, 10);
}

function formatDateTime(value) {
  if (!value) {
    return '—';
  }

  return new Date(value).toLocaleString('ru-RU');
}

function renderJsonPreview(value) {
  if (!value || (typeof value === 'object' && !Object.keys(value).length)) {
    return '—';
  }

  return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
}

// Every parking rule runs in APP_TIMEZONE, so the UI's default date has to as well.
// Deriving it in UTC made the whole admin UI default to *yesterday* between 21:00 and
// 24:00 UTC — the Moscow small hours — while the API answered for the real today.
function todayIsoDate() {
  return currentDateInTimezone(appTimezone);
}

module.exports = {
  formatDate,
  formatDateTime,
  renderJsonPreview,
  todayIsoDate
};
