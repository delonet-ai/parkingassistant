<script setup>
import { computed, ref } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViAlert, ViButton, ViIcon, ViInput, ViText } from '@vi-frontend/vision-ui'

import { activateAccount, signIn, state } from '../store'

// Two forms, one screen: signing in, and — only while the database holds the single invited
// bootstrap operator — giving that account its first password. Which one is shown is the
// store's answer to `/auth/bootstrap-status`, never a guess made here.
const firstRun = computed(() => state.authStage === 'activate')

const login = ref(state.bootstrapLogin || '')
const password = ref('')
const confirmation = ref('')

// The only rule this screen owns: the two first-run fields must agree. One password is sent,
// so the API cannot answer this one — everything else it refuses, it refuses in its own words.
const mismatch = computed(() => firstRun.value && confirmation.value.length > 0 && confirmation.value !== password.value)

const canSubmit = computed(() => {
  if (!login.value.trim() || !password.value) {
    return false
  }

  return !firstRun.value || (confirmation.value === password.value && confirmation.value.length > 0)
})

async function submitForm() {
  if (!canSubmit.value || state.authBusy) {
    return
  }

  const credentials = { login: login.value.trim(), password: password.value }
  const result = firstRun.value ? await activateAccount(credentials) : await signIn(credentials)

  if (!result.ok) {
    // The login stays so a typo in the password does not cost both fields.
    password.value = ''
    confirmation.value = ''
  }
}
</script>

<template>
  <div class="login-screen">
    <ViCard variant="outlined">
      <ViCardContent>
        <div class="brand login-brand">
          <span class="brand-mark"><ViIcon icon="key" /></span>
          <div>
            <ViText tag="h1" variant="title-h4">Parking Assistant</ViText>
            <ViText tag="p" variant="body-S-wide" class="muted">
              {{ firstRun ? 'Первый вход: задайте пароль администратора' : 'Вход для администратора парковки' }}
            </ViText>
          </div>
        </div>

        <ViAlert v-if="firstRun" type="info" title="Учётная запись ещё не активирована">
          Пароль задаётся один раз. После этого новые учётные записи создаёт системный администратор.
        </ViAlert>

        <ViAlert v-if="state.authError" type="error" title="Вход не выполнен">
          {{ state.authError }}
        </ViAlert>

        <form class="login-form" @submit.prevent="submitForm">
          <ViInput
            v-model:value="login"
            label="Логин"
            label-type="static"
            autocomplete="off"
            required
          />

          <ViInput
            v-model:value="password"
            type="password"
            label="Пароль"
            label-type="static"
            autocomplete="off"
            required
          >
            <!-- The slot is declared unconditionally and its *content* is conditional:
                 ViInput decides whether it has a note or an error slot from the slots object
                 it was mounted with, so a `v-if` on the <template> itself never shows up. -->
            <template #note><span v-if="firstRun">Не короче 10 символов</span></template>
          </ViInput>

          <ViInput
            v-if="firstRun"
            v-model:value="confirmation"
            type="password"
            label="Пароль ещё раз"
            label-type="static"
            autocomplete="off"
            required
          >
            <template #error><span v-if="mismatch">Пароли не совпадают</span></template>
          </ViInput>

          <ViButton
            type="submit"
            color="primary"
            full-width
            :loading="state.authBusy"
            :disabled="!canSubmit"
          >
            {{ firstRun ? 'Задать пароль и войти' : 'Войти' }}
          </ViButton>
        </form>
      </ViCardContent>
    </ViCard>
  </div>
</template>
