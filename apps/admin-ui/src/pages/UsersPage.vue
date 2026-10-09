<script setup>
import { computed, onMounted, ref } from 'vue'
import { ViCard, ViCardContent } from '@vi-frontend/vision-ui/next'
import { ViAlert, ViButton, ViCheckbox, ViInput, ViModal, ViNameplate, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { AUTH_ROLES, AUTH_STATUS_LABELS, loadUsers, state, submitUser } from '../store'

// The Доступ tab: the accounts that may sign in, and the four things a system administrator
// does to them. Every rule lives in the API — which roles exist, how short a password may be,
// that nobody may demote or disable themselves — and this screen only shows what it answered.
//
// The tab itself is rendered only for a `system_admin` (see `allowedTabs()` in store.js), and
// every endpoint below is refused with 403 for anyone else, so the role is enforced twice and
// relied upon here exactly once: not at all.

const HEADERS = [
  { text: 'Логин' },
  { text: 'Имя' },
  { text: 'Роли' },
  { text: 'Состояние' },
  { text: 'Последний вход' },
  { text: 'Действия' }
]

const MIN_PASSWORD_LENGTH = 10

const busy = ref(false)
const listError = ref(null)
const draft = ref(emptyDraft())
const editingRoles = ref(null)
const editingPassword = ref(null)

function emptyDraft() {
  return { login: '', displayName: '', password: '', roles: ['parking_admin'] }
}

function roleTitle(code) {
  const known = AUTH_ROLES.find((role) => role.code === code)
  return known ? known.title : code
}

function formatMoment(value) {
  return value ? String(value).slice(0, 19).replace('T', ' ') : '—'
}

// The list is read on demand rather than with the day: `/admin/users` is the one endpoint a
// `parking_admin` may not call, and folding it into `loadDay()` would turn their every day
// load into a 403.
async function reload() {
  const result = await loadUsers()
  listError.value = result.ok ? null : result.error
}

onMounted(reload)

const canCreate = computed(
  () =>
    draft.value.login.trim().length >= 3 &&
    draft.value.displayName.trim().length > 0 &&
    draft.value.password.length >= MIN_PASSWORD_LENGTH &&
    draft.value.roles.length > 0
)

const rows = computed(() =>
  state.authUsers.map((user) => [
    { text: user.login },
    { text: user.displayName || '—' },
    { text: (user.roles || []).map((role) => roleTitle(role.code)).join(', ') || '—' },
    { authStatus: user.authStatus },
    { text: formatMoment(user.lastLoginAt) },
    { actionsFor: user }
  ])
)

async function run(action) {
  busy.value = true
  try {
    await action()
  } finally {
    busy.value = false
  }
}

const create = () =>
  run(async () => {
    const result = await submitUser(
      '/admin/users',
      {
        login: draft.value.login.trim(),
        displayName: draft.value.displayName.trim(),
        password: draft.value.password,
        roles: [...draft.value.roles]
      },
      'Учётная запись создана.'
    )

    if (result.ok) {
      draft.value = emptyDraft()
    }
  })

// A copy of the user's roles, so closing the dialog without saving changes nothing.
function openRoles(user) {
  editingRoles.value = { user, roles: (user.roles || []).map((role) => role.code) }
}

const saveRoles = () =>
  run(async () => {
    const result = await submitUser(
      '/admin/users/roles',
      { authUserId: editingRoles.value.user.id, roles: [...editingRoles.value.roles] },
      'Роли обновлены.'
    )

    if (result.ok) {
      editingRoles.value = null
    }
  })

function openPassword(user) {
  editingPassword.value = { user, password: '' }
}

const savePassword = () =>
  run(async () => {
    const result = await submitUser(
      '/admin/users/password',
      { authUserId: editingPassword.value.user.id, password: editingPassword.value.password },
      'Пароль задан.'
    )

    if (result.ok) {
      editingPassword.value = null
    }
  })

const setStatus = (user, status) =>
  run(() =>
    submitUser(
      status === 'disabled' ? '/admin/users/disable' : '/admin/users/enable',
      { authUserId: user.id },
      status === 'disabled' ? 'Учётная запись отключена.' : 'Учётная запись включена.'
    )
  )

// The checkbox owns no state of its own: it reports a change and the set is recomputed here,
// so the box that is checked and the list that will be posted cannot disagree.
function toggleRole(target, code) {
  target.roles = target.roles.includes(code)
    ? target.roles.filter((role) => role !== code)
    : [...target.roles, code]
}
</script>

<template>
  <div class="stack">
    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h2" variant="title-h4">Доступ</ViText>
        <ViText tag="p" variant="body-M-wide" class="muted">
          Учётные записи, которые могут войти в панель. Администратор парковки ведёт день,
          системный администратор — ещё и этот список.
        </ViText>
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">Новая учётная запись</ViText>

        <div class="form-row">
          <ViInput
            v-model:value="draft.login"
            label="Логин"
            label-type="static"
            autocomplete="off"
            required
          />
          <ViInput v-model:value="draft.displayName" label="Имя" label-type="static" required />
          <ViInput
            v-model:value="draft.password"
            type="password"
            label="Пароль"
            label-type="static"
            autocomplete="new-password"
            required
          >
            <template #note>
              <span v-if="draft.password.length < MIN_PASSWORD_LENGTH">Не короче 10 символов</span>
            </template>
          </ViInput>
        </div>

        <div class="form-row">
          <ViCheckbox
            v-for="role in AUTH_ROLES"
            :key="role.code"
            size="medium"
            :model-value="draft.roles"
            :value="role.code"
            @update:model-value="toggleRole(draft, role.code)"
          >
            {{ role.title }}
          </ViCheckbox>

          <ViButton color="primary" :loading="busy" :disabled="!canCreate" @click="create">
            Создать
          </ViButton>
        </div>

        <ViText tag="p" variant="body-XS-wide" class="muted">
          Пароль задаётся здесь и сразу работает — приглашений по почте в системе нет. Хотя бы
          одна роль обязательна: учётная запись без ролей не нужна, вход без доступа — это
          «отключён».
        </ViText>
      </ViCardContent>
    </ViCard>

    <ViCard variant="outlined">
      <ViCardContent>
        <ViText tag="h3" variant="title-h5" class="section-head">
          Учётные записи · {{ state.authUsers.length }}
        </ViText>

        <ViAlert v-if="listError" type="error" title="Список не загружен">
          {{ listError }}
        </ViAlert>

        <div v-else-if="rows.length" class="table-scroll">
          <ViTableSimple :headers="HEADERS" :rows="rows" table-max-height="460px">
            <template #cell="{ cell }">
              <ViNameplate
                v-if="cell.authStatus"
                size="small"
                :background-color="
                  cell.authStatus === 'active' ? 'var(--vi-color-green-200)' : 'var(--vi-color-gray-200)'
                "
                :text-color="
                  cell.authStatus === 'active' ? 'var(--vi-color-green-900)' : 'var(--vi-color-gray-900)'
                "
              >
                {{ AUTH_STATUS_LABELS[cell.authStatus] || cell.authStatus }}
              </ViNameplate>

              <span v-else-if="cell.actionsFor" class="row">
                <ViButton
                  size="small"
                  variant="outlined"
                  color="secondary"
                  :loading="busy"
                  @click="openRoles(cell.actionsFor)"
                >
                  Роли
                </ViButton>
                <ViButton
                  size="small"
                  variant="outlined"
                  color="secondary"
                  :loading="busy"
                  @click="openPassword(cell.actionsFor)"
                >
                  Пароль
                </ViButton>
                <ViButton
                  v-if="cell.actionsFor.authStatus === 'disabled'"
                  size="small"
                  variant="outlined"
                  color="primary"
                  :loading="busy"
                  @click="setStatus(cell.actionsFor, 'active')"
                >
                  Включить
                </ViButton>
                <ViButton
                  v-else
                  size="small"
                  variant="outlined"
                  color="secondary"
                  :loading="busy"
                  @click="setStatus(cell.actionsFor, 'disabled')"
                >
                  Отключить
                </ViButton>
              </span>
            </template>
          </ViTableSimple>
        </div>

        <ViText v-else tag="p" variant="body-S-wide" class="muted">Учётных записей нет.</ViText>

        <ViText tag="p" variant="body-XS-wide" class="muted">
          Себя отключить нельзя, и снять с себя роль системного администратора — тоже: иначе
          управлять доступом стало бы некому. Это сделает другой системный администратор.
          Отключение сразу закрывает все активные сессии этой учётной записи.
        </ViText>
      </ViCardContent>
    </ViCard>

    <ViModal
      use-model
      :is-opened="Boolean(editingRoles)"
      :title="editingRoles ? `Роли · ${editingRoles.user.login}` : ''"
      width="520px"
      has-close-button
      @update:is-opened="editingRoles = null"
    >
      <div v-if="editingRoles" class="stack">
        <ViCheckbox
          v-for="role in AUTH_ROLES"
          :key="role.code"
          size="medium"
          :model-value="editingRoles.roles"
          :value="role.code"
          @update:model-value="toggleRole(editingRoles, role.code)"
        >
          {{ role.title }}
        </ViCheckbox>

        <ViButton
          color="primary"
          :loading="busy"
          :disabled="editingRoles.roles.length === 0"
          @click="saveRoles"
        >
          Сохранить роли
        </ViButton>
      </div>
    </ViModal>

    <ViModal
      use-model
      :is-opened="Boolean(editingPassword)"
      :title="editingPassword ? `Новый пароль · ${editingPassword.user.login}` : ''"
      width="520px"
      has-close-button
      @update:is-opened="editingPassword = null"
    >
      <div v-if="editingPassword" class="stack">
        <ViText tag="p" variant="body-S-wide" class="muted">
          Пароль заменяется сразу. Активные сессии этой учётной записи при этом не закрываются —
          чтобы закрыть их, отключите и снова включите запись.
        </ViText>

        <ViInput
          v-model:value="editingPassword.password"
          type="password"
          label="Пароль"
          label-type="static"
          autocomplete="new-password"
          required
        >
          <template #note>
            <span v-if="editingPassword.password.length < MIN_PASSWORD_LENGTH">
              Не короче 10 символов
            </span>
          </template>
        </ViInput>

        <ViButton
          color="primary"
          :loading="busy"
          :disabled="editingPassword.password.length < MIN_PASSWORD_LENGTH"
          @click="savePassword"
        >
          Задать пароль
        </ViButton>
      </div>
    </ViModal>
  </div>
</template>
