'use strict';

// Журнал — jobs, audit log and contact access.

const { escapeHtml } = require('../../../../packages/shared/html');
const { todayIsoDate } = require('../components/format');
const { renderJobsPanel } = require('../components/jobs-panel');
const { renderAuditLogsTable, renderContactAccessLogsTable } = require('../components/audit-tables');

function renderAuditTab(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const auditLogs = model.auditLogs?.data?.auditLogs || [];
  const contactAccessLogs = model.contactAccessLogs?.data?.contactAccessLogs || [];

  return `
    <section class="card">
      <h2 class="section-title">Audit Log</h2>
      <p class="section-copy">Фильтр по дате, сущности и действию. Пустые поля не применяются.</p>
      <form class="action-form" method="get" action="/">
        <input type="hidden" name="view" value="audit" />
        <label>
          <span>Дата</span>
          <input type="date" name="date" value="${escapeHtml(selectedDate)}" required />
        </label>
        <label>
          <span>Сущность</span>
          <input name="entityType" value="${escapeHtml(model.auditFilters?.entityType || '')}" placeholder="reservation, user..." />
        </label>
        <label>
          <span>Действие</span>
          <input name="action" value="${escapeHtml(model.auditFilters?.action || '')}" placeholder="created, canceled..." />
        </label>
        <label>
          <span>Актор</span>
          <input name="actor" value="${escapeHtml(model.auditFilters?.actor || '')}" placeholder="admin-web, login, ФИО..." />
        </label>
        <button type="submit">Показать</button>
      </form>
      ${renderAuditLogsTable(auditLogs)}
    </section>

    <section class="card">
      <h2 class="section-title">Contact Access Logs</h2>
      <p class="section-copy">Все запросы контактов тех, кто стоит впереди в multi-линии.</p>
      ${renderContactAccessLogsTable(contactAccessLogs)}
    </section>

    <section class="card">
      <h2 class="section-title">Jobs и регламент</h2>
      <p class="section-copy">Ручной запуск ежедневных регламентных задач и последние результаты.</p>
      ${renderJobsPanel(model)}
    </section>
  `;
}

module.exports = {
  renderAuditTab
};
