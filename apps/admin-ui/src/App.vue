<script setup>
import { computed, onMounted, watch } from 'vue'
import { ViAlert, ViButton, ViIcon, ViTabs, ViText } from '@vi-frontend/vision-ui'

import AuditPage from './pages/AuditPage.vue'
import CatalogPage from './pages/CatalogPage.vue'
import DayPage from './pages/DayPage.vue'
import LinesPage from './pages/LinesPage.vue'
import LoginPage from './pages/LoginPage.vue'
import PlacesPage from './pages/PlacesPage.vue'
import RequestsPage from './pages/RequestsPage.vue'
import UsersPage from './pages/UsersPage.vue'
import { allowedTabs, boot, buildUrl, dismissNotice, signOut, state } from './store'

const PAGES = {
  day: DayPage,
  requests: RequestsPage,
  lines: LinesPage,
  catalog: CatalogPage,
  audit: AuditPage,
  places: PlacesPage,
  access: UsersPage
}

// The tab strip follows the operator's roles: Доступ is a `system_admin` screen, and every
// request it makes would answer 403 for anyone else. The store drops `state.view` back to the
// day if a pasted URL names a tab this operator may not open, so the component resolved below
// is always one of the visible ones.
const tabs = computed(() => allowedTabs())

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
  <!-- No session, no application: the tab strip is not rendered at all behind the login
       screen, so nothing can fetch, flash or leak a day the API has not authorised. -->
  <div v-if="state.authStage === 'loading'" class="app-shell">
    <ViText tag="p" variant="body-M-wide" class="muted">Загрузка…</ViText>
  </div>

  <div v-else-if="state.authStage !== 'ready'" class="app-shell">
    <LoginPage />
  </div>

  <div v-else class="app-shell">
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

      <div class="session">
        <div class="session-who">
          <ViText tag="p" variant="body-M-wide">{{ state.authUser?.displayName || state.authUser?.login }}</ViText>
          <ViText tag="p" variant="body-S-wide" class="muted">
            {{ state.authRoles.length ? state.authRoles.join(', ') : state.authUser?.login }}
          </ViText>
        </div>
        <ViButton variant="outlined" color="secondary" size="small" :loading="state.authBusy" @click="signOut">
          Выйти
        </ViButton>
      </div>
    </header>

    <ViTabs
      :tabs="tabs"
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

    <component :is="PAGES[state.view] || PAGES.day" v-else-if="state.ready" />
  </div>
</template>
