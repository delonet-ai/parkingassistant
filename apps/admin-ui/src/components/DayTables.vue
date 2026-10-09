<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViNameplate, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { sourceColors, sourceLabel } from '../statuses'
import { state, submit } from '../store'

// ViTableSimple renders a cell's `text`; a cell without one falls through to the #cell slot,
// which is how the cancel button gets into the last column.
const RELEASE_HEADERS = [
  { text: 'Место' },
  { text: 'Владелец' },
  { text: 'Подразделение' },
  { text: 'Состояние' },
  { text: 'Комментарий' }
]

const RESERVATION_HEADERS = [
  { text: 'Место' },
  { text: 'Кому' },
  { text: 'Подразделение' },
  { text: 'Источник' },
  { text: 'Причина' },
  { text: 'Действие' }
]

const busy = ref(false)

const releaseRows = computed(() =>
  (state.dashboard?.releasedPlaces || []).map((item) => [
    { text: item.parkingPlace.code },
    { text: item.owner.displayName },
    { text: item.owner.department || '—' },
    // The same vocabulary the slots use: a word plus a colour, never a colour alone.
    { release: item.isReserved ? 'назначено' : 'свободно', reserved: item.isReserved },
    { text: item.releaseNotes || '—' }
  ])
)

const reservationRows = computed(() =>
  (state.dashboard?.reservations || []).map((reservation) => [
    { text: reservation.parkingPlace.code },
    { text: reservation.user ? reservation.user.displayName : '—' },
    { text: reservation.user?.department || '—' },
    { source: reservation.source },
    { text: reservation.reason || '—' },
    { cancelReservationId: reservation.id }
  ])
)

async function cancel(reservationId) {
  busy.value = true
  try {
    await submit('/admin/reservations/cancel', { reservationId }, 'Назначение отменено.')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="stack">
    <ViText tag="h3" variant="title-h6">Отданные места на день</ViText>
    <div v-if="releaseRows.length" class="table-scroll">
      <ViTableSimple :headers="RELEASE_HEADERS" :rows="releaseRows">
        <template #cell="{ cell }">
          <ViNameplate
            v-if="cell.release"
            size="small"
            :background-color="cell.reserved ? 'var(--vi-color-yellow-200)' : 'var(--vi-color-green-200)'"
            :text-color="cell.reserved ? 'var(--vi-color-yellow-900)' : 'var(--vi-color-green-900)'"
          >
            {{ cell.release }}
          </ViNameplate>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">На этот день мест не отдано.</ViText>

    <ViText tag="h3" variant="title-h6">Активные назначения</ViText>
    <div v-if="reservationRows.length" class="table-scroll">
      <ViTableSimple :headers="RESERVATION_HEADERS" :rows="reservationRows">
        <template #cell="{ cell }">
          <ViNameplate v-if="cell.source" size="small" v-bind="sourceColors(cell.source)">
            {{ sourceLabel(cell.source) }}
          </ViNameplate>
          <ViButton
            v-if="cell.cancelReservationId"
            size="small"
            variant="outlined"
            color="secondary"
            :loading="busy"
            @click="cancel(cell.cancelReservationId)"
          >
            Отменить
          </ViButton>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">Назначений на этот день нет.</ViText>
  </div>
</template>
