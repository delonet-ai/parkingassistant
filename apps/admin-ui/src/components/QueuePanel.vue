<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViNameplate, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { queueColors, queueLabel } from '../statuses'
import { state, submit } from '../store'

const HEADERS = [{ text: 'Позиция' }, { text: 'Сотрудник' }, { text: 'Состояние' }, { text: 'Место' }]

const busy = ref(false)

// The queue is a view over the employee requests: a request joins it when it is queued, and
// the entry carries the position and what the run decided about it.
const entries = computed(() =>
  state.employeeRequests
    .filter((request) => request.queueEntry)
    .sort((left, right) => left.queueEntry.position - right.queueEntry.position)
)

const rows = computed(() =>
  entries.value.map((request) => [
    { text: `№${request.queueEntry.position}` },
    { text: request.user?.displayName || '—' },
    { queueStatus: request.queueEntry.status },
    // This endpoint flattens the place to a code; the guest and dashboard endpoints nest a
    // whole parkingPlace object instead. Reading the wrong one silently prints a dash.
    { text: request.assignedReservation?.parkingPlaceCode || '—' }
  ])
)

async function process() {
  busy.value = true
  try {
    // The job is the same one the scheduler runs at 08:00; running it by hand is how the
    // operator serves the queue off-schedule. Counts come back from the API, not from us.
    const result = await submit('/admin/jobs/process-queue', { date: state.date }, 'Очередь обработана.')

    if (result.ok) {
      const assigned = result.data?.assignedCount ?? 0
      const skipped = result.data?.skippedCount ?? 0
      state.notice = {
        type: 'success',
        text: `Очередь обработана: назначено ${assigned}, пропущено ${skipped}.`
      }
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <ViButton color="primary" variant="outlined" :loading="busy" @click="process">
        Обработать очередь на {{ state.date }}
      </ViButton>
      <ViText tag="span" variant="body-XS-wide" class="muted">
        Та же задача, что идёт по расписанию в 08:00. Правила распределения считает backend.
      </ViText>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows">
        <template #cell="{ cell }">
          <ViNameplate v-if="cell.queueStatus" size="small" v-bind="queueColors(cell.queueStatus)">
            {{ queueLabel(cell.queueStatus) }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">Очередь на эту дату пуста.</ViText>
  </div>
</template>
