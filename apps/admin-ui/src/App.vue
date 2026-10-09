<script setup>
import { onMounted } from 'vue'
import { ViAlert, ViTabs, ViText } from '@vi-frontend/vision-ui'

import DayPage from './pages/DayPage.vue'
import NotMigratedPage from './pages/NotMigratedPage.vue'
import { TABS, boot, dismissNotice, state } from './store'

const PAGES = { day: DayPage }

onMounted(boot)

function selectTab(value) {
  state.view = value
  dismissNotice()
}
</script>

<template>
  <div class="app-shell">
    <header class="app-head">
      <div>
        <ViText tag="h1" variant="title-h2">Parking Assistant</ViText>
        <ViText tag="p" variant="body-M-wide" class="muted">
          Управление офисной парковкой. Все правила считает backend — интерфейс только показывает и
          отправляет.
        </ViText>
      </div>
    </header>

    <ViTabs
      :tabs="TABS"
      :active-tab="state.view"
      @update:active-tab="selectTab"
    />

    <ViAlert v-if="state.bootError" type="error" title="Не удалось загрузить данные">
      {{ state.bootError }}
    </ViAlert>

    <ViAlert
      v-else-if="state.notice"
      :type="state.notice.type === 'error' ? 'error' : 'success'"
      has-close-button
      @close="dismissNotice"
    >
      {{ state.notice.text }}
    </ViAlert>

    <ViText v-if="!state.ready && !state.bootError" tag="p" variant="body-M-wide" class="muted">
      Загрузка…
    </ViText>

    <component :is="PAGES[state.view] || NotMigratedPage" v-else-if="state.ready" />
  </div>
</template>
