<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViNameplate, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { state, submit } from '../store'

// The five scheduled jobs, with the times the scheduler runs them. Running one by hand is the
// same endpoint the scheduler calls — nothing here reimplements what a job does.
const JOBS = [
  { name: 'lock_departure_plans', path: 'lock-departure-plans', title: 'Блокировка времени выезда', at: '07:00' },
  { name: 'process_queue', path: 'process-queue', title: 'Обработка очереди', at: '08:00' },
  { name: 'rebuild_conflicts', path: 'rebuild-conflicts', title: 'Пересчёт конфликтов', at: '08:05' },
  { name: 'freeze_next_day', path: 'freeze-next-day', title: 'Фиксация следующего дня', at: '19:00' },
  { name: 'unlock_employee_pool', path: 'unlock-employee-pool', title: 'Открытие пула сотрудникам', at: '19:00' }
]

const RUN_HEADERS = [{ text: 'Задача' }, { text: 'Дата' }, { text: 'Состояние' }, { text: 'Начата' }, { text: 'Итог' }]

const busy = ref(null)

function formatMoment(value) {
  return String(value || '').slice(0, 19).replace('T', ' ')
}

function formatDate(value) {
  return String(value || '').slice(0, 10)
}

const latestByName = computed(() => {
  const map = new Map()

  for (const run of state.jobRuns.latestSuccessfulRuns || []) {
    map.set(run.jobName, run)
  }

  return map
})

const runRows = computed(() =>
  (state.jobRuns.runs || []).map((run) => [
    { text: (JOBS.find((job) => job.name === run.jobName) || {}).title || run.jobName },
    { text: formatDate(run.targetDate) },
    { runStatus: run.status },
    { text: formatMoment(run.startedAt) },
    { text: run.error || run.summary || '—' }
  ])
)

async function run(job) {
  busy.value = job.name
  try {
    await submit(`/admin/jobs/${job.path}`, { date: state.date }, `${job.title}: выполнено.`)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="stack">
    <div class="jobs-grid">
      <div v-for="job in JOBS" :key="job.name" class="job-tile">
        <ViText tag="p" variant="body-Sm-wide">{{ job.title }}</ViText>
        <ViText tag="p" variant="body-XS-wide" class="muted">
          По расписанию в {{ job.at }} ·
          <template v-if="latestByName.get(job.name)">
            успешно {{ formatMoment(latestByName.get(job.name).finishedAt) }}
          </template>
          <template v-else>успешных запусков нет</template>
        </ViText>
        <ViButton
          size="small"
          variant="outlined"
          color="secondary"
          :loading="busy === job.name"
          @click="run(job)"
        >
          Запустить на {{ state.date }}
        </ViButton>
      </div>
    </div>

    <ViText tag="h4" variant="title-h6" class="section-gap">Последние запуски</ViText>

    <div v-if="runRows.length" class="table-scroll">
      <ViTableSimple :headers="RUN_HEADERS" :rows="runRows" table-max-height="420px">
        <template #cell="{ cell }">
          <ViNameplate
            v-if="cell.runStatus"
            size="small"
            :background-color="cell.runStatus === 'success' ? 'var(--vi-color-green-200)' : 'var(--vi-color-red-200)'"
            :text-color="cell.runStatus === 'success' ? 'var(--vi-color-green-900)' : 'var(--vi-color-red-900)'"
          >
            {{ cell.runStatus === 'success' ? 'успешно' : 'ошибка' }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">Запусков ещё не было.</ViText>
  </div>
</template>
