<script setup>
import { computed } from 'vue'
import { ViCard } from '@vi-frontend/vision-ui/next'
import { ViNameplate, ViText } from '@vi-frontend/vision-ui'

const props = defineProps({
  dashboard: { type: Object, default: null },
  employeeRequests: { type: Array, default: () => [] },
  guestRequests: { type: Array, default: () => [] }
})

// The same six numbers the SSR KPI strip showed, from the same endpoints it used.
const tiles = computed(() => {
  const dashboard = props.dashboard || {}
  const released = dashboard.releasedPlaces || []
  const reservations = dashboard.reservations || []
  // Both request lists come from their own endpoints: /admin/dashboard carries guest
  // requests but no employee ones, so reading them off it would print a permanent zero.
  const guestRequests = props.guestRequests.length ? props.guestRequests : dashboard.guestRequests || []
  const employeeRequests = props.employeeRequests

  return [
    { label: 'Отдано мест', value: released.length },
    { label: 'Доступно к назначению', value: released.filter((place) => !place.isReserved).length },
    { label: 'Активных назначений', value: reservations.length },
    { label: 'Заявок сотрудников', value: employeeRequests.length },
    { label: 'Гостевых заявок', value: guestRequests.length }
  ]
})

const reserve = computed(() => props.dashboard?.guestReserve || { minimum: 5, availablePlaces: 0, status: 'low' })
</script>

<template>
  <div class="kpi-grid">
    <ViCard v-for="tile in tiles" :key="tile.label" variant="outlined" padding="16px">
      <ViText tag="p" variant="body-S-wide" class="muted">{{ tile.label }}</ViText>
      <ViText tag="p" variant="title-h4">{{ tile.value }}</ViText>
    </ViCard>

    <ViCard variant="outlined" padding="16px">
      <ViText tag="p" variant="body-S-wide" class="muted">Гостевой резерв</ViText>
      <ViText tag="p" variant="title-h4">{{ reserve.availablePlaces }}/{{ reserve.minimum }}</ViText>
      <!-- The reserve is a rule, not a decoration: the API says whether it holds, and the
           word is printed next to the colour so the state survives a greyscale print. -->
      <ViNameplate
        size="small"
        :background-color="reserve.status === 'ok' ? 'rgb(var(--vi-color-green-100))' : 'rgb(var(--vi-color-red-100))'"
        :text-color="reserve.status === 'ok' ? 'rgb(var(--vi-color-green-800))' : 'rgb(var(--vi-color-red-800))'"
      >
        {{ reserve.status === 'ok' ? 'в норме' : 'ниже минимума' }}
      </ViNameplate>
    </ViCard>
  </div>
</template>
