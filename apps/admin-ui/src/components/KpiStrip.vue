<script setup>
import { computed } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViIcon, ViNameplate, ViText } from '@vi-frontend/vision-ui'

const props = defineProps({
  dashboard: { type: Object, default: null },
  employeeRequests: { type: Array, default: () => [] },
  guestRequests: { type: Array, default: () => [] }
})

// The same six numbers the SSR KPI strip showed, from the same endpoints it used. Each one
// carries an icon and a colour from the design-system palette, so the strip reads as six
// different things at a glance instead of six identical grey boxes.
const tiles = computed(() => {
  const dashboard = props.dashboard || {}
  const released = dashboard.releasedPlaces || []
  const reservations = dashboard.reservations || []
  // Both request lists come from their own endpoints: /admin/dashboard carries guest
  // requests but no employee ones, so reading them off it would print a permanent zero.
  const guestRequests = props.guestRequests.length ? props.guestRequests : dashboard.guestRequests || []
  const employeeRequests = props.employeeRequests

  return [
    { label: 'Отдано мест', value: released.length, icon: 'key-unlock', group: 'mint' },
    {
      label: 'Доступно к назначению',
      // The API's count of the day's free supply nobody holds yet — released places plus
      // places with no permanent owner. Counting the released list here would miss the latter.
      value: dashboard.guestReserve ? dashboard.guestReserve.availablePlaces : 0,
      icon: 'check-circle',
      group: 'green'
    },
    { label: 'Активных назначений', value: reservations.length, icon: 'key', group: 'yellow' },
    { label: 'Заявок сотрудников', value: employeeRequests.length, icon: 'person', group: 'blue' },
    { label: 'Гостевых заявок', value: guestRequests.length, icon: 'group', group: 'orange' }
  ]
})

const reserve = computed(() => props.dashboard?.guestReserve || { minimum: 5, availablePlaces: 0, status: 'low' })
const reserveGroup = computed(() => (reserve.value.status === 'ok' ? 'green' : 'red'))
</script>

<template>
  <div class="kpi-grid">
    <ViCard v-for="tile in tiles" :key="tile.label" variant="outlined">
      <ViCardContent padding="s">
        <span class="kpi-icon" :style="{ background: `var(--vi-color-${tile.group}-100)` }">
          <ViIcon :icon="tile.icon" :style="{ color: `var(--vi-color-${tile.group}-700)` }" />
        </span>
        <ViText tag="p" variant="body-S-wide" class="muted">{{ tile.label }}</ViText>
        <ViText tag="p" variant="title-h3">{{ tile.value }}</ViText>
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent padding="s">
        <span class="kpi-icon" :style="{ background: `var(--vi-color-${reserveGroup}-100)` }">
          <ViIcon icon="shield-star" :style="{ color: `var(--vi-color-${reserveGroup}-700)` }" />
        </span>
        <ViText tag="p" variant="body-S-wide" class="muted">Гостевой резерв</ViText>
        <ViText tag="p" variant="title-h3">{{ reserve.availablePlaces }}/{{ reserve.minimum }}</ViText>
        <!-- The reserve is a rule, not a decoration: the API says whether it holds, and the
             word is printed next to the colour so the state survives a greyscale print. -->
        <ViNameplate
          size="small"
          :background-color="`var(--vi-color-${reserveGroup}-200)`"
          :text-color="`var(--vi-color-${reserveGroup}-900)`"
        >
          {{ reserve.status === 'ok' ? 'в норме' : 'ниже минимума' }}
        </ViNameplate>
      </ViCardContent>
    </ViCard>
  </div>
</template>
