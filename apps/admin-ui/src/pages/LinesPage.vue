<script setup>
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViText } from '@vi-frontend/vision-ui'

import ContactAccessLog from '../components/ContactAccessLog.vue'
import DateSelector from '../components/DateSelector.vue'
import DeparturePlans from '../components/DeparturePlans.vue'
import LineOccupancy from '../components/LineOccupancy.vue'
import { dismissNotice, loadDay, state } from '../store'

async function changeDate(next) {
  state.date = next
  state.selectedPlaceId = null
  dismissNotice()
  await loadDay()
}
</script>

<template>
  <div class="stack">
    <ViCard variant="outlined">
      <ViCardContent>
        <div class="card-head">
          <div>
            <ViText tag="h2" variant="title-h4">Линии</ViText>
            <ViText tag="p" variant="body-M-wide" class="muted">
              Кто на какой позиции стоит {{ state.date }}, кто кого перекрывает и кто спрашивал
              контакты.
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

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Фактические позиции</ViText>
        <LineOccupancy />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Время выезда и конфликты</ViText>
        <DeparturePlans />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Запросы контактов</ViText>
        <ContactAccessLog />
      </ViCardContent>
    </ViCard>
  </div>
</template>
