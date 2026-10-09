<script setup>
import { computed } from 'vue'
import { ViButton, ViDateTimeInput } from '@vi-frontend/vision-ui'

const props = defineProps({
  modelValue: { type: String, default: null },
  today: { type: String, default: null }
})

const emit = defineEmits(['update:modelValue'])

/**
 * The selected day is an ISO date string everywhere (that is what the API speaks), while
 * ViDateTimeInput works with Date objects. Both conversions go through local Y/M/D parts on
 * purpose: `new Date('2026-10-09')` is UTC midnight, which a browser east of UTC renders as
 * the previous day.
 */
function toDate(iso) {
  if (!iso) {
    return null
  }

  const [year, month, day] = iso.split('-').map(Number)

  return new Date(year, month - 1, day)
}

function toIso(date) {
  if (!date) {
    return null
  }

  const pad = (value) => String(value).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const value = computed(() => toDate(props.modelValue))

function onUpdate(next) {
  const iso = toIso(next instanceof Date ? next : toDate(next))

  if (iso) {
    emit('update:modelValue', iso)
  }
}

function shift(days) {
  const base = toDate(props.modelValue) || new Date()
  base.setDate(base.getDate() + days)
  emit('update:modelValue', toIso(base))
}
</script>

<template>
  <div class="row">
    <ViDateTimeInput
      picker-type="date"
      label="Дата"
      label-type="static"
      :value="value"
      readonly-input
      @update:value="onUpdate"
    />
    <ViButton variant="outlined" color="secondary" size="medium" @click="shift(-1)">
      Назад
    </ViButton>
    <ViButton variant="outlined" color="secondary" size="medium" @click="shift(1)">
      Вперёд
    </ViButton>
    <ViButton
      v-if="today && today !== modelValue"
      variant="link"
      color="secondary"
      size="medium"
      @click="emit('update:modelValue', today)"
    >
      Сегодня
    </ViButton>
  </div>
</template>
