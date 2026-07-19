'use strict';

// Журнал: the five scheduled jobs and their run history.

const { escapeHtml } = require('../../../../packages/shared/html');
const { formatDate, renderJsonPreview, todayIsoDate } = require('./format');

function renderJobsPanel(model) {
  const selectedDate = model.selectedDate || todayIsoDate();
  const runs = model.jobRuns?.data?.runs || [];
  const latestSuccessfulRuns = model.jobRuns?.data?.latestSuccessfulRuns || [];
  const latestRows = latestSuccessfulRuns
    .map(
      (run) => `
        <tr>
          <td>${escapeHtml(run.jobName)}</td>
          <td>${run.targetDate ? escapeHtml(formatDate(run.targetDate)) : '—'}</td>
          <td>${run.finishedAt ? escapeHtml(new Date(run.finishedAt).toLocaleString('ru-RU')) : '—'}</td>
          <td>${renderJsonPreview(run.summary)}</td>
        </tr>
      `
    )
    .join('');
  const rows = runs
    .map(
      (run) => `
        <tr>
          <td>${escapeHtml(run.jobName)}</td>
          <td>${run.targetDate ? escapeHtml(formatDate(run.targetDate)) : '—'}</td>
          <td><span class="tag ${run.status === 'success' ? 'free' : run.status === 'failed' ? 'reserved' : ''}">${escapeHtml(run.status)}</span></td>
          <td>${run.startedAt ? escapeHtml(new Date(run.startedAt).toLocaleString('ru-RU')) : '—'}</td>
          <td>${run.finishedAt ? escapeHtml(new Date(run.finishedAt).toLocaleString('ru-RU')) : '—'}</td>
          <td>${run.error ? escapeHtml(run.error) : '—'}</td>
        </tr>
      `
    )
    .join('');

  return `
    <div class="jobs-actions">
      <form class="inline-action-form" method="post" action="/admin/jobs/lock-departure-plans">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job 07:00: закрыть выезды</button>
        <span>Проставляет <code>locked_at</code>: планы выезда на дату больше не редактируются</span>
      </form>
      <form class="inline-action-form" method="post" action="/admin/jobs/process-queue">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job 08:00: обработать очередь</button>
        <span>Раздаёт освобождённые места из очереди с учётом гостевого резерва</span>
      </form>
      <form class="inline-action-form" method="post" action="/admin/jobs/rebuild-conflicts">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job 08:05: пересчитать конфликты</button>
        <span>Чинит <code>is_early</code> по правилу отсечки и пересобирает набор конфликтов</span>
      </form>
      <form class="inline-action-form" method="post" action="/admin/jobs/freeze-next-day">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job 19:00: заморозить день</button>
        <span>Проставляет <code>frozen_at</code>: отдачу на дату больше нельзя отозвать</span>
      </form>
      <form class="inline-action-form" method="post" action="/admin/jobs/unlock-employee-pool">
        <input type="hidden" name="date" value="${escapeHtml(selectedDate)}" />
        <button type="submit">Job 19:00: открыть пул сотрудников</button>
        <span>Считает, сколько мест достанется сотрудникам: всё освобождённое минус гостевой резерв</span>
      </form>
    </div>
    <h4>Последний успешный запуск</h4>
    ${
      latestRows
        ? `<table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Дата</th>
                <th>Успешно завершен</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>${latestRows}</tbody>
          </table>`
        : '<p class="empty">Успешных запусков jobs пока нет.</p>'
    }
    <h4>Последние запуски</h4>
    ${
      rows
        ? `<table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Дата</th>
                <th>Статус</th>
                <th>Старт</th>
                <th>Финиш</th>
                <th>Ошибка</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`
        : '<p class="empty">Запусков jobs пока нет.</p>'
    }
  `;
}

module.exports = {
  renderJobsPanel
};
