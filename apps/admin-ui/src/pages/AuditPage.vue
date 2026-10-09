<script setup>
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViText } from '@vi-frontend/vision-ui'

import AuditTable from '../components/AuditTable.vue'
import ContactAccessLog from '../components/ContactAccessLog.vue'
import DateSelector from '../components/DateSelector.vue'
import JobsPanel from '../components/JobsPanel.vue'
import { dismissNotice, loadDay, state } from '../store'

async function changeDate(next) {
  state.date = next
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
            <ViText tag="h2" variant="title-h4">Журнал</ViText>
            <ViText tag="p" variant="body-M-wide" class="muted">
              Что происходило {{ state.date }}: действия, запросы контактов и регламентные задачи.
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
        <ViText tag="h3" variant="title-h5" class="section-head">Действия</ViText>
        <AuditTable />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Запросы контактов</ViText>
        <ContactAccessLog />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Регламентные задачи</ViText>
        <JobsPanel />
      </ViCardContent>
    </ViCard>
  </div>
</template>
