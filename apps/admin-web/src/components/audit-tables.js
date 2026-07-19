'use strict';

// Audit and contact-access journals.

const { escapeHtml } = require('../../../../packages/shared/html');
const { formatDateTime, renderJsonPreview } = require('./format');

function renderAuditLogsTable(auditLogs) {
  if (!auditLogs.length) {
    return '<p class="empty">Записей журнала по выбранным фильтрам нет.</p>';
  }

  const rows = auditLogs
    .map((log) => {
      const actor = log.actorUser?.displayName || log.actorAuthUser?.login || log.actorService || 'system';

      return `
        <tr>
          <td>${escapeHtml(formatDateTime(log.occurredAt))}</td>
          <td>${escapeHtml(log.entityType)}</td>
          <td>${log.entityId ? escapeHtml(log.entityId) : '—'}</td>
          <td>${escapeHtml(log.action)}</td>
          <td>${escapeHtml(actor)}</td>
          <td>${renderJsonPreview(log.metadata)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Время</th>
          <th>Сущность</th>
          <th>ID</th>
          <th>Действие</th>
          <th>Актор</th>
          <th>Metadata</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderContactAccessLogsTable(logs) {
  if (!logs.length) {
    return '<p class="empty">Запросов контактов по выбранной дате нет.</p>';
  }

  const rows = logs
    .map((log) => {
      const target = log.targetUser
        ? `${log.targetUser.displayName} · ${log.targetUser.phone || 'телефон не указан'}`
        : log.targetGuestParkingRequest
          ? `Гость: ${log.targetGuestParkingRequest.guestName}; контакт через администратора`
          : '—';

      return `
        <tr>
          <td>${escapeHtml(formatDateTime(log.createdAt))}</td>
          <td>${escapeHtml(log.requester.displayName)}</td>
          <td>${log.lineGroup ? escapeHtml(log.lineGroup.code) : '—'}</td>
          <td>${escapeHtml(target)}</td>
          <td>${escapeHtml(log.resolution)}</td>
          <td>${renderJsonPreview(log.metadata)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <table>
      <thead>
        <tr>
          <th>Время</th>
          <th>Кто запросил</th>
          <th>Линия</th>
          <th>Цель</th>
          <th>Результат</th>
          <th>Metadata</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

module.exports = {
  renderAuditLogsTable,
  renderContactAccessLogsTable
};
