<script setup>
import { computed, ref } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViButton, ViChip, ViSelect, ViText } from '@vi-frontend/vision-ui'

import DateSelector from '../components/DateSelector.vue'
import DayTables from '../components/DayTables.vue'
import KpiStrip from '../components/KpiStrip.vue'
import PlaceDrawer from '../components/PlaceDrawer.vue'
import PlaceLines from '../components/PlaceLines.vue'
import PlanView from '../components/PlanView.vue'
import { planImageSrc } from '../maps'
import { PLACE_STATUS_OPTIONS, PLACE_TYPE_OPTIONS } from '../statuses'
import { FLOORS, currentFloor, dismissNotice, loadDay, selectFloor, state } from '../store'

const floorOptions = FLOORS.map((floor) => ({ value: floor.code, text: `Этаж ${floor.title}` }))
const floorLabel = computed(() => currentFloor().floorLabel)

// The file name is the API's, not this app's: admin-ui writes a new one per upload.
const planSrc = computed(() => planImageSrc(state.maps.find((map) => map.code === state.floorCode)))
// Markup for the floor on screen only — a late answer for the previous floor is not this plan.
const markup = computed(() =>
  state.markup && (!state.markup.mapCode || state.markup.mapCode === state.floorCode) ? state.markup : null
)
const hasMarkup = computed(() => Object.keys(markup.value?.places || {}).length > 0)

// A marked plan is a work surface — click a place, the drawer opens — so it starts open. An
// unmarked one is only a picture, tall enough to push the element list below the fold, so it
// starts closed. Once the operator toggles it, their choice wins.
const planChoice = ref(null)
const planOpen = computed(() => (planChoice.value === null ? hasMarkup.value : planChoice.value))

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
                @update:value="selectFloor"
              />
              <ViButton variant="outlined" color="secondary" @click="planChoice = !planOpen">
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

          <!-- The plan draws the same statuses the element list prints; the list under it stays
               the source of truth for what exists (ADR 004), the plan is a way to reach it. -->
          <PlanView
            v-if="planOpen"
            :lines="state.lines"
            :markup="markup"
            :plan-src="planSrc"
            :status-filter="state.statusFilter"
            :selected-place-id="state.selectedPlaceId"
            @select="state.selectedPlaceId = $event"
          />
          <ViText v-if="planOpen && state.markupError" tag="p" variant="body-XS-wide" class="muted">
            Разметку плана загрузить не удалось: {{ state.markupError }}
          </ViText>

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
