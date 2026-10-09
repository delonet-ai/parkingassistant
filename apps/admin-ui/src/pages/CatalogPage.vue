<script setup>
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViText } from '@vi-frontend/vision-ui'

import EmployeesTable from '../components/EmployeesTable.vue'
import HistoryCard from '../components/HistoryCard.vue'
import PermanentAssignments from '../components/PermanentAssignments.vue'
import PlacesTable from '../components/PlacesTable.vue'
import { openHistory, state } from '../store'
</script>

<template>
  <div class="stack">
    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h2" variant="title-h4">Справочники</ViText>
        <ViText tag="p" variant="body-M-wide" class="muted">
          Сотрудники, места и постоянные закрепления. Клик по имени или коду открывает историю.
        </ViText>
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">
          Сотрудники · {{ state.employees.length }}
        </ViText>
        <EmployeesTable @open-history="openHistory" />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">
          Места · {{ state.places.length }}
        </ViText>
        <PlacesTable @open-history="openHistory" />
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Постоянные закрепления</ViText>
        <PermanentAssignments />
      </ViCardContent>
    </ViCard>

    <HistoryCard />
  </div>
</template>
