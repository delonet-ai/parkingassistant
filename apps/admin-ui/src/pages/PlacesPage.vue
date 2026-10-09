<script setup>
import { computed } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViAlert, ViSelect, ViText } from '@vi-frontend/vision-ui'

import InventoryEditor from '../components/InventoryEditor.vue'
import MapUpload from '../components/MapUpload.vue'
import { FLOORS, currentFloor, state } from '../store'

const floorOptions = FLOORS.map((floor) => ({ value: floor.code, text: `Этаж ${floor.title}` }))

// The API reports inventory that cannot be right: a place with no line, or a line whose
// capacity disagrees with how many slots it actually has.
const diagnostics = computed(() => state.mapDiagnostics || {})
const orphanPlaces = computed(() => diagnostics.value.placeWithoutLine || [])
const capacityMismatches = computed(() => diagnostics.value.lineCapacityMismatch || [])
</script>

<template>
  <div class="stack">
    <ViCard variant="outlined">
      <ViCardContent>
        <div class="card-head">
          <div>
            <ViText tag="h2" variant="title-h4">Места</ViText>
            <ViText tag="p" variant="body-M-wide" class="muted">
              Какие места существуют вообще. Добавление и архивирование меняют состав парковки.
            </ViText>
          </div>
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
        </div>
      </ViCardContent>
    </ViCard>

    <ViAlert v-if="orphanPlaces.length" type="warning" title="Места без линии">
      {{ orphanPlaces.map((place) => place.code).join(', ') }}
    </ViAlert>

    <ViAlert v-if="capacityMismatches.length" type="warning" title="Размер линии не совпадает с числом мест">
      {{
        capacityMismatches
          .map((item) => `${item.code}: заявлено ${item.capacity}, мест ${item.placeCount}`)
          .join('; ')
      }}
    </ViAlert>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">
          Инвентарь · этаж {{ currentFloor().title }}
        </ViText>
        <InventoryEditor />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Подложки этажей</ViText>
        <MapUpload />
      </ViCardContent>
    </ViCard>
  </div>
</template>
