<script setup>
import { computed, ref, watch } from 'vue'
import { ViInput, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { state, reloadAudit } from '../store'

const HEADERS = [
  { text: 'Когда' },
  { text: 'Действие' },
  { text: 'Сущность' },
  { text: 'Кто' },
  { text: 'Подробности' }
]

// The entity types the API actually writes. Anything new shows up as itself rather than being
// filtered out of existence.
const ENTITY_OPTIONS = [
  { value: '', text: 'все сущности' },
  { value: 'parking_place', text: 'место' },
  { value: 'line_group', text: 'линия' },
  { value: 'reservation', text: 'назначение' },
  { value: 'place_release', text: 'отдача' },
  { value: 'permanent_assignment', text: 'закрепление' },
  { value: 'employee_parking_request', text: 'заявка сотрудника' },
  { value: 'guest_parking_request', text: 'гостевая заявка' },
  { value: 'queue_entry', text: 'очередь' },
  { value: 'departure_plan', text: 'план выезда' },
  { value: 'line_occupancy', text: 'позиция в линии' },
  { value: 'user', text: 'сотрудник' }
]

const action = ref(state.auditFilters.action)
let timer = null

// The action filter is a LIKE on the server, so it is debounced rather than fired per keypress.
watch(action, (value) => {
  clearTimeout(timer)
  timer = setTimeout(() => reloadAudit({ action: value }), 350)
})

function formatMoment(value) {
  return String(value || '').slice(0, 19).replace('T', ' ')
}

function describe(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return '—'
  }

  const parts = Object.entries(metadata)
    .filter(([key]) => key !== 'seed')
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)

  return parts.length ? parts.join(' · ') : '—'
}

const rows = computed(() =>
  state.auditLogs.map((entry) => [
    { text: formatMoment(entry.occurredAt) },
    { action: entry.action },
    { text: (ENTITY_OPTIONS.find((option) => option.value === entry.entityType) || {}).text || entry.entityType || '—' },
    {
      text:
        entry.actorUser?.displayName ||
        entry.actorAuthUser?.login ||
        entry.actorService ||
        '—'
    },
    { text: describe(entry.metadata) }
  ])
)
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViSelect
        :value="state.auditFilters.entityType"
        :options="ENTITY_OPTIONS"
        label="Сущность"
        label-type="static"
        text-field-name="text"
        value-field-name="value"
        track-by-value
        @update:value="reloadAudit({ entityType: $event || '' })"
      />
      <ViInput
        v-model:value="action"
        label="Действие"
        label-type="static"
        placeholder="reservation_created"
        clearable
      />
      <ViText tag="span" variant="body-XS-wide" class="muted">
        Показано {{ state.auditLogs.length }} записей за {{ state.date }}.
      </ViText>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows" table-max-height="560px">
        <template #cell="{ cell }">
          <ViNameplate
            v-if="cell.action"
            size="small"
            background-color="var(--vi-color-blue-200)"
            text-color="var(--vi-color-blue-900)"
          >
            {{ cell.action }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      Записей с такими фильтрами нет.
    </ViText>
  </div>
</template>
