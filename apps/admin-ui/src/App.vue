<script setup>
import { onMounted, watch } from 'vue'
import { ViAlert, ViIcon, ViTabs, ViText } from '@vi-frontend/vision-ui'

import DayPage from './pages/DayPage.vue'
import NotMigratedPage from './pages/NotMigratedPage.vue'
import { TABS, boot, buildUrl, dismissNotice, state } from './store'

const PAGES = { day: DayPage }

onMounted(() => boot(window.location.search))

// The URL follows the screen, so a reload or a pasted link lands on the same place on the
// same day — replaceState rather than pushState, because selecting slots is browsing, not
// navigation, and every click would otherwise fill the back button with noise.
watch(
  () => [state.view, state.date, state.floorCode, state.selectedPlaceId],
  () => {
    if (state.ready) {
      window.history.replaceState(null, '', buildUrl())
    }
  }
)

function selectTab(value) {
  state.view = value
  dismissNotice()
}
</script>

<template>
  <div class="app-shell">
    <header class="app-head">
      <div class="brand">
        <span class="brand-mark"><ViIcon icon="key" /></span>
        <div>
          <ViText tag="h1" variant="title-h3">Parking Assistant</ViText>
          <ViText tag="p" variant="body-S-wide" class="muted">
            Управление офисной парковкой — все правила считает backend
          </ViText>
        </div>
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
