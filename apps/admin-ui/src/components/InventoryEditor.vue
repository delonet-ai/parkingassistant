<script setup>
import { computed, ref } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViAlert, ViButton, ViInput, ViModal, ViNameplate, ViSelect, ViText } from '@vi-frontend/vision-ui'

import { CAPACITY_LABELS, positionLabel, statusColors, statusLabel } from '../statuses'
import { currentFloor, state, submit } from '../store'

const ROLE_OPTIONS = [
  { value: 'regular', text: 'Обычное' },
  { value: 'rotatable', text: 'Ротируемое/гостевое' },
  { value: 'blocked', text: 'Недоступное' }
]

const busy = ref(false)
const draft = ref(null)
const archiving = ref(null)

const floorLines = computed(() =>
  state.lines.filter((line) => String(line.floorLabel || '') === currentFloor().floorLabel)
)

const nextCode = computed(() => {
  // A new element needs codes nobody is using; the highest numeric code on the floor plus one
  // is a suggestion, not a rule — the operator can overwrite every field.
  const numbers = state.places
    .map((place) => Number(place.code))
    .filter((value) => Number.isFinite(value))

  return numbers.length ? Math.max(...numbers) + 1 : 1
})

function openDraft(capacity) {
  draft.value = {
    capacity,
    floorLabel: currentFloor().floorLabel,
    slots: Array.from({ length: capacity }, (_, index) => ({
      code: String(nextCode.value + index),
      placeRole: 'regular',
      guestPriorityRank: ''
    }))
  }
}

const canCreate = computed(() => draft.value?.slots.every((slot) => slot.code.trim()))

async function create() {
  busy.value = true
  try {
    const result = await submit(
      '/admin/place-lines',
      {
        floorLabel: draft.value.floorLabel,
        capacity: draft.value.capacity,
        slots: draft.value.slots.map((slot) => ({
          code: slot.code.trim(),
          placeRole: slot.placeRole,
          guestPriorityRank: slot.guestPriorityRank === '' ? null : Number(slot.guestPriorityRank)
        }))
      },
      `Элемент на ${draft.value.capacity} мест создан.`
    )

    if (result.ok) {
      draft.value = null
    }
  } finally {
    busy.value = false
  }
}

async function archive() {
  busy.value = true
  try {
    const result = await submit(
      '/admin/place-lines/archive',
      { lineId: archiving.value.lineId },
      'Элемент заархивирован.'
    )

    if (result.ok) {
      archiving.value = null
    } else if (result.data?.blockers?.length) {
      // The API names what stands in the way; repeating it is more useful than "409".
      state.notice = {
        type: 'error',
        text: `${result.error}: ${result.data.blockers
          .map((blocker) => `${blocker.placeCode} — ${blocker.detail || blocker.type}`)
          .join('; ')}`
      }
    }
  } finally {
    busy.value = false
  }
}

async function setRole(placeId, placeRole) {
  busy.value = true
  try {
    await submit('/admin/places/update', { placeId, placeRole }, 'Роль места обновлена.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <ViButton color="primary" variant="outlined" :loading="busy" @click="openDraft(1)">
        + Одинарное
      </ViButton>
      <ViButton color="primary" variant="outlined" :loading="busy" @click="openDraft(2)">
        + Двойное
      </ViButton>
      <ViButton color="primary" variant="outlined" :loading="busy" @click="openDraft(3)">
        + Тройное
      </ViButton>
      <ViText tag="span" variant="body-XS-wide" class="muted">
        Добавление создаёт реальные места и меняет счётчики: дашборд, гостевой резерв, ёмкость
        очереди.
      </ViText>
    </div>

    <div v-if="floorLines.length" class="line-grid">
      <ViCard v-for="line in floorLines" :key="line.lineId" variant="outlined">
        <ViCardContent padding="s">
          <div class="slot-line">
            <ViText tag="p" variant="body-Sm-wide">{{ line.name || line.code }}</ViText>
            <ViText tag="span" variant="body-XS-wide" class="muted">
              {{ CAPACITY_LABELS[line.capacity] || line.capacity }}
            </ViText>
          </div>

          <div class="line-slots">
            <div v-for="slot in line.slots" :key="slot.placeId" class="editor-slot">
              <span class="slot-line">
                <ViText tag="span" variant="body-Mm-tight">{{ slot.code }}</ViText>
                <ViNameplate size="small" v-bind="statusColors(slot.status)">
                  {{ statusLabel(slot.status) }}
                </ViNameplate>
              </span>
              <ViText tag="span" variant="body-XS-wide" class="muted">
                {{ positionLabel(line.capacity, slot.position) }}
              </ViText>
              <ViSelect
                :value="slot.placeRole"
                :options="ROLE_OPTIONS"
                size="small"
                text-field-name="text"
                value-field-name="value"
                track-by-value
                :disabled="busy"
                @update:value="setRole(slot.placeId, $event)"
              />
            </div>
          </div>

          <ViButton
            size="small"
            variant="outlined"
            color="secondary"
            class="section-gap"
            :loading="busy"
            @click="archiving = line"
          >
            Удалить
          </ViButton>
        </ViCardContent>
      </ViCard>
    </div>

    <ViText v-else tag="p" variant="body-M-wide" class="muted">
      Этаж {{ currentFloor().title }}: элементов нет.
    </ViText>

    <ViModal
      use-model
      :is-opened="Boolean(draft)"
      :title="draft ? `Новый элемент на ${draft.capacity} мест` : ''"
      width="560px"
      has-close-button
      @update:is-opened="draft = null"
    >
      <div v-if="draft" class="stack">
        <ViText tag="p" variant="body-S-wide" class="muted">
          Этаж {{ draft.floorLabel }}. Каждое место линии — отдельная строка каталога.
        </ViText>

        <div v-for="(slot, index) in draft.slots" :key="index" class="form-row">
          <ViInput
            v-model:value="slot.code"
            :label="`Код места ${positionLabel(draft.capacity, index + 1) || ''}`"
            label-type="static"
            required
          />
          <ViSelect
            :value="slot.placeRole"
            :options="ROLE_OPTIONS"
            label="Роль"
            label-type="static"
            text-field-name="text"
            value-field-name="value"
            track-by-value
            @update:value="slot.placeRole = $event"
          />
          <ViInput
            v-model:value="slot.guestPriorityRank"
            label="Гостевой ранг"
            label-type="static"
            placeholder="1..99"
          />
        </div>

        <ViButton color="primary" :loading="busy" :disabled="!canCreate" @click="create">
          Создать
        </ViButton>
      </div>
    </ViModal>

    <ViModal
      use-model
      :is-opened="Boolean(archiving)"
      title="Удалить элемент?"
      width="520px"
      has-close-button
      @update:is-opened="archiving = null"
    >
      <div v-if="archiving" class="stack">
        <ViAlert type="warning" title="Это изменит состав парковки">
          Будут заархивированы места:
          {{ archiving.slots.map((slot) => slot.code).join(', ') }}. Заявки, отдачи и история
          останутся читаемыми, но мест станет меньше — изменится и гостевой резерв, и ёмкость
          очереди.
        </ViAlert>
        <ViButton color="error" :loading="busy" @click="archive">Удалить</ViButton>
      </div>
    </ViModal>
  </div>
</template>
