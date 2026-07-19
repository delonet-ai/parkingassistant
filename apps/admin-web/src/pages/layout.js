'use strict';

// The page shell: <head>, the stylesheet every tab shares, the tab strip, and the
// dispatch into the active tab's renderer.

const { escapeHtml } = require('../../../../packages/shared/html');
const { renderActiveTab } = require('./registry');
const { todayIsoDate } = require('../components/format');
const { renderTabs } = require('../components/tabs');
const { renderModules } = require('./index');

function renderPage(model) {
  const placesCount = Array.isArray(model.places?.data?.places) ? model.places.data.places.length : 0;
  const selectedDate = model.selectedDate || todayIsoDate();
  const activeView = model.activeView || 'day';
  const bootstrap = model.bootstrap?.data?.bootstrapUser;
  const bootstrapState = bootstrap
    ? `${bootstrap.login} (${bootstrap.authStatus})`
    : 'не найден';
  const notice = model.notice
    ? `<p class="notice ${model.notice.type === 'error' ? 'notice-error' : 'notice-ok'}">${escapeHtml(model.notice.text)}</p>`
    : '';

  const mainContent = renderActiveTab(renderModules, activeView, model);

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Parking Assistant Admin</title>
    <style>
      :root {
        --bg: #f4efe7;
        --card: #fffaf2;
        --line: #d8cfc0;
        --text: #1f2328;
        --muted: #6c706f;
        --accent: #1f6f78;
        --accent-soft: #d8eeef;
        --danger: #9f3a2a;
        --ok: #2f6846;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        color: var(--text);
        background:
          radial-gradient(circle at top left, rgba(31,111,120,0.08), transparent 28%),
          linear-gradient(180deg, #f8f2e8 0%, var(--bg) 100%);
      }

      main {
        max-width: 1180px;
        margin: 0 auto;
        padding: 32px 20px 48px;
      }

      h1 {
        margin: 0 0 10px;
        font-size: clamp(34px, 5vw, 56px);
        line-height: 0.95;
      }

      .subhead {
        margin: 0 0 26px;
        color: var(--muted);
        font-size: 18px;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        margin-bottom: 24px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 8px 30px rgba(31, 35, 40, 0.06);
      }

      h3 {
        margin: 24px 0 12px;
        font-size: 20px;
      }

      .label {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }

      .value {
        margin: 0;
        font-size: 28px;
      }

      .status-ok {
        color: var(--accent);
      }

      .status-error {
        color: var(--danger);
      }

      .section-title {
        margin: 0 0 16px;
        font-size: 26px;
      }

      .section-copy {
        margin: -8px 0 18px;
        color: var(--muted);
      }

      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 0 0 22px;
      }

      .tabs a {
        display: inline-flex;
        align-items: center;
        min-height: 42px;
        padding: 10px 16px;
        border: 1px solid var(--line);
        border-radius: 999px;
        color: var(--text);
        background: rgba(255, 250, 242, 0.74);
        text-decoration: none;
      }

      .tabs a.active {
        border-color: var(--accent);
        color: #fff;
        background: var(--accent);
      }

      .notice {
        margin: 0 0 18px;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: #fff;
      }

      .notice-ok {
        color: var(--ok);
      }

      .notice-error {
        color: var(--danger);
      }

      .action-form,
      .date-form {
        display: grid;
        grid-template-columns: minmax(240px, 2fr) repeat(2, minmax(150px, 1fr));
        gap: 14px;
        align-items: end;
        margin-bottom: 22px;
      }

      .date-form {
        grid-template-columns: minmax(220px, 320px) 180px;
      }

      .action-form label,
      .date-form label {
        display: grid;
        gap: 7px;
      }

      .action-form label.wide {
        grid-column: span 2;
      }

      .action-form span,
      .date-form span {
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      select,
      input,
      button {
        width: 100%;
        min-height: 43px;
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 10px 12px;
        font: inherit;
        background: #fff;
      }

      button {
        border-color: var(--accent);
        color: #fff;
        background: var(--accent);
        cursor: pointer;
      }

      .button-secondary {
        min-height: 34px;
        padding: 7px 10px;
        border-color: var(--line);
        color: var(--danger);
        background: #fff;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.48;
      }

      .inline-action-form {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: center;
        margin: 0 0 16px;
      }

      .inline-action-form button {
        width: auto;
      }

      .inline-action-form span {
        color: var(--muted);
      }

      option:disabled {
        color: var(--muted);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        padding: 14px 10px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
        text-align: left;
      }

      th {
        font-size: 13px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--muted);
      }

      .tag {
        display: inline-block;
        margin: 0 8px 8px 0;
        padding: 6px 10px;
        border-radius: 999px;
        background: var(--accent-soft);
        font-size: 13px;
      }

      .tag.free {
        background: #dcefd7;
      }

      .tag.reserved {
        background: #ead8c4;
      }

      .mini-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 8px;
      }

      .mini-grid article {
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.44);
      }

      .operational-layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(320px, 380px);
        gap: 18px;
        align-items: start;
      }

      .operational-places {
        min-width: 0;
      }

      .place-drawer {
        position: sticky;
        top: 16px;
      }

      .place-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
        margin: 0 0 14px;
      }

      .place-floor-plan {
        display: block;
        width: 100%;
        height: auto;
        background: #fff;
      }

      .place-floor {
        margin: 18px 0 0;
      }

      .place-floor-title {
        margin: 0 0 10px;
      }

      .place-line-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 14px;
      }

      .place-line {
        display: grid;
        gap: 8px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #fff;
      }

      .place-line-head {
        display: flex;
        justify-content: space-between;
        gap: 10px;
        align-items: center;
      }

      .place-line-head h4 {
        margin: 0;
        font-size: 16px;
      }

      .place-line-slots {
        display: grid;
        gap: 6px;
      }

      .place-slot-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: center;
      }

      .place-slot {
        display: grid;
        grid-template-columns: auto auto 1fr auto;
        gap: 8px;
        width: 100%;
        min-height: 44px;
        align-items: center;
        padding: 8px 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--text);
        font: inherit;
        text-align: left;
        cursor: pointer;
      }

      .place-slot-code {
        font-weight: 700;
      }

      .place-slot-position,
      .place-slot-owner {
        color: var(--muted);
        font-size: 13px;
      }

      .place-slot-status {
        font-size: 13px;
      }

      .place-slot--selected {
        outline: 3px solid #000;
        outline-offset: 1px;
      }

      /* The six status colours carried over verbatim from the retired map legend.
         Colour never carries the meaning alone — every slot prints the status word. */
      .place-slot--free {
        background: #dcefd7;
      }

      .place-slot--released {
        background: #d8eeef;
      }

      .place-slot--occupied,
      .place-slot--guest {
        background: #ead8c4;
      }

      .place-slot--rotatable {
        background: #efc5bd;
      }

      .place-slot--blocked {
        color: #fff;
        background: #4b4f52;
      }

      .place-slot-role select {
        min-width: 150px;
      }

      .place-slot-field-grid {
        display: grid;
        gap: 12px;
      }

      .place-slot-fields[hidden] {
        display: none;
      }

      .place-slot-fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
      }

      .place-slot-fields label {
        display: grid;
        gap: 6px;
      }

      dialog menu {
        display: flex;
        gap: 10px;
        justify-content: flex-end;
        margin: 14px 0 0;
        padding: 0;
      }

      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
      }

      .map-card {
        display: grid;
        gap: 12px;
      }

      .map-card-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }

      .map-card h3,
      .map-card p {
        margin: 0;
      }

      .map-card p {
        color: var(--muted);
      }

      .map-floor-form {
        display: grid;
        grid-template-columns: repeat(3, minmax(120px, 1fr));
        gap: 10px;
        min-width: min(100%, 440px);
      }

      .map-floor-form label {
        display: grid;
        gap: 7px;
      }

      .map-floor-form span {
        color: var(--muted);
        font-size: 13px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }

      .map-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0 0 14px;
      }

      .map-upload-panel,
      .map-diagnostic {
        margin: 0 0 16px;
        padding: 14px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.4);
      }

      .map-upload-grid,
      .map-diagnostics {
        display: grid;
        gap: 12px;
      }

      .map-upload-grid {
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      }

      .map-upload-form {
        display: grid;
        gap: 10px;
        padding: 12px;
        border: 1px dashed var(--line);
        border-radius: 8px;
        background: #fff;
      }

      .map-upload-form label {
        display: grid;
        gap: 6px;
      }

      .map-upload-form strong,
      .map-upload-form .muted {
        display: block;
      }

      .map-upload-form .muted {
        margin-top: 4px;
        overflow-wrap: anywhere;
      }

      .map-workspace {
        width: 100%;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
      }

      .place-status-free {
        background: #dcefd7;
      }

      .place-status-released {
        background: #d8eeef;
      }

      .place-status-occupied,
      .place-status-guest {
        background: #ead8c4;
      }

      .place-status-rotatable {
        background: #efc5bd;
      }

      .place-status-blocked {
        color: #fff;
        background: #4b4f52;
      }

      .empty {
        margin: 0;
        color: var(--muted);
      }

      .history-head {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: start;
      }

      .compact-form {
        grid-template-columns: 1fr;
      }

      code {
        display: block;
        max-width: 420px;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12px;
      }

      @media (max-width: 760px) {
        .action-form,
        .date-form,
        .map-floor-form,
        .operational-layout,
        .action-form label.wide {
          display: grid;
          grid-template-columns: 1fr;
          grid-column: auto;
        }

        .place-drawer {
          position: static;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Parking Assistant</h1>
      <p class="subhead">Минимальная админка для проверки backend, каталога мест и bootstrap-состояния системы.</p>
      ${renderTabs(activeView, selectedDate)}
      ${notice}

      <section class="grid">
        <article class="card">
          <p class="label">API Health</p>
          <p class="value ${model.health.ok ? 'status-ok' : 'status-error'}">${escapeHtml(model.health.data?.status || 'error')}</p>
        </article>
        <article class="card">
          <p class="label">DB Health</p>
          <p class="value ${model.db.ok ? 'status-ok' : 'status-error'}">${escapeHtml(model.db.data?.status || 'error')}</p>
        </article>
        <article class="card">
          <p class="label">Bootstrap Admin</p>
          <p class="value">${escapeHtml(bootstrapState)}</p>
        </article>
        <article class="card">
          <p class="label">Places In Catalog</p>
          <p class="value">${escapeHtml(placesCount)}</p>
        </article>
      </section>

      ${mainContent}
    </main>
  </body>
</html>`;
}

module.exports = {
  renderPage
};
