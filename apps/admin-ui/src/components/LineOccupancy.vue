<script setup>
import { computed, ref, watch } from 'vue'
import { ViButton, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { sourceColors, sourceLabel } from '../statuses'
import { state, submit } from '../store'

const HEADERS = [
  { text: 'Линия' },
  { text: 'Позиция' },
  { text: 'Место' },
  { text: 'Кто стоит' },
  { text: 'Контакт / маршрут' },
  { text: 'Источник' }
]

const lineGroupId = ref(null)
const position = ref(null)
const parkingPlaceId = ref(null)
const userId = ref(null)
const busy = ref(false)

const lineOptions = computed(() =>
  state.lineGroups.map((line) => ({
    value: line.id,
    text: `${line.name || line.code} · ${line.capacity} мест`
  }))
)

const selectedLine = computed(() =>
  state.lineGroups.find((line) => line.id === lineGroupId.value) || null
)

// The positions a line has are its capacity, not a fixed 1/2/3: offering a third position on
// a double line would only produce a refusal from the API.
const positionOptions = computed(() => {
  const capacity = selectedLine.value?.capacity || 0

  return Array.from({ length: capacity }, (_, index) => ({
    value: index + 1,
    text: `Позиция ${index + 1}`
  }))
})

const placeOptions = computed(() =>
  (selectedLine.value?.places || []).map((place) => ({ value: place.id, text: place.code }))
)

const employeeOptions = computed(() =>
  state.employees.map((employee) => ({
    value: employee.id,
    text: [employee.displayName, employee.department || null].filter(Boolean).join(' · ')
  }))
)

watch(lineGroupId, () => {
  position.value = null
  parkingPlaceId.value = null
})

const rows = computed(() =>
  state.occupancy.map((item) => [
    { text: item.lineGroup?.name || item.lineGroup?.code || '—' },
    { text: `№${item.position}` },
    { text: item.parkingPlace?.code || '—' },
    {
      text:
        item.subjectType === 'guest'
          ? `Гость: ${item.guestParkingRequest?.guestName || '—'}`
          : item.user?.displayName || '—'
    },
    // A guest in front is not someone an employee may call directly — the route is through
    // the inviting employee, which is why this column says a route and not only a phone.
    {
      text:
        item.subjectType === 'guest'
          ? `Через приглашающего: ${item.guestParkingRequest?.hostDisplayName || 'администратор'}`
          : [item.user?.phone, item.user?.email].filter(Boolean).join(' · ') || 'контакты не указаны'
    },
    item.reservation ? { source: item.reservation.source } : { text: '—' }
  ])
)

async function fix() {
  busy.value = true
  try {
    await submit(
      '/admin/line-occupancy',
      {
        occupancyDate: state.date,
        lineGroupId: lineGroupId.value,
        parkingPlaceId: parkingPlaceId.value,
        position: position.value,
        subjectType: 'employee',
        userId: userId.value
      },
      'Позиция в линии зафиксирована.'
    )
    userId.value = null
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViSelect
        :value="lineGroupId"
        :options="lineOptions"
        label="Линия"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        has-search
        clearable
        @update:value="lineGroupId = $event"
      />
      <ViSelect
        :value="position"
        :options="positionOptions"
        label="Позиция"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        :disabled="!selectedLine"
        @update:value="position = $event"
      />
      <ViSelect
        :value="parkingPlaceId"
        :options="placeOptions"
        label="Место"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        :disabled="!selectedLine"
        @update:value="parkingPlaceId = $event"
      />
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
      <ViButton
        color="primary"
        :loading="busy"
        :disabled="!lineGroupId || !position || !parkingPlaceId || !userId"
        @click="fix"
      >
        Зафиксировать
      </ViButton>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows">
        <template #cell="{ cell }">
          <ViNameplate v-if="cell.source" size="small" v-bind="sourceColors(cell.source)">
            {{ sourceLabel(cell.source) }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      На выбранную дату позиции в линиях ещё не зафиксированы.
    </ViText>
  </div>
</template>
