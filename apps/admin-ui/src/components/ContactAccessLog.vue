<script setup>
import { computed } from 'vue'
import { ViNameplate, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { state } from '../store'

const HEADERS = [
  { text: 'Дата' },
  { text: 'Кто спрашивал' },
  { text: 'Линия' },
  { text: 'Исход' },
  { text: 'Причина' }
]

// Read-only on purpose: the log records that someone asked for the contacts of the people in
// front of them. Nothing here creates an entry — the bot and the operator do, through the API.
const RESOLUTIONS = {
  contact_shared: { label: 'контакты выданы', group: 'green' },
  guest_ahead: { label: 'впереди гость', group: 'orange' },
  no_one_ahead: { label: 'впереди никого', group: 'gray' },
  denied: { label: 'отказано', group: 'red' }
}

// The reason is free-form metadata the caller writes; the few the bot and the jobs use get a
// Russian wording, anything else is shown as it came.
const REASONS = {
  early_departure: 'ранний выезд',
  blocked_exit: 'перекрыт выезд',
  manual: 'запрос оператора'
}

function resolution(value) {
  return RESOLUTIONS[value] || { label: value || '—', group: 'gray' }
}

function reason(value) {
  return value ? REASONS[value] || value : '—'
}

const rows = computed(() =>
  state.contactAccessLogs.map((entry) => [
    { text: String(entry.occupancyDate || '').slice(0, 10) },
    {
      text: [entry.requester?.displayName, entry.requester?.department].filter(Boolean).join(' · ') || '—'
    },
    { text: entry.lineGroup?.name || entry.lineGroup?.code || '—' },
    { resolution: entry.resolution },
    { text: reason(entry.metadata?.reason) }
  ])
)
</script>

<template>
  <div class="stack">
    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows">
        <template #cell="{ cell }">
          <ViNameplate
            v-if="cell.resolution"
            size="small"
            :background-color="`var(--vi-color-${resolution(cell.resolution).group}-200)`"
            :text-color="`var(--vi-color-${resolution(cell.resolution).group}-900)`"
          >
            {{ resolution(cell.resolution).label }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">
      Запросов контактов не было.
    </ViText>
  </div>
</template>
