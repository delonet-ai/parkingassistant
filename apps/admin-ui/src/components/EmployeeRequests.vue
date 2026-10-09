<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViInput, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { queueColors, queueLabel, requestColors, requestLabel } from '../statuses'
import { state, submit } from '../store'

const HEADERS = [
  { text: 'Сотрудник' },
  { text: 'Подразделение' },
  { text: 'Статус' },
  { text: 'Очередь' },
  { text: 'Комментарий' },
  { text: 'Действие' }
]

const userId = ref(null)
const notes = ref('')
const busy = ref(false)

const employeeOptions = computed(() =>
  state.employees.map((employee) => ({
    value: employee.id,
    text: [employee.displayName, employee.department || null].filter(Boolean).join(' · ')
  }))
)

const rows = computed(() =>
  state.employeeRequests.map((request) => [
    { text: request.user?.displayName || '—' },
    { text: request.user?.department || '—' },
    { requestStatus: request.status },
    // Position comes from the queue entry, which is absent until the request is queued.
    request.queueEntry
      ? { queueStatus: request.queueEntry.status, position: request.queueEntry.position }
      : { text: '—' },
    { text: request.notes || '—' },
    ['active', 'queued'].includes(request.status)
      ? { cancelRequestId: request.id }
      : { text: '—' }
  ])
)

async function run(action) {
  busy.value = true
  try {
    await action()
  } finally {
    busy.value = false
  }
}

const create = () =>
  run(async () => {
    await submit(
      '/admin/employee-parking-requests',
      { userId: userId.value, requestDate: state.date, notes: notes.value || null },
      'Заявка сотрудника создана.'
    )
    userId.value = null
    notes.value = ''
  })

const cancel = (requestId) =>
  run(() => submit('/admin/employee-parking-requests/cancel', { requestId }, 'Заявка отменена.'))
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViSelect
        :value="userId"
        :options="employeeOptions"
        label="Сотрудник"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        has-search
        clearable
        @update:value="userId = $event"
      />
      <ViInput v-model:value="notes" label="Комментарий" label-type="static" clearable />
      <ViButton color="primary" :loading="busy" :disabled="!userId" @click="create">
        Подать заявку на {{ state.date }}
      </ViButton>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows">
        <template #cell="{ cell }">
          <ViNameplate v-if="cell.requestStatus" size="small" v-bind="requestColors(cell.requestStatus)">
            {{ requestLabel(cell.requestStatus) }}
          </ViNameplate>

          <span v-else-if="cell.queueStatus" class="queue-cell">
            <ViText tag="span" variant="body-S-wide">№{{ cell.position }}</ViText>
            <ViNameplate size="small" v-bind="queueColors(cell.queueStatus)">
              {{ queueLabel(cell.queueStatus) }}
            </ViNameplate>
          </span>

          <ViButton
            v-else-if="cell.cancelRequestId"
            size="small"
            variant="outlined"
            color="secondary"
            :loading="busy"
            @click="cancel(cell.cancelRequestId)"
          >
            Отменить
          </ViButton>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      На эту дату заявок сотрудников нет.
    </ViText>
  </div>
</template>
