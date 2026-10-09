<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

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
    { text: item.isReserved ? 'назначено' : 'свободно' },
    { text: item.releaseNotes || '—' }
  ])
)

const reservationRows = computed(() =>
  (state.dashboard?.reservations || []).map((reservation) => [
    { text: reservation.parkingPlace.code },
    { text: reservation.user ? reservation.user.displayName : '—' },
    { text: reservation.user?.department || '—' },
    { text: reservation.source },
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
      <ViTableSimple :headers="RELEASE_HEADERS" :rows="releaseRows" />
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">На этот день мест не отдано.</ViText>

    <ViText tag="h3" variant="title-h6">Активные назначения</ViText>
    <div v-if="reservationRows.length" class="table-scroll">
      <ViTableSimple :headers="RESERVATION_HEADERS" :rows="reservationRows">
        <template #cell="{ cell }">
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
