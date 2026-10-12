<script setup>
import { computed, ref } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViButton, ViChip, ViSelect, ViText } from '@vi-frontend/vision-ui'

import DateSelector from '../components/DateSelector.vue'
import DayTables from '../components/DayTables.vue'
import KpiStrip from '../components/KpiStrip.vue'
import PlaceDrawer from '../components/PlaceDrawer.vue'
import PlaceLines from '../components/PlaceLines.vue'
import { planImageSrc } from '../maps'
import { PLACE_STATUS_OPTIONS, PLACE_TYPE_OPTIONS } from '../statuses'
import { FLOORS, currentFloor, dismissNotice, loadDay, state } from '../store'

const floorOptions = FLOORS.map((floor) => ({ value: floor.code, text: `Этаж ${floor.title}` }))
const floorLabel = computed(() => currentFloor().floorLabel)

// The plan is a reference, not the work surface: it is tall, it does not change during a day,
// and leaving it open pushed the element list — the thing the operator actually clicks —
// below the fold.
const planOpen = ref(false)
// The file name is the API's, not this app's: admin-ui writes a new one per upload.
const planSrc = computed(() => planImageSrc(state.maps.find((map) => map.code === state.floorCode)))

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
    <ViCard variant="outlined">
      <ViCardContent>
        <div class="card-head">
          <div>
            <ViText tag="h2" variant="title-h4">День</ViText>
            <ViText tag="p" variant="body-M-wide" class="muted">
              Кто где стоит {{ state.date }} и что меняется на этот день.
            </ViText>
          </div>
          <DateSelector
            :model-value="state.date"
            :today="state.today"
            @update:model-value="changeDate"
          />
        </div>
      </ViCardContent>
    </ViCard>

    <KpiStrip
      :dashboard="state.dashboard"
      :employee-requests="state.employeeRequests"
      :guest-requests="state.guestRequests"
    />

    <div class="day-columns">
      <ViCard variant="outlined">
        <ViCardContent>
          <div class="card-head">
            <ViText tag="h3" variant="title-h5">Места на этаже</ViText>
            <div class="row">
              <ViSelect
                :value="state.floorCode"
                :options="floorOptions"
                label="Этаж"
                label-type="static"
                text-field-name="text"
                value-field-name="value"
                track-by-value
                @update:value="state.floorCode = $event"
              />
              <ViButton variant="outlined" color="secondary" @click="planOpen = !planOpen">
                {{ planOpen ? 'Скрыть план' : 'Показать план' }}
              </ViButton>
            </div>
          </div>

          <div class="filters">
            <ViText tag="span" variant="body-XS-wide" class="muted filters__label">Статус</ViText>
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

          <div class="filters">
            <ViText tag="span" variant="body-XS-wide" class="muted filters__label">Тип</ViText>
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
            v-if="planSrc"
            v-show="planOpen"
            class="floor-plan"
            :src="planSrc"
            :alt="`План этажа ${currentFloor().title}`"
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
        </ViCardContent>
      </ViCard>

      <div class="drawer-column">
        <PlaceDrawer />
      </div>
    </div>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h2" variant="title-h5" margin>Таблицы дня</ViText>
        <DayTables />
      </ViCardContent>
    </ViCard>
  </div>
</template>
