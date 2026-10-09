<script setup>
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViText } from '@vi-frontend/vision-ui'

import DateSelector from '../components/DateSelector.vue'
import EmployeeRequests from '../components/EmployeeRequests.vue'
import GuestRequests from '../components/GuestRequests.vue'
import KpiStrip from '../components/KpiStrip.vue'
import QueuePanel from '../components/QueuePanel.vue'
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
            <ViText tag="h2" variant="title-h4">Заявки и очередь</ViText>
            <ViText tag="p" variant="body-M-wide" class="muted">
              Сотрудники без места, гостевые заявки и ручная обработка очереди на {{ state.date }}.
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

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Заявки сотрудников</ViText>
        <EmployeeRequests />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Очередь</ViText>
        <QueuePanel />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Гостевые заявки</ViText>
        <GuestRequests />
      </ViCardContent>
    </ViCard>
  </div>
</template>
