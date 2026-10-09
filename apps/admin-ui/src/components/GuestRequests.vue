<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViInput, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { requestColors, requestLabel } from '../statuses'
import { state, submit } from '../store'

const HEADERS = [
  { text: 'Гость' },
  { text: 'Телефон' },
  { text: 'Авто' },
  { text: 'Приглашающий' },
  { text: 'Статус' },
  { text: 'Место' },
  { text: 'Действие' }
]

const form = ref({ hostUserId: null, guestName: '', guestPhone: '', vehiclePlateNumber: '' })
const busy = ref(false)

const hostOptions = computed(() =>
  state.employees.map((employee) => ({ value: employee.id, text: employee.displayName }))
)

const rows = computed(() =>
  state.guestRequests.map((request) => [
    { text: request.guestName || request.guest?.displayName || '—' },
    { text: request.guestPhone || '—' },
    { text: request.vehiclePlateNumber || '—' },
    { text: request.host?.displayName || '—' },
    { requestStatus: request.status },
    { text: request.assignedReservation?.parkingPlace?.code || '—' },
    // A guest already holding a place can only be cancelled; one still waiting can be given
    // a place by the backend, which picks it by the single → double → triple rule.
    request.status === 'active'
      ? { assignRequestId: request.id }
      : request.status === 'assigned'
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
      '/admin/guest-parking-requests',
      { ...form.value, requestDate: state.date },
      'Гостевая заявка создана.'
    )
    form.value = { hostUserId: null, guestName: '', guestPhone: '', vehiclePlateNumber: '' }
  })

const assign = (requestId) =>
  run(() => submit('/admin/guest-parking-requests/assign', { requestId }, 'Гостю назначено место.'))

const cancel = (requestId) =>
  run(() => submit('/admin/guest-parking-requests/cancel', { requestId }, 'Гостевая заявка отменена.'))
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViSelect
        :value="form.hostUserId"
        :options="hostOptions"
        label="Приглашающий"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        has-search
        clearable
        @update:value="form.hostUserId = $event"
      />
      <ViInput v-model:value="form.guestName" label="Гость" label-type="static" required />
      <ViInput v-model:value="form.guestPhone" label="Телефон" label-type="static" />
      <ViInput v-model:value="form.vehiclePlateNumber" label="Авто" label-type="static" />
      <ViButton
        color="primary"
        :loading="busy"
        :disabled="!form.hostUserId || !form.guestName"
        @click="create"
      >
        Создать гостя
      </ViButton>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows">
        <template #cell="{ cell }">
          <ViNameplate v-if="cell.requestStatus" size="small" v-bind="requestColors(cell.requestStatus)">
            {{ requestLabel(cell.requestStatus) }}
          </ViNameplate>

          <ViButton
            v-else-if="cell.assignRequestId"
            size="small"
            color="primary"
            :loading="busy"
            @click="assign(cell.assignRequestId)"
          >
            Назначить место
          </ViButton>

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
      На эту дату гостевых заявок нет.
    </ViText>
  </div>
</template>
