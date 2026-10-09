<script setup>
import { computed } from 'vue'
import { ViCard } from '@vi-frontend/vision-ui/next'
import { ViChip, ViSelect, ViText } from '@vi-frontend/vision-ui'

import DateSelector from '../components/DateSelector.vue'
import DayTables from '../components/DayTables.vue'
import KpiStrip from '../components/KpiStrip.vue'
import PlaceDrawer from '../components/PlaceDrawer.vue'
import PlaceLines from '../components/PlaceLines.vue'
import { PLACE_STATUS_OPTIONS, PLACE_TYPE_OPTIONS } from '../statuses'
import { FLOORS, currentFloor, dismissNotice, loadDay, state } from '../store'

const floorOptions = FLOORS.map((floor) => ({ value: floor.code, text: `Этаж ${floor.title}` }))
const floorLabel = computed(() => currentFloor().floorLabel)

async function changeDate(next) {
  state.date = next
  // The drawer describes one place on one day; keeping a selection across a date change
  // would show yesterday's reservation under today's heading.
  state.selectedPlaceId = null
  dismissNotice()
  await loadDay()
}

function toggleStatus(status) {
  state.statusFilter = state.statusFilter === status ? '' : status
}

function toggleType(type) {
  state.typeFilter = state.typeFilter === type ? '' : type
}
</script>

<template>
  <div class="stack">
    <ViCard variant="outlined" padding="16px">
      <ViText tag="h2" variant="title-h4">День</ViText>
      <ViText tag="p" variant="body-M-wide" class="muted">
        Кто где стоит {{ state.date }} и что меняется на этот день.
      </ViText>
      <DateSelector :model-value="state.date" :today="state.today" @update:model-value="changeDate" />
    </ViCard>

    <KpiStrip
      :dashboard="state.dashboard"
      :employee-requests="state.employeeRequests"
      :guest-requests="state.guestRequests"
    />

    <div class="day-columns">
      <ViCard variant="outlined" padding="16px">
        <div class="row">
          <ViSelect
            :value="state.floorCode"
            :options="floorOptions"
            label="Этаж"
            label-type="static"
            text-field-name="text"
            value-field-name="value"
            @update:value="state.floorCode = $event"
          />
        </div>

        <div class="row" style="margin-top: 12px">
          <ViChip
            v-for="option in PLACE_STATUS_OPTIONS"
            :key="option.status"
            interactive
            :selected="state.statusFilter === option.status"
            @click="toggleStatus(option.status)"
          >
            {{ option.label }}
          </ViChip>
        </div>

        <div class="row" style="margin-top: 8px">
          <ViChip
            v-for="option in PLACE_TYPE_OPTIONS"
            :key="option.value"
            interactive
            :selected="state.typeFilter === option.value"
            @click="toggleType(option.value)"
          >
            {{ option.label }}
          </ViChip>
        </div>

        <!-- The floor plan stays a static reference image; the element list under it is the
             source of truth for what exists (ADR 004). -->
        <img
          :src="`/maps/parking-${state.floorCode}.png`"
          :alt="`План этажа ${currentFloor().title}`"
          style="max-width: 100%; margin: 12px 0; border-radius: var(--vi-radius-s)"
          onerror="this.style.display='none'"
        />

        <PlaceLines
          :lines="state.lines"
          :floor-label="floorLabel"
          :status-filter="state.statusFilter"
          :type-filter="state.typeFilter"
          :selected-place-id="state.selectedPlaceId"
          @select="state.selectedPlaceId = $event"
        />
      </ViCard>

      <PlaceDrawer />
    </div>

    <ViCard variant="outlined" padding="16px">
      <ViText tag="h2" variant="title-h5">Таблицы дня</ViText>
      <DayTables />
    </ViCard>
  </div>
</template>
