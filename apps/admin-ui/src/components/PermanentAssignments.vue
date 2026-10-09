<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViChip, ViInput, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { setAssignmentFilter, state, submit } from '../store'

const HEADERS = [
  { text: 'Сотрудник' },
  { text: 'Место' },
  { text: 'С' },
  { text: 'По' },
  { text: 'Состояние' },
  { text: 'Комментарий' },
  { text: 'Действие' }
]

const STATUS_FILTERS = [
  { value: 'all', text: 'все' },
  { value: 'active', text: 'активные' },
  { value: 'future', text: 'будущие' },
  { value: 'ended', text: 'завершённые' }
]

const STATUS_LABELS = {
  active: { label: 'активно', group: 'green' },
  future: { label: 'будущее', group: 'blue' },
  ended: { label: 'завершено', group: 'gray' }
}

const draft = ref({ userId: null, parkingPlaceId: null, dateFrom: '', notes: '' })
const busy = ref(false)

const employeeOptions = computed(() =>
  state.employees.map((employee) => ({
    value: employee.id,
    text: [employee.displayName, employee.department || null].filter(Boolean).join(' · ')
  }))
)

const placeOptions = computed(() =>
  state.places.map((place) => ({
    value: place.id,
    text: `${place.code}${place.permanentOwner ? ` · занято: ${place.permanentOwner.displayName}` : ''}`
  }))
)

const rows = computed(() =>
  state.permanentAssignments.map((assignment) => [
    { text: assignment.user?.displayName || '—' },
    { text: assignment.parkingPlace?.code || '—' },
    { text: assignment.dateFrom || '—' },
    { text: assignment.dateTo || 'бессрочно' },
    { assignmentStatus: assignment.status },
    { text: assignment.notes || '—' },
    assignment.status === 'ended' ? { text: '—' } : { endAssignmentId: assignment.id }
  ])
)

function status(value) {
  return STATUS_LABELS[value] || { label: value || '—', group: 'gray' }
}

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
      '/admin/permanent-assignments',
      { ...draft.value, dateFrom: draft.value.dateFrom || state.date },
      'Постоянное закрепление создано.'
    )
    draft.value = { userId: null, parkingPlaceId: null, dateFrom: '', notes: '' }
  })

const end = (assignmentId) =>
  run(() =>
    // The API decides what "ending today" means for a date range; the UI only names the day.
    submit(
      '/admin/permanent-assignments/end',
      { assignmentId, dateTo: state.date },
      'Закрепление завершено.'
    )
  )

async function setFilter(value) {
  await setAssignmentFilter(value)
}
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViSelect
        :value="draft.userId"
        :options="employeeOptions"
        label="Сотрудник"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        has-search
        clearable
        @update:value="draft.userId = $event"
      />
      <ViSelect
        :value="draft.parkingPlaceId"
        :options="placeOptions"
        label="Место"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        has-search
        clearable
        @update:value="draft.parkingPlaceId = $event"
      />
      <ViInput v-model:value="draft.notes" label="Комментарий" label-type="static" clearable />
      <ViButton
        color="primary"
        :loading="busy"
        :disabled="!draft.userId || !draft.parkingPlaceId"
        @click="create"
      >
        Закрепить с {{ state.date }}
      </ViButton>
    </div>

    <div class="filters">
      <ViText tag="span" variant="body-XS-wide" class="muted filters__label">Показать</ViText>
      <ViChip
        v-for="option in STATUS_FILTERS"
        :key="option.value"
        interactive
        :selected="state.assignmentStatusFilter === option.value"
        @click="setFilter(option.value)"
      >
        {{ option.text }}
      </ViChip>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows" table-max-height="420px">
        <template #cell="{ cell }">
          <ViNameplate
            v-if="cell.assignmentStatus"
            size="small"
            :background-color="`var(--vi-color-${status(cell.assignmentStatus).group}-200)`"
            :text-color="`var(--vi-color-${status(cell.assignmentStatus).group}-900)`"
          >
            {{ status(cell.assignmentStatus).label }}
          </ViNameplate>

          <ViButton
            v-else-if="cell.endAssignmentId"
            size="small"
            variant="outlined"
            color="secondary"
            :loading="busy"
            @click="end(cell.endAssignmentId)"
          >
            Завершить
          </ViButton>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      Закреплений с таким фильтром нет.
    </ViText>
  </div>
</template>
