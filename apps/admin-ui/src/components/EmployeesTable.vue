<script setup>
import { computed, ref } from 'vue'
import { ViButton, ViInput, ViNameplate, ViTableSimple, ViText } from '@vi-frontend/vision-ui'

import { state, submit } from '../store'

const HEADERS = [
  { text: 'Сотрудник' },
  { text: 'Подразделение' },
  { text: 'Почта' },
  { text: 'Телефон' },
  { text: 'Постоянное место' },
  { text: 'Состояние' },
  { text: 'Действие' }
]

const emit = defineEmits(['open-history'])

const search = ref('')
const draft = ref({ displayName: '', department: '', email: '', phone: '' })
const busy = ref(false)

// A catalog of 68 people does not fit on a screen; the filter is plain substring matching on
// what the operator can see, and it never leaves the browser.
const visible = computed(() => {
  const needle = search.value.trim().toLowerCase()

  if (!needle) {
    return state.employees
  }

  return state.employees.filter((employee) =>
    [employee.displayName, employee.department, employee.email, employee.permanentPlace?.code]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle))
  )
})

const rows = computed(() =>
  visible.value.map((employee) => [
    { historyEmployeeId: employee.id, label: employee.displayName },
    { text: employee.department || '—' },
    { text: employee.email || '—' },
    { text: employee.phone || '—' },
    { text: employee.permanentPlace?.code || '—' },
    { active: employee.isActive },
    employee.isActive ? { disableEmployeeId: employee.id } : { text: '—' }
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
    await submit('/admin/employees', { ...draft.value }, 'Сотрудник создан.')
    draft.value = { displayName: '', department: '', email: '', phone: '' }
  })

const disable = (employeeId) =>
  run(() => submit('/admin/employees/disable', { employeeId }, 'Сотрудник отключён.'))
</script>

<template>
  <div class="stack">
    <div class="form-row">
      <ViInput v-model:value="draft.displayName" label="ФИО" label-type="static" required />
      <ViInput v-model:value="draft.department" label="Подразделение" label-type="static" />
      <ViInput v-model:value="draft.email" label="Почта" label-type="static" />
      <ViInput v-model:value="draft.phone" label="Телефон" label-type="static" />
      <ViButton color="primary" :loading="busy" :disabled="!draft.displayName" @click="create">
        Создать
      </ViButton>
    </div>

    <div class="form-row">
      <ViInput
        v-model:value="search"
        label="Поиск"
        label-type="static"
        placeholder="имя, отдел, место"
        clearable
      />
      <ViText tag="span" variant="body-XS-wide" class="muted">
        Показано {{ visible.length }} из {{ state.employees.length }}.
      </ViText>
    </div>

    <div v-if="rows.length" class="table-scroll">
      <ViTableSimple :headers="HEADERS" :rows="rows" table-max-height="460px">
        <template #cell="{ cell }">
          <ViButton
            v-if="cell.historyEmployeeId"
            variant="link"
            color="secondary"
            size="small"
            @click="emit('open-history', { kind: 'employee', id: cell.historyEmployeeId })"
          >
            {{ cell.label }}
          </ViButton>

          <ViNameplate
            v-else-if="cell.active !== undefined"
            size="small"
            :background-color="cell.active ? 'var(--vi-color-green-200)' : 'var(--vi-color-gray-200)'"
            :text-color="cell.active ? 'var(--vi-color-green-900)' : 'var(--vi-color-gray-900)'"
          >
            {{ cell.active ? 'активен' : 'отключён' }}
          </ViNameplate>

          <ViButton
            v-else-if="cell.disableEmployeeId"
            size="small"
            variant="outlined"
            color="secondary"
            :loading="busy"
            @click="disable(cell.disableEmployeeId)"
          >
            Отключить
          </ViButton>
        </template>
      </ViTableSimple>
    </div>
    <ViText v-else tag="p" variant="body-S-wide" class="muted">Никто не найден.</ViText>
  </div>
</template>
