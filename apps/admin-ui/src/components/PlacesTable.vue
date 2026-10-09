<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViInput, ViNameplate, ViSelect, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { state, submit } from '../store'

const HEADERS = [
  { text: 'Место' },
  { text: 'Этаж' },
  { text: 'Тип' },
  { text: 'Линия' },
  { text: 'Владелец' },
  { text: 'Роль' },
  { text: 'Гостевой ранг' }
]

// place_role is the domain's, only the Russian wording is this component's.
const ROLE_OPTIONS = [
  { value: 'regular', text: 'Обычное' },
  { value: 'rotatable', text: 'Ротируемое/гостевое' },
  { value: 'blocked', text: 'Недоступное' }
]

const ROLE_COLORS = {
  regular: 'gray',
  rotatable: 'red',
  blocked: 'gray'
}

const emit = defineEmits(['open-history'])

const search = ref('')
const busy = ref(false)

const visible = computed(() => {
  const needle = search.value.trim().toLowerCase()

  if (!needle) {
    return state.places
  }

  return state.places.filter((place) =>
    [place.code, place.title, place.floorLabel, place.lineGroup?.code, place.permanentOwner?.displayName]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle))
  )
})

const rows = computed(() =>
  visible.value.map((place) => [
    { historyPlaceId: place.id, label: place.code },
    { text: place.floorLabel || '—' },
    { text: place.placeType || '—' },
    { text: place.lineGroup?.code || '—' },
    { text: place.permanentOwner?.displayName || '—' },
    { roleOf: place.id, role: place.placeRole },
    { text: place.guestPriorityRank === null || place.guestPriorityRank === undefined ? '—' : String(place.guestPriorityRank) }
  ])
)

async function setRole(placeId, role) {
  busy.value = true
  try {
    // Only the role is sent: code, title, floor and line belong to the Места tab, and a
    // partial update here would overwrite them with whatever this screen happens to hold.
    await submit('/admin/places/update', { placeId, placeRole: role }, 'Роль места обновлена.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViInput
        v-model:value="search"
        label="Поиск"
        label-type="static"
        placeholder="код, этаж, линия, владелец"
        clearable
      />
      <ViText tag="span" variant="body-XS-wide" class="muted">
        Показано {{ visible.length }} из {{ state.places.length }}. Места создаются и
        архивируются на вкладке «Места».
      </ViText>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows" table-max-height="460px">
        <template #cell="{ cell }">
          <ViButton
            v-if="cell.historyPlaceId"
            variant="link"
            color="secondary"
            size="small"
            @click="emit('open-history', { kind: 'place', id: cell.historyPlaceId })"
          >
            {{ cell.label }}
          </ViButton>

          <span v-else-if="cell.roleOf" class="queue-cell">
            <ViNameplate
              size="small"
              :background-color="`var(--vi-color-${ROLE_COLORS[cell.role] || 'gray'}-200)`"
              :text-color="`var(--vi-color-${ROLE_COLORS[cell.role] || 'gray'}-900)`"
            >
              {{ (ROLE_OPTIONS.find((option) => option.value === cell.role) || {}).text || cell.role }}
            </ViNameplate>
            <ViSelect
              :value="cell.role"
              :options="ROLE_OPTIONS"
              size="small"
              text-field-name="text"
              value-field-name="value"
              track-by-value
              :disabled="busy"
              @update:value="setRole(cell.roleOf, $event)"
            />
          </span>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">Ничего не найдено.</ViText>
  </div>
</template>
