<script setup>
import { computed, ref } from 'vue'
import { ViAlert, ViButton, ViInput, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { digitsToTime } from '../time'
import { state, submit } from '../store'

const HEADERS = [
  { text: 'Сотрудник' },
  { text: 'Линия' },
  { text: 'Позиция' },
  { text: 'Время выезда' },
  { text: 'Ранний' }
]

const userId = ref(null)
const departureTime = ref('')
const busy = ref(false)

// The field emits digits only; this is the value the API is given.
const normalizedTime = computed(() => digitsToTime(departureTime.value))

const employeeOptions = computed(() =>
  state.employees.map((employee) => ({
    value: employee.id,
    text: [employee.displayName, employee.department || null].filter(Boolean).join(' · ')
  }))
)

const rows = computed(() =>
  state.departurePlans.map((plan) => [
    { text: plan.user?.displayName || '—' },
    { text: plan.lineOccupancy?.lineGroup?.name || plan.lineOccupancy?.lineGroup?.code || '—' },
    { text: plan.lineOccupancy?.position ? `№${plan.lineOccupancy.position}` : '—' },
    { text: plan.departureTime || '—' },
    { early: plan.isEarly }
  ])
)

const conflicts = computed(() => state.conflicts)

async function save() {
  busy.value = true
  try {
    // Editing the current day closes at 07:00 and the API answers 409. That message is the
    // operator's answer; the UI does not pre-judge the cut-off, which would be a second
    // place where the rule lives.
    await submit(
      '/admin/departure-plans',
      { userId: userId.value, planDate: state.date, departureTime: normalizedTime.value },
      'Плановое время выезда сохранено.'
    )
    departureTime.value = ''
  } finally {
    busy.value = false
  }
}
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
      <ViInput
        v-model:value="departureTime"
        label="Время выезда"
        label-type="static"
        placeholder="18:30"
        mask="##:##"
      />
      <ViButton
        color="primary"
        :loading="busy"
        :disabled="!userId || !normalizedTime"
        @click="save"
      >
        Сохранить на {{ state.date }}
      </ViButton>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows">
        <template #cell="{ cell }">
          <ViNameplate
            v-if="cell.early !== undefined"
            size="small"
            :background-color="cell.early ? 'var(--vi-color-orange-200)' : 'var(--vi-color-gray-200)'"
            :text-color="cell.early ? 'var(--vi-color-orange-900)' : 'var(--vi-color-gray-900)'"
          >
            {{ cell.early ? 'ранний выезд' : 'обычный' }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      На выбранную дату планов выезда нет.
    </ViText>

    <ViText tag="h4" variant="title-h6" class="section-gap">Конфликты</ViText>

    <ViAlert
      v-for="(conflict, index) in conflicts"
      :key="index"
      :type="conflict.severity === 'warning' ? 'warning' : 'info'"
      :title="conflict.lineGroup?.name || conflict.lineGroup?.code || 'Линия'"
    >
      {{ conflict.earlyDeparture?.user?.displayName || 'Сотрудник' }} уезжает в
      {{ conflict.earlyDeparture?.departureTime }} с места
      {{ conflict.earlyDeparture?.parkingPlaceCode }} (позиция №{{ conflict.earlyDeparture?.position }}),
      а впереди на позиции №{{ conflict.blocker?.position }} стоит
      {{
        conflict.blocker?.subjectType === 'guest'
          ? `гость ${conflict.blocker?.guestParkingRequest?.guestName || ''}`
          : conflict.blocker?.user?.displayName || '—'
      }}
      (место {{ conflict.blocker?.parkingPlaceCode }}).
    </ViAlert>

    <ViText v-if="!conflicts.length" tag="p" variant="body-S-wide" class="muted">
      Конфликтов по ранним выездам на эту дату нет.
    </ViText>
  </div>
</template>
